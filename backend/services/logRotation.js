// Two-tier rotation of the Scout log tables (windows_events, linux_logs) and the metrics retention.
//
// It runs in the background worker every 30 minutes, in small batches: every batch is one short SQLite statement,
// and the event loop is released between batches, so neither process stalls while millions of old rows go.
// (It used to run in the web process as a few huge synchronous statements, which froze every page for minutes.)
// - Hot tier: rows older than hotDays are written to archives/archive_<table>_<date>_<ms>.json.gz (up to
//   ARCHIVE_ROWS per file, compressed off the main thread) and then deleted.
// - maxRecords: rows beyond the newest maxRecords (by rowid, i.e. insert order) are archived and deleted the same way.
// - Cold tier: archive files older than the total retention are removed.
// - metrics: rows older than the retention are deleted (no archive).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const db = require('./scoutDb');
const dbManager = require('./db');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const LOG_TABLES = ['windows_events', 'linux_logs'];
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULTS = { batch: 1000, archiveRows: 20000, pauseMs: 25 };

const pause = (ms) => new Promise(r => setTimeout(r, ms));
const archiveDir = () => path.join(process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard', 'archives');

/** Hot tier max 14 days; below 28 days of retention, half of it. */
function calculateDynamicTiers(maxRetentionDays) {
    const totalDays = Math.max(1, Number(maxRetentionDays) || 30);
    const hotDays = totalDays < 28 ? Math.max(1, Math.floor(totalDays / 2)) : 14;
    return { totalDays, hotDays, coldDays: Math.max(0, totalDays - hotDays) };
}

async function writeArchive(tableName, rows) {
    const dir = archiveDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `archive_${tableName}_${new Date().toISOString().slice(0, 10)}_${Date.now()}.json.gz`);
    await fs.promises.writeFile(file, await gzip(JSON.stringify(rows)));
    return file;
}

const stripRid = (rows) => rows.map(({ __rid, ...r }) => r); // eslint-disable-line no-unused-vars

/**
 * Copies the pages the deletions left in the WAL back into the database file now, in this (worker) process. Left to
 * SQLite's automatic checkpoint, that work could fall to the web process's next write and stall it for seconds.
 */
function checkpoint() {
    try {
        if (dbManager.getDriver()?.dbType === 'sqlite') db.get('PRAGMA wal_checkpoint(PASSIVE)');
    } catch { /* best effort */ }
}

/** Deletes rows by rowid, a few hundred per statement, releasing the event loop in between. */
async function deleteRowids(table, rowids, pauseMs) {
    for (let i = 0; i < rowids.length; i += 500) {
        const chunk = rowids.slice(i, i + 500);
        db.run(`DELETE FROM ${table} WHERE rowid IN (${chunk.map(() => '?').join(',')})`, chunk);
        await pause(pauseMs);
    }
}

/**
 * Archives and deletes the rows selected page by page by nextPage(afterRow) (rows carry __rid), archiveRows per
 * archive file. Returns the number of rows removed.
 */
async function archiveAndDelete(table, nextPage, { batch, archiveRows, pauseMs }) {
    let removed = 0;
    let last = null;
    for (;;) {
        const collected = [];
        while (collected.length < archiveRows) {
            const rows = nextPage(last, Math.min(batch, archiveRows - collected.length));
            if (!rows.length) break;
            collected.push(...rows);
            last = rows[rows.length - 1];
            if (rows.length < batch) break;
            await pause(pauseMs);
        }
        if (!collected.length) break;
        const file = await writeArchive(table, stripRid(collected)); // archived before anything is deleted
        await deleteRowids(table, collected.map(r => r.__rid), pauseMs);
        checkpoint();
        removed += collected.length;
        console.log(`[Log Rotation] ${table}: archived and removed ${collected.length} row(s) -> ${path.basename(file)}`);
        if (collected.length < archiveRows) break;
    }
    return removed;
}

/** Hot tier: rows older than cutoff, oldest first (keyset over the timestamp index, so no OFFSET scans). */
function hotPager(table, cutoffIso) {
    return (after, limit) => (after
        ? db.all(`SELECT rowid AS __rid, * FROM ${table} WHERE timestamp < ? AND (timestamp > ? OR (timestamp = ? AND rowid > ?)) ORDER BY timestamp, rowid LIMIT ?`,
            [cutoffIso, after.timestamp, after.timestamp, after.__rid, limit])
        : db.all(`SELECT rowid AS __rid, * FROM ${table} WHERE timestamp < ? ORDER BY timestamp, rowid LIMIT ?`, [cutoffIso, limit]));
}

/** maxRecords: rows at or below rowid maxRid (everything but the newest maxRecords inserts), oldest first. */
function overflowPager(table, maxRid) {
    return (after, limit) => db.all(`SELECT rowid AS __rid, * FROM ${table} WHERE rowid <= ? AND rowid > ? ORDER BY rowid LIMIT ?`,
        [maxRid, after ? after.__rid : -1, limit]);
}

async function cleanupExpiredArchives(tableName, totalDays, now = Date.now()) {
    const dir = archiveDir();
    let files;
    try { files = await fs.promises.readdir(dir); } catch { return 0; }
    const prefix = `archive_${tableName}_`;
    let removed = 0;
    for (const file of files) {
        if (!file.startsWith(prefix) || !file.endsWith('.json.gz')) continue;
        const full = path.join(dir, file);
        try {
            // totalDays 0: every archive of the table goes (legacy metrics archives)
            if (totalDays > 0 && (await fs.promises.stat(full)).mtimeMs >= now - totalDays * DAY_MS) continue;
            await fs.promises.unlink(full);
            removed++;
        } catch { /* gone already */ }
    }
    if (removed) console.log(`[Log Rotation] Removed ${removed} expired archive file(s) of ${tableName}`);
    return removed;
}

/** Deletes metrics older than retentionDays, `batch` rows per statement. */
async function purgeMetrics(retentionDays, { batch, pauseMs }, now = Date.now()) {
    const cutoff = new Date(now - retentionDays * DAY_MS).toISOString();
    let removed = 0;
    for (;;) {
        const r = db.run('DELETE FROM metrics WHERE rowid IN (SELECT rowid FROM metrics WHERE timestamp < ? LIMIT ?)', [cutoff, batch]);
        removed += r.changes || 0;
        if (removed && removed % (batch * 20) === 0) checkpoint();
        if (!r.changes || r.changes < batch) break;
        await pause(pauseMs);
    }
    if (removed) checkpoint();
    if (removed) console.log(`[Metrics Retention] Removed ${removed} metric row(s) older than ${retentionDays} day(s)`);
    return removed;
}

let running = null;

/**
 * One rotation run (at most one at a time in this process; a call during a run waits for that run).
 * @returns {Promise<{ [table]: number, durationMs: number }>}
 */
function runLogRotation(opts = {}) {
    if (running) return running;
    const o = { ...DEFAULTS, ...opts };
    const now = o.now || Date.now();
    running = (async () => {
        const started = Date.now();
        const summary = {};
        try {
            for (const s of db.all('SELECT * FROM log_rotation_settings')) {
                if (Number(s.enabled) !== 1) continue;
                const table = s.id === 'agent_metrics' ? 'metrics' : s.id;
                if (table === 'metrics') {
                    summary.metrics = await purgeMetrics(Number(s.maxRetentionDays) || 7, o, now);
                    await cleanupExpiredArchives('metrics', 0, now);
                    continue;
                }
                if (!LOG_TABLES.includes(table)) continue;
                const { totalDays, hotDays } = calculateDynamicTiers(s.maxRetentionDays);
                let removed = await archiveAndDelete(table, hotPager(table, new Date(now - hotDays * DAY_MS).toISOString()), o);
                const maxRecords = Number(s.maxRecords) || 0;
                if (maxRecords > 0) {
                    const top = db.get(`SELECT MAX(rowid) AS hi FROM ${table}`);
                    const maxRid = top && top.hi ? top.hi - maxRecords : 0;
                    if (maxRid > 0) removed += await archiveAndDelete(table, overflowPager(table, maxRid), o);
                }
                summary[table] = removed;
                await cleanupExpiredArchives(table, totalDays, now);
            }
        } catch (err) {
            console.error('[Log Rotation] Run failed:', err.message);
            summary.error = err.message;
        }
        summary.durationMs = Date.now() - started;
        console.log(`[Log Rotation] Run finished in ${Math.round(summary.durationMs / 1000)}s: ${JSON.stringify(summary)}`);
        return summary;
    })().finally(() => { running = null; });
    return running;
}

let timer = null;
/** Worker: every 30 minutes, the first run 5 minutes after start (not while the service is starting up). */
function scheduleLogRotation({ everyMs = 30 * 60 * 1000, firstMs = 5 * 60 * 1000 } = {}) {
    if (timer) return;
    const tick = () => runLogRotation().catch(err => console.error('[Log Rotation] Scheduler error:', err.message));
    timer = setTimeout(function loop() {
        tick();
        timer = setTimeout(loop, everyMs);
        if (timer.unref) timer.unref();
    }, firstMs);
    if (timer.unref) timer.unref();
}

/** Web process: ask the worker for a run (it owns the rotation); without a worker, run here in the background. */
function requestLogRotation() {
    if (typeof global.sendWorkerMessage === 'function') {
        try {
            global.sendWorkerMessage({ type: 'RUN_LOG_ROTATION' });
            return 'worker';
        } catch { /* fall through */ }
    }
    runLogRotation().catch(() => {});
    return 'local';
}

/**
 * Rows of the newest archive files that match filterFn, newest file first; at most maxFiles files are read, each
 * decompressed off the main thread.
 */
async function readColdArchives(tableName, filterFn, maxLimit = 100, maxFiles = 14) {
    const results = [];
    let files;
    try { files = await fs.promises.readdir(archiveDir()); } catch { return results; }
    const prefix = `archive_${tableName}_`;
    const newest = files.filter(f => f.startsWith(prefix) && f.endsWith('.json.gz')).sort().reverse().slice(0, maxFiles);
    for (const file of newest) {
        if (results.length >= maxLimit) break;
        try {
            const items = JSON.parse((await gunzip(await fs.promises.readFile(path.join(archiveDir(), file)))).toString('utf8'));
            if (!Array.isArray(items)) continue;
            for (let i = items.length - 1; i >= 0 && results.length < maxLimit; i--) {
                if (!filterFn || filterFn(items[i])) results.push(items[i]);
            }
        } catch { /* unreadable archive: skipped */ }
    }
    return results;
}

module.exports = {
    calculateDynamicTiers, runLogRotation, scheduleLogRotation, requestLogRotation, readColdArchives,
    cleanupExpiredArchives, purgeMetrics, LOG_TABLES, _internals: { hotPager, overflowPager, archiveAndDelete },
};
