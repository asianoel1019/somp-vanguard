// Server Provision Phase 4: jobs in the worker (IPC + web fallback), cross-process ownership, heartbeat, resume after restart.
// The "worker process" is a second, independent copy of services/provisionJobs (own live map, own identity, own slots)
// sharing the same SQLite handle, so claims and fences are exercised exactly as between two processes. Nothing is forked.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { DatabaseSync } = require('node:sqlite');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const powershell = require('../../lib/powershell');
const ssh = require('../../lib/ssh');
const logger = require('../../lib/logger');
const prov = require('../../lib/provisioning');
const store = require('../../services/inventoryStore');
const jobs = require('../../services/provisionJobs');
const exitHandler = require('../../lib/workerExitHandler');

const mk = (role, extra = {}) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups: ['prov'], ...extra })}`;
const op = mk('Operator');
const admin = mk('SuperAdmin');
const localOp = mk('Operator', { username: 'locop', domain: 'local' });
const USER_PWD = 'Us3r-Own-Pa$$!';
const SVC_PWD = 'Svc-Acc0unt-Pwd!';
const adOpWithPwd = mk('Operator', { username: 'adop', epass: require('../../lib/crypto').encryptPassword(USER_PWD, 'test-jwt-secret') });
const bearer = (t) => ({ Authorization: t });
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const KNOWN = ['10.20.0.1', '10.20.0.2', '10.20.0.3', '10.20.0.4', '10.20.0.5', '10.20.0.6'];
const DEAD_PID = 999999;
const OLD = new Date(Date.now() - 10 * 60 * 1000).toISOString();

const pkgLine = (o) => `${prov.PKG_MARK}${JSON.stringify({ idx: 0, kind: 'installer', timedOut: false, error: '', stdout: '', stderr: '', ...o })}`;
const hostLine = (o) => `${prov.HOST_MARK}${JSON.stringify(o)}`;
const okOutput = () => [hostLine({ connected: true }), pkgLine({ name: '7zip', exitCode: 0 }), hostLine({ done: true })].join('\n');

let app;
let worker;
const psCalls = [];
const sshCalls = [];
const audits = [];
const notifications = [];
const sent = [];
const replies = [];
let psImpl, sshImpl;

/** A second, independent copy of the job service: the "worker process". */
function loadCopy() {
    const p = require.resolve('../../services/provisionJobs');
    const saved = require.cache[p];
    delete require.cache[p];
    const copy = require('../../services/provisionJobs');
    require.cache[p] = saved;
    return copy;
}

/** global.sendWorkerMessage delivering to the worker copy; replies go back to the web copy. */
function wire({ deliver = true, ack = true } = {}) {
    global.sendWorkerMessage = (msg) => {
        sent.push(msg);
        if (deliver) setImmediate(() => worker.handleWorkerMessage(msg, (reply) => { replies.push(reply); if (ack) jobs.onWorkerMessage(reply); }));
        return true;
    };
}

const installCalls = (ip, marker = 'yum install -y a') => sshCalls.filter(a => a[0] === ip && String(a[3]).includes(marker)).length;
const getJob = async (id) => (await request(app).get(`/api/install/jobs/${id}`).set(bearer(admin))).body;
const dbRow = (id) => jobs.getHandle().prepare('SELECT * FROM provision_jobs WHERE id = ?').get(id);

async function submitLinux(token, ips) {
    const r = await request(app).post('/api/install/execute').set(bearer(token)).send({ ips, osType: 'linux' });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    return r.body.jobId;
}

const linuxRequest = (ips, extra = {}) => ({ ips, osType: 'linux', buType: 'Basic', reboot: false, forceReinstall: false, keepInstallers: false, softwareNames: ['pkgA', 'pkgB'], allowUnknownTargets: false, unknownIps: [], credentialSource: 'settings', actorGroups: ['prov'], ...extra });

let seq = 0;
/** Writes a job row as another (dead or alive) process would have left it. */
function insertJob({ id = `p4-${++seq}`, runner = 'worker', ownerId = `worker:${DEAD_PID}:gone`, heartbeatAt = OLD, status = 'running', request: req, cancelRequested = 0, resumeCount = 0, hosts }) {
    const h = jobs.getHandle();
    h.prepare('INSERT INTO provision_jobs (id, createdBy, createdAt, startedAt, status, buType, request, hostCount, runner, ownerId, claimedAt, heartbeatAt, cancelRequested, resumeCount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, 'operator', OLD, OLD, status, 'Basic', JSON.stringify(req || {}), hosts.length, runner, ownerId, OLD, heartbeatAt, cancelRequested, resumeCount);
    const ins = h.prepare("INSERT INTO provision_job_hosts (jobId, ip, status, packages, log) VALUES (?, ?, ?, '[]', '')");
    for (const [ip, st] of hosts) ins.run(id, ip, st);
    return id;
}

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { prov: { enabled: true, features: { install: true }, auditLogs: { install: true } } }
    });
    // Let the one-time built-in SuperAdmin mapping upgrade persist now, so its document-cache
    // invalidation does not show up among the IPC messages asserted below.
    require('../../lib/rbac').readRbacConfig();
    process.env.REMOTE_INSTALL_BUS = 'BU-A';
    process.env.REMOTE_INSTALL_SOFTWARE_MASTER = '7zip|\\\\srv\\share\\7z.exe|/S';
    process.env.REMOTE_INSTALL_SOFTWARE_Basic = '7zip';
    process.env.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER = 'pkgA|yum install -y a\npkgB|yum install -y b';
    process.env.REMOTE_INSTALL_LINUX_SOFTWARE_Basic = 'pkgA,pkgB';
    process.env.SYSNAS_SOFTWARE_PATH = '\\\\srv\\share';
    process.env.LINUX_ADMIN_USER = 'svc';
    process.env.LINUX_ADMIN_PWD = 'linux-pw';
    process.env.AD_ADMIN_USER = 'svc-prov';
    process.env.AD_ADMIN_PWD = SVC_PWD;
    for (const ip of KNOWN) store.upsertScanResult(ip, { hostname: `HOST-${ip}`, status: 'online', os: 'Linux' });

    powershell.runPowerShell = async (script, timeout, options) => { psCalls.push({ script, timeout, options }); return psImpl(script, timeout, options); };
    ssh.executeSSH = async (...args) => { sshCalls.push(args); return sshImpl(...args); };
    logger.auditLog = (...a) => { audits.push(a); };
    logger.auditLogBatched = (...a) => { audits.push(a); };
    logger.auditLogFileOnly = (...a) => { audits.push(a); };
    logger.queueNotification = (key, moduleName, item, render) => { notifications.push({ key, moduleName, item, text: render([item]) }); };

    app = express();
    app.use(express.json());
    app.use('/api/install', require('../../routes/install'));

    worker = loadCopy();
    worker.initWorker({ sweepMs: 0 });
    for (const m of [jobs, worker]) m._hooks.isPidAlive = (pid) => pid !== DEAD_PID && pid !== 4242;
});
test.after(async () => {
    delete global.sendWorkerMessage;
    await jobs.whenIdle(); await worker.whenIdle();
    await dbManager.closeDB();
});
test.beforeEach(() => {
    psCalls.length = 0; sshCalls.length = 0; audits.length = 0; notifications.length = 0; sent.length = 0; replies.length = 0;
    delete global.sendWorkerMessage;
    delete process.env.ENABLE_EMBEDDED_WORKER;
    process.env.PROVISION_HOST_CONCURRENCY = '4';
    jobs._config.ackTimeoutMs = 5000;
    psImpl = async () => okOutput();
    sshImpl = async () => ({ success: true, code: 0, stdout: 'ok', stderr: '' });
});

// --- schema ---------------------------------------------------------------------------------------

test('schema: new columns are added idempotently to an old table; old rows keep their data and get the defaults', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE provision_jobs (id TEXT PRIMARY KEY, createdBy TEXT, createdAt TEXT, startedAt TEXT, finishedAt TEXT, status TEXT, buType TEXT, request TEXT, hostCount INTEGER DEFAULT 0, okCount INTEGER DEFAULT 0, failCount INTEGER DEFAULT 0, rebootCount INTEGER DEFAULT 0, note TEXT)');
    db.exec("INSERT INTO provision_jobs (id, createdBy, createdAt, status, buType, request, hostCount) VALUES ('old-1', 'x', '2026-01-01', 'running', 'Basic', '{}', 1)");
    // another process already added one of the columns
    db.exec('ALTER TABLE provision_jobs ADD COLUMN runner TEXT');
    jobs.ensureTables(db);
    jobs.ensureTables(db);
    const cols = db.prepare('PRAGMA table_info(provision_jobs)').all().map(c => c.name);
    for (const c of ['runner', 'ownerId', 'claimedAt', 'heartbeatAt', 'cancelRequested', 'resumeCount']) assert.ok(cols.includes(c), c);
    const row = db.prepare("SELECT * FROM provision_jobs WHERE id = 'old-1'").get();
    assert.equal(row.status, 'running');
    assert.equal(row.runner, null);
    assert.equal(row.cancelRequested, 0);
    assert.equal(row.resumeCount, 0);
    db.close();
});

// --- IPC path -------------------------------------------------------------------------------------

test('IPC: a Linux job is handed to the worker, which claims it, acknowledges and runs it; only the job id travels', async () => {
    wire();
    const id = await submitLinux(op, ['10.20.0.1']);
    await jobs.whenIdle(id);
    await worker.whenIdle(id);
    const j = await getJob(id);
    assert.equal(j.job.status, 'done');
    assert.equal(j.job.runner, 'worker');
    assert.equal(j.job.resumed, false);
    assert.equal(j.hosts[0].status, 'ok');
    assert.deepEqual(sent, [{ type: 'RUN_PROVISION_JOB', jobId: id }]);
    assert.deepEqual(replies, [{ type: 'PROVISION_JOB_ACCEPTED', jobId: id }]);
    assert.ok(!JSON.stringify(sent).includes('linux-pw'));
    assert.equal(installCalls('10.20.0.1'), 1);
    assert.equal(jobs._live.size, 0, 'the web never ran it');
    assert.equal(sshCalls[0][2], 'linux-pw', 'the worker resolved the credential itself');
    // notifications and audit from the worker path; the actor's audit groups are known in the worker
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].text, /operator/);
    assert.ok(audits.some(a => a[0] === 'operator' && /SUCCESS 10\.20\.0\.1/.test(a[2])));
    assert.ok(audits.some(a => a[0] === 'operator' && /Finished linux install job/.test(a[2])));
    assert.ok(!('actorGroups' in j.job.request), 'groups are not part of the API shape');
    const row = dbRow(id);
    assert.match(row.ownerId, /^worker:/);
    assert.ok(row.claimedAt && row.heartbeatAt);
});

test('fallback: no worker, send failure, worker disabled, no ack in time, rejection -> the web runs the job (runner web)', async () => {
    const runOne = async (ip) => { const id = await submitLinux(op, [ip]); await jobs.whenIdle(id); await worker.whenIdle(id); return getJob(id); };
    let j = await runOne('10.20.0.1');
    assert.equal(j.job.runner, 'web');
    assert.equal(j.job.status, 'done');

    global.sendWorkerMessage = () => false;
    j = await runOne('10.20.0.2');
    assert.equal(j.job.runner, 'web');

    wire();
    process.env.ENABLE_EMBEDDED_WORKER = 'false';
    j = await runOne('10.20.0.3');
    assert.equal(j.job.runner, 'web');
    assert.equal(sent.length, 0, 'nothing sent when the worker is disabled');
    delete process.env.ENABLE_EMBEDDED_WORKER;

    jobs._config.ackTimeoutMs = 60;
    wire({ deliver: false });
    const t0 = Date.now();
    j = await runOne('10.20.0.4');
    assert.ok(Date.now() - t0 >= 50, 'waited for the ack');
    assert.equal(j.job.runner, 'web');
    assert.equal(sent.length, 1);

    // a worker copy that is not ready rejects; the web falls back at once
    const notReady = loadCopy();
    global.sendWorkerMessage = (msg) => { sent.push(msg); setImmediate(() => notReady.handleWorkerMessage(msg, (r) => { replies.push(r); jobs.onWorkerMessage(r); })); return true; };
    jobs._config.ackTimeoutMs = 5000;
    const t1 = Date.now();
    j = await runOne('10.20.0.5');
    assert.ok(Date.now() - t1 < 2000);
    assert.equal(j.job.runner, 'web');
    assert.equal(replies.at(-1).type, 'PROVISION_JOB_REJECTED');
    for (const ip of ['10.20.0.1', '10.20.0.2', '10.20.0.3', '10.20.0.4', '10.20.0.5']) assert.equal(installCalls(ip), 1, ip);
});

test('atomic claim: a late worker never runs a job the web claimed; the web never runs a job the worker claimed (lost ack)', async () => {
    jobs._config.ackTimeoutMs = 40;
    const held = [];
    global.sendWorkerMessage = (msg) => { held.push(msg); return true; };
    const a = await submitLinux(op, ['10.20.0.1']);
    await jobs.whenIdle(a);
    assert.equal(dbRow(a).runner, 'web');
    // the RUN message arrives after the web already claimed the job
    worker.handleWorkerMessage(held[0], (r) => replies.push(r));
    await worker.whenIdle(a);
    assert.deepEqual(replies, [{ type: 'PROVISION_JOB_REJECTED', jobId: a, reason: 'already claimed' }]);
    assert.equal(installCalls('10.20.0.1'), 1);

    // the worker claims and runs it, but its ack is lost: the web's claim fails and it does not run the job
    wire({ ack: false });
    const b = await submitLinux(op, ['10.20.0.2']);
    await jobs.whenIdle(b);
    await worker.whenIdle(b);
    assert.equal(dbRow(b).runner, 'worker');
    assert.equal((await getJob(b)).job.status, 'done');
    assert.equal(installCalls('10.20.0.2'), 1);
});

test('service account: a Windows job of an AD user runs in the worker as AD_ADMIN_*; the user\'s own password is never used; createdBy stays the user', async () => {
    wire();
    const r = await request(app).post('/api/install/execute').set(bearer(adOpWithPwd)).send({ ips: ['10.20.0.1'] });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await jobs.whenIdle(r.body.jobId);
    await worker.whenIdle(r.body.jobId);
    const j = await getJob(r.body.jobId);
    assert.equal(j.job.runner, 'worker');
    assert.equal(j.job.status, 'done');
    assert.equal(j.job.createdBy, 'adop', 'the triggering user is recorded');
    assert.equal(j.job.runAs, 'svc-prov');
    assert.deepEqual(sent, [{ type: 'RUN_PROVISION_JOB', jobId: r.body.jobId }]);
    const env = psCalls.at(-1).options.env;
    assert.equal(env.SOMP_CRED_USER, 'svc-prov');
    assert.equal(env.SOMP_CRED_PWD, SVC_PWD);
    const dump = JSON.stringify([psCalls, sent, replies, audits, notifications, j, jobs.getHandle().prepare('SELECT * FROM provision_jobs WHERE id = ?').all(r.body.jobId)]);
    assert.ok(!dump.includes(USER_PWD), 'the signed-in user\'s password is never used');
    assert.ok(!JSON.stringify([sent, j, audits]).includes(SVC_PWD), 'the service password is not in IPC, rows or audit');
    assert.ok(audits.some(a => a[0] === 'adop' && /Started windows install job/.test(a[2])));
    assert.ok(audits.some(a => a[0] === 'adop' && /SUCCESS 10\.20\.0\.1/.test(a[2])));

    // a local SOMP user gets the same service account (no empty-env fallback)
    const l = await request(app).post('/api/install/execute').set(bearer(localOp)).send({ ips: ['10.20.0.2'] });
    await jobs.whenIdle(l.body.jobId);
    await worker.whenIdle(l.body.jobId);
    assert.equal(psCalls.at(-1).options.env.SOMP_CRED_USER, 'svc-prov');
    assert.equal((await getJob(l.body.jobId)).job.createdBy, 'locop');
});

test('service account: ALLOWED_AD_DOMAIN qualifies a bare user name like the scanner; buildContext ignores any user argument', () => {
    const runners = require('../../lib/provisionRunners');
    process.env.ALLOWED_AD_DOMAIN = 'CORP';
    try {
        const b = runners.buildContext({ osType: 'windows', user: { username: 'x', password: USER_PWD, domain: 'corp' }, config: {} });
        assert.equal(b.ctx.runAs, 'CORP\\svc-prov');
        assert.equal(b.ctx.credEnv.SOMP_CRED_USER, 'CORP\\svc-prov');
        assert.ok(!JSON.stringify(b).includes(USER_PWD));
        process.env.AD_ADMIN_USER = 'svc-prov@corp.local';
        assert.equal(runners.buildContext({ osType: 'windows', config: {} }).ctx.runAs, 'svc-prov@corp.local');
    } finally {
        delete process.env.ALLOWED_AD_DOMAIN;
        process.env.AD_ADMIN_USER = 'svc-prov';
    }
    const lin = runners.buildContext({ osType: 'linux', config: {} });
    assert.equal(lin.ctx.linuxCreds.user, 'svc');
    assert.equal(lin.ctx.runAs, 'svc');
});

test('service account missing: execute, pre-check and retry-failed fail fast with 400; nothing is created or probed', async () => {
    const prov4 = require('../../lib/provisionRunners');
    // a finished job to retry
    const done = insertJob({ runner: 'web', ownerId: `web:${process.pid}:x`, status: 'partial', request: { ips: ['10.20.0.3'], osType: 'windows', buType: 'Basic', softwareNames: ['7zip'] }, hosts: [['10.20.0.3', 'failed']] });
    const saved = process.env.AD_ADMIN_PWD;
    delete process.env.AD_ADMIN_PWD;
    try {
        const before = jobs.getHandle().prepare('SELECT COUNT(*) AS c FROM provision_jobs').get().c;
        for (const [url, body] of [['/api/install/execute', { ips: ['10.20.0.1'] }], ['/api/install/precheck', { ips: ['10.20.0.1'] }], [`/api/install/jobs/${done}/retry-failed`, {}]]) {
            const r = await request(app).post(url).set(bearer(adOpWithPwd)).send(body);
            assert.equal(r.status, 400, url);
            assert.equal(r.body.error, prov4.SERVICE_ACCOUNT_MISSING, url);
        }
        assert.equal(prov4.SERVICE_ACCOUNT_MISSING, 'Server Provision requires the service account in Settings (AD_ADMIN_USER / AD_ADMIN_PWD)');
        assert.equal(jobs.getHandle().prepare('SELECT COUNT(*) AS c FROM provision_jobs').get().c, before);
        assert.equal(psCalls.length, 0);
        // AD_ADMIN_USER missing is the same error; the user's own password is never a fallback
        process.env.AD_ADMIN_PWD = saved;
        delete process.env.AD_ADMIN_USER;
        const r = await request(app).post('/api/install/execute').set(bearer(adOpWithPwd)).send({ ips: ['10.20.0.1'] });
        assert.equal(r.status, 400);
        assert.equal(r.body.error, prov4.SERVICE_ACCOUNT_MISSING);
    } finally {
        process.env.AD_ADMIN_PWD = saved;
        process.env.AD_ADMIN_USER = 'svc-prov';
    }
});

test('resume of an AD user\'s Windows job (also one created before the switch) runs as the service account; missing service account -> interrupted', async () => {
    const legacy = insertJob({ runner: 'web', ownerId: `web:${DEAD_PID}:gone`, request: { ips: ['10.20.0.4'], osType: 'windows', buType: 'Basic', reboot: false, softwareNames: ['7zip'], credentialSource: 'session', allowUnknownTargets: false, unknownIps: [] }, hosts: [['10.20.0.4', 'queued']] });
    jobs.recoverOrphans({ startup: true });
    await jobs.whenIdle(legacy);
    let j = await getJob(legacy);
    assert.equal(j.job.resumed, true);
    assert.equal(j.hosts[0].status, 'ok');
    assert.equal(j.job.createdBy, 'operator');
    assert.equal(j.job.runAs, 'svc-prov');
    assert.equal(psCalls.at(-1).options.env.SOMP_CRED_USER, 'svc-prov');

    const saved = process.env.AD_ADMIN_PWD;
    delete process.env.AD_ADMIN_PWD;
    try {
        const missing = insertJob({ request: { ips: ['10.20.0.5'], osType: 'windows', buType: 'Basic', softwareNames: ['7zip'], credentialSource: 'settings' }, hosts: [['10.20.0.5', 'queued']] });
        worker.recoverOrphans({ startup: true });
        j = await getJob(missing);
        assert.equal(j.job.status, 'interrupted');
        assert.match(j.hosts[0].error, /requires the service account in Settings \(AD_ADMIN_USER \/ AD_ADMIN_PWD\)/);
        assert.equal(psCalls.filter(c => c.script.includes("'10.20.0.5'")).length, 0);
    } finally { process.env.AD_ADMIN_PWD = saved; }
});

// --- cancel ---------------------------------------------------------------------------------------

test('cancel of a worker-owned job: DB flag + CANCEL message; works without IPC (flag read before the next package)', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '1';
    wire();
    const gate = deferred();
    sshImpl = async () => { await gate.promise; return { success: true, code: 0, stdout: '', stderr: '' }; };
    const id = await submitLinux(op, ['10.20.0.1', '10.20.0.2']);
    await jobs.whenIdle(id);
    await tick(30);
    assert.equal(dbRow(id).runner, 'worker');
    // IPC is down: only the DB flag can reach the worker
    global.sendWorkerMessage = (msg) => { sent.push(msg); return false; };
    const c = await request(app).post(`/api/install/jobs/${id}/cancel`).set(bearer(op));
    assert.equal(c.status, 200);
    assert.equal(c.body.runner, 'worker');
    assert.ok(sent.some(m => m.type === 'CANCEL_PROVISION_JOB' && m.jobId === id));
    assert.equal(dbRow(id).cancelRequested, 1);
    gate.resolve();
    await worker.whenIdle(id);
    const j = await getJob(id);
    assert.equal(j.job.status, 'cancelled');
    assert.equal(j.job.cancelRequested, true);
    assert.deepEqual(j.hosts.map(h => h.status), ['failed', 'cancelled']);
    assert.match(j.hosts[0].packages[1].message, /cancelled/);
    assert.equal(installCalls('10.20.0.1', 'yum install -y b'), 0, 'second package never started');
    assert.ok(audits.some(a => /Cancelled install job/.test(a[2]) && a[0] === 'operator'));
});

test('cancel: the CANCEL message stops a worker job whose hosts wait for a slot; a DB-only cancel is picked up by the heartbeat', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '1';
    wire();
    const gate = deferred();
    sshImpl = async () => { await gate.promise; return { success: true, code: 0, stdout: '', stderr: '' }; };
    const a = await submitLinux(op, ['10.20.0.1']);
    await jobs.whenIdle(a);
    await tick(20);
    const b = await submitLinux(op, ['10.20.0.2', '10.20.0.3']);
    await jobs.whenIdle(b);
    await tick(20);
    await request(app).post(`/api/install/jobs/${b}/cancel`).set(bearer(op)).expect(200);
    await worker.whenIdle(b); // would wait for job A without the message
    assert.equal((await getJob(b)).job.status, 'cancelled');

    const c = await submitLinux(op, ['10.20.0.4', '10.20.0.5']);
    await jobs.whenIdle(c);
    await tick(20);
    global.sendWorkerMessage = () => false;
    await request(app).post(`/api/install/jobs/${c}/cancel`).set(bearer(op)).expect(200);
    worker._beat();
    await worker.whenIdle(c);
    assert.equal((await getJob(c)).job.status, 'cancelled');
    gate.resolve();
    await worker.whenIdle(a);
    assert.equal(installCalls('10.20.0.2') + installCalls('10.20.0.4'), 0);
});

test('cancel of a job whose owner is gone (dead worker) marks it interrupted and releases the IP locks', async () => {
    const id = insertJob({ request: linuxRequest(['10.20.0.6']), hosts: [['10.20.0.6', 'running']] });
    const r = await request(app).post(`/api/install/jobs/${id}/cancel`).set(bearer(op));
    assert.equal(r.status, 200);
    assert.equal(r.body.interrupted, true);
    assert.equal((await getJob(id)).job.status, 'interrupted');
    assert.equal(jobs.activeJobForIp('10.20.0.6'), null);
});

// --- heartbeat / fencing --------------------------------------------------------------------------

test('heartbeat is refreshed while running; a runner that lost ownership starts no new host and writes no terminal state', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '1';
    wire();
    const gate = deferred();
    sshImpl = async () => { await gate.promise; return { success: true, code: 0, stdout: '', stderr: '' }; };
    const id = await submitLinux(op, ['10.20.0.1', '10.20.0.2']);
    await jobs.whenIdle(id);
    await tick(20);
    const h = jobs.getHandle();
    h.prepare('UPDATE provision_jobs SET heartbeatAt = ? WHERE id = ?').run(OLD, id);
    worker._beat();
    assert.ok(dbRow(id).heartbeatAt > OLD, 'heartbeat written');
    // another process adopted the job meanwhile
    h.prepare("UPDATE provision_jobs SET ownerId = 'web:1:other', runner = 'web' WHERE id = ?").run(id);
    gate.resolve();
    await worker.whenIdle(id);
    assert.equal(installCalls('10.20.0.2'), 0, 'no new host after losing ownership');
    assert.equal(dbRow(id).status, 'running', 'terminal state left to the new owner');
    assert.equal(h.prepare("SELECT status FROM provision_job_hosts WHERE jobId = ? AND ip = '10.20.0.2'").get(id).status, 'queued');
    assert.equal(worker._live.size, 0);
    h.prepare("UPDATE provision_job_hosts SET status = 'interrupted' WHERE jobId = ? AND status IN ('queued', 'running')").run(id);
    h.prepare("UPDATE provision_jobs SET status = 'interrupted' WHERE id = ?").run(id);
});

// --- resume after restart -------------------------------------------------------------------------

test('resume: running -> interrupted, queued resumed for those hosts only, unknown target skipped; note, audit and summary', async () => {
    const id = insertJob({ request: linuxRequest(['10.20.0.1', '10.20.0.2', '10.20.0.3', '10.99.9.9']), hosts: [['10.20.0.1', 'ok'], ['10.20.0.2', 'running'], ['10.20.0.3', 'queued'], ['10.99.9.9', 'queued']] });
    // a fresh process has never seen the actor's login: the audit groups come from the job row
    global.userGroupsCache = {};
    const r = worker.recoverOrphans({ startup: true });
    assert.equal(r.resumed, 1);
    assert.deepEqual(global.userGroupsCache.operator, ['prov']);
    await worker.whenIdle(id);
    const j = await getJob(id);
    assert.deepEqual(j.hosts.map(h => h.status), ['ok', 'interrupted', 'ok', 'skipped']);
    assert.match(j.hosts[1].error, /restart/i);
    assert.match(j.hosts[3].error, /no longer a known target/);
    assert.equal(j.job.resumeCount, 1);
    assert.equal(j.job.resumed, true);
    assert.equal(j.job.runner, 'worker');
    assert.match(j.job.note, /Resumed after restart \(1 host/);
    assert.equal(j.job.status, 'partial');
    assert.equal(installCalls('10.20.0.3'), 1);
    assert.equal(installCalls('10.20.0.2'), 0, 'a half-done host is never re-run');
    assert.ok(audits.some(a => /Resumed install job/.test(a[2]) && a[2].includes(id)));
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].text, /Resumed after restart \(1 host/);
    assert.match(dbRow(id).ownerId, /^worker:/);
});

test('resume rules: cancelRequested -> cancelled; already resumed once -> interrupted; locked IP / removed package', async () => {
    const cancelled = insertJob({ cancelRequested: 1, request: linuxRequest(['10.20.0.1', '10.20.0.2']), hosts: [['10.20.0.1', 'running'], ['10.20.0.2', 'queued']] });
    const twice = insertJob({ resumeCount: 1, request: linuxRequest(['10.20.0.3']), hosts: [['10.20.0.3', 'queued']] });
    const removed = insertJob({ request: linuxRequest(['10.20.0.5'], { softwareNames: ['pkgA', 'gone'] }), hosts: [['10.20.0.5', 'queued']] });
    worker.recoverOrphans({ startup: true });
    jobs.recoverOrphans({ startup: true });
    await worker.whenIdle(); await jobs.whenIdle();
    let j = await getJob(cancelled);
    assert.equal(j.job.status, 'cancelled');
    assert.deepEqual(j.hosts.map(h => h.status), ['interrupted', 'cancelled']);
    j = await getJob(twice);
    assert.equal(j.job.status, 'interrupted');
    assert.match(j.hosts[0].error, /already resumed once/);
    assert.equal(j.job.resumeCount, 1);
    j = await getJob(removed);
    assert.equal(j.job.status, 'interrupted');
    assert.match(j.hosts[0].error, /gone/);
    assert.equal(sshCalls.length + psCalls.length, 0, 'nothing ran');
    for (const ip of ['10.20.0.1', '10.20.0.2', '10.20.0.3', '10.20.0.5']) assert.equal(jobs.activeJobForIp(ip), null, ip);

    // a queued host whose IP another active job holds is skipped on resume
    const holder = insertJob({ runner: 'web', ownerId: `web:${process.pid}:alive`, heartbeatAt: new Date().toISOString(), request: linuxRequest(['10.20.0.6']), hosts: [['10.20.0.6', 'running']] });
    const locked = insertJob({ request: linuxRequest(['10.20.0.6', '10.20.0.1']), hosts: [['10.20.0.6', 'queued'], ['10.20.0.1', 'queued']] });
    worker.recoverOrphans({ startup: true });
    await worker.whenIdle(locked);
    j = await getJob(locked);
    assert.deepEqual(j.hosts.map(h => h.status), ['skipped', 'ok']);
    assert.match(j.hosts[0].error, new RegExp(`already being provisioned by job ${holder}`));
    assert.equal((await getJob(holder)).job.status, 'running', 'a live owner is never touched');
    jobs.getHandle().prepare("UPDATE provision_job_hosts SET status = 'ok' WHERE jobId = ?").run(holder);
    jobs.getHandle().prepare("UPDATE provision_jobs SET status = 'done' WHERE id = ?").run(holder);
});

test('startup ownership: the worker recovers only worker jobs, the web only web / legacy jobs; live owners are left alone; one adopter wins', async () => {
    const fresh = new Date().toISOString();
    const deadWorker = insertJob({ request: {}, hosts: [['10.20.1.1', 'running']] });
    const deadWeb = insertJob({ runner: 'web', ownerId: `web:${DEAD_PID}:gone`, request: {}, hosts: [['10.20.1.2', 'running']] });
    const legacy = insertJob({ runner: null, ownerId: null, heartbeatAt: null, request: {}, hosts: [['10.20.1.3', 'queued']] });
    const liveWorker = insertJob({ ownerId: `worker:${process.pid}:other`, heartbeatAt: fresh, request: {}, hosts: [['10.20.1.4', 'running']] });
    const liveWeb = insertJob({ runner: 'web', ownerId: `web:${process.pid}:other`, heartbeatAt: fresh, request: {}, hosts: [['10.20.1.5', 'running']] });
    const status = (id) => dbRow(id).status;

    jobs.recoverOrphans({ startup: true });
    assert.equal(status(deadWorker), 'running', 'the web leaves worker jobs to the worker at startup');
    assert.equal(status(deadWeb), 'interrupted');
    assert.equal(status(legacy), 'interrupted', 'pre-upgrade rows (no runner) are orphans of the web');
    worker.recoverOrphans({ startup: true });
    assert.equal(status(deadWorker), 'interrupted');
    assert.equal(status(liveWorker), 'running');
    assert.equal(status(liveWeb), 'running');
    assert.equal(dbRow(liveWorker).ownerId, `worker:${process.pid}:other`);

    // a stale heartbeat makes the owner gone; two adopters racing on the same snapshot: exactly one wins
    jobs.getHandle().prepare('UPDATE provision_jobs SET heartbeatAt = ? WHERE id = ?').run(OLD, liveWorker);
    const snapshot = dbRow(liveWorker);
    assert.equal(worker._tryAdopt(snapshot), true);
    assert.equal(jobs._tryAdopt(snapshot), false);
    worker.recoverOrphans({});
    assert.equal(status(liveWorker), 'interrupted');
    jobs.getHandle().prepare('UPDATE provision_jobs SET heartbeatAt = ? WHERE id = ?').run(OLD, liveWeb);
    jobs.recoverOrphans({});
    assert.equal(status(liveWeb), 'interrupted');
});

test('supervisor exit handler: closes the backup status, adopts the exited worker\'s jobs into the web (resumed there) and ends ack waits', async () => {
    const backupWrites = [];
    const backupService = { readLastResult: async () => ({ startedAt: '2026-10-21T00:00:00Z' }), writeLastResult: async (x) => { backupWrites.push(x); } };
    const own = insertJob({ ownerId: 'worker:4242:x', heartbeatAt: new Date().toISOString(), request: linuxRequest(['10.20.0.1', '10.20.0.2']), hosts: [['10.20.0.1', 'running'], ['10.20.0.2', 'queued']] });
    const other = insertJob({ ownerId: `worker:${process.pid}:y`, heartbeatAt: new Date().toISOString(), request: {}, hosts: [['10.20.2.1', 'running']] });
    // a job waiting for the ack of the worker that just died
    wire({ deliver: false });
    const t0 = Date.now();
    const pendingId = await submitLinux(op, ['10.20.0.3']);
    await tick(10);
    await exitHandler.handleWorkerExit({ pid: 4242, jobs, backupService });
    await jobs.whenIdle();
    assert.ok(Date.now() - t0 < 2000, 'fallback did not wait for the ack timeout');
    assert.equal(backupWrites.length, 1);
    assert.equal(backupWrites[0].error, 'Background worker exited during backup');
    let j = await getJob(own);
    assert.equal(j.job.runner, 'web');
    assert.deepEqual(j.hosts.map(h => h.status), ['interrupted', 'ok']);
    assert.equal(j.job.resumeCount, 1);
    assert.equal(installCalls('10.20.0.2'), 1);
    j = await getJob(pendingId);
    assert.equal(j.job.runner, 'web');
    assert.equal(j.job.status, 'done');
    assert.equal(dbRow(other).status, 'running', 'jobs of another worker process are not touched');
    jobs.getHandle().prepare("UPDATE provision_job_hosts SET status = 'ok' WHERE jobId = ?").run(other);
    jobs.getHandle().prepare("UPDATE provision_jobs SET status = 'done' WHERE id = ?").run(other);
    // never throws, even when everything fails
    await exitHandler.handleWorkerExit({ pid: 1, jobs: { onWorkerGone: () => { throw new Error('x'); }, recoverOrphans: () => { throw new Error('y'); } }, backupService: { readLastResult: async () => { throw new Error('z'); } } });
});

test('M1: a job the exited worker claimed but never acknowledged is adopted by the web at once (not after the respawn)', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '1';
    // a worker process whose pid is 4242 (dead for the web once it exits)
    const w2 = loadCopy();
    w2.initWorker({ sweepMs: 0 });
    w2._identity.instance = 'worker:4242:m1';
    const gate = deferred();
    sshImpl = async (ip) => { if (ip === '10.20.0.1') await gate.promise; return { success: true, code: 0, stdout: '', stderr: '' }; };
    global.sendWorkerMessage = (msg) => { sent.push(msg); setImmediate(() => w2.handleWorkerMessage(msg, () => { /* ack lost: the worker dies */ })); return true; };
    const t0 = Date.now();
    const id = await submitLinux(op, ['10.20.0.1', '10.20.0.2']);
    await tick(30);
    assert.equal(dbRow(id).ownerId, 'worker:4242:m1', 'claimed by the worker, ack never arrived');
    await exitHandler.handleWorkerExit({ pid: 4242, jobs, backupService: { readLastResult: async () => ({}) } });
    await tick(20);
    await jobs.whenIdle(id);
    assert.ok(Date.now() - t0 < 2000, 'no wait for the 5 s ack timeout or the respawn');
    gate.resolve();
    await w2.whenIdle(id);
    const j = await getJob(id);
    assert.equal(j.job.runner, 'web');
    assert.equal(j.job.resumeCount, 1);
    assert.deepEqual(j.hosts.map(h => h.status), ['interrupted', 'ok']);
    assert.equal(installCalls('10.20.0.2'), 1, 'the queued host ran once, in the web');
});

test('M2: an adoption based on a stale snapshot fails when the owner heartbeats meanwhile', () => {
    const id = insertJob({ ownerId: `worker:${process.pid}:slow`, request: {}, hosts: [['10.20.4.1', 'running']] });
    const snapshot = dbRow(id); // heartbeat 10 min old: looks gone to a sweep
    jobs.getHandle().prepare('UPDATE provision_jobs SET heartbeatAt = ? WHERE id = ?').run(new Date().toISOString(), id); // the owner revives
    assert.equal(jobs._tryAdopt(snapshot), false);
    assert.equal(dbRow(id).ownerId, `worker:${process.pid}:slow`);
    assert.equal(jobs._tryAdopt(dbRow(id)), true, 'a current snapshot still adopts');
    jobs.getHandle().prepare("UPDATE provision_job_hosts SET status = 'interrupted' WHERE jobId = ?").run(id);
    jobs.getHandle().prepare("UPDATE provision_jobs SET status = 'interrupted' WHERE id = ?").run(id);
});

test('M3: a forked worker shuts down gracefully when the IPC channel to the web closes', () => {
    const { EventEmitter } = require('events');
    const { attachParentDisconnect } = require('../../lib/workerLifecycle');
    const calls = [];
    const forked = Object.assign(new EventEmitter(), { send: () => true });
    assert.equal(attachParentDisconnect(forked, (s) => calls.push(s)), true);
    forked.emit('disconnect');
    assert.deepEqual(calls, ['PARENT_DISCONNECTED']);
    // started standalone (npm run start:worker): no IPC channel, nothing attached
    const standalone = new EventEmitter();
    assert.equal(attachParentDisconnect(standalone, (s) => calls.push(s)), false);
    standalone.emit('disconnect');
    assert.equal(calls.length, 1);
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../worker.js'), 'utf8');
    assert.match(src, /attachParentDisconnect\(process, shutdown\)/);
});

test('wiring: the supervisor routes acks and the exit close-out; the worker handles RUN / CANCEL and initialises its role after the DB', () => {
    const fs = require('fs');
    const path = require('path');
    const index = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
    const workerSrc = fs.readFileSync(path.join(__dirname, '../../worker.js'), 'utf8');
    assert.match(index, /PROVISION_JOB_ACCEPTED' \|\| msg\.type === 'PROVISION_JOB_REJECTED'[\s\S]{0,200}onWorkerMessage\(msg\)/);
    const exitAt = index.indexOf("workerProcess.on('exit'");
    const stopAt = index.indexOf('if (isStopping)', exitAt);
    const closeAt = index.indexOf("require('./lib/workerExitHandler').handleWorkerExit({ pid: child.pid })", exitAt);
    assert.ok(exitAt > 0 && stopAt > exitAt && closeAt > stopAt, 'close-out runs in the exit handler, after the shutdown check');
    assert.ok(!index.slice(exitAt, closeAt).includes('readLastResult'), 'backup close-out moved into the handler module');
    assert.match(workerSrc, /msg\.type === 'RUN_PROVISION_JOB' \|\| msg\.type === 'CANCEL_PROVISION_JOB'[\s\S]{0,300}handleWorkerMessage\(msg,/);
    const db = workerSrc.indexOf('await initDB()');
    const iw = workerSrc.indexOf("require('./services/provisionJobs').initWorker()");
    assert.ok(db > 0 && iw > db, 'initWorker after initDB');
    // provision is never started by the web for worker jobs at startup: init() is the web entry, initWorker() the worker one
    assert.ok(!workerSrc.includes("provisionJobs').init("));
});

test('legacy markInterrupted never touches worker jobs or jobs dispatched by this process', async () => {
    const w = insertJob({ ownerId: `worker:${process.pid}:alive`, heartbeatAt: new Date().toISOString(), request: {}, hosts: [['10.20.3.1', 'running']] });
    jobs.markInterrupted();
    assert.equal(dbRow(w).status, 'running');
    jobs.getHandle().prepare("UPDATE provision_job_hosts SET status = 'ok' WHERE jobId = ?").run(w);
    jobs.getHandle().prepare("UPDATE provision_jobs SET status = 'done' WHERE id = ?").run(w);
});
