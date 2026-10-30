const net = require('net');
const { runPowerShell } = require('./powershell');

function checkPort(host, port, timeout = 2000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeout);
        
        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });
        
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        
        socket.on('error', () => {
            resolve(false);
        });
        
        socket.connect(port, host);
    });
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// The target is placed inside a PowerShell command: only an IPv4 address or a DNS host name is accepted
function isSafeTarget(ip) {
    if (typeof ip !== 'string') return false;
    return /^[0-9.]+$/.test(ip) ? IPV4.test(ip) : HOSTNAME.test(ip);
}

async function detectOs(ip) {
    if (!isSafeTarget(ip)) {
        return { status: 'offline', os: 'unknown', error: 'invalid target' };
    }
    try {
        const pingObj = await runPowerShell(`Test-Connection -ComputerName "${ip}" -Count 1 -Quiet -ErrorAction SilentlyContinue`);
        if (pingObj.trim() !== 'True') {
            return { status: 'offline', os: 'unknown' };
        }
    } catch(e) {
        return { status: 'offline', os: 'unknown' };
    }

    const isSsh = await checkPort(ip, 22);
    if (isSsh) return { status: 'online', os: 'Linux' };

    const isWinRM = await checkPort(ip, 5985);
    if (isWinRM) return { status: 'online', os: 'Windows' };

    const isWmiRpc = await checkPort(ip, 135);
    if (isWmiRpc) return { status: 'online', os: 'Windows' };

    return { status: 'online', os: 'Unknown' };
}

module.exports = { detectOs, checkPort, isSafeTarget };
