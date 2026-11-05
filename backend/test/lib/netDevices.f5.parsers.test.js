// F5 BIG-IP parsers against recorded iControl REST answers (documentation IPs / MACs only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const f5 = require('../../lib/netDevices/parsers/f5');

const fx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/f5', name), 'utf8'));

test('stat helpers: values, descriptions, records found by field not by key', () => {
    assert.equal(f5.statValue({ value: 3 }), 3);
    assert.equal(f5.statValue({ description: 'x' }), 'x');
    assert.equal(f5.findStat(fx('version.json'), 'Version'), '16.1.4');
    assert.equal(f5.findStat({}, 'Version'), null);
    const v14 = f5.statsByPath(fx('virtual_stats.json'));
    const v13 = f5.statsByPath(fx('virtual_stats_v13.json'));
    assert.equal(v14['/Common/vs_web']['clientside.curConns'], 12);
    assert.equal(v13['/Common/vs_web']['clientside.curConns'], 7, '13.x key layout');
});

test('status colours', () => {
    assert.equal(f5.statusColor('available', 'enabled'), 'green');
    assert.equal(f5.statusColor('unavailable', 'enabled'), 'yellow');
    assert.equal(f5.statusColor('offline', 'enabled'), 'red');
    assert.equal(f5.statusColor('unknown', 'enabled'), 'blue');
    assert.equal(f5.statusColor('available', 'disabled'), 'gray');
    assert.equal(f5.statusColor('offline', 'disabled-by-parent'), 'gray');
});

test('destinations: IPv4, route domain, IPv6, any', () => {
    assert.deepEqual(f5.parseDestination('/Common/192.0.2.10:443'), { ip: '192.0.2.10', port: 443 });
    assert.deepEqual(f5.parseDestination('/Tenant_A/198.51.100.20%2:443'), { ip: '198.51.100.20%2', port: 443 });
    assert.deepEqual(f5.parseDestination('/Common/2001:db8::10.443'), { ip: '2001:db8::10', port: 443 });
    assert.deepEqual(f5.parseDestination('/Common/0.0.0.0:any'), { ip: '0.0.0.0', port: 0 });
    assert.deepEqual(f5.parseDestination(''), { ip: null, port: null });
});

test('summary: platform, version, build, serial, CPU, memory', () => {
    const s = f5.parseSummary({ settings: fx('global_settings.json'), version: fx('version.json'), hardware: fx('hardware.json'), hostInfo: fx('host_info.json') });
    assert.deepEqual(s, { model: 'BIG-IP i5800', hostname: 'bigip-lab-01.example.test', version: '16.1.4', build: '0.0.4', serial: 'f5-lab0-0001', cpu: 15, memory: 38 });
    const bare = f5.parseSummary({ settings: fx('global_settings.json'), version: fx('version.json'), hardware: null, hostInfo: null });
    assert.deepEqual([bare.model, bare.serial, bare.cpu, bare.memory], ['BIG-IP', null, null, null]);
});

test('HA: role, device group, sync state, members', () => {
    const h = f5.parseHa({ failover: fx('failover_status.json'), sync: fx('sync_status.json'), devices: fx('devices.json') });
    assert.deepEqual([h.mode, h.group, h.syncStatus, h.syncColor, h.priority], ['active', 'dg-lab-failover', 'In Sync', 'green', null]);
    assert.deepEqual(h.members.map(m => [m.hostname, m.state, m.mgmtIp, m.self]), [
        ['bigip-lab-01.example.test', 'active', '192.0.2.80', true],
        ['bigip-lab-02.example.test', 'standby', '192.0.2.81', false],
    ]);
    const single = f5.parseHa({ failover: fx('failover_status.json'), sync: null, devices: null });
    assert.deepEqual([single.mode, single.group, single.members], ['active', null, []]);
});

test('virtual servers: destinations, colours, counters', () => {
    const by = Object.fromEntries(f5.parseVirtuals(fx('virtuals.json'), fx('virtual_stats.json')).map(v => [v.name, v]));
    assert.deepEqual([by.vs_web.status, by.vs_web.destination, by.vs_web.pool, by.vs_web.curConns, by.vs_web.description], ['green', '192.0.2.10:443', '/Common/pool_web', 12, 'lab web']);
    assert.deepEqual([by.vs_api.status, by.vs_api.statusReason], ['red', 'The children pool member(s) are down']);
    assert.deepEqual([by.vs_old.status, by.vs_old.enabled], ['gray', false]);
    assert.deepEqual([by.vs_rd.status, by.vs_rd.partition, by.vs_rd.destination], ['yellow', 'Tenant_A', '198.51.100.20%2:443']);
    assert.deepEqual([by.vs_v6.status, by.vs_v6.destination], ['blue', '2001:db8::10.443']);
    assert.deepEqual([by.vs_any.status, by.vs_any.port, by.vs_any.curConns], ['blue', 0, null], 'no stats record: unknown');
    // without the stats answer: enabled ones are blue, disabled ones gray
    const bare = Object.fromEntries(f5.parseVirtuals(fx('virtuals.json'), null).map(v => [v.name, v]));
    assert.deepEqual([bare.vs_web.status, bare.vs_old.status], ['blue', 'gray']);
    assert.deepEqual(f5.parseVirtuals({}, null), []);
});

test('pools: colours, members up / total, monitor, lb mode', () => {
    const by = Object.fromEntries(f5.parsePools(fx('pools.json'), fx('pool_stats.json')).map(p => [p.name, p]));
    assert.deepEqual([by.pool_web.status, by.pool_web.membersUp, by.pool_web.membersTotal, by.pool_web.curConns, by.pool_web.monitor], ['green', 1, 4, 30, '/Common/http']);
    assert.deepEqual([by.pool_api.status, by.pool_api.statusReason, by.pool_api.lbMode], ['red', 'The children pool member(s) are down', 'least-connections-member']);
    assert.deepEqual([by.pool_rd.partition, by.pool_rd.membersUp], ['Tenant_A', 1]);
    assert.deepEqual([by.pool_empty.status, by.pool_empty.membersTotal, by.pool_empty.monitor], ['blue', 0, null]);
    const bare = f5.parsePools(fx('pools.json'), null);
    assert.ok(bare.every(p => p.status === 'blue' && p.curConns === null));
});

test('pool members: matched to stats by node and port, sessions, reasons', () => {
    const by = Object.fromEntries(f5.parsePoolMembers(fx('pool_web_members.json'), fx('pool_web_member_stats.json')).map(m => [m.address, m]));
    assert.deepEqual([by['192.0.2.21'].status, by['192.0.2.21'].session, by['192.0.2.21'].curConns, by['192.0.2.21'].port], ['green', 'enabled', 20, 80]);
    assert.deepEqual([by['192.0.2.22'].status, by['192.0.2.22'].statusReason], ['red', 'Pool member has been marked down by a monitor']);
    assert.deepEqual([by['192.0.2.23'].status, by['192.0.2.23'].session], ['gray', 'disabled']);
    assert.deepEqual([by['192.0.2.24'].status, by['192.0.2.24'].session], ['gray', 'forced-offline']);
    // without stats: colours from the monitor state of the configuration
    const bare = Object.fromEntries(f5.parsePoolMembers(fx('pool_web_members.json'), null).map(m => [m.address, m]));
    assert.deepEqual([bare['192.0.2.21'].status, bare['192.0.2.22'].status, bare['192.0.2.21'].curConns], ['green', 'red', null]);
    assert.equal(f5.restName('/Common/app1/pool_web'), '~Common~app1~pool_web');
});

test('certificates: days left, CN from the subject, sorted by expiry', () => {
    const now = Date.parse('2026-11-05T00:00:00Z');
    const certs = f5.parseCerts(fx('ssl_certs.json'), now);
    assert.deepEqual(certs.map(c => [c.name, c.daysLeft]), [['ca-bundle.crt', -400], ['old.example.test.crt', -3], ['api.example.test.crt', 12], ['web.example.test.crt', 200]]);
    const api = certs.find(c => c.name === 'api.example.test.crt');
    assert.deepEqual([api.commonName, api.issuer, api.isBundle], ['api.example.test', 'Lab Issuing CA', false]);
    assert.equal(certs[0].isBundle, true);
    assert.equal(certs.find(c => c.name === 'web.example.test.crt').expiresAt, new Date(now + 200 * 86400000).toISOString());
    assert.deepEqual(f5.parseCerts({}), []);
});
