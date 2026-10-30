// Network liveness primitives for Server Inventory: in-process TCP connect, batched ICMP, bounded concurrency.
// No module state; every external effect (sockets, PowerShell) can be injected for tests.
const net = require('net');
const { isIpv4 } = require('./inventoryValidation');

const TCP_TIMEOUT_MS = 1500;
const ICMP_TIMEOUT_MS = 5000;
const ICMP_ATTEMPTS = 2;

/** Resolves true when a TCP connection to host:port succeeds within timeoutMs. Never rejects. */
function checkTcpPort(host, port, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const done = (ok) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (_) {}
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        try {
            socket.connect(port, host);
        } catch (e) {
            done(false);
        }
    });
}

/** Ports (of `ports`) that accept a connection, probed in parallel. */
async function probeTcpPorts(ip, ports, tcp = checkTcpPort, timeoutMs = TCP_TIMEOUT_MS) {
    const results = await Promise.all(ports.map(async (p) => {
        try { return (await tcp(ip, p, timeoutMs)) ? p : null; } catch (_) { return null; }
    }));
    return results.filter(p => p !== null);
}

function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
}

/**
 * One ping of one address through ping.exe / ping (execFile, NO shell, args array, strict IPv4 only).
 * 'alive' = exit code 0 AND the output contains TTL= (locale independent; "destination host unreachable" can exit 0
 * on Windows). 'dead' = ping ran and got no reply. 'unknown' = could not be decided (spawn error, timeout, bad
 * address): the caller must not treat it as a miss.
 */
function pingOnce(ip, { execFile = require('child_process').execFile, timeoutMs = ICMP_TIMEOUT_MS, platform = process.platform } = {}) {
    return new Promise((resolve) => {
        if (!isIpv4(ip)) return resolve('unknown');
        const isWin = platform === 'win32';
        const args = isWin ? ['-n', '1', '-w', '1000', ip] : ['-c', '1', '-W', '1', ip];
        try {
            // absolute path on Windows: a service account PATH may lack System32
            const cmd = isWin && process.env.SystemRoot ? require('path').win32.join(process.env.SystemRoot, 'System32', 'PING.EXE') : 'ping';
            execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true }, (err, stdout) => {
                if (!err) return resolve(/TTL=/i.test(String(stdout || '')) ? 'alive' : 'dead');
                if (err.killed || err.signal || typeof err.code !== 'number') return resolve('unknown');
                resolve('dead'); // ping ran and exited non-zero: no reply
            });
        } catch (_) { resolve('unknown'); }
    });
}

/** Two attempts: alive if any attempt answered, dead only when both really got no reply, otherwise unknown. */
async function pingHost(ip, opts = {}) {
    const results = [];
    for (let i = 0; i < ICMP_ATTEMPTS; i++) {
        const r = await pingOnce(ip, opts);
        if (r === 'alive') return 'alive';
        results.push(r);
    }
    return results.every(r => r === 'dead') ? 'dead' : 'unknown';
}

/**
 * ICMP for many addresses with bounded concurrency. Returns { alive: Set, checked: Set }: "checked" are the
 * addresses whose answer is certain (alive or dead); unknown / unreached ones are in neither.
 */
async function icmpCheckMany(ips, { concurrency = 16, shouldStop = () => false, execFile, timeoutMs, platform } = {}) {
    const alive = new Set();
    const checked = new Set();
    await runPool(ips, concurrency, async (ip) => {
        const r = await pingHost(ip, { execFile, timeoutMs, platform });
        if (r === 'alive') { alive.add(ip); checked.add(ip); } else if (r === 'dead') checked.add(ip);
    }, shouldStop);
    return { alive, checked };
}

/** Runs worker(item, index) over items with at most `limit` in flight. Stops starting new items when shouldStop() is true. */
async function runPool(items, limit, worker, shouldStop = () => false) {
    let next = 0;
    const lanes = Math.max(1, Math.min(limit, items.length || 1));
    await Promise.all(Array.from({ length: lanes }, async () => {
        while (next < items.length && !shouldStop()) {
            const i = next++;
            await worker(items[i], i);
        }
    }));
}

module.exports = { TCP_TIMEOUT_MS, ICMP_TIMEOUT_MS, ICMP_ATTEMPTS, checkTcpPort, probeTcpPorts, pingOnce, pingHost, icmpCheckMany, chunk, runPool };
