// Shared Prism client: mode resolution, paging, bounded concurrency and the v2 -> v3 VM mapping.
const test = require('node:test');
const assert = require('node:assert/strict');
const nc = require('../../lib/nutanixClient');

const fakeClient = (handler) => ({
    calls: [],
    get(path, opts) { this.calls.push(['get', path, opts && opts.params]); return handler('get', path, opts); },
    post(path, body) { this.calls.push(['post', path, body]); return handler('post', path, body); },
});

test('resolveConfig: PE mode when forced or when only PE IPs exist, account follows the mode', () => {
    let c = nc.resolveConfig({ NUTANIX_PE_IP: ' 192.0.2.1, ,192.0.2.2 ', NUTANIX_PE_ACCOUNT: 'pe', NUTANIX_PE_PWD: 'x' });
    assert.equal(c.isPeMode, true);
    assert.deepEqual(c.peIps, ['192.0.2.1', '192.0.2.2']);
    assert.equal(c.primaryIp, '192.0.2.1');
    assert.equal(c.account, 'pe');
    c = nc.resolveConfig({ NUTANIX_PC_IP: '192.0.2.9', NUTANIX_PE_IP: '192.0.2.1', NUTANIX_PC_ACCOUNT: 'pc' });
    assert.equal(c.isPeMode, false);
    assert.equal(c.primaryIp, '192.0.2.9');
    assert.equal(c.account, 'pc');
    c = nc.resolveConfig({ NUTANIX_MODE: 'PE' });
    assert.equal(c.isPeMode, true);
    assert.equal(c.primaryIp, '', 'PE mode without PE IP no longer throws');
});

test('listV3 follows offset until total_matches', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const client = fakeClient((m, p, body) => ({ entities: all.slice(body.offset, body.offset + body.length), metadata: { total_matches: 5 } }));
    const got = await nc.listV3(client, 'vm', { filter: 'cluster_name==A', pageSize: 2 });
    assert.deepEqual(got.map(e => e.id), [0, 1, 2, 3, 4]);
    assert.deepEqual(client.calls.map(c => [c[1], c[2].offset, c[2].filter]), [
        ['/v3/vms/list', 0, 'cluster_name==A'], ['/v3/vms/list', 2, 'cluster_name==A'], ['/v3/vms/list', 4, 'cluster_name==A'],
    ]);
});

test('listV2: single request when everything fits, extra pages only when metadata says so', async () => {
    let client = fakeClient(() => ({ entities: [{ uuid: 'a' }], metadata: { grand_total_entities: 1 } }));
    assert.equal((await nc.listV2(client, '/v2.0/vms', { params: { include_vm_disk_config: true } })).length, 1);
    assert.deepEqual(client.calls, [['get', '/v2.0/vms', { include_vm_disk_config: true }]]);

    const all = ['a', 'b', 'c', 'd', 'e'].map(uuid => ({ uuid }));
    client = fakeClient((m, p, opts) => {
        const { offset = 0, length = 2 } = (opts && opts.params) || {};
        return { entities: all.slice(offset, offset + length), metadata: { grand_total_entities: 5 } };
    });
    assert.deepEqual((await nc.listV2(client, '/v2.0/vms')).map(e => e.uuid), ['a', 'b', 'c', 'd', 'e']);

    // a server that ignores offset must not loop forever
    client = fakeClient(() => ({ entities: all.slice(0, 2), metadata: { grand_total_entities: 5 } }));
    assert.equal((await nc.listV2(client, '/v2.0/vms')).length, 2);
    assert.equal(client.calls.length, 2);
});

test('mapLimit keeps order and never exceeds the limit', async () => {
    let inFlight = 0, peak = 0;
    const out = await nc.mapLimit([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, n));
        inFlight--;
        return n * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30, 0, 60]);
    assert.equal(peak, 3);
    assert.deepEqual(await nc.mapLimit([], 5, async () => 1), []);
});

test('normalizeV2Vm: vCPU = sockets x cores, disks in MiB, NIC IPs, host name', () => {
    const vm = nc.normalizeV2Vm({
        uuid: 'u1', name: 'web01', power_state: 'on', num_vcpus: 2, num_cores_per_vcpu: 4, memory_mb: 8192, host_uuid: 'h1',
        vm_nics: [{ ip_address: '192.0.2.5' }],
        vm_disk_info: [{ size: 50 * 1024 * 1024 * 1024 }, { is_cdrom: true, size: 0 }],
    }, { clusterName: 'CL1', hostMap: { h1: 'node-a' } });
    const r = vm.status.resources;
    assert.equal(r.num_sockets * r.num_vcpus_per_socket, 8);
    assert.equal(r.memory_size_mib, 8192);
    assert.equal(r.power_state, 'ON');
    assert.deepEqual(r.disk_list.map(d => [d.disk_size_mib, d.device_properties.device_type]), [[51200, 'DISK'], [0, 'CDROM']]);
    assert.deepEqual(r.nic_list, [{ ip_endpoint_list: [{ ip: '192.0.2.5' }] }]);
    assert.equal(r.host_reference.name, 'node-a');
    assert.equal(vm.status.cluster_reference.name, 'CL1');
    // older field names still map
    const old = nc.normalizeV2Vm({ uuid: 'u2', name: 'x', ip_addresses: ['192.0.2.6'], disk_list: [{ disk_size_bytes: 1024 * 1024 * 10 }] }, { clusterName: 'CL1' });
    assert.equal(old.status.resources.disk_list[0].disk_size_mib, 10);
    assert.equal(old.status.resources.host_reference.name, 'N/A');
    assert.equal(old.status.resources.nic_list[0].ip_endpoint_list[0].ip, '192.0.2.6');
});

test('isCvm and errorMessage', () => {
    assert.equal(nc.isCvm('NTNX-abc-CVM'), true);
    assert.equal(nc.isCvm('app01'), false);
    assert.equal(nc.errorMessage({ message: 'x', response: { data: { message: 'from prism' } } }), 'from prism');
    assert.equal(nc.errorMessage(new Error('plain')), 'plain');
});
