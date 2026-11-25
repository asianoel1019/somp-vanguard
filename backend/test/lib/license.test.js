require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dbManager = require('../../services/db');
const { readDataSync, writeDataSync } = require('../../lib/db');
const lic = require('../../lib/license');
const { signLicense, setPaid, setFree, PAID_TEXT } = require('../helpers/license');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { setPaid(); await dbManager.closeDB(); });

test('canonicalJson sorts keys at every level', () => {
    assert.equal(lic.canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}');
});

test('verifyLicense accepts a correctly signed paid license', () => {
    const r = lic.verifyLicense(signLicense());
    assert.equal(r.valid, true);
    assert.equal(r.payload.customer, 'Example Test Co.');
});

test('verifyLicense rejects tampering, unknown keys, bad versions, non-paid editions and garbage', () => {
    const doc = JSON.parse(signLicense());
    doc.payload.customer = 'Someone Else';
    assert.match(lic.verifyLicense(JSON.stringify(doc)).reason, /signature/);

    const sig = JSON.parse(signLicense());
    sig.signature = Buffer.alloc(64, 1).toString('base64');
    assert.match(lic.verifyLicense(JSON.stringify(sig)).reason, /signature/);

    assert.match(lic.verifyLicense(signLicense({ keyId: 'nope' })).reason, /unknown key/);
    assert.match(lic.verifyLicense(signLicense({ formatVersion: 3 })).reason, /format version/);
    assert.match(lic.verifyLicense(signLicense({ edition: 'free' })).reason, /not paid/);
    assert.match(lic.verifyLicense(signLicense({ customer: '' })).reason, /missing customer/);
    assert.match(lic.verifyLicense('not json').reason, /JSON/);
    assert.match(lic.verifyLicense('{"payload":1}').reason, /payload or signature/);
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    assert.match(lic.verifyLicense(signLicense({}, privateKey)).reason, /signature/);
});

test('getLicense / isPaid / licenseAllows / channelAllowed follow the stored document', () => {
    setPaid();
    assert.equal(lic.isPaid(), true);
    assert.equal(lic.getLicense().customer, 'Example Test Co.');
    assert.equal(lic.licenseAllows('dataCenter'), true);
    assert.equal(lic.channelAllowed('telegram'), true);
    assert.deepEqual(lic.lockedFeatures(), []);

    setFree();
    assert.equal(lic.isPaid(), false);
    assert.equal(lic.getLicense().reason, 'no license');
    assert.equal(lic.licenseAllows('dataCenter'), false);
    assert.equal(lic.licenseAllows('serverList'), true); // not a paid feature
    assert.equal(lic.channelAllowed('email'), false);
    assert.deepEqual(lic.lockedFeatures(), lic.PAID_FEATURES);
    assert.deepEqual(lic.lockedChannels(), lic.PAID_CHANNELS);
    assert.match(lic.statusLine(), /^License: Free \(no license\)$/);

    writeDataSync(lic.LICENSE_KEY, 'garbage string');
    assert.equal(lic.isPaid(), false);
    writeDataSync(lic.LICENSE_KEY, { text: 'tampered' });
    assert.equal(lic.isPaid(), false);
    assert.match(lic.getLicense().reason, /JSON/);
});

test('installLicense stores only valid licenses; removeLicense returns to free', () => {
    setFree();
    const bad = lic.installLicense('{"x":1}', 'boss');
    assert.equal(bad.ok, false);
    assert.equal(lic.isPaid(), false);

    const good = lic.installLicense(`  ${PAID_TEXT}\n`, 'boss');
    assert.equal(good.ok, true);
    assert.equal(lic.isPaid(), true);
    const doc = readDataSync(lic.LICENSE_KEY);
    assert.equal(doc.text, PAID_TEXT);
    assert.equal(doc.uploadedBy, 'boss');
    assert.match(lic.statusLine(), /^License: Paid \(Example Test Co\., L-TEST-0001, expires 2099-12-31, \d+ days left\)$/);

    lic.removeLicense('boss');
    assert.equal(lic.isPaid(), false);
});

test('importLicenseFile imports a valid license.lic once and never replaces a license with an invalid file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-lic-'));
    setFree();
    assert.equal(lic.importLicenseFile(dir).reason, 'no file');

    fs.writeFileSync(path.join(dir, 'license.lic'), PAID_TEXT);
    const r = lic.importLicenseFile(dir);
    assert.equal(r.imported, true);
    assert.equal(r.licenseId, 'L-TEST-0001');
    assert.equal(lic.isPaid(), true);
    assert.equal(readDataSync(lic.LICENSE_KEY).uploadedBy, 'license.lic');
    assert.equal(lic.importLicenseFile(dir).reason, 'same');

    fs.writeFileSync(path.join(dir, 'license.lic'), 'broken');
    const bad = lic.importLicenseFile(dir);
    assert.equal(bad.imported, false);
    assert.equal(bad.reason, 'no valid license file');
    assert.match(bad.invalid[0].reason, /JSON/);
    assert.equal(lic.isPaid(), true); // the stored license is untouched
});

test('license.lic does not undo a UI removal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-lic-'));
    setFree();
    fs.writeFileSync(path.join(dir, 'license.lic'), PAID_TEXT);
    assert.equal(lic.importLicenseFile(dir).imported, true);
    lic.removeLicense('boss');
    assert.equal(lic.importLicenseFile(dir).reason, 'same');
    assert.equal(lic.isPaid(), false);
});

test('license.lic does not undo a UI replacement', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-lic-'));
    setFree();
    fs.writeFileSync(path.join(dir, 'license.lic'), PAID_TEXT);
    assert.equal(lic.importLicenseFile(dir).imported, true);
    assert.equal(lic.installLicense(signLicense({ licenseId: 'L-TEST-0002' }), 'boss').ok, true);
    const r = lic.importLicenseFile(dir);
    assert.equal(r.imported, false);
    assert.equal(lic.getLicense().licenseId, 'L-TEST-0002');
});

test('a changed license.lic is imported', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-lic-'));
    setFree();
    fs.writeFileSync(path.join(dir, 'license.lic'), PAID_TEXT);
    assert.equal(lic.importLicenseFile(dir).imported, true);
    fs.writeFileSync(path.join(dir, 'license.lic'), signLicense({ licenseId: 'L-TEST-0003' }));
    const r = lic.importLicenseFile(dir);
    assert.equal(r.imported, true);
    assert.equal(r.licenseId, 'L-TEST-0003');
});

test('importLicenseFile picks the newest valid *.lic, whatever the file names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-lic-'));
    setFree();
    fs.writeFileSync(path.join(dir, 'a-old.lic'), signLicense({ licenseId: 'L-TEST-0010', issuedAt: '2026-01-01' }));
    fs.writeFileSync(path.join(dir, 'b-new.LIC'), signLicense({ licenseId: 'L-TEST-0011', issuedAt: '2026-06-01' }));
    fs.writeFileSync(path.join(dir, 'c-newest-tampered.lic'), signLicense({ issuedAt: '2027-01-01' }).replace('Example Test Co.', 'Other Co.'));
    fs.writeFileSync(path.join(dir, 'd-broken.lic'), 'broken');
    fs.writeFileSync(path.join(dir, 'notes.txt'), signLicense({ licenseId: 'L-TEST-0099', issuedAt: '2028-01-01' }));
    const r = lic.importLicenseFile(dir);
    assert.equal(r.imported, true);
    assert.equal(r.file, 'b-new.LIC');
    assert.equal(r.licenseId, 'L-TEST-0011');
    assert.deepEqual(r.invalid.map(f => f.file), ['c-newest-tampered.lic', 'd-broken.lic']);
    assert.equal(lic.getLicense().licenseId, 'L-TEST-0011');
    assert.equal(readDataSync(lic.LICENSE_KEY).uploadedBy, 'b-new.LIC');
    assert.equal(lic.importLicenseFile(dir).reason, 'same');

    fs.writeFileSync(path.join(dir, 'z-newer.lic'), signLicense({ licenseId: 'L-TEST-0012', issuedAt: '2026-09-01' }));
    assert.equal(lic.importLicenseFile(dir).licenseId, 'L-TEST-0012');
    assert.equal(lic.getLicense().licenseId, 'L-TEST-0012');
});

test('importLicenseFile breaks an issuedAt tie by licenseId', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-lic-'));
    setFree();
    fs.writeFileSync(path.join(dir, 'x.lic'), signLicense({ licenseId: 'L-TEST-0021' }));
    fs.writeFileSync(path.join(dir, 'y.lic'), signLicense({ licenseId: 'L-TEST-0020' }));
    assert.equal(lic.importLicenseFile(dir).licenseId, 'L-TEST-0021');
});

test('importLicenseFile reports when no .lic file is valid and keeps the stored license', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-lic-'));
    setPaid();
    fs.writeFileSync(path.join(dir, 'one.lic'), 'broken');
    const r = lic.importLicenseFile(dir);
    assert.equal(r.imported, false);
    assert.equal(r.reason, 'no valid license file');
    assert.equal(r.invalid.length, 1);
    assert.equal(lic.isPaid(), true);
});

test('importLicenseFile does not replace a newer stored license with an older file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-lic-'));
    setFree();
    assert.equal(lic.installLicense(signLicense({ licenseId: 'L-TEST-0031', issuedAt: '2026-12-01' }), 'boss').ok, true);
    fs.writeFileSync(path.join(dir, 'old.lic'), signLicense({ licenseId: 'L-TEST-0030', issuedAt: '2026-10-01' }));
    const r = lic.importLicenseFile(dir);
    assert.equal(r.imported, false);
    assert.match(r.reason, /older than the current license L-TEST-0031/);
    assert.equal(lic.getLicense().licenseId, 'L-TEST-0031');
});

test('format: only version 2 with a valid expiresAt', () => {
    assert.equal(lic.verifyLicense(signLicense()).valid, true);
    assert.equal(lic.verifyLicense(signLicense({ formatVersion: 1 })).reason, 'unsupported format version 1: issue a new license with an expiry date');
    assert.equal(lic.verifyLicense(signLicense({ formatVersion: 3 })).reason, 'unsupported format version 3');
    assert.equal(lic.verifyLicense(signLicense({ expiresAt: undefined })).reason, 'missing expiresAt');
    assert.equal(lic.verifyLicense(signLicense({ expiresAt: '2027-02-30' })).reason, 'invalid expiresAt');
    assert.equal(lic.verifyLicense(signLicense({ expiresAt: '27-1-1' })).reason, 'invalid expiresAt');
    assert.equal(lic.verifyLicense(signLicense({ issuedAt: '2027-05-01', expiresAt: '2027-04-30' })).reason, 'invalid expiresAt');
    // A signed non-string expiresAt must not throw (String(['2027-12-31']) would pass the date pattern).
    assert.equal(lic.verifyLicense(signLicense({ expiresAt: ['2099-12-31'] })).reason, 'invalid expiresAt');
    assert.equal(lic.verifyLicense(signLicense({ expiresAt: 20991231 })).reason, 'invalid expiresAt');
});

test('expiry: valid through the expiry day, free the next day, no reload needed', (t) => {
    t.after(() => lic._setClockForTest(null));
    const text = signLicense({ issuedAt: '2027-01-01', expiresAt: '2027-03-10' });
    writeDataSync(lic.LICENSE_KEY, { text, uploadedAt: 'x', uploadedBy: 'test' });
    lic._setClockForTest(() => new Date(2027, 2, 9, 12, 0, 0));
    assert.equal(lic.isPaid(), true);
    assert.equal(lic.getLicense().daysLeft, 1);
    assert.equal(lic.getLicense().expiredAt, '', 'paid and free states have the same keys');
    const paidKeys = Object.keys(lic.getLicense()).sort();
    assert.match(lic.statusLine(), /^License: Paid \(Example Test Co\., L-TEST-0001, expires 2027-03-10, 1 days left\)$/);
    lic._setClockForTest(() => new Date(2027, 2, 10, 23, 59, 0));
    assert.equal(lic.isPaid(), true);
    assert.equal(lic.getLicense().daysLeft, 0);
    lic._setClockForTest(() => new Date(2027, 2, 11, 0, 0, 1));
    assert.equal(lic.isPaid(), false);
    const s = lic.getLicense();
    assert.equal(s.reason, 'expired on 2027-03-10');
    assert.equal(s.expiredAt, '2027-03-10');
    assert.equal(s.daysLeft, null);
    assert.deepEqual(Object.keys(s).sort(), paidKeys, 'paid and expired states have the same keys');
    assert.equal(s.licenseId, 'L-TEST-0001', 'an expired state keeps the id and customer for the notice');
    assert.ok(lic.lockedFeatures().length > 0);
});

test('install and folder import refuse version 1 and expired licenses', (t) => {
    t.after(() => lic._setClockForTest(null));
    setPaid();
    assert.equal(lic.installLicense(signLicense({ formatVersion: 1 }), 'boss').ok, false);
    lic._setClockForTest(() => new Date(2030, 0, 1));
    assert.equal(lic.installLicense(signLicense({ expiresAt: '2029-12-31' }), 'boss').ok, false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-lic-'));
    setFree();
    fs.writeFileSync(path.join(dir, 'v1.lic'), signLicense({ formatVersion: 1, licenseId: 'L-TEST-0101', issuedAt: '2029-06-01' }));
    fs.writeFileSync(path.join(dir, 'v2.lic'), signLicense({ licenseId: 'L-TEST-0102', issuedAt: '2029-01-01', expiresAt: '2031-01-01' }));
    const r = lic.importLicenseFile(dir);
    assert.equal(r.licenseId, 'L-TEST-0102');
    assert.deepEqual(r.invalid.map(f => f.file), ['v1.lic']);
});

test('daysBetween and today', (t) => {
    t.after(() => lic._setClockForTest(null));
    lic._setClockForTest(() => new Date(2027, 11, 31, 8, 0, 0));
    assert.equal(lic.today(), '2027-12-31');
    assert.equal(lic.daysBetween('2027-12-31', '2028-01-30'), 30);
    assert.equal(lic.daysBetween('2028-03-01', '2028-02-28'), -2); // leap year
});

test('noteSkipped logs once per hour per subject', (t) => {
    const lines = [];
    t.mock.method(console, 'log', (msg) => lines.push(msg));
    lic.noteSkipped('Unit test channel');
    lic.noteSkipped('Unit test channel');
    assert.deepEqual(lines, ['[License] Unit test channel skipped: requires a paid license']);
});

const CONTACT = { vendor: 'Example Vendor', email: 'support@example.test' };
const withEnvContact = (t, vendor, email) => {
    const saved = { v: process.env.LICENSE_CONTACT_VENDOR, e: process.env.LICENSE_CONTACT_EMAIL };
    if (vendor === undefined) delete process.env.LICENSE_CONTACT_VENDOR; else process.env.LICENSE_CONTACT_VENDOR = vendor;
    if (email === undefined) delete process.env.LICENSE_CONTACT_EMAIL; else process.env.LICENSE_CONTACT_EMAIL = email;
    t.after(() => {
        if (saved.v === undefined) delete process.env.LICENSE_CONTACT_VENDOR; else process.env.LICENSE_CONTACT_VENDOR = saved.v;
        if (saved.e === undefined) delete process.env.LICENSE_CONTACT_EMAIL; else process.env.LICENSE_CONTACT_EMAIL = saved.e;
    });
};

test('contact: optional; when present an object of non-empty strings within the limits', () => {
    assert.equal(lic.verifyLicense(signLicense()).valid, true); // absent
    assert.equal(lic.verifyLicense(signLicense({ contact: CONTACT })).valid, true);
    assert.equal(lic.verifyLicense(signLicense({ contact: { vendor: 'Example Vendor' } })).valid, true);
    assert.equal(lic.verifyLicense(signLicense({ contact: { email: 'support@example.test' } })).valid, true);
    assert.equal(lic.verifyLicense(signLicense({ contact: { vendor: 'v'.repeat(100), email: `${'e'.repeat(187)}@example.test` } })).valid, true);
    const bad = [
        null, 'support@example.test', ['support@example.test'], 42,
        { vendor: '' }, { vendor: '   ' }, { vendor: 7 }, { vendor: 'v'.repeat(101) },
        { email: '' }, { email: 7 }, { email: `${'e'.repeat(188)}@example.test` },
        { email: 'support' }, { email: 'support@' }, { email: '@example.test' }, { email: 'sup port@example.test' }, { email: 'a@b@c' },
    ];
    for (const contact of bad) assert.equal(lic.verifyLicense(signLicense({ contact })).reason, 'invalid contact', JSON.stringify(contact));
});

test('getLicense: contact of a paid and of an expired license; null without one', (t) => {
    t.after(() => lic._setClockForTest(null));
    writeDataSync(lic.LICENSE_KEY, { text: signLicense({ contact: CONTACT }), uploadedAt: 'x', uploadedBy: 'test' });
    assert.deepEqual(lic.getLicense().contact, CONTACT);
    writeDataSync(lic.LICENSE_KEY, { text: signLicense({ contact: { email: 'support@example.test' } }), uploadedAt: 'x', uploadedBy: 'test' });
    assert.deepEqual(lic.getLicense().contact, { vendor: '', email: 'support@example.test' });
    writeDataSync(lic.LICENSE_KEY, { text: signLicense({ expiresAt: '2027-03-10', contact: CONTACT }), uploadedAt: 'x', uploadedBy: 'test' });
    lic._setClockForTest(() => new Date(2027, 2, 11, 9, 0, 0));
    const expired = lic.getLicense();
    assert.equal(expired.edition, 'free');
    assert.equal(expired.expiredAt, '2027-03-10');
    assert.deepEqual(expired.contact, CONTACT);
    lic._setClockForTest(null);
    setPaid();
    assert.equal(lic.getLicense().contact, null);
    setFree();
    assert.equal(lic.getLicense().contact, null);
});

test('removeLicense keeps the removed license contact; an install replaces it', () => {
    setFree();
    assert.equal(lic.installLicense(signLicense({ contact: CONTACT }), 'boss').ok, true);
    lic.removeLicense('boss');
    assert.deepEqual(readDataSync(lic.LICENSE_KEY).lastContact, CONTACT);
    assert.equal(lic.isPaid(), false);
    assert.deepEqual(lic.getLicense().contact, CONTACT);
    assert.deepEqual(lic.resolveContact(), CONTACT);
    lic.removeLicense('boss'); // removing again keeps it
    assert.deepEqual(readDataSync(lic.LICENSE_KEY).lastContact, CONTACT);

    assert.equal(lic.installLicense(PAID_TEXT, 'boss').ok, true); // a license without a contact
    assert.equal(readDataSync(lic.LICENSE_KEY).lastContact, undefined);
    assert.equal(lic.getLicense().contact, null);
    lic.removeLicense('boss');
    assert.equal(readDataSync(lic.LICENSE_KEY).lastContact, undefined);
    assert.equal(lic.getLicense().contact, null);

    writeDataSync(lic.LICENSE_KEY, { lastContact: { email: 'not an email' } }); // a bad stored value is ignored
    assert.equal(lic.getLicense().contact, null);
});

test('resolveContact: license -> removed license -> .env -> null; publicState.contact', (t) => {
    withEnvContact(t, undefined, undefined);
    setFree();
    assert.equal(lic.resolveContact(), null);
    assert.equal(lic.publicState().contact, null);

    withEnvContact(t, ' Example Env Vendor ', 'env@example.test');
    assert.deepEqual(lic.resolveContact(), { vendor: 'Example Env Vendor', email: 'env@example.test' });
    assert.deepEqual(lic.publicState().contact, { vendor: 'Example Env Vendor', email: 'env@example.test' });
    withEnvContact(t, '', 'env@example.test');
    assert.deepEqual(lic.resolveContact(), { vendor: '', email: 'env@example.test' });
    withEnvContact(t, 'Example Env Vendor', 'not an email'); // invalid values are not shown
    assert.equal(lic.resolveContact(), null);
    withEnvContact(t, 'Example Env Vendor', undefined);
    assert.deepEqual(lic.resolveContact(), { vendor: 'Example Env Vendor', email: '' });

    setPaid(); // a license without a contact: .env
    assert.deepEqual(lic.publicState().contact, { vendor: 'Example Env Vendor', email: '' });
    writeDataSync(lic.LICENSE_KEY, { text: signLicense({ contact: CONTACT }), uploadedAt: 'x', uploadedBy: 'test' });
    assert.deepEqual(lic.publicState().contact, CONTACT);
    assert.equal(lic.publicState().edition, 'paid');
    writeDataSync(lic.LICENSE_KEY, { lastContact: { vendor: 'Example Old Vendor' } });
    assert.deepEqual(lic.resolveContact(), { vendor: 'Example Old Vendor', email: '' });
    setPaid();
});

test('contact vendor or email with control characters makes the license invalid', () => {
    assert.equal(lic.verifyLicense(signLicense({ contact: { vendor: 'Example\nVendor' } })).reason, 'invalid contact');
    for (const email of ['support\u0000@example.test', 'support@example\u001b.test', 'support@example.test\u007f']) {
        assert.equal(lic.verifyLicense(signLicense({ contact: { email } })).reason, 'invalid contact', JSON.stringify(email));
    }
    assert.equal(lic.verifyLicense(signLicense({ contact: { vendor: 'Example Vendor', email: 'support@example.test' } })).valid, true);
});

test('trial: optional boolean; any other present value makes the license invalid', () => {
    assert.equal(lic.verifyLicense(signLicense({ trial: true })).valid, true);
    assert.equal(lic.verifyLicense(signLicense({ trial: false })).valid, true);
    assert.equal(lic.verifyLicense(PAID_TEXT).valid, true); // absent
    for (const trial of ['true', 1, 0, null, {}, []]) {
        const r = lic.verifyLicense(signLicense({ trial }));
        assert.equal(r.valid, false, JSON.stringify(trial));
        assert.equal(r.reason, 'invalid trial', JSON.stringify(trial));
    }
});

test('state.trial: true for a trial license (valid or expired), false otherwise; publicState carries it', (t) => {
    t.after(() => { lic._setClockForTest(null); setPaid(); });
    setPaid();
    assert.equal(lic.getLicense().trial, false);
    writeDataSync(lic.LICENSE_KEY, { text: signLicense({ trial: true, expiresAt: '2027-03-10' }), uploadedAt: 'x', uploadedBy: 'test' });
    assert.equal(lic.getLicense().trial, true);
    assert.equal(lic.getLicense().edition, 'paid');
    assert.equal(lic.publicState().trial, true);
    assert.deepEqual(lic.reminderDaysFor(lic.getLicense()), [7, 3, 1]);
    lic._setClockForTest(() => new Date(2027, 2, 11, 9, 0, 0));
    const expired = lic.getLicense();
    assert.equal(expired.edition, 'free');
    assert.equal(expired.trial, true);
    writeDataSync(lic.LICENSE_KEY, { text: signLicense({ trial: false }), uploadedAt: 'x', uploadedBy: 'test' });
    lic._setClockForTest(null);
    assert.equal(lic.getLicense().trial, false);
    assert.deepEqual(lic.reminderDaysFor(lic.getLicense()), [30, 14, 7, 3, 2, 1]);
    writeDataSync(lic.LICENSE_KEY, {});
    assert.equal(lic.getLicense().trial, false);
    assert.equal(lic.publicState().trial, false);
});
