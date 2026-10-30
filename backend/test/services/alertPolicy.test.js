require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const { writeDataSync } = require('../../lib/db');
const cfg = require('../../services/alertQualityConfig');
const store = require('../../services/alertPolicyStore');
const { decide } = require('../../services/alertPolicy');

const mon = { id: 'm1', name: 'WEB-01', ip: '10.0.0.1', tags: '[]', envId: 'e1' };
const rule = { id: 'r1', name: 'CPU' };
const T0 = new Date(2026, 9, 14, 10, 0, 0);
const plus = (min) => new Date(T0.getTime() + min * 60000);

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => {
    for (const t of ['notify_state', 'notify_rate', 'notify_digest', 'maintenance_windows']) dbManager.run(`DELETE FROM ${t}`);
    store.invalidateWindows();
    writeDataSync(cfg.CONFIG_KEY, {}); cfg.invalidateConfig();
});

const trig = (now, extra = {}) => decide({ monitor: mon, rule, kind: 'trigger', now, isTransition: true, wantsNotify: true, digestLine: 'WEB-01 cpu 95', ...extra });

test('first trigger notifies, a second within cooldown is suppressed, after cooldown notifies again', () => {
    assert.equal(trig(T0).notify, true);
    assert.deepEqual(decide({ monitor: mon, rule, kind: 'trigger', now: plus(5), isTransition: false, wantsNotify: true }), { notify: false, suppressedReason: 'cooldown', flapStarted: false, window: null });
    assert.equal(decide({ monitor: mon, rule, kind: 'trigger', now: plus(16), isTransition: false, wantsNotify: true }).notify, true);
});

test('cooldown survives a "restart" (state is in the DB, not memory)', () => {
    trig(T0);
    delete require.cache[require.resolve('../../services/alertPolicy')];
    const fresh = require('../../services/alertPolicy');
    assert.equal(fresh.decide({ monitor: mon, rule, kind: 'trigger', now: plus(1), isTransition: false, wantsNotify: true }).suppressedReason, 'cooldown');
});

test('trigger and recovery cooldowns are independent', () => {
    trig(T0);
    assert.equal(decide({ monitor: mon, rule, kind: 'recovery', now: plus(1), isTransition: true, wantsNotify: true }).notify, true);
});

test('maintenance suppresses (even before cooldown) and reports the window', () => {
    dbManager.run(`INSERT INTO maintenance_windows (id, name, kind, startAt, endAt, scopeType, scopeValues, ruleIds, enabled) VALUES ('w1','patch','once',?,?,'monitors','["m1"]','[]',1)`,
        [plus(-10).toISOString(), plus(60).toISOString()]);
    store.invalidateWindows();
    const d = trig(T0);
    assert.equal(d.notify, false);
    assert.equal(d.suppressedReason, 'maintenance');
    assert.equal(d.window.id, 'w1');
});

test('flapping: 4 transitions in 30 min → one flapStarted, then suppressed until stable 30 min', () => {
    const results = [0, 2, 4, 6].map((m, i) => decide({ monitor: mon, rule, kind: i % 2 ? 'recovery' : 'trigger', now: plus(m), isTransition: true, wantsNotify: true }));
    assert.equal(results[3].suppressedReason, 'flapping');
    assert.equal(results[3].flapStarted, true);
    const again = decide({ monitor: mon, rule, kind: 'trigger', now: plus(8), isTransition: true, wantsNotify: true });
    assert.equal(again.suppressedReason, 'flapping');
    assert.equal(again.flapStarted, false);
    // stable for 30 min since last transition (minute 8) → cleared, normal rules apply again
    const later = decide({ monitor: mon, rule, kind: 'trigger', now: plus(40), isTransition: true, wantsNotify: true });
    assert.notEqual(later.suppressedReason, 'flapping');
});

test('wantsNotify=false only records the transition', () => {
    const d = decide({ monitor: mon, rule, kind: 'recovery', now: T0, isTransition: true, wantsNotify: false });
    assert.deepEqual(d, { notify: false, suppressedReason: null, flapStarted: false, window: null });
    assert.equal(store.getState(store.stateKey('m1', 'r1')).transitions.length, 1);
});

test('rate limit: the 11th notification in a minute goes to the digest', () => {
    const outs = Array.from({ length: 11 }, (_, i) => decide({ monitor: { ...mon, id: `m${i}` }, rule, kind: 'trigger', now: T0, isTransition: true, wantsNotify: true, digestLine: `host${i}` }));
    assert.equal(outs.filter(o => o.notify).length, 10);
    assert.equal(outs[10].suppressedReason, 'digest');
    assert.deepEqual(store.takeDigest(plus(1).toISOString()), ['host10']);
    assert.deepEqual(store.takeDigest(plus(1).toISOString()), [], 'taken lines are deleted');
});

test('log kind never flaps', () => {
    for (let i = 0; i < 10; i++) decide({ monitor: mon, rule, kind: 'log', now: plus(i * 20), isTransition: false, wantsNotify: true });
    assert.equal(store.getState(store.stateKey('m1', 'r1')).flappingSince, null);
});

test('flap release does not re-arm from stale transitions (non-transition call)', () => {
    [0, 2, 4, 6].forEach((m, i) => decide({ monitor: mon, rule, kind: i % 2 ? 'recovery' : 'trigger', now: plus(m), isTransition: true, wantsNotify: true }));
    const a = decide({ monitor: mon, rule, kind: 'trigger', now: plus(40), isTransition: false, wantsNotify: true });
    assert.notEqual(a.suppressedReason, 'flapping');
    assert.equal(a.flapStarted, false);
    const b = decide({ monitor: mon, rule, kind: 'trigger', now: plus(41), isTransition: false, wantsNotify: true });
    assert.notEqual(b.suppressedReason, 'flapping');
    assert.equal(b.flapStarted, false);
});

test('flap release with stableMin < windowMin does not re-flap on the releasing transition', () => {
    writeDataSync(cfg.CONFIG_KEY, { flapping: { transitions: 4, windowMin: 30, stableMin: 10 } }); cfg.invalidateConfig();
    [0, 2, 4, 6].forEach((m, i) => decide({ monitor: mon, rule, kind: i % 2 ? 'recovery' : 'trigger', now: plus(m), isTransition: true, wantsNotify: true }));
    const d = decide({ monitor: mon, rule, kind: 'trigger', now: plus(20), isTransition: true, wantsNotify: true });
    assert.notEqual(d.suppressedReason, 'flapping');
    assert.equal(d.flapStarted, false);
    assert.equal(store.getState(store.stateKey('m1', 'r1')).transitions.length, 1);
});

test('saveState failure does not discard the decision', () => {
    dbManager.run(`INSERT INTO maintenance_windows (id, name, kind, startAt, endAt, scopeType, scopeValues, ruleIds, enabled) VALUES ('w1','patch','once',?,?,'monitors','["m1"]','[]',1)`,
        [plus(-10).toISOString(), plus(60).toISOString()]);
    store.invalidateWindows();
    const orig = store.saveState;
    store.saveState = () => { throw new Error('disk full'); };
    const origErr = console.error; console.error = () => {};
    try {
        assert.equal(trig(T0).suppressedReason, 'maintenance');
    } finally { store.saveState = orig; console.error = origErr; }
});

test('flapStarted is reported even when wantsNotify=false', () => {
    const rs = [0, 2, 4, 6].map((m, i) => decide({ monitor: mon, rule, kind: i % 2 ? 'recovery' : 'trigger', now: plus(m), isTransition: true, wantsNotify: i !== 3 }));
    assert.equal(rs[3].flapStarted, true);
    assert.equal(rs[3].notify, false);
});

test('digested event stamps cooldown so it is not digested again', () => {
    for (let i = 0; i < 10; i++) decide({ monitor: { ...mon, id: `x${i}` }, rule, kind: 'trigger', now: T0, isTransition: true, wantsNotify: true });
    assert.equal(trig(T0).suppressedReason, 'digest');
    assert.equal(trig(plus(0.5), { isTransition: false }).suppressedReason, 'cooldown');
    assert.equal(store.takeDigest(plus(5).toISOString()).length, 1);
});

test('F10: listWindows skips ended once windows but keeps weekly and future ones', () => {
    const ins = (id, kind, startAt, endAt, enabled = 1) => dbManager.run(`INSERT INTO maintenance_windows (id, name, kind, startAt, endAt, weekdays, startTime, durationMin, scopeType, scopeValues, ruleIds, enabled) VALUES (?,?,?,?,?,?,?,?,'all','[]','[]',?)`,
        [id, id, kind, startAt, endAt, kind === 'weekly' ? '[1]' : null, kind === 'weekly' ? '02:00' : null, kind === 'weekly' ? 60 : null, enabled]);
    ins('ended', 'once', plus(-120).toISOString(), plus(-60).toISOString());
    ins('active', 'once', plus(-10).toISOString(), plus(60).toISOString());
    ins('weekly', 'weekly', null, null);
    ins('off', 'once', plus(-10).toISOString(), plus(60).toISOString(), 0);
    assert.deepEqual(store.listWindows(T0.getTime()).map(w => w.id).sort(), ['active', 'weekly']);
});

test('F8: takeDigestRows returns lines with createdAt and deletes them', () => {
    store.addDigest('a', plus(-3).toISOString());
    store.addDigest('b', plus(1).toISOString());
    assert.deepEqual(store.takeDigestRows(T0.toISOString()).map(r => ({ ...r })), [{ line: 'a', createdAt: plus(-3).toISOString() }]);
    assert.deepEqual(store.takeDigest(plus(5).toISOString()), ['b']);
});
