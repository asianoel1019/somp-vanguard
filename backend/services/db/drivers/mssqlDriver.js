/**
 * Microsoft SQL Server (MSSQL) Driver Implementation (using mssql)
 */
const sql = require('mssql');
const { translateSql } = require('../translator');

class MssqlDriver {
    constructor(config = {}) {
        this.config = {
            server: config.host || process.env.DB_HOST || '127.0.0.1',
            port: parseInt(config.port || process.env.DB_PORT || '1433', 10),
            user: config.user || process.env.DB_USER || 'sa',
            password: config.password || process.env.DB_PASSWORD || '',
            database: config.database || process.env.DB_NAME || 'somp_vanguard',
            options: {
                encrypt: process.env.DB_ENCRYPT === 'true',
                trustServerCertificate: true,
                enableArithAbort: true
            },
            pool: {
                max: parseInt(process.env.DB_POOL_MAX || '30', 10),
                min: parseInt(process.env.DB_POOL_MIN || '5', 10),
                idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10)
            }
        };
        this.pool = null;
        this.dbType = 'mssql';
    }

    async init() {
        this.pool = await new sql.ConnectionPool(this.config).connect();
        const request = this.pool.request();
        const res = await request.query('SELECT @@VERSION as version;');
        console.log(`[MSSQL Driver] Connected successfully to ${this.config.server}:${this.config.port}/${this.config.database}`);
        console.log(`[MSSQL Driver] Version: ${res.recordset[0]?.version?.split('\n')[0] || 'MSSQL'}`);
    }

    _prepareRequest(rawSql, params = []) {
        const translatedSql = translateSql(rawSql, 'mssql');
        const req = this.pool.request();
        params.forEach((val, i) => {
            req.input(`p${i + 1}`, val);
        });
        return { req, sql: translatedSql };
    }

    async get(sqlStr, params = []) {
        try {
            const { req, sql: mssqlSql } = this._prepareRequest(sqlStr, params);
            const res = await req.query(mssqlSql);
            return res.recordset && res.recordset.length > 0 ? res.recordset[0] : null;
        } catch (err) {
            console.error(`[MSSQL Error] get() failed: "${sqlStr}":`, err.message);
            return null;
        }
    }

    async all(sqlStr, params = []) {
        try {
            const { req, sql: mssqlSql } = this._prepareRequest(sqlStr, params);
            const res = await req.query(mssqlSql);
            return res.recordset || [];
        } catch (err) {
            console.error(`[MSSQL Error] all() failed: "${sqlStr}":`, err.message);
            return [];
        }
    }

    async run(sqlStr, params = []) {
        try {
            const { req, sql: mssqlSql } = this._prepareRequest(sqlStr, params);
            const res = await req.query(mssqlSql);
            return {
                changes: res.rowsAffected ? res.rowsAffected[0] : 0
            };
        } catch (err) {
            console.error(`[MSSQL Error] run() failed: "${sqlStr}":`, err.message);
            throw err;
        }
    }

    async exec(sqlStr) {
        try {
            const req = this.pool.request();
            return await req.batch(sqlStr);
        } catch (err) {
            console.error(`[MSSQL Error] exec() failed:`, err.message);
            throw err;
        }
    }

    async transaction(callback) {
        const transaction = new sql.Transaction(this.pool);
        await transaction.begin();
        try {
            const trxWrapper = {
                get: async (sqlStr, params = []) => {
                    const translatedSql = translateSql(sqlStr, 'mssql');
                    const req = new sql.Request(transaction);
                    params.forEach((val, i) => req.input(`p${i + 1}`, val));
                    const res = await req.query(translatedSql);
                    return res.recordset && res.recordset.length > 0 ? res.recordset[0] : null;
                },
                all: async (sqlStr, params = []) => {
                    const translatedSql = translateSql(sqlStr, 'mssql');
                    const req = new sql.Request(transaction);
                    params.forEach((val, i) => req.input(`p${i + 1}`, val));
                    const res = await req.query(translatedSql);
                    return res.recordset || [];
                },
                run: async (sqlStr, params = []) => {
                    const translatedSql = translateSql(sqlStr, 'mssql');
                    const req = new sql.Request(transaction);
                    params.forEach((val, i) => req.input(`p${i + 1}`, val));
                    const res = await req.query(translatedSql);
                    return { changes: res.rowsAffected ? res.rowsAffected[0] : 0 };
                },
                exec: async (sqlStr) => {
                    const req = new sql.Request(transaction);
                    return await req.batch(sqlStr);
                }
            };
            const result = await callback(trxWrapper);
            await transaction.commit();
            return result;
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    }

    async close() {
        if (this.pool) {
            await this.pool.close();
            console.log('[MSSQL Driver] Connection closed cleanly.');
            this.pool = null;
        }
    }
}

module.exports = MssqlDriver;
