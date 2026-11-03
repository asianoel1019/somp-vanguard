// Connections to the MySQL / PostgreSQL / SQL Server targets of the Database pages: one place for timeouts, TLS and
// closing connections, plus the read-only execution used by the SQL Terminal.
const { decryptText } = require('./crypto');

// SQL Terminal statements are cancelled after this long on every engine
const QUERY_TIMEOUT_MS = 30000;
// The SQL Terminal returns at most this many rows; one extra row is fetched to tell the user the result was cut
const MAX_ROWS = 1000;

let drivers = null;
function getDrivers() {
    if (!drivers) drivers = { mysql: require('mysql2/promise'), pg: require('pg'), mssql: require('mssql') };
    return drivers;
}

// Stored records carry password_enc; ad-hoc connection tests carry the typed password
const passwordOf = (db) => (db.password !== undefined ? db.password || '' : (db.password_enc ? decryptText(db.password_enc) : ''));

/** SQL Server connection settings; host may be host\INSTANCE, which connects by instance name instead of port. */
function mssqlConfig(db, connectTimeoutMs) {
    const [server, instanceName] = String(db.host).split('\\');
    return {
        user: db.username,
        password: passwordOf(db),
        server,
        ...(instanceName ? {} : { port: parseInt(db.port || 1433, 10) }),
        database: db.database || undefined,
        requestTimeout: QUERY_TIMEOUT_MS,
        options: {
            encrypt: true,
            // internal SQL Servers often present a self-signed certificate; the connection record decides
            trustServerCertificate: db.trustServerCertificate === true,
            connectTimeout: connectTimeoutMs,
            ...(instanceName ? { instanceName } : {})
        }
    };
}

/**
 * Open one connection.
 * @returns {Promise<{ engine, query: (sql, params?) => Promise<object[]>, close: () => Promise<void>, raw }>}
 *   params: an array for MySQL / PostgreSQL placeholders, an object of named inputs (@name) for SQL Server
 */
async function connect(db, { connectTimeoutMs = 5000 } = {}) {
    const d = getDrivers();
    if (db.engine === 'MySQL') {
        const conn = await d.mysql.createConnection({
            host: db.host, port: parseInt(db.port || 3306, 10), user: db.username, password: passwordOf(db),
            database: db.database || undefined, connectTimeout: connectTimeoutMs
        });
        return {
            engine: db.engine,
            raw: conn,
            query: async (q, params) => (await conn.query({ sql: q, timeout: QUERY_TIMEOUT_MS }, params))[0],
            close: () => conn.end().catch(() => {})
        };
    }
    if (db.engine === 'PostgreSQL') {
        const client = new d.pg.Client({
            host: db.host, port: parseInt(db.port || 5432, 10), user: db.username, password: passwordOf(db),
            database: db.database || undefined, connectionTimeoutMillis: connectTimeoutMs, statement_timeout: QUERY_TIMEOUT_MS
        });
        try {
            await client.connect();
        } catch (e) {
            await client.end().catch(() => {});
            throw e;
        }
        return {
            engine: db.engine,
            raw: client,
            query: async (q, params) => (await client.query(q, params)).rows,
            close: () => client.end().catch(() => {})
        };
    }
    if (db.engine === 'SQLServer') {
        const pool = new d.mssql.ConnectionPool(mssqlConfig(db, connectTimeoutMs));
        try {
            await pool.connect();
        } catch (e) {
            await pool.close().catch(() => {});
            throw e;
        }
        return {
            engine: db.engine,
            raw: pool,
            query: async (q, params) => {
                const request = pool.request();
                Object.entries(params || {}).forEach(([k, v]) => request.input(k, v));
                return (await request.query(q)).recordset || [];
            },
            close: () => pool.close().catch(() => {})
        };
    }
    throw new Error(`Unsupported database engine: ${db.engine}`);
}

/** Run fn(query, connection) on a fresh connection that is always closed afterwards. */
async function withConnection(db, connectTimeoutMs, fn) {
    const c = await connect(db, { connectTimeoutMs });
    try {
        return await fn(c.query, c);
    } finally {
        await c.close();
    }
}

/** Connect (and ping) within timeoutMs. A connection that only completes after the timeout is closed, not leaked. */
async function testConnection(db, timeoutMs = 3000) {
    let timer;
    const pending = connect(db, { connectTimeoutMs: timeoutMs });
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Connection timed out (${timeoutMs / 1000}s limit)`)), timeoutMs);
    });
    try {
        const c = await Promise.race([pending, timeout]);
        try {
            if (db.engine === 'MySQL') await c.raw.ping();
            else await c.query('SELECT 1');
        } finally {
            await c.close();
        }
    } catch (e) {
        pending.then(c => c.close(), () => {});
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

const capRows = (rows) => {
    const list = Array.isArray(rows) ? rows : [];
    return { rows: list.slice(0, MAX_ROWS), truncated: list.length > MAX_ROWS };
};

/**
 * Run one already-validated read-only statement inside a read-only (or rolled-back) transaction, fetching at most
 * MAX_ROWS + 1 rows on the server side. The statement itself is never rewritten:
 * MySQL sql_select_limit, a PostgreSQL cursor, and SQL Server SET ROWCOUNT cap the rows instead.
 * @param {string} leading the statement's first keyword (from sqlGuard)
 * @returns {Promise<{ rows: object[], truncated: boolean }>}
 */
async function runReadOnly(db, query, leading) {
    const q = String(query).replace(/[;\s]+$/, '');
    return withConnection(db, 5000, async (_, c) => {
        if (db.engine === 'MySQL') {
            const conn = c.raw;
            // MAX_EXECUTION_TIME exists from MySQL 5.7.8; MariaDB lacks it and the client timeout still applies
            await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${QUERY_TIMEOUT_MS}`).catch(() => {});
            await conn.query(`SET SESSION sql_select_limit = ${MAX_ROWS + 1}`);
            await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED');
            await conn.query('START TRANSACTION READ ONLY');
            try {
                const [rows] = await conn.query({ sql: q, timeout: QUERY_TIMEOUT_MS });
                return capRows(rows);
            } finally {
                await conn.query('ROLLBACK').catch(() => {});
            }
        }
        if (db.engine === 'PostgreSQL') {
            const client = c.raw;
            await client.query('BEGIN READ ONLY');
            try {
                // SHOW and EXPLAIN cannot sit behind a cursor; their output is small
                if (leading === 'SELECT' || leading === 'WITH') {
                    await client.query(`DECLARE vanguard_cursor NO SCROLL CURSOR FOR\n${q}\n`);
                    return capRows((await client.query(`FETCH FORWARD ${MAX_ROWS + 1} FROM vanguard_cursor`)).rows);
                }
                return capRows((await client.query(q)).rows);
            } finally {
                await client.query('ROLLBACK').catch(() => {});
            }
        }
        if (db.engine === 'SQLServer') {
            const { mssql } = getDrivers();
            const tx = new mssql.Transaction(c.raw);
            await tx.begin();
            try {
                const result = await new mssql.Request(tx).query(`SET ROWCOUNT ${MAX_ROWS + 1};\n${q}\n`);
                return capRows(result.recordset);
            } finally {
                await tx.rollback().catch(() => {});
            }
        }
        throw new Error(`Unsupported database engine: ${db.engine}`);
    });
}

/** Test hook: replace the database drivers ({ mysql, pg, mssql }); null restores the real ones. */
function setDriversForTest(fake) { drivers = fake; }

module.exports = { QUERY_TIMEOUT_MS, MAX_ROWS, mssqlConfig, connect, withConnection, testConnection, runReadOnly, setDriversForTest };
