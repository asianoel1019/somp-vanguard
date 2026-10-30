import test from 'node:test';
import assert from 'node:assert/strict';
import { failedConsumers, cascadeSummary, isRename, nonZeroUsage, usageSummary, deleteBlockReason, validateEnvironmentForm, isDefaultEnvironment, unmappedRows, unmappedLabel } from './environmentsUtils.js';

test('deleteBlockReason refuses the isDefault environment', () => {
    const envs = [{ id: '1', name: 'Others' }, { id: 'p', name: 'Prod', isDefault: true }];
    assert.match(deleteBlockReason(envs[1], envs, { total: 0, items: [] }), /default environment/);
});

test('validateEnvironmentForm rejects the reserved names Unassigned / (empty), case-insensitive', () => {
    const envs = [{ id: '1', name: 'Others' }, { id: 'u', name: 'Unassigned' }];
    assert.match(validateEnvironmentForm({ name: 'unassigned', purpose: '' }, envs, null), /reserved/);
    assert.match(validateEnvironmentForm({ name: '(EMPTY)', purpose: '' }, envs, '1'), /reserved/);
    assert.equal(validateEnvironmentForm({ name: 'Unassigned', purpose: 'x' }, envs, 'u'), null); // legacy entry keeps its name
});

test('unmappedRows flattens consumers, editable first, by count; empty value label', () => {
    const rows = unmappedRows([
        { key: 'prometheus_name', consumer: 'Prometheus', readOnly: true, values: [{ value: 'Mars', count: 9 }] },
        { key: 'cmdb', consumer: 'CMDB servers', values: [{ value: 'Lab', count: 1 }, { value: '', count: 5 }] }
    ]);
    assert.deepEqual(rows.map(r => [r.key, r.value]), [['cmdb', ''], ['cmdb', 'Lab'], ['prometheus_name', 'Mars']]);
    assert.equal(unmappedLabel(''), '(empty)');
    assert.equal(unmappedLabel('Lab'), 'Lab');
    assert.deepEqual(unmappedRows(null), []);
});

const usage = {
    id: 'p', name: 'Prod', total: 5,
    items: [
        { consumer: 'CMDB servers', count: 2, keyedBy: 'id' },
        { consumer: 'API keys', count: 0, keyedBy: 'id' },
        { consumer: 'SSL certificates', count: 3, keyedBy: 'name' }
    ]
};

test('nonZeroUsage keeps only referenced consumers', () => {
    assert.deepEqual(nonZeroUsage(usage).map(i => i.consumer), ['CMDB servers', 'SSL certificates']);
    assert.deepEqual(nonZeroUsage(null), []);
    assert.deepEqual(nonZeroUsage({}), []);
});

test('usageSummary lists consumers with counts, or says unused', () => {
    assert.equal(usageSummary(usage), 'CMDB servers: 2, SSL certificates: 3');
    assert.equal(usageSummary({ total: 0, items: [] }), 'Not referenced anywhere');
    assert.equal(usageSummary(null), '');
});

test('isDefaultEnvironment matches Others case-insensitively', () => {
    assert.equal(isDefaultEnvironment({ name: 'Others' }), true);
    assert.equal(isDefaultEnvironment({ name: ' others ' }), true);
    assert.equal(isDefaultEnvironment({ name: 'Prod' }), false);
    assert.equal(isDefaultEnvironment(null), false);
});

test('deleteBlockReason: default, last, still referenced, usage unknown, free', () => {
    const prod = { id: 'p', name: 'Prod' };
    const two = [{ id: '1', name: 'Others' }, prod];
    assert.match(deleteBlockReason({ id: '1', name: 'Others' }, two, { total: 0 }), /default/i);
    assert.match(deleteBlockReason(prod, [prod], { total: 0 }), /last/i);
    assert.match(deleteBlockReason(prod, two, usage), /5 reference/);
    assert.match(deleteBlockReason(prod, two, null), /usage/i);
    assert.equal(deleteBlockReason(prod, two, { total: 0, items: [] }), null);
});

test('validateEnvironmentForm mirrors the backend rules', () => {
    const envs = [{ id: '1', name: 'Others' }, { id: 'p', name: 'Production' }];
    assert.equal(validateEnvironmentForm({ name: '  ', purpose: '' }, envs, null), 'Name is required');
    assert.match(validateEnvironmentForm({ name: 'x'.repeat(65), purpose: '' }, envs, null), /64/);
    assert.match(validateEnvironmentForm({ name: 'ok', purpose: 'p'.repeat(257) }, envs, null), /256/);
    assert.match(validateEnvironmentForm({ name: 'production', purpose: '' }, envs, null), /already exists/);
    assert.equal(validateEnvironmentForm({ name: 'production', purpose: '' }, envs, 'p'), null); // renaming itself by case
    assert.equal(validateEnvironmentForm({ name: 'Stage', purpose: 'x' }, envs, null), null);
});

test('deleteBlockReason refuses when usage is incomplete', () => {
    const two = [{ id: '1', name: 'Others' }, { id: 'p', name: 'Prod' }];
    assert.match(deleteBlockReason(two[1], two, { total: 0, complete: false, items: [] }), /could not be determined/);
});

test('cascade result helpers', () => {
    const c = [{ consumer: 'SSL certificates', count: 2 }, { consumer: 'CMDB servers', count: 0, error: 'disk' }];
    assert.deepEqual(failedConsumers(c).map(x => x.consumer), ['CMDB servers']);
    assert.deepEqual(failedConsumers(undefined), []);
    assert.equal(cascadeSummary(c), 'SSL certificates: 2, CMDB servers: FAILED (disk)');
});

test('isRename ignores surrounding whitespace in the stored name', () => {
    assert.equal(isRename({ name: 'Others ' }, 'Others'), false);
    assert.equal(isRename({ name: 'Prod' }, ' Live '), true);
    assert.equal(isRename({ name: 'Prod' }, 'PROD'), true);
});
