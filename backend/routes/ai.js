const express = require('express');
const router = express.Router();
const axios = require('axios');
const { requireAuth, checkRole, checkFeature, checkAnyFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { readDataSync, writeDataSync } = require('../lib/db');
const { encryptText, decryptText } = require('../lib/crypto');
const { getAxiosProxyConfig } = require('../lib/proxyHelper');

const AI_CONFIG_PATH = 'system/ai_config.json';

// Default AI Configuration
function getAiConfig() {
    const raw = readDataSync(AI_CONFIG_PATH, {
        enabled: false,
        provider: 'opencode', // 'opencode' | 'openai' | 'anthropic' | 'deepseek' | 'gemini' | 'ollama' | 'azure' | 'custom'
        baseUrl: 'https://opencode.ai/zen/v1',
        apiKey_enc: '',
        model: 'claude-3-7-sonnet',
        temperature: 0.3,
        timeout: 120000,
        maxTokens: 2048,
        enableThinking: false,
        reasoningEffort: 'medium', // 'low' | 'medium' | 'high' for o1/o3/thinking models
        agentEnabled: false,
        agentModel: '',
        agentRateLimitPerHour: 30,
        systemPrompt: 'You are an elite Incident Response and Enterprise IT Operations assistant for SOMP Vanguard. Provide actionable, accurate, and security-hardened advice with copyable scripts.'
    });
    return raw;
}

// Intranet DNS suffixes: built-in generic ones + INTERNAL_DOMAINS (.env, comma separated) + the AD domain
function internalDomainSuffixes() {
    const extra = String(process.env.INTERNAL_DOMAINS || '').split(',');
    const ad = String(process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '');
    return ['local', 'lan', 'internal', ...extra, ad]
        .map(d => d.trim().toLowerCase().replace(/^\.+/, ''))
        .filter(Boolean);
}

// Check if a URL / Hostname is an internal intranet target (which must bypass external proxy)
function isInternalHost(urlStr) {
    if (!urlStr) return false;
    try {
        const parsed = new URL(urlStr);
        const host = parsed.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || internalDomainSuffixes().some(d => host === d || host.endsWith(`.${d}`))) {
            return true;
        }
        // Private IP Ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
        if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)) {
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

// Friendly AI Error Formatter
function formatAiError(e, timeoutMs) {
    const isTimeout = e.code === 'ECONNABORTED' || (e.message && e.message.includes('timeout')) || (e.message && e.message.includes('ETIMEDOUT'));
    if (isTimeout) {
        const sec = Math.round((timeoutMs || 120000) / 1000);
        return `AI 引擎請求逾時（超過 ${sec} 秒）。若正在處理複雜運算或開啟了 Thinking 模式可能耗時較長，建議至「System Settings > AI Service」確認 Thinking Mode 已關閉、或調大 Timeout 時間。`;
    }
    const errData = e.response?.data;
    if (errData) {
        if (typeof errData === 'string') return errData;
        if (errData.error) {
            if (typeof errData.error === 'string') {
                if (errData.error.toLowerCase().includes('internal server error') || e.response?.status === 500) {
                    return `AI 遠端服務端回傳 500 Internal server error。目前選用的模型節點可能運算超載、暫時離線或不支援此上下文長度，建議至「System Settings > AI Service」切換為主流穩定模型（例如 deepseek-chat, claude-3-7-sonnet, gpt-4o 等）。`;
                }
                return errData.error;
            }
            if (errData.error.message) {
                if (errData.error.message.toLowerCase().includes('internal server error') || e.response?.status === 500) {
                    return `AI 遠端服務端回傳 500 Internal server error。目前選用的模型節點可能運算超載、暫時離線或不支援此上下文長度，建議至「System Settings > AI Service」切換為主流穩定模型（例如 deepseek-chat, claude-3-7-sonnet, gpt-4o 等）。`;
                }
                return errData.error.message;
            }
            return JSON.stringify(errData.error);
        }
        if (errData.message) {
            if (errData.message.toLowerCase().includes('internal server error') || e.response?.status === 500) {
                return `AI 遠端服務端回傳 500 Internal server error。目前選用的模型節點可能運算超載或維護中，建議至「System Settings > AI Service」切換為其他穩定模型後重試。`;
            }
            return errData.message;
        }
        if (errData.detail) {
            if (typeof errData.detail === 'string') return errData.detail;
            return JSON.stringify(errData.detail);
        }
        return JSON.stringify(errData);
    }
    if (e.response?.status === 500) {
        return `AI 遠端服務端回傳 500 Internal server error。目前選用的模型節點可能運算超載或維護中，建議至「System Settings > AI Service」切換為其他穩定模型後重試。`;
    }
    return e.message || String(e);
}

// Validation helper for AI configuration
function validateAiConfig(config) {
    if (!config || !config.enabled) {
        return {
            valid: false,
            reason: 'disabled',
            message: 'AI 整合服務目前未啟用。請至「System Settings > AI Service」開啟啟用開關。'
        };
    }
    const provider = (config.provider || 'opencode').toLowerCase();
    const keyRequiredProviders = ['gemini', 'openai', 'anthropic', 'deepseek', 'opencode', 'azure'];
    if (keyRequiredProviders.includes(provider) && !config.apiKey_enc) {
        const providerName = provider === 'opencode' ? 'OpenCode' : provider === 'anthropic' ? 'Anthropic Claude' : provider === 'deepseek' ? 'DeepSeek' : provider === 'azure' ? 'Azure OpenAI' : provider === 'gemini' ? 'Google Gemini' : 'OpenAI';
        return {
            valid: false,
            reason: 'missing_key',
            message: `${providerName} 尚未設定 API Key。請至「System Settings > AI Service」填寫金鑰並儲存。`
        };
    }
    if ((provider === 'custom' || provider === 'ollama' || provider === 'azure') && !config.baseUrl) {
        return {
            valid: false,
            reason: 'missing_url',
            message: 'AI 服務 Base URL 尚未設定。請至「System Settings > AI Service」填寫連線網址並儲存。'
        };
    }
    return { valid: true };
}

// Universal AI Caller
async function callAiEngine(config, messages, promptOptions = {}) {
    if (!config.enabled && !promptOptions.isTest) {
        throw new Error('AI Service integration is disabled in System Settings.');
    }

    const provider = (config.provider || 'opencode').toLowerCase();
    let rawTimeout = Number(config.timeout ?? 120000);
    if (rawTimeout === 45000) rawTimeout = 120000;
    const timeout = rawTimeout < 1000 ? rawTimeout * 1000 : rawTimeout;
    const temperature = Number(config.temperature ?? 0.3);
    const maxTokens = Number(promptOptions.maxTokens || (config.maxTokens ?? 2048));

    // Default models per provider
    const defaultModels = {
        opencode: 'claude-3-7-sonnet',
        openai: 'gpt-4o-mini',
        anthropic: 'claude-3-7-sonnet-latest',
        deepseek: 'deepseek-chat',
        gemini: 'gemini-2.0-flash',
        azure: 'gpt-4o',
        ollama: 'llama3:8b',
        custom: 'default'
    };
    const model = config.model || defaultModels[provider] || 'default';

    let apiKey = '';
    if (config.apiKey_enc) {
        try {
            apiKey = decryptText(config.apiKey_enc);
        } catch (e) {
            console.error('[AI Service] Failed to decrypt API key:', e.message);
        }
    }

    // Default base URLs per provider
    const defaultUrls = {
        opencode: 'https://opencode.ai/zen/v1',
        openai: 'https://api.openai.com/v1',
        anthropic: 'https://api.anthropic.com',
        deepseek: 'https://api.deepseek.com',
        gemini: 'https://generativelanguage.googleapis.com',
        ollama: 'http://localhost:11434'
    };
    let baseUrl = (config.baseUrl || defaultUrls[provider] || '').trim().replace(/\/+$/, '');

    // Get Proxy Configuration for AI module if enabled in Network Settings
    // CRITICAL: Intranet internal hosts (INTERNAL_DOMAINS / AD domain, *.local, 10.x.x.x) MUST bypass external proxy to prevent timeout
    let proxyConfig = null;
    if (!isInternalHost(baseUrl)) {
        proxyConfig = getAxiosProxyConfig('AI');
    }
    const axiosBaseOptions = {
        timeout,
        ...(proxyConfig ? { proxy: proxyConfig } : { proxy: false })
    };

    // ─────────────────────────────────────────────────────────────
    // Provider Dispatcher
    // ─────────────────────────────────────────────────────────────

    // 1. Ollama Native Endpoint
    if (provider === 'ollama') {
        if (!baseUrl) baseUrl = 'http://localhost:11434';
        const url = `${baseUrl}/api/chat`;
        try {
            const res = await axios.post(url, {
                model,
                messages,
                stream: false,
                options: {
                    temperature,
                    num_predict: maxTokens
                }
            }, axiosBaseOptions);
            return {
                content: res.data?.message?.content || res.data?.response || '',
                model: res.data?.model || model,
                provider: 'ollama'
            };
        } catch (e) {
            console.error('[AI Engine OLLAMA Error]', { model, url, status: e.response?.status, data: e.response?.data, message: e.message });
            const err = new Error(formatAiError(e, timeout));
            err.status = e.response?.status || 500;
            err.response = e.response;
            throw err;
        }
    }

    // 2. Google Gemini Native v1beta Endpoint
    else if (provider === 'gemini') {
        if (!apiKey) throw new Error('API Key is required for Google Gemini.');
        const targetModel = model.replace(/^models\//, '');
        const url = `${baseUrl}/v1beta/models/${targetModel}:generateContent?key=${apiKey}`;
        
        // Format messages for Gemini
        const systemMsg = messages.find(m => m.role === 'system');
        const userAndAssistantMsgs = messages.filter(m => m.role !== 'system');
        
        const contents = userAndAssistantMsgs.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const generationConfig = {
            temperature,
            maxOutputTokens: maxTokens
        };

        if (promptOptions.json === true) {
            generationConfig.responseMimeType = 'application/json';
        }

        // If user explicitly disabled thinking on models that support it:
        if (config.enableThinking === false) {
            generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        const body = {
            contents,
            generationConfig
        };

        if (systemMsg) {
            body.systemInstruction = {
                parts: [{ text: systemMsg.content }]
            };
        }

        try {
            const res = await axios.post(url, body, axiosBaseOptions);
            const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            return {
                content: text,
                model: targetModel,
                provider: 'gemini'
            };
        } catch (e) {
            console.error('[AI Engine GEMINI Error]', { model: targetModel, url, status: e.response?.status, data: e.response?.data, message: e.message });
            const err = new Error(formatAiError(e, timeout));
            err.status = e.response?.status || 500;
            err.response = e.response;
            throw err;
        }
    }

    // 3. Anthropic Claude Native Messages API
    else if (provider === 'anthropic') {
        if (!apiKey) throw new Error('API Key is required for Anthropic Claude.');
        const url = `${baseUrl}/v1/messages`;
        
        const systemMsg = messages.find(m => m.role === 'system');
        const nonSystemMsgs = messages.filter(m => m.role !== 'system').map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content
        }));

        const headers = {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        };

        const payload = {
            model,
            messages: nonSystemMsgs.length > 0 ? nonSystemMsgs : [{ role: 'user', content: 'Hello' }],
            max_tokens: maxTokens
        };

        if (systemMsg) {
            payload.system = systemMsg.content;
        }

        // Claude 3.7 Extended Thinking Support
        if (config.enableThinking === true) {
            const budget = Math.min(2048, Math.max(1024, Math.floor(maxTokens / 2)));
            payload.thinking = { type: 'enabled', budget_tokens: budget };
            // Note: temperature must not be set when thinking is enabled in Claude 3.7
        } else {
            payload.temperature = temperature;
        }

        try {
            const res = await axios.post(url, payload, { headers, ...axiosBaseOptions });
            const textBlocks = (res.data?.content || []).filter(b => b.type === 'text');
            const content = textBlocks.map(b => b.text).join('\n') || '';

            return {
                content,
                model: res.data?.model || model,
                provider: 'anthropic'
            };
        } catch (e) {
            console.error('[AI Engine ANTHROPIC Error]', { model, url, status: e.response?.status, data: e.response?.data, message: e.message });
            const err = new Error(formatAiError(e, timeout));
            err.status = e.response?.status || 500;
            err.response = e.response;
            throw err;
        }
    }

    // 4. OpenAI, OpenCode (Zen/Go), DeepSeek, Azure, and Custom OpenAI-Compatible
    else {
        let url = baseUrl;
        const headers = { 'Content-Type': 'application/json' };

        if (provider === 'azure') {
            if (!apiKey) throw new Error('API Key is required for Azure OpenAI.');
            headers['api-key'] = apiKey;
            if (!url.includes('/chat/completions')) {
                url = `${url}/openai/deployments/${model}/chat/completions?api-version=2024-06-01`;
            }
        } else {
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }
            if (!url.endsWith('/chat/completions')) {
                if (!url.endsWith('/v1')) {
                    url = `${url}/v1/chat/completions`;
                } else {
                    url = `${url}/chat/completions`;
                }
            }
        }

        const isReasoningModel = /(^|\/)(o1|o3|o4)/i.test(model);
        const isDeepSeekReasoner = /(^|\/)(deepseek-reasoner|deepseek-r1|r1)/i.test(model);
        const isThinkingClaude = /(^|\/)claude/i.test(model) && config.enableThinking === true;

        const payload = {
            model,
            messages
        };

        // Adaptive token parameter handling for o1/o3-mini vs traditional models:
        if (isReasoningModel) {
            // OpenAI o1/o3 requires max_completion_tokens, temperature must not be custom
            payload.max_completion_tokens = maxTokens;
            if (config.reasoningEffort) {
                payload.reasoning_effort = config.reasoningEffort;
            }
        } else {
            payload.max_tokens = maxTokens;
            // Omit custom temperature if thinking mode is on for Claude or DeepSeek R1 to prevent 400/500 errors
            if (!isThinkingClaude && !isDeepSeekReasoner) {
                payload.temperature = temperature;
            }

            // Only send chat_template_kwargs for custom/local servers that expect it (not for DeepSeek official cloud or OpenAI)
            if (provider === 'custom' && config.enableThinking === true) {
                payload.chat_template_kwargs = { enable_thinking: true };
            }
        }

        if (promptOptions.json === true && !isReasoningModel) {
            payload.response_format = { type: 'json_object' };
        }

        try {
            let res;
            try {
                res = await axios.post(url, payload, { headers, ...axiosBaseOptions });
            } catch (initialErr) {
                // Check if this model failed due to role: 'system' rejection (common in open-source / contributor models)
                const hasSystemMsg = messages.some(m => m.role === 'system');
                if (hasSystemMsg && (initialErr.response?.status === 400 || initialErr.response?.status === 500)) {
                    console.warn(`[AI Engine ${provider.toUpperCase()}] Model '${model}' failed with ${initialErr.response?.status}. Attempting auto-recovery with merged system prompt...`);
                    const fallbackMessages = [];
                    let mergedSys = '';
                    for (const m of messages) {
                        if (m.role === 'system') {
                            mergedSys += (mergedSys ? '\n\n' : '') + m.content;
                        } else if (m.role === 'user' && mergedSys) {
                            fallbackMessages.push({
                                role: 'user',
                                content: `[System Instructions]\n${mergedSys}\n\n[User Request]\n${m.content}`
                            });
                            mergedSys = '';
                        } else {
                            fallbackMessages.push(m);
                        }
                    }
                    if (mergedSys) fallbackMessages.push({ role: 'user', content: mergedSys });

                    const fallbackPayload = { ...payload, messages: fallbackMessages };
                    res = await axios.post(url, fallbackPayload, { headers, ...axiosBaseOptions });
                    console.log(`[AI Engine ${provider.toUpperCase()}] Auto-recovery succeeded for '${model}'!`);
                } else {
                    throw initialErr;
                }
            }

            const choiceMsg = res.data?.choices?.[0]?.message;
            let content = choiceMsg?.content || '';
            // Capture reasoning_content from DeepSeek-R1, Qwen, or other thinking engines:
            if (!content && choiceMsg?.reasoning_content) {
                content = choiceMsg.reasoning_content;
            }

            return {
                content,
                model: res.data?.model || model,
                provider
            };
        } catch (e) {
            console.error(`[AI Engine ${provider.toUpperCase()} Error]`, {
                url,
                model,
                status: e.response?.status,
                data: e.response?.data,
                message: e.message
            });
            const err = new Error(formatAiError(e, timeout));
            err.status = e.response?.status || 500;
            err.response = e.response;
            throw err;
        }
    }
}

// GET /api/ai/config - Fetch AI settings (masked key)
// Feature checks (callers): GET /config - App shell (AI agent availability, 'aiAgent') and System Settings /
// Dev Tools ('settings'); POST /config, /fetch-models, /test - System Settings -> AI Service only;
// /chat - AI agent family (no screen calls it today); /forensics-remediation - Live Event Viewer ->
// On-Demand Forensics ('monitorWinEvent'). Role checks are unchanged.
const aiConfigReadGate = checkAnyFeature('aiAgent', 'settings');
const aiSettingsGate = checkFeature('settings');

router.get('/config', requireAuth, aiConfigReadGate, checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    try {
        const config = getAiConfig();
        let timeout = config.timeout || 120000;
        if (timeout === 45000) timeout = 120000; // Auto-upgrade legacy default
        res.json({
            enabled: !!config.enabled,
            provider: config.provider || 'opencode',
            baseUrl: config.baseUrl || '',
            model: config.model || '',
            temperature: config.temperature ?? 0.3,
            timeout,
            maxTokens: config.maxTokens || 2048,
            enableThinking: !!config.enableThinking,
            reasoningEffort: config.reasoningEffort || 'medium',
            systemPrompt: config.systemPrompt || '',
            agentEnabled: !!config.agentEnabled,
            agentModel: config.agentModel || '',
            agentRateLimitPerHour: config.agentRateLimitPerHour || 30,
            hasApiKey: !!config.apiKey_enc
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/ai/config - Save AI settings (encrypts key)
router.post('/config', requireAuth, aiSettingsGate, checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    try {
        const { enabled, provider, baseUrl, apiKey, model, temperature, timeout, maxTokens, enableThinking, reasoningEffort, systemPrompt, agentEnabled, agentModel, agentRateLimitPerHour } = req.body;
        const current = getAiConfig();

        const updated = {
            enabled: typeof enabled === 'boolean' ? enabled : current.enabled,
            provider: provider || current.provider || 'opencode',
            baseUrl: baseUrl !== undefined ? baseUrl : current.baseUrl,
            apiKey_enc: apiKey ? encryptText(apiKey) : (apiKey === '' ? '' : current.apiKey_enc),
            model: model || current.model,
            temperature: temperature !== undefined ? Number(temperature) : current.temperature,
            timeout: timeout !== undefined ? Number(timeout) : current.timeout,
            maxTokens: maxTokens !== undefined ? Number(maxTokens) : current.maxTokens,
            enableThinking: typeof enableThinking === 'boolean' ? enableThinking : !!current.enableThinking,
            reasoningEffort: reasoningEffort || current.reasoningEffort || 'medium',
            systemPrompt: systemPrompt !== undefined ? systemPrompt : current.systemPrompt,
            agentEnabled: typeof agentEnabled === 'boolean' ? agentEnabled : !!current.agentEnabled,
            agentModel: agentModel !== undefined ? String(agentModel).trim() : (current.agentModel || ''),
            agentRateLimitPerHour: agentRateLimitPerHour !== undefined
                ? Math.min(500, Math.max(1, parseInt(agentRateLimitPerHour, 10) || 1))
                : (current.agentRateLimitPerHour || 30),
            updatedAt: new Date().toISOString(),
            updatedBy: req.user.username
        };

        writeDataSync(AI_CONFIG_PATH, updated);
        auditLog(req.user.username, 'AI_CONFIG_UPDATE', 'Settings', `Updated AI Engine settings (Provider: ${updated.provider}, Enabled: ${updated.enabled})`);

        res.json({ success: true, message: 'AI configuration saved successfully.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/ai/fetch-models - Dynamically fetch available models from provider
router.post('/fetch-models', requireAuth, aiSettingsGate, checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const { provider, baseUrl, apiKey } = req.body;
        const current = getAiConfig();

        const p = (provider || current.provider || 'opencode').toLowerCase();
        let key = apiKey;
        if (!key && current.apiKey_enc) {
            try { key = decryptText(current.apiKey_enc); } catch {}
        }

        const defaultUrls = {
            opencode: 'https://opencode.ai/zen/v1',
            openai: 'https://api.openai.com/v1',
            anthropic: 'https://api.anthropic.com',
            deepseek: 'https://api.deepseek.com',
            gemini: 'https://generativelanguage.googleapis.com',
            ollama: 'http://localhost:11434'
        };
        let url = (baseUrl || current.baseUrl || defaultUrls[p] || '').trim().replace(/\/+$/, '');

        let proxyConfig = null;
        if (!isInternalHost(url)) {
            proxyConfig = getAxiosProxyConfig('AI');
        }
        const axiosOpts = {
            timeout: 15000,
            ...(proxyConfig ? { proxy: proxyConfig } : { proxy: false })
        };

        let models = [];

        if (p === 'ollama') {
            if (!url) url = 'http://localhost:11434';
            const resp = await axios.get(`${url}/api/tags`, axiosOpts);
            models = (resp.data?.models || []).map(m => m.name || m.model).filter(Boolean);
        } else if (p === 'gemini') {
            if (!key) return res.status(400).json({ error: 'API Key is required to fetch Google Gemini models.' });
            const resp = await axios.get(`${url}/v1beta/models?key=${key}`, axiosOpts);
            models = (resp.data?.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => (m.name || '').replace(/^models\//, ''))
                .filter(Boolean);
        } else if (p === 'anthropic') {
            models = [
                'claude-3-7-sonnet-latest',
                'claude-3-5-sonnet-latest',
                'claude-3-5-haiku-latest',
                'claude-3-opus-latest'
            ];
        } else {
            // OpenAI, OpenCode (Zen/Go), DeepSeek, Custom OpenAI-Compatible
            if (p === 'deepseek' && !url) url = 'https://api.deepseek.com';
            if (p === 'opencode' && !url) url = 'https://opencode.ai/zen/v1';
            if (p === 'openai' && !url) url = 'https://api.openai.com/v1';

            let fetchUrl = url;
            if (!fetchUrl.endsWith('/models')) {
                if (fetchUrl.endsWith('/v1')) {
                    fetchUrl = `${fetchUrl}/models`;
                } else {
                    fetchUrl = `${fetchUrl}/v1/models`;
                }
            }

            const headers = {};
            if (key) headers['Authorization'] = `Bearer ${key}`;
            const resp = await axios.get(fetchUrl, { headers, ...axiosOpts });
            const list = resp.data?.data || resp.data?.models || [];
            models = list.map(m => m.id || m.name).filter(Boolean);
        }

        res.json({ success: true, count: models.length, models });
    } catch (e) {
        console.error('[AI Models Fetch Error]', e.message);
        res.status(500).json({ error: formatAiError(e, 15000) });
    }
});

// POST /api/ai/test - Test connection to AI provider
router.post('/test', requireAuth, aiSettingsGate, checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const startTime = Date.now();
    try {
        const { provider, baseUrl, apiKey, model, enableThinking, reasoningEffort } = req.body;
        const current = getAiConfig();

        const testConfig = {
            enabled: true,
            provider: provider || current.provider,
            baseUrl: baseUrl !== undefined ? baseUrl : current.baseUrl,
            apiKey_enc: apiKey ? encryptText(apiKey) : current.apiKey_enc,
            model: model || current.model,
            temperature: 0.1,
            timeout: 25000,
            maxTokens: 100,
            enableThinking: enableThinking !== undefined ? !!enableThinking : false,
            reasoningEffort: reasoningEffort || current.reasoningEffort || 'medium'
        };

        const testMessages = [
            { role: 'user', content: 'Respond with exactly "AI_ONLINE_OK" and nothing else.' }
        ];

        const response = await callAiEngine(testConfig, testMessages, { isTest: true });
        const latencyMs = Date.now() - startTime;

        res.json({
            success: true,
            latencyMs,
            model: response.model,
            provider: response.provider,
            reply: response.content.slice(0, 100).trim()
        });
    } catch (e) {
        const latencyMs = Date.now() - startTime;
        res.status(500).json({
            success: false,
            latencyMs,
            error: formatAiError(e, 25000)
        });
    }
});

// POST /api/ai/chat - Universal Completion / Chat Endpoint
router.post('/chat', requireAuth, checkFeature('aiAgent'), checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    let config;
    try {
        const { prompt, systemPrompt, context, messages } = req.body;
        config = getAiConfig();

        const check = validateAiConfig(config);
        if (!check.valid) {
            return res.json({
                success: false,
                notConfigured: true,
                reason: check.reason,
                message: check.message
            });
        }

        let formattedMessages = [];
        const baseSystem = systemPrompt || config.systemPrompt || 'You are an operations AI assistant for SOMP Vanguard.';
        formattedMessages.push({ role: 'system', content: baseSystem });

        if (context) {
            formattedMessages.push({ role: 'system', content: `Contextual Environment Information:\n${typeof context === 'object' ? JSON.stringify(context, null, 2) : context}` });
        }

        if (Array.isArray(messages) && messages.length > 0) {
            formattedMessages.push(...messages);
        } else if (prompt) {
            formattedMessages.push({ role: 'user', content: prompt });
        } else {
            return res.status(400).json({ error: 'Either prompt or messages is required.' });
        }

        const response = await callAiEngine(config, formattedMessages);
        res.json({
            success: true,
            answer: response.content,
            provider: response.provider,
            model: response.model
        });
    } catch (e) {
        console.error('[AI Service] Chat failed:', e.message);
        res.status(500).json({ error: formatAiError(e, config?.timeout) });
    }
});

// POST /api/ai/forensics-remediation - Dedicated Endpoint for Forensic Incident Remediation
router.post('/forensics-remediation', requireAuth, checkFeature('monitorWinEvent'), checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    let config;
    try {
        const { report, targetHost, os } = req.body;
        if (!report) return res.status(400).json({ error: 'Forensics report payload is required.' });

        config = getAiConfig();
        const check = validateAiConfig(config);
        if (!check.valid) {
            return res.json({
                success: false,
                notConfigured: true,
                reason: check.reason,
                message: check.message
            });
        }

        // Build compact structured summary for LLM prompt
        const criticalList = (report.suspiciousIndicators || []).slice(0, 8).map(i => `- [${i.severity || 'CRIT'}] ${i.indicator}: ${i.details}`).join('\n');
        const privList = (report.privilegeEvents || []).slice(0, 6).map(p => `- ${p.type}: ${p.details}`).join('\n');
        const timelineSample = (report.timeline || []).slice(0, 10).map(t => `[${t.timestamp}] [${t.stage} / ${t.severity}] ${t.title}: ${t.details}`).join('\n');

        const prompt = `You are a Senior Incident Responder analyzing a forensic sweep report for host "${targetHost || 'Unknown'}" (${os || 'Windows/Linux'}).

--- FORENSIC SWEEP DATA ---
• Risk Level: ${report.riskLevel} (Score: ${report.riskScore}/100)
• Total Logs Analyzed: ${report.totalLogsAnalyzed}
• Threat Counts: Critical=${report.threatCounts?.critical}, FailedLogons=${report.threatCounts?.failedLogons}, SuspiciousCmds=${report.threatCounts?.suspiciousCmds}, PrivilegeModifications=${report.threatCounts?.privilegeChanges}
• Top Targeted Account: ${report.logonSummary?.topBruteTarget || 'None'}
• MITRE Tactics Matched: ${JSON.stringify(report.mitreDomains || {})}

--- CRITICAL SUSPICIOUS INDICATORS ---
${criticalList || 'None detected'}

--- PRIVILEGE & ACCOUNT CHANGES ---
${privList || 'None detected'}

--- ATTACK CHAIN TIMELINE ---
${timelineSample || 'None'}

--- INSTRUCTIONS ---
Provide a concise, professional Incident Response & Remediation Plan formatted in Markdown:
1. **🚨 Incident Diagnostic & Attack Vector Summary**: Summarize what happened, how the attacker gained access or escalated, and current severity in 2-3 bullet points.
2. **🛑 Immediate Containment Steps**: Immediate actions the engineer must execute right now to contain the breach (e.g. isolate host, kill process, disable account).
3. **🛠️ Actionable Remediation Script (${os?.toLowerCase() === 'linux' ? 'Bash' : 'PowerShell'})**: Provide exact, copy-paste ready, safe commands to revert unauthorized changes, restore defender/security settings, or inspect suspicious files/sockets.
4. **🛡️ Prevention & Policy Hardening**: 2-3 long-term hardening recommendations (e.g. GPO changes, firewall rules, SSH key policies).

Keep your response practical, authoritative, and direct.`;

        const messages = [
            {
                role: 'system',
                content: 'You are an elite Cybersecurity Incident Response (IR) expert assisting enterprise sysadmins. Output clean markdown with formatted code blocks for commands.'
            },
            {
                role: 'user',
                content: prompt
            }
        ];

        const aiResponse = await callAiEngine(config, messages);
        res.json({
            success: true,
            analysis: aiResponse.content,
            model: aiResponse.model,
            provider: aiResponse.provider
        });
    } catch (e) {
        console.error('[AI Forensics] Remediation generation failed:', e.message);
        res.status(500).json({ error: formatAiError(e, config?.timeout) });
    }
});

router.getAiConfig = getAiConfig;
router.callAiEngine = callAiEngine;
router.validateAiConfig = validateAiConfig;
router.formatAiError = formatAiError;
router.isInternalHost = isInternalHost;

module.exports = router;
