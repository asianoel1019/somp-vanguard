require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { runScript, runInSandboxProcess } = require('../../lib/scriptRunner');

test('returns the script return value', async () => {
    const { result } = await runScript('return { total: ctx.servers.length, ok: true };', { servers: [1, 2, 3] });
    assert.deepEqual(result, { total: 3, ok: true });
});

test('changes to ctx are returned', async () => {
    const { ctx } = await runScript('ctx.counter = ctx.counter + 1; ctx.added = "x";', { counter: 1 });
    assert.equal(ctx.counter, 2);
    assert.equal(ctx.added, 'x');
});

test('console.log output is captured as logs', async () => {
    const { logs } = await runScript('console.log("hello", 42, { a: 1 }); console.error("bad"); return 1;', {});
    assert.deepEqual(logs, ['hello 42 {"a":1}', '[error] bad']);
});

test('await is supported', async () => {
    const { result } = await runScript('const v = await Promise.resolve(5); return v * 2;', {});
    assert.equal(result, 10);
});

test('non-JSON values are converted (Date becomes ISO string)', async () => {
    const { result } = await runScript('return { at: new Date(0), fn: () => 1 };', {});
    assert.deepEqual(result, { at: '1970-01-01T00:00:00.000Z' });
});

test('syntax errors reject with a readable message', async () => {
    await assert.rejects(runScript('return (;', {}), /SyntaxError/);
});

test('thrown errors reject with the script error message', async () => {
    await assert.rejects(runScript('throw new Error("boom")', {}), /boom/);
});

test('synchronous infinite loop is stopped by the timeout', async () => {
    const t0 = Date.now();
    await assert.rejects(runScript('while (true) {}', {}, { timeoutMs: 500 }), /timed out/);
    assert.ok(Date.now() - t0 < 5000);
});

test('never-resolving async script is stopped by the timeout', async () => {
    await assert.rejects(runScript('await new Promise(() => {});', {}, { timeoutMs: 500 }), /timed out/);
});

test('require, process and module are not available', async () => {
    const { result } = await runScript(
        'return [typeof require, typeof process, typeof module, typeof globalThis.process];', {});
    assert.deepEqual(result, ['undefined', 'undefined', 'undefined', 'undefined']);
});

test('constructor escape through ctx does not reach process', async () => {
    const { result } = await runScript(
        'const g = ctx.constructor.constructor("return this")(); return typeof g.process;', { a: 1 });
    assert.equal(result, 'undefined');
});

test('constructor escape through console does not reach process', async () => {
    const { result } = await runScript(
        'const g = console.log.constructor("return this")(); return typeof g.process;', {});
    assert.equal(result, 'undefined');
});

// Defense in depth: even code that escaped the vm context runs in a locked-down child process
test('sandbox process has no parent secrets, no fs access and cannot spawn processes', async (t) => {
    process.env.SOMP_TEST_SECRET = 'should-not-leak';
    t.after(() => { delete process.env.SOMP_TEST_SECRET; });
    const probe = `
        const tryIt = (fn) => { try { fn(); return 'allowed'; } catch (e) { return e.code || e.message; } };
        process.stdout.write(JSON.stringify({
            secret: process.env.SOMP_TEST_SECRET || null,
            jwt: process.env.JWT_SECRET || null,
            fsRead: tryIt(() => require('fs').readdirSync('.')),
            fsWrite: tryIt(() => require('fs').writeFileSync('somp-probe.txt', 'x')),
            spawn: tryIt(() => require('child_process').execSync('whoami')),
        }));
    `;
    const out = JSON.parse(await runInSandboxProcess(probe, '', 5000));
    assert.equal(out.secret, null);
    assert.equal(out.jwt, null);
    assert.equal(out.fsRead, 'ERR_ACCESS_DENIED');
    assert.equal(out.fsWrite, 'ERR_ACCESS_DENIED');
    assert.equal(out.spawn, 'ERR_ACCESS_DENIED');
});
