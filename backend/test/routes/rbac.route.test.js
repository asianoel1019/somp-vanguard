require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { signToken } = require('../helpers/http');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/rbac', require('../../routes/rbac'));
    return app;
}

const app = buildApp();
const superAdmin = `Bearer ${signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' })}`;
const operator = `Bearer ${signToken({ username: 'op', domain: 'corp', role: 'Operator' })}`;

test('GET /api/rbac without token -> 401', async () => {
    await request(app).get('/api/rbac').expect(401);
});

test('GET /api/rbac as Operator -> 403', async () => {
    await request(app).get('/api/rbac').set('Authorization', operator).expect(403);
});

test('GET /api/rbac as SuperAdmin -> 200 with roles', async () => {
    const res = await request(app).get('/api/rbac').set('Authorization', superAdmin).expect(200);
    assert.ok(res.body.roles.includes('SuperAdmin'));
});

test('POST /api/rbac validates required fields', async () => {
    await request(app).post('/api/rbac').set('Authorization', superAdmin)
        .send({ username: 'dave', domain: 'corp' }).expect(400);
});

test('POST then DELETE /api/rbac updates and removes a user role', async () => {
    await request(app).post('/api/rbac').set('Authorization', superAdmin)
        .send({ username: 'dave', domain: 'corp', role: 'Operator' }).expect(200);
    let res = await request(app).get('/api/rbac').set('Authorization', superAdmin).expect(200);
    assert.equal(res.body.users['dave@corp'], 'Operator');

    await request(app).delete('/api/rbac').set('Authorization', superAdmin)
        .send({ username: 'dave', domain: 'corp' }).expect(200);
    res = await request(app).get('/api/rbac').set('Authorization', superAdmin).expect(200);
    assert.equal(res.body.users['dave@corp'], undefined);
});

test('POST /api/rbac with invalid role -> 500 and nothing saved', async () => {
    await request(app).post('/api/rbac').set('Authorization', superAdmin)
        .send({ username: 'eve', domain: 'corp', role: 'God' }).expect(500);
    const res = await request(app).get('/api/rbac').set('Authorization', superAdmin);
    assert.equal(res.body.users['eve@corp'], undefined);
});
