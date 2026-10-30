import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isValidIpv4, parseManualIps, mergeTargets, unknownManualIps, buildExecuteBody, buildPrecheckBody,
    precheckColumns, installWarning, jobStatusTone, retryableHosts, canRetry, jobProgress, formatDuration,
    nextPollState, packageLine, jobSummaryLine, toneClass, formatTime, packageClass, installedNote, checkLabel,
    runnerLabel, resumedBadge, jobAccountsLine
} from './provisionUtils.js';

test('jobAccountsLine: triggering user and the service account the hosts are provisioned with', () => {
    assert.equal(jobAccountsLine({ createdBy: 'alice', runAs: 'CORP\\svc-prov' }), 'Triggered by: alice / Run as: CORP\\svc-prov');
    assert.equal(jobAccountsLine({ createdBy: 'alice', runAs: null }), 'Triggered by: alice');
    assert.equal(jobAccountsLine({}), '');
    assert.equal(jobAccountsLine(null), '');
});

test('runnerLabel names the process that runs the job; nothing for old jobs without a runner', () => {
    assert.equal(runnerLabel({ runner: 'worker' }), 'Background worker');
    assert.equal(runnerLabel({ runner: 'web' }), 'Web server (fallback)');
    assert.equal(runnerLabel({ runner: null }), '');
    assert.equal(runnerLabel({}), '');
    assert.equal(runnerLabel(null), '');
    assert.equal(runnerLabel({ runner: 'other' }), '');
});

test('resumedBadge only for jobs resumed after a restart', () => {
    assert.equal(resumedBadge({ resumed: true, resumeCount: 1 }), 'Resumed after restart');
    assert.equal(resumedBadge({ resumeCount: 1 }), 'Resumed after restart');
    assert.equal(resumedBadge({ resumed: false, resumeCount: 0 }), '');
    assert.equal(resumedBadge(undefined), '');
});

test('isValidIpv4 accepts dotted quads only', () => {
    assert.ok(isValidIpv4('10.99.1.2'));
    assert.ok(isValidIpv4(' 192.168.0.255 '));
    for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', 'a.b.c.d', '', null, '1.2.3.4;ls']) assert.ok(!isValidIpv4(bad), String(bad));
});

test('parseManualIps splits, dedupes and separates invalid tokens', () => {
    const r = parseManualIps('10.0.0.1\n10.0.0.2, 10.0.0.1 ; bad 300.1.1.1');
    assert.deepEqual(r.valid, ['10.0.0.1', '10.0.0.2']);
    assert.deepEqual(r.invalid, ['bad', '300.1.1.1']);
});

test('mergeTargets keeps chips first and dedupes manual entries', () => {
    assert.deepEqual(mergeTargets([{ ip: '10.0.0.2' }, { ip: '10.0.0.3' }], '10.0.0.3\n10.0.0.9\nnope'), ['10.0.0.2', '10.0.0.3', '10.0.0.9']);
});

test('unknownManualIps flags manual IPs missing from the known set', () => {
    assert.deepEqual(unknownManualIps('10.0.0.1\n10.0.0.2', new Set(['10.0.0.1'])), ['10.0.0.2']);
});

test('request bodies: allowUnknownTargets only for SuperAdmin; keepInstallers off for linux; no Disk Setup field', () => {
    const b = buildExecuteBody({ ips: ['1.1.1.1'], buType: 'Basic', reboot: true, setDisk: true, keepInstallers: true, osType: 'linux', allowUnknownTargets: true, isSuperAdmin: false });
    assert.equal(b.allowUnknownTargets, undefined);
    assert.equal('setDisk' in b, false);
    assert.equal(b.keepInstallers, false);
    assert.equal(buildExecuteBody({ ips: [], osType: 'windows', allowUnknownTargets: true, isSuperAdmin: true }).allowUnknownTargets, true);
    const p = buildPrecheckBody({ ips: ['1.1.1.1'], buType: 'Basic', osType: 'windows', setDisk: true, software: ['a'] });
    assert.deepEqual(p.software, ['a']);
    assert.equal('setDisk' in p, false);
    assert.equal(buildPrecheckBody({ ips: [], osType: 'windows', software: [] }).software, undefined);
});

test('request bodies carry forceReinstall / keepInstallers as booleans (default false)', () => {
    const d = buildExecuteBody({ ips: ['1.1.1.1'], buType: 'Basic', osType: 'windows' });
    assert.equal(d.forceReinstall, false);
    assert.equal(d.keepInstallers, false);
    assert.equal(d.reboot, false);
    const f = buildExecuteBody({ ips: ['1.1.1.1'], buType: 'Basic', osType: 'windows', forceReinstall: true, keepInstallers: true });
    assert.equal(f.forceReinstall, true);
    assert.equal(f.keepInstallers, true);
    assert.equal(buildExecuteBody({ ips: ['1.1.1.1'], osType: 'linux', forceReinstall: true }).forceReinstall, true);
    assert.equal(buildPrecheckBody({ ips: [], osType: 'windows' }).forceReinstall, false);
    assert.equal(buildPrecheckBody({ ips: [], osType: 'linux', forceReinstall: true }).forceReinstall, true);
});

test('skipped packages: SKIP label, neutral colour; the installed pre-check row is a note', () => {
    const p = { name: 'Chrome', ok: true, skipped: true, exitCode: null, message: 'Already installed (120.0)' };
    assert.equal(packageLine(p), 'SKIP - Chrome: Already installed (120.0)');
    assert.equal(packageClass(p), 'text-secondary');
    assert.equal(packageClass({ ok: true }), 'text-success');
    assert.equal(packageClass({ ok: false }), 'text-danger');
    assert.equal(packageLine({ name: 'x', ok: true, exitCode: 0, message: 'Installed' }), 'OK - x (exit 0): Installed');
    assert.equal(installedNote({ checks: [{ id: 'installed', ok: true, message: 'Already installed, will be skipped: A' }] }), 'Already installed, will be skipped: A');
    assert.equal(installedNote({ checks: [] }), '');
    assert.equal(installedNote(null), '');
    assert.equal(checkLabel('installed'), 'Installed');
    assert.deepEqual(precheckColumns([{ checks: [{ id: 'nas' }, { id: 'installed' }, { id: 'disk' }] }]), ['disk', 'installed', 'nas']);
});

test('precheckColumns orders known ids and appends unknown ones', () => {
    const cols = precheckColumns([{ checks: [{ id: 'auth' }, { id: 'zzz' }, { id: 'known-target' }] }, { checks: [{ id: 'reachable' }] }]);
    assert.deepEqual(cols, ['known-target', 'reachable', 'auth', 'zzz']);
});

test('installWarning covers not run, failed, and hosts added later', () => {
    assert.match(installWarning(null, ['1.1.1.1']), /not been run/);
    const pre = { hosts: [{ ip: '1.1.1.1', ok: true, checks: [{ id: 'auth', ok: true }] }, { ip: '1.1.1.2', ok: false, checks: [{ id: 'auth', ok: false }] }] };
    assert.match(installWarning(pre, ['1.1.1.1', '1.1.1.2'], ['1.1.1.1', '1.1.1.2']), /failed for 1 host.*1\.1\.1\.2/);
    assert.match(installWarning(pre, ['1.1.1.1', '1.1.1.5'], ['1.1.1.1']), /added after/);
    assert.equal(installWarning({ hosts: [pre.hosts[0]] }, ['1.1.1.1'], ['1.1.1.1']), '');
});

test('job helpers', () => {
    assert.equal(jobStatusTone('ok'), 'success');
    assert.equal(jobStatusTone('interrupted'), 'danger');
    assert.equal(jobStatusTone('partial'), 'warning');
    assert.equal(jobStatusTone('running'), 'info');
    const hosts = [{ status: 'ok' }, { status: 'failed' }, { status: 'interrupted' }, { status: 'skipped' }, { status: 'running' }];
    assert.equal(retryableHosts(hosts).length, 3);
    assert.ok(canRetry({ running: false }, hosts));
    assert.ok(!canRetry({ running: true }, hosts));
    assert.ok(!canRetry({ running: false }, [{ status: 'ok' }]));
    assert.deepEqual(jobProgress(hosts), { finished: 4, total: 5 });
    assert.equal(formatDuration(1000, 4000), '3s');
    assert.equal(formatDuration(0, 1), '-');
    assert.equal(formatDuration(1000, 1000 + 125000), '2m 5s');
    assert.equal(packageLine({ name: 'x', ok: false, exitCode: 1603, message: 'bad' }), 'FAIL - x (exit 1603): bad');
    assert.equal(jobSummaryLine({ hostCount: 3, okCount: 2, failCount: 1, rebootCount: 2 }), '3 host(s), 2 ok, 1 failed, 2 need reboot');
});

test('nextPollState tolerates transient errors, then reports lost; finishes when not running', () => {
    let s = { errors: 0 };
    for (let i = 0; i < 4; i++) { s = nextPollState(s.errors, { error: true }); assert.equal(s.action, 'continue'); }
    assert.equal(nextPollState(s.errors, { error: true }).action, 'lost');
    s = nextPollState(3, { data: { job: { running: true } } });
    assert.deepEqual(s, { action: 'continue', errors: 0 });
    assert.equal(nextPollState(2, { data: { job: { running: false } } }).action, 'finish');
});

test('installWarning also warns on NAS-only failure and top-level ok:false', () => {
    const okHost = { ip: '1.1.1.1', ok: true, checks: [{ id: 'auth', ok: true }] };
    assert.match(installWarning({ ok: false, nas: { ok: false, message: 'no share' }, hosts: [okHost] }, ['1.1.1.1'], ['1.1.1.1']), /NAS path check failed: no share/);
    assert.match(installWarning({ ok: false, hosts: [okHost] }, ['1.1.1.1'], ['1.1.1.1']), /reported problems/);
});

test('nextPollState: errors reset after success, lost exactly at the 5th consecutive error', () => {
    assert.equal(nextPollState(4, { error: true }).action, 'lost');
    assert.equal(nextPollState(3, { error: true }).action, 'continue');
    assert.equal(nextPollState(4, { data: { job: { running: true } } }).errors, 0);
    assert.equal(nextPollState(0, { error: true }, 1).action, 'lost');
});

test('misc helpers: tones, time, manual parse edge cases', () => {
    assert.equal(jobStatusTone('whatever'), 'muted');
    assert.match(toneClass('danger'), /text-danger/);
    assert.match(toneClass('nope'), /text-secondary/);
    assert.equal(formatTime(0), '-');
    assert.equal(formatTime('not a date'), '-');
    assert.notEqual(formatTime(1700000000000), '-');
    assert.deepEqual(parseManualIps('01.2.3.4').invalid, ['01.2.3.4']);
    const many = Array.from({ length: 60 }, (_, i) => `10.0.0.${i + 1}`).join(' ');
    assert.equal(parseManualIps(many).valid.length, 60);
});
