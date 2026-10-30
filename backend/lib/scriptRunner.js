/**
 * Sandboxed runner for Workflow "JS Script" nodes (replaces vm2).
 *
 * Layers:
 *  1. User code runs in a fresh vm context; ctx and console are created inside that
 *     context, so no host object (and no host Function constructor) is reachable.
 *  2. The vm runs in a short-lived child process started with Node's permission model
 *     (no fs read/write, no child processes, no workers) and an empty environment.
 *  3. The child is killed if it exceeds the timeout or produces too much output.
 * Data crosses the process boundary as JSON only.
 */
const { spawn } = require('child_process');
const os = require('os');

const DEFAULT_TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 2000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

// Executed with `node --permission -e` in the child process
const CHILD_SOURCE = `
const vm = require('vm');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  let done = false;
  const send = (payload) => {
    if (done) return;
    done = true;
    process.stdout.write(JSON.stringify(payload), () => process.exit(0));
  };
  let timer;
  try {
    const { code, ctxJson, timeoutMs } = JSON.parse(input);
    timer = setTimeout(() => send({ ok: false, error: 'Script timed out after ' + timeoutMs + 'ms' }), timeoutMs);

    const context = vm.createContext(Object.create(null));
    context.__ctxJson = ctxJson;
    vm.runInContext([
      'var ctx = JSON.parse(__ctxJson); delete globalThis.__ctxJson;',
      'var __logs = [];',
      'var __fmt = function (a) { if (typeof a === "string") return a; try { var s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch (e) { return String(a); } };',
      'var __logger = function (prefix) { return function () { __logs.push(prefix + Array.prototype.map.call(arguments, __fmt).join(" ")); }; };',
      'var console = { log: __logger(""), info: __logger(""), warn: __logger("[warn] "), error: __logger("[error] ") };',
    ].join('\\n'), context);

    const script = new vm.Script('(async () => {\\n' + code + '\\n})()', { filename: 'workflow-script.js' });
    const result = await script.runInContext(context, { timeout: timeoutMs });

    context.__result = result;
    const json = vm.runInContext('JSON.stringify({ result: __result, ctx: ctx, logs: __logs })', context, { timeout: timeoutMs });
    clearTimeout(timer);
    process.stdout.write('{"ok":true,"data":' + json + '}', () => process.exit(0));
    done = true;
  } catch (e) {
    clearTimeout(timer);
    let message;
    try { message = (e && e.name ? e.name + ': ' : '') + (e && e.message !== undefined ? e.message : String(e)); }
    catch (_) { message = 'Script threw a non-printable value'; }
    send({ ok: false, error: message });
  }
});
`;

/**
 * Runs `source` with `node --permission` in a child process with an empty environment.
 * Resolves with the child's stdout; rejects on timeout or oversized output.
 */
function runInSandboxProcess(source, stdinText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--permission', '--max-old-space-size=128', '-e', source], {
      cwd: os.tmpdir(),
      env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      fn(value);
    };

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new Error(`Script timed out after ${timeoutMs}ms (process killed)`));
    }, timeoutMs + KILL_GRACE_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(reject, new Error('Script output exceeded 10 MB'));
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk; });
    child.on('error', (err) => finish(reject, err));
    child.on('close', () => {
      if (!stdout && stderr) return finish(reject, new Error(`Script process failed: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
      finish(resolve, stdout);
    });

    child.stdin.on('error', () => {}); // child may exit before reading everything
    child.stdin.end(stdinText);
  });
}

/**
 * Runs a workflow script.
 * @param {string} code    Body of an async function; may use `ctx`, `console` and `await`.
 * @param {object} ctx     Workflow context (must be JSON-serializable).
 * @returns {Promise<{ result: any, ctx: object, logs: string[] }>}
 */
async function runScript(code, ctx, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let ctxJson;
  try {
    ctxJson = JSON.stringify(ctx || {});
  } catch (e) {
    throw new Error(`Workflow context is not JSON-serializable: ${e.message}`);
  }

  const out = await runInSandboxProcess(CHILD_SOURCE, JSON.stringify({ code: String(code || ''), ctxJson, timeoutMs }), timeoutMs);
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    throw new Error('Script process returned no result');
  }
  if (!parsed.ok) throw new Error(parsed.error);
  const { result, ctx: newCtx, logs } = parsed.data;
  return { result, ctx: newCtx || {}, logs: logs || [] };
}

module.exports = { runScript, runInSandboxProcess };
