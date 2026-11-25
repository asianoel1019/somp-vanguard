// Vendor contact: CONTACT_VENDOR / CONTACT_EMAIL defaults (checked at startup), the Vendor / Contact email fields of the
// issue form (checked by the server with the product's rules), the signed payload, the audit line and the page texts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyLicense } = require('../../backend/lib/licenseFormat');
const { KEYS } = require('../../backend/lib/licenseKeys');
const core = require('../../scripts/licenseIssuerCore');
const { readConfig } = require('../src/config');
const C = require('../public/contact');
const { startApp, keyDir } = require('./helpers');

const GOOD = { customer: 'Example Corp.', licenseId: 'L-2026-0001', issuedAt: '2026-11-25', expiresAt: '2027-11-24' };
const BASE = { KEY_FILE: 'C:/keys/k1-private.pem', PASSWORD_HASH: 'x' };
const payloadOf = (file) => verifyLicense(fs.readFileSync(file, 'utf8'), KEYS, '2026-11-25');

test('readConfig: CONTACT_VENDOR / CONTACT_EMAIL are optional form defaults; invalid values are startup errors', () => {
    assert.deepEqual(readConfig(BASE).contactDefaults, { vendor: '', email: '' });
    const c = readConfig({ ...BASE, CONTACT_VENDOR: ' Example Vendor ', CONTACT_EMAIL: 'support@example.test' });
    assert.deepEqual(c.contactDefaults, { vendor: 'Example Vendor', email: 'support@example.test' });
    assert.deepEqual(c.errors, []);
    assert.deepEqual(readConfig({ ...BASE, CONTACT_EMAIL: 'support@example.test' }).errors, []);

    const bad = (env) => readConfig({ ...BASE, ...env }).errors;
    assert.deepEqual(bad({ CONTACT_VENDOR: 'v'.repeat(101) }), ['CONTACT_VENDOR must be at most 100 characters']);
    assert.deepEqual(bad({ CONTACT_EMAIL: 'not-an-email' }), ['CONTACT_EMAIL must be an email address like name@domain (got "not-an-email")']);
    assert.deepEqual(bad({ CONTACT_EMAIL: 'sup port@example.test' }), ['CONTACT_EMAIL must be an email address like name@domain (got "sup port@example.test")']);
    assert.deepEqual(bad({ CONTACT_EMAIL: `${'e'.repeat(190)}@example.test` }), ['CONTACT_EMAIL must be at most 200 characters']);
    assert.equal(bad({ CONTACT_VENDOR: 'v'.repeat(101), CONTACT_EMAIL: 'x' }).length, 2);
});

test('server.js refuses to start with an invalid CONTACT_EMAIL', (t) => {
    const k = keyDir(t);
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, PORT: '18445', KEY_FILE: k.keyFile, KEY_ID: 'k1', PASSWORD_HASH: '', ISSUED_DIR: path.join(k.dir, 'issued'),
            REGISTRY_FILE: '', CONTACT_VENDOR: 'Example Vendor', CONTACT_EMAIL: 'support at example.test' },
        encoding: 'utf8', timeout: 20000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Cannot start[\s\S]*CONTACT_EMAIL must be an email address like name@domain \(got "support at example.test"\)/);
    assert.doesNotMatch(r.stdout, /Open http/);
});

test('the session carries the .env defaults (empty when unset)', async (t) => {
    const plain = await startApp(t);
    assert.deepEqual((await (await plain.login()).call('GET', '/api/session')).json.contactDefaults, { vendor: '', email: '' });
    const app = await startApp(t, { overrides: { contactDefaults: { vendor: 'Example Vendor', email: 'support@example.test' } } });
    const s = await (await app.login()).call('GET', '/api/session');
    assert.deepEqual(s.json.contactDefaults, { vendor: 'Example Vendor', email: 'support@example.test' });
});

test('issue: the typed contact is signed into the license and written to the audit line', async (t) => {
    const app = await startApp(t, { overrides: { contactDefaults: { vendor: 'Example Default Vendor', email: 'default@example.test' } } });
    const c = await app.login();
    const r = await c.issue({ ...GOOD, contactVendor: ' Example Vendor ', contactEmail: 'support@example.test' });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.json.license.contactVendor, r.json.license.contactEmail], ['Example Vendor', 'support@example.test']);
    const v = payloadOf(r.json.file);
    assert.equal(v.valid, true, v.reason);
    assert.deepEqual(v.payload.contact, { vendor: 'Example Vendor', email: 'support@example.test' });
    assert.match(app.auditText(), /"event":"issue","licenseId":"L-2026-0001","customer":"Example Corp\.","contact":"Example Vendor \(support@example\.test\)"/);

    const only = await c.issue({ ...GOOD, licenseId: 'L-2026-0002', contactVendor: '', contactEmail: 'support@example.test' });
    assert.equal(only.status, 201, only.text);
    assert.deepEqual(payloadOf(only.json.file).payload.contact, { email: 'support@example.test' });

    // the .env values are form defaults only: a request without contact fields signs no contact
    const none = await c.issue({ ...GOOD, licenseId: 'L-2026-0003' });
    assert.equal(none.status, 201, none.text);
    assert.deepEqual([none.json.license.contactVendor, none.json.license.contactEmail], [null, null]);
    assert.equal('contact' in payloadOf(none.json.file).payload, false);
    const blank = await c.issue({ ...GOOD, licenseId: 'L-2026-0004', contactVendor: '   ', contactEmail: '' });
    assert.equal('contact' in payloadOf(blank.json.file).payload, false);
    // the contact is kept in the database (not in the generated registry)
    const rows = app.store.listLicenses({ sort: 'id' });
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((l) => [l.contactVendor, l.contactEmail]),
        [['Example Vendor', 'support@example.test'], [null, 'support@example.test'], [null, null], [null, null]]);
    const reg = fs.readFileSync(app.config.registryFile, 'utf8');
    assert.equal(reg.split('\n').filter((l) => /^\| L-2026-000\d /.test(l)).length, 4);
    assert.doesNotMatch(reg, /support@example\.test/);
});

test('issue: an invalid contact is refused with a field, audited, and nothing is written', async (t) => {
    const app = await startApp(t);
    const c = await app.login();
    const cases = [
        [{ contactVendor: 'v'.repeat(101) }, 'contactVendor', 'Vendor must be at most 100 characters.'],
        [{ contactEmail: 'support' }, 'contactEmail', 'Contact email must look like name@domain (no spaces).'],
        [{ contactEmail: 'support@' }, 'contactEmail', 'Contact email must look like name@domain (no spaces).'],
        [{ contactEmail: 'sup port@example.test' }, 'contactEmail', 'Contact email must look like name@domain (no spaces).'],
        [{ contactEmail: `${'e'.repeat(190)}@example.test` }, 'contactEmail', 'Contact email must be at most 200 characters.'],
        [{ contactVendor: 42 }, 'contactVendor', 'Vendor must be text.'],
        [{ contactEmail: ['support@example.test'] }, 'contactEmail', 'Contact email must be text.'],
    ];
    for (const [change, field, error] of cases) {
        const r = await c.issue({ ...GOOD, ...change });
        assert.equal(r.status, 400, JSON.stringify(change));
        assert.equal(r.json.field, field);
        assert.equal(r.json.error, error);
    }
    assert.equal(fs.existsSync(app.config.issuedDir) ? fs.readdirSync(app.config.issuedDir).length : 0, 0);
    assert.equal(fs.existsSync(app.config.registryFile), false);
    assert.match(app.auditText(), /"event":"issue-refused".*"reason":"Contact email must look like name@domain \(no spaces\)\."/);
});

test('page rules (public/contact.js) agree with the server rules (core.makeContact)', () => {
    const samples = [
        ['', ''], ['Example Vendor', ''], ['', 'support@example.test'], ['Example Vendor', 'support@example.test'],
        ['  ', '  '], ['v'.repeat(100), ''], ['v'.repeat(101), ''], ['', 'support'], ['', '@example.test'], ['', 'a@b@c'],
        ['', 'sup port@example.test'], ['', ` ${'e'.repeat(187)}@example.test `], ['', `${'e'.repeat(188)}@example.test`],
    ];
    for (const [vendor, email] of samples) {
        const page = C.check(vendor, email);
        const server = core.makeContact({ vendor, email });
        assert.equal(!!(page.vendor || page.email), !!server.error, JSON.stringify([vendor, email]));
        if (server.error) assert.equal(page.vendor || page.email, server.error);
    }
    assert.equal(C.text('Example Vendor', 'support@example.test'), 'Example Vendor (support@example.test)');
    assert.equal(C.text(' Example Vendor ', ''), 'Example Vendor');
    assert.equal(C.text('', 'support@example.test'), 'support@example.test');
    assert.equal(C.text('', ''), '');
});

test('page: Vendor / Contact email fields in the Issue form, review row, defaults, kept after an issue', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'tab-issue.js'), 'utf8');
    const form = html.slice(html.indexOf('<form id="issueForm"'), html.indexOf('</form>', html.indexOf('<form id="issueForm"')));
    assert.ok(form.indexOf('id="customerSearch"') < form.indexOf('id="contactVendor"'));
    assert.ok(form.indexOf('id="contactVendor"') < form.indexOf('id="contactEmail"'));
    assert.match(form, /<label for="contactVendor">Vendor <span class="muted">\(optional\)<\/span><\/label>/);
    assert.match(form, /<label for="contactEmail">Contact email <span class="muted">\(optional\)<\/span><\/label>/);
    assert.match(form, /id="contactVendor"[^>]*maxlength="100"/);
    assert.match(form, /id="contactEmail"[^>]*maxlength="200"/);
    assert.ok(html.indexOf('<script src="contact.js"></script>') < html.indexOf('<script src="tab-issue.js"></script>'));
    assert.match(js, /\['Vendor contact', C\.text\(v\.contactVendor, v\.contactEmail\) \|\| 'none'\]/); // review row
    assert.match(js, /\$\('reviewBtn'\)\.disabled = !!\(bad\.vendor \|\| bad\.email\);/);
    assert.match(js, /reset\(true\); \/\/ the next license for the same vendor contact/); // after a successful issue
    assert.match(js, /\$\('contactVendor'\)\.value = cd\.vendor \|\| '';/);
    assert.doesNotMatch(html + js, /sales@example/);
});

test('page rules refuse control characters in the vendor name and the contact email', () => {
    const C2 = require('../public/contact.js');
    assert.match(C2.check('Example\nVendor', '').vendor, /control characters/);
    assert.match(C2.check('', 'support\u001b@example.test').email, /control characters/);
    assert.match(C2.check('', 'support@example.test\u0000').email, /control characters/);
    assert.equal(C2.check('Example Vendor', 'support@example.test').vendor, '');
});
