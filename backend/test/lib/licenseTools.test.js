require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KEYS } = require('../../lib/licenseKeys');
const { verifyLicense } = require('../../lib/license');

const keygen = require('../../../scripts/license_keygen');
const issue = require('../../../scripts/license_issue');

/** Temp dir with a freshly generated, trusted key (KEYS.<id> removed again by the caller's cleanup). */
function setup(t, keyId) {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-keys-'));
    assert.equal(keygen.main(['--out', dir, '--key-id', keyId]), 0);
    KEYS[keyId] = fs.readFileSync(path.join(dir, `${keyId}-public.pem`), 'utf8');
    t.after(() => { delete KEYS[keyId]; fs.rmSync(dir, { recursive: true, force: true }); });
    const priv = path.join(dir, `${keyId}-private.pem`);
    const reg = path.join(dir, 'reg.md');
    const run = (id, name, extra = []) => issue.main([
        '--key', priv, '--key-id', keyId, '--customer', name, '--id', id, '--issued', '2026-11-16',
        '--expires', '2099-12-31', '--out', path.join(dir, `${id}.lic`), '--registry', reg, ...extra]);
    return { dir, priv, reg, run };
}

test('keygen -> issue -> verify round trip', (t) => {
    const { dir, priv, reg } = setup(t, 'kround');
    assert.match(fs.readFileSync(priv, 'utf8'), /BEGIN PRIVATE KEY/);
    const out = path.join(dir, 'example.lic');
    assert.equal(issue.main(['--key', priv, '--key-id', 'kround', '--customer', 'Example Test Co.', '--id', 'L-2026-9999',
        '--issued', '2026-11-16', '--expires', '2099-12-31', '--out', out, '--registry', reg]), 0);
    const r = verifyLicense(fs.readFileSync(out, 'utf8'));
    assert.equal(r.valid, true);
    assert.equal(r.payload.formatVersion, 2);
    assert.equal(r.payload.licenseId, 'L-2026-9999');
    assert.equal(r.payload.expiresAt, '2099-12-31');
    assert.equal(r.payload.updatesUntil, null);
});

test('keygen refuses to overwrite an existing key; issue refuses a key the system does not trust', (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-keys-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    assert.equal(keygen.main(['--out', dir, '--key-id', 'kx']), 0);
    assert.equal(keygen.main(['--out', dir, '--key-id', 'kx']), 1);
    const out = path.join(dir, 'x.lic');
    assert.equal(issue.main(['--key', path.join(dir, 'kx-private.pem'), '--key-id', 'kx', '--customer', 'A', '--id', 'L-2026-0001',
        '--expires', '2099-12-31', '--out', out]), 1);
    assert.match(console.error.mock.calls.at(-1).arguments[0], /would reject this license/);
    assert.equal(fs.existsSync(out), false);
    assert.equal(issue.main(['--customer', 'A']), 1); // missing arguments
});

test('issue refuses a past --expires and an --expires before --issued; nothing is written', (t) => {
    const { dir, priv, reg } = setup(t, 'kpast');
    const out = path.join(dir, 'p.lic');
    const base = ['--key', priv, '--key-id', 'kpast', '--customer', 'A', '--id', 'L-2026-0001', '--out', out, '--registry', reg];
    assert.equal(issue.main([...base, '--expires', '2000-01-01']), 1);
    assert.equal(issue.main([...base, '--issued', '2098-01-02', '--expires', '2098-01-01']), 1);
    assert.equal(issue.main([...base, '--expires', '2099-02-30']), 1); // not a real date
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.existsSync(reg), false);
});

test('registry is created with a header and one row; a second issue appends', (t) => {
    const { reg, run } = setup(t, 'kreg');
    assert.equal(run('L-2026-0001', 'Example Test Co.'), 0);
    let lines = fs.readFileSync(reg, 'utf8').trimEnd().split('\n');
    assert.equal(lines[0], '# SOMP Vanguard 已簽發授權登記表');
    assert.equal(lines[2], '| License ID | Customer | Issued | Expires | Key | File | SHA-256 | Signed at |');
    assert.equal(lines[3], '|---|---|---|---|---|---|---|---|');
    assert.equal(lines.length, 5);
    assert.match(lines[4], /^\| L-2026-0001 \| Example Test Co\. \| 2026-11-16 \| 2099-12-31 \| kreg \| .+ \| [0-9a-f]{12} \| \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} \|$/);
    assert.equal(run('L-2026-0002', 'Example Two Ltd.'), 0);
    lines = fs.readFileSync(reg, 'utf8').trimEnd().split('\n');
    assert.equal(lines.length, 6);
    assert.match(lines[5], /^\| L-2026-0002 \|/);
});

test('duplicate license ID is refused unless --allow-duplicate-id', (t) => {
    const { dir, reg, run } = setup(t, 'kdup');
    assert.equal(run('L-2026-0001', 'A'), 0);
    fs.rmSync(path.join(dir, 'L-2026-0001.lic'));
    assert.equal(run('L-2026-0001', 'B'), 1);
    assert.match(console.error.mock.calls.at(-1).arguments[0], /already in the registry/);
    assert.equal(fs.existsSync(path.join(dir, 'L-2026-0001.lic')), false);
    // the registry match is case-insensitive (a hand-typed row in lower case still counts)
    fs.appendFileSync(reg, '| l-2026-0005 | Hand Typed | 2026-11-16 | 2099-12-31 | kdup | x | 0 | 0 |\n');
    assert.equal(run('L-2026-0005', 'C'), 1);
    assert.match(console.error.mock.calls.at(-1).arguments[0], /already in the registry/);
    assert.equal(run('L-2026-0001', 'B', ['--allow-duplicate-id']), 0);
    assert.equal(fs.readFileSync(reg, 'utf8').split('\n').filter((l) => l.startsWith('| L-2026-0001')).length, 2);
});

test('a pipe in the customer name is escaped in the registry', (t) => {
    const { reg, run } = setup(t, 'kpipe');
    assert.equal(run('L-2026-0001', 'Example | Test Co.'), 0);
    assert.match(fs.readFileSync(reg, 'utf8'), /\| Example \\\| Test Co\. \|/);
    assert.equal(issue.escapeCell('a|b\r\nc'), 'a\\|b c');
});

test('a backslash right before a pipe cannot end the cell early; other backslashes stay readable', () => {
    // Foo\|Bar -> Foo\\\|Bar (escaped backslash + escaped pipe); a run of backslashes is doubled as a whole
    assert.equal(issue.escapeCell('Foo\\|Bar'), 'Foo\\\\\\|Bar');
    assert.equal(issue.escapeCell('a\\\\|b'), 'a\\\\\\\\\\|b');
    assert.equal(issue.escapeCell('C:\\keys\\L-2026-0001.lic'), 'C:\\keys\\L-2026-0001.lic');
    assert.equal(issue.escapeCell('Ends with \\'), 'Ends with \\');
});

test('argument hardening: a flag is never taken as a value, the id format is checked, --out is not overwritten', (t) => {
    const { dir, priv, reg, run } = setup(t, 'kargs');
    const lastError = () => console.error.mock.calls.at(-1).arguments[0];
    // --customer followed by another flag: refused, nothing written
    assert.equal(issue.main(['--key', priv, '--key-id', 'kargs', '--customer', '--id', 'L-2026-0001', '--expires', '2099-12-31',
        '--out', path.join(dir, 'a.lic'), '--registry', reg]), 1);
    assert.equal(fs.existsSync(path.join(dir, 'a.lic')), false);
    assert.equal(issue.main(['--key', priv, '--customer', 'A', '--id', 'L-2026-0001', '--expires', '2099-12-31', '--out']), 1);
    // id format
    for (const bad of ['L-1', 'L-2026-1', 'X-2026-0001', 'L-2026-0001|x', 'l-2026-0001']) {
        assert.equal(run(bad, 'A'), 1, bad);
        assert.match(lastError(), /--id must look like L-YYYY-NNNN/);
    }
    assert.equal(fs.existsSync(reg), false);
    // --out must not be the private key or the registry, even with --force
    const keyBefore = fs.readFileSync(priv, 'utf8');
    const base = ['--key', priv, '--key-id', 'kargs', '--customer', 'A', '--id', 'L-2026-0001', '--expires', '2099-12-31', '--registry', reg];
    assert.equal(issue.main([...base, '--out', priv, '--force']), 1);
    assert.equal(fs.readFileSync(priv, 'utf8'), keyBefore);
    fs.writeFileSync(reg, '# registry\n');
    assert.equal(issue.main([...base, '--out', reg, '--force']), 1);
    assert.equal(fs.readFileSync(reg, 'utf8'), '# registry\n');
    fs.rmSync(reg);
    // an existing --out file is kept unless --force
    const out = path.join(dir, 'existing.lic');
    fs.writeFileSync(out, 'keep me');
    assert.equal(issue.main([...base, '--out', out]), 1);
    assert.match(lastError(), /already exists/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'keep me');
    assert.equal(issue.main([...base, '--out', out, '--force']), 0);
    assert.equal(verifyLicense(fs.readFileSync(out, 'utf8')).valid, true);
});

test('a registry that exists but cannot be read stops before signing and is never overwritten', (t) => {
    const { dir, run } = setup(t, 'kread');
    const reg = path.join(dir, 'reg.md');
    fs.writeFileSync(reg, '# existing registry\n| L-2026-0001 | A | 2026-11-16 | 2099-12-31 | kread | x | 0 | 0 |\n');
    const realRead = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function (p, ...rest) {
        if (typeof p === 'string' && path.resolve(p) === path.resolve(reg)) {
            const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e;
        }
        return realRead.call(this, p, ...rest);
    });
    assert.equal(run('L-2026-0002', 'B'), 1);
    assert.match(console.error.mock.calls.at(-1).arguments[0], /Cannot read the registry/);
    assert.equal(fs.existsSync(path.join(dir, 'L-2026-0002.lic')), false);
    t.mock.restoreAll();
    assert.match(fs.readFileSync(reg, 'utf8'), /^# existing registry\n\| L-2026-0001 /);
});

test('nextLicenseId returns the highest number for the year plus one', () => {
    assert.equal(issue.nextLicenseId('| L-2027-0002 | x |\n| L-2027-0010 | y |\n| L-2026-0099 | z |', 2027), 'L-2027-0011');
    assert.equal(issue.nextLicenseId('', 2027), 'L-2027-0001');
    assert.equal(issue.nextLicenseId(null, 2027), 'L-2027-0001');
});

test('registry write failure returns 2 and leaves the license', (t) => {
    const { dir } = setup(t, 'kfail');
    const blocker = path.join(dir, 'afile');
    fs.writeFileSync(blocker, 'x');
    const reg = path.join(blocker, 'sub', 'reg.md'); // parent is a file: cannot be created
    const rc = issue.main(['--key', path.join(dir, 'kfail-private.pem'), '--key-id', 'kfail', '--customer', 'A', '--id', 'L-2026-0001',
        '--issued', '2026-11-16', '--expires', '2099-12-31', '--out', path.join(dir, 'f.lic'), '--registry', reg]);
    assert.equal(rc, 2);
    assert.equal(verifyLicense(fs.readFileSync(path.join(dir, 'f.lic'), 'utf8')).valid, true);
});
