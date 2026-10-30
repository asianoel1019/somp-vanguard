/**
 * Table planning / copying for the scout.sqlite maintenance scripts (scoutDb_maintenance.js vacuum rebuild,
 * migrate_all_sqlite_to_db.js). The table list is read from the SOURCE schema (sqlite_master), so a table added
 * by a newer version (maintenance_windows, notify_*, inventory_*, provision_*, rule_exclusions, ...) is never
 * silently dropped. Only the explicitly listed large telemetry tables are copied partially (recent rows).
 *
 * Works with node:sqlite DatabaseSync and better-sqlite3 (uses exec('BEGIN')/COMMIT, prepare/iterate/run only).
 */

/** The large log/metric tables the vacuum rebuild was designed to trim: only recent rows are kept. */
const TELEMETRY_TABLES = Object.freeze([
    { name: 'metrics', tsCol: 'timestamp' },
    { name: 'windows_events', tsCol: 'timestamp' },
    { name: 'linux_logs', tsCol: 'timestamp' },
]);

/** migrate_all_sqlite_to_db.js step 2 does not copy these: document_store is migrated from database.sqlite in step 1. */
const MIGRATE_SKIP_TABLES = Object.freeze(['document_store']);

const qi = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** User tables of the source database (sqlite internals excluded), in creation order. */
function listTables(db) {
    return db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()
        .map(r => ({ name: r.name, sql: r.sql }));
}

/**
 * → { full: [{name, sql}], partial: [{name, sql, tsCol}], skipped: [name] }
 * partial: tables copied recent-rows-only; skip: tables not copied at all by this caller (handled elsewhere).
 */
function planTables(db, { partial = TELEMETRY_TABLES, skip = [] } = {}) {
    const partialByName = new Map(partial.map(p => [p.name, p]));
    const skipSet = new Set(skip);
    const plan = { full: [], partial: [], skipped: [] };
    for (const t of listTables(db)) {
        if (skipSet.has(t.name)) plan.skipped.push(t.name);
        else if (partialByName.has(t.name)) plan.partial.push({ ...t, tsCol: partialByName.get(t.name).tsCol });
        else plan.full.push(t);
    }
    return plan;
}

/** Index / trigger / view DDL attached to the given tables (auto-indexes have no sql and are recreated by the table DDL). */
function listSchemaObjects(db, tableNames) {
    const wanted = new Set(tableNames);
    return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL ORDER BY rowid").all()
        .filter(o => o.type === 'view' || wanted.has(o.tbl_name));
}

/** Streams rows from src into dst (same column names) in batched transactions. Returns the row count. */
function copyRows(srcDb, dstDb, table, { where = '', params = [], limit = null, batchSize = 5000 } = {}) {
    const sql = `SELECT * FROM ${qi(table)}${where ? ` WHERE ${where}` : ''}${limit ? ` LIMIT ${Number(limit)}` : ''}`;
    let insert = null;
    let n = 0;
    let inTx = false;
    const begin = () => { dstDb.exec('BEGIN'); inTx = true; };
    const commit = () => { if (inTx) { dstDb.exec('COMMIT'); inTx = false; } };
    try {
        for (const row of srcDb.prepare(sql).iterate(...params)) {
            if (!insert) {
                const keys = Object.keys(row);
                insert = dstDb.prepare(`INSERT OR REPLACE INTO ${qi(table)} (${keys.map(qi).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`);
            }
            if (!inTx) begin();
            insert.run(...Object.values(row));
            n++;
            if (n % batchSize === 0) commit();
        }
        commit();
    } catch (e) {
        if (inTx) { try { dstDb.exec('ROLLBACK'); } catch (e2) { /* ignore */ } }
        throw e;
    }
    return n;
}

/**
 * Rebuilds src into an empty dst: every table (schema from source) with all rows, except telemetry tables
 * which keep only rows with tsCol >= retentionCutoff (at most logLimit rows each); then indexes/triggers/views.
 * → { copied: [{name, rows}], partial: [{name, rows}], failed: [{name, error}], schemaObjects: { created, failed } }
 */
function rebuildInto(srcDb, dstDb, { retentionCutoff, logLimit = 50000, partial = TELEMETRY_TABLES, log = () => {} } = {}) {
    const plan = planTables(srcDb, { partial });
    const summary = { copied: [], partial: [], failed: [], schemaObjects: { created: 0, failed: [] } };
    const created = [];
    for (const t of plan.full) {
        try {
            dstDb.exec(t.sql);
            created.push(t.name);
            const rows = copyRows(srcDb, dstDb, t.name);
            summary.copied.push({ name: t.name, rows });
            log(`   - ${t.name.padEnd(28)}: copied ${rows.toLocaleString()} rows [OK]`);
        } catch (e) {
            summary.failed.push({ name: t.name, error: e.message });
            log(`   - ${t.name.padEnd(28)}: FAILED: ${e.message}`);
        }
    }
    for (const t of plan.partial) {
        try {
            dstDb.exec(t.sql);
            created.push(t.name);
            const rows = copyRows(srcDb, dstDb, t.name, { where: `${qi(t.tsCol)} >= ?`, params: [retentionCutoff], limit: logLimit });
            summary.partial.push({ name: t.name, rows });
            log(`   - ${t.name.padEnd(28)}: kept ${rows.toLocaleString()} recent rows (>= ${String(retentionCutoff).slice(0, 10)}, max ${logLimit.toLocaleString()}) [OK]`);
        } catch (e) {
            summary.failed.push({ name: t.name, error: e.message });
            log(`   - ${t.name.padEnd(28)}: FAILED: ${e.message}`);
        }
    }
    for (const o of listSchemaObjects(srcDb, created)) {
        try { dstDb.exec(o.sql); summary.schemaObjects.created++; } catch (e) { summary.schemaObjects.failed.push({ name: o.name, error: e.message }); }
    }
    return summary;
}

module.exports = { TELEMETRY_TABLES, MIGRATE_SKIP_TABLES, listTables, planTables, listSchemaObjects, copyRows, rebuildInto };
