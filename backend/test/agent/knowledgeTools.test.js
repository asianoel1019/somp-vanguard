require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const scoutDb = require('../../services/scoutDb');
const { writeDataSync } = require('../../lib/db');
const { writeRbacConfig } = require('../../lib/rbac');
const wf = require('../../lib/workflow');
const { PRESEEDED_RUNBOOKS } = require('../../routes/runbook');
const tools = require('../../lib/agent/tools');
const getHostChangeHistory = require('../../lib/agent/tools/getHostChangeHistory');
const searchRunbooks = require('../../lib/agent/tools/searchRunbooks');
const getRunbook = require('../../lib/agent/tools/getRunbook');
const listWorkflows = require('../../lib/agent/tools/listWorkflows');
const suggestActions = require('../../lib/agent/tools/suggestActions');

const NOW = new Date('2026-10-08T06:00:00.000Z');
const admin = { username: 'boss', domain: 'corp', role: 'SuperAdmin', groups: [] };
const ctx = { user: admin, now: NOW };
let workflow;

test.before(async () => {
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: {} });
    await dbManager.initDB();
    require('../../services/cmdbModel').initCmdbTable();
    await scoutDb.run('INSERT INTO monitors (id, name, ip, os, status, lastSeen) VALUES (?,?,?,?,?,?)', ['m-web', 'web-03', '10.0.5.13', 'Windows', 'online', NOW.toISOString()]);
    writeDataSync('server_operation/server_cmdb_history.json', [
        { id: 'h3', ip: '10.0.5.13', username: 'alice', action: 'Update', timestamp: '2026-10-07T10:00:00Z', oldData: { memoryGB: 8, notes: 'a' }, newData: { memoryGB: 16, notes: 'a' } },
        { id: 'h2', ip: '10.0.5.13', username: 'SYSTEM', action: 'Global Auto-Sync', timestamp: '2026-10-07T09:00:00Z' },
        { id: 'h1', ip: '10.0.9.9', username: 'bob', action: 'Update', timestamp: '2026-10-06T10:00:00Z', oldData: { os: 'x' }, newData: { os: 'y' } },
    ]);
    writeDataSync('runbooks.json', [
        { id: 'rb-custom', title: 'IIS w3wp CPU 飆高處理', component: 'IIS', tags: ['cpu', 'windows'], content: '1. 檢查 w3wp 應用程式集區\n2. 回收 App Pool', updatedBy: 'alice', updatedAt: '2026-10-01' },
    ]);
    workflow = wf.createWorkflow({ name: 'Recycle IIS App Pool', description: 'Recycle the IIS application pool on a web server', nodes: [{ id: 'start', type: 'start' }, { id: 'ps', type: 'powershell', data: { command: 'Restart-WebAppPool' } }], edges: [] });
});

test.after(async () => { await dbManager.closeDB(); });

test('get_host_change_history: changed fields only, auto-sync skipped', async () => {
    const r = await getHostChangeHistory.run({ host: 'web-03' }, ctx);
    assert.equal(r.count, 1);
    assert.equal(r.changes[0].user, 'alice');
    assert.deepEqual(r.changes[0].changedFields, [{ field: 'memoryGB', from: '8', to: '16' }]);
});

test('get_host_change_history: by IP and unknown host', async () => {
    const r = await getHostChangeHistory.run({ host: '10.0.9.9' }, ctx);
    assert.equal(r.changes[0].user, 'bob');
    const none = await getHostChangeHistory.run({ host: 'nope-host' }, ctx);
    assert.equal(none.count, 0);
    assert.match(none.note, /No host/);
});

test('search_runbooks: custom and preset runbooks are searchable, read-only', async () => {
    const r = await searchRunbooks.run({ query: 'w3wp' }, ctx);
    const custom = r.results.find(x => x.id === 'rb-custom');
    assert.ok(custom, 'custom runbook is found (presets may match too)');
    assert.ok(custom.snippet.includes('w3wp'));
    const preset = PRESEEDED_RUNBOOKS[0];
    const r2 = await searchRunbooks.run({ query: preset.title.slice(0, 6) }, ctx);
    assert.ok(r2.results.some(x => x.id === preset.id));
    const { readDataSync } = require('../../lib/db');
    assert.equal(readDataSync('runbooks.json', []).length, 1, 'search must not seed presets into storage');
});

test('get_runbook: returns content and errors on unknown id', async () => {
    const r = await getRunbook.run({ id: 'rb-custom' }, ctx);
    assert.equal(r.title, 'IIS w3wp CPU 飆高處理');
    assert.ok(r.content.includes('回收 App Pool'));
    await assert.rejects(getRunbook.run({ id: 'missing' }, ctx), /not found/);
});

test('list_workflows: filter by keyword', async () => {
    const r = await listWorkflows.run({ query: 'iis' }, ctx);
    assert.equal(r.count, 1);
    assert.equal(r.workflows[0].id, workflow.id);
    assert.deepEqual(r.workflows[0].nodeTypes, ['powershell']);
});

test('suggest_actions: only existing, permitted IDs are accepted', async () => {
    const r = await suggestActions.run({ runbookIds: ['rb-custom', 'fake-rb'], workflowIds: [workflow.id, 'wf-fake'], reason: 'CPU' }, ctx);
    assert.deepEqual(r.suggestions, [
        { type: 'runbook', id: 'rb-custom', title: 'IIS w3wp CPU 飆高處理' },
        { type: 'workflow', id: workflow.id, title: 'Recycle IIS App Pool' },
    ]);
    assert.equal(r.rejected.length, 2);
});

test('suggest_actions: workflows rejected without workflow permission', async () => {
    const viewer = { username: 'v', domain: 'corp', role: 'Viewer', groups: [] };
    const r = await suggestActions.run({ workflowIds: [workflow.id] }, { user: viewer, now: NOW });
    assert.equal(r.suggestions.length, 0);
    assert.match(r.rejected[0].reason, /permission/);
});

test('tool list has 9 uniquely named tools in the documented order', () => {
    assert.deepEqual(tools.map(t => t.name), [
        'find_host', 'get_host_metrics', 'list_alerts', 'search_logs', 'get_host_change_history',
        'search_runbooks', 'get_runbook', 'list_workflows', 'suggest_actions',
    ]);
});
