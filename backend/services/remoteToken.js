// Web Remote (Guacamole) session tokens.
// - AES-256-GCM: the token is encrypted and authenticated, so a changed token is rejected instead of decrypted.
// - The key is derived from JWT_SECRET with HKDF under its own label (never the JWT signing key itself); without
//   JWT_SECRET no token is issued or accepted.
// - Each token expires TOKEN_TTL_MS after it is issued and can be used once: a token seen in a log or a copied URL
//   cannot open another session. Used ids are remembered in memory until they expire (one backend process).
const crypto = require('crypto');

const TOKEN_TTL_MS = 30 * 1000;
const KEY_LABEL = 'somp-vanguard/web-remote-token/v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

class RemoteTokenError extends Error {
    constructor(message, status = 401) { super(message); this.status = status; this.userSafe = true; }
}

function tokenKey(secret = process.env.JWT_SECRET) {
    if (!secret) throw new RemoteTokenError('JWT_SECRET is not set: Web Remote is disabled', 503);
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret)), Buffer.alloc(0), Buffer.from(KEY_LABEL), 32));
}

const used = new Map(); // jti -> expiry (ms)
function forgetExpired(now) {
    for (const [jti, exp] of used) if (exp <= now) used.delete(jti);
}

/**
 * Token for one session. payload: { connection, audit } (anything JSON); exp and jti are added here.
 * @returns {{ token: string, expiresAt: number, jti: string }}
 */
function issueToken(payload, { now = Date.now(), ttlMs = TOKEN_TTL_MS, secret } = {}) {
    const key = tokenKey(secret);
    const jti = crypto.randomBytes(16).toString('hex');
    const expiresAt = now + ttlMs;
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify({ ...payload, exp: expiresAt, jti }), 'utf8'), cipher.final()]);
    const token = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    return { token, expiresAt, jti };
}

/**
 * The payload of a valid, unexpired, unused token; the token is used up by this call.
 * Throws RemoteTokenError (401) for anything else, without saying which check failed.
 */
function consumeToken(token, { now = Date.now(), secret } = {}) {
    const key = tokenKey(secret);
    let payload;
    try {
        const raw = Buffer.from(String(token || ''), 'base64url');
        if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('short');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
        decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        const json = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
        payload = JSON.parse(json);
    } catch {
        throw new RemoteTokenError('Invalid remote session token');
    }
    forgetExpired(now);
    if (!payload || typeof payload !== 'object' || typeof payload.jti !== 'string' || !Number.isFinite(payload.exp)) {
        throw new RemoteTokenError('Invalid remote session token');
    }
    if (payload.exp <= now) throw new RemoteTokenError('The remote session token has expired; connect again');
    if (used.has(payload.jti)) throw new RemoteTokenError('The remote session token was already used; connect again');
    used.set(payload.jti, payload.exp);
    return payload;
}

module.exports = { issueToken, consumeToken, tokenKey, RemoteTokenError, TOKEN_TTL_MS, _used: used };
