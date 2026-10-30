/**
 * AI Ops Agent API (read-only investigation assistant).
 * POST /chat streams Server-Sent Events: conversation, step_start, step_end, answer, error, done.
 */
const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const logger = require('../lib/logger');
const { hasFeature } = require('../lib/permissions');
const scoutDb = require('../services/scoutDb');
const { getAiConfig, validateAiConfig } = require('./ai');
const { createChat } = require('../lib/agent/providers');
const { createRegistry } = require('../lib/agent/toolRegistry');
const tools = require('../lib/agent/tools');
const { runAgent } = require('../lib/agent/agentLoop');
const { createRedactor, redactString, collectSecretValues } =require('../lib/agent/redact');
const store = require('../lib/agent/conversationStore');
const { createRateLimiter } = require('../lib/agent/rateLimiter');

const MAX_MESSAGE_CHARS = 4000;
const registry = createRegistry(tools);
const limiter = createRateLimiter();

let chatFactory = createChat;
// Test seam: replace the provider with a fake (pass null to restore)
router.__setChatFactory = (fn) => { chatFactory = fn || createChat; };

const TEST_TOOL = {
    name: 'get_server_time',
    description: 'Returns the current server time.',
    parameters: { type: 'object', properties: {} },
};

const clean = (v, n = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/</g, '＜').replace(/>/g, '＞').slice(0, n);
const wrapAlert = (text) => `<alert_data>\n${text}\n</alert_data>`;

async function describeAlert(alertId, user) {
    if (!hasFeature(user, 'monitorScout')) return '';
    const alert = await scoutDb.get('SELECT * FROM alerts WHERE id = ?', [alertId]);
    if (!alert) return wrapAlert(`[告警資料] 找不到告警 ${clean(alertId, 100)}`);
    const monitor = await scoutDb.get('SELECT name, ip FROM monitors WHERE id = ?', [alert.monitorId]);
    return wrapAlert(`[告警資料] id=${clean(alert.id)} 主機=${clean(monitor?.name || 'unknown')} (${clean(monitor?.ip || '')}) 類型=${clean(alert.type)} 規則=${clean(alert.ruleName || '')} `
        + `目標=${clean(alert.target || '')} 觸發值=${clean(alert.value)} 門檻=${clean(alert.threshold)} 觸發時間=${clean(alert.triggeredAt)} 狀態=${alert.resolved ? '已解除' : '作用中'}`);
}

router.use(requireAuth);

// Model capability check; available before the agent is enabled so SuperAdmin can validate the model first
router.post('/test', checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const chat = chatFactory(getAiConfig());
        const startedAt = Date.now();
        const result = await chat({
            system: 'You are a connectivity test for tool calling. Always answer by calling the provided tool.',
            messages: [{ role: 'user', content: 'What time is it on the server? Call get_server_time.' }],
            tools: [TEST_TOOL],
            toolChoice: 'auto',
        });
        const toolCalled = (result.toolCalls || []).some(tc => tc.name === TEST_TOOL.name);
        res.json({
            ok: toolCalled,
            toolCalled,
            model: result.model,
            latencyMs: Date.now() - startedAt,
            message: toolCalled ? '模型支援工具呼叫，可以使用 AI Agent。' : '模型有回應但沒有呼叫工具，可能不適合 AI Agent，建議更換模型。',
        });
    } catch (e) {
        res.status(e.code === 'AI_CONFIG_INVALID' ? 400 : 502).json({ ok: false, error: e.message });
    }
});

router.use(checkFeature('aiAgent'));
router.use((req, res, next) => {
    const config = getAiConfig();
    if (!config.enabled || !config.agentEnabled) {
        return res.status(403).json({ error: 'AI Agent 尚未啟用。請由 SuperAdmin 至「System Settings > AI Service」開啟。' });
    }
    const check = validateAiConfig(config);
    if (!check.valid) return res.status(400).json({ error: check.message });
    req.aiConfig = config;
    next();
});

router.get('/conversations', (req, res) => {
    res.json(store.listConversations(req.user));
});

router.get('/conversations/:id', (req, res) => {
    const conv = store.getConversation(req.user, req.params.id);
    if (!conv) return res.status(404).json({ error: '找不到這個對話' });
    res.json(conv);
});

router.delete('/conversations/:id', (req, res) => {
    if (!store.deleteConversation(req.user, req.params.id)) return res.status(404).json({ error: '找不到這個對話' });
    res.json({ success: true });
});

router.post('/chat', async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > MAX_MESSAGE_CHARS) {
        return res.status(400).json({ error: `問題內容必須是 1–${MAX_MESSAGE_CHARS} 字的文字` });
    }
    const conversationId = req.body.conversationId ? String(req.body.conversationId) : null;
    const existing = conversationId ? store.getConversation(req.user, conversationId) : null;
    if (conversationId && !existing) return res.status(404).json({ error: '找不到這個對話' });

    const key = store.userKey(req.user);
    const slot = limiter.tryStart(key, req.aiConfig.agentRateLimitPerHour || 30);
    if (!slot.ok) {
        if (slot.reason === 'busy') return res.status(409).json({ error: '你已有一個 AI Agent 查詢正在進行中，請稍候或先按停止。' });
        return res.status(429).json({ error: `已達每小時提問上限，請 ${Math.ceil(slot.retryAfterSec / 60)} 分鐘後再試。` });
    }

    let heartbeat = null;
    try {
        let alertContext = '';
        if (req.body.alertId) {
            const alertId = String(req.body.alertId);
            try {
                alertContext = await describeAlert(alertId, req.user);
            } catch (e) {
                console.error('[AI Agent] describeAlert failed:', e.message);
                alertContext = wrapAlert(`[告警資料] 無法讀取告警 ${clean(alertId, 100)}`);
            }
        }
        const question = alertContext ? `${alertContext}\n\n${message}` : message;

        res.status(200).set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
        heartbeat.unref();
        const send = (event, data) => {
            if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abort.abort(); });

        const convId = existing ? existing.id : store.newConversationId();
        send('conversation', { conversationId: convId });
        logger.auditLog(req.user.username, 'AI Agent', `Asked: ${redactString(message.slice(0, 100).replace(/[\r\n]+/g, ' '), collectSecretValues())}`);

        let result = null;
        let error = null;
        try {
            result = await runAgent({
                chat: chatFactory(req.aiConfig),
                registry,
                user: req.user,
                history: store.historyForModel(existing),
                question,
                onEvent: send,
                signal: abort.signal,
                redactor: createRedactor(),
            });
            send('answer', { text: result.answer, suggestions: result.suggestions });
        } catch (e) {
            error = e;
            if (e.code !== 'ABORTED') send('error', { message: e.message });
        }

        try {
            store.appendTurn(req.user, {
                conversationId: convId,
                question,
                title: message,
                answer: result ? result.answer : '',
                steps: result ? result.steps : (error && error.steps) || [],
                suggestions: result ? result.suggestions : [],
                error: error ? (error.code === 'ABORTED' ? '使用者已停止' : error.message) : undefined,
            });
        } catch (e) {
            console.error('[AI Agent] appendTurn failed:', e.message);
            send('error', { message: '對話紀錄儲存失敗，本次結果未保存。' });
        }
        clearInterval(heartbeat);
        send('done', {});
        res.end();
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        limiter.finish(key);
    }
});

module.exports = router;
