const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dbManager = require('../../services/db');
const store = require('../../services/inventoryStore');
const inv = require('../../services/inventoryScheduler');
const { writeDataSync, invalidateCache } = require('../../lib/db');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });

const aliveDeps = (ips) => ({
    pingCheck: async (ip) => ips.includes(ip),
    tcpCheck: async (ip, port) => ips.includes(ip) && port === 22,
    runPowerShell: async () => '{}',
    executeSSH: async () => { throw new Error('no ssh in test'); }
});

function resetLegacy() {
    store._testHooks.beforeCommit = null;
    store._testHooks.dataDir = null;
    store.getHandle().exec('DELETE FROM inventory_hosts');
    store._resetForTests();
    const { db } = require('../../lib/db');
    for (const r of db.prepare("SELECT key FROM document_store WHERE key LIKE 'server_operation/oscheck/data_%'").all()) {
        db.prepare('DELETE FROM document_store WHERE key = ?').run(r.key);
        invalidateCache(r.key);
    }
    for (const f of fs.readdirSync(dataDir)) if (f.startsWith('server_operation_oscheck_data_')) fs.unlinkSync(path.join(dataDir, f));
}

test('failed migration: no marker, no rows, writes rejected with a pending code and retried; legacy tags survive', () => {
    resetLegacy();
    writeDataSync('server_operation/oscheck/data_10.70.1.json', [{ ip: '10.70.1.5', status: 'online', os: 'linux', tags: ['legacy'], linkedTo: '10.70.1.1', vipOf: '10.70.1.1', isVip: true }]);
    store._testHooks.beforeCommit = () => { throw new Error('boom'); };
    assert.throws(() => store.upsertScanResult('10.70.1.5', { status: 'online', hostname: 'new' }), (e) => e.code === 'INVENTORY_MIGRATION_PENDING');
    assert.throws(() => store.updateTags('10.70.1.5', ['x']), (e) => e.code === 'INVENTORY_MIGRATION_PENDING');
    assert.equal(store.getHandle().prepare('SELECT COUNT(*) AS c FROM inventory_hosts').get().c, 0);
    assert.equal(store.getHandle().prepare('SELECT COUNT(*) AS c FROM inventory_meta').get().c, 0);
    assert.equal(store.isMigrated(), false);
    assert.equal(store.getHost('10.70.1.5').tags[0], 'legacy'); // reads still come from the documents

    store._testHooks.beforeCommit = null; // the next write retries and succeeds
    const h = store.upsertScanResult('10.70.1.5', { status: 'online', hostname: 'new' });
    assert.equal(h.hostname, 'new');
    assert.deepEqual(h.tags, ['legacy']);
    assert.equal(h.linkedTo, '10.70.1.1');
    assert.equal(h.isVip, true);
});

test('write before migration migrates first and keeps legacy tags; a recreated table re-imports; deleting the last host does not resurrect', () => {
    resetLegacy();
    writeDataSync('server_operation/oscheck/data_10.71.1.json', [{ ip: '10.71.1.2', status: 'online', tags: ['t1'] }, { ip: '10.71.1.3', status: 'offline' }]);
    assert.equal(store.updateTags('10.71.1.3', ['added']), true);
    assert.deepEqual(store.getHost('10.71.1.2').tags, ['t1']);
    // scout.sqlite recreated: table and marker disappear together, the import runs again
    store.getHandle().exec('DELETE FROM inventory_hosts; DELETE FROM inventory_meta;');
    store._resetForTests();
    assert.equal(store.isMigrated(), false);
    store.ensureMigrated();
    assert.equal(store.getAllSubnetData().length, 2);
    // marker present but table empty while legacy documents exist counts as not migrated
    store.getHandle().exec('DELETE FROM inventory_hosts');
    store._resetForTests();
    store.getHandle().prepare("INSERT INTO inventory_meta (key, value) VALUES ('hosts_migrated', '{}')").run();
    assert.equal(store.isMigrated(), false);
    // deliberately deleting the last host is final
    store.ensureMigrated();
    for (const h of store.getAllSubnetData()) store.deleteHost(h.ip);
    assert.equal(store.isMigrated(), true);
    assert.equal(store.getAllSubnetData().length, 0);
});

test('migration merges: existing rows keep their values, only empty user fields are filled; duplicate IPs union tags', () => {
    resetLegacy();
    store.upsertScanResult('10.72.1.1', { status: 'online', hostname: 'scanned' }); // migrates (nothing) first
    store.getHandle().exec('DELETE FROM inventory_meta'); // pretend the import still has to run
    store._resetForTests();
    writeDataSync('server_operation/oscheck/data_10.72.1.json', [
        { ip: '10.72.1.1', hostname: 'OLD', status: 'offline', tags: ['legacy'], linkedTo: '10.72.1.9', isVip: true },
        { ip: '10.72.1.2', hostname: 'a', lastSeen: '2026-01-01T00:00:00.000Z', tags: ['x'] }
    ]);
    writeDataSync('server_operation/oscheck/data_10.72.1_5.json', [
        { ip: '10.72.1.2', hostname: 'b', lastSeen: '2026-02-01T00:00:00.000Z', tags: ['y', 'x'], linkedTo: '10.72.1.9' }
    ]);
    store.migrateFromDocuments();
    const one = store.getHost('10.72.1.1');
    assert.equal(one.hostname, 'scanned');
    assert.equal(one.status, 'online');
    assert.deepEqual(one.tags, ['legacy']);
    assert.equal(one.linkedTo, '10.72.1.9');
    const two = store.getHost('10.72.1.2');
    assert.equal(two.hostname, 'b');
    assert.deepEqual(two.tags.slice().sort(), ['x', 'y']);
    assert.equal(two.linkedTo, '10.72.1.9');
});

test('legacy flat files are imported read-only; the newer entry per IP wins and user fields merge', () => {
    resetLegacy();
    writeDataSync('server_operation/oscheck/data_10.73.1.json', [{ ip: '10.73.1.1', hostname: 'db-doc', lastChecked: '2026-03-01T00:00:00.000Z', tags: ['doc'] }]);
    // the app's resolved data dir is NOT DB_DATA_DIR here: the importer must ask the resolver, not the env var
    const otherDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'somp-flat-'));
    store._testHooks.dataDir = () => otherDir;
    const flat = path.join(otherDir, 'server_operation_oscheck_data_10.73.1.json');
    const flatOnly = path.join(otherDir, 'server_operation_oscheck_data_10.73.2.json');
    const body = JSON.stringify([{ ip: '10.73.1.1', hostname: 'flat-newer', lastChecked: '2026-04-01T00:00:00.000Z', tags: ['flat'] }]);
    fs.writeFileSync(flat, body);
    fs.writeFileSync(flatOnly, JSON.stringify([{ ip: '10.73.2.7', hostname: 'only-flat', status: 'online' }]));
    try {
        store.migrateFromDocuments();
        const a = store.getHost('10.73.1.1');
        assert.equal(a.hostname, 'flat-newer');
        assert.deepEqual(a.tags.slice().sort(), ['doc', 'flat']);
        assert.equal(store.getHost('10.73.2.7').hostname, 'only-flat');
        assert.equal(fs.readFileSync(flat, 'utf8'), body);
    } finally {
        store._testHooks.dataDir = null;
        fs.rmSync(otherDir, { recursive: true, force: true });
    }
});

test('compat shape equals the output of the OLD getAllSubnetData logic (concatenated documents)', () => {
    resetLegacy();
    const docA = [
        { ip: '10.74.1.10', os: 'win', status: 'online', hostname: 'ten', mem: '16', cpu: 4, error: null, isVip: false, tags: 'not-an-array', subnet: 'keep-me', updatedAt: 'u', extra: { z: 1 }, zzz: 'unknown' },
        { ip: '10.74.1.2', os: 'linux', status: 'offline', lastSeen: '2026-01-01T00:00:00.000Z', tags: [] }
    ];
    const docB = [{ ip: '10.74.2.1', status: 'online', osVersion: '10.0', lastSeen: 'x', error: 'e' }];
    writeDataSync('server_operation/oscheck/data_10.74.1.json', docA);
    writeDataSync('server_operation/oscheck/data_10.74.2.json', docB);
    const oldShape = docA.concat(docB); // what the old function returned
    store.migrateFromDocuments();
    const sortIp = (arr) => JSON.parse(JSON.stringify(arr)).sort((x, y) => x.ip.localeCompare(y.ip, undefined, { numeric: true }));
    assert.deepStrictEqual(sortIp(store.getAllSubnetData()), sortIp(oldShape));
    assert.deepEqual(store.getAllSubnetData().map(h => h.ip), ['10.74.1.2', '10.74.1.10', '10.74.2.1']);
});

test('a tag edit between the probe and the write of the same IP survives the scan', async () => {
    resetLegacy();
    store.upsertScanResult('10.75.1.3', { status: 'online', os: 'linux', hostname: 'before' });
    const deps = aliveDeps(['10.75.1.3']);
    deps.executeSSH = async () => { store.updateTags('10.75.1.3', ['mid-probe']); throw new Error('no ssh'); };
    process.env.LINUX_ADMIN_USER = 'u';
    process.env.LINUX_ADMIN_PWD = 'p';
    try { await inv.scanSubnet('10.75.1:3~3', [1, 254], deps); } finally { delete process.env.LINUX_ADMIN_USER; delete process.env.LINUX_ADMIN_PWD; }
    assert.deepEqual(store.getHost('10.75.1.3').tags, ['mid-probe']);
});

test('offline results are batched and unknown addresses are not created; listHosts has a default limit', async () => {
    resetLegacy();
    store.upsertScanResult('10.76.1.5', { status: 'online' });
    await inv.scanSubnet('10.76.1:1~30', [1, 254], aliveDeps([]));
    assert.equal(store.getHost('10.76.1.5').status, 'online', 'one miss keeps the host online');
    await inv.scanSubnet('10.76.1:1~30', [1, 254], aliveDeps([]));
    assert.equal(store.getHost('10.76.1.5').status, 'offline');
    assert.ok(store.getHost('10.76.1.5').offlineSince);
    assert.equal(store.getHost('10.76.1.6'), null);
    const h = store.getHandle();
    const ins = h.prepare("INSERT OR IGNORE INTO inventory_hosts (ip, subnet, status) VALUES (?, '10.77.1', 'online')");
    for (let i = 0; i < 1100; i++) ins.run(`10.77.${Math.floor(i / 250)}.${(i % 250) + 1}`);
    assert.equal(store.listHosts({}).hosts.length, 1000);
    assert.ok(store.listHosts({ all: true }).hosts.length > 1000);
});

test('legacy documents are parsed once while unmigrated (cached), the marker survives re-insert after emptied', () => {
    resetLegacy();
    writeDataSync('server_operation/oscheck/data_10.78.1.json', [{ ip: '10.78.1.1', status: 'online' }]);
    store.getAllSubnetData(); // fills the cache
    writeDataSync('server_operation/oscheck/data_10.78.2.json', [{ ip: '10.78.2.1', status: 'online' }]);
    assert.equal(store.getAllSubnetData().length, 1, 'served from the cache within the TTL');
    store.migrateFromDocuments(); // fresh read
    assert.equal(store.getAllSubnetData().length, 2);
    store.deleteHost('10.78.1.1');
    store.deleteHost('10.78.2.1');
    assert.equal(JSON.parse(store.getHandle().prepare("SELECT value FROM inventory_meta WHERE key='hosts_migrated'").get().value).emptied, true);
    store.upsertScanResult('10.78.3.3', { status: 'online' });
    assert.equal(JSON.parse(store.getHandle().prepare("SELECT value FROM inventory_meta WHERE key='hosts_migrated'").get().value).emptied, undefined);
});
