/**
 * Maps an inventory host (legacy host object from inventoryStore) to the input of cmdbModel.bulkUpsertCmdbServers.
 * Empty inventory values are never emitted, so an empty probe result can not blank a non-empty CMDB value
 * (cmdbModel.mergeServerWithAuthority additionally ignores empty incoming values).
 */
const BAD_DOMAINS = new Set(['workgroup', 'localdomain', '(none)', 'none', 'local']);

function nonEmpty(v) { return v !== undefined && v !== null && String(v).trim() !== ''; }

function toInt(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** hostname + domain as FQDN, only for a bare host name and a real domain (not WORKGROUP / (none)). */
function buildFqdn(hostname, domain) {
    if (!nonEmpty(hostname) || !nonEmpty(domain)) return '';
    const h = String(hostname).trim();
    const d = String(domain).trim().replace(/^\.+/, '');
    if (h.includes('.') || !d.includes('.') || BAD_DOMAINS.has(d.toLowerCase())) return '';
    return `${h}.${d}`;
}

function mapInventoryHostToCmdb(host) {
    const out = { ...host };
    // inventory-only keys must not leak into the CMDB input
    delete out.cpu; delete out.mem; delete out.osname; delete out.domain; delete out.timezone; delete out.error;
    const osText = nonEmpty(host.osname) ? String(host.osname).trim() : (nonEmpty(host.os) && host.os !== 'unknown' ? String(host.os).trim() : '');
    if (osText) out.os = osText; else delete out.os;
    if (nonEmpty(host.osVersion)) out.osVersion = String(host.osVersion).trim(); else delete out.osVersion;
    const cpu = toInt(host.cpu);
    if (cpu) out.cpuCores = cpu;
    const mem = toInt(host.mem !== undefined ? host.mem : host.memoryGB);
    if (mem) out.memoryGB = mem;
    const fqdn = buildFqdn(host.hostname, host.domain);
    if (fqdn) out.fqdn = fqdn;
    if (!nonEmpty(host.hostname)) delete out.hostname;
    if (nonEmpty(host.timezone)) out.timezone = String(host.timezone).trim();
    if (Array.isArray(host.tags) && host.tags.length) out.tags = JSON.stringify(host.tags);
    else delete out.tags;
    return out;
}

module.exports = { mapInventoryHostToCmdb, buildFqdn };
