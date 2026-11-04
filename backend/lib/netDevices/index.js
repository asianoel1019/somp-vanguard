// Network device drivers: picks the driver of a device's vendor, caches its answers for a short while and lets only
// one identical request per device run at a time (a page refreshing every few seconds must not flood a firewall).
const profileStore = require('./profileStore');
const backups = require('./backups');
const { netError } = require('./errors');

const CACHE_MS = 30 * 1000;
const CAPABILITIES = ['summary', 'interfaces', 'policies', 'routes', 'sessions', 'vpn', 'ha'];
const METHOD = { summary: 'getSummary', interfaces: 'getInterfaces', policies: 'getPolicies', routes: 'getRoutes', sessions: 'getSessions', vpn: 'getVpn', ha: 'getHa' };

const drivers = {
    fortigate: require('./drivers/fortigate'),
    paloalto: require('./drivers/paloalto'),
    checkpoint: require('./drivers/checkpoint'),
};
backups.setDrivers(drivers);

const cache = new Map();    // `${id}|${cap}|${opts}` -> { at, value }
const inFlight = new Map(); // same key -> Promise

/** Vendors offered for a device type (all of them when no type is given). */
function vendorList(type) {
    return Object.entries(profileStore.VENDORS)
        .filter(([, v]) => !type || v.types.includes(type))
        .map(([id, v]) => ({ id, ...v, available: v.available && !!drivers[id], capabilities: capabilitiesOf(id), backup: backups.canBackup(id) }));
}

function capabilitiesOf(vendor) {
    const d = drivers[vendor];
    return d ? CAPABILITIES.filter(c => d.capabilities.includes(c)) : [];
}

function driverFor(vendor) {
    const d = drivers[vendor];
    if (!d) throw netError('UNSUPPORTED', `No driver for vendor ${vendor}`);
    return d;
}

const cacheKey = (id, cap, opts) => `${id}|${cap}|${JSON.stringify(opts || {})}`;

/**
 * Read one capability of a configured device.
 * @returns {Promise<{ data: any, cachedAt: string, fromCache: boolean }>}
 */
async function runCapability(deviceId, capability, opts = {}, { refresh = false } = {}) {
    if (!CAPABILITIES.includes(capability)) throw netError('BAD_REQUEST', `Unknown capability: ${capability}`);
    const profile = profileStore.getProfile(deviceId);
    if (!profile) throw netError('NOT_CONFIGURED', 'This device has no management connection');
    if (profile.enabled === false) throw netError('NOT_CONFIGURED', 'The management connection of this device is disabled');
    const driver = driverFor(profile.vendor);
    if (!driver.capabilities.includes(capability)) throw netError('UNSUPPORTED', `${capability} is not available for this vendor`);

    const key = cacheKey(deviceId, capability, opts);
    const hit = cache.get(key);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return { data: hit.value, cachedAt: new Date(hit.at).toISOString(), fromCache: true };
    if (inFlight.has(key)) return inFlight.get(key);

    const p = (async () => {
        try {
            const value = await driver[METHOD[capability]](profile, opts);
            const at = Date.now();
            cache.set(key, { at, value });
            profileStore.recordStatus(deviceId, { ok: true, facts: capability === 'summary' ? factsOf(value) : undefined });
            return { data: value, cachedAt: new Date(at).toISOString(), fromCache: false };
        } catch (err) {
            // only failures of the device itself change its status; a bad request to Vanguard does not
            if (!['BAD_REQUEST', 'UNSUPPORTED'].includes(err.code)) profileStore.recordStatus(deviceId, { ok: false, error: err.message });
            throw err;
        } finally {
            inFlight.delete(key);
        }
    })();
    inFlight.set(key, p);
    return p;
}

/** Facts kept with the profile for the device list. */
function factsOf(summary) {
    if (!summary || typeof summary !== 'object') return undefined;
    const pick = ['model', 'version', 'serial', 'hostname', 'haMode'];
    return Object.fromEntries(pick.filter(k => summary[k] !== undefined && summary[k] !== null).map(k => [k, summary[k]]));
}

/**
 * Try a connection without saving it (the target comes from profileStore.testTarget).
 * @returns {Promise<object>} the device facts
 */
async function testConnection(target) {
    return driverFor(target.vendor).testConnection(target);
}

/** Forget cached answers of a device (after its connection changed), or all of them. */
function clearCache(deviceId) {
    if (!deviceId) { cache.clear(); return; }
    for (const k of cache.keys()) if (k.startsWith(`${deviceId}|`)) cache.delete(k);
}

module.exports = { CAPABILITIES, CACHE_MS, vendorList, capabilitiesOf, canBackup: backups.canBackup, runCapability, testConnection, clearCache, factsOf, _drivers: drivers };
