// dbClient against fake drivers: read-only execution per engine, server-side row caps, connections always closed.
require('../helpers/setupEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const dbClient = require('../../lib/dbClient');

const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, id2: i + 1 }));

function fakeDrivers({ resultRows = 3, connectDelayMs = 0, failConnect = false } = {}) {
    const log = { sql: [], closed: 0, opened: 0, configs: [] };
    const answer = (sqlText) => {
        log.sql.push(sqlText);
        return /FROM t/.test(sqlText) ? rowsOf(resultRows) : [];
    };
    const mysql = {
        createConnection: async (cfg) => {
            log.configs.push(cfg);
            if (connectDelayMs) await new Promise(r => setTimeout(r, connectDelayMs));
            if (failConnect) throw new Error('ECONNREFUSED');
            log.opened++;
            return {
                query: async (q) => [answer(typeof q === 'string' ? q : q.sql)],
                ping: async () => {},
                end: async () => { log.closed++; },
            };
        },
    };
    class Client {
        constructor(cfg) { log.configs.push(cfg); }
        async connect() { log.opened++; }
        async query(q) {
            const rows = answer(q);
            // FETCH returns what the cursor yields: at most the requested count
            const fetch = q.match(/^FETCH FORWARD (\d+)/);
            if (fetch) return { rows: rowsOf(resultRows).slice(0, Number(fetch[1])) };
            return { rows };
        }
        async end() { log.closed++; }
    }
    class ConnectionPool {
        constructor(cfg) { log.configs.push(cfg); }
        async connect() { log.opened++; }
        async close() { log.closed++; }
        request() { return new Request(); }
    }
    class Transaction {
        async begin() { log.sql.push('BEGIN TRAN'); }
        async rollback() { log.sql.push('ROLLBACK TRAN'); }
    }
    class Request {
        input() {}
        async query(q) {
            const rows = answer(q);
            const cap = q.match(/^SET ROWCOUNT (\d+);/);
            return { recordset: cap ? rows.slice(0, Number(cap[1])) : rows };
        }
    }
    return { drivers: { mysql, pg: { Client }, mssql: { ConnectionPool, Transaction, Request } }, log };
}

const base = { host: 'db01.example.test', username: 'u', password: 'pw', database: 'app' };

test.afterEach(() => dbClient.setDriversForTest(null));

test('MySQL: read-only transaction, sql_select_limit caps rows, query runs unchanged, connection closed', async () => {
    const { drivers, log } = fakeDrivers({ resultRows: 1500 });
    dbClient.setDriversForTest(drivers);
    // MySQL honours sql_select_limit itself; the fake returns everything, so the cap below is the client-side slice
    const r = await dbClient.runReadOnly({ ...base, engine: 'MySQL' }, 'SELECT * FROM t a JOIN t b ON a.id = b.id;', 'SELECT');
    assert.equal(r.rows.length, dbClient.MAX_ROWS);
    assert.equal(r.truncated, true);
    assert.ok(log.sql.includes(`SET SESSION sql_select_limit = ${dbClient.MAX_ROWS + 1}`));
    assert.ok(log.sql.includes('START TRANSACTION READ ONLY'));
    assert.ok(log.sql.includes('SELECT * FROM t a JOIN t b ON a.id = b.id'), 'not wrapped in SELECT * FROM (...)');
    assert.equal(log.sql[log.sql.length - 1], 'ROLLBACK');
    assert.equal(log.closed, log.opened);
});

test('PostgreSQL: SELECT goes through a cursor, SHOW runs directly, both read-only', async () => {
    const { drivers, log } = fakeDrivers({ resultRows: 1200 });
    dbClient.setDriversForTest(drivers);
    const r = await dbClient.runReadOnly({ ...base, engine: 'PostgreSQL' }, 'WITH x AS (SELECT 1) SELECT * FROM t ORDER BY id -- note', 'WITH');
    assert.equal(r.truncated, true);
    assert.equal(r.rows.length, dbClient.MAX_ROWS);
    assert.ok(log.sql.some(s => s.startsWith('DECLARE vanguard_cursor NO SCROLL CURSOR FOR\nWITH x AS')));
    assert.ok(log.sql.includes(`FETCH FORWARD ${dbClient.MAX_ROWS + 1} FROM vanguard_cursor`));
    assert.equal(log.sql[0], 'BEGIN READ ONLY');

    log.sql.length = 0;
    await dbClient.runReadOnly({ ...base, engine: 'PostgreSQL' }, 'SHOW search_path', 'SHOW');
    assert.deepEqual(log.sql, ['BEGIN READ ONLY', 'SHOW search_path', 'ROLLBACK']);
    assert.equal(log.closed, log.opened);
    assert.equal(log.configs[0].statement_timeout, dbClient.QUERY_TIMEOUT_MS);
});

test('SQL Server: SET ROWCOUNT caps rows inside a rolled-back transaction', async () => {
    const { drivers, log } = fakeDrivers({ resultRows: 5 });
    dbClient.setDriversForTest(drivers);
    const r = await dbClient.runReadOnly({ ...base, engine: 'SQLServer', port: 1433 }, 'SELECT * FROM t ORDER BY id', 'SELECT');
    assert.equal(r.rows.length, 5);
    assert.equal(r.truncated, false);
    assert.ok(log.sql.some(s => s.startsWith(`SET ROWCOUNT ${dbClient.MAX_ROWS + 1};\nSELECT * FROM t ORDER BY id`)));
    assert.equal(log.sql[log.sql.length - 1], 'ROLLBACK TRAN');
    assert.equal(log.closed, 1);
});

test('SQL Server config: named instance replaces the port, certificate trust is per record', () => {
    const named = dbClient.mssqlConfig({ ...base, engine: 'SQLServer', host: 'sql01\\INST1', port: 1433 }, 3000);
    assert.equal(named.server, 'sql01');
    assert.equal(named.options.instanceName, 'INST1');
    assert.equal(named.port, undefined);
    assert.equal(named.options.trustServerCertificate, false);
    assert.equal(dbClient.mssqlConfig({ ...base, host: 'sql01', trustServerCertificate: true }, 3000).options.trustServerCertificate, true);
});

test('testConnection: timeout rejects, and the connection that arrives late is closed', async () => {
    const { drivers, log } = fakeDrivers({ connectDelayMs: 150 });
    dbClient.setDriversForTest(drivers);
    await assert.rejects(dbClient.testConnection({ ...base, engine: 'MySQL' }, 50), /timed out/);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(log.opened, 1);
    assert.equal(log.closed, 1, 'late connection closed, not leaked');

    const failing = fakeDrivers({ failConnect: true });
    dbClient.setDriversForTest(failing.drivers);
    await assert.rejects(dbClient.testConnection({ ...base, engine: 'MySQL' }, 1000), /ECONNREFUSED/);
});

test('stored records decrypt their password; ad-hoc records use the typed one', async () => {
    const { encryptText } = require('../../lib/crypto');
    const { drivers, log } = fakeDrivers();
    dbClient.setDriversForTest(drivers);
    await dbClient.withConnection({ ...base, password: undefined, password_enc: encryptText('s3cret'), engine: 'MySQL' }, 1000, async () => {});
    await dbClient.withConnection({ ...base, password: 'typed', engine: 'MySQL' }, 1000, async () => {});
    assert.equal(log.configs[0].password, 's3cret');
    assert.equal(log.configs[1].password, 'typed');
});
