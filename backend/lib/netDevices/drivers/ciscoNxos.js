// Cisco NX-OS switches (read only). Two ways in, both giving the same JSON (parsers/nxos.js):
//   - NX-API (`feature nxapi`, HTTPS): POST /ins with `cli_show` (JSON) or `cli_show_ascii` (the running-config)
//   - SSH exec channel with a fixed whitelist of `show ... | json` commands (lib/netDevices/sshCli.js)
// `transport` of the profile picks the way (lib/netDevices/transport.js). A role of `network-operator` is enough.
const sshCli = require('../sshCli');
const { createClient } = require('../httpClient');
const nx = require('../parsers/nxos');
const { netError } = require('../errors');
const { viaTransport: via, firstThenParallel } = require('../transport');

const capabilities = ['summary', 'interfaces', 'vlans', 'mac'];
const MAC_MAX = 1000;
// a missing optional answer only leaves its fields empty; these failures still stop the request
const FATAL_CODES = new Set(['UNREACHABLE', 'AUTH', 'TLS', 'HOSTKEY']);

// key -> show command (the SSH form adds " | json", except the running-config which is text)
const COMMANDS = {
    version: 'show version',
    inventory: 'show inventory',
    resources: 'show system resources',
    interfaces: 'show interface',
    status: 'show interface status',
    trunk: 'show interface trunk',
    vlans: 'show vlan brief',
    mac: 'show mac address-table',
    running: 'show running-config',
};
const TEXT = new Set(['running']);
const OPTIONAL = new Set(['inventory', 'resources', 'status', 'trunk']);
const sshCommand = (k) => (TEXT.has(k) ? COMMANDS[k] : `${COMMANDS[k]} | json`);
const WHITELIST = Object.keys(COMMANDS).map(sshCommand);

const viaTransport = (profile, fns, ctx) => via(profile, fns, ctx, 'NX-API');

// ---- SSH ----

/** JSON body (or text) per key; optional keys are null when the device does not offer them. */
async function ssh(profile, keys) {
    const cmds = keys.map(sshCommand);
    const out = await sshCli.runCommands(profile, cmds, { mode: 'exec', whitelist: WHITELIST, optional: keys.filter(k => OPTIONAL.has(k)).map(sshCommand) });
    return Object.fromEntries(keys.map((k) => {
        const text = out[sshCommand(k)];
        if (text === null || text === undefined) return [k, null];
        if (TEXT.has(k)) return [k, text];
        if (!text.trim()) return [k, {}]; // an empty table prints nothing
        try {
            return [k, JSON.parse(text)];
        } catch (e) {
            if (OPTIONAL.has(k)) return [k, null];
            throw netError('UNSUPPORTED', `The device did not answer "${COMMANDS[k]} | json" with JSON (NX-OS 7.x or later is needed)`);
        }
    }));
}

// ---- NX-API ----

function apiClient(profile) {
    const user = profile.username || '';
    const password = (profile.secrets && profile.secrets.password) || '';
    if (!user || !password) throw netError('NOT_CONFIGURED', 'No user name / password stored for this device');
    const basic = Buffer.from(`${user}:${password}`).toString('base64');
    return createClient({
        host: profile.mgmtHost,
        port: profile.port,
        tlsVerify: profile.tlsVerify,
        caCert: profile.caCert,
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' },
        secrets: [password, basic],
    });
}

/** The `body` of one NX-API command; its own error code is classified like an HTTP status. */
async function apiCommand(client, key) {
    const ascii = TEXT.has(key);
    const data = await client.request({
        method: 'POST',
        path: '/ins',
        data: { ins_api: { version: '1.0', type: ascii ? 'cli_show_ascii' : 'cli_show', chunk: '0', sid: '1', input: COMMANDS[key], output_format: 'json' } },
    });
    const output = data && data.ins_api && data.ins_api.outputs && data.ins_api.outputs.output;
    const o = Array.isArray(output) ? output[0] : output;
    if (!o) throw netError('OTHER', 'The device answered with something that is not an NX-API reply');
    const code = String(o.code || '');
    if (code === '200') return o.body === undefined || o.body === '' ? (ascii ? '' : {}) : o.body;
    if (code === '401' || code === '403') throw netError('FORBIDDEN', `The account may not run "${COMMANDS[key]}"`);
    if (code === '400' || code === '404' || code === '501') throw netError('UNSUPPORTED', `The device does not offer "${COMMANDS[key]}"`);
    throw netError('OTHER', `NX-API error ${code}${o.msg ? `: ${String(o.msg).slice(0, 120)}` : ''}`);
}

async function api(profile, keys) {
    const client = apiClient(profile);
    const values = await firstThenParallel(keys.map(k => async () => {
        try {
            return await apiCommand(client, k);
        } catch (err) {
            if (OPTIONAL.has(k) && !FATAL_CODES.has(err.code)) return null;
            throw err;
        }
    }));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

/** Read `keys` the way the profile says. */
async function read(profile, keys, ctx) {
    return viaTransport(profile, { api: () => api(profile, keys), ssh: () => ssh(profile, keys) }, ctx);
}

// ---- capabilities ----

const facts = (s) => ({ model: s.model, hostname: s.hostname, version: s.version, serial: s.serial });

async function testConnection(profile) {
    const { value, transport } = await read(profile, ['version', 'inventory'], {});
    return { ...facts(nx.parseSummary(value)), transport };
}

async function getSummary(profile, opts, ctx) {
    const { value, transport } = await read(profile, ['version', 'inventory', 'resources'], ctx);
    return { ...nx.parseSummary(value), transport };
}

async function getInterfaces(profile, opts, ctx) {
    const { value: o } = await read(profile, ['interfaces', 'status', 'trunk'], ctx);
    return nx.parseInterfaces(o.interfaces, o.status, o.trunk);
}

async function getVlans(profile, opts, ctx) {
    const { value: o } = await read(profile, ['vlans', 'trunk'], ctx);
    return nx.parseVlans(o.vlans, o.trunk);
}

const MAC_QUERY_RE = /^[0-9a-fA-F.:\- ]{1,20}$/;
const PORT_QUERY_RE = /^[\w/.:-]{1,40}$/;

/** MAC table, filtered on the server: any MAC notation (also partial), a port (short or long name), a VLAN. */
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
    const { value: o } = await read(profile, ['mac'], ctx);
    const all = nx.parseMac(o.mac);
    const perPortCount = {};
    for (const r of all) perPortCount[r.port] = (perPortCount[r.port] || 0) + 1;
    const hex = macQ.toLowerCase().replace(/[^0-9a-f]/g, '');
    const port = portQ ? nx.ifKey(portQ) : null;
    const rows = all.filter(r => (!hex || r.mac.replace(/:/g, '').includes(hex))
        && (!port || nx.ifKey(r.port) === port)
        && (vlan === null || r.vlan === vlan));
    rows.sort((a, b) => a.port.localeCompare(b.port, undefined, { numeric: true }) || a.vlan - b.vlan || a.mac.localeCompare(b.mac));
    return { total: rows.length, truncated: rows.length > MAC_MAX, perPortCount, items: rows.slice(0, MAC_MAX) };
}

/** running-config over the profile's way (NX-API `cli_show_ascii` or SSH), time stamp lines removed. */
async function backupConfig(profile) {
    const { value: o } = await read(profile, ['running'], {});
    const content = nx.cleanConfig(o.running);
    if (!/^(hostname|version|feature)\b/m.test(content)) throw netError('OTHER', 'The device did not return a configuration');
    return { content, format: 'conf' };
}

module.exports = { capabilities, testConnection, getSummary, getInterfaces, getVlans, getMac, backupConfig, COMMANDS, WHITELIST };
