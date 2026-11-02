const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requireAuth, checkFeature, checkRole } = require('../middleware/auth');
const { readDB, readDataSync } = require('../lib/db');
const dnsDataStore = require('../lib/dnsDataStore');
const { runPowerShell, getADCredentialHeader, getCimSessionHeader, getCimSessionCleanup, sanitizePsString } = require('../lib/powershell');
const { auditLog, batchAuditLog } = require('../lib/logger');
const { encryptText, decryptText } = require('../lib/crypto');

/**
 * Resolve AD_ADMIN_PWD — handles enc: prefix transparently.
 */
function resolveAdminPassword(raw) {
    if (!raw) return '';
    if (raw.startsWith('enc:')) {
        try { return decryptText(raw.substring(4)); } catch (e) { return ''; }
    }
    return raw;
}

/**
 * Generates a PowerShell script block that fetches DNS records for all supplied zones
 * from a remote DNS server.  Priority order:
 *   Tier 0 — Invoke-Command (WinRM): runs Get-DnsServerResourceRecord LOCALLY on the DNS
 *             server, so RSAT is NOT needed on the app server.
 *   Tier 1 — Get-DnsServerResourceRecord -ComputerName (RSAT/RPC, if installed locally)
 *   Tier 2 — WMI root\MicrosoftDNS (legacy, no RSAT needed, uses AD cred)
 *   Tier 3 — dnscmd /enumrecords (RPC, needs DNS admin group membership)
 * Returns a ConvertTo-Json block: { records: [...], diagErrors: [...] }
 */
function buildDnsQueryPs(cleanHost, zonesJson, credHdr, sessHdr, cleanup) {
    return `
$ErrorActionPreference = 'Continue'
${credHdr}
${sessHdr}
$diagErrors = @()
$results    = @()

$recordSelect = {
    param($zone, $raw)
    $type = $raw.RecordType
    $data = $null
    try {
        if ($type -eq 'A')     { $data = $raw.RecordData.IPv4Address.IPAddressToString }
        elseif ($type -eq 'AAAA')  { $data = $raw.RecordData.IPv6Address.IPAddressToString }
        elseif ($type -eq 'CNAME') { $data = $raw.RecordData.HostNameAlias }
        elseif ($type -eq 'PTR')   { $data = $raw.RecordData.PtrDomainName }
        elseif ($type -eq 'MX')    { $data = $raw.RecordData.MailExchange }
        elseif ($type -eq 'TXT')   { $data = $raw.RecordData.DescriptiveText }
        elseif ($type -eq 'NS')    { $data = $raw.RecordData.NameServer }
        else                        { $data = $raw.RecordData.ToString() }
    } catch { $data = '' }
    [PSCustomObject]@{ ZoneName=$zone; HostName=$raw.HostName; RecordType=$type; TTL=$raw.TimeToLive.TotalSeconds; Data=$data }
}

try {
    $zones = '${zonesJson}' | ConvertFrom-Json
    foreach ($zone in $zones) {
        $recs = $null

        # ---- Tier 0: Invoke-Command (WinRM) — runs locally on DNS server (most reliable) ----
        if (-not $recs -and $global:AD_CRED) {
            try {
                $sb = {
                    param($z)
                    Get-DnsServerResourceRecord -ZoneName $z -ErrorAction Stop |
                        Select-Object HostName, RecordType,
                            @{N='TTL';  E={$_.TimeToLive.TotalSeconds}},
                            @{N='Data'; E={
                                $t = $_.RecordType
                                if ($t -eq 'A')     { $_.RecordData.IPv4Address.IPAddressToString }
                                elseif ($t -eq 'AAAA')  { $_.RecordData.IPv6Address.IPAddressToString }
                                elseif ($t -eq 'CNAME') { $_.RecordData.HostNameAlias }
                                elseif ($t -eq 'PTR')   { $_.RecordData.PtrDomainName }
                                elseif ($t -eq 'MX')    { $_.RecordData.MailExchange }
                                elseif ($t -eq 'TXT')   { $_.RecordData.DescriptiveText }
                                elseif ($t -eq 'NS')    { $_.RecordData.NameServer }
                                else                     { $_.RecordData.ToString() }
                            }}
                }
                $raw = Invoke-Command -ComputerName '${cleanHost}' -Credential $global:AD_CRED -ScriptBlock $sb -ArgumentList $zone -ErrorAction Stop
                if ($raw) {
                    $recs = $raw | ForEach-Object { [PSCustomObject]@{ ZoneName=$zone; HostName=$_.HostName; RecordType=$_.RecordType; TTL=$_.TTL; Data=$_.Data } }
                }
            } catch {
                $diagErrors += ('Invoke-Command on ' + $zone + ': ' + $_.Exception.Message)
            }
        }

        # ---- Tier 1: Get-DnsServerResourceRecord -ComputerName (RSAT local) ----
        $hasDnsCmdlet = [bool](Get-Command Get-DnsServerResourceRecord -ErrorAction SilentlyContinue)
        if (-not $recs -and $hasDnsCmdlet) {
            try {
                $raw = Get-DnsServerResourceRecord -ZoneName $zone -ComputerName '${cleanHost}' -ErrorAction Stop
                if ($raw) { $recs = $raw | ForEach-Object { & $recordSelect $zone $_ } }
            } catch {
                $diagErrors += ('RSAT RPC on ' + $zone + ': ' + $_.Exception.Message)
            }
        }

        # ---- Tier 2: WMI root\MicrosoftDNS ----
        if (-not $recs) {
            try {
                $wmiArgs = @{ Namespace='root\MicrosoftDNS'; Class='MicrosoftDNS_ResourceRecord'; ComputerName='${cleanHost}'; Filter="ContainerName='$zone'"; ErrorAction='Stop' }
                if ($global:AD_CRED) { $wmiArgs['Credential'] = $global:AD_CRED }
                $wmiRaw = Get-WmiObject @wmiArgs
                if ($wmiRaw) {
                    $recs = $wmiRaw | ForEach-Object {
                        $cls   = $_.GetType().Name -replace '^MicrosoftDNS_','' -replace 'Type$',''
                        $owner = if ($_.OwnerName) { $_.OwnerName.TrimEnd('.') } else { '' }
                        $cz    = $zone.TrimEnd('.')
                        $hn    = if ($owner -eq $cz -or -not $owner) { '@' } elseif ($owner.EndsWith('.' + $cz)) { $owner.Substring(0,$owner.Length - $cz.Length - 1) } else { $owner }
                        $dv    = $_.RecordData
                        if (-not $dv) { if ($_.IPAddress) { $dv=$_.IPAddress } elseif ($_.HostNameAlias) { $dv=$_.HostNameAlias } elseif ($_.PtrDomainName) { $dv=$_.PtrDomainName } elseif ($_.TextRepresentation) { $dv=($_.TextRepresentation.Trim() -split '\s+')[-1] } }
                        [PSCustomObject]@{ ZoneName=$zone; HostName=$hn; RecordType=$cls; TTL=if($_.TTL){$_.TTL}else{3600}; Data=$dv }
                    }
                }
            } catch {
                $diagErrors += ('WMI on ' + $zone + ': ' + $_.Exception.Message)
            }
        }

        # ---- Tier 3: dnscmd /enumrecords (RPC, needs DNS admin) ----
        if (-not $recs) {
            try {
                $dnscmdResult = Get-Command dnscmd.exe -ErrorAction SilentlyContinue
                $dnscmdPath = if ($dnscmdResult) { $dnscmdResult.Source } else { $null }
                if (-not $dnscmdPath) { $dnscmdPath = Join-Path $env:SystemRoot 'System32\\dnscmd.exe' }

                if (Test-Path $dnscmdPath) {
                    $out = & $dnscmdPath '${cleanHost}' /enumrecords $zone '@' /type any /additional 2>&1 | Out-String
                    $parsed = @()
                    $out -split '[\r\n]+' | Where-Object { $_ -match '^\s+(\S+)\s+(\d+)\s+\w+\s+(\w+)\s+(.+)$' } | ForEach-Object {
                        $m = [regex]::Match($_, '^\s+(\S+)\s+(\d+)\s+\w+\s+(\w+)\s+(.+)$')
                        if ($m.Success) {
                            $parsed += [PSCustomObject]@{ ZoneName=$zone; HostName=$m.Groups[1].Value; RecordType=$m.Groups[3].Value; TTL=[int]$m.Groups[2].Value; Data=$m.Groups[4].Value.Trim() }
                        }
                    }
                    if ($parsed.Count -gt 0) { $recs = $parsed } else { $diagErrors += ('dnscmd enumrecords empty on ' + $zone) }
                } else {
                    $diagErrors += 'dnscmd.exe not found'
                }
            } catch {
                $diagErrors += ('dnscmd on ' + $zone + ': ' + $_.Exception.Message)
            }
        }

        if ($recs) { $results += $recs }
    }
} finally {
    ${cleanup}
}

[PSCustomObject]@{ records=$results; diagErrors=$diagErrors } | ConvertTo-Json -Depth 5 -Compress
`;
}

function appendDnsChangeLog(user, actions) {
    try {
        const timestamp = new Date().toLocaleString('sv-SE', { timeZone: process.env.TZ || 'Asia/Taipei' });
        const newLogs = actions.map(action => ({
            timestamp,
            user,
            action
        }));
        // one row per change in table dns_changes (listed in this order, before the older ones)
        dnsDataStore.appendDnsChanges(newLogs);
    } catch (e) {
        console.error('[DNS] Failed to write the DNS change log', e);
    }
}

router.use(requireAuth);
router.use(checkFeature('dnsHub'));

// Universal DNS Record Line Parser
// Supports: Tabs, single/multiple spaces, hyphens (-), slashes (/), commas (,), colons (:), pipes (|), equals (=), arrows (->), and /etc/hosts format
function parseDnsRecordLine(rawLine) {
    if (!rawLine || typeof rawLine !== 'string' || !rawLine.trim()) return null;
    const line = rawLine.trim();

    // Match IPv4 address
    const ipRegex = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/;
    const ipMatch = line.match(ipRegex);

    if (ipMatch) {
        const ip = ipMatch[0];
        // Remove the IP from the line and strip surrounding delimiters
        let remaining = line.replace(ip, '').trim();
        remaining = remaining.replace(/^[\s\t\/,;:|=><]+|[\s\t\/,;:|=><]+$/g, '').trim();
        remaining = remaining.replace(/^-\s*|\s*-$/g, '').trim();
        if (remaining) {
            return { fqdn: remaining, ip };
        }
    }

    // Delimiter fallback: tabs, multiple spaces, or delimiters surrounded by whitespace
    const delimiterRegex = /[\t,;|/=]+|\s+[-/|:=,>]+\s*|\s+/;
    const parts = line.split(delimiterRegex).filter(p => p.trim().length > 0);
    if (parts.length >= 2 && (ipRegex.test(parts[0]) || ipRegex.test(parts[1]))) {
        let fqdn = parts[0].trim();
        let ip = parts[1].trim();
        if (ipRegex.test(fqdn) && !ipRegex.test(ip)) {
            const temp = fqdn;
            fqdn = ip;
            ip = temp;
        }
        return { fqdn, ip };
    }

    return { fqdn: line.replace(/^[\s\t\/,;:|=><]+|[\s\t\/,;:|=><]+$/g, '').replace(/^-\s*|\s*-$/g, '').trim(), ip: null };
}

function parseFqdn(fqdn, cachedDomains) {
    if (!cachedDomains || cachedDomains.length === 0) return null;
    const lowerFqdn = fqdn.toLowerCase();
    let longestMatch = '';
    for (const domain of cachedDomains) {
        const lowerDomain = domain.toLowerCase();
        // Domain must match exactly or as a sub-domain with a '.' boundary
        if ((lowerFqdn === lowerDomain || lowerFqdn.endsWith('.' + lowerDomain)) && domain.length > longestMatch.length) {
            longestMatch = domain;
        }
    }
    if (!longestMatch) return null;
    let host = fqdn.substring(0, fqdn.length - longestMatch.length);
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (!host) host = '@'; 
    return { host, zone: longestMatch };
}

function findTargetServer(fqdn, servers) {
    let bestServer = null;
    let longestMatchLen = -1;
    let parsedData = null;

    for (const server of servers) {
        if (server.disabled) continue;
        if (!server.cachedDomains) continue;
        const parsed = parseFqdn(fqdn, server.cachedDomains);
        if (parsed && parsed.zone.length > longestMatchLen) {
            longestMatchLen = parsed.zone.length;
            bestServer = server;
            parsedData = parsed;
        }
    }
    return { server: bestServer, parsed: parsedData };
}

router.post('/query', async (req, res) => {
    const { queries } = req.body;
    const db = await readDB();
    const servers = db.servers;
    
    // Group queries by server to minimize CimSessions
    const groups = new Map();
    const results = [];
    const unmatched = [];

    for (const rawQuery of queries) {
        const parsedLine = parseDnsRecordLine(String(rawQuery));
        const query = parsedLine && parsedLine.fqdn ? parsedLine.fqdn : String(rawQuery).trim();
        const { server, parsed } = findTargetServer(query, servers);
        if (!server) {
            unmatched.push({ record: query, ip: 'N/A', lastUpdate: 'N/A (Zone not found)', serverName: 'None Output' });
            continue;
        }
        if (!groups.has(server.id)) {
            groups.set(server.id, { server, items: [] });
        }
        groups.get(server.id).items.push({ query, parsed });
    }

    // Process each server group in one PS call
    for (const [serverId, group] of groups) {
        const { server, items } = group;
        try {
            // Prioritize login user's credentials for performance
            let username = req.user.username;
            const password = req.user.password;
            let domain = req.user.domain;

            // Only fallback to AD_ADMIN_USER if user session has no password (e.g. local or special auth)
            if (!password && process.env.AD_ADMIN_USER) {
                username = process.env.AD_ADMIN_USER;
                const adminPass = process.env.AD_ADMIN_PWD;
                if (username.includes('\\')) {
                    const parts = username.split('\\');
                    domain = parts[0];
                    username = parts[1];
                } else {
                    domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim() || domain;
                }
            }

            const credHdr = getADCredentialHeader(username, domain, password || process.env.AD_ADMIN_PWD);
            const sessHdr = getCimSessionHeader(server.hostname);
            const cleanup = getCimSessionCleanup();

            // Prepare a batch PS script for this server
            const batchJson = JSON.stringify(items.map(it => ({
                zone: it.parsed.zone,
                host: it.parsed.host,
                fqdn: it.query,
                original: it.query || (it.parsed.host === '@' ? it.parsed.zone : `${it.parsed.host}.${it.parsed.zone}`)
            })));
            const safeBatchJson = sanitizePsString(batchJson);
            const psCmd = `
                $ErrorActionPreference = "Stop";
                ${credHdr}
                ${sessHdr}
                try {
                    $batch = '${safeBatchJson}' | ConvertFrom-Json
                    $batchResults = @()
                    foreach ($item in $batch) {
                        $recs = $null;
                        if ($global:CIM_SESS) {
                            $recs = Get-DnsServerResourceRecord -ZoneName $item.zone -Name $item.host -CimSession $global:CIM_SESS -ErrorAction SilentlyContinue | Select-Object HostName, RecordType, Timestamp, @{Name="IPAddress";Expression={$_.RecordData.IPv4Address.IPAddressToString}}
                        }
                        if (-not $recs) {
                            $recs = Get-DnsServerResourceRecord -ZoneName $item.zone -Name $item.host -ComputerName "${server.hostname}" -ErrorAction SilentlyContinue | Select-Object HostName, RecordType, Timestamp, @{Name="IPAddress";Expression={$_.RecordData.IPv4Address.IPAddressToString}}
                        }
                        if (-not $recs) {
                            $recs = Get-DnsServerResourceRecord -ZoneName $item.zone -Name $item.host -ErrorAction SilentlyContinue | Select-Object HostName, RecordType, Timestamp, @{Name="IPAddress";Expression={$_.RecordData.IPv4Address.IPAddressToString}}
                        }
                        if (-not $recs) {
                            try {
                                $fqdnQuery = if ($item.host -eq '@') { $item.zone } else { "$($item.host).$($item.zone)" }
                                $resolved = Resolve-DnsName -Name $fqdnQuery -Server "${server.hostname}" -ErrorAction SilentlyContinue
                                if ($resolved) {
                                    $recs = $resolved | Where-Object { $_.IPAddress } | Select-Object @{N="HostName";E={$item.host}}, @{N="RecordType";E={$_.Type}}, @{N="Timestamp";E={"DNS (Port 53)"}}, IPAddress
                                }
                            } catch {}
                        }
                        if ($recs) {
                            foreach ($r in $recs) {
                                $batchResults += [PSCustomObject]@{
                                    original = if ($item.original) { $item.original } else { $item.fqdn }
                                    HostName = $r.HostName
                                    RecordType = $r.RecordType
                                    Timestamp = $r.Timestamp
                                    IPAddress = $r.IPAddress
                                }
                            }
                        } else {
                            $batchResults += [PSCustomObject]@{
                                original = if ($item.original) { $item.original } else { $item.fqdn }
                                IPAddress = "N/A"
                                Timestamp = "Not Found"
                            }
                        }
                    }
                    $batchResults | ConvertTo-Json -Compress
                } finally {
                    ${cleanup}
                }
            `;

            const stdout = await runPowerShell(psCmd);
            if (stdout.trim()) {
                let data = JSON.parse(stdout);
                if (!Array.isArray(data)) data = [data];

                data.forEach(row => {
                    let dateStr = 'Static';
                    const tsMatch = row.Timestamp && row.Timestamp.match(/Date\((.*?)\)/);
                    if (tsMatch) {
                        dateStr = new Date(parseInt(tsMatch[1])).toLocaleString();
                    } else if (row.Timestamp === "Not Found") {
                        dateStr = "Not Found";
                    }

                    results.push({
                        record: row.original || row.fqdn || row.HostName || 'N/A',
                        ip: row.IPAddress || 'N/A',
                        lastUpdate: dateStr,
                        serverName: server.name
                    });
                });
            }
        } catch (err) {
            const errMsg = err.stderr || (err.error && err.error.message) || String(err);
            items.forEach(it => {
                results.push({ record: it.query, ip: 'Error', lastUpdate: errMsg, serverName: server.name });
            });
        }
    }

    res.json({ results: [...results, ...unmatched] });
});

router.post('/preview', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { records } = req.body; // array of { fqdn, ip } or strings
    const db = await readDB();
    const servers = db.servers;
    const results = [];

    for (const record of records) {
        let fqdn = '';
        let ip = '';
        if (typeof record === 'object' && record !== null && record.fqdn) {
            fqdn = String(record.fqdn).trim();
            ip = String(record.ip || '').trim();
        } else if (typeof record === 'string') {
            const parsed = parseDnsRecordLine(record);
            if (parsed) {
                fqdn = parsed.fqdn;
                ip = parsed.ip || '';
            }
        }

        if (!fqdn || !ip) {
            results.push({ fqdn: fqdn || String(record), ip, serverName: 'Invalid format', status: 'Error' });
            continue;
        }
        const { server } = findTargetServer(fqdn, servers);
        if (!server) {
            results.push({ fqdn, ip, serverName: 'None (Zone not found)', status: 'Error' });
        } else {
            results.push({ fqdn, ip, serverName: server.name, status: 'Ready' });
        }
    }
    
    res.json({ results });
});

router.post('/add', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { records } = req.body;
    const db = await readDB();
    const servers = db.servers;
    const results = [];
    const actionsPerformed = [];

    // Group items by server
    const groups = new Map();
    for (const line of records) {
        let fqdn = '';
        let ip = '';

        if (typeof line === 'object' && line !== null && line.fqdn && line.ip) {
            fqdn = String(line.fqdn).trim();
            ip = String(line.ip).trim();
        } else {
            const parsed = parseDnsRecordLine(String(line));
            if (parsed && parsed.fqdn && parsed.ip) {
                fqdn = parsed.fqdn;
                ip = parsed.ip;
            }
        }

        if (!fqdn || !ip) {
            results.push({ record: typeof line === 'string' ? line : JSON.stringify(line), status: 'Invalid format (needs Domain & IP)', serverName: 'None' });
            continue;
        }

        const { server, parsed } = findTargetServer(fqdn, servers);
        if (!server) {
            results.push({ record: fqdn, status: 'Failed: Zone not found in any cache', serverName: 'None' });
            continue;
        }
        if (!groups.has(server.id)) {
            groups.set(server.id, { server, items: [] });
        }
        groups.get(server.id).items.push({ fqdn, ip, parsed });
    }

    // Process each server group
    for (const [serverId, group] of groups) {
        const { server, items } = group;
        try {
            // Prioritize login user's credentials for performance
            let username = req.user.username;
            const password = req.user.password;
            let domain = req.user.domain;

            if (!password && process.env.AD_ADMIN_USER) {
                username = process.env.AD_ADMIN_USER;
                if (username.includes('\\')) {
                    const parts = username.split('\\');
                    domain = parts[0];
                    username = parts[1];
                } else {
                    domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim() || domain;
                }
            }

            const credHdr = getADCredentialHeader(username, domain, password || process.env.AD_ADMIN_PWD);
            const sessHdr = getCimSessionHeader(server.hostname);
            const cleanup = getCimSessionCleanup();

            const batchJson = JSON.stringify(items.map(it => ({ zone: it.parsed.zone, host: it.parsed.host, ip: it.ip, fqdn: it.fqdn })));
            const safeBatchJson = sanitizePsString(batchJson);
            const psCmd = `
                $ErrorActionPreference = "Stop";
                ${credHdr}
                ${sessHdr}
                try {
                    $batch = '${safeBatchJson}' | ConvertFrom-Json
                    $batchResults = @()
                    foreach ($item in $batch) {
                        try {
                            $existing = Get-DnsServerResourceRecord -ZoneName $item.zone -Name $item.host -RRType A -CimSession $global:CIM_SESS -ErrorAction SilentlyContinue;
                            if ($existing) {
                                $newObj = $existing.Clone();
                                $newObj.RecordData.IPv4Address = [System.Net.IPAddress]::Parse($item.ip);
                                Set-DnsServerResourceRecord -ZoneName $item.zone -OldInputObject $existing -NewInputObject $newObj -CimSession $global:CIM_SESS;
                            } else {
                                Add-DnsServerResourceRecordA -ZoneName $item.zone -Name $item.host -IPv4Address $item.ip -CimSession $global:CIM_SESS;
                            }
                            $batchResults += [PSCustomObject]@{ fqdn = $item.fqdn; status = "Success" }
                        } catch {
                            $batchResults += [PSCustomObject]@{ fqdn = $item.fqdn; status = "Error: $($_.Exception.Message)" }
                        }
                    }
                    $batchResults | ConvertTo-Json -Compress
                } finally {
                    ${cleanup}
                }
            `;

            const stdout = await runPowerShell(psCmd);
            if (stdout.trim()) {
                let data = JSON.parse(stdout);
                if (!Array.isArray(data)) data = [data];
                data.forEach(r => {
                    results.push({ record: r.fqdn, status: r.status, serverName: server.name });
                    if (r.status === "Success") {
                        const item = items.find(it => it.fqdn === r.fqdn);
                        actionsPerformed.push(`Add/Mod: ${r.fqdn} -> ${item.ip} (Server: ${server.name})`);
                    }
                });
            }
        } catch (err) {
            console.error('[DNS] DNS Add Error:', err.stderr || err.message || String(err));
            items.forEach(it => {
                results.push({ record: it.fqdn, status: `Error: Failed to process DNS record`, serverName: server.name });
            });
        }
    }

    if (actionsPerformed.length > 0) {
        batchAuditLog(req.user.username, 'DNS Hub', actionsPerformed);
        appendDnsChangeLog(req.user.username, actionsPerformed);
    }
    res.json({ results });
});

router.post('/delete', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { records } = req.body;
    const db = await readDB();
    const servers = db.servers;
    const results = [];
    const actionsPerformed = [];

    // Group items by server
    const groups = new Map();
    for (const raw of records) {
        const parsedLine = parseDnsRecordLine(String(raw));
        const fqdn = parsedLine && parsedLine.fqdn ? parsedLine.fqdn : String(raw).trim();
        const { server, parsed } = findTargetServer(fqdn, servers);
        if (!server) {
            results.push({ record: fqdn, status: 'Failed: Zone not found in any cache', serverName: 'None' });
            continue;
        }
        if (!groups.has(server.id)) {
            groups.set(server.id, { server, items: [] });
        }
        groups.get(server.id).items.push({ fqdn, parsed });
    }

    // Process each server group
    for (const [serverId, group] of groups) {
        const { server, items } = group;
        try {
            // Prioritize login user's credentials for performance
            let username = req.user.username;
            const password = req.user.password;
            let domain = req.user.domain;

            if (!password && process.env.AD_ADMIN_USER) {
                username = process.env.AD_ADMIN_USER;
                if (username.includes('\\')) {
                    const parts = username.split('\\');
                    domain = parts[0];
                    username = parts[1];
                } else {
                    domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim() || domain;
                }
            }

            const credHdr = getADCredentialHeader(username, domain, password || process.env.AD_ADMIN_PWD);
            const sessHdr = getCimSessionHeader(server.hostname);
            const cleanup = getCimSessionCleanup();

            const batchJson = JSON.stringify(items.map(it => ({ zone: it.parsed.zone, host: it.parsed.host, fqdn: it.fqdn })));
            const safeBatchJson = sanitizePsString(batchJson);
            const psCmd = `
                $ErrorActionPreference = "Stop";
                ${credHdr}
                ${sessHdr}
                try {
                    $batch = '${safeBatchJson}' | ConvertFrom-Json
                    $batchResults = @()
                    foreach ($item in $batch) {
                        try {
                            Get-DnsServerResourceRecord -ZoneName $item.zone -Name $item.host -CimSession $global:CIM_SESS -ErrorAction Stop | Remove-DnsServerResourceRecord -ZoneName $item.zone -CimSession $global:CIM_SESS -Force -ErrorAction Stop
                            $batchResults += [PSCustomObject]@{ fqdn = $item.fqdn; status = "Deleted" }
                        } catch {
                            $batchResults += [PSCustomObject]@{ fqdn = $item.fqdn; status = "Error: $($_.Exception.Message)" }
                        }
                    }
                    $batchResults | ConvertTo-Json -Compress
                } finally {
                    ${cleanup}
                }
            `;

            const stdout = await runPowerShell(psCmd);
            if (stdout.trim()) {
                let data = JSON.parse(stdout);
                if (!Array.isArray(data)) data = [data];
                data.forEach(r => {
                    results.push({ record: r.fqdn, status: r.status, serverName: server.name });
                    if (r.status === "Deleted") {
                        actionsPerformed.push(`Delete: ${r.fqdn} (Server: ${server.name})`);
                    }
                });
            }
        } catch (err) {
            console.error('[DNS] DNS Delete Error:', err.stderr || err.message || String(err));
            items.forEach(it => {
                results.push({ record: it.fqdn, status: `Error: Failed to process DNS record`, serverName: server.name });
            });
        }
    }

    if (actionsPerformed.length > 0) {
        batchAuditLog(req.user.username, 'DNS Hub', actionsPerformed);
        appendDnsChangeLog(req.user.username, actionsPerformed);
    }
    res.json({ results });
});

router.get('/logs', async (req, res) => {
    try {
        // table dns_changes, newest first, the last 5000 (as the former capped document)
        res.json(dnsDataStore.listDnsChanges());
    } catch (e) {
        res.status(500).json({ error: 'Failed to read logs' });
    }
});

router.get('/export-all', async (req, res) => {
    try {
        const db = await readDB();
        const servers = db.servers;
        let allRecords = [];

        for (const server of servers) {
            if (server.disabled) continue;
            if (!server.cachedDomains || server.cachedDomains.length === 0) continue;

            let username = process.env.AD_ADMIN_USER || req.user.username;
            // FIX: decrypt enc: prefix before passing to PowerShell
            let rawPwd = process.env.AD_ADMIN_PWD || req.user.password || '';
            let password = resolveAdminPassword(rawPwd);
            let domain = req.user.domain;

            if (process.env.AD_ADMIN_USER && username.includes('\\')) {
                const parts = username.split('\\');
                domain = parts[0];
                username = parts[1];
            } else if (process.env.AD_ADMIN_USER && !username.includes('\\')) {
                domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim() || domain;
            }

            let cleanHost = (server.hostname || server.ip || '').trim();
            if (cleanHost.includes('(')) cleanHost = cleanHost.split('(')[0].trim();

            const credHdr = getADCredentialHeader(username, domain, password);
            const sessHdr = getCimSessionHeader(cleanHost);
            const cleanup = getCimSessionCleanup();
            const zonesJson = sanitizePsString(JSON.stringify(server.cachedDomains));
            const psCmd = buildDnsQueryPs(cleanHost, zonesJson, credHdr, sessHdr, cleanup);

            try {
                const stdout = await runPowerShell(psCmd, 120000);
                if (stdout.trim()) {
                    let parsed;
                    try { parsed = JSON.parse(stdout); } catch { parsed = null; }
                    if (parsed) {
                        let data = Array.isArray(parsed) ? parsed : (parsed.records || []);
                        const diagErrors = parsed.diagErrors || [];
                        if (data.length === 0 && diagErrors.length > 0) {
                            console.warn(`[Export-All] Server ${server.name} (${cleanHost}): 0 records. Diag: ${diagErrors.slice(0,5).join(' | ')}`);
                        }
                        data.forEach(r => {
                            allRecords.push({
                                server: server.name,
                                zone: r.ZoneName,
                                host: r.HostName,
                                type: r.RecordType,
                                ttl: r.TTL,
                                data: r.Data
                            });
                        });
                    }
                }
            } catch (e) {
                console.error(`[Export-All] Server ${server.name} (${cleanHost}) error: ${e.message}`);
            }
        }
        res.json({ records: allRecords });
    } catch (err) {
        console.error('[DNS] Export all failed:', err);
        res.status(500).json({ error: 'Failed to export records. Please contact administrator.' });
    }
});

router.get('/export-server/:id', async (req, res) => {
    try {
        const db = await readDB();
        const server = db.servers.find(s => s.id === req.params.id);
        if (!server) return res.status(404).json({ error: 'Server not found' });
        if (server.disabled) return res.status(400).json({ error: 'DNS Server is disabled' });
        
        let allRecords = [];
        if (server.cachedDomains && server.cachedDomains.length > 0) {
            // FIX: use AD_ADMIN_USER/PWD (decrypted) when available, fall back to session user
            let username = process.env.AD_ADMIN_USER || req.user.username;
            let rawPwd   = process.env.AD_ADMIN_PWD || req.user.password || '';
            let password = resolveAdminPassword(rawPwd);
            let domain   = req.user.domain;

            if (process.env.AD_ADMIN_USER && username.includes('\\')) {
                const parts = username.split('\\');
                domain = parts[0];
                username = parts[1];
            } else if (process.env.AD_ADMIN_USER && !username.includes('\\')) {
                domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim() || domain;
            }

            let cleanHost = (server.hostname || server.ip || '').trim();
            if (cleanHost.includes('(')) cleanHost = cleanHost.split('(')[0].trim();

            const credHdr = getADCredentialHeader(username, domain, password);
            const sessHdr = getCimSessionHeader(cleanHost);
            const cleanup = getCimSessionCleanup();
            const zonesJson = sanitizePsString(JSON.stringify(server.cachedDomains));
            const psCmd = buildDnsQueryPs(cleanHost, zonesJson, credHdr, sessHdr, cleanup);

            try {
                const stdout = await runPowerShell(psCmd, 120000);
                if (stdout.trim()) {
                    let parsed;
                    try { parsed = JSON.parse(stdout); } catch { parsed = null; }
                    if (parsed) {
                        let data = Array.isArray(parsed) ? parsed : (parsed.records || []);
                        const diagErrors = parsed.diagErrors || [];
                        if (data.length === 0 && diagErrors.length > 0) {
                            console.warn(`[Export-Server] Server ${server.name} (${cleanHost}): 0 records. Diag: ${diagErrors.slice(0,5).join(' | ')}`);
                        }
                        data.forEach(r => {
                            allRecords.push({
                                server: server.name,
                                zone: r.ZoneName,
                                host: r.HostName,
                                type: r.RecordType,
                                ttl: r.TTL,
                                data: r.Data
                            });
                        });
                    }
                }
            } catch (e) {
                console.error(`[Export-Server] ${server.name} (${cleanHost}) error: ${e.message}`);
            }
        }
        res.json({ records: allRecords });
    } catch (err) {
        console.error('[DNS] Export server failed:', err);
        res.status(500).json({ error: 'Failed to export records. Please contact administrator.' });
    }
});

// GET /schedule
router.get('/schedule', async (req, res) => {
    try {
        const db = await readDB();
        const sched = db.exportSchedule || { enabled: false, frequency: 'daily', time: '00:00', exportPath: 'C:\\DNS_Exports', targetServerId: 'ALL' };
        res.json(sched);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch schedule' });
    }
});

// POST /schedule
router.post('/schedule', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const newSched = req.body;
        
        // Validate exportPath
        if (newSched.exportPath && typeof newSched.exportPath === 'string') {
            const p = newSched.exportPath.trim();
            if (p.includes('..')) {
                return res.status(400).json({ error: 'Invalid exportPath. Path cannot contain directory traversal (..) characters.' });
            }
            newSched.exportPath = p;
        }

        // Remove legacy svc fields if they exist in request
        delete newSched.svcDomain;
        delete newSched.svcUser;
        delete newSched.svcPassword;

        // atomic read-modify-write of the CURRENT dns_data.json (only exportSchedule changes)
        dnsDataStore.mutateDnsDb((db) => { db.exportSchedule = newSched; }, { reason: 'export schedule' });
        
        // Notify Background Worker to re-initialize scheduler via IPC, fallback to local if standalone
        const sent = typeof global.sendWorkerMessage === 'function' && global.sendWorkerMessage({ 
            type: 'RELOAD_DNS_SCHEDULER',
            schedule: newSched
        });
        if (!sent) {
            const { initDnsScheduler } = require('../services/dnsScheduler');
            initDnsScheduler(newSched);
        }
        
        auditLog(req.user.username, 'DNS Hub', `Updated export schedule: ${JSON.stringify(req.body)}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update schedule' });
    }
});

module.exports = router;
module.exports.buildDnsQueryPs = buildDnsQueryPs;

