import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedule, describeSchedule, cronLooksValid, buildConfigPayload, scanBadge, triggerLabel, formatNextRun } from './inventoryScanUtils.js';

test('normalizeSchedule fills defaults and keeps valid values', () => {
    assert.deepEqual(normalizeSchedule(undefined), { enabled: false, frequency: 'daily', time: '08:00', weekday: 1, cron: '' });
    assert.deepEqual(normalizeSchedule({ enabled: true, frequency: 'weekly', weekday: 0, time: '02:30' }), { enabled: true, frequency: 'weekly', time: '02:30', weekday: 0, cron: '' });
    assert.equal(normalizeSchedule({ frequency: 'monthly' }).frequency, 'daily');
    assert.equal(normalizeSchedule({ weekday: '5' }).weekday, 5);
});

test('legacy weekly without a weekday is daily (it always ran daily)', () => {
    assert.equal(normalizeSchedule({ enabled: true, frequency: 'weekly', time: '07:00' }).frequency, 'daily');
    assert.equal(describeSchedule({ enabled: true, frequency: 'weekly', time: '07:00' }), 'Every day at 07:00');
    assert.equal(buildConfigPayload({ schedule: { enabled: true, frequency: 'weekly', time: '07:00' } }).schedule.frequency, 'daily');
    assert.equal(normalizeSchedule({ enabled: true, frequency: 'weekly', weekday: 0 }).frequency, 'weekly');
});

test('describeSchedule reads naturally for each frequency', () => {
    assert.equal(describeSchedule({ enabled: false }), 'Automatic scan is off');
    assert.equal(describeSchedule({ enabled: true, time: '07:15' }), 'Every day at 07:15');
    assert.equal(describeSchedule({ enabled: true, frequency: 'weekly', weekday: 6, time: '23:00' }), 'Every Saturday at 23:00');
    assert.equal(describeSchedule({ enabled: true, frequency: 'cron', cron: ' 0 3 * * 1-5 ' }), 'Cron: 0 3 * * 1-5');
    assert.equal(describeSchedule({ enabled: true, frequency: 'cron', cron: '' }), 'Cron expression missing');
});

test('cronLooksValid is a light 5-field check', () => {
    assert.equal(cronLooksValid('*/5 * * * *'), true);
    assert.equal(cronLooksValid('0 3 * * mon-fri'), true);
    assert.equal(cronLooksValid('0 3 * *'), false);
    assert.equal(cronLooksValid('0 3 * * *; rm'), false);
});

test('buildConfigPayload drops server-owned fields', () => {
    const p = buildConfigPayload({ subnets: ['10.0.0'], lastScan: 'x', lastDiscovered: 9, schedule: { enabled: true, frequency: 'cron', cron: '0 1 * * *' } });
    assert.equal(p.lastScan, undefined);
    assert.equal(p.lastDiscovered, undefined);
    assert.deepEqual(p.subnets, ['10.0.0']);
    assert.equal(p.schedule.cron, '0 1 * * *');
});

test('scanBadge covers live, aborting, aborted, interrupted, stale, completed, degraded, idle', () => {
    assert.equal(scanBadge(null), null);
    assert.equal(scanBadge({ running: true }).label, 'LIVE');
    assert.equal(scanBadge({ running: true, abortRequested: true }).label, 'ABORTING');
    assert.equal(scanBadge({ running: false, aborted: true, finishedAt: 'x' }).label, 'ABORTED');
    assert.equal(scanBadge({ running: false, aborted: true, interrupted: true }).label, 'INTERRUPTED');
    assert.equal(scanBadge({ running: false, stale: true }).label, 'STALE');
    assert.equal(scanBadge({ running: false, finishedAt: 'x' }).label, 'COMPLETED');
    assert.equal(scanBadge({ running: false, finishedAt: 'x', degraded: true }).tone, 'warning');
    assert.equal(scanBadge({ running: false }), null);
});

test('triggerLabel distinguishes manual / scheduled / catch-up', () => {
    assert.equal(triggerLabel({ trigger: 'manual', requestedBy: 'bob' }), 'Manual by bob');
    assert.equal(triggerLabel({ trigger: 'schedule', requestedBy: 'SYSTEM' }), 'Scheduled');
    assert.equal(triggerLabel({ trigger: 'catchup', requestedBy: 'SYSTEM' }), 'Scheduled (catch-up)');
    assert.equal(triggerLabel({}), '');
});

test('formatNextRun gives a relative hint', () => {
    const now = Date.parse('2026-03-10T00:00:00Z');
    assert.equal(formatNextRun(null, now), 'Not scheduled');
    assert.match(formatNextRun('2026-03-10T00:45:00Z', now), /in 45m\)$/);
    assert.match(formatNextRun('2026-03-10T05:05:00Z', now), /in 5h 5m\)$/);
    assert.match(formatNextRun('2026-03-20T00:00:00Z', now), /in 10 days\)$/);
    assert.match(formatNextRun('2026-03-09T23:00:00Z', now), /\(due\)$/);
});

test('specsErrorText shows the stored probe error (trimmed, max 500) and nothing for healthy hosts', async () => {
    const { specsErrorText } = await import('./inventoryScanUtils.js');
    assert.equal(specsErrorText({ ip: '1.1.1.1' }), '');
    assert.equal(specsErrorText({ error: null }), '');
    assert.equal(specsErrorText({ error: '  WinRM timed out after 60 s ' }), 'WinRM timed out after 60 s');
    assert.equal(specsErrorText({ specsError: 'x'.repeat(900) }).length, 500);
    assert.equal(specsErrorText(null), '');
});
