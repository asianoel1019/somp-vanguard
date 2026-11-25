#!/usr/bin/env node
/**
 * Signs a SOMP Vanguard license file (vendor only).
 *
 *   scripts\License_Issue.bat --key <keyId-private.pem> --customer "<customer name>" --id L-2026-0001
 *                             --expires YYYY-MM-DD --out <file.lic>
 *                             [--key-id k1] [--issued YYYY-MM-DD] [--registry <file.md>] [--allow-duplicate-id]
 *                             [--force]   (overwrite an existing --out file)
 *
 * The license is verified with the public keys built into this checkout (backend/lib/licenseKeys.js) before it is
 * written: a key the product does not trust writes nothing. updatesUntil is reserved (null).
 * Every issued license is appended to a Markdown registry (default: issued-licenses.md next to the private key).
 *
 * Exit codes: 0 ok, 1 refused (nothing written), 2 license written but the registry was not updated.
 * The logic lives in licenseIssuerCore.js (shared with the license-issuer web app); this file is the command line.
 */
const path = require('path');
const core = require(path.join(__dirname, 'licenseIssuerCore'));
const { escapeCell, registryRow, nextLicenseId, today, daysBetween } = core;

const USAGE = 'Usage: License_Issue.bat --key <private.pem> --customer "<name>" --id <L-YYYY-NNNN> --expires YYYY-MM-DD --out <file.lic> [--key-id k1] [--issued YYYY-MM-DD] [--registry <file.md>] [--allow-duplicate-id] [--force]';
const VALUE_FLAGS = ['--key', '--customer', '--id', '--expires', '--out', '--key-id', '--issued', '--registry'];

/** Value after a flag: '' when the flag is absent, null when it is there but the next token is missing or another flag. */
function arg(argv, name) {
    const i = argv.indexOf(name);
    if (i < 0) return '';
    const v = i + 1 < argv.length ? argv[i + 1] : '';
    return v === '' || v.startsWith('--') ? null : v;
}

function main(argv = process.argv.slice(2)) {
    const noValue = VALUE_FLAGS.filter((f) => arg(argv, f) === null);
    if (noValue.length) { console.error(`Missing value for ${noValue.join(', ')}`); console.error(USAGE); return 1; }
    const keyFile = arg(argv, '--key');
    const customer = arg(argv, '--customer').trim();
    const licenseId = arg(argv, '--id').trim();
    const expiresAt = arg(argv, '--expires').trim();
    const out = arg(argv, '--out');
    const keyId = arg(argv, '--key-id') || 'k1';
    const issuedAt = arg(argv, '--issued') || today();
    const allowDup = argv.includes('--allow-duplicate-id');
    const force = argv.includes('--force');
    if (!keyFile || !customer || !licenseId || !expiresAt || !out) { console.error(USAGE); return 1; }
    const invalid = core.validateIssueFields({ licenseId, issuedAt, expiresAt }, today());
    if (invalid) {
        console.error({
            'id-format': `--id must look like L-YYYY-NNNN (got "${licenseId}")`,
            'issued-date': '--issued must be a real date in YYYY-MM-DD format',
            'expires-date': '--expires must be a real date in YYYY-MM-DD format',
            'expires-past': `--expires is in the past (${expiresAt}, today is ${today()})`,
            'expires-before-issued': '--expires is before --issued',
        }[invalid]);
        return 1;
    }

    const registry = arg(argv, '--registry') || path.join(path.dirname(keyFile), 'issued-licenses.md');
    const r = core.issueLicense({
        keyFile, keyId, customer, licenseId, issuedAt, expiresAt, out, registry, allowDuplicate: allowDup, overwrite: allowDup || force,
    });
    if (!r.ok) {
        const msg = {
            'out-protected': () => '--out must not be the private key or the registry',
            'out-exists': () => `${out} already exists. Choose another --out, or add --force (or --allow-duplicate-id) to overwrite it.`,
            'registry-locked': () => `${r.error.message}. Try again; nothing was written.`,
            'registry-unreadable': () => `Cannot read the registry ${registry} (${r.error && r.error.message}). Nothing was written.`,
            'duplicate-id': () => `License ID ${licenseId} is already in the registry (${registry}). Use a new ID (next: ${r.next}) or --allow-duplicate-id.`,
            'key-unreadable': () => `Cannot read the private key: ${r.error.message}`,
            rejected: () => `Not written: the product would reject this license (${r.reason}).`,
            'write-failed': () => `Cannot write ${out}: ${r.error.message}`,
        }[r.code];
        console.error(msg ? msg() : `Not written (${r.code}).`);
        return 1;
    }
    let rc = 0;
    if (r.registryError) {
        console.error(`WARNING: the license was written but the registry was not updated (${r.registryError.message}). Add this row to ${registry}:`);
        console.error(r.row);
        rc = 2;
    }

    console.log(`Issued ${licenseId} to "${customer}"`);
    console.log(`  Issued:  ${issuedAt}`);
    console.log(`  Expires: ${expiresAt} (${daysBetween(today(), expiresAt)} days from today)`);
    console.log(`  File:    ${out}`);
    if (rc === 0) {
        console.log(`  Registry: ${registry}`);
        console.log(`  Next ID: ${nextLicenseId(r.registryText, r.year)}`);
    }
    return rc;
}

if (require.main === module) process.exit(main());
module.exports = { main, registryRow, nextLicenseId, escapeCell };
