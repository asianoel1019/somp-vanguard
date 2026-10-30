/**
 * Daily system backup (DB_BACKUP_ENABLED / DB_BACKUP_TARGETS / DB_BACKUP_PATH / DB_BACKUP_SCAN_TIME / DB_BACKUP_RETENTION_DAYS).
 *
 * Backs up, each independently (one failure does not stop the others):
 *  - database.sqlite → database_backup_YYYY-MM-DD.sqlite  (CMDB server table)
 *  - scout.sqlite    → scout_backup_YYYY-MM-DD.sqlite     (settings document store, RBAC, runbooks, workflows,
 *                                                           Scout metrics/alerts) — SQLite engine only
 *  - document_store  → config_backup_YYYY-MM-DD.json      — external DB engines (PG / MySQL / MSSQL) only
 *  - .system_key     → system_key_backup.key              (needed to decrypt every enc: value)
 *  - backend/.env    → env_backup_YYYY-MM-DD.env
 * Each dated file is also copied to *_latest.*. Dates are local (server) dates.
 *
 * SQLite files run in WAL mode, so they are copied with SQLite's online backup API (never a raw file copy,
 * which can miss committed data still in the -wal file), written to a temp file, integrity-checked, then renamed.
 */
const fs = require('fs');
const path = require('path');
const { auditLog } = require('../lib/logger');

let backupSchedulerTask = null;
let lastRunDate = null; // Local 'YYYY-MM-DD' of the last backup run
let running = false; // Shared by the scheduler and manual runs: only one backup at a time per process

const BACKUP_TARGETS = ['system', 'scout', 'both'];
const RUNNING_MAX_AGE_MS = 30 * 60 * 1000;

/** 'system' (database.sqlite) | 'scout' (scout.sqlite / external-engine document_store snapshot) | 'both'. Anything else = 'both'. */
function normalizeTargets(t) {
    const v = String(t || '').trim().toLowerCase();
    return BACKUP_TARGETS.includes(v) ? v : 'both';
}

const LAST_RESULT_KEY = 'system/last_backup_result.json';

const DATED_PATTERN = /^(database_backup|scout_backup|config_backup|env_backup)_\d{4}-\d{2}-\d{2}\.(sqlite|json|env)$/;

function localDateStr(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function resolveBackupDir() {
    let rawPath = (process.env.DB_BACKUP_PATH || '').trim();
    if (!rawPath) {
        rawPath = path.join(process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard', 'config_backup');
    }
    // If the path contains a filename (.sqlite or .db), use its parent directory
    const lower = rawPath.toLowerCase();
    return lower.endsWith('.sqlite') || lower.endsWith('.db') ? path.dirname(rawPath) : rawPath;
}

function nodeSqlite() {
    try { return require('node:sqlite'); } catch (e) { return null; }
}

function openReadOnly(file) {
    const ns = nodeSqlite();
    if (ns) return new ns.DatabaseSync(file, { readOnly: true });
    const BetterSqlite = require('better-sqlite3');
    return new BetterSqlite(file, { readonly: true });
}

/** Consistent online copy of a live SQLite connection into destFile (verified, atomic rename). */
async function backupSqlite(sourceDb, destFile) {
    const tmpFile = `${destFile}.tmp`;
    try { fs.rmSync(tmpFile, { force: true }); } catch (e) {}

    const ns = nodeSqlite();
    if (ns && typeof ns.backup === 'function' && sourceDb instanceof ns.DatabaseSync) {
        // rate -1 = copy every page in ONE step (runs off the event loop). The default (100 pages per step)
        // restarts from scratch whenever ANOTHER connection writes between steps — the web process writes
        // scout.sqlite every few seconds, so a stepped backup of a large file may never finish.
        await ns.backup(sourceDb, tmpFile, { rate: -1 });
    } else if (typeof sourceDb.backup === 'function') {
        await sourceDb.backup(tmpFile); // better-sqlite3
    } else {
        sourceDb.exec(`VACUUM INTO '${tmpFile.replace(/'/g, "''")}'`);
    }

    let check;
    const copy = openReadOnly(tmpFile);
    try {
        check = copy.prepare('PRAGMA quick_check').get();
    } finally {
        copy.close();
    }
    const verdict = check && Object.values(check)[0];
    if (verdict !== 'ok') {
        try { fs.rmSync(tmpFile, { force: true }); } catch (e) {}
        throw new Error(`integrity check failed for ${path.basename(destFile)}: ${verdict}`);
    }
    fs.renameSync(tmpFile, destFile);
    return fs.statSync(destFile).size;
}

function copyLatest(datedFile, latestFile) {
    fs.copyFileSync(datedFile, latestFile);
}

/**
 * Runs one backup. Returns { dir, date, items: [{ name, file?, bytes?, ok, error? }] },
 * or { skipped: 'running' } when another run is in progress in this process.
 * @param {{ force?: boolean, now?: Date, targets?: string }} options force ignores DB_BACKUP_ENABLED (manual / tests);
 *   targets overrides DB_BACKUP_TARGETS. .system_key and .env are always backed up.
 */
async function runBackup({ force = false, now = new Date(), targets, _lockHeld = false } = {}) {
    if (!force && process.env.DB_BACKUP_ENABLED !== 'true') return null;
    // _lockHeld: the caller (runRecordedBackup) already reserved the guard and releases it itself
    if (!_lockHeld) {
        if (running) return { skipped: 'running' };
        running = true;
    }
    try {
        return await runBackupInner({ now, targets: normalizeTargets(targets !== undefined ? targets : process.env.DB_BACKUP_TARGETS) });
    } finally {
        if (!_lockHeld) running = false;
    }
}

async function runBackupInner({ now, targets }) {
    const backupDir = resolveBackupDir();
    const dateStr = localDateStr(now);
    const items = [];
    const step = async (name, fn) => {
        try {
            const r = await fn();
            if (r) items.push({ name, ok: true, ...r });
        } catch (e) {
            items.push({ name, ok: false, error: e.message });
            console.error(`[Backup Service] ${name} backup failed:`, e.message);
        }
    };

    console.log(`[Backup Service] Starting system backup into: ${backupDir}`);
    try {
        fs.mkdirSync(backupDir, { recursive: true });
    } catch (e) {
        console.error('[Backup Service] Cannot create backup directory:', e.message);
        auditLog('SYSTEM', 'Database Backup', `Backup FAILED: cannot create directory ${backupDir} (${e.message})`);
        return { dir: backupDir, date: dateStr, items: [{ name: 'directory', ok: false, error: e.message }] };
    }

    // 1. database.sqlite (CMDB server table; present in every engine mode)
    if (targets !== 'scout') await step('database.sqlite', async () => {
        const { db } = require('../lib/db');
        if (!db) return null;
        const file = path.join(backupDir, `database_backup_${dateStr}.sqlite`);
        const bytes = await backupSqlite(db, file);
        copyLatest(file, path.join(backupDir, 'database_backup_latest.sqlite'));
        return { file, bytes };
    });

    // 2. Main data store: scout.sqlite (SQLite engine) or a JSON snapshot of document_store (external engines)
    const dbManager = require('./db');
    const driver = dbManager.getDriver();
    if (targets === 'system') {
        // scout / document_store not selected
    } else if (driver && driver.dbType === 'sqlite') {
        await step('scout.sqlite', async () => {
            if (typeof driver.ensureDb === 'function') driver.ensureDb();
            if (!driver.db) throw new Error('scout.sqlite connection is not open');
            const file = path.join(backupDir, `scout_backup_${dateStr}.sqlite`);
            const bytes = await backupSqlite(driver.db, file);
            copyLatest(file, path.join(backupDir, 'scout_backup_latest.sqlite'));
            return { file, bytes };
        });
    } else if (driver) {
        await step(`${driver.dbType} document_store`, async () => {
            const rows = await dbManager.all('SELECT "key", value FROM document_store');
            const file = path.join(backupDir, `config_backup_${dateStr}.json`);
            fs.writeFileSync(file, JSON.stringify({
                engine: driver.dbType,
                timestamp: now.toISOString(),
                count: rows ? rows.length : 0,
                documents: rows || [],
            }, null, 2), 'utf8');
            copyLatest(file, path.join(backupDir, 'config_backup_latest.json'));
            return { file, bytes: fs.statSync(file).size };
        });
    }

    // 3. Master key (without it no enc: value in .env / rbac can be decrypted)
    await step('.system_key', async () => {
        const { SYSTEM_KEY_FILE } = require('../lib/crypto');
        // Same lookup order as crypto.getSystemKey(): data dir first, then the legacy C:\ProgramData location
        const candidates = [SYSTEM_KEY_FILE];
        if (!process.env.SOMP_DISABLE_LEGACY_PATHS) candidates.push('C:\\ProgramData\\somp-vanguard\\.system_key');
        const keyFile = candidates.find(f => fs.existsSync(f));
        if (!keyFile) throw new Error(`${SYSTEM_KEY_FILE} not found`);
        const file = path.join(backupDir, 'system_key_backup.key');
        fs.copyFileSync(keyFile, file);
        return { file, bytes: fs.statSync(file).size };
    });

    // 4. backend/.env (secrets stay encrypted as enc:...)
    await step('.env', async () => {
        const envFile = process.env.SOMP_ENV_PATH || path.join(__dirname, '..', '.env');
        if (!fs.existsSync(envFile)) return null;
        const file = path.join(backupDir, `env_backup_${dateStr}.env`);
        fs.copyFileSync(envFile, file);
        copyLatest(file, path.join(backupDir, 'env_backup_latest.env'));
        return { file, bytes: fs.statSync(file).size };
    });

    const failed = items.filter(i => !i.ok);
    const describe = (i) => i.ok ? `${i.name} ✓ (${(i.bytes / 1048576).toFixed(1)} MB)` : `${i.name} ✗ ${i.error}`;
    const summary = items.map(describe).join('; ');
    if (failed.length) {
        console.error(`[Backup Service] Backup finished with ${failed.length} failure(s): ${summary}`);
        auditLog('SYSTEM', 'Database Backup', `Backup FAILED (${failed.length}/${items.length}) in ${backupDir}: ${summary}`);
    } else {
        console.log(`[Backup Service] Backup completed: ${summary}`);
        auditLog('SYSTEM', 'Database Backup', `Backup completed in ${backupDir}: ${summary}`);
    }

    const retentionDays = parseInt(process.env.DB_BACKUP_RETENTION_DAYS, 10) || 30;
    cleanOldBackups(backupDir, retentionDays);

    return { dir: backupDir, date: dateStr, items };
}

/** Last backup result, read straight from the shared scout document_store (the worker process writes it there). */
async function readLastResult() {
    try {
        const row = await require('./scoutDb').get('SELECT value FROM document_store WHERE "key" = ?', [LAST_RESULT_KEY]);
        if (!row || !row.value) return {};
        try { return JSON.parse(row.value) || {}; } catch (e) { return {}; }
    } catch (e) {
        const { readDataSync } = require('../lib/db');
        return readDataSync(LAST_RESULT_KEY, null) || {};
    }
}

/** Persists the status doc; resolves once it is in the shared scout document_store (writeDataSync alone fires that write without waiting). */
async function writeLastResult(doc) {
    const value = JSON.stringify(doc, null, 2);
    require('../lib/db').writeDataSync(LAST_RESULT_KEY, value);
    await require('./db').upsert({ table: 'document_store', conflictKeys: ['key'], data: { key: LAST_RESULT_KEY, value, updatedAt: new Date().toISOString() } });
}

/** Runs a backup and records started/finished in the status document. Never rejects. */
async function runRecordedBackup(requestedBy, requestId = null, options = {}) {
    if (running) {
        // Scheduled run (no caller id): leave the status of the run in progress alone. Manual: tell the caller.
        if (requestId) {
            const nowIso = new Date().toISOString();
            try { await writeLastResult({ requestId, requestedBy, startedAt: nowIso, finishedAt: nowIso, items: [], dir: null, error: 'A backup is already running.' }); } catch (e) {}
        }
        return { skipped: 'running' };
    }
    // Reserve the guard synchronously (no await since the check above) so two callers cannot both pass it
    running = true;
    try {
        const id = requestId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const existing = await readLastResult();
        const startedAt = existing.requestId === id && existing.startedAt ? existing.startedAt : new Date().toISOString();
        const doc = { requestId: id, requestedBy, startedAt, finishedAt: null, items: [], dir: null };
        try { await writeLastResult(doc); } catch (e) { console.error('[Backup Service] Cannot record backup start:', e.message); }
        try {
            if (typeof options.beforeRun === 'function') await options.beforeRun(); // test seam: hold the run open after 'started' is recorded
            const result = await runBackup({ ...options, _lockHeld: true });
            if (result && result.skipped) {
                doc.error = 'A backup is already running.';
            } else if (result) {
                doc.items = result.items;
                doc.dir = result.dir;
            }
            doc.finishedAt = new Date().toISOString();
            try { await writeLastResult(doc); } catch (e) { console.error('[Backup Service] Cannot record backup result:', e.message); }
            return result;
        } catch (err) {
            console.error('[Backup Service Error]', err);
            doc.error = err.message;
            doc.finishedAt = new Date().toISOString();
            try { await writeLastResult(doc); } catch (e) {}
            return null;
        }

    } finally {
        running = false;
    }
}

/** True when a status doc describes a run that started less than 30 minutes ago and has not finished. */
function isStatusRunning(doc, nowMs = Date.now()) {
    return !!(doc && doc.startedAt && !doc.finishedAt && nowMs - new Date(doc.startedAt).getTime() < RUNNING_MAX_AGE_MS);
}

/** Manual "Back Up Now": always backs up both databases, ignores DB_BACKUP_ENABLED. requestId lets the web process correlate the status document. */
function runManualBackup(requestedBy, requestId = null, options = {}) {
    return runRecordedBackup(requestedBy, requestId, { ...options, force: true, targets: 'both' });
}

/** Deletes dated backups older than retentionDays; *_latest.* and the key backup are never deleted. */
function cleanOldBackups(backupDir, retentionDays) {
    if (!fs.existsSync(backupDir) || retentionDays <= 0) return;
    try {
        const nowMs = Date.now();
        const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
        for (const file of fs.readdirSync(backupDir)) {
            if (!DATED_PATTERN.test(file)) continue;
            const filePath = path.join(backupDir, file);
            try {
                if (nowMs - fs.statSync(filePath).mtimeMs > maxAgeMs) {
                    fs.unlinkSync(filePath);
                    console.log(`[Backup Service Retention] Purged expired backup (> ${retentionDays}d): ${file}`);
                    auditLog('SYSTEM', 'Backup Retention', `Purged expired backup: ${file}`);
                }
            } catch (e) {}
        }
    } catch (err) {
        console.error('[Backup Service Retention Error]', err);
    }
}

/** True when today's dated backup for the selected targets already exists (avoids a second run after a restart). */
function hasBackupFor(dateStr, targets = process.env.DB_BACKUP_TARGETS) {
    const dir = resolveBackupDir();
    const t = normalizeTargets(targets);
    const prefixes = t === 'system' ? ['database_backup'] : t === 'scout' ? ['scout_backup', 'config_backup'] : ['database_backup', 'scout_backup', 'config_backup'];
    return prefixes.some(prefix => fs.existsSync(path.join(dir, `${prefix}_${dateStr}.${prefix === 'config_backup' ? 'json' : 'sqlite'}`)));
}

/** Pure scheduling decision, exported for tests. */
function isBackupDue(now, scanTime, lastRun, alreadyBackedUp) {
    const [h, m] = String(scanTime || '03:00').split(':').map(Number);
    const scheduled = new Date(now);
    scheduled.setHours(Number.isFinite(h) ? h : 3, Number.isFinite(m) ? m : 0, 0, 0);
    const today = localDateStr(now);
    return now.getTime() >= scheduled.getTime() && lastRun !== today && !alreadyBackedUp;
}

/**
 * One scheduler poll. Returns { skipped: reason } or { started: Promise } (the promise is for tests).
 * Skips while a run (manual or scheduled) is unfinished and started < 30 minutes ago.
 */
async function schedulerTick(now = new Date()) {
    if (process.env.DB_BACKUP_ENABLED !== 'true') return { skipped: 'disabled' };
    const today = localDateStr(now);
    if (lastRunDate === today) return { skipped: 'already-ran' };
    if (isBackupDue(now, process.env.DB_BACKUP_SCAN_TIME, lastRunDate, hasBackupFor(today))) {
        if (running || isStatusRunning(await readLastResult(), now.getTime())) return { skipped: 'running' };
        lastRunDate = today;
        return { started: runRecordedBackup('SCHEDULE', null, { now }) };
    }
    if (hasBackupFor(today)) lastRunDate = today;
    return { skipped: 'not-due' };
}

function resetSchedulerState() { lastRunDate = null; }

function initBackupScheduler() {
    if (backupSchedulerTask) {
        clearInterval(backupSchedulerTask);
    }

    // Poll every 10 seconds; run once per local day after DB_BACKUP_SCAN_TIME
    backupSchedulerTask = setInterval(() => {
        schedulerTick()
            .then(r => { if (r.started) r.started.catch(err => console.error('[Backup Service Error]', err)); })
            .catch(err => console.error('[Backup Scheduler Error]', err));
    }, 10000);
}

module.exports = {
    initBackupScheduler,
    runBackup,
    runManualBackup,
    runRecordedBackup,
    readLastResult,
    writeLastResult,
    LAST_RESULT_KEY,
    normalizeTargets,
    hasBackupFor,
    isStatusRunning,
    schedulerTick,
    resetSchedulerState,
    cleanOldBackups,
    backupSqlite,
    isBackupDue,
    localDateStr,
};
