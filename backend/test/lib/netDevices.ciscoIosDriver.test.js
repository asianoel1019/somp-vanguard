// cisco-ios driver with the SSH layer and the HTTPS transport stubbed: commands asked for, merged results, MAC filters,
// backup, RESTCONF answers and the 'auto' change-over rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const sshCli = require('../../lib/netDevices/sshCli');
const ios = require('../../lib/netDevices/drivers/ciscoIos');
const { netError } = require('../../lib/netDevices/errors');
const httpClient = require('../../lib/netDevices/httpClient');

const fx = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/cisco-ios', name), 'utf8');
const OUT = {
    'show version': fx('show_version_9300.txt'),
    'show inventory': fx('show_inventory.txt'),
    'show interfaces': fx('show_interfaces.txt'),
    'show interfaces status': fx('show_interfaces_status.txt'),
    'show interfaces trunk': fx('show_interfaces_trunk.txt'),
    'show vlan brief': fx('show_vlan_brief.txt'),
    'show mac address-table': fx('show_mac_address_table.txt'),
    'show running-config': fx('show_running_config.txt'),
};
const real = sshCli.runCommands;
let calls = [];
let missing = [];
test.beforeEach(() => {
    calls = [];
    missing = [];
    sshCli.runCommands = async (profile, cmds, opts) => {
        calls.push({ cmds, opts });
        return Object.fromEntries(cmds.map(c => [c, missing.includes(c) ? null : OUT[c]]));
    };
});
test.after(() => { sshCli.runCommands = real; httpClient.setTransportForTest(null); });

const profile = { vendor: 'cisco-ios', mgmtHost: '192.0.2.20', sshPort: 22, transport: 'ssh', username: 'netro', secrets: { password: 'pw-123456' } };

test('whitelist and options passed to the SSH layer', async () => {
    await ios.testConnection(profile);
    const { opts } = calls[0];
    assert.deepEqual(calls[0].cmds, ['show version']);
    assert.equal(opts.mode, 'shell');
    assert.ok(opts.whitelist.every(c => c.startsWith('show ')));
    assert.deepEqual(opts.privileged, ['show running-config']);
    assert.ok(opts.optional.includes('show interfaces trunk'));
});


test('summary with stack members', async () => {
    const s = await ios.getSummary(profile);
    assert.deepEqual([s.model, s.hostname, s.version, s.serial], ['C9300-48P', 'sw-lab-core', '17.09.04a', 'FOC0000LAB1']);
    assert.deepEqual(s.members.map(m => [m.slot, m.serial, m.role]), [[1, 'FOC0000LAB1', 'active'], [2, 'FOC0000LAB2', 'member']]);
    missing = ['show inventory'];
    assert.equal((await ios.getSummary(profile)).members[1].serial, 'FOC0000LAB2', 'serial from show version when inventory is missing');
});

test('interfaces merge counters, mode and VLAN', async () => {
    const by = Object.fromEntries((await ios.getInterfaces(profile)).map(i => [i.shortName, i]));
    assert.deepEqual([by['Gi1/0/1'].mode, by['Gi1/0/1'].vlan, by['Gi1/0/1'].crcErrors], ['access', 10, 3]);
    assert.deepEqual([by['Gi1/0/3'].mode, by['Gi1/0/3'].vlan, by['Gi1/0/3'].trunkVlans], ['trunk', 1, 4]);
    assert.equal(by['Gi1/0/48'].mode, 'routed');
    assert.equal(by['Gi1/0/4'].status, 'err-disabled');
    assert.equal(by.Vl10.ip, '192.0.2.1/24');
    // a router without "show interfaces status / trunk"
    missing = ['show interfaces status', 'show interfaces trunk'];
    const r = Object.fromEntries((await ios.getInterfaces(profile)).map(i => [i.shortName, i]));
    assert.equal(r['Gi1/0/48'].mode, 'routed');
    assert.equal(r['Gi1/0/1'].mode, null);
});

test('VLANs with access and trunk ports', async () => {
    const v = Object.fromEntries((await ios.getVlans(profile)).map(x => [x.id, x]));
    assert.deepEqual(v[10].accessPorts, ['Gi1/0/1', 'Gi1/0/2']);
    assert.deepEqual(v[10].trunkPorts, ['Gi1/0/3', 'Po1']);
    assert.deepEqual(v[30].trunkPorts, ['Gi1/0/3', 'Po1']);
    assert.deepEqual(v[99].trunkPorts, [], 'native-only VLAN not active on any trunk');
    assert.deepEqual(v[1].trunkPorts, ['Gi1/0/3']);
});

test('MAC table: filters in any notation, per-port counts, cap', async () => {
    let r = await ios.getMac(profile, {});
    assert.equal(r.total, 6);
    assert.equal(r.perPortCount['Gi1/0/3'], 3);
    r = await ios.getMac(profile, { mac: '0000.5E00.5310' });
    assert.deepEqual(r.items.map(x => x.port), ['Gi1/0/1']);
    r = await ios.getMac(profile, { mac: '53:2' });
    assert.equal(r.total, 3);
    r = await ios.getMac(profile, { port: 'GigabitEthernet1/0/3' });
    assert.equal(r.total, 3);
    r = await ios.getMac(profile, { vlan: '20' });
    assert.deepEqual(r.items.map(x => x.mac), ['00:00:5e:00:53:23', '00:00:5e:00:53:30']);
    for (const bad of [{ mac: 'zz;reload' }, { port: 'Gi1/0/1 | include x' }, { vlan: '5000' }]) {
        await assert.rejects(ios.getMac(profile, bad), (e) => e.code === 'BAD_REQUEST', JSON.stringify(bad));
    }
    const many = Array.from({ length: 1500 }, (_, i) => `  10    0000.5e00.${(0x5300 + (i % 256)).toString(16)}    DYNAMIC     Gi1/0/${(i % 48) + 1}`).join('\n');
    sshCli.runCommands = async (p, cmds) => Object.fromEntries(cmds.map(c => [c, many]));
    r = await ios.getMac(profile, {});
    assert.equal(r.total, 1500);
    assert.equal(r.items.length, 1000);
    assert.equal(r.truncated, true);
});

test('backup: cleaned running-config; errors pass through', async () => {
    const b = await ios.backupConfig(profile);
    assert.equal(b.format, 'conf');
    assert.ok(!/Last configuration change/.test(b.content));
    assert.ok(calls[0].cmds.includes('show running-config'));
    sshCli.runCommands = async () => { throw netError('FORBIDDEN', 'no enable'); };
    await assert.rejects(ios.backupConfig(profile), (e) => e.code === 'FORBIDDEN');
});

// ---- RESTCONF and 'auto' ----

const rfx = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/cisco-restconf', name), 'utf8'));
const ANSWERS = {
    'Cisco-IOS-XE-device-hardware-oper:device-hardware-data': rfx('device_hardware.json'),
    'Cisco-IOS-XE-native:native/hostname': rfx('hostname.json'),
    'Cisco-IOS-XE-process-cpu-oper:cpu-usage/cpu-utilization': rfx('cpu.json'),
    'Cisco-IOS-XE-memory-oper:memory-statistics': rfx('memory.json'),
    'Cisco-IOS-XE-stack-oper:stack-oper-data': rfx('stack.json'),
    'Cisco-IOS-XE-interfaces-oper:interfaces': rfx('interfaces.json'),
    'Cisco-IOS-XE-native:native/interface': rfx('native_interface.json'),
    'Cisco-IOS-XE-vlan-oper:vlans': rfx('vlans.json'),
    'Cisco-IOS-XE-matm-oper:matm-oper-data': rfx('mac.json'),
};
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const netErr = (code) => Object.assign(new Error(code), { code });
let http = [];
let httpFail = {}; // model -> error to throw ('*' for every request)
function stubHttp() {
    http = [];
    httpFail = {};
    httpClient.setTransportForTest(async (config) => {
        const model = config.url.split('/restconf/data/')[1];
        http.push({ url: config.url, headers: config.headers });
        if (httpFail[model] || httpFail['*']) throw httpFail[model] || httpFail['*'];
        if (!ANSWERS[model]) throw httpErr(404);
        return { status: 200, data: ANSWERS[model] };
    });
}
const api = { ...profile, transport: 'api', port: 443 };
const auto = { ...profile, transport: 'auto', port: 443 };

test('RESTCONF: basic auth, YANG JSON, summary / interfaces / VLAN / MAC', async () => {
    stubHttp();
    const s = await ios.getSummary(api);
    assert.equal(calls.length, 0, 'no SSH');
    assert.equal(http[0].url, 'https://192.0.2.20:443/restconf/data/Cisco-IOS-XE-device-hardware-oper:device-hardware-data');
    assert.equal(http[0].headers.Accept, 'application/yang-data+json');
    assert.equal(http[0].headers.Authorization, `Basic ${Buffer.from('netro:pw-123456').toString('base64')}`);
    assert.deepEqual([s.model, s.hostname, s.version, s.cpu, s.memory, s.transport], ['C9300-48P', 'sw-lab-core', '17.09.04a', 6, 35, 'api']);
    const by = Object.fromEntries((await ios.getInterfaces(api)).map(i => [i.shortName, i]));
    assert.deepEqual([by['Gi1/0/1'].mode, by['Gi1/0/1'].vlan, by['Gi1/0/1'].crcErrors], ['access', 10, 3]);
    const v = Object.fromEntries((await ios.getVlans(api)).map(x => [x.id, x]));
    assert.deepEqual(v[10].trunkPorts, ['Gi1/0/3', 'Po1']);
    const m = await ios.getMac(api, { vlan: '20' });
    assert.deepEqual(m.items.map(x => x.mac), ['00:00:5e:00:53:23', '00:00:5e:00:53:30']);
    assert.equal(m.perPortCount['Gi1/0/3'], 3);
});

test('RESTCONF: optional answers missing or forbidden only leave fields empty', async () => {
    stubHttp();
    httpFail['Cisco-IOS-XE-native:native/hostname'] = httpErr(403);
    httpFail['Cisco-IOS-XE-process-cpu-oper:cpu-usage/cpu-utilization'] = httpErr(404);
    httpFail['Cisco-IOS-XE-native:native/interface'] = httpErr(403);
    const s = await ios.getSummary(api);
    assert.deepEqual([s.hostname, s.cpu, s.memory], [null, null, 35]);
    const by = Object.fromEntries((await ios.getInterfaces(api)).map(i => [i.shortName, i]));
    assert.equal(by['Gi1/0/1'].mode, null);
    // the main answer is required
    httpFail['Cisco-IOS-XE-interfaces-oper:interfaces'] = httpErr(401);
    await assert.rejects(ios.getInterfaces(api), (e) => e.code === 'AUTH');
    // a wrong password fails on the first request alone
    stubHttp();
    httpFail['*'] = httpErr(401);
    await assert.rejects(ios.getSummary(api), (e) => e.code === 'AUTH');
    assert.equal(http.length, 1);
    await assert.rejects(ios.getSummary({ ...api, secrets: {} }), (e) => e.code === 'NOT_CONFIGURED');
});

test('auto: RESTCONF first, SSH when RESTCONF is off or unreachable; the working way is remembered', async () => {
    const seen = [];
    const ctx = { setTransport: (t) => seen.push(t) };

    stubHttp();
    let s = await ios.getSummary(auto, {}, ctx);
    assert.deepEqual([s.transport, calls.length, seen], ['api', 0, ['api']]);

    // RESTCONF not enabled (404) -> SSH, remembered because nothing was learned yet
    stubHttp(); seen.length = 0;
    httpFail['*'] = httpErr(404);
    s = await ios.getSummary(auto, {}, ctx);
    assert.deepEqual([s.transport, calls.length, seen], ['ssh', 1, ['ssh']]);

    // learned 'ssh': SSH first, no HTTPS at all
    stubHttp(); seen.length = 0; calls = [];
    s = await ios.getSummary({ ...auto, lastTransport: 'ssh' }, {}, ctx);
    assert.deepEqual([s.transport, http.length, seen], ['ssh', 0, []]);

    // learned 'api', one YANG model missing (404): SSH for this request, 'api' kept
    stubHttp(); seen.length = 0; calls = [];
    httpFail['Cisco-IOS-XE-matm-oper:matm-oper-data'] = httpErr(404);
    const m = await ios.getMac({ ...auto, lastTransport: 'api' }, {}, ctx);
    assert.deepEqual([m.total, calls.length, seen], [6, 1, []]);

    // learned 'api', HTTPS unreachable: SSH, and 'ssh' remembered
    stubHttp(); seen.length = 0; calls = [];
    httpFail['*'] = netErr('ECONNREFUSED');
    s = await ios.getSummary({ ...auto, lastTransport: 'api' }, {}, ctx);
    assert.deepEqual([s.transport, seen], ['ssh', ['ssh']]);
});

test('auto: wrong credentials, permissions and TLS never change over to SSH', async () => {
    for (const [err, code] of [[httpErr(401), 'AUTH'], [httpErr(403), 'FORBIDDEN'], [netErr('DEPTH_ZERO_SELF_SIGNED_CERT'), 'TLS']]) {
        stubHttp(); calls = [];
        httpFail['*'] = err;
        await assert.rejects(ios.getSummary(auto, {}, {}), (e) => e.code === code, code);
        assert.equal(calls.length, 0, `${code}: no SSH attempt`);
    }
    // both ways fail: one error naming both
    stubHttp();
    httpFail['*'] = netErr('ETIMEDOUT');
    sshCli.runCommands = async () => { throw netError('UNREACHABLE', 'SSH connection failed'); };
    await assert.rejects(ios.testConnection(auto), (e) => e.code === 'UNREACHABLE' && /RESTCONF: .*; SSH: SSH connection failed/.test(e.message));
});

test('test connection reports the way used; backup always reads over SSH', async () => {
    stubHttp();
    const t = await ios.testConnection(auto);
    assert.deepEqual([t.model, t.hostname, t.transport], ['C9300-48P', 'sw-lab-core', 'api']);
    assert.deepEqual(http.map(h => h.url.split('/data/')[1]), ['Cisco-IOS-XE-device-hardware-oper:device-hardware-data', 'Cisco-IOS-XE-native:native/hostname']);

    calls = [];
    const b = await ios.backupConfig(api);
    assert.ok(calls[0].cmds.includes('show running-config'));
    assert.equal(b.format, 'conf');
    sshCli.runCommands = async () => { throw netError('UNREACHABLE', 'SSH connection failed'); };
    await assert.rejects(ios.backupConfig(api), (e) => e.code === 'UNSUPPORTED' && /enable SSH/.test(e.message));
    await assert.rejects(ios.backupConfig(profile), (e) => e.code === 'UNREACHABLE', 'SSH-only keeps the real error');
});
