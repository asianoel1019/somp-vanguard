const { detectOs } = require('../lib/osDetect');
const { executeSSH } = require('../lib/ssh');
const { runPowerShell, getADCredentialHeader } = require('../lib/powershell');

/**
 * Performs a health check (CPU, Mem, Disk) on a given IP.
 * @param {string} ip Target IP Address
 * @param {string} linuxPassword Linux SSH password (optional)
 * @param {object} adCredentials AD Credentials for Windows { username, domain, password } (optional)
 * @returns {Promise<object>} Status object
 */
async function performServerCheck(ip, linuxPassword, adCredentials) {
    let result = { ip, status: 'Offline', os: 'N/A', cpu: '-', memory: '-', disk: '-', error: null };
    try {
        const detection = await detectOs(ip);
        if (detection.status === 'offline') {
            result = { ip, status: 'Offline', os: 'N/A', cpu: '-', memory: '-', disk: '-', error: 'Ping failed' };
        } else if (detection.os === 'Linux') {
            if (!linuxPassword) {
                result = { ip, status: 'Online', os: 'Linux', cpu: '-', memory: '-', disk: '-', error: 'Missing Linux password' };
            } else {
                try {
                    const cmd = `
                        cpu=$(top -bn1 | grep load | awk '{printf "%.2f", $(NF-2)}');
                        mem=$(free -m | awk 'NR==2{printf "%.2f", $3*100/$2 }');
                        disk=$(df -h / | awk '$NF=="/"{printf "%s", $5}');
                        echo "$cpu|$mem|$disk";
                    `;
                    const { stdout, stderr } = await executeSSH(ip, process.env.LINUX_ADMIN_USER || 'xyuser', linuxPassword, cmd, { timeout: 5000 });
                    if (stderr) throw new Error(stderr);
                    
                    const parts = stdout.trim().split('|');
                    result = { 
                        ip, status: 'Online', os: 'Linux', 
                        cpu: parts[0] ? parts[0] + '%' : '-',
                        memory: parts[1] ? parts[1] + '%' : '-',
                        disk: parts[2] ? parts[2] : '-',
                        error: null
                    };
                } catch (err) {
                    result = { ip, status: 'Online', os: 'Linux', cpu: '-', memory: '-', disk: '-', error: err.message || 'SSH failed' };
                }
            }
        } else if (detection.os === 'Windows' || detection.os === 'Unknown') {
            try {
                // Determine AD credentials to use
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
                        $proc = Get-CimInstance -ClassName Win32_Processor;
                        $cpuVal = ($proc | Measure-Object -Property LoadPercentage -Average).Average;
                        $cpu = [Math]::Round($cpuVal, 1);
                        $osObj = Get-CimInstance -ClassName Win32_OperatingSystem;
                        $memUsed = $osObj.TotalVisibleMemorySize - $osObj.FreePhysicalMemory;
                        $mem = [Math]::Round(($memUsed / $osObj.TotalVisibleMemorySize) * 100, 1);
                        $diskObj = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='C:'";
                        $diskP = [Math]::Round((($diskObj.Size - $diskObj.FreeSpace) / $diskObj.Size) * 100, 1);
                        [PSCustomObject]@{ CPU = "$cpu%"; Memory = "$mem%"; Disk = "$diskP%" } | ConvertTo-Json
                    }
                `;
                const out = await runPowerShell(psCmd);
                if (!out.trim()) throw new Error("Empty WMI response");
                const jsonStart = out.indexOf('{');
                const jsonEnd = out.lastIndexOf('}');
                if (jsonStart === -1 || jsonEnd === -1) {
                    throw new Error("Invalid WMI response format: " + out.trim());
                }
                const cleanJson = out.substring(jsonStart, jsonEnd + 1);
                const parsed = JSON.parse(cleanJson);
                
                result = {
                    ip, status: 'Online', os: 'Windows',
                    cpu: parsed.CPU, memory: parsed.Memory, disk: parsed.Disk, error: null
                };
            } catch (err) {
                const errMsg = (err.stderr || err.message || 'WMI check failed').trim();
                result = { ip, status: 'Online', os: 'Windows', cpu: '-', memory: '-', disk: '-', error: errMsg };
            }
        }
    } catch (err) {
        result = { ip, status: 'Offline', os: 'N/A', cpu: '-', memory: '-', disk: '-', error: err.message };
    }
    
    if (result.status === 'Offline') {
        try { require('../lib/websocket').broadcastEvent('SERVER_OFFLINE_ALERT', result); } catch(e) {}
    }
    
    return result;
}

module.exports = { performServerCheck };
