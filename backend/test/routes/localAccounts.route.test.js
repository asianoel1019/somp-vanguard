require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const la = require('../../lib/localAccounts');
const sessionRevocation = require('../../lib/sessionRevocation');
const logger = require('../../lib/logger');
const { signToken } = require('../helpers/http');
const { setPaid, setFree } = require('../helpers/license');

const PW = 'Correct-horse-42';
let app; const audits = [];
const BG = signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' });
test.before(async () => {
    await dbManager.initDB();
    logger.auditLog = (u, m, a) => audits.push(`${u}|${m}|${a}`);
    app = express(); app.use(express.json());
    app.use('/api/local-accounts', require('../../routes/localAccounts'));
});
test.beforeEach(() => { setPaid(); la._resetForTest(); sessionRevocation.resetForTest(); audits.length = 0; });
test.after(async () => { setPaid(); await dbManager.closeDB(); });

const api = (method, path, token = BG) => request(app)[method](`/api/local-accounts${path}`).set('Authorization', `Bearer ${token}`);

test('SuperAdmin creates, lists, updates and deletes; audit never holds a password', async () => {
    const c = await api('post', '/').send({ username: 'ops1', role: 'Operator', password: PW });
    assert.equal(c.status, 201);
    assert.equal(c.body.account.username, 'ops1');
    const l = await api('get', '/');
    assert.equal(l.status, 200);
    assert.equal(l.body.accounts.length, 1);
    assert.equal(l.body.breakGlass.username, 'admin');
    assert.equal(JSON.stringify(l.body).includes('scrypt'), false);
    assert.equal((await api('put', '/ops1').send({ role: 'Viewer', password: 'Reset-pass-123' })).body.account.role, 'Viewer');
    assert.equal((await api('delete', '/ops1')).status, 200);
    assert.equal(audits.some(a => a.includes(PW) || a.includes('Reset-pass-123')), false);
    assert.ok(audits.some(a => a.startsWith('admin|Local Accounts|') && a.includes('ops1')));
});

test('non-SuperAdmin cannot manage; can list', async () => {
    la.createAccount({ username: 'v1', role: 'Viewer', password: PW }, 'admin');
    const viewer = signToken({ username: 'v1', domain: 'local', role: 'Viewer' });
    assert.equal((await api('get', '/', viewer)).status, 200);
    assert.equal((await api('post', '/', viewer).send({ username: 'x1', role: 'Viewer', password: PW })).status, 403);
    assert.equal((await api('delete', '/v1', viewer)).status, 403);
});

test('free edition quota on the API', async () => {
    setFree();
    assert.equal((await api('post', '/').send({ username: 'f1', role: 'Viewer', password: PW })).status, 201);
    const r = await api('post', '/').send({ username: 'f2', role: 'Viewer', password: PW });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'LICENSE_REQUIRED');
    assert.equal(r.body.error, la.QUOTA_MESSAGE);
});

test('changes revoke the account sessions', async () => {
    la.createAccount({ username: 's1', role: 'Operator', password: PW }, 'admin');
    const old = { username: 's1', domain: 'local', iat: Math.floor(Date.now() / 1000) - 5 };
    await api('put', '/s1').send({ disabled: true });
    assert.equal(sessionRevocation.isRevoked(old), true);
});

test('self protection through the API', async () => {
    la.createAccount({ username: 'boss', role: 'SuperAdmin', password: PW }, 'admin');
    const boss = signToken({ username: 'boss', domain: 'local', role: 'SuperAdmin' });
    assert.equal((await api('delete', '/boss', boss)).status, 400);
    assert.equal((await api('put', '/boss', boss).send({ role: 'Viewer' })).status, 400);
});

test('me/password: page accounts only, needs the current password, signs out', async () => {
    la.createAccount({ username: 'me1', role: 'Viewer', password: PW }, 'admin');
    const me = signToken({ username: 'me1', domain: 'local', role: 'Viewer' });
    assert.equal((await api('put', '/me/password', me).send({ currentPassword: 'Wrong-pass-123', newPassword: 'Brand-new-pass-1' })).status, 400);
    const ok = await api('put', '/me/password', me).send({ currentPassword: PW, newPassword: 'Brand-new-pass-1' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.signOut, true);
    assert.equal(la.authenticate('me1', 'Brand-new-pass-1').ok, true);
    assert.equal((await api('put', '/me/password', BG).send({ currentPassword: 'x', newPassword: 'Brand-new-pass-1' })).status, 400);
});
