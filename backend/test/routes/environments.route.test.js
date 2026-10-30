require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const logger = require('../../lib/logger');
const { signToken } = require('../helpers/http');
const { db: libDb, readDataSync, writeDataSync } = require('../../lib/db');
const cmdb = require('../../services/cmdbModel');
const { getTargetsSafely, saveTargetsSafely } = require('../../lib/prometheusTargetHelper');

const ENV_KEY = 'system/environments.json';
const IPAM_KEY = 'network_service/ipam/subnets.json';
const SSL_KEY = 'network_service/ssl_certificates.json';
const DBINV_KEY = 'service_platform/database_clusters.json';
const DBREQ_KEY = 'service_platform/database_requests.json';
const K8S_KEY = 'service_platform/k8s_clusters.json';
const META_KEY = 'server_operation/server_cmdb_meta.json';

const tok = (role) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role })}`;
const admin = tok('SuperAdmin'), op = tok('Operator'), viewer = tok('Viewer');
let app;

test.before(async () => {
    await dbManager.initDB();
    app = express();
    app.use(express.json());
    app.use('/api/environments', require('../../routes/environments'));
});
test.after(async () => { await dbManager.closeDB(); });

const run = (sql, params = []) => dbManager.run(sql, params);
const as = (method, url, token) => request(app)[method](url).set('Authorization', token);

function seedEnvs() {
    writeDataSync(ENV_KEY, [
        { id: '1', name: 'Others', purpose: 'Unclassified items' },
        { id: 'prod-id', name: 'Production', purpose: 'Live' },
        { id: 'dev-id', name: 'Dev', purpose: '' }
    ]);
}

async function seedConsumers() {
    for (const t of ['monitors', 'api_keys', 'rule_bindings', 'maintenance_windows']) await run(`DELETE FROM ${t}`);
    libDb.prepare('DELETE FROM cmdb_servers').run();
    cmdb.upsertCmdbServer({ ip: '10.9.0.1', hostname: 'a', envId: 'prod-id', envName: 'Production' }, 'MANUAL');
    // legacy row written before phase 2 (name only): the write path now always resolves, so insert it raw
    libDb.prepare("INSERT INTO cmdb_servers (ip, hostname, envName, isSecondary) VALUES ('10.9.0.2', 'b', 'production', 0)").run();
    cmdb.upsertCmdbServer({ ip: '10.9.0.3', hostname: 'c', envId: 'dev-id', envName: 'Dev' }, 'MANUAL');
    writeDataSync(META_KEY, {
        '10.9.0.1': { envId: 'prod-id', envName: 'Production' },
        '10.9.0.2': { envName: 'PRODUCTION' },
        '10.9.0.4': { envName: 'Dev' }
    });
    await run("INSERT INTO monitors (id, name, ip, tags, enabled, envId) VALUES ('m1','h1','1.1.1.1','[]',1,'prod-id'),('m2','h2','1.1.1.2','[]',1,'prod-id'),('m3','h3','1.1.1.3','[]',1,'dev-id')");
    await run("INSERT INTO api_keys (id, name, key, envId) VALUES ('k1','key1','abc','prod-id')");
    await run("INSERT INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES ('b1','r1','env','prod-id'),('b2','r1','env','dev-id'),('b3','r2','tag','prod-id')");
    await run("INSERT INTO maintenance_windows (id, name, kind, scopeType, scopeValues, enabled) VALUES ('w1','w','weekly','envs','[\"prod-id\",\"dev-id\"]',1),('w2','w','weekly','envs','[\"dev-id\"]',1),('w3','w','weekly','tags','[\"prod-id\"]',1)");
    writeDataSync(IPAM_KEY, [
        { id: 's1', name: 'n1', cidr: '10.0.0.0/24', environment: 'production', ips: [
            { address: '10.0.0.1', environment: 'Production' }, { address: '10.0.0.2', environment: 'Others' } ] },
        { id: 's2', name: 'n2', cidr: '10.0.1.0/24', environment: 'Dev', ips: [{ address: '10.0.1.1', environment: 'Production' }] }
    ]);
    writeDataSync(SSL_KEY, [{ id: 'c1', environment: 'Production' }, { id: 'c2', environment: 'Dev' }]);
    writeDataSync(DBINV_KEY, [{ id: 'd1', environment: 'PRODUCTION' }]);
    writeDataSync(DBREQ_KEY, [{ id: 'r1', environment: 'Production' }, { id: 'r2', environment: 'Production' }]);
    writeDataSync(K8S_KEY, [{ id: 'k1', environment: 'Production' }, { id: 'k2', environment: 'Dev' }]);
    await saveTargetsSafely([
        { targets: ['10.5.0.1:9100'], labels: { addr: '10.5.0.1', zone: 'Production', host: 'x' } },
        { targets: ['10.5.0.2:9100'], labels: { addr: '10.5.0.2', env: 'production' } },
        { targets: ['10.5.0.3:9100'], labels: { addr: '10.5.0.3', zone: 'prod-id' } },
        { targets: ['10.5.0.4:9100'], labels: { addr: '10.5.0.4', zone: 'Dev' } }
    ], 'test');
}

const countOf = (body, consumer) => (body.items.find(i => i.consumer === consumer) || {}).count;

test.beforeEach(() => seedEnvs());

// ---------------------------------------------------------------- RBAC
test('GET /api/environments works for every logged-in role, 401 without token', async () => {
    await request(app).get('/api/environments').expect(401);
    for (const t of [viewer, op, admin]) {
        const res = await as('get', '/api/environments', t).expect(200);
        assert.equal(res.body.length, 3);
    }
});

test('writes and usage need SuperAdmin (Viewer/Operator get 403)', async () => {
    for (const t of [viewer, op]) {
        await as('post', '/api/environments', t).send({ name: 'Stage' }).expect(403);
        await as('put', '/api/environments/dev-id', t).send({ name: 'Dev2' }).expect(403);
        await as('delete', '/api/environments/dev-id', t).expect(403);
        await as('get', '/api/environments/dev-id/usage', t).expect(403);
    }
    assert.equal(readDataSync(ENV_KEY).length, 3);
    await as('post', '/api/environments', admin).send({ name: 'Stage', purpose: 'staging' }).expect(201);
});

// ---------------------------------------------------------------- validation
test('create validates name (empty, whitespace, too long, duplicate case-insensitive) and purpose length', async () => {
    await as('post', '/api/environments', admin).send({}).expect(400);
    await as('post', '/api/environments', admin).send({ name: '   ' }).expect(400);
    await as('post', '/api/environments', admin).send({ name: 'x'.repeat(65) }).expect(400);
    await as('post', '/api/environments', admin).send({ name: 123 }).expect(400);
    await as('post', '/api/environments', admin).send({ name: 'PRODUCTION' }).expect(400);
    await as('post', '/api/environments', admin).send({ name: 'Ok', purpose: 'p'.repeat(257) }).expect(400);
    const res = await as('post', '/api/environments', admin).send({ name: '  Stage  ', purpose: ' s ' }).expect(201);
    assert.equal(res.body.name, 'Stage');
    assert.equal(res.body.purpose, 's');
    assert.ok(res.body.id);
    await as('post', '/api/environments', admin).send({ name: 'x'.repeat(64) }).expect(201);
});

test('update validates name/purpose, rejects id change and duplicate, allows case-only rename', async () => {
    await as('put', '/api/environments/dev-id', admin).send({ name: '' }).expect(400);
    await as('put', '/api/environments/dev-id', admin).send({ name: 'x'.repeat(65) }).expect(400);
    await as('put', '/api/environments/dev-id', admin).send({ name: 'production' }).expect(400);
    await as('put', '/api/environments/dev-id', admin).send({ purpose: 'p'.repeat(257) }).expect(400);
    await as('put', '/api/environments/dev-id', admin).send({ id: 'other', name: 'Dev' }).expect(400);
    await as('put', '/api/environments/nope', admin).send({ name: 'Zed' }).expect(404);
    const same = await as('put', '/api/environments/dev-id', admin).send({ id: 'dev-id', name: 'DEV', purpose: 'dev box' }).expect(200);
    assert.equal(same.body.name, 'DEV');
    assert.equal(same.body.id, 'dev-id');
    assert.equal(same.body.purpose, 'dev box');
});

test("'Others' cannot be renamed or deleted but its purpose is editable", async () => {
    await as('put', '/api/environments/1', admin).send({ name: 'Misc' }).expect(403);
    await as('delete', '/api/environments/1', admin).expect(403);
    const res = await as('put', '/api/environments/1', admin).send({ purpose: 'Anything else' }).expect(200);
    assert.equal(res.body.purpose, 'Anything else');
});

test('the last remaining environment cannot be deleted', async () => {
    writeDataSync(ENV_KEY, [{ id: 'only', name: 'Solo', purpose: '' }]);
    const res = await as('delete', '/api/environments/only', admin).expect(400);
    assert.match(res.body.error, /last/i);
    assert.equal(readDataSync(ENV_KEY).length, 1);
});

// ---------------------------------------------------------------- usage
test('usage counts every consumer, split by id and name keys', async () => {
    await seedConsumers();
    await as('get', '/api/environments/nope/usage', admin).expect(404);
    const { body } = await as('get', '/api/environments/prod-id/usage', admin).expect(200);
    assert.equal(body.id, 'prod-id');
    assert.equal(body.name, 'Production');
    const byKey = (c) => (body.items.find(i => i.consumer === c) || {}).keyedBy;

    assert.equal(countOf(body, 'CMDB servers'), 1);
    assert.equal(byKey('CMDB servers'), 'id');
    assert.equal(countOf(body, 'Server list metadata'), 1);
    assert.equal(countOf(body, 'Scout monitors'), 2);
    assert.equal(countOf(body, 'API keys'), 1);
    assert.equal(countOf(body, 'Alert rule bindings'), 1);
    assert.equal(countOf(body, 'Maintenance windows'), 1);
    assert.equal(countOf(body, 'Prometheus targets (zone = id)'), 1);
    assert.equal(byKey('Prometheus targets (zone = id)'), 'id');

    assert.equal(countOf(body, 'CMDB servers (by name)'), 1);
    assert.equal(byKey('CMDB servers (by name)'), 'name');
    assert.equal(countOf(body, 'Server list metadata (by name)'), 1);
    assert.equal(countOf(body, 'IPAM subnets'), 1);
    assert.equal(countOf(body, 'IPAM IP addresses'), 2);
    assert.equal(countOf(body, 'SSL certificates'), 1);
    assert.equal(countOf(body, 'Database inventory'), 1);
    assert.equal(countOf(body, 'Database requests'), 2);
    assert.equal(countOf(body, 'Kubernetes clusters'), 1);
    assert.equal(countOf(body, 'Prometheus targets'), 2);
    assert.equal(byKey('Prometheus targets'), 'name');
    assert.equal(body.total, body.items.reduce((s, i) => s + i.count, 0));
    assert.ok(body.total > 0);
    for (const i of body.items) assert.ok(['id', 'name'].includes(i.keyedBy));
});

test('usage of an unreferenced environment is zero', async () => {
    await seedConsumers();
    writeDataSync(ENV_KEY, [...readDataSync(ENV_KEY), { id: 'lab', name: 'Lab', purpose: '' }]);
    const { body } = await as('get', '/api/environments/lab/usage', admin).expect(200);
    assert.equal(body.total, 0);
});

// ---------------------------------------------------------------- delete
test('delete is refused with 409 + usage while referenced, succeeds once free', async () => {
    await seedConsumers();
    const res = await as('delete', '/api/environments/prod-id', admin).expect(409);
    assert.ok(res.body.usage.total > 0);
    assert.equal(res.body.usage.id, 'prod-id');
    assert.equal(readDataSync(ENV_KEY).length, 3);
    // force flag must not bypass the guard
    await as('delete', '/api/environments/prod-id', admin).send({ force: true }).expect(409);

    writeDataSync(ENV_KEY, [...readDataSync(ENV_KEY), { id: 'lab', name: 'Lab', purpose: '' }]);
    await as('delete', '/api/environments/lab', admin).expect(200);
    assert.equal(readDataSync(ENV_KEY).some(e => e.id === 'lab'), false);
});

// ---------------------------------------------------------------- rename + cascade
test('rename without cascade changes only the list', async () => {
    await seedConsumers();
    const res = await as('put', '/api/environments/prod-id', admin).send({ name: 'Live' }).expect(200);
    assert.equal(res.body.name, 'Live');
    assert.equal(res.body.cascade, undefined);
    assert.equal(readDataSync(SSL_KEY)[0].environment, 'Production');
    assert.equal(readDataSync(IPAM_KEY)[0].environment, 'production');
    assert.equal(getTargetsSafely().filter(t => t.labels.zone === 'Production').length, 1);
});

test('rename with cascade updates every name-keyed consumer and reports counts', async () => {
    await seedConsumers();
    const res = await as('put', '/api/environments/prod-id', admin).send({ name: 'Live', cascade: true }).expect(200);
    assert.equal(res.body.name, 'Live');
    const upd = Object.fromEntries(res.body.cascade.map(c => [c.consumer, c.count]));
    assert.equal(upd['CMDB servers'], 2);
    assert.equal(upd['Server list metadata'], 2);
    assert.equal(upd['IPAM subnets'], 1);
    assert.equal(upd['IPAM IP addresses'], 2);
    assert.equal(upd['SSL certificates'], 1);
    assert.equal(upd['Database inventory'], 1);
    assert.equal(upd['Database requests'], 2);
    assert.equal(upd['Kubernetes clusters'], 1);
    assert.equal(upd['Prometheus targets'], 2);

    const rows = libDb.prepare('SELECT ip, envId, envName FROM cmdb_servers ORDER BY ip').all();
    assert.deepEqual(rows.map(r => r.envName), ['Live', 'Live', 'Dev']);
    const meta = readDataSync(META_KEY);
    assert.equal(meta['10.9.0.1'].envName, 'Live');
    assert.equal(meta['10.9.0.2'].envName, 'Live');
    assert.equal(meta['10.9.0.4'].envName, 'Dev');
    const ipam = readDataSync(IPAM_KEY);
    assert.equal(ipam[0].environment, 'Live');
    assert.deepEqual(ipam[0].ips.map(i => i.environment), ['Live', 'Others']);
    assert.equal(ipam[1].environment, 'Dev');
    assert.equal(ipam[1].ips[0].environment, 'Live');
    assert.deepEqual(readDataSync(SSL_KEY).map(c => c.environment), ['Live', 'Dev']);
    assert.equal(readDataSync(DBINV_KEY)[0].environment, 'Live');
    assert.deepEqual(readDataSync(DBREQ_KEY).map(c => c.environment), ['Live', 'Live']);
    assert.deepEqual(readDataSync(K8S_KEY).map(c => c.environment), ['Live', 'Dev']);
    const t = getTargetsSafely();
    const label = (addr) => t.find(x => x.labels.addr === addr).labels;
    assert.equal(label('10.5.0.1').zone, 'Live');
    assert.equal(label('10.5.0.2').env, 'Live');
    assert.equal(label('10.5.0.3').zone, 'prod-id'); // id value left alone
    assert.equal(label('10.5.0.4').zone, 'Dev');
});

test('rename with cascade but unchanged name performs no cascade', async () => {
    await seedConsumers();
    const res = await as('put', '/api/environments/prod-id', admin).send({ name: 'Production', purpose: 'x', cascade: true }).expect(200);
    assert.equal(res.body.cascade, undefined);
});

test('create, update and delete are audited', async (t) => {
    const logged = [];
    t.mock.method(logger, 'auditLog', (...a) => { logged.push(a); });
    const created = await as('post', '/api/environments', admin).send({ name: 'Audit1' }).expect(201);
    await as('put', '/api/environments/' + created.body.id, admin).send({ name: 'Audit2' }).expect(200);
    await as('delete', '/api/environments/' + created.body.id, admin).expect(200);
    assert.equal(logged.length, 3);
    assert.ok(logged.every(l => l[0] === 'superadmin' && l[1] === 'System'));
    assert.match(logged[0][2], /Created Global Environment: Audit1/);
    assert.match(logged[1][2], /Audit1.*Audit2/);
    assert.match(logged[2][2], /Deleted Global Environment: Audit2/);
});

test('cascade rename audit line includes updated counts', async (t) => {
    await seedConsumers();
    const logged = [];
    t.mock.method(logger, 'auditLog', (...a) => { logged.push(a); });
    await as('put', '/api/environments/prod-id', admin).send({ name: 'Live', cascade: true }).expect(200);
    assert.match(logged[0][2], /Production.*Live/);
    assert.match(logged[0][2], /SSL certificates: 1/);
});

// ---------------------------------------------------------------- fix round 1
test('every usage item has a stable machine key', async () => {
    await seedConsumers();
    const { body } = await as('get', '/api/environments/prod-id/usage', admin).expect(200);
    const keys = body.items.map(i => i.key);
    assert.deepEqual(keys, [
        'cmdb', 'cmdb_meta', 'monitors', 'api_keys', 'rule_bindings', 'maintenance', 'prometheus_id',
        'cmdb_name', 'cmdb_meta_name', 'ipam_subnets', 'ipam_ips', 'ssl', 'db_clusters', 'db_requests', 'k8s', 'prometheus_name'
    ]);
    assert.equal(body.complete, true);
});

test('usage does not double count a Prometheus target matched by id and by name', async () => {
    await seedConsumers();
    await saveTargetsSafely([{ targets: ['10.6.0.1:9100'], labels: { addr: '10.6.0.1', zone: 'prod-id', env: 'Production' } }], 'test');
    const { body } = await as('get', '/api/environments/prod-id/usage', admin).expect(200);
    assert.equal(countOf(body, 'Prometheus targets (zone = id)'), 1);
    assert.equal(countOf(body, 'Prometheus targets'), 0);
});

test('delete fails closed when a usage read errors (not a missing table)', async (t) => {
    await seedConsumers();
    writeDataSync(ENV_KEY, [...readDataSync(ENV_KEY), { id: 'lab', name: 'Lab', purpose: '' }]);
    t.mock.method(dbManager, 'get', () => { throw new Error('SQLITE_BUSY: database is locked'); });
    const res = await as('delete', '/api/environments/lab', admin).expect(409);
    assert.match(res.body.error, /could not be verified/);
    assert.equal(res.body.usage.complete, false);
    assert.ok(res.body.usage.items.some(i => i.error));
    assert.equal(readDataSync(ENV_KEY).some(e => e.id === 'lab'), true);
});

test('a missing table counts as 0 and keeps usage complete', async (t) => {
    await seedConsumers();
    writeDataSync(ENV_KEY, [...readDataSync(ENV_KEY), { id: 'lab', name: 'Lab', purpose: '' }]);
    t.mock.method(dbManager, 'get', () => { throw new Error('no such table: monitors'); });
    const { body } = await as('get', '/api/environments/lab/usage', admin).expect(200);
    assert.equal(body.complete, true);
    await as('delete', '/api/environments/lab', admin).expect(200);
});

test('cascade failure leaves the list unrenamed, reports consumers, and a retry completes', async (t) => {
    await seedConsumers();
    const realPrepare = libDb.prepare.bind(libDb);
    const mock = t.mock.method(libDb, 'prepare', (sql) => {
        if (/UPDATE cmdb_servers/.test(sql)) throw new Error('disk I/O error');
        return realPrepare(sql);
    });
    const fail = await as('put', '/api/environments/prod-id', admin).send({ name: 'Live', cascade: true }).expect(500);
    assert.equal(fail.body.renamed, false);
    assert.equal(fail.body.cascade.find(c => c.key === 'cmdb').error, 'disk I/O error');
    assert.equal(fail.body.cascade.find(c => c.key === 'ssl').count, 1);
    assert.equal(readDataSync(ENV_KEY).find(e => e.id === 'prod-id').name, 'Production');

    mock.mock.restore();
    const ok = await as('put', '/api/environments/prod-id', admin).send({ name: 'Live', cascade: true }).expect(200);
    assert.equal(ok.body.name, 'Live');
    const byKey = Object.fromEntries(ok.body.cascade.map(c => [c.key, c.count]));
    assert.equal(byKey.cmdb, 2);
    assert.equal(byKey.ssl, 0); // already updated by the failed attempt: idempotent
    assert.deepEqual(readDataSync(SSL_KEY).map(c => c.environment), ['Live', 'Dev']);
    assert.equal(libDb.prepare("SELECT envName FROM cmdb_servers WHERE ip='10.9.0.1'").get().envName, 'Live');
});

test('Prometheus cascade goes through updateTargetsSafely (rolling backup tagged environment_rename)', async () => {
    await seedConsumers();
    const { BACKUP_DIR } = require('../../lib/prometheusTargetHelper');
    const fs = require('fs');
    await as('put', '/api/environments/prod-id', admin).send({ name: 'Live', cascade: true }).expect(200);
    assert.ok(fs.readdirSync(BACKUP_DIR).some(f => f.includes('environment_rename')));
});

test('legacy untrimmed Others name: purpose-only edit works; purpose null clears', async () => {
    writeDataSync(ENV_KEY, [{ id: '1', name: 'Others ', purpose: 'x' }, { id: 'a', name: 'A', purpose: 'keep' }]);
    await as('put', '/api/environments/1', admin).send({ name: 'Others', purpose: 'y' }).expect(200);
    const res = await as('put', '/api/environments/a', admin).send({ purpose: null }).expect(200);
    assert.equal(res.body.purpose, '');
    await as('post', '/api/environments', admin).send({ name: 'Nul', purpose: null }).expect(201);
});

test('purpose-only update audit records old and new purpose', async (t) => {
    const logged = [];
    t.mock.method(logger, 'auditLog', (...a) => { logged.push(a); });
    await as('put', '/api/environments/dev-id', admin).send({ purpose: 'new purpose' }).expect(200);
    assert.match(logged[0][2], /purpose: "" -> "new purpose"/);
});

test('concurrent creates of the same name are serialised (only one wins)', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => as('post', '/api/environments', admin).send({ name: 'Race' })));
    assert.deepEqual(rs.map(r => r.status).sort(), [201, 400, 400]);
    assert.equal(readDataSync(ENV_KEY).filter(e => e.name === 'Race').length, 1);
});
