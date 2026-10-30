const test = require('node:test');
const assert = require('node:assert/strict');
const { createInventoryScheduler } = require('../../services/inventoryScheduling');

const L = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0);

function harness({ schedule, status = {}, start }) {
    const h = { clock: start, runs: [], patches: [], timers: [], logs: [], status: { ...status }, config: { schedule } };
    const sched = createInventoryScheduler({
        now: () => new Date(h.clock.getTime()),
        readConfig: async () => h.config,
        readStatus: async () => h.status,
        patchStatus: async (p) => { h.patches.push(p); h.status = { ...h.status, ...p }; },
        runScan: async (o) => { h.runs.push(o); },
        setInterval: (fn, ms) => { const t = { fn, ms, unref() {} }; h.timers.push(t); return t; },
        clearInterval: (t) => { t.cleared = true; },
        log: (m) => h.logs.push(m)
    });
    h.sched = sched;
    h.advance = async (ms) => { h.clock = new Date(h.clock.getTime() + ms); await sched.tick(); };
    return h;
}

test('start publishes nextRunAt and installs a 30 s timer; a disabled schedule installs none', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'daily', time: '08:00' }, start: L(2026, 3, 10, 7, 0) });
    await h.sched.start({ startup: true });
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].ms, 30000);
    const sch = h.status.schedule;
    assert.equal(sch.enabled, true);
    assert.equal(sch.nextRunAt, L(2026, 3, 10, 8, 0).toISOString());
    assert.equal(h.runs.length, 0);

    const off = harness({ schedule: { enabled: false, time: '08:00' }, start: L(2026, 3, 10, 7, 0) });
    await off.sched.start({ startup: true });
    assert.equal(off.timers.length, 0);
    assert.equal(off.status.schedule.nextRunAt, null);
    assert.equal(off.status.schedule.enabled, false);
});

test('a tick landing well after the target minute still runs the scan once (no minute polling gaps)', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'daily', time: '08:00' }, start: L(2026, 3, 10, 7, 59, 0) });
    await h.sched.start({ startup: true });
    await h.advance(20000);            // 07:59:20, not yet
    assert.equal(h.runs.length, 0);
    await h.advance(100000);           // 08:01:00, the 08:00 minute was skipped by the timer
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].trigger, 'schedule');
    assert.equal(h.runs[0].requestedBy, 'SYSTEM');
    assert.equal(h.status.schedule.lastScheduledRunAt, L(2026, 3, 10, 8, 0).toISOString());
    assert.equal(h.status.schedule.nextRunAt, L(2026, 3, 11, 8, 0).toISOString());
    await h.advance(30000);
    assert.equal(h.runs.length, 1, 'does not run twice');
});

test('a run more than 6 h late is skipped, next run is rescheduled', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'daily', time: '08:00' }, start: L(2026, 3, 10, 7, 0) });
    await h.sched.start({ startup: true });
    await h.advance(8 * 3600000 + 30 * 60000); // 15:30 (event loop frozen / host asleep)
    assert.equal(h.runs.length, 0);
    assert.equal(h.status.schedule.nextRunAt, L(2026, 3, 11, 8, 0).toISOString());
    assert.ok(h.logs.some(l => /skipped/.test(l)));
});

test('weekly and cron schedules compute their next run', async () => {
    const w = harness({ schedule: { enabled: true, frequency: 'weekly', weekday: 5, time: '23:00' }, start: L(2026, 3, 10, 7, 0) }); // Tue
    await w.sched.start();
    assert.equal(w.status.schedule.nextRunAt, L(2026, 3, 13, 23, 0).toISOString());
    const c = harness({ schedule: { enabled: true, frequency: 'cron', cron: '*/20 * * * *' }, start: L(2026, 3, 10, 7, 5) });
    await c.sched.start();
    assert.equal(c.status.schedule.nextRunAt, L(2026, 3, 10, 7, 20).toISOString());
    await c.advance(15 * 60000);
    assert.equal(c.runs.length, 1);
    assert.equal(c.status.schedule.nextRunAt, L(2026, 3, 10, 7, 40).toISOString());
});

test('invalid stored schedule never starts a timer', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'cron', cron: 'nonsense' }, start: L(2026, 3, 10, 7, 0) });
    await h.sched.start({ startup: true });
    assert.equal(h.timers.length, 0);
    assert.equal(h.status.schedule.nextRunAt, null);
});

test('worker start catches up one missed run inside 6 h, not outside, not when already run', async () => {
    const sched = { enabled: true, frequency: 'daily', time: '08:00' };
    const missed = harness({ schedule: sched, status: { schedule: { lastScheduledRunAt: L(2026, 3, 9, 8, 0).toISOString() } }, start: L(2026, 3, 10, 9, 30) });
    await missed.sched.start({ startup: true });
    assert.equal(missed.runs.length, 1);
    assert.equal(missed.runs[0].trigger, 'catchup');
    assert.equal(missed.status.schedule.lastScheduledRunAt, L(2026, 3, 10, 8, 0).toISOString());
    assert.equal(missed.status.schedule.nextRunAt, L(2026, 3, 11, 8, 0).toISOString());

    const old = harness({ schedule: sched, status: { schedule: { lastScheduledRunAt: L(2026, 3, 9, 8, 0).toISOString() } }, start: L(2026, 3, 10, 15, 0) });
    await old.sched.start({ startup: true });
    assert.equal(old.runs.length, 0);

    const done = harness({ schedule: sched, status: { schedule: { lastScheduledRunAt: L(2026, 3, 10, 8, 0).toISOString() } }, start: L(2026, 3, 10, 9, 30) });
    await done.sched.start({ startup: true });
    assert.equal(done.runs.length, 0);

    const reload = harness({ schedule: sched, status: { schedule: { lastScheduledRunAt: L(2026, 3, 9, 8, 0).toISOString() } }, start: L(2026, 3, 10, 9, 30) });
    await reload.sched.start({ startup: false });
    assert.equal(reload.runs.length, 0, 'a config reload never catches up');
});

test('a never-run schedule is seeded with now and does not catch up', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'daily', time: '08:00' }, start: L(2026, 3, 10, 9, 0) });
    await h.sched.start({ startup: true });
    assert.equal(h.runs.length, 0);
    assert.equal(h.status.schedule.lastScheduledRunAt, L(2026, 3, 10, 9, 0).toISOString());
});

test('reloading replaces the timer', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'daily', time: '08:00' }, start: L(2026, 3, 10, 7, 0) });
    await h.sched.start();
    h.config = { schedule: { enabled: true, frequency: 'daily', time: '09:00' } };
    await h.sched.start();
    assert.equal(h.timers[0].cleared, true);
    assert.equal(h.timers.length, 2);
    assert.equal(h.status.schedule.nextRunAt, L(2026, 3, 10, 9, 0).toISOString());
});

test('a scan that is still running does not block the tick or start-up (runScan is not awaited)', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'daily', time: '08:00' }, status: { schedule: { lastScheduledRunAt: L(2026, 3, 9, 8, 0).toISOString() } }, start: L(2026, 3, 10, 9, 0) });
    const sched = createInventoryScheduler({
        now: () => h.clock, readConfig: async () => h.config, readStatus: async () => h.status,
        patchStatus: async () => {}, runScan: () => new Promise(() => {}), setInterval: () => ({ unref() {} }), clearInterval() {}
    });
    await Promise.race([sched.start({ startup: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('blocked')), 500))]);
});

test('legacy weekly without weekday (old UI) is scheduled daily', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'weekly', time: '08:00' }, start: L(2026, 3, 10, 9, 0) });
    await h.sched.start({ startup: true });
    assert.equal(h.status.schedule.nextRunAt, L(2026, 3, 11, 8, 0).toISOString());
    await h.advance(23 * 3600000 + 60000);
    assert.equal(h.runs.length, 1);
    assert.equal(h.status.schedule.nextRunAt, L(2026, 3, 12, 8, 0).toISOString());
});

test('concurrent start() calls leave exactly one live timer', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'daily', time: '08:00' }, start: L(2026, 3, 10, 7, 0) });
    await Promise.all([h.sched.start(), h.sched.start(), h.sched.start({ startup: true })]);
    const live = h.timers.filter(t => !t.cleared);
    assert.equal(live.length, 1);
    h.sched.stop();
    assert.equal(h.timers.filter(t => !t.cleared).length, 0);
});

test('a reload with an unchanged schedule fires a run that just came due instead of losing it', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'daily', time: '08:00' }, start: L(2026, 3, 10, 7, 59, 40) });
    await h.sched.start();
    h.clock = L(2026, 3, 10, 8, 0, 10); // due, but no tick has landed yet
    await h.sched.start();
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].trigger, 'schedule');
    assert.equal(h.status.schedule.lastScheduledRunAt, L(2026, 3, 10, 8, 0).toISOString());
    assert.equal(h.status.schedule.nextRunAt, L(2026, 3, 11, 8, 0).toISOString());
});

test('a reload with a CHANGED schedule does not fire the old due run', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'daily', time: '08:00' }, start: L(2026, 3, 10, 7, 59, 40) });
    await h.sched.start();
    h.clock = L(2026, 3, 10, 8, 0, 10);
    h.config = { schedule: { enabled: true, frequency: 'daily', time: '09:00' } };
    await h.sched.start();
    assert.equal(h.runs.length, 0);
});

test('a scheduled run skipped because a scan is already running is recorded in the schedule status', async () => {
    const h = harness({ schedule: { enabled: true, frequency: 'daily', time: '08:00' }, start: L(2026, 3, 10, 7, 59, 0) });
    const sched = createInventoryScheduler({
        now: () => new Date(h.clock.getTime()), readConfig: async () => h.config, readStatus: async () => h.status,
        patchStatus: async (p) => { h.patches.push(p); h.status = { ...h.status, ...p }; },
        runScan: async () => ({ skipped: 'running' }), setInterval: () => ({ unref() {} }), clearInterval() {}, log: (m) => h.logs.push(m)
    });
    await sched.start({ startup: true });
    h.clock = L(2026, 3, 10, 8, 0, 20);
    await sched.tick();
    await new Promise(r => setImmediate(r));
    assert.equal(h.status.schedule.lastSkippedReason, 'running');
    assert.ok(h.logs.some(l => /skipped: running/.test(l)));
});
