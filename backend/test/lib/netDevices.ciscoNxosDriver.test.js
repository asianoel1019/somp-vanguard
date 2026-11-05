// cisco-nxos driver with the SSH layer and the HTTPS transport stubbed: NX-API requests, `| json` commands over SSH
// exec, optional answers, NX-API error codes, MAC filters, backup and the 'auto' change-over.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sshCli = require('../../lib/netDevices/sshCli');
const httpClient = require('../../lib/netDevices/httpClient');
const nxos = require('../../lib/netDevices/drivers/ciscoNxos');
const { netError } = require('../../lib/netDevices/errors');

const raw = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/cisco-nxos', name), 'utf8');
const BODY = {
    'show version': raw('show_version.json'),
    'show inventory': raw('show_inventory.json'),
    'show system resources': raw('show_system_resources.json'),
    'show interface': raw('show_interface.json'),
    'show interface status': raw('show_interface_status.json'),
    'show interface trunk': raw('show_interface_trunk.json'),
    'show vlan brief': raw('show_vlan_brief.json'),
    'show mac address-table': raw('show_mac_address_table.json'),
};
const RUNNING = raw('show_running_config.txt');

const realRun = sshCli.runCommands;
let calls = [];
let sshOut = {}; // command -> override (null = not offered)
let http = [];
let apiCode = {}; // command -> NX-API code
let httpFail = null;

test.beforeEach(() => {
    calls = [];
    sshOut = {};
    http = [];
    apiCode = {};
    httpFail = null;
    sshCli.runCommands = async (profile, cmds, opts) => {
        calls.push({ cmds, opts });
        return Object.fromEntries(cmds.map((c) => {
            if (c in sshOut) return [c, sshOut[c]];
            const base = c.replace(/ \| json$/, '');
            return [c, base === 'show running-config' ? RUNNING : BODY[base]];
        }));
    };
    httpClient.setTransportForTest(async (config) => {
        http.push(config);
        if (httpFail) throw httpFail;
        const { input, type } = config.data.ins_api;
        const code = apiCode[input] || '200';
        const body = code !== '200' ? undefined : type === 'cli_show_ascii' ? RUNNING : JSON.parse(BODY[input]);
        return { status: 200, data: { ins_api: { type, version: '1.0', sid: 'eoc', outputs: { output: { input, msg: code === '200' ? 'Success' : 'Input CLI command error', code, body } } } } };
    });
});
test.after(() => { sshCli.runCommands = realRun; httpClient.setTransportForTest(null); });

const base = { vendor: 'cisco-nxos', mgmtHost: '192.0.2.40', port: 443, sshPort: 22, username: 'netro', secrets: { password: 'pw-123456' } };
const api = { ...base, transport: 'api' };
const viaSsh = { ...base, transport: 'ssh' };
const auto = { ...base, transport: 'auto' };

test('whitelist: only "show ... | json" plus the running-config, exec mode', () => {
    assert.ok(nxos.WHITELIST.every(c => /^show [a-z -]+( \| json)?$/.test(c)));
    assert.ok(nxos.WHITELIST.includes('show running-config'));
    assert.ok(!nxos.WHITELIST.includes('show running-config | json'));
});

test('NX-API: POST /ins with cli_show and basic auth', async () => {
    const s = await nxos.getSummary(api);
    assert.equal(calls.length, 0, 'no SSH');
    assert.equal(http[0].method, 'POST');
    assert.equal(http[0].url, 'https://192.0.2.40:443/ins');
    assert.deepEqual(http[0].data.ins_api, { version: '1.0', type: 'cli_show', chunk: '0', sid: '1', input: 'show version', output_format: 'json' });
    assert.equal(http[0].headers.Authorization, `Basic ${Buffer.from('netro:pw-123456').toString('base64')}`);
    assert.deepEqual([s.model, s.hostname, s.version, s.cpu, s.memory, s.transport], ['N9K-C93180YC-EX', 'nx-lab-leaf1', '9.3(10)', 6, 30, 'api']);
    const by = Object.fromEntries((await nxos.getInterfaces(api)).map(i => [i.shortName, i]));
    assert.deepEqual([by['Eth1/1'].mode, by['Eth1/1'].vlan, by['Eth1/3'].status], ['access', 10, 'err-disabled']);
    const v = Object.fromEntries((await nxos.getVlans(api)).map(x => [x.id, x]));
    assert.deepEqual(v[10].trunkPorts, ['Eth1/49', 'Po10']);
});

test('NX-API: optional commands may be missing; required ones and wrong passwords fail', async () => {
    apiCode['show system resources'] = '400';
    apiCode['show interface trunk'] = '403';
    const s = await nxos.getSummary(api);
    assert.deepEqual([s.cpu, s.model], [null, 'N9K-C93180YC-EX']);
    assert.equal((await nxos.getInterfaces(api)).find(i => i.shortName === 'Po10').mode, 'trunk', 'mode from show interface');
    apiCode['show interface'] = '400';
    await assert.rejects(nxos.getInterfaces(api), (e) => e.code === 'UNSUPPORTED');
    apiCode['show mac address-table'] = '500';
    await assert.rejects(nxos.getMac(api), (e) => e.code === 'OTHER' && /NX-API error 500/.test(e.message));
    http = [];
    httpFail = Object.assign(new Error('401'), { response: { status: 401 } });
    await assert.rejects(nxos.getSummary(api), (e) => e.code === 'AUTH');
    assert.equal(http.length, 1, 'a wrong password fails on the first request alone');
    await assert.rejects(nxos.getSummary({ ...api, secrets: {} }), (e) => e.code === 'NOT_CONFIGURED');
});

test('SSH: "| json" commands on the exec channel, optional ones may be missing or not JSON', async () => {
    const s = await nxos.getSummary(viaSsh);
    assert.equal(http.length, 0, 'no HTTPS');
    assert.deepEqual(calls[0].cmds, ['show version | json', 'show inventory | json', 'show system resources | json']);
    assert.equal(calls[0].opts.mode, 'exec');
    assert.deepEqual(calls[0].opts.optional, ['show inventory | json', 'show system resources | json']);
    assert.equal(calls[0].opts.whitelist, nxos.WHITELIST);
    assert.deepEqual([s.model, s.serial, s.transport], ['N9K-C93180YC-EX', 'FDO0000LAB0', 'ssh']);

    sshOut['show inventory | json'] = null;
    sshOut['show system resources | json'] = 'not json';
    const bare = await nxos.getSummary(viaSsh);
    assert.deepEqual([bare.model, bare.cpu], ['Nexus9000 C93180YC-EX', null]);

    sshOut['show mac address-table | json'] = '';
    assert.equal((await nxos.getMac(viaSsh)).total, 0, 'an empty table prints nothing');
    sshOut['show interface | json'] = 'Ethernet1/1 is up';
    await assert.rejects(nxos.getInterfaces(viaSsh), (e) => e.code === 'UNSUPPORTED' && /JSON/.test(e.message));
});

test('MAC filters and validation', async () => {
    let r = await nxos.getMac(viaSsh, {});
    assert.equal(r.total, 5);
    assert.equal(r.perPortCount['Eth1/49'], 3);
    r = await nxos.getMac(viaSsh, { port: 'Ethernet1/49', vlan: '10' });
    assert.deepEqual(r.items.map(x => x.mac), ['00:00:5e:00:53:21', '00:00:5e:00:53:22']);
    r = await nxos.getMac(viaSsh, { mac: '0000.5E00.5330' });
    assert.deepEqual(r.items.map(x => x.port), ['Po10']);
    for (const bad of [{ mac: 'x;y' }, { port: 'Eth1/1 | include' }, { vlan: '0' }]) {
        await assert.rejects(nxos.getMac(viaSsh, bad), (e) => e.code === 'BAD_REQUEST', JSON.stringify(bad));
    }
});

test('backup: running-config as text over NX-API (cli_show_ascii) or SSH', async () => {
    let b = await nxos.backupConfig(api);
    assert.equal(http[0].data.ins_api.type, 'cli_show_ascii');
    assert.equal(b.format, 'conf');
    assert.ok(!/!Time:/.test(b.content));
    b = await nxos.backupConfig(viaSsh);
    assert.deepEqual(calls[0].cmds, ['show running-config']);
    assert.match(b.content, /^hostname nx-lab-leaf1$/m);
    sshOut['show running-config'] = '';
    await assert.rejects(nxos.backupConfig(viaSsh), (e) => e.code === 'OTHER');
});

test('auto: NX-API first, SSH when NX-API is off; credentials errors do not change over', async () => {
    const seen = [];
    const ctx = { setTransport: (t) => seen.push(t) };
    let s = await nxos.getSummary(auto, {}, ctx);
    assert.deepEqual([s.transport, seen], ['api', ['api']]);

    seen.length = 0;
    httpFail = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    s = await nxos.getSummary(auto, {}, ctx);
    assert.deepEqual([s.transport, seen], ['ssh', ['ssh']]);

    calls = [];
    httpFail = Object.assign(new Error('401'), { response: { status: 401 } });
    await assert.rejects(nxos.getSummary(auto, {}, ctx), (e) => e.code === 'AUTH');
    assert.equal(calls.length, 0);

    httpFail = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    sshCli.runCommands = async () => { throw netError('UNREACHABLE', 'SSH connection failed'); };
    await assert.rejects(nxos.testConnection(auto), (e) => /^NX-API: .*; SSH: SSH connection failed$/.test(e.message));
});

test('test connection: facts and the way used', async () => {
    const t = await nxos.testConnection(auto);
    assert.deepEqual(t, { model: 'N9K-C93180YC-EX', hostname: 'nx-lab-leaf1', version: '9.3(10)', serial: 'FDO0000LAB0', transport: 'api' });
});
