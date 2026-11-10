// Pure helpers of DNS Hub record work (routes/records.js): reading input lines, finding the DNS server and zone of a
// name, checking what a delete may remove, and the change-log lines. No PowerShell, no storage.

const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/;

// Record types the Delete flow may remove (zone plumbing such as SOA / NS stays out of reach)
const DELETABLE_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'PTR'];

// Most lines accepted by one add / delete / preview call
const MAX_BATCH = 500;

/**
 * Universal DNS record line parser: tabs, spaces, -, /, ",", ";", ":", |, =, -> and the /etc/hosts order.
 * Returns { fqdn, ip } (ip null when the line has none) or null for an empty line.
 */
function parseDnsRecordLine(rawLine) {
    if (!rawLine || typeof rawLine !== 'string' || !rawLine.trim()) return null;
    const line = rawLine.trim();

    const ipMatch = line.match(IPV4_RE);
    if (ipMatch) {
        const ip = ipMatch[0];
        // Remove the IP from the line and strip surrounding delimiters
        let remaining = line.replace(ip, '').trim();
        remaining = remaining.replace(/^[\s\t/,;:|=><]+|[\s\t/,;:|=><]+$/g, '').trim();
        remaining = remaining.replace(/^-\s*|\s*-$/g, '').trim();
        if (remaining) return { fqdn: remaining, ip };
    }

    // Delimiter fallback: tabs, multiple spaces, or delimiters surrounded by whitespace
    const delimiterRegex = /[\t,;|/=]+|\s+[-/|:=,>]+\s*|\s+/;
    const parts = line.split(delimiterRegex).filter(p => p.trim().length > 0);
    if (parts.length >= 2 && (IPV4_RE.test(parts[0]) || IPV4_RE.test(parts[1]))) {
        let fqdn = parts[0].trim();
        let ip = parts[1].trim();
        if (IPV4_RE.test(fqdn) && !IPV4_RE.test(ip)) [fqdn, ip] = [ip, fqdn];
        return { fqdn, ip };
    }

    return { fqdn: line.replace(/^[\s\t/,;:|=><]+|[\s\t/,;:|=><]+$/g, '').replace(/^-\s*|\s*-$/g, '').trim(), ip: null };
}

/** Host and zone of a name within the longest matching zone ('@' for the zone itself), or null. */
function parseFqdn(fqdn, cachedDomains) {
    if (!cachedDomains || cachedDomains.length === 0) return null;
    const lowerFqdn = String(fqdn).toLowerCase().replace(/\.$/, '');
    let longestMatch = '';
    for (const domain of cachedDomains) {
        const lowerDomain = String(domain).toLowerCase();
        // Domain must match exactly or as a sub-domain with a '.' boundary
        if ((lowerFqdn === lowerDomain || lowerFqdn.endsWith('.' + lowerDomain)) && domain.length > longestMatch.length) {
            longestMatch = domain;
        }
    }
    if (!longestMatch) return null;
    let host = lowerFqdn === longestMatch.toLowerCase() ? '' : String(fqdn).replace(/\.$/, '').slice(0, lowerFqdn.length - longestMatch.length - 1);
    if (!host) host = '@';
    return { host, zone: longestMatch };
}

/** The enabled server holding the longest zone of a name: { server, parsed } (both null when none). */
function findTargetServer(fqdn, servers) {
    let bestServer = null;
    let longestMatchLen = -1;
    let parsedData = null;
    for (const server of servers || []) {
        if (server.disabled || !server.cachedDomains) continue;
        const parsed = parseFqdn(fqdn, server.cachedDomains);
        if (parsed && parsed.zone.length > longestMatchLen) {
            longestMatchLen = parsed.zone.length;
            bestServer = server;
            parsedData = parsed;
        }
    }
    return { server: bestServer, parsed: parsedData };
}

/** Name of an input line or object (the IP and separators of a line are ignored). */
function nameOf(raw) {
    if (raw && typeof raw === 'object') return String(raw.fqdn || '').trim();
    const parsed = parseDnsRecordLine(String(raw == null ? '' : raw));
    return parsed && parsed.fqdn ? parsed.fqdn : String(raw == null ? '' : raw).trim();
}

/**
 * Groups names by DNS server for a lookup or delete.
 * Each input is a line / name (a delete then removes the A records of the name only) or { fqdn, type, data } naming
 * exactly one record. Zone roots, unknown zones and types outside DELETABLE_TYPES are rejected.
 * Returns { groups: Map(serverId -> { server, items: [{ fqdn, zone, host, type, data }] }), rejected: [result] }.
 * `type` / `data` are null for a lookup (withType false).
 */
function groupByServer(records, servers, { withType = true } = {}) {
    const groups = new Map();
    const rejected = [];
    for (const raw of Array.isArray(records) ? records : []) {
        const fqdn = nameOf(raw);
        if (!fqdn) { rejected.push({ record: String(raw && raw.fqdn !== undefined ? raw.fqdn : raw), status: 'Error: Invalid format', serverName: 'None' }); continue; }
        let type = null;
        let data = null;
        if (withType) {
            const exact = raw && typeof raw === 'object';
            type = exact ? String(raw.type || '').toUpperCase() : 'A';
            data = exact ? String(raw.data == null ? '' : raw.data) : null;
            if (!DELETABLE_TYPES.includes(type)) { rejected.push({ record: fqdn, status: `Error: Record type ${type || '(none)'} cannot be deleted here`, serverName: 'None' }); continue; }
            if (exact && !data) { rejected.push({ record: fqdn, status: 'Error: Record data is required', serverName: 'None' }); continue; }
        }
        const { server, parsed } = findTargetServer(fqdn, servers);
        if (!server) { rejected.push({ record: fqdn, status: 'Failed: Zone not found in any cache', serverName: 'None' }); continue; }
        if (withType && parsed.host === '@') { rejected.push({ record: fqdn, status: 'Error: Zone root records cannot be deleted here', serverName: server.name }); continue; }
        if (!groups.has(server.id)) groups.set(server.id, { server, items: [] });
        groups.get(server.id).items.push({ fqdn, zone: parsed.zone, host: parsed.host, type, data });
    }
    return { groups, rejected };
}

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Result row and change-log line of one add / modify answer from PowerShell ({ fqdn, ip, status, oldIps }). */
function addOutcome(r, serverName) {
    const oldIps = toArray(r.oldIps).map(String);
    const base = { record: r.fqdn, serverName };
    if (r.status === 'Added') return { ...base, status: 'Success', detail: `Added ${r.ip}`, log: `Add: ${r.fqdn} -> ${r.ip} (Server: ${serverName})` };
    if (r.status === 'Updated') return { ...base, status: 'Success', detail: `Updated ${oldIps.join(', ')} -> ${r.ip}`, log: `Modify: ${r.fqdn}: ${oldIps.join(', ')} -> ${r.ip} (Server: ${serverName})` };
    if (r.status === 'Unchanged') return { ...base, status: 'Success', detail: `Unchanged (already ${r.ip})`, log: null };
    if (r.status === 'Multiple') {
        return { ...base, status: `Error: ${r.fqdn} has ${oldIps.length} A records (${oldIps.join(', ')}). Use Delete to remove the ones not needed, then add again.`, log: null };
    }
    return { ...base, status: String(r.status || 'Error: No answer'), log: null };
}

/** Result row and change-log lines of one delete answer from PowerShell ({ fqdn, status, removed: [{ type, data }] }). */
function deleteOutcome(r, serverName) {
    const removed = toArray(r.removed).map(x => ({ type: String(x.type), data: String(x.data) }));
    const detail = removed.map(x => `${x.type} ${x.data}`).join(', ');
    // Whatever was removed is logged, also when a later record of the same name failed
    const logs = removed.map(x => `Delete: ${r.fqdn} ${x.type} ${x.data} (Server: ${serverName})`);
    return { record: r.fqdn, serverName, status: String(r.status || 'Error: No answer'), detail: detail || undefined, logs };
}

/** Records found by a delete lookup, each marked deletable or not. */
function lookupRecords(list) {
    return toArray(list).map(x => {
        const type = String(x.type || '');
        return { type, data: String(x.data == null ? '' : x.data), ttl: Number(x.ttl) || null, deletable: DELETABLE_TYPES.includes(type.toUpperCase()) };
    });
}

module.exports = {
    IPV4_RE, DELETABLE_TYPES, MAX_BATCH,
    parseDnsRecordLine, parseFqdn, findTargetServer, nameOf, groupByServer, addOutcome, deleteOutcome, lookupRecords, toArray,
};
