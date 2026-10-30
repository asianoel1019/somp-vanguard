require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { encryptText } = require('../../lib/crypto');
const { createChat } = require('../../lib/agent/providers');
const { retryDelayMs, isDailyQuota } = require('../../lib/agent/providers/connection');

const geminiConfig = { enabled: true, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey_enc: encryptText('gk'), model: 'gemini-3.8-flash', timeout: 60000, maxTokens: 2048, temperature: 0.3 };
const ollamaConfig = { enabled: true, provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3', timeout: 60000, maxTokens: 2048, temperature: 0.3 };
const REQ = { system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [], toolChoice: 'auto' };

function httpError(status, data, headers = {}) {
    const e = new Error(`Request failed with status code ${status}`);
    e.response = { status, data, headers };
    return e;
}
const geminiQuota = (delay, extra = {}) => httpError(429, { error: {
    code: 429,
    message: `You exceeded your current quota, please check your plan and billing details. Please retry in ${delay}.`,
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }],
    ...extra,
} });
const geminiOk = { candidates: [{ content: { parts: [{ text: 'ok' }] } }] };

function scriptAxios(t, responses) {
    const calls = [];
    t.mock.method(axios, 'post', async () => {
        calls.push(Date.now());
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return { data: next };
    });
    return calls;
}

// ── delay parsing ──

test('retryDelayMs: Gemini RetryInfo, message text, Retry-After header, exponential fallback', () => {
    assert.equal(retryDelayMs(geminiQuota('17s'), 0), 17000);
    assert.equal(retryDelayMs(httpError(429, { error: { message: 'Quota exceeded. Please retry in 17.215495491s.' } }), 0), 17216);
    assert.equal(retryDelayMs(httpError(429, { error: { message: 'slow down' } }, { 'retry-after': '5' }), 0), 5000);
    assert.equal(retryDelayMs(httpError(503, {}), 0), 2000);
    assert.equal(retryDelayMs(httpError(503, {}), 2), 8000);
});

test('isDailyQuota detects per-day quota violations', () => {
    const daily = geminiQuota('3600s', { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] });
    assert.equal(isDailyQuota(daily), true);
    assert.equal(isDailyQuota(geminiQuota('17s')), false);
});

// ── retry behaviour through a real adapter ──

test('429 is retried after the provider-specified delay, then succeeds', async (t) => {
    const calls = scriptAxios(t, [geminiQuota('0.05s'), geminiOk]);
    const notices = [];
    const res = await createChat(geminiConfig)({ ...REQ, onRetry: (info) => notices.push(info) });
    assert.equal(res.text, 'ok');
    assert.equal(calls.length, 2);
    assert.ok(calls[1] - calls[0] >= 45, 'waited roughly the requested delay');
    assert.deepEqual(notices, [{ waitMs: 50, attempt: 1, maxRetries: 3, status: 429 }]);
});

test('503 overload is retried too (OpenAI-compatible adapter, Retry-After header)', async (t) => {
    scriptAxios(t, [httpError(503, { error: { message: 'overloaded' } }, { 'retry-after': '0' }), { choices: [{ message: { content: 'fine' } }] }]);
    const res = await createChat(ollamaConfig)(REQ);
    assert.equal(res.text, 'fine');
});

test('gives up after 3 retries with a RATE_LIMITED error in 繁體中文', async (t) => {
    const calls = scriptAxios(t, [geminiQuota('0.01s'), geminiQuota('0.01s'), geminiQuota('0.01s'), geminiQuota('0.01s'), geminiOk]);
    await assert.rejects(createChat(geminiConfig)(REQ), (e) => e.code === 'RATE_LIMITED' && /請求次數已達上限，自動重試後仍未成功/.test(e.message) && e.status === 429);
    assert.equal(calls.length, 4);
});

test('does not retry when the wait would pass the agent deadline', async (t) => {
    const calls = scriptAxios(t, [geminiQuota('17s'), geminiOk]);
    await assert.rejects(createChat(geminiConfig)({ ...REQ, deadline: Date.now() + 5000 }), { code: 'RATE_LIMITED' });
    assert.equal(calls.length, 1);
});

test('does not retry when the requested wait exceeds 60 seconds', async (t) => {
    const calls = scriptAxios(t, [geminiQuota('3600s')]);
    await assert.rejects(createChat(geminiConfig)(REQ), { code: 'RATE_LIMITED' });
    assert.equal(calls.length, 1);
});

test('daily quota is reported immediately with a "today" message', async (t) => {
    const daily = geminiQuota('0.01s', { details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] });
    const calls = scriptAxios(t, [daily, geminiOk]);
    await assert.rejects(createChat(geminiConfig)(REQ), (e) => e.code === 'RATE_LIMITED' && /今日請求額度/.test(e.message));
    assert.equal(calls.length, 1);
});

test('stop during the wait aborts immediately with ABORTED', async (t) => {
    scriptAxios(t, [geminiQuota('30s'), geminiOk]);
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(createChat(geminiConfig)({ ...REQ, signal: ac.signal }), { code: 'ABORTED' });
    assert.ok(Date.now() - started < 5000);
});

test('non-retryable errors are not retried', async (t) => {
    const calls = scriptAxios(t, [httpError(401, { error: { message: 'bad key' } }), geminiOk]);
    await assert.rejects(createChat(geminiConfig)(REQ), { code: 'PROVIDER_ERROR' });
    assert.equal(calls.length, 1);
});
