/** Google Gemini generateContent with functionDeclarations. The API key is sent as a header, never in the URL. */
const { postWithRetry } = require('./connection');

const ALLOWED_SCHEMA_KEYS = new Set(['type', 'description', 'properties', 'required', 'enum', 'items', 'format', 'nullable']);

function toGeminiSchema(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (!ALLOWED_SCHEMA_KEYS.has(k)) continue;
        if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
        else if (k === 'items') out.items = toGeminiSchema(v);
        else out[k] = v;
    }
    return out;
}

function toGeminiContents(messages) {
    const contents = [];
    for (const m of messages) {
        if (m.role === 'user') {
            contents.push({ role: 'user', parts: [{ text: m.content }] });
        } else if (m.role === 'assistant') {
            const parts = [];
            if (m.content) parts.push({ text: m.content });
            for (const tc of m.toolCalls || []) parts.push({ functionCall: { name: tc.name, args: tc.args || {} }, ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}) });
            contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '(empty)' }] });
        } else if (m.role === 'tool') {
            const part = { functionResponse: { name: m.name, response: { result: m.content } } };
            const last = contents[contents.length - 1];
            if (last && last.role === 'user' && last.parts.every(p => p.functionResponse)) last.parts.push(part);
            else contents.push({ role: 'user', parts: [part] });
        }
    }
    return contents;
}

async function chat(conn, { system, messages, tools = [], toolChoice = 'auto', signal, deadline, onRetry }) {
    if (!conn.apiKey) throw new Error('API Key is required for Google Gemini.');
    const model = conn.model.replace(/^models\//, '');

    const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: toGeminiContents(messages),
        generationConfig: { temperature: conn.temperature, maxOutputTokens: conn.maxTokens },
    };
    if (tools.length) {
        body.tools = [{
            functionDeclarations: tools.map((t) => {
                const decl = { name: t.name, description: t.description };
                // Gemini rejects an object schema with empty properties, so omit parameters in that case.
                if (t.parameters && t.parameters.properties && Object.keys(t.parameters.properties).length > 0) {
                    decl.parameters = toGeminiSchema(t.parameters);
                }
                return decl;
            }),
        }];
        body.toolConfig = { functionCallingConfig: { mode: toolChoice === 'none' ? 'NONE' : 'AUTO' } };
    }

    const res = await postWithRetry(conn, `${conn.baseUrl}/v1beta/models/${model}:generateContent`, body, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': conn.apiKey },
        ...conn.axiosOptions,
    }, 'GEMINI', { signal, deadline, onRetry });

    const parts = res.data?.candidates?.[0]?.content?.parts || [];
    const stamp = Date.now().toString(36);
    return {
        text: parts.filter(p => typeof p.text === 'string').map(p => p.text).join(''),
        toolCalls: parts.filter(p => p.functionCall).map((p, i) => ({ id: `gemini_${stamp}_${i}`, name: p.functionCall.name, args: p.functionCall.args || {}, ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}) })),
        model,
    };
}

module.exports = { chat, toGeminiContents, toGeminiSchema };
