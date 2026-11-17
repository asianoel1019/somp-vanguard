require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { setPaid, setFree } = require('../helpers/license');

// Scheduler engine stub: the router requires it lazily and it would otherwise start timers.
require.cache[require.resolve('../../services/taskSchedulerService')] = {
    id: 'taskSchedulerService-stub', loaded: true,
    exports: { reloadScheduler() {}, triggerTaskExecution: async () => {} },
};

// One representative request per paid router (see the router gates in each file)
const CASES = [
    ['aiAgent', '/api/agent', 'get', '/conversations', require('../../routes/agent')],
    ['aiAgent', '/api/ai', 'post', '/chat', require('../../routes/ai')],
    ['workflow', '/api/workflow', 'get', '/', require('../../routes/workflow')],
    ['scheduler', '/api/scheduler', 'get', '/tasks', require('../../routes/scheduler')],
    ['remoteCmd', '/api/ops', 'post', '/command', require('../../routes/ops')],
    ['remoteCmd', '/api/cmd-library', 'post', '/', require('../../routes/cmdLibrary')],
    ['install', '/api/install', 'get', '/history', require('../../routes/install')],
    ['networkDevice', '/api/network-device', 'get', '/devices', require('../../routes/networkDevice')],
    ['ipam', '/api/ipam', 'get', '/subnets', require('../../routes/ipam')],
    ['netSearch', '/api/netsearch', 'get', '/status', require('../../routes/netsearch')],
    ['dataCenter', '/api/rack', 'get', '/contracts', require('../../routes/rack')],
    ['dataCenter', '/api/rack', 'get', '/datacenters', require('../../routes/rack')],
];
const ADMIN = `Bearer ${signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' })}`;
let app;

test.before(async () => {
    await dbManager.initDB();
    app = express();
    app.use(express.json());
    const mounted = new Set();
    for (const [, base, , , router] of CASES) {
        if (mounted.has(base)) continue;
        mounted.add(base);
        app.use(base, router);
    }
});
test.after(async () => { setPaid(); await dbManager.closeDB(); });

for (const [key, base, method, path] of CASES) {
    test(`${key}: ${method.toUpperCase()} ${base}${path} is license gated`, async () => {
        setFree();
        const free = await request(app)[method](`${base}${path}`).set('Authorization', ADMIN).send({});
        assert.equal(free.status, 403, JSON.stringify(free.body));
        assert.equal(free.body.code, 'LICENSE_REQUIRED');
        setPaid();
        const paid = await request(app)[method](`${base}${path}`).set('Authorization', ADMIN).send({});
        assert.notEqual(paid.body && paid.body.code, 'LICENSE_REQUIRED');
    });
}
