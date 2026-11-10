// DNS Hub record helpers: reading input lines, finding the server and zone of a name, what a delete may remove,
// and the result rows / change-log lines built from the PowerShell answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../../lib/dnsRecords');

const servers = [
    { id: 's1', name: 'DNS-1', cachedDomains: ['example.test', 'corp.example.test'] },
    { id: 's2', name: 'DNS-2', cachedDomains: ['lab.example.test'] },
    { id: 's3', name: 'DNS-OFF', disabled: true, cachedDomains: ['off.example.test'] },
];

test('input lines: every supported separator and the hosts-file order', () => {
    const want = { fqdn: 'app.example.test', ip: '192.0.2.10' };
    for (const line of ['app.example.test 192.0.2.10', 'app.example.test\t192.0.2.10', 'app.example.test - 192.0.2.10',
        'app.example.test / 192.0.2.10', 'app.example.test, 192.0.2.10', 'app.example.test | 192.0.2.10',
        'app.example.test -> 192.0.2.10', '192.0.2.10 app.example.test', '  app.example.test   192.0.2.10  ']) {
        assert.deepEqual(d.parseDnsRecordLine(line), want, line);
    }
    assert.deepEqual(d.parseDnsRecordLine('app.example.test'), { fqdn: 'app.example.test', ip: null });
    assert.equal(d.parseDnsRecordLine('   '), null);
    assert.equal(d.parseDnsRecordLine(null), null);
});

test('zone of a name: longest zone wins, dot boundary, root as @, trailing dot', () => {
    assert.deepEqual(d.parseFqdn('web.corp.example.test', servers[0].cachedDomains), { host: 'web', zone: 'corp.example.test' });
    assert.deepEqual(d.parseFqdn('a.b.example.test', servers[0].cachedDomains), { host: 'a.b', zone: 'example.test' });
    assert.deepEqual(d.parseFqdn('Web.Example.Test.', servers[0].cachedDomains), { host: 'Web', zone: 'example.test' });
    assert.deepEqual(d.parseFqdn('example.test', servers[0].cachedDomains), { host: '@', zone: 'example.test' });
    assert.equal(d.parseFqdn('badexample.test', servers[0].cachedDomains), null);
    assert.equal(d.parseFqdn('x.example.test', []), null);
});

test('server of a name: the most specific zone over all enabled servers', () => {
    assert.equal(d.findTargetServer('pc.lab.example.test', servers).server.id, 's2');
    assert.equal(d.findTargetServer('pc.example.test', servers).server.id, 's1');
    assert.equal(d.findTargetServer('pc.off.example.test', servers).server.id, 's1', 'disabled server skipped, parent zone used');
    assert.deepEqual(d.findTargetServer('pc.other.test', servers), { server: null, parsed: null });
});

test('delete grouping: plain names remove A records only, exact records keep type and data', () => {
    const { groups, rejected } = d.groupByServer([
        'app.example.test 192.0.2.10',
        { fqdn: 'mail.example.test', type: 'txt', data: 'v=spf1 -all' },
        { fqdn: 'pc.lab.example.test', type: 'CNAME', data: 'app.example.test' },
    ], servers);
    assert.deepEqual(rejected, []);
    assert.deepEqual(groups.get('s1').items, [
        { fqdn: 'app.example.test', zone: 'example.test', host: 'app', type: 'A', data: null },
        { fqdn: 'mail.example.test', zone: 'example.test', host: 'mail', type: 'TXT', data: 'v=spf1 -all' },
    ]);
    assert.deepEqual(groups.get('s2').items, [{ fqdn: 'pc.lab.example.test', zone: 'lab.example.test', host: 'pc', type: 'CNAME', data: 'app.example.test' }]);
});

test('delete grouping refuses zone roots, zone plumbing types, empty data and unknown zones', () => {
    const { groups, rejected } = d.groupByServer([
        'example.test',
        { fqdn: 'x.example.test', type: 'NS', data: 'ns1.example.test' },
        { fqdn: 'x.example.test', type: 'SOA', data: 'x' },
        { fqdn: 'x.example.test', type: 'A', data: '' },
        'pc.other.test',
        '',
    ], servers);
    assert.equal(groups.size, 0);
    assert.deepEqual(rejected.map(r => r.status), [
        'Error: Zone root records cannot be deleted here',
        'Error: Record type NS cannot be deleted here',
        'Error: Record type SOA cannot be deleted here',
        'Error: Record data is required',
        'Failed: Zone not found in any cache',
        'Error: Invalid format',
    ]);
});

test('add outcome: added / updated with the old address / unchanged / several A records / error', () => {
    assert.deepEqual(d.addOutcome({ fqdn: 'a.example.test', ip: '192.0.2.1', status: 'Added', oldIps: [] }, 'DNS-1'),
        { record: 'a.example.test', serverName: 'DNS-1', status: 'Success', detail: 'Added 192.0.2.1', log: 'Add: a.example.test -> 192.0.2.1 (Server: DNS-1)' });
    const upd = d.addOutcome({ fqdn: 'a.example.test', ip: '192.0.2.2', status: 'Updated', oldIps: '192.0.2.1' }, 'DNS-1');
    assert.equal(upd.status, 'Success');
    assert.equal(upd.log, 'Modify: a.example.test: 192.0.2.1 -> 192.0.2.2 (Server: DNS-1)');
    assert.equal(d.addOutcome({ fqdn: 'a', ip: '192.0.2.1', status: 'Unchanged', oldIps: ['192.0.2.1'] }, 'DNS-1').log, null);
    const multi = d.addOutcome({ fqdn: 'rr.example.test', ip: '192.0.2.9', status: 'Multiple', oldIps: ['192.0.2.1', '192.0.2.2'] }, 'DNS-1');
    assert.match(multi.status, /^Error: rr\.example\.test has 2 A records \(192\.0\.2\.1, 192\.0\.2\.2\)/);
    assert.equal(multi.log, null);
    assert.deepEqual(d.addOutcome({ fqdn: 'a', status: 'Error: Access denied' }, 'DNS-1').status, 'Error: Access denied');
});

test('delete outcome logs every removed record with its type and data, also on a partial failure', () => {
    const ok = d.deleteOutcome({ fqdn: 'app.example.test', status: 'Deleted', removed: [{ type: 'A', data: '192.0.2.10' }, { type: 'A', data: '192.0.2.11' }] }, 'DNS-1');
    assert.equal(ok.status, 'Deleted');
    assert.equal(ok.detail, 'A 192.0.2.10, A 192.0.2.11');
    assert.deepEqual(ok.logs, ['Delete: app.example.test A 192.0.2.10 (Server: DNS-1)', 'Delete: app.example.test A 192.0.2.11 (Server: DNS-1)']);
    const single = d.deleteOutcome({ fqdn: 'x', status: 'Deleted', removed: { type: 'TXT', data: 'hello' } }, 'DNS-1');
    assert.deepEqual(single.logs, ['Delete: x TXT hello (Server: DNS-1)']);
    const part = d.deleteOutcome({ fqdn: 'x', status: 'Partly deleted: boom', removed: [{ type: 'A', data: '192.0.2.1' }] }, 'DNS-1');
    assert.equal(part.logs.length, 1);
    assert.deepEqual(d.deleteOutcome({ fqdn: 'x', status: 'Not found', removed: [] }, 'DNS-1').logs, []);
});

test('lookup records are marked deletable by type', () => {
    assert.deepEqual(d.lookupRecords([{ type: 'A', data: '192.0.2.1', ttl: 3600 }, { type: 'NS', data: 'ns.example.test', ttl: 3600 }]), [
        { type: 'A', data: '192.0.2.1', ttl: 3600, deletable: true },
        { type: 'NS', data: 'ns.example.test', ttl: 3600, deletable: false },
    ]);
    assert.deepEqual(d.lookupRecords(null), []);
});
