const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requireAuth, checkFeature, checkRole } = require('../middleware/auth');
const { readDB, readDataSync } = require('../lib/db');
const dnsDataStore = require('../lib/dnsDataStore');
const powershell = require('../lib/powershell');
const { getADCredentialHeader, getCimSessionHeader, getCimSessionCleanup, sanitizePsString } = powershell;
const { psSq } = require('../lib/psQuote');
const dnsRecords = require('../lib/dnsRecords');
const { parseDnsRecordLine, findTargetServer } = dnsRecords;
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

            const stdout = await powershell.runPowerShell(psCmd);
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

/**
 * PowerShell credential header for a DNS change: the signed-in user's AD credential, or the service account
 * (AD_ADMIN_USER / AD_ADMIN_PWD) when the session carries no password.
 */
function dnsCredentialHeader(user) {
    let username = user.username;
    const password = user.password;
    let domain = user.domain;
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
    return getADCredentialHeader(username, domain, password || resolveAdminPassword(process.env.AD_ADMIN_PWD));
}

// PowerShell: the data of a record as one string (the same values the query and export show)
const PS_RECORD_DATA = `
$dataOf = {
    param($r)
    $t = [string]$r.RecordType
    try {
        if ($t -eq 'A')         { return $r.RecordData.IPv4Address.IPAddressToString }
        elseif ($t -eq 'AAAA')  { return $r.RecordData.IPv6Address.IPAddressToString }
        elseif ($t -eq 'CNAME') { return $r.RecordData.HostNameAlias }
        elseif ($t -eq 'PTR')   { return $r.RecordData.PtrDomainName }
        elseif ($t -eq 'MX')    { return $r.RecordData.MailExchange }
        elseif ($t -eq 'TXT')   { return $r.RecordData.DescriptiveText }
        elseif ($t -eq 'NS')    { return $r.RecordData.NameServer }
        else                    { return $r.RecordData.ToString() }
    } catch { return '' }
}`;

/** Runs one batch script on a DNS server: $batch is the JSON list, the script body adds to $out. Returns the list. */
async function runBatch(user, server, items, body) {
    const psCmd = `
$ErrorActionPreference = "Stop";
${dnsCredentialHeader(user)}
${getCimSessionHeader(server.hostname)}
${PS_RECORD_DATA}
try {
    $batch = '${psSq(JSON.stringify(items))}' | ConvertFrom-Json
    $out = @()
${body}
    ConvertTo-Json -InputObject @($out) -Depth 5 -Compress
} finally {
    ${getCimSessionCleanup()}
}
`;
    const stdout = await powershell.runPowerShell(psCmd);
    return stdout && stdout.trim() ? dnsRecords.toArray(JSON.parse(stdout)) : [];
}

// Why a whole batch failed: the first line of the error, never the script (it carries the credential)
function batchError(err) {
    const msg = String((err && (err.stderr || err.message)) || err || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || 'Unknown error';
    return /ConvertTo-SecureString|PSCredential/i.test(msg) ? 'Error: Failed to process DNS record' : `Error: ${msg.slice(0, 300)}`;
}

function badBatch(res, list) {
    if (!Array.isArray(list) || list.length === 0) { res.status(400).json({ error: 'records must be a non-empty list' }); return true; }
    if (list.length > dnsRecords.MAX_BATCH) { res.status(400).json({ error: `At most ${dnsRecords.MAX_BATCH} records per request` }); return true; }
    return false;
}

const IPV4_ONLY_RE = new RegExp(`^${dnsRecords.IPV4_RE.source}$`);

router.post('/add', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { records } = req.body || {};
    if (badBatch(res, records)) return;
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
        if (!IPV4_ONLY_RE.test(ip)) {
            results.push({ record: fqdn, status: `Error: Invalid IPv4 address ${ip}`, serverName: 'None' });
            continue;
        }
        const { server, parsed } = findTargetServer(fqdn, servers);
        if (!server) {
            results.push({ record: fqdn, status: 'Failed: Zone not found in any cache', serverName: 'None' });
            continue;
        }
        if (!groups.has(server.id)) groups.set(server.id, { server, items: [] });
        groups.get(server.id).items.push({ fqdn, ip, zone: parsed.zone, host: parsed.host });
    }

    // One script per server. A name with one A record is updated in place; a name with several is left alone
    // (which one to replace is the user's call). The previous address goes into the change log.
    const body = `
    foreach ($item in $batch) {
        try {
            $existing = @(Get-DnsServerResourceRecord -ZoneName $item.zone -Name $item.host -RRType A -CimSession $global:CIM_SESS -ErrorAction SilentlyContinue)
            $old = @($existing | ForEach-Object { [string](& $dataOf $_) })
            if ($existing.Count -eq 0) {
                Add-DnsServerResourceRecordA -ZoneName $item.zone -Name $item.host -IPv4Address $item.ip -CimSession $global:CIM_SESS
                $status = 'Added'
            } elseif ($existing.Count -gt 1) {
                $status = 'Multiple'
            } elseif ($old[0] -eq $item.ip) {
                $status = 'Unchanged'
            } else {
                $newObj = $existing[0].Clone()
                $newObj.RecordData.IPv4Address = [System.Net.IPAddress]::Parse($item.ip)
                Set-DnsServerResourceRecord -ZoneName $item.zone -OldInputObject $existing[0] -NewInputObject $newObj -CimSession $global:CIM_SESS
                $status = 'Updated'
            }
            $out += [PSCustomObject]@{ fqdn = $item.fqdn; ip = $item.ip; status = $status; oldIps = $old }
        } catch {
            $out += [PSCustomObject]@{ fqdn = $item.fqdn; ip = $item.ip; status = "Error: $($_.Exception.Message)"; oldIps = @() }
        }
    }`;

    for (const { server, items } of groups.values()) {
        try {
            const answers = await runBatch(req.user, server, items, body);
            for (const a of answers) {
                const { log, ...row } = dnsRecords.addOutcome(a, server.name);
                results.push(row);
                if (log) actionsPerformed.push(log);
            }
        } catch (err) {
            console.error('[DNS] DNS Add Error:', err.stderr || err.message || String(err));
            const status = batchError(err);
            items.forEach(it => results.push({ record: it.fqdn, status, serverName: server.name }));
        }
    }

    if (actionsPerformed.length > 0) {
        batchAuditLog(req.user.username, 'DNS Hub', actionsPerformed);
        appendDnsChangeLog(req.user.username, actionsPerformed);
    }
    res.json({ results });
});

// What a delete would remove: every record under each name, read from its DNS server. Nothing is changed.
router.post('/delete-preview', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { records } = req.body || {};
    if (badBatch(res, records)) return;
    const db = await readDB();
    // Plain names: zone roots and unknown zones are refused here already
    const { groups, rejected } = dnsRecords.groupByServer(records.map(r => dnsRecords.nameOf(r)), db.servers);
    const results = rejected.map(r => ({ fqdn: r.record, serverName: r.serverName, status: r.status, records: [] }));

    const body = `
    foreach ($item in $batch) {
        try {
            $recs = @(Get-DnsServerResourceRecord -ZoneName $item.zone -Name $item.host -CimSession $global:CIM_SESS -ErrorAction Stop)
            $list = @($recs | ForEach-Object { [PSCustomObject]@{ type = [string]$_.RecordType; data = [string](& $dataOf $_); ttl = $_.TimeToLive.TotalSeconds } })
            $out += [PSCustomObject]@{ fqdn = $item.fqdn; status = 'Ready'; records = $list }
        } catch {
            $st = if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { 'Not found' } else { "Error: $($_.Exception.Message)" }
            $out += [PSCustomObject]@{ fqdn = $item.fqdn; status = $st; records = @() }
        }
    }`;

    for (const { server, items } of groups.values()) {
        try {
            const answers = await runBatch(req.user, server, items.map(({ fqdn, zone, host }) => ({ fqdn, zone, host })), body);
            for (const a of answers) {
                const list = dnsRecords.lookupRecords(a.records);
                const status = a.status === 'Ready' && list.length === 0 ? 'Not found' : String(a.status || 'Error: No answer');
                results.push({ fqdn: a.fqdn, serverName: server.name, status, records: list });
            }
        } catch (err) {
            console.error('[DNS] DNS Delete Preview Error:', err.stderr || err.message || String(err));
            const status = batchError(err);
            items.forEach(it => results.push({ fqdn: it.fqdn, serverName: server.name, status, records: [] }));
        }
    }
    res.json({ results });
});

// Deletes exactly the records named: { fqdn, type, data } removes that one record; a plain name removes the A
// records of the name only (never its CNAME, TXT, MX ... records). Every removed record goes into the change log.
router.post('/delete', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { records } = req.body || {};
    if (badBatch(res, records)) return;
    const db = await readDB();
    const { groups, rejected } = dnsRecords.groupByServer(records, db.servers);
    const results = [...rejected];
    const actionsPerformed = [];

    const body = `
    foreach ($item in $batch) {
        $removed = @()
        try {
            $recs = @(Get-DnsServerResourceRecord -ZoneName $item.zone -Name $item.host -RRType $item.type -CimSession $global:CIM_SESS -ErrorAction Stop)
            $targets = @($recs | Where-Object { $null -eq $item.data -or [string](& $dataOf $_) -eq $item.data })
            if ($targets.Count -eq 0) {
                $out += [PSCustomObject]@{ fqdn = $item.fqdn; status = 'Not found'; removed = @() }
                continue
            }
            foreach ($t in $targets) {
                Remove-DnsServerResourceRecord -ZoneName $item.zone -InputObject $t -CimSession $global:CIM_SESS -Force -ErrorAction Stop
                $removed += [PSCustomObject]@{ type = [string]$t.RecordType; data = [string](& $dataOf $t) }
            }
            $out += [PSCustomObject]@{ fqdn = $item.fqdn; status = 'Deleted'; removed = $removed }
        } catch {
            $st = if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { 'Not found' } elseif ($removed.Count -gt 0) { "Partly deleted: $($_.Exception.Message)" } else { "Error: $($_.Exception.Message)" }
            $out += [PSCustomObject]@{ fqdn = $item.fqdn; status = $st; removed = $removed }
        }
    }`;

    for (const { server, items } of groups.values()) {
        try {
            const answers = await runBatch(req.user, server, items, body);
            for (const a of answers) {
                const { logs, ...row } = dnsRecords.deleteOutcome(a, server.name);
                results.push(row);
                actionsPerformed.push(...logs);
            }
        } catch (err) {
            console.error('[DNS] DNS Delete Error:', err.stderr || err.message || String(err));
            const status = batchError(err);
            items.forEach(it => results.push({ record: it.fqdn, status, serverName: server.name }));
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
                const stdout = await powershell.runPowerShell(psCmd, 120000);
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
                const stdout = await powershell.runPowerShell(psCmd, 120000);
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

