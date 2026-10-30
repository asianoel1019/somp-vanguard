const crypto = require('crypto');
const { broadcastEvent } = require('../lib/websocket');
const { WS_EVENTS } = require('../constants/wsEvents');
const mailer = require('../lib/mailer');
const logger = require('../lib/logger');
const store = require('./alertPolicyStore');
const webhookService = require('./webhookService');
const db = require('./scoutDb');
const { evaluateCheck } = require('./alertRuleEval');
const { buildRuleScope, loadExclusions, applicableRuleIds, applicabilityFor } = require('./ruleScope');
const { getConfig } = require('./alertQualityConfig');
const { decide } = require('./alertPolicy');

// SQLite engine only: db.get/all/run are synchronous in the SQLite driver.

let pollerInterval = null;
let cleanupInterval = null;
let cleanupTimeout = null;
let ENGINE_START_TIME = 0;

const RULE_CACHE_MS = 30000;
const RULE_CACHE_EMPTY_MS = 5000;
let ruleCache = null;
let ruleCacheAt = 0;
function getRuleContext(nowMs = Date.now()) {
    if (ruleCache && nowMs - ruleCacheAt < RULE_CACHE_MS) return ruleCache;
    const rules = db.all('SELECT * FROM rules');
    // Bindings + exclusions are loaded once per cache period (never per monitor); see ruleScope.js
    const scope = buildRuleScope(db.all('SELECT * FROM rule_bindings'), loadExclusions(db));
    ruleCache = {
        rulesById: new Map(rules.map(r => [r.id, r])),
        logRules: rules.filter(r => r.type === 'winevent' || r.type === 'syslog' || r.category === 'log'),
        index: scope.index,
        exclusions: scope.exclusions,
        boundRuleIds: scope.boundRuleIds,
    };
    // db.all swallows read errors and returns []; keep an empty result only briefly so a transient failure cannot silence alerting
    ruleCacheAt = rules.length === 0 ? nowMs - (RULE_CACHE_MS - RULE_CACHE_EMPTY_MS) : nowMs;
    return ruleCache;
}
function invalidateRuleCache() { ruleCache = null; ruleCacheAt = 0; }

// Throttle high-frequency telemetry WS broadcast (at most once every 15s per monitor)
const reportBroadcastCooldownMap = new Map();
const REPORT_BROADCAST_INTERVAL_MS = 15000;

// Helper to parse JSON
function parseJSON(val, def) {
    if (!val) return def;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch(e) { return def; }
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function triggerAction(monitor, check, value, isRecovery = false, note = '') {
    const statusText = isRecovery ? '🟢 RECOVERED' : '🔴 ALERT';
    const checkTarget = check.target ? ` (${check.target})` : '';
    const subject = `[Scout Monitor] ${statusText}: ${monitor.name} - ${check.type}${checkTarget}`;
    const subjectHtml = escHtml(subject);

    const html = `
        <h2 style="color: ${isRecovery ? '#3fb950' : '#f78166'}">${subjectHtml}</h2>
        ${note ? `<p><strong>${escHtml(note)}</strong></p>` : ''}
        <p><strong>Host:</strong> ${escHtml(monitor.name)} (${escHtml(monitor.ip)})</p>
        <p><strong>Check Type:</strong> ${escHtml(check.type)}</p>
        ${check.target ? `<p><strong>Target:</strong> ${escHtml(check.target)}</p>` : ''}
        <p><strong>Value:</strong> ${escHtml(value)}</p>
        <p><strong>Threshold:</strong> ${escHtml(check.threshold)}</p>
        <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
    `;

    const mdText = (note ? `${note}\n` : '') + `*${subject}*\n` +
                   `🖥️ Host: ${monitor.name} (${monitor.ip})\n` +
                   `🔍 Type: ${check.type}${checkTarget}\n` +
                   `📊 Value: ${value}\n` +
                   `⚙️ Threshold: ${check.threshold}\n` +
                   `🕒 Time: ${new Date().toLocaleString()}`;

    const actions = parseJSON(check.actions, []);
    for (const action of actions) {
        try {
            if (action.type === 'mail') {
                await mailer.sendMail({
                    subject: subject,
                    html: html,
                    to: action.to // If empty, it falls back to default
                });
            } else if (action.type === 'telegram') {
                await logger.sendTelegramAlert(mdText, 'ScoutMonitor');
            } else if (action.type === 'webhook') {
                const webhookPayloadParams = {
                    message: mdText,
                    module: 'ScoutMonitor',
                    category: isRecovery ? 'Recovery' : 'Alert',
                    host: monitor.name,
                    ip: monitor.ip,
                    checkType: check.type,
                    target: check.target || '',
                    value: String(value),
                    threshold: String(check.threshold || ''),
                    timestamp: new Date().toISOString()
                };
                if (action.webhookId && action.webhookId !== 'all') {
                    const webhooks = webhookService.loadWebhooks();
                    const targetWh = webhooks.find(w => w.id === action.webhookId);
                    if (targetWh) {
                        await webhookService.executeWebhook(targetWh, webhookPayloadParams);
                    } else {
                        await webhookService.triggerWebhooks(mdText, 'ScoutMonitor', isRecovery ? 'Recovery' : 'Alert');
                    }
                } else {
                    await webhookService.triggerWebhooks(mdText, 'ScoutMonitor', isRecovery ? 'Recovery' : 'Alert');
                }
            }
        } catch (e) {
            console.error(`[ScoutEngine] Action failed for check ${check.id}:`, e.message);
        }
    }
}

function digestLineFor(monitor, check, value) {
    return `${monitor.name} (${monitor.ip}) ${check.type}${check.target ? ` ${check.target}` : ''} ${value}`;
}

function sendNotice(message) {
    Promise.resolve(logger.sendTelegramAlert(message, 'ScoutMonitor')).catch(e => console.error('[AlertPolicy] notice failed:', e.message));
}

function flapNotice(monitor, check) {
    const cfg = getConfig();
    return `〰️ [Scout Monitor] 告警不穩定，暫停通知\n🖥️ ${monitor.name} (${monitor.ip}) - ${check.type}${check.target ? ` (${check.target})` : ''}\n${cfg.flapping.windowMin} 分鐘內狀態切換 ${cfg.flapping.transitions} 次以上；穩定 ${cfg.flapping.stableMin} 分鐘後恢復通知`;
}

/** Flap-start notice; counts against the per-minute rate limit and overflows into the digest (spec §4.2). */
function sendFlapNotice(monitor, check, now) {
    const cfg = getConfig(now.getTime());
    if (store.bumpRate(store.minuteBucket(now)) > cfg.rateLimitPerMinute) {
        store.addDigest(`〰️ 告警不穩定，暫停通知 ${monitor.name} (${monitor.ip}) ${check.type}${check.target ? ` ${check.target}` : ''}`, now.toISOString());
        return;
    }
    sendNotice(flapNotice(monitor, check));
}

/** A rule's actions as an array; invalid or non-array JSON counts as no actions. */
function parseActions(val) {
    const a = parseJSON(val, []);
    return Array.isArray(a) ? a : [];
}

/** Runs the policy for one event and performs the resulting notification(s). */
function notifyAlert({ monitor, check, value, kind, alertId = null, isTransition, wantsNotify = true, now = new Date() }) {
    // A rule without actions is dashboard-only: it must not use the rate budget, feed the digest or send flap notices
    const silent = parseActions(check.actions).length === 0;
    const want = wantsNotify && !silent;
    let d;
    try {
        d = decide({ monitor, rule: check, kind, now, isTransition, wantsNotify: want, digestLine: digestLineFor(monitor, check, value) });
    } catch (e) {
        console.error('[AlertPolicy] decide failed, falling back to notify:', e.message);
        d = { notify: want, suppressedReason: null, flapStarted: false };
    }
    try {
        if (alertId && d.suppressedReason) {
            db.run('UPDATE alerts SET suppressedReason = ? WHERE id = ?', [d.suppressedReason, alertId]);
        }
        if (d.flapStarted && !silent) sendFlapNotice(monitor, check, now);
    } catch (e) {
        console.error('[AlertPolicy] post-decision bookkeeping failed:', e.message);
    }
    if (d.notify) triggerAction(monitor, check, value, kind === 'recovery');
    return d;
}

/** Deletes resolved alerts older than 7 days in small batches so a large backlog never holds a long write lock. Returns the number deleted. */
async function cleanupOldAlerts(now = new Date(), { batchSize = 2000 } = {}) {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let total = 0;
    for (;;) {
        const res = db.run('DELETE FROM alerts WHERE rowid IN (SELECT rowid FROM alerts WHERE resolved = 1 AND resolvedAt < ? LIMIT ?)', [sevenDaysAgo, batchSize]);
        const deleted = (res && res.changes) || 0;
        total += deleted;
        if (deleted < batchSize) break;
        await new Promise(r => setImmediate(r));
    }
    return total;
}

/**
 * Stale alert_state rows left as 'alerting' (from when evaluation last ran) with NO alert row at all for that monitor+rule
 * would later produce "RECOVERED" notifications for alerts nobody saw. Silently reset them. Rows whose alert exists but is
 * resolved (acknowledged by an operator) are kept: the condition may still be breaching and must not re-alert.
 * Idempotent. Key format is `${monitorId}-${ruleId}` (ids may contain '-'), so keys are compared as built strings, not split.
 */
function reconcileAlertState() {
    // Startup only: partial hit counts from before the restart are stale; counting simply restarts
    db.run("UPDATE alert_state SET hitCount = 0 WHERE status = 'ok' AND hitCount > 0");
    // Read alerting states FIRST, then alert keys: an alert inserted between the two reads is then still seen
    const alerting = db.all("SELECT stateKey FROM alert_state WHERE status = 'alerting'");
    const have = new Set(db.all('SELECT DISTINCT monitorId, checkId FROM alerts').map(r => `${r.monitorId}-${r.checkId}`));
    const stale = alerting.filter(r => !have.has(r.stateKey));
    if (stale.length === 0) return 0;
    db.exec('BEGIN');
    try {
        for (const row of stale) db.run("UPDATE alert_state SET status = 'ok', hitCount = 0 WHERE stateKey = ?", [row.stateKey]);
        db.exec('COMMIT');
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch (e2) {}
        throw e;
    }
    console.log(`[ScoutEngine] Reconciled ${stale.length} stale alert_state row(s) with no alert record.`);
    return stale.length;
}

function evaluateReport(monitor, payload, now = new Date()) {
    // Throttled broadcast of high-frequency report (at most once every 15s per monitor); runs even when evaluation is disabled
    const lastBc = reportBroadcastCooldownMap.get(monitor.id) || 0;
    if (Date.now() - lastBc >= REPORT_BROADCAST_INTERVAL_MS) {
        reportBroadcastCooldownMap.set(monitor.id, Date.now());
        broadcastEvent(WS_EVENTS.SCOUT_REPORT, { monitorId: monitor.id, data: payload, timestamp: new Date().toISOString() });
    }

    if (!getConfig(now.getTime()).evaluationEnabled) return;

    const ctx = getRuleContext(now.getTime());
    for (const ruleId of applicableRuleIds(monitor, ctx.index, ctx.exclusions, { includeGlobal: false })) {
        const check = ctx.rulesById.get(ruleId);
        if (!check) continue; // Rule deleted
        const r = evaluateCheck(check, payload.metrics);
        if (!r) continue;
        const exceeded = r.exceeded;
        const val = r.value;

        const stateKey = `${monitor.id}-${check.id}`;

        if (exceeded) {
            // Atomic UPSERT increment to prevent read-modify-write race conditions when reports arrive concurrently
            db.run(`
                INSERT INTO alert_state (stateKey, hitCount, status)
                VALUES (?, 1, 'ok')
                ON CONFLICT(stateKey) DO UPDATE SET hitCount = hitCount + 1
                WHERE status != 'alerting'
            `, [stateKey]);

            let state = db.get("SELECT * FROM alert_state WHERE stateKey = ?", [stateKey]);

            if (state && state.status !== 'alerting') {
                if (state.hitCount >= (check.alertHits || 3)) {
                    state.status = 'alerting';
                    // Insert the alert row BEFORE marking the state 'alerting' so a concurrent reconcileAlertState never sees an alerting state without an alert
                    const newAlertId = crypto.randomUUID();
                    db.run(`INSERT INTO alerts (id, monitorId, checkId, ruleName, type, target, value, threshold, triggeredAt, resolved, resolvedAt)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                            [newAlertId, monitor.id, check.id, check.name, check.type, check.target, String(val), check.type === 'process' ? `Status/CPU/Mem` : check.threshold, now.toISOString(), 0, null]);
                    db.run("UPDATE alert_state SET status = 'alerting' WHERE stateKey = ?", [stateKey]);

                    notifyAlert({ monitor, check, value: val, kind: 'trigger', alertId: newAlertId, isTransition: true, now });
                }
            }
        } else {
            // Recovered
            const state = db.get("SELECT * FROM alert_state WHERE stateKey = ?", [stateKey]);
            if (state) {
                if (state.hitCount > 0) {
                    state.hitCount = 0;
                    db.run("UPDATE alert_state SET hitCount = 0 WHERE stateKey = ?", [stateKey]);
                }
                if (state.status === 'alerting') {
                    state.status = 'ok';
                    db.run("UPDATE alert_state SET status = 'ok' WHERE stateKey = ?", [stateKey]);

                    // Resolve active alerts
                    db.run("UPDATE alerts SET resolved = 1, resolvedAt = ? WHERE checkId = ? AND monitorId = ? AND resolved = 0",
                            [now.toISOString(), check.id, monitor.id]);

                    notifyAlert({ monitor, check, value: val, kind: 'recovery', isTransition: true, wantsNotify: check.recoveryNotify === 1, now });
                }
            }
        }
    }
}

/**
 * Whether a log rule evaluates events of this log type. winevent and syslog rules are both stored with
 * category 'log', so the category alone must not cross-match; only legacy generic log rules (category 'log'
 * with a type that is neither winevent nor syslog) apply to every log type.
 */
function appliesToLogType(rule, logType) {
    if (rule.type === logType) return true;
    return rule.category === 'log' && rule.type !== 'winevent' && rule.type !== 'syslog';
}

async function evaluateLogEvents(monitor, logType, eventItem, now = new Date()) {
    if (!eventItem) return;
    try {
        // Resolve monitor if only hostname was passed
        let mon = monitor;
        if (!mon || typeof mon === 'string') {
            const h = mon || eventItem.host || eventItem.computer;
            mon = db.get("SELECT * FROM monitors WHERE LOWER(name) = LOWER(?) OR ip = ?", [h, h]) || {
                id: h || 'unknown-host',
                name: h || 'unknown-host',
                ip: eventItem.ip || h || '127.0.0.1'
            };
        }

        if (!getConfig(now.getTime()).evaluationEnabled) return;

        const ctx = getRuleContext(now.getTime());
        const allLogRules = ctx.logRules.filter(r => appliesToLogType(r, logType));
        if (allLogRules.length === 0) return;
        // Rules with bindings must be bound to this monitor; rules without any binding apply globally; exclusions always win
        const applies = applicabilityFor(mon, ctx.index, ctx.exclusions, { includeGlobal: true, unboundApplies: true, boundRuleIds: ctx.boundRuleIds });

        for (const rule of allLogRules) {
            if (!applies(rule.id)) continue;

            let logCfg = parseJSON(rule.logConfig, {});
            // Fallback parsing if logConfig was empty but target had data
            if (!logCfg.channel && !logCfg.eventID && rule.target) {
                if (rule.target.startsWith('{')) {
                    logCfg = parseJSON(rule.target, {});
                } else if (logType === 'winevent') {
                    logCfg.eventID = rule.target;
                } else if (logType === 'syslog') {
                    logCfg.logPath = rule.target;
                }
            }

            let matched = false;
            let matchReason = '';

            if (logType === 'winevent' && appliesToLogType(rule, 'winevent')) {
                // Windows Event check
                const channel = (eventItem.logName || eventItem.channel || '').toLowerCase();
                const reqChannel = (logCfg.channel || '').trim().toLowerCase();
                if (reqChannel && reqChannel !== '*' && reqChannel !== 'all' && channel !== reqChannel) {
                    continue;
                }

                // Event ID check
                const evId = String(eventItem.eventID || '').trim();
                const reqEvIds = logCfg.eventID ? String(logCfg.eventID).split(',').map(s => s.trim()).filter(Boolean) : [];
                if (reqEvIds.length > 0) {
                    if (!reqEvIds.includes(evId) && !reqEvIds.includes('*')) {
                        continue;
                    }
                }

                // Level check
                const evLevel = String(eventItem.level || '').trim().toLowerCase();
                const reqLevel = String(logCfg.level || '').trim().toLowerCase();
                if (reqLevel && reqLevel !== 'all' && reqLevel !== '*') {
                    if (reqLevel === 'critical' && evLevel !== 'critical' && evLevel !== '1') continue;
                    if (reqLevel === 'error' && !['critical', 'error', '1', '2'].includes(evLevel)) continue;
                    if (reqLevel === 'warning' && !['critical', 'error', 'warning', '1', '2', '3'].includes(evLevel)) continue;
                    if (reqLevel === 'information' && !['critical', 'error', 'warning', 'information', '0', '1', '2', '3', '4', ''].includes(evLevel)) continue;
                }

                // Exclude users check
                if (logCfg.excludeUsers) {
                    const exUsers = String(logCfg.excludeUsers).split(',').map(u => u.trim().toLowerCase()).filter(Boolean);
                    const userFields = [eventItem.user, eventItem.targetUser, eventItem.subjectUser].filter(Boolean).join(' ');
                    const rawCombined = String((eventItem.message || '') + ' ' + (eventItem.raw || '') + ' ' + userFields).toLowerCase();
                    let isExcluded = false;
                    for (const exU of exUsers) {
                        const cleanU = exU.includes('\\') ? exU.split('\\').pop() : exU;
                        if (rawCombined.includes(exU) || rawCombined.includes(cleanU)) {
                            isExcluded = true;
                            break;
                        }
                    }
                    if (isExcluded) continue;
                }

                // Keyword / Pattern check
                if (logCfg.keyword && logCfg.keyword.trim()) {
                    const kw = logCfg.keyword.trim();
                    const msg = String(eventItem.message || '') + ' ' + String(eventItem.raw || '');
                    let isKwMatch = false;
                    try {
                        const re = new RegExp(kw, 'i');
                        isKwMatch = re.test(msg);
                    } catch (e) {
                        isKwMatch = msg.toLowerCase().includes(kw.toLowerCase());
                    }
                    if (!isKwMatch) continue;
                }

                matched = true;
                matchReason = `Windows Event ${evId} [${eventItem.logName || 'Security'}]: ${eventItem.message ? eventItem.message.substring(0, 100) : 'Event matched'}`;
            } else if (logType === 'syslog' && appliesToLogType(rule, 'syslog')) {
                // Linux Syslog / Log check
                const filePath = String(eventItem.filePath || (eventItem.log && eventItem.log.file && eventItem.log.file.path) || '').toLowerCase();
                const reqPath = String(logCfg.logPath || '').trim().toLowerCase();
                if (reqPath && reqPath !== '*' && reqPath !== 'all') {
                    if (!filePath.includes(reqPath)) continue;
                }

                // Severity check
                const evSev = String(eventItem.level || eventItem.format || '').toLowerCase();
                const reqSev = String(logCfg.severity || '').trim().toLowerCase();
                if (reqSev && reqSev !== 'all' && reqSev !== '*') {
                    if (!evSev.includes(reqSev)) continue;
                }

                // Keyword check
                if (logCfg.keyword && logCfg.keyword.trim()) {
                    const kw = logCfg.keyword.trim();
                    const msg = String(eventItem.message || '') + ' ' + String(eventItem.raw || '');
                    let isKwMatch = false;
                    try {
                        const re = new RegExp(kw, 'i');
                        isKwMatch = re.test(msg);
                    } catch (e) {
                        isKwMatch = msg.toLowerCase().includes(kw.toLowerCase());
                    }
                    if (!isKwMatch) continue;
                }

                matched = true;
                matchReason = `Linux Log [${eventItem.filePath || 'Syslog'}]: ${eventItem.message ? eventItem.message.substring(0, 100) : 'Pattern matched'}`;
            }

            if (matched) {
                const stateKey = `log-${mon.id}-${rule.id}`;
                const reqHits = rule.alertHits || 1;

                db.run(`
                    INSERT INTO alert_state (stateKey, hitCount, status)
                    VALUES (?, 1, 'ok')
                    ON CONFLICT(stateKey) DO UPDATE SET hitCount = hitCount + 1
                `, [stateKey]);

                const state = db.get("SELECT * FROM alert_state WHERE stateKey = ?", [stateKey]);
                if (state && state.hitCount >= reqHits) {
                    const triggerTarget = rule.type === 'winevent'
                        ? `EventID: ${eventItem.eventID || '-'} (${eventItem.logName || 'Security'})`
                        : (eventItem.filePath || 'Syslog');

                    const existing = db.get('SELECT id, occurrences FROM alerts WHERE monitorId = ? AND checkId = ? AND resolved = 0 ORDER BY triggeredAt DESC LIMIT 1', [mon.id, rule.id]);
                    let alertId;
                    if (existing) {
                        alertId = existing.id;
                        db.run('UPDATE alerts SET occurrences = COALESCE(occurrences, 1) + 1, value = ? WHERE id = ?', [matchReason, existing.id]);
                    } else {
                        alertId = crypto.randomUUID();
                        db.run(`INSERT INTO alerts (id, monitorId, checkId, ruleName, type, target, value, threshold, triggeredAt, resolved, resolvedAt, occurrences)
                                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                                [alertId, mon.id, rule.id, rule.name, rule.type, triggerTarget, matchReason, reqHits, now.toISOString(), 0, null, 1]);
                    }

                    // Reset hit count after alert trigger
                    db.run("UPDATE alert_state SET hitCount = 0 WHERE stateKey = ?", [stateKey]);

                    // Send notifications (Email / Telegram / Webhook) through the notification policy
                    notifyAlert({ monitor: mon, check: rule, value: matchReason, kind: 'log', alertId: existing ? null : alertId, isTransition: false, now });

                    // Broadcast WS alert event (only for a newly created alert)
                    if (!existing) {
                        try {
                            broadcastEvent(WS_EVENTS.ALERT_TRIGGERED, {
                                id: alertId,
                                monitorId: mon.id,
                                monitorName: mon.name,
                                ruleName: rule.name,
                                type: rule.type,
                                target: triggerTarget,
                                value: matchReason,
                                triggeredAt: now.toISOString()
                            });
                        } catch (err) {}
                    }
                }
            }
        }
    } catch (e) {
        console.error('[ScoutAlertEngine] Error evaluating log event:', e);
    }
}

function checkDeadAgents(now = new Date()) {
    const monitors = db.all("SELECT * FROM monitors WHERE enabled = 1");
    // Loaded once per cycle (fresh every 15 s in the worker, no cache): inclusion bindings + exclusions
    const scope = buildRuleScope(db.all("SELECT * FROM rule_bindings"), loadExclusions(db));
    const allRules = db.all("SELECT * FROM rules");
    const ruleMap = new Map();
    allRules.forEach(r => ruleMap.set(r.id, r));

    // 使用 OS 本地時間（Date 物件）以避免 Windows 時區跨日與時差 Bug (符合 sys-op-manager 規範 #6)
    const nowMs = now.getTime();
    const enabled = getConfig(nowMs).evaluationEnabled;

    // GRACE PERIOD (3 minutes): 
    // Do not alert if the backend engine just started within the last 3 minutes,
    // to prevent false positives for agents whose heartbeats were missed while the backend was down.
    if (nowMs - ENGINE_START_TIME < 3 * 60 * 1000) {
        return;
    }

    monitors.forEach(monitor => {
        if (!monitor.lastSeen) return;

        const last = new Date(monitor.lastSeen);
        const lastMs = last.getTime();
        
        // Offline/connectivity rules applying to this monitor (shared helper: bindings minus exclusions)
        const applicableOfflineRules = applicableRuleIds(monitor, scope.index, scope.exclusions, { includeGlobal: false })
            .map(id => ruleMap.get(id))
            .filter(r => r && (r.type === 'offline' || r.type === 'connectivity'));

        // Determine offline threshold
        let alertRule = null;
        let offlineThresholdSec = 300; // Default 5 minutes (300s) buffer

        if (applicableOfflineRules.length > 0) {
            // User explicitly created and applied an Offline Rule Template
            alertRule = applicableOfflineRules[0];
            const ruleThreshold = parseFloat(alertRule.threshold);
            if (!isNaN(ruleThreshold) && ruleThreshold > 0) {
                // If threshold is >= 10, treat as seconds; otherwise treat as minutes
                offlineThresholdSec = ruleThreshold >= 10 ? ruleThreshold : ruleThreshold * 60;
            }
        } else {
            // No rule applied: fallback threshold for UI dashboard display only (at least 5m or 3x reportInterval)
            offlineThresholdSec = Math.max(300, (monitor.reportInterval || 60) * 3);
        }

        const offlineThresholdMs = offlineThresholdSec * 1000;

        if (nowMs - lastMs > offlineThresholdMs) {
            if (monitor.status !== 'offline') {
                db.run("UPDATE monitors SET status = 'offline' WHERE id = ?", [monitor.id]);
                
                // Only send alert notification if user has an active offline rule template applied!
                if (alertRule && enabled) {
                    const thresholdDisplay = offlineThresholdSec >= 60 ? `${Math.round(offlineThresholdSec / 60)}m (${offlineThresholdSec}s)` : `${offlineThresholdSec}s`;
                    const msg = `🔴 <b>[Scout Monitor] Agent Offline</b>\nHost: ${monitor.name} (${monitor.ip})\nRule: ${alertRule.name}\nThreshold Buffer: ${thresholdDisplay}\nLast Seen: ${new Date(monitor.lastSeen).toLocaleString()}`;

                    // Alerts table row, so the Dashboard sees it too (inserted before sending so suppression can be recorded)
                    const newAlertId = crypto.randomUUID();
                    db.run(`INSERT INTO alerts (id, monitorId, checkId, ruleName, type, target, value, threshold, triggeredAt, resolved, resolvedAt)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, 
                            [newAlertId, monitor.id, alertRule.id, alertRule.name, 'offline', 'Heartbeat', 'offline', thresholdDisplay, now.toISOString(), 0, null]);

                    let d;
                    try {
                        d = decide({ monitor, rule: alertRule, kind: 'trigger', now, isTransition: true, digestLine: `${monitor.name} (${monitor.ip}) offline` });
                    } catch (e) {
                        console.error('[AlertPolicy] decide failed, falling back to notify:', e.message);
                        d = { notify: true, suppressedReason: null, flapStarted: false };
                    }
                    try {
                        if (d.suppressedReason) db.run('UPDATE alerts SET suppressedReason = ? WHERE id = ?', [d.suppressedReason, newAlertId]);
                        if (d.flapStarted) sendFlapNotice(monitor, alertRule, now);
                    } catch (e) {
                        console.error('[AlertPolicy] post-decision bookkeeping failed:', e.message);
                    }

                    if (d.notify) {
                    const actions = parseJSON(alertRule.actions, []);
                    if (actions.length === 0) {
                        logger.sendTelegramAlert(msg, 'ScoutMonitor').catch(console.error);
                    } else {
                        for (const action of actions) {
                            if (action.type === 'telegram') {
                                logger.sendTelegramAlert(msg, 'ScoutMonitor').catch(console.error);
                            } else if (action.type === 'mail' && action.to) {
                                mailer.sendMail({
                                    subject: `[Scout Monitor] 🔴 ALERT: ${monitor.name} - Agent Offline`,
                                    html: `<h2>[Scout Monitor] Agent Offline Alert</h2>
                                           <p><strong>Host:</strong> ${escHtml(monitor.name)} (${escHtml(monitor.ip)})</p>
                                           <p><strong>Applied Rule:</strong> ${escHtml(alertRule.name)}</p>
                                           <p><strong>Buffer Threshold:</strong> ${escHtml(thresholdDisplay)}</p>
                                           <p><strong>Last Seen:</strong> ${escHtml(new Date(monitor.lastSeen).toLocaleString())}</p>`,
                                    to: action.to
                                }).catch(console.error);
                            } else if (action.type === 'webhook') {
                                const webhookPayloadParams = {
                                    message: msg,
                                    module: 'ScoutMonitor',
                                    category: 'Alert',
                                    host: monitor.name,
                                    ip: monitor.ip,
                                    checkType: 'offline',
                                    target: 'Heartbeat',
                                    value: 'offline',
                                    threshold: thresholdDisplay,
                                    timestamp: new Date().toISOString()
                                };
                                if (action.webhookId && action.webhookId !== 'all') {
                                    const webhooks = webhookService.loadWebhooks();
                                    const targetWh = webhooks.find(w => w.id === action.webhookId);
                                    if (targetWh) {
                                        webhookService.executeWebhook(targetWh, webhookPayloadParams).catch(console.error);
                                    } else {
                                        webhookService.triggerWebhooks(msg, 'ScoutMonitor', 'Alert').catch(console.error);
                                    }
                                } else {
                                    webhookService.triggerWebhooks(msg, 'ScoutMonitor', 'Alert').catch(console.error);
                                }
                            }
                        }
                    }
                    }
                }

                broadcastEvent(WS_EVENTS.SCOUT_AGENT_OFFLINE, { monitorId: monitor.id, timestamp: new Date().toISOString() });
            }
        } else {
            if (monitor.status === 'offline') {
                db.run("UPDATE monitors SET status = 'online' WHERE id = ?", [monitor.id]);
                
                // Check if there was an active offline alert to send recovery
                const activeOfflineAlert = db.get("SELECT * FROM alerts WHERE type = 'offline' AND monitorId = ? AND resolved = 0", [monitor.id]);
                if (activeOfflineAlert) {   // only an outage that actually alerted gets an "Agent Online" (none exists if evaluation was disabled)
                    const msg = `🟢 <b>[Scout Monitor] Agent Online</b>\nHost: ${monitor.name} (${monitor.ip})\nAgent is back online.`;

                    const ruleForPolicy = alertRule || { id: 'offline', name: 'Agent Offline' };
                    let d = { notify: enabled };
                    if (enabled) {
                        try {
                            d = decide({ monitor, rule: ruleForPolicy, kind: 'recovery', now, isTransition: true, wantsNotify: true });
                        } catch (e) {
                            console.error('[AlertPolicy] decide failed, falling back to notify:', e.message);
                            d = { notify: true };
                        }
                    }

                    if (d.notify) {
                    const actions = alertRule ? parseJSON(alertRule.actions, []) : [];
                    if (actions.length === 0) {
                        logger.sendTelegramAlert(msg, 'ScoutMonitor').catch(console.error);
                    } else {
                        for (const action of actions) {
                            if (action.type === 'telegram') {
                                logger.sendTelegramAlert(msg, 'ScoutMonitor').catch(console.error);
                            } else if (action.type === 'mail' && action.to) {
                                mailer.sendMail({
                                    subject: `[Scout Monitor] 🟢 RECOVERED: ${monitor.name} - Agent Online`,
                                    html: `<h2>[Scout Monitor] Agent Back Online</h2>
                                           <p><strong>Host:</strong> ${escHtml(monitor.name)} (${escHtml(monitor.ip)})</p>
                                           <p>Agent is back online and reporting metrics.</p>
                                           <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>`,
                                    to: action.to
                                }).catch(console.error);
                            } else if (action.type === 'webhook') {
                                const webhookPayloadParams = {
                                    message: msg,
                                    module: 'ScoutMonitor',
                                    category: 'Recovery',
                                    host: monitor.name,
                                    ip: monitor.ip,
                                    checkType: 'offline',
                                    target: 'Heartbeat',
                                    value: 'online',
                                    threshold: 'recovered',
                                    timestamp: new Date().toISOString()
                                };
                                if (action.webhookId && action.webhookId !== 'all') {
                                    const webhooks = webhookService.loadWebhooks();
                                    const targetWh = webhooks.find(w => w.id === action.webhookId);
                                    if (targetWh) {
                                        webhookService.executeWebhook(targetWh, webhookPayloadParams).catch(console.error);
                                    } else {
                                        webhookService.triggerWebhooks(msg, 'ScoutMonitor', 'Recovery').catch(console.error);
                                    }
                                } else {
                                    webhookService.triggerWebhooks(msg, 'ScoutMonitor', 'Recovery').catch(console.error);
                                }
                            }
                        }
                    }
                    }

                    // 將該 Agent 的 offline 告警設為已解決
                    db.run("UPDATE alerts SET resolved = 1, resolvedAt = ? WHERE type = 'offline' AND monitorId = ? AND resolved = 0", 
                            [now.toISOString(), monitor.id]);
                }
                
                try {
                    broadcastEvent(WS_EVENTS.SCOUT_AGENT_ONLINE, { monitorId: monitor.id, timestamp: new Date().toISOString() });
                } catch (err) {}
            }
        }
    });
}

function registerEvaluator() {
    try { reconcileAlertState(); } catch (e) { console.error('[ScoutEngine] reconcileAlertState failed:', e.message); }
    global.scoutAlertEngine = { evaluateReport, evaluateLogEvents };
}

function initScoutAlertEngine() {
    console.log('[ScoutEngine] Initializing Scout Alert Engine (SQLite Version)...');
    ENGINE_START_TIME = new Date().getTime();
    registerEvaluator();

    if (pollerInterval) clearInterval(pollerInterval);
    pollerInterval = setInterval(() => {
        try { checkDeadAgents(); } catch (e) { console.error('[ScoutEngine] checkDeadAgents failed:', e.message); }
    }, 15000); // Check every 15s

    // Old resolved alerts are no longer cleaned on every report; purge in batches in the worker.
    // First run is delayed 2 minutes so a large backlog does not compete with startup, then hourly.
    if (cleanupTimeout) clearTimeout(cleanupTimeout);
    if (cleanupInterval) clearInterval(cleanupInterval);
    const runCleanup = () => { cleanupOldAlerts().catch(console.error); };
    cleanupTimeout = setTimeout(runCleanup, 2 * 60 * 1000);
    cleanupTimeout.unref();
    cleanupInterval = setInterval(runCleanup, 60 * 60 * 1000);
    cleanupInterval.unref();
}

module.exports = { initScoutAlertEngine, registerEvaluator, evaluateReport, evaluateLogEvents, checkDeadAgents, cleanupOldAlerts, reconcileAlertState, invalidateRuleCache, triggerAction, notifyAlert };
