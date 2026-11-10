// GPMC-style read-only views: ids are validated, nothing writes to AD, the settings report is Operator+ and
// carries no script.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const powershell = require('../../lib/powershell');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

const tok = (username, role) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['g'] })}`;
const op = tok('op1', 'Operator');
const viewer = tok('v1', 'Viewer');
const GUID = '31B2F340-016D-11D2-945F-00C04FB984F9';
const WRITE_CMDLETS = /\b(Set|New|Remove|Rename|Copy|Restore|Import|Backup)-(GP|AD)\w*/;
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { adControl: true } } },
    });
    app = express();
    app.use(express.json());
    app.use('/api/gpo', require('../../routes/gpo'));
    process.env.AD_ADMIN_USER = 'CORP\\svc-vanguard';
    process.env.AD_ADMIN_PWD = 'S3cret-test';
    process.env.AD_DC_HOST = 'dc01.example.test';
});
test.after(async () => {
    for (const k of ['AD_ADMIN_USER', 'AD_ADMIN_PWD', 'AD_DC_HOST']) delete process.env[k];
    await dbManager.closeDB();
});

function capturePs(t, output) {
    const calls = [];
    t.mock.method(powershell, 'runPowerShell', async (script) => { calls.push(script); return output; });
    return calls;
}

test('tree: shaped from the DC answer; read-only script with a bounded OU count', async (t) => {
    const calls = capturePs(t, JSON.stringify({
        domain: { dn: 'DC=example,DC=test', dns: 'example.test', gPLink: `[LDAP://cn={${GUID}},cn=policies,cn=system,DC=example,DC=test;2]`, gPOptions: '' },
        ous: [{ dn: 'OU=Workstations,DC=example,DC=test', name: 'Workstations', gPLink: '', gPOptions: '1' }],
        gpos: [{ id: GUID, name: 'Default Domain Policy', status: 'AllSettingsEnabled', wmi: '', created: '2026-01-01T00:00:00', modified: '2026-01-02T00:00:00' }],
    }));
    const r = await request(app).get('/api/gpo/tree').set('Authorization', viewer).expect(200);
    assert.equal(r.body.domain.links[0].enforced, true);
    assert.equal(r.body.ous[0].blockInheritance, true);
    assert.equal(r.body.gpos[0].id, GUID.toLowerCase());
    assert.equal(r.body.truncated, false);
    assert.ok(calls[0].includes("-ArgumentList '2000'"));
    assert.doesNotMatch(calls[0], WRITE_CMDLETS);
    assert.ok(!calls[0].includes('S3cret-test'), 'password only through the environment');
});

test('detail: guid validated; permissions always a list; read-only', async (t) => {
    const calls = capturePs(t, JSON.stringify({ id: `{${GUID}}`, name: 'P', permissions: { trustee: 'Authenticated Users', permission: 'GpoApply' } }));
    await request(app).get('/api/gpo/detail').query({ guid: "x'; calc" }).set('Authorization', viewer).expect(400);
    assert.equal(calls.length, 0);
    const r = await request(app).get('/api/gpo/detail').query({ guid: GUID }).set('Authorization', viewer).expect(200);
    assert.equal(r.body.id, GUID.toLowerCase());
    assert.equal(r.body.permissions.length, 1);
    assert.ok(calls[0].includes(`-ArgumentList '${GUID}'`));
    assert.doesNotMatch(calls[0], WRITE_CMDLETS);
});

test('report: Operator+ only, scripts removed', async (t) => {
    const calls = capturePs(t, '<html><body><script>alert(1)</script><h1>Settings</h1><SCRIPT src="x"></SCRIPT ></body></html>');
    await request(app).get('/api/gpo/report').query({ guid: GUID }).set('Authorization', viewer).expect(403);
    await request(app).get('/api/gpo/report').query({ guid: 'nope' }).set('Authorization', op).expect(400);
    const r = await request(app).get('/api/gpo/report').query({ guid: GUID }).set('Authorization', op).expect(200);
    assert.equal(r.body.html, '<html><body><h1>Settings</h1></body></html>');
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], WRITE_CMDLETS);
});

test('wmi-filters: queries parsed; one filter still comes back as a list', async (t) => {
    const q = 'SELECT * FROM Win32_OperatingSystem';
    const calls = capturePs(t, JSON.stringify({ id: '{AB}', name: 'Win11', description: 'd', parm2: `1;3;10;${q.length};WQL;root\\CIMv2;${q};`, modified: 'm' }));
    const r = await request(app).get('/api/gpo/wmi-filters').set('Authorization', viewer).expect(200);
    assert.equal(r.body.filters.length, 1);
    assert.equal(r.body.filters[0].queries[0].query, q);
    assert.doesNotMatch(calls[0], WRITE_CMDLETS);
});
