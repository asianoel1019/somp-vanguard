/**
 * SSL Manager core: validation, certificate parsing, status / alert-level model, public projection and the TLS
 * prober. Everything except probeTLS / parsePfx (I/O) is pure.
 *
 * Status model (computed from validTo / notAfter, never trusted from storage):
 *   active   days > thresholdDays
 *   warning  0 <= days <= thresholdDays
 *   expired  days < 0
 *   error    no usable expiry date (probe failed and nothing was ever read / file unparseable)
 * daysRemaining = floor((notAfter - now) / 1 day): negative exactly when the certificate has expired.
 * `trusted` / `trustError` are kept separate from the status.
 *
 * Test hooks: hooks.probe (TLS prober), hooks.runPowerShell (PFX parser), hooks.sendAlert (alert sender) can be
 * replaced with setHooks({...}) and restored with resetHooks(); callers always go through `hooks`.
 */
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');

const FILE_ONLY_HOST = 'File Backup Only';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PORT = 443;
const DEFAULT_THRESHOLD_DAYS = 30;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_NAME_LENGTH = 200;
const MAX_HOST_LENGTH = 253;
const PROBE_TIMEOUT_MS = 8000;
const NO_DAYS = -999; // legacy "unknown" value of daysRemaining (kept for old readers)

/** Upload type whitelist: X509 (PEM / DER, decided by content) or PFX. */
const FILE_TYPE_ALIASES = { PEM: 'X509', DER: 'X509', CER: 'X509', CRT: 'X509', PFX: 'PFX', P12: 'PFX' };

/** Expiry alert levels, least to most severe. */
const EXPIRY_LEVELS = ['ok', 'warn30', 'warn14', 'warn7', 'warn1', 'expired'];
const levelRank = (l) => EXPIRY_LEVELS.indexOf(l);

// ---------------------------------------------------------------- settings
function thresholdDays(env = process.env) {
    const n = parseInt(env.SSL_ALERT_THRESHOLD_DAYS, 10);
    return Number.isFinite(n) && n >= 0 && n <= 3650 ? n : DEFAULT_THRESHOLD_DAYS;
}

// ---------------------------------------------------------------- validation
/**
 * Host: hostname or IPv4, <= 253 chars. Politely normalised: trimmed, lower-cased, a leading http(s):// and
 * trailing "/" or "." removed. Anything else (path, port, spaces, user info, IPv6) is rejected.
 * Empty (or the legacy 'File Backup Only') -> { host: '' } (a file-only record).
 */
function normalizeHost(input) {
    if (input === undefined || input === null) return { host: '' };
    if (typeof input !== 'string' && typeof input !== 'number') return { error: 'Host must be a string' };
    let h = String(input).trim();
    if (h === '' || h === FILE_ONLY_HOST) return { host: '' };
    h = h.replace(/^https?:\/\//i, '').replace(/\/+$/, '').replace(/\.$/, '').toLowerCase();
    if (!h) return { error: 'Host is empty' };
    if (h.length > MAX_HOST_LENGTH) return { error: `Host is too long (max ${MAX_HOST_LENGTH} characters)` };
    if (/[\s/\\:@?#]/.test(h)) return { error: 'Host must be a hostname or IPv4 address without scheme, port, path or spaces' };
    if (/^[\d.]+$/.test(h)) {
        if (!net.isIPv4(h)) return { error: `Invalid IPv4 address: ${h}` };
        return { host: h };
    }
    const label = '[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?';
    if (!new RegExp(`^${label}(?:\\.${label})*$`).test(h)) return { error: `Invalid hostname: ${h}` };
    return { host: h };
}

/** Port: integer 1-65535; empty -> 443. */
function normalizePort(input) {
    if (input === undefined || input === null || input === '') return { port: DEFAULT_PORT };
    const s = String(input).trim();
    if (!/^\d{1,5}$/.test(s)) return { error: 'Port must be an integer between 1 and 65535' };
    const n = parseInt(s, 10);
    if (n < 1 || n > 65535) return { error: 'Port must be an integer between 1 and 65535' };
    return { port: n };
}

function normalizeName(input) {
    if (input === undefined || input === null) return { name: '' };
    if (typeof input !== 'string' && typeof input !== 'number') return { error: 'Name must be a string' };
    const n = String(input).trim();
    if (n.length > MAX_NAME_LENGTH) return { error: `Name is too long (max ${MAX_NAME_LENGTH} characters)` };
    return { name: n };
}

const isFileOnly = (record) => !record || !record.host || String(record.host).trim() === '' || record.host === FILE_ONLY_HOST;

function newId(now = Date.now()) {
    return `ssl-${now}-${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------- dates / status
function parseDate(v) {
    if (v === undefined || v === null || v === '' || v === '-') return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days until validTo (floor, negative once expired); null when the date is unknown. */
function daysUntil(validTo, now = new Date()) {
    const d = parseDate(validTo);
    if (!d) return null;
    const n = now instanceof Date ? now.getTime() : Number(now);
    return Math.floor((d.getTime() - n) / DAY_MS);
}

/** Expiry of a record: the exact notAfter when known, else the stored YYYY-MM-DD validTo. */
const expiryOf = (record) => (record && (parseDate(record.notAfter) ? record.notAfter : record.validTo)) || null;

function statusForDays(days, threshold = DEFAULT_THRESHOLD_DAYS) {
    if (days === null || days === undefined) return 'error';
    if (days < 0) return 'expired';
    return days <= threshold ? 'warning' : 'active';
}

/** { daysRemaining, status } of a record at `now` (daysRemaining -999 when unknown, as before). */
function computeStatus(record, now = new Date(), threshold = DEFAULT_THRESHOLD_DAYS) {
    const days = daysUntil(expiryOf(record), now);
    return { daysRemaining: days === null ? NO_DAYS : days, status: statusForDays(days, threshold) };
}

/** Expiry alert level for `days` (null when unknown). */
function expiryLevel(days, threshold = DEFAULT_THRESHOLD_DAYS) {
    if (days === null || days === undefined) return null;
    if (days < 0) return 'expired';
    if (days > threshold) return 'ok';
    if (days <= 1) return 'warn1';
    if (days <= 7) return 'warn7';
    if (days <= 14) return 'warn14';
    return 'warn30';
}

/**
 * Alert state machine. prev = stored record.alertState ({ level, notifiedAt, expiry, errorNotified }) and
 * record.failCount. input = { days, expiry, threshold, probed, probeFailed, now }.
 *   - expiry: notify when the level becomes MORE severe than the last level (ok -> warn30 -> ... -> expired);
 *     a renewal (expiry moved forward) resets the level first; 'ok' never notifies.
 *   - probe failures: notify once when failCount reaches 2, and once more when the probe succeeds again.
 * Returns { alertState, failCount, events: [{ type: 'expiry'|'expired'|'error'|'recovered', level }] }.
 */
function decideAlerts(prevState, prevFailCount, input) {
    const prev = prevState && typeof prevState === 'object' ? prevState : {};
    const nowIso = (input.now instanceof Date ? input.now : new Date(input.now || Date.now())).toISOString();
    const state = { level: prev.level || null, notifiedAt: prev.notifiedAt || null, expiry: prev.expiry || null, errorNotified: !!prev.errorNotified };
    let failCount = Number(prevFailCount) || 0;
    const events = [];

    const newExpiry = parseDate(input.expiry);
    const oldExpiry = parseDate(state.expiry);
    // renewal: the expiry moved forward by more than a day (a legacy day-only validTo vs. the exact notAfter of the
    // same certificate differs by hours, never by a day)
    if (newExpiry && oldExpiry && newExpiry.getTime() - oldExpiry.getTime() > DAY_MS) state.level = 'ok';
    if (newExpiry) state.expiry = newExpiry.toISOString();

    const level = expiryLevel(input.days, input.threshold);
    if (level) {
        const prevRank = state.level ? levelRank(state.level) : -1;
        if (level !== 'ok' && levelRank(level) > prevRank) {
            events.push({ type: level === 'expired' ? 'expired' : 'expiry', level });
            state.notifiedAt = nowIso;
        }
        state.level = level;
    }

    if (input.probed) {
        if (input.probeFailed) {
            failCount += 1;
            if (failCount >= 2 && !state.errorNotified) {
                events.push({ type: 'error', level: 'error' });
                state.errorNotified = true;
                state.notifiedAt = nowIso;
            }
        } else {
            failCount = 0;
            if (state.errorNotified) {
                events.push({ type: 'recovered', level: 'recovered' });
                state.errorNotified = false;
                state.notifiedAt = nowIso;
            }
        }
    }
    return { alertState: state, failCount, events };
}

// ---------------------------------------------------------------- certificate parsing
const toDay = (d) => d.toISOString().split('T')[0];

function dnField(dn, field) {
    const m = String(dn || '').split(/\r?\n/).map(s => s.trim()).find(s => s.toUpperCase().startsWith(field.toUpperCase() + '='));
    return m ? m.slice(field.length + 1) : '';
}
const oneLineDn = (dn) => String(dn || '').split(/\r?\n/).filter(Boolean).join(', ');

/** "DNS:a, IP Address:1.2.3.4" -> ['DNS:a', 'IP:1.2.3.4'] */
function parseSan(s) {
    if (!s) return [];
    return String(s).split(/,\s*/).map(x => x.trim()).filter(Boolean).map(x => x.replace(/^IP Address:/i, 'IP:'));
}

/** Fields of a crypto.X509Certificate. */
function infoFromX509(x) {
    const notBefore = x.validFromDate || new Date(x.validFrom);
    const notAfter = x.validToDate || new Date(x.validTo);
    return {
        success: true,
        subject: dnField(x.subject, 'CN') || oneLineDn(x.subject) || '-',
        subjectDN: oneLineDn(x.subject),
        issuer: dnField(x.issuer, 'CN') || oneLineDn(x.issuer) || '-',
        issuerDN: oneLineDn(x.issuer),
        validFrom: toDay(notBefore),
        validTo: toDay(notAfter),
        notBefore: notBefore.toISOString(),
        notAfter: notAfter.toISOString(),
        san: parseSan(x.subjectAltName),
        fingerprint256: x.fingerprint256 || '',
    };
}

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

/** PEM text (first certificate = leaf) or DER bytes -> { success, ...info } | { success:false, error }. */
function parseX509(input) {
    try {
        let x;
        const text = Buffer.isBuffer(input) ? input.toString('latin1') : String(input || '');
        const m = text.match(PEM_RE);
        if (m) x = new crypto.X509Certificate(m[0]);
        else if (Buffer.isBuffer(input) && input.length) x = new crypto.X509Certificate(input);
        else return { success: false, error: 'No PEM certificate block found' };
        return infoFromX509(x);
    } catch (e) {
        return { success: false, error: `Certificate could not be parsed: ${e.message}` };
    }
}

function normalizeFileType(t) {
    const k = String(t || '').trim().toUpperCase().replace(/^\./, '');
    return FILE_TYPE_ALIASES[k] ? { type: k, family: FILE_TYPE_ALIASES[k] } : null;
}

/**
 * Validates an uploaded file: type whitelist, strict base64, decoded size <= 1 MB.
 * Returns { buffer, family: 'X509'|'PFX', type } or { error } (HTTP 400).
 */
function decodeUpload(b64, fileType) {
    const ft = normalizeFileType(fileType);
    if (!ft) return { error: `Unsupported certificate file type "${fileType || ''}". Allowed: PEM, DER (CER / CRT), PFX (P12)` };
    if (typeof b64 !== 'string') return { error: 'uploadedFileB64 must be a base64 string' };
    const s = b64.replace(/\s+/g, '');
    if (s.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) return { error: 'Certificate file is too large (max 1 MB)' };
    if (!s || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return { error: 'uploadedFileB64 is not valid base64' };
    const buffer = Buffer.from(s, 'base64');
    if (buffer.length === 0) return { error: 'Certificate file is empty' };
    if (buffer.length > MAX_FILE_BYTES) return { error: 'Certificate file is too large (max 1 MB)' };
    return { buffer, family: ft.family, type: ft.type, b64: s };
}

/**
 * Constant PFX parser script: the file bytes and the password arrive ONLY through stdin (base64 JSON
 * { file, password }); nothing is ever interpolated into the script text. The leaf certificate (the one with
 * the private key, else the first) is returned as DER (base64) and parsed in Node.
 */
const PFX_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$res = @{ success = $false; error = ''; der = '' }
try {
    $in = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
    $bytes = [System.Convert]::FromBase64String([string]$in.file)
    $pass = [string]$in.password
    $in = $null
    $col = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
    try {
        $col.Import($bytes, $pass, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
    } catch {
        $col = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
        $col.Import($bytes, $pass, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::DefaultKeySet)
    }
    $pass = $null
    $cert = $null
    foreach ($c in $col) { if ($c.HasPrivateKey) { $cert = $c; break } }
    if (-not $cert -and $col.Count -gt 0) { $cert = $col[0] }
    if (-not $cert) { throw 'The PFX file contains no certificate' }
    $res.der = [System.Convert]::ToBase64String($cert.RawData)
    $res.success = $true
} catch {
    $res.error = $_.Exception.Message
}
$json = $res | ConvertTo-Json -Compress
Write-Output ('@@SOMP_RESULT@@' + [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))
`;

function parseScriptResult(stdout) {
    const line = String(stdout || '').split(/\r?\n/).reverse().find(l => l.startsWith('@@SOMP_RESULT@@'));
    if (!line) return null;
    try { return JSON.parse(Buffer.from(line.slice('@@SOMP_RESULT@@'.length).trim(), 'base64').toString('utf8')); }
    catch (e) { return null; }
}

/** PFX/P12 -> leaf certificate info, via the constant PowerShell script (bytes + password over stdin). */
async function parsePfx(buffer, password = '') {
    const payload = Buffer.from(JSON.stringify({ file: buffer.toString('base64'), password: password || '' }), 'utf8').toString('base64');
    let stdout;
    try {
        stdout = await hooks.runPowerShell(PFX_SCRIPT, 30000, { stdin: payload });
    } catch (err) {
        const reason = (err && (err.stderr || (err.error && err.error.message) || err.message)) || 'unknown error';
        return { success: false, error: `PFX could not be parsed: ${String(reason).trim()}` };
    }
    const r = parseScriptResult(stdout);
    if (!r) return { success: false, error: 'PFX could not be parsed: no result from PowerShell' };
    if (!r.success || !r.der) return { success: false, error: `PFX could not be parsed: ${r.error || 'unknown error'}` };
    return parseX509(Buffer.from(r.der, 'base64'));
}

/** Parses an uploaded file (already decoded by decodeUpload). Returns { success, ...info, format } | { success:false, error }. */
async function parseUpload(decoded, password = '') {
    if (decoded.family === 'PFX') {
        const r = await parsePfx(decoded.buffer, password);
        return r.success ? { ...r, format: 'PFX' } : r;
    }
    const isPem = decoded.buffer.toString('latin1').includes('-----BEGIN');
    const r = parseX509(isPem ? decoded.buffer.toString('utf8') : decoded.buffer);
    return r.success ? { ...r, format: isPem ? 'PEM' : 'DER' } : r;
}

// ---------------------------------------------------------------- trust
/**
 * Trust evaluation of a probed peer certificate (detailed = getPeerCertificate(true)).
 * - chain trust: socket.authorized / authorizationError
 * - hostname: tls.checkServerIdentity(host, cert). When host is an IP address and the certificate carries no
 *   IP SAN at all, the hostname check is SKIPPED (internal servers monitored by IP); hostnameChecked=false.
 * - chain walk: any expired intermediate / root in the presented chain is reported (stops on self-reference
 *   or a repeated fingerprint).
 */
function evaluateTrust({ host, authorized, authorizationError, cert, now = new Date(), checkServerIdentity = tls.checkServerIdentity }) {
    const problems = [];
    if (!authorized) problems.push(String(authorizationError || 'Certificate chain is not trusted'));
    const san = parseSan(cert && cert.subjectaltname);
    const hasIpSan = san.some(s => /^IP:/i.test(s));
    let hostnameChecked = false;
    if (host && cert && !(net.isIP(host) && !hasIpSan)) {
        hostnameChecked = true;
        let err;
        try { err = checkServerIdentity(host, cert); } catch (e) { err = e; }
        if (err) problems.push(err.reason || err.message || String(err));
    }
    const expiredChain = [];
    const seen = new Set();
    let cur = cert;
    const nowMs = now.getTime();
    for (let depth = 0; cur && depth < 20; depth++) {
        const fp = cur.fingerprint256 || cur.fingerprint || `${depth}`;
        if (seen.has(fp)) break;
        seen.add(fp);
        if (depth > 0) {
            const vt = parseDate(cur.valid_to);
            if (vt && vt.getTime() < nowMs) {
                const name = (cur.subject && cur.subject.CN) || 'intermediate';
                expiredChain.push(`${name} (${toDay(vt)})`);
            }
        }
        const next = cur.issuerCertificate;
        if (!next || next === cur) break;
        cur = next;
    }
    if (expiredChain.length) problems.push(`Expired certificate in chain: ${expiredChain.join(', ')}`);
    // de-duplicate (an expired chain also shows in authorizationError)
    const uniq = [...new Set(problems)];
    return { trusted: uniq.length === 0, trustError: uniq.join('; '), hostnameChecked, expiredChain, san };
}

// ---------------------------------------------------------------- TLS prober (real network I/O)
function probeTLS(host, port = DEFAULT_PORT, { timeoutMs = PROBE_TIMEOUT_MS, tlsImpl = tls } = {}) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (r) => { if (!done) { done = true; resolve(r); } };
        let socket;
        try {
            const opts = { host, port: parseInt(port, 10), rejectUnauthorized: false };
            if (!net.isIP(host)) opts.servername = host;
            socket = tlsImpl.connect(opts, () => {
                try {
                    const cert = socket.getPeerCertificate(true);
                    if (cert && cert.valid_to) {
                        const notAfter = new Date(cert.valid_to);
                        const notBefore = new Date(cert.valid_from);
                        const trust = evaluateTrust({ host, authorized: socket.authorized, authorizationError: socket.authorizationError, cert });
                        finish({
                            success: true,
                            subject: (cert.subject && cert.subject.CN) || host,
                            issuer: (cert.issuer && cert.issuer.CN) || 'Unknown Issuer',
                            validFrom: toDay(notBefore),
                            validTo: toDay(notAfter),
                            notBefore: notBefore.toISOString(),
                            notAfter: notAfter.toISOString(),
                            fingerprint256: cert.fingerprint256 || '',
                            ...trust,
                        });
                    } else {
                        finish({ success: false, error: 'Could not retrieve certificate information' });
                    }
                } catch (e) {
                    finish({ success: false, error: e.message });
                }
                socket.destroy();
            });
            socket.on('error', (err) => { finish({ success: false, error: err.message }); socket.destroy(); });
            socket.setTimeout(timeoutMs, () => { socket.destroy(); finish({ success: false, error: `Connection timeout (${Math.round(timeoutMs / 1000)}s)` }); });
        } catch (e) {
            finish({ success: false, error: e.message });
            try { socket && socket.destroy(); } catch (_) { /* ignore */ }
        }
    });
}

// ---------------------------------------------------------------- hooks (test seams)
const defaultHooks = {
    probe: (host, port) => probeTLS(host, port),
    runPowerShell: (...a) => require('./powershell').runPowerShell(...a),
    sendAlert: (message, moduleName) => require('./logger').sendTelegramAlert(message, moduleName),
};
const hooks = { ...defaultHooks };
function setHooks(h) { Object.assign(hooks, h || {}); }
function resetHooks() { Object.assign(hooks, defaultHooks); }

// ---------------------------------------------------------------- projection
const SECRET_FIELDS = ['encryptedKey', 'encryptedPass', 'encryptedFile'];

/** Record as served to clients: no encrypted material, has* booleans, status/days computed at read time. */
function publicRecord(record, now = new Date(), threshold = DEFAULT_THRESHOLD_DAYS) {
    const out = { ...record };
    for (const f of SECRET_FIELDS) delete out[f];
    out.hasKey = !!record.encryptedKey;
    out.hasFile = !!record.encryptedFile;
    out.hasCertText = !!(record.certText && String(record.certText).trim());
    out.fileOnly = isFileOnly(record);
    if (out.fileOnly && !out.host) out.host = FILE_ONLY_HOST; // legacy display value
    const s = computeStatus(record, now, threshold);
    out.daysRemaining = s.daysRemaining;
    out.status = s.status;
    return out;
}

module.exports = {
    FILE_ONLY_HOST, DAY_MS, DEFAULT_PORT, DEFAULT_THRESHOLD_DAYS, MAX_FILE_BYTES, MAX_NAME_LENGTH, NO_DAYS,
    PROBE_TIMEOUT_MS, EXPIRY_LEVELS, PFX_SCRIPT, SECRET_FIELDS,
    thresholdDays, normalizeHost, normalizePort, normalizeName, isFileOnly, newId,
    daysUntil, expiryOf, statusForDays, computeStatus, expiryLevel, decideAlerts,
    parseX509, parseSan, normalizeFileType, decodeUpload, parsePfx, parseUpload, parseScriptResult,
    evaluateTrust, probeTLS, hooks, setHooks, resetHooks, publicRecord,
};
