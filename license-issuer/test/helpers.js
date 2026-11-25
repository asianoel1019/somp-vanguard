// Test setup: temp folders, a throwaway Ed25519 key registered in the built-in KEYS, a cheap password hash, and an
// HTTP client that can set any header (Host, Origin, Cookie). Never touches a real key folder.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { KEYS } = require('../../backend/lib/licenseKeys');
const { hashPassword } = require('../src/auth');
const { createApp } = require('../src/app');
const { createAudit } = require('../src/audit');
const { checkStartup } = require('../src/startup');

const PASSWORD = 'Example-Pass-123';
const FAST = { N: 1024, r: 8, p: 1, keylen: 32 };
let hashCache = null;
const testHash = async () => (hashCache = hashCache || await hashPassword(PASSWORD, FAST));

/** Temp dir + key pair (public key registered as keyId, removed again after the test). */
function keyDir(t, keyId = `kli${crypto.randomBytes(3).toString('hex')}`) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-issuer-'));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const keyFile = path.join(dir, `${keyId}-private.pem`);
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    KEYS[keyId] = publicKey.export({ type: 'spki', format: 'pem' });
    t.after(() => { delete KEYS[keyId]; fs.rmSync(dir, { recursive: true, force: true }); });
    return { dir, keyId, keyFile, privateKey, pem: fs.readFileSync(keyFile, 'utf8') };
}

/** A config as readConfig would return it, inside the temp dir. */
async function makeConfig(k, overrides = {}) {
    return {
        host: '127.0.0.1', port: 0, keyFile: k.keyFile, keyId: k.keyId, issuedDir: path.join(k.dir, 'issued'),
        registryFile: path.join(k.dir, 'issued-licenses.md'), passwordHash: await testHash(), logDir: path.join(k.dir, 'logs'),
        errors: [], ...overrides,
    };
}

/** Starts the app on 127.0.0.1:<random port>. clock.ms moves the app's time. */
async function startApp(t, { overrides = {}, start = new Date(2026, 10, 25, 10, 0, 0) } = {}) {
    const k = keyDir(t);
    const config = await makeConfig(k, overrides);
    const startup = checkStartup(config);
    if (startup.errors.length) throw new Error(startup.errors.join('; '));
    const clock = { ms: start.getTime() };
    const audit = createAudit(config.logDir, { echo: false });
    const server = http.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    config.port = server.address().port;
    server.on('request', createApp({ config, privateKey: startup.privateKey, audit, now: () => new Date(clock.ms) }));
    t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
    const origin = `http://127.0.0.1:${config.port}`;
    const seen = []; // every response body, for the "no secrets" checks

    function request(method, urlPath, { body, headers = {}, cookie } = {}) {
        const h = { Host: `127.0.0.1:${config.port}`, ...headers };
        if (method !== 'GET' && !('Origin' in headers)) h.Origin = origin;
        for (const key of Object.keys(h)) if (h[key] === undefined) delete h[key];
        if (cookie) h.Cookie = cookie;
        const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        if (data) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = data.length; }
        return new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: config.port, method, path: urlPath, headers: h }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks);
                    const text = raw.toString('utf8');
                    seen.push(text);
                    let json = null;
                    try { json = JSON.parse(text); } catch { json = null; }
                    resolve({ status: res.statusCode, headers: res.headers, text, raw, json });
                });
            });
            req.on('error', reject);
            if (data) req.write(data);
            req.end();
        });
    }

    /** Signs in; returns a client whose calls carry the session cookie and CSRF token. */
    async function login(password = PASSWORD) {
        const r = await request('POST', '/api/login', { body: { password } });
        if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
        const cookie = String(r.headers['set-cookie'][0]).split(';')[0];
        const csrf = r.json.csrfToken;
        const call = (method, p, opts = {}) => request(method, p, {
            ...opts, cookie, headers: { ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrf }), ...(opts.headers || {}) },
        });
        return { cookie, csrf, loginResponse: r, call, issue: (body) => call('POST', '/api/issue', { body }) };
    }

    return { k, config, clock, request, login, origin, seen, auditText: () => (fs.existsSync(audit.file) ? fs.readFileSync(audit.file, 'utf8') : '') };
}

module.exports = { PASSWORD, FAST, testHash, keyDir, makeConfig, startApp };
