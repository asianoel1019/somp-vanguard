const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');
const { encryptText, decryptText } = require('../lib/crypto');
const { auditLog } = require('../lib/logger');
const { requireAuth, checkFeature } = require('../middleware/auth');

router.use(requireAuth);
router.use(checkFeature('redisControl')); // only RedisControlPlane calls these endpoints

const { readDataSync, writeDataSync } = require('../lib/db');

const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const REDIS_BACKUP_DIR = path.join(BASE_DATA_DIR, 'config_backup', 'redis_backups');

if (!fs.existsSync(REDIS_BACKUP_DIR)) {
    fs.mkdirSync(REDIS_BACKUP_DIR, { recursive: true });
}

// Helper to read connections
function readConnections() {
    return readDataSync('service_platform/redis_connections.json', []);
}

// Helper to write connections
function writeConnections(conns) {
    writeDataSync('service_platform/redis_connections.json', conns);
}

// 1. Manage Connections (CRUD)
router.get('/connections', (req, res) => {
    const conns = readConnections().map(c => ({
        ...c,
        password: c.password ? '******' : '' // Mask for UI
    }));
    res.json(conns);
});

router.get('/export', (req, res) => {
    res.json(readConnections()); // Send raw encrypted passwords for export
});

router.post('/connections', (req, res) => {
    const { host, ip, port, bu, password, tls } = req.body;
    const conns = readConnections();
    
    const isAlreadyEncrypted = password && (password.startsWith('=enc:') || (password.includes(':') && password.indexOf(':') === 32));
    
    const newConn = {
        id: Date.now().toString(),
        host: host || '',
        ip: ip || '',
        port: parseInt(port) || 6379,
        bu: bu || '',
        password: isAlreadyEncrypted ? password : (password ? '=enc:' + encryptText(password) : ''),
        tls: tls === true || tls === 'true'
    };
    
    conns.push(newConn);
    writeConnections(conns);
    auditLog(req.user.username, 'Redis Control', `Added new Redis connection: ${host || ip}:${port}`);
    res.json({ ok: true, id: newConn.id });
});

router.delete('/connections/:id', (req, res) => {
    const { id } = req.params;
    let conns = readConnections();
    conns = conns.filter(c => c.id !== id);
    writeConnections(conns);
    auditLog(req.user.username, 'Redis Control', `Deleted Redis connection ID: ${id}`);
    res.json({ ok: true });
});

router.put('/connections/:id', (req, res) => {
    const { id } = req.params;
    const { host, ip, port, bu, password, tls } = req.body;
    let conns = readConnections();
    const idx = conns.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });

    conns[idx] = {
        ...conns[idx],
        host,
        ip,
        port: parseInt(port) || 6379,
        bu: bu || '',
        tls: tls === true || tls === 'true'
    };

    if (password && password !== '******') {
        const isAlreadyEncrypted = password.startsWith('=enc:') || (password.includes(':') && password.indexOf(':') === 32);
        conns[idx].password = isAlreadyEncrypted ? password : '=enc:' + encryptText(password);
    }

    writeConnections(conns);
    auditLog(req.user.username, 'Redis Control', `Updated Redis connection: ${host || ip}:${port}`);
    res.json({ ok: true });
});

// 2. Redis Operations
async function getRedisClient(connId) {
    const conns = readConnections();
    const conn = conns.find(c => c.id === connId);
    if (!conn) throw new Error('Connection not found');

    const options = {
        host: conn.ip || conn.host,
        port: conn.port,
        password: conn.password ? decryptText(conn.password.startsWith('=enc:') ? conn.password.slice(5) : conn.password) : undefined,
        retryStrategy: () => null, // Don't retry indefinitely
        connectTimeout: 5000
    };

    if (conn.tls) {
        options.tls = {}; // Basic TLS support
    }

    return new Redis(options);
}

// CONFIG GET *
router.post('/config/get', async (req, res) => {
    const { connId } = req.body;
    let redis;
    try {
        redis = await getRedisClient(connId);
        const config = await redis.config('GET', '*');
        
        // ioredis returns [key1, value1, key2, value2, ...]
        const configMap = [];
        for (let i = 0; i < config.length; i += 2) {
            configMap.push({
                parameter: config[i],
                value: config[i + 1],
                editable: true // Most are editable, but some might not be. For simplicity, we mark all.
            });
        }
        res.json(configMap);
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (redis) redis.quit();
    }
});

// CONFIG SET
router.post('/config/set', async (req, res) => {
    const { connId, parameter, value } = req.body;
    let redis;
    try {
        redis = await getRedisClient(connId);
        
        // Security check: only allow CONFIG SET
        await redis.config('SET', parameter, value);
        
        auditLog(req.user.username, 'Redis Control', `CONFIG SET ${parameter} = ${value} on connection ${connId}`);
        
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (redis) redis.quit();
    }
});

// CONFIG REWRITE
router.post('/config/rewrite', async (req, res) => {
    const { connId } = req.body;
    let redis;
    try {
        redis = await getRedisClient(connId);

        // 1. Backup current config
        const config = await redis.config('GET', '*');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(REDIS_BACKUP_DIR, `config_backup_${connId}_${timestamp}.json`);
        fs.writeFileSync(backupFile, JSON.stringify(config, null, 2), 'utf8');

        // 2. Execute REWRITE
        await redis.config('REWRITE');

        // 3. Audit Log & Telegram
        auditLog(req.user.username, 'Redis Control', `CONFIG REWRITE executed on connection ${connId}. Backup saved to ${path.basename(backupFile)}`);
        
        res.json({ ok: true, backup: path.basename(backupFile) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    } finally {
        if (redis) redis.quit();
    }
});

module.exports = router;
