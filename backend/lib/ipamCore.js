/**
 * IPAM core: the single implementation of the IPv4 / CIDR helpers used by routes/ipam.js, lib/ipamSync.js,
 * services/inventoryScheduler.js and the IPAM store. Pure functions only (no storage, no audit).
 *
 * Stored document shape (unchanged, read by many modules): array of subnets
 *   { id, name, cidr, vlan, envId, environment, createdAt, gateway?, reserved?, ips: [ipEntry] }
 *   ipEntry = { address, status, hostname, fqdn, assignedTo, envId, environment, service, tags, updatedAt,
 *               reservedBy?, reservedUntil? }
 */
const crypto = require('crypto');

// Never materialise more than this many IP objects for one subnet (/20 = 4094 usable hosts)
const MAX_MATERIALISED = 4094;
// Masks accepted for NEW subnets (manual create / batch create)
const NEW_MASK_MIN = 20;
const NEW_MASK_MAX = 30;
// Masks generateIPs understands (legacy subnets /16 - /19 exist, only their first 4094 IPs are materialised)
const GEN_MASK_MIN = 16;
const GEN_MASK_MAX = 30;

/** 'a.b.c.d' -> unsigned 32-bit int, or null when not a strict dotted-quad. */
function ipToInt(ip) {
    if (typeof ip !== 'string' && typeof ip !== 'number') return null;
    const s = String(ip).trim();
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (!m) return null;
    const p = [m[1], m[2], m[3], m[4]].map(Number);
    if (p.some(n => n > 255)) return null;
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function intToIp(n) {
    n = n >>> 0;
    return `${(n >>> 24) & 0xFF}.${(n >>> 16) & 0xFF}.${(n >>> 8) & 0xFF}.${n & 0xFF}`;
}

const isValidIp = (ip) => ipToInt(ip) !== null;

function maskBits(mask) {
    return mask === 0 ? 0 : ((0xFFFFFFFF << (32 - mask)) >>> 0);
}

/**
 * Parses 'a.b.c.d/n' (n 0..32). Returns null when malformed, else
 * { cidr (normalised to the network address), mask, network, broadcast (ints), isNetworkAddress, given }.
 */
function parseCidr(cidr) {
    if (typeof cidr !== 'string') return null;
    const m = /^\s*([0-9.]+)\s*\/\s*(\d{1,2})\s*$/.exec(cidr);
    if (!m) return null;
    const baseInt = ipToInt(m[1]);
    const mask = Number(m[2]);
    if (baseInt === null || mask > 32) return null;
    const bits = maskBits(mask);
    const network = (baseInt & bits) >>> 0;
    const broadcast = (network | (~bits >>> 0)) >>> 0;
    return {
        cidr: `${intToIp(network)}/${mask}`,
        mask,
        network,
        broadcast,
        isNetworkAddress: network === baseInt,
        given: `${m[1]}/${mask}`
    };
}

/** Normalised cidr string ('10.1.2.3/24' -> '10.1.2.0/24'), or null when malformed. */
function normalizeCidr(cidr) {
    const p = parseCidr(cidr);
    return p ? p.cidr : null;
}

/** First / last usable host ints (/31 and /32: every address is usable). */
function hostRange(p) {
    if (p.mask >= 31) return { first: p.network, last: p.broadcast };
    return { first: (p.network + 1) >>> 0, last: (p.broadcast - 1) >>> 0 };
}

/** Number of usable hosts of a cidr (0 when malformed). */
function hostCount(cidr) {
    const p = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
    if (!p) return 0;
    const r = hostRange(p);
    return r.last - r.first + 1;
}

/**
 * Validation of a cidr for a NEW subnet: well-formed, mask /20 - /30.
 * The address is normalised to the network address (10.1.2.3/24 -> 10.1.2.0/24); `normalized` tells the caller.
 * Returns { ok: true, cidr, normalized } or { ok: false, error }.
 */
function validateNewCidr(cidr) {
    const p = parseCidr(cidr);
    if (!p) return { ok: false, error: `Invalid CIDR "${cidr}": expected a.b.c.d/n` };
    if (p.mask < NEW_MASK_MIN || p.mask > NEW_MASK_MAX) {
        return { ok: false, error: `Invalid mask /${p.mask} for "${cidr}": new subnets must be /${NEW_MASK_MIN} to /${NEW_MASK_MAX} (at most ${MAX_MATERIALISED} hosts)` };
    }
    return { ok: true, cidr: p.cidr, normalized: !p.isNetworkAddress, parsed: p };
}

function ipInCidr(ip, cidr) {
    const n = ipToInt(ip);
    const p = parseCidr(cidr);
    if (n === null || !p) return false;
    return n >= p.network && n <= p.broadcast;
}

function cidrsOverlap(a, b) {
    const pa = typeof a === 'string' ? parseCidr(a) : a;
    const pb = typeof b === 'string' ? parseCidr(b) : b;
    if (!pa || !pb) return false;
    return pa.network <= pb.broadcast && pb.network <= pa.broadcast;
}

/** Duplicate / overlap check of a new cidr against the stored subnets: { duplicate, overlap } (subnet or null). */
function findConflict(subnets, cidr) {
    const p = parseCidr(cidr);
    if (!p) return { duplicate: null, overlap: null };
    let overlap = null;
    for (const s of Array.isArray(subnets) ? subnets : []) {
        const sp = s && parseCidr(s.cidr);
        if (!sp) continue;
        if (sp.network === p.network && sp.mask === p.mask) return { duplicate: s, overlap: null };
        if (!overlap && cidrsOverlap(sp, p)) overlap = s;
    }
    return { duplicate: null, overlap };
}

/** RFC1918 (10/8, 172.16/12, 192.168/16) plus CGNAT 100.64/10. */
function isPrivateIp(ip) {
    const n = ipToInt(ip);
    if (n === null) return false;
    const inNet = (net, mask) => ((n & maskBits(mask)) >>> 0) === ipToInt(net);
    return inNet('10.0.0.0', 8) || inNet('172.16.0.0', 12) || inNet('192.168.0.0', 16) || inNet('100.64.0.0', 10);
}

function newIpEntry(address, envFields = {}) {
    return {
        address,
        status: 'free',
        hostname: '',
        fqdn: '',
        assignedTo: '',
        ...envFields,
        service: '',
        updatedAt: new Date().toISOString(),
        tags: []
    };
}

/**
 * Materialised IP objects of a cidr (/16 - /30), at most MAX_MATERIALISED (the first ones).
 * envFields: { envId, environment } read once by the caller (not per IP).
 */
function generateIPs(cidr, envFields = {}) {
    const p = parseCidr(cidr);
    if (!p || p.mask < GEN_MASK_MIN || p.mask > GEN_MASK_MAX) return [];
    const { first, last } = hostRange(p);
    const count = Math.min(last - first + 1, MAX_MATERIALISED);
    const ips = new Array(count);
    for (let i = 0; i < count; i++) ips[i] = newIpEntry(intToIp(first + i), envFields);
    return ips;
}

/** Usable hosts not materialised in ips[] (legacy /16 - /19 subnets): { truncated, hostCount, materialised }. */
function truncationOf(subnet) {
    const total = hostCount(subnet && subnet.cidr);
    const materialised = Array.isArray(subnet && subnet.ips) ? subnet.ips.length : 0;
    return { truncated: total > materialised && total > MAX_MATERIALISED, hostCount: total, materialised };
}

/**
 * The subnet containing ip with the LONGEST prefix (most specific); ties -> the first stored. null when none.
 */
function findSubnetForIp(subnets, ip) {
    const n = ipToInt(ip);
    if (n === null || !Array.isArray(subnets)) return null;
    let best = null;
    let bestMask = -1;
    for (const s of subnets) {
        const p = s && parseCidr(s.cidr);
        if (!p) continue;
        if (n >= p.network && n <= p.broadcast && p.mask > bestMask) {
            best = s;
            bestMask = p.mask;
        }
    }
    return best;
}

/** The subnet's own environment fields, used for IPs materialised later. */
function subnetEnvFields(subnet) {
    if (!subnet) return {};
    if (subnet.envId) return { envId: subnet.envId, environment: subnet.environment };
    return subnet.environment !== undefined ? { environment: subnet.environment } : {};
}

/**
 * The IP object of `ip` in `subnet`; when missing but a usable host inside the subnet's CIDR it is created
 * (status free, inserted in address order) - e.g. addresses past the 4094 materialised IPs of a legacy /16.
 * envFields defaults to the subnet's environment. Returns null when ip is outside the CIDR (or the network /
 * broadcast address) or malformed. Mutates subnet.ips.
 */
function ensureIpEntry(subnet, ip, envFields) {
    if (!subnet) return null;
    const n = ipToInt(ip);
    const p = parseCidr(subnet.cidr);
    if (n === null || !p) return null;
    const address = intToIp(n);
    if (!Array.isArray(subnet.ips)) subnet.ips = [];
    const existing = subnet.ips.find(e => e && String(e.address).trim() === address);
    if (existing) return existing;
    const { first, last } = hostRange(p);
    if (n < first || n > last) return null;
    const entry = newIpEntry(address, envFields || subnetEnvFields(subnet));
    // insert in address order (first entry with a greater address); append when none
    let at = subnet.ips.length;
    for (let i = 0; i < subnet.ips.length; i++) {
        const v = ipToInt(subnet.ips[i] && subnet.ips[i].address);
        if (v !== null && v > n) { at = i; break; }
    }
    subnet.ips.splice(at, 0, entry);
    return entry;
}

/**
 * A new /24 subnet for ip, only for private IPs (isPrivateIp); null for public / malformed IPs.
 * opts.name overrides the default "Auto Network (a.b.c.0)".
 */
function autoCreateSubnetFor(ip, envFields = {}, opts = {}) {
    if (!isPrivateIp(ip)) return null;
    const n = ipToInt(ip);
    const base = intToIp((n & maskBits(24)) >>> 0);
    const cidr = `${base}/24`;
    return {
        id: crypto.randomUUID(),
        name: opts.name || `Auto Network (${base})`,
        cidr,
        vlan: '',
        ...envFields,
        ips: generateIPs(cidr, envFields),
        createdAt: new Date().toISOString()
    };
}

// ------------------------------------------------------------------ gateway / reserved ranges

/** First usable host of a cidr as a string ('' when malformed). */
function firstUsableHost(cidr) {
    const p = parseCidr(cidr);
    return p ? intToIp(hostRange(p).first) : '';
}

/**
 * Gateway in effect: field absent (legacy subnets) -> the first usable host; '' -> no gateway; else the value.
 */
function effectiveGateway(subnet) {
    if (!subnet) return '';
    if (subnet.gateway === undefined || subnet.gateway === null) return firstUsableHost(subnet.cidr);
    return String(subnet.gateway).trim();
}

/** Validates a gateway for a cidr: '' or a usable host inside it. Returns an error message or null. */
function validateGateway(gateway, cidr) {
    if (gateway === '') return null;
    if (typeof gateway !== 'string') return 'gateway must be a string';
    const p = parseCidr(cidr);
    const n = ipToInt(gateway);
    if (!p || n === null) return `Invalid gateway "${gateway}"`;
    const { first, last } = hostRange(p);
    if (n < first || n > last) return `Gateway ${gateway} is not a usable host of ${p.cidr}`;
    return null;
}

/**
 * Parses reserved entries ('a.b.c.d' or 'a.b.c.d-a.b.c.e') inside cidr.
 * Returns { ranges: [[lo, hi]], values: [normalised strings] } or { error }.
 */
function parseReserved(reserved, cidr) {
    if (reserved === undefined || reserved === null) return { ranges: [], values: [] };
    if (!Array.isArray(reserved)) return { error: 'reserved must be an array of addresses or ranges' };
    if (reserved.length > 256) return { error: 'reserved: at most 256 entries' };
    const p = parseCidr(cidr);
    if (!p) return { error: `Invalid CIDR "${cidr}"` };
    const ranges = [];
    const values = [];
    for (const raw of reserved) {
        if (typeof raw !== 'string' || !raw.trim()) return { error: 'reserved entries must be non-empty strings' };
        const parts = raw.split('-').map(x => x.trim());
        if (parts.length > 2) return { error: `Invalid reserved entry "${raw}"` };
        const lo = ipToInt(parts[0]);
        const hi = parts.length === 2 ? ipToInt(parts[1]) : lo;
        if (lo === null || hi === null) return { error: `Invalid reserved entry "${raw}"` };
        if (hi < lo) return { error: `Invalid reserved range "${raw}": end before start` };
        if (lo < p.network || hi > p.broadcast) return { error: `Reserved entry "${raw}" is outside ${p.cidr}` };
        ranges.push([lo, hi]);
        values.push(parts.length === 2 ? `${intToIp(lo)}-${intToIp(hi)}` : intToIp(lo));
    }
    return { ranges, values };
}

/** Is a reservation (reservedUntil) still running at `now`? */
function reservationActive(entry, now = Date.now()) {
    if (!entry || !entry.reservedUntil) return false;
    const t = new Date(entry.reservedUntil).getTime();
    return Number.isFinite(t) && t > now;
}

/**
 * The next IP object that can be handed out: status 'free', not the gateway, not inside a reserved entry,
 * no running reservation. null when none.
 */
function nextAvailable(subnet, now = Date.now()) {
    if (!subnet || !Array.isArray(subnet.ips)) return null;
    const gw = ipToInt(effectiveGateway(subnet));
    const parsed = parseReserved(subnet.reserved, subnet.cidr);
    const ranges = parsed.error ? [] : parsed.ranges;
    for (const e of subnet.ips) {
        if (!e || (e.status || 'free') !== 'free') continue;
        const n = ipToInt(e.address);
        if (n === null || n === gw) continue;
        if (ranges.some(([lo, hi]) => n >= lo && n <= hi)) continue;
        if (reservationActive(e, now)) continue;
        return e;
    }
    return null;
}

module.exports = {
    MAX_MATERIALISED,
    NEW_MASK_MIN,
    NEW_MASK_MAX,
    ipToInt,
    intToIp,
    isValidIp,
    parseCidr,
    normalizeCidr,
    validateNewCidr,
    hostCount,
    ipInCidr,
    cidrsOverlap,
    findConflict,
    isPrivateIp,
    newIpEntry,
    generateIPs,
    truncationOf,
    findSubnetForIp,
    subnetEnvFields,
    ensureIpEntry,
    autoCreateSubnetFor,
    firstUsableHost,
    effectiveGateway,
    validateGateway,
    parseReserved,
    reservationActive,
    nextAvailable
};
