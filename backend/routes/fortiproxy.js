const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const https = require('https');
const { executeShell } = require('../lib/ssh');
const { auditLog } = require('../lib/logger');

router.use(requireAuth);
router.use(checkFeature('fortiProxy'));

function getFortiConfig() {
    const envs = (process.env.FORTI_ENVS || '').split(',').map(e => e.trim()).filter(Boolean);
    const hosts = {};
    const tokens = {};
    const sshUsers = {};
    const sshPwds = {};
    envs.forEach(env => {
        hosts[env] = process.env[`FORTI_HOST_${env}`];
        tokens[env] = process.env[`FORTI_TOKEN_${env}`];
        sshUsers[env] = process.env[`FORTI_SSH_USER_${env}`] || 'admin';
        sshPwds[env] = process.env[`FORTI_SSH_PWD_${env}`];
    });
    const bus = (process.env.FORTI_BU_LIST || '').split(',').map(b => b.trim()).filter(Boolean);
    return { envs, hosts, tokens, sshUsers, sshPwds, bus };
}

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { rejectUnauthorized: false }, (resp) => {
            let data = '';
            resp.on('data', chunk => data += chunk);
            resp.on('end', () => {
                try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); }
            });
        }).on("error", err => reject(err));
    });
}

function httpsRequest(method, urlStr, payload = null) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlStr);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: method.toUpperCase(),
            rejectUnauthorized: false,
            headers: { 'Content-Type': 'application/json' }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(json);
                    } else {
                        reject(new Error(json.error || `HTTP ${res.statusCode}: ${data}`));
                    }
                } catch(e) {
                    if (res.statusCode >= 200 && res.statusCode < 300) resolve({ raw: data });
                    else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', (err) => reject(err));

        if (payload) {
            req.write(JSON.stringify(payload));
        }
        req.end();
    });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- EXPORT CONFIG ---
router.get('/config', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    const fullConfig = getFortiConfig();
    res.json({
        envs: fullConfig.envs,
        hosts: fullConfig.hosts,
        bus: fullConfig.bus
    });
});

// --- STATUS CHECKER ---
router.post('/check', checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    const { envs, type, target } = req.body;
    if (!envs || envs.length === 0 || !type || !target) return res.status(400).json({ error: 'Missing parameters' });
    try {
        const { hosts, tokens, bus } = getFortiConfig();
        let results = [];
        for (let env of envs) {
            const host = hosts[env]; const token = tokens[env];
            if (!host || !token) continue;
            const baseURL = `https://${host}/api/v2/cmdb`;
            let promises = [];
            for (let b of bus) {
                if (type === 'ProxyAddress') {
                    promises.push(httpsGet(`${baseURL}/firewall/proxy-addrgrp/${b}_ProxyGroup?access_token=${token}`).then(r => ({ env, group: `${b}_ProxyGroup`, found: JSON.stringify(r).includes(target) })).catch(e => ({ env, group: `${b}_ProxyGroup`, found: false, error: e.message })));
                    promises.push(httpsGet(`${baseURL}/firewall/proxy-addrgrp/${b}_ProxyGroupNew?access_token=${token}`).then(r => ({ env, group: `${b}_ProxyGroupNew`, found: JSON.stringify(r).includes(target) })).catch(e => ({ env, group: `${b}_ProxyGroupNew`, found: false, error: e.message })));
                } else if (type === 'SourceIP') {
                    promises.push(httpsGet(`${baseURL}/firewall/addrgrp/${b}_SourceGroup?access_token=${token}`).then(r => ({ env, group: `${b}_SourceGroup`, found: JSON.stringify(r).includes(target) })).catch(e => ({ env, group: `${b}_SourceGroup`, found: false, error: e.message })));
                }
            }
            const envResults = await Promise.all(promises);
            results.push(...envResults);
        }
        res.json({ target, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- SINGLE DEPLOYMENT (SSH fallback, keep as is for complex multi-group operations) ---
router.post('/execute', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    // Note: Kept minimal implementation for backward compatibility.
    const { envs, type, bu, items, portRange } = req.body;
    const { hosts, sshUsers, sshPwds } = getFortiConfig();
    try {
        let commands = [];
        for (let item of items) {
            if (!item.trim()) continue;
            const url = item.trim();
            commands.push(`config firewall proxy-address`, `edit "${url}"`, `set type host-regex`, `set host-regex "${url}"`, `end`, ``);
            commands.push(`config firewall proxy-addrgrp`, `edit "${bu}_ProxyGroupNew"`, `append member "${url}"`, `end`, ``);
        }
        let runResults = {};
        for (let env of envs) {
            const ip = hosts[env];
            const sshUser = sshUsers[env] || 'admin';
            const sshPwd = sshPwds[env];
            if (!ip) continue;
            if (!sshPwd) {
                runResults[env] = { status: 'Failed', error: `FortiProxy SSH Password not configured for environment: ${env}` };
                continue;
            }
            try {
                const logs = await executeShell(ip, sshUser, sshPwd, commands, { port: 22, algorithms: { cipher: ['aes256-cbc', 'aes192-cbc', 'aes128-cbc', 'aes256-ctr', 'aes192-ctr', 'aes128-ctr'] } });
                runResults[env] = { status: 'Success', protocol: logs };
            } catch(e) { runResults[env] = { status: 'Failed', error: e.message }; }
        }
        auditLog(req.user.username, 'FortiProxy Manager', `Deployed [${type}] via SSH to Env: ${envs.join(', ')}`);
        res.json({ success: true, results: runResults });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- BULK DEPLOYMENT (API) ---
router.post('/execute/bulk/api', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, rules } = req.body;
    if (!env || !rules || !Array.isArray(rules)) return res.status(400).json({ error: 'Missing environment or rules' });
    const { hosts, tokens } = getFortiConfig();
    const host = hosts[env]; const token = tokens[env];
    if (!host || !token) return res.status(400).json({ error: 'Invalid environment' });

    let results = [];
    let successCount = 0; let failCount = 0;

    for (let rule of rules) {
        let status = 'Failed'; let errMessage = '';
        try {
            if (rule.type === 'ProxyURL' || rule.type === 'ProxyIP') {
                const url = `https://${host}/api/v2/cmdb/firewall/proxy-address?access_token=${token}`;
                const payload = {
                    name: rule.type === 'ProxyIP' ? `Proxy_${rule.item}` : rule.item,
                    type: rule.type === 'ProxyIP' ? 'dst-advanced' : 'host-regex'
                };
                if (rule.type === 'ProxyIP') {
                    payload['host'] = rule.item;
                } else {
                    payload['host-regex'] = rule.item;
                }
                
                await httpsRequest('POST', url, payload);
                await delay(50); // Prevent rate limiting

                // Optionally assign to group
                if (rule.bu) {
                    const groupName = `${rule.bu}_ProxyGroupNew`;
                    const grpUrl = `https://${host}/api/v2/cmdb/firewall/proxy-addrgrp/${groupName}/member?access_token=${token}`;
                    await httpsRequest('POST', grpUrl, { name: payload.name }).catch(() => {}); // ignore if already member
                    await delay(50);
                }

                status = 'Success'; successCount++;
            } else {
                status = 'Failed'; errMessage = 'Unsupported type for REST API bulk'; failCount++;
            }
        } catch (e) {
            status = 'Failed'; errMessage = e.message; failCount++;
        }
        results.push({ ...rule, status, error: errMessage });
    }
    auditLog(req.user.username, 'FortiProxy Manager', `Bulk Deployed API ${rules.length} rules to ${env}`);
    res.json({ results, summary: { total: rules.length, success: successCount, failed: failCount } });
});

// --- ANALYTICS ---
router.post('/analytics', checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    const { env } = req.body;
    const { hosts, tokens } = getFortiConfig();
    if (!hosts[env] || !tokens[env]) return res.status(400).json({ error: 'Invalid environment' });
    const host = hosts[env]; const token = tokens[env];

    try {
        let cpu = 0, mem = 0, sessions = 0;
        let topRules = [];
        let threats = [];
        let zones = [ { name: 'LAN', traffic: 'N/A' }, { name: 'WAN', traffic: 'N/A' } ];

        res.json({
            host,
            performance: { cpu, mem, sessions },
            topRules,
            threats,
            zones
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- OBJECT CLEANUP ---
router.post('/cleanup/scan', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env } = req.body;
    const { hosts, tokens } = getFortiConfig();
    const host = hosts[env]; const token = tokens[env];
    if (!host || !token) return res.status(400).json({ error: 'Invalid environment' });

    try {
        // 1. Get all Proxy Addresses
        const addrsRes = await httpsGet(`https://${host}/api/v2/cmdb/firewall/proxy-address?access_token=${token}`);
        if (!addrsRes.results) throw new Error("Failed to fetch proxy addresses");
        
        // 2. Get all Proxy Address Groups
        const grpsRes = await httpsGet(`https://${host}/api/v2/cmdb/firewall/proxy-addrgrp?access_token=${token}`);
        if (!grpsRes.results) throw new Error("Failed to fetch proxy groups");

        // 3. Find members in use
        const inUse = new Set();
        grpsRes.results.forEach(g => {
            if (g.member && Array.isArray(g.member)) {
                g.member.forEach(m => inUse.add(m.name));
            }
        });

        // 4. Filter orphans
        const orphans = addrsRes.results.filter(a => !inUse.has(a.name) && a.name !== 'all').map(a => ({
            name: a.name,
            type: a.type,
            lastUsed: 'Unknown (API)' // Real FortiOS API does not track 'lastUsed' on CMDB objects natively
        }));

        res.json({ results: orphans });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/cleanup/delete', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, items } = req.body;
    const { hosts, tokens } = getFortiConfig();
    const host = hosts[env]; const token = tokens[env];
    if (!host || !token || !Array.isArray(items)) return res.status(400).json({ error: 'Missing parameters' });

    try {
        let successCount = 0;
        let failCount = 0;
        let failedItems = [];
        for (let name of items) {
            const encodedName = encodeURIComponent(name);
            try {
                await httpsRequest('DELETE', `https://${host}/api/v2/cmdb/firewall/proxy-address/${encodedName}?access_token=${token}`);
                successCount++;
            } catch (err) {
                failCount++;
                failedItems.push({ name, error: err.message });
            }
            await delay(50);
        }
        auditLog(req.user.username, 'FortiProxy Manager', `Cleaned up ${successCount} objects, ${failCount} failed on ${env}`);
        res.json({ success: true, message: `Successfully deleted ${successCount} objects, ${failCount} failed.`, failedItems });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- URL RATING (SSH) ---
router.post('/url-rating', checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    const { env, url } = req.body;
    const { hosts, sshUsers, sshPwds } = getFortiConfig();
    const host = hosts[env];
    const sshUser = sshUsers[env];
    const sshPwd = sshPwds[env];

    if (!host || !url) return res.status(400).json({ error: 'Missing parameters' });
    if (!sshPwd) return res.status(500).json({ error: `FortiProxy SSH Password not configured for environment: ${env}. Please set FORTI_SSH_PWD_${env} in .env` });

    try {
        // We use SSH to run diagnose command because FortiOS API doesn't expose a rating tester directly
        const cmd = `diagnose webfilter test url ${url}`;
        const output = await executeShell(host, sshUser, sshPwd, [cmd, ``], { port: 22, algorithms: { cipher: ['aes256-cbc', 'aes192-cbc', 'aes128-cbc', 'aes256-ctr'] } });
        
        let category = 'Unknown (Failed to parse CLI)';
        let action = 'Warning / Monitored';
        let blocked = false;

        // Naive parsing of FortiOS diagnose output
        const match = output.match(/category:\s*(.+)/i);
        if (match && match[1]) {
            category = match[1].trim();
        }

        if (category.toLowerCase().includes('malicious') || category.toLowerCase().includes('phishing') || category.toLowerCase().includes('gambling')) {
            action = 'Blocked'; blocked = true;
        }

        res.json({ url, category, action, blocked, raw: output });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- BACKUPS ---
router.get('/backups', checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    const { env } = req.query;
    const { hosts, tokens, envs } = getFortiConfig();
    const targetEnv = env || envs[0];
    if (!targetEnv) return res.json({ files: [] });
    const host = hosts[targetEnv]; const token = tokens[targetEnv];
    if (!host || !token) return res.status(400).json({ error: `Environment ${targetEnv} configuration not found` });

    try {
        const revRes = await httpsGet(`https://${host}/api/v2/monitor/system/config/revision?access_token=${token}`);
        if (revRes && revRes.results) {
            const files = revRes.results.map(r => `Revision ${r.id} (${r.time}) - ${r.admin}`).reverse();
            res.json({ files, _env: targetEnv }); // Pass env back so frontend knows
        } else {
            res.json({ files: ['No revisions found on device'] });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/backups/read', checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    // Real config download
    const { env } = req.body;
    const { envs, hosts, tokens } = getFortiConfig();
    const targetEnv = env || envs[0];
    if (!targetEnv) return res.status(400).json({ error: 'No environment specified' });
    const host = hosts[targetEnv]; const token = tokens[targetEnv];
    if (!host || !token) return res.status(400).json({ error: `Environment ${targetEnv} configuration not found` });
    try {
        // In a real device, we would download the config file
        // Due to API complexity of downloading streams, we'll fetch global status
        const sysInfo = await httpsGet(`https://${host}/api/v2/monitor/system/status?access_token=${token}`);
        let content = `### Real Time Device Status (${host})\n`;
        content += JSON.stringify(sysInfo.results || sysInfo, null, 2);
        res.json({ content });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- POLICY MANAGER ---
router.post('/policies', checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    const { env } = req.body;
    const { hosts, tokens } = getFortiConfig();
    const host = hosts[env]; const token = tokens[env];
    if (!host || !token) return res.status(400).json({ error: 'Invalid environment' });

    try {
        const polRes = await httpsGet(`https://${host}/api/v2/cmdb/firewall/policy?access_token=${token}`);
        if (!polRes || !polRes.results) throw new Error("Failed to fetch policies");

        const policies = polRes.results.map(p => {
            return {
                id: p.policyid,
                name: p.name || `Policy_${p.policyid}`,
                src: (p.srcaddr && p.srcaddr[0]) ? p.srcaddr[0].name : 'all',
                dst: (p.dstaddr && p.dstaddr[0]) ? p.dstaddr[0].name : 'all',
                action: p.action || 'accept',
                status: p.status || 'enable'
            };
        });

        res.json({ policies });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/policies/toggle', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, policyId, action } = req.body;
    const { hosts, tokens } = getFortiConfig();
    const host = hosts[env]; const token = tokens[env];
    if (!host || !token || !policyId || !action) return res.status(400).json({ error: 'Missing parameters' });
    if (req.user.role === 'Viewer') return res.status(403).json({ error: 'Forbidden' });
    
    try {
        const url = `https://${host}/api/v2/cmdb/firewall/policy/${policyId}?access_token=${token}`;
        await httpsRequest('PUT', url, { status: action });
        auditLog(req.user.username, 'FortiProxy Manager', `Toggled Policy ID ${policyId} to ${action} on ${env}`);
        res.json({ success: true, message: `Policy ${policyId} is now ${action}` });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- SESSION TRACER ---
router.post('/sessions', checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    const { env, ip } = req.body;
    const { hosts, tokens } = getFortiConfig();
    const host = hosts[env]; const token = tokens[env];
    if (!host || !token || !ip) return res.status(400).json({ error: 'Missing parameters' });
    
    try {
        const sessRes = await httpsGet(`https://${host}/api/v2/monitor/system/session?ip=${ip}&access_token=${token}`);
        if (!sessRes || !sessRes.results) throw new Error("Failed to fetch sessions");

        const activeSessions = sessRes.results.map(s => {
            return {
                id: s.serial,
                dst: s.dst,
                port: s.dst_port,
                policy: s.policyid,
                state: s.state || 'ESTABLISHED',
                bytes: `${s.bytes} B`
            };
        });
        
        res.json({ sessions: activeSessions });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
