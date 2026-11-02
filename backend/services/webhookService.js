const http = require('http');
const https = require('https');
const tls = require('tls');

const { readDataSync } = require('../lib/db');
const { mutateDocument, replaceDocument } = require('../lib/docStore');

const WEBHOOKS_KEY = 'service_platform/webhooks.json';

function loadWebhooks() {
    return readDataSync(WEBHOOKS_KEY, []);
}

/** Atomic read-modify-write of the webhook list (fn synchronous, mutates in place, returns the result). */
function mutateWebhooks(fn) {
    return mutateDocument(WEBHOOKS_KEY, fn, { defaultValue: [], fnName: 'webhookService.mutateWebhooks', label: 'webhooks' });
}

/** Whole-list replacement under the same lock (prefer mutateWebhooks). */
function saveWebhooks(webhooks) {
    replaceDocument(WEBHOOKS_KEY, webhooks, { defaultValue: [] });
    return true;
}

// Webhook results go to the console only: the shared console format adds the time and process, and copies the
// line to logs\app_YYYY-MM-DD.log (lib/consoleFormat.js)
function logWebhookResult(webhookName, status, details) {
    const logLine = `[WebhookHub] [${status}] Webhook: "${webhookName}" - ${details}`;
    if (status === 'SUCCESS') {
        console.log(logLine);
    } else {
        console.error(logLine);
    }
}

// Helper to replace template parameters safely with encoding
function renderTemplate(template, params, contentType = 'application/json') {
    let result = template || '';
    const isUrlEncoded = String(contentType).toLowerCase().includes('x-www-form-urlencoded');

    Object.keys(params).forEach(key => {
        const rawVal = params[key] !== undefined && params[key] !== null ? String(params[key]) : '';
        const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');

        if (isUrlEncoded) {
            result = result.replace(regex, encodeURIComponent(rawVal));
        } else {
            // For JSON: escape quotes, newlines, and control characters safely
            const escapedForJsonString = JSON.stringify(rawVal).slice(1, -1);
            result = result.replace(regex, escapedForJsonString);
        }
    });
    return result;
}

function logWebhookFailure(webhook, requestOptions, postData, proxyUrl, errorDetails) {
    const timestamp = new Date().toISOString();
    const divider = '='.repeat(72);
    const debugObj = {
        timestamp,
        webhookName: webhook.name,
        webhookId: webhook.id || 'N/A',
        targetUrl: webhook.url,
        method: requestOptions.method || 'POST',
        proxyUsed: proxyUrl || 'None (Direct Connection)',
        headers: requestOptions.headers || {},
        payloadBody: postData || '(Empty)',
        failureReason: typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails)
    };

    const dumpStr = [
        divider,
        `💥 [WEBHOOK DISPATCH FAILURE DUMP] ${timestamp}`,
        `Webhook Name  : "${webhook.name}" (ID: ${webhook.id || 'N/A'})`,
        `Target URL    : ${webhook.url}`,
        `Method        : ${requestOptions.method || 'POST'}`,
        `Proxy Used    : ${proxyUrl || 'None (Direct Connection)'}`,
        `--- Request Headers ---`,
        JSON.stringify(requestOptions.headers, null, 2),
        `--- Request Body (Payload) ---`,
        postData ? postData : '(Empty Body)',
        `--- Failure Reason ---`,
        typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails, null, 2),
        divider
    ].join('\n');

    // The whole request dump goes to the console (and with it to logs\app_YYYY-MM-DD.log)
    console.error(`[WebhookHub] Dispatch failure dump\n${dumpStr}`);

    return debugObj;
}

// Executes a single webhook HTTP request
function executeWebhook(webhook, payloadParams) {
    return new Promise((resolve) => {
        const urlStr = (webhook.url || '').trim();
        if (!urlStr) {
            logWebhookResult(webhook.name, 'SKIP', 'Empty URL');
            const debug = logWebhookFailure(webhook, { method: 'POST', headers: {} }, '', '', 'Webhook URL is empty');
            return resolve({ success: false, error: 'Webhook URL is empty', debug });
        }

        let urlObj;
        try {
            urlObj = new URL(urlStr);
        } catch (err) {
            logWebhookResult(webhook.name, 'ERROR', `Invalid URL: ${err.message}`);
            const debug = logWebhookFailure(webhook, { method: 'POST', headers: {} }, '', '', `Invalid URL format: ${err.message}`);
            return resolve({ success: false, error: `Invalid URL format: ${err.message}`, debug });
        }

        const method = (webhook.method || 'POST').toUpperCase();
        
        // Headers parsing
        let parsedHeaders = {};
        if (typeof webhook.headers === 'object' && webhook.headers !== null) {
            parsedHeaders = { ...webhook.headers };
        } else if (typeof webhook.headers === 'string' && webhook.headers.trim()) {
            try {
                parsedHeaders = JSON.parse(webhook.headers);
            } catch (e) {
                logWebhookResult(webhook.name, 'WARN', 'Failed to parse custom headers JSON, falling back to empty.');
            }
        }

        // Default Content-Type to application/json if not set
        if (!Object.keys(parsedHeaders).some(h => h.toLowerCase() === 'content-type')) {
            parsedHeaders['Content-Type'] = 'application/json';
        }

        // Render payload template
        const contentType = parsedHeaders['Content-Type'] || parsedHeaders['content-type'] || 'application/json';
        const bodyTemplate = webhook.bodyTemplate || '{"text": "{{message}}"}';
        const bodyText = renderTemplate(bodyTemplate, payloadParams, contentType);

        const isHttps = urlObj.protocol === 'https:';
        const enabledModules = (process.env.PROXY_ENABLED_MODULES || '').split(',').map(s => s.trim());
        const proxyUrl = enabledModules.includes('Webhooks') ? (global.SYSTEM_PROXY || '').trim() : '';

        const requestOptions = {
            method: method,
            headers: {
                ...parsedHeaders,
                'Host': urlObj.host
            }
        };

        const postData = bodyText;
        if (method !== 'GET' && method !== 'DELETE') {
            requestOptions.headers['Content-Length'] = Buffer.byteLength(postData);
        }

        const handleResponse = (res) => {
            let respData = '';
            res.on('data', chunk => respData += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    logWebhookResult(webhook.name, 'SUCCESS', `HTTP ${res.statusCode}`);
                    resolve({ success: true, statusCode: res.statusCode, response: respData });
                } else {
                    const preview = respData.substring(0, 1000) || res.statusMessage || 'Unknown error';
                    const errorMsg = `HTTP ${res.statusCode} (${preview})`;
                    logWebhookResult(webhook.name, 'FAILED', errorMsg);
                    const debug = logWebhookFailure(webhook, requestOptions, postData, proxyUrl, errorMsg);
                    resolve({ success: false, statusCode: res.statusCode, error: errorMsg, debug });
                }
            });
        };

        if (proxyUrl) {
            const pObj = new URL(proxyUrl);
            if (isHttps) {
                // HTTPS request over HTTP Proxy using CONNECT tunneling
                const tunnelRequest = http.request({
                    host: pObj.hostname,
                    port: pObj.port || 80,
                    method: 'CONNECT',
                    path: `${urlObj.hostname}:${urlObj.port || 443}`,
                    headers: {
                        'Host': urlObj.hostname
                    }
                });

                tunnelRequest.on('connect', (tunnelRes, socket) => {
                    if (tunnelRes.statusCode !== 200) {
                        const errorMsg = `Proxy tunnel error (HTTP ${tunnelRes.statusCode})`;
                        logWebhookResult(webhook.name, 'PROXY_ERROR', errorMsg);
                        const debug = logWebhookFailure(webhook, requestOptions, postData, proxyUrl, errorMsg);
                        return resolve({ success: false, error: errorMsg, debug });
                    }

                    const tlsSocket = tls.connect({
                        socket: socket,
                        servername: urlObj.hostname
                    }, () => {
                        const clientRequest = https.request({
                            ...requestOptions,
                            createConnection: () => tlsSocket,
                            path: urlObj.pathname + urlObj.search
                        }, handleResponse);

                        clientRequest.on('error', (err) => {
                            const errorMsg = `Client request error: ${err.message}`;
                            logWebhookResult(webhook.name, 'ERROR', errorMsg);
                            const debug = logWebhookFailure(webhook, requestOptions, postData, proxyUrl, errorMsg);
                            resolve({ success: false, error: errorMsg, debug });
                        });

                        if (method !== 'GET' && method !== 'DELETE') {
                            clientRequest.write(postData);
                        }
                        clientRequest.end();
                    });

                    tlsSocket.on('error', (err) => {
                        const errorMsg = `TLS connection error: ${err.message}`;
                        logWebhookResult(webhook.name, 'TLS_ERROR', errorMsg);
                        const debug = logWebhookFailure(webhook, requestOptions, postData, proxyUrl, errorMsg);
                        resolve({ success: false, error: errorMsg, debug });
                    });
                });

                tunnelRequest.on('error', (err) => {
                    const errorMsg = `Proxy connect failed: ${err.message}`;
                    logWebhookResult(webhook.name, 'PROXY_CONNECT_ERROR', errorMsg);
                    const debug = logWebhookFailure(webhook, requestOptions, postData, proxyUrl, errorMsg);
                    resolve({ success: false, error: errorMsg, debug });
                });

                tunnelRequest.end();
            } else {
                // HTTP request over HTTP Proxy (direct request to proxy with full URL)
                const clientRequest = http.request({
                    host: pObj.hostname,
                    port: pObj.port || 80,
                    path: urlStr,
                    ...requestOptions
                }, handleResponse);

                clientRequest.on('error', (err) => {
                    const errorMsg = `Proxy request error: ${err.message}`;
                    logWebhookResult(webhook.name, 'PROXY_ERROR', errorMsg);
                    const debug = logWebhookFailure(webhook, requestOptions, postData, proxyUrl, errorMsg);
                    resolve({ success: false, error: errorMsg, debug });
                });

                if (method !== 'GET' && method !== 'DELETE') {
                    clientRequest.write(postData);
                }
                clientRequest.end();
            }
        } else {
            // Direct request (No Proxy)
            const protocolModule = isHttps ? https : http;
            const clientRequest = protocolModule.request({
                host: urlObj.hostname,
                port: urlObj.port || (isHttps ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                ...requestOptions
            }, handleResponse);

            clientRequest.on('error', (err) => {
                const errorMsg = `Connection failed: ${err.message}`;
                logWebhookResult(webhook.name, 'ERROR', errorMsg);
                const debug = logWebhookFailure(webhook, requestOptions, postData, proxyUrl, errorMsg);
                resolve({ success: false, error: errorMsg, debug });
            });

            if (method !== 'GET' && method !== 'DELETE') {
                clientRequest.write(postData);
            }
            clientRequest.end();
        }
    });
}

// Webhooks that should receive a notification of the given category
function selectWebhooksForCategory(webhooks, cat) {
    const { isOptInCategory } = require('../lib/logger');
    return webhooks.filter(w => {
        if (w.enabled === false) return false;
        // Each webhook has its own enabledLogs filter
        if (w.enabledLogs && Array.isArray(w.enabledLogs)) {
            return w.enabledLogs.includes(cat);
        }
        // No list saved: all enabled for backward compatibility, except opt-in categories
        return !isOptInCategory(cat);
    });
}

// Central function to trigger all enabled webhooks
async function triggerWebhooks(message, moduleName = 'System', category = null) {
    const { resolveLogCategory } = require('../lib/logger');
    const cat = category || resolveLogCategory(moduleName, message);

    const enabledWebhooks = selectWebhooksForCategory(loadWebhooks(), cat);
    if (enabledWebhooks.length === 0) return;

    const payloadParams = {
        message: message,
        module: moduleName,
        category: cat,
        timestamp: new Date().toISOString()
    };

    // Execute concurrently but without blocking
    Promise.all(enabledWebhooks.map(w => executeWebhook(w, payloadParams)))
        .catch(err => console.error('[WebhookService] Batch execution error:', err.message));
}

// Function to handle incoming webhooks from external systems
async function handleIncomingWebhook(id, payload, sourceIp) {
    const webhooks = loadWebhooks();
    const targetWebhook = webhooks.find(w => w.id === id);
    
    let webhookName = 'Unknown Webhook';
    if (targetWebhook) {
        webhookName = targetWebhook.name;
    } else {
        webhookName = `Custom_Webhook_${id}`;
    }
    
    logWebhookResult(webhookName, 'INCOMING', `Source IP: ${sourceIp} | Payload: ${JSON.stringify(payload)}`);
    
    const { auditLog, sendTelegramAlert } = require('../lib/logger');
    auditLog('API', 'Webhook Hub', `Received incoming webhook: ${webhookName} from ${sourceIp}`);
    
    // Log and trigger alert
    const message = `📥 [Incoming Webhook Received]\n\nTarget: ${webhookName}\nSource IP: ${sourceIp}\nPayload:\n${JSON.stringify(payload, null, 2).substring(0, 500)}`;
    await sendTelegramAlert(message, 'Integration Hub');
}

module.exports = {
    WEBHOOKS_KEY,
    loadWebhooks,
    saveWebhooks,
    mutateWebhooks,
    executeWebhook,
    triggerWebhooks,
    selectWebhooksForCategory,
    handleIncomingWebhook
};
