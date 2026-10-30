require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { hasFeature, buildFeatureMap } = require('../../lib/permissions');

process.env.LOCAL_ADMIN_PWD = 'test-local-pwd';

const app = express();
app.use(express.json());
app.use('/api/auth', require('../../routes/auth'));

const ROLES = ['SuperAdmin', 'Operator', 'Viewer', 'None'];
const boss = { username: 'boss', domain: 'corp', role: 'SuperAdmin', groups: ['ops'] };
const op = { username: 'op', domain: 'corp', role: 'Operator', groups: ['ops'] };
const localAdmin = { username: 'admin', domain: 'local', role: 'SuperAdmin' };
const bearer = (u) => `Bearer ${signToken(u)}`;

test.beforeEach(() => {
    writeRbacConfig({
        roles: ROLES, users: {}, defaultRole: 'Viewer', groups: {
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { dnsHub: true, workflow: false, monitorScout: false, manage_self_healing: false } },
            ops: { type: 'group', target: 'ops', enabled: true, features: { workflow: true, ipam: true, monitorScout: true } },
        },
    });
});

test('/config for an AD SuperAdmin follows the built-in mapping, not their groups', async () => {
    const { body } = await request(app).get('/api/auth/config').set('Authorization', bearer(boss)).expect(200);
    assert.equal(body.features.dnsHub, true);
    assert.equal(body.features.workflow, false);
    assert.equal(body.features.ipam, false);
    assert.equal(body.features.monitorScout, false, 'SuperAdmin gets every switchable key in /config');
    for (const [k, v] of Object.entries(body.features)) assert.equal(v, hasFeature(boss, k), k);
});

test('/config for a non-SuperAdmin: group union, every switchable key (screen hidden exactly when the API refuses)', async () => {
    const { body } = await request(app).get('/api/auth/config').set('Authorization', bearer(op)).expect(200);
    assert.equal(body.features.workflow, true);
    assert.equal(body.features.ipam, true);
    assert.equal(body.features.dnsHub, false);
    assert.equal(body.features.monitorScout, true);
    assert.equal(body.features.monitorAlerts, false);
    for (const [k, v] of Object.entries(body.features)) assert.equal(v, hasFeature(op, k), k);
});

test('/config for the local admin: everything on (break-glass), kill switch still wins', async (t) => {
    process.env.APP_ENABLE_IPAM = 'false';
    t.after(() => { delete process.env.APP_ENABLE_IPAM; });
    const { body } = await request(app).get('/api/auth/config').set('Authorization', bearer(localAdmin)).expect(200);
    assert.equal(body.features.workflow, true);
    assert.equal(body.features.monitorScout, true);
    assert.equal(body.features.ipam, false);
});

test('/config without a token still exposes only the global flags', async () => {
    const { body } = await request(app).get('/api/auth/config').expect(200);
    assert.equal(body.features.workflow, true);
});

test('local admin login returns the full feature map from the shared helper', async () => {
    const { body } = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'test-local-pwd' }).expect(200);
    assert.equal(body.user.role, 'SuperAdmin');
    assert.equal(body.user.features.manage_self_healing, true);
    assert.equal(body.user.features.workflow, true);
    assert.deepEqual(body.user.features, buildFeatureMap({ username: 'admin', domain: 'local', role: 'SuperAdmin' }));
});
