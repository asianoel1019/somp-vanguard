require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { signToken } = require('../helpers/http');
const wf = require('../../lib/workflow');

const app = express();
app.use(express.json());
app.use('/api/workflow', require('../../routes/workflow'));

const superAdmin = `Bearer ${signToken({ username: 'boss', domain: 'corp', role: 'SuperAdmin' })}`;
const operator = `Bearer ${signToken({ username: 'op', domain: 'corp', role: 'Operator' })}`;

const workflow = wf.createWorkflow({
    name: 'Approval route test',
    nodes: [{ id: 'ap', type: 'approval', data: { message: 'ok?' } }, { id: 'after', type: 'loop', data: { items: [1] } }],
    edges: [{ id: 'e1', source: 'ap', target: 'after' }],
});

async function startPaused() {
    const res = await request(app).post(`/api/workflow/${workflow.id}/execute`).set('Authorization', superAdmin).send({}).expect(200);
    assert.equal(res.body.status, 'waiting_approval');
    return res.body.id;
}

test('approve requires SuperAdmin', async () => {
    const execId = await startPaused();
    await request(app).post(`/api/workflow/executions/${execId}/approve`).expect(401);
    await request(app).post(`/api/workflow/executions/${execId}/approve`).set('Authorization', operator).expect(403);
    assert.equal(wf.getExecution(execId).status, 'waiting_approval');
});

test('SuperAdmin approve resumes the execution', async () => {
    const execId = await startPaused();
    const res = await request(app).post(`/api/workflow/executions/${execId}/approve`)
        .set('Authorization', superAdmin).send({ comment: 'looks good' }).expect(200);
    assert.equal(res.body.status, 'success');
    assert.equal(res.body.nodeResults.ap.output.decidedBy, 'boss@corp');
    assert.equal(res.body.nodeResults.ap.output.comment, 'looks good');
    assert.equal(res.body.nodeResults.after.status, 'success');
});

test('SuperAdmin reject stops the execution', async () => {
    const execId = await startPaused();
    const res = await request(app).post(`/api/workflow/executions/${execId}/reject`)
        .set('Authorization', superAdmin).send({ comment: 'no' }).expect(200);
    assert.equal(res.body.status, 'rejected');
    assert.equal(res.body.nodeResults.after.status, 'skipped');
});

test('deciding twice returns 409, unknown execution returns 404', async () => {
    const execId = await startPaused();
    await request(app).post(`/api/workflow/executions/${execId}/approve`).set('Authorization', superAdmin).expect(200);
    await request(app).post(`/api/workflow/executions/${execId}/reject`).set('Authorization', superAdmin).expect(409);
    await request(app).post('/api/workflow/executions/exec-missing/approve').set('Authorization', superAdmin).expect(404);
});
