/**
 * Which alert rules apply to a monitor — the ONE place that combines inclusion bindings (rule_bindings)
 * with exclusions (rule_exclusions). Every evaluation site (metric, offline/connectivity, log/event,
 * agent dynamic config, preview) must go through this module.
 *
 * A rule applies when an inclusion binding matches (or, for log rules, the rule has no binding at all)
 * AND no exclusion matches the monitor id or any of its tags. An exclusion always wins, also over an
 * explicit monitor binding and over global bindings.
 *
 * Pure: no db, no logger (alertPreview runs against a read-only connection in a standalone script).
 */
const { buildBindingIndex, applicableRuleIds: inclusionRuleIds, parseTags } = require('./alertRuleEval');

const EXCLUSION_SCOPES = ['monitor', 'tag'];

/** rows: [{ ruleId, scopeType: 'monitor'|'tag', scopeValue }] → { monitor: Map<id, Set<ruleId>>, tag: Map<tag, Set<ruleId>> } */
function buildExclusionIndex(rows) {
    const idx = { monitor: new Map(), tag: new Map() };
    for (const e of rows || []) {
        if (!e || !EXCLUSION_SCOPES.includes(e.scopeType)) continue;
        const key = String(e.scopeValue);
        const map = idx[e.scopeType];
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(e.ruleId);
    }
    return idx;
}

/** Set of rule ids excluded for this monitor (by monitor id or any of its tags). */
function excludedRuleIds(exclusionIndex, monitor) {
    const out = new Set();
    if (!exclusionIndex || !monitor) return out;
    const add = (set) => { if (set) for (const id of set) out.add(id); };
    add(exclusionIndex.monitor.get(String(monitor.id)));
    for (const t of parseTags(monitor.tags)) add(exclusionIndex.tag.get(String(t)));
    return out;
}

/** Applicable rule ids (inclusion minus exclusions). opts.includeGlobal as in alertRuleEval. */
function applicableRuleIds(monitor, bindingIndex, exclusionIndex, { includeGlobal = false } = {}) {
    const excluded = excludedRuleIds(exclusionIndex, monitor);
    const included = inclusionRuleIds(bindingIndex, monitor, { includeGlobal });
    return excluded.size === 0 ? included : included.filter(id => !excluded.has(id));
}

/**
 * Predicate for one monitor (computes inclusion/exclusion once, then O(1) per rule).
 * opts.unboundApplies + opts.boundRuleIds: a rule with no inclusion binding at all applies everywhere (log rules).
 */
function applicabilityFor(monitor, bindingIndex, exclusionIndex, { includeGlobal = false, unboundApplies = false, boundRuleIds = null } = {}) {
    const included = new Set(inclusionRuleIds(bindingIndex, monitor, { includeGlobal }));
    const excluded = excludedRuleIds(exclusionIndex, monitor);
    return (ruleId) => {
        if (excluded.has(ruleId)) return false;
        if (included.has(ruleId)) return true;
        return !!(unboundApplies && boundRuleIds && !boundRuleIds.has(ruleId));
    };
}

function isRuleApplicable(ruleId, monitor, bindingIndex, exclusionIndex, opts) {
    return applicabilityFor(monitor, bindingIndex, exclusionIndex, opts)(ruleId);
}

/** Loads both tables' rows into one context: { index, exclusions, boundRuleIds }. Exclusions never count as bindings. */
function buildRuleScope(bindings, exclusions) {
    return {
        index: buildBindingIndex(bindings || []),
        exclusions: buildExclusionIndex(exclusions || []),
        boundRuleIds: new Set((bindings || []).map(b => b.ruleId)),
    };
}

/** Reads all exclusion rows through an injected { all } (sync SQLite). A missing table (DB not migrated yet,
 *  read-only preview DB) means "no exclusions" rather than an error. */
function loadExclusions({ all }) {
    try {
        const rows = all('SELECT ruleId, scopeType, scopeValue FROM rule_exclusions');
        return Array.isArray(rows) ? rows : [];
    } catch (e) {
        return [];
    }
}

module.exports = { EXCLUSION_SCOPES, loadExclusions, buildExclusionIndex, excludedRuleIds, applicableRuleIds, applicabilityFor, isRuleApplicable, buildRuleScope };
