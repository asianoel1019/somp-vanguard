require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');
const logger = require('../../lib/logger');
const { writeDataSync, readDataSync } = require('../../lib/db');
const ingestion = require('../../services/telemetryIngestionService');

const META_KEY = 'server_operation/server_cmdb_meta.json';
const API_KEY = 'global-test-key';
let sent;
const realSend = logger.sendTelegramAlert;

test.before(async () => {
    await dbManager.initDB();
    dbManager.run("INSERT INTO api_keys (id, name, key, createdAt, maxAgents, isOpenApi) VALUES ('k1','Global','" + API_KEY + "','now',50,0)");
    writeDataSync(META_KEY, { '10.9.9.9': { deleted: true, deletedAt: 'x' }, '10.9.9.8': { deleted: false } });
});
test.beforeEach(() => {
    sent = [];
    ingestion._resetDeletedAgentNotices();
    logger.sendTelegramAlert = async (msg, mod) => { sent.push({ msg, mod }); };
});
test.after(async () => {
    logger.sendTelegramAlert = realSend;
    await dbManager.closeDB();
});

const monitorCount = (ip) => dbManager.get('SELECT COUNT(*) AS c FROM monitors WHERE ip = ?', [ip]).c;

test('auto-registration is skipped for a deleted server and notifies once per 24 h', async () => {
    const payload = { ip: '10.9.9.9', hostname: 'GONE-01', apiKey: API_KEY, os: 'linux', metrics: {} };
    for (let i = 0; i < 5; i++) {
        const r = await ingestion.processAgentReportFast(payload, '10.9.9.9');
        assert.equal(r.status, 401);
    }
    assert.equal(monitorCount('10.9.9.9'), 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mod, 'ScoutMonitor');
    assert.equal(sent[0].msg, '⚠️ [Scout Monitor] Agent on deleted server GONE-01 (10.9.9.9) is still reporting — not re-registered. Restore the server in Server List or uninstall the agent.');
    assert.equal(dbManager.get("SELECT COUNT(*) AS c FROM monitors WHERE name = 'GONE-01'").c, 0);

    // throttle window: still silent just before 24 h, notifies again after
    const t0 = Date.now();
    assert.equal(ingestion.notifyDeletedAgentReporting('10.9.9.9', 'GONE-01', t0 + 23 * 3600 * 1000), false);
    assert.equal(ingestion.notifyDeletedAgentReporting('10.9.9.9', 'GONE-01', t0 + 25 * 3600 * 1000), true);
    assert.equal(sent.length, 2);
    // a different deleted IP has its own throttle
    assert.equal(ingestion.notifyDeletedAgentReporting('10.9.9.10', 'OTHER'), true);
});

test('a server that is not deleted is still auto-registered', async () => {
    const r = await ingestion.processAgentReportFast({ ip: '10.9.9.8', hostname: 'LIVE-01', apiKey: API_KEY, os: 'linux', metrics: {} }, '10.9.9.8');
    assert.equal(r.status, 200);
    assert.equal(monitorCount('10.9.9.8'), 1);
    assert.equal(sent.length, 0);
});

test('IP reuse: a different hostname on a deleted IP registers as a new server and clears the flag', async () => {
    writeDataSync(META_KEY, { '10.9.9.7': { hostname: 'OLDBOX', deletedNames: ['oldbox', 'prd-oldbox'], deleted: true, deletedAt: 'x' }, '10.9.9.5': { hostname: 'LEGACY', deleted: true } });
    // same host (short name, any case): stays blocked
    const same = await ingestion.processAgentReportFast({ ip: '10.9.9.7', hostname: 'oldbox', apiKey: API_KEY, os: 'linux', metrics: {} }, '10.9.9.7');
    assert.equal(same.status, 401);
    assert.equal(monitorCount('10.9.9.7'), 0);
    const reused = await ingestion.processAgentReportFast({ ip: '10.9.9.7', hostname: 'NEWBOX', apiKey: API_KEY, os: 'linux', metrics: {} }, '10.9.9.7');
    assert.equal(reused.status, 200);
    assert.equal(monitorCount('10.9.9.7'), 1);
    const meta = readDataSync(META_KEY, {});
    assert.equal(meta['10.9.9.7'].deleted, false);
    assert.equal(meta['10.9.9.7'].restoredBy, 'SYSTEM');
    assert.ok(readDataSync('server_operation/server_cmdb_history.json', []).some(h => h.ip === '10.9.9.7' && h.action === 'RESTORE_IP_REUSE'));
});

test('a deleted-but-reporting agent is answered from a 60 s cache, not by re-reading CMDB meta', () => {
    writeDataSync(META_KEY, { '10.9.9.6': { hostname: 'GONE', deleted: true } });
    const t0 = Date.now();
    assert.equal(ingestion.isAgentOnDeletedServer('10.9.9.6', 'GONE', t0), true);
    writeDataSync(META_KEY, {}); // meta changed underneath: cached answer still served within 60 s
    assert.equal(ingestion.isAgentOnDeletedServer('10.9.9.6', 'GONE', t0 + 30000), true);
    assert.equal(ingestion.isAgentOnDeletedServer('10.9.9.6', 'GONE', t0 + 61000), false);
});

test('IP reuse: another recorded name of the deleted server, or a legacy entry without names, never revives', async () => {
    writeDataSync(META_KEY, {
        '10.9.9.7': { hostname: 'OLDBOX', deletedNames: ['oldbox', 'prd-oldbox'], deleted: true },
        '10.9.9.5': { hostname: 'LEGACY', deleted: true }
    });
    const vm = await ingestion.processAgentReportFast({ ip: '10.9.9.7', hostname: 'PRD-OLDBOX', apiKey: API_KEY, os: 'linux', metrics: {} }, '10.9.9.7');
    assert.equal(vm.status, 401);
    const legacy = await ingestion.processAgentReportFast({ ip: '10.9.9.5', hostname: 'ANYTHING', apiKey: API_KEY, os: 'linux', metrics: {} }, '10.9.9.5');
    assert.equal(legacy.status, 401);
    assert.equal(monitorCount('10.9.9.5'), 0);
    assert.equal(readDataSync(META_KEY, {})['10.9.9.5'].deleted, true);
    assert.equal(sent.length, 2); // throttled notice per IP suggests Restore
});
