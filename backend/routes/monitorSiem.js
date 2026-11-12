const express = require('express');
const router = express.Router();
const db = require('../services/scoutDb');
const crypto = require('crypto');
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');

// Only Live Event Viewer -> SIEM Analytics (SiemLocalDashboard.jsx) calls these endpoints
router.use(requireAuth, checkFeature('monitorWinEvent'));

// ---------------------------------------------------------------------------
// Counts of the dashboard (totals, top hosts, top event IDs, trend). They used to be 7 GROUP BY queries, each
// reading every row of the range again, all synchronous: about 7 s on a day of 300 agents (held the whole process),
// many times that for 7 / 30 days. Now each table is read once, one time slice per query (the timestamp index picks
// the rows), counted here, with the event loop released between slices; the result is kept STATS_TTL_MS per range.
// ---------------------------------------------------------------------------
const STATS_TTL_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MAX_SLICES = 720;
const statsCache = new Map(); // activeHours -> { at, promise }

const tick = () => new Promise(r => setImmediate(r));

function topOf(counts, keyName, limit) {
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .slice(0, limit)
        .map(([key, count]) => ({ [keyName]: key, count }));
}

/**
 * One pass over `table` from sinceIso (null: everything): { total, hosts: Map, eventIds: Map | null, buckets: Map }.
 * Slices are [t, t + slice) up to now; the last one is open-ended, so together they are exactly timestamp >= since.
 */
async function countTable(table, { sinceIso, bucketLen, withEventIds, now }) {
    const cols = `host, ${withEventIds ? 'eventID' : 'NULL'} AS eventID, substr(timestamp, 1, ${bucketLen}) AS bucket`;
    const out = { total: 0, hosts: new Map(), eventIds: withEventIds ? new Map() : null, buckets: new Map() };
    const add = (rows) => {
        for (const r of rows) {
            out.total++;
            out.hosts.set(r.host, (out.hosts.get(r.host) || 0) + 1);
            if (out.eventIds) out.eventIds.set(r.eventID, (out.eventIds.get(r.eventID) || 0) + 1);
            if (r.bucket !== null && r.bucket !== undefined) out.buckets.set(r.bucket, (out.buckets.get(r.bucket) || 0) + 1);
        }
    };
    let from = sinceIso;
    if (from === null) {
        add(db.all(`SELECT ${cols} FROM ${table} WHERE timestamp IS NULL`)); // "all time" counted these too
        from = db.get(`SELECT min(timestamp) AS t FROM ${table}`)?.t;
        if (!from) return out;
    }
    const startMs = Date.parse(from);
    const span = Number.isFinite(startMs) ? Math.max(0, now - startMs) : 0;
    const slice = Math.max(HOUR_MS, Math.ceil(span / MAX_SLICES));
    let lo = from;
    let loMs = startMs;
    while (Number.isFinite(loMs) && loMs + slice < now) {
        const hi = new Date(loMs + slice).toISOString();
        add(db.all(`SELECT ${cols} FROM ${table} WHERE timestamp >= ? AND timestamp < ?`, [lo, hi]));
        lo = hi;
        loMs += slice;
        await tick();
    }
    add(db.all(`SELECT ${cols} FROM ${table} WHERE timestamp >= ?`, [lo]));
    return out;
}

async function computeStats(activeHours, now = Date.now()) {
    const sinceIso = activeHours > 0 ? new Date(now - activeHours * HOUR_MS).toISOString() : null;
    const minute = activeHours <= 1 && activeHours > 0;
    const bucketLen = minute ? 16 : 13;
    const suffix = minute ? ':00Z' : ':00:00Z';
    const win = await countTable('windows_events', { sinceIso, bucketLen, withEventIds: true, now });
    await tick();
    const lin = await countTable('linux_logs', { sinceIso, bucketLen, withEventIds: false, now });

    const trendMap = {};
    for (const [b, n] of win.buckets) trendMap[b + suffix] = { time: b + suffix, windows: n, linux: 0 };
    for (const [b, n] of lin.buckets) {
        const k = b + suffix;
        if (!trendMap[k]) trendMap[k] = { time: k, windows: 0, linux: 0 };
        trendMap[k].linux = n;
    }
    return {
        trendData: Object.values(trendMap).sort((a, b) => a.time.localeCompare(b.time)),
        windows: { total: win.total, topHosts: topOf(win.hosts, 'host', 5), topEventIds: topOf(win.eventIds, 'eventID', 8) },
        linux: { total: lin.total, topHosts: topOf(lin.hosts, 'host', 5) },
    };
}

/** The counts of a range, at most STATS_TTL_MS old; concurrent requests share one computation. */
function cachedStats(activeHours) {
    const hit = statsCache.get(activeHours);
    if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.promise;
    const promise = computeStats(activeHours);
    statsCache.set(activeHours, { at: Date.now(), promise });
    promise.catch(() => { if (statsCache.get(activeHours)?.promise === promise) statsCache.delete(activeHours); });
    return promise;
}

// GET /api/monitor-siem/local-stats
router.get('/local-stats', requireAuth, checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    try {
        const hours = parseInt(req.query.hours);
        const activeHours = isNaN(hours) ? 24 : hours;
        
        let whereClause = '';
        let params = [];
        if (activeHours > 0) {
            const timeFilter = new Date(Date.now() - activeHours * 60 * 60 * 1000).toISOString();
            whereClause = ' WHERE timestamp >= ?';
            params = [timeFilter];
        }

        const search = (req.query.search || '').trim();
        let winSearchClause = '';
        let winSearchParams = [];
        let linSearchClause = '';
        let linSearchParams = [];

        if (search) {
            winSearchClause = ' AND (host LIKE ? OR eventID = ? OR message LIKE ? OR raw LIKE ?)';
            const searchLike = `%${search}%`;
            const searchNum = parseInt(search, 10);
            winSearchParams = [searchLike, isNaN(searchNum) ? -1 : searchNum, searchLike, searchLike];

            linSearchClause = ' AND (host LIKE ? OR message LIKE ? OR tags LIKE ? OR filePath LIKE ?)';
            linSearchParams = [searchLike, searchLike, searchLike, searchLike];
        }

        // Critical Security Event IDs (Threat, Persistence, Privilege Escalation, Defense Evasion, System Crash)
        const securityEventIds = '1102,104,4625,4648,4672,4720,4722,4726,4728,4732,4738,4740,4756,4719,7045,7031,7034,41,6008';
        const critFilter = `level IN ('Error', 'Warning', 'AuditFailure', 'Critical') OR eventID IN (${securityEventIds})`;

        // When user explicitly searches, search across all events in that time range; otherwise show latest critical events
        const winEventFilter = search ? `1=1 ${winSearchClause}` : critFilter;
        const linEventFilter = search ? `1=1 ${linSearchClause}` : `(tags LIKE '%security%' OR tags LIKE '%auth%')`;

        // Latest critical events (or the search results) are read per request: they depend on the search text
        const recentCriticalWindows = db.all(`
            SELECT * FROM windows_events
            ${whereClause ? whereClause + " AND (" + winEventFilter + ")" : " WHERE " + winEventFilter}
            ORDER BY timestamp DESC LIMIT ${search ? 100 : 30}
        `, [...params, ...winSearchParams]);
        const recentCriticalLinux = db.all(`
            SELECT * FROM linux_logs
            ${whereClause ? whereClause + " AND (" + linEventFilter + ")" : " WHERE " + linEventFilter}
            ORDER BY timestamp DESC LIMIT ${search ? 100 : 30}
        `, [...params, ...linSearchParams]);

        const counts = await cachedStats(activeHours);

        res.json({
            success: true,
            timeRange: activeHours === 0 ? 'All Time' : `${activeHours}h`,
            stats: {
                trendData: counts.trendData,
                windows: { ...counts.windows, recentCritical: recentCriticalWindows },
                linux: { ...counts.linux, recentCritical: recentCriticalLinux }
            }
        });
    } catch (error) {
        console.error('[Monitor-SIEM] Get local stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/monitor-siem/generate-report
router._test = { computeStats, statsCache };

router.post('/generate-report', requireAuth, checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    try {
        const { startTime, endTime, reportType } = req.body;
        
        if (!startTime || !endTime) {
            return res.status(400).json({ error: 'startTime and endTime are required' });
        }

        const startMs = new Date(startTime).getTime();
        const endMs = new Date(endTime).getTime();
        if (isNaN(startMs) || isNaN(endMs)) {
            return res.status(400).json({ error: 'Invalid startTime or endTime format' });
        }
        if (endMs < startMs) {
            return res.status(400).json({ error: 'endTime must be greater than or equal to startTime' });
        }
        const maxRangeMs = 90 * 24 * 60 * 60 * 1000; // Max 90 days limit
        if (endMs - startMs > maxRangeMs) {
            return res.status(400).json({ error: 'Date range cannot exceed 90 days' });
        }

        const winEvents = db.all("SELECT * FROM windows_events WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 5000", [startTime, endTime]) || [];
        const linLogs = db.all("SELECT * FROM linux_logs WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC LIMIT 5000", [startTime, endTime]) || [];

        const reportContent = JSON.stringify({
            summary: {
                totalWindowsEvents: winEvents.length,
                totalLinuxLogs: linLogs.length
            },
            windowsEvents: winEvents,
            linuxLogs: linLogs
        });

        const id = crypto.randomUUID();
        const type = reportType || 'OnDemand';
        
        db.run("INSERT INTO siem_reports (id, reportType, startTime, endTime, content, timestamp) VALUES (?,?,?,?,?,?)",
            [id, type, startTime, endTime, reportContent, new Date().toISOString()]);
        
        res.json({
            success: true,
            message: 'Report generated successfully',
            reportId: id,
            summary: {
                totalWindowsEvents: winEvents.length,
                totalLinuxLogs: linLogs.length
            }
        });
    } catch (error) {
        console.error('[Monitor-SIEM] Generate report error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET /api/monitor-siem/reports
router.get('/reports', requireAuth, checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    try {
        const reports = db.all("SELECT id, reportType, startTime, endTime, timestamp FROM siem_reports ORDER BY timestamp DESC LIMIT 50");
        res.json({ success: true, reports });
    } catch (error) {
        console.error('[Monitor-SIEM] Get reports error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
