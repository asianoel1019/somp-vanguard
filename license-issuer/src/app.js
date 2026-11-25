// The license issuer web app: one static page and a small JSON API, for the signing computer only (127.0.0.1).
const path = require('path');
const express = require('express');
const core = require(path.join(__dirname, '..', '..', 'scripts', 'licenseIssuerCore'));
const { KEYS } = require(path.join(__dirname, '..', '..', 'backend', 'lib', 'licenseKeys'));
const { verifyPassword, LoginGuard, Sessions, safeEqual } = require('./auth');
const { registryView, slugify, downloadTarget } = require('./registry');

const COOKIE = 'li_session';
const CUSTOMER_MAX = 200;

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
}

const FIELD_ERRORS = {
    'id-format': ['licenseId', 'License ID must look like L-YYYY-NNNN.'],
    'issued-date': ['issuedAt', 'Issued must be a real date (YYYY-MM-DD).'],
    'expires-date': ['expiresAt', 'Expires must be a real date (YYYY-MM-DD).'],
    'expires-past': ['expiresAt', 'Expires is in the past.'],
    'expires-before-issued': ['expiresAt', 'Expires is before Issued.'],
};

/**
 * @param {object} o config (src/config readConfig), privateKey (KeyObject from src/startup), audit(event, details),
 *   keys (public keys, default the built-in ones), now() -> Date, idleMs, lockMs, maxFailures
 */
function createApp({ config, privateKey, audit, keys = KEYS, now = () => new Date(), idleMs, lockMs, maxFailures }) {
    const nowMs = () => now().getTime();
    const today = () => localDate(now());
    const guard = new LoginGuard({ max: maxFailures, lockMs, now: nowMs });
    const sessions = new Sessions({ idleMs, now: nowMs });
    const hosts = () => [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
    const origins = () => hosts().map((h) => `http://${h}`);
    let loginChain = Promise.resolve(); // one password check at a time, so parallel guesses cannot pass the limit

    const app = express();
    app.disable('x-powered-by');
    app.set('etag', false);

    app.use((req, res, next) => {
        res.set({
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Cache-Control': 'no-store',
        });
        next();
    });

    // DNS rebinding: only our own host names are answered
    app.use((req, res, next) => {
        const host = String(req.headers.host || '').toLowerCase();
        if (hosts().includes(host)) return next();
        res.status(421).type('text/plain; charset=utf-8').send('Misdirected request: open http://127.0.0.1:' + config.port + '/');
    });

    // state-changing requests only from our own page
    app.use((req, res, next) => {
        if (req.method === 'GET' || req.method === 'HEAD') return next();
        if (origins().includes(String(req.headers.origin || ''))) return next();
        res.status(403).json({ error: 'Request refused: wrong or missing Origin.' });
    });

    app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0, etag: false }));

    const sessionOf = (req) => sessions.get(parseCookies(req.headers.cookie)[COOKIE]);
    const lockInfo = () => {
        const s = guard.state();
        return { locked: s.locked, remaining: s.remaining, lockedUntil: s.locked ? new Date(s.lockedUntil).toISOString() : null,
            retryAfter: s.locked ? Math.ceil((s.lockedUntil - nowMs()) / 1000) : 0 };
    };
    function requireSession(req, res, next) {
        const s = sessionOf(req);
        if (!s) return res.status(401).json({ error: 'Not signed in (or the session expired).', ...lockInfo() });
        if (req.method !== 'GET' && req.method !== 'HEAD' && !safeEqual(String(req.headers['x-csrf-token'] || ''), s.csrf)) {
            return res.status(403).json({ error: 'Request refused: missing or wrong CSRF token. Reload the page.' });
        }
        req.session = s;
        next();
    }
    const json = express.json({ limit: '8kb' });

    app.post('/api/login', json, (req, res, next) => {
        const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
        loginChain = loginChain.then(async () => {
            let info = lockInfo();
            if (info.locked) {
                audit('login-locked', { reason: `locked until ${info.lockedUntil}` });
                return res.status(429).json({ error: 'Too many wrong passwords. Sign-in is locked.', ...info });
            }
            const ok = password.length > 0 && password.length <= 1024 && await verifyPassword(password, config.passwordHash);
            if (!ok) {
                guard.fail();
                info = lockInfo();
                audit('login-fail', { reason: `${info.remaining} attempt(s) left` });
                if (info.locked) {
                    audit('login-locked', { reason: `locked until ${info.lockedUntil}` });
                    return res.status(429).json({ error: 'Too many wrong passwords. Sign-in is locked.', ...info });
                }
                return res.status(401).json({ error: 'Wrong password.', ...info });
            }
            guard.success();
            const old = parseCookies(req.headers.cookie)[COOKIE];
            if (old) sessions.destroy(old);
            const s = sessions.create();
            audit('login-ok');
            res.set('Set-Cookie', `${COOKIE}=${s.token}; HttpOnly; SameSite=Strict; Path=/`);
            res.json({ ok: true, csrfToken: s.csrf });
        }).catch(next);
    });

    app.post('/api/logout', requireSession, (req, res) => {
        sessions.destroy(req.session.token);
        audit('logout');
        res.set('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        res.json({ ok: true });
    });

    app.get('/api/session', requireSession, (req, res) => {
        const view = registryView(config.registryFile, today());
        res.json({
            csrfToken: req.session.csrf, today: today(), nextId: view.nextId || core.nextLicenseId('', today().slice(0, 4)),
            keyId: config.keyId, issuedDir: config.issuedDir, registryFile: config.registryFile,
        });
    });

    app.get('/api/registry', requireSession, (req, res) => {
        const view = registryView(config.registryFile, today());
        if (view.error) return res.status(500).json({ error: view.error });
        res.json({ today: today(), registryFile: config.registryFile, ...view });
    });

    app.post('/api/issue', requireSession, json, (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const str = (v) => (typeof v === 'string' ? v.trim() : '');
        const customer = str(b.customer);
        const licenseId = str(b.licenseId);
        const issuedAt = str(b.issuedAt);
        const expiresAt = str(b.expiresAt);
        const refuse = (status, error, extra = {}) => {
            audit('issue-refused', { licenseId, customer, reason: error });
            res.status(status).json({ error, ...extra });
        };
        if (!customer) return refuse(400, 'Customer is required.', { field: 'customer' });
        if (customer.length > CUSTOMER_MAX) return refuse(400, `Customer is longer than ${CUSTOMER_MAX} characters.`, { field: 'customer' });
        if (/[\x00-\x1f\x7f]/.test(customer)) return refuse(400, 'Customer must not contain control characters.', { field: 'customer' });
        const day = today();
        const bad = core.validateIssueFields({ licenseId, issuedAt, expiresAt }, day);
        if (bad) return refuse(400, FIELD_ERRORS[bad][1], { field: FIELD_ERRORS[bad][0] });

        const out = path.join(config.issuedDir, `${licenseId}-${slugify(customer)}.lic`);
        const r = core.issueLicense({
            key: privateKey, keyFile: config.keyFile, keyId: config.keyId, customer, licenseId, issuedAt, expiresAt,
            out, registry: config.registryFile, allowDuplicate: false, overwrite: false, keys, onDate: day,
        });
        if (!r.ok) {
            const why = r.error ? ` (${r.error.code || r.error.message})` : '';
            switch (r.code) {
                case 'duplicate-id': return refuse(409, `License ID ${licenseId} is already in the registry. Next free ID: ${r.next}.`, { field: 'licenseId', nextId: r.next });
                case 'out-exists': return refuse(409, `The file ${out} already exists. Nothing was written.`);
                case 'registry-locked': return refuse(503, 'The registry is in use by another writer. Try again in a moment.');
                case 'registry-unreadable': return refuse(500, `Cannot read the registry${why}. Nothing was written.`);
                case 'rejected': return refuse(500, `Not written: the product would reject this license (${r.reason}).`);
                default: return refuse(500, `Not written (${r.code})${why}.`);
            }
        }
        const nextId = core.nextLicenseId(r.registryError ? `${r.registryText || ''}\n${r.row}` : r.registryText, day.slice(0, 4));
        audit('issue', { licenseId, customer, issuedAt, expiresAt, file: r.outAbs, reason: r.registryError ? 'registry not updated' : '' });
        const body = {
            ok: true, licenseId, customer, issuedAt, expiresAt, days: core.daysBetween(day, expiresAt), file: r.outAbs,
            fileName: path.basename(r.outAbs), sha256: r.sha256, registryFile: config.registryFile, nextId,
        };
        if (r.registryError) {
            body.registryError = `The license was written but the registry was not updated (${r.registryError.code || r.registryError.message}). Add this row to the registry by hand.`;
            body.row = r.row;
        }
        res.json(body);
    });

    app.get('/api/download/:licenseId', requireSession, (req, res) => {
        const id = String(req.params.licenseId || '');
        const t = downloadTarget(config.registryFile, id, config.keyFile);
        if (!t.file) {
            audit('download-refused', { licenseId: id, reason: t.reason });
            return res.status(t.status).json({ error: t.reason });
        }
        audit('download', { licenseId: id, file: t.file });
        res.attachment(t.name);
        res.set('Content-Type', 'application/octet-stream');
        res.send(t.body);
    });

    app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
    app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('Not found'));
    // malformed JSON and other request errors: no stack traces
    app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
        const status = err.status && err.status < 500 ? err.status : 500;
        if (status === 500) console.error('[license-issuer] Error:', err.message);
        if (!res.headersSent) res.status(status).json({ error: status === 500 ? 'Internal error' : 'Bad request' });
    });
    return app;
}

module.exports = { createApp, COOKIE, parseCookies, localDate };
