require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const { readDataSync, writeDataSync } = require('../../lib/db');
const { setPaid, setFree } = require('../helpers/license');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { setPaid(); await dbManager.closeDB(); });

test('free: contract notices are neither sent nor marked as sent', async (t) => {
    const notifier = require('../../services/contractExpiryNotifier');
    const logger = require('../../lib/logger');
    const sent = [];
    t.mock.method(logger, 'sendTelegramAlert', async (msg) => { sent.push(msg); });
    writeDataSync('data_center/contracts.json', [{ id: 'c1', name: 'Support', vendor: 'Example', endDate: '2026-12-01', status: 'active' }]);
    writeDataSync(notifier.STATE_KEY, {});
    setFree();
    assert.deepEqual(await notifier.tick(new Date('2026-11-16T10:00:00'), { force: true }), { skipped: 'license' });
    assert.deepEqual(readDataSync(notifier.STATE_KEY), {});
    assert.equal(sent.length, 0);
    setPaid();
});

test('free: password expiry notices do not claim the day; a manual run answers 403', async (t) => {
    const powershell = require('../../lib/powershell');
    const mailer = require('../../lib/mailer');
    t.mock.method(console, 'log', () => {});
    t.mock.method(powershell, 'runPowerShell', async () => JSON.stringify({ scanned: 0, accounts: [] }));
    t.mock.method(mailer, 'deliverMail', async () => ({}));
    const notifier = require('../../services/pwdExpiryNotifier');
    const ENV = {
        AD_ADMIN_USER: 'CORP\svc-vanguard', AD_ADMIN_PWD: 'S3cret-test', AD_DC_HOST: 'dc01.example.test',
        MAIL_RELAY_SERVER: 'smtp.example.test', MAIL_RELAY_SENDER: 'it@example.test', MAIL_RELAY_RECIPIENT: 'admin@example.test',
        PWD_NOTIFY_ENABLED: 'true', PWD_NOTIFY_TIME: '09:00', PWD_NOTIFY_DAYS: '14,7,3,2,1', PWD_NOTIFY_TEST_MODE: 'false',
        AD_OU_SEARCH: 'OU=Staff,DC=example,DC=test',
    };
    const saved = {};
    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);
    writeDataSync(notifier.KEY, {});
    try {
        setFree();
        const r = await notifier.tick(new Date(2026, 10, 16, 9, 30));
        assert.deepEqual(r, { skipped: 'license' });
        const doc = readDataSync(notifier.KEY, {});
        assert.equal(doc.schedule && doc.schedule.lastRunDate, undefined, 'the day must not be claimed');
        await assert.rejects(notifier.runNow('admin'), (err) => err.status === 403 && err.code === 'LICENSE_REQUIRED' && /paid license/.test(err.message));
    } finally {
        setPaid();
        for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        writeDataSync(notifier.KEY, {});
    }
});

test('free: network device backup, NetSearch import and scheduled tasks do not run', async (t) => {
    t.mock.method(console, 'log', () => {});
    const backups = require('../../lib/netDevices/backups');
    let ran = 0;
    t.mock.method(backups, 'scheduledRun', async () => { ran++; return {}; });
    setFree();
    assert.deepEqual(await require('../../services/netDeviceBackupScheduler').tick(new Date()), { skipped: 'license' });
    assert.equal(ran, 0);
    const ns = await require('../../services/netsearchScheduler').loadAllConfigs();
    assert.deepEqual(ns, { ok: false, error: 'NetSearch requires a paid license', disabled: true });
    setPaid();
});

test('free: scout agents receive no self-healing scripts', () => {
    const svc = require('../../services/telemetryIngestionService');
    const rules = [{ id: 'r1', type: 'service', target: 'Spooler', threshold: 1, remediationScript: 'Restart-Service Spooler', enabled: true }];
    setFree();
    const free = svc.__test.policiesFor(rules);
    setPaid();
    const paid = svc.__test.policiesFor(rules);
    assert.deepEqual(free, []);
    assert.equal(paid.length, 1);
});

test('free: a triggered scheduled task does not run; on paid it does', async (t) => {
    t.mock.method(console, 'log', () => {});
    const powershell = require('../../lib/powershell');
    let ran = 0;
    t.mock.method(powershell, 'runPowerShell', async () => { ran++; return 'ok'; });
    const sched = require('../../services/taskSchedulerService');
    const schedulerStore = require('../../lib/schedulerStore');
    writeDataSync(schedulerStore.TASKS_KEY, [{ id: 'lic-t1', name: 'License probe', targetType: 'local_ps', winCommand: 'Get-Date', enabled: true }]);
    const tick = () => new Promise((r) => setTimeout(r, 100));
    try {
        setFree();
        await sched.triggerTaskExecution('lic-t1');
        await tick();
        assert.equal(ran, 0);
        setPaid();
        await sched.triggerTaskExecution('lic-t1');
        await tick();
        assert.equal(ran, 1);
    } finally {
        setPaid();
        writeDataSync(schedulerStore.TASKS_KEY, []);
    }
});
