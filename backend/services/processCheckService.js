const { detectOs } = require('../lib/osDetect');
const { executeSSH } = require('../lib/ssh');
const { runPowerShell, getADCredentialHeader } = require('../lib/powershell');

/**
 * Performs a check for the Top 5 processes (by CPU) on a given IP.
 * @param {string} ip Target IP Address
 * @param {string} linuxPassword Linux SSH password (optional)
 * @param {object} adCredentials AD Credentials for Windows (optional)
 * @returns {Promise<object>}
 */
async function performProcessCheck(ip, linuxPassword, adCredentials) {
    let result = { ip, status: 'Offline', os: 'N/A', processes: [], error: null };
    try {
        const detection = await detectOs(ip);
        if (detection.status === 'offline') {
            result = { ip, status: 'Offline', os: 'N/A', processes: [], error: 'Ping failed' };
        } else if (detection.os === 'Linux') {
            if (!linuxPassword) {
                result = { ip, status: 'Online', os: 'Linux', processes: [], error: 'Missing Linux password' };
            } else {
                try {
                    // Get top 5 processes by CPU usage
                    const cmd = `ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 6`;
                    const { stdout, stderr } = await executeSSH(ip, process.env.LINUX_ADMIN_USER || 'xyuser', linuxPassword, cmd, { timeout: 5000 });
                    if (stderr && !stdout.trim()) throw new Error(stderr);
                    
                    const lines = stdout.trim().split('\n').slice(1); // Remove header
                    const processes = lines.map(line => {
                        const parts = line.trim().split(/\s+/);
                        return {
                            pid: parts[0] || '-',
                            name: parts[1] || '-',
                            cpu: (parts[2] || '-') + '%',
                            mem: (parts[3] || '-') + '%'
                        };
                    });
                    
                    result = { ip, status: 'Online', os: 'Linux', processes, error: null };
                } catch (err) {
                    result = { ip, status: 'Online', os: 'Linux', processes: [], error: err.message || 'SSH failed' };
                }
            }
        } else if (detection.os === 'Windows' || detection.os === 'Unknown') {
            try {
                let username = adCredentials?.username;
                let password = adCredentials?.password;
                let domain = adCredentials?.domain;

                if (!password && process.env.AD_ADMIN_USER) {
                    username = process.env.AD_ADMIN_USER;
                    password = process.env.AD_ADMIN_PWD;
                    if (username.includes('\\')) {
                        const parts = username.split('\\');
                        domain = parts[0];
                        username = parts[1];
                    } else {
                        domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim() || domain;
                    }
                }

                const credHdr = getADCredentialHeader(username, domain, password);
                const credArg = password && domain !== 'local' ? '-Credential $global:AD_CRED' : '';
                const psCmd = `
                    $ErrorActionPreference = "Stop";
                    try { Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value "*" -Force -ErrorAction SilentlyContinue } catch {}
                    ${credHdr}
                    Invoke-Command -ComputerName "${ip}" ${credArg} -ScriptBlock {
                        Get-Process | Where-Object { $_.CPU -gt 0 } | Sort-Object CPU -Descending | Select-Object -First 5 @{Name='name';Expression={$_.Name}}, @{Name='pid';Expression={$_.Id}}, @{Name='cpu';Expression={[Math]::Round($_.CPU, 1)}}, @{Name='mem';Expression={[Math]::Round($_.WorkingSet64 / 1MB, 1)}} | ConvertTo-Json
                    }
                `;
                const out = await runPowerShell(psCmd);
                if (!out.trim()) throw new Error("Empty WMI response");
                
                // Robust JSON Extraction using Regex matching
                const jsonMatch = out.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
                if (!jsonMatch) {
                    throw new Error("Invalid WMI response format");
                }

                let cleanJson = jsonMatch[0].trim();
                if (cleanJson.startsWith('{')) {
                    cleanJson = `[${cleanJson}]`;
                }

                let parsed = JSON.parse(cleanJson);
                if (!Array.isArray(parsed)) parsed = [parsed];
                
                const processes = parsed.map(p => ({
                    pid: p.pid,
                    name: p.name,
                    cpu: p.cpu + 's', // Windows Get-Process CPU is total processor time in seconds
                    mem: p.mem + ' MB'
                }));
                
                result = { ip, status: 'Online', os: 'Windows', processes, error: null };
            } catch (err) {
                const errMsg = (err.stderr || err.message || 'WMI check failed').trim();
                result = { ip, status: 'Online', os: 'Windows', processes: [], error: errMsg };
            }
        }
    } catch (err) {
        result = { ip, status: 'Error', processes: [], error: err.message };
    }
    
    // Determine if any required process is down (Offline / Down etc)
    // Actually, process status strings could vary. If processes array has any down or status is error.
    if (result.status === 'Error' || (result.processes && result.processes.some(p => p.status === 'Down' || p.status === 'Stopped'))) {
        try { require('../lib/websocket').broadcastEvent('PROCESS_OFFLINE_ALERT', result); } catch(e) {}
    }

    return result;
}

module.exports = { performProcessCheck };
