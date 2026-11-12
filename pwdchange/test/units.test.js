const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNets, inNets, clientIp } = require('../src/net');
const { parseAccount, isPasswordText, splitDns, isScopeDn } = require('../src/scope');
const { Limiter } = require('../src/limiter');
const { parseEnvFile, readConfig } = require('../src/config');
const { classify, parseResult } = require('../src/ad');
const { buildChangedMail } = require('../src/mail');

test('networks: IPv4, IPv6 and mapped addresses; bad entries refused', () => {
    const { list } = parseNets('10.0.0.0/8, 192.168.1.10, fd00::/8');
    assert.ok(inNets('10.20.30.40', list));
    assert.ok(inNets('::ffff:10.1.2.3', list));
    assert.ok(inNets('192.168.1.10', list));
    assert.ok(!inNets('192.168.1.11', list));
    assert.ok(inNets('fd12:3456::1', list));
    assert.ok(!inNets('fe80::1', list));
    assert.ok(!inNets('203.0.113.5', list));
    assert.ok(!inNets('not-an-ip', list));
    assert.match(parseNets('10.0.0.0/33').error, /prefix/);
    assert.match(parseNets('intranet').error, /not an IP/);
    assert.deepEqual(parseNets('').list, []);
    assert.ok(inNets('198.51.100.7', parseNets('0.0.0.0/0').list));
});

test('client address: socket peer, or the right-most forwarded address behind a trusted proxy', () => {
    const req = { socket: { remoteAddress: '::ffff:192.0.2.5' }, headers: { 'x-forwarded-for': '10.9.9.9, 192.0.2.77' } };
    assert.equal(clientIp(req, false), '192.0.2.5');
    assert.equal(clientIp(req, true), '192.0.2.77');
});

test('accounts: three ways to type them; anything that could reach a filter is refused', () => {
    assert.deepEqual(parseAccount(' alice '), { kind: 'sam', value: 'alice' });
    assert.deepEqual(parseAccount('EXAMPLE\\alice'), { kind: 'sam', value: 'alice' });
    assert.deepEqual(parseAccount('alice.chen@example.test'), { kind: 'upn', value: 'alice.chen@example.test' });
    for (const bad of ['', 'a\\b\\c', "o'brien", 'a*', 'x@y', 'a@b.c\'d', 'al ice@example.test', 'a@(b).test', 'x'.repeat(65), 'a;b']) {
        assert.equal(parseAccount(bad), null, bad);
    }
    assert.ok(isPasswordText('P@ss w0rd!中文'));
    assert.ok(!isPasswordText(''));
    assert.ok(!isPasswordText('a\nb'));
    assert.ok(!isPasswordText('x'.repeat(257)));
    assert.ok(!isPasswordText(12345));
});

test('OU scope entries', () => {
    assert.deepEqual(splitDns('OU=A\\;B,DC=x; OU=C,DC=x'), ['OU=A\\;B,DC=x', 'OU=C,DC=x']);
    assert.ok(isScopeDn('OU=Staff,DC=example,DC=test'));
    assert.ok(!isScopeDn('Staff'));
    assert.ok(!isScopeDn('DC=x,OU=y,DC=z'));
});

test('limiter: max attempts in the window, then a wait', () => {
    const l = new Limiter(2, 1000);
    assert.ok(l.take('A', 0));
    assert.ok(l.take('a', 100));
    assert.ok(!l.take('A', 200));
    assert.equal(l.retryAfter('a', 200), 1);
    assert.ok(l.take('a', 1001));
});

test('config: .env text parsed as typed; missing essentials reported', () => {
    const env = parseEnvFile('# c\nAD_SERVICE_USER=EXAMPLE\\svc\nAD_SERVICE_PWD="p=1#x"\n\nBAD LINE\nALLOWED_NETS=10.0.0.0/8\n');
    assert.equal(env.AD_SERVICE_USER, 'EXAMPLE\\svc');
    assert.equal(env.AD_SERVICE_PWD, 'p=1#x');
    let c = readConfig({ ...env, ALLOW_HTTP: 'true' });
    assert.deepEqual(c.errors, []);
    assert.equal(c.smtp, null);
    c = readConfig({});
    assert.equal(c.errors.length, 3);
    assert.match(c.errors.join('|'), /HTTPS_PFX_PATH.*\|ALLOWED_NETS is empty.*\|AD_SERVICE_USER/);
    assert.match(readConfig({ ...env, ALLOW_HTTP: 'true', ALLOWED_OUS: 'Staff' }).errors[0], /ALLOWED_OUS/);
});

test('AD answers: one generic answer for every "no" except policy', () => {
    assert.equal(classify({ code: 'OK' }).outcome, 'ok');
    for (const code of ['NOT_FOUND', 'PROTECTED', 'DISABLED', 'OUT_OF_SCOPE']) assert.equal(classify({ code }).outcome, 'invalid', code);
    const fail = (type, message) => classify({ code: 'FAIL', data: { type, message } });
    assert.equal(fail('Microsoft.ActiveDirectory.Management.ADPasswordComplexityException', 'The password does not meet the length, complexity, or history requirement of the domain.').outcome, 'policy');
    assert.equal(fail('Microsoft.ActiveDirectory.Management.ADInvalidPasswordException', 'The specified network password is not correct').outcome, 'invalid');
    assert.equal(fail('Microsoft.ActiveDirectory.Management.ADException', 'The referenced account is currently locked out and may not be logged on to').outcome, 'invalid');
    assert.equal(fail('System.TimeoutException', 'Unable to contact the server').outcome, 'error');
    assert.deepEqual(parseResult('noise\nPWC_RESULT {"code":"OK","data":null}\r\n'), { code: 'OK', data: null });
    assert.throws(() => parseResult('nothing here'), /No result/);
});

test('confirmation mail: both languages, values escaped', () => {
    const m = buildChangedMail({ name: 'Bob <b>', sam: 'bob', ip: '10.1.2.3', adminContact: 'IT ext. 1234' }, new Date(2026, 10, 11, 14, 5));
    assert.equal(m.subject, '您的密碼已變更 / Your password was changed');
    assert.match(m.text, /2026-11-11 14:05 從 10\.1\.2\.3/);
    assert.match(m.text, /If this was not you, contact IT ext\. 1234 immediately\./);
    assert.match(m.html, /Bob &lt;b&gt;/);
});
