// Pure helpers of the Network Device management tabs (no React, no api).

export const SECRET_MASK = '********';

// Capabilities in tab order, with their tab labels
export const CAPABILITY_TABS = [
    { key: 'summary', label: 'Overview' },
    { key: 'interfaces', label: 'Interfaces' },
    { key: 'policies', label: 'Policies' },
    { key: 'routes', label: 'Routes' },
    { key: 'sessions', label: 'Sessions' },
    { key: 'vpn', label: 'VPN' },
    { key: 'ha', label: 'HA' },
];

export const SCOPE_LABELS = { vdom: 'VDOM', vsys: 'vsys', domain: 'Domain' };

/** Tabs to show for a device: capability tabs only when a connection is saved and enabled. */
export function capabilityTabs(info) {
    const caps = info && info.profile && info.profile.enabled !== false ? info.capabilities || [] : [];
    return CAPABILITY_TABS.filter(t => caps.includes(t.key));
}

/** Form values for a saved profile (or a new one with the first available vendor of the type). */
export function formFromProfile(profile, vendors = []) {
    if (profile) {
        return {
            vendor: profile.vendor,
            mgmtHost: profile.mgmtHost || '',
            port: profile.port || '',
            username: profile.username || '',
            scope: profile.scope || '',
            target: profile.target || '',
            tlsVerify: !!profile.tlsVerify,
            caCert: profile.caCert || '',
            enabled: profile.enabled !== false,
            token: profile.secrets && profile.secrets.token ? SECRET_MASK : '',
            password: profile.secrets && profile.secrets.password ? SECRET_MASK : '',
            apiKey: profile.secrets && profile.secrets.apiKey ? SECRET_MASK : '',
        };
    }
    const v = vendors.find(x => x.available) || vendors[0] || {};
    return { vendor: v.id || '', mgmtHost: '', port: v.defaultPort || 443, username: '', scope: '', target: '', tlsVerify: false, caCert: '', enabled: true, token: '', password: '', apiKey: '' };
}

/** True when the saved secrets will be dropped by the server on save (address, port or vendor changed). */
export function targetChanged(profile, form) {
    if (!profile) return false;
    return profile.vendor !== form.vendor || profile.mgmtHost !== String(form.mgmtHost).trim() || Number(profile.port) !== Number(form.port || 0);
}

/** Request body for save / test: only the fields of the vendor's auth kind. */
export function payloadFromForm(form, vendor) {
    const body = {
        vendor: form.vendor,
        mgmtHost: String(form.mgmtHost || '').trim(),
        port: form.port === '' ? undefined : Number(form.port),
        scope: vendor && vendor.scope ? String(form.scope || '').trim() : '',
        target: vendor && vendor.target ? String(form.target || '').trim() : '',
        tlsVerify: !!form.tlsVerify,
        caCert: form.tlsVerify ? form.caCert || '' : '',
        enabled: form.enabled !== false,
    };
    const auth = vendor ? vendor.auth : 'token';
    if (auth === 'token') body.token = form.token;
    if (auth === 'password' || auth === 'apiKey') { body.username = String(form.username || '').trim(); body.password = form.password; }
    if (auth === 'apiKey') body.apiKey = form.apiKey;
    return body;
}

/** Two selected backup ids as [older, newer] by backup time. */
export function orderPair(backups, ids) {
    const at = (id) => { const b = (backups || []).find(x => x.id === id); return b ? Date.parse(b.at) : 0; };
    const [x, y] = ids;
    return at(x) <= at(y) ? [x, y] : [y, x];
}

/** Query string for a capability read. */
export function dataQuery(params = {}, refresh = false) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && String(v).trim() !== '') q.set(k, String(v).trim());
    if (refresh) q.set('refresh', '1');
    const s = q.toString();
    return s ? `?${s}` : '';
}

export function formatBytes(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(sec) {
    const s = Number(sec);
    if (!Number.isFinite(s) || s < 0) return '-';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    const h = Math.floor(s / 3600);
    return h < 24 ? `${h}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Badge colors for a status word. */
export function statusTone(status) {
    const s = String(status || '').toLowerCase();
    if (['up', 'ok', 'accept', 'enabled'].includes(s)) return 'success';
    if (['down', 'error', 'deny', 'disabled'].includes(s)) return 'danger';
    if (['partial', 'unknown'].includes(s)) return 'warning';
    return 'muted';
}

/** Message for a failed device read; the server's code tells what to do next. */
export function describeError(err) {
    const data = err && err.response && err.response.data;
    const msg = (data && data.error) || (err && err.message) || 'Request failed';
    const hint = {
        AUTH: '請檢查 API token / key 或帳號密碼是否正確、是否已過期。',
        FORBIDDEN: 'API 帳號權限不足（需要唯讀權限的 admin profile）。',
        UNREACHABLE: '連不到設備：請確認管理位址、埠號與防火牆是否允許 Vanguard 連線。',
        TLS: '憑證驗證失敗：請提供設備的 CA 憑證，或關閉憑證驗證。',
        NOT_CONFIGURED: '尚未設定管理連線，請到 Connection 頁籤設定。',
        UNSUPPORTED: '此設備或韌體版本不提供這項資料。',
    }[data && data.code];
    return hint ? `${msg} — ${hint}` : msg;
}
