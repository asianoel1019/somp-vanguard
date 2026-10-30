require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const { writeDataSync, readDataSync } = require('../../lib/db');
const store = require('../../services/inventoryStore');
const history = require('../../services/inventoryHistory');
const creds = require('../../lib/inventoryCredentials');
const { csvField, csvRow, BOM } = require('../../lib/csvExport');

const CONFIG_KEY = 'server_operation/oscheck/config.json';
const tok = (role, groups = ['inv']) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups })}`;
const admin = tok('SuperAdmin'), op = tok('Operator'), viewer = tok('Viewer'), noFeature = tok('Viewer', ['other']);
const bearer = (t) => ({ Authorization: t });
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { inv: { enabled: true, features: { inventory: true } }, other: { enabled: true, features: { serverList: true } } }
    });
    app = express();
    app.use(express.json());
    app.use('/api/inventory', require('../../routes/inventory'));
});
test.after(async () => { await dbManager.closeDB(); });

// --- CSV writer -----------------------------------------------------------------------------------

test('csv: every field quoted, quotes doubled, commas / newlines safe, formula injection prefixed', () => {
    assert.equal(csvField('a,b'), '"a,b"');
    assert.equal(csvField('say "hi"'), '"say ""hi"""');
    assert.equal(csvField('l1\nl2'), '"l1\nl2"');
    assert.equal(csvField(null), '""');
    assert.equal(csvField(4), '"4"');
    for (const bad of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) assert.equal(csvField(bad), `"'${bad}"`, bad);
    assert.equal(csvField('a=b'), '"a=b"');
    assert.equal(csvField("=HYPERLINK(\"x\")"), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvRow(['a', 'b']), '"a","b"\r\n');
    assert.equal(BOM, '﻿');
});

// --- export ---------------------------------------------------------------------------------------

test('export: Operator+ only, BOM, header, filters, escaping of hostile values', async () => {
    store.upsertScanResult('10.71.1.1', { status: 'online', hostname: '=cmd|calc', os: 'linux', osname: 'Ubuntu, "LTS"', mem: 8, cpu: 4, timezone: 'UTC', error: null });
    store.updateTags('10.71.1.1', ['a', 'b']);
    store.upsertScanResult('10.71.2.7', { status: 'online', hostname: 'win7', os: 'win', osname: 'Windows Server', mem: 16, cpu: 8 });
    store.upsertScanResult('10.71.1.2', { status: 'offline', hostname: 'down', os: 'linux', osname: 'CentOS', error: '@bad' });

    await request(app).get('/api/inventory/export?format=csv').expect(401);
    await request(app).get('/api/inventory/export?format=csv').set(bearer(noFeature)).expect(403);
    await request(app).get('/api/inventory/export?format=csv').set(bearer(viewer)).expect(403);

    const res = await request(app).get('/api/inventory/export?format=csv&subnet=10.71.1&status=online').set(bearer(op)).buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /attachment; filename="server-inventory-\d{8}\.csv"/);
    assert.equal(res.body[0], 0xEF); assert.equal(res.body[1], 0xBB); assert.equal(res.body[2], 0xBF);
    const text = res.body.toString('utf8').replace(/^﻿/, '');
    const lines = text.trim().split('\r\n');
    assert.equal(lines[0], '"ip","hostname","status","os","osVersion","cpu","memoryGB","timezone","subnet","tags","firstSeen","lastSeen","offlineSince","specsError"');
    assert.equal(lines.length, 2, 'filters: only the online host of 10.71.1');
    assert.ok(lines[1].startsWith('"10.71.1.1","\'=cmd|calc","online","Ubuntu, ""LTS""",'), lines[1]);
    assert.ok(lines[1].includes('"10.71.1","a, b"'));

    const q = await request(app).get('/api/inventory/export?q=win7').set(bearer(admin)).expect(200);
    assert.equal(q.text.trim().split('\r\n').length, 2);
    const o = await request(app).get('/api/inventory/export?status=offline&subnet=10.71.1').set(bearer(admin)).expect(200);
    assert.ok(o.text.includes('"\'@bad"'), 'specsError starting with @ is neutralised');
    // same predicates as the table: os category = exact value of hosts that are not offline; q also searches tags
    const lines2 = (r) => r.text.trim().split('\r\n').slice(1).filter(Boolean);
    const w = await request(app).get('/api/inventory/export?os=win').set(bearer(admin)).expect(200);
    assert.ok(lines2(w).every(l => l.includes('"online"')) && lines2(w).some(l => l.startsWith('"10.71.2.7"')));
    const lin = await request(app).get('/api/inventory/export?os=linux&subnet=10.71.1').set(bearer(admin)).expect(200);
    assert.equal(lines2(lin).length, 1, 'offline linux host is not in the Linux category');
    store.upsertScanResult('10.71.3.1', { status: 'online', hostname: 'Darwin1', os: 'mac', osname: 'Darwin' });
    store.updateTags('10.71.3.1', ['zzTag']);
    const unk = await request(app).get('/api/inventory/export?os=unknown&subnet=10.71.3').set(bearer(admin)).expect(200);
    assert.equal(lines2(unk).length, 1);
    const win2 = await request(app).get('/api/inventory/export?os=win&subnet=10.71.3').set(bearer(admin)).expect(200);
    assert.equal(lines2(win2).length, 0, 'Darwin is not "win"');
    const tag = await request(app).get('/api/inventory/export?q=zztag').set(bearer(admin)).expect(200);
    assert.equal(lines2(tag).length, 1);
    await request(app).get('/api/inventory/export?format=xlsx').set(bearer(op)).expect(400);
    await request(app).get('/api/inventory/export?status=bogus').set(bearer(op)).expect(400);
    await request(app).get('/api/inventory/export?os=centos').set(bearer(op)).expect(400);
    await request(app).get('/api/inventory/export?subnet=10.1.1;calc').set(bearer(op)).expect(400);
});

// --- history API ---------------------------------------------------------------------------------

test('history API: scans, changes of a scan, changes of a host, legacy fallback, validation', async () => {
    writeDataSync('server_operation/status_changes.json', [{ timestamp: '2026-01-01T00:00:00.000Z', ip: '10.1.1.1', hostname: 'old', from: 'online', to: 'offline' }]);
    const id = history.startScan({ trigger: 'manual', requestedBy: 'amy', scope: { ip: '10.72.1.1' }, subnets: ['10.72.1:1~1'] });
    history.recordChanges(id, [{ ip: '10.72.1.1', field: 'hostname', oldValue: 'a', newValue: 'b' }, { ip: '10.72.1.1', field: 'status', oldValue: 'offline', newValue: 'online' }]);
    history.finishScan(id, { durationMs: 1200, ipsChecked: 1, online: 1 });

    await request(app).get('/api/inventory/history').expect(401);
    await request(app).get('/api/inventory/history').set(bearer(noFeature)).expect(403);
    for (const t of [viewer, op, admin]) await request(app).get('/api/inventory/history').set(bearer(t)).expect(200);

    const list = await request(app).get('/api/inventory/history?limit=1').set(bearer(viewer)).expect(200);
    assert.equal(list.body.scans[0].id, id);
    assert.equal(list.body.scans[0].requestedBy, 'amy');
    assert.deepEqual(list.body.scans[0].scope, { ip: '10.72.1.1' });
    assert.equal(list.body.legacyStatusChanges[0].hostname, 'old');
    const older = await request(app).get(`/api/inventory/history?limit=5&before=${id}`).set(bearer(viewer)).expect(200);
    assert.equal(older.body.legacyStatusChanges, undefined, 'legacy entries only on the first page');
    assert.ok(older.body.scans.every(s => s.id < id));

    const ch = await request(app).get(`/api/inventory/history/${id}/changes?limit=1&offset=1`).set(bearer(viewer)).expect(200);
    assert.equal(ch.body.total, 2);
    assert.equal(ch.body.changes.length, 1);
    assert.equal(ch.body.scan.id, id);
    await request(app).get('/api/inventory/history/999999/changes').set(bearer(viewer)).expect(404);
    await request(app).get('/api/inventory/history/abc/changes').set(bearer(viewer)).expect(400);

    const host = await request(app).get('/api/inventory/hosts/10.72.1.1/changes').set(bearer(viewer)).expect(200);
    assert.equal(host.body.total, 2);
    assert.equal(host.body.changes[0].ip, '10.72.1.1');
    await request(app).get('/api/inventory/hosts/10.72.1.999/changes').set(bearer(viewer)).expect(400);
});

// --- credential profiles --------------------------------------------------------------------------

test('credential profiles API: SuperAdmin only, passwords never returned or stored in clear, in-use profile refused', async () => {
    for (const tkn of [viewer, op]) {
        await request(app).get('/api/inventory/credential-profiles').set(bearer(tkn)).expect(403);
        await request(app).put('/api/inventory/credential-profiles/P1').set(bearer(tkn)).send({ winUser: 'u', winPassword: 'p' }).expect(403);
        await request(app).delete('/api/inventory/credential-profiles/P1').set(bearer(tkn)).expect(403);
    }
    await request(app).put('/api/inventory/credential-profiles/bad%2Fname').set(bearer(admin)).send({ winUser: 'u' }).expect(400);
    await request(app).put('/api/inventory/credential-profiles/P1').set(bearer(admin)).send({ winUser: 'u', winPassword: 123 }).expect(400);

    const put = await request(app).put('/api/inventory/credential-profiles/P1').set(bearer(admin)).send({ winUser: 'DOM\\svc', winPassword: 'TopSecret1', linuxUser: 'root', linuxPassword: 'RootSecret2' }).expect(200);
    assert.equal(put.body.created, true);
    assert.equal(JSON.stringify(put.body).includes('TopSecret1'), false);
    const list = await request(app).get('/api/inventory/credential-profiles').set(bearer(admin)).expect(200);
    assert.deepEqual(list.body.profiles.map(p => ({ name: p.name, w: p.hasWinPassword, l: p.hasLinuxPassword, wu: p.winUser })), [{ name: 'P1', w: true, l: true, wu: 'DOM\\svc' }]);
    const text = JSON.stringify(list.body);
    assert.ok(!text.includes('TopSecret1') && !text.includes('RootSecret2') && !/enc:/.test(text) && !/Password"/.test(text.replace(/hasWinPassword|hasLinuxPassword/g, '')));
    const raw = JSON.stringify(readDataSync(creds.PROFILES_KEY, {}));
    assert.ok(raw.includes('enc:') && !raw.includes('TopSecret1'));

    // referenced by a subnet: config rejects unknown profiles; delete refuses a used one
    const bad = await request(app).post('/api/inventory/config').set(bearer(admin)).send({ subnetSettings: { '10.1.2': { credentialProfile: 'Nope' } } });
    assert.equal(bad.status, 400);
    // I-2: an Operator can not assign / change / remove a credential profile of a subnet
    const opAssign = await request(app).post('/api/inventory/config').set(bearer(op)).send({ subnetSettings: { '10.1.2': { credentialProfile: 'P1' } } });
    assert.equal(opAssign.status, 403);
    const ok = await request(app).post('/api/inventory/config').set(bearer(admin)).send({ subnets: ['10.1.2'], subnetSettings: { '10.1.2': { credentialProfile: 'P1', concurrency: 4 } } });
    assert.equal(ok.status, 200);
    const del = await request(app).delete('/api/inventory/credential-profiles/P1').set(bearer(admin));
    assert.equal(del.status, 409);
    assert.equal(del.body.code, 'PROFILE_IN_USE');
    assert.deepEqual(del.body.subnets, ['10.1.2']);

    await request(app).post('/api/inventory/config').set(bearer(op)).send({ subnetSettings: {} }).expect(403);
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ subnetSettings: { '10.1.2': { credentialProfile: 'Other' } } }).expect(403);
    // an unchanged profile with other changes by an Operator is fine
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ subnetSettings: { '10.1.2': { credentialProfile: 'P1', concurrency: 8 } } }).expect(200);
    await request(app).post('/api/inventory/config').set(bearer(admin)).send({ subnetSettings: {} }).expect(200);
    await request(app).delete('/api/inventory/credential-profiles/P1').set(bearer(admin)).expect(200);
    await request(app).delete('/api/inventory/credential-profiles/P1').set(bearer(admin)).expect(404);
});

// --- config ---------------------------------------------------------------------------------------

test('config API: subnetSettings / newHostAlerts / historyRetentionDays saved; GET merges legacy subnetOffsets and defaults', async () => {
    writeDataSync(CONFIG_KEY, { subnets: [], timezoneCheck: { subnetOffsets: [{ subnet: '10.5.5.*', targetOffset: '9' }] } });
    const get = await request(app).get('/api/inventory/config').set(bearer(viewer)).expect(200);
    assert.deepEqual(get.body.subnetSettings, {}, 'stored map as is, legacy offsets are not merged in');
    assert.deepEqual(get.body.timezoneCheck.subnetOffsets, [{ subnet: '10.5.5.*', targetOffset: '9' }]);
    assert.equal(get.body.newHostAlerts, true);
    assert.equal(get.body.historyRetentionDays, 180);

    await request(app).post('/api/inventory/config').set(bearer(op)).send({ historyRetentionDays: 10 }).expect(400);
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ subnetSettings: { '10.1.2': { concurrency: 999 } } }).expect(400);
    await request(app).post('/api/inventory/config').set(bearer(op)).send({ newHostAlerts: false, historyRetentionDays: 365, subnetSettings: { '10.1.2:1~50': { concurrency: 8, tcpPorts: [22, 443], autoSyncPrometheus: false, timezoneOffset: 8 } } }).expect(200);
    const saved = readDataSync(CONFIG_KEY, {});
    assert.equal(saved.newHostAlerts, false);
    assert.equal(saved.historyRetentionDays, 365);
    assert.deepEqual(saved.subnetSettings, { '10.1.2:1~50': { concurrency: 8, tcpPorts: [22, 443], autoSyncPrometheus: false, timezoneOffset: 8 } });
    assert.deepEqual(saved.timezoneCheck.subnetOffsets, [{ subnet: '10.5.5.*', targetOffset: '9' }], 'legacy subnetOffsets untouched');
});

test('deploy-agent refuses an undecryptable credential profile; non-SuperAdmin profile change names the subnet', async () => {
    writeDataSync(creds.PROFILES_KEY, { Broken: { winUser: 'u', winPassword_enc: 'enc:00:11:22', linuxUser: 'dmz', linuxPassword_enc: 'enc:00:11:22' } });
    writeDataSync(CONFIG_KEY, { subnets: ['10.200.1'], subnetSettings: { '10.200.1': { credentialProfile: 'Broken' } } });
    for (const os of ['win', 'linux']) {
        const r = await request(app).post('/api/inventory/deploy-agent').set(bearer(op)).send({ ip: '10.200.1.5', os });
        assert.equal(r.status, 409, os);
        assert.match(r.body.error, /cannot be decrypted/);
    }
    const r2 = await request(app).post('/api/inventory/config').set(bearer(op)).send({ subnetSettings: {} });
    assert.equal(r2.status, 403);
    assert.match(r2.body.error, /10.200.1/);
    assert.match(r2.body.error, /only a SuperAdmin can change credential profiles/);
    writeDataSync(creds.PROFILES_KEY, {});
    writeDataSync(CONFIG_KEY, { subnets: [] });
});
