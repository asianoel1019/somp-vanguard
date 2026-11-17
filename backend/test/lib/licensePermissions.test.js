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
const BOSS = { username: 'boss', domain: 'local', role: 'SuperAdmin' };
const PW = 'Correct-horse-42';
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: {
        SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { dataCenter: true, serverList: true } },
        g: { type: 'group', target: 'g', enabled: true, features: { dataCenter: true } },
    } });
    localAccounts._resetForTest();
    setFree(); // free-created accounts stay active on both editions
    localAccounts.createAccount({ username: 'ops', role: 'Operator', password: PW }, 'admin');
    localAccounts.createAccount({ username: 'Watch', role: 'Viewer', password: PW }, 'admin');
    localAccounts.createAccount({ username: 'boss', role: 'SuperAdmin', password: PW }, 'admin');
    setPaid();
    app = express();
    app.use(requireAuth);
    app.get('/dc', checkFeature('dataCenter'), (req, res) => res.json({ ok: true }));
    app.get('/any', checkAnyFeature('networkDevice', 'dataCenter'), (req, res) => res.json({ ok: true }));
    app.get('/free', checkFeature('serverList'), (req, res) => res.json({ ok: true }));
});
test.after(async () => {
    setPaid();
    localAccounts._resetForTest();
    await dbManager.closeDB();
});

const get = (url, user) => request(app).get(url).set('Authorization', `Bearer ${signToken(user)}`);

test('localAccountRole: page accounts only, case-insensitive; null for break-glass, AD users and unknown names', () => {
    assert.equal(localAccounts.localAccountRole(OPERATOR), 'Operator');
    assert.equal(localAccounts.localAccountRole({ ...VIEWER, username: 'WATCH' }), 'Viewer');
    assert.equal(localAccounts.localAccountRole(BOSS), 'SuperAdmin');
    assert.equal(localAccounts.localAccountRole({ ...OPERATOR, domain: 'example.test' }), null);
    assert.equal(localAccounts.localAccountRole({ ...BOSS, domain: 'example.test' }), null);
    assert.equal(localAccounts.localAccountRole(LOCAL_ADMIN), null);
    assert.equal(localAccounts.localAccountRole({ username: 'nobody', domain: 'local', role: 'Operator' }), null);
});

test('paid: page SuperAdmin has every licensed feature like the break-glass admin', () => {
    setPaid();
    assert.equal(buildFeatureMap(BOSS).serverList, true);
    assert.equal(buildFeatureMap(BOSS).settings, true);
    assert.equal(buildFeatureMap(BOSS).auditLog, true);
    assert.deepEqual(buildFeatureMap(BOSS), buildFeatureMap(LOCAL_ADMIN));
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
    for (const u of [LOCAL_ADMIN, OPERATOR, VIEWER, BOSS]) {
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
