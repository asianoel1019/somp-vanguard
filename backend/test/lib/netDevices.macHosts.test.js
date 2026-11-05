// Host names next to switch MAC tables: CMDB MACs in any notation, several per server, deleted servers left out,
// one-minute index, failures that never hide the table, and the registry adding them to MAC answers.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const dbMod = require('../../lib/db');
const cmdb = require('../../services/cmdbModel');
const macHosts = require('../../lib/netDevices/macHosts');
const store = require('../../lib/netDevices/profileStore');
const registry = require('../../lib/netDevices');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { macHosts._setSource(null); await dbManager.closeDB(); });
test.beforeEach(() => { macHosts._setSource(null); });

test('macsOf: any notation, several per field, junk skipped', () => {
    assert.deepEqual(macHosts.macsOf('00:00:5E:00:53:10, 0000.5e00.5311; 00-00-5e-00-53-12 bogus'), ['00:00:5e:00:53:10', '00:00:5e:00:53:11', '00:00:5e:00:53:12']);
    assert.deepEqual(macHosts.macsOf(''), []);
    assert.deepEqual(macHosts.macsOf(null), []);
});

test('annotate from a record source: hosts per MAC, at most three, cached', () => {
    let reads = 0;
    const records = [
        { ip: '192.0.2.11', hostname: 'lab-web01', mac: '00:00:5e:00:53:10' },
        { ip: '192.0.2.12', hostname: '', vmName: 'lab-vm02', mac: '0000.5e00.5311, 0000.5e00.5310' },
        ...['192.0.2.13', '192.0.2.14', '192.0.2.15'].map(ip => ({ ip, hostname: `vip-${ip.slice(-2)}`, mac: '00:00:5e:00:53:20' })),
    ];
    macHosts._setSource(() => { reads += 1; return records; });
    const rows = macHosts.annotate([
        { mac: '00:00:5e:00:53:10', vlan: 10, port: 'Gi1/0/1' },
        { mac: '00:00:5e:00:53:11', vlan: 10, port: 'Gi1/0/2' },
        { mac: '00:00:5e:00:53:20', vlan: 10, port: 'Po1' },
        { mac: '00:00:5e:00:53:99', vlan: 10, port: 'Gi1/0/3' },
    ]);
    assert.deepEqual(rows[0].hosts, [{ hostname: 'lab-web01', ip: '192.0.2.11' }, { hostname: 'lab-vm02', ip: '192.0.2.12' }]);
    assert.deepEqual(rows[1].hosts, [{ hostname: 'lab-vm02', ip: '192.0.2.12' }]);
    assert.equal(rows[2].hosts.length, 3);
    assert.deepEqual(rows[3].hosts, []);
    assert.equal(rows[0].port, 'Gi1/0/1', 'row fields kept');
    macHosts.annotate([]);
    assert.equal(reads, 1, 'index reused within a minute');
    macHosts.clear();
    macHosts.annotate([]);
    assert.equal(reads, 2);
});

test('a failing source leaves the table without names', () => {
    macHosts._setSource(() => { throw new Error('db down'); });
    const orig = console.error;
    console.error = () => {};
    try {
        assert.deepEqual(macHosts.annotate([{ mac: '00:00:5e:00:53:10' }]), [{ mac: '00:00:5e:00:53:10', hosts: [] }]);
    } finally { console.error = orig; }
});

test('CMDB source: servers with a MAC, deleted ones left out', () => {
    cmdb.upsertCmdbServer({ ip: '192.0.2.31', hostname: 'lab-mac-a', mac: '00:00:5e:00:53:31' }, 'SCANNER');
    cmdb.upsertCmdbServer({ ip: '192.0.2.32', hostname: 'lab-mac-b', mac: '00:00:5e:00:53:32' }, 'SCANNER');
    cmdb.upsertCmdbServer({ ip: '192.0.2.33', hostname: 'lab-no-mac' }, 'MANUAL');
    const meta = dbMod.readDataSync('server_operation/server_cmdb_meta.json', {}) || {};
    meta['192.0.2.32'] = { ...(meta['192.0.2.32'] || {}), deleted: true };
    dbMod.writeDataSync('server_operation/server_cmdb_meta.json', meta);
    const recs = cmdb.listMacRecords().filter(r => r.ip.startsWith('192.0.2.3'));
    assert.deepEqual(recs.map(r => [r.ip, r.hostname, r.mac]), [['192.0.2.31', 'lab-mac-a', '00:00:5e:00:53:31']]);
    const [row] = macHosts.annotate([{ mac: '00:00:5e:00:53:31' }]);
    assert.deepEqual(row.hosts, [{ hostname: 'lab-mac-a', ip: '192.0.2.31' }]);
});

test('registry adds hosts to MAC answers only', async () => {
    const real = registry._drivers['cisco-ios'];
    registry._drivers['cisco-ios'] = {
        capabilities: ['summary', 'mac'],
        getSummary: async () => ({ model: 'X' }),
        getMac: async () => ({ total: 1, truncated: false, perPortCount: { 'Gi1/0/1': 1 }, items: [{ mac: '00:00:5e:00:53:10', vlan: 10, port: 'Gi1/0/1', type: 'dynamic' }] }),
    };
    macHosts._setSource(() => [{ ip: '192.0.2.11', hostname: 'lab-web01', mac: '00:00:5e:00:53:10' }]);
    try {
        dbMod.writeDataSync(store.KEY, {});
        registry.clearCache();
        store.saveProfile('sw9', 'Switch', { vendor: 'cisco-ios', mgmtHost: '192.0.2.90', username: 'netro', password: 'pw-123456' }, 'a');
        const r = await registry.runCapability('sw9', 'mac');
        assert.deepEqual(r.data.items[0].hosts, [{ hostname: 'lab-web01', ip: '192.0.2.11' }]);
        assert.equal(r.data.total, 1);
        assert.equal((await registry.runCapability('sw9', 'summary')).data.hosts, undefined);
    } finally {
        registry._drivers['cisco-ios'] = real;
    }
});
