// Project-wide scan fixes: FortiProxy URL rating no longer passes arbitrary text to the proxy CLI and is Operator+;
// the SIEM telemetry stub (random numbers) is gone.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const { writeRbacConfig } = require('../../lib/rbac');

const tok = (username, role) => `Bearer ${signToken({ username, domain: 'corp', role, groups: ['g'] })}`;
const op = tok('op1', 'Operator');
const viewer = tok('v1', 'Viewer');
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({
        roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer',
        groups: { g: { type: 'group', target: 'g', enabled: true, features: { fortiProxy: true, elk: true } } },
    });
    app = express();
    app.use(express.json());
    app.use('/api/fortiproxy', require('../../routes/fortiproxy'));
    app.use('/api/siem', require('../../routes/siem'));
});
test.after(async () => { await dbManager.closeDB(); });

test('FortiProxy URL rating: Viewer refused; anything that could add a CLI command is rejected before SSH', async () => {
    await request(app).post('/api/fortiproxy/url-rating').set('Authorization', viewer).send({ env: 'PROD', url: 'example.com' }).expect(403);
    for (const url of ['example.com\nexecute reboot', 'example.com execute shutdown', 'a"b', 'a\\b', '', 'x'.repeat(2049)]) {
        const r = await request(app).post('/api/fortiproxy/url-rating').set('Authorization', op).send({ env: 'PROD', url });
        assert.equal(r.status, 400, JSON.stringify(url.slice(0, 40)));
    }
    // a normal URL passes validation and stops only at the missing proxy configuration
    const ok = await request(app).post('/api/fortiproxy/url-rating').set('Authorization', op).send({ env: 'PROD', url: 'https://example.com/path?q=1&x=2' });
    assert.notEqual(ok.status, 403);
    assert.doesNotMatch(String(ok.body.error || ''), /single URL/);
});

test('SIEM telemetry stub is removed', async () => {
    await request(app).get('/api/siem/telemetry').set('Authorization', op).expect(404);
});
