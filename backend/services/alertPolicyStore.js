/**
 * Persistence for alert notification policy. Lives in scout.sqlite so the web process
 * (metric/log evaluation) and the worker (offline, escalation, digest) share one state.
 * SQLite engine only (synchronous db calls, same as scoutAlertEngine).
 */
const db = require('./scoutDb');
const { safeSlice } = require('../lib/textUtil');

const WINDOW_CACHE_MS = 30000;
let windowCache = null;
let windowCacheAt = 0;

const stateKey = (monitorId, ruleId) => `${monitorId}|${ruleId}`;

function parseArr(v) {
    try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}

function getState(key) {
    const row = db.get('SELECT * FROM notify_state WHERE stateKey = ?', [key]);
    return {
        stateKey: key,
        lastTriggerNotifiedAt: row ? row.lastTriggerNotifiedAt : null,
        lastRecoveryNotifiedAt: row ? row.lastRecoveryNotifiedAt : null,
        transitions: row ? parseArr(row.transitions) : [],
        flappingSince: row ? row.flappingSince : null,
    };
}

function saveState(s) {
    db.run(`INSERT INTO notify_state (stateKey, lastTriggerNotifiedAt, lastRecoveryNotifiedAt, transitions, flappingSince)
            VALUES (?,?,?,?,?)
            ON CONFLICT(stateKey) DO UPDATE SET lastTriggerNotifiedAt = excluded.lastTriggerNotifiedAt,
              lastRecoveryNotifiedAt = excluded.lastRecoveryNotifiedAt, transitions = excluded.transitions,
              flappingSince = excluded.flappingSince`,
        [s.stateKey, s.lastTriggerNotifiedAt, s.lastRecoveryNotifiedAt, JSON.stringify(s.transitions || []), s.flappingSince]);
}

const listFlapping = () => db.all('SELECT * FROM notify_state WHERE flappingSince IS NOT NULL')
    .map(r => ({ ...r, transitions: parseArr(r.transitions) }));

function minuteBucket(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function bumpRate(bucket) {
    const row = db.get('INSERT INTO notify_rate (bucket, count) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET count = count + 1 RETURNING count', [bucket]);
    return row ? row.count : 1;
}

const pruneRate = (beforeBucket) => db.run('DELETE FROM notify_rate WHERE bucket < ?', [beforeBucket]);

const addDigest = (line, createdAtIso) => db.run('INSERT INTO notify_digest (createdAt, line) VALUES (?, ?)', [createdAtIso, safeSlice(line, 300)]);

/** Takes (and deletes) digest rows created before beforeIso: [{ line, createdAt }] in insertion order. */
function takeDigestRows(beforeIso) {
    const rows = db.all('SELECT id, line, createdAt FROM notify_digest WHERE createdAt < ? ORDER BY id', [beforeIso]);
    if (rows.length) db.run('DELETE FROM notify_digest WHERE id <= ? AND createdAt < ?', [rows[rows.length - 1].id, beforeIso]);
    return rows.map(r => ({ line: r.line, createdAt: r.createdAt }));
}

const takeDigest = (beforeIso) => takeDigestRows(beforeIso).map(r => r.line);

function listWindows(nowMs = Date.now()) {
    // cache age uses the real clock; nowMs only filters out once windows that have already ended
    if (windowCache && Date.now() - windowCacheAt < WINDOW_CACHE_MS) return windowCache;
    try {
        const nowIso = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString();
        windowCache = db.all("SELECT * FROM maintenance_windows WHERE enabled = 1 AND (kind = 'weekly' OR endAt > ?)", [nowIso]);
    } catch (e) {
        console.error('[AlertPolicy] Failed to load maintenance windows:', e.message);
        return [];
    }
    windowCacheAt = Date.now();
    return windowCache;
}

function invalidateWindows() { windowCache = null; windowCacheAt = 0; }

module.exports = { stateKey, getState, saveState, listFlapping, minuteBucket, bumpRate, pruneRate, addDigest, takeDigest, takeDigestRows, listWindows, invalidateWindows };
