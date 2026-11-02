/**
 * Input checks for the Nutanix VM Manager write endpoints (routes/nutanix.js).
 * Every validator returns { errors: [{ row?, error }] }; an empty list means the input is accepted.
 */

// Power actions the VM Manager offers (NutanixManager.jsx action menu)
const POWER_ACTIONS = ['OFF', 'POWER_CYCLE', 'RESET', 'ACPI_SHUTDOWN', 'ACPI_REBOOT'];
const MAX_VM_ACTION_UUIDS = 500;
const MAX_MAP_ENTRIES = 1000;
const MAX_FIELD_LENGTH = 512;

// The UUID goes into the Nutanix API URL path, so nothing but a UUID is allowed
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const HOST = /^[A-Za-z0-9.-]+$/;

function validateVmAction(uuids, actionType) {
    const errors = [];
    if (!POWER_ACTIONS.includes(actionType)) {
        errors.push({ error: `Unsupported actionType "${actionType}" (allowed: ${POWER_ACTIONS.join(', ')})` });
    }
    if (!Array.isArray(uuids) || uuids.length === 0) {
        errors.push({ error: 'uuids must be a non-empty array' });
    } else if (uuids.length > MAX_VM_ACTION_UUIDS) {
        errors.push({ error: `Too many VMs in one request (${uuids.length}, max ${MAX_VM_ACTION_UUIDS})` });
    } else {
        uuids.forEach((u, i) => {
            if (typeof u !== 'string' || !UUID.test(u)) errors.push({ row: i + 1, error: `Invalid VM UUID "${String(u)}"` });
        });
    }
    return { errors };
}

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

// Shared shape check: a plain object whose values are short single-line scalars
function checkEntryShape(entry, row, errors) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push({ row, error: 'Entry must be an object' });
        return false;
    }
    for (const [key, value] of Object.entries(entry)) {
        if (value !== null && typeof value === 'object') {
            errors.push({ row, error: `Field "${key}" must be a text value` });
            return false;
        }
        const s = str(value);
        if (s.length > MAX_FIELD_LENGTH) { errors.push({ row, error: `Field "${key}" is too long (max ${MAX_FIELD_LENGTH})` }); return false; }
        if (CONTROL_CHARS.test(s)) { errors.push({ row, error: `Field "${key}" contains control characters` }); return false; }
    }
    return true;
}

function checkList(data, label) {
    if (!Array.isArray(data)) return [{ error: 'Payload must be an array of mapping entries.' }];
    if (data.length > MAX_MAP_ENTRIES) return [{ error: `${label} has too many entries (${data.length}, max ${MAX_MAP_ENTRIES})` }];
    return null;
}

function isSubnetPrefix(s) {
    const parts = s.split('.');
    return parts.length === 3 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function validateIpSwitchMap(data) {
    const listErr = checkList(data, 'IP Switch Mapping');
    if (listErr) return { errors: listErr };
    const errors = [];
    const seen = new Map();
    data.forEach((entry, i) => {
        const row = i + 1;
        if (!checkEntryShape(entry, row, errors)) return;
        const prefix = str(entry.subnetPrefix);
        if (!isSubnetPrefix(prefix)) {
            errors.push({ row, error: `subnetPrefix "${prefix}" must be 3 octets (e.g. 10.20.30)` });
        } else if (seen.has(prefix)) {
            errors.push({ row, error: `Duplicate subnetPrefix "${prefix}" (also row ${seen.get(prefix)})` });
        } else {
            seen.set(prefix, row);
        }
        for (const field of ['cluster', 'zone', 'vlan']) {
            if (!str(entry[field])) errors.push({ row, error: `${field} is required` });
        }
        // Used as connection targets by the clone scripts
        for (const field of ['clusterIp', 'dns1', 'dns2']) {
            const v = str(entry[field]);
            if (v && !HOST.test(v)) errors.push({ row, error: `${field} "${v}" must be an IP address or host name` });
        }
    });
    return { errors };
}

function validateTemplateBuMap(data) {
    const listErr = checkList(data, 'Template-BU Mapping');
    if (listErr) return { errors: listErr };
    const errors = [];
    const seen = new Map();
    data.forEach((entry, i) => {
        const row = i + 1;
        if (!checkEntryShape(entry, row, errors)) return;
        const missing = ['os', 'bu', 'template'].filter(f => !str(entry[f]));
        missing.forEach(f => errors.push({ row, error: `${f} is required` }));
        if (missing.length) return;
        const key = [str(entry.os), str(entry.bu), str(entry.cluster) || 'All'].map(s => s.toLowerCase()).join('\u0000');
        if (seen.has(key)) {
            errors.push({ row, error: `Duplicate OS/BU/Cluster "${str(entry.os)} / ${str(entry.bu)} / ${str(entry.cluster) || 'All'}" (also row ${seen.get(key)})` });
        } else {
            seen.set(key, row);
        }
    });
    return { errors };
}

/** One-line 400 message: the first few problems, each prefixed with its row. */
function describeErrors(prefix, errors) {
    const shown = errors.slice(0, 10).map(e => (e.row ? `row ${e.row}: ${e.error}` : e.error)).join('; ');
    return `${prefix}: ${shown}${errors.length > 10 ? ` (+${errors.length - 10} more)` : ''}`;
}

module.exports = {
    POWER_ACTIONS,
    MAX_VM_ACTION_UUIDS,
    MAX_MAP_ENTRIES,
    validateVmAction,
    validateIpSwitchMap,
    validateTemplateBuMap,
    describeErrors
};
