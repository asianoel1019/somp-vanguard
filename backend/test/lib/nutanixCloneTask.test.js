const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const ct = require('../../lib/nutanixCloneTask');

const WIN = { Name: 'WIN-A', IP: '10.20.30.11', OS: 'W2K22', BU: 'OPS' };
const LNX = { Name: 'lnx-b', IP: '10.20.30.12', OS: 'Rocky Linux 9', BU: 'OPS' };
const LNX_FAIL = { Name: 'lnx-c', IP: '10.20.30.13', OS: 'Ubuntu 22.04', BU: 'OPS' };
const marker = (vm) => `${ct.CREATED_MARKER} ${JSON.stringify({ uuid: 'u-' + vm.Name, ip: vm.IP, name: vm.Name })}\n`;

/** A clone task with fake process / SSH / Server List, state kept in memory, log in a temp dir. */
function harness(t, overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-clone-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const h = { stored: null, children: [], ssh: [], upserts: [], events: [], killed: [], alive: new Set() };
    h.task = ct.createCloneTask({
        logFile: path.join(dir, 'logs', 'nutanix_clone.log'),
        readState: () => h.stored && JSON.parse(JSON.stringify(h.stored)),
        writeState: (s) => { h.stored = JSON.parse(JSON.stringify(s)); },
        spawn: (cmd, args, opts) => {
            const child = new EventEmitter();
            child.pid = 4242 + h.children.length;
            child.stdinData = '';
            child.stdin = Object.assign(new EventEmitter(), { end: (d) => { child.stdinData += d; } });
            h.children.push({ cmd, args, opts, child });
            return child;
        },
        isAlive: (pid) => h.alive.has(pid),
        kill: (pid) => h.killed.push(pid),
        executeSSH: async (ip, user, pwd, command, opts) => {
            h.ssh.push({ ip, command, opts });
            if (command === 'echo OK') return { code: 0, stdout: 'OK', stderr: '' };
            return ip === LNX_FAIL.IP ? { code: 3, stdout: '', stderr: 'agent install failed' } : { code: 0, stdout: 'installed', stderr: '' };
        },
        upsertVms: (vms, user) => { h.upserts.push({ vms: vms.map(v => v.Name), user }); return { count: vms.length }; },
        broadcast: (event, payload) => h.events.push({ event, payload }),
        loadLinuxContext: () => ({ user: 'root', password: 'linux-pw', resolveSoftware: () => [{ name: 'agent', command: 'install-agent.sh' }] }),
        sshRetryDelayMs: 0,
        pollMs: 5,
        env: {},
        ...overrides
    });
    h.log = () => fs.readFileSync(h.task.logFile, 'utf8');
    h.psWrites = (text) => fs.appendFileSync(h.task.logFile, text);
    return h;
}

const PARAMS = { NPass: 'nutanix-secret', JoinPass: 'ad-secret', LocalAdminPass: 'local-secret', BatchList: [{ Name: 'WIN-A', BU: '測試' }] };

test('start: credentials go to stdin only, PowerShell output goes to the log file, state is persisted', (t) => {
    const h = harness(t);
    h.task.start({ scriptPath: 'C:\\app\\lib\\nutanix_clone_vm_api.ps1', params: PARAMS, vms: [WIN], user: 'op', mode: 'PC' });

    const { cmd, args, opts, child } = h.children[0];
    assert.equal(cmd, 'powershell.exe');
    assert.equal(args.at(-1), "& 'C:/app/lib/nutanix_clone_vm_api.ps1' -ParamFile '-'");
    assert.equal(opts.stdio[0], 'pipe');
    assert.equal(typeof opts.stdio[1], 'number', 'stdout is the log file descriptor');
    assert.ok(!opts.detached, 'a detached powershell.exe produces no output');
    assert.deepEqual(JSON.parse(child.stdinData), PARAMS);
    assert.ok(/^[\x00-\x7e]*$/.test(child.stdinData), 'stdin JSON is pure ASCII (PS 5.1 reads stdin in the OEM code page)');

    assert.deepEqual(fs.readdirSync(path.dirname(h.task.logFile)), ['nutanix_clone.log'], 'no parameter file on disk');
    assert.ok(!JSON.stringify(h.stored).includes('secret'), 'no credential in the persisted state');
    assert.equal(h.stored.running, true);
    assert.equal(h.stored.pid, 4242);
    assert.equal(h.stored.timeoutMinutes, 60);
    assert.equal(h.task.status().running, true);
    assert.throws(() => h.task.start({ scriptPath: 'x.ps1', params: {}, vms: [WIN], mode: 'PC' }), /currently running/);
});

test('finish: only VMs the script created get the Linux install and the Server List; failed installs are reported', async (t) => {
    const h = harness(t);
    const vms = [WIN, LNX, LNX_FAIL, { Name: 'never-made', IP: '10.20.30.14', OS: 'Rocky Linux' }];
    h.task.start({ scriptPath: 'x.ps1', params: {}, vms, user: 'op', mode: 'PC' });
    h.psWrites('Error: [never-made] Template target VM not found\n' + marker(WIN) + marker(LNX) + marker(LNX_FAIL));
    h.children[0].child.emit('close', 0);
    await h.task.finish(0); // same promise as the close handler's

    assert.deepEqual(h.upserts, [{ vms: ['WIN-A', 'lnx-b', 'lnx-c'], user: 'op' }]);
    assert.deepEqual([...new Set(h.ssh.map(s => s.ip))], [LNX.IP, LNX_FAIL.IP], 'no SSH to Windows or to the VM that was never created');
    const install = h.ssh.find(s => s.command === 'install-agent.sh');
    assert.equal(install.opts.execTimeoutMs, 20 * 60 * 1000, 'install commands have an execution time limit');

    const r = h.stored.result;
    assert.equal(h.stored.running, false);
    assert.deepEqual({ created: r.created, total: r.total, notCreated: r.notCreated, linuxInstallFailed: r.linuxInstallFailed, registered: r.registered, success: r.success },
        { created: 3, total: 4, notCreated: ['never-made'], linuxInstallFailed: ['lnx-c'], registered: 3, success: false });
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].event, 'NUTANIX_CLONE_COMPLETED');
    assert.equal(h.events[0].payload.success, false);

    const log = h.log();
    assert.match(log, /\[Summary\] 3 of 4 VM\(s\) created in Nutanix\./);
    assert.match(log, /NOT created: never-made \(10\.20\.30\.14\)/);
    assert.match(log, /Exit code: 3 \[FAILED\]/);
    assert.match(log, /lnx-c \(10\.20\.30\.13\): 1 of 1 installation\(s\) failed: agent \[FAILED\]/);
    assert.match(log, /lnx-b \(10\.20\.30\.12\): Software installations completed successfully! \[OK\]/);
});

test('finish: a non-zero exit code no longer drops the VMs that were created before the failure', async (t) => {
    const h = harness(t);
    h.task.start({ scriptPath: 'x.ps1', params: {}, vms: [WIN, LNX], user: 'op', mode: 'PE' });
    h.psWrites(marker(WIN));
    await h.task.finish(1);
    assert.deepEqual(h.upserts.map(u => u.vms), [['WIN-A']]);
    assert.equal(h.stored.result.exitCode, 1);
    assert.equal(h.stored.result.success, false);
});

test('deadline: past the time limit the process tree is killed and the result says timeout', async (t) => {
    const h = harness(t, { env: { NUTANIX_CLONE_TIMEOUT_MINUTES: '0.0002' } }); // 12 ms
    h.task.start({ scriptPath: 'x.ps1', params: {}, vms: [WIN], user: 'op', mode: 'PC' });
    for (let i = 0; i < 300 && h.killed.length === 0; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(h.killed, [4242]);
    assert.match(h.log(), /exceeded its time limit .* Killing PowerShell process tree \(PID 4242\)/);
    h.children[0].child.emit('close', 1);
    await h.task.finish(1);
    assert.equal(h.stored.result.reason, 'timeout');
    assert.equal(h.stored.running, false);
});

test('recover: a task whose PowerShell died with the old web process is finished from its log', async (t) => {
    const h = harness(t);
    h.task.start({ scriptPath: 'x.ps1', params: {}, vms: [WIN, LNX], user: 'op', mode: 'PC' });
    h.psWrites(marker(LNX));
    // a new web process: fresh task object, same stored state and log
    const restarted = harness(t);
    restarted.stored = h.stored;
    fs.mkdirSync(path.dirname(restarted.task.logFile), { recursive: true });
    fs.copyFileSync(h.task.logFile, restarted.task.logFile);

    assert.equal(restarted.task.recover(), 'finished');
    await restarted.task.finish(null);
    assert.equal(restarted.stored.running, false);
    assert.equal(restarted.stored.result.reason, 'interrupted by a web process restart');
    assert.deepEqual(restarted.upserts.map(u => u.vms), [['lnx-b']]);
    assert.match(restarted.log(), /PowerShell process ended \(interrupted by a web process restart\)/);
});

test('recover: a still-running PowerShell is watched until it exits', async (t) => {
    const h = harness(t);
    h.stored = { running: true, pid: 777, user: 'op', startTime: Date.now(), timeoutMinutes: 60, timeoutAt: Date.now() + 3600000, vms: [WIN] };
    fs.mkdirSync(path.dirname(h.task.logFile), { recursive: true });
    fs.writeFileSync(h.task.logFile, marker(WIN));
    h.alive.add(777);
    assert.equal(h.task.recover(), 'watching');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(h.stored.running, true, 'still running while the PID is alive');
    h.alive.delete(777);
    for (let i = 0; i < 500 && h.stored.running; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(h.stored.running, false);
    assert.deepEqual(h.upserts.map(u => u.vms), [['WIN-A']]);
    assert.match(h.log(), /still running\. Watching it/);
});

test('recover: nothing to do when no task is running', (t) => {
    const h = harness(t);
    assert.equal(h.task.recover(), 'idle');
    h.stored = { running: false, result: { success: true } };
    assert.equal(h.task.recover(), 'idle');
});

test('helpers: markers, matching, ASCII JSON, timeouts', () => {
    const log = `noise\n   [WIN-A] Clone succeeded\r\n${marker(WIN)}${ct.CREATED_MARKER} {broken\n${ct.CREATED_MARKER} {"ip":"","name":"LNX-B","uuid":"x"}\n`;
    const created = ct.parseCreatedMarkers(log);
    assert.deepEqual(created.map(c => c.name), ['WIN-A', 'LNX-B']);
    assert.deepEqual(ct.createdFlags([WIN, LNX, LNX_FAIL], created), [true, true, false], 'IP match, else case-insensitive name');

    const json = ct.asciiJson({ bu: '測試', pw: 'a"b\\c' });
    assert.ok(/^[\x00-\x7e]*$/.test(json));
    assert.deepEqual(JSON.parse(json), { bu: '測試', pw: 'a"b\\c' });

    assert.equal(ct.cloneTimeoutMinutes(1, {}), 60);
    assert.equal(ct.cloneTimeoutMinutes(5, {}), 150);
    assert.equal(ct.cloneTimeoutMinutes(5, { NUTANIX_CLONE_TIMEOUT_MINUTES: '45' }), 45);
    assert.equal(ct.cloneTimeoutMinutes(5, { NUTANIX_CLONE_TIMEOUT_MINUTES: 'abc' }), 150);
    assert.equal(ct.installTimeoutMs({ NUTANIX_LINUX_INSTALL_TIMEOUT_MINUTES: '5' }), 300000);
});

test('real powershell.exe: parameters arrive on stdin, output lands in the log, markers are picked up', { skip: process.platform !== 'win32' }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-clone-ps-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const script = path.join(dir, 'fake_clone.ps1');
    fs.writeFileSync(script, [
        'param([string]$ParamFile)',
        "$ParamJson = if ($ParamFile -eq '-') { [Console]::In.ReadToEnd() } else { Get-Content -Raw $ParamFile }",
        '$Params = $ParamJson | ConvertFrom-Json',
        'Write-Host "got password length $($Params.NPass.Length), BU $([int][char]$Params.BU[0])"',
        'foreach ($VM in $Params.BatchList) { Write-Host ("##SOMP_VM_CREATED## " + (@{ ip = "$($VM.IP)"; name = "$($VM.Name)"; uuid = "u" } | ConvertTo-Json -Compress)) }',
        'exit 1'
    ].join('\r\n'));
    let stored = null;
    const upserts = [];
    const task = ct.createCloneTask({
        logFile: path.join(dir, 'clone.log'),
        readState: () => stored, writeState: (s) => { stored = s; },
        spawn: require('child_process').spawn,
        executeSSH: async () => ({ code: 0, stdout: '', stderr: '' }),
        upsertVms: (vms) => { upserts.push(vms.map(v => v.Name)); return { count: vms.length }; },
        loadLinuxContext: () => ({ user: 'u', password: 'p', resolveSoftware: () => [] }),
        env: {}
    });
    const done = new Promise(resolve => { const iv = setInterval(() => { if (stored && !stored.running) { clearInterval(iv); resolve(); } }, 50); });
    task.start({ scriptPath: script, params: { NPass: `p'w"d$x`, BU: '測', BatchList: [WIN] }, vms: [WIN, LNX], user: 'op', mode: 'PC' });
    await done;
    const log = fs.readFileSync(task.logFile, 'utf8');
    assert.match(log, /got password length 7, BU 28204/);
    assert.match(log, /PowerShell process finished with exit code 1/);
    assert.deepEqual(upserts, [['WIN-A']]);
    assert.deepEqual(stored.result.notCreated, ['lnx-b']);
});

test('removeLegacyParamFiles: deletes only the old credential parameter files', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-clone-legacy-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const n of ['nutanix_clone_params_1730000000000.json', 'nutanix_clone_params_1.json', 'nutanix_clone_vm_api.ps1', 'nutanix_clone_params_x.json', 'other.json']) {
        fs.writeFileSync(path.join(dir, n), '{}');
    }
    assert.deepEqual(ct.removeLegacyParamFiles(dir).sort(), ['nutanix_clone_params_1.json', 'nutanix_clone_params_1730000000000.json']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['nutanix_clone_params_x.json', 'nutanix_clone_vm_api.ps1', 'other.json']);
    assert.deepEqual(ct.removeLegacyParamFiles(path.join(dir, 'missing')), []);
});
