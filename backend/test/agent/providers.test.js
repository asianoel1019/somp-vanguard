require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { encryptText } = require('../../lib/crypto');
const { createChat } = require('../../lib/agent/providers');
const { resolveConnection } = require('../../lib/agent/providers/connection');

const TOOLS = [{
    name: 'find_host',
    description: 'Find hosts',
    parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 100, description: 'name' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] },
}];
const HISTORY = [
    { role: 'user', content: 'web-03 CPU?' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'find_host', args: { query: 'web-03' } }] },
    { role: 'tool', toolCallId: 'call_1', name: 'find_host', content: '<tool_result name="find_host">{"matches":1}</tool_result>' },
];
const baseConfig = (extra) => ({ enabled: true, temperature: 0.3, timeout: 60000, maxTokens: 2048, ...extra });

function captureAxios(t, responseData) {
    const calls = [];
    t.mock.method(axios, 'post', async (url, body, opts) => {
        calls.push({ url, body, opts });
        return { data: responseData };
    });
    return calls;
}

test('resolveConnection prefers agentModel and never proxies internal hosts', () => {
    const conn = resolveConnection(baseConfig({ provider: 'ollama', baseUrl: 'http://10.0.0.5:11434/', model: 'llama3', agentModel: 'qwen3:14b' }));
    assert.equal(conn.model, 'qwen3:14b');
    assert.equal(conn.baseUrl, 'http://10.0.0.5:11434');
    assert.equal(conn.axiosOptions.proxy, false);
    assert.equal(conn.maxTokens, 2048);
});

test('createChat rejects invalid config with AI_CONFIG_INVALID', () => {
    assert.throws(() => createChat(baseConfig({ enabled: false, provider: 'ollama', baseUrl: 'http://x' })), { code: 'AI_CONFIG_INVALID' });
});

test('openai-compatible: request shape and tool call parsing', async (t) => {
    const calls = captureAxios(t, {
        model: 'gpt-x',
        choices: [{ message: { content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'find_host', arguments: '{"query":"db-01"}' } }] } }],
    });
    const chat = createChat(baseConfig({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey_enc: encryptText('sk-test'), model: 'gpt-x' }));
    const res = await chat({ system: 'SYS', messages: HISTORY, tools: TOOLS, toolChoice: 'auto' });

    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer sk-test');
    const body = calls[0].body;
    assert.deepEqual(body.messages[0], { role: 'system', content: 'SYS' });
    assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"query":"web-03"}');
    assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'call_1', content: HISTORY[2].content });
    assert.equal(body.tools[0].function.name, 'find_host');
    assert.equal(body.tool_choice, 'auto');
    assert.deepEqual(res.toolCalls, [{ id: 'call_2', name: 'find_host', args: { query: 'db-01' } }]);
    assert.equal(res.text, '');
});

test('openai-compatible: invalid JSON arguments are flagged, not thrown', async (t) => {
    captureAxios(t, { choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'find_host', arguments: '{oops' } }] } }] });
    const chat = createChat(baseConfig({ provider: 'custom', baseUrl: 'http://10.0.0.9:8000/v1', model: 'm' }));
    const res = await chat({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, toolChoice: 'auto' });
    assert.equal(res.toolCalls[0].args.__invalidJson, '{oops');
});

test('ollama uses the OpenAI-compatible /v1 endpoint without auth', async (t) => {
    const calls = captureAxios(t, { choices: [{ message: { content: 'done' } }] });
    const chat = createChat(baseConfig({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3' }));
    const res = await chat({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [], toolChoice: 'auto' });
    assert.equal(calls[0].url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(calls[0].opts.headers.Authorization, undefined);
    assert.equal(calls[0].body.tools, undefined);
    assert.equal(res.text, 'done');
});

test('azure uses deployment URL and api-key header', async (t) => {
    const calls = captureAxios(t, { choices: [{ message: { content: 'ok' } }] });
    const chat = createChat(baseConfig({ provider: 'azure', baseUrl: 'https://corp.openai.azure.com', apiKey_enc: encryptText('az-key'), model: 'gpt4o-deploy' }));
    await chat({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, toolChoice: 'none' });
    assert.equal(calls[0].url, 'https://corp.openai.azure.com/openai/deployments/gpt4o-deploy/chat/completions?api-version=2024-06-01');
    assert.equal(calls[0].opts.headers['api-key'], 'az-key');
    assert.equal(calls[0].body.tool_choice, 'none');
});

test('anthropic: system, tool_use / tool_result conversion and parsing', async (t) => {
    const calls = captureAxios(t, {
        model: 'claude-x',
        content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tu_9', name: 'find_host', input: { query: 'web-03' } }],
    });
    const chat = createChat(baseConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey_enc: encryptText('ak'), model: 'claude-x' }));
    const res = await chat({ system: 'SYS', messages: [...HISTORY, { role: 'user', content: 'follow-up' }], tools: TOOLS, toolChoice: 'auto' });

    const { url, body, opts } = calls[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(opts.headers['x-api-key'], 'ak');
    assert.equal(body.system, 'SYS');
    assert.equal(body.tools[0].input_schema.properties.query.type, 'string');
    assert.deepEqual(body.tool_choice, { type: 'auto' });
    assert.deepEqual(body.messages[1].content, [{ type: 'tool_use', id: 'call_1', name: 'find_host', input: { query: 'web-03' } }]);
    // tool_result and the following user text are merged into one user turn
    assert.equal(body.messages.length, 3);
    assert.deepEqual(body.messages[2].content, [
        { type: 'tool_result', tool_use_id: 'call_1', content: HISTORY[2].content },
        { type: 'text', text: 'follow-up' },
    ]);
    assert.equal(res.text, 'Checking.');
    assert.deepEqual(res.toolCalls, [{ id: 'tu_9', name: 'find_host', args: { query: 'web-03' } }]);
});

test('gemini: key in header, schema sanitized, functionCall parsing', async (t) => {
    const calls = captureAxios(t, {
        candidates: [{ content: { parts: [{ text: 'Looking up.' }, { functionCall: { name: 'find_host', args: { query: 'web-03' } } }] } }],
    });
    const chat = createChat(baseConfig({ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey_enc: encryptText('gk'), model: 'models/gemini-x' }));
    const res = await chat({ system: 'SYS', messages: HISTORY, tools: TOOLS, toolChoice: 'auto' });

    const { url, body, opts } = calls[0];
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
    assert.ok(!url.includes('gk'), 'API key must not be in the URL');
    assert.equal(opts.headers['x-goog-api-key'], 'gk');
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'SYS' }] });
    const params = body.tools[0].functionDeclarations[0].parameters;
    assert.equal(params.properties.query.maxLength, undefined, 'unsupported keywords are stripped');
    assert.equal(params.properties.limit.minimum, undefined);
    assert.deepEqual(body.contents[1], { role: 'model', parts: [{ functionCall: { name: 'find_host', args: { query: 'web-03' } } }] });
    assert.equal(body.contents[2].parts[0].functionResponse.name, 'find_host');
    assert.equal(res.text, 'Looking up.');
    assert.equal(res.toolCalls[0].name, 'find_host');
    assert.ok(res.toolCalls[0].id);
});

test('HTTP errors become readable PROVIDER_ERROR / TOOLS_UNSUPPORTED errors', async (t) => {
    t.mock.method(axios, 'post', async () => {
        const e = new Error('Request failed with status code 400');
        e.response = { status: 400, data: { error: { message: 'model llama3 does not support tools' } } };
        throw e;
    });
    const chat = createChat(baseConfig({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3' }));
    await assert.rejects(chat({ system: 'S', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, toolChoice: 'auto' }),
        (err) => err.code === 'TOOLS_UNSUPPORTED' && /^目前選擇的模型不支援工具呼叫，請至 AI Service 設定改用支援的模型。/.test(err.message));
});

test('schema errors mentioning tools stay PROVIDER_ERROR', async (t) => {
    t.mock.method(axios, 'post', async () => {
        const e = new Error('Request failed with status code 400');
        e.response = { status: 400, data: { error: { message: "Invalid 'tools[0].function.name': string does not match pattern" } } };
        throw e;
    });
    const chat = createChat(baseConfig({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3' }));
    await assert.rejects(chat({ system: 'S', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, toolChoice: 'auto' }),
        (err) => err.code === 'PROVIDER_ERROR' && /Invalid 'tools\[0\]/.test(err.message));
});

test('gemini omits parameters for tools without properties', async (t) => {
    const calls = captureAxios(t, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    const chat = createChat(baseConfig({ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey_enc: encryptText('gk'), model: 'gemini-x' }));
    await chat({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'get_server_time', description: 'time', parameters: { type: 'object', properties: {} } }], toolChoice: 'auto' });
    assert.equal(calls[0].body.tools[0].functionDeclarations[0].parameters, undefined);
    assert.equal(calls[0].body.tools[0].functionDeclarations[0].name, 'get_server_time');
});

test('gemini: thoughtSignature is parsed and replayed on the functionCall part', async (t) => {
    const calls = captureAxios(t, {
        candidates: [{ content: { parts: [{ functionCall: { name: 'find_host', args: { query: 'x' } }, thoughtSignature: 'sig-123' }] } }],
    });
    const chat = createChat(baseConfig({ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey_enc: encryptText('gk'), model: 'gemini-3-x' }));
    const res = await chat({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, toolChoice: 'auto' });
    assert.equal(res.toolCalls[0].thoughtSignature, 'sig-123');

    const history = [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'find_host', args: { query: 'x' }, thoughtSignature: 'sig-123' }] },
        { role: 'tool', toolCallId: 'c1', name: 'find_host', content: 'r' },
    ];
    await chat({ system: 'S', messages: history, tools: TOOLS, toolChoice: 'auto' });
    const modelPart = calls[1].body.contents[1].parts[0];
    assert.equal(modelPart.thoughtSignature, 'sig-123');
    assert.deepEqual(modelPart.functionCall, { name: 'find_host', args: { query: 'x' } });
});
