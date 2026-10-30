/**
 * Append-style log tables that replace the former log DOCUMENTS (one row per entry instead of one JSON array that every
 * writer read, modified and rewrote as a whole):
 *
 *   table                document it replaces (now 'legacy')         order of the old array   retention / row cap
 *   scheduler_logs       server_operation/scheduler_logs.json         oldest first             90 d  /  50 000
 *   cmdb_history         server_operation/server_cmdb_history.json    newest first             365 d / 200 000
 *   dns_changes          dns_changes.json                              newest first             365 d / 200 000
 *   workflow_executions  workflow_executions.json                      oldest first (by id)     90 d  /   5 000 (waiting_approval rows are never pruned)
 *   workflow_history     workflow_history.json                         oldest first             90 d  /  20 000 (+ 10 versions per workflow, as before)
 *
 * Storage: the synchronous SQLite handle shared by both processes, exactly like inventory_hosts / inventory_scans /
 * provision_jobs (services/inventoryStore.js getHandle): scout.sqlite on the SQLite engine; with PostgreSQL / MSSQL /
 * MariaDB the tables live in the local database.sqlite next to it (those engines have no synchronous handle).
 *
 * Every table: id INTEGER PRIMARY KEY AUTOINCREMENT (insertion order = the old array order), created_at (ISO text,
 * indexed; used by retention), the columns readers filter on, and `entry` = the full original entry as JSON text, so
 * readers return the identical objects. Readers keep the old order / limits (see the store modules and routes).
 *
 * One-time migration (idempotent): the first access in any process (and explicitly at web startup, index.js) copies the
 * old document into the table in the original order, keeping the entries' own timestamps, inside BEGIN IMMEDIATE on the
 * same database, and writes the authoritative marker row (log_table_meta 'migrated:<table>', with the count) in that
 * same transaction: when both processes start at once the second one waits for the lock and then sees the marker.
 * The old document is never modified or deleted (rollback path). An informational copy of the marker is merged into
 * the document system/log_tables_migration.json (docRegistry 'replace') after the commit.
 *
 * Retention: prune() deletes rows older than RETENTION_<TABLE>_DAYS (.env; 0 = no age limit) and the oldest rows above
 * the row cap, in bounded LIMIT batches. The worker runs it once shortly after start and then daily (scheduleDailyPrune).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH = 5000;
const MAX_BATCHES_PER_RUN = 40; // bounded work per table per run (<= 200 000 rows); the rest goes on the next run
const MARKER_KEY = 'system/log_tables_migration.json';
const META_TABLE = 'log_table_meta';

const str = (v) => (typeof v === 'string' ? v : null);

/** ISO text of a timestamp value, null when it cannot be parsed. */
function isoOrNull(v) {
    if (v === undefined || v === null || v === '') return null;
    const t = typeof v === 'number' ? v : Date.parse(String(v));
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * 'YYYY-MM-DD HH:mm:ss' wall time in `timeZone` (the dns_changes.json timestamp format: sv-SE locale string) -> ISO.
 * Falls back to Date.parse for any other format; null when unparsable.
 */
function zonedToIso(text, timeZone) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(text || '').trim());
    if (!m) return isoOrNull(text);
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    let offset = 0;
    try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(guess)).map(p => [p.type, p.value]));
        const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
        offset = asUtc - guess;
    } catch (e) { offset = 0; }
    const t = guess - offset;
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const dnsTimeZone = () => process.env.TZ || 'Asia/Taipei';

/**
 * Table definitions. columns: [name, value(entry)] (all TEXT). created(entry, { migrating }) -> ISO created_at.
 * newestFirst: the old document kept the newest entry at index 0 (migration inserts it reversed).
 */
const TABLES = {
    scheduler_logs: {
        legacyKey: 'server_operation/scheduler_logs.json', newestFirst: false,
        columns: [['task_id', e => str(e.taskId)], ['task_name', e => str(e.taskName)], ['run_status', e => str(e.runStatus)]],
        indexes: ['task_id'],
        created: (e) => isoOrNull(e.runTime),
        retentionEnv: 'RETENTION_SCHEDULER_LOGS_DAYS', defaultDays: 90, cap: 50000,
    },
    cmdb_history: {
        legacyKey: 'server_operation/server_cmdb_history.json', newestFirst: true,
        columns: [['ip', e => str(e.ip)], ['username', e => str(e.username)], ['action', e => str(e.action)], ['entry_id', e => str(e.id)]],
        indexes: ['ip'],
        created: (e) => isoOrNull(e.timestamp),
        retentionEnv: 'RETENTION_CMDB_HISTORY_DAYS', defaultDays: 365, cap: 200000,
    },
    dns_changes: {
        legacyKey: 'dns_changes.json', newestFirst: true,
        columns: [['username', e => str(e.user)]],
        indexes: ['username'],
        // the stored timestamp is a local wall-clock string; a new row is stamped with the insert time
        created: (e, { migrating }) => (migrating ? zonedToIso(e.timestamp, dnsTimeZone()) : null),
        retentionEnv: 'RETENTION_DNS_CHANGES_DAYS', defaultDays: 365, cap: 200000,
    },
    workflow_executions: {
        legacyKey: 'workflow_executions.json', newestFirst: false,
        columns: [['exec_id', e => str(e.id)], ['workflow_id', e => str(e.workflowId)], ['status', e => str(e.status)]],
        indexes: ['workflow_id'],
        unique: 'exec_id',
        created: (e) => isoOrNull(e.startedAt),
        retentionEnv: 'RETENTION_WORKFLOW_EXECUTIONS_DAYS', defaultDays: 90, cap: 5000,
        keepWhere: "(status IS NULL OR status != 'waiting_approval')", // rows prune / cap may delete
    },
    workflow_history: {
        legacyKey: 'workflow_history.json', newestFirst: false,
        columns: [['workflow_id', e => str(e.id)]],
        indexes: ['workflow_id'],
        created: (e, { migrating }) => (migrating ? isoOrNull(e.updatedAt || e.createdAt) : null),
        // version snapshots (max 10 per workflow): no age limit by default, or an untouched workflow loses its history
        retentionEnv: 'RETENTION_WORKFLOW_HISTORY_DAYS', defaultDays: 0, cap: 20000,
    },
};
const TABLE_NAMES = Object.keys(TABLES);

function def(name) {
    const d = TABLES[name];
    if (!d) throw new Error(`logTables: unknown table ${name}`);
    return d;
}

// ---------------------------------------------------------------------------------------------------------------
// handle / schema / migration
// ---------------------------------------------------------------------------------------------------------------
const readyHandles = new WeakSet();
const migratedByHandle = new WeakMap(); // handle -> Set(table)
const testHooks = { handle: null };

// SQLite can answer "database is locked" at once (without waiting for busy_timeout), e.g. when the web process and the
// worker create the schema or open a write transaction at the same moment: retry with a short backoff.
const BUSY_ATTEMPTS = 8;
const isBusy = (e) => !!e && (e.code === 'SQLITE_BUSY' || e.errcode === 5 || /locked|busy/i.test(String(e.message || '')));
function syncDelay(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch (e) { const t = Date.now(); while (Date.now() - t < ms) { /* spin */ } }
}
function withBusyRetry(fn) {
    for (let attempt = 0; ; attempt++) {
        try { return fn(); }
        catch (e) {
            if (isBusy(e) && attempt < BUSY_ATTEMPTS - 1) { syncDelay(25 * Math.pow(2, attempt) + Math.floor(Math.random() * 25)); continue; }
            throw e;
        }
    }
}

function ensureTables(handle) {
    withBusyRetry(() => createTables(handle)); // every statement is IF NOT EXISTS: safe to repeat
}

function createTables(handle) {
    handle.exec(`CREATE TABLE IF NOT EXISTS ${META_TABLE} (name TEXT PRIMARY KEY, value TEXT)`);
    for (const [name, d] of Object.entries(TABLES)) {
        const cols = d.columns.map(([c]) => `${c} TEXT`).join(', ');
        handle.exec(`CREATE TABLE IF NOT EXISTS ${name} (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, ${cols}, entry TEXT NOT NULL)`);
        const idx = [`CREATE INDEX IF NOT EXISTS idx_${name}_created_at ON ${name}(created_at)`]
            .concat(d.indexes.map(c => `CREATE INDEX IF NOT EXISTS idx_${name}_${c} ON ${name}(${c})`));
        if (d.unique) idx.push(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${name}_${d.unique}_unique ON ${name}(${d.unique})`);
        for (const sql of idx) {
            try { handle.exec(sql); } catch (e) { if (d.unique && sql.includes('UNIQUE')) throw e; /* plain index: optimisation only */ }
        }
    }
}

/** The shared synchronous handle (tables created once per handle). */
function getHandle() {
    const handle = testHooks.handle || require('./inventoryStore').getHandle();
    if (!readyHandles.has(handle)) {
        ensureTables(handle);
        readyHandles.add(handle);
    }
    return handle;
}

function tx(handle, fn) {
    if (handle.inTransaction || handle.isTransaction) return fn();
    withBusyRetry(() => handle.exec('BEGIN IMMEDIATE'));
    try {
        const out = fn();
        handle.exec('COMMIT');
        return out;
    } catch (e) {
        try { handle.exec('ROLLBACK'); } catch (_) { /* not in a transaction */ }
        throw e;
    }
}

function insertStmt(handle, name) {
    const d = def(name);
    const cols = ['created_at', ...d.columns.map(([c]) => c), 'entry'];
    const verb = d.unique ? 'INSERT OR IGNORE' : 'INSERT';
    return handle.prepare(`${verb} INTO ${name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
}

function rowValues(name, entry, opts) {
    const d = def(name);
    const e = entry && typeof entry === 'object' ? entry : {};
    const created = d.created(e, opts) || opts.now || new Date().toISOString();
    return [created, ...d.columns.map(([, get]) => get(e)), JSON.stringify(entry === undefined ? null : entry)];
}

function readMarker(handle, name) {
    const r = handle.prepare(`SELECT value FROM ${META_TABLE} WHERE name = ?`).get(`migrated:${name}`);
    if (!r) return null;
    try { return JSON.parse(r.value); } catch (e) { return {}; }
}

/** The old document (read only; never written again). */
function readLegacy(key) {
    const { readDataSync } = require('../lib/db');
    const v = readDataSync(key, []);
    return Array.isArray(v) ? v : [];
}

function writeInfoMarker(name, info) {
    try {
        require('../lib/docStore').mutateDocument(MARKER_KEY, (doc) => { doc[name] = info; }, {
            defaultValue: {}, fnName: 'logTables.marker', label: MARKER_KEY,
        });
    } catch (e) {
        console.warn(`[LogTables] migration marker document not written (${name}): ${e.message}`);
    }
}

/**
 * Copies the legacy document of `name` into its table once. Returns { table, skipped, count }.
 * The marker row is written in the same transaction as the rows (cross-process safe).
 */
function migrate(name) {
    const d = def(name);
    const handle = getHandle();
    let done = migratedByHandle.get(handle);
    if (!done) { done = new Set(); migratedByHandle.set(handle, done); }
    if (done.has(name)) return { table: name, skipped: true, count: 0 };
    const res = tx(handle, () => {
        const marker = readMarker(handle, name);
        if (marker) return { table: name, skipped: true, count: Number(marker.count) || 0 };
        const doc = readLegacy(d.legacyKey);
        const list = d.newestFirst ? doc.slice().reverse() : doc;
        const ins = insertStmt(handle, name);
        const now = new Date().toISOString();
        let count = 0;
        for (const entry of list) {
            if (entry === undefined) continue;
            count += Number(ins.run(...rowValues(name, entry, { migrating: true, now })).changes) || 0;
        }
        const info = { migratedAt: now, count, sourceKey: d.legacyKey, sourceEntries: doc.length };
        handle.prepare(`INSERT INTO ${META_TABLE} (name, value) VALUES (?, ?)`).run(`migrated:${name}`, JSON.stringify(info));
        return { table: name, skipped: false, count, info };
    });
    done.add(name);
    if (!res.skipped) {
        writeInfoMarker(name, res.info);
        if (res.count) console.log(`[LogTables] Migrated ${res.count} entr${res.count === 1 ? 'y' : 'ies'} of ${d.legacyKey} into table ${name}.`);
    }
    return { table: name, skipped: res.skipped, count: res.count };
}

/** Startup: migrates every table (idempotent; failures are logged, the lazy path retries on first use). */
function migrateAll() {
    const out = [];
    for (const name of TABLE_NAMES) {
        try { out.push(migrate(name)); } catch (e) {
            console.error(`[LogTables] migration of ${name} failed: ${e.message}`);
            out.push({ table: name, error: e.message });
        }
    }
    return out;
}

/** Handle with the table ready and migrated (every reader / writer goes through this). */
function ready(name) {
    migrate(name);
    return getHandle();
}

const parseEntry = (r) => { try { return JSON.parse(r.entry); } catch (e) { return null; } };

/**
 * Rows of `sql` (which has no LIMIT) as entries, limited exactly like Array.prototype.slice(0, limit) on the full
 * list: undefined = all; a positive finite limit becomes SQL LIMIT; anything else (0, negative, NaN, Infinity) is
 * applied with slice on the full result.
 */
function limitedRows(h, sql, params, limit) {
    if (limit === undefined) return h.prepare(sql).all(...params).map(parseEntry);
    const n = Number(limit);
    if (Number.isFinite(n) && n >= 1) return h.prepare(`${sql} LIMIT ?`).all(...params, Math.trunc(n)).map(parseEntry);
    return h.prepare(sql).all(...params).map(parseEntry).slice(0, limit);
}

// ---------------------------------------------------------------------------------------------------------------
// writers
// ---------------------------------------------------------------------------------------------------------------

/** Appends entries (in the given order: ascending ids) in one transaction. Returns the number inserted. */
function append(name, entries) {
    const list = (Array.isArray(entries) ? entries : [entries]).filter(e => e !== undefined && e !== null);
    if (!list.length) return 0;
    const h = ready(name);
    return tx(h, () => {
        const ins = insertStmt(h, name);
        const now = new Date().toISOString();
        let n = 0;
        for (const e of list) n += Number(ins.run(...rowValues(name, e, { migrating: false, now })).changes) || 0;
        return n;
    });
}

// ---------------------------------------------------------------------------------------------------------------
// scheduler_logs
// ---------------------------------------------------------------------------------------------------------------

/** Newest first, at most `limit` entries (the old logs.reverse().slice(0, limit)). */
function listSchedulerLogs(limit = 200) {
    const h = ready('scheduler_logs');
    return h.prepare('SELECT entry FROM scheduler_logs ORDER BY id DESC LIMIT ?').all(Math.max(0, Number(limit) || 0)).map(parseEntry);
}

/** Every entry, oldest first, without the (large) stdout / stderr fields (for statistics). */
function listSchedulerLogsLite() {
    const h = ready('scheduler_logs');
    let rows;
    try {
        rows = h.prepare("SELECT json_remove(entry, '$.stdout', '$.stderr') AS entry FROM scheduler_logs ORDER BY id").all();
    } catch (e) {
        rows = h.prepare('SELECT entry FROM scheduler_logs ORDER BY id').all(); // SQLite without JSON1
    }
    return rows.map(parseEntry);
}

// ---------------------------------------------------------------------------------------------------------------
// cmdb_history
// ---------------------------------------------------------------------------------------------------------------

/**
 * Newest first. opts: ips (array: entries whose ip is one of them), excludeAction (entries with exactly that action are
 * skipped), limit (default: all).
 */
function listCmdbHistory({ ips, excludeAction, limit } = {}) {
    const h = ready('cmdb_history');
    const where = [];
    const params = [];
    if (Array.isArray(ips)) {
        const list = [...new Set(ips.filter(ip => typeof ip === 'string'))];
        if (!list.length) return [];
        where.push(`ip IN (${list.map(() => '?').join(', ')})`);
        params.push(...list);
    }
    if (typeof excludeAction === 'string') { where.push('(action IS NULL OR action != ?)'); params.push(excludeAction); }
    return limitedRows(h, `SELECT entry FROM cmdb_history${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`, params, limit);
}

// ---------------------------------------------------------------------------------------------------------------
// dns_changes
// ---------------------------------------------------------------------------------------------------------------

/** Newest first, at most `limit` entries. */
function listDnsChanges(limit) {
    const h = ready('dns_changes');
    return h.prepare('SELECT entry FROM dns_changes ORDER BY id DESC LIMIT ?').all(Math.max(0, Number(limit) || 0)).map(parseEntry);
}

// ---------------------------------------------------------------------------------------------------------------
// workflow_executions
// ---------------------------------------------------------------------------------------------------------------

/**
 * Stores an execution: replaces the row with the same id in place (keeps its position) or appends it, then trims the
 * oldest rows that are not waiting for approval above `cap` (the former saveExecution behaviour). One transaction.
 */
function saveExecution(execution, cap = TABLES.workflow_executions.cap) {
    const h = ready('workflow_executions');
    const id = str(execution && execution.id);
    const [created, execId, workflowId, status, entry] = rowValues('workflow_executions', execution, { migrating: false });
    return tx(h, () => {
        let changed = 0;
        if (id !== null) {
            changed = Number(h.prepare('UPDATE workflow_executions SET workflow_id = ?, status = ?, entry = ? WHERE exec_id = ?')
                .run(workflowId, status, entry, id).changes) || 0;
        }
        if (!changed) {
            h.prepare('INSERT INTO workflow_executions (created_at, exec_id, workflow_id, status, entry) VALUES (?, ?, ?, ?, ?)')
                .run(created, execId, workflowId, status, entry);
        }
        const total = Number(h.prepare('SELECT COUNT(*) AS c FROM workflow_executions').get().c);
        const excess = total - cap;
        if (excess > 0) {
            h.prepare(`DELETE FROM workflow_executions WHERE id IN (SELECT id FROM workflow_executions WHERE ${TABLES.workflow_executions.keepWhere} ORDER BY id LIMIT ?)`).run(excess);
        }
        return true;
    });
}

/** The first stored execution with that id, or null. */
function getExecution(id) {
    if (typeof id !== 'string') return null;
    const h = ready('workflow_executions');
    const r = h.prepare('SELECT entry FROM workflow_executions WHERE exec_id = ? ORDER BY id LIMIT 1').get(id);
    return r ? parseEntry(r) : null;
}

/**
 * Newest started first (ties: stored order), optionally of one workflow, at most `limit`
 * (the old filter -> sort by startedAt desc (stable) -> slice).
 */
function listExecutions(workflowId, limit = 20) {
    if (workflowId && typeof workflowId !== 'string') return [];
    const h = ready('workflow_executions');
    const where = workflowId ? ' WHERE workflow_id = ?' : '';
    const params = workflowId ? [workflowId] : [];
    // created_at = startedAt as ISO text (lexical order = time order); ties keep the stored order (stable sort)
    return limitedRows(h, `SELECT entry FROM workflow_executions${where} ORDER BY created_at DESC, id ASC`, params, limit);
}

// ---------------------------------------------------------------------------------------------------------------
// workflow_history
// ---------------------------------------------------------------------------------------------------------------

/** Appends a version snapshot; with perWorkflowMax, removes that workflow's oldest snapshot when it has more. */
function appendWorkflowHistory(snapshot, perWorkflowMax = null) {
    const h = ready('workflow_history');
    const wfId = str(snapshot && snapshot.id);
    return tx(h, () => {
        insertStmt(h, 'workflow_history').run(...rowValues('workflow_history', snapshot, { migrating: false }));
        if (perWorkflowMax && wfId !== null) {
            const n = Number(h.prepare('SELECT COUNT(*) AS c FROM workflow_history WHERE workflow_id = ?').get(wfId).c);
            if (n > perWorkflowMax) {
                h.prepare('DELETE FROM workflow_history WHERE id = (SELECT MIN(id) FROM workflow_history WHERE workflow_id = ?)').run(wfId);
            }
        }
        return true;
    });
}

/** Snapshots of one workflow, oldest first. */
function listWorkflowHistory(workflowId) {
    if (typeof workflowId !== 'string') return [];
    const h = ready('workflow_history');
    return h.prepare('SELECT entry FROM workflow_history WHERE workflow_id = ? ORDER BY id').all(workflowId).map(parseEntry);
}

/** Removes every snapshot of a workflow. Returns the number removed. */
function deleteWorkflowHistory(workflowId) {
    if (typeof workflowId !== 'string') return 0;
    const h = ready('workflow_history');
    return Number(h.prepare('DELETE FROM workflow_history WHERE workflow_id = ?').run(workflowId).changes) || 0;
}

// ---------------------------------------------------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------------------------------------------------

/** Retention days of a table from .env (RETENTION_<TABLE>_DAYS), default per table; 0 = no age limit. */
function retentionDays(name, env = process.env) {
    const d = def(name);
    const raw = env[d.retentionEnv];
    if (raw === undefined || raw === null || String(raw).trim() === '') return d.defaultDays;
    const n = parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(n) || n < 0) return d.defaultDays;
    return Math.min(n, 36500);
}

const yieldTurn = () => new Promise(r => setImmediate(r));

/**
 * Deletes rows older than the retention window and the oldest rows above the row cap, LIMIT-bounded batches with the
 * event loop yielded in between (at most MAX_BATCHES_PER_RUN batches per table and step). Returns { <table>: { aged, capped } }.
 * opts: tables, now (ms), batchSize, caps ({ table: n }), env.
 */
async function prune({ tables = TABLE_NAMES, now = Date.now(), batchSize = BATCH, caps = {}, env = process.env, maxBatches = MAX_BATCHES_PER_RUN } = {}) {
    const out = {};
    for (const name of tables) {
        const d = def(name);
        const h = ready(name);
        const keep = d.keepWhere ? ` AND ${d.keepWhere}` : '';
        const res = { aged: 0, capped: 0 };
        const days = retentionDays(name, env);
        if (days > 0) {
            const cutoff = new Date(now - days * DAY_MS).toISOString();
            for (let i = 0; i < maxBatches; i++) {
                const n = Number(h.prepare(`DELETE FROM ${name} WHERE id IN (SELECT id FROM ${name} WHERE created_at < ?${keep} ORDER BY id LIMIT ?)`).run(cutoff, batchSize).changes) || 0;
                res.aged += n;
                if (n < batchSize) break;
                await yieldTurn();
            }
        }
        const cap = Number.isFinite(caps[name]) ? caps[name] : d.cap;
        for (let i = 0; i < maxBatches; i++) {
            const total = Number(h.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c);
            const excess = Math.min(total - cap, batchSize);
            if (excess <= 0) break;
            const n = Number(h.prepare(`DELETE FROM ${name} WHERE id IN (SELECT id FROM ${name} WHERE 1 = 1${keep} ORDER BY id LIMIT ?)`).run(excess).changes) || 0;
            res.capped += n;
            if (n === 0) break;
            await yieldTurn();
        }
        out[name] = res;
    }
    return out;
}

let pruneTimer = null;
/** Worker only: one prune shortly after start, then once per day. Safe to call repeatedly. */
function scheduleDailyPrune({ firstDelayMs = 2 * 60 * 1000 } = {}) {
    if (pruneTimer) return false;
    const tick = async () => {
        try {
            const res = await prune();
            const removed = Object.entries(res).filter(([, r]) => r.aged || r.capped).map(([t, r]) => `${t}: ${r.aged} aged, ${r.capped} over cap`);
            if (removed.length) console.log(`[LogTables] Retention removed rows (${removed.join('; ')}).`);
        } catch (e) { console.error('[LogTables] Retention prune failed:', e.message); }
    };
    const first = setTimeout(() => { tick(); }, firstDelayMs);
    if (first.unref) first.unref();
    pruneTimer = setInterval(tick, DAY_MS);
    if (pruneTimer.unref) pruneTimer.unref();
    return true;
}

module.exports = {
    TABLES, TABLE_NAMES, MARKER_KEY, META_TABLE,
    getHandle, ensureTables, migrate, migrateAll, readMarker,
    append,
    listSchedulerLogs, listSchedulerLogsLite,
    listCmdbHistory,
    listDnsChanges,
    saveExecution, getExecution, listExecutions,
    appendWorkflowHistory, listWorkflowHistory, deleteWorkflowHistory,
    retentionDays, prune, scheduleDailyPrune,
    zonedToIso,
    _testHooks: testHooks,
    /** Tests: forget the per-handle migration cache (the next access re-checks the marker row). */
    _resetCache(handle) { if (handle) migratedByHandle.delete(handle); else { for (const h of [testHooks.handle].filter(Boolean)) migratedByHandle.delete(h); } },
};
