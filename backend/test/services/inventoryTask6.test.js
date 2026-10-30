require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const store = require('../../services/inventoryStore');
const history = require('../../services/inventoryHistory');
const inv = require('../../services/inventoryScheduler');
const cmdb = require('../../services/cmdbModel');
const webhookService = require('../../services/webhookService');
const logger = require('../../lib/logger');
const validation = require('../../lib/inventoryValidation');
const creds = require('../../lib/inventoryCredentials');
const { mapInventoryHostToCmdb } = require('../../services/inventoryCmdbMap');
const { writeDataSync, readDataSync } = require('../../lib/db');

const CONFIG_KEY = 'server_operation/oscheck/config.json';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => { process.env.LINUX_ADMIN_USER = 'root'; process.env.LINUX_ADMIN_PWD = 'default-pw'; logger.flushAllNotifyBatches(); logger.notifyBatchTiming.quietMs = 20; logger.notifyBatchTiming.maxWaitMs = 100; });

function makeDeps({ alive = [], ps, ssh } = {}) {
    const aliveSet = new Set(alive);
    return {
        tcpProbe: async (ip, port) => aliveSet.has(ip) && port === 22,
        icmpBatch: async () => [],
        runPowerShell: ps || (async () => '{}'),
        executeSSH: ssh || (async () => ({ stdout: 'lx1|Ubuntu 22.04|8|4|UTC', stderr: '', code: 0, success: true }))
    };
}
const capture = (t) => {
    const sent = [];
    t.mock.method(webhookService, 'triggerWebhooks', (message, moduleName, category) => sent.push({ message, moduleName, category }));
    return sent;
};
const flush = async () => { logger.flushAllNotifyBatches(); await wait(10); };

// --- CMDB mapping -------------------------------------------------------------------------------

test('mapping: cpu/mem/os/osVersion/fqdn/tags go to CMDB columns, empty values are never emitted', () => {
    const m = mapInventoryHostToCmdb({ ip: '10.1.1.5', hostname: 'srv1', os: 'linux', osname: 'Ubuntu 22.04', osVersion: '22.04', cpu: 4, mem: 16, domain: 'corp.example.com', timezone: 'UTC', tags: ['a', 'b'], status: 'online' });
    assert.equal(m.cpuCores, 4);
    assert.equal(m.memoryGB, 16);
    assert.equal(m.os, 'Ubuntu 22.04');
    assert.equal(m.osVersion, '22.04');
    assert.equal(m.fqdn, 'srv1.corp.example.com');
    assert.equal(m.tags, '["a","b"]');
    assert.equal(m.status, 'online');
    assert.equal(m.cpu, undefined);

    const e = mapInventoryHostToCmdb({ ip: '10.1.1.6', hostname: '', os: 'unknown', osname: '', cpu: 0, mem: '', domain: 'WORKGROUP', tags: [] });
    for (const k of ['hostname', 'os', 'cpuCores', 'memoryGB', 'fqdn', 'tags', 'osVersion']) assert.equal(e[k], undefined, k);
    assert.equal(mapInventoryHostToCmdb({ ip: '1.1.1.1', hostname: 'a.b.c', domain: 'corp.example.com' }).fqdn, undefined, 'hostname that is already an FQDN');
});

test('a scan writes the mapped fields to the CMDB and an empty probe value never blanks them', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.61.1:1~2'] });
    const ssh = async () => ({ stdout: 'lx1|Ubuntu 22.04|8|4|UTC', stderr: '', code: 0, success: true });
    await inv.runScan({ deps: makeDeps({ alive: ['10.61.1.1'], ssh }) });
    let row = cmdb.getCmdbServerByIp('10.61.1.1');
    assert.equal(row.cpuCores, 4);
    assert.equal(row.memoryGB, 8);
    assert.equal(row.os, 'Ubuntu 22.04');
    // second scan: the probe now fails (no specs) -> the CMDB keeps its values
    await inv.runScan({ deps: makeDeps({ alive: ['10.61.1.1'], ssh: async () => { throw new Error('boom'); } }) });
    row = cmdb.getCmdbServerByIp('10.61.1.1');
    assert.equal(row.cpuCores, 4);
    assert.equal(row.memoryGB, 8);
});

test('a CMDB server flagged deleted is not recreated by the mapped upsert', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.62.1:1~1'] });
    writeDataSync('server_operation/server_cmdb_meta.json', { '10.62.1.1': { deleted: true, deletedName: 'gone', hostname: 'gone' } });
    await inv.runScan({ deps: makeDeps({ alive: ['10.62.1.1'] }) });
    assert.equal(cmdb.getCmdbServerByIp('10.62.1.1'), null);
});

// --- history ------------------------------------------------------------------------------------

test('history: one scans row per run with counters, scope and field changes (old vs new)', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.63.1:1~3'] });
    let n = 0;
    const ssh = async () => ({ stdout: `lx1|Ubuntu 22.04|8|${n === 0 ? 4 : 8}|UTC`, stderr: '', code: 0, success: true });
    await inv.runScan({ trigger: 'manual', requestedBy: 'amy', deps: makeDeps({ alive: ['10.63.1.1'], ssh }) });
    n = 1;
    await inv.runScan({ trigger: 'schedule', requestedBy: 'SYSTEM', deps: makeDeps({ alive: ['10.63.1.1'], ssh }) });

    const { scans } = history.listScans({ limit: 10 });
    const second = scans[0]; const first = scans[1];
    assert.equal(second.trigger, 'schedule');
    assert.equal(second.requestedBy, 'SYSTEM');
    assert.equal(second.partial, false);
    assert.equal(second.online, 1);
    assert.equal(second.ipsChecked, 3);
    assert.equal(second.aborted, false);
    assert.ok(second.finishedAt && second.durationMs >= 0);
    assert.deepEqual(second.subnets, ['10.63.1:1~3']);
    assert.equal(first.newHosts, 1);
    assert.equal(second.newHosts, 0);

    const c1 = history.listScanChanges(first.id).changes;
    assert.deepEqual(c1.map(c => [c.ip, c.field, c.oldValue, c.newValue]), [['10.63.1.1', 'status', null, 'online']]);
    const c2 = history.listScanChanges(second.id).changes;
    assert.deepEqual(c2.map(c => [c.field, c.oldValue, c.newValue]), [['cpu', '4', '8']]);
    const perHost = history.listHostChanges('10.63.1.1').changes;
    assert.equal(perHost.length, 2);
    assert.equal(perHost[0].scanId, second.id, 'newest first');
});

test('history: offline transition is recorded as a status change; partial scan stores its scope; abort is flagged', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.64.1:1~2'], probe: { missesBeforeOffline: 1 } });
    await inv.runScan({ deps: makeDeps({ alive: ['10.64.1.1'] }) });
    await inv.runScan({ deps: makeDeps({ alive: [] }) });
    const { scans } = history.listScans({ limit: 1 });
    assert.equal(scans[0].disappeared, 1);
    assert.equal(scans[0].offline, 1);
    const ch = history.listScanChanges(scans[0].id).changes;
    assert.deepEqual(ch.map(c => [c.ip, c.field, c.oldValue, c.newValue]), [['10.64.1.1', 'status', 'online', 'offline']]);

    await inv.runScan({ scope: { ip: '10.64.1.2' }, requestedBy: 'bob', deps: makeDeps({ alive: [] }) });
    const partial = history.listScans({ limit: 1 }).scans[0];
    assert.equal(partial.partial, true);
    assert.deepEqual(partial.scope, { ip: '10.64.1.2' });
    assert.equal(partial.requestedBy, 'bob');
    assert.equal(partial.ipsChecked, 1);

    let pings = 0;
    await inv.runScan({ deps: { ...makeDeps(), icmpBatch: async (ips) => { pings++; inv.abortScan(); return []; } } });
    assert.equal(history.listScans({ limit: 1 }).scans[0].aborted, true);
});

test('history: pagination cursor and retention cleanup (batched)', async () => {
    const h = store.getHandle();
    history.ensureTables(h);
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(history.startScan({ trigger: 'manual', startedAt: old, subnets: [] }));
    history.recordChanges(ids[0], Array.from({ length: 7 }, (_, i) => ({ ip: `10.99.0.${i + 1}`, field: 'status', oldValue: 'a', newValue: 'b', at: old })));
    const page1 = history.listScans({ limit: 2 });
    assert.equal(page1.scans.length, 2);
    assert.ok(page1.nextBefore);
    const page2 = history.listScans({ limit: 2, before: page1.nextBefore });
    assert.ok(page2.scans.every(s => s.id < page1.nextBefore));

    assert.equal(history.retentionDays({ historyRetentionDays: 5 }), 30);
    assert.equal(history.retentionDays({ historyRetentionDays: 9999 }), 730);
    assert.equal(history.retentionDays({}), 180);
    const res = await history.cleanup({ retentionDays: 180, batchSize: 3 });
    assert.ok(res.scans >= 5 && res.changes >= 7);
    assert.equal(history.listScanChanges(ids[0]).total, 0);
    assert.equal(h.prepare('SELECT COUNT(*) AS c FROM inventory_scans WHERE id IN (?, ?)').get(ids[0], ids[1]).c, 0);
    // recent history is kept
    assert.ok(history.listScans({ limit: 1 }).scans.length >= 1);
});

// --- new / unknown host alert ------------------------------------------------------------------

test('new hosts: ONE summary notification per scan (category Inventory), none for known hosts or when disabled', async (t) => {
    const sent = capture(t);
    writeDataSync(CONFIG_KEY, { subnets: ['10.65.1:1~4'] });
    await inv.runScan({ deps: makeDeps({ alive: ['10.65.1.1', '10.65.1.2', '10.65.1.3'] }) });
    await flush();
    const msgs = sent.filter(s => /new \/ unknown/.test(s.message));
    assert.equal(msgs.length, 1, 'one summary, not one per host');
    assert.equal(msgs[0].category, 'Inventory');
    for (const ip of ['10.65.1.1', '10.65.1.2', '10.65.1.3']) assert.ok(msgs[0].message.includes(ip));
    assert.ok(msgs[0].message.includes('3 new'));

    // second scan: the hosts are known now (inventory, CMDB, IPAM) -> silence
    sent.length = 0;
    await inv.runScan({ deps: makeDeps({ alive: ['10.65.1.1', '10.65.1.2', '10.65.1.3'] }) });
    await flush();
    assert.equal(sent.filter(s => /new \/ unknown/.test(s.message)).length, 0);

    // disabled
    sent.length = 0;
    writeDataSync(CONFIG_KEY, { subnets: ['10.66.1:1~2'], newHostAlerts: false });
    await inv.runScan({ deps: makeDeps({ alive: ['10.66.1.1'] }) });
    await flush();
    assert.equal(sent.filter(s => /new \/ unknown/.test(s.message)).length, 0);
});

test('unknown host: online, already in the inventory, but neither in CMDB nor IPAM -> alerted', async (t) => {
    const sent = capture(t);
    store.upsertScanResult('10.67.1.9', { status: 'online', hostname: 'old', os: 'linux' });
    writeDataSync(CONFIG_KEY, { subnets: ['10.67.1:9~9'] });
    await inv.runScan({ deps: makeDeps({ alive: ['10.67.1.9'] }) });
    await flush();
    const msg = sent.find(s => /new \/ unknown/.test(s.message));
    assert.ok(msg && msg.message.includes('not in CMDB / IPAM'));
});

// --- per-subnet settings ----------------------------------------------------------------------

test('subnetSettings: validation, normalised keys, legacy subnetOffsets migrated on read', () => {
    const ok = validation.validateInventoryConfig({ subnetSettings: { '10.1.2:1~50': { concurrency: 8, tcpPorts: [22, 443], autoSyncPrometheus: false, credentialProfile: 'Lab 1', timezoneOffset: 8 }, '10.1.3': { concurrency: null } } });
    assert.equal(ok.valid, true);
    assert.deepEqual(Object.keys(ok.subnetSettings), ['10.1.2:1~50']);
    const bad = (s) => validation.validateInventoryConfig({ subnetSettings: s });
    assert.equal(bad({ '10.1.2; calc': { concurrency: 4 } }).valid, false);
    assert.equal(bad({ '10.1.2': { concurrency: 65 } }).valid, false);
    assert.equal(bad({ '10.1.2': { tcpPorts: [] } }).valid, false);
    assert.equal(bad({ '10.1.2': { autoSyncPrometheus: 'no' } }).valid, false);
    assert.equal(bad({ '10.1.2': { credentialProfile: '../x' } }).valid, false);
    assert.equal(bad({ '10.1.2': { timezoneOffset: 99 } }).valid, false);
    assert.equal(bad([]).valid, false);
    assert.equal(validation.validateInventoryConfig({ newHostAlerts: 'x' }).valid, false);
    assert.equal(validation.validateInventoryConfig({ historyRetentionDays: 10 }).valid, false);
    assert.equal(validation.validateInventoryConfig({ historyRetentionDays: 731 }).valid, false);
    assert.equal(validation.validateInventoryConfig({ historyRetentionDays: 180 }).valid, true);

    assert.deepEqual(validation.getSubnetSettings({ timezoneCheck: { subnetOffsets: [{ subnet: '10.5.5.*', targetOffset: '9' }] }, subnetSettings: { '10.6.6': { concurrency: 3 } } }), { '10.6.6': { concurrency: 3 } }, 'legacy offsets are not merged into the stored map');
    const legacyCfg = { timezoneCheck: { subnetOffsets: [{ subnet: '10.5.5.*', targetOffset: '9' }, { subnet: '10.5.5.7, 10.8.8.0/24', targetOffset: '-5' }] } };
    assert.equal(validation.legacyOffsetFor(legacyCfg, '10.5.5.20'), 9);
    assert.equal(validation.legacyOffsetFor(legacyCfg, '10.5.5.7'), -5, 'a single-IP row beats the /24 row');
    assert.equal(validation.legacyOffsetFor(legacyCfg, '10.8.8.1'), -5);
    assert.equal(validation.legacyOffsetFor(legacyCfg, '10.9.9.1'), null);
    // M-8: whitespace is not a number
    assert.equal(bad({ '10.1.2': { timezoneOffset: '  ' } }).valid, false);
    assert.equal(bad({ '10.1.2': { timezoneOffset: ' 8 ' } }).valid, true);

    const check = validation.validateInventoryConfig({ subnetSettings: { '10.1.2': { concurrency: 4 } } });
    assert.deepEqual(validation.mergeConfigPatch({ subnetSettings: { '9.9.9': { concurrency: 2 } } }, { subnetSettings: { '10.1.2': { concurrency: 4 } } }, check).subnetSettings, { '10.1.2': { concurrency: 4 } });
});

test('resolveProbeSettings applies per-subnet overrides (exact entry, whole /24, IP inside a range)', () => {
    const cfg = { probe: { concurrencyPerSubnet: 16, tcpPorts: [22] }, subnetSettings: { '10.1.2': { concurrency: 4, tcpPorts: [443], autoSyncPrometheus: false, credentialProfile: 'P', timezoneOffset: 8 }, '10.1.2:100~110': { concurrency: 2 } } };
    const a = validation.resolveProbeSettings(cfg, '10.1.2:5~9');
    assert.equal(a.concurrencyPerSubnet, 4);
    assert.deepEqual(a.tcpPorts, [443]);
    assert.equal(a.autoSyncPrometheus, false);
    assert.equal(a.credentialProfile, 'P');
    assert.equal(a.timezoneOffset, 8);
    assert.equal(validation.resolveProbeSettings(cfg, '10.1.2:100~110').concurrencyPerSubnet, 2);
    assert.equal(validation.resolveProbeSettings(cfg, '10.9.9').concurrencyPerSubnet, 16);
    assert.equal(validation.resolveProbeSettings(cfg, '10.9.9').autoSyncPrometheus, undefined);
    assert.equal(validation.resolveProbeSettings(cfg).concurrencyPerSubnet, 16);
});

test('a scan uses the per-subnet tcp ports', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.68.1:1~1', '10.68.2:1~1'], subnetSettings: { '10.68.2': { tcpPorts: [8080] } } });
    const seen = [];
    const deps = { ...makeDeps(), tcpProbe: async (ip, port) => { seen.push(`${ip}:${port}`); return false; } };
    await inv.runScan({ deps });
    assert.ok(seen.includes('10.68.2.1:8080') && !seen.includes('10.68.2.1:22'));
    assert.ok(seen.includes('10.68.1.1:22') && !seen.includes('10.68.1.1:8080'));
});

// --- credential profiles ------------------------------------------------------------------------

test('credential profiles: encrypted at rest, never returned, resolution profile -> default (one helper)', async () => {
    delete process.env.AD_ADMIN_USER; delete process.env.AD_ADMIN_PWD; delete process.env.LINUX_ADMIN_USER; delete process.env.LINUX_ADMIN_PWD;
    process.env.AD_ADMIN_USER = 'defwin'; process.env.AD_ADMIN_PWD = 'defwinpw';
    process.env.LINUX_ADMIN_USER = 'deflx'; process.env.LINUX_ADMIN_PWD = 'deflxpw';
    try {
        assert.deepEqual(creds.putProfile('bad/name', {}).errors.length, 1);
        const r = creds.putProfile('Lab 1', { winUser: 'labwin', winPassword: 'S3cret!', linuxUser: 'lablx', linuxPassword: 'L1nux' }, 'root');
        assert.equal(r.created, true);
        assert.deepEqual(r.changed.sort(), ['linuxPassword', 'linuxUser', 'winPassword', 'winUser']);
        const pub = JSON.stringify(creds.listProfiles());
        assert.ok(!pub.includes('S3cret!') && !pub.includes('L1nux'));
        assert.deepEqual(creds.listProfiles().map(p => [p.name, p.hasWinPassword, p.hasLinuxPassword]), [['Lab 1', true, true]]);
        const raw = JSON.stringify(readDataSync(creds.PROFILES_KEY, {}));
        assert.ok(!raw.includes('S3cret!') && !raw.includes('L1nux'), 'no plaintext password in the stored document');
        assert.ok(raw.includes('enc:'));
        assert.equal(creds.getProfile('Lab 1').winPassword, 'S3cret!');

        const cfg = { subnetSettings: { '10.7.7': { credentialProfile: 'Lab 1' } } };
        const inProfile = creds.resolveCredentials(cfg, '10.7.7:1~10');
        assert.equal(inProfile.source, 'profile:Lab 1');
        assert.equal(inProfile.winUser, 'labwin');
        assert.equal(inProfile.linuxPassword, 'L1nux');
        assert.equal(creds.resolveCredentials(cfg, '10.7.7.55').winPassword, 'S3cret!', 'a single IP resolves through its subnet');
        const other = creds.resolveCredentials(cfg, '10.8.8.1');
        assert.equal(other.source, 'default');
        assert.equal(other.winUser, 'defwin');
        assert.equal(other.linuxPassword, 'deflxpw');

        // password semantics: undefined keeps, '' clears
        creds.putProfile('Lab 1', { winUser: 'labwin2' });
        assert.equal(creds.getProfile('Lab 1').winPassword, 'S3cret!');
        creds.putProfile('Lab 1', { winPassword: '' });
        assert.equal(creds.getProfile('Lab 1').winPassword, '');
        assert.equal(creds.resolveCredentials(cfg, '10.7.7').winUser, 'defwin', 'incomplete pair falls back to the default for that OS');
        assert.deepEqual(creds.subnetsUsingProfile(cfg, 'Lab 1'), ['10.7.7']);
        assert.equal(creds.deleteProfile('Lab 1'), true);
        assert.equal(creds.deleteProfile('Lab 1'), false);
    } finally {
        delete process.env.AD_ADMIN_USER; delete process.env.AD_ADMIN_PWD; delete process.env.LINUX_ADMIN_USER; delete process.env.LINUX_ADMIN_PWD;
    }
});

test('default credentials come from the .env (readEnv, decrypted) before process.env; an enc: value in process.env is decrypted, not used literally', () => {
    process.env.LINUX_ADMIN_PWD = 'enc:' + require('../../lib/crypto').encryptText('from-process');
    try {
        assert.equal(creds.readDefaultCredentials({ readEnv: () => ({}) }).linuxPassword, 'from-process');
        assert.equal(creds.readDefaultCredentials({ readEnv: () => ({ LINUX_ADMIN_PWD: 'from-env-file' }) }).linuxPassword, 'from-env-file');
    } finally { delete process.env.LINUX_ADMIN_PWD; }
});

test('the scanner uses the subnet credential profile for SSH', async () => {
    delete process.env.LINUX_ADMIN_USER; delete process.env.LINUX_ADMIN_PWD;
    creds.putProfile('ScanProf', { linuxUser: 'profuser', linuxPassword: 'profpw' });
    writeDataSync(CONFIG_KEY, { subnets: ['10.69.1:1~1', '10.69.2:1~1'], subnetSettings: { '10.69.1': { credentialProfile: 'ScanProf' } } });
    const used = [];
    const ssh = async (ip, user, pwd) => { used.push([ip, user, pwd]); return { stdout: 'h|Ubuntu|8|4|UTC', stderr: '', code: 0, success: true }; };
    await inv.runScan({ deps: makeDeps({ alive: ['10.69.1.1', '10.69.2.1'], ssh }) });
    assert.deepEqual(used.filter(u => u[0] === '10.69.1.1'), [['10.69.1.1', 'profuser', 'profpw']]);
    assert.equal(used.find(u => u[0] === '10.69.2.1'), undefined, 'no default credentials configured: that host is not even tried');
    creds.deleteProfile('ScanProf');
});
