const { auditLog, appendLog } = require('../lib/logger');

// In-memory active session store
// key: token (or token prefix/hash)
// value: { token, username, domain, ip, userAgent, loginTime, lastActivityTime, timedOut }
const activeSessions = new Map();

/**
 * Get timeout duration in milliseconds from FRONTEND_TIMEOUT_MINS
 */
function getTimeoutDurationMs() {
    const mins = parseInt(process.env.FRONTEND_TIMEOUT_MINS || '60', 10);
    return (isNaN(mins) || mins <= 0 ? 60 : mins) * 60 * 1000;
}

/**
 * Register a newly authenticated session
 */
function registerSession({ token, username, domain = 'local', ip = 'unknown', userAgent = '' }) {
    if (!token || !username) return;

    const fullUsername = domain ? `${username}@${domain}` : username;
    const now = Date.now();

    activeSessions.set(token, {
        token,
        username,
        domain,
        fullUsername,
        ip,
        userAgent,
        loginTime: now,
        lastActivityTime: now,
        timedOut: false
    });

    appendLog(`[SessionService] Registered active session for ${fullUsername} (IP: ${ip})`);
}

/**
 * Refresh last activity timestamp for an active session
 */
function touchSession(token, userPayload = null) {
    if (!token) return;

    const session = activeSessions.get(token);
    const now = Date.now();

    if (session) {
        if (!session.timedOut) {
            session.lastActivityTime = now;
        }
    } else if (userPayload && userPayload.username) {
        // Auto-register session if verified token is present but not yet in memory
        const username = userPayload.username;
        const domain = userPayload.domain || 'local';
        const fullUsername = domain ? `${username}@${domain}` : username;
        activeSessions.set(token, {
            token,
            username,
            domain,
            fullUsername,
            ip: 'unknown',
            userAgent: '',
            loginTime: now,
            lastActivityTime: now,
            timedOut: false
        });
    }
}

/**
 * Check if a token session has already timed out
 */
function isSessionTimedOut(token) {
    if (!token) return false;
    const session = activeSessions.get(token);
    return session ? session.timedOut === true : false;
}

/**
 * Explicitly remove a specific session (e.g. manual logout)
 */
function removeSession(token) {
    if (!token) return;
    activeSessions.delete(token);
}

/**
 * Remove all active sessions for a username
 */
function removeUserSessions(username) {
    if (!username) return;
    const target = username.toLowerCase().trim();

    for (const [token, session] of activeSessions.entries()) {
        const u = (session.username || '').toLowerCase();
        const f = (session.fullUsername || '').toLowerCase();
        if (u === target || f === target || f.startsWith(target + '@') || u.startsWith(target + '@')) {
            activeSessions.delete(token);
        }
    }
}

/**
 * Return summary of all currently active sessions
 */
function getActiveSessions() {
    const list = [];
    for (const session of activeSessions.values()) {
        list.push({
            username: session.fullUsername,
            loginTime: new Date(session.loginTime).toISOString(),
            lastActivityTime: new Date(session.lastActivityTime).toISOString(),
            ip: session.ip,
            timedOut: session.timedOut
        });
    }
    return list;
}

/**
 * Native Local Time Poller Engine for Session Inactivity Timeout (Rule 6: native setInterval + Date)
 * Runs in the background and evaluates OS local elapsed time against FRONTEND_TIMEOUT_MINS.
 * When timeout is detected on the server, triggers the alert IMMEDIATELY without waiting for browser reopen.
 */
// Map to track recent timeout alerts sent by the server engine: username.toLowerCase() -> timestamp
const recentTimeoutAlerts = new Map();

function recordTimeoutAlert(username) {
    if (!username) return;
    const now = Date.now();
    recentTimeoutAlerts.set(username.toLowerCase(), now);

    // Clean up entries older than 30 minutes
    for (const [user, ts] of recentTimeoutAlerts.entries()) {
        if (now - ts > 30 * 60 * 1000) {
            recentTimeoutAlerts.delete(user);
        }
    }
}

function hasRecentlyAlertedTimeout(username) {
    if (!username) return false;
    const ts = recentTimeoutAlerts.get(username.toLowerCase());
    return !!(ts && (Date.now() - ts < 15 * 60 * 1000));
}

let pollerIntervalId = null;

function startSessionTimeoutPoller() {
    if (pollerIntervalId) return;

    pollerIntervalId = setInterval(() => {
        try {
            const now = Date.now();
            const timeoutMs = getTimeoutDurationMs();
            const expiredTokens = [];

            for (const [token, session] of activeSessions.entries()) {
                if (session.timedOut) {
                    expiredTokens.push(token);
                    continue;
                }

                const elapsedMs = now - session.lastActivityTime;
                if (elapsedMs >= timeoutMs) {
                    session.timedOut = true;
                    const elapsedMins = Math.round(elapsedMs / 60000);
                    const userIdentifier = session.fullUsername || session.username;

                    appendLog(`[SessionEngine] Server-side timeout triggered for ${userIdentifier} (Inactive for ${elapsedMins}m)`);

                    // 1. Record that we alerted this user to avoid duplicate alerts from client
                    recordTimeoutAlert(userIdentifier);
                    if (session.username) recordTimeoutAlert(session.username);

                    // 2. Trigger Audit Log & Push Notification right now at actual timeout time!
                    auditLog(userIdentifier, 'Auth', `Session timed out due to inactivity (${elapsedMins}m)`);

                    // 3. Broadcast WebSocket event if user has active connected browser tab
                    try {
                        const { broadcastEvent } = require('../lib/websocket');
                        broadcastEvent('SESSION_TIMEOUT', {
                            username: userIdentifier,
                            reason: 'inactivity',
                            elapsedMins
                        });
                    } catch (wsErr) {
                        // Ignore ws if not available
                    }

                    expiredTokens.push(token);
                }
            }

            // Remove expired tokens from memory
            for (const t of expiredTokens) {
                activeSessions.delete(t);
            }
        } catch (e) {
            console.error('[SessionEngine Poller Error]:', e.message);
        }
    }, 30000); // Poll every 30 seconds
    // Don't keep the process alive just for this poller (the HTTP server already does in production)
    pollerIntervalId.unref();
}

// Automatically start session timeout poller
startSessionTimeoutPoller();

module.exports = {
    registerSession,
    touchSession,
    isSessionTimedOut,
    removeSession,
    removeUserSessions,
    getActiveSessions,
    startSessionTimeoutPoller,
    getTimeoutDurationMs,
    hasRecentlyAlertedTimeout,
    recordTimeoutAlert
};
