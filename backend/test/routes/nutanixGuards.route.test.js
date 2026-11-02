// Nutanix VM Manager write endpoints: Viewer is read-only, power actions and mapping tables are validated.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { readDataSync } = require('../../lib/db');
const v = require('../../lib/nutanixValidation');

const user = (role) => ({ username: role.toLowerCase(), domain: 'corp', role, groups: ['g'] });
const bearer = (role) => `Bearer ${signToken(user(role))}`;
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const IP_ROW = { subnetPrefix: '10.20.30', ouLayer: 'OU=Servers,DC=corp,DC=example', cluster: 'CL1', zone: 'corp.example', dns1: '192.0.2.1', dns2: '192.0.2.2', vlan: 'VLAN30', clusterIp: '192.0.2.10' };
const TPL_ROW = { os: 'W2K22', bu: 'Default', cluster: 'All', template: 'Template_2022' };

let app;
test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: {
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { nutanix: true } },
            g: { type: 'group', target: 'g', enabled: true, features: { nutanix: true } },
        },
    });
    // Nutanix not configured: a request that passes the guards stops at the credentials check, never the network
    for (const k of ['NUTANIX_MODE', 'NUTANIX_PC_IP', 'NUTANIX_PC_ACCOUNT', 'NUTANIX_PC_PWD', 'NUTANIX_PE_IP', 'NUTANIX_PE_ACCOUNT', 'NUTANIX_PE_PWD']) delete process.env[k];
    app = express();
    app.use(express.json());
    app.use('/api/nutanix', require('../../routes/nutanix'));
});
test.after(async () => { await dbManager.closeDB(); });

test('Viewer gets 403 on every write endpoint and nothing is saved', async () => {
    const calls = [
        ['/api/nutanix/vm-action', { uuids: [UUID], actionType: 'OFF' }],
        ['/api/nutanix/clone', { vms: [{ Name: 'a', IP: '10.20.30.5', OS: 'Rocky Linux', Env: 'x' }] }],
        ['/api/nutanix/ip-switch-map', [IP_ROW]],
        ['/api/nutanix/template-bu-map', [TPL_ROW]],
    ];
    for (const [url, body] of calls) {
        const res = await request(app).post(url).set('Authorization', bearer('Viewer')).send(body);
        assert.equal(res.status, 403, url);
        assert.match(res.body.error, /Requires one of: SuperAdmin, Operator/, url);
    }
    assert.deepEqual(readDataSync('server_operation/ip_switch_map.json', []), []);
    assert.deepEqual(readDataSync('server_operation/template_bu_map.json', []), []);
});

test('Viewer can still read', async () => {
    await request(app).get('/api/nutanix/settings-check').set('Authorization', bearer('Viewer')).expect(200);
    await request(app).get('/api/nutanix/ip-switch-map').set('Authorization', bearer('Viewer')).expect(200);
});

test('vm-action: unknown action or non-UUID is rejected before any Nutanix call', async () => {
    const post = (body) => request(app).post('/api/nutanix/vm-action').set('Authorization', bearer('Operator')).send(body);
    let res = await post({ uuids: [UUID], actionType: 'DELETE' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Unsupported actionType "DELETE"/);
    res = await post({ uuids: ['../../clusters'], actionType: 'OFF' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /row 1: Invalid VM UUID/);
    // valid input passes the guards and stops at the (missing) credentials
    res = await post({ uuids: [UUID], actionType: 'ACPI_SHUTDOWN' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /credentials not configured/);
});

test('mapping tables: Operator saves valid data, invalid rows are rejected with their row number', async () => {
    await request(app).post('/api/nutanix/ip-switch-map').set('Authorization', bearer('Operator')).send([IP_ROW]).expect(200);
    assert.deepEqual(readDataSync('server_operation/ip_switch_map.json', []), [IP_ROW]);
    const res = await request(app).post('/api/nutanix/ip-switch-map').set('Authorization', bearer('Operator'))
        .send([IP_ROW, { ...IP_ROW, vlan: '' }]).expect(400);
    assert.match(res.body.error, /row 2: Duplicate subnetPrefix "10\.20\.30" \(also row 1\)/);
    assert.deepEqual(res.body.rows.map(r => r.row), [2, 2]);
    assert.deepEqual(readDataSync('server_operation/ip_switch_map.json', []), [IP_ROW], 'rejected save leaves the table unchanged');

    await request(app).post('/api/nutanix/template-bu-map').set('Authorization', bearer('SuperAdmin')).send([TPL_ROW]).expect(200);
    await request(app).post('/api/nutanix/template-bu-map').set('Authorization', bearer('SuperAdmin')).send({ not: 'an array' }).expect(400);
});

test('validateVmAction', () => {
    assert.deepEqual(v.validateVmAction([UUID], 'OFF').errors, []);
    for (const a of v.POWER_ACTIONS) assert.deepEqual(v.validateVmAction([UUID.toUpperCase()], a).errors, []);
    assert.equal(v.validateVmAction([UUID], 'off').errors.length, 1);
    assert.equal(v.validateVmAction([], 'OFF').errors.length, 1);
    assert.equal(v.validateVmAction('x', 'OFF').errors.length, 1);
    assert.equal(v.validateVmAction(Array(v.MAX_VM_ACTION_UUIDS + 1).fill(UUID), 'OFF').errors.length, 1);
    assert.deepEqual(v.validateVmAction([UUID, 7, 'abc'], 'OFF').errors.map(e => e.row), [2, 3]);
});

test('validateIpSwitchMap', () => {
    const errs = (rows) => v.validateIpSwitchMap(rows).errors.map(e => e.error);
    assert.deepEqual(errs([IP_ROW, { ...IP_ROW, subnetPrefix: '10.20.31', vlan: 31, clusterIp: '' }]), []);
    assert.match(errs([{ ...IP_ROW, subnetPrefix: '10.20' }])[0], /must be 3 octets/);
    assert.match(errs([{ ...IP_ROW, subnetPrefix: '10.20.256' }])[0], /must be 3 octets/);
    assert.deepEqual(errs([{ ...IP_ROW, cluster: ' ', zone: '' }]), ['cluster is required', 'zone is required']);
    assert.match(errs([{ ...IP_ROW, clusterIp: '1.2.3.4/evil?x=' }])[0], /clusterIp .* must be an IP address or host name/);
    assert.match(errs([{ ...IP_ROW, ouLayer: 'OU=a\r\nOU=b' }])[0], /control characters/);
    assert.match(errs([{ ...IP_ROW, ouLayer: { $gt: '' } }])[0], /must be a text value/);
    assert.match(errs([{ ...IP_ROW, ouLayer: 'x'.repeat(513) }])[0], /too long/);
    assert.match(errs(['row'])[0], /must be an object/);
    assert.match(errs({})[0], /must be an array/);
    assert.match(errs(Array(v.MAX_MAP_ENTRIES + 1).fill(IP_ROW))[0], /too many entries/);
});

test('validateTemplateBuMap', () => {
    const errs = (rows) => v.validateTemplateBuMap(rows).errors.map(e => e.error);
    assert.deepEqual(errs([TPL_ROW, { ...TPL_ROW, cluster: 'CL1' }, { os: 'Rocky', bu: 'Default', template: 'T' }]), []);
    assert.deepEqual(errs([{ os: '', bu: 'X', template: '' }]), ['os is required', 'template is required']);
    // cluster missing counts as "All"; comparison ignores case
    assert.match(errs([TPL_ROW, { os: 'w2k22', bu: 'DEFAULT', template: 'Other' }])[0], /Duplicate OS\/BU\/Cluster .* \(also row 1\)/);
});

test('describeErrors keeps the message short', () => {
    const errors = Array.from({ length: 12 }, (_, i) => ({ row: i + 1, error: 'bad' }));
    const msg = v.describeErrors('X rejected', errors);
    assert.match(msg, /^X rejected: row 1: bad; /);
    assert.match(msg, /\(\+2 more\)$/);
});

test('clone: refused while a task is running; clone-status is the persisted task status', async (t) => {
    const nutanix = require('../../routes/nutanix');
    const fake = { running: true, startTime: 1, timeoutAt: 2, finishedAt: null, vms: [{ Name: 'a' }], result: null };
    nutanix.setCloneTaskForTest(() => ({ status: () => fake, start: () => { throw new Error('must not start'); } }));
    t.after(() => nutanix.setCloneTaskForTest(null));
    const res = await request(app).post('/api/nutanix/clone').set('Authorization', bearer('Operator'))
        .send({ vms: [{ Name: 'a', IP: '10.20.30.5', OS: 'Rocky Linux', Env: 'x' }] }).expect(400);
    assert.match(res.body.error, /currently running/);
    const st = await request(app).get('/api/nutanix/clone-status').set('Authorization', bearer('Viewer')).expect(200);
    assert.deepEqual(st.body, fake);
});
