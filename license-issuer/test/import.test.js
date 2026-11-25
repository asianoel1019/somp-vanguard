// The Markdown registry: one-time import of a registry written by earlier versions (backup, counts, format-1 rows,
// unreadable lines, duplicates, idempotent, refusals), the generated read-only copy, and database backups.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const core = require('../../scripts/licenseIssuerCore');
const S = require('../src/store');
const { prepareStore, importSummary } = require('../src/startup');
const { tempStore, startApp, makeConfig, keyDir } = require('./helpers');

const row = (o) => core.registryRow({ licenseId: 'L-2025-0001', customer: 'Example Corp.', issuedAt: '2025-01-10', expiresAt: '2026-01-09',
    keyId: 'k1', file: 'C:\\keys\\issued\\L-2025-0001-example-corp.lic', sha256: 'ABCDEF012345', signedAt: '2025-01-10T10:00:00+08:00', ...o });

// line 5..: rows; the earlier L-2025-0003 row (line 8) is superseded by line 11
const LEGACY = [
    core.REGISTRY_HEADER.trimEnd(),
    row({}),
    row({ licenseId: 'L-2024-0007', issuedAt: '2024-06-01', expiresAt: '— (format 1, no expiry; reissued as L-2025-0001)', file: 'C:\\keys\\old.lic' }),
    row({ licenseId: 'L-2025-0002', customer: 'Other | Pipe Ltd.', issuedAt: '2025-03-01', expiresAt: '2027-02-28' }),
    row({ licenseId: 'L-2025-0003', customer: 'Third Co.', issuedAt: '2025-04-01', expiresAt: '2026-03-31', file: 'C:\\keys\\first.lic' }),
    '| L-2025-0004 | Too | Few |',
    'A note under the table.',
    row({ licenseId: 'L-2025-0003', customer: 'Third Co.', issuedAt: '2025-04-01', expiresAt: '2027-03-31', file: 'C:\\keys\\second.lic' }),
    '| l-2025-0005 | example corp. | 2025-05-01 | 2027-04-30 | k1 | C:\\keys\\x.lic | 0123456789ab | 2025-05-01T09:00:00+08:00 |',
    '| L-2025-0006 | Bad Date Co. | 2025-02-30 | 2027-04-30 | k1 | x | 0 | 0 |',
    '',
].join('\r\n');

test('import: every readable row becomes a license; format 1 kept; unreadable lines and duplicate IDs reported; backup first', (t) => {
    const ctx = tempStore(t, { before: (k, reg) => fs.writeFileSync(reg, LEGACY) });
    const { store, reg, k } = ctx;
    const r = store.importRegistryIfNeeded();
    assert.equal(r.status, 'imported');
    assert.deepEqual([r.imported, r.customersCreated], [5, 3]);
    assert.deepEqual(r.unreadable.map((u) => u.line), [9, 13]);
    assert.match(r.unreadable[0].text, /^\| L-2025-0004 \| Too \| Few \|$/);
    assert.deepEqual(r.duplicates, [{ line: 8, licenseId: 'L-2025-0003', keptLine: 11 }]);
    assert.equal(r.registryError, null);
    // the backup holds the original bytes
    assert.match(path.basename(r.backup), /^issued-licenses\.md\.bak-20261125-100000$/);
    assert.equal(fs.readFileSync(r.backup, 'utf8'), LEGACY);
    assert.equal(fs.readdirSync(k.dir).filter((f) => f.includes('.bak-')).length, 1);

    const all = store.listLicenses({ sort: 'id' });
    assert.deepEqual(all.map((l) => [l.licenseId, l.customerName, l.format, l.expiresAt, l.status, l.isRenewal]), [
        ['L-2025-0001', 'Example Corp.', 2, '2026-01-09', 'Expired', true],
        ['L-2024-0007', 'Example Corp.', 1, null, 'Format 1 (invalid)', false],
        ['L-2025-0002', 'Other | Pipe Ltd.', 2, '2027-02-28', 'Active', false],
        ['L-2025-0003', 'Third Co.', 2, '2027-03-31', 'Active', false],
        ['L-2025-0005', 'Example Corp.', 2, '2027-04-30', 'Active', true], // upper-cased ID; the customer matched ignoring case
    ]);
    const first = all[0];
    assert.deepEqual([first.type, first.salesId, first.amount, first.currency, first.planId, first.keyId, first.sha12, first.filePath, first.signedAt, first.licensedTo],
        ['paid', null, null, null, null, 'k1', 'abcdef012345', 'C:\\keys\\issued\\L-2025-0001-example-corp.lic', '2025-01-10T10:00:00+08:00', 'Example Corp.']);
    assert.equal(all[3].filePath, 'C:\\keys\\second.lic'); // the last row of a duplicated ID
    assert.equal(all[4].licensedTo, 'example corp.'); // the name as written in that row
    const ev = store.licenseEvents('L-2025-0001');
    assert.deepEqual(ev.map((e) => e.type), ['imported']);
    assert.deepEqual([ev[0].detail.line, ev[0].detail.source, ev[0].detail.row.expiresAt], [5, reg, '2026-01-09']);
    assert.equal(store.licenseEvents('L-2024-0007')[0].detail.row.expiresAt, '— (format 1, no expiry; reissued as L-2025-0001)');
    assert.equal(store.importRecord().imported, 5);
    assert.equal(store.nextLicenseId('2025'), 'L-2025-0006');

    // the registry is now the generated copy
    const text = fs.readFileSync(reg, 'utf8');
    assert.equal(text.split('\n')[0], S.REGISTRY_MARKER);
    assert.match(text, /\| L-2024-0007 \| Example Corp\. \| Paid \| 2024-06-01 \| — \|  \| Format 1 \(invalid\) \| C:\\keys\\old\.lic \|/);
    assert.match(text, /\| L-2025-0002 \| Other \\\| Pipe Ltd\. \| Paid \|/);
    assert.equal(text.split('\n').filter((l) => /^\| L-20\d\d-\d{4} /.test(l)).length, 5);

    const summary = importSummary(r);
    assert.match(summary[0], /^Imported 5 license\(s\) from .+ \(3 customer\(s\) created; backup: .+\)\.$/);
    assert.equal(summary.length, 4);
});

test('import is idempotent and never into a database that has licenses; a hand-made registry is never overwritten', (t) => {
    const { store, k, issue } = tempStore(t, { before: (kk, r) => fs.writeFileSync(r, LEGACY) });
    assert.equal(store.importRegistryIfNeeded().status, 'imported');
    assert.equal(store.importRegistryIfNeeded().status, 'done-before');
    assert.equal(issue({ customerName: 'Example Corp.', expiresAt: '2027-11-24' }).ok, true);
    assert.equal(store.importRegistryIfNeeded().status, 'done-before');
    assert.equal(store.licenseCount(), 6);
    assert.equal(fs.readdirSync(k.dir).filter((f) => f.includes('.bak-')).length, 1);

    // another database (no registry at first): issues create the generated copy; it is never imported back
    const reg2 = path.join(k.dir, 'second.md');
    const s2 = S.openStore(path.join(k.dir, 'second.db'), { registryFile: reg2, now: () => new Date(2026, 10, 25, 10) });
    k.closers.push(() => s2.close());
    assert.equal(s2.importRegistryIfNeeded().status, 'no-registry');
    const base = { key: k.privateKey, keyId: k.keyId, issuedDir: path.join(k.dir, 'issued') };
    assert.equal(S.issueLicense(s2, { ...base, customerName: 'Second Co.', createCustomer: true, expiresAt: '2027-11-24' }).ok, true);
    assert.equal(s2.importRegistryIfNeeded().status, 'not-empty');
    // a hand-made registry appears where the generated one was: it is left unchanged (no import, no overwrite)
    fs.writeFileSync(reg2, LEGACY);
    assert.equal(s2.importRegistryIfNeeded().status, 'not-empty');
    assert.equal(S.issueLicense(s2, { ...base, customerName: 'Second Co.', expiresAt: '2027-11-24' }).registryError.message.includes('was not generated by license-issuer'), true);
    assert.equal(fs.readFileSync(reg2, 'utf8'), LEGACY);
    assert.deepEqual([s2.registryStatus().ok, s2.registryStatus().file], [false, reg2]);
});

test('import refusals: an unreadable registry stops (nothing imported, no backup); a generated registry with an empty database', (t) => {
    // a registry path that cannot be read (a folder)
    const a = tempStore(t, { before: (k, reg) => fs.mkdirSync(reg) });
    assert.throws(() => a.store.importRegistryIfNeeded(), { code: 'registry-unreadable', status: 500, message: /Cannot read the registry .+ \(EISDIR\)\./ });
    assert.deepEqual([a.store.licenseCount(), a.store.importRecord()], [0, null]);
    assert.equal(fs.readdirSync(a.k.dir).some((f) => f.includes('.bak-')), false);
    // a generated registry but an empty database (wrong DB_FILE, or a lost database): refused, the file stays
    const generated = `${S.REGISTRY_MARKER}\n<!-- Database ID: 00aa00aa00aa00aa -->\n# x\n| L-2026-0001 | A | Paid | 2026-11-25 | 2027-11-24 |  | Active | x | 0 | 0 |\n`;
    const b = tempStore(t, { before: (k, reg) => fs.writeFileSync(reg, generated) });
    assert.throws(() => b.store.importRegistryIfNeeded(), { code: 'registry-generated', status: 409, message: /was generated from a license-issuer database, but the database .+ has no licenses/ });
    assert.equal(fs.readFileSync(b.reg, 'utf8'), generated);
    // the copy of another database is never overwritten, even when issuing goes ahead (the license is issued and recorded)
    const r = b.issue({ customerName: 'A', createCustomer: true, expiresAt: '2027-11-24' });
    assert.equal(r.ok, true);
    assert.match(r.registryError.message, /was generated from another database \(ID 00aa00aa00aa00aa\); it was left unchanged/);
    assert.equal(fs.readFileSync(b.reg, 'utf8'), generated);
    assert.match(b.store.dbId(), /^[0-9a-f]{16}$/);
    // a header-only registry imports nothing but is recorded and replaced by the generated copy
    const c = tempStore(t, { before: (k, reg) => fs.writeFileSync(reg, core.REGISTRY_HEADER) });
    const rc = c.store.importRegistryIfNeeded();
    assert.deepEqual([rc.status, rc.imported, rc.unreadable, rc.duplicates], ['imported', 0, [], []]);
    assert.equal(fs.readFileSync(c.reg, 'utf8').split('\n')[0], S.REGISTRY_MARKER);
    assert.equal(c.store.importRegistryIfNeeded().status, 'done-before');
    // the registry lock is respected
    const d = tempStore(t, { before: (k, reg) => { fs.writeFileSync(reg, LEGACY); fs.writeFileSync(`${reg}.lock`, 'other'); } });
    d.store.lockOptions = { timeoutMs: 100 };
    assert.throws(() => d.store.importRegistryIfNeeded(), { code: 'locked', status: 503 });
    assert.equal(d.store.licenseCount(), 0);
});

test('web app first start imports the registry; a generated registry with an empty database stops the start', async (t) => {
    const app = await startApp(t, { before: (k, config) => fs.writeFileSync(config.registryFile, LEGACY) });
    assert.equal(app.imported.status, 'imported');
    const c = await app.login();
    const view = await c.call('GET', '/api/registry');
    assert.equal(view.status, 200);
    assert.equal(view.json.rows.length, 5);
    assert.deepEqual(view.json.unreadable, []);
    assert.equal(view.json.rows.find((r) => r.licenseId === 'L-2024-0007').status, 'Format 1 (invalid)');
    assert.equal((await c.call('GET', '/api/session')).json.nextId, 'L-2026-0001');

    const k = keyDir(t);
    const config = await makeConfig(k);
    fs.writeFileSync(config.registryFile, `${S.REGISTRY_MARKER}\n`);
    const prepared = prepareStore(config);
    assert.equal(prepared.store, null);
    assert.match(prepared.errors[0], /was generated from a license-issuer database, but the database .+license-issuer\.db has no licenses/);
    const bad = await makeConfig(k, { dbFile: path.join(k.dir, 'missing', 'x.db') });
    assert.match(prepareStore(bad).errors[0], /^DB_FILE cannot be opened: .+x\.db/);
});

test('restart after only sales / customer edits on a fresh install: the own generated registry does not stop the start', async (t) => {
    const k = keyDir(t);
    const config = await makeConfig(k);
    const first = prepareStore(config);
    assert.deepEqual([first.errors, first.imported.status], [[], 'no-registry']);
    const s1 = first.store;
    const sales = s1.createSales({ name: 'Example Sales' });
    s1.updateSales(sales.id, { email: 'example-sales@example.test' }); // writes the generated registry (no licenses)
    const cust = s1.createCustomer({ name: 'Example Corp.' });
    s1.updateCustomer(cust.id, { notes: 'example note' });
    const text = fs.readFileSync(config.registryFile, 'utf8');
    assert.equal(S.isGeneratedRegistry(text), true);
    assert.ok(text.includes(`<!-- Database ID: ${s1.dbId()} -->`));
    assert.deepEqual([s1.licenseCount(), s1.importRecord()], [0, null]);
    s1.close();

    const second = prepareStore(config); // the restart
    assert.deepEqual(second.errors, []);
    assert.equal(second.imported.status, 'no-registry');
    k.closers.push(() => second.store.close());
    assert.equal(second.store.getSales(sales.id).email, 'example-sales@example.test');
    fs.mkdirSync(config.issuedDir);
    const r = S.issueLicense(second.store, { key: k.privateKey, keyId: k.keyId, issuedDir: config.issuedDir,
        customerName: 'Example Corp.', expiresAt: '2027-11-24' });
    assert.equal(r.ok, true);
    assert.equal(r.registryError, null);
    assert.equal(second.store.importRegistryIfNeeded().status, 'not-empty');
});

test('generated registry: marker, columns, type, sales, revoked reasons, the signed name after a rename; hand edits are overwritten', (t) => {
    const { store, issue, replace, reg } = tempStore(t);
    const a = store.createSales({ name: 'Alice Example' });
    const one = issue({ customerName: 'Example | Corp.', createCustomer: true, expiresAt: '2027-11-24', salesId: a.id });
    const two = issue({ customerName: 'Trial Co.', createCustomer: true, type: 'trial', expiresAt: '2026-12-01' });
    store.revokeLicense(two.licenseId, { reason: 'issued_in_error' });
    const three = replace({ replaces: one.licenseId, expiresAt: '2028-01-31' });
    store.updateCustomer(one.license.customerId, { name: 'Renamed Corp.' });
    store.updateSales(a.id, { name: 'Alice Renamed' });
    fs.appendFileSync(reg, '| L-2026-0099 | Hand edit | Paid | 2026-11-25 | 2027-11-24 |  | Active | x | 0 | 0 |\n');
    store.editLicense(three.licenseId, { orderNo: 'PO-7' }); // any change regenerates
    const lines = fs.readFileSync(reg, 'utf8').split('\n');
    assert.deepEqual(lines.slice(0, 8), [
        '<!-- Generated by license-issuer from license-issuer.db. Do not edit by hand. -->',
        `<!-- Database ID: ${store.dbId()} -->`,
        '# SOMP Vanguard 已簽發授權登記表',
        '',
        '狀態以 2026-11-25 為準（每次資料異動後重新產生）。',
        '',
        '| License ID | Customer | Type | Issued | Expires | Sales | Status | File | SHA-256 | Signed at |',
        '|---|---|---|---|---|---|---|---|---|---|',
    ]);
    const rows = lines.filter((l) => l.startsWith('| L-'));
    assert.equal(rows.length, 3);
    assert.match(rows[0], /^\| L-2026-0001 \| Example \\\| Corp\. \| Paid \| 2026-11-25 \| 2027-11-24 \| Alice Renamed \| Revoked \(replaced by L-2026-0003\) \| .+L-2026-0001-example-corp\.lic \| [0-9a-f]{12} \| 2026-11-25T10:00:00[+-]\d\d:\d\d \|$/);
    assert.match(rows[1], /^\| L-2026-0002 \| Trial Co\. \| Trial \| 2026-11-25 \| 2026-12-01 \|  \| Revoked \(issued in error\) \|/);
    // the replacement was signed before the rename: the registry shows the name in the license, the record the new name
    assert.match(rows[2], /^\| L-2026-0003 \| Example \\\| Corp\. \| Paid \| 2026-11-25 \| 2028-01-31 \| Alice Renamed \| Active \|/);
    assert.equal(store.getLicense('L-2026-0003').customerName, 'Renamed Corp.');
    assert.equal(S.renderRegistry(store), fs.readFileSync(reg, 'utf8'));
    assert.equal(S.isGeneratedRegistry(`\uFEFF${S.REGISTRY_MARKER}`), true);
    assert.equal(fs.existsSync(`${reg}.lock`), false);
    assert.equal(fs.readdirSync(path.dirname(reg)).some((f) => f.includes('.tmp-')), false);
});

test('backups: a consistent copy next to the database, listed newest first, resolved only by exact name', (t) => {
    const { store, issue, clock, k } = tempStore(t);
    assert.deepEqual(store.listBackups(), []);
    issue({ customerName: 'Example Corp.', createCustomer: true, expiresAt: '2027-11-24' });
    const b1 = store.createBackup();
    assert.equal(b1.name, 'license-issuer-backup-20261125-100000.db');
    assert.equal(b1.file, path.join(k.dir, b1.name));
    assert.equal(b1.createdAt, '2026-11-25T10:00:00');
    assert.ok(b1.size > 0);
    const b1b = store.createBackup(); // same second
    assert.equal(b1b.name, 'license-issuer-backup-20261125-100000-2.db');
    clock.ms += 3600 * 1000;
    issue({ customerName: 'Example Corp.', expiresAt: '2027-11-24' });
    const b2 = store.createBackup();
    assert.deepEqual(store.listBackups().map((b) => b.name), [b2.name, b1b.name, b1.name]);
    // the copy is a working database with the data of that moment
    const copy = S.openStore(b1.file);
    try { assert.equal(copy.licenseCount(), 1); } finally { copy.close(); }
    assert.equal(store.backupPath(b1.name), b1.file);
    for (const name of ['../license-issuer-backup-20261125-100000.db', 'license-issuer.db', 'license-issuer-backup-20261125-100000.db.txt',
        'license-issuer-backup-20991231-000000.db', '', null]) {
        assert.equal(store.backupPath(name), null, String(name));
    }
});
