// Cisco IOS / IOS-XE switches and routers (read only). Two ways in, both returning the same unified fields:
//   - RESTCONF (IOS-XE 16.x+, HTTPS, YANG JSON; the account needs privilege 15), parsers/ciscoRestconf.js
//   - SSH with a fixed whitelist of `show` commands (lib/netDevices/sshCli.js), parsers/ciscoIos.js
// `transport` of the profile picks the way (lib/netDevices/transport.js). The config backup always reads over SSH
// (RESTCONF has no plain-text config).
const sshCli = require('../sshCli');
const { createClient } = require('../httpClient');
const p = require('../parsers/ciscoIos');
const rc = require('../parsers/ciscoRestconf');
const { netError } = require('../errors');
const { viaTransport: via, firstThenParallel } = require('../transport');

const capabilities = ['summary', 'interfaces', 'vlans', 'mac'];
const MAC_MAX = 1000;
// a missing optional RESTCONF answer only leaves its fields empty; these failures still stop the request
const FATAL_CODES = new Set(['UNREACHABLE', 'AUTH', 'TLS']);

const COMMANDS = {
    version: 'show version',
    inventory: 'show inventory',
    interfaces: 'show interfaces',
    status: 'show interfaces status',
    trunk: 'show interfaces trunk',
    vlans: 'show vlan brief',
    mac: 'show mac address-table',
    running: 'show running-config',
};
const WHITELIST = Object.values(COMMANDS);
const PRIVILEGED = [COMMANDS.running];
// not every model / role has these: a missing one only leaves its fields empty
const OPTIONAL = [COMMANDS.inventory, COMMANDS.status, COMMANDS.trunk];

const RESTCONF = {
    hardware: 'Cisco-IOS-XE-device-hardware-oper:device-hardware-data',
    hostname: 'Cisco-IOS-XE-native:native/hostname',
    cpu: 'Cisco-IOS-XE-process-cpu-oper:cpu-usage/cpu-utilization',
    memory: 'Cisco-IOS-XE-memory-oper:memory-statistics',
    stack: 'Cisco-IOS-XE-stack-oper:stack-oper-data',
    interfaces: 'Cisco-IOS-XE-interfaces-oper:interfaces',
    switchport: 'Cisco-IOS-XE-native:native/interface',
    vlans: 'Cisco-IOS-XE-vlan-oper:vlans',
    mac: 'Cisco-IOS-XE-matm-oper:matm-oper-data',
};
const RESTCONF_OPTIONAL = new Set(['hostname', 'cpu', 'memory', 'stack', 'switchport']);

// ---- SSH ----

/** Output per key of COMMANDS. */
async function ssh(profile, keys) {
    const cmds = keys.map(k => COMMANDS[k]);
    const out = await sshCli.runCommands(profile, cmds, { mode: 'shell', whitelist: WHITELIST, privileged: PRIVILEGED, optional: OPTIONAL });
    return Object.fromEntries(keys.map(k => [k, out[COMMANDS[k]]]));
}

// ---- RESTCONF ----

function restClient(profile) {
    const user = profile.username || '';
    const password = (profile.secrets && profile.secrets.password) || '';
    if (!user || !password) throw netError('NOT_CONFIGURED', 'No user name / password stored for this device');
    const basic = Buffer.from(`${user}:${password}`).toString('base64');
    return createClient({
        host: profile.mgmtHost,
        port: profile.port,
        tlsVerify: profile.tlsVerify,
        caCert: profile.caCert,
        headers: { Authorization: `Basic ${basic}`, Accept: 'application/yang-data+json' },
        secrets: [password, basic],
    });
}

/** Answers per key of RESTCONF; optional ones are null when the device does not give them. */
async function restconf(profile, keys) {
    const client = restClient(profile);
    const get = async (k) => {
        try {
            const data = await client.request({ path: `/restconf/data/${RESTCONF[k]}` });
            // 204 No Content: the node exists but is empty
            return data && typeof data === 'object' ? data : {};
        } catch (err) {
            if (RESTCONF_OPTIONAL.has(k) && !FATAL_CODES.has(err.code)) return null;
            throw err;
        }
    };
    const values = await firstThenParallel(keys.map(k => () => get(k)));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

const viaTransport = (profile, fns, ctx) => via(profile, fns, ctx, 'RESTCONF');

// ---- capabilities ----

function facts(v) {
    return { model: v.model, hostname: v.hostname, version: v.version, serial: v.serial };
}

async function summaryVia(profile, ctx, keysApi, keysSsh) {
    return viaTransport(profile, {
        api: async () => {
            const o = await restconf(profile, keysApi);
            return rc.parseSummary(o);
        },
        ssh: async () => {
            const o = await ssh(profile, keysSsh);
            const v = p.parseVersion(o.version);
            const inv = o.inventory ? p.parseInventory(o.inventory) : [];
            for (const m of v.members) {
                const item = inv.find(x => new RegExp(`^switch\\s*0*${m.slot}$`, 'i').test(x.name));
                if (item && item.serial) m.serial = item.serial;
            }
            return { ...facts(v), uptime: v.uptime, cpu: null, memory: null, members: v.members.length > 1 ? v.members : [] };
        },
    }, ctx);
}

async function testConnection(profile) {
    const { value, transport } = await summaryVia(profile, {}, ['hardware', 'hostname'], ['version']);
    return { ...facts(value), transport };
}

async function getSummary(profile, opts, ctx) {
    const { value, transport } = await summaryVia(profile, ctx, ['hardware', 'hostname', 'cpu', 'memory', 'stack'], ['version', 'inventory']);
    return { ...value, transport };
}

async function getInterfaces(profile, opts, ctx) {
    const { value } = await viaTransport(profile, {
        api: async () => {
            const o = await restconf(profile, ['interfaces', 'switchport']);
            return rc.parseInterfaces(o.interfaces, o.switchport ? rc.parseSwitchport(o.switchport) : null);
        },
        ssh: async () => {
            const o = await ssh(profile, ['interfaces', 'status', 'trunk']);
            const status = o.status ? p.parseInterfacesStatus(o.status) : {};
            const trunk = o.trunk ? p.parseTrunk(o.trunk) : {};
            return p.parseInterfaces(o.interfaces).map((i) => {
                const key = p.ifKey(i.name);
                const s = status[key];
                const t = trunk[key];
                let mode = s ? s.mode : (i.ip ? 'routed' : null);
                if (t) mode = 'trunk';
                return {
                    ...i,
                    alias: i.alias || (s && s.alias) || '',
                    shortName: p.shortIf(i.name),
                    mode,
                    vlan: t ? t.native : (s ? s.vlan : null),
                    trunkVlans: t ? (t.active.length ? t.active : t.allowed).length : null,
                    zone: null,
                };
            });
        },
    }, ctx);
    return value;
}

async function getVlans(profile, opts, ctx) {
    const { value } = await viaTransport(profile, {
        api: async () => {
            const o = await restconf(profile, ['vlans', 'switchport']);
            return rc.parseVlans(o.vlans, o.switchport ? rc.parseSwitchport(o.switchport) : null);
        },
        ssh: async () => {
            const o = await ssh(profile, ['vlans', 'trunk']);
            const trunk = o.trunk ? Object.values(p.parseTrunk(o.trunk)) : [];
            return p.parseVlanBrief(o.vlans).map(v => ({
                ...v,
                trunkPorts: trunk.filter(t => (t.active.length ? t.active : t.allowed).includes(v.id)).map(t => t.port),
            }));
        },
    }, ctx);
    return value;
}

const MAC_QUERY_RE = /^[0-9a-fA-F.:\- ]{1,20}$/;
const PORT_QUERY_RE = /^[\w/.:-]{1,40}$/;

/** Validated MAC filters (before anything is read from the device). */
function macFilter(opts) {
    const macQ = String(opts.mac || '').trim();
    const portQ = String(opts.port || '').trim();
    const vlanQ = String(opts.vlan || '').trim();
    if (macQ && !MAC_QUERY_RE.test(macQ)) throw netError('BAD_REQUEST', 'MAC filter: hex digits with . : - separators only');
    if (portQ && !PORT_QUERY_RE.test(portQ)) throw netError('BAD_REQUEST', 'Invalid port filter');
    let vlan = null;
    if (vlanQ) {
        vlan = Number(vlanQ);
        if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) throw netError('BAD_REQUEST', 'VLAN must be 1-4094');
    }
    return { hex: macQ.toLowerCase().replace(/[^0-9a-f]/g, ''), port: portQ ? p.ifKey(portQ) : null, vlan };
}

/** MAC table, filtered on the server: any MAC notation (also partial), a port (short or long name), a VLAN. */
async function getMac(profile, opts = {}, ctx) {
    const f = macFilter(opts);
    const { value: all } = await viaTransport(profile, {
        api: async () => rc.parseMac((await restconf(profile, ['mac'])).mac),
        ssh: async () => p.parseMacTable((await ssh(profile, ['mac'])).mac),
    }, ctx);
    const perPortCount = {};
    for (const r of all) perPortCount[r.port] = (perPortCount[r.port] || 0) + 1;
    const rows = all.filter(r => (!f.hex || r.mac.replace(/:/g, '').includes(f.hex))
        && (!f.port || p.ifKey(r.port) === f.port)
        && (f.vlan === null || r.vlan === f.vlan));
    rows.sort((a, b) => a.port.localeCompare(b.port, undefined, { numeric: true }) || a.vlan - b.vlan || a.mac.localeCompare(b.mac));
    return { total: rows.length, truncated: rows.length > MAC_MAX, perPortCount, items: rows.slice(0, MAC_MAX) };
}

async function backupConfig(profile) {
    let o;
    try {
        o = await ssh(profile, ['running']);
    } catch (err) {
        if (err.code === 'UNREACHABLE' && profile.transport !== 'ssh') {
            throw netError('UNSUPPORTED', `Config backup reads over SSH (port ${profile.sshPort || 22}), which did not answer: enable SSH on the device`);
        }
        throw err;
    }
    const content = p.cleanConfig(o.running);
    if (!/^(hostname|version|end)\b/m.test(content)) throw netError('OTHER', 'The device did not return a configuration');
    return { content, format: 'conf' };
}

module.exports = { capabilities, testConnection, getSummary, getInterfaces, getVlans, getMac, backupConfig, COMMANDS, RESTCONF };
