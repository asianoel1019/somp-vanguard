/**
 * SOMP Vanguard - Apache Guacamole WebSocket Proxy Gateway
 * Bridges Frontend HTML5 Guacamole Client with native guacd daemon (Port 4822).
 */
const crypto = require('crypto');
const net = require('net');
const http = require('http');
const GuacamoleLite = require('guacamole-lite');
const Crypt = require('guacamole-lite/lib/Crypt');
const ClientConnection = require('guacamole-lite/lib/ClientConnection');

// Patch ClientConnection.prototype.connect to prevent unhandled TypeError if token decryption fails or connection is closed early
const origClientConnect = ClientConnection.prototype.connect;
ClientConnection.prototype.connect = function(guacdOptions) {
    if (this.state === this.STATE_CLOSED || !this.connectionSettings || !this.connectionSettings.connection) {
        if (this.logger) {
            this.logger.log(0, 'Skipping guacd connect - session already closed or invalid connection settings');
        }
        return;
    }
    return origClientConnect.call(this, guacdOptions);
};

// Patch Server.prototype.decryptToken to sanitize tokens and safely extract JSON slices
GuacamoleLite.prototype.decryptToken = function(encryptedToken) {
    if (!this.clientOptions.crypt || !this.clientOptions.crypt.key) {
        throw new Error('Encryption key not configured');
    }

    try {
        let cleanToken = encryptedToken;
        if (typeof cleanToken === 'string') {
            // Strip any trailing ?undefined, &undefined, or query parameters
            cleanToken = cleanToken.split('?')[0].split('&')[0].trim();
        }

        const rawJson = Buffer.from(cleanToken, 'base64').toString('utf8');
        const start = rawJson.indexOf('{');
        const end = rawJson.lastIndexOf('}');
        const jsonSlice = (start !== -1 && end !== -1 && end >= start) ? rawJson.slice(start, end + 1) : rawJson;
        const tokenData = JSON.parse(jsonSlice);

        const decipher = crypto.createDecipheriv(
            this.clientOptions.crypt.cypher,
            this.clientOptions.crypt.key,
            Buffer.from(tokenData.iv, 'base64')
        );

        let decrypted = decipher.update(Buffer.from(tokenData.value, 'base64'), null, 'utf8');
        decrypted += decipher.final('utf8');

        const dStart = decrypted.indexOf('{');
        const dEnd = decrypted.lastIndexOf('}');
        const dSlice = (dStart !== -1 && dEnd !== -1 && dEnd >= dStart) ? decrypted.slice(dStart, dEnd + 1) : decrypted;

        return JSON.parse(dSlice);
    } catch (error) {
        throw new Error('Failed to decrypt token: ' + error.message);
    }
};

// Patch Crypt.prototype.decrypt to safely sanitize tokens and JSON
Crypt.prototype.decrypt = function(encodedString) {
    let cleanToken = encodedString;
    if (typeof cleanToken === 'string') {
        cleanToken = cleanToken.split('?')[0].split('&')[0].trim();
    }

    const rawJson = Buffer.from(cleanToken, 'base64').toString('utf8');
    const start = rawJson.indexOf('{');
    const end = rawJson.lastIndexOf('}');
    const jsonSlice = (start !== -1 && end !== -1 && end >= start) ? rawJson.slice(start, end + 1) : rawJson;
    let encoded = JSON.parse(jsonSlice);

    const iv = Buffer.from(encoded.iv, 'base64');
    const value = Buffer.from(encoded.value, 'base64');

    const decipher = crypto.createDecipheriv(this.cypher, this.key, iv);

    let decrypted = decipher.update(value, null, 'utf8');
    decrypted += decipher.final('utf8');

    const dStart = decrypted.indexOf('{');
    const dEnd = decrypted.lastIndexOf('}');
    const dSlice = (dStart !== -1 && dEnd !== -1 && dEnd >= dStart) ? decrypted.slice(dStart, dEnd + 1) : decrypted;

    return JSON.parse(dSlice);
};

let guacProxy = null;
let cryptInstance = null;
let effectiveGuacdHost = process.env.GUACD_HOST || '127.0.0.1';

function getEncryptionKey() {
    const rawSecret = process.env.JWT_SECRET || 'SOMP_VANGUARD_GUACAMOLE_SECRET_32B!';
    return crypto.createHash('sha256').update(rawSecret).digest(); // Exactly 32 bytes for AES-256
}

function getCryptInstance() {
    if (!cryptInstance) {
        cryptInstance = new Crypt('AES-256-CBC', getEncryptionKey());
    }
    return cryptInstance;
}

/**
 * Encrypts connection payload into guacamole-lite compatible token format
 */
function encryptConnectionToken(connectionData) {
    return getCryptInstance().encrypt(connectionData);
}

/**
 * Probes TCP port connectivity with configurable timeout
 */
function probeTcpPort(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeoutMs);

        socket.on('connect', () => {
            socket.destroy();
            resolve({ ok: true });
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve({ ok: false, reason: 'timeout' });
        });

        socket.on('error', (err) => {
            socket.destroy();
            resolve({ ok: false, reason: err.code || err.message });
        });

        socket.connect(port, host);
    });
}

function getEffectiveGuacdHost() {
    return effectiveGuacdHost;
}

/**
 * Initializes GuacamoleLite WebSocket proxy attached to the HTTP server.
 * Handles /guacamole WebSocket endpoint and routes traffic to guacd.
 */
function initGuacamoleProxy(httpServer) {
    if (guacProxy) return guacProxy;

    const configuredHost = process.env.GUACD_HOST || '127.0.0.1';
    const guacdPort = parseInt(process.env.GUACD_PORT || '4822', 10);
    effectiveGuacdHost = configuredHost;
    const key = getEncryptionKey();

    // Use an unlistened dummy HTTP server for guacamole-lite's internal WebSocketServer.
    // If we passed httpServer directly, ws.WebSocketServer would attach an 'upgrade' listener
    // that immediately aborts any non-/guacamole requests (such as /ws notifications) with 400 Bad Request!
    const dummyServer = http.createServer();

    const websocketOptions = {
        server: dummyServer,
        path: '/guacamole'
    };

    const guacdOptions = {
        host: configuredHost,
        port: guacdPort
    };

    const clientOptions = {
        crypt: {
            cypher: 'AES-256-CBC',
            key: key
        },
        log: {
            level: 'VERBOSE', // VERBOSE enables connection lifecycle & debug logs
            stdLog: (...args) => console.log('[GuacamoleLite]', ...args),
            errorLog: (...args) => console.error('[GuacamoleLite Error]', ...args)
        }
    };

    const callbacks = {
        processConnectionSettings: (settings, callback) => {
            // Synchronously accept verified connection settings to avoid async race condition in ClientConnection
            callback(null, settings);
        }
    };

    try {
        guacProxy = new GuacamoleLite(websocketOptions, guacdOptions, clientOptions, callbacks);
        console.log(`[Guacamole] WebSocket proxy initialized on /guacamole targeting guacd at ${configuredHost}:${guacdPort}`);

        // Perform proactive background check on guacd daemon connectivity
        (async () => {
            const check = await probeTcpPort(configuredHost, guacdPort, 1500);
            if (check.ok) {
                console.log(`[Guacamole] Health check OK: Successfully connected to guacd daemon at ${configuredHost}:${guacdPort}`);
            } else {
                console.warn(`[Guacamole Warning] Configured guacd daemon at ${configuredHost}:${guacdPort} is UNREACHABLE (${check.reason})!`);
                if (configuredHost !== '127.0.0.1' && configuredHost !== 'localhost') {
                    const localCheck = await probeTcpPort('127.0.0.1', guacdPort, 1500);
                    if (localCheck.ok) {
                        console.log(`[Guacamole Recovery] Detected active guacd on local loopback 127.0.0.1:${guacdPort}! Auto-switching default guacd routing to 127.0.0.1.`);
                        effectiveGuacdHost = '127.0.0.1';
                        if (guacProxy && guacProxy.defaultGuacdOptions) {
                            guacProxy.defaultGuacdOptions.host = '127.0.0.1';
                        }
                    } else {
                        console.error(`[Guacamole Error] Neither ${configuredHost}:${guacdPort} nor 127.0.0.1:${guacdPort} is reachable. Please verify guacd container status.`);
                    }
                }
            }
        })();

        // Safeguard WebSocketServer against unhandled errors on socket drop
        if (guacProxy.webSocketServer) {
            guacProxy.webSocketServer.on('error', (err) => {
                console.warn('[Guacamole WebSocketServer]', err?.message || err);
            });
            guacProxy.webSocketServer.on('connection', (ws) => {
                ws.on('error', (err) => {
                    console.warn('[Guacamole Client WS]', err?.message || err);
                });
            });
        }

        // Wrap newConnection to safely catch any async rejections (e.g. token decryption failures, closed sockets)
        const origNewConnection = guacProxy.newConnection.bind(guacProxy);
        guacProxy.newConnection = async function(webSocketConnection, request) {
            try {
                if (request && request.url) {
                    request.url = request.url.replace(/[\?&]undefined\b.*/g, '');
                }
                return await origNewConnection(webSocketConnection, request);
            } catch (err) {
                console.warn('[Guacamole Connection Caught]', err?.message || err);
                try {
                    if (webSocketConnection && webSocketConnection.readyState === 1) {
                        webSocketConnection.close(1011, 'Guacamole session setup failed');
                    }
                } catch (e) {}
            }
        };

        guacProxy.on('error', (clientConnection, error) => {
            console.error('[Guacamole Proxy Error]', error ? (error.stack || error.message || error) : 'Unknown proxy error');
        });

        guacProxy.on('close', (clientConnection, error) => {
            console.log('[Guacamole Proxy Close] Session disconnected.', error ? (error.message || error) : 'Normal closure');
        });

        // Explicitly bridge only /guacamole upgrade requests from the real httpServer
        httpServer.on('upgrade', (request, socket, head) => {
            if (!request.url.startsWith('/guacamole')) {
                // Strictly ignore non-/guacamole paths (e.g. /ws for alerts and notifications)
                return;
            }

            // Immediately attach socket error listener to avoid unhandled socket reset exceptions
            socket.on('error', (err) => {
                console.warn('[Guacamole Raw Socket]', err?.message || err);
            });

            if (request.url) {
                request.url = request.url.replace(/[\?&]undefined\b.*/g, '');
            }

            if (!request.url.includes('token=')) {
                socket.write('HTTP/1.1 400 Bad Request\r\n\r\nMissing token parameter');
                socket.destroy();
                return;
            }

            guacProxy.webSocketServer.handleUpgrade(request, socket, head, (ws) => {
                // Attach error trap directly onto the client websocket
                ws.on('error', (err) => {
                    console.warn('[Guacamole Client WS]', err?.message || err);
                });
                guacProxy.webSocketServer.emit('connection', ws, request);
            });
        });

        return guacProxy;
    } catch (err) {
        console.error('[Guacamole Proxy Init Error]:', err.message);
        return null;
    }
}

module.exports = {
    initGuacamoleProxy,
    encryptConnectionToken,
    getEncryptionKey,
    getEffectiveGuacdHost
};

