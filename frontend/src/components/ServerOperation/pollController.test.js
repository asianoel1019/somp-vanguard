import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoller } from './pollController.js';

function harness(script, opts = {}) {
    const timers = [];
    const calls = { light: 0, full: 0, data: [], full_: [], lost: 0, notFound: 0, active: [], fullErr: 0 };
    let hidden = false;
    const p = createPoller({
        fetchLight: () => { calls.light++; return script.shift()(); },
        fetchFull: () => { calls.full++; return opts.fullFails ? Promise.reject(new Error('x')) : Promise.resolve({ job: { running: false }, full: true }); },
        isHidden: () => hidden,
        setTimer: (fn) => { const t = { fn, cleared: false }; timers.push(t); return t; },
        clearTimer: (t) => { t.cleared = true; },
        onData: d => calls.data.push(d), onFull: d => calls.full_.push(d), onFullError: () => calls.fullErr++,
        onLost: () => calls.lost++, onNotFound: () => calls.notFound++, onActive: a => calls.active.push(a)
    });
    const live = () => timers.filter(t => !t.cleared && !t.fired);
    const fire = async () => { const t = live()[0]; t.fired = true; await t.fn(); };
    return { p, calls, timers, live, fire, setHidden: v => { hidden = v; } };
}
const running = () => Promise.resolve({ job: { running: true } });
const done = () => Promise.resolve({ job: { running: false } });
const fail = () => Promise.reject(new Error('net'));

test('runs one chain, then a single full fetch at the end and reports inactive', async () => {
    const h = harness([running, running, done]);
    await h.p.start();
    assert.equal(h.live().length, 1);
    await h.fire();
    await h.fire();
    assert.equal(h.calls.light, 3);
    assert.equal(h.calls.full, 1);
    assert.equal(h.live().length, 0);
    assert.deepEqual(h.calls.active, [true, false]);
    assert.equal(h.p.resume(), false);
});

test('resume while a request is in flight does not start a second poll', async () => {
    let release;
    const slow = () => new Promise(r => { release = () => r({ job: { running: true } }); });
    const h = harness([running, slow, running]);
    await h.p.start();
    const firing = h.fire();           // second poll now in flight
    assert.equal(h.p.state().inFlight, true);
    assert.equal(h.p.resume(), false);
    assert.equal(h.calls.light, 2);
    release();
    await firing;
    assert.equal(h.live().length, 1);
});

test('resume with a pending timer polls immediately and keeps a single timer', async () => {
    const h = harness([running, running]);
    await h.p.start();
    assert.equal(h.p.resume(), true);
    await new Promise(r => setImmediate(r));
    assert.equal(h.calls.light, 2);
    assert.equal(h.live().length, 1);
});

test('after lost or not found the chain stays ended (resume is a no-op)', async () => {
    const h = harness([fail, fail, fail, fail, fail]);
    await h.p.start();
    for (let i = 0; i < 4; i++) await h.fire();
    assert.equal(h.calls.lost, 1);
    assert.equal(h.calls.light, 5);
    assert.equal(h.p.resume(), false);
    assert.equal(h.live().length, 0);
    assert.deepEqual(h.calls.active, [true, false]);

    const nf = harness([() => Promise.reject({ response: { status: 404 } })]);
    await nf.p.start();
    assert.equal(nf.calls.notFound, 1);
    assert.equal(nf.p.resume(), false);
});

test('a success resets the error count; lost needs 5 consecutive errors', async () => {
    const h = harness([fail, fail, fail, fail, running, fail, fail, fail, fail, done]);
    await h.p.start();
    for (let i = 0; i < 8; i++) await h.fire();
    assert.equal(h.calls.lost, 0);
    await h.fire();
    assert.equal(h.calls.full, 1);
});

test('hidden tab pauses requests; stop prevents any later work', async () => {
    const h = harness([running, running]);
    await h.p.start();
    h.setHidden(true);
    await h.fire();
    assert.equal(h.calls.light, 1);
    assert.equal(h.live().length, 1);
    h.p.stop();
    assert.equal(h.live().length, 0);
    assert.equal(h.p.resume(), false);
});

test('a failing full fetch is reported but the chain still ends', async () => {
    const h = harness([done], { fullFails: true });
    await h.p.start();
    assert.equal(h.calls.fullErr, 1);
    assert.deepEqual(h.calls.active, [true, false]);
});
