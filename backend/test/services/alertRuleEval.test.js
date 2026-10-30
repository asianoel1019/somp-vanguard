require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const ev = require('../../services/alertRuleEval');

const metrics = {
    cpu: { used: 95 }, memory: { used: 40 },
    disk: [{ mount: 'C:', used: 91 }],
    services: [{ name: 'W3SVC', status: 'Stopped' }],
    processes: [{ name: 'sqlservr.exe', status: 'Running', cpuUsage: 12.34, memoryMB: 2048 }],
};

test('evaluateCheck: metric thresholds', () => {
    assert.deepEqual(ev.evaluateCheck({ type: 'cpu', threshold: 90 }, metrics), { exceeded: true, value: 95 });
    assert.deepEqual(ev.evaluateCheck({ type: 'memory', threshold: 90 }, metrics), { exceeded: false, value: 40 });
    assert.deepEqual(ev.evaluateCheck({ type: 'disk', target: 'C:', threshold: 90 }, metrics), { exceeded: true, value: 91 });
    assert.deepEqual(ev.evaluateCheck({ type: 'service', target: 'W3SVC' }, metrics), { exceeded: true, value: 'stopped' });
    assert.equal(ev.evaluateCheck({ type: 'disk', target: 'Z:', threshold: 90 }, metrics), null, 'no data → skip');
});

test('evaluateCheck: process rules keep the engine wording', () => {
    assert.deepEqual(ev.evaluateCheck({ type: 'process', target: 'missing.exe' }, metrics), { exceeded: true, value: 'stopped' });
    assert.deepEqual(ev.evaluateCheck({ type: 'process', target: 'SQLSERVR.EXE', cpuThreshold: 10 }, metrics), { exceeded: true, value: 'CPU: 12.3%' });
    assert.deepEqual(ev.evaluateCheck({ type: 'process', target: 'sqlservr.exe', memThreshold: 1000 }, metrics), { exceeded: true, value: 'Memory: 2048.0MB' });
    assert.deepEqual(ev.evaluateCheck({ type: 'process', target: 'sqlservr.exe' }, metrics), { exceeded: false, value: 'running' });
});

test('binding index resolves monitor / apikey / tag / env, globals only when asked', () => {
    const idx = ev.buildBindingIndex([
        { ruleId: 'r-mon', scopeType: 'monitor', scopeValue: 'm1' },
        { ruleId: 'r-key', scopeType: 'apikey', scopeValue: 'k1' },
        { ruleId: 'r-tag', scopeType: 'tag', scopeValue: 'prod' },
        { ruleId: 'r-env', scopeType: 'env', scopeValue: 'e1' },
        { ruleId: 'r-all', scopeType: 'all', scopeValue: '' },
        { ruleId: 'r-mon', scopeType: 'tag', scopeValue: 'prod' },
        { ruleId: 'r-other', scopeType: 'monitor', scopeValue: 'm2' },
    ]);
    const m = { id: 'm1', apiKey: 'k1', tags: '["prod"]', envId: 'e1' };
    assert.deepEqual(ev.applicableRuleIds(idx, m, { includeGlobal: false }), ['r-mon', 'r-key', 'r-tag', 'r-env']);
    assert.deepEqual(ev.applicableRuleIds(idx, m, { includeGlobal: true }), ['r-mon', 'r-key', 'r-tag', 'r-env', 'r-all']);
});
