// NAS Devices: RBAC matrix, per-device CRUD, validation, write serialisation, encryption migration, audit.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const logger = require('../../lib/logger');
const nasDrivers = require('../../services/nasDrivers');
const { signToken } = require('../helpers/http');
const { readDataSync, writeDataSync } = require('../../lib/db');
const { writeRbacConfig } = require('../../lib/rbac');
const { encryptPassword, encryptText, decryptText } = require('../../lib/crypto');
const decryptPassword = (v) => decryptText(v); // at-rest passwords use the system key (v2)

const KEY = 'service_platform/nas_config.json';
const SECRET = process.env.JWT_SECRET;
const tok = (role, groups = ['nasg']) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups })}`;
const admin = tok('SuperAdmin', []);
const op = tok('Operator');
const viewer = tok('Viewer');
const noFeature = tok('Operator', []);
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { nasg: { enabled: true, features: { nasControl: true } } }
    });
    app = express();
    app.use(express.json());
    app.use('/api/nas', require('../../routes/nas'));
});
test.after(async () => { await dbManager.closeDB(); });

const as = (method, url, token) => request(app)[method](url).set('Authorization', token);
const dev = (extra = {}) => ({ name: 'NAS-1', type: 'synology', ip: '10.0.0.5', port: 5000, username: 'svc', password: 'p@ss:word', ...extra });
const stored = () => readDataSync(KEY, []);
const fakeDriver = (over = {}) => ({
    getStorageInfo: async () => [], listShares: async () => [],
    createShare: async () => true, deleteShare: async () => true, ...over
});

test.beforeEach(() => writeDataSync(KEY, []));

// ---------------------------------------------------------------- RBAC matrix
test('RBAC matrix: every route', async (t) => {
    t.mock.method(nasDrivers, 'getDriver', () => fakeDriver());
    writeDataSync(KEY, [{ id: 'd1', name: 'A', type: 'synology', ip: '1.1.1.1', shares: [{ name: 'S', path: 'p', permissions: [] }] }]);
    const routes = [
        // method, url, body, allowed roles
        ['get', '/api/nas/config', undefined, ['SuperAdmin', 'Operator', 'Viewer']],
        ['post', '/api/nas/get-permissions', { deviceId: 'd1', shareName: 'S' }, ['SuperAdmin', 'Operator', 'Viewer']],
        ['post', '/api/nas/create-share', { deviceId: 'd1', name: 'N', path: '/x' }, ['SuperAdmin', 'Operator']],
        ['post', '/api/nas/delete-share', { deviceId: 'd1', name: 'N' }, ['SuperAdmin', 'Operator']],
        ['post', '/api/nas/set-permissions', { deviceId: 'd1', shareName: 'S', permissions: [] }, ['SuperAdmin', 'Operator']],
        ['post', '/api/nas/devices', dev({ name: 'rbac-new' }), ['SuperAdmin']],
        ['put', '/api/nas/devices/d1', { name: 'A2' }, ['SuperAdmin']],
        ['post', '/api/nas/test-connection', { ip: '1.1.1.1', type: 'synology' }, ['SuperAdmin']],
        ['post', '/api/nas/config', [], ['SuperAdmin']],
        ['delete', '/api/nas/devices/d1', undefined, ['SuperAdmin']]
    ];
    const tokens = { SuperAdmin: admin, Operator: op, Viewer: viewer };
    for (const [m, url, body, allowed] of routes) {
        for (const role of Object.keys(tokens)) {
            const r = body === undefined ? as(m, url, tokens[role]) : as(m, url, tokens[role]).send(body);
            const res = await r;
            if (allowed.includes(role)) assert.notEqual(res.status, 403, `${role} ${m} ${url} should be allowed (got ${res.status})`);
            else assert.equal(res.status, 403, `${role} ${m} ${url} should be 403`);
        }
        const noAuth = await request(app)[m](url).send(body);
        assert.equal(noAuth.status, 401, `${m} ${url} without token`);
        const nf = body === undefined ? as(m, url, noFeature) : as(m, url, noFeature).send(body);
        assert.equal((await nf).status, 403, `${m} ${url} without nasControl feature`);
    }
});

// ---------------------------------------------------------------- CRUD
test('create stores an encrypted password with explicit marker and never returns it', async () => {
    const res = await as('post', '/api/nas/devices', admin).send(dev()).expect(201);
    assert.equal(res.body.hasPassword, true);
    assert.ok(res.body.id);
    assert.equal(res.body.password, undefined);
    assert.equal(res.body.passwordEncrypted, undefined);
    const [s] = stored();
    assert.equal(s.passwordEnc, 'v2');
    assert.notEqual(s.password, 'p@ss:word');
    assert.equal(decryptPassword(s.password), 'p@ss:word');
    const list = await as('get', '/api/nas/config', op).expect(200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].hasPassword, true);
    assert.doesNotMatch(JSON.stringify(list.body), /p@ss|passwordEncrypted|"password"/);
});

test('update keeps password when blank or absent, replaces when provided', async () => {
    const { body } = await as('post', '/api/nas/devices', admin).send(dev()).expect(201);
    const before = stored()[0].password;
    await as('put', `/api/nas/devices/${body.id}`, admin).send({ name: 'Renamed' }).expect(200);
    assert.equal(stored()[0].password, before);
    await as('put', `/api/nas/devices/${body.id}`, admin).send({ ...dev(), name: 'Renamed2', password: '' }).expect(200);
    assert.equal(stored()[0].password, before);
    assert.equal(stored()[0].name, 'Renamed2');
    const res = await as('put', `/api/nas/devices/${body.id}`, admin).send({ password: 'new-secret' }).expect(200);
    assert.equal(res.body.hasPassword, true);
    assert.equal(decryptPassword(stored()[0].password), 'new-secret');
    assert.equal(stored()[0].passwordEnc, 'v2');
});

test('update keeps shares/volumes; unknown id is 404; delete removes', async () => {
    const { body } = await as('post', '/api/nas/devices', admin).send(dev()).expect(201);
    const all = stored(); all[0].shares = [{ name: 'S1' }]; all[0].volumes = [{ n: 1 }]; writeDataSync(KEY, all);
    await as('put', `/api/nas/devices/${body.id}`, admin).send({ ip: '10.0.0.9' }).expect(200);
    assert.deepEqual(stored()[0].shares, [{ name: 'S1' }]);
    assert.equal(stored()[0].ip, '10.0.0.9');
    await as('put', '/api/nas/devices/nope', admin).send({ name: 'x' }).expect(404);
    await as('delete', '/api/nas/devices/nope', admin).expect(404);
    await as('delete', `/api/nas/devices/${body.id}`, admin).expect(200);
    assert.equal(stored().length, 0);
});

test('duplicate device name is rejected', async () => {
    await as('post', '/api/nas/devices', admin).send(dev()).expect(201);
    await as('post', '/api/nas/devices', admin).send(dev({ name: 'nas-1' })).expect(409);
});

// ---------------------------------------------------------------- validation
test('validation rejects bad fields', async () => {
    const bad = [
        dev({ name: '' }), dev({ name: 'x'.repeat(65) }), dev({ type: 'ftp' }),
        dev({ ip: 'bad host!' }), dev({ ip: '999.1.1.1' }), dev({ ip: '' }), dev({ ip: '1.1.1.1; rm -rf /' }),
        dev({ port: 0 }), dev({ port: 70000 }), dev({ port: 'abc' }), dev({ port: 1.5 }),
        dev({ username: 'u'.repeat(129) }), dev({ name: 123 })
    ];
    for (const b of bad) {
        const res = await as('post', '/api/nas/devices', admin).send(b);
        assert.equal(res.status, 400, JSON.stringify(b));
    }
    assert.equal(stored().length, 0);
    await as('post', '/api/nas/devices', admin).send(dev({ ip: 'nas01.corp.example.com', port: 65535 })).expect(201);
});

test('update validates only provided fields', async () => {
    const { body } = await as('post', '/api/nas/devices', admin).send(dev()).expect(201);
    await as('put', `/api/nas/devices/${body.id}`, admin).send({ port: 99999 }).expect(400);
    await as('put', `/api/nas/devices/${body.id}`, admin).send({ type: 'zzz' }).expect(400);
});

// ---------------------------------------------------------------- serialisation
test('parallel updates are both persisted', async () => {
    const a = await as('post', '/api/nas/devices', admin).send(dev({ name: 'A', ip: '10.0.0.1' })).expect(201);
    const b = await as('post', '/api/nas/devices', admin).send(dev({ name: 'B', ip: '10.0.0.2' })).expect(201);
    await Promise.all([
        as('put', `/api/nas/devices/${a.body.id}`, admin).send({ username: 'ua' }).then(r => assert.equal(r.status, 200)),
        as('put', `/api/nas/devices/${b.body.id}`, admin).send({ username: 'ub' }).then(r => assert.equal(r.status, 200)),
        as('post', '/api/nas/devices', admin).send(dev({ name: 'C', ip: '10.0.0.3' })).then(r => assert.equal(r.status, 201))
    ]);
    const s = stored();
    assert.equal(s.length, 3);
    assert.equal(s.find(x => x.name === 'A').username, 'ua');
    assert.equal(s.find(x => x.name === 'B').username, 'ub');
});

test('share routes join the same write chain (no lost update)', async (t) => {
    let release;
    const gate = new Promise(r => { release = r; });
    t.mock.method(nasDrivers, 'getDriver', () => fakeDriver({ createShare: async () => { await gate; return true; } }));
    const a = await as('post', '/api/nas/devices', admin).send(dev({ name: 'A' })).expect(201);
    const pShare = as('post', '/api/nas/create-share', op).send({ deviceId: a.body.id, name: 'Sh', path: '/v/sh' }).then(r => r);
    const upd = await as('put', `/api/nas/devices/${a.body.id}`, admin).send({ username: 'changed' }).expect(200);
    release();
    const r = await pShare;
    assert.equal(r.status, 200);
    const s = stored()[0];
    assert.equal(s.username, 'changed');
    assert.equal(s.shares.length, 1);
    assert.ok(upd);
});

// ---------------------------------------------------------------- encryption migration
test('migration: decryptable stays, plaintext (incl. with colon) encrypted, idempotent, no values logged', async (t) => {
    const legacy = encryptPassword('keepme', SECRET);          // legacy ciphertext under JWT_SECRET
    const v2 = encryptText('already-v2');
    const foreign = encryptPassword('lost', 'some-rotated-secret'); // ciphertext nothing can decrypt
    writeDataSync(KEY, [
        { id: 'a', name: 'A', type: 'synology', ip: '1.1.1.1', password: legacy },
        { id: 'b', name: 'B', type: 'qnap', ip: '1.1.1.2', password: 'plain-one' },
        { id: 'c', name: 'C', type: 'linux', ip: '1.1.1.3', password: 'pa:ss:wd' },
        { id: 'd', name: 'D', type: 'linux', ip: '1.1.1.4' },
        { id: 'e', name: 'E', type: 'linux', ip: '1.1.1.5', password: v2, passwordEnc: 'v2' },
        { id: 'f', name: 'F', type: 'linux', ip: '1.1.1.6', password: foreign }
    ]);
    const logs = [];
    t.mock.method(console, 'log', (...a) => logs.push(a.join(' ')));
    const res = await as('get', '/api/nas/config', admin).expect(200);
    assert.deepEqual(res.body.map(x => x.hasPassword), [true, true, true, false, true, false]);
    assert.deepEqual(res.body.map(x => x.passwordNeedsReset), [false, false, false, false, false, true]);
    const s = stored();
    assert.equal(decryptPassword(s[0].password), 'keepme');           // legacy re-encrypted with the system key
    assert.equal(decryptPassword(s[1].password), 'plain-one');
    assert.equal(decryptPassword(s[2].password), 'pa:ss:wd');
    assert.ok([0, 1, 2, 4].every(i => s[i].passwordEnc === 'v2'));
    assert.equal(s[3].password, undefined);
    assert.equal(s[4].password, v2);                                  // already v2 + decryptable: untouched
    assert.equal(s[5].password, foreign);                             // never double-encrypted
    assert.equal(s[5].passwordNeedsReset, true);
    assert.equal(s[5].passwordEnc, undefined);
    assert.doesNotMatch(logs.join('\n'), /plain-one|pa:ss:wd|keepme|already-v2|lost/);
    assert.ok(logs.some(l => /NAS/.test(l) && /4 device/.test(l) && /1 need/.test(l)));
    const snapshot = JSON.stringify(s);
    await as('get', '/api/nas/config', admin).expect(200);
    assert.equal(JSON.stringify(stored()), snapshot, 'second run must not change anything');
});

test('migration helper branches: NAS_ENCRYPTION_KEY, garbage decrypt, v2 undecryptable, idempotent', (t) => {
    const { migrateDevices } = require('../../services/nasDevices');
    t.mock.method(console, 'error', () => {});
    process.env.NAS_ENCRYPTION_KEY = 'legacy-nas-key';
    try {
        const viaNasKey = encryptPassword('nas-key-pw', 'legacy-nas-key');
        const r = migrateDevices([
            { id: '1', password: viaNasKey },
            { id: '2', password: 'raw' },
            { id: '3', password: `${'00'.repeat(16)}:${'11'.repeat(16)}:${'22'.repeat(15)}`, passwordEnc: 'v2' }, // malformed v2: cannot decrypt
            { id: '4', password: encryptPassword('z', 'unknown-secret') }
        ]);
        assert.equal(decryptText(r.devices[0].password), 'nas-key-pw');
        assert.equal(r.devices[1].passwordEnc, 'v2');
        assert.equal(r.devices[2].passwordNeedsReset, true);
        assert.equal(r.devices[3].passwordNeedsReset, true);
        assert.equal(r.devices[3].passwordEnc, undefined);
        assert.equal(r.needsReset, 2);
        const again = migrateDevices(r.devices);
        assert.equal(again.changed, 0);
    } finally {
        delete process.env.NAS_ENCRYPTION_KEY;
    }
});

test('wrong-key garbage decrypt is rejected (control chars / invalid UTF-8)', () => {
    const { migrateDevices } = require('../../services/nasDevices');
    // Many ciphertexts under unrelated keys: none may be "accepted" as decryptable under JWT_SECRET
    const devices = Array.from({ length: 40 }, (_, i) => ({ id: String(i), password: encryptPassword('pw' + i, 'other-key-' + i) }));
    const r = migrateDevices(devices);
    assert.ok(r.devices.every(d => d.passwordNeedsReset === true && d.passwordEnc === undefined));
});

test('drivers fail with a clear message on passwordNeedsReset / undecryptable v2, and use the system key', () => {
    const { getDriver } = nasDrivers;
    assert.throws(() => getDriver({ type: 'synology', ip: '1.1.1.1', password: 'x', passwordNeedsReset: true }), /re-enter/);
    const d = getDriver({ type: 'synology', ip: '1.1.1.1', username: 'u', password: encryptText('sysky'), passwordEnc: 'v2' });
    assert.equal(d.password, 'sysky');
});

// ---------------------------------------------------------------- back-compat POST /config
test('POST /config still works: encrypts plaintext, keeps password when omitted, ignores client marker', async () => {
    const created = await as('post', '/api/nas/devices', admin).send(dev()).expect(201);
    const keep = stored()[0].password;
    await as('post', '/api/nas/config', admin).send([
        { id: created.body.id, name: 'NAS-1', type: 'synology', ip: '10.0.0.5', port: 5000, username: 'svc' },
        { id: 'new1', name: 'N2', type: 'qnap', ip: '10.0.0.6', port: 8080, username: 'u', password: 'has:colon', passwordEnc: 'v2' }
    ]).expect(200);
    const s = stored();
    assert.equal(s[0].password, keep);
    assert.equal(decryptPassword(s[1].password), 'has:colon');
    await as('post', '/api/nas/config', admin).send({ not: 'array' }).expect(400);
    await as('post', '/api/nas/config', admin).send([{ id: 'x', name: '', type: 'qnap', ip: '1.1.1.1' }]).expect(400);
});

test('POST /config preserves shares of existing devices', async () => {
    const created = await as('post', '/api/nas/devices', admin).send(dev()).expect(201);
    const all = stored(); all[0].shares = [{ name: 'Keep' }]; writeDataSync(KEY, all);
    await as('post', '/api/nas/config', admin).send([{ id: created.body.id, name: 'NAS-1', type: 'synology', ip: '10.0.0.5' }]).expect(200);
    assert.deepEqual(stored()[0].shares, [{ name: 'Keep' }]);
});

// ---------------------------------------------------------------- test-connection
test('test-connection uses stored password when id given and blank password; hands driver a decryptable password', async (t) => {
    let seen;
    t.mock.method(nasDrivers, 'getDriver', (d) => { seen = d; return fakeDriver(); });
    const created = await as('post', '/api/nas/devices', admin).send(dev()).expect(201);
    const res = await as('post', '/api/nas/test-connection', admin).send({ id: created.body.id, ip: '10.0.0.5', port: 5000, type: 'synology', password: '' }).expect(200);
    assert.equal(res.body.success, true);
    assert.equal(decryptPassword(seen.password), 'p@ss:word');
    assert.equal(seen.passwordEnc, 'v2');
    await as('post', '/api/nas/test-connection', admin).send({ ip: '10.0.0.5', type: 'synology', username: 'a', password: 'typed' }).expect(200);
    assert.equal(decryptPassword(seen.password), 'typed');
    assert.doesNotMatch(JSON.stringify(res.body), /p@ss/);
    await as('post', '/api/nas/test-connection', admin).send({ ip: 'bad host', type: 'synology' }).expect(400);
});

test('test-connection reuses the stored password only when host and port are unchanged', async (t) => {
    let calls = 0;
    t.mock.method(nasDrivers, 'getDriver', () => { calls++; return fakeDriver(); });
    const c = await as('post', '/api/nas/devices', admin).send(dev()).expect(201);
    const base = { id: c.body.id, type: 'synology', port: 5000, password: '' };
    await as('post', '/api/nas/test-connection', admin).send({ ...base, ip: '10.0.0.5' }).expect(200);
    await as('post', '/api/nas/test-connection', admin).send({ ...base, ip: '10.0.0.5', port: 5001 }).expect(400);
    await as('post', '/api/nas/test-connection', admin).send({ ...base, ip: '10.9.9.9' }).expect(400);
    await as('post', '/api/nas/test-connection', admin).send({ ip: '10.0.0.5', type: 'synology' }).expect(400);
    await as('post', '/api/nas/test-connection', admin).send({ ...base, ip: '10.9.9.9', password: 'typed' }).expect(200);
    assert.equal(calls, 2);
});

test('M2/M3/M5/M8: 409 duplicates, duplicate ids, case-insensitive shares, clearing port, generic 500s', async (t) => {
    t.mock.method(console, 'error', () => {});
    const a = await as('post', '/api/nas/devices', admin).send(dev({ name: 'A', ip: '10.0.0.1' })).expect(201);
    const b = await as('post', '/api/nas/devices', admin).send(dev({ name: 'B', ip: '10.0.0.2' })).expect(201);
    await as('put', `/api/nas/devices/${b.body.id}`, admin).send({ name: 'a' }).expect(409);
    await as('post', '/api/nas/config', admin).send([
        { id: 'x', name: 'N1', type: 'qnap', ip: '1.1.1.1' }, { id: 'y', name: 'n1', type: 'qnap', ip: '1.1.1.2' }]).expect(409);
    await as('post', '/api/nas/config', admin).send([
        { id: 'x', name: 'N1', type: 'qnap', ip: '1.1.1.1' }, { id: 'x', name: 'N2', type: 'qnap', ip: '1.1.1.2' }]).expect(400);
    // port can be cleared with null
    await as('put', `/api/nas/devices/${a.body.id}`, admin).send({ port: null }).expect(200);
    assert.equal(stored().find(x => x.id === a.body.id).port, undefined);
    // shares matched case-insensitively
    const all = stored(); all[0].shares = [{ name: 'Finance', permissions: [] }]; writeDataSync(KEY, all);
    t.mock.method(nasDrivers, 'getDriver', () => fakeDriver());
    await as('post', '/api/nas/delete-share', op).send({ deviceId: all[0].id, name: 'finance' }).expect(200);
    assert.deepEqual(stored()[0].shares, []);
    const all2 = stored(); all2[0].shares = [{ name: 'Finance', permissions: [] }]; writeDataSync(KEY, all2);
    await as('post', '/api/nas/set-permissions', op).send({ deviceId: all2[0].id, shareName: 'FINANCE', permissions: [] }).expect(200);
    // driver errors are not echoed
    nasDrivers.getDriver.mock.restore();
    t.mock.method(nasDrivers, 'getDriver', () => fakeDriver({ createShare: async () => { throw new Error('ENOENT C:\\secret\\path'); } }));
    const r = await as('post', '/api/nas/create-share', op).send({ deviceId: all2[0].id, name: 'N', path: '/p' }).expect(500);
    assert.doesNotMatch(JSON.stringify(r.body), /secret|ENOENT/);
});

test('test-connection failure message is returned without password', async (t) => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(nasDrivers, 'getDriver', () => fakeDriver({ getStorageInfo: async () => { throw new Error('boom'); } }));
    const res = await as('post', '/api/nas/test-connection', admin).send({ ip: '10.0.0.5', type: 'synology', password: 'zzz' }).expect(500);
    assert.equal(res.body.success, false);
    assert.doesNotMatch(JSON.stringify(res.body), /zzz/);
});

// ---------------------------------------------------------------- responses never leak
test('create/update/sync responses never include password or blob', async (t) => {
    t.mock.method(nasDrivers, 'getDriver', () => fakeDriver());
    const c = await as('post', '/api/nas/devices', admin).send(dev()).expect(201);
    const u = await as('put', `/api/nas/devices/${c.body.id}`, admin).send({ password: 'another' }).expect(200);
    const sync = await as('get', '/api/nas/config?sync=true', op).expect(200);
    for (const body of [c.body, u.body, sync.body]) {
        const j = JSON.stringify(body);
        assert.doesNotMatch(j, /"password"|passwordEnc"|passwordEncrypted|another|p@ss/);
    }
    assert.equal(sync.body[0].hasPassword, true);
    assert.equal(stored()[0].passwordEnc, 'v2');
});

// ---------------------------------------------------------------- audit
test('device and share/permission changes are audited without secrets', async (t) => {
    t.mock.method(nasDrivers, 'getDriver', () => fakeDriver());
    const logged = [];
    t.mock.method(logger, 'auditLog', (...a) => { logged.push(a); });
    const c = await as('post', '/api/nas/devices', admin).send(dev()).expect(201);
    await as('put', `/api/nas/devices/${c.body.id}`, admin).send({ name: 'NAS-X', password: 'secret2' }).expect(200);
    await as('post', '/api/nas/create-share', op).send({ deviceId: c.body.id, name: 'Sh1', path: '/v/sh1' }).expect(200);
    await as('post', '/api/nas/set-permissions', op).send({ deviceId: c.body.id, shareName: 'Sh1', permissions: [{ name: 'g', access: 'r' }] }).expect(200);
    await as('post', '/api/nas/delete-share', op).send({ deviceId: c.body.id, name: 'Sh1' }).expect(200);
    await as('delete', `/api/nas/devices/${c.body.id}`, admin).expect(200);
    await as('post', '/api/nas/config', admin).send([]).expect(200);
    assert.equal(logged.length, 7);
    assert.ok(logged.every(l => l[1] === 'NAS Manager' && typeof l[2] === 'string' && l.length === 3));
    assert.equal(logged[0][0], 'superadmin');
    assert.match(logged[0][2], /Created NAS device "NAS-1"/);
    assert.match(logged[1][2], /NAS-1.*NAS-X.*password changed/i);
    assert.match(logged[2][2], /share "Sh1".*NAS-X/);
    assert.equal(logged[2][0], 'operator');
    assert.match(logged[3][2], /permissions.*"Sh1".*NAS-X/i);
    assert.match(logged[4][2], /Deleted share "Sh1".*NAS-X/);
    assert.match(logged[5][2], /Deleted NAS device "NAS-X"/);
    assert.doesNotMatch(JSON.stringify(logged), /p@ss|secret2/);
});
