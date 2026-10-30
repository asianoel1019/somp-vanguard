require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { EventEmitter } = require('events');
const { runPowerShell, buildCredentialEnv, ENV_CREDENTIAL_HEADER } = require('../../lib/powershell');

function fakeSpawn(capture, stdout = 'ok') {
    return (cmd, args, opts) => {
        capture.cmd = cmd; capture.args = args; capture.opts = opts;
        const psPath = /& '(.+)'$/.exec(args[args.indexOf('-Command') + 1])[1];
        capture.scriptText = fs.readFileSync(psPath, 'utf8');
        const ps = new EventEmitter();
        ps.stdout = new EventEmitter();
        ps.stderr = new EventEmitter();
        ps.stdin = new EventEmitter();
        ps.stdin.end = (d) => { capture.stdin = d; };
        setImmediate(() => { ps.stdout.emit('data', Buffer.from(stdout)); ps.emit('close', 0); });
        return ps;
    };
}

test('credentials are passed via env and never appear in the script file or arguments', async () => {
    const cap = {};
    const secret = "P@ss'w0rd$(calc)";
    const env = buildCredentialEnv('CORP\\svc', secret);
    const script = `${ENV_CREDENTIAL_HEADER}\nInvoke-Command -ComputerName "10.0.0.1" -Credential $global:AD_CRED -ScriptBlock { 1 }`;
    const out = await runPowerShell(script, 5000, { env, spawnImpl: fakeSpawn(cap) });
    assert.equal(out, 'ok');
    assert.equal(cap.opts.env.SOMP_CRED_USER, 'CORP\\svc');
    assert.equal(cap.opts.env.SOMP_CRED_PWD, secret);
    assert.ok(!cap.scriptText.includes(secret), 'secret must not be written into the script file');
    assert.ok(!cap.args.join(' ').includes(secret));
    assert.ok(cap.scriptText.includes('$env:SOMP_CRED_PWD'));
    assert.equal(cap.stdin, undefined);
});

test('stdin payload is delivered to the process stdin', async () => {
    const cap = {};
    await runPowerShell('[Console]::In.ReadToEnd()', 5000, { stdin: 'secret-payload', spawnImpl: fakeSpawn(cap) });
    assert.equal(cap.stdin, 'secret-payload');
    assert.ok(!cap.scriptText.includes('secret-payload'));
});

test('buildCredentialEnv returns nothing without both parts', () => {
    assert.deepEqual(buildCredentialEnv('u', ''), {});
    assert.deepEqual(buildCredentialEnv('', 'p'), {});
});
