// Pure helpers for alert rule exclusions ("Excluded hosts"). Matching mirrors backend services/ruleScope.js:
// a rule is excluded for a monitor when an exclusion names the monitor id or any of the monitor's tags.

/**
 * Tags as an array, exactly like the backend (alertRuleEval.parseTags): an array, or a JSON array string.
 * Anything else (comma lists, malformed JSON) is no tags — so the UI never shows "Excluded" where the engine
 * would still evaluate the rule. Tags are always stored as JSON arrays.
 */
export function parseTagList(tags) {
    if (Array.isArray(tags)) return tags.map(String);
    if (typeof tags !== 'string' || !tags.trim()) return [];
    try {
        const p = JSON.parse(tags);
        return Array.isArray(p) ? p.map(String) : [];
    } catch {
        return [];
    }
}

export function isExcludedFor(ruleId, monitor, exclusions) {
    if (!monitor) return false;
    const tags = parseTagList(monitor.tags);
    return (exclusions || []).some(e => e.ruleId === ruleId && (
        (e.scopeType === 'monitor' && String(e.scopeValue) === String(monitor.id)) ||
        (e.scopeType === 'tag' && tags.includes(String(e.scopeValue)))
    ));
}

/** Rules (in the given rule order) this monitor is excluded from. */
export function excludedRulesForMonitor(monitor, exclusions, rules) {
    if (!monitor) return [];
    return (rules || []).filter(r => isExcludedFor(r.id, monitor, exclusions));
}

export function exclusionsByRule(exclusions) {
    const out = {};
    for (const e of exclusions || []) (out[e.ruleId] ||= []).push(e);
    return out;
}

export function monitorLabel(m) {
    if (!m) return '';
    return m.ip ? `${m.name || m.id} (${m.ip})` : (m.name || m.id);
}

export function exclusionLabel(e, monitorsById) {
    if (e.scopeType === 'monitor') {
        const m = monitorsById ? monitorsById[e.scopeValue] : null;
        return `Host: ${m ? monitorLabel(m) : e.scopeValue}`;
    }
    return `Tag: ${e.scopeValue}`;
}

/** Selected monitor ids that also have a direct (monitor) binding to the rule — the exclusion wins, so the UI warns. */
export function explicitBindingConflicts(ruleId, monitorIds, bindings) {
    const direct = new Set((bindings || []).filter(b => b.ruleId === ruleId && b.scopeType === 'monitor').map(b => String(b.scopeValue)));
    return (monitorIds || []).filter(id => direct.has(String(id)));
}

export function filterMonitors(monitors, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return monitors || [];
    return (monitors || []).filter(m =>
        String(m.name || '').toLowerCase().includes(q) ||
        String(m.ip || '').toLowerCase().includes(q) ||
        parseTagList(m.tags).some(t => t.toLowerCase().includes(q)));
}
