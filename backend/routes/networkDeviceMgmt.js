// Management (vendor API) connection of a network device and the read-only data read through it.
// Mounted by routes/networkDevice.js, behind its login and feature checks.
const express = require('express');
const router = express.Router();
const { checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { findNetworkDevice, NETWORK_TYPES } = require('../lib/networkDevices');
const profileStore = require('../lib/netDevices/profileStore');
const registry = require('../lib/netDevices');
const backups = require('../lib/netDevices/backups');
const sshCli = require('../lib/netDevices/sshCli');
const f5Session = require('../lib/netDevices/f5Session');

const networkDeviceOnly = checkFeature('networkDevice');
const READ = checkRole(['SuperAdmin', 'Operator', 'Viewer']);
const WRITE = checkRole(['SuperAdmin', 'Operator']);
// Backup contents hold hashed passwords and pre-shared keys
const SUPER = checkRole(['SuperAdmin']);

// Query parameters each capability accepts; anything else is ignored (and stays out of the cache key)
const OPTS = {
    policies: ['page', 'limit', 'search'],
    sessions: ['src', 'dst', 'dport'],
    mac: ['mac', 'port', 'vlan'],
    virtuals: ['search', 'nonGreen'],
    pools: ['search', 'nonGreen', 'pool'],
    certs: ['expiringOnly'],
};

function fail(res, err) {
    if (err && err.status && err.code) return res.status(err.status).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: (err && err.message) || 'Request failed' });
}

/** The rack device behind :id, or null after answering 404. */
function deviceOr404(req, res) {
    const found = findNetworkDevice(req.params.id);
    if (!found || !NETWORK_TYPES.includes(found.device.type)) {
        res.status(404).json({ error: 'Device not found' });
        return null;
    }
    return found.device;
}

const label = (d) => d.hostname || d.id;

router.get('/mgmt/vendors', networkDeviceOnly, READ, (req, res) => {
    const type = typeof req.query.type === 'string' ? req.query.type : '';
    res.json(registry.vendorList(type || undefined));
});

router.get('/:id/mgmt', networkDeviceOnly, READ, (req, res) => {
    try {
        const device = deviceOr404(req, res);
        if (!device) return;
        const profile = profileStore.publicProfile(profileStore.getProfile(device.id));
        res.json({
            device: { id: device.id, type: device.type, hostname: device.hostname || '', ip: device.ip || '' },
            profile,
            vendors: registry.vendorList(device.type),
            capabilities: profile ? registry.capabilitiesOf(profile.vendor) : [],
            backup: profile ? registry.canBackup(profile.vendor) : false,
        });
    } catch (err) { fail(res, err); }
});

router.put('/:id/mgmt', networkDeviceOnly, WRITE, (req, res) => {
    try {
        const device = deviceOr404(req, res);
        if (!device) return;
        // tokens of the old connection are not reused (F5 logs in again with the saved values)
        f5Session.forget(profileStore.getProfile(device.id));
        const profile = profileStore.saveProfile(device.id, device.type, req.body, req.user.username);
        registry.clearCache(device.id);
        auditLog(req.user.username, 'Network Device', `Saved management connection of ${label(device)} (${profile.vendor} ${profile.mgmtHost}:${profile.port})`);
        res.json({ success: true, profile, capabilities: registry.capabilitiesOf(profile.vendor), backup: registry.canBackup(profile.vendor) });
    } catch (err) { fail(res, err); }
});

router.delete('/:id/mgmt', networkDeviceOnly, WRITE, (req, res) => {
    try {
        const device = deviceOr404(req, res);
        if (!device) return;
        f5Session.forget(profileStore.getProfile(device.id));
        const existed = profileStore.removeProfile(device.id);
        registry.clearCache(device.id);
        if (existed) auditLog(req.user.username, 'Network Device', `Removed management connection of ${label(device)}`);
        res.json({ success: true, removed: existed });
    } catch (err) { fail(res, err); }
});

// Forget the pinned SSH host key (the switch was replaced): the next SSH connection pins the new key
router.post('/:id/mgmt/hostkey/reset', networkDeviceOnly, WRITE, (req, res) => {
    try {
        const device = deviceOr404(req, res);
        if (!device) return;
        const profile = profileStore.getProfile(device.id);
        const meta = profile && profileStore.VENDORS[profile.vendor];
        if (!profile || !meta || !meta.transports) return res.status(400).json({ error: 'This device has no SSH connection', code: 'BAD_REQUEST' });
        const removed = sshCli.forgetHostKey(profile);
        registry.clearCache(device.id);
        auditLog(req.user.username, 'Network Device', `Reset the SSH host key of ${label(device)} (${sshCli.hostKeyId(profile)})${removed ? '' : ' (none was stored)'}`);
        res.json({ success: true, removed: !!removed });
    } catch (err) { fail(res, err); }
});

// Try the values on the page without saving them (blank secrets fall back to the stored ones for the same target)
router.post('/:id/mgmt/test', networkDeviceOnly, WRITE, async (req, res) => {
    try {
        const device = deviceOr404(req, res);
        if (!device) return;
        const target = profileStore.testTarget(device.id, device.type, req.body);
        const facts = await registry.testConnection(target);
        // a test decides the way afresh: forget the one learned on 'auto'
        const stored = profileStore.getProfile(device.id);
        if (stored && stored.lastTransport) profileStore.recordTransport(device.id, null);
        auditLog(req.user.username, 'Network Device', `Tested management connection of ${label(device)} (${target.vendor} ${target.mgmtHost}:${target.port}): OK`);
        res.json({ success: true, facts });
    } catch (err) { fail(res, err); }
});

router.get('/:id/mgmt/data/:capability', networkDeviceOnly, READ, async (req, res) => {
    try {
        const device = deviceOr404(req, res);
        if (!device) return;
        const cap = req.params.capability;
        const opts = {};
        for (const k of OPTS[cap] || []) {
            const v = req.query[k];
            if (typeof v === 'string' && v !== '') opts[k] = v.slice(0, 200);
        }
        const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
        res.json(await registry.runCapability(device.id, cap, opts, { refresh }));
    } catch (err) { fail(res, err); }
});

// ---------------------------------------------------------------- configuration backups

// List (no contents) and run: Operator+. Contents, differences, download: SuperAdmin, audited.
router.get('/:id/mgmt/backups', networkDeviceOnly, WRITE, (req, res) => {
    try {
        const device = deviceOr404(req, res);
        if (!device) return;
        const list = backups.listBackups(device.id);
        res.json({ ...list, backups: list.backups.map(({ sha256, ...b }) => b), ...backups.scheduleInfo(), canView: req.user.role === 'SuperAdmin' });
    } catch (err) { fail(res, err); }
});

router.post('/:id/mgmt/backups', networkDeviceOnly, WRITE, async (req, res) => {
    try {
        const device = deviceOr404(req, res);
        if (!device) return;
        const r = await backups.runBackup(device.id, { by: req.user.username, trigger: 'manual' });
        auditLog(req.user.username, 'Network Device', `Backed up configuration of ${label(device)}${r.unchanged ? ' (unchanged)' : ` (${r.backup.id}, ${r.backup.size} bytes)`}`);
        const { sha256, ...backup } = r.backup;
        res.json({ success: true, unchanged: r.unchanged, backup });
    } catch (err) { fail(res, err); }
});

// before /:bid so "diff" is not taken for a backup id
router.get('/:id/mgmt/backups/diff', networkDeviceOnly, SUPER, (req, res) => {
    try {
        const device = deviceOr404(req, res);
        if (!device) return;
        const d = backups.diffBackups(device.id, String(req.query.from || ''), String(req.query.to || ''));
        if (!d) return res.status(404).json({ error: 'Backup not found' });
        auditLog(req.user.username, 'Network Device', `Compared configuration backups ${d.from.id} and ${d.to.id} of ${label(device)}`);
        const strip = ({ sha256, ...b }) => b;
        res.json({ ...d, from: strip(d.from), to: strip(d.to) });
    } catch (err) { fail(res, err); }
});

router.get('/:id/mgmt/backups/:bid', networkDeviceOnly, SUPER, (req, res) => {
    try {
        const device = deviceOr404(req, res);
        if (!device) return;
        const b = backups.readBackup(device.id, req.params.bid);
        if (!b) return res.status(404).json({ error: 'Backup not found' });
        auditLog(req.user.username, 'Network Device', `Viewed configuration backup ${b.entry.id} of ${label(device)}`);
        const { sha256, ...entry } = b.entry;
        res.json({ backup: entry, content: b.content });
    } catch (err) { fail(res, err); }
});

router.get('/:id/mgmt/backups/:bid/download', networkDeviceOnly, SUPER, (req, res) => {
    try {
        const device = deviceOr404(req, res);
        if (!device) return;
        const b = backups.readBackup(device.id, req.params.bid);
        if (!b) return res.status(404).json({ error: 'Backup not found' });
        auditLog(req.user.username, 'Network Device', `Downloaded configuration backup ${b.entry.id} of ${label(device)}`);
        const safeName = String(device.hostname || device.id).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'device';
        res.setHeader('Content-Type', b.entry.format === 'xml' ? 'application/xml; charset=utf-8' : b.entry.format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}_${b.entry.id}.${b.entry.format || 'conf'}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(b.content);
    } catch (err) { fail(res, err); }
});

module.exports = router;
