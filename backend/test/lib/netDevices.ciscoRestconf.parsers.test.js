// Cisco IOS-XE RESTCONF parsers against recorded YANG JSON answers (documentation IPs / MACs only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const r = require('../../lib/netDevices/parsers/ciscoRestconf');

const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/cisco-restconf', name), 'utf8'));

test('leaf accepts module-prefixed and plain names', () => {
    assert.equal(r.leaf({ 'Cisco-IOS-XE-switch:mode': 1 }, 'mode'), 1);
    assert.equal(r.leaf({ mode: 2 }, 'mode'), 2);
    assert.equal(r.leaf(null, 'mode'), undefined);
    assert.equal(r.cidr('192.0.2.1', '255.255.255.0'), '192.0.2.1/24');
    assert.equal(r.cidr('0.0.0.0', '0.0.0.0'), null);
    assert.equal(r.versionOf('Cisco IOS XE Software, Version 17.09.04a\nmore'), '17.09.04a');
    assert.equal(r.uptimeText('2026-11-01T00:00:00Z', '2026-11-03T05:07:00Z'), '2 days, 5 hours, 7 minutes');
});

test('summary: model, version, uptime, CPU, memory, stack members', () => {
    const s = r.parseSummary({ hardware: fx('device_hardware.json'), hostname: fx('hostname.json'), cpu: fx('cpu.json'), memory: fx('memory.json'), stack: fx('stack.json') });
    assert.deepEqual([s.model, s.hostname, s.version, s.serial], ['C9300-48P', 'sw-lab-core', '17.09.04a', 'FOC0000LAB1']);
    assert.equal(s.uptime, '33 days, 2 hours, 30 minutes');
    assert.equal(s.cpu, 6);
    assert.equal(s.memory, 35);
    assert.deepEqual(s.members.map(m => [m.slot, m.serial, m.role]), [[1, 'FOC0000LAB1', 'active'], [2, 'FOC0000LAB2', 'standby']]);
    // without the optional answers: members come from the chassis inventory, the rest stays empty
    const bare = r.parseSummary({ hardware: fx('device_hardware.json'), hostname: null, cpu: null, memory: null, stack: null });
    assert.deepEqual([bare.hostname, bare.cpu, bare.memory], [null, null, null]);
    assert.deepEqual(bare.members.map(m => [m.slot, m.serial, m.role]), [[1, 'FOC0000LAB1', null], [2, 'FOC0000LAB2', null]]);
    assert.deepEqual(r.parseSummary({ hardware: {} }).members, []);
});

test('switchport settings from the native configuration', () => {
    const sp = r.parseSwitchport(fx('native_interface.json'));
    assert.deepEqual(sp['gi1/0/1'], { port: 'Gi1/0/1', mode: 'access', vlan: 10, allowed: null, ip: null });
    assert.deepEqual(sp['gi1/0/3'].allowed, [1, 10, 20, 21, 30]);
    assert.deepEqual([sp['gi1/0/3'].mode, sp['gi1/0/3'].vlan], ['trunk', 1]);
    assert.deepEqual([sp.po1.mode, sp.po1.vlan, sp.po1.allowed], ['trunk', 99, null]);
    assert.deepEqual([sp['gi1/0/48'].mode, sp['gi1/0/48'].ip], ['routed', '198.51.100.1/30']);
    assert.equal(sp['gi1/0/4'].mode, null);
    assert.equal(sp.vl10.mode, 'routed');
});

test('interfaces: status, counters, rates, merged switchport', () => {
    const sp = r.parseSwitchport(fx('native_interface.json'));
    const by = Object.fromEntries(r.parseInterfaces(fx('interfaces.json'), sp).map(i => [i.shortName, i]));
    const g1 = by['Gi1/0/1'];
    assert.deepEqual([g1.status, g1.mode, g1.vlan, g1.speed, g1.duplex, g1.alias], ['up', 'access', 10, 1000, 'full', 'lab host 1']);
    assert.deepEqual([g1.inErrors, g1.crcErrors, g1.outErrors, g1.outDiscards], [5, 3, 0, 2]);
    assert.deepEqual([g1.rxBps, g1.txBps, g1.rateInterval, g1.rxBytes], [1250000, 800000, 300, 123456789]);
    assert.equal(g1.mac, '00:00:5e:00:53:a1');
    assert.deepEqual([by['Gi1/0/3'].mode, by['Gi1/0/3'].trunkVlans], ['trunk', 5]);
    assert.equal(by['Gi1/0/4'].status, 'admin-down');
    assert.deepEqual([by['Gi1/0/5'].status, by['Gi1/0/5'].speed, by['Gi1/0/5'].duplex], ['down', 10, 'half']);
    assert.deepEqual([by['Gi1/0/48'].mode, by['Gi1/0/48'].ip], ['routed', '198.51.100.1/30']);
    assert.deepEqual([by.Po1.mode, by.Po1.vlan], ['trunk', 99]);
    assert.equal(by.Vl10.ip, '192.0.2.1/24');
    assert.equal(by['Gi1/0/4'].rateInterval, null);
    // without the configuration: only ports with an IP get a mode
    const bare = Object.fromEntries(r.parseInterfaces(fx('interfaces.json'), null).map(i => [i.shortName, i]));
    assert.deepEqual([bare['Gi1/0/1'].mode, bare['Gi1/0/1'].vlan, bare['Gi1/0/48'].mode], [null, null, 'routed']);
    assert.deepEqual(r.parseInterfaces({}, null), []);
});

test('VLANs: access members, trunks allowing each VLAN, legacy VLANs skipped', () => {
    const sp = r.parseSwitchport(fx('native_interface.json'));
    const v = Object.fromEntries(r.parseVlans(fx('vlans.json'), sp).map(x => [x.id, x]));
    assert.deepEqual(Object.keys(v).map(Number), [1, 10, 20, 30, 99]);
    assert.deepEqual(v[10].accessPorts, ['Gi1/0/1', 'Gi1/0/2']);
    assert.deepEqual(v[10].trunkPorts, ['Gi1/0/3', 'Po1']);
    assert.deepEqual(v[99].trunkPorts, ['Po1'], 'Gi1/0/3 does not allow 99; Po1 allows all');
    assert.equal(v[30].status, 'suspend');
    assert.deepEqual(v[30].accessPorts, []);
    assert.deepEqual(r.parseVlans(fx('vlans.json'), null)[1].trunkPorts, []);
});

test('MAC table: CPU entries skipped, short port names, types', () => {
    const rows = r.parseMac(fx('mac.json'));
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0], { mac: '00:00:5e:00:53:10', vlan: 10, port: 'Gi1/0/1', type: 'dynamic' });
    assert.equal(rows.find(x => x.mac === '00:00:5e:00:53:30').type, 'static');
    assert.deepEqual(r.parseMac({}), []);
});
