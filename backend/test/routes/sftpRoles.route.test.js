require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

const app = express();
app.use(express.json());
app.use('/api/sftp', require('../../routes/sftp'));
// Every token is in group "g", which has the SFTP Manager feature, so a 403 here comes from the role check.
const bearer = (role) => `Bearer ${signToken({ username: 'u', domain: 'corp', role, groups: ['g'] })}`;
const isFeatureDenied = (res) => res.status === 403 && /feature/i.test(String(res.body && res.body.error));
const roleDenied = (res) => res.status === 403 && !isFeatureDenied(res);

test.beforeEach(() => {
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: {
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { sftpManager: true } },
            g: { type: 'group', target: 'g', enabled: true, features: { sftpManager: true } },
        },
    });
});

test('the dead "Admin" role is gone from the SFTP routes', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../routes/sftp.js'), 'utf8');
    assert.doesNotMatch(src, /'Admin'/);
});

test('SuperAdmin-only SFTP actions reject Operator and a forged "Admin" role (role check, not feature)', async () => {
    for (const role of ['Operator', 'Admin', 'Viewer']) {
        for (const [m, u] of [['post', '/api/sftp/service/restart'], ['delete', '/api/sftp/users/x'], ['post', '/api/sftp/config']]) {
            const res = await request(app)[m](u).set('Authorization', bearer(role)).send({});
            assert.ok(roleDenied(res), `${role} ${m} ${u} -> ${res.status} ${JSON.stringify(res.body)}`);
        }
    }
});

test('Operator-level SFTP actions reject Viewer and a forged "Admin" role (role check, not feature)', async () => {
    for (const role of ['Admin', 'Viewer']) {
        const add = await request(app).post('/api/sftp/users').set('Authorization', bearer(role)).send({});
        assert.ok(roleDenied(add), `${role} POST users -> ${add.status}`);
        const groups = await request(app).get('/api/sftp/groups').set('Authorization', bearer(role));
        assert.ok(roleDenied(groups), `${role} GET groups -> ${groups.status}`);
    }
});

test('a SuperAdmin with the feature reaches the handler', async () => {
    const res = await request(app).get('/api/sftp/servers').set('Authorization', bearer('SuperAdmin')).expect(200);
    assert.ok(Array.isArray(res.body.servers));
});

test('without the feature every SFTP endpoint answers with the feature 403', async () => {
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: {
        SuperAdmin: { builtin: true, type: 'role', enabled: true, features: {} },
        g: { type: 'group', target: 'g', enabled: true, features: {} },
    } });
    assert.ok(isFeatureDenied(await request(app).get('/api/sftp/servers').set('Authorization', bearer('SuperAdmin'))));
    assert.ok(isFeatureDenied(await request(app).get('/api/sftp/servers').set('Authorization', bearer('Operator'))));
});
