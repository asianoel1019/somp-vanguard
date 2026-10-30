require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const { writeDataSync } = require('../../lib/db');
const cfg = require('../../services/alertQualityConfig');
const store = require('../../services/alertPolicyStore');
const logger = require('../../lib/logger');
const engine = require('../../services/scoutAlertEngine');
const ingestion = require('../../services/telemetryIngestionService');
const { WS_EVENTS } = require('../../constants/wsEvents');

const mon = { id: 'm1', name: 'WEB-01', ip: '10.0.0.1', apiKey: 'k1', tags: '[]', envId: 'e1', enabled: 1 };
const cpu = (v) => ({ metrics: { cpu: { used: v } } });
const T0 = new Date(2026, 9, 14, 10, 0, 0);
const plus = (min) => new Date(T0.getTime() + min * 60000);

let sent;
let sentAlertRows; // offline alert rows present at the moment each notification was sent
let warns;
test.before(async () => {
    await dbManager.initDB();
    dbManager.run("INSERT INTO monitors (id, name, ip, apiKey, tags, envId, enabled, status, lastSeen) VALUES ('m1','WEB-01','10.0.0.1','k1','[]','e1',1,'online',?)", [T0.toISOString()]);
    dbManager.run(`INSERT INTO rules (id, name, type, target, threshold, alertHits, actions, recoveryNotify, category) VALUES ('r-cpu','CPU high','cpu','',90,3,'[{"type":"telegram"}]',1,'metric')`);
    dbManager.run("INSERT INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES ('b1','r-cpu','monitor','m1')");
    dbManager.run(`INSERT INTO rules (id, name, type, target, alertHits, actions, category, logConfig) VALUES ('r-4625','Logon fail','winevent','',1,'[{"type":"telegram"}]','log','{"channel":"Security","eventID":"4625"}')`);
    dbManager.run("INSERT INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES ('b2','r-4625','monitor','m1')");
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach((t) => {
    for (const tb of ['alerts', 'alert_state', 'notify_state', 'notify_rate', 'notify_digest', 'maintenance_windows']) dbManager.run(`DELETE FROM ${tb}`);
    writeDataSync(cfg.CONFIG_KEY, {}); cfg.invalidateConfig(); store.invalidateWindows(); engine.invalidateRuleCache();
    sent = []; sentAlertRows = []; warns = [];
    t.mock.method(logger, 'sendTelegramAlert', async (msg) => {
        sent.push(msg);
        sentAlertRows.push(dbManager.get("SELECT count(*) c FROM alerts WHERE type = 'offline'").c);
    });
    // broadcastEvent warns "Cannot broadcast event X" when no WebSocket server exists; used to observe WS events
    t.mock.method(console, 'warn', (...a) => { warns.push(a.join(' ')); });
});

const report = (v, now) => engine.evaluateReport(mon, cpu(v), now);

test('three consecutive breaches create one alert and one notification', async () => {
    report(95, plus(0)); report(95, plus(1));
    assert.equal(dbManager.get('SELECT count(*) c FROM alerts').c, 0);
    report(95, plus(2));
    await new Promise(r => setImmediate(r));
    const alerts = dbManager.all('SELECT * FROM alerts');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].suppressedReason, null);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /ALERT: WEB-01 - cpu/);
});

test('recovery resolves the alert and notifies (recoveryNotify=1)', async () => {
    report(95, plus(0)); report(95, plus(1)); report(95, plus(2));
    report(10, plus(3));
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get('SELECT resolved FROM alerts').resolved, 1);
    assert.equal(sent.length, 2);
    assert.match(sent[1], /RECOVERED/);
});

test('maintenance: alert is recorded with suppressedReason, nothing is sent', async () => {
    dbManager.run(`INSERT INTO maintenance_windows (id, name, kind, startAt, endAt, scopeType, scopeValues, ruleIds, enabled) VALUES ('w','x','once',?,?,'all','[]','[]',1)`, [plus(-1).toISOString(), plus(60).toISOString()]);
    store.invalidateWindows();
    report(95, plus(0)); report(95, plus(1)); report(95, plus(2));
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get('SELECT suppressedReason FROM alerts').suppressedReason, 'maintenance');
    assert.equal(sent.length, 0);
});

test('kill switch: evaluationEnabled=false stops evaluation entirely', async () => {
    writeDataSync(cfg.CONFIG_KEY, { evaluationEnabled: false }); cfg.invalidateConfig();
    for (let i = 0; i < 5; i++) report(99, plus(i));
    assert.equal(dbManager.get('SELECT count(*) c FROM alerts').c, 0);
    assert.equal(dbManager.get('SELECT count(*) c FROM alert_state').c, 0);
});

test('log alerts are deduplicated into occurrences while unresolved', async () => {
    const ev = { eventID: '4625', logName: 'Security', level: 'information', message: 'An account failed to log on' };
    for (let i = 0; i < 5; i++) await engine.evaluateLogEvents(mon, 'winevent', ev, plus(i));
    const rows = dbManager.all("SELECT * FROM alerts WHERE checkId = 'r-4625'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].occurrences, 5);
    assert.equal(sent.length, 1, 'later hits are within cooldown');
});

test('old resolved alerts are cleaned by cleanupOldAlerts, not by each report', async () => {
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, resolved, resolvedAt, triggeredAt) VALUES ('old','m1','r-cpu',1,?,?)", [plus(-60 * 24 * 8).toISOString(), plus(-60 * 24 * 8).toISOString()]);
    report(10, plus(0));
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE id='old'").c, 1);
    const n = await engine.cleanupOldAlerts(plus(0));
    assert.equal(n, 1);
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE id='old'").c, 0);
});

test('cleanupOldAlerts deletes in batches and keeps recent resolved and unresolved alerts', async () => {
    const old = plus(-60 * 24 * 8).toISOString();
    for (let i = 0; i < 5; i++) dbManager.run("INSERT INTO alerts (id, monitorId, checkId, resolved, resolvedAt, triggeredAt) VALUES (?,?,?,1,?,?)", [`o${i}`, 'm1', 'r-cpu', old, old]);
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, resolved, resolvedAt, triggeredAt) VALUES ('recent','m1','r-cpu',1,?,?)", [plus(-60).toISOString(), plus(-90).toISOString()]);
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, resolved, triggeredAt) VALUES ('open','m1','r-cpu',0,?)", [old]);
    const n = await engine.cleanupOldAlerts(plus(0), { batchSize: 2 });
    assert.equal(n, 5);
    assert.deepEqual(dbManager.all('SELECT id FROM alerts ORDER BY id').map(r => r.id), ['open', 'recent']);
});

test('registerEvaluator exposes evaluators on global without starting the offline poller', () => {
    delete global.scoutAlertEngine;
    const timers = () => process.getActiveResourcesInfo().filter(x => x === 'Timeout').length;
    const before = timers();
    const ret = engine.registerEvaluator();
    assert.equal(ret, undefined);
    assert.equal(timers(), before, 'registerEvaluator must not create timers (no poller)');
    assert.equal(typeof global.scoutAlertEngine.evaluateReport, 'function');
    assert.equal(typeof global.scoutAlertEngine.evaluateLogEvents, 'function');
});

const mon2 = { id: 'm2', name: 'DB-02', ip: '10.0.0.2', apiKey: 'k2', tags: '[]', envId: 'e1', enabled: 1 };
function addRule(t, id, { alertHits = 1, recoveryNotify = 1, monitorId = 'm2' } = {}) {
    dbManager.run(`INSERT OR REPLACE INTO rules (id, name, type, target, threshold, alertHits, actions, recoveryNotify, category) VALUES (?,?,'cpu','',90,?,'[{"type":"telegram"}]',?,'metric')`, [id, id, alertHits, recoveryNotify]);
    dbManager.run("INSERT OR REPLACE INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES (?,?,'monitor',?)", [`b-${id}`, id, monitorId]);
    engine.invalidateRuleCache();
    t.after(() => {
        dbManager.run('DELETE FROM rules WHERE id = ?', [id]);
        dbManager.run('DELETE FROM rule_bindings WHERE id = ?', [`b-${id}`]);
        engine.invalidateRuleCache();
    });
}
const report2 = (v, now) => engine.evaluateReport(mon2, cpu(v), now);

test('recovery with recoveryNotify=0 resolves the alert but sends nothing', async (t) => {
    addRule(t, 'r-norec', { recoveryNotify: 0 });
    report2(95, plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(sent.length, 1);
    report2(10, plus(1));
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get("SELECT resolved FROM alerts WHERE checkId = 'r-norec'").resolved, 1);
    assert.equal(sent.length, 1, 'no recovery notification');
});

test('flapping: the "unstable" notice is sent exactly once', async (t) => {
    writeDataSync(cfg.CONFIG_KEY, { flapping: { transitions: 4, windowMin: 30, stableMin: 30 } }); cfg.invalidateConfig();
    addRule(t, 'r-flap');
    for (let i = 0; i < 10; i++) report2(i % 2 === 0 ? 95 : 10, plus(i));
    await new Promise(r => setImmediate(r));
    const notices = sent.filter(m => m.includes('告警不穩定'));
    assert.equal(notices.length, 1, `sent: ${JSON.stringify(sent)}`);
});

test('reconcileAlertState resets only states with no alert row at all; acknowledged ones are kept', async () => {
    dbManager.run("INSERT INTO alert_state (stateKey, hitCount, status) VALUES ('m1-r-cpu', 5, 'alerting')"); // no alert row at all -> reset
    dbManager.run("INSERT INTO alert_state (stateKey, hitCount, status) VALUES ('mon-9-r-x', 3, 'alerting')"); // open alert, dashed id -> kept
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, resolved, triggeredAt) VALUES ('open9','mon-9','r-x',0,?)", [T0.toISOString()]);
    dbManager.run("INSERT INTO alert_state (stateKey, hitCount, status) VALUES ('m7-r-ack', 4, 'alerting')"); // acknowledged (resolved) -> kept
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, resolved, resolvedAt, triggeredAt) VALUES ('ack7','m7','r-ack',1,?,?)", [T0.toISOString(), T0.toISOString()]);
    assert.equal(engine.reconcileAlertState(), 1);
    assert.equal(engine.reconcileAlertState(), 0, 'idempotent');
    const st = (k) => dbManager.get('SELECT status, hitCount FROM alert_state WHERE stateKey = ?', [k]);
    assert.deepEqual({ ...st('m1-r-cpu') }, { status: 'ok', hitCount: 0 });
    assert.equal(st('mon-9-r-x').status, 'alerting');
    assert.equal(st('m7-r-ack').status, 'alerting');
    report(10, plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(sent.length, 0);
});

test('a new alert row exists whenever alert_state is alerting (insert-before-update ordering)', () => {
    report(95, plus(0)); report(95, plus(1)); report(95, plus(2));
    assert.equal(dbManager.get("SELECT status FROM alert_state WHERE stateKey = 'm1-r-cpu'").status, 'alerting');
    assert.equal(engine.reconcileAlertState(), 0);
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE checkId = 'r-cpu' AND resolved = 0").c, 1);
});

test('ingestion path: web-process evaluator registered, reports flow through processAgentReportFast', async () => {
    engine.registerEvaluator();
    dbManager.run("UPDATE monitors SET status = 'online', enabled = 1 WHERE id = 'm1'");
    for (let i = 0; i < 3; i++) {
        const r = await ingestion.processAgentReportFast({ ip: '10.0.0.1', hostname: 'WEB-01', apiKey: 'k1', metrics: { cpu: { used: 95 } } }, '10.0.0.1');
        assert.equal(r.status, 200);
        await ingestion.flushTelemetryBatch();
        await new Promise(r2 => setImmediate(r2));
    }
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE checkId = 'r-cpu'").c, 1);
    assert.equal(sent.length, 1);
});

// ---- checkDeadAgents ----
function seedOffline(t, { status, lastSeen }) {
    dbManager.run('DELETE FROM monitors');
    dbManager.run("INSERT INTO monitors (id, name, ip, apiKey, tags, envId, enabled, status, lastSeen) VALUES ('dm1','DEAD-01','10.0.0.9','kd','[]','e1',1,?,?)", [status, lastSeen.toISOString()]);
    dbManager.run(`INSERT OR REPLACE INTO rules (id, name, type, target, threshold, alertHits, actions, category) VALUES ('r-off','Offline','offline','',5,1,'[{"type":"telegram"}]','metric')`);
    dbManager.run("INSERT OR REPLACE INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES ('b-off','r-off','monitor','dm1')");
    engine.invalidateRuleCache();
    t.after(() => {
        dbManager.run('DELETE FROM monitors');
        dbManager.run("DELETE FROM rules WHERE id = 'r-off'");
        dbManager.run("DELETE FROM rule_bindings WHERE id = 'b-off'");
        engine.invalidateRuleCache();
    });
}
const status = () => dbManager.get("SELECT status FROM monitors WHERE id = 'dm1'").status;
const wsEvent = (name) => warns.some(w => w.includes(name));

test('checkDeadAgents: offline with a bound rule inserts the alert row before notifying, once', async (t) => {
    seedOffline(t, { status: 'online', lastSeen: plus(-60) });
    engine.checkDeadAgents(plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(status(), 'offline');
    const rows = dbManager.all("SELECT * FROM alerts WHERE type = 'offline'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].suppressedReason, null);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Agent Offline/);
    assert.deepEqual(sentAlertRows, [1], 'alert row existed when the notification was sent');
    assert.ok(wsEvent(WS_EVENTS.SCOUT_AGENT_OFFLINE));
    engine.checkDeadAgents(plus(1)); // already offline: no second alert / notification
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE type = 'offline'").c, 1);
    assert.equal(sent.length, 1);
});

test('checkDeadAgents: offline during maintenance is recorded as suppressed and not sent', async (t) => {
    seedOffline(t, { status: 'online', lastSeen: plus(-60) });
    dbManager.run(`INSERT INTO maintenance_windows (id, name, kind, startAt, endAt, scopeType, scopeValues, ruleIds, enabled) VALUES ('w','x','once',?,?,'all','[]','[]',1)`, [plus(-5).toISOString(), plus(60).toISOString()]);
    store.invalidateWindows();
    engine.checkDeadAgents(plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get("SELECT suppressedReason FROM alerts WHERE type = 'offline'").suppressedReason, 'maintenance');
    assert.equal(sent.length, 0);
    assert.equal(status(), 'offline');
});

test('checkDeadAgents: back online resolves the offline alert and notifies once', async (t) => {
    seedOffline(t, { status: 'offline', lastSeen: plus(-1) });
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, ruleName, type, resolved, triggeredAt) VALUES ('off1','dm1','r-off','Offline','offline',0,?)", [plus(-30).toISOString()]);
    engine.checkDeadAgents(plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(status(), 'online');
    assert.equal(dbManager.get("SELECT resolved FROM alerts WHERE id = 'off1'").resolved, 1);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Agent Online/);
    assert.ok(wsEvent(WS_EVENTS.SCOUT_AGENT_ONLINE));
});

test('checkDeadAgents: kill switch keeps status + WS but creates no alert and sends nothing (offline and online)', async (t) => {
    writeDataSync(cfg.CONFIG_KEY, { evaluationEnabled: false }); cfg.invalidateConfig();
    seedOffline(t, { status: 'online', lastSeen: plus(-60) });
    engine.checkDeadAgents(plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(status(), 'offline');
    assert.ok(wsEvent(WS_EVENTS.SCOUT_AGENT_OFFLINE));
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE type = 'offline'").c, 0);
    assert.equal(sent.length, 0);
    // back online (with a leftover open offline alert): status/WS/resolve still happen, no notification
    dbManager.run("UPDATE monitors SET lastSeen = ? WHERE id = 'dm1'", [plus(59).toISOString()]);
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, ruleName, type, resolved, triggeredAt) VALUES ('off2','dm1','r-off','Offline','offline',0,?)", [plus(-30).toISOString()]);
    engine.checkDeadAgents(plus(60));
    await new Promise(r => setImmediate(r));
    assert.equal(status(), 'online');
    assert.ok(wsEvent(WS_EVENTS.SCOUT_AGENT_ONLINE));
    assert.equal(dbManager.get("SELECT resolved FROM alerts WHERE id = 'off2'").resolved, 1);
    assert.equal(sent.length, 0);
});

test('performance: 500 monitors x 5 bindings, mean evaluateReport < 2 ms', () => {
    dbManager.exec('BEGIN');
    for (let r = 0; r < 5; r++) dbManager.run(`INSERT OR REPLACE INTO rules (id, name, type, target, threshold, alertHits, actions, category) VALUES (?,?,?,?,?,3,'[]','metric')`, [`perf-r${r}`, `perf ${r}`, 'cpu', '', 99]);
    for (let r = 0; r < 5; r++) dbManager.run('INSERT OR REPLACE INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES (?,?,?,?)', [`perf-b${r}`, `perf-r${r}`, 'tag', 'perf']);
    dbManager.exec('COMMIT');
    engine.invalidateRuleCache();
    const mons = Array.from({ length: 500 }, (_, i) => ({ id: `pm${i}`, name: `P${i}`, ip: `10.9.${i >> 8}.${i & 255}`, tags: ['perf'], envId: null }));
    for (const m of mons) engine.evaluateReport(m, cpu(10), T0); // warm-up
    const start = process.hrtime.bigint();
    for (const m of mons) engine.evaluateReport(m, cpu(10), T0);
    const meanMs = Number(process.hrtime.bigint() - start) / 1e6 / mons.length;
    console.log(`PERF_MEAN_MS ${meanMs.toFixed(4)}`);
    assert.ok(meanMs < 2, `mean ${meanMs.toFixed(3)} ms`);
});

// ---- final-review fixes ----
function addLogRule(t, id, type, logConfig = '{}', category = 'log') {
    dbManager.run(`INSERT OR REPLACE INTO rules (id, name, type, target, alertHits, actions, category, logConfig) VALUES (?,?,?,'',1,'[{"type":"telegram"}]',?,?)`, [id, id, type, category, logConfig]);
    dbManager.run("INSERT OR REPLACE INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES (?,?,'monitor','m1')", [`b-${id}`, id]);
    engine.invalidateRuleCache();
    t.after(() => {
        dbManager.run('DELETE FROM rules WHERE id = ?', [id]);
        dbManager.run('DELETE FROM rule_bindings WHERE id = ?', [`b-${id}`]);
        engine.invalidateRuleCache();
    });
}

test('F1: a winevent rule (category log, empty config) never matches a syslog event', async (t) => {
    addLogRule(t, 'r-wev-any', 'winevent');
    await engine.evaluateLogEvents(mon, 'syslog', { filePath: '/var/log/messages', message: 'anything at all', level: 'info' }, plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get('SELECT count(*) c FROM alerts').c, 0);
    assert.equal(sent.length, 0);
});

test('F1: a syslog rule (category log, empty config) never matches a winevent event', async (t) => {
    addLogRule(t, 'r-sys-any', 'syslog');
    await engine.evaluateLogEvents(mon, 'winevent', { eventID: '9999', logName: 'System', level: 'information', message: 'other event' }, plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get('SELECT count(*) c FROM alerts').c, 0);
    assert.equal(sent.length, 0);
});

test('F1: a syslog rule still matches syslog events and a legacy generic log rule matches both', async (t) => {
    addLogRule(t, 'r-sys-kw', 'syslog', '{"keyword":"panic"}');
    addLogRule(t, 'r-legacy', 'log', '{"keyword":"legacyhit"}');
    await engine.evaluateLogEvents(mon, 'syslog', { filePath: '/var/log/messages', message: 'kernel panic legacyhit' }, plus(0));
    await engine.evaluateLogEvents(mon, 'winevent', { eventID: '1', logName: 'System', message: 'legacyhit' }, plus(1));
    const byRule = (id) => dbManager.get('SELECT occurrences FROM alerts WHERE checkId = ?', [id]);
    assert.equal(byRule('r-sys-kw').occurrences, 1);
    assert.equal(byRule('r-legacy').occurrences, 2);
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE checkId = 'r-4625'").c, 0);
});

test('F3: a flap-start notice over the rate limit goes to the digest', async (t) => {
    writeDataSync(cfg.CONFIG_KEY, { rateLimitPerMinute: 1, flapping: { transitions: 4, windowMin: 30, stableMin: 30 } }); cfg.invalidateConfig();
    addRule(t, 'r-flaprate');
    for (let i = 0; i < 3; i++) report2(i % 2 === 0 ? 95 : 10, plus(i));
    store.bumpRate(store.minuteBucket(plus(3)));   // one notification already sent in that minute
    report2(10, plus(3));                           // 4th transition: flap starts
    await new Promise(r => setImmediate(r));
    assert.equal(sent.filter(m => m.includes('告警不穩定')).length, 0, `sent: ${JSON.stringify(sent)}`);
    assert.equal(store.takeDigest(plus(10).toISOString()).filter(l => l.includes('告警不穩定')).length, 1);
});

test('F4: a rule with no actions records the alert but notifies nothing and uses no rate budget', async (t) => {
    addRule(t, 'r-silent');
    dbManager.run("UPDATE rules SET actions = '[]' WHERE id = 'r-silent'"); engine.invalidateRuleCache();
    writeDataSync(cfg.CONFIG_KEY, { rateLimitPerMinute: 1 }); cfg.invalidateConfig();
    store.bumpRate(store.minuteBucket(plus(0)));
    report2(95, plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE checkId = 'r-silent' AND resolved = 0").c, 1);
    assert.equal(sent.length, 0);
    assert.equal(dbManager.get('SELECT count FROM notify_rate WHERE bucket = ?', [store.minuteBucket(plus(0))]).count, 1);
    assert.equal(dbManager.get('SELECT count(*) c FROM notify_digest').c, 0);
});

test('F4: invalid actions JSON is treated as no actions', async (t) => {
    addRule(t, 'r-badjson');
    dbManager.run("UPDATE rules SET actions = 'not json' WHERE id = 'r-badjson'"); engine.invalidateRuleCache();
    report2(95, plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE checkId = 'r-badjson'").c, 1);
    assert.equal(dbManager.get('SELECT count(*) c FROM notify_rate').c, 0);
});

test('F6: reconcileAlertState resets stale hitCount on ok rows', () => {
    dbManager.run("INSERT INTO alert_state (stateKey, hitCount, status) VALUES ('m1-r-cpu', 2, 'ok')");
    dbManager.run("INSERT INTO alert_state (stateKey, hitCount, status) VALUES ('mon-9-r-x', 3, 'alerting')");
    dbManager.run("INSERT INTO alerts (id, monitorId, checkId, resolved, triggeredAt) VALUES ('open9','mon-9','r-x',0,?)", [T0.toISOString()]);
    assert.equal(engine.reconcileAlertState(), 0);
    assert.equal(dbManager.get("SELECT hitCount FROM alert_state WHERE stateKey = 'm1-r-cpu'").hitCount, 0);
    assert.deepEqual({ ...dbManager.get("SELECT status, hitCount FROM alert_state WHERE stateKey = 'mon-9-r-x'") }, { status: 'alerting', hitCount: 3 });
});

test('F7: an outage that started under the kill switch sends no "Agent Online" after re-enable', async (t) => {
    writeDataSync(cfg.CONFIG_KEY, { evaluationEnabled: false }); cfg.invalidateConfig();
    seedOffline(t, { status: 'online', lastSeen: plus(-60) });
    engine.checkDeadAgents(plus(0));
    assert.equal(status(), 'offline');
    writeDataSync(cfg.CONFIG_KEY, {}); cfg.invalidateConfig();
    dbManager.run("UPDATE monitors SET lastSeen = ? WHERE id = 'dm1'", [plus(59).toISOString()]);
    engine.checkDeadAgents(plus(60));
    await new Promise(r => setImmediate(r));
    assert.equal(status(), 'online');
    assert.ok(wsEvent(WS_EVENTS.SCOUT_AGENT_ONLINE));
    assert.equal(sent.length, 0);
});

test('F11: offline mail and triggerAction mail HTML are escaped', async (t) => {
    const mailer = require('../../lib/mailer');
    const mails = [];
    t.mock.method(mailer, 'sendMail', async (o) => { mails.push(o); });
    seedOffline(t, { status: 'online', lastSeen: plus(-60) });
    dbManager.run("UPDATE monitors SET name = 'DEAD<b>01' WHERE id = 'dm1'");
    dbManager.run(`UPDATE rules SET name = 'Off<i>', actions = '[{"type":"mail","to":"ops@corp.local"}]' WHERE id = 'r-off'`);
    engine.checkDeadAgents(plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(mails.length, 1);
    assert.match(mails[0].html, /DEAD&lt;b&gt;01/);
    assert.match(mails[0].html, /Off&lt;i&gt;/);
    assert.doesNotMatch(mails[0].html, /<b>01|<i>/);
    await engine.triggerAction({ name: 'H', ip: '1' }, { id: 'x', type: 'cpu', threshold: '<script>', actions: '[{"type":"mail"}]' }, 1);
    assert.equal(mails.length, 2);
    assert.match(mails[1].html, /Threshold:<\/strong> &lt;script&gt;/);
});

// ---- rule exclusions ("Excluded hosts") ----
function exclude(t, ruleId, scopeType, scopeValue) {
    const id = `ex-${ruleId}-${scopeType}-${scopeValue}`;
    dbManager.run('INSERT INTO rule_exclusions (id, ruleId, scopeType, scopeValue, reason, createdBy, createdAt) VALUES (?,?,?,?,?,?,?)', [id, ruleId, scopeType, scopeValue, '', 'test', T0.toISOString()]);
    engine.invalidateRuleCache();
    t.after(() => { dbManager.run('DELETE FROM rule_exclusions WHERE id = ?', [id]); engine.invalidateRuleCache(); });
}

test('exclusion: an env-bound metric rule excluded for one monitor creates no alert, no state, no notification there', async (t) => {
    dbManager.run(`INSERT OR REPLACE INTO rules (id, name, type, target, threshold, alertHits, actions, recoveryNotify, category) VALUES ('r-envcpu','Env CPU','cpu','',90,1,'[{"type":"telegram"}]',1,'metric')`);
    dbManager.run("INSERT OR REPLACE INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES ('b-envcpu','r-envcpu','env','e1')");
    t.after(() => { dbManager.run("DELETE FROM rules WHERE id = 'r-envcpu'"); dbManager.run("DELETE FROM rule_bindings WHERE id = 'b-envcpu'"); engine.invalidateRuleCache(); });
    exclude(t, 'r-envcpu', 'monitor', 'm1');
    for (let i = 0; i < 4; i++) { report(99, plus(i)); report2(99, plus(i)); }
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE checkId = 'r-envcpu' AND monitorId = 'm1'").c, 0);
    assert.equal(dbManager.get("SELECT count(*) c FROM alert_state WHERE stateKey = 'm1-r-envcpu'").c, 0);
    assert.equal(dbManager.get("SELECT count(*) c FROM notify_state WHERE stateKey = 'm1|r-envcpu'").c, 0);
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE checkId = 'r-envcpu' AND monitorId = 'm2'").c, 1, 'other monitor still alerts');
    // m1 only notifies for its own (non-excluded) r-cpu binding; r-envcpu only for m2
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE checkId = 'r-cpu' AND monitorId = 'm1'").c, 1);
    assert.equal(sent.filter(m => m.includes('WEB-01')).length, 1);
    assert.equal(sent.filter(m => m.includes('DB-02')).length, 1);
});

test('exclusion beats an explicit monitor binding (metric rule r-cpu bound to m1, excluded by tag)', async (t) => {
    const tagged = { ...mon, tags: '["legacy"]' };
    exclude(t, 'r-cpu', 'tag', 'legacy');
    for (let i = 0; i < 4; i++) engine.evaluateReport(tagged, cpu(99), plus(i));
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE checkId = 'r-cpu'").c, 0);
    assert.equal(sent.length, 0);
    report(99, plus(5)); report(99, plus(6)); report(99, plus(7));   // same monitor without the tag still alerts
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE checkId = 'r-cpu'").c, 1);
});

test('exclusion: bound log rule and unbound (global) log rule are both skipped for the excluded host', async (t) => {
    const ev = { eventID: '4625', logName: 'Security', level: 'information', message: 'An account failed to log on' };
    dbManager.run(`INSERT OR REPLACE INTO rules (id, name, type, target, alertHits, actions, category, logConfig) VALUES ('r-glob','Global kw','syslog','',1,'[{"type":"telegram"}]','log','{"keyword":"segfault"}')`);
    t.after(() => { dbManager.run("DELETE FROM rules WHERE id = 'r-glob'"); engine.invalidateRuleCache(); });
    exclude(t, 'r-4625', 'monitor', 'm1');
    exclude(t, 'r-glob', 'monitor', 'm1');
    await engine.evaluateLogEvents(mon, 'winevent', ev, plus(0));
    await engine.evaluateLogEvents(mon, 'syslog', { filePath: '/var/log/messages', message: 'app segfault' }, plus(1));
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE monitorId = 'm1'").c, 0);
    assert.equal(dbManager.get("SELECT count(*) c FROM alert_state WHERE stateKey LIKE 'log-m1-%'").c, 0);
    assert.equal(sent.length, 0);
    await engine.evaluateLogEvents(mon2, 'syslog', { filePath: '/var/log/messages', message: 'app segfault' }, plus(2));
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE monitorId = 'm2' AND checkId = 'r-glob'").c, 1, 'unbound rule still global for other hosts');
});

test('exclusion: offline rule excluded for the host → status changes, but no alert row and no notification', async (t) => {
    seedOffline(t, { status: 'online', lastSeen: plus(-60) });
    exclude(t, 'r-off', 'monitor', 'dm1');
    engine.checkDeadAgents(plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(status(), 'offline');
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE type = 'offline'").c, 0);
    assert.equal(sent.length, 0);
    assert.equal(dbManager.get("SELECT count(*) c FROM notify_state WHERE stateKey = 'dm1|r-off'").c, 0);
});

test('exclusion: an env-bound offline rule still alerts for non-excluded hosts (offline path uses the shared helper incl. env)', async (t) => {
    seedOffline(t, { status: 'online', lastSeen: plus(-60) });
    dbManager.run("UPDATE rule_bindings SET scopeType = 'env', scopeValue = 'e1' WHERE id = 'b-off'");
    engine.checkDeadAgents(plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(dbManager.get("SELECT count(*) c FROM alerts WHERE type = 'offline'").c, 1);
});

test('exclusion: agent dynamic config omits targets / remediation of an excluded rule', (t) => {
    dbManager.run(`INSERT OR REPLACE INTO rules (id, name, type, target, threshold, alertHits, actions, category, remediationScript) VALUES ('r-ping','Ping gw','ping','10.9.9.9',100,1,'[]','metric','echo fix')`);
    dbManager.run("INSERT OR REPLACE INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES ('b-ping','r-ping','env','e1')");
    t.after(() => { dbManager.run("DELETE FROM rules WHERE id = 'r-ping'"); dbManager.run("DELETE FROM rule_bindings WHERE id = 'b-ping'"); });
    const before = ingestion.buildDynamicConfig(mon);
    assert.ok(before.pingTargets.includes('10.9.9.9'));
    assert.ok(before.remediationPolicies.some(p => p.id === 'r-ping'));
    exclude(t, 'r-ping', 'monitor', 'm1');
    const after = ingestion.buildDynamicConfig(mon);
    assert.ok(!after.pingTargets.includes('10.9.9.9'));
    assert.ok(!after.remediationPolicies.some(p => p.id === 'r-ping'));
    assert.ok(ingestion.buildDynamicConfig(mon2).pingTargets.includes('10.9.9.9'), 'other monitor keeps the target');
});

test('M1: several offline rules on one host → the most specific binding wins (monitor > apikey > tag > env), not row order', async (t) => {
    seedOffline(t, { status: 'online', lastSeen: plus(-6) });   // r-off: 5 min, bound directly to dm1
    dbManager.run(`INSERT OR REPLACE INTO rules (id, name, type, target, threshold, alertHits, actions, category) VALUES ('r-off-env','Offline env','offline','',600,1,'[{"type":"telegram"}]','metric')`);
    // env binding row created BEFORE the monitor binding (old behaviour picked the first row → 10 min, no alert yet)
    dbManager.run("DELETE FROM rule_bindings WHERE id = 'b-off'");
    dbManager.run("INSERT INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES ('b-off-env','r-off-env','env','e1')");
    dbManager.run("INSERT INTO rule_bindings (id, ruleId, scopeType, scopeValue) VALUES ('b-off','r-off','monitor','dm1')");
    t.after(() => { dbManager.run("DELETE FROM rules WHERE id = 'r-off-env'"); dbManager.run("DELETE FROM rule_bindings WHERE id = 'b-off-env'"); });
    engine.checkDeadAgents(plus(0));
    await new Promise(r => setImmediate(r));
    assert.equal(status(), 'offline');
    assert.deepEqual(dbManager.all("SELECT checkId FROM alerts WHERE type = 'offline'").map(r => r.checkId), ['r-off']);
});
