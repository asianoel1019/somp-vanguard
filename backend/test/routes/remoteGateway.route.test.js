// Web Remote gateway: target / port / security checked before a token is issued, the token carries the audit data,
// the browser cannot write audit lines any more, and the WebSocket upgrade refuses bad, expired or reused tokens.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');
const proxy = require('../../services/guacamoleProxy');
const remoteToken = require('../../services/remoteToken');

const OP = `Bearer ${signToken({ username: 'op.user', domain: 'corp', role: 'Operator', groups: ['g'] })}`;
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { serverList: true } } },
    });
    app = express();
    app.use(express.json());
    app.use('/api/remote', require('../../routes/remote'));
});
test.after(async () => { await dbManager.closeDB(); });

const tokenReq = (body) => request(app).post('/api/remote/token').set('Authorization', OP).send(body);

test('targets, ports, protocols and security modes are checked', async () => {
    for (const ip of ['192.0.2.10 -p 25', 'http://192.0.2.10', 'host_name.example.test', '192.0.2.10:3389', 'a'.repeat(254), 'host\n.example.test']) {
        const r = await tokenReq({ ip, os: 'linux' });
        assert.equal(r.status, 400, ip);
    }
    for (const port of ['0', '65536', 'abc', '22; x', -1, 3.5]) {
        assert.equal((await tokenReq({ ip: '192.0.2.10', os: 'linux', port })).status, 400, String(port));
    }
    assert.equal((await tokenReq({ ip: '192.0.2.10', protocol: 'vnc' })).status, 400);
    assert.equal((await tokenReq({ ip: '192.0.2.10', os: 'windows', password: 'x', security: 'none"; foo' })).status, 400);
    assert.equal((await tokenReq({ ip: '192.0.2.10', os: 'linux', username: 'a\nb' })).status, 400);
    for (const ip of ['192.0.2.10', '2001:db8::10', 'host01.example.test', 'HOST01']) {
        assert.equal((await tokenReq({ ip, os: 'linux' })).status, 200, ip);
    }
});

test('the issued token is single-use, expires in 30 s and carries the audit data', async () => {
    const r = await tokenReq({ ip: '192.0.2.10', name: 'Web01', os: 'windows', username: 'CORP\\alice', password: 'typed', port: '3390' });
    assert.equal(r.status, 200);
    assert.equal(r.body.expiresIn, 30);
    assert.equal(r.headers['cache-control'], 'no-store');
    const p = remoteToken.consumeToken(r.body.token);
    assert.deepEqual(p.audit, { user: 'op.user', protocol: 'RDP', target: 'Web01 (192.0.2.10:3390)', account: 'CORP\\alice' });
    assert.equal(p.connection.settings.port, '3390');
    assert.throws(() => remoteToken.consumeToken(r.body.token), /already used/);
});

test('the browser can no longer write audit lines', async () => {
    await request(app).post('/api/remote/audit-event').set('Authorization', OP).send({ action: 'x' }).expect(404);
});

test('WebSocket upgrade: missing, forged and reused tokens are refused before guacamole-lite', async (t) => {
    const server = http.createServer();
    proxy.initGuacamoleProxy(server);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise(r => server.close(r)));
    const port = server.address().port;
    const upgrade = (path) => new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
        req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
        req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
        req.on('error', () => resolve('error'));
        req.end();
    });
    assert.equal(await upgrade('/guacamole'), 401);
    assert.equal(await upgrade('/guacamole?token=eyJpdiI6ImEiLCJ2YWx1ZSI6ImIifQ%3D%3D'), 401);
    const { token } = remoteToken.issueToken({ connection: { type: 'ssh', settings: { hostname: '192.0.2.10', port: '22' } }, audit: { user: 'op.user', protocol: 'SSH', target: '192.0.2.10:22', account: 'prompted' } });
    assert.equal(await upgrade(`/guacamole?token=${encodeURIComponent(token)}&width=1280&height=720`), 101, 'a fresh token is accepted');
    assert.equal(await upgrade(`/guacamole?token=${encodeURIComponent(token)}`), 401, 'the same token cannot open a second session');
});
