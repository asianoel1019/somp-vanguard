require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Regression guard for the 2026-10 bug: the web process ingests agent reports, so it must register the evaluators.
test('index.js (web process) registers the alert evaluators after the DB is ready', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
    const init = src.indexOf('initDB().then(');
    const reg = src.indexOf('registerEvaluator()');
    assert.ok(init > 0, 'initDB().then( found');
    assert.ok(reg > init, 'registerEvaluator() is called inside/after initDB().then(');
});

test('index.js mounts /api/alert-quality', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
    assert.match(src, /app\.use\('\/api\/alert-quality', require\('\.\/routes\/alertQuality'\)\)/);
});

test('web process sends the startup notice from the app.listen callback; the worker does not', () => {
    const index = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
    const worker = fs.readFileSync(path.join(__dirname, '../../worker.js'), 'utf8');
    const listen = index.indexOf('app.listen(PORT');
    const call = index.indexOf('notifyStartup(');
    const end = index.indexOf('// End of app.listen()');
    assert.ok(listen > 0 && call > listen && call < end, 'notifyStartup( is called inside the app.listen callback');
    assert.equal(worker.includes('notifyStartup'), false);
});

test('worker.js handles the RUN_BACKUP_NOW IPC message with runManualBackup', () => {
    const worker = fs.readFileSync(path.join(__dirname, '../../worker.js'), 'utf8');
    assert.ok(worker.includes("msg.type === 'RUN_BACKUP_NOW'"));
    assert.ok(worker.includes('runManualBackup(msg.requestedBy, msg.requestId)'));
});

test('settings save tells the worker to reload .env, and the worker handles RELOAD_ENV', () => {
    const settings = fs.readFileSync(path.join(__dirname, '../../routes/apiSettings.js'), 'utf8');
    const worker = fs.readFileSync(path.join(__dirname, '../../worker.js'), 'utf8');
    assert.ok(settings.includes("type: 'RELOAD_ENV'"));
    assert.ok(worker.includes("msg.type === 'RELOAD_ENV'"));
});

test('index.js closes an unfinished backup status when the worker exits', () => {
    // the close-out lives in lib/workerExitHandler.js (behaviour tested in provision.p4.test.js); index.js calls it on exit
    const index = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
    const handler = fs.readFileSync(path.join(__dirname, '../../lib/workerExitHandler.js'), 'utf8');
    assert.ok(index.includes("require('./lib/workerExitHandler').handleWorkerExit("));
    assert.ok(handler.includes('Background worker exited during backup'));
});

test('only the web process may rewrite .env: index uses rewrite:true, worker rewrite:false', () => {
    const index = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
    const worker = fs.readFileSync(path.join(__dirname, '../../worker.js'), 'utf8');
    assert.ok(index.includes('loadEnv({ rewrite: true'));
    assert.ok(worker.includes('loadEnv({ rewrite: false })'));
    assert.equal(worker.includes('writeEnv'), false);
});

test('global.sendWorkerMessage reports failure when the IPC channel is closed', () => {
    const index = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
    assert.ok(index.includes('workerProcess && workerProcess.connected'));
});

test('the Telegram listener is started only by the worker (no initTelegramListener in routes/ or index.js)', () => {
    const root = path.join(__dirname, '../..');
    const files = [path.join(root, 'index.js')];
    for (const f of fs.readdirSync(path.join(root, 'routes'))) if (f.endsWith('.js')) files.push(path.join(root, 'routes', f));
    for (const f of files) assert.equal(fs.readFileSync(f, 'utf8').includes('initTelegramListener'), false, f);
    const worker = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
    assert.ok(worker.includes('initTelegramListener()'));
    assert.ok(worker.includes("msg.type === 'RELOAD_TELEGRAM_LISTENER'"));
});
