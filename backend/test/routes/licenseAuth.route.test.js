require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const powershell = require('../../lib/powershell');
const { signToken } = require('../helpers/http');
const { setPaid, setFree } = require('../helpers/license');

let app;
let adCalls = 0;

test.before(async () => {
    await dbManager.initDB();
    process.env.LOCAL_ADMIN_PWD = 'admin-pass';
    process.env.LOCAL_OPERATOR_USER = 'ops'; process.env.LOCAL_OPERATOR_PWD = 'op-pass';
    process.env.LOCAL_VIEWER_USER = 'watch'; process.env.LOCAL_VIEWER_PWD = 'view-pass';
    process.env.ALLOWED_AD_DOMAIN = 'example.test';
    powershell.validateADCredentials = async () => { adCalls++; return 'False'; };
    app = express();
    app.use(express.json());
    app.use('/api/auth', require('../../routes/auth'));
    app.use('/api/rbac', require('../../routes/rbac'));
});
test.after(async () => {
    setPaid();
    for (const k of ['LOCAL_ADMIN_PWD', 'LOCAL_OPERATOR_USER', 'LOCAL_OPERATOR_PWD', 'LOCAL_VIEWER_USER', 'LOCAL_VIEWER_PWD', 'ALLOWED_AD_DOMAIN']) delete process.env[k];
    await dbManager.closeDB();
});

const login = (username, password) => request(app).post('/api/auth/login').set('X-Forwarded-For', `192.0.2.${Math.floor(Math.random() * 200) + 1}`).send({ username, password });

test('local operator / viewer sign in on the free edition with their role and the license state', async () => {
    setFree();
    const op = await login('OPS', 'op-pass');
    assert.equal(op.status, 200);
    assert.equal(op.body.user.role, 'Operator');
    assert.equal(op.body.user.domain, 'local');
    assert.equal(op.body.user.features.serverList, true);
    assert.equal(op.body.user.features.dataCenter, false);
    assert.equal(op.body.user.license.edition, 'free');
    assert.ok(op.body.user.license.locked.includes('dataCenter'));

    const vw = await login('watch', 'view-pass');
    assert.equal(vw.status, 200);
    assert.equal(vw.body.user.role, 'Viewer');

    const bad = await login('ops', 'wrong');
    assert.equal(bad.status, 401);
    assert.equal(adCalls, 0); // a local name never falls through to AD
    setPaid();
});

test('free edition refuses AD sign-in before calling AD', async () => {
    setFree();
    adCalls = 0;
    const r = await login('alice', 'whatever');
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'LICENSE_REQUIRED');
    assert.equal(adCalls, 0);
    setPaid();
    await login('alice', 'whatever');
    assert.equal(adCalls, 1);
});

test('/config exposes the edition to everyone and the license state to signed-in users', async () => {
    setFree();
    let r = await request(app).get('/api/auth/config');
    assert.equal(r.body.edition, 'free');
    assert.equal(r.body.license, undefined);
    r = await request(app).get('/api/auth/config').set('Authorization', `Bearer ${signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' })}`);
    assert.equal(r.body.license.edition, 'free');
    assert.equal(r.body.features.dataCenter, false);
    setPaid();
});

test('free edition: RBAC is read-only', async () => {
    const auth = `Bearer ${signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' })}`;
    setFree();
    assert.equal((await request(app).get('/api/rbac/groups').set('Authorization', auth)).status, 200);
    const w = await request(app).post('/api/rbac/groups').set('Authorization', auth).send({ name: 'x' });
    assert.equal(w.status, 403);
    assert.equal(w.body.code, 'LICENSE_REQUIRED');
    setPaid();
});
