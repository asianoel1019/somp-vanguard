// FortiGate (FortiOS REST API v2, read only). Authenticates with a REST API admin token (Bearer); the VDOM of the
// profile scope goes with every request. Answers are normalized (see the spec) and keep the device's own record in `raw`.
const net = require('net');
const { createClient } = require('../httpClient');
const { netError } = require('../errors');

const capabilities = ['summary', 'interfaces', 'policies', 'routes', 'sessions', 'vpn', 'ha'];
const SESSION_MAX = 500;
const POLICY_LIMIT = 50;
const POLICY_MAX = 200;

function clientFor(profile) {
    const token = (profile.secrets && profile.secrets.token) || '';
    if (!token) throw netError('NOT_CONFIGURED', 'No API token stored for this device');
    return createClient({
        host: profile.mgmtHost,
        port: profile.port,
        tlsVerify: profile.tlsVerify,
        caCert: profile.caCert,
        headers: { Authorization: `Bearer ${token}` },
        secrets: [token],
    });
}

/** GET an /api/v2 path; returns `results` (FortiOS wraps every answer), with the envelope's top-level fields. */
async function get(profile, path, params = {}, client = clientFor(profile)) {
    const data = await client.request({ path: `/api/v2/${path}`, params: { ...(profile.scope ? { vdom: profile.scope } : {}), ...params } });
    if (!data || typeof data !== 'object') throw netError('OTHER', 'The device answered with something that is not JSON');
    if (data.status === 'error') throw netError(data.http_status === 404 ? 'UNSUPPORTED' : 'OTHER', `The device reported an error${data.http_status ? ` (${data.http_status})` : ''}`);
    return { results: data.results !== undefined ? data.results : data, envelope: data };
}

const names = (list) => (Array.isArray(list) ? list.map(x => (x && (x.name || x['interface-name'])) || '').filter(Boolean) : []);
const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const first = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
const epochIso = (s) => (num(s) ? new Date(Number(s) * 1000).toISOString() : null);

/** "192.0.2.1 255.255.255.0" or { ip, mask } -> "192.0.2.1/24" */
function cidr(ip, mask) {
    let a = ip;
    let m = mask;
    if (typeof ip === 'string' && ip.includes(' ')) [a, m] = ip.split(/\s+/);
    if (!a || a === '0.0.0.0') return null;
    if (m === undefined || m === null || m === '') return a;
    if (/^\d+$/.test(String(m))) return `${a}/${m}`;
    const bits = String(m).split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).split('').filter(c => c === '1').length, 0);
    return `${a}/${bits}`;
}

async function testConnection(profile) {
    const { results, envelope } = await get(profile, 'monitor/system/status');
    return statusFacts(results, envelope);
}

function statusFacts(r, env) {
    return {
        model: r.model_name ? `${r.model_name}${r.model_number ? ` ${r.model_number}` : ''}`.trim() : (r.model || null),
        hostname: r.hostname || null,
        version: env.version || r.version || null,
        build: num(env.build),
        serial: env.serial || r.serial || null,
    };
}

async function getSummary(profile) {
    const client = clientFor(profile);
    const { results, envelope } = await get(profile, 'monitor/system/status', {}, client);
    const facts = statusFacts(results, envelope);
    // resources and HA are extras: an account without those permissions still gets the summary
    const [res, ha] = await Promise.all([
        get(profile, 'monitor/system/resource/usage', { scope: 'global' }, client).then(x => x.results).catch(() => null),
        get(profile, 'cmdb/system/ha', {}, client).then(x => x.results).catch(() => null),
    ]);
    const cur = (k) => { const x = res && first(res[k]); return x ? num(x.current) : null; };
    return {
        ...facts,
        vdom: profile.scope || envelope.vdom || null,
        cpu: cur('cpu'),
        memory: cur('mem'),
        disk: cur('disk'),
        sessions: cur('session'),
        haMode: ha && typeof ha === 'object' ? (ha.mode || null) : null,
        raw: { status: results, resources: res },
    };
}

async function getInterfaces(profile) {
    const client = clientFor(profile);
    const [mon, conf, zones] = await Promise.all([
        get(profile, 'monitor/system/interface', { include_vlan: true }, client).then(x => x.results),
        get(profile, 'cmdb/system/interface', {}, client).then(x => x.results).catch(() => []),
        get(profile, 'cmdb/system/zone', {}, client).then(x => x.results).catch(() => []),
    ]);
    const zoneOf = {};
    for (const z of Array.isArray(zones) ? zones : []) for (const i of names(z.interface)) zoneOf[i] = z.name;
    const confOf = {};
    for (const c of Array.isArray(conf) ? conf : []) confOf[c.name] = c;
    const list = Array.isArray(mon) ? mon : Object.values(mon || {});
    return list.map((m) => {
        const c = confOf[m.name] || {};
        return {
            name: m.name,
            alias: m.alias || c.alias || '',
            ip: cidr(m.ip, m.mask) || cidr(c.ip),
            status: m.link === true ? 'up' : m.link === false ? 'down' : (c.status || 'unknown'),
            adminStatus: c.status || null,
            speed: num(m.speed),
            vlan: num(m.vlanid) || num(c.vlanid),
            type: c.type || null,
            zone: zoneOf[m.name] || null,
            rxBytes: num(m.rx_bytes),
            txBytes: num(m.tx_bytes),
            rxErrors: num(m.rx_errors),
            txErrors: num(m.tx_errors),
            raw: m,
        };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
}

async function getPolicies(profile, opts = {}) {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || POLICY_LIMIT, 1), POLICY_MAX);
    const page = Math.max(parseInt(opts.page, 10) || 1, 1);
    const search = String(opts.search || '').trim().toLowerCase().slice(0, 100);
    const client = clientFor(profile);
    const [conf, hits] = await Promise.all([
        get(profile, 'cmdb/firewall/policy', {}, client).then(x => x.results),
        get(profile, 'monitor/firewall/policy', {}, client).then(x => x.results).catch(() => null),
    ]);
    const hitOf = {};
    for (const h of Array.isArray(hits) ? hits : []) hitOf[h.policyid] = h;
    let items = (Array.isArray(conf) ? conf : []).map((p) => {
        const h = hitOf[p.policyid];
        return {
            id: p.policyid,
            name: p.name || '',
            enabled: p.status !== 'disable',
            action: p.action || null,
            from: names(p.srcintf),
            to: names(p.dstintf),
            source: names(p.srcaddr),
            destination: names(p.dstaddr),
            service: names(p.service),
            nat: p.nat === 'enable',
            hitCount: h ? num(h.hit_count) : null,
            bytes: h ? num(h.bytes) : null,
            lastHit: h ? epochIso(h.last_used) : null,
            comment: p.comments || '',
            raw: p,
        };
    });
    if (search) {
        items = items.filter(p => [p.id, p.name, p.action, p.comment, ...p.from, ...p.to, ...p.source, ...p.destination, ...p.service]
            .some(v => String(v).toLowerCase().includes(search)));
    }
    const total = items.length;
    return { total, page, limit, hitCounts: !!hits, items: items.slice((page - 1) * limit, page * limit) };
}

async function getRoutes(profile) {
    const { results } = await get(profile, 'monitor/router/ipv4');
    return (Array.isArray(results) ? results : []).map(r => ({
        destination: r.ip_mask || cidr(r.ip, r.mask),
        gateway: r.gateway && r.gateway !== '0.0.0.0' ? r.gateway : null,
        interface: r.interface || null,
        type: r.type || null,
        distance: num(r.distance),
        metric: num(r.metric),
        raw: r,
    }));
}

/** Sessions matching a filter (the table can hold millions; an unfiltered read is refused). */
async function getSessions(profile, opts = {}) {
    const params = { count: SESSION_MAX };
    for (const k of ['src', 'dst']) {
        const v = String(opts[k] || '').trim();
        if (!v) continue;
        if (!net.isIP(v)) throw netError('BAD_REQUEST', `${k === 'src' ? 'Source' : 'Destination'} must be an IP address`);
        params[k === 'src' ? 'srcaddr' : 'dstaddr'] = v;
    }
    if (opts.dport !== undefined && opts.dport !== '') {
        const p = Number(opts.dport);
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw netError('BAD_REQUEST', 'Destination port must be 1-65535');
        params.dport = p;
    }
    if (!params.srcaddr && !params.dstaddr && !params.dport) throw netError('BAD_REQUEST', 'Give a source, destination or destination port to filter the sessions');
    const { results } = await get(profile, 'monitor/firewall/session', params);
    const rows = Array.isArray(results) ? results : (results && Array.isArray(results.details) ? results.details : []);
    const total = results && !Array.isArray(results) && num(results.total) !== null ? num(results.total) : rows.length;
    return {
        total,
        truncated: total > rows.length,
        items: rows.slice(0, SESSION_MAX).map(s => ({
            protocol: s.proto || s.protocol || null,
            source: s.saddr || null,
            sourcePort: num(s.sport),
            destination: s.daddr || null,
            destinationPort: num(s.dport),
            policyId: num(s.policyid),
            state: s.state || null,
            duration: num(s.duration),
            bytes: (num(s.sentbyte) || 0) + (num(s.rcvdbyte) || 0),
            raw: s,
        })),
    };
}

async function getVpn(profile) {
    const client = clientFor(profile);
    const [ipsec, ssl] = await Promise.all([
        get(profile, 'monitor/vpn/ipsec', {}, client).then(x => x.results).catch((e) => { if (e.code === 'UNSUPPORTED') return []; throw e; }),
        get(profile, 'monitor/vpn/ssl', {}, client).then(x => x.results).catch(() => []),
    ]);
    const tunnels = (Array.isArray(ipsec) ? ipsec : []).map((t) => {
        const proxies = Array.isArray(t.proxyid) ? t.proxyid : [];
        const up = proxies.filter(p => p.status === 'up').length;
        return {
            name: t.name,
            type: 'ipsec',
            peer: t.rgwy || null,
            status: proxies.length ? (up === proxies.length ? 'up' : up ? 'partial' : 'down') : 'down',
            user: t.xauth_user || null,
            bytesIn: num(t.incoming_bytes),
            bytesOut: num(t.outgoing_bytes),
            phase2: proxies.map(p => ({ name: p.p2name, status: p.status, bytesIn: num(p.incoming_bytes), bytesOut: num(p.outgoing_bytes) })),
            raw: t,
        };
    });
    const users = (Array.isArray(ssl) ? ssl : []).map(u => ({
        name: u.user_name || '',
        type: 'ssl',
        peer: u.remote_host || null,
        status: 'up',
        user: u.user_name || null,
        bytesIn: null,
        bytesOut: null,
        since: epochIso(u.last_login_time),
        tunnelIp: (first(u.subsessions) || {}).aip || null,
        raw: u,
    }));
    return { tunnels, users };
}

async function getHa(profile) {
    const client = clientFor(profile);
    const [conf, peers] = await Promise.all([
        get(profile, 'cmdb/system/ha', {}, client).then(x => x.results),
        get(profile, 'monitor/system/ha-peer', {}, client).then(x => x.results).catch(() => []),
    ]);
    const c = conf && typeof conf === 'object' ? conf : {};
    return {
        mode: c.mode || 'standalone',
        group: c['group-name'] || null,
        priority: num(c.priority),
        members: (Array.isArray(peers) ? peers : []).map(p => ({
            hostname: p.hostname || null,
            serial: p.serial_no || null,
            priority: num(p.priority),
            primary: p.is_primary === true || p.primary === true || p.role === 'primary',
            raw: p,
        })),
        raw: c,
    };
}

/**
 * Full configuration as text. FortiOS up to 7.4 answers GET monitor/system/config/backup; 7.6 wants a POST.
 * A token limited to one VDOM gets that VDOM's configuration.
 */
async function backupConfig(profile) {
    const client = clientFor(profile);
    const params = profile.scope ? { scope: 'vdom', vdom: profile.scope } : { scope: 'global' };
    let content;
    try {
        content = await client.request({ path: '/api/v2/monitor/system/config/backup', params, responseType: 'text', headers: { Accept: '*/*' } });
    } catch (err) {
        if (err.code !== 'UNSUPPORTED') throw err;
        content = await client.request({ method: 'POST', path: '/api/v2/monitor/system/config/backup', params: profile.scope ? { vdom: profile.scope } : {}, data: { destination: 'file', ...params }, responseType: 'text', headers: { Accept: '*/*' } });
    }
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    // an error comes back as JSON, a configuration starts with #config-version or "config ..."
    if (!/^\s*(#config-version|config\s)/m.test(text.slice(0, 2000))) throw netError('OTHER', 'The device did not return a configuration');
    return { content: text, format: 'conf' };
}

module.exports = { backupConfig, capabilities, testConnection, getSummary, getInterfaces, getPolicies, getRoutes, getSessions, getVpn, getHa, _cidr: cidr };
