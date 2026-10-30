require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync, writeDataSync } = require('../../lib/db');
const { KNOWN_HOSTS_KEY } = require('../../lib/sshHostKeys');
const { saveTargetsSafely } = require('../../lib/prometheusTargetHelper');

const META_KEY = 'server_operation/server_cmdb_meta.json';
const LEGACY_KEY = 'server_operation/cmdb_meta.json';

const tok = (role, groups = ['inv'], username = role.toLowerCase()) => `Bearer ${signToken({ username, domain: 'corp', role, groups })}`;
const admin = tok('SuperAdmin'), op = tok('Operator'), viewer = tok('Viewer');
const noFeature = tok('Viewer', ['other']);
const bearer = (t) => ({ Authorization: t });
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: {
            inv: { enabled: true, features: { inventory: true } }, other: { enabled: true, features: { serverList: true } },
            gScout: { enabled: true, features: { monitorScout: true } }, gCheck: { enabled: true, features: { serverCheck: true } },
            gWf: { enabled: true, features: { workflow: true } }, gAgents: { enabled: true, features: { monitorAgents: true } },
            gAlerts: { enabled: true, features: { monitorAlerts: true } }, gSl: { enabled: true, features: { serverList: true } }
        }
    });
    await saveTargetsSafely([], 'test_seed');
    app = express();
    app.use(express.json());
    app.use('/api/inventory', require('../../routes/inventory'));
});
test.after(async () => { await dbManager.closeDB(); });

const validConfig = { subnets: [], schedule: { enabled: false, time: '08:00' } };

test('reads need the inventory feature but any role', async () => {
    await request(app).get('/api/inventory/config').expect(401);
    await request(app).get('/api/inventory/config').set(bearer(noFeature)).expect(403);
    for (const t of [viewer, op, admin]) {
        await request(app).get('/api/inventory/config').set(bearer(t)).expect(200);
        await request(app).get('/api/inventory/data').set(bearer(t)).expect(200);
        await request(app).get('/api/inventory/scan-status').set(bearer(t)).expect(200);
    }
});

test('RBAC matrix: Viewer gets 403 on every write route, Operator and SuperAdmin pass the role check', async () => {
    const writes = [
        ['post', '/api/inventory/config', validConfig],
        ['post', '/api/inventory/scan-now', {}],
        ['post', '/api/inventory/abort-scan', {}],
        ['post', '/api/inventory/send-report', {}],
        ['post', '/api/inventory/deploy-agent', { ip: '10.0.0.1', os: 'zzz' }],
        ['post', '/api/inventory/link', { primaryIp: '10.0.0.1', secondaryIp: '10.0.0.2' }],
        ['post', '/api/inventory/unlink', { ip: '10.0.0.2' }],
        ['post', '/api/inventory/server/10.0.0.1/tags', { tags: ['a'] }],
        ['delete', '/api/inventory/server/10.0.0.1', undefined],
        ['post', '/api/inventory/delete-preview', { ips: ['10.0.0.1'] }],
        ['post', '/api/inventory/bulk-delete-offline', { days: 30 }]
    ];
    for (const [method, url, body] of writes) {
        const v = await request(app)[method](url).set(bearer(viewer)).send(body);
        assert.equal(v.status, 403, `Viewer ${method} ${url}`);
        for (const t of [op, admin]) {
            const r = await request(app)[method](url).set(bearer(t)).send(body);
            assert.notEqual(r.status, 403, `${method} ${url} must pass the role check`);
            assert.notEqual(r.status, 401);
        }
    }
});

test('a denied role gets a response (no hang) on delete / tags / deploy-agent', async () => {
    // Regression for the Promise-wrapped checkRole that never resolved on deny
    const res = await request(app).delete('/api/inventory/server/10.0.0.1').set(bearer(viewer)).timeout(3000);
    assert.equal(res.status, 403);
    const res2 = await request(app).post('/api/inventory/deploy-agent').set(bearer(viewer)).send({ ip: '10.0.0.1', os: 'win' }).timeout(3000);
    assert.equal(res2.status, 403);
});

test('/config rejects injection and malformed subnets with 400 and does not save', async () => {
    const ok = await request(app).post('/api/inventory/config').set(bearer(op)).send({ subnets: ['10.20.30'], schedule: { enabled: false } }).expect(200);
    assert.equal(ok.body.success, true);
    const before = (await request(app).get('/api/inventory/config').set(bearer(op))).body;
    assert.deepEqual(before.subnets, ['10.20.30']);

    const bad = await request(app).post('/api/inventory/config').set(bearer(admin))
        .send({ subnets: ['10.20.31', "10.1.1'; Remove-Item C:\\Windows -Recurse; '", '10.9.9:1~999'], schedule: { enabled: false } }).expect(400);
    assert.equal(bad.body.errors.length, 2);
    assert.match(bad.body.error, /Invalid inventory configuration/);
    const after = (await request(app).get('/api/inventory/config').set(bearer(op))).body;
    assert.deepEqual(after.subnets, ['10.20.30'], 'nothing is saved when any entry is invalid');

    const tooMany = Array.from({ length: 501 }, (_, i) => `10.${Math.floor(i / 250)}.${i % 250}`);
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ subnets: tooMany }).expect(400);
    await request(app).post('/api/inventory/config').set(bearer(op)).send(validConfig).expect(200);
});

test('deploy-agent rejects non-IPv4 targets before any shell call', async () => {
    for (const ip of ['10.0.0.1"; calc; "', '$(calc)', 'host.example.com', '10.0.0.1 -Credential x']) {
        const r = await request(app).post('/api/inventory/deploy-agent').set(bearer(op)).send({ ip, os: 'win' });
        assert.equal(r.status, 400, ip);
        assert.match(r.body.error, /Invalid IPv4/);
    }
    // Hostile Host header is rejected as well (it ends up inside generated scripts)
    const r = await request(app).post('/api/inventory/deploy-agent').set(bearer(op)).set('Host', 'evil"$(calc)').send({ ip: '10.0.0.1', os: 'win' });
    assert.equal(r.status, 400);
});

test('public install scripts refuse a hostile Host header', async () => {
    const r = await request(app).get('/api/inventory/install.ps1?token=x').set('Host', 'a"b');
    assert.ok([400, 401].includes(r.status));
});

test('server delete / tags validate the IP parameter', async () => {
    await request(app).delete('/api/inventory/server/not-an-ip').set(bearer(op)).expect(400);
    await request(app).post('/api/inventory/server/999.1.1.1/tags').set(bearer(op)).send({ tags: [] }).expect(400);
    await request(app).post('/api/inventory/server/10.0.0.1/tags').set(bearer(op)).send({ tags: 'x' }).expect(400);
});

test('SSH host key forget endpoint is SuperAdmin only', async () => {
    writeDataSync(KNOWN_HOSTS_KEY, { '10.4.4.4': { fingerprint: 'sha256:aa' } });
    await request(app).get('/api/inventory/ssh-hostkeys').set(bearer(op)).expect(403);
    await request(app).delete('/api/inventory/ssh-hostkeys/10.4.4.4').set(bearer(op)).expect(403);
    assert.ok(readDataSync(KNOWN_HOSTS_KEY, {})['10.4.4.4']);
    const list = await request(app).get('/api/inventory/ssh-hostkeys').set(bearer(admin)).expect(200);
    assert.ok(list.body['10.4.4.4']);
    await request(app).delete('/api/inventory/ssh-hostkeys/10.4.4.4').set(bearer(admin)).expect(200);
    assert.equal(readDataSync(KNOWN_HOSTS_KEY, {})['10.4.4.4'], undefined);
    await request(app).delete('/api/inventory/ssh-hostkeys/10.4.4.4').set(bearer(admin)).expect(404);
    await request(app).delete('/api/inventory/ssh-hostkeys/zzz').set(bearer(admin)).expect(400);
});

test('link validates IPv4; unlink restores only a delete that the link itself set', async () => {
    await request(app).post('/api/inventory/link').set(bearer(op)).send({ primaryIp: '10.5.5.1', secondaryIp: 'x;y' }).expect(400);

    writeDataSync(META_KEY, {
        '10.5.5.1': { hostname: 'P' },
        '10.5.5.9': { hostname: 'V' },
        // unrelated delete (e.g. Server List delete): must survive an unlink
        '10.5.5.50': { deleted: true, deletedBy: 'someone', deletedAt: '2026-01-01T00:00:00Z' },
        // deleted by a user first, then linked
        '10.5.5.60': { deleted: true, deletedBy: 'someone' }
    });
    writeDataSync(LEGACY_KEY, { '10.5.5.1': { legacy: true } });

    await request(app).post('/api/inventory/link').set(bearer(op)).send({ primaryIp: '10.5.5.1', secondaryIp: '10.5.5.9' }).expect(200);
    let meta = readDataSync(META_KEY, {});
    assert.equal(meta['10.5.5.9'].deleted, true);
    assert.equal(meta['10.5.5.9'].deletedReason, 'vip_link');
    assert.deepEqual(readDataSync(LEGACY_KEY, {}), { '10.5.5.1': { legacy: true } }, 'legacy key is no longer written');

    await request(app).post('/api/inventory/link').set(bearer(op)).send({ primaryIp: '10.5.5.1', secondaryIp: '10.5.5.60' }).expect(200);
    assert.notEqual(readDataSync(META_KEY, {})['10.5.5.60'].deletedReason, 'vip_link', 'link does not claim an existing delete');

    // Unlink an IP that was never linked but is deleted: delete is kept
    await request(app).post('/api/inventory/unlink').set(bearer(op)).send({ ip: '10.5.5.50' }).expect(200);
    assert.equal(readDataSync(META_KEY, {})['10.5.5.50'].deleted, true);
    assert.equal(readDataSync(META_KEY, {})['10.5.5.50'].deletedBy, 'someone');

    // Unlink a link-created delete: restored
    await request(app).post('/api/inventory/unlink').set(bearer(op)).send({ ip: '10.5.5.9' }).expect(200);
    meta = readDataSync(META_KEY, {});
    assert.equal(meta['10.5.5.9'].deleted, false);
    assert.equal(meta['10.5.5.9'].deletedReason, undefined);
    assert.ok(!(meta['10.5.5.1'].secondaryIps || []).includes('10.5.5.9'));

    // Pre-deleted then linked then unlinked: stays deleted
    await request(app).post('/api/inventory/unlink').set(bearer(op)).send({ ip: '10.5.5.60' }).expect(200);
    assert.equal(readDataSync(META_KEY, {})['10.5.5.60'].deleted, true);
    assert.equal(readDataSync(LEGACY_KEY, {})['10.5.5.9'], undefined, 'legacy key still untouched');
});

test('legacy subnet syntax is accepted and stored canonical; monitoredIps warnings', async () => {
    const r = await request(app).post('/api/inventory/config').set(bearer(op))
        .send({ subnets: ['10.60.1.1-50', '10.60.2|5~9', '10.60.3'], monitoredIps: [' 10.60.1.5 ', 'junk'], schedule: { enabled: false } }).expect(200);
    assert.equal(r.body.warnings.length, 1);
    const cfg = (await request(app).get('/api/inventory/config').set(bearer(op))).body;
    assert.deepEqual(cfg.subnets, ['10.60.1:1~50', '10.60.2:5~9', '10.60.3']);
    assert.deepEqual(cfg.monitoredIps, ['10.60.1.5']);
    await request(app).post('/api/inventory/config').set(bearer(op)).send(validConfig).expect(200);
});

test('shared endpoints: /deploy-agent and GET /data honour any-of feature gates', async () => {
    const ops = (g) => tok('Operator', [g]);
    for (const g of ['gScout', 'gCheck', 'inv']) {
        const r = await request(app).post('/api/inventory/deploy-agent').set(bearer(ops(g))).send({ ip: 'bad', os: 'win' });
        assert.equal(r.status, 400, g);
    }
    await request(app).post('/api/inventory/deploy-agent').set(bearer(ops('gWf'))).send({ ip: '10.0.0.1', os: 'win' }).expect(403);
    await request(app).post('/api/inventory/deploy-agent').set(bearer(tok('Viewer', ['gScout']))).send({ ip: '10.0.0.1', os: 'win' }).expect(403);
    for (const g of ['gWf', 'inv']) await request(app).get('/api/inventory/data').set(bearer(tok('Viewer', [g]))).expect(200);
    await request(app).get('/api/inventory/data').set(bearer(tok('Viewer', ['gScout']))).expect(403);
    await request(app).get('/api/inventory/config').set(bearer(tok('Viewer', ['gWf']))).expect(403);
});

test('install-token: feature + role, known apiKey, clamping, script escaping', async () => {
    const scoutDb = require('../../services/scoutDb');
    scoutDb.run("INSERT INTO api_keys (id, name, desc, key, createdAt, envId) VALUES ('k1','t','d','key-abc123',?,NULL)", [new Date().toISOString()]);
    const post = (t, body) => request(app).post('/api/inventory/install-token').set(bearer(t)).send(body);
    await post(tok('Viewer', ['gAgents']), { apiKey: 'key-abc123' }).expect(403);
    await post(tok('Operator', ['gWf']), { apiKey: 'key-abc123' }).expect(403);
    await post(tok('Operator', ['gAgents']), { apiKey: 'nope' }).expect(400);
    await post(tok('Operator', ['gAgents']), {}).expect(400);
    for (const g of ['gAgents', 'gAlerts', 'gScout', 'inv']) {
        const r = await post(tok('Operator', [g]), { apiKey: 'key-abc123', maxUses: 999999, expiresInHours: 'abc' }).expect(200);
        assert.ok(r.body.token);
    }
    const r = await post(op, { apiKey: 'key-abc123', maxUses: 999999, expiresInHours: 99999 }).expect(200);
    const sh = await request(app).get(`/api/inventory/install.sh?token=${r.body.token}`).expect(200);
    assert.match(sh.text, /API_KEY='key-abc123'/);
    const ps = await request(app).get(`/api/inventory/install.ps1?token=${r.body.token}`).expect(200);
    assert.match(ps.text, /\$ApiKey = 'key-abc123'/);
});

test('Server List delete after link keeps the delete across unlink (deletedReason manual)', async () => {
    const app2 = express();
    app2.use(express.json());
    app2.use('/api/inventory', require('../../routes/inventory'));
    app2.use('/api/server-list', require('../../routes/serverList'));
    writeDataSync(META_KEY, { '10.8.8.1': { hostname: 'P' }, '10.8.8.9': { hostname: 'V' } });
    await request(app2).post('/api/inventory/link').set(bearer(op)).send({ primaryIp: '10.8.8.1', secondaryIp: '10.8.8.9' }).expect(200);
    assert.equal(readDataSync(META_KEY, {})['10.8.8.9'].deletedReason, 'vip_link');
    // Deleting the primary also deletes its linked VIPs (the VIP alone is already gone from Server List)
    const d = await request(app2).delete('/api/server-list/10.8.8.1').set(bearer(tok('Operator', ['gSl'])));
    assert.ok(d.status < 400, `delete status ${d.status}`);
    assert.equal(readDataSync(META_KEY, {})['10.8.8.1'].deletedReason, 'manual');
    assert.equal(readDataSync(META_KEY, {})['10.8.8.9'].deletedReason, 'manual');
    await request(app2).post('/api/inventory/unlink').set(bearer(op)).send({ ip: '10.8.8.9' }).expect(200);
    assert.equal(readDataSync(META_KEY, {})['10.8.8.9'].deleted, true);
});

test('install-token rejects an API key outside the safe charset; PUT /apikeys rejects unsafe new keys', async () => {
    const scoutDb = require('../../services/scoutDb');
    const evil = "x'; id; 'yy";
    scoutDb.run("INSERT INTO api_keys (id, name, desc, key, createdAt, envId) VALUES ('k-evil','e','d',?,?,NULL)", [evil, new Date().toISOString()]);
    const r = await request(app).post('/api/inventory/install-token').set(bearer(op)).send({ apiKey: evil }).expect(400);
    assert.match(r.body.error, /unsupported characters/);

    const mon = express();
    mon.use(express.json());
    mon.use('/api/monitor', require('../../routes/monitor'));
    const put = (key) => request(mon).put('/api/monitor/apikeys/k-evil').set(bearer(tok('Operator', ['gScout']))).send({ key });
    const bad = await put("new'key;id;12345");
    assert.equal(bad.status, 400);
    assert.equal(scoutDb.get("SELECT key FROM api_keys WHERE id='k-evil'").key, evil, 'stored key untouched');
    const good = await put('new-key_ok.12345');
    assert.equal(good.status, 200);
    // Install scripts never render a key outside the charset (guard in the template handlers)
    assert.equal(scoutDb.get("SELECT key FROM api_keys WHERE id='k-evil'").key, 'new-key_ok.12345');
});

test('maxUses clamp allows large multi-use tokens (100000)', async () => {
    const scoutDb = require('../../services/scoutDb');
    scoutDb.run("INSERT OR IGNORE INTO api_keys (id, name, desc, key, createdAt, envId) VALUES ('k2','t2','d','key-abc12345',?,NULL)", [new Date().toISOString()]);
    const r = await request(app).post('/api/inventory/install-token').set(bearer(op)).send({ apiKey: 'key-abc12345', maxUses: 999999, expiresInHours: 1 }).expect(200);
    // Token is usable many times: 3 downloads succeed
    for (let i = 0; i < 3; i++) await request(app).get(`/api/inventory/install.sh?token=${r.body.token}`).expect(200);
});
