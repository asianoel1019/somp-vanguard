require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const powershell = require('../../lib/powershell');
const la = require('../../lib/localAccounts');
const { setPaid, setFree } = require('../helpers/license');

const PW = 'Correct-horse-42';
let app; let adCalls = 0;
test.before(async () => {
    await dbManager.initDB();
    process.env.LOCAL_ADMIN_PWD = 'admin-pass';
    process.env.ALLOWED_AD_DOMAIN = 'example.test';
    powershell.validateADCredentials = async () => { adCalls++; return 'False'; };
    app = express(); app.use(express.json());
    app.use('/api/auth', require('../../routes/auth'));
    const { requireAuth } = require('../../middleware/auth');
    app.get('/api/whoami', requireAuth, (req, res) => res.json({ role: req.user.role }));
});
test.beforeEach(() => { setPaid(); la._resetForTest(); adCalls = 0; });
test.after(async () => { setPaid(); delete process.env.LOCAL_ADMIN_PWD; delete process.env.ALLOWED_AD_DOMAIN; await dbManager.closeDB(); });

const login = (username, password) => request(app).post('/api/auth/login')
    .set('X-Forwarded-For', `192.0.2.${Math.floor(Math.random() * 200) + 1}`).send({ username, password });

test('break-glass admin signs in on both editions; not marked as a page account', async () => {
    for (const set of [setPaid, setFree]) {
        set();
        const r = await login('admin', 'admin-pass');
        assert.equal(r.status, 200);
        assert.equal(r.body.user.role, 'SuperAdmin');
        assert.ok(!r.body.user.localAccount);
    }
});

test('page account signs in with its stored role, never via AD', async () => {
    la.createAccount({ username: 'ops1', role: 'Operator', password: PW }, 'admin');
    const r = await login('OPS1', PW);
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'Operator');
    assert.equal(r.body.user.domain, 'local');
    assert.equal(r.body.user.localAccount, true);
    const bad = await login('ops1', 'Wrong-pass-123');
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, 'Invalid user name or password.');
    assert.equal(adCalls, 0);
});

test('free edition: paid-created refused, free-created accepted; license restores', async () => {
    la.createAccount({ username: 'p1', role: 'Viewer', password: PW }, 'admin');
    setFree();
    la.createAccount({ username: 'f1', role: 'Viewer', password: PW }, 'admin');
    const p = await login('p1', PW);
    assert.equal(p.status, 403);
    assert.equal(p.body.code, 'LICENSE_REQUIRED');
    assert.equal(p.body.error, 'This account is inactive on the free edition.');
    assert.equal((await login('f1', PW)).status, 200);
    setPaid();
    assert.equal((await login('p1', PW)).status, 200);
});

test('disabled account refused', async () => {
    la.createAccount({ username: 'd1', role: 'Viewer', password: PW }, 'admin');
    la.updateAccount('d1', { disabled: true }, 'admin');
    const r = await login('d1', PW);
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ACCOUNT_INACTIVE');
});

test('requireAuth: stored role wins; delete / disable / downgrade end the session', async () => {
    la.createAccount({ username: 's1', role: 'Operator', password: PW }, 'admin');
    const token = (await login('s1', PW)).body.token;
    const who = () => request(app).get('/api/whoami').set('Authorization', `Bearer ${token}`);
    assert.equal((await who()).body.role, 'Operator');
    la.updateAccount('s1', { role: 'Viewer' }, 'admin');
    assert.equal((await who()).body.role, 'Viewer');
    setFree();
    const free = await who();
    assert.equal(free.status, 401);
    assert.equal(free.body.code, 'LICENSE_REQUIRED');
    setPaid();
    la.updateAccount('s1', { disabled: true }, 'admin');
    const dis = await who();
    assert.equal(dis.status, 401);
    assert.equal(dis.body.code, 'ACCOUNT_INACTIVE');
    la.updateAccount('s1', { disabled: false }, 'admin');
    la.deleteAccount('s1', 'admin');
    const gone = await who();
    assert.equal(gone.status, 401);
    assert.equal(gone.body.error, 'Your account no longer exists.');
});
