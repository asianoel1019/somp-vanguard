// Side effects of rack device changes, shared by the Server Rack routes (routes/rack.js) and the
// Network Device routes (routes/networkDevice.js): IPAM use / free and removal of SNMP settings.
const { readDataSync, writeDataSync } = require('./db');
const ipamSync = require('./ipamSync');

const SNMP_FILE = 'network_service/snmp_settings.json';

/** { [deviceId]: device } of every device in the given rack list. */
function deviceMapOf(racks) {
    const map = {};
    (racks || []).forEach(r => {
        (r && Array.isArray(r.devices) ? r.devices : []).forEach(d => {
            if (d && d.id) map[d.id] = d;
        });
    });
    return map;
}

/**
 * Given the old and new device maps: queues the IPAM use/free actions and removes the SNMP settings
 * of removed devices. Only the devices present in either map are considered.
 * Returns { ipActions, snmpChanged }.
 */
function syncDeviceChanges(oldDevices, newDevices, username, source = 'Server Rack') {
    const snmpSettings = readDataSync(SNMP_FILE, {}) || {};
    let snmpChanged = false;
    const ipActions = [];

    for (const id in oldDevices) {
        if (!newDevices[id]) {
            if (oldDevices[id].ip) {
                ipActions.push({ ip: oldDevices[id].ip, hostname: '', username, action: 'free', source });
            }
            if (snmpSettings[id]) {
                delete snmpSettings[id];
                snmpChanged = true;
            }
        }
    }

    for (const id in newDevices) {
        const newDev = newDevices[id];
        const oldDev = oldDevices[id];
        const deviceName = newDev.hostname || newDev.name || 'Server Rack Device';

        if (!oldDev) {
            if (newDev.ip) {
                ipActions.push({ ip: newDev.ip, hostname: deviceName, username, action: 'use', source });
            }
        } else if (oldDev.ip !== newDev.ip) {
            if (oldDev.ip) ipActions.push({ ip: oldDev.ip, hostname: '', username, action: 'free', source });
            if (newDev.ip) ipActions.push({ ip: newDev.ip, hostname: deviceName, username, action: 'use', source });
        } else if (oldDev.hostname !== newDev.hostname || oldDev.name !== newDev.name) {
            if (newDev.ip) ipActions.push({ ip: newDev.ip, hostname: deviceName, username, action: 'use', source });
        }
    }

    if (snmpChanged) writeDataSync(SNMP_FILE, snmpSettings);
    // via the module object so tests can stub batchSyncIpsToIpam
    if (ipActions.length > 0) ipamSync.batchSyncIpsToIpam(ipActions);
    return { ipActions, snmpChanged };
}

module.exports = { deviceMapOf, syncDeviceChanges };
