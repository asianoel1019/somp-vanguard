require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgent, buildSystemPrompt } = require('../../lib/agent/agentLoop');

const user = { username: 'boss', domain: 'corp', role: 'SuperAdmin' };
const NOW = new Date('2026-10-08T06:00:00.000Z');

function fakeRegistry({ suggestions } = {}) {
    const calls = [];
    return {
        calls,
        definitions: () => [{ name: 'find_host', description: 'd', parameters: { type: 'object', properties: {} } }],
        async execute(name, args) {
            calls.push({ name, args });
            return {
                ok: true,
                content: `<tool_result name="${name}">\n{"ok":true}\n</tool_result>`,
                summary: '{"ok":true}',
                ...(suggestions ? { suggestions } : {}),
            };
        },
    };
}

function scriptedChat(responses) {
    const requests = [];
    const chat = async (req) => {
        requests.push(JSON.parse(JSON.stringify(req)));
        const next = responses.shift();
        if (!next) throw new Error('no more scripted responses');
        return typeof next === 'function' ? next(req) : next;
    };
    return { chat, requests };
}

const toolCall = (id, name = 'find_host', args = { query: 'web-03' }) => ({ text: '', toolCalls: [{ id, name, args }] });
const answer = (text) => ({ text, toolCalls: [] });

test('system prompt states time, read-only role and untrusted tool data', () => {
    const p = buildSystemPrompt(NOW);
    assert.match(p, /2026-10-08T06:00:00\.000Z/);
    assert.match(p, /唯讀/);
    assert.match(p, /tool_result/);
    assert.match(p, /不可信/);
    assert.match(p, /suggest_actions/);
});

test('direct answer without tools', async () => {
    const { chat, requests } = scriptedChat([answer('沒問題')]);
    const r = await runAgent({ chat, registry: fakeRegistry(), user, question: 'hi', now: NOW });
    assert.equal(r.answer, '沒問題');
    assert.deepEqual(r.steps, []);
    assert.equal(requests[0].toolChoice, 'auto');
    assert.equal(requests[0].tools.length, 1);
});

test('tool round trip: events, tool messages appended, then answer', async () => {
    const { chat, requests } = scriptedChat([toolCall('c1'), answer('結論：CPU 高')]);
    const registry = fakeRegistry();
    const events = [];
    const r = await runAgent({ chat, registry, user, question: 'web-03?', now: NOW, onEvent: (e, d) => events.push([e, d]) });

    assert.equal(r.answer, '結論：CPU 高');
    assert.equal(registry.calls[0].name, 'find_host');
    assert.deepEqual(events.map(e => e[0]), ['step_start', 'step_end']);
    assert.equal(events[0][1].tool, 'find_host');
    assert.equal(events[1][1].ok, true);
    const second = requests[1].messages;
    assert.equal(second[1].role, 'assistant');
    assert.equal(second[1].toolCalls[0].id, 'c1');
    assert.deepEqual(second[2], { role: 'tool', toolCallId: 'c1', name: 'find_host', content: '<tool_result name="find_host">\n{"ok":true}\n</tool_result>' });
    assert.equal(r.steps.length, 1);
});

test('history: only user/assistant text, last N messages', async () => {
    const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    history.push({ role: 'assistant', content: '', error: 'x' });
    const { chat, requests } = scriptedChat([answer('ok')]);
    await runAgent({ chat, registry: fakeRegistry(), user, question: 'q', history, now: NOW, limits: { historyMessages: 4 } });
    assert.deepEqual(requests[0].messages.map(m => m.content), ['m26', 'm27', 'm28', 'm29', 'q']);
});

test('round limit forces a final answer with toolChoice none', async () => {
    const { chat, requests } = scriptedChat([toolCall('a'), toolCall('b'), answer('final')]);
    const r = await runAgent({ chat, registry: fakeRegistry(), user, question: 'q', now: NOW, limits: { maxRounds: 2 } });
    assert.equal(r.answer, 'final');
    assert.equal(r.budgetExhausted, true);
    const last = requests[requests.length - 1];
    assert.equal(last.toolChoice, 'none');
    assert.match(last.messages[last.messages.length - 1].content, /上限/);
});

test('tool call limit: extra calls get an error result and are not executed', async () => {
    const many = { text: '', toolCalls: [1, 2, 3].map(i => ({ id: `t${i}`, name: 'find_host', args: {} })) };
    const { chat, requests } = scriptedChat([many, answer('done')]);
    const registry = fakeRegistry();
    const r = await runAgent({ chat, registry, user, question: 'q', now: NOW, limits: { maxToolCalls: 2 } });
    assert.equal(registry.calls.length, 2);
    const toolMsgs = requests[1].messages.filter(m => m.role === 'tool');
    assert.equal(toolMsgs.length, 3);
    assert.match(toolMsgs[2].content, /budget exhausted/);
    assert.equal(r.answer, 'done');
});

test('suggestions are merged and de-duplicated', async () => {
    const s = [{ type: 'runbook', id: 'rb-1', title: 'A' }];
    const { chat } = scriptedChat([toolCall('x1'), toolCall('x2'), answer('ok')]);
    const r = await runAgent({ chat, registry: fakeRegistry({ suggestions: s }), user, question: 'q', now: NOW });
    assert.deepEqual(r.suggestions, s);
});

test('abort signal stops before the next step with code ABORTED and keeps steps', async () => {
    const ac = new AbortController();
    const { chat } = scriptedChat([toolCall('c1'), () => { ac.abort(); return toolCall('c2'); }, answer('never')]);
    await assert.rejects(
        runAgent({ chat, registry: fakeRegistry(), user, question: 'q', now: NOW, signal: ac.signal }),
        (e) => e.code === 'ABORTED' && e.steps.length === 1,
    );
});

test('total timeout rejects with code TIMEOUT', async () => {
    const chat = () => new Promise(() => {});
    await assert.rejects(
        runAgent({ chat, registry: fakeRegistry(), user, question: 'q', now: NOW, limits: { totalTimeoutMs: 50 } }),
        (e) => e.code === 'TIMEOUT' && /逾時/.test(e.message),
    );
});

test('provider errors propagate with steps attached', async () => {
    const { chat } = scriptedChat([toolCall('c1'), () => { throw Object.assign(new Error('boom'), { code: 'PROVIDER_ERROR' }); }]);
    await assert.rejects(
        runAgent({ chat, registry: fakeRegistry(), user, question: 'q', now: NOW }),
        (e) => e.code === 'PROVIDER_ERROR' && e.steps.length === 1,
    );
});

test('forced-final falls back to a text-only call when toolChoice none is rejected', async () => {
    const { chat, requests } = scriptedChat([
        toolCall('a'),
        () => { throw Object.assign(new Error('tool_choice none not supported'), { code: 'PROVIDER_ERROR' }); },
        answer('依據已取得資料：CPU 高'),
    ]);
    const r = await runAgent({ chat, registry: fakeRegistry(), user, question: 'q', now: NOW, limits: { maxRounds: 1 } });
    assert.equal(r.answer, '依據已取得資料：CPU 高');
    assert.equal(r.budgetExhausted, true);
    const last = requests[requests.length - 1];
    assert.deepEqual(last.tools, []);
    assert.ok(last.messages.every(m => m.role !== 'tool' && !m.toolCalls));
    assert.match(last.messages[last.messages.length - 1].content, /已取得的查詢結果[\s\S]*tool_result/);
});

test('forced-final with only tool calls yields an explanatory answer', async () => {
    const { chat } = scriptedChat([toolCall('a'), toolCall('b')]);
    const r = await runAgent({ chat, registry: fakeRegistry(), user, question: 'q', now: NOW, limits: { maxRounds: 1 } });
    assert.match(r.answer, /未能產生最終答覆/);
});

test('repeated or missing tool-call ids are made unique across rounds', async () => {
    const { chat, requests } = scriptedChat([
        { text: '', toolCalls: [{ id: 'call_0', name: 'find_host', args: {} }] },
        { text: '', toolCalls: [{ id: 'call_0', name: 'find_host', args: {} }, { name: 'find_host', args: {} }] },
        answer('ok'),
    ]);
    await runAgent({ chat, registry: fakeRegistry(), user, question: 'q', now: NOW });
    const ids = requests[2].messages.filter(m => m.role === 'tool').map(m => m.toolCallId);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 3);
});

test('history never starts with an assistant message', async () => {
    const history = [{ role: 'assistant', content: 'orphan' }, { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }];
    const { chat, requests } = scriptedChat([answer('ok')]);
    await runAgent({ chat, registry: fakeRegistry(), user, question: 'q', history, now: NOW, limits: { historyMessages: 3 } });
    assert.deepEqual(requests[0].messages.map(m => m.content), ['u1', 'a1', 'q']);
});

test('chat receives the deadline and abort signal; rate-limit retries become notice events', async () => {
    const ac = new AbortController();
    const seen = {};
    const chat = async (req) => {
        seen.deadline = req.deadline;
        seen.signal = req.signal;
        req.onRetry({ waitMs: 17000, attempt: 1, maxRetries: 3, status: 429 });
        req.onRetry({ waitMs: 2000, attempt: 2, maxRetries: 3, status: 503 });
        return { text: 'ok', toolCalls: [] };
    };
    const events = [];
    const before = Date.now();
    await runAgent({ chat, registry: fakeRegistry(), user, question: 'q', now: NOW, signal: ac.signal, onEvent: (e, d) => events.push([e, d]) });
    assert.ok(seen.deadline >= before + 179000 && seen.deadline <= Date.now() + 180000);
    assert.equal(seen.signal, ac.signal);
    assert.deepEqual(events.map(e => e[0]), ['notice', 'notice']);
    assert.match(events[0][1].message, /請求次數已達上限，17 秒後自動重試（第 1\/3 次）/);
    assert.match(events[1][1].message, /暫時忙碌，2 秒後自動重試（第 2\/3 次）/);
});

test('RATE_LIMITED on the forced-final call is not retried text-only (would hit the quota again)', async () => {
    const { chat, requests } = scriptedChat([
        toolCall('a'),
        () => { throw Object.assign(new Error('AI 服務請求次數已達上限'), { code: 'RATE_LIMITED' }); },
        answer('never'),
    ]);
    await assert.rejects(runAgent({ chat, registry: fakeRegistry(), user, question: 'q', now: NOW, limits: { maxRounds: 1 } }), { code: 'RATE_LIMITED' });
    assert.equal(requests.length, 2);
});
