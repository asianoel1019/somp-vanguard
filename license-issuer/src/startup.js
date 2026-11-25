// Checks before the server listens: settings, password hash, a private key that the product trusts, and the database.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseHash } = require('./auth');
const { KEYS } = require(path.join(__dirname, '..', '..', 'backend', 'lib', 'licenseKeys'));
const { openStore } = require('./store');

/**
 * { errors: [], privateKey } — privateKey (a KeyObject, never logged or sent) only when every check passed.
 * The key must sign a probe that the built-in public key for KEY_ID verifies.
 */
function checkStartup(config, keys = KEYS) {
    const errors = [...config.errors];
    if (config.passwordHash && !parseHash(config.passwordHash)) errors.push('PASSWORD_HASH is not a valid scrypt hash: run Set_Password.bat again');

    let privateKey = null;
    if (config.keyFile) {
        try {
            privateKey = crypto.createPrivateKey(fs.readFileSync(config.keyFile));
            if (privateKey.asymmetricKeyType !== 'ed25519') { privateKey = null; errors.push('KEY_FILE is not an Ed25519 private key'); }
        } catch (e) {
            // the error code only: an OpenSSL message is harmless, but nothing about the key's content is ever printed
            errors.push(`KEY_FILE cannot be read as a private key: ${config.keyFile} (${(e && e.code) || 'not a private key'})`);
        }
    }
    const pem = Object.prototype.hasOwnProperty.call(keys, config.keyId) ? keys[config.keyId] : null;
    if (!pem) errors.push(`KEY_ID "${config.keyId}" has no built-in public key (backend/lib/licenseKeys.js)`);
    else if (privateKey) {
        const probe = Buffer.from(`license-issuer probe ${crypto.randomBytes(16).toString('hex')}`);
        let ok = false;
        try { ok = crypto.verify(null, probe, crypto.createPublicKey(pem), crypto.sign(null, probe, privateKey)); } catch { ok = false; }
        if (!ok) errors.push(`KEY_FILE does not match the built-in public key for KEY_ID "${config.keyId}": licenses signed with it would be rejected`);
    }
    if (!errors.length) {
        try { fs.mkdirSync(config.issuedDir, { recursive: true }); } catch (e) { errors.push(`ISSUED_DIR cannot be created: ${config.issuedDir} (${e.code || e.message})`); }
    }
    return errors.length ? { errors, privateKey: null } : { errors, privateKey };
}

/**
 * Opens the database (creating it when missing) and, on first use, imports the existing Markdown registry.
 * { errors: [], store, imported (importRegistryIfNeeded result) }; on an error the store is closed and null.
 */
function prepareStore(config, { now } = {}) {
    let store;
    try {
        store = openStore(config.dbFile, { registryFile: config.registryFile, now });
    } catch (e) {
        return { errors: [`DB_FILE cannot be opened: ${config.dbFile} (${e.message})`], store: null, imported: null };
    }
    try {
        return { errors: [], store, imported: store.importRegistryIfNeeded() };
    } catch (e) {
        store.close();
        return { errors: [e.message], store: null, imported: null };
    }
}

/** Console lines describing a first-use import (empty when nothing was imported). */
function importSummary(imported) {
    if (!imported || imported.status !== 'imported') return [];
    const lines = [`Imported ${imported.imported} license(s) from ${imported.file} (${imported.customersCreated} customer(s) created; backup: ${imported.backup}).`];
    for (const u of imported.unreadable) lines.push(`  Not imported, line ${u.line} (unreadable): ${u.text}`);
    for (const d of imported.duplicates) lines.push(`  Not imported, line ${d.line}: ${d.licenseId} is listed again on line ${d.keptLine} (that row was imported).`);
    if (imported.registryError) lines.push(`  The registry copy was not regenerated: ${imported.registryError.message}`);
    return lines;
}

module.exports = { checkStartup, prepareStore, importSummary };
