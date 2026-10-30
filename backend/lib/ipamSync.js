const { auditLog } = require('./logger');
// New subnets / IPs get the isDefault environment (id + name), never a hard-coded name
const { defaultEnvFields } = require('./environmentRegistry');
const core = require('./ipamCore');
const ipamStore = require('./ipamStore');

// One read of the environment list per sync run: the first call loads it, later calls reuse it
function envFieldsOnce() {
    let cached = null;
    return () => (cached || (cached = defaultEnvFields()));
}

// assignedTo values written by system syncs: such IPs may be freed by any system source
const SYSTEM_SOURCES = ['Network Device', 'Server Rack'];

/**
 * Applies one use / free action to `subnets` (in place). Returns { changed, created (subnet|null), skipped }.
 * use: the most specific subnet (longest prefix); none -> a /24 is auto-created for private IPs only,
 * public IPs are skipped. A missing IP object inside the CIDR (legacy /16) is materialised.
 */
function applyAction(subnets, actionData, envF) {
    const { ip, hostname, action = 'use', source = 'Network Device' } = actionData;
    const out = { changed: false, created: null, skipped: false };
    if (!ip) return out;
    const addr = String(ip).trim();
    let subnet = core.findSubnetForIp(subnets, addr);

    if (action === 'use') {
        if (!subnet) {
            subnet = core.autoCreateSubnetFor(addr, envF());
            if (!subnet) { out.skipped = true; return out; }
            subnets.push(subnet);
            out.created = subnet;
            out.changed = true;
        }
        const entry = core.ensureIpEntry(subnet, addr);
        if (!entry) { out.skipped = true; return out; }
        entry.status = 'used';
        entry.hostname = hostname || '';
        entry.assignedTo = source;
        entry.updatedAt = new Date().toISOString();
        out.changed = true;
    } else if (action === 'free') {
        const entry = subnet && Array.isArray(subnet.ips) ? subnet.ips.find(i => i.address === addr) : null;
        // Allow freeing if it was assigned by Network Device or Server Rack (source)
        if (entry && (SYSTEM_SOURCES.includes(entry.assignedTo) || entry.assignedTo === source)) {
            entry.status = 'free';
            entry.hostname = '';
            entry.assignedTo = '';
            entry.updatedAt = new Date().toISOString();
            out.changed = true;
        }
    }
    return out;
}

function auditCreated(created, username, source) {
    for (const s of created) auditLog(username, 'IPAM', `Auto-created Subnet: ${s.name} (${s.cidr}) from ${source}`);
}

/** Returns { changed, created, skipped } ({ changed: false } on error). */
function syncIpToIpam(ip, hostname, username, action = 'use', source = 'Network Device') {
    if (!ip) return { changed: false, created: 0, skipped: 0 };
    const envF = envFieldsOnce();
    try {
        const res = ipamStore.mutateSubnets((subnets) => applyAction(subnets, { ip, hostname, action, source }, envF),
            { username, reason: `sync ${action} ${ip}` });
        if (res.created) auditCreated([res.created], username, source);
        return { changed: res.changed, created: res.created ? 1 : 0, skipped: res.skipped ? 1 : 0 };
    } catch (e) {
        console.error('Failed to sync IPAM', e);
        return { changed: false, created: 0, skipped: 0 };
    }
}

/** actions: [{ ip, hostname, username, action, source }]. Returns { changed, created, skipped }. */
function batchSyncIpsToIpam(actions) {
    if (!actions || actions.length === 0) return { changed: false, created: 0, skipped: 0 };
    const envF = envFieldsOnce();
    try {
        const res = ipamStore.mutateSubnets((subnets) => {
            const r = { changed: false, created: [], skipped: 0 };
            for (const a of actions) {
                const one = applyAction(subnets, a || {}, envF);
                if (one.changed) r.changed = true;
                if (one.created) r.created.push({ subnet: one.created, username: a.username, source: a.source || 'Network Device' });
                if (one.skipped) r.skipped++;
            }
            return r;
        }, { reason: 'batch sync' });
        for (const c of res.created) auditCreated([c.subnet], c.username, c.source);
        return { changed: res.changed, created: res.created.length, skipped: res.skipped };
    } catch (e) {
        console.error('Failed to batch sync IPAM', e);
        return { changed: false, created: 0, skipped: 0 };
    }
}

const splitFqdns = (v) => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
const cleanZone = (z) => String(z || '').trim().toLowerCase().replace(/\.$/, '');

/** Does fqdn belong to one of the zones (equals the zone or ends with ".<zone>")? */
function inZones(fqdn, zones) {
    const f = cleanZone(fqdn);
    return zones.some(z => f === z || f.endsWith(`.${z}`));
}

/**
 * DNS -> IPAM FQDN sync.
 * records: [{ ip, fqdn }]. opts.zones: zone names that were fetched successfully.
 * - An IP present in the records gets the record FQDNs, plus its current FQDNs that do not belong to a listed zone
 *   (without opts.zones every current FQDN is kept: only additions).
 * - An IP absent from the records loses only the FQDNs of the listed zones; its fqdn is cleared when ALL its
 *   FQDNs belong to listed zones. Without opts.zones nothing is ever cleared.
 * - IPs without a subnet: a /24 is auto-created for private IPs only; public IPs are skipped (counted).
 * Returns { updated, cleared, skipped }.
 */
async function syncDnsToIpam(records, username, opts = {}) {
    if (!records || !Array.isArray(records)) return { updated: 0, cleared: 0, skipped: 0 };
    const zones = Array.isArray(opts.zones) ? opts.zones.map(cleanZone).filter(Boolean) : [];

    const fqdnByIp = new Map();
    for (const record of records) {
        if (!record || !record.ip || !record.fqdn) continue;
        const ipStr = String(record.ip).trim();
        const fqdnStr = String(record.fqdn).trim();
        if (!ipStr || !fqdnStr) continue;
        if (!fqdnByIp.has(ipStr)) fqdnByIp.set(ipStr, new Set());
        fqdnByIp.get(ipStr).add(fqdnStr);
    }

    const envF = envFieldsOnce();
    const res = ipamStore.mutateSubnets((subnets) => {
        const r = { updated: 0, cleared: 0, skipped: 0, created: [] };
        const now = new Date().toISOString();
        const seen = new Set();

        for (const [ipStr, set] of fqdnByIp) {
            let subnet = core.findSubnetForIp(subnets, ipStr);
            if (!subnet) {
                subnet = core.autoCreateSubnetFor(ipStr, envF());
                if (!subnet) { r.skipped++; continue; }
                subnets.push(subnet);
                r.created.push(subnet);
            }
            const entry = core.ensureIpEntry(subnet, ipStr);
            if (!entry) { r.skipped++; continue; }
            seen.add(entry);
            const kept = splitFqdns(entry.fqdn).filter(f => !zones.length || !inZones(f, zones));
            const newFqdn = [...new Set([...set, ...kept])].sort().join(',');
            if ((entry.fqdn || '') !== newFqdn) {
                entry.fqdn = newFqdn;
                entry.updatedAt = now;
                r.updated++;
            }
        }

        if (zones.length) {
            for (const subnet of subnets) {
                for (const entry of arr(subnet && subnet.ips)) {
                    if (!entry || seen.has(entry) || !entry.fqdn) continue;
                    const current = splitFqdns(entry.fqdn);
                    const kept = current.filter(f => !inZones(f, zones));
                    if (kept.length === current.length) continue;
                    entry.fqdn = kept.join(',');
                    entry.updatedAt = now;
                    if (kept.length === 0) r.cleared++;
                    else r.updated++;
                }
            }
        }
        return r;
    }, { username, reason: 'DNS sync' });

    for (const s of res.created) auditLog(username, 'IPAM', `Auto-created Subnet: ${s.name} (${s.cidr}) from DNS Sync`);
    if (res.updated > 0 || res.cleared > 0) {
        auditLog(username, 'IPAM', `DNS Sync: Updated ${res.updated} FQDNs, Cleared ${res.cleared} FQDNs${res.skipped ? `, Skipped ${res.skipped} IPs without a private subnet` : ''}`);
    } else {
        auditLog(username, 'IPAM', `DNS Sync: Received ${records.length} records, no changes needed${res.skipped ? ` (${res.skipped} IPs skipped)` : ''}`);
    }
    return { updated: res.updated, cleared: res.cleared, skipped: res.skipped };
}

function arr(v) { return Array.isArray(v) ? v : []; }

module.exports = {
    syncIpToIpam,
    batchSyncIpsToIpam,
    ipInCidr: core.ipInCidr,
    syncDnsToIpam,
    SYSTEM_SOURCES
};
