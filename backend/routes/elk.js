const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const axios = require('axios');
const dotenv = require('dotenv');
const { executeSSH, sftpWrite } = require('../lib/ssh');
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { runPowerShell, getADCredentialHeader } = require('../lib/powershell');
const { auditLog } = require('../lib/logger');

router.use(requireAuth);
router.use(checkFeature('elk'));

const { readEnv } = require('../lib/envEditor');

// Custom agents supporting keep-alive and self-signed / internal CA HTTPS certs
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true
});

function isEsVersionAtLeast76(versionStr) {
    if (!versionStr) return true; // Default to modern
    const clean = String(versionStr).trim().toLowerCase().replace(/^v/, '');
    const parts = clean.split('.').map(n => parseInt(n, 10) || 0);
    const major = parts[0] || 0;
    const minor = parts[1] || 0;
    if (major > 7) return true; // 8.x, 9.x+
    if (major === 7) return minor >= 6; // 7.6, 7.17, etc.
    return false; // < 7.6 (e.g. 7.5, 7.0, 6.8, 5.6)
}

function getEnvMap() {
    const envMap = {};
    const parsedEnv = readEnv();

    Object.keys(parsedEnv).forEach(key => {
        const match = key.match(/^ELK_([A-Z0-9_]+)_MASTER$/);
        if (match) {
            const cluster = match[1];
            const rawMaster = parsedEnv[`ELK_${cluster}_MASTER`] || '';
            const explicitProto = parsedEnv[`ELK_${cluster}_PROTO`] || (rawMaster.startsWith('https://') ? 'https' : 'http');
            const version = parsedEnv[`ELK_${cluster}_VERSION`] || parsedEnv[`ELK_VERSION`] || '7.17';
            const apiUser = parsedEnv[`ELK_${cluster}_API_USER`] || parsedEnv[`ELK_${cluster}_ACCOUNT`] || "";
            const apiPwd = parsedEnv[`ELK_${cluster}_API_PWD`] || parsedEnv[`ELK_${cluster}_PWD`] || "";
            envMap[cluster] = {
                master: rawMaster,
                proto: explicitProto,
                version: String(version).trim(),
                nodes: parsedEnv[`ELK_${cluster}_NODES`] ? parsedEnv[`ELK_${cluster}_NODES`].split(',') : [],
                ls: parsedEnv[`LS_${cluster}_NODES`] ? parsedEnv[`LS_${cluster}_NODES`].split(',') : [],
                ls_path: parsedEnv[`SYSNAS_LS_${cluster}_PATH`] || "",
                account: apiUser,
                apiUser: apiUser,
                apiPwd: apiPwd
            };
        }
    });
    return envMap;
}

function getElkCredentials(env) {
    const uEnv = (env || '').toUpperCase();
    const customUser = process.env[`ELK_${uEnv}_USER`];
    const customPwd = process.env[`ELK_${uEnv}_PWD`];
    return {
        user: (customUser && customUser.trim()) ? customUser.trim() : (process.env.LINUX_ADMIN_USER || 'xyuser'),
        pwd: (customPwd && customPwd.trim()) ? customPwd.trim() : null
    };
}

// Normalizes Elasticsearch master configuration into full base URL (e.g. https://198.51.100.10:9200)
function getEsBaseUrl(master, proto) {
    if (!master) return '';
    let target = master.trim();

    // If master already contains http:// or https://
    if (/^https?:\/\//i.test(target)) {
        try {
            const parsed = new URL(target);
            const protocol = parsed.protocol;
            const host = parsed.hostname;
            const port = parsed.port || '9200';
            return `${protocol}//${host}:${port}`;
        } catch {
            return target.replace(/\/+$/, '');
        }
    }

    const defaultProto = (proto && proto.toLowerCase() === 'https') ? 'https://' : 'http://';
    if (target.includes(':')) {
        const [host, port] = target.split(':');
        return `${defaultProto}${host}:${port || 9200}`;
    }
    return `${defaultProto}${target}:9200`;
}

function getHttpConfig(envData) {
    const baseConfig = {
        headers: { 'Content-Type': 'application/json' },
        timeout: 50000,
        proxy: false,
        httpAgent,
        httpsAgent
    };
    const apiUser = envData?.apiUser || envData?.account;
    const apiPwd = envData?.apiPwd;
    if (!apiUser || !apiPwd) return baseConfig;
    const creds = Buffer.from(`${apiUser}:${apiPwd}`).toString('base64');
    baseConfig.headers['Authorization'] = `Basic ${creds}`;
    return baseConfig;
}

// 1. Health & Status Checkers (Native Axios bridging with HTTPS support)
router.post('/health', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env } = req.body;
    const envData = getEnvMap()[env];
    const master = envData?.master;
    if (!master) return res.status(400).json({ error: 'Invalid ELK environment target' });

    const httpCfg = getHttpConfig(envData);
    const baseUrl = getEsBaseUrl(master, envData.proto);

    try {
        const [health, nodes, threads] = await Promise.all([
            axios.get(`${baseUrl}/_cluster/health?pretty&wait_for_status=yellow&timeout=50s`, httpCfg).then(r => r.data).catch(e => e.response?.data ? JSON.stringify(e.response.data) : e.message),
            axios.get(`${baseUrl}/_cat/nodes?v&h=name,id,ip,port,v,m`, httpCfg).then(r => r.data).catch(e => e.response?.data ? JSON.stringify(e.response.data) : e.message),
            axios.get(`${baseUrl}/_cat/thread_pool/search,write?v&s=node_name:asc`, httpCfg).then(r => r.data).catch(e => e.response?.data ? JSON.stringify(e.response.data) : e.message)
        ]);
        res.json({ health, nodes, threads });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Parallel Disk Checks via SSH
router.post('/disk', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, linuxPassword } = req.body;
    if (!env) return res.status(400).json({ error: 'Missing environment' });
    const nodes = getEnvMap()[env]?.nodes;
    if (!nodes) return res.status(400).json({ error: 'No nodes found for environment' });

    const { user, pwd } = getElkCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    let results = [];
    for (const host of nodes) {
        try {
            const { stdout, stderr } = await executeSSH(host, user, finalPassword, 'df -lh');
            const output = stdout + stderr;
            results.push({ host, status: 'Success', val: output });
        } catch (err) {
            results.push({ host, status: 'Failed', val: err.message });
        }
    }
    res.json(results);
});

// 3. Cluster Actions (ES HTTP/HTTPS APIs)
router.post('/action', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, action_type } = req.body; // action_type: 'disable_allocation', 'enable_allocation', 'synced_flush', 'reroute', 'explain'
    const envData = getEnvMap()[env];
    const master = envData?.master;
    if (!master) return res.status(400).json({ error: 'Invalid ELK environment' });

    const httpCfg = getHttpConfig(envData);
    const baseUrl = getEsBaseUrl(master, envData.proto);

    try {
        let responseData = null;
        if (action_type === 'disable_allocation') {
            const payload = { persistent: { "cluster.routing.allocation.enable": "none" } };
            const r = await axios.put(`${baseUrl}/_cluster/settings`, payload, httpCfg);
            responseData = r.data;
        } else if (action_type === 'enable_allocation') {
            const payload = { persistent: { "cluster.routing.allocation.enable": null } };
            const r = await axios.put(`${baseUrl}/_cluster/settings`, payload, httpCfg);
            responseData = r.data;
        } else if (action_type === 'synced_flush' || action_type === 'flush') {
            const isModern = isEsVersionAtLeast76(envData.version);
            const endpoint = isModern ? '/_flush?pretty' : '/_flush/synced';
            const r = await axios.request({
                method: 'POST',
                url: `${baseUrl}${endpoint}`,
                ...httpCfg
            });
            responseData = {
                endpoint: `POST ${endpoint}`,
                es_version: envData.version || '7.17',
                es_mode: isModern ? 'Standard Flush (ES >= 7.6)' : 'Legacy Synced Flush (ES < 7.6)',
                result: r.data
            };
        } else if (action_type === 'reroute') {
            const r = await axios.request({
                method: 'POST',
                url: `${baseUrl}/_cluster/reroute?retry_failed`,
                ...httpCfg
            });
            responseData = r.data;
        } else if (action_type === 'explain') {
            const r = await axios.get(`${baseUrl}/_cluster/allocation/explain`, httpCfg);
            responseData = r.data;
        } else {
            return res.status(400).json({ error: 'Invalid action_type' });
        }
        
        auditLog(req.user.username, 'ELK Manager', `Executed Cluster Action [${action_type}] on Env: ${env}`);
        res.json({ success: true, response: responseData });
    } catch (e) {
        res.status(500).json({ error: e.response?.data ? JSON.stringify(e.response.data) : e.message });
    }
});

// 4. ElasticSearch Node Restart
router.post('/restart-node', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { nodeIp, linuxPassword, env } = req.body;
    if (!nodeIp) return res.status(400).json({ error: 'Missing parameters' });
    
    const { user, pwd } = getElkCredentials(env || '');
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    try {
        const { stdout, stderr } = await executeSSH(nodeIp, user, finalPassword, 'systemctl restart elasticsearch');
        const logs = stdout + stderr;
        auditLog(req.user.username, 'ELK Manager', `Restarted Elasticsearch node: ${nodeIp}`);
        res.json({ success: true, logs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Delete By Query (Advanced)
router.post('/delete-by-query', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, index, startTime, endTime } = req.body;
    const envData = getEnvMap()[env];
    const master = envData?.master;
    if (!master || !index || !startTime || !endTime) return res.status(400).json({ error: 'Missing parameters' });

    const httpCfg = getHttpConfig(envData);
    const baseUrl = getEsBaseUrl(master, envData.proto);

    // Payload: { "query": { "range" : { "@timestamp" : { "gte" : "$s_time", "lte" : "$e_time", "format": "dd/MM/yyyy||yyyy" } } } }
    const payload = {
        query: {
            range: {
                "@timestamp": { gte: startTime, lte: endTime, format: "dd/MM/yyyy||yyyy" }
            }
        }
    };
    try {
        const r = await axios.post(`${baseUrl}/${index}/_delete_by_query`, payload, httpCfg);
        auditLog(req.user.username, 'ELK Manager', `Deleted index data for ${index} from ${startTime} to ${endTime}`);
        res.json({ success: true, response: r.data });
    } catch (e) {
        res.status(500).json({ error: e.response?.data ? JSON.stringify(e.response.data) : e.message });
    }
});

function extractJsonObjects(text) {
    if (!text || typeof text !== 'string') return [];
    const objects = [];
    let i = 0;
    while (i < text.length) {
        const start = text.indexOf('{', i);
        if (start === -1) break;
        let depth = 0;
        let inString = false;
        let escape = false;
        let end = -1;
        for (let j = start; j < text.length; j++) {
            const ch = text[j];
            if (escape) {
                escape = false;
                continue;
            }
            if (ch === '\\') {
                escape = true;
                continue;
            }
            if (ch === '"') {
                inString = !inString;
                continue;
            }
            if (!inString) {
                if (ch === '{') depth++;
                else if (ch === '}') {
                    depth--;
                    if (depth === 0) {
                        end = j;
                        break;
                    }
                }
            }
        }
        if (end !== -1) {
            try {
                objects.push(JSON.parse(text.slice(start, end + 1)));
            } catch (e) {
                // Ignore parse errors for incomplete JSON
            }
            i = end + 1;
        } else {
            break;
        }
    }
    return objects;
}

// 5.5 Deploy Index Template & Initial Bootstrap Index directly to Cluster
router.post('/deploy-index-template', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, templateName, indexPattern, aliasName, policyName, customScript } = req.body;
    const envMap = getEnvMap();
    const envKey = (env || '').trim();
    const envData = envMap[envKey] || envMap[envKey.toUpperCase()] || envMap[envKey.toLowerCase()];
    const master = envData?.master;
    if (!master) return res.status(400).json({ error: `Invalid ELK environment target: ${env || 'undefined'}` });
    if (!templateName || !indexPattern || !aliasName || !policyName) {
        return res.status(400).json({ error: 'Missing required parameters: templateName, indexPattern, aliasName, policyName' });
    }

    const httpCfg = getHttpConfig(envData);
    const baseUrl = getEsBaseUrl(master, envData.proto);
    const dateVersion = parseInt(new Date().toISOString().slice(0, 10).replace(/-/g, ""), 10) || 100;

    const results = {
        template: null,
        templateType: 'composable',
        initialIndex: null,
        initialIndexName: `${aliasName}-000001`
    };

    try {
        const customJsons = extractJsonObjects(customScript);

        // 1. Deploy Index Template (Try Composable _index_template first, fallback to legacy _template)
        const composablePayload = customJsons[0] || {
            index_patterns: [indexPattern],
            template: {
                settings: {
                    index: {
                        lifecycle: {
                            name: policyName,
                            rollover_alias: aliasName
                        },
                        refresh_interval: "10s",
                        number_of_shards: "1",
                        number_of_replicas: "1"
                    }
                }
            },
            composed_of: [],
            priority: 100,
            version: dateVersion
        };

        try {
            const tRes = await axios.put(`${baseUrl}/_index_template/${templateName}`, composablePayload, httpCfg);
            results.template = tRes.data;
            results.templateType = 'composable (_index_template)';
        } catch (tErr) {
            // Fallback to legacy _template
            const legacyPayload = composablePayload.template ? {
                index_patterns: composablePayload.index_patterns || [indexPattern],
                settings: composablePayload.template.settings || {},
                mappings: composablePayload.template.mappings || undefined,
                aliases: composablePayload.template.aliases || undefined
            } : {
                index_patterns: [indexPattern],
                settings: {
                    index: {
                        lifecycle: {
                            name: policyName,
                            rollover_alias: aliasName
                        },
                        refresh_interval: "10s",
                        number_of_shards: "1",
                        number_of_replicas: "1"
                    }
                }
            };
            const legacyRes = await axios.put(`${baseUrl}/_template/${templateName}`, legacyPayload, httpCfg);
            results.template = legacyRes.data;
            results.templateType = 'legacy (_template)';
        }

        // 2. Deploy Initial Bootstrap Index with write alias
        const indexPayload = customJsons[1] || {
            aliases: {
                [aliasName]: {
                    is_write_index: true
                }
            }
        };

        try {
            const iRes = await axios.put(`${baseUrl}/${aliasName}-000001`, indexPayload, httpCfg);
            results.initialIndex = iRes.data;
        } catch (iErr) {
            const errData = iErr.response?.data || {};
            // If index already exists or resource_already_exists_exception, treat with warning instead of hard crash
            if (errData?.error?.type === 'resource_already_exists_exception' || iErr.response?.status === 400) {
                results.initialIndex = { warning: 'Index already exists', details: errData };
            } else {
                throw iErr;
            }
        }

        auditLog(req.user.username, 'ELK Manager', `Deployed Index Template [${templateName}] & Initial Index [${aliasName}-000001] to Env: ${env}`);
        res.json({ success: true, results });
    } catch (e) {
        const errMsg = e.response?.data ? (typeof e.response.data === 'object' ? JSON.stringify(e.response.data) : e.response.data) : e.message;
        res.status(500).json({ error: errMsg });
    }
});

// 6. Logstash Filter Deploy
router.post('/logstash-deploy', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, folderName, linuxPassword } = req.body;
    const envData = getEnvMap()[env] || {};
    const lsNodes = envData.ls;
    const lsNasPath = envData.ls_path;

    if (!lsNodes || lsNodes.length === 0 || !lsNasPath) return res.status(400).json({ error: 'Environment does not support Logstash deployments' });
    if (!folderName) return res.status(400).json({ error: 'Missing folder name' });

    const { user, pwd } = getElkCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    try {
        const targetPath = `${lsNasPath.trim()}\\${folderName.trim()}`;
        const { username, domain, password: adPassword } = req.user;
        const credHdr = getADCredentialHeader(username, domain, adPassword);

        const psScript = `
$ErrorActionPreference = "Stop"
${credHdr}
if ($global:AD_CRED) {
    New-PSDrive -Name "ELKNAS" -PSProvider "FileSystem" -Root "${lsNasPath.trim()}" -Credential $global:AD_CRED | Out-Null
} else {
    New-PSDrive -Name "ELKNAS" -PSProvider "FileSystem" -Root "${lsNasPath.trim()}" | Out-Null
}
try {
    $target = "ELKNAS:\\${folderName.trim()}"
    if (-not (Test-Path $target)) {
        throw "Network path not found: ${targetPath}"
    }
    
    $files = Get-ChildItem -Path "$target\\*.conf"
    if (-not $files) {
        throw "No .conf files found in directory"
    }

    $result = @()
    foreach ($f in $files) {
        $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
        $b64 = [System.Convert]::ToBase64String($bytes)
        $result += [PSCustomObject]@{ Name = $f.Name; Content = $b64 }
    }
    $result | ConvertTo-Json -Depth 10
} finally {
    Remove-PSDrive -Name "ELKNAS" -ErrorAction SilentlyContinue | Out-Null
}
        `;

        const output = await runPowerShell(psScript);
        let parsedFiles = [];
        try {
            const rawOutput = output.trim();
            if (!rawOutput) throw new Error("Empty response from PowerShell");
            parsedFiles = JSON.parse(rawOutput);
            if (!Array.isArray(parsedFiles)) parsedFiles = [parsedFiles];
        } catch (e) {
            return res.status(500).json({ error: `PowerShell UNC Parse Error: ${output}` });
        }

        let deploymentLogs = [];

        // For each node, loop through all files and SFTP upload them
        for (const host of lsNodes) {
            let hostResult = { host, copied: [], errors: [] };
            for (const fileObj of parsedFiles) {
                try {
                    const content = Buffer.from(fileObj.Content, 'base64');
                    const remotePath = `/etc/logstash/conf.d/${fileObj.Name}`;
                    await sftpWrite(host, user, finalPassword, remotePath, content);
                    hostResult.copied.push(fileObj.Name);
                } catch (e) {
                    hostResult.errors.push(`${fileObj.Name}: ${e.message}`);
                }
            }
            deploymentLogs.push(hostResult);
        }
        
        auditLog(req.user.username, 'ELK Manager', `Deployed Logstash Filter [${folderName}] to Env: ${env}`);
        res.json({ success: true, deploymentLogs });
    } catch (err) {
        let errMsg = err.message;
        if (err.stderr) errMsg = err.stderr.trim() || err.error?.message;
        res.status(500).json({ error: errMsg || JSON.stringify(err) });
    }
});

// 7. Get Nodes per Environment for Frontend Dropdowns
router.get('/nodes/:env', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    const targetEnv = req.params.env.toUpperCase();
    const nodes = getEnvMap()[targetEnv]?.nodes || [];
    res.json(nodes);
});

// 8. Get Available Environments dynamically
router.get('/envs', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    const map = getEnvMap();
    const safeMap = {};
    for (const [cluster, data] of Object.entries(map)) {
        const creds = getElkCredentials(cluster);
        safeMap[cluster] = {
            ...data,
            hasPresetAuth: !!creds.pwd,
            user: creds.user
        };
        delete safeMap[cluster].account;
        delete safeMap[cluster].pwd;
    }
    console.log('[ELK] /envs returning clusters:', Object.keys(safeMap));
    res.json(safeMap);
});

// 9. Dynamic ILM Lifecycle Policy Durations (Days) per Environment
router.get('/lifecycle-config', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    try {
        const parsedEnv = readEnv();
        const targetEnv = (req.query.env || '').toUpperCase();

        const getEnvLifecycle = (e) => {
            const u = (e || '').toUpperCase();
            const shortVal = parseInt(
                parsedEnv[`${u}_LIFECYCLE_SHORT`] || 
                parsedEnv[`ELK_${u}_LIFECYCLE_SHORT`] || 
                parsedEnv.ELK_ILM_SHORT_DAYS || process.env.ELK_ILM_SHORT_DAYS || 7, 
                10
            );
            const medVal = parseInt(
                parsedEnv[`${u}_LIFECYCLE_MEDIUM`] || 
                parsedEnv[`ELK_${u}_LIFECYCLE_MEDIUM`] || 
                parsedEnv.ELK_ILM_MEDIUM_DAYS || process.env.ELK_ILM_MEDIUM_DAYS || 60, 
                10
            );
            const longVal = parseInt(
                parsedEnv[`${u}_LIFECYCLE_LONG`] || 
                parsedEnv[`ELK_${u}_LIFECYCLE_LONG`] || 
                parsedEnv.ELK_ILM_LONG_DAYS || process.env.ELK_ILM_LONG_DAYS || 365, 
                10
            );
            return {
                short: Number.isNaN(shortVal) ? 7 : shortVal,
                medium: Number.isNaN(medVal) ? 60 : medVal,
                long: Number.isNaN(longVal) ? 365 : longVal
            };
        };

        const envMap = getEnvMap();
        const byEnv = {};
        Object.keys(envMap).forEach(e => {
            byEnv[e] = getEnvLifecycle(e);
        });

        // Also check any configured ELK_ENVS in parsedEnv
        const configuredEnvs = (parsedEnv.ELK_ENVS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        configuredEnvs.forEach(e => {
            if (!byEnv[e]) byEnv[e] = getEnvLifecycle(e);
        });

        const activeConfig = targetEnv ? getEnvLifecycle(targetEnv) : (Object.values(byEnv)[0] || { short: 7, medium: 60, long: 365 });

        res.json({
            ...activeConfig,
            byEnv
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 10. Lifecycle Violation: Fetch state and violation records
const {
    getViolationsData,
    saveViolationsData,
    scanLifecycleViolations,
    deleteIndices
} = require('../services/elkLifecycleScheduler');

router.get('/lifecycle-violations', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    try {
        const data = getViolationsData();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 11. Lifecycle Violation: Update scanning configuration & schedule
router.post('/lifecycle-violations/config', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    const { schedule, targetEnv, indexPattern } = req.body;
    try {
        const current = getViolationsData();
        const updated = {
            ...current,
            schedule: schedule || current.schedule || '1 day',
            targetEnv: targetEnv || current.targetEnv,
            indexPattern: typeof indexPattern === 'string' ? indexPattern.trim() : current.indexPattern
        };
        saveViolationsData(updated);
        auditLog(req.user.username, 'ELK Manager', `Updated lifecycle violation configuration (Pattern: ${updated.indexPattern}, Schedule: ${updated.schedule})`);
        res.json({ success: true, config: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 12. Lifecycle Violation: Run on-demand scan
router.post('/lifecycle-violations/scan', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, indexPattern } = req.body;
    try {
        const result = await scanLifecycleViolations(env, indexPattern);
        auditLog(req.user.username, 'ELK Manager', `Triggered on-demand lifecycle violation scan on env ${env || 'default'} for: ${indexPattern || '*'}`);
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 13. Lifecycle Violation: Delete unmanaged index / indices
router.post('/lifecycle-violations/delete', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, indices } = req.body;
    if (!indices || (Array.isArray(indices) && indices.length === 0)) {
        return res.status(400).json({ error: 'No index provided for deletion' });
    }
    try {
        const results = await deleteIndices(env, indices, req.user.username);
        res.json({ success: true, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
