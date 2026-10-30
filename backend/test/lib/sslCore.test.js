// SSL Manager core: validation, PEM/DER parsing in Node, PFX via constant script + stdin, status / alert model,
// trust evaluation, public projection. No network: the prober is never called here.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const core = require('../../lib/sslCore');

// Self-signed test certificate: CN=test.example.com, SAN DNS:test.example.com, DNS:www.test.example.com, IP:10.0.0.5
// notBefore 2026-10-28T10:07:30Z, notAfter 2036-10-25T10:07:30Z
const TEST_PEM = `-----BEGIN CERTIFICATE-----
MIIBpjCCAUygAwIBAgIUM7AiB6kuNDc2ftRHHQwqqidyqPIwCgYIKoZIzj0EAwIw
LzEZMBcGA1UEAwwQdGVzdC5leGFtcGxlLmNvbTESMBAGA1UECgwJU09NUCBUZXN0
MB4XDTI2MTAyODEwMDczMFoXDTM2MTAyNTEwMDczMFowLzEZMBcGA1UEAwwQdGVz
dC5leGFtcGxlLmNvbTESMBAGA1UECgwJU09NUCBUZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAE0pqhHaOoMukxwlAPTkRSu96DFRIVYPmKLtNOUbmz9Eoteg1f
dNNtynKXNAMVkHrYkCz4xcHN70/+4OgvrCXWD6NGMEQwNwYDVR0RBDAwLoIQdGVz
dC5leGFtcGxlLmNvbYIUd3d3LnRlc3QuZXhhbXBsZS5jb22HBAoAAAUwCQYDVR0T
BAIwADAKBggqhkjOPQQDAgNIADBFAiBtZUKNn+Zm6yGedcwPscNm9DfZT6qzdG0E
rRVK7UiHUgIhAMNzjsISO/6k3Pmvht26wl11YV21GO6XHQ8Q9ZL3TQtj
-----END CERTIFICATE-----
`;
const TEST_DER = new crypto.X509Certificate(TEST_PEM).raw;
const FP = '2D:1F:5B:41:7D:05:7A:78:95:4C:BE:61:89:74:C0:70:B9:32:55:CB:F8:8E:3D:04:98:B7:2D:48:DF:E4:3F:B3';

test.afterEach(() => core.resetHooks());

// ---------------------------------------------------------------- validation
test('host validation: hostname / IPv4, polite normalisation, rejects scheme+path, ports, spaces, bad IPs, long names', () => {
    assert.deepEqual(core.normalizeHost('  Mail.Example.COM '), { host: 'mail.example.com' });
    assert.deepEqual(core.normalizeHost('https://mail.example.com/'), { host: 'mail.example.com' });
    assert.deepEqual(core.normalizeHost('mail.example.com.'), { host: 'mail.example.com' });
    assert.deepEqual(core.normalizeHost('10.1.2.3'), { host: '10.1.2.3' });
    assert.deepEqual(core.normalizeHost(''), { host: '' });
    assert.deepEqual(core.normalizeHost(undefined), { host: '' });
    assert.deepEqual(core.normalizeHost('File Backup Only'), { host: '' });
    for (const bad of ['https://a.com/path', 'a.com:443', 'a b.com', 'user@a.com', '999.1.1.1', '1.2.3', '-a.com', 'a..com', '::1', 'a.com?x', 'x'.repeat(254), { a: 1 }]) {
        assert.ok(core.normalizeHost(bad).error, `expected error for ${JSON.stringify(bad)}`);
    }
});

test('port / name validation and new ids', () => {
    assert.deepEqual(core.normalizePort(''), { port: 443 });
    assert.deepEqual(core.normalizePort(undefined), { port: 443 });
    assert.deepEqual(core.normalizePort('8443'), { port: 8443 });
    assert.deepEqual(core.normalizePort(65535), { port: 65535 });
    for (const bad of [0, '0', 65536, '1.5', 'abc', -1, '443x']) assert.ok(core.normalizePort(bad).error, String(bad));
    assert.deepEqual(core.normalizeName(' n '), { name: 'n' });
    assert.ok(core.normalizeName('x'.repeat(201)).error);
    assert.match(core.newId(1700000000000), /^ssl-1700000000000-[0-9a-f]{8}$/);
    assert.notEqual(core.newId(1), core.newId(1));
});

test('isFileOnly: empty host or the legacy File Backup Only marker', () => {
    assert.equal(core.isFileOnly({ host: '' }), true);
    assert.equal(core.isFileOnly({}), true);
    assert.equal(core.isFileOnly({ host: 'File Backup Only' }), true);
    assert.equal(core.isFileOnly({ host: 'a.com' }), false);
});

// ---------------------------------------------------------------- uploads / parsing
test('upload validation: type whitelist, strict base64, 1 MB limit', () => {
    assert.match(core.decodeUpload('AAAA', 'JKS').error, /Unsupported/);
    assert.match(core.decodeUpload('AAAA', '').error, /Unsupported/);
    assert.match(core.decodeUpload('not base64!!', 'PEM').error, /base64/);
    assert.match(core.decodeUpload('AAA', 'PEM').error, /base64/);
    assert.match(core.decodeUpload(Buffer.alloc(1024 * 1024 + 1).toString('base64'), 'DER').error, /1 MB/);
    const ok = core.decodeUpload(TEST_DER.toString('base64'), 'cer');
    assert.equal(ok.family, 'X509');
    assert.equal(ok.type, 'CER');
    assert.equal(core.decodeUpload('AAAA', 'p12').family, 'PFX');
    assert.equal(core.decodeUpload('AAAA', 'CRT').family, 'X509');
});

test('PEM and DER are parsed in Node (subject CN / DN, issuer, dates, SAN, fingerprint)', async () => {
    const pem = core.parseX509(TEST_PEM);
    assert.equal(pem.success, true);
    assert.equal(pem.subject, 'test.example.com');
    assert.equal(pem.subjectDN, 'CN=test.example.com, O=SOMP Test');
    assert.equal(pem.issuer, 'test.example.com');
    assert.equal(pem.validFrom, '2026-10-28');
    assert.equal(pem.validTo, '2036-10-25');
    assert.equal(pem.notAfter, '2036-10-25T10:07:30.000Z');
    assert.deepEqual(pem.san, ['DNS:test.example.com', 'DNS:www.test.example.com', 'IP:10.0.0.5']);
    assert.equal(pem.fingerprint256, FP);

    // content decides: a ".cer" upload that is DER, a ".der" upload that is PEM
    const der = await core.parseUpload(core.decodeUpload(TEST_DER.toString('base64'), 'CER'), '');
    assert.equal(der.success, true);
    assert.equal(der.format, 'DER');
    assert.equal(der.fingerprint256, FP);
    const pemAsDer = await core.parseUpload(core.decodeUpload(Buffer.from(TEST_PEM).toString('base64'), 'DER'), '');
    assert.equal(pemAsDer.format, 'PEM');

    let psCalls = 0;
    core.setHooks({ runPowerShell: async () => { psCalls++; return ''; } });
    await core.parseUpload(core.decodeUpload(TEST_DER.toString('base64'), 'PEM'), '');
    assert.equal(psCalls, 0, 'no PowerShell for PEM / DER');

    const bad = core.parseX509('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----');
    assert.equal(bad.success, false);
    assert.match(bad.error, /could not be parsed/);
    assert.equal(core.parseX509('hello').success, false);
});

test('PFX: constant script, file bytes + password only over stdin; result parsed in Node', async () => {
    const pfxBytes = Buffer.from('fake-pfx-bytes-\'; Remove-Item C:\\ -Recurse; $x=\'');
    const password = "p@ss'word$(evil)";
    const calls = [];
    core.setHooks({
        runPowerShell: async (script, timeout, opts) => {
            calls.push({ script, timeout, opts });
            const json = JSON.stringify({ success: true, der: TEST_DER.toString('base64'), error: '' });
            return 'noise\r\n@@SOMP_RESULT@@' + Buffer.from(json).toString('base64') + '\r\n';
        },
    });
    const r = await core.parseUpload(core.decodeUpload(pfxBytes.toString('base64'), 'P12'), password);
    assert.equal(r.success, true);
    assert.equal(r.format, 'PFX');
    assert.equal(r.subject, 'test.example.com');
    assert.equal(calls.length, 1);
    const { script, opts } = calls[0];
    assert.equal(script, core.PFX_SCRIPT, 'script text is the constant');
    assert.ok(!script.includes(pfxBytes.toString('base64')));
    assert.ok(!script.includes('p@ss'));
    const payload = JSON.parse(Buffer.from(opts.stdin, 'base64').toString('utf8'));
    assert.deepEqual(payload, { file: pfxBytes.toString('base64'), password });

    core.setHooks({ runPowerShell: async () => '@@SOMP_RESULT@@' + Buffer.from(JSON.stringify({ success: false, error: 'The specified network password is not correct.' })).toString('base64') });
    const wrong = await core.parseUpload(core.decodeUpload('AAAA', 'PFX'), 'x');
    assert.equal(wrong.success, false);
    assert.match(wrong.error, /password is not correct/);
    core.setHooks({ runPowerShell: async () => { throw { stderr: 'powershell missing' }; } });
    assert.match((await core.parsePfx(Buffer.from('x'), '')).error, /powershell missing/);
});

// ---------------------------------------------------------------- status model
test('daysUntil / computeStatus: expired < 0 <= warning <= threshold < active; unknown -> error/-999', () => {
    const now = new Date('2026-01-10T12:00:00Z');
    const at = (iso) => ({ notAfter: iso });
    assert.deepEqual(core.computeStatus(at('2026-03-01T00:00:00Z'), now, 30), { daysRemaining: 49, status: 'active' });
    assert.deepEqual(core.computeStatus(at('2026-02-09T12:00:00Z'), now, 30), { daysRemaining: 30, status: 'warning' });
    assert.deepEqual(core.computeStatus(at('2026-02-10T12:00:01Z'), now, 30), { daysRemaining: 31, status: 'active' });
    assert.deepEqual(core.computeStatus(at('2026-01-10T13:00:00Z'), now, 30), { daysRemaining: 0, status: 'warning' });
    assert.deepEqual(core.computeStatus(at('2026-01-10T11:00:00Z'), now, 30), { daysRemaining: -1, status: 'expired' });
    assert.deepEqual(core.computeStatus({ validTo: '2026-01-01' }, now, 30), { daysRemaining: -10, status: 'expired' });
    assert.deepEqual(core.computeStatus({ validTo: '-' }, now, 30), { daysRemaining: -999, status: 'error' });
    assert.deepEqual(core.computeStatus({}, now, 30), { daysRemaining: -999, status: 'error' });
    // threshold respected
    assert.equal(core.computeStatus(at('2026-01-25T12:00:00Z'), now, 10).status, 'active');
    assert.equal(core.computeStatus(at('2026-01-25T12:00:00Z'), now, 15).status, 'warning');
    // notAfter preferred over the day-only validTo
    assert.equal(core.computeStatus({ validTo: '2020-01-01', notAfter: '2026-03-01T00:00:00Z' }, now, 30).status, 'active');
});

test('thresholdDays: SSL_ALERT_THRESHOLD_DAYS, default 30', () => {
    assert.equal(core.thresholdDays({}), 30);
    assert.equal(core.thresholdDays({ SSL_ALERT_THRESHOLD_DAYS: '45' }), 45);
    assert.equal(core.thresholdDays({ SSL_ALERT_THRESHOLD_DAYS: 'abc' }), 30);
});

test('expiry levels', () => {
    const lv = (d, t = 30) => core.expiryLevel(d, t);
    assert.deepEqual([lv(60), lv(30), lv(15), lv(14), lv(8), lv(7), lv(2), lv(1), lv(0), lv(-1), lv(null)],
        ['ok', 'warn30', 'warn30', 'warn14', 'warn14', 'warn7', 'warn7', 'warn1', 'warn1', 'expired', null]);
    assert.equal(lv(12, 10), 'ok', 'threshold first');
});

// ---------------------------------------------------------------- alert dedupe
test('alerts: same level twice -> one alert; deeper -> alert; expired -> alert; renewal resets', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const exp = '2026-01-20T00:00:00Z';
    let st = null, fc = 0;
    const step = (days, expiry = exp, extra = {}) => {
        const d = core.decideAlerts(st, fc, { days, expiry, threshold: 30, now, ...extra });
        st = d.alertState; fc = d.failCount;
        return d.events.map(e => e.type + ':' + e.level);
    };
    assert.deepEqual(step(60), []);
    assert.deepEqual(step(25), ['expiry:warn30']);
    assert.deepEqual(step(24), [], 'same level: no repeat');
    assert.deepEqual(step(20), []);
    assert.deepEqual(step(13), ['expiry:warn14']);
    assert.deepEqual(step(13), []);
    assert.deepEqual(step(1), ['expiry:warn1'], 'jumping levels alerts once');
    assert.deepEqual(step(-1), ['expired:expired']);
    assert.deepEqual(step(-5), []);
    // renewal: expiry moved forward -> level reset; a renewed cert that is ok does not alert
    assert.deepEqual(step(300, '2027-01-01T00:00:00Z'), []);
    assert.equal(st.level, 'ok');
    assert.deepEqual(step(20, '2027-01-01T00:00:00Z'), ['expiry:warn30'], 'alerts again on the renewed certificate');
});

test('alerts: 2 consecutive probe failures -> one alert; recovery -> one alert; non-probed records never count failures', () => {
    const now = new Date();
    let st = null, fc = 0;
    const step = (probeFailed, probed = true) => {
        const d = core.decideAlerts(st, fc, { days: 100, expiry: '2030-01-01T00:00:00Z', threshold: 30, probed, probeFailed, now });
        st = d.alertState; fc = d.failCount;
        return d.events.map(e => e.type);
    };
    assert.deepEqual(step(true), []);
    assert.equal(fc, 1);
    assert.deepEqual(step(true), ['error']);
    assert.deepEqual(step(true), []);
    assert.deepEqual(step(true, false), [], 'not probed: unchanged');
    assert.equal(fc, 3);
    assert.deepEqual(step(false), ['recovered']);
    assert.deepEqual(step(false), []);
    assert.deepEqual(step(true), []);
    assert.deepEqual(step(false), [], 'single failure then success: no recovery alert');
});

// ---------------------------------------------------------------- trust
test('trust: authorized + hostname ok -> trusted; untrusted chain, hostname mismatch, expired intermediate reported', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const root = { subject: { CN: 'Root' }, valid_to: 'Jan  1 00:00:00 2035 GMT', fingerprint256: 'R' };
    root.issuerCertificate = root;
    const inter = { subject: { CN: 'Inter CA' }, valid_to: 'Jan  1 00:00:00 2026 GMT', fingerprint256: 'I', issuerCertificate: root };
    const leaf = { subject: { CN: 'a.com' }, subjectaltname: 'DNS:a.com', valid_to: 'Jan  1 00:00:00 2027 GMT', fingerprint256: 'L', issuerCertificate: root };
    const ok = core.evaluateTrust({ host: 'a.com', authorized: true, cert: leaf, now });
    assert.equal(ok.trusted, true);
    assert.equal(ok.trustError, '');
    assert.equal(ok.hostnameChecked, true);

    const mismatch = core.evaluateTrust({ host: 'b.com', authorized: true, cert: leaf, now });
    assert.equal(mismatch.trusted, false);
    assert.match(mismatch.trustError, /b\.com/);

    const selfSigned = core.evaluateTrust({ host: 'a.com', authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', cert: leaf, now });
    assert.equal(selfSigned.trusted, false);
    assert.match(selfSigned.trustError, /SELF_SIGNED/);

    const chained = core.evaluateTrust({ host: 'a.com', authorized: true, cert: { ...leaf, issuerCertificate: inter }, now });
    assert.equal(chained.trusted, false);
    assert.deepEqual(chained.expiredChain, ['Inter CA (2026-01-01)']);

    // IP host and no IP SAN: hostname check skipped (documented)
    const ip = core.evaluateTrust({ host: '10.0.0.9', authorized: true, cert: leaf, now });
    assert.equal(ip.hostnameChecked, false);
    assert.equal(ip.trusted, true);
    // IP host with IP SANs: checked
    const ipSan = core.evaluateTrust({ host: '10.0.0.9', authorized: true, cert: { ...leaf, subjectaltname: 'DNS:a.com, IP Address:10.0.0.5' }, now });
    assert.equal(ipSan.hostnameChecked, true);
    assert.equal(ipSan.trusted, false);
});

// ---------------------------------------------------------------- projection
test('publicRecord hides encrypted fields, adds has* flags and computes status at read time', () => {
    const rec = { id: '1', name: 'n', host: 'File Backup Only', certText: TEST_PEM, encryptedKey: 'k', encryptedPass: 'p', encryptedFile: 'f', notAfter: new Date(Date.now() + 10 * core.DAY_MS + 3600e3).toISOString(), daysRemaining: -999, status: 'error' };
    const out = core.publicRecord(rec, new Date(), 30);
    for (const f of ['encryptedKey', 'encryptedPass', 'encryptedFile']) assert.equal(f in out, false, f);
    assert.equal(out.hasKey, true);
    assert.equal(out.hasFile, true);
    assert.equal(out.hasCertText, true);
    assert.equal(out.fileOnly, true);
    assert.equal(out.daysRemaining, 10);
    assert.equal(out.status, 'warning');
    assert.equal(rec.encryptedKey, 'k', 'input untouched');
    const none = core.publicRecord({ id: '2', host: 'a.com' });
    assert.deepEqual([none.hasKey, none.hasFile, none.hasCertText, none.status], [false, false, false, 'error']);
});
