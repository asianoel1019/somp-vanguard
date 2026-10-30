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
const { FEATURE_KEYS, SUPERADMIN_LOCKED_FEATURES, LEGACY_CONFIG_FEATURE_KEYS } = require('../../lib/featureCatalog');

// Scheduler engine stub: records manual runs instead of executing tasks (the router requires it lazily).
const schedulerRuns = [];
require.cache[require.resolve('../../services/taskSchedulerService')] = {
    id: 'taskSchedulerService-stub', loaded: true,
    exports: { reloadScheduler() {}, triggerTaskExecution: async (id) => { schedulerRuns.push(id); } },
};

// Feature-switch API enforcement for the features whose screens used to be hidden only in the sidebar.
const ROLES = ['SuperAdmin', 'Operator', 'Viewer', 'None'];
const bearer = (u) => `Bearer ${signToken(u)}`;
const OP = { username: 'op', domain: 'corp', role: 'Operator', groups: ['g'] };
const VIEWER = { username: 'vw', domain: 'corp', role: 'Viewer', groups: ['g'] };
const SA = { username: 'boss', domain: 'corp', role: 'SuperAdmin', groups: ['g'] };
const LOCAL_ADMIN = { username: 'admin', domain: 'local', role: 'SuperAdmin' };

function setRbac({ g = {}, sa = {} } = {}) {
    writeRbacConfig({
        roles: ROLES, users: {}, defaultRole: 'Viewer', groups: {
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { ...sa } },
            g: { type: 'group', target: 'g', enabled: true, features: { ...g } },
        },
    });
}
const on = (...keys) => Object.fromEntries(keys.map(k => [k, true]));

// A feature-check rejection (403 from checkFeature / checkAnyFeature), as opposed to a role check or the handler.
const isFeatureDenied = (res) => res.status === 403 && /feature/i.test(String(res.body && res.body.error));

let app;
test.before(async () => {
    await dbManager.initDB();
    app = express();
    app.use(express.json());
    app.use('/api/ops', require('../../routes/ops'));
    app.use('/api/remote', require('../../routes/remote'));
    app.use('/api/nutanix', require('../../routes/nutanix'));
    app.use('/api/prometheus', require('../../routes/prometheus'));
    app.use('/api/redis', require('../../routes/redis'));
    app.use('/api/runbook', require('../../routes/runbook'));
    app.use('/api/scheduler', require('../../routes/scheduler'));
    app.use('/api/sftp', require('../../routes/sftp'));
    app.use('/api/network-device', require('../../routes/networkDevice'));
    app.use('/api/monitor/forensics', require('../../routes/forensics'));
    app.use('/api/monitor', require('../../routes/monitor'));
    app.use('/api/auth', require('../../routes/auth'));
    app.use('/api/rack', require('../../routes/rack'));
    app.use('/api/cmd-library', require('../../routes/cmdLibrary'));
    app.use('/api/siem', require('../../routes/siem'));
    app.use('/api/monitor-siem', require('../../routes/monitorSiem'));
    app.use('/api/webhooks', require('../../routes/webhooks'));
    app.use('/api/ai', require('../../routes/ai'));
});
test.after(async () => { await dbManager.closeDB(); });

function call(method, url, user, body) {
    let r = request(app)[method](url);
    if (user) r = r.set('Authorization', bearer(user));
    return body !== undefined ? r.send(body) : r;
}

// [owner feature, method, url, body, other features that legitimately call it]
const REMOTE_CALLERS = ['nutanix', 'serverList', 'serverCheck', 'inventory', 'ipam', 'monitorScout', 'monitorAlerts', 'monitorAgents'];
const CASES = [
    ['remoteCmd', 'post', '/api/ops/command', { ips: [] }, []],
    ['serverCheck', 'post', '/api/ops/check', { ips: [] }, []],
    ['remoteCmd', 'get', '/api/remote/status', undefined, REMOTE_CALLERS],
    ['nutanix', 'get', '/api/nutanix/settings-check', undefined, []],
    ['nutanix', 'get', '/api/nutanix/clone-status', undefined, []],
    ['prometheus', 'get', '/api/prometheus/list', undefined, []],
    ['prometheus', 'get', '/api/prometheus/health-check-config', undefined, []],
    ['redisControl', 'get', '/api/redis/connections', undefined, []],
    ['runbook', 'get', '/api/runbook', undefined, []],
    ['scheduler', 'get', '/api/scheduler/tasks', undefined, []],
    ['scheduler', 'get', '/api/scheduler/logs', undefined, []],
    ['scheduler', 'post', '/api/scheduler/run-now/nope', {}, ['settings']],
    ['sftpManager', 'get', '/api/sftp/servers', undefined, []],
    ['networkDevice', 'get', '/api/network-device/devices', undefined, []],
    ['networkDevice', 'get', '/api/network-device/nd-1/snmp', undefined, ['dataCenter']],
    ['monitorWinEvent', 'get', '/api/monitor/winevent/live', undefined, []],
    ['monitorWinEvent', 'get', '/api/monitor/linuxlog/live', undefined, []],
    ['monitorLinuxLog', 'get', '/api/monitor/logrotation', undefined, []],
    ['monitorLinuxLog', 'get', '/api/monitor/tls_settings', undefined, []],
    ['monitorLinuxLog', 'get', '/api/monitor/winevent/policy', undefined, []],
    ['monitorLinuxLog', 'get', '/api/monitor/winevent/push_policy', undefined, []],
    ['monitorLinuxLog', 'get', '/api/monitor/linuxlog/policy', undefined, []],
    ['monitorLinuxLog', 'get', '/api/monitor/linuxlog/push_policy', undefined, []],
    // Round 2 C: routers that had no feature check at all
    ['dataCenter', 'get', '/api/rack/datacenters', undefined, ['networkDevice']],
    ['dataCenter', 'get', '/api/rack', undefined, ['networkDevice']],
    ['dataCenter', 'get', '/api/rack/revision', undefined, ['networkDevice']],
    ['dataCenter', 'get', '/api/rack/contracts', undefined, []],
    ['dataCenter', 'get', '/api/rack/spare-parts', undefined, []],
    ['dataCenter', 'get', '/api/rack/issues', undefined, []],
    ['remoteCmd', 'get', '/api/cmd-library', undefined, ['runbook']],
    ['elk', 'get', '/api/siem', undefined, []],
    ['elk', 'get', '/api/siem/telemetry', undefined, []],
    ['monitorWinEvent', 'get', '/api/monitor-siem/reports', undefined, []],
    ['monitorWinEvent', 'get', '/api/monitor-siem/local-stats', undefined, []],
    ['monitorWinEvent', 'get', '/api/monitor/forensics/reports', undefined, []],
    ['settings', 'get', '/api/webhooks', undefined, ['monitorScout', 'monitorAlerts', 'monitorAgents', 'workflow']],
    ['aiAgent', 'get', '/api/ai/config', undefined, ['settings']],
];
// 'settings' is a lock-out key: always on for SuperAdmin and not subject to the kill switch for them
const settingsReachable = (feature, others) => feature === 'settings' || others.includes('settings');
const label = ([f, m, u]) => `${f} ${m.toUpperCase()} ${u}`;

test('a user without the feature gets 403; with it the request reaches the handler', async () => {
    for (const c of CASES) {
        const [feature, method, url, body] = c;
        setRbac({ g: {} });
        const denied = await call(method, url, OP, body);
        assert.ok(isFeatureDenied(denied), `${label(c)} without feature -> ${denied.status} ${JSON.stringify(denied.body)}`);
        setRbac({ g: on(feature) });
        const allowed = await call(method, url, OP, body);
        assert.ok(!isFeatureDenied(allowed), `${label(c)} with feature -> ${allowed.status} ${JSON.stringify(allowed.body)}`);
    }
});

test('a feature switched off explicitly (false) is denied too', async () => {
    for (const c of CASES) {
        const [feature, method, url, body] = c;
        setRbac({ g: { [feature]: false } });
        assert.ok(isFeatureDenied(await call(method, url, OP, body)), label(c));
    }
});

test('shared endpoints accept every listed caller feature', async () => {
    for (const c of CASES) {
        const [, method, url, body, others] = c;
        for (const other of others) {
            if (other === 'settings') continue; // lock-out key: SuperAdmin only, covered below
            setRbac({ g: on(other) });
            const res = await call(method, url, OP, body);
            assert.ok(!isFeatureDenied(res), `${label(c)} via ${other} -> ${res.status} ${JSON.stringify(res.body)}`);
        }
    }
});

test('SuperAdmin follows the built-in mapping switch: off -> 403, on -> allowed', async () => {
    for (const c of CASES) {
        const [feature, method, url, body, others] = c;
        setRbac({ g: on(feature), sa: {} });
        const off = await call(method, url, SA, body);
        if (settingsReachable(feature, others)) {
            // Settings screens (SuperAdmin only, 'settings' always on) still reach it
            assert.ok(!isFeatureDenied(off), `${label(c)} reachable from Settings`);
        } else {
            assert.ok(isFeatureDenied(off), `${label(c)} SuperAdmin with switch off -> ${off.status}`);
        }
        setRbac({ sa: on(feature) });
        const onRes = await call(method, url, SA, body);
        assert.ok(!isFeatureDenied(onRes), `${label(c)} SuperAdmin with switch on -> ${onRes.status} ${JSON.stringify(onRes.body)}`);
    }
});

test('local admin (break-glass) is always allowed; the global kill switch wins over everyone', async (t) => {
    setRbac({});
    for (const c of CASES) {
        const [feature, method, url, body, others] = c;
        const res = await call(method, url, LOCAL_ADMIN, body);
        assert.ok(!isFeatureDenied(res), `${label(c)} local admin -> ${res.status}`);
        if (others.length || feature === 'settings') continue; // kill switch of one caller does not block the others
        const envKey = `APP_ENABLE_${feature.toUpperCase()}`;
        process.env[envKey] = 'false';
        try {
            setRbac({ g: on(feature), sa: on(feature) });
            assert.ok(isFeatureDenied(await call(method, url, LOCAL_ADMIN, body)), `${label(c)} kill switch / local admin`);
            assert.ok(isFeatureDenied(await call(method, url, OP, body)), `${label(c)} kill switch / group`);
            assert.ok(isFeatureDenied(await call(method, url, SA, body)), `${label(c)} kill switch / SuperAdmin`);
        } finally {
            delete process.env[envKey];
        }
    }
    t.diagnostic('kill switch checked on every single-owner endpoint');
});

test('unauthenticated requests are still 401 (feature checks run after authentication)', async () => {
    for (const c of CASES) {
        const [, method, url, body] = c;
        assert.equal((await call(method, url, null, body)).status, 401, label(c));
    }
});

test('Prometheus HTTP service discovery stays token-based (no user, no feature check)', async (t) => {
    process.env.PROMETHEUS_SD_TOKEN = 'sd-token';
    t.after(() => { delete process.env.PROMETHEUS_SD_TOKEN; });
    setRbac({});
    await request(app).get('/api/prometheus/targets').set('Authorization', 'Bearer sd-token').expect(200);
    await request(app).get('/api/prometheus/targets').expect(401);
});

test('Network Device endpoints: device management needs networkDevice, dataCenter alone is not enough', async () => {
    setRbac({ g: on('dataCenter') });
    assert.ok(isFeatureDenied(await call('get', '/api/network-device/devices', OP)));
    assert.ok(isFeatureDenied(await call('post', '/api/network-device/devices', OP, {})));
    assert.ok(isFeatureDenied(await call('put', '/api/network-device/devices/x', OP, {})));
    assert.ok(isFeatureDenied(await call('delete', '/api/network-device/devices/x', OP)));
    // Server Rack (Data Center) still reads / saves SNMP settings and polls
    assert.ok(!isFeatureDenied(await call('get', '/api/network-device/x/snmp', OP)));
    const viewer = await call('post', '/api/network-device/x/snmp', VIEWER, {});
    assert.ok(viewer.status === 403 && !isFeatureDenied(viewer), 'POST snmp reaches the role check');
    setRbac({ g: on('networkDevice') });
    const viewerNd = await call('post', '/api/network-device/x/snmp', VIEWER, {});
    assert.ok(viewerNd.status === 403 && !isFeatureDenied(viewerNd), 'Network Device screen also saves SNMP');
    setRbac({ g: {} });
    assert.ok(isFeatureDenied(await call('get', '/api/network-device/x/poll', OP)));
});

test('Monitor log endpoints use their own keys; Scout Monitor keeps the rest of /api/monitor', async () => {
    setRbac({ g: on('monitorScout') });
    assert.ok(isFeatureDenied(await call('get', '/api/monitor/winevent/live', OP)), 'monitorScout alone cannot read live events');
    assert.ok(isFeatureDenied(await call('get', '/api/monitor/logrotation', OP)), 'monitorScout alone cannot read log settings');
    assert.ok(isFeatureDenied(await call('get', '/api/monitor/WINEVENT/LIVE', OP)), 'case variants do not skip the specific key');
    assert.ok(isFeatureDenied(await call('get', '/api/monitor/winevent/live/', OP)), 'trailing slash does not skip the specific key');
    assert.ok(!isFeatureDenied(await call('get', '/api/monitor/', OP)), 'Scout Monitor list still works');

    setRbac({ g: on('monitorLinuxLog') });
    assert.ok(!isFeatureDenied(await call('get', '/api/monitor/Logrotation', OP)), 'case variant reaches the handler with the right key');
    assert.ok(isFeatureDenied(await call('get', '/api/monitor/', OP)), 'Scout Monitor list still needs monitorScout');
    // PUT/DELETE /:id with a log path as id must not skip the Scout Monitor gate
    assert.ok(isFeatureDenied(await call('put', '/api/monitor/vacuum', OP, {})), 'PUT /vacuum hits PUT /:id -> monitorScout');
    assert.ok(isFeatureDenied(await call('delete', '/api/monitor/logrotation', OP)), 'DELETE /logrotation hits DELETE /:id -> monitorScout');
    const vac = await call('post', '/api/monitor/vacuum', VIEWER, {});
    assert.ok(vac.status === 403 && !isFeatureDenied(vac), 'POST /vacuum: feature passes, role check still applies');
    const push = await call('post', '/api/monitor/winevent/push_policy', VIEWER, {});
    assert.ok(push.status === 403 && !isFeatureDenied(push), 'POST winevent push_policy: role check still applies');
    assert.ok(!isFeatureDenied(await call('post', '/api/monitor/winevent/validate_push_policy', VIEWER, {})));

    setRbac({ g: on('monitorWinEvent') });
    assert.ok(isFeatureDenied(await call('get', '/api/monitor/winevent/policy', OP)), 'policy belongs to Log Settings');
});

test('SFTP: test-connection is shared with Settings, everything else needs sftpManager', async () => {
    // Reaching the handler would open a connection, so the guard is checked with a Viewer:
    // a feature pass then stops at the role check (403 without "feature" in the message).
    setRbac({ g: {}, sa: {} });
    const viewer = await call('post', '/api/sftp/test-connection', VIEWER, {});
    assert.ok(isFeatureDenied(viewer), 'no sftpManager / settings -> feature 403');
    setRbac({ g: on('sftpManager') });
    const viewerOn = await call('post', '/api/sftp/test-connection', VIEWER, {});
    assert.ok(viewerOn.status === 403 && !isFeatureDenied(viewerOn), 'feature passes, role check still applies');
    setRbac({ g: {}, sa: {} });
    assert.ok(isFeatureDenied(await call('get', '/api/sftp/users', SA)), 'SuperAdmin with switch off');
});

test('role checks are unchanged (feature passes, role still rejects)', async () => {
    setRbac({ g: on('runbook', 'sftpManager', 'remoteCmd') });
    const del = await call('delete', '/api/runbook/x', OP);
    assert.ok(del.status === 403 && !isFeatureDenied(del));
    const restart = await call('post', '/api/sftp/service/restart', OP, {});
    assert.ok(restart.status === 403 && !isFeatureDenied(restart));
    const token = await call('post', '/api/remote/token', VIEWER, {});
    assert.ok(token.status === 403 && !isFeatureDenied(token));
});

test('/config returns every editor key for SuperAdmin and non-SuperAdmin users, with the API value', async () => {
    setRbac({ g: on('networkDevice', 'monitorScout'), sa: on('dnsHub') });
    const { hasFeature } = require('../../lib/permissions');
    // Extra keys allowed beyond the editor: legacy global flags of the unauthenticated response (e.g. scoutMonitor)
    const legacyOnly = LEGACY_CONFIG_FEATURE_KEYS.filter(k => !editorKeys().has(k));
    const expected = [...new Set([...editorKeys(), ...legacyOnly])].sort();
    for (const user of [OP, VIEWER, SA]) {
        const { body } = await call('get', '/api/auth/config', user).expect(200);
        assert.deepEqual(Object.keys(body.features).sort(), expected, `${user.role} key set`);
        for (const [k, v] of Object.entries(body.features)) assert.equal(v, hasFeature(user, k), `${user.role} ${k}`);
    }
    const { body } = await call('get', '/api/auth/config', OP).expect(200);
    assert.equal(body.features.networkDevice, true);
    for (const k of ['sftpManager', 'monitorWinEvent', 'monitorLinuxLog', 'monitorAlerts', 'monitorAgents', 'nasControl', 'hmChecker']) {
        assert.equal(body.features[k], false, `${k} hidden for a group without it`);
    }
});

test('/config exposes every key that a route enforces, for a non-SuperAdmin user', async () => {
    setRbac({});
    const { body } = await call('get', '/api/auth/config', OP).expect(200);
    const missing = [...enforcedKeysInRoutes().all].filter(k => !(k in body.features));
    assert.deepEqual(missing, [], 'enforced keys missing from /config');
});

// ---- Round 2: role restrictions on state-changing endpoints ----
test('Remote Command needs Operator+; Server Check stays open to Viewers', async () => {
    setRbac({ g: on('remoteCmd', 'serverCheck') });
    const v = await call('post', '/api/ops/command', VIEWER, { ips: [] });
    assert.ok(v.status === 403 && !isFeatureDenied(v), `Viewer remote command -> ${v.status} ${JSON.stringify(v.body)}`);
    // Operator passes the role check: an empty target list is then rejected by validation (400)
    assert.equal((await call('post', '/api/ops/command', OP, { ips: [] })).status, 400);
    assert.equal((await call('post', '/api/ops/check', VIEWER, { ips: [] })).status, 200);
});

test('Scheduler: Viewer with the feature cannot add, edit, toggle, run or delete tasks (no local_ps runs)', async () => {
    setRbac({ g: on('scheduler') });
    const { writeDataSync } = require('../../lib/db');
    writeDataSync('server_operation/scheduler_tasks.json', [
        { id: 't-local', name: 'local', cronExpression: '0 0 * * *', targetType: 'local_ps', targets: [], winCommand: 'whoami', nixCommand: '', status: 'active' },
    ]);
    schedulerRuns.length = 0;
    const roleDenied = (res) => res.status === 403 && !isFeatureDenied(res);
    assert.ok(roleDenied(await call('post', '/api/scheduler/tasks/add', VIEWER, { name: 'x', targetType: 'local_ps', winCommand: 'whoami' })), 'add');
    assert.ok(roleDenied(await call('put', '/api/scheduler/tasks/update', VIEWER, { id: 't-local', winCommand: 'calc' })), 'update');
    assert.ok(roleDenied(await call('post', '/api/scheduler/tasks/toggle/t-local', VIEWER, {})), 'toggle');
    assert.ok(roleDenied(await call('post', '/api/scheduler/tasks/run/t-local', VIEWER, {})), 'run');
    assert.ok(roleDenied(await call('delete', '/api/scheduler/tasks/delete/t-local', VIEWER)), 'delete (Viewer)');
    assert.ok(roleDenied(await call('delete', '/api/scheduler/tasks/delete/t-local', OP)), 'delete (Operator)');
    assert.deepEqual(schedulerRuns, [], 'no task was executed');
    const { readDataSync } = require('../../lib/db');
    const tasks = readDataSync('server_operation/scheduler_tasks.json', []);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].winCommand, 'whoami');
    assert.equal(tasks[0].status, 'active');
    // Viewer can still read
    assert.equal((await call('get', '/api/scheduler/tasks', VIEWER)).status, 200);
    // Operator can run, SuperAdmin can delete
    assert.equal((await call('post', '/api/scheduler/tasks/run/t-local', OP, {})).status, 200);
    assert.deepEqual(schedulerRuns, ['t-local']);
    setRbac({ sa: on('scheduler') });
    assert.equal((await call('delete', '/api/scheduler/tasks/delete/t-local', SA)).status, 200);
});

test('run-now needs the owner feature AND Operator+ (Settings "Run Scan Now" as SuperAdmin still works)', async () => {
    for (const mod of ['ssl', 'dns', 'prometheus', 'inventory', 'nope']) {
        setRbac({ g: on('scheduler', 'sslMonitor', 'dnsHub', 'prometheus', 'inventory') });
        const v = await call('post', `/api/scheduler/run-now/${mod}`, VIEWER, {});
        assert.ok(v.status === 403 && !isFeatureDenied(v), `${mod}: Viewer -> ${v.status}`);
        setRbac({ g: {} });
        assert.ok(isFeatureDenied(await call('post', `/api/scheduler/run-now/${mod}`, OP, {})), `${mod}: no feature`);
    }
    setRbac({ sa: {} }); // built-in switches all off: 'settings' (lock-out) keeps Run Scan Now reachable
    assert.equal((await call('post', '/api/scheduler/run-now/nope', SA, {})).status, 400);
});

test('Prometheus writes need Operator+; reads stay open to Viewers with the feature', async () => {
    setRbac({ g: on('prometheus') });
    const writes = [
        ['put', '/api/prometheus/pause', {}], ['post', '/api/prometheus/bulk-pause', {}], ['post', '/api/prometheus/parse', {}],
        ['delete', '/api/prometheus/target/10.0.0.1'], ['post', '/api/prometheus/bulk-delete', {}], ['put', '/api/prometheus/update', {}],
        ['post', '/api/prometheus/restore', {}], ['post', '/api/prometheus/health-check-config', {}], ['post', '/api/prometheus/health-check-run', {}],
    ];
    for (const [m, u, b] of writes) {
        const res = await call(m, u, VIEWER, b);
        assert.ok(res.status === 403 && !isFeatureDenied(res), `${m} ${u} Viewer -> ${res.status} ${JSON.stringify(res.body)}`);
    }
    for (const u of ['/api/prometheus/list', '/api/prometheus/backups', '/api/prometheus/health-check-config']) {
        assert.equal((await call('get', u, VIEWER)).status, 200, u);
    }
});

test('Round 2 C write / action endpoints: owner feature plus the unchanged role check', async () => {
    const roleDenied = (res) => res.status === 403 && !isFeatureDenied(res);
    // cmd-library writes belong to Remote Command; the Runbook screen only reads it
    setRbac({ g: on('runbook') });
    assert.ok(isFeatureDenied(await call('post', '/api/cmd-library', OP, {})));
    assert.ok(isFeatureDenied(await call('delete', '/api/cmd-library/x', OP)));
    assert.ok(!isFeatureDenied(await call('get', '/api/cmd-library', OP)));
    setRbac({ g: on('remoteCmd') });
    assert.ok(!isFeatureDenied(await call('post', '/api/cmd-library', OP, {})));
    // webhooks writes: System Settings only
    setRbac({ g: on('monitorScout', 'monitorAlerts', 'workflow') });
    assert.ok(!isFeatureDenied(await call('get', '/api/webhooks', OP)));
    for (const [m, u] of [['post', '/api/webhooks'], ['put', '/api/webhooks/x'], ['delete', '/api/webhooks/x'], ['post', '/api/webhooks/test/x']]) {
        assert.ok(isFeatureDenied(await call(m, u, OP, {})), `${m} ${u}`);
    }
    setRbac({ g: on('settings') });
    assert.ok(roleDenied(await call('post', '/api/webhooks', VIEWER, {})));
    // webhooks incoming stays public (token per webhook)
    assert.ok(!isFeatureDenied(await call('post', '/api/webhooks/incoming/none', null, {})));
    // AI: Settings endpoints, chat (AI agent), forensics remediation (Live Event Viewer -> On-Demand Forensics)
    setRbac({ g: on('aiAgent', 'monitorWinEvent') });
    for (const u of ['/api/ai/config', '/api/ai/test', '/api/ai/fetch-models']) assert.ok(isFeatureDenied(await call('post', u, OP, {})), u);
    setRbac({ g: on('settings', 'monitorWinEvent') });
    assert.ok(isFeatureDenied(await call('post', '/api/ai/chat', OP, {})), 'chat needs aiAgent');
    setRbac({ g: on('settings', 'aiAgent') });
    assert.ok(isFeatureDenied(await call('post', '/api/ai/forensics-remediation', OP, {})), 'remediation needs monitorWinEvent');
    setRbac({ g: on('settings', 'aiAgent', 'monitorWinEvent') });
    for (const u of ['/api/ai/config', '/api/ai/test', '/api/ai/fetch-models', '/api/ai/chat', '/api/ai/forensics-remediation']) {
        assert.ok(roleDenied(await call('post', u, VIEWER, {})), `${u} Viewer`);
    }
    // forensics: Live Event Viewer; the agent upload stays key-based (no session)
    setRbac({ g: {} });
    assert.ok(isFeatureDenied(await call('post', '/api/monitor/forensics/scan', OP, {})));
    assert.equal((await call('post', '/api/monitor/forensics/upload', null, {})).status, 400);
    setRbac({ g: on('monitorWinEvent') });
    assert.ok(roleDenied(await call('post', '/api/monitor/forensics/scan', VIEWER, {})));
    // monitor-siem report generation: Live Event Viewer -> SIEM analytics
    setRbac({ g: {} });
    assert.ok(isFeatureDenied(await call('post', '/api/monitor-siem/generate-report', OP, {})));
    // siem save: ELK
    assert.ok(isFeatureDenied(await call('post', '/api/siem/save', OP, {})));
    // rack writes: Data Center only (Network Device only reads data centers / racks)
    setRbac({ g: on('networkDevice') });
    assert.ok(isFeatureDenied(await call('post', '/api/rack/datacenters', OP, {})));
    assert.ok(isFeatureDenied(await call('patch', '/api/rack', OP, {})));
    assert.ok(isFeatureDenied(await call('get', '/api/rack/contracts', OP)));
});

test('every monitor route that skips the Scout Monitor gate has its own feature check', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../routes/monitor.js'), 'utf8');
    const set = src.match(/const LOG_ROUTES = new Set\(\[([\s\S]*?)\]\);/);
    assert.ok(set, 'LOG_ROUTES found');
    const entries = [...set[1].matchAll(/'(GET|POST) ([^']+)'/g)];
    assert.ok(entries.length >= 17);
    for (const [, method, p] of entries) {
        const re = new RegExp(`router\\.${method.toLowerCase()}\\('${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}',\\s*(logSettingsFeature|liveViewerFeature),`);
        assert.match(src, re, `${method} ${p} must be guarded by its own feature`);
    }
});

// ---- Drift guard: every key of the RBAC feature editor is enforced on at least one route ----
// UI-only keys (no API of their own) with the reason they are not checked on a route.
// ('settings' is a lock-out key too; it owns the System-Settings-only endpoints such as the webhook writes and
// the AI Service settings, and is the second key of endpoints shared with System Settings, so it is not listed here.)
const UI_ONLY_KEYS = {
    auditLog: 'Lock-out key. /api/audit is gated by checkRole([SuperAdmin]); always on for SuperAdmin.',
};

// Remove /* */ and // comments (not inside quotes) so commented-out checks do not count.
function stripComments(src) {
    let out = '';
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
            const q = c; out += c; i++;
            while (i < src.length && src[i] !== q) { if (src[i] === '\\') { out += src[i++]; } out += src[i++]; }
            out += q; continue;
        }
        if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
        if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e - 1; continue; }
        out += c;
    }
    return out;
}

/**
 * all:    every key quoted in a checkFeature / checkAnyFeature / hasFeature call in routes/*.js
 * owners: key -> files where it is the FIRST (owner) key of such a call
 *         (hasFeature(user, 'key'): the first quoted key)
 */
function enforcedKeysInRoutes() {
    const dir = path.join(__dirname, '../../routes');
    const all = new Set();
    const owners = new Map();
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
        const src = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const m of src.matchAll(/\b(?:checkFeature|checkAnyFeature|hasFeature)\(([^)]*)\)/g)) {
            const quoted = [...m[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map(s => s[1]);
            quoted.forEach(k => all.add(k));
            if (quoted.length) {
                if (!owners.has(quoted[0])) owners.set(quoted[0], new Set());
                owners.get(quoted[0]).add(f);
            }
        }
    }
    return { all, owners };
}

test('drift guard helper ignores commented-out checks', () => {
    assert.equal(stripComments("a // checkFeature('x')\nb /* checkFeature('y') */ c 'k//not'").includes("checkFeature"), false);
    assert.match(stripComments("x = '// keep'"), /\/\/ keep/);
});

function editorKeys() {
    const src = fs.readFileSync(path.join(__dirname, '../../../frontend/src/components/SettingsGroup/rbacBuiltinUtils.js'), 'utf8');
    const start = src.indexOf('export const FEATURE_CATEGORIES');
    assert.ok(start >= 0, 'FEATURE_CATEGORIES found');
    const keys = [...src.slice(start).matchAll(/key:\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)].map(m => m[1]);
    return new Set([...keys, ...FEATURE_KEYS, ...SUPERADMIN_LOCKED_FEATURES]);
}

// Owner map: the route file(s) where each editor key must be the primary (first) key of a check.
const OWNER_FILES = {
    dnsHub: 'records.js', adControl: 'ad.js', runbook: 'runbook.js', aiAgent: 'agent.js',
    serverList: 'serverList.js', serverCheck: 'ops.js', remoteCmd: 'ops.js', install: 'install.js', nutanix: 'nutanix.js',
    inventory: 'inventory.js', scheduler: 'scheduler.js', hmChecker: 'hmChecker.js',
    monitorScout: 'monitor.js', monitorAlerts: 'alertQuality.js', monitorWinEvent: 'monitor.js', monitorLinuxLog: 'monitor.js',
    monitorAgents: 'inventory.js', manage_self_healing: 'monitor.js',
    fortiProxy: 'fortiproxy.js', squid: 'squid.js', ipam: 'ipam.js', networkDevice: 'networkDevice.js', sslMonitor: 'ssl.js', netSearch: 'netsearch.js',
    mail: 'mail.js', elk: 'elk.js', prometheus: 'prometheus.js', redisControl: 'redis.js', kubernetes: 'kubernetes.js', nasControl: 'nas.js',
    workflow: 'workflow.js', sftpManager: 'sftp.js', dataCenter: 'rack.js',
    dbInventory: 'database.js', dbPerformance: 'database.js', dbProvision: 'database.js', dbBackup: 'database.js', dbSqlTerminal: 'database.js',
    settings: 'webhooks.js',
};

test('drift guard: every RBAC editor key is the owner (first) key of a check in its route file', () => {
    const { owners } = enforcedKeysInRoutes();
    const keys = [...editorKeys()].filter(k => !Object.prototype.hasOwnProperty.call(UI_ONLY_KEYS, k));
    const noOwnerEntry = keys.filter(k => !OWNER_FILES[k]);
    assert.deepEqual(noOwnerEntry, [], `add these editor keys to OWNER_FILES: ${noOwnerEntry.join(', ')}`);
    const notOwned = keys.filter(k => !(owners.get(k) && owners.get(k).has(OWNER_FILES[k])));
    assert.deepEqual(notOwned, [], `keys that are not the primary check in their route file: ${notOwned.map(k => `${k} (${OWNER_FILES[k]})`).join(', ')}`);
    for (const k of Object.keys(UI_ONLY_KEYS)) assert.ok(!owners.has(k), `${k} is enforced now: remove it from UI_ONLY_KEYS`);
});

test('drift guard (reverse): every key used in a route check exists in the feature catalogue', () => {
    const catalogue = new Set([...FEATURE_KEYS, ...SUPERADMIN_LOCKED_FEATURES]);
    const unknown = [...enforcedKeysInRoutes().all].filter(k => !catalogue.has(k));
    assert.deepEqual(unknown, [], `unknown feature keys in routes (typo?): ${unknown.join(', ')}`);
});
