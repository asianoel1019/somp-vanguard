// Starts the license issuer on http://127.0.0.1:<PORT>/ (settings in license-issuer/.env). Never listens elsewhere.
const http = require('http');
const { loadEnv, readConfig } = require('./config');
const { checkStartup } = require('./startup');
const { createAudit } = require('./audit');
const { createApp } = require('./app');

const config = readConfig(loadEnv());
const { errors, privateKey } = checkStartup(config);
if (errors.length) {
    console.error('[license-issuer] Cannot start, fix license-issuer/.env:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
}

const app = createApp({ config, privateKey, audit: createAudit(config.logDir) });
const server = http.createServer(app);
server.on('error', (err) => {
    console.error(`[license-issuer] Cannot listen on ${config.host}:${config.port}: ${err.code || err.message}`);
    process.exit(1);
});
server.listen(config.port, config.host, () => {
    console.log(`[license-issuer] Open http://${config.host}:${config.port}/ (key ${config.keyId})`);
    console.log(`[license-issuer] Licenses: ${config.issuedDir}`);
    console.log(`[license-issuer] Registry: ${config.registryFile}`);
});
