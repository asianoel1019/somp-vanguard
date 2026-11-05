// juniper driver with the SSH layer and the HTTPS transport stubbed: REST RPCs, `| display json` over SSH exec,
// optional answers, MAC VLAN names, backup over SSH and the 'auto' change-over.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sshCli = require('../../lib/netDevices/sshCli');
const httpClient = require('../../lib/netDevices/httpClient');
const junos = require('../../lib/netDevices/drivers/juniper');
const { netError } = require('../../lib/netDevices/errors');

const raw = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/juniper', name), 'utf8');
const BY_CLI = {
    'show version': raw('show_version.json'),
    'show chassis hardware': raw('show_chassis_hardware.json'),
    'show chassis routing-engine': raw('show_chassis_routing_engine.json'),
    'show interfaces extensive': raw('show_interfaces_extensive.json'),
    'show ethernet-switching interface': raw('show_ethernet_switching_interface.json'),
    'show vlans': raw('show_vlans.json'),
    'show ethernet-switching table': raw('show_ethernet_switching_table.json'),
};
const BY_RPC = Object.fromEntries(Object.entries(junos.READS).map(([, [rpc, , cli]]) => [rpc, BY_CLI[cli]]));
const CONFIG = raw('show_configuration_set.txt');

const realRun = sshCli.runCommands;
let calls = [];
let sshOut = {};
let http = [];
let rpcFail = {};

test.beforeEach(() => {
    calls = [];
    sshOut = {};
    http = [];
    rpcFail = {};
    sshCli.runCommands = async (profile, cmds, opts) => {
        calls.push({ cmds, opts });
        return Object.fromEntries(cmds.map((c) => {
            if (c in sshOut) return [c, sshOut[c]];
            if (c === 'show configuration | display set') return [c, CONFIG];
            return [c, `{master:0}\n${BY_CLI[c.replace(/ \| display json$/, '')]}\n{master:0}\n`];
        }));
    };
    httpClient.setTransportForTest(async (config) => {
        http.push(config);
        const rpc = config.url.split('/rpc/')[1];
        const fail = rpcFail[rpc] || rpcFail['*'];
        if (fail) throw fail;
        if (!BY_RPC[rpc]) throw Object.assign(new Error('404'), { response: { status: 404 } });
        return { status: 200, data: JSON.parse(BY_RPC[rpc]) };
    });
});
test.after(() => { sshCli.runCommands = realRun; httpClient.setTransportForTest(null); });

const base = { vendor: 'juniper', mgmtHost: '192.0.2.70', port: 3443, sshPort: 22, username: 'netro', secrets: { password: 'pw-123456' } };
const api = { ...base, transport: 'api' };
const viaSsh = { ...base, transport: 'ssh' };
const auto = { ...base, transport: 'auto' };
const httpErr = (status) => Object.assign(new Error(String(status)), { response: { status } });

test('whitelist: only "show ... | display json" and the set-format configuration', () => {
    assert.ok(junos.WHITELIST.every(c => /^show [a-z -]+ \| display (json|set)$/.test(c)), junos.WHITELIST.join('\n'));
});

test('REST API: GET /rpc/<rpc> with basic auth and JSON', async () => {
    const s = await junos.getSummary(api);
    assert.equal(calls.length, 0, 'no SSH');
    assert.equal(http[0].method, 'GET');
    assert.equal(http[0].url, 'https://192.0.2.70:3443/rpc/get-software-information');
    assert.equal(http[0].headers.Accept, 'application/json');
    assert.equal(http[0].headers.Authorization, `Basic ${Buffer.from('netro:pw-123456').toString('base64')}`);
    assert.deepEqual([s.model, s.hostname, s.version, s.cpu, s.memory, s.transport], ['EX4300-48T', 'ex-lab-access1', '21.4R3-S5.4', 9, 42, 'api']);
    assert.equal(s.members.length, 2);
    http = [];
    const by = Object.fromEntries((await junos.getInterfaces(api)).map(i => [i.name, i]));
    assert.deepEqual(http[0].params, { extensive: '' });
    assert.deepEqual([by['ge-0/0/1'].mode, by['ge-0/0/1'].vlan, by['xe-0/2/0'].mode], ['access', 10, 'trunk']);
    const v = Object.fromEntries((await junos.getVlans(api)).map(x => [x.id, x]));
    assert.deepEqual(v[10].trunkPorts, ['xe-0/2/0', 'ae0']);
});

test('REST API: optional RPCs may fail; required ones and wrong passwords stop the request', async () => {
    rpcFail['get-route-engine-information'] = httpErr(500);
    rpcFail['get-ethernet-switching-interface-information'] = httpErr(403);
    const s = await junos.getSummary(api);
    assert.deepEqual([s.cpu, s.model], [null, 'EX4300-48T']);
    assert.equal((await junos.getInterfaces(api)).find(i => i.name === 'ge-0/0/1').mode, null);
    rpcFail['get-vlan-information'] = httpErr(404);
    await assert.rejects(junos.getVlans(api), (e) => e.code === 'UNSUPPORTED');
    http = [];
    rpcFail['*'] = httpErr(401);
    await assert.rejects(junos.getSummary(api), (e) => e.code === 'AUTH');
    assert.equal(http.length, 1, 'a wrong password fails on the first request alone');
    await assert.rejects(junos.getSummary({ ...api, secrets: {} }), (e) => e.code === 'NOT_CONFIGURED');
});

test('SSH: "| display json" on the exec channel, virtual chassis prompts removed', async () => {
    const s = await junos.getSummary(viaSsh);
    assert.equal(http.length, 0, 'no HTTPS');
    assert.deepEqual(calls[0].cmds, ['show version | display json', 'show chassis hardware | display json', 'show chassis routing-engine | display json']);
    assert.equal(calls[0].opts.mode, 'exec');
    assert.deepEqual(calls[0].opts.optional, ['show chassis hardware | display json', 'show chassis routing-engine | display json']);
    assert.deepEqual([s.serial, s.transport], ['PE0000LAB01', 'ssh']);
    sshOut['show chassis routing-engine | display json'] = 'error: syntax error';
    assert.equal((await junos.getSummary(viaSsh)).cpu, null);
    sshOut['show vlans | display json'] = '';
    assert.deepEqual(await junos.getVlans(viaSsh), []);
    sshOut['show interfaces extensive | display json'] = 'Physical interface: ge-0/0/1';
    await assert.rejects(junos.getInterfaces(viaSsh), (e) => e.code === 'UNSUPPORTED' && /JSON/.test(e.message));
});

test('MAC: VLAN names mapped to tags, filters, validation', async () => {
    let r = await junos.getMac(viaSsh, {});
    assert.deepEqual(calls[0].opts.optional, ['show vlans | display json']);
    assert.equal(r.total, 5);
    assert.equal(r.perPortCount['xe-0/2/0'], 3);
    r = await junos.getMac(viaSsh, { port: 'xe-0/2/0.0', vlan: '10' });
    assert.deepEqual(r.items.map(x => x.mac), ['00:00:5e:00:53:21', '00:00:5e:00:53:22']);
    sshOut['show vlans | display json'] = null;
    assert.equal((await junos.getMac(viaSsh, {})).total, 4, 'without the VLAN list an entry with only a name is left out');
    for (const bad of [{ mac: 'x;y' }, { port: 'ge-0/0/1 | count' }, { vlan: '4095' }]) {
        await assert.rejects(junos.getMac(viaSsh, bad), (e) => e.code === 'BAD_REQUEST', JSON.stringify(bad));
    }
});

test('backup: set-format configuration over SSH; hint when only the REST API answers', async () => {
    const b = await junos.backupConfig(api);
    assert.deepEqual(calls[0].cmds, ['show configuration | display set']);
    assert.ok(b.content.startsWith('set version'));
    assert.equal(b.format, 'conf');
    sshCli.runCommands = async () => { throw netError('UNREACHABLE', 'SSH connection failed'); };
    await assert.rejects(junos.backupConfig(api), (e) => e.code === 'UNSUPPORTED' && /enable SSH/.test(e.message));
    await assert.rejects(junos.backupConfig(viaSsh), (e) => e.code === 'UNREACHABLE');
});

test('auto: REST first, SSH when REST is off; credential errors do not change over', async () => {
    const seen = [];
    const ctx = { setTransport: (t) => seen.push(t) };
    let s = await junos.getSummary(auto, {}, ctx);
    assert.deepEqual([s.transport, seen], ['api', ['api']]);
    seen.length = 0;
    rpcFail['*'] = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    s = await junos.getSummary(auto, {}, ctx);
    assert.deepEqual([s.transport, seen], ['ssh', ['ssh']]);
    calls = [];
    rpcFail['*'] = httpErr(401);
    await assert.rejects(junos.getSummary(auto, {}, ctx), (e) => e.code === 'AUTH');
    assert.equal(calls.length, 0);
    const t = await junos.testConnection({ ...auto, lastTransport: 'ssh' });
    assert.deepEqual(t, { model: 'EX4300-48T', hostname: 'ex-lab-access1', version: '21.4R3-S5.4', serial: 'PE0000LAB01', transport: 'ssh' });
});
