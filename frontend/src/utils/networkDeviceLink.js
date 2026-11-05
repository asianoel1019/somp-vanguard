// Opening a device in Network Device from other screens (Server Rack, Topology Map).
// The target is handed over in sessionStorage (Network Device mounts after the view switch) and as an event
// (when it is already mounted); App.jsx keeps the feature flags here so links are shown only to users who may open it.

export const NETWORK_DEVICE_TYPES = ['Switch', 'Router', 'Firewall', 'LoadBalancer'];
export const OPEN_EVENT = 'somp:open-network-device';
const KEY = 'somp:openNetworkDevice';
const MAX_AGE_MS = 60 * 1000;

let features = {};

/** Called by App.jsx whenever the user's feature flags are loaded. */
export function setFeatureFlags(flags) { features = flags && typeof flags === 'object' ? flags : {}; }

/** True when `device` is a network device and this user can open Network Device. */
export function canOpenInNetworkDevice(device) {
    return !!device && NETWORK_DEVICE_TYPES.includes(device.type) && !!device.id && features.networkDevice !== false;
}

function storage() {
    try { return typeof window !== 'undefined' ? window.sessionStorage : null; } catch { return null; }
}

/** Switch to Network Device and open `deviceId` there (optionally on a tab: 'info', 'mgmt', 'cap:summary', ...). */
export function openInNetworkDevice(deviceId, tab) {
    const target = { id: String(deviceId), tab: tab || null, at: Date.now() };
    const s = storage();
    try { if (s) s.setItem(KEY, JSON.stringify(target)); } catch { /* private mode: the event still works when mounted */ }
    window.dispatchEvent(new CustomEvent('somp:navigate', { detail: { view: 'NETWORK_DEVICE' } }));
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: target }));
}

/** The pending target (once; stale ones are dropped). */
export function takePendingTarget(now = Date.now()) {
    const s = storage();
    if (!s) return null;
    let raw = null;
    try { raw = s.getItem(KEY); s.removeItem(KEY); } catch { return null; }
    return parseTarget(raw, now);
}

export function parseTarget(raw, now = Date.now()) {
    if (!raw) return null;
    try {
        const t = JSON.parse(raw);
        if (!t || typeof t.id !== 'string' || !t.id) return null;
        if (!Number.isFinite(t.at) || now - t.at > MAX_AGE_MS || now < t.at - MAX_AGE_MS) return null;
        return { id: t.id, tab: typeof t.tab === 'string' ? t.tab : null };
    } catch {
        return null;
    }
}
