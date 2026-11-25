// License file format rules without the database: canonical JSON, signature / format / expiry checks and the local
// date helpers. Used by lib/license.js (the product) and by the vendor issuing tools (scripts/licenseIssuerCore.js,
// license-issuer/), so a license is judged by exactly the same code everywhere. Nothing here throws.
const crypto = require('crypto');
const { KEYS } = require('./licenseKeys');

const REQUIRED_FIELDS = ['keyId', 'licenseId', 'customer', 'edition', 'issuedAt'];

/** JSON with object keys sorted at every level: the exact bytes that are signed. */
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

const fail = (reason) => ({ valid: false, reason, payload: null });

let clock = () => new Date();
const pad = (n) => String(n).padStart(2, '0');
/** Local date as YYYY-MM-DD (injectable clock for tests). */
function today() { const d = clock(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function isRealDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/** Calendar days from one YYYY-MM-DD to another. */
function daysBetween(from, to) {
    const ms = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((ms(to) - ms(from)) / 86400000);
}
function _setClockForTest(fn) { clock = fn || (() => new Date()); }

function verifyLicense(text, keys = KEYS, onDate = today()) {
    let doc;
    try { doc = JSON.parse(String(text || '')); } catch { return fail('not valid JSON'); }
    if (!doc || typeof doc !== 'object' || !doc.payload || typeof doc.payload !== 'object' || typeof doc.signature !== 'string') {
        return fail('missing payload or signature');
    }
    const p = doc.payload;
    if (p.formatVersion !== 2) {
        return fail(p.formatVersion === 1
            ? 'unsupported format version 1: issue a new license with an expiry date'
            : `unsupported format version ${p.formatVersion}`);
    }
    for (const f of REQUIRED_FIELDS) {
        if (typeof p[f] !== 'string' || !p[f].trim()) return fail(`missing ${f}`);
    }
    const pem = Object.prototype.hasOwnProperty.call(keys, p.keyId) ? keys[p.keyId] : null;
    if (!pem) return fail(`unknown key ${p.keyId}`);
    let ok = false;
    try {
        ok = crypto.verify(null, Buffer.from(canonicalJson(p)), crypto.createPublicKey(pem), Buffer.from(doc.signature, 'base64'));
    } catch { ok = false; }
    if (!ok) return fail('signature does not match');
    if (p.edition !== 'paid') return fail(`edition "${p.edition}" is not paid`);
    if (p.expiresAt === undefined || p.expiresAt === null || p.expiresAt === '') return fail('missing expiresAt');
    if (!isRealDate(p.expiresAt) || (isRealDate(p.issuedAt) && p.expiresAt < p.issuedAt)) return fail('invalid expiresAt');
    if (onDate > p.expiresAt) return { valid: false, reason: `expired on ${p.expiresAt}`, payload: p, expiredAt: p.expiresAt };
    return { valid: true, reason: '', payload: p };
}

module.exports = { REQUIRED_FIELDS, canonicalJson, verifyLicense, today, isRealDate, daysBetween, _setClockForTest };
