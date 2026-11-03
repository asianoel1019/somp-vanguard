const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { detectOs } = require('../lib/osDetect');
const { readEnv } = require('../lib/envEditor');
const provisioningConfig = require('../lib/provisioningConfig');
const envRegistry = require('../lib/environmentRegistry');
const nutanixValidation = require('../lib/nutanixValidation');
const { getCloneTask } = require('../lib/nutanixCloneTask');
const nutanixClient = require('../lib/nutanixClient');

// Overridable in tests
let cloneTask = getCloneTask;

router.use(requireAuth);
router.use(checkFeature('nutanix')); // only NutanixManager / NutanixCloneVM call these endpoints

// Power actions, cloning and the mapping tables change infrastructure: Viewer is read-only here
const canOperate = checkRole(['SuperAdmin', 'Operator']);

// Partial failures (one PE or cluster unreachable) are reported instead of silently shrinking the list.
// Array responses carry them in this header (URI-encoded JSON) so the response shape stays unchanged.
function setWarningsHeader(res, warnings) {
    if (warnings.length > 0) res.set('X-Nutanix-Warnings', encodeURIComponent(JSON.stringify(warnings)));
}

// GET /connection-status
router.get('/connection-status', async (req, res) => {
    const cfg = nutanixClient.resolveConfig();
    const shownIp = cfg.isPeMode ? cfg.peIps.join(',') : cfg.pcIp;

    if (!cfg.primaryIp || !cfg.account || !cfg.pwd) {
        return res.json({ success: false, status: 'Offline', error: 'Settings are incomplete.', ip: shownIp, isPeMode: cfg.isPeMode });
    }

    try {
        const client = nutanixClient.createClient(cfg.primaryIp, cfg);
        await client.get(cfg.isPeMode ? '/v2.0/cluster' : '/v3/users/me', { timeout: 20000 });
        res.json({ success: true, status: 'Online', ip: shownIp, isPeMode: cfg.isPeMode });
    } catch (err) {
        console.error('[Nutanix] Connection check failed:', err.message);
        res.json({ success: false, status: 'Offline', error: err.message, ip: shownIp, isPeMode: cfg.isPeMode });
    }
});

// GET /ip-switch-map
router.get('/ip-switch-map', async (req, res) => {
    try {
        const data = readDataSync('server_operation/ip_switch_map.json', []);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read IP switch mapping table: ' + err.message });
    }
});

// POST /ip-switch-map
router.post('/ip-switch-map', canOperate, async (req, res) => {
    try {
        const data = req.body;
        const { errors } = nutanixValidation.validateIpSwitchMap(data);
        if (errors.length > 0) {
            return res.status(400).json({ error: nutanixValidation.describeErrors('IP Switch Mapping rejected', errors), rows: errors });
        }
        writeDataSync('server_operation/ip_switch_map.json', data);
        auditLog(req.user.username, 'Nutanix Manager', 'Updated IP Switch Mapping Table');
        res.json({ success: true, message: 'IP Switch mapping table saved successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write IP switch mapping table: ' + err.message });
    }
});

const { readDataSync, writeDataSync } = require('../lib/db');

// GET /template-bu-map
router.get('/template-bu-map', async (req, res) => {
    try {
        const data = readDataSync('server_operation/template_bu_map.json', []);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read Template-BU mapping table: ' + err.message });
    }
});

// POST /template-bu-map
router.post('/template-bu-map', canOperate, async (req, res) => {
    try {
        const data = req.body;
        const { errors } = nutanixValidation.validateTemplateBuMap(data);
        if (errors.length > 0) {
            return res.status(400).json({ error: nutanixValidation.describeErrors('Template-BU Mapping rejected', errors), rows: errors });
        }
        writeDataSync('server_operation/template_bu_map.json', data);
        auditLog(req.user.username, 'Nutanix Manager', 'Updated Template-BU Mapping Table');
        res.json({ success: true, message: 'Template-BU mapping table saved successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write Template-BU mapping table: ' + err.message });
    }
});

const vmName = (vm) => vm.spec?.name || vm.status?.name || vm.name;

// GET /templates
router.get('/templates', async (req, res) => {
    const cfg = nutanixClient.resolveConfig();
    const cluster = String(req.query.cluster || '').trim();

    if (!cfg.primaryIp || !cfg.account || !cfg.pwd) {
        return res.json([]);
    }

    const warnings = [];
    const isTemplate = (name) => !!name && name.toLowerCase().startsWith('template_');

    if (cfg.isPeMode) {
        // PE Mode: template VMs from every configured PE
        const perPe = await Promise.all(cfg.peIps.map(async (peIp) => {
            try {
                const entities = await nutanixClient.listV2(nutanixClient.createClient(peIp, cfg), '/v2.0/vms', { timeout: 20000 });
                return entities.map(vm => vm.name).filter(isTemplate);
            } catch (err) {
                const error = nutanixClient.errorMessage(err);
                console.error(`[Nutanix] Error fetching templates from PE ${peIp}:`, error);
                warnings.push({ source: `PE ${peIp}`, error });
                return [];
            }
        }));
        setWarningsHeader(res, warnings);
        return res.json([...new Set(perPe.flat())].sort());
    }

    // PC Mode: v3 vms/list, filtered by cluster when one is given, otherwise cluster by cluster
    const pc = nutanixClient.createClient(cfg.pcIp, cfg);
    let entities = [];
    const clusterWarnings = [];
    try {
        const clusterNames = cluster
            ? [cluster]
            : (await nutanixClient.listV3(pc, 'cluster', { timeout: 10000 })).map(c => c.spec?.name).filter(Boolean);
        const lists = await nutanixClient.mapLimit(clusterNames, 5, (name) =>
            nutanixClient.listV3(pc, 'vm', { filter: `cluster_name==${name}`, timeout: 15000 }).catch((err) => {
                clusterWarnings.push({ source: `cluster ${name}`, error: nutanixClient.errorMessage(err) });
                return [];
            }));
        entities = lists.flat();
    } catch (err) {
        console.warn('[Nutanix] Could not list clusters for the template query:', nutanixClient.errorMessage(err));
    }

    if (entities.length === 0) {
        // Fallback: one unfiltered list (cluster filter rejected or cluster list unavailable)
        try {
            entities = await nutanixClient.listV3(pc, 'vm', { timeout: 45000 });
        } catch (err) {
            const error = nutanixClient.errorMessage(err);
            console.error('[Nutanix] PC mode v3 list retry failed:', error);
            warnings.push({ source: `PC ${cfg.pcIp}`, error });
        }
    } else {
        warnings.push(...clusterWarnings);
    }

    const target = cluster.toLowerCase();
    const templates = entities
        .filter(vm => {
            if (!isTemplate(vmName(vm))) return false;
            if (!target) return true;
            const cName = (vm.spec?.cluster_reference?.name || vm.status?.cluster_reference?.name || vm.cluster_name || '').toLowerCase();
            const cUuid = (vm.spec?.cluster_reference?.uuid || vm.status?.cluster_reference?.uuid || vm.cluster_uuid || '').toLowerCase();
            return !(cName || cUuid) || cName === target || cUuid === target;
        })
        .map(vmName);

    setWarningsHeader(res, warnings);
    res.json([...new Set(templates)].sort());
});

// GET /clusters
router.get('/clusters', async (req, res) => {
    const cfg = nutanixClient.resolveConfig();

    if (!cfg.primaryIp || !cfg.account || !cfg.pwd) {
        return res.json([]);
    }

    if (cfg.isPeMode) {
        // PE Mode: one cluster per configured PE
        const warnings = [];
        const names = await Promise.all(cfg.peIps.map(async (peIp) => {
            try {
                const cluster = await nutanixClient.createClient(peIp, cfg).get('/v2.0/cluster', { timeout: 20000 });
                return (cluster && cluster.name) || `PE_Cluster_${peIp}`;
            } catch (err) {
                const error = nutanixClient.errorMessage(err);
                console.error(`[Nutanix] Error fetching cluster from PE ${peIp}:`, error);
                warnings.push({ source: `PE ${peIp}`, error });
                return null;
            }
        }));
        setWarningsHeader(res, warnings);
        return res.json([...new Set(names.filter(Boolean))].sort());
    }

    try {
        const entities = await nutanixClient.listV3(nutanixClient.createClient(cfg.pcIp, cfg), 'cluster', { timeout: 20000 });
        res.json([...new Set(entities.map(c => c.spec?.name).filter(Boolean))].sort());
    } catch (err) {
        console.error('[Nutanix] Error fetching clusters:', err.message);
        res.status(500).json({ error: 'Failed to fetch clusters: ' + nutanixClient.errorMessage(err) });
    }
});

// GET /settings-check
router.get('/settings-check', (req, res) => {
    const isPeMode = nutanixClient.resolveConfig().isPeMode;
    res.json({
        pcIp: !!process.env.NUTANIX_PC_IP,
        pcAccount: !!process.env.NUTANIX_PC_ACCOUNT,
        pcPwd: !!process.env.NUTANIX_PC_PWD,
        peIp: !!process.env.NUTANIX_PE_IP,
        peAccount: !!process.env.NUTANIX_PE_ACCOUNT,
        pePwd: !!process.env.NUTANIX_PE_PWD,
        isPeMode,
        adUser: !!process.env.AD_ADMIN_USER,
        adPwd: !!process.env.AD_ADMIN_PWD,
        adDomain: !!process.env.ALLOWED_AD_DOMAIN,
        pcIpValue: process.env.NUTANIX_PC_IP || '',
        peIpValue: process.env.NUTANIX_PE_IP || '',
        adUserValue: process.env.AD_ADMIN_USER || '',
        adDomainValue: process.env.ALLOWED_AD_DOMAIN || ''
    });
});

/**
 * Validates the environment of every clone row. Returns { names: [canonical per row], errors: [{ row, ip, name, value, error }], allowed }.
 * No default is applied: an empty environment is an error.
 */
function validateCloneEnvironments(vms) {
    const envs = envRegistry.getEnvironments();
    const allowed = envRegistry.allowedNames(envs);
    const names = [];
    const errors = [];
    (vms || []).forEach((vm, i) => {
        const raw = vm ? String(vm.Env || vm.envName || vm.environment || '').trim() : '';
        const base = { row: i + 1, ip: String((vm && (vm.IP || vm.ip)) || ''), name: String((vm && (vm.Name || vm.name)) || '') };
        if (!raw) { errors.push({ ...base, value: '', error: `Environment is required (allowed: ${allowed.join(', ')})` }); names.push(''); return; }
        const env = envRegistry.resolveEnv(raw, envs);
        if (!env) { errors.push({ ...base, value: raw, error: `Unknown environment "${raw}" (allowed: ${allowed.join(', ')})` }); names.push(''); return; }
        names.push(env.name);
    });
    return { names, errors, allowed };
}

// POST /clone
router.post('/clone', canOperate, async (req, res) => {
    if (cloneTask().status().running) {
        return res.status(400).json({ error: 'A cloning provisioning task is currently running. Please wait for it to complete.' });
    }

    const { vms, localAdminPassword } = req.body;
    if (!vms || !Array.isArray(vms) || vms.length === 0) {
        return res.status(400).json({ error: 'No VMs provided for cloning.' });
    }

    // Every VM needs an environment from the global list (id, name or code, case-insensitive), checked
    // BEFORE anything starts; the canonical name is what reaches the clone job and the Server List
    const envCheck = validateCloneEnvironments(vms);
    if (envCheck.errors.length > 0) {
        return res.status(400).json({
            error: `Environment check failed for ${envCheck.errors.length} VM(s): ${envCheck.errors.slice(0, 10).map(e => `${e.name || e.ip || `row ${e.row}`}: ${e.error}`).join('; ')}`,
            rows: envCheck.errors,
            allowed: envCheck.allowed
        });
    }
    vms.forEach((vm, i) => { vm.Env = envCheck.names[i]; });

    const hasWindowsVM = vms.some(vm => {
        const os = vm.OS || '';
        return !os.match(/linux|ubuntu|centos|rhel|redhat|debian|rocky|alma|suse|sles/i);
    });

    if (hasWindowsVM && !localAdminPassword) {
        return res.status(400).json({ error: 'Local Administrator password is required for Windows VM customization.' });
    }

    const isPeMode = nutanixClient.resolveConfig().isPeMode;
    const ip = isPeMode ? process.env.NUTANIX_PE_IP : process.env.NUTANIX_PC_IP;
    const account = isPeMode ? process.env.NUTANIX_PE_ACCOUNT : process.env.NUTANIX_PC_ACCOUNT;
    const pwd = isPeMode ? process.env.NUTANIX_PE_PWD : process.env.NUTANIX_PC_PWD;
    const adUser = process.env.AD_ADMIN_USER;
    const adPwd = process.env.AD_ADMIN_PWD;
    const adDomain = process.env.ALLOWED_AD_DOMAIN;

    if (hasWindowsVM) {
        if (!ip || !account || !pwd || !adUser || !adPwd) {
            return res.status(400).json({ error: `Nutanix ${isPeMode ? 'PE' : 'PC'} and AD Domain Admin credentials are not configured in system Settings.` });
        }
    } else {
        if (!ip || !account || !pwd) {
            return res.status(400).json({ error: `Nutanix ${isPeMode ? 'PE' : 'PC'} credentials are not configured in system Settings.` });
        }
    }

    // Load current IP switch map
    let ipSwitchMap = [];
    try {
        ipSwitchMap = readDataSync('server_operation/ip_switch_map.json', []);
    } catch (e) {
        console.error('[Nutanix] Failed to parse IP switch map: ', e);
    }

    // Read Remote Install (Server Provision) settings dynamically from settings config
    const config = readEnv();
    // One shared parser (lib/provisioningConfig.js) for Server Provision and Nutanix Clone VM
    const remoteInstallConfig = provisioningConfig.nutanixRemoteInstallConfig(config);

    // Load current Template BU map
    let templateBuMap = [];
    try {
        templateBuMap = readDataSync('server_operation/template_bu_map.json', []);
    } catch (e) {
        console.error('[Nutanix] Failed to parse Template BU map: ', e);
    }

    // Sanitize VM objects to prevent duplicate case-insensitive keys (PS5.1 ConvertFrom-Json compatibility)
    const cleanBatchList = vms.map(vm => ({
        Zone: vm.Zone || vm.zone || vm.Env || '',
        Platform: vm.Platform || vm.platform || vm.Zone || vm.zone || '',
        Name: vm.Name || vm.name || vm.hostname || '',
        IP: vm.IP || vm.ip || '',
        NumCore: parseInt(vm.NumCore || vm.numCore || vm.cpuCores || vm.cpu || 4, 10),
        MemoryGB: parseInt(vm.MemoryGB || vm.memoryGB || vm.ram || 8, 10),
        MemoryMiB: parseInt(vm.MemoryMiB || vm.memoryMiB || (vm.MemoryGB || vm.memoryGB || 8) * 1024, 10),
        OS: vm.OS || vm.os || '',
        BU: vm.BU || vm.bu || vm.businessUnit || 'Default',
        Application: vm.Application || vm.application || vm.applicationName || '',
        DiskInfo: vm.DiskInfo || vm.diskInfo || {}
    }));

    const params = {
        PrismCentralIP: ip,
        NUser: account,
        NPass: pwd,
        JoinUser: adUser,
        JoinPass: adPwd,
        AllowedADDomain: adDomain || '',
        LocalAdminPass: localAdminPassword,
        LinuxAdminPass: config.LINUX_ADMIN_PWD || process.env.LINUX_ADMIN_PWD || '',
        BatchList: cleanBatchList,
        IPSwitchMap: ipSwitchMap,
        TemplateBUMap: templateBuMap,
        RemoteInstallConfig: remoteInstallConfig
    };

    try {
        // Credentials reach the script on stdin only; lib/nutanixCloneTask.js owns the process, its deadline,
        // the per-VM follow-up (Linux software, Server List) and the persisted status
        const scriptName = isPeMode ? 'nutanix_clone_vm_pe_api.ps1' : 'nutanix_clone_vm_api.ps1';
        cloneTask().start({
            scriptPath: path.join(__dirname, '../lib/', scriptName),
            params,
            vms,
            user: req.user?.username || 'SYSTEM',
            mode: isPeMode ? 'PE' : 'PC'
        });
        auditLog(req.user.username, 'Nutanix Manager', `Triggered background clone provisioning task for ${vms.length} VMs`);
        res.json({ success: true, message: 'Cloning task started in the background.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to initialize clone operation: ' + err.message });
    }
});

// GET /clone-status
router.get('/clone-status', (req, res) => {
    res.json(cloneTask().status());
});

// GET /clone-logs
router.get('/clone-logs', (req, res) => {
    try {
        const logFile = cloneTask().logFile;
        if (!fs.existsSync(logFile)) {
            return res.send('');
        }
        const logs = fs.readFileSync(logFile, 'utf8');
        res.send(logs);
    } catch (err) {
        res.status(500).send('Error reading logs: ' + err.message);
    }
});

/** All non-CVM VMs of one PE (v2.0), normalized to the v3 shape. Throws if the VM list itself fails. */
async function fetchPeVms(peIp, creds) {
    const client = nutanixClient.createClient(peIp, creds);
    const params = { include_vm_disk_config: true, include_vm_nic_config: true };
    const [entities, hosts, cluster] = await Promise.all([
        nutanixClient.listV2(client, '/v2.0/vms', { params, timeout: 30000 }),
        nutanixClient.listV2(client, '/v2.0/hosts', { timeout: 15000 }).catch(() => []),
        client.get('/v2.0/cluster', { timeout: 10000 }).catch((err) => {
            console.warn(`[Nutanix] Could not fetch cluster name for ${peIp}:`, err.message);
            return null;
        }),
    ]);
    const hostMap = {};
    hosts.forEach(h => { if (h.uuid && h.name) hostMap[h.uuid] = h.name; });
    const clusterName = (cluster && cluster.name) || `PE_Cluster_${peIp}`;
    return entities
        .filter(vm => !nutanixClient.isCvm(vm.name))
        .map(vm => nutanixClient.normalizeV2Vm(vm, { clusterName, hostMap }));
}

/** VMs from every PE; failures become warnings so the caller can tell which PE is missing. */
async function fetchAllPeVms(peIps, creds) {
    const warnings = [];
    const lists = await Promise.all(peIps.map(peIp => fetchPeVms(peIp, creds).catch((err) => {
        const error = nutanixClient.errorMessage(err);
        console.error(`[Nutanix] Error fetching from PE IP ${peIp}:`, error);
        warnings.push({ source: `PE ${peIp}`, error });
        return [];
    })));
    return { vms: lists.flat(), warnings };
}

router.post('/vms', async (req, res) => {
    const cfg = nutanixClient.resolveConfig();

    if (!cfg.primaryIp || !cfg.account || !cfg.pwd) {
        return res.status(400).json({ error: `Nutanix ${cfg.isPeMode ? 'Prism Element' : 'Prism Central'} credentials are not configured in Settings.` });
    }

    try {
        if (cfg.isPeMode) {
            const { vms, warnings } = await fetchAllPeVms(cfg.peIps, cfg);
            if (vms.length === 0 && warnings.length > 0) {
                return res.status(502).json({ error: 'No Prism Element answered: ' + warnings.map(w => `${w.source}: ${w.error}`).join('; '), warnings });
            }
            return res.json({ success: true, vms, warnings, pcIp: cfg.peIps.join(','), isPeMode: true });
        }

        // PC Mode: the per-PE v2 list is faster when PE IPs are configured; fall back to PC v3 when it returns nothing
        if (cfg.peIps.length > 0) {
            const { vms, warnings } = await fetchAllPeVms(cfg.peIps, cfg);
            if (vms.length > 0) {
                return res.json({ success: true, vms, warnings, pcIp: cfg.pcIp, isPeMode: false });
            }
        }

        const pc = nutanixClient.createClient(cfg.pcIp, cfg);
        let entities = [];
        const clusterWarnings = [];
        try {
            const clusters = await nutanixClient.listV3(pc, 'cluster', { timeout: 10000 });
            const lists = await nutanixClient.mapLimit(clusters, 5, (c) => {
                const name = c.spec?.name;
                const filter = name ? `cluster_name==${name}` : `cluster_uuid==${c.metadata?.uuid}`;
                return nutanixClient.listV3(pc, 'vm', { filter, timeout: 15000 }).catch((err) => {
                    clusterWarnings.push({ source: `cluster ${name || c.metadata?.uuid}`, error: nutanixClient.errorMessage(err) });
                    return [];
                });
            });
            entities = lists.flat();
        } catch (err) {
            console.warn('[Nutanix] Could not fetch clusters list for cluster-by-cluster VM query:', nutanixClient.errorMessage(err));
        }

        const warnings = [];
        if (entities.length === 0) {
            // Secondary fallback: one unfiltered list; if this fails too the request fails
            entities = await nutanixClient.listV3(pc, 'vm', { timeout: 45000 });
        } else {
            warnings.push(...clusterWarnings);
        }

        const vms = entities.filter(vm => !nutanixClient.isCvm(vm.spec?.name));

        // v3 host_reference usually carries only the uuid: resolve names from the host list
        if (vms.some(vm => vm.status?.resources?.host_reference?.uuid && !vm.status.resources.host_reference.name)) {
            const hosts = await nutanixClient.listV3(pc, 'host', { timeout: 15000 }).catch((err) => {
                warnings.push({ source: 'host names', error: nutanixClient.errorMessage(err) });
                return [];
            });
            const hostMap = {};
            hosts.forEach(h => { const n = h.spec?.name || h.status?.name; if (h.metadata?.uuid && n) hostMap[h.metadata.uuid] = n; });
            vms.forEach(vm => {
                const ref = vm.status?.resources?.host_reference;
                if (ref && ref.uuid && !ref.name && hostMap[ref.uuid]) ref.name = hostMap[ref.uuid];
            });
        }

        return res.json({ success: true, vms, warnings, pcIp: cfg.pcIp });
    } catch (err) {
        console.error('[Nutanix] Error fetching VMs:', err.message);
        res.status(500).json({ error: err.response?.data ? JSON.stringify(err.response.data) : err.message });
    }
});

// Detect OS for a single IP using osDetect.js (ping + port probe)
router.post('/detect-os', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'Missing ip' });

    try {
        const result = await detectOs(ip);
        res.json({ ip, os: result.os, status: result.status });
    } catch {
        res.json({ ip, os: 'Unknown', status: 'error' });
    }
});


// Power requests in flight at once, so a large selection does not hit Prism with hundreds of parallel calls
const VM_ACTION_CONCURRENCY = 5;
const PC_PUT_ATTEMPTS = 3;

// Prism Central v3 only knows power_state ON/OFF; the mechanism picks hard vs. guest (ACPI) shutdown
const PC_POWER_SPEC = {
    OFF: { power_state: 'OFF', mechanism: 'HARD' },
    ACPI_SHUTDOWN: { power_state: 'OFF', mechanism: 'ACPI' },
};

/**
 * One PC v3 power change. The PUT sends back metadata.spec_version from the GET, so Prism rejects it with 409
 * when the VM was changed in between instead of overwriting that change; the GET/PUT is then repeated.
 */
async function setPcPowerState(pc, uuid, actionType) {
    const target = PC_POWER_SPEC[actionType];
    if (!target) {
        return { uuid, status: 'Error', message: `${actionType} is not available through Prism Central v3 (only OFF and ACPI_SHUTDOWN)` };
    }
    for (let attempt = 1; ; attempt++) {
        try {
            const vm = await pc.get(`/v3/vms/${uuid}`, { timeout: 10000 });
            if (!vm || !vm.spec || !vm.spec.resources) {
                return { uuid, status: 'Error', message: 'Invalid VM structure returned' };
            }
            vm.spec.resources.power_state = target.power_state;
            vm.spec.resources.power_state_mechanism = { ...(vm.spec.resources.power_state_mechanism || {}), mechanism: target.mechanism };
            // status is read-only in v3 and must not be sent back
            await pc.put(`/v3/vms/${uuid}`, { spec: vm.spec, metadata: vm.metadata }, { timeout: 10000 });
            return { uuid, status: 'Success' };
        } catch (err) {
            if (err.response?.status === 409 && attempt < PC_PUT_ATTEMPTS) continue;
            return { uuid, status: 'Error', message: nutanixClient.errorMessage(err) };
        }
    }
}

router.post('/vm-action', canOperate, async (req, res) => {
    const { uuids, actionType } = req.body || {};
    const cfg = nutanixClient.resolveConfig();

    const { errors } = nutanixValidation.validateVmAction(uuids, actionType);
    if (errors.length > 0) {
        return res.status(400).json({ error: nutanixValidation.describeErrors('VM action rejected', errors), rows: errors });
    }

    if (cfg.isPeMode) {
        if (cfg.peIps.length === 0 || !cfg.account || !cfg.pwd) {
            return res.status(400).json({ error: 'Nutanix PE credentials not configured.' });
        }
        const clients = cfg.peIps.map(peIp => nutanixClient.createClient(peIp, cfg));

        // The UUID is not tied to a PE in the request: try each PE until one accepts it
        const results = await nutanixClient.mapLimit(uuids, VM_ACTION_CONCURRENCY, async (uuid) => {
            let lastError = 'VM not found on configured PE IPs';
            for (const client of clients) {
                try {
                    await client.post(`/v2.0/vms/${uuid}/set_power_state`, { transition: actionType }, { timeout: 10000 });
                    return { uuid, status: 'Success' };
                } catch (err) {
                    lastError = nutanixClient.errorMessage(err);
                }
            }
            return { uuid, status: 'Error', message: lastError };
        });

        auditLog(req.user.username, 'Nutanix Manager', `Executed ${actionType} on ${uuids.length} VMs (PE Mode)`);
        return res.json({ success: true, results });
    }

    if (!cfg.pcIp || !cfg.account || !cfg.pwd) {
        return res.status(400).json({ error: 'Nutanix credentials not configured.' });
    }
    const pc = nutanixClient.createClient(cfg.pcIp, cfg);
    const results = await nutanixClient.mapLimit(uuids, VM_ACTION_CONCURRENCY, (uuid) => setPcPowerState(pc, uuid, actionType));
    auditLog(req.user.username, 'Nutanix Manager', `Executed ${actionType} on ${uuids.length} VMs`);
    res.json({ success: true, results });
});


router.validateCloneEnvironments = validateCloneEnvironments;
router.setCloneTaskForTest = (getter) => { cloneTask = getter || getCloneTask; };
module.exports = router;
