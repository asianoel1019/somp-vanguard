const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../../lib/pwdNotifyModel');

const base = { MAIL_RELAY_SERVER: 'smtp.example.test', MAIL_RELAY_SENDER: 'it@example.test', MAIL_RELAY_RECIPIENT: 'admin@example.test' };

test('days and time: defaults, sorting, duplicates and bad values', () => {
    assert.deepEqual(m.parseDays(''), [14, 7, 3, 2, 1]);
    assert.deepEqual(m.parseDays('1, 7,14 7'), [14, 7, 1]);
    assert.equal(m.parseDays('0,7'), null);
    assert.equal(m.parseDays('91'), null);
    assert.equal(m.parseDays('7;rm'), null);
    assert.deepEqual(m.parseTime(''), { h: 9, m: 0, text: '09:00' });
    assert.deepEqual(m.parseTime('7:05'), { h: 7, m: 5, text: '07:05' });
    assert.equal(m.parseTime('24:00'), null);
});

test('config: off and in test mode by default; OUs and recipient fall back; problems listed', () => {
    let c = m.readConfig(base);
    assert.equal(c.enabled, false);
    assert.equal(c.testMode, true);
    assert.deepEqual([c.ous, c.ousSource], [[], 'domain']);
    assert.deepEqual([c.adminTo, c.adminToSource], [['admin@example.test'], 'MAIL_RELAY_RECIPIENT']);
    assert.deepEqual(c.errors, []);

    c = m.readConfig({ ...base, AD_OU_SEARCH: 'OU=Staff,DC=example,DC=test' });
    assert.deepEqual([c.ous, c.ousSource], [['OU=Staff,DC=example,DC=test'], 'AD_OU_SEARCH']);
    c = m.readConfig({ ...base, AD_OU_SEARCH: 'OU=Staff,DC=example,DC=test', PWD_NOTIFY_OUS: 'OU=A,DC=example,DC=test; OU=B\\;x,DC=example,DC=test', PWD_NOTIFY_ADMIN_TO: 'a@example.test; b@example.test', PWD_NOTIFY_TEST_MODE: 'false' });
    assert.deepEqual([c.ous, c.ousSource], [['OU=A,DC=example,DC=test', 'OU=B\\;x,DC=example,DC=test'], 'PWD_NOTIFY_OUS']);
    assert.deepEqual(c.adminTo, ['a@example.test', 'b@example.test']);
    assert.equal(c.testMode, false);

    c = m.readConfig({ PWD_NOTIFY_ENABLED: 'true', PWD_NOTIFY_TIME: '9am', PWD_NOTIFY_DAYS: 'x', PWD_NOTIFY_OUS: 'Staff', PWD_NOTIFY_ADMIN_TO: 'not-mail', PWD_NOTIFY_CHANGE_URL: 'javascript:alert(1)' });
    assert.equal(c.errors.length, 6);
    assert.match(c.errors.join('|'), /PWD_NOTIFY_TIME.*\|PWD_NOTIFY_DAYS.*\|PWD_NOTIFY_OUS has an entry.*\|PWD_NOTIFY_ADMIN_TO has an address.*\|PWD_NOTIFY_CHANGE_URL.*\|Mail Relay is not configured/);
});

test('days left counts calendar days in local time', () => {
    const now = new Date(2026, 10, 11, 9, 0);
    assert.equal(m.daysLeft(new Date(2026, 10, 25, 8, 0).toISOString(), now), 14);
    assert.equal(m.daysLeft(new Date(2026, 10, 11, 23, 59).toISOString(), now), 0);
    assert.equal(m.daysLeft(new Date(2026, 10, 12, 0, 1).toISOString(), now), 1);
    assert.equal(m.daysLeft('nonsense', now), null);
});

test('only accounts on a configured day are due; no email goes to its own list', () => {
    const now = new Date(2026, 10, 11, 9, 0);
    const at = (d) => new Date(2026, 10, 11 + d, 12, 0).toISOString();
    const r = m.selectDue([
        { sam: 'bob', name: 'Bob', mail: 'bob@example.test', expires: at(7) },
        { sam: 'amy', name: 'Amy', mail: 'amy@example.test', expires: at(7) },
        { sam: 'cat', name: 'Cat', mail: 'cat@example.test', expires: at(6) },
        { sam: 'dan', name: 'Dan', mail: '', expires: at(1) },
        { sam: 'eve', name: 'Eve', mail: 'not an address', expires: at(14) },
        { sam: 'fay', name: 'Fay', mail: 'fay@example.test', expires: at(1) },
    ], [14, 7, 3, 2, 1], now);
    assert.deepEqual(r.due.map(e => [e.sam, e.daysLeft]), [['fay', 1], ['amy', 7], ['bob', 7]]);
    assert.deepEqual(r.noEmail.map(e => e.sam), ['dan', 'eve']);
});

test('user mail: both languages, escaped values, optional change link', () => {
    const entry = { sam: 'bob', name: 'Bob <script>alert(1)</script>', mail: 'bob@example.test', daysLeft: 3, expires: new Date(2026, 10, 14, 8, 30).toISOString() };
    const mail = m.buildUserMail(entry, { changeUrl: '' });
    assert.equal(mail.subject, '密碼將於3 天後到期 / Your password expires in 3 days');
    assert.match(mail.text, /您的帳號 bob 的密碼將於3 天後（2026-11-14 08:30）到期/);
    assert.match(mail.text, /expires in 3 days \(2026-11-14 08:30\)/);
    assert.match(mail.text, /IT never asks for your password/);
    assert.doesNotMatch(mail.html, /<script>/);
    assert.match(mail.html, /Bob &lt;script&gt;/);
    const withLink = m.buildUserMail({ ...entry, daysLeft: 1 }, { changeUrl: 'https://passwordreset.example.test/?a=1&b="2"' });
    assert.match(withLink.subject, /in 1 day$/);
    assert.match(withLink.html, /href="https:\/\/passwordreset\.example\.test\/\?a=1&amp;b=&quot;2&quot;"/);
    assert.equal(m.buildUserMail({ ...entry, daysLeft: 0 }, {}).subject, '密碼將於今天到期 / Your password expires today');
});

test('summary mail lists every group and marks test mode', () => {
    const e = { sam: 'bob', name: 'Bob', mail: 'bob@example.test', daysLeft: 7, expires: new Date(2026, 10, 18).toISOString() };
    const s = m.buildSummaryMail({ at: new Date(2026, 10, 11, 9).toISOString(), testMode: true, scanned: 120, sent: [e], failed: [{ ...e, sam: 'amy', error: '550 mailbox unavailable' }], noEmail: [{ ...e, sam: 'dan', mail: '' }], overLimit: [], error: '' });
    assert.match(s.subject, /^\[TEST\] .*2026-11-11: sent 1, failed 1, no email 1$/);
    assert.match(s.text, /Test mode/);
    assert.match(s.text, /Failed \(1\):\n {2}amy.*550 mailbox unavailable/);
    assert.match(s.html, /No email address \(not notified\) \(1\)/);
});

test('due once per day, within an hour after the set time', () => {
    const t = m.parseTime('09:00');
    assert.equal(m.isDue(new Date(2026, 10, 11, 8, 59), t, null), false);
    assert.equal(m.isDue(new Date(2026, 10, 11, 9, 0), t, null), true);
    assert.equal(m.isDue(new Date(2026, 10, 11, 9, 59), t, '2026-11-10'), true);
    assert.equal(m.isDue(new Date(2026, 10, 11, 10, 1), t, null), false);
    assert.equal(m.isDue(new Date(2026, 10, 11, 9, 30), t, '2026-11-11'), false);
});
