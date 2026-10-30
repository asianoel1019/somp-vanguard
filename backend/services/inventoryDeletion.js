/**
 * Server Inventory delete: ONE delete path. Server List state (deleted flag + deletedNames, CMDB row, Scout monitor,
 * cache invalidation, optional Prometheus / Scout history / rule binding cleanup) is handled by the shared
 * performServerDelete of routes/serverList; this module adds the guard (offline long enough), the inventory
 * row removal, the IPAM release (only records in status 'used'), previews and the bulk "offline > N days" delete.
 */
const inventoryStore = require('./inventoryStore');
const serverDeletion = require('./serverDeletion');
const { readDataSync } = require('../lib/db');
const ipamStore = require('../lib/ipamStore');
const logger = require('../lib/logger');

const IPAM_KEY = 'network_service/ipam/subnets.json';
const CONFIG_KEY = 'server_operation/oscheck/config.json';
const DEFAULT_OFFLINE_DELETE_DAYS = 7;
const MAX_BULK = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

function getOfflineDeleteDays(config = null) {
    let cfg = config;
    if (!cfg) { try { cfg = readDataSync(CONFIG_KEY, {}) || {}; } catch (e) { cfg = {}; } }
    const n = Number(cfg.offlineDeleteDays);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_OFFLINE_DELETE_DAYS;
}

function parseMs(v) {
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
}

/**
 * When the host went offline. offlineSince (set by a scan when the host is seen offline and it is still empty) first;
 * legacy rows without it fall back to lastSeen. lastChecked is NOT used (every scan refreshes it, so it would always look
 * fresh). null when nothing is known. Single place to refine (e.g. consecutive-miss logic) without touching the guard.
 */
function offlineSinceMs(host) {
    if (!host) return null;
    return parseMs(host.offlineSince) || parseMs(host.lastSeen);
}

/** Is the host currently offline for at least `days` days? */
function evaluateGuard(host, days, now = Date.now()) {
    if (!host) return { blocked: true, code: 'not_found', reason: 'Host not found in Server Inventory' };
    if (host.status !== 'offline') {
        return { blocked: true, code: 'not_offline', reason: `Host is ${host.status || 'in an unknown state'}, not offline` };
    }
    const since = offlineSinceMs(host);
    if (since === null) {
        return { blocked: true, code: 'unknown_offline_duration', reason: 'Offline duration is unknown (no timestamps recorded)' };
    }
    const offlineDays = (now - since) / DAY_MS;
    if (offlineDays < days) {
        return {
            blocked: true, code: 'not_offline_long_enough', offlineDays,
            reason: `Offline for ${offlineDays.toFixed(1)} days; at least ${days} days required`
        };
    }
    return { blocked: false, offlineDays };
}

function readIpam() {
    try {
        const subnets = readDataSync(IPAM_KEY, []);
        return Array.isArray(subnets) ? subnets : [];
    } catch (e) { return []; }
}

/** What an IPAM release would do for this IP: only status 'used' is released; reserved / vip / others are kept. */
function ipamPlan(ip, subnets) {
    for (const subnet of subnets) {
        if (!Array.isArray(subnet.ips)) continue;
        const entry = subnet.ips.find(i => String(i.address).trim() === ip);
        if (entry) {
            const status = entry.status || 'free';
            return { found: true, status, action: status === 'used' ? 'release' : (status === 'free' ? 'none' : 'keep'), cidr: subnet.cidr || '' };
        }
    }
    return { found: false, status: null, action: 'none', cidr: '' };
}

/** Server List delete preview + inventory / IPAM lines. Read-only. */
async function previewInventoryDelete(ips, { days, now = Date.now() } = {}) {
    const list = serverDeletion.normalizeIps(ips);
    const required = days || getOfflineDeleteDays();
    const base = await serverDeletion.previewDelete(list);
    const byIp = new Map(base.map(p => [p.ip, p]));
    const subnets = readIpam();
    return list.map(ip => {
        const p = byIp.get(ip) || { ip, hostname: '', exists: false, linkedVips: [], scout: { monitors: [] }, prometheusTargets: [], ruleBindings: [], ruleExclusions: [], maintenanceWindows: [] };
        const host = inventoryStore.getHost(ip);
        const guard = evaluateGuard(host, required, now);
        const ipam = ipamPlan(ip, subnets);
        const lines = [];
        lines.push(host ? 'Server Inventory: the host record will be removed' : 'Server Inventory: host not found');
        if (ipam.action === 'release') lines.push(`IPAM ${ip}${ipam.cidr ? ` (${ipam.cidr})` : ''}: status "used" will be released to "free" (hostname, owner and service cleared)`);
        else if (ipam.action === 'keep') lines.push(`IPAM ${ip}: status "${ipam.status}" is kept (only "used" records are released)`);
        else lines.push(ipam.found ? `IPAM ${ip}: already free, nothing to release` : `IPAM ${ip}: no record, nothing to release`);
        if (host && guard.blocked) lines.push(`Blocked: ${guard.reason}`);
        return {
            ...p,
            hostname: p.hostname || (host && host.hostname) || '',
            inventory: {
                exists: !!host,
                status: host ? (host.status || null) : null,
                offlineSince: host ? (host.offlineSince || null) : null,
                offlineDays: guard.offlineDays !== undefined ? Number(guard.offlineDays.toFixed(2)) : null,
                requiredDays: required,
                blocked: !!host && guard.blocked,
                blockedCode: host && guard.blocked ? guard.code : null,
                blockedReason: host && guard.blocked ? guard.reason : null
            },
            ipam: { found: ipam.found, status: ipam.status, action: ipam.action },
            lines
        };
    });
}

function releaseIpam(ips) {
    const out = { released: [], kept: [] };
    if (!ips.length) return out;
    const want = new Set(ips);
    // atomic read-modify-write of the IPAM document (shared with the worker); writes only when something changed
    return ipamStore.mutateSubnets((subnets) => {
        const r = { released: [], kept: [] };
        const now = new Date().toISOString();
        for (const subnet of subnets) {
            if (!Array.isArray(subnet.ips)) continue;
            for (const entry of subnet.ips) {
                const ip = String(entry.address).trim();
                if (!want.has(ip)) continue;
                if (entry.status === 'used') {
                    entry.status = 'free';
                    entry.hostname = '';
                    entry.fqdn = '';
                    entry.assignedTo = '';
                    entry.service = '';
                    entry.owner = '';
                    entry.updatedAt = now;
                    r.released.push(ip);
                } else if (entry.status && entry.status !== 'free') {
                    r.kept.push({ ip, status: entry.status });
                }
            }
        }
        return r;
    }, { reason: 'inventory delete release' });
}

/**
 * Deletes inventory hosts through the shared Server List delete, then releases IPAM ('used' only) and removes the
 * inventory rows. Hosts failing the offline guard are reported in `blocked` (not deleted) unless force is true
 * (callers allow force for SuperAdmin only). Never throws for blocked / missing hosts.
 */
async function deleteInventoryHosts(ips, { cleanup = {}, username = 'SYSTEM', force = false, historyAction = 'INVENTORY_DELETE', now = Date.now() } = {}) {
    const list = serverDeletion.normalizeIps(ips);
    const days = getOfflineDeleteDays();
    const result = {
        requested: list.length, deleted: [], blocked: [], missing: [],
        ipamReleased: [], ipamKept: [], serverList: 0, cleaned: {}, cleanupStarted: false, forced: []
    };
    const eligible = [];
    for (const ip of list) {
        const host = inventoryStore.getHost(ip);
        if (!host) { result.missing.push(ip); continue; }
        const guard = evaluateGuard(host, days, now);
        if (guard.blocked && !force) { result.blocked.push({ ip, code: guard.code, reason: guard.reason }); continue; }
        if (guard.blocked) result.forced.push({ ip, reason: guard.reason });
        eligible.push(ip);
    }
    if (!eligible.length) return result;

    // Shared Server List delete: deleted flag + deletedNames, cmdb row, Scout monitor, cache invalidation, cleanup flags
    const { performServerDelete } = require('../routes/serverList');
    const sl = await performServerDelete(eligible, cleanup || {}, username, historyAction);
    result.serverList = sl.count;
    result.cleaned = sl.cleaned || {};
    result.cleanupStarted = !!sl.historyJob;

    try {
        // NOTE: IPAM document read-modify-write is not atomic across web / worker processes (known, pre-existing; parked)
        const ipam = releaseIpam(eligible);
        result.ipamReleased = ipam.released;
        result.ipamKept = ipam.kept;
    } catch (e) {
        console.error('[InventoryDelete] IPAM release failed:', e.message);
        result.ipamError = e.message;
    }

    for (const ip of eligible) {
        if (inventoryStore.deleteHost(ip)) result.deleted.push(ip);
    }

    const what = result.deleted.length === 1 ? `server ${result.deleted[0]}` : `${result.deleted.length} servers`;
    const details = [
        `Server List: ${result.serverList}`,
        `IPAM released: ${result.ipamReleased.length}`,
        result.ipamKept.length ? `IPAM kept: ${result.ipamKept.map(k => `${k.ip}(${k.status})`).join(', ')}` : null,
        result.cleaned.prometheusTargets !== undefined ? `Prometheus targets removed: ${result.cleaned.prometheusTargets}` : null
    ].filter(Boolean).join('; ');
    if (result.forced.length) {
        logger.auditLog(username, 'Inventory', `FORCE deleted ${what} that did not meet the offline guard (${result.forced.map(f => `${f.ip}: ${f.reason}`).join(' | ')}) (${details})`);
    } else {
        logger.auditLog(username, 'Inventory', `Permanently deleted ${what} from Server Inventory (${details})`);
    }
    return result;
}

/**
 * Bulk delete of hosts offline for more than N days. The effective threshold is never below the configured
 * offlineDeleteDays (the same guard as a single delete, no force). dryRun returns the preview list only.
 * At most MAX_BULK hosts per request (longest offline first).
 */
async function bulkDeleteOffline({ days, dryRun = true, ips: confirmedIps = null, cleanup = {}, username = 'SYSTEM', now = Date.now() } = {}) {
    const requested = Number(days);
    if (!Number.isInteger(requested) || requested < 1 || requested > 3650) {
        const err = new Error('days must be a whole number between 1 and 3650');
        err.status = 400;
        throw err;
    }
    const effective = Math.max(requested, getOfflineDeleteDays());
    const candidates = [];
    for (const host of inventoryStore.getAllSubnetData()) {
        const g = evaluateGuard(host, effective, now);
        if (!g.blocked) candidates.push({ ip: host.ip, offlineDays: g.offlineDays });
    }
    candidates.sort((a, b) => b.offlineDays - a.offlineDays);
    const total = candidates.length;
    const ips = candidates.slice(0, MAX_BULK).map(c => c.ip);
    const base = { days: effective, requestedDays: requested, total, truncated: total > ips.length, max: MAX_BULK, ips };
    if (dryRun !== false) {
        return { dryRun: true, ...base, previews: await previewInventoryDelete(ips, { days: effective, now }) };
    }
    // The real run acts ONLY on the list the user confirmed (from the dry run), and only on those hosts that still pass
    // the guard now; everything else is reported in `skipped` with the reason.
    if (!Array.isArray(confirmedIps) || confirmedIps.length === 0) {
        const err = new Error('ips (the confirmed list from the dry run) is required');
        err.status = 400;
        throw err;
    }
    const confirmed = serverDeletion.normalizeIps(confirmedIps).slice(0, MAX_BULK);
    const eligible = new Set(candidates.map(c => c.ip));
    const toDelete = confirmed.filter(ip => eligible.has(ip));
    const skipped = confirmed.filter(ip => !eligible.has(ip)).map(ip => {
        const host = inventoryStore.getHost(ip);
        const g = evaluateGuard(host, effective, now);
        return { ip, reason: g.blocked ? g.reason : 'No longer selected' };
    });
    const empty = { deleted: [], blocked: [], missing: [], serverList: 0, ipamReleased: [], ipamKept: [], cleaned: {}, cleanupStarted: false, forced: [] };
    const res = toDelete.length
        ? await deleteInventoryHosts(toDelete, { cleanup, username, force: false, historyAction: 'INVENTORY_BULK_DELETE', now })
        : empty;
    return { dryRun: false, ...base, ...res, ips: confirmed, requested: confirmed.length, skipped };
}

module.exports = {
    MAX_BULK,
    DEFAULT_OFFLINE_DELETE_DAYS,
    getOfflineDeleteDays,
    offlineSinceMs,
    evaluateGuard,
    ipamPlan,
    previewInventoryDelete,
    deleteInventoryHosts,
    bulkDeleteOffline
};
