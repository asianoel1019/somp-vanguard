// Settings-area features that used to report success they never had: NAS drivers inventing capacity and shares,
// Test Connection always green, sync marking every device online, permission edits only cached; Open API ignoring
// its max query range.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const axios = require('axios');
const dbManager = require('../../services/db');
const nasDrivers = require('../../services/nasDrivers');
const { signToken } = require('../helpers/http');
const { writeDataSync, readDataSync } = require('../../lib/db');
const { writeRbacConfig } = require('../../lib/rbac');

const KEY = 'service_platform/nas_config.json';
const admin = `Bearer ${signToken({ username: 'root', domain: 'corp', role: 'SuperAdmin', groups: [] })}`;
let app;

test.before(async () => {
    await dbManager.initDB();
    writeRbacConfig({ roles: ['SuperAdmin', 'Operator', 'Viewer', 'None'], users: {}, defaultRole: 'Viewer', groups: {} });
    app = express();
    app.use(express.json());
    app.use('/api/nas', require('../../routes/nas'));
});
test.after(async () => { await dbManager.closeDB(); });

test('NAS drivers: a failed call throws a readable error instead of returning invented data', async (t) => {
    t.mock.method(axios, 'get', async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); });
    const syn = nasDrivers.getDriver({ type: 'synology', ip: '192.0.2.10', username: 'u' });
    await assert.rejects(syn.getStorageInfo(), (e) => e.userSafe && /Synology storage info failed: connect ECONNREFUSED/.test(e.message));
    await assert.rejects(syn.listShares(), /Synology share list failed/);
    await assert.rejects(syn.testConnection(), /Synology login failed/);

    const qnap = nasDrivers.getDriver({ type: 'qnap', ip: '192.0.2.11', username: 'u' });
    await assert.rejects(qnap.getStorageInfo(), (e) => e.code === 'NOT_SUPPORTED');
    await assert.rejects(qnap.listShares(), (e) => e.code === 'NOT_SUPPORTED');
});

test('NAS Test Connection reports the real failure', async (t) => {
    t.mock.method(nasDrivers, 'getDriver', () => ({
        testConnection: async () => { const e = new Error('Synology login failed: {"code":400}'); e.userSafe = true; throw e; },
        getStorageInfo: async () => [{ name: 'fake', totalGB: 1, usedGB: 1 }],
    }));
    const r = await request(app).post('/api/nas/test-connection').set('Authorization', admin)
        .send({ name: 'x', type: 'synology', ip: '192.0.2.12', username: 'u', password: 'p' }).expect(500);
    assert.equal(r.body.success, false);
    assert.match(r.body.message, /login failed/);
});

test('NAS sync: unreachable devices go offline with the error and keep their last real data; unsupported parts are noted', async (t) => {
    writeDataSync(KEY, [
        { id: 'a', name: 'up', type: 'synology', ip: '192.0.2.20', status: 'online', volumes: [{ name: 'v', totalGB: 10, usedGB: 1 }], shares: [{ name: 'S', path: '/s', permissions: [{ name: 'g', access: 'r' }] }] },
        { id: 'b', name: 'down', type: 'synology', ip: '192.0.2.21', status: 'online', volumes: [{ name: 'old', totalGB: 5, usedGB: 2 }], shares: [] },
        { id: 'c', name: 'q', type: 'qnap', ip: '192.0.2.22', volumes: [{ name: 'DataVol1', totalGB: 16384, usedGB: 14000 }], shares: [{ name: 'QNAPPublic', path: '/p', permissions: [] }] },
    ]);
    t.mock.method(nasDrivers, 'getDriver', (dev) => {
        if (dev.id === 'b') return { testConnection: async () => { const e = new Error('Synology login failed: timeout'); e.userSafe = true; throw e; } };
        if (dev.id === 'c') {
            const ns = (w) => { const e = new Error(`${w} is not supported for this NAS type yet`); e.code = 'NOT_SUPPORTED'; e.userSafe = true; return e; };
            return { testConnection: async () => {}, getStorageInfo: async () => { throw ns('Reading QNAP volumes'); }, listShares: async () => { throw ns('Listing QNAP shares'); } };
        }
        return { testConnection: async () => {}, getStorageInfo: async () => [{ name: 'v', totalGB: 20, usedGB: 2 }], listShares: async () => [{ name: 'S', path: '/s', description: '', permissions: [] }] };
    });
    const list = (await request(app).get('/api/nas/config?sync=true').set('Authorization', admin).expect(200)).body;
    const by = Object.fromEntries(list.map(d => [d.id, d]));
    assert.equal(by.a.status, 'online');
    assert.equal(by.a.volumes[0].totalGB, 20);
    assert.deepEqual(by.a.shares[0].permissions, [{ name: 'g', access: 'r' }], 'cached ACL kept when the driver lists none');
    assert.equal(by.b.status, 'offline');
    assert.match(by.b.lastError, /timeout/);
    assert.equal(by.b.volumes[0].name, 'old', 'last real data kept');
    assert.equal(by.c.status, 'online');
    assert.deepEqual(by.c.volumes, [], 'invented QNAP volumes are gone');
    assert.deepEqual(by.c.shares, []);
    assert.equal(by.c.syncNotes.length, 2);
    assert.equal(readDataSync(KEY, []).find(d => d.id === 'b').status, 'offline');
});

test('Open API: SCOUT_OPEN_API_MAX_DAYS caps how far back a query reaches', () => {
    const { cappedFrom } = require('../../routes/openScoutApi')._test;
    const ageDays = (iso) => (Date.now() - new Date(iso).getTime()) / 86400000;
    process.env.SCOUT_OPEN_API_MAX_DAYS = '7';
    try {
        assert.ok(Math.abs(ageDays(cappedFrom('2000-01-01T00:00:00Z')) - 7) < 0.01, 'older from raised to the limit');
        assert.ok(Math.abs(ageDays(cappedFrom(undefined)) - 7) < 0.01, 'missing from starts at the limit');
        const recent = new Date(Date.now() - 86400000).toISOString();
        assert.equal(cappedFrom(recent), recent, 'a from inside the range is kept');
        process.env.SCOUT_OPEN_API_MAX_DAYS = '9999';
        assert.ok(Math.abs(ageDays(cappedFrom(undefined)) - 365) < 0.01, 'limit clamped to 365 days');
    } finally {
        delete process.env.SCOUT_OPEN_API_MAX_DAYS;
    }
});
