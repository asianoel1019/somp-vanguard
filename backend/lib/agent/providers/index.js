const { resolveConnection } = require('./connection');
const { AgentError } = require('../errors');
const openaiCompat = require('./openaiCompat');
const anthropic = require('./anthropic');
const gemini = require('./gemini');

const ADAPTERS = { anthropic, gemini };

/**
 * Returns chat(req) bound to the current (or given) AI configuration.
 * @param {object} [config] AI config as returned by routes/ai.js getAiConfig()
 */
function createChat(config) {
    const { getAiConfig, validateAiConfig } = require('../../../routes/ai');
    const cfg = config || getAiConfig();
    const check = validateAiConfig(cfg);
    if (!check.valid) throw new AgentError(check.message, 'AI_CONFIG_INVALID');

    const conn = resolveConnection(cfg);
    const adapter = ADAPTERS[conn.provider] || openaiCompat;
    return (req) => adapter.chat(conn, req);
}

module.exports = { createChat };
