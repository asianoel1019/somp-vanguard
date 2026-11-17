require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { writeRbacConfig } = require('../../lib/rbac');
const { evaluateFeature, buildFeatureMap } = require('../../lib/permissions');
const { requireAuth, checkFeature, checkAnyFeature } = require('../../middleware/auth');
const localAccounts = require('../../lib/localAccounts');
const { signToken } = require('../helpers/http');
const { setPaid, setFree } = require('../helpers/license');

const LOCAL_ADMIN = { username: 'admin', domain: 'local', role: 'SuperAdmin' };
const SA = { username: 'boss', domain: 'corp', role: 'SuperAdmin', groups: ['g'] };
const OPERATOR = { username: 'ops', domain: 'local', role: 'Operator' };
const VIEWER = { username: 'watch', domain: 'local', role: 'Viewer' };
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: {
        SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { dataCenter: true, serverList: true } },
        g: { type: 'group', target: 'g', enabled: true, features: { dataCenter: true } },
    } });
    process.env.LOCAL_OPERATOR_USER = 'ops'; process.env.LOCAL_OPERATOR_PWD = 'op-pass';
    process.env.LOCAL_VIEWER_USER = 'Watch'; process.env.LOCAL_VIEWER_PWD = 'view-pass';
    app = express();
    app.use(requireAuth);
    app.get('/dc', checkFeature('dataCenter'), (req, res) => res.json({ ok: true }));
    app.get('/any', checkAnyFeature('networkDevice', 'dataCenter'), (req, res) => res.json({ ok: true }));
    app.get('/free', checkFeature('serverList'), (req, res) => res.json({ ok: true }));
});
test.after(async () => {
    setPaid();
    for (const k of ['LOCAL_OPERATOR_USER', 'LOCAL_OPERATOR_PWD', 'LOCAL_VIEWER_USER', 'LOCAL_VIEWER_PWD']) delete process.env[k];
    await dbManager.closeDB();
});

const get = (url, user) => request(app).get(url).set('Authorization', `Bearer ${signToken(user)}`);

test('localAccounts: admin always listed; operator / viewer only with user and password; first match wins', () => {
    assert.deepEqual(localAccounts.list().map(a => a.role), [null, 'Operator', 'Viewer']);
    assert.equal(localAccounts.find('WATCH').role, 'Viewer');
    assert.equal(localAccounts.isBuiltinLocalUser(OPERATOR), true);
    assert.equal(localAccounts.isBuiltinLocalUser({ ...OPERATOR, domain: 'corp' }), false);
    assert.equal(localAccounts.isBuiltinLocalUser(LOCAL_ADMIN), false);
    process.env.LOCAL_VIEWER_PWD = '';
    assert.equal(localAccounts.find('watch'), null);
    process.env.LOCAL_VIEWER_PWD = 'view-pass';
    process.env.LOCAL_OPERATOR_USER = 'admin';
    assert.equal(localAccounts.find('admin').role, null); // the local admin wins a name clash
    process.env.LOCAL_OPERATOR_USER = 'ops';
});

test('paid: features follow RBAC as before; built-in local accounts get every feature except settings / auditLog', () => {
    setPaid();
    assert.equal(evaluateFeature(SA, 'dataCenter', require('../../lib/rbac').readRbacConfig()), true);
    assert.equal(buildFeatureMap(LOCAL_ADMIN).networkDevice, true);
    const op = buildFeatureMap(OPERATOR);
    assert.equal(op.networkDevice, true);
    assert.equal(op.serverList, true);
    assert.equal(op.settings, false);
    assert.equal(op.auditLog, false);
});

test('free: paid features are off for everyone, local admin and SuperAdmin included; free features unchanged', () => {
    setFree();
    for (const u of [LOCAL_ADMIN, OPERATOR, VIEWER]) {
        const m = buildFeatureMap(u);
        assert.equal(m.dataCenter, false, u.username);
        assert.equal(m.aiAgent, false, u.username);
        assert.equal(m.serverList, true, u.username);
    }
    assert.equal(buildFeatureMap(LOCAL_ADMIN).settings, true);
    setPaid();
});

test('free: middleware answers LICENSE_REQUIRED for paid features, AD tokens get 401', async () => {
    setFree();
    let r = await get('/dc', LOCAL_ADMIN);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'LICENSE_REQUIRED');
    assert.match(r.body.error, /feature/i);
    r = await get('/any', LOCAL_ADMIN);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'LICENSE_REQUIRED');
    r = await get('/free', OPERATOR);
    assert.equal(r.status, 200);
    r = await get('/free', SA);
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'LICENSE_REQUIRED');
    setPaid();
    r = await get('/dc', SA);
    assert.equal(r.status, 200);
});
