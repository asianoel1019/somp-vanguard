require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { db: libDb, readDataSync, writeDataSync } = require('../../lib/db');
const cmdb = require('../../services/cmdbModel');
const serverDeletion = require('../../services/serverDeletion');
const { getTargetsSafely, saveTargetsSafely } = require('../../lib/prometheusTargetHelper');

const META_KEY = 'server_operation/server_cmdb_meta.json';
const HISTORY_KEY = 'server_operation/server_cmdb_history.json';

const tok = (role, username = role.toLowerCase()) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['sl'] })}`;
const admin = tok('SuperAdmin'), op = tok('Operator'), viewer = tok('Viewer');
let app, serverListRouter;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: { sl: { enabled: true, features: { serverList: true } } } });
    serverListRouter = require('../../routes/serverList');
    app = express();
    app.use(express.json());
    app.use('/api/server-list', serverListRouter);
});
test.after(async () => { await dbManager.closeDB(); });

const run = (sql, params = []) => dbManager.run(sql, params);
const get = (sql, params = []) => dbManager.get(sql, params);
const count = (table, where = '1=1', params = []) => get(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, params).c;
const cmdbRow = (ip) => libDb.prepare('SELECT ip, hostname FROM cmdb_servers WHERE ip = ?').get(ip);
const meta = () => readDataSync(META_KEY, {});
const history = () => readDataSync(HISTORY_KEY, []);
const bearer = (t) => ({ Authorization: t });

function promTarget(ip, host) {
    return { targets: [`${ip}:9100`], labels: { addr: ip, host, application: 'X', group: 'G', zone: 'Z' } };
}

// Two servers (10.1.1.1 with a linked VIP 10.1.1.9, 10.1.1.2) plus a bystander 10.1.1.3, all with Scout data
async function seed() {
    for (const t of ['monitors', 'metrics', 'alerts', 'alert_state', 'notify_state', 'rule_bindings', 'rule_exclusions', 'rules', 'maintenance_windows',
        'windows_events', 'linux_logs', 'remediation_logs', 'forensic_tasks', 'forensic_reports']) run(`DELETE FROM ${t}`);
    libDb.prepare('DELETE FROM cmdb_servers').run();
    writeDataSync(HISTORY_KEY, []);
    writeDataSync('prometheus_targets.json', []);

    cmdb.upsertCmdbServer({ ip: '10.1.1.1', hostname: 'H1', applicationName: 'App1' }, 'MANUAL');
    cmdb.upsertCmdbServer({ ip: '10.1.1.2', hostname: 'H2' }, 'MANUAL');
    cmdb.upsertCmdbServer({ ip: '10.1.1.3', hostname: 'H3' }, 'MANUAL');
    cmdb.upsertCmdbServer({ ip: '10.1.1.9', hostname: 'VIP9', linkedToIp: '10.1.1.1' }, 'SCANNER');
    writeDataSync(META_KEY, {
        '10.1.1.1': { hostname: 'H1', applicationName: 'App1', secondaryIps: ['10.1.1.9'], notes: 'keep me' },
        '10.1.1.2': { hostname: 'H2' },
        '10.1.1.3': { hostname: 'H3' },
        '10.1.1.9': { deleted: true, isVip: true, linkedTo: '10.1.1.1' }
    });

    run("INSERT INTO monitors (id, name, ip, tags, enabled) VALUES ('m1','H1','10.1.1.1','[]',1),('m2','H2','10.1.1.2','[]',1),('m3','H3','10.1.1.3','[]',1)");
    for (let i = 0; i < 7; i++) run("INSERT INTO metrics (monitorId, timestamp, metrics) VALUES ('m1', ?, '{}')", [`2026-01-01T00:00:0${i}Z`]);
    run("INSERT INTO metrics (monitorId, timestamp, metrics) VALUES ('m2', '2026-01-01T00:00:00Z', '{}'),('m3', '2026-01-01T00:00:00Z', '{}')");
    run("INSERT INTO alerts (id, monitorId, checkId, resolved) VALUES ('a1','m1','r1',0),('a2','m1','r2',1),('a3','m3','r1',0)");
    run("INSERT INTO alert_state (stateKey, hitCount, status) VALUES ('m1-r1',1,'alerting'),('log-m1-r1',1,'ok'),('m3-r1',1,'ok')");
    run("INSERT INTO notify_state (stateKey, transitions) VALUES ('m1|r1','[]'),('m3|r1','[]')");
    run("INSERT INTO windows_events (id, host, timestamp) VALUES ('e1','H1','t'),('e2','H1','t'),('e3','H3','t')");
    run("INSERT INTO linux_logs (id, host, timestamp) VALUES ('l1','H1','t'),('l2','H3','t')");
    run("INSERT INTO remediation_logs (id, monitorId) VALUES ('rl1','m1'),('rl2','m3')");
    run("INSERT INTO forensic_tasks (id, monitorId) VALUES ('ft1','m1'),('ft2','m3')");
    run("INSERT INTO forensic_reports (id, taskId, monitorId) VALUES ('fr1','ft1','m1'),('fr2','ft2','m3')");

    run("INSERT INTO rules (id, name, type) VALUES ('r1','CPU high','cpu'),('r2','Mem high','memory')");
    run("INSERT INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES ('b1','r1','monitor','m1'),('b2','r2','monitor','m1'),('b3','r1','monitor','m3'),('b4','r1','env','prod')");
    run("INSERT INTO rule_exclusions (id, ruleId, scopeType, scopeValue) VALUES ('x1','r1','monitor','m1'),('x2','r1','monitor','m3'),('x3','r2','tag','legacy')");
    const w = (id, vals) => run("INSERT INTO maintenance_windows (id, name, kind, scopeType, scopeValues, enabled) VALUES (?,?,?,?,?,1)", [id, `W-${id}`, 'once', 'monitors', JSON.stringify(vals)]);
    w('w1', ['m1']); w('w2', ['m1', 'm3']); w('w3', ['m3']);

    await saveTargetsSafely([promTarget('10.1.1.1', 'H1'), promTarget('10.1.1.9', 'VIP9'), promTarget('10.1.1.2', 'H2'), promTarget('10.1.1.3', 'H3')], 'test_seed');
}

const targetIps = () => getTargetsSafely().map(t => t.labels.addr).sort();

test('delete-preview: shape, exact counts, unindexed counts are null, RBAC', async () => {
    await seed();
    await request(app).post('/api/server-list/delete-preview').set(bearer(viewer)).send({ ips: ['10.1.1.1'] }).expect(403);
    await request(app).post('/api/server-list/delete-preview').set(bearer(op)).send({ ips: [] }).expect(400);

    const res = await request(app).post('/api/server-list/delete-preview').set(bearer(op)).send({ ips: ['10.1.1.1', '10.1.1.77'] }).expect(200);
    const [p, missing] = res.body.previews;
    assert.equal(p.ip, '10.1.1.1');
    assert.equal(p.hostname, 'H1');
    assert.equal(p.exists, true);
    assert.deepEqual(p.linkedVips.map(v => v.ip), ['10.1.1.9']);
    assert.equal(p.linkedVips[0].hostname, 'VIP9');
    assert.deepEqual(p.scout.monitors, [{ id: 'm1', name: 'H1' }]);
    assert.equal(p.scout.metricRows, 7);
    // no index with leading monitorId yet (the worker builds idx_alerts_monId in the background): unknown
    assert.equal(p.scout.alertRows, null);
    // no index on windows_events.host / linux_logs.host in the schema: unknown, never a full scan
    assert.equal(p.scout.eventRows, null);
    assert.equal(p.scout.logRows, null);
    assert.deepEqual(p.prometheusTargets.map(t => t.target).sort(), ['10.1.1.1:9100', '10.1.1.9:9100']);
    assert.equal(p.prometheusTargets[0].labels.application, 'X');
    assert.deepEqual(p.ruleBindings.map(b => b.ruleId).sort(), ['r1', 'r2']);
    assert.equal(p.ruleBindings.find(b => b.ruleId === 'r1').ruleName, 'CPU high');
    assert.deepEqual(p.ruleExclusions, [{ ruleId: 'r1', ruleName: 'CPU high' }]);
    assert.deepEqual(p.maintenanceWindows, [{ id: 'w1', name: 'W-w1' }]); // w2 is mixed: untouched
    assert.equal(missing.exists, false);
    assert.equal(missing.scout.metricRows, 0);

    // once a host index exists the counts become exact
    run('CREATE INDEX IF NOT EXISTS idx_test_we_host ON windows_events(host)');
    run('CREATE INDEX IF NOT EXISTS idx_test_ll_host ON linux_logs(host)');
    assert.equal(serverDeletion.ensureAlertsMonitorIndex().created, true);
    assert.equal(serverDeletion.ensureAlertsMonitorIndex().created, false); // idempotent
    const again = await request(app).post('/api/server-list/delete-preview').set(bearer(op)).send({ ips: ['10.1.1.1'] }).expect(200);
    assert.equal(again.body.previews[0].scout.alertRows, 2);
    assert.equal(again.body.previews[0].scout.eventRows, 2);
    assert.equal(again.body.previews[0].scout.logRows, 1);
    run('DROP INDEX idx_test_we_host');
    run('DROP INDEX idx_test_ll_host');
    run('DROP INDEX idx_alerts_monId');
});

test('delete without cleanup removes only the always-deleted items', async () => {
    await seed();
    await request(app).delete('/api/server-list/10.1.1.1').set(bearer(viewer)).expect(403);
    const res = await request(app).delete('/api/server-list/10.1.1.1').set(bearer(op)).expect(200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.cleanup, undefined);
    await serverDeletion.whenCleanupIdle();

    // always deleted: CMDB record, linked VIP row, Scout monitor, history entry
    assert.equal(cmdbRow('10.1.1.1'), undefined);
    assert.equal(cmdbRow('10.1.1.9'), undefined);
    assert.ok(cmdbRow('10.1.1.2'));
    assert.equal(count('monitors', "ip = '10.1.1.1'"), 0);
    assert.equal(meta()['10.1.1.1'].deleted, true);
    assert.equal(meta()['10.1.1.1'].deletedBy, 'operator');
    assert.ok(history().some(h => h.ip === '10.1.1.1' && h.action === 'DELETE'));

    // untouched without opt-in
    assert.deepEqual(targetIps(), ['10.1.1.1', '10.1.1.2', '10.1.1.3', '10.1.1.9']);
    assert.equal(count('metrics', "monitorId = 'm1'"), 7);
    assert.equal(count('alerts', "monitorId = 'm1'"), 2);
    assert.equal(count('alert_state', "stateKey LIKE '%m1%'"), 2);
    assert.equal(count('notify_state', "stateKey LIKE 'm1|%'"), 1);
    assert.equal(count('windows_events', "host = 'H1'"), 2);
    assert.equal(count('remediation_logs', "monitorId = 'm1'"), 1);
    assert.equal(count('rule_bindings'), 4);
    // monitor-scoped exclusions of the deleted host are always removed (meaningless without it); tag exclusions stay
    assert.deepEqual(get("SELECT GROUP_CONCAT(id) AS ids FROM (SELECT id FROM rule_exclusions ORDER BY id)").ids, 'x2,x3');
    assert.equal(count('maintenance_windows'), 3);
});

test('cleanup.prometheus removes only the host and its linked VIP targets', async () => {
    await seed();
    const res = await request(app).delete('/api/server-list/10.1.1.1').set(bearer(op)).send({ cleanup: { prometheus: true } }).expect(200);
    assert.equal(res.body.cleaned.prometheusTargets, 2);
    assert.deepEqual(targetIps(), ['10.1.1.2', '10.1.1.3']);
    assert.equal(count('metrics', "monitorId = 'm1'"), 7);
    assert.equal(count('rule_bindings'), 4);
    assert.equal(count('maintenance_windows'), 3);
});

test('cleanup.ruleBindings removes monitor bindings and exclusive windows only', async () => {
    await seed();
    const res = await request(app).delete('/api/server-list/10.1.1.1').set(bearer(op)).send({ cleanup: { ruleBindings: true } }).expect(200);
    assert.equal(res.body.cleaned.ruleBindings, 2);
    assert.equal(res.body.cleaned.maintenanceWindows, 1);
    assert.deepEqual(get("SELECT GROUP_CONCAT(id) AS ids FROM (SELECT id FROM rule_bindings ORDER BY id)").ids, 'b3,b4');
    assert.equal(res.body.cleaned.ruleExclusions, 1);
    assert.deepEqual(get("SELECT GROUP_CONCAT(id) AS ids FROM (SELECT id FROM rule_exclusions ORDER BY id)").ids, 'x2,x3'); // tag exclusions kept
    assert.deepEqual(get("SELECT GROUP_CONCAT(id) AS ids FROM (SELECT id FROM maintenance_windows ORDER BY id)").ids, 'w2,w3');
    assert.deepEqual(targetIps(), ['10.1.1.1', '10.1.1.2', '10.1.1.3', '10.1.1.9']);
    assert.equal(count('metrics', "monitorId = 'm1'"), 7);
});

test('cleanup.scoutHistory responds first, then deletes only that monitor history in the background', async () => {
    await seed();
    const res = await request(app).post('/api/server-list/bulk-delete').set(bearer(op)).send({ ips: ['10.1.1.1'], cleanup: { scoutHistory: true } }).expect(200);
    assert.equal(res.body.cleanup, 'started');
    assert.equal(res.body.count, 1);
    await serverDeletion.whenCleanupIdle();

    assert.equal(count('metrics', "monitorId = 'm1'"), 0);
    assert.equal(count('metrics'), 2); // m2, m3 intact
    assert.equal(count('alerts', "monitorId = 'm1'"), 0);
    assert.equal(count('alerts'), 1);
    assert.equal(count('alert_state'), 1); // only m3-r1 left (covers `${id}-` and `log-${id}-`)
    assert.equal(count('notify_state'), 1);
    assert.equal(count('remediation_logs'), 1);
    assert.equal(count('forensic_tasks'), 1);
    assert.equal(count('forensic_reports'), 1);
    // no host index on events/logs: skipped rather than full-scanned
    assert.equal(count('windows_events'), 3);
    assert.equal(count('linux_logs'), 2);
    // other cleanup options were not requested
    assert.deepEqual(targetIps(), ['10.1.1.1', '10.1.1.2', '10.1.1.3', '10.1.1.9']);
    assert.equal(count('rule_bindings'), 4);
});

test('history cleanup deletes in batches and covers indexed events/logs', async () => {
    await seed();
    run('CREATE INDEX IF NOT EXISTS idx_test_we_host ON windows_events(host)');
    run('CREATE INDEX IF NOT EXISTS idx_test_ll_host ON linux_logs(host)');
    const totals = await serverDeletion.cleanupScoutHistory([{ id: 'm1', name: 'H1' }], { batchSize: 3 });
    assert.equal(totals.metrics, 7); // 3 + 3 + 1
    assert.equal(totals.alerts, 2);
    assert.equal(totals.alertState, 2);
    assert.equal(totals.notifyState, 1);
    assert.equal(totals.events, 2);
    assert.equal(totals.logs, 1);
    assert.deepEqual(totals.skippedUnindexed, []);
    assert.equal(count('windows_events'), 1);
    assert.equal(count('metrics'), 2);
    run('DROP INDEX idx_test_we_host');
    run('DROP INDEX idx_test_ll_host');
});

test('restore round trip: deleted list, restore, 404s, RBAC', async () => {
    await seed();
    await request(app).delete('/api/server-list/10.1.1.1').set(bearer(op)).expect(200);

    await request(app).get('/api/server-list/deleted').set(bearer(viewer)).expect(200);
    const list = await request(app).get('/api/server-list/deleted').set(bearer(op)).expect(200);
    assert.deepEqual(list.body.servers.map(s => s.ip), ['10.1.1.1']); // linked VIP 10.1.1.9 is not listed
    assert.equal(list.body.servers[0].hostname, 'H1');
    assert.equal(list.body.servers[0].deletedBy, 'operator');
    assert.ok(list.body.servers[0].deletedAt);

    await request(app).post('/api/server-list/10.1.1.1/restore').set(bearer(viewer)).expect(403);
    await request(app).post('/api/server-list/10.1.1.2/restore').set(bearer(op)).expect(404);
    await request(app).post('/api/server-list/10.1.1.9/restore').set(bearer(op)).expect(404);
    await request(app).post('/api/server-list/10.1.1.1/restore').set(bearer(admin)).expect(200);

    assert.ok(cmdbRow('10.1.1.1'));
    assert.equal(cmdbRow('10.1.1.1').hostname, 'H1');
    assert.equal(meta()['10.1.1.1'].deleted, false);
    assert.equal(meta()['10.1.1.1'].notes, 'keep me');
    assert.ok(history().some(h => h.ip === '10.1.1.1' && h.action === 'RESTORE'));
    const after = await request(app).get('/api/server-list/deleted').set(bearer(op)).expect(200);
    assert.deepEqual(after.body.servers, []);
    await request(app).post('/api/server-list/10.1.1.1/restore').set(bearer(op)).expect(404);
});

test('automatic writers do not resurrect a deleted server (sync-all, inventory/scout bulk upsert)', async () => {
    await seed();
    await request(app).delete('/api/server-list/10.1.1.1').set(bearer(op)).expect(200);

    // Global Auto-Sync: a Prometheus target for 10.1.1.3 fills meta.applicationName -> upserts every meta entry
    await saveTargetsSafely([promTarget('10.1.1.3', 'H3')], 'test_seed');
    const m = meta(); m['10.1.1.3'] = {}; writeDataSync(META_KEY, m);
    const sync = await request(app).post('/api/server-list/sync-all').set(bearer(op)).expect(200);
    assert.ok(sync.body.count >= 1);
    assert.equal(cmdbRow('10.1.1.1'), undefined);
    assert.equal(cmdbRow('10.1.1.9'), undefined);

    // Inventory scan / scout sync path: bulk upsert with a deleted IP and a linked VIP of a deleted primary
    const written = cmdb.bulkUpsertCmdbServers([{ ip: '10.1.1.1', hostname: 'H1' }, { ip: '10.1.1.9', linkedTo: '10.1.1.1' }, { ip: '10.1.1.4', hostname: 'H4' }], 'INVENTORY_SCAN');
    assert.equal(written, 1);
    assert.equal(cmdbRow('10.1.1.1'), undefined);
    assert.ok(cmdbRow('10.1.1.4'));
});

test('manual edit and Excel import re-create a deleted server; bulk edit skips it', async () => {
    await seed();
    await request(app).delete('/api/server-list/10.1.1.1').set(bearer(op)).expect(200);
    await request(app).delete('/api/server-list/10.1.1.2').set(bearer(op)).expect(200);

    const bulk = await request(app).post('/api/server-list/bulk-cmdb-meta').set(bearer(op)).send({ ips: ['10.1.1.1', '10.1.1.3'], data: { applicationName: 'Bulk' } }).expect(200);
    assert.equal(bulk.body.count, 1);
    assert.equal(bulk.body.skipped, 1);
    assert.equal(cmdbRow('10.1.1.1'), undefined);
    assert.equal(meta()['10.1.1.1'].deleted, true);

    await request(app).put('/api/server-list/cmdb-meta/10.1.1.1').set(bearer(op)).send({ applicationName: 'Back' }).expect(200);
    assert.ok(cmdbRow('10.1.1.1'));
    assert.equal(meta()['10.1.1.1'].deleted, false);
    assert.ok(meta()['10.1.1.1'].restoredAt);
    assert.ok(history().some(h => h.ip === '10.1.1.1' && h.action === 'RESTORE'));

    serverListRouter.upsertClonedVms([{ IP: '10.1.1.2', Name: 'H2-new', OS: 'linux' }], 'importer');
    assert.ok(cmdbRow('10.1.1.2'));
    assert.equal(meta()['10.1.1.2'].deleted, false);
    assert.ok(history().some(h => h.ip === '10.1.1.2' && h.action === 'RESTORE'));
});

test('cmdbModel: upsert skips deleted IPs unless allowDeleted', async () => {
    await seed();
    writeDataSync(META_KEY, { ...meta(), '10.2.2.2': { deleted: true } });
    assert.equal(cmdb.upsertCmdbServer({ ip: '10.2.2.2', hostname: 'D' }, 'SCANNER'), false);
    assert.equal(cmdbRow('10.2.2.2'), undefined);
    assert.equal(cmdb.upsertCmdbServer({ ip: '10.2.2.2', hostname: 'D' }, 'MANUAL', { allowDeleted: true }), true);
    assert.ok(cmdbRow('10.2.2.2'));
    libDb.prepare("DELETE FROM cmdb_servers WHERE ip = '10.2.2.2'").run();
    assert.equal(cmdb.bulkUpsertCmdbServers([{ ip: '10.2.2.2', hostname: 'D' }], 'SCANNER'), 0);
    assert.equal(cmdb.bulkUpsertCmdbServers([{ ip: '10.2.2.2', hostname: 'D' }], 'SCANNER', { allowDeleted: true }), 1);
    assert.equal(cmdb.isServerDeleted('10.2.2.2'), true);
    assert.equal(cmdb.isServerDeleted('10.1.1.2'), false);
});

test('similar monitor ids never cross-delete (m1 vs m10, log-m1- vs log-m10-)', async () => {
    await seed();
    run("INSERT INTO monitors (id, name, ip, tags, enabled) VALUES ('m10','H10','10.1.1.10','[]',1)");
    run("INSERT INTO metrics (monitorId, timestamp, metrics) VALUES ('m10','t','{}')");
    run("INSERT INTO alerts (id, monitorId, checkId, resolved) VALUES ('a10','m10','r1',0)");
    run("INSERT INTO alert_state (stateKey, hitCount, status) VALUES ('m10-r1',1,'ok'),('log-m10-r1',1,'ok')");
    run("INSERT INTO notify_state (stateKey, transitions) VALUES ('m10|r1','[]')");
    run("INSERT INTO remediation_logs (id, monitorId) VALUES ('rl10','m10')");
    await serverDeletion.cleanupScoutHistory([{ id: 'm1', name: 'H1' }], { batchSize: 2, pauseMs: 0 });
    assert.equal(count('metrics', "monitorId = 'm10'"), 1);
    assert.equal(count('alerts', "monitorId = 'm10'"), 1);
    assert.equal(count('alert_state', "stateKey IN ('m10-r1','log-m10-r1')"), 2);
    assert.equal(count('notify_state', "stateKey = 'm10|r1'"), 1);
    assert.equal(count('remediation_logs', "monitorId = 'm10'"), 1);
    assert.equal(count('metrics', "monitorId = 'm1'"), 0);
});

test('a window shared by two selected hosts is exclusive to the selection (preview + cleanup)', async () => {
    await seed();
    run("INSERT INTO maintenance_windows (id, name, kind, scopeType, scopeValues, enabled) VALUES ('w12','W-12','once','monitors',?,1)", [JSON.stringify(['m1', 'm2'])]);
    const res = await request(app).post('/api/server-list/delete-preview').set(bearer(op)).send({ ips: ['10.1.1.1', '10.1.1.2'] }).expect(200);
    const all = res.body.previews.flatMap(p => p.maintenanceWindows.map(w => w.id)).sort();
    assert.deepEqual(all, ['w1', 'w12']); // listed once; w2 (shared with unselected m3) is not
    const single = await request(app).post('/api/server-list/delete-preview').set(bearer(op)).send({ ips: ['10.1.1.1'] }).expect(200);
    assert.deepEqual(single.body.previews[0].maintenanceWindows.map(w => w.id), ['w1']);

    const del = await request(app).post('/api/server-list/bulk-delete').set(bearer(op)).send({ ips: ['10.1.1.1', '10.1.1.2'], cleanup: { ruleBindings: true } }).expect(200);
    assert.equal(del.body.cleaned.maintenanceWindows, 2);
    assert.equal(get("SELECT GROUP_CONCAT(id) AS ids FROM (SELECT id FROM maintenance_windows ORDER BY id)").ids, 'w2,w3');
});

test('preview counts are capped at 100,001', async () => {
    await seed();
    run("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100100) INSERT INTO metrics (monitorId, timestamp, metrics) SELECT 'm1', 't', '{}' FROM n");
    const res = await request(app).post('/api/server-list/delete-preview').set(bearer(op)).send({ ips: ['10.1.1.1'] }).expect(200);
    assert.equal(res.body.previews[0].scout.metricRows, 100001);
});

test('deleting an IP that is not in Server List creates no meta entry and changes nothing', async () => {
    await seed();
    const res = await request(app).delete('/api/server-list/10.1.1.77').set(bearer(op)).expect(200);
    assert.equal(res.body.deleted, 0);
    assert.equal(meta()['10.1.1.77'], undefined);
    assert.ok(!history().some(h => h.ip === '10.1.1.77'));
    const bulk = await request(app).post('/api/server-list/bulk-delete').set(bearer(op)).send({ ips: ['10.1.1.77', '10.1.1.2'] }).expect(200);
    assert.equal(bulk.body.count, 1);
    assert.deepEqual(bulk.body.skipped, ['10.1.1.77']);
    assert.equal(meta()['10.1.1.77'], undefined);
    const again = await request(app).delete('/api/server-list/10.1.1.2').set(bearer(op)).expect(200);
    assert.equal(again.body.deleted, 0); // already deleted: no-op
});

test('a failed cleanup is surfaced in the response, the delete itself still succeeds', async () => {
    await seed();
    writeDataSync('prometheus_targets.json', 'not-an-array'); // circuit breaker trips in getTargetsSafely
    const res = await request(app).delete('/api/server-list/10.1.1.1').set(bearer(op)).send({ cleanup: { prometheus: true } }).expect(200);
    assert.equal(res.body.success, true);
    assert.match(res.body.cleaned.prometheusError, /Circuit Breaker/);
    assert.equal(cmdbRow('10.1.1.1'), undefined);
});

test('an IP reused by a different host is treated as a new server (same host stays deleted)', async () => {
    await seed();
    await request(app).delete('/api/server-list/10.1.1.1').set(bearer(op)).expect(200);
    assert.equal(cmdb.bulkUpsertCmdbServers([{ ip: '10.1.1.1', hostname: 'h1.corp.local' }], 'INVENTORY_SCAN'), 0); // same short name
    assert.equal(cmdbRow('10.1.1.1'), undefined);
    assert.equal(meta()['10.1.1.1'].deleted, true);
    assert.equal(cmdb.bulkUpsertCmdbServers([{ ip: '10.1.1.1', hostname: 'Unknown' }, { ip: '10.1.1.1' }], 'INVENTORY_SCAN'), 0);
    assert.equal(cmdb.bulkUpsertCmdbServers([{ ip: '10.1.1.1', hostname: 'NEWBOX' }], 'INVENTORY_SCAN'), 1);
    assert.equal(cmdbRow('10.1.1.1').hostname, 'NEWBOX');
    assert.equal(meta()['10.1.1.1'].deleted, false);
    assert.equal(meta()['10.1.1.1'].restoredBy, 'SYSTEM');
    assert.equal(meta()['10.1.1.1'].hostname, 'NEWBOX');
    assert.ok(history().some(h => h.ip === '10.1.1.1' && h.action === 'RESTORE_IP_REUSE'));
});

test('delete records every known name; another source name for the same server never revives it', async () => {
    await seed();
    cmdb.upsertCmdbServer({ ip: '10.1.1.2', hostname: 'web01', vmName: 'PRD-WEB01', fqdn: 'web01.corp.local' }, 'MANUAL');
    await request(app).delete('/api/server-list/10.1.1.2').set(bearer(op)).expect(200);
    assert.deepEqual([...meta()['10.1.1.2'].deletedNames].sort(), ['h2', 'prd-web01', 'web01']);
    // VM name from the Excel/VM sync vs OS hostname from the agent/oscheck: same server, stays deleted
    assert.equal(cmdb.bulkUpsertCmdbServers([{ ip: '10.1.1.2', hostname: 'PRD-WEB01' }, { ip: '10.1.1.2', hostname: 'WEB01.corp.local' }], 'INVENTORY_SCAN'), 0);
    assert.equal(meta()['10.1.1.2'].deleted, true);
    // a genuinely different host revives it and drops the recorded names
    assert.equal(cmdb.bulkUpsertCmdbServers([{ ip: '10.1.1.2', hostname: 'DB77' }], 'INVENTORY_SCAN'), 1);
    assert.equal(meta()['10.1.1.2'].deleted, false);
    assert.equal(meta()['10.1.1.2'].deletedNames, undefined);
});

test('legacy deleted entries without deletedNames never auto-revive; restore clears deletedNames', async () => {
    await seed();
    writeDataSync(META_KEY, { ...meta(), '10.1.1.5': { hostname: 'OLD', deleted: true, deletedAt: 'x', deletedBy: 'bob' } });
    assert.equal(cmdb.bulkUpsertCmdbServers([{ ip: '10.1.1.5', hostname: 'SOMETHING-ELSE' }], 'INVENTORY_SCAN'), 0);
    assert.equal(cmdb.reviveIfIpReused('10.1.1.5', 'SOMETHING-ELSE'), false);
    assert.equal(meta()['10.1.1.5'].deleted, true);

    await request(app).delete('/api/server-list/10.1.1.3').set(bearer(op)).expect(200);
    assert.ok(Array.isArray(meta()['10.1.1.3'].deletedNames));
    await request(app).post('/api/server-list/10.1.1.3/restore').set(bearer(op)).expect(200);
    assert.equal(meta()['10.1.1.3'].deletedNames, undefined);
});
