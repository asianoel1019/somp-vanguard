// Global Environments phase 2: consumers store envId, migration, unmapped values, flags, validation.
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
const migration = require('../../services/environmentMigration');
const { getTargetsSafely, saveTargetsSafely } = require('../../lib/prometheusTargetHelper');

const ENV_KEY = 'system/environments.json';
const IPAM_KEY = 'network_service/ipam/subnets.json';
const SSL_KEY = 'network_service/ssl_certificates.json';
const DBINV_KEY = 'service_platform/database_clusters.json';
const DBREQ_KEY = 'service_platform/database_requests.json';
const K8S_KEY = 'service_platform/k8s_clusters.json';
const META_KEY = 'server_operation/server_cmdb_meta.json';

const tok = (role) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role })}`;
const admin = tok('SuperAdmin'), op = tok('Operator');
let app;

test.before(async () => {
    await dbManager.initDB();
    app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/environments', require('../../routes/environments'));
    app.use('/api/ssl', require('../../routes/ssl'));
    app.use('/api/database', require('../../routes/database'));
    app.use('/api/kubernetes', require('../../routes/kubernetes'));
    app.use('/api/ipam', require('../../routes/ipam'));
    app.use('/api/server-list', require('../../routes/serverList'));
    app.use('/api/prometheus', require('../../routes/prometheus'));
    app.use('/api/nutanix', require('../../routes/nutanix'));
});
test.after(async () => { await dbManager.closeDB(); });

const as = (method, url, token) => request(app)[method](url).set('Authorization', token);

function seedEnvs() {
    writeDataSync(ENV_KEY, [
        { id: '1', name: 'Others', purpose: '' },
        { id: 'prod-id', name: 'Production', code: 'prd' },
        { id: 'trust-id', name: 'TRUST' }
    ]);
}

function seedLegacy() {
    libDb.prepare('DELETE FROM cmdb_servers').run();
    const ins = libDb.prepare('INSERT INTO cmdb_servers (ip, hostname, envId, envName, isSecondary) VALUES (?, ?, ?, ?, 0)');
    ins.run('10.1.0.1', 'a', null, 'production');   // name
    ins.run('10.1.0.2', 'b', 'TRUST', 'TRUST');     // name stored in envId (old Excel sync)
    ins.run('10.1.0.3', 'c', 'prod-id', 'Production'); // already an id
    ins.run('10.1.0.4', 'd', null, 'Lab');          // unknown
    ins.run('10.1.0.5', 'e', 'PRD', '');            // code in envId
    writeDataSync(META_KEY, {
        '10.1.0.1': { envName: 'PRODUCTION' },
        '10.1.0.2': { envId: 'trust', envName: '' },
        '10.1.0.4': { envName: 'Lab' }
    });
    writeDataSync(IPAM_KEY, [
        { id: 's1', name: 'n1', cidr: '10.0.0.0/24', environment: 'production', ips: [
            { address: '10.0.0.1', environment: 'TRUST' }, { address: '10.0.0.2', environment: 'Lab' }] }
    ]);
    writeDataSync(SSL_KEY, [{ id: 'c1', environment: 'prd' }, { id: 'c2', environment: 'Lab' }]);
    writeDataSync(DBINV_KEY, [{ id: 'd1', environment: 'TRUST' }]);
    writeDataSync(DBREQ_KEY, [{ id: 'r1', environment: 'lab' }]);
    writeDataSync(K8S_KEY, [{ id: 'k1', environment: 'Production' }]);
    writeDataSync(migration.MARKER_KEY, {});
}

test.beforeEach(() => seedEnvs());

// ---------------------------------------------------------------- migration
test('migration resolves names / ids / codes case-insensitively, leaves unknown untouched and reports them', () => {
    seedLegacy();
    const r = migration.runEnvironmentIdMigration({ log: () => {} });
    const rows = Object.fromEntries(libDb.prepare('SELECT ip, envId, envName FROM cmdb_servers').all().map(x => [x.ip, x]));
    assert.deepEqual([rows['10.1.0.1'].envId, rows['10.1.0.1'].envName], ['prod-id', 'Production']);
    assert.deepEqual([rows['10.1.0.2'].envId, rows['10.1.0.2'].envName], ['trust-id', 'TRUST']);
    assert.equal(rows['10.1.0.3'].envId, 'prod-id');
    assert.deepEqual([rows['10.1.0.4'].envId, rows['10.1.0.4'].envName], [null, 'Lab']); // untouched
    assert.equal(rows['10.1.0.5'].envId, 'prod-id');
    assert.equal(r.results.cmdb.resolved, 3);
    assert.deepEqual(r.results.cmdb.unresolved, [{ value: 'Lab', count: 1 }]);

    const meta = readDataSync(META_KEY);
    assert.equal(meta['10.1.0.1'].envId, 'prod-id');
    assert.equal(meta['10.1.0.2'].envId, 'trust-id');
    assert.equal(meta['10.1.0.4'].envId, undefined);
    const ipam = readDataSync(IPAM_KEY);
    assert.equal(ipam[0].envId, 'prod-id');
    assert.equal(ipam[0].environment, 'Production'); // name kept (canonical) for rollback
    assert.equal(ipam[0].ips[0].envId, 'trust-id');
    assert.equal(ipam[0].ips[1].envId, undefined);
    assert.equal(ipam[0].ips[1].environment, 'Lab');
    assert.deepEqual(readDataSync(SSL_KEY).map(c => c.envId), ['prod-id', undefined]);
    assert.equal(readDataSync(DBINV_KEY)[0].envId, 'trust-id');
    assert.equal(readDataSync(DBREQ_KEY)[0].envId, undefined);
    assert.equal(readDataSync(K8S_KEY)[0].envId, 'prod-id');

    const marker = readDataSync(migration.MARKER_KEY);
    for (const k of ['cmdb', 'cmdb_meta', 'ipam_subnets', 'ipam_ips', 'ssl', 'db_clusters', 'db_requests', 'k8s']) assert.ok(marker[k].migratedAt, k);
    assert.deepEqual(marker.ssl.unresolved, [{ value: 'Lab', count: 1 }]);
});

test('migration is idempotent: a second run is skipped per consumer and changes nothing', () => {
    seedLegacy();
    migration.runEnvironmentIdMigration({ log: () => {} });
    writeDataSync(SSL_KEY, [{ id: 'c9', environment: 'Production' }]); // would resolve, but the marker is set
    const r = migration.runEnvironmentIdMigration({ log: () => {} });
    assert.equal(r.results.ssl.skipped, true);
    assert.equal(readDataSync(SSL_KEY)[0].envId, undefined);
    const forced = migration.runEnvironmentIdMigration({ log: () => {}, force: true });
    assert.equal(forced.results.ssl.resolved, 1);
    assert.equal(migration.runEnvironmentIdMigration({ log: () => {}, force: true }).results.ssl.resolved, 0);
});

test('migration failure of one consumer does not stop the others and leaves its marker unset', (t) => {
    seedLegacy();
    const real = libDb.prepare.bind(libDb);
    t.mock.method(libDb, 'prepare', (sql) => { if (/SELECT ip, envId, envName FROM cmdb_servers/.test(sql)) throw new Error('disk I/O error'); return real(sql); });
    const r = migration.runEnvironmentIdMigration({ log: () => {} });
    assert.match(r.results.cmdb.error, /disk/);
    assert.equal(readDataSync(migration.MARKER_KEY).cmdb, undefined);
    assert.equal(readDataSync(SSL_KEY)[0].envId, 'prod-id');
});

// ---------------------------------------------------------------- unmapped + apply
test('GET /unmapped lists distinct unresolved values per consumer (SuperAdmin only)', async () => {
    seedLegacy();
    migration.runEnvironmentIdMigration({ log: () => {} });
    await saveTargetsSafely([
        { targets: ['10.5.0.1:9100'], labels: { addr: '10.5.0.1', zone: 'Production' } },
        { targets: ['10.5.0.2:9100'], labels: { addr: '10.5.0.2', zone: 'Mars', env: 'mars' } },
        { targets: ['10.5.0.3:9100'], labels: { addr: '10.5.0.3', zone: '-' } }
    ], 'test');
    await as('get', '/api/environments/unmapped', op).expect(403);
    const { body } = await as('get', '/api/environments/unmapped', admin).expect(200);
    const by = Object.fromEntries(body.consumers.map(c => [c.key, c]));
    assert.deepEqual(by.cmdb.values, [{ value: 'Lab', count: 1 }]);
    assert.deepEqual(by.ipam_ips.values, [{ value: 'Lab', count: 1 }]);
    assert.equal(by.ipam_subnets.total, 0);
    assert.deepEqual(by.db_requests.values, [{ value: 'lab', count: 1 }]);
    assert.deepEqual(by.prometheus_name.values, [{ value: 'Mars', count: 1 }]); // one target, counted once
    assert.equal(by.prometheus_name.readOnly, true);
});

test('POST /unmapped/apply assigns the environment to every record with that value, audited', async (t) => {
    seedLegacy();
    migration.runEnvironmentIdMigration({ log: () => {} });
    const logged = [];
    t.mock.method(logger, 'auditLog', (...a) => { logged.push(a); });
    await as('post', '/api/environments/unmapped/apply', op).send({ consumer: 'cmdb', value: 'Lab', envId: '1' }).expect(403);
    await as('post', '/api/environments/unmapped/apply', admin).send({ consumer: 'nope', value: 'Lab', envId: '1' }).expect(400);
    await as('post', '/api/environments/unmapped/apply', admin).send({ consumer: 'cmdb', value: 'Lab', envId: 'missing' }).expect(400);
    await as('post', '/api/environments/unmapped/apply', admin).send({ consumer: 'prometheus_name', value: 'Mars', envId: '1' }).expect(400);

    const res = await as('post', '/api/environments/unmapped/apply', admin).send({ consumer: 'cmdb', value: 'lab', envId: '1' }).expect(200);
    assert.equal(res.body.count, 1);
    const row = libDb.prepare("SELECT envId, envName FROM cmdb_servers WHERE ip = '10.1.0.4'").get();
    assert.deepEqual([row.envId, row.envName], ['1', 'Others']);
    const ips = await as('post', '/api/environments/unmapped/apply', admin).send({ consumer: 'ipam_ips', value: 'Lab', envId: 'prod-id' }).expect(200);
    assert.equal(ips.body.count, 1);
    assert.equal(readDataSync(IPAM_KEY)[0].ips[1].envId, 'prod-id');
    assert.ok(logged.some(l => /Mapped environment value "lab" of cmdb to Others \(1 record/.test(l[2])));
    const { body } = await as('get', '/api/environments/unmapped', admin).expect(200);
    assert.equal(body.consumers.find(c => c.key === 'cmdb').total, 0);
});

// ---------------------------------------------------------------- flags
test('isProduction / isDefault flags: derived defaults, exactly one default, default cannot be unset or deleted', async () => {
    const list = (await as('get', '/api/environments', admin).expect(200)).body;
    assert.deepEqual(list.map(e => [e.name, e.isDefault, e.isProduction]), [['Others', true, false], ['Production', false, true], ['TRUST', false, false]]);
    await as('put', '/api/environments/trust-id', admin).send({ isProduction: 'yes' }).expect(400);
    await as('put', '/api/environments/1', admin).send({ isDefault: false }).expect(400);
    const upd = await as('put', '/api/environments/trust-id', admin).send({ isProduction: true, isDefault: true }).expect(200);
    assert.equal(upd.body.isDefault, true);
    const after = readDataSync(ENV_KEY);
    assert.deepEqual(after.filter(e => e.isDefault).map(e => e.id), ['trust-id']);
    assert.equal(after.find(e => e.id === 'trust-id').isProduction, true);
    await as('delete', '/api/environments/trust-id', admin).expect(403);
    const created = await as('post', '/api/environments', admin).send({ name: 'Stage', isDefault: true }).expect(201);
    assert.deepEqual(readDataSync(ENV_KEY).filter(e => e.isDefault).map(e => e.id), [created.body.id]);
});

test('records created without an explicit environment get the isDefault environment (not a hard-coded name)', async () => {
    writeDataSync(ENV_KEY, [{ id: '1', name: 'Others' }, { id: 'lab', name: 'Lab', isDefault: true }]);
    writeDataSync(SSL_KEY, []);
    const r = await as('post', '/api/ssl/add', admin).send({ name: 'x', uploadedFileB64: '' }).expect(200);
    assert.deepEqual([r.body.record.envId, r.body.record.environment], ['lab', 'Lab']);
    writeDataSync(IPAM_KEY, []);
    const s = await as('post', '/api/ipam/subnets', admin).send({ name: 'n', cidr: '10.7.0.0/30' }).expect(201);
    assert.deepEqual([s.body.envId, s.body.environment], ['lab', 'Lab']);
    assert.deepEqual([s.body.ips[0].envId, s.body.ips[0].environment], ['lab', 'Lab']);
});

// ---------------------------------------------------------------- writes store envId / reject unknown
test('SSL, DB inventory, DB provision and Kubernetes writes store envId (+ canonical name) and reject unknown values', async () => {
    writeDataSync(SSL_KEY, []); writeDataSync(DBINV_KEY, []); writeDataSync(DBREQ_KEY, []); writeDataSync(K8S_KEY, []);
    const bad = await as('post', '/api/ssl/add', admin).send({ name: 'x', environment: 'Mars' }).expect(400);
    assert.match(bad.body.error, /Unknown environment "Mars".*Allowed: Others, Production, TRUST/);
    const ssl = await as('post', '/api/ssl/add', admin).send({ name: 'x', environment: 'prd' }).expect(200);
    assert.deepEqual([ssl.body.record.envId, ssl.body.record.environment], ['prod-id', 'Production']);

    await as('post', '/api/database/inventory', admin).send({ name: 'd', environment: 'Mars', engine: 'SQLite', filePath: 'x.db' }).expect(400);
    await as('post', '/api/database/inventory', admin).send({ name: 'd', environment: 'trust', engine: 'SQLite', filePath: 'x.db' }).expect(200);
    assert.deepEqual([readDataSync(DBINV_KEY)[0].envId, readDataSync(DBINV_KEY)[0].environment], ['trust-id', 'TRUST']);

    await as('post', '/api/database/provision', admin).send({ name: 'p', engine: 'MySQL', environment: 'nope', size: 'S' }).expect(400);
    await as('post', '/api/database/provision', admin).send({ name: 'p', engine: 'MySQL', envId: 'prod-id', size: 'S' }).expect(200);
    assert.equal(readDataSync(DBREQ_KEY)[0].envId, 'prod-id');

    await as('post', '/api/kubernetes/clusters', admin).send({ name: 'k', environment: 'Mars', authType: 'token', apiUrl: 'https://x' }).expect(400);
    await as('post', '/api/kubernetes/clusters', admin).send({ name: 'k', environment: 'PRODUCTION', authType: 'token', apiUrl: 'https://x' }).expect(200);
    assert.deepEqual([readDataSync(K8S_KEY)[0].envId, readDataSync(K8S_KEY)[0].environment], ['prod-id', 'Production']);
});

test('reads derive the name from envId (rename needs no cascade) and show Unassigned for unknown', async () => {
    writeDataSync(SSL_KEY, [{ id: 'c1', envId: 'prod-id', environment: 'Production' }, { id: 'c2', environment: 'Mars' }]);
    writeDataSync(K8S_KEY, [{ id: 'k1', envId: 'prod-id', environment: 'Production' }, { id: 'k2', envId: 'gone', environment: '' }]);
    writeDataSync(DBINV_KEY, [{ id: 'd1', envId: 'prod-id', environment: 'Production' }]);
    await as('put', '/api/environments/prod-id', admin).send({ name: 'Live' }).expect(200); // no cascade
    const ssl = (await as('get', '/api/ssl/list', admin).expect(200)).body;
    assert.deepEqual(ssl.map(c => c.environment), ['Live', 'Unassigned']);
    assert.equal(ssl[1].envUnmapped, 'Mars');
    assert.equal(ssl[0].envIsProduction, true);
    const k8s = (await as('get', '/api/kubernetes/clusters', admin).expect(200)).body.clusters;
    assert.deepEqual(k8s.map(c => c.environment), ['Live', 'Unassigned']);
    const dbs = (await as('get', '/api/database/inventory', admin).expect(200)).body.databases;
    assert.deepEqual([dbs[0].environment, dbs[0].envId], ['Live', 'prod-id']);
    // stored name copy is untouched without cascade (rollback field), display is derived
    assert.equal(readDataSync(SSL_KEY)[0].environment, 'Production');
});

test('delete is blocked by an envId reference even when the stored name differs', async () => {
    writeDataSync(ENV_KEY, [...readDataSync(ENV_KEY), { id: 'lab', name: 'Lab' }]);
    writeDataSync(SSL_KEY, [{ id: 'c1', envId: 'lab', environment: 'Old name' }]);
    const res = await as('delete', '/api/environments/lab', admin).expect(409);
    assert.equal(res.body.usage.items.find(i => i.key === 'ssl').count, 1);
    assert.equal(res.body.usage.items.find(i => i.key === 'ssl').keyedBy, 'id');
    writeDataSync(SSL_KEY, []);
});

// ---------------------------------------------------------------- IPAM
test('IPAM: explicit subnet environment validated; ips round-trip keeps unmapped raw values (never "Unassigned")', async () => {
    writeDataSync(IPAM_KEY, [{ id: 's1', name: 'n', cidr: '10.8.0.0/24', envId: 'prod-id', environment: 'Production', ips: [
        { address: '10.8.0.1', environment: 'Mars' }, { address: '10.8.0.2', envId: 'trust-id', environment: 'TRUST' }] }]);
    // the default list is summaries (no ips): the full shape is ?include=ips
    const list = (await as('get', '/api/ipam/subnets?include=ips', admin).expect(200)).body;
    assert.equal(list[0].ips[0].environment, 'Unassigned');
    assert.equal(list[0].ips[0].envUnmapped, 'Mars');
    await as('put', '/api/ipam/subnets/s1', admin).send({ environment: 'Mars' }).expect(400);
    await as('put', '/api/ipam/subnets/s1', admin).send({ environment: 'trust', ips: list[0].ips }).expect(200);
    const stored = readDataSync(IPAM_KEY)[0];
    assert.deepEqual([stored.envId, stored.environment], ['trust-id', 'TRUST']);
    assert.equal(stored.ips[0].environment, 'Mars');
    assert.equal(stored.ips[0].envUnmapped, undefined);
    assert.equal(stored.ips[0].envIsProduction, undefined);
    assert.equal(stored.ips[1].envId, 'trust-id');

    await as('put', '/api/ipam/subnets/s1/ips', admin).send({ address: '10.8.0.1', environment: 'Venus' }).expect(400);
    await as('put', '/api/ipam/subnets/s1/ips', admin).send({ address: '10.8.0.1', envId: 'prod-id' }).expect(200);
    assert.equal(readDataSync(IPAM_KEY)[0].ips[0].envId, 'prod-id');

    const batch = await as('post', '/api/ipam/subnets/batch', admin).send({ subnets: [
        { name: 'a', cidr: '10.9.1.0/30', environment: 'prd' }, { name: 'b', cidr: '10.9.2.0/30', environment: 'Mars' }] }).expect(201);
    assert.equal(batch.body.added, 1);
    assert.equal(batch.body.rejected[0].cidr, '10.9.2.0/30');
    assert.match(batch.body.rejected[0].error, /Unknown environment "Mars"/);
});

// ---------------------------------------------------------------- Server List / CMDB
test('Server List: edits store envId, unknown rejected, list shows Unassigned (no silent Production)', async () => {
    libDb.prepare('DELETE FROM cmdb_servers').run();
    writeDataSync(META_KEY, {});
    await as('put', '/api/server-list/cmdb-meta/10.2.0.1', admin).send({ envName: 'Mars' }).expect(400);
    await as('put', '/api/server-list/cmdb-meta/10.2.0.1', admin).send({ envName: 'prd', hostname: 'h' }).expect(200);
    const meta = readDataSync(META_KEY)['10.2.0.1'];
    assert.deepEqual([meta.envId, meta.envName], ['prod-id', 'Production']);
    const row = libDb.prepare("SELECT envId, envName FROM cmdb_servers WHERE ip = '10.2.0.1'").get();
    assert.deepEqual([row.envId, row.envName], ['prod-id', 'Production']);

    libDb.prepare("INSERT INTO cmdb_servers (ip, hostname, envName, isSecondary) VALUES ('10.2.0.2', 'x', 'Mars', 0)").run();
    const { body } = await as('get', '/api/server-list', admin).expect(200);
    const s2 = body.servers.find(s => s.ip === '10.2.0.2');
    assert.deepEqual([s2.envName, s2.envId, s2.envUnmapped], ['Unassigned', null, 'Mars']);
    const s1 = body.servers.find(s => s.ip === '10.2.0.1');
    assert.deepEqual([s1.envName, s1.envIsProduction], ['Production', true]);

    // "Unassigned" sent back unchanged leaves the stored value alone
    await as('put', '/api/server-list/cmdb-meta/10.2.0.1', admin).send({ envName: 'Unassigned' }).expect(200);
    assert.equal(readDataSync(META_KEY)['10.2.0.1'].envId, 'prod-id');

    await as('post', '/api/server-list/bulk-cmdb-meta', admin).send({ ips: ['10.2.0.1'], data: { envName: 'Mars' } }).expect(400);
    await as('post', '/api/server-list/bulk-cmdb-meta', admin).send({ ips: ['10.2.0.1'], data: { envId: 'trust-id' } }).expect(200);
    assert.equal(readDataSync(META_KEY)['10.2.0.1'].envId, 'trust-id');
});

test('Server List filter accepts id, name or code; Excel upsert rejects unknown rows with a clear message', async () => {
    libDb.prepare('DELETE FROM cmdb_servers').run();
    writeDataSync(META_KEY, {});
    const r = await as('post', '/api/server-list/upsert-vms', admin).send({ vms: [
        { IP: '10.3.0.1', Name: 'ok1', Env: 'trust' },
        { IP: '10.3.0.2', Name: 'bad', Env: 'Mars' },
        { IP: '10.3.0.3', Name: 'ok2', Env: 'PRD' }
    ] }).expect(200);
    assert.equal(r.body.count, 2);
    assert.equal(r.body.rejected.length, 1);
    assert.match(r.body.rejected[0].error, /Unknown environment "Mars"/);
    assert.equal(libDb.prepare("SELECT envId FROM cmdb_servers WHERE ip = '10.3.0.1'").get().envId, 'trust-id');
    assert.equal(libDb.prepare("SELECT COUNT(*) AS c FROM cmdb_servers WHERE ip = '10.3.0.2'").get().c, 0);
    await as('post', '/api/server-list/upsert-vms', admin).send({ vms: [{ IP: '10.3.0.9', Env: 'Mars' }] }).expect(400);

    for (const q of ['prod-id', 'production', 'PRD']) {
        const { body } = await as('get', `/api/server-list?env=${encodeURIComponent(q)}`, admin).expect(200);
        assert.deepEqual(body.servers.map(s => s.ip), ['10.3.0.3'], q);
    }
});

test('CMDB writes from background sources resolve names to envId; unresolved values stay raw', () => {
    libDb.prepare('DELETE FROM cmdb_servers').run();
    writeDataSync(META_KEY, {});
    cmdb.upsertCmdbServer({ ip: '10.4.0.1', envName: 'trust' }, 'SCANNER');
    cmdb.bulkUpsertCmdbServers([{ ip: '10.4.0.2', envId: 'Production' }, { ip: '10.4.0.3', envName: 'Mars' }], 'SCANNER');
    const rows = Object.fromEntries(libDb.prepare('SELECT ip, envId, envName FROM cmdb_servers').all().map(x => [x.ip, x]));
    assert.equal(rows['10.4.0.1'].envId, 'trust-id');
    assert.deepEqual([rows['10.4.0.2'].envId, rows['10.4.0.2'].envName], ['prod-id', 'Production']);
    assert.deepEqual([rows['10.4.0.3'].envId, rows['10.4.0.3'].envName], [null, 'Mars']);
    assert.equal(cmdb.queryCmdbServers({}).servers.find(s => s.ip === '10.4.0.3').envName, 'Unassigned');
});

test('CMDB -> Prometheus sync writes the canonical NAME, never the id', async () => {
    libDb.prepare('DELETE FROM cmdb_servers').run();
    writeDataSync(META_KEY, {});
    await saveTargetsSafely([{ targets: ['10.6.0.1:9100'], labels: { addr: '10.6.0.1', zone: 'Others' } }], 'test');
    await as('put', '/api/server-list/cmdb-meta/10.6.0.1', admin).send({ envId: 'prod-id', hostname: 'p' }).expect(200);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(getTargetsSafely().find(t => t.labels.addr === '10.6.0.1').labels.zone, 'Production');

    writeDataSync(META_KEY, { '10.6.0.1': { envId: 'trust-id', envName: 'TRUST', applicationName: 'app' } });
    await as('post', '/api/server-list/sync-all', admin).send({}).expect(200);
    assert.equal(getTargetsSafely().find(t => t.labels.addr === '10.6.0.1').labels.zone, 'TRUST');
});

// ---------------------------------------------------------------- Prometheus
test('Prometheus: manual update validates zone and normalises to the canonical name; unknown -> 400 with allowed names', async () => {
    await saveTargetsSafely([{ targets: ['10.6.1.1:9100'], labels: { addr: '10.6.1.1', zone: 'Old', host: 'h' } }], 'test');
    const bad = await as('put', '/api/prometheus/update', admin).send({ originalIp: '10.6.1.1', newIp: '10.6.1.1', port: 9100, zone: 'Mars' }).expect(400);
    assert.match(bad.body.error, /Unknown environment "Mars".*Allowed: Others, Production, TRUST/);
    await as('put', '/api/prometheus/update', admin).send({ originalIp: '10.6.1.1', newIp: '10.6.1.1', port: 9100, zone: '' }).expect(400);
    await as('put', '/api/prometheus/update', admin).send({ originalIp: '10.6.1.1', newIp: '10.6.1.1', port: 9100, zone: 'production' }).expect(200);
    assert.equal(getTargetsSafely()[0].labels.zone, 'Production');
});

test('Prometheus: text import rejects unknown environments with line numbers (nothing written)', async () => {
    await saveTargetsSafely([{ targets: ['10.6.2.1:9100'], labels: { addr: '10.6.2.1', zone: 'TRUST', host: 'h' } }], 'test');
    const text = 'ip,host,zone\n10.6.2.1,h2,prd\n10.6.2.2,new,Mars\n10.6.2.3,new3,';
    const res = await as('post', '/api/prometheus/parse', admin).send({ pastedText: text }).expect(400);
    assert.deepEqual(res.body.lineErrors.map(e => e.line), [3, 4]);
    assert.match(res.body.error, /line 3: Unknown environment "Mars"/);
    assert.equal(getTargetsSafely()[0].labels.zone, 'TRUST');
    const ok = await as('post', '/api/prometheus/parse', admin).send({ pastedText: '10.6.2.1,h2,prd' }).expect(200);
    assert.equal(ok.body.updatedCount, 1);
    assert.equal(getTargetsSafely()[0].labels.zone, 'Production');
});

test('Prometheus list flags existing targets whose labels are not in Environments (display only)', async () => {
    await saveTargetsSafely([
        { targets: ['10.6.3.1:9100'], labels: { addr: '10.6.3.1', zone: 'Mars' } },
        { targets: ['10.6.3.2:9100'], labels: { addr: '10.6.3.2', zone: 'TRUST' } }
    ], 'test');
    const { body } = await as('get', '/api/prometheus/list', admin).expect(200);
    assert.deepEqual(body.targets[0].envWarning, [{ label: 'zone', value: 'Mars' }]);
    assert.equal(body.targets[1].envWarning, undefined);
    assert.equal(getTargetsSafely()[0].envWarning, undefined); // never stored
    assert.deepEqual(body.environments.map(e => e.name), ['Others', 'Production', 'TRUST']);
});

// ---------------------------------------------------------------- HM_checker
test('HM_checker: environment list comes from the global list only; DEV / SIT ignored by default (by id, case-insensitive)', () => {
    const svc = require('../../services/hostMonitorCheckerService');
    writeDataSync(ENV_KEY, [{ id: '1', name: 'Others' }, { id: 'dev-id', name: 'Dev' }, { id: 'sit-id', name: 'SIT' }, { id: 'trust-id', name: 'TRUST', isProduction: true }]);
    libDb.prepare('DELETE FROM cmdb_servers').run();
    libDb.prepare("INSERT INTO cmdb_servers (ip, hostname, envName, isSecondary) VALUES ('10.7.7.7', 'x', 'FromCmdbOnly', 0)").run();
    assert.deepEqual(svc.getActualEnvironments(), ['Dev', 'Others', 'SIT', 'TRUST']); // CMDB-only names no longer added
    writeDataSync('server_operation/hm_checker_config.json', {}); // never saved
    assert.deepEqual(svc.getConfig().ignoredEnvs, ['dev-id', 'sit-id']);
    const parsed = { tests: [] };
    const servers = [
        { ip: '1.1.1.1', envId: 'dev-id', envName: 'Dev' },
        { ip: '1.1.1.2', envId: 'trust-id', envName: 'TRUST' },
        { ip: '1.1.1.3', envId: null, envName: 'sit' } // unmapped raw name still matches case-insensitively
    ];
    const r = svc.compareServersWithHostMonitor(servers, parsed, svc.getConfig().ignoredEnvs);
    assert.equal(r.summary.ignoredServers, 2);
    assert.deepEqual(r.results.map(x => x.ip), ['1.1.1.2']);
    // an explicitly saved list (names or ids) replaces the default
    assert.equal(svc.compareServersWithHostMonitor(servers, parsed, ['trust']).summary.ignoredServers, 1);
    svc.saveConfig({ ignoredEnvs: [] });
});

// ---------------------------------------------------------------- Nutanix
test('Nutanix clone: environments validated before anything starts (unknown / empty rejected, canonical name)', async () => {
    const nutanix = require('../../routes/nutanix');
    const v = nutanix.validateCloneEnvironments([{ Name: 'a', Env: 'trust' }, { Name: 'b', Env: 'Mars' }, { Name: 'c' }]);
    assert.deepEqual(v.names, ['TRUST', '', '']);
    assert.deepEqual(v.errors.map(e => e.row), [2, 3]);
    assert.match(v.errors[0].error, /Unknown environment "Mars"/);
    assert.match(v.errors[1].error, /required/);
    const res = await as('post', '/api/nutanix/clone', admin).send({ vms: [{ Name: 'b', IP: '10.1.1.1', OS: 'Rocky Linux', Env: 'Mars' }] }).expect(400);
    assert.match(res.body.error, /Environment check failed for 1 VM/);
    assert.equal(res.body.rows[0].value, 'Mars');
});

// ================================================================ fix round 1
const cmdbRow = (ip) => libDb.prepare('SELECT envId, envName, envRaw FROM cmdb_servers WHERE ip = ?').get(ip);

test('I1: a CMDB mapping survives sync-all and an Excel import with an empty Env (meta mapped too)', async () => {
    libDb.prepare('DELETE FROM cmdb_servers').run();
    const ins = libDb.prepare('INSERT INTO cmdb_servers (ip, hostname, envId, envName, isSecondary) VALUES (?, ?, ?, ?, 0)');
    ins.run('10.11.0.1', 'm1', null, 'Mars');
    ins.run('10.11.0.2', 'm2', null, '');
    writeDataSync(META_KEY, { '10.11.0.1': { envName: 'Mars', applicationName: 'a' }, '10.11.0.2': { envId: '', envName: '' } });

    const a = await as('post', '/api/environments/unmapped/apply', admin).send({ consumer: 'cmdb', value: 'mars', envId: 'trust-id' }).expect(200);
    assert.equal(a.body.count, 1);
    assert.equal(a.body.related.cmdb_meta, 1);
    assert.deepEqual([readDataSync(META_KEY)['10.11.0.1'].envId, readDataSync(META_KEY)['10.11.0.1'].envNameRaw], ['trust-id', 'Mars']);
    const e = await as('post', '/api/environments/unmapped/apply', admin).send({ consumer: 'cmdb', value: '', envId: 'prod-id' }).expect(200);
    assert.equal(e.body.count, 1);

    await as('post', '/api/server-list/sync-all', admin).send({}).expect(200);
    assert.equal(cmdbRow('10.11.0.1').envId, 'trust-id');
    assert.equal(cmdbRow('10.11.0.1').envRaw, 'Mars'); // original text kept for rollback / audit
    assert.equal(cmdbRow('10.11.0.2').envId, 'prod-id');

    await as('post', '/api/server-list/upsert-vms', admin).send({ vms: [{ IP: '10.11.0.1', Name: 'm1', Env: '' }, { IP: '10.11.0.2', Name: 'm2' }] }).expect(200);
    assert.equal(cmdbRow('10.11.0.1').envId, 'trust-id');
    assert.equal(cmdbRow('10.11.0.2').envId, 'prod-id');

    // applying on the metadata side maps the CMDB rows of the same IPs as well
    libDb.prepare("UPDATE cmdb_servers SET envId = NULL, envName = 'Venus' WHERE ip = '10.11.0.1'").run();
    writeDataSync(META_KEY, { '10.11.0.1': { envName: 'Venus' } });
    const m = await as('post', '/api/environments/unmapped/apply', admin).send({ consumer: 'cmdb_meta', value: 'Venus', envId: '1' }).expect(200);
    assert.deepEqual([m.body.count, m.body.related.cmdb], [1, 1]);
    assert.equal(cmdbRow('10.11.0.1').envId, '1');
});

test('I1: an automatic source with an empty / unknown env never replaces a valid stored envId; a manual edit may', () => {
    libDb.prepare('DELETE FROM cmdb_servers').run();
    writeDataSync(META_KEY, {});
    cmdb.upsertCmdbServer({ ip: '10.12.0.1', envId: 'prod-id' }, 'MANUAL');
    cmdb.bulkUpsertCmdbServers([{ ip: '10.12.0.1', envId: '', envName: 'Mars' }], 'SCANNER');
    assert.equal(cmdbRow('10.12.0.1').envId, 'prod-id');
    cmdb.upsertCmdbServer({ ip: '10.12.0.1', envId: '', envName: '' }, 'SCANNER');
    assert.equal(cmdbRow('10.12.0.1').envId, 'prod-id');
    cmdb.upsertCmdbServer({ ip: '10.12.0.1', envName: 'trust' }, 'SCANNER'); // a known value still applies
    assert.equal(cmdbRow('10.12.0.1').envId, 'trust-id');
    cmdb.upsertCmdbServer({ ip: '10.12.0.1', envId: 'prod-id' }, 'MANUAL');
    assert.equal(cmdbRow('10.12.0.1').envId, 'prod-id');
});

test('M1: migration keeps the original text (code / id-in-name / spelling) in a raw field; HM groups by the canonical name', () => {
    seedLegacy();
    migration.runEnvironmentIdMigration({ log: () => {} });
    assert.equal(cmdbRow('10.1.0.5').envRaw, 'PRD');        // code in envId
    assert.equal(cmdbRow('10.1.0.1').envRaw, 'production'); // spelling
    assert.equal(cmdbRow('10.1.0.3').envRaw, null);          // already an id: untouched
    assert.equal(readDataSync(SSL_KEY)[0].environmentRaw, 'prd');
    assert.equal(readDataSync(K8S_KEY)[0].environmentRaw, undefined); // exact name: nothing to keep
    assert.equal(readDataSync(META_KEY)['10.1.0.2'].envNameRaw, 'trust');
    const svc = require('../../services/hostMonitorCheckerService');
    const s = svc.loadCmdbServers('', { readDeletedMeta: () => ({}) }).find(x => x.ip === '10.1.0.5');
    assert.deepEqual([s.envId, s.env], ['prod-id', 'Production']);
});

test('M2: codes count in usage (delete blocked) and in the legacy Server List filter', async () => {
    libDb.prepare('DELETE FROM cmdb_servers').run();
    libDb.prepare("INSERT INTO cmdb_servers (ip, hostname, envName, isSecondary) VALUES ('10.13.0.1', 'c', 'prd', 0)").run();
    writeDataSync(META_KEY, { '10.13.0.9': { envName: 'PRD' } });
    writeDataSync(SSL_KEY, [{ id: 's', environment: 'PRD' }]);
    const { body } = await as('get', '/api/environments/prod-id/usage', admin).expect(200);
    const by = Object.fromEntries(body.items.map(i => [i.key, i.count]));
    assert.equal(by.cmdb_name, 1);
    assert.equal(by.cmdb_meta_name, 1);
    assert.equal(by.ssl, 1);
    await as('delete', '/api/environments/prod-id', admin).expect(409);
    const list = await as('get', '/api/server-list?env=Production', admin).expect(200);
    assert.deepEqual(list.body.servers.map(s => s.ip), ['10.13.0.1']);
    writeDataSync(SSL_KEY, []);
});

test('M4: "Unassigned" and "(empty)" are reserved environment names (case-insensitive)', async () => {
    for (const name of ['Unassigned', 'UNASSIGNED', '(empty)', '(Empty)']) {
        const r = await as('post', '/api/environments', admin).send({ name }).expect(400);
        assert.match(r.body.error, /reserved/);
    }
    await as('put', '/api/environments/trust-id', admin).send({ name: 'unassigned' }).expect(400);
});

test('M5: CMDB apply over many rows runs in batches inside one transaction', async () => {
    libDb.prepare('DELETE FROM cmdb_servers').run();
    writeDataSync(META_KEY, {});
    const ins = libDb.prepare("INSERT INTO cmdb_servers (ip, hostname, envName, isSecondary) VALUES (?, 'h', 'Bulk', 0)");
    libDb.exec('BEGIN');
    for (let i = 0; i < 1203; i++) ins.run(`10.20.${Math.floor(i / 250)}.${i % 250}`);
    libDb.exec('COMMIT');
    const r = await as('post', '/api/environments/unmapped/apply', admin).send({ consumer: 'cmdb', value: 'bulk', envId: 'trust-id' }).expect(200);
    assert.equal(r.body.count, 1203);
    assert.equal(libDb.prepare("SELECT COUNT(*) AS c FROM cmdb_servers WHERE envId = 'trust-id' AND envRaw = 'Bulk'").get().c, 1203);
});

test('M6: inventory-discovered Prometheus targets get the CMDB environment name, else the default (never "-")', async () => {
    const sched = require('../../services/inventoryScheduler');
    libDb.prepare('DELETE FROM cmdb_servers').run();
    writeDataSync(META_KEY, {});
    cmdb.upsertCmdbServer({ ip: '10.14.0.1', envId: 'trust-id' }, 'MANUAL');
    await saveTargetsSafely([], 'test');
    await sched.applyPrometheusAdditions([{ ip: '10.14.0.1', port: 9100, hostname: 'a', targetOs: 'linux' }, { ip: '10.14.0.2', port: 9100, hostname: 'b', targetOs: 'linux' }]);
    const zones = Object.fromEntries(getTargetsSafely().map(t => [t.labels.addr, t.labels.zone]));
    assert.deepEqual(zones, { '10.14.0.1': 'TRUST', '10.14.0.2': 'Others' });
});

test('M7: /parse canonicalises env / environment labels and reports invalid / duplicate lines', async () => {
    await saveTargetsSafely([{ targets: ['10.15.0.1:9100'], labels: { addr: '10.15.0.1', zone: 'TRUST', env: 'production' } }], 'test');
    const r = await as('post', '/api/prometheus/parse', admin).send({ pastedText: '10.15.0.1,h,trust\nnot-an-ip,x,TRUST\n10.15.0.1,h,TRUST' }).expect(200);
    assert.equal(r.body.updatedCount, 1);
    assert.deepEqual(r.body.skippedLines.map(s => s.line), [2, 3]);
    assert.match(r.body.skippedLines[1].reason, /duplicate of line 1/);
    const t = getTargetsSafely().find(x => x.labels.addr === '10.15.0.1');
    assert.deepEqual([t.labels.zone, t.labels.env], ['TRUST', 'Production']);
});

test('M10: editing a DB / K8s record whose environment is Unassigned keeps it; SSL "Unassigned" means the default', async () => {
    writeDataSync(DBINV_KEY, [{ id: 'd9', name: 'd', environment: 'Mars', engine: 'SQLite', host: 'localhost', database: 'x.db' }]);
    await as('post', '/api/database/inventory', admin).send({ id: 'd9', name: 'd2', environment: '', engine: 'SQLite', filePath: 'x.db' }).expect(200);
    assert.deepEqual([readDataSync(DBINV_KEY)[0].name, readDataSync(DBINV_KEY)[0].environment, readDataSync(DBINV_KEY)[0].envId], ['d2', 'Mars', undefined]);
    await as('post', '/api/database/inventory', admin).send({ id: 'd9', name: 'd2', environment: 'Unassigned', engine: 'SQLite', filePath: 'x.db' }).expect(200);
    await as('post', '/api/database/inventory', admin).send({ name: 'new', environment: '', engine: 'SQLite', filePath: 'y.db' }).expect(400); // create still needs one
    writeDataSync(K8S_KEY, [{ id: 'k9', name: 'k', environment: 'Mars', authType: 'token' }]);
    await as('post', '/api/kubernetes/clusters', admin).send({ id: 'k9', name: 'k2', environment: 'Unassigned', authType: 'token', apiUrl: 'https://x' }).expect(200);
    assert.deepEqual([readDataSync(K8S_KEY)[0].name, readDataSync(K8S_KEY)[0].environment], ['k2', 'Mars']);
    writeDataSync(SSL_KEY, []);
    const s = await as('post', '/api/ssl/add', admin).send({ name: 'x', environment: 'Unassigned' }).expect(200);
    assert.equal(s.body.record.envId, '1');
});
