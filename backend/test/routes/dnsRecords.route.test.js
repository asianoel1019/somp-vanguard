// DNS Hub record routes: a delete removes only the records named (a plain name: its A records only), the preview
// changes nothing, zone roots are refused, an add with several A records is left alone, and the change log keeps
// the old values. PowerShell is replaced by a recorder.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const powershell = require('../../lib/powershell');
const dnsDataStore = require('../../lib/dnsDataStore');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

const tok = (username, role) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['g'] })}`;
const op = tok('op1', 'Operator');
const viewer = tok('v1', 'Viewer');
const SERVICE_PWD = 'Dns(Svc)P@ss';
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { dnsHub: true } } },
    });
    process.env.AD_ADMIN_USER = 'CORP\\svc-dns';
    process.env.AD_ADMIN_PWD = SERVICE_PWD;
    await dnsDataStore.mutateDnsDb((doc) => {
        doc.servers = [
            { id: 's1', name: 'DNS-1', hostname: 'dns1.example.test', cachedDomains: ['example.test'] },
            { id: 's2', name: 'DNS-2', hostname: 'dns2.example.test', cachedDomains: ['lab.example.test'] },
        ];
    });
    app = express();
    app.use(express.json());
    app.use('/api/records', require('../../routes/records'));
});
test.after(async () => {
    delete process.env.AD_ADMIN_USER;
    delete process.env.AD_ADMIN_PWD;
    await dbManager.closeDB();
});

// Answers per call in order (a function gets the parsed batch)
function capturePs(t, ...answers) {
    const calls = [];
    t.mock.method(powershell, 'runPowerShell', async (script) => {
        const m = script.match(/\$batch = '((?:[^']|'')*)' \| ConvertFrom-Json/);
        const batch = m ? JSON.parse(m[1].replace(/''/g, "'")) : null;
        calls.push({ script, batch });
        const a = answers[calls.length - 1];
        if (a instanceof Error) throw a;
        return JSON.stringify(typeof a === 'function' ? a(batch) : a);
    });
    return calls;
}
const lastLogs = (n) => dnsDataStore.listDnsChanges().slice(0, n).map(e => e.action);

test('delete: a plain name asks for its A records only; exact records carry type and data', async (t) => {
    const calls = capturePs(t, (batch) => batch.map(it => ({ fqdn: it.fqdn, status: 'Deleted', removed: [{ type: it.type, data: it.data || '192.0.2.10' }] })));
    const r = await request(app).post('/api/records/delete').set('Authorization', op)
        .send({ records: ['app.example.test 192.0.2.10', { fqdn: 'mail.example.test', type: 'TXT', data: "it's v=spf1" }] }).expect(200);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].batch, [
        { fqdn: 'app.example.test', zone: 'example.test', host: 'app', type: 'A', data: null },
        { fqdn: 'mail.example.test', zone: 'example.test', host: 'mail', type: 'TXT', data: "it's v=spf1" },
    ]);
    const script = calls[0].script;
    assert.ok(script.includes('-RRType $item.type'), 'lookup limited to the record type');
    assert.ok(/Where-Object \{ \$null -eq \$item\.data -or/.test(script), 'only records with the given data');
    assert.ok(script.includes('Remove-DnsServerResourceRecord -ZoneName $item.zone -InputObject $t'), 'removes the matched records one by one');
    assert.ok(!/Get-DnsServerResourceRecord -ZoneName \$item\.zone -Name \$item\.host -CimSession[^\n]*\| Remove-/.test(script), 'never pipes every record of the name');
    assert.deepEqual(r.body.results.map(x => [x.record, x.status, x.detail]), [
        ['app.example.test', 'Deleted', 'A 192.0.2.10'],
        ['mail.example.test', 'Deleted', "TXT it's v=spf1"],
    ]);
    assert.deepEqual(lastLogs(2), ['Delete: app.example.test A 192.0.2.10 (Server: DNS-1)', "Delete: mail.example.test TXT it's v=spf1 (Server: DNS-1)"]);
});

test('delete refuses zone roots and NS / SOA records without calling PowerShell', async (t) => {
    const calls = capturePs(t);
    const r = await request(app).post('/api/records/delete').set('Authorization', op)
        .send({ records: ['example.test', { fqdn: 'x.example.test', type: 'NS', data: 'ns1.example.test' }] }).expect(200);
    assert.equal(calls.length, 0);
    assert.deepEqual(r.body.results.map(x => x.status), ['Error: Zone root records cannot be deleted here', 'Error: Record type NS cannot be deleted here']);
});

test('delete preview lists every record of each name per server and changes nothing', async (t) => {
    const calls = capturePs(t,
        [{ fqdn: 'app.example.test', status: 'Ready', records: [{ type: 'A', data: '192.0.2.10', ttl: 3600 }, { type: 'TXT', data: 'note', ttl: 300 }] },
            { fqdn: 'gone.example.test', status: 'Not found', records: [] }],
        [{ fqdn: 'pc.lab.example.test', status: 'Ready', records: { type: 'CNAME', data: 'app.example.test', ttl: 3600 } }]);
    const r = await request(app).post('/api/records/delete-preview').set('Authorization', op)
        .send({ records: ['app.example.test 192.0.2.10', 'gone.example.test', 'pc.lab.example.test', 'example.test'] }).expect(200);
    assert.equal(calls.length, 2);
    for (const c of calls) assert.ok(!/(Remove|Add|Set)-DnsServer/.test(c.script), 'read only');
    assert.deepEqual(calls[0].batch, [{ fqdn: 'app.example.test', zone: 'example.test', host: 'app' }, { fqdn: 'gone.example.test', zone: 'example.test', host: 'gone' }]);
    const by = Object.fromEntries(r.body.results.map(x => [x.fqdn, x]));
    assert.equal(by['example.test'].status, 'Error: Zone root records cannot be deleted here');
    assert.deepEqual(by['app.example.test'].records.map(x => `${x.type} ${x.data} ${x.deletable}`), ['A 192.0.2.10 true', 'TXT note true']);
    assert.equal(by['gone.example.test'].status, 'Not found');
    assert.deepEqual(by['pc.lab.example.test'].records, [{ type: 'CNAME', data: 'app.example.test', ttl: 3600, deletable: true }]);
    assert.equal(by['pc.lab.example.test'].serverName, 'DNS-2');
});

test('add: several A records are left alone, an update logs the old address, unchanged logs nothing', async (t) => {
    const calls = capturePs(t, [
        { fqdn: 'new.example.test', ip: '192.0.2.1', status: 'Added', oldIps: [] },
        { fqdn: 'web.example.test', ip: '192.0.2.2', status: 'Updated', oldIps: ['192.0.2.20'] },
        { fqdn: 'same.example.test', ip: '192.0.2.3', status: 'Unchanged', oldIps: ['192.0.2.3'] },
        { fqdn: 'rr.example.test', ip: '192.0.2.4', status: 'Multiple', oldIps: ['192.0.2.40', '192.0.2.41'] },
    ]);
    const before = dnsDataStore.listDnsChanges().length;
    const r = await request(app).post('/api/records/add').set('Authorization', op)
        .send({ records: ['new.example.test 192.0.2.1', 'web.example.test 192.0.2.2', 'same.example.test 192.0.2.3', 'rr.example.test 192.0.2.4'] }).expect(200);
    const script = calls[0].script;
    assert.ok(script.includes('$existing.Count -gt 1'), 'several A records are detected');
    assert.ok(script.includes('-OldInputObject $existing[0]'), 'a single record is updated in place');
    assert.deepEqual(r.body.results.map(x => x.status.slice(0, 40)), ['Success', 'Success', 'Success', 'Error: rr.example.test has 2 A records (']);
    assert.equal(r.body.results[1].detail, 'Updated 192.0.2.20 -> 192.0.2.2');
    assert.equal(dnsDataStore.listDnsChanges().length, before + 2);
    assert.deepEqual(lastLogs(2), ['Add: new.example.test -> 192.0.2.1 (Server: DNS-1)', 'Modify: web.example.test: 192.0.2.20 -> 192.0.2.2 (Server: DNS-1)']);
});

test('add rejects a bad address before PowerShell; a failed batch reports the reason without the credential', async (t) => {
    const calls = capturePs(t, Object.assign(new Error('x'), { stderr: 'WinRM cannot complete the operation. Verify the computer name.\nat line 3' }));
    const r = await request(app).post('/api/records/add').set('Authorization', op)
        .send({ records: [{ fqdn: 'bad.example.test', ip: '192.0.2.999' }, 'ok.example.test 192.0.2.5'] }).expect(200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].batch.map(x => x.fqdn), ['ok.example.test']);
    assert.equal(r.body.results[0].status, 'Error: Invalid IPv4 address 192.0.2.999');
    assert.equal(r.body.results[1].status, 'Error: WinRM cannot complete the operation. Verify the computer name.');
    assert.ok(!JSON.stringify(r.body).includes(SERVICE_PWD));
});

test('batch size is bounded and Viewers cannot change or preview', async (t) => {
    const calls = capturePs(t);
    await request(app).post('/api/records/delete').set('Authorization', op).send({ records: Array(501).fill('a.example.test') }).expect(400);
    await request(app).post('/api/records/add').set('Authorization', op).send({ records: [] }).expect(400);
    await request(app).post('/api/records/delete').set('Authorization', viewer).send({ records: ['a.example.test'] }).expect(403);
    await request(app).post('/api/records/delete-preview').set('Authorization', viewer).send({ records: ['a.example.test'] }).expect(403);
    assert.equal(calls.length, 0);
});
