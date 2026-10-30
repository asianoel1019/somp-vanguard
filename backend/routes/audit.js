const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { requireAuth, checkRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(checkRole(['SuperAdmin']));

const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const LOG_DIR = path.join(BASE_DATA_DIR, 'logs');

// Helper to parse log line
function parseLogLine(line) {
    // Matches formats like:
    // [2026-05-12T07:28:24.701Z] [Audit] User: admin | Module: Inventory | Action: Updated inventory configuration
    // [2026-05-12T07:28:24.701Z] [Audit-Batch] User: admin | Module: Inventory | Actions (5): Updated config...
    const auditRegex = /^\[(.*?)\] \[(Audit(?:-Batch)?)\] User: (.*?) \| Module: (.*?) \| Actions?(?: \(\d+\))?: (.*)$/;
    const match = line.match(auditRegex);
    if (match) {
        return {
            timestamp: match[1],
            user: match[3].trim(),
            module: match[4].trim(),
            action: match[5].trim()
        };
    }
    return null;
}

// GET /api/audit/logs - Fetch and filter audit logs
router.get('/logs', (req, res) => {
    try {
        if (!fs.existsSync(LOG_DIR)) {
            return res.json({ logs: [] });
        }

        const files = fs.readdirSync(LOG_DIR);
        const auditFiles = files.filter(f => f.startsWith('auth_') && (f.endsWith('.log') || f.endsWith('.log.gz')));

        let allLogs = [];

        auditFiles.forEach(file => {
            const filePath = path.join(LOG_DIR, file);
            let content = '';

            try {
                if (file.endsWith('.gz')) {
                    const compressed = fs.readFileSync(filePath);
                    content = zlib.gunzipSync(compressed).toString('utf8');
                } else {
                    content = fs.readFileSync(filePath, 'utf8');
                }
            } catch (err) {
                console.error(`Failed to read/decompress audit log file: ${file}`, err);
                return;
            }

            const lines = content.split('\n');
            lines.forEach(line => {
                if (line.includes('[Audit]') || line.includes('[Audit-Batch]')) {
                    const parsed = parseLogLine(line);
                    if (parsed) {
                        allLogs.push(parsed);
                    }
                }
            });
        });

        // Default sort by timestamp desc
        allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Get unique users and modules for filter dropdowns
        const uniqueUsers = [...new Set(allLogs.map(l => l.user))].sort();
        const uniqueModules = [...new Set(allLogs.map(l => l.module))].sort();

        res.json({
            logs: allLogs,
            filters: {
                users: uniqueUsers,
                modules: uniqueModules
            }
        });
    } catch (err) {
        console.error('Error in GET /api/audit/logs:', err);
        res.status(500).json({ error: 'Internal server error reading audit logs' });
    }
});

module.exports = router;
