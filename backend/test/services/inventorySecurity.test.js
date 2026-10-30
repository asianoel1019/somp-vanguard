require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const inv = require('../../services/inventoryScheduler');
const { writeDataSync } = require('../../lib/db');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });

function makeDeps(log, { aliveIps = [], winPorts = [], linuxPorts = [] } = {}) {
    return {
        pingCheck: async (ip) => { log.ping.push(ip); return aliveIps.includes(ip); },
        tcpCheck: async (ip, port) => {
            log.tcp.push([ip, port]);
            return (port === 3389 && winPorts.includes(ip)) || (port === 22 && linuxPorts.includes(ip));
        },
        runPowerShell: async (script, timeout, opts) => { log.ps.push({ script, opts }); return JSON.stringify({ hostname: 'WIN1', osname: 'Windows', mem: 8, cpu: 4, timezone: 'UTC' }); },
        executeSSH: async (ip, user, pwd, cmd, opts) => { log.ssh.push({ ip, user, pwd, cmd, opts }); return { stdout: 'lx1|Linux|8|4|UTC', stderr: '', code: 0, success: true }; }
    };
}
const newLog = () => ({ ping: [], tcp: [], ps: [], ssh: [] });

test('scanSubnet refuses injection / malformed entries before touching anything', async () => {
    const bad = ["10.1.2'; Remove-Item C:\\ -Recurse #", '10.1.2.3', '10.1.2:1~300', '10.1.2;calc', '$(calc)', '10.1.2:9~3', 'a.b.c'];
    for (const entry of bad) {
        const log = newLog();
        await assert.rejects(inv.scanSubnet(entry, [1, 254], makeDeps(log)), /Invalid subnet entry/, entry);
        assert.deepEqual(log, newLog(), `no probe may run for ${entry}`);
    }
    assert.deepEqual(inv.scanStatus.activeSubnets, []);
});

test('scanSubnet accepts legacy range syntax (same data_<prefix> key)', async () => {
    const log = newLog();
    await inv.scanSubnet('10.79.9.1-2', [1, 254], makeDeps(log));
    assert.deepEqual(log.ping, ['10.79.9.1', '10.79.9.2']);
});

test('scanSubnet only passes strict IPv4 addresses to probes, SSH pins host keys, WinRM secrets go via env', async () => {
    process.env.AD_ADMIN_USER = 'svc';
    process.env.AD_ADMIN_PWD = "Pw'$(calc)";
    process.env.LINUX_ADMIN_USER = 'root';
    process.env.LINUX_ADMIN_PWD = 'lxpw';
    try {
        const log = newLog();
        const deps = makeDeps(log, { aliveIps: ['10.77.7.5', '10.77.7.6'], winPorts: ['10.77.7.5'], linuxPorts: ['10.77.7.6'] });
        await inv.scanSubnet('10.77.7:5~6', [1, 254], deps);

        const strict = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
        assert.deepEqual(log.ping, [], 'ICMP is skipped when a TCP port answered');
        assert.deepEqual([...new Set(log.tcp.map(([ip]) => ip))].sort(), ['10.77.7.5', '10.77.7.6']);
        for (const [ip] of log.tcp) assert.match(ip, strict);

        assert.equal(log.ps.length, 1);
        assert.ok(!log.ps[0].script.includes('calc'), 'password must not be embedded in the script');
        assert.equal(log.ps[0].opts.env.SOMP_CRED_PWD, "Pw'$(calc)");
        assert.ok(log.ps[0].script.includes('"10.77.7.5"'));

        assert.equal(log.ssh.length, 1);
        assert.equal(log.ssh[0].opts.pinHostKey, true);
        assert.match(log.ssh[0].ip, strict);
    } finally {
        for (const k of ['AD_ADMIN_USER', 'AD_ADMIN_PWD', 'LINUX_ADMIN_USER', 'LINUX_ADMIN_PWD']) delete process.env[k];
    }
});

test('scanSubnet records "host key changed" as the host error', async () => {
    process.env.LINUX_ADMIN_USER = 'root';
    process.env.LINUX_ADMIN_PWD = 'lxpw';
    try {
        const log = newLog();
        const deps = makeDeps(log, { aliveIps: ['10.78.8.1'], linuxPorts: ['10.78.8.1'] });
        deps.executeSSH = async () => { throw new Error('host key changed for 10.78.8.1 (expected a, got b); credentials were not sent.'); };
        await inv.scanSubnet('10.78.8:1~1', [1, 254], deps);
        const stored = inv.getAllSubnetData().find(h => h.ip === '10.78.8.1');
        assert.match(stored.error, /host key changed/);
    } finally {
        delete process.env.LINUX_ADMIN_USER; delete process.env.LINUX_ADMIN_PWD;
    }
});

test('compliance report e-mail HTML-escapes every remote value', async () => {
    writeDataSync('server_operation/oscheck/data_10.99.9.json', [
        { ip: '10.99.9.1', hostname: '<script>alert(1)</script>', timezone: '(UTC+05:00) <img src=x onerror=1>', os: '"><b>x</b>', status: 'online' }
    ]);
    // Windows style tz string gets parsed to an offset; use a numeric-looking one that still contains markup
    const sent = [];
    const config = { timezoneCheck: { targetOffset: 8 } };
    const res = await inv.sendComplianceReport(config, {
        sendMail: async (m) => { sent.push(m); },
        getAllSubnetData: () => [{ ip: '10.99.9.1', hostname: '<script>alert(1)</script>', timezone: '(UTC+05:00) <img src=x onerror=1>', os: '"><b>x</b>', status: 'online' }]
    });
    assert.equal(res.success, true);
    assert.equal(sent.length, 1);
    const html = sent[0].html;
    assert.ok(!html.includes('<script>'), 'raw script tag must not appear');
    assert.ok(!html.includes('<img src=x'), 'raw img tag must not appear');
    assert.ok(!html.includes('"><b>x'), 'attribute breakout must not appear');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});
