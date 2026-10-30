const test = require('node:test');
const assert = require('node:assert/strict');
const sch = require('../../lib/inventorySchedule');

const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const iso = (d) => d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

test('daily: next run is later today or tomorrow, strictly after now', () => {
    const s = { enabled: true, frequency: 'daily', time: '08:30' };
    assert.equal(iso(sch.computeNextRun(s, L(2026, 3, 10, 7, 0))), '2026-03-10 08:30');
    assert.equal(iso(sch.computeNextRun(s, L(2026, 3, 10, 8, 30))), '2026-03-11 08:30');
    assert.equal(iso(sch.computeNextRun(s, L(2026, 3, 10, 23, 59))), '2026-03-11 08:30');
});

test('missing frequency means daily; disabled or invalid schedules have no next run', () => {
    assert.equal(iso(sch.computeNextRun({ enabled: true, time: '01:00' }, L(2026, 3, 10, 0, 0))), '2026-03-10 01:00');
    assert.equal(sch.computeNextRun({ enabled: false, time: '01:00' }, L(2026, 3, 10)), null);
    assert.equal(sch.computeNextRun({ enabled: true, frequency: 'daily', time: '25:00' }, L(2026, 3, 10)), null);
    assert.equal(sch.computeNextRun(null, L(2026, 3, 10)), null);
});

test('weekly: picks the configured weekday (0 = Sunday)', () => {
    // 2026-03-10 is a Tuesday
    const wed = { enabled: true, frequency: 'weekly', weekday: 3, time: '02:00' };
    assert.equal(iso(sch.computeNextRun(wed, L(2026, 3, 10, 12, 0))), '2026-03-11 02:00');
    const tue = { enabled: true, frequency: 'weekly', weekday: 2, time: '02:00' };
    assert.equal(iso(sch.computeNextRun(tue, L(2026, 3, 10, 12, 0))), '2026-03-17 02:00');
    assert.equal(iso(sch.computeNextRun(tue, L(2026, 3, 10, 1, 0))), '2026-03-10 02:00');
    const sun = { enabled: true, frequency: 'weekly', weekday: 0, time: '23:15' };
    assert.equal(iso(sch.computeNextRun(sun, L(2026, 3, 10, 12, 0))), '2026-03-15 23:15');
});

test('cron: lists, ranges, steps, names and the dom/dow OR rule', () => {
    const at = (cron, now) => iso(sch.computeNextRun({ enabled: true, frequency: 'cron', cron }, now));
    assert.equal(at('*/15 * * * *', L(2026, 3, 10, 10, 1)), '2026-03-10 10:15');
    assert.equal(at('0 6-8 * * mon-fri', L(2026, 3, 13, 9, 0)), '2026-03-16 06:00'); // Friday after the window -> Monday
    assert.equal(at('30 4 1,15 * *', L(2026, 3, 2, 0, 0)), '2026-03-15 04:30');
    assert.equal(at('0 0 29 2 *', L(2026, 3, 1, 0, 0)), '2028-02-29 00:00');
    assert.equal(at('0 9 13 * fri', L(2026, 3, 10, 0, 0)), '2026-03-13 09:00'); // the 13th OR a Friday: both are the 13th here
    assert.equal(at('0 9 12 * fri', L(2026, 3, 10, 0, 0)), '2026-03-12 09:00'); // the 12th (Thursday) comes before Friday
    assert.equal(at('0 0 * * 7', L(2026, 3, 10, 0, 0)), '2026-03-15 00:00'); // 7 = Sunday
});

test('cron validation rejects malformed expressions', () => {
    for (const bad of ['', '* * * *', '* * * * * *', '61 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', 'a b c d e', '1-2-3 * * * *', '5-1 * * * *', '*/5/2 * * * *', ';rm * * * *', 'x'.repeat(200)]) {
        assert.throws(() => sch.parseCron(bad), Error, JSON.stringify(bad));
    }
    assert.throws(() => sch.parseCron(42), /string/);
    assert.deepEqual(sch.validateSchedule({ enabled: true, frequency: 'cron', cron: '0 3 * * *' }), []);
    assert.match(sch.validateSchedule({ enabled: true, frequency: 'cron', cron: '0 3 * *' })[0], /schedule\.cron/);
    assert.match(sch.validateSchedule({ frequency: 'monthly' })[0], /frequency/);
    assert.match(sch.validateSchedule({ frequency: 'weekly', weekday: 9, time: '01:00' })[0], /weekday/);
    assert.match(sch.validateSchedule({ enabled: true, frequency: 'daily', time: '7:00' })[0], /HH:MM/);
    assert.match(sch.validateSchedule({ enabled: true, frequency: 'daily' })[0], /incomplete/);
    assert.deepEqual(sch.validateSchedule(undefined), []);
});

function withTz(tz, fn) {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try { fn(); } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
}

test('DST: a daily job fires once on spring-forward and fall-back days and keeps its wall-clock time otherwise', () => {
    withTz('America/New_York', () => {
        if (new Date(2026, 2, 8, 12).getTimezoneOffset() !== 240) return; // TZ switching unsupported on this platform
        const s = { enabled: true, frequency: 'daily', time: '02:30' };
        // 2026-03-08: 02:30 does not exist; the run happens once that day at the shifted time
        const n1 = sch.computeNextRun(s, L(2026, 3, 8, 0, 0));
        assert.equal(n1.getDate(), 8);
        const n2 = sch.computeNextRun(s, n1);
        assert.equal(iso(n2), '2026-03-09 02:30');
        // 2026-11-01: 01:30 happens twice; a daily 01:30 runs once
        const f = { enabled: true, frequency: 'daily', time: '01:30' };
        const a = sch.computeNextRun(f, L(2026, 11, 1, 0, 0));
        const b = sch.computeNextRun(f, a);
        assert.equal(iso(a), '2026-11-01 01:30');
        assert.equal(iso(b), '2026-11-02 01:30');
        // the interval across the 25 h day is one calendar day, not a fixed 24 h
        assert.equal(b.getTime() - a.getTime(), 25 * 3600000);
    });
});

test('catch-up: runs the missed slot once, only inside the 6 h window', () => {
    const s = { enabled: true, frequency: 'daily', time: '08:00' };
    const now = L(2026, 3, 10, 10, 0);
    assert.equal(iso(sch.decideCatchUp({ schedule: s, lastScheduledRunAt: L(2026, 3, 9, 8, 0).toISOString(), now })), '2026-03-10 08:00');
    assert.equal(sch.decideCatchUp({ schedule: s, lastScheduledRunAt: L(2026, 3, 10, 8, 0).toISOString(), now }), null);
    assert.equal(sch.decideCatchUp({ schedule: s, lastScheduledRunAt: L(2026, 3, 9, 8, 0).toISOString(), now: L(2026, 3, 10, 14, 1) }), null);
    assert.equal(iso(sch.decideCatchUp({ schedule: s, lastScheduledRunAt: L(2026, 3, 9, 8, 0).toISOString(), now: L(2026, 3, 10, 13, 59) })), '2026-03-10 08:00');
    assert.equal(sch.decideCatchUp({ schedule: s, lastScheduledRunAt: null, now }), null);
    assert.equal(sch.decideCatchUp({ schedule: { ...s, enabled: false }, lastScheduledRunAt: L(2026, 3, 9).toISOString(), now }), null);
    assert.equal(sch.decideCatchUp({ schedule: s, lastScheduledRunAt: 'nope', now }), null);
});

test('catch-up with a frequent cron picks only the latest slot (one run)', () => {
    const s = { enabled: true, frequency: 'cron', cron: '0 * * * *' };
    const slot = sch.decideCatchUp({ schedule: s, lastScheduledRunAt: L(2026, 3, 10, 6, 0).toISOString(), now: L(2026, 3, 10, 10, 20) });
    assert.equal(iso(slot), '2026-03-10 10:00');
});

test('legacy weekly without a weekday keeps running daily', () => {
    const legacy = { enabled: true, frequency: 'weekly', time: '08:00' };
    assert.equal(iso(sch.computeNextRun(legacy, L(2026, 3, 10, 9, 0))), '2026-03-11 08:00');
    assert.equal(iso(sch.computeNextRun(legacy, L(2026, 3, 11, 9, 0))), '2026-03-12 08:00');
    assert.deepEqual(sch.validateSchedule(legacy), []);
    assert.match(sch.validateSchedule({ ...legacy, weekday: 9 })[0], /weekday must be 0/);
});

test('cron uses Vixie day semantics: a field starting with * is unrestricted (AND)', () => {
    const at = (cron, now) => iso(sch.computeNextRun({ enabled: true, frequency: 'cron', cron }, now));
    // odd days of month AND Friday (not OR): Mar 11 (Wed, odd) must not fire; Fri Mar 13 is odd
    assert.equal(at('0 9 */2 * fri', L(2026, 3, 10, 0, 0)), '2026-03-13 09:00');
    assert.equal(at('0 9 */2 * fri', L(2026, 3, 14, 0, 0)), '2026-03-27 09:00'); // Mar 20 is even
    assert.equal(at('0 9 * * */2', L(2026, 3, 10, 0, 0)), '2026-03-10 09:00'); // Tuesday is in */2 (0,2,4,6)
});

test('cron that can never match is rejected when enabled; a disabled schedule may hold an empty or partial cron', () => {
    assert.match(sch.validateSchedule({ enabled: true, frequency: 'cron', cron: '0 0 31 2 *' })[0], /never matches/);
    assert.deepEqual(sch.validateSchedule({ enabled: false, frequency: 'cron', cron: '' }), []);
    assert.deepEqual(sch.validateSchedule({ enabled: false, frequency: 'cron', cron: '0 3 *' }), []);
    assert.match(sch.validateSchedule({ enabled: true, frequency: 'cron', cron: '' })[0], /schedule\.cron/);
    // partial (PATCH body) validation does not demand completeness
    assert.deepEqual(sch.validateSchedule({ enabled: true }, { partial: true }), []);
    assert.deepEqual(sch.validateSchedule({ frequency: 'cron' }, { partial: true }), []);
});

test('a disabled schedule is never rejected for an empty or malformed time; an enabled one is', () => {
    assert.deepEqual(sch.validateSchedule({ enabled: false, frequency: 'daily', time: '' }), []);
    assert.deepEqual(sch.validateSchedule({ enabled: false, frequency: 'weekly', weekday: 2, time: '7pm' }), []);
    assert.match(sch.validateSchedule({ enabled: true, frequency: 'daily', time: '' })[0], /HH:MM/);
});
