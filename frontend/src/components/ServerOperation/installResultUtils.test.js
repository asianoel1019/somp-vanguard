import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResults, hostStatus, packageSummary, overallSummary, jobToResults, isJobActive } from './installResultUtils.js';

test('normalizeResults reads structured fields and ignores log text', () => {
    const r = normalizeResults({ results: [
        { ip: '10.0.0.1', ok: false, packages: [{ name: 'a', ok: false, exitCode: 1603, message: 'x' }], log: 'RESULT:Success Success' },
        { ip: '10.0.0.2', ok: true, packages: [], rebootRequired: true, log: 'ERROR failed' }
    ] });
    assert.equal(r[0].ok, false);
    assert.equal(hostStatus(r[0]).tone, 'danger');
    assert.equal(hostStatus(r[1]).tone, 'warning');
    assert.match(hostStatus(r[1]).label, /reboot required/);
    assert.equal(hostStatus({ ok: true, packages: [] }).tone, 'success');
});

test('request errors become a single failed entry; bad payloads give an empty list', () => {
    const r = normalizeResults(undefined, 'Too many IPs');
    assert.equal(r.length, 1);
    assert.equal(r[0].ok, false);
    assert.equal(r[0].error, 'Too many IPs');
    assert.deepEqual(normalizeResults({}), []);
    assert.deepEqual(normalizeResults({ results: { '10.0.0.1': 'old string format' } }), []);
});

test('summaries', () => {
    assert.equal(packageSummary({ packages: [{ ok: true }, { ok: false }] }), '1/2 packages OK');
    assert.equal(packageSummary({ packages: [] }), '');
    assert.equal(overallSummary([{ ok: true }, { ok: false }]), '1 of 2 host(s) failed');
    assert.equal(overallSummary([{ ok: true }]), 'All 1 host(s) succeeded');
    assert.equal(overallSummary([]), '');
});

test('jobToResults maps job hosts to results; only ok hosts succeed; isJobActive follows job.running', () => {
    const data = { job: { running: false }, hosts: [
        { ip: '10.0.0.1', status: 'ok', packages: [{ name: 'a', ok: true }], rebootRequired: true, error: null, log: 'l' },
        { ip: '10.0.0.2', status: 'skipped', packages: [], error: 'already being provisioned by job x', log: '' },
        { ip: '10.0.0.3', status: 'cancelled', packages: [], error: null, log: '' }
    ] };
    const r = normalizeResults({ results: jobToResults(data) });
    assert.deepEqual(r.map(x => x.ok), [true, false, false]);
    assert.equal(r[0].rebootRequired, true);
    assert.match(r[1].error, /already being provisioned/);
    assert.equal(r[2].error, 'Host cancelled');
    assert.equal(isJobActive(data), false);
    assert.equal(isJobActive({ job: { running: true } }), true);
    assert.deepEqual(jobToResults(null), []);
});
