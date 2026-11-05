// F5 iControl REST sessions: token reuse, refresh before expiry, one login for concurrent requests, a single
// re-login on 401, uncached test sessions, forget, and no token / password in error messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const httpClient = require('../../lib/netDevices/httpClient');
const f5Session = require('../../lib/netDevices/f5Session');

let logins = 0;
let calls = [];
let tokenTimeout = 1200;
let revoked = new Set();
let loginStatus = null;
let loginDelay = 0;

function stub() {
    httpClient.setTransportForTest(async (config) => {
        calls.push(config);
        if (config.url.endsWith('/mgmt/shared/authn/login')) {
            if (loginDelay) await new Promise(r => setTimeout(r, loginDelay));
            if (loginStatus) throw Object.assign(new Error(String(loginStatus)), { response: { status: loginStatus } });
            logins += 1;
            return { status: 200, data: { username: config.data.username, token: { token: `TOKEN${logins}XYZ`, timeout: tokenTimeout } } };
        }
        const t = config.headers['X-F5-Auth-Token'];
        if (!t || revoked.has(t)) throw Object.assign(new Error('401'), { response: { status: 401 } });
        return { status: 200, data: { token: t, path: config.url } };
    });
}

test.beforeEach(() => {
    f5Session._reset();
    logins = 0;
    calls = [];
    tokenTimeout = 1200;
    revoked = new Set();
    loginStatus = null;
    loginDelay = 0;
    stub();
});
test.after(() => httpClient.setTransportForTest(null));

const profile = { vendor: 'f5', mgmtHost: '192.0.2.80', port: 443, username: 'auditor1', loginProvider: 'tmos', secrets: { password: 'pw-123456' } };

test('login once, token reused across sessions, sent as X-F5-Auth-Token', async () => {
    const a = await f5Session.open(profile).request({ path: '/mgmt/tm/sys/version' });
    const b = await f5Session.open(profile).request({ path: '/mgmt/tm/sys/version' });
    assert.equal(logins, 1);
    assert.equal(a.token, 'TOKEN1XYZ');
    assert.equal(b.token, 'TOKEN1XYZ');
    const login = calls[0];
    assert.equal(login.method, 'POST');
    assert.deepEqual(login.data, { username: 'auditor1', password: 'pw-123456', loginProviderName: 'tmos' });
    assert.equal(calls[1].method, 'GET');
});

test('a token close to expiry is replaced before use', async () => {
    tokenTimeout = 30; // below the one-minute margin
    await f5Session.open(profile).request({ path: '/a' });
    await f5Session.open(profile).request({ path: '/b' });
    assert.equal(logins, 2);
});

test('concurrent requests share one login', async () => {
    loginDelay = 20;
    const s = f5Session.open(profile);
    await Promise.all([s.request({ path: '/a' }), s.request({ path: '/b' }), f5Session.open(profile).request({ path: '/c' })]);
    assert.equal(logins, 1);
});

test('401 on a request: one new login and one retry, never a loop', async () => {
    await f5Session.open(profile).request({ path: '/a' });
    revoked.add('TOKEN1XYZ');
    const r = await f5Session.open(profile).request({ path: '/b' });
    assert.equal(r.token, 'TOKEN2XYZ');
    assert.equal(logins, 2);
    // a token refused right after login: AUTH after exactly one retry
    httpClient.setTransportForTest(async (config) => {
        calls.push(config);
        if (config.url.endsWith('/login')) { logins += 1; return { status: 200, data: { token: { token: `T${logins}`, timeout: 1200 } } }; }
        throw Object.assign(new Error('401'), { response: { status: 401 } });
    });
    f5Session._reset();
    logins = 0;
    await assert.rejects(f5Session.open(profile).request({ path: '/c' }), (e) => e.code === 'AUTH');
    assert.equal(logins, 2);
});

test('login errors: wrong password, refused login, no token in messages', async () => {
    loginStatus = 401;
    await assert.rejects(f5Session.open(profile).request({ path: '/a' }), (e) => e.code === 'AUTH' && !/pw-123456/.test(e.message));
    loginStatus = 400;
    await assert.rejects(f5Session.open(profile).request({ path: '/a' }), (e) => e.code === 'AUTH' && /login provider/.test(e.message));
    loginStatus = 404;
    await assert.rejects(f5Session.open(profile).request({ path: '/a' }), (e) => e.code === 'UNSUPPORTED');
    loginStatus = null;
    httpClient.setTransportForTest(async (config) => {
        if (config.url.endsWith('/login')) return { status: 200, data: { token: { token: 'SECRETTOKEN1', timeout: 1200 } } };
        throw Object.assign(new Error('boom SECRETTOKEN1'), { code: 'EWEIRD' });
    });
    await assert.rejects(f5Session.open(profile).request({ path: '/a' }), (e) => !/SECRETTOKEN1/.test(e.message));
    await assert.rejects(f5Session.open({ ...profile, secrets: {} }).request({ path: '/a' }), (e) => e.code === 'NOT_CONFIGURED');
});

test('uncached sessions (connection test) keep their token to themselves', async () => {
    const s = f5Session.open(profile, { cache: false });
    await s.request({ path: '/a' });
    await s.request({ path: '/b' });
    assert.equal(logins, 1);
    assert.equal(f5Session._size(), 0);
    await f5Session.open(profile).request({ path: '/c' });
    assert.equal(logins, 2, 'the cache logs in on its own');
});

test('a new password or forget() never reuses the old token', async () => {
    await f5Session.open(profile).request({ path: '/a' });
    await f5Session.open({ ...profile, secrets: { password: 'pw-new-999' } }).request({ path: '/b' });
    assert.equal(logins, 2);
    f5Session.forget(profile);
    assert.equal(f5Session._size(), 0);
    await f5Session.open(profile).request({ path: '/c' });
    assert.equal(logins, 3);
});
