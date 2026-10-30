require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const { writeDataSync } = require('../../lib/db');
const cfg = require('../../services/alertQualityConfig');
const store = require('../../services/alertPolicyStore');
const logger = require('../../lib/logger');
const mailer = require('../../lib/mailer');
const webhookService = require('../../services/webhookService');
const job = require('../../services/alertMaintenanceJob');

const T0 = new Date(2026, 9, 14, 10, 0, 0);
const plus = (min) => new Date(T0.getTime() + min * 60000);
let tg, chat, mails, hooks;

test.before(async () => {
    await dbManager.initDB();
    dbManager.run("INSERT INTO monitors (id, name, ip, tags, enabled) VALUES ('m1','WEB-01','10.0.0.1','[]',1)");
    dbManager.run(`INSERT INTO rules (id, name, type, threshold, alertHits, actions, category, escalateAfterMin) VALUES ('r1','CPU','cpu',90,3,'[{"type":"telegram"}]','metric',30)`);
    dbManager.run(`INSERT INTO rules (id, name, type, threshold, alertHits, actions, category) VALUES ('r2','MEM','memory',90,3,'[]','metric')`);
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach((t) => {
    for (const tb of ['alerts', 'alert_state', 'notify_state', 'notify_rate', 'notify_digest', 'maintenance_windows']) dbManager.run(`DELETE FROM ${tb}`);
    store.invalidateWindows();
    writeDataSync(cfg.CONFIG_KEY, { escalation: { telegram: { enabled: true, chatId: '-100123' }, email: { enabled: true, to: 'boss@corp.local' }, webhook: { enabled: true, webhookId: 'wh1' } } });
    cfg.invalidateConfig();
    tg = []; chat = []; mails = []; hooks = [];
    t.mock.method(logger, 'sendTelegramAlert', async (m) => { tg.push(m); });
    t.mock.method(logger, 'sendTelegramToChat', async (id, m) => { chat.push({ id, m }); });
    t.mock.method(mailer, 'sendMail', async (o) => { mails.push(o); });
    t.mock.method(webhookService, 'loadWebhooks', () => [{ id: 'wh1', name: 'pager' }]);
    t.mock.method(webhookService, 'executeWebhook', async (wh, p) => { hooks.push({ wh, p }); });
});

const addAlert = (id, ruleId, triggeredMinAgo, extra = {}) => dbManager.run(
    'INSERT INTO alerts (id, monitorId, checkId, ruleName, type, target, value, threshold, triggeredAt, resolved, suppressedReason, escalatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, extra.monitorId || 'm1', ruleId, ruleId === 'r1' ? 'CPU' : 'MEM', ruleId === 'r1' ? 'cpu' : 'memory', '', '97', 90, plus(-triggeredMinAgo).toISOString(), extra.resolved ?? 0, extra.suppressedReason ?? null, extra.escalatedAt ?? null]);

test('escalates unresolved alerts past escalateAfterMin to every enabled destination, exactly once', async () => {
    addAlert('a1', 'r1', 31);
    addAlert('a2', 'r1', 10);          // too young
    addAlert('a3', 'r2', 120);         // rule has no escalation
    addAlert('a4', 'r1', 60, { resolved: 1 });
    const r = await job.runOnce(T0);
    assert.equal(r.escalated, 1);
    assert.equal(chat.length, 1); assert.equal(chat[0].id, '-100123'); assert.match(chat[0].m, /升級通知/);
    assert.equal(mails.length, 1); assert.equal(mails[0].to, 'boss@corp.local');
    assert.equal(hooks.length, 1); assert.equal(hooks[0].p.category, 'Escalation');
    assert.ok(dbManager.get("SELECT escalatedAt FROM alerts WHERE id='a1'").escalatedAt);
    await job.runOnce(plus(1));
    assert.equal(chat.length, 1, 'not escalated twice');
});

test('no escalation while in maintenance or flapping', async () => {
    addAlert('a1', 'r1', 45);
    dbManager.run(`INSERT INTO maintenance_windows (id, name, kind, startAt, endAt, scopeType, scopeValues, ruleIds, enabled) VALUES ('w','x','once',?,?,'all','[]','[]',1)`, [plus(-5).toISOString(), plus(60).toISOString()]);
    store.invalidateWindows();
    assert.equal((await job.runOnce(T0)).escalated, 0);
    dbManager.run('DELETE FROM maintenance_windows'); store.invalidateWindows();
    store.saveState({ stateKey: store.stateKey('m1', 'r1'), lastTriggerNotifiedAt: null, lastRecoveryNotifiedAt: null, transitions: [plus(-1).toISOString()], flappingSince: plus(-5).toISOString() });
    assert.equal((await job.runOnce(T0)).escalated, 0);
});

test('maintenance end: still-active suppressed alerts get one follow-up notification', async (t) => {
    const engine = require('../../services/scoutAlertEngine');
    const calls = [];
    t.mock.method(engine, 'triggerAction', async (...a) => { calls.push(a); });
    addAlert('a1', 'r1', 90, { suppressedReason: 'maintenance' });
    addAlert('a2', 'r1', 90, { suppressedReason: 'maintenance', resolved: 1 });
    const r = await job.runOnce(T0);
    assert.equal(r.maintenanceFollowUps, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0][4], /維護結束後仍異常/);
    assert.equal(dbManager.get("SELECT suppressedReason FROM alerts WHERE id='a1'").suppressedReason, null);
    assert.equal((await job.runOnce(plus(1))).maintenanceFollowUps, 0);
});

test('digest lines from previous minutes are sent as one summary', async () => {
    for (let i = 0; i < 25; i++) store.addDigest(`host${i} cpu 9${i % 10}`, plus(-2).toISOString());
    store.addDigest('current-minute line', T0.toISOString());
    const r = await job.runOnce(T0);
    assert.equal(r.digestSent, 25);
    assert.equal(tg.length, 1);
    assert.match(tg[0], /告警摘要（過去 1 分鐘另有 25 則/);
    assert.match(tg[0], /及其他 5 筆/);
});

test('flapping is released after stableMin with a status notice if the alert is still active', async () => {
    addAlert('a1', 'r1', 40);
    store.saveState({ stateKey: store.stateKey('m1', 'r1'), lastTriggerNotifiedAt: null, lastRecoveryNotifiedAt: null, transitions: [plus(-31).toISOString()], flappingSince: plus(-40).toISOString() });
    const r = await job.runOnce(T0);
    assert.equal(r.flapsReleased, 1);
    assert.equal(store.getState(store.stateKey('m1', 'r1')).flappingSince, null);
    assert.ok(tg.some(m => /已恢復穩定/.test(m) && /仍異常/.test(m)));
});

test('flapping of a rule without notification actions is released silently', async () => {
    addAlert('a2', 'r2', 40);   // r2 has actions '[]' (dashboard-only rule)
    store.saveState({ stateKey: store.stateKey('m1', 'r2'), lastTriggerNotifiedAt: null, lastRecoveryNotifiedAt: null, transitions: [plus(-31).toISOString()], flappingSince: plus(-40).toISOString() });
    const r = await job.runOnce(T0);
    assert.equal(r.flapsReleased, 1);
    assert.equal(store.getState(store.stateKey('m1', 'r2')).flappingSince, null);
    assert.equal(tg.filter(m => /已恢復穩定/.test(m)).length, 0, 'no release notice for a silent rule');
    assert.equal(store.takeDigest(plus(1).toISOString()).length, 0, 'not put into the digest either');
});

test('flapping release reports 目前正常 when no unresolved alert exists', async () => {
    addAlert('a1', 'r1', 40, { resolved: 1 });
    store.saveState({ stateKey: store.stateKey('m1', 'r1'), lastTriggerNotifiedAt: null, lastRecoveryNotifiedAt: null, transitions: [plus(-31).toISOString()], flappingSince: plus(-40).toISOString() });
    assert.equal((await job.runOnce(T0)).flapsReleased, 1);
    assert.ok(tg.some(m => /已恢復穩定/.test(m) && /目前正常/.test(m)));
});

test('kill switch stops the job', async () => {
    writeDataSync(cfg.CONFIG_KEY, { evaluationEnabled: false }); cfg.invalidateConfig();
    addAlert('a1', 'r1', 120);
    assert.deepEqual(await job.runOnce(T0), { excludedResolved: 0, digestSent: 0, escalated: 0, maintenanceFollowUps: 0, flapsReleased: 0 });
});

test('concurrent runs escalate each alert exactly once', async (t) => {
    t.mock.method(mailer, 'sendMail', async (o) => { await new Promise(r => setTimeout(r, 30)); mails.push(o); });
    addAlert('a1', 'r1', 31);
    addAlert('a2', 'r1', 35);
    await Promise.all([job.runOnce(T0), job.runOnce(T0)]);
    assert.equal(mails.length, 2);
    assert.equal(chat.length, 2);
    assert.equal(hooks.length, 2);
});

test('no destination enabled: nothing is claimed', async () => {
    writeDataSync(cfg.CONFIG_KEY, {}); cfg.invalidateConfig();
    addAlert('a1', 'r1', 31);
    assert.equal((await job.runOnce(T0)).escalated, 0);
    assert.equal(dbManager.get("SELECT escalatedAt FROM alerts WHERE id='a1'").escalatedAt, null);
});

test('stale (older than escalateAfterMin + 1440) and disabled-monitor alerts are not escalated', async () => {
    dbManager.run("INSERT INTO monitors (id, name, ip, tags, enabled) VALUES ('m2','OFF-01','10.0.0.2','[]',0)");
    addAlert('a1', 'r1', 30 + 1441);
    addAlert('a2', 'r1', 60, { monitorId: 'm2' });
    assert.equal((await job.runOnce(T0)).escalated, 0);
    assert.equal(chat.length, 0);
    addAlert('a3', 'r1', 30 + 1440);
    assert.equal((await job.runOnce(T0)).escalated, 1);   // exactly at the upper bound is still eligible
    dbManager.run("DELETE FROM monitors WHERE id='m2'");
});

test('escalation storm: max 10 individual messages plus one summary, all claimed', async () => {
    for (let i = 1; i <= 12; i++) addAlert('s' + i, 'r1', 40 + i);
    const r = await job.runOnce(T0);
    assert.equal(r.escalated, 12);
    assert.equal(chat.length, 11);
    assert.equal(chat.filter(c => /另有 2 則告警未處理已超過升級時間/.test(c.m)).length, 1);
    assert.equal(dbManager.get('SELECT COUNT(*) AS n FROM alerts WHERE escalatedAt IS NOT NULL').n, 12);
    await job.runOnce(plus(1));
    assert.equal(chat.length, 11);
});

test('escalation skips alerts still marked maintenance in the same run', async () => {
    addAlert('a1', 'r1', 45, { suppressedReason: 'maintenance' });
    const r = await job.runOnce(T0);
    assert.equal(r.escalated, 0);
    assert.equal(r.maintenanceFollowUps, 1);
    assert.equal(chat.length, 0);
});

test('maintenance follow-ups respect the rate limit and overflow goes to the digest', async (t) => {
    const engine = require('../../services/scoutAlertEngine');
    const calls = [];
    t.mock.method(engine, 'triggerAction', async (...a) => { calls.push(a); });
    writeDataSync(cfg.CONFIG_KEY, { rateLimitPerMinute: 1 }); cfg.invalidateConfig();
    for (const id of ['a1', 'a2', 'a3']) addAlert(id, 'r1', 90, { suppressedReason: 'maintenance' });
    const r = await job.runOnce(T0);
    assert.equal(r.maintenanceFollowUps, 3);
    assert.equal(calls.length, 1);
    assert.equal(dbManager.get('SELECT COUNT(*) AS n FROM alerts WHERE suppressedReason IS NOT NULL').n, 0);
    assert.equal(store.takeDigest(plus(5).toISOString()).filter(l => /維護結束後仍異常/.test(l)).length, 2);
});

test('maintenance follow-up defaults to telegram when an offline rule has no actions', async (t) => {
    const engine = require('../../services/scoutAlertEngine');
    const calls = [];
    t.mock.method(engine, 'triggerAction', async (...a) => { calls.push(a); });
    dbManager.run(`INSERT OR REPLACE INTO rules (id, name, type, threshold, alertHits, actions, category) VALUES ('r-off','Offline','offline',5,1,'[]','metric')`);
    t.after(() => dbManager.run("DELETE FROM rules WHERE id = 'r-off'"));
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, ruleName, type, target, value, threshold, triggeredAt, resolved, suppressedReason) VALUES ('o1','m1','r-off','Offline','offline','Heartbeat','offline','5m',?,0,'maintenance')", [plus(-90).toISOString()]);
    await job.runOnce(T0);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0][1].actions), [{ type: 'telegram' }]);
});

test('F4: maintenance follow-up for a metric rule with no actions notifies nothing', async (t) => {
    const engine = require('../../services/scoutAlertEngine');
    const calls = [];
    t.mock.method(engine, 'triggerAction', async (...a) => { calls.push(a); });
    addAlert('a1', 'r2', 90, { suppressedReason: 'maintenance' });   // r2 actions = []
    const r = await job.runOnce(T0);
    assert.equal(r.maintenanceFollowUps, 1);
    assert.equal(calls.length, 0);
    assert.equal(dbManager.get("SELECT suppressedReason FROM alerts WHERE id='a1'").suppressedReason, null);
    assert.equal(dbManager.get('SELECT count(*) AS n FROM notify_rate').n, 0);
});

test('digest message stays within the length budget and counts the remainder', async () => {
    for (let i = 0; i < 40; i++) store.addDigest('x'.repeat(300), plus(-2).toISOString());
    await job.runOnce(T0);
    assert.equal(tg.length, 1);
    assert.ok(tg[0].length <= 1500, `length ${tg[0].length}`);
    for (const line of tg[0].split('\n').filter(l => l.startsWith('• '))) assert.ok(line.length <= 122, `line ${line.length}`);
    const shown = (tg[0].match(/\n• /g) || []).length;
    assert.match(tg[0], new RegExp(`及其他 ${40 - shown} 筆`));
});

test('alert with unparsable triggeredAt is skipped', async () => {
    addAlert('a1', 'r1', 40);
    dbManager.run("UPDATE alerts SET triggeredAt = 'garbage' WHERE id = 'a1'");
    assert.equal((await job.runOnce(T0)).escalated, 0);
});

// ---- final-review fixes ----
test('F2: log alerts get no follow-up at maintenance end, only the marker is cleared', async (t) => {
    const engine = require('../../services/scoutAlertEngine');
    const calls = [];
    t.mock.method(engine, 'triggerAction', async (...a) => { calls.push(a); });
    dbManager.run(`INSERT OR REPLACE INTO rules (id, name, type, alertHits, actions, category) VALUES ('r-log','Logon','winevent',1,'[{"type":"telegram"}]','log')`);
    t.after(() => dbManager.run("DELETE FROM rules WHERE id = 'r-log'"));
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, ruleName, type, target, value, threshold, triggeredAt, resolved, suppressedReason) VALUES ('l1','m1','r-log','Logon','winevent','EventID: 4625','x',1,?,0,'maintenance')", [plus(-90).toISOString()]);
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, ruleName, type, target, value, threshold, triggeredAt, resolved, suppressedReason) VALUES ('l2','m1','gone-rule','Old','syslog','Syslog','x',1,?,0,'maintenance')", [plus(-90).toISOString()]);
    const r = await job.runOnce(T0);
    assert.equal(r.maintenanceFollowUps, 2);
    assert.equal(calls.length, 0);
    assert.equal(dbManager.get('SELECT count(*) AS n FROM alerts WHERE suppressedReason IS NOT NULL').n, 0);
    assert.equal(dbManager.get('SELECT count(*) AS n FROM notify_rate').n, 0);
});

test('F3: a flap-release notice over the rate limit goes to the digest', async () => {
    writeDataSync(cfg.CONFIG_KEY, { rateLimitPerMinute: 1 }); cfg.invalidateConfig();
    store.bumpRate(store.minuteBucket(T0));
    store.saveState({ stateKey: store.stateKey('m1', 'r1'), lastTriggerNotifiedAt: null, lastRecoveryNotifiedAt: null, transitions: [plus(-31).toISOString()], flappingSince: plus(-40).toISOString() });
    assert.equal((await job.runOnce(T0)).flapsReleased, 1);
    assert.equal(tg.filter(m => /已恢復穩定/.test(m)).length, 0);
    assert.equal(store.takeDigest(plus(5).toISOString()).filter(l => /已恢復穩定/.test(l)).length, 1);
});

test('F5: flap release clears transitions and is silent during maintenance', async () => {
    store.saveState({ stateKey: store.stateKey('m1', 'r1'), lastTriggerNotifiedAt: T0.toISOString(), lastRecoveryNotifiedAt: null, transitions: [plus(-35).toISOString(), plus(-31).toISOString()], flappingSince: plus(-40).toISOString() });
    dbManager.run(`INSERT INTO maintenance_windows (id, name, kind, startAt, endAt, scopeType, scopeValues, ruleIds, enabled) VALUES ('w','x','once',?,?,'all','[]','[]',1)`, [plus(-5).toISOString(), plus(60).toISOString()]);
    store.invalidateWindows();
    assert.equal((await job.runOnce(T0)).flapsReleased, 1);
    const st = store.getState(store.stateKey('m1', 'r1'));
    assert.equal(st.flappingSince, null);
    assert.deepEqual(st.transitions, []);
    assert.equal(st.lastTriggerNotifiedAt, T0.toISOString(), 'other fields kept');
    assert.equal(tg.length, 0);
    assert.equal(dbManager.get('SELECT count(*) AS n FROM notify_rate').n, 0);
});

test('F5: flap release re-reads state and skips if a newer transition arrived', async (t) => {
    const key = store.stateKey('m1', 'r1');
    store.saveState({ stateKey: key, lastTriggerNotifiedAt: null, lastRecoveryNotifiedAt: null, transitions: [plus(-31).toISOString()], flappingSince: plus(-40).toISOString() });
    const realList = store.listFlapping;
    t.mock.method(store, 'listFlapping', () => {
        const snap = realList();
        // a concurrent web-process update lands after the snapshot
        store.saveState({ stateKey: key, lastTriggerNotifiedAt: null, lastRecoveryNotifiedAt: null, transitions: [plus(-31).toISOString(), plus(-1).toISOString()], flappingSince: plus(-40).toISOString() });
        return snap;
    });
    assert.equal((await job.runOnce(T0)).flapsReleased, 0);
    const st = store.getState(key);
    assert.equal(st.flappingSince, plus(-40).toISOString());
    assert.equal(st.transitions.length, 2);
    assert.equal(tg.length, 0);
});

test('F8: digest of old lines says how many minutes they accumulated over', async () => {
    for (let i = 0; i < 3; i++) store.addDigest(`old${i}`, plus(-10).toISOString());
    store.addDigest('newer', plus(-1).toISOString());
    await job.runOnce(T0);
    assert.equal(tg.length, 1);
    assert.match(tg[0], /告警摘要（過去 10 分鐘累積 4 則，超過速率上限）/);
});

test('F10: hourly prune removes stale notify_state rows and old quick-mute windows', async () => {
    const far = plus(30 * 24 * 60);
    const old = new Date(far.getTime() - 8 * 24 * 3600000).toISOString();
    const recent = new Date(far.getTime() - 3600000).toISOString();
    // a still-flapping row keeps a recent transition so the release step leaves it alone
    const st = (k, trig, rec, flap = null) => store.saveState({ stateKey: k, lastTriggerNotifiedAt: trig, lastRecoveryNotifiedAt: rec, transitions: flap ? [new Date(far.getTime() - 60000).toISOString()] : [], flappingSince: flap });
    st('old|r', old, null);
    st('old2|r', old, old);
    st('recent|r', recent, null);
    st('recrec|r', old, recent);
    st('flap|r', old, old, old);
    const win = (id, source, endAt) => dbManager.run(`INSERT INTO maintenance_windows (id, name, kind, startAt, endAt, scopeType, scopeValues, ruleIds, enabled, source) VALUES (?,?,'once',?,?,'all','[]','[]',1,?)`, [id, id, old, endAt, source]);
    win('qm-old', 'quick-mute', old);
    win('qm-new', 'quick-mute', recent);
    win('manual-old', 'manual', old);
    await job.runOnce(far);
    const keys = dbManager.all('SELECT stateKey FROM notify_state ORDER BY stateKey').map(r => r.stateKey);
    assert.deepEqual(keys, ['flap|r', 'recent|r', 'recrec|r']);
    assert.deepEqual(dbManager.all('SELECT id FROM maintenance_windows ORDER BY id').map(r => r.id), ['manual-old', 'qm-new']);
    // at most once per hour
    st('old3|r', old, null);
    await job.runOnce(new Date(far.getTime() + 60000));
    assert.equal(dbManager.get("SELECT count(*) AS n FROM notify_state WHERE stateKey = 'old3|r'").n, 1);
    await job.runOnce(new Date(far.getTime() + 61 * 60000));
    assert.equal(dbManager.get("SELECT count(*) AS n FROM notify_state WHERE stateKey = 'old3|r'").n, 0);
});

// ---- rule exclusions (I1) ----
const ruleExclusions = require('../../services/ruleExclusions');
function excludeTag(t, ruleId, tag) {
    dbManager.run("INSERT INTO rule_exclusions (id, ruleId, scopeType, scopeValue, createdAt) VALUES (?,?,'tag',?,?)", [`jx-${ruleId}-${tag}`, ruleId, tag, T0.toISOString()]);
    t.after(() => { dbManager.run('DELETE FROM rule_exclusions'); dbManager.run("UPDATE monitors SET tags = '[]' WHERE id = 'm1'"); });
}

test('exclusion: a host that gains an excluded tag later gets its open alert resolved as excluded and is never escalated', async (t) => {
    addAlert('a1', 'r1', 31);
    excludeTag(t, 'r1', 'batch');
    dbManager.run("UPDATE monitors SET tags = '[\"batch\"]' WHERE id = 'm1'");   // tag added after the exclusion, outside the routes
    const r = await job.runOnce(T0);
    assert.equal(r.excludedResolved, 1);
    assert.equal(r.escalated, 0);
    assert.equal(chat.length + mails.length + hooks.length, 0);
    const a = dbManager.get("SELECT resolved, resolvedReason FROM alerts WHERE id = 'a1'");
    assert.equal(a.resolved, 1); assert.equal(a.resolvedReason, 'excluded');
});

test('exclusion: escalation, maintenance follow-up and flap release skip excluded pairs even if the reconcile step fails', async (t) => {
    t.mock.method(ruleExclusions, 'reconcileOpenAlerts', () => { throw new Error('boom'); });
    t.mock.method(console, 'error', () => {});
    addAlert('a1', 'r1', 31);
    addAlert('a2', 'r1', 5, { suppressedReason: 'maintenance', monitorId: 'm1' });
    store.saveState({ stateKey: store.stateKey('m1', 'r1'), lastTriggerNotifiedAt: null, lastRecoveryNotifiedAt: null, transitions: [plus(-40).toISOString()], flappingSince: plus(-45).toISOString() });
    excludeTag(t, 'r1', 'batch');
    dbManager.run("UPDATE monitors SET tags = '[\"batch\"]' WHERE id = 'm1'");
    const r = await job.runOnce(T0);
    assert.equal(r.escalated, 0);
    assert.equal(chat.length + mails.length + hooks.length, 0, 'no escalation delivery');
    assert.equal(tg.length, 0, 'no follow-up and no flap-release notice');
});
