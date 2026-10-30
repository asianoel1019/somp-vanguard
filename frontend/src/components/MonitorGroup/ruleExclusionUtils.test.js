import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseTagList, isExcludedFor, excludedRulesForMonitor, exclusionsByRule, exclusionLabel,
    explicitBindingConflicts, filterMonitors, monitorLabel,
} from './ruleExclusionUtils.js';

const monitors = [
    { id: 'm1', name: 'WEB-01', ip: '10.0.0.1', tags: ['web', 'legacy'] },
    { id: 'm2', name: 'DB-01', ip: '10.0.0.2', tags: '["db"]' },
    { id: 'm3', name: 'APP-01', ip: '10.0.0.3', tags: '["app","web"]' },
    { id: 'm4', name: 'ODD-01', ip: '10.0.0.4', tags: 'web, db' },
];
const rules = [{ id: 'r1', name: 'Prod CPU' }, { id: 'r2', name: 'Disk' }, { id: 'r3', name: 'Mem' }];
const exclusions = [
    { id: 'x1', ruleId: 'r1', scopeType: 'monitor', scopeValue: 'm1', reason: 'decom', createdBy: 'alice', createdAt: '2026-10-27T01:00:00Z' },
    { id: 'x2', ruleId: 'r2', scopeType: 'tag', scopeValue: 'web' },
    { id: 'x3', ruleId: 'r3', scopeType: 'tag', scopeValue: 'db' },
];

test('parseTagList matches the backend: arrays and JSON array strings only', () => {
    assert.deepEqual(parseTagList(['a', 'b']), ['a', 'b']);
    assert.deepEqual(parseTagList('["a","b"]'), ['a', 'b']);
    assert.deepEqual(parseTagList('a, b ,'), [], 'comma lists are not tags for the engine either');
    assert.deepEqual(parseTagList(null), []);
    assert.deepEqual(parseTagList('[bad'), []);
    assert.deepEqual(parseTagList('{"a":1}'), []);
});

test('isExcludedFor: monitor id or any tag (mirrors backend ruleScope)', () => {
    assert.equal(isExcludedFor('r1', monitors[0], exclusions), true);
    assert.equal(isExcludedFor('r1', monitors[1], exclusions), false);
    assert.equal(isExcludedFor('r2', monitors[0], exclusions), true);
    assert.equal(isExcludedFor('r2', monitors[2], exclusions), true, 'JSON tag string');
    assert.equal(isExcludedFor('r2', monitors[3], exclusions), false, 'malformed (comma) tags: engine would still evaluate');
    assert.equal(isExcludedFor('r3', monitors[1], exclusions), true, 'JSON tag string');
    assert.equal(isExcludedFor('r3', monitors[0], exclusions), false);
    assert.equal(isExcludedFor('r1', null, exclusions), false);
});

test('excludedRulesForMonitor returns the rule names in rule order, unknown rules skipped', () => {
    assert.deepEqual(excludedRulesForMonitor(monitors[0], [...exclusions, { ruleId: 'gone', scopeType: 'monitor', scopeValue: 'm1' }], rules).map(r => r.name), ['Prod CPU', 'Disk']);
    assert.deepEqual(excludedRulesForMonitor(monitors[1], exclusions, rules).map(r => r.name), ['Mem']);
    assert.deepEqual(excludedRulesForMonitor({ id: 'zz', tags: [] }, exclusions, rules), []);
});

test('exclusionsByRule groups rows by ruleId', () => {
    const g = exclusionsByRule(exclusions);
    assert.deepEqual(Object.keys(g).sort(), ['r1', 'r2', 'r3']);
    assert.equal(g.r1[0].id, 'x1');
    assert.deepEqual(exclusionsByRule(null), {});
});

test('exclusionLabel / monitorLabel show host name (IP) or tag; missing monitor falls back to its id', () => {
    const byId = Object.fromEntries(monitors.map(m => [m.id, m]));
    assert.equal(exclusionLabel(exclusions[0], byId), 'Host: WEB-01 (10.0.0.1)');
    assert.equal(exclusionLabel(exclusions[1], byId), 'Tag: web');
    assert.equal(exclusionLabel({ scopeType: 'monitor', scopeValue: 'gone' }, byId), 'Host: gone');
    assert.equal(monitorLabel({ id: 'x', name: 'N' }), 'N');
});

test('explicitBindingConflicts: selected monitors that also have a direct binding to the rule', () => {
    const bindings = [
        { ruleId: 'r1', scopeType: 'monitor', scopeValue: 'm1' },
        { ruleId: 'r1', scopeType: 'env', scopeValue: 'prod' },
        { ruleId: 'r2', scopeType: 'monitor', scopeValue: 'm2' },
    ];
    assert.deepEqual(explicitBindingConflicts('r1', ['m1', 'm2'], bindings), ['m1']);
    assert.deepEqual(explicitBindingConflicts('r1', [], bindings), []);
    assert.deepEqual(explicitBindingConflicts('r3', ['m1'], bindings), []);
});

test('filterMonitors matches name, IP or tag (case-insensitive); empty query returns all', () => {
    assert.equal(filterMonitors(monitors, '').length, 4);
    assert.deepEqual(filterMonitors(monitors, 'web').map(m => m.id), ['m1', 'm3']);   // m4's malformed tags are ignored
    assert.deepEqual(filterMonitors(monitors, '10.0.0.2').map(m => m.id), ['m2']);
    assert.deepEqual(filterMonitors(monitors, 'LEGACY').map(m => m.id), ['m1']);
});
