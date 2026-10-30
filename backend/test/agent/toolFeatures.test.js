require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeRbacConfig } = require('../../lib/rbac');
const { createRegistry } = require('../../lib/agent/toolRegistry');
const { createRedactor } = require('../../lib/agent/redact');
const { FEATURE_KEYS } = require('../../lib/featureCatalog');
const tools = require('../../lib/agent/tools');

const redactor = createRedactor({ secrets: [] });
const op = { username: 'op', domain: 'corp', role: 'Operator', groups: ['g'] };
const setGroup = (features) => writeRbacConfig({
    roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
    groups: { g: { type: 'group', target: 'g', enabled: true, features } },
});
const byName = (n) => tools.find(t => t.name === n);
const denied = (r) => r.ok === false && /沒有權限/.test(r.error || '');

test('runbook tools require the runbook feature (same switch as /api/runbook)', async () => {
    assert.equal(byName('get_runbook').feature, 'runbook');
    assert.equal(byName('search_runbooks').feature, 'runbook');
    const reg = createRegistry(tools);
    setGroup({ aiAgent: true });
    assert.ok(denied(await reg.execute('search_runbooks', {}, { user: op, redactor })));
    assert.ok(denied(await reg.execute('get_runbook', { id: 'x' }, { user: op, redactor })));
    setGroup({ aiAgent: true, runbook: true });
    assert.ok(!denied(await reg.execute('search_runbooks', {}, { user: op, redactor })));
    assert.ok(!denied(await reg.execute('get_runbook', { id: 'x' }, { user: op, redactor })));
});

test('search_logs accepts any of the log screens: monitorScout, monitorWinEvent or monitorLinuxLog', async () => {
    assert.deepEqual(byName('search_logs').feature, ['monitorScout', 'monitorWinEvent', 'monitorLinuxLog']);
    const stub = { ...byName('search_logs'), run: async () => ({ ok: 1 }) };
    const reg = createRegistry([stub]);
    setGroup({});
    assert.ok(denied(await reg.execute('search_logs', {}, { user: op, redactor })));
    for (const k of ['monitorScout', 'monitorWinEvent', 'monitorLinuxLog']) {
        setGroup({ [k]: true });
        const r = await reg.execute('search_logs', {}, { user: op, redactor });
        assert.equal(r.ok, true, k);
    }
});

test('every tool declares a catalogue feature (or none, only for UI-only helpers)', () => {
    const NO_FEATURE = new Set(['suggest_actions']); // only switches the view; the target screen checks its own feature
    for (const t of tools) {
        const feats = Array.isArray(t.feature) ? t.feature : (t.feature ? [t.feature] : []);
        if (!feats.length) { assert.ok(NO_FEATURE.has(t.name), `${t.name} has no feature`); continue; }
        for (const f of feats) assert.ok(FEATURE_KEYS.includes(f), `${t.name}: unknown feature ${f}`);
    }
});
