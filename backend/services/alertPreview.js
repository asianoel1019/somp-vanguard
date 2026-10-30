/**
 * Read-only "what would fire right now" report: latest stored metrics per enabled monitor × bound metric rules.
 * Takes a minimal { all, get } db so the server script can pass a read-only connection.
 * Depends only on pure modules (no logger, no migrations) — keep it that way.
 */
const { evaluateCheck } = require('./alertRuleEval');
const { buildRuleScope, loadExclusions, applicableRuleIds } = require('./ruleScope');
const { findActiveWindow } = require('./maintenanceWindows');

const STALE_MS = 10 * 60000;

function previewAlerts({ all, get }, now = new Date()) {
    const monitors = all('SELECT * FROM monitors WHERE enabled = 1');
    const rules = all('SELECT * FROM rules');
    const rulesById = new Map(rules.map(r => [r.id, r]));
    // Same rule scope as the engine: bindings minus exclusions (a DB without rule_exclusions yet = no exclusions)
    const { index, exclusions } = buildRuleScope(all('SELECT * FROM rule_bindings'), loadExclusions({ all }));
    const windows = all('SELECT * FROM maintenance_windows WHERE enabled = 1');
    const firing = [];
    let withoutMetrics = 0;
    let stale = 0;
    const checkedRules = new Set();
    for (const m of monitors) {
        const row = get('SELECT metrics, timestamp FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1', [m.id]);
        let metrics = null;
        try { metrics = row ? JSON.parse(row.metrics) : null; } catch (e) { metrics = null; }
        if (!metrics) { withoutMetrics++; continue; }
        const age = now.getTime() - Date.parse(row.timestamp);
        if (!Number.isFinite(age) || age > STALE_MS) { stale++; continue; }   // long-offline/removed agents must not look like they are firing
        for (const ruleId of applicableRuleIds(m, index, exclusions, { includeGlobal: false })) {
            const rule = rulesById.get(ruleId);
            if (!rule || rule.category === 'log' || ['winevent', 'syslog', 'offline', 'connectivity'].includes(rule.type)) continue;
            checkedRules.add(ruleId);
            const r = evaluateCheck(rule, metrics);
            if (!r || !r.exceeded) continue;
            firing.push({
                monitorId: m.id, host: m.name, ip: m.ip, ruleId, ruleName: rule.name, type: rule.type, target: rule.target || '',
                metricsAt: row.timestamp, value: r.value, threshold: rule.threshold, inMaintenance: !!findActiveWindow(windows, m, ruleId, now),
            });
        }
    }
    firing.sort((a, b) => String(a.host).localeCompare(String(b.host)) || String(a.ruleName).localeCompare(String(b.ruleName)));
    return {
        generatedAt: now.toISOString(),
        monitorsChecked: monitors.length,
        monitorsWithoutMetrics: withoutMetrics,
        monitorsStale: stale,
        rulesChecked: checkedRules.size,
        firing,
        note: 'Only metric rules are estimated (CPU/memory/disk/service/process/ping/tcp). Log rules and offline rules cannot be estimated from historical data. Actual firing requires the alertHits count of consecutive hits set on the rule.',
    };
}

module.exports = { previewAlerts };
