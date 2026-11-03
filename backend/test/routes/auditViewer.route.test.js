// Audit log viewer: archived (gzip) days readable, only the requested days read, server-side filter / sort / paging,
// formula-safe CSV export, configurable retention; settings saves audited with the names of what changed.
const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const request = require('supertest');
const dbManager = require('../../services/db');
const { signToken } = require('../helpers/http');
const logger = require('../../lib/logger');
const { envVersion } = require('../../lib/envEditor');

const admin = `Bearer ${signToken({ username: 'root', domain: 'corp', role: 'SuperAdmin', groups: [] })}`;
const LOG_DIR = path.join(dataDir, 'logs');
const ARCHIVE = path.join(LOG_DIR, 'archive');
let app;

const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const line = (d, time, user, module, action) => `[${d}T${time}] [Audit] User: ${user} | Module: ${module} | Action: ${action}`;

test.before(async () => {
    await dbManager.initDB();
    app = express();
    app.use(express.json());
    app.use('/api/audit', require('../../routes/audit'));
    app.use('/api/settings', require('../../routes/apiSettings'));

    fs.mkdirSync(ARCHIVE, { recursive: true });
    const old = day(-40);
    fs.writeFileSync(path.join(ARCHIVE, `auth_${old}.log.gz`), zlib.gzipSync([
        line(old, '09:00:00', 'alice', 'RBAC', 'Granted Operator to bob'),
        line(old, '10:00:00', 'carol', 'DNS Hub', '=HYPERLINK("http://x","y")'),
    ].join('\n')));
    const recent = day(-2);
    fs.writeFileSync(path.join(LOG_DIR, `auth_${recent}.log`), Array.from({ length: 20 }, (_, i) =>
        line(recent, `11:${String(i).padStart(2, '0')}:00`, i % 2 ? 'alice' : 'dave', 'IPAM', `edit ${i}`)).join('\n') + '\nnot an audit line\n');
});
test.after(async () => { await dbManager.closeDB(); });

test('default range is the last 30 days; older archived days are read when asked for', async () => {
    const def = (await request(app).get('/api/audit/logs').set('Authorization', admin).expect(200)).body;
    assert.equal(def.range.to, day(0));
    assert.equal(def.range.from, day(-29));
    assert.ok(def.logs.every(l => l.module !== 'RBAC'), 'the 40-day-old archive is outside the default range');
    assert.equal(def.range.retentionDays, 180);
    assert.equal(def.range.earliestDay, day(-40));

    const old = (await request(app).get('/api/audit/logs').query({ from: day(-41), to: day(-39) }).set('Authorization', admin).expect(200)).body;
    assert.equal(old.total, 2);
    assert.deepEqual(old.logs.map(l => l.user).sort(), ['alice', 'carol']);
});

test('filters, sort and paging happen on the server', async () => {
    const q = { from: day(-5), to: day(0) };
    const page1 = (await request(app).get('/api/audit/logs').query({ ...q, limit: 5 }).set('Authorization', admin).expect(200)).body;
    assert.equal(page1.logs.length, 5);
    assert.ok(page1.total >= 20);
    assert.ok(page1.logs[0].timestamp >= page1.logs[4].timestamp, 'newest first');
    const alice = (await request(app).get('/api/audit/logs').query({ ...q, user: 'alice', module: 'IPAM' }).set('Authorization', admin).expect(200)).body;
    assert.equal(alice.total, 10);
    assert.ok(alice.filters.users.includes('dave'), 'dropdown values span the whole range');
    const kw = (await request(app).get('/api/audit/logs').query({ ...q, q: 'EDIT 1' }).set('Authorization', admin).expect(200)).body;
    assert.equal(kw.total, 11, 'edit 1 and edit 10-19');
    const asc = (await request(app).get('/api/audit/logs').query({ ...q, user: 'dave', order: 'asc', page: 99, limit: 3 }).set('Authorization', admin).expect(200)).body;
    assert.equal(asc.page, 4, 'page clamped to the last one');
});

test('CSV export holds every match and neutralises formulas', async () => {
    const res = await request(app).get('/api/audit/logs').query({ from: day(-41), to: day(0), format: 'csv' }).set('Authorization', admin)
        .buffer(true).parse((r, cb) => { let s = ''; r.on('data', c => { s += c; }); r.on('end', () => cb(null, s)); }).expect(200);
    assert.match(res.headers['content-type'], /text\/csv/);
    const rows = res.body.replace(/^﻿/, '').split('\r\n');
    assert.ok(rows.length >= 23, 'header + all entries, not one page');
    const formulaRow = rows.find(r => r.includes('HYPERLINK'));
    assert.match(formulaRow, /"'=HYPERLINK\(""http:\/\/x"",""y""\)"/);
});

test('retention days come from AUDIT_LOG_RETENTION_DAYS within 30-3650', () => {
    process.env.AUDIT_LOG_RETENTION_DAYS = '400';
    assert.equal(logger.auditRetentionDays(), 400);
    process.env.AUDIT_LOG_RETENTION_DAYS = '5';
    assert.equal(logger.auditRetentionDays(), 30);
    delete process.env.AUDIT_LOG_RETENTION_DAYS;
    assert.equal(logger.auditRetentionDays(), 180);
});

test('settings save audit names what changed and what was removed, never the values', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\nMAIL_RELAY_HOST=mx\nAD_ADMIN_PWD=oldpw\nFORTI_HOST_DR=fw2\n');
    const before = fs.existsSync(logger.getTodayLogFile()) ? fs.readFileSync(logger.getTodayLogFile(), 'utf8').length : 0;
    await request(app).post('/api/settings/save').set('Authorization', admin)
        .send({ FOO: '1', MAIL_RELAY_HOST: 'mx2', AD_ADMIN_PWD: 'newpw', __version: envVersion() }).expect(200);
    const added = fs.readFileSync(logger.getTodayLogFile(), 'utf8').slice(before);
    assert.match(added, /System configurations updated: changed MAIL_RELAY_HOST, AD_ADMIN_PWD; removed FORTI_HOST_DR/);
    assert.doesNotMatch(added, /newpw|oldpw|mx2/);
});
