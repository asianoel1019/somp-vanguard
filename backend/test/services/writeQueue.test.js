// The write queue (queueRun / flushWriteBuffer) on SQLite: every chunk of queued statements is one transaction that
// commits after its last statement, the event loop runs between chunks, a failing statement costs only itself, and
// an async transaction callback commits (or rolls back) only when it has finished.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbManager = require('../../services/db');

let driver;
test.before(async () => {
    driver = await dbManager.initDB();
    driver.exec('CREATE TABLE IF NOT EXISTS wq_test (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
});
test.after(async () => { await dbManager.closeDB(); });
test.beforeEach(() => { driver.run('DELETE FROM wq_test'); });

const count = () => driver.get('SELECT COUNT(*) AS n FROM wq_test').n;

test('queued statements are written in transactions of 200, committed after their last statement, with the event loop running in between', async (t) => {
    const log = [];
    const realExec = driver.db.exec.bind(driver.db);
    t.mock.method(driver.db, 'exec', (sql) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) log.push(sql.split(' ')[0].replace(';', ''));
        return realExec(sql);
    });
    const realRun = driver.run.bind(driver);
    t.mock.method(driver, 'run', (sql, params) => { log.push('run'); return realRun(sql, params); });

    for (let i = 0; i < 450; i++) dbManager.queueRun('INSERT INTO wq_test (v) VALUES (?)', [`v${i}`]);
    setImmediate(() => log.push('event loop'));
    await dbManager.flushWriteBuffer();

    assert.equal(count(), 450);
    const shape = [];
    for (const e of log) {
        const last = shape[shape.length - 1];
        if (e === 'run' && last && last.startsWith('run')) shape[shape.length - 1] = `run x${Number(last.slice(5) || 1) + 1}`;
        else shape.push(e === 'run' ? 'run x1' : e);
    }
    assert.deepEqual(shape.filter(s => s !== 'event loop'), ['BEGIN', 'run x200', 'COMMIT', 'BEGIN', 'run x200', 'COMMIT', 'BEGIN', 'run x50', 'COMMIT']);
    assert.ok(shape.indexOf('event loop') > 0 && shape.indexOf('event loop') < shape.length - 1, `the event loop ran between chunks: ${shape.join(', ')}`);
});

test('a failing statement is skipped; the rest of its chunk is written', async (t) => {
    const errors = [];
    t.mock.method(console, 'error', (...a) => errors.push(a.join(' ')));
    dbManager.queueRun('INSERT INTO wq_test (v) VALUES (?)', ['a']);
    dbManager.queueRun('INSERT INTO wq_test (v) VALUES (?)', [null]); // NOT NULL
    dbManager.queueRun('INSERT INTO wq_test (v) VALUES (?)', ['c']);
    await dbManager.flushWriteBuffer();
    assert.deepEqual(driver.all('SELECT v FROM wq_test ORDER BY id').map(r => r.v), ['a', 'c']);
    assert.ok(errors.some(e => /1 of 3 queued statement\(s\) failed/.test(e)), errors.join('\n'));
});

test('an async transaction callback commits after its last statement and rolls everything back on failure', async () => {
    await driver.transaction(async (trx) => {
        trx.run('INSERT INTO wq_test (v) VALUES (?)', ['x']);
        await null;
        trx.run('INSERT INTO wq_test (v) VALUES (?)', ['y']);
        assert.equal(driver.db.isTransaction, true, 'still inside the transaction after an await');
    });
    assert.equal(driver.db.isTransaction, false);
    assert.equal(count(), 2);

    await assert.rejects(driver.transaction(async (trx) => {
        trx.run('INSERT INTO wq_test (v) VALUES (?)', ['p']);
        await null;
        trx.run('INSERT INTO wq_test (v) VALUES (?)', ['q']);
        throw new Error('stop');
    }), /stop/);
    assert.equal(count(), 2, 'both statements rolled back');

    await dbManager.bulkInsert('wq_test', [{ v: 'b1' }, { v: 'b2' }, { v: 'b3' }]);
    assert.equal(count(), 5);
    assert.equal(driver.db.isTransaction, false);
});
