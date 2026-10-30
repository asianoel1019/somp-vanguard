// SSL Manager routes + scan engine: validation, safe certificate parsing, secrets projection, view-key audit,
// background check-all with a cross-process lease, scan merge, file-only handling, trust fields, alert dedupe, edit.
// No network: the TLS prober, PowerShell and the alert sender are stubbed through sslCore.setHooks.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync, writeDataSync } = require('../../lib/db');
const { encryptText, decryptText } = require('../../lib/crypto');
const core = require('../../lib/sslCore');

const SSL_KEY = 'network_service/ssl_certificates.json';
const LOCK_KEY = 'network_service/ssl_scan_lock.json';
const ENV_KEY = 'system/environments.json';

const TEST_PEM = `-----BEGIN CERTIFICATE-----
MIIBpjCCAUygAwIBAgIUM7AiB6kuNDc2ftRHHQwqqidyqPIwCgYIKoZIzj0EAwIw
LzEZMBcGA1UEAwwQdGVzdC5leGFtcGxlLmNvbTESMBAGA1UECgwJU09NUCBUZXN0
MB4XDTI2MTAyODEwMDczMFoXDTM2MTAyNTEwMDczMFowLzEZMBcGA1UEAwwQdGVz
dC5leGFtcGxlLmNvbTESMBAGA1UECgwJU09NUCBUZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAE0pqhHaOoMukxwlAPTkRSu96DFRIVYPmKLtNOUbmz9Eoteg1f
dNNtynKXNAMVkHrYkCz4xcHN70/+4OgvrCXWD6NGMEQwNwYDVR0RBDAwLoIQdGVz
dC5leGFtcGxlLmNvbYIUd3d3LnRlc3QuZXhhbXBsZS5jb22HBAoAAAUwCQYDVR0T
BAIwADAKBggqhkjOPQQDAgNIADBFAiBtZUKNn+Zm6yGedcwPscNm9DfZT6qzdG0E
rRVK7UiHUgIhAMNzjsISO/6k3Pmvht26wl11YV21GO6XHQ8Q9ZL3TQtj
-----END CERTIFICATE-----
`;
const TEST_DER = new crypto.X509Certificate(TEST_PEM).raw;

const tok = (role) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups: ['g'] })}`;
const SA = tok('SuperAdmin'), OP = tok('Operator'), VIEWER = tok('Viewer');

let app;
let svc;
const audits = [];
let alerts = [];
let probes = [];
let probeImpl;

const DAY = 24 * 3600 * 1000;
const inDays = (d) => new Date(Date.now() + d * DAY + 3600 * 1000).toISOString();
const okProbe = (days, extra = {}) => ({
    success: true, subject: 'a.com', issuer: 'CA', validFrom: '2025-01-01', validTo: inDays(days).slice(0, 10), notAfter: inDays(days),
    notBefore: '2025-01-01T00:00:00.000Z', fingerprint256: 'FP', trusted: true, trustError: '', hostnameChecked: true, san: ['DNS:a.com'], ...extra,
});

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: {
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { sslMonitor: true } },
            g: { type: 'group', target: 'g', enabled: true, features: { sslMonitor: true } },
        },
    });
    writeDataSync(ENV_KEY, [{ id: 'def', name: 'Default', isDefault: true }, { id: 'prod', name: 'Production' }]);
    // stub before routes/ssl destructures auditLog
    require('../../lib/logger').auditLog = (user, mod, msg) => { audits.push([user, mod, msg]); };
    svc = require('../../services/sslMonitorService');
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/ssl', require('../../routes/ssl'));
});
test.after(async () => { core.resetHooks(); await dbManager.closeDB(); });

test.beforeEach(() => {
    audits.length = 0;
    alerts = [];
    probes = [];
    probeImpl = async () => okProbe(200);
    core.setHooks({
        probe: async (host, port) => { probes.push(`${host}:${port}`); return probeImpl(host, port); },
        sendAlert: async (message) => { alerts.push(message); },
        runPowerShell: async () => { throw new Error('PowerShell must not run in this test'); },
    });
    writeDataSync(SSL_KEY, []);
    writeDataSync(LOCK_KEY, {});
});

const call = (method, url, token, body) => {
    const r = request(app)[method](`/api/ssl${url}`).set('Authorization', token);
    return body !== undefined ? r.send(body) : r;
};
const stored = () => readDataSync(SSL_KEY, []);
const byId = (id) => stored().find(r => r.id === id);
async function waitIdle() {
    for (let i = 0; i < 500; i++) {
        if (!svc.getScanStatus().running) return;
        await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('scan did not finish');
}

// ---------------------------------------------------------------- validation
test('validation: host / port / name / file type / base64 / size -> 400; /probe validates the same way', async () => {
    const bad = [
        [{ host: 'https://a.com/x' }, /Host/],
        [{ host: 'a.com:443' }, /Host/],
        [{ host: 'a b' }, /Host/],
        [{ host: 'a.com', port: 70000 }, /Port/],
        [{ host: 'a.com', port: 'x' }, /Port/],
        [{ name: 'x'.repeat(201) }, /Name/],
        [{ uploadedFileB64: 'AAAA', uploadedFileType: 'JKS' }, /Unsupported/],
        [{ uploadedFileB64: '***', uploadedFileType: 'PEM' }, /base64/],
        [{ uploadedFileB64: Buffer.alloc(1024 * 1024 + 10).toString('base64'), uploadedFileType: 'DER' }, /1 MB/],
        [{ keyText: { a: 1 } }, /keyText/],
    ];
    for (const [body, re] of bad) {
        const r = await call('post', '/add', OP, body).expect(400);
        assert.match(r.body.error, re, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(stored().length, 0);
    await call('post', '/probe', OP, { host: '' }).expect(400);
    await call('post', '/probe', OP, { host: 'a.com/x' }).expect(400);
    await call('post', '/probe', OP, { host: 'a.com', port: 0 }).expect(400);
    await call('post', '/probe', VIEWER, { host: 'a.com' }).expect(403);
    const ok = await call('post', '/probe', OP, { host: 'https://A.com/', port: '8443' }).expect(200);
    assert.equal(ok.body.success, true);
    assert.deepEqual(probes, ['a.com:8443']);
    assert.equal(probes.length, 1, 'no probe for invalid input');
});

// ---------------------------------------------------------------- add / parsing / projection
test('add with a PEM / DER file: parsed in Node (no PowerShell, no probe), new id format, secrets hidden from list', async () => {
    const r = await call('post', '/add', OP, {
        name: 'pem', uploadedFileName: 'c.cer', uploadedFileType: 'CER', uploadedFileB64: Buffer.from(TEST_PEM).toString('base64'),
        keyText: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----', keyPassword: 'pw',
    }).expect(200);
    const rec = r.body.record;
    assert.match(rec.id, /^ssl-\d+-[0-9a-f]{8}$/);
    assert.equal(rec.subject, 'test.example.com');
    assert.equal(rec.validTo, '2036-10-25');
    assert.equal(rec.host, 'File Backup Only');
    assert.equal(rec.uploadedFileType, 'PEM');
    assert.equal(rec.status, 'active');
    assert.equal('encryptedKey' in rec, false);
    assert.deepEqual(probes, []);

    const der = await call('post', '/add', OP, { name: 'der', uploadedFileType: 'DER', uploadedFileB64: TEST_DER.toString('base64') }).expect(200);
    assert.equal(der.body.record.uploadedFileType, 'DER');
    assert.equal(der.body.record.fingerprint256, new crypto.X509Certificate(TEST_PEM).fingerprint256);

    const txt = await call('post', '/add', OP, { name: 'txt', certText: TEST_PEM }).expect(200);
    assert.equal(txt.body.record.validTo, '2036-10-25');

    const list = (await call('get', '/list', VIEWER).expect(200)).body;
    assert.ok(Array.isArray(list));
    const pem = list.find(x => x.name === 'pem');
    for (const f of ['encryptedKey', 'encryptedPass', 'encryptedFile']) assert.equal(f in pem, false, f);
    assert.deepEqual([pem.hasKey, pem.hasFile, pem.hasCertText], [true, true, false]);
    assert.equal(list.find(x => x.name === 'txt').hasCertText, true);
    assert.ok(!JSON.stringify(list).includes(stored()[0].encryptedKey));
    // stored format: the old fields still exist
    const s = byId(rec.id);
    assert.ok(s.encryptedKey && s.encryptedPass && s.encryptedFile);
    assert.equal(s.hasCertStored, true);
});

test('add with a PFX: constant script + stdin; unparseable file -> 400 without host, probe fallback with host', async () => {
    const calls = [];
    core.setHooks({
        runPowerShell: async (script, t, opts) => {
            calls.push({ script, opts });
            return '@@SOMP_RESULT@@' + Buffer.from(JSON.stringify({ success: true, der: TEST_DER.toString('base64') })).toString('base64');
        },
    });
    const pfx = Buffer.from('PFXDATA').toString('base64');
    const r = await call('post', '/add', OP, { name: 'p', uploadedFileType: 'PFX', uploadedFileB64: pfx, keyPassword: "x'; evil" }).expect(200);
    assert.equal(r.body.record.subject, 'test.example.com');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].script, core.PFX_SCRIPT);
    assert.ok(!calls[0].script.includes(pfx) && !calls[0].script.includes('evil'));
    assert.deepEqual(JSON.parse(Buffer.from(calls[0].opts.stdin, 'base64').toString()), { file: pfx, password: "x'; evil" });

    core.setHooks({ runPowerShell: async () => '@@SOMP_RESULT@@' + Buffer.from(JSON.stringify({ success: false, error: 'bad password' })).toString('base64') });
    const fail = await call('post', '/add', OP, { name: 'q', uploadedFileType: 'P12', uploadedFileB64: pfx }).expect(400);
    assert.match(fail.body.error, /bad password/);
    const bogusPem = await call('post', '/add', OP, { name: 'q', uploadedFileType: 'PEM', uploadedFileB64: Buffer.from('garbage').toString('base64') }).expect(400);
    assert.match(bogusPem.body.error, /PEM|parsed/);
    assert.equal(stored().length, 1, 'nothing saved for an unparseable file');

    probeImpl = async () => okProbe(100);
    const withHost = await call('post', '/add', OP, { name: 'h', host: 'a.com', uploadedFileType: 'P12', uploadedFileB64: pfx }).expect(200);
    assert.deepEqual(probes, ['a.com:443']);
    assert.equal(withHost.body.record.status, 'active');
    assert.match(byId(withHost.body.record.id).certParseError, /bad password/);
});

test('list: daysRemaining / status computed from validTo at read time (file-only counts down); threshold via /settings', async () => {
    writeDataSync(SSL_KEY, [
        { id: 'f1', name: 'file', host: 'File Backup Only', validTo: inDays(10).slice(0, 10), daysRemaining: 999, status: 'active' },
        { id: 'f2', name: 'old', host: 'x.com', validTo: '2020-01-01', daysRemaining: 5, status: 'warning' },
        { id: 'f3', name: 'none', host: 'y.com', validTo: '-', daysRemaining: -999, status: 'error' },
    ]);
    const list = (await call('get', '/list', VIEWER).expect(200)).body;
    const by = Object.fromEntries(list.map(r => [r.id, r]));
    assert.equal(by.f1.status, 'warning');
    assert.ok(by.f1.daysRemaining >= 9 && by.f1.daysRemaining <= 10);
    assert.equal(by.f2.status, 'expired');
    assert.ok(by.f2.daysRemaining < 0);
    assert.deepEqual([by.f3.status, by.f3.daysRemaining], ['error', -999]);
    const s = (await call('get', '/settings', VIEWER).expect(200)).body;
    assert.equal(s.thresholdDays, 30);
});

// ---------------------------------------------------------------- view-key
test('view-key: SuperAdmin only, every view audited, 404 unknown, empty when no key', async () => {
    writeDataSync(SSL_KEY, [
        { id: 'k1', name: 'withKey', host: 'a.com', encryptedKey: encryptText('KEYTEXT'), encryptedPass: encryptText('PW') },
        { id: 'k2', name: 'noKey', host: 'b.com' },
    ]);
    await call('get', '/view-key/k1', OP).expect(403);
    await call('get', '/view-key/k1', VIEWER).expect(403);
    await call('get', '/view-key/zz', SA).expect(404);
    const r = await call('get', '/view-key/k1', SA).expect(200);
    assert.deepEqual(r.body, { keyText: 'KEYTEXT', keyPassword: 'PW' });
    await call('get', '/view-key/k1', SA).expect(200);
    const none = await call('get', '/view-key/k2', SA).expect(200);
    assert.deepEqual(none.body, { keyText: '', keyPassword: '' });
    const views = audits.filter(a => /Viewed private key/.test(a[2])).map(a => a[2]);
    assert.deepEqual(views, ['Viewed private key of withKey (k1)', 'Viewed private key of withKey (k1)', 'Viewed private key of noKey (k2)']);
});

// ---------------------------------------------------------------- scans
test('check-all: 202 + background scan; second request 409 while running; scan-status; file-only never probed', async () => {
    writeDataSync(SSL_KEY, [
        { id: 'a', name: 'A', host: 'a.com', port: 443 },
        { id: 'f', name: 'F', host: 'File Backup Only', validTo: inDays(100).slice(0, 10) },
        { id: 'e', name: 'E', host: '' },
    ]);
    let release;
    const gate = new Promise(r => { release = r; });
    probeImpl = async () => { await gate; return okProbe(100); };
    const r = await call('post', '/check-all', OP).expect(202);
    assert.equal(r.body.started, true);
    const st = (await call('get', '/scan-status', VIEWER).expect(200)).body;
    assert.equal(st.running, true);
    const again = await call('post', '/check-all', OP).expect(409);
    assert.equal(again.body.running, true);
    assert.deepEqual(await svc.runSSLCheck(), { skipped: 'running' }, 'scheduler skips too');
    release();
    await waitIdle();
    assert.deepEqual(probes, ['a.com:443'], 'file-only records are not probed');
    const done = (await call('get', '/scan-status', VIEWER).expect(200)).body;
    assert.equal(done.running, false);
    assert.equal(done.lastResult.checked, 1);
    assert.ok(done.finishedAt);
    assert.equal(byId('a').status, 'active');
    assert.equal(byId('f').status, 'active', 'file-only status computed from validTo');
    assert.ok(byId('f').daysRemaining >= 99);
    await call('post', '/check-all', VIEWER).expect(403);
});

test('scan merge: record added during the scan kept, deleted one not resurrected, user edits preserved, host change ignores stale result', async () => {
    writeDataSync(SSL_KEY, [
        { id: 'keep', name: 'Keep', host: 'k.com', port: 443, envId: 'def', environment: 'Default' },
        { id: 'del', name: 'Del', host: 'd.com', port: 443 },
        { id: 'mv', name: 'Move', host: 'old.com', port: 443, validTo: '-' },
    ]);
    let release;
    const gate = new Promise(r => { release = r; });
    probeImpl = async (host) => { await gate; return okProbe(host === 'k.com' ? 100 : 50, { subject: host }); };
    const running = svc.runSSLCheck({ trigger: 'test' });
    await new Promise(r => setTimeout(r, 20));
    // concurrent changes while probes are in flight
    svc.mutateRecords((records) => {
        records.splice(records.findIndex(r => r.id === 'del'), 1);
        records.find(r => r.id === 'keep').name = 'Renamed';
        records.find(r => r.id === 'mv').host = 'new.com';
        records.push({ id: 'new', name: 'Added', host: 'n.com', port: 443 });
    });
    release();
    const result = await running;
    assert.equal(result.checked, 1, 'only results merged into existing, unchanged endpoints count (del deleted, mv moved)');
    assert.equal(result.targets, 3);
    const ids = stored().map(r => r.id);
    assert.deepEqual(ids, ['keep', 'mv', 'new']);
    assert.equal(byId('keep').name, 'Renamed');
    assert.equal(byId('keep').subject, 'k.com');
    assert.equal(byId('keep').status, 'active');
    assert.equal(byId('mv').subject, undefined, 'stale result of old.com not applied to new.com');
    assert.deepEqual(byId('new'), { id: 'new', name: 'Added', host: 'n.com', port: 443 }, 'added record untouched by the merge');
});

test('lease: one scan at a time; a stale lease (> 15 min) is taken over', () => {
    const now = Date.now();
    assert.equal(svc.acquireLease('one', now), true);
    assert.equal(svc.acquireLease('two', now + 1000), false);
    assert.equal(svc.acquireLease('two', now + svc.LEASE_MS + 1), true, 'stale');
    assert.equal(readDataSync(LOCK_KEY).takenOverFrom, 'one');
    assert.equal(svc.releaseLease('one'), false, 'old owner cannot release');
    assert.equal(svc.releaseLease('two', { ok: 1 }), true);
    assert.equal(svc.acquireLease('three'), true);
    svc.releaseLease('three');
});

test('overall deadline: targets not reached are not checked this run (no status change)', async () => {
    writeDataSync(SSL_KEY, [{ id: 's1', name: 'S1', host: 's1.com', port: 443, status: 'active', validTo: inDays(100).slice(0, 10) }]);
    probeImpl = () => new Promise(() => {}); // never answers
    const owner = svc.newOwner();
    assert.equal(svc.acquireLease(owner), true);
    try {
        const res = await svc.runScan({ deadlineMs: 30 });
        assert.equal(res.notChecked, 1);
        assert.equal(res.checked, 0);
    } finally { svc.releaseLease(owner); }
    assert.equal(byId('s1').lastCheck, undefined);
    assert.ok(byId('s1').notCheckedAt);
});

test('trust fields from the prober are stored and served', async () => {
    writeDataSync(SSL_KEY, [{ id: 't', name: 'T', host: 't.com', port: 443 }]);
    probeImpl = async () => okProbe(100, { trusted: false, trustError: 'DEPTH_ZERO_SELF_SIGNED_CERT', san: ['DNS:t.com'] });
    await svc.runSSLCheck();
    const t = (await call('get', '/list', VIEWER).expect(200)).body[0];
    assert.equal(t.trusted, false);
    assert.equal(t.trustError, 'DEPTH_ZERO_SELF_SIGNED_CERT');
    assert.deepEqual(t.san, ['DNS:t.com']);
    assert.equal(t.status, 'active', 'trust is separate from status');
});

test('alerts through scans: same level once, deeper level, 2 failures -> one alert, recovery -> one alert, renewal resets', async () => {
    writeDataSync(SSL_KEY, [{ id: 'w', name: 'W', host: 'w.com', port: 443 }]);
    probeImpl = async () => okProbe(20);
    await svc.runSSLCheck();
    await svc.runSSLCheck();
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /Expiration Notice/);
    probeImpl = async () => okProbe(5);
    await svc.runSSLCheck();
    assert.equal(alerts.length, 2);
    assert.match(alerts[1], /CRITICAL/);

    probeImpl = async () => ({ success: false, error: 'ECONNREFUSED' });
    await svc.runSSLCheck();
    assert.equal(alerts.length, 2, 'first failure: no alert');
    assert.equal(byId('w').status, 'warning', 'stale data still usable');
    assert.equal(byId('w').error, 'ECONNREFUSED');
    await svc.runSSLCheck();
    assert.equal(alerts.length, 3);
    assert.match(alerts[2], /Probe Error/);
    await svc.runSSLCheck();
    assert.equal(alerts.length, 3, 'no repeat while failing');

    probeImpl = async () => okProbe(5);
    await svc.runSSLCheck();
    assert.equal(alerts.length, 4);
    assert.match(alerts[3], /Recovered/);
    await svc.runSSLCheck();
    assert.equal(alerts.length, 4);

    probeImpl = async () => okProbe(365); // renewed
    await svc.runSSLCheck();
    assert.equal(alerts.length, 4);
    assert.equal(byId('w').alertState.level, 'ok');
    probeImpl = async () => okProbe(25); // the renewed certificate eventually nears expiry again
    await svc.runSSLCheck();
    assert.equal(alerts.length, 5);
});

test('file-only: alerts from validTo without probing; wiped record re-parsed once from the stored certificate', async () => {
    writeDataSync(SSL_KEY, [
        { id: 'fo', name: 'FO', host: 'File Backup Only', validTo: inDays(3).slice(0, 10) },
        { id: 'wiped', name: 'Wiped', host: 'File Backup Only', validTo: '-', daysRemaining: -999, status: 'error', uploadedFileType: 'PEM', encryptedFile: encryptText(Buffer.from(TEST_PEM).toString('base64')) },
        { id: 'broken', name: 'Broken', host: 'File Backup Only', validTo: '-', daysRemaining: -999, status: 'error', uploadedFileType: 'JKS', encryptedFile: encryptText('AAAA') },
    ]);
    const r = await svc.runSSLCheck();
    assert.deepEqual(probes, []);
    assert.equal(r.repaired, 1);
    assert.equal(r.repairFailed, 1);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /FO/);
    assert.equal(byId('wiped').validTo, '2036-10-25');
    assert.equal(byId('wiped').status, 'active');
    assert.equal(byId('broken').status, 'error');
    assert.match(byId('broken').error, /could not be parsed.*Unsupported/);
    await svc.runSSLCheck();
    assert.equal(alerts.length, 1);
});

// ---------------------------------------------------------------- edit / delete
test('edit: name/host/port/env, key kept unless replaced, clearKey, re-probe on host change, validation, audit', async () => {
    writeDataSync(SSL_KEY, [{ id: 'e1', name: 'E1', host: 'a.com', port: 443, envId: 'def', environment: 'Default', encryptedKey: encryptText('K1'), encryptedPass: encryptText('P1'), validTo: inDays(100).slice(0, 10) }]);
    await call('put', '/e1', VIEWER, { name: 'x' }).expect(403);
    await call('put', '/nope', OP, { name: 'x' }).expect(404);
    await call('put', '/e1', OP, { host: 'bad host' }).expect(400);
    await call('put', '/e1', OP, { port: 0 }).expect(400);
    await call('put', '/e1', OP, { environment: 'Mars' }).expect(400);

    // name + env only: no probe, key unchanged (empty secrets = unchanged)
    const r1 = await call('put', '/e1', OP, { name: 'Edited', environment: 'prod', keyText: '', keyPassword: '' }).expect(200);
    assert.equal(r1.body.record.name, 'Edited');
    assert.equal(r1.body.record.envId, 'prod');
    assert.equal(r1.body.record.hasKey, true);
    assert.equal('encryptedKey' in r1.body.record, false);
    assert.deepEqual(probes, []);
    assert.equal(decryptText(byId('e1').encryptedKey), 'K1');
    assert.match(audits.at(-1)[2], /Edited certificate monitor Edited \(e1\): name, environment/);

    // host change -> re-probe
    probeImpl = async () => okProbe(50, { subject: 'b.com' });
    const r2 = await call('put', '/e1', OP, { host: 'b.com', port: '8443' }).expect(200);
    assert.deepEqual(probes, ['b.com:8443']);
    assert.equal(r2.body.record.subject, 'b.com');
    assert.equal(decryptText(byId('e1').encryptedKey), 'K1');

    // replace key
    await call('put', '/e1', OP, { keyText: 'K2' }).expect(200);
    assert.equal(decryptText(byId('e1').encryptedKey), 'K2');
    assert.equal(decryptText(byId('e1').encryptedPass), 'P1');

    // clearKey
    const r3 = await call('put', '/e1', OP, { clearKey: true }).expect(200);
    assert.equal(r3.body.record.hasKey, false);
    assert.equal(byId('e1').encryptedKey, '');
    assert.equal(byId('e1').encryptedPass, '');

    // replace certificate file (re-parsed, no probe)
    probes.length = 0;
    const r4 = await call('put', '/e1', OP, { uploadedFileType: 'DER', uploadedFileB64: TEST_DER.toString('base64'), uploadedFileName: 'n.der' }).expect(200);
    assert.equal(r4.body.record.validTo, '2036-10-25');
    assert.equal(r4.body.record.hasFile, true);
    assert.deepEqual(probes, []);
    await call('put', '/e1', OP, { uploadedFileType: 'JKS', uploadedFileB64: 'AAAA' }).expect(400);
});

test('delete: Operator+, 404 unknown, audit mentions the stored key', async () => {
    writeDataSync(SSL_KEY, [{ id: 'd1', name: 'D1', host: 'a.com', encryptedKey: encryptText('K') }]);
    await call('delete', '/delete/d1', VIEWER).expect(403);
    await call('delete', '/delete/zz', OP).expect(404);
    await call('delete', '/delete/d1', OP).expect(200);
    assert.deepEqual(stored(), []);
    assert.match(audits.at(-1)[2], /Deleted certificate monitor D1 \(d1\) including its stored private key/);
});
