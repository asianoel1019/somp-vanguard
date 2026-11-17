// Local accounts API (RBAC -> Local Accounts). Not under /api/rbac: it stays writable on the free edition, where the
// quota in lib/localAccounts.js applies. Managing is for local SuperAdmins only (the break-glass admin or a SuperAdmin
// created on this page; an AD SuperAdmin gets 403); every signed-in user can read the list.
const express = require('express');
const { requireAuth, checkRole } = require('../middleware/auth');
const la = require('../lib/localAccounts');
const logger = require('../lib/logger');
const sessionRevocation = require('../lib/sessionRevocation');
const sessionService = require('../services/sessionService');

const router = express.Router();
router.use(requireAuth);

const fail = (res, e) => (e instanceof la.LocalAccountError
    ? res.status(e.status).json({ error: e.message, code: e.code })
    : res.status(500).json({ error: e.message }));
// The change is already committed when this runs: a failure here is logged, never turned into an error response
const endSessions = (username) => {
    try {
        sessionRevocation.revokeUser(username, 'local');
        sessionService.removeLocalUserSessions(username);
    } catch (e) {
        console.error(`[LocalAccounts] Ending the sessions of ${username} failed: ${e.message}`);
        try { logger.appendLog(`[LocalAccounts] Ending the sessions of ${username} failed: ${e.message}`); } catch { /* log unavailable */ }
    }
};
const audit = (req, text) => logger.auditLog(req.user.username, 'Local Accounts', text);
const actor = (req) => ({ username: req.user.username, domain: req.user.domain });

const requireLocalSuperAdmin = [checkRole(['SuperAdmin']), (req, res, next) => (req.user.domain === 'local' ? next()
    : res.status(403).json({ error: 'Local accounts are managed by local SuperAdmins only (the break-glass admin or a SuperAdmin created on this page).', code: 'LOCAL_SUPERADMIN_ONLY' }))];

// /me/password: per-account failure counter (5 wrong current passwords -> 15 minutes), like the login lockout
const PW_MAX_FAILURES = 5;
const PW_LOCK_MS = 15 * 60 * 1000;
const pwFailures = new Map();
const pwKey = (name) => String(name || '').trim().toLowerCase();

router.get('/', (req, res) => res.json(la.listAccounts()));

router.put('/me/password', async (req, res) => {
    try {
        if (req.user.domain !== 'local' || la.isBreakGlassName(req.user.username) || !la.findAccount(req.user.username)) {
            return res.status(400).json({ error: 'Only local accounts created on the RBAC page can change their password here.', code: 'INVALID' });
        }
        const key = pwKey(req.user.username);
        const rec = pwFailures.get(key);
        if (rec && rec.lockUntil) {
            if (Date.now() < rec.lockUntil) {
                const minutes = Math.ceil((rec.lockUntil - Date.now()) / 60000);
                return res.status(429).json({ error: `Too many wrong current passwords. Try again in ${minutes} minutes.`, code: 'LOCKED' });
            }
            pwFailures.delete(key);
        }
        const { currentPassword, newPassword } = req.body || {};
        try {
            await la.changeOwnPasswordAsync(req.user.username, currentPassword, newPassword);
        } catch (e) {
            if (e.wrongPassword) {
                const r = pwFailures.get(key) || { count: 0, lockUntil: 0 };
                r.count += 1;
                if (r.count >= PW_MAX_FAILURES) {
                    r.lockUntil = Date.now() + PW_LOCK_MS;
                    logger.auditLog('SYSTEM', 'Local Accounts', `Change password locked for 15m after ${PW_MAX_FAILURES} wrong current passwords: ${req.user.username}`);
                }
                pwFailures.set(key, r);
            }
            throw e;
        }
        pwFailures.delete(key);
        audit(req, `Changed own password: ${req.user.username}`);
        endSessions(req.user.username);
        res.json({ ok: true, signOut: true });
    } catch (e) { fail(res, e); }
});

router.post('/', requireLocalSuperAdmin, async (req, res) => {
    try {
        const { username, role, password } = req.body || {};
        const passwordHash = password !== undefined && !la.validatePassword(password) ? await la.hashPasswordAsync(password) : undefined;
        const account = la.createAccount({ username, role, password }, req.user.username, { passwordHash });
        audit(req, `Created local account ${account.username} (${account.role}, ${account.createdEdition} edition)`);
        res.status(201).json({ account });
    } catch (e) { fail(res, e); }
});

router.put('/:username', requireLocalSuperAdmin, async (req, res) => {
    try {
        const { role, disabled, password } = req.body || {};
        const passwordHash = password !== undefined && !la.validatePassword(password) ? await la.hashPasswordAsync(password) : undefined;
        const { account, changed } = la.updateAccountDetailed(req.params.username, { role, disabled, password }, actor(req), { passwordHash });
        const what = [changed.role && `role ${account.role}`, changed.disabled && (account.disabled ? 'disabled' : 'enabled'),
            changed.password && 'password reset'].filter(Boolean).join(', ');
        if (what) {
            audit(req, `Updated local account ${account.username}: ${what}`);
            endSessions(account.username);
        }
        res.json({ account });
    } catch (e) { fail(res, e); }
});

router.delete('/:username', requireLocalSuperAdmin, (req, res) => {
    try {
        la.deleteAccount(req.params.username, actor(req));
        audit(req, `Deleted local account ${req.params.username}`);
        endSessions(req.params.username);
        res.json({ ok: true });
    } catch (e) { fail(res, e); }
});

/** Test hook: forget the /me/password failure counters. */
router._resetPasswordFailures = () => pwFailures.clear();

module.exports = router;
