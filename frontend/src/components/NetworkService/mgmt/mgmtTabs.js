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
    { key: 'vlans', label: 'VLAN' },
    { key: 'mac', label: 'MAC 表' },
    { key: 'virtuals', label: 'Virtual Servers' },
    { key: 'pools', label: 'Pools' },
    { key: 'certs', label: 'Certificates' },
];

// Tabs that only make sense on a switch (a router with the same driver has no VLAN / MAC table)
const SWITCH_ONLY = ['vlans', 'mac'];

export const TRANSPORT_LABELS = { auto: '自動（API 優先，不行改 SSH）', api: '只用 API', ssh: '只用 SSH' };

// The API of each switch / router vendor and what the Connection tab says about its ways in
const API_NAMES = { 'cisco-ios': 'RESTCONF', 'cisco-nxos': 'NX-API', juniper: 'REST API' };
const AUTO_RULE = '帳密錯誤、權限不足、憑證錯誤不會改試，避免帳號被鎖。';
const TRANSPORT_HINTS = {
    'cisco-ios': `API 為 RESTCONF（使用上方 API Port，帳號需 privilege 15）；SSH 只會執行固定的 show 指令（不進設定模式）。「自動」先用上次成功的方式（沒有時先試 RESTCONF），設備沒回應或沒開 RESTCONF 才改用 SSH；${AUTO_RULE}設定備份一律走 SSH，帳號權限不到 15 級時需要 Enable 密碼。`,
    'cisco-nxos': `API 為 NX-API（設備需 feature nxapi，使用上方 API Port；帳號角色 network-operator 即可）；SSH 只會執行固定的 show … | json 指令。「自動」先用上次成功的方式（沒有時先試 NX-API），設備沒回應或沒開 NX-API 才改用 SSH；${AUTO_RULE}設定備份走目前的連線方式。`,
    juniper: `API 為 Junos REST API（設備需 set system services rest https，使用上方 API Port，預設 3443；帳號 login class read-only 即可）；SSH 只會執行固定的 show … | display json 指令。「自動」先用上次成功的方式（沒有時先試 REST API），設備沒回應或沒開 REST 才改用 SSH；${AUTO_RULE}設定備份一律走 SSH（show configuration | display set）。`,
};

/** Name of a vendor's API ("RESTCONF", "NX-API", ...). */
export const apiName = (vendorId) => API_NAMES[vendorId] || 'API';
/** What the Connection tab says about a vendor's API and SSH ways in. */
export const transportHint = (vendorId) => TRANSPORT_HINTS[vendorId] || `「自動」先試 API，設備沒回應才改用 SSH；${AUTO_RULE}`;

export const SCOPE_LABELS = { vdom: 'VDOM', vsys: 'vsys', domain: 'Domain', partition: 'Partition' };

/** Tabs to show for a device: capability tabs only when a connection is saved and enabled. */
export function capabilityTabs(info) {
    const caps = info && info.profile && info.profile.enabled !== false ? info.capabilities || [] : [];
    const isSwitch = info && info.device ? info.device.type === 'Switch' : true;
    return CAPABILITY_TABS.filter(t => caps.includes(t.key) && (isSwitch || !SWITCH_ONLY.includes(t.key)));
}

/**
 * Tab bar of the device window in three groups: live state read over the management connection,
 * SNMP polling and settings. Each tab: { key, label, poll?, dim?, dot? } where poll means opening it
 * starts an SNMP poll, dim that SNMP is off, dot a 'danger' / 'warning' marker.
 * opts: role, snmp ('ok' | 'missing' | 'off' from snmpState), health (from deviceHealth).
 */
export function detailTabGroups(info, { role = 'Viewer', snmp = 'off', health = 'none' } = {}) {
    const groups = [];
    const live = capabilityTabs(info).map(t => ({ key: `cap:${t.key}`, label: t.label }));
    if (live.length) groups.push({ key: 'live', label: '即時狀態', tabs: live });
    const dim = snmp === 'off';
    groups.push({ key: 'snmp', label: 'SNMP', tabs: [
        { key: 'ports', label: '連接埠', poll: true, dim },
        { key: 'arp', label: 'ARP', poll: true, dim },
        { key: 'mac', label: 'MAC（SNMP）', poll: true, dim },
    ] });
    const settings = [
        { key: 'info', label: '基本資料 & SNMP', dot: snmp === 'missing' ? 'warning' : null },
        { key: 'mgmt', label: '管理連線', dot: health === 'error' ? 'danger' : null },
    ];
    if (role !== 'Viewer' && info && info.profile && info.backup) settings.push({ key: 'backup', label: '設定備份' });
    groups.push({ key: 'settings', label: '設定', tabs: settings });
    return groups;
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
            enableSecret: profile.secrets && profile.secrets.enableSecret ? SECRET_MASK : '',
            transport: profile.transport || 'auto',
            sshPort: profile.sshPort || 22,
            loginProvider: profile.loginProvider || 'tmos',
        };
    }
    const v = vendors.find(x => x.available) || vendors[0] || {};
    return { vendor: v.id || '', mgmtHost: '', port: v.defaultPort || 443, username: '', scope: '', target: '', tlsVerify: false, caCert: '', enabled: true, token: '', password: '', apiKey: '', enableSecret: '', transport: 'auto', sshPort: 22, loginProvider: 'tmos' };
}

/** True when the saved secrets will be dropped by the server on save (address, port, SSH port or vendor changed). */
export function targetChanged(profile, form) {
    if (!profile) return false;
    if (profile.sshPort && Number(profile.sshPort) !== Number(form.sshPort || 22)) return true;
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
    if (vendor && vendor.transports) {
        body.transport = form.transport || 'auto';
        body.sshPort = form.sshPort === '' ? undefined : Number(form.sshPort);
    }
    if (vendor && vendor.enable) body.enableSecret = form.enableSecret;
    if (vendor && vendor.loginProvider) body.loginProvider = String(form.loginProvider || '').trim() || 'tmos';
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

/** Interfaces shown with the 'errors only' / 'down only' filters. */
export function filterInterfaces(list, { errorsOnly = false, downOnly = false } = {}) {
    const errs = (i) => ['inErrors', 'crcErrors', 'outErrors'].some(k => Number(i[k]) > 0);
    return (list || []).filter(i => (!errorsOnly || errs(i)) && (!downOnly || i.status !== 'up'));
}

/** Bits per second -> '12.3 Mb/s'. */
export function formatBps(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '-';
    const units = ['b/s', 'kb/s', 'Mb/s', 'Gb/s', 'Tb/s'];
    let v = Number(n);
    let i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i += 1; }
    return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** Badge colors for a status word. */
export function statusTone(status) {
    const s = String(status || '').toLowerCase();
    if (['up', 'ok', 'accept', 'enabled', 'active', 'connected', 'green', 'in sync'].includes(s)) return 'success';
    if (['down', 'error', 'deny', 'disabled', 'err-disabled', 'suspended', 'red', 'offline', 'forced-offline'].includes(s)) return 'danger';
    if (['admin-down', 'gray', 'standby'].includes(s)) return 'muted';
    if (['partial', 'unknown', 'yellow', 'changes pending', 'awaiting initial sync'].includes(s)) return 'warning';
    if (['blue'].includes(s)) return 'info';
    return 'muted';
}

/** Message for a failed device read; the server's code tells what to do next. */
export function describeError(err) {
    const data = err && err.response && err.response.data;
    const msg = (data && data.error) || (err && err.message) || 'Request failed';
    const hint = {
        AUTH: '請檢查 API token / key 或帳號密碼是否正確、是否已過期。',
        FORBIDDEN: '帳號權限不足：Firewall 需要唯讀的 admin profile；Cisco 走 RESTCONF 需要 privilege 15 帳號（不允許時改用「只用 SSH」），設定備份需要 privilege 15 或設定 Enable 密碼；NX-OS 帳號需要 network-operator 以上角色；Junos 帳號需要 read-only 以上 login class；F5 帳號需要 Auditor 以上角色（並可看到該 partition）。',
        UNREACHABLE: '連不到設備：請確認管理位址、埠號與防火牆是否允許 Vanguard 連線。',
        TLS: '憑證驗證失敗：請提供設備的 CA 憑證，或關閉憑證驗證。',
        NOT_CONFIGURED: '尚未設定管理連線，請到「管理連線」頁籤設定。',
        UNSUPPORTED: '此設備或韌體版本不提供這項資料。',
        HOSTKEY: '設備的 SSH 主機金鑰與第一次連線時不同。確認設備確實更換過後，到「管理連線」頁籤按「重設主機金鑰」。',
    }[data && data.code];
    return hint ? `${msg} — ${hint}` : msg;
}
