require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

const tok = (role, username = role.toLowerCase()) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['mon'] })}`;
const admin = tok('SuperAdmin'), op = tok('Operator'), viewer = tok('Viewer');
let app;
const later = (h) => new Date(Date.now() + h * 3600000).toISOString();

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: { mon: { enabled: true, features: { monitorAlerts: true } } } });
    app = express(); app.use(express.json()); app.use('/api/alert-quality', require('../../routes/alertQuality'));
    dbManager.run("INSERT INTO monitors (id, name, ip, tags, enabled) VALUES ('m1','WEB-01','10.0.0.1','[]',1)");
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, ruleName, type, triggeredAt, resolved) VALUES ('a1','m1','r1','CPU','cpu',?,0)", [new Date().toISOString()]);
});
test.after(async () => { await dbManager.closeDB(); });

test('maintenance CRUD with validation, status and permissions', async () => {
    const body = { name: '今晚維護', kind: 'once', startAt: later(1), endAt: later(3), scopeType: 'monitors', scopeValues: ['m1'] };
    await request(app).post('/api/alert-quality/maintenance').set('Authorization', viewer).send(body).expect(403);
    const bad = await request(app).post('/api/alert-quality/maintenance').set('Authorization', op).send({ ...body, endAt: later(-1) }).expect(400);
    assert.ok(bad.body.errors.length > 0);
    const created = await request(app).post('/api/alert-quality/maintenance').set('Authorization', op).send(body).expect(201);
    assert.equal(created.body.createdBy, 'operator');
    const list = await request(app).get('/api/alert-quality/maintenance').set('Authorization', viewer).expect(200);
    assert.equal(list.body[0].status, 'scheduled');
    assert.deepEqual(list.body[0].scopeValues, ['m1']);
    await request(app).put(`/api/alert-quality/maintenance/${created.body.id}`).set('Authorization', op).send({ enabled: false }).expect(200);
    assert.equal((await request(app).get('/api/alert-quality/maintenance').set('Authorization', op)).body[0].status, 'disabled');
    const tampered = await request(app).put(`/api/alert-quality/maintenance/${created.body.id}`).set('Authorization', op).send({ id: 'x', createdBy: 'hacker', source: 'evil', enabled: true }).expect(200);
    assert.equal(tampered.body.id, created.body.id);
    assert.equal(tampered.body.createdBy, 'operator');
    assert.equal(tampered.body.source, 'manual');
    const row = dbManager.get('SELECT id, createdBy, source FROM maintenance_windows WHERE id = ?', [created.body.id]);
    assert.equal(row.id, created.body.id);
    assert.equal(row.createdBy, 'operator');
    assert.equal(row.source, 'manual');
    await request(app).put(`/api/alert-quality/maintenance/${created.body.id}`).set('Authorization', op).send({ enabled: 'false' }).expect(400);
    await request(app).put(`/api/alert-quality/maintenance/${created.body.id}`).set('Authorization', op).send({ enabled: false }).expect(200);
    await request(app).delete(`/api/alert-quality/maintenance/${created.body.id}`).set('Authorization', op).expect(200);
    await request(app).delete('/api/alert-quality/maintenance/nope').set('Authorization', op).expect(404);
});

test('quick mute creates a host+rule window for 1/4/24 hours only', async () => {
    await request(app).post('/api/alert-quality/mute').set('Authorization', op).send({ alertId: 'a1', hours: 2 }).expect(400);
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, ruleName, type, triggeredAt, resolved) VALUES ('a-nocheck','m1',NULL,NULL,NULL,?,0)", [new Date().toISOString()]);
    const nc = await request(app).post('/api/alert-quality/mute').set('Authorization', op).send({ alertId: 'a-nocheck', hours: 1 }).expect(400);
    assert.equal(nc.body.error, 'This alert has no rule information and cannot be muted');
    await request(app).post('/api/alert-quality/mute').set('Authorization', op).send({ alertId: 'zzz', hours: 1 }).expect(404);
    const w = await request(app).post('/api/alert-quality/mute').set('Authorization', op).send({ alertId: 'a1', hours: 4 }).expect(201);
    assert.equal(w.body.source, 'quick-mute');
    assert.deepEqual(w.body.scopeValues, ['m1']);
    assert.deepEqual(w.body.ruleIds, ['r1']);
    assert.equal(w.body.status, 'active');
});

test('settings: read for logged-in users, write SuperAdmin only, validated', async () => {
    const s = await request(app).get('/api/alert-quality/settings').set('Authorization', viewer).expect(200);
    assert.equal(s.body.rateLimitPerMinute, 10);
    await request(app).put('/api/alert-quality/settings').set('Authorization', op).send({ rateLimitPerMinute: 20 }).expect(403);
    await request(app).put('/api/alert-quality/settings').set('Authorization', admin).send({ rateLimitPerMinute: 0 }).expect(400);
    const saved = await request(app).put('/api/alert-quality/settings').set('Authorization', admin).send({ rateLimitPerMinute: 20 }).expect(200);
    assert.equal(saved.body.rateLimitPerMinute, 20);
    await request(app).put('/api/alert-quality/settings').set('Authorization', admin).send({ escalation: { telegram: { enabled: true, chatId: '12345' } } }).expect(200);
    const v = await request(app).get('/api/alert-quality/settings').set('Authorization', viewer).expect(200);
    assert.equal(v.body.escalation.telegram.enabled, true);
    assert.equal(v.body.escalation.telegram.chatId, '');
    assert.equal(v.body.escalation.email.to, '');
    const a = await request(app).get('/api/alert-quality/settings').set('Authorization', admin).expect(200);
    assert.equal(a.body.escalation.telegram.chatId, '12345');   // redaction must not mutate the shared cache
});

test('preview requires Operator and returns the report shape', async () => {
    await request(app).get('/api/alert-quality/preview').set('Authorization', viewer).expect(403);
    const p = await request(app).get('/api/alert-quality/preview').set('Authorization', op).expect(200);
    assert.ok(Array.isArray(p.body.firing));
});

test('unauthenticated requests are rejected', async () => {
    await request(app).get('/api/alert-quality/settings').expect(401);
    await request(app).get('/api/alert-quality/maintenance').expect(401);
});
