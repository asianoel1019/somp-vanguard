// Settings of the password change page, from pwdchange/.env (KEY=VALUE lines) and the process environment.
const fs = require('fs');
const path = require('path');
const { parseNets } = require('./net');
const { splitDns, isScopeDn } = require('./scope');

/** KEY=VALUE lines; # comments; optional surrounding quotes; backslashes kept as typed (CORP\svc). */
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

function loadEnv(dir = path.join(__dirname, '..')) {
    const file = path.join(dir, '.env');
    const fromFile = fs.existsSync(file) ? parseEnvFile(fs.readFileSync(file, 'utf8')) : {};
    return { ...fromFile, ...process.env };
}

const truthy = (v) => String(v || '').trim().toLowerCase() === 'true';

/**
 * The checked settings: { ..., errors: [] }. The server refuses to start while errors is not empty.
 */
function readConfig(env) {
    const errors = [];
    const port = Number(env.PORT || 8443);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('PORT must be 1-65535');

    const allowHttp = truthy(env.ALLOW_HTTP);
    const pfxPath = String(env.HTTPS_PFX_PATH || '').trim();
    if (!allowHttp && !pfxPath) errors.push('HTTPS_PFX_PATH is required (or ALLOW_HTTP=true for a trial)');

    const nets = parseNets(env.ALLOWED_NETS);
    if (nets.error) errors.push(`ALLOWED_NETS: ${nets.error}`);
    else if (!nets.list.length) errors.push('ALLOWED_NETS is empty: set the internal networks that may use the page (for example 10.0.0.0/8)');

    const serviceUser = String(env.AD_SERVICE_USER || '').trim();
    const servicePassword = String(env.AD_SERVICE_PWD || '');
    if (!serviceUser || !servicePassword) errors.push('AD_SERVICE_USER and AD_SERVICE_PWD are required');

    const ous = splitDns(env.ALLOWED_OUS);
    const badOu = ous.find(d => !isScopeDn(d));
    if (badOu) errors.push(`ALLOWED_OUS has an entry that is not an OU distinguished name: ${badOu.slice(0, 120)}`);

    const smtp = {
        host: String(env.SMTP_HOST || '').trim(),
        port: Number(env.SMTP_PORT || 25),
        secure: truthy(env.SMTP_SECURE),
        user: String(env.SMTP_USER || '').trim(),
        password: String(env.SMTP_PWD || ''),
        from: String(env.SMTP_FROM || '').trim(),
    };

    return {
        port,
        allowHttp,
        pfxPath,
        pfxPassphrase: String(env.HTTPS_PFX_PASSPHRASE || ''),
        nets: nets.list || [],
        trustProxy: truthy(env.TRUST_PROXY),
        adServer: String(env.AD_SERVER || '').trim(),
        serviceUser,
        servicePassword,
        ous,
        adminContact: String(env.ADMIN_CONTACT || '').trim().slice(0, 300),
        smtp: smtp.host && smtp.from ? smtp : null,
        logDir: path.resolve(String(env.LOG_DIR || path.join(__dirname, '..', 'logs'))),
        errors,
    };
}

module.exports = { parseEnvFile, loadEnv, readConfig };
