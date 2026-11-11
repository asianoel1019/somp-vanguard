// Password expiry notifier: who gets mailed, test mode, failures, the summary, once-a-day scheduling, manual runs
// and the API roles. PowerShell and SMTP are replaced by recorders.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const powershell = require('../../lib/powershell');
const mailer = require('../../lib/mailer');
const { writeDataSync } = require('../../lib/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const notifier = require('../../services/pwdExpiryNotifier');

const ENV = {
    AD_ADMIN_USER: 'CORP\\svc-vanguard', AD_ADMIN_PWD: 'S3cret-test', AD_DC_HOST: 'dc01.example.test',
    MAIL_RELAY_SERVER: 'smtp.example.test', MAIL_RELAY_SENDER: 'it@example.test', MAIL_RELAY_RECIPIENT: 'admin@example.test',
    PWD_NOTIFY_ENABLED: 'true', PWD_NOTIFY_TIME: '09:00', PWD_NOTIFY_DAYS: '14,7,3,2,1', PWD_NOTIFY_TEST_MODE: 'false',
    AD_OU_SEARCH: "OU=O'Staff,DC=example,DC=test",
};
const NOW = new Date(2026, 10, 11, 9, 5);
const at = (d) => new Date(2026, 10, 11 + d, 12, 0).toISOString();
const ACCOUNTS = [
    { sam: 'amy', name: 'Amy', mail: 'amy@example.test', expires: at(7) },
    { sam: 'bob', name: 'Bob', mail: 'bob@example.test', expires: at(3) },
    { sam: 'cat', name: 'Cat', mail: 'cat@example.test', expires: at(5) },
    { sam: 'dan', name: 'Dan', mail: '', expires: at(1) },
];
let app;

test.before(async () => {
    await dbManager.initDB();
    Object.assign(process.env, ENV);
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { adControl: true } } },
    });
    app = express();
    app.use(express.json());
    app.use('/api/ad', require('../../routes/ad'));
});
test.after(async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    await dbManager.closeDB();
});
test.beforeEach(() => {
    Object.assign(process.env, ENV);
    writeDataSync(notifier.KEY, {});
});

function fakes(t, { accounts = ACCOUNTS, failFor = [], psError } = {}) {
    const scripts = [];
    const mails = [];
    t.mock.method(powershell, 'runPowerShell', async (script) => {
        scripts.push(script);
        if (psError) throw Object.assign(new Error('PowerShell failed'), { stderr: psError });
        return JSON.stringify({ scanned: 42, accounts });
    });
    t.mock.method(mailer, 'deliverMail', async (mail) => {
        mails.push(mail);
        if (failFor.some(f => String(mail.to).includes(f))) throw new mailer.MailError('550 mailbox unavailable');
        return 'id';
    });
    return { scripts, mails };
}

test('users on a configured day get one mail each; the summary lists everyone; the run is recorded and audited', async (t) => {
    const { scripts, mails } = fakes(t, { failFor: ['bob@'] });
    const r = await notifier.run({ now: NOW, trigger: 'manual', by: 'sa1' });
    assert.deepEqual(r.sent.map(e => e.sam), ['amy']);
    assert.deepEqual(r.failed.map(e => [e.sam, e.error]), [['bob', '550 mailbox unavailable']]);
    assert.deepEqual(r.noEmail.map(e => e.sam), ['dan']);
    assert.equal(r.scanned, 42);
    assert.deepEqual(mails.map(m => m.to), ['bob@example.test', 'amy@example.test', 'admin@example.test']);
    assert.match(mails[2].subject, /sent 1, failed 1, no email 1/);
    assert.equal(r.summary, 'sent');
    assert.ok(scripts[0].includes("$bases = @('OU=O''Staff,DC=example,DC=test')"), 'OUs only as literals');
    assert.match(scripts[0], /Get-ADUser -Filter \$filter -SearchBase \$b/);
    assert.doesNotMatch(scripts[0], /\b(Set|Remove|New|Enable|Disable|Unlock)-AD/);
    assert.ok(!scripts[0].includes('S3cret-test'));
    assert.equal(notifier.status().runs[0].sent.length, 1);
});

test('test mode sends the user notices to the summary recipient, marked with the real address', async (t) => {
    process.env.PWD_NOTIFY_TEST_MODE = 'true';
    const { mails } = fakes(t);
    const r = await notifier.run({ now: NOW });
    assert.equal(r.testMode, true);
    assert.ok(mails.every(m => m.to === 'admin@example.test'));
    assert.match(mails[0].subject, /^\[TEST -> bob@example\.test\] /);
    assert.match(mails[mails.length - 1].subject, /^\[TEST\] /);
});

test('preview sends nothing and records nothing', async (t) => {
    const { mails } = fakes(t);
    const r = await notifier.preview(NOW);
    assert.deepEqual(r.due.map(e => e.sam), ['bob', 'amy']);
    assert.equal(mails.length, 0);
    assert.equal(notifier.status().runs.length, 0);
});

test('when AD cannot be read the administrator still gets a summary with the error', async (t) => {
    const { mails } = fakes(t, { psError: 'Get-ADUser : Unable to contact the server.\nAt line:3' });
    const r = await notifier.run({ now: NOW });
    assert.match(r.error, /Could not read the accounts: Get-ADUser : Unable to contact the server/);
    assert.equal(mails.length, 1);
    assert.match(mails[0].text, /Error: Could not read the accounts/);
    await assert.rejects(() => notifier.preview(NOW), /Could not read the accounts/);
});

test('the schedule runs once a day, only from the set time to an hour after, and not when off', async (t) => {
    const { mails } = fakes(t);
    assert.deepEqual(await notifier.tick(new Date(2026, 10, 11, 8, 59)), { skipped: 'not-due' });
    const r = await notifier.tick(NOW);
    assert.equal(r.trigger, 'schedule');
    const count = mails.length;
    assert.deepEqual(await notifier.tick(new Date(2026, 10, 11, 9, 30)), { skipped: 'not-due' });
    assert.equal(mails.length, count, 'no second mail the same day');
    writeDataSync(notifier.KEY, {});
    process.env.PWD_NOTIFY_ENABLED = 'false';
    assert.deepEqual(await notifier.tick(NOW), { skipped: 'disabled' });
});

test('a manual run that mails users counts as today\'s run; a second one is refused', async (t) => {
    const { mails } = fakes(t);
    await notifier.runNow('sa1', NOW);
    await assert.rejects(() => notifier.runNow('sa1', NOW), /already sent/);
    assert.deepEqual(await notifier.tick(new Date(2026, 10, 11, 9, 10)), { skipped: 'not-due' });
    const sentToUsers = mails.filter(m => m.to !== 'admin@example.test').length;
    assert.equal(sentToUsers, 2);
});

test('bad settings stop a run with the reason', async (t) => {
    fakes(t);
    process.env.PWD_NOTIFY_DAYS = '0,400';
    await assert.rejects(() => notifier.runNow('sa1', NOW), /PWD_NOTIFY_DAYS/);
});

test('API: status and preview for Operators, run now for SuperAdmins only', async (t) => {
    process.env.PWD_NOTIFY_TEST_MODE = 'true';
    fakes(t);
    const tok = (role) => `Bearer ${signToken({ username: `${role}1`, domain: 'corp', role, groups: ['g'] })}`;
    await request(app).get('/api/ad/pwd-notify/status').set('Authorization', tok('Viewer')).expect(403);
    const st = await request(app).get('/api/ad/pwd-notify/status').set('Authorization', tok('Operator')).expect(200);
    assert.equal(st.body.config.time, '09:00');
    assert.equal(st.body.config.ousSource, 'AD_OU_SEARCH');
    const pv = await request(app).post('/api/ad/pwd-notify/preview').set('Authorization', tok('Operator')).expect(200);
    assert.equal(pv.body.due.length, 2);
    await request(app).post('/api/ad/pwd-notify/run').set('Authorization', tok('Operator')).expect(403);
    const run = await request(app).post('/api/ad/pwd-notify/run').set('Authorization', tok('SuperAdmin')).expect(200);
    assert.equal(run.body.testMode, true);
});
