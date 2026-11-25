// Password (scrypt), login lockout and sessions. Everything is in memory: one process on the signing computer.
const crypto = require('crypto');

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };
const MAXMEM = 128 * 1024 * 1024;
const MIN_PASSWORD = 10;

/** "scrypt$N$r$p$salt$hash" (base64) -> parts, or null when the text is not such a hash. */
function parseHash(text) {
    const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(text || '').trim());
    if (!m) return null;
    const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const salt = Buffer.from(m[4], 'base64');
    const hash = Buffer.from(m[5], 'base64');
    // N a power of two; bounds keep a hand-edited hash from asking for absurd memory or time
    if (N < 1024 || N > 1048576 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
    if (salt.length < 16 || hash.length < 16 || 128 * N * r > MAXMEM) return null;
    return { N, r, p, salt, hash };
}

function scrypt(password, salt, keylen, opts) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(String(password), salt, keylen, { ...opts, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
    });
}

async function hashPassword(password, params = SCRYPT) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p });
    return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Timing-safe check of a password against a stored hash; false for a malformed hash. */
async function verifyPassword(password, stored) {
    const h = parseHash(stored);
    if (!h || typeof password !== 'string') return false;
    const key = await scrypt(password, h.salt, h.hash.length, { N: h.N, r: h.r, p: h.p });
    return crypto.timingSafeEqual(key, h.hash);
}

/** Consecutive failed logins: after `max` failures every login is refused for lockMs (whatever the password). */
class LoginGuard {
    constructor({ max = 5, lockMs = 15 * 60 * 1000, now = Date.now } = {}) {
        Object.assign(this, { max, lockMs, now, failures: 0, lockedUntil: 0 });
    }

    /** { locked, lockedUntil (ms, 0 when not locked), remaining attempts } */
    state() {
        if (this.lockedUntil && this.now() >= this.lockedUntil) { this.failures = 0; this.lockedUntil = 0; }
        return { locked: this.lockedUntil > 0, lockedUntil: this.lockedUntil, remaining: Math.max(0, this.max - this.failures) };
    }

    fail() {
        this.state();
        this.failures += 1;
        if (this.failures >= this.max) this.lockedUntil = this.now() + this.lockMs;
        return this.state();
    }

    success() { this.failures = 0; this.lockedUntil = 0; }
}

/** Session tokens (cookie) with a CSRF token each; idle sessions end after idleMs. */
class Sessions {
    constructor({ idleMs = 30 * 60 * 1000, max = 20, now = Date.now } = {}) {
        Object.assign(this, { idleMs, max, now, map: new Map() });
    }

    create() {
        const token = crypto.randomBytes(32).toString('hex');
        const s = { token, csrf: crypto.randomBytes(32).toString('hex'), lastSeen: this.now() };
        this.map.set(token, s);
        while (this.map.size > this.max) this.map.delete(this.map.keys().next().value); // oldest first
        return s;
    }

    /** The live session for a token (its idle timer restarts), or null. */
    get(token) {
        if (typeof token !== 'string' || !token) return null;
        const s = this.map.get(token);
        if (!s) return null;
        if (this.now() - s.lastSeen > this.idleMs) { this.map.delete(token); return null; }
        s.lastSeen = this.now();
        return s;
    }

    destroy(token) { this.map.delete(token); }
}

/** Constant-time string comparison (false for different lengths or non-strings). */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { SCRYPT, MIN_PASSWORD, parseHash, hashPassword, verifyPassword, LoginGuard, Sessions, safeEqual };
