// Juniper Junos switches and routers (read only). Two ways in, both giving the same JSON (parsers/junos.js):
//   - REST API (`set system services rest https`, default port 3443): GET /rpc/<rpc-name> with Accept JSON
//   - SSH exec channel with a fixed whitelist of `show ... | display json` commands (lib/netDevices/sshCli.js)
// `transport` of the profile picks the way (lib/netDevices/transport.js). A login class of `read-only` is enough.
// The config backup (`show configuration | display set`) always reads over SSH.
const sshCli = require('../sshCli');
const { createClient } = require('../httpClient');
const j = require('../parsers/junos');
const { netError } = require('../errors');
const { viaTransport: via, firstThenParallel } = require('../transport');

const capabilities = ['summary', 'interfaces', 'vlans', 'mac'];
const MAC_MAX = 1000;
// a missing optional answer only leaves its fields empty; these failures still stop the request
const FATAL_CODES = new Set(['UNREACHABLE', 'AUTH', 'TLS', 'HOSTKEY']);

// key -> [RPC of the REST API, its parameters, CLI command]
const READS = {
    version: ['get-software-information', {}, 'show version'],
    inventory: ['get-chassis-inventory', {}, 'show chassis hardware'],
    engines: ['get-route-engine-information', {}, 'show chassis routing-engine'],
    interfaces: ['get-interface-information', { extensive: '' }, 'show interfaces extensive'],
    switching: ['get-ethernet-switching-interface-information', {}, 'show ethernet-switching interface'],
    vlans: ['get-vlan-information', {}, 'show vlans'],
    mac: ['get-ethernet-switching-table-information', {}, 'show ethernet-switching table'],
};
const CONFIG_COMMAND = 'show configuration | display set';
const sshCommand = (k) => `${READS[k][2]} | display json`;
const WHITELIST = [...Object.keys(READS).map(sshCommand), CONFIG_COMMAND];

const viaTransport = (profile, fns, ctx) => via(profile, fns, ctx, 'REST API');

// ---- SSH ----

async function ssh(profile, keys, optional) {
    const cmds = keys.map(sshCommand);
    const out = await sshCli.runCommands(profile, cmds, { mode: 'exec', whitelist: WHITELIST, optional: optional.map(sshCommand) });
    return Object.fromEntries(keys.map((k) => {
        const text = out[sshCommand(k)];
        if (text === null || text === undefined) return [k, null];
        if (!text.trim()) return [k, {}];
        let doc = null;
        try { doc = j.parseCliJson(text); } catch (e) { doc = null; }
        if (doc) return [k, doc];
        if (optional.includes(k)) return [k, null];
        throw netError('UNSUPPORTED', `The device did not answer "${sshCommand(k)}" with JSON (Junos 14.2 or later is needed)`);
    }));
}

// ---- REST API ----

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
        headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
        secrets: [password, basic],
    });
}

async function rest(profile, keys, optional) {
    const client = restClient(profile);
    const values = await firstThenParallel(keys.map(k => async () => {
        const [rpc, params] = READS[k];
        try {
            const data = await client.request({ path: `/rpc/${rpc}`, params: Object.keys(params).length ? params : undefined });
            if (data && typeof data === 'object') return data;
            if (data === '' || data === undefined || data === null) return {};
            throw netError('OTHER', `The device did not answer ${rpc} with JSON`);
        } catch (err) {
            if (optional.includes(k) && !FATAL_CODES.has(err.code)) return null;
            throw err;
        }
    }));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

/** Read `keys` the way the profile says; `optional` keys are null when the device does not give them. */
async function read(profile, keys, ctx, optional = []) {
    return viaTransport(profile, { api: () => rest(profile, keys, optional), ssh: () => ssh(profile, keys, optional) }, ctx);
}

// ---- capabilities ----

const facts = (s) => ({ model: s.model, hostname: s.hostname, version: s.version, serial: s.serial });

async function testConnection(profile) {
    const { value, transport } = await read(profile, ['version', 'inventory'], {}, ['inventory']);
    return { ...facts(j.parseSummary(value)), transport };
}

async function getSummary(profile, opts, ctx) {
    const { value, transport } = await read(profile, ['version', 'inventory', 'engines'], ctx, ['inventory', 'engines']);
    return { ...j.parseSummary(value), transport };
}

async function getInterfaces(profile, opts, ctx) {
    const { value: o } = await read(profile, ['interfaces', 'switching'], ctx, ['switching']);
    return j.parseInterfaces(o.interfaces, o.switching ? j.parseSwitching(o.switching) : null);
}

async function getVlans(profile, opts, ctx) {
    const { value: o } = await read(profile, ['vlans'], ctx);
    return j.parseVlans(o.vlans);
}

const MAC_QUERY_RE = /^[0-9a-fA-F.:\- ]{1,20}$/;
const PORT_QUERY_RE = /^[\w/.:-]{1,40}$/;

/** MAC table, filtered on the server: any MAC notation (also partial), a port, a VLAN. */
async function getMac(profile, opts = {}, ctx) {
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
    // the VLAN list names the tags of entries that only carry a VLAN name
    const { value: o } = await read(profile, ['mac', 'vlans'], ctx, ['vlans']);
    const vlanIds = Object.fromEntries((o.vlans ? j.parseVlans(o.vlans) : []).map(v => [v.name, v.id]));
    const all = j.parseMac(o.mac, vlanIds);
    const perPortCount = {};
    for (const r of all) perPortCount[r.port] = (perPortCount[r.port] || 0) + 1;
    const hex = macQ.toLowerCase().replace(/[^0-9a-f]/g, '');
    const port = portQ ? j.ifKey(portQ) : null;
    const rows = all.filter(r => (!hex || r.mac.replace(/:/g, '').includes(hex))
        && (!port || j.ifKey(r.port) === port)
        && (vlan === null || r.vlan === vlan));
    rows.sort((a, b) => a.port.localeCompare(b.port, undefined, { numeric: true }) || a.vlan - b.vlan || a.mac.localeCompare(b.mac));
    return { total: rows.length, truncated: rows.length > MAC_MAX, perPortCount, items: rows.slice(0, MAC_MAX) };
}

async function backupConfig(profile) {
    let out;
    try {
        out = await sshCli.runCommands(profile, [CONFIG_COMMAND], { mode: 'exec', whitelist: WHITELIST });
    } catch (err) {
        if (err.code === 'UNREACHABLE' && profile.transport !== 'ssh') {
            throw netError('UNSUPPORTED', `Config backup reads over SSH (port ${profile.sshPort || 22}), which did not answer: enable SSH on the device`);
        }
        throw err;
    }
    const content = j.cleanConfig(out[CONFIG_COMMAND]);
    if (!/^set /m.test(content)) throw netError('OTHER', 'The device did not return a configuration');
    return { content, format: 'conf' };
}

module.exports = { capabilities, testConnection, getSummary, getInterfaces, getVlans, getMac, backupConfig, READS, WHITELIST };
