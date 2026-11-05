// Parsers of Cisco NX-OS structured output (pure functions). NX-API `cli_show` bodies and SSH `show ... | json` give
// the same JSON, so both ways share these. NX-OS returns a single ROW_ as an object and several as an array: `rows`
// accepts both. Results use the unified fields of the spec (same as the IOS parsers).
const { normalizeMac, expandVlanList } = require('./ciscoIos');

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
const DEFAULT_LEGACY_VLANS = new Set([1002, 1003, 1004, 1005]);

/** body.TABLE_x.ROW_x as an array (missing -> []). */
function rows(body, name, rowName = name) {
    const table = body && body[`TABLE_${name}`];
    return arr(table).flatMap(t => arr(t && t[`ROW_${rowName}`]));
}

const SHORT = [['Ethernet', 'Eth'], ['port-channel', 'Po'], ['loopback', 'Lo'], ['Vlan', 'Vlan'], ['Tunnel', 'Tunnel'], ['nve', 'nve'], ['mgmt', 'mgmt']];

/** "Ethernet1/1" -> "Eth1/1", "port-channel10" -> "Po10" (NX-OS short forms). */
function shortIf(name) {
    const n = String(name || '').trim();
    for (const [long, short] of SHORT) {
        if (n.toLowerCase().startsWith(long.toLowerCase()) && /\d/.test(n.charAt(long.length))) return short + n.slice(long.length);
    }
    if (/^Eth\d/i.test(n)) return `Eth${n.slice(3)}`;
    if (/^Po\d/i.test(n)) return `Po${n.slice(2)}`;
    return n;
}
const ifKey = (name) => shortIf(name).toLowerCase();

/** "Ethernet1/1-3,Ethernet1/7,port-channel10" -> ["Eth1/1","Eth1/2","Eth1/3","Eth1/7","Po10"] */
function expandPorts(text) {
    const out = [];
    for (const part of String(text || '').split(',').map(s => s.trim()).filter(Boolean)) {
        const m = /^(.*?)(\d+)-(\d+)$/.exec(part);
        if (m && /[/a-z]$/i.test(m[1]) && Number(m[3]) >= Number(m[2]) && Number(m[3]) - Number(m[2]) < 1024) {
            for (let i = Number(m[2]); i <= Number(m[3]); i += 1) out.push(shortIf(`${m[1]}${i}`));
        } else {
            out.push(shortIf(part));
        }
    }
    return out;
}

function uptimeText(v) {
    const d = num(v.kern_uptm_days);
    if (d === null) return null;
    const h = num(v.kern_uptm_hrs) || 0;
    const m = num(v.kern_uptm_mins) || 0;
    return [d && `${d} days`, h && `${h} hours`, `${m} minutes`].filter(Boolean).join(', ');
}

/**
 * Summary from `show version` (+ optional `show inventory`, `show system resources`; null when not readable).
 * @returns {{ model, hostname, version, serial, uptime, cpu, memory, members[] }}
 */
function parseSummary({ version, inventory, resources }) {
    const v = version || {};
    const inv = rows(inventory, 'inv');
    const chassis = inv.find(x => /chassis/i.test(String(x.name || ''))) || {};
    const slots = inv.filter(x => /^"?slot\s*\d+/i.test(String(x.name || '').trim()))
        .map(x => ({ slot: num(/\d+/.exec(x.name)[0]), model: x.productid || null, serial: x.serialnum || null, role: null }));
    const r = resources || {};
    const idle = num(r.cpu_state_idle);
    const total = num(r.memory_usage_total);
    const used = num(r.memory_usage_used);
    const chassisText = String(v.chassis_id || '').replace(/\s*chassis.*$/i, '').trim();
    return {
        model: (chassis.productid && String(chassis.productid).trim()) || chassisText || null,
        hostname: v.host_name || null,
        version: v.nxos_ver_str || v.sys_ver_str || v.kickstart_ver_str || null,
        serial: (chassis.serialnum && String(chassis.serialnum).trim()) || v.proc_board_id || null,
        uptime: uptimeText(v),
        cpu: idle === null ? null : Math.round(100 - idle),
        memory: total ? Math.round((used / total) * 100) : null,
        members: slots.length > 1 ? slots.sort((a, b) => a.slot - b.slot) : [],
    };
}

/** "10 Gb/s" / "1000 Mb/s" -> Mbit/s */
function speedOf(text) {
    const m = /([\d.]+)\s*([MG])b/i.exec(String(text || ''));
    return m ? Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1000 : 1) : null;
}

/** Trunk settings from `show interface trunk`: { [ifKey]: { port, native, allowed: number[]|null (null = all) } } */
function parseTrunk(body) {
    const out = {};
    for (const r of rows(body, 'interface')) {
        if (!r.interface) continue;
        out[ifKey(r.interface)] = { port: shortIf(r.interface), native: num(r.native) || 1, allowed: null };
    }
    for (const r of rows(body, 'allowed_vlans')) {
        const k = ifKey(r.interface);
        if (!out[k]) out[k] = { port: shortIf(r.interface), native: 1, allowed: null };
        const list = expandVlanList(String(r.allowedvlans || ''));
        out[k].allowed = list.length >= 4094 ? null : list;
    }
    return out;
}

/** Access VLAN / mode per port from `show interface status`: { [ifKey]: { mode, vlan } } */
function parseStatus(body) {
    const out = {};
    for (const r of rows(body, 'interface')) {
        if (!r.interface) continue;
        const vlan = String(r.vlan || '').trim();
        out[ifKey(r.interface)] = {
            mode: vlan === 'trunk' ? 'trunk' : vlan === 'routed' ? 'routed' : /^\d+$/.test(vlan) ? 'access' : null,
            vlan: /^\d+$/.test(vlan) ? Number(vlan) : null,
            state: r.state || null,
            alias: r.name || '',
        };
    }
    return out;
}

function ifStatus(r, st) {
    const admin = String(r.admin_state || r.svi_admin_state || '').toLowerCase();
    const reason = `${r.state_rsn_desc || ''} ${st ? st.state || '' : ''}`;
    if (/err-?disabled/i.test(reason)) return 'err-disabled';
    if (admin === 'down' || /administratively down|^\s*disabled/i.test(reason)) return 'admin-down';
    const oper = String(r.state || r.svi_line_proto || r.svi_rsn_desc || '').toLowerCase();
    return oper === 'up' ? 'up' : 'down';
}

/**
 * Interfaces from `show interface`, merged with `show interface status` and `show interface trunk` (null when the
 * device did not answer them). Rates are NX-OS load-interval 1 averages (30 s unless configured).
 */
function parseInterfaces(body, statusBody, trunkBody) {
    const status = statusBody ? parseStatus(statusBody) : {};
    const trunk = trunkBody ? parseTrunk(trunkBody) : {};
    return rows(body, 'interface').filter(r => r && r.interface).map((r) => {
        const key = ifKey(r.interface);
        const st = status[key];
        const t = trunk[key];
        const ipAddr = r.eth_ip_addr || r.svi_ip_addr;
        const ipMask = r.eth_ip_mask || r.svi_ip_mask;
        const ip = ipAddr ? (ipMask ? `${ipAddr}/${ipMask}` : String(ipAddr)) : null;
        let mode = ['access', 'trunk', 'routed'].includes(r.eth_mode) ? r.eth_mode : (st ? st.mode : null);
        if (t) mode = 'trunk';
        if (!mode && ip) mode = 'routed';
        const rateInterval = num(r.eth_load_interval1_rx);
        return {
            name: r.interface,
            shortName: shortIf(r.interface),
            alias: r.desc || r.svi_desc || (st && st.alias) || '',
            status: ifStatus(r, st),
            speed: speedOf(r.eth_speed) || (num(r.eth_bw) ? num(r.eth_bw) / 1000 : null),
            duplex: r.eth_duplex ? String(r.eth_duplex).toLowerCase() : null,
            mode,
            vlan: mode === 'trunk' ? (t ? t.native : 1) : mode === 'access' ? (st && st.vlan) || null : null,
            trunkVlans: t && t.allowed ? t.allowed.length : null,
            ip,
            mtu: num(r.eth_mtu ?? r.svi_mtu),
            mac: normalizeMac(r.eth_hw_addr || r.svi_mac),
            inErrors: num(r.eth_inerr),
            crcErrors: num(r.eth_crc),
            outErrors: num(r.eth_outerr),
            inDiscards: num(r.eth_indiscard),
            outDiscards: num(r.eth_outdiscard),
            rxBytes: num(r.eth_inbytes ?? r.svi_ucast_bytes_in),
            txBytes: num(r.eth_outbytes ?? r.svi_ucast_bytes_out),
            rxBps: num(r.eth_inrate1_bits),
            txBps: num(r.eth_outrate1_bits),
            rateInterval: r.eth_inrate1_bits !== undefined ? (rateInterval || 30) : null,
            zone: null,
        };
    });
}

/**
 * VLANs from `show vlan brief` with the trunks allowing each (`show interface trunk`, null when not readable).
 * NX-OS lists trunk ports among a VLAN's ports too: those are shown only as trunks.
 */
function parseVlans(body, trunkBody) {
    const trunks = Object.values(trunkBody ? parseTrunk(trunkBody) : {});
    const trunkKeys = new Set(trunks.map(t => t.port.toLowerCase()));
    return rows(body, 'vlanbriefxbrief')
        .map(r => ({ r, id: num(r['vlanshowbr-vlanid'] ?? r['vlanshowbr-vlanid-utf']) }))
        .filter(({ id }) => id !== null && !DEFAULT_LEGACY_VLANS.has(id))
        .map(({ r, id }) => ({
            id,
            name: r['vlanshowbr-vlanname'] || '',
            status: r['vlanshowbr-shutstate'] === 'shutdown' ? 'shutdown' : (r['vlanshowbr-vlanstate'] || 'active'),
            accessPorts: expandPorts(r['vlanshowplist-ifidx']).filter(p => !trunkKeys.has(p.toLowerCase())),
            trunkPorts: trunks.filter(t => !t.allowed || t.allowed.includes(id)).map(t => t.port),
        }))
        .sort((a, b) => a.id - b.id);
}

/** MAC table from `show mac address-table` (supervisor / gateway entries skipped). */
function parseMac(body) {
    const out = [];
    for (const r of rows(body, 'mac_address')) {
        const port = String(r.disp_port || '').trim();
        const vlan = num(String(r.disp_vlan || '').trim());
        const mac = normalizeMac(r.disp_mac_addr);
        if (!mac || vlan === null || !port || /sup-eth|\(R\)|^(CPU|Router|Drop)$/i.test(port)) continue;
        out.push({ mac, vlan, port: shortIf(port), type: /enabled|true/i.test(String(r.disp_is_static || '')) ? 'static' : 'dynamic' });
    }
    return out;
}

// Lines that change without a configuration change
const VOLATILE_LINES = [/^!Time:.*$/gm, /^!Running configuration last done at:.*$/gm];

/** running-config without the time stamp lines, trailing blanks trimmed. */
function cleanConfig(text) {
    let t = String(text || '').replace(/\r/g, '');
    for (const re of VOLATILE_LINES) t = t.replace(re, '');
    return t.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '').replace(/\s+$/, '\n');
}

module.exports = { rows, shortIf, ifKey, expandPorts, speedOf, parseSummary, parseTrunk, parseStatus, parseInterfaces, parseVlans, parseMac, cleanConfig };
