// iControl REST sessions of F5 BIG-IP devices: one login token per device and account, kept in memory only (never
// written anywhere, never put into a message). A token is reused until a minute before it expires; concurrent
// requests share one login; a request answered 401 logs in again once and is retried once.
const crypto = require('crypto');
const { createClient } = require('./httpClient');
const { netError } = require('./errors');

const REFRESH_MS = 60 * 1000;
const DEFAULT_TIMEOUT_S = 1200;

const tokens = new Map(); // key -> { token, expiresAt }
const logins = new Map(); // key -> Promise<{ token, expiresAt }>

const target = (profile) => `${profile.mgmtHost}:${profile.port}`;
const passwordOf = (profile) => (profile.secrets && profile.secrets.password) || '';

/** Cache key: the device, the account and its password (a new password never reuses an old token). */
function keyOf(profile) {
    const pw = crypto.createHash('sha256').update(passwordOf(profile)).digest('hex').slice(0, 16);
    return `${target(profile)}|${profile.username}|${profile.loginProvider || 'tmos'}|${pw}`;
}

function client(profile, headers, secrets) {
    return createClient({ host: profile.mgmtHost, port: profile.port, tlsVerify: profile.tlsVerify, caCert: profile.caCert, headers, secrets });
}

async function login(profile) {
    const username = profile.username || '';
    const password = passwordOf(profile);
    if (!username || !password) throw netError('NOT_CONFIGURED', 'No user name / password stored for this device');
    let data;
    try {
        data = await client(profile, { 'Content-Type': 'application/json' }, [password]).request({
            method: 'POST',
            path: '/mgmt/shared/authn/login',
            data: { username, password, loginProviderName: profile.loginProvider || 'tmos' },
        });
    } catch (err) {
        if (err.code === 'AUTH') throw netError('AUTH', 'The device rejected the user name / password (401)');
        // BIG-IP answers 400 to a login it refuses for another reason: an unknown login provider, or the account
        // already holds the most tokens it may have
        if (err.code === 'OTHER' && /HTTP 400/.test(err.message)) {
            throw netError('AUTH', 'The device refused the login (400): check the user name, password and login provider, or wait for older tokens of this account to expire');
        }
        if (err.code === 'UNSUPPORTED') throw netError('UNSUPPORTED', 'The device has no iControl REST login (is this a BIG-IP management address?)');
        throw err;
    }
    const t = data && data.token;
    if (!t || !t.token) throw netError('OTHER', 'The device did not return a login token');
    const timeout = Number(t.timeout) > 0 ? Number(t.timeout) : DEFAULT_TIMEOUT_S;
    return { token: String(t.token), expiresAt: Date.now() + timeout * 1000 };
}

/** A cached token, or a new one (one login at a time per key). */
function cachedToken(profile) {
    const key = keyOf(profile);
    const hit = tokens.get(key);
    if (hit && hit.expiresAt - Date.now() > REFRESH_MS) return Promise.resolve(hit);
    if (logins.has(key)) return logins.get(key);
    const p = login(profile)
        .then((t) => { tokens.set(key, t); return t; })
        .finally(() => logins.delete(key));
    logins.set(key, p);
    return p;
}

/**
 * A session for one device. `cache: false` (a connection test with unsaved values) logs in on its own and keeps
 * the token only for this session.
 * @returns {{ request: (opts: { method?, path, params?, data? }) => Promise<any> }}
 */
function open(profile, { cache = true } = {}) {
    let own = null;
    const getToken = async () => {
        if (cache) return cachedToken(profile);
        if (!own) own = await login(profile);
        return own;
    };
    const drop = (t) => {
        if (!cache) { own = null; return; }
        const key = keyOf(profile);
        if (tokens.get(key) === t) tokens.delete(key);
    };
    async function send(t, opts) {
        return client(profile, { 'X-F5-Auth-Token': t.token }, [passwordOf(profile), t.token]).request(opts);
    }
    return {
        async request(opts) {
            const t = await getToken();
            try {
                return await send(t, opts);
            } catch (err) {
                if (err.code !== 'AUTH') throw err;
                // the token expired or was revoked on the device: one new login, one retry
                drop(t);
                const t2 = await getToken();
                try {
                    return await send(t2, opts);
                } catch (err2) {
                    if (err2.code === 'AUTH') drop(t2);
                    throw err2;
                }
            }
        },
    };
}

/** Forget the tokens of a device (its connection was saved or removed). */
function forget(profile) {
    if (!profile || !profile.mgmtHost) return;
    const prefix = `${target(profile)}|`;
    for (const k of tokens.keys()) if (k.startsWith(prefix)) tokens.delete(k);
}

/** Test hook: drop every token. */
function _reset() { tokens.clear(); logins.clear(); }
const _size = () => tokens.size;

module.exports = { open, forget, REFRESH_MS, _reset, _size };
