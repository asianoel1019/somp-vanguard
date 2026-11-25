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

// Optional vendor contact in the payload (shown to customers for renewals): { vendor?, email? }.
const CONTACT_VENDOR_MAX = 100;
const CONTACT_EMAIL_MAX = 200;
const CONTACT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/; // a newline would break the reminder email / Telegram text

/** '' when the contact is acceptable (an object whose vendor / email, when present, are valid), else a message. */
function contactError(contact) {
    if (!contact || typeof contact !== 'object' || Array.isArray(contact)) return 'contact must be an object';
    const has = (k) => Object.prototype.hasOwnProperty.call(contact, k) && contact[k] !== undefined;
    if (has('vendor')) {
        const v = contact.vendor;
        if (typeof v !== 'string' || !v.trim()) return 'contact vendor must be a non-empty string';
        if (v.length > CONTACT_VENDOR_MAX) return `contact vendor is longer than ${CONTACT_VENDOR_MAX} characters`;
        if (CONTROL_CHARS.test(v)) return 'contact vendor contains control characters';
    }
    if (has('email')) {
        const e = contact.email;
        if (typeof e !== 'string' || !e.trim()) return 'contact email must be a non-empty string';
        if (e.length > CONTACT_EMAIL_MAX) return `contact email is longer than ${CONTACT_EMAIL_MAX} characters`;
        if (CONTROL_CHARS.test(e)) return 'contact email contains control characters';
        if (!CONTACT_EMAIL_PATTERN.test(e)) return 'contact email is not a valid email address';
    }
    return '';
}

/** { vendor, email } ('' for a missing value) from a valid contact with at least one value; otherwise null. */
function normalizeContact(contact) {
    if (contact === undefined || contact === null || contactError(contact)) return null;
    const vendor = typeof contact.vendor === 'string' ? contact.vendor : '';
    const email = typeof contact.email === 'string' ? contact.email : '';
    return vendor || email ? { vendor, email } : null;
}

/** The "<who>" of a { vendor, email } contact: "vendor (email)", "vendor", "email", or '' (empty values count as missing). */
function contactText(contact) {
    if (!contact || typeof contact !== 'object') return '';
    const vendor = typeof contact.vendor === 'string' ? contact.vendor.trim() : '';
    const email = typeof contact.email === 'string' ? contact.email.trim() : '';
    if (vendor && email) return `${vendor} (${email})`;
    return vendor || email;
}

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
    if (p.contact !== undefined && contactError(p.contact)) return fail('invalid contact');
    if (p.trial !== undefined && typeof p.trial !== 'boolean') return fail('invalid trial');
    if (onDate > p.expiresAt) return { valid: false, reason: `expired on ${p.expiresAt}`, payload: p, expiredAt: p.expiresAt };
    return { valid: true, reason: '', payload: p };
}

module.exports = {
    REQUIRED_FIELDS, canonicalJson, verifyLicense, today, isRealDate, daysBetween, _setClockForTest,
    CONTACT_VENDOR_MAX, CONTACT_EMAIL_MAX, CONTACT_EMAIL_PATTERN, contactError, normalizeContact, contactText,
};
