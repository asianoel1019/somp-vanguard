const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { executeSSH, sftpWrite } = require('../lib/ssh');
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');

router.use(requireAuth);
router.use(checkFeature('squid'));

// ---- Dynamic Squid Environment Engine ----
function getSquidEnvs() {
    return (process.env.SQUID_ENVS || '').split(',').map(e => e.trim()).filter(Boolean);
}

function getServersForEnv(env) {
    const raw = process.env[`SQUID_SERVERS_${env}`];
    if (!raw) return null;
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// GET /envs — returns available environments
router.get('/envs', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    const envs = getSquidEnvs().filter(e => process.env[`SQUID_SERVERS_${e}`]);
    const envDetails = envs.map(e => {
        const creds = getSquidCredentials(e);
        return {
            name: e,
            hasPresetAuth: !!creds.pwd,
            user: creds.user
        };
    });
    res.json({ envs, envDetails });
});

const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const BACKUP_DIR = path.join(BASE_DATA_DIR, 'config_backup', 'squid_cfg_bk');
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function getSquidCredentials(env) {
    const uEnv = (env || '').toUpperCase();
    const customUser = process.env[`SQUID_${uEnv}_USER`];
    const customPwd = process.env[`SQUID_${uEnv}_PWD`];
    return {
        user: (customUser && customUser.trim()) ? customUser.trim() : (process.env.LINUX_ADMIN_USER || 'xyuser'),
        pwd: (customPwd && customPwd.trim()) ? customPwd.trim() : null
    };
}

// Format YYYY-MM-DD-HH-mm
function getTimestamp() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}`;
}

const CONFIG_PATHS = {
    'access': '/etc/squid/allowip.txt',
    'squid.conf': '/etc/squid/squid.conf',
    'blacklist': '/etc/squid/blacklist.txt'
};

// 1. Read Remote Config
router.post('/config/read', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, linuxPassword, fileType } = req.body;
    if (!env) return res.status(400).json({ error: 'Missing environment' });

    const { user, pwd } = getSquidCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    const targetType = fileType || 'access';
    const remotePath = CONFIG_PATHS[targetType];
    if (!remotePath) return res.status(400).json({ error: 'Invalid file type' });

    const hosts = getServersForEnv(env.toUpperCase());
    if (!hosts) return res.status(400).json({ error: 'Invalid environment' });

    try {
        const command = `cat ${remotePath}`;
        const { stdout, stderr } = await executeSSH(hosts[0], user, finalPassword, command);
        res.json({ content: stdout + stderr });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. Deploy Remote Config
router.post('/config/deploy', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, content, linuxPassword, fileType } = req.body;
    if (!env || !content) return res.status(400).json({ error: 'Missing parameters' });

    const { user, pwd } = getSquidCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    const targetType = fileType || 'access';
    const remotePath = CONFIG_PATHS[targetType];
    if (!remotePath) return res.status(400).json({ error: 'Invalid file type' });

    const hosts = getServersForEnv(env.toUpperCase());
    if (!hosts) return res.status(400).json({ error: 'Invalid environment' });

    try {
        // Create local backup
        const ts = getTimestamp();
        const bkType = targetType === 'access' ? 'ACCESS' : 'SQUID_CONF';
        const bkName = `${env.toUpperCase()}_${bkType}_${ts}_backup.txt`;
        const bkPath = path.join(BACKUP_DIR, bkName);
        fs.writeFileSync(bkPath, content, 'utf8');

        // Deploy to all servers
        let results = [];
        const reloadCmd = `systemctl reload squid`;

        for (const host of hosts) {
            try {
                await sftpWrite(host, user, finalPassword, remotePath, content);
                const { stdout, stderr } = await executeSSH(host, user, finalPassword, reloadCmd);
                results.push({ host, status: 'Success', logs: stdout + stderr });
            } catch (err) {
                results.push({ host, status: 'Failed', error: err.message });
            }
        }

        auditLog(req.user.username, 'Squid Proxy', `Deployed ${targetType} to Env: ${env}`);
        res.json({ backupFile: bkName, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. List Backups
router.get('/backups', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    try {
        const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.txt')).sort().reverse();
        res.json({ files });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Read Local Backup content
router.post('/backups/read', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    const { filename } = req.body;
    try {
        const safeFilename = path.basename(filename);
        const p = path.join(BACKUP_DIR, safeFilename);
        if (fs.existsSync(p)) {
            res.json({ content: fs.readFileSync(p, 'utf8') });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Dashboard Telemetry & Advanced Analytics Engine
router.post('/dashboard', checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    const { env, linuxPassword } = req.body;
    if (!env) return res.status(400).json({ error: 'Missing environment' });

    const { user, pwd } = getSquidCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    const hosts = getServersForEnv(env.toUpperCase());
    if (!hosts || hosts.length === 0) return res.status(400).json({ error: 'Invalid environment' });
    const host = hosts[0]; // Fetch from first server for dashboard

    try {
        // Fetch last 2000 lines of access.log with rich fields:
        // $1: timestamp, $2: elapsed(ms), $3: clientIp, $4: code/status, $5: bytes, $6: method, $7: url, $9: hierarchy, $10: type
        const logCmd = `tail -n 2000 /var/log/squid/access.log 2>/dev/null | awk '{print $1"|"$2"|"$3"|"$4"|"$5"|"$6"|"$7"|"$9"|"$10}'`;
        const connCmd = `netstat -an | grep :3128 | grep ESTABLISHED | wc -l`;
        
        const [logRes, connRes] = await Promise.all([
            executeSSH(host, user, finalPassword, logCmd),
            executeSSH(host, user, finalPassword, connCmd)
        ]);

        const rawLines = (logRes.stdout || '').split('\n').filter(Boolean);
        
        let totalBytes = 0;
        let totalElapsed = 0;
        let validElapsedCount = 0;
        let hitCount = 0;
        let missCount = 0;
        let deniedCount = 0;
        let errorCount = 0;

        const clientMap = {};
        const domainMap = {};
        const statusMap = { '2xx': 0, '3xx': 0, '403': 0, '4xx': 0, '5xx': 0, 'other': 0 };
        const methodMap = {};
        const deniedEvents = [];
        const parsedLogs = [];

        // Helper to extract clean domain from url or host:port
        const extractDomain = (urlStr) => {
            if (!urlStr) return 'unknown';
            try {
                let clean = urlStr;
                if (clean.includes('://')) {
                    clean = clean.split('://')[1];
                }
                clean = clean.split('/')[0];
                clean = clean.split(':')[0]; // strip port
                return clean.toLowerCase() || urlStr;
            } catch {
                return urlStr;
            }
        };

        for (let i = rawLines.length - 1; i >= 0; i--) {
            const parts = rawLines[i].split('|');
            if (parts.length < 5) continue;

            const rawTs = parseFloat(parts[0]);
            const timestamp = !isNaN(rawTs) ? new Date(rawTs * 1000).toLocaleString('sv-SE').replace(' ', ' ') : '-';
            const elapsed = parseInt(parts[1], 10) || 0;
            const clientIp = (parts[2] || 'unknown').trim();
            const resultCode = (parts[3] || '').trim();
            const bytes = parseInt(parts[4], 10) || 0;
            const method = (parts[5] || 'GET').trim().toUpperCase();
            const url = (parts[6] || '').trim();
            const hierarchy = (parts[7] || '-').trim();
            const contentType = (parts[8] || '-').trim();

            totalBytes += bytes;
            if (elapsed > 0) {
                totalElapsed += elapsed;
                validElapsedCount++;
            }

            // Method stats
            methodMap[method] = (methodMap[method] || 0) + 1;

            // Cache Hit vs Miss vs Denied
            const isHit = resultCode.includes('HIT') || resultCode.includes('REFRESH_UNMODIFIED');
            const isDenied = resultCode.includes('DENIED') || resultCode.includes('/403');
            
            if (isHit) hitCount++;
            else missCount++;

            if (isDenied) deniedCount++;

            // Status codes
            const statusMatch = resultCode.match(/\/(\d{3})/);
            const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;
            if (statusCode >= 200 && statusCode < 300) statusMap['2xx']++;
            else if (statusCode >= 300 && statusCode < 400) statusMap['3xx']++;
            else if (statusCode === 403 || isDenied) statusMap['403']++;
            else if (statusCode >= 400 && statusCode < 500) { statusMap['4xx']++; errorCount++; }
            else if (statusCode >= 500 && statusCode < 600) { statusMap['5xx']++; errorCount++; }
            else statusMap['other']++;

            const domain = extractDomain(url);

            // Client IP Aggregations
            if (!clientMap[clientIp]) {
                clientMap[clientIp] = { ip: clientIp, requests: 0, bytes: 0, denied: 0, domains: {} };
            }
            clientMap[clientIp].requests++;
            clientMap[clientIp].bytes += bytes;
            if (isDenied) clientMap[clientIp].denied++;
            clientMap[clientIp].domains[domain] = (clientMap[clientIp].domains[domain] || 0) + 1;

            // Domain Aggregations
            if (!domainMap[domain]) {
                domainMap[domain] = { domain, requests: 0, bytes: 0, denied: 0, isConnect: method === 'CONNECT' };
            }
            domainMap[domain].requests++;
            domainMap[domain].bytes += bytes;
            if (isDenied) domainMap[domain].denied++;

            const logItem = {
                timestamp,
                elapsed,
                ip: clientIp,
                result: resultCode,
                bytes,
                method,
                url,
                domain,
                statusCode: statusCode || 200,
                isHit,
                isDenied
            };

            // Denied event tracking (up to 50 items)
            if (isDenied && deniedEvents.length < 50) {
                deniedEvents.push(logItem);
            }

            if (parsedLogs.length < 150) {
                parsedLogs.push(logItem);
            }
        }

        const totalReq = rawLines.length;
        const hitRatio = totalReq > 0 ? ((hitCount / totalReq) * 100).toFixed(1) : '0';
        const bandwidthMB = (totalBytes / 1024 / 1024).toFixed(2);
        const avgLatencyMs = validElapsedCount > 0 ? Math.round(totalElapsed / validElapsedCount) : 0;

        // Top 10 Clients (sorted by bandwidth desc)
        const topClients = Object.values(clientMap)
            .map(c => {
                let topD = 'None';
                let maxDC = 0;
                for (const [d, cnt] of Object.entries(c.domains)) {
                    if (cnt > maxDC) { maxDC = cnt; topD = d; }
                }
                return {
                    ip: c.ip,
                    requests: c.requests,
                    bandwidthMB: (c.bytes / 1024 / 1024).toFixed(2),
                    bytes: c.bytes,
                    denied: c.denied,
                    topDomain: topD
                };
            })
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, 10);

        // Top 10 Domains (sorted by request count desc)
        const topDomains = Object.values(domainMap)
            .map(d => ({
                domain: d.domain,
                requests: d.requests,
                bandwidthMB: (d.bytes / 1024 / 1024).toFixed(2),
                bytes: d.bytes,
                denied: d.denied,
                isConnect: d.isConnect
            }))
            .sort((a, b) => b.requests - a.requests)
            .slice(0, 10);

        res.json({
            activeConnections: parseInt(connRes.stdout.trim(), 10) || 0,
            totalRequests: totalReq,
            hitRatio,
            bandwidthMB,
            avgLatencyMs,
            deniedCount,
            errorCount,
            statusBreakdown: statusMap,
            methodBreakdown: methodMap,
            topClients,
            topDomains,
            deniedEvents,
            recentLogs: parsedLogs
        });
    } catch (e) {
        console.error('[Squid Dashboard Error]', e);
        res.status(500).json({ error: e.message });
    }
});

// 6. Toggle URL Block feature in squid.conf
router.post('/config/toggle-block', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, linuxPassword, enable } = req.body;
    if (!env || enable === undefined) return res.status(400).json({ error: 'Missing parameters' });

    const { user, pwd } = getSquidCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    const hosts = getServersForEnv(env.toUpperCase());
    if (!hosts) return res.status(400).json({ error: 'Invalid environment' });

    const BLOCK_CONF = `acl block_url dstdomain "/etc/squid/blacklist.txt"\nhttp_access deny block_url`;

    try {
        let results = [];
        for (const host of hosts) {
            try {
                // Read current squid.conf
                const { stdout: currentConf } = await executeSSH(host, user, finalPassword, `cat /etc/squid/squid.conf`);
                let newConf = currentConf;
                let modified = false;

                const hasBlock = currentConf.includes('acl block_url dstdomain "/etc/squid/blacklist.txt"');

                if (enable && !hasBlock) {
                    // Inject before http_access allow allowip
                    if (newConf.includes('http_access allow allowip')) {
                        newConf = newConf.replace('http_access allow allowip', `${BLOCK_CONF}\nhttp_access allow allowip`);
                        modified = true;
                    } else if (newConf.includes('http_access deny all')) {
                        newConf = newConf.replace('http_access deny all', `${BLOCK_CONF}\nhttp_access deny all`);
                        modified = true;
                    }
                } else if (!enable && hasBlock) {
                    // Remove
                    newConf = newConf.replace(BLOCK_CONF + '\n', '');
                    newConf = newConf.replace(BLOCK_CONF, '');
                    modified = true;
                }

                if (modified) {
                    await sftpWrite(host, user, finalPassword, '/etc/squid/squid.conf', newConf);
                    // Ensure blacklist.txt exists so reload doesn't fail
                    await executeSSH(host, user, finalPassword, `touch /etc/squid/blacklist.txt`);
                    const { stdout, stderr } = await executeSSH(host, user, finalPassword, `systemctl reload squid`);
                    results.push({ host, status: 'Success', logs: stdout + stderr });
                } else {
                    results.push({ host, status: 'Success', logs: 'No changes needed.' });
                }
            } catch (err) {
                results.push({ host, status: 'Failed', error: err.message });
            }
        }

        auditLog(req.user.username, 'Squid Proxy', `${enable ? 'Enabled' : 'Disabled'} URL Block on Env: ${env}`);
        res.json({ results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. AI Security & Traffic Diagnosis Endpoint
router.post('/ai-diagnose', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const { env, stats } = req.body;
        if (!stats) return res.status(400).json({ error: 'Missing stats payload' });

        const aiRouter = require('./ai');
        const config = aiRouter.getAiConfig();
        const check = aiRouter.validateAiConfig(config);
        if (!check.valid) {
            return res.json({
                success: false,
                notConfigured: true,
                message: check.message
            });
        }

        const prompt = `You are a Senior Network Security & Proxy Operations Expert analyzing live Squid Proxy telemetry for environment [${env || 'PRODUCTION'}].

Here is the current aggregated log analysis snapshot:
- Total Requests Analyzed: ${stats.totalRequests || 0}
- Active Connections on Port 3128: ${stats.activeConnections || 0}
- Cache Hit Ratio: ${stats.hitRatio}%
- Bandwidth Transferred: ${stats.bandwidthMB} MB
- Avg Response Time: ${stats.avgLatencyMs} ms
- Security Denials (403/Blocked): ${stats.deniedCount || 0}
- Client/Server Errors (4xx/5xx): ${stats.errorCount || 0}

Top 5 Bandwidth Consuming Clients:
${JSON.stringify(stats.topClients?.slice(0, 5) || [], null, 2)}

Top 5 Visited Domains:
${JSON.stringify(stats.topDomains?.slice(0, 5) || [], null, 2)}

Recent Denied / Blocked Requests (Sample):
${JSON.stringify(stats.deniedEvents?.slice(0, 5) || [], null, 2)}

Please provide a concise, structured Markdown report:
1. 🛡️ **Security & Anomaly Assessment**: Evaluate if there are signs of malware C2 beaconing, port scanning, abnormal data transfers, or compromised clients.
2. 🚨 **Denied Traffic & Threat Review**: Analyze why requests were denied and whether specific client IPs require investigation or subnet isolation.
3. ⚡ **Performance & Cache Optimization**: Actionable suggestions to boost cache hit ratio, reduce latency, and minimize external bandwidth cost.
4. 🔧 **Squid Configuration & ACL Recommendations**: Ready-to-use Squid ACL rules (e.g. blocking suspicious domains, rate limiting, or caching patterns).`;

        const messages = [
            {
                role: 'system',
                content: 'You are an elite Enterprise Network Engineer & Cybersecurity Analyst. Provide clean, professional Markdown with bullet points, threat ratings (Low/Medium/High), and copyable Squid config snippets.'
            },
            {
                role: 'user',
                content: prompt
            }
        ];

        const aiResponse = await aiRouter.callAiEngine(config, messages);
        res.json({
            success: true,
            diagnosis: aiResponse.content,
            model: aiResponse.model,
            provider: aiResponse.provider
        });
    } catch (e) {
        console.error('[Squid AI Diagnose Error]', e);
        const aiRouter = require('./ai');
        res.status(500).json({ error: aiRouter.formatAiError(e) });
    }
});

module.exports = router;
