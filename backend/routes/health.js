const express = require('express');
const router = express.Router();
const os = require('os');

// In-memory rate limiter: max 5 requests per 30 seconds per IP
const healthCheckLimits = new Map();
const WINDOW_MS = 30 * 1000;
const MAX_REQUESTS = 5;

const rateLimiter = (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    
    if (!healthCheckLimits.has(ip)) {
        healthCheckLimits.set(ip, { count: 1, firstRequest: now });
        return next();
    }
    
    const record = healthCheckLimits.get(ip);
    if (now - record.firstRequest > WINDOW_MS) {
        // Reset window
        healthCheckLimits.set(ip, { count: 1, firstRequest: now });
        return next();
    }
    
    record.count++;
    if (record.count > MAX_REQUESTS) {
        return res.status(429).json({
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Maximum ${MAX_REQUESTS} requests per ${WINDOW_MS / 1000} seconds.`
        });
    }
    
    healthCheckLimits.set(ip, record);
    next();
};

// Cleanup stale entries every minute to prevent memory leak
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of healthCheckLimits.entries()) {
        if (now - record.firstRequest > WINDOW_MS) {
            healthCheckLimits.delete(ip);
        }
    }
}, 60000);

// GET /api/health
router.get('/', rateLimiter, async (req, res) => {
    const memory = process.memoryUsage();
    
    const version = require('../lib/version').getVersion();

    let databaseStatus = 'UNKNOWN';
    let databaseSize = 0;
    const dbManager = require('../services/db');
    const dbEngine = dbManager.resolveDriverType();

    try {
        const driver = dbManager.getDriver();
        if (driver) {
            const testRow = await driver.get('SELECT 1 as ok');
            if (testRow) databaseStatus = 'CONNECTED';

            if (dbEngine === 'sqlite') {
                const fs = require('fs');
                const path = require('path');
                let dbDir = process.env.DB_DATA_DIR || 'D:\\somp-vanguard';
                if (!fs.existsSync(dbDir) && fs.existsSync('C:\\ProgramData\\somp-vanguard')) {
                    dbDir = 'C:\\ProgramData\\somp-vanguard';
                }
                const dbFile = path.join(dbDir, 'database.sqlite');
                if (fs.existsSync(dbFile)) {
                    databaseSize = fs.statSync(dbFile).size;
                }
            }
        }
    } catch (e) {
        databaseStatus = `ERROR: ${e.message}`;
    }

    const schedulers = {};
    try {
        const { readDataSync } = require('../lib/db');
        const tasks = readDataSync('server_operation/scheduler_tasks.json', []);
        tasks.forEach(t => {
            if (t.name) {
                schedulers[t.name] = {
                    lastRun: t.lastRunTime || null,
                    status: t.lastRunStatus || 'UNKNOWN'
                };
            }
        });
    } catch (e) {
        schedulers.error = e.message;
    }

    res.json({
        status: 'UP',
        uptime: process.uptime(),
        version: version,
        memoryUsage: {
            rss: memory.rss,
            heapTotal: memory.heapTotal,
            heapUsed: memory.heapUsed,
            external: memory.external,
            arrayBuffers: memory.arrayBuffers
        },
        systemMemory: {
            free: os.freemem(),
            total: os.totalmem()
        },
        database: {
            status: databaseStatus,
            engine: dbEngine,
            engineName: dbEngine === 'postgres' ? 'PostgreSQL' : (dbEngine === 'mariadb' ? 'MariaDB' : (dbEngine === 'mssql' ? 'MSSQL' : 'SQLite')),
            sizeBytes: databaseSize
        },
        schedulers: schedulers,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;
