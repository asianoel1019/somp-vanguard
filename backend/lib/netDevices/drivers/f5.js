// F5 BIG-IP (iControl REST, read only). Logs in with a token (lib/netDevices/f5Session.js) and only reads: no
// writes, no /mgmt/tm/util/bash. The profile scope is a partition: when set, collections are filtered to it.
// An account with the Auditor role is enough.
const f5Session = require('../f5Session');
const f5 = require('../parsers/f5');
const { netError } = require('../errors');

const capabilities = ['summary', 'ha', 'virtuals', 'pools', 'certs'];
// a missing optional answer only leaves its fields empty; these failures still stop the request
const FATAL_CODES = new Set(['UNREACHABLE', 'AUTH', 'TLS', 'NOT_CONFIGURED']);
const VIRTUAL_FIELDS = 'name,partition,fullPath,destination,ipProtocol,pool,enabled,disabled,description';
const POOL_FIELDS = 'name,partition,fullPath,description,loadBalancingMode,monitor,membersReference';
const MEMBER_FIELDS = 'name,partition,fullPath,address,state,session';
const CERT_FIELDS = 'name,partition,fullPath,commonName,subject,issuer,expirationDate,isBundle';
const EXPIRING_DAYS = 30;

/** GET each path of `reqs` ({ key: { path, params?, optional? } }); the first one alone (one login), then in parallel. */
async function readAll(profile, reqs, { cache = true } = {}) {
    const s = f5Session.open(profile, { cache });
    const keys = Object.keys(reqs);
    const get = async (k) => {
        const { path, params, optional } = reqs[k];
        try {
            const data = await s.request({ path, params });
            if (data && typeof data === 'object') return data;
            throw netError('OTHER', `The device did not answer ${path} with JSON`);
        } catch (err) {
            if (optional && !FATAL_CODES.has(err.code)) return null;
            throw err;
        }
    };
    const out = { [keys[0]]: await get(keys[0]) };
    const rest = await Promise.all(keys.slice(1).map(get));
    keys.slice(1).forEach((k, i) => { out[k] = rest[i]; });
    return out;
}

/** OData parameters of a collection: only the needed fields, only the profile's partition. */
function collectionParams(profile, select) {
    const p = {};
    if (select) p.$select = select;
    if (profile.scope) p.$filter = `partition eq ${profile.scope}`;
    return p;
}

const SUMMARY_READS = {
    settings: { path: '/mgmt/tm/sys/global-settings', params: { $select: 'hostname' } },
    version: { path: '/mgmt/tm/sys/version' },
    hardware: { path: '/mgmt/tm/sys/hardware', optional: true },
};

const facts = (s) => ({ model: s.model, hostname: s.hostname, version: s.version, serial: s.serial });

/** A connection test logs in with the values on the page and keeps no token. */
async function testConnection(profile) {
    const o = await readAll(profile, SUMMARY_READS, { cache: false });
    return facts(f5.parseSummary(o));
}

async function getSummary(profile) {
    const o = await readAll(profile, { ...SUMMARY_READS, hostInfo: { path: '/mgmt/tm/sys/host-info', optional: true } });
    return { ...f5.parseSummary(o), ...(profile.scope ? { partition: profile.scope } : {}) };
}

async function getHa(profile) {
    const o = await readAll(profile, {
        failover: { path: '/mgmt/tm/cm/failover-status' },
        sync: { path: '/mgmt/tm/cm/sync-status', optional: true },
        devices: { path: '/mgmt/tm/cm/device', params: { $select: 'name,hostname,managementIp,failoverState,selfDevice,version,chassisId' }, optional: true },
    });
    return f5.parseHa(o);
}

const SEARCH_RE = /^[\w.:%/ -]{1,100}$/;

/** Virtual servers, filtered on the server: `search` (name, address, pool), `nonGreen` (anything but green). */
async function getVirtuals(profile, opts = {}) {
    const search = String(opts.search || '').trim();
    if (search && !SEARCH_RE.test(search)) throw netError('BAD_REQUEST', 'Search: letters, digits and . : % / - _ only');
    const nonGreen = opts.nonGreen === true || opts.nonGreen === 'true' || opts.nonGreen === '1';
    const o = await readAll(profile, {
        config: { path: '/mgmt/tm/ltm/virtual', params: collectionParams(profile, VIRTUAL_FIELDS) },
        stats: { path: '/mgmt/tm/ltm/virtual/stats', optional: true },
    });
    const q = search.toLowerCase();
    const items = f5.parseVirtuals(o.config, o.stats)
        .filter(v => !profile.scope || v.partition === profile.scope)
        .filter(v => !q || [v.fullPath, v.destination, v.pool].some(x => x && x.toLowerCase().includes(q)))
        .filter(v => !nonGreen || v.status !== 'green');
    return { total: items.length, statsAvailable: !!o.stats, items };
}

// "/Common/pool_web" or "/Common/app1/pool_web"; nothing that could change the request path
const POOL_PATH_RE = /^\/[\w.-]{1,64}(\/[\w.-]{1,64})?\/[\w.:%-]{1,255}$/;
const flag = (v) => v === true || v === 'true' || v === '1';

/**
 * Pools, or the members of one pool (`opts.pool` = its full path; read only when a pool is opened: reading the
 * members of every pool would take one request per pool).
 */
async function getPools(profile, opts = {}) {
    const poolPath = String(opts.pool || '').trim();
    if (poolPath) {
        if (!POOL_PATH_RE.test(poolPath) || poolPath.split('/').some(seg => seg === '.' || seg === '..')) throw netError('BAD_REQUEST', 'Invalid pool path');
        if (profile.scope && poolPath.split('/')[1] !== profile.scope) throw netError('BAD_REQUEST', `The pool is not in partition ${profile.scope}`);
        const base = `/mgmt/tm/ltm/pool/${f5.restName(poolPath)}/members`;
        const o = await readAll(profile, {
            config: { path: base, params: { $select: MEMBER_FIELDS } },
            stats: { path: `${base}/stats`, optional: true },
        });
        const members = f5.parsePoolMembers(o.config, o.stats);
        return { pool: poolPath, statsAvailable: !!o.stats, members };
    }
    const search = String(opts.search || '').trim();
    if (search && !SEARCH_RE.test(search)) throw netError('BAD_REQUEST', 'Search: letters, digits and . : % / - _ only');
    const o = await readAll(profile, {
        config: { path: '/mgmt/tm/ltm/pool', params: { ...collectionParams(profile, POOL_FIELDS), expandSubcollections: 'true' } },
        stats: { path: '/mgmt/tm/ltm/pool/stats', optional: true },
    });
    const q = search.toLowerCase();
    const items = f5.parsePools(o.config, o.stats)
        .filter(p => !profile.scope || p.partition === profile.scope)
        .filter(p => !q || p.fullPath.toLowerCase().includes(q))
        .filter(p => !flag(opts.nonGreen) || p.status !== 'green');
    return { total: items.length, statsAvailable: !!o.stats, items };
}

/** SSL certificates by expiry; `expiringOnly`: expired or expiring within 30 days (bundles left out). */
async function getCerts(profile, opts = {}) {
    const o = await readAll(profile, { certs: { path: '/mgmt/tm/sys/file/ssl-cert', params: collectionParams(profile, CERT_FIELDS) } });
    const all = f5.parseCerts(o.certs).filter(c => !profile.scope || c.partition === profile.scope);
    const expiring = (c) => !c.isBundle && c.daysLeft !== null && c.daysLeft <= EXPIRING_DAYS;
    const items = flag(opts.expiringOnly) ? all.filter(expiring) : all;
    return { total: items.length, expiring: all.filter(expiring).length, warnDays: EXPIRING_DAYS, items };
}

// ---- configuration snapshot ----

// Collections of the snapshot (iControl REST cannot give the tmsh text to a read-only account)
const SNAPSHOT = [
    ['ltm/virtual'], ['ltm/pool', { expandSubcollections: 'true' }], ['ltm/node'],
    ['ltm/monitor/http'], ['ltm/monitor/https'], ['ltm/monitor/tcp'], ['ltm/monitor/icmp'], ['ltm/monitor/gateway-icmp'],
    ['ltm/profile/client-ssl'], ['ltm/profile/server-ssl'], ['ltm/profile/http'],
    ['ltm/rule'], ['ltm/data-group/internal'], ['ltm/snat'], ['ltm/snatpool'],
    ['net/self'], ['net/vlan'], ['net/route'],
];
const SNAPSHOT_PARALLEL = 4;
// self links (they carry the software version), generations and kinds change without a configuration change
const DROP_KEYS = new Set(['selfLink', 'generation', 'kind', 'link', 'isSubcollection']);

/**
 * One object of the snapshot: volatile keys dropped, keys sorted. The monitor result of pool members and nodes
 * (state up / down / unchecked) is status, not configuration: only a forced offline (user-down) is kept.
 */
function cleanObject(v) {
    if (Array.isArray(v)) return v.map(cleanObject);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const k of Object.keys(v).sort()) {
        if (DROP_KEYS.has(k)) continue;
        if (k === 'state' && typeof v[k] === 'string' && v[k] !== 'user-down' && ('session' in v || 'address' in v)) continue;
        const c = cleanObject(v[k]);
        if (c && typeof c === 'object' && !Array.isArray(c) && !Object.keys(c).length) continue; // a reference that only held a link
        out[k] = c;
    }
    return out;
}

/**
 * Configuration snapshot as JSON (format 'json'): the objects of SNAPSHOT, sorted by full path. A collection the
 * account may not read or the device does not have is listed in `_skipped`; nothing readable at all fails.
 * The snapshot tracks changes; it cannot restore a device (use a UCS archive for that).
 */
async function backupConfig(profile) {
    const s = f5Session.open(profile);
    const objects = {};
    const skipped = [];
    const readOne = async ([name, extra]) => {
        try {
            const data = await s.request({ path: `/mgmt/tm/${name}`, params: { ...collectionParams(profile), ...(extra || {}) } });
            const items = data && Array.isArray(data.items) ? data.items : [];
            objects[name] = items.map(cleanObject).sort((a, b) => String(a.fullPath || a.name).localeCompare(String(b.fullPath || b.name)));
        } catch (err) {
            if (FATAL_CODES.has(err.code)) throw err;
            skipped.push(`${name}: ${err.code}`);
        }
    };
    await readOne(SNAPSHOT[0]); // alone first: a wrong password fails once
    for (let i = 1; i < SNAPSHOT.length; i += SNAPSHOT_PARALLEL) {
        await Promise.all(SNAPSHOT.slice(i, i + SNAPSHOT_PARALLEL).map(readOne));
    }
    if (!Object.keys(objects).length) throw netError('OTHER', `No configuration could be read (${skipped.join(', ')})`);
    const snapshot = {
        snapshot: 'F5 BIG-IP configuration objects (iControl REST, read only)',
        partition: profile.scope || 'all',
        objects: Object.fromEntries(SNAPSHOT.map(([n]) => n).filter(n => objects[n]).map(n => [n, objects[n]])),
        ...(skipped.length ? { _skipped: skipped.sort() } : {}),
    };
    return { content: `${JSON.stringify(snapshot, null, 2)}\n`, format: 'json' };
}

module.exports = { capabilities, testConnection, getSummary, getHa, getVirtuals, getPools, getCerts, backupConfig, cleanObject, SNAPSHOT };
