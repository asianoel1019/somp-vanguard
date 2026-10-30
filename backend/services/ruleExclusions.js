/**
 * Alert rule exclusions ("Excluded hosts") store. Evaluation logic lives in ruleScope.js (pure);
 * this module only reads/writes rule_exclusions and performs the side effects of adding one:
 * open alerts of that rule on the excluded monitors are resolved silently (resolvedReason 'excluded',
 * no notification) and their alert_state / notify_state rows are cleared.
 * SQLite engine only (synchronous db calls), like the alert engine.
 */
const crypto = require('crypto');
const db = require('./scoutDb');
const { EXCLUSION_SCOPES, loadExclusions, buildExclusionIndex, excludedRuleIds } = require('./ruleScope');
const { parseTags } = require('./alertRuleEval');

const MAX_TAG = 64;
const MAX_REASON = 500;
const CHUNK = 400;

const chunks = (arr) => { const out = []; for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK)); return out; };
const marks = (n) => new Array(n).fill('?').join(',');

/** → { value } normalised, or { error } (HTTP 400 message). */
function validate(body) {
    const b = body || {};
    const ruleId = typeof b.ruleId === 'string' ? b.ruleId.trim() : '';
    if (!ruleId || !db.get('SELECT 1 AS x FROM rules WHERE id = ?', [ruleId])) return { error: 'Alert rule not found' };
    if (!EXCLUSION_SCOPES.includes(b.scopeType)) return { error: "scopeType must be 'monitor' or 'tag'" };
    const scopeValue = typeof b.scopeValue === 'string' ? b.scopeValue.trim() : (typeof b.scopeValue === 'number' ? String(b.scopeValue) : '');
    if (b.scopeType === 'monitor') {
        if (!scopeValue || !db.get('SELECT 1 AS x FROM monitors WHERE id = ?', [scopeValue])) return { error: 'Monitor not found' };
    } else {
        if (!scopeValue) return { error: 'Tag is required' };
        if (scopeValue.length > MAX_TAG) return { error: `Tag must be at most ${MAX_TAG} characters` };
    }
    if (b.reason !== undefined && b.reason !== null && typeof b.reason !== 'string') return { error: 'reason must be a string' };
    const reason = (b.reason || '').trim();
    if (reason.length > MAX_REASON) return { error: `Reason must be at most ${MAX_REASON} characters` };
    return { value: { ruleId, scopeType: b.scopeType, scopeValue, reason } };
}

function list(ruleId) {
    const rows = ruleId
        ? db.all('SELECT * FROM rule_exclusions WHERE ruleId = ? ORDER BY createdAt', [ruleId])
        : db.all('SELECT * FROM rule_exclusions ORDER BY createdAt');
    return rows || [];
}

function get(id) {
    return db.get('SELECT * FROM rule_exclusions WHERE id = ?', [id]) || null;
}

/** Monitor ids covered by an exclusion (monitor scope: that id; tag scope: every monitor carrying the tag). */
function affectedMonitorIds({ scopeType, scopeValue }) {
    if (scopeType === 'monitor') return [String(scopeValue)];
    if (scopeType !== 'tag') return [];
    const tag = String(scopeValue);
    // instr() is a cheap substring prefilter (no LIKE wildcards); the JSON is parsed to match whole tags only
    const rows = db.all('SELECT id, tags FROM monitors WHERE instr(tags, ?) > 0', [tag]) || [];
    return rows.filter(r => parseTags(r.tags).map(String).includes(tag)).map(r => String(r.id));
}

/** Resolves open alerts of ruleId on the monitors silently and clears their engine/notification state. Returns resolved count. */
function resolveExcluded(ruleId, monitorIds, now = new Date()) {
    let resolved = 0;
    for (const part of chunks(monitorIds)) {
        const res = db.run(`UPDATE alerts SET resolved = 1, resolvedAt = ?, resolvedReason = 'excluded' WHERE checkId = ? AND resolved = 0 AND monitorId IN (${marks(part.length)})`,
            [now.toISOString(), ruleId, ...part]);
        resolved += (res && res.changes) || 0;
        const stateKeys = part.flatMap(m => [`${m}-${ruleId}`, `log-${m}-${ruleId}`]);
        db.run(`DELETE FROM alert_state WHERE stateKey IN (${marks(stateKeys.length)})`, stateKeys);
        const notifyKeys = part.map(m => `${m}|${ruleId}`);
        db.run(`DELETE FROM notify_state WHERE stateKey IN (${marks(notifyKeys.length)})`, notifyKeys);
    }
    return resolved;
}

/**
 * Adds a validated exclusion (see validate) atomically with the silent resolution of affected open alerts.
 * → { duplicate: true } | { exclusion, monitorIds, resolvedAlerts }
 */
function add(value, createdBy, now = new Date()) {
    const { ruleId, scopeType, scopeValue } = value;
    if (db.get('SELECT 1 AS x FROM rule_exclusions WHERE ruleId = ? AND scopeType = ? AND scopeValue = ?', [ruleId, scopeType, scopeValue])) {
        return { duplicate: true };
    }
    const exclusion = { id: crypto.randomUUID(), ruleId, scopeType, scopeValue, reason: value.reason || '', createdBy: createdBy || '', createdAt: now.toISOString() };
    const monitorIds = affectedMonitorIds(exclusion);
    let resolvedAlerts = 0;
    db.exec('BEGIN');
    try {
        db.run('INSERT INTO rule_exclusions (id, ruleId, scopeType, scopeValue, reason, createdBy, createdAt) VALUES (?,?,?,?,?,?,?)',
            [exclusion.id, exclusion.ruleId, exclusion.scopeType, exclusion.scopeValue, exclusion.reason, exclusion.createdBy, exclusion.createdAt]);
        resolvedAlerts = resolveExcluded(ruleId, monitorIds, now);
        db.exec('COMMIT');
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch (e2) { /* nothing to roll back */ }
        // A concurrent request inserted the same exclusion after our pre-check: unique index → duplicate (409)
        if (/UNIQUE constraint|unique|duplicate/i.test(e && e.message)) return { duplicate: true };
        throw e;
    }
    return { exclusion, monitorIds, resolvedAlerts };
}

/**
 * After a monitor's tags (or other scope) changed: resolves open alerts of every rule now excluded for it and clears
 * the pair's state. → [{ ruleId, resolved }] for rules that had open alerts.
 */
function resolveForMonitor(monitor, now = new Date()) {
    if (!monitor || monitor.id == null) return [];
    const excluded = excludedRuleIds(buildExclusionIndex(loadExclusions(db)), monitor);
    const out = [];
    for (const ruleId of excluded) {
        const resolved = resolveExcluded(ruleId, [String(monitor.id)], now);
        if (resolved > 0) out.push({ ruleId, resolved });
    }
    return out;
}

/**
 * Safety net (worker job, every run): closes any open alert whose (rule, monitor) is excluded — covers tags added
 * later, exclusions written by another process, or a crash between steps. Only open alerts of rules that have
 * exclusions are read (idx_alerts_active), so with no exclusions this is a single tiny query. Returns resolved count.
 */
function reconcileOpenAlerts(now = new Date()) {
    const rows = loadExclusions(db);
    if (rows.length === 0) return 0;
    const idx = buildExclusionIndex(rows);
    const ruleIds = [...new Set(rows.map(r => r.ruleId))];
    const byRule = new Map();
    for (const part of chunks(ruleIds)) {
        const open = db.all(`SELECT DISTINCT a.monitorId, a.checkId, m.tags FROM alerts a LEFT JOIN monitors m ON m.id = a.monitorId
                             WHERE a.resolved = 0 AND a.checkId IN (${marks(part.length)})`, part) || [];
        for (const a of open) {
            if (!excludedRuleIds(idx, { id: a.monitorId, tags: a.tags }).has(a.checkId)) continue;
            if (!byRule.has(a.checkId)) byRule.set(a.checkId, new Set());
            byRule.get(a.checkId).add(String(a.monitorId));
        }
    }
    let total = 0;
    for (const [ruleId, mons] of byRule) total += resolveExcluded(ruleId, [...mons], now);
    return total;
}

/** Deletes one exclusion; returns the deleted row or null. */
function remove(id) {
    const row = get(id);
    if (!row) return null;
    db.run('DELETE FROM rule_exclusions WHERE id = ?', [id]);
    return row;
}

function removeForRule(ruleId) {
    const res = db.run('DELETE FROM rule_exclusions WHERE ruleId = ?', [ruleId]);
    return (res && res.changes) || 0;
}

/** Monitor-scoped exclusions of deleted monitors (tag exclusions are kept: other hosts may carry the tag). */
function removeForMonitors(monitorIds) {
    let n = 0;
    for (const part of chunks((monitorIds || []).map(String))) {
        const res = db.run(`DELETE FROM rule_exclusions WHERE scopeType = 'monitor' AND scopeValue IN (${marks(part.length)})`, part);
        n += (res && res.changes) || 0;
    }
    return n;
}

/** Monitor-scoped exclusions (with rule names) for the server-delete preview. */
function listForMonitors(monitorIds) {
    const out = [];
    for (const part of chunks((monitorIds || []).map(String))) {
        out.push(...(db.all(`SELECT e.id, e.ruleId, r.name AS ruleName FROM rule_exclusions e LEFT JOIN rules r ON r.id = e.ruleId
             WHERE e.scopeType = 'monitor' AND e.scopeValue IN (${marks(part.length)})`, part) || []));
    }
    return out;
}

module.exports = { MAX_TAG, MAX_REASON, validate, list, get, affectedMonitorIds, resolveExcluded, resolveForMonitor, reconcileOpenAlerts, add, remove, removeForRule, removeForMonitors, listForMonitors };
