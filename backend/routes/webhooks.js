const express = require('express');
const router = express.Router();
const { requireAuth, checkFeature, checkAnyFeature } = require('../middleware/auth');
const webhookService = require('../services/webhookService');
const { auditLog } = require('../lib/logger');

// Middleware to verify the user is SuperAdmin or Operator
function requireAdminOrOperator(req, res, next) {
    const role = req.user?.role;
    if (role === 'SuperAdmin' || role === 'Operator') {
        return next();
    }
    return res.status(403).json({ error: 'Permission denied. SuperAdmin or Operator role required.' });
}

// GET /api/webhooks - List all webhooks
// Feature checks. The list is read by System Settings -> Integration Hub, the rule editor (RuleModal in
// Scout Monitor / Alerts / Agents), Alerts -> Alert Settings and the Workflow editor. Creating, editing,
// deleting and testing webhooks is done only in System Settings ('settings'). /incoming/:id stays public.
const webhookListGate = checkAnyFeature('settings', 'monitorScout', 'monitorAlerts', 'monitorAgents', 'workflow');
const webhookWriteGate = checkFeature('settings');

router.get('/', requireAuth, webhookListGate, requireAdminOrOperator, (req, res) => {
    try {
        const webhooks = webhookService.loadWebhooks();
        res.json(webhooks);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/webhooks - Create a new Webhook target
router.post('/', requireAuth, webhookWriteGate, requireAdminOrOperator, (req, res) => {
    try {
        const { name, url, method, headers, bodyTemplate, enabled, enabledLogs } = req.body;
        if (!name || !url) {
            return res.status(400).json({ error: 'Webhook Name and URL are required.' });
        }

        const id = 'wh_' + Date.now();
        const newWebhook = {
            id,
            name: name.trim(),
            url: url.trim(),
            method: (method || 'POST').toUpperCase(),
            headers: headers || {},
            bodyTemplate: bodyTemplate || '{"text": "{{message}}"}',
            enabled: enabled !== false,
            enabledLogs: Array.isArray(enabledLogs) ? enabledLogs : undefined
        };

        // atomic read-modify-write of the CURRENT list
        const webhooks = webhookService.mutateWebhooks((list) => { list.push(newWebhook); return list.map(w => ({ ...w })); });

        auditLog(req.user.username, 'Integration Hub', `Created Webhook: "${newWebhook.name}"`);
        res.json({ success: true, webhook: newWebhook, webhooks });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/webhooks/:id - Update an existing Webhook target
router.put('/:id', requireAuth, webhookWriteGate, requireAdminOrOperator, (req, res) => {
    try {
        const { id } = req.params;
        const { name, url, method, headers, bodyTemplate, enabled, enabledLogs } = req.body;

        // atomic read-modify-write of the CURRENT list
        const out = webhookService.mutateWebhooks((webhooks) => {
        const index = webhooks.findIndex(w => w.id === id);
        if (index === -1) return null;

        if (name) webhooks[index].name = name.trim();
        if (url) webhooks[index].url = url.trim();
        if (method) webhooks[index].method = method.toUpperCase();
        if (headers !== undefined) webhooks[index].headers = headers;
        if (bodyTemplate !== undefined) webhooks[index].bodyTemplate = bodyTemplate;
        if (enabled !== undefined) webhooks[index].enabled = enabled;
        if (enabledLogs !== undefined) webhooks[index].enabledLogs = Array.isArray(enabledLogs) ? enabledLogs : [];
        return { index, webhooks: webhooks.map(w => ({ ...w })) };
        });
        if (!out) {
            return res.status(404).json({ error: 'Webhook not found.' });
        }
        const { index, webhooks } = out;

        auditLog(req.user.username, 'Integration Hub', `Updated Webhook: "${webhooks[index].name}"`);
        res.json({ success: true, webhook: webhooks[index], webhooks });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/webhooks/:id - Remove a Webhook target
router.delete('/:id', requireAuth, webhookWriteGate, requireAdminOrOperator, (req, res) => {
    try {
        const { id } = req.params;
        // atomic read-modify-write of the CURRENT list
        const out = webhookService.mutateWebhooks((list) => {
            const index = list.findIndex(w => w.id === id);
            if (index === -1) return null;
            const removedName = list[index].name;
            list.splice(index, 1);
            return { name: removedName, webhooks: list.map(w => ({ ...w })) };
        });
        if (!out) {
            return res.status(404).json({ error: 'Webhook not found.' });
        }
        const { name, webhooks } = out;

        auditLog(req.user.username, 'Integration Hub', `Deleted Webhook: "${name}"`);
        res.json({ success: true, webhooks });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/webhooks/test/:id - Send a test alert payload to a specific webhook
router.post('/test/:id', requireAuth, webhookWriteGate, requireAdminOrOperator, async (req, res) => {
    try {
        const { id } = req.params;
        const webhooks = webhookService.loadWebhooks();
        const webhook = webhooks.find(w => w.id === id);
        if (!webhook) {
            return res.status(404).json({ error: 'Webhook not found.' });
        }

        const testParams = {
            message: '🔔 This is a test alert from the Sys-Op-Manager Webhook Hub integration test.',
            module: 'Integration Hub Test',
            timestamp: new Date().toISOString()
        };

        const result = await webhookService.executeWebhook(webhook, testParams);
        const isSuccess = typeof result === 'boolean' ? result : !!result?.success;
        if (isSuccess) {
            auditLog(req.user.username, 'Integration Hub', `Successfully dispatched test webhook to "${webhook.name}"`);
            res.json({ success: true, message: `Test webhook "${webhook.name}" dispatched successfully.` });
        } else {
            const errDetail = (typeof result === 'object' && result?.error) ? result.error : 'Connection or delivery failed';
            res.status(500).json({
                error: `Test webhook "${webhook.name}" failed: ${errDetail}`,
                debug: result?.debug || null
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/webhooks/incoming/:id - Receive incoming webhook payload from external systems
router.post('/incoming/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const payload = req.body;
        const sourceIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
        
        await webhookService.handleIncomingWebhook(id, payload, sourceIp);
        
        auditLog('SYSTEM', 'Integration Hub', `Received incoming webhook for ID: ${id} from ${sourceIp}`);
        
        res.json({ success: true, message: 'Webhook received and processed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
