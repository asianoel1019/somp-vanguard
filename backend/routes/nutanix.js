const express = require('express');
const router = express.Router();
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { requireAuth, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { detectOs } = require('../lib/osDetect');
const { readEnv } = require('../lib/envEditor');
const provisioningConfig = require('../lib/provisioningConfig');
const { executeSSH } = require('../lib/ssh');
const envRegistry = require('../lib/environmentRegistry');





const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';

let currentTask = {
    running: false,
    startTime: null,
    vms: [],
    logFile: path.join(BASE_DATA_DIR, 'logs', 'nutanix_clone.log')
};

router.use(requireAuth);
router.use(checkFeature('nutanix')); // only NutanixManager / NutanixCloneVM call these endpoints

// GET /connection-status
router.get('/connection-status', async (req, res) => {
    const isPeMode = process.env.NUTANIX_MODE === 'PE' || (!process.env.NUTANIX_PC_IP && process.env.NUTANIX_PE_IP);
    const peIpsStr = process.env.NUTANIX_PE_IP || '';
    const ip = isPeMode ? peIpsStr.split(',')[0].trim() : process.env.NUTANIX_PC_IP;
    const account = isPeMode ? process.env.NUTANIX_PE_ACCOUNT : process.env.NUTANIX_PC_ACCOUNT;
    const pwd = isPeMode ? process.env.NUTANIX_PE_PWD : process.env.NUTANIX_PC_PWD;

    if (!ip || !account || !pwd) {
        return res.json({ success: false, status: 'Offline', error: 'Settings are incomplete.', ip: isPeMode ? peIpsStr : ip, isPeMode });
    }

    try {
        const url = isPeMode 
            ? `https://${ip}:9440/api/nutanix/v2.0/cluster`
            : `https://${ip}:9440/api/nutanix/v3/users/me`;
        const auth = Buffer.from(`${account}:${pwd}`).toString('base64');
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });

        const headers = {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
        };

        await axios.get(url, { headers, httpsAgent, proxy: false, timeout: 20000 });
        res.json({ success: true, status: 'Online', ip: isPeMode ? peIpsStr : ip, isPeMode });
    } catch (err) {
        console.error('[Nutanix] Connection check failed:', err.message);
        res.json({ success: false, status: 'Offline', error: err.message, ip: isPeMode ? peIpsStr : ip, isPeMode });
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
router.post('/ip-switch-map', async (req, res) => {
    try {
        const data = req.body;
        if (!Array.isArray(data)) {
            return res.status(400).json({ error: 'Payload must be an array of mapping entries.' });
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
router.post('/template-bu-map', async (req, res) => {
    try {
        const data = req.body;
        if (!Array.isArray(data)) {
            return res.status(400).json({ error: 'Payload must be an array of mapping entries.' });
        }
        writeDataSync('server_operation/template_bu_map.json', data);
        auditLog(req.user.username, 'Nutanix Manager', 'Updated Template-BU Mapping Table');
        res.json({ success: true, message: 'Template-BU mapping table saved successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to write Template-BU mapping table: ' + err.message });
    }
});

// GET /templates
router.get('/templates', async (req, res) => {
    const isPeMode = process.env.NUTANIX_MODE === 'PE' || (!process.env.NUTANIX_PC_IP && process.env.NUTANIX_PE_IP);
    const ip = isPeMode ? process.env.NUTANIX_PE_IP.split(',')[0].trim() : process.env.NUTANIX_PC_IP;
    let account = isPeMode ? process.env.NUTANIX_PE_ACCOUNT : process.env.NUTANIX_PC_ACCOUNT;
    let pwd = isPeMode ? process.env.NUTANIX_PE_PWD : process.env.NUTANIX_PC_PWD;
    const { cluster } = req.query;

    if (account && account.startsWith('enc:')) {
        try { const { decryptText } = require('../lib/crypto'); account = decryptText(account.substring(4)); } catch(e){}
    }
    if (pwd && pwd.startsWith('enc:')) {
        try { const { decryptText } = require('../lib/crypto'); pwd = decryptText(pwd.substring(4)); } catch(e){}
    }

    if (!ip || !account || !pwd) {
        return res.json([]);
    }

    try {
        const auth = Buffer.from(`${account}:${pwd}`).toString('base64');
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });
        const headers = {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
        };

        if (isPeMode) {
            // PE Mode: fetch local VMs from all configured PE IPs using GET /vms
            const peIps = process.env.NUTANIX_PE_IP.split(',').map(s => s.trim()).filter(s => s);
            let aggregatedTemplates = [];
            
            const fetchPromises = peIps.map(async (peIp) => {
                try {
                    const url = `https://${peIp}:9440/api/nutanix/v2.0/vms`;
                    const response = await axios.get(url, { headers, httpsAgent, proxy: false, timeout: 20000 });
                    const entities = response.data.entities || [];
                    const templates = entities
                        .map(vm => vm.name)
                        .filter(name => name && name.toLowerCase().startsWith('template_'));
                    aggregatedTemplates = aggregatedTemplates.concat(templates);
                } catch (err) {
                    console.error(`[Nutanix] Error fetching templates from PE ${peIp}:`, err.message);
                }
            });
            await Promise.all(fetchPromises);
            const uniqueTemplates = [...new Set(aggregatedTemplates)].sort();
            return res.json(uniqueTemplates);
        } else {
            // PC Mode: fetch using v3 /vms/list with cluster_name filter if cluster is provided
            const url = `https://${ip}:9440/api/nutanix/v3/vms/list`;
            const pcAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
            let entities = [];

            if (cluster && cluster.trim()) {
                const targetCluster = cluster.trim();
                try {
                    const payload = { kind: "vm", length: 1000, filter: `cluster_name==${targetCluster}` };
                    const response = await axios.post(url, payload, { headers, httpsAgent: pcAgent, proxy: false, timeout: 15000 });
                    if (response.data && response.data.entities) {
                        entities = response.data.entities;
                    }
                } catch (clusterErr) {}
            } else {
                // If no cluster provided, query clusters first, then fetch VMs per cluster in parallel (50ms per cluster)
                try {
                    const clustersRes = await axios.post(`https://${ip}:9440/api/nutanix/v3/clusters/list`, { kind: "cluster", length: 500 }, { headers, httpsAgent: pcAgent, proxy: false, timeout: 10000 });
                    const clusterEntities = clustersRes.data?.entities || [];

                    if (clusterEntities.length > 0) {
                        const clusterFetchPromises = clusterEntities.map(async (c) => {
                            const clusterName = c.spec?.name;
                            const clusterUuid = c.metadata?.uuid;
                            try {
                                const filterExpr = clusterName ? `cluster_name==${clusterName}` : `cluster_uuid==${clusterUuid}`;
                                const res = await axios.post(url, { kind: "vm", length: 1000, filter: filterExpr }, { headers, httpsAgent: pcAgent, proxy: false, timeout: 10000 });
                                return res.data?.entities || [];
                            } catch (err) { return []; }
                        });
                        const results = await Promise.all(clusterFetchPromises);
                        results.forEach(list => { entities = entities.concat(list); });
                    }
                } catch (cErr) {}
            }

            // Fallback: If EVERYTHING failed (e.g. cluster query threw 400), try single light payload
            if (entities.length === 0) {
                try {
                    const payload = { kind: "vm", length: 1000 };
                    const response = await axios.post(url, payload, { headers, httpsAgent: pcAgent, proxy: false, timeout: 45000 });
                    entities = response.data.entities || [];
                } catch (err2) {
                    console.error('[Nutanix] PC mode v3 list retry failed:', err2.message);
                }
            }


            const templates = entities
                .filter(vm => {
                    const name = vm.spec?.name || vm.status?.name || vm.name;
                    if (!name || !name.toLowerCase().startsWith('template_')) {
                        return false;
                    }
                    if (cluster && cluster.trim()) {
                        const targetCluster = cluster.trim().toLowerCase();
                        const cName = (vm.spec?.cluster_reference?.name || vm.status?.cluster_reference?.name || vm.cluster_name || '').toLowerCase();
                        const cUuid = (vm.spec?.cluster_reference?.uuid || vm.status?.cluster_reference?.uuid || vm.cluster_uuid || '').toLowerCase();

                        if (cName || cUuid) {
                            const isMatch = cName === targetCluster || cUuid === targetCluster;
                            if (!isMatch) {
                                return false;
                            }
                        }
                    }
                    return true;
                })
                .map(vm => vm.spec?.name || vm.status?.name || vm.name);

            const uniqueTemplates = [...new Set(templates)].sort();
            res.json(uniqueTemplates);
        }
    } catch (err) {
        console.error('[Nutanix] Error fetching templates:', err.response?.data || err.message);
        res.json([]);
    }
});

// GET /clusters
router.get('/clusters', async (req, res) => {
    const isPeMode = process.env.NUTANIX_MODE === 'PE' || (!process.env.NUTANIX_PC_IP && process.env.NUTANIX_PE_IP);
    const ip = isPeMode ? process.env.NUTANIX_PE_IP.split(',')[0].trim() : process.env.NUTANIX_PC_IP;
    const account = isPeMode ? process.env.NUTANIX_PE_ACCOUNT : process.env.NUTANIX_PC_ACCOUNT;
    const pwd = isPeMode ? process.env.NUTANIX_PE_PWD : process.env.NUTANIX_PC_PWD;

    if (!ip || !account || !pwd) {
        return res.json([]);
    }

    try {
        const auth = Buffer.from(`${account}:${pwd}`).toString('base64');
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });
        const headers = {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
        };

        if (isPeMode) {
            // PE Mode: Fetch all configured PE clusters in parallel
            const peIps = process.env.NUTANIX_PE_IP.split(',').map(s => s.trim()).filter(s => s);
            let aggregatedClusters = [];
            
            const fetchPromises = peIps.map(async (peIp) => {
                try {
                    const url = `https://${peIp}:9440/api/nutanix/v2.0/cluster`;
                    const response = await axios.get(url, { headers, httpsAgent, proxy: false, timeout: 20000 });
                    const clusterName = response.data.name || `PE_Cluster_${peIp}`;
                    aggregatedClusters.push(clusterName);
                } catch (err) {
                    console.error(`[Nutanix] Error fetching cluster from PE ${peIp}:`, err.message);
                }
            });
            await Promise.all(fetchPromises);
            const uniqueClusters = [...new Set(aggregatedClusters)].sort();
            return res.json(uniqueClusters);
        } else {
            // PC Mode
            const url = `https://${ip}:9440/api/nutanix/v3/clusters/list`;
            const payload = {
                kind: "cluster",
                length: 500
            };

            const response = await axios.post(url, payload, { headers, httpsAgent, proxy: false, timeout: 20000 });
            const entities = response.data.entities || [];
            const clusters = entities
                .map(c => c.spec?.name)
                .filter(name => name);

            const uniqueClusters = [...new Set(clusters)].sort();
            res.json(uniqueClusters);
        }
    } catch (err) {
        console.error('[Nutanix] Error fetching clusters:', err.message);
        res.status(500).json({ error: 'Failed to fetch clusters: ' + err.message });
    }
});

// GET /settings-check
router.get('/settings-check', (req, res) => {
    const isPeMode = process.env.NUTANIX_MODE === 'PE' || (!process.env.NUTANIX_PC_IP && process.env.NUTANIX_PE_IP);
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
router.post('/clone', async (req, res) => {
    if (currentTask.running) {
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

    const isPeMode = process.env.NUTANIX_MODE === 'PE' || (!process.env.NUTANIX_PC_IP && process.env.NUTANIX_PE_IP);
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
    const installCfg = provisioningConfig.loadInstallConfig(config);
    const remoteInstallConfig = provisioningConfig.nutanixRemoteInstallConfig(config);

    // Load current Template BU map
    let templateBuMap = [];
    try {
        templateBuMap = readDataSync('server_operation/template_bu_map.json', []);
    } catch (e) {
        console.error('[Nutanix] Failed to parse Template BU map: ', e);
    }

    // Setup parameter file in backend/lib/ alongside the PowerShell scripts
    const paramFileName = `nutanix_clone_params_${Date.now()}.json`;
    const paramFilePath = path.join(__dirname, '../lib/', paramFileName);

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
        const libDir = path.dirname(paramFilePath);
        if (!fs.existsSync(libDir)) {
            fs.mkdirSync(libDir, { recursive: true });
        }
        fs.writeFileSync(paramFilePath, JSON.stringify(params, null, 2), 'utf8');

        if (!fs.existsSync(paramFilePath)) {
            throw new Error(`Failed to create parameter file at: ${paramFilePath}`);
        }
        
        // Ensure log file parent directory exists and clear log file
        const logFileDir = path.dirname(currentTask.logFile);
        if (!fs.existsSync(logFileDir)) {
            fs.mkdirSync(logFileDir, { recursive: true });
        }
        fs.writeFileSync(currentTask.logFile, `[${new Date().toISOString()}] Starting headless Nutanix ${isPeMode ? 'PE' : 'PC'} VM provisioning...\n`, 'utf8');

        // Spawning PowerShell process in the background
        const scriptName = isPeMode ? 'nutanix_clone_vm_pe_api.ps1' : 'nutanix_clone_vm_api.ps1';
        const scriptPath = path.join(__dirname, '../lib/', scriptName).replace(/\\/g, '/');
        const safeParamFilePath = paramFilePath.replace(/\\/g, '/');
        const psCmd = `& '${scriptPath}' -ParamFile '${safeParamFilePath}'`;
        const psProcess = spawn('powershell.exe', [
            '-NonInteractive',
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-Command', psCmd
        ]);

        const logStream = fs.createWriteStream(currentTask.logFile, { flags: 'a' });
        psProcess.stdout.pipe(logStream);
        psProcess.stderr.pipe(logStream);

        psProcess.on('error', (err) => {
            fs.appendFileSync(currentTask.logFile, `\n[Node.js Process Error] Failed to launch PowerShell: ${err.message}\n`);
            currentTask.running = false;
            try { require('../lib/websocket').broadcastEvent('NUTANIX_CLONE_COMPLETED', { success: false }); } catch(e) {}
        });

        psProcess.on('close', async (code) => {
            fs.appendFileSync(currentTask.logFile, `\n[Node.js Task Exit] PowerShell process finished with exit code ${code}\n`);
            
            if (code === 0) {
                fs.appendFileSync(currentTask.logFile, `\n[Linux Provisioning] Analyzing VMs for Linux software deployments...\n`);
                const linuxVMs = vms.filter(vm => {
                    const os = vm.OS || '';
                    return !!os.match(/linux|ubuntu|centos|rhel|redhat|debian|rocky|alma|suse|sles/i);
                });

                if (linuxVMs.length > 0) {
                    fs.appendFileSync(currentTask.logFile, `[Linux Provisioning] Found ${linuxVMs.length} Linux target VMs. Initializing SSH software installation pipelines...\n`);
                    
                    const linuxUser = config.LINUX_ADMIN_USER || process.env.LINUX_ADMIN_USER || 'root';
                    const linuxPwd = config.LINUX_ADMIN_PWD || process.env.LINUX_ADMIN_PWD || '';

                    for (const vm of linuxVMs) {
                        const vmIP = vm.IP;
                        const vmName = vm.VMName || vm.Name;
                        const vmBU = vm.BU || 'Basic';
                        const selectedNames = provisioningConfig.selectedNamesFor(installCfg, vmBU, 'linux');
                        const selectedSoftware = provisioningConfig.resolveSoftware(installCfg, vmBU, 'linux');

                        if (selectedSoftware.length === 0) {
                            fs.appendFileSync(currentTask.logFile, `[Linux Provisioning] VM ${vmName} (${vmIP}) - BU [${vmBU}]: No Linux software mapped. Skipping.\n`);
                            continue;
                        }

                        fs.appendFileSync(currentTask.logFile, `[Linux Provisioning] VM ${vmName} (${vmIP}) - BU [${vmBU}]: Mapped software: ${selectedNames.join(', ')}\n`);
                        fs.appendFileSync(currentTask.logFile, `[Linux Provisioning] VM ${vmName} (${vmIP}): Connecting to guest via SSH on port 22...\n`);
                        
                        try {
                            // Wait up to 30 seconds for SSH port 22 to be up again after boot ON
                            let sshReady = false;
                            for (let attempt = 1; attempt <= 6; attempt++) {
                                try {
                                    await executeSSH(vmIP, linuxUser, linuxPwd, 'echo OK', { timeout: 10000 });
                                    sshReady = true;
                                    break;
                                } catch (e) {
                                    fs.appendFileSync(currentTask.logFile, `[Linux Provisioning] VM ${vmName} (${vmIP}): SSH connection attempt ${attempt}/6 failed. Retrying in 5 seconds...\n`);
                                    await new Promise(r => setTimeout(r, 5000));
                                }
                            }

                            if (!sshReady) {
                                throw new Error('SSH connection timed out after VM boot ON.');
                            }

                            fs.appendFileSync(currentTask.logFile, `[Linux Provisioning] VM ${vmName} (${vmIP}): SSH session established. Running installer commands...\n`);

                            for (const sw of selectedSoftware) {
                                fs.appendFileSync(currentTask.logFile, `=== Installing ${sw.name} inside ${vmName} ===\n`);
                                fs.appendFileSync(currentTask.logFile, `Running command: ${sw.command}\n`);
                                const resCmd = await executeSSH(vmIP, linuxUser, linuxPwd, sw.command, { timeout: 10000 });
                                fs.appendFileSync(currentTask.logFile, `stdout:\n${resCmd.stdout}\n`);
                                if (resCmd.stderr) {
                                    fs.appendFileSync(currentTask.logFile, `stderr:\n${resCmd.stderr}\n`);
                                }
                                fs.appendFileSync(currentTask.logFile, `Exit code: ${resCmd.code}\n\n`);
                            }
                            fs.appendFileSync(currentTask.logFile, `[Linux Provisioning] VM ${vmName} (${vmIP}): Software installations completed successfully! [OK]\n`);
                        } catch (err) {
                            fs.appendFileSync(currentTask.logFile, `[Linux Provisioning] VM ${vmName} (${vmIP}) ERROR: SSH deployment failed: ${err.message}\n`);
                        }
                    }
                } else {
                    fs.appendFileSync(currentTask.logFile, `[Linux Provisioning] No Linux VMs detected in batch list. Skip.\n`);
                }
            }

            // Auto-register / Upsert newly cloned VMs into Server List CMDB Meta
            if (code === 0 && Array.isArray(vms) && vms.length > 0) {
                try {
                    const serverListRoute = require('./serverList');
                    if (typeof serverListRoute.upsertClonedVms === 'function') {
                        const upsertResult = serverListRoute.upsertClonedVms(vms, req.user?.username || 'SYSTEM');
                        fs.appendFileSync(currentTask.logFile, `\n[Server List Integration] Successfully synced ${upsertResult.count} VMs to Server List (CMDB).\n`);
                    }
                } catch (syncErr) {
                    console.error('[Nutanix Clone] Error syncing to Server List:', syncErr);
                    fs.appendFileSync(currentTask.logFile, `\n[Server List Warning] Failed to auto-sync VMs to Server List: ${syncErr.message}\n`);
                }
            }

            currentTask.running = false;
            try { require('../lib/websocket').broadcastEvent('NUTANIX_CLONE_COMPLETED', { success: code === 0 }); } catch(e) {}
            try {
                if (fs.existsSync(paramFilePath)) {
                    fs.unlinkSync(paramFilePath);
                }
            } catch (err) {
                console.error('[Nutanix] Failed to delete temporary clone params file:', err);
            }
        });

        psProcess.unref();

        currentTask.running = true;
        currentTask.startTime = Date.now();
        currentTask.vms = vms;

        auditLog(req.user.username, 'Nutanix Manager', `Triggered background clone provisioning task for ${vms.length} VMs`);
        res.json({ success: true, message: 'Cloning task started in the background.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to initialize clone operation: ' + err.message });
    }
});

// GET /clone-status
router.get('/clone-status', (req, res) => {
    res.json({
        running: currentTask.running,
        startTime: currentTask.startTime,
        vms: currentTask.vms
    });
});

// GET /clone-logs
router.get('/clone-logs', (req, res) => {
    try {
        if (!fs.existsSync(currentTask.logFile)) {
            return res.send('');
        }
        const logs = fs.readFileSync(currentTask.logFile, 'utf8');
        res.send(logs);
    } catch (err) {
        res.status(500).send('Error reading logs: ' + err.message);
    }
});

router.post('/vms', async (req, res) => {
    const isPeMode = process.env.NUTANIX_MODE === 'PE' || (!process.env.NUTANIX_PC_IP && process.env.NUTANIX_PE_IP);
    const ip = isPeMode ? process.env.NUTANIX_PE_IP.split(',')[0].trim() : process.env.NUTANIX_PC_IP;
    let account = isPeMode ? process.env.NUTANIX_PE_ACCOUNT : process.env.NUTANIX_PC_ACCOUNT;
    let pwd = isPeMode ? process.env.NUTANIX_PE_PWD : process.env.NUTANIX_PC_PWD;

    if (account && account.startsWith('enc:')) {
        try { const { decryptText } = require('../lib/crypto'); account = decryptText(account.substring(4)); } catch(e){}
    }
    if (pwd && pwd.startsWith('enc:')) {
        try { const { decryptText } = require('../lib/crypto'); pwd = decryptText(pwd.substring(4)); } catch(e){}
    }

    if (!ip || !account || !pwd) {
        return res.status(400).json({ error: `Nutanix ${isPeMode ? 'Prism Element' : 'Prism Central'} credentials are not configured in Settings.` });
    }

    try {
        const auth = Buffer.from(`${account}:${pwd}`).toString('base64');
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });

        const headers = {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json'
        };

        if (isPeMode) {
            // PE Mode: call PE v2.0 VMs API for each configured PE IP in parallel
            const peIps = process.env.NUTANIX_PE_IP.split(',').map(s => s.trim()).filter(s => s);
            let aggregatedVms = [];

            const fetchPromises = peIps.map(async (peIp) => {
                try {
                    const urlVms = `https://${peIp}:9440/api/nutanix/v2.0/vms`;
                    const urlHosts = `https://${peIp}:9440/api/nutanix/v2.0/hosts`;
                    
                    const [vmsResponse, hostsResponse] = await Promise.all([
                        axios.get(urlVms, { headers, httpsAgent, proxy: false, timeout: 30000 }),
                        axios.get(urlHosts, { headers, httpsAgent, proxy: false, timeout: 15000 }).catch(e => ({ data: { entities: [] } }))
                    ]);

                    let entities = vmsResponse.data.entities || [];
                    const hostsList = hostsResponse.data.entities || [];

                    const hostMap = {};
                    hostsList.forEach(h => {
                        if (h.uuid && h.name) {
                            hostMap[h.uuid] = h.name;
                        }
                    });

                    // Try fetching actual cluster name
                    let clusterName = 'Local_PE_Cluster';
                    try {
                        const clusterRes = await axios.get(`https://${peIp}:9440/api/nutanix/v2.0/cluster`, { headers, httpsAgent, proxy: false, timeout: 10000 });
                        if (clusterRes.data?.name) {
                            clusterName = clusterRes.data.name;
                        }
                    } catch (err) {
                        console.warn(`[Nutanix] Could not fetch cluster name for ${peIp}:`, err.message);
                    }

                    // Filter CVMs
                    entities = entities.filter(vm => {
                        const name = (vm.name || '').toUpperCase();
                        return !(name.startsWith('NTNX') || name.endsWith('CVM'));
                    });

                    // Normalize to V3 PC format so the React client is fully compatible
                    const mapped = entities.map(vm => {
                        const ipAddresses = vm.ip_addresses || [];
                        const nic_list = ipAddresses.map(ipAddr => ({
                            ip_endpoint_list: [{ ip: ipAddr }]
                        }));

                        const disk_list = (vm.disk_list || []).map(disk => {
                            let sizeMib = 0;
                            if (disk.disk_size_in_bytes) {
                                sizeMib = Math.round(disk.disk_size_in_bytes / (1024 * 1024));
                            } else if (disk.disk_size_mib) {
                                sizeMib = disk.disk_size_mib;
                            }
                            return {
                                disk_size_mib: sizeMib,
                                device_properties: {
                                    device_type: disk.device_properties?.device_type || 'disk'
                                }
                            };
                        });

                        return {
                            uuid: vm.uuid,
                            metadata: {
                                uuid: vm.uuid
                            },
                            spec: {
                                name: vm.name,
                                resources: {
                                    num_vcpus_per_socket: vm.num_vcpus || 1,
                                    num_sockets: 1,
                                    memory_size_mib: vm.memory_mb || 2048
                                }
                            },
                            status: {
                                name: vm.name,
                                power_state: (vm.power_state || 'UNKNOWN').toUpperCase(),
                                cluster_reference: {
                                    name: clusterName,
                                    uuid: vm.cluster_uuid || ''
                                },
                                resources: {
                                    power_state: (vm.power_state || 'UNKNOWN').toUpperCase(),
                                    num_vcpus_per_socket: vm.num_vcpus || 1,
                                    num_sockets: 1,
                                    memory_size_mib: vm.memory_mb || 2048,
                                    host_reference: {
                                        name: (vm.host_uuid && hostMap[vm.host_uuid]) ? hostMap[vm.host_uuid] : 'N/A',
                                        uuid: vm.host_uuid || ''
                                    },
                                    nic_list: nic_list,
                                    disk_list: disk_list
                                }
                            }
                        };
                    });

                    aggregatedVms = aggregatedVms.concat(mapped);
                } catch (err) {
                    console.error(`[Nutanix] Error fetching from PE IP ${peIp}:`, err.message);
                }
            });

            await Promise.all(fetchPromises);

            return res.json({ success: true, vms: aggregatedVms, pcIp: process.env.NUTANIX_PE_IP, isPeMode: true });
        } else {
            // PC Mode: Try fast PE IP parallel fetch first if PE IPs are configured, or use PC v3 list with is_cvm==false filter
            const peIpsStr = process.env.NUTANIX_PE_IP || '';
            const peIps = peIpsStr.split(',').map(s => s.trim()).filter(s => s);

            if (peIps.length > 0) {
                let aggregatedVms = [];
                const pcAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

                const fetchPromises = peIps.map(async (peIp) => {
                    try {
                        const urlVms = `https://${peIp}:9440/api/nutanix/v2.0/vms`;
                        const urlHosts = `https://${peIp}:9440/api/nutanix/v2.0/hosts`;
                        
                        const [vmsResponse, hostsResponse] = await Promise.all([
                            axios.get(urlVms, { headers, httpsAgent: pcAgent, proxy: false, timeout: 15000 }),
                            axios.get(urlHosts, { headers, httpsAgent: pcAgent, proxy: false, timeout: 15000 }).catch(e => ({ data: { entities: [] } }))
                        ]);

                        let entities = vmsResponse.data.entities || [];
                        const hostsList = hostsResponse.data.entities || [];
                        const hostMap = {};
                        hostsList.forEach(h => { if (h.uuid && h.name) hostMap[h.uuid] = h.name; });

                        let clusterName = 'PE_Cluster';
                        try {
                            const clusterRes = await axios.get(`https://${peIp}:9440/api/nutanix/v2.0/cluster`, { headers, httpsAgent: pcAgent, proxy: false, timeout: 15000 });
                            if (clusterRes.data?.name) clusterName = clusterRes.data.name;
                        } catch (err) {}

                        entities = entities.filter(vm => {
                            const name = (vm.name || '').toUpperCase();
                            return !(name.startsWith('NTNX') || name.endsWith('CVM'));
                        });

                        const mapped = entities.map(vm => {
                            const ipAddresses = vm.ip_addresses || [];
                            const nic_list = ipAddresses.map(ipAddr => ({ ip_endpoint_list: [{ ip: ipAddr }] }));
                            const disk_list = (vm.disk_list || []).map(disk => ({
                                disk_size_bytes: disk.disk_size_bytes || ((disk.container_max_capacity_bytes || 0)),
                                device_properties: { disk_address: { device_bus: disk.device_bus || 'SCSI' } }
                            }));

                            return {
                                metadata: { uuid: vm.uuid },
                                spec: { name: vm.name },
                                status: {
                                    name: vm.name,
                                    cluster_reference: { name: clusterName, uuid: vm.cluster_uuid || '' },
                                    resources: {
                                        power_state: (vm.power_state || 'UNKNOWN').toUpperCase(),
                                        num_vcpus_per_socket: vm.num_vcpus || 1,
                                        num_sockets: 1,
                                        memory_size_mib: vm.memory_mb || 2048,
                                        host_reference: { name: (vm.host_uuid && hostMap[vm.host_uuid]) ? hostMap[vm.host_uuid] : 'N/A', uuid: vm.host_uuid || '' },
                                        nic_list: nic_list,
                                        disk_list: disk_list
                                    }
                                }
                            };
                        });
                        aggregatedVms = aggregatedVms.concat(mapped);
                    } catch (err) {
                        console.error(`[Nutanix] Error fetching from PE IP ${peIp}:`, err.message);
                    }
                });

                await Promise.all(fetchPromises);
                if (aggregatedVms.length > 0) {
                    return res.json({ success: true, vms: aggregatedVms, pcIp: ip, isPeMode: false });
                }
            }

            // PC Mode fallback: Query clusters first, then fetch VMs per cluster in parallel (50ms per cluster)
            const pcAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
            let vmsEntities = [];

            try {
                const clustersRes = await axios.post(`https://${ip}:9440/api/nutanix/v3/clusters/list`, { kind: "cluster", length: 500 }, { headers, httpsAgent: pcAgent, proxy: false, timeout: 10000 });
                const clusterEntities = clustersRes.data?.entities || [];

                if (clusterEntities.length > 0) {
                    const clusterFetchPromises = clusterEntities.map(async (c) => {
                        const clusterName = c.spec?.name;
                        const clusterUuid = c.metadata?.uuid;

                        try {
                            const vmsUrl = `https://${ip}:9440/api/nutanix/v3/vms/list`;
                            const filterExpr = clusterName ? `cluster_name==${clusterName}` : `cluster_uuid==${clusterUuid}`;
                            const res = await axios.post(vmsUrl, { kind: "vm", length: 1000, filter: filterExpr }, { headers, httpsAgent: pcAgent, proxy: false, timeout: 10000 });
                            return res.data?.entities || [];
                        } catch (err) {
                            return [];
                        }
                    });

                    const results = await Promise.all(clusterFetchPromises);
                    results.forEach(list => { vmsEntities = vmsEntities.concat(list); });
                }
            } catch (cErr) {
                console.warn('[Nutanix] Could not fetch clusters list for cluster-by-cluster VM query:', cErr.message);
            }

            // Secondary fallback: single light payload if cluster query returned empty
            if (vmsEntities.length === 0) {
                try {
                    const payload = { kind: "vm", length: 1000 };
                    const response = await axios.post(`https://${ip}:9440/api/nutanix/v3/vms/list`, payload, { headers, httpsAgent: pcAgent, proxy: false, timeout: 15000 });
                    vmsEntities = response.data.entities || [];
                } catch (e) {}
            }

            // Filter CVMs
            let vms = vmsEntities.filter(vm => {
                const name = (vm.spec?.name || '').toUpperCase();
                return !(name.startsWith('NTNX') || name.endsWith('CVM'));
            });

            // Resolve hostnames
            const hostMap = {}; // define empty map to prevent ReferenceError
            vms = vms.map(vm => {
                const hUuid = vm.status?.resources?.host_reference?.uuid || vm.status?.host_reference?.uuid;
                if (hUuid && hostMap[hUuid]) {
                    if (vm.status?.resources?.host_reference) {
                        vm.status.resources.host_reference.name = hostMap[hUuid];
                    }
                    if (vm.status?.host_reference) {
                        vm.status.host_reference.name = hostMap[hUuid];
                    }
                }
                return vm;
            });

            return res.json({ success: true, vms, pcIp: ip });
        }
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


router.post('/vm-action', async (req, res) => {
    const { uuids, actionType } = req.body;
    const isPeMode = process.env.NUTANIX_MODE === 'PE' || (!process.env.NUTANIX_PC_IP && process.env.NUTANIX_PE_IP);
    const account = isPeMode ? process.env.NUTANIX_PE_ACCOUNT : process.env.NUTANIX_PC_ACCOUNT;
    const pwd = isPeMode ? process.env.NUTANIX_PE_PWD : process.env.NUTANIX_PC_PWD;

    if (!uuids || !Array.isArray(uuids) || uuids.length === 0 || !actionType) {
        return res.status(400).json({ error: 'Missing UUIDs or actionType' });
    }

    if (isPeMode) {
        const peIps = process.env.NUTANIX_PE_IP.split(',').map(s => s.trim()).filter(s => s);
        if (peIps.length === 0 || !account || !pwd) {
            return res.status(400).json({ error: 'Nutanix PE credentials not configured.' });
        }

        const auth = Buffer.from(`${account}:${pwd}`).toString('base64');
        const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });

        const tasks = uuids.map(async (uuid) => {
            let lastError = 'VM not found on configured PE IPs';
            for (const peIp of peIps) {
                try {
                    const url = `https://${peIp}:9440/api/nutanix/v2.0/vms/${uuid}/set_power_state`;
                    const payload = { transition: actionType };
                    await axios.post(url, payload, { headers, httpsAgent, proxy: false, timeout: 10000 });
                    return { uuid, status: 'Success' };
                } catch (err) {
                    lastError = err.response?.data?.message || err.message;
                }
            }
            return { uuid, status: 'Error', message: lastError };
        });

        const results = await Promise.all(tasks);
        auditLog(req.user.username, 'Nutanix Manager', `Executed ${actionType} on ${uuids.length} VMs (PE Mode)`);
        return res.json({ success: true, results });
    } else {
        const pcIp = process.env.NUTANIX_PC_IP;
        if (!pcIp || !account || !pwd) {
            return res.status(400).json({ error: 'Nutanix credentials not configured.' });
        }

        const auth = Buffer.from(`${account}:${pwd}`).toString('base64');
        const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };
        const httpsAgent = new https.Agent({ rejectUnauthorized: false });

        // Parallel processing with limited concurrency might be safer, but for now simple Promise.all
        const tasks = uuids.map(async (uuid) => {
            try {
                const url = `https://${pcIp}:9440/api/nutanix/v3/vms/${uuid}`;
                // 1. GET current spec
                const getRes = await axios.get(url, { headers, httpsAgent, proxy: false, timeout: 10000 });
                const vm = getRes.data;

                if (!vm.spec || !vm.spec.resources) {
                    return { uuid, status: 'Failed', message: 'Invalid VM structure returned' };
                }

                // 2. Set new power state
                vm.spec.resources.power_state = actionType;

                // 3. PUT updated spec (exclude status as per Nutanix v3 rules)
                const payload = {
                    spec: vm.spec,
                    metadata: vm.metadata
                };

                await axios.put(url, payload, { headers, httpsAgent, proxy: false, timeout: 10000 });
                return { uuid, status: 'Success' };
            } catch (err) {
                const msg = err.response?.data?.message || err.message;
                return { uuid, status: 'Error', message: msg };
            }
        });

        const results = await Promise.all(tasks);
        auditLog(req.user.username, 'Nutanix Manager', `Executed ${actionType} on ${uuids.length} VMs`);
        res.json({ success: true, results });
    }
});


router.validateCloneEnvironments = validateCloneEnvironments;
module.exports = router;
