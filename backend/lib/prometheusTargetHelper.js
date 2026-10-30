const fs = require('fs');
const path = require('path');
const dbModule = require('./db');
const { readDataSync, writeDataSync } = dbModule;
const { mutateDocument, replaceDocument, replaceContents } = require('./docStore');

let BASE_DATA_DIR = process.env.DB_DATA_DIR;
if (!BASE_DATA_DIR) {
    if (fs.existsSync('D:\\somp-vanguard')) {
        BASE_DATA_DIR = 'D:\\somp-vanguard';
    } else {
        BASE_DATA_DIR = 'C:\\ProgramData\\somp-vanguard';
    }
}
const TARGETS_FILE = path.join(BASE_DATA_DIR, 'prometheus_targets.json');
const TARGETS_KEY = 'prometheus_targets.json';
const BACKUP_DIR = path.join(BASE_DATA_DIR, 'backups', 'prometheus_targets');
const MAX_BACKUPS = 30;

// Helper for 4-octet numerical IP comparison (1 to 255)
function compareIPs(ipA, ipB) {
    const partsA = String(ipA || '').trim().split('.').map(n => parseInt(n, 10) || 0);
    const partsB = String(ipB || '').trim().split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 4; i++) {
        const a = partsA[i] !== undefined ? partsA[i] : 0;
        const b = partsB[i] !== undefined ? partsB[i] : 0;
        if (a !== b) return a - b;
    }
    return 0;
}

// In-process serialized mutex queue for all target file writes
let writeQueue = Promise.resolve();
function withLock(fn) {
    const next = writeQueue.then(() => fn(), () => fn());
    writeQueue = next.catch(err => {
        console.error('[PrometheusTargetHelper Lock Error]', err);
    });
    return next;
}

function sortTargets(list) {
    list.sort((a, b) => {
        const ipA = a.labels?.addr || (a.targets && a.targets[0] ? a.targets[0].split(':')[0] : '');
        const ipB = b.labels?.addr || (b.targets && b.targets[0] ? b.targets[0].split(':')[0] : '');
        return compareIPs(ipA, ipB);
    });
    return list;
}

function syncSleep(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch (e) {
        const start = Date.now();
        while (Date.now() - start < ms) {}
    }
}

/**
 * Reads the raw document value straight from the shared local database.sqlite
 * (bypassing the per-process RAM cache, which the web and worker processes do not share).
 * Returns { raw: string|null } or { fallback: true } when there is no local db.
 */
function readSharedRaw(key = TARGETS_KEY) {
    const db = dbModule.db;
    if (!db) return { fallback: true };
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const row = db.prepare("SELECT value, updated_at FROM document_store WHERE key = ?").get(key);
            return { raw: row && row.value ? row.value : null, updatedAt: row ? row.updated_at : null };
        } catch (e) {
            const isLocked = e.code === 'SQLITE_BUSY' || e.message?.includes('locked') || e.message?.includes('busy');
            if (isLocked && attempt < maxAttempts - 1) {
                syncSleep(25 * Math.pow(2, attempt) + Math.floor(Math.random() * 20));
                continue;
            }
            throw e;
        }
    }
    return { raw: null };
}

/**
 * Safely reads prometheus targets.
 * The shared database document_store is primary; the legacy flat file is only a fallback
 * when the database has no value. Circuit breakers: a DB value that is not an array, or
 * (with no DB value) a corrupt legacy file, throws instead of returning [].
 */
function getTargetsSafely() {
    let dbValue;
    let dbHasValue = false;
    try {
        const shared = readSharedRaw();
        if (shared.fallback) {
            const v = readDataSync(TARGETS_KEY, null);
            if (v !== null && v !== undefined) { dbHasValue = true; dbValue = v; }
        } else if (shared.raw !== null) {
            dbHasValue = true;
            try { dbValue = JSON.parse(shared.raw); } catch (_) { dbValue = shared.raw; }
        }
    } catch (e) {
        console.error('[PrometheusTargetHelper] document_store read failed:', e.message);
        throw new Error('Circuit Breaker Tripped: Failed to read prometheus targets from the database (' + e.message + '). Aborting operation to protect target data.');
    }

    if (dbHasValue) {
        if (Array.isArray(dbValue)) return sortTargets(dbValue);
        throw new Error('Circuit Breaker Tripped: prometheus_targets.json in the database is not an array. Aborting operation to protect target data.');
    }

    let fileReadError = null;
    if (fs.existsSync(TARGETS_FILE)) {
        try {
            const raw = fs.readFileSync(TARGETS_FILE, 'utf8');
            if (raw && raw.trim().length > 0) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    return sortTargets(parsed);
                }
            }
        } catch (e) {
            fileReadError = e;
            console.error('[PrometheusTargetHelper] Warning: Failed to parse legacy TARGETS_FILE:', e.message);
        }
    }

    if (fileReadError) {
        throw new Error(`Circuit Breaker Tripped: Failed to read prometheus_targets.json safely (${fileReadError.message}). Aborting operation to protect target data.`);
    }

    return [];
}

function stampNow() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const IMPORT_MARKER_KEY = 'system/legacy_targets_import.json';
const UPSERT_TIMEOUT_MS = 10000;

// SQLite CURRENT_TIMESTAMP is UTC without a zone ("YYYY-MM-DD HH:MM:SS"); ISO strings carry their own.
function parseDbTime(s) {
    if (!s) return NaN;
    const str = String(s);
    if (/(Z|[+-]\d\d:?\d\d)$/i.test(str)) return Date.parse(str);
    return Date.parse(str.replace(' ', 'T') + 'Z');
}

/**
 * One-time startup import of the legacy prometheus_targets.json (web process); safe on every restart.
 * - File is read with the ORIGINAL fs functions (opts.fsApi) so the VFS intercept is bypassed.
 * - Idempotency marker (document_store key system/legacy_targets_import.json) records the imported sha256.
 * - Imports only when the DB has no targets or the file is newer than the DB row; the marker is written
 *   BEFORE the rename so a failed rename is retried next start but never re-imports.
 * Never throws; a corrupt file is left in place.
 */
async function importLegacyTargetsFileOnce(opts = {}) {
    const api = opts.fsApi || fs;
    try {
        if (!api.existsSync(TARGETS_FILE)) return { status: 'no-file' };
        let rawFile;
        let parsed;
        try {
            rawFile = api.readFileSync(TARGETS_FILE, 'utf8');
            parsed = JSON.parse(rawFile);
        } catch (e) {
            console.warn('[PrometheusTargetHelper] Legacy targets file is unreadable, left in place:', e.message);
            return { status: 'corrupt' };
        }
        if (!Array.isArray(parsed)) {
            console.warn('[PrometheusTargetHelper] Legacy targets file is not an array, left in place.');
            return { status: 'corrupt' };
        }
        const sha = require('crypto').createHash('sha256').update(rawFile).digest('hex');
        const mtimeMs = fs.statSync(TARGETS_FILE).mtimeMs;

        const doRename = () => {
            const dest = `${TARGETS_FILE}.imported-${stampNow()}`;
            try {
                fs.renameSync(TARGETS_FILE, dest);
                return dest;
            } catch (e) {
                console.warn('[PrometheusTargetHelper] Could not rename legacy targets file (will retry next start):', e.message);
                return null;
            }
        };

        // Read current state; on any read failure write nothing
        let current = null;
        let dbUpdatedAt = null;
        let marker = null;
        try {
            const shared = readSharedRaw();
            if (shared.fallback) {
                current = readDataSync(TARGETS_KEY, null);
                marker = readDataSync(IMPORT_MARKER_KEY, null);
            } else {
                if (shared.raw !== null) current = JSON.parse(shared.raw);
                dbUpdatedAt = shared.updatedAt;
                const m = readSharedRaw(IMPORT_MARKER_KEY);
                if (m.raw !== null) marker = JSON.parse(m.raw);
            }
        } catch (e) {
            console.warn('[PrometheusTargetHelper] Legacy import skipped, cannot read current state:', e.message);
            return { status: 'read-error' };
        }

        if (marker && marker.fileSha256 === sha) {
            const dest = doRename();
            return { status: 'already-imported', renamed: !!dest };
        }

        const hasDb = current !== null && current !== undefined;
        const same = Array.isArray(current) && JSON.stringify(current) === JSON.stringify(parsed);
        const dbMs = parseDbTime(dbUpdatedAt);
        const fileNewer = Number.isNaN(dbMs) ? true : mtimeMs > dbMs;
        const shouldImport = !hasDb || (!same && fileNewer);

        if (shouldImport) {
            if (Array.isArray(current) && current.length > 0) createRollingBackup(current, 'pre_legacy_import');
            const sorted = sortTargets([...parsed]);
            replaceDocument(TARGETS_KEY, sorted, { defaultValue: [], fnName: 'prometheusTargetHelper.importLegacy' });
            let timer;
            try {
                const dbManager = require('../services/db');
                const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), opts.upsertTimeoutMs || UPSERT_TIMEOUT_MS); });
                await Promise.race([dbManager.upsert({
                    table: 'document_store',
                    conflictKeys: ['key'],
                    data: { key: TARGETS_KEY, value: JSON.stringify(sorted, null, 2), updatedAt: new Date().toISOString() }
                }), timeout]);
            } catch (e) {
                console.warn('[PrometheusTargetHelper] scout upsert during legacy import failed:', e.message);
            } finally {
                clearTimeout(timer);
            }
        }

        // Marker first, then rename
        writeDataSync(IMPORT_MARKER_KEY, { importedAt: new Date().toISOString(), fileMtime: new Date(mtimeMs).toISOString(), fileSha256: sha });
        const dest = doRename();
        console.log(`[PrometheusTargetHelper] Legacy prometheus_targets.json ${shouldImport ? `imported (${parsed.length} targets)` : 'not newer than the database, not imported'}${dest ? `; renamed to ${path.basename(dest)}` : '; rename pending'}`);
        return { status: shouldImport ? 'imported' : 'skipped', count: parsed.length, renamed: !!dest };
    } catch (e) {
        console.warn('[PrometheusTargetHelper] Legacy targets import failed:', e.message);
        return { status: 'error' };
    }
}

/**
 * Creates a timestamped rolling backup of targets before overwriting.
 */
function createRollingBackup(targets, reason = 'auto') {
    if (!Array.isArray(targets) || targets.length === 0) return;
    try {
        if (!fs.existsSync(BACKUP_DIR)) {
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
        }

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const filename = `prometheus_targets_${ts}_${reason}.json`;
        const filePath = path.join(BACKUP_DIR, filename);

        // Atomic write backup
        const tmpPath = `${filePath}.tmp.${Date.now()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(targets, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);

        // Purge old backups keeping MAX_BACKUPS
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('prometheus_targets_') && f.endsWith('.json'))
            .sort();

        if (files.length > MAX_BACKUPS) {
            const toDelete = files.slice(0, files.length - MAX_BACKUPS);
            for (const f of toDelete) {
                try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {}
            }
        }
    } catch (e) {
        console.error('[PrometheusTargetHelper] Warning: Failed to create rolling backup:', e.message);
    }
}

/**
 * Saves targets safely using rolling backups and the document store.
 * Protected by an in-process mutex queue to guarantee zero file truncation race conditions.
 */
async function saveTargetsSafely(newTargets, source = 'system', options = {}) {
    return withLock(() => saveTargetsLocked(newTargets, source, options));
}

/**
 * Atomic read-modify-write under the same lock as saveTargetsSafely.
 * mutator(currentTargets) returns { targets, result } to save (result is returned to the caller),
 * or { result } / null to leave the targets untouched. Returns { saved, result }.
 */
async function updateTargetsSafely(mutator, source = 'system', options = {}) {
    return withLock(async () => {
        // The in-process queue orders this process' writers; the read -> mutator -> write itself is ONE
        // cross-process atomic step (docStore.mutateDocument: the worker writes the targets too).
        // The mutator must therefore be synchronous (every caller's mutator is).
        return mutateTargetsDoc((current) => {
            const out = mutator(current);
            if (out && typeof out.then === 'function') {
                throw new Error('updateTargetsSafely: mutator must be synchronous (it returned a Promise)');
            }
            if (!out || !Array.isArray(out.targets)) return { saved: false, result: out ? out.result : undefined };
            return { saved: true, result: out.result, targets: out.targets };
        }, source, options);
    });
}

/**
 * Atomic read-modify-write of the targets document. decide(currentTargets) -> { saved, result, targets? }; when
 * saved, `targets` replaces the document (after the wipe guard, rolling backup and sort of saveTargetsLocked).
 * Runs inside mutateDocument: decide must be synchronous and must not keep state outside its return value.
 */
function mutateTargetsDoc(decide, source, options) {
    // fail fast with the circuit breaker (unreadable / non-array document) before taking the write lock
    if (!(options && options.allowWipe && options.replace)) getTargetsSafely();
    const res = mutateDocument(TARGETS_KEY, (doc) => {
        // Inside the lock: the CURRENT shared row (getTargetsSafely reads database.sqlite directly), with its circuit breakers
        let current;
        try {
            current = getTargetsSafely();
        } catch (e) {
            // a full replacement with allowWipe (backup restore) may overwrite an unreadable document
            if (!(options && options.allowWipe && options.replace)) throw e;
            current = [];
        }
        const out = decide(current);
        if (!out.saved) return { saved: false, result: out.result };
        const sorted = prepareTargetsForSave(out.targets, current, source, options);
        replaceContents(doc, sorted);
        return { saved: true, result: out.result, sorted };
    }, { defaultValue: [], fnName: 'prometheusTargetHelper.mutateTargets', label: 'Prometheus targets' });
    return res;
}

async function saveTargetsLocked(newTargets, source = 'system', options = {}) {
    if (!Array.isArray(newTargets)) {
        throw new Error('saveTargetsSafely: newTargets must be an array');
    }
    const r = mutateTargetsDoc(() => ({ saved: true, targets: newTargets }), source, { ...options, replace: true });
    return r.sorted;
}

/** Wipe guard, rolling backup of the current targets, sort. Returns the sorted list to store. */
function prepareTargetsForSave(newTargets, currentFromLock, source = 'system', options = {}) {
    {
        if (!Array.isArray(newTargets)) {
            throw new Error('saveTargetsSafely: newTargets must be an array');
        }

        // 1. Defend against accidental wipe:
        const currentTargets = Array.isArray(currentFromLock) ? currentFromLock : [];

        if (currentTargets.length > 30 && newTargets.length === 0 && !options.allowWipe) {
            throw new Error(`Circuit Breaker Tripped: Blocked attempt to wipe all ${currentTargets.length} targets. Set allowWipe: true if intentional.`);
        }

        // 2. Automatically backup current targets before overwriting
        if (currentTargets.length > 0) {
            createRollingBackup(currentTargets, source);
        }

        // 3. Sort targets
        const sorted = [...newTargets];
        sorted.sort((a, b) => {
            const ipA = a.labels?.addr || (a.targets && a.targets[0] ? a.targets[0].split(':')[0] : '');
            const ipB = b.labels?.addr || (b.targets && b.targets[0] ? b.targets[0].split(':')[0] : '');
            return compareIPs(ipA, ipB);
        });

        // 4. The caller (mutateTargetsDoc) writes it to the document store (single source of truth; no flat file)
        return sorted;
    }
}

/**
 * Lists available rolling backups.
 */
function getBackupsList() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('prometheus_targets_') && f.endsWith('.json'))
            .sort()
            .reverse();

        return files.map(filename => {
            const fullPath = path.join(BACKUP_DIR, filename);
            const stat = fs.statSync(fullPath);
            return {
                filename,
                sizeBytes: stat.size,
                createdAt: stat.mtime.toISOString()
            };
        });
    } catch (e) {
        console.error('[PrometheusTargetHelper] Failed to list backups:', e.message);
        return [];
    }
}

/**
 * Restores a specific backup file.
 */
async function restoreBackup(filename, user = 'System') {
    const cleanFilename = path.basename(filename);
    const backupFile = path.join(BACKUP_DIR, cleanFilename);

    if (!fs.existsSync(backupFile)) {
        throw new Error(`Backup file not found: ${cleanFilename}`);
    }

    const raw = fs.readFileSync(backupFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error('Invalid backup file content: must be an array');
    }

    const restored = await saveTargetsSafely(parsed, `restore_by_${user}`, { allowWipe: true });
    return {
        success: true,
        restoredCount: restored.length,
        filename: cleanFilename
    };
}

module.exports = {
    TARGETS_FILE,
    TARGETS_KEY,
    BACKUP_DIR,
    getTargetsSafely,
    importLegacyTargetsFileOnce,
    saveTargetsSafely,
    updateTargetsSafely,
    createRollingBackup,
    getBackupsList,
    restoreBackup,
    compareIPs
};
