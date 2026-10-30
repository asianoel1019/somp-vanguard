/**
 * Tool registry for the AI Agent: argument validation, permission checks,
 * secret redaction, output truncation and tagging of results as untrusted data.
 */
const { hasFeature } = require('../permissions');
const { createRedactor } = require('./redact');
const { ToolInputError } = require('./errors');

const MAX_OUTPUT_CHARS = 8000;
const SUMMARY_CHARS = 300;

function coerce(key, def, value) {
    switch (def.type) {
        case 'string': {
            const s = typeof value === 'string' ? value.trim() : String(value);
            if (def.maxLength && s.length > def.maxLength) throw new ToolInputError(`"${key}" must be at most ${def.maxLength} characters`);
            if (def.enum && !def.enum.includes(s)) throw new ToolInputError(`"${key}" must be one of: ${def.enum.join(', ')}`);
            return s;
        }
        case 'integer':
        case 'number': {
            const n = typeof value === 'number' ? value : Number(String(value).trim());
            if (!Number.isFinite(n)) throw new ToolInputError(`"${key}" must be a number`);
            if (def.type === 'integer' && !Number.isInteger(n)) throw new ToolInputError(`"${key}" must be an integer`);
            if (def.minimum !== undefined && n < def.minimum) throw new ToolInputError(`"${key}" must be >= ${def.minimum}`);
            if (def.maximum !== undefined && n > def.maximum) throw new ToolInputError(`"${key}" must be <= ${def.maximum}`);
            return n;
        }
        case 'boolean':
            if (typeof value === 'boolean') return value;
            if (value === 'true' || value === 'false') return value === 'true';
            throw new ToolInputError(`"${key}" must be true or false`);
        case 'array': {
            if (!Array.isArray(value)) throw new ToolInputError(`"${key}" must be an array`);
            if (def.maxItems !== undefined && value.length > def.maxItems) throw new ToolInputError(`"${key}" must have at most ${def.maxItems} items`);
            return value.map((item, i) => coerce(`${key}[${i}]`, def.items || { type: 'string' }, item));
        }
        default:
            throw new ToolInputError(`Unsupported argument type for "${key}"`);
    }
}

function validateArgs(schema, raw) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    if (input.__invalidJson !== undefined) throw new ToolInputError('Arguments were not valid JSON');
    const isEmpty = (v) => v === undefined || v === null || v === '';
    for (const key of schema.required || []) {
        if (isEmpty(input[key])) throw new ToolInputError(`Missing required argument "${key}"`);
    }
    const out = {};
    for (const [key, def] of Object.entries(schema.properties || {})) {
        if (isEmpty(input[key])) continue;
        out[key] = coerce(key, def, input[key]);
    }
    return out;
}

// JSON.stringify leaves <, > and & as-is; escaping them keeps data from closing the wrapper tag.
// The result is still valid JSON because these characters only occur inside string literals.
const escapeForTag = (json) => json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
// Tool name comes from the model, so restrict it to a safe charset before putting it in an attribute.
const safeName = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
const wrap = (name, json) => `<tool_result name="${safeName(name)}">\n${escapeForTag(json)}\n</tool_result>`;

function failure(name, message) {
    return { ok: false, content: wrap(name, JSON.stringify({ error: message })), summary: message.slice(0, SUMMARY_CHARS), error: message };
}

function sanitizeSuggestions(list, redactor) {
    if (!Array.isArray(list)) return undefined;
    return list
        .filter(s => s && (s.type === 'runbook' || s.type === 'workflow') && typeof s.id === 'string' && s.id.length <= 100 && typeof s.title === 'string')
        .slice(0, 10)
        .map(s => ({ type: s.type, id: s.id, title: String(redactor.redact(s.title)).slice(0, 200) }));
}

function createRegistry(tools) {
    const byName = new Map(tools.map(t => [t.name, t]));

    return {
        definitions() {
            return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
        },

        async execute(name, rawArgs, { user, now = new Date(), redactor } = {}) {
            const tool = byName.get(name);
            if (!tool) return failure(name, `Unknown tool "${name}". Available: ${[...byName.keys()].join(', ')}`);
            // feature: a key, or an array of keys of which any one is enough
            const features = Array.isArray(tool.feature) ? tool.feature : (tool.feature ? [tool.feature] : []);
            if (features.length && !features.some(f => hasFeature(user, f))) {
                return failure(name, `你沒有權限查詢此資料（需要功能權限：${features.join(' / ')}）`);
            }

            let args;
            try {
                args = validateArgs(tool.parameters, rawArgs);
            } catch (e) {
                return failure(name, `Invalid arguments: ${e.message}`);
            }

            let result;
            try {
                result = await tool.run(args, { user, now });
            } catch (e) {
                if (e instanceof ToolInputError) return failure(name, e.message);
                console.error(`[AI Agent Tool Error] ${name}:`, e);
                return failure(name, 'Tool execution failed (internal error).');
            }

            try {
                const { suggestions, ...visible } = result && typeof result === 'object' ? result : { value: result };
                const red = redactor || createRedactor();
                const fullJson = JSON.stringify(red.redact(visible));
                let json = fullJson;
                if (escapeForTag(json).length > MAX_OUTPUT_CHARS) {
                    let cut = MAX_OUTPUT_CHARS - 400;
                    do {
                        json = JSON.stringify({
                            truncated: true,
                            note: 'Output exceeded 8 KB and was cut. Narrow the query (shorter time range, specific host, keyword or lower limit).',
                            partial: fullJson.slice(0, cut),
                        });
                        cut = Math.floor(cut * 0.8);
                    } while (escapeForTag(json).length > MAX_OUTPUT_CHARS && cut > 0);
                }
                const sanitized = sanitizeSuggestions(suggestions, red);
                return {
                    ok: true,
                    content: wrap(name, json),
                    summary: fullJson.slice(0, SUMMARY_CHARS),
                    ...(sanitized ? { suggestions: sanitized } : {}),
                };
            } catch (e) {
                console.error(`[AI Agent Tool Error] ${name}:`, e);
                return failure(name, 'Tool returned output that could not be serialized.');
            }
        },
    };
}

module.exports = { createRegistry, validateArgs, MAX_OUTPUT_CHARS };
