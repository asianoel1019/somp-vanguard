require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { encryptPassword } = require('../../lib/crypto');
const { writeDataSync } = require('../../lib/db');
const powershell = require('../../lib/powershell');
const ssh = require('../../lib/ssh');
const logger = require('../../lib/logger');
const netProbe = require('../../lib/netProbe');
const prov = require('../../lib/provisioning');
const store = require('../../services/inventoryStore');
const cmdb = require('../../services/cmdbModel');
const jobs = require('../../services/provisionJobs');

const SECRET = 'S3cr3t-Pa$$w0rd!';
const mk = (role, groups = ['prov']) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups })}`;
const admin = mk('SuperAdmin'), op = mk('Operator'), viewer = mk('Viewer'), noFeature = mk('Operator', ['other']);
const opWithPwd = `Bearer ${signToken({ username: 'op', domain: 'corp', role: 'Operator', groups: ['prov'], epass: encryptPassword(SECRET, 'test-jwt-secret') })}`;
const bearer = (t) => ({ Authorization: t });
const NAMES = ['7zip', 'Tool', 'Data'];

let app;
const psCalls = [];
const sshCalls = [];
const audits = [];
const notifications = [];
let psImpl, sshImpl, tcpImpl;

const pkgLine = (o) => `${prov.PKG_MARK}${JSON.stringify({ idx: NAMES.indexOf(o.name), kind: 'installer', timedOut: false, error: '', stdout: '', stderr: '', ...o })}`;
const hostLine = (o) => `${prov.HOST_MARK}${JSON.stringify(o)}`;
const okOutput = (names = ['7zip']) => ['Connecting...', hostLine({ connected: true }), ...names.map(n => pkgLine({ name: n, exitCode: 0 })), hostLine({ done: true })].join('\n');
const failOutput = () => [hostLine({ connected: true }), pkgLine({ name: '7zip', exitCode: 1603, stderr: 'fatal' }), hostLine({ done: true })].join('\n');
const preLine = (o) => `${prov.PRE_MARK || '@@PRE@@'}${JSON.stringify(o)}`;
const nasLine = (o) => `@@NAS@@${JSON.stringify(o)}`;
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

const KNOWN = ['10.20.0.1', '10.20.0.2', '10.20.0.3', '10.20.0.4', '10.20.0.5', '10.20.0.6', '10.20.0.7', '10.20.0.8'];

async function submit(token, body) {
    return request(app).post('/api/install/execute').set(bearer(token)).send(body);
}
async function runJob(token, body) {
    const r = await submit(token, body);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await jobs.whenIdle(r.body.jobId);
    return (await request(app).get(`/api/install/jobs/${r.body.jobId}`).set(bearer(admin))).body;
}

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { prov: { enabled: true, features: { install: true }, auditLogs: { install: true } }, other: { enabled: true, features: { serverList: true } } }
    });
    process.env.REMOTE_INSTALL_BUS = 'BU-A';
    process.env.REMOTE_INSTALL_SOFTWARE_MASTER = '7zip|\\\\srv\\share\\7z.exe|/S\nTool|tools\\setup.bat|-q\nData|\\\\srv\\share\\datadir|';
    process.env.REMOTE_INSTALL_SOFTWARE_Basic = '7zip';
    process.env.REMOTE_INSTALL_SOFTWARE_BU_A = '7zip,Tool,Data';
    process.env.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER = 'pkgA|yum install -y a\npkgB|yum install -y b';
    process.env.REMOTE_INSTALL_LINUX_SOFTWARE_Basic = 'pkgA,pkgB';
    process.env.SYSNAS_SOFTWARE_PATH = '\\\\srv\\share';
    process.env.LINUX_ADMIN_USER = 'svc';
    process.env.LINUX_ADMIN_PWD = 'linux-pw';
    // Windows installs run as the Settings service account (SECRET is its password)
    process.env.AD_ADMIN_USER = 'svc-prov';
    process.env.AD_ADMIN_PWD = SECRET;

    for (const ip of KNOWN) store.upsertScanResult(ip, { hostname: `HOST-${ip}`, status: 'online', os: 'Windows Server 2022' });

    powershell.runPowerShell = async (script, timeout, options) => { psCalls.push({ script, timeout, options }); return psImpl(script, timeout, options); };
    ssh.executeSSH = async (...args) => { sshCalls.push(args); return sshImpl(...args); };
    logger.auditLog = (...a) => { audits.push(a); };
    logger.auditLogBatched = (...a) => { audits.push(a); };
    logger.auditLogFileOnly = (...a) => { audits.push(a); };
    logger.queueNotification = (key, moduleName, item, render) => { notifications.push({ key, moduleName, item, text: render([item]) }); };
    netProbe.checkTcpPort = async (...a) => tcpImpl(...a);

    app = express();
    app.use(express.json());
    app.use('/api/install', require('../../routes/install'));
});
test.after(async () => { await jobs.whenIdle(); await dbManager.closeDB(); });
test.beforeEach(() => {
    psCalls.length = 0; sshCalls.length = 0; audits.length = 0; notifications.length = 0;
    process.env.PROVISION_HOST_CONCURRENCY = '4';
    psImpl = async () => okOutput();
    sshImpl = async () => ({ success: true, code: 0, stdout: 'ok', stderr: '' });
    tcpImpl = async () => true;
});

// --- schema ---------------------------------------------------------------------------------------

test('tables and indexes are created idempotently', () => {
    const h = jobs.getHandle();
    jobs.ensureTables(h);
    jobs.ensureTables(h);
    const names = h.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'provision_%' OR name LIKE 'idx_provision_%'").all().map(r => r.name);
    for (const n of ['provision_jobs', 'provision_job_hosts', 'idx_provision_jobs_createdAt', 'idx_provision_job_hosts_jobId', 'idx_provision_job_hosts_ip']) assert.ok(names.includes(n), n);
    const cols = h.prepare('PRAGMA table_info(provision_jobs)').all().map(c => c.name);
    for (const c of ['id', 'createdBy', 'createdAt', 'startedAt', 'finishedAt', 'status', 'buType', 'request', 'hostCount', 'okCount', 'failCount', 'rebootCount', 'note']) assert.ok(cols.includes(c), c);
    const hc = h.prepare('PRAGMA table_info(provision_job_hosts)').all().map(c => c.name);
    for (const c of ['jobId', 'ip', 'hostname', 'os', 'status', 'startedAt', 'finishedAt', 'packages', 'rebootRequired', 'log', 'error']) assert.ok(hc.includes(c), c);
});

test('provision settings: defaults and clamping', () => {
    assert.deepEqual(prov.loadProvisionSettings({}, {}), { hostConcurrency: 4, historyRetentionDays: 180, minFreeGB: 5 });
    assert.equal(prov.loadProvisionSettings({ PROVISION_HOST_CONCURRENCY: '99' }, {}).hostConcurrency, 10);
    assert.equal(prov.loadProvisionSettings({ PROVISION_HOST_CONCURRENCY: '0' }, {}).hostConcurrency, 1);
    assert.equal(prov.loadProvisionSettings({ PROVISION_HISTORY_RETENTION_DAYS: '5' }, {}).historyRetentionDays, 30);
    assert.equal(prov.loadProvisionSettings({ PROVISION_HISTORY_RETENTION_DAYS: '9999' }, {}).historyRetentionDays, 730);
});

// --- lifecycle ------------------------------------------------------------------------------------

test('execute returns 202 { jobId } at once; status goes queued -> running -> done', async () => {
    const gate = deferred();
    psImpl = async () => { await gate.promise; return okOutput(); };
    const r = await submit(op, { ips: ['10.20.0.1'] });
    assert.equal(r.status, 202);
    assert.match(r.body.jobId, /^[0-9a-f-]{36}$/);
    let j = (await request(app).get(`/api/install/jobs/${r.body.jobId}`).set(bearer(viewer))).body;
    assert.ok(['queued', 'running'].includes(j.job.status), j.job.status);
    await tick(30);
    j = (await request(app).get(`/api/install/jobs/${r.body.jobId}`).set(bearer(viewer))).body;
    assert.equal(j.job.status, 'running');
    assert.equal(j.hosts[0].status, 'running');
    assert.ok(j.job.startedAt);
    gate.resolve();
    await jobs.whenIdle(r.body.jobId);
    j = (await request(app).get(`/api/install/jobs/${r.body.jobId}`).set(bearer(op))).body;
    assert.equal(j.job.status, 'done');
    assert.equal(j.job.createdBy, 'operator');
    assert.equal(j.job.hostCount, 1);
    assert.equal(j.job.okCount, 1);
    assert.equal(j.job.failCount, 0);
    assert.ok(j.job.finishedAt);
    assert.equal(j.hosts[0].status, 'ok');
    assert.equal(j.hosts[0].hostname, 'HOST-10.20.0.1');
    assert.equal(j.hosts[0].packages[0].name, '7zip');
    assert.match(j.hosts[0].log, /OK/);
});

test('job status: done / partial / failed, reboot count', async () => {
    let n = 0;
    psImpl = async () => { n++; return n === 2 ? failOutput() : [hostLine({ connected: true }), pkgLine({ name: '7zip', exitCode: 3010 }), hostLine({ done: true })].join('\n'); };
    const p = await runJob(op, { ips: ['10.20.0.1', '10.20.0.2', '10.20.0.3'] });
    assert.equal(p.job.status, 'partial');
    assert.equal(p.job.okCount, 2);
    assert.equal(p.job.failCount, 1);
    assert.equal(p.job.rebootCount, 2);
    psImpl = async () => failOutput();
    const f = await runJob(op, { ips: ['10.20.0.4', '10.20.0.5'] });
    assert.equal(f.job.status, 'failed');
    assert.equal(f.job.failCount, 2);
});

test('GET /jobs pages newest first with limit / before', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await runJob(op, { ips: [`10.20.0.${i + 1}`] })).job.id);
    const page1 = (await request(app).get('/api/install/jobs?limit=2').set(bearer(viewer))).body;
    assert.equal(page1.jobs.length, 2);
    assert.equal(page1.jobs[0].id, ids[2]);
    assert.equal(page1.jobs[1].id, ids[1]);
    assert.ok(page1.nextBefore);
    assert.ok(!('hosts' in page1.jobs[0]), 'list rows do not carry host rows / logs');
    const page2 = (await request(app).get(`/api/install/jobs?limit=2&before=${page1.nextBefore}`).set(bearer(viewer))).body;
    assert.ok(page2.jobs.every(x => !page1.jobs.some(y => y.id === x.id)));
    assert.ok(page2.jobs.some(x => x.id === ids[0]));
    const noLog = (await request(app).get(`/api/install/jobs/${ids[0]}?log=0`).set(bearer(viewer))).body;
    assert.ok(!('log' in noLog.hosts[0]));
    await request(app).get('/api/install/jobs/does-not-exist').set(bearer(viewer)).expect(404);
});

test('bounded concurrency: never more hosts in flight than provision.hostConcurrency', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '2';
    let inflight = 0, max = 0;
    psImpl = async () => { inflight++; max = Math.max(max, inflight); await tick(25); inflight--; return okOutput(); };
    const j = await runJob(op, { ips: KNOWN.slice(0, 6) });
    assert.equal(j.job.status, 'done');
    assert.equal(max, 2);
    // and the limit is really used (not serial)
    process.env.PROVISION_HOST_CONCURRENCY = '99';
    inflight = 0; max = 0;
    await runJob(op, { ips: KNOWN });
    assert.equal(max, 8, 'values above 10 are clamped; 8 hosts fit under 10');
});

test('per-IP lock: a host already in a queued/running job is skipped with the owning job id', async () => {
    const gate = deferred();
    psImpl = async () => { await gate.promise; return okOutput(); };
    const a = await submit(op, { ips: ['10.20.0.1'] });
    await tick(30);
    psImpl = async () => okOutput();
    const b = await submit(op, { ips: ['10.20.0.1', '10.20.0.2'] });
    assert.equal(b.status, 202);
    await jobs.whenIdle(b.body.jobId);
    const jb = (await request(app).get(`/api/install/jobs/${b.body.jobId}`).set(bearer(viewer))).body;
    const skipped = jb.hosts.find(h => h.ip === '10.20.0.1');
    assert.equal(skipped.status, 'skipped');
    assert.ok(skipped.error.includes(`already being provisioned by job ${a.body.jobId}`));
    assert.equal(jb.hosts.find(h => h.ip === '10.20.0.2').status, 'ok');
    assert.equal(jb.job.status, 'partial');
    gate.resolve();
    await jobs.whenIdle(a.body.jobId);
    // lock released: the same IP can be provisioned again
    const again = await runJob(op, { ips: ['10.20.0.1'] });
    assert.equal(again.hosts[0].status, 'ok');
});

test('cancel: no new host starts, queued hosts become cancelled, the running one finishes, job is cancelled', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '1';
    const gate = deferred();
    psImpl = async () => { await gate.promise; return okOutput(); };
    const r = await submit(op, { ips: ['10.20.0.1', '10.20.0.2', '10.20.0.3'] });
    await tick(30);
    await request(app).post(`/api/install/jobs/${r.body.jobId}/cancel`).set(bearer(viewer)).expect(403);
    const c = await request(app).post(`/api/install/jobs/${r.body.jobId}/cancel`).set(bearer(op));
    assert.equal(c.status, 200);
    gate.resolve();
    await jobs.whenIdle(r.body.jobId);
    const j = (await request(app).get(`/api/install/jobs/${r.body.jobId}`).set(bearer(viewer))).body;
    assert.equal(j.job.status, 'cancelled');
    assert.deepEqual(j.hosts.map(h => h.status), ['ok', 'cancelled', 'cancelled']);
    assert.equal(psCalls.length, 1);
    assert.ok(audits.some(a => /Cancelled install job/.test(a[2]) && a[0] === 'operator'));
    await request(app).post(`/api/install/jobs/${r.body.jobId}/cancel`).set(bearer(op)).expect(409);
    await request(app).post('/api/install/jobs/nope/cancel').set(bearer(op)).expect(404);
});

test('cancel stops the remaining packages of a Linux host', async () => {
    const gate = deferred();
    let calls = 0;
    sshImpl = async () => { calls++; await gate.promise; return { success: true, code: 0, stdout: '', stderr: '' }; };
    const r = await submit(op, { ips: ['10.20.0.1'], osType: 'linux' });
    await tick(30);
    await request(app).post(`/api/install/jobs/${r.body.jobId}/cancel`).set(bearer(op)).expect(200);
    gate.resolve();
    await jobs.whenIdle(r.body.jobId);
    const j = (await request(app).get(`/api/install/jobs/${r.body.jobId}`).set(bearer(viewer))).body;
    assert.equal(calls, 1, 'second package never started');
    assert.equal(j.job.status, 'cancelled');
    assert.match(j.hosts[0].packages[1].message, /cancelled/);
});

test('startup marks queued / running jobs and hosts as interrupted', () => {
    const h = jobs.getHandle();
    const at = new Date().toISOString();
    h.prepare("INSERT INTO provision_jobs (id, createdBy, createdAt, status, buType, request, hostCount) VALUES ('int-run', 'x', ?, 'running', 'Basic', '{}', 3)").run(at);
    h.prepare("INSERT INTO provision_jobs (id, createdBy, createdAt, status, buType, request, hostCount) VALUES ('int-q', 'x', ?, 'queued', 'Basic', '{}', 1)").run(at);
    h.prepare("INSERT INTO provision_jobs (id, createdBy, createdAt, status, buType, request, hostCount) VALUES ('int-done', 'x', ?, 'done', 'Basic', '{}', 1)").run(at);
    const ins = h.prepare("INSERT INTO provision_job_hosts (jobId, ip, status, packages, log) VALUES (?, ?, ?, '[]', '')");
    ins.run('int-run', '10.99.0.1', 'ok'); ins.run('int-run', '10.99.0.2', 'running'); ins.run('int-run', '10.99.0.3', 'queued');
    ins.run('int-q', '10.99.0.4', 'queued'); ins.run('int-done', '10.99.0.5', 'ok');
    const r = jobs.markInterrupted();
    assert.equal(r.jobs, 2);
    assert.equal(r.hosts, 3);
    const st = (id) => h.prepare('SELECT status, finishedAt, okCount, failCount FROM provision_jobs WHERE id = ?').get(id);
    assert.equal(st('int-run').status, 'interrupted');
    assert.ok(st('int-run').finishedAt);
    assert.equal(st('int-run').okCount, 1);
    assert.equal(st('int-run').failCount, 2);
    assert.equal(st('int-q').status, 'interrupted');
    assert.equal(st('int-done').status, 'done');
    const hs = h.prepare("SELECT ip, status FROM provision_job_hosts WHERE jobId = 'int-run' ORDER BY ip").all().map(x => x.status);
    assert.deepEqual(hs, ['ok', 'interrupted', 'interrupted']);
    assert.equal(h.prepare("SELECT status FROM provision_job_hosts WHERE jobId = 'int-done'").get().status, 'ok');
    // a second run finds nothing
    assert.deepEqual(jobs.markInterrupted(), { jobs: 0, hosts: 0 });
});

test('retry-failed creates a new job with only the failed / interrupted hosts and the same request', async () => {
    let n = 0;
    psImpl = async () => { n++; return n === 2 ? failOutput() : okOutput(NAMES); };
    const first = await runJob(op, { ips: ['10.20.0.1', '10.20.0.2', '10.20.0.3'], buType: 'BU-A', reboot: true });
    assert.equal(first.job.status, 'partial');
    await request(app).post(`/api/install/jobs/${first.job.id}/retry-failed`).set(bearer(viewer)).expect(403);
    psImpl = async () => okOutput(NAMES);
    const r = await request(app).post(`/api/install/jobs/${first.job.id}/retry-failed`).set(bearer(op));
    assert.equal(r.status, 202);
    assert.notEqual(r.body.jobId, first.job.id);
    await jobs.whenIdle(r.body.jobId);
    const j = (await request(app).get(`/api/install/jobs/${r.body.jobId}`).set(bearer(viewer))).body;
    assert.deepEqual(j.hosts.map(h => h.ip), ['10.20.0.2']);
    assert.equal(j.job.buType, 'BU-A');
    assert.equal(j.job.request.reboot, true);
    assert.equal(j.job.request.retryOf, first.job.id);
    assert.equal(j.job.status, 'done');
    assert.ok(audits.some(a => /Retried failed hosts of install job/.test(a[2])));
    // nothing failed any more in the new job -> nothing to retry
    await request(app).post(`/api/install/jobs/${r.body.jobId}/retry-failed`).set(bearer(op)).expect(400);
    await request(app).post('/api/install/jobs/nope/retry-failed').set(bearer(op)).expect(404);

    // an interrupted host is retried too; a running job cannot be retried
    const h = jobs.getHandle();
    h.prepare("INSERT INTO provision_jobs (id, createdBy, createdAt, status, buType, request, hostCount) VALUES ('retry-int', 'x', ?, 'interrupted', 'Basic', ?, 2)").run(new Date().toISOString(), JSON.stringify({ osType: 'windows', buType: 'Basic' }));
    h.prepare("INSERT INTO provision_job_hosts (jobId, ip, status, packages, log) VALUES ('retry-int', '10.20.0.7', 'interrupted', '[]', '')").run();
    h.prepare("INSERT INTO provision_job_hosts (jobId, ip, status, packages, log) VALUES ('retry-int', '10.20.0.8', 'ok', '[]', '')").run();
    psImpl = async () => okOutput();
    const ri = await request(app).post('/api/install/jobs/retry-int/retry-failed').set(bearer(op));
    assert.equal(ri.status, 202);
    await jobs.whenIdle(ri.body.jobId);
    assert.deepEqual((await request(app).get(`/api/install/jobs/${ri.body.jobId}`).set(bearer(op))).body.hosts.map(x => x.ip), ['10.20.0.7']);
    h.prepare("INSERT INTO provision_jobs (id, createdBy, createdAt, status, buType, request, hostCount) VALUES ('retry-run', 'x', ?, 'running', 'Basic', '{}', 1)").run(new Date().toISOString());
    await request(app).post('/api/install/jobs/retry-run/retry-failed').set(bearer(op)).expect(409);
});

// --- target restriction ---------------------------------------------------------------------------

test('unknown targets are rejected with the list; Operator cannot override; SuperAdmin can (audited, listed in the job)', async () => {
    const body = { ips: ['10.20.0.1', '10.250.0.1', '10.250.0.2'] };
    const r = await submit(op, body);
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.unknownTargets, ['10.250.0.1', '10.250.0.2']);
    assert.match(r.body.error, /10\.250\.0\.1/);
    assert.equal(psCalls.length, 0);
    assert.equal(audits.length, 0);
    const o = await submit(op, { ...body, allowUnknownTargets: true });
    assert.equal(o.status, 403);
    assert.equal(psCalls.length, 0);
    await submit(admin, { ...body, allowUnknownTargets: 'yes' }).then(x => assert.equal(x.status, 400));
    const a = await submit(admin, { ...body, allowUnknownTargets: true });
    assert.equal(a.status, 202);
    await jobs.whenIdle(a.body.jobId);
    const j = (await request(app).get(`/api/install/jobs/${a.body.jobId}`).set(bearer(admin))).body;
    assert.deepEqual(j.job.unknownTargets, ['10.250.0.1', '10.250.0.2']);
    assert.equal(j.job.request.allowUnknownTargets, true);
    assert.equal(j.hosts.length, 3);
    assert.ok(audits.some(x => /Unknown-target override/.test(x[2]) && x[2].includes('10.250.0.1') && x[0] === 'superadmin'));
});

test('a CMDB server counts as known; one flagged deleted in the CMDB meta does not (unless inventory knows it)', async () => {
    cmdb.upsertCmdbServer({ ip: '10.30.0.1', hostname: 'cmdb-one' }, 'MANUAL');
    cmdb.upsertCmdbServer({ ip: '10.30.0.2', hostname: 'cmdb-two' }, 'MANUAL');
    writeDataSync('server_operation/server_cmdb_meta.json', { '10.30.0.2': { deleted: true, deletedNames: ['cmdb-two'] } });
    try {
        const ok = await submit(op, { ips: ['10.30.0.1'] });
        assert.equal(ok.status, 202);
        await jobs.whenIdle(ok.body.jobId);
        const bad = await submit(op, { ips: ['10.30.0.2'] });
        assert.equal(bad.status, 400);
        assert.deepEqual(bad.body.unknownTargets, ['10.30.0.2']);
    } finally {
        writeDataSync('server_operation/server_cmdb_meta.json', {});
    }
});

// --- precheck -------------------------------------------------------------------------------------

function winProbe({ hasX = true, freeGB = 50, ok = true, error = '' } = {}) {
    return async (script) => {
        if (script.includes('NASCheck')) return nasLine({ ok: true, error: '' });
        return preLine({ ok, hostname: 'GUEST1', hasX, freeGB, error });
    };
}

test('precheck: shape, one NAS check per request, only read-only scripts, never the install runners', async () => {
    psImpl = winProbe();
    const before = new Date().toISOString();
    const r = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.20.0.1', '10.20.0.2', '10.20.0.3'], buType: 'BU-A' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.hosts.length, 3);
    const h = r.body.hosts[0];
    assert.equal(h.ip, '10.20.0.1');
    assert.equal(h.known, true);
    assert.equal(h.hostname, 'HOST-10.20.0.1');
    assert.deepEqual(h.checks.map(c => c.id), ['known-target', 'reachable', 'auth', 'disk', 'installed', 'nas', 'alreadyRunning']);
    assert.ok(h.checks.every(c => typeof c.ok === 'boolean' && typeof c.message === 'string'));
    assert.equal(h.ok, true);
    assert.equal(r.body.ok, true);
    assert.equal(psCalls.filter(c => c.script.includes('NASCheck')).length, 1, 'NAS checked once, not per host');
    assert.equal(psCalls.length, 4, '1 NAS + 3 host probes');
    for (const c of psCalls) {
        for (const bad of ['$packages', 'Copy-Item', 'Start-Process', 'Restart-Computer', 'ProcessStartInfo', 'Set-Disk', 'msiexec']) assert.ok(!c.script.includes(bad), `precheck script must not contain ${bad}`);
        assert.ok(!c.script.includes(SECRET));
    }
    assert.equal(sshCalls.length, 0);
    assert.equal(jobs.getHandle().prepare('SELECT COUNT(*) AS c FROM provision_jobs WHERE createdAt >= ?').get(before).c, 0, 'results are not stored');
});

test('precheck: unreachable, low disk, missing X:, auth failure, unknown target (no credentials used), already running', async () => {
    tcpImpl = async (ip) => ip !== '10.20.0.2';
    let n = 0;
    psImpl = async (script) => {
        if (script.includes('NASCheck')) return nasLine({ ok: false, error: 'Path not found' });
        n++;
        if (script.includes("'10.20.0.3'")) return preLine({ ok: true, hostname: 'G3', hasX: true, freeGB: 2 });
        if (script.includes("'10.20.0.4'")) return preLine({ ok: true, hostname: 'G4', hasX: false, freeGB: null });
        if (script.includes("'10.20.0.5'")) return preLine({ ok: false, error: `Access is denied ${SECRET}` });
        return preLine({ ok: true, hostname: 'G', hasX: true, freeGB: 100 });
    };
    // lock for 10.20.0.6
    const gate = deferred();
    const holdPs = psImpl;
    psImpl = async () => { await gate.promise; return okOutput(); };
    const held = await submit(op, { ips: ['10.20.0.6'] });
    await tick(30);
    psImpl = holdPs;
    psCalls.length = 0;
    const r = await request(app).post('/api/install/precheck').set(bearer(opWithPwd)).send({ ips: ['10.20.0.2', '10.20.0.3', '10.20.0.4', '10.20.0.5', '10.20.0.6', '10.250.9.9'], buType: 'BU-A' });
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.body.hosts.map(h => [h.ip, Object.fromEntries(h.checks.map(c => [c.id, c]))]));
    assert.equal(by['10.20.0.2'].reachable.ok, false);
    assert.match(by['10.20.0.2'].auth.message, /not reachable/);
    assert.equal(by['10.20.0.3'].disk.ok, false);
    assert.match(by['10.20.0.3'].disk.message, /2 GB free.*5 GB/);
    assert.equal(by['10.20.0.4'].disk.ok, false);
    assert.equal(by['10.20.0.5'].auth.ok, false);
    assert.ok(!JSON.stringify(r.body).includes(SECRET));
    assert.equal(by['10.20.0.6'].alreadyRunning.ok, false);
    assert.match(by['10.20.0.6'].alreadyRunning.message, new RegExp(held.body.jobId));
    const unknown = r.body.hosts.find(h => h.ip === '10.250.9.9');
    assert.equal(unknown.known, false);
    assert.equal(unknown.checks.find(c => c.id === 'known-target').ok, false);
    assert.equal(unknown.checks.find(c => c.id === 'auth').ok, false);
    assert.ok(!psCalls.some(c => c.script.includes('10.250.9.9')), 'credentials are never used against an unknown target');
    assert.equal(by['10.20.0.3'].nas.ok, false);
    assert.equal(r.body.ok, false);
    assert.match(by['10.20.0.4'].disk.message, /Drive X: not found \u2014 prepare the data disk \(Nutanix Clone VM does this\)/);
    // Disk Setup is gone: the legacy setDisk field changes nothing, X: stays mandatory
    const withDisk = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.20.0.4'], setDisk: true });
    assert.equal(withDisk.body.hosts[0].checks.find(c => c.id === 'disk').ok, false);
    gate.resolve();
    await jobs.whenIdle(held.body.jobId);
    // an Operator cannot probe unknown targets by override; SuperAdmin can
    await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.250.9.9'], allowUnknownTargets: true }).expect(403);
    psCalls.length = 0;
    const sa = await request(app).post('/api/install/precheck').set(bearer(admin)).send({ ips: ['10.250.9.9'], allowUnknownTargets: true });
    assert.equal(sa.status, 200);
    assert.ok(psCalls.some(c => c.script.includes('10.250.9.9')));
});

test('precheck: Linux uses only "echo ok" over SSH with host key pinning and a 20 s timeout; validation errors are 400', async () => {
    const r = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.20.0.1'], osType: 'linux' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.hosts[0].checks.map(c => c.id), ['known-target', 'reachable', 'auth', 'installed', 'alreadyRunning']);
    assert.equal(sshCalls.length, 1);
    const [ip, user, , cmd, opts] = sshCalls[0];
    assert.equal(ip, '10.20.0.1'); assert.equal(user, 'svc');
    assert.equal(cmd, 'echo ok');
    assert.equal(opts.pinHostKey, true);
    assert.equal(opts.timeout, 20000);
    assert.equal(psCalls.length, 0);
    assert.equal(r.body.hosts[0].ok, true);
    sshImpl = async () => { throw new Error('host key changed'); };
    const bad = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.20.0.1'], osType: 'linux' });
    assert.equal(bad.body.hosts[0].checks.find(c => c.id === 'auth').ok, false);
    for (const body of [{}, { ips: ['x;calc'] }, { ips: ['10.20.0.1'], buType: 'Nope' }, { ips: ['10.20.0.1'], software: 'x' }, { ips: ['10.20.0.1'], software: ['Nope'] }]) {
        await request(app).post('/api/install/precheck').set(bearer(op)).send(body).expect(400);
    }
});

// --- targets --------------------------------------------------------------------------------------

test('targets: Operator+ only, CMDB + inventory merged, search is parameterised, deleted CMDB entries are hidden, max 200', async () => {
    cmdb.upsertCmdbServer({ ip: '10.40.0.1', hostname: 'web-cmdb-only', businessUnit: 'BU-A', os: 'Windows' }, 'MANUAL');
    cmdb.upsertCmdbServer({ ip: '10.20.0.1', hostname: 'HOST-10.20.0.1', businessUnit: 'BU-B' }, 'MANUAL');
    cmdb.upsertCmdbServer({ ip: '10.40.0.2', hostname: 'web-deleted' }, 'MANUAL');
    writeDataSync('server_operation/server_cmdb_meta.json', { '10.40.0.2': { deleted: true, deletedNames: ['web-deleted'] } });
    try {
        await request(app).get('/api/install/targets').expect(401);
        await request(app).get('/api/install/targets').set(bearer(viewer)).expect(403);
        await request(app).get('/api/install/targets').set(bearer(noFeature)).expect(403);
        const t = await request(app).get('/api/install/targets?q=web').set(bearer(op));
        assert.equal(t.status, 200);
        assert.deepEqual(t.body.targets.map(x => x.ip), ['10.40.0.1']);
        assert.deepEqual(t.body.targets[0], { ip: '10.40.0.1', hostname: 'web-cmdb-only', os: 'Windows', source: 'cmdb', bu: 'BU-A' });
        const both = (await request(app).get('/api/install/targets?q=10.20.0.1').set(bearer(admin))).body.targets;
        assert.equal(both[0].ip, '10.20.0.1');
        assert.equal(both[0].source, 'both');
        assert.equal(both[0].bu, 'BU-B');
        const inv = (await request(app).get('/api/install/targets?q=10.20.0.2').set(bearer(admin))).body.targets;
        assert.equal(inv[0].source, 'inventory');
        // injection-like and wildcard terms are plain text
        for (const q of ["' OR 1=1 --", "x'); DROP TABLE cmdb_servers;--", '%', '_']) {
            const r = await request(app).get('/api/install/targets').query({ q }).set(bearer(op));
            assert.equal(r.status, 200, q);
            assert.equal(r.body.targets.length, 0, `wildcard / SQL text must not match: ${q}`);
        }
        assert.ok(cmdb.getCmdbServerByIp('10.40.0.1'), 'table still there');
        const lim = (await request(app).get('/api/install/targets?limit=3').set(bearer(op))).body.targets;
        assert.equal(lim.length, 3);
        const big = (await request(app).get('/api/install/targets?limit=100000').set(bearer(op))).body.targets;
        assert.ok(big.length <= 200);
    } finally {
        writeDataSync('server_operation/server_cmdb_meta.json', {});
    }
});

// --- RBAC -----------------------------------------------------------------------------------------

test('RBAC matrix for every new route', async () => {
    const j = await runJob(op, { ips: ['10.20.0.1'] });
    const routes = [
        ['get', '/api/install/jobs', 'read'],
        ['get', `/api/install/jobs/${j.job.id}`, 'read'],
        ['get', '/api/install/targets', 'write'],
        ['post', '/api/install/precheck', 'write'],
        ['post', `/api/install/jobs/${j.job.id}/cancel`, 'write'],
        ['post', `/api/install/jobs/${j.job.id}/retry-failed`, 'write']
    ];
    for (const [m, url, kind] of routes) {
        assert.equal((await request(app)[m](url).send({ ips: ['10.20.0.1'] })).status, 401, `${url} without token`);
        assert.equal((await request(app)[m](url).set(bearer(noFeature)).send({ ips: ['10.20.0.1'] })).status, 403, `${url} without feature`);
        const v = (await request(app)[m](url).set(bearer(viewer)).send({ ips: ['10.20.0.1'] })).status;
        if (kind === 'read') assert.equal(v, 200, `${url} viewer`); else assert.equal(v, 403, `${url} viewer`);
        for (const t of [op, admin]) {
            const s = (await request(app)[m](url).set(bearer(t)).send({ ips: ['10.20.0.1'] })).status;
            assert.ok(s !== 401 && s !== 403, `${url} ${s}`);
        }
    }
    await jobs.whenIdle();
});

// --- retention ------------------------------------------------------------------------------------

test('retention cleanup deletes old finished jobs and their hosts in batches; recent and active jobs stay', async () => {
    const h = jobs.getHandle();
    h.exec("DELETE FROM provision_job_hosts; DELETE FROM provision_jobs;");
    const now = Date.now();
    const old = new Date(now - 400 * 86400000).toISOString();
    const recent = new Date(now - 5 * 86400000).toISOString();
    const insJob = h.prepare("INSERT INTO provision_jobs (id, createdBy, createdAt, status, buType, request, hostCount) VALUES (?, 'x', ?, ?, 'Basic', '{}', 2)");
    const insHost = h.prepare("INSERT INTO provision_job_hosts (jobId, ip, status, packages, log) VALUES (?, ?, 'ok', '[]', '')");
    for (let i = 0; i < 7; i++) { insJob.run(`old-${i}`, old, 'done'); insHost.run(`old-${i}`, '10.0.0.1'); insHost.run(`old-${i}`, '10.0.0.2'); }
    insJob.run('old-running', old, 'running'); insHost.run('old-running', '10.0.0.3');
    for (let i = 0; i < 2; i++) { insJob.run(`new-${i}`, recent, 'done'); insHost.run(`new-${i}`, '10.0.0.4'); }
    insHost.run('ghost-job', '10.0.0.9'); // orphan host row
    const res = await jobs.cleanup({ retentionDays: 180, batchSize: 2, now });
    assert.equal(res.jobs, 7);
    assert.equal(res.hosts, 15, '14 hosts of the old jobs + 1 orphan');
    assert.deepEqual(h.prepare('SELECT id FROM provision_jobs ORDER BY id').all().map(r => r.id), ['new-0', 'new-1', 'old-running']);
    assert.equal(h.prepare('SELECT COUNT(*) AS c FROM provision_job_hosts').get().c, 3);
    assert.equal((await jobs.cleanup({ retentionDays: 180, batchSize: 2, now })).jobs, 0);
});

// --- notifications / secrets ----------------------------------------------------------------------

test('one notification per job (category Provision) with counts and failed hosts', async () => {
    let n = 0;
    psImpl = async () => { n++; return n === 2 ? failOutput() : okOutput(NAMES); };
    const j = await runJob(op, { ips: ['10.20.0.1', '10.20.0.2', '10.20.0.3'], buType: 'BU-A' });
    assert.equal(notifications.length, 1);
    const note = notifications[0];
    assert.equal(note.moduleName, 'Provision');
    assert.ok(note.key.includes(j.job.id));
    assert.ok(note.text.includes(j.job.id));
    assert.match(note.text, /operator/);
    assert.match(note.text, /BU-A/);
    assert.match(note.text, /OK: 2, Failed: 1/);
    assert.ok(note.text.includes('10.20.0.2'));
    assert.ok(!note.text.includes('10.20.0.1'));
    // a skipped-only job still notifies exactly once
    notifications.length = 0;
    await runJob(op, { ips: ['10.20.0.5'] });
    assert.equal(notifications.length, 1);
});

test('no secrets in job rows, logs, audit or notifications; the log is truncated to 64 KB', async () => {
    psImpl = async () => { throw { error: new Error(`boom ${SECRET}`), stderr: `leak ${SECRET}`, stdout: `${'A'.repeat(200000)}\n${hostLine({ connected: true })}` }; };
    const j = await runJob(opWithPwd, { ips: ['10.20.0.1', '10.20.0.2'], buType: 'BU-A' });
    assert.equal(j.job.status, 'failed');
    const h = jobs.getHandle();
    const dump = JSON.stringify([
        h.prepare('SELECT * FROM provision_jobs').all(), h.prepare('SELECT * FROM provision_job_hosts').all(),
        audits, notifications, j
    ]);
    assert.ok(!dump.includes(SECRET));
    assert.ok(!dump.includes('SOMP_CRED_PWD'));
    for (const x of j.hosts) assert.ok(x.log.length <= prov.LOG_MAX_CHARS + 50, `log length ${x.log.length}`);
    assert.ok(j.hosts[0].log.length > 60000, 'but the first 64 KB are kept');
    assert.equal(JSON.stringify(j.job.request).includes('epass'), false);
    // the credential only ever travels in the process environment
    assert.equal(psCalls.at(-1).options.env.SOMP_CRED_PWD, SECRET);
});

// --- fix round 1 ----------------------------------------------------------------------------------

test('I1: an exception around one host (audit throws) does not finalize the job early or touch rows after finishedAt', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '2';
    const origBatched = logger.auditLogBatched;
    let thrown = 0;
    logger.auditLogBatched = (...a) => { if (thrown === 0) { thrown++; throw new Error('audit boom'); } audits.push(a); };
    psImpl = async () => { await tick(20); return okOutput(); };
    try {
        const j = await runJob(op, { ips: KNOWN.slice(0, 5) });
        assert.equal(thrown, 1);
        assert.equal(j.job.status, 'done');
        assert.equal(psCalls.length, 5, 'every host was still processed');
        assert.deepEqual(j.hosts.map(h => h.status), ['ok', 'ok', 'ok', 'ok', 'ok']);
        for (const h of j.hosts) assert.ok(h.finishedAt <= j.job.finishedAt, 'no host row finished after the job');
        assert.equal(j.job.okCount, 5);
    } finally {
        logger.auditLogBatched = origBatched;
    }
});

test('I1: a host whose result write fails is marked failed and the job continues', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '1';
    const h = jobs.getHandle();
    const realPrepare = h.prepare.bind(h);
    let armed = true;
    h.prepare = (sql) => {
        const st = realPrepare(sql);
        if (armed && /SET status = \?, finishedAt = \?, packages/.test(sql)) {
            armed = false;
            return { run: () => { throw new Error('SQLITE_BUSY'); }, get: st.get.bind(st), all: st.all.bind(st) };
        }
        return st;
    };
    try {
        const j = await runJob(op, { ips: ['10.20.0.1', '10.20.0.2', '10.20.0.3'] });
        assert.deepEqual(j.hosts.map(x => x.status), ['failed', 'ok', 'ok']);
        assert.equal(j.hosts[0].error, 'Job runner error');
        assert.equal(j.job.status, 'partial');
        assert.ok(j.job.finishedAt);
    } finally {
        delete h.prepare;
    }
});

test('I2: finalize runs once; throwing audit / notification steps do not break the terminal status; a failing terminal write falls back', async () => {
    const origFile = logger.auditLogFileOnly, origQ = logger.queueNotification;
    logger.auditLogFileOnly = () => { throw new Error('audit down'); };
    logger.queueNotification = () => { throw new Error('notify down'); };
    try {
        const j = await runJob(op, { ips: ['10.20.0.1'] });
        assert.equal(j.job.status, 'done');
        assert.ok(j.job.finishedAt);
        assert.equal(j.job.note, null, 'not rewritten by a second finalize');
    } finally {
        logger.auditLogFileOnly = origFile; logger.queueNotification = origQ;
    }
    // first terminal write attempt throws -> retried once
    let n = 0;
    jobs._hooks.beforeTerminalWrite = () => { if (n++ === 0) throw new Error('busy'); };
    try {
        const j = await runJob(op, { ips: ['10.20.0.2'] });
        assert.equal(j.job.status, 'done');
        assert.equal(notifications.length, 1);
    } finally { jobs._hooks.beforeTerminalWrite = null; }
    // every attempt throws -> last resort marks the job failed with finishedAt
    jobs._hooks.beforeTerminalWrite = () => { throw new Error('dead'); };
    try {
        const j = await runJob(op, { ips: ['10.20.0.3'] });
        assert.equal(j.job.status, 'failed');
        assert.ok(j.job.finishedAt);
        assert.ok(!jobs._live.size, 'live map cleaned');
    } finally { jobs._hooks.beforeTerminalWrite = null; }
});

test('M1: host concurrency is global across jobs', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '3';
    let inflight = 0, max = 0;
    psImpl = async () => { inflight++; max = Math.max(max, inflight); await tick(25); inflight--; return okOutput(); };
    const a = await submit(op, { ips: KNOWN.slice(0, 4) });
    const b = await submit(op, { ips: KNOWN.slice(4, 8) });
    await jobs.whenIdle(a.body.jobId); await jobs.whenIdle(b.body.jobId);
    assert.equal(max, 3);
});

test('M3/N4: one Finished audit, one summary; the summary follows the install audit-log toggle; Finished skips only Telegram', async () => {
    const j = await runJob(op, { ips: ['10.20.0.1'] });
    assert.equal(audits.filter(a => /Finished/.test(a[2])).length, 1);
    assert.equal(notifications.length, 1);
    assert.ok(j.job.id);
    // group with the install audit log switched off: no summary
    const rbac = require('../../lib/rbac');
    const cfg = rbac.readRbacConfig();
    writeRbacConfig({ ...cfg, groups: { ...cfg.groups, prov: { ...cfg.groups.prov, auditLogs: { install: false } } } });
    try {
        notifications.length = 0;
        await runJob(op, { ips: ['10.20.0.2'] });
        assert.equal(notifications.length, 0);
    } finally {
        writeRbacConfig(cfg);
    }
    // real logger: file-only audit dispatches webhooks but never reaches the Telegram code path
    const real = require('fs');
    const wh = require('../../services/webhookService');
    const origTrigger = wh.triggerWebhooks;
    const hooksSeen = [];
    wh.triggerWebhooks = (...a) => { hooksSeen.push(a); };
    const savedTok = process.env.TELEGRAM_BOT_TOKEN, savedChat = process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_BOT_TOKEN = 'x'; process.env.TELEGRAM_CHAT_ID = '1';
    const https = require('https');
    const origGet = https.get, origReq = https.request;
    let net = 0;
    https.get = (...a) => { net++; return origGet(...a); };
    https.request = (...a) => { net++; return origReq(...a); };
    try {
        const sendReal = Object.getOwnPropertyDescriptor(logger, 'auditLogFileOnly').value;
        // the test file replaced the stub; call the original through a fresh module copy
        delete require.cache[require.resolve('../../lib/logger')];
        const fresh = require('../../lib/logger');
        fresh.auditLogFileOnly('SYSTEM', 'Remote Install', 'Finished test');
        await tick(30);
        assert.equal(hooksSeen.length, 1, 'webhooks still receive it');
        assert.equal(net, 0, 'no Telegram request');
        assert.ok(sendReal && real);
    } finally {
        wh.triggerWebhooks = origTrigger; https.get = origGet; https.request = origReq;
        if (savedTok === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = savedTok;
        if (savedChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = savedChat;
    }
});

test('N1: cancelling a job whose hosts wait for a slot finishes it promptly', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '1';
    const gate = deferred();
    psImpl = async () => { await gate.promise; return okOutput(); };
    const a = await submit(op, { ips: ['10.20.0.1'] });
    await tick(30);
    const b = await submit(op, { ips: ['10.20.0.2', '10.20.0.3', '10.20.0.4'] });
    await tick(30);
    assert.equal(psCalls.length, 1, 'B is waiting for a slot');
    await request(app).post(`/api/install/jobs/${b.body.jobId}/cancel`).set(bearer(op)).expect(200);
    await jobs.whenIdle(b.body.jobId); // would hang until A finishes without the fix
    const jb = (await request(app).get(`/api/install/jobs/${b.body.jobId}`).set(bearer(op))).body;
    assert.equal(jb.job.status, 'cancelled');
    assert.deepEqual(jb.hosts.map(h => h.status), ['cancelled', 'cancelled', 'cancelled']);
    assert.equal(psCalls.length, 1);
    gate.resolve();
    await jobs.whenIdle(a.body.jobId);
});

test('N2: a host row whose result could not be recorded is failed and counted at the end', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '1';
    const h = jobs.getHandle();
    const realPrepare = h.prepare.bind(h);
    h.prepare = (sql) => {
        const st = realPrepare(sql);
        if (/SET status = \?, finishedAt = \?, packages/.test(sql) || /SET status = 'failed', finishedAt = \?, error = COALESCE\(error, 'Job runner error'\) WHERE jobId = \? AND ip/.test(sql)) {
            return { run: () => { throw new Error('SQLITE_BUSY'); }, get: st.get.bind(st), all: st.all.bind(st) };
        }
        return st;
    };
    let j;
    try { j = await runJob(op, { ips: ['10.20.0.1', '10.20.0.2'] }); } finally { delete h.prepare; }
    assert.equal(j.hosts[0].status, 'failed');
    assert.equal(j.hosts[0].error, 'Result could not be recorded');
    assert.equal(j.hosts[1].status, 'failed');
    assert.equal(j.job.failCount, 2);
    assert.equal(jobs.activeJobForIp('10.20.0.1'), null, 'no lock left behind');
});

test('N3: one global limit; raising it wakes waiting hosts, nothing is lost', async () => {
    process.env.PROVISION_HOST_CONCURRENCY = '1';
    const gate = deferred();
    let inflight = 0, max = 0;
    psImpl = async () => { inflight++; max = Math.max(max, inflight); await gate.promise; inflight--; return okOutput(); };
    const a = await submit(op, { ips: ['10.20.0.1', '10.20.0.2'] });
    await tick(30);
    assert.equal(inflight, 1);
    process.env.PROVISION_HOST_CONCURRENCY = '3';
    const b = await submit(op, { ips: ['10.20.0.3', '10.20.0.4'] });
    await tick(30);
    assert.equal(inflight, 3, 'the new global limit applies to the waiting host of job A as well');
    gate.resolve();
    await jobs.whenIdle(a.body.jobId); await jobs.whenIdle(b.body.jobId);
    assert.equal(max, 3);
    for (const id of [a.body.jobId, b.body.jobId]) assert.equal((await request(app).get(`/api/install/jobs/${id}`).set(bearer(op))).body.job.status, 'done');
});

test('M6: truncateLog cuts at 64 KB of UTF-8 without splitting a character', () => {
    const cjk = '防'.repeat(40000); // 120000 bytes
    const t = prov.truncateLog(cjk);
    assert.ok(Buffer.byteLength(t) <= prov.LOG_MAX_CHARS + 30);
    assert.ok(!t.includes('�'));
    assert.ok(t.endsWith('...[log truncated]'));
    assert.equal(prov.truncateLog('short'), 'short');
});

test('M7: the Linux pre-check says it pins the host key on first contact; M2: unknown-target override is in the audit', async () => {
    const r = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.20.0.1'], osType: 'linux' });
    assert.match(r.body.note, /first contact/);
    psImpl = winProbe();
    audits.length = 0;
    await request(app).post('/api/install/precheck').set(bearer(admin)).send({ ips: ['10.250.9.9'], allowUnknownTargets: true }).expect(200);
    assert.ok(audits.some(a => /Pre-check/.test(a[2]) && /override used for 10\.250\.9\.9/.test(a[2])));
});

// --- final review fixes ---------------------------------------------------------------------------

test('F-M1: cancel on a job that is active in the DB but has no runner marks it interrupted and releases the IP lock; init retries markInterrupted', async () => {
    const h = jobs.getHandle();
    h.prepare("INSERT INTO provision_jobs (id, createdBy, createdAt, status, buType, request, hostCount) VALUES ('stale-1', 'x', ?, 'running', 'Basic', '{}', 2)").run(new Date().toISOString());
    h.prepare("INSERT INTO provision_job_hosts (jobId, ip, status, packages, log) VALUES ('stale-1', '10.20.0.7', 'running', '[]', '')").run();
    h.prepare("INSERT INTO provision_job_hosts (jobId, ip, status, packages, log) VALUES ('stale-1', '10.20.0.8', 'queued', '[]', '')").run();
    assert.equal(jobs.activeJobForIp('10.20.0.7'), 'stale-1');
    const r = await request(app).post('/api/install/jobs/stale-1/cancel').set(bearer(op));
    assert.equal(r.status, 200);
    assert.equal(r.body.interrupted, true);
    const j = (await request(app).get('/api/install/jobs/stale-1').set(bearer(op))).body;
    assert.equal(j.job.status, 'interrupted');
    assert.deepEqual(j.hosts.map(x => x.status), ['interrupted', 'interrupted']);
    assert.equal(jobs.activeJobForIp('10.20.0.7'), null);
    await request(app).post('/api/install/jobs/stale-1/cancel').set(bearer(op)).expect(409);
    // a live job is never touched by markInterrupted (retry safety)
    const gate = deferred();
    psImpl = async () => { await gate.promise; return okOutput(); };
    const live = await submit(op, { ips: ['10.20.0.1'] });
    await tick(30);
    jobs.markInterrupted();
    assert.equal((await request(app).get(`/api/install/jobs/${live.body.jobId}`).set(bearer(op))).body.job.status, 'running');
    gate.resolve();
    await jobs.whenIdle(live.body.jobId);
});

test('F-M2: logs and long package messages are returned to Operator / SuperAdmin only; others get logHidden', async () => {
    const long = 'x'.repeat(500);
    psImpl = async () => [hostLine({ connected: true }), pkgLine({ name: '7zip', exitCode: 1603, stderr: long }), hostLine({ done: true })].join('\n');
    const j = await runJob(op, { ips: ['10.20.0.1'] });
    for (const t of [op, admin]) {
        const w = (await request(app).get(`/api/install/jobs/${j.job.id}`).set(bearer(t))).body;
        assert.equal(typeof w.hosts[0].log, 'string');
        assert.ok(!('logHidden' in w.hosts[0]));
    }
    const v = (await request(app).get(`/api/install/jobs/${j.job.id}`).set(bearer(viewer))).body;
    assert.ok(!('log' in v.hosts[0]));
    assert.equal(v.hosts[0].logHidden, true);
    assert.ok(!JSON.stringify(v).includes('x'.repeat(250)));
    const vl = (await request(app).get(`/api/install/jobs/${j.job.id}?log=0`).set(bearer(viewer))).body;
    assert.equal(vl.hosts[0].logHidden, true);
});

test('F-M4: pre-check probes of concurrent requests share one global cap of 8', async () => {
    let inflight = 0, max = 0;
    psImpl = async (script) => {
        if (script.includes('NASCheck')) return nasLine({ ok: true });
        inflight++; max = Math.max(max, inflight); await tick(25); inflight--;
        return preLine({ ok: true, hostname: 'G', hasX: true, freeGB: 50 });
    };
    const ips = KNOWN.slice(0, 8);
    const rs = await Promise.all([1, 2, 3].map(() => request(app).post('/api/install/precheck').set(bearer(op)).send({ ips })));
    for (const r of rs) assert.equal(r.status, 200);
    assert.ok(max <= 8, `max in flight ${max}`);
    assert.ok(max >= 4, 'probes still run in parallel');
});

test('F-M5/M6: retry-failed includes skipped hosts and never inherits the unknown-target override', async () => {
    const gate = deferred();
    psImpl = async () => { await gate.promise; return okOutput(); };
    const a = await submit(op, { ips: ['10.20.0.1'] });
    await tick(30);
    psImpl = async () => okOutput();
    const b = await submit(op, { ips: ['10.20.0.1', '10.20.0.2'] });
    await jobs.whenIdle(b.body.jobId);
    gate.resolve();
    await jobs.whenIdle(a.body.jobId);
    const r = await request(app).post(`/api/install/jobs/${b.body.jobId}/retry-failed`).set(bearer(op));
    assert.equal(r.status, 202);
    await jobs.whenIdle(r.body.jobId);
    assert.deepEqual((await request(app).get(`/api/install/jobs/${r.body.jobId}`).set(bearer(op))).body.hosts.map(x => x.ip), ['10.20.0.1']);

    // override job with an unknown host that fails
    psImpl = async () => failOutput();
    const o = await submit(admin, { ips: ['10.20.0.3', '10.250.7.7'], allowUnknownTargets: true });
    await jobs.whenIdle(o.body.jobId);
    const calls = psCalls.length;
    const noFlag = await request(app).post(`/api/install/jobs/${o.body.jobId}/retry-failed`).set(bearer(admin));
    assert.equal(noFlag.status, 400);
    assert.deepEqual(noFlag.body.unknownTargets, ['10.250.7.7']);
    assert.equal(psCalls.length, calls);
    await request(app).post(`/api/install/jobs/${o.body.jobId}/retry-failed`).set(bearer(op)).send({ allowUnknownTargets: true }).expect(403);
    await request(app).post(`/api/install/jobs/${o.body.jobId}/retry-failed`).set(bearer(admin)).send({ allowUnknownTargets: 'yes' }).expect(400);
    psImpl = async () => okOutput();
    const ok = await request(app).post(`/api/install/jobs/${o.body.jobId}/retry-failed`).set(bearer(admin)).send({ allowUnknownTargets: true });
    assert.equal(ok.status, 202);
    await jobs.whenIdle(ok.body.jobId);
});
