// NAS device store helpers: validation, password encryption (explicit marker), one-time migration,
// public (secret-free) view, and a single in-process write chain for service_platform/nas_config.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readDataSync, writeDataSync } = require('../lib/db');
const { encryptText, decryptText } = require('../lib/crypto');

const CONFIG_PATH = 'service_platform/nas_config.json';
const OLD_CONFIG_PATH = 'network_service/nas/config.json';
const SUPPORTED_TYPES = ['synology', 'qnap', 'windows', 'linux'];

class NasValidationError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

// Passwords are stored encrypted with the persistent system key (lib/crypto encryptText/decryptText),
// marked with passwordEnc: 'v2'. JWT_SECRET rotation does not affect them.
const ENC_VERSION = 'v2';

function encryptForStorage(plain) { return encryptText(plain); }

// Marks a record with a freshly encrypted password (clears any reset flag).
function applyPassword(dev, plain) {
    dev.password = encryptForStorage(plain);
    dev.passwordEnc = ENC_VERSION;
    delete dev.passwordNeedsReset;
}

// Legacy ciphertext (lib/crypto encryptPassword): iv(32 hex):salt(32 hex):ct, or the older iv:ct with salt 'salt'.
const CIPHER_RE = /^[0-9a-f]{32}:([0-9a-f]{32}:)?[0-9a-f]+$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// Decrypts a legacy value with one secret. Returns a string only when the result is valid UTF-8 without control characters.
function legacyDecrypt(value, secret) {
    try {
        const parts = value.split(':');
        const iv = Buffer.from(parts[0], 'hex');
        const salt = parts.length === 3 ? parts[1] : 'salt';
        const encrypted = parts[parts.length - 1];
        const key = crypto.scryptSync(secret, salt, 32);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        const buf = Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
        if (!text || CONTROL_CHARS.test(text)) return null;
        return text;
    } catch (e) {
        return null;
    }
}

function legacySecrets() {
    const list = [process.env.JWT_SECRET || 'fallback-secret-123'];
    if (process.env.NAS_ENCRYPTION_KEY) list.push(process.env.NAS_ENCRYPTION_KEY);
    return list;
}

// v2 values already verified decryptable in this process (avoids a scrypt per record on every read)
const verifiedV2 = new Set();
function v2Decryptable(value) {
    if (verifiedV2.has(value)) return true;
    try {
        if (decryptText(value) === '') return false;
        verifiedV2.add(value);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Idempotent migration:
 *  - v2 and decryptable with the system key -> keep (not decryptable -> passwordNeedsReset)
 *  - legacy ciphertext that decrypts (JWT_SECRET / NAS_ENCRYPTION_KEY, valid UTF-8) -> re-encrypt with the system key
 *  - not in any ciphertext format -> plaintext, encrypt
 *  - ciphertext format that nothing decrypts -> unchanged + passwordNeedsReset (never double-encrypted)
 * Returns { devices, changed, needsReset } (counts only).
 */
function migrateDevices(devices) {
    let changed = 0;
    let needsReset = 0;
    const out = devices.map(d => {
        if (!d || typeof d !== 'object') return d;
        if (typeof d.password !== 'string' || d.password === '') return d;
        if (d.passwordEnc === ENC_VERSION) {
            if (d.passwordNeedsReset || v2Decryptable(d.password)) return d;
            changed++; needsReset++;
            return { ...d, passwordNeedsReset: true };
        }
        if (!CIPHER_RE.test(d.password)) {
            const n = { ...d };
            applyPassword(n, d.password);
            changed++;
            return n;
        }
        for (const secret of legacySecrets()) {
            const plain = legacyDecrypt(d.password, secret);
            if (plain !== null) {
                const n = { ...d };
                applyPassword(n, plain);
                changed++;
                return n;
            }
        }
        if (d.passwordNeedsReset) return d;
        changed++; needsReset++;
        return { ...d, passwordNeedsReset: true };
    });
    return { devices: out, changed, needsReset };
}

function publicDevice(d) {
    const { password, passwordEnc, passwordEncrypted, passwordNeedsReset, ...rest } = d;
    return { ...rest, hasPassword: !!password && !passwordNeedsReset, passwordNeedsReset: !!passwordNeedsReset };
}

/** Decrypted stored password for test-connection reuse; null when unusable. */
function readStoredPassword(d) {
    if (!d || !d.password) return '';
    if (d.passwordNeedsReset) return null;
    if (d.passwordEnc === ENC_VERSION) {
        try { return decryptText(d.password); } catch (e) { return null; }
    }
    return null;
}

// ---- validation
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const ALL_DIGITS_DOTS = /^[0-9.]+$/;

function isValidHost(h) {
    if (typeof h !== 'string') return false;
    if (ALL_DIGITS_DOTS.test(h)) return IPV4.test(h);
    return HOSTNAME.test(h);
}

/**
 * Validates and normalises device fields. partial=true only checks fields that are present.
 * Returns a clean object with only known fields (never a password blob/marker).
 */
function validateDeviceInput(body, { partial = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new NasValidationError('Device payload must be an object');
    const out = {};
    const has = (k) => body[k] !== undefined && body[k] !== null;

    if (!partial || has('name')) {
        if (typeof body.name !== 'string' || !body.name.trim()) throw new NasValidationError('Device name is required');
        if (body.name.trim().length > 64) throw new NasValidationError('Device name must be 64 characters or fewer');
        out.name = body.name.trim();
    }
    if (!partial || has('type')) {
        const t = typeof body.type === 'string' ? body.type.trim().toLowerCase() : '';
        if (!SUPPORTED_TYPES.includes(t)) throw new NasValidationError(`Type must be one of: ${SUPPORTED_TYPES.join(', ')}`);
        out.type = t;
    }
    if (!partial || has('ip')) {
        const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
        if (!ip || !isValidHost(ip)) throw new NasValidationError('IP address or hostname is invalid');
        out.ip = ip;
    }
    if (body.port === null || body.port === '') {
        out.port = null; // explicit "unset": the driver falls back to the type default
    } else if (has('port')) {
        const p = typeof body.port === 'string' && /^\d+$/.test(body.port) ? Number(body.port) : body.port;
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw new NasValidationError('Port must be an integer between 1 and 65535');
        out.port = p;
    }
    if (has('username')) {
        if (typeof body.username !== 'string' || body.username.length > 128) throw new NasValidationError('Username must be 128 characters or fewer');
        out.username = body.username;
    }
    if (has('password')) {
        if (typeof body.password !== 'string' || body.password.length > 256) throw new NasValidationError('Password must be 256 characters or fewer');
        out.password = body.password; // '' means "keep"
    }
    return out;
}

// ---- storage
function loadRaw() {
    const TARGET_DB_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
    const newPath = path.join(TARGET_DB_DIR, CONFIG_PATH);
    const oldPath = path.join(TARGET_DB_DIR, OLD_CONFIG_PATH);
    if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
        try { writeDataSync(CONFIG_PATH, readDataSync(OLD_CONFIG_PATH, [])); }
        catch (e) { console.error('Failed to migrate NAS config', e.message); }
    }
    const data = readDataSync(CONFIG_PATH, []);
    return Array.isArray(data) ? data : [];
}

function needsMigration(devices) {
    return migrateDevices(devices).changed > 0;
}

let chain = Promise.resolve();

/**
 * Serialised read-modify-write. fn(devices) may mutate the array in place or return a replacement array;
 * return value `{ skipWrite: true, value }` avoids writing. Throwing aborts without writing.
 */
function mutate(fn) {
    const run = chain.then(async () => {
        const mig = migrateDevices(loadRaw());
        if (mig.changed > 0) console.log(`[NAS] Password encryption migration: ${mig.changed} device record(s) updated, ${mig.needsReset} need a password re-entry`);
        const devices = mig.devices;
        const r = await fn(devices);
        if (r && r.skipWrite) {
            if (mig.changed > 0) writeDataSync(CONFIG_PATH, devices);
            return r.value;
        }
        writeDataSync(CONFIG_PATH, (r && Array.isArray(r.devices)) ? r.devices : devices);
        return r ? r.value : undefined;
    });
    chain = run.catch(() => {});
    return run;
}

/** Read the (migrated) list; persists the migration through the write chain on first use. */
async function readDevices() {
    if (needsMigration(loadRaw())) await mutate(() => ({ skipWrite: true }));
    return loadRaw();
}

function newId() { return crypto.randomUUID(); }

module.exports = {
    CONFIG_PATH, SUPPORTED_TYPES, NasValidationError,
    ENC_VERSION, encryptForStorage, applyPassword, readStoredPassword, migrateDevices, publicDevice,
    validateDeviceInput, isValidHost, mutate, readDevices, newId
};
