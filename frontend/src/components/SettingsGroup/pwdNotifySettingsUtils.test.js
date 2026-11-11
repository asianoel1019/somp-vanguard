import test from 'node:test';
import assert from 'node:assert/strict';
import { pwdNotifyProblems, normalizeDays, pwdNotifyState, splitDns } from './pwdNotifySettingsUtils.js';

const mail = { MAIL_RELAY_SERVER: 'smtp.example.test', MAIL_RELAY_SENDER: 'it@example.test', MAIL_RELAY_RECIPIENT: 'admin@example.test' };

test('empty settings are fine (defaults apply)', () => {
    assert.deepEqual(pwdNotifyProblems(mail), {});
});

test('each field reports its own problem', () => {
    const p = pwdNotifyProblems({ PWD_NOTIFY_TIME: '9am', PWD_NOTIFY_DAYS: '14,0', PWD_NOTIFY_OUS: 'OU=A,DC=example,DC=test;Staff', PWD_NOTIFY_ADMIN_TO: 'admin@example.test; nope', PWD_NOTIFY_CHANGE_URL: 'javascript:alert(1)' });
    assert.deepEqual(Object.keys(p).sort(), ['PWD_NOTIFY_ADMIN_TO', 'PWD_NOTIFY_CHANGE_URL', 'PWD_NOTIFY_DAYS', 'PWD_NOTIFY_OUS', 'PWD_NOTIFY_TIME']);
    assert.match(p.PWD_NOTIFY_OUS, /Staff/);
});

test('test mode needs somewhere to send', () => {
    assert.match(pwdNotifyProblems({ MAIL_RELAY_SERVER: 'x' }).PWD_NOTIFY_ADMIN_TO, /Test mode needs a recipient/);
    assert.deepEqual(pwdNotifyProblems({ PWD_NOTIFY_TEST_MODE: 'false' }), {});
});

test('days are tidied, state and mail readiness reported, escaped ; kept', () => {
    assert.equal(normalizeDays(' 1, 14,7 7'), '14,7,1');
    assert.equal(normalizeDays('7,x'), '7,x');
    assert.deepEqual(pwdNotifyState({}), { state: 'off', mailReady: false });
    assert.deepEqual(pwdNotifyState({ ...mail, PWD_NOTIFY_ENABLED: 'true' }), { state: 'test', mailReady: true });
    assert.deepEqual(pwdNotifyState({ ...mail, PWD_NOTIFY_ENABLED: 'true', PWD_NOTIFY_TEST_MODE: 'false' }).state, 'on');
    assert.deepEqual(splitDns('OU=A\\;B,DC=x; OU=C,DC=x'), ['OU=A\\;B,DC=x', 'OU=C,DC=x']);
});
