const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

let wss = null;

// Helper to extract token from standard URL query
function getTokenFromUrl(url) {
    if (!url) return null;
    const match = url.match(/[?&]token=([^&]+)/);
    return match ? match[1] : null;
}

function initWebSocketServer(server) {
    wss = new WebSocketServer({ noServer: true });

    // Handle the upgrade request manually to authenticate
    server.on('upgrade', (request, socket, head) => {
        // Ensure this is our websocket endpoint
        if (!request.url.startsWith('/ws')) {
            // Let other handlers process it or destroy
            return;
        }

        const token = getTokenFromUrl(request.url);
        const secret = process.env.JWT_SECRET;
        
        if (!token || !secret) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        jwt.verify(token, secret, (err, decoded) => {
            if (err) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            // Authentication successful, upgrade connection
            wss.handleUpgrade(request, socket, head, (ws) => {
                ws.user = decoded; // Attach user info to socket
                wss.emit('connection', ws, request);
            });
        });
    });

    wss.on('connection', (ws) => {
        console.log(`[WebSocket] Client connected: ${ws.user.username}`);

        ws.on('message', (message) => {
            // We can handle incoming frontend messages here if needed
            // Currently, it's primarily server-to-client push
        });

        ws.on('close', () => {
            console.log(`[WebSocket] Client disconnected: ${ws.user.username}`);
        });
        
        ws.on('error', (err) => {
            console.error(`[WebSocket] Client error:`, err);
        });
        
        // Send initial connection success event
        ws.send(JSON.stringify({ type: 'CONNECTION_ESTABLISHED', payload: { user: ws.user.username } }));
    });

    console.log('[Startup] WebSocket server initialized on /ws');
}

/**
 * Broadcasts an event to all connected and authenticated clients.
 * @param {string} type - The event type (e.g. 'DNS_UPDATED', 'TASK_COMPLETED')
 * @param {any} payload - The data payload for the event
 */
function broadcastEvent(type, payload = {}) {
    if (!wss) {
        console.warn(`[WebSocket] Cannot broadcast event ${type}: WSS not initialized.`);
        return;
    }

    const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
    
    let count = 0;
    wss.clients.forEach((client) => {
        if (client.readyState === 1) { // 1 = OPEN
            client.send(message);
            count++;
        }
    });
    
    // Only log non-high-frequency events to prevent flooding logs
    if (count > 0 && type !== 'SCOUT_REPORT' && type !== 'TELEMETRY_INGESTED') {
        console.log(`[WebSocket] Broadcasted ${type} to ${count} clients.`);
    }
}

function closeAllConnections() {
    if (wss) {
        console.log('[WebSocket] Force closing all active websocket connections...');
        wss.clients.forEach(client => {
            client.terminate();
        });
        wss.close();
    }
}

module.exports = {
    initWebSocketServer,
    broadcastEvent,
    closeAllConnections
};
