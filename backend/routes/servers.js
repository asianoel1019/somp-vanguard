const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { readDB } = require('../lib/db');
// every dns_data.json change is an atomic read-modify-write of the CURRENT document (lib/dnsDataStore.js)
const { mutateDnsDb } = require('../lib/dnsDataStore');
const { runPowerShell, getADCredentialHeader, getCimSessionHeader, getCimSessionCleanup } = require('../lib/powershell');
const { auditLog } = require('../lib/logger');

router.use(requireAuth);
router.use(checkFeature('dnsHub'));

const statusCache = {}; // Cache server alive checks in memory (Key: serverId, Value: { status, timestamp })

// GET /api/servers
router.get('/', async (req, res) => {
    const db = await readDB();
    res.json(db.servers);
});

// GET /api/servers/:id/status
router.get('/:id/status', async (req, res) => {
    const db = await readDB();
    const server = db.servers.find(s => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    if (server.disabled) {
        return res.json({ status: 'disabled' });
    }

    const force = req.query.force === 'true';
    const cached = statusCache[req.params.id];
    const TEN_MINUTES = 10 * 60 * 1000;

    if (!force && cached && (Date.now() - cached.timestamp < TEN_MINUTES)) {
        return res.json({ status: cached.status });
    }

    try {
        const result = await runPowerShell(`(Test-NetConnection -ComputerName "${server.hostname}" -Port 53 -InformationLevel Quiet)`);
        const status = result.trim() === 'True' ? 'online' : 'offline';
        statusCache[req.params.id] = { status, timestamp: Date.now() };
        res.json({ status });
    } catch (e) {
        statusCache[req.params.id] = { status: 'offline', timestamp: Date.now() };
        res.json({ status: 'offline' });
    }
});

// POST /api/servers/:id/toggle
router.post('/:id/toggle', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const server = mutateDnsDb((db) => {
        const srv = db.servers.find(s => s.id === req.params.id);
        if (!srv) return null;
        srv.disabled = !srv.disabled;
        return { ...srv };
    }, { reason: 'server toggle' });
    if (!server) return res.status(404).json({ error: 'Server not found' });

    // Clear alive check cache so it checks immediately on next call
    delete statusCache[req.params.id];

    auditLog(req.user.username, 'DNS Hub', `${server.disabled ? 'Disabled' : 'Enabled'} DNS Server: ${server.name} (${server.hostname})`);
    res.json(server);
});

// POST /api/servers
router.post('/', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { name, hostname } = req.body;
    if (!name || !hostname) return res.status(400).json({ error: 'Name and hostname required' });

    const newServer = {
        id: Date.now().toString(),
        name,
        hostname,
        status: 'unknown',
        cachedDomains: [],
        lastCacheUpdate: null
    };
    mutateDnsDb((db) => { db.servers.push(newServer); }, { reason: 'server add' });

    auditLog(req.user.username, 'DNS Hub', `Added DNS Server: ${name} (${hostname})`);
    res.json(newServer);
});

// PUT /api/servers/:id
router.put('/:id', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { name, hostname } = req.body;
    const upd = mutateDnsDb((db) => {
        const srv = db.servers.find(s => s.id === req.params.id);
        if (!srv) return null;
        const old = { name: srv.name, hostname: srv.hostname };
        if (name) srv.name = name;
        if (hostname) srv.hostname = hostname;
        return { old, server: { ...srv } };
    }, { reason: 'server update' });
    if (!upd) return res.status(404).json({ error: 'Server not found' });
    const server = upd.server;
    const oldName = upd.old.name;
    const oldHost = upd.old.hostname;
    auditLog(req.user.username, 'DNS Hub', `Updated DNS Server: ${oldName} -> ${server.name} (${oldHost} -> ${server.hostname})`);
    res.json(server);
});

// DELETE /api/servers/:id
router.delete('/:id', checkRole(['SuperAdmin']), async (req, res) => {
    const serverName = mutateDnsDb((db) => {
        const srv = db.servers.find(s => s.id === req.params.id);
        for (let i = db.servers.length - 1; i >= 0; i--) if (db.servers[i].id === req.params.id) db.servers.splice(i, 1);
        return srv ? srv.name : req.params.id;
    }, { reason: 'server delete' });
    delete statusCache[req.params.id];

    auditLog(req.user.username, 'DNS Hub', `Deleted DNS Server: ${serverName}`);
    res.json({ success: true });
});

// POST /api/servers/:id/restart
router.post('/:id/restart', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const db = await readDB();
    const server = db.servers.find(s => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    try {
        let username = process.env.AD_ADMIN_USER || req.user.username;
        const password = process.env.AD_ADMIN_PWD || req.user.password;
        let domain = req.user.domain;

        if (process.env.AD_ADMIN_USER && username.includes('\\')) {
            const parts = username.split('\\');
            domain = parts[0];
            username = parts[1];
        } else if (process.env.AD_ADMIN_USER && !username.includes('\\')) {
            domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim() || domain;
        }

        const credHdr = getADCredentialHeader(username, domain, password);
        const credArg = (password) ? '-Credential $global:AD_CRED' : '';
        await runPowerShell(`
            $ErrorActionPreference = "Stop";
            ${credHdr}
            Invoke-WmiMethod -Class Win32_Service -Name StopService -Filter "Name='dns'" -ComputerName "${server.hostname}" ${credArg} | Out-Null
            Invoke-WmiMethod -Class Win32_Service -Name StartService -Filter "Name='dns'" -ComputerName "${server.hostname}" ${credArg} | Out-Null
        `);

        auditLog(req.user.username, 'DNS Hub', `Restarted DNS Service on: ${server.name} (${server.hostname})`);
        res.json({ success: true });
    } catch (error) {
        console.error('Restart error:', error);
        res.status(500).json({ error: 'Failed to restart DNS service. Please contact administrator.' });
    }
});

// POST /api/servers/:id/cache-update
router.post('/:id/cache-update', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const db = await readDB();
    const server = db.servers.find(s => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    try {
        let username = req.user.username;
        let password = req.user.password;
        let domain = req.user.domain || '';

        // Fallback to configured AD Admin credentials if user session has no plaintext password
        if (!password && process.env.AD_ADMIN_USER) {
            username = process.env.AD_ADMIN_USER;
            password = process.env.AD_ADMIN_PWD || password;
        }

        if (username.includes('\\')) {
            const parts = username.split('\\');
            domain = parts[0];
            username = parts[1];
        } else if (!domain || domain === 'local') {
            domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim();
        }

        let cleanHost = server.ip || server.hostname || '';
        if (cleanHost.includes('(')) {
            cleanHost = cleanHost.split('(')[0].trim();
        }

        const credHdr = getADCredentialHeader(username, domain, password || process.env.AD_ADMIN_PWD);
        const sessHdr = getCimSessionHeader(cleanHost);
        const cleanup = getCimSessionCleanup();
        const result = await runPowerShell(`
            $ErrorActionPreference = "SilentlyContinue";
            ${credHdr}
            ${sessHdr}
            $dcTarget = "${cleanHost}";
            try {
                $rawZones = $null;
                if ($global:CIM_SESS) {
                    $rawZones = Get-DnsServerZone -CimSession $global:CIM_SESS -ErrorAction SilentlyContinue
                }
                if (-not $rawZones -and $dcTarget) {
                    $rawZones = Get-DnsServerZone -ComputerName $dcTarget -ErrorAction SilentlyContinue
                }
                if (-not $rawZones) {
                    $rawZones = Get-DnsServerZone -ErrorAction SilentlyContinue
                }
                if (-not $rawZones -and $dcTarget) {
                    if ($global:AD_CRED) {
                        $rawZones = Get-WmiObject -Namespace "root\\MicrosoftDNS" -Class "MicrosoftDNS_Zone" -ComputerName $dcTarget -Credential $global:AD_CRED -ErrorAction SilentlyContinue
                    } else {
                        $rawZones = Get-WmiObject -Namespace "root\\MicrosoftDNS" -Class "MicrosoftDNS_Zone" -ComputerName $dcTarget -ErrorAction SilentlyContinue
                    }
                }
                if (-not $rawZones) {
                    try {
                        $adSrv = if ($dcTarget) { $dcTarget } else { $env:LOGONSERVER -replace '^\\\\','' }
                        $rootDSE = if ($global:AD_CRED) { Get-ADRootDSE -Server $adSrv -Credential $global:AD_CRED -ErrorAction SilentlyContinue } else { Get-ADRootDSE -Server $adSrv -ErrorAction SilentlyContinue }
                        $adZoneList = @()
                        if ($rootDSE) {
                            $domDN = $rootDSE.defaultNamingContext
                            $sBases = @(
                                "CN=MicrosoftDNS,DC=DomainDnsZones,$domDN",
                                "CN=MicrosoftDNS,DC=ForestDnsZones,$domDN",
                                "CN=MicrosoftDNS,CN=System,$domDN"
                            )
                            foreach ($sb in $sBases) {
                                $f = if ($global:AD_CRED) { Get-ADObject -Filter "objectClass -eq 'dnsZone'" -SearchBase $sb -Server $adSrv -Credential $global:AD_CRED -ErrorAction SilentlyContinue } else { Get-ADObject -Filter "objectClass -eq 'dnsZone'" -SearchBase $sb -Server $adSrv -ErrorAction SilentlyContinue }
                                if ($f) { $adZoneList += $f }
                            }
                        }
                        if (-not $adZoneList) {
                            $adZoneList = if ($global:AD_CRED) { Get-ADObject -Filter "objectClass -eq 'dnsZone'" -Server $adSrv -Credential $global:AD_CRED -ErrorAction SilentlyContinue } else { Get-ADObject -Filter "objectClass -eq 'dnsZone'" -Server $adSrv -ErrorAction SilentlyContinue }
                        }
                        if ($adZoneList) {
                            $rawZones = $adZoneList | Select-Object @{N="ZoneName";E={$_.Name}}, @{N="ZoneType";E={"Primary"}}, @{N="IsAutoCreated";E={$false}}
                        }
                    } catch {}
                }

                $zonesList = @()
                if ($rawZones) {
                    foreach ($z in $rawZones) {
                        $zn = if ($z.ZoneName) { $z.ZoneName } else { $z.Name }
                        if ($zn -and $zn -ne 'TrustAnchors' -and $zn -notlike '*in-addr.arpa' -and $zn -notlike '*ip6.arpa') {
                            $zonesList += $zn
                        }
                    }
                }
                if ($zonesList) {
                    $zonesList | ConvertTo-Json -Compress
                } else {
                    Write-Output "[]"
                }
            } finally {
                ${cleanup}
            }
        `);

        console.log(`[Cache Update] User: ${username}@${domain}, Server: ${server.name} (${cleanHost}) => Result: ${result.trim()}`);

        let zones = [];
        if (result.trim()) {
            try {
                const parsed = JSON.parse(result);
                if (Array.isArray(parsed)) {
                    zones = parsed.map(z => typeof z === 'string' ? z : (z.ZoneName || z.Name || z));
                } else if (typeof parsed === 'string') {
                    zones = [parsed];
                } else if (parsed) {
                    const zName = parsed.ZoneName || parsed.Name;
                    if (zName) zones = [zName];
                }
            } catch (e) {}
        }
        server.cachedDomains = zones;
        server.lastCacheUpdate = Date.now();
        server.lastError = null;
        // merge only this server's cache fields into the CURRENT document (the query above took seconds)
        mutateDnsDb((cur) => {
            const srv = cur.servers.find(s => s.id === server.id);
            if (srv) { srv.cachedDomains = zones; srv.lastCacheUpdate = server.lastCacheUpdate; srv.lastError = null; }
        }, { reason: 'zone cache update' });

        auditLog(req.user.username, 'DNS Hub', `Updated Zone Cache for: ${server.name}`);
        res.json({ success: true, domains: zones });
    } catch (error) {
        console.error('Cache update error:', error);
        server.lastError = 'Failed to update domain cache';
        mutateDnsDb((cur) => {
            const srv = cur.servers.find(s => s.id === server.id);
            if (srv) srv.lastError = server.lastError;
        }, { reason: 'zone cache update error' });
        res.status(500).json({ error: 'Failed to update domain cache from server. Please contact administrator.' });
    }
});

// POST /api/servers/:id/sync-ad
router.post('/:id/sync-ad', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const db = await readDB();
    const server = db.servers.find(s => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    try {
        let username = process.env.AD_ADMIN_USER || req.user.username;
        const password = process.env.AD_ADMIN_PWD || req.user.password;
        let domain = req.user.domain;

        if (process.env.AD_ADMIN_USER && username.includes('\\')) {
            const parts = username.split('\\');
            domain = parts[0];
            username = parts[1];
        } else if (process.env.AD_ADMIN_USER && !username.includes('\\')) {
            domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim() || domain;
        }

        const credHdr = getADCredentialHeader(username, domain, password);
        const sessHdr = getCimSessionHeader(server.hostname);
        const cleanup = getCimSessionCleanup();
        const result = await runPowerShell(`
            $ErrorActionPreference = "Stop";
            ${credHdr}
            ${sessHdr}
            try {
                if (-not $global:CIM_SESS) {
                    Write-Output "CIM Session connection failed (host unreachable)"
                    return
                }
                Invoke-Command -CimSession $global:CIM_SESS -ScriptBlock {
                    repadmin.exe /syncall /AdP | Out-String
                }
            } finally {
                ${cleanup}
            }
        `);

        auditLog(req.user.username, 'DNS Hub', `Executed AD Sync on: ${server.name}`);
        res.json({ success: true, log: result });
    } catch (error) {
        console.error('AD Sync error:', error);
        res.status(500).json({ error: 'Failed to sync AD. Please contact administrator.' });
    }
});

module.exports = router;
