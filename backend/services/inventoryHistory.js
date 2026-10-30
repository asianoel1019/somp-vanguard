/**
 * Server Inventory scan history (scout.sqlite, same handle as inventory_hosts):
 *  - inventory_scans: one row per scan run (incl. partial / aborted ones)
 *  - inventory_host_changes: field level changes recorded while a scan stores its results
 * Retention is configurable (historyRetentionDays, 30-730, default 180) and cleaned in small batches by the worker.
 */
const DEFAULT_RETENTION_DAYS = 180;
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 730;
const CLEANUP_BATCH = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEGACY_KEY = 'server_operation/status_changes.json';

// field name stored in the history -> key of the legacy host object (inventoryStore.rowToHost)
const TRACKED_FIELDS = { hostname: 'hostname', os: 'os', osVersion: 'osVersion', cpu: 'cpu', memoryGB: 'mem', timezone: 'timezone', status: 'status' };

const readyHandles = new WeakSet();

function getHandle() {
    const handle = require('./inventoryStore').getHandle();
    if (!readyHandles.has(handle)) {
        ensureTables(handle);
        readyHandles.add(handle);
    }
    return handle;
}

/** Idempotent: CREATE TABLE IF NOT EXISTS + indexes ("trigger" is quoted: it is an SQL keyword). */
function ensureTables(handle) {
    handle.exec(`CREATE TABLE IF NOT EXISTS inventory_scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        runId TEXT,
        "trigger" TEXT,
        requestedBy TEXT,
        scope TEXT,
        startedAt TEXT,
        finishedAt TEXT,
        durationMs INTEGER,
        subnets TEXT,
        ipsChecked INTEGER DEFAULT 0,
        online INTEGER DEFAULT 0,
        offline INTEGER DEFAULT 0,
        newHosts INTEGER DEFAULT 0,
        disappeared INTEGER DEFAULT 0,
        degradedSubnets TEXT,
        aborted INTEGER DEFAULT 0,
        note TEXT
    )`);
    try { handle.exec('ALTER TABLE inventory_scans ADD COLUMN note TEXT'); } catch (e) { /* already there */ }
    handle.exec(`CREATE TABLE IF NOT EXISTS inventory_host_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scanId INTEGER,
        ip TEXT,
        field TEXT,
        oldValue TEXT,
        newValue TEXT,
        at TEXT
    )`);
    for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_inventory_scans_startedAt ON inventory_scans(startedAt)',
        'CREATE INDEX IF NOT EXISTS idx_inventory_changes_scanId ON inventory_host_changes(scanId)',
        'CREATE INDEX IF NOT EXISTS idx_inventory_changes_ip ON inventory_host_changes(ip)',
        'CREATE INDEX IF NOT EXISTS idx_inventory_changes_at ON inventory_host_changes(at)'
    ]) {
        try { handle.exec(sql); } catch (e) { /* index is an optimisation only */ }
    }
}

/** Comparable text of a field value: '', null, 'unknown' / 'Unknown' (placeholder of a failed probe) are all "empty". */
function norm(v) {
    if (v === undefined || v === null) return '';
    const t = String(v).trim();
    return t.toLowerCase() === 'unknown' ? '' : t;
}

/**
 * Field level diff between the stored host before and after a scan write (legacy host objects).
 * A host seen for the first time only records its status (null -> online). A field that is empty after the scan
 * (probe failed, nothing new) is not a change.
 */
function diffHost(before, after) {
    const changes = [];
    if (!after) return changes;
    if (!before) {
        if (norm(after.status)) changes.push({ field: 'status', oldValue: null, newValue: norm(after.status) });
        return changes;
    }
    for (const [field, key] of Object.entries(TRACKED_FIELDS)) {
        const o = norm(before[key]);
        const n = norm(after[key]);
        if (n === '' || o === n) continue;
        if (field === 'hostname' && o.toLowerCase() === n.toLowerCase()) continue;
        changes.push({ field, oldValue: o === '' ? null : o, newValue: n });
    }
    return changes;
}

function jsonOrNull(v) {
    if (v === undefined || v === null) return null;
    try { return JSON.stringify(v); } catch (e) { return null; }
}

function parseJson(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
}

/** Creates the scans row at scan start. Returns its id. */
function startScan({ runId = null, trigger = 'manual', requestedBy = null, scope = null, startedAt = new Date().toISOString(), subnets = [] } = {}) {
    const h = getHandle();
    const res = h.prepare('INSERT INTO inventory_scans (runId, "trigger", requestedBy, scope, startedAt, subnets, aborted) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(runId, trigger, requestedBy, jsonOrNull(scope), startedAt, jsonOrNull(subnets));
    return Number(res.lastInsertRowid);
}

/** Closes the scans row with the final counters. */
function finishScan(id, s = {}) {
    if (!id) return false;
    const h = getHandle();
    const finishedAt = s.finishedAt || new Date().toISOString();
    return Number(h.prepare('UPDATE inventory_scans SET finishedAt = ?, durationMs = ?, ipsChecked = ?, online = ?, offline = ?, newHosts = ?, disappeared = ?, degradedSubnets = ?, aborted = ? WHERE id = ?')
        .run(finishedAt, Math.max(0, Math.round(Number(s.durationMs) || 0)), Number(s.ipsChecked) || 0, Number(s.online) || 0, Number(s.offline) || 0,
            Number(s.newHosts) || 0, Number(s.disappeared) || 0, jsonOrNull(s.degradedSubnets || []), s.aborted ? 1 : 0, id).changes) > 0;
}

/**
 * Worker start: scan rows still open (finishedAt NULL) belong to a worker that died mid-scan. They are closed as
 * aborted with note 'interrupted'. exceptId = the run that is starting right now.
 */
function closeInterrupted({ exceptId = null, now = new Date().toISOString() } = {}) {
    const h = getHandle();
    const res = exceptId
        ? h.prepare("UPDATE inventory_scans SET finishedAt = ?, aborted = 1, note = 'interrupted' WHERE finishedAt IS NULL AND id != ?").run(now, exceptId)
        : h.prepare("UPDATE inventory_scans SET finishedAt = ?, aborted = 1, note = 'interrupted' WHERE finishedAt IS NULL").run(now);
    return Number(res.changes);
}

/** Inserts change rows ({ ip, field, oldValue, newValue, at? }) in one transaction. Returns the number stored. */
function recordChanges(scanId, changes) {
    const list = (changes || []).filter(c => c && c.ip && c.field);
    if (!scanId || !list.length) return 0;
    const h = getHandle();
    const now = new Date().toISOString();
    const ins = h.prepare('INSERT INTO inventory_host_changes (scanId, ip, field, oldValue, newValue, at) VALUES (?, ?, ?, ?, ?, ?)');
    const own = !(h.inTransaction || h.isTransaction);
    if (own) h.exec('BEGIN IMMEDIATE');
    try {
        for (const c of list) {
            ins.run(scanId, String(c.ip), String(c.field), c.oldValue === undefined || c.oldValue === null ? null : String(c.oldValue),
                c.newValue === undefined || c.newValue === null ? null : String(c.newValue), c.at || now);
        }
        if (own) h.exec('COMMIT');
    } catch (e) {
        if (own) { try { h.exec('ROLLBACK'); } catch (_) {} }
        throw e;
    }
    return list.length;
}

function clampInt(v, dflt, lo, hi) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
}

function scanRowToApi(r) {
    return {
        id: Number(r.id),
        runId: r.runId || null,
        trigger: r.trigger || null,
        requestedBy: r.requestedBy || null,
        scope: parseJson(r.scope, null),
        partial: !!parseJson(r.scope, null),
        startedAt: r.startedAt || null,
        finishedAt: r.finishedAt || null,
        running: !r.finishedAt,
        durationMs: r.durationMs === null || r.durationMs === undefined ? null : Number(r.durationMs),
        subnets: parseJson(r.subnets, []),
        ipsChecked: Number(r.ipsChecked) || 0,
        online: Number(r.online) || 0,
        offline: Number(r.offline) || 0,
        newHosts: Number(r.newHosts) || 0,
        disappeared: Number(r.disappeared) || 0,
        degradedSubnets: parseJson(r.degradedSubnets, []),
        aborted: !!r.aborted,
        interrupted: r.note === 'interrupted'
    };
}

/** Newest scans first. before = id cursor (scans older than that id). Returns { scans, nextBefore }. */
function listScans({ limit, before } = {}) {
    const lim = clampInt(limit, 25, 1, 200);
    const h = getHandle();
    const beforeId = parseInt(before, 10);
    const rows = Number.isFinite(beforeId)
        ? h.prepare('SELECT * FROM inventory_scans WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, lim + 1)
        : h.prepare('SELECT * FROM inventory_scans ORDER BY id DESC LIMIT ?').all(lim + 1);
    const more = rows.length > lim;
    const page = rows.slice(0, lim).map(scanRowToApi);
    return { scans: page, nextBefore: more && page.length ? page[page.length - 1].id : null };
}

function getScan(id) {
    const r = getHandle().prepare('SELECT * FROM inventory_scans WHERE id = ?').get(id);
    return r ? scanRowToApi(r) : null;
}

function changeRowToApi(r) {
    return { id: Number(r.id), scanId: Number(r.scanId), ip: r.ip, field: r.field, oldValue: r.oldValue === undefined ? null : r.oldValue, newValue: r.newValue === undefined ? null : r.newValue, at: r.at };
}

/** Changes of one scan: { total, changes } ordered by ip then field. */
function listScanChanges(scanId, { limit, offset } = {}) {
    const lim = clampInt(limit, 100, 1, 1000);
    const off = clampInt(offset, 0, 0, 1e9);
    const h = getHandle();
    const total = Number(h.prepare('SELECT COUNT(*) AS c FROM inventory_host_changes WHERE scanId = ?').get(scanId).c);
    const rows = h.prepare('SELECT * FROM inventory_host_changes WHERE scanId = ? ORDER BY ip, id LIMIT ? OFFSET ?').all(scanId, lim, off);
    return { total, changes: rows.map(changeRowToApi) };
}

/** Changes of one host, newest first. */
function listHostChanges(ip, { limit, offset } = {}) {
    const lim = clampInt(limit, 100, 1, 1000);
    const off = clampInt(offset, 0, 0, 1e9);
    const h = getHandle();
    const total = Number(h.prepare('SELECT COUNT(*) AS c FROM inventory_host_changes WHERE ip = ?').get(ip).c);
    const rows = h.prepare('SELECT * FROM inventory_host_changes WHERE ip = ? ORDER BY at DESC, id DESC LIMIT ? OFFSET ?').all(ip, lim, off);
    return { total, changes: rows.map(changeRowToApi) };
}

/** Read-only: entries of the old 1000-entry status_changes.json (nothing writes it any more). */
function readLegacyStatusChanges(max = 200) {
    try {
        const { readDataSync } = require('../lib/db');
        let data = readDataSync(LEGACY_KEY, []);
        if (!Array.isArray(data) || data.length === 0) data = readDataSync('server_operation/oscheck/status_changes.json', []);
        return Array.isArray(data) ? data.slice(0, max) : [];
    } catch (e) { return []; }
}

function retentionDays(config) {
    return clampInt(config && config.historyRetentionDays, DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS);
}

const yieldTurn = () => new Promise(r => setImmediate(r));

/**
 * Deletes history older than the retention window in LIMIT-bounded batches (the event loop is yielded between them).
 * Returns { scans, changes } deleted counts.
 */
async function cleanup({ retentionDays: days = DEFAULT_RETENTION_DAYS, batchSize = CLEANUP_BATCH, now = Date.now(), orphans = false } = {}) {
    const h = getHandle();
    const cutoff = new Date(now - clampInt(days, DEFAULT_RETENTION_DAYS, 1, 36500) * DAY_MS).toISOString();
    const out = { scans: 0, changes: 0 };
    const run = async (table, col, key) => {
        for (;;) {
            const res = h.prepare(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${col} < ? LIMIT ?)`).run(cutoff, batchSize);
            const n = Number(res.changes);
            out[table === 'inventory_scans' ? 'scans' : 'changes'] += n;
            if (n < batchSize) break;
            await yieldTurn();
        }
    };
    await run('inventory_host_changes', 'at', 'id');
    await run('inventory_scans', 'startedAt', 'id');
    // changes of scans that no longer exist: anti-join over the whole table, so only the daily run does it (orphans: true)
    while (orphans) {
        const res = h.prepare('DELETE FROM inventory_host_changes WHERE id IN (SELECT c.id FROM inventory_host_changes c LEFT JOIN inventory_scans s ON s.id = c.scanId WHERE s.id IS NULL LIMIT ?)').run(batchSize);
        const n = Number(res.changes);
        out.changes += n;
        if (n < batchSize) break;
        await yieldTurn();
    }
    return out;
}

let cleanupTimer = null;
/** Worker only: one cleanup shortly after start, then once per day. Safe to call repeatedly. */
function scheduleDailyCleanup(readConfig, { firstDelayMs = 60 * 1000 } = {}) {
    if (cleanupTimer) return false;
    const tick = async () => {
        try {
            const cfg = (await readConfig()) || {};
            const res = await cleanup({ retentionDays: retentionDays(cfg), orphans: true });
            if (res.scans || res.changes) console.log(`[Inventory] History cleanup removed ${res.scans} scan(s) and ${res.changes} change(s).`);
        } catch (e) { console.error('[Inventory] History cleanup failed:', e.message); }
    };
    const first = setTimeout(() => { tick(); }, firstDelayMs);
    if (first.unref) first.unref();
    cleanupTimer = setInterval(tick, DAY_MS);
    if (cleanupTimer.unref) cleanupTimer.unref();
    return true;
}

module.exports = {
    DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS, TRACKED_FIELDS,
    ensureTables, diffHost, closeInterrupted, startScan, finishScan, recordChanges, listScans, getScan, listScanChanges, listHostChanges,
    readLegacyStatusChanges, retentionDays, cleanup, scheduleDailyCleanup
};
