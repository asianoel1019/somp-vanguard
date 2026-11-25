// Test licenses: a throwaway Ed25519 key registered as 'ktest' and helpers that switch the edition.
const crypto = require('crypto');
const { KEYS } = require('../../lib/licenseKeys');
const { canonicalJson, LICENSE_KEY } = require('../../lib/license');
const { writeDataSync } = require('../../lib/db');

const TEST_KEY_ID = 'ktest';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
KEYS[TEST_KEY_ID] = publicKey.export({ type: 'spki', format: 'pem' });

function signLicense(overrides = {}, key = privateKey) {
    const payload = {
        formatVersion: 2, keyId: TEST_KEY_ID, licenseId: 'L-TEST-0001', customer: 'Example Test Co.',
        edition: 'paid', issuedAt: '2026-11-16', expiresAt: '2099-12-31', updatesUntil: null, ...overrides,
    };
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
    const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64');
    return JSON.stringify({ payload, signature }, null, 2);
}

const PAID_TEXT = signLicense();
const setPaid = () => writeDataSync(LICENSE_KEY, { text: PAID_TEXT, uploadedAt: '2026-11-16T00:00:00.000Z', uploadedBy: 'test' });
const setFree = () => writeDataSync(LICENSE_KEY, {});

module.exports = { TEST_KEY_ID, signLicense, setPaid, setFree, PAID_TEXT, testPrivateKey: privateKey };
