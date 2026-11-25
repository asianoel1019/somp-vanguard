// Settings of the license issuer, from license-issuer/.env (KEY=VALUE lines) and the process environment.
const fs = require('fs');
const path = require('path');
const { makeContact, CONTACT_VENDOR_MAX, CONTACT_EMAIL_MAX } = require(path.join(__dirname, '..', '..', 'scripts', 'licenseIssuerCore'));

const APP_DIR = path.join(__dirname, '..');
const HOST = '127.0.0.1'; // never anything else: the app is for the signing computer only

/** KEY=VALUE lines; # comments; optional surrounding quotes; backslashes kept as typed (C:\keys\k1-private.pem). */
function parseEnvFile(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 1) continue;
        const key = t.slice(0, eq).trim();
        let value = t.slice(eq + 1).trim();
        if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) value = value.slice(1, -1);
        out[key] = value;
    }
    return out;
}

function loadEnv(dir = APP_DIR) {
    const file = path.join(dir, '.env');
    const fromFile = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
    return { ...fromFile, ...process.env };
}

/** A single mail address that is safe to hand to SMTP: no spaces, quotes, commas, brackets or comments; at most 200. */
const MAIL_ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const isMailAddress = (v) => typeof v === 'string' && v.length <= 200 && MAIL_ADDRESS.test(v);

/** MAIL_FROM: "address" or "Display Name <address>" -> { name, address } or null. */
function parseFrom(text) {
    const t = String(text || '').trim();
    if (/[\x00-\x1f\x7f]/.test(t)) return null;
    const m = /^(.*?)\s*<([^<>]+)>$/.exec(t);
    const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1') : '';
    const address = m ? m[2].trim() : t;
    if (!isMailAddress(address) || /[<>"]/.test(name) || name.length > 100) return null;
    return { name, address };
}

/**
 * Mail settings (SMTP_HOST, SMTP_PORT default 587, SMTP_SECURE true/false, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_ADMIN).
 * Missing or invalid values never stop the app: mail is then disabled and `reason` says why. The password is a
 * non-enumerable property, so it never shows up when the settings are logged or serialised.
 */
function readMailConfig(env) {
    const v = (k) => String(env[k] === undefined || env[k] === null ? '' : env[k]).trim();
    const problems = [];
    const host = v('SMTP_HOST');
    if (!host) problems.push('SMTP_HOST is not set');
    else if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) problems.push('SMTP_HOST must be a host name or IP address');
    const rawPort = v('SMTP_PORT') || '587';
    const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
    if (!(port >= 1 && port <= 65535)) problems.push('SMTP_PORT must be 1-65535');
    const rawSecure = v('SMTP_SECURE').toLowerCase();
    let secure = false;
    if (['true', '1', 'yes'].includes(rawSecure)) secure = true;
    else if (!['', 'false', '0', 'no'].includes(rawSecure)) problems.push('SMTP_SECURE must be true or false');
    const user = v('SMTP_USER');
    const pass = String(env.SMTP_PASS === undefined || env.SMTP_PASS === null ? '' : env.SMTP_PASS);
    if (pass && !user) problems.push('SMTP_PASS is set but SMTP_USER is empty');
    const fromText = v('MAIL_FROM');
    const from = fromText ? parseFrom(fromText) : null;
    if (!fromText) problems.push('MAIL_FROM is not set');
    else if (!from) problems.push('MAIL_FROM must be an address like name@example.test or "Name <name@example.test>"');
    const admin = v('MAIL_ADMIN');
    if (admin && !isMailAddress(admin)) problems.push('MAIL_ADMIN must be one address like name@example.test');
    const mail = { enabled: problems.length === 0, reason: problems.join('; '), host, port, secure, user, from, admin };
    Object.defineProperty(mail, 'pass', { value: pass, enumerable: false });
    return mail;
}

/** The checked settings: { ..., errors: [] }. The server refuses to start while errors is not empty. */
function readConfig(env, appDir = APP_DIR) {
    const errors = [];
    const rawPort = String(env.PORT || '8444').trim();
    const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('PORT must be 1-65535');

    const keyFile = String(env.KEY_FILE || '').trim();
    if (!keyFile) errors.push('KEY_FILE is required: the private key file (for example C:\\keys\\k1-private.pem)');
    const keyId = String(env.KEY_ID || 'k1').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) errors.push('KEY_ID must be letters, digits, _ or - (for example k1)');
    const keyDir = keyFile ? path.dirname(path.resolve(keyFile)) : appDir;

    const passwordHash = String(env.PASSWORD_HASH || '').trim();
    if (!passwordHash) errors.push('PASSWORD_HASH is missing: run Set_Password.bat first');

    // Defaults for the Vendor / Contact email fields of the issue form (both optional), checked with the product's rules.
    const contactVendor = String(env.CONTACT_VENDOR || '').trim();
    const contactEmail = String(env.CONTACT_EMAIL || '').trim();
    if (contactVendor.length > CONTACT_VENDOR_MAX) errors.push(`CONTACT_VENDOR must be at most ${CONTACT_VENDOR_MAX} characters`);
    if (contactEmail && makeContact({ email: contactEmail }).error) {
        errors.push(contactEmail.length > CONTACT_EMAIL_MAX
            ? `CONTACT_EMAIL must be at most ${CONTACT_EMAIL_MAX} characters`
            : `CONTACT_EMAIL must be an email address like name@domain (got "${contactEmail}")`);
    }

    return {
        host: HOST,
        port,
        keyFile: keyFile ? path.resolve(keyFile) : '',
        keyId,
        issuedDir: path.resolve(String(env.ISSUED_DIR || '').trim() || path.join(keyDir, 'issued')),
        registryFile: path.resolve(String(env.REGISTRY_FILE || '').trim() || path.join(keyDir, 'issued-licenses.md')),
        // the database (source of truth; the registry above is regenerated from it), default next to the key
        dbFile: path.resolve(String(env.DB_FILE || '').trim() || path.join(keyDir, 'license-issuer.db')),
        passwordHash,
        contactDefaults: { vendor: contactVendor, email: contactEmail },
        // optional SMTP settings (mail disabled with a reason when incomplete; never a start error)
        mail: readMailConfig(env),
        logDir: path.join(appDir, 'logs'),
        errors,
    };
}

module.exports = { APP_DIR, HOST, parseEnvFile, loadEnv, readConfig, readMailConfig, isMailAddress, parseFrom, MAIL_ADDRESS };
