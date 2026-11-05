// Driver registry: not-configured / unsupported answers, 30 s cache, one request at a time, status recorded.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbMod = require('../../lib/db');
const dbManager = require('../../services/db');
const store = require('../../lib/netDevices/profileStore');
const registry = require('../../lib/netDevices');

const real = registry._drivers.fortigate;
let calls = 0;
let fail = null;
const fake = {
    capabilities: ['summary', 'interfaces'],
    testConnection: async () => ({ model: 'X' }),
    getSummary: async () => { calls += 1; await new Promise(r => setTimeout(r, 20)); if (fail) throw fail; return { model: 'FGT60F', version: 'v7.4.3', cpu: 5 }; },
    getInterfaces: async () => { calls += 1; return []; },
};

test.before(async () => { await dbManager.initDB(); registry._drivers.fortigate = fake; });
test.after(async () => { registry._drivers.fortigate = real; await dbManager.closeDB(); });
test.beforeEach(() => {
    dbMod.writeDataSync(store.KEY, {});
    registry.clearCache();
    calls = 0;
    fail = null;
    store.saveProfile('d1', 'Firewall', { vendor: 'fortigate', mgmtHost: '192.0.2.1', token: 'tok-123456' }, 'a');
});

test('drivers get a context that remembers the working transport', async () => {
    const orig = fake.getInterfaces;
    fake.getInterfaces = async (profile, opts, ctx) => { ctx.setTransport('ssh'); return []; };
    try {
        await registry.runCapability('d1', 'interfaces');
        assert.equal(store.getProfile('d1').lastTransport, 'ssh');
    } finally { fake.getInterfaces = orig; }
});

test('vendor list by device type', () => {
    const fw = registry.vendorList('Firewall');
    assert.deepEqual(fw.map(v => v.id), ['fortigate', 'paloalto', 'checkpoint']);
    assert.equal(fw[0].available, true);
    assert.equal(fw[1].available, true);
    assert.equal(fw[2].available, true);
    assert.deepEqual(registry.capabilitiesOf('checkpoint'), ['summary', 'interfaces', 'policies', 'ha']);
    assert.deepEqual(registry.vendorList('Switch').map(v => [v.id, v.available]), [['cisco-ios', true], ['cisco-nxos', true], ['juniper', true]]);
    assert.deepEqual(registry.vendorList('Router').map(v => v.id), ['cisco-ios', 'juniper']);
    assert.equal(registry.vendorList('Router').find(v => v.id === 'juniper').defaultPort, 3443);
    assert.deepEqual(registry.capabilitiesOf('cisco-nxos'), ['summary', 'interfaces', 'vlans', 'mac']);
    assert.equal(registry.canBackup('cisco-nxos'), true);
    assert.deepEqual(registry.capabilitiesOf('cisco-ios'), ['summary', 'interfaces', 'vlans', 'mac']);
    assert.equal(registry.canBackup('cisco-ios'), true);
    assert.deepEqual(registry.vendorList('LoadBalancer').map(v => [v.id, v.available, v.scope, v.loginProvider]), [['f5', true, 'partition', true]]);
    assert.deepEqual(registry.capabilitiesOf('f5'), ['summary', 'ha', 'virtuals', 'pools', 'certs']);
    assert.equal(registry.canBackup('f5'), true);
});

test('unknown device, disabled profile, unsupported capability', async () => {
    await assert.rejects(registry.runCapability('nope', 'summary'), (e) => e.code === 'NOT_CONFIGURED' && e.status === 409);
    await assert.rejects(registry.runCapability('d1', 'bogus'), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(registry.runCapability('d1', 'routes'), (e) => e.code === 'UNSUPPORTED');
    store.saveProfile('d1', 'Firewall', { vendor: 'fortigate', mgmtHost: '192.0.2.1', token: store.MASK, enabled: false }, 'a');
    await assert.rejects(registry.runCapability('d1', 'summary'), (e) => e.code === 'NOT_CONFIGURED');
});

test('answers are cached; refresh bypasses; concurrent calls share one request', async () => {
    const [a, b] = await Promise.all([registry.runCapability('d1', 'summary'), registry.runCapability('d1', 'summary')]);
    assert.equal(calls, 1);
    assert.equal(a, b);
    const c = await registry.runCapability('d1', 'summary');
    assert.equal(c.fromCache, true);
    assert.equal(calls, 1);
    await registry.runCapability('d1', 'summary', {}, { refresh: true });
    assert.equal(calls, 2);
    registry.clearCache('d1');
    await registry.runCapability('d1', 'summary');
    assert.equal(calls, 3);
});

test('status and facts are recorded', async () => {
    await registry.runCapability('d1', 'summary');
    let s = store.listSummaries().d1;
    assert.equal(s.lastStatus, 'ok');
    assert.equal(s.model, 'FGT60F');
    fail = Object.assign(new Error('The device did not answer'), { code: 'UNREACHABLE' });
    await assert.rejects(registry.runCapability('d1', 'summary', {}, { refresh: true }));
    s = store.listSummaries().d1;
    assert.equal(s.lastStatus, 'error');
    assert.equal(s.model, 'FGT60F', 'facts of the last good read stay');
});
