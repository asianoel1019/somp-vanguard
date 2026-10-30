require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { db: libDb, readDataSync, writeDataSync } = require('../../lib/db');
const { getTargetsSafely, saveTargetsSafely } = require('../../lib/prometheusTargetHelper');

const META_KEY = 'server_operation/server_cmdb_meta.json';
const bearer = `Bearer ${signToken({ username: 'op', domain: 'corp', role: 'Operator', groups: ['sl'] })}`;
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: { sl: { enabled: true, features: { serverList: true } } } });
    app = express();
    app.use(express.json());
    app.use('/api/server-list', require('../../routes/serverList'));
});
test.after(async () => { await dbManager.closeDB(); });

const target = (ip, application) => ({ targets: [`${ip}:9100`], labels: { addr: ip, host: `H-${ip}`, application, group: 'G', zone: 'Z' } });
const promRow = () => dbManager.get("SELECT value, updatedAt FROM document_store WHERE key = 'prometheus_targets.json'");

test('sync-all pushes CMDB metadata to the Prometheus target of the changed server only; the target count is preserved', async () => {
    libDb.prepare('DELETE FROM cmdb_servers').run();
    await saveTargetsSafely([target('10.2.1.1', 'OldApp'), target('10.2.1.2', 'SameApp')], 'test_seed');
    writeDataSync(META_KEY, {
        '10.2.1.1': { hostname: 'A', applicationName: 'NewApp' },
        '10.2.1.2': { hostname: 'B', applicationName: 'SameApp' }
    });

    const res = await request(app).post('/api/server-list/sync-all').set('Authorization', bearer);
    assert.equal(res.status, 200);

    const targets = getTargetsSafely();
    assert.equal(targets.length, 2, 'no target lost or duplicated');
    const byIp = Object.fromEntries(targets.map(t => [t.labels.addr, t]));
    assert.equal(byIp['10.2.1.1'].labels.application, 'NewApp');
    assert.equal(byIp['10.2.1.1'].applications, 'NewApp');
    assert.equal(byIp['10.2.1.2'].labels.application, 'SameApp');
    assert.equal(byIp['10.2.1.2'].labels.group, 'G');
    assert.equal(byIp['10.2.1.2'].labels.zone, 'Z');
    assert.equal(byIp['10.2.1.2'].labels.host, 'H-10.2.1.2');
});

test('a single-server sync with an empty targets document writes nothing', async () => {
    await saveTargetsSafely([], 'test_seed');
    const before = promRow();
    const res = await request(app).put('/api/server-list/cmdb-meta/10.2.9.9').set('Authorization', bearer).send({ applicationName: 'Whatever' });
    assert.equal(res.status, 200);
    const after = promRow();
    assert.equal(after.value, before.value);
    assert.equal(after.updatedAt, before.updatedAt, 'the targets document was not rewritten');
    assert.deepEqual(getTargetsSafely(), []);
    assert.equal(readDataSync(META_KEY, {})['10.2.9.9'].applicationName, 'Whatever', 'the CMDB edit itself is saved');
});
