// scout.sqlite maintenance: duplicate index detection, the report changes nothing, drop + VACUUM on a throwaway
// database, and no change while another process holds the database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { findDuplicateIndexes, keyOf, vacuumSpaceNeeded } = require('../../scripts/lib/indexAnalysis');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'scoutDbOptimize.js');
const col = (name, desc = false) => ({ name, desc });
const ix = (name, table, columns, extra = {}) => ({ name, table, columns, unique: false, origin: 'c', ...extra });

test('duplicates: same key (a trailing rowid / INTEGER PRIMARY KEY ignored, a fully reversed index is the same)', () => {
    const alias = { metrics: 'id' };
    assert.equal(keyOf(ix('a', 'metrics', [col('monitorId'), col('id', true)]), alias), keyOf(ix('b', 'metrics', [col('monitorId')]), alias));
    assert.equal(keyOf(ix('a', 'windows_events', [col('timestamp', true)])), keyOf(ix('b', 'windows_events', [col('timestamp')])));
    assert.notEqual(keyOf(ix('a', 'metrics', [col('monitorId'), col('timestamp', true)])), keyOf(ix('b', 'metrics', [col('monitorId'), col('timestamp')])));
    assert.equal(keyOf(ix('e', 't', [col(null)])), null, 'expression indexes are left alone');

    const dups = findDuplicateIndexes([
        ix('idx_metrics_monitorId', 'metrics', [col('monitorId')]),
        ix('idx_metrics_monId', 'metrics', [col('monitorId')]),
        ix('idx_metrics_monitor_id_desc', 'metrics', [col('monitorId'), col('id', true)]),
        ix('idx_metrics_monitor_ts', 'metrics', [col('monitorId'), col('timestamp', true)]),
        ix('idx_metrics_timestamp', 'metrics', [col('timestamp')]),
        ix('idx_metrics_ts', 'metrics', [col('timestamp')]),
        ix('idx_windows_events_timestamp', 'windows_events', [col('timestamp')]),
        ix('idx_win_events_ts', 'windows_events', [col('timestamp', true)]),
        ix('sqlite_autoindex_x_1', 'x', [col('id')], { unique: true, origin: 'pk' }),
        ix('idx_x_id', 'x', [col('id')]),
    ], alias);
    assert.deepEqual(dups.map(d => [d.table, d.keep, d.drop]), [
        ['metrics', 'idx_metrics_monId', ['idx_metrics_monitor_id_desc', 'idx_metrics_monitorId']],
        ['metrics', 'idx_metrics_ts', ['idx_metrics_timestamp']],
        ['windows_events', 'idx_win_events_ts', ['idx_windows_events_timestamp']],
        ['x', 'sqlite_autoindex_x_1', ['idx_x_id']],
    ]);
    assert.equal(vacuumSpaceNeeded({ pageSize: 4096, pageCount: 1000, freePages: 400 }), Math.ceil(600 * 4096 * 1.1));
});

function makeDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoutdb-opt-'));
    const file = path.join(dir, 'scout.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA journal_mode = WAL;
        CREATE TABLE metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, monitorId TEXT, timestamp TEXT, metrics TEXT);
        CREATE TABLE windows_events (id TEXT PRIMARY KEY, host TEXT, message TEXT, timestamp TEXT);
        CREATE INDEX idx_metrics_monId ON metrics(monitorId);
        CREATE INDEX idx_metrics_monitorId ON metrics(monitorId);
        CREATE INDEX idx_metrics_monitor_id_desc ON metrics(monitorId, id DESC);
        CREATE INDEX idx_metrics_monitor_ts ON metrics(monitorId, timestamp DESC);
        CREATE INDEX idx_win_events_ts ON windows_events(timestamp DESC);
        CREATE INDEX idx_windows_events_timestamp ON windows_events(timestamp);`);
    const ins = db.prepare('INSERT INTO metrics (monitorId, timestamp, metrics) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    for (let i = 0; i < 4000; i++) ins.run(`m${i % 20}`, new Date(2026, 0, 1, 0, i).toISOString(), 'x'.repeat(400));
    db.exec('COMMIT');
    db.exec('DELETE FROM metrics WHERE id <= 3000; PRAGMA wal_checkpoint(TRUNCATE);');
    db.close();
    return { dir, file };
}
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });
const indexNames = (file) => { const db = new DatabaseSync(file, { readOnly: true }); const n = db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all().map(r => r.name); db.close(); return n; };

test('the report changes nothing; --drop-duplicates --vacuum drops the copies and shrinks the file', (t) => {
    const { dir, file } = makeDb();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const before = indexNames(file);
    const sizeBefore = fs.statSync(file).size;

    const report = run('--db', file);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /metrics: \(monitorid\) keep idx_metrics_monId, drop idx_metrics_monitor_id_desc, idx_metrics_monitorId/);
    assert.match(report.stdout, /windows_events: \(timestamp\) keep idx_win_events_ts, drop idx_windows_events_timestamp/);
    assert.match(report.stdout, /Report only: nothing was changed/);
    assert.deepEqual(indexNames(file), before);

    const fix = run('--db', file, '--drop-duplicates', '--vacuum', '--yes');
    assert.equal(fix.status, 0, fix.stderr);
    assert.deepEqual(indexNames(file), ['idx_metrics_monId', 'idx_metrics_monitor_ts', 'idx_win_events_ts', 'sqlite_autoindex_windows_events_1']);
    assert.ok(fs.statSync(file).size < sizeBefore / 2, `shrunk from ${sizeBefore} to ${fs.statSync(file).size}`);
    const db = new DatabaseSync(file, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 1000, 'data kept');
    db.close();
});

test('no change while another process holds the database', (t) => {
    const { dir, file } = makeDb();
    const holder = new DatabaseSync(file);
    t.after(() => { try { holder.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); });
    holder.exec('BEGIN IMMEDIATE');
    const r = run('--db', file, '--drop-duplicates', '--yes');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Another process is using the database/);
    holder.exec('ROLLBACK');
    holder.close();
    assert.ok(indexNames(file).includes('idx_metrics_monitorId'), 'nothing dropped');
});
