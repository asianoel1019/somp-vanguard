// Cisco NX-OS parsers against recorded `| json` / NX-API bodies (documentation IPs / MACs only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const nx = require('../../lib/netDevices/parsers/nxos');

const raw = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/cisco-nxos', name), 'utf8');
const fx = (name) => JSON.parse(raw(name));

test('rows, short names, port ranges, speeds', () => {
    assert.deepEqual(nx.rows({ TABLE_x: { ROW_x: { a: 1 } } }, 'x'), [{ a: 1 }], 'a single ROW is an object');
    assert.deepEqual(nx.rows({ TABLE_x: [{ ROW_x: [{ a: 1 }] }, { ROW_x: { a: 2 } }] }, 'x'), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(nx.rows({}, 'x'), []);
    assert.equal(nx.shortIf('Ethernet1/1'), 'Eth1/1');
    assert.equal(nx.shortIf('port-channel10'), 'Po10');
    assert.equal(nx.shortIf('Eth1/2'), 'Eth1/2');
    assert.equal(nx.shortIf('mgmt0'), 'mgmt0');
    assert.equal(nx.ifKey('Ethernet1/49'), nx.ifKey('eth1/49'));
    assert.deepEqual(nx.expandPorts('Ethernet1/5-7,port-channel10,Ethernet101/1/1'), ['Eth1/5', 'Eth1/6', 'Eth1/7', 'Po10', 'Eth101/1/1']);
    assert.deepEqual(nx.expandPorts(''), []);
    assert.equal(nx.speedOf('10 Gb/s'), 10000);
    assert.equal(nx.speedOf('auto-speed'), null);
});

test('summary: model, version, serial, uptime, CPU, memory', () => {
    const s = nx.parseSummary({ version: fx('show_version.json'), inventory: fx('show_inventory.json'), resources: fx('show_system_resources.json') });
    assert.deepEqual([s.model, s.hostname, s.version, s.serial], ['N9K-C93180YC-EX', 'nx-lab-leaf1', '9.3(10)', 'FDO0000LAB0']);
    assert.equal(s.uptime, '41 days, 3 hours, 15 minutes');
    assert.deepEqual([s.cpu, s.memory], [6, 30]);
    assert.deepEqual(s.members, [], 'one slot is not a list of members');
    const bare = nx.parseSummary({ version: fx('show_version.json'), inventory: null, resources: null });
    assert.deepEqual([bare.model, bare.serial, bare.cpu, bare.memory], ['Nexus9000 C93180YC-EX', 'FDO0000LAB1', null, null]);
    const modular = nx.parseSummary({ version: fx('show_version.json'), inventory: fx('show_inventory_modular.json') });
    assert.deepEqual(modular.members.map(m => [m.slot, m.serial]), [[1, 'FOC0000LC01'], [2, 'FOC0000LC02']]);
    assert.equal(modular.model, 'N9K-C9508');
});

test('interfaces: status, mode, VLAN, counters, rates', () => {
    const list = nx.parseInterfaces(fx('show_interface.json'), fx('show_interface_status.json'), fx('show_interface_trunk.json'));
    const by = Object.fromEntries(list.map(i => [i.shortName, i]));
    const e1 = by['Eth1/1'];
    assert.deepEqual([e1.status, e1.mode, e1.vlan, e1.speed, e1.duplex, e1.alias], ['up', 'access', 10, 10000, 'full', 'lab host 1']);
    assert.deepEqual([e1.inErrors, e1.crcErrors, e1.outErrors, e1.outDiscards], [4, 2, 0, 7]);
    assert.deepEqual([e1.rxBps, e1.txBps, e1.rateInterval, e1.rxBytes], [2500000, 1200000, 30, 987654321]);
    assert.equal(e1.mac, '00:00:5e:00:53:b1');
    assert.deepEqual([by['Eth1/2'].status, by['Eth1/2'].vlan, by['Eth1/2'].speed], ['down', 20, 10000]);
    assert.equal(by['Eth1/3'].status, 'err-disabled');
    assert.equal(by['Eth1/4'].status, 'admin-down');
    assert.deepEqual([by['Eth1/49'].mode, by['Eth1/49'].vlan, by['Eth1/49'].trunkVlans], ['trunk', 1, 5]);
    assert.deepEqual([by.Po10.mode, by.Po10.vlan, by.Po10.trunkVlans], ['trunk', 99, null]);
    assert.deepEqual([by['Eth1/50'].mode, by['Eth1/50'].ip], ['routed', '198.51.100.5/30']);
    assert.deepEqual([by.Vlan10.status, by.Vlan10.ip, by.Vlan10.alias, by.Vlan10.mode], ['up', '192.0.2.1/24', 'lab users', 'routed']);
    assert.equal(by.mgmt0.ip, '192.0.2.50/24');
    // without status / trunk answers the mode still comes from show interface
    const bare = Object.fromEntries(nx.parseInterfaces(fx('show_interface.json'), null, null).map(i => [i.shortName, i]));
    assert.deepEqual([bare['Eth1/1'].mode, bare['Eth1/1'].vlan, bare['Eth1/49'].mode], ['access', null, 'trunk']);
    assert.deepEqual(nx.parseInterfaces({}, null, null), []);
});

test('VLANs: ranges expanded, trunks listed once, legacy skipped, shutdown state', () => {
    const v = Object.fromEntries(nx.parseVlans(fx('show_vlan_brief.json'), fx('show_interface_trunk.json')).map(x => [x.id, x]));
    assert.deepEqual(Object.keys(v).map(Number), [1, 10, 20, 30, 99]);
    assert.deepEqual(v[10].accessPorts, ['Eth1/1', 'Eth1/3', 'Eth1/5', 'Eth1/6', 'Eth1/7']);
    assert.deepEqual(v[10].trunkPorts, ['Eth1/49', 'Po10']);
    assert.deepEqual(v[99].trunkPorts, ['Po10'], 'Eth1/49 does not allow 99; Po10 allows all');
    assert.equal(v[30].status, 'shutdown');
    assert.deepEqual(v[1].accessPorts, ['Eth1/4']);
    assert.deepEqual(nx.parseVlans(fx('show_vlan_brief.json'), null)[1].accessPorts.length, 7, 'without trunk info every port is listed');
});

test('MAC table: gateway / supervisor entries skipped', () => {
    const rows = nx.parseMac(fx('show_mac_address_table.json'));
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0], { mac: '00:00:5e:00:53:10', vlan: 10, port: 'Eth1/1', type: 'dynamic' });
    assert.deepEqual(rows[4], { mac: '00:00:5e:00:53:30', vlan: 20, port: 'Po10', type: 'static' });
    assert.deepEqual(nx.parseMac({}), []);
});

test('config: time stamp lines removed', () => {
    const c = nx.cleanConfig(raw('show_running_config.txt'));
    assert.ok(!/!Time:|last done at/.test(c));
    assert.ok(c.startsWith('!Command: show running-config'));
    assert.match(c, /^hostname nx-lab-leaf1$/m);
    assert.equal(nx.cleanConfig(raw('show_running_config.txt').replace('08:30:00', '09:45:12')), c);
});
