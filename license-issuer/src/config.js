// Settings of the license issuer, from license-issuer/.env (KEY=VALUE lines) and the process environment.
const fs = require('fs');
const path = require('path');

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

    return {
        host: HOST,
        port,
        keyFile: keyFile ? path.resolve(keyFile) : '',
        keyId,
        issuedDir: path.resolve(String(env.ISSUED_DIR || '').trim() || path.join(keyDir, 'issued')),
        registryFile: path.resolve(String(env.REGISTRY_FILE || '').trim() || path.join(keyDir, 'issued-licenses.md')),
        passwordHash,
        logDir: path.join(appDir, 'logs'),
        errors,
    };
}

module.exports = { APP_DIR, HOST, parseEnvFile, loadEnv, readConfig };
