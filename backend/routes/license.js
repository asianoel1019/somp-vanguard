// License page (System Settings -> License): current edition for every signed-in user; upload / removal for SuperAdmin.
const express = require('express');
const router = express.Router();
const { requireAuth, checkRole } = require('../middleware/auth');
const license = require('../lib/license');
const logger = require('../lib/logger');

const MAX_BYTES = 16 * 1024;

router.use(requireAuth);

router.get('/', (req, res) => res.json(license.publicState()));

router.post('/', checkRole(['SuperAdmin']), (req, res) => {
    const text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
    if (!text.trim()) return res.status(400).json({ error: 'Paste or choose a license file.' });
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return res.status(400).json({ error: 'A license file is at most 16 KB.' });
    let r;
    try {
        r = license.installLicense(text, req.user.username);
    } catch (e) {
        return res.status(500).json({ error: `Could not store the license: ${e.message}` });
    }
    if (!r.ok) return res.status(400).json({ error: `License rejected: ${r.reason}` });
    logger.auditLog(req.user.username, 'License', `License installed: ${r.payload.licenseId} (${r.payload.customer})`);
    res.json(license.publicState());
});

router.delete('/', checkRole(['SuperAdmin']), (req, res) => {
    try {
        const before = license.getLicense();
        license.removeLicense(req.user.username);
        logger.auditLog(req.user.username, 'License', `License removed${before.licenseId ? `: ${before.licenseId}` : ''} (free edition)`);
    } catch (e) {
        return res.status(500).json({ error: `Could not remove the license: ${e.message}` });
    }
    res.json(license.publicState());
});

module.exports = router;
