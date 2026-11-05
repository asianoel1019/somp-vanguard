// Parsers of F5 BIG-IP iControl REST answers (pure functions). Statistics come as nested `entries` maps keyed by
// self links ({ entries: { "<url>": { nestedStats: { entries: { field: { value | description } } } } } }); the
// key paths differ between 13.x and 14+, so records are found by their fields (tmName), never by their keys.

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** Value of one stat field: { value } (numbers) or { description } (text). */
function statValue(f) {
    if (!f || typeof f !== 'object') return f === undefined ? null : f;
    if (f.value !== undefined) return f.value;
    if (f.description !== undefined) return f.description;
    return null;
}

/** The flat field maps of a stats answer: every nested `entries` object that holds plain fields. */
function statRecords(doc) {
    const out = [];
    const walk = (entries) => {
        if (!entries || typeof entries !== 'object') return;
        const fields = {};
        let plain = false;
        for (const [k, v] of Object.entries(entries)) {
            if (v && typeof v === 'object' && v.nestedStats) walk(v.nestedStats.entries);
            else if (v && typeof v === 'object' && v.entries) walk(v.entries);
            else { fields[k] = statValue(v); plain = true; }
        }
        if (plain) out.push(fields);
    };
    walk(doc && doc.entries);
    return out;
}

/** First value of a stat field anywhere in a stats answer. */
function findStat(doc, name) {
    for (const r of statRecords(doc)) if (r[name] !== undefined && r[name] !== null) return r[name];
    return null;
}

/** Stats records by full path (tmName). */
function statsByPath(doc) {
    const map = {};
    for (const r of statRecords(doc)) if (r.tmName) map[r.tmName] = r;
    return map;
}

/** F5 status colour from availability and enabled state. */
function statusColor(availability, enabled) {
    if (/disabled/i.test(String(enabled || ''))) return 'gray';
    const a = String(availability || '').toLowerCase();
    if (a === 'available') return 'green';
    if (a === 'unavailable') return 'yellow';
    if (a === 'offline') return 'red';
    return 'blue';
}

/**
 * "/Common/192.0.2.10:443" -> { ip: '192.0.2.10', port: 443 }; route domains stay on the address
 * ("192.0.2.10%2"); IPv6 separates the port with a dot ("2001:db8::10.443"); "any" is port 0.
 */
function parseDestination(dest) {
    const s = String(dest || '').replace(/^\/[^/]+\//, '');
    if (!s) return { ip: null, port: null };
    let ip;
    let port;
    if ((s.match(/:/g) || []).length > 1) {
        const i = s.lastIndexOf('.');
        ip = s.slice(0, i);
        port = s.slice(i + 1);
    } else {
        const i = s.lastIndexOf(':');
        if (i < 0) return { ip: s, port: null };
        ip = s.slice(0, i);
        port = s.slice(i + 1);
    }
    return { ip, port: port === 'any' ? 0 : num(port) };
}

/**
 * Summary from sys/global-settings, sys/version, sys/hardware and (optional) sys/host-info.
 * @returns {{ model, hostname, version, build, serial, cpu, memory }}
 */
function parseSummary({ settings, version, hardware, hostInfo }) {
    const idles = statRecords(hostInfo).map(r => num(r.oneMinAvgIdle)).filter(v => v !== null);
    const total = num(findStat(hostInfo, 'memoryTotal'));
    const used = num(findStat(hostInfo, 'memoryUsed'));
    const product = findStat(version, 'Product');
    const ver = findStat(version, 'Version');
    return {
        model: findStat(hardware, 'marketingName') || findStat(hardware, 'platform') || product || null,
        hostname: (settings && settings.hostname) || null,
        version: ver ? `${product && product !== 'BIG-IP' ? `${product} ` : ''}${ver}` : null,
        build: findStat(version, 'Build'),
        serial: findStat(hardware, 'bigipChassisSerialNum') || findStat(hardware, 'chassisSerialNum') || null,
        cpu: idles.length ? Math.round(100 - idles.reduce((a, b) => a + b, 0) / idles.length) : null,
        memory: total ? Math.round((used / total) * 100) : null,
    };
}

const ROLE = { active: 'active', standby: 'standby', offline: 'offline', 'forced-offline': 'forced-offline' };
const roleOf = (s) => ROLE[String(s || '').toLowerCase().replace(/\s+/g, '-')] || (s ? String(s).toLowerCase() : null);

/**
 * HA in the shape of the HA tab: { mode, group, priority, members[], syncStatus, syncColor }.
 * `devices`: cm/device items (null when not readable).
 */
function parseHa({ failover, sync, devices }) {
    const items = devices && Array.isArray(devices.items) ? devices.items : [];
    const self = items.find(d => String(d.selfDevice) === 'true');
    const mode = roleOf((self && self.failoverState) || findStat(failover, 'status'));
    // "dg-failover (In Sync): ..." among the sync details; the trust group is not a failover group
    const details = statRecords(sync).map(r => r.details).filter(Boolean);
    const groupLine = details.map(d => /^(\S+) \(/.exec(String(d))).find(m => m && !/device_trust_group|gtm/i.test(m[1]));
    return {
        mode,
        group: groupLine ? groupLine[1] : null,
        priority: null,
        syncStatus: findStat(sync, 'status'),
        syncColor: findStat(sync, 'color'),
        members: items.map(d => ({
            hostname: d.hostname || d.name || null,
            serial: d.chassisId || null,
            priority: null,
            primary: null,
            state: roleOf(d.failoverState),
            mgmtIp: d.managementIp || null,
            version: d.version || null,
            self: String(d.selfDevice) === 'true',
        })),
    };
}

/**
 * Virtual servers from ltm/virtual (configuration) and ltm/virtual/stats (status and counters, null when not
 * readable: status then follows the configured enabled / disabled state only).
 */
function parseVirtuals(config, stats) {
    const st = stats ? statsByPath(stats) : {};
    return (config && Array.isArray(config.items) ? config.items : []).map((v) => {
        const fullPath = v.fullPath || `/${v.partition || 'Common'}/${v.name}`;
        const s = st[fullPath] || {};
        const enabled = !(v.disabled === true || /disabled/i.test(String(s['status.enabledState'] || '')));
        const { ip, port } = parseDestination(v.destination);
        return {
            name: v.name,
            partition: v.partition || 'Common',
            fullPath,
            description: v.description || '',
            destination: ip === null ? null : (port === null ? ip : `${ip}${ip.includes(':') ? '.' : ':'}${port}`),
            ip,
            port,
            protocol: v.ipProtocol || null,
            pool: v.pool || null,
            status: statusColor(s['status.availabilityState'] || (stats ? null : (enabled ? 'unknown' : null)), enabled ? 'enabled' : 'disabled'),
            statusReason: s['status.statusReason'] || null,
            enabled,
            curConns: num(s['clientside.curConns']),
            bitsIn: num(s['clientside.bitsIn']),
            bitsOut: num(s['clientside.bitsOut']),
        };
    }).sort((a, b) => a.fullPath.localeCompare(b.fullPath));
}

const membersOf = (pool) => {
    const ref = pool && pool.membersReference;
    return ref && Array.isArray(ref.items) ? ref.items : [];
};

/**
 * Pools from ltm/pool (configuration with members expanded) and ltm/pool/stats (null when not readable).
 * A member counts as up when its monitor says so and nobody disabled it.
 */
function parsePools(config, stats) {
    const st = stats ? statsByPath(stats) : {};
    return (config && Array.isArray(config.items) ? config.items : []).map((p) => {
        const fullPath = p.fullPath || `/${p.partition || 'Common'}/${p.name}`;
        const s = st[fullPath] || {};
        const members = membersOf(p);
        return {
            name: p.name,
            partition: p.partition || 'Common',
            fullPath,
            description: p.description || '',
            status: stats ? statusColor(s['status.availabilityState'], s['status.enabledState']) : 'blue',
            statusReason: s['status.statusReason'] || null,
            lbMode: p.loadBalancingMode || null,
            monitor: p.monitor ? String(p.monitor).trim() : null,
            membersUp: members.filter(m => m.state === 'up' && m.session !== 'user-disabled').length,
            membersTotal: members.length,
            curConns: num(s['serverside.curConns']),
        };
    }).sort((a, b) => a.fullPath.localeCompare(b.fullPath));
}

/** Enabled / disabled / forced offline from a member's configuration. */
function sessionOf(m) {
    if (m.state === 'user-down') return 'forced-offline';
    if (m.session === 'user-disabled') return 'disabled';
    return 'enabled';
}

/**
 * Members of one pool from its members collection (configuration) and members/stats (null when not readable).
 * Stats records name their member by nodeName ("/Common/192.0.2.21") and port; members are matched on both.
 */
function parsePoolMembers(config, stats) {
    const byMember = {};
    for (const r of stats ? statRecords(stats) : []) {
        if (r.nodeName !== undefined && r.port !== undefined) byMember[`${String(r.nodeName).replace(/^\/[^/]+\//, '')}|${r.port}`] = r;
    }
    return (config && Array.isArray(config.items) ? config.items : []).map((m) => {
        const { ip: node, port } = parseDestination(`/x/${m.name}`);
        const s = byMember[`${node}|${port}`] || {};
        const session = sessionOf(m);
        const availability = s['status.availabilityState'] || ({ up: 'available', down: 'offline', 'user-down': 'offline' }[m.state] || 'unknown');
        return {
            name: m.name,
            fullPath: m.fullPath || `/${m.partition || 'Common'}/${m.name}`,
            address: m.address || null,
            port,
            status: statusColor(availability, session === 'enabled' ? 'enabled' : 'disabled'),
            statusReason: s['status.statusReason'] || null,
            monitor: m.state || null,
            session,
            curConns: num(s['serverside.curConns']),
            bitsIn: num(s['serverside.bitsIn']),
            bitsOut: num(s['serverside.bitsOut']),
        };
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const cnOf = (dn) => { const m = /(?:^|,\s*)CN=([^,]+)/i.exec(String(dn || '')); return m ? m[1].trim() : null; };

/** SSL certificates of sys/file/ssl-cert with the days left at `now` (expired ones are negative). */
function parseCerts(doc, now = Date.now()) {
    return (doc && Array.isArray(doc.items) ? doc.items : []).map((c) => {
        const exp = num(c.expirationDate);
        const expiresAt = exp ? new Date(exp * 1000).toISOString() : null;
        return {
            name: c.name,
            partition: c.partition || 'Common',
            fullPath: c.fullPath || `/${c.partition || 'Common'}/${c.name}`,
            commonName: c.commonName || cnOf(c.subject),
            issuer: cnOf(c.issuer) || c.issuer || null,
            expiresAt,
            daysLeft: exp ? Math.floor((exp * 1000 - now) / DAY_MS) : null,
            isBundle: c.isBundle === 'true' || c.isBundle === true,
        };
    }).sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.fullPath.localeCompare(b.fullPath));
}

/** "/Common/pool_web" or "/Common/app/pool_web" -> "~Common~pool_web" (iControl REST path form). */
const restName = (fullPath) => String(fullPath).replace(/\//g, '~');

module.exports = {
    statValue, statRecords, findStat, statsByPath, statusColor, parseDestination, parseSummary, parseHa, parseVirtuals,
    parsePools, parsePoolMembers, parseCerts, restName,
};
