const express = require('express');
const router = express.Router();
const { encryptText, decryptText } = require('../lib/crypto');
const { appendLog, auditLog } = require('../lib/logger');
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const envRegistry = require('../lib/environmentRegistry');
const core = require('../lib/sslCore');
const sslService = require('../services/sslMonitorService');

router.use(requireAuth);
router.use(checkFeature('sslMonitor'));

const ALL_ROLES = ['SuperAdmin', 'Operator', 'Viewer'];
const WRITE_ROLES = ['SuperAdmin', 'Operator'];
const MAX_KEY_TEXT = 256 * 1024;
const MAX_CERT_TEXT = 1024 * 1024;

const userOf = (req) => (req.user ? req.user.username : 'System');
const given = (v) => v !== undefined && v !== null && v !== '';

/** Record as served to clients (no encrypted material, computed status, derived environment). */
function present(record, envs, now = new Date()) {
    return envRegistry.decorateRecord(core.publicRecord(record, now, core.thresholdDays()), envs);
}

/** Type checks of the optional text fields of /add and PUT /:id. Returns an error string or null. */
function checkTextFields(body) {
    for (const f of ['certText', 'keyText', 'keyPassword', 'uploadedFileName', 'uploadedFileType']) {
        if (given(body[f]) && typeof body[f] !== 'string') return `${f} must be a string`;
    }
    if (given(body.uploadedFileB64) && typeof body.uploadedFileB64 !== 'string') return 'uploadedFileB64 must be a base64 string';
    if (given(body.certText) && body.certText.length > MAX_CERT_TEXT) return 'certText is too large (max 1 MB)';
    if (given(body.keyText) && body.keyText.length > MAX_KEY_TEXT) return 'keyText is too large';
    if (given(body.uploadedFileName) && body.uploadedFileName.length > 255) return 'uploadedFileName is too long';
    return null;
}

/**
 * Certificate material of a request: the uploaded file (type whitelist, strict base64, <= 1 MB; PEM / DER parsed in
 * Node, PFX through the constant PowerShell script with bytes + password over stdin) or the pasted certText.
 * Returns { error } (400: bad input), { info, decoded } (parsed), { parseError, decoded } or {} (nothing given).
 */
async function readCertMaterial({ uploadedFileB64, uploadedFileType, certText }, password) {
    if (given(uploadedFileB64)) {
        const decoded = core.decodeUpload(uploadedFileB64, uploadedFileType);
        if (decoded.error) return { error: decoded.error };
        const r = await core.parseUpload(decoded, password || '');
        return r.success ? { info: r, decoded } : { parseError: r.error, decoded };
    }
    if (given(certText) && String(certText).trim()) {
        const r = core.parseX509(certText);
        return r.success ? { info: r } : { parseError: r.error };
    }
    return {};
}

// GET /list - all certificates (array; secrets never included; daysRemaining / status computed now)
router.get('/list', checkRole(ALL_ROLES), async (req, res) => {
    const envs = envRegistry.getEnvironments();
    const now = new Date();
    // environment is derived from envId (Unassigned when unknown); envId is the stored reference
    res.json(sslService.readRecords().filter(r => r && typeof r === 'object').map(r => present(r, envs, now)));
});

// GET /settings - shared UI / alert settings
router.get('/settings', checkRole(ALL_ROLES), (req, res) => {
    res.json({
        thresholdDays: core.thresholdDays(),
        probeTimeoutSeconds: core.PROBE_TIMEOUT_MS / 1000,
        scanDeadlineMinutes: sslService.SCAN_DEADLINE_MS / 60000,
        scanConcurrency: sslService.SCAN_CONCURRENCY,
    });
});

// GET /scan-status - { running, startedAt, finishedAt, lastResult } (any process)
router.get('/scan-status', checkRole(ALL_ROLES), (req, res) => {
    try {
        res.json(sslService.getScanStatus());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /probe - Test single host immediately
router.post('/probe', checkRole(WRITE_ROLES), async (req, res) => {
    const body = req.body || {};
    const h = core.normalizeHost(body.host);
    if (h.error) return res.status(400).json({ error: h.error });
    if (!h.host) return res.status(400).json({ error: 'Host is required' });
    const p = core.normalizePort(body.port);
    if (p.error) return res.status(400).json({ error: p.error });

    const result = await core.hooks.probe(h.host, p.port);
    auditLog(userOf(req), 'SSL Monitor', `Executed single probe on ${h.host}:${p.port}`);
    res.json(result);
});

// POST /add - Add new target, with optional cert text / file / key text
router.post('/add', checkRole(WRITE_ROLES), async (req, res) => {
    const body = req.body || {};
    const { envId, environment, certText, keyText, keyPassword, uploadedFileName, uploadedFileType, uploadedFileB64 } = body;
    // Environment: id, name or code (case-insensitive); empty -> the default environment; unknown -> 400
    // ("Unassigned" is a display value, never a stored choice: treated as empty -> default)
    const envRef = envRegistry.envWriteFields(envRegistry.isUnchangedEnvInput(envId, environment) ? '' : (envId || environment), null, { useDefault: true });
    if (envRef.error) return res.status(400).json({ error: envRef.error });

    const n = core.normalizeName(body.name);
    if (n.error) return res.status(400).json({ error: n.error });
    const h = core.normalizeHost(body.host);
    if (h.error) return res.status(400).json({ error: h.error });
    const p = core.normalizePort(body.port);
    if (p.error) return res.status(400).json({ error: p.error });
    const textErr = checkTextFields(body);
    if (textErr) return res.status(400).json({ error: textErr });
    const host = h.host;

    const nowIso = new Date().toISOString();
    const record = {
        id: core.newId(),
        name: n.name || host || uploadedFileName || 'SSL Monitor',
        host: host || core.FILE_ONLY_HOST,
        port: p.port,
        environment: envRef.env.name,
        envId: envRef.env.id,
        subject: '-',
        issuer: '-',
        validFrom: '-',
        validTo: '-',
        daysRemaining: core.NO_DAYS,
        lastCheck: nowIso,
        status: 'error',
        error: '',
        hasCertStored: !!(given(certText) || given(uploadedFileB64)),
        certText: certText || '',
        uploadedFileName: uploadedFileName || '',
        uploadedFileType: '',
        encryptedFile: '',
        encryptedKey: keyText ? encryptText(keyText) : '',
        encryptedPass: keyPassword ? encryptText(keyPassword) : '',
        createdAt: nowIso,
        createdBy: userOf(req),
    };

    // 1. the uploaded file / pasted certificate, parsed locally (PFX: safe PowerShell path)
    const material = await readCertMaterial(body, keyPassword);
    if (material.error) return res.status(400).json({ error: material.error });
    if (material.parseError && !host) return res.status(400).json({ error: material.parseError });
    if (material.decoded) {
        record.encryptedFile = encryptText(material.decoded.b64);
        record.uploadedFileType = (material.info && material.info.format) || material.decoded.type;
    }

    if (material.info) {
        sslService.applyCertInfo(record, material.info);
    } else if (host) {
        // 2. fallback: probe the live host (also when a given file could not be parsed: the reason is kept)
        if (material.parseError) record.certParseError = material.parseError;
        const probeResult = await core.hooks.probe(host, p.port);
        sslService.applyProbeResult(record, probeResult);
    } else {
        record.error = 'No monitor host and no certificate provided.';
    }
    sslService.refreshStatus(record, new Date(), core.thresholdDays());

    sslService.mutateRecords((records) => { records.push(record); }, 'add');

    auditLog(userOf(req), 'SSL Monitor', `Added certificate monitor for ${record.name} (${record.id})`);
    appendLog(`[SSL Monitor] Added certificate monitor for ${record.name}`);
    res.json({ success: true, record: present(record, envRegistry.getEnvironments()) });
});

// PUT /:id - Edit: name, host, port, environment, optional replacement of certificate material / key.
// Absent (or empty secret) fields stay unchanged; clearKey: true removes the stored key + password.
router.put('/:id', checkRole(WRITE_ROLES), async (req, res) => {
    const id = String(req.params.id);
    const body = req.body || {};
    const current = sslService.readRecords().find(r => r && r.id === id);
    if (!current) return res.status(404).json({ error: 'Record not found' });

    const patch = {};
    const removed = [];
    const changed = [];

    if (body.name !== undefined) {
        const n = core.normalizeName(body.name);
        if (n.error) return res.status(400).json({ error: n.error });
        if (n.name && n.name !== current.name) { patch.name = n.name; changed.push('name'); }
    }
    let host = core.isFileOnly(current) ? '' : current.host;
    if (body.host !== undefined) {
        const h = core.normalizeHost(body.host);
        if (h.error) return res.status(400).json({ error: h.error });
        if (h.host !== host) { host = h.host; patch.host = host || core.FILE_ONLY_HOST; changed.push('host'); }
    }
    let port = Number(current.port) || core.DEFAULT_PORT;
    if (body.port !== undefined) {
        const p = core.normalizePort(body.port);
        if (p.error) return res.status(400).json({ error: p.error });
        if (p.port !== port) { port = p.port; patch.port = port; changed.push('port'); }
    }
    if (!envRegistry.isUnchangedEnvInput(body.envId, body.environment)) {
        const envRef = envRegistry.envWriteFields(body.envId || body.environment, null, { useDefault: true });
        if (envRef.error) return res.status(400).json({ error: envRef.error });
        if (envRef.env.id !== current.envId || envRef.env.name !== current.environment) {
            patch.envId = envRef.env.id; patch.environment = envRef.env.name; changed.push('environment');
        }
    }
    const textErr = checkTextFields(body);
    if (textErr) return res.status(400).json({ error: textErr });

    // secrets: never prefilled by the UI, empty = unchanged
    if (body.clearKey === true) {
        if (current.encryptedKey || current.encryptedPass) changed.push('key cleared');
        patch.encryptedKey = ''; patch.encryptedPass = '';
    }
    if (given(body.keyText)) { patch.encryptedKey = encryptText(body.keyText); changed.push('private key'); }
    if (given(body.keyPassword)) { patch.encryptedPass = encryptText(body.keyPassword); changed.push('key password'); }

    // certificate material
    const certTextChanged = body.certText !== undefined && (body.certText || '') !== (current.certText || '');
    const fileGiven = given(body.uploadedFileB64);
    const pfxPassword = !fileGiven ? '' : (given(body.keyPassword) ? body.keyPassword : (current.encryptedPass && body.clearKey !== true ? decryptText(current.encryptedPass) : ''));
    const material = (fileGiven || (certTextChanged && given(body.certText)))
        ? await readCertMaterial({ uploadedFileB64: body.uploadedFileB64, uploadedFileType: body.uploadedFileType, certText: fileGiven ? '' : body.certText }, pfxPassword)
        : {};
    if (material.error) return res.status(400).json({ error: material.error });
    if (material.parseError && !host) return res.status(400).json({ error: material.parseError });
    if (certTextChanged) { patch.certText = body.certText || ''; changed.push('certificate text'); }
    if (material.decoded) {
        patch.encryptedFile = encryptText(material.decoded.b64);
        patch.uploadedFileType = (material.info && material.info.format) || material.decoded.type;
        patch.uploadedFileName = given(body.uploadedFileName) ? body.uploadedFileName : (current.uploadedFileName || '');
        changed.push('certificate file');
    }
    if (certTextChanged || material.decoded) {
        patch.hasCertStored = !!((certTextChanged ? body.certText : current.certText) || material.decoded || current.encryptedFile);
        removed.push('repairAttemptedAt');
    }

    // re-parse / re-probe
    const endpointChanged = changed.includes('host') || changed.includes('port');
    const certFields = {};
    if (material.info) {
        sslService.applyCertInfo(certFields, material.info);
        certFields.error = '';
        certFields.lastCheck = new Date().toISOString();
        removed.push('certParseError');
    } else if (host && (endpointChanged || material.parseError)) {
        if (material.parseError) certFields.certParseError = material.parseError;
        sslService.applyProbeResult(certFields, await core.hooks.probe(host, port));
    } else if (!host && endpointChanged) {
        // switched to file-only: the certificate data now come from the stored certificate
        const stored = { encryptedFile: current.encryptedFile, encryptedPass: patch.encryptedPass !== undefined ? patch.encryptedPass : current.encryptedPass, certText: patch.certText !== undefined ? patch.certText : current.certText, uploadedFileType: current.uploadedFileType };
        if (stored.encryptedFile || (stored.certText && stored.certText.trim())) {
            const r = await sslService.reparseStored(stored);
            if (r.success) { sslService.applyCertInfo(certFields, r); certFields.error = ''; }
            else certFields.error = `Stored certificate could not be parsed: ${r.error}`;
        }
    }
    if (endpointChanged) {
        for (const f of ['trusted', 'trustError', 'hostnameChecked']) if (certFields[f] === undefined) removed.push(f);
        patch.failCount = 0;
    }

    let missing = false;
    const updated = sslService.mutateRecords((records) => {
        const rec = records.find(r => r && r.id === id);
        if (!rec) { missing = true; return null; }
        Object.assign(rec, patch, certFields);
        for (const f of removed) if (!(f in certFields)) delete rec[f];
        if (endpointChanged && rec.alertState) rec.alertState.errorNotified = false;
        if (!rec.name) rec.name = (host || rec.uploadedFileName || 'SSL Monitor');
        sslService.refreshStatus(rec, new Date(), core.thresholdDays());
        rec.updatedAt = new Date().toISOString();
        rec.updatedBy = userOf(req);
        return JSON.parse(JSON.stringify(rec));
    }, 'edit');
    if (missing) return res.status(404).json({ error: 'Record not found' });

    auditLog(userOf(req), 'SSL Monitor', `Edited certificate monitor ${updated.name} (${id})${changed.length ? `: ${changed.join(', ')}` : ''}`);
    res.json({ success: true, record: present(updated, envRegistry.getEnvironments()) });
});

// POST /check-all - Scan all domains in the background (202); 409 while a scan runs (any process)
router.post('/check-all', checkRole(WRITE_ROLES), (req, res) => {
    const user = userOf(req);
    let r;
    try {
        r = sslService.startBackgroundScan({ trigger: 'manual', user });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
    if (r.running) return res.status(409).json({ running: true, error: 'An SSL scan is already running' });
    auditLog(user, 'SSL Monitor', 'Triggered manual check-all');
    res.status(202).json({ started: true, startedAt: r.startedAt });
});

// DELETE /delete/:id - Remove record (and its stored certificate / private key)
router.delete('/delete/:id', checkRole(WRITE_ROLES), (req, res) => {
    const id = String(req.params.id);
    const removedRec = sslService.mutateRecords((records) => {
        const idx = records.findIndex(r => r && r.id === id);
        if (idx < 0) return null;
        return records.splice(idx, 1)[0];
    }, 'delete');

    if (!removedRec) return res.status(404).json({ error: 'Record not found' });
    const withKey = removedRec.encryptedKey ? ' including its stored private key' : '';
    auditLog(userOf(req), 'SSL Monitor', `Deleted certificate monitor ${removedRec.name || ''} (${id})${withKey}`);
    res.json({ success: true });
});

// GET /view-key/:id - Decrypt and view private key (SuperAdmin only; every view is audited)
router.get('/view-key/:id', checkRole(['SuperAdmin']), (req, res) => {
    const id = String(req.params.id);
    const record = sslService.readRecords().find(r => r && r.id === id);
    if (!record) return res.status(404).json({ error: 'Record not found' });

    auditLog(userOf(req), 'SSL Monitor', `Viewed private key of ${record.name} (${record.id})`);
    if (!record.encryptedKey) return res.json({ keyText: '', keyPassword: '' });

    const keyText = decryptText(record.encryptedKey);
    const keyPassword = record.encryptedPass ? decryptText(record.encryptedPass) : '';
    res.json({ keyText, keyPassword });
});

module.exports = router;
