import test from 'node:test';
import assert from 'node:assert/strict';
import {
    formatCount, aggregatePreviews, prometheusLabel, scoutHistoryLabel, ruleBindingsLabel,
    deleteButtonLabel, buildDeleteRequest, logsNotDeletedNote, deletableIps, cleanupFailures,
    offlineDaysOf, collectExtraLines, blockedByGuard, canOfferForce, buildInventoryDeleteRequest, showInventoryDeleteButton
} from './serverDeleteUtils.js';

const preview = (ip, over = {}) => ({
    ip, hostname: `H-${ip}`, exists: true,
    linkedVips: [],
    scout: { monitors: [{ id: `m-${ip}`, name: 'x' }], metricRows: 1000, alertRows: 3, eventRows: 4, logRows: 5 },
    prometheusTargets: [{ target: `${ip}:9100`, labels: {} }],
    ruleBindings: [{ ruleId: 'r1', ruleName: 'CPU' }],
    maintenanceWindows: [],
    ...over
});

test('formatCount shows unknown for null/undefined and groups digits', () => {
    assert.equal(formatCount(null), 'unknown');
    assert.equal(formatCount(undefined), 'unknown');
    assert.equal(formatCount(0), '0');
    assert.equal(formatCount(12345), '12,345');
});

test('aggregatePreviews sums counts, lists linked VIPs with their primary, and keeps unknown unknown', () => {
    const a = preview('10.0.0.1', { linkedVips: [{ ip: '10.0.0.9', hostname: 'vip' }] });
    const b = preview('10.0.0.2', { scout: { monitors: [], metricRows: 500, alertRows: 0, eventRows: null, logRows: 1 }, maintenanceWindows: [{ id: 'w', name: 'W' }] });
    const t = aggregatePreviews([a, b]);
    assert.equal(t.servers, 2);
    assert.deepEqual(t.linkedVips, [{ ip: '10.0.0.9', hostname: 'vip', primary: '10.0.0.1' }]);
    assert.equal(t.monitors, 1);
    assert.equal(t.prometheusTargets, 2);
    assert.equal(t.metricRows, 1500);
    assert.equal(t.eventRows, null);
    assert.equal(t.logRows, 6);
    assert.equal(t.ruleBindings, 2);
    assert.equal(t.maintenanceWindows, 1);
});

test('cleanup labels carry the counts', () => {
    const t = aggregatePreviews([preview('10.0.0.1')]);
    assert.equal(prometheusLabel(t), 'Remove from Prometheus targets (1 targets)');
    assert.equal(scoutHistoryLabel(t), 'Delete Scout history (≈ metrics 1,000 rows, alerts 3, events 4, logs 5)');
    assert.equal(logsNotDeletedNote(t), '');
    assert.equal(ruleBindingsLabel(t), 'Remove alert rule bindings & maintenance windows for this host (1 bindings, 0 windows)');
    const withEx = aggregatePreviews([preview('10.0.0.1', { ruleExclusions: [{ ruleId: 'r1', ruleName: 'CPU' }, { ruleId: 'r2', ruleName: 'Mem' }] }), preview('10.0.0.2')]);
    assert.equal(withEx.ruleExclusions, 2);
    assert.equal(ruleBindingsLabel(withEx), 'Remove alert rule bindings & maintenance windows for this host (2 bindings, 0 windows; 2 rule exclusion(s) are always removed with the host)');
    const unknown = aggregatePreviews([preview('10.0.0.1', { scout: { monitors: [], metricRows: 1, alertRows: 0, eventRows: null, logRows: null } })]);
    assert.equal(scoutHistoryLabel(unknown), 'Delete Scout history (≈ metrics 1 rows, alerts 0)');
    assert.equal(logsNotDeletedNote(unknown), 'Windows events / Linux logs: NOT deleted (no host index; removed by log rotation)');
    assert.equal(logsNotDeletedNote(aggregatePreviews([preview('10.0.0.1', { scout: { monitors: [], metricRows: 1, alertRows: 0, eventRows: 2, logRows: null } })])), 'Linux logs: NOT deleted (no host index; removed by log rotation)');
});

test('deleteButtonLabel reflects the count', () => {
    assert.equal(deleteButtonLabel(1), 'Delete 1 server');
    assert.equal(deleteButtonLabel(3), 'Delete 3 servers');
});

test('buildDeleteRequest: cleanup defaults off, only sent when the preview loaded', () => {
    const none = { prometheus: false, scoutHistory: false, ruleBindings: false };
    assert.deepEqual(buildDeleteRequest({ ips: ['10.0.0.1'], cleanup: none, previewOk: true }),
        { method: 'delete', url: '/server-list/10.0.0.1', data: {} });
    assert.deepEqual(buildDeleteRequest({ ips: ['10.0.0.1', '10.0.0.2'], cleanup: { ...none, prometheus: true, scoutHistory: true }, previewOk: true }),
        { method: 'post', url: '/server-list/bulk-delete', data: { ips: ['10.0.0.1', '10.0.0.2'], cleanup: { prometheus: true, scoutHistory: true } } });
    // preview failed: plain delete even if boxes were somehow checked
    assert.deepEqual(buildDeleteRequest({ ips: ['10.0.0.1'], cleanup: { ...none, prometheus: true }, previewOk: false }),
        { method: 'delete', url: '/server-list/10.0.0.1', data: {} });
});

test('capped counts show as "> 100,000" and unknown alerts stay unknown', () => {
    assert.equal(formatCount(100000), '100,000');
    assert.equal(formatCount(100001), '> 100,000');
    const t = aggregatePreviews([preview('10.0.0.1', { scout: { monitors: [], metricRows: 100001, alertRows: null, eventRows: null, logRows: null } })]);
    assert.equal(scoutHistoryLabel(t), 'Delete Scout history (≈ metrics > 100,000 rows, alerts unknown)');
});

test('deletableIps drops IPs that are not in Server List, only when the preview loaded', () => {
    const previews = [preview('10.0.0.1'), preview('10.0.0.2', { exists: false })];
    assert.deepEqual(deletableIps(['10.0.0.1', '10.0.0.2'], previews, true), ['10.0.0.1']);
    assert.deepEqual(deletableIps(['10.0.0.1', '10.0.0.2'], previews, false), ['10.0.0.1', '10.0.0.2']);
    assert.deepEqual(deletableIps(['10.0.0.1'], [], true), ['10.0.0.1']);
});

test('cleanupFailures names the failed cleanups', () => {
    assert.deepEqual(cleanupFailures({ cleaned: { prometheusTargets: 1 } }), []);
    assert.deepEqual(cleanupFailures({ cleaned: { prometheusError: 'boom', ruleBindingsError: 'bad' } }),
        ['Prometheus targets (boom)', 'rule bindings & maintenance windows (bad)']);
    assert.deepEqual(cleanupFailures(undefined), []);
});

test('offlineDaysOf: offlineSince first, legacy fallbacks, null when unknown or not offline', () => {
    const now = Date.parse('2026-03-20T00:00:00Z');
    assert.equal(offlineDaysOf({ status: 'offline', offlineSince: '2026-03-10T00:00:00Z' }, now), 10);
    assert.equal(offlineDaysOf({ status: 'offline', lastSeen: '2026-03-15T00:00:00Z' }, now), 5);
    assert.equal(offlineDaysOf({ status: 'offline', lastChecked: '2026-03-19T00:00:00Z' }, now), null, 'lastChecked is refreshed by every scan: not a fallback');
    assert.equal(offlineDaysOf({ status: 'offline' }, now), null);
    assert.equal(offlineDaysOf({ status: 'online', offlineSince: '2026-03-10T00:00:00Z' }, now), null);
});

test('inventory previews: extra lines are flattened, guard blocks are listed', () => {
    const previews = [
        { ip: '10.0.0.1', lines: ['Server Inventory: the host record will be removed', 'IPAM 10.0.0.1: released'], inventory: { blocked: false } },
        { ip: '10.0.0.2', lines: ['Blocked: Offline for 1.0 days; at least 7 days required'], inventory: { blocked: true, blockedReason: 'Offline for 1.0 days; at least 7 days required' } }
    ];
    assert.deepEqual(collectExtraLines(previews).map(l => l.ip), ['10.0.0.1', '10.0.0.1', '10.0.0.2']);
    assert.deepEqual(blockedByGuard(previews), [{ ip: '10.0.0.2', reason: 'Offline for 1.0 days; at least 7 days required' }]);
    assert.deepEqual(blockedByGuard(null), []);
});

test('force is offered to SuperAdmin only, and only when the guard blocks', () => {
    const blocked = [{ ip: '10.0.0.2', reason: 'x' }];
    assert.equal(canOfferForce({ role: 'SuperAdmin', blocked }), true);
    assert.equal(canOfferForce({ role: 'SuperAdmin', blocked: [] }), false);
    assert.equal(canOfferForce({ role: 'SuperAdmin', blocked: [], refused: true }), true);
    assert.equal(canOfferForce({ role: 'Operator', blocked }), false);
    assert.equal(canOfferForce({ role: 'Operator', blocked: [], refused: true }), false);
});

test('buildInventoryDeleteRequest: single host DELETE with cleanup / force, bulk POST by days', () => {
    const none = { prometheus: false, scoutHistory: false, ruleBindings: false };
    assert.deepEqual(buildInventoryDeleteRequest({ ips: ['10.0.0.1'], cleanup: none, previewOk: true }),
        { method: 'delete', url: '/inventory/server/10.0.0.1', data: {} });
    assert.deepEqual(buildInventoryDeleteRequest({ ips: ['10.0.0.1'], cleanup: { ...none, prometheus: true }, previewOk: true, force: true }),
        { method: 'delete', url: '/inventory/server/10.0.0.1', data: { cleanup: { prometheus: true }, force: true } });
    assert.deepEqual(buildInventoryDeleteRequest({ ips: ['10.0.0.1'], cleanup: { ...none, prometheus: true }, previewOk: false, force: false }),
        { method: 'delete', url: '/inventory/server/10.0.0.1', data: {} });
    assert.deepEqual(buildInventoryDeleteRequest({ ips: ['10.0.0.1', '10.0.0.2'], cleanup: { ...none, scoutHistory: true }, previewOk: true, bulkDays: 30, force: true }),
        { method: 'post', url: '/inventory/bulk-delete-offline', data: { days: 30, dryRun: false, ips: ['10.0.0.1', '10.0.0.2'], cleanup: { scoutHistory: true } } });
});

test('showInventoryDeleteButton: offline hosts only; Operator needs the threshold, SuperAdmin may force below it', () => {
    const now = Date.parse('2026-03-20T00:00:00Z');
    const online = { status: 'online', offlineSince: '2026-03-01T00:00:00Z' };
    const longOff = { status: 'offline', offlineSince: '2026-03-10T00:00:00Z' };
    const shortOff = { status: 'offline', offlineSince: '2026-03-18T00:00:00Z' };
    for (const role of ['SuperAdmin', 'Operator', 'Viewer']) assert.equal(showInventoryDeleteButton(online, role, 7, now), false, role);
    assert.equal(showInventoryDeleteButton(longOff, 'Operator', 7, now), true);
    assert.equal(showInventoryDeleteButton(shortOff, 'Operator', 7, now), false);
    assert.equal(showInventoryDeleteButton(shortOff, 'SuperAdmin', 7, now), true);
    assert.equal(showInventoryDeleteButton(longOff, 'Viewer', 7, now), false);
});
