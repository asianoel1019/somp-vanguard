const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature, checkAnyFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const { readDataSync, db } = require('../lib/db');
const { 
    readJson,
    mutateConfig,
    sendComplianceReport,
    validateInventoryConfig,
    CONFIG_FILE
} = require('../services/inventoryScheduler');
const { isIpv4, isValidApiKey, API_KEY_ERROR, shellQuote, psQuote, mergeConfigPatch, getSubnetSettings, parseSubnetEntry } = require('../lib/inventoryValidation');
const { replaceContents } = require('../lib/docStore');
const inventoryHistory = require('../services/inventoryHistory');
const inventoryCredentials = require('../lib/inventoryCredentials');
const { BOM, csvRow } = require('../lib/csvExport');
const { validateSchedule } = require('../lib/inventorySchedule');
const { readStatus, toApiStatus } = require('../services/inventoryStatus');
const inventoryControl = require('../services/inventoryControl');
const inventoryDeletion = require('../services/inventoryDeletion');
const { getAllSubnetData } = require('../services/inventoryStore');
const failStatus = (e) => (e && e.code === 'INVENTORY_MIGRATION_PENDING' ? 503 : 500);
const { listHostKeys, forgetHostKey } = require('../lib/sshHostKeys');
const { executeSSH, sftpWrite } = require('../lib/ssh');
const { runPowerShell, ENV_CREDENTIAL_HEADER, buildCredentialEnv } = require('../lib/powershell');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { checkTcpPort } = require('../lib/netProbe');

// Roles allowed to change inventory state / run scans / deploy; credential-ish admin endpoints need SuperAdmin
const requireWriter = checkRole(['SuperAdmin', 'Operator']);
const requireSuperAdmin = checkRole(['SuperAdmin']);

// The Host header is attacker-controlled and ends up inside generated scripts: only accept host[:port]
function safeServerUrl(req) {
    const host = String(req.headers.host || '');
    if (!/^[A-Za-z0-9.\-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:]+\](:\d{1,5})?$/.test(host)) return null;
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim().toLowerCase();
    return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

const semver = {
    compare: (v1, v2) => {
        const parse = (v) => (v || '').split('.').map(Number);
        const p1 = parse(v1);
        const p2 = parse(v2);
        for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
            const part1 = p1[i] || 0;
            const part2 = p2[i] || 0;
            if (part1 > part2) return 1;
            if (part1 < part2) return -1;
        }
        return 0;
    }
};

function getLatestWinAgent() {
    const winDir = path.resolve(__dirname, '../../scout/scout-win');
    let latestVersion = '1.0.11';
    let latestFile = 'scout-win.exe';

    try {
        if (fs.existsSync(winDir)) {
            const files = fs.readdirSync(winDir);
            let maxVer = '0.0.0';
            let maxFile = '';
            files.forEach(f => {
                const match = f.match(/^scout-win_v([\d\.]+)\.exe$/);
                if (match) {
                    const ver = match[1];
                    if (semver.compare(ver, maxVer) > 0) {
                        maxVer = ver;
                        maxFile = f;
                    }
                }
            });
            if (maxFile) {
                latestVersion = maxVer;
                latestFile = maxFile;
            } else {
                const mainGoPath = path.join(winDir, 'main.go');
                if (fs.existsSync(mainGoPath)) {
                    const content = fs.readFileSync(mainGoPath, 'utf8');
                    const match = content.match(/const\s+AgentVersion\s*=\s*"([^"]+)"/);
                    if (match) latestVersion = match[1];
                }
            }
        }
    } catch (err) {
        console.error('[Scout] getLatestWinAgent error:', err);
    }
    return { version: latestVersion, filename: latestFile, fullPath: path.join(winDir, latestFile) };
}

function getLatestLinuxAgent() {
    const linuxDir = path.resolve(__dirname, '../../scout/scout-linux');
    let latestVersion = '1.0.10';
    let latestFile = '';

    try {
        if (fs.existsSync(linuxDir)) {
            const files = fs.readdirSync(linuxDir);
            let maxVer = '0.0.0';
            let maxFile = '';
            files.forEach(f => {
                const match = f.match(/^scout-([\d\.]+)(?:-\d+)?\..*\.rpm$/) || f.match(/^scout-([\d\.]+)\.rpm$/);
                if (match) {
                    const ver = match[1];
                    if (semver.compare(ver, maxVer) > 0) {
                        maxVer = ver;
                        maxFile = f;
                    }
                }
            });
            if (maxFile) {
                latestVersion = maxVer;
                latestFile = maxFile;
            } else {
                const mainGoPath = path.join(linuxDir, 'main.go');
                if (fs.existsSync(mainGoPath)) {
                    const content = fs.readFileSync(mainGoPath, 'utf8');
                    const match = content.match(/const\s+AgentVersion\s*=\s*"([^"]+)"/);
                    if (match) latestVersion = match[1];
                }
                const anyRpm = files.find(f => f.endsWith('.rpm'));
                if (anyRpm) latestFile = anyRpm;
            }
        }
    } catch (err) {
        console.error('[Scout] getLatestLinuxAgent error:', err);
    }
    return { version: latestVersion, filename: latestFile, fullPath: latestFile ? path.join(linuxDir, latestFile) : '' };
}

function getLatestLinuxDebAgent() {
    const linuxDir = path.resolve(__dirname, '../../scout/scout-linux');
    let latestVersion = '1.0.15';
    let latestFile = '';

    try {
        if (fs.existsSync(linuxDir)) {
            const files = fs.readdirSync(linuxDir);
            let maxVer = '0.0.0';
            let maxFile = '';
            files.forEach(f => {
                const match = f.match(/^scout-([\d\.]+)(?:-\d+)?\..*\.deb$/) || f.match(/^scout-([\d\.]+)\.deb$/) || f.match(/^scout-([\d\.]+)-amd64\.deb$/);
                if (match) {
                    const ver = match[1];
                    if (semver.compare(ver, maxVer) > 0) {
                        maxVer = ver;
                        maxFile = f;
                    }
                }
            });
            if (maxFile) {
                latestVersion = maxVer;
                latestFile = maxFile;
            } else {
                const anyDeb = files.find(f => f.endsWith('.deb'));
                if (anyDeb) latestFile = anyDeb;
            }
        }
    } catch (err) {
        console.error('[Scout] getLatestLinuxDebAgent error:', err);
    }
    return { version: latestVersion, filename: latestFile || 'scout-1.0.15-amd64.deb', fullPath: latestFile ? path.join(linuxDir, latestFile) : path.join(linuxDir, 'scout-1.0.15-amd64.deb') };
}

router.getLatestWinAgent = getLatestWinAgent;
router.getLatestLinuxAgent = getLatestLinuxAgent;
router.getLatestLinuxDebAgent = getLatestLinuxDebAgent;

// Store short-lived install tokens (Key: UUID, Value: { apiKey, expiresAt })
const installTokens = new Map();

// Public route for downloading the agent during deployment
router.get('/download-scout-win', (req, res) => {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    console.log(`[Download Scout Win] Incoming request from: ${clientIp} (Host: ${req.headers.host})`);
    const agent = router.getLatestWinAgent();
    if (fs.existsSync(agent.fullPath)) {
        console.log(`[Download Scout Win] Sending agent binary: ${agent.fullPath} (${(fs.statSync(agent.fullPath).size / 1024 / 1024).toFixed(2)} MB) to ${clientIp}...`);
        res.download(agent.fullPath, 'scout-win.exe', (err) => {
            if (err) {
                console.error(`[Download Scout Win] Transmission failed/aborted to ${clientIp}:`, err.message);
                if (!res.headersSent) res.status(500).send('Download interrupted');
            } else {
                console.log(`[Download Scout Win] Successfully delivered ${agent.filename} to ${clientIp}`);
            }
        });
    } else {
        console.error(`[Download Scout Win] Target executable not found: ${agent.fullPath}`);
        res.status(404).send('Not found');
    }
});

router.get('/download-scout-agent-win', (req, res) => {
    const payloadDir = path.resolve(__dirname, '../../scout/scout-win/installer/payload');
    const agentBinary = path.join(payloadDir, 'scout-agent.exe');
    if (fs.existsSync(agentBinary)) {
        res.download(agentBinary, 'scout-agent.exe');
    } else {
        res.status(404).send('Not found');
    }
});

router.get('/download-scout-linux', (req, res) => {
    const binPath = path.resolve(__dirname, '../../scout/scout-linux/scout-linux');
    if (fs.existsSync(binPath)) res.download(binPath);
    else res.status(404).send('Not found');
});

router.get('/download-scout-linux-rpm', (req, res) => {
    const agent = router.getLatestLinuxAgent();
    if (agent.fullPath && fs.existsSync(agent.fullPath)) {
        res.download(agent.fullPath, agent.filename);
    } else {
        res.status(404).send('Not found');
    }
});

router.get('/download-scout-linux-deb', (req, res) => {
    const agent = router.getLatestLinuxDebAgent();
    if (agent.fullPath && fs.existsSync(agent.fullPath)) {
        res.download(agent.fullPath, agent.filename);
    } else {
        res.status(404).send('Not found');
    }
});

router.get('/install.ps1', (req, res) => {
    const token = req.query.token;
    if (!token || !installTokens.has(token)) return res.status(401).send('Invalid or expired install token');
    
    const tokenData = installTokens.get(token);
    if (Date.now() > tokenData.expiresAt) {
        installTokens.delete(token);
        return res.status(401).send('Token has expired');
    }
    
    const apiKey = tokenData.apiKey;
    if (!isValidApiKey(apiKey)) return res.status(400).send('API key contains unsupported characters');
    tokenData.uses = (tokenData.uses || 0) + 1;
    
    // Multi-use token logic: delete only if maxUses is reached
    if (tokenData.uses >= tokenData.maxUses) {
        installTokens.delete(token);
    }
    const serverUrl = safeServerUrl(req);
    if (!serverUrl) return res.status(400).send('Invalid Host header');

    const script = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$ServerUrl = "${serverUrl}"
$ApiKey = ${psQuote(apiKey)}
$TempInstaller = "$env:TEMP\\scout-win-installer.exe"

Write-Host "Starting Scout Agent Installation for Windows..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Host "Downloading Scout Agent installer..."
Invoke-WebRequest -Uri "$ServerUrl/api/inventory/download-scout-win" -OutFile $TempInstaller -UseBasicParsing -TimeoutSec 180

Write-Host "Installing Scout Windows Service..."
# Stop existing service if running before overwrite to prevent file locks
Stop-Service -Name ScoutAgent -Force -ErrorAction SilentlyContinue
Get-Process -Name scout -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Unregister legacy scheduled task if exists
Unregister-ScheduledTask -TaskName "ScoutMonitorAgent" -Confirm:$false -ErrorAction SilentlyContinue

# Execute installer silently
Start-Process -FilePath $TempInstaller -ArgumentList "-silent" -Wait

# Update configuration
$InstallDir = "C:\\Program Files\\scout-win"
$targetConfig = "$InstallDir\\config.json"
$configJson = @"
{
  "apiKey": "$ApiKey",
  "backendUrl": "$ServerUrl",
  "reportInterval": 60,
  "pingTargets": [],
  "tcpTargets": [],
  "watchServices": [],
  "watchProcesses": []
}
"@
[IO.File]::WriteAllText($targetConfig, $configJson)

# Restart Windows Service to apply new config
net stop ScoutAgent 2>$null
net start ScoutAgent 2>$null

# Cleanup temporary installer
Remove-Item -Force $TempInstaller -ErrorAction SilentlyContinue

Write-Host "Installation completed successfully! ScoutAgent Windows Service is now running."
`;
    res.type('text/plain').send(script.trim());
});

router.get('/install.sh', (req, res) => {
    const token = req.query.token;
    if (!token || !installTokens.has(token)) return res.status(401).send('Invalid or expired install token');
    
    const tokenData = installTokens.get(token);
    if (Date.now() > tokenData.expiresAt) {
        installTokens.delete(token);
        return res.status(401).send('Token has expired');
    }
    
    const apiKey = tokenData.apiKey;
    if (!isValidApiKey(apiKey)) return res.status(400).send('API key contains unsupported characters');
    tokenData.uses = (tokenData.uses || 0) + 1;
    
    // Multi-use token logic: delete only if maxUses is reached
    if (tokenData.uses >= tokenData.maxUses) {
        installTokens.delete(token);
    }

    const serverUrl = safeServerUrl(req);
    if (!serverUrl) return res.status(400).send('Invalid Host header');

    const script = `
#!/bin/bash
set -e
SERVER_URL="${serverUrl}"
API_KEY=${shellQuote(apiKey)}

echo "Starting Scout Agent Installation for Linux..."

echo "Configuring Scout Agent..."
mkdir -p /etc/scout

# Safely update config.json without destroying existing policies
if [ -f /etc/scout/config.json ]; then
    echo "Existing config.json found. Updating backendUrl and apiKey..."
    # We use python to safely merge JSON since it's universally available
    python3 -c '
import json, sys
try:
    with open("/etc/scout/config.json", "r") as f: c = json.load(f)
except:
    c = {}
c["apiKey"] = "'$API_KEY'"
c["backendUrl"] = "'$SERVER_URL'"
c.setdefault("reportInterval", 60)
c.setdefault("pingTargets", [])
c.setdefault("tcpTargets", [])
c.setdefault("watchServices", [])
c.setdefault("watchProcesses", [])
with open("/etc/scout/config.json", "w") as f: json.dump(c, f, indent=2)
' || echo "Failed to merge config gracefully"
else
    cat > /etc/scout/config.json <<EOF
{
  "apiKey": "$API_KEY",
  "backendUrl": "$SERVER_URL",
  "reportInterval": 60,
  "pingTargets": [],
  "tcpTargets": [],
  "watchServices": [],
  "watchProcesses": []
}
EOF
fi

echo "Downloading and installing Scout Agent..."

# Detect Linux OS distribution family (Debian/Ubuntu vs RHEL/CentOS/Rocky/Alma/Fedora)
IS_DEBIAN=0
if [ -f /etc/debian_version ] || command -v dpkg >/dev/null 2>&1 || command -v apt-get >/dev/null 2>&1; then
    IS_DEBIAN=1
fi

if [ "$IS_DEBIAN" -eq 1 ]; then
    echo "Detected Debian/Ubuntu environment. Downloading Scout DEB package (scout-1.0.15-amd64.deb)..."
    curl -sL "$SERVER_URL/api/inventory/download-scout-linux-deb" -o /tmp/scout-linux.deb

    if grep -q "Not found" /tmp/scout-linux.deb; then
        echo "Error: DEB package not found on the server."
        exit 1
    fi

    echo "Installing DEB package..."
    dpkg -i /tmp/scout-linux.deb || apt-get install -f -y
    rm -f /tmp/scout-linux.deb
else
    echo "Detected RHEL/CentOS/AlmaLinux/Rocky environment. Downloading Scout RPM package..."
    curl -sL "$SERVER_URL/api/inventory/download-scout-linux-rpm" -o /tmp/scout-linux.rpm

    if grep -q "Not found" /tmp/scout-linux.rpm; then
        echo "Error: RPM package not found on the server."
        exit 1
    fi

    echo "Installing RPM package..."
    rpm -Uvh --force /tmp/scout-linux.rpm
    rm -f /tmp/scout-linux.rpm
fi

echo "Starting service..."
systemctl daemon-reload
systemctl enable scout
systemctl restart scout

echo "Installation completed successfully! The service 'scout' is now running."
`;
    res.type('text/plain').send(script.trim());
});

router.use(requireAuth);

// --- API Endpoints ---
// install-token is used by the Agents / Alerts screens, which have their own feature flags

const MAX_INSTALL_TOKENS = 1000;
router.post('/install-token', checkAnyFeature('monitorAgents', 'monitorAlerts', 'monitorScout', 'inventory'), requireWriter, async (req, res) => {
    const { apiKey } = req.body || {};
    if (!apiKey || typeof apiKey !== 'string') return res.status(400).json({ error: 'Missing apiKey' });
    // The key must be a real Scout API key: the token ends up inside generated install scripts
    let known = false;
    try {
        const scoutDb = require('../services/scoutDb');
        known = !!(await scoutDb.get('SELECT 1 AS ok FROM api_keys WHERE key = ?', [apiKey]));
    } catch (e) { known = false; }
    if (!known) return res.status(400).json({ error: 'Unknown apiKey' });
    if (!isValidApiKey(apiKey)) return res.status(400).json({ error: API_KEY_ERROR });

    const clamp = (v, lo, hi, dflt) => {
        const n = Number(v === undefined || v === null || v === '' ? dflt : v);
        if (!Number.isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
    };
    const validHours = clamp(req.body.expiresInHours, 5 / 60, 168, 5 / 60);
    const maxUses = Math.floor(clamp(req.body.maxUses, 1, 100000, 1));
    const expiresAt = Date.now() + Math.floor(validHours * 60 * 60 * 1000);

    // Evict expired tokens first, then the oldest ones, so the map stays bounded
    for (const [key, val] of installTokens.entries()) {
        if (Date.now() > val.expiresAt) installTokens.delete(key);
    }
    while (installTokens.size >= MAX_INSTALL_TOKENS) {
        installTokens.delete(installTokens.keys().next().value);
    }

    const token = crypto.randomUUID();
    installTokens.set(token, { apiKey, expiresAt, maxUses, uses: 0 });
    res.json({ token });
});

// Everything below needs the 'inventory' feature (reads) plus a role check on every state-changing route
// /deploy-agent and GET /data are shared with other screens and carry their own (any-of) feature checks.
const inventoryGate = checkFeature('inventory');
router.use((req, res, next) => ((req.path === '/deploy-agent' || (req.method === 'GET' && req.path === '/data')) ? next() : inventoryGate(req, res, next)));

// The web RAM cache may lag behind the worker's lastScan/lastDiscovered write (and the shared database may lag behind
// this process's own just-saved edits), so: editable fields come from the cached copy, the server-owned scan fields
// from whichever of the cached / database copies has the newer lastScan.
async function readStoredConfig() {
    const cached = readJson(CONFIG_FILE, {}) || {};
    try {
        const row = await require('../services/scoutDb').get('SELECT value FROM document_store WHERE "key" = ?', ['server_operation/oscheck/config.json']);
        const fresh = row && row.value ? JSON.parse(row.value) : null;
        if (fresh && typeof fresh === 'object') {
            const t = (c) => { const n = new Date(c.lastScan || 0).getTime(); return Number.isFinite(n) ? n : 0; };
            if (t(fresh) > t(cached)) return { ...cached, lastScan: fresh.lastScan, lastDiscovered: fresh.lastDiscovered };
        }
    } catch (e) { /* the cached copy is good enough */ }
    return cached;
}

router.get('/config', async (req, res) => {
    const stored = await readStoredConfig();
    const config = {
        subnets: [], schedule: { enabled: false, time: '08:00', frequency: 'daily' }, lastScan: null,
        newHostAlerts: true, historyRetentionDays: inventoryHistory.DEFAULT_RETENTION_DAYS, ...stored
    };
    config.subnetSettings = getSubnetSettings(stored); // as stored; legacy timezoneCheck.subnetOffsets stay in timezoneCheck
    res.json(config);
});

// PATCH semantics: only the editable fields of the body are merged into the stored config; lastScan / lastDiscovered
// (and anything else the server owns) are never taken from the client. The worker owns scanning and scheduling.
router.post('/config', requireWriter, async (req, res) => {
    const check = validateInventoryConfig(req.body);
    if (!check.valid) {
        return res.status(400).json({ error: `Invalid inventory configuration: ${check.errors.slice(0, 5).join('; ')}`, errors: check.errors });
    }
    // Serialised with credential profile deletes: a profile can not vanish between the existence check and the save
    return inventoryCredentials.runExclusive(async () => {
        const existing = await readStoredConfig();
        const nextSettings = req.body.subnetSettings === null ? {} : check.subnetSettings;
        if (nextSettings !== undefined) {
            // Which stored secrets a subnet uses is a SuperAdmin decision: any add / change / removal is refused for others
            if (req.user.role !== 'SuperAdmin') {
                const profileOf = (map) => { const o = {}; for (const [k, v] of Object.entries(map || {})) if (v && v.credentialProfile) o[k] = v.credentialProfile; return o; };
                const before = profileOf(existing.subnetSettings);
                const after = profileOf(nextSettings);
                const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
                const changed = [...keys].filter(k => before[k] !== after[k]);
                if (changed.length) {
                    return res.status(403).json({ error: `Access denied. Credential profile change on subnet(s) ${changed.join(', ')} refused: only a SuperAdmin can change credential profiles.` });
                }
            }
            const unknown = [];
            for (const [k, v] of Object.entries(nextSettings)) {
                if (v.credentialProfile && !inventoryCredentials.hasProfile(v.credentialProfile)) unknown.push(`subnetSettings "${k}": credential profile "${v.credentialProfile}" does not exist`);
            }
            if (unknown.length) return res.status(400).json({ error: `Invalid inventory configuration: ${unknown.slice(0, 5).join('; ')}`, errors: unknown });
        }
        // The patch is merged into the CURRENT stored config in ONE atomic read-modify-write (the worker writes
        // lastScan / lastDiscovered into the same document; the reads above were awaited)
        const schedErrors = mutateConfig((current) => {
            const toSave = mergeConfigPatch(current, req.body, check);
            // a newer lastScan that so far only reached the shared active database (readStoredConfig) is kept
            const scanMs = (c) => { const n = new Date((c && c.lastScan) || 0).getTime(); return Number.isFinite(n) ? n : 0; };
            if (scanMs(existing) > scanMs(toSave)) { toSave.lastScan = existing.lastScan; toSave.lastDiscovered = existing.lastDiscovered; }
            if (req.body.schedule !== undefined && req.body.schedule !== null) {
                // The schedule is merged per sub-field, so completeness is checked on the merged result
                const errs = validateSchedule(toSave.schedule);
                if (errs.length) return errs;
            }
            replaceContents(current, toSave);
            return [];
        }, { reason: 'inventory settings' });
        if (schedErrors.length) {
            return res.status(400).json({ error: `Invalid inventory configuration: ${schedErrors.slice(0, 5).join('; ')}`, errors: schedErrors });
        }
        auditLog(req.user.username, 'Inventory', 'Updated inventory configuration');
        const reloaded = inventoryControl.requestSchedulerReload();
        res.json({
            success: true,
            warnings: check.warnings || [],
            schedulerReloaded: reloaded,
            schedulerNote: reloaded ? null : 'The background worker is unavailable; the new schedule will be applied when it restarts.'
        });
    });
});

router.get('/data', checkAnyFeature('inventory', 'workflow'), (req, res) => {
    const data = getAllSubnetData();
    res.json(data);
});

// Scan status endpoint: the worker writes the status document, the web process reads it from the shared database
router.get('/scan-status', async (req, res) => {
    try {
        res.json(toApiStatus(await readStatus()));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Scans run only in the background worker; the web process just hands over the request (optionally { subnet } or { ip })
router.post('/scan-now', requireWriter, async (req, res) => {
    try {
        const result = await inventoryControl.requestScan({ body: req.body, requestedBy: req.user.username });
        if (result.status === 202) {
            const scope = result.body.scope;
            auditLog(req.user.username, 'Inventory', `Requested server inventory scan${scope ? ` (${scope.ip || scope.subnet})` : ''}`);
        }
        res.status(result.status).json(result.body);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/send-report', requireWriter, async (req, res) => {
    const result = await sendComplianceReport();
    if (result.success) {
        auditLog(req.user.username, 'Inventory', `Manually triggered compliance report (Issues found: ${result.count || 0})`);
        res.json({ message: result.message || 'Report sent successfully', count: result.count });
    } else {
        res.status(500).json({ message: 'Failed to send report', error: result.error });
    }
});

router.post('/abort-scan', requireWriter, async (req, res) => {
    try {
        const result = await inventoryControl.requestAbort({ requestedBy: req.user.username });
        if (result.status === 200) auditLog(req.user.username, 'Inventory', 'Requested to abort scan');
        res.status(result.status).json(result.body);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- Delete: one path (serverDeletion / performServerDelete) + inventory row + IPAM release ('used' only) ---
function parseCleanup(body) {
    const c = (body && typeof body.cleanup === 'object' && body.cleanup) || {};
    return { prometheus: c.prometheus === true, scoutHistory: c.scoutHistory === true, ruleBindings: c.ruleBindings === true };
}

// force bypasses the "offline long enough" guard: SuperAdmin only (checked here, audited by the delete service)
function wantsForce(req) {
    return (req.body && req.body.force === true) || String(req.query.force || '').toLowerCase() === 'true';
}

function parseIpList(ips) {
    if (!Array.isArray(ips) || ips.length === 0) return { error: 'Missing ips array' };
    if (ips.length > inventoryDeletion.MAX_BULK) return { error: `At most ${inventoryDeletion.MAX_BULK} IPs per request` };
    const list = ips.map(i => String(i == null ? '' : i).trim());
    const bad = list.find(i => !isIpv4(i));
    if (bad !== undefined && !isIpv4(bad)) return { error: `Invalid IPv4 address: ${String(bad).slice(0, 40)}` };
    return { list };
}

// What a delete of these hosts would touch: the Server List delete preview plus inventory / IPAM lines (read-only)
router.post('/delete-preview', requireWriter, async (req, res) => {
    try {
        const parsed = parseIpList((req.body || {}).ips);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        const previews = await inventoryDeletion.previewInventoryDelete(parsed.list);
        res.json({ success: true, previews, offlineDeleteDays: inventoryDeletion.getOfflineDeleteDays() });
    } catch (e) {
        res.status(failStatus(e)).json({ error: e.message });
    }
});

// Hosts offline for more than N days: { days, dryRun (default true), cleanup }. dryRun lists / previews only.
router.post('/bulk-delete-offline', requireWriter, async (req, res) => {
    try {
        const body = req.body || {};
        if (body.force !== undefined && body.force !== false) return res.status(400).json({ error: 'force is not supported for bulk delete' });
        const dryRun = body.dryRun !== false;
        let ips = null;
        if (!dryRun) {
            const parsed = parseIpList(body.ips);
            if (parsed.error) return res.status(400).json({ error: `Confirmed ips required: ${parsed.error}` });
            ips = parsed.list;
        }
        const result = await inventoryDeletion.bulkDeleteOffline({
            days: body.days, dryRun, ips, cleanup: parseCleanup(body), username: req.user?.username || 'SYSTEM'
        });
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(e.status || failStatus(e)).json({ error: e.message });
    }
});

router.delete('/server/:ip', requireWriter, async (req, res) => {
    try {
        const ip = req.params.ip;
        if (!isIpv4(ip)) return res.status(400).json({ error: 'Invalid IPv4 address' });
        const force = wantsForce(req);
        if (force && req.user?.role !== 'SuperAdmin') {
            return res.status(403).json({ error: 'Access denied. Force delete requires SuperAdmin.' });
        }
        const result = await inventoryDeletion.deleteInventoryHosts([ip], {
            cleanup: parseCleanup(req.body), username: req.user?.username || 'SYSTEM', force, historyAction: 'INVENTORY_DELETE'
        });
        if (result.missing.length) return res.status(404).json({ error: 'Server not found in inventory' });
        if (result.blocked.length) {
            const b = result.blocked[0];
            return res.status(409).json({
                error: `Delete blocked: ${b.reason}`, code: 'OFFLINE_GUARD', reason: b.reason,
                requiredDays: inventoryDeletion.getOfflineDeleteDays(), canForce: req.user?.role === 'SuperAdmin'
            });
        }
        res.json({
            message: 'Server deleted successfully',
            result: {
                success: true, ip, forced: result.forced.length > 0,
                removedFromInventory: result.deleted.includes(ip),
                removedFromServerList: result.serverList > 0,
                releasedInIpam: result.ipamReleased.includes(ip),
                ipamKept: result.ipamKept,
                cleaned: result.cleaned,
                cleanup: result.cleanupStarted ? 'started' : undefined
            }
        });
    } catch (e) {
        res.status(failStatus(e)).json({ error: e.message });
    }
});

router.post('/server/:ip/tags', requireWriter, async (req, res) => {
    try {
        const ip = req.params.ip;
        if (!isIpv4(ip)) return res.status(400).json({ error: 'Invalid IPv4 address' });
        const { tags } = req.body;
        if (tags !== undefined && (!Array.isArray(tags) || tags.length > 50 || tags.some(t => typeof t !== 'string' || t.length > 64))) {
            return res.status(400).json({ error: 'tags must be an array of up to 50 strings (max 64 characters each)' });
        }

        const { updateServerTags } = require('../services/inventoryScheduler');
        const result = updateServerTags(ip, tags || []);
        auditLog(req.user.username, 'Inventory', `Updated tags for server ${ip}: [${(tags || []).join(', ')}]`);
        res.json({ message: 'Tags updated successfully', result });
    } catch (e) {
        res.status(failStatus(e)).json({ error: e.message });
    }
});

router.post('/deploy-agent', checkAnyFeature('inventory', 'monitorScout', 'serverCheck'), requireWriter, async (req, res) => {
    try {
        const { ip, os, hostname } = req.body;
        if (!ip || !os) return res.status(400).json({ error: 'IP and OS are required' });
        if (!isIpv4(ip)) return res.status(400).json({ error: 'Invalid IPv4 address' });

        // Same credential source as the scanner: the subnet's credential profile, else AD_ADMIN_* / LINUX_ADMIN_*
        const creds = inventoryCredentials.resolveCredentials(await readStoredConfig(), ip);
        const scoutDb = require('../services/scoutDb');
        
        // 1. Prepare Global API Key
        let apiKeyObj = scoutDb.get("SELECT * FROM api_keys WHERE name = 'ServerInventory Global API Key'");
        if (!apiKeyObj) {
            const newKey = crypto.randomBytes(32).toString('hex');
            const newId = crypto.randomUUID();
            scoutDb.run("INSERT INTO api_keys (id, name, desc, key, createdAt, envId) VALUES (?,?,?,?,?,?)",
                [newId, 'ServerInventory Global API Key', 'Auto-generated for Server Inventory auto-deployments', newKey, new Date().toISOString(), null]);
            apiKeyObj = { key: newKey };
        }
        const apiKey = apiKeyObj.key;
        
        // Server URL
        const serverUrl = safeServerUrl(req);
        if (!serverUrl) return res.status(400).json({ error: 'Invalid Host header' });

        const baseConfig = {
            backendUrl: serverUrl,
            apiKey: apiKey,
            reportInterval: 60,
            hostname: hostname || ip
        };

        const osLower = (os || '').toLowerCase();
        if (osLower.includes('linux') || osLower.includes('centos') || osLower.includes('ubuntu') || osLower.includes('redhat') || osLower.includes('rocky') || osLower.includes('debian')) {
            baseConfig.disableReportLog = req.body.disableReportLog !== undefined ? req.body.disableReportLog : true;
            baseConfig.logPath = req.body.logPath || "/var/log/scout-agent.log";
        }
        const configJson = JSON.stringify(baseConfig, null, 2);

        // An undecryptable credential profile password is refused up front (never an empty / fallback password)
        const isWinTarget = osLower === 'win' || osLower.includes('windows');
        const usesStoredCreds = isWinTarget ? (req.user.domain === 'local' || !req.user.password) : !(req.body.linuxPassword || req.body.password);
        const credError = isWinTarget ? creds.winError : creds.linuxError;
        if (credError && usesStoredCreds) {
            return res.status(409).json({ error: `Cannot deploy: ${credError}. A SuperAdmin must re-enter the credential profile password.` });
        }

        console.log(`[Deploy Agent] Target: ${ip} (${hostname || 'no-hostname'}, OS: ${os}), ServerURL: ${serverUrl}`);

        if (osLower === 'win' || osLower.includes('windows')) {
            const agent = router.getLatestWinAgent();
            if (!fs.existsSync(agent.fullPath)) {
                return res.status(500).json({ error: 'scout Windows executable not found on server' });
            }

            const confB64 = Buffer.from(configJson).toString('base64');

            let winUser = req.user.username;
            let winDomain = req.user.domain;
            let winPwd = req.user.password;

            if (req.user.domain === 'local' || !req.user.password) {
                winUser = creds.winUser || 'Administrator';
                winPwd = creds.winPassword || '';
                // If the user specifies domain\username in AD_ADMIN_USER, we should parse it.
                // Otherwise assume the local machine domain '.' or a domain from .env
                if (winUser.includes('\\')) {
                    const parts = winUser.split('\\');
                    winDomain = parts[0];
                    winUser = parts[1];
                } else {
                    winDomain = creds.adDomain || process.env.USERDOMAIN || '.';
                }
            }

            if (!winPwd) {
                return res.status(400).json({ error: 'WinRM requires explicit credentials for IP deployment. Please configure AD_ADMIN_USER and AD_ADMIN_PWD in .env or login via AD.' });
            }

            // Fast probe: check if WinRM port 5985 is open (fail fast in 2.5s instead of blocking for 180s)
            const isWinRmOpen = await checkTcpPort(ip, 5985, 2500);
            if (!isWinRmOpen) {
                console.warn(`[Deploy Agent] WinRM port 5985 unreachable on ${ip}:2500 (host offline or port blocked). Skipping fast.`);
                return res.status(400).json({ error: `WinRM 服務無法連線至 ${ip}:5985 (主機離線或通訊埠未開放)` });
            }

            // Credentials go to PowerShell through the process environment, never into the script file
            const credEnv = buildCredentialEnv(`${winDomain}\\${winUser}`, winPwd);
            const credArg = '-Credential $global:AD_CRED';

            // TrustedHosts: never "*". Only this single target is appended (if not already trusted).
            const psScript = `
                 $ErrorActionPreference = "Stop"
                 try {
                     $th = (Get-Item WSMan:\\localhost\\Client\\TrustedHosts -ErrorAction Stop).Value
                     if ($th -ne '*' -and (($th -split ',') | ForEach-Object { $_.Trim() }) -notcontains "${ip}") {
                         $newTh = if ([string]::IsNullOrWhiteSpace($th)) { "${ip}" } else { "$th,${ip}" }
                         Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value $newTh -Force -ErrorAction Stop
                     }
                 } catch {}
                 ${ENV_CREDENTIAL_HEADER}
                 
                 Invoke-Command -ComputerName "${ip}" ${credArg} -ScriptBlock {
                     $ProgressPreference = "SilentlyContinue"
                     $TempInstaller = "$env:TEMP\\scout-win-installer.exe"
                     Remove-Item -Force $TempInstaller -ErrorAction SilentlyContinue
                     
                     $downloadUrl = "${serverUrl}/api/inventory/download-scout-win"
                     [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                     try {
                         $wc = New-Object System.Net.WebClient
                         $wc.Proxy = $null
                         $wc.DownloadFile($downloadUrl, $TempInstaller)
                     } catch {
                         Invoke-WebRequest -Uri $downloadUrl -OutFile $TempInstaller -UseBasicParsing
                     }
                     
                     # Remove legacy scheduled task if exists
                     Unregister-ScheduledTask -TaskName "ScoutMonitorAgent" -Confirm:$false -ErrorAction SilentlyContinue
                     
                     # Run self-extracting installer silently (wait at most 15s for installer to exit, avoid WinRM hang on background service)
                     $proc = Start-Process -FilePath $TempInstaller -ArgumentList "-silent" -PassThru
                     $null = $proc.WaitForExit(15000)
                     
                     # Update custom configuration
                     $InstallDir = "C:\\Program Files\\scout-win"
                     $targetConfig = "$InstallDir\\config.json"
                     $confBytes = [System.Convert]::FromBase64String("${confB64}")
                     [System.IO.File]::WriteAllBytes($targetConfig, $confBytes)
                     
                     # Restart service reliably without blocking SCM
                     Restart-Service -Name "ScoutAgent" -Force -ErrorAction SilentlyContinue
                     
                     # Cleanup installer
                     Remove-Item -Force $TempInstaller -ErrorAction SilentlyContinue
                 }
              `;
              await runPowerShell(psScript, 60000, { env: credEnv });

        } else if (osLower.includes('linux') || osLower.includes('centos') || osLower.includes('ubuntu') || osLower.includes('redhat') || osLower.includes('rocky') || osLower.includes('debian') || osLower.includes('alma')) {
            // Fast probe: check if SSH port 22 is open (fail fast in 2.5s)
            const isSshOpen = await checkTcpPort(ip, 22, 2500);
            if (!isSshOpen) {
                return res.status(400).json({ error: `SSH 服務無法連線至 ${ip}:22 (連線逾時或通訊埠未開放)` });
            }
            const isUbuntuDebian = osLower.includes('ubuntu') || osLower.includes('debian');
            let pkgPath = '';
            let pkgExt = 'rpm';

            if (isUbuntuDebian) {
                const debAgent = getLatestLinuxDebAgent();
                if (debAgent.fullPath && fs.existsSync(debAgent.fullPath)) {
                    pkgPath = debAgent.fullPath;
                    pkgExt = 'deb';
                }
            }

            if (!pkgPath) {
                const rpmAgent = getLatestLinuxAgent();
                if (rpmAgent.fullPath && fs.existsSync(rpmAgent.fullPath)) {
                    pkgPath = rpmAgent.fullPath;
                    pkgExt = 'rpm';
                }
            }

            if (!pkgPath || !fs.existsSync(pkgPath)) {
                return res.status(500).json({ error: `Scout Linux ${isUbuntuDebian ? 'DEB' : 'RPM'} package not found in scout-linux directory` });
            }

            const linuxUser = req.body.linuxUser || req.body.username || creds.linuxUser || 'xyuser';
            const linuxPwd = req.body.linuxPassword || req.body.password || creds.linuxPassword || (req.user && req.user.password ? req.user.password : '');
            if (!linuxPwd) {
                return res.status(400).json({ error: 'LINUX_ADMIN_PWD is not configured in .env and no password was provided' });
            }

            const ts = Date.now();
            const tempPkg = `/tmp/scout_deploy_${ts}.${pkgExt}`;
            const tempConfig = `/tmp/scout_config_${ts}.json`;
            const tempScript = `/tmp/scout_install_${ts}.sh`;
            
            // Upload Package and Config via SFTP
            const pkgBuffer = fs.readFileSync(pkgPath);
            const sshOpts = { pinHostKey: true };
            await sftpWrite(ip, linuxUser, linuxPwd, tempPkg, pkgBuffer, sshOpts);
            await sftpWrite(ip, linuxUser, linuxPwd, tempConfig, Buffer.from(configJson, 'utf-8'), sshOpts);

            // Create and upload installer script
            const installCmd = pkgExt === 'deb' ? `dpkg -i "${tempPkg}"` : `rpm -Uvh --force "${tempPkg}"`;
            const scriptContent = `#!/bin/bash
set -e
${installCmd}
mkdir -p /etc/scout
cp -f "${tempConfig}" /etc/scout/config.json
systemctl daemon-reload
systemctl enable scout
systemctl restart scout
rm -f "${tempPkg}" "${tempConfig}" "${tempScript}"
`;
            await sftpWrite(ip, linuxUser, linuxPwd, tempScript, Buffer.from(scriptContent, 'utf-8'), sshOpts);

            // Execute script
            // The sudo password is sent over the exec channel's stdin, never on the command line
            let runCmd = '';
            let stdin;
            if (linuxUser === 'root') {
                runCmd = `bash ${tempScript}`;
            } else {
                runCmd = `sudo -S -p '' sh -c 'exec bash ${tempScript} </dev/null'`;
                stdin = `${linuxPwd}\n`;
            }

            const sshResult = await executeSSH(ip, linuxUser, linuxPwd, runCmd, { timeout: 45000, pinHostKey: true, stdin });
            if (!sshResult.success) {
                const errDetail = (sshResult.stderr || sshResult.stdout || '').trim();
                throw new Error(`Agent installation failed (exit code ${sshResult.code}): ${errDetail || 'Unknown execution error'}`);
            }
        } else {
            return res.status(400).json({ error: 'Unsupported OS for deployment' });
        }

        auditLog(req.user.username, 'Inventory', `Auto-deployed Scout Agent to ${ip} (${os})`);
        
        // Linkage: Auto-sync to Prometheus Targets
        try {
            const { autoSyncPrometheusTarget } = require('../services/inventoryScheduler');
            await autoSyncPrometheusTarget(ip, hostname, os);
        } catch (syncErr) {
            console.warn('[Inventory Deploy] Auto-sync to Prometheus warning:', syncErr.message);
        }

        res.json({ success: true, message: 'Agent deployed successfully' });

    } catch (e) {
        console.error('[Deploy Agent Error]', e);
        const errMsg = e.stderr || e.message || (e.error && e.error.message) || String(e);
        res.status(500).json({ error: errMsg });
    }
});

// POST /link
// Link a secondary IP (VIP) to a primary IP (merge duplicate hostnames)
// Cascades across: Server Inventory, IPAM (status=vip), Server List (CMDB table & meta), and Prometheus Targets
const { linkVip, unlinkVip } = require('../lib/vipLinkageHelper');

router.post('/link', requireWriter, async (req, res) => {
    try {
        const { primaryIp, secondaryIp } = req.body;
        if (!primaryIp || !secondaryIp) {
            return res.status(400).json({ error: 'Missing primaryIp or secondaryIp' });
        }
        if (!isIpv4(String(primaryIp).trim()) || !isIpv4(String(secondaryIp).trim())) {
            return res.status(400).json({ error: 'primaryIp and secondaryIp must be valid IPv4 addresses' });
        }
        const result = await linkVip(primaryIp, secondaryIp, req.user?.username || 'SYSTEM');
        res.json(result);
    } catch (e) {
        console.error('[Inventory Link Error]', e);
        res.status(failStatus(e)).json({ error: e.message });
    }
});

// POST /unlink
// Unlink a previously linked VIP / secondary IP
router.post('/unlink', requireWriter, async (req, res) => {
    try {
        const { ip } = req.body;
        if (!ip) return res.status(400).json({ error: 'Missing ip' });
        if (!isIpv4(String(ip).trim())) return res.status(400).json({ error: 'ip must be a valid IPv4 address' });
        const result = await unlinkVip(ip, req.user?.username || 'SYSTEM');
        res.json(result);
    } catch (e) {
        console.error('[Inventory Unlink Error]', e);
        res.status(failStatus(e)).json({ error: e.message });
    }
});

// SSH host key pins (trust on first use). SuperAdmin only.
router.get('/ssh-hostkeys', requireSuperAdmin, (req, res) => {
    res.json(listHostKeys());
});

router.delete('/ssh-hostkeys/:ip', requireSuperAdmin, (req, res) => {
    const ip = req.params.ip;
    if (!isIpv4(ip)) return res.status(400).json({ error: 'Invalid IPv4 address' });
    const removed = forgetHostKey(ip);
    if (!removed) return res.status(404).json({ error: 'No pinned host key for this IP' });
    auditLog(req.user.username, 'Inventory', `Forgot pinned SSH host key for ${ip}`);
    res.json({ success: true });
});

// --- Scan history (reads: feature inventory) ---
const histLimit = (v, d, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(1, n)) : d; };

// Paged scans, newest first: ?limit (1-200, default 25) &before=<scan id>. The first page also carries the read-only
// entries of the old status_changes.json (legacyStatusChanges) so history from before 1.7.5 stays visible.
router.get('/history', (req, res) => {
    try {
        const page = inventoryHistory.listScans({ limit: req.query.limit, before: req.query.before });
        const body = { scans: page.scans, nextBefore: page.nextBefore };
        if (req.query.before === undefined) body.legacyStatusChanges = inventoryHistory.readLegacyStatusChanges(200);
        res.json(body);
    } catch (e) {
        res.status(failStatus(e)).json({ error: e.message });
    }
});

router.get('/history/:scanId/changes', (req, res) => {
    try {
        const scanId = parseInt(req.params.scanId, 10);
        if (!Number.isInteger(scanId) || scanId < 1) return res.status(400).json({ error: 'Invalid scan id' });
        const scan = inventoryHistory.getScan(scanId);
        if (!scan) return res.status(404).json({ error: 'Scan not found (it may have been removed by the retention cleanup)' });
        const { total, changes } = inventoryHistory.listScanChanges(scanId, { limit: histLimit(req.query.limit, 100, 1000), offset: req.query.offset });
        res.json({ scan, total, changes });
    } catch (e) {
        res.status(failStatus(e)).json({ error: e.message });
    }
});

router.get('/hosts/:ip/changes', (req, res) => {
    try {
        const ip = req.params.ip;
        if (!isIpv4(ip)) return res.status(400).json({ error: 'Invalid IPv4 address' });
        const { total, changes } = inventoryHistory.listHostChanges(ip, { limit: histLimit(req.query.limit, 100, 1000), offset: req.query.offset });
        res.json({ ip, total, changes });
    } catch (e) {
        res.status(failStatus(e)).json({ error: e.message });
    }
});

// --- Credential profiles (SuperAdmin only; passwords are never returned) ---
router.get('/credential-profiles', requireSuperAdmin, (req, res) => {
    try {
        res.json({ profiles: inventoryCredentials.listProfiles() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.put('/credential-profiles/:name', requireSuperAdmin, async (req, res) => {
    try {
        const name = req.params.name;
        if (!inventoryCredentials.isValidProfileName(name)) return res.status(400).json({ error: 'Profile name may contain letters, digits, space, _ . - (1-64 characters)' });
        const result = await inventoryCredentials.runExclusive(async () => inventoryCredentials.putProfile(name, req.body, req.user.username));
        if (result.errors) return res.status(400).json({ error: result.errors.join('; '), errors: result.errors });
        // Audit: which fields changed, never any value
        auditLog(req.user.username, 'Inventory', `${result.created ? 'Created' : 'Updated'} credential profile "${name}"${result.changed.length ? ` (changed: ${result.changed.join(', ')})` : ''}`);
        res.json({ success: true, created: result.created, profile: result.profile });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/credential-profiles/:name', requireSuperAdmin, async (req, res) => {
    try {
        const name = req.params.name;
        if (!inventoryCredentials.isValidProfileName(name)) return res.status(400).json({ error: 'Invalid profile name' });
        await inventoryCredentials.runExclusive(async () => {
            if (!inventoryCredentials.hasProfile(name)) return res.status(404).json({ error: 'Credential profile not found' });
            const used = inventoryCredentials.subnetsUsingProfile(await readStoredConfig(), name);
            if (used.length) return res.status(409).json({ error: `Profile "${name}" is used by ${used.length} subnet(s): ${used.slice(0, 10).join(', ')}`, code: 'PROFILE_IN_USE', subnets: used });
            inventoryCredentials.deleteProfile(name);
            auditLog(req.user.username, 'Inventory', `Deleted credential profile "${name}"`);
            res.json({ success: true });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- CSV export (Operator+): ?format=csv&status&subnet&q&os. Streamed page by page, UTF-8 BOM, every field quoted ---
const EXPORT_COLUMNS = ['ip', 'hostname', 'status', 'os', 'osVersion', 'cpu', 'memoryGB', 'timezone', 'subnet', 'tags', 'firstSeen', 'lastSeen', 'offlineSince', 'specsError'];
const EXPORT_PAGE = 1000;

function exportRow(h) {
    const ip = h.ip || '';
    return [
        ip, h.hostname, h.status || 'offline', h.osname || h.os, h.osVersion, h.cpu, h.mem !== undefined ? h.mem : h.memoryGB, h.timezone,
        ip.split('.').slice(0, 3).join('.'), Array.isArray(h.tags) ? h.tags.join(', ') : '', h.firstSeen, h.lastSeen, h.offlineSince, h.error
    ];
}

// Same predicates as the Server Inventory table: text = hostname / ip / tags; os win|linux|unknown = exact OS category
// of a host that is not offline; status offline = offline hosts only.
function exportMatcher({ q, os, status }) {
    const needle = q.toLowerCase();
    return (h) => {
        if (q) {
            const hit = (h.hostname || '').toLowerCase().includes(needle) || (h.ip || '').includes(q)
                || (Array.isArray(h.tags) ? h.tags : []).some(t => String(t).toLowerCase().includes(needle));
            if (!hit) return false;
        }
        const offline = h.status === 'offline';
        if (os === 'win' || os === 'linux') { if (h.os !== os || offline) return false; }
        else if (os === 'unknown') { if (h.os === 'win' || h.os === 'linux' || offline) return false; }
        if (status === 'offline' && !offline) return false;
        if (status === 'online' && h.status !== 'online') return false;
        return true;
    };
}

router.get('/export', requireWriter, async (req, res) => {
    try {
        const format = String(req.query.format || 'csv').toLowerCase();
        if (format !== 'csv') return res.status(400).json({ error: 'Unsupported format (only csv)' });
        const str = (v) => (typeof v === 'string' ? v.trim() : '');
        const f = { status: str(req.query.status), q: str(req.query.q), os: str(req.query.os).toLowerCase() };
        if (f.status && !['online', 'offline'].includes(f.status)) return res.status(400).json({ error: 'status must be online or offline' });
        if (f.os && !['win', 'linux', 'unknown'].includes(f.os)) return res.status(400).json({ error: 'os must be win, linux or unknown' });
        const subnet = str(req.query.subnet);
        const listFilters = {};
        if (subnet) {
            const parsed = parseSubnetEntry(subnet);
            if (parsed.error) return res.status(400).json({ error: `Invalid subnet: ${parsed.error}` });
            listFilters.subnet = parsed.prefix;
        }
        const matches = exportMatcher(f);
        const store = require('../services/inventoryStore');
        store.ensureMigrated();
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="server-inventory-${stamp}.csv"`);
        res.setHeader('Cache-Control', 'no-store');
        let closed = false;
        res.on('close', () => { closed = true; });
        // Backpressure: waits for drain, but a client that disconnects meanwhile ends the wait
        const write = (chunk) => (res.write(chunk) || closed ? Promise.resolve() : new Promise(r => { const done = () => { res.off('drain', done); res.off('close', done); r(); }; res.once('drain', done); res.once('close', done); }));
        await write(BOM + csvRow(EXPORT_COLUMNS));
        let offset = 0; let rows = 0;
        while (!closed) {
            const { hosts } = store.listHosts({ ...listFilters, limit: EXPORT_PAGE, offset });
            if (!hosts.length) break;
            const picked = hosts.filter(matches);
            if (picked.length) { rows += picked.length; await write(picked.map(h => csvRow(exportRow(h))).join('')); }
            if (hosts.length < EXPORT_PAGE) break;
            offset += EXPORT_PAGE;
        }
        const filterText = Object.entries({ ...f, subnet }).filter(([, v]) => v).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(', ') || 'none';
        auditLog(req.user.username, 'Inventory', `Exported server inventory CSV (${rows} rows${closed ? ', client disconnected' : ''}; filters: ${filterText})`);
        if (!closed) res.end();
    } catch (e) {
        if (!res.headersSent) res.status(failStatus(e)).json({ error: e.message });
        else res.end();
    }
});

router.getLatestWinAgent = getLatestWinAgent;
router.getLatestLinuxAgent = getLatestLinuxAgent;

module.exports = router;

