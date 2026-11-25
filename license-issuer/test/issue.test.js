// Issuing over the API: the license verifies with the product's rules, refusals write nothing, registry failures.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { verifyLicense } = require('../../backend/lib/licenseFormat');
const { KEYS } = require('../../backend/lib/licenseKeys');
const core = require('../../scripts/licenseIssuerCore');
const { slugify } = require('../src/registry');
const { startApp } = require('./helpers');

const GOOD = { customer: 'Example Corp.', licenseId: 'L-2026-0001', issuedAt: '2026-11-25', expiresAt: '2027-11-24' };
const listIssued = (app) => (fs.existsSync(app.config.issuedDir) ? fs.readdirSync(app.config.issuedDir) : []);

test('a valid issue writes <ID>-<slug>.lic that the product accepts, and a registry row', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    const r = await c.issue(GOOD);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.fileName, 'L-2026-0001-example-corp.lic');
    assert.equal(r.json.file, path.join(app.config.issuedDir, 'L-2026-0001-example-corp.lic'));
    assert.equal(r.json.days, 364);
    assert.equal(r.json.nextId, 'L-2026-0002');
    assert.equal(r.json.registryError, undefined);
    const text = fs.readFileSync(r.json.file, 'utf8');
    const v = verifyLicense(text, KEYS, '2026-11-25');
    assert.equal(v.valid, true, v.reason);
    assert.deepEqual(v.payload, { formatVersion: 2, keyId: app.k.keyId, licenseId: 'L-2026-0001', customer: 'Example Corp.',
        edition: 'paid', issuedAt: '2026-11-25', expiresAt: '2027-11-24', updatesUntil: null });
    assert.equal(verifyLicense(text, KEYS, '2027-11-25').valid, false); // the day after the expiry
    const reg = core.parseRegistry(fs.readFileSync(app.config.registryFile, 'utf8'));
    assert.equal(reg.rows.length, 1);
    assert.equal(reg.rows[0].file, r.json.file);
    assert.equal(reg.rows[0].sha256, r.json.sha256);
    assert.equal(fs.existsSync(`${app.config.registryFile}.lock`), false);
    // the registry view shows it; the next issue gets the next ID
    const view = await c.call('GET', '/api/registry');
    assert.equal(view.json.rows[0].status, 'Active');
    assert.equal(view.json.rows[0].daysLeft, 364);
    assert.equal(view.json.nextId, 'L-2026-0002');
    const second = await c.issue({ ...GOOD, licenseId: 'L-2026-0002', customer: 'Example Two Ltd.' });
    assert.equal(second.status, 200);
    assert.equal(second.json.nextId, 'L-2026-0003');
});

test('bad input is refused and nothing is written', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    const cases = [
        [{ customer: '' }, 'customer'],
        [{ customer: '   ' }, 'customer'],
        [{ customer: 'x'.repeat(201) }, 'customer'],
        [{ customer: 'Line\nbreak' }, 'customer'],
        [{ customer: 42 }, 'customer'],
        [{ licenseId: 'L-2026-1' }, 'licenseId'],
        [{ licenseId: 'l-2026-0001' }, 'licenseId'],
        [{ licenseId: '../../x' }, 'licenseId'],
        [{ issuedAt: '2026-02-30' }, 'issuedAt'],
        [{ expiresAt: '2027-02-29' }, 'expiresAt'],
        [{ expiresAt: '2026-11-24' }, 'expiresAt'], // yesterday
        [{ issuedAt: '2027-01-02', expiresAt: '2027-01-01' }, 'expiresAt'],
        [{ expiresAt: '27-11-24' }, 'expiresAt'],
    ];
    for (const [change, field] of cases) {
        const r = await c.issue({ ...GOOD, ...change });
        assert.equal(r.status, 400, JSON.stringify(change));
        assert.equal(r.json.field, field, JSON.stringify(change));
    }
    assert.deepEqual(listIssued(app), []);
    assert.equal(fs.existsSync(app.config.registryFile), false);
    // 200 characters is fine; today is fine
    assert.equal((await c.issue({ ...GOOD, customer: 'y'.repeat(200), expiresAt: '2026-11-25' })).status, 200);
});

test('a duplicate ID is refused (also case-insensitive in the registry); nothing new is written', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    assert.equal((await c.issue(GOOD)).status, 200);
    const before = fs.readFileSync(app.config.registryFile, 'utf8');
    const dup = await c.issue({ ...GOOD, customer: 'Other Co.' });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.field, 'licenseId');
    assert.equal(dup.json.nextId, 'L-2026-0002');
    fs.appendFileSync(app.config.registryFile, '| l-2026-0007 | Hand Typed | 2026-11-16 | 2099-12-31 | k1 | x | 0 | 0 |\n');
    assert.equal((await c.issue({ ...GOOD, licenseId: 'L-2026-0007' })).status, 409);
    assert.deepEqual(listIssued(app), ['L-2026-0001-example-corp.lic']);
    assert.ok(fs.readFileSync(app.config.registryFile, 'utf8').startsWith(before));
});

test('an existing file is never overwritten', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    const target = path.join(app.config.issuedDir, 'L-2026-0001-example-corp.lic');
    fs.writeFileSync(target, 'keep me');
    const r = await c.issue(GOOD);
    assert.equal(r.status, 409);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep me');
    assert.equal(fs.existsSync(app.config.registryFile), false);
});

test('a registry that cannot be written: the license is kept, the answer has registryError and the row', async (t) => {
    const app = await startApp(t);
    const blocker = path.join(app.k.dir, 'afile');
    fs.writeFileSync(blocker, 'x');
    app.config.registryFile = path.join(blocker, 'sub', 'reg.md'); // parent is a file
    const c = await app.login();
    const r = await c.issue(GOOD);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.registryError, /registry was not updated/);
    assert.match(r.json.row, /^\| L-2026-0001 \| Example Corp\. \| 2026-11-25 \| 2027-11-24 \| /);
    assert.equal(r.json.nextId, 'L-2026-0002');
    assert.equal(verifyLicense(fs.readFileSync(r.json.file, 'utf8'), KEYS, '2026-11-25').valid, true);
    assert.match(app.auditText(), /"reason":"registry not updated"/);
});

test('a registry locked by another writer refuses the issue (nothing written)', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    fs.writeFileSync(`${app.config.registryFile}.lock`, 'other');
    const r = await c.issue(GOOD);
    assert.equal(r.status, 503);
    assert.deepEqual(listIssued(app), []);
    fs.rmSync(`${app.config.registryFile}.lock`);
    assert.equal((await c.issue(GOOD)).status, 200);
});

test('slug: lowercase ASCII letters, digits and hyphens, at most 40, fallback "customer"', () => {
    assert.equal(slugify('Example Corp.'), 'example-corp');
    assert.equal(slugify('  A.B.C. (Taiwan) Co., Ltd!!  '), 'a-b-c-taiwan-co-ltd');
    assert.equal(slugify('Café Ünited'), 'cafe-united');
    assert.equal(slugify('範例股份有限公司'), 'customer');
    assert.equal(slugify('範例 Example 公司'), 'example');
    assert.equal(slugify('!!!'), 'customer');
    assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
    assert.equal(slugify('x'.repeat(100)), 'x'.repeat(40));
    assert.equal(slugify(`${'a'.repeat(39)} bcd`), 'a'.repeat(39)); // no trailing hyphen after the cut
    for (const s of ['Example Corp.', 'x'.repeat(100), '範例', 'a|b\\c']) assert.match(slugify(s), /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
});

test('a long and CJK customer name issues fine; the full name is in the license', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    const name = '範例科技股份有限公司 | Example "Quotes" \\ Co.';
    const r = await c.issue({ ...GOOD, customer: name });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.fileName, 'L-2026-0001-example-quotes-co.lic');
    assert.equal(JSON.parse(fs.readFileSync(r.json.file, 'utf8')).payload.customer, name);
    const reg = await c.call('GET', '/api/registry');
    assert.equal(reg.json.rows[0].customer, name);
    assert.deepEqual(reg.json.unreadable, []);
});
