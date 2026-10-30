require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TELEGRAM_BOT_TOKEN = 'tok1';
delete process.env.TELEGRAM_LISTENER_ENABLED;
const tl = require('../../services/telegramListener');

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const pending = new Map(); // handle -> callback // live 1000 ms timers (poll loop schedule / restart wait)
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };

const fireNextTimer = () => {
    const [h, fn] = [...pending][0];
    realClearTimeout(h);
    pending.delete(h);
    fn();
};

let urls;
test.before(() => {
    global.setTimeout = (fn, ms, ...args) => {
        if (ms !== 1000) return realSetTimeout(fn, ms, ...args);
        const h = realSetTimeout(() => { pending.delete(h); fn(...args); }, ms);
        pending.set(h, () => fn(...args));
        return h;
    };
    global.clearTimeout = (h) => { pending.delete(h); return realClearTimeout(h); };
});
test.after(() => {
    tl.stopTelegramListener();
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    tl.__test.setFetch(null);
});
test.beforeEach(() => {
    tl.stopTelegramListener();
    pending.clear();
    urls = [];
    process.env.TELEGRAM_BOT_TOKEN = 'tok1';
    tl.__test.setFetch(async (url) => {
        urls.push(url);
        return { ok: true, result: [] };
    });
});

test('init twice leaves exactly one active poll timer', async () => {
    await tl.initTelegramListener();
    await settle();
    assert.equal(pending.size, 1);
    await tl.initTelegramListener(); // restart path (1 s wait inside)
    await settle();
    assert.equal(pending.size, 1);
    assert.equal(tl.__test.state().isPolling, true);
    tl.stopTelegramListener();
    assert.equal(pending.size, 0);
    assert.equal(tl.__test.state().hasTimer, false);
});

test('overlapping init calls (no await between) still leave a single poll loop', async () => {
    await Promise.all([tl.initTelegramListener(), tl.initTelegramListener()]);
    await settle();
    assert.equal(pending.size, 1);
    tl.stopTelegramListener();
    await settle();
    assert.equal(pending.size, 0);
});

test('a token change resets the stored update offset; the same token keeps it', async () => {
    let served = false;
    tl.__test.setFetch(async (url) => {
        urls.push(url);
        const result = served ? [] : [{ update_id: 41 }];
        served = true;
        return { ok: true, result };
    });
    await tl.initTelegramListener();
    await settle();
    assert.match(urls[0], /bot[^/]*tok1\/getUpdates\?offset=\d+&timeout=0/);
    assert.equal(tl.__test.state().lastUpdateId, 42);
    tl.stopTelegramListener();

    urls.length = 0;
    await tl.initTelegramListener();
    assert.match(urls[0], /offset=42&timeout=0/, 'same bot keeps its offset');
    tl.stopTelegramListener();

    urls.length = 0;
    process.env.TELEGRAM_BOT_TOKEN = 'tok2';
    await tl.initTelegramListener();
    assert.match(urls[0], /tok2\/getUpdates\?offset=0&timeout=0/, 'new bot starts from offset 0');
    assert.equal(tl.__test.state().lastUpdateId, 0);
    tl.stopTelegramListener();
});

test('the poll loop keeps the token captured at init even if the env token changes without a reload', async () => {
    await tl.initTelegramListener();
    await settle();
    process.env.TELEGRAM_BOT_TOKEN = 'tok9'; // changed in env, no RELOAD_TELEGRAM_LISTENER yet
    urls.length = 0;
    fireNextTimer();
    await settle();
    assert.equal(urls.length, 1);
    assert.match(urls[0], /bot[^/]*tok1\/getUpdates/);
    assert.ok(!urls[0].includes('tok9'));
    tl.stopTelegramListener();
});

test('the HTTP request timeout is the long-poll interval plus 10 seconds', async () => {
    const timeouts = [];
    tl.__test.setFetch(async (url, timeoutMs) => { timeouts.push({ url, timeoutMs }); return { ok: true, result: [] }; });
    const saved = process.env.TELEGRAM_POLL_INTERVAL;
    try {
        delete process.env.TELEGRAM_POLL_INTERVAL;
        assert.equal(tl.__test.requestTimeoutMs(), 40000);
        process.env.TELEGRAM_POLL_INTERVAL = '60';
        assert.equal(tl.__test.requestTimeoutMs(), 70000);
        await tl.initTelegramListener();
        await settle();
        const flush = timeouts.find(t => /timeout=0/.test(t.url));
        const poll = timeouts.find(t => /timeout=60/.test(t.url));
        assert.equal(flush.timeoutMs, 10000);
        assert.equal(poll.timeoutMs, 70000);
    } finally {
        if (saved === undefined) delete process.env.TELEGRAM_POLL_INTERVAL; else process.env.TELEGRAM_POLL_INTERVAL = saved;
        tl.stopTelegramListener();
    }
});
