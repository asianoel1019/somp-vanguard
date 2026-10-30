// Server Provision phase 3: Disk Setup removal, installed detection, post-install cleanup
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const powershell = require('../../lib/powershell');
const ssh = require('../../lib/ssh');
const logger = require('../../lib/logger');
const netProbe = require('../../lib/netProbe');
const prov = require('../../lib/provisioning');
const store = require('../../services/inventoryStore');
const jobs = require('../../services/provisionJobs');
const runners = require('../../lib/provisionRunners');

const mk = (role) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups: ['prov'] })}`;
const admin = mk('SuperAdmin'), op = mk('Operator');
const bearer = (t) => ({ Authorization: t });
const BACKEND = path.join(__dirname, '..', '..');

let app;
const psCalls = [];
const sshCalls = [];
let psImpl, sshImpl;

const pkgLine = (o) => `${prov.PKG_MARK}${JSON.stringify({ idx: 0, kind: 'installer', timedOut: false, error: '', stdout: '', stderr: '', ...o })}`;
const hostLine = (o) => `${prov.HOST_MARK}${JSON.stringify(o)}`;
const okOutput = (extra = []) => ['Connecting...', hostLine({ connected: true }), pkgLine({ name: '7zip', exitCode: 0 }), ...extra, hostLine({ done: true })].join('\n');
const preLine = (o) => `${prov.PRE_MARK}${JSON.stringify(o)}`;
const nasLine = (o) => `${prov.NAS_MARK}${JSON.stringify(o)}`;

async function withEnv(vars, fn) {
    const old = {};
    for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; }
    try { return await fn(); } finally {
        for (const k of Object.keys(vars)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    }
}

async function runJob(token, body) {
    const r = await request(app).post('/api/install/execute').set(bearer(token)).send(body);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await jobs.whenIdle(r.body.jobId);
    const j = (await request(app).get(`/api/install/jobs/${r.body.jobId}`).set(bearer(admin))).body;
    return { jobId: r.body.jobId, ...j };
}

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { prov: { enabled: true, features: { install: true }, auditLogs: { install: true } } }
    });
    process.env.REMOTE_INSTALL_BUS = 'BU-A';
    process.env.REMOTE_INSTALL_SOFTWARE_MASTER = '7zip|\\\\srv\\share\\7z.exe|/S\nTool|tools\\setup.bat|-q';
    process.env.REMOTE_INSTALL_SOFTWARE_Basic = '7zip';
    process.env.REMOTE_INSTALL_SOFTWARE_BU_A = '7zip,Tool';
    process.env.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER = 'pkgA|yum install -y a\npkgB|yum install -y b';
    process.env.REMOTE_INSTALL_LINUX_SOFTWARE_Basic = 'pkgA,pkgB';
    process.env.SYSNAS_SOFTWARE_PATH = '\\\\srv\\share';
    process.env.LINUX_ADMIN_USER = 'svc';
    process.env.LINUX_ADMIN_PWD = 'linux-pw';
    process.env.AD_ADMIN_USER = 'svc-prov';
    process.env.AD_ADMIN_PWD = 'svc-pw';
    process.env.PROVISION_HOST_CONCURRENCY = '4';
    for (const ip of ['10.30.0.1', '10.30.0.2', '10.30.0.3']) store.upsertScanResult(ip, { hostname: `H-${ip}`, status: 'online', os: 'Windows Server 2022' });

    powershell.runPowerShell = async (script, timeout, options) => { psCalls.push({ script, timeout, options }); return psImpl(script, timeout, options); };
    ssh.executeSSH = async (...args) => { sshCalls.push(args); return sshImpl(...args); };
    logger.auditLog = () => {};
    logger.auditLogBatched = () => {};
    logger.auditLogFileOnly = () => {};
    logger.queueNotification = () => {};
    netProbe.checkTcpPort = async () => true;

    app = express();
    app.use(express.json());
    app.use('/api/install', require('../../routes/install'));
});
test.after(async () => { await jobs.whenIdle(); await dbManager.closeDB(); });
test.beforeEach(() => {
    psCalls.length = 0; sshCalls.length = 0;
    psImpl = async () => okOutput();
    sshImpl = async () => ({ success: true, code: 0, stdout: 'ok', stderr: '' });
});

const baseOpts = { ip: '10.30.0.1', nasPath: '\\\\srv\\share', credentialHeader: '' };
const pk = [{ name: '7zip', path: 'a.exe', args: '/S' }, { name: 'Tool', path: 'my tools\\setup.bat', args: '' }, { name: 'Dir', path: '\\\\srv\\share\\datadir', args: '' }];

// ---------------------------------------------------------------------------------------------
// 1. Disk Setup is gone
// ---------------------------------------------------------------------------------------------
test('Disk Setup removal: no provisioning code path formats disks, renames the NIC or disables IPv6', () => {
    assert.equal(prov.PREP_SCRIPT, undefined);
    for (const f of ['lib/provisioning.js', 'lib/provisionRunners.js', 'services/provisionJobs.js', 'services/provisionPrecheck.js', 'routes/install.js']) {
        const src = fs.readFileSync(path.join(BACKEND, f), 'utf8');
        for (const bad of ['Set-Disk', 'Rename-NetAdapter', 'ms_tcpip6', 'Set-Partition', 'Set-Volume', 'PrepScript', 'doDisk', 'PREP_SCRIPT']) assert.ok(!src.includes(bad), `${f} must not contain ${bad}`);
    }
    const scripts = [
        prov.buildWindowsHostScript({ ...baseOpts, packages: pk, reboot: true }),
        prov.buildWindowsPrecheckScript({ ip: '10.30.0.1', credentialHeader: '' }),
        prov.buildNasCheckScript({ nasPath: '\\\\srv\\share', credentialHeader: '' })
    ];
    for (const s of scripts) for (const bad of ['Set-Disk', 'Rename-NetAdapter', 'ms_tcpip6', 'Set-Partition', 'Initialize-Disk', 'Format-Volume']) assert.ok(!s.includes(bad), bad);
});

test('Disk Setup removal: Nutanix Clone VM keeps its own scripts and does not depend on the provisioning module', () => {
    const nut = fs.readFileSync(path.join(BACKEND, 'lib', 'nutanix_clone_vm_api.ps1'), 'utf8');
    assert.ok(nut.includes('Set-Disk') && nut.includes('Rename-NetAdapter'), 'Nutanix still prepares the disk itself');
    const route = fs.readFileSync(path.join(BACKEND, 'routes', 'nutanix.js'), 'utf8');
    assert.ok(!route.includes("require('../lib/provisioning')") && !route.includes('PREP_SCRIPT'));
});

test('Disk Setup removal: a legacy setDisk field is ignored (any value), never stored and never changes the script', async () => {
    const cfg = prov.loadInstallConfig({}, process.env);
    for (const v of [true, false, 'yes', 1, null]) {
        const r = prov.validateExecuteBody({ ips: ['10.30.0.1'], setDisk: v }, cfg);
        assert.ok(r.value, `setDisk=${String(v)}`);
        assert.equal('setDisk' in r.value, false);
    }
    const j = await runJob(op, { ips: ['10.30.0.1'], setDisk: true });
    assert.equal(j.job.status, 'done');
    assert.equal('setDisk' in j.job.request, false);
    assert.ok(!psCalls[0].script.includes('Set-Disk'));
});

test('Disk Setup removal: an old job request that carries setDisk can still be retried', async () => {
    psImpl = async () => [hostLine({ connected: true }), pkgLine({ name: '7zip', exitCode: 1603, stderr: 'fatal' }), hostLine({ done: true })].join('\n');
    const j = await runJob(op, { ips: ['10.30.0.2'] });
    assert.equal(j.job.status, 'failed');
    const h = jobs.getHandle();
    const req = JSON.parse(h.prepare('SELECT request FROM provision_jobs WHERE id = ?').get(j.jobId).request);
    h.prepare('UPDATE provision_jobs SET request = ? WHERE id = ?').run(JSON.stringify({ ...req, setDisk: true }), j.jobId);
    psImpl = async () => okOutput();
    const r = await request(app).post(`/api/install/jobs/${j.jobId}/retry-failed`).set(bearer(op)).send({});
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await jobs.whenIdle(r.body.jobId);
    const again = (await request(app).get(`/api/install/jobs/${r.body.jobId}`).set(bearer(admin))).body;
    assert.equal(again.job.status, 'done');
    assert.equal('setDisk' in again.job.request, false);
});

test('Disk Setup removal: a missing X: fails the guest package with the Nutanix hint, no script prepares the disk', () => {
    const s = prov.buildWindowsHostScript({ ...baseOpts, packages: pk });
    assert.ok(s.includes('Guest drive X: not found - prepare the data disk (Nutanix Clone VM does this)'));
});

// ---------------------------------------------------------------------------------------------
// 2. Installed detection
// ---------------------------------------------------------------------------------------------
const detPk = [
    { name: 'Chrome', path: 'chrome\\setup.msi', args: '/qn', detect: { type: 'reg', value: "Google Chrome*", minVersion: '120.0' } },
    { name: 'Agent', path: 'agent\\agent.exe', args: '', detect: { type: 'file', value: 'C:\\Program Files\\Agent\\agent.exe', minVersion: '' } },
    { name: 'Plain', path: 'plain\\p.exe', args: '' }
];

test('detect: the generated script carries each rule as psQuote literals and the guest check runs before the copy', () => {
    const s = prov.buildWindowsHostScript({ ...baseOpts, packages: detPk, jobId: 'job-1' });
    assert.ok(s.includes("DetectType = 'reg'; DetectValue = 'Google Chrome*'; DetectMin = '120.0'"));
    assert.ok(s.includes("DetectType = 'file'; DetectValue = 'C:\\Program Files\\Agent\\agent.exe'; DetectMin = ''"));
    assert.ok(s.includes("DetectType = ''; DetectValue = ''; DetectMin = ''"), 'packages without a rule have empty fields');
    assert.ok(s.includes('$guestDetect = {'));
    assert.ok(s.includes('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'));
    assert.ok(s.includes('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'));
    assert.ok(s.includes('$forceReinstall = $false'));
    assert.ok(s.indexOf('-ScriptBlock $guestDetect') < s.indexOf('$pkgDir = '), 'detection happens before anything is copied');
    assert.ok(s.includes('$r.skipped = $true'));
    assert.ok(prov.buildWindowsHostScript({ ...baseOpts, packages: detPk, forceReinstall: true }).includes('$forceReinstall = $true'));
});

test('detect: hostile rule values stay inside single-quoted literals and never reach the script as code', () => {
    const evil = "x'; Remove-Item C:\\ -Recurse; '";
    const s = prov.buildWindowsHostScript({ ...baseOpts, packages: [{ name: 'E', path: 'e.exe', args: '', detect: { type: 'reg', value: evil, minVersion: '' } }] });
    assert.ok(s.includes("DetectValue = 'x''; Remove-Item C:\\ -Recurse; '''"));
    // the value is only ever passed as an ArgumentList element to the guest scriptblock
    assert.ok(s.includes('-ArgumentList @($pkg.DetectType, $pkg.DetectValue, $pkg.DetectMin)'));
});

test('detect: a skipped package is { ok: true, skipped: true, exitCode: null, message: "Already installed (<version>)" }', () => {
    assert.deepEqual(prov.evaluatePackage({ name: 'Chrome', skipped: true, version: '120.0.1', exitCode: null }),
        { name: 'Chrome', exitCode: null, ok: true, skipped: true, rebootRequired: false, message: 'Already installed (120.0.1)' });
    assert.equal(prov.evaluatePackage({ name: 'Chrome', skipped: true, version: '' }).message, 'Already installed');
    const out = ['x', hostLine({ connected: true }), pkgLine({ idx: 0, name: 'a', skipped: true, version: '1.2' }), pkgLine({ idx: 1, name: 'b', exitCode: 0 }), hostLine({ done: true })].join('\n');
    const r = prov.parseHostOutput(out, '10.30.0.1', ['Chrome', 'Tool']);
    assert.equal(r.ok, true);
    assert.equal(r.packages[0].skipped, true);
    assert.equal(r.packages[0].name, 'Chrome');
    assert.equal(r.packages[1].skipped, undefined);
    assert.match(r.log, /\[SKIP\] Chrome: Already installed \(1\.2\)/);
});

test('detect: end to end, the job result carries the skipped package and forceReinstall reaches the guest script', async () => {
    await withEnv({ REMOTE_INSTALL_SOFTWARE_MASTER: '7zip|\\\\srv\\share\\7z.exe|/S|@detect:reg:7-Zip*>=19.0' }, async () => {
        psImpl = async () => [hostLine({ connected: true }), pkgLine({ idx: 0, name: '7zip', skipped: true, version: '23.01' }), hostLine({ done: true })].join('\n');
        const j = await runJob(op, { ips: ['10.30.0.1'] });
        assert.equal(j.job.status, 'done');
        assert.equal(j.hosts[0].status, 'ok');
        assert.deepEqual(j.hosts[0].packages[0], { name: '7zip', exitCode: null, ok: true, skipped: true, rebootRequired: false, message: 'Already installed (23.01)' });
        assert.ok(psCalls[0].script.includes("DetectValue = '7-Zip*'; DetectMin = '19.0'"));
        assert.ok(psCalls[0].script.includes('$forceReinstall = $false'));
        assert.equal(j.job.request.forceReinstall, false);
        psCalls.length = 0;
        const f = await runJob(op, { ips: ['10.30.0.2'], forceReinstall: true, keepInstallers: true });
        assert.equal(f.job.request.forceReinstall, true);
        assert.equal(f.job.request.keepInstallers, true);
        assert.ok(psCalls[0].script.includes('$forceReinstall = $true'));
        assert.ok(psCalls[0].script.includes('$keepInstallers = $true'));
    });
});

test('detect: forceReinstall and keepInstallers must be booleans', async () => {
    for (const body of [{ forceReinstall: 'yes' }, { keepInstallers: 1 }]) {
        const r = await request(app).post('/api/install/execute').set(bearer(op)).send({ ips: ['10.30.0.1'], ...body });
        assert.equal(r.status, 400);
    }
    assert.equal(psCalls.length, 0);
});

test('detect: an invalid rule in the master list is a 400 for execute and pre-check, before any runner', async () => {
    await withEnv({ REMOTE_INSTALL_SOFTWARE_MASTER: '7zip|\\\\srv\\share\\7z.exe|/S|@detect:bogus:x' }, async () => {
        const r = await request(app).post('/api/install/execute').set(bearer(op)).send({ ips: ['10.30.0.1'] });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /Invalid detect rule for "7zip".*Unknown detect type/);
        const p = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.30.0.1'] });
        assert.equal(p.status, 400);
        assert.equal(psCalls.length, 0);
    });
});

test('detect: GET /config exposes the rule to writers only as a flag for others', async () => {
    await withEnv({ REMOTE_INSTALL_SOFTWARE_MASTER: '7zip|\\\\srv\\share\\7z.exe|/S|@detect:reg:7-Zip*', REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'pkgA|yum install -y a|@detect:rpm:pkgA' }, async () => {
        const w = (await request(app).get('/api/install/config').set(bearer(op))).body;
        assert.equal(w.masterList[0].detect.type, 'reg');
        assert.equal(w.masterList[0].args, '/S', 'the detect segment is not part of the args');
        assert.equal(w.linuxMasterList[0].command, 'yum install -y a', 'nor of the command');
        assert.equal(w.linuxMasterList[0].detect.type, 'rpm');
    });
});

test('detect (Windows pre-check): the probe script carries the rules and the result becomes one informational "installed" row', async () => {
    await withEnv({ REMOTE_INSTALL_SOFTWARE_MASTER: '7zip|\\\\srv\\share\\7z.exe|/S|@detect:reg:7-Zip*\nTool|tools\\setup.bat|-q' }, async () => {
        psImpl = async (script) => {
            if (script.includes('NASCheck')) return nasLine({ ok: true });
            return preLine({ ok: true, hostname: 'G', hasX: true, freeGB: 100, installed: [{ idx: 0, found: true, version: '23.01' }] });
        };
        const r = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.30.0.1'], buType: 'BU-A' });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const probe = psCalls.find(c => !c.script.includes('NASCheck')).script;
        assert.ok(probe.includes("Type = 'reg'; Value = '7-Zip*'; Min = ''"));
        assert.ok(!probe.includes('Tool'), 'only packages with a rule are probed');
        const row = r.body.hosts[0].checks.find(c => c.id === 'installed');
        assert.equal(row.ok, true);
        assert.match(row.message, /Already installed, will be skipped: 7zip \(23\.01\)/);
        assert.equal(r.body.hosts[0].ok, true, 'informational: never fails the host');

        psCalls.length = 0;
        const f = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.30.0.1'], buType: 'BU-A', forceReinstall: true });
        const frow = f.body.hosts[0].checks.find(c => c.id === 'installed');
        assert.match(frow.message, /Force reinstall is on/);
        assert.ok(!psCalls.find(c => !c.script.includes('NASCheck')).script.includes('Value = '), 'no detection is run when forced');
    });
});

test('detect (Windows pre-check): without any rule the row says so and the probe script has no detection', async () => {
    psImpl = async (script) => (script.includes('NASCheck') ? nasLine({ ok: true }) : preLine({ ok: true, hostname: 'G', hasX: true, freeGB: 100 }));
    const r = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.30.0.1'] });
    assert.match(r.body.hosts[0].checks.find(c => c.id === 'installed').message, /No detect rules configured/);
    assert.ok(!psCalls.find(c => !c.script.includes('NASCheck')).script.includes('$guestDetect = {'));
});

test('detect (Linux): rpm / dpkg / cmd commands are shell-quoted; found packages are skipped, others installed', async () => {
    await withEnv({ REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'pkgA|yum install -y a|@detect:rpm:pkgA\npkgB|apt-get install -y b|@detect:dpkg:openssh-server\npkgC|install-c.sh|@detect:cmd:test -x /opt/c/bin/c', REMOTE_INSTALL_LINUX_SOFTWARE_Basic: 'pkgA,pkgB,pkgC' }, async () => {
        sshImpl = async (ip, user, pwd, cmd) => {
            if (cmd.startsWith('rpm -q')) return { success: true, code: 0, stdout: '1.4-2', stderr: '' };
            if (cmd.startsWith('dpkg-query')) return { success: true, code: 1, stdout: '', stderr: 'no packages found' };
            if (cmd.includes('test -x /opt/c/bin/c')) return { success: true, code: 1, stdout: '', stderr: '' };
            return { success: true, code: 0, stdout: 'done', stderr: '' };
        };
        const j = await runJob(op, { ips: ['10.30.0.1'], osType: 'linux' });
        assert.equal(j.job.status, 'done');
        const pk2 = j.hosts[0].packages;
        assert.deepEqual(pk2[0], { name: 'pkgA', exitCode: null, ok: true, skipped: true, rebootRequired: false, message: 'Already installed (1.4-2)' });
        assert.equal(pk2[1].skipped, undefined);
        assert.equal(pk2[2].skipped, undefined);
        const cmds = sshCalls.map(c => c[3]);
        assert.ok(cmds.includes("rpm -q --qf '%{VERSION}-%{RELEASE}\\n' 'pkgA'"));
        assert.ok(cmds.includes("dpkg-query -W -f='${Status}|${Version}\\n' 'openssh-server'"));
        assert.ok(!cmds.some(c => c.includes('yum install -y a')), 'the skipped package is not installed');
        assert.ok(cmds.some(c => c.includes('apt-get install -y b')) && cmds.some(c => c.includes('install-c.sh')));
        assert.match(j.hosts[0].log, /\[SKIP\] pkgA/);
    });
});

test('detect (Linux): dpkg state other than "install ok installed" is not installed; forceReinstall skips detection', async () => {
    assert.deepEqual(prov.parseLinuxDetect({ type: 'dpkg' }, { code: 0, stdout: 'deinstall ok config-files|1.0' }), { found: false, version: '' });
    assert.deepEqual(prov.parseLinuxDetect({ type: 'dpkg' }, { code: 0, stdout: 'install ok installed|1.0-3' }), { found: true, version: '1.0-3' });
    assert.deepEqual(prov.parseLinuxDetect({ type: 'cmd' }, { code: 0, stdout: '' }), { found: true, version: '' });
    assert.deepEqual(prov.parseLinuxDetect({ type: 'rpm' }, { code: 1, stdout: 'package x is not installed' }), { found: false, version: '' });
    await withEnv({ REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'pkgA|yum install -y a|@detect:rpm:pkgA', REMOTE_INSTALL_LINUX_SOFTWARE_Basic: 'pkgA' }, async () => {
        const j = await runJob(op, { ips: ['10.30.0.1'], osType: 'linux', forceReinstall: true });
        assert.equal(j.hosts[0].packages[0].skipped, undefined);
        assert.ok(!sshCalls.some(c => String(c[3]).startsWith('rpm -q')), 'no detection when forced');
        assert.ok(sshCalls.some(c => String(c[3]).includes('yum install -y a')));
    });
});

test('detect (Linux): a "sudo" user runs a cmd rule through sudo with the password on stdin only', async () => {
    await withEnv({ REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: "pkgA|yum install -y a|@detect:cmd:test -x '/opt/a b/x'", REMOTE_INSTALL_LINUX_SOFTWARE_Basic: 'pkgA' }, async () => {
        sshImpl = async (ip, user, pwd, cmd) => (cmd.includes('/opt/a b/x') ? { success: true, code: 0, stdout: '', stderr: '' } : { success: true, code: 0, stdout: 'ok', stderr: '' });
        const j = await runJob(op, { ips: ['10.30.0.1'], osType: 'linux' });
        assert.equal(j.hosts[0].packages[0].skipped, true);
        const call = sshCalls.find(c => String(c[3]).includes('/opt/a b/x'));
        assert.match(call[3], /^sudo -k; sudo -S -p '' sh -c /);
        assert.equal(call[4].stdin, 'linux-pw\n');
        assert.ok(!call[3].includes('linux-pw'));
    });
});

test('detect (Linux pre-check): rules are queried after the SSH login and reported as one row', async () => {
    await withEnv({ REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'pkgA|yum install -y a|@detect:rpm:pkgA\npkgB|yum install -y b', REMOTE_INSTALL_LINUX_SOFTWARE_Basic: 'pkgA,pkgB' }, async () => {
        sshImpl = async (ip, user, pwd, cmd) => (cmd.startsWith('rpm -q') ? { success: true, code: 0, stdout: '2.0-1', stderr: '' } : { success: true, code: 0, stdout: 'ok', stderr: '' });
        const r = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.30.0.1'], osType: 'linux' });
        assert.equal(r.status, 200);
        assert.deepEqual(sshCalls.map(c => c[3]), ['echo ok', "rpm -q --qf '%{VERSION}-%{RELEASE}\\n' 'pkgA'"]);
        const row = r.body.hosts[0].checks.find(c => c.id === 'installed');
        assert.match(row.message, /Already installed, will be skipped: pkgA \(2\.0-1\)/);
        assert.equal(r.body.hosts[0].ok, true);
    });
});

// ---------------------------------------------------------------------------------------------
// 3. Post-install cleanup
// ---------------------------------------------------------------------------------------------
test('cleanup: installers go to X:\\SOMP_Provision\\<jobId>\\<n>\\ and only that folder is ever removed', async () => {
    const j = await runJob(op, { ips: ['10.30.0.1'], buType: 'BU-A' });
    const s = psCalls[0].script;
    assert.ok(s.includes(`$jobDir = 'X:\\SOMP_Provision\\${j.jobId}'`), 'per-job folder named after the job');
    assert.ok(s.includes("$jobRoot = 'X:\\SOMP_Provision'"));
    assert.ok(s.includes("$pkgDir = $jobDir + '\\' + $i"));
    assert.ok(s.includes("$pkgDir = 'X:\\' + $pkg.FolderName"), 'script packages keep the old X:\\<folder> location and are not cleaned');
    assert.ok(/IsScript\) \{[^}]*pkgDir = 'X:\\' \+ \$pkg\.FolderName[^}]*\} else \{[^}]*jobDirUsed = \$true/.test(s), 'only single installers mark the job folder for cleanup');
    // every Remove-Item in the script: the msi log, the guarded job folder, the (empty) root, PS drive / session handles
    const removes = [...s.matchAll(/Remove-Item -LiteralPath (\S+)/g)].map(m => m[1]);
    assert.deepEqual([...new Set(removes)].sort(), ['$d', '$dir.FullName', '$msiLog', '$r'].sort());
    assert.ok(!/Remove-Item[^\n]*\*/.test(s), 'no wildcard deletes');
    assert.ok(s.includes("Refusing to delete outside the job work directory"));
    assert.ok(s.includes("$d.StartsWith($r + '\\'"), 'the target must be below the root');
    assert.ok(s.includes('$keepInstallers = $false'));
    assert.ok(s.indexOf('Invoke-Cleanup\n\n    if ($doReboot)') > 0, 'cleanup runs before the optional reboot');
    // a copy-only package (folder delivery) is not tracked for cleanup: it lands in X:\<name>
    const withCopy = prov.buildWindowsHostScript({ ...baseOpts, packages: pk, jobId: 'j2' });
    assert.ok(withCopy.includes("$destDir = 'X:\\' + $pkg.SafeName"));
    assert.ok(/\$r\.kind = 'copy'[\s\S]*?Copy-Children \$src \$destDir/.test(withCopy));
    assert.ok(!/kind = 'copy'[\s\S]{0,200}jobDirUsed/.test(withCopy));
});

test('cleanup: install_*.log content is read into the output before the folder is removed', () => {
    const s = prov.buildWindowsHostScript({ ...baseOpts, packages: pk, jobId: 'j3' });
    const readAt = s.indexOf('-ScriptBlock $guestReadLogs');
    const removeAt = s.indexOf('-ScriptBlock $guestRemove');
    assert.ok(readAt > 0 && removeAt > readAt, 'logs are captured first');
    assert.ok(s.includes("-Filter 'install_*.log'"));
    assert.ok(s.includes("Write-Output ('    ' + $ln)"), 'log text is indented so it can never look like a result marker');
});

test('cleanup: log text can never forge a result line (markers must start the line)', () => {
    const out = [hostLine({ connected: true }), pkgLine({ idx: 0, name: 'a', exitCode: 1603 }), '--- install_x.log ---', `    ${prov.PKG_MARK}${JSON.stringify({ idx: 0, exitCode: 0 })}`, hostLine({ done: true })].join('\n');
    const r = prov.parseHostOutput(out, '10.30.0.1', ['a']);
    assert.equal(r.packages[0].ok, false);
    assert.match(r.log, /--- install_x\.log ---/);
});

test('cleanup: keepInstallers leaves the folder and says where it is; the default removes it', async () => {
    const kept = prov.buildWindowsHostScript({ ...baseOpts, packages: pk, jobId: 'keep-1', keepInstallers: true });
    assert.ok(kept.includes('$keepInstallers = $true'));
    assert.ok(kept.includes("Installers kept on the guest (keepInstallers): '"));
    assert.ok(prov.buildWindowsHostScript({ ...baseOpts, packages: pk, jobId: 'keep-2' }).includes('$keepInstallers = $false'));
});

test('cleanup: the job id is validated before it is used in a path', () => {
    for (const bad of ["a'b", '..\\x', 'a b', '', 'x'.repeat(65), 'a/b']) {
        assert.throws(() => prov.buildWindowsHostScript({ ...baseOpts, packages: pk, jobId: bad }), /Invalid job id/, bad);
    }
    const auto = prov.buildWindowsHostScript({ ...baseOpts, packages: pk });
    assert.match(auto, /\$jobDir = 'X:\\SOMP_Provision\\[0-9a-f-]{36}'/);
});

test('cleanup: a failed cleanup is a warning in the host log, never a failure', async () => {
    psImpl = async () => okOutput(['Cleanup: partial', 'WARN|Cleanup|could not remove X:\\SOMP_Provision\\abc: Access is denied']);
    const j = await runJob(op, { ips: ['10.30.0.1'] });
    assert.equal(j.job.status, 'done');
    assert.equal(j.hosts[0].status, 'ok');
    assert.match(j.hosts[0].log, /Warning: cleanup problem: could not remove X:\\SOMP_Provision\\abc: Access is denied/);
    assert.ok(!/WARN\|Cleanup/.test(j.hosts[0].log));
});

test('cleanup: the runner passes the job id, keepInstallers and forceReinstall to the script builder', async () => {
    const seen = [];
    const orig = prov.buildWindowsHostScript;
    prov.buildWindowsHostScript = (o) => { seen.push(o); return orig(o); };
    try {
        const j = await runJob(op, { ips: ['10.30.0.3'], keepInstallers: true });
        assert.equal(seen[0].jobId, j.jobId);
        assert.equal(seen[0].keepInstallers, true);
        assert.equal(seen[0].forceReinstall, false);
    } finally {
        prov.buildWindowsHostScript = orig;
    }
});

test('cleanup: the reboot only happens when something was installed', () => {
    const s = prov.buildWindowsHostScript({ ...baseOpts, packages: pk, jobId: 'r1', reboot: true });
    assert.ok(s.includes('if ($allOk -and $anyInstalled)'));
    assert.ok(s.includes('Reboot skipped because nothing was installed.'));
});

test('every new script variant parses with the PowerShell parser (win32 only, nothing is executed)', { skip: process.platform !== 'win32' }, (t) => {
    const { spawnSync } = require('child_process');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-p3-parse-'));
    try {
        const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
        if (probe.error || probe.status !== 0) { t.skip('powershell.exe is not usable here'); return; }
        const hdr = powershell.ENV_CREDENTIAL_HEADER;
        const evil = [{ name: "E'x", path: "e'.exe", args: '', detect: { type: 'reg', value: "x'; calc; '", minVersion: '1.2.3' } }];
        const files = [
            prov.buildWindowsHostScript({ ...baseOpts, packages: detPk, jobId: 'p-1' }),
            prov.buildWindowsHostScript({ ...baseOpts, packages: detPk, jobId: 'p-2', forceReinstall: true, keepInstallers: true, reboot: true }),
            prov.buildWindowsHostScript({ ...baseOpts, packages: evil, jobId: 'p-3' }),
            prov.buildWindowsHostScript({ ...baseOpts, packages: pk }),
            prov.buildWindowsPrecheckScript({ ip: '10.30.0.1', credentialHeader: hdr }),
            prov.buildWindowsPrecheckScript({ ip: '10.30.0.1', credentialHeader: hdr, detects: [{ idx: 0, type: 'reg', value: "7-Zip*'x", minVersion: '19.0' }, { idx: 1, type: 'file', value: 'C:\\a\\b.exe', minVersion: '' }] })
        ];
        files.forEach((src, i) => {
            const f = path.join(dir, `v${i}.ps1`);
            fs.writeFileSync(f, '\ufeff' + src, 'utf8');
            const cmd = '$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:SOMP_PARSE_FILE,[ref]$t,[ref]$e);if($e -and $e.Count){$e|ForEach-Object{$_.Message + " @" + $_.Extent.StartLineNumber};exit 1};exit 0';
            const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', env: { ...process.env, SOMP_PARSE_FILE: f } });
            assert.equal(r.status, 0, `variant ${i} has parse errors: ${r.stdout}`);
        });
        assert.equal(files.length, 6);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('runners module still exports the host runners (job runner contract)', () => {
    assert.equal(typeof runners.runHost, 'function');
    assert.equal(typeof runners.runLinuxHost, 'function');
});

test('I2: a detect timeout or error is never a host failure (Windows: own 30 s job budget; Linux: warning, install proceeds)', async () => {
    const s = prov.buildWindowsHostScript({ ...baseOpts, packages: detPk, jobId: 'j9' });
    assert.ok(s.includes('-AsJob') && s.includes('Wait-Job -Job $dj -Timeout 30') && s.includes('Detect check timed out after 30 s, installing anyway'));
    await withEnv({ REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'pkgA|yum install -y a|@detect:cmd:sleep 999', REMOTE_INSTALL_LINUX_SOFTWARE_Basic: 'pkgA' }, async () => {
        sshImpl = async (ip, user, pwd, cmd, opts) => {
            if (cmd.includes('sleep 999')) { assert.equal(opts.execTimeoutMs, 30000); throw new Error('exec timeout'); }
            return { success: true, code: 0, stdout: 'done', stderr: '' };
        };
        const j = await runJob(op, { ips: ['10.30.0.1'], osType: 'linux' });
        assert.equal(j.job.status, 'done');
        assert.equal(j.hosts[0].packages[0].ok, true);
        assert.equal(j.hosts[0].packages[0].skipped, undefined);
        assert.match(j.hosts[0].log, /Detect check failed, installing anyway: exec timeout/);
    });
});

test('I3: pre-check never runs cmd rules; rpm / dpkg queries run without sudo', async () => {
    await withEnv({ REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'pkgA|yum install -y a|@detect:cmd:touch /tmp/x\npkgB|yum install -y b|@detect:rpm:pkgB', REMOTE_INSTALL_LINUX_SOFTWARE_Basic: 'pkgA,pkgB' }, async () => {
        sshImpl = async (ip, user, pwd, cmd) => (cmd.startsWith('rpm -q') ? { success: true, code: 1, stdout: '', stderr: '' } : { success: true, code: 0, stdout: 'ok', stderr: '' });
        const r = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.30.0.1'], osType: 'linux' });
        assert.equal(r.status, 200);
        const cmds = sshCalls.map(c => c[3]);
        assert.ok(!cmds.some(c => c.includes('touch /tmp/x')), 'cmd rule not executed');
        assert.ok(cmds.every(c => !c.includes('sudo')), 'no sudo in pre-check');
        assert.match(r.body.hosts[0].checks.find(c => c.id === 'installed').message, /cmd rule not evaluated in pre-check: pkgA/);
    });
    await withEnv({ REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'pkgA|yum install -y a|@detect:cmd:true', REMOTE_INSTALL_LINUX_SOFTWARE_Basic: 'pkgA' }, async () => {
        const r = await request(app).post('/api/install/precheck').set(bearer(op)).send({ ips: ['10.30.0.1'], osType: 'linux' });
        assert.equal(r.body.hosts[0].checks.find(c => c.id === 'installed').message, 'cmd rule not evaluated in pre-check: pkgA');
    });
});

test('M1/M2/M4: version padding, literal [ ] in DisplayName patterns, several instances joined with ", "', () => {
    const g = prov.GUEST_DETECT_BLOCK;
    assert.ok(g.includes("while (($a -split '\\.').Count -lt 4)"));
    assert.ok(g.includes(".Replace('[', $bt + '[').Replace(']', $bt + ']')") && g.includes('-like $pat'));
    assert.deepEqual(prov.parseLinuxDetect({ type: 'rpm' }, { code: 0, stdout: '1.0-1\n1.1-2\n' }), { found: true, version: '1.0-1, 1.1-2' });
    assert.deepEqual(prov.parseLinuxDetect({ type: 'dpkg' }, { code: 0, stdout: 'install ok installed|1.0\ninstall ok installed|2.0\n' }), { found: true, version: '1.0, 2.0' });
});

test('M5: the stale job folder sweep only touches job-id-named children older than 7 days, not the current job', () => {
    const s = prov.buildWindowsHostScript({ ...baseOpts, packages: pk, jobId: 'cur-1' });
    assert.ok(s.includes("-ArgumentList $jobRoot, 'cur-1', 7"));
    assert.ok(s.includes("-notmatch '^[A-Za-z0-9_-]{1,64}$'") && s.includes('-ieq $Current') && s.includes('.LastWriteTime -ge $limit'));
    assert.ok(s.includes('Remove-Item -LiteralPath $dir.FullName -Recurse -Force'));
    assert.ok(s.indexOf('$guestSweep') > 0 && s.indexOf('-ScriptBlock $guestSweep') < s.indexOf('=== package'));
});
