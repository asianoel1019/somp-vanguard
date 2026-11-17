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
    assert.match(lic.verifyLicense(signLicense({ formatVersion: 2 })).reason, /format version/);
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
    assert.match(lic.statusLine(), /^License: Paid \(Example Test Co\., L-TEST-0001\)$/);

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

test('noteSkipped logs once per hour per subject', (t) => {
    const lines = [];
    t.mock.method(console, 'log', (msg) => lines.push(msg));
    lic.noteSkipped('Unit test channel');
    lic.noteSkipped('Unit test channel');
    assert.deepEqual(lines, ['[License] Unit test channel skipped: requires a paid license']);
});
