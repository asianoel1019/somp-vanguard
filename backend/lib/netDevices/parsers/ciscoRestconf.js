// Parsers of Cisco IOS-XE RESTCONF answers (YANG JSON, pure functions). They return the same unified fields as the
// SSH parsers (parsers/ciscoIos.js), so the page does not care which way a switch was read.
// Leaf names carry a module prefix in some releases ("Cisco-IOS-XE-switch:mode") and not in others: `leaf` accepts both.
const { shortIf, ifKey, normalizeMac, expandVlanList } = require('./ciscoIos');

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
const DEFAULT_LEGACY_VLANS = new Set([1002, 1003, 1004, 1005]);

/** obj[key], or obj['<any module>:key']. */
function leaf(obj, key) {
    if (!obj || typeof obj !== 'object') return undefined;
    if (obj[key] !== undefined) return obj[key];
    const k = Object.keys(obj).find(x => x.endsWith(`:${key}`));
    return k ? obj[k] : undefined;
}

/** The single top-level container of a RESTCONF answer ({"Module:name": {...}}), or {}. */
function body(doc, key) {
    const v = leaf(doc, key);
    return v && typeof v === 'object' ? v : {};
}

/** "192.0.2.1" + "255.255.255.0" -> "192.0.2.1/24" (null for 0.0.0.0 / none). */
function cidr(ip, mask) {
    if (!ip || ip === '0.0.0.0') return null;
    if (!mask) return String(ip);
    const bits = String(mask).split('.').reduce((n, o) => n + ((Number(o) >>> 0).toString(2).match(/1/g) || []).length, 0);
    return `${ip}/${bits}`;
}

/** "Cisco IOS XE Software, Version 17.09.04a\n..." -> "17.09.04a" */
function versionOf(text) {
    const m = /Version\s+([\w.()-]+)/.exec(String(text || ''));
    return m ? m[1].replace(/,$/, '') : null;
}

function uptimeText(bootIso, nowIso) {
    const boot = Date.parse(bootIso);
    const now = nowIso ? Date.parse(nowIso) : Date.now();
    if (Number.isNaN(boot) || Number.isNaN(now) || now < boot) return null;
    let s = Math.floor((now - boot) / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60);
    return [d && `${d} days`, h && `${h} hours`, `${m} minutes`].filter(Boolean).join(', ');
}

const ROLES = { 'stack-role-active': 'active', 'stack-role-standby': 'standby', 'stack-role-member': 'member' };

/**
 * Summary from device-hardware-oper (+ optional hostname, CPU, memory and stack answers; null when not readable).
 * @returns {{ model, hostname, version, serial, uptime, cpu, memory, members[] }}
 */
function parseSummary({ hardware, hostname, cpu, memory, stack }) {
    const hw = leaf(body(hardware, 'device-hardware-data'), 'device-hardware') || {};
    const inv = arr(leaf(hw, 'device-inventory'));
    const sys = leaf(hw, 'device-system-data') || {};
    const chassis = inv.filter(x => /chassis/.test(String(x['hw-type'] || x['hw-class'] || '')))
        .sort((a, b) => (num(a['hw-dev-index']) || 0) - (num(b['hw-dev-index']) || 0));
    const nodes = arr(leaf(body(stack, 'stack-oper-data'), 'stack-node'));
    let members = nodes.map(n => ({
        slot: num(n['chassis-number']),
        model: n.pid || n['part-number'] || null,
        serial: n['serial-number'] || null,
        role: ROLES[n.role] || (n.role ? String(n.role).replace(/^stack-role-/, '') : null),
    })).filter(m => m.slot !== null);
    if (!members.length) {
        members = chassis.map((c, i) => ({ slot: num(c['hw-dev-index']) || i + 1, model: c['part-number'] || null, serial: c['serial-number'] || null, role: null }));
    }
    members.sort((a, b) => a.slot - b.slot);
    const head = chassis[0] || {};
    const active = members.find(m => m.role === 'active') || members[0] || {};

    const util = leaf(body(cpu, 'cpu-utilization'), 'five-minutes') ?? leaf(leaf(body(cpu, 'cpu-usage'), 'cpu-utilization'), 'five-minutes');
    const stats = arr(leaf(body(memory, 'memory-statistics'), 'memory-statistic'));
    const proc = stats.find(s => /^processor$/i.test(String(s.name))) || null;
    const total = proc && num(proc['total-memory']);
    const used = proc && num(proc['used-memory']);

    const host = typeof hostname === 'object' && hostname ? leaf(hostname, 'hostname') : hostname;
    return {
        model: active.model || head['part-number'] || null,
        hostname: host ? String(host) : null,
        version: versionOf(sys['software-version']),
        serial: active.serial || head['serial-number'] || null,
        uptime: uptimeText(sys['boot-time'], sys['current-time']),
        cpu: num(util),
        memory: total ? Math.round((used / total) * 100) : null,
        members: members.length > 1 ? members : [],
    };
}

/**
 * Switchport settings of every interface from Cisco-IOS-XE-native:native/interface (config, keyed by ifKey).
 * @returns {{ [ifKey]: { port: string, mode: 'access'|'trunk'|'routed'|null, vlan: number|null, allowed: number[]|null, ip: string|null } }}
 */
function parseSwitchport(doc) {
    const root = body(doc, 'interface');
    const out = {};
    for (const [type, list] of Object.entries(root)) {
        const typeName = type.replace(/^.*:/, '');
        for (const itf of arr(list)) {
            const name = `${typeName}${itf.name}`;
            const sp = leaf(itf, 'switchport') || {};
            const conf = leaf(itf, 'switchport-conf') || {};
            const modeObj = leaf(sp, 'mode') || {};
            const access = leaf(sp, 'access') || {};
            const trunk = leaf(sp, 'trunk') || {};
            const primary = ((leaf(itf, 'ip') || {}).address || {}).primary || {};
            const ip = cidr(primary.address, primary.mask);
            let mode = null;
            if (leaf(modeObj, 'trunk') !== undefined) mode = 'trunk';
            else if (leaf(modeObj, 'access') !== undefined) mode = 'access';
            else if (conf.switchport === false || ip) mode = 'routed';
            const allowedText = ((trunk.allowed || {}).vlan || {}).vlans;
            const nativeVlan = num(((trunk.native || {}).vlan || {})['vlan-id']);
            out[ifKey(name)] = {
                port: shortIf(name),
                mode,
                vlan: mode === 'trunk' ? (nativeVlan || 1) : mode === 'access' ? (num((access.vlan || {}).vlan) || 1) : null,
                allowed: mode === 'trunk' && allowedText !== undefined ? expandVlanList(String(allowedText)) : null,
                ip,
            };
        }
    }
    return out;
}

function ifStatus(itf) {
    if (/down/.test(String(itf['admin-status'] || ''))) return 'admin-down';
    const oper = String(itf['oper-status'] || '');
    if (/err-?disabled/i.test(oper)) return 'err-disabled';
    return /ready|up/.test(oper) ? 'up' : 'down';
}

const DUPLEX = { 'full-duplex': 'full', 'half-duplex': 'half', 'auto-duplex': 'auto' };

/**
 * Interfaces from Cisco-IOS-XE-interfaces-oper, merged with the switchport settings (parseSwitchport; null when the
 * account could not read the configuration: mode and VLAN then stay empty unless the port has an IP).
 * IOS-XE averages rates over the load-interval (300 s unless configured).
 */
function parseInterfaces(doc, switchport) {
    const list = arr(leaf(body(doc, 'interfaces'), 'interface'));
    return list.filter(i => i && i.name).map((i) => {
        const st = i.statistics || {};
        const eth = i['ether-state'] || {};
        const sp = switchport ? switchport[ifKey(i.name)] : null;
        const ip = cidr(i.ipv4, i['ipv4-subnet-mask']) || (sp && sp.ip) || null;
        const speedBps = num(i.speed);
        const kbps = (v) => (num(v) === null ? null : num(v) * 1000);
        let mode = sp ? sp.mode : null;
        if (!mode && ip) mode = 'routed';
        return {
            name: i.name,
            shortName: shortIf(i.name),
            alias: i.description || '',
            status: ifStatus(i),
            speed: speedBps ? speedBps / 1e6 : null,
            duplex: DUPLEX[eth['negotiated-duplex-mode']] || null,
            mode,
            vlan: sp ? sp.vlan : null,
            trunkVlans: sp && sp.allowed ? sp.allowed.length : null,
            ip,
            mtu: num(i.mtu),
            mac: i['phys-address'] ? normalizeMac(i['phys-address']) : null,
            inErrors: num(st['in-errors']),
            crcErrors: num(st['in-crc-errors']),
            outErrors: num(st['out-errors']),
            inDiscards: num(st['in-discards']),
            outDiscards: num(st['out-discards']),
            rxBytes: num(st['in-octets']),
            txBytes: num(st['out-octets']),
            rxBps: kbps(st['rx-kbps']),
            txBps: kbps(st['tx-kbps']),
            rateInterval: st['rx-kbps'] !== undefined ? 300 : null,
            zone: null,
        };
    });
}

/**
 * VLANs from Cisco-IOS-XE-vlan-oper with the trunks that allow each one (from parseSwitchport; trunks without an
 * allowed list carry every VLAN). Ports configured as trunks are listed only as trunks.
 */
function parseVlans(doc, switchport) {
    const trunks = Object.entries(switchport || {}).filter(([, s]) => s.mode === 'trunk');
    const trunkKeys = new Set(trunks.map(([k]) => k));
    return arr(leaf(body(doc, 'vlans'), 'vlan'))
        .map(v => ({ v, id: num(v.id) }))
        .filter(({ id }) => id !== null && !DEFAULT_LEGACY_VLANS.has(id))
        .map(({ v, id }) => ({
            id,
            name: v.name || '',
            status: String(v.status || '').replace(/^vlan-status-/, '') || 'active',
            accessPorts: arr(v['vlan-interfaces']).map(x => x.interface).filter(Boolean)
                .filter(n => !trunkKeys.has(ifKey(n))).map(shortIf),
            trunkPorts: trunks.filter(([, s]) => !s.allowed || s.allowed.includes(id)).map(([, s]) => s.port),
        }))
        .sort((a, b) => a.id - b.id);
}

/** MAC table from Cisco-IOS-XE-matm-oper (entries of the switch itself are skipped). */
function parseMac(doc) {
    const out = [];
    for (const table of arr(leaf(body(doc, 'matm-oper-data'), 'matm-table'))) {
        for (const e of arr(table['matm-mac-entry'])) {
            const port = String(e.port || '').trim();
            const mac = normalizeMac(e.mac);
            if (!mac || !port || /^(CPU|Router|Switch|Drop)$/i.test(port)) continue;
            out.push({ mac, vlan: num(e['vlan-id-number'] ?? table['vlan-id-number']), port: shortIf(port), type: /static/i.test(String(e['mat-addr-type'] || '')) ? 'static' : 'dynamic' });
        }
    }
    return out;
}

module.exports = { leaf, cidr, versionOf, uptimeText, parseSummary, parseSwitchport, parseInterfaces, parseVlans, parseMac };
