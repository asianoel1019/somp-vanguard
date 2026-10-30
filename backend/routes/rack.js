const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { requireAuth, checkRole, checkFeature, checkAnyFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');

const LICENSES_DIR = process.env.DB_DATA_DIR ? path.join(process.env.DB_DATA_DIR, 'data_center', 'licenses') : 'C:\\ProgramData\\somp-vanguard\\data_center\\licenses';

const { readDataSync, writeDataSync } = require('../lib/db');
const { mutateDocument, replaceDocument } = require('../lib/docStore');
const rackStore = require('../lib/rackStore');
const { getRacks, saveRacks, getRackRevision, normDcId } = rackStore;
const { placementProblem, validateRacks, isSideMounted } = require('../lib/rackLayout');
const { deviceMapOf, syncDeviceChanges } = require('../lib/rackDeviceSync');

const writeRoles = checkRole(['SuperAdmin', 'Operator']);
const superAdminOnly = checkRole(['SuperAdmin']);

function deleteDcAssociatedData(dcId, username) {
    syncDeviceChanges(deviceMapOf(getRacks(dcId)), {}, username);
    // Removes the rack document from the DB and the RAM cache, plus the DC's revision entry
    rackStore.deleteRacks(dcId);
}

// Helper to read dataCenters
function getDataCenters() {
    const defaultDC = [{
        id: 'default',
        name: 'Default Data Center',
        address: '',
        contact: '',
        contactNumber: '',
        acl: []
    }];
    const dcs = readDataSync('data_center/datacenters.json', defaultDC);
    return Array.isArray(dcs) ? dcs : defaultDC;
}

// Helper to write dataCenters
function saveDataCenters(data) {
    writeDataSync('data_center/datacenters.json', data);
}

// Fields the Data Center forms (DataCenters.jsx / ServerRack.jsx) edit. Computed fields (usedRacks) are never stored.
const DC_STRING_FIELDS = ['name', 'address', 'contact', 'contactNumber', 'emergencyHotline', 'certifications'];
const DC_NUMBER_FIELDS = ['totalRacks', 'powerCapacity'];
const DC_ORDER_FIELDS = { rackOrder: 'asc', rowOrder: 'asc', uOrder: 'desc' };
const DC_COMPUTED_FIELDS = ['usedRacks'];

/** Whitelisted, normalised copy of the DC fields present in `body`. */
function pickDcFields(body) {
    const out = {};
    const src = body && typeof body === 'object' ? body : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
    DC_STRING_FIELDS.forEach(k => {
        if (has(k)) out[k] = src[k] === null || src[k] === undefined ? '' : String(src[k]);
    });
    if (has('name')) out.name = out.name.trim();
    DC_NUMBER_FIELDS.forEach(k => {
        if (!has(k)) return;
        const v = src[k];
        const n = Number(v);
        out[k] = v === '' || v === null || v === undefined || !Number.isFinite(n) ? '' : n;
    });
    Object.entries(DC_ORDER_FIELDS).forEach(([k, def]) => {
        if (has(k)) out[k] = src[k] === 'asc' || src[k] === 'desc' ? src[k] : def;
    });
    if (has('acl')) {
        out.acl = (Array.isArray(src.acl) ? src.acl : [])
            .filter(p => p && typeof p === 'object')
            .map(p => ({ name: p.name == null ? '' : String(p.name), phone: p.phone == null ? '' : String(p.phone) }));
    }
    return out;
}

function stripComputed(dc) {
    const copy = { ...dc };
    DC_COMPUTED_FIELDS.forEach(k => delete copy[k]);
    return copy;
}

function newDcRecord(id, fields) {
    return {
        id,
        name: fields.name,
        address: '',
        contact: '',
        contactNumber: '',
        acl: [],
        ...fields
    };
}

function dcExists(dcId) {
    const id = normDcId(dcId);
    return id === 'default' || getDataCenters().some(dc => dc && dc.id === id);
}

function dcNameOf(dcId) {
    const id = normDcId(dcId);
    return getDataCenters().find(d => d && d.id === id)?.name || id;
}

// Helper to read issues
function getIssues() {
    const issues = readDataSync('data_center/hw_issues.json', []);
    return Array.isArray(issues) ? issues : [];
}

// Helper to write issues
function saveIssues(data) {
    writeDataSync('data_center/hw_issues.json', data);
}

// Spare parts: `quantity` is the one stock field; legacy `qty` / `stock` are folded into it on read
function finiteNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
}

function normalizeSpareItem(item) {
    const { qty, stock, ...rest } = item || {};
    const q = finiteNumber(rest.quantity) ?? finiteNumber(qty) ?? finiteNumber(stock) ?? 0;
    return {
        ...rest,
        quantity: Math.max(0, Math.floor(q)),
        history: Array.isArray(rest.history) ? rest.history : []
    };
}

const DEFAULT_SPARE_CATEGORIES = ['RAM', 'SSD', 'HDD', 'Fan', 'Power Supply', 'Cable'];

function getSpareParts() {
    const raw = readDataSync('data_center/spare_parts.json', null);
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        ...data,
        categories: Array.isArray(data.categories) ? data.categories : [...DEFAULT_SPARE_CATEGORIES],
        items: (Array.isArray(data.items) ? data.items : []).filter(i => i && typeof i === 'object').map(normalizeSpareItem)
    };
}

function saveSpareParts(data) {
    writeDataSync('data_center/spare_parts.json', {
        ...data,
        items: (data.items || []).map(normalizeSpareItem)
    });
}

const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;

/**
 * Applies a stock movement to `item` in place (no save). Returns an error message or null.
 */
function applyStockMovement(item, { type, qty, note, username }) {
    if (type !== 'IN' && type !== 'OUT') return "type must be 'IN' or 'OUT'";
    if (!isPositiveInt(qty)) return 'qty must be a positive integer';
    if (type === 'OUT' && qty > item.quantity) {
        return `Insufficient stock for "${item.name}": ${item.quantity} on hand, ${qty} requested`;
    }
    item.quantity = type === 'IN' ? item.quantity + qty : item.quantity - qty;
    item.history = [...(item.history || []), {
        date: new Date().toISOString(),
        type,
        qty,
        note: note == null ? '' : String(note),
        user: username
    }];
    return null;
}

/**
 * Hardware issue spare-part usage. Validates and, when the usage is new for this issue, deducts the stock
 * (in the returned spare-part data, not saved) and records it on the issue. Idempotent per usageId.
 * Returns { error } or { spareData|null } — spareData is set when the stock changed and must be saved.
 */
function applyIssueSparePartUsage(issue, usage, username) {
    if (!usage || typeof usage !== 'object' || !usage.partId) return { spareData: null };
    const qty = typeof usage.qty === 'string' ? parseInt(usage.qty, 10) : usage.qty;
    if (!isPositiveInt(qty)) return { error: 'Spare part quantity must be a positive integer' };
    const usageId = typeof usage.usageId === 'string' && usage.usageId.trim()
        ? usage.usageId.trim().slice(0, 100)
        : crypto.randomUUID();

    const usages = Array.isArray(issue.sparePartUsages) ? issue.sparePartUsages : [];
    if (usages.some(u => u && u.usageId === usageId)) return { spareData: null }; // already deducted

    const spareData = getSpareParts();
    const item = spareData.items.find(i => i.id === usage.partId);
    if (!item) return { error: `Spare part not found: ${usage.partId}` };

    const err = applyStockMovement(item, { type: 'OUT', qty, note: `Hardware Issue ${issue.id}`, username });
    if (err) return { error: err };

    const at = new Date().toISOString();
    issue.sparePartUsages = [...usages, { usageId, partId: item.id, qty, at, user: username }];
    issue.processNotes = [{
        timestamp: new Date().toLocaleString(),
        user: 'System',
        status: 'Spare Part Used',
        note: `Repaired using Spare Part: ${item.name} (Qty: ${qty})`
    }, ...(Array.isArray(issue.processNotes) ? issue.processNotes : [])];
    return { spareData, item, qty };
}

// Helper for contracts
function getContracts() {
    return readDataSync('data_center/contracts.json', []);
}

// Synchronous read -> change -> save callers only (no await in between); the upload route merges via mutateDocument
function saveContracts(data) {
    replaceDocument('data_center/contracts.json', data, { defaultValue: [] });
}

router.use(requireAuth);
// Data Center screens (+ the Home contract / spare-part banners) -> 'dataCenter'. The Network Device screen
// also reads the data-center and rack lists (GET /datacenters, GET /?dcId=, GET /revision) to place a device -> either key.
const dataCenterGate = checkFeature('dataCenter');
const sharedRackReadGate = checkAnyFeature('dataCenter', 'networkDevice');
function isSharedRackRead(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const p = String(req.path || '').toLowerCase().replace(/(.)\/$/, '$1');
    return p === '/' || p === '/datacenters' || p === '/revision';
}
router.use((req, res, next) => (isSharedRackRead(req) ? sharedRackReadGate : dataCenterGate)(req, res, next));

// Data Center Routes
router.get('/datacenters', (req, res) => {
    let dcs = getDataCenters();
    dcs = dcs.map(dc => {
        const racks = getRacks(dc.id);
        const usedRacks = racks.filter(r => !r.isBack && Array.isArray(r.devices) && r.devices.length > 0).length;
        return { ...dc, usedRacks };
    });
    res.json(dcs);
});

// Legacy whole-list save (stale clients): upsert only — a DC missing from the array is never deleted.
router.post('/datacenters', writeRoles, (req, res) => {
    try {
        const dcs = req.body;
        if (!Array.isArray(dcs)) return res.status(400).json({ error: 'Payload must be an array' });

        const stored = getDataCenters().map(stripComputed);
        let created = 0;
        let updated = 0;
        for (const dc of dcs) {
            if (!dc || typeof dc !== 'object' || typeof dc.id !== 'string' || !dc.id.trim()) {
                return res.status(400).json({ error: 'Every data center needs an id' });
            }
            const fields = pickDcFields(dc);
            if (Object.prototype.hasOwnProperty.call(fields, 'name') && !fields.name) {
                return res.status(400).json({ error: 'Data center name is required' });
            }
            const idx = stored.findIndex(s => s && s.id === dc.id);
            if (idx !== -1) {
                stored[idx] = { ...stored[idx], ...fields };
                updated++;
            } else {
                if (!fields.name) return res.status(400).json({ error: 'Data center name is required' });
                stored.push(newDcRecord(dc.id, fields));
                created++;
            }
        }

        if (created + updated > 0) {
            saveDataCenters(stored);
            auditLog(req.user.username, 'Data Centers', `Updated Datacenters configuration (legacy save: ${created} added, ${updated} updated)`);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/datacenters/item', writeRoles, (req, res) => {
    try {
        const fields = pickDcFields(req.body);
        if (!fields.name) return res.status(400).json({ error: 'Data center name is required' });

        const dcs = getDataCenters().map(stripComputed);
        const id = `dc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const dc = newDcRecord(id, fields);
        dcs.push(dc);
        saveDataCenters(dcs);
        auditLog(req.user.username, 'Data Centers', `Added Datacenter: ${dc.name} (${id})`);
        res.json({ success: true, dataCenter: dc });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/datacenters/:dcId', writeRoles, (req, res) => {
    try {
        const { dcId } = req.params;
        const dcs = getDataCenters().map(stripComputed);
        const idx = dcs.findIndex(dc => dc && dc.id === dcId);
        if (idx === -1) return res.status(404).json({ error: 'Data center not found' });

        const fields = pickDcFields(req.body);
        if (Object.prototype.hasOwnProperty.call(fields, 'name') && !fields.name) {
            return res.status(400).json({ error: 'Data center name is required' });
        }
        dcs[idx] = { ...dcs[idx], ...fields, id: dcId };
        saveDataCenters(dcs);
        auditLog(req.user.username, 'Data Centers', `Updated Datacenter: ${dcs[idx].name} (${dcId})`);
        res.json({ success: true, dataCenter: dcs[idx] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/datacenters/:dcId', superAdminOnly, (req, res) => {
    try {
        const { dcId } = req.params;
        if (dcId === 'default') return res.status(400).json({ error: 'Cannot delete default DC' });

        const dcs = getDataCenters();
        const dc = dcs.find(d => d && d.id === dcId);
        if (!dc) return res.status(404).json({ error: 'Data center not found' });

        const confirmName = (req.body && req.body.confirmName !== undefined) ? req.body.confirmName : req.query.confirmName;
        if (typeof confirmName !== 'string' || confirmName !== dc.name) {
            return res.status(400).json({ error: 'confirmName must match the data center name exactly' });
        }

        saveDataCenters(dcs.filter(d => d && d.id !== dcId).map(stripComputed));
        deleteDcAssociatedData(dcId, req.user.username);

        auditLog(req.user.username, 'Data Centers', `Deleted Datacenter: ${dc.name} (${dcId})`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rack Routes
function sendRevisionHeader(res, revision) {
    res.set('X-Rack-Revision', String(revision));
    res.set('Access-Control-Expose-Headers', 'X-Rack-Revision');
}

router.get('/', (req, res) => {
    const { dcId } = req.query;
    sendRevisionHeader(res, getRackRevision(dcId));
    res.json(getRacks(dcId));
});

router.get('/revision', (req, res) => {
    res.json({ revision: getRackRevision(req.query.dcId) });
});

// Client revision from ?rev= or If-Match. undefined = missing, NaN = malformed.
function clientRevision(req) {
    let raw = req.query.rev;
    if (raw === undefined || raw === '') raw = req.get('If-Match');
    if (raw === undefined || raw === null || raw === '') return undefined;
    const n = Number(String(raw).replace(/^W\//, '').replace(/"/g, '').trim());
    return Number.isInteger(n) && n >= 0 ? n : NaN;
}

// Shared precondition of rack writes; sends the error response and returns false when the write must stop.
function checkRackWrite(req, res) {
    const { dcId } = req.query;
    if (!dcExists(dcId)) {
        res.status(404).json({ error: `Data center not found: ${dcId}` });
        return false;
    }
    const rev = clientRevision(req);
    if (rev === undefined) {
        res.status(428).json({ error: 'Rack revision required (?rev= or If-Match)' });
        return false;
    }
    const current = getRackRevision(dcId);
    if (Number.isNaN(rev)) {
        res.status(400).json({ error: 'Invalid rack revision', revision: current });
        return false;
    }
    if (rev !== current) {
        res.status(409).json({ error: '資料已被其他人修改，請重新載入', revision: current });
        return false;
    }
    return true;
}

router.post('/', writeRoles, (req, res) => {
    try {
        const { dcId } = req.query;
        const racks = req.body;
        if (!Array.isArray(racks)) {
            return res.status(400).json({ error: 'Payload must be an array of racks' });
        }
        if (racks.length === 0 && req.query.confirm !== 'true') return res.status(400).json({ error: 'Empty array requires ?confirm=true' });
        if (!checkRackWrite(req, res)) return;

        const oldRacks = getRacks(dcId);
        const invalid = validateRacks(racks, oldRacks);
        if (invalid) return res.status(400).json({ error: invalid });

        syncDeviceChanges(deviceMapOf(oldRacks), deviceMapOf(racks), req.user.username);

        const revision = saveRacks(dcId, racks);
        auditLog(req.user.username, 'Data Centers', `Saved Rack Configuration for DC: ${dcNameOf(dcId)}`);
        res.json({ success: true, revision });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch('/', writeRoles, (req, res) => {
    try {
        const { dcId } = req.query;
        const patchRacks = req.body;
        if (!Array.isArray(patchRacks)) {
            return res.status(400).json({ error: 'Payload must be an array of rack updates' });
        }
        if (!checkRackWrite(req, res)) return;

        const oldRacks = getRacks(dcId);
        const patches = new Map();
        for (const patch of patchRacks) {
            if (!patch || typeof patch !== 'object' || typeof patch.id !== 'string' || !patch.id) {
                return res.status(400).json({ error: 'Every rack update needs an id' });
            }
            if (!oldRacks.some(r => r && r.id === patch.id)) {
                return res.status(400).json({ error: `Unknown rack id: ${patch.id}` });
            }
            patches.set(patch.id, patch);
        }

        const racks = oldRacks.map(r => (r && patches.has(r.id) ? { ...r, ...patches.get(r.id) } : r));
        const invalid = validateRacks(racks, oldRacks);
        if (invalid) return res.status(400).json({ error: invalid });

        syncDeviceChanges(deviceMapOf(oldRacks), deviceMapOf(racks), req.user.username);

        const revision = saveRacks(dcId, racks);
        const names = racks.filter(r => r && patches.has(r.id)).map(r => r.name || r.id).join(', ');
        auditLog(req.user.username, 'Data Centers', `Updated Racks [${names}] in DC: ${dcNameOf(dcId)}`);
        res.json({ success: true, revision });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function getSplitLocation(rack, u) {
    if (!rack) return `U${u}`;
    if (rack.isSplitDesign) {
        if (u > rack.lowerU) {
            return `Up U${u - rack.lowerU} (U${u})`;
        }
        return `Down U${u} (U${u})`;
    }
    return `U${u}`;
}

// Move / Migrate Device between Racks / U Slots (server-atomic: no client revision needed)
router.post('/move-device', writeRoles, (req, res) => {
    try {
        const { dcId, targetDcId, deviceId, sourceRackId, targetRackId, targetU } = req.body;
        const srcDc = normDcId(dcId);
        const tgtDc = targetDcId ? normDcId(targetDcId) : srcDc;
        const newU = parseInt(targetU, 10);

        if (!deviceId || !sourceRackId || !targetRackId || isNaN(newU) || newU < 1) {
            return res.status(400).json({ error: 'Missing required parameters (deviceId, sourceRackId, targetRackId, targetU)' });
        }
        if (!dcExists(srcDc)) return res.status(404).json({ error: `Data center not found: ${srcDc}` });
        if (!dcExists(tgtDc)) return res.status(404).json({ error: `Data center not found: ${tgtDc}` });

        const sourceRacks = getRacks(srcDc);
        const targetRacks = srcDc === tgtDc ? sourceRacks : getRacks(tgtDc);

        const sourceRack = sourceRacks.find(r => r.id === sourceRackId);
        const targetRack = targetRacks.find(r => r.id === targetRackId);

        if (!sourceRack) return res.status(404).json({ error: `Source rack ${sourceRackId} not found` });
        if (!targetRack) return res.status(404).json({ error: `Target rack ${targetRackId} not found` });

        const devIndex = (sourceRack.devices || []).findIndex(d => d.id === deviceId);
        if (devIndex === -1) {
            return res.status(404).json({ error: 'Device not found in source rack' });
        }

        const device = sourceRack.devices[devIndex];
        const oldU = device.startU;
        const oldLocation = getSplitLocation(sourceRack, oldU);
        const newLocation = getSplitLocation(targetRack, newU);

        const sizeU = parseInt(device.sizeU, 10) || 1;
        const problem = placementProblem(targetRack, {
            startU: newU,
            sizeU,
            sideMounted: isSideMounted(device),
            excludeId: sourceRackId === targetRackId && srcDc === tgtDc ? deviceId : null,
        }, targetRack.devices);
        if (problem) {
            return res.status(400).json({ error: `Target rack "${targetRack.name || targetRack.id}": ${problem}` });
        }

        // Remove from source rack
        sourceRack.devices.splice(devIndex, 1);

        // Update device startU and insert into target rack
        device.startU = newU;
        if (!targetRack.devices) targetRack.devices = [];
        targetRack.devices.push(device);

        const revision = saveRacks(srcDc, sourceRacks);
        let targetRevision;
        if (srcDc !== tgtDc) {
            targetRevision = saveRacks(tgtDc, targetRacks);
        }

        const srcDcName = dcNameOf(srcDc);
        const tgtDcName = dcNameOf(tgtDc);
        const devLabel = device.hostname || device.name || device.type || deviceId;

        const dcStr = srcDc === tgtDc ? `[${srcDcName}]` : `[${srcDcName}] -> [${tgtDcName}]`;
        const auditMsg = `Moved Device "${devLabel}" in ${dcStr} from Rack "${sourceRack.name}" (${oldLocation}) to Rack "${targetRack.name}" (${newLocation})`;

        auditLog(req.user.username, 'Data Centers', auditMsg);

        const body = { success: true, message: auditMsg, racks: sourceRacks, revision };
        if (targetRevision !== undefined) body.targetRevision = targetRevision;
        res.json(body);
    } catch (err) {
        console.error('[Rack] Failed to move device:', err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/issues', (req, res) => {
    res.json(getIssues());
});

router.post('/issues/single', writeRoles, (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const { sparePartUsage, sparePartUsages, id, ...fields } = body;
        const issues = getIssues();
        // A retried create (response lost) carries the same usageId: return the issue already created
        const retryUsageId = sparePartUsage && typeof sparePartUsage.usageId === 'string' ? sparePartUsage.usageId.trim() : '';
        if (retryUsageId) {
            const existing = issues.find(i => i && Array.isArray(i.sparePartUsages) && i.sparePartUsages.some(u => u && u.usageId === retryUsageId));
            if (existing) return res.json({ success: true, issue: existing, duplicate: true });
        }
        let issueId = typeof id === 'string' && id.trim() ? id.trim() : `hw-${Date.now()}`;
        if (issues.some(i => i && i.id === issueId)) issueId = `hw-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const issue = { ...fields, id: issueId };

        const usage = applyIssueSparePartUsage(issue, sparePartUsage, req.user.username);
        if (usage.error) return res.status(400).json({ error: usage.error });

        if (usage.spareData) {
            saveSpareParts(usage.spareData);
            auditLog(req.user.username, 'Spare Parts', `Deducted ${usage.qty}x ${usage.item.name} for Hardware Issue ${issue.id}`);
        }
        issues.push(issue);
        saveIssues(issues);
        auditLog(req.user.username, 'Hardware Issues', `Reported Issue: ${issue.id}`);
        res.json({ success: true, issue });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/issues/:id', writeRoles, (req, res) => {
    try {
        const { id } = req.params;
        const issues = getIssues();
        const index = issues.findIndex(i => i && i.id === id);
        if (index === -1) return res.status(404).json({ error: 'Issue not found' });

        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        // id and the recorded spare-part usages are server-owned
        const { sparePartUsage, sparePartUsages, id: _ignoredId, ...updateData } = body;
        const issue = { ...issues[index], ...updateData, id };
        if (!Array.isArray(updateData.processNotes)) issue.processNotes = issues[index].processNotes || [];

        const usage = applyIssueSparePartUsage(issue, sparePartUsage, req.user.username);
        if (usage.error) return res.status(400).json({ error: usage.error });

        if (usage.spareData) {
            saveSpareParts(usage.spareData);
            auditLog(req.user.username, 'Spare Parts', `Deducted ${usage.qty}x ${usage.item.name} for Hardware Issue ${id}`);
        }
        issues[index] = issue;
        saveIssues(issues);
        auditLog(req.user.username, 'Hardware Issues', `Updated Issue: ${id}`);
        res.json({ success: true, issue });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/issues/:id', writeRoles, (req, res) => {
    try {
        const { id } = req.params;
        let issues = getIssues();
        issues = issues.filter(i => i.id !== id);
        saveIssues(issues);
        auditLog(req.user.username, 'Hardware Issues', `Deleted Issue: ${id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/spare-parts', (req, res) => {
    res.json(getSpareParts());
});

function cleanCategories(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const c of list) {
        if (typeof c !== 'string') return null;
        const v = c.trim();
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}

// Legacy whole-document save (stale clients): only the categories are taken; items change via the item endpoints.
router.post('/spare-parts', writeRoles, (req, res) => {
    try {
        const categories = cleanCategories(req.body && req.body.categories);
        if (!categories) return res.status(400).json({ error: 'categories must be an array of strings' });
        const data = getSpareParts();
        data.categories = categories;
        saveSpareParts(data);
        auditLog(req.user.username, 'Data Centers', 'Updated Spare Parts Categories');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/spare-parts/categories', writeRoles, (req, res) => {
    try {
        const categories = cleanCategories(req.body && req.body.categories);
        if (!categories) return res.status(400).json({ error: 'categories must be an array of strings' });
        const data = getSpareParts();
        data.categories = categories;
        saveSpareParts(data);
        auditLog(req.user.username, 'Data Centers', 'Updated Spare Parts Categories');
        res.json({ success: true, categories });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Metadata the spare-part form edits (SpareParts.jsx); quantity / history change only via /stock
const SPARE_STRING_FIELDS = ['name', 'category', 'model', 'spec', 'location'];

function pickSpareFields(body, { partial }) {
    const src = body && typeof body === 'object' ? body : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
    const out = {};
    for (const k of SPARE_STRING_FIELDS) {
        if (has(k)) out[k] = src[k] === null || src[k] === undefined ? '' : String(src[k]);
    }
    if (has('name')) out.name = out.name.trim();
    if (has('category')) out.category = out.category.trim();
    if ((!partial || has('name')) && !out.name) return { error: 'name is required' };
    if ((!partial || has('category')) && !out.category) return { error: 'category is required' };
    if (has('minStock')) {
        const n = finiteNumber(src.minStock);
        if (n === null || !Number.isInteger(n) || n < 0) return { error: 'minStock must be an integer >= 0' };
        out.minStock = n;
    }
    if (has('unitPrice')) {
        const n = src.unitPrice === '' || src.unitPrice === null ? 0 : finiteNumber(src.unitPrice);
        if (n === null || n < 0) return { error: 'unitPrice must be a number >= 0' };
        out.unitPrice = n;
    }
    return { fields: out };
}

router.post('/spare-parts/items', writeRoles, (req, res) => {
    try {
        const picked = pickSpareFields(req.body, { partial: false });
        if (picked.error) return res.status(400).json({ error: picked.error });
        const rawQty = req.body && req.body.quantity !== undefined ? finiteNumber(req.body.quantity) : 0;
        if (rawQty === null || !Number.isInteger(rawQty) || rawQty < 0) {
            return res.status(400).json({ error: 'quantity must be an integer >= 0' });
        }

        const data = getSpareParts();
        const item = {
            id: `spare-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
            model: '',
            spec: '',
            location: '',
            minStock: 0,
            unitPrice: 0,
            ...picked.fields,
            quantity: rawQty,
            history: rawQty > 0
                ? [{ date: new Date().toISOString(), type: 'IN', qty: rawQty, note: 'Initial stock', user: req.user.username }]
                : []
        };
        data.items.push(item);
        saveSpareParts(data);
        auditLog(req.user.username, 'Spare Parts', `Added Spare Part: ${item.name} (Qty: ${rawQty})`);
        res.json({ success: true, item });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.patch('/spare-parts/:id', writeRoles, (req, res) => {
    try {
        const { id } = req.params;
        const data = getSpareParts();
        const index = data.items.findIndex(i => i.id === id);
        if (index === -1) return res.status(404).json({ error: 'Spare part not found' });

        // quantity / history / id are ignored here (stock moves go through /stock)
        const picked = pickSpareFields(req.body, { partial: true });
        if (picked.error) return res.status(400).json({ error: picked.error });

        data.items[index] = { ...data.items[index], ...picked.fields };
        saveSpareParts(data);
        auditLog(req.user.username, 'Spare Parts', `Updated Spare Part: ${data.items[index].name} (${id})`);
        res.json({ success: true, item: data.items[index] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/spare-parts/:id/stock', writeRoles, (req, res) => {
    try {
        const { id } = req.params;
        const { type, note } = req.body || {};
        const qty = req.body ? req.body.qty : undefined;
        const data = getSpareParts();
        const item = data.items.find(i => i.id === id);
        if (!item) return res.status(404).json({ error: 'Spare part not found' });

        const err = applyStockMovement(item, { type, qty, note, username: req.user.username });
        if (err) return res.status(400).json({ error: err });

        saveSpareParts(data);
        auditLog(req.user.username, 'Spare Parts', `Stock ${type} ${qty}x ${item.name} (now ${item.quantity})${note ? ` - ${note}` : ''}`);
        res.json({ success: true, item });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Contracts & Warranties Routes
router.get('/contracts', (req, res) => {
    res.json(getContracts());
});

router.post('/contracts', writeRoles, async (req, res) => {
    try {
        const { id, type, name, vendor, startDate, endDate, linkedDevices, licenseKey, serialNumber, seats, cost, currency, fileBase64, originalFileName, fileType } = req.body;

        let savedFileName = null;
        if (fileBase64 && originalFileName) {
            const base64DataStr = fileBase64.replace(/^data:([a-zA-Z0-9-+/.]+);base64,/, '');
            const buffer = Buffer.from(base64DataStr, 'base64');

            if (buffer.length > 5 * 1024 * 1024) {
                return res.status(400).json({ error: 'File size exceeds 5MB limit.' });
            }

            const hex = buffer.toString('hex', 0, 4).toUpperCase();
            const isPDF = hex.startsWith('25504446');
            const isPNG = hex.startsWith('89504E47');
            const isJPG = hex.startsWith('FFD8FF');
            const isDOCX = hex.startsWith('504B0304');

            if (!isPDF && !isPNG && !isJPG && !isDOCX) {
                return res.status(400).json({ error: 'Invalid file magic bytes. Only PDF, DOCX, PNG, and JPG are allowed.' });
            }

            if (!fs.existsSync(LICENSES_DIR)) fs.mkdirSync(LICENSES_DIR, { recursive: true });

            const cleanName = originalFileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            savedFileName = `${Date.now()}_${cleanName}`;
            const fullPath = path.join(LICENSES_DIR, savedFileName);

            fs.writeFileSync(fullPath, buffer);

            try {
                await execAsync(`clamscan "${fullPath}"`);
            } catch (scanErr) {
                if (scanErr.code === 1) {
                    fs.unlinkSync(fullPath);
                    return res.status(400).json({ error: 'Malware detected by ClamAV. Upload rejected.' });
                } else {
                    console.warn('[ClamAV] Scanner unavailable or failed to run:', scanErr.message);
                }
            }
        }

        // The virus scan above is awaited: the contract is merged by id into the CURRENT list (atomic read-modify-write),
        // so a contract saved / deleted meanwhile is not lost
        const contractId = id || `contract-${Date.now()}`;
        const saved = mutateDocument('data_center/contracts.json', (current) => {
            const idx = id ? current.findIndex(c => c.id === id) : -1;
            const prev = idx >= 0 ? current[idx] : null;
            const contractObj = {
                id: contractId,
                type, name, vendor, startDate, endDate, linkedDevices, licenseKey, serialNumber, seats, cost, currency,
                savedFileName: savedFileName || (prev ? prev.savedFileName : null),
                originalFileName: originalFileName || (prev ? prev.originalFileName : null),
                fileType: fileType || (prev ? prev.fileType : null)
            };
            if (idx >= 0) current[idx] = contractObj;
            else current.push(contractObj);
            return { contractObj, updated: idx >= 0 };
        }, { defaultValue: [], fnName: 'rack.saveContract', label: 'contracts' });
        auditLog(req.user.username, 'Contracts & Warranties', `${saved.updated ? 'Updated' : 'Added'} Contract: ${name}`);
        res.json({ success: true, contract: saved.contractObj });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/contracts/:id', writeRoles, (req, res) => {
    try {
        const { id } = req.params;
        let contracts = getContracts();
        const index = contracts.findIndex(c => c.id === id);

        if (index !== -1) {
            contracts[index].deletedAt = new Date().toISOString();
            saveContracts(contracts);
            auditLog(req.user.username, 'Contracts & Warranties', `Soft Deleted Contract ID: ${id}`);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/contracts/:id/force', superAdminOnly, (req, res) => {
    try {
        const { id } = req.params;
        let contracts = getContracts();
        const contract = contracts.find(c => c.id === id);

        if (contract && contract.savedFileName) {
            const filePath = path.join(LICENSES_DIR, contract.savedFileName);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }

        contracts = contracts.filter(c => c.id !== id);
        saveContracts(contracts);
        auditLog(req.user.username, 'Contracts & Warranties', `Permanently Deleted Contract ID: ${id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/contracts/:id/restore', writeRoles, (req, res) => {
    try {
        const { id } = req.params;
        let contracts = getContracts();
        const index = contracts.findIndex(c => c.id === id);

        if (index !== -1) {
            delete contracts[index].deletedAt;
            saveContracts(contracts);
            auditLog(req.user.username, 'Contracts & Warranties', `Restored Contract ID: ${id}`);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/contracts/download/:filename', (req, res) => {
    try {
        const { filename } = req.params;
        const safeFilename = path.basename(filename);

        const ext = path.extname(safeFilename).toLowerCase();
        const allowedExts = ['.pdf', '.png', '.jpg', '.jpeg', '.docx'];
        if (!allowedExts.includes(ext)) {
            return res.status(403).json({ error: 'File type not permitted for download.' });
        }

        const filePath = path.join(LICENSES_DIR, safeFilename);
        if (fs.existsSync(filePath)) {
            res.download(filePath);
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
