const { dataDir } = require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { signToken } = require('../helpers/http');
const settingsRouter = require('../../routes/apiSettings');

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRouter);
const superAdmin = `Bearer ${signToken({ username: 'admin', domain: 'local', role: 'SuperAdmin' })}`;

test('save of a Telegram setting tells the worker to reload env, then the Telegram listener, and never starts the listener in the web process', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\n');
    const sent = [];
    global.sendWorkerMessage = (msg) => { sent.push(msg.type); return true; };
    try {
        await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({ FOO: '2', TELEGRAM_BOT_TOKEN: 'abc' }).expect(200);
    } finally {
        delete global.sendWorkerMessage;
    }
    assert.deepEqual(sent, ['RELOAD_ENV', 'RELOAD_TELEGRAM_LISTENER']);
    const loaded = Object.keys(require.cache).some(p => p.endsWith(path.join('services', 'telegramListener.js')));
    assert.equal(loaded, false, 'telegramListener must not be loaded by the web process');
    assert.equal(path.dirname(process.env.SOMP_ENV_PATH), dataDir);
});

test('save without a reachable worker succeeds and does nothing for Telegram', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\n');
    delete global.sendWorkerMessage;
    await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({ FOO: '3' }).expect(200);
    assert.equal(Object.keys(require.cache).some(p => p.endsWith(path.join('services', 'telegramListener.js'))), false);
});

test('save of an unrelated setting reloads env but does not restart the Telegram listener', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\n');
    const sent = [];
    global.sendWorkerMessage = (msg) => { sent.push(msg.type); return true; };
    try {
        await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({ DB_BACKUP_TARGETS: 'system' }).expect(200);
        assert.deepEqual(sent, ['RELOAD_ENV']);
        sent.length = 0;
        await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({ PROXY_ENABLED_MODULES: 'Telegram' }).expect(200);
        assert.deepEqual(sent, ['RELOAD_ENV', 'RELOAD_TELEGRAM_LISTENER']);
    } finally {
        delete global.sendWorkerMessage;
    }
});

// --- Server Provision settings ---------------------------------------------------------------
const prov = require('../../lib/provisioning');

test('provision settings validation: ranges 1-10 / 30-730 / 1-500, whole numbers only, empty = default', () => {
    assert.deepEqual(prov.validateProvisionSettings({}), []);
    assert.deepEqual(prov.validateProvisionSettings({ PROVISION_HOST_CONCURRENCY: '1', PROVISION_HISTORY_RETENTION_DAYS: 30, PROVISION_MIN_FREE_GB: '500' }), []);
    assert.deepEqual(prov.validateProvisionSettings({ PROVISION_HOST_CONCURRENCY: '10', PROVISION_HISTORY_RETENTION_DAYS: '730', PROVISION_MIN_FREE_GB: '1' }), []);
    assert.deepEqual(prov.validateProvisionSettings({ PROVISION_HOST_CONCURRENCY: '', PROVISION_MIN_FREE_GB: '  ' }), []);
    for (const [k, bad] of [['PROVISION_HOST_CONCURRENCY', ['0', '11', '2.5', 'abc', '-1', '1e1']], ['PROVISION_HISTORY_RETENTION_DAYS', ['29', '731', '1.5']], ['PROVISION_MIN_FREE_GB', ['0', '501', 'x']]]) {
        for (const v of bad) assert.equal(prov.validateProvisionSettings({ [k]: v }).length, 1, `${k}=${v}`);
    }
});

test('save rejects out-of-range PROVISION_* values with 400 and writes nothing', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\n');
    const r = await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({ FOO: '2', PROVISION_HOST_CONCURRENCY: '11' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /PROVISION_HOST_CONCURRENCY must be a whole number between 1 and 10/);
    assert.equal(fs.readFileSync(process.env.SOMP_ENV_PATH, 'utf8'), 'FOO=1\n');
});

test('save rejects an invalid detect rule in the master lists with the package name', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\n');
    const r = await request(app).post('/api/settings/save').set('Authorization', superAdmin)
        .send({ REMOTE_INSTALL_SOFTWARE_MASTER: 'A|a.exe||@detect:rpm:x\nB|b.exe|', REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'L|echo|@detect:reg:x' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /REMOTE_INSTALL_SOFTWARE_MASTER A: .*not valid for Windows/);
    assert.match(r.body.error, /REMOTE_INSTALL_LINUX_SOFTWARE_MASTER L: .*not valid for Linux/);
    const ok = await request(app).post('/api/settings/save').set('Authorization', superAdmin)
        .send({ REMOTE_INSTALL_SOFTWARE_MASTER: 'A|a.exe||@detect:reg:A*>=1.0', REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'L|echo|@detect:rpm:l' });
    assert.equal(ok.status, 200);
});

test('valid PROVISION_* values are saved and picked up without a restart (the job service reads the settings file each time)', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\n');
    const keys = ['PROVISION_HOST_CONCURRENCY', 'PROVISION_HISTORY_RETENTION_DAYS', 'PROVISION_MIN_FREE_GB'];
    const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    try {
        await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({ PROVISION_HOST_CONCURRENCY: '7', PROVISION_HISTORY_RETENTION_DAYS: '90', PROVISION_MIN_FREE_GB: '12' }).expect(200);
        const { readEnv } = require('../../lib/envEditor');
        assert.deepEqual(prov.loadProvisionSettings(readEnv(), {}), { hostConcurrency: 7, historyRetentionDays: 90, minFreeGB: 12 });
    } finally {
        for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    }
});

test('the provision job service reads the settings at submit / pre-check / cleanup time (no cached values)', () => {
    const jobsSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'provisionJobs.js'), 'utf8');
    assert.match(jobsSrc, /loadProvisionSettings\(config\)/, 'submit reads the current settings');
    assert.match(jobsSrc, /loadProvisionSettings\(readConfig \? \(await readConfig\(\)\) : \{\}\)/, 'daily cleanup reads the retention setting each run');
    const installSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'install.js'), 'utf8');
    assert.match(installSrc, /settings: prov\.loadProvisionSettings\(config\)/, 'pre-check reads minFreeGB per request');
});

test('round trip through the real save route: stored encoding -> readEnv -> shared parser (Server Provision and Nutanix call sites)', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\n');
    const cfgMod = require('../../lib/provisioningConfig');
    const { readEnv } = require('../../lib/envEditor');
    const win = 'A|\\\\nas01\\soft\\a.exe|/S\nB|b\\setup.exe|\nC|c.msi|/qn||@detect:reg:C*>=1.0';
    const lin = 'L1|echo one|@detect:cmd:test -f /x\nL2|yum install -y foo\nL3|echo three|@detect:rpm:three';
    await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({
        REMOTE_INSTALL_BUS: 'X', REMOTE_INSTALL_SOFTWARE_MASTER: win, REMOTE_INSTALL_SOFTWARE_X: 'A,B,C',
        REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: lin, REMOTE_INSTALL_LINUX_SOFTWARE_X: 'L1,L2,L3'
    }).expect(200);
    const stored = readEnv();
    assert.ok(!/[\r\n]/.test(stored.REMOTE_INSTALL_SOFTWARE_MASTER), 'stored on one line with the three-character separator');
    const cfg = cfgMod.loadInstallConfig(stored, {});
    assert.deepEqual(cfg.masterList.map(x => [x.name, x.path, x.args]), [['A', '\\\\nas01\\soft\\a.exe', '/S'], ['B', 'b\\setup.exe', ''], ['C', 'c.msi', '/qn']]);
    assert.deepEqual(cfg.masterList[2].detect, { type: 'reg', value: 'C*', minVersion: '1.0' });
    assert.deepEqual(cfg.linuxMasterList.map(x => [x.name, x.command]), [['L1', 'echo one'], ['L2', 'yum install -y foo'], ['L3', 'echo three']]);
    assert.equal(cfg.linuxMasterList[0].detect.value, 'test -f /x');
    const nut = cfgMod.nutanixRemoteInstallConfig(stored, {});
    assert.deepEqual(nut.masterList.map(x => x.name), ['A', 'B', 'C']);
    assert.deepEqual(nut.buSoftwareMapping, { X: ['A', 'B', 'C'] });
    assert.equal(cfgMod.resolveSoftware(cfg, 'X', 'linux').length, 3);
});

test('save rejects a Linux command with a backslash-n sequence', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\n');
    const r = await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({ REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: 'L|printf "a\\nb"' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /backslash-n/);
});

test('M7: an old out-of-range stored value does not block saving other settings; changing it to a bad value does', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\nPROVISION_MIN_FREE_GB=0\n');
    await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({ FOO: '2', PROVISION_MIN_FREE_GB: '0' }).expect(200);
    await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({ PROVISION_MIN_FREE_GB: '600' }).expect(400);
    assert.equal(prov.loadProvisionSettings({ PROVISION_MIN_FREE_GB: '0' }, {}).minFreeGB, 1, 'runtime clamps');
});

test('N1: save -> GET (decoded) -> edit one line -> save -> GET -> parse; the Nutanix call sites agree; other keys are untouched in GET', async () => {
    fs.writeFileSync(process.env.SOMP_ENV_PATH, 'FOO=1\n');
    const cfgMod = require('../../lib/provisioningConfig');
    const win = 'A|\\\\nas01\\soft\\a.exe|/S\nB|soft\\notepad\\setup.exe|\nC|c.msi|/qn||@detect:reg:C*>=1.0';
    const lin = 'L1|echo one|@detect:cmd:test -f /x\nL2|yum install -y foo\nL3|echo three|@detect:rpm:three';
    const keys = { REMOTE_INSTALL_BUS: 'X', REMOTE_INSTALL_SOFTWARE_X: 'A,B,C', REMOTE_INSTALL_LINUX_SOFTWARE_X: 'L1,L2,L3', FOO: 'a\\nb|c' };
    await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({ ...keys, REMOTE_INSTALL_SOFTWARE_MASTER: win, REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: lin }).expect(200);
    const g1 = (await request(app).get('/api/settings').set('Authorization', superAdmin).expect(200)).body;
    assert.equal(g1.REMOTE_INSTALL_SOFTWARE_MASTER, win, 'textarea gets real newlines, one entry per line');
    assert.equal(g1.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER, lin);
    for (const k of Object.keys(keys)) assert.equal(g1[k], require('../../lib/envEditor').readEnv()[k], `${k} unchanged in GET`);
    // edit one line of each list and save the GET value again
    const win2 = g1.REMOTE_INSTALL_SOFTWARE_MASTER.replace('B|soft\\notepad\\setup.exe|', 'B|soft\\notepad\\setup2.exe|/q');
    const lin2 = g1.REMOTE_INSTALL_LINUX_SOFTWARE_MASTER.replace('yum install -y foo', 'yum install -y bar');
    await request(app).post('/api/settings/save').set('Authorization', superAdmin).send({ ...keys, REMOTE_INSTALL_SOFTWARE_MASTER: win2, REMOTE_INSTALL_LINUX_SOFTWARE_MASTER: lin2 }).expect(200);
    const g2 = (await request(app).get('/api/settings').set('Authorization', superAdmin)).body;
    const stored = require('../../lib/envEditor').readEnv();
    const cfg = cfgMod.loadInstallConfig(stored, {});
    assert.deepEqual(cfg.masterList.map(x => [x.name, x.path, x.args]), [['A', '\\\\nas01\\soft\\a.exe', '/S'], ['B', 'soft\\notepad\\setup2.exe', '/q'], ['C', 'c.msi', '/qn']]);
    assert.deepEqual(cfg.linuxMasterList.map(x => [x.name, x.command]), [['L1', 'echo one'], ['L2', 'yum install -y bar'], ['L3', 'echo three']]);
    assert.equal(cfg.linuxMasterList[0].detect.value, 'test -f /x');
    const nut = cfgMod.nutanixRemoteInstallConfig(stored, {});
    assert.deepEqual(nut.masterList.map(x => x.name), ['A', 'B', 'C']);
    assert.equal(nut.masterList[1].path, 'soft\\notepad\\setup2.exe');
    assert.equal(cfgMod.resolveSoftware(cfg, 'X', 'linux')[1].command, 'yum install -y bar');
    assert.equal(g2.REMOTE_INSTALL_SOFTWARE_MASTER, win2);
});
