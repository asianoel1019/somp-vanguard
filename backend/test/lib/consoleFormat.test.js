const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cf = require('../../lib/consoleFormat');

const AT = new Date('2026-11-02T00:00:07.143Z'); // 08:00:07.143 in Asia/Taipei

test('localTimestamp: SYSTEM_TIMEZONE local time with milliseconds', () => {
    assert.equal(cf.localTimestamp(AT, 'Asia/Taipei'), '2026-11-02T08:00:07.143');
    assert.equal(cf.localTimestamp(new Date('2026-11-02T16:30:00.005Z'), 'Asia/Taipei'), '2026-11-03T00:30:00.005');
    assert.equal(cf.localTimestamp(AT, 'Not/AZone'), '2026-11-02T00:00:07.143');
});

test('formatLine: [time] [process] [LEVEL] message', () => {
    process.env.SYSTEM_TIMEZONE = 'Asia/Taipei';
    assert.equal(cf.formatLine('Worker', 'log', ['[Inventory] Scan started'], AT), '[2026-11-02T08:00:07.143] [Worker] [INFO] [Inventory] Scan started');
    assert.equal(cf.formatLine('Web', 'warn', ['[X] a'], AT), '[2026-11-02T08:00:07.143] [Web] [WARN] [X] a');
    assert.equal(cf.formatLine('Web', 'error', ['[X] failed:', 'boom', 3], AT), '[2026-11-02T08:00:07.143] [Web] [ERROR] [X] failed: boom 3');
    assert.equal(cf.formatLine('Web', 'info', [{ a: 1 }], AT), '[2026-11-02T08:00:07.143] [Web] [INFO] { a: 1 }');
});

test('formatLine: a timestamp the caller already added is removed (no double, differently zoned times)', () => {
    process.env.SYSTEM_TIMEZONE = 'Asia/Taipei';
    const expected = '[2026-11-02T08:00:07.143] [Worker] [INFO] [WebhookHub] [SUCCESS] ok';
    assert.equal(cf.formatLine('Worker', 'log', ['2026-11-02T00:00:07.143Z: [WebhookHub] [SUCCESS] ok'], AT), expected);
    assert.equal(cf.formatLine('Worker', 'log', ['[2026-11-02T08:00:06] [WebhookHub] [SUCCESS] ok'], AT), expected);
    assert.equal(cf.formatLine('Worker', 'log', ['[2026-11-02 08:00:06.12] [WebhookHub] [SUCCESS] ok'], AT), expected);
    // only a LEADING timestamp is touched
    assert.equal(cf.stripLeadingTimestamp('[Logger] next run 2026-11-02T06:00:00'), '[Logger] next run 2026-11-02T06:00:00');
});

test('file sink: lines go to app_<local date>.log, a new file per day; APP_LOG_FILE=false disables it', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-applog-'));
    t.after(() => { cf.disableFileSink(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.APP_LOG_FILE; });
    assert.equal(cf.enableFileSink(dir), true);
    cf.writeToFile('[2026-11-02T23:59:59.999] [Web] [INFO] a');
    cf.writeToFile('[2026-11-02T23:59:59.999] [Worker] [INFO] b');
    cf.writeToFile('[2026-11-03T00:00:00.001] [Web] [INFO] c');
    cf.disableFileSink();
    assert.equal(fs.readFileSync(path.join(dir, 'app_2026-11-02.log'), 'utf8'),
        '[2026-11-02T23:59:59.999] [Web] [INFO] a\n[2026-11-02T23:59:59.999] [Worker] [INFO] b\n');
    assert.equal(fs.readFileSync(path.join(dir, 'app_2026-11-03.log'), 'utf8'), '[2026-11-03T00:00:00.001] [Web] [INFO] c\n');

    process.env.APP_LOG_FILE = 'false';
    assert.equal(cf.enableFileSink(dir), false);
    cf.writeToFile('[2026-11-04T00:00:00.000] [Web] [INFO] d');
    assert.equal(fs.existsSync(path.join(dir, 'app_2026-11-04.log')), false);
});

test('file sink: an unwritable directory never breaks logging', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'somp-applog-'));
    const asFile = path.join(dir, 'not-a-dir');
    fs.writeFileSync(asFile, '');
    t.after(() => { cf.disableFileSink(); fs.rmSync(dir, { recursive: true, force: true }); });
    assert.equal(cf.enableFileSink(asFile), false);
    assert.doesNotThrow(() => cf.writeToFile('[2026-11-02T08:00:00.000] [Web] [INFO] x'));
});
