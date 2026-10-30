require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const mw = require('../../services/maintenanceWindows');

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi);   // local time
const mon = { id: 'm1', tags: '["web","prod"]', envId: 'env-prod' };
const once = (extra = {}) => ({ kind: 'once', startAt: at(2026, 10, 14, 22).toISOString(), endAt: at(2026, 10, 15, 0).toISOString(), scopeType: 'all', scopeValues: '[]', ruleIds: '[]', enabled: 1, ...extra });
const weekly = (extra = {}) => ({ kind: 'weekly', weekdays: '[0]', startTime: '23:00', durationMin: 180, scopeType: 'all', scopeValues: '[]', ruleIds: '[]', enabled: 1, ...extra });

test('once: active only inside [startAt, endAt)', () => {
    assert.equal(mw.isWindowActive(once(), at(2026, 10, 14, 21, 59)), false);
    assert.equal(mw.isWindowActive(once(), at(2026, 10, 14, 22, 0)), true);
    assert.equal(mw.isWindowActive(once(), at(2026, 10, 15, 0, 0)), false);
});

test('weekly: crosses midnight into the next day (Sun 23:00 + 3h covers Mon 01:30)', () => {
    // 2026-10-18 is a Sunday
    assert.equal(mw.isWindowActive(weekly(), at(2026, 10, 18, 22, 59)), false);
    assert.equal(mw.isWindowActive(weekly(), at(2026, 10, 18, 23, 30)), true);
    assert.equal(mw.isWindowActive(weekly(), at(2026, 10, 19, 1, 30)), true);
    assert.equal(mw.isWindowActive(weekly(), at(2026, 10, 19, 2, 0)), false);
    assert.equal(mw.isWindowActive(weekly(), at(2026, 10, 21, 23, 30)), false, 'Wednesday not selected');
});

test('disabled windows never apply', () => {
    assert.equal(mw.isWindowActive(once({ enabled: 0 }), at(2026, 10, 14, 23)), false);
});

test('scope: all / monitors / tags / envs, and optional ruleIds', () => {
    assert.equal(mw.windowCovers(once(), mon, 'r1'), true);
    assert.equal(mw.windowCovers(once({ scopeType: 'monitors', scopeValues: '["m1"]' }), mon, 'r1'), true);
    assert.equal(mw.windowCovers(once({ scopeType: 'monitors', scopeValues: '["m2"]' }), mon, 'r1'), false);
    assert.equal(mw.windowCovers(once({ scopeType: 'tags', scopeValues: '["prod"]' }), mon, 'r1'), true);
    assert.equal(mw.windowCovers(once({ scopeType: 'tags', scopeValues: '["db"]' }), { ...mon, tags: ['web'] }, 'r1'), false);
    assert.equal(mw.windowCovers(once({ scopeType: 'envs', scopeValues: '["env-prod"]' }), mon, 'r1'), true);
    assert.equal(mw.windowCovers(once({ ruleIds: '["r2"]' }), mon, 'r1'), false);
    assert.equal(mw.windowCovers(once({ ruleIds: '["r1"]' }), mon, 'r1'), true);
});

test('isInMaintenance combines activity and scope; garbage rows are ignored', () => {
    const now = at(2026, 10, 14, 23);
    assert.equal(mw.isInMaintenance([once({ scopeValues: 'not json', scopeType: 'monitors' })], mon, 'r1', now), false);
    assert.equal(mw.isInMaintenance([once({ scopeType: 'monitors', scopeValues: '["m1"]' })], mon, 'r1', now), true);
});

test('windowStatus', () => {
    assert.equal(mw.windowStatus(once(), at(2026, 10, 14, 12)), 'scheduled');
    assert.equal(mw.windowStatus(once(), at(2026, 10, 14, 23)), 'active');
    assert.equal(mw.windowStatus(once(), at(2026, 10, 16, 0)), 'ended');
    assert.equal(mw.windowStatus(weekly(), at(2026, 10, 14, 12)), 'scheduled');
    assert.equal(mw.windowStatus(once({ enabled: 0 }), at(2026, 10, 14, 23)), 'disabled');
});

test('validateWindowInput: accepts valid once/weekly and rejects bad input', () => {
    const now = at(2026, 10, 14, 12);
    const ok = mw.validateWindowInput({ name: 'patch', kind: 'once', startAt: at(2026, 10, 14, 22).toISOString(), endAt: at(2026, 10, 15, 0).toISOString(), scopeType: 'monitors', scopeValues: ['m1'] }, now);
    assert.equal(ok.ok, true, ok.errors.join());
    assert.equal(ok.value.scopeValues, '["m1"]');
    assert.equal(ok.value.ruleIds, '[]');
    assert.equal(ok.value.enabled, 1);
    const wk = mw.validateWindowInput({ name: 'weekly', kind: 'weekly', weekdays: [0, 6], startTime: '02:00', durationMin: 120, scopeType: 'all' }, now);
    assert.equal(wk.ok, true, wk.errors.join());
    const bad = [
        { kind: 'once', name: 'x', startAt: at(2026, 10, 15, 0).toISOString(), endAt: at(2026, 10, 14, 0).toISOString(), scopeType: 'all' },
        { kind: 'once', name: 'x', startAt: at(2026, 10, 1, 0).toISOString(), endAt: at(2026, 11, 20, 0).toISOString(), scopeType: 'all' },
        { kind: 'weekly', name: 'x', weekdays: [7], startTime: '02:00', durationMin: 60, scopeType: 'all' },
        { kind: 'weekly', name: 'x', weekdays: [1], startTime: '25:00', durationMin: 60, scopeType: 'all' },
        { kind: 'weekly', name: 'x', weekdays: [1], startTime: '02:00', durationMin: 0, scopeType: 'all' },
        { kind: 'once', name: 'x', startAt: at(2026, 10, 14, 22).toISOString(), endAt: at(2026, 10, 15, 0).toISOString(), scopeType: 'monitors', scopeValues: [] },
        { kind: 'once', name: 'x', startAt: at(2026, 10, 14, 22).toISOString(), endAt: at(2026, 10, 15, 0).toISOString(), scopeType: 'tags', scopeValues: Array.from({ length: 501 }, (_, i) => `t${i}`) },
        { kind: 'nope', name: 'x', scopeType: 'all' },
        { kind: 'once', name: '', startAt: at(2026, 10, 14, 22).toISOString(), endAt: at(2026, 10, 15, 0).toISOString(), scopeType: 'all' },
    ];
    for (const b of bad) assert.equal(mw.validateWindowInput(b, now).ok, false, JSON.stringify(b));
});
