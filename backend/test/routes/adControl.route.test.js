// AD Control / GPO: request values only reach PowerShell as quoted literals, the service account is required and its
// password never appears in the script, audit lines name the signed-in user, inputs and result sizes are bounded.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const powershell = require('../../lib/powershell');
const logger = require('../../lib/logger');
const { adErrorMessage } = require('../../lib/adService');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

const tok = (username, role) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['g'] })}`;
const op = tok('op1', 'Operator');
const viewer = tok('v1', 'Viewer');
let app;
let adRouter;

const SERVICE_PWD = 'Sv(c)P@ss"word';
const setAccount = () => {
    process.env.AD_ADMIN_USER = 'CORP\\svc-vanguard';
    process.env.AD_ADMIN_PWD = SERVICE_PWD;
    process.env.AD_DC_HOST = 'dc01.corp.example.test';
};

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { adControl: true } } },
    });
    adRouter = require('../../routes/ad');
    app = express();
    app.use(express.json());
    app.use('/api/ad', adRouter);
    app.use('/api/gpo', require('../../routes/gpo'));
});
test.after(async () => {
    for (const k of ['AD_ADMIN_USER', 'AD_ADMIN_PWD', 'AD_DC_HOST']) delete process.env[k];
    await dbManager.closeDB();
});

function capturePs(t, output = '[]') {
    const calls = [];
    t.mock.method(powershell, 'runPowerShell', async (script, timeout, options) => { calls.push({ script, options }); return output; });
    return calls;
}

test('search: a quote in the text stays inside a single-quoted literal; length, * and result size are bounded', async (t) => {
    setAccount();
    const calls = capturePs(t, JSON.stringify(Array.from({ length: 205 }, (_, i) => ({ Name: `u${i}`, SamAccountName: `u${i}` }))));
    const evil = `x" ; Start-Process calc ; "it's`;
    const r = await request(app).post('/api/ad/search').set('Authorization', viewer).send({ type: 'User', q: evil }).expect(200);
    assert.equal(r.body.results.length, 200);
    assert.equal(r.body.truncated, true);
    const script = calls[0].script;
    assert.ok(script.includes(`$term = 'x" ; Start-Process calc ; "it''s'.Replace("'", "''")`), 'text only as a literal');
    assert.ok(script.includes('-ResultSetSize 201'));
    for (const q of ['a', '*', 'ab*', 'a\nb']) {
        await request(app).post('/api/ad/search').set('Authorization', viewer).send({ type: 'User', q }).expect(400);
    }
});

test('the service account is required and its password never appears in the script', async (t) => {
    delete process.env.AD_ADMIN_USER;
    delete process.env.AD_ADMIN_PWD;
    const calls = capturePs(t);
    const r = await request(app).post('/api/ad/search').set('Authorization', viewer).send({ type: 'User', q: 'bob' }).expect(503);
    assert.match(r.body.error, /AD_ADMIN_USER/);
    assert.equal(calls.length, 0, 'no fallback to the signed-in user');

    setAccount();
    await request(app).post('/api/ad/search').set('Authorization', viewer).send({ type: 'User', q: 'bob' }).expect(200);
    assert.ok(!calls[0].script.includes(SERVICE_PWD));
    assert.equal(calls[0].options.env.SOMP_AD_SERVICE_PWD, SERVICE_PWD);
    assert.ok(calls[0].script.includes("PSCredential ('CORP\\svc-vanguard', $secPass)"));
    assert.ok(calls[0].script.includes("$dc = 'dc01.corp.example.test'"));
});

test('actions: account names are literals ($ kept), the audit line names the signed-in user, new passwords are strong', async (t) => {
    setAccount();
    const calls = capturePs(t, '');
    await request(app).post('/api/ad/action').set('Authorization', op).send({ sam: 'PC01$', action: 'disable' }).expect(200);
    assert.ok(calls[0].script.includes("$target = Get-ManagedUser 'PC01$'"), 'no backtick inserted into the literal');
    assert.ok(calls[0].script.includes('Disable-ADAccount -Identity $target'), 'the change hits the account that was checked');

    const r = await request(app).post('/api/ad/action').set('Authorization', op).send({ sam: 'alice', action: 'reset_password' }).expect(200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.body.password.length, 16);
    assert.match(r.body.password, /[A-Z]/);
    assert.match(r.body.password, /[a-z]/);
    assert.match(r.body.password, /[0-9]/);
    assert.match(r.body.password, /[^A-Za-z0-9]/);

    await request(app).post('/api/ad/action').set('Authorization', op).send({ sam: "a'; Remove-ADUser x; '", action: 'disable' }).expect(400);
    await request(app).post('/api/ad/action').set('Authorization', viewer).send({ sam: 'alice', action: 'disable' }).expect(403);
    await request(app).get('/api/ad/user/a%22b').set('Authorization', viewer).expect(400);
});

test('audit lines record who acted, not the service account', async (t) => {
    setAccount();
    capturePs(t, '');
    const fs = require('fs');
    const before = fs.existsSync(logger.getTodayLogFile()) ? fs.readFileSync(logger.getTodayLogFile(), 'utf8').length : 0;
    await request(app).post('/api/ad/action').set('Authorization', op).send({ sam: 'carol', action: 'unlock' }).expect(200);
    const added = fs.readFileSync(logger.getTodayLogFile(), 'utf8').slice(before);
    assert.match(added, /User: op1 \| Module: AD User Control \| Action: Unlocked AD Account: carol \(via service account svc-vanguard\)/);
});

test('GPO: ids and options are validated; values reach the DC only as literals', async (t) => {
    setAccount();
    const calls = capturePs(t, '[]');
    await request(app).get('/api/gpo/registry-list').query({ guid: '"; calc; "' }).set('Authorization', viewer).expect(400);
    const guid = '31B2F340-016D-11D2-945F-00C04FB984F9';
    await request(app).get('/api/gpo/registry-list').query({ guid }).set('Authorization', viewer).expect(200);
    assert.ok(calls[0].script.includes(`-ArgumentList '${guid}'`));
    assert.ok(!/gpo_report_debug/.test(calls[0].script));

    await request(app).post('/api/gpo/status').set('Authorization', op).send({ guid, status: 'Off"; calc' }).expect(400);
    await request(app).post('/api/gpo/backup').set('Authorization', op).send({ guid, nasPath: 'C:\\x"; calc; "' }).expect(400);
    await request(app).post('/api/gpo/security').set('Authorization', op)
        .send({ guid, action: 'Set', key: 'HKLM\\Software\\Policies\\Vendor', valueName: "v'; calc", type: 'String', value: 'a"$(calc)' }).expect(200);
    const sec = calls[calls.length - 1].script;
    assert.ok(sec.includes(`'v''; calc', 'String', 'a"$(calc)'`), 'every argument a single-quoted literal');
});

test('PowerShell errors are shortened, script positions dropped and secrets removed', () => {
    process.env.AD_ADMIN_PWD = 'TopSecret1';
    const msg = adErrorMessage({ stderr: "Get-ADUser : Cannot find an object with identity: 'x'\nAt C:\\app\\temp_run_ab.ps1:7 char:9\n+ $user = Get-ADUser -Identity 'x'\n+ ~~~~\n    + CategoryInfo : ObjectNotFound\nusing TopSecret1" });
    assert.match(msg, /Cannot find an object with identity/);
    assert.doesNotMatch(msg, /temp_run|CategoryInfo|TopSecret1/);
});
