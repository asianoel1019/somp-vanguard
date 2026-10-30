require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { executeSSH, sftpWrite } = require('../../lib/ssh');
const { checkHostKey, forgetHostKey, listHostKeys, KNOWN_HOSTS_KEY } = require('../../lib/sshHostKeys');
const { readDataSync, writeDataSync } = require('../../lib/db');
const dbManager = require('../../services/db');

test.before(async () => { await dbManager.initDB(); });
test.after(async () => { await dbManager.closeDB(); });

function memStore() {
    let data = {};
    return { read: () => JSON.parse(JSON.stringify(data)), write: (d) => { data = JSON.parse(JSON.stringify(d)); }, get data() { return data; } };
}

// Fake ssh2 Client: runs the host verifier like ssh2 does, only becomes "ready" (credentials accepted) if it passes
function fakeClientFactory(hostHash, log) {
    return () => {
        const c = new EventEmitter();
        c.connect = (cfg) => {
            log.connectCfg = cfg;
            setImmediate(() => {
                if (cfg.hostVerifier && cfg.hostVerifier(hostHash) === false) {
                    return c.emit('error', new Error('Handshake failed: no matching host key'));
                }
                log.authenticated = true;
                c.emit('ready');
            });
            return c;
        };
        c.exec = (cmd, cb) => {
            log.cmd = cmd;
            const stream = new EventEmitter();
            stream.stderr = new EventEmitter();
            stream.end = (data) => { log.stdin = data; };
            cb(null, stream);
            setImmediate(() => stream.emit('close', 0));
        };
        c.end = () => {};
        return c;
    };
}

test('first connection pins the key (TOFU), same key later matches', async () => {
    const store = memStore();
    const log = {};
    const r = await executeSSH('10.0.0.5', 'u', 'p', 'id', { pinHostKey: true, hostKeyStore: store, clientFactory: fakeClientFactory('aa11', log) });
    assert.equal(r.success, true);
    assert.equal(store.data['10.0.0.5'].fingerprint, 'sha256:aa11');
    const r2 = await executeSSH('10.0.0.5', 'u', 'p', 'id', { pinHostKey: true, hostKeyStore: store, clientFactory: fakeClientFactory('aa11', {}) });
    assert.equal(r2.success, true);
});

test('changed host key refuses to authenticate and reports "host key changed"', async () => {
    const store = memStore();
    store.write({ '10.0.0.6': { fingerprint: 'sha256:aa11' } });
    const log = {};
    await assert.rejects(
        executeSSH('10.0.0.6', 'u', 'secret', 'id', { pinHostKey: true, hostKeyStore: store, clientFactory: fakeClientFactory('bb22', log) }),
        (e) => e.code === 'HOST_KEY_CHANGED' && /host key changed/.test(e.message)
    );
    assert.equal(log.authenticated, undefined, 'credentials must not be accepted/sent on mismatch');
    assert.equal(log.cmd, undefined);
    assert.equal(store.data['10.0.0.6'].fingerprint, 'sha256:aa11', 'pin is not overwritten');
});

test('sftpWrite also pins; pinning is opt-in', async () => {
    const store = memStore();
    store.write({ '10.0.0.7': { fingerprint: 'sha256:aa11' } });
    const mk = (hash) => () => {
        const c = new EventEmitter();
        c.connect = (cfg) => { setImmediate(() => ((cfg.hostVerifier && cfg.hostVerifier(hash) === false) ? c.emit('error', new Error('x')) : c.emit('ready'))); };
        c.sftp = (cb) => { const w = new EventEmitter(); w.write = () => {}; w.end = () => setImmediate(() => w.emit('close')); cb(null, { createWriteStream: () => w }); };
        c.end = () => {};
        return c;
    };
    await assert.rejects(sftpWrite('10.0.0.7', 'u', 'p', '/tmp/x', 'data', { pinHostKey: true, hostKeyStore: store, clientFactory: mk('bb22') }), /host key changed/);
    // Without pinHostKey no verifier is installed (legacy callers unchanged)
    await sftpWrite('10.0.0.7', 'u', 'p', '/tmp/x', 'data', { hostKeyStore: store, clientFactory: mk('bb22') });
});

test('stdin option is sent through the exec stream, not the command', async () => {
    const log = {};
    await executeSSH('10.0.0.8', 'u', 'p', "sudo -S -p '' bash /tmp/x.sh", { stdin: 'pw\n', clientFactory: fakeClientFactory('aa', log) });
    assert.equal(log.stdin, 'pw\n');
    assert.ok(!log.cmd.includes('pw'));
});

test('forget / list host keys (document_store backed default store)', () => {
    writeDataSync(KNOWN_HOSTS_KEY, {});
    assert.equal(checkHostKey('10.9.9.9', 'AbC').status, 'new');
    assert.equal(checkHostKey('10.9.9.9', 'abc').status, 'match');
    assert.equal(checkHostKey('10.9.9.9', 'zzz').status, 'mismatch');
    assert.ok(listHostKeys()['10.9.9.9']);
    assert.equal(forgetHostKey('10.9.9.9'), true);
    assert.equal(forgetHostKey('10.9.9.9'), false);
    assert.deepEqual(readDataSync(KNOWN_HOSTS_KEY, null), {});
    assert.equal(checkHostKey('10.9.9.9', 'zzz').status, 'new');
});

test('a failing pin store fails closed (no authentication)', async () => {
    const badStore = { read: () => { throw new Error('db down'); }, write: () => {} };
    const log = {};
    await assert.rejects(
        executeSSH('10.0.0.20', 'u', 'p', 'id', { pinHostKey: true, hostKeyStore: badStore, clientFactory: fakeClientFactory('aa', log) }),
        /host key verification failed/
    );
    assert.equal(log.authenticated, undefined);
});

test('executeSSH execTimeoutMs: a hung command closes the channel and destroys the connection, then rejects', async () => {
    const log = { closed: false, ended: false, destroyed: false };
    const factory = () => {
        const c = new EventEmitter();
        c.connect = () => { setImmediate(() => c.emit('ready')); return c; };
        c.exec = (cmd, cb) => {
            const stream = new EventEmitter();
            stream.stderr = new EventEmitter();
            stream.end = () => {};
            stream.close = () => { log.closed = true; };
            cb(null, stream); // never closes by itself
        };
        c.end = () => { log.ended = true; };
        c.destroy = () => { log.destroyed = true; };
        return c;
    };
    await assert.rejects(executeSSH('10.0.0.30', 'u', 'p', 'hang', { clientFactory: factory, execTimeoutMs: 30 }), /timed out/);
    assert.deepEqual(log, { closed: true, ended: true, destroyed: true });
});
