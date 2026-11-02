/**
 * Background Nutanix clone task (one at a time, web process only).
 *
 * - The clone parameters (Nutanix / AD / local admin / Linux passwords) go to PowerShell on stdin (-ParamFile '-'),
 *   so no credential file is ever written to disk.
 * - The task state lives in the document store (server_operation/nutanix_clone_task.json), not in memory: after a web
 *   restart the status survives, a still-running PowerShell is watched until it exits, and a dead one is finished.
 * - The PowerShell process gets a deadline (NUTANIX_CLONE_TIMEOUT_MINUTES, default max(60, 30 x VM count)); past it
 *   the whole process tree is killed.
 * - The scripts print "##SOMP_VM_CREATED## {json}" once a VM exists in Nutanix. Only those VMs get the Linux software
 *   install and the Server List registration; the exit code no longer decides for the whole batch.
 */
const fs = require('fs');
const path = require('path');

const STATE_KEY = 'server_operation/nutanix_clone_task.json';
const CREATED_MARKER = '##SOMP_VM_CREATED##';
const LINUX_OS = /linux|ubuntu|centos|rhel|redhat|debian|rocky|alma|suse|sles/i;
const DEFAULT_INSTALL_TIMEOUT_MINUTES = 20;

const isLinux = (vm) => LINUX_OS.test(String((vm && vm.OS) || ''));
const vmName = (vm) => String(vm.VMName || vm.Name || vm.name || '');
const vmIp = (vm) => String(vm.IP || vm.ip || '').trim();

function positiveNumber(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Minutes the PowerShell process may run before it is killed. */
function cloneTimeoutMinutes(vmCount, env = process.env) {
    return positiveNumber(env.NUTANIX_CLONE_TIMEOUT_MINUTES) || Math.max(60, 30 * (vmCount || 1));
}

function installTimeoutMs(env = process.env) {
    return (positiveNumber(env.NUTANIX_LINUX_INSTALL_TIMEOUT_MINUTES) || DEFAULT_INSTALL_TIMEOUT_MINUTES) * 60 * 1000;
}

/** JSON with every non-ASCII character escaped: PowerShell 5.1 reads stdin in the OEM code page. */
function asciiJson(obj) {
    return JSON.stringify(obj).replace(/[^\x00-\x7e]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** [{ ip, name, uuid }] from the marker lines in the clone log. */
function parseCreatedMarkers(logText) {
    const out = [];
    for (const line of String(logText || '').split(/\r?\n/)) {
        const at = line.indexOf(CREATED_MARKER);
        if (at < 0) continue;
        try {
            const m = JSON.parse(line.slice(at + CREATED_MARKER.length).trim());
            out.push({ ip: String(m.ip || '').trim(), name: String(m.name || '').trim(), uuid: String(m.uuid || '').trim() });
        } catch (_) { /* a broken marker line counts as no marker */ }
    }
    return out;
}

/** Per VM of the batch: was it created? Matched by IP, else by name (case-insensitive). */
function createdFlags(vms, created) {
    const ips = new Set(created.map(c => c.ip).filter(Boolean));
    const names = new Set(created.map(c => c.name.toLowerCase()).filter(Boolean));
    return vms.map(vm => (vmIp(vm) && ips.has(vmIp(vm))) || (!!vmName(vm) && names.has(vmName(vm).toLowerCase())));
}

function defaultIsAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function defaultKill(pid) {
    // /T: the PC script runs every VM in its own Start-Job child process
    require('child_process').execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
}

function createCloneTask(deps) {
    const {
        logFile,
        readState, writeState,
        spawn, isAlive = defaultIsAlive, kill = defaultKill,
        executeSSH, upsertVms, broadcast = () => {},
        loadLinuxContext,
        sshRetryDelayMs = 5000,
        pollMs = 10000,
        env = process.env,
        now = () => Date.now()
    } = deps;

    let timer = null;
    let poller = null;
    let finishing = null;

    const log = (text) => { try { fs.appendFileSync(logFile, text); } catch (_) {} };
    const state = () => { try { return readState() || { running: false }; } catch (_) { return { running: false }; } };
    const save = (s) => { try { writeState(s); } catch (e) { console.error('[Nutanix Clone] Saving task state failed:', e.message); } };

    function clearTimers() {
        if (timer) { clearTimeout(timer); timer = null; }
        if (poller) { clearInterval(poller); poller = null; }
    }

    function armDeadline(s) {
        const ms = Math.max(0, (s.timeoutAt || 0) - now());
        timer = setTimeout(() => {
            timer = null;
            log(`\n[Node.js Timeout] Clone task exceeded its time limit (${s.timeoutMinutes} min). Killing PowerShell process tree (PID ${s.pid})...\n`);
            save({ ...state(), timedOut: true });
            kill(s.pid);
        }, ms);
        if (timer.unref) timer.unref();
    }

    function status() {
        const s = state();
        return {
            running: !!s.running,
            startTime: s.startTime || null,
            timeoutAt: s.timeoutAt || null,
            finishedAt: s.finishedAt || null,
            vms: s.vms || [],
            result: s.result || null
        };
    }

    /**
     * Starts the PowerShell clone script. params holds the credentials and is only written to the child's stdin.
     * Throws if a task is already running or the process cannot be started.
     */
    function start({ scriptPath, params, vms, user, mode }) {
        if (state().running) throw new Error('A cloning provisioning task is currently running. Please wait for it to complete.');
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, `[${new Date(now()).toISOString()}] Starting headless Nutanix ${mode} VM provisioning...\n`, 'utf8');

        const fd = fs.openSync(logFile, 'a');
        let child;
        try {
            // Output goes straight to the log file, so the script keeps logging even while the web process restarts.
            // Not detached: a detached powershell.exe gets no console and produces no output.
            const psCmd = `& '${scriptPath.replace(/\\/g, '/').replace(/'/g, "''")}' -ParamFile '-'`;
            child = spawn('powershell.exe', ['-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
                { stdio: ['pipe', fd, fd], windowsHide: true });
        } finally {
            try { fs.closeSync(fd); } catch (_) {}
        }

        const timeoutMinutes = cloneTimeoutMinutes(vms.length, env);
        const s = {
            running: true,
            pid: child.pid || null,
            mode,
            user: user || 'SYSTEM',
            startTime: now(),
            timeoutMinutes,
            timeoutAt: now() + timeoutMinutes * 60 * 1000,
            vms
        };
        save(s);

        child.stdin.on('error', (e) => log(`\n[Node.js Process Error] Passing parameters to PowerShell failed: ${e.message}\n`));
        child.stdin.end(asciiJson(params));
        child.on('error', (err) => {
            log(`\n[Node.js Process Error] Failed to launch PowerShell: ${err.message}\n`);
            finish(null, 'launch failed');
        });
        child.on('close', (code) => finish(code));
        armDeadline(s);
        return s;
    }

    async function installLinuxSoftware(vm, ctx) {
        const ip = vmIp(vm);
        const name = vmName(vm);
        const bu = vm.BU || 'Basic';
        const software = ctx.resolveSoftware(bu);
        if (software.length === 0) {
            log(`[Linux Provisioning] VM ${name} (${ip}) - BU [${bu}]: No Linux software mapped. Skipping.\n`);
            return true;
        }
        log(`[Linux Provisioning] VM ${name} (${ip}) - BU [${bu}]: Mapped software: ${software.map(s => s.name).join(', ')}\n`);
        log(`[Linux Provisioning] VM ${name} (${ip}): Connecting to guest via SSH on port 22...\n`);

        let ready = false;
        for (let attempt = 1; attempt <= 6 && !ready; attempt++) {
            try {
                await executeSSH(ip, ctx.user, ctx.password, 'echo OK', { timeout: 10000, execTimeoutMs: 30000 });
                ready = true;
            } catch (e) {
                log(`[Linux Provisioning] VM ${name} (${ip}): SSH connection attempt ${attempt}/6 failed. Retrying in ${sshRetryDelayMs / 1000} seconds...\n`);
                if (attempt < 6) await new Promise(r => setTimeout(r, sshRetryDelayMs));
            }
        }
        if (!ready) {
            log(`[Linux Provisioning] VM ${name} (${ip}) ERROR: SSH connection timed out after VM boot ON.\n`);
            return false;
        }

        log(`[Linux Provisioning] VM ${name} (${ip}): SSH session established. Running installer commands...\n`);
        const execTimeoutMs = installTimeoutMs(env);
        const failed = [];
        for (const sw of software) {
            log(`=== Installing ${sw.name} inside ${name} ===\nRunning command: ${sw.command}\n`);
            try {
                const r = await executeSSH(ip, ctx.user, ctx.password, sw.command, { timeout: 10000, execTimeoutMs });
                log(`stdout:\n${r.stdout}\n`);
                if (r.stderr) log(`stderr:\n${r.stderr}\n`);
                log(`Exit code: ${r.code}${r.code === 0 ? '' : ' [FAILED]'}\n\n`);
                if (r.code !== 0) failed.push(sw.name);
            } catch (e) {
                log(`ERROR: ${e.message} [FAILED]\n\n`);
                failed.push(sw.name);
            }
        }
        if (failed.length) {
            log(`[Linux Provisioning] VM ${name} (${ip}): ${failed.length} of ${software.length} installation(s) failed: ${failed.join(', ')} [FAILED]\n`);
            return false;
        }
        log(`[Linux Provisioning] VM ${name} (${ip}): Software installations completed successfully! [OK]\n`);
        return true;
    }

    /** Post-processing once the PowerShell process is gone (exit code null = unknown, e.g. it died while the web restarted). */
    function finish(code, reason) {
        if (finishing) return finishing;
        finishing = (async () => {
            clearTimers();
            const s = state();
            const vms = s.vms || [];
            const timedOut = !!s.timedOut;
            log(code === null || code === undefined
                ? `\n[Node.js Task Exit] PowerShell process ended (${reason || 'exit code unknown'})\n`
                : `\n[Node.js Task Exit] PowerShell process finished with exit code ${code}\n`);

            let logText = '';
            try { logText = fs.readFileSync(logFile, 'utf8'); } catch (_) {}
            const flags = createdFlags(vms, parseCreatedMarkers(logText));
            const createdVms = vms.filter((_, i) => flags[i]);
            const notCreated = vms.filter((_, i) => !flags[i]);
            log(`\n[Summary] ${createdVms.length} of ${vms.length} VM(s) created in Nutanix.\n`);
            notCreated.forEach(vm => log(`[Summary] NOT created: ${vmName(vm)} (${vmIp(vm)}) - see the errors above. Skipped for software install and Server List.\n`));

            const linuxFailed = [];
            const linuxVms = createdVms.filter(isLinux);
            if (linuxVms.length > 0) {
                log(`\n[Linux Provisioning] ${linuxVms.length} created Linux VM(s). Initializing SSH software installation pipelines...\n`);
                let ctx = null;
                try { ctx = loadLinuxContext(); } catch (e) { log(`[Linux Provisioning] ERROR: cannot load the install settings: ${e.message}\n`); }
                for (const vm of linuxVms) {
                    const ok = ctx ? await installLinuxSoftware(vm, ctx) : false;
                    if (!ok) linuxFailed.push(vmName(vm));
                }
            }

            let registered = 0;
            if (createdVms.length > 0) {
                try {
                    registered = (upsertVms(createdVms, s.user || 'SYSTEM') || {}).count || 0;
                    log(`\n[Server List Integration] Successfully synced ${registered} VMs to Server List (CMDB).\n`);
                } catch (e) {
                    console.error('[Nutanix Clone] Error syncing to Server List:', e);
                    log(`\n[Server List Warning] Failed to auto-sync VMs to Server List: ${e.message}\n`);
                }
            }

            const result = {
                exitCode: code === undefined ? null : code,
                reason: timedOut ? 'timeout' : (reason || null),
                total: vms.length,
                created: createdVms.length,
                notCreated: notCreated.map(vmName),
                linuxInstallFailed: linuxFailed,
                registered
            };
            const success = vms.length > 0 && notCreated.length === 0 && linuxFailed.length === 0 && !timedOut;
            save({ ...s, running: false, finishedAt: now(), result: { ...result, success } });
            try { broadcast('NUTANIX_CLONE_COMPLETED', { success, ...result }); } catch (_) {}
        })().finally(() => { finishing = null; });
        return finishing;
    }

    /**
     * Startup: a task left "running" by the previous web process is either still running (watch the PID until it
     * exits, keep the deadline) or already gone (finish it now from what its log says).
     */
    function recover() {
        const s = state();
        if (!s.running) return 'idle';
        if (isAlive(s.pid)) {
            log(`\n[Node.js Recovery] Web process restarted; PowerShell (PID ${s.pid}) is still running. Watching it...\n`);
            poller = setInterval(() => { if (!isAlive(s.pid)) finish(null, 'finished while the web process was restarting'); }, pollMs);
            if (poller.unref) poller.unref();
            armDeadline(s);
            return 'watching';
        }
        finish(null, 'interrupted by a web process restart');
        return 'finished';
    }

    return { start, status, finish, recover, logFile };
}

/**
 * Deletes the plain-text parameter files (with credentials) that older versions wrote next to the scripts and only
 * removed when PowerShell exited (left behind by a restart mid-clone). Returns the deleted file names.
 */
function removeLegacyParamFiles(dir = __dirname) {
    const removed = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return removed; }
    for (const name of names) {
        if (!/^nutanix_clone_params_\d+\.json$/.test(name)) continue;
        try { fs.unlinkSync(path.join(dir, name)); removed.push(name); } catch (e) {
            console.warn(`[Nutanix] Could not delete leftover clone parameter file ${name}: ${e.message}`);
        }
    }
    return removed;
}

// The task used by routes/nutanix.js
let shared = null;
function getCloneTask() {
    if (!shared) {
        const { readDataSync, writeDataSync } = require('./db');
        const dataDir = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
        shared = createCloneTask({
            logFile: path.join(dataDir, 'logs', 'nutanix_clone.log'),
            readState: () => readDataSync(STATE_KEY, null),
            writeState: (s) => writeDataSync(STATE_KEY, s),
            spawn: require('child_process').spawn,
            executeSSH: (...a) => require('./ssh').executeSSH(...a),
            upsertVms: (vms, user) => require('../routes/serverList').upsertClonedVms(vms, user),
            broadcast: (event, payload) => require('./websocket').broadcastEvent(event, payload),
            loadLinuxContext: () => {
                const provisioningConfig = require('./provisioningConfig');
                const config = require('./envEditor').readEnv();
                const installCfg = provisioningConfig.loadInstallConfig(config);
                return {
                    user: config.LINUX_ADMIN_USER || process.env.LINUX_ADMIN_USER || 'root',
                    password: config.LINUX_ADMIN_PWD || process.env.LINUX_ADMIN_PWD || '',
                    resolveSoftware: (bu) => provisioningConfig.resolveSoftware(installCfg, bu, 'linux')
                };
            }
        });
    }
    return shared;
}

module.exports = {
    STATE_KEY,
    CREATED_MARKER,
    cloneTimeoutMinutes,
    installTimeoutMs,
    asciiJson,
    parseCreatedMarkers,
    createdFlags,
    createCloneTask,
    getCloneTask,
    removeLegacyParamFiles
};
