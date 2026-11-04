// Check Point (Management API on the Security Management / Multi-Domain server, read only). Logs in read-only with
// user + password or an API key; the session id is kept in memory and reused until it expires. The rack device is one
// gateway (or cluster) of that server: the profile `target` names it, or the server's only gateway is used.
// The management API holds configuration, not the gateway's live state: routes, sessions and VPN are not offered.
const crypto = require('crypto');
const { createClient } = require('../httpClient');
const { netError, NetDeviceError } = require('../errors');

const capabilities = ['summary', 'interfaces', 'policies', 'ha'];
const SESSION_TIMEOUT_S = 600;
const PAGE = 500;
const MAX_RULES = 5000;
const POLICY_LIMIT = 50;
const POLICY_MAX = 200;
// Objects of show-gateways-and-servers that are not a gateway the rack device can be
const NOT_GATEWAY = new Set(['CpmiHostCkp', 'checkpoint-host', 'CpmiClusterMember', 'cluster-member', 'CpmiLogServer']);
const CLUSTER_TYPES = new Set(['CpmiGatewayCluster', 'simple-cluster', 'CpmiVsxClusterNetobj', 'CpmiVsClusterNetobj']);

const sessions = new Map(); // profile identity -> { sid, until } | Promise

const sessionId = (p) => {
    const s = p.secrets || {};
    return `${p.mgmtHost}:${p.port}:${p.scope || ''}:${p.username || ''}:${crypto.createHash('sha256').update(String(s.apiKey || s.password || '')).digest('hex')}`;
};

function clientFor(profile, sid) {
    const s = profile.secrets || {};
    return createClient({
        host: profile.mgmtHost,
        port: profile.port,
        tlsVerify: profile.tlsVerify,
        caCert: profile.caCert,
        headers: { 'Content-Type': 'application/json', ...(sid ? { 'X-chkp-sid': sid } : {}) },
        secrets: [s.apiKey, s.password].filter(Boolean),
        timeoutMs: 30000, // rulebase pages of a large policy can take a while on the management server
    });
}

async function login(profile) {
    const s = profile.secrets || {};
    let body;
    if (s.apiKey) body = { 'api-key': s.apiKey };
    else if (profile.username && s.password) body = { user: profile.username, password: s.password };
    else throw netError('NOT_CONFIGURED', 'No API key or password stored for this device');
    body['read-only'] = true;
    body['session-timeout'] = SESSION_TIMEOUT_S;
    body['session-name'] = 'SOMP Vanguard (read only)';
    if (profile.scope) body.domain = profile.scope;
    const data = await clientFor(profile).request({ method: 'POST', path: '/web_api/login', data: body }).catch((e) => {
        // a refused login answers 400 / 401 / 403 depending on the version
        if (e instanceof NetDeviceError && (e.code === 'FORBIDDEN' || e.code === 'AUTH' || /HTTP 400/.test(e.message))) {
            throw netError('AUTH', 'The management server rejected the login (user, password, API key or domain)');
        }
        throw e;
    });
    if (!data || !data.sid) throw netError('AUTH', 'The management server did not return a session');
    return { sid: data.sid, until: Date.now() + (SESSION_TIMEOUT_S - 60) * 1000 };
}

async function session(profile, renew) {
    const id = sessionId(profile);
    const cur = sessions.get(id);
    if (!renew && cur) {
        if (typeof cur.then === 'function') return cur;
        if (cur.until > Date.now()) return cur;
    }
    const p = login(profile).then((x) => { sessions.set(id, x); return x; }, (e) => { sessions.delete(id); throw e; });
    sessions.set(id, p);
    return p;
}

/** One API command; an expired session is renewed once. */
async function api(profile, command, body = {}, { retried = false } = {}) {
    const { sid } = await session(profile, retried);
    try {
        return await clientFor(profile, sid).request({ method: 'POST', path: `/web_api/${command}`, data: body });
    } catch (e) {
        if (!retried && e.code === 'AUTH') return api(profile, command, body, { retried: true });
        if (e.code === 'FORBIDDEN') throw netError('FORBIDDEN', 'The account has no permission for this request (403)');
        throw e;
    }
}

const isCluster = (g) => CLUSTER_TYPES.has(g.type);
const ipv4 = (o) => o['ipv4-address'] || null;

async function listGateways(profile) {
    const out = [];
    for (let offset = 0; offset < 2000; offset += PAGE) {
        const page = await api(profile, 'show-gateways-and-servers', { 'details-level': 'full', limit: PAGE, offset });
        out.push(...(page.objects || []));
        if (!page.total || out.length >= page.total || !(page.objects || []).length) break;
    }
    return out.filter(o => o && !NOT_GATEWAY.has(o.type));
}

/** The gateway of this device: by the configured name / IP, or the only one there is. */
async function gatewayOf(profile) {
    const gws = await listGateways(profile);
    const want = String(profile.target || '').trim().toLowerCase();
    if (want) {
        const g = gws.find(x => String(x.name).toLowerCase() === want || ipv4(x) === want);
        if (!g) throw netError('BAD_REQUEST', `No gateway named ${profile.target} on the management server`);
        return { gateway: g, all: gws };
    }
    if (gws.length === 1) return { gateway: gws[0], all: gws };
    if (!gws.length) throw netError('UNSUPPORTED', 'The management server has no gateways');
    throw netError('BAD_REQUEST', `The management server has ${gws.length} gateways (${gws.slice(0, 5).map(x => x.name).join(', ')}${gws.length > 5 ? ', ...' : ''}): set the gateway name in the connection`);
}

const policyName = (g) => (g.policy && g.policy['access-policy-name']) || null;

function gatewayFacts(g) {
    return {
        model: g.hardware || (isCluster(g) ? 'Check Point cluster' : 'Check Point gateway'),
        hostname: g.name || null,
        version: g.version || null,
        serial: null,
    };
}

async function testConnection(profile) {
    const ver = await api(profile, 'show-api-versions');
    const { gateway, note } = await gatewayOf(profile).catch((e) => {
        // credentials work; a missing gateway name is reported but does not fail the login test
        if (e.code === 'BAD_REQUEST' || e.code === 'UNSUPPORTED') return { gateway: null, note: e.message };
        throw e;
    });
    return { ...(gateway ? gatewayFacts(gateway) : { model: 'Check Point management', hostname: null, version: null, serial: null }), apiVersion: ver['current-version'] || null, ...(note ? { note } : {}) };
}

async function getSummary(profile) {
    const [ver, { gateway, all }] = await Promise.all([api(profile, 'show-api-versions'), gatewayOf(profile)]);
    return {
        ...gatewayFacts(gateway),
        ip: ipv4(gateway),
        os: gateway['os-name'] || null,
        policy: policyName(gateway),
        policyInstalled: gateway.policy ? gateway.policy['access-policy-installed'] === true : null,
        sic: gateway['sic-state'] || null,
        cluster: isCluster(gateway),
        domain: profile.scope || null,
        managementApi: ver['current-version'] || null,
        gateways: all.map(g => ({ name: g.name, type: g.type, ip: ipv4(g), version: g.version || null })),
        cpu: null,
        memory: null,
        disk: null,
        sessions: null,
        haMode: isCluster(gateway) ? (gateway['cluster-mode'] || 'cluster') : 'standalone',
        raw: { gateway },
    };
}

/** Gateway or cluster object with its interfaces (and members for a cluster). */
async function gatewayDetail(profile) {
    const { gateway } = await gatewayOf(profile);
    const cmd = isCluster(gateway) ? 'show-simple-cluster' : 'show-simple-gateway';
    const detail = await api(profile, cmd, { uid: gateway.uid }).catch((e) => {
        // VSX and other special objects are not "simple": fall back to the list entry
        if (e.code === 'UNSUPPORTED' || e.code === 'OTHER') return gateway;
        throw e;
    });
    return { gateway, detail };
}

async function getInterfaces(profile) {
    const { detail } = await gatewayDetail(profile);
    return (detail.interfaces || []).map((i) => {
        const len = i['ipv4-mask-length'];
        const ip = i['ipv4-address'];
        return {
            name: i['interface-name'] || i.name,
            alias: i.comments || '',
            ip: ip ? (len !== undefined && len !== null ? `${ip}/${len}` : ip) : null,
            status: null, // configuration only: the management API has no link state
            adminStatus: null,
            speed: null,
            vlan: null,
            type: null,
            zone: (i.topology || (i['topology-settings'] && i['topology-settings']['interface-leads-to-dmz'] ? 'dmz' : null)) || null,
            rxBytes: null,
            txBytes: null,
            raw: i,
        };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
}

/** Rules of a rulebase page, sections flattened. */
function flattenRules(rulebase) {
    const out = [];
    for (const r of rulebase || []) {
        if (r && Array.isArray(r.rulebase)) out.push(...flattenRules(r.rulebase).map(x => ({ ...x, section: x.section || r.name || null })));
        else if (r && r.type === 'access-rule') out.push(r);
    }
    return out;
}

async function getPolicies(profile, opts = {}) {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || POLICY_LIMIT, 1), POLICY_MAX);
    const page = Math.max(parseInt(opts.page, 10) || 1, 1);
    const search = String(opts.search || '').trim().toLowerCase().slice(0, 100);
    const { gateway } = await gatewayOf(profile);
    const pkgName = policyName(gateway);
    if (!pkgName) throw netError('UNSUPPORTED', 'No access policy is installed on this gateway');
    const pkg = await api(profile, 'show-package', { name: pkgName });
    const layer = (pkg['access-layers'] || [])[0];
    if (!layer) throw netError('UNSUPPORTED', `Policy package ${pkgName} has no access layer`);

    const dict = {};
    const rules = [];
    let total = 0;
    for (let offset = 0; offset < MAX_RULES; offset += PAGE) {
        const res = await api(profile, 'show-access-rulebase', {
            uid: layer.uid, offset, limit: PAGE, 'details-level': 'standard', 'use-object-dictionary': true, 'show-hits': true,
            'hits-settings': { 'target': gateway.name },
        });
        for (const o of res['objects-dictionary'] || []) dict[o.uid] = o;
        rules.push(...flattenRules(res.rulebase));
        total = res.total || rules.length;
        if (!res.to || res.to >= total || !(res.rulebase || []).length) break;
    }
    const nameOf = (uid) => (dict[uid] ? dict[uid].name : uid);
    const names = (arr) => (Array.isArray(arr) ? arr.map(nameOf) : []);
    let items = rules.map((r) => {
        const last = r.hits && r.hits['last-date'] && r.hits['last-date']['iso-8601'];
        return {
            id: r['rule-number'],
            name: r.name || '',
            enabled: r.enabled !== false,
            action: r.action ? String(nameOf(r.action)).toLowerCase() : null,
            from: [],
            to: [],
            source: names(r.source).map((n, i) => (r['source-negate'] && i === 0 ? `NOT ${n}` : n)),
            destination: names(r.destination).map((n, i) => (r['destination-negate'] && i === 0 ? `NOT ${n}` : n)),
            service: names(r.service),
            section: r.section || null,
            nat: null,
            hitCount: r.hits && r.hits.value !== undefined ? Number(r.hits.value) : null,
            bytes: null,
            lastHit: last ? new Date(last).toISOString() : null,
            comment: r.comments || '',
            raw: r,
        };
    });
    if (search) {
        items = items.filter(p => [p.id, p.name, p.action, p.comment, p.section, ...p.source, ...p.destination, ...p.service]
            .some(v => String(v).toLowerCase().includes(search)));
    }
    return {
        total: items.length,
        page,
        limit,
        hitCounts: items.some(p => p.hitCount !== null),
        layer: layer.name,
        truncated: total > rules.length,
        items: items.slice((page - 1) * limit, page * limit),
    };
}

async function getHa(profile) {
    const { gateway, detail } = await gatewayDetail(profile);
    if (!isCluster(gateway)) return { mode: 'standalone', group: null, priority: null, members: [], raw: detail };
    const members = detail['cluster-members'] || detail.members || [];
    return {
        mode: detail['cluster-mode'] || 'cluster',
        group: gateway.name,
        priority: null,
        // the management API has the cluster configuration only, not which member is active
        members: members.map(m => ({
            hostname: m.name || null,
            serial: null,
            priority: m.priority !== undefined ? Number(m.priority) : null,
            primary: null,
            state: null,
            mgmtIp: m['ip-address'] || m['ipv4-address'] || null,
            raw: m,
        })),
        raw: detail,
    };
}

// Fields that change without a configuration change (edit times, hit counters, UI hints): left out of backups
const VOLATILE = new Set(['meta-info', 'hits', 'read-only', 'available-actions', 'icon', 'color']);

/** Deep copy without volatile fields, keys sorted, so two backups of the same policy are identical text. */
function stable(v) {
    if (Array.isArray(v)) return v.map(stable);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const k of Object.keys(v).sort()) if (!VOLATILE.has(k)) out[k] = stable(v[k]);
    return out;
}

/**
 * The gateway object and the policy package installed on it, every access layer with its rules and the objects they
 * use, as JSON (the management API has no single configuration file; Gaia settings of the gateway are not included).
 */
async function backupConfig(profile) {
    const { gateway, detail } = await gatewayDetail(profile);
    const pkgName = policyName(gateway);
    const pkg = pkgName ? await api(profile, 'show-package', { name: pkgName }) : null;
    const layers = [];
    for (const layer of (pkg && pkg['access-layers']) || []) {
        const dict = {};
        const rulebase = [];
        for (let offset = 0; offset < MAX_RULES; offset += PAGE) {
            const res = await api(profile, 'show-access-rulebase', { uid: layer.uid, offset, limit: PAGE, 'details-level': 'standard', 'use-object-dictionary': true });
            for (const o of res['objects-dictionary'] || []) dict[o.uid] = o;
            rulebase.push(...(res.rulebase || []));
            if (!res.to || res.to >= (res.total || 0) || !(res.rulebase || []).length) break;
        }
        layers.push({
            name: layer.name,
            uid: layer.uid,
            rulebase,
            objects: Object.values(dict).sort((x, y) => String(x.name).localeCompare(String(y.name)) || String(x.uid).localeCompare(String(y.uid))),
        });
    }
    const doc = { vendor: 'checkpoint', domain: profile.scope || null, gateway: detail, package: pkg, accessLayers: layers };
    return { content: `${JSON.stringify(stable(doc), null, 2)}\n`, format: 'json' };
}

/** Test hook: forget cached sessions. */
function _resetSessions() { sessions.clear(); }

module.exports = { backupConfig, capabilities, testConnection, getSummary, getInterfaces, getPolicies, getHa, _resetSessions, _flattenRules: flattenRules };
