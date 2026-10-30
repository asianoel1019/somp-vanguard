/** OpenAI-compatible chat completions with tools (OpenCode, OpenAI, DeepSeek, Azure, custom, Ollama /v1). */
const { postWithRetry } = require('./connection');

function buildUrl(conn) {
    const url = conn.baseUrl;
    if (conn.provider === 'azure') {
        return url.includes('/chat/completions')
            ? url
            : `${url}/openai/deployments/${conn.model}/chat/completions?api-version=2024-06-01`;
    }
    if (url.endsWith('/chat/completions')) return url;
    return url.endsWith('/v1') ? `${url}/chat/completions` : `${url}/v1/chat/completions`;
}

function buildHeaders(conn) {
    const headers = { 'Content-Type': 'application/json' };
    if (conn.provider === 'azure') headers['api-key'] = conn.apiKey;
    else if (conn.apiKey) headers.Authorization = `Bearer ${conn.apiKey}`;
    return headers;
}

function toOpenAiMessages(system, messages) {
    const out = [{ role: 'system', content: system }];
    for (const m of messages) {
        if (m.role === 'user') {
            out.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant') {
            const msg = { role: 'assistant', content: m.content || null };
            if (m.toolCalls && m.toolCalls.length) {
                msg.tool_calls = m.toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
                }));
            }
            out.push(msg);
        } else if (m.role === 'tool') {
            out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
        }
    }
    return out;
}

function parseArgs(raw) {
    if (raw && typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(raw || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return { __invalidJson: String(raw).slice(0, 500) };
    }
}

async function chat(conn, { system, messages, tools = [], toolChoice = 'auto', signal, deadline, onRetry }) {
    if (conn.provider === 'azure' && !conn.apiKey) throw new Error('API Key is required for Azure OpenAI.');

    const payload = { model: conn.model, messages: toOpenAiMessages(system, messages) };
    if (tools.length) {
        payload.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
        payload.tool_choice = toolChoice;
    }
    if (/(^|\/)(o1|o3|o4)/i.test(conn.model)) {
        payload.max_completion_tokens = conn.maxTokens;
    } else {
        payload.max_tokens = conn.maxTokens;
        payload.temperature = conn.temperature;
    }

    const res = await postWithRetry(conn, buildUrl(conn), payload, { headers: buildHeaders(conn), ...conn.axiosOptions },
        conn.provider.toUpperCase(), { signal, deadline, onRetry });

    const msg = res.data?.choices?.[0]?.message || {};
    return {
        text: msg.content || '',
        toolCalls: (msg.tool_calls || []).map((tc, i) => ({
            id: tc.id || `call_${i}`,
            name: tc.function?.name,
            args: parseArgs(tc.function?.arguments),
        })),
        model: res.data?.model || conn.model,
    };
}

module.exports = { chat, buildUrl, toOpenAiMessages };
