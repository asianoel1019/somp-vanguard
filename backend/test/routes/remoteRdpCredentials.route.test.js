require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

// Web RDP: the username defaults to the logged-in user and the password must always be typed in
// (never filled in from AD_ADMIN_PWD or decrypted from an enc: value).
const OP = { username: 'op.user', domain: 'corp', role: 'Operator', groups: ['g'] };
const bearer = (u) => `Bearer ${signToken(u)}`;

let app;
let issued = [];
test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { serverList: true } } },
    });
    const proxy = require('../../services/guacamoleProxy');
    proxy.encryptConnectionToken = (payload) => { issued.push(payload); return 'tok'; };
    app = express();
    app.use(express.json());
    app.use('/api/remote', require('../../routes/remote'));
});

test.after(async () => { await dbManager.closeDB(); });

const token = (body) => request(app).post('/api/remote/token').set('Authorization', bearer(OP)).send(body);

test('RDP without a password is rejected, even for the AD admin account', async () => {
    process.env.AD_ADMIN_USER = 'svc.admin';
    process.env.AD_ADMIN_PWD = 'Secret!1';
    try {
        issued = [];
        let r = await token({ ip: '10.0.0.5', os: 'windows', username: 'svc.admin' });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /password/i);
        r = await token({ ip: '10.0.0.5', os: 'windows' });
        assert.equal(r.status, 400);
        assert.equal(issued.length, 0, 'no connection token issued without a password');
    } finally {
        delete process.env.AD_ADMIN_USER;
        delete process.env.AD_ADMIN_PWD;
    }
});

test('RDP defaults to the logged-in user and uses only the typed password', async () => {
    process.env.AD_ADMIN_USER = 'svc.admin';
    process.env.AD_ADMIN_PWD = 'Secret!1';
    try {
        issued = [];
        let r = await token({ ip: '10.0.0.5', os: 'windows', password: 'typed' });
        assert.equal(r.status, 200);
        assert.equal(r.body.effectiveUser, 'op.user');
        assert.equal(issued[0].connection.settings.password, 'typed');
        r = await token({ ip: '10.0.0.5', os: 'windows', username: 'svc.admin', password: 'typed2' });
        assert.equal(r.status, 200);
        assert.equal(issued[1].connection.settings.password, 'typed2', 'AD admin password is never substituted');
    } finally {
        delete process.env.AD_ADMIN_USER;
        delete process.env.AD_ADMIN_PWD;
    }
});

test('an enc: value typed as the password is passed through, never decrypted with the system key', async () => {
    issued = [];
    const r = await token({ ip: '10.0.0.5', os: 'windows', password: 'enc:abcdef' });
    assert.equal(r.status, 200);
    assert.equal(issued[0].connection.settings.password, 'enc:abcdef');
});

test('SSH keeps its behaviour: blank credentials are allowed (typed in the terminal)', async () => {
    issued = [];
    const r = await token({ ip: '10.0.0.6', os: 'linux', protocol: 'ssh' });
    assert.equal(r.status, 200);
    assert.equal(issued[0].connection.settings.password, undefined);
});
