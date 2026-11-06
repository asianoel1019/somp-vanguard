// Pure helpers of the Network Device list: health of each device, the summary cards, filters and order.

export const TYPE_ORDER = ['Firewall', 'Switch', 'Router', 'LoadBalancer'];

/**
 * Health of a device from its management connection:
 * 'error' (last read failed), 'ok', 'pending' (saved, never read), 'disabled' (connection turned off),
 * 'none' (no management connection).
 */
export function deviceHealth(d) {
    const m = d && d.mgmt;
    if (!m) return 'none';
    if (m.enabled === false) return 'disabled';
    if (m.lastStatus === 'error') return 'error';
    if (m.lastStatus === 'ok') return 'ok';
    return 'pending';
}

/** SNMP state: 'off' (turned off), 'ok' (credentials set), 'missing' (on but no community / v3 user). */
export function snmpState(d) {
    if (!d || d.enabled === false) return 'off';
    return d.snmp && (d.snmp.community || d.snmp.v3User) ? 'ok' : 'missing';
}

/** Numbers of the summary cards. */
export function summarize(devices) {
    const out = { total: 0, ok: 0, error: 0, none: 0, snmpMissing: 0 };
    for (const d of devices || []) {
        out.total += 1;
        const h = deviceHealth(d);
        if (h === 'ok') out.ok += 1;
        if (h === 'error') out.error += 1;
        if (h === 'none') out.none += 1;
        if (snmpState(d) === 'missing') out.snmpMissing += 1;
    }
    return out;
}

/** Device types with their counts, known types first. */
export function typeCounts(devices) {
    const counts = {};
    for (const d of devices || []) if (d.type) counts[d.type] = (counts[d.type] || 0) + 1;
    const rank = (t) => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? TYPE_ORDER.length : i; };
    return Object.keys(counts).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).map(type => ({ type, count: counts[type] }));
}

// Quick filters of the summary cards
export const QUICK_FILTERS = {
    all: () => true,
    ok: d => deviceHealth(d) === 'ok',
    error: d => deviceHealth(d) === 'error',
    none: d => deviceHealth(d) === 'none',
    snmpMissing: d => snmpState(d) === 'missing',
};

/** Devices matching the data center, type, quick filter and search text (host, IP, vendor, model). */
export function filterDevices(devices, { dc = 'All', type = 'All', quick = 'all', search = '' } = {}) {
    const q = String(search || '').trim().toLowerCase();
    const quickFn = QUICK_FILTERS[quick] || QUICK_FILTERS.all;
    return (devices || []).filter((d) => {
        if (dc !== 'All' && d.datacenter !== dc) return false;
        if (type !== 'All' && d.type !== type) return false;
        if (!quickFn(d)) return false;
        if (!q) return true;
        const m = d.mgmt || {};
        return [d.hostname, d.ip, m.vendorLabel, m.model].some(v => v && String(v).toLowerCase().includes(q));
    });
}

const HEALTH_RANK = { error: 0, pending: 1, ok: 2, disabled: 3, none: 4 };

/** Failing devices first, then by host name (natural order: sw2 before sw10). */
export function sortDevices(devices) {
    return [...(devices || [])].sort((a, b) => HEALTH_RANK[deviceHealth(a)] - HEALTH_RANK[deviceHealth(b)]
        || String(a.hostname || '').localeCompare(String(b.hostname || ''), undefined, { numeric: true, sensitivity: 'base' }));
}

/** "剛剛", "5 分鐘前", "3 小時前", "2 天前" (null when no time). */
export function relativeTime(iso, now = Date.now()) {
    const t = Date.parse(iso || '');
    if (Number.isNaN(t)) return null;
    const min = Math.floor((now - t) / 60000);
    if (min < 1) return '剛剛';
    if (min < 60) return `${min} 分鐘前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小時前`;
    return `${Math.floor(h / 24)} 天前`;
}

/** Second line of the vendor cell: what to know about the connection. */
export function connectionNote(d, now = Date.now()) {
    const m = d && d.mgmt;
    const h = deviceHealth(d);
    if (h === 'none') return '未設定管理連線';
    if (h === 'disabled') return '管理連線已停用';
    if (h === 'pending') return '尚未讀取';
    const when = relativeTime(m.lastCheckedAt, now);
    if (h === 'error') {
        const msg = String(m.lastError || '讀取失敗').replace(/\s+/g, ' ');
        return `${msg.length > 80 ? `${msg.slice(0, 80)}…` : msg}${when ? `（${when}）` : ''}`;
    }
    return when ? `最後讀取 ${when}` : '';
}
