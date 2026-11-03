// Database pages: target policy, SQL Terminal guard and masking, real backup records, provisioning, schema diff, metrics.
const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { DatabaseSync } = require('node:sqlite');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync, writeDataSync } = require('../../lib/db');
const { encryptText } = require('../../lib/crypto');
const dbBackupCommand = require('../../lib/dbBackupCommand');

const ENV_KEY = 'system/environments.json';
const DBINV_KEY = 'service_platform/database_clusters.json';
const DBREQ_KEY = 'service_platform/database_requests.json';
const BACKUP_KEY = 'service_platform/database_backups.json';
const SCHEDULE_KEY = 'service_platform/database_backup_schedule.json';
const FEATURES = { database: true, dbInventory: true, dbPerformance: true, dbProvision: true, dbBackup: true, dbSqlTerminal: true };

const tok = (username, role) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['g'] })}`;
const admin = tok('admin1', 'SuperAdmin');
const op = tok('op1', 'Operator');
const SQLITE_ROOT = path.join(dataDir, 'data');
let app;
let router;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: FEATURES } },
    });
    writeDataSync(ENV_KEY, [{ id: 'dev-id', name: 'Dev' }]);
    fs.mkdirSync(SQLITE_ROOT, { recursive: true });
    router = require('../../routes/database');
    app = express();
    app.use(express.json());
    app.use('/api/database', router);
});
test.after(async () => { dbBackupCommand.setRunnerForTest(null); await dbManager.closeDB(); });

const as = (method, url, token) => request(app)[method](url).set('Authorization', token);

function makeSqlite(name, statements = []) {
    const file = path.join(SQLITE_ROOT, name);
    fs.rmSync(file, { force: true });
    const db = new DatabaseSync(file);
    try { statements.forEach(s => db.exec(s)); } finally { db.close(); }
    return file;
}

const sqliteRecord = (id, file) => ({ id, name: id, environment: 'Dev', envId: 'dev-id', engine: 'SQLite', host: 'localhost', port: null, database: file, username: 'sqlite', password_enc: null });
const mysqlRecord = (id) => ({ id, name: id, environment: 'Dev', envId: 'dev-id', engine: 'MySQL', host: 'db01.example.test', port: 3306, database: 'app', username: 'u', password_enc: encryptText('pw') });

async function waitFor(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error('timed out waiting');
        await new Promise(r => setTimeout(r, 20));
    }
}

test('inventory: shell characters and SQLite paths outside the root are refused; relative SQLite paths resolve into the root', async () => {
    const base = { name: 'm', envId: 'dev-id', engine: 'MySQL', host: 'db01', port: 3306, database: 'app', username: 'u', password: 'pw' };
    const bad = await as('post', '/api/database/inventory', op).send({ ...base, host: 'db01 & calc' }).expect(400);
    assert.match(bad.body.error, /主機格式/);
    await as('post', '/api/database/inventory', op).send({ ...base, database: '--all-databases' }).expect(400);
    await as('post', '/api/database/inventory', op).send({ ...base, engine: 'SQLite', filePath: '../database.sqlite' }).expect(400);
    await as('post', '/api/database/inventory', op).send({ ...base, engine: 'SQLite', filePath: path.join(dataDir, 'database.sqlite') }).expect(400);

    const res = await as('post', '/api/database/inventory', op).send({ ...base, engine: 'SQLite', filePath: 'rel.db' }).expect(200);
    const saved = readDataSync(DBINV_KEY, []).find(d => d.id === res.body.id);
    assert.equal(path.basename(saved.database), 'rel.db');
    assert.ok(path.isAbsolute(saved.database));
});

test('records saved before the policy existed are refused at use time', async () => {
    writeDataSync(DBINV_KEY, [sqliteRecord('legacy', path.join(dataDir, 'database.sqlite')), { ...mysqlRecord('evil'), host: 'x & calc' }]);
    const q = await as('post', '/api/database/query', op).send({ id: 'legacy', query: 'SELECT 1' }).expect(400);
    assert.match(q.body.error, /允許的目錄|Vanguard/);
    await as('post', '/api/database/backups/create', op).send({ dbId: 'evil', type: 'full' }).expect(400);
    await as('post', '/api/database/test-connection', op).send({ id: 'evil' }).expect(400);
});

test('SQL Terminal: read-only guard, DB errors returned, masking that only SuperAdmin can lift', async () => {
    const file = makeSqlite('term.db', [
        'CREATE TABLE users (id INTEGER, name TEXT, password TEXT, contact TEXT)',
        "INSERT INTO users VALUES (1, 'alice', 'hunter2', 'alice@example.com')",
    ]);
    writeDataSync(DBINV_KEY, [sqliteRecord('t1', file)]);

    const blocked = await as('post', '/api/database/query', op).send({ id: 't1', query: 'SELECT 1; DROP TABLE users' }).expect(403);
    assert.match(blocked.body.error, /one statement/);
    await as('post', '/api/database/query', op).send({ id: 't1', query: 'DELETE FROM users' }).expect(403);

    const syntax = await as('post', '/api/database/query', op).send({ id: 't1', query: 'SELECT nope FROM users' }).expect(400);
    assert.match(syntax.body.error, /nope/);

    const masked = await as('post', '/api/database/query', op).send({ id: 't1', query: 'SELECT name, password AS p, contact FROM users -- trailing', showRaw: true }).expect(200);
    assert.equal(masked.body.rows[0].p, '******', 'Operator cannot unmask');
    assert.equal(masked.body.rows[0].contact, 'a***e@example.com');
    assert.equal(masked.body.canUnmask, false);

    const raw = await as('post', '/api/database/query', admin).send({ id: 't1', query: 'SELECT name, password AS p FROM users', showRaw: true }).expect(200);
    assert.equal(raw.body.rows[0].p, 'hunter2');
    assert.equal(raw.body.canUnmask, true);

    const pragma = await as('post', '/api/database/query', op).send({ id: 't1', query: 'PRAGMA table_info(users)' }).expect(200);
    assert.equal(pragma.body.rows.length, 4, 'PRAGMA is not wrapped in SELECT * FROM (...)');
});

test('backups: SQLite backup is a real file, completes, can be deleted with its file', async () => {
    const file = makeSqlite('bk.db', ['CREATE TABLE t (x INTEGER)', 'INSERT INTO t VALUES (1)']);
    writeDataSync(DBINV_KEY, [sqliteRecord('s1', file)]);
    writeDataSync(BACKUP_KEY, []);

    const created = await as('post', '/api/database/backups/create', op).send({ dbId: 's1', type: 'full' }).expect(200);
    assert.equal(created.body.backup.status, 'running');
    const done = await waitFor(async () => {
        const list = (await as('get', '/api/database/backups/s1', op).expect(200)).body.backups;
        return list.find(b => b.status !== 'running');
    });
    assert.equal(done.status, 'completed');
    assert.equal(done.restorable, true);
    assert.match(done.size, /MB$/);
    assert.ok(fs.existsSync(done.file));

    await as('post', '/api/database/backups/create', op).send({ dbId: 's1', type: 'incremental' }).expect(400);
    await as('delete', `/api/database/backups/${done.id}`, admin).expect(200);
    assert.equal(fs.existsSync(done.file), false);
});

test('backups: MySQL runs the tool, failures are recorded, one backup per DB at a time', async () => {
    writeDataSync(DBINV_KEY, [mysqlRecord('m1')]);
    writeDataSync(BACKUP_KEY, []);
    let release;
    const gate = new Promise(r => { release = r; });
    const calls = [];
    dbBackupCommand.setRunnerForTest(async ({ cmd, args }) => {
        calls.push({ cmd, args });
        await gate;
        const out = args.find(a => a.startsWith('--result-file=')).slice('--result-file='.length);
        fs.writeFileSync(out, '-- dump');
        return {};
    });
    await as('post', '/api/database/backups/create', op).send({ dbId: 'm1', type: 'full' }).expect(200);
    await as('post', '/api/database/backups/create', op).send({ dbId: 'm1', type: 'full' }).expect(409);
    release();
    const ok = await waitFor(async () => (await as('get', '/api/database/backups/m1', op)).body.backups.find(b => b.status === 'completed'));
    assert.equal(calls[0].cmd, 'mysqldump');
    assert.ok(!calls[0].args.some(a => a.includes('pw') && !a.startsWith('--defaults-extra-file')), 'password not on the command line');
    assert.equal(ok.restorable, true);

    dbBackupCommand.setRunnerForTest(async () => { throw new Error('mysqldump exited with code 2: Access denied'); });
    await as('post', '/api/database/backups/create', op).send({ dbId: 'm1', type: 'full' }).expect(200);
    const failed = await waitFor(async () => (await as('get', '/api/database/backups/m1', op)).body.backups.find(b => b.status === 'failed'));
    assert.match(failed.error, /Access denied/);
    assert.equal(failed.restorable, false);
    await as('post', `/api/database/backups/restore/${failed.id}`, admin).expect(400);
    dbBackupCommand.setRunnerForTest(null);
});

test('backups: old simulated records are flagged and cannot be restored', async () => {
    writeDataSync(DBINV_KEY, [mysqlRecord('m2')]);
    writeDataSync(BACKUP_KEY, [{ id: 'snap-old', dbId: 'm2', type: 'full', size: '123 MB (Simulated)', duration: '20s (Simulated)', status: 'completed', createdBy: 'system_scheduler', timestamp: new Date().toISOString() }]);
    const list = (await as('get', '/api/database/backups/m2', op).expect(200)).body.backups;
    assert.equal(list[0].simulated, true);
    assert.equal(list[0].restorable, false);
    const res = await as('post', '/api/database/backups/restore/snap-old', admin).expect(400);
    assert.match(res.body.error, /模擬/);
});

test('backups: restore of a SQLite snapshot writes the file back and records the outcome', async () => {
    const file = makeSqlite('rs.db', ['CREATE TABLE t (x INTEGER)']);
    writeDataSync(DBINV_KEY, [sqliteRecord('s2', file)]);
    writeDataSync(BACKUP_KEY, []);
    await as('post', '/api/database/backups/create', op).send({ dbId: 's2' }).expect(200);
    const done = await waitFor(async () => (await as('get', '/api/database/backups/s2', op)).body.backups.find(b => b.status === 'completed'));
    fs.writeFileSync(file, '');
    await as('post', `/api/database/backups/restore/${done.id}`, admin).expect(200);
    const restored = await waitFor(async () => (await as('get', '/api/database/backups/s2', op)).body.backups.find(b => b.restore && b.restore.status !== 'running'));
    assert.equal(restored.restore.status, 'completed');
    assert.ok(fs.statSync(file).size > 0);
});

test('scheduled backups: off unless DB_BACKUP_SCHEDULE is set, once per day, only inside the hour after the set time', async () => {
    const file = makeSqlite('sched.db', ['CREATE TABLE t (x INTEGER)']);
    writeDataSync(DBINV_KEY, [sqliteRecord('s3', file)]);
    writeDataSync(BACKUP_KEY, []);
    writeDataSync(SCHEDULE_KEY, {});
    const { runScheduledBackups } = router._test;
    const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };

    delete process.env.DB_BACKUP_SCHEDULE;
    assert.equal((await runScheduledBackups(at(2, 30))).ran, false);
    process.env.DB_BACKUP_SCHEDULE = '02:00';
    try {
        assert.equal((await runScheduledBackups(at(5, 0))).ran, false, 'restart later in the day does not run it');
        const first = await runScheduledBackups(at(2, 30));
        assert.equal(first.ran, true);
        assert.equal(first.completed, 1);
        assert.equal((await runScheduledBackups(at(2, 31))).ran, false, 'once per day');
        const records = readDataSync(BACKUP_KEY, []);
        assert.equal(records.length, 1);
        assert.equal(records[0].createdBy, 'system_scheduler');
        assert.ok(fs.existsSync(records[0].file));
    } finally {
        delete process.env.DB_BACKUP_SCHEDULE;
    }
});

test('provisioning: name validated, SQLite approval creates a real file, a request is processed once', async () => {
    writeDataSync(DBINV_KEY, []);
    writeDataSync(DBREQ_KEY, []);
    await as('post', '/api/database/provision', op).send({ name: '../evil', engine: 'SQLite', envId: 'dev-id', size: 'Small' }).expect(400);

    const sqliteReq = (await as('post', '/api/database/provision', op).send({ name: 'newapp', engine: 'SQLite', envId: 'dev-id', size: 'Small' }).expect(200)).body.request;
    const approved = (await as('put', `/api/database/provision/${sqliteReq.id}/status`, admin).send({ status: 'approved' }).expect(200)).body.request;
    const conn = readDataSync(DBINV_KEY, []).find(d => d.id === approved.connectionId);
    assert.ok(conn && fs.existsSync(conn.database));
    assert.equal(path.basename(conn.database), 'newapp.db');
    await as('put', `/api/database/provision/${sqliteReq.id}/status`, admin).send({ status: 'approved' }).expect(409);

    const mysqlReq = (await as('post', '/api/database/provision', op).send({ name: 'erp', engine: 'MySQL', envId: 'dev-id', size: 'Small' }).expect(200)).body.request;
    const mysqlApproved = (await as('put', `/api/database/provision/${mysqlReq.id}/status`, admin).send({ status: 'approved' }).expect(200)).body.request;
    assert.match(mysqlApproved.provisionNote, /DBA/);
    assert.equal(readDataSync(DBINV_KEY, []).length, 1, 'no placeholder connection for server engines');
});

test('schema diff: an unreadable or empty side is reported, never "identical"', async () => {
    const full = makeSqlite('full.db', ['CREATE TABLE a (id INTEGER, name TEXT)']);
    const empty = makeSqlite('empty.db');
    writeDataSync(DBINV_KEY, [sqliteRecord('full', full), sqliteRecord('empty', empty)]);

    const fromEmpty = (await as('post', '/api/database/schema-diff', op).send({ sourceId: 'empty', targetId: 'full' }).expect(200)).body;
    assert.ok(fromEmpty.warnings.some(w => /來源/.test(w)));
    assert.doesNotMatch(fromEmpty.migrationSql, /完全一致/);

    const toEmpty = (await as('post', '/api/database/schema-diff', op).send({ sourceId: 'full', targetId: 'empty' }).expect(200)).body;
    assert.equal(toEmpty.diffSummary.missingTablesCount, 1);
    assert.ok(toEmpty.warnings.some(w => /目標/.test(w)));

    const same = (await as('post', '/api/database/schema-diff', op).send({ sourceId: 'full', targetId: 'full' }).expect(200)).body;
    assert.deepEqual(same.warnings, []);
    assert.match(same.migrationSql, /完全一致/);
});

test('metrics and health report real values, not random numbers', async () => {
    const file = makeSqlite('mx.db', ['CREATE TABLE big (x TEXT)', "INSERT INTO big VALUES ('" + 'x'.repeat(5000) + "')", 'CREATE TABLE small (y INTEGER)']);
    writeDataSync(DBINV_KEY, [sqliteRecord('mx', file), sqliteRecord('gone', path.join(SQLITE_ROOT, 'missing.db'))]);
    router._test.metricsCache.clear();

    const m = (await as('get', '/api/database/metrics/mx', op).expect(200)).body.metrics;
    assert.equal(m.reachable, true);
    assert.equal(typeof m.latencyMs, 'number');
    assert.equal(m.cpuUsage, undefined, 'no invented CPU figure');
    const gone = (await as('get', '/api/database/metrics/gone', op).expect(200)).body.metrics;
    assert.equal(gone.reachable, false);
    assert.match(gone.error, /不存在/);

    const h = (await as('get', '/api/database/health/mx', op).expect(200)).body.health;
    assert.deepEqual(h.topTables.map(t => t.tableName).sort(), ['big', 'small']);
    if (!h.note) assert.ok(Number(h.topTables.find(t => t.tableName === 'big').sizeKb) > Number(h.topTables.find(t => t.tableName === 'small').sizeKb));
    await as('get', '/api/database/health/gone', op).expect(502);
});

const dbClient = require('../../lib/dbClient');

function fakeMysql(handler) {
    const log = { sql: [], closed: 0 };
    dbClient.setDriversForTest({
        mysql: {
            createConnection: async () => ({
                query: async (q) => { const s = typeof q === 'string' ? q : q.sql; log.sql.push(s); return [handler(s) || []]; },
                ping: async () => {},
                end: async () => { log.closed++; },
            }),
        },
        pg: {}, mssql: {},
    });
    return log;
}

test('SQL Terminal: more than 1000 rows are cut with a flag, JOINs need no LIMIT', async () => {
    const file = makeSqlite('many.db', [
        'CREATE TABLE n (id INTEGER, v TEXT)',
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1005) INSERT INTO n SELECT x, 'v' FROM c",
    ]);
    writeDataSync(DBINV_KEY, [sqliteRecord('many', file)]);
    const all = (await as('post', '/api/database/query', op).send({ id: 'many', query: 'SELECT * FROM n ORDER BY id' }).expect(200)).body;
    assert.equal(all.rowCount, 1000);
    assert.equal(all.truncated, true);
    // a column named like TOP / LIMIT no longer switches the cap off
    const named = (await as('post', '/api/database/query', op).send({ id: 'many', query: 'SELECT id AS laptop_stop FROM n' }).expect(200)).body;
    assert.equal(named.rowCount, 1000);
    const join = (await as('post', '/api/database/query', op).send({ id: 'many', query: 'SELECT * FROM n a JOIN n b ON a.id = b.id WHERE a.id < 3' }).expect(200)).body;
    assert.equal(join.rowCount, 2);
    assert.equal(join.truncated, false);
});

test('SQL Terminal on MySQL goes through dbClient: read-only, statement unchanged, connection closed', async () => {
    writeDataSync(DBINV_KEY, [mysqlRecord('mq')]);
    const log = fakeMysql((s) => (s.startsWith('SELECT name') ? [{ name: 'a', email: 'xy@example.com' }] : []));
    try {
        const res = (await as('post', '/api/database/query', op).send({ id: 'mq', query: 'SELECT name, email FROM users' }).expect(200)).body;
        assert.equal(res.rows[0].email, '***@example.com');
        assert.ok(log.sql.includes('START TRANSACTION READ ONLY'));
        assert.ok(log.sql.includes('SELECT name, email FROM users'));
        assert.equal(log.closed, 1);
    } finally {
        dbClient.setDriversForTest(null);
    }
});

test('processes and kill: kill mode per engine, ids validated', async () => {
    writeDataSync(DBINV_KEY, [mysqlRecord('mk'), sqliteRecord('sk', makeSqlite('k.db'))]);
    const log = fakeMysql((s) => (s === 'SHOW FULL PROCESSLIST' ? [{ Id: 7, User: 'app', Host: 'h', db: 'app', Command: 'Query', Time: 30, State: 'Sending', Info: 'SELECT 1' }] : []));
    try {
        const p = (await as('get', '/api/database/processes/mk', op).expect(200)).body;
        assert.equal(p.killMode, 'cancel-query');
        assert.equal(p.processes[0].id, 7);
        await as('post', '/api/database/kill-process', admin).send({ dbId: 'mk', processId: '7; DROP' }).expect(400);
        await as('post', '/api/database/kill-process', admin).send({ dbId: 'mk', processId: -1 }).expect(400);
        const k = (await as('post', '/api/database/kill-process', admin).send({ dbId: 'mk', processId: 7 }).expect(200)).body;
        assert.match(k.message, /cancelled/);
        assert.ok(log.sql.includes('KILL QUERY 7'));
        await as('post', '/api/database/kill-process', admin).send({ dbId: 'sk', processId: 1 }).expect(400);
        await as('post', '/api/database/kill-process', op).send({ dbId: 'mk', processId: 7 }).expect(403);
    } finally {
        dbClient.setDriversForTest(null);
    }
});

test('insights: SQLite explains there is nothing to show; MySQL reports a missing source as a note', async () => {
    writeDataSync(DBINV_KEY, [mysqlRecord('mi'), sqliteRecord('si', makeSqlite('i.db'))]);
    const s = (await as('get', '/api/database/insights/si', op).expect(200)).body;
    assert.equal(s.notes.length, 1);
    fakeMysql((q) => {
        if (/performance_schema/.test(q)) throw new Error('SELECT command denied');
        if (/innodb_lock_waits/.test(q)) return [{ waiting_pid: 5, waiting_query: 'UPDATE t', blocking_pid: 4, blocking_query: 'x', wait_age_secs: 12 }];
        return [];
    });
    try {
        const m = (await as('get', '/api/database/insights/mi', op).expect(200)).body;
        assert.deepEqual(m.slowQueries, []);
        assert.match(m.notes[0], /performance_schema/);
        assert.deepEqual(m.lockWaits[0], { waitingId: 5, waitingQuery: 'UPDATE t', blockingId: 4, blockingQuery: 'x', waitSec: 12 });
    } finally {
        dbClient.setDriversForTest(null);
    }
});

test('inventory: SQL Server certificate trust is stored per record, other engines never get it', async () => {
    writeDataSync(DBINV_KEY, []);
    const base = { name: 'ms', envId: 'dev-id', host: 'sql01\\INST1', database: 'app', username: 'u', password: 'pw', trustServerCertificate: true };
    const a = (await as('post', '/api/database/inventory', op).send({ ...base, engine: 'SQLServer' }).expect(200)).body.id;
    const b = (await as('post', '/api/database/inventory', op).send({ ...base, engine: 'MySQL', host: 'db01' }).expect(200)).body.id;
    const list = (await as('get', '/api/database/inventory', op).expect(200)).body.databases;
    assert.equal(list.find(d => d.id === a).trustServerCertificate, true);
    assert.equal(list.find(d => d.id === b).trustServerCertificate, false);
});

test('provisioning: reject reasons are stored as typed; older escaped ones are shown decoded', async () => {
    writeDataSync(DBREQ_KEY, [{ id: 'req-old', name: 'x', engine: 'MySQL', environment: 'Dev', envId: 'dev-id', size: 'S', status: 'rejected', requester: 'op1', rejectReason: 'use &lt;prod&gt;' }]);
    const req = (await as('post', '/api/database/provision', op).send({ name: 'y', engine: 'MySQL', envId: 'dev-id', size: 'S' }).expect(200)).body.request;
    await as('put', `/api/database/provision/${req.id}/status`, admin).send({ status: 'rejected', rejectReason: 'a < b & c' }).expect(200);
    const list = (await as('get', '/api/database/provision', op).expect(200)).body.requests;
    assert.equal(list.find(r => r.id === req.id).rejectReason, 'a < b & c');
    assert.equal(list.find(r => r.id === 'req-old').rejectReason, 'use <prod>');
});

test('backups: download is SuperAdmin only; settings report schedule and retention', async () => {
    const file = makeSqlite('dl.db', ['CREATE TABLE t (x INTEGER)']);
    writeDataSync(DBINV_KEY, [sqliteRecord('dl', file)]);
    writeDataSync(BACKUP_KEY, []);
    await as('post', '/api/database/backups/create', op).send({ dbId: 'dl' }).expect(200);
    const done = await waitFor(async () => (await as('get', '/api/database/backups/dl', op)).body.backups.find(b => b.status === 'completed'));
    await as('get', `/api/database/backups/${done.id}/download`, op).expect(403);
    const res = await as('get', `/api/database/backups/${done.id}/download`, admin)
        .buffer(true)
        .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); })
        .expect(200);
    assert.equal(res.body.subarray(0, 15).toString(), 'SQLite format 3');

    process.env.DB_BACKUP_SCHEDULE = '03:30';
    process.env.DB_BACKUP_RETENTION_DAYS = '14';
    try {
        const s = (await as('get', '/api/database/backup-settings', op).expect(200)).body;
        assert.equal(s.schedule, '03:30');
        assert.equal(s.retentionDays, 14);
    } finally {
        delete process.env.DB_BACKUP_SCHEDULE;
        delete process.env.DB_BACKUP_RETENTION_DAYS;
    }
});

test('backups: retention drops old records and files but keeps the newest completed backup of each DB', async () => {
    const backupDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const mk = (id, daysAgo, status, dbId = 'r1') => {
        const file = path.join(backupDir, `${id}.db`);
        fs.writeFileSync(file, 'x');
        return { id, dbId, engine: 'SQLite', type: 'full', status, timestamp: new Date(Date.now() - daysAgo * 86400000).toISOString(), file };
    };
    const records = [mk('old-a', 40, 'completed'), mk('old-b', 35, 'completed'), mk('old-fail', 30, 'failed'), mk('new', 1, 'completed'), mk('lonely', 90, 'completed', 'r2')];
    writeDataSync(BACKUP_KEY, records);
    const { pruneBackups } = router._test;

    delete process.env.DB_BACKUP_RETENTION_DAYS;
    assert.equal(pruneBackups().removed, 0, 'unset keeps everything');
    process.env.DB_BACKUP_RETENTION_DAYS = '7';
    try {
        assert.equal(pruneBackups().removed, 3);
    } finally {
        delete process.env.DB_BACKUP_RETENTION_DAYS;
    }
    const left = readDataSync(BACKUP_KEY, []).map(b => b.id).sort();
    assert.deepEqual(left, ['lonely', 'new'], 'r2 keeps its only (old) backup');
    assert.equal(fs.existsSync(records[0].file), false);
    assert.equal(fs.existsSync(records[3].file), true);
});
