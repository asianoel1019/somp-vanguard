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
const { checkStartup, prepareStore } = require('../src/startup');
const { openStore, issueLicense, replaceLicense } = require('../src/store');
const { readMailConfig } = require('../src/config');

const PASSWORD = 'Example-Pass-123';
const FAST = { N: 1024, r: 8, p: 1, keylen: 32 };
let hashCache = null;
const testHash = async () => (hashCache = hashCache || await hashPassword(PASSWORD, FAST));

/**
 * Temp dir + key pair (public key registered as keyId, removed again after the test). Stores opened in the dir must be
 * pushed onto k.closers: they are closed before the dir is removed (an open database file cannot be deleted on Windows).
 */
function keyDir(t, keyId = `kli${crypto.randomBytes(3).toString('hex')}`) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-issuer-'));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const keyFile = path.join(dir, `${keyId}-private.pem`);
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    KEYS[keyId] = publicKey.export({ type: 'spki', format: 'pem' });
    const closers = [];
    t.after(() => {
        delete KEYS[keyId];
        for (const close of closers) close();
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    });
    return { dir, keyId, keyFile, privateKey, pem: fs.readFileSync(keyFile, 'utf8'), closers };
}

/** A config as readConfig would return it, inside the temp dir. */
async function makeConfig(k, overrides = {}) {
    return {
        host: '127.0.0.1', port: 0, keyFile: k.keyFile, keyId: k.keyId, issuedDir: path.join(k.dir, 'issued'),
        registryFile: path.join(k.dir, 'issued-licenses.md'), dbFile: path.join(k.dir, 'license-issuer.db'), passwordHash: await testHash(),
        logDir: path.join(k.dir, 'logs'), errors: [], ...overrides,
    };
}

/** SMTP settings of the tests (example.test hosts; never a real server). */
const MAIL_ENV = {
    SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'issuer@example.test', SMTP_PASS: 'Example-Smtp-Secret-77',
    MAIL_FROM: 'SOMP License Issuer <issuer@example.test>', MAIL_ADMIN: 'admin@example.test',
};

/**
 * A fake nodemailer transport: sent[] holds every message; set .fail = 'text' to make sendMail reject with that message.
 * createTransport(options) records the options (options.auth.pass included: tests check it never leaks elsewhere).
 */
function fakeTransport() {
    const t = {
        sent: [], options: null, fail: null, created: 0,
        async sendMail(msg) {
            if (t.fail) throw new Error(t.fail);
            t.sent.push(msg);
            return { messageId: `<m${t.sent.length}@example.test>` };
        },
    };
    t.createTransport = (options) => { t.options = options; t.created += 1; return t; };
    return t;
}

/**
 * Starts the app on 127.0.0.1:<random port> with its database in the temp dir. clock.ms moves the app's time.
 * before(k, config): runs before the database is opened (e.g. to put a registry in place for the first-use import).
 */
async function startApp(t, { overrides = {}, start = new Date(2026, 10, 25, 10, 0, 0), before, mailEnv = null, transport = null, digestLog } = {}) {
    const k = keyDir(t);
    const config = await makeConfig(k, overrides);
    config.mail = readMailConfig(mailEnv || {});
    const startup = checkStartup(config);
    if (startup.errors.length) throw new Error(startup.errors.join('; '));
    const clock = { ms: start.getTime() };
    if (before) before(k, config);
    const prepared = prepareStore(config, { now: () => new Date(clock.ms) });
    if (prepared.errors.length) throw new Error(prepared.errors.join('; '));
    const store = prepared.store;
    k.closers.push(() => store.close());
    const audit = createAudit(config.logDir, { echo: false });
    const server = http.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    config.port = server.address().port;
    const app = createApp({
        config, privateKey: startup.privateKey, audit, store, now: () => new Date(clock.ms),
        ...(transport ? { createTransport: transport.createTransport } : {}),
        digestOptions: { log: digestLog || { warn() {}, error() {} } },
    });
    server.on('request', app);
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
        let salesId = null;
        /**
         * Issues over POST /api/licenses. Shortcut: `customer` (a name) becomes the existing customer's customerId or a
         * newCustomer; salesId defaults to a sales person "Example Sales" created on first use (give salesId to override).
         */
        async function issue(body) {
            const b = { ...body };
            if ('customer' in b) {
                const found = typeof b.customer === 'string' && b.customer.trim() ? store.findCustomerByName(b.customer.trim()) : null;
                if (found) b.customerId = found.id; else b.newCustomer = { name: b.customer };
                delete b.customer;
            }
            if (!('salesId' in b)) {
                if (!salesId) {
                    const existing = store.findSalesByName('Example Sales');
                    salesId = existing ? existing.id : store.createSales({ name: 'Example Sales', email: 'example-sales@example.test' }).id;
                }
                b.salesId = salesId;
            }
            return call('POST', '/api/licenses', { body: b });
        }
        return { cookie, csrf, loginResponse: r, call, issue };
    }

    return {
        k, config, clock, store, imported: prepared.imported, request, login, origin, seen, app, digest: app.locals.digest,
        auditText: () => (fs.existsSync(audit.file) ? fs.readFileSync(audit.file, 'utf8') : ''),
    };
}

/**
 * A store in a temp dir with a throwaway trusted key and an "issued" folder. clock.ms moves the store's time.
 * before(k, registryFile): runs before the database is opened. registry: false = no registry copy.
 * issue(o) / replace(o): the store's issueLicense / replaceLicense with the key and the issued folder filled in.
 */
function tempStore(t, { start = new Date(2026, 10, 25, 10, 0, 0), registry = true, before } = {}) {
    const k = keyDir(t);
    const clock = { ms: start.getTime() };
    const reg = path.join(k.dir, 'issued-licenses.md');
    const issuedDir = path.join(k.dir, 'issued');
    fs.mkdirSync(issuedDir);
    if (before) before(k, reg);
    const store = openStore(path.join(k.dir, 'license-issuer.db'), { registryFile: registry ? reg : null, now: () => new Date(clock.ms) });
    k.closers.push(() => store.close());
    const base = { key: k.privateKey, keyFile: k.keyFile, keyId: k.keyId, issuedDir };
    return {
        k, store, reg, clock, issuedDir,
        issue: (o) => issueLicense(store, { ...base, ...o }),
        replace: (o) => replaceLicense(store, { ...base, ...o }),
    };
}

module.exports = { PASSWORD, FAST, MAIL_ENV, testHash, keyDir, makeConfig, startApp, tempStore, fakeTransport };
