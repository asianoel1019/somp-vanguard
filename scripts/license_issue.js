#!/usr/bin/env node
/**
 * Signs a SOMP Vanguard license file (vendor only).
 *
 *   scripts\License_Issue.bat --key <keyId-private.pem> --customer "<customer name>" --id L-2026-0001 --out <file.lic>
 *                             [--key-id k1] [--issued YYYY-MM-DD]
 *
 * The license is verified with the public keys built into this checkout (backend/lib/licenseKeys.js) before it is
 * written: a key the product does not trust writes nothing. updatesUntil is reserved (null).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson, verifyLicense } = require(path.join(__dirname, '..', 'backend', 'lib', 'license'));

function arg(argv, name) {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
}

function main(argv = process.argv.slice(2)) {
    const keyFile = arg(argv, '--key');
    const customer = arg(argv, '--customer').trim();
    const licenseId = arg(argv, '--id').trim();
    const out = arg(argv, '--out');
    const keyId = arg(argv, '--key-id') || 'k1';
    const issuedAt = arg(argv, '--issued') || new Date().toISOString().slice(0, 10);
    if (!keyFile || !customer || !licenseId || !out) {
        console.error('Usage: License_Issue.bat --key <private.pem> --customer "<name>" --id <licenseId> --out <file.lic> [--key-id k1] [--issued YYYY-MM-DD]');
        return 1;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedAt)) { console.error('--issued must be YYYY-MM-DD'); return 1; }
    let key;
    try { key = crypto.createPrivateKey(fs.readFileSync(keyFile)); } catch (e) { console.error(`Cannot read the private key: ${e.message}`); return 1; }
    const payload = { formatVersion: 1, keyId, licenseId, customer, edition: 'paid', issuedAt, updatesUntil: null };
    const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64');
    const text = JSON.stringify({ payload, signature }, null, 2);
    const check = verifyLicense(text);
    if (!check.valid) { console.error(`Not written: the product would reject this license (${check.reason}).`); return 1; }
    fs.writeFileSync(out, text + '\n');
    console.log(`Issued ${licenseId} to "${customer}" (${issuedAt}, key ${keyId}) -> ${out}`);
    return 0;
}

if (require.main === module) process.exit(main());
module.exports = { main };
