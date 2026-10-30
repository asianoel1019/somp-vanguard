const scoutDb = require('../services/scoutDb');
const { readEnv } = require('../lib/envEditor');
const { auditLog } = require('../lib/logger');

// In-memory rate limiter for Open API
const openApiRateLimitMap = new Map();
const DEFAULT_RATE_LIMIT = 120; // 120 req / min default

/**
 * Middleware to authenticate Open API requests via API Key.
 * Checks for API key in 'Authorization: Bearer <KEY>' or 'X-API-Key: <KEY>'.
 * Also validates that the Open API feature is enabled in system settings and logs audit access.
 */
function openApiAuth(options = {}) {
    return (req, res, next) => {
        const startTime = Date.now();
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
        const cleanIp = clientIp.startsWith('::ffff:') ? clientIp.substring(7) : clientIp;
        
        try {
            const configEnv = readEnv();
            const isApiEnabled = configEnv.ENABLE_SCOUT_OPEN_API !== 'false';
            const isLoggingEnabled = configEnv.ENABLE_OPEN_API_LOGGING !== 'false';
            const rateLimitMax = parseInt(configEnv.OPEN_API_RATE_LIMIT, 10) || DEFAULT_RATE_LIMIT;
            
            // 1. Check if Scout Open API feature is enabled
            if (!isApiEnabled) {
                if (isLoggingEnabled) {
                    try {
                        auditLog('OpenAPI (Blocked)', 'Scout Open API', `Rejected request: Open API is disabled (IP: ${cleanIp}, Method: ${req.method}, Path: ${req.originalUrl})`);
                    } catch (e) {}
                }
                return res.status(403).json({
                    error: 'Access Denied',
                    code: 'OPEN_API_DISABLED',
                    message: 'Scout Open API is currently disabled in system settings. Please enable it in Settings > Scout Open API.'
                });
            }

            // 2. Extract API Key
            const authHeader = req.headers['authorization'];
            let apiKey = '';
            if (authHeader && authHeader.startsWith('Bearer ')) {
                apiKey = authHeader.substring(7).trim();
            } else if (req.headers['x-api-key']) {
                apiKey = String(req.headers['x-api-key']).trim();
            } else if (req.query.api_key || req.query.apiKey) {
                apiKey = String(req.query.api_key || req.query.apiKey).trim();
            }

            if (!apiKey) {
                if (isLoggingEnabled) {
                    try {
                        auditLog('OpenAPI (Unauthorized)', 'Scout Open API', `Rejected request: Missing API Key (IP: ${cleanIp}, Method: ${req.method}, Path: ${req.originalUrl})`);
                    } catch (e) {}
                }
                return res.status(401).json({
                    error: 'Unauthorized',
                    code: 'MISSING_API_KEY',
                    message: 'Missing API Key. Please provide an API key via Authorization header (Bearer <KEY>), X-API-Key header, or apiKey query parameter.'
                });
            }

            // 3. Rate Limiting Check per Key + IP
            const rateKey = `${cleanIp}:${apiKey}`;
            const nowTime = Date.now();
            if (!openApiRateLimitMap.has(rateKey)) {
                openApiRateLimitMap.set(rateKey, { count: 1, resetAt: nowTime + 60000 });
            } else {
                const state = openApiRateLimitMap.get(rateKey);
                if (nowTime > state.resetAt) {
                    state.count = 1;
                    state.resetAt = nowTime + 60000;
                } else {
                    state.count++;
                    if (state.count > rateLimitMax) {
                        if (isLoggingEnabled) {
                            try {
                                auditLog('OpenAPI (RateLimited)', 'Scout Open API', `Rate limit exceeded (${state.count}/${rateLimitMax} req/min) for key from IP: ${cleanIp} (Path: ${req.originalUrl})`);
                            } catch (e) {}
                        }
                        return res.status(429).json({
                            error: 'Too Many Requests',
                            code: 'RATE_LIMIT_EXCEEDED',
                            message: `Rate limit of ${rateLimitMax} requests per minute exceeded. Please slow down.`
                        });
                    }
                }
            }

            // Rate limiter periodic cleanup
            if (!global.__openApiRateLimitCleanupStarted) {
                global.__openApiRateLimitCleanupStarted = true;
                setInterval(() => {
                    const ct = Date.now();
                    for (const [k, v] of openApiRateLimitMap.entries()) {
                        if (ct > v.resetAt) openApiRateLimitMap.delete(k);
                    }
                }, 60000);
            }

            // 4. Validate against Scout DB api_keys table
            const keyRecord = scoutDb.get("SELECT id, name, desc, key, createdAt, envId, isOpenApi FROM api_keys WHERE key = ?", [apiKey]);
            if (!keyRecord) {
                if (isLoggingEnabled) {
                    try {
                        auditLog('OpenAPI (Unauthorized)', 'Scout Open API', `Rejected request: Invalid or revoked API Key (IP: ${cleanIp}, KeyPrefix: ${apiKey.substring(0, 6)}..., Path: ${req.originalUrl})`);
                    } catch (e) {}
                }
                return res.status(401).json({
                    error: 'Unauthorized',
                    code: 'INVALID_API_KEY',
                    message: 'Invalid or revoked API Key.'
                });
            }

            if (!keyRecord.isOpenApi || keyRecord.isOpenApi !== 1) {
                if (isLoggingEnabled) {
                    try {
                        auditLog('OpenAPI (Forbidden)', 'Scout Open API', `Rejected request: Key '${keyRecord.name}' is an Agent Registration Key, not an Open API Key (IP: ${cleanIp}, Path: ${req.originalUrl})`);
                    } catch (e) {}
                }
                return res.status(403).json({
                    error: 'Forbidden',
                    code: 'KEY_NOT_OPEN_API',
                    message: 'This API Key is dedicated to Scout Agent registration only and is not authorized for Open API queries. Please enable the "Open API Key" option in Agent Manager > API Keys.'
                });
            }

            req.apiKeyInfo = keyRecord;

            // 5. Response Finish Hook: Record Access & Audit Logging
            res.on('finish', () => {
                const latency = Date.now() - startTime;
                const statusCode = res.statusCode;
                
                console.log(`[OpenAPI] ${keyRecord.name} (${cleanIp}) -> ${req.method} ${req.originalUrl} [${statusCode}] (${latency}ms)`);

                if (isLoggingEnabled) {
                    try {
                        const querySummary = Object.keys(req.query).length > 0 
                            ? ` | Query: ${JSON.stringify(req.query)}` 
                            : '';
                        const auditAction = `${req.method} ${req.baseUrl}${req.path} [${statusCode}] (${latency}ms)${querySummary} | IP: ${cleanIp}`;
                        auditLog(`OpenAPI (${keyRecord.name})`, 'Scout Open API', auditAction);
                    } catch (logErr) {
                        console.error('[OpenAPI Logging Error]', logErr);
                    }
                }
            });

            next();
        } catch (err) {
            console.error('[OpenAPI Auth Error]', err);
            return res.status(500).json({ error: 'Internal Server Error during authentication' });
        }
    };
}

module.exports = { openApiAuth };
