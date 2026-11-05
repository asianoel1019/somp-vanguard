// Parsers of Cisco IOS / IOS-XE `show` command output (pure functions). They tolerate the small differences between
// IOS 15.x (Catalyst 2960 / 3750) and IOS-XE 16-17.x (Catalyst 9000) and return the unified fields of the spec.

// Long interface name prefix -> the short form used by "show interfaces status / trunk", "show vlan", "show mac"
const IF_PREFIXES = [
    ['HundredGigE', 'Hu'], ['FortyGigabitEthernet', 'Fo'], ['TwentyFiveGigE', 'Twe'], ['TenGigabitEthernet', 'Te'],
    ['FiveGigabitEthernet', 'Fi'], ['TwoGigabitEthernet', 'Tw'], ['AppGigabitEthernet', 'Ap'], ['GigabitEthernet', 'Gi'],
    ['FastEthernet', 'Fa'], ['Port-channel', 'Po'], ['Ethernet', 'Et'], ['Loopback', 'Lo'], ['Vlan', 'Vl'], ['Tunnel', 'Tu'],
];

/** "GigabitEthernet1/0/1" -> "Gi1/0/1" (already short names are returned as they are). */
function shortIf(name) {
    const n = String(name || '').trim();
    for (const [long, short] of IF_PREFIXES) {
        if (n.toLowerCase().startsWith(long.toLowerCase()) && /\d/.test(n.charAt(long.length))) return short + n.slice(long.length);
    }
    return n;
}

/** Key to compare interface names written either way. */
const ifKey = (name) => shortIf(name).toLowerCase();

/** Any MAC notation (aabb.ccdd.eeff, AA-BB-.., aa:bb:..) -> "aa:bb:cc:dd:ee:ff", or null. */
function normalizeMac(s) {
    const hex = String(s || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    if (hex.length !== 12) return null;
    return hex.match(/.{2}/g).join(':');
}

/** "1,10-12,20" -> [1, 10, 11, 12, 20]; "none" / "" -> []. Ranges larger than 4094 VLANs are refused. */
function expandVlanList(text) {
    const out = [];
    for (const part of String(text || '').split(',').map(s => s.trim()).filter(Boolean)) {
        const m = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (!m) continue;
        const a = Number(m[1]);
        const b = m[2] ? Number(m[2]) : a;
        if (a < 1 || b > 4094 || b < a) continue;
        for (let v = a; v <= b; v += 1) out.push(v);
    }
    return out;
}

const lines = (text) => String(text || '').replace(/\r/g, '').split('\n');
const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// ---------------------------------------------------------------- show version / show inventory

function parseVersion(text) {
    const t = String(text || '').replace(/\r/g, '');
    const version = (/Cisco IOS[^\n]*?,\s*Version\s+([\w.()-]+)/.exec(t) || [])[1] || null;
    const up = /^(\S+) uptime is (.+)$/m.exec(t);
    const model = (/^Model [Nn]umber\s*:\s*(\S+)/m.exec(t) || [])[1]
        || (/^cisco (\S+) .*processor/m.exec(t) || [])[1] || null;
    const serial = (/^System [Ss]erial [Nn]umber\s*:\s*(\S+)/m.exec(t) || [])[1]
        || (/^Processor board ID (\S+)/m.exec(t) || [])[1] || null;
    const members = [];
    const ls = lines(t);
    const head = ls.findIndex(l => /^Switch\s+Ports\s+Model\s+SW Version/.test(l));
    if (head >= 0) {
        for (let i = head + 2; i < ls.length; i += 1) {
            const m = /^\s*(\*)?\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)/.exec(ls[i]);
            if (!m) break;
            members.push({ slot: Number(m[2]), ports: Number(m[3]), model: m[4], version: m[5], role: m[1] ? 'active' : 'member', serial: null });
        }
    }
    // per-member blocks ("Switch 02" ... "System Serial Number") of a stack
    const blockRe = /^Switch 0*(\d+)\n-+\n([\s\S]*?)(?=\n\s*\n|(?![\s\S]))/gm;
    let b;
    while ((b = blockRe.exec(t))) {
        const sn = (/System [Ss]erial [Nn]umber\s*:\s*(\S+)/.exec(b[2]) || [])[1];
        const mem = members.find(x => x.slot === Number(b[1]));
        if (mem && sn) mem.serial = sn;
    }
    const active = members.find(x => x.role === 'active');
    if (active && !active.serial) active.serial = serial;
    return { model, hostname: up ? up[1] : null, version, serial, uptime: up ? up[2].trim() : null, members };
}

/** { "switch 1": serial, ... } from show inventory (NAME / SN pairs). */
function parseInventory(text) {
    const out = [];
    const re = /NAME:\s*"([^"]*)",\s*DESCR:\s*"([^"]*)"\s*\n\s*PID:\s*([^,]*?)\s*,\s*VID:\s*([^,]*?)\s*,\s*SN:\s*(\S*)/g;
    let m;
    const t = String(text || '').replace(/\r/g, '');
    while ((m = re.exec(t))) out.push({ name: m[1], descr: m[2], pid: m[3] || null, serial: m[5] || null });
    return out;
}

// ---------------------------------------------------------------- show interfaces

const STATUS_FROM_PROTOCOL = { 'err-disabled': 'err-disabled', disabled: 'admin-down' };

function parseInterfaces(text) {
    const out = [];
    let cur = null;
    for (const line of lines(text)) {
        const head = /^(\S+) is (administratively down|up|down|deleted)\s*,\s*line protocol is (\w+)\s*(?:\(([^)]+)\))?/.exec(line);
        if (head) {
            const admin = head[2] === 'administratively down';
            const detail = head[4] ? head[4].trim() : '';
            let status = admin ? 'admin-down' : (head[2] === 'up' && head[3] === 'up' ? 'up' : 'down');
            if (STATUS_FROM_PROTOCOL[detail]) status = STATUS_FROM_PROTOCOL[detail];
            cur = {
                name: head[1], alias: '', status, speed: null, duplex: null, ip: null, mtu: null,
                inErrors: null, crcErrors: null, outErrors: null, inDiscards: null, outDiscards: null,
                rxBytes: null, txBytes: null, rxBps: null, txBps: null, rateInterval: null, mac: null,
            };
            out.push(cur);
            continue;
        }
        if (!cur) continue;
        let m;
        if ((m = /^\s+Description:\s*(.*)$/.exec(line))) cur.alias = m[1].trim();
        else if ((m = /^\s+Internet address is (\S+)/.exec(line))) cur.ip = m[1];
        else if ((m = /address is ([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})/i.exec(line)) && !cur.mac) cur.mac = normalizeMac(m[1]);
        if ((m = /^\s+MTU (\d+) bytes/.exec(line))) cur.mtu = Number(m[1]);
        if ((m = /^\s+(Full|Half|Auto)-duplex,\s*(Auto-speed|[\d.]+\s*[MG]b\/s)/i.exec(line))) {
            cur.duplex = m[1].toLowerCase() === 'auto' ? 'auto' : m[1].toLowerCase();
            const sp = /([\d.]+)\s*([MG])b\/s/i.exec(m[2]);
            cur.speed = sp ? Number(sp[1]) * (sp[2].toUpperCase() === 'G' ? 1000 : 1) : null;
        }
        if ((m = /Input queue: \d+\/\d+\/(\d+)\/\d+.*Total output drops: (\d+)/.exec(line))) { cur.inDiscards = Number(m[1]); cur.outDiscards = Number(m[2]); }
        if ((m = /^\s+(\d+) (minute|second) input rate (\d+) bits\/sec/.exec(line))) { cur.rxBps = Number(m[3]); cur.rateInterval = Number(m[1]) * (m[2] === 'minute' ? 60 : 1); }
        if ((m = /^\s+\d+ (?:minute|second) output rate (\d+) bits\/sec/.exec(line))) cur.txBps = Number(m[1]);
        if ((m = /^\s+\d+ packets input, (\d+) bytes/.exec(line))) cur.rxBytes = Number(m[1]);
        if ((m = /^\s+\d+ packets output, (\d+) bytes/.exec(line))) cur.txBytes = Number(m[1]);
        if ((m = /^\s+(\d+) input errors, (\d+) CRC/.exec(line))) { cur.inErrors = Number(m[1]); cur.crcErrors = Number(m[2]); }
        if ((m = /^\s+(\d+) output errors/.exec(line))) cur.outErrors = Number(m[1]);
    }
    return out;
}

// ---------------------------------------------------------------- show interfaces status (fixed columns)

function parseInterfacesStatus(text) {
    const out = {};
    const ls = lines(text);
    const hi = ls.findIndex(l => /^Port\s+Name\s+Status\s+Vlan/.test(l));
    if (hi < 0) return out;
    const header = ls[hi];
    const nameAt = header.indexOf('Name');
    const statusAt = header.indexOf('Status');
    for (const line of ls.slice(hi + 1)) {
        if (!line.trim() || /^Port\s/.test(line)) continue;
        const port = line.slice(0, nameAt).trim() || line.split(/\s+/)[0];
        // the Name column may hold spaces and the Status column may start a little to the left when Name is full
        let restAt = statusAt;
        while (restAt > nameAt && line.charAt(restAt - 1) !== ' ') restAt -= 1;
        const alias = line.slice(nameAt, restAt).trim();
        const rest = line.slice(restAt).trim().split(/\s+/);
        if (rest.length < 4) continue;
        const [status, vlan, duplex, speed] = rest;
        const mode = vlan === 'trunk' ? 'trunk' : vlan === 'routed' ? 'routed' : 'access';
        out[ifKey(port)] = {
            port, alias, status, mode,
            vlan: /^\d+$/.test(vlan) ? Number(vlan) : null,
            duplex: duplex.replace(/^a-/, ''),
            speed: speed.replace(/^a-/, ''),
            type: rest.slice(4).join(' ') || null,
        };
    }
    return out;
}

// ---------------------------------------------------------------- show interfaces trunk

function parseTrunk(text) {
    const out = {};
    let section = null;
    let last = null;
    for (const line of lines(text)) {
        if (/^Port\s+Mode\s+Encapsulation/.test(line)) { section = 'mode'; continue; }
        if (/^Port\s+Vlans allowed on trunk/.test(line)) { section = 'allowed'; continue; }
        if (/^Port\s+Vlans allowed and active/.test(line)) { section = 'active'; continue; }
        if (/^Port\s+Vlans in spanning tree/.test(line)) { section = 'forwarding'; continue; }
        if (!line.trim()) { last = null; continue; }
        if (!section) continue;
        // a long VLAN list continues on the next lines, indented
        if (/^\s+\S/.test(line) && last && section !== 'mode') {
            out[last][section] += line.trim();
            continue;
        }
        const m = /^(\S+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const key = ifKey(m[1]);
        out[key] = out[key] || { port: m[1], native: null, allowed: '', active: '', forwarding: '' };
        if (section === 'mode') {
            const cols = m[2].trim().split(/\s+/);
            out[key].native = num(cols[cols.length - 1]);
        } else {
            out[key][section] = m[2].trim();
            last = key;
        }
    }
    for (const v of Object.values(out)) {
        v.allowed = expandVlanList(v.allowed);
        v.active = expandVlanList(v.active);
        v.forwarding = expandVlanList(v.forwarding);
    }
    return out;
}

// ---------------------------------------------------------------- show vlan brief

const DEFAULT_LEGACY_VLANS = new Set([1002, 1003, 1004, 1005]);

function parseVlanBrief(text) {
    const out = [];
    let cur = null;
    for (const line of lines(text)) {
        const m = /^(\d+)\s+(\S.*?)\s+(active|suspended|act\/\S+|sus\/\S+)\s*(.*)$/.exec(line);
        if (m) {
            cur = { id: Number(m[1]), name: m[2].trim(), status: m[3], accessPorts: splitPorts(m[4]) };
            if (!DEFAULT_LEGACY_VLANS.has(cur.id)) out.push(cur);
            else cur = null;
            continue;
        }
        if (cur && /^\s{20,}\S/.test(line)) cur.accessPorts.push(...splitPorts(line));
        else if (!/^\s/.test(line)) cur = null;
    }
    return out;
}

const splitPorts = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

// ---------------------------------------------------------------- show mac address-table

function parseMacTable(text) {
    const out = [];
    for (const line of lines(text)) {
        const m = /^\s*(\d+)\s+([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})\s+(\S+)\s+(?:\S+\s+)?(\S+)\s*$/i.exec(line);
        if (!m) continue;
        const port = m[4];
        if (/^(CPU|Router|Switch|Drop)$/i.test(port)) continue;
        out.push({ mac: normalizeMac(m[2]), vlan: Number(m[1]), port, type: /static/i.test(m[3]) ? 'static' : 'dynamic' });
    }
    return out;
}

// ---------------------------------------------------------------- show running-config

// Lines that change without a configuration change
const VOLATILE_LINES = [
    /^! Last configuration change at /,
    /^! NVRAM config last updated at /,
    /^! No configuration change since last restart/,
    /^ntp clock-period /,
    /^Building configuration\.\.\./,
    /^Current configuration : \d+ bytes/,
];

function cleanConfig(text) {
    const kept = lines(text).filter(l => !VOLATILE_LINES.some(re => re.test(l)));
    while (kept.length && !kept[0].trim()) kept.shift();
    return `${kept.join('\n').replace(/\s+$/, '')}\n`;
}

module.exports = {
    shortIf, ifKey, normalizeMac, expandVlanList,
    parseVersion, parseInventory, parseInterfaces, parseInterfacesStatus, parseTrunk, parseVlanBrief, parseMacTable, cleanConfig,
};
