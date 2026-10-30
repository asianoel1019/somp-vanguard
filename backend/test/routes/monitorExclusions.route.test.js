require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const logger = require('../../lib/logger');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

let app;
const op = `Bearer ${signToken({ username: 'op', domain: 'corp', role: 'Operator', groups: ['mon'] })}`;
const viewer = `Bearer ${signToken({ username: 'vw', domain: 'corp', role: 'Viewer', groups: ['mon'] })}`;
const admin = `Bearer ${signToken({ username: 'sa', domain: 'corp', role: 'SuperAdmin', groups: ['mon'] })}`;
const URL = '/api/monitor/rules/exclusions';

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: { mon: { enabled: true, features: { monitorScout: true } } } });
    app = express(); app.use(express.json()); app.use('/api/monitor', require('../../routes/monitor'));
    dbManager.run("INSERT INTO monitors (id, name, ip, tags, envId, enabled) VALUES ('em1','EXR-01','10.8.0.1','[\"web\"]','prod',1),('em2','EXR-02','10.8.0.2','[]','prod',1)");
    dbManager.run("INSERT INTO rules (id, name, type, threshold, alertHits, actions, category) VALUES ('er1','Prod CPU','cpu',90,1,'[]','metric')");
    dbManager.run("INSERT INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES ('eb1','er1','env','prod')");
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => { dbManager.run('DELETE FROM rule_exclusions'); dbManager.run('DELETE FROM alerts'); dbManager.run('DELETE FROM alert_state'); });

test('POST validates: unknown rule / monitor → 400, empty or long tag → 400, bad scopeType → 400', async () => {
    await request(app).post(URL).set('Authorization', op).send({ ruleId: 'nope', scopeType: 'monitor', scopeValue: 'em1' }).expect(400);
    await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'monitor', scopeValue: 'ghost' }).expect(400);
    await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'tag', scopeValue: '' }).expect(400);
    await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'tag', scopeValue: 'x'.repeat(65) }).expect(400);
    await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'env', scopeValue: 'prod' }).expect(400);
    assert.equal(dbManager.get('SELECT count(*) c FROM rule_exclusions').c, 0);
});

test('POST creates (audited with rule name, host name, reason), duplicate → 409, GET lists and filters by ruleId', async (t) => {
    const logged = [];
    t.mock.method(logger, 'auditLog', (...a) => { logged.push(a); });
    const r = await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'monitor', scopeValue: 'em1', reason: 'being decommissioned' }).expect(200);
    assert.equal(r.body.exclusion.createdBy, 'op');
    assert.equal(r.body.exclusion.reason, 'being decommissioned');
    const entry = logged.find(a => /Excluded/.test(a[2]));
    assert.ok(entry, JSON.stringify(logged));
    assert.equal(entry[0], 'op');
    assert.match(entry[2], /Prod CPU/); assert.match(entry[2], /EXR-01/); assert.match(entry[2], /being decommissioned/);
    await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'monitor', scopeValue: 'em1' }).expect(409);
    await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'tag', scopeValue: 'web' }).expect(200);
    const all = await request(app).get(URL).set('Authorization', viewer).expect(200);
    assert.equal(all.body.length, 2);
    const filtered = await request(app).get(`${URL}?ruleId=er1`).set('Authorization', viewer).expect(200);
    assert.equal(filtered.body.length, 2);
    assert.equal((await request(app).get(`${URL}?ruleId=other`).set('Authorization', viewer).expect(200)).body.length, 0);
});

test('RBAC: Viewer can read but not add or remove', async () => {
    await request(app).post(URL).set('Authorization', viewer).send({ ruleId: 'er1', scopeType: 'monitor', scopeValue: 'em1' }).expect(403);
    const r = await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'monitor', scopeValue: 'em1' }).expect(200);
    await request(app).delete(`${URL}/${r.body.exclusion.id}`).set('Authorization', viewer).expect(403);
    await request(app).get(URL).set('Authorization', viewer).expect(200);
});

test('POST resolves the open alert of that rule on the excluded host silently and the engine stops evaluating it', async (t) => {
    const engine = require('../../services/scoutAlertEngine');
    const sent = [];
    t.mock.method(logger, 'sendTelegramAlert', async (m) => { sent.push(m); });
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, ruleName, type, resolved, triggeredAt) VALUES ('ea1','em1','er1','Prod CPU','cpu',0,?)", [new Date().toISOString()]);
    dbManager.run("INSERT INTO alert_state (stateKey, hitCount, status) VALUES ('em1-er1', 1, 'alerting')");
    const r = await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'monitor', scopeValue: 'em1' }).expect(200);
    assert.equal(r.body.resolvedAlerts, 1);
    const row = dbManager.get("SELECT resolved, resolvedReason FROM alerts WHERE id = 'ea1'");
    assert.equal(row.resolved, 1); assert.equal(row.resolvedReason, 'excluded');
    assert.equal(dbManager.get("SELECT count(*) c FROM alert_state WHERE stateKey = 'em1-er1'").c, 0);
    // route invalidated the engine cache: the very next breach report does not alert
    engine.evaluateReport({ id: 'em1', name: 'EXR-01', ip: '10.8.0.1', tags: '["web"]', envId: 'prod' }, { metrics: { cpu: { used: 99 } } });
    engine.evaluateReport({ id: 'em2', name: 'EXR-02', ip: '10.8.0.2', tags: '[]', envId: 'prod' }, { metrics: { cpu: { used: 99 } } });
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE monitorId = 'em1'").c, 1, 'only the resolved one');
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE monitorId = 'em2' AND resolved = 0").c, 1);
    assert.equal(sent.length, 0, 'no recovery notification for the resolved alert (rule has no actions anyway)');
});

test('DELETE removes and audits; unknown id → 404', async (t) => {
    const logged = [];
    t.mock.method(logger, 'auditLog', (...a) => { logged.push(a); });
    const r = await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'tag', scopeValue: 'web', reason: 'x' }).expect(200);
    await request(app).delete(`${URL}/${r.body.exclusion.id}`).set('Authorization', op).expect(200);
    assert.equal(dbManager.get('SELECT count(*) c FROM rule_exclusions').c, 0);
    assert.ok(logged.some(a => /Removed exclusion/.test(a[2]) && /Prod CPU/.test(a[2]) && /tag "web"/.test(a[2])), JSON.stringify(logged));
    await request(app).delete(`${URL}/missing`).set('Authorization', op).expect(404);
});

test('deleting a rule deletes its exclusions; deleting a monitor deletes its monitor exclusions', async () => {
    const rule = await request(app).post('/api/monitor/rules').set('Authorization', op).send({ name: 'tmp', type: 'cpu', threshold: 90 }).expect(200);
    await request(app).post(URL).set('Authorization', op).send({ ruleId: rule.body.id, scopeType: 'tag', scopeValue: 'web' }).expect(200);
    await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'monitor', scopeValue: 'em2' }).expect(200);
    await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'tag', scopeValue: 'web' }).expect(200);
    await request(app).delete(`/api/monitor/rules/${rule.body.id}`).set('Authorization', op).expect(200);
    assert.equal(dbManager.get('SELECT count(*) c FROM rule_exclusions WHERE ruleId = ?', [rule.body.id]).c, 0);
    await request(app).delete('/api/monitor/em2').set('Authorization', admin).expect(200);
    assert.deepEqual(dbManager.all('SELECT ruleId, scopeType, scopeValue FROM rule_exclusions').map(r => `${r.ruleId}:${r.scopeType}:${r.scopeValue}`), ['er1:tag:web']);
});

test('I1: adding an excluded tag to a host (PUT /:id and bulk-update) resolves its open alert of that rule silently', async (t) => {
    const sent = [];
    t.mock.method(logger, 'sendTelegramAlert', async (m) => { sent.push(m); });
    dbManager.run("INSERT OR REPLACE INTO monitors (id, name, ip, tags, envId, enabled) VALUES ('em3','EXR-03','10.8.0.3','[]','prod',1),('em4','EXR-04','10.8.0.4','[]','prod',1)");
    await request(app).post(URL).set('Authorization', op).send({ ruleId: 'er1', scopeType: 'tag', scopeValue: 'batch' }).expect(200);
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, ruleName, type, resolved, triggeredAt) VALUES ('tg1','em3','er1','Prod CPU','cpu',0,?),('tg2','em4','er1','Prod CPU','cpu',0,?)", [new Date().toISOString(), new Date().toISOString()]);
    await request(app).put('/api/monitor/em3').set('Authorization', op).send({ tags: ['batch'] }).expect(200);
    assert.equal(dbManager.get("SELECT resolvedReason FROM alerts WHERE id = 'tg1'").resolvedReason, 'excluded');
    assert.equal(dbManager.get("SELECT resolved FROM alerts WHERE id = 'tg2'").resolved, 0);
    await request(app).post('/api/monitor/bulk-update').set('Authorization', op).send({ agentIds: ['em4'], mode: 'append', config: { tags: ['batch'] } }).expect(200);
    assert.equal(dbManager.get("SELECT resolvedReason FROM alerts WHERE id = 'tg2'").resolvedReason, 'excluded');
    assert.equal(sent.length, 0);
});
