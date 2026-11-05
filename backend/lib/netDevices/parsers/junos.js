// Parsers of Juniper Junos JSON (pure functions). The REST API (`/rpc/<rpc>`) and SSH `show ... | display json` give
// the same JSON, in which every leaf is wrapped: { "host-name": [{ "data": "sw1" }] }. `d` unwraps one, `list` gives
// the array of a container. VLAN / MAC answers are those of ELS switches (EX2300/3400/4300+, QFX; Junos 15.1+).
const { normalizeMac } = require('./ciscoIos');

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
const list = (o, k) => (o && typeof o === 'object' ? arr(o[k]) : []);
const first = (o, k) => list(o, k)[0];

/** Unwrapped leaf value (string) or null. */
function d(o, k) {
    const raw = o && typeof o === 'object' ? o[k] : undefined;
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v === undefined || v === null) return null;
    if (typeof v === 'object') return v.data === undefined ? null : String(v.data);
    return String(v);
}

/** The items of a multi routing engine / virtual chassis answer, or the answer itself as one item. */
function items(doc, key) {
    const multi = first(doc, 'multi-routing-engine-results');
    if (multi) {
        return list(multi, 'multi-routing-engine-item').map(i => ({ re: d(i, 're-name'), body: first(i, key) })).filter(i => i.body);
    }
    const body = first(doc, key);
    return body ? [{ re: null, body }] : [];
}

/** "ge-0/0/1.0*" -> "ge-0/0/1" (unit 0 and the active marker dropped; other units kept). */
function portName(name) {
    return String(name || '').trim().replace(/\*$/, '').replace(/\.0$/, '');
}
const ifKey = (name) => portName(name).toLowerCase();

/** "1000mbps" / "10Gbps" -> Mbit/s */
function speedOf(text) {
    const m = /([\d.]+)\s*([mg])bps/i.exec(String(text || ''));
    return m ? Number(m[1]) * (m[2].toLowerCase() === 'g' ? 1000 : 1) : null;
}

const ROLE = { master: 'active', backup: 'standby', linecard: 'member' };

/**
 * Summary from get-software-information (+ optional get-chassis-inventory, get-route-engine-information).
 * @returns {{ model, hostname, version, serial, uptime, cpu, memory, members[] }}
 */
function parseSummary({ version, inventory, engines }) {
    const sw = (items(version, 'software-information')[0] || {}).body || {};
    const pkg = list(sw, 'package-information').map(p => d(p, 'comment')).find(c => /\[.+\]/.test(c || ''));
    const chassis = first(first(inventory, 'chassis-inventory'), 'chassis') || {};
    const res = items(engines, 'route-engine-information').flatMap(i => list(i.body, 'route-engine'));
    const master = res.find(r => d(r, 'mastership-state') === 'master') || res[0] || null;
    const fpcs = list(chassis, 'chassis-module')
        .filter(m => /^FPC \d+$/.test(d(m, 'name') || ''))
        .map((m) => {
            const slot = num(/\d+/.exec(d(m, 'name'))[0]);
            const re = res.find(r => num(d(r, 'slot')) === slot);
            return { slot, model: d(m, 'model-number') || d(m, 'description'), serial: d(m, 'serial-number'), role: re ? ROLE[d(re, 'mastership-state')] || null : null };
        });
    const idle = master ? num(d(master, 'cpu-idle')) : null;
    const mem = master ? num(d(master, 'memory-buffer-utilization') ?? d(master, 'memory-utilization')) : null;
    // a virtual chassis describes itself as "Virtual Chassis": name the master member instead
    const vc = /virtual chassis/i.test(d(chassis, 'description') || '');
    const head = vc ? (fpcs.find(m => m.role === 'active') || fpcs[0] || {}) : {};
    const model = (vc ? head.model : d(chassis, 'description')) || (d(sw, 'product-model') ? d(sw, 'product-model').toUpperCase() : null);
    return {
        model,
        hostname: d(sw, 'host-name'),
        version: d(sw, 'junos-version') || (pkg ? /\[(.+?)\]/.exec(pkg)[1] : null),
        serial: (vc && head.serial) || d(chassis, 'serial-number'),
        uptime: master ? d(master, 'up-time') : null,
        cpu: idle === null ? null : Math.round(100 - idle),
        memory: mem,
        members: fpcs.length > 1 ? fpcs.sort((a, b) => a.slot - b.slot) : [],
    };
}

/**
 * Port mode and VLAN membership from get-ethernet-switching-interface-information (`show ethernet-switching interface`).
 * @returns {{ [ifKey]: { port, mode: 'access'|'trunk', vlan: number|null, tagged: number[] } }}
 */
function parseSwitching(doc) {
    const out = {};
    for (const info of list(doc, 'switching-interface-information')) {
        for (const itf of list(info, 'interface')) {
            const port = portName(d(itf, 'interface-name'));
            if (!port) continue;
            const members = list(itf, 'interface-vlan-member-list').flatMap(l => list(l, 'interface-vlan-member'));
            const untagged = members.find(m => d(m, 'interface-vlan-member-tagness') === 'untagged');
            const tagged = members.filter(m => d(m, 'interface-vlan-member-tagness') === 'tagged').map(m => num(d(m, 'interface-vlan-member-tagid'))).filter(v => v !== null);
            const mode = /trunk/i.test(d(itf, 'interface-port-mode') || '') ? 'trunk' : 'access';
            out[ifKey(port)] = {
                port,
                mode,
                vlan: untagged ? num(d(untagged, 'interface-vlan-member-tagid')) : (num(d(itf, 'interface-native-vlan')) || null),
                tagged,
            };
        }
    }
    return out;
}

const PHYSICAL_RE = /^((ge|xe|et|mge|fe)-\d+\/\d+\/\d+(:\d+)?|ae\d+|em\d+|fxp\d+|me\d+|vme|irb)$/;

function inetAddress(logical) {
    for (const fam of list(logical, 'address-family')) {
        if (d(fam, 'address-family-name') !== 'inet') continue;
        const a = first(fam, 'interface-address');
        const local = a && d(a, 'ifa-local');
        if (!local) continue;
        const dest = d(a, 'ifa-destination') || '';
        const bits = /\/(\d+)$/.exec(dest);
        return bits ? `${local}/${bits[1]}` : local;
    }
    return null;
}

const errField = (p, listKey, k) => num(d(first(p, listKey), k));

/**
 * Interfaces from get-interface-information (extensive), with port modes from parseSwitching (null when not
 * readable). Internal interfaces are left out; the units of irb (the VLAN interfaces) are listed as irb.<unit>.
 * Junos reports current rates, not an average over an interval.
 */
function parseInterfaces(doc, switching) {
    const out = [];
    for (const info of list(doc, 'interface-information')) {
        for (const p of list(info, 'physical-interface')) {
            const name = d(p, 'name');
            if (!name || !PHYSICAL_RE.test(name)) continue;
            const admin = d(p, 'admin-status');
            const oper = d(p, 'oper-status');
            const status = admin === 'down' ? 'admin-down' : oper === 'up' ? 'up' : 'down';
            const logical = list(p, 'logical-interface');
            if (name === 'irb') {
                for (const l of logical) {
                    out.push(blank({ name: d(l, 'name'), status, ip: inetAddress(l), mode: 'routed', alias: d(l, 'description') || '' }));
                }
                continue;
            }
            const sw = switching ? switching[ifKey(name)] : null;
            const ip = logical.map(inetAddress).find(Boolean) || null;
            const ts = first(p, 'traffic-statistics');
            const duplex = (d(p, 'duplex') || d(p, 'link-mode') || '').toLowerCase().replace(/-duplex$/, '');
            out.push({
                ...blank({ name, status, ip, alias: d(p, 'description') || '' }),
                speed: speedOf(d(p, 'speed')),
                duplex: duplex || null,
                mode: sw ? sw.mode : (ip ? 'routed' : null),
                vlan: sw ? sw.vlan : null,
                trunkVlans: sw && sw.mode === 'trunk' ? sw.tagged.length : null,
                mtu: num(d(p, 'mtu')),
                mac: normalizeMac(d(p, 'current-physical-address')),
                inErrors: errField(p, 'input-error-list', 'input-errors'),
                crcErrors: num(d(first(p, 'ethernet-mac-statistics'), 'input-crc-errors')) ?? errField(p, 'input-error-list', 'framing-errors'),
                outErrors: errField(p, 'output-error-list', 'output-errors'),
                inDiscards: errField(p, 'input-error-list', 'input-drops'),
                outDiscards: errField(p, 'output-error-list', 'output-drops'),
                rxBytes: num(d(ts, 'input-bytes')),
                txBytes: num(d(ts, 'output-bytes')),
                rxBps: num(d(ts, 'input-bps')),
                txBps: num(d(ts, 'output-bps')),
            });
        }
    }
    return out;
}

function blank({ name, status, ip, mode = null, alias = '' }) {
    return {
        name, shortName: name, alias, status, speed: null, duplex: null, mode, vlan: null, trunkVlans: null, ip, mtu: null, mac: null,
        inErrors: null, crcErrors: null, outErrors: null, inDiscards: null, outDiscards: null,
        rxBytes: null, txBytes: null, rxBps: null, txBps: null, rateInterval: null, zone: null,
    };
}

/** VLANs from get-vlan-information (ELS): members split into access (untagged) and trunk (tagged) ports. */
function parseVlans(doc) {
    const out = [];
    for (const info of list(doc, 'l2ng-l2ald-vlan-instance-information')) {
        for (const g of list(info, 'l2ng-l2ald-vlan-instance-group')) {
            const id = num(d(g, 'l2ng-l2rtb-vlan-tag'));
            if (id === null) continue;
            const members = list(g, 'l2ng-l2rtb-vlan-member').map(m => ({
                port: portName(d(m, 'l2ng-l2rtb-vlan-member-interface')),
                trunk: d(m, 'l2ng-l2rtb-vlan-member-tagness') === 'tagged' || /trunk/i.test(d(m, 'l2ng-l2rtb-vlan-member-interface-mode') || ''),
            })).filter(m => m.port);
            out.push({
                id,
                name: d(g, 'l2ng-l2rtb-vlan-name') || '',
                status: 'active',
                accessPorts: members.filter(m => !m.trunk).map(m => m.port),
                trunkPorts: members.filter(m => m.trunk).map(m => m.port),
            });
        }
    }
    return out.sort((a, b) => a.id - b.id);
}

/** MAC table from get-ethernet-switching-table-information (ELS); `vlanIds` maps VLAN names to tags when needed. */
function parseMac(doc, vlanIds = {}) {
    const out = [];
    for (const db of list(doc, 'l2ng-l2ald-rtb-macdb')) {
        for (const group of list(db, 'l2ng-l2ald-mac-entry-vlan')) {
            for (const e of list(group, 'l2ng-mac-entry')) {
                const mac = normalizeMac(d(e, 'l2ng-l2-mac-address'));
                const port = portName(d(e, 'l2ng-l2-mac-logical-interface'));
                const vlanName = d(e, 'l2ng-l2-mac-vlan-name');
                const vlan = num(d(e, 'l2ng-l2-vlan-id')) ?? (vlanName && vlanIds[vlanName] !== undefined ? vlanIds[vlanName] : null);
                if (!mac || !port || vlan === null) continue;
                out.push({ mac, vlan, port, type: /S/.test(d(e, 'l2ng-l2-mac-flags') || '') ? 'static' : 'dynamic' });
            }
        }
    }
    return out;
}

/** `show configuration | display set` without the "## Last commit" line. */
function cleanConfig(text) {
    return String(text || '').replace(/\r/g, '')
        .split('\n').filter(l => !/^## Last commit:/.test(l) && !/^\{(master|backup|linecard)(:\d+)?\}$/.test(l.trim()))
        .join('\n').replace(/^\s+/, '').replace(/\s+$/, '\n');
}

/** JSON of `| display json` over SSH: virtual chassis prompts and warnings around it removed. */
function parseCliJson(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n')
        .filter(l => !/^\{(master|backup|linecard)(:\d+)?\}$/.test(l.trim()));
    const start = lines.findIndex(l => l.trim().startsWith('{'));
    if (start < 0) return null;
    return JSON.parse(lines.slice(start).join('\n'));
}

module.exports = { d, list, items, portName, ifKey, speedOf, parseSummary, parseSwitching, parseInterfaces, parseVlans, parseMac, cleanConfig, parseCliJson };
