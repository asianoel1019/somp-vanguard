// Configuration backups: files + index, unchanged detection, retention, failures, removal, daily schedule.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dbMod = require('../../lib/db');
const dbManager = require('../../services/db');
const store = require('../../lib/netDevices/profileStore');
const registry = require('../../lib/netDevices');
const backups = require('../../lib/netDevices/backups');

const real = registry._drivers.fortigate;
let content = 'config system global\n    set hostname "fw1"\nend\n';
let fail = null;
let calls = 0;
const fake = { capabilities: ['summary'], backupConfig: async () => { calls += 1; if (fail) throw fail; return { content, format: 'conf' }; } };

test.before(async () => { await dbManager.initDB(); registry._drivers.fortigate = fake; });
test.after(async () => { registry._drivers.fortigate = real; delete process.env.NETDEVICE_BACKUP_KEEP; delete process.env.NETDEVICE_BACKUP_SCHEDULE; await dbManager.closeDB(); });
test.beforeEach(() => {
    dbMod.writeDataSync(store.KEY, {});
    dbMod.writeDataSync(backups.KEY, {});
    fs.rmSync(backups.rootDir(), { recursive: true, force: true });
    content = 'config system global\n    set hostname "fw1"\nend\n';
    fail = null;
    calls = 0;
    delete process.env.NETDEVICE_BACKUP_KEEP;
    delete process.env.NETDEVICE_BACKUP_SCHEDULE;
    store.saveProfile('d1', 'Firewall', { vendor: 'fortigate', mgmtHost: '192.0.2.1', token: 'tok-123456' }, 'a');
});

const at = (s) => new Date(`2026-11-04T${s}`);

test('a backup writes a file and an index entry without the contents', async () => {
    const r = await backups.runBackup('d1', { by: 'alice', now: at('01:02:03Z') });
    assert.equal(r.unchanged, false);
    assert.equal(r.backup.id, '20261104T010203Z');
    const file = path.join(backups.rootDir(), 'd1', r.backup.file);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    const idx = JSON.stringify(dbMod.readDataSync(backups.KEY, {}));
    assert.ok(!idx.includes('set hostname'));
    const list = backups.listBackups('d1');
    assert.equal(list.backups.length, 1);
    assert.equal(list.lastAttempt.ok, true);
    assert.equal(backups.readBackup('d1', r.backup.id).content, content);
});

test('an identical configuration is not stored again', async () => {
    await backups.runBackup('d1', { now: at('01:00:00Z') });
    const r = await backups.runBackup('d1', { now: at('02:00:00Z') });
    assert.equal(r.unchanged, true);
    const list = backups.listBackups('d1');
    assert.equal(list.backups.length, 1);
    assert.equal(list.backups[0].checkedAt, at('02:00:00Z').toISOString());
    assert.equal(list.lastAttempt.unchanged, true);
});

test('retention keeps the newest NETDEVICE_BACKUP_KEEP and deletes older files', async () => {
    process.env.NETDEVICE_BACKUP_KEEP = '2';
    for (let i = 0; i < 4; i += 1) {
        content = `config v${i}\nend\n`;
        await backups.runBackup('d1', { now: at(`0${i}:00:00Z`) });
    }
    const list = backups.listBackups('d1');
    assert.deepEqual(list.backups.map(b => b.id), ['20261104T030000Z', '20261104T020000Z']);
    assert.deepEqual(fs.readdirSync(path.join(backups.rootDir(), 'd1')).sort(), ['20261104T020000Z.conf', '20261104T030000Z.conf']);
});

test('diff between two backups', async () => {
    const a = await backups.runBackup('d1', { now: at('01:00:00Z') });
    content = 'config system global\n    set hostname "fw2"\nend\n';
    const b = await backups.runBackup('d1', { now: at('02:00:00Z') });
    const d = backups.diffBackups('d1', a.backup.id, b.backup.id);
    assert.equal(d.added, 1);
    assert.equal(d.removed, 1);
    assert.equal(backups.diffBackups('d1', a.backup.id, '20200101T000000Z'), null);
});

test('a failure is recorded without dropping the good backups; bad ids are refused', async () => {
    await backups.runBackup('d1', { now: at('01:00:00Z') });
    fail = Object.assign(new Error('The device did not answer'), { code: 'UNREACHABLE' });
    await assert.rejects(backups.runBackup('d1', { now: at('02:00:00Z') }));
    const list = backups.listBackups('d1');
    assert.equal(list.backups.length, 1);
    assert.equal(list.lastAttempt.ok, false);
    assert.match(list.lastAttempt.error, /did not answer/);
    assert.throws(() => backups.readBackup('d1', '../../etc'), (e) => e.code === 'BAD_REQUEST');
    assert.equal(backups.removeDevice('../x'), false);
});

test('not configured, disabled, unsupported vendor', async () => {
    await assert.rejects(backups.runBackup('nope'), (e) => e.code === 'NOT_CONFIGURED');
    store.saveProfile('d1', 'Firewall', { vendor: 'fortigate', mgmtHost: '192.0.2.1', token: store.MASK, enabled: false }, 'a');
    await assert.rejects(backups.runBackup('d1'), (e) => e.code === 'NOT_CONFIGURED');
    registry._drivers.fortigate = { capabilities: [] };
    try {
        store.saveProfile('d1', 'Firewall', { vendor: 'fortigate', mgmtHost: '192.0.2.1', token: store.MASK }, 'a');
        await assert.rejects(backups.runBackup('d1'), (e) => e.code === 'UNSUPPORTED');
    } finally { registry._drivers.fortigate = fake; }
});

test('removing the device deletes its files and index entry', async () => {
    await backups.runBackup('d1', { now: at('01:00:00Z') });
    assert.equal(backups.removeDevice('d1'), true);
    assert.equal(fs.existsSync(path.join(backups.rootDir(), 'd1')), false);
    assert.equal(backups.listBackups('d1').backups.length, 0);
});

test('schedule: off by default, due only within an hour after the time, once a day across restarts', async () => {
    const local = (h, m) => { const d = new Date(2026, 10, 4, h, m, 0); return d; };
    assert.deepEqual(await backups.scheduledRun(local(3, 0)), { skipped: 'disabled' });
    process.env.NETDEVICE_BACKUP_SCHEDULE = '25:00';
    assert.deepEqual(await backups.scheduledRun(local(3, 0)), { skipped: 'disabled' });
    process.env.NETDEVICE_BACKUP_SCHEDULE = '02:30';
    assert.equal(backups.isDue(local(2, 29), null), false);
    assert.equal(backups.isDue(local(3, 29), null), true);
    assert.equal(backups.isDue(local(3, 31), null), false, 'more than an hour late: skip the day');
    const r = await backups.scheduledRun(local(2, 31));
    assert.deepEqual(r.results, [{ id: 'd1', ok: true, unchanged: false }]);
    assert.deepEqual(await backups.scheduledRun(local(2, 45)), { skipped: 'not-due' }, 'recorded in the document, not in memory');
    assert.equal(calls, 1);
    assert.equal(backups.scheduleInfo().schedule, '02:30');
    assert.equal(backups.scheduleInfo().lastRun.devices, 1);
});
