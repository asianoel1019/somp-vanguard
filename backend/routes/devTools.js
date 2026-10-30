const express = require('express');
const router = express.Router();
const axios = require('axios');
const { requireAuth, checkRole } = require('../middleware/auth');
const { readEnv } = require('../lib/envEditor');
const { auditLog } = require('../lib/logger');

// Strictly SuperAdmin only
router.use(requireAuth);
router.use(checkRole(['SuperAdmin']));

/**
 * POST /api/devtools/execute
 * Execute arbitrary API commands against local backend or internal endpoints
 */
router.post('/execute', async (req, res) => {
    const startTime = Date.now();
    try {
        const configEnv = readEnv();
        if (configEnv.ENABLE_DEV_TOOLS === 'false') {
            return res.status(403).json({
                error: 'Dev Tools is disabled in system settings. Please enable it in Settings > Core System.',
                code: 'DEV_TOOLS_DISABLED'
            });
        }

        let { method = 'GET', path = '', headers = {}, params = {}, body = null } = req.body;
        method = String(method).toUpperCase();
        path = String(path).trim();

        if (!path) {
            return res.status(400).json({ error: 'Endpoint path is required (e.g. /api/v1/open/servers or /api/workflow)' });
        }

        const port = process.env.PORT || 5000;
        let targetUrl = path.startsWith('http://') || path.startsWith('https://') 
            ? path 
            : `http://127.0.0.1:${port}${path.startsWith('/') ? path : '/' + path}`;

        // Forward caller's auth token if not explicitly provided
        const requestHeaders = { ...headers };
        if (!requestHeaders['Authorization'] && !requestHeaders['authorization'] && req.headers['authorization']) {
            requestHeaders['Authorization'] = req.headers['authorization'];
        }
        if (!requestHeaders['Content-Type'] && !requestHeaders['content-type'] && body && typeof body === 'object') {
            requestHeaders['Content-Type'] = 'application/json';
        }

        const axiosConfig = {
            method,
            url: targetUrl,
            params,
            data: body,
            headers: requestHeaders,
            timeout: 30000,
            validateStatus: () => true // Allow receiving non-2xx status codes without throwing
        };

        const targetResponse = await axios(axiosConfig);
        const durationMs = Date.now() - startTime;
        
        let sizeBytes = 0;
        try {
            const rawBody = typeof targetResponse.data === 'string' 
                ? targetResponse.data 
                : JSON.stringify(targetResponse.data);
            sizeBytes = Buffer.byteLength(rawBody || '', 'utf8');
        } catch (e) {}

        auditLog(
            req.user.username,
            'Dev Tools',
            `Executed ${method} ${path} [${targetResponse.status}] (${durationMs}ms)`
        );

        return res.json({
            success: true,
            status: targetResponse.status,
            statusText: targetResponse.statusText,
            headers: targetResponse.headers,
            data: targetResponse.data,
            durationMs,
            sizeBytes
        });
    } catch (err) {
        const durationMs = Date.now() - startTime;
        console.error('[DevTools Execution Error]', err);
        return res.status(500).json({
            success: false,
            error: err.message,
            code: err.code || 'EXECUTION_ERROR',
            durationMs
        });
    }
});

module.exports = router;
