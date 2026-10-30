// Phase 2: the former append-only log documents live in SQL tables (services/logTables.js).
//  - migration: original order, entry timestamps kept, idempotent, legacy document untouched, marker (row + document),
//    two processes migrating at once (child processes) import exactly once
//  - readers return what the old document logic returned for the same data (golden comparisons)
//  - writers append rows; retention prune (age + row cap, waiting approvals kept)
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const dbMod = require('../../lib/db');
const logTables = require('../../services/logTables');
const cmdbMetaStore = require('../../lib/cmdbMetaStore');
const schedulerStore = require('../../lib/schedulerStore');
const dnsDataStore = require('../../lib/dnsDataStore');
const wf = require('../../lib/workflow');
const { modeOf } = require('../../lib/docRegistry');

const KEYS = {
    scheduler_logs: 'server_operation/scheduler_logs.json',
    cmdb_history: 'server_operation/server_cmdb_history.json',
    dns_changes: 'dns_changes.json',
    workflow_executions: 'workflow_executions.json',
    workflow_history: 'workflow_history.json',
};

/** A fresh, empty in-memory table database; the given legacy documents are what the migration will read. */
function freshTables(docs = {}) {
    for (const [name, key] of Object.entries(KEYS)) dbMod.writeDataSync(key, docs[name] || []);
    const h = new DatabaseSync(':memory:');
    logTables._testHooks.handle = h;
    return h;
}
test.afterEach(() => { logTables._testHooks.handle = null; });
test.before(async () => { await require('../../services/db').initDB(); });
test.after(async () => { await require('../../services/db').closeDB(); });

const clone = (v) => JSON.parse(JSON.stringify(v));
const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString();

// ---- fixtures: documents as the old code wrote them ------------------------------------------------------------
function schedulerDoc(n = 250) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({ id: String(1000 + i), taskId: `t${i % 4}`, taskName: `Task ${i % 4}`, runTime: day(i % 30), runStatus: i % 3 ? 'Success' : 'Failed',
            stdout: `out ${i}`, stderr: '', executionTimeMs: i * 10 });
    }
    // entries with the fields the stats endpoint reads (older entry format)
    out.push({ taskName: 'Legacy', status: 'Success', duration: '1m 5s', timestamp: day(3) });
    out.push({ taskName: 'Legacy', status: 'Failed', duration: '7s', timestamp: day(9) });
    out.push({ status: 'Success' }); // no task id / name: skipped by the stats
    return out;
}
function cmdbDoc() { // newest first
    const ips = ['192.0.2.1', '192.0.2.2', '192.0.2.3'];
    const out = [];
    for (let i = 40; i >= 0; i--) {
        out.push({ id: `h${i}`, ip: ips[i % 3], username: i % 2 ? 'alice' : 'SYSTEM', action: i % 5 === 0 ? 'Global Auto-Sync' : 'UPDATE',
            timestamp: day(i), oldData: { a: i }, newData: { a: i + 1 } });
    }
    out.splice(3, 0, { id: 'noaction', ip: '192.0.2.1', username: 'bob', timestamp: day(50), oldData: {}, newData: {} });
    out.splice(5, 0, { id: 'numip', ip: 1234, action: 'UPDATE', timestamp: day(51) });
    return out;
}
function dnsDoc() { // newest first
    const out = [];
    for (let i = 0; i < 30; i++) out.push({ timestamp: `2026-03-${String(1 + (i % 28)).padStart(2, '0')} 10:0${i % 10}:00`, user: i % 2 ? 'alice' : 'bob', action: `change ${i}` });
    return out.reverse();
}
function executionsDoc() { // stored order (oldest saved first)
    return [
        { id: 'e1', workflowId: 'w1', status: 'success', startedAt: '2026-02-01T10:00:00.000Z' },
        { id: 'e2', workflowId: 'w2', status: 'failed', startedAt: '2026-02-03T10:00:00.000Z' },
        { id: 'e3', workflowId: 'w1', status: 'waiting_approval', startedAt: '2026-02-02T10:00:00.000Z' },
        { id: 'e4', workflowId: 'w1', status: 'success', startedAt: '2026-02-02T10:00:00.000Z' }, // tie with e3
        { id: 'e5', workflowId: 'w1', status: 'rejected', startedAt: '2026-02-05T10:00:00.000Z' },
        { id: 'e6', workflowId: 'w3', status: 'success', startedAt: '2026-01-05T10:00:00.000Z' },
    ];
}
function historyDoc() {
    return [
        { id: 'w1', version: 1, name: 'one', updatedAt: day(1) },
        { id: 'w2', version: 1, name: 'two', updatedAt: day(2) },
        { id: 'w1', version: 2, name: 'one b', updatedAt: day(3) },
        { id: 'w1', version: 3, name: 'one c', createdAt: day(1) },
    ];
}

// ---- the old reader logic (verbatim from the former routes / modules) ------------------------------------------
const old = {
    schedulerLogs: (logs) => clone(logs).reverse().slice(0, 200),
    schedulerStats: (logs) => {
        const stats = {};
        logs.forEach(log => {
            const taskId = log.taskId || log.taskName;
            if (!taskId) return;
            if (!stats[taskId]) stats[taskId] = { total: 0, success: 0, failed: 0, totalDuration: 0, lastRun: null };
            stats[taskId].total += 1;
            if (log.status === 'Success') stats[taskId].success += 1;
            else if (log.status === 'Failed') stats[taskId].failed += 1;
            if (log.duration) {
                const parts = log.duration.split(' ');
                let secs = 0;
                parts.forEach(p => { if (p.endsWith('m')) secs += parseInt(p) * 60; if (p.endsWith('s')) secs += parseInt(p); });
                stats[taskId].totalDuration += secs;
            }
            if (!stats[taskId].lastRun || new Date(log.timestamp) > new Date(stats[taskId].lastRun)) stats[taskId].lastRun = log.timestamp;
        });
        return JSON.parse(JSON.stringify(stats)); // what res.json sends
    },
    cmdbByIp: (history, ip) => history.filter(h => h.ip === ip),
    hostTool: (history, ips, limit) => history.filter(h => ips.has(h.ip) && h.action !== 'Global Auto-Sync').slice(0, limit),
    dnsLogs: (logs) => logs,
    executions: (list, workflowId, limit = 20) => clone(list).filter(e => !workflowId || e.workflowId === workflowId)
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, limit),
    execution: (list, id) => list.find(e => e.id === id) || null,
    wfHistory: (list, id) => list.filter(h => h.id === id),
};

// ---- registry ---------------------------------------------------------------------------------------------------

test('the former log documents are legacy in the registry, the marker document is replace', () => {
    for (const key of Object.values(KEYS)) assert.equal(modeOf(key), 'legacy', key);
    assert.equal(modeOf(logTables.MARKER_KEY), 'replace');
    assert.deepEqual(Object.keys(logTables.TABLES).sort(), Object.keys(KEYS).sort());
    for (const [name, d] of Object.entries(logTables.TABLES)) assert.equal(d.legacyKey, KEYS[name]);
});

// ---- migration --------------------------------------------------------------------------------------------------

test('migration copies every document in its original order, keeps timestamps and the documents, records the count', () => {
    const docs = { scheduler_logs: schedulerDoc(20), cmdb_history: cmdbDoc(), dns_changes: dnsDoc(), workflow_executions: executionsDoc(), workflow_history: historyDoc() };
    const h = freshTables(docs);
    const res = logTables.migrateAll();
    assert.deepEqual(res.map(r => [r.table, r.skipped, r.count]), Object.keys(logTables.TABLES).map(t => [t, false, docs[t].length]));

    // id order = the old array order (newest-first documents are stored reversed)
    const entries = (t) => h.prepare(`SELECT entry FROM ${t} ORDER BY id`).all().map(r => JSON.parse(r.entry));
    assert.deepEqual(entries('scheduler_logs'), docs.scheduler_logs);
    assert.deepEqual(entries('cmdb_history'), clone(docs.cmdb_history).reverse());
    assert.deepEqual(entries('dns_changes'), clone(docs.dns_changes).reverse());
    assert.deepEqual(entries('workflow_executions'), docs.workflow_executions);
    assert.deepEqual(entries('workflow_history'), docs.workflow_history);

    // created_at = the entry's own timestamp
    const created = (t) => h.prepare(`SELECT created_at FROM ${t} ORDER BY id`).all().map(r => r.created_at);
    // (entries without a timestamp get the migration time, so retention can still age them out)
    created('scheduler_logs').forEach((c, i) => assert.equal(c, docs.scheduler_logs[i].runTime || c));
    assert.ok(created('scheduler_logs').every(c => !Number.isNaN(Date.parse(c))));
    assert.deepEqual(created('cmdb_history'), clone(docs.cmdb_history).reverse().map(e => e.timestamp));
    assert.deepEqual(created('workflow_executions'), docs.workflow_executions.map(e => e.startedAt));
    assert.deepEqual(created('workflow_history'), docs.workflow_history.map(e => e.updatedAt || e.createdAt));
    assert.equal(created('dns_changes')[0], logTables.zonedToIso(docs.dns_changes[docs.dns_changes.length - 1].timestamp, process.env.TZ || 'Asia/Taipei'));

    // legacy documents untouched (rollback path)
    for (const [name, key] of Object.entries(KEYS)) assert.deepEqual(dbMod.readDataSync(key, []), docs[name], key);

    // markers: authoritative row (same database) + informational document
    assert.equal(logTables.readMarker(h, 'cmdb_history').count, docs.cmdb_history.length);
    const info = dbMod.readDataSync(logTables.MARKER_KEY, {});
    assert.equal(info.scheduler_logs.count, docs.scheduler_logs.length);
    assert.equal(info.dns_changes.sourceKey, 'dns_changes.json');
});

test('migration is idempotent: a second run (also after a cache reset / restart) imports nothing', () => {
    const h = freshTables({ scheduler_logs: schedulerDoc(5), cmdb_history: cmdbDoc() });
    logTables.migrateAll();
    const count = () => h.prepare('SELECT COUNT(*) AS c FROM cmdb_history').get().c;
    const before = count();
    assert.ok(logTables.migrateAll().every(r => r.skipped));
    logTables._resetCache(h); // as a restarted process: only the marker row decides
    dbMod.writeDataSync(KEYS.cmdb_history, cmdbDoc().concat(cmdbDoc()));
    assert.ok(logTables.migrateAll().every(r => r.skipped));
    assert.equal(count(), before);
});

test('readers and writers migrate lazily first (no startup call needed), writes land after the imported entries', () => {
    const doc = schedulerDoc(3);
    freshTables({ scheduler_logs: doc });
    const entry = { id: 'new', taskId: 't9', runTime: new Date().toISOString() };
    schedulerStore.appendLog(entry);
    assert.deepEqual(schedulerStore.listRecentLogs(200), old.schedulerLogs(doc.concat([entry])));
});

test('two processes migrating at the same time import every document exactly once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-logmig-'));
    const local = new DatabaseSync(path.join(dir, 'database.sqlite'));
    local.exec('CREATE TABLE document_store (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)');
    const docs = { scheduler_logs: schedulerDoc(400), cmdb_history: cmdbDoc(), dns_changes: dnsDoc(), workflow_executions: executionsDoc(), workflow_history: historyDoc() };
    for (const [name, key] of Object.entries(KEYS)) local.prepare('INSERT INTO document_store (key, value) VALUES (?, ?)').run(key, JSON.stringify(docs[name], null, 2));
    local.close();
    const child = path.join(__dirname, 'fixtures', 'logTablesMigrateChild.js');
    const runChild = () => new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [child], { env: { ...process.env, DB_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { err += d; });
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.slice(out.indexOf('{"res"')))) : reject(new Error(`child exit ${code}: ${err}`))));
    });
    const [a, b] = await Promise.all([runChild(), runChild()]);
    for (const [name, rows] of Object.entries(docs)) {
        assert.equal(a.counts[name], rows.length, name);
        assert.equal(b.counts[name], rows.length, name);
        // exactly one of the two imported it, the other saw the marker
        const did = [a, b].map(r => r.res.find(x => x.table === name)).filter(x => !x.skipped);
        assert.equal(did.length, 1, `${name}: ${JSON.stringify([a.res, b.res])}`);
        assert.equal(did[0].count, rows.length);
    }
    fs.rmSync(dir, { recursive: true, force: true });
});

// ---- golden comparisons: same data -> same response as the old document logic -----------------------------------

test('scheduler: GET /logs (newest 200) and the stats input equal the old document logic', () => {
    const doc = schedulerDoc(250);
    freshTables({ scheduler_logs: doc });
    assert.deepEqual(schedulerStore.listRecentLogs(200), old.schedulerLogs(doc));
    assert.deepEqual(old.schedulerStats(schedulerStore.listLogsForStats()), old.schedulerStats(doc));
    // the stats input only drops stdout / stderr
    assert.deepEqual(schedulerStore.listLogsForStats(), doc.map(({ stdout, stderr, ...rest }) => rest));
});

test('CMDB history: per-IP list (Server List) and the agent tool query equal the old document logic', () => {
    const doc = cmdbDoc();
    freshTables({ cmdb_history: doc });
    for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.9']) assert.deepEqual(cmdbMetaStore.readHistory({ ip, limit: 2000 }), old.cmdbByIp(doc, ip), ip);
    for (const limit of [10, 3, 1, 20]) {
        const ips = new Set(['192.0.2.1', '192.0.2.3']);
        assert.deepEqual(cmdbMetaStore.readHistory({ ips: [...ips], excludeAction: 'Global Auto-Sync', limit }), old.hostTool(doc, ips, limit), `limit ${limit}`);
    }
    assert.deepEqual(cmdbMetaStore.readHistory(), doc);
});

test('CMDB history: appendHistory gives the same newest-first order as the old unshift loop', () => {
    const doc = cmdbDoc();
    freshTables({ cmdb_history: doc });
    const batch = [{ id: 'n1', ip: '192.0.2.1' }, { id: 'n2', ip: '192.0.2.1' }];
    const expected = clone(doc);
    for (const e of batch) expected.unshift(clone(e));
    cmdbMetaStore.appendHistory(batch, 2000);
    cmdbMetaStore.appendHistory([]); // no-op
    assert.deepEqual(cmdbMetaStore.readHistory(), expected);
});

test('DNS change log: GET /logs and appends equal the old document logic (newest first, last 5000)', () => {
    const doc = dnsDoc();
    freshTables({ dns_changes: doc });
    assert.deepEqual(dnsDataStore.listDnsChanges(), old.dnsLogs(doc));
    const batch = [{ timestamp: '2026-04-01 09:00:00', user: 'carol', action: 'x1' }, { timestamp: '2026-04-01 09:00:00', user: 'carol', action: 'x2' }];
    const expected = clone(doc);
    expected.unshift(...clone(batch));
    dnsDataStore.appendDnsChanges(batch);
    assert.deepEqual(dnsDataStore.listDnsChanges(), expected);
    assert.equal(dnsDataStore.listDnsChanges(3).length, 3);
});

test('workflow executions: getExecutions (filters, ties, limits) and getExecution equal the old document logic', () => {
    const doc = executionsDoc();
    freshTables({ workflow_executions: doc });
    for (const wid of [undefined, 'w1', 'w2', 'nope']) {
        for (const limit of [20, 2, 1, -1, 0]) assert.deepEqual(wf.getExecutions(wid, limit), old.executions(doc, wid, limit), `${wid} ${limit}`);
    }
    assert.deepEqual(wf.getExecutions('w1'), old.executions(doc, 'w1'));
    for (const id of ['e1', 'e4', 'missing']) assert.deepEqual(wf.getExecution(id), old.execution(doc, id));
});

test('workflow executions: saving replaces in place and appends new ones (same order as the old merge by id)', () => {
    const doc = executionsDoc();
    freshTables({ workflow_executions: doc });
    const expected = clone(doc);
    const upd = { ...doc[2], status: 'success', completedAt: '2026-02-02T11:00:00.000Z' };
    expected[2] = upd;
    const added = { id: 'e7', workflowId: 'w1', status: 'running', startedAt: '2026-02-02T10:00:00.000Z' };
    expected.push(added);
    wf.executionLimits.cap = 1000;
    require('../../services/logTables').saveExecution(upd, 1000);
    require('../../services/logTables').saveExecution(added, 1000);
    assert.deepEqual(wf.getExecutions(undefined, 100), old.executions(expected, undefined, 100));
    assert.equal(wf.getExecution('e3').status, 'success');
});

test('workflow history: per-workflow list, the 10-version trim and delete equal the old document logic', () => {
    const doc = historyDoc();
    freshTables({ workflow_history: doc });
    for (const id of ['w1', 'w2', 'w9']) assert.deepEqual(wf.getWorkflowHistory(id), old.wfHistory(doc, id));
    // updateWorkflow keeps at most 10 snapshots per workflow (removes that workflow's oldest one)
    dbMod.writeDataSync('workflows.json', [{ id: 'w1', name: 'one', version: 3, nodes: [], edges: [] }]);
    // the old logic on the document: push the pre-update snapshot, drop this workflow's oldest when > 10
    const simulated = clone(doc);
    for (let i = 0; i < 9; i++) {
        simulated.push({ id: 'w1', version: 3 + i });
        const mine = simulated.filter(h => h.id === 'w1');
        if (mine.length > 10) simulated.splice(simulated.indexOf(mine[0]), 1);
        wf.updateWorkflow('w1', { name: `rename ${i}` });
    }
    const list = wf.getWorkflowHistory('w1');
    assert.equal(list.length, 10);
    assert.deepEqual(list.map(h => h.version), simulated.filter(h => h.id === 'w1').map(h => h.version));
    assert.deepEqual(wf.getWorkflowHistory('w2'), old.wfHistory(doc, 'w2'), 'other workflows untouched');
    wf.deleteWorkflow('w1');
    assert.deepEqual(wf.getWorkflowHistory('w1'), []);
    assert.equal(wf.getWorkflowHistory('w2').length, 1);
});

// ---- retention ----------------------------------------------------------------------------------------------------

test('retention days come from .env (RETENTION_*_DAYS), defaults 90 / 365, 0 disables the age limit', () => {
    assert.equal(logTables.retentionDays('scheduler_logs', {}), 90);
    assert.equal(logTables.retentionDays('workflow_executions', {}), 90);
    // version snapshots: no age limit by default (max 10 per workflow + the row cap bound the table)
    assert.equal(logTables.retentionDays('workflow_history', {}), 0);
    assert.equal(logTables.retentionDays('cmdb_history', {}), 365);
    assert.equal(logTables.retentionDays('dns_changes', {}), 365);
    assert.equal(logTables.retentionDays('dns_changes', { RETENTION_DNS_CHANGES_DAYS: '30' }), 30);
    assert.equal(logTables.retentionDays('cmdb_history', { RETENTION_CMDB_HISTORY_DAYS: '0' }), 0);
    assert.equal(logTables.retentionDays('scheduler_logs', { RETENTION_SCHEDULER_LOGS_DAYS: 'abc' }), 90);
    assert.equal(logTables.retentionDays('scheduler_logs', { RETENTION_SCHEDULER_LOGS_DAYS: '-5' }), 90);
});

test('prune removes rows older than the retention window and the oldest rows above the cap, in batches', async () => {
    freshTables();
    const now = Date.parse('2026-10-30T00:00:00.000Z');
    const ago = (d) => new Date(now - d * 86400000).toISOString();
    logTables.append('scheduler_logs', [...Array(30)].map((_, i) => ({ id: `old${i}`, runTime: ago(100 + i) })));
    logTables.append('scheduler_logs', [...Array(12)].map((_, i) => ({ id: `new${i}`, runTime: ago(10 - (i % 5)) })));
    logTables.append('cmdb_history', [{ id: 'c-old', timestamp: ago(400) }, { id: 'c-mid', timestamp: ago(200) }]);
    const res = await logTables.prune({ now, batchSize: 7, caps: { scheduler_logs: 10 }, env: {} });
    assert.deepEqual(res.scheduler_logs, { aged: 30, capped: 2 });
    assert.deepEqual(schedulerStore.listRecentLogs(200).map(l => l.id), ['new11', 'new10', 'new9', 'new8', 'new7', 'new6', 'new5', 'new4', 'new3', 'new2']);
    assert.deepEqual(res.cmdb_history, { aged: 1, capped: 0 });
    assert.deepEqual(cmdbMetaStore.readHistory().map(h => h.id), ['c-mid']);

    // 0 days = no age limit
    logTables.append('cmdb_history', [{ id: 'c-older', timestamp: ago(4000) }]);
    const keep = await logTables.prune({ now, tables: ['cmdb_history'], env: { RETENTION_CMDB_HISTORY_DAYS: '0' } });
    assert.deepEqual(keep.cmdb_history, { aged: 0, capped: 0 });
    // bounded work per run
    const bounded = await logTables.prune({ now, tables: ['cmdb_history'], batchSize: 1, maxBatches: 1, env: { RETENTION_CMDB_HISTORY_DAYS: '1' } });
    assert.deepEqual(bounded.cmdb_history, { aged: 1, capped: 0 });
});

test('prune never removes executions waiting for approval (age or cap)', async () => {
    freshTables();
    const now = Date.parse('2026-10-30T00:00:00.000Z');
    const ago = (d) => new Date(now - d * 86400000).toISOString();
    for (const [id, status, d] of [['w-old', 'waiting_approval', 300], ['s-old', 'success', 300], ['s1', 'success', 1], ['s2', 'failed', 1], ['w2', 'waiting_approval', 1]]) {
        logTables.saveExecution({ id, workflowId: 'w', status, startedAt: ago(d) }, 1000);
    }
    const res = await logTables.prune({ now, tables: ['workflow_executions'], caps: { workflow_executions: 2 }, env: {} });
    assert.deepEqual(res.workflow_executions, { aged: 1, capped: 2 });
    assert.deepEqual(wf.getExecutions('w', 50).map(e => e.id).sort(), ['w-old', 'w2']);
});

test('zonedToIso converts the DNS log wall-clock timestamps', () => {
    assert.equal(logTables.zonedToIso('2026-03-01 10:00:00', 'Asia/Taipei'), '2026-03-01T02:00:00.000Z');
    assert.equal(logTables.zonedToIso('2026-03-01 10:00:00', 'UTC'), '2026-03-01T10:00:00.000Z');
    assert.equal(logTables.zonedToIso('2026-03-01T10:00:00.000Z', 'Asia/Taipei'), '2026-03-01T10:00:00.000Z');
    assert.equal(logTables.zonedToIso('garbage', 'UTC'), null);
});
