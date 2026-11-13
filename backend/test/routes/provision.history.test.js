// Server Provision History: job list filters (status, OS, search over id / creator / template / host IP and name),
// paging with filters, validation, and the History figures. Rows are written directly; no job runs.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const jobs = require('../../services/provisionJobs');

const mk = (role, groups = ['prov']) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups })}`;
const viewer = mk('Viewer');
const noFeature = mk('Operator', ['other']);
const DAY = 24 * 60 * 60 * 1000;
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { prov: { enabled: true, features: { install: true } }, other: { enabled: true, features: { serverList: true } } },
    });
    app = express();
    app.use(express.json());
    app.use('/api/install', require('../../routes/install'));
});
test.after(async () => { await jobs.whenIdle(); await dbManager.closeDB(); });
test.beforeEach(() => {
    const h = jobs.getHandle();
    h.exec('DELETE FROM provision_job_hosts; DELETE FROM provision_jobs;');
});

function addJob({ id, status, os = 'windows', bu = 'Basic', by = 'op1', ageDays = 1, hosts = [], ok = 0, fail = 0, reboot = 0 }) {
    const h = jobs.getHandle();
    const createdAt = new Date(Date.now() - ageDays * DAY).toISOString();
    h.prepare('INSERT INTO provision_jobs (id, createdBy, createdAt, status, buType, request, hostCount, okCount, failCount, rebootCount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, by, createdAt, status, bu, JSON.stringify({ osType: os, buType: bu, ips: hosts.map(x => x.ip) }), hosts.length, ok, fail, reboot);
    for (const x of hosts) {
        h.prepare('INSERT INTO provision_job_hosts (jobId, ip, hostname, os, status, packages, rebootRequired, log) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
            .run(id, x.ip, x.hostname || '', '', 'ok', '[]', '');
    }
}

function seed() {
    addJob({ id: 'aaaa1111-0000', status: 'done', hosts: [{ ip: '192.0.2.10', hostname: 'WEB01' }, { ip: '192.0.2.11' }], ok: 2, ageDays: 5 });
    addJob({ id: 'bbbb2222-0000', status: 'partial', os: 'linux', bu: 'HR_100%', by: 'op2', hosts: [{ ip: '198.51.100.7', hostname: 'db-07' }, { ip: '198.51.100.8' }], ok: 1, fail: 1, reboot: 1, ageDays: 3 });
    addJob({ id: 'cccc3333-0000', status: 'failed', hosts: [{ ip: '203.0.113.5' }], fail: 1, ageDays: 2 });
    addJob({ id: 'dddd4444-0000', status: 'running', os: 'linux', hosts: [{ ip: '192.0.2.99', hostname: 'APP99' }], ageDays: 0 });
    addJob({ id: 'eeee5555-0000', status: 'done', hosts: [{ ip: '192.0.2.50' }], ok: 1, ageDays: 40 }); // outside 30 days
}

const list = async (query) => (await request(app).get('/api/install/jobs').query(query).set('Authorization', viewer).expect(200)).body.jobs.map(j => j.id.slice(0, 4));

test('filters: status list, OS, and search over id prefix, creator, template, host IP and host name', async () => {
    seed();
    assert.deepEqual(await list({}), ['eeee', 'dddd', 'cccc', 'bbbb', 'aaaa'], 'newest first');
    assert.deepEqual(await list({ status: 'queued,running' }), ['dddd']);
    assert.deepEqual(await list({ status: 'failed,interrupted' }), ['cccc']);
    assert.deepEqual(await list({ status: 'done' }), ['eeee', 'aaaa']);
    assert.deepEqual(await list({ os: 'linux' }), ['dddd', 'bbbb']);
    assert.deepEqual(await list({ os: 'windows', status: 'done,failed' }), ['eeee', 'cccc', 'aaaa']);
    assert.deepEqual(await list({ q: 'bbbb' }), ['bbbb'], 'id prefix');
    assert.deepEqual(await list({ q: '0000' }), [], 'the id matches from its start only');
    assert.deepEqual(await list({ q: 'OP2' }), ['bbbb'], 'creator, any case');
    assert.deepEqual(await list({ q: 'HR_100%' }), ['bbbb'], 'template; % and _ are literal');
    assert.deepEqual(await list({ q: '_' }), ['bbbb'], 'a lone _ matches only a real underscore');
    assert.deepEqual(await list({ q: '198.51.100.8' }), ['bbbb'], 'host IP');
    assert.deepEqual(await list({ q: 'web01' }), ['aaaa'], 'host name');
    assert.deepEqual(await list({ q: '192.0.2.' }), ['eeee', 'dddd', 'aaaa']);
});

test('paging keeps the filters; bad filters are 400; viewers may read, users without the feature may not', async () => {
    seed();
    const p1 = (await request(app).get('/api/install/jobs').query({ q: '192.0.2.', limit: 2 }).set('Authorization', viewer).expect(200)).body;
    assert.deepEqual(p1.jobs.map(j => j.id.slice(0, 4)), ['eeee', 'dddd']);
    const p2 = (await request(app).get('/api/install/jobs').query({ q: '192.0.2.', limit: 2, before: p1.nextBefore }).set('Authorization', viewer).expect(200)).body;
    assert.deepEqual(p2.jobs.map(j => j.id.slice(0, 4)), ['aaaa']);
    assert.equal(p2.nextBefore, null);

    for (const query of [{ status: 'done,bogus' }, { os: 'mac' }, { q: 'x'.repeat(101) }]) {
        const r = await request(app).get('/api/install/jobs').query(query).set('Authorization', viewer).expect(400);
        assert.ok(r.body.error, JSON.stringify(query));
    }
    await request(app).get('/api/install/jobs/stats').set('Authorization', noFeature).expect(403);
    await request(app).get('/api/install/jobs/stats').expect(401);
});

test('stats: jobs and host counts of the last N days, plus the jobs running now', async () => {
    seed();
    const s = (await request(app).get('/api/install/jobs/stats').set('Authorization', viewer).expect(200)).body;
    assert.equal(s.days, 30);
    assert.equal(s.jobs, 4, 'the 40-day-old job is outside the window');
    assert.equal(s.running, 1);
    assert.equal(s.hosts, 6);
    assert.equal(s.okHosts, 3);
    assert.equal(s.failedHosts, 2);
    assert.equal(s.rebootHosts, 1);
    assert.equal(s.doneJobs, 1);
    assert.equal(s.failedJobs, 1);
    const s90 = (await request(app).get('/api/install/jobs/stats').query({ days: 90 }).set('Authorization', viewer).expect(200)).body;
    assert.equal(s90.jobs, 5);
    const clamped = (await request(app).get('/api/install/jobs/stats').query({ days: 9999 }).set('Authorization', viewer).expect(200)).body;
    assert.equal(clamped.days, 365);
});
