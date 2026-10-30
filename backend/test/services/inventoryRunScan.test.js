require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const inv = require('../../services/inventoryScheduler');
const { readDataSync, writeDataSync } = require('../../lib/db');
const { STATUS_KEY, readStatus, toApiStatus } = require('../../services/inventoryStatus');

const CONFIG_KEY = 'server_operation/oscheck/config.json';

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });

async function putStatus(doc) {
    await dbManager.upsert({ table: 'document_store', conflictKeys: ['key'], data: { key: STATUS_KEY, value: JSON.stringify(doc), updatedAt: new Date().toISOString() } });
}
const offlineDeps = (hooks = {}) => ({
    pingCheck: async (ip) => { if (hooks.onPing) await hooks.onPing(ip); return false; },
    tcpCheck: async () => false,
    runPowerShell: async () => '{}',
    executeSSH: async () => ({ stdout: '', stderr: '', code: 1, success: false })
});

test('a full scan records running/progress in the shared status, then finishes and updates lastScan/lastDiscovered', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.81.1:1~4', '10.81.2:1~2'], lastDiscovered: 5 });
    const seen = [];
    const result = await inv.runScan({
        trigger: 'schedule', requestedBy: 'SYSTEM',
        deps: offlineDeps({ onPing: async (ip) => { if (ip === '10.81.1.3') seen.push(await readStatus()); } })
    });
    assert.equal(result.skipped, undefined);
    assert.equal(seen.length, 1);
    const mid = seen[0];
    assert.equal(mid.running, true);
    assert.equal(mid.trigger, 'schedule');
    assert.equal(mid.requestedBy, 'SYSTEM');
    assert.equal(mid.totalIps, 6);
    assert.ok(mid.startedAt);
    assert.deepEqual(mid.subnets.map(s => s.subnet).sort(), ['10.81.1:1~4', '10.81.2:1~2']);

    const done = await readStatus();
    assert.equal(done.running, false);
    assert.ok(done.finishedAt);
    assert.equal(done.aborted, false);
    assert.equal(done.processedIps, 6);
    assert.deepEqual(done.subnets.map(s => s.state), ['done', 'done']);
    assert.equal(toApiStatus(done).overallProgress, 100);
    const cfg = readDataSync(CONFIG_KEY, {});
    assert.ok(cfg.lastScan);
    assert.equal(cfg.lastDiscovered, 0);
    assert.equal(inv.scanStatus.running, false);
});

test('a partial scan (ip scope) scans only that address and leaves lastScan/lastDiscovered alone', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.82.1'], lastScan: '2026-01-01T00:00:00.000Z', lastDiscovered: 33 });
    const pinged = [];
    await inv.runScan({ trigger: 'manual', requestedBy: 'bob', scope: { ip: '10.82.1.77' }, deps: offlineDeps({ onPing: (ip) => pinged.push(ip) }) });
    assert.deepEqual(pinged, ['10.82.1.77']);
    const cfg = readDataSync(CONFIG_KEY, {});
    assert.equal(cfg.lastScan, '2026-01-01T00:00:00.000Z');
    assert.equal(cfg.lastDiscovered, 33);
    const st = await readStatus();
    assert.deepEqual(st.scope, { ip: '10.82.1.77' });
    assert.equal(st.requestedBy, 'bob');
});

test('a subnet scope scans the configured ranges of that /24 only', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.83.1:1~2', '10.83.2:1~2', '10.83.1:10~11'] });
    const pinged = [];
    await inv.runScan({ scope: { subnet: '10.83.1' }, deps: offlineDeps({ onPing: (ip) => pinged.push(ip) }) });
    assert.deepEqual(pinged.sort(), ['10.83.1.1', '10.83.1.10', '10.83.1.11', '10.83.1.2']);
});

test('only one scan at a time: a concurrent call is skipped (worker-local guard)', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.84.1:1~3'] });
    let release;
    const gate = new Promise(r => { release = r; });
    const first = inv.runScan({ deps: offlineDeps({ onPing: async (ip) => { if (ip === '10.84.1.1') await gate; } }) });
    const second = await inv.runScan({ deps: offlineDeps() });
    assert.deepEqual(second, { skipped: 'running' });
    release();
    await first;
    assert.equal(inv.scanStatus.running, false);
});

test('a running status of another process blocks the scan; a stale one (> 6 h) does not', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.85.1:1~1'] });
    await putStatus({ running: true, pid: process.pid + 1000, startedAt: new Date(Date.now() - 60000).toISOString(), finishedAt: null });
    const pinged = [];
    assert.deepEqual(await inv.runScan({ deps: offlineDeps({ onPing: (ip) => pinged.push(ip) }) }), { skipped: 'running' });
    assert.deepEqual(pinged, []);
    assert.equal(inv.scanStatus.running, false, 'the local guard is released when the start is refused');

    await putStatus({ running: true, pid: process.pid + 1000, startedAt: new Date(Date.now() - 7 * 3600000).toISOString(), finishedAt: null });
    await inv.runScan({ deps: offlineDeps({ onPing: (ip) => pinged.push(ip) }) });
    assert.deepEqual(pinged, ['10.85.1.1']);
});

test('abortScan stops the scan, marks it aborted and keeps lastScan untouched', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.86.1:1~50'], lastScan: '2026-01-01T00:00:00.000Z', lastDiscovered: 8 });
    assert.equal(inv.abortScan(), false, 'nothing to abort when idle');
    let pings = 0;
    await inv.runScan({ deps: offlineDeps({ onPing: () => { pings++; if (pings === 3) assert.equal(inv.abortScan(), true); } }) });
    assert.equal(pings, 3);
    const st = await readStatus();
    assert.equal(st.running, false);
    assert.equal(st.aborted, true);
    assert.equal(st.subnets[0].state, 'aborted');
    assert.equal(readDataSync(CONFIG_KEY, {}).lastScan, '2026-01-01T00:00:00.000Z');
});

test('invalid scope or no subnets: nothing starts and the guard is released', async () => {
    writeDataSync(CONFIG_KEY, { subnets: [] });
    assert.deepEqual(await inv.runScan({ deps: offlineDeps() }), { skipped: 'no_subnets' });
    const r = await inv.runScan({ scope: { ip: '10.9.9.255' }, deps: offlineDeps() });
    assert.equal(r.skipped, 'invalid_scope');
    assert.equal(inv.scanStatus.running, false);
});

test('worker start closes a status left "running" by a dead worker', async () => {
    await putStatus({ running: true, pid: process.pid + 4242, startedAt: new Date(Date.now() - 600000).toISOString(), finishedAt: null, processedIps: 10 });
    await inv.recoverInterruptedStatus();
    const st = await readStatus();
    assert.equal(st.running, false);
    assert.equal(st.interrupted, true);
    assert.ok(st.finishedAt);
});

const statusLib = require('../../services/inventoryStatus');

test('liveness: running needs a recent updatedAt (5 min), the 6 h hard cap still applies', () => {
    const t0 = Date.parse('2026-03-10T10:00:00Z');
    const doc = (startedAgoMs, updatedAgoMs) => ({ running: true, startedAt: new Date(t0 - startedAgoMs).toISOString(), updatedAt: new Date(t0 - updatedAgoMs).toISOString(), finishedAt: null });
    assert.equal(statusLib.isStatusRunning(doc(60000, 4 * 60000), t0), true);
    assert.equal(statusLib.isStatusRunning(doc(3600000, 6 * 60000), t0), false, 'lost final write: not running after 5 min without heartbeat');
    assert.equal(statusLib.toApiStatus(doc(3600000, 6 * 60000), t0).stale, true);
    // heartbeats keep a long scan alive until the hard cap
    assert.equal(statusLib.isStatusRunning(doc(5.9 * 3600000, 10000), t0), true);
    assert.equal(statusLib.isStatusRunning(doc(6.1 * 3600000, 10000), t0), false);
    // old documents without updatedAt fall back to startedAt
    assert.equal(statusLib.isStatusRunning({ running: true, startedAt: new Date(t0 - 60000).toISOString() }, t0), true);
    assert.equal(statusLib.isStatusRunning({ running: true, startedAt: new Date(t0 - 10 * 60000).toISOString() }, t0), false);
});

test('status writer stamps updatedAt on every write and retries a failing final write 3 times', async () => {
    const written = [];
    let failures = 2;
    const w = statusLib.createStatusWriter({
        read: async () => ({}),
        write: async (d) => { if (failures-- > 0) throw new Error('db busy'); written.push(d); },
        now: () => new Date('2026-03-10T10:00:00Z'),
        delay: async () => {}
    });
    await w.update({ running: false, finishedAt: 'x' });
    assert.equal(written.length, 1);
    assert.equal(written[0].updatedAt, '2026-03-10T10:00:00.000Z');
    assert.equal(written[0].finishedAt, 'x');

    let calls = 0;
    const bad = statusLib.createStatusWriter({ read: async () => ({}), write: async () => { calls++; throw new Error('down'); }, delay: async () => {} });
    await bad.update({ a: 1 }); // never rejects
    assert.equal(calls, 3);
});

test('heartbeat refreshes updatedAt while a long scan runs and stops when it ends', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.87.1:1~2'] });
    const stamps = [];
    await inv.runScan({
        heartbeatMs: 25,
        deps: offlineDeps({ onPing: async (ip) => { if (ip === '10.87.1.1') { stamps.push((await readStatus()).updatedAt); await new Promise(r => setTimeout(r, 200)); stamps.push((await readStatus()).updatedAt); } } })
    });
    assert.ok(stamps[1] > stamps[0], `heartbeat must advance updatedAt (${stamps})`);
    const done = await readStatus();
    assert.equal(done.running, false);
    await new Promise(r => setTimeout(r, 80));
    assert.equal((await readStatus()).updatedAt, done.updatedAt, 'no heartbeat after the scan finished');
});

test('abort of a ghost "running" status (no active scan in the worker) closes it as aborted', async () => {
    await putStatus({ running: true, pid: process.pid + 1, startedAt: new Date(Date.now() - 60000).toISOString(), updatedAt: new Date().toISOString(), finishedAt: null });
    assert.equal(await inv.abortScanOrCloseGhost(), 'closed');
    const st = await readStatus();
    assert.equal(st.running, false);
    assert.equal(st.aborted, true);
    assert.ok(st.finishedAt);
    assert.equal(await inv.abortScanOrCloseGhost(), 'idle');
});

test('worker skip reasons are recorded in the status document', async () => {
    writeDataSync(CONFIG_KEY, { subnets: [] });
    await inv.runScan({ trigger: 'schedule', requestedBy: 'SYSTEM', deps: offlineDeps() });
    let st = await readStatus();
    assert.equal(st.lastSkipped.reason, 'no_subnets');
    assert.equal(st.lastSkipped.trigger, 'schedule');
    writeDataSync(CONFIG_KEY, { subnets: ['10.200.1'] });
    await inv.runScan({ requestedBy: 'bob', scope: { ip: '10.200.1.0' }, deps: offlineDeps() });
    st = await readStatus();
    assert.equal(st.lastSkipped.reason, 'invalid_scope');
    assert.equal(st.lastSkipped.requestedBy, 'bob');
    assert.equal(statusLib.toApiStatus(st).lastSkipped.reason, 'invalid_scope');
});

test('never-started subnets are "skipped" in the final doc of an aborted scan', async () => {
    const subnets = ['10.89.1:1~3', '10.89.2:1~3', '10.89.3:1~3', '10.89.4:1~3', '10.89.5:1~3', '10.89.6:1~3'];
    writeDataSync(CONFIG_KEY, { subnets });
    await inv.runScan({ deps: offlineDeps({ onPing: () => { inv.abortScan(); } }) });
    const st = await readStatus();
    assert.equal(st.aborted, true);
    const states = Object.fromEntries(st.subnets.map(s => [s.subnet, s.state]));
    assert.equal(states['10.89.6:1~3'], 'skipped');
    assert.ok(!Object.values(states).includes('pending'));
});

test('an abort during post-processing does not mark a completed scan aborted; partial/aborted scans send no summary or auto-email', async () => {
    const logger = require('../../lib/logger');
    const origTg = logger.sendTelegramAlert;
    const origReport = inv.sendComplianceReport;
    const tg = []; const reports = [];
    logger.sendTelegramAlert = async (m) => { tg.push(m); };
    inv.sendComplianceReport = async () => { reports.push(1); return { success: true }; };
    try {
        writeDataSync(CONFIG_KEY, { subnets: ['10.90.1:1~2'], timezoneCheck: { autoEmail: true } });
        // full scan: summary + email; abort fired while post-processing (from the Telegram notice) is ignored for the outcome
        logger.sendTelegramAlert = async (m) => { tg.push(m); inv.abortScan(); };
        await inv.runScan({ deps: offlineDeps() });
        assert.equal(tg.length, 1);
        assert.equal(reports.length, 1);
        assert.equal((await readStatus()).aborted, false);
        assert.ok(readDataSync(CONFIG_KEY, {}).lastScan, 'lastScan updated for the completed scan');

        tg.length = 0; reports.length = 0;
        await inv.runScan({ scope: { ip: '10.90.1.5' }, deps: offlineDeps() });
        let n = 0;
        await inv.runScan({ deps: offlineDeps({ onPing: () => { if (++n === 1) inv.abortScan(); } }) });
        assert.equal(tg.length, 0, 'no completed-summary notice for partial or aborted scans');
        assert.equal(reports.length, 0, 'no compliance auto-email for partial or aborted scans');
    } finally {
        logger.sendTelegramAlert = origTg;
        inv.sendComplianceReport = origReport;
    }
});

test('a skip record does not revive the liveness of a ghost running doc', async () => {
    const old = new Date(Date.now() - 20 * 60000).toISOString();
    const w = statusLib.createStatusWriter({ read: async () => ({ running: true, startedAt: old, updatedAt: old, finishedAt: null }), write: async () => {}, delay: async () => {} });
    await w.update({ lastSkipped: { reason: 'no_subnets' } }, { touch: false });
    const d = await w.get();
    assert.equal(d.updatedAt, old);
    assert.equal(statusLib.isStatusRunning(d), false);
    assert.equal(d.lastSkipped.reason, 'no_subnets');
    // a normal update still stamps
    await w.update({ currentIp: 'x' });
    assert.notEqual((await w.get()).updatedAt, old);
});
