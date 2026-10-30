const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../services/scoutDb');
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');

// Mounted at /api/monitor/forensics BEFORE /api/monitor, so it never passed the Scout Monitor gate.
// Only Live Event Viewer -> On-Demand Forensics (OnDemandForensics.jsx) calls the session endpoints
// -> 'monitorWinEvent'. POST /upload is the Scout agent's upload (apiKey + taskId, no session) and is skipped.
const forensicsGate = [requireAuth, checkFeature('monitorWinEvent')];
const isAgentUpload = (req) => req.method === 'POST' && /^\/upload\/?$/i.test(req.path);
router.use((req, res, next) => {
    if (isAgentUpload(req)) return next();
    return forensicsGate[0](req, res, () => forensicsGate[1](req, res, next));
});

// Helper to parse JSON safely
function parseJSON(val, def) {
    if (!val) return def;
    try { return JSON.parse(val); } catch(e) { return def; }
}

// Common Threat Analysis Engine
function runThreatAnalysis(winLogs, linLogs) {
    const report = {
        scanTime: new Date().toISOString(),
        totalLogsAnalyzed: winLogs.length + linLogs.length,
        threatCounts: {
            critical: 0,
            high: 0,
            warning: 0,
            failedLogons: 0,
            suspiciousCmds: 0,
            privilegeChanges: 0
        },
        riskScore: 0,
        riskLevel: 'CLEAN', // 'CLEAN' | 'LOW' | 'ELEVATED' | 'CRITICAL'
        riskColor: '#10b981',
        mitreDomains: {
            'Initial Access': 0,
            'Execution': 0,
            'Persistence': 0,
            'Privilege Escalation': 0,
            'Defense Evasion': 0,
            'Credential Access': 0,
            'Discovery': 0,
            'Lateral Movement': 0,
            'Impact': 0
        },
        logonSummary: {
            success: 0,
            failure: 0,
            users: {},
            ips: {},
            topBruteTarget: null
        },
        privilegeEvents: [],
        suspiciousIndicators: [],
        timeline: [], // Attack Chain Timeline: sorted chronological events
        recommendations: [] // Actionable guidance
    };

    const timelineEvents = [];

    // Detailed Threat Signatures & Rules for Windows
    const MITRE_WIN = {
        '4624': 'Initial Access',
        '4625': 'Credential Access',
        '4648': 'Lateral Movement',
        '4720': 'Persistence',
        '4722': 'Persistence',
        '4724': 'Credential Access',
        '4732': 'Privilege Escalation',
        '4738': 'Persistence',
        '4776': 'Credential Access',
        '1102': 'Defense Evasion',
        '104': 'Defense Evasion',
        '4698': 'Execution',
        '7045': 'Lateral Movement',
        '4697': 'Lateral Movement',
        '4104': 'Execution'
    };

    winLogs.forEach(log => {
        const idStr = String(log.eventID);
        const msg = String(log.message || '').toLowerCase();
        const rawObj = parseJSON(log.raw, {});

        // Threat Severity Counts
        if (log.level === 'Error' || log.level === 'Critical') report.threatCounts.critical++;
        if (log.level === 'Warning') report.threatCounts.warning++;

        // MITRE Mapping
        if (MITRE_WIN[idStr]) {
            report.mitreDomains[MITRE_WIN[idStr]]++;
        }

        // Logon Analysis
        if (log.eventID === 4624) {
            report.logonSummary.success++;
            const targetUser = rawObj.TargetUserName || rawObj.SubjectUserName || '-';
            const ipAddress = rawObj.IpAddress || '-';
            if (targetUser && targetUser !== '-' && targetUser !== 'SYSTEM' && targetUser !== 'LOCAL SERVICE' && targetUser !== 'NETWORK SERVICE') {
                report.logonSummary.users[targetUser] = (report.logonSummary.users[targetUser] || 0) + 1;
            }
            if (ipAddress && ipAddress !== '-' && ipAddress !== '127.0.0.1' && ipAddress !== '::1') {
                report.logonSummary.ips[ipAddress] = (report.logonSummary.ips[ipAddress] || 0) + 1;
            }
        } else if (log.eventID === 4625) {
            report.logonSummary.failure++;
            report.threatCounts.failedLogons++;
            const targetUser = rawObj.TargetUserName || '-';
            const ipAddress = rawObj.IpAddress || '-';
            if (targetUser && targetUser !== '-') {
                report.logonSummary.users[targetUser] = (report.logonSummary.users[targetUser] || 0) + 1;
            }
            if (ipAddress && ipAddress !== '-' && ipAddress !== '127.0.0.1' && ipAddress !== '::1') {
                report.logonSummary.ips[ipAddress] = (report.logonSummary.ips[ipAddress] || 0) + 1;
            }
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'Warning',
                stage: 'Credential Access',
                tactic: 'Brute Force / Logon Failure',
                title: `Failed Logon for user "${targetUser}"`,
                details: `Source IP: ${ipAddress} | Event ID 4625`,
                source: 'Windows Security'
            });
        }

        // Account & Privilege Escalation Events
        if ([4720, 4722, 4724, 4732, 4738].includes(log.eventID)) {
            report.threatCounts.privilegeChanges++;
            const evType = log.eventID === 4720 ? 'New User Account Created'
                : log.eventID === 4722 ? 'User Account Enabled'
                : log.eventID === 4724 ? 'User Password Reset Attempt'
                : log.eventID === 4732 ? 'User Added to Admin/Privileged Group'
                : 'User Account Modified';
            
            report.privilegeEvents.push({
                timestamp: log.timestamp,
                type: evType,
                details: `Event ID ${log.eventID}: ${log.message}`
            });

            timelineEvents.push({
                timestamp: log.timestamp,
                severity: [4732, 4720].includes(log.eventID) ? 'High' : 'Medium',
                stage: log.eventID === 4732 ? 'Privilege Escalation' : 'Persistence',
                tactic: evType,
                title: evType,
                details: log.message,
                source: 'Windows Security'
            });
        }

        // Defense Evasion: Log Clearing
        if ([1102, 104].includes(log.eventID) || msg.includes('wevtutil cl') || msg.includes('wevtutil.exe cl')) {
            report.threatCounts.critical++;
            report.mitreDomains['Defense Evasion']++;
            report.suspiciousIndicators.push({
                timestamp: log.timestamp,
                source: 'Windows Security',
                indicator: 'Security/System Event Log Cleared (Tampering)',
                severity: 'Critical',
                details: log.message
            });
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'Critical',
                stage: 'Defense Evasion',
                tactic: 'Log Clearing / Indicator Removal',
                title: 'Audit Log Cleared by Administrator or Attacker',
                details: `Event ID ${log.eventID}: ${log.message}`,
                source: 'Windows Event'
            });
        }

        // Lateral Movement: Service Creation (PsExec / Remote Service)
        if ([7045, 4697].includes(log.eventID) || msg.includes('psexec') || msg.includes('paexec')) {
            report.threatCounts.high++;
            report.mitreDomains['Lateral Movement']++;
            report.suspiciousIndicators.push({
                timestamp: log.timestamp,
                source: 'Windows System / Security',
                indicator: 'Remote Service Installation / PsExec Activity',
                severity: 'High',
                details: log.message
            });
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'High',
                stage: 'Lateral Movement',
                tactic: 'Service Execution / Remote Tool',
                title: 'New Service Installed or PsExec Detected',
                details: log.message,
                source: 'Windows System'
            });
        }

        // Ransomware & System Tampering Patterns
        if (msg.includes('vssadmin delete shadows') || msg.includes('wbadmin delete catalog') || msg.includes('bcdedit /set') || msg.includes('disable-realtime') || msg.includes('set-mppreference')) {
            report.threatCounts.critical++;
            report.mitreDomains['Impact']++;
            report.mitreDomains['Defense Evasion']++;
            report.suspiciousIndicators.push({
                timestamp: log.timestamp,
                source: 'Windows CLI / Powershell',
                indicator: 'Ransomware / Shadow Deletion / Antivirus Disabling',
                severity: 'Critical',
                details: log.message
            });
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'Critical',
                stage: 'Impact',
                tactic: 'Inhibit System Recovery / Ransomware Pre-cursor',
                title: 'Shadow Copy Deletion or Defender Tampering',
                details: log.message,
                source: 'Windows CLI'
            });
        }

        // Credential Dumping (Mimikatz / LSASS Dump / NTDS)
        if (msg.includes('mimikatz') || msg.includes('sekurlsa') || (msg.includes('procdump') && msg.includes('lsass')) || msg.includes('ntdsutil') || msg.includes('samkey') || msg.includes('comsvcs.dll')) {
            report.threatCounts.critical++;
            report.mitreDomains['Credential Access']++;
            report.suspiciousIndicators.push({
                timestamp: log.timestamp,
                source: 'Windows Process / PowerShell',
                indicator: 'LSASS Memory Dump / Credential Stealing Tool',
                severity: 'Critical',
                details: log.message
            });
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'Critical',
                stage: 'Credential Access',
                tactic: 'OS Credential Dumping',
                title: 'Credential Stealing / LSASS Memory Access Detected',
                details: log.message,
                source: 'Windows Process'
            });
        }

        // Execution: Suspicious PowerShell / Encoded Commands
        if (msg.includes('-enc ') || msg.includes('-encodedcommand') || msg.includes('downloadstring') || msg.includes('iex(') || msg.includes('invoke-expression')) {
            report.threatCounts.suspiciousCmds++;
            report.threatCounts.high++;
            report.mitreDomains['Execution']++;
            report.suspiciousIndicators.push({
                timestamp: log.timestamp,
                source: 'PowerShell Execution',
                indicator: 'Encoded / Fileless PowerShell Script Execution',
                severity: 'High',
                details: log.message
            });
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'High',
                stage: 'Execution',
                tactic: 'Command and Scripting Interpreter',
                title: 'Obfuscated / Download-Execute PowerShell Command',
                details: log.message,
                source: 'PowerShell'
            });
        }

        // Reconnaissance / Discovery
        if (msg.includes('nltest') || msg.includes('net group "domain admins"') || msg.includes('whoami /priv') || msg.includes('klist')) {
            report.mitreDomains['Discovery']++;
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'Info',
                stage: 'Discovery',
                tactic: 'Domain / Account Discovery',
                title: 'Active Reconnaissance Command Executed',
                details: log.message,
                source: 'Windows CLI'
            });
        }
    });

    // Detailed Threat Signatures & Rules for Linux
    linLogs.forEach(log => {
        const msg = String(log.message || '').toLowerCase();

        // Logon Analysis (SSH logins)
        if (msg.includes('accepted password') || msg.includes('accepted publickey')) {
            report.logonSummary.success++;
            const match = msg.match(/for (\S+) from (\S+)/);
            if (match) {
                const user = match[1];
                const ip = match[2];
                report.logonSummary.users[user] = (report.logonSummary.users[user] || 0) + 1;
                report.logonSummary.ips[ip] = (report.logonSummary.ips[ip] || 0) + 1;
            }
        } else if (msg.includes('failed password') || msg.includes('authentication failure') || msg.includes('invalid user')) {
            report.logonSummary.failure++;
            report.threatCounts.failedLogons++;
            report.mitreDomains['Credential Access']++;
            const match = msg.match(/for (?:invalid user )?(\S+) from (\S+)/);
            if (match) {
                const user = match[1];
                const ip = match[2];
                report.logonSummary.users[user] = (report.logonSummary.users[user] || 0) + 1;
                report.logonSummary.ips[ip] = (report.logonSummary.ips[ip] || 0) + 1;
            }
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'Warning',
                stage: 'Credential Access',
                tactic: 'SSH Brute Force Attempt',
                title: `SSH Login Failure: ${msg.slice(0, 100)}`,
                details: log.message,
                source: 'Linux Auth'
            });
        }

        // Privilege Escalation (Sudo / SU)
        if (msg.includes('sudo:') || msg.includes('pam_unix(sudo:session): session opened') || msg.includes('su: pam_unix(su:session): session opened')) {
            report.mitreDomains['Privilege Escalation']++;
            report.threatCounts.privilegeChanges++;
            report.privilegeEvents.push({
                timestamp: log.timestamp,
                type: 'Linux Sudo / Root Switch',
                details: log.message
            });
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'Medium',
                stage: 'Privilege Escalation',
                tactic: 'Sudo / Root Privilege Elevation',
                title: 'Elevated Command Executed via Sudo',
                details: log.message,
                source: 'Linux Syslog'
            });
        }

        // Account Management & Persistence
        if (msg.includes('useradd') || msg.includes('groupadd') || msg.includes('usermod') || msg.includes('passwd: password changed') || msg.includes('crontab -e')) {
            report.mitreDomains['Persistence']++;
            report.threatCounts.privilegeChanges++;
            report.privilegeEvents.push({
                timestamp: log.timestamp,
                type: 'Linux Account/Cron Modification',
                details: log.message
            });
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'High',
                stage: 'Persistence',
                tactic: 'Account or Scheduled Job Modification',
                title: 'Linux User/Group or Crontab Modified',
                details: log.message,
                source: 'Linux Syslog'
            });
        }

        // Defense Evasion & Service Crash / SELinux Denials
        if (msg.includes('avc:  denied') || msg.includes('segfault at') || msg.includes('iptables -f') || msg.includes('ufw disable') || msg.includes('setenforce 0')) {
            report.threatCounts.critical++;
            report.mitreDomains['Defense Evasion']++;
            report.suspiciousIndicators.push({
                timestamp: log.timestamp,
                source: 'Linux Kernel / Auditd',
                indicator: 'SELinux Denial / Security Disabling / Core Segfault',
                severity: 'Critical',
                details: log.message
            });
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'Critical',
                stage: 'Defense Evasion',
                tactic: 'Disable Security Controls / Exploit Attempt',
                title: 'Security Control Disabled or Segmentation Fault',
                details: log.message,
                source: 'Linux Kernel'
            });
        }

        // Reverse Shells, Network Scanners & Web Delivery
        if ((msg.includes('curl ') && (msg.includes('| sh') || msg.includes('| bash') || msg.includes('| python'))) ||
            (msg.includes('wget ') && (msg.includes('| sh') || msg.includes('| bash'))) ||
            msg.includes('/dev/tcp/') || msg.includes('nc -e') || msg.includes('ncat -e') || msg.includes('nmap') || msg.includes('masscan') || msg.includes('hydra')) {
            report.threatCounts.suspiciousCmds++;
            report.threatCounts.critical++;
            report.mitreDomains['Execution']++;
            report.suspiciousIndicators.push({
                timestamp: log.timestamp,
                source: 'Linux Shell / Process',
                indicator: 'Remote Shell / Scanner / Web-Pipe Execution',
                severity: 'Critical',
                details: log.message
            });
            timelineEvents.push({
                timestamp: log.timestamp,
                severity: 'Critical',
                stage: 'Execution',
                tactic: 'Reverse Shell / Automated Scanner',
                title: 'Suspicious Web Pipe Execution or Reverse Shell',
                details: log.message,
                source: 'Linux Shell'
            });
        }
    });

    // Sort timeline chronologically
    report.timeline = timelineEvents.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Calculate Top Brute Target
    const userEntries = Object.entries(report.logonSummary.users);
    if (userEntries.length > 0) {
        userEntries.sort((a, b) => b[1] - a[1]);
        report.logonSummary.topBruteTarget = userEntries[0][0];
    }

    // Calculate Host Risk Score (0 - 100)
    let score = 0;
    score += Math.min(50, report.threatCounts.critical * 25);
    score += Math.min(25, (report.threatCounts.high || 0) * 10);
    score += Math.min(20, report.threatCounts.suspiciousCmds * 10);
    if (report.threatCounts.failedLogons >= 10) score += 15;
    else if (report.threatCounts.failedLogons >= 3) score += 8;
    if (report.privilegeEvents.length >= 3) score += 15;
    else if (report.privilegeEvents.length >= 1) score += 5;

    report.riskScore = Math.min(100, Math.max(0, score));

    if (report.riskScore >= 75) {
        report.riskLevel = 'CRITICAL';
        report.riskColor = '#ef4444';
    } else if (report.riskScore >= 45) {
        report.riskLevel = 'ELEVATED';
        report.riskColor = '#f59e0b';
    } else if (report.riskScore >= 20) {
        report.riskLevel = 'LOW';
        report.riskColor = '#3b82f6';
    } else {
        report.riskLevel = 'CLEAN';
        report.riskColor = '#10b981';
    }

    // Dynamic Remediation Guidance
    const recs = [];
    if (report.threatCounts.critical > 0) {
        recs.push({
            priority: 'P1 - Immediate',
            action: 'Isolate Host & Check Process Memory',
            desc: 'Critical indicators (LSASS dump, shadow deletion, or reverse shells) were detected. Verify running processes and network sockets.'
        });
    }
    if (report.threatCounts.failedLogons >= 5) {
        recs.push({
            priority: 'P2 - High',
            action: 'Credential Brute-Force Defense',
            desc: `Detected ${report.threatCounts.failedLogons} failed logons. Consider enabling account lockout policies or restricting RDP/SSH ingress IPs.`
        });
    }
    if (report.privilegeEvents.length > 0) {
        recs.push({
            priority: 'P2 - High',
            action: 'Audit Privileged Account Membership',
            desc: `Detected ${report.privilegeEvents.length} account/privilege changes. Verify newly granted administrative privileges against change management records.`
        });
    }
    if (report.mitreDomains['Defense Evasion'] > 0) {
        recs.push({
            priority: 'P1 - Immediate',
            action: 'Investigate Log Clearing & Security Tampering',
            desc: 'Audit logs or firewall controls were modified or cleared. Inspect secondary offline SIEM copies to recover missing audit traces.'
        });
    }
    if (recs.length === 0) {
        recs.push({
            priority: 'Info',
            action: 'Routine Monitoring',
            desc: 'No high-risk threat indicators found within the selected lookback window. System posture is clean.'
        });
    }
    report.recommendations = recs;

    return report;
}

// POST /api/monitor/forensics/scan
// Triggers an on-demand scan
router.post('/scan', requireAuth, checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const { monitorId, scanType, options } = req.body;
        if (!monitorId || !scanType) {
            return res.status(400).json({ error: 'monitorId and scanType are required' });
        }

        const monitor = db.get("SELECT * FROM monitors WHERE id = ?", [monitorId]);
        if (!monitor) {
            return res.status(404).json({ error: 'Monitor not found' });
        }

        const taskId = crypto.randomUUID();
        const days = options?.days || 7;
        const timeFilter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        if (scanType === 'local') {
            // OPTION A: Query existing database rows
            // Match logs by hostname (case-insensitive)
            const winLogs = db.all("SELECT * FROM windows_events WHERE LOWER(host) = LOWER(?) AND timestamp >= ?", [monitor.name, timeFilter]);
            const linLogs = db.all("SELECT * FROM linux_logs WHERE LOWER(host) = LOWER(?) AND timestamp >= ?", [monitor.name, timeFilter]);

            const analysisReport = runThreatAnalysis(winLogs, linLogs);
            
            // Insert task as completed
            db.run(`INSERT INTO forensic_tasks (id, monitorId, scanType, status, params, createdAt, completedAt)
                    VALUES (?,?,?,?,?,?,?)`,
                    [taskId, monitorId, 'local', 'completed', JSON.stringify({ days }), new Date().toISOString(), new Date().toISOString()]);

            // Save report
            const reportId = crypto.randomUUID();
            db.run(`INSERT INTO forensic_reports (id, taskId, monitorId, scanType, content, timestamp)
                    VALUES (?,?,?,?,?,?)`,
                    [reportId, taskId, monitorId, 'local', JSON.stringify(analysisReport), new Date().toISOString()]);

            return res.json({ success: true, taskId, status: 'completed', report: analysisReport });
        } else {
            // OPTION B: Queued command for agent to run
            db.run(`INSERT INTO forensic_tasks (id, monitorId, scanType, status, params, createdAt, completedAt)
                    VALUES (?,?,?,?,?,?,?)`,
                    [taskId, monitorId, 'deep', 'pending', JSON.stringify({ days }), new Date().toISOString(), null]);

            return res.json({ success: true, taskId, status: 'pending' });
        }
    } catch (e) {
        console.error('[Forensics] Scan Trigger failed:', e);
        res.status(500).json({ error: 'Failed to start scan' });
    }
});

// POST /api/monitor/forensics/fleet-scan
// Multi-host / Environment Fleet Sweeping Scan
router.post('/fleet-scan', requireAuth, checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    try {
        const { envId, monitorIds, days = 7 } = req.body;
        let targets = [];

        if (Array.isArray(monitorIds) && monitorIds.length > 0) {
            targets = db.all(`SELECT * FROM monitors WHERE id IN (${monitorIds.map(() => '?').join(',')}) AND enabled = 1`, monitorIds);
        } else if (envId) {
            targets = db.all("SELECT * FROM monitors WHERE envId = ? AND enabled = 1", [envId]);
        } else {
            targets = db.all("SELECT * FROM monitors WHERE enabled = 1");
        }

        if (targets.length === 0) {
            return res.status(404).json({ error: 'No matching online/enabled targets found for fleet scan' });
        }

        const timeFilter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const results = [];

        for (const m of targets) {
            const winLogs = db.all("SELECT * FROM windows_events WHERE LOWER(host) = LOWER(?) AND timestamp >= ?", [m.name, timeFilter]);
            const linLogs = db.all("SELECT * FROM linux_logs WHERE LOWER(host) = LOWER(?) AND timestamp >= ?", [m.name, timeFilter]);
            const analysis = runThreatAnalysis(winLogs, linLogs);

            const taskId = crypto.randomUUID();
            const reportId = crypto.randomUUID();

            db.run(`INSERT INTO forensic_tasks (id, monitorId, scanType, status, params, createdAt, completedAt)
                    VALUES (?,?,?,?,?,?,?)`,
                    [taskId, m.id, 'fleet', 'completed', JSON.stringify({ days }), new Date().toISOString(), new Date().toISOString()]);

            db.run(`INSERT INTO forensic_reports (id, taskId, monitorId, scanType, content, timestamp)
                    VALUES (?,?,?,?,?,?)`,
                    [reportId, taskId, m.id, 'fleet', JSON.stringify(analysis), new Date().toISOString()]);

            results.push({
                monitorId: m.id,
                name: m.name,
                ip: m.ip,
                os: m.os,
                taskId,
                reportId,
                riskScore: analysis.riskScore,
                riskLevel: analysis.riskLevel,
                riskColor: analysis.riskColor,
                criticalThreats: analysis.threatCounts.critical,
                suspiciousCmds: analysis.threatCounts.suspiciousCmds,
                failedLogons: analysis.threatCounts.failedLogons,
                totalLogs: analysis.totalLogsAnalyzed,
                report: analysis
            });
        }

        results.sort((a, b) => b.riskScore - a.riskScore);

        res.json({
            success: true,
            totalScanned: results.length,
            criticalCount: results.filter(r => r.riskLevel === 'CRITICAL').length,
            elevatedCount: results.filter(r => r.riskLevel === 'ELEVATED').length,
            cleanCount: results.filter(r => r.riskLevel === 'CLEAN').length,
            results
        });
    } catch (e) {
        console.error('[Forensics] Fleet scan failed:', e);
        res.status(500).json({ error: 'Fleet scan failed' });
    }
});

// GET /api/monitor/forensics/active/:monitorId
// Checks if there is an active (pending/running) task for the monitor
router.get('/active/:monitorId', requireAuth, checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    try {
        const task = db.get("SELECT * FROM forensic_tasks WHERE monitorId = ? AND status IN ('pending', 'running') ORDER BY createdAt DESC LIMIT 1", [req.params.monitorId]);
        res.json({ activeTask: task || null });
    } catch (e) {
        console.error('[Forensics] Get active task failed:', e);
        res.status(500).json({ error: 'Failed to query active task' });
    }
});

// GET /api/monitor/forensics/task/:id
// Get task status and report
router.get('/task/:id', requireAuth, checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    try {
        const task = db.get("SELECT * FROM forensic_tasks WHERE id = ?", [req.params.id]);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        if (task.status === 'completed') {
            const report = db.get("SELECT * FROM forensic_reports WHERE taskId = ?", [task.id]);
            return res.json({
                success: true,
                status: task.status,
                completedAt: task.completedAt,
                report: report ? parseJSON(report.content, {}) : null
            });
        }

        return res.json({ success: true, status: task.status });
    } catch (e) {
        console.error('[Forensics] Get task failed:', e);
        res.status(500).json({ error: 'Failed to query task' });
    }
});

// GET /api/monitor/forensics/reports
// List past reports
router.get('/reports', requireAuth, checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    try {
        const reports = db.all(`
            SELECT r.id, r.taskId, r.monitorId, r.scanType, r.timestamp, m.name as hostName, m.ip as hostIp, t.status 
            FROM forensic_reports r
            LEFT JOIN monitors m ON r.monitorId = m.id
            LEFT JOIN forensic_tasks t ON r.taskId = t.id
            ORDER BY r.timestamp DESC LIMIT 50
        `);
        res.json(reports);
    } catch (e) {
        console.error('[Forensics] List reports failed:', e);
        res.status(500).json({ error: 'Failed to query reports' });
    }
});

// POST /api/monitor/forensics/task/:id/cancel
// Cancel a stuck forensic task
router.post('/task/:id/cancel', requireAuth, checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    try {
        db.run("UPDATE forensic_tasks SET status = 'failed', completedAt = ? WHERE id = ?", [new Date().toISOString(), req.params.id]);
        res.json({ success: true });
    } catch (e) {
        console.error('[Forensics] Cancel task failed:', e);
        res.status(500).json({ error: 'Failed to cancel task' });
    }
});

// Rate Limiting & Disk Watermark for Forensics Uploads
const uploadRateLimits = new Map();
const UPLOAD_RATE_LIMIT_MAX = 5; // 5 uploads per 60s window per IP
const UPLOAD_WINDOW_MS = 60000;
const MAX_LOG_ENTRIES = 5000; // Cap log items to prevent memory / disk exhaustion

setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of uploadRateLimits.entries()) {
        if (now > data.resetAt) uploadRateLimits.delete(ip);
    }
}, UPLOAD_WINDOW_MS).unref(); // housekeeping only: must not keep the process (or a route test) alive

// POST /api/monitor/forensics/upload
// Endpoint for Agent to post deep scan raw logs
router.post('/upload', async (req, res) => {
    try {
        // IP Rate Limiting Check
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        if (!uploadRateLimits.has(clientIp)) {
            uploadRateLimits.set(clientIp, { count: 1, resetAt: now + UPLOAD_WINDOW_MS });
        } else {
            const limitState = uploadRateLimits.get(clientIp);
            if (now > limitState.resetAt) {
                limitState.count = 1;
                limitState.resetAt = now + UPLOAD_WINDOW_MS;
            } else {
                limitState.count++;
                if (limitState.count > UPLOAD_RATE_LIMIT_MAX) {
                    return res.status(429).json({ error: 'Too many forensics uploads. Rate limit exceeded.' });
                }
            }
        }

        const { apiKey, taskId, winLogs, linLogs } = req.body;
        console.log('[Forensics Debug] Upload Request:', { clientIp, apiKey, taskId, hasWinLogs: !!winLogs, hasLinLogs: !!linLogs });
        if (!apiKey || !taskId) {
            return res.status(400).json({ error: 'apiKey and taskId are required' });
        }

        // Validate payload entry counts
        const safeWinLogs = Array.isArray(winLogs) ? winLogs.slice(0, MAX_LOG_ENTRIES) : [];
        const safeLinLogs = Array.isArray(linLogs) ? linLogs.slice(0, MAX_LOG_ENTRIES) : [];

        // Disk space watermark check (Ensure at least 100MB free space if statfs is supported)
        const fs = require('fs');
        if (typeof fs.statfsSync === 'function') {
            try {
                const targetDir = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
                const stats = fs.statfsSync(targetDir);
                const freeBytes = stats.bavail * stats.bsize;
                const minFreeBytes = 100 * 1024 * 1024; // 100MB
                if (freeBytes < minFreeBytes) {
                    console.error(`[Forensics Upload] Disk space critical! Free bytes: ${freeBytes}`);
                    return res.status(507).json({ error: 'Server disk space insufficient for forensic logs' });
                }
            } catch (fsErr) {
                console.warn('[Forensics Upload] Statfs check warning:', fsErr.message);
            }
        }

        // 1. Find the task first (Task ID is unique and secure)
        const task = db.get("SELECT * FROM forensic_tasks WHERE id = ?", [taskId]);
        console.log('[Forensics Debug] Found Task:', task ? { id: task.id, monitorId: task.monitorId, status: task.status } : null);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // 2. Find the monitor that this task was assigned to
        const monitor = db.get("SELECT * FROM monitors WHERE id = ?", [task.monitorId]);
        console.log('[Forensics Debug] Found Monitor:', monitor ? { id: monitor.id, name: monitor.name } : null);
        if (!monitor) {
            return res.status(404).json({ error: 'Monitor for this task not found' });
        }

        // 3. Verify apiKey (support either direct match or valid global key)
        const isGlobalKey = db.get("SELECT 1 FROM api_keys WHERE key = ?", [apiKey]);
        if (monitor.apiKey !== apiKey && !isGlobalKey) {
            console.log('[Forensics Debug] Auth failed. apiKey mismatch and not a valid global key.');
            return res.status(401).json({ error: 'Invalid apiKey' });
        }

        // Run threat analysis
        const analysisReport = runThreatAnalysis(safeWinLogs, safeLinLogs);

        // Update task status
        db.run("UPDATE forensic_tasks SET status = 'completed', completedAt = ? WHERE id = ?", [new Date().toISOString(), taskId]);

        // Save report
        const reportId = crypto.randomUUID();
        db.run(`INSERT INTO forensic_reports (id, taskId, monitorId, scanType, content, timestamp)
                VALUES (?,?,?,?,?,?)`,
                [reportId, taskId, monitor.id, 'deep', JSON.stringify(analysisReport), new Date().toISOString()]);

        res.json({ success: true });
    } catch (e) {
        console.error('[Forensics] Upload failed:', e);
        res.status(500).json({ error: 'Failed to process forensic upload' });
    }
});

module.exports = router;
