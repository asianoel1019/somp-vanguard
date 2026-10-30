require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const scoutDb = require('../../services/scoutDb');
const { db: docDb } = require('../../lib/db');
const cmdbModel = require('../../services/cmdbModel');
const { writeRbacConfig } = require('../../lib/rbac');
const { parseRange } = require('../../lib/agent/tools/common');
const findHost = require('../../lib/agent/tools/findHost');
const getHostMetrics = require('../../lib/agent/tools/getHostMetrics');
const listAlerts = require('../../lib/agent/tools/listAlerts');
const searchLogs = require('../../lib/agent/tools/searchLogs');

const NOW = new Date('2026-10-08T06:00:00.000Z');
const minutesAgo = (m) => new Date(NOW.getTime() - m * 60000).toISOString();
const admin = { username: 'boss', domain: 'corp', role: 'SuperAdmin', groups: [] };
const ctx = { user: admin, now: NOW };

test.before(async () => {
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: {} });
    await dbManager.initDB();
    cmdbModel.initCmdbTable();

    await scoutDb.run('INSERT INTO monitors (id, name, ip, os, status, lastSeen) VALUES (?,?,?,?,?,?)', ['m-web', 'web-03', '10.0.5.13', 'Windows', 'online', minutesAgo(1)]);
    await scoutDb.run('INSERT INTO monitors (id, name, ip, os, status, lastSeen) VALUES (?,?,?,?,?,?)', ['m-db', 'db-01', '10.0.6.21,10.0.6.22', 'Linux', 'online', minutesAgo(2)]);
    await scoutDb.run('INSERT INTO monitors (id, name, ip, os, status, lastSeen) VALUES (?,?,?,?,?,?)', ['m-web4', 'web-04', '10.0.5.14', 'Windows', 'offline', minutesAgo(600)]);

    // 12 samples over the last 6 hours for web-03; spike 30 minutes ago
    for (let i = 0; i < 12; i++) {
        const minutes = 330 - i * 30;
        const spike = minutes === 30;
        await scoutDb.run('INSERT INTO metrics (monitorId, timestamp, metrics) VALUES (?,?,?)', ['m-web', minutesAgo(minutes), JSON.stringify({
            cpu: { used: spike ? 97 : 20 + i },
            memory: { used: 60 },
            disk: [{ mount: 'C:', used: 71 }],
            network: { rxSpeedKbps: 100, txSpeedKbps: 50 },
            processes: spike
                ? [{ name: 'w3wp.exe', pid: 10, cpuUsage: 80.44, memoryMB: 900 }, { name: 'sqlservr.exe', pid: 11, cpuUsage: 9, memoryMB: 4000 }]
                : [{ name: 'svchost.exe', pid: 4, cpuUsage: 1, memoryMB: 50 }],
        })]);
    }
    // older than 7 days: must never be returned
    await scoutDb.run('INSERT INTO metrics (monitorId, timestamp, metrics) VALUES (?,?,?)', ['m-web', minutesAgo(60 * 24 * 9), JSON.stringify({ cpu: { used: 99 } })]);

    await scoutDb.run('INSERT INTO alerts (id, monitorId, checkId, ruleName, type, target, value, threshold, triggeredAt, resolved, resolvedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ['a1', 'm-web', 'c1', 'CPU High', 'cpu', 'cpu', '97', 90, minutesAgo(30), 0, null]);
    await scoutDb.run('INSERT INTO alerts (id, monitorId, checkId, ruleName, type, target, value, threshold, triggeredAt, resolved, resolvedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ['a2', 'm-db', 'c2', 'Disk Full', 'disk', '/var', '95', 90, minutesAgo(600), 1, minutesAgo(500)]);

    await scoutDb.run('INSERT INTO windows_events (id, host, level, eventID, provider, message, raw, timestamp) VALUES (?,?,?,?,?,?,?,?)',
        ['w1', 'web-03', 'Error', 1000, 'Application Error', 'Faulting application w3wp.exe; password=Hunter22secret', '', minutesAgo(31)]);
    await scoutDb.run('INSERT INTO windows_events (id, host, level, eventID, provider, message, raw, timestamp) VALUES (?,?,?,?,?,?,?,?)',
        ['w2', 'web-03', 'Information', 7036, 'Service Control Manager', 'Service entered running state', '', minutesAgo(200)]);
    await scoutDb.run('INSERT INTO linux_logs (id, host, filePath, format, message, tags, raw, timestamp) VALUES (?,?,?,?,?,?,?,?)',
        ['l1', 'db-01', '/var/log/messages', 'syslog', 'kernel: Out of memory: Killed process 4242 (postgres)', 'error,kernel', '', minutesAgo(45)]);

    // CMDB environment names are derived from the global Environments list (unknown -> Unassigned)
    require('../../lib/db').writeDataSync('system/environments.json', [{ id: '1', name: 'Others' }, { id: 'prod', name: 'PROD' }]);
    docDb.prepare('INSERT INTO cmdb_servers (ip, hostname, applicationName, businessUnit, envName, lifecycleStatus, isSecondary) VALUES (?,?,?,?,?,?,0)')
        .run('10.0.5.13', 'web-03', 'eShop Web', 'E-Commerce', 'PROD', 'Active');
    docDb.prepare('INSERT INTO cmdb_servers (ip, hostname, applicationName, businessUnit, envName, lifecycleStatus, isSecondary) VALUES (?,?,?,?,?,?,0)')
        .run('10.0.9.9', 'legacy-ftp', 'FTP', 'IT', 'PROD', 'Active');
});

test.after(async () => { await dbManager.closeDB(); });

// ── parseRange ──
test('parseRange applies defaults and clamps to maxDays', () => {
    const r = parseRange({}, NOW, { defaultHours: 6, maxDays: 7 });
    assert.equal(r.to, NOW.toISOString());
    assert.equal(r.from, minutesAgo(360));
    const c = parseRange({ from: '2026-09-01T00:00:00Z' }, NOW, { defaultHours: 6, maxDays: 7 });
    assert.equal(c.clamped, true);
    assert.equal(c.from, minutesAgo(7 * 24 * 60));
    assert.throws(() => parseRange({ from: 'not-a-date' }, NOW, { defaultHours: 6, maxDays: 7 }), /Invalid "from"/);
    assert.throws(() => parseRange({ from: NOW.toISOString(), to: minutesAgo(5) }, NOW, { defaultHours: 6, maxDays: 7 }), /earlier/);
});

// ── find_host ──
test('find_host: fuzzy match by name with CMDB info', async () => {
    const r = await findHost.run({ query: 'web-0' }, ctx);
    assert.equal(r.matches, 2);
    const web03 = r.hosts.find(h => h.name === 'web-03');
    assert.equal(web03.ip, '10.0.5.13');
    assert.equal(web03.cmdb.application, 'eShop Web');
    assert.equal(web03.cmdb.environment, 'PROD');
});

test('find_host: match by secondary IP', async () => {
    const r = await findHost.run({ query: '10.0.6.22' }, ctx);
    assert.equal(r.hosts[0].name, 'db-01');
});

test('find_host: falls back to CMDB-only records', async () => {
    const r = await findHost.run({ query: 'legacy-ftp' }, ctx);
    assert.equal(r.matches, 0);
    assert.equal(r.cmdbOnly[0].ip, '10.0.9.9');
});

test('find_host: no CMDB data without serverList permission', async () => {
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: { mon: { enabled: true, features: { monitorScout: true } } } });
    const viewer = { username: 'v', domain: 'corp', role: 'Viewer', groups: ['mon'] };
    const r = await findHost.run({ query: 'web-03' }, { user: viewer, now: NOW });
    assert.equal(r.hosts[0].cmdb, undefined);
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: {} });
});

// ── get_host_metrics ──
test('get_host_metrics: stats, trend and peak processes', async () => {
    const r = await getHostMetrics.run({ host: 'web-03' }, ctx);
    assert.equal(r.host.name, 'web-03');
    assert.equal(r.samples, 12);
    assert.equal(r.cpuPercent.max, 97);
    assert.equal(r.cpuPercent.min, 20);
    assert.equal(r.memoryPercent.avg, 60);
    assert.equal(r.diskPercent['C:'].latest, 71);
    assert.equal(r.networkKbps.rx.max, 100);
    assert.ok(r.trend.length <= 48 && r.trend.length > 0);
    assert.equal(r.peak.cpuPercent, 97);
    assert.equal(r.peak.timestamp, minutesAgo(30));
    assert.deepEqual(r.peak.topProcesses[0], { name: 'w3wp.exe', pid: 10, cpuPercent: 80.4, memoryMB: 900 });
});

test('get_host_metrics: never reads beyond 7 days and reports empty ranges', async () => {
    const r = await getHostMetrics.run({ host: 'web-03', from: '2026-09-01T00:00:00Z' }, ctx);
    assert.equal(r.range.clamped, true);
    assert.equal(r.cpuPercent.max, 97, 'the 9-day-old 99% sample is excluded');
    const empty = await getHostMetrics.run({ host: 'db-01' }, ctx);
    assert.equal(empty.samples, 0);
    assert.match(empty.note, /No metrics/);
});

test('get_host_metrics: ambiguous or unknown host is a ToolInputError', async () => {
    await assert.rejects(getHostMetrics.run({ host: 'web' }, ctx), /matches 2 hosts/);
    await assert.rejects(getHostMetrics.run({ host: 'nothing-here' }, ctx), /No monitored host/);
});

// ── list_alerts ──
test('list_alerts: active alerts by default with host names', async () => {
    const r = await listAlerts.run({}, ctx);
    assert.equal(r.count, 1);
    assert.equal(r.alerts[0].host, 'web-03');
    assert.equal(r.alerts[0].ruleName, 'CPU High');
    assert.equal(r.alerts[0].resolved, false);
});

test('list_alerts: resolved alerts within range, filtered by host', async () => {
    const r = await listAlerts.run({ status: 'resolved', host: 'db-01' }, ctx);
    assert.equal(r.count, 1);
    assert.equal(r.alerts[0].target, '/var');
    const none = await listAlerts.run({ status: 'all', host: 'web-04' }, ctx);
    assert.equal(none.count, 0);
});

// ── search_logs ──
test('search_logs: windows errors for a host', async () => {
    const r = await searchLogs.run({ host: 'web-03', level: 'error' }, ctx);
    assert.equal(r.count, 1);
    assert.equal(r.events[0].eventID, 1000);
    assert.equal(r.events[0].os, 'windows');
});

test('search_logs: keyword across linux logs via IP lookup', async () => {
    const r = await searchLogs.run({ host: '10.0.6.21', keyword: 'Out of memory' }, ctx);
    assert.equal(r.count, 1);
    assert.equal(r.events[0].host, 'db-01');
    assert.equal(r.events[0].os, 'linux');
});

test('search_logs: eventId limits the search to windows and respects limit', async () => {
    const r = await searchLogs.run({ eventId: 7036, limit: 1 }, ctx);
    assert.equal(r.count, 1);
    assert.equal(r.events[0].source, 'Service Control Manager');
});

test('get_host_metrics analyses the newest samples when the row cap is hit', async (t) => {
    getHostMetrics.maxRows = 3;
    t.after(() => { getHostMetrics.maxRows = 5000; });
    const r = await getHostMetrics.run({ host: 'web-03' }, ctx);
    assert.equal(r.samples, 3);
    assert.equal(r.limited, true);
    assert.match(r.note, /most recent 3 samples/);
    assert.equal(r.trend[r.trend.length - 1].t, minutesAgo(0), 'newest sample is included');
    assert.equal(r.peak.cpuPercent, 97, 'spike 30 minutes ago is within the newest 3 samples');
});

test('exact host match wins over fuzzy matches for alerts and logs', async () => {
    await scoutDb.run('INSERT INTO monitors (id, name, ip, os, status, lastSeen) VALUES (?,?,?,?,?,?)', ['m-web1', 'web-0', '10.0.5.1', 'Windows', 'online', minutesAgo(1)]);
    const alerts = await listAlerts.run({ host: '10.0.5.1', status: 'all' }, ctx);
    assert.equal(alerts.count, 0, '10.0.5.1 must not match web-03 (10.0.5.13)');
    const logs = await searchLogs.run({ host: '10.0.5.1' }, ctx);
    assert.equal(logs.count, 0);
    await scoutDb.run('DELETE FROM monitors WHERE id = ?', ['m-web1']);
});

test('tool definitions declare feature and schema', () => {
    for (const t of [findHost, getHostMetrics, listAlerts, searchLogs]) {
        // search_logs also accepts the log screens' own keys (any of them)
        if (t === searchLogs) assert.deepEqual(t.feature, ['monitorScout', 'monitorWinEvent', 'monitorLinuxLog']);
        else assert.equal(t.feature, 'monitorScout');
        assert.equal(t.parameters.type, 'object');
        assert.ok(t.description.length > 20);
    }
});
