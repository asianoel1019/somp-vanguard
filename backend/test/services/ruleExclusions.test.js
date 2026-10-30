require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const ex = require('../../services/ruleExclusions');

test.before(async () => {
    await dbManager.initDB();
    dbManager.run("INSERT INTO monitors (id, name, ip, tags, enabled) VALUES ('xm1','EX-01','10.7.0.1','[\"web\"]',1),('xm2','EX-02','10.7.0.2','[\"web\",\"legacy\"]',1),('xm3','EX-03','10.7.0.3','[]',1)");
    dbManager.run("INSERT INTO rules (id, name, type, threshold, alertHits, actions, category) VALUES ('xr1','CPU env','cpu',90,1,'[]','metric'),('xr2','Other','cpu',90,1,'[]','metric')");
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => {
    for (const t of ['rule_exclusions', 'alerts', 'alert_state', 'notify_state']) dbManager.run(`DELETE FROM ${t}`);
});

const columns = (table) => dbManager.all(`PRAGMA table_info(${table})`).map(c => c.name);
const indexes = (table) => dbManager.all(`PRAGMA index_list(${table})`).map(i => i.name);

test('schema: rule_exclusions table + indexes + alerts.resolvedReason; initDB idempotent', async () => {
    assert.deepEqual(columns('rule_exclusions'), ['id', 'ruleId', 'scopeType', 'scopeValue', 'reason', 'createdBy', 'createdAt']);
    assert.ok(indexes('rule_exclusions').includes('idx_rule_exclusions_rule'));
    assert.ok(indexes('rule_exclusions').includes('idx_rule_exclusions_scope'));
    assert.ok(columns('alerts').includes('resolvedReason'));
    await dbManager.closeDB(); await dbManager.initDB();   // really re-runs the migrations
    assert.ok(columns('rule_exclusions').includes('reason'));
});

test('validate: rule must exist, monitor must exist, tag non-empty and <= 64, scope monitor|tag, reason <= 500', () => {
    assert.match(ex.validate({ ruleId: 'nope', scopeType: 'monitor', scopeValue: 'xm1' }).error, /rule/i);
    assert.match(ex.validate({ ruleId: 'xr1', scopeType: 'env', scopeValue: 'prod' }).error, /scopeType/);
    assert.match(ex.validate({ ruleId: 'xr1', scopeType: 'monitor', scopeValue: 'ghost' }).error, /monitor/i);
    assert.match(ex.validate({ ruleId: 'xr1', scopeType: 'tag', scopeValue: '   ' }).error, /tag/i);
    assert.match(ex.validate({ ruleId: 'xr1', scopeType: 'tag', scopeValue: 'x'.repeat(65) }).error, /64/);
    assert.match(ex.validate({ ruleId: 'xr1', scopeType: 'tag', scopeValue: 'web', reason: 'r'.repeat(501) }).error, /500/);
    const ok = ex.validate({ ruleId: 'xr1', scopeType: 'tag', scopeValue: ' web ', reason: ' patching ' });
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.value, { ruleId: 'xr1', scopeType: 'tag', scopeValue: 'web', reason: 'patching' });
});

test('add stores the row, rejects duplicates, list filters by rule', () => {
    const a = ex.add({ ruleId: 'xr1', scopeType: 'monitor', scopeValue: 'xm1', reason: 'decom' }, 'alice');
    assert.equal(a.duplicate, undefined);
    assert.equal(a.exclusion.createdBy, 'alice');
    assert.ok(a.exclusion.createdAt);
    assert.equal(ex.add({ ruleId: 'xr1', scopeType: 'monitor', scopeValue: 'xm1' }, 'bob').duplicate, true);
    ex.add({ ruleId: 'xr2', scopeType: 'tag', scopeValue: 'web' }, 'bob');
    assert.equal(ex.list().length, 2);
    assert.deepEqual(ex.list('xr1').map(r => r.scopeValue), ['xm1']);
});

test('affectedMonitorIds: monitor scope → that id; tag scope → every monitor carrying the tag', () => {
    assert.deepEqual(ex.affectedMonitorIds({ scopeType: 'monitor', scopeValue: 'xm1' }), ['xm1']);
    assert.deepEqual(ex.affectedMonitorIds({ scopeType: 'tag', scopeValue: 'web' }).sort(), ['xm1', 'xm2']);
    assert.deepEqual(ex.affectedMonitorIds({ scopeType: 'tag', scopeValue: 'legacy' }), ['xm2']);
});

test('add resolves open alerts of that rule on the excluded monitors silently and clears their state keys', () => {
    const ins = (id, m, r, resolved = 0) => dbManager.run('INSERT INTO alerts (id, monitorId, checkId, ruleName, type, resolved, triggeredAt) VALUES (?,?,?,?,?,?,?)', [id, m, r, r, 'cpu', resolved, new Date().toISOString()]);
    ins('a1', 'xm1', 'xr1'); ins('a2', 'xm2', 'xr1'); ins('a3', 'xm3', 'xr1'); ins('a4', 'xm1', 'xr2');
    for (const k of ['xm1-xr1', 'log-xm1-xr1', 'xm2-xr1', 'xm3-xr1', 'xm1-xr2']) dbManager.run("INSERT INTO alert_state (stateKey, hitCount, status) VALUES (?, 2, 'alerting')", [k]);
    for (const k of ['xm1|xr1', 'xm3|xr1']) dbManager.run('INSERT INTO notify_state (stateKey, transitions) VALUES (?, ?)', [k, '[]']);
    const r = ex.add({ ruleId: 'xr1', scopeType: 'tag', scopeValue: 'web' }, 'alice');
    assert.equal(r.resolvedAlerts, 2);
    const row = (id) => dbManager.get('SELECT resolved, resolvedReason, resolvedAt FROM alerts WHERE id = ?', [id]);
    assert.equal(row('a1').resolved, 1); assert.equal(row('a1').resolvedReason, 'excluded'); assert.ok(row('a1').resolvedAt);
    assert.equal(row('a2').resolvedReason, 'excluded');
    assert.equal(row('a3').resolved, 0, 'monitor without the tag untouched');
    assert.equal(row('a4').resolved, 0, 'other rule untouched');
    const keys = dbManager.all('SELECT stateKey FROM alert_state ORDER BY stateKey').map(x => x.stateKey);
    assert.deepEqual(keys, ['xm1-xr2', 'xm3-xr1']);
    assert.deepEqual(dbManager.all('SELECT stateKey FROM notify_state').map(x => x.stateKey), ['xm3|xr1']);
});

test('remove deletes one row and returns it; removeForRule / removeForMonitors clean up', () => {
    const a = ex.add({ ruleId: 'xr1', scopeType: 'monitor', scopeValue: 'xm1' }, 'u').exclusion;
    ex.add({ ruleId: 'xr1', scopeType: 'tag', scopeValue: 'web' }, 'u');
    ex.add({ ruleId: 'xr2', scopeType: 'monitor', scopeValue: 'xm1' }, 'u');
    ex.add({ ruleId: 'xr2', scopeType: 'monitor', scopeValue: 'xm2' }, 'u');
    assert.equal(ex.remove('missing'), null);
    assert.equal(ex.remove(a.id).id, a.id);
    assert.equal(ex.list().length, 3);
    assert.equal(ex.removeForMonitors(['xm1']), 1);
    assert.deepEqual(ex.list().map(r => `${r.ruleId}:${r.scopeValue}`).sort(), ['xr1:web', 'xr2:xm2']);
    assert.equal(ex.removeForRule('xr1'), 1);
    assert.deepEqual(ex.list().map(r => r.ruleId), ['xr2']);
});

test('ruleScope.loadExclusions tolerates a missing table (returns []) and reads rows otherwise', () => {
    const { loadExclusions } = require('../../services/ruleScope');
    assert.deepEqual(loadExclusions({ all: () => { throw new Error('no such table: rule_exclusions'); } }), []);
    assert.deepEqual(loadExclusions({ all: () => null }), []);
    ex.add({ ruleId: 'xr1', scopeType: 'monitor', scopeValue: 'xm1' }, 'u');
    assert.equal(loadExclusions({ all: dbManager.all }).length, 1);
});

test('I1: resolveForMonitor closes open alerts of rules now excluded for the monitor (tag added later), others untouched', () => {
    ex.add({ ruleId: 'xr1', scopeType: 'tag', scopeValue: 'batch' }, 'u');
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, ruleName, type, resolved, triggeredAt) VALUES ('t1','xm3','xr1','x','cpu',0,?),('t2','xm3','xr2','x','cpu',0,?)", [new Date().toISOString(), new Date().toISOString()]);
    dbManager.run("INSERT INTO alert_state (stateKey, hitCount, status) VALUES ('xm3-xr1', 1, 'alerting')");
    assert.deepEqual(ex.resolveForMonitor({ id: 'xm3', tags: '[]' }), []);
    assert.equal(dbManager.get("SELECT resolved FROM alerts WHERE id = 't1'").resolved, 0);
    const r = ex.resolveForMonitor({ id: 'xm3', tags: '["batch"]' });
    assert.deepEqual(r, [{ ruleId: 'xr1', resolved: 1 }]);
    assert.equal(dbManager.get("SELECT resolvedReason FROM alerts WHERE id = 't1'").resolvedReason, 'excluded');
    assert.equal(dbManager.get("SELECT resolved FROM alerts WHERE id = 't2'").resolved, 0);
    assert.equal(dbManager.get("SELECT count(*) c FROM alert_state WHERE stateKey = 'xm3-xr1'").c, 0);
});

test('I1: reconcileOpenAlerts closes every open alert whose (rule, monitor) is excluded; cheap no-op without exclusions', () => {
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, ruleName, type, resolved, triggeredAt) VALUES ('o1','xm2','xr1','x','cpu',0,?),('o2','xm3','xr1','x','cpu',0,?)", [new Date().toISOString(), new Date().toISOString()]);
    assert.equal(ex.reconcileOpenAlerts(), 0, 'no exclusions → nothing');
    // exclusion row written without add() (e.g. another process, or tag added later): reconcile closes it
    dbManager.run("INSERT INTO rule_exclusions (id, ruleId, scopeType, scopeValue, createdAt) VALUES ('rx','xr1','tag','legacy',?)", [new Date().toISOString()]);
    assert.equal(ex.reconcileOpenAlerts(), 1);
    assert.equal(dbManager.get("SELECT resolvedReason FROM alerts WHERE id = 'o1'").resolvedReason, 'excluded');
    assert.equal(dbManager.get("SELECT resolved FROM alerts WHERE id = 'o2'").resolved, 0);
    assert.equal(ex.reconcileOpenAlerts(), 0, 'idempotent');
});

test('M3: unique index on (ruleId, scopeType, scopeValue); a racing duplicate insert is reported as duplicate', () => {
    assert.ok(dbManager.all('PRAGMA index_list(rule_exclusions)').some(i => i.name === 'idx_rule_exclusions_unique' && i.unique === 1));
    ex.add({ ruleId: 'xr1', scopeType: 'monitor', scopeValue: 'xm1' }, 'u');
    // simulate the race: the pre-check passes (row not visible), the INSERT hits the constraint
    const realGet = require('../../services/scoutDb').get;
    const scoutDb = require('../../services/scoutDb');
    scoutDb.get = (sql, p) => (/FROM rule_exclusions WHERE ruleId/.test(sql) ? undefined : realGet(sql, p));
    try {
        assert.equal(ex.add({ ruleId: 'xr1', scopeType: 'monitor', scopeValue: 'xm1' }, 'u').duplicate, true);
    } finally { scoutDb.get = realGet; }
    assert.equal(dbManager.get('SELECT count(*) c FROM rule_exclusions').c, 1);
});

test('M3: initDB dedupes existing duplicate rows before creating the unique index (idempotent)', async () => {
    dbManager.run('DROP INDEX IF EXISTS idx_rule_exclusions_unique');
    dbManager.run("INSERT INTO rule_exclusions (id, ruleId, scopeType, scopeValue, createdAt) VALUES ('d1','xr1','tag','dup','2026-01-01'),('d2','xr1','tag','dup','2026-01-02'),('d3','xr2','tag','dup','2026-01-02')");
    await dbManager.closeDB(); await dbManager.initDB();
    assert.deepEqual(dbManager.all("SELECT id FROM rule_exclusions WHERE scopeValue = 'dup' ORDER BY id").map(r => r.id), ['d1', 'd3']);
    assert.ok(dbManager.all('PRAGMA index_list(rule_exclusions)').some(i => i.name === 'idx_rule_exclusions_unique'));
    await dbManager.closeDB(); await dbManager.initDB();
    assert.equal(dbManager.get("SELECT count(*) c FROM rule_exclusions WHERE scopeValue = 'dup'").c, 2);
});
