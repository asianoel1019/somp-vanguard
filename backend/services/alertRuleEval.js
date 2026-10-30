// Pure alert-rule evaluation helpers (no I/O, no DB access).
// extractValueFromMetrics / isExceeded are moved verbatim from scoutAlertEngine.js.
// Note: scoutAlertEngine still has its own copies until the engine switches to this module.

function extractValueFromMetrics(type, target, metrics) {
    if (!metrics) return null;
    try {
        if (type === 'cpu') return metrics.cpu ? metrics.cpu.used : null;
        if (type === 'memory') return metrics.memory ? metrics.memory.used : null;
        
        if (type === 'disk' && metrics.disk) {
            const d = metrics.disk.find(x => x.mount === target || x.mount === target + '\\');
            if (d) return d.used;
        }
        
        if (type === 'ping' && metrics.ping) {
            const p = metrics.ping.find(x => x.target === target);
            if (p) return p.rttMs === -1 || p.lost === 100 ? 'down' : p.rttMs;
        }
        
        if (type === 'tcp' && metrics.tcp) {
            const t = metrics.tcp.find(x => x.host + ':' + x.port === target);
            if (t) return t.ok ? t.latencyMs : 'down';
        }
        
        if (type === 'service' && metrics.services) {
            const s = metrics.services.find(x => x.name === target);
            if (s) return s.status.toLowerCase();
        }
        
        if (type === 'process' && metrics.processes) {
            const pr = metrics.processes.find(x => x.name.toLowerCase() === target.toLowerCase());
            if (pr) return pr.status.toLowerCase(); // 'running' or 'stopped'
        }
        
        if (type === 'process_cpu' && metrics.processes) {
            const pr = metrics.processes.find(x => x.name.toLowerCase() === target.toLowerCase());
            if (pr) {
                if (pr.status.toLowerCase() === 'stopped') return 'down';
                return pr.cpuUsage;
            }
            return 'down';
        }

        if (type === 'process_memory' && metrics.processes) {
            const pr = metrics.processes.find(x => x.name.toLowerCase() === target.toLowerCase());
            if (pr) {
                if (pr.status.toLowerCase() === 'stopped') return 'down';
                return pr.memoryMB;
            }
            return 'down';
        }
    } catch (e) {}
    
    return null;
}

function isExceeded(value, threshold, type) {
    if (value === null || value === undefined) return false;
    
    if (['cpu', 'memory', 'disk', 'ping', 'tcp', 'process_cpu', 'process_memory'].includes(type)) {
        if (value === 'down') return true;
        return parseFloat(value) >= parseFloat(threshold);
    }
    
    if (['service', 'process'].includes(type)) {
        return value !== 'running';
    }
    
    console.warn(`[ScoutAlertEngine] Unknown or unsupported check type encountered: "${type}"`);
    return false;
}

const parseTags = (t) => {
    if (Array.isArray(t)) return t;
    try { const p = JSON.parse(t || '[]'); return Array.isArray(p) ? p : []; } catch (e) { return []; }
};

function evaluateCheck(check, metrics) {
    if (check.type === 'process') {
        const target = String(check.target || '').toLowerCase();
        const pr = metrics && Array.isArray(metrics.processes) ? metrics.processes.find(x => String(x.name).toLowerCase() === target) : null;
        if (!pr || String(pr.status).toLowerCase() !== 'running') return { exceeded: true, value: 'stopped' };
        if (check.cpuThreshold !== null && check.cpuThreshold !== undefined && pr.cpuUsage >= check.cpuThreshold) {
            return { exceeded: true, value: `CPU: ${Number(pr.cpuUsage).toFixed(1)}%` };
        }
        if (check.memThreshold !== null && check.memThreshold !== undefined && pr.memoryMB >= check.memThreshold) {
            return { exceeded: true, value: `Memory: ${Number(pr.memoryMB).toFixed(1)}MB` };
        }
        return { exceeded: false, value: 'running' };
    }
    const value = extractValueFromMetrics(check.type, check.target, metrics);
    if (value === null) return null;
    return { exceeded: isExceeded(value, check.threshold, check.type), value };
}

function buildBindingIndex(bindings) {
    const idx = { monitor: new Map(), apikey: new Map(), tag: new Map(), env: new Map(), global: [] };
    for (const b of bindings || []) {
        if (b.scopeType === 'all' || b.scopeType === 'global') { idx.global.push(b.ruleId); continue; }
        const map = idx[b.scopeType];
        if (!map) continue;
        const key = String(b.scopeValue);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(b.ruleId);
    }
    return idx;
}

function applicableRuleIds(idx, monitor, { includeGlobal = false } = {}) {
    const out = new Set();
    const add = (list) => { for (const id of list || []) out.add(id); };
    add(idx.monitor.get(String(monitor.id)));
    if (monitor.apiKey) add(idx.apikey.get(String(monitor.apiKey)));
    for (const t of parseTags(monitor.tags)) add(idx.tag.get(String(t)));
    if (monitor.envId != null) add(idx.env.get(String(monitor.envId)));
    if (includeGlobal) add(idx.global);
    return [...out];
}

module.exports = { extractValueFromMetrics, isExceeded, evaluateCheck, buildBindingIndex, applicableRuleIds, parseTags };
