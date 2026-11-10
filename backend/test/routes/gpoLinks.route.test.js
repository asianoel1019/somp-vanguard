// GPO link management: Operator+ only, ids / targets / options validated before PowerShell, values only as
// literals, audit lines name the acting user.
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
const GUID = '31B2F340-016D-11D2-945F-00C04FB984F9';
const OU = 'OU=Kiosk,OU=Workstations,DC=example,DC=test';
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

function capturePs(t) {
    const calls = [];
    t.mock.method(powershell, 'runPowerShell', async (script) => { calls.push(script); return ''; });
    return calls;
}
const auditSince = (before) => fs.readFileSync(logger.getTodayLogFile(), 'utf8').slice(before);
const logLength = () => (fs.existsSync(logger.getTodayLogFile()) ? fs.readFileSync(logger.getTodayLogFile(), 'utf8').length : 0);

test('every link action is Operator+ and checks the GPO id and target first', async (t) => {
    const calls = capturePs(t);
    for (const path of ['/link', '/link/delete', '/link/set', '/inheritance']) {
        await request(app).post(`/api/gpo${path}`).set('Authorization', viewer).send({ guid: GUID, target: OU, blocked: true, enforced: true }).expect(403);
        await request(app).post(`/api/gpo${path}`).set('Authorization', op).send({ guid: GUID, target: "OU=x'; calc", blocked: true, enforced: true }).expect(400);
        await request(app).post(`/api/gpo${path}`).set('Authorization', op).send({ guid: GUID, target: 'CN=Users,DC=example,DC=test', blocked: true, enforced: true }).expect(400);
    }
    await request(app).post('/api/gpo/link').set('Authorization', op).send({ guid: 'bad', target: OU }).expect(400);
    assert.equal(calls.length, 0);
});

test('link: New-GPLink with literal arguments, target class checked on the DC, audited', async (t) => {
    const calls = capturePs(t);
    const before = logLength();
    const target = "OU=O'Brien\\, Ops,DC=example,DC=test";
    await request(app).post('/api/gpo/link').set('Authorization', op).send({ guid: GUID, target, name: 'Baseline\nfake line' }).expect(200);
    assert.match(calls[0], /New-GPLink -Guid \$gId -Target \$t -LinkEnabled Yes/);
    assert.match(calls[0], /notcontains \[string\]\$o\.ObjectClass/);
    assert.ok(calls[0].includes(`-ArgumentList '${GUID}', 'OU=O''Brien\\, Ops,DC=example,DC=test'`));
    assert.match(auditSince(before), /User: op1 \| Module: GPO Manager \| Action: Linked GPO 'Baseline fake line' to OU=O'Brien/);
});

test('link/delete: Remove-GPLink only', async (t) => {
    const calls = capturePs(t);
    await request(app).post('/api/gpo/link/delete').set('Authorization', op).send({ guid: GUID, target: OU }).expect(200);
    assert.match(calls[0], /Remove-GPLink -Guid \$gId -Target \$t/);
    assert.doesNotMatch(calls[0], /Remove-GPO\b/);
});

test('link/set: booleans and order validated; only the sent options change', async (t) => {
    const calls = capturePs(t);
    await request(app).post('/api/gpo/link/set').set('Authorization', op).send({ guid: GUID, target: OU }).expect(400);
    await request(app).post('/api/gpo/link/set').set('Authorization', op).send({ guid: GUID, target: OU, enforced: 'yes' }).expect(400);
    await request(app).post('/api/gpo/link/set').set('Authorization', op).send({ guid: GUID, target: OU, order: 0 }).expect(400);
    await request(app).post('/api/gpo/link/set').set('Authorization', op).send({ guid: GUID, target: OU, order: 1.5 }).expect(400);
    assert.equal(calls.length, 0);
    const before = logLength();
    await request(app).post('/api/gpo/link/set').set('Authorization', op).send({ guid: GUID, target: OU, enabled: false, order: 2 }).expect(200);
    assert.ok(calls[0].includes(`-ArgumentList '${GUID}', '${OU}', '', 'No', '2'`));
    assert.match(calls[0], /Set-GPLink @p/);
    assert.match(auditSince(before), /Changed the link of GPO '.*' on OU=Kiosk.*: LinkEnabled=No, Order=2/);
});

test('inheritance: Set-GPInheritance Yes / No', async (t) => {
    const calls = capturePs(t);
    await request(app).post('/api/gpo/inheritance').set('Authorization', op).send({ target: OU, blocked: 'true' }).expect(400);
    await request(app).post('/api/gpo/inheritance').set('Authorization', op).send({ target: OU, blocked: true }).expect(200);
    await request(app).post('/api/gpo/inheritance').set('Authorization', op).send({ target: 'DC=example,DC=test', blocked: false }).expect(200);
    assert.match(calls[0], /Set-GPInheritance -Target \$t -IsBlocked \$b/);
    assert.ok(calls[0].includes(`-ArgumentList '${OU}', 'Yes'`));
    assert.ok(calls[1].includes("-ArgumentList 'DC=example,DC=test', 'No'"));
});
