const express = require('express');
const router = express.Router();
const snmp = require('net-snmp');
const { requireAuth, checkRole, checkFeature, checkAnyFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { readDataSync, writeDataSync } = require('../lib/db');
const { encryptText, decryptText } = require('../lib/crypto');
const crypto = require('crypto');
const rackStore = require('../lib/rackStore');
const { placementProblem } = require('../lib/rackLayout');
const { syncDeviceChanges } = require('../lib/rackDeviceSync');

// File containing SNMP settings
const SNMP_FILE = 'network_service/snmp_settings.json';

const ENCRYPTION_KEY = Buffer.alloc(32, 'a-secure-secret-key-that-should-be-in-env'); // Keep for legacy decryption
const IV_LENGTH = 16;

// Tests replace `snmp` with a stub so no SNMP packet is ever sent
const _testHooks = { snmp: null };
const snmpLib = () => _testHooks.snmp || snmp;

const NETWORK_TYPES = ['Switch', 'Router', 'Firewall', 'LoadBalancer'];
const SECRET_MASK = '●●●●●●';
const SECRET_FIELDS = ['community', 'v3AuthPass', 'v3PrivPass'];
const SNMP_VERSIONS = ['v1', 'v2c', 'v3'];
const IPAM_SOURCE = 'Network Device';

function legacyDecrypt(text) {
    if (!text) return text;
    try {
        let textParts = text.split(':');
        if (textParts.length !== 2) return text;
        let iv = Buffer.from(textParts.shift(), 'hex');
        let encryptedText = Buffer.from(textParts.join(':'), 'hex');
        let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) { return text; }
}

router.use(requireAuth);
// SNMP settings and polling (/:id/snmp, /:id/poll) are used by the Network Device screen and by the
// Data Center Server Rack screen -> either feature. Device management (/devices) is Network Device only.
router.use(checkAnyFeature('networkDevice', 'dataCenter'));
const networkDeviceOnly = checkFeature('networkDevice');

function getSnmpSettings() {
    const data = readDataSync(SNMP_FILE, {});
    let migrationNeeded = false;
    for (let id in data) {
        ['community', 'v3AuthPass', 'v3PrivPass'].forEach(field => {
            if (data[id][field]) {
                const parts = data[id][field].split(':');
                if (parts.length === 2) {
                    // Legacy format (iv:ciphertext), decrypt and flag for migration
                    const decrypted = legacyDecrypt(data[id][field]);
                    data[id][field] = decrypted;
                    migrationNeeded = true;
                } else {
                    try {
                        data[id][field] = decryptText(data[id][field]);
                    } catch (e) {
                        // Fallback to legacy
                        data[id][field] = legacyDecrypt(data[id][field]);
                        migrationNeeded = true;
                    }
                }
            }
        });
    }
    if (migrationNeeded) {
        saveSnmpSettings(data);
    }
    return data;
}

function saveSnmpSettings(data) {
    const toSave = JSON.parse(JSON.stringify(data));
    for (let id in toSave) {
        if (toSave[id].community) toSave[id].community = encryptText(toSave[id].community);
        if (toSave[id].v3AuthPass) toSave[id].v3AuthPass = encryptText(toSave[id].v3AuthPass);
        if (toSave[id].v3PrivPass) toSave[id].v3PrivPass = encryptText(toSave[id].v3PrivPass);
    }
    writeDataSync(SNMP_FILE, toSave);
}

/**
 * Effective SNMP settings of a device. No stored settings -> disabled (never a 'public' fallback);
 * stored settings without an `enabled` key predate the switch and count as enabled.
 */
function effectiveSnmp(stored) {
    if (!stored || typeof stored !== 'object') {
        return { enabled: false, version: 'v2c', community: '', port: 161 };
    }
    return { ...stored, enabled: stored.enabled !== false };
}

function maskSnmp(settings) {
    const masked = { ...settings };
    SECRET_FIELDS.forEach(f => { if (masked[f]) masked[f] = SECRET_MASK; });
    return masked;
}

// ---------------------------------------------------------------- validation helpers

const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);

function isIPv4(v) {
    const parts = String(v).split('.');
    return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** '' (clears) or an IPv4 address; returns { value } or { error }. */
function cleanIp(v) {
    if (v === null || v === undefined) return { value: '' };
    if (typeof v !== 'string') return { error: 'ip must be a string' };
    const ip = v.trim();
    if (ip && !isIPv4(ip)) return { error: `Invalid IPv4 address: ${ip}` };
    return { value: ip };
}

function cleanHostname(v) {
    if (v === null || v === undefined) return { value: '' };
    if (typeof v !== 'string') return { error: 'hostname must be a string' };
    const hostname = v.trim();
    if (hostname.length > 253) return { error: 'hostname must be at most 253 characters' };
    return { value: hostname };
}

/** Positive integer (number or digit string) or null. */
function toPosInt(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v >= 1 ? v : null;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
        const n = Number(v.trim());
        return n >= 1 ? n : null;
    }
    return null;
}

// ---------------------------------------------------------------- rack lookup (rackStore, any DB backend)

/** Every DC id that may hold a rack document: 'default' + data_center/datacenters.json. */
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

/** Replaces device `id` in the DC's rack list via `fn(device) -> device | null (removed)`, saves, returns the new revision. */
function updateDeviceInDc(dcId, id, fn) {
    const racks = rackStore.getRacks(dcId).map(rack => {
        if (!rack || !Array.isArray(rack.devices) || !rack.devices.some(d => d && d.id === id)) return rack;
        const devices = [];
        rack.devices.forEach(d => {
            if (d && d.id === id) {
                const next = fn(d);
                if (next) devices.push(next);
            } else {
                devices.push(d);
            }
        });
        return { ...rack, devices };
    });
    return rackStore.saveRacks(dcId, racks);
}

// 1. GET /devices - Returns all network devices merged with SNMP settings
router.get('/devices', networkDeviceOnly, checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    try {
        const allNetworkDevices = [];
        listDataCenters().forEach(dc => {
            const fileKey = rackStore.rackKey(dc.id);
            rackStore.getRacks(dc.id).forEach(rack => {
                (rack && Array.isArray(rack.devices) ? rack.devices : []).forEach(device => {
                    if (device && NETWORK_TYPES.includes(device.type)) {
                        allNetworkDevices.push({
                            ...device,
                            rackId: rack.id,
                            rackName: rack.name,
                            datacenter: dc.name,
                            fileKey
                        });
                    }
                });
            });
        });

        // Merge with SNMP settings
        const snmpSettings = getSnmpSettings();
        res.json(allNetworkDevices.map(device => {
            const settings = effectiveSnmp(snmpSettings[device.id]);
            return { ...device, snmp: maskSnmp(settings), enabled: settings.enabled };
        }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. POST /devices - Adds a new network device to the target rack
router.post('/devices', networkDeviceOnly, checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const { rackId } = body;
        const input = body.device && typeof body.device === 'object' && !Array.isArray(body.device) ? body.device : null;
        if (!input) return res.status(400).json({ error: 'device is required' });

        if (!NETWORK_TYPES.includes(input.type)) {
            return res.status(400).json({ error: `type must be one of ${NETWORK_TYPES.join(', ')}` });
        }
        const hostname = cleanHostname(input.hostname);
        if (hostname.error) return res.status(400).json({ error: hostname.error });
        const ip = cleanIp(input.ip);
        if (ip.error) return res.status(400).json({ error: ip.error });
        const startU = toPosInt(input.startU);
        const sizeU = toPosInt(input.sizeU);
        if (startU === null) return res.status(400).json({ error: 'startU must be a positive integer' });
        if (sizeU === null) return res.status(400).json({ error: 'sizeU must be a positive integer' });
        let ports = 24;
        if (input.ports !== undefined && input.ports !== null && input.ports !== '') {
            ports = toPosInt(input.ports);
            if (ports === null) return res.status(400).json({ error: 'ports must be a positive integer' });
        }

        const dcId = rackStore.normDcId(body.datacenterId);
        const dc = listDataCenters().find(d => d.id === dcId);
        if (!dc) return res.status(404).json({ error: `Data center not found: ${dcId}` });

        const racks = rackStore.getRacks(dcId);
        const rack = racks.find(r => r && r.id === rackId);
        if (!rack || typeof rackId !== 'string' || !rackId) return res.status(404).json({ error: 'Target rack not found' });

        const problem = placementProblem(rack, { startU, sizeU }, rack.devices);
        if (problem) return res.status(400).json({ error: `Rack "${rack.name || rack.id}": ${problem}` });

        // id is server-owned
        const device = {
            id: `dev-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
            type: input.type,
            hostname: hostname.value,
            ip: ip.value,
            startU,
            sizeU,
            ports
        };
        rack.devices = [...(Array.isArray(rack.devices) ? rack.devices : []), device];
        const revision = rackStore.saveRacks(dcId, racks);
        syncDeviceChanges({}, { [device.id]: device }, req.user.username, IPAM_SOURCE);

        auditLog(req.user.username, 'Network Device', `Added ${device.type} (${device.hostname}) to Rack ${rack.name || rack.id} in ${dc.name}`);
        res.json({ success: true, device, fileKey: rackStore.rackKey(dcId), revision });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. PUT /devices/:id - Update hostname and / or IP (absent fields keep their value)
router.put('/devices/:id', networkDeviceOnly, checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    try {
        const { id } = req.params;
        const body = req.body && typeof req.body === 'object' ? req.body : {};

        const changes = {};
        if (has(body, 'hostname')) {
            const hostname = cleanHostname(body.hostname);
            if (hostname.error) return res.status(400).json({ error: hostname.error });
            changes.hostname = hostname.value;
        }
        if (has(body, 'ip')) {
            const ip = cleanIp(body.ip);
            if (ip.error) return res.status(400).json({ error: ip.error });
            changes.ip = ip.value;
        }

        const found = findNetworkDevice(id);
        if (!found) return res.status(404).json({ error: 'Device not found' });
        // fileKey / rackId are optional hints from older clients; a mismatch means a stale screen
        if (body.fileKey && body.fileKey !== found.fileKey) {
            return res.status(400).json({ error: 'Device is not in the specified rack document (fileKey); reload and try again' });
        }
        if (body.rackId && body.rackId !== found.rack.id) {
            return res.status(400).json({ error: 'Device is not in the specified rack; reload and try again' });
        }

        const oldDevice = found.device;
        const newDevice = { ...oldDevice, ...changes };
        const revision = updateDeviceInDc(found.dcId, id, () => newDevice);
        syncDeviceChanges({ [id]: oldDevice }, { [id]: newDevice }, req.user.username, IPAM_SOURCE);

        auditLog(req.user.username, 'Network Device', `Updated hostname/IP for device ${id} (${newDevice.hostname || ''} / ${newDevice.ip || ''})`);
        res.json({ success: true, device: newDevice, revision });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3b. DELETE /devices/:id - Deletes a network device (frees its IP, removes its SNMP settings)
router.delete('/devices/:id', networkDeviceOnly, checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    try {
        const { id } = req.params;
        const { fileKey } = req.query;

        const found = findNetworkDevice(id);
        if (!found) return res.status(404).json({ error: 'Device not found' });
        if (fileKey && fileKey !== found.fileKey) {
            return res.status(400).json({ error: 'Device is not in the specified rack document (fileKey); reload and try again' });
        }

        const revision = updateDeviceInDc(found.dcId, id, () => null);
        syncDeviceChanges({ [id]: found.device }, {}, req.user.username, IPAM_SOURCE);

        auditLog(req.user.username, 'Network Device', `Deleted device ${id} (${found.device.hostname || found.device.type || ''})`);
        res.json({ success: true, revision });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. GET /:id/snmp - Get SNMP settings (secrets masked)
router.get('/:id/snmp', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    try {
        const { id } = req.params;
        const settings = effectiveSnmp(getSnmpSettings()[id]);
        res.json({ community: '', ...maskSnmp(settings) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Whitelists and validates a POST /:id/snmp body against the stored settings (mask = keep the old secret).
 * Returns { settings } or { error }.
 */
function normalizeSnmpSettings(body, oldSettings) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Settings must be an object' };
    const old = oldSettings && typeof oldSettings === 'object' ? oldSettings : null;
    const out = {};

    if (has(body, 'enabled')) {
        if (typeof body.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
        out.enabled = body.enabled;
    } else {
        // an older client that does not know the switch keeps the current state (new settings: enabled)
        out.enabled = old ? old.enabled !== false : true;
    }

    const version = has(body, 'version') ? body.version : (old && old.version) || 'v2c';
    if (!SNMP_VERSIONS.includes(version)) return { error: `version must be one of ${SNMP_VERSIONS.join(', ')}` };
    out.version = version;

    if (body.port === undefined || body.port === null || body.port === '') {
        out.port = 161;
    } else {
        const port = toPosInt(body.port);
        if (port === null || port > 65535) return { error: 'port must be an integer between 1 and 65535' };
        out.port = port;
    }

    const strings = { community: 256, v3User: 128, v3AuthPass: 256, v3PrivPass: 256 };
    for (const [key, max] of Object.entries(strings)) {
        let v = body[key];
        if (v === undefined || v === null) v = '';
        if (typeof v !== 'string') return { error: `${key} must be a string` };
        if (SECRET_FIELDS.includes(key) && v === SECRET_MASK) v = (old && old[key]) || '';
        if (v.length > max) return { error: `${key} must be at most ${max} characters` };
        out[key] = v;
    }

    if (out.enabled) {
        if (out.version !== 'v3' && !out.community) return { error: `SNMP ${out.version} requires a community string` };
        if (out.version === 'v3') {
            if (!out.v3User) return { error: 'SNMP v3 requires a security name (v3User)' };
            if (out.v3AuthPass.length < 8) return { error: 'SNMP v3 auth password must be at least 8 characters' };
            if (out.v3PrivPass.length < 8) return { error: 'SNMP v3 priv password must be at least 8 characters' };
        }
    }
    return { settings: out };
}

// 5. POST /:id/snmp - Save SNMP settings
router.post('/:id/snmp', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    try {
        const { id } = req.params;
        if (!findNetworkDevice(id)) return res.status(404).json({ error: 'Device not found' });

        const allSettings = getSnmpSettings();
        const result = normalizeSnmpSettings(req.body, allSettings[id]);
        if (result.error) return res.status(400).json({ error: result.error });

        allSettings[id] = result.settings;
        saveSnmpSettings(allSettings);

        auditLog(req.user.username, 'Network Device', `Updated SNMP settings for device ${id} (${result.settings.enabled ? `enabled, ${result.settings.version}` : 'disabled'})`);
        res.json({ success: true, enabled: result.settings.enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 6. GET /:id/poll - SNMP Poll. The target IP always comes from the rack documents, never from the client.
router.get('/:id/poll', checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    try {
        const { id } = req.params;

        const found = findNetworkDevice(id);
        if (!found) return res.status(404).json({ error: 'Device not found' });

        const settings = effectiveSnmp(getSnmpSettings()[id]);
        if (!settings.enabled) {
            return res.status(409).json({ success: false, disabled: true, error: '此設備未啟用 SNMP 查詢' });
        }

        const targetIp = typeof found.device.ip === 'string' ? found.device.ip.trim() : '';
        if (!targetIp) return res.status(400).json({ error: 'Device has no IP address; set and save the IP first' });

        const version = SNMP_VERSIONS.includes(settings.version) ? settings.version : 'v2c';
        if (version !== 'v3' && !settings.community) {
            return res.status(400).json({ error: 'SNMP community string is not configured for this device' });
        }
        if (version === 'v3' && !settings.v3User) {
            return res.status(400).json({ error: 'SNMP v3 security name is not configured for this device' });
        }

        const lib = snmpLib();
        const port = parseInt(settings.port, 10) || 161;

        // MIBs:
        // ifOperStatus = 1.3.6.1.2.1.2.2.1.8
        // ipNetToMediaPhysAddress (ARP) = 1.3.6.1.2.1.4.22.1.2
        // dot1dTpFdbPort (MAC) = 1.3.6.1.2.1.17.4.3.1.2

        let session;
        const walkOid = (oid, isHex = false) => {
            return new Promise((resolve, reject) => {
                const result = [];
                session.subtree(oid, (varbinds) => {
                    for (let i = 0; i < varbinds.length; i++) {
                        if (!lib.isVarbindError(varbinds[i])) {
                            let val = varbinds[i].value;
                            if (Buffer.isBuffer(val)) {
                                if (isHex) {
                                    val = val.toString('hex').match(/.{1,2}/g).join(':').toUpperCase();
                                } else {
                                    val = val.toString('utf8');
                                }
                            } else {
                                val = val.toString();
                            }
                            result.push({
                                oid: varbinds[i].oid.toString(),
                                value: val
                            });
                        }
                    }
                }, (error) => {
                    if (error) reject(error);
                    else resolve(result);
                });
            });
        };

        try {
            // Build SNMP session (net-snmp defaults to SNMPv1 when no version is passed)
            if (version === 'v3') {
                const user = {
                    name: settings.v3User,
                    level: lib.SecurityLevel.authPriv,
                    authProtocol: lib.AuthProtocols.sha,
                    authKey: settings.v3AuthPass,
                    privProtocol: lib.PrivProtocols.aes,
                    privKey: settings.v3PrivPass
                };
                session = lib.createV3Session(targetIp, user, { port, timeout: 10000 });
            } else {
                session = lib.createSession(targetIp, settings.community, {
                    port,
                    timeout: 10000,
                    version: version === 'v1' ? lib.Version1 : lib.Version2c
                });
            }

            const portsRaw = await walkOid("1.3.6.1.2.1.2.2.1.8");
            const arpRaw = await walkOid("1.3.6.1.2.1.4.22.1.2", true);
            const macRaw = await walkOid("1.3.6.1.2.1.17.4.3.1.2", true);
            const speedRaw = await walkOid("1.3.6.1.2.1.2.2.1.5");

            let nameRaw = [];
            let descRaw = [];
            try { nameRaw = await walkOid("1.3.6.1.2.1.31.1.1.1.1"); } catch(e) { console.log(`[SNMP] Failed to walk ifName: ${e.message}`); }
            try { descRaw = await walkOid("1.3.6.1.2.1.2.2.1.2"); } catch(e) { console.log(`[SNMP] Failed to walk ifDescr: ${e.message}`); }

            // Format data
            const formattedPorts = portsRaw.map(p => {
                const parts = p.oid.split('.');
                const portNum = parts[parts.length - 1];
                const speedObj = speedRaw.find(s => s.oid.endsWith(`.${portNum}`));

                const nameObj = nameRaw.find(n => n.oid.endsWith(`.${portNum}`));
                const descObj = descRaw.find(d => d.oid.endsWith(`.${portNum}`));
                const portName = (nameObj ? nameObj.value : null) || (descObj ? descObj.value : null) || portNum;

                let speedStr = 'Unknown';
                if (speedObj) {
                    const bps = parseInt(speedObj.value);
                    if (bps >= 1000000000) speedStr = (bps / 1000000000) + ' Gbps';
                    else if (bps >= 1000000) speedStr = (bps / 1000000) + ' Mbps';
                }
                return { port: portNum, name: portName, value: p.value, status: p.value === '1' ? 'Up' : 'Down', speed: speedStr };
            });

            const formattedArp = arpRaw.map(a => {
                const parts = a.oid.split('.');
                const ip = parts.slice(-4).join('.');
                return { ip, mac: a.value };
            });

            const formattedMac = macRaw.map(m => {
                const parts = m.oid.split('.');
                const macDec = parts.slice(-6);
                const macHex = macDec.map(d => parseInt(d).toString(16).padStart(2, '0').toUpperCase()).join(':');
                return { mac: macHex, port: m.value };
            });

            res.json({
                success: true,
                live: true,
                ports: formattedPorts,
                arp: formattedArp,
                mac: formattedMac
            });
        } catch (e) {
            console.error(`[SNMP] Query to ${targetIp} failed: ${e.message}`);
            res.status(500).json({
                success: false,
                live: false,
                error: `SNMP query failed: ${e.message}`,
                ports: [],
                arp: [],
                mac: []
            });
        } finally {
            if (session) {
                try {
                    session.close();
                } catch(e) { console.error('[SNMP] Error closing session', e); }
            }
        }

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router._testHooks = _testHooks;
router.findNetworkDevice = findNetworkDevice;

module.exports = router;
