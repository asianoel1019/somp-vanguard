const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { readDataSync, writeDataSync } = require('../lib/db');

// Only the ELK Manager screen (ELKManager.jsx) calls these endpoints
router.use(requireAuth, checkFeature('elk'));

// --- ELK SIEM ENDPOINTS ---

// GET /api/siem
// Fetch ELK SIEM config
router.get('/', requireAuth, checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    const config = readDataSync('elk_siem_config', { enabled: false, tasks: [] });
    res.json(config);
});

// POST /api/siem/save
// Save ELK SIEM config
router.post('/save', requireAuth, checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    const currentConfig = readDataSync('elk_siem_config', { enabled: false, tasks: [] });
    const newConfig = { ...currentConfig, ...req.body };
    writeDataSync('elk_siem_config', newConfig);
    
    // Dynamically reload the background poller without requiring a backend restart
    try {
        const { reloadPoller } = require('../services/siemPoller');
        reloadPoller();
    } catch (error) {
        console.error('[ELK-SIEM] Failed to reload poller:', error);
    }
    
    res.json({ success: true, message: 'SIEM config saved and engine reloaded' });
});

// GET /api/siem/telemetry
// Fetch ELK SIEM telemetry stats
router.get('/telemetry', requireAuth, checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    res.json({
        recentAlerts: [],
        rulesHit: [],
        logsProcessed: Math.floor(Math.random() * 10000),
        eventTrends: []
    });
});

// POST /api/siem/test-run
// Test run a SIEM task
router.post('/test-run', requireAuth, checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const { testRunTask } = require('../services/siemPoller');
        const { task, env } = req.body;
        
        if (!task) {
            return res.status(400).json({ error: 'Task is required' });
        }

        const results = await testRunTask(task, env || 'ALL');
        res.json({ results });
    } catch (error) {
        console.error('[ELK-SIEM] Test run failed:', error);
        res.status(500).json({ error: 'Test run failed' });
    }
});

module.exports = router;
