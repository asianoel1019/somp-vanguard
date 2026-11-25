// Registry view for the page (status per license, from the database) and the file checks behind a download.
const fs = require('fs');
const path = require('path');
const core = require(path.join(__dirname, '..', '..', 'scripts', 'licenseIssuerCore'));
const { computeStatus, slugify, SOON_DAYS: SOON } = require('./store/rules');

const SOON_DAYS = SOON.paid;
const FORMAT1_TEXT = '— (format 1, no expiry)';

/** { status, daysLeft } of a paid license by its expiry text: Format 1 (invalid) | Expired | Expires soon (0-30 days) | Active. */
function rowStatus(expiresAt, today) {
    return computeStatus({ format: core.isRealDate(expiresAt) ? 2 : 1, expiresAt: core.isRealDate(expiresAt) ? expiresAt : null, type: 'paid' }, today);
}

/** Expiry ascending, format-1 rows last, then by ID. */
function compareRows(a, b) {
    const da = core.isRealDate(a.expiresAt);
    const db = core.isRealDate(b.expiresAt);
    if (da !== db) return da ? -1 : 1;
    if (da && a.expiresAt !== b.expiresAt) return a.expiresAt < b.expiresAt ? -1 : 1;
    return a.licenseId < b.licenseId ? -1 : a.licenseId > b.licenseId ? 1 : (a.line || 0) - (b.line || 0);
}

/**
 * The licenses for the page, from the database: { exists (registry copy written), rows, unreadable: [], nextId }.
 * Rows keep the shape of the earlier Markdown view (licenseId, customer = the name signed into the license, issuedAt,
 * expiresAt (text for format 1), keyId, file, sha256, signedAt, fileName, status, daysLeft) plus type, sales, revoked.
 */
function registryView(store, today) {
    const rows = store.listLicenses({ sort: 'id' }).map((l) => ({
        licenseId: l.licenseId, customer: l.licensedTo, issuedAt: l.issuedAt, expiresAt: l.expiresAt || FORMAT1_TEXT, keyId: l.keyId || '',
        file: l.filePath || '', sha256: l.sha12 || '', signedAt: l.signedAt || '', fileName: l.fileName || '', type: l.type, sales: l.salesName,
        revoked: !!l.revokedAt, ...computeStatus(l, today),
    })).sort(compareRows);
    return { exists: !!store.registryFile && fs.existsSync(store.registryFile), rows, unreadable: [], nextId: store.nextLicenseId(today.slice(0, 4)) };
}

const isLic = (p) => /\.lic$/i.test(p);

/**
 * The file to download for a license ID: only the file the database records for it, that exists, is a .lic, is not the
 * private key and whose SHA-256 still matches the recorded one. { file, name, body, license } or { status, reason }.
 */
function downloadTarget(store, licenseId, keyFile) {
    if (!core.ID_PATTERN.test(String(licenseId || ''))) return { status: 404, reason: 'Not a license ID' };
    const license = store.getLicense(licenseId);
    if (!license) return { status: 404, reason: `${licenseId} is not in the registry` };
    const file = license.filePath || '';
    if (!path.isAbsolute(file) || !isLic(file)) return { status: 409, reason: 'The recorded path is not an absolute .lic file path' };
    const resolved = path.resolve(file);
    if (keyFile && core.samePath(resolved, keyFile)) return { status: 409, reason: 'The recorded path points at the private key' };
    let buf;
    try {
        const st = fs.statSync(resolved);
        if (!st.isFile()) return { status: 409, reason: 'The recorded path is not a file' };
        const real = fs.realpathSync(resolved); // a link must not lead somewhere else
        if (!isLic(real) || (keyFile && core.samePath(real, keyFile))) return { status: 409, reason: 'The recorded path links to a file that is not a license' };
        buf = fs.readFileSync(real);
    } catch (e) {
        return { status: 404, reason: `The license file is missing (${e.code || 'unreadable'}): ${resolved}` };
    }
    if (core.sha12(buf) !== String(license.sha12 || '').toLowerCase()) {
        return { status: 409, reason: 'The license file does not match the SHA-256 in the registry (changed or replaced)' };
    }
    return { file: resolved, name: path.basename(resolved), body: buf, license };
}

module.exports = { SOON_DAYS, FORMAT1_TEXT, rowStatus, compareRows, registryView, slugify, downloadTarget };
