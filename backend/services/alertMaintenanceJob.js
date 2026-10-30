/**
 * Worker job (every 60 s): excluded-pair reconcile, digest flush, escalation, maintenance-end follow-ups, flapping release,
 * rate-bucket pruning. All state is in scout.sqlite; safe to run while the web process evaluates alerts.
 * (Old-alert cleanup is scheduled separately by initScoutAlertEngine.)
 */
const db = require('./scoutDb');
const logger = require('../lib/logger');
const mailer = require('../lib/mailer');
const webhookService = require('./webhookService');
const { getConfig } = require('./alertQualityConfig');
const { findActiveWindow } = require('./maintenanceWindows');
const store = require('./alertPolicyStore');
const { safeSlice } = require('../lib/textUtil');
const ruleExclusions = require('./ruleExclusions');
const { loadExclusions, buildExclusionIndex, excludedRuleIds } = require('./ruleScope');

const MIN = 60000;
let timer = null;
let running = false;

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hhmm = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function activeAlertsWithContext(where, params = []) {
    return db.all(`SELECT a.*, m.name AS hostName, m.ip AS hostIp, m.tags AS hostTags, m.envId AS hostEnv, r.escalateAfterMin AS escalateAfterMin
                   FROM alerts a LEFT JOIN monitors m ON a.monitorId = m.id LEFT JOIN rules r ON a.checkId = r.id
                   WHERE a.resolved = 0 AND ${where}`, params);
}
const monitorOf = (a) => ({ id: a.monitorId, name: a.hostName || a.monitorId, ip: a.hostIp || '', tags: a.hostTags, envId: a.hostEnv });

/** Exclusion check for this run (exclusions loaded once): an excluded (rule, monitor) pair never escalates / follows up / notifies. */
function exclusionCheck() {
    const rows = loadExclusions(db);
    if (rows.length === 0) return () => false;
    const idx = buildExclusionIndex(rows);
    return (monitor, ruleId) => excludedRuleIds(idx, monitor).has(ruleId);
}

const DIGEST_MAX_LINES = 20;
// Telegram text goes in a GET query string (CJK URL-encodes ~9x): keep the whole digest <= 1500 chars
const DIGEST_MAX_CHARS = 1500;
const DIGEST_SUFFIX_RESERVE = 30;   // room for the "... 及其他 N 筆" tail
const DIGEST_LINE_CHARS = 120;
const ESCALATION_MAX_AGE_EXTRA_MIN = 1440;
const ESCALATION_MAX_PER_RUN = 10;
const PRUNE_INTERVAL_MS = 60 * MIN;
const PRUNE_KEEP_MS = 7 * 24 * 60 * MIN;
let lastPruneAt = 0;

async function flushDigest(now) {
    const minuteStart = new Date(now); minuteStart.setSeconds(0, 0);
    const rows = store.takeDigestRows(minuteStart.toISOString());
    if (!rows.length) return 0;
    const lines = rows.map(r => r.line);
    const oldest = rows.reduce((m, r) => { const t = Date.parse(r.createdAt); return Number.isFinite(t) && t < m ? t : m; }, Infinity);
    const ageMs = Number.isFinite(oldest) ? now.getTime() - oldest : 0;
    let text = ageMs > 2 * MIN
        ? `📦 [Scout Monitor] 告警摘要（過去 ${Math.ceil(ageMs / MIN)} 分鐘累積 ${lines.length} 則，超過速率上限）`
        : `📦 [Scout Monitor] 告警摘要（過去 1 分鐘另有 ${lines.length} 則，超過速率上限）`;
    let shown = 0;
    for (const l of lines) {
        if (shown >= DIGEST_MAX_LINES) break;
        const row = `
• ${safeSlice(l, DIGEST_LINE_CHARS)}`;
        if (text.length + row.length > DIGEST_MAX_CHARS - DIGEST_SUFFIX_RESERVE) break;
        text += row;
        shown++;
    }
    if (shown < lines.length) text += `
... 及其他 ${lines.length - shown} 筆`;
    await logger.sendTelegramAlert(text, 'ScoutMonitor');
    return lines.length;
}

/** Enabled escalation destinations, resolved once per run. */
function resolveDestinations(cfg) {
    const e = cfg.escalation;
    const dest = {};
    if (e.telegram.enabled && e.telegram.chatId) dest.telegram = e.telegram.chatId;
    if (e.email.enabled && e.email.to) dest.email = e.email.to;
    if (e.webhook.enabled && e.webhook.webhookId) {
        const wh = webhookService.loadWebhooks().find(w => w.id === e.webhook.webhookId);
        if (wh) dest.webhook = wh;
    }
    return dest;
}

async function deliver(dest, message, subject, payload) {
    const tasks = [];
    if (dest.telegram) tasks.push(logger.sendTelegramToChat(dest.telegram, message));
    if (dest.email) tasks.push(mailer.sendMail({ subject, html: `<pre>${escapeHtml(message)}</pre>`, to: dest.email }));
    if (dest.webhook) tasks.push(webhookService.executeWebhook(dest.webhook, { message, module: 'ScoutMonitor', category: 'Escalation', ...payload }));
    const results = await Promise.allSettled(tasks);
    results.filter(r => r.status === 'rejected').forEach(r => console.error('[AlertJob] escalation delivery failed:', r.reason && r.reason.message));
}

async function sendEscalation(a, dest, now) {
    const minutes = Math.round((now.getTime() - Date.parse(a.triggeredAt)) / MIN);
    const message = `⏫ [Scout Monitor] 告警未處理已 ${minutes} 分鐘（升級通知）
🖥️ ${a.hostName || a.monitorId} (${a.hostIp || ''})  🔍 ${a.type}${a.target ? ` (${a.target})` : ''}  📊 ${a.value}  ⚙️ 門檻 ${a.threshold}
🕒 觸發於 ${hhmm(a.triggeredAt)}`;
    await deliver(dest, message, `[Scout Monitor] ⏫ 升級：${a.hostName || a.monitorId} - ${a.type}`,
        { host: a.hostName || a.monitorId, ip: a.hostIp || '', checkType: a.type, target: a.target || '', value: String(a.value), threshold: String(a.threshold ?? ''), timestamp: now.toISOString() });
}

/** Claim-then-send: the conditional UPDATE makes concurrent runs escalate each alert at most once. */
const claim = (a, now) => db.run('UPDATE alerts SET escalatedAt = ? WHERE id = ? AND escalatedAt IS NULL', [now.toISOString(), a.id]).changes === 1;

async function escalate(now, cfg, isExcluded = () => false) {
    const dest = resolveDestinations(cfg);
    if (!dest.telegram && !dest.email && !dest.webhook) return 0;
    const candidates = activeAlertsWithContext(`a.escalatedAt IS NULL AND r.escalateAfterMin > 0 AND m.enabled = 1
        AND (a.suppressedReason IS NULL OR a.suppressedReason != 'maintenance')`);
    const windows = store.listWindows(now.getTime());
    const eligible = [];
    for (const a of candidates) {
        const triggered = Date.parse(a.triggeredAt);
        if (!Number.isFinite(triggered)) continue;
        const ageMin = (now.getTime() - triggered) / MIN;
        if (ageMin < a.escalateAfterMin || ageMin > a.escalateAfterMin + ESCALATION_MAX_AGE_EXTRA_MIN) continue;
        if (findActiveWindow(windows, monitorOf(a), a.checkId, now)) continue;
        if (isExcluded(monitorOf(a), a.checkId)) continue;
        if (store.getState(store.stateKey(a.monitorId, a.checkId)).flappingSince) continue;
        eligible.push(a);
    }
    let count = 0;
    for (const a of eligible.slice(0, ESCALATION_MAX_PER_RUN)) {
        if (!claim(a, now)) continue;
        count++;
        await sendEscalation(a, dest, now);
    }
    let overflow = 0;
    for (const a of eligible.slice(ESCALATION_MAX_PER_RUN)) {
        if (claim(a, now)) { overflow++; count++; }
    }
    if (overflow > 0) {
        await deliver(dest, `⏫ [Scout Monitor] 另有 ${overflow} 則告警未處理已超過升級時間（請至 Scout Monitor 查看）`,
            '[Scout Monitor] ⏫ 升級摘要', { host: '', ip: '', checkType: '', target: '', value: '', threshold: '', timestamp: now.toISOString() });
    }
    return count;
}

/**
 * The rule to notify with for a maintenance follow-up, or null when no follow-up should be sent:
 * log alerts never auto-resolve (a follow-up would be a false "still abnormal"), and rules without actions are
 * dashboard-only — except offline/connectivity rules, whose empty actions have always meant "telegram".
 */
function ruleForFollowUp(a) {
    const rule = db.get('SELECT * FROM rules WHERE id = ?', [a.checkId]) || { id: a.checkId, type: a.type, target: a.target, threshold: a.threshold, actions: '[]' };
    if (a.type === 'winevent' || a.type === 'syslog' || rule.category === 'log') return null;
    let actions = [];
    try { actions = JSON.parse(rule.actions || '[]'); } catch (e) { actions = []; }
    if (!Array.isArray(actions) || actions.length === 0) {
        const isOffline = rule.type === 'offline' || rule.type === 'connectivity' || a.type === 'offline';
        return isOffline ? { ...rule, actions: '[{"type":"telegram"}]' } : null;
    }
    return rule;
}

async function maintenanceFollowUps(now, cfg, isExcluded = () => false) {
    const engine = require('./scoutAlertEngine');
    const windows = store.listWindows(now.getTime());
    let count = 0;
    for (const a of activeAlertsWithContext("a.suppressedReason = 'maintenance'")) {
        if (findActiveWindow(windows, monitorOf(a), a.checkId, now)) continue;
        db.run("UPDATE alerts SET suppressedReason = NULL WHERE id = ? AND suppressedReason = 'maintenance'", [a.id]);
        count++;
        if (isExcluded(monitorOf(a), a.checkId)) continue;   // host excluded from the rule: no "still abnormal" notice
        const rule = ruleForFollowUp(a);
        if (!rule) continue;
        if (store.bumpRate(store.minuteBucket(now)) > cfg.rateLimitPerMinute) {
            store.addDigest(`${a.hostName || a.monitorId} ${a.type} ${a.value}（維護結束後仍異常）`, now.toISOString());
            continue;
        }
        await engine.triggerAction(monitorOf(a), rule, a.value, false, '🔧 維護結束後仍異常');
    }
    return count;
}

/** Metric/log rules with no notification actions are dashboard-only; offline/connectivity rules default to Telegram. */
function isSilentRule(rule) {
    if (rule.type === 'offline' || rule.type === 'connectivity') return false;
    let actions = [];
    try { actions = JSON.parse(rule.actions || '[]'); } catch (e) { actions = []; }
    return !Array.isArray(actions) || actions.length === 0;
}

async function releaseFlapping(now, cfg, isExcluded = () => false) {
    let count = 0;
    const windows = store.listWindows(now.getTime());
    for (const candidate of store.listFlapping()) {
        // Re-read right before deciding: the web process may have recorded a transition since the snapshot
        const s = store.getState(candidate.stateKey);
        if (!s.flappingSince) continue;
        const last = s.transitions.length ? Date.parse(s.transitions[s.transitions.length - 1]) : 0;
        if (now.getTime() - last < cfg.flapping.stableMin * MIN) continue;
        store.saveState({ ...s, flappingSince: null, transitions: [] });
        count++;
        const [monitorId, ruleId] = s.stateKey.split('|');
        const monRow = db.get('SELECT id, name, ip, tags, envId FROM monitors WHERE id = ?', [monitorId]);
        const mon = monRow || { id: monitorId, name: monitorId, ip: '' };
        if (findActiveWindow(windows, mon, ruleId, now)) continue;   // in maintenance: release silently
        if (isExcluded(mon, ruleId)) continue;                         // excluded from the rule: release silently
        const active = db.get('SELECT 1 AS x FROM alerts WHERE monitorId = ? AND checkId = ? AND resolved = 0', [monitorId, ruleId]);
        const rule = db.get('SELECT name, type, target, actions FROM rules WHERE id = ?', [ruleId]) || { name: ruleId, type: ruleId === 'offline' ? 'offline' : '', target: '', actions: '[]' };
        if (isSilentRule(rule)) continue;   // dashboard-only rule: no start notice was sent, so no release notice either
        const status = active ? '目前仍異常' : '目前正常';
        const target = `${mon.name} (${mon.ip}) - ${rule.type}${rule.target ? ` (${rule.target})` : ''}`;
        if (store.bumpRate(store.minuteBucket(now)) > cfg.rateLimitPerMinute) {
            store.addDigest(`✅ 告警已恢復穩定（${status}）${target}`, now.toISOString());
            continue;
        }
        await logger.sendTelegramAlert(`✅ [Scout Monitor] 告警已恢復穩定，恢復通知（${status}）\n🖥️ ${target}`, 'ScoutMonitor');
    }
    return count;
}

async function runOnce(now = new Date()) {
    const result = { excludedResolved: 0, digestSent: 0, escalated: 0, maintenanceFollowUps: 0, flapsReleased: 0 };
    const cfg = getConfig(now.getTime());
    if (!cfg.evaluationEnabled) return result;
    const step = async (name, fn) => {
        try { result[name] = await fn(); } catch (e) { console.error(`[AlertJob] ${name} failed:`, e.message); }
    };
    // Close open alerts of excluded (rule, monitor) pairs first (e.g. a host that gained an excluded tag later)
    await step('excludedResolved', () => ruleExclusions.reconcileOpenAlerts(now));
    let isExcluded = () => false;
    try { isExcluded = exclusionCheck(); } catch (e) { console.error('[AlertJob] exclusion check failed:', e.message); }
    await step('digestSent', () => flushDigest(now));
    await step('escalated', () => escalate(now, cfg, isExcluded));
    await step('maintenanceFollowUps', () => maintenanceFollowUps(now, cfg, isExcluded));
    await step('flapsReleased', () => releaseFlapping(now, cfg, isExcluded));
    try {
        const hourAgo = new Date(now.getTime() - 60 * MIN);
        store.pruneRate(store.minuteBucket(hourAgo));
        const t = now.getTime();
        // Hourly (a clock that jumped backwards also triggers a prune)
        if (lastPruneAt === 0 || t - lastPruneAt >= PRUNE_INTERVAL_MS || t < lastPruneAt) {
            lastPruneAt = t;
            const cutoff = new Date(t - PRUNE_KEEP_MS).toISOString();
            db.run(`DELETE FROM notify_state WHERE (flappingSince IS NULL) AND COALESCE(lastTriggerNotifiedAt, '') < ?
                    AND COALESCE(lastRecoveryNotifiedAt, '') < ?`, [cutoff, cutoff]);
            const res = db.run("DELETE FROM maintenance_windows WHERE kind = 'once' AND source = 'quick-mute' AND endAt < ?", [cutoff]);
            if (res && res.changes) store.invalidateWindows();
        }
    } catch (e) { console.error('[AlertJob] prune failed:', e.message); }
    return result;
}

function start() {
    stop();
    timer = setInterval(() => {
        if (running) return;
        running = true;
        runOnce().catch(e => console.error('[AlertJob]', e.message)).finally(() => { running = false; });
    }, MIN);
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { runOnce, start, stop };
