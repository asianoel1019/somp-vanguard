// Cisco IOS / IOS-XE show-command parsers against recorded-shape output (documentation addresses only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const p = require('../../lib/netDevices/parsers/ciscoIos');

const fx = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/cisco-ios', name), 'utf8');

test('interface names, MACs, VLAN lists', () => {
    assert.equal(p.shortIf('GigabitEthernet1/0/1'), 'Gi1/0/1');
    assert.equal(p.shortIf('TenGigabitEthernet1/1/1'), 'Te1/1/1');
    assert.equal(p.shortIf('Port-channel1'), 'Po1');
    assert.equal(p.shortIf('Gi1/0/1'), 'Gi1/0/1');
    assert.equal(p.ifKey('gigabitethernet1/0/1'), p.ifKey('Gi1/0/1'));
    for (const m of ['0000.5e00.5301', '00-00-5E-00-53-01', '00:00:5e:00:53:01', '00005e005301']) assert.equal(p.normalizeMac(m), '00:00:5e:00:53:01');
    assert.equal(p.normalizeMac('0000.5e00'), null);
    assert.deepEqual(p.expandVlanList('1,10-12, 20'), [1, 10, 11, 12, 20]);
    assert.deepEqual(p.expandVlanList('none'), []);
    assert.deepEqual(p.expandVlanList('5-1,0,4095'), []);
});

test('show version: IOS-XE stack and classic IOS', () => {
    const xe = p.parseVersion(fx('show_version_9300.txt'));
    assert.deepEqual([xe.model, xe.hostname, xe.version, xe.serial], ['C9300-48P', 'sw-lab-core', '17.09.04a', 'FOC0000LAB1']);
    assert.equal(xe.uptime, '12 weeks, 3 days, 4 hours, 5 minutes');
    assert.deepEqual(xe.members.map(m => [m.slot, m.role, m.serial]), [[1, 'active', 'FOC0000LAB1'], [2, 'member', 'FOC0000LAB2']]);
    const ios = p.parseVersion(fx('show_version_2960.txt'));
    assert.deepEqual([ios.model, ios.hostname, ios.version, ios.serial], ['WS-C2960X-24TS-L', 'sw-lab-acc2', '15.2(7)E4', 'FOC1111LAB3']);
    assert.equal(ios.members.length, 1);
});

test('show inventory', () => {
    const inv = p.parseInventory(fx('show_inventory.txt'));
    assert.deepEqual(inv.find(x => x.name === 'Switch 2'), { name: 'Switch 2', descr: 'C9300-48P', pid: 'C9300-48P', serial: 'FOC0000LAB2' });
    assert.equal(inv.length, 4);
});

test('show interfaces: status, counters, rates', () => {
    const by = Object.fromEntries(p.parseInterfaces(fx('show_interfaces.txt')).map(i => [i.name, i]));
    const g1 = by['GigabitEthernet1/0/1'];
    assert.equal(g1.status, 'up');
    assert.equal(g1.alias, 'srv-web-01 eth0');
    assert.deepEqual([g1.speed, g1.duplex, g1.mtu], [1000, 'full', 1500]);
    assert.deepEqual([g1.inErrors, g1.crcErrors, g1.outErrors, g1.inDiscards, g1.outDiscards], [5, 3, 2, 12, 7]);
    assert.deepEqual([g1.rxBytes, g1.txBytes, g1.rxBps, g1.txBps, g1.rateInterval], [98765432, 87654321, 12000, 34000, 300]);
    assert.equal(by['GigabitEthernet1/0/3'].rateInterval, 30);
    assert.equal(by['GigabitEthernet1/0/4'].status, 'err-disabled');
    assert.equal(by['GigabitEthernet1/0/4'].crcErrors, 118);
    assert.equal(by['GigabitEthernet1/0/5'].status, 'admin-down');
    assert.equal(by['TenGigabitEthernet1/1/1'].status, 'down');
    assert.equal(by['TenGigabitEthernet1/1/1'].speed, 10000);
    assert.equal(by['GigabitEthernet1/0/4'].speed, null, 'auto speed while down');
    assert.equal(by.Vlan10.ip, '192.0.2.1/24');
    assert.equal(by.Vlan10.mac, '00:00:5e:00:53:01');
    assert.equal(by['GigabitEthernet1/0/48'].ip, '198.51.100.2/30');
});

test('show interfaces status: fixed columns, names with spaces, modes', () => {
    const s = p.parseInterfacesStatus(fx('show_interfaces_status.txt'));
    assert.deepEqual(s['gi1/0/1'], { port: 'Gi1/0/1', alias: 'srv-web-01 eth0', status: 'connected', mode: 'access', vlan: 10, duplex: 'full', speed: '1000', type: '10/100/1000BaseTX' });
    assert.equal(s['gi1/0/2'].alias, '');
    assert.equal(s['gi1/0/3'].mode, 'trunk');
    assert.equal(s['gi1/0/3'].vlan, null);
    assert.equal(s['gi1/0/4'].status, 'err-disabled');
    assert.equal(s['gi1/0/48'].mode, 'routed');
    assert.equal(s['te1/1/1'].speed, '10G');
});

test('show interfaces trunk: native VLAN and wrapped allowed lists', () => {
    const t = p.parseTrunk(fx('show_interfaces_trunk.txt'));
    assert.equal(t['gi1/0/3'].native, 1);
    assert.equal(t['gi1/0/3'].allowed.length, 4094);
    assert.deepEqual(t['gi1/0/3'].active, [1, 10, 20, 30]);
    assert.equal(t['po1'].native, 99);
    assert.ok(t['po1'].allowed.includes(219) && t['po1'].allowed.includes(220), 'continuation line joined');
    assert.deepEqual(t['po1'].forwarding, [10, 20]);
});

test('show vlan brief: wrapped port lists, legacy VLANs left out', () => {
    const v = p.parseVlanBrief(fx('show_vlan_brief.txt'));
    assert.deepEqual(v.map(x => x.id), [1, 10, 20, 30, 99]);
    assert.deepEqual(v.find(x => x.id === 20).accessPorts, ['Gi1/0/4', 'Gi1/0/6', 'Gi1/0/7', 'Gi1/0/8', 'Gi1/0/9', 'Gi1/0/10']);
    assert.equal(v.find(x => x.id === 30).status, 'act/lshut');
    assert.deepEqual(v.find(x => x.id === 30).accessPorts, []);
    assert.equal(v.find(x => x.id === 99).status, 'suspended');
});

test('show mac address-table: CPU entries skipped, types, normalized MACs', () => {
    const m = p.parseMacTable(fx('show_mac_address_table.txt'));
    assert.equal(m.length, 6);
    assert.deepEqual(m[0], { mac: '00:00:5e:00:53:10', vlan: 10, port: 'Gi1/0/1', type: 'dynamic' });
    assert.equal(m.find(x => x.port === 'Gi1/0/4').type, 'static');
    assert.equal(m.filter(x => x.port === 'Gi1/0/3').length, 3);
});

test('running-config: volatile lines removed', () => {
    const c = p.cleanConfig(fx('show_running_config.txt'));
    assert.ok(!/Last configuration change|NVRAM config|ntp clock-period|Building configuration|Current configuration/.test(c));
    assert.match(c, /^!\n/);
    assert.match(c, /hostname sw-lab-core/);
    assert.match(c, /end\n$/);
});
