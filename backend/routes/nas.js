const express = require('express');
const router = express.Router();
const { requireAuth, checkFeature, checkRole } = require('../middleware/auth');
const nasDrivers = require('../services/nasDrivers');
const logger = require('../lib/logger');
const store = require('../services/nasDevices');

const MODULE = 'NAS Manager';
const superAdmin = checkRole(['SuperAdmin']);
const operatorUp = checkRole(['SuperAdmin', 'Operator']);

router.use(requireAuth);
router.use(checkFeature('nasControl'));

function audit(req, text) {
    logger.auditLog(req.user.username, MODULE, text);
}

function fail(res, e, fallback = 500) {
    const status = e && e.status ? e.status : fallback;
    if (status >= 500) {
        console.error('[NAS Manager] Request failed:', e && e.message);
        return res.status(status).json({ error: 'Internal server error' });
    }
    return res.status(status).json({ error: e.message });
}

// Driver failures: details only in the server log, except messages flagged userSafe.
function driverFail(res, e, prefix) {
    console.error(`[NAS Manager] ${prefix}:`, e && e.message);
    return res.status(500).json({ error: e && e.userSafe ? e.message : prefix });
}

// Sanitization function to prevent shell/powershell injection
function sanitizeInput(str) {
    if (!str) return '';
    // Allow alphanumeric characters, common path separators, dash, underscore, dot, and space
    return String(str).replace(/[^a-zA-Z0-9_\-\.\/\\: ]/g, '');
}

function nameTaken(devices, name, exceptId) {
    const n = name.toLowerCase();
    return devices.some(d => d.id !== exceptId && String(d.name || '').toLowerCase() === n);
}

// GET all devices (with optional dynamic sync if sync=true query param is present)
router.get('/config', async (req, res) => {
    try {
        let devices = await store.readDevices();

        if (req.query.sync === 'true') {
            // Query drivers outside the write chain (slow), then apply results to the fresh list by id.
            const results = await Promise.all(devices.map(async (dev) => {
                try {
                    const driver = nasDrivers.getDriver(dev);
                    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 6000));
                    const volumes = await Promise.race([driver.getStorageInfo(), timeout]);
                    const shares = await Promise.race([driver.listShares(), timeout]);
                    return { id: dev.id, volumes, shares };
                } catch (e) {
                    console.warn(`[NAS Manager] Failed to dynamically sync device ${dev.name}: ${e.message}`);
                    return { id: dev.id };
                }
            }));
            devices = await store.mutate((list) => {
                for (const r of results) {
                    const dev = list.find(x => x.id === r.id);
                    if (!dev) continue;
                    if (r.volumes && r.volumes.length > 0) dev.volumes = r.volumes;
                    if (r.shares && r.shares.length > 0) dev.shares = r.shares;
                    else if (!dev.shares) dev.shares = [];
                    dev.status = 'online';
                }
                return { value: list.map(d => ({ ...d })) };
            });
        }

        res.json(devices.map(store.publicDevice));
    } catch (e) {
        fail(res, e);
    }
});

// POST create device (SuperAdmin)
router.post('/devices', superAdmin, async (req, res) => {
    try {
        const fields = store.validateDeviceInput(req.body);
        const created = await store.mutate((list) => {
            if (nameTaken(list, fields.name)) throw new store.NasValidationError(`A device named "${fields.name}" already exists`, 409);
            const { password, ...rest } = fields;
            if (rest.port === null) delete rest.port;
            const dev = { id: store.newId(), ...rest, shares: [], volumes: [], status: 'unknown' };
            if (password) store.applyPassword(dev, password);
            list.push(dev);
            return { value: store.publicDevice(dev) };
        });
        audit(req, `Created NAS device "${created.name}" (${created.type}, ${created.ip})`);
        res.status(201).json(created);
    } catch (e) {
        fail(res, e);
    }
});

// PUT update device (SuperAdmin); blank/absent password keeps the stored one
router.put('/devices/:id', superAdmin, async (req, res) => {
    try {
        const fields = store.validateDeviceInput(req.body, { partial: true });
        const out = await store.mutate((list) => {
            const dev = list.find(x => x.id === req.params.id);
            if (!dev) throw new store.NasValidationError('Device not found', 404);
            if (fields.name && nameTaken(list, fields.name, dev.id)) throw new store.NasValidationError(`A device named "${fields.name}" already exists`, 409);
            const oldName = dev.name;
            const changes = [];
            for (const k of ['name', 'type', 'ip', 'port', 'username']) {
                if (fields[k] === null && k === 'port') {
                    if (dev.port !== undefined) { delete dev.port; changes.push('port'); }
                } else if (fields[k] !== undefined && fields[k] !== dev[k]) { dev[k] = fields[k]; changes.push(k); }
            }
            if (fields.password) {
                store.applyPassword(dev, fields.password);
                changes.push('password changed');
            }
            return { value: { oldName, changes, device: store.publicDevice(dev) } };
        });
        const rename = out.oldName !== out.device.name ? ` -> "${out.device.name}"` : '';
        audit(req, `Updated NAS device "${out.oldName}"${rename} (${out.changes.length ? out.changes.join(', ') : 'no field changes'})`);
        res.json(out.device);
    } catch (e) {
        fail(res, e);
    }
});

// DELETE device (SuperAdmin)
router.delete('/devices/:id', superAdmin, async (req, res) => {
    try {
        const removed = await store.mutate((list) => {
            const idx = list.findIndex(x => x.id === req.params.id);
            if (idx < 0) throw new store.NasValidationError('Device not found', 404);
            const [dev] = list.splice(idx, 1);
            return { value: dev };
        });
        audit(req, `Deleted NAS device "${removed.name}" (${removed.ip})`);
        res.json({ success: true });
    } catch (e) {
        fail(res, e);
    }
});

// POST save/add config (legacy whole-list replace; SuperAdmin only)
router.post('/config', superAdmin, async (req, res) => {
    const incoming = req.body;
    if (!Array.isArray(incoming)) {
        return res.status(400).json({ error: 'Payload must be an array of devices' });
    }
    try {
        const cleaned = incoming.map(d => ({ id: d && typeof d.id === 'string' ? d.id : undefined, fields: store.validateDeviceInput(d) }));
        const ids = cleaned.map(c => c.id).filter(Boolean);
        if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'Duplicate device id in payload' });
        const total = await store.mutate((list) => {
            const next = [];
            for (const { id, fields } of cleaned) {
                if (nameTaken(next, fields.name)) throw new store.NasValidationError(`A device named "${fields.name}" already exists`, 409);
                const existing = id ? list.find(x => x.id === id) : undefined;
                const { password, ...rest } = fields;
                const dev = existing
                    ? { ...existing, ...rest }
                    : { id: id || store.newId(), ...rest, shares: [], volumes: [], status: 'unknown' };
                if (dev.port === null) delete dev.port;
                if (password) store.applyPassword(dev, password);
                next.push(dev);
            }
            return { devices: next, value: next.length };
        });
        audit(req, `Replaced NAS device list via legacy endpoint. Total devices: ${total}`);
        res.json({ success: true, message: 'NAS configuration saved successfully' });
    } catch (e) {
        fail(res, e);
    }
});

// POST test connection (SuperAdmin). Blank password + id => use the stored one.
router.post('/test-connection', superAdmin, async (req, res) => {
    const body = req.body || {};
    let fields;
    try {
        fields = store.validateDeviceInput({ ...body, name: 'test' });
    } catch (e) {
        return fail(res, e);
    }
    try {
        const probe = { ...fields };
        delete probe.password;
        if (probe.port === null) delete probe.port;
        if (fields.password) {
            store.applyPassword(probe, fields.password);
        } else {
            // Reuse the stored password only when host and port are unchanged from the stored device.
            const stored = typeof body.id === 'string' ? (await store.readDevices()).find(x => x.id === body.id) : null;
            const effPort = (type, p) => Number(p || { synology: 5000, qnap: 8080 }[type] || 0);
            const same = stored
                && String(stored.ip).toLowerCase() === String(fields.ip).toLowerCase()
                && effPort(stored.type, stored.port) === effPort(fields.type, fields.port);
            const plain = same ? store.readStoredPassword(stored) : null;
            if (plain === null) {
                return res.status(400).json({ success: false, message: 'Enter the password to test: the stored password is only reused when the address and port are unchanged.' });
            }
            if (plain) store.applyPassword(probe, plain);
        }
        const driver = nasDrivers.getDriver(probe);
        await driver.getStorageInfo();
        res.json({ success: true, status: 'online', message: `Connected to ${fields.type} successfully.` });
    } catch (e) {
        console.error('[NAS Manager] Connection test failed:', e && e.message);
        const hint = e && e.userSafe ? e.message : `Connection test failed${e && e.code ? ` (${e.code})` : ''}. See the server log for details.`;
        res.status(500).json({ success: false, status: 'offline', message: hint });
    }
});

// POST create share folder (Operator / SuperAdmin)
router.post('/create-share', operatorUp, async (req, res) => {
    let { deviceId, name, path, description } = req.body || {};
    if (!deviceId || !name || !path) {
        return res.status(400).json({ error: 'Missing deviceId, name or path' });
    }
    name = sanitizeInput(name);
    path = sanitizeInput(path);
    description = sanitizeInput(description);

    try {
        const dev = (await store.readDevices()).find(x => x.id === deviceId);
        if (!dev) return res.status(404).json({ error: 'Device not found' });

        await nasDrivers.getDriver(dev).createShare(name, path, description);

        const devName = await store.mutate((list) => {
            const d = list.find(x => x.id === deviceId);
            if (!d) throw new store.NasValidationError('Device not found', 404);
            d.shares = d.shares || [];
            if (!d.shares.some(x => x.name.toLowerCase() === name.toLowerCase())) {
                d.shares.push({ name, path, description, permissions: [] });
            }
            return { value: d.name };
        });
        audit(req, `Created share "${name}" (path "${path}") on NAS device "${devName}"`);
        res.json({ success: true, message: `Share folder "${name}" created successfully on ${devName}` });
    } catch (e) {
        if (e.status) return fail(res, e);
        driverFail(res, e, 'Driver execution failed');
    }
});

// POST delete share folder (Operator / SuperAdmin)
router.post('/delete-share', operatorUp, async (req, res) => {
    let { deviceId, name } = req.body || {};
    if (!deviceId || !name) {
        return res.status(400).json({ error: 'Missing deviceId or name' });
    }
    name = sanitizeInput(name);

    try {
        const dev = (await store.readDevices()).find(x => x.id === deviceId);
        if (!dev) return res.status(404).json({ error: 'Device not found' });

        await nasDrivers.getDriver(dev).deleteShare(name);

        const devName = await store.mutate((list) => {
            const d = list.find(x => x.id === deviceId);
            if (!d) throw new store.NasValidationError('Device not found', 404);
            const lc = name.toLowerCase();
            d.shares = (d.shares || []).filter(x => String(x.name).toLowerCase() !== lc);
            return { value: d.name };
        });
        audit(req, `Deleted share "${name}" from NAS device "${devName}"`);
        res.json({ success: true, message: `Share folder "${name}" deleted successfully from ${devName}` });
    } catch (e) {
        if (e.status) return fail(res, e);
        driverFail(res, e, 'Driver execution failed');
    }
});

// POST set permissions (Operator / SuperAdmin)
router.post('/set-permissions', operatorUp, async (req, res) => {
    const { deviceId, shareName, permissions } = req.body || {};
    if (!deviceId || !shareName || !Array.isArray(permissions)) {
        return res.status(400).json({ error: 'Missing deviceId, shareName or permissions' });
    }
    try {
        const devName = await store.mutate((list) => {
            const dev = list.find(x => x.id === deviceId);
            if (!dev) throw new store.NasValidationError('Device not found', 404);
            const share = dev.shares?.find(x => String(x.name).toLowerCase() === String(shareName).toLowerCase());
            if (!share) throw new store.NasValidationError('Share not found', 404);
            share.permissions = permissions;
            return { value: dev.name };
        });
        audit(req, `Updated permissions for share "${shareName}" on NAS device "${devName}". ACL count: ${permissions.length}`);
        res.json({ success: true, message: `Permissions updated successfully for "${shareName}"` });
    } catch (e) {
        fail(res, e);
    }
});

// POST get live permissions for a share (any nasControl user)
router.post('/get-permissions', async (req, res) => {
    const { deviceId, shareName } = req.body || {};
    if (!deviceId || !shareName) {
        return res.status(400).json({ error: 'Missing deviceId or shareName' });
    }
    try {
        const dev = (await store.readDevices()).find(x => x.id === deviceId);
        if (!dev) return res.status(404).json({ error: 'Device not found' });
        const lc = String(shareName).toLowerCase();
        const cached = () => dev.shares?.find(x => x.name.toLowerCase() === lc)?.permissions || [];

        let perms = [];
        try {
            const driver = nasDrivers.getDriver(dev);
            if (typeof driver.getSharePermissions === 'function') perms = await driver.getSharePermissions(shareName);
        } catch (e) {
            console.error('[NAS] Failed to get share permissions:', e.message);
            return res.json({ success: true, permissions: cached() });
        }
        if (perms && perms.length > 0) {
            await store.mutate((list) => {
                const share = list.find(x => x.id === deviceId)?.shares?.find(x => x.name.toLowerCase() === lc);
                if (!share) return { skipWrite: true };
                share.permissions = perms;
                return {};
            });
        } else {
            perms = cached();
        }
        res.json({ success: true, permissions: perms || [] });
    } catch (e) {
        fail(res, e);
    }
});

module.exports = router;
