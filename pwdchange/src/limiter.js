// Attempts per key in a sliding window (in memory: one server process).

class Limiter {
    /** @param {number} max attempts allowed in windowMs */
    constructor(max, windowMs) {
        this.max = max;
        this.windowMs = windowMs;
        this.hits = new Map(); // key -> [timestamps]
    }

    /** Records an attempt; false when the key already used up its attempts (then nothing is recorded). */
    take(key, now = Date.now()) {
        const k = String(key).toLowerCase();
        const recent = (this.hits.get(k) || []).filter(t => now - t < this.windowMs);
        if (recent.length >= this.max) {
            this.hits.set(k, recent);
            return false;
        }
        recent.push(now);
        this.hits.set(k, recent);
        if (this.hits.size > 10000) this.prune(now);
        return true;
    }

    /** Seconds until the key may try again (0 when it may now). */
    retryAfter(key, now = Date.now()) {
        const recent = (this.hits.get(String(key).toLowerCase()) || []).filter(t => now - t < this.windowMs);
        if (recent.length < this.max) return 0;
        return Math.ceil((recent[0] + this.windowMs - now) / 1000);
    }

    prune(now = Date.now()) {
        for (const [k, list] of this.hits) {
            const recent = list.filter(t => now - t < this.windowMs);
            if (recent.length) this.hits.set(k, recent); else this.hits.delete(k);
        }
    }
}

module.exports = { Limiter };
