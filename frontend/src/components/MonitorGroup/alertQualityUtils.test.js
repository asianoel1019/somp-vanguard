import test from 'node:test';
import assert from 'node:assert/strict';
import { badgesFor, describeWindow, describeScope, buildWindowPayload, toLocalInput, suppressionBadge, isHostInActiveWindow } from './alertQualityUtils.js';

const weekly = (over = {}) => ({ name: 'x', kind: 'weekly', weekdays: [0], startTime: '02:00', durationMin: 60, scopeType: 'all', ...over });
const once = (over = {}) => ({ name: 'x', kind: 'once', startLocal: '2026-10-14T22:00', endLocal: '2026-10-15T00:00', scopeType: 'all', ...over });

test('badgesFor maps suppression, escalation and occurrences', () => {
    assert.deepEqual(badgesFor({ suppressedReason: 'maintenance' }).map(b => b.icon), ['🔕']);
    assert.deepEqual(badgesFor({ suppressedReason: 'flapping', escalatedAt: '2026-10-14T00:00:00Z', occurrences: 37 }).map(b => b.label), ['Flapping', 'Escalated', '×37']);
    assert.deepEqual(badgesFor({ occurrences: 1 }), []);
    assert.deepEqual(badgesFor({}), []);
});

test('badgesFor marks alerts resolved because the host was excluded from the rule', () => {
    assert.deepEqual(badgesFor({ resolved: 1, resolvedReason: 'excluded' }).map(b => b.label), ['Excluded']);
    assert.deepEqual(badgesFor({ resolved: 1, resolvedReason: null }), []);
});

test('suppressionBadge returns only own keys of the suppression table', () => {
    assert.equal(suppressionBadge({ suppressedReason: 'cooldown' }).label, 'Cooldown');
    assert.equal(suppressionBadge({ suppressedReason: 'constructor' }), null);
    assert.equal(suppressionBadge({ suppressedReason: 'toString' }), null);
    assert.equal(suppressionBadge({}), null);
    assert.equal(suppressionBadge(null), null);
});

test('badgesFor ignores prototype keys as suppression reasons', () => {
    assert.deepEqual(badgesFor({ suppressedReason: 'constructor' }), []);
    assert.deepEqual(badgesFor({ suppressedReason: 'toString', occurrences: 1 }), []);
});

test('badgesFor uses a safe title for an unparsable escalatedAt', () => {
    const [b] = badgesFor({ escalatedAt: 'not-a-date' });
    assert.equal(b.label, 'Escalated');
    assert.equal(b.title, 'Escalation notice sent');
    assert.doesNotMatch(b.title, /Invalid Date/);
});

test('describeWindow', () => {
    assert.equal(describeWindow({ kind: 'weekly', weekdays: [0, 6], startTime: '02:00', durationMin: 120 }), 'Every Sun, Sat from 02:00 for 2 h');
    assert.equal(describeWindow({ kind: 'weekly', weekdays: [1], startTime: '23:30', durationMin: 45 }), 'Every Mon from 23:30 for 45 min');
    assert.match(describeWindow({ kind: 'once', startAt: '2026-10-14T14:00:00Z', endAt: '2026-10-14T16:00:00Z' }), /~/);
});

test('describeWindow ignores weekday indexes outside 0-6', () => {
    assert.equal(describeWindow({ kind: 'weekly', weekdays: [7, 1, -1], startTime: '02:00', durationMin: 60 }), 'Every Mon from 02:00 for 1 h');
});

test('describeScope renders each scope type and the rule suffix', () => {
    assert.equal(describeScope({ scopeType: 'all', scopeValues: [] }), 'All hosts');
    assert.equal(describeScope({ scopeType: 'monitors', scopeValues: ['m1', 'm2'] }, { m1: { name: 'web-01' } }), 'Hosts: web-01, m2');
    assert.equal(describeScope({ scopeType: 'tags', scopeValues: ['a', 'b'] }), 'Tags: a, b');
    assert.equal(describeScope({ scopeType: 'envs', scopeValues: ['prod'] }), 'Environments: prod');
    assert.equal(describeScope({ scopeType: 'all', scopeValues: [], ruleIds: ['r1', 'r2'] }), 'All hosts (limited to 2 rules)');
});

test('buildWindowPayload validates like the backend', () => {
    const ok = buildWindowPayload(once({ scopeValues: [], ruleIds: [] }));
    assert.equal(ok.ok, true, ok.errors.join());
    assert.equal(ok.payload.startAt, new Date('2026-10-14T22:00').toISOString());
    assert.equal(buildWindowPayload(once({ startLocal: '2026-10-15T00:00', endLocal: '2026-10-14T00:00' })).ok, false);
    assert.equal(buildWindowPayload(weekly({ weekdays: [] })).ok, false);
    assert.equal(buildWindowPayload(weekly({ scopeType: 'tags', scopeValues: [] })).ok, false);
    assert.equal(buildWindowPayload(weekly({ name: '' })).ok, false);
});

test('buildWindowPayload builds a valid weekly payload shape (deduped, sorted, numeric)', () => {
    const r = buildWindowPayload(weekly({ weekdays: [6, 0, 6, '3'], durationMin: '90', scopeType: 'envs', scopeValues: ['prod'], ruleIds: ['r1'], reason: '  patch  ' }));
    assert.equal(r.ok, true, r.errors.join());
    assert.deepEqual(r.payload.weekdays, [0, 3, 6]);
    assert.equal(r.payload.durationMin, 90);
    assert.equal(typeof r.payload.durationMin, 'number');
    assert.deepEqual(r.payload.scopeValues, ['prod']);
    assert.deepEqual(r.payload.ruleIds, ['r1']);
    assert.equal(r.payload.reason, 'patch');
    assert.equal(r.payload.startTime, '02:00');
});

test('buildWindowPayload rejects a name longer than 100 characters', () => {
    const r = buildWindowPayload(weekly({ name: 'a'.repeat(101) }));
    assert.equal(r.ok, false);
    assert.equal(buildWindowPayload(weekly({ name: 'a'.repeat(100) })).ok, true);
});

test('buildWindowPayload rejects weekday 7 and non-integer weekdays', () => {
    assert.equal(buildWindowPayload(weekly({ weekdays: [7] })).ok, false);
    assert.equal(buildWindowPayload(weekly({ weekdays: [1.5] })).ok, false);
});

test('buildWindowPayload rejects an unknown scopeType', () => {
    assert.equal(buildWindowPayload(weekly({ scopeType: 'hosts', scopeValues: ['x'] })).ok, false);
});

test('buildWindowPayload rejects more than 500 scope values', () => {
    const vals = Array.from({ length: 501 }, (_, i) => `v${i}`);
    assert.equal(buildWindowPayload(weekly({ scopeType: 'monitors', scopeValues: vals })).ok, false);
    assert.equal(buildWindowPayload(weekly({ scopeType: 'monitors', scopeValues: vals.slice(0, 500) })).ok, true);
});

test('buildWindowPayload rejects empty-string and over-long scope values', () => {
    assert.equal(buildWindowPayload(weekly({ scopeType: 'tags', scopeValues: [''] })).ok, false);
    assert.equal(buildWindowPayload(weekly({ scopeType: 'tags', scopeValues: ['a'.repeat(201)] })).ok, false);
});

test('buildWindowPayload rejects null or missing once boundaries', () => {
    assert.equal(buildWindowPayload(once({ startLocal: null })).ok, false);
    assert.equal(buildWindowPayload(once({ endLocal: null })).ok, false);
    assert.equal(buildWindowPayload(once({ startLocal: undefined })).ok, false);
});

test('buildWindowPayload treats non-array ruleIds as [] and rejects bad entries', () => {
    const r = buildWindowPayload(weekly({ ruleIds: 'r1' }));
    assert.equal(r.ok, true, r.errors.join());
    assert.deepEqual(r.payload.ruleIds, []);
    assert.equal(buildWindowPayload(weekly({ ruleIds: [''] })).ok, false);
    assert.equal(buildWindowPayload(weekly({ ruleIds: Array.from({ length: 501 }, (_, i) => `r${i}`) })).ok, false);
});

test('buildWindowPayload sends scopeValues [] for scope all', () => {
    const r = buildWindowPayload(weekly({ scopeValues: ['ignored'] }));
    assert.equal(r.ok, true, r.errors.join());
    assert.deepEqual(r.payload.scopeValues, []);
});

test('toLocalInput round-trips', () => {
    const iso = new Date(2026, 9, 14, 9, 5).toISOString();
    assert.equal(toLocalInput(iso), '2026-10-14T09:05');
});

test("isHostInActiveWindow", () => {
    const m = { id: "m1", tags: ["web"], envId: "e1" };
    assert.equal(isHostInActiveWindow([{ status: "active", scopeType: "tags", scopeValues: ["web"] }], m), true);
    assert.equal(isHostInActiveWindow([{ status: "scheduled", scopeType: "all", scopeValues: [] }], m), false);
    assert.equal(isHostInActiveWindow([{ status: "active", scopeType: "monitors", scopeValues: ["m2"] }], m), false);
    assert.equal(isHostInActiveWindow([{ status: "active", scopeType: "all", scopeValues: [], ruleIds: ["r1"] }], m), false);
});
