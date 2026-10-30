require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { db: libDb, readDataSync, writeDataSync } = require('../../lib/db');
const cmdb = require('../../services/cmdbModel');
const store = require('../../services/inventoryStore');
const promHelper = require('../../lib/prometheusTargetHelper');

// Count Prometheus read-modify-write calls made by the inventory scheduler (must be wrapped BEFORE it is required)
const promCalls = [];
const realUpdate = promHelper.updateTargetsSafely;
promHelper.updateTargetsSafely = (mutator, reason, opts) => { promCalls.push(reason); return realUpdate(mutator, reason, opts); };

const inv = require('../../services/inventoryScheduler');
const del = require('../../services/inventoryDeletion');
const { buildVipSet, isIpVip, linkVip } = require('../../lib/vipLinkageHelper');

const META_KEY = 'server_operation/server_cmdb_meta.json';
const IPAM_KEY = 'network_service/ipam/subnets.json';
const CONFIG_KEY = 'server_operation/oscheck/config.json';
const DAY = 86400000;
const daysAgo = (d) => new Date(Date.now() - d * DAY).toISOString();

const tok = (role, username = role.toLowerCase()) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['inv'] })}`;
const admin = tok('SuperAdmin'), op = tok('Operator'), viewer = tok('Viewer');
const bearer = (t) => ({ Authorization: t });
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: { inv: { enabled: true, features: { inventory: true, serverList: true } } } });
    app = express();
    app.use(express.json());
    app.use('/api/inventory', require('../../routes/inventory'));
});
test.after(async () => { await dbManager.closeDB(); });

const target = (ip, host = ip) => ({ targets: [`${ip}:9100`], labels: { addr: ip, host, application: 'X', group: 'G', zone: '-' } });
const cmdbRow = (ip) => libDb.prepare('SELECT ip, lifecycleStatus, lastDiscoveredAt FROM cmdb_servers WHERE ip = ?').get(ip);
const meta = () => readDataSync(META_KEY, {});
const ipamEntry = (ip) => readDataSync(IPAM_KEY, []).flatMap(s => s.ips).find(i => i.address === ip);

function seedHost(ip, { hostname = `H-${ip}`, offlineDaysAgo = 10, status = 'offline', withCmdb = true, ipamStatus = 'used' } = {}) {
    store.upsertScanResult(ip, { hostname, status, os: 'linux', offlineSince: status === 'offline' ? daysAgo(offlineDaysAgo) : null, lastSeen: daysAgo(offlineDaysAgo + 1) });
    if (withCmdb) cmdb.upsertCmdbServer({ ip, hostname }, 'MANUAL');
    return ipamStatus;
}
const clearInventory = () => store.getAllSubnetData().forEach(h => store.deleteHost(h.ip));
function seedIpam(entries) {
    const byCidr = {};
    for (const [ip, status] of Object.entries(entries)) {
        const cidr = `${ip.split('.').slice(0, 3).join('.')}.0/24`;
        (byCidr[cidr] = byCidr[cidr] || []).push({ address: ip, status, hostname: `H-${ip}`, fqdn: 'x', assignedTo: 'a', service: 's', owner: 'o' });
    }
    writeDataSync(IPAM_KEY, Object.entries(byCidr).map(([cidr, ips]) => ({ id: cidr, cidr, name: cidr, ips })));
}

// --- guard ---------------------------------------------------------------------------------------

test('guard: offlineSince decides; legacy rows fall back to lastSeen / lastChecked; unknown duration is blocked', () => {
    const now = Date.now();
    assert.equal(del.evaluateGuard({ status: 'offline', offlineSince: daysAgo(8) }, 7, now).blocked, false);
    assert.equal(del.evaluateGuard({ status: 'offline', offlineSince: daysAgo(6) }, 7, now).code, 'not_offline_long_enough');
    assert.equal(del.evaluateGuard({ status: 'offline', lastSeen: daysAgo(9) }, 7, now).blocked, false, 'legacy: lastSeen');
    assert.equal(del.evaluateGuard({ status: 'offline', lastChecked: daysAgo(9) }, 7, now).code, 'unknown_offline_duration', 'lastChecked is refreshed by every scan: not a fallback');
    assert.equal(del.evaluateGuard({ status: 'offline' }, 7, now).code, 'unknown_offline_duration');
    assert.equal(del.evaluateGuard({ status: 'online', offlineSince: daysAgo(30) }, 7, now).code, 'not_offline');
    assert.equal(del.evaluateGuard(null, 7, now).code, 'not_found');
});

// --- one delete path -----------------------------------------------------------------------------

test('inventory DELETE goes through the Server List delete: deleted flag + deletedNames, CMDB row gone, inventory row gone, IPAM used released, Prometheus untouched by default', async () => {
    writeDataSync(CONFIG_KEY, { subnets: [], offlineDeleteDays: 7 });
    writeDataSync(META_KEY, { '10.71.1.5': { hostname: 'OLDHOST' } });
    seedHost('10.71.1.5', { hostname: 'OLDHOST', offlineDaysAgo: 10 });
    seedIpam({ '10.71.1.5': 'used' });
    await promHelper.saveTargetsSafely([target('10.71.1.5', 'OLDHOST'), target('10.71.1.6')], 'test_seed');

    const res = await request(app).delete('/api/inventory/server/10.71.1.5').set(bearer(op));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.result.removedFromInventory, true);
    assert.equal(res.body.result.releasedInIpam, true);

    assert.equal(store.getHost('10.71.1.5'), null);
    assert.equal(cmdbRow('10.71.1.5'), undefined);
    const m = meta()['10.71.1.5'];
    assert.equal(m.deleted, true);
    assert.equal(m.deletedReason, 'manual');
    assert.equal(m.deletedBy, 'operator');
    assert.ok(m.deletedNames.includes('oldhost'), 'deletedNames recorded for IP-reuse detection');
    assert.equal(ipamEntry('10.71.1.5').status, 'free');
    assert.equal(ipamEntry('10.71.1.5').hostname, '');
    assert.ok(promHelper.getTargetsSafely().some(t => t.labels.addr === '10.71.1.5'), 'Prometheus cleanup is optional and OFF by default');
});

test('optional Prometheus cleanup flag removes the target through the shared path', async () => {
    seedHost('10.71.2.5', { offlineDaysAgo: 12 });
    await promHelper.saveTargetsSafely([target('10.71.2.5'), target('10.71.2.6')], 'test_seed');
    const res = await request(app).delete('/api/inventory/server/10.71.2.5').set(bearer(op)).send({ cleanup: { prometheus: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.cleaned.prometheusTargets, 1);
    assert.deepEqual(promHelper.getTargetsSafely().map(t => t.labels.addr), ['10.71.2.6']);
});

test('IPAM: reserved and vip records are kept, only "used" is released', async () => {
    seedHost('10.71.3.1', { offlineDaysAgo: 9 });
    seedHost('10.71.3.2', { offlineDaysAgo: 9 });
    seedHost('10.71.3.3', { offlineDaysAgo: 9 });
    seedIpam({ '10.71.3.1': 'reserved', '10.71.3.2': 'vip', '10.71.3.3': 'used' });
    for (const ip of ['10.71.3.1', '10.71.3.2', '10.71.3.3']) {
        await request(app).delete(`/api/inventory/server/${ip}`).set(bearer(op)).expect(200);
    }
    assert.equal(ipamEntry('10.71.3.1').status, 'reserved');
    assert.equal(ipamEntry('10.71.3.1').hostname, 'H-10.71.3.1', 'kept records are not modified');
    assert.equal(ipamEntry('10.71.3.2').status, 'vip');
    assert.equal(ipamEntry('10.71.3.3').status, 'free');
    assert.equal(store.getHost('10.71.3.1'), null, 'the inventory row is removed regardless');
});

test('server-side guard: blocked unless offline long enough; force is SuperAdmin only and audited', async () => {
    writeDataSync(CONFIG_KEY, { subnets: [], offlineDeleteDays: 7 });
    seedHost('10.72.1.1', { offlineDaysAgo: 2 });
    seedHost('10.72.1.2', { status: 'online', offlineDaysAgo: 0 });

    let r = await request(app).delete('/api/inventory/server/10.72.1.1').set(bearer(op));
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'OFFLINE_GUARD');
    assert.equal(r.body.canForce, false);
    assert.ok(store.getHost('10.72.1.1'), 'nothing deleted');
    assert.equal(meta()['10.72.1.1']?.deleted, undefined);

    r = await request(app).delete('/api/inventory/server/10.72.1.1').set(bearer(op)).send({ force: true });
    assert.equal(r.status, 403, 'an Operator cannot force');
    assert.ok(store.getHost('10.72.1.1'));

    r = await request(app).delete('/api/inventory/server/10.72.1.2').set(bearer(admin));
    assert.equal(r.status, 409, 'online hosts are blocked too');
    assert.equal(r.body.canForce, true);

    const logger = require('../../lib/logger');
    const lines = [];
    const realAudit = logger.auditLog;
    logger.auditLog = (user, mod, action) => { lines.push(`[Audit] User: ${user} | Module: ${mod} | Action: ${action}`); };
    try {
        r = await request(app).delete('/api/inventory/server/10.72.1.2').set(bearer(admin)).send({ force: true });
    } finally { logger.auditLog = realAudit; }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.result.forced, true);
    assert.equal(store.getHost('10.72.1.2'), null);
    assert.equal(meta()['10.72.1.2'].deleted, true);
    assert.ok(lines.some(l => /\[Audit\] User: superadmin \| Module: Inventory \| Action: FORCE deleted server 10\.72\.1\.2/.test(l)), 'force delete is audited');

    await request(app).delete('/api/inventory/server/10.72.9.9').set(bearer(op)).expect(404);
    await request(app).delete('/api/inventory/server/10.72.1.1').set(bearer(viewer)).expect(403);
});

// --- preview -------------------------------------------------------------------------------------

test('preview = Server List preview + inventory / IPAM lines, with guard info', async () => {
    writeDataSync(CONFIG_KEY, { subnets: [], offlineDeleteDays: 7 });
    seedHost('10.73.1.1', { offlineDaysAgo: 10 });
    seedHost('10.73.1.2', { offlineDaysAgo: 1 });
    seedIpam({ '10.73.1.1': 'used', '10.73.1.2': 'reserved' });
    await promHelper.saveTargetsSafely([target('10.73.1.1')], 'test_seed');

    const res = await request(app).post('/api/inventory/delete-preview').set(bearer(op)).send({ ips: ['10.73.1.1', '10.73.1.2'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.offlineDeleteDays, 7);
    const [a, b] = res.body.previews;
    assert.equal(a.exists, true, 'carries the Server List preview fields');
    assert.equal(a.prometheusTargets.length, 1);
    assert.equal(a.inventory.blocked, false);
    assert.equal(a.ipam.action, 'release');
    assert.ok(a.lines.some(l => /Server Inventory: the host record will be removed/.test(l)));
    assert.ok(a.lines.some(l => /status "used" will be released/.test(l)));
    assert.equal(b.inventory.blocked, true);
    assert.equal(b.inventory.blockedCode, 'not_offline_long_enough');
    assert.equal(b.ipam.action, 'keep');
    assert.ok(b.lines.some(l => /"reserved" is kept/.test(l)));
    assert.ok(b.lines.some(l => /^Blocked:/.test(l)));

    await request(app).post('/api/inventory/delete-preview').set(bearer(op)).send({ ips: [] }).expect(400);
    await request(app).post('/api/inventory/delete-preview').set(bearer(op)).send({ ips: ['nope'] }).expect(400);
    await request(app).post('/api/inventory/delete-preview').set(bearer(viewer)).send({ ips: ['10.73.1.1'] }).expect(403);
});

// --- bulk ----------------------------------------------------------------------------------------

test('bulk delete of hosts offline > N days: dry run previews, real run deletes through the same path, effective days never below the configured guard', async () => {
    writeDataSync(CONFIG_KEY, { subnets: [], offlineDeleteDays: 7 });
    clearInventory();
    seedHost('10.74.1.1', { offlineDaysAgo: 40 });
    seedHost('10.74.1.2', { offlineDaysAgo: 20 });
    seedHost('10.74.1.3', { offlineDaysAgo: 10 });
    seedHost('10.74.1.4', { offlineDaysAgo: 3 });
    seedHost('10.74.1.5', { status: 'online' });
    seedIpam({ '10.74.1.1': 'used', '10.74.1.2': 'reserved' });

    const dry = await request(app).post('/api/inventory/bulk-delete-offline').set(bearer(op)).send({ days: 15, dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal(dry.body.dryRun, true);
    assert.deepEqual(dry.body.ips, ['10.74.1.1', '10.74.1.2']);
    assert.equal(dry.body.previews.length, 2);
    assert.ok(dry.body.previews[0].lines.length >= 2);
    assert.ok(store.getHost('10.74.1.1'), 'a dry run deletes nothing');

    // N below the configured guard is raised to the guard (7 days): the 3-day host is never a candidate
    const low = await request(app).post('/api/inventory/bulk-delete-offline').set(bearer(op)).send({ days: 1 });
    assert.equal(low.body.days, 7);
    assert.deepEqual(low.body.ips.sort(), ['10.74.1.1', '10.74.1.2', '10.74.1.3']);

    const real = await request(app).post('/api/inventory/bulk-delete-offline').set(bearer(op)).send({ days: 15, dryRun: false, ips: dry.body.ips });
    assert.equal(real.status, 200, JSON.stringify(real.body));
    assert.deepEqual(real.body.deleted.sort(), ['10.74.1.1', '10.74.1.2']);
    assert.equal(store.getHost('10.74.1.1'), null);
    assert.ok(store.getHost('10.74.1.3'), 'shorter offline hosts survive');
    assert.ok(store.getHost('10.74.1.5'), 'online hosts survive');
    assert.equal(meta()['10.74.1.2'].deleted, true);
    assert.ok(Array.isArray(meta()['10.74.1.2'].deletedNames));
    assert.equal(ipamEntry('10.74.1.1').status, 'free');
    assert.equal(ipamEntry('10.74.1.2').status, 'reserved');

    await request(app).post('/api/inventory/bulk-delete-offline').set(bearer(op)).send({ days: 15, dryRun: false }).expect(400); // confirmed ips are required
    await request(app).post('/api/inventory/bulk-delete-offline').set(bearer(op)).send({ days: 'abc' }).expect(400);
    await request(app).post('/api/inventory/bulk-delete-offline').set(bearer(op)).send({ days: 5, force: true }).expect(400);
    await request(app).post('/api/inventory/bulk-delete-offline').set(bearer(viewer)).send({ days: 5 }).expect(403);
});

test('bulk delete handles at most 500 hosts per request', async () => {
    writeDataSync(CONFIG_KEY, { subnets: [], offlineDeleteDays: 1 });
    clearInventory();
    const ips = [];
    for (let i = 1; i <= 254; i++) ips.push(`10.75.1.${i}`);
    for (let i = 1; i <= 254; i++) ips.push(`10.75.2.${i}`);
    for (let i = 1; i <= 2; i++) ips.push(`10.75.3.${i}`);
    for (const ip of ips) store.upsertScanResult(ip, { status: 'offline', offlineSince: daysAgo(30) });
    const dry = await request(app).post('/api/inventory/bulk-delete-offline').set(bearer(op)).send({ days: 2, dryRun: true });
    assert.equal(dry.body.total, 510);
    assert.equal(dry.body.truncated, true);
    assert.equal(dry.body.ips.length, 500);
});

// --- Prometheus / deleted flag -------------------------------------------------------------------

test('a deleted host is not re-added to Prometheus by auto sync (scan and telemetry callers); an IP reused by another host is', async () => {
    writeDataSync(CONFIG_KEY, { subnets: [] });
    writeDataSync(META_KEY, {
        '10.76.1.1': { hostname: 'GONE', deleted: true, deletedNames: ['gone'] },
        '10.76.1.2': { hostname: 'OLD', deleted: true, deletedNames: ['old'] }
    });
    await promHelper.saveTargetsSafely([], 'test_seed');

    // telemetry-style call (no collector)
    assert.equal(await inv.autoSyncPrometheusTarget('10.76.1.1', 'gone', 'linux'), false);
    // scan-style call (collector)
    const collector = [];
    assert.equal(await inv.autoSyncPrometheusTarget('10.76.1.1', 'GONE', 'linux', { collector }), false);
    assert.deepEqual(collector, []);
    assert.deepEqual(promHelper.getTargetsSafely(), []);

    // the apply step re-checks too (flag set after collection)
    const apply = await inv.applyPrometheusAdditions([{ ip: '10.76.1.1', hostname: 'gone', targetOs: 'linux', port: 9100 }]);
    assert.deepEqual(apply, []);
    assert.deepEqual(promHelper.getTargetsSafely(), []);

    // IP reuse: another name on a deleted IP is a new server
    assert.equal(await inv.autoSyncPrometheusTarget('10.76.1.2', 'BRAND-NEW', 'linux'), true);
    assert.deepEqual(promHelper.getTargetsSafely().map(t => t.labels.addr), ['10.76.1.2']);
    assert.equal(meta()['10.76.1.2'].deleted, false);
});

function scanDeps(online) {
    return {
        pingCheck: async (ip) => online.has(ip),
        tcpCheck: async (ip, port) => online.has(ip) && port === 22,
        runPowerShell: async () => '{}',
        executeSSH: async () => ({ stdout: 'web-01|Ubuntu 22.04|8|4|UTC', stderr: '', code: 0, success: true })
    };
}

test('a scan collects Prometheus additions and writes them ONCE; deleted servers are skipped', async () => {
    process.env.LINUX_ADMIN_USER = 'u'; process.env.LINUX_ADMIN_PWD = 'p';
    try {
        writeDataSync(CONFIG_KEY, { subnets: ['10.77.1:1~6'], autoSyncPrometheus: true });
        writeDataSync(META_KEY, { '10.77.1.4': { hostname: 'web-01', deleted: true, deletedNames: ['web-01'] } });
        await promHelper.saveTargetsSafely([target('10.77.9.9')], 'test_seed');
        promCalls.length = 0;
        const online = new Set(['10.77.1.1', '10.77.1.2', '10.77.1.3', '10.77.1.4']);
        await inv.runScan({ trigger: 'manual', requestedBy: 't', deps: scanDeps(online) });
        const added = promHelper.getTargetsSafely().map(t => t.labels.addr).sort();
        assert.deepEqual(added, ['10.77.1.1', '10.77.1.2', '10.77.1.3', '10.77.9.9'], 'deleted 10.77.1.4 is not re-added; existing target kept');
        assert.equal(promCalls.filter(r => r === 'inventory_auto_sync').length, 1, 'one read-modify-write for the whole scan');
    } finally { delete process.env.LINUX_ADMIN_USER; delete process.env.LINUX_ADMIN_PWD; }
});

test('an aborted scan still registers the hosts it completed (one write)', async () => {
    process.env.LINUX_ADMIN_USER = 'u'; process.env.LINUX_ADMIN_PWD = 'p';
    try {
        writeDataSync(CONFIG_KEY, { subnets: ['10.78.1:1~20'], probe: { concurrencyPerSubnet: 1 } });
        writeDataSync(META_KEY, {});
        await promHelper.saveTargetsSafely([], 'test_seed');
        promCalls.length = 0;
        const online = new Set(['10.78.1.1', '10.78.1.2', '10.78.1.15']);
        const deps = scanDeps(online);
        const ssh = deps.executeSSH;
        deps.executeSSH = async (ip, ...rest) => { if (ip === '10.78.1.2') inv.abortScan(); return ssh(ip, ...rest); };
        await inv.runScan({ deps });
        assert.deepEqual(promHelper.getTargetsSafely().map(t => t.labels.addr).sort(), ['10.78.1.1', '10.78.1.2']);
        assert.equal(promCalls.filter(r => r === 'inventory_auto_sync').length, 1);
    } finally { delete process.env.LINUX_ADMIN_USER; delete process.env.LINUX_ADMIN_PWD; }
});

test('concurrent Prometheus writers are not lost: scan additions, a manual add and a VIP link interleave safely', async () => {
    writeDataSync(META_KEY, {});
    await promHelper.saveTargetsSafely([target('10.79.1.50'), target('10.79.1.99')], 'test_seed');
    const items = ['10.79.1.1', '10.79.1.2', '10.79.1.3'].map(ip => ({ ip, hostname: ip, targetOs: 'linux', port: 9100 }));
    await Promise.all([
        inv.applyPrometheusAdditions(items),
        promHelper.updateTargetsSafely((t) => ({ targets: [...t, target('10.79.1.77')] }), 'test_manual_add'),
        linkVip('10.79.1.1', '10.79.1.99', 'tester')
    ]);
    const addrs = promHelper.getTargetsSafely().map(t => t.labels.addr).sort();
    assert.deepEqual(addrs, ['10.79.1.1', '10.79.1.2', '10.79.1.3', '10.79.1.50', '10.79.1.77'], 'VIP .99 removed, every addition kept');
});

// --- VIP set -------------------------------------------------------------------------------------

test('buildVipSet agrees with isIpVip over meta, cmdb table, IPAM and inventory', async () => {
    writeDataSync(META_KEY, { '10.80.1.2': { isVip: true }, '10.80.1.1': { secondaryIps: ['10.80.1.3'] } });
    cmdb.upsertCmdbServer({ ip: '10.80.1.4', hostname: 'x', isVip: true }, 'MANUAL');
    seedIpam({ '10.80.1.5': 'vip', '10.80.1.6': 'used' });
    store.upsertScanResult('10.80.1.7', { status: 'online' });
    store.setVipLink('10.80.1.7', '10.80.1.1');
    const set = buildVipSet();
    for (const ip of ['10.80.1.1', '10.80.1.2', '10.80.1.3', '10.80.1.4', '10.80.1.5', '10.80.1.6', '10.80.1.7', '10.80.1.8']) {
        assert.equal(isIpVip(ip, [], { vipSet: set }), isIpVip(ip), `vip set vs full lookup for ${ip}`);
    }
    assert.equal(set.has('10.80.1.3'), true);
    assert.equal(set.has('10.80.1.5'), true);
    assert.equal(set.has('10.80.1.6'), false);
});

// --- reconcile scope -----------------------------------------------------------------------------

test('reconcile only touches addresses inside the scanned ranges, and only online hosts refresh their CMDB row', async () => {
    process.env.LINUX_ADMIN_USER = 'u'; process.env.LINUX_ADMIN_PWD = 'p';
    try {
        writeDataSync(META_KEY, {});
        writeDataSync(CONFIG_KEY, { subnets: ['10.81.1:1~10', '10.82.1:1~10'], autoSyncPrometheus: false });
        for (const ip of ['10.81.1.1', '10.81.1.2', '10.81.1.3', '10.81.1.50', '10.82.1.3', '10.99.9.9']) cmdb.upsertCmdbServer({ ip, hostname: `h-${ip}` }, 'MANUAL');
        // 10.81.1.2 was known offline before; its CMDB row has an old discovery time
        store.upsertScanResult('10.81.1.2', { status: 'offline', offlineSince: daysAgo(1) });
        libDb.prepare("UPDATE cmdb_servers SET lastDiscoveredAt = '2020-01-01T00:00:00.000Z'").run();

        // full scan: .1 online, .2 offline (in range), .3 offline (in range), .50 and 10.99.9.9 not in any scanned range
        await inv.runScan({ deps: scanDeps(new Set(['10.81.1.1'])) });
        assert.equal(cmdbRow('10.81.1.1').lifecycleStatus, 'active');
        assert.ok(cmdbRow('10.81.1.1').lastDiscoveredAt > '2021', 'online host refreshed');
        assert.equal(cmdbRow('10.81.1.2').lifecycleStatus, 'missing', 'in range, did not answer');
        assert.equal(cmdbRow('10.81.1.2').lastDiscoveredAt, '2020-01-01T00:00:00.000Z', 'offline host is not refreshed');
        assert.equal(cmdbRow('10.81.1.3').lifecycleStatus, 'missing');
        assert.equal(cmdbRow('10.81.1.50').lifecycleStatus, 'active', 'outside the scanned range');
        assert.equal(cmdbRow('10.99.9.9').lifecycleStatus, 'active', 'other network untouched');

        // partial scan of one IP: only that address can change
        libDb.prepare("UPDATE cmdb_servers SET lifecycleStatus = 'active'").run();
        await inv.runScan({ scope: { ip: '10.81.1.3' }, deps: scanDeps(new Set()) });
        assert.equal(cmdbRow('10.81.1.3').lifecycleStatus, 'missing');
        assert.equal(cmdbRow('10.81.1.1').lifecycleStatus, 'active', 'not part of the partial scan');
        assert.equal(cmdbRow('10.82.1.3').lifecycleStatus, 'active');

        // aborted scan: addresses that were never reached are not marked missing
        libDb.prepare("UPDATE cmdb_servers SET lifecycleStatus = 'active'").run();
        const deps = scanDeps(new Set());
        let n = 0;
        deps.pingCheck = async () => { if (++n === 2) inv.abortScan(); return false; };
        await inv.runScan({ scope: { subnet: '10.81.1' }, deps });
        assert.equal(cmdbRow('10.81.1.1').lifecycleStatus, 'active', 'online before: a single miss does not make it missing yet');
        assert.equal(cmdbRow('10.81.1.2').lifecycleStatus, 'missing');
        assert.equal(cmdbRow('10.81.1.3').lifecycleStatus, 'active', 'scan stopped before .3');
    } finally { delete process.env.LINUX_ADMIN_USER; delete process.env.LINUX_ADMIN_PWD; }
});

// --- fix round 1 ---------------------------------------------------------------------------------

test('I2: bulk delete acts only on the confirmed list; a host that became eligible after the dry run is not deleted, blocked ones are reported', async () => {
    writeDataSync(CONFIG_KEY, { subnets: [], offlineDeleteDays: 7 });
    clearInventory();
    seedHost('10.83.1.1', { offlineDaysAgo: 30 });
    seedHost('10.83.1.2', { offlineDaysAgo: 3 });
    seedHost('10.83.1.3', { offlineDaysAgo: 30 });
    const dry = await request(app).post('/api/inventory/bulk-delete-offline').set(bearer(op)).send({ days: 10 });
    assert.deepEqual(dry.body.ips.sort(), ['10.83.1.1', '10.83.1.3']);
    // .2 becomes eligible after the dry run; .3 stops being eligible (back online)
    store.upsertScanResult('10.83.1.2', { status: 'offline', offlineSince: daysAgo(50) });
    store.upsertScanResult('10.83.1.3', { status: 'online' });
    const real = await request(app).post('/api/inventory/bulk-delete-offline').set(bearer(op)).send({ days: 10, dryRun: false, ips: dry.body.ips });
    assert.equal(real.status, 200, JSON.stringify(real.body));
    assert.deepEqual(real.body.deleted, ['10.83.1.1']);
    assert.equal(real.body.skipped.length, 1);
    assert.equal(real.body.skipped[0].ip, '10.83.1.3');
    assert.match(real.body.skipped[0].reason, /not offline/);
    assert.ok(store.getHost('10.83.1.2'), 'never confirmed: not deleted');
    assert.ok(store.getHost('10.83.1.3'), 'no longer eligible: not deleted');
});

test('M1: a scan that sees an offline host with an empty offlineSince sets it (legacy rows become deletable later)', () => {
    store.upsertScanResult('10.84.1.1', { status: 'online' });
    store.getHandle().prepare("UPDATE inventory_hosts SET status = 'offline', offlineSince = NULL WHERE ip = '10.84.1.1'").run();
    assert.equal(store.getHost('10.84.1.1').offlineSince, undefined);
    store.markOfflineBatch(['10.84.1.1']);
    const since = store.getHost('10.84.1.1').offlineSince;
    assert.ok(since);
    store.markOfflineBatch(['10.84.1.1']);
    assert.equal(store.getHost('10.84.1.1').offlineSince, since, 'kept once set');
    store.getHandle().prepare("UPDATE inventory_hosts SET offlineSince = NULL WHERE ip = '10.84.1.1'").run();
    store.upsertScanResult('10.84.1.1', { status: 'offline' });
    assert.ok(store.getHost('10.84.1.1').offlineSince, 'upsert path sets it too');
});

test('C1: a server deleted mid-scan stays deleted (flag and deletedNames intact) when another IP is revived through the scan path', async () => {
    const { readDeletedMeta } = cmdb;
    writeDataSync(META_KEY, { '10.85.1.2': { hostname: 'OLD', deleted: true, deletedNames: ['old'] } });
    await promHelper.saveTargetsSafely([], 'test_seed');
    const snapshot = readDeletedMeta(); // start-of-scan snapshot
    // an operator deletes X while the scan runs
    writeDataSync(META_KEY, { ...readDeletedMeta(), '10.85.1.1': { hostname: 'X', deleted: true, deletedNames: ['x'], deletedReason: 'manual' } });
    // the scan reaches Y, announced by a new host name: legitimate IP reuse -> revive
    const collector = [];
    assert.equal(await inv.autoSyncPrometheusTarget('10.85.1.2', 'BRAND-NEW', 'linux', { collector, deletedMeta: snapshot }), true);
    assert.equal(meta()['10.85.1.2'].deleted, false);
    assert.equal(meta()['10.85.1.1'].deleted, true, 'X delete was not overwritten by the stale snapshot');
    assert.deepEqual(meta()['10.85.1.1'].deletedNames, ['x']);
    // X reached the collector before it was deleted: apply time must drop it
    const added = await inv.applyPrometheusAdditions([
        { ip: '10.85.1.1', hostname: 'x', probedHostname: 'x', targetOs: 'linux', port: 9100 },
        ...collector
    ]);
    assert.deepEqual(added.map(a => a.ip), ['10.85.1.2']);
    assert.deepEqual(promHelper.getTargetsSafely().map(t => t.labels.addr), ['10.85.1.2']);
    assert.equal(meta()['10.85.1.1'].deleted, true);
});

test('C1: a full scan with a mid-scan delete does not re-add the server to CMDB or Prometheus', async () => {
    process.env.LINUX_ADMIN_USER = 'u'; process.env.LINUX_ADMIN_PWD = 'p';
    try {
        writeDataSync(CONFIG_KEY, { subnets: ['10.86.1:1~4'], probe: { concurrencyPerSubnet: 1 } });
        writeDataSync(META_KEY, {});
        libDb.prepare("DELETE FROM cmdb_servers WHERE ip LIKE '10.86.1.%'").run();
        await promHelper.saveTargetsSafely([], 'test_seed');
        const online = new Set(['10.86.1.1', '10.86.1.2', '10.86.1.3']);
        const deps = scanDeps(online);
        const origSsh = deps.executeSSH;
        deps.executeSSH = async (ip, ...rest) => {
            if (ip === '10.86.1.3') { // deleted by an operator after .2 was probed
                writeDataSync(META_KEY, { ...meta(), '10.86.1.2': { hostname: 'web-01', deleted: true, deletedNames: ['web-01'], deletedReason: 'manual' } });
            }
            return origSsh(ip, ...rest);
        };
        await inv.runScan({ deps });
        assert.equal(meta()['10.86.1.2'].deleted, true);
        assert.deepEqual(meta()['10.86.1.2'].deletedNames, ['web-01']);
        assert.equal(cmdbRow('10.86.1.2'), undefined, 'not re-added to CMDB');
        assert.ok(cmdbRow('10.86.1.1'));
        assert.deepEqual(promHelper.getTargetsSafely().map(t => t.labels.addr).sort(), ['10.86.1.1', '10.86.1.3']);
    } finally { delete process.env.LINUX_ADMIN_USER; delete process.env.LINUX_ADMIN_PWD; }
});

test('I1: an unknown probed hostname never revives a deleted server (apply time, IP is only the label)', async () => {
    writeDataSync(META_KEY, { '10.87.1.1': { hostname: 'WEB01', deleted: true, deletedNames: ['web01'] } });
    await promHelper.saveTargetsSafely([], 'test_seed');
    const added = await inv.applyPrometheusAdditions([{ ip: '10.87.1.1', hostname: '10.87.1.1', probedHostname: '', targetOs: 'win', port: 9182 }]);
    assert.deepEqual(added, []);
    assert.equal(meta()['10.87.1.1'].deleted, true);
    assert.deepEqual(meta()['10.87.1.1'].deletedNames, ['web01']);
    // collection path: no hostname -> collector stays empty, flag intact
    const collector = [];
    assert.equal(await inv.autoSyncPrometheusTarget('10.87.1.1', '', 'win', { collector }), false);
    assert.deepEqual(collector, []);
    assert.equal(meta()['10.87.1.1'].deleted, true);
    assert.deepEqual(promHelper.getTargetsSafely(), []);
});

test('M5: SuperAdmin force via ?force=true is audited; an Operator is refused', async () => {
    writeDataSync(CONFIG_KEY, { subnets: [], offlineDeleteDays: 7 });
    seedHost('10.200.1.1', { offlineDaysAgo: 1 });
    await request(app).delete('/api/inventory/server/10.200.1.1?force=true').set(bearer(op)).expect(403);
    const logger = require('../../lib/logger');
    const lines = [];
    const realAudit = logger.auditLog;
    logger.auditLog = (user, mod, action) => { lines.push(`${user}|${mod}|${action}`); };
    let r;
    try { r = await request(app).delete('/api/inventory/server/10.200.1.1?force=true').set(bearer(admin)); } finally { logger.auditLog = realAudit; }
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(lines.some(l => /^superadmin\|Inventory\|FORCE deleted server 10.200.1\.1/.test(l)));
});
