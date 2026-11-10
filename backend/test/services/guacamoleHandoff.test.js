require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const GuacamoleLite = require('guacamole-lite');
const Crypt = require('guacamole-lite/lib/Crypt');
const proxy = require('../../services/guacamoleProxy');

const payload = { connection: { type: 'ssh', settings: { hostname: 'host01.example.test' } }, audit: { user: 'op1' } };

test('guacamole-lite gets the verified settings by handoff id: peeked to route, then taken to connect', () => {
    const id = proxy._handoff.putHandoff(payload);
    const routed = GuacamoleLite.prototype.decryptToken.call({}, id);
    assert.equal(routed.connection.settings.hostname, 'host01.example.test');
    routed.connection.settings.hostname = 'changed'; // guacamole-lite mutates what it gets
    const taken = Crypt.prototype.decrypt.call({}, id);
    assert.equal(taken.connection.settings.hostname, 'host01.example.test', 'each read is a fresh copy');
    assert.throws(() => Crypt.prototype.decrypt.call({}, id), /Unknown or expired/);
    assert.throws(() => GuacamoleLite.prototype.decryptToken.call({}, 'not-an-id'), /Unknown or expired/);
});

test('only valid display settings travel next to the handoff id', () => {
    const q = new URLSearchParams('token=client-token&width=1600&height=900&dpi=96&hostname=evil.example.test&port=25&audio=x&width2=1');
    assert.equal(proxy._handoff.handoffUrl('abc', q), '/guacamole?token=abc&width=1600&height=900&dpi=96');
    const bad = new URLSearchParams('width=99999&height=-1&dpi=96px');
    assert.equal(proxy._handoff.handoffUrl('abc', bad), '/guacamole?token=abc');
});

test('the guacd host is the configured one', () => {
    process.env.GUACD_HOST = 'guacd.example.test';
    try {
        assert.equal(proxy.getEffectiveGuacdHost(), 'guacd.example.test');
    } finally {
        delete process.env.GUACD_HOST;
    }
    assert.equal(proxy.getEffectiveGuacdHost(), '127.0.0.1');
});
