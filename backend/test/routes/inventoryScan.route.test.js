require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync, writeDataSync } = require('../../lib/db');
const { STATUS_KEY, readStatus } = require('../../services/inventoryStatus');

const CONFIG_KEY = 'server_operation/oscheck/config.json';
const tok = (role, username = role.toLowerCase()) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['inv'] })}`;
const admin = tok('SuperAdmin'), op = tok('Operator'), viewer = tok('Viewer');
const bearer = (t) => ({ Authorization: t });
let app;

// what the worker does: write through dbManager only (no RAM cache in the web process knows about it)
async function workerWritesStatus(doc) {
    await dbManager.upsert({ table: 'document_store', conflictKeys: ['key'], data: { key: STATUS_KEY, value: JSON.stringify(doc), updatedAt: new Date().toISOString() } });
}
const runningDoc = (over = {}) => ({ running: true, startedAt: new Date().toISOString(), finishedAt: null, trigger: 'schedule', requestedBy: 'SYSTEM', totalIps: 200, processedIps: 50, discovered: 7, currentIp: '10.1.1.50', activeSubnets: ['10.1.1'], subnets: [{ subnet: '10.1.1', total: 100, processed: 50, state: 'running' }], logs: ['a'], ...over });

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: { inv: { enabled: true, features: { inventory: true } } } });
    app = express();
    app.use(express.json());
    app.use('/api/inventory', require('../../routes/inventory'));
});
test.beforeEach(async () => { await workerWritesStatus({}); });
test.after(async () => { delete global.sendWorkerMessage; delete process.env.ENABLE_EMBEDDED_WORKER; await dbManager.closeDB(); });

function captureIpc(deliver = true) {
    const sent = [];
    global.sendWorkerMessage = (m) => { if (m.type !== 'INVALIDATE_DOC_CACHE') sent.push(m); return deliver; };
    return sent;
}

test('config save sends RELOAD_INVENTORY_SCHEDULER and never starts a scan in the web process', async () => {
    const sent = captureIpc();
    const inv = require('../../services/inventoryScheduler');
    const r = await request(app).post('/api/inventory/config').set(bearer(op))
        .send({ subnets: ['10.70.1'], schedule: { enabled: true, frequency: 'weekly', weekday: 3, time: '02:30' } }).expect(200);
    assert.equal(r.body.schedulerReloaded, true);
    assert.deepEqual(sent, [{ type: 'RELOAD_INVENTORY_SCHEDULER' }]);
    assert.equal(inv.scanStatus.running, false);
    assert.deepEqual((await readStatus()).running, undefined);
    const cfg = readDataSync(CONFIG_KEY, {});
    assert.deepEqual(cfg.schedule, { enabled: true, frequency: 'weekly', time: '02:30', weekday: 3 });
});

test('config save succeeds with a note when the worker is unavailable', async () => {
    captureIpc(false);
    const r = await request(app).post('/api/inventory/config').set(bearer(op)).send({ schedule: { enabled: false } }).expect(200);
    assert.equal(r.body.schedulerReloaded, false);
    assert.match(r.body.schedulerNote, /worker is unavailable/);
});

test('config save is PATCH: server-owned lastScan/lastDiscovered and omitted fields survive, unknown fields are dropped', async () => {
    captureIpc();
    writeDataSync(CONFIG_KEY, { subnets: ['10.71.1'], monitoredIps: ['10.71.1.5'], lastScan: '2026-01-01T00:00:00.000Z', lastDiscovered: 42, offlineDeleteDays: 9, extraFutureField: 'keep' });
    await request(app).post('/api/inventory/config').set(bearer(op))
        .send({ schedule: { enabled: false }, lastScan: '1999-01-01T00:00:00.000Z', lastDiscovered: 0, evil: 'x' }).expect(200);
    const cfg = readDataSync(CONFIG_KEY, {});
    assert.equal(cfg.lastScan, '2026-01-01T00:00:00.000Z');
    assert.equal(cfg.lastDiscovered, 42);
    assert.deepEqual(cfg.subnets, ['10.71.1']);
    assert.deepEqual(cfg.monitoredIps, ['10.71.1.5']);
    assert.equal(cfg.offlineDeleteDays, 9);
    assert.equal(cfg.extraFutureField, 'keep');
    assert.equal(cfg.evil, undefined);
});

test('a lastScan written only by the worker (database) is not overwritten by a UI save', async () => {
    captureIpc();
    writeDataSync(CONFIG_KEY, { subnets: [], lastScan: '2026-01-01T00:00:00.000Z', lastDiscovered: 1 });
    const newer = { subnets: [], lastScan: '2026-06-01T00:00:00.000Z', lastDiscovered: 99 };
    await dbManager.upsert({ table: 'document_store', conflictKeys: ['key'], data: { key: CONFIG_KEY, value: JSON.stringify(newer), updatedAt: new Date().toISOString() } });
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ schedule: { enabled: false } }).expect(200);
    const cfg = readDataSync(CONFIG_KEY, {});
    assert.equal(cfg.lastScan, '2026-06-01T00:00:00.000Z');
    assert.equal(cfg.lastDiscovered, 99);
});

test('schedule validation: invalid cron / weekday / time rejected with 400', async () => {
    captureIpc();
    for (const schedule of [
        { enabled: true, frequency: 'cron', cron: '* * * *' },
        { enabled: true, frequency: 'cron', cron: '0 3 * * *; calc' },
        { enabled: true, frequency: 'weekly', weekday: 7, time: '01:00' },
        { enabled: true, frequency: 'daily', time: '25:99' },
        { enabled: true, frequency: 'monthly', time: '01:00' }
    ]) {
        await request(app).post('/api/inventory/config').set(bearer(op)).send({ schedule }).expect(400);
    }
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ schedule: { enabled: true, frequency: 'cron', cron: '0 3 * * 1-5' } }).expect(200);
});

test('POST /scan-now hands RUN_INVENTORY_SCAN to the worker (202) and does not scan in the web process', async () => {
    const sent = captureIpc();
    const res = await request(app).post('/api/inventory/scan-now').set(bearer(op)).send({}).expect(202);
    assert.deepEqual(sent, [{ type: 'RUN_INVENTORY_SCAN', requestedBy: 'operator' }]);
    assert.equal(res.body.message, 'Scan started in background');
    assert.equal(require('../../services/inventoryScheduler').scanStatus.running, false);
});

test('POST /scan-now with a scope forwards a normalised subnet or ip; bad scopes are 400', async () => {
    const sent = captureIpc();
    await request(app).post('/api/inventory/scan-now').set(bearer(op)).send({ subnet: '10.1.2.1-9' }).expect(202);
    await request(app).post('/api/inventory/scan-now').set(bearer(op)).send({ ip: '10.1.2.77' }).expect(202);
    assert.deepEqual(sent.map(m => m.scope), [{ subnet: '10.1.2:1~9' }, { ip: '10.1.2.77' }]);
    for (const body of [{ ip: '10.1.2.300' }, { ip: "10.1.2.3'; calc" }, { subnet: "10.1.2'; calc #" }, { subnet: '10.1.2:9~3' }]) {
        await request(app).post('/api/inventory/scan-now').set(bearer(op)).send(body).expect(400);
    }
    assert.equal(sent.length, 2);
});

test('POST /scan-now: 503 with a clear message when no worker (not delivered / missing / ENABLE_EMBEDDED_WORKER=false)', async () => {
    captureIpc(false);
    let r = await request(app).post('/api/inventory/scan-now').set(bearer(op)).send({}).expect(503);
    assert.match(r.body.error, /worker unavailable/i);
    delete global.sendWorkerMessage;
    await request(app).post('/api/inventory/scan-now').set(bearer(op)).send({}).expect(503);
    const sent = captureIpc();
    process.env.ENABLE_EMBEDDED_WORKER = 'false';
    r = await request(app).post('/api/inventory/scan-now').set(bearer(op)).send({}).expect(503);
    assert.match(r.body.error, /ENABLE_EMBEDDED_WORKER=false/);
    assert.equal(sent.length, 0);
    delete process.env.ENABLE_EMBEDDED_WORKER;
});

test('POST /scan-now: 409 while the shared status says running; a stale (> 6 h) running status does not block', async () => {
    const sent = captureIpc();
    await workerWritesStatus(runningDoc());
    const r = await request(app).post('/api/inventory/scan-now').set(bearer(op)).send({}).expect(409);
    assert.equal(r.body.alreadyRunning, true);
    assert.equal(sent.length, 0);
    await workerWritesStatus(runningDoc({ startedAt: new Date(Date.now() - 7 * 3600000).toISOString() }));
    await request(app).post('/api/inventory/scan-now').set(bearer(op)).send({}).expect(202);
    assert.equal(sent.length, 1);
});

test('POST /abort-scan: 400 when idle, IPC when running, 503 when worker unavailable', async () => {
    const sent = captureIpc();
    await request(app).post('/api/inventory/abort-scan').set(bearer(op)).send({}).expect(400);
    assert.equal(sent.length, 0);
    await workerWritesStatus(runningDoc());
    await request(app).post('/api/inventory/abort-scan').set(bearer(op)).send({}).expect(200);
    assert.deepEqual(sent, [{ type: 'ABORT_INVENTORY_SCAN', requestedBy: 'operator' }]);
    captureIpc(false);
    await request(app).post('/api/inventory/abort-scan').set(bearer(op)).send({}).expect(503);
    await request(app).post('/api/inventory/abort-scan').set(bearer(viewer)).send({}).expect(403);
    await request(app).post('/api/inventory/scan-now').set(bearer(viewer)).send({}).expect(403);
});

test('GET /scan-status reads the worker-written document (including scheduled scans) straight from the shared store', async () => {
    let r = await request(app).get('/api/inventory/scan-status').set(bearer(viewer)).expect(200);
    assert.equal(r.body.running, false);
    assert.equal(r.body.overallProgress, 0);
    assert.equal(r.body.nextRunAt, null);

    const next = new Date(Date.now() + 3600000).toISOString();
    await workerWritesStatus(runningDoc({ schedule: { enabled: true, nextRunAt: next, lastScheduledRunAt: null } }));
    r = await request(app).get('/api/inventory/scan-status').set(bearer(viewer)).expect(200);
    assert.equal(r.body.running, true);
    assert.equal(r.body.trigger, 'schedule');
    assert.equal(r.body.requestedBy, 'SYSTEM');
    assert.equal(r.body.currentIp, '10.1.1.50');
    assert.equal(r.body.overallProgress, 25);
    assert.equal(r.body.ipProgress, '50 / 200 IPs');
    assert.equal(r.body.discovered, 7);
    assert.equal(r.body.subnets[0].processed, 50);
    assert.equal(r.body.nextRunAt, next);

    await workerWritesStatus(runningDoc({ running: false, finishedAt: new Date().toISOString(), aborted: true, degraded: true, processedIps: 120 }));
    r = await request(app).get('/api/inventory/scan-status').set(bearer(viewer)).expect(200);
    assert.equal(r.body.running, false);
    assert.equal(r.body.aborted, true);
    assert.equal(r.body.degraded, true);
    assert.equal(r.body.overallProgress, 100);
    assert.equal(r.body.currentIp, '');
});

test('GET /scan-status marks a running status older than 6 h as stale and not running', async () => {
    await workerWritesStatus(runningDoc({ startedAt: new Date(Date.now() - 7 * 3600000).toISOString() }));
    const r = await request(app).get('/api/inventory/scan-status').set(bearer(viewer)).expect(200);
    assert.equal(r.body.running, false);
    assert.equal(r.body.stale, true);
});

test('Scheduler "run now" for inventory goes through the same IPC (503 without worker)', async () => {
    const schedApp = express();
    schedApp.use(express.json());
    schedApp.use('/api/scheduler', require('../../routes/scheduler'));
    const sent = captureIpc();
    // same RBAC as POST /api/inventory/scan-now: Viewers must not start a scan that sends stored credentials
    await request(schedApp).post('/api/scheduler/run-now/inventory').set(bearer(viewer)).expect(403);
    assert.equal(sent.length, 0);
    await request(schedApp).post('/api/scheduler/run-now/inventory').set(bearer(op)).expect(200);
    sent.length = 0;
    await request(schedApp).post('/api/scheduler/run-now/inventory').set(bearer(admin)).expect(200);
    assert.deepEqual(sent.map(m => m.type), ['RUN_INVENTORY_SCAN']);
    captureIpc(false);
    await request(schedApp).post('/api/scheduler/run-now/inventory').set(bearer(admin)).expect(503);
});

test('legacy weekly schedule (no weekday) stays daily after a save: no weekday is invented', async () => {
    captureIpc();
    writeDataSync(CONFIG_KEY, { subnets: [], schedule: { enabled: true, time: '08:00', frequency: 'weekly' } });
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ schedule: { enabled: true, time: '08:00', frequency: 'weekly' } }).expect(200);
    const s = readDataSync(CONFIG_KEY, {}).schedule;
    assert.equal(s.frequency, 'daily');
    assert.equal(s.weekday, undefined);
    assert.equal(s.time, '08:00');
});

test('schedule PATCH merges per sub-field; the merged schedule is validated', async () => {
    captureIpc();
    writeDataSync(CONFIG_KEY, { subnets: [], schedule: { enabled: false, frequency: 'weekly', weekday: 4, time: '03:15' } });
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ schedule: { enabled: true } }).expect(200);
    assert.deepEqual(readDataSync(CONFIG_KEY, {}).schedule, { enabled: true, frequency: 'weekly', weekday: 4, time: '03:15' });
    // enabling cron without an expression is rejected on the merged result; a disabled partial cron is accepted
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ schedule: { frequency: 'cron' } }).expect(400);
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ schedule: { frequency: 'cron', enabled: false, cron: '0 3 *' } }).expect(200);
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ schedule: { enabled: true, frequency: 'cron', cron: '0 0 31 2 *' } }).expect(400);
});

test('a legacy offlineDeleteDays (null / 0 / out of range) is reset to 7 with a warning and never blocks a save', async () => {
    captureIpc();
    for (const bad of [null, 0, -3, 99999, 'abc']) {
        const r = await request(app).post('/api/inventory/config').set(bearer(op)).send({ offlineDeleteDays: bad, schedule: { enabled: false } }).expect(200);
        assert.equal(r.body.warnings.length, 1, String(bad));
        assert.equal(readDataSync(CONFIG_KEY, {}).offlineDeleteDays, 7);
    }
    const ok = await request(app).post('/api/inventory/config').set(bearer(op)).send({ offlineDeleteDays: 30 }).expect(200);
    assert.deepEqual(ok.body.warnings, []);
    assert.equal(readDataSync(CONFIG_KEY, {}).offlineDeleteDays, 30);
});

test('scan-now rejects host parts 0 and 255', async () => {
    const sent = captureIpc();
    await request(app).post('/api/inventory/scan-now').set(bearer(op)).send({ ip: '10.1.2.0' }).expect(400);
    await request(app).post('/api/inventory/scan-now').set(bearer(op)).send({ ip: '10.1.2.255' }).expect(400);
    await request(app).post('/api/inventory/scan-now').set(bearer(op)).send({ ip: '10.1.2.254' }).expect(202);
    assert.equal(sent.length, 1);
});
