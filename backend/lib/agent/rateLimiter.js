/** In-memory per-user limiter: one running request at a time and N requests per rolling hour. */
const HOUR_MS = 3600 * 1000;

function createRateLimiter() {
    const hits = new Map();
    const active = new Set();

    return {
        tryStart(key, limitPerHour, nowMs = Date.now()) {
            if (active.has(key)) return { ok: false, reason: 'busy' };
            const recent = (hits.get(key) || []).filter(t => nowMs - t < HOUR_MS);
            if (recent.length >= limitPerHour) {
                hits.set(key, recent);
                return { ok: false, reason: 'rate', retryAfterSec: Math.ceil((recent[0] + HOUR_MS - nowMs) / 1000) };
            }
            recent.push(nowMs);
            hits.set(key, recent);
            active.add(key);
            return { ok: true };
        },
        finish(key) {
            active.delete(key);
        },
    };
}

module.exports = { createRateLimiter };
