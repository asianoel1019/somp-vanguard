require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const store = require('../../services/inventoryStore');
const history = require('../../services/inventoryHistory');
const inv = require('../../services/inventoryScheduler');
const webhookService = require('../../services/webhookService');
const logger = require('../../lib/logger');
const validation = require('../../lib/inventoryValidation');
const creds = require('../../lib/inventoryCredentials');
const { writeDataSync } = require('../../lib/db');

const CONFIG_KEY = 'server_operation/oscheck/config.json';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => { process.env.LINUX_ADMIN_USER = 'root'; process.env.LINUX_ADMIN_PWD = 'default-pw'; logger.flushAllNotifyBatches(); logger.notifyBatchTiming.quietMs = 20; logger.notifyBatchTiming.maxWaitMs = 100; });

function makeDeps({ alive = [], ssh } = {}) {
    const aliveSet = new Set(alive);
    return {
        tcpProbe: async (ip, port) => aliveSet.has(ip) && port === 22,
        icmpBatch: async () => [],
        runPowerShell: async () => '{}',
        executeSSH: ssh || (async () => ({ stdout: 'lx1|Ubuntu 22.04|8|4|UTC', stderr: '', code: 0, success: true }))
    };
}
const capture = (t) => {
    const sent = [];
    t.mock.method(webhookService, 'triggerWebhooks', (message, moduleName, category) => sent.push({ message, moduleName, category }));
    return sent;
};
const flush = async () => { logger.flushAllNotifyBatches(); await wait(10); };
const NEW_RE = /new \/ unknown/;

test('I-1: legacy (Timezone tab) offsets keep working next to subnetSettings; a single-IP row beats the /24 row; settings are the fallback', async () => {
    let mail = null;
    const hosts = [
        { ip: '10.5.5.20', hostname: 'a', status: 'online', timezone: '(UTC+08:00) Taipei', os: 'win' },
        { ip: '10.5.5.7', hostname: 'b', status: 'online', timezone: '(UTC+09:00) Tokyo', os: 'win' },
        { ip: '10.6.6.1', hostname: 'c', status: 'online', timezone: '(UTC+08:00) Taipei', os: 'win' }
    ];
    const run = (config) => inv.sendComplianceReport({ timezoneCheck: { targetOffset: '8', ...(config.timezoneCheck || {}) }, subnetSettings: config.subnetSettings }, { getAllSubnetData: () => hosts, sendMail: async (m) => { mail = m; } });
    // legacy /24 row says +9, a single-IP row says +8 for .7, while subnetSettings (saved from another tab) says +8
    await run({ timezoneCheck: { subnetOffsets: [{ subnet: '10.5.5.*', targetOffset: '9' }, { subnet: '10.5.5.7', targetOffset: '8' }] }, subnetSettings: { '10.5.5': { timezoneOffset: 8 } } });
    assert.ok(mail.html.includes('10.5.5.20'), '.20 follows the legacy /24 row (+9), not the settings value');
    assert.ok(mail.html.includes('10.5.5.7'), '.7 follows its single-IP row (+8)');
    assert.ok(!mail.html.includes('10.6.6.1'));
    // no legacy row: subnetSettings applies
    await run({ subnetSettings: { '10.6.6': { timezoneOffset: 9 } } });
    assert.ok(mail.html.includes('10.6.6.1'));
});

test('I-3: worker start closes scan history rows left open, as interrupted', async () => {
    const open = history.startScan({ trigger: 'schedule', subnets: [] });
    const done = history.startScan({ trigger: 'manual', subnets: [] });
    history.finishScan(done, { durationMs: 5 });
    await inv.recoverInterruptedStatus();
    const rows = history.listScans({ limit: 50 }).scans;
    const o = rows.find(r => r.id === open);
    assert.ok(o.finishedAt && o.aborted === true && o.interrupted === true);
    assert.equal(rows.find(r => r.id === done).interrupted, false);
    assert.equal(history.closeInterrupted(), 0);
    const running = history.startScan({ trigger: 'manual', subnets: [] });
    assert.equal(history.closeInterrupted({ exceptId: running }), 0, 'the run that is starting is excluded');
});

test('I-4: an undecryptable profile password reports a specsError and never falls back to the default credentials', async () => {
    writeDataSync(creds.PROFILES_KEY, { Broken: { winUser: '', linuxUser: 'dmz', linuxPassword_enc: 'enc:00:11:22', winPassword_enc: '' } });
    const r = creds.resolveCredentials({ subnetSettings: { '10.70.1': { credentialProfile: 'Broken' } } }, '10.70.1.5');
    assert.equal(r.linuxPassword, '');
    assert.equal(r.linuxUser, '');
    assert.match(r.linuxError, /credential profile 'Broken' cannot be decrypted/);
    assert.equal(r.source, 'profile:Broken');
    writeDataSync(CONFIG_KEY, { subnets: ['10.70.1:5~5'], subnetSettings: { '10.70.1': { credentialProfile: 'Broken' } } });
    const used = [];
    await inv.runScan({ deps: makeDeps({ alive: ['10.70.1.5'], ssh: async (...a) => { used.push(a); return { stdout: 'h|U|1|1|UTC', stderr: '', code: 0, success: true }; } }) });
    assert.deepEqual(used, [], 'no SSH attempt with the default credentials');
    assert.match(store.getHost('10.70.1.5').error, /cannot be decrypted/);
    writeDataSync(creds.PROFILES_KEY, {});
});

test('I-5: findSubnetSettings matches an IP / single-IP range against range keys (narrowest wins); the IP rescan uses the range profile', async () => {
    const cfg = { subnetSettings: { '10.71.1': { concurrency: 1 }, '10.71.1:1~100': { concurrency: 2 }, '10.71.1:5~9': { concurrency: 3 } } };
    assert.equal(validation.findSubnetSettings(cfg, '10.71.1.7').concurrency, 3);
    assert.equal(validation.findSubnetSettings(cfg, '10.71.1.50').concurrency, 2);
    assert.equal(validation.findSubnetSettings(cfg, '10.71.1.200').concurrency, 1);
    assert.equal(validation.findSubnetSettings(cfg, '10.71.1:50~50').concurrency, 2, 'a single-IP scan range resolves like the IP');
    assert.equal(validation.findSubnetSettings(cfg, '10.71.1:5~9').concurrency, 3);
    assert.equal(validation.findSubnetSettings(cfg, '10.71.1:1~100').concurrency, 2);
    assert.equal(validation.findSubnetSettings(cfg, '10.99.1.1'), null);

    creds.putProfile('LinuxOps', { linuxUser: 'ops', linuxPassword: 'opspw' });
    writeDataSync(CONFIG_KEY, { subnets: ['10.71.1:1~100'], subnetSettings: { '10.71.1:1~100': { credentialProfile: 'LinuxOps' } } });
    const used = [];
    await inv.runScan({ scope: { ip: '10.71.1.5' }, deps: makeDeps({ alive: ['10.71.1.5'], ssh: async (ip, u, p) => { used.push([u, p]); return { stdout: 'h|U|1|1|UTC', stderr: '', code: 0, success: true }; } }) });
    assert.deepEqual(used, [['ops', 'opspw']]);
    creds.deleteProfile('LinuxOps');
});

test('M-1: unknown / empty placeholders and hostname case are not history changes', () => {
    const d = history.diffHost;
    assert.deepEqual(d({ os: 'win', hostname: 'Srv1', cpu: 4 }, { os: 'unknown', hostname: 'SRV1', cpu: '4' }), []);
    assert.deepEqual(d({ os: 'unknown' }, { os: 'win' }).map(c => [c.field, c.oldValue, c.newValue]), [['os', null, 'win']]);
    assert.deepEqual(d({ hostname: 'Unknown' }, { hostname: 'x' }).map(c => c.oldValue), [null]);
});

test('M-3: a deleted-flagged host that reappears raises no first-seen alert (the scan row still counts it)', async (t) => {
    const sent = capture(t);
    writeDataSync('server_operation/server_cmdb_meta.json', { '10.72.1.1': { deleted: true, deletedName: 'gone', hostname: 'gone' } });
    writeDataSync(CONFIG_KEY, { subnets: ['10.72.1:1~2'] });
    await inv.runScan({ deps: makeDeps({ alive: ['10.72.1.1', '10.72.1.2'] }) });
    await flush();
    const msg = sent.find(s => NEW_RE.test(s.message));
    assert.ok(msg && msg.message.includes('10.72.1.2') && !msg.message.includes('10.72.1.1'));
    assert.equal(history.listScans({ limit: 1 }).scans[0].newHosts, 2);
});

test('M-4: a history write failure does not hide the host from the new-host alert', async (t) => {
    const sent = capture(t);
    t.mock.method(history, 'recordChanges', () => { throw new Error('SQLITE_BUSY'); });
    writeDataSync(CONFIG_KEY, { subnets: ['10.73.1:1~1'] });
    await inv.runScan({ deps: makeDeps({ alive: ['10.73.1.1'] }) });
    await flush();
    assert.ok(sent.some(s => NEW_RE.test(s.message) && s.message.includes('10.73.1.1')));
    assert.equal(store.getHost('10.73.1.1').status, 'online');
});

test('M-2: orphan changes are removed only by the daily run (orphans: true)', async () => {
    const h = store.getHandle();
    history.ensureTables(h);
    h.prepare('INSERT INTO inventory_host_changes (scanId, ip, field, oldValue, newValue, at) VALUES (?, ?, ?, ?, ?, ?)').run(987654, '10.74.0.1', 'status', 'a', 'b', new Date().toISOString());
    await history.cleanup({ retentionDays: 180 });
    assert.equal(h.prepare('SELECT COUNT(*) AS c FROM inventory_host_changes WHERE scanId = 987654').get().c, 1);
    await history.cleanup({ retentionDays: 180, orphans: true, batchSize: 1 });
    assert.equal(h.prepare('SELECT COUNT(*) AS c FROM inventory_host_changes WHERE scanId = 987654').get().c, 0);
});

test('M-10: credential profile writes are serialised', async () => {
    const order = [];
    const a = creds.runExclusive(async () => { await wait(30); order.push('a'); });
    const b = creds.runExclusive(async () => { order.push('b'); });
    await Promise.all([a, b]);
    assert.deepEqual(order, ['a', 'b']);
});
