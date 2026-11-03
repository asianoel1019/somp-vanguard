// Nutanix VM Manager against a fake Prism: partial failures become warnings, PE/PC data shape, PC power changes.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const nutanixClient = require('../../lib/nutanixClient');

const bearer = `Bearer ${signToken({ username: 'op', domain: 'corp', role: 'Operator', groups: ['g'] })}`;
const PE1 = '192.0.2.11';
const PE2 = '192.0.2.12';
const PC = '192.0.2.20';
const uuid = (n) => `0f8fad5b-d9cb-469f-a165-${String(n).padStart(12, '0')}`;
const prismError = (status, message) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { message } } });

let calls = [];
/** routes: { 'METHOD host path': (req) => data | throws } */
function fakePrism(routes) {
    calls = [];
    nutanixClient.setTransportForTest(async (req) => {
        const u = new URL(req.url);
        const key = `${req.method.toUpperCase()} ${u.hostname} ${u.pathname.replace('/api/nutanix', '')}`;
        calls.push({ key, data: req.data, params: req.params });
        const handler = routes[key];
        if (!handler) throw prismError(404, `no route ${key}`);
        return { data: await handler(req) };
    });
}

function setEnv(vars) {
    for (const k of ['NUTANIX_MODE', 'NUTANIX_PC_IP', 'NUTANIX_PC_ACCOUNT', 'NUTANIX_PC_PWD', 'NUTANIX_PE_IP', 'NUTANIX_PE_ACCOUNT', 'NUTANIX_PE_PWD']) delete process.env[k];
    Object.assign(process.env, vars);
}
const PE_ENV = { NUTANIX_MODE: 'PE', NUTANIX_PE_IP: `${PE1},${PE2}`, NUTANIX_PE_ACCOUNT: 'pe', NUTANIX_PE_PWD: 'pw' };
const PC_ENV = { NUTANIX_PC_IP: PC, NUTANIX_PC_ACCOUNT: 'pc', NUTANIX_PC_PWD: 'pw' };

let app;
test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: {
            g: { type: 'group', target: 'g', enabled: true, features: { nutanix: true } },
        },
    });
    app = express();
    app.use(express.json());
    app.use('/api/nutanix', require('../../routes/nutanix'));
});
test.after(async () => { nutanixClient.setTransportForTest(null); await dbManager.closeDB(); });

const peVm = (n, extra = {}) => ({ uuid: uuid(n), name: `vm${n}`, power_state: 'on', num_vcpus: 2, num_cores_per_vcpu: 2, memory_mb: 4096, host_uuid: 'h1', vm_disk_info: [{ size: 1024 ** 3 }], ...extra });

test('PE mode /vms: one PE down -> VMs of the other PE plus a warning naming the failed PE', async () => {
    setEnv(PE_ENV);
    fakePrism({
        [`GET ${PE1} /v2.0/vms`]: () => ({ entities: [peVm(1), { ...peVm(2), name: 'NTNX-x-CVM' }], metadata: { grand_total_entities: 2 } }),
        [`GET ${PE1} /v2.0/hosts`]: () => ({ entities: [{ uuid: 'h1', name: 'node-a' }] }),
        [`GET ${PE1} /v2.0/cluster`]: () => ({ name: 'CL1' }),
        [`GET ${PE2} /v2.0/vms`]: () => { throw prismError(401, 'Authentication required'); },
    });
    const res = await request(app).post('/api/nutanix/vms').set('Authorization', bearer).expect(200);
    assert.equal(res.body.vms.length, 1, 'CVM filtered');
    const r = res.body.vms[0].status.resources;
    assert.equal(r.num_sockets * r.num_vcpus_per_socket, 4);
    assert.equal(r.disk_list[0].disk_size_mib, 1024);
    assert.equal(r.host_reference.name, 'node-a');
    assert.equal(res.body.vms[0].status.cluster_reference.name, 'CL1');
    assert.deepEqual(res.body.warnings, [{ source: `PE ${PE2}`, error: 'Authentication required' }]);
    const vmsCall = calls.find(c => c.key === `GET ${PE1} /v2.0/vms`);
    assert.equal(vmsCall.params.include_vm_disk_config, true);
});

test('PE mode /vms: every PE down -> error instead of an empty list', async () => {
    setEnv(PE_ENV);
    fakePrism({});
    const res = await request(app).post('/api/nutanix/vms').set('Authorization', bearer).expect(502);
    assert.match(res.body.error, /No Prism Element answered/);
    assert.equal(res.body.warnings.length, 2);
});

test('PC mode with PE IPs: v2 disks are reported in MiB like PE mode', async () => {
    setEnv({ ...PC_ENV, NUTANIX_PE_IP: PE1 });
    fakePrism({
        [`GET ${PE1} /v2.0/vms`]: () => ({ entities: [peVm(1)] }),
        [`GET ${PE1} /v2.0/cluster`]: () => ({ name: 'CL1' }),
    });
    const res = await request(app).post('/api/nutanix/vms').set('Authorization', bearer).expect(200);
    assert.equal(res.body.vms[0].status.resources.disk_list[0].disk_size_mib, 1024);
    assert.equal(res.body.isPeMode, false);
});

test('PC mode /vms: pages past the first 500, resolves host names, reports a failed cluster', async () => {
    setEnv(PC_ENV);
    const many = Array.from({ length: 501 }, (_, i) => ({ metadata: { uuid: uuid(i) }, spec: { name: `vm${i}` }, status: { resources: { host_reference: { uuid: 'h1' } } } }));
    fakePrism({
        [`POST ${PC} /v3/clusters/list`]: () => ({ entities: [{ spec: { name: 'CL1' } }, { spec: { name: 'CL2' } }], metadata: { total_matches: 2 } }),
        [`POST ${PC} /v3/vms/list`]: (req) => {
            if (req.data.filter === 'cluster_name==CL2') throw prismError(500, 'cluster busy');
            return { entities: many.slice(req.data.offset, req.data.offset + req.data.length), metadata: { total_matches: many.length } };
        },
        [`POST ${PC} /v3/hosts/list`]: () => ({ entities: [{ metadata: { uuid: 'h1' }, status: { name: 'node-a' } }], metadata: { total_matches: 1 } }),
    });
    const res = await request(app).post('/api/nutanix/vms').set('Authorization', bearer).expect(200);
    assert.equal(res.body.vms.length, 501);
    assert.equal(res.body.vms[500].status.resources.host_reference.name, 'node-a');
    assert.deepEqual(res.body.warnings, [{ source: 'cluster CL2', error: 'cluster busy' }]);
});

test('/templates and /clusters keep their array shape and report failed PEs in X-Nutanix-Warnings', async () => {
    setEnv(PE_ENV);
    fakePrism({
        [`GET ${PE1} /v2.0/vms`]: () => ({ entities: [{ uuid: uuid(1), name: 'Template_W2K22' }, { uuid: uuid(2), name: 'app01' }] }),
        [`GET ${PE1} /v2.0/cluster`]: () => ({ name: 'CL1' }),
    });
    const decode = (res) => JSON.parse(decodeURIComponent(res.headers['x-nutanix-warnings']));
    let res = await request(app).get('/api/nutanix/templates').set('Authorization', bearer).expect(200);
    assert.deepEqual(res.body, ['Template_W2K22']);
    assert.equal(decode(res)[0].source, `PE ${PE2}`);
    res = await request(app).get('/api/nutanix/clusters').set('Authorization', bearer).expect(200);
    assert.deepEqual(res.body, ['CL1']);
    assert.equal(decode(res)[0].source, `PE ${PE2}`);
});

test('PC vm-action: OFF keeps spec_version, retries after 409, unsupported actions fail without a call', async () => {
    setEnv(PC_ENV);
    let gets = 0, puts = [];
    fakePrism({
        [`GET ${PC} /v3/vms/${uuid(1)}`]: () => { gets++; return { spec: { resources: { power_state: 'ON' } }, metadata: { uuid: uuid(1), spec_version: gets }, status: {} }; },
        [`PUT ${PC} /v3/vms/${uuid(1)}`]: (req) => { puts.push(req.data); if (puts.length === 1) throw prismError(409, 'spec_version mismatch'); return {}; },
    });
    let res = await request(app).post('/api/nutanix/vm-action').set('Authorization', bearer).send({ uuids: [uuid(1)], actionType: 'OFF' }).expect(200);
    assert.deepEqual(res.body.results, [{ uuid: uuid(1), status: 'Success' }]);
    assert.equal(gets, 2, 'GET repeated after the conflict');
    assert.equal(puts[1].metadata.spec_version, 2, 'PUT carries the version it read');
    assert.equal(puts[1].spec.resources.power_state, 'OFF');
    assert.equal(puts[1].spec.resources.power_state_mechanism.mechanism, 'HARD');
    assert.equal(puts[1].status, undefined);

    calls = [];
    res = await request(app).post('/api/nutanix/vm-action').set('Authorization', bearer).send({ uuids: [uuid(1)], actionType: 'RESET' }).expect(200);
    assert.equal(res.body.results[0].status, 'Error');
    assert.match(res.body.results[0].message, /not available through Prism Central v3/);
    assert.equal(calls.length, 0);
});

test('PE vm-action: tries the next PE, at most 5 requests in flight', async () => {
    setEnv(PE_ENV);
    let inFlight = 0, peak = 0;
    const routes = {};
    const ids = Array.from({ length: 12 }, (_, i) => uuid(i + 1));
    for (const id of ids) {
        routes[`POST ${PE2} /v2.0/vms/${id}/set_power_state`] = async () => {
            inFlight++; peak = Math.max(peak, inFlight);
            await new Promise(r => setTimeout(r, 5));
            inFlight--;
            return {};
        };
    }
    fakePrism(routes); // PE1 answers 404 for all of them
    const res = await request(app).post('/api/nutanix/vm-action').set('Authorization', bearer).send({ uuids: ids, actionType: 'ACPI_SHUTDOWN' }).expect(200);
    assert.ok(res.body.results.every(r => r.status === 'Success'));
    assert.ok(peak <= 5, `peak ${peak}`);
    assert.equal(calls.find(c => c.key.includes(PE2)).data.transition, 'ACPI_SHUTDOWN');
});
