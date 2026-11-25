// Registry view for the page (status per row) and the file checks behind a download.
const fs = require('fs');
const path = require('path');
const core = require(path.join(__dirname, '..', '..', 'scripts', 'licenseIssuerCore'));

const SOON_DAYS = 30;

/** { status, daysLeft }: Format 1 (invalid) | Expired | Expires soon (0-30 days) | Active. */
function rowStatus(expiresAt, today) {
    if (!core.isRealDate(expiresAt)) return { status: 'Format 1 (invalid)', daysLeft: null };
    const daysLeft = core.daysBetween(today, expiresAt);
    if (daysLeft < 0) return { status: 'Expired', daysLeft };
    if (daysLeft <= SOON_DAYS) return { status: 'Expires soon', daysLeft };
    return { status: 'Active', daysLeft };
}

/** Expiry ascending, format-1 rows last, then by ID. */
function compareRows(a, b) {
    const da = core.isRealDate(a.expiresAt);
    const db = core.isRealDate(b.expiresAt);
    if (da !== db) return da ? -1 : 1;
    if (da && a.expiresAt !== b.expiresAt) return a.expiresAt < b.expiresAt ? -1 : 1;
    return a.licenseId < b.licenseId ? -1 : a.licenseId > b.licenseId ? 1 : a.line - b.line;
}

/** The registry for the page: { exists, rows (with status/daysLeft/fileName), unreadable, nextId } or { error }. */
function registryView(file, today) {
    const r = core.readRegistry(file);
    if (r.error) return { error: `Cannot read the registry (${r.error.code || r.error.message})` };
    const { rows, unreadable } = core.parseRegistry(r.text);
    const out = rows.map((row) => ({ ...row, fileName: path.win32.basename(row.file), ...rowStatus(row.expiresAt, today) })).sort(compareRows);
    return { exists: r.text !== null, rows: out, unreadable, nextId: core.nextLicenseId(r.text, today.slice(0, 4)) };
}

/** File name part from a customer name: lowercase ASCII letters, digits and hyphens, at most 40, else "customer". */
function slugify(customer) {
    const s = String(customer || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
    return s || 'customer';
}

const isLic = (p) => /\.lic$/i.test(p);

/**
 * The file to download for a license ID: only a file the registry lists (the last row for the ID), that exists, is a
 * .lic, is not the private key and whose SHA-256 still matches the registry. { file, name } or { status, reason }.
 */
function downloadTarget(registryFile, licenseId, keyFile) {
    if (!core.ID_PATTERN.test(String(licenseId || ''))) return { status: 404, reason: 'Not a license ID' };
    const r = core.readRegistry(registryFile);
    if (r.error) return { status: 409, reason: `Cannot read the registry (${r.error.code || r.error.message})` };
    const rows = core.parseRegistry(r.text).rows.filter((row) => row.licenseId === licenseId);
    if (!rows.length) return { status: 404, reason: `${licenseId} is not in the registry` };
    const row = rows[rows.length - 1];
    const file = row.file;
    if (!path.isAbsolute(file) || !isLic(file)) return { status: 409, reason: 'The registry path is not an absolute .lic file path' };
    const resolved = path.resolve(file);
    if (keyFile && core.samePath(resolved, keyFile)) return { status: 409, reason: 'The registry path points at the private key' };
    let buf;
    try {
        const st = fs.statSync(resolved);
        if (!st.isFile()) return { status: 409, reason: 'The registry path is not a file' };
        const real = fs.realpathSync(resolved); // a link must not lead somewhere else
        if (!isLic(real) || (keyFile && core.samePath(real, keyFile))) return { status: 409, reason: 'The registry path links to a file that is not a license' };
        buf = fs.readFileSync(real);
    } catch (e) {
        return { status: 404, reason: `The license file is missing (${e.code || 'unreadable'}): ${resolved}` };
    }
    if (core.sha12(buf) !== String(row.sha256).toLowerCase()) {
        return { status: 409, reason: 'The license file does not match the SHA-256 in the registry (changed or replaced)' };
    }
    return { file: resolved, name: path.basename(resolved), body: buf };
}

module.exports = { SOON_DAYS, rowStatus, compareRows, registryView, slugify, downloadTarget };
