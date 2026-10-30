// Pure helpers for the Server List delete confirmation (no React, no network).

export const COLLAPSE_AFTER = 5; // more IPs than this -> summary table instead of per-IP cards

export const EMPTY_CLEANUP = Object.freeze({ prometheus: false, scoutHistory: false, ruleBindings: false });

/** null / undefined means "unknown" (the backend refuses to full-scan unindexed tables). */
export const COUNT_CAP = 100000; // the backend caps counts at COUNT_CAP + 1

export function formatCount(n) {
    if (n === null || n === undefined) return 'unknown';
    if (Number(n) > COUNT_CAP) return '> 100,000';
    return Number(n).toLocaleString('en-US');
}

function sumKnown(values) {
    if (values.some(v => v === null || v === undefined)) return null;
    return values.reduce((a, b) => a + (Number(b) || 0), 0);
}

/** Totals across all previewed servers; a total is null (unknown) when any server's count is unknown. */
export function aggregatePreviews(previews) {
    const list = Array.isArray(previews) ? previews : [];
    return {
        servers: list.length,
        existing: list.filter(p => p.exists).length,
        linkedVips: list.flatMap(p => (p.linkedVips || []).map(v => ({ ...v, primary: p.ip }))),
        monitors: list.reduce((a, p) => a + (p.scout?.monitors?.length || 0), 0),
        prometheusTargets: list.reduce((a, p) => a + (p.prometheusTargets?.length || 0), 0),
        metricRows: sumKnown(list.map(p => p.scout?.metricRows ?? null)),
        alertRows: sumKnown(list.map(p => p.scout?.alertRows ?? null)),
        eventRows: sumKnown(list.map(p => p.scout?.eventRows ?? null)),
        logRows: sumKnown(list.map(p => p.scout?.logRows ?? null)),
        ruleBindings: list.reduce((a, p) => a + (p.ruleBindings?.length || 0), 0),
        maintenanceWindows: list.reduce((a, p) => a + (p.maintenanceWindows?.length || 0), 0),
        ruleExclusions: list.reduce((a, p) => a + (p.ruleExclusions?.length || 0), 0)
    };
}

export function prometheusLabel(totals) {
    return `Remove from Prometheus targets (${formatCount(totals.prometheusTargets)} targets)`;
}

export function scoutHistoryLabel(totals) {
    // Events / logs are only part of the cleanup (and the label) when their count is known, i.e. a host index exists
    const extra = [];
    if (totals.eventRows !== null) extra.push(`events ${formatCount(totals.eventRows)}`);
    if (totals.logRows !== null) extra.push(`logs ${formatCount(totals.logRows)}`);
    return `Delete Scout history (≈ metrics ${formatCount(totals.metricRows)} rows, alerts ${formatCount(totals.alertRows)}${extra.length ? ', ' + extra.join(', ') : ''})`;
}

export const SCOUT_HISTORY_DETAIL = 'Deletes metrics, alerts, alert state, notification state, remediation logs and forensic tasks/reports. Runs in the background after the server is deleted; large histories can take a while.';

export const PERMANENT_NOTE = 'Optional cleanups are permanent — Restore does not bring them back.';

/** Not-affected line for Windows events / Linux logs when the backend cannot delete them (count unknown). */
export function logsNotDeletedNote(totals) {
    const names = [];
    if (totals.eventRows === null) names.push('Windows events');
    if (totals.logRows === null) names.push('Linux logs');
    return names.length ? `${names.join(' / ')}: NOT deleted (no host index; removed by log rotation)` : '';
}

/** The IPs a delete will actually act on: IPs the preview says are not in Server List are left out. */
export function deletableIps(ips, previews, previewOk) {
    if (!previewOk || !Array.isArray(previews) || previews.length === 0) return ips;
    const missing = new Set(previews.filter(p => p.exists === false).map(p => p.ip));
    return ips.filter(ip => !missing.has(ip));
}

/** Names of cleanups that failed according to a delete response ({ cleaned: { prometheusError, ruleBindingsError } }). */
export function cleanupFailures(data) {
    const c = (data && data.cleaned) || {};
    const out = [];
    if (c.prometheusError) out.push(`Prometheus targets (${c.prometheusError})`);
    if (c.ruleBindingsError) out.push(`rule bindings & maintenance windows (${c.ruleBindingsError})`);
    return out;
}

export function ruleBindingsLabel(totals) {
    // Host exclusions ("Excluded hosts" of alert rules) are removed with the host whether or not this box is ticked
    const ex = totals.ruleExclusions ? `; ${formatCount(totals.ruleExclusions)} rule exclusion(s) are always removed with the host` : '';
    return `Remove alert rule bindings & maintenance windows for this host (${formatCount(totals.ruleBindings)} bindings, ${formatCount(totals.maintenanceWindows)} windows${ex})`;
}

// --- Server Inventory variant (same modal, inventory / IPAM extras) -------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days a host has been offline (offlineSince, legacy rows: lastSeen / lastChecked); null when unknown or not offline. */
export function offlineDaysOf(host, now = Date.now()) {
    if (!host || host.status !== 'offline') return null;
    const t = new Date(host.offlineSince || host.lastSeen || '').getTime();
    if (!Number.isFinite(t)) return null;
    return Math.max(0, (now - t) / DAY_MS);
}

/**
 * Whether the inventory row shows DELETE & RELEASE IP: only offline hosts. Operators need offline >= thresholdDays;
 * SuperAdmin also sees it for offline hosts below the threshold (the modal then offers force). Never for online hosts.
 */
export function showInventoryDeleteButton(host, role, thresholdDays, now = Date.now()) {
    if (!['SuperAdmin', 'Operator'].includes(role)) return false;
    if (!host || host.status !== 'offline') return false;
    if (role === 'SuperAdmin') return true;
    const days = offlineDaysOf(host, now);
    return days !== null && days >= thresholdDays;
}

/** Inventory / IPAM lines of every preview, flattened: [{ ip, line }]. */
export function collectExtraLines(previews) {
    return (Array.isArray(previews) ? previews : []).flatMap(p => (p.lines || []).map(line => ({ ip: p.ip, line })));
}

/** Hosts the server-side offline guard would refuse: [{ ip, reason }]. */
export function blockedByGuard(previews) {
    return (Array.isArray(previews) ? previews : [])
        .filter(p => p.inventory && p.inventory.blocked)
        .map(p => ({ ip: p.ip, reason: p.inventory.blockedReason || 'Not offline long enough' }));
}

/** Force is offered to SuperAdmin only, and only when the guard blocks (or the server just refused with OFFLINE_GUARD). */
export function canOfferForce({ role, blocked, refused }) {
    return role === 'SuperAdmin' && ((Array.isArray(blocked) && blocked.length > 0) || refused === true);
}

function cleanupBody(cleanup, previewOk) {
    const c = {};
    if (previewOk) for (const k of ['prometheus', 'scoutHistory', 'ruleBindings']) if (cleanup && cleanup[k] === true) c[k] = true;
    return Object.keys(c).length > 0 ? { cleanup: c } : {};
}

/** Single host: DELETE /inventory/server/:ip { cleanup?, force? }; bulk (days): POST /inventory/bulk-delete-offline. */
export function buildInventoryDeleteRequest({ ips, cleanup, previewOk, force, bulkDays }) {
    const body = cleanupBody(cleanup, previewOk);
    if (bulkDays) {
        return { method: 'post', url: '/inventory/bulk-delete-offline', data: { days: bulkDays, dryRun: false, ips, ...body } };
    }
    const data = { ...body };
    if (force === true) data.force = true;
    return { method: 'delete', url: `/inventory/server/${encodeURIComponent(ips[0])}`, data };
}

export function deleteButtonLabel(count) {
    return `Delete ${count} ${count === 1 ? 'server' : 'servers'}`;
}

/**
 * Request for the delete call. cleanup is only sent when the preview loaded
 * (on preview failure the cleanup boxes are disabled and a plain delete is performed).
 */
export function buildDeleteRequest({ ips, cleanup, previewOk }) {
    const body = {};
    if (previewOk) {
        const c = {};
        for (const k of ['prometheus', 'scoutHistory', 'ruleBindings']) if (cleanup && cleanup[k] === true) c[k] = true;
        if (Object.keys(c).length > 0) body.cleanup = c;
    }
    if (ips.length === 1) {
        return { method: 'delete', url: `/server-list/${encodeURIComponent(ips[0])}`, data: body };
    }
    return { method: 'post', url: '/server-list/bulk-delete', data: { ips, ...body } };
}
