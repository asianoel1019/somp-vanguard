const express = require('express');
const { clientIp: getClientIp } = require('../lib/clientIp');
const router = express.Router();
const { requireAuth, checkFeature, checkAnyFeature } = require('../middleware/auth');
const webhookService = require('../services/webhookService');
const { auditLog } = require('../lib/logger');
const crypto = require('crypto');

const INCOMING_SECRET_HEADER = 'X-Webhook-Secret';
const INCOMING_LIMIT = 30; // calls per webhook per minute
const incomingWindows = new Map(); // id -> { start, count }

const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');

function secretMatches(given, storedHash) {
    if (!given || !storedHash) return false;
    const a = Buffer.from(hashSecret(given), 'hex');
    const b = Buffer.from(String(storedHash), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function takeIncomingSlot(id, now = Date.now()) {
    const w = incomingWindows.get(id);
    if (!w || now - w.start >= 60000) {
        incomingWindows.set(id, { start: now, count: 1 });
        return true;
    }
    w.count++;
    return w.count <= INCOMING_LIMIT;
}

// The stored hash never leaves the server; the page only needs to know whether incoming calls are enabled
const forClient = (w) => {
    const { incomingSecretHash, ...rest } = w;
    return { ...rest, incomingEnabled: !!incomingSecretHash };
};

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
        res.json(webhookService.loadWebhooks().map(forClient));
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
        res.json({ success: true, webhook: forClient(newWebhook), webhooks: webhooks.map(forClient) });
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
        res.json({ success: true, webhook: forClient(webhooks[index]), webhooks: webhooks.map(forClient) });
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
        res.json({ success: true, webhooks: webhooks.map(forClient) });
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

// POST /api/webhooks/:id/incoming-secret - (Re)generate the secret external systems must send to /incoming/:id.
// Only a hash is stored; the secret is shown once in this response.
router.post('/:id/incoming-secret', requireAuth, webhookWriteGate, requireAdminOrOperator, (req, res) => {
    try {
        const secret = crypto.randomBytes(24).toString('hex');
        const found = webhookService.mutateWebhooks((list) => {
            const w = list.find(x => x.id === req.params.id);
            if (!w) return null;
            w.incomingSecretHash = hashSecret(secret);
            return w.name;
        });
        if (!found) return res.status(404).json({ error: 'Webhook not found.' });
        auditLog(req.user.username, 'Integration Hub', `Generated a new incoming secret for webhook "${found}"`);
        res.json({ success: true, secret, header: INCOMING_SECRET_HEADER });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/webhooks/incoming/:id - Receive incoming webhook payload from external systems.
// No login, so the caller proves itself with the webhook's secret (header X-Webhook-Secret); a webhook without a
// secret does not accept incoming calls, and each webhook takes at most INCOMING_LIMIT calls per minute.
router.post('/incoming/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const payload = req.body;
        const sourceIp = getClientIp(req);

        const webhook = webhookService.loadWebhooks().find(w => w.id === id);
        if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
        if (!webhook.incomingSecretHash) {
            return res.status(403).json({ error: 'Incoming calls are not enabled for this webhook (no secret generated)' });
        }
        if (!secretMatches(req.get(INCOMING_SECRET_HEADER), webhook.incomingSecretHash)) {
            console.warn(`[Webhooks] Rejected incoming call for ${id} from ${sourceIp}: wrong or missing secret`);
            return res.status(401).json({ error: `Missing or wrong ${INCOMING_SECRET_HEADER}` });
        }
        if (!takeIncomingSlot(id)) {
            return res.status(429).json({ error: `Too many calls: at most ${INCOMING_LIMIT} per minute` });
        }

        await webhookService.handleIncomingWebhook(id, payload, sourceIp);
        
        auditLog('SYSTEM', 'Integration Hub', `Received incoming webhook for ID: ${id} from ${sourceIp}`);
        
        res.json({ success: true, message: 'Webhook received and processed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
