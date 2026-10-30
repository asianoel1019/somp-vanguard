require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readDataSync } = require('../../lib/db');
const { executeWorkflow, getExecutions, getExecution, resolveApproval } = require('../../lib/workflow');

const start = { id: 'start', type: 'start' };
const end = { id: 'end', type: 'end' };
const edge = (source, target, sourceHandle) => ({ id: `${source}-${target}`, source, target, sourceHandle });
const loopNode = (id, items = [1]) => ({ id, type: 'loop', data: { items } });
const failNode = (id) => ({ id, type: 'teleport' });

// ── Ordering & context ──

test('runs nodes in topological order, not array order', async () => {
    const wf = {
        id: 'wf-order',
        // check listed BEFORE loop on purpose; edge loop -> check enforces order
        nodes: [start, { id: 'check', type: 'condition', data: { expression: 'ctx["loop.output"].total === 3' } },
                loopNode('loop', [1, 2, 3]), end],
        edges: [edge('start', 'loop'), edge('loop', 'check'), edge('check', 'end', 'true')],
    };
    const exec = await executeWorkflow(wf);
    assert.equal(exec.status, 'success');
    assert.deepEqual(exec.nodeResults.loop.output, { total: 3, processed: [1, 2, 3] });
    assert.equal(exec.nodeResults.check.output.condition, true);
    assert.equal(exec.nodeResults.end.status, 'success');
});

test('node outputs are reachable as ctx.<nodeId>.<field> (manual syntax)', async () => {
    const wf = {
        id: 'wf-nested',
        nodes: [loopNode('node_1', [1, 2]), { id: 'c', type: 'condition', data: { expression: 'ctx.node_1.total === 2' } }],
        edges: [edge('node_1', 'c')],
    };
    const exec = await executeWorkflow(wf);
    assert.equal(exec.nodeResults.c.output.condition, true);
});

test('condition resolves {{var}} from trigger inputs', async () => {
    const wf = {
        id: 'wf-vars',
        nodes: [start, { id: 'c', type: 'condition', data: { expression: '{{threshold}} > 5' } }],
        edges: [edge('start', 'c')],
    };
    const exec = await executeWorkflow(wf, { inputs: { threshold: 10 } });
    assert.equal(exec.nodeResults.c.output.condition, true);
    assert.equal(exec.nodeResults.c.output.selectedBranch, 'true');
});

// ── Condition node ──

test('condition node ends with status success', async () => {
    const exec = await executeWorkflow({ id: 'wf-cond-status', nodes: [{ id: 'c', type: 'condition', data: { expression: 'true' } }], edges: [] });
    assert.equal(exec.nodeResults.c.status, 'success');
    assert.equal(exec.status, 'success');
});

test('invalid condition expression fails the node with a readable error', async () => {
    const wf = { id: 'wf-badexpr', nodes: [{ id: 'c', type: 'condition', data: { expression: ')(' } }], edges: [] };
    const exec = await executeWorkflow(wf);
    assert.equal(exec.status, 'failed');
    assert.equal(exec.nodeResults.c.status, 'failed');
    assert.match(exec.nodeResults.c.error, /Unexpected token/);
});

test('condition referencing a missing node output fails instead of silently going false', async () => {
    const wf = { id: 'wf-missing', nodes: [{ id: 'c', type: 'condition', data: { expression: 'parseInt(ctx.node_9.stdout) > 85' } }], edges: [] };
    const exec = await executeWorkflow(wf);
    assert.equal(exec.nodeResults.c.status, 'failed');
    assert.match(exec.nodeResults.c.error, /Cannot read property "stdout" of undefined/);
});

test('condition expressions cannot reach Node.js globals', async () => {
    const exec = await executeWorkflow({ id: 'wf-sandbox', nodes: [{ id: 'c', type: 'condition', data: { expression: 'typeof process !== "undefined"' } }], edges: [] });
    assert.equal(exec.nodeResults.c.status, 'failed');
    const exec2 = await executeWorkflow({ id: 'wf-sandbox', nodes: [{ id: 'c', type: 'condition', data: { expression: 'ctx.constructor.constructor("return process")()' } }], edges: [] });
    assert.equal(exec2.nodeResults.c.status, 'failed');
    assert.match(exec2.nodeResults.c.error, /not allowed|Cannot call/);
});

// ── Branching ──

function branchWorkflow(id, expression) {
    return {
        id,
        nodes: [start, { id: 'c', type: 'condition', data: { expression } },
                loopNode('yes'), loopNode('yes_after'), loopNode('no'), loopNode('join'), end],
        edges: [edge('start', 'c'),
                edge('c', 'yes', 'true'), edge('yes', 'yes_after'),
                edge('c', 'no', 'false'),
                edge('yes_after', 'join'), edge('no', 'join'), edge('join', 'end')],
    };
}

test('false branch: true-side nodes and their descendants are skipped, join still runs', async () => {
    const exec = await executeWorkflow(branchWorkflow('wf-branch-f', 'false'));
    const s = (id) => exec.nodeResults[id].status;
    assert.equal(s('yes'), 'skipped');
    assert.equal(s('yes_after'), 'skipped');
    assert.equal(s('no'), 'success');
    assert.equal(s('join'), 'success');
    assert.equal(s('end'), 'success');
    assert.equal(exec.status, 'success');
});

test('true branch: false-side nodes are skipped', async () => {
    const exec = await executeWorkflow(branchWorkflow('wf-branch-t', 'true'));
    assert.equal(exec.nodeResults.yes.status, 'success');
    assert.equal(exec.nodeResults.yes_after.status, 'success');
    assert.equal(exec.nodeResults.no.status, 'skipped');
    assert.equal(exec.nodeResults.join.status, 'success');
});

test('nodes downstream of a failed node are skipped; independent branches still run', async () => {
    const wf = {
        id: 'wf-fail-downstream',
        nodes: [start, failNode('bad'), loopNode('after_bad'), loopNode('independent')],
        edges: [edge('start', 'bad'), edge('bad', 'after_bad'), edge('start', 'independent')],
    };
    const exec = await executeWorkflow(wf);
    assert.equal(exec.status, 'failed');
    assert.equal(exec.nodeResults.bad.status, 'failed');
    assert.equal(exec.nodeResults.after_bad.status, 'skipped');
    assert.equal(exec.nodeResults.independent.status, 'success');
});

// ── Other node types ──

test('unknown node type fails the workflow with a clear error', async () => {
    const exec = await executeWorkflow({ id: 'wf-unknown', nodes: [failNode('x')], edges: [] });
    assert.equal(exec.status, 'failed');
    assert.equal(exec.nodeResults.x.status, 'failed');
    assert.equal(exec.nodeResults.x.error, 'Unknown node type: teleport');
});

test('retry.count retries a failing node', async () => {
    const wf = { id: 'wf-retry', nodes: [{ id: 'x', type: 'teleport', data: { retry: { count: 2, delay: 0.01 } } }], edges: [] };
    const exec = await executeWorkflow(wf);
    assert.equal(exec.nodeResults.x.attempts, 3);
    assert.equal(exec.nodeResults.x.status, 'failed');
});

test('sleep node waits roughly the configured seconds', async () => {
    const wf = { id: 'wf-sleep', nodes: [{ id: 's', type: 'sleep', data: { seconds: 0.05 } }], edges: [] };
    const t0 = Date.now();
    const exec = await executeWorkflow(wf);
    assert.ok(Date.now() - t0 >= 45);
    assert.deepEqual(exec.nodeResults.s.output, { slept: 50 });
});

test('script node is refused for non-SuperAdmin triggers', async () => {
    const wf = { id: 'wf-script', nodes: [{ id: 'js', type: 'script', data: { code: 'return 1' } }], edges: [] };
    const exec = await executeWorkflow(wf, { triggerRole: 'Operator' });
    assert.equal(exec.status, 'failed');
    assert.match(exec.nodeResults.js.error, /restricted to SuperAdmin/);
});

test('script node (SuperAdmin) returns a result, logs to stdout and shares ctx downstream', async () => {
    const wf = {
        id: 'wf-script-ok',
        nodes: [
            { id: 'js', type: 'script', data: { code: 'console.log("count", ctx.items.length); ctx.flag = "set-by-script"; ctx.TRIGGER_USER_ROLE = "hacked"; return { total: ctx.items.length };' } },
            { id: 'c', type: 'condition', data: { expression: 'ctx.js.result.total === 2 && ctx.flag === "set-by-script" && ctx.TRIGGER_USER_ROLE === "SuperAdmin"' } },
        ],
        edges: [edge('js', 'c')],
    };
    const exec = await executeWorkflow(wf, { triggerRole: 'SuperAdmin', inputs: { items: ['a', 'b'] } });
    assert.equal(exec.nodeResults.js.status, 'success');
    assert.deepEqual(exec.nodeResults.js.output.result, { total: 2 });
    assert.equal(exec.nodeResults.js.output.stdout, 'count 2');
    assert.equal(exec.nodeResults.c.output.condition, true);
});

test('script node errors fail the node with the script error message', async () => {
    const wf = { id: 'wf-script-err', nodes: [{ id: 'js', type: 'script', data: { code: 'throw new Error("disk check failed")' } }], edges: [] };
    const exec = await executeWorkflow(wf, { triggerRole: 'SuperAdmin' });
    assert.equal(exec.nodeResults.js.status, 'failed');
    assert.match(exec.nodeResults.js.error, /disk check failed/);
});

test('script node cannot reach the host process', async () => {
    const wf = { id: 'wf-script-escape', nodes: [{ id: 'js', type: 'script', data: { code: 'return typeof ctx.constructor.constructor("return this")().process;' } }], edges: [] };
    const exec = await executeWorkflow(wf, { triggerRole: 'SuperAdmin' });
    assert.equal(exec.nodeResults.js.output.result, 'undefined');
});

test('executions are persisted and queryable by workflowId', async () => {
    const exec = await executeWorkflow({ id: 'wf-persist', nodes: [loopNode('l', [])], edges: [] });
    const list = getExecutions('wf-persist');
    assert.ok(list.some(e => e.id === exec.id));
    assert.ok(getExecutions('wf-order').every(e => e.workflowId === 'wf-order'));
});

// ── Approval ──

function approvalWorkflow(id) {
    return {
        id, name: 'Reboot prod',
        nodes: [start, loopNode('before'), { id: 'ap', type: 'approval', data: { message: 'Reboot {{host}}?' } },
                loopNode('after'), end],
        edges: [edge('start', 'before'), edge('before', 'ap'), edge('ap', 'after'), edge('after', 'end')],
    };
}

test('approval pauses the workflow: downstream nodes stay pending', async () => {
    const exec = await executeWorkflow(approvalWorkflow('wf-ap-pause'), { inputs: { host: 'web-01' } });
    assert.equal(exec.status, 'waiting_approval');
    assert.equal(exec.nodeResults.before.status, 'success');
    assert.equal(exec.nodeResults.ap.status, 'pending_approval');
    assert.equal(exec.nodeResults.after.status, 'pending');
    assert.equal(exec.nodeResults.end.status, 'pending');
    assert.equal(exec.approval.nodeId, 'ap');
    assert.equal(exec.approval.message, 'Reboot web-01?');
    assert.equal(getExecution(exec.id).status, 'waiting_approval');
});

test('paused execution does not persist injected system credentials', async (t) => {
    process.env.AD_ADMIN_PWD = 'super-secret-ad-pwd';
    t.after(() => { delete process.env.AD_ADMIN_PWD; });
    const exec = await executeWorkflow(approvalWorkflow('wf-ap-secret'));
    const raw = require('../../services/logTables').getHandle().prepare('SELECT entry FROM workflow_executions WHERE exec_id = ?').get(exec.id);
    assert.ok(raw && raw.entry.includes(exec.id));
    assert.ok(!raw.entry.includes('super-secret-ad-pwd'));
});

test('approving resumes from the approval node and completes the workflow', async () => {
    const paused = await executeWorkflow(approvalWorkflow('wf-ap-ok'), { inputs: { host: 'web-01' } });
    const done = await resolveApproval(paused.id, { approved: true, user: 'boss@corp', comment: 'go' });
    assert.equal(done.status, 'success');
    assert.equal(done.nodeResults.ap.status, 'success');
    assert.equal(done.nodeResults.ap.output.approved, true);
    assert.equal(done.nodeResults.ap.output.decidedBy, 'boss@corp');
    assert.equal(done.nodeResults.after.status, 'success');
    assert.equal(done.nodeResults.end.status, 'success');
    assert.equal(done.nodeResults.before.attempts, 1, 'nodes before approval must not run again');
    const stored = getExecution(paused.id);
    assert.equal(stored.status, 'success');
    assert.equal(stored.ctx, undefined, 'context snapshot is dropped once finished');
});

test('rejecting stops the workflow and skips remaining nodes', async () => {
    const paused = await executeWorkflow(approvalWorkflow('wf-ap-no'));
    const done = await resolveApproval(paused.id, { approved: false, user: 'boss@corp', comment: 'not now' });
    assert.equal(done.status, 'rejected');
    assert.equal(done.nodeResults.ap.status, 'rejected');
    assert.equal(done.nodeResults.ap.output.comment, 'not now');
    assert.equal(done.nodeResults.after.status, 'skipped');
    assert.equal(done.nodeResults.end.status, 'skipped');
});

test('an execution can only be decided once (concurrent approvals)', async () => {
    const paused = await executeWorkflow(approvalWorkflow('wf-ap-once'));
    const first = resolveApproval(paused.id, { approved: true, user: 'a@corp' });
    await assert.rejects(resolveApproval(paused.id, { approved: false, user: 'b@corp' }), { code: 'NOT_WAITING' });
    assert.equal((await first).status, 'success');
});

test('resolveApproval on unknown execution rejects with NOT_FOUND', async () => {
    await assert.rejects(resolveApproval('exec-nope', { approved: true, user: 'a' }), { code: 'NOT_FOUND' });
});

test('resumed workflow can hit a second approval', async () => {
    const wf = {
        id: 'wf-ap-two',
        nodes: [{ id: 'ap1', type: 'approval' }, { id: 'ap2', type: 'approval' }, loopNode('final')],
        edges: [edge('ap1', 'ap2'), edge('ap2', 'final')],
    };
    const p1 = await executeWorkflow(wf);
    const p2 = await resolveApproval(p1.id, { approved: true, user: 'a' });
    assert.equal(p2.status, 'waiting_approval');
    assert.equal(p2.approval.nodeId, 'ap2');
    const done = await resolveApproval(p1.id, { approved: true, user: 'a' });
    assert.equal(done.status, 'success');
    assert.equal(done.nodeResults.final.status, 'success');
});

test('waiting executions are never trimmed from history', async (t) => {
    // the table cap is 5000; the trimming rule is the same at any cap, so test it at the former 200
    const { executionLimits } = require('../../lib/workflow');
    const before = executionLimits.cap;
    executionLimits.cap = 200;
    t.after(() => { executionLimits.cap = before; });
    const paused = await executeWorkflow(approvalWorkflow('wf-ap-trim'));
    for (let i = 0; i < 205; i++) {
        await executeWorkflow({ id: 'wf-bulk', nodes: [loopNode('l', [])], edges: [] });
    }
    assert.equal(getExecution(paused.id).status, 'waiting_approval');
    const count = require('../../services/logTables').getHandle().prepare('SELECT COUNT(*) AS c FROM workflow_executions').get().c;
    assert.ok(count <= 200, `${count} rows`);
});
