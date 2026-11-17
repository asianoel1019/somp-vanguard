#!/usr/bin/env node
/**
 * Creates the Ed25519 key pair that signs SOMP Vanguard licenses (vendor only; never run on a customer server).
 *
 *   scripts\License_Keygen.bat --out <folder outside the repo> [--key-id k1]
 *
 * Writes <folder>\<keyId>-private.pem (keep it offline, never commit it) and <folder>\<keyId>-public.pem, and prints
 * the public key: paste it into backend/lib/licenseKeys.js as KEYS['<keyId>']. Refuses to overwrite existing files.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function arg(argv, name) {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
}

function main(argv = process.argv.slice(2)) {
    const out = arg(argv, '--out');
    const keyId = arg(argv, '--key-id') || 'k1';
    if (!out) { console.error('Usage: License_Keygen.bat --out <folder> [--key-id k1]'); return 1; }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(keyId)) { console.error('Key id: letters, digits, _ or -, at most 32'); return 1; }
    const privFile = path.join(out, `${keyId}-private.pem`);
    const pubFile = path.join(out, `${keyId}-public.pem`);
    if (fs.existsSync(privFile) || fs.existsSync(pubFile)) { console.error(`${privFile} or ${pubFile} already exists; nothing written.`); return 1; }
    fs.mkdirSync(out, { recursive: true });
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pub = publicKey.export({ type: 'spki', format: 'pem' });
    fs.writeFileSync(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pubFile, pub);
    console.log(`Private key: ${privFile}  (keep offline; never commit or copy to a customer server)`);
    console.log(`Public key:  ${pubFile}`);
    console.log(`\nAdd to backend/lib/licenseKeys.js:\n    ${keyId}: \`${pub.trim()}\`,`);
    return 0;
}

if (require.main === module) process.exit(main());
module.exports = { main };
