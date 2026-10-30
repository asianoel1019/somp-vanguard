require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../../services/remoteCommandService');
const { detectOs, isSafeTarget } = require('../../lib/osDetect');

const encodeResult = (obj) => '@@SOMP_RESULT@@' + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

test('targets: only IPv4 / host names; injection attempts are rejected before anything runs', () => {
    for (const t of ['10.0.0.1', 'srv01', 'srv01.corp.local', 'a-b.c']) assert.ok(svc.isValidTarget(t), t);
    for (const t of ['x"; Remove-Item C:\\ -Recurse; "', '10.0.0.1; whoami', '$(calc)', '10.0.0.256', '1.2.3', 'a b', '-a', '', null, 5]) {
        assert.equal(svc.isValidTarget(t), false, String(t));
    }
    assert.ok(isSafeTarget('10.0.0.1'));
    assert.equal(isSafeTarget('x"; calc; "'), false);
});

test('detectOs never builds a PowerShell command from an invalid target', async () => {
    assert.deepEqual(await detectOs('x"; calc; "'), { status: 'offline', os: 'unknown', error: 'invalid target' });
});

test('validateCommandRequest: shape, de-dup, limits, invalid targets', () => {
    assert.match(svc.validateCommandRequest({}).error, /ips/);
    assert.match(svc.validateCommandRequest({ ips: 'x', winCommand: 'a' }).error, /ips/);
    assert.match(svc.validateCommandRequest({ ips: ['10.0.0.1'] }).error, /command/);
    assert.match(svc.validateCommandRequest({ ips: ['10.0.0.1'], winCommand: 5 }).error, /winCommand/);
    assert.match(svc.validateCommandRequest({ ips: [], winCommand: 'a' }).error, /at least one/);
    assert.match(svc.validateCommandRequest({ ips: ['10.0.0.1', 'bad"x'], winCommand: 'a' }).error, /Invalid IP .*bad"x/);
    assert.match(svc.validateCommandRequest({ ips: ['10.0.0.1'], winCommand: 'x'.repeat(svc.MAX_COMMAND_LENGTH + 1) }).error, /at most/);
    const many = Array.from({ length: svc.MAX_TARGETS + 1 }, (_, i) => `10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`);
    assert.match(svc.validateCommandRequest({ ips: many, winCommand: 'a' }).error, /At most/);
    const ok = svc.validateCommandRequest({ ips: [' 10.0.0.1 ', '10.0.0.1', 'SRV1', 'srv1', ''], nixCommand: 'uptime', linuxPassword: 'p' });
    assert.deepEqual(ok.targets, ['10.0.0.1', 'SRV1']);
    assert.equal(ok.winCommand, '');
    assert.equal(ok.linuxPassword, 'p');
});

test('resolveWindowsCredentials: user cred only for an AD user who typed a password; service account qualified', () => {
    const deps = { readDefaultCredentials: () => ({ winUser: 'svc.ops', winPassword: 'S', allowedAdDomain: 'CORP' }) };
    let c = svc.resolveWindowsCredentials({ username: 'alice', domain: 'CORP' }, 'pw', deps);
    assert.deepEqual(c.userCred, { name: 'CORP\\alice', password: 'pw' });
    assert.deepEqual(c.serviceCred, { name: 'CORP\\svc.ops', password: 'S' });
    c = svc.resolveWindowsCredentials({ username: 'alice', domain: 'CORP' }, '', deps);
    assert.equal(c.userCred, null);
    c = svc.resolveWindowsCredentials({ username: 'admin', domain: 'local' }, 'pw', deps);
    assert.equal(c.userCred, null, 'local break-glass account never used as a Windows credential');
    c = svc.resolveWindowsCredentials({ username: 'alice', domain: 'CORP' }, 'pw', { readDefaultCredentials: () => ({ winUser: 'X\\svc', winPassword: 'S' }) });
    assert.equal(c.serviceCred.name, 'X\\svc');
    c = svc.resolveWindowsCredentials({ username: 'alice', domain: 'CORP' }, 'pw', { readDefaultCredentials: () => ({}) });
    assert.equal(c.serviceCred, null);
});

test('runWindowsCommand: target, script and secrets go through stdin only (never into the script text)', async () => {
    let seen;
    const runPowerShell = async (script, timeout, opts) => { seen = { script, timeout, opts }; return encodeResult({ runAs: 'user', output: 'hello 中文\n' }); };
    const creds = { userCred: { name: 'CORP\\alice', password: 'Pw"1' }, serviceCred: { name: 'CORP\\svc', password: 'S$2' } };
    const r = await svc.runWindowsCommand('10.0.0.5', 'Get-Date', creds, { runPowerShell });
    assert.equal(seen.script, svc.WINDOWS_SCRIPT);
    for (const secret of ['Pw"1', 'S$2', '10.0.0.5', 'Get-Date']) assert.ok(!seen.script.includes(secret));
    const payload = JSON.parse(Buffer.from(seen.opts.stdin, 'base64').toString('utf8'));
    assert.deepEqual(payload, { target: '10.0.0.5', script: 'Get-Date', user: creds.userCred, service: creds.serviceCred });
    assert.equal(r.status, 'Online');
    assert.equal(r.runAs, 'user');
    assert.equal(r.runAsName, 'CORP\\alice');
    assert.equal(r.output, 'hello 中文');
});

test('runWindowsCommand: falls back to the service account only when the user session cannot open', async () => {
    const creds = { userCred: { name: 'CORP\\alice', password: 'p' }, serviceCred: { name: 'CORP\\svc', password: 's' } };
    const fallback = await svc.runWindowsCommand('h1', 'x', creds, { runPowerShell: async () => encodeResult({ runAs: 'service', userError: 'Access is denied.', output: 'ok' }) });
    assert.equal(fallback.status, 'Online');
    assert.equal(fallback.runAs, 'service');
    assert.match(fallback.output, /已改用服務帳號執行：個人帳號 CORP\\alice 連線失敗 — Access is denied\./);
    assert.match(fallback.output, /ok$/);

    // A failing command is reported as-is (it already ran once): no fallback note, no retry
    const cmdErr = await svc.runWindowsCommand('h1', 'x', creds, { runPowerShell: async () => encodeResult({ runAs: 'user', error: 'Cannot find path' }) });
    assert.equal(cmdErr.status, 'Failed');
    assert.equal(cmdErr.runAs, 'user');
    assert.match(cmdErr.output, /Command error: Cannot find path/);

    const none = await svc.runWindowsCommand('h1', 'x', creds, { runPowerShell: async () => encodeResult({ runAs: '', userError: 'denied', serviceError: 'WinRM cannot' }) });
    assert.equal(none.status, 'Failed');
    assert.match(none.output, /個人帳號 CORP\\alice: denied\n服務帳號 CORP\\svc: WinRM cannot/);

    const noCreds = await svc.runWindowsCommand('h1', 'x', { userCred: null, serviceCred: null }, { runPowerShell: async () => { throw new Error('must not run'); } });
    assert.equal(noCreds.status, 'Failed');

    const crashed = await svc.runWindowsCommand('h1', 'x', creds, { runPowerShell: async () => { throw { stderr: 'boom' }; } });
    assert.equal(crashed.status, 'Failed');
    assert.match(crashed.output, /boom/);
    const garbage = await svc.runWindowsCommand('h1', 'x', creds, { runPowerShell: async () => 'no marker' });
    assert.match(garbage.output, /unexpected/);
});

test('runLinuxCommand: exec timeout and output cap are always set; output truncated', async () => {
    let opts;
    const big = 'y'.repeat(svc.MAX_OUTPUT_CHARS + 1000);
    const r = await svc.runLinuxCommand('10.0.0.6', 'tail -f /x', 'pw', { executeSSH: async (h, u, p, c, o) => { opts = o; return { stdout: big, stderr: '' }; } });
    assert.ok(opts.execTimeoutMs > 0);
    assert.ok(opts.maxOutputBytes > 0);
    assert.match(r.output, /output truncated/);
    assert.ok(r.output.length < big.length);
    assert.equal((await svc.runLinuxCommand('h', 'x', '', {})).output, 'Missing Linux password');
    const err = await svc.runLinuxCommand('h', 'x', 'pw', { executeSSH: async () => { throw new Error('SSH command timed out after 120 s'); } });
    assert.equal(err.status, 'Failed');
    assert.match(err.output, /timed out/);
});
