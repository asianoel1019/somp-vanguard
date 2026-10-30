require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

// Stub AD before routes/auth.js destructures these at load time
const powershell = require('../../lib/powershell');
let adGroups = [];
powershell.validateADCredentials = async () => 'True';
powershell.getADCredentialHeader = () => '';
powershell.runPowerShell = async () => JSON.stringify({ DistinguishedName: 'CN=u,OU=Staff,DC=corp,DC=test', MemberOf: [], GroupNames: adGroups });

const { writeRbacConfig } = require('../../lib/rbac');
const { buildFeatureMap, hasFeature } = require('../../lib/permissions');

process.env.ALLOWED_AD_DOMAIN = 'corp.test';
const app = express();
app.use(express.json());
app.use('/api/auth', require('../../routes/auth'));

const ROLES = ['SuperAdmin', 'Operator', 'Viewer', 'None'];
// distinct client IPs so the per-IP login rate limiter never interferes
let ip = 10;
const login = (username) => request(app).post('/api/auth/login')
    .set('X-Forwarded-For', `10.9.9.${ip++}`)
    .send({ username, password: 'pw' });

test.beforeEach(() => {
    process.env.ALLOWED_AD_DOMAIN = 'corp.test';
    writeRbacConfig({
        roles: ROLES, defaultRole: 'None',
        users: { '[group] admins@local': 'SuperAdmin', '[group] ops@local': 'Operator' },
        groups: {
            SuperAdmin: { builtin: true, type: 'role', enabled: true, features: { dnsHub: true, ipam: false, manage_self_healing: false } },
            admins: { type: 'group', target: 'admins', enabled: true, features: { ipam: true, manage_self_healing: true } },
            ops: { type: 'group', target: 'ops', enabled: true, features: { ipam: true, workflow: true } },
        },
    });
});

test('AD SuperAdmin login: feature map = built-in mapping (not their AD groups), same as hasFeature', async () => {
    adGroups = ['admins'];
    const { body } = await login('boss').expect(200);
    assert.equal(body.user.role, 'SuperAdmin');
    assert.equal(body.user.domain, 'corp.test');
    const u = { username: 'boss', domain: 'corp.test', role: 'SuperAdmin', groups: ['admins'] };
    assert.deepEqual(body.user.features, buildFeatureMap(u));
    assert.equal(body.user.features.dnsHub, true);
    assert.equal(body.user.features.ipam, false);
    assert.equal(body.user.features.manage_self_healing, false);
    assert.equal(body.user.features.settings, true);
    for (const [k, v] of Object.entries(body.user.features)) assert.equal(v, hasFeature(u, k), k);
});

test('AD non-SuperAdmin login: feature map = union of matched mappings', async () => {
    adGroups = ['ops'];
    const { body } = await login('op').expect(200);
    assert.equal(body.user.role, 'Operator');
    assert.equal(body.user.features.ipam, true);
    assert.equal(body.user.features.workflow, true);
    assert.equal(body.user.features.dnsHub, false);
    assert.equal(body.user.features.settings, false);
});

test('ALLOWED_AD_DOMAIN=local is ignored: an AD user can never be minted with domain local', async () => {
    adGroups = ['admins'];
    for (const v of ['local', 'LOCAL']) {
        process.env.ALLOWED_AD_DOMAIN = v;
        const res = await login('someone');
        assert.equal(res.status, 401);
        assert.match(res.body.error, /uninitialized/i);
    }
    const cfg = await request(app).get('/api/auth/config').expect(200);
    assert.equal(cfg.body.allowedDomain, '');
});
