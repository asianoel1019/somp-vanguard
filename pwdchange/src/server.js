// Starts the password change page: HTTPS with HTTPS_PFX_PATH, or HTTP only when ALLOW_HTTP=true (trial).
const fs = require('fs');
const http = require('http');
const https = require('https');
const { loadEnv, readConfig } = require('./config');
const ad = require('./ad');
const { createAudit } = require('./audit');
const { createMailer } = require('./mail');
const { createApp } = require('./app');

const config = readConfig(loadEnv());
if (config.errors.length) {
    console.error('[pwdchange] Cannot start, fix pwdchange/.env:');
    for (const e of config.errors) console.error(`  - ${e}`);
    process.exit(1);
}
if (!config.ous.length) console.warn('[pwdchange] ALLOWED_OUS is empty: every enabled account in the domain (except protected ones) may use the page.');

const app = createApp({
    config,
    ad,
    audit: createAudit(config.logDir),
    sendChanged: createMailer(config.smtp, config.adminContact),
});

let server;
if (config.allowHttp) {
    console.warn('[pwdchange] ALLOW_HTTP=true: passwords travel unencrypted. Use this for a trial only.');
    server = http.createServer(app);
} else {
    server = https.createServer({ pfx: fs.readFileSync(config.pfxPath), passphrase: config.pfxPassphrase || undefined, minVersion: 'TLSv1.2' }, app);
}
server.listen(config.port, () => {
    console.log(`[pwdchange] Listening on ${config.allowHttp ? 'http' : 'https'}://0.0.0.0:${config.port} for ${config.nets.map(n => n.text).join(', ')}`);
});
