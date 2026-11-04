// Palo Alto Networks PAN-OS (XML API, read only). Authenticates with an API key (X-PAN-KEY header); with a user name
// and password instead, a key is generated (POST, never in the URL) and kept in memory only. The vsys of the profile
// scope (default vsys1) selects the rulebase and goes with every request.
const net = require('net');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { createClient } = require('../httpClient');
const { netError, NetDeviceError } = require('../errors');

const capabilities = ['summary', 'interfaces', 'policies', 'routes', 'sessions', 'vpn', 'ha'];
const SESSION_MAX = 500;
const POLICY_LIMIT = 50;
const POLICY_MAX = 200;

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    textNodeName: '#text',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: true,
    htmlEntities: false,
    isArray: (name) => name === 'entry' || name === 'member',
});

const generatedKeys = new Map(); // `${host}:${port}:${user}:${hash(password)}` -> key

const text = (v) => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']) : '';
    return String(v);
};
const num = (v) => { const t = text(v); return t === '' || Number.isNaN(Number(t)) ? null : Number(t); };
const entries = (v) => (v && Array.isArray(v.entry) ? v.entry : []);
const members = (v) => (v && Array.isArray(v.member) ? v.member.map(text).filter(Boolean) : (text(v) ? [text(v)] : []));
const esc = (s) => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/** Parse a PAN-OS answer; returns <result>, or throws the classified error the device reported. */
function parseResponse(xml) {
    let doc;
    try { doc = parser.parse(String(xml || '')); } catch (e) { throw netError('OTHER', 'The device answered with something that is not XML'); }
    const r = doc && doc.response;
    if (!r) throw netError('OTHER', 'The device answered with something that is not a PAN-OS response');
    if (r['@status'] !== 'success') {
        const code = r['@code'];
        const msg = r.msg ? [].concat(r.msg.line || r.msg).map(x => (typeof x === 'object' ? text(x) || JSON.stringify(x) : String(x))).join('; ') : text(r.result && r.result.msg);
        if (code === '403' || /invalid credential/i.test(msg)) throw netError('AUTH', 'The device rejected the API key or credentials');
        if (['1', '2', '3', '14', '17'].includes(code) || /unknown command|invalid syntax|not supported/i.test(msg)) throw netError('UNSUPPORTED', `The device does not offer this request${msg ? `: ${msg.slice(0, 150)}` : ''}`);
        throw netError('OTHER', `The device reported an error${msg ? `: ${msg.slice(0, 150)}` : ''}`);
    }
    return r.result === undefined ? {} : r.result;
}

function baseClient(profile, extraHeaders = {}) {
    const s = profile.secrets || {};
    return createClient({
        host: profile.mgmtHost,
        port: profile.port,
        tlsVerify: profile.tlsVerify,
        caCert: profile.caCert,
        headers: { Accept: 'application/xml', 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
        secrets: [s.apiKey, s.password].filter(Boolean),
    });
}

const keyCacheId = (p) => `${p.mgmtHost}:${p.port}:${p.username}:${crypto.createHash('sha256').update(String(p.secrets.password)).digest('hex')}`;

/** The API key: the stored one, or one generated from user name and password. */
async function apiKey(profile, { renew = false } = {}) {
    const s = profile.secrets || {};
    if (s.apiKey) return { key: s.apiKey, generated: false };
    if (!profile.username || !s.password) throw netError('NOT_CONFIGURED', 'No API key or password stored for this device');
    const id = keyCacheId(profile);
    if (!renew && generatedKeys.has(id)) return { key: generatedKeys.get(id), generated: true };
    const body = new URLSearchParams({ type: 'keygen', user: profile.username, password: s.password }).toString();
    const xml = await baseClient(profile).request({ method: 'POST', path: '/api/', data: body, responseType: 'text' }).catch((e) => {
        if (e instanceof NetDeviceError && e.code === 'FORBIDDEN') throw netError('AUTH', 'The device rejected the user name or password');
        throw e;
    });
    const key = text(parseResponse(xml).key);
    if (!key) throw netError('AUTH', 'The device did not return an API key');
    generatedKeys.set(id, key);
    return { key, generated: true };
}

/** One XML API call (form-encoded POST). A generated key that stopped working is renewed once. */
async function call(profile, params, { retried = false } = {}) {
    const { key, generated } = await apiKey(profile, { renew: retried });
    const vsys = profile.scope || '';
    const body = new URLSearchParams({ ...params, ...(vsys && params.type === 'op' ? { vsys } : {}) }).toString();
    try {
        const xml = await baseClient(profile, { 'X-PAN-KEY': key }).request({ method: 'POST', path: '/api/', data: body, responseType: 'text' })
            .catch((e) => {
                // PAN-OS answers an invalid key with HTTP 403
                if (e instanceof NetDeviceError && e.code === 'FORBIDDEN') throw netError('AUTH', 'The device rejected the API key (403)');
                throw e;
            });
        return parseResponse(xml);
    } catch (e) {
        if (generated && !retried && e.code === 'AUTH') return call(profile, params, { retried: true });
        throw e;
    }
}

const op = (profile, cmd) => call(profile, { type: 'op', cmd });
const optional = (p) => p.catch(() => null);
const vsysName = (profile) => profile.scope || 'vsys1';

async function testConnection(profile) {
    return infoFacts(await op(profile, '<show><system><info></info></system></show>'));
}

function infoFacts(result) {
    const s = (result && result.system) || {};
    return {
        model: text(s.model) || null,
        hostname: text(s.hostname) || null,
        version: text(s['sw-version']) || null,
        serial: text(s.serial) || null,
    };
}

/** Management-plane CPU and memory from the `top` text of <show><system><resources>. */
function parseResources(out) {
    const t = text(out) || (typeof out === 'string' ? out : '');
    const idle = /%Cpu\(s\):.*?([\d.]+)\s*id/.exec(t);
    const mem = /(?:MiB|KiB)\s+Mem\s*:\s*([\d.]+)\s*total,\s*([\d.]+)\s*free,\s*([\d.]+)\s*used/.exec(t);
    return {
        cpu: idle ? Math.round((100 - Number(idle[1])) * 10) / 10 : null,
        memory: mem ? Math.round((Number(mem[3]) / Number(mem[1])) * 1000) / 10 : null,
    };
}

async function getSummary(profile) {
    const info = await op(profile, '<show><system><info></info></system></show>');
    const [res, sess, ha] = await Promise.all([
        optional(op(profile, '<show><system><resources></resources></system></show>')),
        optional(op(profile, '<show><session><info></info></session></show>')),
        optional(op(profile, '<show><high-availability><state></state></high-availability></show>')),
    ]);
    const s = info.system || {};
    const r = parseResources(res);
    return {
        ...infoFacts(info),
        vsys: vsysName(profile),
        multiVsys: text(s['multi-vsys']) === 'on',
        uptime: text(s.uptime) || null,
        cpu: r.cpu,
        memory: r.memory,
        disk: null,
        sessions: sess ? num(sess['num-active']) : null,
        sessionsMax: sess ? num(sess['num-max']) : null,
        haMode: ha ? (text(ha.enabled) === 'yes' ? text(ha.group && ha.group.mode) || 'enabled' : 'standalone') : null,
        raw: { system: s, session: sess },
    };
}

async function getInterfaces(profile) {
    const result = await op(profile, '<show><interface>all</interface></show>');
    const hw = {};
    for (const h of entries(result.hw)) hw[text(h.name)] = h;
    const logical = entries(result.ifnet);
    const names = new Set([...logical.map(i => text(i.name)), ...Object.keys(hw)]);
    const byName = Object.fromEntries(logical.map(i => [text(i.name), i]));
    return [...names].filter(Boolean).map((name) => {
        const i = byName[name] || {};
        // sub-interfaces (ethernet1/1.10) report the link of their parent
        const h = hw[name] || hw[name.split('.')[0]] || {};
        const ip = text(i.ip);
        const state = text(h.state).toLowerCase();
        return {
            name,
            alias: '',
            ip: ip && ip !== 'N/A' ? ip : null,
            status: state === 'up' ? 'up' : state === 'down' ? 'down' : 'unknown',
            adminStatus: null,
            speed: num(h.speed),
            vlan: num(i.tag) || null,
            type: null,
            zone: text(i.zone) || null,
            vsys: num(i.vsys),
            virtualRouter: text(i.fwd).replace(/^vr:/, '') || null,
            rxBytes: null,
            txBytes: null,
            raw: { ifnet: i, hw: hw[name] || null },
        };
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function getPolicies(profile, opts = {}) {
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || POLICY_LIMIT, 1), POLICY_MAX);
    const page = Math.max(parseInt(opts.page, 10) || 1, 1);
    const search = String(opts.search || '').trim().toLowerCase().slice(0, 100);
    const vsys = esc(vsysName(profile));
    const xpath = `/config/devices/entry[@name='localhost.localdomain']/vsys/entry[@name='${vsys}']/rulebase/security/rules`;
    const [conf, hits] = await Promise.all([
        call(profile, { type: 'config', action: 'show', xpath }),
        optional(op(profile, `<show><rule-hit-count><vsys><vsys-name><entry name='${vsys}'><rule-base><entry name='security'><rules><all/></rules></entry></rule-base></entry></vsys-name></vsys></rule-hit-count></show>`)),
    ]);
    const hitOf = {};
    const hitRules = hits && hits['rule-hit-count'] && hits['rule-hit-count'].vsys;
    for (const v of entries(hitRules)) for (const rb of entries(v['rule-base'])) for (const r of entries(rb.rules)) hitOf[r['@name']] = r;
    let items = entries(conf.rules).map((p, idx) => {
        const name = p['@name'];
        const h = hitOf[name];
        const last = h ? num(h['last-hit-timestamp']) : null;
        return {
            id: idx + 1, // rule position: PAN-OS rules are identified by name and evaluated in order
            name,
            enabled: text(p.disabled) !== 'yes',
            action: text(p.action) || null,
            from: members(p.from),
            to: members(p.to),
            source: members(p.source),
            destination: members(p.destination),
            service: members(p.service),
            application: members(p.application),
            nat: null,
            hitCount: h ? num(h['hit-count']) : null,
            bytes: null,
            lastHit: last ? new Date(last * 1000).toISOString() : null,
            comment: text(p.description),
            raw: p,
        };
    });
    if (search) {
        items = items.filter(p => [p.id, p.name, p.action, p.comment, ...p.from, ...p.to, ...p.source, ...p.destination, ...p.service, ...p.application]
            .some(v => String(v).toLowerCase().includes(search)));
    }
    return { total: items.length, page, limit, hitCounts: !!hits, items: items.slice((page - 1) * limit, page * limit) };
}

const ROUTE_FLAGS = { S: 'static', C: 'connect', H: 'host', O: 'ospf', B: 'bgp', R: 'rip' };

async function getRoutes(profile) {
    const result = await op(profile, '<show><routing><route></route></routing></show>');
    return entries(result).map((r) => {
        const flags = text(r.flags).split(/\s+/);
        const t = flags.map(f => ROUTE_FLAGS[f]).find(Boolean) || null;
        const nexthop = text(r.nexthop);
        return {
            destination: text(r.destination) || null,
            gateway: nexthop && nexthop !== '0.0.0.0' && !/^discard$/i.test(nexthop) ? nexthop : null,
            interface: text(r.interface) || null,
            type: t,
            distance: null,
            metric: num(r.metric),
            virtualRouter: text(r['virtual-router']) || null,
            active: flags.includes('A'),
            raw: r,
        };
    });
}

const PROTO = { 1: 'icmp', 6: 'tcp', 17: 'udp', 58: 'icmp6' };

async function getSessions(profile, opts = {}) {
    const filter = [];
    for (const [k, tag] of [['src', 'source'], ['dst', 'destination']]) {
        const v = String(opts[k] || '').trim();
        if (!v) continue;
        if (!net.isIP(v)) throw netError('BAD_REQUEST', `${k === 'src' ? 'Source' : 'Destination'} must be an IP address`);
        filter.push(`<${tag}>${v}</${tag}>`);
    }
    if (opts.dport !== undefined && opts.dport !== '') {
        const p = Number(opts.dport);
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw netError('BAD_REQUEST', 'Destination port must be 1-65535');
        filter.push(`<destination-port>${p}</destination-port>`);
    }
    if (!filter.length) throw netError('BAD_REQUEST', 'Give a source, destination or destination port to filter the sessions');
    const result = await op(profile, `<show><session><all><filter>${filter.join('')}</filter></all></session></show>`);
    const rows = entries(result);
    return {
        total: rows.length,
        truncated: rows.length > SESSION_MAX,
        items: rows.slice(0, SESSION_MAX).map(s => ({
            protocol: PROTO[num(s.proto)] || text(s.proto) || null,
            source: text(s.source) || null,
            sourcePort: num(s.sport),
            destination: text(s.dst) || null,
            destinationPort: num(s.dport),
            policyId: text(s['security-rule']) || null,
            application: text(s.application) || null,
            state: text(s.state) || null,
            duration: null,
            bytes: num(s['total-byte-count']),
            raw: s,
        })),
    };
}

async function getVpn(profile) {
    const [flow, gp] = await Promise.all([
        op(profile, '<show><vpn><flow></flow></vpn></show>').catch((e) => { if (e.code === 'UNSUPPORTED') return {}; throw e; }),
        optional(op(profile, '<show><global-protect-gateway><current-user></current-user></global-protect-gateway></show>')),
    ]);
    const tunnels = entries(flow && flow.IPSec).map(t => ({
        name: text(t.name),
        type: 'ipsec',
        peer: text(t.peerip) || null,
        status: text(t.state).toLowerCase() === 'active' ? 'up' : 'down',
        user: null,
        bytesIn: null,
        bytesOut: null,
        phase2: [],
        raw: t,
    }));
    const users = entries(gp).map(u => {
        const login = num(u['login-time-utc']);
        return {
            name: text(u.username),
            type: 'globalprotect',
            peer: text(u['public-ip']) || text(u['client-ip']) || null,
            status: 'up',
            user: [text(u.domain), text(u.username)].filter(Boolean).join('\\') || null,
            bytesIn: null,
            bytesOut: null,
            since: login ? new Date(login * 1000).toISOString() : null,
            tunnelIp: text(u['virtual-ip']) || null,
            raw: u,
        };
    });
    return { tunnels, users };
}

async function getHa(profile) {
    const result = await op(profile, '<show><high-availability><state></state></high-availability></show>');
    const enabled = text(result.enabled) === 'yes';
    const g = result.group || {};
    const local = g['local-info'] || {};
    const peer = g['peer-info'] || {};
    const member = (m, self) => ({
        hostname: self ? 'local' : 'peer',
        serial: text(m['serial-num']) || null,
        priority: num(m.priority),
        primary: ['active', 'active-primary'].includes(text(m.state).toLowerCase()),
        state: text(m.state) || null,
        mgmtIp: text(m['mgmt-ip']) || null,
        raw: m,
    });
    return {
        mode: enabled ? text(g.mode) || 'enabled' : 'standalone',
        group: text(g['group-id']) || null,
        priority: num(local.priority),
        members: enabled ? [member(local, true), ...(Object.keys(peer).length ? [member(peer, false)] : [])] : [],
        raw: result,
    };
}

/** Running configuration (type=export, category=configuration): raw XML, not wrapped in <response>. */
async function backupConfig(profile, { retried = false } = {}) {
    const { key, generated } = await apiKey(profile, { renew: retried });
    const body = new URLSearchParams({ type: 'export', category: 'configuration' }).toString();
    let xml;
    try {
        xml = await baseClient(profile, { 'X-PAN-KEY': key, Accept: '*/*' }).request({ method: 'POST', path: '/api/', data: body, responseType: 'text' })
            .catch((e) => {
                if (e instanceof NetDeviceError && e.code === 'FORBIDDEN') throw netError('AUTH', 'The device rejected the API key (403)');
                throw e;
            });
    } catch (e) {
        if (generated && !retried && e.code === 'AUTH') return backupConfig(profile, { retried: true });
        throw e;
    }
    const text = String(xml || '');
    if (/^\s*<response\b/.test(text)) parseResponse(text); // an error answer: throws the classified error
    if (!/<config\b/.test(text.slice(0, 4000))) throw netError('OTHER', 'The device did not return a configuration');
    return { content: text, format: 'xml' };
}

/** Test hook: forget generated keys. */
function _resetKeys() { generatedKeys.clear(); }

module.exports = { backupConfig, capabilities, testConnection, getSummary, getInterfaces, getPolicies, getRoutes, getSessions, getVpn, getHa, _parseResources: parseResources, _parseResponse: parseResponse, _resetKeys };
