require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

const tok = (role) => `Bearer ${signToken({ username: role.toLowerCase(), domain: 'corp', role, groups: ['g'] })}`;
const OP = tok('Operator'), VIEWER = tok('Viewer');

let app;
let detected = [];
let ran = [];
test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { remoteCmd: true } } },
    });
    // stubs must be in place before routes/ops destructures detectOs
    const osDetect = require('../../lib/osDetect');
    osDetect.detectOs = async (ip) => { detected.push(ip); return { status: 'online', os: ip.startsWith('10.1.') ? 'Linux' : 'Windows' }; };
    const svc = require('../../services/remoteCommandService');
    svc.runWindowsCommand = async (ip, cmd, creds) => { ran.push(['win', ip, cmd, creds]); return { ip, status: 'Online', os: 'Windows', runAs: 'service', output: 'w' }; };
    svc.runLinuxCommand = async (ip, cmd) => { ran.push(['nix', ip, cmd]); return { ip, status: 'Online', os: 'Linux', output: 'l' }; };
    app = express();
    app.use(express.json());
    app.use('/api/ops', require('../../routes/ops'));
    app.use('/api/cmd-library', require('../../routes/cmdLibrary'));
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => { detected = []; ran = []; });

const command = (body, token = OP) => request(app).post('/api/ops/command').set('Authorization', token).send(body);
const lines = (text) => text.split('\n').filter(Boolean).map(l => JSON.parse(l));

test('an injected target is rejected with 400 and nothing is detected or executed', async () => {
    const r = await command({ ips: ['10.0.0.1', 'x"; Remove-Item C:\\ -Recurse; "'], winCommand: 'Get-Date' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Invalid IP/);
    assert.deepEqual(detected, []);
    assert.deepEqual(ran, []);
});

test('malformed body / dangerous command -> 400 (no crash, nothing executed)', async () => {
    assert.equal((await command({ ips: 'nope', winCommand: 'a' })).status, 400);
    assert.equal((await command({ winCommand: 'a' })).status, 400);
    const d = await command({ ips: ['10.0.0.1'], nixCommand: 'rm -rf /' });
    assert.equal(d.status, 400);
    assert.match(d.body.error, /blocked/);
    assert.deepEqual(ran, []);
});

test('targets are de-duplicated and routed by OS; the Windows password is passed as the user credential', async () => {
    const r = await command({ ips: ['10.0.0.1', '10.0.0.1', '10.1.0.2'], winCommand: 'Get-Date', nixCommand: 'uptime', linuxPassword: 'lp', winPassword: 'wp' });
    assert.equal(r.status, 200);
    const out = lines(r.text);
    assert.deepEqual(out.map(o => o.ip).sort(), ['10.0.0.1', '10.1.0.2']);
    assert.equal(ran.length, 2);
    const win = ran.find(x => x[0] === 'win');
    assert.deepEqual(win[3].userCred, { name: 'corp\\operator', password: 'wp' });
});

test('empty command for an OS -> Skipped for that host', async () => {
    const r = await command({ ips: ['10.1.0.2'], winCommand: 'Get-Date' });
    assert.equal(lines(r.text)[0].status, 'Skipped');
    assert.deepEqual(ran, []);
});

test('command library: Viewer cannot add or delete; Operator add/delete is validated', async () => {
    const lib = (method, url, token, body) => request(app)[method](`/api/cmd-library${url}`).set('Authorization', token).send(body);
    assert.equal((await lib('post', '/', VIEWER, { name: 'x', winCommand: 'a' })).status, 403);
    assert.equal((await lib('delete', '/c_1', VIEWER)).status, 403);
    assert.equal((await lib('post', '/', OP, { name: 'x' })).status, 400);
    assert.equal((await lib('post', '/', OP, { name: 'x', winCommand: 5 })).status, 400);
    const ok = await lib('post', '/', OP, { name: ' Uptime ', winCommand: 'Get-Date' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.command.name, 'Uptime');
    assert.equal(ok.body.command.createdBy, 'operator');
    assert.equal((await lib('delete', `/${ok.body.command.id}`, OP)).status, 200);
    assert.equal((await lib('delete', `/${ok.body.command.id}`, OP)).status, 404);
});
