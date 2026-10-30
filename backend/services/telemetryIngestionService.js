/**
 * Telemetry Ingestion Service (Option A: Asynchronous Non-blocking Batch Ingestion)
 * 
 * Offloads Scout Agent telemetry JSON parsing, multi-query lookups, and DB writes
 * from the Express HTTP event loop to an in-memory fast-path queue with batch transactions.
 */

const crypto = require('crypto');
const db = require('./scoutDb');
const { broadcastEvent } = require('../lib/websocket');
const { WS_EVENTS } = require('../constants/wsEvents');
const { readDataSync } = require('../lib/db');
const logger = require('../lib/logger');
const { isServerDeleted, reviveIfIpReused } = require('./cmdbModel');
const { buildRuleScope, loadExclusions, applicableRuleIds } = require('./ruleScope');

// In-Memory Fast Caches
const monitorCache = new Map();     // Key: "ip:name" or "apiKey:name" -> Monitor Object
const configCache = new Map();      // Key: monitorId -> { config, expiresAt }
let telemetryQueue = [];            // Telemetry queue for micro-batch flushing
let isFlushing = false;
let autoRegLock = new Set();
const deletedAgentNotices = new Map(); // ip -> last Telegram notice time (ms); in-memory throttle
const DELETED_AGENT_NOTICE_MS = 24 * 3600 * 1000;
const deletedCheckCache = new Map(); // `${ip}|${hostname}` -> expiry ms; only positive ("deleted") results are cached
const DELETED_CHECK_TTL_MS = 60 * 1000;

/**
 * Is this agent's IP flagged deleted in Server List? A different hostname on a deleted IP means the IP was
 * reassigned to a new server: the flag is cleared (history RESTORE_IP_REUSE) and registration proceeds.
 * A deleted-but-reporting agent is cached for 60 s so CMDB meta is not parsed on every report.
 */
function isAgentOnDeletedServer(ip, hostname, nowMs = Date.now()) {
    const key = `${ip}|${String(hostname || '').toLowerCase()}`;
    const until = deletedCheckCache.get(key);
    if (until !== undefined && until > nowMs) return true;
    deletedCheckCache.delete(key);
    if (reviveIfIpReused(ip, hostname)) return false;
    if (!isServerDeleted(ip)) return false;
    deletedCheckCache.set(key, nowMs + DELETED_CHECK_TTL_MS);
    return true;
}

/**
 * An agent keeps reporting from a server that was deleted in Server List: do not re-register it,
 * but tell the operators at most once per IP per 24 h (in memory, resets on restart).
 * Returns true when a notice was sent.
 */
function notifyDeletedAgentReporting(ip, hostname, nowMs = Date.now()) {
    const last = deletedAgentNotices.get(ip);
    if (last !== undefined && nowMs - last < DELETED_AGENT_NOTICE_MS) return false;
    deletedAgentNotices.set(ip, nowMs);
    console.warn(`[Ingestion] Agent on deleted server ${hostname || '-'} (${ip}) is still reporting - not re-registered`);
    try {
        Promise.resolve(logger.sendTelegramAlert(
            `⚠️ [Scout Monitor] Agent on deleted server ${hostname || ip} (${ip}) is still reporting — not re-registered. Restore the server in Server List or uninstall the agent.`,
            'ScoutMonitor'
        )).catch(() => {});
    } catch (e) { /* non-fatal */ }
    return true;
}

function parseJSON(val, def) {
    if (!val) return def;
    try { return JSON.parse(val); } catch (e) { return def; }
}

function generateApiKey() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Invalidate in-memory caches when monitors or rules are modified in UI
 */
function invalidateCache(monitorId = null) {
    if (monitorId) {
        configCache.delete(monitorId);
        for (const [k, v] of monitorCache.entries()) {
            if (v && v.id === monitorId) monitorCache.delete(k);
        }
    } else {
        monitorCache.clear();
        configCache.clear();
    }
}

/** Drops only the cached dynamic agent config of these monitors (monitor rows stay cached). O(ids). */
function invalidateConfigs(monitorIds) {
    for (const id of monitorIds || []) configCache.delete(id);
}

/**
 * Computes dynamic configuration for an agent
 */
function buildDynamicConfig(monitor) {
    const dynamicConfig = {
        apiKey: monitor.apiKey,
        reportInterval: monitor.reportInterval || 60,
        pingTargets: [],
        tcpTargets: [],
        watchServices: [],
        watchProcesses: [],
        remediationPolicies: [],
        disableReportLog: monitor.disableReportLog !== null && monitor.disableReportLog !== undefined ? !!monitor.disableReportLog : true,
        logPath: monitor.logPath || '/var/log/scout-agent.log'
    };

    try {
        const monitorPing = parseJSON(monitor.pingTargets, []);
        const monitorTcp = parseJSON(monitor.tcpTargets, []);
        const monitorServices = parseJSON(monitor.watchServices, []);
        const monitorProcesses = parseJSON(monitor.watchProcesses, []);

        const pingSet = new Set(monitorPing);
        const tcpSet = new Set(monitorTcp);
        const serviceSet = new Set(monitorServices);
        const processSet = new Set(monitorProcesses);

        // Shared rule-scope helper: inclusion bindings minus exclusions (an excluded host gets no targets / remediation of that rule)
        const scope = buildRuleScope(db.all("SELECT * FROM rule_bindings") || [], loadExclusions(db));

        applicableRuleIds(monitor, scope.index, scope.exclusions, { includeGlobal: false }).forEach(ruleId => {
            const rule = db.get("SELECT * FROM rules WHERE id = ?", [ruleId]);
            if (rule && rule.target) {
                const targetStr = String(rule.target).trim();
                if (targetStr) {
                    if (rule.type === 'ping') pingSet.add(targetStr);
                    else if (rule.type === 'tcp') tcpSet.add(targetStr);
                    else if (rule.type === 'service') serviceSet.add(targetStr);
                    else if (['process', 'process_cpu', 'process_memory'].includes(rule.type)) processSet.add(targetStr);
                }

                if (rule.remediationScript && rule.remediationScript.trim().length > 0) {
                    if (!dynamicConfig.remediationPolicies.find(p => p.id === rule.id)) {
                        dynamicConfig.remediationPolicies.push({
                            id: rule.id,
                            type: rule.type,
                            target: rule.target,
                            threshold: rule.threshold,
                            script: rule.remediationScript,
                            timeoutSeconds: rule.timeoutSeconds || 30
                        });
                    }
                }
            }
        });

        dynamicConfig.pingTargets = Array.from(pingSet);
        dynamicConfig.tcpTargets = Array.from(tcpSet);
        dynamicConfig.watchServices = Array.from(serviceSet);
        dynamicConfig.watchProcesses = Array.from(processSet);

        // Windows / Linux Log Policies
        const policyRow = db.get("SELECT * FROM winevent_policy WHERE id = 'global'");
        if (policyRow && policyRow.rules) {
            dynamicConfig.windowsEventPolicy = parseJSON(policyRow.rules, []);
        }
        const pushPolicyRow = db.get("SELECT * FROM winevent_policy WHERE id = 'push_es'");
        if (pushPolicyRow && pushPolicyRow.rules) {
            const p = parseJSON(pushPolicyRow.rules, {});
            if (!p.elasticsearchEnabled) {
                dynamicConfig.windowsEventPushPolicy = { ...p, elasticsearchEnabled: false, logEnabled: false, metricsEnabled: false, yamlConfig: '' };
            } else {
                const logActive = p.logEnabled !== false;
                const metricsActive = !!p.metricsEnabled;
                dynamicConfig.windowsEventPushPolicy = {
                    ...p,
                    elasticsearchEnabled: true,
                    logEnabled: logActive,
                    metricsEnabled: metricsActive,
                    yamlConfig: logActive ? (p.yamlConfig || '') : ''
                };
            }
        }
        
        const linuxPolicyRow = db.get("SELECT * FROM linux_log_policy WHERE id = 'global'");
        if (linuxPolicyRow && linuxPolicyRow.rules) {
            dynamicConfig.linuxLogPolicy = parseJSON(linuxPolicyRow.rules, []);
        }
        const linuxPushRow = db.get("SELECT * FROM linux_log_policy WHERE id = 'push_es'");
        if (linuxPushRow && linuxPushRow.rules) {
            const lp = parseJSON(linuxPushRow.rules, {});
            if (!lp.elasticsearchEnabled) {
                dynamicConfig.linuxLogPushPolicy = { ...lp, elasticsearchEnabled: false, logEnabled: false, metricsEnabled: false, rules: [] };
            } else {
                const logActive = lp.logEnabled !== false;
                const metricsActive = !!lp.metricsEnabled;
                dynamicConfig.linuxLogPushPolicy = {
                    ...lp,
                    elasticsearchEnabled: true,
                    logEnabled: logActive,
                    metricsEnabled: metricsActive,
                    rules: logActive ? (lp.rules || []) : []
                };
            }
        } else {
            dynamicConfig.linuxLogPushPolicy = { elasticsearchEnabled: false, logEnabled: false, url: '', username: '', password: '', rules: [] };
        }

        const tlsPolicyRow = db.get("SELECT * FROM linux_log_policy WHERE id = 'agent_tls'");
        if (tlsPolicyRow && tlsPolicyRow.rules) {
            const tlsConf = parseJSON(tlsPolicyRow.rules, {});
            dynamicConfig.tlsEnabled = !!tlsConf.tlsEnabled;
            dynamicConfig.tlsSkipVerify = !!tlsConf.tlsSkipVerify;
        } else {
            dynamicConfig.tlsEnabled = false;
            dynamicConfig.tlsSkipVerify = true;
        }
    } catch (e) {
        console.error('[Ingestion] Error building dynamic config for monitor:', monitor.id, e);
    }

    return dynamicConfig;
}

/**
 * Fast-path handler for incoming agent report
 * Returns { success: true, config } in < 1ms
 */
async function processAgentReportFast(payload, clientIp) {
    const ip = payload.ip || clientIp || '0.0.0.0';
    const hostname = payload.hostname || '';
    const apiKey = payload.apiKey || '';
    const cacheKey = `${ip}:${hostname.toLowerCase()}`;

    let monitor = monitorCache.get(cacheKey);

    if (!monitor) {
        // Look up by IP + Name
        monitor = db.get("SELECT * FROM monitors WHERE ip = ? AND LOWER(name) = LOWER(?)", [ip, hostname]);

        if (monitor) {
            if (monitor.apiKey !== apiKey) {
                const isValidKey = db.get("SELECT 1 FROM api_keys WHERE key = ? AND (isOpenApi = 0 OR isOpenApi IS NULL)", [apiKey]);
                if (isValidKey) {
                    monitor.apiKey = apiKey;
                    db.run("UPDATE monitors SET apiKey = ? WHERE id = ?", [apiKey, monitor.id]);
                }
            }
        }

        if (!monitor) {
            // Match by apiKey + Hostname
            monitor = db.get("SELECT * FROM monitors WHERE apiKey = ? AND LOWER(name) = LOWER(?)", [apiKey, hostname]);
        }

        if (!monitor) {
            // Check global key auto-registration
            const globalKeyObj = db.get("SELECT * FROM api_keys WHERE key = ? AND (isOpenApi = 0 OR isOpenApi IS NULL)", [apiKey]);
            if (globalKeyObj && isAgentOnDeletedServer(String(ip).replace(/^::ffff:/, ''), hostname)) {
                notifyDeletedAgentReporting(ip, hostname);
            } else if (globalKeyObj) {
                const autoRegKey = `${ip}:${hostname}`;
                if (!autoRegLock.has(autoRegKey)) {
                    autoRegLock.add(autoRegKey);
                    try {
                        const registeredCount = db.get("SELECT COUNT(*) as count FROM monitors WHERE apiKey = ?", [apiKey])?.count || 0;
                        const limit = globalKeyObj.maxAgents ?? 50;
                        let targetApiKey = apiKey;

                        if (registeredCount >= limit) {
                            let baseName = globalKeyObj.name.replace(' (Auto-Regen)', '').replace(/ \d+$/, '');
                            const familyKeys = db.all("SELECT * FROM api_keys WHERE name LIKE ?", [baseName + '%']) || [];
                            let availableKey = null;
                            let maxSuffix = 1;

                            for (const fk of familyKeys) {
                                const match = fk.name.match(/ (\d+)$/);
                                const suffix = match ? parseInt(match[1], 10) : 1;
                                if (suffix > maxSuffix) maxSuffix = suffix;
                                const fkLimit = fk.maxAgents ?? 50;
                                const fkCount = db.get("SELECT COUNT(*) as count FROM monitors WHERE apiKey = ?", [fk.key])?.count || 0;
                                if (fkCount < fkLimit) {
                                    availableKey = fk;
                                    break;
                                }
                            }

                            if (availableKey) {
                                targetApiKey = availableKey.key;
                            } else {
                                const nextSuffix = maxSuffix + 1;
                                targetApiKey = generateApiKey();
                                db.run("INSERT INTO api_keys (id, name, desc, key, createdAt, envId, maxAgents) VALUES (?,?,?,?,?,?,?)", [
                                    crypto.randomUUID(), `${baseName} ${nextSuffix}`, `Auto-regenerated for limit ${limit}`, targetApiKey, new Date().toISOString(), globalKeyObj.envId || null, limit
                                ]);
                            }
                        }

                        monitor = {
                            id: crypto.randomUUID(),
                            name: hostname,
                            ip: ip,
                            os: payload.os || 'linux',
                            group_name: 'Auto-Registered',
                            tags: JSON.stringify([]),
                            reportInterval: 60,
                            apiKey: targetApiKey,
                            enabled: 1,
                            status: 'online',
                            lastSeen: new Date().toISOString(),
                            createdAt: new Date().toISOString(),
                            envId: globalKeyObj.envId || null,
                            version: payload.version || null
                        };

                        db.run(`INSERT INTO monitors (id, name, ip, os, group_name, tags, apiKey, enabled, reportInterval, status, lastSeen, createdAt, envId, version) 
                                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 
                                [monitor.id, monitor.name, monitor.ip, monitor.os, monitor.group_name, monitor.tags, monitor.apiKey, monitor.enabled, monitor.reportInterval, monitor.status, monitor.lastSeen, monitor.createdAt, monitor.envId, monitor.version]);
                        
                        // Linkage: Auto-sync to Prometheus Targets upon new Scout Agent registration
                        try {
                            const { autoSyncPrometheusTarget } = require('./inventoryScheduler');
                            autoSyncPrometheusTarget(monitor.ip, monitor.name, monitor.os);
                        } catch (syncErr) {}
                    } finally {
                        autoRegLock.delete(autoRegKey);
                    }
                }
            } else {
                monitor = db.get("SELECT * FROM monitors WHERE apiKey = ?", [apiKey]);
            }
        }

        if (monitor) {
            monitorCache.set(cacheKey, monitor);
            monitorCache.set(`${apiKey}:${hostname.toLowerCase()}`, monitor);
        }
    }

    if (!monitor) {
        return { status: 401, error: 'Unauthorized or unregistered agent' };
    }

    if (monitor.enabled === 0) {
        return { status: 403, error: 'Monitor is disabled' };
    }

    // Get or build dynamic config (cached for 30 seconds)
    const nowTime = Date.now();
    let cachedCfgObj = configCache.get(monitor.id);
    if (!cachedCfgObj || nowTime > cachedCfgObj.expiresAt) {
        const freshConfig = buildDynamicConfig(monitor);
        cachedCfgObj = { config: freshConfig, expiresAt: nowTime + 30000 };
        configCache.set(monitor.id, cachedCfgObj);
    }

    // Push report into non-blocking ingestion queue
    telemetryQueue.push({
        monitorId: monitor.id,
        monitor: monitor,
        payload: payload,
        timestamp: payload.timestamp || new Date().toISOString(),
        receivedAt: nowTime
    });

    if (telemetryQueue.length >= 200) {
        setImmediate(flushTelemetryBatch);
    }

    return {
        status: 200,
        monitorId: monitor.id,
        response: {
            success: true,
            config: cachedCfgObj.config
        }
    };
}

/**
 * Micro-batch flusher: Executes bulk updates in a single fast SQLite transaction
 */
async function flushTelemetryBatch() {
    if (isFlushing || telemetryQueue.length === 0) return;
    isFlushing = true;

    const batch = telemetryQueue;
    telemetryQueue = [];

    try {
        const nowIso = new Date().toISOString();
        const monitorUpdates = new Map();
        const metricsToInsert = [];

        for (const item of batch) {
            const m = item.monitor;
            const p = item.payload;

            // Track latest status & IP/OS updates
            let reportedOs = p.os ? (String(p.os).toLowerCase().includes('win') ? 'windows' : 'linux') : null;
            if (!reportedOs && p.metrics) {
                const met = p.metrics;
                if (met.os) reportedOs = String(met.os).toLowerCase().includes('win') ? 'windows' : 'linux';
                else if (Array.isArray(met.disk) && met.disk.some(d => d && String(d.mount).startsWith('/'))) reportedOs = 'linux';
                else if (Array.isArray(met.disks) && met.disks.some(d => d && String(d.mount).startsWith('/'))) reportedOs = 'linux';
                else if (Array.isArray(met.disk) && met.disk.some(d => d && /^[A-Za-z]:/.test(String(d.mount)))) reportedOs = 'windows';
                else if (Array.isArray(met.disks) && met.disks.some(d => d && /^[A-Za-z]:/.test(String(d.mount)))) reportedOs = 'windows';
            }

            const updatedOs = reportedOs || m.os || 'linux';
            const updatedIp = p.ip || m.ip || '0.0.0.0';
            const updatedVer = p.version || m.version || null;

            monitorUpdates.set(item.monitorId, {
                id: item.monitorId,
                lastSeen: item.timestamp || nowIso,
                ip: updatedIp,
                version: updatedVer,
                os: updatedOs
            });

            if (p.metrics) {
                metricsToInsert.push({
                    monitorId: item.monitorId,
                    timestamp: item.timestamp || nowIso,
                    metricsJson: JSON.stringify(p.metrics)
                });
            }
        }

        // Execute batch database updates (Cross-database compatible for SQLite, PostgreSQL, MariaDB, MSSQL)
        for (const u of monitorUpdates.values()) {
            db.queueRun(
                "UPDATE monitors SET lastSeen = ?, status = 'online', ip = ?, version = ?, os = ? WHERE id = ?",
                [u.lastSeen, u.ip, u.version, u.os, u.id]
            );
        }

        // Insert metrics in batch
        if (metricsToInsert.length > 0) {
            for (const met of metricsToInsert) {
                db.queueRun(
                    "INSERT INTO metrics (monitorId, timestamp, metrics) VALUES (?,?,?)",
                    [met.monitorId, met.timestamp, met.metricsJson]
                );
            }
        }

        // Immediately flush batch write buffer to database
        await db.flushWriteBuffer();

        // Asynchronously dispatch WebSocket & Alert evaluation
        setImmediate(() => {
            for (const item of batch) {
                try {
                    if (global.scoutAlertEngine) {
                        global.scoutAlertEngine.evaluateReport(item.monitor, item.payload);
                    } else {
                        broadcastEvent(WS_EVENTS.SCOUT_REPORT, { monitorId: item.monitorId, data: item.payload });
                    }
                } catch (err) {
                    // non-fatal
                }
            }
        });

    } catch (err) {
        console.error('[Ingestion] Error flushing telemetry batch:', err);
    } finally {
        isFlushing = false;
    }
}

// Micro-batch flush every 500ms
setInterval(flushTelemetryBatch, 500).unref();

module.exports = {
    processAgentReportFast,
    flushTelemetryBatch,
    invalidateCache,
    invalidateConfigs,
    buildDynamicConfig,
    notifyDeletedAgentReporting,
    isAgentOnDeletedServer,
    _resetDeletedAgentNotices: () => { deletedAgentNotices.clear(); deletedCheckCache.clear(); }
};
