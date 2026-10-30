const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { readDB } = require('../lib/db');
const { runPowerShell, getADCredentialHeader, getCimSessionHeader, getCimSessionCleanup, sanitizePsString } = require('../lib/powershell');
const { buildDnsQueryPs } = require('../routes/records');
const { auditLog } = require('../lib/logger');

let currentTask = null;
let heartbeatTask = null;
let lastTickMinute = -1;
let lastHeartbeatMinute = -1;

/**
 * Writes export content to a target directory (including UNC network shares like \\host\share\...)
 * using AD_ADMIN_USER and AD_ADMIN_PWD credentials via PowerShell PSDrive mounting.
 */
async function writeExportFileWithADAuth(exportDirPath, fileName, fileContent, username, domain, password) {
    if (!exportDirPath) {
        throw new Error('Export directory path is empty or not configured.');
    }

    const isUnc = exportDirPath.startsWith('\\\\') || exportDirPath.startsWith('//');

    // If not a UNC path, attempt standard fs write first
    if (!isUnc) {
        try {
            if (!fsSync.existsSync(exportDirPath)) {
                await fs.mkdir(exportDirPath, { recursive: true });
            }
            const localFullPath = path.join(exportDirPath, fileName);
            await fs.writeFile(localFullPath, fileContent, 'utf8');
            return localFullPath;
        } catch (localErr) {
            console.warn(`[Scheduler] Standard fs.writeFile failed (${localErr.message}), falling back to PowerShell AD auth...`);
        }
    }

    // PowerShell AD Authenticated Write (specifically for UNC network shares)
    const safePass = (password || '').replace(/'/g, "''");
    const safeUser = (username || '').replace(/'/g, "''");
    const safeDomain = (domain || '').replace(/'/g, "''");
    let credUser = safeUser;
    if (safeDomain && !safeUser.includes('\\') && !safeUser.includes('@')) {
        credUser = `${safeDomain}\\${safeUser}`;
    }

    const safeDirPath = exportDirPath.replace(/'/g, "''");
    const safeFileName = fileName.replace(/'/g, "''");
    const b64Data = Buffer.from(fileContent, 'utf8').toString('base64');

    const psCmd = `
        $ErrorActionPreference = "Stop";
        $targetDir = '${safeDirPath}';
        $fileName = '${safeFileName}';
        $b64 = '${b64Data}';
        $bytes = [System.Convert]::FromBase64String($b64);
        $csvText = [System.Text.Encoding]::UTF8.GetString($bytes);
        
        $credUser = '${credUser}';
        $plainPass = '${safePass}';
        $uncRoot = $null;

        # If targetDir is a UNC network path (starts with \\\\)
        if ($targetDir.StartsWith('\\\\') -or $targetDir.StartsWith('//')) {
            $trimmed = $targetDir.TrimStart('\\').TrimStart('/');
            $parts = $trimmed.Split('\\/');
            if ($parts.Length -ge 2) {
                $uncRoot = "\\\\" + $parts[0] + "\\" + $parts[1];
                # Establish SMB session with AD admin credentials
                & net.exe use $uncRoot /user:"$credUser" "$plainPass" /yes 2>&1 | Out-Null;
            }
        }

        try {
            if (-not (Test-Path -LiteralPath $targetDir)) {
                New-Item -ItemType Directory -Path $targetDir -Force | Out-Null;
            }
            $destFile = Join-Path $targetDir $fileName;
            Set-Content -LiteralPath $destFile -Value $csvText -Encoding UTF8 -Force;
            Write-Output "SAVED_OK";
        } finally {
            if ($uncRoot) {
                & net.exe use $uncRoot /delete /yes 2>&1 | Out-Null;
            }
        }
    `;

    const out = await runPowerShell(psCmd);
    if (!out.includes('SAVED_OK')) {
        throw new Error(`PowerShell AD file write failed: ${out}`);
    }
    return path.join(exportDirPath, fileName);
}

async function runExportTask() {
    if (runExportTask.isExecuting) return;
    runExportTask.isExecuting = true;

    const tz = process.env.TZ || 'Asia/Taipei';
    const nowLocal = new Date().toLocaleString('sv-SE', { timeZone: tz });
    console.log(`[Scheduler] [${nowLocal}] DNS Export Task Triggered.`);

    try {
        const db = await readDB(true);
        const sched = db.exportSchedule;
        if (!sched || !sched.enabled) {
            console.log('[Scheduler] Task skipped: disabled or not configured.');
            return;
        }

        auditLog('SYSTEM', 'DNS Hub', `Scheduled export task started. Target: ${sched.targetServerId}`);

        const servers = db.servers.filter(s => sched.targetServerId === 'ALL' || s.id === sched.targetServerId);
        let allRecords = [];

        let username = process.env.AD_ADMIN_USER || '';
        let password = process.env.AD_ADMIN_PWD || '';
        let domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim();

        if (password && password.startsWith('enc:')) {
            try {
                const { decryptText } = require('../lib/crypto');
                password = decryptText(password.substring(4));
            } catch (e) {}
        }

        if (!username || !password) {
            console.error('[Scheduler] AD credentials missing.');
            return;
        }

        if (username.includes('\\')) {
            const parts = username.split('\\');
            domain = parts[0];
            username = parts[1];
        }

        for (const server of servers) {
            if (!server.cachedDomains || server.cachedDomains.length === 0) continue;

            let cleanHost = (server.hostname || server.ip || '').trim();
            if (cleanHost.includes('(')) cleanHost = cleanHost.split('(')[0].trim();

            const credHdr = getADCredentialHeader(username, domain, password);
            const sessHdr = getCimSessionHeader(cleanHost);
            const cleanup = getCimSessionCleanup();
            const zonesJson = sanitizePsString(JSON.stringify(server.cachedDomains));
            const psCmd = buildDnsQueryPs(cleanHost, zonesJson, credHdr, sessHdr, cleanup);

            try {
                const stdout = await runPowerShell(psCmd);
                if (stdout.trim()) {
                    let parsed = JSON.parse(stdout);
                    let data = Array.isArray(parsed) ? parsed : (parsed.records || []);
                    let diagErrors = parsed.diagErrors || [];

                    if (data.length > 0) {
                        console.log(`[Scheduler] Server ${server.name} (${cleanHost}): retrieved ${data.length} records across ${server.cachedDomains.length} zones.`);
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
                    } else {
                        const errSummary = diagErrors.length > 0 ? diagErrors.slice(0, 5).join(' | ') : 'No records returned from DNS queries';
                        console.warn(`[Scheduler] Server ${server.name} (${cleanHost}): 0 records returned. Diagnostics: ${errSummary}`);
                        auditLog('SYSTEM', 'DNS Hub', `Scheduled export check: Server ${server.name} (${cleanHost}) returned 0 records. Diagnostics: ${errSummary}`);
                    }
                } else {
                    console.warn(`[Scheduler] Server ${server.name} (${cleanHost}): PowerShell returned empty output.`);
                }
            } catch (e) {
                console.error(`[Scheduler] Error on server ${server.name} (${cleanHost}): ${e.message}`);
            }
        }

        if (allRecords.length === 0) {
            console.warn('[Scheduler] DNS Export Task finished with 0 records. No file was generated.');
            auditLog('SYSTEM', 'DNS Hub', 'Scheduled export task finished with 0 records. No export file was generated. Please verify server connectivity or AD permissions.');
            return;
        }

        let csv = "Server,Zone,HostName,Type,TTL,Data\n";
        allRecords.forEach(r => {
            csv += `"${r.server}","${r.zone}","${r.host}","${r.type}","${r.ttl}","${r.data}"\n`;
        });

        const now = new Date();
        const dateStr = now.toLocaleDateString('sv-SE', { timeZone: tz }).replace(/-/g, '');
        const timeStr = now.toLocaleTimeString('sv-SE', { timeZone: tz, hour12: false }).replace(/:/g, '');
        const fileName = `DNS_Export_Auto_${dateStr}_${timeStr}.csv`;
        const fullPath = path.join(sched.exportPath, fileName);

        // Write export file using AD_ADMIN_USER & AD_ADMIN_PWD authentication for UNC / network shares
        try {
            await writeExportFileWithADAuth(sched.exportPath, fileName, csv, username, domain, password);
            console.log(`[Scheduler] Export successfully saved to ${fullPath} (${allRecords.length} records) using AD credentials (${domain}\\${username})`);
            auditLog('SYSTEM', 'DNS Hub', `Automatic export successful: ${fullPath} (${allRecords.length} records, Authenticated as ${domain}\\${username})`);
        } catch (writeErr) {
            console.error(`[Scheduler] Failed to write export file to ${fullPath}:`, writeErr.message);
            auditLog('SYSTEM', 'DNS Hub', `Automatic export write failed to ${fullPath}: ${writeErr.message}`);
            return;
        }

            // Sync to IPAM if enabled
            if (process.env.APP_ENABLE_IPAM !== 'false') {
                let syncRecords = [];
                let fqdnToIp = {};

                // Pass 1: Extract A/AAAA records
                allRecords.forEach(r => {
                    if (r.type === 'A' || r.type === 'AAAA') {
                        const fqdn = r.host === '@' ? r.zone : `${r.host}.${r.zone}`;
                        const ip = String(r.data).trim();
                        fqdnToIp[fqdn] = ip;
                        syncRecords.push({ ip, fqdn });
                    }
                });

                // Pass 2: Map CNAME targets
                allRecords.forEach(r => {
                    if (r.type === 'CNAME') {
                        const fqdn = r.host === '@' ? r.zone : `${r.host}.${r.zone}`;
                        let targetFqdn = String(r.data).trim();
                        if (targetFqdn.endsWith('.')) targetFqdn = targetFqdn.slice(0, -1);
                        
                        const ip = fqdnToIp[targetFqdn];
                        if (ip) {
                            syncRecords.push({ ip, fqdn });
                        }
                    }
                });

                if (syncRecords.length > 0) {
                    try {
                        const { syncDnsToIpam } = require('../lib/ipamSync');
                        // Only zones that returned records were fetched completely (every zone has SOA/NS records):
                        // FQDNs of a zone whose fetch failed are never cleared
                        const fetchedZones = [...new Set(allRecords.map(r => r.zone).filter(Boolean))];
                        const syncRes = await syncDnsToIpam(syncRecords, 'SYSTEM', { zones: fetchedZones });
                        console.log(`[Scheduler] IPAM FQDN Sync completed: ${syncRes.updated} updated, ${syncRes.cleared} cleared, ${syncRes.skipped} skipped.`);
                        
                        // Sync FQDN to Server List CMDB metadata
                        const { readDataSync, writeDataSync } = require('../lib/db');
                        const CMDB_META_KEY = 'server_operation/server_cmdb_meta.json';
                        let cmdbMeta = readDataSync(CMDB_META_KEY, {});
                        let metaChanged = false;

                        syncRecords.forEach(rec => {
                            if (rec.ip && rec.fqdn) {
                                const cleanIp = String(rec.ip).trim();
                                if (!cmdbMeta[cleanIp]) cmdbMeta[cleanIp] = {};
                                if (cmdbMeta[cleanIp].fqdn !== rec.fqdn) {
                                    cmdbMeta[cleanIp].fqdn = rec.fqdn;
                                    cmdbMeta[cleanIp].updatedAt = new Date().toISOString();
                                    metaChanged = true;
                                }
                            }
                        });

                        if (metaChanged) {
                            writeDataSync(CMDB_META_KEY, cmdbMeta);
                            console.log('[Scheduler] Server List CMDB FQDN Sync completed.');
                        }
                    } catch (syncErr) {
                        console.error('[Scheduler] IPAM / CMDB FQDN Sync failed:', syncErr.message);
                    }
                }
            }
    } catch (err) {
        console.error('[Scheduler] Task failed:', err);
    } finally {
        runExportTask.isExecuting = false;
    }
}

async function initDnsScheduler(overrideSchedule = null) {
    lastTickMinute = -1;
    try {
        let sched = overrideSchedule;
        if (!sched) {
            const db = await readDB(true);
            sched = db.exportSchedule;
        }
        if (!sched || !sched.enabled) {
            console.log('[Scheduler] DNS Export is disabled.');
            if (currentTask) {
                if (currentTask.stop) currentTask.stop();
                clearInterval(currentTask);
                currentTask = null;
            }
            if (heartbeatTask) {
                if (heartbeatTask.stop) heartbeatTask.stop();
                clearInterval(heartbeatTask);
                heartbeatTask = null;
            }
            return;
        }

        if (currentTask) {
            if (currentTask.stop) currentTask.stop();
            clearInterval(currentTask);
            currentTask = null;
        }
        if (heartbeatTask) {
            if (heartbeatTask.stop) heartbeatTask.stop();
            clearInterval(heartbeatTask);
            heartbeatTask = null;
        }

        // Robust Heartbeat (Every Hour)
        heartbeatTask = setInterval(() => {
            const now = new Date();
            if (now.getMinutes() === 0 && lastHeartbeatMinute !== 0) {
                lastHeartbeatMinute = 0;
                console.log(`[Scheduler] [Heartbeat] Active. System Time: ${now.toLocaleString()} (TZ: ${process.env.TZ || 'Default'})`);
            } else if (now.getMinutes() !== 0) {
                lastHeartbeatMinute = -1;
            }
        }, 10000);

        if (sched.frequency === 'daily') {
            const [hh, mm] = (sched.time || '00:00').split(':');
            const targetH = parseInt(hh, 10);
            const targetM = parseInt(mm, 10);
            
            const msg = `DNS Export scheduled daily at ${sched.time}`;
            console.log(`[Scheduler] ${msg}`);
            auditLog('SYSTEM', 'DNS Hub', msg);
            
            currentTask = setInterval(() => {
                const now = new Date();
                const currentH = now.getHours();
                const currentM = now.getMinutes();
                
                if (currentH === targetH && currentM === targetM && lastTickMinute !== currentM) {
                    lastTickMinute = currentM;
                    runExportTask();
                } else if (currentM !== targetM) {
                    lastTickMinute = -1;
                }
            }, 10000);
            
        } else {
            // Fallback for weekly/custom cron
            let cronExpr = '';
            if (sched.frequency === 'weekly') {
                const [hh, mm] = (sched.time || '00:00').split(':');
                const day = sched.dayOfWeek || 0; 
                cronExpr = `${parseInt(mm, 10)} ${parseInt(hh, 10)} * * ${day}`;
            } else if (sched.frequency === 'custom') {
                cronExpr = sched.customCron;
            }

            if (cronExpr) {
                const msg = `DNS Export scheduled via native polling: ${cronExpr}`;
                console.log(`[Scheduler] ${msg}`);
                auditLog('SYSTEM', 'DNS Hub', msg);
                
                const matchCronField = (value, field) => {
                    if (field === '*') return true;
                    if (field.includes(',')) return field.split(',').some(part => matchCronField(value, part));
                    if (field.includes('/')) {
                        const step = parseInt(field.split('/')[1], 10);
                        return value % step === 0;
                    }
                    return value === parseInt(field, 10);
                };

                const parts = cronExpr.trim().split(/\s+/);
                if (parts.length >= 5) {
                    currentTask = setInterval(() => {
                        const now = new Date();
                        const currentM = now.getMinutes();
                        
                        const minMatch = matchCronField(currentM, parts[0]);
                        const hourMatch = matchCronField(now.getHours(), parts[1]);
                        const domMatch = matchCronField(now.getDate(), parts[2]);
                        const monMatch = matchCronField(now.getMonth() + 1, parts[3]);
                        const dowMatch = matchCronField(now.getDay(), parts[4]);

                        if (minMatch && hourMatch && domMatch && monMatch && dowMatch && lastTickMinute !== currentM) {
                            lastTickMinute = currentM;
                            runExportTask();
                        } else if (!minMatch) {
                            lastTickMinute = -1;
                        }
                    }, 10000);
                }
            }
        }
    } catch (err) {
        console.error(`[Scheduler] Init error: ${err.message}`);
    }
}

module.exports = { initDnsScheduler, runExportTask };
