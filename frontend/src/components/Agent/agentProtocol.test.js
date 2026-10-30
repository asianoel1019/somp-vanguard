import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSseBuffer, buildAlertPrompt } from './agentProtocol.js';

test('parses complete events and keeps the incomplete tail', () => {
    const buf = 'event: conversation\ndata: {"conversationId":"c1"}\n\nevent: step_start\ndata: {"id":"s1"}\n\nevent: ans';
    const { events, rest } = parseSseBuffer(buf);
    assert.deepEqual(events, [
        { event: 'conversation', data: { conversationId: 'c1' } },
        { event: 'step_start', data: { id: 's1' } },
    ]);
    assert.equal(rest, 'event: ans');
});

test('handles CRLF, multi-line data and non-JSON data', () => {
    const { events } = parseSseBuffer('event: x\r\ndata: line1\r\ndata: line2\r\n\r\n');
    assert.deepEqual(events, [{ event: 'x', data: 'line1\nline2' }]);
});

test('defaults event name to message and skips empty blocks', () => {
    const { events } = parseSseBuffer('\n\ndata: {"a":1}\n\n');
    assert.deepEqual(events, [{ event: 'message', data: { a: 1 } }]);
});

test('heartbeat comments are ignored', () => {
    const { events, rest } = parseSseBuffer(': ping\n\nevent: done\ndata: {}\n\n: ping\n\n');
    assert.deepEqual(events, [{ event: 'done', data: {} }]);
    assert.equal(rest, '');
});

test('buildAlertPrompt includes host, type, target, value and threshold', () => {
    const p = buildAlertPrompt({ type: 'cpu', target: 'cpu', value: '97', threshold: 90, triggeredAt: '2026-10-08T06:32:00Z' }, 'web-03');
    assert.match(p, /web-03/);
    assert.match(p, /cpu/);
    assert.match(p, /97/);
    assert.match(p, /90/);
    assert.match(p, /^調查這筆告警/);
});
