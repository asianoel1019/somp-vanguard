// Starts the license issuer on http://127.0.0.1:<PORT>/ (settings in license-issuer/.env). Never listens elsewhere.
const http = require('http');
const { loadEnv, readConfig } = require('./config');
const { checkStartup, prepareStore, importSummary } = require('./startup');
const { createAudit } = require('./audit');
const { createApp } = require('./app');

const config = readConfig(loadEnv());
const { errors, privateKey } = checkStartup(config);
if (errors.length) {
    console.error('[license-issuer] Cannot start, fix license-issuer/.env:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
}
const prepared = prepareStore(config);
if (prepared.errors.length) {
    console.error('[license-issuer] Cannot start, the database is not ready:');
    for (const e of prepared.errors) console.error(`  - ${e}`);
    process.exit(1);
}
for (const line of importSummary(prepared.imported)) console.log(`[license-issuer] ${line}`);

const app = createApp({ config, privateKey, store: prepared.store, audit: createAudit(config.logDir) });
const server = http.createServer(app);
server.on('error', (err) => {
    console.error(`[license-issuer] Cannot listen on ${config.host}:${config.port}: ${err.code || err.message}`);
    process.exit(1);
});
server.listen(config.port, config.host, () => {
    console.log(`[license-issuer] Open http://${config.host}:${config.port}/ (key ${config.keyId})`);
    console.log(`[license-issuer] Licenses: ${config.issuedDir}`);
    console.log(`[license-issuer] Database: ${config.dbFile}`);
    console.log(`[license-issuer] Registry: ${config.registryFile} (generated copy)`);
    const mail = app.locals.mailer.status();
    if (mail.enabled) {
        console.log(`[license-issuer] Mail: ${mail.host}:${mail.port} from ${mail.from}${mail.admin ? `, digest summary to ${mail.admin}` : ' (MAIL_ADMIN not set: no digest summary)'}`);
        app.locals.digest.start(); // weekly digest: checks every 10 minutes (unref'd timer)
    } else {
        console.log(`[license-issuer] Mail: disabled (${mail.reason}); delivery mails and the weekly digest are off.`);
    }
});
