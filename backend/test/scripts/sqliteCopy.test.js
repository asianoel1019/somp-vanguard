require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const copy = require('../../scripts/lib/sqliteCopy');

function seedSource(file) {
    const db = new DatabaseSync(file);
    db.exec(`
        CREATE TABLE monitors (id TEXT PRIMARY KEY, name TEXT, tags TEXT);
        CREATE TABLE maintenance_windows (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE notify_state (stateKey TEXT PRIMARY KEY, transitions TEXT);
        CREATE TABLE notify_digest (id INTEGER PRIMARY KEY AUTOINCREMENT, createdAt TEXT, line TEXT);
        CREATE TABLE inventory_hosts (ip TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE rule_exclusions (id TEXT PRIMARY KEY, ruleId TEXT, scopeType TEXT, scopeValue TEXT);
        CREATE TABLE brand_new_future_table ("weird ""col""" TEXT, n INTEGER);
        CREATE TABLE metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, monitorId TEXT, timestamp TEXT, metrics TEXT);
        CREATE TABLE windows_events (id TEXT PRIMARY KEY, host TEXT, timestamp TEXT);
        CREATE TABLE linux_logs (id TEXT PRIMARY KEY, host TEXT, timestamp TEXT);
        CREATE INDEX idx_metrics_mon ON metrics(monitorId);
        CREATE UNIQUE INDEX idx_rule_exclusions_unique ON rule_exclusions(ruleId, scopeType, scopeValue);
        CREATE INDEX idx_future ON brand_new_future_table(n);
    `);
    db.prepare("INSERT INTO monitors VALUES ('m1','A','[]'),('m2','B','[\"x\"]')").run();
    db.prepare("INSERT INTO maintenance_windows VALUES ('w1','patch')").run();
    db.prepare("INSERT INTO notify_state VALUES ('m1|r1','[]')").run();
    db.prepare("INSERT INTO notify_digest (createdAt, line) VALUES ('t','l1'),('t','l2')").run();
    db.prepare("INSERT INTO inventory_hosts VALUES ('10.0.0.1','{}')").run();
    db.prepare("INSERT INTO rule_exclusions VALUES ('x1','r1','monitor','m1')").run();
    db.prepare('INSERT INTO brand_new_future_table VALUES (?, ?)').run('v', 7);
    for (let i = 0; i < 12; i++) db.prepare('INSERT INTO metrics (monitorId, timestamp, metrics) VALUES (?,?,?)').run('m1', i < 4 ? '2020-01-01T00:00:00Z' : '2026-10-27T00:00:00Z', '{}');
    db.prepare("INSERT INTO windows_events VALUES ('e1','A','2020-01-01T00:00:00Z'),('e2','A','2026-10-27T00:00:00Z')").run();
    db.close();
}

test('planTables: every source table is copied fully except the telemetry tables (partial) and the caller skip list', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-copy-'));
    try {
        seedSource(path.join(tmp, 'src.sqlite'));
        const src = new DatabaseSync(path.join(tmp, 'src.sqlite'), { readOnly: true });
        const plan = copy.planTables(src);
        assert.deepEqual(plan.full.map(t => t.name), ['monitors', 'maintenance_windows', 'notify_state', 'notify_digest', 'inventory_hosts', 'rule_exclusions', 'brand_new_future_table']);
        assert.deepEqual(plan.partial.map(t => t.name), ['metrics', 'windows_events', 'linux_logs']);
        assert.deepEqual(plan.skipped, []);
        assert.ok(!plan.full.some(t => t.name.startsWith('sqlite_')), 'sqlite_sequence is internal');
        const withSkip = copy.planTables(src, { skip: ['monitors'] });
        assert.deepEqual(withSkip.skipped, ['monitors']);
        src.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('rebuildInto copies all non-telemetry rows, recent telemetry only, and the indexes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-copy-'));
    try {
        seedSource(path.join(tmp, 'src.sqlite'));
        const src = new DatabaseSync(path.join(tmp, 'src.sqlite'), { readOnly: true });
        const dst = new DatabaseSync(path.join(tmp, 'dst.sqlite'));
        const s = copy.rebuildInto(src, dst, { retentionCutoff: '2026-01-01T00:00:00Z', logLimit: 5 });
        assert.deepEqual(s.failed, []);
        const count = (t) => dst.prepare(`SELECT count(*) AS c FROM "${t}"`).get().c;
        assert.equal(count('monitors'), 2);
        assert.equal(count('maintenance_windows'), 1);
        assert.equal(count('notify_state'), 1);
        assert.equal(count('notify_digest'), 2);
        assert.equal(count('inventory_hosts'), 1);
        assert.equal(count('rule_exclusions'), 1);
        assert.equal(dst.prepare('SELECT n FROM brand_new_future_table').get().n, 7);
        assert.equal(count('metrics'), 5, 'recent rows only, capped at logLimit');
        assert.equal(count('windows_events'), 1);
        assert.equal(count('linux_logs'), 0);
        const idx = dst.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all().map(r => r.name);
        assert.deepEqual(idx, ['idx_future', 'idx_metrics_mon', 'idx_rule_exclusions_unique']);
        assert.equal(s.schemaObjects.created, 3);
        assert.deepEqual(s.copied.find(c => c.name === 'notify_digest'), { name: 'notify_digest', rows: 2 });
        src.close(); dst.close();
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('copyRows streams in batches across transactions', () => {
    const src = new DatabaseSync(':memory:');
    const dst = new DatabaseSync(':memory:');
    src.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    dst.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < 23; i++) src.prepare('INSERT INTO t (v) VALUES (?)').run(`v${i}`);
    assert.equal(copy.copyRows(src, dst, 't', { batchSize: 5 }), 23);
    assert.equal(dst.prepare('SELECT count(*) c FROM t').get().c, 23);
    assert.throws(() => copy.copyRows(src, dst, 'missing_in_source'), /no such table/);
});

test('both maintenance scripts build their table list from the source schema (no hard-coded allow-list)', () => {
    for (const f of ['scoutDb_maintenance.js', 'migrate_all_sqlite_to_db.js']) {
        const src = fs.readFileSync(path.join(__dirname, '../../scripts', f), 'utf8');
        assert.match(src, /require\('\.\/lib\/sqliteCopy'\)/, f);
        assert.doesNotMatch(src, /'monitors', 'api_keys', 'rules'/, `${f} has no fixed table list`);
        assert.match(src, /require\.main === module/, `${f} only runs when executed directly`);
    }
    assert.deepEqual([...copy.MIGRATE_SKIP_TABLES], ['document_store']);
    assert.deepEqual(copy.TELEMETRY_TABLES.map(t => t.name), ['metrics', 'windows_events', 'linux_logs']);
});
