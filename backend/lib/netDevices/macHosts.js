// Host names for switch MAC tables: the MACs recorded in the CMDB (Server List / Inventory scans) mapped to their
// servers. IPAM keeps no MACs, so the CMDB is the only source. The index is rebuilt at most once a minute.
const { normalizeMac } = require('./parsers/ciscoIos');

const TTL_MS = 60 * 1000;
const MAX_HOSTS = 3; // per MAC (a shared MAC: VIPs, clusters)

// lazy: services/cmdbModel pulls in the database layer
let source = () => require('../../services/cmdbModel').listMacRecords();
let cache = null; // { at, map: Map<mac, [{ hostname, ip }]> }

/** "00:50:56:aa:bb:cc, 0050.56aa.bbcd" -> normalized MACs (anything that is not 12 hex digits is skipped). */
function macsOf(text) {
    return String(text || '').split(/[\s,;|/]+/).map(normalizeMac).filter(Boolean);
}

function index() {
    if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
    const map = new Map();
    for (const r of source() || []) {
        const host = { hostname: r.hostname || r.vmName || '', ip: r.ip };
        for (const mac of macsOf(r.mac)) {
            const list = map.get(mac) || [];
            if (list.length < MAX_HOSTS && !list.some(h => h.ip === host.ip)) list.push(host);
            map.set(mac, list);
        }
    }
    cache = { at: Date.now(), map };
    return map;
}

/** MAC table rows with `hosts` ([{ hostname, ip }], empty when the MAC is not in the CMDB). */
function annotate(items) {
    let map;
    try {
        map = index();
    } catch (e) {
        // the MAC table matters more than the names: show it without them
        console.error('[netDevices] MAC host index failed:', e.message);
        map = new Map();
    }
    return (items || []).map(r => ({ ...r, hosts: map.get(r.mac) || [] }));
}

/** Test hooks: replace the record source (null restores the CMDB) and drop the index. */
function _setSource(fn) { source = fn || (() => require('../../services/cmdbModel').listMacRecords()); cache = null; }
function clear() { cache = null; }

module.exports = { annotate, macsOf, clear, TTL_MS, _setSource };
