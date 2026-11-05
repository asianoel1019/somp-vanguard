// f5 driver with the HTTPS transport stubbed: reads only (GET after the login), partition filter, optional
// answers, virtual server filters, connection test without a cached token.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const httpClient = require('../../lib/netDevices/httpClient');
const f5Session = require('../../lib/netDevices/f5Session');
const driver = require('../../lib/netDevices/drivers/f5');

const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/f5', name), 'utf8'));
const ANSWERS = {
    '/mgmt/tm/sys/global-settings': fx('global_settings.json'),
    '/mgmt/tm/sys/version': fx('version.json'),
    '/mgmt/tm/sys/hardware': fx('hardware.json'),
    '/mgmt/tm/sys/host-info': fx('host_info.json'),
    '/mgmt/tm/cm/failover-status': fx('failover_status.json'),
    '/mgmt/tm/cm/sync-status': fx('sync_status.json'),
    '/mgmt/tm/cm/device': fx('devices.json'),
    '/mgmt/tm/ltm/virtual': fx('virtuals.json'),
    '/mgmt/tm/ltm/virtual/stats': fx('virtual_stats.json'),
    '/mgmt/tm/ltm/pool': fx('pools.json'),
    '/mgmt/tm/ltm/pool/stats': fx('pool_stats.json'),
    '/mgmt/tm/ltm/pool/~Common~pool_web/members': fx('pool_web_members.json'),
    '/mgmt/tm/ltm/pool/~Common~pool_web/members/stats': fx('pool_web_member_stats.json'),
    '/mgmt/tm/sys/file/ssl-cert': fx('ssl_certs.json'),
};
let calls = [];
let fail = {};
let logins = 0;

test.beforeEach(() => {
    f5Session._reset();
    calls = [];
    fail = {};
    logins = 0;
    httpClient.setTransportForTest(async (config) => {
        const p = config.url.replace(/^https:\/\/[^/]+/, '');
        calls.push({ method: config.method, path: p, params: config.params });
        if (p === '/mgmt/shared/authn/login') { logins += 1; return { status: 200, data: { token: { token: `TOK${logins}`, timeout: 1200 } } }; }
        if (fail[p]) throw Object.assign(new Error(String(fail[p])), { response: { status: fail[p] } });
        if (!ANSWERS[p]) throw Object.assign(new Error('404'), { response: { status: 404 } });
        return { status: 200, data: ANSWERS[p] };
    });
});
test.after(() => { httpClient.setTransportForTest(null); f5Session._reset(); });

const profile = { vendor: 'f5', mgmtHost: '192.0.2.80', port: 443, username: 'auditor1', loginProvider: 'tmos', scope: '', secrets: { password: 'pw-123456' } };

test('only GET requests after the login', async () => {
    await driver.getSummary(profile);
    await driver.getHa(profile);
    await driver.getVirtuals(profile);
    assert.equal(calls[0].path, '/mgmt/shared/authn/login');
    assert.ok(calls.slice(1).every(c => c.method === 'GET'), JSON.stringify(calls.map(c => c.method)));
    assert.ok(!calls.some(c => /util\/bash/.test(c.path)));
    assert.equal(logins, 1, 'one token for all reads');
});

test('summary, HA', async () => {
    const s = await driver.getSummary(profile);
    assert.deepEqual([s.model, s.hostname, s.version, s.build, s.cpu, s.memory], ['BIG-IP i5800', 'bigip-lab-01.example.test', '16.1.4', '0.0.4', 15, 38]);
    assert.equal(s.partition, undefined);
    fail['/mgmt/tm/sys/host-info'] = 403;
    fail['/mgmt/tm/sys/hardware'] = 404;
    const bare = await driver.getSummary({ ...profile, scope: 'Tenant_A' });
    assert.deepEqual([bare.cpu, bare.serial, bare.partition], [null, null, 'Tenant_A']);
    const h = await driver.getHa(profile);
    assert.deepEqual([h.mode, h.group, h.syncStatus, h.members.length], ['active', 'dg-lab-failover', 'In Sync', 2]);
    fail['/mgmt/tm/cm/failover-status'] = 401;
    await assert.rejects(driver.getHa(profile), (e) => e.code === 'AUTH');
});

test('virtual servers: $select, partition filter, search, non-green', async () => {
    let r = await driver.getVirtuals(profile, {});
    const cfg = calls.find(c => c.path === '/mgmt/tm/ltm/virtual');
    assert.match(cfg.params.$select, /destination/);
    assert.equal(cfg.params.$filter, undefined);
    assert.deepEqual([r.total, r.statsAvailable], [6, true]);
    calls = [];
    r = await driver.getVirtuals({ ...profile, scope: 'Tenant_A' }, {});
    assert.equal(calls.find(c => c.path === '/mgmt/tm/ltm/virtual').params.$filter, 'partition eq Tenant_A');
    assert.deepEqual(r.items.map(v => v.name), ['vs_rd']);
    r = await driver.getVirtuals(profile, { search: '192.0.2.1' });
    assert.deepEqual(r.items.map(v => v.name), ['vs_api', 'vs_old', 'vs_web']);
    r = await driver.getVirtuals(profile, { search: 'pool_web' });
    assert.deepEqual(r.items.map(v => v.name), ['vs_v6', 'vs_web']);
    r = await driver.getVirtuals(profile, { nonGreen: 'true' });
    assert.ok(r.items.every(v => v.status !== 'green'));
    assert.equal(r.total, 5);
    await assert.rejects(driver.getVirtuals(profile, { search: 'x;y' }), (e) => e.code === 'BAD_REQUEST');
    fail['/mgmt/tm/ltm/virtual/stats'] = 403;
    r = await driver.getVirtuals(profile, {});
    assert.equal(r.statsAvailable, false);
    fail['/mgmt/tm/ltm/virtual'] = 404;
    await assert.rejects(driver.getVirtuals(profile, {}), (e) => e.code === 'UNSUPPORTED');
});

test('connection test: facts, no cached token', async () => {
    const t = await driver.testConnection(profile);
    assert.deepEqual(t, { model: 'BIG-IP i5800', hostname: 'bigip-lab-01.example.test', version: '16.1.4', serial: 'f5-lab0-0001' });
    assert.equal(f5Session._size(), 0);
    await assert.rejects(driver.testConnection({ ...profile, secrets: {} }), (e) => e.code === 'NOT_CONFIGURED');
});

test('pools: list with members expanded, one pool opened on demand', async () => {
    let r = await driver.getPools(profile, {});
    const cfg = calls.find(c => c.path === '/mgmt/tm/ltm/pool');
    assert.equal(cfg.params.expandSubcollections, 'true');
    assert.match(cfg.params.$select, /membersReference/);
    assert.ok(!calls.some(c => c.path.includes('/members')), 'no member reads for the list');
    assert.deepEqual([r.total, r.statsAvailable], [4, true]);
    r = await driver.getPools(profile, { nonGreen: '1', search: 'pool_' });
    assert.deepEqual(r.items.map(p => p.name), ['pool_api', 'pool_empty']);
    r = await driver.getPools({ ...profile, scope: 'Tenant_A' }, {});
    assert.deepEqual(r.items.map(p => p.name), ['pool_rd']);

    calls = [];
    const m = await driver.getPools(profile, { pool: '/Common/pool_web' });
    assert.deepEqual(calls.map(c => c.path).filter(p => p !== '/mgmt/shared/authn/login'), ['/mgmt/tm/ltm/pool/~Common~pool_web/members', '/mgmt/tm/ltm/pool/~Common~pool_web/members/stats']);
    assert.equal(m.pool, '/Common/pool_web');
    assert.deepEqual(m.members.map(x => [x.address, x.status, x.session]), [['192.0.2.21', 'green', 'enabled'], ['192.0.2.22', 'red', 'enabled'], ['192.0.2.23', 'gray', 'disabled'], ['192.0.2.24', 'gray', 'forced-offline']]);
    for (const bad of ['Common/pool_web', '/Common/../x', '/Common/pool web', '/Common/a/b/c/d']) {
        await assert.rejects(driver.getPools(profile, { pool: bad }), (e) => e.code === 'BAD_REQUEST', bad);
    }
    await assert.rejects(driver.getPools({ ...profile, scope: 'Tenant_A' }, { pool: '/Common/pool_web' }), (e) => e.code === 'BAD_REQUEST' && /partition/.test(e.message));
    await assert.rejects(driver.getPools(profile, { pool: '/Common/pool_missing' }), (e) => e.code === 'UNSUPPORTED');
});

test('certificates: expiring filter leaves bundles out, partition', async () => {
    let r = await driver.getCerts(profile, {});
    assert.equal(r.total, 4);
    assert.equal(r.warnDays, 30);
    assert.equal(r.expiring, 2);
    assert.match(calls.find(c => c.path === '/mgmt/tm/sys/file/ssl-cert').params.$select, /expirationDate/);
    r = await driver.getCerts(profile, { expiringOnly: 'true' });
    assert.deepEqual(r.items.map(c => c.name).sort(), ['api.example.test.crt', 'old.example.test.crt']);
    r = await driver.getCerts({ ...profile, scope: 'Tenant_A' }, {});
    assert.deepEqual(r.items.map(c => c.name), ['old.example.test.crt']);
});

test('config snapshot: stable JSON without volatile fields, skipped collections listed', async () => {
    const nodes = { items: [
        { kind: 'tm:ltm:node:nodestate', name: '192.0.2.21', partition: 'Common', fullPath: '/Common/192.0.2.21', selfLink: 'https://localhost/mgmt/tm/ltm/node/~Common~192.0.2.21?ver=16.1.4', generation: 7, address: '192.0.2.21', session: 'monitor-enabled', state: 'up', monitor: 'default' },
        { name: '192.0.2.24', partition: 'Common', fullPath: '/Common/192.0.2.24', address: '192.0.2.24', session: 'user-disabled', state: 'user-down' },
    ] };
    ANSWERS['/mgmt/tm/ltm/node'] = nodes;
    ANSWERS['/mgmt/tm/net/vlan'] = { items: [{ name: 'external', partition: 'Common', fullPath: '/Common/external', tag: 100, interfacesReference: { link: 'https://localhost/mgmt/tm/net/vlan/~Common~external/interfaces?ver=16.1.4', isSubcollection: true } }] };
    fail['/mgmt/tm/ltm/rule'] = 403;
    try {
        const b = await driver.backupConfig(profile);
        assert.equal(b.format, 'json');
        const snap = JSON.parse(b.content);
        assert.equal(snap.partition, 'all');
        assert.deepEqual(Object.keys(snap.objects), ['ltm/virtual', 'ltm/pool', 'ltm/node', 'net/vlan']);
        assert.ok(snap._skipped.includes('ltm/rule: FORBIDDEN'));
        assert.ok(snap._skipped.includes('ltm/monitor/http: UNSUPPORTED'));
        assert.ok(!/selfLink|"generation"|"kind"|\?ver=/.test(b.content), 'no volatile fields');
        assert.deepEqual(snap.objects['ltm/node'].map(n => n.state), [undefined, 'user-down'], 'monitor result dropped, forced offline kept');
        assert.deepEqual(Object.keys(snap.objects['net/vlan'][0]), ['fullPath', 'name', 'partition', 'tag']);
        const web = snap.objects['ltm/pool'].find(p => p.name === 'pool_web');
        assert.deepEqual(web.membersReference.items.map(m => m.state), [undefined, undefined, undefined, 'user-down']);
        assert.ok(calls.filter(c => c.path.startsWith('/mgmt/tm/')).every(c => c.method === 'GET'));
        assert.equal(calls.find(c => c.path === '/mgmt/tm/ltm/pool' && c.params.expandSubcollections).params.expandSubcollections, 'true');
        // the same configuration gives the same file (no time stamps): the backup store keeps one copy
        nodes.items[0].state = 'down';
        nodes.items[0].generation = 8;
        assert.equal((await driver.backupConfig(profile)).content, b.content);
        // partition filter on every collection
        calls = [];
        await driver.backupConfig({ ...profile, scope: 'Tenant_A' });
        assert.ok(calls.filter(c => c.path.startsWith('/mgmt/tm/')).every(c => c.params.$filter === 'partition eq Tenant_A'));
        // a wrong password stops the backup; nothing readable fails
        fail['/mgmt/tm/ltm/virtual'] = 401;
        await assert.rejects(driver.backupConfig(profile), (e) => e.code === 'AUTH');
        for (const [name] of driver.SNAPSHOT) fail[`/mgmt/tm/${name}`] = 403;
        await assert.rejects(driver.backupConfig(profile), (e) => e.code === 'OTHER' && /No configuration/.test(e.message));
    } finally {
        delete ANSWERS['/mgmt/tm/ltm/node'];
        delete ANSWERS['/mgmt/tm/net/vlan'];
    }
});
