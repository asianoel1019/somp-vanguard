// The license issuer web app: one static page and a small JSON API, for the signing computer only (127.0.0.1).
const path = require('path');
const express = require('express');
const { KEYS } = require(path.join(__dirname, '..', '..', 'backend', 'lib', 'licenseKeys'));
const { verifyPassword, LoginGuard, Sessions, safeEqual } = require('./auth');
const { registryView, downloadTarget } = require('./registry');
const { openStore } = require('./store');
const { createMailer } = require('./mail');
const { createDigest } = require('./digest');
const { createApi } = require('./api');

const COOKIE = 'li_session';

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

/**
 * @param {object} o config (src/config readConfig), privateKey (KeyObject from src/startup), audit(event, details),
 *   store (src/store openStore; prepared by src/startup prepareStore — opened from config.dbFile when not given),
 *   keys (public keys, default the built-in ones), now() -> Date, idleMs, lockMs, maxFailures,
 *   mailer (src/mail createMailer; default from config.mail) or createTransport (nodemailer's; tests pass a fake),
 *   digestOptions (src/digest createDigest options, e.g. log). The weekly-digest timer is NOT started here:
 *   src/server.js calls app.locals.digest.start().
 */
function createApp({ config, privateKey, audit, store, keys = KEYS, now = () => new Date(), idleMs, lockMs, maxFailures, mailer, createTransport, digestOptions = {} }) {
    const nowMs = () => now().getTime();
    const db = store || openStore(config.dbFile, { registryFile: config.registryFile, now });
    // Vendor / Contact email form defaults (CONTACT_VENDOR / CONTACT_EMAIL in .env, checked by readConfig); '' when not set.
    const contactDefaults = () => {
        const d = config.contactDefaults || {};
        return { vendor: typeof d.vendor === 'string' ? d.vendor : '', email: typeof d.email === 'string' ? d.email : '' };
    };
    const today = () => localDate(now());
    const guard = new LoginGuard({ max: maxFailures, lockMs, now: nowMs });
    const sessions = new Sessions({ idleMs, now: nowMs });
    const hosts = () => [`127.0.0.1:${config.port}`, `localhost:${config.port}`];
    const origins = () => hosts().map((h) => `http://${h}`);
    let loginChain = Promise.resolve(); // one password check at a time, so parallel guesses cannot pass the limit

    const mail = mailer || createMailer(config.mail, createTransport ? { createTransport } : {});
    const digest = createDigest({ store: db, mailer: mail, audit, now, ...digestOptions });

    const app = express();
    app.locals.store = db;
    app.locals.mailer = mail;
    app.locals.digest = digest;
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
        res.json({
            csrfToken: req.session.csrf, today: today(), nextId: db.nextLicenseId(today().slice(0, 4)),
            keyId: config.keyId, issuedDir: config.issuedDir, registryFile: config.registryFile,
            contactDefaults: contactDefaults(), defaultCurrency: db.getSettings().defaultCurrency,
            mail: { enabled: mail.status().enabled, reason: mail.status().reason }, registry: db.registryStatus(),
        });
    });

    app.get('/api/registry', requireSession, (req, res) => {
        res.json({ today: today(), registryFile: config.registryFile, ...registryView(db, today()) });
    });

    app.get('/api/download/:licenseId', requireSession, (req, res) => {
        const id = String(req.params.licenseId || '');
        const t = downloadTarget(db, id, config.keyFile);
        if (!t.file) {
            audit('download-refused', { licenseId: id, reason: t.reason });
            return res.status(t.status).json({ error: t.reason });
        }
        audit('download', { licenseId: id, file: t.file });
        try { db.addEvent(id, 'downloaded', {}); } catch (e) { console.error('[license-issuer] Could not record the download:', e.message); }
        res.attachment(t.name);
        res.set('Content-Type', 'application/octet-stream');
        res.send(t.body);
    });

    // business features (src/api.js): issuing is POST /api/licenses (a sales person is required)
    app.use('/api', createApi({ config, store: db, audit, privateKey, keys, today, requireSession, mailer: mail, digest, contactDefaults }));

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
