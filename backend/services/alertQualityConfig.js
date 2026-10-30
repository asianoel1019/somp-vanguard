/**
 * Alert quality settings (document_store `system/alert_quality.json`).
 * Shared by the web and worker processes; the worker sees writes via the existing
 * INVALIDATE_DOC_CACHE IPC plus this module's 30 s cache.
 */
const { readDataSync } = require('../lib/db');
const { replaceDocument } = require('../lib/docStore');

const CONFIG_KEY = 'system/alert_quality.json';
const CACHE_MS = 30000;
const DEFAULTS = Object.freeze({
    evaluationEnabled: true,
    rateLimitPerMinute: 10,
    flapping: { transitions: 4, windowMin: 30, stableMin: 30 },
    cooldownMin: 15,
    escalation: {
        telegram: { enabled: false, chatId: '' },
        email: { enabled: false, to: '' },
        webhook: { enabled: false, webhookId: '' },
    },
});
const RANGES = {
    rateLimitPerMinute: [1, 1000],
    cooldownMin: [1, 1440],
    'flapping.transitions': [2, 50],
    'flapping.windowMin': [5, 1440],
    'flapping.stableMin': [5, 1440],
};
const CHAT_ID_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

let cache = null;
let cacheAt = 0;

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const clampInt = (v, [min, max], def) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.round(n)));
};

function normalize(raw) {
    const r = obj(raw);
    const f = obj(r.flapping);
    const e = obj(r.escalation);
    const tg = obj(e.telegram), em = obj(e.email), wh = obj(e.webhook);
    return {
        evaluationEnabled: r.evaluationEnabled !== false,
        rateLimitPerMinute: clampInt(r.rateLimitPerMinute, RANGES.rateLimitPerMinute, DEFAULTS.rateLimitPerMinute),
        flapping: {
            transitions: clampInt(f.transitions, RANGES['flapping.transitions'], DEFAULTS.flapping.transitions),
            windowMin: clampInt(f.windowMin, RANGES['flapping.windowMin'], DEFAULTS.flapping.windowMin),
            stableMin: clampInt(f.stableMin, RANGES['flapping.stableMin'], DEFAULTS.flapping.stableMin),
        },
        cooldownMin: clampInt(r.cooldownMin, RANGES.cooldownMin, DEFAULTS.cooldownMin),
        escalation: {
            telegram: { enabled: tg.enabled === true, chatId: String(tg.chatId || '').trim() },
            email: { enabled: em.enabled === true, to: String(em.to || '').trim() },
            webhook: { enabled: wh.enabled === true, webhookId: String(wh.webhookId || '').trim() },
        },
    };
}

function getConfig(nowMs = Date.now()) {
    if (cache && nowMs - cacheAt < CACHE_MS) return cache;
    try {
        cache = normalize(readDataSync(CONFIG_KEY, {}));
    } catch (e) {
        console.error('[AlertQuality] Failed to read settings, using defaults:', e.message);
        cache = normalize({});
    }
    cacheAt = nowMs;
    return cache;
}

function invalidateConfig() { cache = null; cacheAt = 0; }

/** Strict validation for API input (normalize() is lenient for stored data). */
function validateConfig(input) {
    const errors = [];
    const r = obj(input);
    const checkRange = (path, value) => {
        if (value === undefined) return;
        const [min, max] = RANGES[path];
        const n = Number(value);
        if (!Number.isInteger(n) || n < min || n > max) errors.push(`${path} must be an integer between ${min} and ${max}`);
    };
    checkRange('rateLimitPerMinute', r.rateLimitPerMinute);
    checkRange('cooldownMin', r.cooldownMin);
    const f = obj(r.flapping);
    checkRange('flapping.transitions', f.transitions);
    checkRange('flapping.windowMin', f.windowMin);
    checkRange('flapping.stableMin', f.stableMin);
    if (r.evaluationEnabled !== undefined && typeof r.evaluationEnabled !== 'boolean') errors.push('evaluationEnabled must be true or false');
    const e = obj(r.escalation);
    const tg = obj(e.telegram), em = obj(e.email), wh = obj(e.webhook);
    if (tg.enabled && !CHAT_ID_RE.test(String(tg.chatId || '').trim())) errors.push('escalation.telegram.chatId is invalid (numeric ID or @channel)');
    if (em.enabled) {
        const list = String(em.to || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
        if (list.length === 0 || list.some(a => !EMAIL_RE.test(a))) errors.push('escalation.email.to must be comma-separated email addresses');
    }
    if (wh.enabled && !String(wh.webhookId || '').trim()) errors.push('escalation.webhook.webhookId is required');
    const merged = normalize({ ...getConfig(), ...r, flapping: { ...getConfig().flapping, ...f }, escalation: {
        telegram: { ...getConfig().escalation.telegram, ...tg },
        email: { ...getConfig().escalation.email, ...em },
        webhook: { ...getConfig().escalation.webhook, ...wh },
    } });
    return { ok: errors.length === 0, errors, value: merged };
}

function saveConfig(input) {
    const r = validateConfig(input);
    if (!r.ok) {
        const err = new Error(r.errors.join('; '));
        err.errors = r.errors;
        throw err;
    }
    // whole-document replacement (the validated, fully merged settings) under the shared document lock
    replaceDocument(CONFIG_KEY, r.value, { defaultValue: {}, fnName: 'alertQualityConfig.saveConfig', label: 'alert quality' });
    invalidateConfig();
    return r.value;
}

module.exports = { CONFIG_KEY, DEFAULTS, getConfig, saveConfig, validateConfig, invalidateConfig, normalize };
