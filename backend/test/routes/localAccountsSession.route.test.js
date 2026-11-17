// Local accounts end to end through the routes: login -> management API -> requireAuth / WebSocket upgrade.
// Covers the canonical login name (padded / mixed case), sign-out reasons after page actions, no account enumeration,
// the unreadable-document answers, local-SuperAdmin-only management and the /me/password lockout. AD is stubbed.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const dbManager = require('../../services/db');
const powershell = require('../../lib/powershell');
const logger = require('../../lib/logger');
const la = require('../../lib/localAccounts');
const sessionRevocation = require('../../lib/sessionRevocation');
const sessionService = require('../../services/sessionService');
const { signToken } = require('../helpers/http');
const { setPaid, setFree } = require('../helpers/license');

const PW = 'Correct-horse-42';
const NEW_PW = 'Reset-pass-12345';
const audits = [];
let app; let adCalls = 0; let adAnswer = 'False'; let ipSeq = 0;
const BG = signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' });

test.before(async () => {
    await dbManager.initDB();
    process.env.LOCAL_ADMIN_PWD = 'admin-pass';
    process.env.ALLOWED_AD_DOMAIN = 'example.test';
    powershell.validateADCredentials = async () => { adCalls++; return adAnswer; };
    logger.auditLog = (u, m, a) => audits.push(`${u}|${m}|${a}`); // before routes/auth (it destructures auditLog)
    app = express(); app.use(express.json());
    app.use('/api/auth', require('../../routes/auth'));
    app.use('/api/local-accounts', require('../../routes/localAccounts'));
    const { requireAuth } = require('../../middleware/auth');
    app.get('/api/whoami', requireAuth, (req, res) => res.json({ role: req.user.role, username: req.user.username }));
});
test.beforeEach(() => {
    setPaid(); la._resetForTest(); sessionRevocation.resetForTest(); audits.length = 0; adCalls = 0; adAnswer = 'False';
    require('../../routes/localAccounts')._resetPasswordFailures();
});
test.after(async () => {
    setPaid(); la._resetForTest();
    for (const k of ['LOCAL_ADMIN_PWD', 'ALLOWED_AD_DOMAIN']) delete process.env[k];
    await dbManager.closeDB();
});

const nextIp = () => `192.0.2.${(ipSeq++ % 250) + 1}`;
const login = (username, password, ip = nextIp()) => request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ username, password });
const api = (method, path, token = BG) => request(app)[method](`/api/local-accounts${path}`).set('Authorization', `Bearer ${token}`);
const whoami = (token) => request(app).get('/api/whoami').set('Authorization', `Bearer ${token}`);
// revocation compares whole seconds: let the clock move past the token's iat
const nextSecond = () => new Promise(r => setTimeout(r, 1100));

test('padded / mixed-case login gets the canonical name; a password reset then ends that session', async () => {
    la.createAccount({ username: 'ops1', role: 'Operator', password: PW }, 'admin');
    const padded = await login('  ops1 ', PW);
    const upper = await login('OPS1', PW);
    for (const r of [padded, upper]) {
        assert.equal(r.status, 200);
        assert.equal(r.body.user.username, 'ops1');
        assert.equal(jwt.decode(r.body.token).username, 'ops1');
    }
    assert.ok(audits.some(a => a.startsWith('ops1|Auth|Local account login successful')));
    await nextSecond();
    assert.equal((await api('put', '/ops1').send({ password: NEW_PW })).status, 200);
    for (const r of [padded, upper]) {
        const w = await whoami(r.body.token);
        assert.equal(w.status, 401);
        assert.equal(w.body.code, 'SESSION_REVOKED');
        assert.equal(w.body.error, 'Your account or role was changed: please sign in again.');
    }
    // the break-glass admin gets its .env name too
    const bg = await login(' ADMIN ', 'admin-pass');
    assert.equal(bg.status, 200);
    assert.equal(jwt.decode(bg.body.token).username, 'admin');
});

test('non-string username / password is a 400', async () => {
    assert.equal((await login(['ops1'], PW)).status, 400);
    assert.equal((await login({ u: 'x' }, PW)).status, 400);
    assert.equal((await login('ops1', ['x'])).status, 400);
    assert.equal((await login('   ', PW)).status, 400);
});

test('the per-account lockout counts every spelling of one name together', async () => {
    la.createAccount({ username: 'ops2', role: 'Operator', password: PW }, 'admin');
    const ip = '192.0.2.251';
    for (const name of ['ops2', 'OPS2', ' ops2', 'Ops2 ', 'ops2@example.test']) {
        assert.equal((await login(name, 'Wrong-pass-123', ip)).status, 401);
    }
    assert.ok(audits.some(a => a.includes('Account locked for 15m due to 5 failed logins')));
});

test('enumeration: a wrong password for a page account answers exactly like an unknown name (AD never asked for it)', async () => {
    la.createAccount({ username: 'ops3', role: 'Operator', password: PW }, 'admin');
    for (const answer of ['False', 'Error: The server is not operational.']) {
        adAnswer = answer; adCalls = 0;
        const known = await login('ops3', 'Wrong-pass-123');
        assert.equal(adCalls, 0);
        const unknown = await login('nobody3', 'Wrong-pass-123');
        assert.equal(adCalls, 1);
        assert.equal(known.status, 401);
        assert.deepEqual([known.status, known.body], [unknown.status, unknown.body]);
    }
    const knownDom = await login('ops3@other.test', 'Wrong-pass-123');
    const unknownDom = await login('nobody3@other.test', 'Wrong-pass-123');
    assert.deepEqual([knownDom.status, knownDom.body], [unknownDom.status, unknownDom.body]);
    setFree();
    la.createAccount({ username: 'free3', role: 'Viewer', password: PW }, 'admin');
    const fKnown = await login('free3', 'Wrong-pass-123');
    const fUnknown = await login('nobody3', 'Wrong-pass-123');
    assert.equal(fKnown.status, 401);
    assert.deepEqual([fKnown.status, fKnown.body], [fUnknown.status, fUnknown.body]);
    // the inactive reason only follows the correct password
    const paidMade = await login('ops3', 'Wrong-pass-123');
    assert.deepEqual(paidMade.body, fUnknown.body);
    assert.equal((await login('ops3', PW)).body.code, 'LICENSE_REQUIRED');
});

test('requireAuth after page actions: disable / delete give their reason, role change and reset revoke', async () => {
    la.createAccount({ username: 's1', role: 'Operator', password: PW }, 'admin');
    la.createAccount({ username: 's2', role: 'Viewer', password: PW }, 'admin');
    const t1 = (await login('s1', PW)).body.token;
    const t2 = (await login('s2', PW)).body.token;
    await nextSecond();
    await api('put', '/s1').send({ disabled: true });
    let r = await whoami(t1);
    assert.deepEqual([r.status, r.body], [401, { error: 'Account disabled.', code: 'ACCOUNT_INACTIVE' }]);
    await api('delete', '/s1');
    r = await whoami(t1);
    assert.deepEqual([r.status, r.body], [401, { error: 'Your account no longer exists.', code: 'ACCOUNT_INACTIVE' }]);
    await api('put', '/s2').send({ role: 'Operator' });
    r = await whoami(t2);
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'SESSION_REVOKED');
    const t2b = (await login('s2', PW)).body.token;
    assert.equal((await whoami(t2b)).body.role, 'Operator');
});

test('PUT with no actual change neither ends sessions nor audits; self password reset is refused', async () => {
    la.createAccount({ username: 'n1', role: 'Viewer', password: PW }, 'admin');
    const old = { username: 'n1', domain: 'local', iat: Math.floor(Date.now() / 1000) - 5 };
    const r = await api('put', '/n1').send({ role: 'Viewer', disabled: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.account.role, 'Viewer');
    assert.equal(sessionRevocation.isRevoked(old), false);
    assert.equal(audits.length, 0);
    la.createAccount({ username: 'boss', role: 'SuperAdmin', password: PW }, 'admin');
    const boss = signToken({ username: 'boss', domain: 'local', role: 'SuperAdmin' });
    const self = await api('put', '/BOSS', boss).send({ password: NEW_PW });
    assert.deepEqual([self.status, self.body.error], [400, 'Use Change password to change your own password.']);
    assert.equal(la.authenticate('boss', PW).ok, true);
});

test('session ending failures: the committed change still answers 200 and is audited first', async () => {
    la.createAccount({ username: 'e1', role: 'Viewer', password: PW }, 'admin');
    const orig = sessionRevocation.revokeUser;
    sessionRevocation.revokeUser = () => { throw new Error('store offline'); };
    try {
        const r = await api('put', '/e1').send({ disabled: true });
        assert.equal(r.status, 200);
        assert.equal(r.body.account.disabled, true);
        assert.ok(audits.some(a => a.includes('Updated local account e1: disabled')));
        assert.equal((await api('delete', '/e1')).status, 200);
        assert.ok(audits.some(a => a.includes('Deleted local account e1')));
    } finally { sessionRevocation.revokeUser = orig; }
});

test('management is for local SuperAdmins only; AD sessions with the same short name survive', async () => {
    la.createAccount({ username: 'dup', role: 'Viewer', password: PW }, 'admin');
    const adSuper = signToken({ username: 'dup', domain: 'example.test', role: 'SuperAdmin' });
    assert.equal((await api('get', '/', adSuper)).status, 200);
    for (const [m, p, body] of [['post', '/', { username: 'x1', role: 'Viewer', password: PW }], ['put', '/dup', { disabled: true }], ['delete', '/dup', undefined]]) {
        const r = await api(m, p, adSuper).send(body);
        assert.equal(r.status, 403);
        assert.match(r.body.error, /local SuperAdmins only/);
    }
    la.createAccount({ username: 'pageboss', role: 'SuperAdmin', password: PW }, 'admin');
    const pageBoss = signToken({ username: 'pageboss', domain: 'local', role: 'SuperAdmin' });
    sessionService.registerSession({ token: 'tok-ad-dup', username: 'dup', domain: 'example.test', ip: '192.0.2.10' });
    sessionService.registerSession({ token: 'tok-local-dup', username: 'dup', domain: 'local', ip: '192.0.2.11' });
    assert.equal((await api('delete', '/dup', pageBoss)).status, 200);
    const names = sessionService.getActiveSessions().map(s => s.username);
    assert.ok(names.includes('dup@example.test'));
    assert.ok(!names.includes('dup@local'));
    sessionService.removeSession('tok-ad-dup');
});

test('unreadable accounts document: free login 503, paid continues to AD, live page sessions get the reason', async () => {
    la.createAccount({ username: 'u1', role: 'Viewer', password: PW }, 'admin');
    const token = signToken({ username: 'u1', domain: 'local', role: 'Viewer' });
    require('../../lib/db').writeDataSync(la.KEY, 'not:encrypted-garbage');
    la._resetCacheForTest();
    const s = await whoami(token);
    assert.deepEqual([s.status, s.body], [401, { error: 'Local accounts are unavailable.', code: 'ACCOUNTS_UNAVAILABLE' }]);
    assert.equal((await whoami(BG)).status, 200); // break-glass unaffected
    await login('u1', PW);
    assert.equal(adCalls, 1);
    setFree();
    adCalls = 0;
    for (const name of ['u1', 'nobody']) {
        const r = await login(name, PW);
        assert.deepEqual([r.status, r.body], [503, { error: 'Local accounts are unavailable.', code: 'ACCOUNTS_UNAVAILABLE' }]);
    }
    assert.equal(adCalls, 0);
    assert.equal((await login('admin', 'admin-pass')).status, 200);
});

test('/me/password: 5 wrong current passwords lock it for 15 minutes', async () => {
    la.createAccount({ username: 'me1', role: 'Viewer', password: PW }, 'admin');
    const me = signToken({ username: 'me1', domain: 'local', role: 'Viewer' });
    for (let i = 0; i < 5; i++) {
        const r = await api('put', '/me/password', me).send({ currentPassword: 'Wrong-pass-123', newPassword: NEW_PW });
        assert.equal(r.status, 400);
    }
    const locked = await api('put', '/me/password', me).send({ currentPassword: PW, newPassword: NEW_PW });
    assert.equal(locked.status, 429);
    assert.match(locked.body.error, /Try again in 15 minutes/);
    assert.equal(la.authenticate('me1', PW).ok, true);
});

test('/me/password success signs out and audits', async () => {
    la.createAccount({ username: 'me2', role: 'Viewer', password: PW }, 'admin');
    const t = (await login('me2', PW)).body.token;
    await nextSecond();
    const r = await api('put', '/me/password', t).send({ currentPassword: PW, newPassword: NEW_PW });
    assert.deepEqual([r.status, r.body], [200, { ok: true, signOut: true }]);
    assert.equal((await whoami(t)).body.code, 'SESSION_REVOKED');
    assert.ok(audits.some(a => a.includes('Changed own password: me2')));
    assert.equal(audits.some(a => a.includes(NEW_PW) || a.includes(PW)), false);
});

test('WebSocket upgrade check: disabled account and revoked token refused, active account accepted', async () => {
    const { authorizeUpgradeToken } = require('../../lib/websocket');
    la.createAccount({ username: 'w1', role: 'Operator', password: PW }, 'admin');
    la.createAccount({ username: 'w2', role: 'Viewer', password: PW }, 'admin');
    const t1 = (await login('w1', PW)).body.token;
    const t2 = (await login('w2', PW)).body.token;
    assert.equal(authorizeUpgradeToken(t1).role, 'Operator');
    await nextSecond();
    await api('put', '/w1').send({ disabled: true });
    assert.equal(authorizeUpgradeToken(t1), null);
    await api('put', '/w2').send({ password: NEW_PW }); // account still active, token revoked
    assert.equal(la.sessionCheck(jwt.decode(t2)).ok, true);
    assert.equal(authorizeUpgradeToken(t2), null);
    assert.equal(authorizeUpgradeToken('not-a-token'), null);
});

test('WebSocket upgrade over a real server: 401 for a disabled account', async () => {
    const { initWebSocketServer, closeAllConnections } = require('../../lib/websocket');
    la.createAccount({ username: 'w3', role: 'Viewer', password: PW }, 'admin');
    const token = (await login('w3', PW)).body.token;
    const server = http.createServer();
    initWebSocketServer(server);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const connect = () => new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
        ws.on('open', () => { ws.close(); resolve('open'); });
        ws.on('unexpected-response', (req, res) => { resolve(res.statusCode); req.destroy(); });
        ws.on('error', () => resolve('error'));
    });
    try {
        assert.equal(await connect(), 'open');
        la.updateAccount('w3', { disabled: true }, 'admin');
        assert.equal(await connect(), 401);
    } finally {
        closeAllConnections();
        await new Promise(r => server.close(r));
    }
});
