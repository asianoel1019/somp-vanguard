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
// Query values whose name looks like a credential are replaced before the path is written to the audit log
const SECRET_PARAM = /key|token|secret|pass|pwd|auth|sig/i;
function auditPath(url, params) {
    const shown = new URL(url.href);
    for (const [k, v] of Object.entries(params && typeof params === 'object' ? params : {})) shown.searchParams.set(k, String(v));
    for (const k of [...shown.searchParams.keys()]) if (SECRET_PARAM.test(k)) shown.searchParams.set(k, '***');
    return `${shown.pathname}${shown.search}`;
}

router.post('/execute', async (req, res) => {
    const startTime = Date.now();
    let auditTarget = null;
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
        const base = `http://127.0.0.1:${port}`;
        // Only this server's own API: an absolute or protocol-relative URL would turn the console into a proxy
        // to anywhere (internal admin pages, metadata services) that also carries the caller's login token
        let target;
        try {
            target = new URL(path.startsWith('/') ? path : '/' + path, base);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid endpoint path' });
        }
        if (target.origin !== base || !target.pathname.startsWith('/api/') || target.pathname.startsWith('/api/devtools')) {
            return res.status(400).json({ error: 'Dev Tools only calls this server\'s own API: use a path that starts with /api/ (absolute URLs are not allowed)' });
        }
        const targetUrl = target.href;
        auditTarget = `${method} ${auditPath(target, params)}`;

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
            maxRedirects: 0,
            maxContentLength: 10 * 1024 * 1024,
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

        auditLog(req.user.username, 'Dev Tools', `Executed ${auditTarget} [${targetResponse.status}] (${durationMs}ms)`);

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
        console.error('[DevTools Execution Error]', err.message);
        if (auditTarget) auditLog(req.user.username, 'Dev Tools', `Executed ${auditTarget} [failed: ${err.code || err.message}] (${durationMs}ms)`);
        return res.status(500).json({
            success: false,
            error: err.message,
            code: err.code || 'EXECUTION_ERROR',
            durationMs
        });
    }
});

module.exports = router;
