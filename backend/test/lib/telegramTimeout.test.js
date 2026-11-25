// A Telegram call that never gets an answer must settle (false) after telegramTiming.timeoutMs and free its sockets.
// Only local stub servers on 127.0.0.1 and mocked https.get are used: nothing reaches Telegram.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const https = require('https');
const { EventEmitter } = require('events');
const logger = require('../../lib/logger');

const KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PROXY_ENABLED_MODULES'];
let saved, savedProxy, savedTimeout;

test.beforeEach(() => {
    saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
    savedProxy = global.SYSTEM_PROXY;
    savedTimeout = logger.telegramTiming.timeoutMs;
    process.env.TELEGRAM_BOT_TOKEN = '123:TEST';
    process.env.TELEGRAM_CHAT_ID = '-100';
    delete process.env.PROXY_ENABLED_MODULES;
    logger.telegramTiming.timeoutMs = 150;
});
test.afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    global.SYSTEM_PROXY = savedProxy;
    logger.telegramTiming.timeoutMs = savedTimeout;
});

/** A TCP server on 127.0.0.1 that accepts connections and never answers (optionally after a CONNECT 200). */
async function stubProxy(t, { answerConnect = false } = {}) {
    const sockets = [];
    let closed = 0;
    const server = net.createServer((socket) => {
        sockets.push(socket);
        socket.on('close', () => { closed++; });
        socket.on('error', () => {});
        if (answerConnect) socket.once('data', () => socket.write('HTTP/1.1 200 Connection established\r\n\r\n'));
        socket.resume(); // read (and ignore) everything, so the client's close is seen
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
    process.env.PROXY_ENABLED_MODULES = 'Telegram';
    global.SYSTEM_PROXY = `http://127.0.0.1:${server.address().port}`;
    return { accepted: () => sockets.length, closed: () => closed };
}

const logText = () => { try { return fs.readFileSync(logger.getTodayLogFile(), 'utf8'); } catch { return ''; } };
const waitFor = async (fn, ms = 1000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); };

test('a proxy that never answers CONNECT: false after the timeout, the connection is closed', async (t) => {
    const proxy = await stubProxy(t);
    const started = Date.now();
    assert.equal(await logger.sendTelegramChecked('hello', { ignoreLicense: true }), false);
    assert.ok(Date.now() - started >= 100, 'waited for the timeout');
    assert.equal(proxy.accepted(), 1);
    await waitFor(() => proxy.closed() === 1);
    assert.equal(proxy.closed(), 1, 'the stalled connection was destroyed');
    assert.match(logText(), /Telegram alert timed out after 150 ms/);
});

test('a proxy that answers CONNECT but then stalls the TLS handshake: false after the timeout', async (t) => {
    const proxy = await stubProxy(t, { answerConnect: true });
    assert.equal(await logger.sendTelegramChecked('hello', { ignoreLicense: true }), false);
    await waitFor(() => proxy.closed() === 1);
    assert.equal(proxy.closed(), 1);
});

test('a direct request that never answers is destroyed and resolves false', async (t) => {
    let destroyed = 0;
    t.mock.method(https, 'get', () => { const req = new EventEmitter(); req.destroy = () => { destroyed++; }; return req; });
    assert.equal(await logger.sendTelegramChecked('hello', { ignoreLicense: true }), false);
    assert.equal(destroyed, 1);
});

test('a response closed before its end resolves false at once', async (t) => {
    t.mock.method(https, 'get', (url, cb) => {
        const res = new EventEmitter(); res.statusCode = 200;
        setImmediate(() => { cb(res); res.emit('close'); });
        return new EventEmitter();
    });
    logger.telegramTiming.timeoutMs = 60000;
    const started = Date.now();
    assert.equal(await logger.sendTelegramChecked('hello', { ignoreLicense: true }), false);
    assert.ok(Date.now() - started < 5000);
});

test('a normal reply still resolves true', async (t) => {
    t.mock.method(https, 'get', (url, cb) => {
        const res = new EventEmitter(); res.statusCode = 200;
        setImmediate(() => { cb(res); res.emit('end'); res.emit('close'); });
        return new EventEmitter();
    });
    assert.equal(await logger.sendTelegramChecked('hello', { ignoreLicense: true }), true);
});
