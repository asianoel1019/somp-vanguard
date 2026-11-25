/**
 * Issuing core shared by the license CLI (scripts/license_issue.js) and the local web app (license-issuer/).
 * No database: it needs only the format rules (backend/lib/licenseFormat.js) and the built-in public keys
 * (backend/lib/licenseKeys.js). Vendor only; never deployed.
 *
 * Registry: a Markdown table (default issued-licenses.md next to the private key), one row per issued license.
 * Writers are serialised with "<registry>.lock" (created exclusively, removed afterwards, taken over when stale).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, verifyLicense, today, isRealDate, daysBetween } = require(path.join(__dirname, '..', 'backend', 'lib', 'licenseFormat'));
const { KEYS } = require(path.join(__dirname, '..', 'backend', 'lib', 'licenseKeys'));

const REGISTRY_HEADER = [
    '# SOMP Vanguard 已簽發授權登記表',
    '',
    '| License ID | Customer | Issued | Expires | Key | File | SHA-256 | Signed at |',
    '|---|---|---|---|---|---|---|---|',
    '',
].join('\n');
const REGISTRY_COLUMNS = ['licenseId', 'customer', 'issuedAt', 'expiresAt', 'keyId', 'file', 'sha256', 'signedAt'];
const ID_PATTERN = /^L-\d{4}-\d{4}$/;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 2 * 60 * 1000;

/**
 * Checks the issue fields; '' when fine, else a code: id-format, issued-date, expires-date, expires-past,
 * expires-before-issued (in this order, like the CLI). Customer checks are left to the caller.
 */
function validateIssueFields({ licenseId, issuedAt, expiresAt }, onDate = today()) {
    if (!ID_PATTERN.test(String(licenseId || ''))) return 'id-format';
    if (!isRealDate(issuedAt)) return 'issued-date';
    if (!isRealDate(expiresAt)) return 'expires-date';
    if (expiresAt < onDate) return 'expires-past';
    if (expiresAt < issuedAt) return 'expires-before-issued';
    return '';
}

/** One Markdown table cell: newlines become spaces, pipes are escaped, and a run of backslashes right before a pipe
 *  is doubled so it cannot swallow the escape (other backslashes, e.g. in Windows paths, stay as they are). */
function escapeCell(v) {
    return String(v).replace(/[\r\n]+/g, ' ').replace(/(\\+)(?=\|)/g, '$1$1').replace(/\|/g, '\\|');
}

/**
 * Splits one table line into raw-unescaped cells (the exact inverse of escapeCell): before a pipe, a run of 2k+1
 * backslashes is k backslashes plus a literal pipe, a run of 2k is k backslashes and the pipe ends the cell;
 * backslashes not followed by a pipe stay as typed. null when the line is not a complete row (| a | b |).
 */
function splitRow(line) {
    const s = String(line).trim();
    if (!s.startsWith('|')) return null;
    const parts = [];
    let cur = '';
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === '\\') {
            let j = i;
            while (j < s.length && s[j] === '\\') j++;
            const n = j - i;
            if (s[j] === '|') {
                cur += '\\'.repeat(Math.floor(n / 2));
                if (n % 2 === 1) { cur += '|'; i = j + 1; } else i = j;
            } else { cur += s.slice(i, j); i = j; }
        } else if (ch === '|') {
            parts.push(cur); cur = ''; i++;
        } else { cur += ch; i++; }
    }
    parts.push(cur);
    // "| a | b |" -> ['', ' a ', ' b ', '']: the outer parts must be empty (an unescaped closing pipe)
    if (parts.length < 3 || parts[0].trim() !== '' || parts[parts.length - 1].trim() !== '') return null;
    return parts.slice(1, -1).map((c) => c.trim());
}

/** The text of a cell as written in the license (undoes escapeCell; newlines that became spaces stay spaces). */
function unescapeCell(text) {
    const cells = splitRow(`| ${String(text)} |`);
    return cells && cells.length === 1 ? cells[0] : String(text);
}

/**
 * Registry rows: { line, licenseId, customer, issuedAt, expiresAt, keyId, file, sha256, signedAt }. Lines that start
 * with "|" but are not a readable data row go to unreadable: [{ line, text }]. Header / separator rows and other text
 * (title, notes) are skipped. expiresAt is kept as written (a format-1 row has text there, not a date).
 */
function parseRegistry(text) {
    const rows = [];
    const unreadable = [];
    String(text || '').split(/\r?\n/).forEach((raw, idx) => {
        const line = idx + 1;
        if (!raw.trim().startsWith('|')) return;
        const cells = splitRow(raw);
        if (cells && cells.length && cells.every((c) => /^:?-+:?$/.test(c))) return; // |---|---|
        if (cells && cells[0].toLowerCase() === 'license id') return; // header
        if (!cells || cells.length !== REGISTRY_COLUMNS.length || !/^L-\d{4}-\d{4}$/i.test(cells[0]) || !isRealDate(cells[2])) {
            unreadable.push({ line, text: raw.slice(0, 500) });
            return;
        }
        const row = { line };
        REGISTRY_COLUMNS.forEach((k, i) => { row[k] = cells[i]; });
        rows.push(row);
    });
    return { rows, unreadable };
}

function registryRow({ licenseId, customer, issuedAt, expiresAt, keyId, file, sha256, signedAt }) {
    const cells = [licenseId, customer, issuedAt, expiresAt, keyId, file, sha256, signedAt].map(escapeCell);
    return `| ${cells.join(' | ')} |`;
}

function nextLicenseId(registryText, year) {
    const re = new RegExp(`L-${year}-(\\d{4})(?!\\d)`, 'g');
    let max = 0;
    let m;
    while ((m = re.exec(String(registryText || ''))) !== null) max = Math.max(max, Number(m[1]));
    return `L-${year}-${String(max + 1).padStart(4, '0')}`;
}

/** First cell of every data row, unescaped lightly (IDs never contain pipes). */
function registryIds(text) {
    const ids = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const m = /^\|\s*([^|\s][^|]*?)\s*\|/.exec(line);
        if (m) ids.push(m[1]);
    }
    return ids;
}

/** Whether the registry already lists the ID (case-insensitive: a hand-typed row in lower case still counts). */
const hasLicenseId = (registryText, licenseId) =>
    registryIds(registryText).some((id) => id.toLowerCase() === String(licenseId).toLowerCase());

const samePath = (a, b) => {
    const norm = (p) => path.resolve(p);
    return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

function localIso(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

/** First 12 hex characters of the file's SHA-256 (the registry's SHA-256 cell). */
const sha12 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Takes "<registry>.lock". { release() } when taken (or when the folder cannot hold a lock file, e.g. it does not
 * exist: the registry write then fails and is reported anyway); { error } when another writer holds it past the timeout.
 */
function lockRegistry(registry, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS } = {}) {
    const file = `${registry}.lock`;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let fd;
        try {
            fd = fs.openSync(file, 'wx');
        } catch (e) {
            if (!e || e.code !== 'EEXIST') return { release() {}, file: null };
            try {
                if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.unlinkSync(file); continue; }
            } catch { continue; } // removed meanwhile: try again
            if (Date.now() >= deadline) return { error: `the registry is locked by another writer (${file})`, file };
            sleepSync(50);
            continue;
        }
        try { fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } catch { /* the lock is the file itself */ }
        fs.closeSync(fd);
        let released = false;
        return { file, release() { if (!released) { released = true; try { fs.unlinkSync(file); } catch { /* gone */ } } } };
    }
}

/** Registry text, null when it does not exist; { error } for any other read problem. */
function readRegistry(registry) {
    try {
        return { text: fs.readFileSync(registry, 'utf8') };
    } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { text: null };
        return { text: null, error: e || new Error('unknown error') };
    }
}

/** Signs a format-2 license; returns the file text (pretty JSON + newline). */
function signLicenseText({ key, keyId, licenseId, customer, issuedAt, expiresAt }) {
    const payload = { formatVersion: 2, keyId, licenseId, customer, edition: 'paid', issuedAt, expiresAt, updatesUntil: null };
    const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64');
    return JSON.stringify({ payload, signature }, null, 2) + '\n';
}

/**
 * Signs, verifies, writes the .lic and appends the registry row, under the registry lock. Input fields must already
 * pass validateIssueFields.
 *   key (KeyObject) or keyFile; keyId; customer; licenseId; issuedAt; expiresAt; out; registry;
 *   allowDuplicate (skip the registry ID check); overwrite (replace an existing out file); keys; onDate
 * Refused (nothing written): { ok: false, code, ... } with code out-protected | out-exists | registry-locked |
 *   registry-unreadable (error) | duplicate-id (next) | key-unreadable (error) | rejected (reason) | write-failed (error).
 * Written: { ok: true, text, outAbs, sha256, row, year, registryText, registryError (Error|null) }.
 */
function issueLicense(o) {
    const { keyId, customer, licenseId, issuedAt, expiresAt, out, registry } = o;
    const keys = o.keys || KEYS;
    const onDate = o.onDate || today();
    if ((o.keyFile && samePath(out, o.keyFile)) || samePath(out, registry)) return { ok: false, code: 'out-protected' };
    if (fs.existsSync(out) && !o.overwrite) return { ok: false, code: 'out-exists' };
    const lock = lockRegistry(registry, o.lock);
    if (lock.error) return { ok: false, code: 'registry-locked', error: new Error(lock.error) };
    try {
        const reg = readRegistry(registry);
        // Only a registry that does not exist is created after issuing; any other read error stops here, before signing,
        // so the duplicate check is never skipped and the existing registry is never overwritten.
        if (reg.error) return { ok: false, code: 'registry-unreadable', error: reg.error };
        let registryText = reg.text;
        const year = /^\d{4}/.test(issuedAt) ? issuedAt.slice(0, 4) : onDate.slice(0, 4);
        if (registryText !== null && !o.allowDuplicate && hasLicenseId(registryText, licenseId)) {
            return { ok: false, code: 'duplicate-id', next: nextLicenseId(registryText, year) };
        }
        let key = o.key;
        if (!key) {
            try { key = crypto.createPrivateKey(fs.readFileSync(o.keyFile)); } catch (e) { return { ok: false, code: 'key-unreadable', error: e }; }
        }
        const text = signLicenseText({ key, keyId, licenseId, customer, issuedAt, expiresAt });
        const check = verifyLicense(text, keys, onDate);
        if (!check.valid) return { ok: false, code: 'rejected', reason: check.reason };
        try {
            fs.writeFileSync(out, text, o.overwrite ? undefined : { flag: 'wx' });
        } catch (e) {
            return { ok: false, code: e && e.code === 'EEXIST' ? 'out-exists' : 'write-failed', error: e };
        }
        const outAbs = path.resolve(out);
        const sha256 = sha12(fs.readFileSync(out));
        const row = registryRow({ licenseId, customer, issuedAt, expiresAt, keyId, file: outAbs, sha256, signedAt: localIso() });
        let registryError = null;
        try {
            if (registryText === null) fs.writeFileSync(registry, REGISTRY_HEADER, { flag: 'wx' }); // never replaces a registry
            else if (registryText.length && !registryText.endsWith('\n')) fs.appendFileSync(registry, '\n');
            fs.appendFileSync(registry, row + '\n');
            registryText = fs.readFileSync(registry, 'utf8');
        } catch (e) {
            registryError = e;
        }
        return { ok: true, text, outAbs, sha256, row, year, registryText, registryError };
    } finally {
        lock.release();
    }
}

module.exports = {
    REGISTRY_HEADER, REGISTRY_COLUMNS, ID_PATTERN, validateIssueFields, escapeCell, unescapeCell, splitRow, parseRegistry,
    registryRow, nextLicenseId, registryIds, hasLicenseId, samePath, localIso, sha12, lockRegistry, readRegistry,
    signLicenseText, issueLicense, isRealDate, today, daysBetween,
};
