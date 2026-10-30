require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { signToken } = require('../helpers/http');
const { writeDataSync } = require('../../lib/db');
const { writeRbacConfig } = require('../../lib/rbac');

const agentRouter = require('../../routes/agent');
const app = express();
app.use(express.json());
app.use('/api/agent', agentRouter);

const superAdmin = `Bearer ${signToken({ username: 'boss', domain: 'corp', role: 'SuperAdmin', groups: [] })}`;
const otherAdmin = `Bearer ${signToken({ username: 'eve', domain: 'corp', role: 'SuperAdmin', groups: [] })}`;
const operator = `Bearer ${signToken({ username: 'op', domain: 'corp', role: 'Operator', groups: [] })}`;

const setConfig = (extra = {}) => writeDataSync('system/ai_config.json', {
    enabled: true, provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3',
    agentEnabled: true, agentModel: '', agentRateLimitPerHour: 30, ...extra,
});

function sse(req) {
    return req.buffer(true).parse((res, cb) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; });
        res.on('end', () => cb(null, data));
    });
}

function parseEvents(text) {
    return text.split('\n\n').filter(Boolean).map(block => {
        const event = (block.match(/^event: (.*)$/m) || [])[1];
        const data = (block.match(/^data: (.*)$/m) || [])[1];
        return { event, data: data ? JSON.parse(data) : null };
    });
}

let chatCalls = [];
function useChat(responder) {
    chatCalls = [];
    agentRouter.__setChatFactory(() => async (req) => { chatCalls.push(req); return responder(req, chatCalls.length); });
}

test.beforeEach(() => {
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: {} });
    setConfig();
    useChat(() => ({ text: '## 結論\n一切正常', toolCalls: [] }));
});
test.after(() => agentRouter.__setChatFactory(null));

test('401 without token, 403 without aiAgent feature', async () => {
    await request(app).get('/api/agent/conversations').expect(401);
    await request(app).get('/api/agent/conversations').set('Authorization', operator).expect(403);
});

test('403 when the agent is disabled', async () => {
    setConfig({ agentEnabled: false });
    const res = await request(app).get('/api/agent/conversations').set('Authorization', superAdmin).expect(403);
    assert.match(res.body.error, /尚未啟用/);
});

test('400 on empty or oversized message', async () => {
    await request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: '  ' }).expect(400);
    await request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: 'x'.repeat(4001) }).expect(400);
});

test('chat streams conversation -> answer -> done and stores the turn', async () => {
    const res = await sse(request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: '系統狀況如何？' })).expect(200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    const events = parseEvents(res.body);
    assert.deepEqual(events.map(e => e.event), ['conversation', 'answer', 'done']);
    const convId = events[0].data.conversationId;
    assert.match(events[1].data.text, /一切正常/);

    const list = await request(app).get('/api/agent/conversations').set('Authorization', superAdmin).expect(200);
    assert.equal(list.body[0].id, convId);
    const conv = await request(app).get(`/api/agent/conversations/${convId}`).set('Authorization', superAdmin).expect(200);
    assert.equal(conv.body.messages.length, 2);
});

test('tool steps are streamed (search_runbooks needs no database)', async () => {
    useChat((req, n) => n === 1
        ? { text: '', toolCalls: [{ id: 'c1', name: 'search_runbooks', args: { query: 'cpu' } }] }
        : { text: '完成', toolCalls: [] });
    const res = await sse(request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: 'cpu runbook?' })).expect(200);
    const events = parseEvents(res.body);
    assert.deepEqual(events.map(e => e.event), ['conversation', 'step_start', 'step_end', 'answer', 'done']);
    assert.equal(events[1].data.tool, 'search_runbooks');
    assert.equal(events[2].data.ok, true);
});

test('follow-up sends previous turns as history; other users cannot use the conversation', async () => {
    const first = parseEvents((await sse(request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: '第一題' }))).body);
    const convId = first[0].data.conversationId;
    await sse(request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: '第二題', conversationId: convId })).expect(200);
    const lastReq = chatCalls[chatCalls.length - 1];
    assert.deepEqual(lastReq.messages.map(m => m.content).slice(-3), ['第一題', '## 結論\n一切正常', '第二題']);

    await request(app).post('/api/agent/chat').set('Authorization', otherAdmin).send({ message: 'x', conversationId: convId }).expect(404);
    await request(app).get(`/api/agent/conversations/${convId}`).set('Authorization', otherAdmin).expect(404);
});

test('provider errors are streamed as error events and stored', async () => {
    useChat(() => { throw Object.assign(new Error('AI 引擎請求逾時'), { code: 'PROVIDER_ERROR' }); });
    const events = parseEvents((await sse(request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: 'boom' }))).body);
    assert.deepEqual(events.map(e => e.event), ['conversation', 'error', 'done']);
    assert.match(events[1].data.message, /逾時/);
});

test('409 while a request is running, 429 over the hourly limit', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    useChat(async () => { await gate; return { text: 'ok', toolCalls: [] }; });
    const pending = sse(request(app).post('/api/agent/chat').set('Authorization', otherAdmin).send({ message: 'slow' }));
    const pendingDone = pending.then(r => r);
    await new Promise(r => setTimeout(r, 50));
    await request(app).post('/api/agent/chat').set('Authorization', otherAdmin).send({ message: 'again' }).expect(409);
    release();
    await pendingDone;

    setConfig({ agentRateLimitPerHour: 1 });
    const limitedUser = `Bearer ${signToken({ username: 'rl', domain: 'corp', role: 'SuperAdmin', groups: [] })}`;
    useChat(() => ({ text: 'ok', toolCalls: [] }));
    await sse(request(app).post('/api/agent/chat').set('Authorization', limitedUser).send({ message: 'one' })).expect(200);
    const res = await request(app).post('/api/agent/chat').set('Authorization', limitedUser).send({ message: 'two' }).expect(429);
    assert.match(res.body.error, /上限/);
});

test('delete conversation', async () => {
    const events = parseEvents((await sse(request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: 'to delete' }))).body);
    const convId = events[0].data.conversationId;
    await request(app).delete(`/api/agent/conversations/${convId}`).set('Authorization', superAdmin).expect(200);
    await request(app).get(`/api/agent/conversations/${convId}`).set('Authorization', superAdmin).expect(404);
});

test('POST /test works before the agent is enabled and reports tool support', async () => {
    setConfig({ agentEnabled: false });
    useChat(() => ({ text: '', toolCalls: [{ id: 't', name: 'get_server_time', args: {} }], model: 'qwen3' }));
    const ok = await request(app).post('/api/agent/test').set('Authorization', superAdmin).expect(200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.toolCalled, true);

    useChat(() => ({ text: 'It is noon', toolCalls: [], model: 'small' }));
    const no = await request(app).post('/api/agent/test').set('Authorization', superAdmin).expect(200);
    assert.equal(no.body.ok, false);

    await request(app).post('/api/agent/test').set('Authorization', operator).expect(403);
});

test('alertId context is wrapped as untrusted <alert_data> and sanitized', async () => {
    const res = await sse(request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: '請調查', alertId: 'a<script>\nX' })).expect(200);
    const events = parseEvents(res.body);
    assert.deepEqual(events.map(e => e.event), ['conversation', 'answer', 'done']);
    const userTurn = chatCalls[chatCalls.length - 1].messages.slice(-1)[0].content;
    assert.match(userTurn, /^<alert_data>\n\[告警資料\] (找不到|無法讀取)告警 a＜script＞ X\n<\/alert_data>\n\n請調查$/);
    assert.match(chatCalls[chatCalls.length - 1].system, /<alert_data>/);
});

test('storage failure still ends the stream with error + done', async (t) => {
    const store = require('../../lib/agent/conversationStore');
    t.mock.method(store, 'appendTurn', () => { throw new Error('disk full'); });
    const res = await sse(request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: 'save fail' })).expect(200);
    const events = parseEvents(res.body);
    assert.deepEqual(events.map(e => e.event), ['conversation', 'answer', 'error', 'done']);
    assert.match(events[2].data.message, /儲存失敗/);
});

test('alert conversations are titled with the user question, not the alert block', async () => {
    const res = await sse(request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: '請調查這筆', alertId: 'a1' })).expect(200);
    const convId = parseEvents(res.body)[0].data.conversationId;
    const list = await request(app).get('/api/agent/conversations').set('Authorization', superAdmin).expect(200);
    const item = list.body.find(c => c.id === convId);
    assert.equal(item.title, '請調查這筆');
    assert.ok(!item.title.startsWith('<alert_data>'));
});

test('audit log text is redacted before it is forwarded', async (t) => {
    const logger = require('../../lib/logger');
    const logged = [];
    t.mock.method(logger, 'auditLog', (...args) => { logged.push(args); });
    await sse(request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: 'check password=hunter22secret now' })).expect(200);
    const entry = logged.find(a => a[1] === 'AI Agent');
    assert.ok(entry, 'auditLog called');
    assert.match(entry[2], /password=\[REDACTED\]/);
    assert.ok(!entry[2].includes('hunter22secret'));
});

test('rate-limit retry notices are streamed as SSE notice events', async () => {
    useChat((req) => { req.onRetry({ waitMs: 5000, attempt: 1, maxRetries: 3, status: 429 }); return { text: 'ok', toolCalls: [] }; });
    const events = parseEvents((await sse(request(app).post('/api/agent/chat').set('Authorization', superAdmin).send({ message: 'quota test' }))).body);
    assert.deepEqual(events.map(e => e.event), ['conversation', 'notice', 'answer', 'done']);
    assert.match(events[1].data.message, /5 秒後自動重試/);
});
