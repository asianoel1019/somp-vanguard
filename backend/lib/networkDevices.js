// Network devices live in the rack documents of each data center; this finds them for the Network Device routes.
const { readDataSync } = require('./db');
const rackStore = require('./rackStore');

const NETWORK_TYPES = ['Switch', 'Router', 'Firewall', 'LoadBalancer'];

function listDataCenters() {
    const raw = readDataSync('data_center/datacenters.json', []);
    const dcs = [{ id: 'default', name: 'Default Data Center' }];
    (Array.isArray(raw) ? raw : []).forEach(dc => {
        if (!dc || typeof dc.id !== 'string' || !dc.id) return;
        const id = rackStore.normDcId(dc.id);
        const existing = dcs.find(d => d.id === id);
        if (existing) {
            if (dc.name) existing.name = dc.name;
        } else {
            dcs.push({ id, name: dc.name || id });
        }
    });
    return dcs;
}

/** Locates a device (any type) by id across all data centers -> { dcId, fileKey, rack, device } or null. */
function findNetworkDevice(id) {
    if (!id) return null;
    for (const dc of listDataCenters()) {
        for (const rack of rackStore.getRacks(dc.id)) {
            const device = (rack && Array.isArray(rack.devices) ? rack.devices : []).find(d => d && d.id === id);
            if (device) return { dcId: dc.id, fileKey: rackStore.rackKey(dc.id), rack, device };
        }
    }
    return null;
}

module.exports = { NETWORK_TYPES, listDataCenters, findNetworkDevice };
