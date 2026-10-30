require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createRedactor, redactString, collectSecretValues } = require('../../lib/agent/redact');

test('exact .env secret values are replaced', (t) => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'AD_ADMIN_PWD=Sup3rSecret!x\nPORT=3000\nAPP_NAME=SOMP\n');
    t.after(() => fs.writeFileSync(process.env.SOMP_ENV_PATH, ''));
    const secrets = collectSecretValues();
    assert.ok(secrets.includes('Sup3rSecret!x'));
    assert.ok(!secrets.includes('3000'));
    const { redact } = createRedactor();
    assert.equal(redact('login failed with Sup3rSecret!x for admin'), 'login failed with [REDACTED] for admin');
});

test('secrets shorter than 6 characters are ignored', () => {
    assert.equal(redactString('value abc here', ['abc']), 'value abc here');
});

test('key=value style secrets', () => {
    const out = redactString('user=bob password=hunter2 token: "abc123def" api_key=XYZ987 note=ok', []);
    assert.equal(out, 'user=bob password=[REDACTED] token: "[REDACTED]" api_key=[REDACTED] note=ok');
});

test('authorization headers', () => {
    assert.equal(redactString('Authorization: Bearer eyAbc.def-ghi_jklmnop', []), 'Authorization: Bearer [REDACTED]');
    assert.equal(redactString('Basic dXNlcjpwYXNzd29yZA==', []), 'Basic [REDACTED]');
});

test('credentials inside URLs', () => {
    assert.equal(redactString('connect mysql://app:P4ssw0rd@db01:3306/app', []), 'connect mysql://app:[REDACTED]@db01:3306/app');
});

test('private keys, JWTs, enc: values and AWS keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
    assert.equal(redactString(`key:\n${pem}\nend`, []), 'key:\n[REDACTED PRIVATE KEY]\nend');
    assert.equal(redactString('jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', []), 'jwt [REDACTED JWT]');
    assert.equal(redactString('v=enc:0123456789abcdef0123:fedcba98', []), 'v=[REDACTED]');
    assert.equal(redactString('aws AKIAIOSFODNN7EXAMPLE used', []), 'aws [REDACTED AWS KEY] used');
});

test('ordinary operational text is untouched', () => {
    const text = 'CPU 97% on web-03 (10.0.5.13); Token Elevation Type: %%1936; Event 4625 failed logon';
    assert.equal(redactString(text, []), text);
});

test('redact walks nested objects and arrays without mutating input', () => {
    const input = { events: [{ message: 'password=abc12345' }], count: 2, ok: true, nothing: null };
    const { redact } = createRedactor({ secrets: [] });
    const out = redact(input);
    assert.deepEqual(out, { events: [{ message: 'password=[REDACTED]' }], count: 2, ok: true, nothing: null });
    assert.equal(input.events[0].message, 'password=abc12345');
});

test('quoted values are redacted whole, including spaces', () => {
    assert.equal(redactString('password="my pass phrase" next', []), 'password="[REDACTED]" next');
    assert.equal(redactString("secret: 'a b c'", []), "secret: '[REDACTED]'");
});

test('authorization headers in any case; plain words after Basic survive', () => {
    assert.equal(redactString('authorization: bearer abcdefghijkl', []), 'authorization: bearer [REDACTED]');
    assert.equal(redactString('Proxy-Authorization: Basic dXNlcjpwYXNz', []), 'Proxy-Authorization: Basic [REDACTED]');
    assert.equal(redactString('Basic configuration failed', []), 'Basic configuration failed');
});

test('truncated PEM block is still redacted', () => {
    assert.equal(redactString('key:\n-----BEGIN PRIVATE KEY-----\nMIIabc', []), 'key:\n[REDACTED PRIVATE KEY]');
});

test('no partial artifacts: JWT after token=, @ inside URL password, newline not crossed', () => {
    assert.equal(redactString('token=eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', []), 'token=[REDACTED JWT]');
    assert.equal(redactString('ftp://u:p@ss@host/x', []), 'ftp://u:[REDACTED]@host/x');
    assert.equal(redactString('password=\nnextline', []), 'password=\nnextline');
});

test('large inputs are processed quickly (no catastrophic backtracking)', () => {
    const big = 'a-'.repeat(100000) + ' ' + 'x.'.repeat(100000);
    const t0 = Date.now();
    redactString(big, ['some-secret-value']);
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
});

test('JSON-style quoted keys and unterminated quotes are redacted', () => {
    assert.equal(redactString('{"password":"abc12345"}', []), '{"password":"[REDACTED]"}');
    assert.equal(redactString('{"token": "abcdef123"}', []), '{"token": "[REDACTED]"}');
    assert.equal(redactString('"api_key": "xyz98765", "user": "bob"', []), '"api_key": "[REDACTED]", "user": "bob"');
    assert.equal(redactString('password="abc', []), 'password="[REDACTED]');
    assert.equal(redactString('Token Elevation Type: %%1936', []), 'Token Elevation Type: %%1936');
});
