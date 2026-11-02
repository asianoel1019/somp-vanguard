const { test } = require('node:test');
const assert = require('node:assert');
const { maskHeaders, maskUrl, logWebhookFailure } = require('../../services/webhookService');

const BEARER = 'eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LXBheWxvYWQ.s1gn4ture';
const SIG = 'AbCdEf0123456789XyZsecretSig';

test('maskHeaders: credential-like values masked, auth scheme and other headers kept', () => {
    assert.deepEqual(maskHeaders({
        Authorization: `Bearer ${BEARER}`,
        'Proxy-Authorization': 'Basic dXNlcjpwYXNz',
        'X-API-Key': 'k-123',
        'X-Auth-Token': 't-456',
        Cookie: 'sid=abc',
        'Content-Type': 'application/json',
        Host: 'hooks.example.com',
        'Content-Length': 42
    }), {
        Authorization: 'Bearer ***',
        'Proxy-Authorization': 'Basic ***',
        'X-API-Key': '***',
        'X-Auth-Token': '***',
        Cookie: '***',
        'Content-Type': 'application/json',
        Host: 'hooks.example.com',
        'Content-Length': 42
    });
    assert.deepEqual(maskHeaders(undefined), {});
});

test('maskUrl: query secrets, user info and token path segments are masked; host and plain path kept', () => {
    assert.equal(
        maskUrl(`https://prod.example.com/workflows/0123456789abcdef0123456789abcdef/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers&sig=${SIG}`),
        'https://prod.example.com/workflows/***/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers&sig=***');
    assert.equal(maskUrl('https://hooks.example.com/services/T0000000/B0000000/XXXXXXXXXXXXXXXXXXXXXXXX'),
        'https://hooks.example.com/services/T0000000/B0000000/***');
    assert.equal(maskUrl('https://api.example.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage?chat_id=-100123'),
        'https://api.example.org/***/sendMessage?chat_id=-100123');
    assert.equal(maskUrl('http://user:pa55@proxy.example.com:3128'), 'http://***:***@proxy.example.com:3128/');
    assert.equal(maskUrl('https://hooks.example.com/notify?token=abc&channel=ops'), 'https://hooks.example.com/notify?token=***&channel=ops');
    assert.equal(maskUrl('not a url with secret'), '***');
    assert.equal(maskUrl(''), '');
});

test('logWebhookFailure: neither the log dump nor the debug object contains a secret', (t) => {
    const lines = [];
    t.mock.method(console, 'error', (...a) => { lines.push(a.join(' ')); });
    const debug = logWebhookFailure(
        { name: 'Teams', id: 'w1', url: `https://prod.example.com/hook?sig=${SIG}` },
        { method: 'POST', headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json' } },
        '{"text":"alert"}', 'http://u:proxypass@proxy.example.com:8080', 'HTTP 500');
    const dump = lines.join('\n');
    for (const secret of [BEARER, SIG, 'proxypass']) {
        assert.ok(!dump.includes(secret), `dump leaks ${secret}`);
        assert.ok(!JSON.stringify(debug).includes(secret), `debug leaks ${secret}`);
    }
    assert.equal(debug.headers.Authorization, 'Bearer ***');
    assert.equal(debug.targetUrl, 'https://prod.example.com/hook?sig=***');
    assert.equal(debug.payloadBody, '{"text":"alert"}');
    assert.match(dump, /\[WebhookHub\] Dispatch failure dump/);
});
