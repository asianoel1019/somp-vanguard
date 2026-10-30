require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const dbManager = require('../../services/db');
const store = require('../../services/inventoryStore');
const inv = require('../../services/inventoryScheduler');
const webhookService = require('../../services/webhookService');
const logger = require('../../lib/logger');
const netProbe = require('../../lib/netProbe');
const validation = require('../../lib/inventoryValidation');
const { writeDataSync } = require('../../lib/db');
const { readStatus } = require('../../services/inventoryStatus');

const CONFIG_KEY = 'server_operation/oscheck/config.json';
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => { logger.flushAllNotifyBatches(); logger.notifyBatchTiming.quietMs = 20; logger.notifyBatchTiming.maxWaitMs = 100; });

/** deps with nothing alive unless told otherwise; tcp(ip, port) / icmp(ips) decide */
function makeDeps({ tcp = () => false, icmp = () => [], ps, ssh } = {}) {
    const calls = { tcp: [], icmp: [] };
    return {
        calls,
        tcpProbe: async (ip, port) => { calls.tcp.push([ip, port]); return !!(await tcp(ip, port)); },
        icmpBatch: async (ips) => { calls.icmp.push([...ips]); return icmp(ips); },
        runPowerShell: ps || (async () => JSON.stringify({ hostname: 'WIN1', osname: 'Windows Server', mem: 8, cpu: 4, timezone: 'UTC' })),
        executeSSH: ssh || (async () => ({ stdout: 'lx1|Ubuntu|8|4|UTC', stderr: '', code: 0, success: true }))
    };
}
const capture = (t) => {
    const sent = [];
    t.mock.method(webhookService, 'triggerWebhooks', (message, moduleName, category) => sent.push({ message, moduleName, category }));
    return sent;
};
const flush = async () => { logger.flushAllNotifyBatches(); await wait(10); };
const seedOnline = (prefix, n, extra = {}) => {
    for (let i = 1; i <= n; i++) store.upsertScanResult(`${prefix}.${i}`, { status: 'online', hostname: `h${i}`, os: 'linux', lastSeen: daysAgo(1), ...extra });
};

// --- settings ---------------------------------------------------------------------------------

test('probe settings: defaults, validation, PATCH merge and a single resolver', () => {
    assert.deepEqual(validation.resolveProbeSettings({}, '10.1.1'), { concurrencyPerSubnet: 16, subnetConcurrency: 4, missesBeforeOffline: 2, outageThresholdPct: 50, tcpPorts: [22, 3389, 5985, 5986] });
    assert.deepEqual(validation.resolveProbeSettings({ probe: { missesBeforeOffline: 3, tcpPorts: [443, 443, 22] } }, '10.1.1').tcpPorts, [443, 22]);
    assert.equal(validation.resolveProbeSettings({ probe: { missesBeforeOffline: 99, concurrencyPerSubnet: 'x' } }).missesBeforeOffline, 2, 'invalid stored values fall back');
    const bad = (probe) => validation.validateInventoryConfig({ probe });
    assert.equal(bad({ concurrencyPerSubnet: 0 }).valid, false);
    assert.equal(bad({ concurrencyPerSubnet: 65 }).valid, false);
    assert.equal(bad({ subnetConcurrency: 17 }).valid, false);
    assert.equal(bad({ missesBeforeOffline: 11 }).valid, false);
    assert.equal(bad({ outageThresholdPct: 9 }).valid, false);
    assert.equal(bad({ tcpPorts: [] }).valid, false);
    assert.equal(bad({ tcpPorts: [0] }).valid, false);
    assert.equal(bad({ tcpPorts: [70000] }).valid, false);
    assert.equal(bad({ tcpPorts: Array.from({ length: 11 }, (_, i) => i + 1) }).valid, false);
    assert.equal(bad('x').valid, false);
    assert.equal(bad({ concurrencyPerSubnet: 64, subnetConcurrency: 16, missesBeforeOffline: 10, outageThresholdPct: 100, tcpPorts: [1, 65535] }).valid, true);

    const check = validation.validateInventoryConfig({ probe: { missesBeforeOffline: 3 } });
    const merged = validation.mergeConfigPatch({ probe: { tcpPorts: [22], concurrencyPerSubnet: 8 }, lastScan: 'x' }, { probe: { missesBeforeOffline: 3 } }, check);
    assert.deepEqual(merged.probe, { tcpPorts: [22], concurrencyPerSubnet: 8, missesBeforeOffline: 3 });
    assert.equal(merged.lastScan, 'x');
});

// --- liveness -----------------------------------------------------------------------------------

test('a host that blocks ICMP but has 3389 open is alive (and ICMP is only asked for the silent addresses)', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.91.1:1~3'] });
    const deps = makeDeps({ tcp: (ip, port) => ip === '10.91.1.2' && port === 3389, icmp: () => [] });
    await inv.runScan({ deps });
    const host = store.getHost('10.91.1.2');
    assert.equal(host.status, 'online');
    assert.equal(host.os, 'win');
    assert.deepEqual(deps.calls.icmp, [['10.91.1.1', '10.91.1.3']], 'one batched ICMP call, without the host that answered TCP');
    assert.equal(store.getHost('10.91.1.1'), null, 'silent unknown addresses create no rows');
});

test('an ICMP-only host (no TCP port) is alive with an unknown OS and a readable reason', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.91.2:1~3'] });
    await inv.runScan({ deps: makeDeps({ icmp: () => ['10.91.2.3'] }) });
    const host = store.getHost('10.91.2.3');
    assert.equal(host.status, 'online');
    assert.equal(host.os, 'unknown');
    assert.match(host.error, /Unknown OS/);
});

test('single miss keeps the host online; the second consecutive miss sets offline with offlineSince = lastSeen; an answer resets', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.92.1:1~5'] });
    store.upsertScanResult('10.92.1.5', { status: 'online', hostname: 'srv', lastSeen: daysAgo(3) });
    const lastSeen = store.getHost('10.92.1.5').lastSeen;
    await inv.runScan({ deps: makeDeps() });
    let h = store.getHost('10.92.1.5');
    assert.equal(h.status, 'online');
    assert.equal(h.consecutiveMisses, 1);
    assert.equal(h.offlineSince, undefined);
    await inv.runScan({ deps: makeDeps() });
    h = store.getHost('10.92.1.5');
    assert.equal(h.status, 'offline');
    assert.equal(h.consecutiveMisses, 2);
    assert.equal(h.offlineSince, lastSeen, 'offline since the last sighting, not "now"');
    await inv.runScan({ deps: makeDeps() });
    assert.equal(store.getHost('10.92.1.5').offlineSince, lastSeen, 'stays put while offline');
    await inv.runScan({ deps: makeDeps({ tcp: (ip, port) => ip === '10.92.1.5' && port === 22 }) });
    h = store.getHost('10.92.1.5');
    assert.equal(h.status, 'online');
    assert.equal(h.consecutiveMisses, 0);
    assert.equal(h.offlineSince, undefined);
});

test('missesBeforeOffline is configurable (1 = classic single-miss behaviour)', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.92.2:1~2'], probe: { missesBeforeOffline: 1 } });
    store.upsertScanResult('10.92.2.1', { status: 'online', lastSeen: daysAgo(1) });
    await inv.runScan({ deps: makeDeps() });
    assert.equal(store.getHost('10.92.2.1').status, 'offline');
    writeDataSync(CONFIG_KEY, { subnets: ['10.92.3:1~2'], probe: { missesBeforeOffline: 3 } });
    store.upsertScanResult('10.92.3.1', { status: 'online', lastSeen: daysAgo(1) });
    await inv.runScan({ deps: makeDeps() });
    await inv.runScan({ deps: makeDeps() });
    assert.equal(store.getHost('10.92.3.1').status, 'online');
    await inv.runScan({ deps: makeDeps() });
    assert.equal(store.getHost('10.92.3.1').status, 'offline');
});

test('legacy backfill: markOfflineBatch / recordMissBatch stamp offlineSince from lastSeen, never "now" for old hosts', () => {
    store.upsertScanResult('10.92.4.1', { status: 'online', lastSeen: daysAgo(30) });
    store.upsertScanResult('10.92.4.2', { status: 'online', lastSeen: daysAgo(30) });
    const seen = store.getHost('10.92.4.1').lastSeen;
    store.markOfflineBatch(['10.92.4.1']);
    assert.equal(store.getHost('10.92.4.1').offlineSince, seen);
    const res = store.recordMissBatch(['10.92.4.2', '10.92.4.99'], { missesBeforeOffline: 1 });
    assert.deepEqual(res.wentOffline, ['10.92.4.2']);
    assert.equal(store.getHost('10.92.4.2').offlineSince, store.getHost('10.92.4.2').lastSeen);
    // a legacy offline row without offlineSince is repaired by the next miss
    store.upsertScanResult('10.92.4.3', { status: 'offline', lastSeen: daysAgo(20) });
    store.getHandle().prepare('UPDATE inventory_hosts SET offlineSince = NULL WHERE ip = ?').run('10.92.4.3');
    store.recordMissBatch(['10.92.4.3'], { missesBeforeOffline: 2 });
    assert.equal(store.getHost('10.92.4.3').offlineSince, store.getHost('10.92.4.3').lastSeen);
});

// --- outage breaker -----------------------------------------------------------------------------

test('isOutage: strictly more than the threshold, never below 4 hosts', () => {
    assert.equal(inv.isOutage(3, 3, 50), false, 'tiny subnet');
    assert.equal(inv.isOutage(3, 5, 50), false, 'below the minimum of 4');
    assert.equal(inv.isOutage(4, 8, 50), false, 'exactly 50% is not more than 50%');
    assert.equal(inv.isOutage(5, 8, 50), true);
    assert.equal(inv.isOutage(4, 4, 100), true);
    assert.equal(inv.isOutage(4, 5, 100), false);
    assert.equal(inv.isOutage(0, 0, 50), false);
});

test('outage breaker: a subnet where most previously-online hosts vanish is degraded, status untouched, ONE notice', async (t) => {
    const sent = capture(t);
    writeDataSync(CONFIG_KEY, { subnets: ['10.93.1:1~10', '10.93.2:1~10'], probe: { missesBeforeOffline: 1 } });
    seedOnline('10.93.1', 6);
    seedOnline('10.93.2', 6);
    // 10.93.1: all six vanish (outage); 10.93.2: five of six keep answering, one dies (normal)
    const deps = makeDeps({ tcp: (ip, port) => ip.startsWith('10.93.2.') && ip !== '10.93.2.6' && port === 22 });
    await inv.runScan({ deps });
    for (let i = 1; i <= 6; i++) {
        const h = store.getHost(`10.93.1.${i}`);
        assert.equal(h.status, 'online', `10.93.1.${i} keeps its status`);
        assert.ok(!h.consecutiveMisses, 'and its miss counter');
    }
    assert.equal(store.getHost('10.93.2.6').status, 'offline', 'the healthy subnet still records the real failure');
    const st = await readStatus();
    assert.equal(st.degraded, true);
    assert.deepEqual(st.degradedSubnets.map(d => d.subnet), ['10.93.1:1~10']);
    assert.equal(st.subnets.find(s => s.subnet === '10.93.1:1~10').state, 'degraded');
    assert.equal(st.subnets.find(s => s.subnet === '10.93.2:1~10').state, 'done');

    await flush();
    const degraded = sent.filter(s => /degraded/i.test(s.message));
    assert.equal(degraded.length, 1, 'one notice for the whole scan');
    assert.match(degraded[0].message, /10\.93\.1:1~10: 6 of 6/);
    assert.equal(degraded[0].category, 'Inventory');
});

test('a tiny subnet (fewer than 4 vanished hosts) never trips the breaker', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.93.3:1~10'], probe: { missesBeforeOffline: 1 } });
    seedOnline('10.93.3', 3);
    await inv.runScan({ deps: makeDeps() });
    for (let i = 1; i <= 3; i++) assert.equal(store.getHost(`10.93.3.${i}`).status, 'offline');
    assert.equal((await readStatus()).degraded, false);
});

test('status changes produce ONE batched notice per scan (offline + back online)', async (t) => {
    const sent = capture(t);
    writeDataSync(CONFIG_KEY, { subnets: ['10.94.1:1~12'], probe: { missesBeforeOffline: 1 }, monitoredIps: ['10.94.1.1'] });
    seedOnline('10.94.1', 3);
    store.upsertScanResult('10.94.1.9', { status: 'offline', lastSeen: daysAgo(2), offlineSince: daysAgo(2), hostname: 'back' });
    // .1 and .2 vanish (2 < 4: no breaker), .3 and .9 answer
    await inv.runScan({ deps: makeDeps({ tcp: (ip, port) => (ip === '10.94.1.3' || ip === '10.94.1.9') && port === 22 }) });
    await flush();
    const notices = sent.filter(s => /Status changes/.test(s.message));
    assert.equal(notices.length, 1);
    assert.match(notices[0].message, /2 offline, 1 back online/);
    assert.match(notices[0].message, /10\.94\.1\.1 \(h1\) \[monitored\]/);
    assert.match(notices[0].message, /10\.94\.1\.9/);
    assert.equal(sent.filter(s => /OFFLINE!/.test(s.message)).length, 0, 'no per-host alerts');
});

// --- concurrency --------------------------------------------------------------------------------

test('concurrency per subnet and across subnets is bounded by the configuration', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.95.1:1~20', '10.95.2:1~20', '10.95.3:1~20', '10.95.4:1~20', '10.95.5:1~20'], probe: { concurrencyPerSubnet: 3, subnetConcurrency: 2 } });
    const perIp = new Map();
    let activeIps = 0, maxIps = 0;
    const perSubnet = new Map();
    let maxSubnets = 0;
    const maxHostsPerSubnet = new Map();
    const deps = makeDeps({
        tcp: async (ip) => {
            const sub = ip.split('.').slice(0, 3).join('.');
            const n = (perIp.get(ip) || 0) + 1;
            perIp.set(ip, n);
            if (n === 1) {
                activeIps++; maxIps = Math.max(maxIps, activeIps);
                perSubnet.set(sub, (perSubnet.get(sub) || 0) + 1);
                const active = [...perSubnet.values()].filter(v => v > 0).length;
                maxSubnets = Math.max(maxSubnets, active);
                maxHostsPerSubnet.set(sub, Math.max(maxHostsPerSubnet.get(sub) || 0, perSubnet.get(sub)));
            }
            await wait(3);
            if (n === 4) { // last of the four port probes of this address
                activeIps--;
                perSubnet.set(sub, perSubnet.get(sub) - 1);
            }
            return false;
        }
    });
    await inv.runScan({ deps });
    assert.ok(Math.max(...maxHostsPerSubnet.values()) <= 3, `per-subnet cap: ${[...maxHostsPerSubnet.values()]}`);
    assert.ok(Math.max(...maxHostsPerSubnet.values()) >= 2, 'it really ran in parallel');
    assert.ok(maxSubnets <= 2, `subnet cap: ${maxSubnets}`);
    assert.ok(maxIps <= 6);
    assert.equal((await readStatus()).processedIps, 100);
});

test('runPool: bounded, stops starting work when asked to', async () => {
    let active = 0, max = 0, started = 0;
    await netProbe.runPool(Array.from({ length: 30 }, (_, i) => i), 4, async () => { started++; active++; max = Math.max(max, active); await wait(2); active--; });
    assert.equal(max, 4);
    assert.equal(started, 30);
    started = 0;
    await netProbe.runPool(Array.from({ length: 30 }, (_, i) => i), 1, async () => { started++; }, () => started >= 5);
    assert.equal(started, 5);
});

// --- ICMP / TCP primitives ----------------------------------------------------------------------

/** fake execFile: behaviour(ip) -> { code, stdout } | { error } */
function fakeExec(behaviour, log = []) {
    return (cmd, args, opts, cb) => {
        const ip = args[args.length - 1];
        log.push({ cmd, args, opts });
        const r = behaviour(ip);
        setImmediate(() => {
            if (r.error) return cb(r.error, '', '');
            if (r.code) { const e = new Error('exit ' + r.code); e.code = r.code; return cb(e, r.stdout || '', ''); }
            cb(null, r.stdout || '', '');
        });
    };
}
const REPLY = 'Reply from 10.1.1.1: bytes=32 time<1ms TTL=64';

test('ping: reply with TTL = alive; no reply = dead; exit 0 without TTL (destination unreachable) = dead; spawn error / timeout = unknown', async () => {
    const log = [];
    const exec = fakeExec((ip) => ({
        '10.1.1.1': { stdout: REPLY },
        '10.1.1.2': { code: 1, stdout: 'Request timed out.' },
        '10.1.1.3': { stdout: 'Reply from 10.1.1.3: Destination host unreachable.' },
        '10.1.1.4': { error: Object.assign(new Error('spawn ping ENOENT'), { code: 'ENOENT' }) },
        '10.1.1.5': { error: Object.assign(new Error('timeout'), { killed: true, signal: 'SIGKILL', code: null }) }
    }[ip]), log);
    const r = await netProbe.icmpCheckMany(['10.1.1.1', '10.1.1.2', '10.1.1.3', '10.1.1.4', '10.1.1.5', '10.1.1.6; calc'], { execFile: exec, platform: 'win32' });
    assert.deepEqual([...r.alive], ['10.1.1.1']);
    assert.deepEqual([...r.checked].sort(), ['10.1.1.1', '10.1.1.2', '10.1.1.3'], 'unknown (4, 5) and invalid addresses are not decided');
    assert.ok(log.every(c => /(^|[\\/])ping(\.exe)?$/i.test(c.cmd) && Array.isArray(c.args)), 'execFile with an args array, no shell');
    assert.deepEqual(log.find(c => c.args.includes('10.1.1.1')).args, ['-n', '1', '-w', '1000', '10.1.1.1']);
    assert.ok(!log.some(c => c.args.some(a => /calc/.test(a))));
    assert.equal(log.find(c => c.args.includes('10.1.1.1')).opts.timeout, 5000);
    assert.equal(log.filter(c => c.args.includes('10.1.1.2')).length, 2, 'two attempts before no answer');
    assert.equal(log.filter(c => c.args.includes('10.1.1.1')).length, 1, 'no second attempt after a reply');
    const lin = [];
    await netProbe.pingOnce('10.1.1.1', { execFile: fakeExec(() => ({ stdout: REPLY }), lin), platform: 'linux' });
    assert.deepEqual(lin[0].args, ['-c', '1', '-W', '1', '10.1.1.1']);
    assert.deepEqual(netProbe.chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

test('ping concurrency is bounded', async () => {
    let active = 0, max = 0;
    const exec = (cmd, args, opts, cb) => { active++; max = Math.max(max, active); setTimeout(() => { active--; cb(null, REPLY); }, 3); };
    const ips = Array.from({ length: 20 }, (_, i) => `10.1.2.${i + 1}`);
    const r = await netProbe.icmpCheckMany(ips, { concurrency: 3, execFile: exec });
    assert.equal(r.alive.size, 20);
    assert.ok(max <= 3 && max >= 2, String(max));
});

test('end to end with an injected execFile: replies are alive, ping failures are NOT misses, real silence is', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.96.1:1~6'], probe: { missesBeforeOffline: 1 } });
    seedOnline('10.96.1', 6);
    const exec = fakeExec((ip) => {
        if (['10.96.1.1', '10.96.1.5', '10.96.1.6'].includes(ip)) return { stdout: REPLY }; // keeps the subnet below the outage threshold
        if (ip === '10.96.1.2') return { error: Object.assign(new Error('spawn'), { code: 'EACCES' }) };
        if (ip === '10.96.1.3') return { stdout: 'Destination host unreachable' };
        return { code: 1, stdout: '' };
    });
    await inv.runScan({ deps: { tcpProbe: async () => false, execFile: exec, runPowerShell: async () => '{}', executeSSH: async () => { throw new Error('unused'); } } });
    assert.equal(store.getHost('10.96.1.1').status, 'online');
    const unknown = store.getHost('10.96.1.2');
    assert.equal(unknown.status, 'online', 'undecided ping keeps the status');
    assert.ok(!unknown.consecutiveMisses, 'and the miss counter');
    assert.equal(store.getHost('10.96.1.3').status, 'offline');
    assert.equal(store.getHost('10.96.1.4').status, 'offline');
    assert.equal(store.getHost('10.96.1.5').status, 'online');
});

test('icmp dep that decides nothing (everything unknown) records no miss for a previously-online ICMP-only host', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.96.2:1~3'], probe: { missesBeforeOffline: 1 } });
    seedOnline('10.96.2', 3);
    const deps = makeDeps({ icmp: () => ({ alive: [], checked: [] }) });
    await inv.runScan({ deps });
    for (let i = 1; i <= 3; i++) {
        const h = store.getHost(`10.96.2.${i}`);
        assert.equal(h.status, 'online');
        assert.ok(!h.consecutiveMisses);
    }
});

test('progress counts every address whose liveness was decided, during the TCP and ICMP phases', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.96.3:1~10'] });
    let seenDuringIcmp = null;
    const deps = makeDeps({ tcp: (ip, port) => ip === '10.96.3.1' && port === 22, icmp: () => { seenDuringIcmp = inv.scanStatus.processedIps; return []; } });
    await inv.runScan({ deps });
    assert.equal(seenDuringIcmp, 1, 'the TCP-alive host is already counted when ICMP starts');
    assert.equal((await readStatus()).processedIps, 10);
});

test('abort during specs collection: unprocessed alive hosts are not reconciled as missing and the subnet is not "done"', async () => {
    process.env.LINUX_ADMIN_USER = 'u'; process.env.LINUX_ADMIN_PWD = 'p';
    try {
        const cmdb = require('../../services/cmdbModel');
        const { db: libDb } = require('../../lib/db');
        for (let i = 1; i <= 3; i++) cmdb.upsertCmdbServer({ ip: `10.96.5.${i}`, hostname: `c${i}` }, 'MANUAL');
        writeDataSync(CONFIG_KEY, { subnets: ['10.96.5:1~3'], probe: { concurrencyPerSubnet: 1 }, autoSyncPrometheus: false });
        const deps = makeDeps({ tcp: (ip, port) => ip.startsWith('10.96.5.') && port === 22, ssh: async () => { inv.abortScan(); return { stdout: 'lx|Ubuntu|8|4|UTC', stderr: '', code: 0, success: true }; } });
        await inv.runScan({ deps });
        const life = (ip) => libDb.prepare('SELECT lifecycleStatus FROM cmdb_servers WHERE ip = ?').get(ip).lifecycleStatus;
        assert.equal(store.getHost('10.96.5.1').status, 'online');
        assert.equal(store.getHost('10.96.5.2'), null, 'not processed');
        assert.equal(life('10.96.5.2'), 'active', 'an alive host that was not reached is not marked missing');
        assert.equal(life('10.96.5.3'), 'active');
        const st = await readStatus();
        assert.equal(st.aborted, true);
        assert.equal(st.subnets[0].state, 'aborted');
    } finally { delete process.env.LINUX_ADMIN_USER; delete process.env.LINUX_ADMIN_PWD; }
});

test('an aborted outage subnet records no misses (breaker uses only the decided hosts)', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.96.4:1~100'], probe: { missesBeforeOffline: 1 } });
    seedOnline('10.96.4', 100);
    let pings = 0;
    const deps = makeDeps();
    delete deps.icmpBatch;
    deps.pingCheck = async () => { if (++pings === 30) inv.abortScan(); return false; };
    await inv.runScan({ deps });
    const hosts = store.listHostsBySubnet('10.96.4');
    assert.equal(hosts.filter(h => h.status === 'offline').length, 0, '30 of 30 decided hosts vanished: outage, nothing applied');
    assert.equal((await readStatus()).degraded, true);
});

test('checkTcpPort / probeTcpPorts: real loopback sockets, 1.5 s style timeout, never rejects', async () => {
    const net = require('node:net');
    const srv = net.createServer((s) => s.destroy());
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const open = srv.address().port;
    try {
        assert.equal(await netProbe.checkTcpPort('127.0.0.1', open, 500), true);
        assert.deepEqual(await netProbe.probeTcpPorts('127.0.0.1', [open, 1], netProbe.checkTcpPort, 300), [open]);
        assert.deepEqual(await netProbe.probeTcpPorts('127.0.0.1', [1], async () => { throw new Error('x'); }), []);
    } finally { srv.close(); }
});

// --- Scout lookup -------------------------------------------------------------------------------

test('Scout fallback: exact ip or exact element of a comma-separated list, no substring matches', () => {
    const mem = new DatabaseSync(':memory:');
    mem.exec('CREATE TABLE monitors (name TEXT, os TEXT, ip TEXT)');
    const ins = mem.prepare('INSERT INTO monitors VALUES (?, ?, ?)');
    ins.run('sub-a', 'Windows', '110.2.3.45');
    ins.run('sub-b', 'Windows', '10.2.3.4x');
    ins.run('list', 'Ubuntu', '192.168.0.1, 10.2.3.4 ,172.16.0.9');
    ins.run('exact', 'Rocky', '10.9.9.9');
    const db = { get: (sql, params) => mem.prepare(sql).get(...params) };
    assert.equal(inv.findScoutMonitor('10.2.3.4', db).name, 'list');
    assert.equal(inv.findScoutMonitor('10.9.9.9', db).name, 'exact');
    assert.equal(inv.findScoutMonitor('10.2.3.45', db), undefined, '110.2.3.45 / 10.2.3.4x are not 10.2.3.45');
    assert.equal(inv.findScoutMonitor('192.168.0.1', db).name, 'list');
    assert.equal(inv.findScoutMonitor('172.16.0.9', db).name, 'list');
    let captured;
    inv.findScoutMonitor('10.2.3.4', { get: (sql, params) => { captured = { sql, params }; } });
    assert.ok(!/LIKE/i.test(captured.sql), 'no LIKE');
    assert.ok(captured.params.every(p => !String(p).includes('%')));
    assert.throws(() => inv.findScoutMonitor("10.2.3.4' OR 1=1 --", db), /Invalid IPv4/);
});

test('Scout fallback identifies the OS of a host whose ports are closed (ICMP-only)', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.97.1:1~2'] });
    const deps = makeDeps({ icmp: () => ['10.97.1.1'], ps: async () => { throw new Error('winrm denied'); } });
    deps.scoutDb = { get: (sql, params) => (params[0] === '10.97.1.1' ? { name: 'SCOUTED', os: 'Windows 11' } : undefined) };
    await inv.runScan({ deps });
    const h = store.getHost('10.97.1.1');
    assert.equal(h.hostname, 'SCOUTED');
    assert.equal(h.osname, 'Windows 11');
    assert.equal(h.os, 'win');
    assert.match(h.error, /winrm denied/);
});

// --- specs timeouts and errors ----------------------------------------------------------------

test('WinRM and SSH timeouts are enforced, stored in specsError (<= 500 chars), shown on the host and cleared on success', async () => {
    process.env.LINUX_ADMIN_USER = 'root'; process.env.LINUX_ADMIN_PWD = 'pw';
    try {
        writeDataSync(CONFIG_KEY, { subnets: ['10.98.1:1~2'] });
        const tcp = (ip, port) => (ip === '10.98.1.1' && port === 3389) || (ip === '10.98.1.2' && port === 22);
        const hang = () => new Promise(() => {});
        const deps = { ...makeDeps({ tcp, ps: hang, ssh: hang }), winrmTimeoutMs: 40, sshTimeoutMs: 40 };
        const started = Date.now();
        await inv.runScan({ deps });
        assert.ok(Date.now() - started < 5000, 'the scan did not hang');
        assert.match(store.getHost('10.98.1.1').error, /WinRM timed out/);
        assert.match(store.getHost('10.98.1.2').error, /SSH timed out/);
        assert.equal(store.getHost('10.98.1.1').status, 'online', 'a specs failure never makes a live host offline');

        // long error text is truncated
        await inv.runScan({ deps: { ...makeDeps({ tcp, ps: async () => { throw { stderr: 'y'.repeat(900) }; }, ssh: async () => { throw new Error('z'.repeat(900)); } }) } });
        assert.equal(store.getHost('10.98.1.1').error.length, 500);
        assert.equal(store.getHost('10.98.1.2').error.length, 500);

        // success clears it
        await inv.runScan({ deps: makeDeps({ tcp }) });
        assert.ok(!store.getHost('10.98.1.1').error);
        assert.ok(!store.getHost('10.98.1.2').error);
        assert.equal(store.getHost('10.98.1.2').hostname, 'lx1');
        assert.equal(store.getAllSubnetData().find(h => h.ip === '10.98.1.1').error, null, 'compat shape carries error: null');
    } finally { delete process.env.LINUX_ADMIN_USER; delete process.env.LINUX_ADMIN_PWD; }
});

test('an aborted scan does not count unprobed addresses as misses', async () => {
    writeDataSync(CONFIG_KEY, { subnets: ['10.99.1:1~20'], probe: { missesBeforeOffline: 1 } });
    seedOnline('10.99.1', 20);
    let pings = 0;
    const deps = makeDeps();
    delete deps.icmpBatch;
    deps.pingCheck = async () => { if (++pings === 3) inv.abortScan(); return false; };
    await inv.runScan({ deps });
    const hosts = store.listHostsBySubnet('10.99.1');
    assert.equal(hosts.filter(h => h.status === 'offline').length, 3, 'only the three addresses that were really checked');
    assert.equal(hosts.filter(h => h.status === 'online').length, 17);
    assert.equal((await readStatus()).aborted, true);
});
