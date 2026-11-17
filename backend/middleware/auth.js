const jwt = require('jsonwebtoken');
const { decryptPassword } = require('../lib/crypto');
const { hasFeature, isFeatureGloballyDisabled } = require('../lib/permissions');
const { licenseAllows, isPaid } = require('../lib/license');
const localAccounts = require('../lib/localAccounts');
const sessionService = require('../services/sessionService');
const sessionRevocation = require('../lib/sessionRevocation');

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid token' });
    }

    const token = authHeader.split(' ')[1];
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET environment variable is missing');
    }
    
    try {
        const decoded = jwt.verify(token, secret);
        // Local page accounts first: still present, enabled and allowed on this edition, so a disabled / deleted
        // account gets its own reason (not the generic revocation below). The stored role wins over the token.
        const localCheck = localAccounts.sessionCheck(decoded);
        if (!localCheck.ok) return res.status(401).json({ error: localCheck.error, code: localCheck.code });
        decoded.role = localCheck.role;
        if (sessionRevocation.isRevoked(decoded)) {
            return res.status(401).json({ error: 'Your account or role was changed: please sign in again.', code: 'SESSION_REVOKED' });
        }
        if (sessionService.isSessionTimedOut(token)) {
            return res.status(401).json({ error: 'Session timed out due to inactivity', code: 'SESSION_TIMEOUT' });
        }
        // Free edition: only the local accounts sign in (an AD session left from a removed license ends here)
        if (decoded.domain !== 'local' && !isPaid()) {
            return res.status(401).json({ error: 'AD sign-in requires a paid license. Sign in with a local account.', code: 'LICENSE_REQUIRED' });
        }
        sessionService.touchSession(token, decoded);

        if (decoded.epass) {
            decoded.password = decryptPassword(decoded.epass, secret);
        }
        if (decoded.username) {
            global.userGroupsCache = global.userGroupsCache || {};
            global.userGroupsCache[decoded.username.toLowerCase()] = decoded.groups || [];
        }
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

const licenseDenied = (res, featureKey) => res.status(403).json({
    error: `Access denied. Feature "${featureKey}" requires a paid license.`, code: 'LICENSE_REQUIRED',
});

function checkRole(allowedRoles) {
    return (req, res, next) => {
        // Assume requireAuth has already run and populated req.user
        if (!req.user || !req.user.role) {
            return res.status(403).json({ error: 'Access denied. Role not found in token.' });
        }
        if (!allowedRoles.includes(req.user.role)) {
            return res.status(403).json({ error: `Access denied. Requires one of: ${allowedRoles.join(', ')}` });
        }
        next();
    };
}

function checkFeature(featureKey) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        if (!licenseAllows(featureKey)) return licenseDenied(res, featureKey);
        if (isFeatureGloballyDisabled(featureKey)) {
            return res.status(403).json({ error: `Access denied. Feature "${featureKey}" is globally disabled.` });
        }
        if (!hasFeature(req.user, featureKey)) {
            return res.status(403).json({ error: `Access denied. Feature "${featureKey}" is disabled in RBAC settings.` });
        }
        next();
    };
}

// Same semantics as checkFeature, but passes when ANY of the keys is allowed (for endpoints shared by several screens)
function checkAnyFeature(...featureKeys) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        const allowed = featureKeys.some(k => !isFeatureGloballyDisabled(k) && hasFeature(req.user, k));
        if (!allowed) {
            if (featureKeys.every(k => !licenseAllows(k))) return licenseDenied(res, featureKeys.join(' / '));
            return res.status(403).json({ error: `Access denied. Requires one of the features: ${featureKeys.join(', ')}` });
        }
        next();
    };
}

module.exports = {
    requireAuth,
    authMiddleware: requireAuth,
    checkRole,
    checkFeature,
    checkAnyFeature
};
