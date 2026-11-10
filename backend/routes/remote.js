const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const net = require('net');
const { requireAuth, checkRole, checkAnyFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
// through the module object, so tests can replace encryptConnectionToken
const guacamoleProxy = require('../services/guacamoleProxy');
const { TOKEN_TTL_MS } = require('../services/remoteToken');

// Apply authentication to all remote endpoints
router.use(requireAuth);
// Web Remote (RDP/SSH) is opened from the shared Host Detail modal and Nutanix Manager, so every screen
// that shows it may call these endpoints (remoteCmd = owner family "remote access").
router.use(checkAnyFeature('remoteCmd', 'nutanix', 'serverList', 'serverCheck', 'inventory', 'ipam', 'monitorScout', 'monitorAlerts', 'monitorAgents'));

const SECURITY_MODES = ['any', 'nla', 'tls', 'rdp'];
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
const CONTROL_RE = /[\x00-\x1f\x7f]/;

/** An IPv4 / IPv6 address or a DNS host name; anything else (URLs, spaces, ports, paths) is refused. */
const isTargetHost = (v) => typeof v === 'string' && (net.isIP(v) !== 0 || HOSTNAME_RE.test(v));

/** Port 1-65535 from a number or digit string; undefined when not given; null when invalid. */
function parsePort(v) {
    if (v === undefined || v === null || v === '') return undefined;
    const s = String(v).trim();
    if (!/^\d{1,5}$/.test(s)) return null;
    const n = Number(s);
    return n >= 1 && n <= 65535 ? n : null;
}

/** Optional text field: a string without control characters, at most max characters ('' when absent). */
function textField(v, max) {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string' || v.length > max || CONTROL_RE.test(v)) return null;
    return v;
}

/**
 * GET /api/remote/status
 * Returns current Guacamole gateway configuration status
 */
router.get('/status', (req, res) => {
    const guacdHost = process.env.GUACD_HOST || '';
    const guacdPort = parseInt(process.env.GUACD_PORT || '4822', 10);
    const endpoint = process.env.GUACAMOLE_ENDPOINT || (guacdHost ? `${guacdHost}:${guacdPort}` : '');
    const enabled = process.env.FEATURE_WEB_REMOTE !== 'false';
    const configured = Boolean(endpoint && endpoint.trim().length > 0);

    res.json({
        enabled,
        configured,
        endpoint,
        guacdHost,
        guacdPort
    });
});

/**
 * POST /api/remote/token
 * Issues a single-use session token for Web-RDP or Web-SSH that expires after TOKEN_TTL_MS.
 * RBAC: Restricted to Operator and SuperAdmin
 */
router.post('/token', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    const body = req.body || {};
    const ip = typeof body.ip === 'string' ? body.ip.trim() : '';
    if (!ip || ip === 'No IP') return res.status(400).json({ error: 'Valid target IP address is required.' });
    if (!isTargetHost(ip)) return res.status(400).json({ error: 'The target must be an IP address or a host name.' });

    const protocolIn = String(body.protocol || 'rdp').toLowerCase();
    const osIn = String(body.os || 'windows').toLowerCase();
    if (!['rdp', 'ssh'].includes(protocolIn)) return res.status(400).json({ error: 'protocol must be rdp or ssh.' });
    const effectiveProtocol = (protocolIn === 'ssh' || osIn === 'linux') ? 'ssh' : 'rdp';

    const port = parsePort(body.port);
    if (port === null) return res.status(400).json({ error: 'port must be a number from 1 to 65535.' });
    const effectivePort = port || (effectiveProtocol === 'rdp' ? 3389 : 22);

    const security = body.security === undefined || body.security === null || body.security === '' ? 'any' : String(body.security).toLowerCase();
    if (!SECURITY_MODES.includes(security)) return res.status(400).json({ error: `security must be one of: ${SECURITY_MODES.join(', ')}.` });

    const username = textField(body.username, 256);
    const domain = textField(body.domain, 255);
    const name = textField(body.name, 255);
    if (username === null || domain === null || name === null) {
        return res.status(400).json({ error: 'username, domain and name must be text without control characters.' });
    }
    if (body.password !== undefined && body.password !== null && (typeof body.password !== 'string' || body.password.length > 1024)) {
        return res.status(400).json({ error: 'password must be text of at most 1024 characters.' });
    }
    const password = typeof body.password === 'string' ? body.password : '';

    try {
        const guacdHost = guacamoleProxy.getEffectiveGuacdHost();
        const guacdPort = parseInt(process.env.GUACD_PORT || '4822', 10);

        // Build native Guacamole connection settings
        const connectionSettings = {
            hostname: ip,
            port: String(effectivePort)
        };

        // Determine effective credentials:
        // Rule: Windows/RDP defaults to current logged-in somp-vanguard AD user (req.user.username)
        // Rule: Linux/SSH keeps username and password blank unless explicitly supplied by the user
        let effectiveUser = '';
        let effectivePwd = '';
        let detectedDomain = '';

        if (effectiveProtocol === 'rdp') {
            let rawUser = username.trim() ? username.trim() : (req.user?.username || 'administrator');

            // Auto-detect AD domain: explicit domain param -> user token domain -> env var
            detectedDomain = domain.trim();
            if (!detectedDomain) {
                const userDomain = req.user?.domain;
                if (userDomain && userDomain.toLowerCase() !== 'local') {
                    detectedDomain = userDomain;
                } else {
                    detectedDomain = process.env.AD_DOMAIN || process.env.ALLOWED_AD_DOMAIN || '';
                }
            }

            // Support DOMAIN\username or username@domain formats
            if (rawUser.includes('\\')) {
                const parts = rawUser.split('\\');
                detectedDomain = parts[0] === '.' ? '' : parts[0];
                rawUser = parts[1];
            } else if (rawUser.includes('@')) {
                const parts = rawUser.split('@');
                rawUser = parts[0];
                detectedDomain = parts[1];
            }

            effectiveUser = rawUser;
            // The password is always typed in by the user: never filled in from stored credentials (e.g. AD_ADMIN_PWD)
            effectivePwd = password.trim() ? password.trim() : '';
            if (!effectivePwd) {
                return res.status(400).json({ error: 'A password is required for Web RDP. Enter the Windows password for this account.' });
            }

            connectionSettings['ignore-cert'] = 'true';
            connectionSettings['security'] = security;
            connectionSettings['enable-font-smoothing'] = 'true';
            connectionSettings['enable-wallpaper'] = 'true';
            connectionSettings['resize-method'] = 'display-update';
            connectionSettings['dpi'] = '96';
            if (detectedDomain && detectedDomain.trim().length > 0) {
                connectionSettings['domain'] = detectedDomain.trim();
            }
        } else {
            // SSH protocol: Keep username and password BLANK, let user fill them in
            effectiveUser = username.trim();
            effectivePwd = password;

            connectionSettings['color-scheme'] = 'gray-black';
            connectionSettings['font-name'] = 'Consolas, Courier New, monospace';
            connectionSettings['font-size'] = '14';
            connectionSettings['server-alive-interval'] = '10';
        }

        if (effectiveUser) {
            connectionSettings.username = effectiveUser;
        }
        if (effectivePwd) {
            connectionSettings.password = effectivePwd;
        }

        const target = name ? `${name.trim()} (${ip}:${effectivePort})` : `${ip}:${effectivePort}`;
        const account = effectiveProtocol === 'rdp' && detectedDomain ? `${detectedDomain.trim()}\\${effectiveUser}` : (effectiveUser || 'prompted');
        const connectionPayload = {
            connection: {
                type: effectiveProtocol,
                settings: connectionSettings,
                guacdHost: guacdHost,
                guacdPort: guacdPort
            },
            // written to the audit log by the proxy when the session connects and disconnects
            audit: { user: req.user?.username || 'system', protocol: effectiveProtocol.toUpperCase(), target, account }
        };

        // Single-use, short-lived, authenticated token (services/remoteToken)
        const token = guacamoleProxy.encryptConnectionToken(connectionPayload);
        const sessionId = crypto.randomBytes(16).toString('hex');

        auditLog(
            req.user?.username || 'system',
            'Web Remote Access',
            `Requested ${effectiveProtocol.toUpperCase()} session to ${target} as [${account}]`
        );

        res.set('Cache-Control', 'no-store');
        res.json({
            success: true,
            token,
            sessionId,
            effectiveUser,
            ip,
            name: name || ip,
            protocol: effectiveProtocol,
            guacdEndpoint: `${guacdHost}:${guacdPort}`,
            expiresIn: Math.round(TOKEN_TTL_MS / 1000)
        });
    } catch (err) {
        console.error('[Remote/Token] Error issuing remote token:', err.message);
        res.status(err.status || 500).json({ error: err.userSafe ? err.message : 'Failed to issue a remote session token.' });
    }
});

module.exports = router;
