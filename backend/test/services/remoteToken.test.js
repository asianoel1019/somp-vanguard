require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { issueToken, consumeToken, tokenKey } = require('../../services/remoteToken');

const SECRET = 'test-secret-for-remote-tokens';
const payload = { connection: { type: 'rdp', settings: { hostname: '192.0.2.10', password: 'P@ss' } }, audit: { user: 'op1' } };

test('a token opens one session only', () => {
    const { token } = issueToken(payload, { secret: SECRET });
    const p = consumeToken(token, { secret: SECRET });
    assert.equal(p.connection.settings.password, 'P@ss');
    assert.throws(() => consumeToken(token, { secret: SECRET }), /already used/);
});

test('a token expires after 30 seconds', () => {
    const now = 1_800_000_000_000;
    const { token } = issueToken(payload, { secret: SECRET, now });
    assert.throws(() => consumeToken(token, { secret: SECRET, now: now + 30_001 }), /expired/);
    const fresh = issueToken(payload, { secret: SECRET, now });
    assert.ok(consumeToken(fresh.token, { secret: SECRET, now: now + 29_000 }));
});

test('a changed token, a token from another key and garbage are refused', () => {
    const { token } = issueToken(payload, { secret: SECRET });
    const raw = Buffer.from(token, 'base64url');
    raw[raw.length - 1] ^= 0x01; // flip one bit of the ciphertext
    assert.throws(() => consumeToken(raw.toString('base64url'), { secret: SECRET }), /Invalid remote session token/);
    const other = issueToken(payload, { secret: 'another-secret' });
    assert.throws(() => consumeToken(other.token, { secret: SECRET }), /Invalid remote session token/);
    for (const bad of ['', 'abc', 'eyJpdiI6ImEiLCJ2YWx1ZSI6ImIifQ==', null, undefined]) {
        assert.throws(() => consumeToken(bad, { secret: SECRET }), /Invalid remote session token/);
    }
});

test('the token key is not the JWT secret itself, and there is none without one', () => {
    const key = tokenKey(SECRET);
    assert.equal(key.length, 32);
    assert.notDeepEqual(key, crypto.createHash('sha256').update(SECRET).digest());
    assert.throws(() => tokenKey(''), (e) => e.status === 503 && /JWT_SECRET is not set/.test(e.message));
});

test('the token carries no readable credentials', () => {
    const { token } = issueToken(payload, { secret: SECRET });
    const text = Buffer.from(token, 'base64url').toString('latin1');
    assert.doesNotMatch(text, /P@ss|192\.0\.2\.10|op1/);
});
