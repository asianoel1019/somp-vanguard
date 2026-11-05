// SSH command layer against an in-process ssh2 server that behaves like a Cisco IOS CLI.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Server, utils } = require('ssh2');
const sshCli = require('../../lib/netDevices/sshCli');

const PASSWORD = 'sw-password-123';
const ENABLE = 'sw-enable-456';
const OUTPUT = {
    'show version': 'Cisco IOS XE Software, Version 17.09.04a\nsw1 uptime is 1 week, 2 days\n',
    'show clock': '*10:00:00.000 UTC Wed Nov 5 2026\n',
    'show running-config': 'Building configuration...\n\nhostname sw1\n!\nend\n',
    'show bogus': "                    ^\n% Invalid input detected at '^' marker.\n",
    'show denied': '% Authorization failed.\n',
};

let hostKey = utils.generateKeyPairSync('ed25519').private;
let startLevel = '>';
let slow = false;
let big = 0;
let sessions = 0;
let concurrent = 0;
let maxConcurrent = 0;
const received = [];

function fakeIos(stream) {
    let level = startLevel;
    let awaitingEnable = false;
    let line = '';
    const prompt = () => stream.write(`\r\nsw1${level}`);
    stream.write('\r\nUser Access Verification\r\n');
    prompt();
    stream.on('data', (d) => {
        for (const ch of d.toString()) {
            if (ch !== '\n' && ch !== '\r') { line += ch; continue; }
            if (ch === '\r') continue;
            const cmd = line.trim();
            line = '';
            if (awaitingEnable) {
                awaitingEnable = false;
                if (cmd === ENABLE) level = '#'; else stream.write('\r\n% Access denied');
                prompt();
                continue;
            }
            received.push(cmd);
            stream.write(`${cmd}\r\n`); // echo
            if (cmd === 'exit') { stream.close(); return; }
            if (cmd === 'enable') { awaitingEnable = true; stream.write('Password: '); continue; }
            if (cmd === 'show slow' && slow) continue; // never answers
            if (cmd === 'show big') { stream.write('x'.repeat(big)); prompt(); continue; }
            if (OUTPUT[cmd] !== undefined) stream.write(OUTPUT[cmd].replace(/\n/g, '\r\n'));
            prompt();
        }
    });
}

let server;
let port;
test.before(async () => {
    server = new Server({ hostKeys: [hostKey] }, (client) => {
        let ready = false;
        client.on('authentication', (ctx) => {
            if (ctx.method === 'password' && ctx.username === 'netro' && ctx.password === PASSWORD) ctx.accept();
            else ctx.reject(['password']);
        });
        client.on('ready', () => {
            sessions += 1;
            ready = true;
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            client.on('session', (accept) => {
                const s = accept();
                s.on('pty', (ok) => ok && ok());
                s.on('shell', (ok) => fakeIos(ok()));
                s.on('exec', (ok, reject, info) => {
                    const stream = ok();
                    stream.write(OUTPUT[info.command] || '');
                    stream.exit(0);
                    stream.end();
                });
            });
        });
        client.on('close', () => { if (ready) concurrent -= 1; });
        client.on('error', () => {});
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
});
test.after(() => { server.close(); sshCli._setHostKeyStore(null); });

function memoryStore() {
    const known = {};
    return { known, read: () => known, mutate: (fn) => fn(known) };
}
let store;
test.beforeEach(() => {
    store = memoryStore();
    sshCli._setHostKeyStore(store);
    startLevel = '>';
    slow = false;
    received.length = 0;
    Object.assign(sshCli.LIMITS, { connectMs: 5000, commandMs: 5000, sessionMs: 10000, maxBytes: 20 * 1024 * 1024 });
});

const profile = (extra = {}) => ({ mgmtHost: '127.0.0.1', sshPort: port, username: 'netro', secrets: { password: PASSWORD, enableSecret: ENABLE }, ...extra });
const WL = Object.keys(OUTPUT).concat(['show slow', 'show big']);
const run = (cmds, p = profile(), opts = {}) => sshCli.runCommands(p, cmds, { whitelist: WL, privileged: ['show running-config'], ...opts });

test('shell: terminal setup, commands split per command without echo or prompt', async () => {
    const r = await run(['show version', 'show clock']);
    assert.deepEqual(received.slice(0, 2), ['terminal length 0', 'terminal width 0']);
    assert.equal(r['show version'], OUTPUT['show version']);
    assert.equal(r['show clock'], OUTPUT['show clock']);
    assert.ok(!received.includes('enable'), 'no enable when nothing privileged is asked');
});

test('enable for privileged commands; without a secret it is FORBIDDEN before sending', async () => {
    const r = await run(['show running-config']);
    assert.match(r['show running-config'], /hostname sw1/);
    assert.ok(received.includes('enable'));
    assert.ok(!received.includes(ENABLE), 'the secret is not recorded as a command');

    received.length = 0;
    await assert.rejects(run(['show running-config'], profile({ secrets: { password: PASSWORD } })), (e) => e.code === 'FORBIDDEN' && /enable password/.test(e.message));
    assert.ok(!received.includes('show running-config'));

    await assert.rejects(run(['show running-config'], profile({ secrets: { password: PASSWORD, enableSecret: 'wrong-secret' } })), (e) => e.code === 'FORBIDDEN' && !e.message.includes('wrong-secret'));

    startLevel = '#';
    received.length = 0;
    await run(['show running-config'], profile({ secrets: { password: PASSWORD } }));
    assert.ok(!received.includes('enable'), 'already privileged');
});

test('whitelist: anything else is refused before connecting', async () => {
    const before = sessions;
    await assert.rejects(run(['configure terminal']), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(run(['show version\nreload']), (e) => e.code === 'BAD_REQUEST');
    await assert.rejects(sshCli.runCommands(profile(), ['show version'], {}), (e) => e.code === 'BAD_REQUEST');
    assert.equal(sessions, before);
});

test('device messages: invalid input is UNSUPPORTED, authorization failure is FORBIDDEN', async () => {
    await assert.rejects(run(['show bogus']), (e) => e.code === 'UNSUPPORTED');
    await assert.rejects(run(['show denied']), (e) => e.code === 'FORBIDDEN');
});

test('wrong password is AUTH and never quoted', async () => {
    await assert.rejects(run(['show version'], profile({ secrets: { password: 'bad-password-xyz' } })), (e) => e.code === 'AUTH' && e.status === 502 && !e.message.includes('bad-password-xyz'));
});

test('host key pinned on first use; a different key is HOSTKEY; forget lets it pin again', async () => {
    await run(['show clock']);
    const id = sshCli.hostKeyId(profile());
    assert.equal(id, `127.0.0.1:${port}`);
    assert.match(store.known[id].fingerprint, /^sha256:/);
    store.known[id].fingerprint = 'sha256:0000';
    await assert.rejects(run(['show clock']), (e) => e.code === 'HOSTKEY' && e.status === 502);
    assert.equal(sshCli.forgetHostKey(profile()), true);
    await run(['show clock']);
    assert.equal(sshCli.hostKeyId({ mgmtHost: '192.0.2.1', sshPort: 22 }), '192.0.2.1');
});

test('limits: a command that never finishes, too much output, unreachable', async () => {
    slow = true;
    sshCli.LIMITS.commandMs = 300;
    await assert.rejects(run(['show slow']), (e) => e.code === 'UNREACHABLE');
    sshCli.LIMITS.commandMs = 5000;
    sshCli.LIMITS.maxBytes = 10000;
    big = 50000;
    await assert.rejects(run(['show big']), (e) => e.code === 'OTHER' && /MB/.test(e.message));
    sshCli.LIMITS.connectMs = 1000;
    await assert.rejects(run(['show clock'], profile({ sshPort: 1 })), (e) => e.code === 'UNREACHABLE');
});

test('one session per device at a time', async () => {
    maxConcurrent = 0;
    const r = await Promise.all([run(['show clock']), run(['show version']), run(['show clock'])]);
    assert.equal(r.length, 3);
    assert.equal(maxConcurrent, 1);
});

test('exec mode (NX-OS / Junos style)', async () => {
    const r = await run(['show version'], profile(), { mode: 'exec' });
    assert.equal(r['show version'], OUTPUT['show version']);
});

test('optional commands the device does not offer give null instead of failing the session', async () => {
    const r = await run(['show bogus', 'show clock'], profile(), { optional: ['show bogus'] });
    assert.equal(r['show bogus'], null);
    assert.equal(r['show clock'], OUTPUT['show clock']);
});
