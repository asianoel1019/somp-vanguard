/**
 * PostgreSQL Driver Implementation (using pg.Pool)
 * Provides high-performance async non-blocking operations for SOMP Vanguard.
 */
const { Pool } = require('pg');
const { translateSql } = require('../translator');

class PgDriver {
    constructor(config = {}) {
        this.config = {
            host: config.host || process.env.DB_HOST || '127.0.0.1',
            port: parseInt(config.port || process.env.DB_PORT || '5432', 10),
            user: config.user || process.env.DB_USER || 'postgres',
            password: config.password || process.env.DB_PASSWORD || '',
            database: config.database || process.env.DB_NAME || 'somp_vanguard',
            max: parseInt(process.env.DB_POOL_MAX || '30', 10),
            min: parseInt(process.env.DB_POOL_MIN || '5', 10),
            idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || '30000', 10),
            connectionTimeoutMillis: 10000
        };
        this.pool = null;
        this.dbType = 'postgres';
    }

    async init() {
        this.pool = new Pool(this.config);

        this.pool.on('error', (err) => {
            console.error('[PostgreSQL Pool Error] Unexpected error on idle client:', err.message);
        });

        // Test connection
        const client = await this.pool.connect();
        try {
            const res = await client.query('SELECT version();');
            const pgVer = res.rows[0]?.version || 'PostgreSQL';
            console.log(`[PostgreSQL Driver] Connected successfully to ${this.config.host}:${this.config.port}/${this.config.database}`);
            console.log(`[PostgreSQL Driver] Version: ${pgVer.split(' on ')[0]}`);
        } finally {
            client.release();
        }
    }

    async get(sql, params = []) {
        const pgSql = translateSql(sql, 'postgres');
        try {
            const res = await this.pool.query(pgSql, params);
            return res.rows[0] || null;
        } catch (err) {
            console.error(`[PostgreSQL Error] get() failed: "${pgSql}":`, err.message);
            return null;
        }
    }

    async all(sql, params = []) {
        const pgSql = translateSql(sql, 'postgres');
        try {
            const res = await this.pool.query(pgSql, params);
            return res.rows || [];
        } catch (err) {
            console.error(`[PostgreSQL Error] all() failed: "${pgSql}":`, err.message);
            return [];
        }
    }

    async run(sql, params = []) {
        const pgSql = translateSql(sql, 'postgres');
        try {
            const res = await this.pool.query(pgSql, params);
            return {
                changes: res.rowCount || 0,
                lastInsertRowid: res.rows?.[0]?.id
            };
        } catch (err) {
            console.error(`[PostgreSQL Error] run() failed: "${pgSql}":`, err.message);
            throw err;
        }
    }

    async exec(sql) {
        try {
            return await this.pool.query(sql);
        } catch (err) {
            console.error(`[PostgreSQL Error] exec() failed:`, err.message);
            throw err;
        }
    }

    async transaction(callback) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const trxWrapper = {
                get: async (sql, params = []) => {
                    const res = await client.query(translateSql(sql, 'postgres'), params);
                    return res.rows[0] || null;
                },
                all: async (sql, params = []) => {
                    const res = await client.query(translateSql(sql, 'postgres'), params);
                    return res.rows || [];
                },
                run: async (sql, params = []) => {
                    const res = await client.query(translateSql(sql, 'postgres'), params);
                    return { changes: res.rowCount || 0 };
                },
                exec: async (sql) => client.query(sql)
            };
            const result = await callback(trxWrapper);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async close() {
        if (this.pool) {
            await this.pool.end();
            console.log('[PostgreSQL Driver] Pool closed cleanly.');
            this.pool = null;
        }
    }
}

module.exports = PgDriver;
