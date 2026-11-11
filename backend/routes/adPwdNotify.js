// Password expiry notifications: status, preview of today's notices and a manual run.
// Mounted by routes/ad.js, which has already required sign-in and the adControl feature.
const express = require('express');
const router = express.Router();
const { checkRole } = require('../middleware/auth');
const notifier = require('../services/pwdExpiryNotifier');

const operator = checkRole(['SuperAdmin', 'Operator']);
const superAdmin = checkRole(['SuperAdmin']);

function sendError(res, err) {
    res.status(err.status || 500).json({ error: err.userSafe ? err.message : 'The password expiry notices could not run.' });
}

// GET /pwd-notify/status — settings as they apply now, today's state, recent runs (they list user accounts: Operator+)
router.get('/pwd-notify/status', operator, (req, res) => {
    try {
        res.json(notifier.status());
    } catch (err) {
        sendError(res, err);
    }
});

// POST /pwd-notify/preview — who would be mailed today; nothing is sent
router.post('/pwd-notify/preview', operator, async (req, res) => {
    try {
        res.json(await notifier.preview());
    } catch (err) {
        sendError(res, err);
    }
});

// POST /pwd-notify/run — send today's notices now (test mode still applies)
router.post('/pwd-notify/run', superAdmin, async (req, res) => {
    try {
        res.json(await notifier.runNow(req.user.username));
    } catch (err) {
        sendError(res, err);
    }
});

module.exports = router;
