const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const net = require('net');
const { executeSSH } = require('../lib/ssh');
const { runPowerShell } = require('../lib/powershell');
const { appendLog } = require('../lib/logger');

const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const TASKS_FILE = path.join(BASE_DATA_DIR, 'server_operation', 'scheduler_tasks.json');

let schedulerInterval = null;
let lastTickMinute = -1;

function matchCronField(field, value) {
    if (field === '*') return true;
    
    const parts = field.split(',');
    for (const part of parts) {
        if (part.includes('/')) {
            const [range, stepStr] = part.split('/');
            const step = parseInt(stepStr, 10);
            let start = 0;
            let end = 59;
            if (range !== '*') {
                if (range.includes('-')) {
                    const [rStart, rEnd] = range.split('-');
                    start = parseInt(rStart, 10);
                    end = parseInt(rEnd, 10);
                } else {
                    start = parseInt(range, 10);
                }
            }
            if (value >= start && value <= end && (value - start) % step === 0) {
                return true;
            }
        } else if (part.includes('-')) {
            const [rStart, rEnd] = part.split('-');
            const start = parseInt(rStart, 10);
            const end = parseInt(rEnd, 10);
            if (value >= start && value <= end) {
                return true;
            }
        } else {
            if (parseInt(part, 10) === value) {
                return true;
            }
        }
    }
    return false;
}

function matchesCron(cronExpression, date) {
    try {
        const fields = cronExpression.trim().split(/\s+/);
        if (fields.length < 5) return false;
        
        let minutes, hours, dom, month, dow;
        let cronMin, cronHour, cronDom, cronMonth, cronDow;
        
        if (fields.length === 6) {
            const seconds = date.getSeconds();
            if (!matchCronField(fields[0], seconds)) return false;
            
            minutes = date.getMinutes();
            hours = date.getHours();
            dom = date.getDate();
            month = date.getMonth() + 1;
            dow = date.getDay();
            
            cronMin = fields[1];
            cronHour = fields[2];
            cronDom = fields[3];
            cronMonth = fields[4];
            cronDow = fields[5];
        } else {
            minutes = date.getMinutes();
            hours = date.getHours();
            dom = date.getDate();
            month = date.getMonth() + 1;
            dow = date.getDay();
            
            cronMin = fields[0];
            cronHour = fields[1];
            cronDom = fields[2];
            cronMonth = fields[3];
            cronDow = fields[4];
        }
        
        if (cronDow === '7') cronDow = '0';
        if (dow === 7) dow = 0;

        return matchCronField(cronMin, minutes) &&
               matchCronField(cronHour, hours) &&
               matchCronField(cronDom, dom) &&
               matchCronField(cronMonth, month) &&
               matchCronField(cronDow, dow);
    } catch (e) {
        console.error('[Scheduler Service] Error matching cron expression:', e);
        return false;
    }
}

// Tasks and logs are written by this process AND the other one (cron in the worker, "Run now" in the web):
// every write is an atomic read-modify-write through lib/schedulerStore.js
const schedulerStore = require('../lib/schedulerStore');

// Helper to read tasks
function getTasks() {
    return schedulerStore.readTasks();
}

// Helper to append execution logs
function appendExecutionLog(taskId, taskName, runStatus, stdout, stderr, durationMs) {
    try {
        const newLog = {
            id: Date.now().toString(),
            taskId,
            taskName,
            runTime: new Date().toISOString(),
            runStatus, // 'Success' or 'Failed'
            stdout: stdout || 'No stdout returned.',
            stderr: stderr || 'No stderr returned.',
            executionTimeMs: durationMs
        };
        schedulerStore.appendLog(newLog);
    } catch (e) {
        console.error('Failed to write execution logs:', e);
    }
}

// Update task execution status in tasks list
function updateTaskRunMeta(taskId, statusStr) {
    try {
        // only this task's run fields are changed, on the CURRENT list (an edit made during the run is kept)
        const found = schedulerStore.mutateTasks((tasks) => {
            const idx = tasks.findIndex(t => t.id === taskId);
            if (idx === -1) return false;
            tasks[idx].lastRunTime = new Date().toISOString();
            tasks[idx].lastRunStatus = statusStr;
            return true;
        }, { reason: 'task run metadata' });
        if (found) {
            try {
                const { broadcastEvent } = require('../lib/websocket');
                broadcastEvent('TASK_COMPLETED', { taskId, statusStr });
            } catch(e) {}
        }
    } catch (e) {
        console.error('[TaskScheduler] Failed to update task run metadata:', e);
    }
}

// Fast TCP port checker for OS detection
function checkPort(host, port, timeout = 1500) {
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
            socket.destroy();
            resolve(false);
        });
        socket.connect(port, host);
    });
}

// Remote SSH execution helper for Linux commands
async function runSSHCommand(host, user, password, command) {
    try {
        return await executeSSH(host, user, password, command);
    } catch (err) {
        return { success: false, stderr: `SSH Connection Error: ${err.message}` };
    }
}

// Core execution engine routing
async function executeTask(task) {
    const startTime = Date.now();
    appendLog(`[Scheduler Service] Starting task: ${task.name}`);
    
    let stdout = '';
    let stderr = '';
    let isSuccess = true;

    try {
        if (task.targetType === 'local_ps') {
            // 1. Local PowerShell execution
            if (!task.winCommand) throw new Error('No PowerShell command specified.');
            stdout = await runPowerShell(task.winCommand);
        } else if (task.targetType === 'remote_linux_ssh') {
            // 2. Remote Linux SSH command
            if (!task.nixCommand) throw new Error('No Linux Shell command specified.');
            if (task.targets.length === 0) throw new Error('No target IP hosts configured.');
            
            const sshUser = process.env.LINUX_ADMIN_USER || 'admin';
            const sshPass = process.env.LINUX_ADMIN_PWD || '';

            const results = [];
            for (const ip of task.targets) {
                const res = await runSSHCommand(ip, sshUser, sshPass, task.nixCommand);
                results.push(`[Host: ${ip}] ${res.success ? 'SUCCESS' : 'FAILED'}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
                if (!res.success) isSuccess = false;
            }
            stdout = results.join('\n\n');
        } else if (task.targetType === 'remote_windows_cmd') {
            // 3. Remote Windows Command Execution via CIM Session
            if (!task.winCommand) throw new Error('No Windows command specified.');
            if (task.targets.length === 0) throw new Error('No target IP hosts configured.');

            const adUser = process.env.AD_ADMIN_USER || '';
            const adPass = process.env.AD_ADMIN_PWD || '';
            const domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim();

            const b64WinCmd = Buffer.from(task.winCommand, 'utf16le').toString('base64');
            const results = [];
            for (const ip of task.targets) {
                let script = '';
                if (adUser && adPass) {
                    const safePass = adPass.replace(/'/g, "''");
                    script += `
                        $secPass = ConvertTo-SecureString '${safePass}' -AsPlainText -Force;
                        $cred = New-Object System.Management.Automation.PSCredential ('${domain}\\${adUser}', $secPass);
                        $opt = New-CimSessionOption -Protocol Dcom;
                        $sess = New-CimSession -ComputerName "${ip}" -Credential $cred -SessionOption $opt -ErrorAction Stop;
                        Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -EncodedCommand ${b64WinCmd}' } -CimSession $sess;
                        Remove-CimSession $sess;
                    `;
                } else {
                    script += `
                        $opt = New-CimSessionOption -Protocol Dcom;
                        $sess = New-CimSession -ComputerName "${ip}" -SessionOption $opt -ErrorAction Stop;
                        Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -EncodedCommand ${b64WinCmd}' } -CimSession $sess;
                        Remove-CimSession $sess;
                    `;
                }

                try {
                    const res = await runPowerShell(script);
                    results.push(`[Host: ${ip}] Triggered WMI process creation.\nOutput:\n${res}`);
                } catch (e) {
                    isSuccess = false;
                    results.push(`[Host: ${ip}] Failed: ${e.message}`);
                }
            }
            stdout = results.join('\n\n');
        } else if (task.targetType === 'remote_windows_task') {
            // 4. Remote Windows Task Scheduler Registration (Deploy permanent remote task)
            if (!task.winCommand) throw new Error('No Task executable command specified.');
            if (task.targets.length === 0) throw new Error('No target hosts configured to deploy scheduler.');

            const adUser = process.env.AD_ADMIN_USER || '';
            const adPass = process.env.AD_ADMIN_PWD || '';
            const domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim();
            const time = task.executeAt || '09:00';
            const today = new Date().toISOString().split('T')[0];

            const b64WinCmd = Buffer.from(task.winCommand, 'utf16le').toString('base64');
            const results = [];
            for (const ip of task.targets) {
                let script = '';
                if (adUser && adPass) {
                    const safePass = adPass.replace(/'/g, "''");
                    const domainUser = domain ? `${domain}\\${adUser}` : adUser;
                    script += `
                        $secPass = ConvertTo-SecureString '${safePass}' -AsPlainText -Force;
                        $cred = New-Object System.Management.Automation.PSCredential ('${domain}\\${adUser}', $secPass);
                        $opt = New-CimSessionOption -Protocol Dcom;
                        $sess = New-CimSession -ComputerName "${ip}" -Credential $cred -SessionOption $opt -ErrorAction Stop;
                        $action = New-CimInstance -ClassName MSFT_TaskAction -Property @{ Execute = 'powershell.exe'; Arguments = '-WindowStyle Hidden -EncodedCommand ${b64WinCmd}' } -ClientSide;
                        $trigger = New-CimInstance -ClassName MSFT_TaskTrigger -Property @{ Enabled = $True; StartBoundary = "${today}T${time}:00" } -ClientSide;
                        Register-ScheduledTask -TaskName "${task.name.replace(/"/g, '`"')}" -Action $action -Trigger $trigger -User '${domainUser}' -Password '${safePass}' -CimSession $sess -Force;
                        Remove-CimSession $sess;
                    `;
                } else {
                    script += `
                        $opt = New-CimSessionOption -Protocol Dcom;
                        $sess = New-CimSession -ComputerName "${ip}" -SessionOption $opt -ErrorAction Stop;
                        $action = New-CimInstance -ClassName MSFT_TaskAction -Property @{ Execute = 'powershell.exe'; Arguments = '-WindowStyle Hidden -EncodedCommand ${b64WinCmd}' } -ClientSide;
                        $trigger = New-CimInstance -ClassName MSFT_TaskTrigger -Property @{ Enabled = $True; StartBoundary = "${today}T${time}:00" } -ClientSide;
                        Register-ScheduledTask -TaskName "${task.name.replace(/"/g, '`"')}" -Action $action -Trigger $trigger -CimSession $sess -Force;
                        Remove-CimSession $sess;
                    `;
                }

                try {
                    const out = await runPowerShell(script);
                    results.push(`[Host: ${ip}] Successfully registered permanent Windows Task Scheduler: ${task.name}.\nOutput:\n${out}`);
                } catch (e) {
                    isSuccess = false;
                    results.push(`[Host: ${ip}] Failed to register task: ${e.message}`);
                }
            }
            stdout = results.join('\n\n');
        } else if (task.targetType === 'remote_auto_cmd') {
            // 5. Intelligent Remote Command with Auto OS routing (Windows WMI + Linux SSH)
            if (!task.winCommand && !task.nixCommand) throw new Error('At least one command (Windows or Linux) must be configured.');
            if (task.targets.length === 0) throw new Error('No target IP hosts configured.');

            const adUser = process.env.AD_ADMIN_USER || '';
            const adPass = process.env.AD_ADMIN_PWD || '';
            const domain = (process.env.ALLOWED_AD_DOMAIN || '').replace(/['"]/g, '').trim();
            const sshUser = process.env.LINUX_ADMIN_USER || 'admin';
            const sshPass = process.env.LINUX_ADMIN_PWD || '';

            const results = [];
            for (const ip of task.targets) {
                // Detect OS via fast parallel port probing (5985 for WinRM, 9182 for Windows exporter, 445 for SMB)
                const checks = await Promise.all([
                    checkPort(ip, 5985),
                    checkPort(ip, 9182),
                    checkPort(ip, 445)
                ]);
                const isWindows = checks.includes(true);
                
                if (isWindows) {
                    if (!task.winCommand) {
                        results.push(`[Host: ${ip}] Detected Windows. Skipped (No Windows command configured).`);
                        continue;
                    }
                    const b64WinCmd = Buffer.from(task.winCommand, 'utf16le').toString('base64');
                    let script = '';
                    if (adUser && adPass) {
                        const safePass = adPass.replace(/'/g, "''");
                        script += `
                            $secPass = ConvertTo-SecureString '${safePass}' -AsPlainText -Force;
                            $cred = New-Object System.Management.Automation.PSCredential ('${domain}\\${adUser}', $secPass);
                            $opt = New-CimSessionOption -Protocol Dcom;
                            $sess = New-CimSession -ComputerName "${ip}" -Credential $cred -SessionOption $opt -ErrorAction Stop;
                            Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -EncodedCommand ${b64WinCmd}' } -CimSession $sess;
                            Remove-CimSession $sess;
                        `;
                    } else {
                        script += `
                            $opt = New-CimSessionOption -Protocol Dcom;
                            $sess = New-CimSession -ComputerName "${ip}" -SessionOption $opt -ErrorAction Stop;
                            Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -EncodedCommand ${b64WinCmd}' } -CimSession $sess;
                            Remove-CimSession $sess;
                        `;
                    }
                    try {
                        const res = await runPowerShell(script);
                        results.push(`[Host: ${ip}] Detected Windows. Triggered WMI process creation.\nOutput:\n${res}`);
                    } catch (e) {
                        isSuccess = false;
                        results.push(`[Host: ${ip}] Detected Windows. Failed WMI execution: ${e.message}`);
                    }
                } else {
                    // Linux
                    if (!task.nixCommand) {
                        results.push(`[Host: ${ip}] Detected Linux. Skipped (No Linux command configured).`);
                        continue;
                    }
                    const res = await runSSHCommand(ip, sshUser, sshPass, task.nixCommand);
                    results.push(`[Host: ${ip}] Detected Linux. SSH Execution ${res.success ? 'SUCCESS' : 'FAILED'}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
                    if (!res.success) isSuccess = false;
                }
            }
            stdout = results.join('\n\n');
        }
    } catch (err) {
        isSuccess = false;
        stderr = err.message;
    }

    const duration = Date.now() - startTime;
    const finalStatus = isSuccess ? 'Success' : 'Failed';
    
    appendExecutionLog(task.id, task.name, finalStatus, stdout, stderr, duration);
    updateTaskRunMeta(task.id, finalStatus);
    
    appendLog(`[Scheduler Service] Finished task: ${task.name} with status: ${finalStatus}`);
}

// Manual one-click instant run in background
async function triggerTaskExecution(taskId) {
    const tasks = getTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) throw new Error('Task not found');
    
    // Non-blocking trigger in background thread tick
    setTimeout(() => {
        executeTask(task).catch(e => console.error('[Scheduler Service Exception]', e));
    }, 0);
}

// Dynamic Cron scheduler reload
function reloadScheduler() {
    appendLog('[Scheduler Service] Reloading scheduled tasks...');
    
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
    }

    const isEnabled = process.env.APP_ENABLE_SCHEDULER !== 'false';
    if (!isEnabled) {
        appendLog('[Scheduler Service] Scheduler module is disabled in configuration.');
        return;
    }

    const tasks = getTasks();
    const activeTasks = tasks.filter(t => t.status === 'active');
    
    activeTasks.forEach(task => {
        if (!cron.validate(task.cronExpression)) {
            console.error(`[Scheduler Service] Invalid cron expression: "${task.cronExpression}" for task: ${task.name}`);
            return;
        }
        appendLog(`[Scheduler Service] Registered task: "${task.name}" with Cron: "${task.cronExpression}"`);
    });

    lastTickMinute = new Date().getMinutes(); // Prevent duplicate runs in the same minute upon reload
    
    schedulerInterval = setInterval(() => {
        const now = new Date();
        const currentM = now.getMinutes();
        
        if (currentM !== lastTickMinute) {
            lastTickMinute = currentM;
            
            // Re-fetch current tasks from file to ensure we execute with up-to-date configs
            const currentTasks = getTasks();
            const currentActive = currentTasks.filter(t => t.status === 'active');
            
            currentActive.forEach(task => {
                if (cron.validate(task.cronExpression) && matchesCron(task.cronExpression, now)) {
                    appendLog(`[Scheduler Service] Local cron match for task "${task.name}" (${task.cronExpression}). Triggering execution.`);
                    executeTask(task).catch(e => console.error(`[Scheduler Job Error] ${task.name}`, e));
                }
            });
        }
    }, 10000); // Probe every 10 seconds, identical to inventoryScheduler
}

// Main initialization call
function initTaskScheduler() {
    reloadScheduler();
}

module.exports = {
    initTaskScheduler,
    reloadScheduler,
    triggerTaskExecution
};
