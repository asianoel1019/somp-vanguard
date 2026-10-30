const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requireAuth, checkFeature, checkAnyFeature, checkRole } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');


const PRESETS = [
    // System
    { id: 'p1', name: 'Check System Uptime', category: 'System', type: 'preset', winCommand: '(get-date) - (gcim Win32_OperatingSystem).LastBootUpTime', nixCommand: 'uptime -p' },
    { id: 'p2', name: 'Top 10 CPU Processes', category: 'System', type: 'preset', winCommand: 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 10', nixCommand: 'ps aux --sort=-%cpu | head -n 11' },
    { id: 'p3', name: 'Top 10 Memory Processes', category: 'System', type: 'preset', winCommand: 'Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 10', nixCommand: 'ps aux --sort=-%mem | head -n 11' },
    { id: 'p4', name: 'Check OS Version', category: 'System', type: 'preset', winCommand: '(Get-WmiObject Win32_OperatingSystem).Caption', nixCommand: 'cat /etc/os-release | grep PRETTY_NAME' },
    { id: 'p16', name: 'Shutdown / Power Off', category: 'System', type: 'preset', winCommand: 'shutdown /s /t 0', nixCommand: 'shutdown -h now' },
    { id: 'p17', name: 'Check .NET Framework Version', category: 'System', type: 'preset', winCommand: "Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP' -Recurse | Get-ItemProperty -Name version -EA 0 | Where { $_.PSChildName -Match '^(?!S)\\p{L}'} | Select PSChildName, version", nixCommand: 'dotnet --info 2>/dev/null || echo "No .NET Core installed"' },
    
    // Network
    { id: 'p5', name: 'Ping Internet (8.8.8.8)', category: 'Network', type: 'preset', winCommand: 'ping -n 4 8.8.8.8', nixCommand: 'ping -c 4 8.8.8.8' },
    { id: 'p6', name: 'Check Open/Listening Ports', category: 'Network', type: 'preset', winCommand: 'netstat -ano | findstr LISTENING', nixCommand: 'ss -tulpn | grep LISTEN' },
    { id: 'p7', name: 'Print Routing Table', category: 'Network', type: 'preset', winCommand: 'route print', nixCommand: 'ip route' },
    { id: 'p8', name: 'DNS Resolution Test (google.com)', category: 'Network', type: 'preset', winCommand: 'Resolve-DnsName google.com', nixCommand: 'dig google.com +short' },
    
    // Storage
    { id: 'p9', name: 'Disk Space Overview', category: 'Storage', type: 'preset', winCommand: "Get-Volume | Select-Object DriveLetter, FileSystemLabel, @{Name='Size(GB)';Expression={[math]::round($_.Size/1GB,2)}}, @{Name='Free(GB)';Expression={[math]::round($_.SizeRemaining/1GB,2)}} | Format-Table -AutoSize", nixCommand: 'df -h' },
    { id: 'p10', name: 'Top 10 Largest Directories', category: 'Storage', type: 'preset', winCommand: 'Get-ChildItem C:\\ -Directory -ErrorAction SilentlyContinue | Sort-Object length -Descending | Select-Object -First 10', nixCommand: 'du -sh /* 2>/dev/null | sort -hr | head -n 10' },
    
    // Logs & Services
    { id: 'p11', name: 'List Running Services', category: 'Logs & Services', type: 'preset', winCommand: "Get-Service | Where-Object Status -eq 'Running'", nixCommand: 'systemctl list-units --type=service --state=running' },
    { id: 'p12', name: 'Tail System Logs (Last 20 lines)', category: 'Logs & Services', type: 'preset', winCommand: 'Get-EventLog -LogName System -Newest 20 | Format-Table -AutoSize', nixCommand: 'tail -n 20 /var/log/syslog 2>/dev/null || tail -n 20 /var/log/messages' },
    
    // Users & Misc
    { id: 'p13', name: 'Show Logged In Users', category: 'Users & Misc', type: 'preset', winCommand: 'query user', nixCommand: 'who' },
    { id: 'p14', name: 'Check System Date & Time', category: 'Users & Misc', type: 'preset', winCommand: 'Get-Date', nixCommand: 'date' },
    { id: 'p15', name: 'List Environment Variables', category: 'Users & Misc', type: 'preset', winCommand: 'Get-ChildItem Env:', nixCommand: 'printenv' }
];

const { readDataSync, writeDataSync } = require('../lib/db');

function loadCustomCommands() {
    return readDataSync('service_platform/cmd_library.json', []);
}

function saveCustomCommands(cmds) {
    writeDataSync('service_platform/cmd_library.json', cmds);
}

// GET all commands (presets + custom)
// Callers: Remote Command (read + save / delete) and SOP Runbook (read only)
router.get('/', requireAuth, checkAnyFeature('remoteCmd', 'runbook'), (req, res) => {
    try {
        const custom = loadCustomCommands();
        res.json({ success: true, commands: [...PRESETS, ...custom] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

const MAX_NAME_LENGTH = 100;
const MAX_COMMAND_LENGTH = 20000;
const optionalText = (v) => v === undefined || v === null || typeof v === 'string';

// POST new custom command: changing the shared library (also used by SOP Runbook) is Operator / SuperAdmin only
router.post('/', requireAuth, checkFeature('remoteCmd'), checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const { name, category, winCommand, nixCommand } = req.body || {};
        if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ success: false, error: 'Name is required' });
        if (name.trim().length > MAX_NAME_LENGTH) return res.status(400).json({ success: false, error: `Name may be at most ${MAX_NAME_LENGTH} characters` });
        if (![category, winCommand, nixCommand].every(optionalText)) return res.status(400).json({ success: false, error: 'category / winCommand / nixCommand must be strings' });
        if ((winCommand || '').length > MAX_COMMAND_LENGTH || (nixCommand || '').length > MAX_COMMAND_LENGTH) {
            return res.status(400).json({ success: false, error: `A command may be at most ${MAX_COMMAND_LENGTH} characters` });
        }
        if (!(winCommand || '').trim() && !(nixCommand || '').trim()) return res.status(400).json({ success: false, error: 'Enter a Windows or Linux command' });

        const custom = loadCustomCommands();
        const newCmd = {
            id: 'c_' + Date.now(),
            name: name.trim(),
            category: (category || '').trim().slice(0, MAX_NAME_LENGTH) || 'Custom',
            type: 'custom',
            winCommand: winCommand || '',
            nixCommand: nixCommand || '',
            createdBy: req.user?.username || ''
        };

        custom.push(newCmd);
        saveCustomCommands(custom);
        auditLog(req.user?.username || 'system', 'Command Library', `Added custom command "${newCmd.name}" (${newCmd.id}) | Win: [${newCmd.winCommand || 'N/A'}] | Lin: [${newCmd.nixCommand || 'N/A'}]`);

        res.json({ success: true, command: newCmd });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// DELETE custom command (Operator / SuperAdmin); presets cannot be deleted
router.delete('/:id', requireAuth, checkFeature('remoteCmd'), checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const id = req.params.id;
        const custom = loadCustomCommands();
        const target = custom.find(c => c.id === id);
        if (!target) return res.status(404).json({ success: false, error: 'Custom command not found' });
        saveCustomCommands(custom.filter(c => c.id !== id));
        auditLog(req.user?.username || 'system', 'Command Library', `Deleted custom command "${target.name}" (${id}) | Win: [${target.winCommand || 'N/A'}] | Lin: [${target.nixCommand || 'N/A'}]`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.PRESETS = PRESETS;
module.exports = router;
