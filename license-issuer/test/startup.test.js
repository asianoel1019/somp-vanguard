// Startup checks: settings, password hash, a readable key that matches the built-in public key; Set_Password helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readConfig, parseEnvFile } = require('../src/config');
const { checkStartup } = require('../src/startup');
const { verifyPassword, hashPassword, parseHash } = require('../src/auth');
const { upsertEnvLine } = require('../src/setPassword');
const { keyDir, makeConfig, testHash, PASSWORD, FAST } = require('./helpers');

test('readConfig: defaults, 127.0.0.1 only, registry next to the key', () => {
    const c = readConfig({ KEY_FILE: 'C:\\keys\\k1-private.pem', PASSWORD_HASH: 'x' });
    assert.equal(c.host, '127.0.0.1');
    assert.equal(c.port, 8444);
    assert.equal(c.keyId, 'k1');
    assert.equal(c.registryFile, path.resolve('C:\\keys\\issued-licenses.md'));
    assert.equal(c.issuedDir, path.resolve('C:\\keys\\issued'));
    assert.deepEqual(c.errors, []);
    const bad = readConfig({ PORT: '99999', HOST: '0.0.0.0' });
    assert.equal(bad.host, '127.0.0.1');
    assert.ok(bad.errors.some((e) => /PORT/.test(e)));
    assert.ok(bad.errors.some((e) => /KEY_FILE is required/.test(e)));
    assert.ok(bad.errors.some((e) => /PASSWORD_HASH is missing/.test(e)));
    assert.deepEqual(parseEnvFile('# c\nKEY_FILE="C:\\k\\a.pem"\nPASSWORD_HASH=scrypt$1$2\n'), { KEY_FILE: 'C:\\k\\a.pem', PASSWORD_HASH: 'scrypt$1$2' });
});

test('startup passes with a trusted key and creates ISSUED_DIR', async (t) => {
    const k = keyDir(t);
    const config = await makeConfig(k);
    const r = checkStartup(config);
    assert.deepEqual(r.errors, []);
    assert.equal(r.privateKey.asymmetricKeyType, 'ed25519');
    assert.equal(fs.statSync(config.issuedDir).isDirectory(), true);
});

test('startup refuses: missing or malformed hash, unreadable key, unknown KEY_ID, mismatched key', async (t) => {
    const k = keyDir(t);
    const missing = checkStartup(readConfig({ KEY_FILE: k.keyFile, KEY_ID: k.keyId }));
    assert.ok(missing.errors.some((e) => /PASSWORD_HASH is missing/.test(e)));
    assert.equal(missing.privateKey, null);

    const malformed = checkStartup(await makeConfig(k, { passwordHash: 'plain-text-password' }));
    assert.ok(malformed.errors.some((e) => /not a valid scrypt hash/.test(e)));

    const unreadable = checkStartup(await makeConfig(k, { keyFile: path.join(k.dir, 'nope.pem') }));
    assert.ok(unreadable.errors.some((e) => /KEY_FILE cannot be read.*ENOENT/.test(e)));
    const garbage = path.join(k.dir, 'garbage.pem');
    fs.writeFileSync(garbage, 'not a key');
    assert.ok(checkStartup(await makeConfig(k, { keyFile: garbage })).errors.some((e) => /KEY_FILE cannot be read/.test(e)));

    assert.ok(checkStartup(await makeConfig(k, { keyId: 'k-none' })).errors.some((e) => /no built-in public key/.test(e)));

    const other = path.join(k.dir, 'other-private.pem');
    fs.writeFileSync(other, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const mismatch = checkStartup(await makeConfig(k, { keyFile: other }));
    assert.ok(mismatch.errors.some((e) => /does not match the built-in public key/.test(e)));
    assert.equal(mismatch.privateKey, null);
    const rsa = path.join(k.dir, 'rsa.pem');
    fs.writeFileSync(rsa, crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.ok(checkStartup(await makeConfig(k, { keyFile: rsa })).errors.some((e) => /not an Ed25519/.test(e)));
    // no message carries key material
    const all = [missing, malformed, unreadable, mismatch].flatMap((r) => r.errors).join('\n');
    assert.doesNotMatch(all, /PRIVATE KEY|MC4CAQAwBQYDK2Vw/);
});

test('server.js exits non-zero with a clear message and never listens when a check fails', (t) => {
    const k = keyDir(t);
    const other = path.join(k.dir, 'stranger-private.pem');
    fs.writeFileSync(other, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const run = (env) => spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
        env: { ...process.env, PORT: '18444', ISSUED_DIR: path.join(k.dir, 'issued'), REGISTRY_FILE: '', ...env }, encoding: 'utf8', timeout: 20000,
    });
    const noHash = run({ PASSWORD_HASH: '', KEY_FILE: other, KEY_ID: 'k1' });
    assert.equal(noHash.status, 1);
    assert.match(noHash.stderr, /Cannot start[\s\S]*PASSWORD_HASH is missing/);
    // k1 is the real product key: a random key cannot match it
    const hash = 'scrypt$1024$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const wrongKey = run({ PASSWORD_HASH: hash, KEY_FILE: other, KEY_ID: 'k1' });
    assert.equal(wrongKey.status, 1);
    assert.match(wrongKey.stderr, /does not match the built-in public key for KEY_ID "k1"/);
    const noKey = run({ PASSWORD_HASH: hash, KEY_FILE: path.join(k.dir, 'missing.pem'), KEY_ID: 'k1' });
    assert.equal(noKey.status, 1);
    assert.match(noKey.stderr, /KEY_FILE cannot be read/);
    for (const r of [noHash, wrongKey, noKey]) {
        assert.doesNotMatch(r.stdout + r.stderr, /Open http|PRIVATE KEY/);
    }
});

test('password hash: scrypt, timing-safe check, malformed hashes rejected', async () => {
    const h = await testHash();
    assert.match(h, /^scrypt\$1024\$8\$1\$/);
    assert.equal(await verifyPassword(PASSWORD, h), true);
    assert.equal(await verifyPassword(`${PASSWORD} `, h), false);
    assert.equal(await verifyPassword('', h), false);
    assert.equal(await verifyPassword(PASSWORD, 'garbage'), false);
    assert.equal(parseHash('scrypt$1000$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA=='), null); // N not a power of two
    assert.equal(parseHash('scrypt$1048576$32$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA=='), null); // too much memory
    const h2 = await hashPassword(PASSWORD, FAST);
    assert.notEqual(h2, h); // salted
});

test('Set_Password writes PASSWORD_HASH into .env text and keeps the rest', () => {
    assert.equal(upsertEnvLine('PORT=8444\r\nPASSWORD_HASH=\r\nKEY_ID=k1\r\n', 'PASSWORD_HASH', 'scrypt$x'), 'PORT=8444\r\nPASSWORD_HASH=scrypt$x\r\nKEY_ID=k1\r\n');
    assert.equal(upsertEnvLine('PORT=8444\n', 'PASSWORD_HASH', 'h'), 'PORT=8444\nPASSWORD_HASH=h\n');
    assert.equal(upsertEnvLine('# PASSWORD_HASH=old\nPORT=1', 'PASSWORD_HASH', 'h'), '# PASSWORD_HASH=old\nPORT=1\nPASSWORD_HASH=h\n');
    assert.equal(upsertEnvLine('', 'PASSWORD_HASH', 'h'), 'PASSWORD_HASH=h\n');
});

test('setPassword.js from a pipe: too short and mismatched passwords change nothing; a good one writes the hash', (t) => {
    const k = keyDir(t);
    const appDir = path.join(k.dir, 'app');
    fs.mkdirSync(appDir);
    fs.writeFileSync(path.join(appDir, '.env.example'), 'PORT=8444\r\nPASSWORD_HASH=\r\n');
    const script = `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'setPassword.js'))}).main(${JSON.stringify(appDir)}).then((rc) => process.exit(rc))`;
    const run = (input) => spawnSync(process.execPath, ['-e', script], { input, encoding: 'utf8', timeout: 20000 });
    assert.equal(run('short\nshort\n').status, 1);
    assert.equal(run('Long-Enough-1\nLong-Enough-2\n').status, 1);
    assert.equal(fs.existsSync(path.join(appDir, '.env')), false);
    const ok = run('Long-Enough-1\nLong-Enough-1\n');
    assert.equal(ok.status, 0, ok.stderr);
    const env = fs.readFileSync(path.join(appDir, '.env'), 'utf8');
    assert.match(env, /^PORT=8444\r\nPASSWORD_HASH=scrypt\$32768\$8\$1\$[^\r\n]+\r\n$/);
    assert.doesNotMatch(env + ok.stdout, /Long-Enough-1/);
});

test('readConfig: the database is license-issuer.db next to the key unless DB_FILE says otherwise', () => {
    const base = { KEY_FILE: 'C:/keys/k1-private.pem', PASSWORD_HASH: 'x' };
    assert.equal(readConfig(base).dbFile, path.resolve('C:/keys/license-issuer.db'));
    assert.equal(readConfig({ ...base, DB_FILE: ' D:/data/issuer.db ' }).dbFile, path.resolve('D:/data/issuer.db'));
});
