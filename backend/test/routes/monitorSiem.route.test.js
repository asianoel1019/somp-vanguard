// SIEM Analytics counts: one sliced pass per table gives exactly what the former GROUP BY queries gave, the event
// loop runs while they are counted, and a range is counted at most once a minute.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const db = require('../../services/scoutDb');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

const OP = `Bearer ${signToken({ username: 'op1', domain: 'corp', role: 'Operator', groups: ['g'] })}`;
const HOUR = 3600 * 1000;
let app;
let siem;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { monitorWinEvent: true } } },
    });
    siem = require('../../routes/monitorSiem');
    app = express();
    app.use(express.json());
    app.use('/api/monitor-siem', siem);
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => {
    db.run('DELETE FROM windows_events');
    db.run('DELETE FROM linux_logs');
    siem._test.statsCache.clear();
});

function seed(now) {
    let n = 0;
    const win = (host, eventID, ts) => db.run('INSERT INTO windows_events (id, host, level, eventID, provider, message, raw, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [`w${n++}`, host, 'Information', eventID, 'p', 'm', '{}', ts]);
    const lin = (host, ts) => db.run('INSERT INTO linux_logs (id, host, filePath, format, message, tags, raw, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [`l${n++}`, host, '/var/log/x', 'syslog', 'm', '', '{}', ts]);
    // 40 hours back, a few rows a minute-ish apart, hosts and event IDs with distinct counts
    for (let i = 0; i < 400; i++) {
        const ts = new Date(now - (i * 6 + 1) * 60 * 1000).toISOString();
        win(`host${i % 7}`, 4600 + (i % 11), ts);
        if (i % 3 === 0) lin(`lin${i % 4}`, ts);
    }
    win('future-host', 41, new Date(now + 5 * 60 * 1000).toISOString()); // a clock ahead of the server's
    win('null-ts', 1, null);
    lin('null-ts', null);
}

/** What the former 7 queries returned. */
function former(activeHours, now) {
    const where = activeHours > 0 ? ' WHERE timestamp >= ?' : '';
    const params = activeHours > 0 ? [new Date(now - activeHours * HOUR).toISOString()] : [];
    const len = (activeHours <= 1 && activeHours > 0) ? 16 : 13;
    const suf = (activeHours <= 1 && activeHours > 0) ? ':00Z' : ':00:00Z';
    const sortTop = (rows, key) => rows.sort((a, b) => b.count - a.count || String(a[key]).localeCompare(String(b[key])));
    const trend = {};
    for (const r of db.all(`SELECT substr(timestamp, 1, ${len}) || '${suf}' as timeBucket, count(*) as count FROM windows_events${where} GROUP BY timeBucket`, params)) {
        if (r.timeBucket) trend[r.timeBucket] = { time: r.timeBucket, windows: r.count, linux: 0 };
    }
    for (const r of db.all(`SELECT substr(timestamp, 1, ${len}) || '${suf}' as timeBucket, count(*) as count FROM linux_logs${where} GROUP BY timeBucket`, params)) {
        if (!r.timeBucket) continue;
        if (!trend[r.timeBucket]) trend[r.timeBucket] = { time: r.timeBucket, windows: 0, linux: 0 };
        trend[r.timeBucket].linux = r.count;
    }
    return {
        trendData: Object.values(trend).sort((a, b) => a.time.localeCompare(b.time)),
        windows: {
            total: db.get(`SELECT count(*) as count FROM windows_events${where}`, params).count,
            topHosts: sortTop(db.all(`SELECT host, count(*) as count FROM windows_events${where} GROUP BY host`, params), 'host').slice(0, 5),
            topEventIds: sortTop(db.all(`SELECT eventID, count(*) as count FROM windows_events${where} GROUP BY eventID`, params), 'eventID').slice(0, 8),
        },
        linux: {
            total: db.get(`SELECT count(*) as count FROM linux_logs${where}`, params).count,
            topHosts: sortTop(db.all(`SELECT host, count(*) as count FROM linux_logs${where} GROUP BY host`, params), 'host').slice(0, 5),
        },
    };
}

test('the sliced counts equal the former queries for 1 h, 24 h, 7 days and all time', async () => {
    const now = Date.now();
    seed(now);
    for (const hours of [1, 24, 168, 0]) {
        const got = await siem._test.computeStats(hours, now);
        assert.deepEqual(got, JSON.parse(JSON.stringify(former(hours, now))), `hours=${hours}`); // plain objects, as sent
    }
    const all = await siem._test.computeStats(0, now);
    assert.equal(all.windows.total, 402, 'future and null timestamps are counted in all time');
});

test('the event loop runs while the counts are made', async () => {
    const now = Date.now();
    seed(now);
    let ran = 0;
    const timer = setInterval(() => { ran++; }, 0);
    try {
        await siem._test.computeStats(168, now);
    } finally {
        clearInterval(timer);
    }
    assert.ok(ran >= 3, `timers ran ${ran} time(s) during the count`);
});

test('API: counts are reused for a minute (also while searching); the latest events are read per request', async () => {
    seed(Date.now());
    const first = await request(app).get('/api/monitor-siem/local-stats').query({ hours: 24 }).set('Authorization', OP).expect(200);
    db.run("INSERT INTO windows_events (id, host, level, eventID, provider, message, raw, timestamp) VALUES ('new1', 'host-new', 'Error', 4625, 'p', 'needle', '{}', ?)", [new Date().toISOString()]);
    const second = await request(app).get('/api/monitor-siem/local-stats').query({ hours: 24, search: 'needle' }).set('Authorization', OP).expect(200);
    assert.equal(second.body.stats.windows.total, first.body.stats.windows.total, 'counts from the cache');
    assert.deepEqual(second.body.stats.windows.recentCritical.map(e => e.id), ['new1'], 'search results are current');
    assert.equal(second.body.timeRange, '24h');
    siem._test.statsCache.clear();
    const third = await request(app).get('/api/monitor-siem/local-stats').query({ hours: 24 }).set('Authorization', OP).expect(200);
    assert.equal(third.body.stats.windows.total, first.body.stats.windows.total + 1);
});
