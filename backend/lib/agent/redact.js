/**
 * Removes secrets from data before it is sent to an AI model.
 * 1. Exact values of sensitive .env keys (same rule as envEditor.shouldEncrypt)
 * 2. Common secret formats (key=value, auth headers, URL credentials, PEM keys, JWT, enc:, AWS)
 */
const { readEnv, shouldEncrypt } = require('../envEditor');

const MIN_SECRET_LENGTH = 6;
const MAX_DEPTH = 20;

const PATTERNS = [
    // PEM private keys, including blocks truncated before the END marker
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
    // scheme://user:pass@host — lookbehind + bounded scheme avoids quadratic backtracking; greedy pass handles '@' in passwords
    [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s:@\/]+):([^\s\/]+)@/gi, '$1$2:[REDACTED]@'],
    // Authorization / Proxy-Authorization headers (any case, optional scheme)
    [/\b((?:Proxy-)?Authorization)(\s*[:=]\s*)(?:(Bearer|Basic|Digest|Negotiate|NTLM)\s+)?([^\s"',;]+)/gi,
        (m, header, sep, scheme) => `${header}${sep}${scheme ? `${scheme} ` : ''}[REDACTED]`],
    // Bare bearer tokens and base64 Basic credentials (must contain a digit, '+', '/' or '=' so plain words survive)
    [/\bBearer\s+[A-Za-z0-9\-._~+\/]{16,}=*/gi, 'Bearer [REDACTED]'],
    [/\bBasic\s+(?=[A-Za-z0-9+\/]*[0-9+\/=])[A-Za-z0-9+\/]{12,}={0,2}/g, 'Basic [REDACTED]'],
    [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED JWT]'],
    // key = "quoted value" / 'quoted value' (whole value, spaces included), then unquoted values; never cross a newline
    [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?[ \t]*[:=][ \t]*)"[^"\n]*"/gi, '$1$2"[REDACTED]"'],
    [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?[ \t]*[:=][ \t]*)'[^'\n]*'/gi, "$1$2'[REDACTED]'"],
    [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?[ \t]*[:=][ \t]*)(["']?)(?!\[REDACTED)([^\s"',;&]+)/gi, '$1$2$3[REDACTED]'],
    [/\benc:[0-9a-f]{16,}(?::[0-9a-f]+)*/gi, '[REDACTED]'],
    [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
];

function collectSecretValues() {
    const values = new Set();
    let fileEnv = {};
    try { fileEnv = readEnv(); } catch (e) {}
    for (const source of [fileEnv, process.env]) {
        for (const [key, raw] of Object.entries(source)) {
            if (typeof raw !== 'string' || !shouldEncrypt(key)) continue;
            const value = raw.trim();
            if (value.length >= MIN_SECRET_LENGTH) values.add(value);
        }
    }
    // Longest first so a secret containing another secret is replaced whole
    return [...values].sort((a, b) => b.length - a.length);
}

function redactString(str, secrets) {
    let out = str;
    for (const secret of secrets) {
        if (secret.length >= MIN_SECRET_LENGTH && out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    }
    for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
    return out;
}

function createRedactor({ secrets } = {}) {
    const secretValues = secrets || collectSecretValues();

    const walk = (value, depth) => {
        if (typeof value === 'string') return redactString(value, secretValues);
        if (value === null || typeof value !== 'object') return value;
        if (depth > MAX_DEPTH) return '[…]';
        if (Array.isArray(value)) return value.map(v => walk(v, depth + 1));
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = walk(v, depth + 1);
        return out;
    };

    return { redact: (value) => walk(value, 0), secretCount: secretValues.length };
}

module.exports = { createRedactor, redactString, collectSecretValues };
