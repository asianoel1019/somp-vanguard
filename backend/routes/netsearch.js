const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { loadAllConfigs, state } = require('../services/netsearchScheduler');
const { auditLog } = require('../lib/logger');

router.use(requireAuth);
router.use(checkFeature('netSearch'));

// GET /api/netsearch/data - Fetch parsed config data
router.get('/data', (req, res) => {
  res.json({
    parsedConfigs: state.parsedConfigs || [],
    fqdnRecords:   state.fqdnRecords || [],
    lastLoaded:    state.lastLoaded,
    loading:       state.loading,
    hasFqdnSource: !!process.env.NETSEARCH_FQDN_FILE
  });
});

// POST /api/netsearch/reload - Manually trigger backup import and configuration parsing
router.post('/reload', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
  auditLog(req.user.username, 'NetSearch', 'Manual configuration reload triggered');
  const result = await loadAllConfigs();
  if (result.ok) {
    auditLog(req.user.username, 'NetSearch', 'Manual configuration reload completed successfully');
  } else {
    auditLog(req.user.username, 'NetSearch', `Manual configuration reload failed: ${result.error}`);
  }
  res.json(result);
});

module.exports = router;
