// Sign-in, sessions, Host / Origin / CSRF checks, headers, audit log and secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, PASSWORD } = require('./helpers');

const ISSUE = { customer: 'Example Corp.', licenseId: 'L-2026-0001', issuedAt: '2026-11-25', expiresAt: '2027-11-24' };

test('the API answers 401 without a session; the page itself is public with strict headers', async (t) => {
    const app = await startApp(t);
    for (const [method, p] of [['GET', '/api/session'], ['GET', '/api/registry'], ['GET', '/api/download/L-2026-0001'],
        ['POST', '/api/issue'], ['POST', '/api/logout']]) {
        const r = await app.request(method, p, { body: method === 'POST' ? ISSUE : undefined });
        assert.equal(r.status, 401, `${method} ${p}`);
    }
    const page = await app.request('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /SOMP License Issuer/);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-powered-by'], undefined);
    const s = await app.request('GET', '/api/session');
    assert.equal(s.headers['cache-control'], 'no-store');
});

test('login sets an HttpOnly SameSite=Strict cookie; session gives the CSRF token and next ID; logout ends it', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    const setCookie = c.loginResponse.headers['set-cookie'][0];
    assert.match(setCookie, /^li_session=[0-9a-f]{64}; /);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    const s = await c.call('GET', '/api/session');
    assert.equal(s.status, 200);
    assert.equal(s.json.csrfToken, c.csrf);
    assert.equal(s.json.nextId, 'L-2026-0001');
    assert.equal(s.json.today, '2026-11-25');
    const out = await c.call('POST', '/api/logout');
    assert.equal(out.status, 200);
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
    assert.equal((await c.call('GET', '/api/session')).status, 401);
});

test('five wrong passwords lock sign-in for 15 minutes, even for the right password', async (t) => {
    const app = await startApp(t);
    for (let i = 1; i <= 4; i++) {
        const r = await app.request('POST', '/api/login', { body: { password: `wrong-${i}` } });
        assert.equal(r.status, 401);
        assert.equal(r.json.remaining, 5 - i);
        assert.equal(r.json.locked, false);
    }
    const fifth = await app.request('POST', '/api/login', { body: { password: 'wrong-5' } });
    assert.equal(fifth.status, 429);
    assert.equal(fifth.json.locked, true);
    assert.equal(fifth.json.lockedUntil, new Date(app.clock.ms + 15 * 60 * 1000).toISOString());
    const right = await app.request('POST', '/api/login', { body: { password: PASSWORD } });
    assert.equal(right.status, 429);
    assert.equal(right.headers['set-cookie'], undefined);
    // the login page can show the lock before trying
    const s = await app.request('GET', '/api/session');
    assert.equal(s.status, 401);
    assert.equal(s.json.locked, true);
    app.clock.ms += 14 * 60 * 1000;
    assert.equal((await app.request('POST', '/api/login', { body: { password: PASSWORD } })).status, 429);
    app.clock.ms += 61 * 1000;
    await app.login();
    const audit = app.auditText();
    assert.equal((audit.match(/"event":"login-fail"/g) || []).length, 5);
    assert.match(audit, /"event":"login-locked"/);
    assert.match(audit, /"event":"login-ok"/);
});

test('a successful login resets the failure count', async (t) => {
    const app = await startApp(t);
    for (let i = 0; i < 4; i++) await app.request('POST', '/api/login', { body: { password: 'nope-nope-nope' } });
    await app.login();
    const r = await app.request('POST', '/api/login', { body: { password: 'nope-nope-nope' } });
    assert.equal(r.json.remaining, 4);
});

test('Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding)', async (t) => {
    const app = await startApp(t);
    const port = app.config.port;
    for (const host of ['evil.example.test', `evil.example.test:${port}`, `127.0.0.1:${port + 1}`, `127.0.0.1`, `[::1]:${port}`, `127.0.0.1:${port}.evil.example.test`]) {
        const r = await app.request('GET', '/', { headers: { Host: host } });
        assert.equal(r.status, 421, `host "${host}"`);
        const api = await app.request('POST', '/api/login', { headers: { Host: host }, body: { password: PASSWORD } });
        assert.equal(api.status, 421, `login via host "${host}"`);
    }
    // no Host header at all (HTTP/1.0)
    const raw = await new Promise((resolve, reject) => {
        const sock = require('net').connect(port, '127.0.0.1', () => sock.end('GET / HTTP/1.0\r\n\r\n'));
        let text = '';
        sock.on('data', (d) => { text += d; });
        sock.on('end', () => resolve(text));
        sock.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1\.1 421 /);
    assert.equal((await app.request('GET', '/', { headers: { Host: `localhost:${port}` } })).status, 200);
    assert.equal((await app.request('GET', '/', { headers: { Host: `LOCALHOST:${port}` } })).status, 200);
});

test('state-changing requests need our Origin and the session CSRF token', async (t) => {
    const app = await startApp(t);
    const port = app.config.port;
    // login: Origin required
    assert.equal((await app.request('POST', '/api/login', { body: { password: PASSWORD }, headers: { Origin: undefined } })).status, 403);
    assert.equal((await app.request('POST', '/api/login', { body: { password: PASSWORD }, headers: { Origin: 'http://evil.example.test' } })).status, 403);
    assert.equal((await app.request('POST', '/api/login', { body: { password: PASSWORD }, headers: { Origin: `https://127.0.0.1:${port}` } })).status, 403);
    const c = await app.login();
    const issue = (headers) => c.call('POST', '/api/issue', { body: ISSUE, headers });
    assert.equal((await issue({ Origin: undefined })).status, 403);
    assert.equal((await issue({ Origin: 'null' })).status, 403);
    assert.equal((await issue({ Origin: `http://127.0.0.1:${port + 1}` })).status, 403);
    assert.equal((await issue({ 'X-CSRF-Token': undefined })).status, 403);
    assert.equal((await issue({ 'X-CSRF-Token': 'a'.repeat(64) })).status, 403);
    // another session's token does not work either
    const other = await app.login();
    assert.equal((await issue({ 'X-CSRF-Token': other.csrf })).status, 403);
    const ok = await issue({ Origin: `http://localhost:${port}`, Host: `localhost:${port}` });
    assert.equal(ok.status, 200, ok.text);
    // logout needs the token too
    assert.equal((await c.call('POST', '/api/logout', { headers: { 'X-CSRF-Token': undefined } })).status, 403);
});

test('a session ends after 30 idle minutes; activity keeps it alive', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    app.clock.ms += 29 * 60 * 1000;
    assert.equal((await c.call('GET', '/api/session')).status, 200);
    app.clock.ms += 29 * 60 * 1000;
    assert.equal((await c.call('GET', '/api/registry')).status, 200);
    app.clock.ms += 30 * 60 * 1000 + 1000;
    assert.equal((await c.call('GET', '/api/session')).status, 401);
    assert.equal((await c.issue(ISSUE)).status, 401);
});

test('malformed JSON and unknown routes answer without stack traces', async (t) => {
    const app = await startApp(t);
    const r = await app.request('POST', '/api/login', { body: '{"password":' });
    assert.equal(r.status, 400);
    assert.doesNotMatch(r.text, /at .*\.js/);
    assert.equal((await app.request('GET', '/api/nope')).status, 404);
});

test('no password, hash, token or key material in responses or in the audit log', async (t) => {
    const app = await startApp(t);
    await app.request('POST', '/api/login', { body: { password: 'Wrong-Guess-999' } });
    const c = await app.login();
    await c.call('GET', '/api/session');
    const issued = await c.issue(ISSUE);
    assert.equal(issued.status, 200);
    await c.call('GET', '/api/registry');
    await c.call('GET', `/api/download/${ISSUE.licenseId}`);
    await c.call('POST', '/api/logout');
    const keyBody = app.k.pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const secrets = [PASSWORD, 'Wrong-Guess-999', app.config.passwordHash, app.config.passwordHash.split('$').pop(), keyBody, keyBody.slice(-20), c.cookie.split('=')[1]];
    const audit = app.auditText();
    assert.match(audit, /"event":"issue"/);
    assert.match(audit, /"event":"download"/);
    assert.match(audit, /"event":"logout"/);
    for (const s of secrets) {
        assert.ok(!audit.includes(s), 'audit log contains a secret');
        assert.ok(!app.seen.some((body) => body.includes(s)), 'a response contains a secret');
    }
    // every audit line is JSON with a known event
    for (const line of audit.trim().split('\n')) {
        const e = JSON.parse(line);
        assert.match(e.event, /^(login-ok|login-fail|login-locked|logout|issue|issue-refused|download|download-refused)$/);
    }
});
