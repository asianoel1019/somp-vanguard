// Single place for Server Rack document storage.
// Racks stay a plain array under data_center/server_rack.json (default DC) / data_center/server_rack_<dcId>.json;
// the optimistic-concurrency revision of each DC lives in its own document (data_center/rack_revisions.json).
const { readDataSync, writeDataSync, deleteDataSync } = require('./db');

const REVISIONS_KEY = 'data_center/rack_revisions.json';

function normDcId(dcId) {
    return !dcId || dcId === 'default' ? 'default' : String(dcId);
}

function rackKey(dcId) {
    const id = normDcId(dcId);
    return id === 'default' ? 'data_center/server_rack.json' : `data_center/server_rack_${id}.json`;
}

// Inverse of rackKey; null for keys that are not rack documents
function dcIdFromKey(key) {
    if (key === 'data_center/server_rack.json') return 'default';
    const m = /^data_center\/server_rack_(.+)\.json$/.exec(String(key || ''));
    return m ? m[1] : null;
}

function getRacks(dcId) {
    const racks = readDataSync(rackKey(dcId), []);
    return Array.isArray(racks) ? racks : [];
}

function readRevisions() {
    const map = readDataSync(REVISIONS_KEY, {});
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

function getRackRevision(dcId) {
    const rev = Number(readRevisions()[normDcId(dcId)]);
    return Number.isInteger(rev) && rev >= 0 ? rev : 0;
}

function bumpRevision(dcId) {
    const map = readRevisions();
    const id = normDcId(dcId);
    const next = getRackRevision(id) + 1;
    map[id] = next;
    writeDataSync(REVISIONS_KEY, map);
    return next;
}

/** Writes the rack array and bumps the DC's revision. Returns the new revision. */
function saveRacks(dcId, racks) {
    writeDataSync(rackKey(dcId), racks);
    return bumpRevision(dcId);
}

/** saveRacks for callers that address the document by key (Network Device). */
function saveRacksByKey(key, racks) {
    const dcId = dcIdFromKey(key);
    if (dcId === null) throw new Error(`Not a rack document key: ${key}`);
    return saveRacks(dcId, racks);
}

/** Removes the DC's rack document (DB + RAM cache) and its revision entry. */
function deleteRacks(dcId) {
    const id = normDcId(dcId);
    deleteDataSync(rackKey(id));
    const map = readRevisions();
    if (Object.prototype.hasOwnProperty.call(map, id)) {
        delete map[id];
        writeDataSync(REVISIONS_KEY, map);
    }
}

module.exports = {
    REVISIONS_KEY,
    normDcId,
    rackKey,
    dcIdFromKey,
    getRacks,
    saveRacks,
    saveRacksByKey,
    getRackRevision,
    deleteRacks,
};
