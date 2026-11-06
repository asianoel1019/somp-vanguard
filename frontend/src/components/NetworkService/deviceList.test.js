import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceHealth, snmpState, summarize, typeCounts, filterDevices, sortDevices, relativeTime, connectionNote } from './deviceList.js';

const NOW = Date.parse('2026-11-06T08:00:00Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const devices = [
    { id: 'a', hostname: 'sw10', ip: '192.0.2.10', type: 'Switch', datacenter: 'DC1', enabled: true, snmp: { community: '********' }, mgmt: { enabled: true, lastStatus: 'ok', vendorLabel: 'Cisco IOS / IOS-XE', model: 'C9300-48P', lastCheckedAt: ago(5) } },
    { id: 'b', hostname: 'sw2', ip: '192.0.2.2', type: 'Switch', datacenter: 'DC1', enabled: true, snmp: {}, mgmt: { enabled: true, lastStatus: 'error', lastError: 'The device did not answer (ETIMEDOUT)', vendorLabel: 'Cisco NX-OS', lastCheckedAt: ago(10) } },
    { id: 'c', hostname: 'fw1', ip: '192.0.2.1', type: 'Firewall', datacenter: 'DC2', enabled: false, mgmt: null },
    { id: 'd', hostname: 'lb1', ip: '192.0.2.80', type: 'LoadBalancer', datacenter: 'DC2', enabled: true, snmp: { v3User: 'u' }, mgmt: { enabled: false, lastStatus: 'ok', vendorLabel: 'F5 BIG-IP' } },
    { id: 'e', hostname: 'rt1', ip: '198.51.100.1', type: 'Router', datacenter: 'DC1', enabled: true, snmp: { community: '********' }, mgmt: { enabled: true, lastStatus: 'unknown', vendorLabel: 'Juniper Junos' } },
];

test('health and SNMP state per device', () => {
    assert.deepEqual(devices.map(deviceHealth), ['ok', 'error', 'none', 'disabled', 'pending']);
    assert.deepEqual(devices.map(snmpState), ['ok', 'missing', 'off', 'ok', 'ok']);
    assert.equal(deviceHealth(null), 'none');
});

test('summary cards and type chips', () => {
    assert.deepEqual(summarize(devices), { total: 5, ok: 1, error: 1, none: 1, snmpMissing: 1 });
    assert.deepEqual(summarize([]), { total: 0, ok: 0, error: 0, none: 0, snmpMissing: 0 });
    assert.deepEqual(typeCounts([...devices, { type: 'Other' }]), [
        { type: 'Firewall', count: 1 }, { type: 'Switch', count: 2 }, { type: 'Router', count: 1 }, { type: 'LoadBalancer', count: 1 }, { type: 'Other', count: 1 },
    ]);
});

test('filters: data center, type, quick filter, search on host / IP / vendor / model', () => {
    const ids = (opts) => filterDevices(devices, opts).map(d => d.id);
    assert.deepEqual(ids({}), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(ids({ dc: 'DC2' }), ['c', 'd']);
    assert.deepEqual(ids({ type: 'Switch' }), ['a', 'b']);
    assert.deepEqual(ids({ quick: 'error' }), ['b']);
    assert.deepEqual(ids({ quick: 'none' }), ['c']);
    assert.deepEqual(ids({ quick: 'snmpMissing' }), ['b']);
    assert.deepEqual(ids({ quick: 'ok', type: 'Switch' }), ['a']);
    assert.deepEqual(ids({ search: 'nx-os' }), ['b']);
    assert.deepEqual(ids({ search: 'C9300' }), ['a']);
    assert.deepEqual(ids({ search: '198.51' }), ['e']);
    assert.deepEqual(ids({ quick: 'bogus' }), ['a', 'b', 'c', 'd', 'e']);
});

test('order: failing first, then natural host name order', () => {
    assert.deepEqual(sortDevices(devices).map(d => d.hostname), ['sw2', 'rt1', 'sw10', 'lb1', 'fw1']);
    const same = [{ hostname: 'sw10', mgmt: null }, { hostname: 'sw2', mgmt: null }, { hostname: 'SW3', mgmt: null }];
    assert.deepEqual(sortDevices(same).map(d => d.hostname), ['sw2', 'SW3', 'sw10']);
});

test('relative time and connection note', () => {
    assert.equal(relativeTime(ago(0.2), NOW), '剛剛');
    assert.equal(relativeTime(ago(5), NOW), '5 分鐘前');
    assert.equal(relativeTime(ago(180), NOW), '3 小時前');
    assert.equal(relativeTime(ago(60 * 50), NOW), '2 天前');
    assert.equal(relativeTime(null, NOW), null);
    assert.deepEqual(devices.map(d => connectionNote(d, NOW)), [
        '最後讀取 5 分鐘前', 'The device did not answer (ETIMEDOUT)（10 分鐘前）', '未設定管理連線', '管理連線已停用', '尚未讀取',
    ]);
    const long = { mgmt: { enabled: true, lastStatus: 'error', lastError: 'x'.repeat(200) } };
    assert.equal(connectionNote(long, NOW), `${'x'.repeat(80)}…`);
});
