#!/usr/bin/env node
/**
 * Signs a SOMP Vanguard license file (vendor only).
 *
 *   scripts\License_Issue.bat --key <keyId-private.pem> --customer "<customer name>" --id L-2026-0001
 *                             --expires YYYY-MM-DD --out <file.lic>
 *                             [--key-id k1] [--issued YYYY-MM-DD] [--registry <file.md>] [--db <file.db>]
 *                             [--force]   (overwrite an existing --out file)
 *                             [--contact-vendor "<vendor name>"] [--contact-email <email>]
 *                             [--sales "<name>"] [--amount <n>] [--currency <code>] [--order <no>] [--trial]
 *
 * --contact-vendor / --contact-email (optional) are signed into the license as the vendor contact the product shows its
 * users for renewals (locked features, expiry reminders). Without either, the license has no contact.
 *
 * Every license is recorded in the license-issuer database (default: license-issuer.db next to the private key; the
 * license-issuer web app uses the same file), and the Markdown registry (default: issued-licenses.md next to the key)
 * is regenerated from it. On first use an existing registry is imported into an empty database (backup first).
 * The customer is found by name (ignoring case) or created. --sales must name an active sales person of the database
 * (a warning when it is missing); --amount / --currency / --order are business data kept only in the database.
 * --trial issues a trial license (one per customer, at most 60 days, amount 0; the license carries trial: true).
 *
 * The license is verified with the public keys built into this checkout (backend/lib/licenseKeys.js) before it is
 * written: a key the product does not trust writes nothing. updatesUntil is reserved (null).
 *
 * Exit codes: 0 ok, 1 refused (nothing written), 2 license issued and recorded but the registry copy was not regenerated.
 * The logic lives in license-issuer/src/store (shared with the license-issuer web app); this file is the command line.
 */
const fs = require('fs');
const path = require('path');
const core = require(path.join(__dirname, 'licenseIssuerCore'));
const { escapeCell, registryRow, nextLicenseId, today, daysBetween } = core;

const STORE = path.join(__dirname, '..', 'license-issuer', 'src', 'store');
const USAGE = 'Usage: License_Issue.bat --key <private.pem> --customer "<name>" --id <L-YYYY-NNNN> --expires YYYY-MM-DD --out <file.lic> [--key-id k1] [--issued YYYY-MM-DD] [--registry <file.md>] [--db <file.db>] [--force] [--contact-vendor "<name>"] [--contact-email <email>] [--sales "<name>"] [--amount <n>] [--currency <code>] [--order <no>] [--trial]';
const VALUE_FLAGS = ['--key', '--customer', '--id', '--expires', '--out', '--key-id', '--issued', '--registry', '--contact-vendor', '--contact-email',
    '--db', '--sales', '--amount', '--currency', '--order'];

/** Value after a flag: '' when the flag is absent, null when it is there but the next token is missing or another flag. */
function arg(argv, name) {
    const i = argv.indexOf(name);
    if (i < 0) return '';
    const v = i + 1 < argv.length ? argv[i + 1] : '';
    return v === '' || v.startsWith('--') ? null : v;
}

/** Checks of the business flags without the database: { values } or { error } (message for the console). */
function businessFlags(argv, R, { issuedAt, expiresAt }) {
    const trial = argv.includes('--trial');
    let amount;
    const rawAmount = arg(argv, '--amount');
    try { amount = R.amount(rawAmount === '' ? undefined : rawAmount); } catch {
        return { error: `--amount must be a number of 0 or more with at most 2 decimals (got "${rawAmount}")` };
    }
    let currency;
    const rawCurrency = arg(argv, '--currency');
    if (rawCurrency) {
        try { currency = R.currency(rawCurrency, null); } catch { return { error: `--currency must be one of ${R.CURRENCIES.join(', ')} (got "${rawCurrency}")` }; }
    }
    let orderNo;
    try { orderNo = R.text(arg(argv, '--order'), { field: 'orderNo', label: '--order', max: R.LIMITS.orderNo }); } catch (e) {
        return { error: e.message.replace(/\.$/, '') };
    }
    if (trial) {
        if (amount) return { error: '--trial: a trial license is free, --amount must be 0 (or left out)' };
        const days = R.termDays(issuedAt, expiresAt);
        if (days > R.TRIAL_MAX_DAYS) return { error: `--trial: a trial license can be valid for at most ${R.TRIAL_MAX_DAYS} days (--issued to --expires is ${days} days)` };
    }
    const salesName = arg(argv, '--sales').trim();
    return { values: { trial, amount: amount === null ? undefined : amount, currency, orderNo: orderNo === null ? undefined : orderNo, salesName } };
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
    const force = argv.includes('--force');
    if (!keyFile || !customer || !licenseId || !expiresAt || !out) { console.error(USAGE); return 1; }
    if (argv.includes('--allow-duplicate-id')) {
        console.error('--allow-duplicate-id is no longer supported: license IDs are unique in the license-issuer database. '
            + 'Use a new --id, or replace the license in the license-issuer web app. Nothing was written.');
        return 1;
    }
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
    const contactInput = { vendor: arg(argv, '--contact-vendor'), email: arg(argv, '--contact-email') };
    const contact = core.makeContact(contactInput);
    if (contact.error) {
        console.error(contact.field === 'vendor'
            ? `--contact-vendor must be at most ${core.CONTACT_VENDOR_MAX} characters`
            : contact.error.includes('at most')
                ? `--contact-email must be at most ${core.CONTACT_EMAIL_MAX} characters`
                : `--contact-email must look like name@domain (got "${contactInput.email}")`);
        return 1;
    }
    const S = require(STORE);
    const biz = businessFlags(argv, S.rules, { issuedAt, expiresAt });
    if (biz.error) { console.error(biz.error); return 1; }
    const { trial, amount, currency, orderNo, salesName } = biz.values;

    const registry = path.resolve(arg(argv, '--registry') || path.join(path.dirname(keyFile), 'issued-licenses.md'));
    const dbFile = path.resolve(arg(argv, '--db') || S.defaultDbFile(keyFile));
    if ([keyFile, registry, dbFile].some((f) => core.samePath(out, f))) { console.error('--out must not be the private key, the registry or the database'); return 1; }
    if (fs.existsSync(out) && !force) {
        console.error(`${out} already exists. Choose another --out, or add --force to overwrite it.`);
        return 1;
    }

    let store;
    try {
        store = S.openStore(dbFile, { registryFile: registry });
    } catch (e) {
        console.error(`Cannot open the database ${dbFile} (${e.message}). Nothing was written.`);
        return 1;
    }
    try {
        return issueWithStore(S, store, {
            keyFile, keyId, customer, licenseId, issuedAt, expiresAt, out, force, contactInput, trial, amount, currency, orderNo, salesName, registry, dbFile,
        });
    } finally {
        store.close();
    }
}

function issueWithStore(S, store, a) {
    try {
        const imp = store.importRegistryIfNeeded();
        if (imp.status === 'imported') {
            console.log(`Imported ${imp.imported} license(s) from ${a.registry} into ${a.dbFile} (backup: ${imp.backup}).`);
            for (const u of imp.unreadable) console.error(`  Not imported, line ${u.line} (unreadable): ${u.text}`);
            for (const d of imp.duplicates) console.error(`  Not imported, line ${d.line}: ${d.licenseId} is listed again on line ${d.keptLine} (that row was imported).`);
        }
    } catch (e) {
        if (e.code === 'registry-unreadable') console.error(`${e.message} Nothing was written.`);
        else if (e.code === 'locked') console.error(`The registry ${a.registry} is locked by another writer (${a.registry}.lock). Try again; nothing was written.`);
        else console.error(e.message);
        return 1;
    }

    const r = S.issueLicense(store, {
        keyFile: a.keyFile, keyId: a.keyId, customerName: a.customer, createCustomer: true, licenseId: a.licenseId, issuedAt: a.issuedAt,
        expiresAt: a.expiresAt, type: a.trial ? 'trial' : 'paid', salesName: a.salesName || undefined, amount: a.amount, currency: a.currency,
        orderNo: a.orderNo, contact: a.contactInput, out: a.out, overwrite: a.force, source: 'cli',
    });
    if (!r.ok) {
        const msg = {
            'out-protected': () => '--out must not be the private key, the registry or the database',
            'out-exists': () => `${a.out} already exists. Choose another --out, or add --force to overwrite it.`,
            locked: () => `The registry ${a.registry} is locked by another writer (${a.registry}.lock). Try again; nothing was written.`,
            'duplicate-id': () => `License ID ${a.licenseId} is already issued (database ${a.dbFile}). Use a new ID (next: ${r.next}).`,
            'not-found': () => (r.field === 'salesId' ? `--sales: ${r.message} Add the sales person in the license-issuer web app first.` : r.message),
            'sales-inactive': () => `--sales: ${r.message}`,
            invalid: () => (r.field === 'customer' ? `--customer: ${r.message}` : r.message),
        }[r.code];
        console.error(msg ? msg() : r.message);
        return 1;
    }
    let rc = 0;
    if (r.registryError) {
        console.error(`WARNING: the license was issued and recorded in the database ${a.dbFile}, but the registry copy ${a.registry} was not regenerated `
            + `(${r.registryError.message}). It is regenerated after the next change.`);
        rc = 2;
    }
    if (r.warnings.includes('no-sales')) {
        console.error('WARNING: no --sales given: the license is recorded without a sales person (set it later in the license-issuer web app).');
    }

    const l = r.license;
    console.log(`Issued ${l.licenseId} to "${l.licensedTo}"`);
    if (l.type === 'trial') console.log('  Type:    Trial');
    console.log(`  Issued:  ${l.issuedAt}`);
    console.log(`  Expires: ${l.expiresAt} (${daysBetween(today(), l.expiresAt)} days from today)`);
    if (l.salesName) console.log(`  Sales:   ${l.salesName}`);
    if (l.amount !== null && l.type === 'paid') console.log(`  Amount:  ${l.amount} ${l.currency}`);
    if (l.orderNo) console.log(`  Order:   ${l.orderNo}`);
    if (r.contact) console.log(`  Contact: ${core.contactText(r.contact)}`);
    console.log(`  File:    ${a.out}`);
    console.log(`  Database: ${a.dbFile}`);
    if (rc === 0) {
        console.log(`  Registry: ${a.registry}`);
        console.log(`  Next ID: ${r.nextId}`);
    }
    return rc;
}

if (require.main === module) process.exit(main());
module.exports = { main, registryRow, nextLicenseId, escapeCell };
