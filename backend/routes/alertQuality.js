/** Alert quality API: maintenance windows, quick mute, settings, read-only preview. */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const db = require('../services/scoutDb');
const { validateWindowInput, windowStatus, parseList } = require('../services/maintenanceWindows');
const { getConfig, saveConfig } = require('../services/alertQualityConfig');
const store = require('../services/alertPolicyStore');
const { previewAlerts } = require('../services/alertPreview');

router.use(requireAuth);
router.use(checkFeature('monitorAlerts'));

const clean = (s, n = 100) => String(s ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n);
const scopeText = (type, valuesJson) => {
    const vals = parseList(valuesJson);
    const n = vals.length;
    return `${clean(type, 20)} (${n} 項${n ? ': ' + vals.slice(0, 3).map(v => clean(v, 40)).join(', ') + (n > 3 ? '…' : '') : ''})`;
};
const ESC_KEYS = ['telegram', 'email', 'webhook'];
const escText = (c) => ESC_KEYS.map(k => `${k}=${c.escalation && c.escalation[k] && c.escalation[k].enabled ? 'on' : 'off'}`).join(', ');

const writers = checkRole(['Operator', 'SuperAdmin']);

function present(row, now = new Date()) {
    return {
        ...row,
        weekdays: row.weekdays ? parseList(row.weekdays).map(Number) : null,
        scopeValues: parseList(row.scopeValues),
        ruleIds: parseList(row.ruleIds),
        enabled: row.enabled === 1,
        status: windowStatus(row, now),
    };
}

function insertWindow(value, user, source = 'manual') {
    const nowIso = new Date().toISOString();
    const row = { id: crypto.randomUUID(), ...value, source, createdBy: user, createdAt: nowIso, updatedAt: nowIso };
    db.run(`INSERT INTO maintenance_windows (id, name, reason, kind, startAt, endAt, weekdays, startTime, durationMin, scopeType, scopeValues, ruleIds, enabled, source, createdBy, createdAt, updatedAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.id, row.name, row.reason, row.kind, row.startAt, row.endAt, row.weekdays, row.startTime, row.durationMin, row.scopeType, row.scopeValues, row.ruleIds, row.enabled, row.source, row.createdBy, row.createdAt, row.updatedAt]);
    store.invalidateWindows();
    return row;
}

const describe = (v) => v.kind === 'once' ? `${v.startAt} ~ ${v.endAt}` : `每週 ${v.weekdays} ${v.startTime} 起 ${v.durationMin} 分鐘`;

router.get('/maintenance', (req, res) => {
    const now = new Date();
    res.json(db.all('SELECT * FROM maintenance_windows ORDER BY createdAt DESC').map(r => present(r, now)));
});

router.post('/maintenance', writers, (req, res) => {
    const v = validateWindowInput(req.body);
    if (!v.ok) return res.status(400).json({ error: v.errors.join('; '), errors: v.errors });
    const row = insertWindow(v.value, req.user.username);
    auditLog(req.user.username, 'Scout Monitor', `Created maintenance window "${clean(row.name)}" (${describe(row)}, scope ${scopeText(row.scopeType, row.scopeValues)})`);
    res.status(201).json(present(row));
});

router.put('/maintenance/:id', writers, (req, res) => {
    const existing = db.get('SELECT * FROM maintenance_windows WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Maintenance window not found' });
    if (req.body && req.body.enabled !== undefined && typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean', errors: ['enabled must be a boolean'] });
    const current = present(existing);
    const merged = { ...current, ...req.body };
    const v = validateWindowInput(merged);
    if (!v.ok) return res.status(400).json({ error: v.errors.join('; '), errors: v.errors });
    const val = v.value;
    const nowIso = new Date().toISOString();
    db.run(`UPDATE maintenance_windows SET name=?, reason=?, kind=?, startAt=?, endAt=?, weekdays=?, startTime=?, durationMin=?, scopeType=?, scopeValues=?, ruleIds=?, enabled=?, updatedAt=? WHERE id=?`,
        [val.name, val.reason, val.kind, val.startAt, val.endAt, val.weekdays, val.startTime, val.durationMin, val.scopeType, val.scopeValues, val.ruleIds, val.enabled, nowIso, existing.id]);
    store.invalidateWindows();
    auditLog(req.user.username, 'Scout Monitor', `Updated maintenance window "${clean(val.name)}" (${val.enabled ? 'enabled' : 'disabled'}, ${describe(val)}, scope ${scopeText(val.scopeType, val.scopeValues)})`);
    res.json(present({ ...existing, ...val, updatedAt: nowIso }));
});

router.delete('/maintenance/:id', writers, (req, res) => {
    const existing = db.get('SELECT * FROM maintenance_windows WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Maintenance window not found' });
    db.run('DELETE FROM maintenance_windows WHERE id = ?', [existing.id]);
    store.invalidateWindows();
    auditLog(req.user.username, 'Scout Monitor', `Deleted maintenance window "${clean(existing.name)}"`);
    res.json({ success: true });
});

router.post('/mute', writers, (req, res) => {
    const hours = Number(req.body && req.body.hours);
    if (![1, 4, 24].includes(hours)) return res.status(400).json({ error: 'Mute duration must be 1, 4 or 24 hours' });
    const alert = db.get('SELECT * FROM alerts WHERE id = ?', [String(req.body.alertId || '')]);
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    if (!alert.checkId) return res.status(400).json({ error: 'This alert has no rule information and cannot be muted' });
    const mon = db.get('SELECT name FROM monitors WHERE id = ?', [alert.monitorId]);
    const monName = clean(mon ? mon.name : alert.monitorId);
    const ruleLabel = clean(alert.ruleName || alert.type || 'Alert');
    const start = new Date();
    const v = validateWindowInput({
        name: `Quick mute: ${monName} ${ruleLabel}`.slice(0, 100),
        reason: `Muted from alert ${alert.id} for ${hours}h`, kind: 'once',
        startAt: start.toISOString(), endAt: new Date(start.getTime() + hours * 3600000).toISOString(),
        scopeType: 'monitors', scopeValues: [String(alert.monitorId)], ruleIds: [String(alert.checkId)],
    }, start);
    if (!v.ok) return res.status(400).json({ error: v.errors.join('; '), errors: v.errors });
    const row = insertWindow(v.value, req.user.username, 'quick-mute');
    auditLog(req.user.username, 'Scout Monitor', `Muted alert ${ruleLabel} on ${monName} for ${hours}h`);
    res.status(201).json(present(row));
});

router.get('/settings', (req, res) => {
    const cfg = { ...getConfig() };   // shallow copy: getConfig() returns a shared cached object
    if (req.user.role !== 'SuperAdmin') {
        const e = cfg.escalation;
        cfg.escalation = {
            telegram: { ...e.telegram, chatId: '' },
            email: { ...e.email, to: '' },
            webhook: { ...e.webhook, webhookId: '' },
        };
    }
    res.json(cfg);
});

router.put('/settings', checkRole(['SuperAdmin']), (req, res) => {
    try {
        const saved = saveConfig(req.body || {});
        auditLog(req.user.username, 'Scout Monitor', `Updated alert quality settings: evaluation=${saved.evaluationEnabled ? 'on' : 'OFF'}, rate=${saved.rateLimitPerMinute}/min, cooldown=${saved.cooldownMin}m, flapping=${saved.flapping.transitions}/${saved.flapping.windowMin}m, escalation: ${escText(saved)}`);
        res.json(saved);
    } catch (e) {
        if (e.errors) return res.status(400).json({ error: e.message, errors: e.errors });
        console.error('[AlertQuality] save settings failed:', e);
        res.status(500).json({ error: 'Save failed' });
    }
});

router.get('/preview', writers, (req, res) => {
    try {
        res.json(previewAlerts({ all: db.all, get: db.get }));
    } catch (e) {
        console.error('[AlertQuality] preview failed:', e);
        res.status(500).json({ error: 'Preview failed' });
    }
});

module.exports = router;
