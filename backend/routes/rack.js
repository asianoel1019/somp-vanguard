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
const { mutateDocument } = require('../lib/docStore');
const rackStore = require('../lib/rackStore');
const { getRacks, saveRacks, getRackRevision, normDcId } = rackStore;
const { placementProblem, validateRacks, isSideMounted } = require('../lib/rackLayout');
const { deviceMapOf, syncDeviceChanges } = require('../lib/rackDeviceSync');
const contractModel = require('../lib/contractModel');
const spareModel = require('../lib/sparePartModel');

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

// ---- Hardware issue fields --------------------------------------------------------------------------------------
// Editable fields and their length limits. Everything else (id, timeline, spare-part usages, created / updated /
// closed times) is owned by the server; the timeline only grows, and only through the server.
const ISSUE_TEXT_FIELDS = {
    date: 10, datacenter: 200, deviceName: 200, deviceId: 100, rackId: 100, sn: 100, rackLoc: 200, failedParts: 1000, reporter: 100, partsInfo: 2000,
    assignee: 100, rmaNumber: 100, dueDate: 10,
};
const ISSUE_URGENCIES = ['H', 'M', 'L'];
const ISSUE_STATUSES = ['Open', 'Processing', 'Closed'];
const ISSUE_RESOLUTIONS = ['Part replaced', 'Vendor repair / RMA', 'Firmware / configuration', 'No fault found', 'Device retired', 'Other'];
const URGENCY_LABELS = { H: 'High', M: 'Medium', L: 'Low' };
const ISSUE_NOTE_MAX = 2000;

/** The stored timeline as entries; very old issues kept it as text lines "[time] status: note". */
function timelineOf(issue) {
    const t = issue && issue.processNotes;
    if (Array.isArray(t)) return t;
    if (typeof t !== 'string' || !t.trim()) return [];
    return t.split(/\r?\n/).filter(Boolean).map(line => {
        const m = line.match(/^\[(.*?)\] (.*?): (.*)$/);
        return m ? { timestamp: m[1], status: m[2], note: m[3], user: 'System' } : { timestamp: '', status: 'Legacy Note', note: line, user: 'System' };
    });
}

/** One timeline entry, stamped here (ISO time, the signed-in user). */
function noteEntry(user, status, note) {
    return { timestamp: new Date().toISOString(), user: user || 'Unknown', status, note };
}

/**
 * Validates the editable fields of a create / update body. Unknown and server-owned keys are dropped.
 * create: deviceName is required; date, reporter, urgency and status get defaults.
 * -> { error } or { fields }
 */
function cleanIssueFields(body, { create = false, username = '' } = {}) {
    const fields = {};
    for (const [key, max] of Object.entries(ISSUE_TEXT_FIELDS)) {
        if (body[key] === undefined || body[key] === null) continue;
        if (typeof body[key] !== 'string' && typeof body[key] !== 'number') return { error: `${key} must be text` };
        const v = String(body[key]).trim();
        if (v.length > max) return { error: `${key} is limited to ${max} characters` };
        fields[key] = v;
    }
    for (const key of ['date', 'dueDate']) {
        if (fields[key] && !/^\d{4}-\d{2}-\d{2}$/.test(fields[key])) return { error: `${key} must be YYYY-MM-DD` };
    }
    if (body.resolution !== undefined && body.resolution !== null && body.resolution !== '') {
        if (!ISSUE_RESOLUTIONS.includes(body.resolution)) return { error: `resolution must be one of ${ISSUE_RESOLUTIONS.join(', ')}` };
        fields.resolution = body.resolution;
    } else if (body.resolution === '') fields.resolution = '';
    if (body.urgency !== undefined && body.urgency !== null) {
        if (!ISSUE_URGENCIES.includes(body.urgency)) return { error: `urgency must be one of ${ISSUE_URGENCIES.join(', ')}` };
        fields.urgency = body.urgency;
    }
    if (body.status !== undefined && body.status !== null) {
        if (!ISSUE_STATUSES.includes(body.status)) return { error: `status must be one of ${ISSUE_STATUSES.join(', ')}` };
        fields.status = body.status;
    }
    if (create) {
        if (!fields.deviceName) return { error: 'deviceName is required' };
        if (!fields.date) fields.date = new Date().toISOString().slice(0, 10);
        if (!fields.reporter) fields.reporter = username || '';
        if (!fields.urgency) fields.urgency = 'M';
        if (!fields.status) fields.status = 'Open';
    }
    return { fields };
}

/** Audit / Telegram text of an issue: what, where, how urgent (High is flagged). */
function issueSummary(issue) {
    const where = [issue.datacenter, issue.rackLoc].filter(Boolean).join(', ');
    const flag = issue.urgency === 'H' ? '🚨 ' : '';
    return `${flag}${issue.deviceName || '?'}${where ? ` (${where})` : ''}: ${issue.failedParts || 'no part given'}; urgency ${URGENCY_LABELS[issue.urgency] || issue.urgency || '-'}`
        + (issue.assignee ? `; assignee ${issue.assignee}` : '');
}

function closedSummary(issue, note) {
    const start = Date.parse(issue.createdAt || issue.date || '');
    const days = Number.isFinite(start) && issue.closedAt ? Math.max(0, Math.round((Date.parse(issue.closedAt) - start) / 86400000)) : null;
    return `${issue.deviceName || '?'}${issue.datacenter ? ` (${issue.datacenter})` : ''}`
        + (issue.resolution ? `; resolution ${issue.resolution}` : '')
        + (days !== null ? `; open ${days} day(s)` : '')
        + (note ? `; ${String(note).slice(0, 200)}` : '');
}

/** Moves an issue to `to`, recording who and when on the timeline; keeps closedAt in step. */
function setIssueStatus(issue, to, username, note) {
    const from = issue.status || 'Open';
    issue.status = to;
    if (to === 'Closed') { if (from !== 'Closed' || !issue.closedAt) issue.closedAt = new Date().toISOString(); } else { delete issue.closedAt; delete issue.resolution; }
    if (from !== to || note) {
        const text = note || `Status changed from ${from} to ${to}`;
        issue.processNotes = [noteEntry(username, to, text), ...timelineOf(issue)];
    }
}

// Spare parts: rules in lib/sparePartModel.js. The document is read, changed and saved synchronously (web only).
const { finiteNumber, isPositiveInt, normalizeSpareItem, applyStockMovement } = spareModel;

function getSpareParts() {
    const raw = readDataSync('data_center/spare_parts.json', null);
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
        ...data,
        categories: Array.isArray(data.categories) ? data.categories : [...spareModel.DEFAULT_CATEGORIES],
        items: (Array.isArray(data.items) ? data.items : []).filter(i => i && typeof i === 'object').map(normalizeSpareItem)
    };
}

function saveSpareParts(data) {
    writeDataSync('data_center/spare_parts.json', {
        ...data,
        items: (data.items || []).map(normalizeSpareItem)
    });
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

    const err = applyStockMovement(item, { type: 'OUT', qty, reason: 'Repair', note: `Hardware Issue ${issue.id}`, issueId: issue.id, username });
    if (err) return { error: err };
    item.updatedAt = new Date().toISOString();
    item.updatedBy = username;

    const at = new Date().toISOString();
    // The part name is kept on the issue, so a part deleted later still reads by name
    issue.sparePartUsages = [...usages, { usageId, partId: item.id, partName: item.name, qty, at, user: username }];
    issue.processNotes = [
        noteEntry(username, 'Spare Part Used', `Repaired using Spare Part: ${item.name} (Qty: ${qty})`),
        ...timelineOf(issue),
    ];
    return { spareData, item, qty };
}

// Helper for contracts (writes: mutateContracts, below the contract routes)
function getContracts() {
    const list = readDataSync('data_center/contracts.json', []);
    return Array.isArray(list) ? list : [];
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
        const { sparePartUsage } = body;
        const clean = cleanIssueFields(body, { create: true, username: req.user.username });
        if (clean.error) return res.status(400).json({ error: clean.error });
        const issues = getIssues();
        // A retried create (response lost) carries the same usageId: return the issue already created
        const retryUsageId = sparePartUsage && typeof sparePartUsage.usageId === 'string' ? sparePartUsage.usageId.trim() : '';
        if (retryUsageId) {
            const existing = issues.find(i => i && Array.isArray(i.sparePartUsages) && i.sparePartUsages.some(u => u && u.usageId === retryUsageId));
            if (existing) return res.json({ success: true, issue: existing, duplicate: true });
        }
        let issueId = `hw-${Date.now()}`;
        if (issues.some(i => i && i.id === issueId)) issueId = `hw-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const now = new Date().toISOString();
        const issue = { ...clean.fields, id: issueId, processNotes: [], createdBy: req.user.username, createdAt: now, updatedAt: now };
        if (issue.status === 'Closed') issue.closedAt = now;

        const usage = applyIssueSparePartUsage(issue, sparePartUsage, req.user.username);
        if (usage.error) return res.status(400).json({ error: usage.error });

        if (usage.spareData) {
            saveSpareParts(usage.spareData);
            auditLog(req.user.username, 'Spare Parts', `Deducted ${usage.qty}x ${usage.item.name} for Hardware Issue ${issue.id}`);
        }
        issues.push(issue);
        saveIssues(issues);
        auditLog(req.user.username, 'Hardware Issues', `Reported Issue ${issue.id}: ${issueSummary(issue)}`);
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
        const { sparePartUsage, expectedUpdatedAt } = body;
        // Saved by someone else since this form was opened: refuse instead of overwriting their changes
        const current = issues[index];
        if (expectedUpdatedAt && current.updatedAt && expectedUpdatedAt !== current.updatedAt) {
            return res.status(409).json({ error: 'This issue was changed by someone else. Reload it and apply your changes again.', issue: current });
        }
        const clean = cleanIssueFields(body, { username: req.user.username });
        if (clean.error) return res.status(400).json({ error: clean.error });
        // the timeline, the spare-part usages, the id and the times stay as stored
        const { status: newStatus, ...updateData } = clean.fields;
        const issue = { ...current, ...updateData, id, processNotes: timelineOf(current) };
        const statusChanged = newStatus && newStatus !== (current.status || 'Open');
        if (statusChanged) setIssueStatus(issue, newStatus, req.user.username);
        if (issue.status !== 'Closed') delete issue.resolution;
        issue.updatedAt = new Date().toISOString();

        const usage = applyIssueSparePartUsage(issue, sparePartUsage, req.user.username);
        if (usage.error) return res.status(400).json({ error: usage.error });

        if (usage.spareData) {
            saveSpareParts(usage.spareData);
            auditLog(req.user.username, 'Spare Parts', `Deducted ${usage.qty}x ${usage.item.name} for Hardware Issue ${id}`);
        }
        issues[index] = issue;
        saveIssues(issues);
        auditLog(req.user.username, 'Hardware Issues', statusChanged && issue.status === 'Closed'
            ? `Closed Issue ${id}: ${closedSummary(issue)}`
            : `Updated Issue ${id}${statusChanged ? ` (now ${issue.status})` : ''}: ${issueSummary(issue)}`);
        res.json({ success: true, issue });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Adds a timeline entry (time and user from the server). type: Note | Open | Processing | Closed (a status change).
router.post('/issues/:id/notes', writeRoles, (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const type = body.type === undefined ? 'Note' : body.type;
        if (type !== 'Note' && !ISSUE_STATUSES.includes(type)) return res.status(400).json({ error: `type must be Note or one of ${ISSUE_STATUSES.join(', ')}` });
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        if (!note) return res.status(400).json({ error: 'note is required' });
        if (note.length > ISSUE_NOTE_MAX) return res.status(400).json({ error: `note is limited to ${ISSUE_NOTE_MAX} characters` });

        const issues = getIssues();
        const index = issues.findIndex(i => i && i.id === id);
        if (index === -1) return res.status(404).json({ error: 'Issue not found' });
        const issue = { ...issues[index], processNotes: timelineOf(issues[index]) };

        const usage = applyIssueSparePartUsage(issue, body.sparePartUsage, req.user.username);
        if (usage.error) return res.status(400).json({ error: usage.error });
        if (body.resolution !== undefined && body.resolution !== null && body.resolution !== '') {
            if (type !== 'Closed') return res.status(400).json({ error: 'resolution is only set when closing' });
            if (!ISSUE_RESOLUTIONS.includes(body.resolution)) return res.status(400).json({ error: `resolution must be one of ${ISSUE_RESOLUTIONS.join(', ')}` });
        }
        if (type === 'Note') issue.processNotes = [noteEntry(req.user.username, 'General Note', note), ...issue.processNotes];
        else setIssueStatus(issue, type, req.user.username, note);
        if (type === 'Closed' && body.resolution) issue.resolution = body.resolution;
        issue.updatedAt = new Date().toISOString();

        if (usage.spareData) {
            saveSpareParts(usage.spareData);
            auditLog(req.user.username, 'Spare Parts', `Deducted ${usage.qty}x ${usage.item.name} for Hardware Issue ${id}`);
        }
        issues[index] = issue;
        saveIssues(issues);
        auditLog(req.user.username, 'Hardware Issues', type === 'Note'
            ? `Added a note to Issue ${id} (${issue.deviceName || '?'})`
            : type === 'Closed' ? `Closed Issue ${id}: ${closedSummary(issue, note)}` : `Set Issue ${id} to ${type}: ${issueSummary(issue)}`);
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
        if (v.length > 100) return null;
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}

/** Saves a new category list; a category that still has items cannot be dropped. -> error text or null */
function setSpareCategories(data, categories) {
    const used = [...new Set(data.items.map(i => i.category).filter(Boolean))];
    const dropped = used.filter(c => !categories.includes(c) && data.categories.includes(c));
    if (dropped.length) return `Category "${dropped[0]}" still has spare parts; move or delete them first`;
    data.categories = categories;
    return null;
}

const spareStamp = (item, username) => { item.updatedAt = new Date().toISOString(); item.updatedBy = username; };

// Legacy whole-document save (stale clients): only the categories are taken; items change via the item endpoints.
router.post('/spare-parts', writeRoles, (req, res) => {
    try {
        const categories = cleanCategories(req.body && req.body.categories);
        if (!categories) return res.status(400).json({ error: 'categories must be an array of strings' });
        const data = getSpareParts();
        const err = setSpareCategories(data, categories);
        if (err) return res.status(400).json({ error: err });
        saveSpareParts(data);
        auditLog(req.user.username, 'Spare Parts', 'Updated spare part categories');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/spare-parts/categories', writeRoles, (req, res) => {
    try {
        const categories = cleanCategories(req.body && req.body.categories);
        if (!categories) return res.status(400).json({ error: 'categories must be an array of names (up to 100 characters)' });
        const data = getSpareParts();
        const before = data.categories;
        const err = setSpareCategories(data, categories);
        if (err) return res.status(400).json({ error: err });
        saveSpareParts(data);
        const added = categories.filter(c => !before.includes(c));
        const removed = before.filter(c => !categories.includes(c));
        auditLog(req.user.username, 'Spare Parts', `Updated spare part categories${added.length ? `; added ${added.join(', ')}` : ''}${removed.length ? `; removed ${removed.join(', ')}` : ''}`);
        res.json({ success: true, categories });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Renames a category and moves its items with it (into an existing category: merged)
router.post('/spare-parts/categories/rename', writeRoles, (req, res) => {
    try {
        const from = typeof req.body?.from === 'string' ? req.body.from.trim() : '';
        const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
        if (!from || !to || to.length > 100) return res.status(400).json({ error: 'from and to are required (up to 100 characters)' });
        const data = getSpareParts();
        if (!data.categories.includes(from) && !data.items.some(i => i.category === from)) return res.status(404).json({ error: 'Category not found' });
        let moved = 0;
        for (const item of data.items) {
            if (item.category === from) { item.category = to; spareStamp(item, req.user.username); moved += 1; }
        }
        const list = data.categories.map(c => (c === from ? to : c));
        if (!list.includes(to)) list.push(to);
        data.categories = list.filter((c, idx) => list.indexOf(c) === idx);
        saveSpareParts(data);
        auditLog(req.user.username, 'Spare Parts', `Renamed category ${from} -> ${to} (${moved} part(s))`);
        res.json({ success: true, categories: data.categories, moved });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** A new item from a request body (validated), with its initial stock as the first movement. -> { error } or { item } */
function newSpareItem(body, username) {
    const picked = spareModel.cleanSpareFields(body, { partial: false });
    if (picked.error) return { error: picked.error };
    const rawQty = body && body.quantity !== undefined && body.quantity !== '' ? finiteNumber(body.quantity) : 0;
    if (rawQty === null || !Number.isInteger(rawQty) || rawQty < 0 || rawQty > 1e7) return { error: 'quantity must be an integer >= 0' };
    const now = new Date().toISOString();
    const item = normalizeSpareItem({
        id: `spare-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        model: '', spec: '', location: '', vendor: '', partNumber: '', compatibleWith: '', supplier: '', notes: '',
        condition: 'New', currency: 'TWD', minStock: 0, reorderQty: 0, unitPrice: 0,
        ...picked.fields,
        quantity: 0,
        createdAt: now, createdBy: username, updatedAt: now, updatedBy: username,
    });
    if (rawQty > 0) {
        const err = applyStockMovement(item, { type: 'IN', qty: rawQty, reason: 'Initial stock', note: '', serials: body.serials, username });
        if (err) return { error: err };
    }
    return { item };
}

router.post('/spare-parts/items', writeRoles, (req, res) => {
    try {
        const made = newSpareItem(req.body || {}, req.user.username);
        if (made.error) return res.status(400).json({ error: made.error });
        const data = getSpareParts();
        if (!data.categories.includes(made.item.category)) data.categories.push(made.item.category);
        data.items.push(made.item);
        saveSpareParts(data);
        auditLog(req.user.username, 'Spare Parts', `Added spare part: ${made.item.name} [${made.item.category}] (qty ${made.item.quantity})`);
        res.json({ success: true, item: made.item });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Several items at once (catalog picker): all or nothing
router.post('/spare-parts/items/bulk', writeRoles, (req, res) => {
    try {
        const list = req.body && Array.isArray(req.body.items) ? req.body.items : null;
        if (!list || !list.length || list.length > 200) return res.status(400).json({ error: 'items must be a list of 1 to 200 parts' });
        const made = [];
        for (let idx = 0; idx < list.length; idx++) {
            const r = newSpareItem(list[idx], req.user.username);
            if (r.error) return res.status(400).json({ error: `Part ${idx + 1}: ${r.error}` });
            r.item.id = `${r.item.id}-${idx}`;
            made.push(r.item);
        }
        const data = getSpareParts();
        for (const item of made) {
            if (!data.categories.includes(item.category)) data.categories.push(item.category);
            data.items.push(item);
        }
        saveSpareParts(data);
        auditLog(req.user.username, 'Spare Parts', `Added ${made.length} spare part(s) from the catalog: ${made.slice(0, 10).map(i => i.name).join(', ')}${made.length > 10 ? ', ...' : ''}`);
        res.json({ success: true, items: made });
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
        const current = data.items[index];
        const expected = req.body && req.body.expectedUpdatedAt;
        if (expected && (current.updatedAt || '') !== expected) {
            return res.status(409).json({ error: 'This spare part was changed by someone else. Reload it and apply your change again.', item: current });
        }

        // quantity / history / serials / id are ignored here (stock changes go through /stock and /count)
        const picked = spareModel.cleanSpareFields(req.body, { partial: true });
        if (picked.error) return res.status(400).json({ error: picked.error });

        data.items[index] = { ...current, ...picked.fields };
        spareStamp(data.items[index], req.user.username);
        if (picked.fields.category && !data.categories.includes(picked.fields.category)) data.categories.push(picked.fields.category);
        saveSpareParts(data);
        auditLog(req.user.username, 'Spare Parts', `Updated spare part: ${data.items[index].name} (${id})`);
        res.json({ success: true, item: data.items[index] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete: a part with stock left needs a SuperAdmin; issues that used it keep its name
router.delete('/spare-parts/:id', writeRoles, (req, res) => {
    try {
        const data = getSpareParts();
        const index = data.items.findIndex(i => i.id === req.params.id);
        if (index === -1) return res.status(404).json({ error: 'Spare part not found' });
        const item = data.items[index];
        if (item.quantity > 0 && req.user.role !== 'SuperAdmin') {
            return res.status(403).json({ error: `${item.quantity} still in stock: book them out first, or ask a SuperAdmin to delete the part` });
        }
        data.items.splice(index, 1);
        saveSpareParts(data);
        auditLog(req.user.username, 'Spare Parts', `Deleted spare part: ${item.name} [${item.category}]${item.quantity ? ` with ${item.quantity} in stock` : ''}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/spare-parts/:id/stock', writeRoles, (req, res) => {
    try {
        const { id } = req.params;
        const { type, note, reason, issueId, serials } = req.body || {};
        const qty = req.body ? req.body.qty : undefined;
        const data = getSpareParts();
        const item = data.items.find(i => i.id === id);
        if (!item) return res.status(404).json({ error: 'Spare part not found' });

        const err = applyStockMovement(item, { type, qty, reason, note, issueId, serials, username: req.user.username });
        if (err) return res.status(400).json({ error: err });
        spareStamp(item, req.user.username);

        saveSpareParts(data);
        const h = item.history.at(-1);
        auditLog(req.user.username, 'Spare Parts', `Stock ${type} ${qty}x ${item.name} (${h.reason}; now ${item.quantity})${h.note ? ` - ${h.note}` : ''}`);
        res.json({ success: true, item });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Stock count: the counted quantity replaces the stored one; the difference is recorded
router.post('/spare-parts/:id/count', writeRoles, (req, res) => {
    try {
        const data = getSpareParts();
        const item = data.items.find(i => i.id === req.params.id);
        if (!item) return res.status(404).json({ error: 'Spare part not found' });
        const { actual, note, serials } = req.body || {};
        const err = spareModel.applyStockCount(item, { actual, note, serials, username: req.user.username });
        if (err) return res.status(400).json({ error: err });
        spareStamp(item, req.user.username);
        saveSpareParts(data);
        const h = item.history.at(-1);
        auditLog(req.user.username, 'Spare Parts', `Stock count ${item.name}: ${h.before} -> ${h.after}${h.note ? ` - ${h.note}` : ''}`);
        res.json({ success: true, item });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---- Contracts & Warranties ---------------------------------------------------------------------------------------
// Fields are validated (lib/contractModel.js); the server owns id, file, created / updated stamps, trash and renewal
// links. A stale edit (expectedUpdatedAt) is refused with the current contract instead of overwriting it.
const CONTRACT_FILE_TYPES = [
    { ext: 'pdf', magic: '25504446', mime: 'application/pdf' },
    { ext: 'png', magic: '89504E47', mime: 'image/png' },
    { ext: 'jpg', magic: 'FFD8FF', mime: 'image/jpeg' },
    { ext: 'docx', magic: '504B0304', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
];
const CONTRACT_FILE_MAX = 5 * 1024 * 1024;

class ContractError extends Error {
    constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const contractLabel = (c) => `${c.name || '(unnamed)'}${c.vendor ? ` (${c.vendor})` : ''}, ${c.startDate || '?'} to ${c.endDate || '?'}`;

function mutateContracts(fn, fnName) {
    return mutateDocument('data_center/contracts.json', fn, { defaultValue: [], fnName, label: 'contracts' });
}

function removeLicenseFile(savedFileName) {
    if (!savedFileName) return;
    try {
        const filePath = path.join(LICENSES_DIR, path.basename(savedFileName));
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
        console.warn('[Contracts] Could not remove file:', err.message);
    }
}

/** Decodes, checks (size, type by content) and stores an uploaded file, then virus-scans it. -> file fields */
async function storeContractFile(fileBase64, originalFileName) {
    const buffer = Buffer.from(String(fileBase64).replace(/^data:[^;,]*;base64,/, ''), 'base64');
    if (!buffer.length) throw new ContractError('The file is empty.');
    if (buffer.length > CONTRACT_FILE_MAX) throw new ContractError('File size exceeds 5MB limit.');
    const hex = buffer.toString('hex', 0, 4).toUpperCase();
    const kind = CONTRACT_FILE_TYPES.find(t => hex.startsWith(t.magic));
    if (!kind) throw new ContractError('Only PDF, DOCX, PNG and JPG files are accepted.');

    if (!fs.existsSync(LICENSES_DIR)) fs.mkdirSync(LICENSES_DIR, { recursive: true });
    // The stored name is ASCII with the extension of the detected type; the original name is kept for display
    const savedFileName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${kind.ext}`;
    const fullPath = path.join(LICENSES_DIR, savedFileName);
    fs.writeFileSync(fullPath, buffer);
    try {
        await execAsync(`clamscan "${fullPath}"`);
    } catch (scanErr) {
        // Exit code 1 is also what cmd.exe returns for a missing command: only a scan report naming a hit counts
        const out = String(scanErr.stdout || '');
        if (scanErr.code === 1 && (/\bFOUND\b/.test(out) || /Infected files:\s*[1-9]/.test(out))) {
            fs.unlinkSync(fullPath);
            throw new ContractError('Malware detected by ClamAV. Upload rejected.');
        }
        console.warn('[ClamAV] Scanner unavailable or failed to run:', scanErr.message.split(/\r?\n/)[0]);
    }
    return { savedFileName, originalFileName: contractModel.displayFileName(originalFileName), fileType: kind.mime };
}

const sendContractError = (res, err) => {
    if (err instanceof ContractError) return res.status(err.status).json({ error: err.message, ...err.extra });
    return res.status(500).json({ error: err.message });
};

router.get('/contracts', (req, res) => {
    const list = getContracts();
    res.json(Array.isArray(list) ? list : []);
});

// Devices of every data center, for linking (racks of each DC; shelves, reserved and patch panels left out)
router.get('/contracts/devices', (req, res) => {
    try {
        const out = [];
        for (const dc of getDataCenters()) {
            for (const r of getRacks(dc.id)) {
                for (const d of Array.isArray(r.devices) ? r.devices : []) {
                    if (!d || !d.id || ['Shelf', 'Reserve', 'PatchPanel'].includes(d.type)) continue;
                    out.push({
                        id: d.id, hostname: d.hostname || '', model: d.model || '', sn: d.sn || '', type: d.type || '',
                        dcId: dc.id, dcName: dc.name || dc.id, rackId: r.id, rackName: r.name || '', u: d.u,
                    });
                }
            }
        }
        res.json(out);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create (no id) or update (id). renewedFrom on a create links the new term to the contract it renews.
router.post('/contracts', writeRoles, async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { id, expectedUpdatedAt, fileBase64, originalFileName, removeFile, renewedFrom } = body;
    const checked = contractModel.cleanContractFields(body);
    if (checked.error) return res.status(400).json({ error: checked.error });
    const fields = checked.fields;
    const username = req.user.username;

    // Checked before the upload so a refused save leaves no file behind; checked again inside the write
    const before = getContracts();
    const existing = id ? before.find(c => c.id === id) : null;
    if (id && !existing) return res.status(404).json({ error: 'Contract not found' });
    if (existing && existing.deletedAt) return res.status(400).json({ error: 'The contract is in the trash; restore it first' });
    if (!id && renewedFrom) {
        const prev = before.find(c => c.id === renewedFrom);
        if (!prev || prev.deletedAt) return res.status(404).json({ error: 'The contract being renewed was not found' });
        if (prev.renewedTo) return res.status(409).json({ error: 'That contract was already renewed' });
    }

    let file = null;
    try {
        if (fileBase64 && originalFileName) file = await storeContractFile(fileBase64, originalFileName);
    } catch (err) {
        return sendContractError(res, err);
    }

    let result;
    try {
        // The upload above was awaited: the write merges into the CURRENT list (atomic read-modify-write)
        result = mutateContracts((current) => {
            const now = new Date().toISOString();
            if (id) {
                const idx = current.findIndex(c => c.id === id);
                if (idx < 0) throw new ContractError('Contract not found', 404);
                const prev = current[idx];
                if (prev.deletedAt) throw new ContractError('The contract is in the trash; restore it first');
                if (expectedUpdatedAt && (prev.updatedAt || '') !== expectedUpdatedAt) {
                    throw new ContractError('This contract was changed by someone else. Reload it and apply your change again.', 409, { contract: prev });
                }
                const keepFile = !file && !removeFile;
                const next = {
                    ...prev, ...fields,
                    savedFileName: file ? file.savedFileName : keepFile ? prev.savedFileName || null : null,
                    originalFileName: file ? file.originalFileName : keepFile ? prev.originalFileName || null : null,
                    fileType: file ? file.fileType : keepFile ? prev.fileType || null : null,
                    updatedAt: now, updatedBy: username,
                };
                current[idx] = next;
                const dropped = !keepFile && prev.savedFileName && prev.savedFileName !== next.savedFileName ? prev.savedFileName : null;
                return { contract: next, updated: true, dropped };
            }
            const next = {
                id: `contract-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
                ...fields,
                savedFileName: file ? file.savedFileName : null,
                originalFileName: file ? file.originalFileName : null,
                fileType: file ? file.fileType : null,
                createdAt: now, createdBy: username, updatedAt: now, updatedBy: username,
            };
            let renewedOf = null;
            if (renewedFrom) {
                const prev = current.find(c => c.id === renewedFrom);
                if (!prev || prev.deletedAt) throw new ContractError('The contract being renewed was not found', 404);
                if (prev.renewedTo) throw new ContractError('That contract was already renewed', 409);
                prev.renewedTo = next.id;
                prev.updatedAt = now;
                prev.updatedBy = username;
                next.renewedFrom = prev.id;
                renewedOf = prev;
            }
            current.push(next);
            return { contract: next, updated: false, renewedOf };
        }, 'rack.saveContract');
    } catch (err) {
        if (file) removeLicenseFile(file.savedFileName);
        return sendContractError(res, err);
    }
    if (result.dropped) removeLicenseFile(result.dropped);
    const c = result.contract;
    const action = result.renewedOf ? `Renewed contract ${contractLabel(result.renewedOf)} -> new term ${c.startDate} to ${c.endDate}`
        : `${result.updated ? 'Updated' : 'Added'} contract: ${contractLabel(c)}`;
    auditLog(username, 'Contracts & Warranties', action);
    res.json({ success: true, contract: c });
});

// Moves a contract to the trash
router.delete('/contracts/:id', writeRoles, (req, res) => {
    try {
        const c = mutateContracts((current) => {
            const found = current.find(x => x.id === req.params.id);
            if (!found) throw new ContractError('Contract not found', 404);
            if (!found.deletedAt) {
                found.deletedAt = new Date().toISOString();
                found.deletedBy = req.user.username;
            }
            return found;
        }, 'rack.trashContract');
        auditLog(req.user.username, 'Contracts & Warranties', `Moved contract to trash: ${contractLabel(c)}`);
        res.json({ success: true, contract: c });
    } catch (err) {
        sendContractError(res, err);
    }
});

// Permanent delete (SuperAdmin, trash only): the file goes too; a contract it renewed counts as current again
router.delete('/contracts/:id/force', superAdminOnly, (req, res) => {
    try {
        const c = mutateContracts((current) => {
            const idx = current.findIndex(x => x.id === req.params.id);
            if (idx < 0) throw new ContractError('Contract not found', 404);
            if (!current[idx].deletedAt) throw new ContractError('Move the contract to the trash first');
            const [removed] = current.splice(idx, 1);
            for (const other of current) {
                if (other.renewedTo === removed.id) delete other.renewedTo;
                if (other.renewedFrom === removed.id) delete other.renewedFrom;
            }
            return removed;
        }, 'rack.deleteContract');
        removeLicenseFile(c.savedFileName);
        auditLog(req.user.username, 'Contracts & Warranties', `Permanently deleted contract: ${contractLabel(c)}`);
        res.json({ success: true });
    } catch (err) {
        sendContractError(res, err);
    }
});

router.post('/contracts/:id/restore', writeRoles, (req, res) => {
    try {
        const c = mutateContracts((current) => {
            const found = current.find(x => x.id === req.params.id);
            if (!found) throw new ContractError('Contract not found', 404);
            delete found.deletedAt;
            delete found.deletedBy;
            found.updatedAt = new Date().toISOString();
            found.updatedBy = req.user.username;
            return found;
        }, 'rack.restoreContract');
        auditLog(req.user.username, 'Contracts & Warranties', `Restored contract: ${contractLabel(c)}`);
        res.json({ success: true, contract: c });
    } catch (err) {
        sendContractError(res, err);
    }
});

router.get('/contracts/download/:filename', (req, res) => {
    try {
        const safeFilename = path.basename(req.params.filename);
        const ext = path.extname(safeFilename).toLowerCase();
        const allowedExts = ['.pdf', '.png', '.jpg', '.jpeg', '.docx'];
        if (!allowedExts.includes(ext)) {
            return res.status(403).json({ error: 'File type not permitted for download.' });
        }
        const owner = getContracts().find(c => c && c.savedFileName === safeFilename);
        const filePath = path.join(LICENSES_DIR, safeFilename);
        if (!owner || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        res.download(filePath, owner.originalFileName || safeFilename);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
