const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { encryptText } = require('../../lib/crypto');
const { loadEnv } = require('../../lib/loadEnv');

const KEYS = ['LE_PLAIN_TOKEN', 'LE_ENC_VALUE', 'LE_PLAIN_VALUE', 'SYSTEM_TIMEZONE', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY'];
let saved;
let savedProxy;

test.beforeEach(() => {
    saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    savedProxy = global.SYSTEM_PROXY;
});
test.afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    global.SYSTEM_PROXY = savedProxy;
});

const writeEnvFile = (text) => fs.writeFileSync(process.env.SOMP_ENV_PATH, text);

test('rewrite:false never modifies the file, even with a plain-text sensitive value', () => {
    const content = 'LE_PLAIN_TOKEN=plain-secret\nLE_PLAIN_VALUE=hello\n';
    writeEnvFile(content);
    const before = fs.statSync(process.env.SOMP_ENV_PATH).mtimeMs;
    loadEnv({ rewrite: false });
    assert.equal(fs.readFileSync(process.env.SOMP_ENV_PATH, 'utf8'), content);
    assert.equal(fs.statSync(process.env.SOMP_ENV_PATH).mtimeMs, before);
    assert.equal(process.env.LE_PLAIN_TOKEN, 'plain-secret');
});

test('rewrite:true encrypts plain-text secrets in the file and still exposes the plain value', () => {
    writeEnvFile('LE_PLAIN_TOKEN=plain-secret\nLE_PLAIN_VALUE=hello\n');
    loadEnv({ rewrite: true });
    const text = fs.readFileSync(process.env.SOMP_ENV_PATH, 'utf8');
    assert.match(text, /^LE_PLAIN_TOKEN=enc:/m);
    assert.ok(!text.includes('plain-secret'));
    assert.match(text, /^LE_PLAIN_VALUE=hello$/m);
    assert.equal(process.env.LE_PLAIN_TOKEN, 'plain-secret');
});

test('enc: values are decrypted into process.env', () => {
    writeEnvFile(`LE_ENC_VALUE=enc:${encryptText('top-secret')}\n`);
    loadEnv({ rewrite: false });
    assert.equal(process.env.LE_ENC_VALUE, 'top-secret');
});

test('TZ is derived from SYSTEM_TIMEZONE (UTC+N form supported)', () => {
    writeEnvFile('SYSTEM_TIMEZONE=UTC+8\n');
    loadEnv();
    assert.equal(process.env.TZ, 'Etc/GMT-8');
    writeEnvFile('SYSTEM_TIMEZONE=Europe/Paris\n');
    loadEnv();
    assert.equal(process.env.TZ, 'Europe/Paris');
});

test('proxy variables are moved into global.SYSTEM_PROXY and removed from process.env', () => {
    writeEnvFile('HTTPS_PROXY=http://proxy.example:3128\n');
    loadEnv();
    assert.equal(global.SYSTEM_PROXY, 'http://proxy.example:3128');
    assert.equal(process.env.HTTPS_PROXY, undefined);
    assert.equal(process.env.HTTP_PROXY, undefined);
});

test('envEditor.writeEnv replaces the file atomically (no .tmp left behind)', () => {
    const { writeEnv } = require('../../lib/envEditor');
    writeEnvFile('A=1\nB=2\n');
    writeEnv({ A: '9' });
    assert.equal(fs.readFileSync(process.env.SOMP_ENV_PATH, 'utf8'), 'A=9\nB=2\n');
    assert.equal(fs.existsSync(`${process.env.SOMP_ENV_PATH}.tmp`), false);
    assert.equal(path.dirname(process.env.SOMP_ENV_PATH), dataDir);
});

const errWith = (code) => Object.assign(new Error(`${code} simulated`), { code });
const tmpOf = () => `${process.env.SOMP_ENV_PATH}.tmp`;

test('writeEnv: rename failing with EPERM every time falls back to an in-place write and leaves no .tmp', (t) => {
    const { writeEnv } = require('../../lib/envEditor');
    writeEnvFile('A=1\nB=2\n');
    const rename = t.mock.method(fs, 'renameSync', () => { throw errWith('EPERM'); });
    writeEnv({ A: '7' });
    assert.equal(rename.mock.callCount(), 4, 'initial try + 3 retries');
    assert.equal(fs.readFileSync(process.env.SOMP_ENV_PATH, 'utf8'), 'A=7\nB=2\n');
    assert.equal(fs.existsSync(tmpOf()), false);
});

test('writeEnv: a single EPERM is retried and the rename is used', (t) => {
    const { writeEnv } = require('../../lib/envEditor');
    writeEnvFile('A=1\nB=2\n');
    const real = fs.renameSync;
    let calls = 0;
    t.mock.method(fs, 'renameSync', (from, to) => {
        calls++;
        if (calls === 1) throw errWith('EBUSY');
        return real(from, to);
    });
    writeEnv({ A: '8' });
    assert.equal(calls, 2);
    assert.equal(fs.readFileSync(process.env.SOMP_ENV_PATH, 'utf8'), 'A=8\nB=2\n');
    assert.equal(fs.existsSync(tmpOf()), false);
});

test('writeEnv: other errors (ENOSPC while writing the temp file) still throw and leave no .tmp', (t) => {
    const { writeEnv } = require('../../lib/envEditor');
    writeEnvFile('A=1\n');
    const real = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (p, ...rest) => {
        if (p === tmpOf()) { real(p, 'partial'); throw errWith('ENOSPC'); }
        return real(p, ...rest);
    });
    assert.throws(() => writeEnv({ A: '2' }), /ENOSPC/);
    assert.equal(fs.existsSync(tmpOf()), false);
    assert.equal(fs.readFileSync(process.env.SOMP_ENV_PATH, 'utf8'), 'A=1\n');
});

test('loadEnv({ rewrite: true }) survives a failing migration: warns and still decrypts', (t) => {
    const envEditor = require('../../lib/envEditor');
    writeEnvFile(`LE_PLAIN_TOKEN=plain-secret\nLE_ENC_VALUE=enc:${encryptText('still-works')}\n`);
    t.mock.method(envEditor, 'writeEnv', () => { throw errWith('EPERM'); });
    const warnings = [];
    loadEnv({ rewrite: true, logger: { log() {}, warn: (m) => warnings.push(m) } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Skipped .env secret migration: EPERM simulated/);
    assert.equal(process.env.LE_ENC_VALUE, 'still-works');
    assert.equal(process.env.LE_PLAIN_TOKEN, 'plain-secret');
});
