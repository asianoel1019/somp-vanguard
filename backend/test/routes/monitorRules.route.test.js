require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

let app;
const op = `Bearer ${signToken({ username: 'op', domain: 'corp', role: 'Operator', groups: ['mon'] })}`;
test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: { mon: { enabled: true, features: { monitorScout: true } } } });
    app = express(); app.use(express.json()); app.use('/api/monitor', require('../../routes/monitor'));
});
test.after(async () => { await dbManager.closeDB(); });

test('rules store escalateAfterMin (valid → int, invalid/empty → null)', async () => {
    const created = await request(app).post('/api/monitor/rules').set('Authorization', op).send({ name: 'cpu', type: 'cpu', threshold: 90, escalateAfterMin: 30 }).expect(200);
    assert.equal(dbManager.get('SELECT escalateAfterMin FROM rules WHERE id = ?', [created.body.id]).escalateAfterMin, 30);
    await request(app).put(`/api/monitor/rules/${created.body.id}`).set('Authorization', op).send({ escalateAfterMin: '' }).expect(200);
    assert.equal(dbManager.get('SELECT escalateAfterMin FROM rules WHERE id = ?', [created.body.id]).escalateAfterMin, null);
    await request(app).put(`/api/monitor/rules/${created.body.id}`).set('Authorization', op).send({ escalateAfterMin: 99999 }).expect(200);
    assert.equal(dbManager.get('SELECT escalateAfterMin FROM rules WHERE id = ?', [created.body.id]).escalateAfterMin, null);
});

test('rule/binding routes invalidate the engine rule cache (a new rule evaluates on the very next report)', async () => {
    const engine = require('../../services/scoutAlertEngine');
    const mon = { id: 'cache-m', name: 'CACHE-01', ip: '10.1.1.1', apiKey: 'kc', tags: '[]', envId: null };
    const cpu = { metrics: { cpu: { used: 99 } } };
    engine.invalidateRuleCache();
    engine.evaluateReport(mon, cpu); // warm the cache without the new rule
    const rule = await request(app).post('/api/monitor/rules').set('Authorization', op).send({ name: 'cache cpu', type: 'cpu', threshold: 90, alertHits: 1, actions: [] }).expect(200);
    await request(app).post('/api/monitor/rules/bindings').set('Authorization', op).send({ ruleId: rule.body.id, scopeType: 'monitor', scopeValue: 'cache-m' }).expect(200);
    engine.evaluateReport(mon, cpu);
    assert.equal(dbManager.get('SELECT count(*) c FROM alerts WHERE checkId = ?', [rule.body.id]).c, 1);
});

test('self-healing scripts follow the shared hasFeature: SuperAdmin -> built-in mapping switch, local admin always', async () => {
    const roles = ['SuperAdmin', 'Operator', 'Viewer', 'None'];
    const boss = `Bearer ${signToken({ username: 'boss', domain: 'corp', role: 'SuperAdmin', groups: [] })}`;
    const local = `Bearer ${signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' })}`;
    const body = { name: 'heal', type: 'cpu', threshold: 90, remediationScript: 'Restart-Service x' };
    const setBuiltin = (on) => writeRbacConfig({ roles, users: {}, defaultRole: 'Viewer', groups: {
        mon: { enabled: true, features: { monitorScout: true } },
        SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { monitorScout: true, manage_self_healing: on } },
    } });
    try {
        setBuiltin(false);
        await request(app).post('/api/monitor/rules').set('Authorization', boss).send(body).expect(403);
        await request(app).post('/api/monitor/rules').set('Authorization', local).send(body).expect(200);
        await request(app).post('/api/monitor/rules').set('Authorization', op).send(body).expect(403);
        setBuiltin(true);
        await request(app).post('/api/monitor/rules').set('Authorization', boss).send(body).expect(200);
    } finally {
        writeRbacConfig({ roles, users: {}, defaultRole: 'Viewer', groups: { mon: { enabled: true, features: { monitorScout: true } } } });
    }
});
