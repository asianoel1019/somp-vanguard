// Unified data access, Phase 1: for every document converted to docStore.mutateDocument, a change written by the
// OTHER process behind this process' RAM cache (row written straight into document_store, as the worker / web would)
// must survive the next write made here. Technique as in test/lib/ipamStore.test.js.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dbMod = require('../../lib/db');
const dbManager = require('../../services/db');
const { mutateDocument, replaceDocument } = require('../../lib/docStore');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });

/** What the other process does: writes the shared row; this process' RAM cache is untouched. */
function externalWrite(key, value) {
    dbMod.db.prepare('INSERT OR REPLACE INTO document_store (key, value) VALUES (?, ?)').run(key, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
/** The stored row (what the other process would read next). */
function row(key) {
    const r = dbMod.db.prepare('SELECT value FROM document_store WHERE key = ?').get(key);
    if (!r) return null;
    try { return JSON.parse(r.value); } catch (e) { return r.value; }
}
/** Seeds `value` (cached here), then lets the other process write `external` behind the cache. */
function seedThenExternal(key, value, external) {
    dbMod.writeDataSync(key, value);
    dbMod.readDataSync(key); // cached
    externalWrite(key, external);
}

// ---- docStore additions --------------------------------------------------------------------------------------

test('docStore codec: decode / encode documents that are not stored as JSON', () => {
    const KEY = 'test/codec.json';
    const codec = { decode: (raw) => (raw ? JSON.parse(String(raw).slice(4)) : null), encode: (d) => 'enc:' + JSON.stringify(d), defaultValue: {} };
    mutateDocument(KEY, (d) => { d.a = 1; }, codec);
    assert.equal(dbMod.db.prepare('SELECT value FROM document_store WHERE key = ?').get(KEY).value, 'enc:{"a":1}');
    externalWrite(KEY, 'enc:{"a":1,"ext":true}');
    mutateDocument(KEY, (d) => { d.b = 2; }, codec);
    assert.equal(dbMod.db.prepare('SELECT value FROM document_store WHERE key = ?').get(KEY).value, 'enc:{"a":1,"ext":true,"b":2}');
    // unchanged -> no write
    const orig = dbMod.writeDataSync;
    let writes = 0;
    dbMod.writeDataSync = (...a) => { writes++; return orig(...a); };
    try { mutateDocument(KEY, () => {}, codec); } finally { dbMod.writeDataSync = orig; }
    assert.equal(writes, 0);
});

test('docStore replaceDocument replaces arrays and objects in place under the lock', () => {
    replaceDocument('test/replace.json', { a: 1, b: 2 });
    replaceDocument('test/replace.json', { c: 3 });
    assert.deepEqual(row('test/replace.json'), { c: 3 });
    replaceDocument('test/replace-arr.json', [1, 2, 3]);
    replaceDocument('test/replace-arr.json', [4]);
    assert.deepEqual(row('test/replace-arr.json'), [4]);
});

test('DOC_WRITE_TRACE=1 appends one line per write (off by default), never throws', () => {
    const file = path.join(dbMod.getDataDir(), 'logs', 'doc_write_trace.log');
    try { fs.rmSync(file, { force: true }); } catch (e) { /* none */ }
    dbMod.writeDataSync('test/trace.json', { x: 1 });
    assert.equal(fs.existsSync(file), false, 'off by default');
    process.env.DOC_WRITE_TRACE = '1';
    try {
        dbMod.writeDataSync('test/trace.json', { x: 2 });
        mutateDocument('test/trace.json', (d) => { d.y = 1; }, { defaultValue: {} });
    } finally { delete process.env.DOC_WRITE_TRACE; }
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const parts = lines[1].split(' | ');
    assert.equal(parts.length, 6);
    assert.ok(!Number.isNaN(Date.parse(parts[0])));
    assert.equal(parts[1], String(process.pid));
    assert.ok(['web', 'worker'].includes(parts[2]));
    assert.equal(parts[3], 'test/trace.json');
    assert.ok(Number(parts[4]) > 0);
    assert.match(parts[5], /test\/lib\/docConcurrency\.test\.js:\d+/, 'caller outside lib/db.js and lib/docStore.js');
});

// ---- CMDB meta / history -------------------------------------------------------------------------------------

const cmdbMetaStore = require('../../lib/cmdbMetaStore');

test('CMDB meta: a worker change behind the cache survives a web edit (mutateMeta)', () => {
    const KEY = cmdbMetaStore.CMDB_META_KEY;
    seedThenExternal(KEY, { '192.0.2.1': { hostname: 'a' } }, { '192.0.2.1': { hostname: 'a' }, '192.0.2.2': { fqdn: 'w.example' } });
    cmdbMetaStore.mutateMeta((meta) => { meta['192.0.2.1'].applicationName = 'App'; });
    assert.deepEqual(row(KEY), { '192.0.2.1': { hostname: 'a', applicationName: 'App' }, '192.0.2.2': { fqdn: 'w.example' } });
});

test('CMDB meta: IP-reuse revive (cmdbModel.reviveIfIpReused) keeps a concurrent change of another IP', () => {
    const KEY = cmdbMetaStore.CMDB_META_KEY;
    const deleted = { hostname: 'oldhost', deleted: true, deletedNames: ['oldhost'], deletedAt: '2026-01-01T00:00:00.000Z' };
    seedThenExternal(KEY, { '192.0.2.10': deleted }, { '192.0.2.10': deleted, '192.0.2.11': { hostname: 'other' } });
    assert.equal(require('../../services/cmdbModel').reviveIfIpReused('192.0.2.10', 'newhost'), true);
    const stored = row(KEY);
    assert.equal(stored['192.0.2.10'].deleted, false);
    assert.equal(stored['192.0.2.10'].hostname, 'newhost');
    assert.deepEqual(stored['192.0.2.11'], { hostname: 'other' });
    assert.equal(cmdbMetaStore.readHistory()[0].action, 'RESTORE_IP_REUSE');
});

// Log tables (services/logTables.js): what the other process does = INSERT through its own connection
const logTables = require('../../services/logTables');
function otherProcessInsert(table, entry) {
    const { DatabaseSync } = require('node:sqlite');
    const other = new DatabaseSync(path.join(dbMod.getDataDir(), 'scout.sqlite'));
    try {
        const cols = logTables.TABLES[table].columns;
        other.prepare(`INSERT INTO ${table} (created_at, ${cols.map(c => c[0]).join(', ')}, entry) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`)
            .run(new Date().toISOString(), ...cols.map(([, get]) => get(entry)), JSON.stringify(entry));
    } finally { other.close(); }
}

test('CMDB history (table): appends keep an entry the other process added, newest first', () => {
    logTables.getHandle().exec('DELETE FROM cmdb_history');
    cmdbMetaStore.appendHistory({ id: 'a' });
    otherProcessInsert('cmdb_history', { id: 'ext' });
    cmdbMetaStore.appendHistory([{ id: 'b' }, { id: 'c' }], 3);
    assert.deepEqual(cmdbMetaStore.readHistory().map(e => e.id), ['c', 'b', 'ext', 'a']);
});

// ---- Task Scheduler ------------------------------------------------------------------------------------------

const schedulerStore = require('../../lib/schedulerStore');

test('scheduler tasks: run metadata written by the worker is not lost by a web edit', () => {
    seedThenExternal(schedulerStore.TASKS_KEY, [{ id: 't1', name: 'one', lastRunStatus: 'Never' }],
        [{ id: 't1', name: 'one', lastRunStatus: 'Success' }]);
    schedulerStore.mutateTasks((tasks) => { tasks[0].name = 'renamed'; });
    assert.deepEqual(row(schedulerStore.TASKS_KEY), [{ id: 't1', name: 'renamed', lastRunStatus: 'Success' }]);
});

test('scheduler logs (table): appends from both processes are all kept (listed newest first)', () => {
    logTables.getHandle().exec('DELETE FROM scheduler_logs');
    schedulerStore.appendLog({ id: '1' });
    otherProcessInsert('scheduler_logs', { id: 'worker' });
    schedulerStore.appendLog({ id: 'web' });
    assert.deepEqual(schedulerStore.listRecentLogs(200).map(l => l.id), ['web', 'worker', '1']);
});

// ---- Prometheus ----------------------------------------------------------------------------------------------

const t = (ip, extra = {}) => ({ targets: [`${ip}:9100`], labels: { addr: ip, host: 'h' }, ...extra });

test('Prometheus targets: updateTargetsSafely merges into the CURRENT targets (worker addition kept)', async () => {
    const { TARGETS_KEY, updateTargetsSafely } = require('../../lib/prometheusTargetHelper');
    seedThenExternal(TARGETS_KEY, [t('192.0.2.20')], [t('192.0.2.20'), t('192.0.2.21')]);
    await updateTargetsSafely((targets) => ({ targets: [...targets, t('192.0.2.22')] }), 'test');
    assert.deepEqual(row(TARGETS_KEY).map(x => x.labels.addr), ['192.0.2.20', '192.0.2.21', '192.0.2.22']);
    await assert.rejects(updateTargetsSafely(async (x) => ({ targets: x }), 'test'), /synchronous/);
});

test('Prometheus health check config: a lastRun written by the worker survives a schedule edit', () => {
    const KEY = 'prometheus_health_check.json';
    seedThenExternal(KEY, { enabled: false, intervalMinutes: 15, lastRun: null }, { enabled: false, intervalMinutes: 15, lastRun: '2026-05-01T00:00:00.000Z' });
    const out = require('../../services/prometheusScheduler').updateHealthCheckConfig({ enabled: false, intervalMinutes: 30 });
    assert.equal(out.intervalMinutes, 30);
    assert.deepEqual(row(KEY), { enabled: false, intervalMinutes: 30, lastRun: '2026-05-01T00:00:00.000Z' });
});

// ---- settings documents --------------------------------------------------------------------------------------

test('webhooks: an edit is applied to the CURRENT list', () => {
    const svc = require('../../services/webhookService');
    seedThenExternal(svc.WEBHOOKS_KEY, [{ id: 'w1', name: 'one' }], [{ id: 'w1', name: 'one' }, { id: 'w2', name: 'two' }]);
    svc.mutateWebhooks((list) => { list[0].enabled = false; });
    assert.deepEqual(row(svc.WEBHOOKS_KEY), [{ id: 'w1', name: 'one', enabled: false }, { id: 'w2', name: 'two' }]);
    svc.saveWebhooks([]); // later audit logs in this file must not dispatch to these entries
    assert.deepEqual(row(svc.WEBHOOKS_KEY), []);
});

test('RBAC (encrypted): a user mapping written by the other process survives updateUserRole', () => {
    const rbac = require('../../lib/rbac');
    const { encryptText } = require('../../lib/crypto');
    const base = { roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: { 'a@corp': 'Viewer' }, defaultRole: 'Viewer', groups: {} };
    rbac.writeRbacConfig(base);
    rbac.readRbacConfig();
    externalWrite(rbac.RBAC_KEY, encryptText(JSON.stringify({ ...base, users: { 'a@corp': 'Viewer', 'ext@corp': 'Operator' } }, null, 2)));
    assert.equal(rbac.updateUserRole('b', 'corp', 'Operator'), true);
    dbMod.invalidateCache(rbac.RBAC_KEY);
    const users = rbac.readRbacConfig().users;
    assert.equal(users['ext@corp'], 'Operator');
    assert.equal(users['b@corp'], 'Operator');
    assert.equal(typeof dbMod.db.prepare('SELECT value FROM document_store WHERE key = ?').get(rbac.RBAC_KEY).value, 'string');
});

test('credential profiles: putProfile keeps a profile added by the other process', () => {
    const creds = require('../../lib/inventoryCredentials');
    seedThenExternal(creds.PROFILES_KEY, {}, { ext: { winUser: 'x', linuxUser: '', winPassword_enc: '', linuxPassword_enc: '' } });
    const r = creds.putProfile('mine', { winUser: 'svc' }, 'tester');
    assert.equal(r.created, true);
    assert.deepEqual(Object.keys(row(creds.PROFILES_KEY)).sort(), ['ext', 'mine']);
    assert.equal(creds.deleteProfile('mine'), true);
    assert.deepEqual(Object.keys(row(creds.PROFILES_KEY)), ['ext']);
});

test('SSH known hosts: a pin made by the other process is kept, and wins over a later first sight here', () => {
    const ssh = require('../../lib/sshHostKeys');
    seedThenExternal(ssh.KNOWN_HOSTS_KEY, {}, { '192.0.2.30': { fingerprint: 'sha256:aa', firstSeen: 'x', lastSeen: 'x' } });
    assert.equal(ssh.checkHostKey('192.0.2.31', 'bb').status, 'new');
    // the cache does not know 192.0.2.30 yet: the locked check sees the other process' pin
    assert.equal(ssh.checkHostKey('192.0.2.30', 'cc').status, 'mismatch');
    assert.deepEqual(Object.keys(row(ssh.KNOWN_HOSTS_KEY)).sort(), ['192.0.2.30', '192.0.2.31']);
});

test('SNMP settings: removing a rack device keeps an entry the other writer added', () => {
    const KEY = 'network_service/snmp_settings.json';
    seedThenExternal(KEY, { d1: { enabled: true } }, { d1: { enabled: true }, d2: { enabled: false } });
    const ipamSync = require('../../lib/ipamSync');
    const origBatch = ipamSync.batchSyncIpsToIpam;
    ipamSync.batchSyncIpsToIpam = () => {};
    try {
        const r = require('../../lib/rackDeviceSync').syncDeviceChanges({ d1: { id: 'd1' } }, {}, 'tester');
        assert.equal(r.snmpChanged, true);
    } finally { ipamSync.batchSyncIpsToIpam = origBatch; }
    assert.deepEqual(row(KEY), { d2: { enabled: false } });
});

test('alert quality / field authority: whole-object replacements go through the lock (stored exactly)', () => {
    const aq = require('../../services/alertQualityConfig');
    const saved = aq.saveConfig({ cooldownMin: 20 });
    assert.deepEqual(row(aq.CONFIG_KEY), saved);
    const cmdb = require('../../services/cmdbModel');
    cmdb.saveFieldAuthorityRules({ hostname: { primary: 'MANUAL' } });
    assert.deepEqual(row('server_operation/cmdb_field_authority.json'), { hostname: { primary: 'MANUAL' } });
});

// ---- DNS Hub -------------------------------------------------------------------------------------------------

const dnsDataStore = require('../../lib/dnsDataStore');

test('dns_data.json: a schedule change is applied to the CURRENT document (server list edit kept)', () => {
    seedThenExternal(dnsDataStore.DNS_DATA_KEY, { servers: [{ id: '1', name: 'a' }] }, { servers: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }] });
    dnsDataStore.mutateDnsDb((db) => { db.exportSchedule = { enabled: false }; });
    assert.deepEqual(row(dnsDataStore.DNS_DATA_KEY), { servers: [{ id: '1', name: 'a' }, { id: '2', name: 'b' }], exportSchedule: { enabled: false } });
});

test('DNS change log (table): appends keep the other entries, the batch listed first in its order', () => {
    logTables.getHandle().exec('DELETE FROM dns_changes');
    dnsDataStore.appendDnsChanges([{ action: 'a' }]);
    otherProcessInsert('dns_changes', { action: 'ext' });
    dnsDataStore.appendDnsChanges([{ action: 'n1' }, { action: 'n2' }]);
    assert.deepEqual(dnsDataStore.listDnsChanges().map(e => e.action), ['n1', 'n2', 'ext', 'a']);
});

// ---- ELK lifecycle, inventory config, workflow logs, contracts -----------------------------------------------

test('ELK lifecycle violations: a config edit keeps scan results written by the worker', () => {
    const elk = require('../../services/elkLifecycleScheduler');
    const KEY = 'service_platform_elk_violations.json';
    seedThenExternal(KEY, { schedule: '1 day', violations: [] }, { schedule: '1 day', violations: [{ index: 'idx-1' }], lastScanStatus: 'Success' });
    elk.mutateViolationsData((cur) => { cur.schedule = '7 day'; });
    assert.deepEqual(row(KEY), { schedule: '7 day', violations: [{ index: 'idx-1' }], lastScanStatus: 'Success' });
});

test('inventory config: lastScan written by the worker survives a settings save, and vice versa', () => {
    const inv = require('../../services/inventoryScheduler');
    const KEY = 'server_operation/oscheck/config.json';
    seedThenExternal(KEY, { subnets: ['10.200.1'], lastScan: null }, { subnets: ['10.200.1'], lastScan: '2026-06-01T00:00:00.000Z', lastDiscovered: 7 });
    inv.mutateConfig((cfg) => { cfg.subnets = ['10.200.1', '10.200.2']; });
    assert.deepEqual(row(KEY), { subnets: ['10.200.1', '10.200.2'], lastScan: '2026-06-01T00:00:00.000Z', lastDiscovered: 7 });
});

test('workflow history (table): createWorkflow appends one row, other rows kept', () => {
    const wf = require('../../lib/workflow');
    otherProcessInsert('workflow_history', { id: 'wf-ext', version: 1 });
    const created = wf.createWorkflow({ name: 'Concurrency' });
    assert.deepEqual(wf.getWorkflowHistory('wf-ext').map(h => h.version), [1]);
    assert.deepEqual(wf.getWorkflowHistory(created.id).map(h => h.id), [created.id]);
});

test('contracts: a contract saved by another request during the upload scan is kept', async () => {
    const express = require('express');
    const request = require('supertest');
    const { signToken } = require('../helpers/http');
    require('../../lib/rbac').writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { dataCenter: true } } },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/rack', require('../../routes/rack'));
    const KEY = 'data_center/contracts.json';
    seedThenExternal(KEY, [{ id: 'c1', name: 'one' }], [{ id: 'c1', name: 'one' }, { id: 'c-ext', name: 'ext' }]);
    const token = `Bearer ${signToken({ username: 'sa', domain: 'corp', role: 'SuperAdmin', groups: [] })}`;
    const r = await request(app).post('/api/rack/contracts').set('Authorization', token).send({ name: 'new', type: 'license' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(row(KEY).map(c => c.id).slice(0, 2), ['c1', 'c-ext']);
    assert.equal(row(KEY).length, 3);
});
