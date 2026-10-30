// Server Rack layout validation shared by POST / PATCH /api/rack and POST /api/rack/move-device.
// Front and back of a cabinet are separate rack objects (isBack), so U collisions are checked per rack object.

const MAX_RACK_HEIGHT = 100;        // UI: Total Height input max 100
const MAX_SPLIT_RACK_HEIGHT = 200;  // UI: split rack height = upperU (max 100) + lowerU (max 100)

// Vertical (side-mounted) power bars hang on the rails beside the U slots and do not take U space
function isSideMounted(device) {
    return !!device && device.type === 'PowerBar' && device.orientation === 'vertical';
}

function deviceLabel(device) {
    return (device && (device.hostname || device.name || device.type || device.id)) || 'device';
}

function rackLabel(rack) {
    return (rack && (rack.name || rack.id)) || 'rack';
}

// Lenient span of a stored device (legacy data may hold strings)
function spanOf(device) {
    const start = parseInt(device.startU, 10) || 1;
    const size = parseInt(device.sizeU, 10) || 1;
    return [start, start + size - 1];
}

/**
 * Checks that a device of sizeU placed at startU fits the rack: height, split boundary and U overlap.
 * `devices` are the rack's other devices; `excludeId` skips the device itself (same-rack move / edit).
 * Returns an error message or null.
 */
function placementProblem(rack, { startU, sizeU, sideMounted = false, excludeId = null }, devices) {
    const endU = startU + sizeU - 1;
    const height = parseInt(rack.height, 10);
    if (!(endU <= height)) {
        return `Device (${sizeU}U) exceeds rack height (${rack.height}U)`;
    }
    if (rack.isSplitDesign) {
        const lowerU = parseInt(rack.lowerU, 10);
        if (lowerU && startU <= lowerU && endU > lowerU) {
            return 'Device cannot cross Down and Up split boundary';
        }
    }
    if (sideMounted) return null;
    const hit = (devices || []).find(d => {
        if (!d || (excludeId !== null && d.id === excludeId) || isSideMounted(d)) return false;
        const [dStart, dEnd] = spanOf(d);
        return Math.max(startU, dStart) <= Math.min(endU, dEnd);
    });
    return hit ? `U slots overlap with "${deviceLabel(hit)}"` : null;
}

// JSON.stringify with sorted keys, so key order does not count as a change
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
            .map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value === undefined ? null : value);
}

// viewMode is UI state the client sends back; a missing devices list equals []
function rackSignature(rack) {
    return stableStringify({ ...rack, viewMode: undefined, devices: rack.devices || [] });
}

function geometryChanged(oldRack, rack) {
    return String(oldRack.height) !== String(rack.height)
        || !!oldRack.isSplitDesign !== !!rack.isSplitDesign
        || (!!rack.isSplitDesign && String(oldRack.lowerU) !== String(rack.lowerU));
}

const isPosInt = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const isNonEmptyId = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Validates the full rack list of one DC (after a POST, or after merging a PATCH) against the stored list.
 * Only racks / devices that are new or changed are checked, so legacy bad data elsewhere never blocks a save.
 * Normalises a missing `devices` to []. Returns an error message or null.
 */
function validateRacks(racks, oldRacks) {
    if (!Array.isArray(racks)) return 'Payload must be an array of racks';
    const oldById = new Map();
    (Array.isArray(oldRacks) ? oldRacks : []).forEach(r => { if (r && r.id) oldById.set(r.id, r); });

    const rackIdCount = new Map();
    racks.forEach(r => {
        if (r && typeof r === 'object' && isNonEmptyId(r.id)) rackIdCount.set(r.id, (rackIdCount.get(r.id) || 0) + 1);
    });

    const dirtyDevices = []; // [rack, device, index]
    const deviceOccurrences = new Map(); // id -> [{ rack, dirty }]

    for (let i = 0; i < racks.length; i++) {
        const rack = racks[i];
        if (!rack || typeof rack !== 'object' || Array.isArray(rack)) return `Rack #${i + 1} is not an object`;
        if (rack.devices === undefined || rack.devices === null) rack.devices = [];

        const oldRack = isNonEmptyId(rack.id) ? oldById.get(rack.id) : undefined;
        const rackChanged = !oldRack || rackSignature(oldRack) !== rackSignature(rack);

        if (rackChanged) {
            if (!isNonEmptyId(rack.id)) return `Rack #${i + 1} ("${rackLabel(rack)}") has no id`;
            if (rackIdCount.get(rack.id) > 1) return `Duplicate rack id "${rack.id}"`;
            const maxHeight = rack.isSplitDesign ? MAX_SPLIT_RACK_HEIGHT : MAX_RACK_HEIGHT;
            if (!isPosInt(rack.height) || rack.height > maxHeight) {
                return `Rack "${rackLabel(rack)}": height must be an integer between 1 and ${maxHeight}`;
            }
            if (rack.isSplitDesign && (!isPosInt(rack.lowerU) || rack.lowerU >= rack.height)) {
                return `Rack "${rackLabel(rack)}": split lower section (lowerU) must be an integer between 1 and ${rack.height - 1}`;
            }
            if (!Array.isArray(rack.devices)) return `Rack "${rackLabel(rack)}": devices must be an array`;
        } else if (!Array.isArray(rack.devices)) {
            continue; // untouched legacy rack
        }

        const allDirty = !oldRack || geometryChanged(oldRack, rack);
        const oldDevices = new Map();
        if (oldRack && Array.isArray(oldRack.devices)) oldRack.devices.forEach(d => { if (d && d.id) oldDevices.set(d.id, d); });

        rack.devices.forEach((device, idx) => {
            const old = device && device.id ? oldDevices.get(device.id) : undefined;
            const dirty = rackChanged && (allDirty || !old || stableStringify(old) !== stableStringify(device));
            if (dirty) dirtyDevices.push([rack, device, idx]);
            if (device && isNonEmptyId(device.id)) {
                if (!deviceOccurrences.has(device.id)) deviceOccurrences.set(device.id, []);
                deviceOccurrences.get(device.id).push({ rack, dirty });
            }
        });
    }

    for (const [rack, device, idx] of dirtyDevices) {
        const where = `Rack "${rackLabel(rack)}"`;
        if (!device || typeof device !== 'object' || Array.isArray(device)) return `${where}: device #${idx + 1} is not an object`;
        if (!isNonEmptyId(device.id)) return `${where}: device "${deviceLabel(device)}" has no id`;
        const label = `${where}: device "${deviceLabel(device)}"`;
        if (!isPosInt(device.startU)) return `${label}: startU must be an integer >= 1`;
        if (!isPosInt(device.sizeU)) return `${label}: sizeU must be an integer >= 1`;
        const problem = placementProblem(rack, {
            startU: device.startU,
            sizeU: device.sizeU,
            sideMounted: isSideMounted(device),
        }, rack.devices.filter(d => d !== device));
        if (problem) return `${label}: ${problem}`;
    }

    for (const [id, occ] of deviceOccurrences) {
        if (occ.length > 1 && occ.some(o => o.dirty)) {
            return `Duplicate device id "${id}" (racks: ${occ.map(o => `"${rackLabel(o.rack)}"`).join(', ')})`;
        }
    }
    return null;
}

module.exports = {
    MAX_RACK_HEIGHT,
    MAX_SPLIT_RACK_HEIGHT,
    isSideMounted,
    placementProblem,
    validateRacks,
    stableStringify,
};
