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

test('keygen -> issue -> verify round trip', (t) => {
    t.mock.method(console, 'log', () => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-keys-'));
    assert.equal(keygen.main(['--out', dir, '--key-id', 'kround']), 0);
    const priv = path.join(dir, 'kround-private.pem');
    const pub = fs.readFileSync(path.join(dir, 'kround-public.pem'), 'utf8');
    assert.match(fs.readFileSync(priv, 'utf8'), /BEGIN PRIVATE KEY/);

    KEYS.kround = pub;
    const out = path.join(dir, 'example.lic');
    assert.equal(issue.main(['--key', priv, '--key-id', 'kround', '--customer', 'Example Test Co.', '--id', 'L-2026-9999', '--issued', '2026-11-16', '--out', out]), 0);
    const r = verifyLicense(fs.readFileSync(out, 'utf8'));
    assert.equal(r.valid, true);
    assert.equal(r.payload.licenseId, 'L-2026-9999');
    assert.equal(r.payload.updatesUntil, null);
    delete KEYS.kround;
});

test('keygen refuses to overwrite an existing key; issue refuses a key the system does not trust', (t) => {
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-keys-'));
    assert.equal(keygen.main(['--out', dir, '--key-id', 'kx']), 0);
    assert.equal(keygen.main(['--out', dir, '--key-id', 'kx']), 1);
    const out = path.join(dir, 'x.lic');
    assert.equal(issue.main(['--key', path.join(dir, 'kx-private.pem'), '--key-id', 'kx', '--customer', 'A', '--id', 'L-1', '--out', out]), 1);
    assert.equal(fs.existsSync(out), false);
    assert.equal(issue.main(['--customer', 'A']), 1); // missing arguments
});
