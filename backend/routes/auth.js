const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const tls = require('tls');
const { validateADCredentials, runPowerShell, getADCredentialHeader } = require('../lib/powershell');
const { encryptPassword } = require('../lib/crypto');
const { getUserRole, readRbacConfig, getAllowedAdDomain } = require('../lib/rbac');
const { buildFeatureMap } = require('../lib/permissions');
const { FEATURE_KEYS, SUPERADMIN_LOCKED_FEATURES } = require('../lib/featureCatalog');
const { requireAuth } = require('../middleware/auth');

const { appendLog, getTodayLogFile, sendTelegramAlert, auditLog } = require('../lib/logger');
const sessionService = require('../services/sessionService');

// --- Global Rate Limiter Memory Store ---
const loginAttempts = new Map();

// --- IP Rate Limiter & Lockout Store ---
const ipLoginLimits = new Map();
const ipLockouts = new Map();
const IP_WINDOW_MS = 30 * 1000;
const IP_MAX_REQUESTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

const loginRateLimiter = (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    if (ipLockouts.has(ip)) {
        const lockTime = ipLockouts.get(ip);
        if (now < lockTime) {
            const minutesLeft = Math.ceil((lockTime - now) / 60000);
            return res.status(429).json({
                error: 'Too Many Requests',
                message: `Too many login attempts. This IP has been locked. Try again in ${minutesLeft} minutes.`
            });
        } else {
            ipLockouts.delete(ip);
        }
    }

    if (!ipLoginLimits.has(ip)) {
        ipLoginLimits.set(ip, { count: 1, firstRequest: now });
        return next();
    }

    const record = ipLoginLimits.get(ip);
    if (now - record.firstRequest > IP_WINDOW_MS) {
        ipLoginLimits.set(ip, { count: 1, firstRequest: now });
        return next();
    }

    record.count++;
    if (record.count > IP_MAX_REQUESTS) {
        ipLockouts.set(ip, now + LOCKOUT_MS);
        auditLog('SYSTEM', 'Auth', `IP ${ip} rate limit exceeded, locked for 5 minutes`);
        return res.status(429).json({
            error: 'Too Many Requests',
            message: `Too many login attempts from this IP. Locked for 5 minutes.`
        });
    }

    ipLoginLimits.set(ip, record);
    next();
};

const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of ipLoginLimits.entries()) {
        if (now - record.firstRequest > IP_WINDOW_MS) {
            ipLoginLimits.delete(ip);
        }
    }
    for (const [ip, lockTime] of ipLockouts.entries()) {
        if (now >= lockTime) {
            ipLockouts.delete(ip);
        }
    }
    for (const [key, attempt] of loginAttempts.entries()) {
        if (attempt.lockUntil && now >= attempt.lockUntil) {
            loginAttempts.delete(key);
        } else if (!attempt.lockUntil && attempt.lastAttempt && now - attempt.lastAttempt > 15 * 60 * 1000) {
            loginAttempts.delete(key);
        }
    }
}, 60000);
// Housekeeping only: must not keep the process (or a test run) alive
if (rateLimitCleanupTimer.unref) rateLimitCleanupTimer.unref();

// Test endpoint — verify route is reachable
router.get('/test', (req, res) => {
    appendLog('TEST endpoint hit');
    res.json({ ok: true, time: new Date().toISOString() });
});

router.post('/login', loginRateLimiter, async (req, res) => {
    try {
        appendLog('POST /login received');
        let { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required' });
        }

        const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const attemptKey = `${username}:${userIp}`;

        if (loginAttempts.has(attemptKey)) {
            const attempt = loginAttempts.get(attemptKey);
            if (attempt.count >= 5) {
                if (Date.now() < attempt.lockUntil) {
                    const minutesLeft = Math.ceil((attempt.lockUntil - Date.now()) / 60000);
                    return res.status(429).json({ error: `Account locked due to too many failed attempts. Try again in ${minutesLeft} minutes.` });
                } else {
                    loginAttempts.delete(attemptKey);
                }
            }
        }

        const handleFailedLogin = (msg) => {
            appendLog(msg);
            const attempt = loginAttempts.get(attemptKey) || { count: 0, lockUntil: 0, lastAttempt: Date.now() };
            attempt.count += 1;
            attempt.lastAttempt = Date.now();
            if (attempt.count >= 5) {
                attempt.lockUntil = Date.now() + 15 * 60 * 1000;
                sendTelegramAlert(`🚨 SECURITY ALERT: Multiple failed logins for ${username} from IP ${userIp}. Locked for 15 minutes.`, 'Auth');
                auditLog('SYSTEM', 'Auth', `Account locked for 15m due to 5 failed logins: ${username} (${userIp})`);
            }
            loginAttempts.set(attemptKey, attempt);
        };

        // 1. Parse username/domain
        let user = username;
        let domain = getAllowedAdDomain();

        if (username.includes('@')) {
            const parts = username.split('@');
            user = parts[0];
            domain = parts[1];
        }

        appendLog(`Login attempt: user="${user}" domain="${domain}" (Input: ${username})`);

        // 2. --- PRIORITY 1: Local admin check ---
        // If username is 'admin' or matches LOCAL_ADMIN_USER, we try local first.
        const localUser = (process.env.LOCAL_ADMIN_USER || 'admin').trim();
        const localPass = (process.env.LOCAL_ADMIN_PWD || '').trim();

        if (user.toLowerCase() === localUser.toLowerCase() && localPass && password === localPass) {
            loginAttempts.delete(attemptKey);
            auditLog(user, 'Auth', 'Local admin login successful');
            const role = getUserRole(user, 'local');
            const secret = process.env.JWT_SECRET;
            if (!secret) throw new Error('JWT_SECRET is not configured. Server must be started with a valid secret.');
            const token = jwt.sign(
                { username: user, domain: 'local', role },
                secret,
                { expiresIn: '24h' }
            );

            sessionService.registerSession({ token, username: user, domain: 'local', ip: userIp });
            
            // Shared evaluation (lib/permissions): the local admin is break-glass and gets every feature
            const features = buildFeatureMap({ username: user, domain: 'local', role });

            return res.json({ token, user: { username: user, domain: 'local', role, features } });
        } else if (user.toLowerCase() === localUser.toLowerCase()) {
            handleFailedLogin(`Local admin login failed: incorrect password for ${user}`);
            return res.status(401).json({ error: 'Invalid local admin credentials.' });
        }

        // 3. --- PRIORITY 2: AD Domain check ---
        // never "local": that domain belongs to the break-glass local admin only
        const allowedDomain = getAllowedAdDomain();
        if (!allowedDomain) {
            return res.status(401).json({ error: 'System uninitialized. Please login as local admin.' });
        }

        // If domain was explicitly provided in username@domain, it MUST match
        if (username.includes('@') && domain.toLowerCase() !== allowedDomain.toLowerCase()) {
            return res.status(401).json({ error: `Authentication restricted to domain: ${allowedDomain}` });
        }

        // Use the configured allowed domain for AD validation
        domain = allowedDomain;

        appendLog(`Calling validateADCredentials for ${user}@${domain}...`);
        const adOutput = await validateADCredentials(user, domain, password);
        
        if (adOutput === 'True') {
            loginAttempts.delete(attemptKey);
            auditLog(username, 'Auth', 'AD login successful');
            const secret = process.env.JWT_SECRET;
            if (!secret) throw new Error('JWT_SECRET is not configured. Server must be started with a valid secret.');
            let role = getUserRole(user, domain);
            
            let matchedGroups = [];
            try {
                const credHdr = getADCredentialHeader(user, domain, password);
                const serverArg = domain ? `-Server "${domain}"` : '';
                const script = `
$ErrorActionPreference = "Stop"
${credHdr}
try {
    $userObj = Get-ADUser -Identity "${user}" -Properties DistinguishedName, MemberOf ${serverArg} -Credential $global:AD_CRED -ErrorAction Stop
    $dn = if ($userObj) { $userObj.DistinguishedName } else { "" }
    $memberOf = if ($userObj -and $userObj.MemberOf) { @($userObj.MemberOf) } else { @() }
    
    $groupNames = try {
        @(Get-ADPrincipalGroupMembership -Identity "${user}" ${serverArg} -Credential $global:AD_CRED | Select-Object -ExpandProperty SamAccountName)
    } catch {
        @()
    }

    [PSCustomObject]@{
        DistinguishedName = $dn
        MemberOf = $memberOf
        GroupNames = $groupNames
    } | ConvertTo-Json
} catch {
    Write-Output "{}"
}
                `;
                appendLog(`Querying AD DN & Groups for user ${user}...`);
                const output = await runPowerShell(script);
                let adInfo = { DistinguishedName: '', MemberOf: [], GroupNames: [] };
                try { adInfo = JSON.parse(output.trim()); } catch (e) {}
                const dn = (adInfo.DistinguishedName || '').toLowerCase();
                const memberOf = Array.isArray(adInfo.MemberOf) ? adInfo.MemberOf.map(m => String(m).toLowerCase()) : (adInfo.MemberOf ? [String(adInfo.MemberOf).toLowerCase()] : []);
                const groupNames = Array.isArray(adInfo.GroupNames) ? adInfo.GroupNames.map(g => String(g).toLowerCase()) : (adInfo.GroupNames ? [String(adInfo.GroupNames).toLowerCase()] : []);
                appendLog(`Retrieved DN: "${dn}", Groups: ${JSON.stringify(groupNames)}`);
                
                const rbac = readRbacConfig();
                if (rbac.groups) {
                    for (const [gName, gData] of Object.entries(rbac.groups)) {
                        if (gData.enabled === false) continue;
                        if (gData.builtin === true) continue; // built-in SuperAdmin mapping is role-based, never AD-matched
                        const gType = gData.type || (gData.adOu ? 'ou' : 'group');
                        const target = (gData.target || gData.adOu || '').toLowerCase().trim();

                        if (gType === 'ou' || (!gData.type && target.startsWith('ou='))) {
                            if (target && dn.includes(target)) {
                                matchedGroups.push(gName);
                            }
                        } else if (gType === 'group') {
                            const isMember = memberOf.some(m => m.includes(target) || m === target) ||
                                             groupNames.some(gn => gn === target || gn === gName.toLowerCase());
                            if (isMember) {
                                matchedGroups.push(gName);
                            }
                        }
                    }
                }
            } catch (gErr) {
                appendLog(`Failed to query AD DN/Groups: ${gErr.message}`);
            }
            appendLog(`Matched groups for ${user}: ${JSON.stringify(matchedGroups)}`);

            // Evaluate group-level role assignments
            const rbacData = readRbacConfig();
            let isAssigned = false;

            // Check direct user assignment
            const userKey = `${user}@${domain}`.toLowerCase();
            if (rbacData.users && rbacData.users[userKey]) {
                isAssigned = true;
            }

            if (rbacData.users) {
                for (const g of matchedGroups) {
                    const groupKey = `[group] ${g}@local`.toLowerCase();
                    if (rbacData.users[groupKey]) {
                        isAssigned = true;
                        const groupRole = typeof rbacData.users[groupKey] === 'string' ? rbacData.users[groupKey] : rbacData.users[groupKey].role;
                        // Upgrade logic: SuperAdmin > Operator > Viewer > None
                        if (groupRole === 'SuperAdmin') role = 'SuperAdmin';
                        else if (groupRole === 'Operator' && (role === 'Viewer' || role === 'None')) role = 'Operator';
                        else if (groupRole === 'Viewer' && role === 'None') role = 'Viewer';
                    }
                }
            }

            if (!isAssigned || role === 'None') {
                handleFailedLogin(`AD user ${user} has role 'None' or is not assigned any authorized role.`);
                return res.status(403).json({ error: 'Access Denied: Your account role is set to None or has not been authorized.' });
            }
            // Calculate user features with the same rules as API gating (hasFeature):
            // SuperAdmin -> built-in "SuperAdmin" mapping, others -> union of their mappings
            const features = buildFeatureMap({ username: user, domain, role, groups: matchedGroups });

            const token = jwt.sign(
                { username: user, domain: domain, role, groups: matchedGroups },
                secret,
                { expiresIn: '24h' }
            );

            sessionService.registerSession({ token, username: user, domain: domain, ip: userIp });
            return res.json({ token, user: { username: user, domain: domain, role, features } });
        } else if (adOutput === 'False') {
            handleFailedLogin(`AD rejected credentials for: ${username}`);
            return res.status(401).json({ error: 'Invalid Active Directory credentials.' });
        } else {
            handleFailedLogin(`AD unexpected output: "${adOutput}"`);
            return res.status(401).json({ error: `AD Error: ${adOutput}` });
        }

    } catch (err) {
        console.error(err);
        appendLog(`EXCEPTION in login route: ${err.stack || err.message}`);
        return res.status(500).json({ error: 'Internal server error occurred.' });
    }
});

// View logs
router.get('/logs', requireAuth, (req, res) => {
    try {
        const currentLogFile = getTodayLogFile();
        if (!fs.existsSync(currentLogFile)) return res.json({ logs: '(no log today yet)' });
        const content = fs.readFileSync(currentLogFile, 'utf-8');
        const lines = content.trim().split('\n');
        res.json({ logs: lines.slice(-100).join('\n') });
    } catch (e) {
        console.error(e);
        appendLog(`[Auth] Exception during view logs: ${e.stack || e.message}`);
        res.status(500).json({ error: 'Internal server error occurred.' });
    }
});

// Explicit logout, timeout, or cold-start cleanup event
router.post('/logout', (req, res) => {
    try {
        const { username, type, token } = req.body;
        if (token) {
            sessionService.removeSession(token);
        }
        if (username) {
            // Cold-start stale session cleanup when opening browser: SILENT, no delayed alert!
            if (type === 'cold_start_cleanup' || type === 'silent_cleanup' || type === 'browser_open') {
                appendLog(`[Auth] Cold-start stale session cleaned up silently for ${username} (no delayed alert)`);
                sessionService.removeUserSessions(username);
                return res.json({ ok: true, cleaned: true });
            }

            if (type === 'timeout' || type === 'frontend_timeout') {
                if (sessionService.hasRecentlyAlertedTimeout(username)) {
                    appendLog(`[Auth] Timeout for ${username} was already alerted by server poller. Suppressing duplicate alert.`);
                    sessionService.removeUserSessions(username);
                    return res.json({ ok: true, suppressed: true });
                }
            }

            let actionDesc = 'User logged out manually';
            if (type === 'timeout' || type === 'frontend_timeout') {
                actionDesc = `Session timed out (Reason: ${type})`;
            }

            sessionService.removeUserSessions(username);
            auditLog(username, 'Auth', actionDesc);
        }
        res.json({ ok: true });
    } catch (e) {
        console.error(e);
        appendLog(`[Auth] Exception during logout: ${e.stack || e.message}`);
        res.status(500).json({ error: 'Internal server error occurred.' });
    }
});

// Lightweight session heartbeat / touch
router.post('/heartbeat', requireAuth, (req, res) => {
    // requireAuth already touches session
    res.json({ ok: true, serverTime: new Date().toISOString() });
});

// GET /config — expose non-sensitive config to frontend
router.get('/config', (req, res) => {
    let decoded = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        const secret = process.env.JWT_SECRET;
        if (!secret) return res.status(500).json({ error: 'JWT_SECRET is not configured' });
        try {
            decoded = jwt.verify(token, secret);
        } catch (e) {
            // Ignore invalid tokens
        }
    }

    const features = {
        dnsHub: process.env.APP_ENABLE_DNSHUB !== 'false',
        adControl: process.env.APP_ENABLE_ADCONTROL !== 'false',
        serverList: process.env.APP_ENABLE_SERVERLIST !== 'false',
        serverCheck: process.env.APP_ENABLE_SERVERCHECK !== 'false',
        remoteCmd: process.env.APP_ENABLE_REMOTECMD !== 'false',
        fortiProxy: process.env.APP_ENABLE_FORTIPROXY !== 'false',
        squid: process.env.APP_ENABLE_SQUID !== 'false',
        mail: process.env.APP_ENABLE_MAIL !== 'false',
        elk: process.env.APP_ENABLE_ELK !== 'false',
        install: process.env.APP_ENABLE_INSTALL !== 'false',
        prometheus: process.env.APP_ENABLE_PROMETHEUS !== 'false',
        nutanix: process.env.APP_ENABLE_NUTANIX !== 'false',
        dataCenter: process.env.APP_ENABLE_DATACENTER !== 'false',
        redisControl: process.env.APP_ENABLE_REDISCONTROL !== 'false',
        inventory: process.env.APP_ENABLE_INVENTORY !== 'false',
        ipam: process.env.APP_ENABLE_IPAM !== 'false',
        sslMonitor: process.env.APP_ENABLE_SSLMONITOR !== 'false',
        scheduler: process.env.APP_ENABLE_SCHEDULER !== 'false',
        netSearch: process.env.APP_ENABLE_NETSEARCH !== 'false',
        kubernetes: process.env.APP_ENABLE_KUBERNETES !== 'false',
        workflow: process.env.APP_ENABLE_WORKFLOW !== 'false',
        runbook: process.env.APP_ENABLE_RUNBOOK !== 'false',
        dbInventory: process.env.APP_ENABLE_DBINVENTORY !== 'false',
        dbSqlTerminal: process.env.APP_ENABLE_DBSQLTERMINAL !== 'false',
        dbPerformance: process.env.APP_ENABLE_DBPERFORMANCE !== 'false',
        dbProvision: process.env.APP_ENABLE_DBPROVISION !== 'false',
        dbBackup: process.env.APP_ENABLE_DBBACKUP !== 'false',
        scoutMonitor: process.env.APP_ENABLE_SCOUTMONITOR !== 'false',
        aiAgent: process.env.APP_ENABLE_AIAGENT !== 'false'
    };

    if (decoded) {
        // Same evaluation as API gating (lib/permissions). SuperAdmin users additionally get every
        // switchable key so the built-in SuperAdmin mapping also hides the matching screens.
        // Every user gets every switchable key (and the lock-out keys) with the API's own value, so a
        // screen is hidden exactly when its API would answer 403.
        const keys = [...new Set([...Object.keys(features), ...FEATURE_KEYS, ...SUPERADMIN_LOCKED_FEATURES])];
        Object.assign(features, buildFeatureMap(decoded, keys));
    }

    const guacEndpoint = process.env.GUACAMOLE_ENDPOINT || (process.env.GUACD_HOST ? `${process.env.GUACD_HOST}:${process.env.GUACD_PORT || 4822}` : '');
    const hasGuacamole = Boolean(guacEndpoint && process.env.FEATURE_WEB_REMOTE !== 'false');

    res.json({
        allowedDomain: getAllowedAdDomain(),
        linuxAdminUser: process.env.LINUX_ADMIN_USER || 'xyuser',
        frontendTimeout: parseInt(process.env.FRONTEND_TIMEOUT_MINS || '60') * 60 * 1000,
        features,
        hasGuacamole,
        guacamoleEndpoint: guacEndpoint
    });
});

// GET /readme — serve the frontend README content
router.get('/readme', requireAuth, (req, res) => {
    try {
        const readmePath = path.join(__dirname, '../../frontend/README.md');
        if (fs.existsSync(readmePath)) {
            const content = fs.readFileSync(readmePath, 'utf8');
            res.json({ content });
        } else {
            res.status(404).json({ error: 'README.md not found' });
        }
    } catch (err) {
        console.error(err);
        appendLog(`[Auth] Exception during get readme: ${err.stack || err.message}`);
        res.status(500).json({ error: 'Internal server error occurred.' });
    }
});

// GET /userguide — serve the frontend userguide content
router.get('/userguide', requireAuth, (req, res) => {
    try {
        const guidePath = path.join(__dirname, '../../frontend/userguide.md');
        if (fs.existsSync(guidePath)) {
            const content = fs.readFileSync(guidePath, 'utf8');
            res.json({ content });
        } else {
            res.status(404).json({ error: 'userguide.md not found' });
        }
    } catch (err) {
        console.error(err);
        appendLog(`[Auth] Exception during get userguide: ${err.stack || err.message}`);
        res.status(500).json({ error: 'Internal server error occurred.' });
    }
});

// GET /troubleshoot — serve the frontend troubleshooting content
router.get('/troubleshoot', requireAuth, (req, res) => {
    try {
        const pathFile = path.join(__dirname, '../../frontend/troubleshooting.md');
        if (fs.existsSync(pathFile)) {
            const content = fs.readFileSync(pathFile, 'utf8');
            res.json({ content });
        } else {
            res.status(404).json({ error: 'troubleshooting.md not found' });
        }
    } catch (err) {
        console.error(err);
        appendLog(`[Auth] Exception during get troubleshoot: ${err.stack || err.message}`);
        res.status(500).json({ error: 'Internal server error occurred.' });
    }
});

module.exports = router;
