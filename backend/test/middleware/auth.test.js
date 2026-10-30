require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { mockRes, signToken, TEST_JWT_SECRET } = require('../helpers/http');
const { encryptPassword } = require('../../lib/crypto');
const { writeRbacConfig } = require('../../lib/rbac');
const { requireAuth, checkRole, checkFeature } = require('../../middleware/auth');

const ROLES = ['SuperAdmin', 'Operator', 'Viewer', 'None'];

function run(mw, req) {
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    return { res, nextCalled };
}

// ── requireAuth ──
test('requireAuth: 401 without Authorization header', () => {
    const { res, nextCalled } = run(requireAuth, { headers: {} });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

test('requireAuth: 401 for non-Bearer scheme', () => {
    const { res } = run(requireAuth, { headers: { authorization: 'Basic abc' } });
    assert.equal(res.statusCode, 401);
});

test('requireAuth: 401 for token signed with another secret', () => {
    const bad = jwt.sign({ username: 'x', role: 'SuperAdmin' }, 'attacker-secret');
    const { res, nextCalled } = run(requireAuth, { headers: { authorization: `Bearer ${bad}` } });
    assert.equal(res.statusCode, 401);
    assert.equal(nextCalled, false);
});

test('requireAuth: 401 for expired token', () => {
    const expired = jwt.sign({ username: 'x', role: 'Viewer', exp: Math.floor(Date.now() / 1000) - 10 }, TEST_JWT_SECRET);
    const { res } = run(requireAuth, { headers: { authorization: `Bearer ${expired}` } });
    assert.equal(res.statusCode, 401);
});

test('requireAuth: valid token populates req.user and decrypts epass', () => {
    const token = signToken({
        username: 'alice', domain: 'corp', role: 'Operator', groups: ['ops'],
        epass: encryptPassword('ad-password', TEST_JWT_SECRET),
    });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const { nextCalled } = run(requireAuth, req);
    assert.equal(nextCalled, true);
    assert.equal(req.user.username, 'alice');
    assert.equal(req.user.password, 'ad-password');
});

// ── checkRole ──
test('checkRole: 403 when req.user missing', () => {
    assert.equal(run(checkRole(['SuperAdmin']), {}).res.statusCode, 403);
});

test('checkRole: 403 when role not allowed', () => {
    const { res, nextCalled } = run(checkRole(['SuperAdmin']), { user: { role: 'Operator' } });
    assert.equal(res.statusCode, 403);
    assert.equal(nextCalled, false);
});

test('checkRole: next() when role allowed', () => {
    assert.equal(run(checkRole(['SuperAdmin', 'Operator']), { user: { role: 'Operator' } }).nextCalled, true);
});

// ── checkFeature ──
test('checkFeature: 401 without user', () => {
    assert.equal(run(checkFeature('dns'), {}).res.statusCode, 401);
});

test('checkFeature: SuperAdmin allowed when no RBAC groups configured', () => {
    writeRbacConfig({ roles: ROLES, users: {}, defaultRole: 'Viewer', groups: {} });
    // fresh install -> the built-in SuperAdmin mapping is seeded with every known feature on
    const req = { user: { username: 'boss', domain: 'corp', role: 'SuperAdmin', groups: [] } };
    assert.equal(run(checkFeature('dnsHub'), req).nextCalled, true);
});

test('checkFeature: global env flag false blocks everyone, including SuperAdmin', (t) => {
    process.env.APP_ENABLE_DNS = 'false';
    t.after(() => { delete process.env.APP_ENABLE_DNS; });
    const req = { user: { username: 'admin', domain: 'local', role: 'SuperAdmin', groups: [] } };
    assert.equal(run(checkFeature('dns'), req).res.statusCode, 403);
});

test('checkFeature: group member gets only features enabled on the group', () => {
    writeRbacConfig({
        roles: ROLES, users: {}, defaultRole: 'Viewer',
        groups: { ops: { enabled: true, features: { dns: true, nutanix: false } } },
    });
    const user = { username: 'alice', domain: 'corp', role: 'Operator', groups: ['ops'] };
    assert.equal(run(checkFeature('dns'), { user }).nextCalled, true);
    assert.equal(run(checkFeature('nutanix'), { user }).res.statusCode, 403);
});

test('checkFeature: disabled group grants nothing', () => {
    writeRbacConfig({
        roles: ROLES, users: {}, defaultRole: 'Viewer',
        groups: { ops: { enabled: false, features: { dns: true } } },
    });
    const user = { username: 'alice', domain: 'corp', role: 'Operator', groups: ['ops'] };
    assert.equal(run(checkFeature('dns'), { user }).res.statusCode, 403);
});

test('checkFeature: once groups exist, SuperAdmin follows the union of enabled groups (current design)', () => {
    writeRbacConfig({
        roles: ROLES, users: {}, defaultRole: 'Viewer',
        groups: { ops: { enabled: true, features: { dns: true } } },
    });
    const boss = { username: 'boss', domain: 'corp', role: 'SuperAdmin', groups: [] };
    assert.equal(run(checkFeature('dns'), { user: boss }).nextCalled, true);
    assert.equal(run(checkFeature('nutanix'), { user: boss }).res.statusCode, 403);
});
