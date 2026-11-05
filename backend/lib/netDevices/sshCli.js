// SSH command layer of the switch / router drivers (read only). Runs only the commands of the caller's whitelist
// (plus terminal setup and `enable`), never anything typed by a user; host keys are pinned on first use
// (lib/sshHostKeys.js); one session per device at a time (switches have few vty lines); bounded in time and size.
// Errors are classified like the HTTP drivers and never quote the password or enable secret.
const { Client } = require('ssh2');
const { createPinning } = require('../ssh');
const sshHostKeys = require('../sshHostKeys');
const { netError, NetDeviceError } = require('./errors');

const LIMITS = {
    connectMs: 10000,
    commandMs: 30000,
    sessionMs: 60000,
    maxBytes: 20 * 1024 * 1024,
};
const SETUP = { shell: ['terminal length 0', 'terminal width 0'], exec: [] };

let clientFactory = () => new Client();
let hostKeyStore; // undefined = the shared document store
const queues = new Map(); // device key -> tail of its promise chain

// Cisco-style prompt at the end of the buffer: "name>", "name#" (any config mode is never entered)
const PROMPT_RE = /(?:^|\n)([^\s>#]{1,128})([>#])[ \t]*$/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

const hostKeyId = (profile) => {
    const port = Number(profile.sshPort || 22);
    return port === 22 ? String(profile.mgmtHost) : `${profile.mgmtHost}:${port}`;
};

function redact(message, profile) {
    let m = String(message || '');
    const s = (profile && profile.secrets) || {};
    for (const v of [s.password, s.enableSecret]) if (v && String(v).length >= 4) m = m.split(String(v)).join('***');
    return m.slice(0, 300);
}

function classifyConnectError(err, pin, profile) {
    if (err instanceof NetDeviceError) return err;
    if (pin.error) {
        return pin.error.code === 'HOST_KEY_CHANGED'
            ? netError('HOSTKEY', 'The SSH host key of the device changed since it was first seen; the password was not sent. Reset the host key in Connection if the device was replaced.')
            : netError('HOSTKEY', redact(pin.error.message, profile));
    }
    if (err && err.level === 'client-authentication') return netError('AUTH', 'The device rejected the user name or password');
    const code = err && err.code;
    if (['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN'].includes(code)
        || /timed out|handshake/i.test(String(err && err.message))) {
        return netError('UNREACHABLE', `The device did not answer on SSH (${code || 'timeout'})`);
    }
    return netError('OTHER', redact(`SSH failed: ${(err && err.message) || err}`, profile));
}

/** Output problems that IOS-style CLIs report in-band. */
function checkOutput(command, out) {
    if (/% ?Invalid input detected|% ?Invalid command|% ?Unknown command|% ?Incomplete command|syntax error|unknown command/i.test(out)) {
        throw netError('UNSUPPORTED', `The device does not know "${command}"`);
    }
    if (/% ?Authorization failed|(?:% ?|error: )Permission denied|command authorization failed/i.test(out)) {
        throw netError('FORBIDDEN', `The account may not run "${command}"`);
    }
}

/** checkOutput, except that an optional command the device does not offer gives null instead of failing the session. */
function outputOf(command, out, optional) {
    try {
        checkOutput(command, out);
        return out;
    } catch (e) {
        if (optional.includes(command) && (e.code === 'UNSUPPORTED' || e.code === 'FORBIDDEN')) return null;
        throw e;
    }
}

/** One shell session (Cisco IOS): prompt-driven, commands one after the other. */
function runShell(conn, profile, commands, privileged, optional) {
    return new Promise((resolve, reject) => {
        conn.shell({ term: 'vt100', cols: 511, rows: 24 }, (err, stream) => {
            if (err) return reject(netError('OTHER', `SSH shell refused: ${err.message}`));
            let buf = '';
            let total = 0;
            let promptBase = null;
            let level = null; // '>' or '#'
            let waiter = null; // { test(buf) -> boolean, resolve, timer }
            const results = {};
            let failed = false;

            const fail = (e) => {
                if (failed) return;
                failed = true;
                if (waiter) clearTimeout(waiter.timer);
                try { stream.close(); } catch (x) { /* already closed */ }
                reject(e);
            };
            const waitFor = (test, ms, what) => new Promise((res) => {
                waiter = {
                    test, resolve: res,
                    timer: setTimeout(() => fail(netError('UNREACHABLE', `The device did not finish "${what}" within ${Math.round(ms / 1000)} s`)), ms),
                };
                check();
            });
            const atPrompt = (b) => {
                const m = PROMPT_RE.exec(b);
                if (!m) return null;
                if (promptBase && m[1] !== promptBase) return null;
                return m;
            };
            function check() {
                if (!waiter || failed) return;
                // a pager left on despite "terminal length 0"
                if (/--More--\s*$/.test(buf)) { buf = buf.replace(/\s*--More--\s*$/, '\n'); stream.write(' '); return; }
                if (waiter.test(buf)) {
                    const w = waiter;
                    waiter = null;
                    clearTimeout(w.timer);
                    w.resolve();
                }
            }
            stream.on('data', (d) => {
                total += d.length;
                if (total > LIMITS.maxBytes) return fail(netError('OTHER', `The device sent more than ${Math.round(LIMITS.maxBytes / 1048576)} MB`));
                buf += d.toString('utf8').replace(ANSI_RE, '').replace(/\r/g, '');
                check();
            });
            stream.stderr && stream.stderr.on('data', () => { /* ignored */ });
            stream.on('close', () => { if (waiter) fail(netError('UNREACHABLE', 'The device closed the SSH session')); });

            const send = (line) => { buf = ''; stream.write(`${line}\n`); };
            const untilPrompt = () => (b) => !!atPrompt(b);
            /** The output of the last command: without the echoed command line and the closing prompt. */
            const cut = (b, command) => {
                let text = b.replace(PROMPT_RE, '');
                const lines = text.split('\n');
                if (lines.length && lines[0].trim().endsWith(command)) lines.shift();
                text = lines.join('\n');
                return text.replace(/^\n+/, '').replace(/\s+$/, '\n');
            };

            (async () => {
                await waitFor(untilPrompt(), LIMITS.connectMs, 'login');
                const first = atPrompt(buf);
                promptBase = first[1];
                level = first[2];
                for (const setup of SETUP.shell) {
                    send(setup);
                    await waitFor(untilPrompt(), LIMITS.commandMs, setup);
                }
                const needsEnable = level === '>' && commands.some(c => privileged.includes(c));
                if (needsEnable) {
                    const secret = profile.secrets && profile.secrets.enableSecret;
                    if (!secret) throw netError('FORBIDDEN', 'The account logs in below privilege 15 and no enable password is set (needed for the configuration backup)');
                    send('enable');
                    await waitFor((b) => /password:\s*$/i.test(b) || !!atPrompt(b), LIMITS.commandMs, 'enable');
                    if (/password:\s*$/i.test(buf)) {
                        buf = '';
                        stream.write(`${secret}\n`);
                        await waitFor((b) => !!atPrompt(b) || /password:\s*$/i.test(b), LIMITS.commandMs, 'enable');
                    }
                    const m = atPrompt(buf);
                    if (!m || m[2] !== '#') throw netError('FORBIDDEN', 'The enable password was rejected');
                    level = '#';
                }
                for (const command of commands) {
                    send(command);
                    await waitFor(untilPrompt(), LIMITS.commandMs, command);
                    results[command] = outputOf(command, cut(buf, command), optional);
                }
                try { stream.write('exit\n'); stream.end(); } catch (x) { /* closing anyway */ }
                return results;
            })().then(resolve, fail);
        });
    });
}

/** Exec channels (NX-OS, Junos): one channel per command. */
async function runExec(conn, commands, optional) {
    const results = {};
    for (const command of commands) {
        results[command] = await new Promise((resolve, reject) => {
            conn.exec(command, (err, stream) => {
                if (err) return reject(netError('OTHER', `SSH exec refused: ${err.message}`));
                let out = '';
                let total = 0;
                const timer = setTimeout(() => { try { stream.close(); } catch (x) { /* closed */ } reject(netError('UNREACHABLE', `The device did not finish "${command}" within ${Math.round(LIMITS.commandMs / 1000)} s`)); }, LIMITS.commandMs);
                stream.on('data', (d) => {
                    total += d.length;
                    if (total > LIMITS.maxBytes) { clearTimeout(timer); try { stream.close(); } catch (x) { /* closed */ } reject(netError('OTHER', `The device sent more than ${Math.round(LIMITS.maxBytes / 1048576)} MB`)); return; }
                    out += d.toString('utf8');
                });
                stream.stderr.on('data', (d) => { out += d.toString('utf8'); });
                stream.on('close', () => {
                    clearTimeout(timer);
                    let res;
                    try { res = outputOf(command, out.replace(/\r/g, ''), optional); } catch (e) { reject(e); return; }
                    resolve(res);
                });
            });
        });
    }
    return results;
}

function session(profile, commands, { mode, privileged, optional }) {
    return new Promise((resolve, reject) => {
        const s = profile.secrets || {};
        if (!profile.username || !s.password) { reject(netError('NOT_CONFIGURED', 'No SSH user name or password stored for this device')); return; }
        const id = hostKeyId(profile);
        const pin = createPinning(id, { pinHostKey: true, hostKeyStore });
        const conn = clientFactory();
        let done = false;
        const finish = (fn, v) => {
            if (done) return;
            done = true;
            clearTimeout(sessionTimer);
            try { conn.end(); } catch (x) { /* closed */ }
            fn(v);
        };
        const sessionTimer = setTimeout(() => finish(reject, netError('UNREACHABLE', `The SSH session took longer than ${Math.round(LIMITS.sessionMs / 1000)} s`)), LIMITS.sessionMs);
        conn.on('ready', () => {
            const run = mode === 'exec' ? runExec(conn, commands, optional || []) : runShell(conn, profile, commands, privileged || [], optional || []);
            run.then((r) => finish(resolve, r), (e) => finish(reject, e instanceof NetDeviceError ? e : netError('OTHER', redact(e.message, profile))));
        });
        conn.on('error', (err) => finish(reject, classifyConnectError(err, pin, profile)));
        conn.on('close', () => finish(reject, pin.error ? classifyConnectError(new Error('closed'), pin, profile) : netError('UNREACHABLE', 'The device closed the SSH connection')));
        conn.connect({
            host: profile.mgmtHost,
            port: Number(profile.sshPort || 22),
            username: profile.username,
            password: s.password,
            readyTimeout: LIMITS.connectMs,
            tryKeyboard: true,
            keepaliveInterval: 0,
            ...pin.connectOptions,
        });
        // some IOS images only offer keyboard-interactive: answer every prompt with the password
        conn.on('keyboard-interactive', (name, instructions, lang, prompts, finishKbd) => finishKbd(prompts.map(() => s.password)));
    });
}

/**
 * Run whitelisted commands on a device over SSH.
 * @param {object} profile management profile (mgmtHost, sshPort, username, secrets.password / enableSecret)
 * @param {string[]} commands commands to run, each one must be in `whitelist`
 * @param {{ mode?: 'shell'|'exec', whitelist: string[], privileged?: string[], optional?: string[] }} options privileged: commands
 *   that need privilege 15 (enable); optional: commands whose "not supported / not allowed" answer gives null instead of an error
 * @returns {Promise<Object<string, string|null>>} output per command
 */
async function runCommands(profile, commands, { mode = 'shell', whitelist, privileged = [], optional = [] } = {}) {
    if (!Array.isArray(whitelist) || !whitelist.length) throw netError('BAD_REQUEST', 'No command whitelist');
    for (const c of commands) {
        if (typeof c !== 'string' || !whitelist.includes(c)) throw netError('BAD_REQUEST', 'Command not allowed');
    }
    // one session per device: wait for the previous one (successful or not)
    const key = hostKeyId(profile);
    const prev = queues.get(key) || Promise.resolve();
    const mine = prev.catch(() => {}).then(() => session(profile, commands, { mode, privileged, optional }));
    const tail = mine.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return mine;
}

/** Forget the pinned host key of a device (Connection page: the device was replaced). */
function forgetHostKey(profile) {
    return sshHostKeys.forgetHostKey(hostKeyId(profile), hostKeyStore);
}

function _setClientFactory(fn) { clientFactory = fn || (() => new Client()); }
function _setHostKeyStore(store) { hostKeyStore = store || undefined; }

module.exports = { runCommands, forgetHostKey, hostKeyId, LIMITS, _setClientFactory, _setHostKeyStore, _promptRe: PROMPT_RE };
