// AD Control OU tree mode, reports, batch actions, exact last logon and user details: inputs checked before
// PowerShell, values only as literals, batch results per account, audit lines name the acting user.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const powershell = require('../../lib/powershell');
const logger = require('../../lib/logger');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

const tok = (username, role) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['g'] })}`;
const op = tok('op1', 'Operator');
const viewer = tok('v1', 'Viewer');
const WRITE = /\b(Set|New|Remove|Enable|Disable|Unlock|Add)-AD\w*/;
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { adControl: true } } },
    });
    app = express();
    app.use(express.json());
    app.use('/api/ad', require('../../routes/ad'));
    process.env.AD_ADMIN_USER = 'CORP\\svc-vanguard';
    process.env.AD_ADMIN_PWD = 'S3cret-test';
    process.env.AD_DC_HOST = 'dc01.example.test';
});
test.after(async () => {
    for (const k of ['AD_ADMIN_USER', 'AD_ADMIN_PWD', 'AD_DC_HOST', 'AD_OU_SEARCH']) delete process.env[k];
    await dbManager.closeDB();
});

function capturePs(t, output = '') {
    const calls = [];
    t.mock.method(powershell, 'runPowerShell', async (script) => { calls.push(script); return typeof output === 'function' ? output(script) : output; });
    return calls;
}
const logLength = () => (fs.existsSync(logger.getTodayLogFile()) ? fs.readFileSync(logger.getTodayLogFile(), 'utf8').length : 0);
const auditSince = (before) => fs.readFileSync(logger.getTodayLogFile(), 'utf8').slice(before);

test('ou-tree: read-only, OUs bounded, System hidden', async (t) => {
    const calls = capturePs(t, JSON.stringify({ dn: 'DC=example,DC=test', name: 'example.test', ous: [{ dn: 'OU=A,DC=example,DC=test', name: 'A' }], containers: [] }));
    const r = await request(app).get('/api/ad/ou-tree').set('Authorization', viewer).expect(200);
    assert.equal(r.body.nodes[0].parentDn, 'DC=example,DC=test');
    assert.match(calls[0], /-ResultSetSize 2001/);
    assert.match(calls[0], /\$hidden = @\('System', 'Program Data'\)/);
    assert.doesNotMatch(calls[0], WRITE);
});

test('ou-objects: DN and type checked; one level only; split by kind', async (t) => {
    const calls = capturePs(t, JSON.stringify([
        { kind: 'user', Name: 'Bob', SamAccountName: 'bob' },
        { kind: 'computer', Name: 'PC1', SamAccountName: 'PC1$' },
        { kind: 'user', Name: 'Alice', SamAccountName: 'alice' },
    ]));
    await request(app).get('/api/ad/ou-objects').query({ dn: "OU=x'; calc" }).set('Authorization', viewer).expect(400);
    await request(app).get('/api/ad/ou-objects').query({ dn: 'OU=A,DC=example,DC=test', type: 'printer' }).set('Authorization', viewer).expect(400);
    assert.equal(calls.length, 0);
    const dn = "OU=O'Brien,DC=example,DC=test";
    const r = await request(app).get('/api/ad/ou-objects').query({ dn }).set('Authorization', viewer).expect(200);
    assert.deepEqual(r.body.users.map(u => u.Name), ['Alice', 'Bob']);
    assert.equal(r.body.computers.length, 1);
    assert.ok(calls[0].includes("$base = 'OU=O''Brien,DC=example,DC=test'"));
    assert.match(calls[0], /-SearchScope OneLevel/);
    assert.doesNotMatch(calls[0], WRITE);
    await request(app).get('/api/ad/ou-objects').query({ dn, type: 'group' }).set('Authorization', viewer).expect(200);
    assert.match(calls[1], /Get-ADGroup/);
    assert.doesNotMatch(calls[1], /Get-ADUser|Get-ADComputer/);
});

test('report: type and days checked; search base honoured; expiring list sorted by date', async (t) => {
    process.env.AD_OU_SEARCH = 'OU=Staff,DC=example,DC=test';
    const calls = capturePs(t, JSON.stringify([
        { SamAccountName: 'b', PasswordExpires: '2026-12-01T00:00:00.0000000Z' },
        { SamAccountName: 'a', PasswordExpires: '2026-11-20T00:00:00.0000000Z' },
    ]));
    await request(app).get('/api/ad/report').query({ type: 'everything' }).set('Authorization', viewer).expect(400);
    await request(app).get('/api/ad/report').query({ type: 'inactive', days: '0' }).set('Authorization', viewer).expect(400);
    await request(app).get('/api/ad/report').query({ type: 'inactive', days: '9; calc' }).set('Authorization', viewer).expect(400);
    assert.equal(calls.length, 0);
    const r = await request(app).get('/api/ad/report').query({ type: 'pwdExpiring' }).set('Authorization', viewer).expect(200);
    assert.equal(r.body.days, 14);
    assert.deepEqual(r.body.rows.map(x => x.SamAccountName), ['a', 'b']);
    assert.ok(calls[0].includes("-SearchBase 'OU=Staff,DC=example,DC=test'"));
    await request(app).get('/api/ad/report').query({ type: 'inactive' }).set('Authorization', viewer).expect(200);
    assert.match(calls[1], /Search-ADAccount -AccountInactive -TimeSpan \(New-TimeSpan -Days 90\) -UsersOnly/);
    await request(app).get('/api/ad/report').query({ type: 'locked' }).set('Authorization', viewer).expect(200);
    for (const c of calls) assert.doesNotMatch(c, WRITE);
    delete process.env.AD_OU_SEARCH;
});

test('batch-action: Operator+, at most 100 valid names, one result and one audit line per account', async (t) => {
    const calls = capturePs(t, JSON.stringify([
        { sam: 'alice', ok: true, error: '' },
        { sam: "o'brien", ok: false, error: 'Cannot find an object with identity S3cret-test' },
    ]));
    await request(app).post('/api/ad/batch-action').set('Authorization', viewer).send({ action: 'unlock', sams: ['alice'] }).expect(403);
    await request(app).post('/api/ad/batch-action').set('Authorization', op).send({ action: 'reset_password', sams: ['alice'] }).expect(400);
    await request(app).post('/api/ad/batch-action').set('Authorization', op).send({ action: 'unlock', sams: [] }).expect(400);
    await request(app).post('/api/ad/batch-action').set('Authorization', op).send({ action: 'unlock', sams: ['a"b'] }).expect(400);
    await request(app).post('/api/ad/batch-action').set('Authorization', op).send({ action: 'unlock', sams: Array.from({ length: 101 }, (_, i) => `u${i}`) }).expect(400);
    assert.equal(calls.length, 0);
    const before = logLength();
    const r = await request(app).post('/api/ad/batch-action').set('Authorization', op).send({ action: 'disable', sams: ['alice', "o'brien", 'alice', 'ghost'] }).expect(200);
    assert.deepEqual(r.body.results.map(x => [x.sam, x.ok]), [['alice', true], ["o'brien", false], ['ghost', false]]);
    assert.equal(r.body.succeeded, 1);
    assert.doesNotMatch(r.body.results[1].error, /S3cret-test/, 'secrets never reach the page');
    assert.ok(calls[0].includes("$sams = @('alice', 'o''brien', 'ghost')"));
    assert.match(calls[0], /\$t = Get-ManagedUser \$s\s+Disable-ADAccount -Identity \$t/);
    const audit = auditSince(before);
    assert.match(audit, /User: op1 \| Module: AD User Control \| Action: Disabled AD Account: alice \(batch, via service account svc-vanguard\)/);
    assert.doesNotMatch(audit, /Disabled AD Account: o'brien/);
});

test('guard: protected / out-of-scope accounts are refused on the DC, scopes reach it as literals', async (t) => {
    process.env.AD_MANAGE_OUS = "OU=Staff,DC=example,DC=test;OU=O'Brien\\;s Team,DC=example,DC=test";
    try {
        const refusal = 'Get-ManagedUser : PROTECTED_ACCOUNT: admin1 is a protected account (administrators, krbtgt or the service account) and cannot be changed here\nAt line:20 char:5';
        let calls = capturePs(t, () => { const e = new Error('PowerShell failed'); e.stderr = refusal; throw e; });
        const single = await request(app).post('/api/ad/action').set('Authorization', op).send({ sam: 'admin1', action: 'reset_password' }).expect(403);
        assert.equal(single.body.error, 'admin1 is a protected account (administrators, krbtgt or the service account) and cannot be changed here');
        assert.equal(single.body.password, undefined);
        assert.ok(calls[0].includes("$guardScopes = @('OU=Staff,DC=example,DC=test', 'OU=O''Brien\\;s Team,DC=example,DC=test')"));
        assert.ok(calls[0].includes("$guardService = 'svc-vanguard'"));
        assert.ok(calls[0].indexOf('$target = Get-ManagedUser') < calls[0].indexOf('Set-ADAccountPassword'), 'checked before the change');
        t.mock.restoreAll();

        calls = capturePs(t, JSON.stringify([
            { sam: 'bob', ok: true, error: '' },
            { sam: 'svc-vanguard', ok: false, error: 'PROTECTED_ACCOUNT: svc-vanguard is a protected account (administrators, krbtgt or the service account) and cannot be changed here' },
            { sam: 'eve', ok: false, error: 'OUTSIDE_MANAGED_OUS: eve is outside the OUs AD Control manages' },
        ]));
        const r = await request(app).post('/api/ad/batch-action').set('Authorization', op).send({ action: 'disable', sams: ['bob', 'svc-vanguard', 'eve'] }).expect(200);
        assert.deepEqual(r.body.results.map(x => [x.sam, x.ok, !!x.refused]), [['bob', true, false], ['svc-vanguard', false, true], ['eve', false, true]]);
        assert.equal(r.body.results[2].error, 'eve is outside the OUs AD Control manages');
        t.mock.restoreAll();

        process.env.AD_MANAGE_OUS = 'OU=Staff,DC=example,DC=test;CN=Bad\nLine';
        calls = capturePs(t, '');
        const bad = await request(app).post('/api/ad/action').set('Authorization', op).send({ sam: 'bob', action: 'unlock' }).expect(503);
        assert.match(bad.body.error, /AD_MANAGE_OUS has an entry that is not an OU/);
        assert.equal(calls.length, 0, 'nothing runs with a broken scope setting');
    } finally {
        delete process.env.AD_MANAGE_OUS;
    }
});

test('last-logon: name checked, newest DC value returned', async (t) => {
    const calls = capturePs(t, JSON.stringify([
        { dc: 'dc01.example.test', lastLogon: '133801632000000000', error: '' },
        { dc: 'dc02.example.test', lastLogon: '', error: 'unreachable' },
    ]));
    await request(app).get('/api/ad/user/a%22b/last-logon').set('Authorization', viewer).expect(400);
    const r = await request(app).get('/api/ad/user/alice/last-logon').set('Authorization', viewer).expect(200);
    assert.deepEqual(r.body, { lastLogon: '2025-01-01T00:00:00.000Z', dc: 'dc01.example.test', checked: 1, failed: ['dc02.example.test'] });
    assert.match(calls[0], /Get-ADUser -Identity 'alice' -Properties lastLogon -Server \$d\.HostName/);
});

test('user details: group, primary group and manager names parsed from DNs', async (t) => {
    capturePs(t, JSON.stringify({
        Name: 'Alice', SamAccountName: 'alice',
        MemberOfDns: ['CN=Sales\\, East,OU=G,DC=example,DC=test', 'CN=Admins,DC=example,DC=test'],
        PrimaryGroupDn: 'CN=Domain Users,CN=Users,DC=example,DC=test',
        ManagerDn: 'CN=Doe\\, John,OU=Staff,DC=example,DC=test',
    }));
    const r = await request(app).get('/api/ad/user/alice').set('Authorization', viewer).expect(200);
    assert.deepEqual(r.body.userInfo.MemberOf, ['Admins', 'Sales, East']);
    assert.equal(r.body.userInfo.PrimaryGroup, 'Domain Users');
    assert.equal(r.body.userInfo.Manager, 'Doe, John');
    assert.equal(r.body.userInfo.MemberOfDns, undefined);
});
