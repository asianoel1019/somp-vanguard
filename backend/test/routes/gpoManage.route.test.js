// GPO lifecycle and permissions: role limits (delete and delegation SuperAdmin only), every input checked before
// PowerShell, values only as literals, audit lines name the acting user.
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
const admin = tok('sa1', 'SuperAdmin');
const op = tok('op1', 'Operator');
const viewer = tok('v1', 'Viewer');
const GUID = '31B2F340-016D-11D2-945F-00C04FB984F9';
const BACKUP = '{0F0A1B2C-3D4E-4F50-8A6B-7C8D9E0F1A2B}';
const OU = 'OU=Kiosk,DC=example,DC=test';
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

function capturePs(t, output = '') {
    const calls = [];
    t.mock.method(powershell, 'runPowerShell', async (script) => { calls.push(script); return typeof output === 'function' ? output(script) : output; });
    return calls;
}
const logLength = () => (fs.existsSync(logger.getTodayLogFile()) ? fs.readFileSync(logger.getTodayLogFile(), 'utf8').length : 0);
const auditSince = (before) => fs.readFileSync(logger.getTodayLogFile(), 'utf8').slice(before);
const post = (path, auth, body) => request(app).post(`/api/gpo${path}`).set('Authorization', auth).send(body);

test('roles: Viewers change nothing; delete and delegation are SuperAdmin only', async (t) => {
    const calls = capturePs(t);
    for (const path of ['/create', '/rename', '/copy', '/comment', '/filtering', '/wmi-filter', '/restore']) {
        await post(path, viewer, {}).expect(403);
    }
    await request(app).get('/api/gpo/backups').set('Authorization', viewer).expect(403);
    await post('/delete', op, { guid: GUID, name: 'X', confirmName: 'X' }).expect(403);
    await post('/delegation', op, { guid: GUID, action: 'remove', trustee: 'Helpdesk', trusteeType: 'Group' }).expect(403);
    assert.equal(calls.length, 0);
});

test('create: name checked, optional link target checked here and on the DC, id returned, audited', async (t) => {
    const calls = capturePs(t, `{${GUID}}\r\n`);
    await post('/create', op, { name: '  ' }).expect(400);
    await post('/create', op, { name: 'a\nb' }).expect(400);
    await post('/create', op, { name: 'x'.repeat(256) }).expect(400);
    await post('/create', op, { name: 'Kiosk', linkTo: 'CN=Users,DC=example,DC=test' }).expect(400);
    assert.equal(calls.length, 0);
    const before = logLength();
    const r = await post('/create', op, { name: " Kiosk 'lockdown' ", comment: 'line 1\nline 2', linkTo: OU }).expect(200);
    assert.equal(r.body.id, GUID.toLowerCase());
    assert.ok(calls[0].includes(`-ArgumentList 'Kiosk ''lockdown''', 'line 1\nline 2', '${OU}'`));
    assert.match(calls[0], /notcontains \[string\]\$o\.ObjectClass[\s\S]*New-GPO -Name \$n[\s\S]*New-GPLink -Guid \$g\.Id -Target \$t/);
    assert.match(auditSince(before), /User: op1 \| Module: GPO Manager \| Action: Created GPO 'Kiosk 'lockdown'' \{31b2f340.*\} and linked it to OU=Kiosk/);
});

test('rename, copy and comment pass only literals', async (t) => {
    const calls = capturePs(t, GUID);
    await post('/rename', op, { guid: 'nope', newName: 'A' }).expect(400);
    await post('/copy', op, { guid: GUID, newName: 'A', copyAcl: 'yes' }).expect(400);
    await post('/comment', op, { guid: GUID, comment: 'bell\x07' }).expect(400);
    assert.equal(calls.length, 0);
    await post('/rename', op, { guid: GUID, name: 'Old', newName: 'New "name"' }).expect(200);
    assert.match(calls[0], /Rename-GPO -Guid \$gId -TargetName \$n/);
    assert.ok(calls[0].includes(`'${GUID}', 'New "name"'`));
    await post('/copy', op, { guid: GUID, name: 'Old', newName: 'Copy of Old', copyAcl: true }).expect(200);
    assert.ok(calls[1].includes(`'${GUID}', 'Copy of Old', 'Yes'`));
    await post('/comment', op, { guid: GUID, comment: '$(calc)' }).expect(200);
    assert.ok(calls[2].includes(`'${GUID}', '$(calc)'`));
});

test('delete: the name must be repeated exactly and is checked again on the DC', async (t) => {
    const calls = capturePs(t);
    await post('/delete', admin, { guid: GUID, name: 'Kiosk', confirmName: 'kiosk' }).expect(400);
    await post('/delete', admin, { guid: GUID, name: 'Kiosk' }).expect(400);
    assert.equal(calls.length, 0);
    const before = logLength();
    await post('/delete', admin, { guid: GUID, name: 'Kiosk', confirmName: 'Kiosk' }).expect(200);
    assert.match(calls[0], /if \(\$g\.DisplayName -cne \$n\) \{ throw[\s\S]*Remove-GPO -Guid \$gId/);
    assert.match(auditSince(before), /User: sa1 .*Deleted GPO 'Kiosk' \{31b2f340-016d-11d2-945f-00c04fb984f9\} and its links/);
});

test('security filtering: Apply on add, Read only on remove; trustee and type checked', async (t) => {
    const calls = capturePs(t);
    await post('/filtering', op, { guid: GUID, action: 'add', trustee: 'a"; calc', trusteeType: 'Group' }).expect(400);
    await post('/filtering', op, { guid: GUID, action: 'add', trustee: 'Kiosk PCs', trusteeType: 'Alias' }).expect(400);
    await post('/filtering', op, { guid: GUID, action: 'grant', trustee: 'Kiosk PCs', trusteeType: 'Group' }).expect(400);
    assert.equal(calls.length, 0);
    await post('/filtering', op, { guid: GUID, action: 'add', trustee: 'EXAMPLE\\Kiosk PCs', trusteeType: 'Group' }).expect(200);
    await post('/filtering', op, { guid: GUID, action: 'remove', trustee: 'Authenticated Users', trusteeType: 'Group' }).expect(200);
    assert.ok(calls[0].includes(`'${GUID}', 'EXAMPLE\\Kiosk PCs', 'Group', 'GpoApply'`));
    assert.ok(calls[1].includes(`'${GUID}', 'Authenticated Users', 'Group', 'GpoRead'`));
    assert.match(calls[0], /Set-GPPermission -Guid \$gId -TargetName \$tn -TargetType \$tt -PermissionLevel \$lvl -Replace/);
});

test('delegation: only the three delegation levels, None on remove', async (t) => {
    const calls = capturePs(t);
    await post('/delegation', admin, { guid: GUID, action: 'set', trustee: 'Helpdesk', trusteeType: 'Group', permission: 'GpoApply' }).expect(400);
    await post('/delegation', admin, { guid: GUID, action: 'set', trustee: 'Helpdesk', trusteeType: 'Group', permission: 'GpoEdit' }).expect(200);
    await post('/delegation', admin, { guid: GUID, action: 'remove', trustee: 'Helpdesk', trusteeType: 'Group' }).expect(200);
    assert.ok(calls[0].includes("'Helpdesk', 'Group', 'GpoEdit'"));
    assert.ok(calls[1].includes("'Helpdesk', 'Group', 'None'"));
});

test('WMI filter: braced id required, the filter must exist, empty clears it', async (t) => {
    const calls = capturePs(t);
    await post('/wmi-filter', op, { guid: GUID, filterId: "x)(msWMI-ID=*" }).expect(400);
    assert.equal(calls.length, 0);
    await post('/wmi-filter', op, { guid: `{${GUID}}`, filterId: BACKUP }).expect(200);
    await post('/wmi-filter', op, { guid: GUID, filterId: null }).expect(200);
    assert.ok(calls[0].includes(`-ArgumentList '${GUID.toLowerCase()}', '${BACKUP}'`));
    assert.match(calls[0], /LDAPFilter "\(msWMI-ID=\$fid\)"[\s\S]*gPCWQLFilter/);
    assert.ok(calls[1].includes(`'${GUID.toLowerCase()}', ''`));
});

test('backups: path checked, list newest first; restore needs a braced backup id', async (t) => {
    const calls = capturePs(t, (script) => (script.includes('bkupInfo.xml') && script.includes('Get-ChildItem')
        ? JSON.stringify([
            { id: BACKUP, gpoId: `{${GUID}}`, name: 'Old', time: '2026-01-01T10:00:00' },
            { id: '{11111111-2222-3333-4444-555555555555}', gpoId: `{${GUID}}`, name: 'Old', time: '2026-03-01T10:00:00' },
            { id: 'not-a-backup', name: 'x', time: '2026-04-01' },
        ])
        : 'Imported'));
    await request(app).get('/api/gpo/backups').query({ path: 'C:\\x"; calc' }).set('Authorization', op).expect(400);
    const r = await request(app).get('/api/gpo/backups').set('Authorization', op).expect(200);
    assert.equal(r.body.path, 'C:\\GPO_Backups');
    assert.deepEqual(r.body.backups.map(b => b.time), ['2026-03-01T10:00:00', '2026-01-01T10:00:00']);
    assert.equal(r.body.backups[0].gpoId, GUID.toLowerCase());

    await post('/restore', op, { backupId: GUID, path: 'C:\\GPO_Backups' }).expect(400);
    const before = logLength();
    const rr = await post('/restore', op, { backupId: BACKUP, path: '\\\\nas01\\gpo', name: 'Old' }).expect(200);
    assert.equal(rr.body.result, 'Imported');
    assert.ok(calls[calls.length - 1].includes(`-ArgumentList '${BACKUP}', '\\\\nas01\\gpo'`));
    assert.match(calls[calls.length - 1], /Restore-GPO -BackupId \$bid[\s\S]*Import-GPO -BackupId \$bid -Path \$path -TargetName \$n -CreateIfNeeded/);
    assert.match(auditSince(before), /Imported GPO 'Old' from backup \{0F0A1B2C/);
});
