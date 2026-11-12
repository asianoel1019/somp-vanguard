// The page over HTTP: network allowlist, input checks, answers, limits, audit lines and the confirmation mail.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { parseNets } = require('../src/net');
const ad = require('../src/ad');

const baseConfig = (nets = '127.0.0.1/32, ::1/128') => ({
    nets: parseNets(nets).list, trustProxy: false, allowHttp: true, adminContact: 'IT ext. 1234', ous: ['OU=Staff,DC=example,DC=test'],
    serviceUser: 'EXAMPLE\\svc-pwdchange', servicePassword: 'svc-secret', adServer: 'dc01.example.test',
});

async function start(t, { config = baseConfig(), outcome = { outcome: 'ok', reason: 'changed', account: { sam: 'alice', name: 'Alice', mail: 'alice@example.test' } }, limits } = {}) {
    const calls = { change: [], audit: [], mail: [] };
    const fakeAd = {
        changePassword: async (cfg, args) => { calls.change.push(args); return typeof outcome === 'function' ? outcome(args) : outcome; },
        passwordPolicy: async () => ({ minLength: 10, complexity: true, history: 5, minAgeDays: 1 }),
    };
    const app = createApp({ config, ad: fakeAd, audit: (e) => calls.audit.push(e), sendChanged: async (m) => { calls.mail.push(m); return ''; }, limits });
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    t.after(() => new Promise(r => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (body) => fetch(`${base}/api/change`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { base, post, calls };
}

const good = { account: 'EXAMPLE\\alice', currentPassword: 'Old-Pass-1', newPassword: 'New-Pass-22', confirmPassword: 'New-Pass-22' };

test('outside ALLOWED_NETS nothing is served, not even the page', async (t) => {
    const { base } = await start(t, { config: baseConfig('10.0.0.0/8') });
    for (const path of ['/', '/api/info', '/page.js']) {
        const r = await fetch(base + path);
        assert.equal(r.status, 403, path);
    }
});

test('the page and its info: strict headers, policy and contact', async (t) => {
    const { base } = await start(t);
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-powered-by'), null);
    const info = await (await fetch(base + '/api/info')).json();
    assert.deepEqual(info, { adminContact: 'IT ext. 1234', httpWarning: true, policy: { minLength: 10, complexity: true, history: 5, minAgeDays: 1 } });
});

test('a change: AD gets the parsed account, the user gets a mail, the audit line has no password', async (t) => {
    const { post, calls } = await start(t);
    const r = await post(good);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    assert.deepEqual(calls.change[0], { account: { kind: 'sam', value: 'alice' }, oldPassword: 'Old-Pass-1', newPassword: 'New-Pass-22' });
    assert.deepEqual(calls.mail[0], { to: 'alice@example.test', name: 'Alice', sam: 'alice', ip: '127.0.0.1' });
    assert.equal(calls.audit[0].outcome, 'ok');
    assert.doesNotMatch(JSON.stringify(calls.audit), /Old-Pass-1|New-Pass-22/);
});

test('bad input never reaches AD', async (t) => {
    const { post, calls } = await start(t);
    for (const body of [
        { ...good, confirmPassword: 'other' },
        { ...good, account: 'a*' },
        { ...good, newPassword: 'Old-Pass-1', confirmPassword: 'Old-Pass-1' },
        { ...good, currentPassword: '' },
        { account: 'alice' },
    ]) {
        const r = await post(body);
        assert.equal(r.status, 400);
    }
    const broken = await fetch(`${(await start(t)).base}/api/change`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(broken.status, 400);
    assert.equal(calls.change.length, 0);
});

test('every "no" from AD reads the same; policy and outages have their own message', async (t) => {
    const answers = { a: { outcome: 'invalid', reason: 'not_found' }, b: { outcome: 'invalid', reason: 'wrong current password' }, c: { outcome: 'invalid', reason: 'protected' }, d: { outcome: 'policy', reason: 'policy' }, e: { outcome: 'error', reason: 'Unable to contact the server' } };
    const { post, calls } = await start(t, { outcome: (args) => answers[args.account.value] });
    const msg = async (account) => { const r = await post({ ...good, account }); return [r.status, (await r.json()).message]; };
    const [sa, ma] = await msg('a');
    assert.deepEqual(await msg('b'), [sa, ma]);
    assert.deepEqual(await msg('c'), [sa, ma]);
    assert.equal(sa, 400);
    assert.match(ma, /帳號或目前密碼不正確/);
    const [sd, md] = await msg('d');
    assert.equal(sd, 400);
    assert.match(md, /密碼原則/);
    const [se, me] = await msg('e');
    assert.equal(se, 503);
    assert.doesNotMatch(me, /Unable to contact/, 'internal details stay in the audit log');
    assert.equal(calls.audit.find(x => x.account === 'e').reason, 'Unable to contact the server');
    assert.equal(calls.audit.find(x => x.account === 'c').reason, 'protected');
});

test('attempts are limited per account and per address', async (t) => {
    const { post, calls } = await start(t, { outcome: { outcome: 'invalid', reason: 'wrong current password' }, limits: { ip: 4, account: 2 } });
    assert.equal((await post(good)).status, 400);
    assert.equal((await post({ ...good, account: 'alice' })).status, 400);
    const r = await post(good);
    assert.equal(r.status, 429);
    assert.ok((await r.json()).retryAfter > 0);
    assert.equal((await post({ ...good, account: 'bob' })).status, 400);
    assert.equal((await post({ ...good, account: 'carol' })).status, 429, 'the address used up its attempts');
    assert.equal(calls.change.length, 3);
});

test('the AD call gets secrets only as environment variables, never in the script', async () => {
    let seen;
    const run = async (script, env) => { seen = { script, env }; return 'PWC_RESULT {"code":"FAIL","data":{"type":"Microsoft.ActiveDirectory.Management.ADPasswordComplexityException","message":"The password does not meet the length, complexity, or history requirement of the domain."}}'; };
    const r = await ad.changePassword(baseConfig(), { account: { kind: 'upn', value: 'alice@example.test' }, oldPassword: "Old'$(calc)", newPassword: 'New"`pass' }, run);
    assert.equal(r.outcome, 'policy');
    assert.equal(seen.env.PWC_OLD, "Old'$(calc)");
    assert.equal(seen.env.PWC_NEW, 'New"`pass');
    assert.equal(seen.env.PWC_SVC_PWD, 'svc-secret');
    assert.equal(seen.env.PWC_KIND, 'upn');
    assert.equal(seen.env.PWC_SCOPES, 'OU=Staff,DC=example,DC=test');
    for (const secret of ["Old'$(calc)", 'New"`pass', 'svc-secret', 'alice@example.test']) assert.ok(!seen.script.includes(secret));
    const failed = await ad.changePassword(baseConfig(), { account: { kind: 'sam', value: 'x' }, oldPassword: 'a', newPassword: 'b' }, async () => { throw new Error('powershell.exe not found'); });
    assert.deepEqual(failed, { outcome: 'error', reason: 'powershell.exe not found' });
});
