const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const {
    encryptPassword, decryptPassword, encryptText, decryptText, getSystemKey,
} = require('../../lib/crypto');

test('encryptPassword/decryptPassword round-trip', () => {
    const cipher = encryptPassword('P@ssw0rd!中文', 'secret-1');
    assert.equal(decryptPassword(cipher, 'secret-1'), 'P@ssw0rd!中文');
});

test('encryptPassword output format is iv:salt:data with random IV', () => {
    const a = encryptPassword('same', 'k');
    const b = encryptPassword('same', 'k');
    assert.notEqual(a, b);
    const parts = a.split(':');
    assert.equal(parts.length, 3);
    assert.equal(parts[0].length, 32); // 16-byte IV hex
    assert.equal(parts[1].length, 32); // 16-byte salt hex
});

test('decryptPassword with wrong secret never reveals the plaintext', () => {
    for (let i = 0; i < 50; i++) {
        const cipher = encryptPassword('hello-plaintext', 'right');
        assert.notEqual(decryptPassword(cipher, 'wrong'), 'hello-plaintext');
    }
});

test('decryptPassword returns empty string for empty or malformed input', () => {
    assert.equal(decryptPassword('', 'k'), '');
    assert.equal(decryptPassword('no-colons', 'k'), '');
});

test('decryptPassword still reads legacy 2-part format (hardcoded salt "salt")', () => {
    const iv = nodeCrypto.randomBytes(16);
    const key = nodeCrypto.scryptSync('legacy-secret', 'salt', 32);
    const c = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
    const data = c.update('old-value', 'utf8', 'hex') + c.final('hex');
    assert.equal(decryptPassword(`${iv.toString('hex')}:${data}`, 'legacy-secret'), 'old-value');
});

test('getSystemKey creates and persists a key inside DB_DATA_DIR', () => {
    const key1 = getSystemKey();
    assert.match(key1, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(dataDir, '.system_key')));
    assert.equal(getSystemKey(), key1);
});

test('encryptText/decryptText round-trip with system key', () => {
    const cipher = encryptText('{"roles":["SuperAdmin"]}');
    assert.equal(decryptText(cipher), '{"roles":["SuperAdmin"]}');
});

test('decryptText throws DECRYPTION_FAILED on truncated or malformed input', () => {
    const cipher = encryptText('payload');
    // Dropping one byte breaks the AES block length, which always fails
    assert.throws(() => decryptText(cipher.slice(0, -2)), { message: 'DECRYPTION_FAILED' });
    assert.throws(() => decryptText('garbage'), { message: 'DECRYPTION_FAILED' });
});

test('decryptText never returns the plaintext for bit-flipped ciphertext', () => {
    // AES-CBC has no integrity check: a flipped last block passes PKCS#7 padding ~1/290 of the time
    // and yields garbage instead of throwing, so assert the secret is never revealed rather than a throw.
    for (let i = 0; i < 10; i++) {
        const cipher = encryptText('payload');
        const tampered = cipher.slice(0, -4) + (cipher.endsWith('0000') ? 'ffff' : '0000');
        let result;
        try { result = decryptText(tampered); } catch (e) { result = e.message; }
        assert.notEqual(result, 'payload');
    }
});

test('encryptText/decryptText return empty string for empty input', () => {
    assert.equal(encryptText(''), '');
    assert.equal(decryptText(''), '');
});
