const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, setTransportForTest } = require('../../lib/netDevices/httpClient');

test.afterEach(() => setTransportForTest(null));

const TOKEN = 'tok-abc-123456';
const client = (extra = {}) => createClient({ host: '192.0.2.10', port: 443, headers: { Authorization: `Bearer ${TOKEN}` }, ...extra });
const failWith = (err) => setTransportForTest(async () => { throw err; });

test('request config: fixed timeout, no redirects, size cap, TLS per device', async () => {
    let seen;
    setTransportForTest(async (cfg) => { seen = cfg; return { status: 200, data: { ok: 1 } }; });
    assert.deepEqual(await client().request({ path: '/api/v2/x', params: { vdom: 'root' } }), { ok: 1 });
    assert.equal(seen.url, 'https://192.0.2.10:443/api/v2/x');
    assert.equal(seen.timeout, 15000);
    assert.equal(seen.maxRedirects, 0);
    assert.equal(seen.maxContentLength, 20 * 1024 * 1024);
    assert.equal(seen.httpsAgent.options.rejectUnauthorized, false);
    await client({ tlsVerify: true }).request({ path: '/' });
    assert.equal(seen.httpsAgent.options.rejectUnauthorized, true);
    await createClient({ host: '2001:db8::1', port: 8443 }).request({ path: '/' });
    assert.equal(seen.url, 'https://[2001:db8::1]:8443/');
});

test('failures are classified and never quote the token', async () => {
    const cases = [
        [{ response: { status: 401 } }, 'AUTH', 502],
        [{ response: { status: 403 } }, 'FORBIDDEN', 502],
        [{ response: { status: 404 } }, 'UNSUPPORTED', 400],
        [{ response: { status: 500 } }, 'OTHER', 502],
        [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'UNREACHABLE', 504],
        [Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }), 'UNREACHABLE', 504],
        [Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), 'TLS', 502],
        [new Error(`weird failure with Bearer ${TOKEN}`), 'OTHER', 502],
    ];
    for (const [err, code, status] of cases) {
        failWith(err);
        await assert.rejects(client().request({ path: '/' }), (e) => e.code === code && e.status === status && !e.message.includes(TOKEN));
    }
});
