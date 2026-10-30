const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, checkRole, checkAnyFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');

// Apply authentication to all remote endpoints
router.use(requireAuth);
// Web Remote (RDP/SSH) is opened from the shared Host Detail modal and Nutanix Manager, so every screen
// that shows it may call these endpoints (remoteCmd = owner family "remote access").
router.use(checkAnyFeature('remoteCmd', 'nutanix', 'serverList', 'serverCheck', 'inventory', 'ipam', 'monitorScout', 'monitorAlerts', 'monitorAgents'));

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

const { encryptConnectionToken, getEffectiveGuacdHost } = require('../services/guacamoleProxy');

/**
 * POST /api/remote/token
 * Issues a short-lived (30s) session token for Web-RDP or Web-SSH connection
 * RBAC: Restricted to Operator and SuperAdmin
 */
router.post('/token', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const { ip, protocol = 'rdp', os = 'windows', name = '', port, username, password, domain, security = 'any' } = req.body;

        if (!ip || ip === 'No IP') {
            return res.status(400).json({ error: 'Valid target IP address is required.' });
        }

        const guacdHost = getEffectiveGuacdHost();
        const guacdPort = parseInt(process.env.GUACD_PORT || '4822', 10);

        const effectiveProtocol = (protocol.toLowerCase() === 'ssh' || os.toLowerCase() === 'linux') ? 'ssh' : 'rdp';
        const effectivePort = port || (effectiveProtocol === 'rdp' ? 3389 : 22);

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

        if (effectiveProtocol === 'rdp') {
            let rawUser = (username && username.trim().length > 0) ? username.trim() : (req.user?.username || 'administrator');
            
            // Auto-detect AD domain: explicit domain param -> user token domain -> env var
            let detectedDomain = (domain !== undefined && domain !== null) ? domain.trim() : '';
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
            effectivePwd = (typeof password === 'string' && password.trim().length > 0) ? password.trim() : '';
            if (!effectivePwd) {
                return res.status(400).json({ error: 'A password is required for Web RDP. Enter the Windows password for this account.' });
            }

            connectionSettings['ignore-cert'] = 'true';
            connectionSettings['security'] = security || 'any'; // 'any', 'nla', 'tls', 'rdp'
            connectionSettings['enable-font-smoothing'] = 'true';
            connectionSettings['enable-wallpaper'] = 'true';
            connectionSettings['resize-method'] = 'display-update';
            connectionSettings['dpi'] = '96';
            if (detectedDomain && detectedDomain.trim().length > 0) {
                connectionSettings['domain'] = detectedDomain.trim();
            }
        } else {
            // SSH protocol: Keep username and password BLANK, let user fill them in
            effectiveUser = (username && username.trim().length > 0) ? username.trim() : '';
            effectivePwd = password || '';

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

        const connectionPayload = {
            connection: {
                type: effectiveProtocol,
                settings: connectionSettings,
                guacdHost: guacdHost,
                guacdPort: guacdPort
            }
        };

        // Encrypt into guacamole-lite compatible token
        const token = encryptConnectionToken(connectionPayload);
        const sessionId = crypto.randomBytes(16).toString('hex');

        // Security Audit Log
        auditLog(
            req.user?.username || 'system',
            'Web Remote Access',
            `Initiated ${effectiveProtocol.toUpperCase()} session to ${name ? `${name} (${ip})` : ip} as [${effectiveUser}]`
        );

        res.json({
            success: true,
            token,
            sessionId,
            effectiveUser,
            ip,
            name: name || ip,
            protocol: effectiveProtocol,
            guacdEndpoint: `${guacdHost}:${guacdPort}`,
            expiresIn: 30
        });
    } catch (err) {
        console.error('[Remote/Token] Error issuing remote token:', err);
        res.status(500).json({ error: 'Failed to issue remote session token: ' + err.message });
    }
});

/**
 * POST /api/remote/audit-event
 * Logs session disconnect or special user action
 */
router.post('/audit-event', (req, res) => {
    const { action, targetIp, protocol, details } = req.body;
    auditLog(
        req.user?.username || 'system',
        'Web Remote Access',
        `${action || 'Session action'} on ${targetIp || 'unknown'} (${protocol || 'unknown'}): ${details || ''}`
    );
    res.json({ success: true });
});

module.exports = router;
