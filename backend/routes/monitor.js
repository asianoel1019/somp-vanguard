const express = require('express');
const router = express.Router();
const { isValidApiKey } = require('../lib/inventoryValidation');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { authMiddleware, checkRole, checkFeature } = require('../middleware/auth');
const inventoryRouter = require('./inventory');
const { auditLog } = require('../lib/logger');
const { broadcastEvent } = require('../lib/websocket');
const { WS_EVENTS } = require('../constants/wsEvents');
const db = require('../services/scoutDb');
const { invalidateRuleCache } = require('../services/scoutAlertEngine');

// Helper to parse JSON arrays/objects from SQLite
function parseJSON(val, def) {
    if (!val) return def;
    try { return JSON.parse(val); } catch(e) { return def; }
}

const normEscalate = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 10080 ? n : null; };

// Generate API key for agents
function generateApiKey() {
    return crypto.randomBytes(32).toString('hex');
}

// Shared feature evaluation (SuperAdmin -> built-in "SuperAdmin" mapping, local admin -> all)
const { hasFeature } = require('../lib/permissions');

// Simple in-memory rate limiter for reports
const reportRateLimit = new Map();
const RATE_LIMIT_MAX = 30; // Max 30 reports per minute per IP+Key

const { processAgentReportFast, invalidateCache, invalidateConfigs } = require('../services/telemetryIngestionService');
const ruleExclusions = require('../services/ruleExclusions');

// --- Agent Report API (Fast Non-blocking Ingestion - Option A) ---
router.post('/report', async (req, res) => {
    try {
        const payload = req.body;
        if (!payload || !payload.hostname || !payload.apiKey) {
            return res.status(400).json({ error: 'Invalid payload' });
        }

        const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
        const rateKey = `${clientIp}-${payload.apiKey}`;
        const now = Date.now();

        if (!reportRateLimit.has(rateKey)) {
            reportRateLimit.set(rateKey, { count: 1, resetAt: now + 60000 });
        } else {
            const state = reportRateLimit.get(rateKey);
            if (now > state.resetAt) {
                state.count = 1;
                state.resetAt = now + 60000;
            } else {
                state.count++;
                if (state.count > RATE_LIMIT_MAX) {
                    return res.status(429).json({ error: 'Too Many Requests' });
                }
            }
        }

        // Periodic cleanup timer for expired rate limit entries
        if (!global.__reportRateLimitCleanupStarted) {
            global.__reportRateLimitCleanupStarted = true;
            setInterval(() => {
                const nowTime = Date.now();
                for (const [key, state] of reportRateLimit.entries()) {
                    if (nowTime > state.resetAt) reportRateLimit.delete(key);
                }
            }, 60000).unref();
        }

        const result = await processAgentReportFast(payload, clientIp);
        if (result.status !== 200) {
            return res.status(result.status).json({ error: result.error });
        }

        // Check for pending forensic tasks
        let pendingTasks = [];
        try {
            const monitorId = result.monitorId;
            if (monitorId) {
                const tasksRaw = db.all("SELECT id, scanType, params FROM forensic_tasks WHERE monitorId = ? AND status = 'pending'", [monitorId]);
                if (tasksRaw && tasksRaw.length > 0) {
                    pendingTasks = tasksRaw.map(t => ({
                        id: t.id,
                        scanType: t.scanType,
                        params: parseJSON(t.params, {})
                    }));
                    db.run("UPDATE forensic_tasks SET status = 'running' WHERE monitorId = ? AND status = 'pending'", [monitorId]);
                }
            }
        } catch (taskErr) {
            console.error('[Scout] Failed to fetch pending forensic tasks:', taskErr);
        }

        return res.json({
            ...result.response,
            pendingTasks
        });
    } catch (e) {
        console.error('[Scout] Report Error:', e);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Endpoint for Agent to report Windows & Linux Events (support both /event and /events)
const handleAgentEvents = async (req, res) => {
    try {
        const { apiKey, hostname, events } = req.body;
        if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

        // Flexible API key validation: match monitor by apiKey, hostname (case-insensitive), or valid global key
        let monitor = db.get("SELECT * FROM monitors WHERE apiKey = ?", [apiKey]);
        if (!monitor && hostname) {
            monitor = db.get("SELECT * FROM monitors WHERE LOWER(name) = LOWER(?)", [hostname]);
        }
        if (!monitor) {
            const isGlobalKey = db.get("SELECT 1 FROM api_keys WHERE key = ? AND (isOpenApi = 0 OR isOpenApi IS NULL)", [apiKey]);
            if (!isGlobalKey) {
                console.warn(`[Scout Event] Rejected event submission from ${hostname}: Invalid API Key (${apiKey})`);
                return res.status(401).json({ error: 'Invalid API Key' });
            }
        }

        // Resolve effective host: prioritize the agent's actual reported hostname
        let effectiveHost = hostname || (monitor ? monitor.name : 'unknown-host');
        if (hostname) {
            const hostMonitor = db.get("SELECT name FROM monitors WHERE LOWER(name) = LOWER(?)", [hostname]);
            if (hostMonitor && hostMonitor.name) {
                effectiveHost = hostMonitor.name;
            }
        }

        if (events && Array.isArray(events)) {
            const now = new Date();
            const nowIso = now.toISOString();

            let globalPolicyRules = [];
            try {
                const pRow = db.get("SELECT rules FROM winevent_policy WHERE id = 'global'");
                if (pRow && pRow.rules) {
                    globalPolicyRules = JSON.parse(pRow.rules);
                }
            } catch (e) {}

            for (const ev of events) {
                const id = ev.id || crypto.randomUUID();
                const raw = ev.raw || JSON.stringify(ev);

                // Use current server reception time if timestamp is missing, invalid, or far in the past (> 7 days)
                let ts = nowIso;
                const rawTs = ev.timestamp || ev['@timestamp'];
                if (rawTs) {
                    try {
                        const parsedTs = new Date(rawTs);
                        const diffMs = Math.abs(now.getTime() - parsedTs.getTime());
                        // If log timestamp is within 7 days, keep parsed ISO timestamp; otherwise use current reception time
                        if (!isNaN(parsedTs.getTime()) && diffMs < 7 * 24 * 60 * 60 * 1000) {
                            ts = parsedTs.toISOString();
                        }
                    } catch (e) {}
                }

                // Determine if it is a Linux log
                const isLinux = (ev.agent && ev.agent.type === 'scout-linux') || (ev.log && ev.log.file && ev.log.file.path) || (ev.event && ev.event.module);
                
                if (isLinux) {
                    const filePath = (ev.log && ev.log.file && ev.log.file.path) || 'unknown';
                    const format = ev.event && ev.event.module ? ev.event.module : 'syslog';
                    const tags = Array.isArray(ev.tags) ? ev.tags.join(', ') : (ev.tags || '');
                    db.queueRun(`INSERT OR IGNORE INTO linux_logs (id, host, filePath, format, message, tags, raw, timestamp) 
                            VALUES (?,?,?,?,?,?,?,?)`, 
                            [id, effectiveHost, filePath, format, ev.message || raw, tags, raw, ts]);

                    if (global.scoutAlertEngine && global.scoutAlertEngine.evaluateLogEvents) {
                        const monObj = monitor || { id: effectiveHost, name: effectiveHost, ip: req.ip || '0.0.0.0' };
                        global.scoutAlertEngine.evaluateLogEvents(monObj, 'syslog', {
                            id,
                            host: effectiveHost,
                            filePath,
                            format,
                            message: ev.message || raw,
                            tags,
                            raw,
                            timestamp: ts
                        });
                    }
                } else {
                    let parsed = null;
                    if (raw) {
                        try {
                            parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                        } catch (e) {}
                    }

                    // Server-side fallback filter for excludeUsers (Supports older scout-win agents seamlessly)
                    if (Array.isArray(globalPolicyRules) && globalPolicyRules.length > 0) {
                        const channelName = (ev.logName || ev.channel || '').toLowerCase();
                        const matchingRules = globalPolicyRules.filter(r => 
                            !r.logName || r.logName.toLowerCase() === channelName || channelName === ''
                        );

                        const eventUsers = new Set();
                        if (ev.user) eventUsers.add(String(ev.user).trim().toLowerCase());
                        if (ev.targetUser) eventUsers.add(String(ev.targetUser).trim().toLowerCase());
                        if (ev.subjectUser) eventUsers.add(String(ev.subjectUser).trim().toLowerCase());

                        if (parsed && parsed.EventData && Array.isArray(parsed.EventData.Data)) {
                            for (const d of parsed.EventData.Data) {
                                if (!d || !d.Name || !d.Value) continue;
                                const dName = String(d.Name).toLowerCase();
                                if (dName.includes('username') || dName === 'user' || dName === 'samaccountname' || dName === 'accountname') {
                                    const val = String(d.Value).trim().toLowerCase();
                                    if (val && val !== '-' && val !== '') {
                                        eventUsers.add(val);
                                        if (val.includes('\\')) {
                                            const parts = val.split('\\');
                                            eventUsers.add(parts[parts.length - 1].trim());
                                        }
                                    }
                                }
                            }
                        }

                        let isUserExcluded = false;
                        for (const rule of matchingRules) {
                            if (rule.excludeUsers) {
                                const excludedList = rule.excludeUsers.split(',').map(u => u.trim().toLowerCase()).filter(Boolean);
                                for (const excluded of excludedList) {
                                    const cleanEx = excluded.includes('\\') ? excluded.split('\\').pop().trim() : excluded;
                                    if (eventUsers.has(excluded) || eventUsers.has(cleanEx)) {
                                        isUserExcluded = true;
                                        break;
                                    }
                                }
                            }
                            if (isUserExcluded) break;
                        }

                        if (isUserExcluded) {
                            // Discard event matching excluded user rule
                            continue;
                        }
                    }

                    let level = ev.level || 'Information';
                    const lStr = String(level).trim().toLowerCase();
                    if (lStr === '1' || lStr === 'critical') level = 'Critical';
                    else if (lStr === '2' || lStr === 'error') level = 'Error';
                    else if (lStr === '3' || lStr === 'warning' || lStr === 'warn') level = 'Warning';
                    else if (lStr === '4' || lStr === '0' || lStr === 'information' || lStr === 'info') level = 'Information';

                    const eventID = ev.eventID || 0;
                    const provider = ev.provider || 'ScoutWindows';
                    
                    let messageText = ev.message;
                    if (!messageText || messageText === 'Native Go WEVTAPI Payload' || messageText.trim() === '') {
                        if (parsed && parsed.EventData && Array.isArray(parsed.EventData.Data)) {
                            const parts = parsed.EventData.Data
                                .filter(d => d && d.Value && String(d.Value).trim() !== '')
                                .map(d => d.Name ? `${d.Name}: ${d.Value}` : d.Value);
                            if (parts.length > 0) {
                                messageText = parts.join('; ');
                            }
                        }
                    }
                    if (!messageText || messageText === 'Native Go WEVTAPI Payload') {
                        messageText = `EventID ${eventID} from ${provider}`;
                    }

                    db.queueRun(`INSERT OR IGNORE INTO windows_events (id, host, level, eventID, provider, message, raw, timestamp) 
                            VALUES (?,?,?,?,?,?,?,?)`, 
                            [id, effectiveHost, level, eventID, provider, messageText, raw, ts]);

                    if (global.scoutAlertEngine && global.scoutAlertEngine.evaluateLogEvents) {
                        const monObj = monitor || { id: effectiveHost, name: effectiveHost, ip: req.ip || '0.0.0.0' };
                        global.scoutAlertEngine.evaluateLogEvents(monObj, 'winevent', {
                            id,
                            host: effectiveHost,
                            channel: ev.logName || ev.channel || '',
                            level,
                            eventID,
                            provider,
                            message: messageText,
                            raw,
                            parsed,
                            user: ev.user,
                            targetUser: ev.targetUser,
                            subjectUser: ev.subjectUser,
                            timestamp: ts
                        });
                    }
                }
            }
        }

        res.json({ success: true });
    } catch (e) {
        console.error('[Scout] Event Report Error:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

router.post('/event', handleAgentEvents);
router.post('/events', handleAgentEvents);

// Endpoint for Agent to report a remediation event (Self-Healing)
router.post('/remediation', async (req, res) => {
    try {
        const { apiKey, hostname, ip, ruleId, type, target, script, output, success } = req.body;
        if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

        const monitor = db.get("SELECT * FROM monitors WHERE apiKey = ?", [apiKey]);
        if (!monitor) return res.status(401).json({ error: 'Invalid API Key' });

        // Update last seen
        db.run("UPDATE monitors SET status = 'online', lastSeen = ? WHERE id = ?", [new Date().toISOString(), monitor.id]);

        const rule = db.get("SELECT name FROM rules WHERE id = ?", [ruleId]) || { name: 'Unknown Rule' };
        
        const logMsg = `Self-Healing triggered for ${monitor.name} (${ip}): ${type} [${target}] via rule '${rule.name}'. Success: ${success}. Output: ${output.substring(0, 100)}`;
        auditLog('Agent', 'Remediation', logMsg);

        // Save to remediation_logs table for UI visibility
        db.run(`INSERT INTO remediation_logs (id, monitorId, hostname, ip, ruleId, ruleName, type, target, script, output, success, timestamp)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                [crypto.randomUUID(), monitor.id, hostname, ip, ruleId, rule.name, type, target, script || '', output || '', success ? 1 : 0, new Date().toISOString()]);

        // Broadcast to WebSocket clients
        try {
            broadcastEvent(WS_EVENTS.SCOUT_REMEDIATION, { monitorId: monitor.id, hostname, ip, ruleName: rule.name, type, target, success, timestamp: new Date().toISOString() });
        } catch (wsErr) {}

        // Optionally broadcast event to UI or trigger Telegram notification
        const statusEmoji = success ? '🟢' : '🔴';
        const mdText = `*${statusEmoji} [Self-Healing]*\n` +
                       `🖥️ Host: ${monitor.name} (${ip})\n` +
                       `🔍 Check: ${type} (${target})\n` +
                       `📝 Rule: ${rule.name}\n` +
                       `⚙️ Result: ${success ? 'SUCCESS' : 'FAILED'}\n` +
                       `🕒 Time: ${new Date().toLocaleString()}\n\n` +
                       `*Output:*\n\`\`\`\n${output.substring(0, 500)}\n\`\`\``;
                       
        const { sendTelegramAlert } = require('../lib/logger');
        sendTelegramAlert(mdText, 'ScoutMonitor').catch(() => {});

        res.json({ success: true });
    } catch (e) {
        console.error('[Scout] Remediation Log Error:', e);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// --- Management APIs (Requires JWT) ---
router.use(authMiddleware);

// Feature gates. Most management APIs belong to Scout Monitor ('monitorScout'). The log endpoints belong to
// their own screens and are checked on the route itself:
//   Live Event Viewer ('monitorWinEvent'): GET /winevent/live, GET /linuxlog/live
//   Log Settings ('monitorLinuxLog'): winevent + linuxlog policy / push_policy, logrotation, vacuum, tls_settings
// They skip the Scout Monitor gate only for the exact method + path of one of those routes, so e.g.
// PUT /vacuum (which Express routes to PUT /:id) still needs monitorScout. A path form that is not
// recognised here only gets stricter (both gates).
const LOG_ROUTES = new Set([
    'GET /winevent/live', 'GET /linuxlog/live',
    'GET /winevent/policy', 'POST /winevent/policy', 'GET /winevent/push_policy', 'POST /winevent/push_policy',
    'POST /winevent/validate_push_policy',
    'GET /linuxlog/policy', 'POST /linuxlog/policy', 'GET /linuxlog/push_policy', 'POST /linuxlog/push_policy',
    'GET /logrotation', 'POST /logrotation', 'POST /logrotation/run', 'POST /vacuum',
    'GET /tls_settings', 'POST /tls_settings',
]);
function isLogRoute(req) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const p = String(req.path || '').toLowerCase().replace(/(.)\/$/, '$1');
    return LOG_ROUTES.has(`${method} ${p}`);
}
const monitorScoutGate = checkFeature('monitorScout');
router.use((req, res, next) => (isLogRoute(req) ? next() : monitorScoutGate(req, res, next)));
const liveViewerFeature = checkFeature('monitorWinEvent');
const logSettingsFeature = checkFeature('monitorLinuxLog');

// GET remediation logs
router.get('/remediation/history', checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    try {
        const logs = db.all("SELECT * FROM remediation_logs ORDER BY timestamp DESC LIMIT 200");
        res.json(logs.map(l => ({ ...l, success: l.success === 1 })));
    } catch (e) {
        res.status(500).json({ error: 'Failed to query remediation history' });
    }
});

// Helper to format monitor
const formatMonitor = (m, role) => {
    m.tags = parseJSON(m.tags, []);
    m.pingTargets = parseJSON(m.pingTargets, []);
    m.tcpTargets = parseJSON(m.tcpTargets, []);
    m.watchServices = parseJSON(m.watchServices, []);
    m.watchProcesses = parseJSON(m.watchProcesses, []);
    m.group = m.group_name;
    delete m.group_name;
    m.enabled = m.enabled === 1;
    if (role === 'Viewer') {
        delete m.apiKey;
    }
    return m;
};

// GET all monitors
router.get('/', checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    let monitors = db.all("SELECT * FROM monitors");
    
    // Auto-resolve envId from IPAM subnets
    try {
        const { readDataSync } = require('../lib/db');
        const subnets = readDataSync('network_service/ipam/subnets.json', []);
        const envRegistry = require('../lib/environmentRegistry');
        const envs = envRegistry.getEnvironments();

        monitors.forEach(monitor => {
            const ipamSub = subnets.find(sub => {
                if (!sub.ips) return false;
                return sub.ips.some(x => String(x.address).trim() === String(monitor.ip).trim());
            });
            if (ipamSub) {
                if (ipamSub.envId || ipamSub.environment) {
                    // The subnet stores envId since phase 2; legacy subnets still resolve by name / id / code
                    const matchEnv = envRegistry.resolveRecordEnv(ipamSub.envId, ipamSub.environment, envs);
                    if (matchEnv) {
                        if (monitor.envId !== matchEnv.id) {
                            monitor.envId = matchEnv.id;
                            db.run("UPDATE monitors SET envId = ? WHERE id = ?", [matchEnv.id, monitor.id]);
                        }
                    } else if (monitor.envId !== null) {
                        monitor.envId = null;
                        db.run("UPDATE monitors SET envId = NULL WHERE id = ?", [monitor.id]);
                    }
                } else if (monitor.envId !== null) {
                    monitor.envId = null;
                    db.run("UPDATE monitors SET envId = NULL WHERE id = ?", [monitor.id]);
                }
            }
        });
    } catch(err) {
        console.error('[Scout] GET monitors auto-resolve envId error:', err);
    }

    // Auto-detect OS from recent metrics if OS mismatch exists
    monitors.forEach(m => {
        try {
            const latestMetric = db.get("SELECT metrics FROM metrics WHERE monitorId = ? ORDER BY id DESC LIMIT 1", [m.id]);
            if (latestMetric && latestMetric.metrics) {
                const met = JSON.parse(latestMetric.metrics);
                let detectedOs = null;
                if (met.os) detectedOs = String(met.os).toLowerCase().includes('win') ? 'windows' : 'linux';
                else if (Array.isArray(met.disk) && met.disk.some(d => d && String(d.mount).startsWith('/'))) detectedOs = 'linux';
                else if (Array.isArray(met.disks) && met.disks.some(d => d && String(d.mount).startsWith('/'))) detectedOs = 'linux';
                else if (Array.isArray(met.disk) && met.disk.some(d => d && /^[A-Za-z]:/.test(String(d.mount)))) detectedOs = 'windows';
                else if (Array.isArray(met.disks) && met.disks.some(d => d && /^[A-Za-z]:/.test(String(d.mount)))) detectedOs = 'windows';

                if (detectedOs && detectedOs !== m.os) {
                    m.os = detectedOs;
                    db.run("UPDATE monitors SET os = ? WHERE id = ?", [detectedOs, m.id]);
                    console.log(`[Scout] Reconciled monitor ${m.name} (${m.ip}) OS: -> ${detectedOs}`);
                }
            }
        } catch (e) {}
    });

    const formatted = monitors.map(m => formatMonitor(m, req.user.role));
    res.json(formatted);
});

// POST new monitor
router.post('/', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const { name, ip, os, group, reportInterval, tags, envId, pingTargets, tcpTargets, watchServices, watchProcesses } = req.body;
    if (!name || !ip) return res.status(400).json({ error: 'Name and IP are required' });

    const existing = db.get("SELECT * FROM monitors WHERE ip = ? AND LOWER(name) = LOWER(?)", [ip, name]);
    if (existing) {
        return res.status(400).json({ error: 'Monitor with this IP and Hostname already exists' });
    }

    const newMonitor = {
        id: crypto.randomUUID(),
        name,
        ip,
        os: os || 'linux',
        group_name: group || 'Default',
        tags: JSON.stringify(tags || []),
        apiKey: generateApiKey(),
        enabled: 1,
        reportInterval: reportInterval || 60,
        status: 'offline',
        lastSeen: null,
        createdAt: new Date().toISOString(),
        envId: envId || null,
        pingTargets: JSON.stringify(pingTargets || []),
        tcpTargets: JSON.stringify(tcpTargets || []),
        watchServices: JSON.stringify(watchServices || []),
        watchProcesses: JSON.stringify(watchProcesses || [])
    };

    db.run(`INSERT INTO monitors (id, name, ip, os, group_name, tags, apiKey, enabled, reportInterval, status, lastSeen, createdAt, envId, pingTargets, tcpTargets, watchServices, watchProcesses) 
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 
            [newMonitor.id, newMonitor.name, newMonitor.ip, newMonitor.os, newMonitor.group_name, newMonitor.tags, newMonitor.apiKey, newMonitor.enabled, newMonitor.reportInterval, newMonitor.status, newMonitor.lastSeen, newMonitor.createdAt, newMonitor.envId, newMonitor.pingTargets, newMonitor.tcpTargets, newMonitor.watchServices, newMonitor.watchProcesses]);
    
    auditLog(req.user.username, 'Scout Monitor', `Created monitor ${name} (${ip})`);
    res.json(formatMonitor(newMonitor, req.user.role));
});

/** Tags/scope of a monitor changed: silently resolve open alerts of rules it is now excluded from (and audit it). */
function resolveNewlyExcluded(monitor, username) {
    try {
        const hits = ruleExclusions.resolveForMonitor(monitor);
        if (hits.length === 0) return;
        const names = hits.map(h => { const r = db.get('SELECT name FROM rules WHERE id = ?', [h.ruleId]); return `"${r ? r.name : h.ruleId}"`; });
        auditLog(username, 'Scout Monitor', `Resolved ${hits.reduce((n, h) => n + h.resolved, 0)} open alert(s) of ${monitor.name || monitor.id} as excluded (now excluded from ${names.join(', ')})`);
    } catch (e) {
        console.error('[Scout Monitor] Failed to resolve newly excluded alerts:', e.message);
    }
}

// POST bulk update monitors
router.post('/bulk-update', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const { agentIds, mode, config } = req.body;
    if (!agentIds || !Array.isArray(agentIds) || agentIds.length === 0) {
        return res.status(400).json({ error: 'agentIds is required and must be a non-empty array' });
    }
    
    db.exec(`BEGIN TRANSACTION;`);
    try {
        for (const id of agentIds) {
            const m = db.get("SELECT * FROM monitors WHERE id = ?", [id]);
            if (!m) continue;
            
            let updatedTags = parseJSON(m.tags, []);
            let updatedPing = parseJSON(m.pingTargets, []);
            let updatedTcp = parseJSON(m.tcpTargets, []);
            let updatedServices = parseJSON(m.watchServices, []);
            let updatedProcesses = parseJSON(m.watchProcesses, []);
            
            if (mode === 'overwrite') {
                if (config.tags) updatedTags = config.tags;
                if (config.pingTargets) updatedPing = config.pingTargets;
                if (config.tcpTargets) updatedTcp = config.tcpTargets;
                if (config.watchServices) updatedServices = config.watchServices;
                if (config.watchProcesses) updatedProcesses = config.watchProcesses;
            } else if (mode === 'append') {
                if (config.tags) updatedTags = [...new Set([...updatedTags, ...config.tags])];
                if (config.pingTargets) updatedPing = [...new Set([...updatedPing, ...config.pingTargets])];
                if (config.tcpTargets) updatedTcp = [...new Set([...updatedTcp, ...config.tcpTargets])];
                if (config.watchServices) updatedServices = [...new Set([...updatedServices, ...config.watchServices])];
                if (config.watchProcesses) updatedProcesses = [...new Set([...updatedProcesses, ...config.watchProcesses])];
            }
            let updateQuery = `UPDATE monitors SET tags=?, pingTargets=?, tcpTargets=?, watchServices=?, watchProcesses=?`;
            let queryParams = [JSON.stringify(updatedTags), JSON.stringify(updatedPing), JSON.stringify(updatedTcp), JSON.stringify(updatedServices), JSON.stringify(updatedProcesses)];
            
            if (config.disableReportLog !== undefined) {
                updateQuery += `, disableReportLog=?`;
                queryParams.push(config.disableReportLog ? 1 : 0);
            }
            if (config.logPath !== undefined) {
                updateQuery += `, logPath=?`;
                queryParams.push(config.logPath);
            }
            
            updateQuery += ` WHERE id=?`;
            queryParams.push(id);
            
            db.run(updateQuery, queryParams);
        }
        db.exec(`COMMIT;`);
    } catch(e) {
        db.exec(`ROLLBACK;`);
        console.error('[Scout] Bulk update error:', e);
        return res.status(500).json({ error: 'Failed to bulk update monitors' });
    }
    if (config && config.tags) {
        for (const id of agentIds) {
            const m = db.get('SELECT id, name, tags FROM monitors WHERE id = ?', [id]);
            if (m) { resolveNewlyExcluded(m, req.user.username); invalidateCache(m.id); }
        }
    }
    
    auditLog(req.user.username, 'Scout Monitor', `Bulk updated config for ${agentIds.length} monitors (${mode})`);
    res.json({ success: true });
});

// PUT update monitor
router.put('/:id', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const m = db.get("SELECT * FROM monitors WHERE id = ?", [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Monitor not found' });

    const { name, ip, os, group, enabled, reportInterval, tags, envId, pingTargets, tcpTargets, watchServices, watchProcesses } = req.body;
    
    if (name !== undefined) m.name = name;
    if (ip !== undefined) m.ip = ip;
    if (os !== undefined) m.os = os;
    if (group !== undefined) m.group_name = group;
    if (enabled !== undefined) m.enabled = enabled ? 1 : 0;
    if (reportInterval !== undefined) m.reportInterval = reportInterval;
    if (tags !== undefined) m.tags = JSON.stringify(tags);
    if (envId !== undefined) m.envId = envId;
    if (pingTargets !== undefined) m.pingTargets = JSON.stringify(pingTargets);
    if (tcpTargets !== undefined) m.tcpTargets = JSON.stringify(tcpTargets);
    if (watchServices !== undefined) m.watchServices = JSON.stringify(watchServices);
    if (watchProcesses !== undefined) m.watchProcesses = JSON.stringify(watchProcesses);

    db.run(`UPDATE monitors SET name=?, ip=?, os=?, group_name=?, enabled=?, reportInterval=?, tags=?, envId=?, pingTargets=?, tcpTargets=?, watchServices=?, watchProcesses=? WHERE id=?`, 
        [m.name, m.ip, m.os, m.group_name, m.enabled, m.reportInterval, m.tags, m.envId, m.pingTargets, m.tcpTargets, m.watchServices, m.watchProcesses, m.id]);

    invalidateCache(m.id);
    auditLog(req.user.username, 'Scout Monitor', `Updated monitor ${m.name}`);
    if (tags !== undefined) resolveNewlyExcluded(m, req.user.username);
    res.json(formatMonitor(m, req.user.role));
});

// DELETE monitor
router.delete('/:id', checkRole(['SuperAdmin']), (req, res) => {
    const monitor = db.get("SELECT * FROM monitors WHERE id = ?", [req.params.id]);
    if (!monitor) return res.status(404).json({ error: 'Monitor not found' });

    db.exec(`BEGIN TRANSACTION;`);
    try {
        db.run("DELETE FROM monitors WHERE id = ?", [req.params.id]);
        db.run("DELETE FROM rule_bindings WHERE scopeType = 'monitor' AND scopeValue = ?", [req.params.id]);
        db.run("DELETE FROM rule_exclusions WHERE scopeType = 'monitor' AND scopeValue = ?", [req.params.id]);
        db.run("DELETE FROM metrics WHERE monitorId = ?", [req.params.id]);
        db.run("DELETE FROM alerts WHERE monitorId = ?", [req.params.id]);
        db.exec(`COMMIT;`);
        invalidateRuleCache();
    } catch(e) {
        db.exec(`ROLLBACK;`);
        return res.status(500).json({ error: 'Failed to delete monitor' });
    }

    invalidateCache(req.params.id);
    auditLog(req.user.username, 'Scout Monitor', `Deleted monitor ${monitor.name}`);
    res.json({ success: true });
});

// POST regenerate key
router.post('/:id/regenerate-key', checkRole(['SuperAdmin']), (req, res) => {
    const monitor = db.get("SELECT * FROM monitors WHERE id = ?", [req.params.id]);
    if (!monitor) return res.status(404).json({ error: 'Monitor not found' });

    const newKey = generateApiKey();
    db.run("UPDATE monitors SET apiKey = ? WHERE id = ?", [newKey, req.params.id]);
    
    invalidateCache(req.params.id);
    auditLog(req.user.username, 'Scout Monitor', `Regenerated API Key for ${monitor.name}`);
    res.json({ success: true, apiKey: newKey });
});

// --- Global API Keys APIs ---
router.get('/apikeys', checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    try {
        const keys = db.all("SELECT * FROM api_keys");
        const counts = db.all("SELECT apiKey, COUNT(*) as count FROM monitors GROUP BY apiKey") || [];
        const countMap = {};
        counts.forEach(c => {
            countMap[c.apiKey] = c.count;
        });
        
        const result = keys.map(k => ({
            ...k,
            isOpenApi: k.isOpenApi === 1 || k.isOpenApi === true,
            maxAgents: k.isOpenApi ? null : (k.maxAgents !== null && k.maxAgents !== undefined ? k.maxAgents : 50),
            registeredCount: countMap[k.key] || 0
        }));
        res.json(result);
    } catch(e) {
        res.status(500).json({ error: 'Failed to query API Keys' });
    }
});

router.post('/apikeys', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const { name, desc, envId, maxAgents, isOpenApi } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    
    const isOp = (isOpenApi === true || isOpenApi === 1 || isOpenApi === 'true') ? 1 : 0;
    const limit = isOp ? 0 : (maxAgents !== undefined && maxAgents !== null ? parseInt(maxAgents, 10) : 50);
    
    const newKey = {
        id: crypto.randomUUID(),
        name,
        desc: desc || '',
        key: generateApiKey(),
        createdAt: new Date().toISOString(),
        envId: envId || null,
        maxAgents: limit,
        isOpenApi: isOp
    };
    db.run("INSERT INTO api_keys (id, name, desc, key, createdAt, envId, maxAgents, isOpenApi) VALUES (?,?,?,?,?,?,?,?)", 
           [newKey.id, newKey.name, newKey.desc, newKey.key, newKey.createdAt, newKey.envId, newKey.maxAgents, newKey.isOpenApi]);
    auditLog(req.user.username, 'Scout Monitor', `Created API Key ${name} (${isOp ? 'Open API' : `Limit: ${limit}`})`);
    res.json(newKey);
});

router.put('/apikeys/:id', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const keyObj = db.get("SELECT * FROM api_keys WHERE id = ?", [req.params.id]);
    if (!keyObj) return res.status(404).json({ error: 'API Key not found' });

    const { name, desc, envId, key, maxAgents, isOpenApi } = req.body;
    if (name !== undefined) keyObj.name = name;
    if (desc !== undefined) keyObj.desc = desc;
    if (envId !== undefined) keyObj.envId = envId || null;
    if (key !== undefined && key.trim() !== '') {
        if (!isValidApiKey(key.trim())) return res.status(400).json({ error: 'API key may only contain letters, digits, dot, underscore and dash (8-256 characters)' });
        keyObj.key = key.trim();
    }
    if (isOpenApi !== undefined) {
        keyObj.isOpenApi = (isOpenApi === true || isOpenApi === 1 || isOpenApi === 'true') ? 1 : 0;
    }
    if (maxAgents !== undefined && maxAgents !== null) keyObj.maxAgents = parseInt(maxAgents, 10);

    db.run("UPDATE api_keys SET name=?, desc=?, envId=?, key=?, maxAgents=?, isOpenApi=? WHERE id=?", 
           [keyObj.name, keyObj.desc, keyObj.envId, keyObj.key, keyObj.maxAgents, keyObj.isOpenApi || 0, keyObj.id]);
    auditLog(req.user.username, 'Scout Monitor', `Updated API Key ${keyObj.name}`);
    res.json(keyObj);
});

router.delete('/apikeys/:id', checkRole(['SuperAdmin']), (req, res) => {
    const keyObj = db.get("SELECT * FROM api_keys WHERE id = ?", [req.params.id]);
    if (!keyObj) return res.status(404).json({ error: 'API Key not found' });

    db.exec(`BEGIN TRANSACTION;`);
    try {
        db.run("DELETE FROM api_keys WHERE id = ?", [req.params.id]);
        
        // Disable all monitors using this key
        db.run("UPDATE monitors SET enabled = 0 WHERE apiKey = ?", [keyObj.key]);
        
        db.exec(`COMMIT;`);
    } catch(e) {
        db.exec(`ROLLBACK;`);
        return res.status(500).json({ error: 'Failed to delete API Key' });
    }

    auditLog(req.user.username, 'Scout Monitor', `Deleted API Key ${req.params.id} and disabled associated monitors`);
    res.json({ success: true });
});

// --- Rule Templates APIs ---
router.get('/rules', checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    const rules = db.all("SELECT * FROM rules").map(r => {
        r.actions = parseJSON(r.actions, []);
        r.recoveryNotify = r.recoveryNotify === 1;
        r.category = r.category || (['winevent', 'syslog'].includes(r.type) ? 'log' : 'metric');
        r.logConfig = parseJSON(r.logConfig, null);
        return r;
    });
    res.json(rules);
});

router.post('/rules', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const { name, type, target, threshold, cpuThreshold, memThreshold, alertHits, actions, recoveryNotify, remediationScript, remediationCooldown, remediationMaxRetries, category, logConfig, escalateAfterMin } = req.body;
    
    // RBAC Check for Self-Healing
    if (remediationScript && remediationScript.trim().length > 0) {
        if (!hasFeature(req.user, 'manage_self_healing')) {
            return res.status(403).json({ error: 'Access denied. You do not have permission to manage Self-Healing scripts.' });
        }
    }

    const resolvedCategory = category || (['winevent', 'syslog'].includes(type) ? 'log' : 'metric');
    const resolvedLogConfig = typeof logConfig === 'object' && logConfig !== null ? JSON.stringify(logConfig) : (logConfig || null);

    const newRule = {
        id: crypto.randomUUID(),
        name: name || `${type.toUpperCase()} Alert`,
        type, 
        target: target || '',
        threshold,
        cpuThreshold: cpuThreshold !== undefined ? cpuThreshold : null,
        memThreshold: memThreshold !== undefined ? memThreshold : null,
        alertHits: alertHits || (resolvedCategory === 'log' ? 1 : 3),
        actions: JSON.stringify(actions || []), 
        recoveryNotify: recoveryNotify !== false ? 1 : 0,
        remediationScript: remediationScript || '',
        remediationCooldown: remediationCooldown || 300,
        remediationMaxRetries: remediationMaxRetries || 3,
        category: resolvedCategory,
        logConfig: resolvedLogConfig,
        escalateAfterMin: normEscalate(escalateAfterMin)
    };

    db.run("INSERT INTO rules (id, name, type, target, threshold, cpuThreshold, memThreshold, alertHits, actions, recoveryNotify, remediationScript, remediationCooldown, remediationMaxRetries, category, logConfig, escalateAfterMin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", 
        [newRule.id, newRule.name, newRule.type, newRule.target, newRule.threshold, newRule.cpuThreshold, newRule.memThreshold, newRule.alertHits, newRule.actions, newRule.recoveryNotify, newRule.remediationScript, newRule.remediationCooldown, newRule.remediationMaxRetries, newRule.category, newRule.logConfig, newRule.escalateAfterMin]);
    
    auditLog(req.user.username, 'Scout Monitor', `Created alert rule template ${newRule.name}`);
    newRule.actions = parseJSON(newRule.actions, []);
    newRule.recoveryNotify = newRule.recoveryNotify === 1;
    newRule.logConfig = parseJSON(newRule.logConfig, null);
    invalidateRuleCache();
    res.json(newRule);
});

router.put('/rules/:id', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const r = db.get("SELECT * FROM rules WHERE id = ?", [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Rule not found' });

    const { name, type, target, threshold, cpuThreshold, memThreshold, alertHits, actions, recoveryNotify, remediationScript, remediationCooldown, remediationMaxRetries, category, logConfig, escalateAfterMin } = req.body;
    
    // RBAC Check for Self-Healing
    if (remediationScript !== undefined && remediationScript.trim() !== (r.remediationScript || '').trim()) {
        if (!hasFeature(req.user, 'manage_self_healing')) {
            return res.status(403).json({ error: 'Access denied. You do not have permission to manage Self-Healing scripts.' });
        }
    }

    if (name !== undefined) r.name = name;
    if (type !== undefined) r.type = type;
    if (target !== undefined) r.target = target;
    if (threshold !== undefined) r.threshold = threshold;
    if (cpuThreshold !== undefined) r.cpuThreshold = cpuThreshold;
    if (memThreshold !== undefined) r.memThreshold = memThreshold;
    if (alertHits !== undefined) r.alertHits = alertHits;
    if (actions !== undefined) r.actions = JSON.stringify(actions);
    if (recoveryNotify !== undefined) r.recoveryNotify = recoveryNotify ? 1 : 0;
    if (remediationScript !== undefined) r.remediationScript = remediationScript;
    if (remediationCooldown !== undefined) r.remediationCooldown = remediationCooldown;
    if (remediationMaxRetries !== undefined) r.remediationMaxRetries = remediationMaxRetries;
    if (category !== undefined) r.category = category;
    if (logConfig !== undefined) r.logConfig = typeof logConfig === 'object' && logConfig !== null ? JSON.stringify(logConfig) : logConfig;
    if (escalateAfterMin !== undefined) r.escalateAfterMin = normEscalate(escalateAfterMin);

    db.run("UPDATE rules SET name=?, type=?, target=?, threshold=?, cpuThreshold=?, memThreshold=?, alertHits=?, actions=?, recoveryNotify=?, remediationScript=?, remediationCooldown=?, remediationMaxRetries=?, category=?, logConfig=?, escalateAfterMin=? WHERE id=?",
        [r.name, r.type, r.target, r.threshold, r.cpuThreshold, r.memThreshold, r.alertHits, r.actions, r.recoveryNotify, r.remediationScript, r.remediationCooldown, r.remediationMaxRetries, r.category || 'metric', r.logConfig || null, r.escalateAfterMin ?? null, r.id]);

    auditLog(req.user.username, 'Scout Monitor', `Updated alert rule template ${r.name}`);
    r.actions = parseJSON(r.actions, []);
    r.recoveryNotify = r.recoveryNotify === 1;
    r.category = r.category || 'metric';
    r.logConfig = parseJSON(r.logConfig, null);
    invalidateRuleCache();
    res.json(r);
});

router.delete('/rules/:id', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    db.exec(`BEGIN TRANSACTION;`);
    try {
        db.run("DELETE FROM rules WHERE id = ?", [req.params.id]);
        db.run("DELETE FROM rule_bindings WHERE ruleId = ?", [req.params.id]);
        db.run("DELETE FROM rule_exclusions WHERE ruleId = ?", [req.params.id]);
        db.exec(`COMMIT;`);
    } catch(e) {
        db.exec(`ROLLBACK;`);
    }
    auditLog(req.user.username, 'Scout Monitor', `Deleted alert rule template ${req.params.id}`);
    invalidateRuleCache();
    res.json({ success: true });
});

// --- Rule Exclusions ("Excluded hosts") APIs --- same RBAC as bindings: read Viewer+, write Operator+
const exclusionTargetName = (scopeType, scopeValue) => {
    if (scopeType === 'monitor') {
        const m = db.get('SELECT name, ip FROM monitors WHERE id = ?', [scopeValue]);
        return m ? `host "${m.name}${m.ip ? ` (${m.ip})` : ''}"` : `host "${scopeValue}"`;
    }
    return `tag "${scopeValue}"`;
};

router.get('/rules/exclusions', checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    const ruleId = typeof req.query.ruleId === 'string' && req.query.ruleId ? req.query.ruleId : undefined;
    res.json(ruleExclusions.list(ruleId));
});

router.post('/rules/exclusions', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const v = ruleExclusions.validate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    let r;
    try {
        r = ruleExclusions.add(v.value, req.user.username);
    } catch (e) {
        console.error('[Scout Monitor] Failed to add rule exclusion:', e.message);
        return res.status(500).json({ error: 'Failed to add exclusion' });
    }
    if (r.duplicate) return res.status(409).json({ error: 'Exclusion already exists' });
    const rule = db.get('SELECT name FROM rules WHERE id = ?', [v.value.ruleId]);
    require('../lib/logger').auditLog(req.user.username, 'Scout Monitor',
        `Excluded ${exclusionTargetName(v.value.scopeType, v.value.scopeValue)} from alert rule "${rule ? rule.name : v.value.ruleId}"` +
        `${v.value.reason ? ` (reason: ${v.value.reason})` : ''}${r.resolvedAlerts ? `; ${r.resolvedAlerts} open alert(s) resolved as excluded` : ''}`);
    invalidateRuleCache();
    invalidateConfigs(r.monitorIds); // only the affected agents' dynamic config (targets / remediation of the rule)
    res.json({ exclusion: r.exclusion, resolvedAlerts: r.resolvedAlerts });
});

router.delete('/rules/exclusions/:id', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const row = ruleExclusions.remove(req.params.id);
    if (!row) return res.status(404).json({ error: 'Exclusion not found' });
    const rule = db.get('SELECT name FROM rules WHERE id = ?', [row.ruleId]);
    require('../lib/logger').auditLog(req.user.username, 'Scout Monitor',
        `Removed exclusion of ${exclusionTargetName(row.scopeType, row.scopeValue)} from alert rule "${rule ? rule.name : row.ruleId}"${row.reason ? ` (reason was: ${row.reason})` : ''}`);
    invalidateRuleCache();
    invalidateConfigs(ruleExclusions.affectedMonitorIds(row));
    res.json({ success: true });
});

// --- Rule Bindings APIs ---
router.get('/rules/bindings',checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    res.json(db.all("SELECT * FROM rule_bindings"));
});

router.post('/rules/bindings', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const { ruleId, scopeType, scopeValue } = req.body;
    
    // Prevent duplicates
    const exists = db.get("SELECT 1 FROM rule_bindings WHERE ruleId=? AND scopeType=? AND scopeValue=?", [ruleId, scopeType, scopeValue]);
    if (exists) return res.status(400).json({ error: 'Binding already exists' });

    const newBinding = {
        id: crypto.randomUUID(),
        ruleId,
        scopeType,
        scopeValue
    };

    db.run("INSERT INTO rule_bindings VALUES (?,?,?,?)", [newBinding.id, newBinding.ruleId, newBinding.scopeType, newBinding.scopeValue]);
    
    // Resolve rule name and scope target name for audit logging
    let ruleName = ruleId;
    let targetName = scopeValue;
    try {
        const ruleRow = db.get("SELECT name FROM rules WHERE id = ?", [ruleId]);
        if (ruleRow) ruleName = ruleRow.name;
        
        if (scopeType === 'monitor') {
            const monitorRow = db.get("SELECT name FROM monitors WHERE id = ?", [scopeValue]);
            if (monitorRow) targetName = monitorRow.name;
        } else if (scopeType === 'apikey') {
            const keyRow = db.get("SELECT name FROM api_keys WHERE key = ? OR id = ?", [scopeValue, scopeValue]);
            if (keyRow) targetName = keyRow.name;
        } else if (scopeType === 'env') {
            // Resolve global environment name from system/environments.json
            const { readDataSync } = require('../lib/db');
            const envs = readDataSync('system/environments.json', []);
            const envRow = envs.find(e => e.id === scopeValue || e.name === scopeValue);
            if (envRow) targetName = envRow.name;
        }
    } catch(e) {}

    auditLog(req.user.username, 'Scout Monitor', `Bound rule "${ruleName}" to ${scopeType} "${targetName}"`);
    invalidateRuleCache();
    res.json(newBinding);
});

router.delete('/rules/bindings/:id', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    let ruleName = '';
    let scopeType = '';
    let targetName = '';
    try {
        const bindingRow = db.get("SELECT * FROM rule_bindings WHERE id = ?", [req.params.id]);
        if (bindingRow) {
            scopeType = bindingRow.scopeType;
            targetName = bindingRow.scopeValue;
            
            const ruleRow = db.get("SELECT name FROM rules WHERE id = ?", [bindingRow.ruleId]);
            if (ruleRow) ruleName = ruleRow.name;
            
            if (scopeType === 'monitor') {
                const monitorRow = db.get("SELECT name FROM monitors WHERE id = ?", [bindingRow.scopeValue]);
                if (monitorRow) targetName = monitorRow.name;
            } else if (scopeType === 'apikey') {
                const keyRow = db.get("SELECT name FROM api_keys WHERE key = ? OR id = ?", [bindingRow.scopeValue, bindingRow.scopeValue]);
                if (keyRow) targetName = keyRow.name;
            } else if (scopeType === 'env') {
                // Resolve global environment name from system/environments.json
                const { readDataSync } = require('../lib/db');
                const envs = readDataSync('system/environments.json', []);
                const envRow = envs.find(e => e.id === bindingRow.scopeValue || e.name === bindingRow.scopeValue);
                if (envRow) targetName = envRow.name;
            }
        }
    } catch(e) {}

    db.run("DELETE FROM rule_bindings WHERE id = ?", [req.params.id]);
    
    if (ruleName) {
        auditLog(req.user.username, 'Scout Monitor', `Deleted rule binding of "${ruleName}" to ${scopeType} "${targetName}"`);
    } else {
        auditLog(req.user.username, 'Scout Monitor', `Deleted rule binding ${req.params.id}`);
    }
    invalidateRuleCache();
    res.json({ success: true });
});

// --- Metrics & Alerts APIs ---
router.get('/:id/metrics', checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    const hoursStr = req.query.hours;
    const hours = parseFloat(hoursStr);
    const isAll = hoursStr === 'all' || isNaN(hours);
    
    let query = "SELECT timestamp, metrics FROM metrics WHERE monitorId = ?";
    let groupBy = "";
    
    // Optimize performance by downsampling data points for longer time ranges
    if (isAll || hours > 24) {
        // Group by hour (substr up to 'YYYY-MM-DDTHH') -> 1 point per hour
        query = "SELECT min(timestamp) as timestamp, metrics FROM metrics WHERE monitorId = ?";
        groupBy = " GROUP BY substr(timestamp, 1, 13)";
    } else if (hours > 1) {
        // Group by 10-minute intervals (substr up to 'YYYY-MM-DDTHH:M') -> 1 point per 10 mins
        query = "SELECT min(timestamp) as timestamp, metrics FROM metrics WHERE monitorId = ?";
        groupBy = " GROUP BY substr(timestamp, 1, 15)";
    }

    const params = [req.params.id];
    if (!isAll && hours > 0) {
        const sinceTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        query += " AND timestamp >= ?";
        params.push(sinceTime);
    }
    
    query += groupBy + " ORDER BY timestamp ASC";
    
    const metricsRows = db.all(query, params);
    const formatted = metricsRows.map(r => ({
        timestamp: r.timestamp,
        metrics: parseJSON(r.metrics, {})
    }));
    res.json(formatted);
});

router.get('/data/alerts', checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    const isPaginated = req.query.page || req.query.limit || req.query.status || req.query.search || req.query.type;
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const status = req.query.status || 'all'; // 'active', 'resolved', 'all'
    const search = (req.query.search || '').trim();
    const type = (req.query.type || '').trim();

    let whereClause = [];
    let params = [];

    if (status === 'active') {
        whereClause.push('resolved = 0');
    } else if (status === 'resolved') {
        whereClause.push('resolved = 1');
    }

    if (type) {
        whereClause.push('type = ?');
        params.push(type);
    }

    if (search) {
        whereClause.push('(ruleName LIKE ? OR target LIKE ? OR value LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereStr = whereClause.length > 0 ? ` WHERE ${whereClause.join(' AND ')}` : '';

    if (!isPaginated) {
        const alerts = db.all(`SELECT * FROM alerts${whereStr} ORDER BY resolved ASC, triggeredAt DESC`, params).map(a => {
            a.resolved = a.resolved === 1;
            return a;
        });
        return res.json(alerts);
    }

    const countRow = db.get(`SELECT count(*) as count FROM alerts${whereStr}`, params);
    const total = countRow ? countRow.count : 0;
    const totalPages = Math.ceil(total / limit) || 1;

    const alerts = db.all(`SELECT * FROM alerts${whereStr} ORDER BY resolved ASC, triggeredAt DESC LIMIT ? OFFSET ?`, [...params, limit, offset]).map(a => {
        a.resolved = a.resolved === 1;
        return a;
    });

    res.json({
        total,
        page,
        limit,
        totalPages,
        data: alerts
    });
});

router.post('/alerts/batch-resolve', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const { alertIds, resolveAll } = req.body;
        const nowIso = new Date().toISOString();

        if (resolveAll) {
            const countRow = db.get("SELECT count(*) as count FROM alerts WHERE resolved = 0");
            const count = countRow ? countRow.count : 0;
            db.run("UPDATE alerts SET resolved = 1, resolvedAt = ? WHERE resolved = 0", [nowIso]);
            auditLog(req.user.username, 'Scout Monitor', `Acknowledged all active alerts (${count} items)`);
            return res.json({ success: true, message: 'All active alerts resolved' });
        }

        if (!Array.isArray(alertIds) || alertIds.length === 0) {
            return res.status(400).json({ error: 'Missing or invalid alertIds array' });
        }

        const placeholders = alertIds.map(() => '?').join(',');
        const targetAlerts = db.all(`SELECT a.*, m.name as hostName, m.ip as hostIp FROM alerts a LEFT JOIN monitors m ON a.monitorId = m.id WHERE a.id IN (${placeholders}) AND a.resolved = 0`, alertIds);

        db.run(`UPDATE alerts SET resolved = 1, resolvedAt = ? WHERE id IN (${placeholders}) AND resolved = 0`, [nowIso, ...alertIds]);

        if (targetAlerts.length === 1) {
            const a = targetAlerts[0];
            const hostDisplay = a.hostName ? `${a.hostName} (${a.hostIp || 'N/A'})` : a.monitorId;
            const eventDetail = [a.ruleName || a.type, a.target ? `[${a.target}]` : '', a.value != null && a.threshold != null ? `${a.value} > ${a.threshold}` : ''].filter(Boolean).join(' ');
            auditLog(req.user.username, 'Scout Monitor', `Acknowledged alert\nHost: ${hostDisplay}\nEvent: ${eventDetail}`);
        } else if (targetAlerts.length > 1) {
            const summaryList = targetAlerts.slice(0, 4).map(a => `${a.hostName || a.monitorId}: ${a.ruleName || a.type}`).join(', ');
            const suffix = targetAlerts.length > 4 ? ` and ${targetAlerts.length - 4} more` : '';
            auditLog(req.user.username, 'Scout Monitor', `Batch acknowledged ${targetAlerts.length} alerts:\n${summaryList}${suffix}`);
        }

        res.json({ success: true, count: alertIds.length });
    } catch (e) {
        console.error('[Scout] Batch resolve alerts error:', e);
        res.status(500).json({ error: 'Failed to batch resolve alerts' });
    }
});

router.put('/alerts/:id/resolve', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const alert = db.get("SELECT * FROM alerts WHERE id = ?", [req.params.id]);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    if (alert.resolved === 1) return res.json({ success: true, message: 'Already resolved' });

    db.run("UPDATE alerts SET resolved = 1, resolvedAt = ? WHERE id = ?", [new Date().toISOString(), req.params.id]);

    const monitor = db.get("SELECT name, ip FROM monitors WHERE id = ?", [alert.monitorId]);
    const hostDisplay = monitor ? `${monitor.name} (${monitor.ip || 'N/A'})` : alert.monitorId;
    const eventDetail = [
        alert.ruleName || alert.type,
        alert.target ? `[${alert.target}]` : '',
        alert.value != null && alert.threshold != null ? `(Current: ${alert.value}, Threshold: ${alert.threshold})` : ''
    ].filter(Boolean).join(' ');

    auditLog(req.user.username, 'Scout Monitor', `Acknowledged alert\nHost: ${hostDisplay}\nEvent: ${eventDetail}`);
    res.json({ success: true });
});

router.post('/alerts/clear', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        db.run("DELETE FROM alerts");
        auditLog(req.user.username, 'Scout Monitor', 'Cleared all alerts history');
        res.json({ success: true });
    } catch (e) {
        console.error('[Scout] Clear Alerts error:', e);
        res.status(500).json({ error: 'Failed to clear alerts history' });
    }
});

router.get('/data/dashboard', checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    const monitors = db.all("SELECT * FROM monitors").map(m => formatMonitor(m, req.user.role));
    const alerts = db.all("SELECT * FROM alerts ORDER BY resolved ASC, triggeredAt DESC").map(a => {
        a.resolved = a.resolved === 1;
        return a;
    });
    
    // Subquery to get the latest metric for each monitor (optimized)
    const latestMetricsRows = db.all(`
        SELECT m1.monitorId, m1.metrics 
        FROM metrics m1
        INNER JOIN (
            SELECT monitorId, MAX(timestamp) as maxTs
            FROM metrics
            GROUP BY monitorId
        ) m2 ON m1.monitorId = m2.monitorId AND m1.timestamp = m2.maxTs
    `);

    const lastMetricsMap = {};
    latestMetricsRows.forEach(r => {
        lastMetricsMap[r.monitorId] = parseJSON(r.metrics, null);
    });

    const historyRows = db.all("SELECT monitorId, timestamp, metrics FROM metrics ORDER BY timestamp DESC LIMIT 500") || [];
    const historyMap = {};
    historyRows.forEach(row => {
        if (!historyMap[row.monitorId]) historyMap[row.monitorId] = [];
        if (historyMap[row.monitorId].length < 10) {
            historyMap[row.monitorId].push({
                timestamp: row.timestamp,
                cpu: parseJSON(row.metrics, {}).cpu?.used || 0,
                memory: parseJSON(row.metrics, {}).memory?.used || 0
            });
        }
    });
    Object.keys(historyMap).forEach(id => {
        historyMap[id].reverse();
    });

    const result = monitors.map(m => {
        return { 
            ...m, 
            lastMetric: lastMetricsMap[m.id] || null,
            metricsHistory: historyMap[m.id] || []
        };
    });

    res.json({ 
        monitors: result, 
        alerts,
        currentVersion: inventoryRouter.getLatestWinAgent().version,
        currentLinuxVersion: inventoryRouter.getLatestLinuxAgent().version
    });
});

// GET Windows Event Policy
router.get('/winevent/policy', logSettingsFeature, checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    try {
        let policyRow = db.get("SELECT * FROM winevent_policy WHERE id = 'global'");
        if (!policyRow || !policyRow.rules) {
            return res.json([{ logName: 'Security', includeIds: '', excludeIds: '', severity: 'All' }]);
        }
        res.json(JSON.parse(policyRow.rules));
    } catch (e) {
        res.status(500).json({ error: 'Failed to get policy' });
    }
});

// POST Windows Event Policy
router.post('/winevent/policy', logSettingsFeature, checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const rules = req.body;
        if (!Array.isArray(rules)) return res.status(400).json({ error: 'Invalid payload, expected array' });
        
        db.run(`INSERT OR REPLACE INTO winevent_policy (id, rules) VALUES ('global', ?)`, 
                [JSON.stringify(rules)]);
        auditLog(req.user.username, 'Scout Monitor', 'Updated Windows Event Global Policy (Multiple Rules)');
        res.json({ success: true });
    } catch (e) {
        console.error('[Scout] Failed to update winevent policy:', e);
        res.status(500).json({ error: 'Failed to update policy' });
    }
});
// GET Windows Event Push Policy
router.get('/winevent/push_policy', logSettingsFeature, checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    try {
        let policyRow = db.get("SELECT * FROM winevent_policy WHERE id = 'push_es'");
        if (!policyRow || !policyRow.rules) {
            return res.json({});
        }
        const data = JSON.parse(policyRow.rules);
        if (data && data.yamlConfig) {
            const val = validateWineventPushPolicy(data);
            if (val && val.parsedRules && val.parsedRules.length > 0) {
                data.structuredRules = val.parsedRules;
            }
        }
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Failed to get push policy' });
    }
});

// Helper to validate Windows Event Push Policy (YAML, URL, Levels)
function validateWineventPushPolicy(policy) {
    const errors = [];
    const warnings = [];
    const suggestions = [];
    let parsedRules = [];

    if (!policy) {
        return { valid: false, errors: ['Policy data is missing.'], warnings, suggestions, parsedRules, ruleCount: 0 };
    }

    // 1. Elasticsearch URL Check
    if (policy.elasticsearchEnabled) {
        if (!policy.url || !policy.url.trim()) {
            errors.push('Elasticsearch URL 為必填欄位。');
        } else {
            const urlTrim = policy.url.trim();
            if (!/^https?:\/\//i.test(urlTrim)) {
                errors.push('Elasticsearch URL 必須以 http:// 或 https:// 開頭。');
            } else if (urlTrim.startsWith('http://')) {
                warnings.push('Elasticsearch URL 使用 HTTP 未加密協定，生產環境建議改用 HTTPS。');
            }
        }
    }

    // 2. YAML Filter Rules Check
    if (policy.elasticsearchEnabled && policy.logEnabled !== false && policy.yamlConfig) {
        const rawYaml = policy.yamlConfig.trim();
        if (!rawYaml) {
            errors.push('YAML 映射策略目前為空，必須定義至少一條 scout_push_policy 規則。');
        } else {
            let doc;
            try {
                const yaml = require('js-yaml');
                doc = yaml.load(rawYaml);
            } catch (yErr) {
                errors.push(`YAML 語法錯誤 (第 ${yErr.mark ? yErr.mark.line + 1 : '?'} 行, 第 ${yErr.mark ? yErr.mark.column + 1 : '?'} 列): ${yErr.reason || yErr.message}`);
            }

            if (doc) {
                if (typeof doc !== 'object' || doc === null) {
                    errors.push('YAML 根節點必須是物件並包含 "scout_push_policy" 鍵。');
                } else if (!doc.scout_push_policy) {
                    errors.push('YAML 缺少必要根鍵 "scout_push_policy: "。');
                } else if (!Array.isArray(doc.scout_push_policy)) {
                    errors.push('"scout_push_policy" 必須是陣列/列表清單 (以 - 開頭的規則)。');
                } else if (doc.scout_push_policy.length === 0) {
                    warnings.push('"scout_push_policy" 規則清單為空，Agent 不會收集並轉發任何日誌。');
                } else {
                    const validLevels = ['All', 'Information', 'Warning', 'Error', 'Critical'];
                    doc.scout_push_policy.forEach((rule, idx) => {
                        const ruleNum = idx + 1;
                        if (!rule || typeof rule !== 'object') {
                            errors.push(`第 ${ruleNum} 條規則格式錯誤，必須為字典/物件結構。`);
                            return;
                        }

                        const channel = typeof rule.channel === 'string' ? rule.channel.trim() : '';
                        if (!channel) {
                            errors.push(`第 ${ruleNum} 條規則: 缺少必要的 "channel" (例如: Security, System, Application)。`);
                        }

                        let normLevel = 'All';
                        if (rule.level !== undefined && rule.level !== null) {
                            const rawLvl = String(rule.level).trim();
                            const matched = validLevels.find(v => v.toLowerCase() === rawLvl.toLowerCase());
                            if (matched) {
                                normLevel = matched;
                            } else {
                                if (/all\s+levels/i.test(rawLvl)) {
                                    errors.push(`第 ${ruleNum} 條規則: level 設定為 "${rawLvl}"。請改用標準值 "All"（點擊「自動修正格式」可修復）。`);
                                    suggestions.push(`第 ${ruleNum} 條規則: "All Levels" ➔ "All"`);
                                } else if (/warn/i.test(rawLvl)) {
                                    errors.push(`第 ${ruleNum} 條規則: level 設定為 "${rawLvl}"。請改用標準值 "Warning"（點擊「自動修正格式」可修復）。`);
                                    suggestions.push(`第 ${ruleNum} 條規則: "Warning & Above" ➔ "Warning"`);
                                } else if (/err/i.test(rawLvl) || /crit/i.test(rawLvl)) {
                                    errors.push(`第 ${ruleNum} 條規則: level 設定為 "${rawLvl}"。請改用標準值 "Error"（點擊「自動修正格式」可修復）。`);
                                    suggestions.push(`第 ${ruleNum} 條規則: "Error & Critical" ➔ "Error"`);
                                } else {
                                    errors.push(`第 ${ruleNum} 條規則: level "${rawLvl}" 不合法。合法值僅限: ${validLevels.join(', ')}。`);
                                }
                            }
                        }

                        let includeCount = 0;
                        let excludeCount = 0;
                        let includeIds = '';
                        let excludeIds = '';
                        if (rule.event_ids) {
                            if (typeof rule.event_ids !== 'object' || rule.event_ids === null) {
                                errors.push(`第 ${ruleNum} 條規則: "event_ids" 格式錯誤，必須包含 include 或 exclude。`);
                            } else {
                                if (rule.event_ids.include !== undefined) {
                                    if (!Array.isArray(rule.event_ids.include)) {
                                        errors.push(`第 ${ruleNum} 條規則: "event_ids.include" 必須為數字陣列 (例如: [4624, 4625])。`);
                                    } else {
                                        includeCount = rule.event_ids.include.length;
                                        includeIds = rule.event_ids.include.join(', ');
                                    }
                                }
                                if (rule.event_ids.exclude !== undefined) {
                                    if (!Array.isArray(rule.event_ids.exclude)) {
                                        errors.push(`第 ${ruleNum} 條規則: "event_ids.exclude" 必須為數字陣列 (例如: [5379, 4798])。`);
                                    } else {
                                        excludeCount = rule.event_ids.exclude.length;
                                        excludeIds = rule.event_ids.exclude.join(', ');
                                    }
                                }
                            }
                        }

                        let excludeUsersStr = '';
                        if (rule.exclude_users !== undefined) {
                            if (!Array.isArray(rule.exclude_users)) {
                                errors.push(`第 ${ruleNum} 條規則: "exclude_users" 必須為字串陣列 (例如: ["svc_backup", "healthcheck"])。`);
                            } else {
                                excludeUsersStr = rule.exclude_users.join(', ');
                            }
                        }

                        parsedRules.push({
                            channel: channel || 'Unknown',
                            level: normLevel,
                            includeCount,
                            excludeCount,
                            excludeUsers: excludeUsersStr,
                            tags: Array.isArray(rule.tags) ? rule.tags : []
                        });
                    });
                }
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        suggestions,
        parsedRules,
        ruleCount: parsedRules.length
    };
}

// POST Validate Windows Event Push Policy Syntax (Check Syntax)
router.post('/winevent/validate_push_policy', logSettingsFeature, checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    try {
        const policy = req.body;
        const validation = validateWineventPushPolicy(policy);
        res.json(validation);
    } catch (e) {
        console.error('[Scout] Validation error:', e);
        res.status(500).json({ valid: false, errors: [`伺服器內部驗證錯誤: ${e.message}`], warnings: [], suggestions: [], parsedRules: [], ruleCount: 0 });
    }
});

// POST Windows Event Push Policy
router.post('/winevent/push_policy', logSettingsFeature, checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const rules = req.body;
        const validation = validateWineventPushPolicy(rules);
        if (!validation.valid) {
            return res.status(400).json({ 
                error: '策略語法檢查未通過，無法部署', 
                validation 
            });
        }

        db.run(`INSERT OR REPLACE INTO winevent_policy (id, rules) VALUES ('push_es', ?)`, 
                [JSON.stringify(rules)]);
        auditLog(req.user.username, 'Scout Monitor', 'Updated Windows Event Push Policy');
        res.json({ success: true, validation });
    } catch (e) {
        console.error('[Scout] Failed to update winevent push policy:', e);
        res.status(500).json({ error: 'Failed to update push policy' });
    }
});

// GET Linux Log Policy
router.get('/linuxlog/policy', logSettingsFeature, checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    try {
        let policyRow = db.get("SELECT * FROM linux_log_policy WHERE id = 'global'");
        if (!policyRow || !policyRow.rules) {
            return res.json([]);
        }
        res.json(JSON.parse(policyRow.rules));
    } catch (e) {
        res.status(500).json({ error: 'Failed to get linux log policy' });
    }
});

// POST Linux Log Policy
router.post('/linuxlog/policy', logSettingsFeature, checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const rules = req.body;
        if (!Array.isArray(rules)) return res.status(400).json({ error: 'Invalid payload, expected array' });
        
        db.run(`INSERT OR REPLACE INTO linux_log_policy (id, rules) VALUES ('global', ?)`, 
                [JSON.stringify(rules)]);
        auditLog(req.user.username, 'Scout Monitor', 'Updated Linux Log Policy');
        res.json({ success: true });
    } catch (e) {
        console.error('[Scout] Failed to update linux log policy:', e);
        res.status(500).json({ error: 'Failed to update policy' });
    }
});

// GET Linux Log Push Policy
router.get('/linuxlog/push_policy', logSettingsFeature, checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    try {
        let policyRow = db.get("SELECT * FROM linux_log_policy WHERE id = 'push_es'");
        if (!policyRow || !policyRow.rules) {
            return res.json({ elasticsearchEnabled: false, url: '', username: '', password: '', rules: [] });
        }
        res.json(JSON.parse(policyRow.rules));
    } catch (e) {
        res.status(500).json({ error: 'Failed to get linux log push policy' });
    }
});

// POST Linux Log Push Policy
router.post('/linuxlog/push_policy', logSettingsFeature, checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const rules = req.body;
        db.run(`INSERT OR REPLACE INTO linux_log_policy (id, rules) VALUES ('push_es', ?)`, 
                [JSON.stringify(rules)]);
        auditLog(req.user.username, 'Scout Monitor', 'Updated Linux Log Push Policy');
        res.json({ success: true });
    } catch (e) {
        console.error('[Scout] Failed to update linux log push policy:', e);
        res.status(500).json({ error: 'Failed to update push policy' });
    }
});

// Helper: Calculate Two-Tier Dynamic Retention Days
// Default: Hot Tier max 14 days. If maxRetentionDays < 28, hotDays = Math.floor(maxRetentionDays / 2).
function calculateDynamicTiers(maxRetentionDays) {
    const totalDays = Math.max(1, Number(maxRetentionDays) || 30);
    let hotDays = 14;
    if (totalDays < 28) {
        hotDays = Math.max(1, Math.floor(totalDays / 2));
    } else {
        hotDays = 14;
    }
    const coldDays = Math.max(0, totalDays - hotDays);
    return { totalDays, hotDays, coldDays };
}

// Native local-time wheel/interval engine for Log Rotation (Rule 6)
const zlib = require('zlib');

function readColdArchives(tableName, filterFn, maxLimit = 100) {
    const results = [];
    try {
        const archiveDir = path.join(process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard', 'archives');
        if (!fs.existsSync(archiveDir)) return results;
        const prefix = `archive_${tableName}_`;
        const files = fs.readdirSync(archiveDir).filter(f => f.startsWith(prefix) && f.endsWith('.json.gz')).sort().reverse();
        for (const file of files) {
            if (results.length >= maxLimit) break;
            try {
                const filePath = path.join(archiveDir, file);
                const gzBuf = fs.readFileSync(filePath);
                const jsonStr = zlib.gunzipSync(gzBuf).toString('utf8');
                const items = JSON.parse(jsonStr);
                if (Array.isArray(items)) {
                    for (const item of items) {
                        if (!filterFn || filterFn(item)) {
                            results.push(item);
                            if (results.length >= maxLimit) break;
                        }
                    }
                }
            } catch (e) {}
        }
    } catch (err) {}
    return results;
}

function archiveLogsBeforePurge(tableName, rowsToPurge) {
    if (!rowsToPurge || rowsToPurge.length === 0) return;
    try {
        const archiveDir = path.join(process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard', 'archives');
        if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
        }
        const todayStr = new Date().toISOString().slice(0, 10);
        const fileName = `archive_${tableName}_${todayStr}_${Date.now()}.json.gz`;
        const filePath = path.join(archiveDir, fileName);

        const compressedData = zlib.gzipSync(JSON.stringify(rowsToPurge));
        fs.writeFileSync(filePath, compressedData);
        console.log(`[Log Rotation Archiver] Successfully archived ${rowsToPurge.length} records to ${filePath}`);
    } catch (err) {
        console.error(`[Log Rotation Archiver] Failed to archive logs for ${tableName}:`, err);
    }
}

function cleanupExpiredArchives(tableName, totalDays) {
    try {
        const archiveDir = path.join(process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard', 'archives');
        if (!fs.existsSync(archiveDir)) return;
        const prefix = `archive_${tableName}_`;
        const files = fs.readdirSync(archiveDir);

        // If totalDays is 0 or not provided, remove all archives for this table (e.g. legacy metrics archives)
        if (!totalDays || totalDays <= 0) {
            for (const file of files) {
                if (file.startsWith(prefix) && file.endsWith('.json.gz')) {
                    const filePath = path.join(archiveDir, file);
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`[Log Rotation Archiver] Cleaned up legacy archive: ${file}`);
                    } catch (e) {}
                }
            }
            return;
        }

        const cutoffMs = Date.now() - totalDays * 24 * 60 * 60 * 1000;
        for (const file of files) {
            if (file.startsWith(prefix) && file.endsWith('.json.gz')) {
                const filePath = path.join(archiveDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    if (stats.mtimeMs < cutoffMs) {
                        fs.unlinkSync(filePath);
                        console.log(`[Log Rotation Archiver] Purged expired archive (> ${totalDays} days): ${file}`);
                    }
                } catch (e) {}
            }
        }
    } catch (err) {
        console.error(`[Log Rotation Archiver] Failed to cleanup expired archives for ${tableName}:`, err);
    }
}

// GET Live Windows Events (Seamless Hot SQLite + Cold Archive tiering)
router.get('/winevent/live', liveViewerFeature, checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    try {
        if (db.flushWriteBuffer) db.flushWriteBuffer();
        const search = (req.query.search || '').trim();
        let events;
        if (search) {
            const searchLike = `%${search}%`;
            const searchNum = parseInt(search, 10);
            events = db.all(
                "SELECT * FROM windows_events WHERE host LIKE ? OR eventID = ? OR message LIKE ? OR raw LIKE ? ORDER BY rowid DESC LIMIT 200",
                [searchLike, isNaN(searchNum) ? -1 : searchNum, searchLike, searchLike]
            );
            if (events.length < 200) {
                const searchLower = search.toLowerCase();
                const coldEvents = readColdArchives('windows_events', item => {
                    return (item.host && item.host.toLowerCase().includes(searchLower)) ||
                           (String(item.eventID) === search) ||
                           (item.message && item.message.toLowerCase().includes(searchLower)) ||
                           (item.raw && item.raw.toLowerCase().includes(searchLower));
                }, 200 - events.length);
                events = events.concat(coldEvents);
            }
        } else {
            events = db.all("SELECT * FROM windows_events ORDER BY rowid DESC LIMIT 100");
            if (events.length < 100) {
                const coldEvents = readColdArchives('windows_events', null, 100 - events.length);
                events = events.concat(coldEvents);
            }
        }
        res.json(events);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch events' });
    }
});

// GET Live Linux Logs (Seamless Hot SQLite + Cold Archive tiering)
router.get('/linuxlog/live', liveViewerFeature, checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    try {
        if (db.flushWriteBuffer) db.flushWriteBuffer();
        const search = (req.query.search || '').trim();
        let events;
        if (search) {
            const searchLike = `%${search}%`;
            events = db.all(
                "SELECT * FROM linux_logs WHERE host LIKE ? OR message LIKE ? OR tags LIKE ? OR filePath LIKE ? ORDER BY rowid DESC LIMIT 200",
                [searchLike, searchLike, searchLike, searchLike]
            );
            if (events.length < 200) {
                const searchLower = search.toLowerCase();
                const coldEvents = readColdArchives('linux_logs', item => {
                    return (item.host && item.host.toLowerCase().includes(searchLower)) ||
                           (item.message && item.message.toLowerCase().includes(searchLower)) ||
                           (item.tags && item.tags.toLowerCase().includes(searchLower)) ||
                           (item.filePath && item.filePath.toLowerCase().includes(searchLower));
                }, 200 - events.length);
                events = events.concat(coldEvents);
            }
        } else {
            events = db.all("SELECT * FROM linux_logs ORDER BY rowid DESC LIMIT 100");
            if (events.length < 100) {
                const coldEvents = readColdArchives('linux_logs', null, 100 - events.length);
                events = events.concat(coldEvents);
            }
        }
        res.json(events);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch linux logs' });
    }
});

// GET Log Rotation Settings (Includes computed hot/cold days)
router.get('/logrotation', logSettingsFeature, checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    try {
        const settings = db.all("SELECT * FROM log_rotation_settings");
        const enriched = settings.map(s => {
            const { hotDays, coldDays, totalDays } = calculateDynamicTiers(s.maxRetentionDays);
            return { ...s, hotDays, coldDays, totalDays };
        });
        res.json(enriched);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch log rotation settings' });
    }
});

// POST Update Log Rotation Settings
router.post('/logrotation', logSettingsFeature, checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const rules = req.body;
        if (!Array.isArray(rules)) return res.status(400).json({ error: 'Invalid payload, expected array' });

        db.exec("BEGIN TRANSACTION;");
        try {
            for (const r of rules) {
                db.run(`INSERT OR REPLACE INTO log_rotation_settings (id, maxRetentionDays, maxRecords, enabled) 
                        VALUES (?, ?, ?, ?)`, [r.id, r.maxRetentionDays, r.maxRecords, r.enabled ? 1 : 0]);
            }
            db.exec("COMMIT;");
        } catch (e) {
            db.exec("ROLLBACK;");
            throw e;
        }

        auditLog(req.user.username, 'Scout Monitor', 'Updated Log Rotation settings');
        res.json({ success: true });
    } catch (e) {
        console.error('[Scout] Log Rotation save error:', e);
        res.status(500).json({ error: 'Failed to update log rotation settings' });
    }
});

// POST Run Log Rotation Now (Manual trigger)
router.post('/logrotation/run', logSettingsFeature, checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        runLogRotation();
        auditLog(req.user.username, 'Scout Monitor', 'Manually executed Two-Tier Log Rotation');
        res.json({ success: true, message: 'Two-Tier Log Rotation completed successfully' });
    } catch (e) {
        console.error('[Scout] Manual Log Rotation error:', e);
        res.status(500).json({ error: 'Failed to run log rotation: ' + e.message });
    }
});

// POST Vacuum & Compact Scout Database (Multi-DB Optimized)
router.post('/vacuum', logSettingsFeature, checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const dbManager = require('../services/db');
        const engine = dbManager.resolveDriverType();

        if (engine === 'postgres') {
            await dbManager.exec("VACUUM ANALYZE;");
            auditLog(req.user.username, 'Scout Monitor', 'Executed PostgreSQL VACUUM ANALYZE');
            res.json({ success: true, engine: 'PostgreSQL', message: 'PostgreSQL VACUUM ANALYZE executed successfully. Query statistics updated.' });
        } else if (engine === 'mariadb') {
            try { await dbManager.exec("OPTIMIZE TABLE metrics, windows_events, linux_logs;"); } catch(e) {}
            auditLog(req.user.username, 'Scout Monitor', 'Executed MariaDB OPTIMIZE TABLE');
            res.json({ success: true, engine: 'MariaDB', message: 'MariaDB table optimization completed successfully.' });
        } else if (engine === 'mssql') {
            try { await dbManager.exec("ALTER INDEX ALL ON metrics REORGANIZE;"); } catch(e) {}
            auditLog(req.user.username, 'Scout Monitor', 'Executed MSSQL index reorganization');
            res.json({ success: true, engine: 'MSSQL', message: 'MSSQL index reorganization completed successfully.' });
        } else {
            await dbManager.exec("VACUUM;");
            auditLog(req.user.username, 'Scout Monitor', 'Executed SQLite VACUUM to reclaim disk space');
            res.json({ success: true, engine: 'SQLite', message: 'SQLite database compacted and space reclaimed successfully.' });
        }
    } catch (e) {
        console.error('[Scout] Database maintenance error:', e);
        res.status(500).json({ error: 'Failed to optimize database: ' + e.message });
    }
});

function runLogRotation() {
    try {
        const settings = db.all("SELECT * FROM log_rotation_settings");
        for (const s of settings) {
            if (s.enabled === 1) {
                let tableName = s.id; // 'windows_events' or 'linux_logs'
                if (tableName === 'agent_metrics') tableName = 'metrics';

                if (tableName === 'metrics') {
                    // Host Performance Metrics: Direct retention purge from SQLite (no gz archive files created)
                    const retentionDays = Number(s.maxRetentionDays) || 7;
                    if (retentionDays > 0) {
                        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
                        db.run("DELETE FROM metrics WHERE timestamp < ?", [cutoff]);
                        console.log(`[Metrics Retention] Purged performance metrics older than ${retentionDays} days (before ${cutoff})`);
                    }
                    // Clean up any legacy archive_metrics_*.json.gz files in archives directory
                    cleanupExpiredArchives('metrics', 0);
                } else {
                    // Windows Events & Linux Logs: Full Two-Tier Dynamic Rotation
                    const { totalDays, hotDays } = calculateDynamicTiers(s.maxRetentionDays);

                    // 1. Two-Tier Dynamic Rotation: Archive and purge hot data older than hotDays (Complete batch processing)
                    if (hotDays > 0) {
                        const hotCutoff = new Date(Date.now() - hotDays * 24 * 60 * 60 * 1000).toISOString();
                        while (true) {
                            const expiredHotRows = db.all(`SELECT * FROM ${tableName} WHERE timestamp < ? LIMIT 20000`, [hotCutoff]);
                            if (!expiredHotRows || expiredHotRows.length === 0) break;
                            archiveLogsBeforePurge(tableName, expiredHotRows);
                            db.run(`DELETE FROM ${tableName} WHERE timestamp < ?`, [hotCutoff]);
                            if (expiredHotRows.length < 20000) break;
                        }
                    }

                    // 2. Enforce maxRecords limit if configured (Complete batch processing)
                    if (s.maxRecords > 0) {
                        while (true) {
                            const cutoffRow = db.get(`SELECT timestamp FROM ${tableName} ORDER BY timestamp DESC LIMIT 1 OFFSET ?`, [s.maxRecords]);
                            if (!cutoffRow || !cutoffRow.timestamp) break;
                            const overflowRows = db.all(`SELECT * FROM ${tableName} WHERE timestamp < ? LIMIT 20000`, [cutoffRow.timestamp]);
                            if (!overflowRows || overflowRows.length === 0) break;
                            archiveLogsBeforePurge(tableName, overflowRows);
                            db.run(`DELETE FROM ${tableName} WHERE timestamp < ?`, [cutoffRow.timestamp]);
                            if (overflowRows.length < 20000) break;
                        }
                    }

                    // 3. Purge cold archive files older than total retention days
                    cleanupExpiredArchives(tableName, totalDays);
                }
            }
        }
    } catch (e) {
        console.error('[Scheduler] Log rotation execution error:', e);
    }
}

// Run log rotation periodically in the background (Rule 6)
setInterval(runLogRotation, 30 * 60 * 1000).unref();

// GET Agent TLS Settings
router.get('/tls_settings', logSettingsFeature, checkRole(['Viewer', 'Operator', 'SuperAdmin']), (req, res) => {
    try {
        const policyRow = db.get("SELECT * FROM linux_log_policy WHERE id = 'agent_tls'");
        if (policyRow && policyRow.rules) {
            res.json(JSON.parse(policyRow.rules));
        } else {
            res.json({ tlsEnabled: false, tlsSkipVerify: true });
        }
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch agent TLS settings' });
    }
});

// POST Update Agent TLS Settings
router.post('/tls_settings', logSettingsFeature, checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const config = req.body;
        db.run(`INSERT OR REPLACE INTO linux_log_policy (id, rules) VALUES ('agent_tls', ?)`, 
                [JSON.stringify(config)]);
        auditLog(req.user.username, 'Scout Monitor', 'Updated Agent TLS Settings');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to update agent TLS settings' });
    }
});

module.exports = router;
