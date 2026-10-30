/**
 * Server List delete support: preview of what a delete touches, optional cleanup of
 * Prometheus targets / Scout history / alert rule bindings, and the deleted-server list.
 *
 * Count exactness (scout.sqlite can be ~20 GB, so no full scans):
 *   - metrics        exact: idx_metrics_monId (monitorId)
 *   - alerts         exact only when an index with leading column monitorId exists (idx_alerts_monId, created by
 *                    the worker ~5 min after start, see ensureAlertsMonitorIndex), otherwise null ("unknown")
 *   - windows_events exact only when an index on `host` exists, otherwise null ("unknown")
 *   - linux_logs     exact only when an index on `host` exists, otherwise null ("unknown")
 *   host = the monitor NAME (routes/monitor.js effectiveHost), not the monitor id.
 *   Every count is capped at COUNT_CAP + 1 (100,001) so a huge history never makes the preview slow.
 *   Cleanup follows the same rule for windows_events / linux_logs: rows are only deleted when the host
 *   index exists; otherwise they are skipped (reported as skippedUnindexed).
 *   remediation_logs / forensic_tasks / forensic_reports (small, keyed by monitorId, unindexed) are
 *   always cleaned by cleanup.scoutHistory but are not part of the preview counts.
 */
const scoutDb = require('./scoutDb');
const { readDataSync, writeDataSync } = require('../lib/db');
const cmdbMetaStore = require('../lib/cmdbMetaStore');
const { getTargetsSafely, updateTargetsSafely } = require('../lib/prometheusTargetHelper');
const { removeIpFromPrometheusTargets } = require('../lib/vipLinkageHelper');
const { getCmdbServerByIp } = require('./cmdbModel');
const { parseList } = require('./maintenanceWindows');
const { auditLog } = require('../lib/logger');

const CMDB_META_KEY = 'server_operation/server_cmdb_meta.json';
const MIGRATION_MARKER_KEY = 'system/cmdb_deleted_flag_migration.json';
const CHUNK = 400;
const HISTORY_BATCH = 1000;
const HISTORY_PAUSE_MS = 20;
const COUNT_CAP = 100000;

const pendingJobs = new Set();

function chunks(arr, size = CHUNK) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

const marks = (n) => new Array(n).fill('?').join(',');

function normalizeIps(ips) {
    const seen = new Set();
    for (const raw of Array.isArray(ips) ? ips : []) {
        const ip = String(raw == null ? '' : raw).trim();
        if (ip) seen.add(ip);
    }
    return [...seen];
}

function readMeta() {
    const meta = readDataSync(CMDB_META_KEY, {});
    return meta && typeof meta === 'object' ? meta : {};
}

function isLinkedVipMeta(m) {
    return !!(m && (m.linkedTo || m.vipOf || m.isVip));
}

/** Does this IP exist in Server List (a cmdb row, or a non-deleted meta entry)? */
function serverExists(ip, meta = readMeta()) {
    return !!getCmdbServerByIp(ip) || !!(meta[ip] && meta[ip].deleted !== true);
}

/** Linked VIPs of a primary: cmdb_servers.linkedToIp rows plus the secondary IPs recorded in its meta. */
function getLinkedVips(ip, meta = readMeta()) {
    const map = new Map();
    try {
        const { db } = require('../lib/db');
        if (db) {
            for (const r of db.prepare('SELECT ip, hostname FROM cmdb_servers WHERE linkedToIp = ?').all(ip)) {
                map.set(String(r.ip).trim(), r.hostname || '');
            }
        }
    } catch (e) { /* cmdb table unavailable: fall back to meta only */ }
    const m = meta[ip] || {};
    for (const list of [m.secondaryIps, m.vips]) {
        for (const v of Array.isArray(list) ? list : []) {
            const vip = String(v).trim();
            if (vip && vip !== ip && !map.has(vip)) map.set(vip, (meta[vip] && meta[vip].hostname) || '');
        }
    }
    return [...map.entries()].map(([vip, hostname]) => ({ ip: vip, hostname }));
}

function getMonitorsByIps(ips) {
    const out = [];
    for (const part of chunks(ips)) {
        out.push(...(scoutDb.all(`SELECT id, name, ip FROM monitors WHERE ip IN (${marks(part.length)})`, part) || []));
    }
    return out;
}

/** True when `column` is the leading column of an index on `table` (SQLite only). */
function hasIndexOn(table, column) {
    try {
        const list = scoutDb.all(`PRAGMA index_list(${table})`) || [];
        for (const idx of list) {
            const cols = scoutDb.all(`PRAGMA index_info(${String(idx.name).replace(/[^A-Za-z0-9_]/g, '')})`) || [];
            const first = cols.find(c => c.seqno === 0) || cols[0];
            if (first && String(first.name).toLowerCase() === column.toLowerCase()) return true;
        }
    } catch (e) { /* not SQLite or table missing */ }
    return false;
}

/** COUNT of rows with column IN (values), capped at COUNT_CAP + 1 so it never scans more than that per chunk. */
function countIn(table, column, values) {
    let total = 0;
    for (const part of chunks(values)) {
        const row = scoutDb.get(`SELECT COUNT(*) AS c FROM (SELECT 1 FROM ${table} WHERE ${column} IN (${marks(part.length)}) LIMIT ${COUNT_CAP + 1})`, part);
        total += (row && row.c) || 0;
        if (total > COUNT_CAP) return COUNT_CAP + 1;
    }
    return total;
}

function targetEndpoint(t) {
    return (Array.isArray(t.targets) && t.targets[0]) || t.labels?.addr || t.ip || '';
}

/** Prometheus targets that mention any of the IPs (same matching rules as removeIpFromPrometheusTargets). */
function findPrometheusTargets(targets, ips) {
    const found = [];
    for (const t of targets) {
        const hit = ips.some(ip => {
            const clone = JSON.parse(JSON.stringify(t));
            return removeIpFromPrometheusTargets([clone], ip).removedCount > 0;
        });
        if (hit) found.push({ target: targetEndpoint(t), labels: t.labels || {} });
    }
    return found;
}

/** Windows scoped only to monitors, every one of which is in monitorIds (the whole selection). */
function exclusiveWindows(monitorIds) {
    const idSet = new Set(monitorIds.map(String));
    if (idSet.size === 0) return [];
    const rows = scoutDb.all("SELECT id, name, scopeValues FROM maintenance_windows WHERE scopeType = 'monitors'") || [];
    return rows.filter(w => {
        const vals = parseList(w.scopeValues).map(String);
        return vals.length > 0 && vals.every(v => idSet.has(v));
    });
}

function getBindings(monitorIds) {
    const out = [];
    for (const part of chunks(monitorIds)) {
        out.push(...(scoutDb.all(
            `SELECT b.id, b.ruleId, r.name AS ruleName FROM rule_bindings b LEFT JOIN rules r ON r.id = b.ruleId
             WHERE b.scopeType = 'monitor' AND b.scopeValue IN (${marks(part.length)})`, part) || []));
    }
    return out;
}

async function previewDelete(ips) {
    const list = normalizeIps(ips);
    const meta = readMeta();
    let allTargets = [];
    try { allTargets = getTargetsSafely(); } catch (e) { /* preview still works without targets */ }
    const alertsIndexed = hasIndexOn('alerts', 'monitorId');
    const eventsIndexed = hasIndexOn('windows_events', 'host');
    const logsIndexed = hasIndexOn('linux_logs', 'host');

    // Monitors / exclusive windows are resolved over the WHOLE selection: a window shared by two selected
    // hosts is exclusive to the selection and is listed once (under the first host it covers).
    const monitorsByIp = new Map(list.map(ip => [ip, getMonitorsByIps([ip])]));
    const allIds = [...monitorsByIp.values()].flat().map(m => m.id);
    const windowOwner = new Map();
    for (const w of exclusiveWindows(allIds)) {
        const vals = new Set(parseList(w.scopeValues).map(String));
        const owner = list.find(ip => monitorsByIp.get(ip).some(m => vals.has(String(m.id))));
        if (owner) {
            if (!windowOwner.has(owner)) windowOwner.set(owner, []);
            windowOwner.get(owner).push(w);
        }
    }

    const out = [];
    for (const ip of list) {
        if (out.length > 0) await new Promise(r => setImmediate(r)); // keep the event loop responsive on big selections
        const row = getCmdbServerByIp(ip);
        const exists = !!row || !!(meta[ip] && meta[ip].deleted !== true);
        const linkedVips = exists ? getLinkedVips(ip, meta) : [];
        const monitors = monitorsByIp.get(ip);
        const ids = monitors.map(m => m.id);
        const names = monitors.map(m => m.name).filter(Boolean);
        out.push({
            ip,
            hostname: (row && row.hostname) || (meta[ip] && meta[ip].hostname) || '',
            exists,
            linkedVips,
            scout: {
                monitors: monitors.map(m => ({ id: m.id, name: m.name })),
                metricRows: ids.length ? countIn('metrics', 'monitorId', ids) : 0,
                alertRows: ids.length === 0 ? 0 : (alertsIndexed ? countIn('alerts', 'monitorId', ids) : null),
                eventRows: names.length === 0 ? 0 : (eventsIndexed ? countIn('windows_events', 'host', names) : null),
                logRows: names.length === 0 ? 0 : (logsIndexed ? countIn('linux_logs', 'host', names) : null)
            },
            prometheusTargets: exists ? findPrometheusTargets(allTargets, [ip, ...linkedVips.map(v => v.ip)]) : [],
            ruleBindings: getBindings(ids).map(b => ({ ruleId: b.ruleId, ruleName: b.ruleName || '' })),
            ruleExclusions: require('./ruleExclusions').listForMonitors(ids).map(e => ({ ruleId: e.ruleId, ruleName: e.ruleName || '' })),
            maintenanceWindows: (windowOwner.get(ip) || []).map(w => ({ id: w.id, name: w.name }))
        });
    }
    return out;
}

/** Removes the IPs from the Prometheus targets inside the helper's write lock (no lost updates). */
async function removeFromPrometheus(ips) {
    const { result } = await updateTargetsSafely((current) => {
        let targets = current;
        let removed = 0;
        for (const ip of ips) {
            const res = removeIpFromPrometheusTargets(targets, ip);
            targets = res.targets;
            removed += res.removedCount;
        }
        return removed > 0 ? { targets, result: removed } : { result: 0 };
    }, 'server_delete');
    return result || 0;
}

/** monitorIds = every monitor of the whole selection (so a window shared by selected hosts is removed). */
function removeRuleScoped(monitorIds) {
    let bindings = 0;
    let windows = 0;
    if (monitorIds.length === 0) return { bindings, windows };
    for (const part of chunks(monitorIds)) {
        const res = scoutDb.run(`DELETE FROM rule_bindings WHERE scopeType = 'monitor' AND scopeValue IN (${marks(part.length)})`, part);
        bindings += (res && res.changes) || 0;
    }
    for (const w of exclusiveWindows(monitorIds)) {
        const res = scoutDb.run('DELETE FROM maintenance_windows WHERE id = ?', [w.id]);
        windows += (res && res.changes) || 0;
    }
    try { require('./scoutAlertEngine').invalidateRuleCache(); } catch (e) { /* engine not loaded */ }
    try { require('./alertPolicyStore').invalidateWindows(); } catch (e) { /* store not loaded */ }
    return { bindings, windows };
}

async function deleteBatched(table, where, params, batchSize, pauseMs) {
    let total = 0;
    for (;;) {
        const res = scoutDb.run(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${batchSize})`, params);
        const n = (res && res.changes) || 0;
        total += n;
        if (n < batchSize) break;
        await new Promise(r => setTimeout(r, pauseMs));
    }
    return total;
}

/** Deletes Scout history for the given monitors in batches, pausing between batches. */
async function cleanupScoutHistory(monitors, { batchSize = HISTORY_BATCH, pauseMs = HISTORY_PAUSE_MS } = {}) {
    const totals = { metrics: 0, alerts: 0, alertState: 0, notifyState: 0, events: 0, logs: 0, remediationLogs: 0, forensic: 0, skippedUnindexed: [] };
    const eventsIndexed = hasIndexOn('windows_events', 'host');
    const logsIndexed = hasIndexOn('linux_logs', 'host');
    for (const m of monitors) {
        const id = m.id;
        totals.metrics += await deleteBatched('metrics', 'monitorId = ?', [id], batchSize, pauseMs);
        totals.alerts += await deleteBatched('alerts', 'monitorId = ?', [id], batchSize, pauseMs);
        // Keys are `${monitorId}-${ruleId}`, `log-${monitorId}-${ruleId}` (alert_state) and `${monitorId}|${ruleId}` (notify_state)
        const a1 = `${id}-`, a2 = `log-${id}-`, n1 = `${id}|`;
        let r = scoutDb.run('DELETE FROM alert_state WHERE substr(stateKey, 1, ?) = ? OR substr(stateKey, 1, ?) = ?', [a1.length, a1, a2.length, a2]);
        totals.alertState += (r && r.changes) || 0;
        r = scoutDb.run('DELETE FROM notify_state WHERE substr(stateKey, 1, ?) = ?', [n1.length, n1]);
        totals.notifyState += (r && r.changes) || 0;
        totals.remediationLogs += await deleteBatched('remediation_logs', 'monitorId = ?', [id], batchSize, pauseMs);
        totals.forensic += await deleteBatched('forensic_reports', 'monitorId = ?', [id], batchSize, pauseMs);
        totals.forensic += await deleteBatched('forensic_tasks', 'monitorId = ?', [id], batchSize, pauseMs);
        if (m.name) {
            if (eventsIndexed) totals.events += await deleteBatched('windows_events', 'host = ?', [m.name], batchSize, pauseMs);
            if (logsIndexed) totals.logs += await deleteBatched('linux_logs', 'host = ?', [m.name], batchSize, pauseMs);
        }
    }
    if (!eventsIndexed) totals.skippedUnindexed.push('windows_events');
    if (!logsIndexed) totals.skippedUnindexed.push('linux_logs');
    return totals;
}

const describeMonitors = (monitors) => monitors.map(m => `${m.id} (${m.name || '-'})`).join(', ');

/**
 * Runs the history cleanup after the HTTP response (the first batch only starts on setImmediate); tracked so
 * tests / shutdown can await it. Start / done / failure are audit-logged with the monitor ids + names, so a job
 * interrupted by a restart can be finished by hand.
 */
function startScoutHistoryCleanup(monitors, username, opts = {}) {
    const job = new Promise(resolve => setImmediate(resolve)).then(async () => {
        const who = describeMonitors(monitors);
        try {
            auditLog(username || 'SYSTEM', 'Server List CMDB', `Scout history cleanup started for ${monitors.length} monitor(s): ${who}`);
            const totals = await cleanupScoutHistory(monitors, opts);
            const msg = `Scout history cleanup finished for ${monitors.length} monitor(s) [${who}]: metrics ${totals.metrics}, alerts ${totals.alerts}, alert_state ${totals.alertState}, notify_state ${totals.notifyState}, events ${totals.events}, logs ${totals.logs}, remediation_logs ${totals.remediationLogs}, forensic ${totals.forensic}` +
                (totals.skippedUnindexed.length ? `; skipped (no host index): ${totals.skippedUnindexed.join(', ')}` : '');
            console.log(`[ServerList Delete] ${msg}`);
            auditLog(username || 'SYSTEM', 'Server List CMDB', msg);
            return totals;
        } catch (e) {
            console.error('[ServerList Delete] Scout history cleanup failed:', e.message);
            auditLog(username || 'SYSTEM', 'Server List CMDB', `Scout history cleanup FAILED for [${who}]: ${e.message}`);
            return null;
        } finally {
            pendingJobs.delete(job);
        }
    });
    pendingJobs.add(job);
    return job;
}

function whenCleanupIdle() {
    return Promise.all([...pendingJobs]);
}

/**
 * Creates idx_alerts_monId (used by the delete preview). Called by the WORKER a few minutes after start,
 * never at web startup, so it cannot delay app.listen. Returns { created, ms } or { error }.
 */
function ensureAlertsMonitorIndex() {
    const t0 = Date.now();
    try {
        if (hasIndexOn('alerts', 'monitorId')) return { created: false, ms: 0 };
        scoutDb.run('CREATE INDEX IF NOT EXISTS idx_alerts_monId ON alerts(monitorId)');
        const ms = Date.now() - t0;
        console.log(`[Worker] Created idx_alerts_monId in ${ms} ms`);
        return { created: true, ms };
    } catch (e) {
        console.error('[Worker] idx_alerts_monId creation failed:', e.message);
        return { error: e.message };
    }
}

function scheduleAlertsMonitorIndex(delayMs = 5 * 60 * 1000) {
    const t = setTimeout(() => { ensureAlertsMonitorIndex(); }, delayMs);
    if (t.unref) t.unref();
    return t;
}

/**
 * One-time startup migration. Before this feature nothing read cmdbMeta[ip].deleted, so servers that were
 * "deleted" were re-created by the syncs and still show in Server List. Those carry a deleted flag AND a
 * cmdb_servers row: clear the flag so they do not freeze. Truly deleted servers (no row) and linked VIPs stay.
 * Idempotent via a document_store marker; never throws.
 */
function migrateResurrectedDeletedFlags() {
    try {
        if (readDataSync(MIGRATION_MARKER_KEY, null)) return { skipped: true, cleared: 0, ips: [] };
        // atomic read-modify-write of the CURRENT meta; fn keeps its outputs in its return value
        const cleared = cmdbMetaStore.mutateMeta((meta) => {
            const out = [];
            for (const [ip, m] of Object.entries(meta)) {
                if (!m || m.deleted !== true || isLinkedVipMeta(m)) continue;
                const row = getCmdbServerByIp(ip);
                if (!row || row.linkedToIp || row.isSecondary) continue;
                const old = { ...m };
                m.deleted = false;
                m.restoredAt = new Date().toISOString();
                m.restoredBy = 'MIGRATION';
                delete m.deletedAt;
                delete m.deletedBy;
                out.push({ ip, old, entry: { ...m } });
            }
            return out;
        }, { reason: 'deleted-flag migration' });
        if (cleared.length > 0) {
            cmdbMetaStore.appendHistory(cleared.map(c => ({
                id: Date.now().toString() + '-' + Math.random().toString(36).substr(2, 4),
                ip: c.ip, username: 'MIGRATION', action: 'RESTORE', timestamp: new Date().toISOString(),
                oldData: c.old, newData: c.entry
            })), 500);
            const first = cleared.slice(0, 20).map(c => c.ip).join(', ');
            auditLog('MIGRATION', 'Server List CMDB', `Cleared stale deleted flag on ${cleared.length} server(s) still present in Server List: ${first}${cleared.length > 20 ? ', ...' : ''}`);
        }
        writeDataSync(MIGRATION_MARKER_KEY, { migratedAt: new Date().toISOString(), cleared: cleared.length });
        return { cleared: cleared.length, ips: cleared.map(c => c.ip) };
    } catch (e) {
        console.error('[ServerList] Deleted-flag migration failed:', e.message);
        return { error: e.message };
    }
}

module.exports = {
    normalizeIps,
    readMeta,
    isLinkedVipMeta,
    serverExists,
    getLinkedVips,
    getMonitorsByIps,
    previewDelete,
    removeFromPrometheus,
    removeRuleScoped,
    cleanupScoutHistory,
    startScoutHistoryCleanup,
    whenCleanupIdle,
    hasIndexOn,
    ensureAlertsMonitorIndex,
    scheduleAlertsMonitorIndex,
    migrateResurrectedDeletedFlags
};
