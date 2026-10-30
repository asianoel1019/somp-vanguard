/**
 * MariaDB / MySQL Driver Implementation (using mysql2/promise)
 */
const mysql = require('mysql2/promise');
const { translateSql } = require('../translator');

class MysqlDriver {
    constructor(config = {}) {
        this.config = {
            host: config.host || process.env.DB_HOST || '127.0.0.1',
            port: parseInt(config.port || process.env.DB_PORT || '3306', 10),
            user: config.user || process.env.DB_USER || 'root',
            password: config.password || process.env.DB_PASSWORD || '',
            database: config.database || process.env.DB_NAME || 'somp_vanguard',
            waitForConnections: true,
            connectionLimit: parseInt(process.env.DB_POOL_MAX || '30', 10),
            queueLimit: 0,
            enableKeepAlive: true,
            keepAliveInitialDelay: 10000
        };
        this.pool = null;
        this.dbType = 'mariadb';
    }

    async init() {
        this.pool = mysql.createPool(this.config);
        // Test connection
        const conn = await this.pool.getConnection();
        try {
            const [rows] = await conn.query('SELECT VERSION() as version;');
            console.log(`[MariaDB/MySQL Driver] Connected successfully to ${this.config.host}:${this.config.port}/${this.config.database}`);
            console.log(`[MariaDB/MySQL Driver] Version: ${rows[0]?.version || 'Unknown'}`);
        } finally {
            conn.release();
        }
    }

    async get(sql, params = []) {
        try {
            const [rows] = await this.pool.query(translateSql(sql, 'mariadb'), params);
            return rows && rows.length > 0 ? rows[0] : null;
        } catch (err) {
            console.error(`[MariaDB Error] get() failed: "${sql}":`, err.message);
            return null;
        }
    }

    async all(sql, params = []) {
        try {
            const [rows] = await this.pool.query(translateSql(sql, 'mariadb'), params);
            return rows || [];
        } catch (err) {
            console.error(`[MariaDB Error] all() failed: "${sql}":`, err.message);
            return [];
        }
    }

    async run(sql, params = []) {
        try {
            const [result] = await this.pool.query(translateSql(sql, 'mariadb'), params);
            return {
                changes: result?.affectedRows || 0,
                lastInsertRowid: result?.insertId
            };
        } catch (err) {
            console.error(`[MariaDB Error] run() failed: "${sql}":`, err.message);
            throw err;
        }
    }

    async exec(sql) {
        try {
            return await this.pool.query(sql);
        } catch (err) {
            console.error(`[MariaDB Error] exec() failed:`, err.message);
            throw err;
        }
    }

    async transaction(callback) {
        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();
            const trxWrapper = {
                get: async (sql, params = []) => {
                    const [rows] = await conn.query(translateSql(sql, 'mariadb'), params);
                    return rows[0] || null;
                },
                all: async (sql, params = []) => {
                    const [rows] = await conn.query(translateSql(sql, 'mariadb'), params);
                    return rows || [];
                },
                run: async (sql, params = []) => {
                    const [res] = await conn.query(translateSql(sql, 'mariadb'), params);
                    return { changes: res.affectedRows || 0 };
                },
                exec: async (sql) => conn.query(sql)
            };
            const result = await callback(trxWrapper);
            await conn.commit();
            return result;
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }
    }

    async close() {
        if (this.pool) {
            await this.pool.end();
            console.log('[MariaDB/MySQL Driver] Pool closed cleanly.');
            this.pool = null;
        }
    }
}

module.exports = MysqlDriver;
