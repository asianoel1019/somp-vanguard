/** Anthropic Messages API with tool_use / tool_result. */
const { postWithRetry } = require('./connection');

function pushUserBlock(out, block) {
    const last = out[out.length - 1];
    if (last && last.role === 'user') {
        if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
        last.content.push(block);
    } else {
        out.push({ role: 'user', content: [block] });
    }
}

function toAnthropicMessages(messages) {
    const out = [];
    for (const m of messages) {
        if (m.role === 'user') {
            const last = out[out.length - 1];
            if (last && last.role === 'user') pushUserBlock(out, { type: 'text', text: m.content });
            else out.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant') {
            const blocks = [];
            if (m.content) blocks.push({ type: 'text', text: m.content });
            for (const tc of m.toolCalls || []) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
            out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '(empty)' }] });
        } else if (m.role === 'tool') {
            pushUserBlock(out, { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
        }
    }
    return out;
}

async function chat(conn, { system, messages, tools = [], toolChoice = 'auto', signal, deadline, onRetry }) {
    if (!conn.apiKey) throw new Error('API Key is required for Anthropic Claude.');

    const payload = {
        model: conn.model,
        max_tokens: conn.maxTokens,
        system,
        messages: toAnthropicMessages(messages),
        temperature: conn.temperature,
    };
    if (tools.length) {
        payload.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
        payload.tool_choice = { type: toolChoice === 'none' ? 'none' : 'auto' };
    }

    const res = await postWithRetry(conn, `${conn.baseUrl}/v1/messages`, payload, {
        headers: { 'Content-Type': 'application/json', 'x-api-key': conn.apiKey, 'anthropic-version': '2023-06-01' },
        ...conn.axiosOptions,
    }, 'ANTHROPIC', { signal, deadline, onRetry });

    const blocks = res.data?.content || [];
    return {
        text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
        toolCalls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} })),
        model: res.data?.model || conn.model,
    };
}

module.exports = { chat, toAnthropicMessages };
