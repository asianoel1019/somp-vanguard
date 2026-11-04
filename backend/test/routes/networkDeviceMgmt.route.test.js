// Management connection routes: roles, masking, device errors as 502/504 (never 401), list status, cleanup on delete.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync, writeDataSync } = require('../../lib/db');

const tok = (role) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups: ['g'] })}`;
const SA = tok('SuperAdmin'), OP = tok('Operator'), VIEWER = tok('Viewer');
const TOKEN = 'fgt-token-0123456789';

let app;
let store;
let registry;
let calls = 0;
let backupText = 'config system global\nend\n';
let failWith = null;
const audits = [];

const fake = {
    capabilities: ['summary', 'policies', 'sessions'],
    testConnection: async (t) => { if (failWith) throw failWith; return { model: 'FGT60F', host: t.mgmtHost, token: t.secrets.token === TOKEN }; },
    getSummary: async () => { calls += 1; if (failWith) throw failWith; return { model: 'FGT60F', version: 'v7.4.3' }; },
    getPolicies: async (p, opts) => ({ opts }),
    getSessions: async (p, opts) => ({ opts }),
    backupConfig: async () => ({ content: backupText, format: 'conf' }),
};

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: {
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { networkDevice: true, dataCenter: true } },
            g: { type: 'group', target: 'g', enabled: true, features: { networkDevice: true, dataCenter: true } },
        },
    });
    require('../../lib/ipamSync').batchSyncIpsToIpam = () => {};
    require('../../lib/logger').auditLog = (user, mod, msg) => { audits.push([user, mod, msg]); };
    store = require('../../lib/netDevices/profileStore');
    registry = require('../../lib/netDevices');
    registry._drivers.fortigate = fake;
    const rackStore = require('../../lib/rackStore');
    rackStore.saveRacks('default', [{ id: 'r1', name: 'r1', height: 42, devices: [
        { id: 'fw1', type: 'Firewall', hostname: 'fw1', startU: 1, sizeU: 1, ip: '192.0.2.1' },
        { id: 'fw2', type: 'Firewall', hostname: 'fw2', startU: 4, sizeU: 1 },
        { id: 'sw1', type: 'Switch', hostname: 'sw1', startU: 2, sizeU: 1 },
        { id: 'srv1', type: 'Server', hostname: 'srv1', startU: 3, sizeU: 1 },
    ] }]);
    app = express();
    app.use(express.json());
    app.use('/api/network-device', require('../../routes/networkDevice'));
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => { writeDataSync(store.KEY, {}); registry.clearCache(); calls = 0; failWith = null; });

const call = (method, url, token, body) => {
    const r = request(app)[method](`/api/network-device${url}`).set('Authorization', token);
    return body !== undefined ? r.send(body) : r;
};
const cfg = { vendor: 'fortigate', mgmtHost: '192.0.2.254', port: 443, token: TOKEN };

test('vendors by type', async () => {
    const r = await call('get', '/mgmt/vendors?type=Firewall', VIEWER);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(v => v.id), ['fortigate', 'paloalto', 'checkpoint']);
});

test('only Operator+ saves; the token never comes back', async () => {
    assert.equal((await call('put', '/fw1/mgmt', VIEWER, cfg)).status, 403);
    const r = await call('put', '/fw1/mgmt', OP, cfg);
    assert.equal(r.status, 200);
    assert.equal(r.body.profile.secrets.token, store.MASK);
    assert.ok(!JSON.stringify(r.body).includes(TOKEN));
    const g = await call('get', '/fw1/mgmt', VIEWER);
    assert.equal(g.status, 200);
    assert.equal(g.body.profile.mgmtHost, '192.0.2.254');
    assert.ok(!JSON.stringify(g.body).includes(TOKEN));
    assert.deepEqual(g.body.capabilities, ['summary', 'policies', 'sessions']);
    assert.ok(audits.some(a => /Saved management connection of fw1/.test(a[2])));
});

test('unknown device, non-network device, wrong vendor for type', async () => {
    assert.equal((await call('get', '/nope/mgmt', VIEWER)).status, 404);
    assert.equal((await call('get', '/srv1/mgmt', VIEWER)).status, 404);
    const r = await call('put', '/sw1/mgmt', OP, cfg);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'BAD_REQUEST');
});

test('data: not configured is 409; device auth failure is 502, never 401', async () => {
    let r = await call('get', '/fw1/mgmt/data/summary', VIEWER);
    assert.equal(r.status, 409);
    await call('put', '/fw1/mgmt', OP, cfg);
    r = await call('get', '/fw1/mgmt/data/summary', VIEWER);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.model, 'FGT60F');
    const { netError } = require('../../lib/netDevices/errors');
    failWith = netError('AUTH', 'The device rejected the credentials (401)');
    r = await call('get', '/fw1/mgmt/data/summary?refresh=1', VIEWER);
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'AUTH');
    failWith = netError('UNREACHABLE', 'The device did not answer (timeout)');
    r = await call('get', '/fw1/mgmt/data/summary?refresh=1', VIEWER);
    assert.equal(r.status, 504);
    assert.equal((await call('get', '/fw1/mgmt/data/routes', VIEWER)).status, 400);
});

test('only the known query options reach the driver', async () => {
    await call('put', '/fw1/mgmt', OP, cfg);
    let r = await call('get', '/fw1/mgmt/data/policies?search=web&page=2&evil=1', VIEWER);
    assert.deepEqual(r.body.data.opts, { search: 'web', page: '2' });
    r = await call('get', '/fw1/mgmt/data/sessions?src=192.0.2.10&dport=443', VIEWER);
    assert.deepEqual(r.body.data.opts, { src: '192.0.2.10', dport: '443' });
});

test('test connection uses the stored token for the same target only', async () => {
    await call('put', '/fw1/mgmt', OP, cfg);
    assert.equal((await call('post', '/fw1/mgmt/test', VIEWER, cfg)).status, 403);
    let r = await call('post', '/fw1/mgmt/test', OP, { ...cfg, token: store.MASK });
    assert.equal(r.status, 200);
    assert.equal(r.body.facts.token, true);
    r = await call('post', '/fw1/mgmt/test', OP, { ...cfg, mgmtHost: '198.51.100.9', token: store.MASK });
    assert.equal(r.status, 400);
    assert.equal(readDataSync(store.KEY, {}).fw1.mgmtHost, '192.0.2.254', 'a test never saves');
});

test('device list carries the connection status; deleting the device removes the profile', async () => {
    await call('put', '/fw1/mgmt', OP, cfg);
    await call('get', '/fw1/mgmt/data/summary', VIEWER);
    const list = await call('get', '/devices', VIEWER);
    const fw = list.body.find(d => d.id === 'fw1');
    assert.equal(fw.mgmt.vendor, 'fortigate');
    assert.equal(fw.mgmt.lastStatus, 'ok');
    assert.equal(fw.mgmt.model, 'FGT60F');
    assert.equal(list.body.find(d => d.id === 'sw1').mgmt, null);

    assert.equal((await call('post', '/fw1/mgmt/backups', OP)).status, 200);
    const backups = require('../../lib/netDevices/backups');
    const dir = require('path').join(backups.rootDir(), 'fw1');
    assert.ok(require('fs').existsSync(dir));

    assert.equal((await call('delete', '/devices/fw1', OP)).status, 200);
    assert.equal(readDataSync(store.KEY, {}).fw1, undefined);
    assert.equal(backups.listBackups('fw1').backups.length, 0, 'backups go with the device');
    assert.equal(require('fs').existsSync(dir), false);
});

test('remove the connection', async () => {
    await call('put', '/fw2/mgmt', OP, cfg);
    assert.equal((await call('delete', '/fw2/mgmt', VIEWER)).status, 403);
    let r = await call('delete', '/fw2/mgmt', OP);
    assert.equal(r.body.removed, true);
    r = await call('get', '/fw2/mgmt', VIEWER);
    assert.equal(r.body.profile, null);
});

test('config backups: Operator runs and lists; only SuperAdmin views, diffs and downloads (audited)', async () => {
    await call('put', '/fw2/mgmt', OP, cfg);
    assert.equal((await call('get', '/fw2/mgmt/backups', VIEWER)).status, 403);
    assert.equal((await call('post', '/fw2/mgmt/backups', VIEWER)).status, 403);
    let r = await call('post', '/fw2/mgmt/backups', OP);
    assert.equal(r.status, 200);
    assert.equal(r.body.unchanged, false);
    const first = r.body.backup.id;
    assert.equal(r.body.backup.sha256, undefined);
    backupText = 'config system global\n    set hostname "x"\nend\n';
    await new Promise(res => setTimeout(res, 1100)); // backup ids have one-second resolution
    const second = (await call('post', '/fw2/mgmt/backups', OP)).body.backup.id;

    r = await call('get', '/fw2/mgmt/backups', OP);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.backups.map(b => b.id), [second, first]);
    assert.equal(r.body.canView, false);
    assert.equal(r.body.keep, 30);
    assert.ok(!JSON.stringify(r.body).includes('set hostname'));
    assert.equal((await call('get', '/fw2/mgmt/backups', SA)).body.canView, true);

    assert.equal((await call('get', `/fw2/mgmt/backups/${first}`, OP)).status, 403);
    assert.equal((await call('get', `/fw2/mgmt/backups/diff?from=${first}&to=${second}`, OP)).status, 403);
    assert.equal((await call('get', `/fw2/mgmt/backups/${first}/download`, OP)).status, 403);

    r = await call('get', `/fw2/mgmt/backups/${first}`, SA);
    assert.equal(r.body.content, 'config system global\nend\n');
    r = await call('get', `/fw2/mgmt/backups/diff?from=${first}&to=${second}`, SA);
    assert.equal(r.body.added, 1);
    r = await call('get', `/fw2/mgmt/backups/${second}/download`, SA);
    assert.equal(r.status, 200);
    assert.match(r.headers['content-disposition'], /attachment; filename="fw2_\d{8}T\d{6}Z\.conf"/);
    assert.match(r.text, /set hostname/);
    assert.equal((await call('get', '/fw2/mgmt/backups/20200101T000000Z', SA)).status, 404);
    assert.equal((await call('get', '/fw2/mgmt/backups/..%2F..%2Fx', SA)).status, 400);
    for (const what of ['Backed up configuration', 'Viewed configuration backup', 'Compared configuration backups', 'Downloaded configuration backup']) {
        assert.ok(audits.some(a => a[2].startsWith(what)), what);
    }
});
