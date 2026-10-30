const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dbModule = require('../../lib/db');

test('writeDataSync does not create a flat file when the local SQLite write succeeds', () => {
    assert.ok(dbModule.db, 'local db expected');
    dbModule.writeDataSync('flat_test/ok.json', { a: 1 });
    assert.equal(fs.existsSync(path.join(dataDir, 'flat_test_ok.json')), false);
    assert.deepEqual(dbModule.readDataSync('flat_test/ok.json', null), { a: 1 });
});

test('writeDataSync writes the flat file when the local SQLite write fails', () => {
    const original = dbModule.db.prepare;
    dbModule.db.prepare = () => { throw new Error('boom'); };
    const warn = console.warn;
    console.warn = () => {};
    try {
        dbModule.writeDataSync('flat_test/fail.json', { b: 2 });
    } finally {
        dbModule.db.prepare = original;
        console.warn = warn;
    }
    const f = path.join(dataDir, 'flat_test_fail.json');
    assert.equal(fs.existsSync(f), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { b: 2 });
});

test('writeDataSync in a forked child notifies the supervisor (DOC_CACHE_UPDATED)', () => {
    const sent = [];
    process.send = (m) => { sent.push(m); return true; };
    try {
        dbModule.writeDataSync('flat_test/ipc.json', { c: 3 });
    } finally {
        delete process.send;
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'DOC_CACHE_UPDATED');
    assert.equal(sent[0].key, 'flat_test/ipc.json');
    assert.equal(sent[0].data, undefined);
});

test('writeDataSync does not send DOC_CACHE_UPDATED when running as the supervisor', () => {
    const sent = [];
    process.send = (m) => { sent.push(m); return true; };
    global.sendWorkerMessage = () => true;
    try {
        dbModule.writeDataSync('flat_test/ipc2.json', { d: 4 });
    } finally {
        delete process.send;
        delete global.sendWorkerMessage;
    }
    assert.equal(sent.length, 0);
});

test('index.js handles DOC_CACHE_UPDATED from the worker via invalidateCache', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
    assert.match(src, /msg\.type === 'DOC_CACHE_UPDATED'[\s\S]{0,200}invalidateCache\(msg\.key\)/);
    assert.doesNotMatch(src, /DOC_CACHE_UPDATED[\s\S]{0,200}sendWorkerMessage/);
});
