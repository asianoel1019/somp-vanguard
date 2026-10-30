const express = require('express');
const router = express.Router();
const db = require('../services/scoutDb');
const crypto = require('crypto');
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');

// Only Live Event Viewer -> SIEM Analytics (SiemLocalDashboard.jsx) calls these endpoints
router.use(requireAuth, checkFeature('monitorWinEvent'));

// GET /api/monitor-siem/local-stats
router.get('/local-stats', requireAuth, checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
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

        // Stats for Windows
        const totalWindows = db.get(`SELECT count(*) as count FROM windows_events${whereClause}`, params)?.count || 0;
        const topWindowsHosts = db.all(`SELECT host, count(*) as count FROM windows_events${whereClause} GROUP BY host ORDER BY count DESC LIMIT 5`, params);
        const topWindowsEventIds = db.all(`SELECT eventID, count(*) as count FROM windows_events${whereClause} GROUP BY eventID ORDER BY count DESC LIMIT 8`, params);
        const recentCriticalWindows = db.all(`
            SELECT * FROM windows_events 
            ${whereClause ? whereClause + " AND (" + winEventFilter + ")" : " WHERE " + winEventFilter} 
            ORDER BY timestamp DESC LIMIT ${search ? 100 : 30}
        `, [...params, ...winSearchParams]);

        // Stats for Linux
        const totalLinux = db.get(`SELECT count(*) as count FROM linux_logs${whereClause}`, params)?.count || 0;
        const topLinuxHosts = db.all(`SELECT host, count(*) as count FROM linux_logs${whereClause} GROUP BY host ORDER BY count DESC LIMIT 5`, params);
        const recentCriticalLinux = db.all(`
            SELECT * FROM linux_logs 
            ${whereClause ? whereClause + " AND (" + linEventFilter + ")" : " WHERE " + linEventFilter} 
            ORDER BY timestamp DESC LIMIT ${search ? 100 : 30}
        `, [...params, ...linSearchParams]);

        // Trend Data (Time Bucketing)
        const bucketLen = (activeHours <= 1 && activeHours > 0) ? 16 : 13;
        const bucketSuffix = (activeHours <= 1 && activeHours > 0) ? ':00Z' : ':00:00Z';
        
        const winTrendRaw = db.all(`SELECT substr(timestamp, 1, ${bucketLen}) || '${bucketSuffix}' as timeBucket, count(*) as count FROM windows_events${whereClause} GROUP BY timeBucket ORDER BY timeBucket ASC`, params);
        const linTrendRaw = db.all(`SELECT substr(timestamp, 1, ${bucketLen}) || '${bucketSuffix}' as timeBucket, count(*) as count FROM linux_logs${whereClause} GROUP BY timeBucket ORDER BY timeBucket ASC`, params);
        
        const trendMap = {};
        winTrendRaw.forEach(row => { if (row.timeBucket) trendMap[row.timeBucket] = { time: row.timeBucket, windows: row.count, linux: 0 }; });
        linTrendRaw.forEach(row => {
            if (row.timeBucket) {
                if (!trendMap[row.timeBucket]) trendMap[row.timeBucket] = { time: row.timeBucket, windows: 0, linux: 0 };
                trendMap[row.timeBucket].linux = row.count;
            }
        });
        const trendData = Object.values(trendMap).sort((a, b) => a.time.localeCompare(b.time));

        res.json({
            success: true,
            timeRange: activeHours === 0 ? 'All Time' : `${activeHours}h`,
            stats: {
                trendData,
                windows: {
                    total: totalWindows,
                    topHosts: topWindowsHosts,
                    topEventIds: topWindowsEventIds,
                    recentCritical: recentCriticalWindows
                },
                linux: {
                    total: totalLinux,
                    topHosts: topLinuxHosts,
                    recentCritical: recentCriticalLinux
                }
            }
        });
    } catch (error) {
        console.error('[Monitor-SIEM] Get local stats error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/monitor-siem/generate-report
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
