/**
 * SOMP Vanguard - Apache Guacamole WebSocket proxy (guacamole-lite) in front of guacd.
 *
 * Tokens: the browser receives a single-use, 30-second, AES-GCM token from POST /api/remote/token
 * (services/remoteToken). When the WebSocket upgrade arrives the token is checked and used up here, before
 * guacamole-lite sees anything; guacamole-lite then gets a random in-memory handoff id instead of a token
 * (it reads the token twice: once to pick the guacd, once to connect). The handoff id is never sent to a browser
 * and is gone after the connection takes it or after HANDOFF_TTL_MS.
 *
 * Audit: connected / disconnected (with duration) / could not be established are written here from the
 * session's own audit data in the token, so they do not depend on the browser reporting them.
 */
const crypto = require('crypto');
const net = require('net');
const http = require('http');
const GuacamoleLite = require('guacamole-lite');
const Crypt = require('guacamole-lite/lib/Crypt');
const ClientConnection = require('guacamole-lite/lib/ClientConnection');
const remoteToken = require('./remoteToken');
const { auditLog } = require('../lib/logger');

const HANDOFF_TTL_MS = 30 * 1000;
// Display settings the browser may send next to the token (validated; everything else is dropped)
const DISPLAY_PARAMS = { width: [320, 8192], height: [200, 8192], dpi: [48, 384] };

// Patch ClientConnection.prototype.connect: no guacd connect after the session closed or without settings
const origClientConnect = ClientConnection.prototype.connect;
ClientConnection.prototype.connect = function (guacdOptions) {
    if (this.state === this.STATE_CLOSED || !this.connectionSettings || !this.connectionSettings.connection) {
        if (this.logger) this.logger.log(0, 'Skipping guacd connect - session already closed or invalid connection settings');
        return;
    }
    return origClientConnect.call(this, guacdOptions);
};

// Any failure while setting a session up closes that WebSocket instead of rejecting unhandled. Patched on the
// prototype: the Server binds newConnection to its WebSocketServer when it is constructed.
const origNewConnection = GuacamoleLite.prototype.newConnection;
GuacamoleLite.prototype.newConnection = async function (webSocketConnection, request) {
    try {
        return await origNewConnection.call(this, webSocketConnection, request);
    } catch (err) {
        console.warn('[Guacamole Connection Caught]', err?.message || err);
        try {
            if (webSocketConnection && webSocketConnection.readyState === 1) webSocketConnection.close(1011, 'Guacamole session setup failed');
        } catch { /* already closed */ }
    }
};

// ---- handoff of verified settings to guacamole-lite ----
const handoff = new Map(); // id -> { payload, expires }

function forgetExpiredHandoffs(now = Date.now()) {
    for (const [id, h] of handoff) if (h.expires <= now) handoff.delete(id);
}
function putHandoff(payload) {
    forgetExpiredHandoffs();
    const id = crypto.randomBytes(24).toString('hex');
    handoff.set(id, { payload: JSON.stringify(payload), expires: Date.now() + HANDOFF_TTL_MS });
    return id;
}
function readHandoff(id, take) {
    forgetExpiredHandoffs();
    const h = handoff.get(String(id || ''));
    if (!h) throw new Error('Unknown or expired session handoff');
    if (take) handoff.delete(String(id));
    return JSON.parse(h.payload); // a fresh copy: guacamole-lite changes the object it gets
}
// Server.extractGuacdOptions reads the settings to choose the guacd; ClientConnection.decryptToken (via
// Crypt.decrypt) reads them to connect and takes them. Neither ever decrypts anything any more.
GuacamoleLite.prototype.decryptToken = function (id) { return readHandoff(id, false); };
Crypt.prototype.decrypt = function (id) { return readHandoff(id, true); };

/** The guacamole-lite URL for a verified session: the handoff id plus valid display settings only. */
function handoffUrl(id, searchParams) {
    const q = new URLSearchParams({ token: id });
    for (const [k, [min, max]] of Object.entries(DISPLAY_PARAMS)) {
        const v = searchParams.get(k);
        if (v !== null && /^\d{1,5}$/.test(v) && Number(v) >= min && Number(v) <= max) q.set(k, v);
    }
    return `/guacamole?${q.toString()}`;
}

let guacProxy = null;

/**
 * Token for one Web Remote session (kept under this name for callers and tests).
 * @returns {string}
 */
function encryptConnectionToken(payload) {
    return remoteToken.issueToken(payload).token;
}

/** Probes TCP port connectivity with a timeout */
function probeTcpPort(host, port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeoutMs);
        socket.on('connect', () => { socket.destroy(); resolve({ ok: true }); });
        socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, reason: 'timeout' }); });
        socket.on('error', (err) => { socket.destroy(); resolve({ ok: false, reason: err.code || err.message }); });
        socket.connect(port, host);
    });
}

/** The guacd host sessions use: always the configured one (no silent switch to another guacd). */
function getEffectiveGuacdHost() {
    return process.env.GUACD_HOST || '127.0.0.1';
}

const formatDuration = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m ${s % 60}s` : m ? `${m}m ${s % 60}s` : `${s}s`;
};
const shortError = (err) => (err ? String(err.message || err).replace(/[\x00-\x1f]+/g, ' ').slice(0, 200) : '');

function rejectUpgrade(socket, status, message) {
    const reason = status === 503 ? 'Service Unavailable' : status === 400 ? 'Bad Request' : 'Unauthorized';
    try {
        socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}`);
    } catch { /* the socket is already gone */ }
    socket.destroy();
}

/**
 * Initializes the guacamole-lite WebSocket proxy on /guacamole of the HTTP server.
 */
function initGuacamoleProxy(httpServer) {
    if (guacProxy) return guacProxy;

    const guacdHost = getEffectiveGuacdHost();
    const guacdPort = parseInt(process.env.GUACD_PORT || '4822', 10);

    // guacamole-lite's own WebSocketServer sits on an unlistened server: attached to httpServer it would answer
    // every other upgrade (such as /ws notifications) with 400. Upgrades are bridged below.
    const dummyServer = http.createServer();
    const clientOptions = {
        // guacamole-lite requires a key; it is never used, since no token is decrypted by guacamole-lite any more
        crypt: { cypher: 'AES-256-CBC', key: crypto.randomBytes(32) },
        log: {
            level: 'VERBOSE', // connection lifecycle; DEBUG would print guacd instructions, credentials included
            stdLog: (...args) => console.log('[GuacamoleLite]', ...args),
            errorLog: (...args) => console.error('[GuacamoleLite Error]', ...args),
        },
    };
    const callbacks = {
        processConnectionSettings: (settings, callback) => callback(null, settings),
    };

    try {
        guacProxy = new GuacamoleLite({ server: dummyServer, path: '/guacamole' }, { host: guacdHost, port: guacdPort }, clientOptions, callbacks);
        console.log(`[Guacamole] WebSocket proxy initialized on /guacamole targeting guacd at ${guacdHost}:${guacdPort}`);

        probeTcpPort(guacdHost, guacdPort, 1500).then((check) => {
            if (check.ok) console.log(`[Guacamole] Health check OK: guacd reachable at ${guacdHost}:${guacdPort}`);
            else console.warn(`[Guacamole Warning] guacd at ${guacdHost}:${guacdPort} is UNREACHABLE (${check.reason}). Check GUACD_HOST / GUACD_PORT and the guacd service.`);
        });

        if (guacProxy.webSocketServer) {
            guacProxy.webSocketServer.on('error', (err) => console.warn('[Guacamole WebSocketServer]', err?.message || err));
        }

        const opened = new WeakMap(); // clientConnection -> start time
        const auditOf = (cc) => (cc && cc.connectionSettings && cc.connectionSettings.audit) || null;
        guacProxy.on('open', (cc) => {
            opened.set(cc, Date.now());
            const a = auditOf(cc);
            if (a) auditLog(a.user, 'Web Remote Access', `Connected ${a.protocol} session to ${a.target} as [${a.account}]`);
        });
        guacProxy.on('close', (cc, error) => {
            const a = auditOf(cc);
            const started = opened.get(cc);
            opened.delete(cc);
            if (!a) return;
            const why = shortError(error);
            if (started) {
                auditLog(a.user, 'Web Remote Access', `Disconnected ${a.protocol} session to ${a.target} as [${a.account}] after ${formatDuration(Date.now() - started)}${why ? ` (${why})` : ''}`);
            } else {
                auditLog(a.user, 'Web Remote Access', `${a.protocol} session to ${a.target} as [${a.account}] could not be established${why ? `: ${why}` : ''}`);
            }
        });
        guacProxy.on('error', (cc, error) => {
            console.error('[Guacamole Proxy Error]', shortError(error) || 'Unknown proxy error');
        });

        // Bridge only /guacamole upgrades from the real server; the token is checked and used up here
        httpServer.on('upgrade', (request, socket, head) => {
            let url;
            try { url = new URL(request.url, 'http://localhost'); } catch { return; }
            if (url.pathname !== '/guacamole' && url.pathname !== '/guacamole/') return; // e.g. /ws notifications

            socket.on('error', (err) => console.warn('[Guacamole Raw Socket]', err?.message || err));

            let payload;
            try {
                payload = remoteToken.consumeToken(url.searchParams.get('token'));
            } catch (err) {
                console.warn(`[Guacamole] Upgrade refused: ${err.message}`);
                rejectUpgrade(socket, err.status === 503 ? 503 : 401, err.userSafe ? err.message : 'Invalid remote session token');
                return;
            }
            if (!payload.connection || !payload.connection.type || !payload.connection.settings) {
                rejectUpgrade(socket, 400, 'Invalid remote session token');
                return;
            }
            request.url = handoffUrl(putHandoff(payload), url.searchParams);

            guacProxy.webSocketServer.handleUpgrade(request, socket, head, (ws) => {
                ws.on('error', (err) => console.warn('[Guacamole Client WS]', err?.message || err));
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
    getEffectiveGuacdHost,
    // for tests
    _handoff: { putHandoff, readHandoff, handoffUrl, map: handoff },
};
