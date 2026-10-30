/**
 * Resolves connection settings for the AI Agent from the shared AI configuration.
 * Mirrors routes/ai.js callAiEngine() (defaults, timeout, API key, proxy rules).
 */
const { getAxiosProxyConfig } = require('../../proxyHelper');
const { decryptText } = require('../../crypto');
const { AgentError } = require('../errors');

const DEFAULT_MODELS = {
    opencode: 'claude-3-7-sonnet',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-7-sonnet-latest',
    deepseek: 'deepseek-chat',
    gemini: 'gemini-2.0-flash',
    azure: 'gpt-4o',
    ollama: 'llama3:8b',
    custom: 'default',
};
const DEFAULT_URLS = {
    opencode: 'https://opencode.ai/zen/v1',
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    deepseek: 'https://api.deepseek.com',
    gemini: 'https://generativelanguage.googleapis.com',
    ollama: 'http://localhost:11434',
};

function resolveConnection(config) {
    const { isInternalHost } = require('../../../routes/ai');
    const provider = (config.provider || 'opencode').toLowerCase();

    let rawTimeout = Number(config.timeout ?? 120000);
    if (rawTimeout === 45000) rawTimeout = 120000;
    const timeout = rawTimeout < 1000 ? rawTimeout * 1000 : rawTimeout;

    const model = (config.agentModel && String(config.agentModel).trim()) || config.model || DEFAULT_MODELS[provider] || 'default';

    let apiKey = '';
    if (config.apiKey_enc) {
        try { apiKey = decryptText(config.apiKey_enc); } catch (e) {
            console.error('[AI Agent] Failed to decrypt API key:', e.message);
        }
    }

    const baseUrl = (config.baseUrl || DEFAULT_URLS[provider] || '').trim().replace(/\/+$/, '');
    const proxy = isInternalHost(baseUrl) ? false : getAxiosProxyConfig('AI');

    return {
        provider,
        model,
        apiKey,
        baseUrl,
        timeout,
        maxTokens: Number(config.maxTokens ?? 2048),
        temperature: Number(config.temperature ?? 0.3),
        axiosOptions: { timeout, proxy: proxy || false },
    };
}

const TOOLS_UNSUPPORTED_RE = /(does not|doesn't|do not) support (tools|tool use|tool calling|function calling|functions)|(tools?|tool use|tool calling|function calling) (is |are )?not supported/i;

/** Converts an axios error into an AgentError with a user-readable message. */
function wrapHttpError(e, conn, tag) {
    const { formatAiError } = require('../../../routes/ai');
    const status = e.response?.status;
    console.error(`[AI Agent ${tag} Error]`, { model: conn.model, status, message: e.message });
    const message = formatAiError(e, conn.timeout);
    if ((status === 400 || status === 404 || status === 422) && TOOLS_UNSUPPORTED_RE.test(message)) {
        const err = new AgentError(`目前選擇的模型不支援工具呼叫，請至 AI Service 設定改用支援的模型。（原始錯誤：${message}）`, 'TOOLS_UNSUPPORTED');
        err.status = status;
        return err;
    }
    const err = new AgentError(message, 'PROVIDER_ERROR');
    err.status = status || 500;
    return err;
}

// ─── Rate-limit / overload retry ────────────────────

const RETRYABLE_STATUS = new Set([429, 503, 529]);
const MAX_RETRIES = 3;
const MAX_WAIT_MS = 60000;
// Budget for callers without an agent deadline (e.g. POST /api/agent/test)
const DEFAULT_RETRY_BUDGET_MS = 60000;

function parseSeconds(value) {
    const m = /^\s*([\d.]+)\s*s?\s*$/i.exec(String(value ?? ''));
    return m ? Number(m[1]) : NaN;
}

function errorText(e) {
    const data = e.response?.data;
    if (typeof data?.error?.message === 'string') return data.error.message;
    if (typeof data?.message === 'string') return data.message;
    return e.message || '';
}

/** How long the provider asks us to wait before retrying (ms). */
function retryDelayMs(e, attempt) {
    // 1. Gemini: error.details[].retryDelay ("17s")
    const details = e.response?.data?.error?.details;
    if (Array.isArray(details)) {
        const info = details.find(d => d && d.retryDelay !== undefined);
        const secs = info ? parseSeconds(info.retryDelay) : NaN;
        if (Number.isFinite(secs)) return Math.ceil(secs * 1000);
    }
    // 2. "Please retry in 17.2s" in the message
    const m = /retry in ([\d.]+)\s*s/i.exec(errorText(e));
    if (m) return Math.ceil(Number(m[1]) * 1000);
    // 3. Retry-After header (seconds or HTTP date)
    const header = e.response?.headers?.['retry-after'];
    if (header !== undefined) {
        const secs = Number(header);
        if (Number.isFinite(secs)) return Math.max(0, Math.ceil(secs * 1000));
        const at = Date.parse(header);
        if (Number.isFinite(at)) return Math.max(0, at - Date.now());
    }
    // 4. Exponential fallback: 2s, 4s, 8s
    return 2000 * 2 ** attempt;
}

/** True when the provider reports a per-day quota (waiting a few seconds will not help). */
function isDailyQuota(e) {
    const details = e.response?.data?.error?.details;
    if (Array.isArray(details)) {
        const daily = details.some(d => Array.isArray(d?.violations) && d.violations.some(v => /per ?day/i.test(`${v.quotaId || ''} ${v.quotaMetric || ''}`)));
        if (daily) return true;
    }
    return /per ?day|daily (limit|quota)/i.test(errorText(e));
}

function rateLimitError(e, conn, tag, { daily }) {
    const status = e.response?.status;
    const { formatAiError } = require('../../../routes/ai');
    console.error(`[AI Agent ${tag} Rate Limited]`, { model: conn.model, status, daily });
    const original = formatAiError(e, conn.timeout);
    const text = daily
        ? 'AI 服務已達今日請求額度，請明天再試，或至供應商後台確認方案額度。'
        : status === 429
            ? 'AI 服務請求次數已達上限，自動重試後仍未成功。請稍候再試，或至供應商後台確認方案額度。'
            : 'AI 服務暫時忙碌，自動重試後仍未成功，請稍候再試。';
    const err = new AgentError(`${text}（原始錯誤：${original}）`, 'RATE_LIMITED');
    err.status = status;
    return err;
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(new AgentError('使用者已停止查詢', 'ABORTED'));
        const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
        const onAbort = () => { clearTimeout(timer); reject(new AgentError('使用者已停止查詢', 'ABORTED')); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * axios.post with retries on 429/503/529, honouring the provider's requested delay.
 * Never waits past `deadline` (agent total timeout) or more than MAX_WAIT_MS per retry;
 * per-day quotas are not retried. Other HTTP errors are converted by wrapHttpError.
 * @param {{ signal?: AbortSignal, deadline?: number, onRetry?: Function }} retry
 */
async function postWithRetry(conn, url, body, options, tag, { signal, deadline, onRetry } = {}) {
    const axios = require('axios');
    const budgetEnd = deadline || Date.now() + DEFAULT_RETRY_BUDGET_MS;
    for (let attempt = 0; ; attempt++) {
        try {
            return await axios.post(url, body, options);
        } catch (e) {
            const status = e.response?.status;
            if (!RETRYABLE_STATUS.has(status)) throw wrapHttpError(e, conn, tag);
            const waitMs = retryDelayMs(e, attempt);
            const daily = isDailyQuota(e);
            if (daily || attempt >= MAX_RETRIES || waitMs > MAX_WAIT_MS || Date.now() + waitMs > budgetEnd) {
                throw rateLimitError(e, conn, tag, { daily });
            }
            console.warn(`[AI Agent ${tag}] HTTP ${status}, retry ${attempt + 1}/${MAX_RETRIES} in ${waitMs}ms`);
            if (onRetry) onRetry({ waitMs, attempt: attempt + 1, maxRetries: MAX_RETRIES, status });
            await sleep(waitMs, signal);
        }
    }
}

module.exports = { resolveConnection, wrapHttpError, postWithRetry, retryDelayMs, isDailyQuota, DEFAULT_MODELS, DEFAULT_URLS };
