// Juniper Junos parsers against recorded REST / `| display json` answers (documentation IPs / MACs only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const j = require('../../lib/netDevices/parsers/junos');

const raw = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/juniper', name), 'utf8');
const fx = (name) => JSON.parse(raw(name));

test('leaf helpers, port names, speeds, CLI JSON', () => {
    assert.equal(j.d({ a: [{ data: 'x' }] }, 'a'), 'x');
    assert.equal(j.d({ a: 'y' }, 'a'), 'y');
    assert.equal(j.d({}, 'a'), null);
    assert.equal(j.portName('ge-0/0/1.0*'), 'ge-0/0/1');
    assert.equal(j.portName('irb.10'), 'irb.10');
    assert.equal(j.speedOf('10Gbps'), 10000);
    assert.equal(j.speedOf('1000mbps'), 1000);
    assert.equal(j.speedOf('Auto'), null);
    assert.deepEqual(j.parseCliJson('{master:0}\n{\n "a": 1\n}\n\n{master:0}\n'), { a: 1 });
    assert.equal(j.parseCliJson('error: syntax error'), null);
});

test('summary: virtual chassis members, roles, CPU, memory', () => {
    const s = j.parseSummary({ version: fx('show_version.json'), inventory: fx('show_chassis_hardware.json'), engines: fx('show_chassis_routing_engine.json') });
    assert.deepEqual([s.model, s.hostname, s.version, s.serial], ['EX4300-48T', 'ex-lab-access1', '21.4R3-S5.4', 'PE0000LAB01']);
    assert.deepEqual([s.cpu, s.memory], [9, 42]);
    assert.equal(s.uptime, '41 days, 3 hours, 15 minutes, 9 seconds');
    assert.deepEqual(s.members.map(m => [m.slot, m.serial, m.role]), [[0, 'PE0000LAB01', 'active'], [1, 'PE0000LAB02', 'standby']]);
    // old Junos: version from the package comment, model from the product
    const old = j.parseSummary({ version: fx('show_version_old.json'), inventory: null, engines: null });
    assert.deepEqual([old.model, old.version, old.hostname, old.cpu, old.members], ['EX2200-24T-4G', '12.3R12-S15', 'ex-lab-old', null, []]);
});

test('interfaces: internal ones skipped, irb units listed, counters, modes', () => {
    const sw = j.parseSwitching(fx('show_ethernet_switching_interface.json'));
    const by = Object.fromEntries(j.parseInterfaces(fx('show_interfaces_extensive.json'), sw).map(i => [i.name, i]));
    assert.deepEqual(Object.keys(by), ['ge-0/0/1', 'ge-0/0/2', 'ge-0/0/3', 'xe-0/2/0', 'xe-1/2/0', 'ae0', 'irb.10', 'me0']);
    const g = by['ge-0/0/1'];
    assert.deepEqual([g.status, g.mode, g.vlan, g.speed, g.duplex, g.alias, g.mtu], ['up', 'access', 10, 1000, 'full', 'lab host 1', 1514]);
    assert.deepEqual([g.inErrors, g.crcErrors, g.outErrors, g.inDiscards, g.outDiscards], [4, 2, 0, 1, 7]);
    assert.deepEqual([g.rxBps, g.txBps, g.rxBytes, g.rateInterval], [2500000, 1200000, 987654321, null]);
    assert.equal(g.mac, '00:00:5e:00:53:b1');
    assert.equal(by['ge-0/0/2'].status, 'down');
    assert.equal(by['ge-0/0/3'].status, 'admin-down');
    assert.deepEqual([by['xe-0/2/0'].mode, by['xe-0/2/0'].vlan, by['xe-0/2/0'].trunkVlans, by['xe-0/2/0'].duplex], ['trunk', 1, 3, 'full']);
    assert.deepEqual([by.ae0.mode, by.ae0.vlan], ['trunk', 99]);
    assert.deepEqual([by['xe-1/2/0'].mode, by['xe-1/2/0'].ip], ['routed', '198.51.100.5/30']);
    assert.deepEqual([by['irb.10'].ip, by['irb.10'].mode, by['irb.10'].status], ['192.0.2.1/24', 'routed', 'up']);
    assert.equal(by.me0.ip, '192.0.2.60/24');
    const bare = Object.fromEntries(j.parseInterfaces(fx('show_interfaces_extensive.json'), null).map(i => [i.name, i]));
    assert.deepEqual([bare['ge-0/0/1'].mode, bare['xe-1/2/0'].mode], [null, 'routed']);
    assert.deepEqual(j.parseInterfaces({}, null), []);
});

test('VLANs: access and trunk members', () => {
    const v = Object.fromEntries(j.parseVlans(fx('show_vlans.json')).map(x => [x.id, x]));
    assert.deepEqual(Object.keys(v).map(Number), [1, 10, 20, 30, 99]);
    assert.deepEqual(v[10].accessPorts, ['ge-0/0/1']);
    assert.deepEqual(v[10].trunkPorts, ['xe-0/2/0', 'ae0']);
    assert.deepEqual(v[1].trunkPorts, ['xe-0/2/0'], 'native VLAN of a trunk counts as trunk membership');
    assert.deepEqual([v[99].accessPorts, v[99].trunkPorts, v[99].name], [[], [], 'NATIVE']);
    assert.deepEqual(j.parseVlans({}), []);
});

test('MAC table: VLAN tag from the entry or from the VLAN name', () => {
    let rows = j.parseMac(fx('show_ethernet_switching_table.json'));
    assert.equal(rows.length, 4, 'entry without a VLAN id and no name map is skipped');
    rows = j.parseMac(fx('show_ethernet_switching_table.json'), { 'LAB-USERS': 10 });
    assert.equal(rows.length, 5);
    assert.deepEqual(rows[0], { mac: '00:00:5e:00:53:10', vlan: 10, port: 'ge-0/0/1', type: 'dynamic' });
    assert.deepEqual(rows[4], { mac: '00:00:5e:00:53:30', vlan: 20, port: 'ae0', type: 'static' });
});

test('config: last commit line and prompts removed', () => {
    const c = j.cleanConfig(raw('show_configuration_set.txt'));
    assert.ok(c.startsWith('set version'));
    assert.ok(!/Last commit|\{master/.test(c));
    assert.equal(j.cleanConfig(raw('show_configuration_set.txt').replace('10:12:33', '11:00:00')), c);
});
