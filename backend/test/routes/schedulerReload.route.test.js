require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

// The cron engines run only in the background worker. Saving a task / the Prometheus health settings from the web
// process must ask the worker to reload and never start a second engine here (tasks would run twice).
const OP = `Bearer ${signToken({ username: 'op', domain: 'corp', role: 'Operator', groups: ['g'] })}`;

let app;
let sent = [];
let localStarts = 0;
test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { scheduler: true } } },
    });
    const tasks = require('../../services/taskSchedulerService');
    tasks.reloadScheduler = () => { localStarts++; };
    global.sendWorkerMessage = (msg) => { sent.push(msg); return true; };
    app = express();
    app.use(express.json());
    app.use('/api/scheduler', require('../../routes/scheduler'));
});
test.after(async () => {
    delete global.sendWorkerMessage;
    await dbManager.closeDB();
});

test('adding a scheduled task asks the worker to reload and starts no engine in the web process', async () => {
    sent = [];
    localStarts = 0;
    const r = await request(app).post('/api/scheduler/tasks/add').set('Authorization', OP)
        .send({ name: 'nightly', cronExpression: '0 2 * * *', targetType: 'local_ps', targets: [], winCommand: 'Get-Date' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(sent.filter(m => m.type === 'RELOAD_TASK_SCHEDULER').length, 1);
    assert.equal(localStarts, 0);
});

test('saving the Prometheus health settings in the web process only notifies the worker', () => {
    sent = [];
    const prom = require('../../services/prometheusScheduler');
    prom.updateHealthCheckConfig({ enabled: false, intervalMinutes: 30 });
    // (the config write itself also sends INVALIDATE_DOC_CACHE: only the reload requests matter here)
    assert.deepEqual(sent.map(m => m.type).filter(t => t.startsWith('RELOAD_')), ['RELOAD_PROMETHEUS_SCHEDULER']);
});
