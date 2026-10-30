const express = require('express');
const router = express.Router();
const { openApiAuth } = require('../middleware/openApiAuth');
const scoutDb = require('../services/scoutDb');
const { queryCmdbServers, getCmdbServerByIp, decorateEnv } = require('../services/cmdbModel');
const { getDiffSlimServersData } = require('./serverList');

// Apply Open API Key authentication to all routes under /api/v1/open
router.use(openApiAuth());

// Helper: parse date with fallback to native Date
function parseTime(val) {
    if (!val) return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

// Helper: Resolve host parameter which could be an IP, ID, Hostname, or partial/variant name
function resolveHostFilter(hostOrIp) {
    if (!hostOrIp) return null;
    const clean = String(hostOrIp).trim();
    if (!clean) return null;

    const matchedNames = new Set([clean]);

    // 1. Exact or partial matches in monitors table (by ip, name, or id)
    const exactMatches = scoutDb.all(
        "SELECT id, name, ip FROM monitors WHERE ip = ? OR ip LIKE ? OR name = ? OR name LIKE ? OR id = ?",
        [clean, `%,${clean},%`, clean, `%${clean}%`, clean]
    );

    exactMatches.forEach(m => {
        if (m.name) matchedNames.add(m.name);
        if (m.ip) {
            m.ip.split(',').map(s => s.trim()).forEach(ip => ip && matchedNames.add(ip));
        }
        // Handle common prefix/suffix variants e.g. APP-SYS-PROXY01 <=> PROXY01
        const shortName = m.name.replace(/^[A-Za-z0-9]+-(?:SYS|SRV|APP|DB|WEB)-/i, '');
        if (shortName && shortName !== m.name) matchedNames.add(shortName);
    });

    // 2. If clean has prefix/suffix, generate stripped variants
    const stripped = clean.replace(/^[A-Za-z0-9]+-(?:SYS|SRV|APP|DB|WEB)-/i, '');
    if (stripped && stripped !== clean) {
        matchedNames.add(stripped);
        const prefixMatches = scoutDb.all("SELECT name, ip FROM monitors WHERE name LIKE ?", [`%${stripped}%`]);
        prefixMatches.forEach(m => {
            if (m.name) matchedNames.add(m.name);
            if (m.ip) m.ip.split(',').map(s => s.trim()).forEach(ip => ip && matchedNames.add(ip));
        });
    }

    // 3. If clean is an IP, also find monitors where ip column contains clean
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(clean);
    if (isIp) {
        const ipLikeMatches = scoutDb.all("SELECT name, ip FROM monitors WHERE ip LIKE ?", [`%${clean}%`]);
        ipLikeMatches.forEach(m => {
            if (m.name) matchedNames.add(m.name);
            const shortName = m.name.replace(/^[A-Za-z0-9]+-(?:SYS|SRV|APP|DB|WEB)-/i, '');
            if (shortName) matchedNames.add(shortName);
        });
    }

    return Array.from(matchedNames);
}

// Helper: Map Windows Event Log severity level string or numeric value to SQL clause
function getWindowsLevelClause(levelStr) {
    if (!levelStr) return null;
    const l = String(levelStr).trim().toLowerCase();
    switch (l) {
        case 'critical':
        case '1':
            return { sql: "(level = '1' OR LOWER(level) = 'critical')", params: [] };
        case 'error':
        case '2':
            return { sql: "(level IN ('1', '2') OR LOWER(level) IN ('error', 'critical'))", params: [] };
        case 'warning':
        case 'warn':
        case '3':
            return { sql: "(level = '3' OR LOWER(level) IN ('warning', 'warn'))", params: [] };
        case 'information':
        case 'info':
        case '4':
        case '0':
            return { sql: "(level IN ('0', '4') OR LOWER(level) IN ('information', 'info', 'auditsuccess', 'auditfailure', 'verbose'))", params: [] };
        default:
            return { sql: "(LOWER(level) = LOWER(?) OR level = ?)", params: [levelStr, levelStr] };
    }
}

// Middleware: Validate query parameters to reject unsupported parameter names
function validateQueryParams(allowedList) {
    return (req, res, next) => {
        const allowedSet = new Set([...allowedList, 'apiKey']);
        const unknownParams = Object.keys(req.query).filter(k => !allowedSet.has(k));
        if (unknownParams.length > 0) {
            return res.status(400).json({
                error: `不支援的查詢參數: ${unknownParams.join(', ')} (Unsupported query parameter(s))`,
                code: 'UNSUPPORTED_PARAMETER',
                unsupportedParameters: unknownParams,
                supportedParameters: allowedList
            });
        }
        next();
    };
}

/**
 * GET /api/v1/open/status
 * Check API availability & metadata
 */
router.get('/status', validateQueryParams([]), (req, res) => {
    try {
        const monitorCount = scoutDb.get("SELECT COUNT(*) as count FROM monitors")?.count || 0;
        const activeAlerts = scoutDb.get("SELECT COUNT(*) as count FROM alerts WHERE resolved = 0")?.count || 0;
        const cmdbStats = queryCmdbServers({ limit: 1 });

        res.json({
            status: 'online',
            service: 'SOMP Scout Open API',
            version: require('../lib/version').getVersion(),
            authenticatedKey: req.apiKeyInfo.name,
            totalMonitoredHosts: monitorCount,
            totalServersInCmdb: cmdbStats.total,
            activeAlerts: activeAlerts,
            endpoints: [
                '/api/v1/open/status',
                '/api/v1/open/server-list',
                '/api/v1/open/servers',
                '/api/v1/open/servers/:ip',
                '/api/v1/open/hosts',
                '/api/v1/open/metrics/realtime',
                '/api/v1/open/metrics/history',
                '/api/v1/open/logs/windows',
                '/api/v1/open/logs/linux',
                '/api/v1/open/logs/events',
                '/api/v1/open/prometheus'
            ],
            serverTime: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/open/server-list
 * Fetch slimmed down diff-comparison server list (with VIP, iLO, CVM preserved) using Open API Key authentication
 */
router.get('/server-list', validateQueryParams(['page', 'limit', 'search', 'env', 'envId', 'envName', 'status', 'application', 'applicationName', 'bu', 'businessUnit', 'zone', 'platform', 'datacenterName', 'rackId']), (req, res) => {
    try {
        const data = getDiffSlimServersData(req.query);
        res.json(data);
    } catch (err) {
        console.error('[Open API] ServerList Query Error:', err);
        res.status(500).json({ error: 'Failed to fetch server list via Open API', message: err.message });
    }
});

/**
 * GET /api/v1/open/servers
 * Query full Server List / CMDB inventory with multi-dimensional filtering & pagination
 */
router.get('/servers', validateQueryParams(['ip', 'keyword', 'env', 'envId', 'envName', 'datacenter', 'bu', 'application', 'os', 'status', 'lifecycle', 'isVip', 'page', 'limit', 'sortBy', 'sortOrder']), (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 1000);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

        const filter = {
            ...req.query,
            page,
            limit
        };

        const result = queryCmdbServers(filter);
        const totalPages = Math.ceil(result.total / limit);

        res.json({
            code: 200,
            status: 'success',
            total: result.total,
            page,
            limit,
            totalPages,
            data: result.servers
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/open/servers/:ip
 * Get detailed server specifications by IP address
 */
router.get('/servers/:ip', validateQueryParams([]), (req, res) => {
    try {
        const ip = String(req.params.ip).trim();
        const server = getCmdbServerByIp(ip);
        if (!server) {
            return res.status(404).json({ error: `Server not found for IP: ${ip}`, code: 404 });
        }
        res.json({
            code: 200,
            status: 'success',
            data: decorateEnv(server) // envName derived from envId (Unassigned when unknown)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/open/hosts
 * List all monitored hosts with their latest telemetry status
 */
router.get('/hosts', validateQueryParams(['ip', 'keyword', 'status', 'os', 'envId', 'group']), (req, res) => {
    try {
        const { status, os, envId, group, ip, keyword } = req.query;
        let query = "SELECT id, name, ip, os, group_name, tags, status, lastSeen, createdAt, envId, version FROM monitors WHERE 1=1";
        const params = [];

        if (ip) {
            query += " AND (ip = ? OR ip LIKE ?)";
            params.push(ip, `%${ip}%`);
        }
        if (keyword) {
            query += " AND (ip LIKE ? OR name LIKE ? OR tags LIKE ?)";
            params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
        }
        if (status) {
            query += " AND status = ?";
            params.push(status);
        }
        if (os) {
            query += " AND LOWER(os) LIKE ?";
            params.push(`%${os.toLowerCase()}%`);
        }
        if (envId) {
            // Same semantics as /servers: an id, name or code (case-insensitive) resolves to the environment id
            const env = require('../lib/environmentRegistry').resolveEnv(envId);
            query += " AND envId = ?";
            params.push(env ? env.id : envId);
        }
        if (group) {
            query += " AND group_name = ?";
            params.push(group);
        }

        query += " ORDER BY name ASC";
        const monitors = scoutDb.all(query, params);

        // Attach latest metric snapshot
        const enriched = monitors.map(m => {
            const latestMetricRow = scoutDb.get("SELECT metrics, timestamp FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1", [m.id]);
            let lastMetric = null;
            if (latestMetricRow && latestMetricRow.metrics) {
                try {
                    lastMetric = JSON.parse(latestMetricRow.metrics);
                } catch (e) {}
            }
            return {
                id: m.id,
                name: m.name,
                ip: m.ip,
                os: m.os,
                group: m.group_name,
                tags: m.tags ? m.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
                status: m.status,
                lastSeen: m.lastSeen,
                version: m.version,
                lastMetricSnapshot: lastMetric ? {
                    timestamp: latestMetricRow.timestamp,
                    cpuUsed: lastMetric.cpu?.used ?? null,
                    memoryUsed: lastMetric.memory?.used ?? null,
                    diskUsage: lastMetric.disk || []
                } : null
            };
        });

        res.json({
            total: enriched.length,
            hosts: enriched
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/open/metrics/realtime
 * Fetch the latest real-time metrics for a specific host or all hosts
 * Query params: host (name or IP or ID)
 */
router.get('/metrics/realtime', validateQueryParams(['host', 'ip', 'id']), (req, res) => {
    try {
        const { host, ip, id } = req.query;
        let monitor = null;

        if (id) {
            monitor = scoutDb.get("SELECT * FROM monitors WHERE id = ?", [id]);
        } else if (ip) {
            monitor = scoutDb.get("SELECT * FROM monitors WHERE ip = ?", [ip]);
        } else if (host) {
            monitor = scoutDb.get("SELECT * FROM monitors WHERE name = ? OR ip = ? OR id = ?", [host, host, host]);
        }

        if (host || ip || id) {
            if (!monitor) {
                return res.status(404).json({ error: 'Host not found' });
            }

            const latestRow = scoutDb.get("SELECT metrics, timestamp FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1", [monitor.id]);
            let metricsData = null;
            if (latestRow && latestRow.metrics) {
                try {
                    metricsData = JSON.parse(latestRow.metrics);
                } catch (e) {}
            }

            return res.json({
                host: {
                    id: monitor.id,
                    name: monitor.name,
                    ip: monitor.ip,
                    os: monitor.os,
                    status: monitor.status,
                    lastSeen: monitor.lastSeen
                },
                timestamp: latestRow ? latestRow.timestamp : null,
                metrics: metricsData
            });
        }

        // Return latest metrics summary for all monitors
        const allMonitors = scoutDb.all("SELECT id, name, ip, os, status, lastSeen FROM monitors ORDER BY name ASC");
        const results = allMonitors.map(m => {
            const latestRow = scoutDb.get("SELECT metrics, timestamp FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1", [m.id]);
            let parsed = null;
            if (latestRow && latestRow.metrics) {
                try { parsed = JSON.parse(latestRow.metrics); } catch (e) {}
            }
            return {
                id: m.id,
                name: m.name,
                ip: m.ip,
                os: m.os,
                status: m.status,
                lastSeen: m.lastSeen,
                timestamp: latestRow ? latestRow.timestamp : null,
                metrics: parsed
            };
        });

        res.json({ total: results.length, data: results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/open/metrics/history
 * Fetch historical time-series metrics for a given host
 * Query params: host (required), from (ISO Date), to (ISO Date), limit (default 100, max 1000)
 */
router.get('/metrics/history', validateQueryParams(['host', 'ip', 'id', 'from', 'to', 'limit']), (req, res) => {
    try {
        const { host, ip, id, from, to } = req.query;
        let limit = parseInt(req.query.limit) || 100;
        if (limit > 1000) limit = 1000;
        if (limit < 1) limit = 1;

        let monitor = null;
        if (id) {
            monitor = scoutDb.get("SELECT * FROM monitors WHERE id = ?", [id]);
        } else if (ip) {
            monitor = scoutDb.get("SELECT * FROM monitors WHERE ip = ?", [ip]);
        } else if (host) {
            monitor = scoutDb.get("SELECT * FROM monitors WHERE name = ? OR ip = ? OR id = ?", [host, host, host]);
        }

        if (!monitor) {
            return res.status(400).json({ error: 'Target host is required (specify host, ip, or id parameter)' });
        }

        let query = "SELECT timestamp, metrics FROM metrics WHERE monitorId = ?";
        const params = [monitor.id];

        const fromIso = parseTime(from);
        const toIso = parseTime(to);

        if (fromIso) {
            query += " AND timestamp >= ?";
            params.push(fromIso);
        }
        if (toIso) {
            query += " AND timestamp <= ?";
            params.push(toIso);
        }

        query += " ORDER BY timestamp DESC LIMIT ?";
        params.push(limit);

        const rows = scoutDb.all(query, params);
        const data = rows.map(r => {
            let parsed = null;
            try { parsed = JSON.parse(r.metrics); } catch (e) {}
            return {
                timestamp: r.timestamp,
                cpu: parsed?.cpu || null,
                memory: parsed?.memory || null,
                disk: parsed?.disk || [],
                network: parsed?.network || [],
                tcpPing: parsed?.tcpPing || [],
                services: parsed?.services || [],
                processes: parsed?.processes || []
            };
        });

        res.json({
            host: {
                id: monitor.id,
                name: monitor.name,
                ip: monitor.ip,
                os: monitor.os
            },
            from: fromIso,
            to: toIso,
            count: data.length,
            records: data
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/open/logs/windows
 * Query Windows Event Logs collected by Scout agents
 * Query params: host, ip, level, eventID, provider, keyword, from, to, page, limit
 */
router.get('/logs/windows', validateQueryParams(['host', 'ip', 'level', 'eventID', 'provider', 'keyword', 'from', 'to', 'page', 'limit']), (req, res) => {
    try {
        const { host, ip, level, eventID, provider, keyword, from, to } = req.query;
        const targetHost = host || ip;
        let limit = parseInt(req.query.limit) || 100;
        if (limit > 1000) limit = 1000;
        if (limit < 1) limit = 1;
        let page = parseInt(req.query.page) || 1;
        if (page < 1) page = 1;
        const offset = (page - 1) * limit;

        let query = "SELECT id, host, level, eventID, provider, message, timestamp FROM windows_events WHERE 1=1";
        let countQuery = "SELECT COUNT(*) as total FROM windows_events WHERE 1=1";
        const params = [];
        const countParams = [];

        if (targetHost) {
            const names = resolveHostFilter(targetHost);
            if (names && names.length > 0) {
                const placeholders = names.map(() => 'LOWER(host) = LOWER(?) OR LOWER(host) LIKE LOWER(?)').join(' OR ');
                query += ` AND (${placeholders})`;
                countQuery += ` AND (${placeholders})`;
                names.forEach(n => {
                    params.push(n, `%${n}%`);
                    countParams.push(n, `%${n}%`);
                });
            }
        }
        if (level) {
            const levelClause = getWindowsLevelClause(level);
            if (levelClause) {
                query += ` AND ${levelClause.sql}`;
                countQuery += ` AND ${levelClause.sql}`;
                if (levelClause.params.length > 0) {
                    params.push(...levelClause.params);
                    countParams.push(...levelClause.params);
                }
            }
        }
        if (eventID) {
            query += " AND eventID = ?";
            countQuery += " AND eventID = ?";
            params.push(parseInt(eventID, 10));
            countParams.push(parseInt(eventID, 10));
        }
        if (provider) {
            query += " AND LOWER(provider) LIKE LOWER(?)";
            countQuery += " AND LOWER(provider) LIKE LOWER(?)";
            params.push(`%${provider}%`);
            countParams.push(`%${provider}%`);
        }
        if (keyword) {
            query += " AND message LIKE ?";
            countQuery += " AND message LIKE ?";
            params.push(`%${keyword}%`);
            countParams.push(`%${keyword}%`);
        }

        const fromIso = parseTime(from);
        const toIso = parseTime(to);
        if (fromIso) {
            query += " AND timestamp >= ?";
            countQuery += " AND timestamp >= ?";
            params.push(fromIso);
            countParams.push(fromIso);
        }
        if (toIso) {
            query += " AND timestamp <= ?";
            countQuery += " AND timestamp <= ?";
            params.push(toIso);
            countParams.push(toIso);
        }

        const total = scoutDb.get(countQuery, countParams)?.total || 0;

        query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);

        const events = scoutDb.all(query, params);

        res.json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            events
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/open/logs/linux
 * Query Linux syslog & file logs collected by Scout agents
 * Query params: host, ip, filePath, level, keyword, from, to, page, limit
 */
router.get('/logs/linux', validateQueryParams(['host', 'ip', 'filePath', 'level', 'keyword', 'from', 'to', 'page', 'limit']), (req, res) => {
    try {
        const { host, ip, filePath, level, keyword, from, to } = req.query;
        const targetHost = host || ip;
        let limit = parseInt(req.query.limit) || 100;
        if (limit > 1000) limit = 1000;
        if (limit < 1) limit = 1;
        let page = parseInt(req.query.page) || 1;
        if (page < 1) page = 1;
        const offset = (page - 1) * limit;

        let query = "SELECT id, host, filePath, format, message, tags, timestamp FROM linux_logs WHERE 1=1";
        let countQuery = "SELECT COUNT(*) as total FROM linux_logs WHERE 1=1";
        const params = [];
        const countParams = [];

        if (targetHost) {
            const names = resolveHostFilter(targetHost);
            if (names && names.length > 0) {
                const placeholders = names.map(() => 'LOWER(host) = LOWER(?) OR LOWER(host) LIKE LOWER(?) OR LOWER(message) LIKE LOWER(?)').join(' OR ');
                query += ` AND (${placeholders})`;
                countQuery += ` AND (${placeholders})`;
                names.forEach(n => {
                    params.push(n, `%${n}%`, `%${n}%`);
                    countParams.push(n, `%${n}%`, `%${n}%`);
                });
            }
        }
        if (filePath) {
            query += " AND filePath LIKE ?";
            countQuery += " AND filePath LIKE ?";
            params.push(`%${filePath}%`);
            countParams.push(`%${filePath}%`);
        }
        if (level) {
            const l = String(level).trim().toLowerCase();
            let linuxLevelSql = '';
            let linuxLevelParams = [];
            if (l === 'error' || l === 'err' || l === 'critical' || l === 'crit') {
                linuxLevelSql = "(tags LIKE '%error%' OR tags LIKE '%err%' OR tags LIKE '%crit%' OR message LIKE '%error%' OR message LIKE '%failed%' OR message LIKE '%fatal%')";
            } else if (l === 'warning' || l === 'warn') {
                linuxLevelSql = "(tags LIKE '%warning%' OR tags LIKE '%warn%' OR message LIKE '%warning%' OR message LIKE '%warn%')";
            } else if (l === 'info' || l === 'information') {
                linuxLevelSql = "(tags LIKE '%info%' OR message LIKE '%info%')";
            } else {
                linuxLevelSql = "(tags LIKE ? OR message LIKE ?)";
                linuxLevelParams = [`%${level}%`, `%${level}%`];
            }
            query += ` AND ${linuxLevelSql}`;
            countQuery += ` AND ${linuxLevelSql}`;
            params.push(...linuxLevelParams);
            countParams.push(...linuxLevelParams);
        }
        if (keyword) {
            query += " AND message LIKE ?";
            countQuery += " AND message LIKE ?";
            params.push(`%${keyword}%`);
            countParams.push(`%${keyword}%`);
        }

        const fromIso = parseTime(from);
        const toIso = parseTime(to);
        if (fromIso) {
            query += " AND timestamp >= ?";
            countQuery += " AND timestamp >= ?";
            params.push(fromIso);
            countParams.push(fromIso);
        }
        if (toIso) {
            query += " AND timestamp <= ?";
            countQuery += " AND timestamp <= ?";
            params.push(toIso);
            countParams.push(toIso);
        }

        const total = scoutDb.get(countQuery, countParams)?.total || 0;

        query += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
        params.push(limit, offset);

        const rawLogs = scoutDb.all(query, params);
        const enrichedLogs = rawLogs.map(row => {
            let derivedLevel = 'Information';
            const tagStr = (row.tags || '').toLowerCase();
            const msgStr = (row.message || '').toLowerCase();
            if (tagStr.includes('crit') || tagStr.includes('emerg') || tagStr.includes('alert') || msgStr.includes('fatal') || msgStr.includes('panic')) {
                derivedLevel = 'Critical';
            } else if (tagStr.includes('error') || tagStr.includes('err') || msgStr.includes('error') || msgStr.includes('failed') || msgStr.includes('rejected')) {
                derivedLevel = 'Error';
            } else if (tagStr.includes('warn') || msgStr.includes('warning') || msgStr.includes('warn')) {
                derivedLevel = 'Warning';
            }
            return {
                id: row.id,
                host: row.host,
                filePath: row.filePath,
                format: row.format,
                level: derivedLevel,
                message: row.message,
                tags: row.tags,
                timestamp: row.timestamp
            };
        });

        res.json({
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            logs: enrichedLogs
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/open/logs/events
 * Unified Event Logs search (Windows Event Log + Linux File Logs)
 * Query params: host, ip, os, level, keyword, from, to, limit
 */
router.get('/logs/events', validateQueryParams(['host', 'ip', 'os', 'level', 'keyword', 'from', 'to', 'limit']), (req, res) => {
    try {
        const { host, ip, os, level, keyword, from, to } = req.query;
        const targetHost = host || ip;
        let limit = parseInt(req.query.limit) || 100;
        if (limit > 500) limit = 500;
        if (limit < 1) limit = 1;

        let results = [];

        if (!os || os.toLowerCase().includes('win')) {
            let winQuery = "SELECT id, host, 'windows' as os, level, eventID, provider as source, message, timestamp FROM windows_events WHERE 1=1";
            const winParams = [];
            if (targetHost) {
                const names = resolveHostFilter(targetHost);
                if (names && names.length > 0) {
                    const placeholders = names.map(() => 'LOWER(host) = LOWER(?) OR LOWER(host) LIKE LOWER(?)').join(' OR ');
                    winQuery += ` AND (${placeholders})`;
                    names.forEach(n => winParams.push(n, `%${n}%`));
                }
            }
            if (level) {
                const levelClause = getWindowsLevelClause(level);
                if (levelClause) {
                    winQuery += ` AND ${levelClause.sql}`;
                    if (levelClause.params.length > 0) winParams.push(...levelClause.params);
                }
            }
            if (keyword) { winQuery += " AND message LIKE ?"; winParams.push(`%${keyword}%`); }
            if (from) { const f = parseTime(from); if (f) { winQuery += " AND timestamp >= ?"; winParams.push(f); } }
            if (to) { const t = parseTime(to); if (t) { winQuery += " AND timestamp <= ?"; winParams.push(t); } }
            winQuery += " ORDER BY timestamp DESC LIMIT ?";
            winParams.push(limit);
            const winEvents = scoutDb.all(winQuery, winParams);
            results.push(...winEvents);
        }

        if (!os || os.toLowerCase().includes('linux')) {
            let nixQuery = "SELECT id, host, 'linux' as os, tags as level, NULL as eventID, filePath as source, message, timestamp FROM linux_logs WHERE 1=1";
            const nixParams = [];
            if (targetHost) {
                const names = resolveHostFilter(targetHost);
                if (names && names.length > 0) {
                    const placeholders = names.map(() => 'LOWER(host) = LOWER(?) OR LOWER(host) LIKE LOWER(?)').join(' OR ');
                    nixQuery += ` AND (${placeholders})`;
                    names.forEach(n => nixParams.push(n, `%${n}%`));
                }
            }
            if (level) {
                const l = String(level).trim().toLowerCase();
                if (l === 'error' || l === 'err' || l === 'critical' || l === 'crit') {
                    nixQuery += " AND (tags LIKE '%error%' OR tags LIKE '%err%' OR tags LIKE '%crit%' OR message LIKE '%error%' OR message LIKE '%failed%' OR message LIKE '%fatal%')";
                } else if (l === 'warning' || l === 'warn') {
                    nixQuery += " AND (tags LIKE '%warning%' OR tags LIKE '%warn%' OR message LIKE '%warning%' OR message LIKE '%warn%')";
                } else if (l === 'info' || l === 'information') {
                    nixQuery += " AND (tags LIKE '%info%' OR message LIKE '%info%')";
                } else {
                    nixQuery += " AND (tags LIKE ? OR message LIKE ?)";
                    nixParams.push(`%${level}%`, `%${level}%`);
                }
            }
            if (keyword) { nixQuery += " AND message LIKE ?"; nixParams.push(`%${keyword}%`); }
            if (from) { const f = parseTime(from); if (f) { nixQuery += " AND timestamp >= ?"; nixParams.push(f); } }
            if (to) { const t = parseTime(to); if (t) { nixQuery += " AND timestamp <= ?"; nixParams.push(t); } }
            nixQuery += " ORDER BY timestamp DESC LIMIT ?";
            nixParams.push(limit);
            const nixLogs = scoutDb.all(nixQuery, nixParams);
            results.push(...nixLogs);
        }

        results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        results = results.slice(0, limit);

        res.json({
            count: results.length,
            events: results
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/v1/open/prometheus
 * Standard Prometheus Text Format Metrics Exporter
 */
router.get('/prometheus', validateQueryParams([]), (req, res) => {
    try {
        const monitors = scoutDb.all("SELECT id, name, ip, os, status FROM monitors");
        let output = "# HELP scout_host_status Host online status (1 = online, 0 = offline)\n# TYPE scout_host_status gauge\n";

        monitors.forEach(m => {
            const isOnline = m.status !== 'offline' ? 1 : 0;
            output += `scout_host_status{id="${m.id}",name="${m.name}",ip="${m.ip}",os="${m.os}"} ${isOnline}\n`;
        });

        output += "\n# HELP scout_cpu_usage_percent CPU utilization percentage\n# TYPE scout_cpu_usage_percent gauge\n";
        monitors.forEach(m => {
            const row = scoutDb.get("SELECT metrics FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1", [m.id]);
            if (row && row.metrics) {
                try {
                    const parsed = JSON.parse(row.metrics);
                    if (parsed.cpu && typeof parsed.cpu.used === 'number') {
                        output += `scout_cpu_usage_percent{id="${m.id}",name="${m.name}",ip="${m.ip}"} ${parsed.cpu.used.toFixed(2)}\n`;
                    }
                } catch (e) {}
            }
        });

        output += "\n# HELP scout_memory_usage_percent Memory utilization percentage\n# TYPE scout_memory_usage_percent gauge\n";
        monitors.forEach(m => {
            const row = scoutDb.get("SELECT metrics FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1", [m.id]);
            if (row && row.metrics) {
                try {
                    const parsed = JSON.parse(row.metrics);
                    if (parsed.memory && typeof parsed.memory.used === 'number') {
                        output += `scout_memory_usage_percent{id="${m.id}",name="${m.name}",ip="${m.ip}"} ${parsed.memory.used.toFixed(2)}\n`;
                    }
                } catch (e) {}
            }
        });

        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(output);
    } catch (err) {
        res.status(500).send(`# ERROR: ${err.message}`);
    }
});

module.exports = router;
