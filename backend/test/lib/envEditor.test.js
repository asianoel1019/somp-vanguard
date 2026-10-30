require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { readEnv, writeEnv, shouldEncrypt } = require('../../lib/envEditor');

const ENV_PATH = process.env.SOMP_ENV_PATH;

test.beforeEach(() => {
    fs.writeFileSync(ENV_PATH, [
        '# comment line',
        'PORT=3000',
        'APP_NAME="SOMP Vanguard"',
        "SINGLE='quoted'",
        'NAS_1_HOST=10.0.0.1',
        'NAS_2_HOST=10.0.0.2',
        '',
    ].join('\n'), 'utf-8');
});

test('shouldEncrypt classifies sensitive keys', () => {
    assert.equal(shouldEncrypt('PORT'), false);
    assert.equal(shouldEncrypt('APP_NAME'), false);
    assert.equal(shouldEncrypt('JWT_SECRET'), true);
    assert.equal(shouldEncrypt('LOCAL_ADMIN_USER'), true);
    assert.equal(shouldEncrypt('AD_ADMIN_PWD'), true);
    assert.equal(shouldEncrypt('TELEGRAM_BOT_TOKEN'), true);
    assert.equal(shouldEncrypt('SMTP_PASS'), true);
});

test('readEnv parses values, strips quotes, skips comments', () => {
    const env = readEnv();
    assert.equal(env.PORT, '3000');
    assert.equal(env.APP_NAME, 'SOMP Vanguard');
    assert.equal(env.SINGLE, 'quoted');
    assert.equal(Object.keys(env).some(k => k.startsWith('#')), false);
});

test('writeEnv encrypts sensitive values on disk and readEnv decrypts them', () => {
    writeEnv({ AD_ADMIN_PWD: 'plain-secret', PORT: '3001' });
    const raw = fs.readFileSync(ENV_PATH, 'utf-8');
    assert.ok(!raw.includes('plain-secret'), 'password must not be stored in plain text');
    assert.match(raw, /^AD_ADMIN_PWD=enc:/m);
    assert.match(raw, /^PORT=3001$/m);
    const env = readEnv();
    assert.equal(env.AD_ADMIN_PWD, 'plain-secret');
    assert.equal(env.PORT, '3001');
});

test('writeEnv does not double-encrypt values already prefixed with enc:', () => {
    writeEnv({ AD_ADMIN_PWD: 'v1' });
    const firstLine = fs.readFileSync(ENV_PATH, 'utf-8').match(/^AD_ADMIN_PWD=(.*)$/m)[1];
    writeEnv({ AD_ADMIN_PWD: firstLine });
    const secondLine = fs.readFileSync(ENV_PATH, 'utf-8').match(/^AD_ADMIN_PWD=(.*)$/m)[1];
    assert.equal(secondLine, firstLine);
});

test('writeEnv keeps untouched keys and comments', () => {
    writeEnv({ PORT: '4000' });
    const raw = fs.readFileSync(ENV_PATH, 'utf-8');
    assert.match(raw, /^# comment line$/m);
    assert.match(raw, /^APP_NAME="SOMP Vanguard"$/m);
});

test('writeEnv removes keys matching dynamicPrefixes that are not in newConfig', () => {
    writeEnv({ NAS_1_HOST: '10.0.0.9' }, ['NAS_']);
    const env = readEnv();
    assert.equal(env.NAS_1_HOST, '10.0.0.9');
    assert.equal(env.NAS_2_HOST, undefined);
    assert.equal(env.PORT, '3000');
});

test('readEnv keeps original enc: string when decryption fails (no data loss)', () => {
    fs.appendFileSync(ENV_PATH, 'BROKEN_PWD=enc:aa:bb:cc\n');
    assert.equal(readEnv().BROKEN_PWD, 'enc:aa:bb:cc');
});
