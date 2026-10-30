require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { signToken } = require('../helpers/http');

// Capture audit lines (routes destructure auditLog at load time, so patch first)
const logger = require('../../lib/logger');
const audits = [];
logger.auditLog = (user, mod, msg) => { audits.push({ user, mod, msg }); };

const { readRbacConfig, writeRbacConfig } = require('../../lib/rbac');

const app = express();
app.use(express.json());
app.use('/api/rbac', require('../../routes/rbac'));

const superAdmin = `Bearer ${signToken({ username: 'boss', domain: 'corp', role: 'SuperAdmin' })}`;
const operator = `Bearer ${signToken({ username: 'op', domain: 'corp', role: 'Operator' })}`;
const viewerLocalName = `Bearer ${signToken({ username: 'admin', domain: 'corp', role: 'Viewer' })}`;
const ROLES = ['SuperAdmin', 'Operator', 'Viewer', 'None'];

test.beforeEach(() => {
    audits.length = 0;
    writeRbacConfig({
        roles: ROLES, users: {}, defaultRole: 'Viewer', groups: {
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { aiAgent: true, dnsHub: false, settings: true, auditLog: true } },
            ops: { type: 'group', target: 'ops', adOu: 'ops', enabled: true, features: { dnsHub: true }, auditLogs: {} },
        },
    });
});

test('GET /groups lists the built-in mapping', async () => {
    const res = await request(app).get('/api/rbac/groups').set('Authorization', superAdmin).expect(200);
    assert.equal(res.body.SuperAdmin.builtin, true);
    assert.equal(res.body.SuperAdmin.type, 'role');
});

test('non-SuperAdmin cannot read or change the built-in mapping', async () => {
    for (const auth of [operator, viewerLocalName]) {
        await request(app).get('/api/rbac/groups').set('Authorization', auth).expect(403);
        await request(app).post('/api/rbac/groups').set('Authorization', auth)
            .send({ name: 'SuperAdmin', features: { dnsHub: true } }).expect(403);
        await request(app).delete('/api/rbac/groups/SuperAdmin').set('Authorization', auth).expect(403);
    }
    assert.equal(readRbacConfig().groups.SuperAdmin.features.dnsHub, false);
});

test('DELETE of the built-in mapping (any case) -> 403 and it survives', async () => {
    for (const n of ['SuperAdmin', 'superadmin', 'SUPERADMIN']) {
        const res = await request(app).delete(`/api/rbac/groups/${n}`).set('Authorization', superAdmin).expect(403);
        assert.match(res.body.error, /built-in mapping cannot be deleted/i);
    }
    assert.equal(readRbacConfig().groups.SuperAdmin.builtin, true);
});

test('ordinary mappings can still be deleted', async () => {
    await request(app).delete('/api/rbac/groups/ops').set('Authorization', superAdmin).expect(200);
    assert.equal(readRbacConfig().groups.ops, undefined);
});

test('cannot create another mapping with the reserved name (any case, any type)', async () => {
    for (const body of [
        { name: 'superadmin', type: 'group', target: 'X' },
        { name: 'SUPERADMIN', type: 'ou', target: 'ou=x' },
        { name: 'SuperAdmin ', type: 'group', target: 'X' },
        { name: 'SuperAdmin', type: 'account', target: 'someone' },
    ]) {
        await request(app).post('/api/rbac/groups').set('Authorization', superAdmin).send(body).expect(400);
    }
    const cfg = readRbacConfig();
    assert.deepEqual(Object.keys(cfg.groups).sort(), ['SuperAdmin', 'ops']);
    assert.equal(cfg.groups.SuperAdmin.type, 'role');
    assert.equal(cfg.users['someone@corp'], undefined);
});

test('cannot change the built-in type / target / enabled', async () => {
    for (const body of [
        { name: 'SuperAdmin', type: 'group', features: {} },
        { name: 'SuperAdmin', target: 'Domain Users', features: {} },
        { name: 'SuperAdmin', adOu: 'ou=x', features: {} },
        { name: 'SuperAdmin', enabled: false, features: {} },
    ]) {
        await request(app).post('/api/rbac/groups').set('Authorization', superAdmin).send(body).expect(400);
    }
    const b = readRbacConfig().groups.SuperAdmin;
    assert.equal(b.enabled, true);
    assert.equal(b.type, 'role');
    assert.equal(b.target, undefined);
});

test('SuperAdmin edits the built-in feature switches; locked keys stay on; change is audited', async () => {
    const res = await request(app).post('/api/rbac/groups').set('Authorization', superAdmin)
        .send({ name: 'SuperAdmin', type: 'role', enabled: true, features: { aiAgent: false, dnsHub: true, settings: false, auditLog: false, bogus: 'yes' } })
        .expect(200);
    const b = res.body.groups.SuperAdmin;
    assert.equal(b.builtin, true);
    assert.equal(b.features.aiAgent, false);
    assert.equal(b.features.dnsHub, true);
    assert.equal(b.features.settings, true);
    assert.equal(b.features.auditLog, true);
    assert.equal(b.features.bogus, undefined, 'non-boolean values are dropped');
    assert.equal(readRbacConfig().groups.SuperAdmin.features.dnsHub, true);
    const line = audits.find(a => /built-in SuperAdmin/i.test(a.msg));
    assert.ok(line, 'audited');
    assert.equal(line.user, 'boss');
    assert.match(line.msg, /on: dnsHub/);
    assert.match(line.msg, /off: aiAgent/);
});

test('editing the built-in keeps unmentioned keys and accepts a description', async () => {
    await request(app).post('/api/rbac/groups').set('Authorization', superAdmin)
        .send({ name: 'SuperAdmin', features: { dnsHub: true }, description: 'core admins' }).expect(200);
    const b = readRbacConfig().groups.SuperAdmin;
    assert.equal(b.features.aiAgent, true);
    assert.equal(b.description, 'core admins');
});

test('built-in accepts only the feature keys the editor shows', async () => {
    await request(app).post('/api/rbac/groups').set('Authorization', superAdmin)
        .send({ name: 'SuperAdmin', features: { '__proto__x': true, 'a b': true, ok_key: true, constructor: true, ipam: true, manage_self_healing: false } }).expect(200);
    const b = readRbacConfig().groups.SuperAdmin;
    assert.equal(b.features.ok_key, undefined);
    assert.equal(b.features['a b'], undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(b.features, 'constructor'), false);
    assert.equal(b.features.ipam, true);
    assert.equal(b.features.manage_self_healing, false);
});

test('description changes are included in the audit line', async () => {
    await request(app).post('/api/rbac/groups').set('Authorization', superAdmin)
        .send({ name: 'SuperAdmin', features: {}, description: 'new text' }).expect(200);
    const line = audits.find(a => /built-in SuperAdmin/i.test(a.msg));
    assert.match(line.msg, /description changed/);
    audits.length = 0;
    await request(app).post('/api/rbac/groups').set('Authorization', superAdmin)
        .send({ name: 'SuperAdmin', features: {}, description: 'new text' }).expect(200);
    assert.doesNotMatch(audits.find(a => /built-in SuperAdmin/i.test(a.msg)).msg, /description changed/);
});

test('lookalike reserved names (fullwidth, zero-width) are rejected', async () => {
    for (const name of ['ＳｕｐｅｒＡｄｍｉｎ', 'Super​Admin']) {
        await request(app).post('/api/rbac/groups').set('Authorization', superAdmin)
            .send({ name, type: 'group', target: 'X' }).expect(400);
        await request(app).delete(`/api/rbac/groups/${encodeURIComponent(name)}`).set('Authorization', superAdmin).expect(403);
    }
});

test('an AD account literally named SuperAdmin can be added (mapping name is derived)', async () => {
    const res = await request(app).post('/api/rbac/groups').set('Authorization', superAdmin)
        .send({ name: 'SuperAdmin', type: 'account', target: 'SuperAdmin' }).expect(200);
    assert.equal(res.body.isAccount, true);
    const entry = readRbacConfig().users['superadmin@corp'];
    assert.equal(entry.role, 'None');
    assert.equal(entry.groupName, 'SuperAdmin (account)');
    // an explicit reserved name for a different account is still rejected
    await request(app).post('/api/rbac/groups').set('Authorization', superAdmin)
        .send({ name: 'SuperAdmin', type: 'account', target: 'bob' }).expect(400);
});

test('ordinary mapping create/update still works and cannot smuggle builtin flag', async () => {
    await request(app).post('/api/rbac/groups').set('Authorization', superAdmin)
        .send({ name: 'net', type: 'group', target: 'NetTeam', builtin: true, features: { ipam: true } }).expect(200);
    const g = readRbacConfig().groups.net;
    assert.equal(g.builtin, undefined);
    assert.equal(g.features.ipam, true);
});

test('role assignment for the reserved group key is rejected', async () => {
    await request(app).post('/api/rbac').set('Authorization', superAdmin)
        .send({ username: '[Group] SuperAdmin', domain: 'local', role: 'SuperAdmin', groupName: 'SuperAdmin' }).expect(400);
    assert.equal(readRbacConfig().users['[group] superadmin@local'], undefined);
});
