// Registry parsing (escapes, unreadable lines, format-1 rows), statuses, date rules, the lock and the CLI's imports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../../scripts/licenseIssuerCore');
const { rowStatus, registryView } = require('../src/registry');
const { openStore } = require('../src/store');
const D = require('../public/dates');

const HEADER = core.REGISTRY_HEADER;
const row = (o) => core.registryRow({ licenseId: 'L-2026-0001', customer: 'Example Corp.', issuedAt: '2026-11-16', expiresAt: '2027-11-15',
    keyId: 'k1', file: 'C:\\keys\\issued\\L-2026-0001-example-corp.lic', sha256: 'abcdef012345', signedAt: '2026-11-16T10:00:00+08:00', ...o });

test('escapeCell / splitRow round trip: pipes, backslashes, Windows and UNC paths', () => {
    const values = ['plain', 'a|b', 'Foo\\|Bar', 'a\\\\|b', 'C:\\keys\\L-2026-0001.lic', '\\\\server\\share\\x.lic', 'Ends with \\',
        '\\', '|', '||', '\\|\\|', '範例 | 公司', 'x\\\\\\|y'];
    for (const v of values) {
        const cells = core.splitRow(`| ${core.escapeCell(v)} | next |`);
        assert.deepEqual(cells, [v.trim(), 'next'], JSON.stringify(v));
        assert.equal(core.unescapeCell(core.escapeCell(v)), v.trim());
    }
    assert.equal(core.splitRow('no pipes'), null);
    assert.equal(core.splitRow('| unterminated'), null);
    assert.equal(core.splitRow('| escaped end \\|'), null);
});

test('parseRegistry reads rows, skips the header, and lists unreadable lines with their numbers', () => {
    const text = HEADER
        + row({ customer: 'Example | Pipe \\ Co.' }) + '\n'
        + row({ licenseId: 'L-2026-0002', expiresAt: '— (format 1, no expiry; reissued as L-2026-0003)' }) + '\r\n'
        + '| L-2026-0003 | Too | Few | Cells |\n'
        + '| not-an-id | A | 2026-11-16 | 2027-11-15 | k1 | x | 0 | 0 |\n'
        + '| L-2026-0004 | A | 2026-13-01 | 2027-11-15 | k1 | x | 0 | 0 |\n'
        + '| L-2026-0005 | unterminated \\|\n'
        + 'Some note under the table\n\n';
    const { rows, unreadable } = core.parseRegistry(text);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].customer, 'Example | Pipe \\ Co.');
    assert.equal(rows[0].file, 'C:\\keys\\issued\\L-2026-0001-example-corp.lic');
    assert.equal(rows[0].line, 5);
    assert.equal(rows[1].expiresAt, '— (format 1, no expiry; reissued as L-2026-0003)');
    assert.deepEqual(unreadable.map((u) => u.line), [7, 8, 9, 10]);
    assert.match(unreadable[0].text, /^\| L-2026-0003 \| Too/);
    assert.deepEqual(core.parseRegistry(''), { rows: [], unreadable: [] });
    assert.deepEqual(core.parseRegistry(null), { rows: [], unreadable: [] });
});

test('the CLI registry format (written by license_issue.js) is read back exactly', () => {
    const r = core.parseRegistry(HEADER + row({ customer: 'Foo\\|Bar' }) + '\n');
    assert.equal(r.rows[0].customer, 'Foo\\|Bar');
    assert.equal(r.rows[0].sha256, 'abcdef012345');
    assert.equal(r.rows[0].signedAt, '2026-11-16T10:00:00+08:00');
});

test('status: 31 days Active, 30 and 0 Expires soon, -1 Expired, format 1 invalid', () => {
    const today = '2026-11-25';
    assert.deepEqual(rowStatus(D.addDays(today, 31), today), { status: 'Active', daysLeft: 31 });
    assert.deepEqual(rowStatus(D.addDays(today, 30), today), { status: 'Expires soon', daysLeft: 30 });
    assert.deepEqual(rowStatus(today, today), { status: 'Expires soon', daysLeft: 0 });
    assert.deepEqual(rowStatus(D.addDays(today, -1), today), { status: 'Expired', daysLeft: -1 });
    assert.deepEqual(rowStatus('— (format 1, no expiry)', today), { status: 'Format 1 (invalid)', daysLeft: null });
});

test('registry view (from the database): sorted by expiry, format-1 rows last; an empty database is empty', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-issuer-reg-'));
    const file = path.join(dir, 'reg.md');
    const store = openStore(path.join(dir, 'license-issuer.db'), { registryFile: file, now: () => new Date(2026, 10, 25, 10) });
    t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
    assert.deepEqual(registryView(store, '2026-11-25'), { exists: false, rows: [], unreadable: [], nextId: 'L-2026-0001' });
    fs.writeFileSync(file, HEADER
        + row({ licenseId: 'L-2026-0001', expiresAt: '— (format 1, no expiry)' }) + '\n'
        + row({ licenseId: 'L-2026-0002', expiresAt: '2028-01-01' }) + '\n'
        + row({ licenseId: 'L-2026-0003', expiresAt: '2026-11-24' }) + '\n'
        + row({ licenseId: 'L-2026-0004', expiresAt: '2026-12-01' }) + '\n');
    assert.equal(store.importRegistryIfNeeded().imported, 4);
    const v = registryView(store, '2026-11-25');
    assert.equal(v.exists, true);
    assert.deepEqual(v.rows.map((r) => r.licenseId), ['L-2026-0003', 'L-2026-0004', 'L-2026-0002', 'L-2026-0001']);
    assert.deepEqual(v.rows.map((r) => r.status), ['Expired', 'Expires soon', 'Active', 'Format 1 (invalid)']);
    assert.deepEqual(v.rows.map((r) => r.expiresAt), ['2026-11-24', '2026-12-01', '2028-01-01', '— (format 1, no expiry)']);
    assert.equal(v.rows[0].fileName, 'L-2026-0001-example-corp.lic');
    assert.equal(v.rows[0].customer, 'Example Corp.');
    assert.equal(v.rows[0].sha256, 'abcdef012345');
    assert.equal(v.nextId, 'L-2026-0005');
});

test('expiry buttons: N years from issued minus one day', () => {
    assert.equal(D.termEnd('2026-11-25', 1), '2027-11-24');
    assert.equal(D.termEnd('2026-11-25', 2), '2028-11-24');
    assert.equal(D.termEnd('2026-11-25', 3), '2029-11-24');
    assert.equal(D.termEnd('2026-01-01', 1), '2026-12-31');
    assert.equal(D.termEnd('2028-02-29', 1), '2029-02-28');
    assert.equal(D.termEnd('2027-03-01', 1), '2028-02-29');
    assert.equal(D.daysBetween('2026-11-25', '2027-11-24'), 364);
});

test('renew: issued today; +1 year on the original expiry while valid, else today + 1 year - 1 day', () => {
    const today = '2026-11-25';
    assert.deepEqual(D.renewDates('2027-01-31', today), { issuedAt: today, expiresAt: '2028-01-31' });
    assert.deepEqual(D.renewDates(today, today), { issuedAt: today, expiresAt: '2027-11-25' }); // expires today: still valid
    assert.deepEqual(D.renewDates('2026-11-24', today), { issuedAt: today, expiresAt: '2027-11-24' }); // expired yesterday
    assert.deepEqual(D.renewDates('— (format 1, no expiry)', today), { issuedAt: today, expiresAt: '2027-11-24' });
    assert.deepEqual(D.renewDates('2028-02-29', today), { issuedAt: today, expiresAt: '2029-02-28' });
});

test('registry lock: a second writer waits and gives up; a stale lock is taken over', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-issuer-lock-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const reg = path.join(dir, 'reg.md');
    const a = core.lockRegistry(reg);
    assert.equal(a.error, undefined);
    assert.equal(fs.existsSync(`${reg}.lock`), true);
    const t0 = Date.now();
    const b = core.lockRegistry(reg, { timeoutMs: 150 });
    assert.match(b.error, /locked by another writer/);
    assert.ok(Date.now() - t0 >= 140);
    a.release();
    assert.equal(fs.existsSync(`${reg}.lock`), false);
    fs.writeFileSync(`${reg}.lock`, 'old');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(`${reg}.lock`, old, old);
    const c = core.lockRegistry(reg, { timeoutMs: 100 });
    assert.equal(c.error, undefined);
    c.release();
    // a folder that does not exist: no lock, no error (the registry write reports the problem)
    const d = core.lockRegistry(path.join(dir, 'missing', 'reg.md'));
    assert.equal(d.error, undefined);
    d.release();
});

test('the CLI and the core do not load the database module', () => {
    const repo = path.join(__dirname, '..', '..');
    const out = execFileSync(process.execPath, ['-e',
        "require('./scripts/license_issue'); require('./license-issuer/src/app'); console.log(JSON.stringify(Object.keys(require.cache)))"], { cwd: repo, encoding: 'utf8' });
    const loaded = JSON.parse(out);
    assert.ok(loaded.some((f) => /licenseFormat\.js$/.test(f)));
    assert.ok(!loaded.some((f) => /[\\/]backend[\\/]lib[\\/](db|license)\.js$/.test(f)), loaded.filter((f) => /backend/.test(f)).join(', '));
});
