require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const store = require('../../services/inventoryStore');
const inv = require('../../services/inventoryScheduler');
const { readDataSync, writeDataSync } = require('../../lib/db');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });

const wipe = () => { store.getHandle().exec('DELETE FROM inventory_hosts'); };
const aliveDeps = (ips) => ({
    pingCheck: async (ip) => ips.includes(ip),
    tcpCheck: async (ip, port) => ips.includes(ip) && port === 22,
    runPowerShell: async () => '{}',
    executeSSH: async () => { throw new Error('no ssh in test'); }
});

test('schema: inventory_hosts exists with indexes and ensureTable is idempotent', () => {
    const h = store.getHandle();
    store.ensureTable(h);
    store.ensureTable(h);
    const cols = h.prepare('PRAGMA table_info(inventory_hosts)').all().map(c => c.name);
    for (const c of ['ip', 'subnet', 'hostname', 'memoryGB', 'consecutiveMisses', 'offlineSince', 'specsError', 'tags', 'linkedTo', 'isVip', 'vipOf', 'extra']) {
        assert.ok(cols.includes(c), `column ${c}`);
    }
    const idx = h.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='inventory_hosts'").all().map(r => r.name);
    assert.ok(idx.includes('idx_inventory_hosts_subnet'));
    assert.ok(idx.includes('idx_inventory_hosts_status'));
});

const FIXTURE = [
    { ip: '10.60.1.1', os: 'win', lastSeen: '2026-10-01T00:00:00.000Z', status: 'online', hostname: 'WIN1', domain: 'corp.local', osname: 'Windows Server 2022', mem: 16, cpu: 8, timezone: '(UTC+08:00) Taipei', error: null, tags: ['prod', 'db'] },
    { ip: '10.60.1.2', os: 'linux', lastSeen: '2026-10-02T00:00:00.000Z', status: 'offline', hostname: 'lx2', osname: 'Ubuntu 22.04', mem: 4, cpu: 2, timezone: 'Asia/Taipei', error: 'Missing Linux credentials' },
    { ip: '10.60.1.3', os: 'unknown', lastSeen: '2026-10-03T00:00:00.000Z', status: 'online', error: 'Unknown OS or Ports closed (3389 & 22)', isVip: true, linkedTo: '10.60.1.1', vipOf: '10.60.1.1', customField: { a: 1 } }
];

test('migration from documents is idempotent, marker-guarded, keeps documents, and the compat shape equals the old shape', () => {
    wipe();
    store._resetForTests();
    writeDataSync('server_operation/oscheck/data_10.60.1.json', FIXTURE);
    writeDataSync('server_operation/oscheck/data_10.61.9.json', [{ ip: '10.61.9.5', status: 'online', os: 'win', lastSeen: '2026-10-01T00:00:00.000Z' }]);
    const before = readDataSync('server_operation/oscheck/data_10.60.1.json', null);

    // before the marker exists: reads fall back to the documents
    assert.equal(store.isMigrated(), false);
    assert.equal(store.getAllSubnetData().length, 4);
    assert.equal(store.getHost('10.60.1.2').hostname, 'lx2');

    const r1 = store.migrateFromDocuments();
    assert.equal(r1.skipped, false);
    assert.equal(r1.migrated, 4);
    assert.ok(readDataSync(store.MARKER_KEY, null), 'marker written');

    const norm = (a) => JSON.parse(JSON.stringify(a)).sort((x, y) => x.ip.localeCompare(y.ip));
    assert.deepStrictEqual(norm(store.getAllSubnetData()), norm([...FIXTURE, { ip: '10.61.9.5', status: 'online', os: 'win', lastSeen: '2026-10-01T00:00:00.000Z' }]));

    // second run: skipped, nothing duplicated or overwritten
    store.updateTags('10.60.1.2', ['edited']);
    const r2 = store.migrateFromDocuments();
    assert.equal(r2.skipped, true);
    assert.deepEqual(store.getHost('10.60.1.2').tags, ['edited']);
    // forced re-run never overwrites existing rows either
    const r3 = store.migrateFromDocuments({ force: true });
    assert.equal(r3.migrated, 0);
    assert.deepEqual(store.getHost('10.60.1.2').tags, ['edited']);
    // documents are untouched
    assert.deepEqual(readDataSync('server_operation/oscheck/data_10.60.1.json', null), before);
});

test('concurrent tag / VIP edits during a scan are kept (scan merges only scan-owned fields)', () => {
    wipe();
    store.upsertScanResult('10.62.1.10', { os: 'linux', status: 'online', hostname: 'a' });
    store.updateTags('10.62.1.10', ['keep-me']);
    store.setVipLink('10.62.1.10', '10.62.1.1');
    // a scan result computed from an older snapshot arrives afterwards
    store.upsertScanResult('10.62.1.10', { os: 'linux', status: 'online', hostname: 'a2', tags: ['SCAN-OVERWRITE'], linkedTo: 'x', isVip: false, vipOf: 'x', error: null });
    const h = store.getHost('10.62.1.10');
    assert.equal(h.hostname, 'a2');
    assert.deepEqual(h.tags, ['keep-me']);
    assert.equal(h.linkedTo, '10.62.1.1');
    assert.equal(h.isVip, true);
    assert.equal(h.vipOf, '10.62.1.1');
});

test('scan updates keep status lifecycle: offline sets offlineSince, online clears it; unknown ips are not created offline', () => {
    wipe();
    assert.equal(store.upsertScanResult('10.62.2.1', { status: 'offline' }, { createIfMissing: false }), null);
    assert.equal(store.getHost('10.62.2.1'), null);
    store.upsertScanResult('10.62.2.1', { status: 'online', os: 'win' });
    const off = store.upsertScanResult('10.62.2.1', { status: 'offline' }, { createIfMissing: false });
    assert.equal(off.status, 'offline');
    assert.ok(off.offlineSince);
    assert.equal(off.os, 'win');
    const on = store.upsertScanResult('10.62.2.1', { status: 'online' });
    assert.equal(on.offlineSince, undefined);
});

test('two ranges of one /24 both persist', async () => {
    wipe();
    const ips = ['10.63.1.2', '10.63.1.101'];
    await inv.scanSubnet('10.63.1:1~10', [1, 254], aliveDeps(ips));
    await inv.scanSubnet('10.63.1:100~110', [1, 254], aliveDeps(ips));
    const got = store.listHostsBySubnet('10.63.1').map(h => h.ip).sort();
    assert.deepEqual(got, ips.slice().sort());
    // rerunning the first range keeps the second range's host
    await inv.scanSubnet('10.63.1:1~10', [1, 254], aliveDeps(['10.63.1.2']));
    assert.equal(store.getHost('10.63.1.101').status, 'online');
});

test('a tag edit made while a scan is running survives the scan', async () => {
    wipe();
    store.upsertScanResult('10.64.1.5', { os: 'linux', status: 'online', hostname: 'old' });
    let edited = false;
    const deps = aliveDeps(['10.64.1.5']);
    const ping = deps.pingCheck;
    deps.pingCheck = async (ip) => {
        if (ip === '10.64.1.7' && !edited) { edited = true; store.updateTags('10.64.1.5', ['during-scan']); }
        return ping(ip);
    };
    await inv.scanSubnet('10.64.1:1~10', [1, 254], deps);
    assert.ok(edited);
    assert.deepEqual(store.getHost('10.64.1.5').tags, ['during-scan']);
    assert.equal(store.getHost('10.64.1.5').status, 'online');
});

test('listHosts filters and paginates; deleteHost removes the row; updateServerTags uses the store', () => {
    wipe();
    for (let i = 1; i <= 12; i++) store.upsertScanResult(`10.65.1.${i}`, { status: i % 2 ? 'online' : 'offline', hostname: `h${i}` });
    store.upsertScanResult('10.65.2.1', { status: 'online', hostname: 'other' });
    const all = store.listHosts({});
    assert.equal(all.total, 13);
    const sub = store.listHosts({ subnet: '10.65.1', status: 'online', limit: 4, offset: 2 });
    assert.equal(sub.total, 6);
    assert.deepEqual(sub.hosts.map(h => h.ip), ['10.65.1.5', '10.65.1.7', '10.65.1.9', '10.65.1.11']);
    assert.deepEqual(store.listHosts({ search: 'other' }).hosts.map(h => h.ip), ['10.65.2.1']);
    // natural numeric order, not lexicographic
    assert.deepEqual(store.listHosts({ subnet: '10.65.1' }).hosts.slice(0, 3).map(h => h.ip), ['10.65.1.1', '10.65.1.2', '10.65.1.3']);

    assert.deepEqual(inv.updateServerTags('10.65.1.1', ['x']), { success: true, tags: ['x'] });
    assert.throws(() => inv.updateServerTags('10.65.9.9', ['x']), /not found/);
    assert.equal(store.deleteHost('10.65.1.1'), true);
    assert.equal(store.deleteHost('10.65.1.1'), false);
    assert.equal(store.getHost('10.65.1.1'), null);
});

test('linkVip / unlinkVip / isIpVip work against the table', async () => {
    wipe();
    store.upsertScanResult('10.66.1.1', { status: 'online', hostname: 'primary' });
    store.upsertScanResult('10.66.1.2', { status: 'online', hostname: 'vip' });
    const { linkVip, unlinkVip, isIpVip } = require('../../lib/vipLinkageHelper');
    await linkVip('10.66.1.1', '10.66.1.2', 'tester');
    assert.equal(store.getHost('10.66.1.2').linkedTo, '10.66.1.1');
    assert.equal(isIpVip('10.66.1.2'), true);
    assert.deepEqual(store.listLinkedHosts().map(h => h.ip), ['10.66.1.2']);
    await unlinkVip('10.66.1.2', 'tester');
    const h = store.getHost('10.66.1.2');
    assert.equal(h.linkedTo, undefined);
    assert.equal(h.isVip, undefined);
});
