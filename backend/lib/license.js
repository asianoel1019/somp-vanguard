// License (free / paid edition). The vendor signs a JSON license with an Ed25519 private key (scripts/license_issue.js);
// every process verifies the stored original text with the built-in public keys (lib/licenseKeys.js), so editing the
// database does not help. Nothing here throws: any problem means the free edition, with the reason recorded.
// Spec: docs/superpowers/specs/2026-11-16-license-design.md
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readDataSync, writeDataSync } = require('./db');
const { KEYS } = require('./licenseKeys');

const LICENSE_KEY = 'system/license.json';
const PAID_FEATURES = Object.freeze(['aiAgent', 'workflow', 'scheduler', 'remoteCmd', 'install', 'manage_self_healing',
    'networkDevice', 'ipam', 'netSearch', 'dataCenter']);
const PAID_CHANNELS = Object.freeze(['telegram', 'email', 'webhook']);
const REQUIRED_FIELDS = ['keyId', 'licenseId', 'customer', 'edition', 'issuedAt'];
const SKIP_LOG_MS = 60 * 60 * 1000;

/** JSON with object keys sorted at every level: the exact bytes that are signed. */
function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

const fail = (reason) => ({ valid: false, reason, payload: null });

function verifyLicense(text, keys = KEYS) {
    let doc;
    try { doc = JSON.parse(String(text || '')); } catch { return fail('not valid JSON'); }
    if (!doc || typeof doc !== 'object' || !doc.payload || typeof doc.payload !== 'object' || typeof doc.signature !== 'string') {
        return fail('missing payload or signature');
    }
    const p = doc.payload;
    if (p.formatVersion !== 1) return fail(`unsupported format version ${p.formatVersion}`);
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
    return { valid: true, reason: '', payload: p };
}

const freeState = (reason) => ({ edition: 'free', customer: '', licenseId: '', issuedAt: '', updatesUntil: null, reason });
let cache = { text: null, state: null };

function storedText() {
    try {
        const doc = readDataSync(LICENSE_KEY, null);
        return doc && typeof doc === 'object' && typeof doc.text === 'string' ? doc.text : '';
    } catch { return ''; }
}

/** Current edition; verified again only when the stored text changes. */
function getLicense() {
    const text = storedText();
    if (cache.state && cache.text === text) return cache.state;
    let state;
    if (!text) state = freeState('no license');
    else {
        const r = verifyLicense(text);
        state = r.valid
            ? { edition: 'paid', customer: r.payload.customer, licenseId: r.payload.licenseId, issuedAt: r.payload.issuedAt,
                updatesUntil: r.payload.updatesUntil === undefined ? null : r.payload.updatesUntil, reason: '' }
            : freeState(r.reason);
    }
    cache = { text, state };
    return state;
}

const isPaid = () => getLicense().edition === 'paid';
const licenseAllows = (featureKey) => !PAID_FEATURES.includes(featureKey) || isPaid();
const channelAllowed = (channel) => !PAID_CHANNELS.includes(channel) || isPaid();
const lockedFeatures = () => (isPaid() ? [] : [...PAID_FEATURES]);
const lockedChannels = () => (isPaid() ? [] : [...PAID_CHANNELS]);

function publicState() {
    return { ...getLicense(), locked: lockedFeatures(), lockedChannels: lockedChannels() };
}

function statusLine() {
    const l = getLicense();
    return l.edition === 'paid' ? `License: Paid (${l.customer}, ${l.licenseId})` : `License: Free (${l.reason})`;
}

/** Hash of the last license file that was imported (kept across installs and removals); '' when none. */
function storedFileSha() {
    try {
        const doc = readDataSync(LICENSE_KEY, null);
        return doc && typeof doc === 'object' && typeof doc.fileSha256 === 'string' ? doc.fileSha256 : '';
    } catch { return ''; }
}

function installLicense(text, by, fileSha256) {
    const clean = String(text || '').trim();
    const r = verifyLicense(clean);
    if (!r.valid) return { ok: false, reason: r.reason };
    const sha = fileSha256 || storedFileSha();
    const doc = { text: clean, uploadedAt: new Date().toISOString(), uploadedBy: String(by || '') };
    if (sha) doc.fileSha256 = sha;
    writeDataSync(LICENSE_KEY, doc);
    return { ok: true, payload: r.payload };
}

function removeLicense(by) {
    const sha = storedFileSha();
    const doc = { removedAt: new Date().toISOString(), removedBy: String(by || '') };
    if (sha) doc.fileSha256 = sha;
    writeDataSync(LICENSE_KEY, doc);
}

/** Newest valid *.lic in <dataDir> (by issuedAt, then licenseId; the first file name wins a tie); invalid files are listed in `invalid`. */
function pickLicenseFile(dataDir) {
    const dir = String(dataDir || '');
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /\.lic$/i.test(n)).sort(); } catch { names = []; }
    let best = null;
    const invalid = [];
    for (const name of names) {
        let text;
        try {
            const file = path.join(dir, name);
            if (!fs.statSync(file).isFile()) continue;
            text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
        } catch (e) { invalid.push({ file: name, reason: e.message }); continue; }
        const r = verifyLicense(text);
        if (!r.valid) { invalid.push({ file: name, reason: r.reason }); continue; }
        const c = { file: name, text, payload: r.payload };
        if (!best || r.payload.issuedAt > best.payload.issuedAt
            || (r.payload.issuedAt === best.payload.issuedAt && r.payload.licenseId > best.payload.licenseId)) best = c;
    }
    return { count: names.length, best, invalid };
}

/**
 * Startup: the newest valid *.lic in <dataDir> becomes the stored license when it is a file not imported before and
 * not older than the stored license (an upgrade starts licensed; a UI removal or replacement is not undone).
 */
function importLicenseFile(dataDir) {
    try {
        const { count, best, invalid } = pickLicenseFile(dataDir);
        if (!count) return { imported: false, reason: 'no file', invalid };
        if (!best) return { imported: false, reason: 'no valid license file', invalid };
        const sha = crypto.createHash('sha256').update(best.text).digest('hex');
        const base = { file: best.file, licenseId: best.payload.licenseId, invalid };
        if (sha === storedFileSha()) return { imported: false, reason: 'same', ...base };
        const current = getLicense();
        if (current.edition === 'paid' && current.issuedAt > best.payload.issuedAt) {
            return { imported: false, reason: `older than the current license ${current.licenseId}`, ...base };
        }
        const r = installLicense(best.text, best.file, sha);
        return r.ok ? { imported: true, reason: '', ...base } : { imported: false, reason: r.reason, ...base };
    } catch (e) {
        return { imported: false, reason: e.message, invalid: [] };
    }
}

const lastSkip = new Map();
function noteSkipped(what) {
    const now = Date.now();
    if (now - (lastSkip.get(what) || 0) < SKIP_LOG_MS) return;
    lastSkip.set(what, now);
    console.log(`[License] ${what} skipped: requires a paid license`);
}

module.exports = {
    LICENSE_KEY, PAID_FEATURES, PAID_CHANNELS, canonicalJson, verifyLicense, getLicense, isPaid, licenseAllows,
    channelAllowed, lockedFeatures, lockedChannels, publicState, statusLine, installLicense, removeLicense,
    pickLicenseFile, importLicenseFile, noteSkipped,
};
