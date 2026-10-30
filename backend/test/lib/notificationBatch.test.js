require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const webhookService = require('../../services/webhookService');
const logger = require('../../lib/logger');

const { queueNotification, auditLogBatched, flushAllNotifyBatches, summarizeLines, notifyBatchTiming } = logger;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function capture(t) {
    const sent = [];
    t.mock.method(webhookService, 'triggerWebhooks', (message, moduleName, category) => sent.push({ message, moduleName, category }));
    return sent;
}

test.beforeEach(() => {
    flushAllNotifyBatches();
    notifyBatchTiming.quietMs = 40;
    notifyBatchTiming.maxWaitMs = 200;
});

const render = (items) => items.length === 1 ? `single ${items[0]}` : `batch ${items.length}: ${items.join(',')}`;

test('a burst of items under one key becomes a single summary notification', async (t) => {
    const sent = capture(t);
    for (let i = 1; i <= 50; i++) queueNotification('prom', 'Prometheus', `10.0.0.${i}`, render);
    assert.equal(sent.length, 0, 'nothing is sent while the burst is still going');
    await wait(80);
    assert.equal(sent.length, 1);
    assert.match(sent[0].message, /^batch 50: 10\.0\.0\.1,/);
    assert.equal(sent[0].category, 'Prometheus');
});

test('a single item keeps its single-event message', async (t) => {
    const sent = capture(t);
    queueNotification('prom', 'Prometheus', '10.0.0.9', render);
    await wait(80);
    assert.deepEqual(sent.map(s => s.message), ['single 10.0.0.9']);
});

test('different keys are batched separately', async (t) => {
    const sent = capture(t);
    queueNotification('a', 'Prometheus', 1, render);
    queueNotification('b', 'Prometheus', 2, render);
    queueNotification('a', 'Prometheus', 3, render);
    await wait(80);
    assert.deepEqual(sent.map(s => s.message).sort(), ['batch 2: 1,3', 'single 2']);
});

test('a never-ending stream is still flushed after maxWaitMs', async (t) => {
    const sent = capture(t);
    const started = Date.now();
    while (Date.now() - started < 320) {
        queueNotification('stream', 'Prometheus', 'x', render);
        await wait(15);
    }
    assert.ok(sent.length >= 1, 'flushed at least once during the stream');
    assert.ok(sent.length <= 3, `not one message per item (got ${sent.length})`);
});

test('auditLogBatched merges notifications per user+module with the existing audit formats', async (t) => {
    const sent = capture(t);
    auditLogBatched('SYSTEM', 'Prometheus Target', 'Updated target IP: 10.0.0.1');
    auditLogBatched('SYSTEM', 'Prometheus Target', 'Updated target IP: 10.0.0.2');
    auditLogBatched('OpenAPI-sync', 'Prometheus Target', 'Deleted target IP: 10.0.0.3');
    await wait(80);
    const systemMsg = sent.find(s => s.message.includes('User: SYSTEM'));
    const apiMsg = sent.find(s => s.message.includes('User: OpenAPI-sync'));
    assert.equal(sent.length, 2);
    assert.match(systemMsg.message, /\[SYS Batch Audit\][\s\S]*Actions \(2\):\nUpdated target IP: 10\.0\.0\.1\nUpdated target IP: 10\.0\.0\.2/);
    assert.match(apiMsg.message, /^🚨 \[SYS Audit\][\s\S]*Action: Deleted target IP: 10\.0\.0\.3$/);
});

test('summarizeLines caps long lists', () => {
    assert.equal(summarizeLines(['a', 'b']), '• a\n• b');
    const long = summarizeLines(Array.from({ length: 25 }, (_, i) => `h${i}`));
    assert.equal(long.split('\n').length, 21);
    assert.match(long, /\.\.\. 及其他 5 筆$/);
});
