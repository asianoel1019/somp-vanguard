const express = require('express');
const router = express.Router();
const http = require('http');
const https = require('https');
const { requireAuth, checkRole, checkFeature, checkAnyFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { encryptText, decryptText } = require('../lib/crypto');

// Apply authentication to all SFTP management endpoints
router.use(requireAuth);
// SFTP Manager screen -> 'sftpManager'. POST /test-connection is also used by System Settings ->
// File Services -> SFTP Servers, so it is checked on the route itself (sftpManager or settings).
const sftpGate = checkFeature('sftpManager');
const isTestConnection = (req) => req.method === 'POST' && /^\/test-connection\/?$/i.test(req.path);
router.use((req, res, next) => (isTestConnection(req) ? next() : sftpGate(req, res, next)));

/**
 * Helper to get configured SFTP servers list from process.env
 */
function getSftpServers() {
    let servers = [];
    if (process.env.SFTP_SERVERS) {
        try {
            servers = typeof process.env.SFTP_SERVERS === 'string' 
                ? JSON.parse(process.env.SFTP_SERVERS) 
                : process.env.SFTP_SERVERS;
            if (!Array.isArray(servers)) servers = [];
        } catch (e) {
            console.warn('[SFTP-Route] Failed to parse SFTP_SERVERS JSON:', e.message);
        }
    }

    // Fallback: If no SFTP_SERVERS array but legacy SFTP_HOST exists and SFTP_ENABLED is true
    if (servers.length === 0 && process.env.SFTP_HOST && (process.env.SFTP_ENABLED === 'true' || process.env.SFTP_ENABLED === true)) {
        servers.push({
            id: 'default',
            name: 'Local SFTP Server',
            host: process.env.SFTP_HOST || '127.0.0.1',
            apiPort: parseInt(process.env.SFTP_API_PORT || '8443', 10),
            sftpPort: parseInt(process.env.SFTP_PORT || '2222', 10),
            apiKey: process.env.SFTP_API_KEY || '',
            protocol: process.env.SFTP_USE_HTTPS === 'true' ? 'https' : 'http',
            enabled: true
        });
    }

    return servers.map((s, idx) => {
        let key = s.apiKey || '';
        if (key.startsWith('enc:')) {
            try {
                key = decryptText(key.substring(4));
            } catch (e) {
                console.warn(`[SFTP-Route] Failed to decrypt apiKey for server ${s.name || s.id}:`, e.message);
            }
        }
        return {
            id: s.id || `sftp-${idx + 1}`,
            name: s.name || `SFTP Server ${idx + 1}`,
            host: s.host || '127.0.0.1',
            apiPort: parseInt(s.apiPort || '8443', 10),
            sftpPort: parseInt(s.sftpPort || '2222', 10),
            apiKey: key,
            protocol: s.protocol || 'http',
            enabled: s.enabled !== false
        };
    });
}

function resolveServer(serverId) {
    const servers = getSftpServers();
    if (!servers || servers.length === 0) return null;
    if (!serverId) {
        return servers.find(s => s.enabled) || servers[0];
    }
    return servers.find(s => s.id === serverId) || servers[0];
}

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 50 });

/**
 * Proxy request helper to specific SFTP Server's FastAPI REST backend
 */
function proxySftpRequest(endpoint, method = 'GET', data = null, customConfig = null) {
    return new Promise((resolve, reject) => {
        const config = customConfig;
        if (!config || !config.host) {
            return reject(new Error('No SFTP Server target configuration available.'));
        }

        const isHttps = config.protocol === 'https';
        const url = `${config.protocol || 'http'}://${config.host}:${config.apiPort || 8443}${endpoint}`;
        const payload = data ? JSON.stringify(data) : null;
        const options = {
            method: method.toUpperCase(),
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': config.apiKey || ''
            },
            timeout: 15000,
            agent: isHttps ? httpsAgent : httpAgent
        };

        if (payload) {
            options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const client = isHttps ? https : http;
        const req = client.request(url, options, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(body);
                } catch (e) {
                    parsed = body;
                }

                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ status: res.statusCode, data: parsed });
                } else {
                    const errMsg = (parsed && parsed.detail) || (parsed && parsed.error) || `HTTP ${res.statusCode}: ${body}`;
                    reject(new Error(errMsg));
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`SFTP Server (${config.host}:${config.apiPort}) request timeout (7s)`));
        });

        req.on('error', (err) => {
            reject(err);
        });

        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

// GET /api/sftp/servers - List all configured SFTP servers
router.get('/servers', async (req, res) => {
    try {
        const servers = getSftpServers();
        const sanitized = servers.map(s => ({
            id: s.id,
            name: s.name,
            host: s.host,
            apiPort: s.apiPort,
            sftpPort: s.sftpPort,
            protocol: s.protocol,
            enabled: s.enabled,
            hasApiKey: !!s.apiKey
        }));
        res.json({ servers: sanitized });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/sftp/status - Get SFTP service runtime status for a specific server
router.get('/status', async (req, res) => {
    try {
        const serverId = req.query.serverId;
        const targetServer = resolveServer(serverId);
        
        if (!targetServer) {
            return res.json({
                configured: false,
                enabled: false,
                status: 'not_configured',
                message: 'No SFTP Servers configured in Settings.'
            });
        }

        if (!targetServer.enabled) {
            return res.json({
                configured: true,
                enabled: false,
                server: { id: targetServer.id, name: targetServer.name },
                status: 'disabled',
                message: `SFTP Server "${targetServer.name}" is currently disabled.`
            });
        }

        const response = await proxySftpRequest('/api/status', 'GET', null, targetServer);
        res.json({
            configured: true,
            enabled: true,
            server: { id: targetServer.id, name: targetServer.name },
            ...response.data
        });
    } catch (err) {
        const targetServer = resolveServer(req.query.serverId);
        res.status(502).json({
            configured: !!targetServer,
            enabled: true,
            server: targetServer ? { id: targetServer.id, name: targetServer.name } : null,
            status: 'offline',
            error: err.message,
            message: `Unable to connect to SFTP Server (${targetServer?.host}:${targetServer?.apiPort})`
        });
    }
});

// POST /api/sftp/test-connection - Test connection with specific credentials
router.post('/test-connection', checkAnyFeature('sftpManager', 'settings'), checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const { host, apiPort, apiKey, protocol } = req.body;
        const testConfig = {
            host: host || '127.0.0.1',
            apiPort: parseInt(apiPort || '8443', 10),
            apiKey: apiKey || '',
            protocol: protocol || 'http'
        };

        const response = await proxySftpRequest('/api/status', 'GET', null, testConfig);
        res.json({
            success: true,
            message: 'Successfully connected to Python SFTP Server!',
            serverInfo: response.data
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            message: `Connection failed: ${err.message}`
        });
    }
});

// GET /api/sftp/users - List users from target server
router.get('/users', async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/users', 'GET', null, targetServer);
        res.json(response.data);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// POST /api/sftp/users - Create or update user on target server
router.post('/users', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/users', 'POST', req.body, targetServer);
        auditLog(req.user.username, 'SFTP Manager', `Saved SFTP user on ${targetServer.name}: ${req.body.username} (Auth: ${req.body.auth_type}, Path: ${req.body.home_dir})`);
        res.json(response.data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// DELETE /api/sftp/users/:username - Delete user on target server
router.delete('/users/:username', checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const username = encodeURIComponent(req.params.username);
        const response = await proxySftpRequest(`/api/users/${username}`, 'DELETE', null, targetServer);
        auditLog(req.user.username, 'SFTP Manager', `Deleted SFTP user on ${targetServer.name}: ${req.params.username}`);
        res.json(response.data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/sftp/users/bulk-delete - Bulk delete users on target server
router.post('/users/bulk-delete', checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const { usernames } = req.body;
        if (!Array.isArray(usernames) || usernames.length === 0) {
            return res.status(400).json({ error: 'No usernames provided for bulk deletion' });
        }
        let deleted = 0;
        let errors = [];
        for (const u of usernames) {
            try {
                await proxySftpRequest(`/api/users/${encodeURIComponent(u)}`, 'DELETE', null, targetServer);
                deleted++;
            } catch (err) {
                errors.push({ username: u, error: err.message });
            }
        }
        auditLog(req.user.username, 'SFTP Manager', `Bulk deleted ${deleted} SFTP user(s) on ${targetServer.name}: ${usernames.join(', ')}`);
        res.json({ success: true, deleted, total: usernames.length, errors });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sftp/users/bulk-update - Bulk update users on target server
router.post('/users/bulk-update', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const { usernames, updates } = req.body;
        if (!Array.isArray(usernames) || usernames.length === 0) {
            return res.status(400).json({ error: 'No usernames provided for bulk update' });
        }
        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'No updates provided' });
        }

        // Fetch current users to preserve existing credentials and paths
        const listRes = await proxySftpRequest('/api/users', 'GET', null, targetServer);
        const currentUsers = listRes.data.users || [];
        const userMap = new Map(currentUsers.map(u => [u.username, u]));

        let updated = 0;
        let errors = [];
        for (const u of usernames) {
            const existing = userMap.get(u);
            if (!existing) {
                errors.push({ username: u, error: 'User not found on target server' });
                continue;
            }

            const merged = { ...existing };
            if (updates.group !== undefined && updates.group !== '') merged.group = updates.group;
            if (updates.read_only !== undefined) merged.read_only = updates.read_only;
            if (updates.enabled !== undefined) merged.enabled = updates.enabled;
            if (updates.rate_limit_kbps !== undefined) merged.rate_limit_kbps = updates.rate_limit_kbps;
            if (updates.max_connections !== undefined) merged.max_connections = updates.max_connections;
            if (updates.idle_timeout_seconds !== undefined) merged.idle_timeout_seconds = updates.idle_timeout_seconds;

            try {
                await proxySftpRequest('/api/users', 'POST', merged, targetServer);
                updated++;
            } catch (err) {
                errors.push({ username: u, error: err.message });
            }
        }
        auditLog(req.user.username, 'SFTP Manager', `Bulk updated ${updated} SFTP user(s) on ${targetServer.name}: ${usernames.join(', ')}`);
        res.json({ success: true, updated, total: usernames.length, errors });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/sftp/sessions - List live connections on target server
router.get('/sessions', async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/sessions', 'GET', null, targetServer);
        res.json(response.data);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// POST /api/sftp/sessions/:sessionId/kick - Force terminate session on target server
router.post('/sessions/:sessionId/kick', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const sessionId = encodeURIComponent(req.params.sessionId);
        const response = await proxySftpRequest(`/api/sessions/${sessionId}/kick`, 'POST', null, targetServer);
        auditLog(req.user.username, 'SFTP Manager', `Kicked SFTP session on ${targetServer.name} ID: ${req.params.sessionId}`);
        res.json(response.data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/sftp/logs - Get audit logs from target server
router.get('/logs', async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 100, 2000));
        const response = await proxySftpRequest(`/api/logs?limit=${limit}`, 'GET', null, targetServer);
        res.json(response.data);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// POST /api/sftp/test-ad - Test Active Directory credentials on target server
router.post('/test-ad', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/test-ad', 'POST', req.body, targetServer);
        res.json(response.data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/sftp/service/restart - Restart SFTP listener on target server
router.post('/service/restart', checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/service/restart', 'POST', null, targetServer);
        auditLog(req.user.username, 'SFTP Manager', `Requested SFTP service listener restart on ${targetServer.name}`);
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sftp/service/start - Start SFTP listener on target server
router.post('/service/start', checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/service/start', 'POST', null, targetServer);
        auditLog(req.user.username, 'SFTP Manager', `Started SFTP service listener on ${targetServer.name}`);
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/sftp/service/stop - Stop SFTP listener on target server
router.post('/service/stop', checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/service/stop', 'POST', null, targetServer);
        auditLog(req.user.username, 'SFTP Manager', `Stopped SFTP service listener on ${targetServer.name}`);
        res.json(response.data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/sftp/groups - List user groups on target server
router.get('/groups', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/groups', 'GET', null, targetServer);
        res.json(response.data);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// POST /api/sftp/groups - Create or update group on target server
router.post('/groups', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/groups', 'POST', req.body, targetServer);
        auditLog(req.user.username, 'SFTP Manager', `Saved group '${req.body.name}' on ${targetServer.name}`);
        res.json(response.data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// DELETE /api/sftp/groups/:group_name - Delete group on target server
router.delete('/groups/:group_name', checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const groupName = encodeURIComponent(req.params.group_name);
        const response = await proxySftpRequest(`/api/groups/${groupName}`, 'DELETE', null, targetServer);
        auditLog(req.user.username, 'SFTP Manager', `Deleted group '${req.params.group_name}' on ${targetServer.name}`);
        res.json(response.data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// GET /api/sftp/browse - Browse directory on target server
router.get('/browse', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const queryPath = req.query.path ? `?path=${encodeURIComponent(req.query.path)}` : '';
        const response = await proxySftpRequest(`/api/browse${queryPath}`, 'GET', null, targetServer);
        res.json(response.data);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// GET /api/sftp/config - Get server config from target server
router.get('/config', checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/config', 'GET', null, targetServer);
        res.json(response.data);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

// POST /api/sftp/config - Update server config on target server
router.post('/config', checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/config', 'POST', req.body, targetServer);
        auditLog(req.user.username, 'SFTP Manager', `Updated SFTP configuration on ${targetServer.name}`);
        res.json(response.data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// POST /api/sftp/logs/purge - Purge expired logs on target server
router.post('/logs/purge', checkRole(['SuperAdmin']), async (req, res) => {
    try {
        const targetServer = resolveServer(req.query.serverId);
        if (!targetServer) return res.status(400).json({ error: 'No SFTP server configured' });
        const response = await proxySftpRequest('/api/logs/purge', 'POST', req.body, targetServer);
        auditLog(req.user.username, 'SFTP Manager', `Purged expired logs on ${targetServer.name}`);
        res.json(response.data);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
