require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { signToken } = require('../helpers/http');
const aiRouter = require('../../routes/ai');

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);
const superAdmin = `Bearer ${signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' })}`;

test('defaults: agent disabled, empty agent model, 30 per hour', async () => {
    const res = await request(app).get('/api/ai/config').set('Authorization', superAdmin).expect(200);
    assert.equal(res.body.agentEnabled, false);
    assert.equal(res.body.agentModel, '');
    assert.equal(res.body.agentRateLimitPerHour, 30);
});

test('agent fields are saved and returned', async () => {
    await request(app).post('/api/ai/config').set('Authorization', superAdmin)
        .send({ enabled: true, provider: 'ollama', baseUrl: 'http://localhost:11434', agentEnabled: true, agentModel: ' qwen3:14b ', agentRateLimitPerHour: 12 })
        .expect(200);
    const res = await request(app).get('/api/ai/config').set('Authorization', superAdmin).expect(200);
    assert.equal(res.body.agentEnabled, true);
    assert.equal(res.body.agentModel, 'qwen3:14b');
    assert.equal(res.body.agentRateLimitPerHour, 12);
});

test('saving without agent fields keeps previous agent values', async () => {
    await request(app).post('/api/ai/config').set('Authorization', superAdmin).send({ temperature: 0.2 }).expect(200);
    const res = await request(app).get('/api/ai/config').set('Authorization', superAdmin).expect(200);
    assert.equal(res.body.agentEnabled, true);
    assert.equal(res.body.agentModel, 'qwen3:14b');
    assert.equal(res.body.agentRateLimitPerHour, 12);
});

test('rate limit is clamped to 1..500', async () => {
    await request(app).post('/api/ai/config').set('Authorization', superAdmin).send({ agentRateLimitPerHour: 9999 }).expect(200);
    let res = await request(app).get('/api/ai/config').set('Authorization', superAdmin);
    assert.equal(res.body.agentRateLimitPerHour, 500);
    await request(app).post('/api/ai/config').set('Authorization', superAdmin).send({ agentRateLimitPerHour: 0 }).expect(200);
    res = await request(app).get('/api/ai/config').set('Authorization', superAdmin);
    assert.equal(res.body.agentRateLimitPerHour, 1);
});

test('isInternalHost is exported', () => {
    assert.equal(aiRouter.isInternalHost('http://10.1.2.3:11434'), true);
    assert.equal(aiRouter.isInternalHost('https://api.openai.com/v1'), false);
});

test('isInternalHost: intranet suffixes come from INTERNAL_DOMAINS and ALLOWED_AD_DOMAIN, not from code', () => {
    const saved = { i: process.env.INTERNAL_DOMAINS, a: process.env.ALLOWED_AD_DOMAIN };
    try {
        delete process.env.INTERNAL_DOMAINS;
        delete process.env.ALLOWED_AD_DOMAIN;
        assert.equal(aiRouter.isInternalHost('https://llm.corp.example'), false);
        assert.equal(aiRouter.isInternalHost('https://llm.lab.local'), true);
        process.env.INTERNAL_DOMAINS = ' corp.example , .intra ';
        assert.equal(aiRouter.isInternalHost('https://llm.corp.example'), true);
        assert.equal(aiRouter.isInternalHost('https://x.intra/v1'), true);
        assert.equal(aiRouter.isInternalHost('https://notcorp.example'), false);
        process.env.ALLOWED_AD_DOMAIN = '"ad.example"';
        assert.equal(aiRouter.isInternalHost('https://ollama.ad.example:11434'), true);
    } finally {
        if (saved.i === undefined) delete process.env.INTERNAL_DOMAINS; else process.env.INTERNAL_DOMAINS = saved.i;
        if (saved.a === undefined) delete process.env.ALLOWED_AD_DOMAIN; else process.env.ALLOWED_AD_DOMAIN = saved.a;
    }
});

test('runbook presets are exported', () => {
    const { PRESEEDED_RUNBOOKS } = require('../../routes/runbook');
    assert.ok(Array.isArray(PRESEEDED_RUNBOOKS) && PRESEEDED_RUNBOOKS.length > 0);
    assert.ok(PRESEEDED_RUNBOOKS[0].id && PRESEEDED_RUNBOOKS[0].title);
});
