const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { executeSSH, sftpWrite } = require('../lib/ssh');
const { exec } = require('child_process');
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const aiRouter = require('./ai');

router.use(requireAuth);
router.use(checkFeature('mail'));

// ---- Dynamic Mail Environment Engine ----
// Reads environment list and server IPs entirely from .env
// To add a new environment, just edit .env ??zero code changes needed.
//
// .env format:
//   MAIL_ENVS=UAT,INFRA,BU
//   MAIL_SERVERS_UAT=203.0.113.184,203.0.113.185
//   MAIL_SERVERS_BU=198.51.100.37,198.51.100.38

function getMailEnvs() {
    return (process.env.MAIL_ENVS || '').split(',').map(e => e.trim()).filter(Boolean);
}

function getServersForEnv(env) {
    const raw = process.env[`MAIL_SERVERS_${env}`];
    if (!raw) return null;
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// GET /envs ??returns available mail environments
router.get('/envs', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    const envs = getMailEnvs().filter(e => process.env[`MAIL_SERVERS_${e}`]);
    const envDetails = envs.map(e => {
        const creds = getMailCredentials(e);
        return {
            name: e,
            hasPresetAuth: !!creds.pwd,
            user: creds.user
        };
    });
    res.json({ envs, envDetails });
});

const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const BACKUP_DIR = path.join(BASE_DATA_DIR, 'config_backup', 'mail_cfg_bk');
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function getMailCredentials(env) {
    const uEnv = (env || '').toUpperCase();
    const customUser = process.env[`MAIL_${uEnv}_USER`];
    const customPwd = process.env[`MAIL_${uEnv}_PWD`];
    return {
        user: (customUser && customUser.trim()) ? customUser.trim() : (process.env.LINUX_ADMIN_USER || 'xyuser'),
        pwd: (customPwd && customPwd.trim()) ? customPwd.trim() : null
    };
}

// Format YYYY-MM-DD-HH-mm for backups
function getTimestamp() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}-${String(d.getMinutes()).padStart(2,'0')}`;
}

// 1. Read Remote Config
router.post('/config/read', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, fileType, linuxPassword } = req.body;
    if (!env || !fileType) return res.status(400).json({ error: 'Missing parameters' });
    
    const { user, pwd } = getMailCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    const hosts = getServersForEnv(env.toUpperCase());
    if (!hosts) return res.status(400).json({ error: 'Invalid environment' });

    try {
        const remotePath = `/etc/mail/${fileType}`;
        const command = `cat ${remotePath}`;
        const { stdout, stderr } = await executeSSH(hosts[0], user, finalPassword, command);
        res.json({ content: stdout + stderr });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. Deploy Remote Config
router.post('/config/deploy', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, fileType, content, linuxPassword } = req.body;
    if (!env || !fileType || !content) return res.status(400).json({ error: 'Missing parameters' });
    
    const { user, pwd } = getMailCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    const hosts = getServersForEnv(env.toUpperCase());
    if (!hosts) return res.status(400).json({ error: 'Invalid environment' });

    try {
        // Create local backup
        const ts = getTimestamp();
        const bkName = `${env.toUpperCase()}_${fileType}_${ts}_backup.txt`;
        const bkPath = path.join(BACKUP_DIR, bkName);
        fs.writeFileSync(bkPath, content, 'utf8');

        // Deploy to all servers
        let results = [];
        const remotePath = `/etc/mail/${fileType}`;
        const restartCmd = `makemap hash ${remotePath} < ${remotePath} ; systemctl restart sendmail`;

        for (const host of hosts) {
            try {
                // SFTP raw write
                await sftpWrite(host, user, finalPassword, remotePath, content);
                const { stdout, stderr } = await executeSSH(host, user, finalPassword, restartCmd);
                results.push({ host, status: 'Success', logs: stdout + stderr });
            } catch (err) {
                results.push({ host, status: 'Failed', error: err.message });
            }
        }
        
        auditLog(req.user.username, 'Mail Relay', `Deployed [${fileType}] config to Env: ${env}`);
        res.json({ backupFile: bkName, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. Mail Queue Check
router.post('/queue', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, linuxPassword } = req.body;
    if (!env) return res.status(400).json({ error: 'Missing parameters' });
    
    const { user, pwd } = getMailCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    const hosts = getServersForEnv(env.toUpperCase());
    if (!hosts) return res.status(400).json({ error: 'Invalid environment' });

    try {
        let results = [];
        const command = `mailq`;
        for (const host of hosts) {
            try {
                const { stdout, stderr } = await executeSSH(host, user, finalPassword, command);
                results.push({ host, status: 'Success', queue: (stdout + stderr).trim() });
            } catch (err) {
                results.push({ host, status: 'Failed', error: err.message, queue: '' });
            }
        }
        auditLog(req.user.username, 'Mail Relay', `Checked mail queue for Env: ${env}`);
        res.json({ results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3.5. Queue Actions
router.post('/queue/action', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, linuxPassword, action, queueId } = req.body;
    if (!env || !action) return res.status(400).json({ error: 'Missing parameters' });
    
    const { user, pwd } = getMailCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    const hosts = getServersForEnv(env.toUpperCase());
    if (!hosts) return res.status(400).json({ error: 'Invalid environment' });

    let command = '';
    if (action === 'flush') {
        command = `sudo sendmail -q`;
    } else if (action === 'delete') {
        if (!queueId) return res.status(400).json({ error: 'Missing queue ID for delete' });
        command = `sudo rm -f /var/spool/mqueue/qf${queueId} /var/spool/mqueue/df${queueId}`;
    } else if (action === 'clear') {
        command = `sudo mkdir -p /tmp/mqueue_trash && sudo mv /var/spool/mqueue/* /tmp/mqueue_trash/ 2>/dev/null || true`;
    } else {
        return res.status(400).json({ error: 'Invalid action' });
    }

    try {
        let results = [];
        for (const host of hosts) {
            try {
                const { stdout, stderr } = await executeSSH(host, user, finalPassword, command);
                results.push({ host, status: 'Success', output: (stdout + stderr).trim() });
            } catch (err) {
                results.push({ host, status: 'Failed', error: err.message });
            }
        }
        auditLog(req.user.username, 'Mail Relay', `Executed queue action '${action}' for Env: ${env}`);
        res.json({ results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3.6. Message Trace
router.post('/trace', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, linuxPassword, query } = req.body;
    if (!env || !query) return res.status(400).json({ error: 'Missing parameters' });
    
    const { user, pwd } = getMailCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    const hosts = getServersForEnv(env.toUpperCase());
    if (!hosts) return res.status(400).json({ error: 'Invalid environment' });

    try {
        const sanitizedQuery = query.replace(/[^a-zA-Z0-9@._-]/g, '');
        const command = `grep -i -F "${sanitizedQuery}" /var/log/maillog | tail -n 200`;
        let results = [];
        for (const host of hosts) {
            try {
                const { stdout, stderr } = await executeSSH(host, user, finalPassword, command);
                results.push({ host, status: 'Success', logs: (stdout + stderr).trim() });
            } catch (err) {
                results.push({ host, status: 'Failed', error: err.message });
            }
        }
        auditLog(req.user.username, 'Mail Relay', `Traced message with query '${query}' for Env: ${env}`);
        res.json({ results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3.7. Dashboard Telemetry
router.post('/dashboard', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, linuxPassword } = req.body;
    if (!env) return res.status(400).json({ error: 'Missing parameters' });
    
    const { user, pwd } = getMailCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    const hosts = getServersForEnv(env.toUpperCase());
    if (!hosts) return res.status(400).json({ error: 'Invalid environment' });

    try {
        let results = [];
        const command = `
            MONTH=$(date +'%b')
            DAY=$(date +'%e' | tr -d ' ')
            LOGS=$(grep -E "^$MONTH +$DAY" /var/log/maillog)
            SENT=$(echo "$LOGS" | grep "stat=Sent" | wc -l)
            DEFERRED=$(echo "$LOGS" | grep "stat=Deferred" | wc -l)
            BOUNCED=$(echo "$LOGS" | grep -E "stat=User unknown|stat=Service unavailable" | wc -l)
            TOP_SENDER=$(echo "$LOGS" | grep "relay=" | awk -F"relay=" '{print $2}' | awk '{print $1}' | sort | uniq -c | sort -nr | head -n 5)
            echo "$SENT|$DEFERRED|$BOUNCED"
            echo "---TOP---"
            echo "$TOP_SENDER"
        `;
        
        for (const host of hosts) {
            try {
                const { stdout, stderr } = await executeSSH(host, user, finalPassword, command);
                const out = (stdout + stderr).trim();
                const [statsPart, topPart] = out.split('---TOP---');
                const [sent, deferred, bounced] = (statsPart || '').split('|').map(s => parseInt(s.trim()) || 0);
                
                results.push({ 
                    host, 
                    status: 'Success', 
                    sent, deferred, bounced, 
                    topRelayers: (topPart || '').trim() 
                });
            } catch (err) {
                results.push({ host, status: 'Failed', error: err.message });
            }
        }
        res.json({ results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3.8. Dashboard Deferred & Bounced Mail Details Drill-down (with Sender Correlation by Queue ID)
router.post('/dashboard/details', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
    const { env, linuxPassword, type } = req.body; // type: 'deferred' | 'bounced'
    if (!env || !type) return res.status(400).json({ error: 'Missing parameters' });
    
    const { user, pwd } = getMailCredentials(env);
    const finalPassword = pwd || linuxPassword;
    if (!finalPassword) return res.status(400).json({ error: 'Missing password' });

    const hosts = getServersForEnv(env.toUpperCase());
    if (!hosts) return res.status(400).json({ error: 'Invalid environment' });

    const isDeferred = type === 'deferred';
    const grepPattern = isDeferred 
        ? 'stat=Deferred' 
        : 'stat=User unknown|stat=Service unavailable|stat=Rejected|stat=Deferred: Connection refused';

    const command = `
        MONTH=$(date +'%b')
        DAY=$(date +'%e' | tr -d ' ')
        DAY_LOGS=$(grep -E "^$MONTH +$DAY" /var/log/maillog)
        
        # 1. Fetch delivery failure/deferred lines
        if [ "${type}" = "deferred" ]; then
            TARGET_LINES=$(echo "$DAY_LOGS" | grep "stat=Deferred" | tail -n 150)
        else
            TARGET_LINES=$(echo "$DAY_LOGS" | grep -E "stat=User unknown|stat=Service unavailable|stat=Rejected|stat=Deferred: Connection refused" | tail -n 150)
        fi

        # 2. Extract unique Sendmail Queue IDs
        QIDS=$(echo "$TARGET_LINES" | grep -oE "sendmail\\[[0-9]+\\]: [a-zA-Z0-9_-]+" | awk '{print $2}' | sort -u)

        # 3. Find matching 'from=' entries in maillog using Queue IDs
        FROM_LINES=""
        if [ -n "$QIDS" ]; then
            QID_PATTERN=$(echo "$QIDS" | tr '\\n' '|' | sed 's/|$//')
            FROM_LINES=$(grep -E "($QID_PATTERN):.*from=" /var/log/maillog | tail -n 300)
        fi

        echo "---TARGET_LINES---"
        echo "$TARGET_LINES"
        echo "---FROM_LINES---"
        echo "$FROM_LINES"
    `;

    try {
        let results = [];
        for (const host of hosts) {
            try {
                const { stdout, stderr } = await executeSSH(host, user, finalPassword, command);
                const rawOutput = (stdout + stderr).trim();
                
                const [targetPart, fromPart] = rawOutput.split('---FROM_LINES---');
                const targetLines = (targetPart || '').replace('---TARGET_LINES---', '').trim().split('\n').filter(Boolean);
                const fromLines = (fromPart || '').trim().split('\n').filter(Boolean);

                // Build lookup map for sender info by Queue ID
                const fromMap = {};
                for (const fLine of fromLines) {
                    const qMatch = fLine.match(/sendmail\[\d+\]:\s+([a-zA-Z0-9_-]+):/);
                    if (!qMatch) continue;
                    const qid = qMatch[1];
                    const senderMatch = fLine.match(/from=<([^>]+)>/) || fLine.match(/from=([^,\s]+)/);
                    const clientRelayMatch = fLine.match(/relay=([^,\s]+(?:\s+\[[^\]]+\])?)/);
                    const msgIdMatch = fLine.match(/msgid=<([^>]+)>/);

                    fromMap[qid] = {
                        from: senderMatch ? senderMatch[1] : '',
                        sourceRelay: clientRelayMatch ? clientRelayMatch[1] : '',
                        msgId: msgIdMatch ? msgIdMatch[1] : ''
                    };
                }

                // Parse each deferred / bounced delivery event
                const parsed = targetLines.map(line => {
                    const timeMatch = line.match(/^([A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2})/);
                    const qidMatch = line.match(/sendmail\[\d+\]:\s+([a-zA-Z0-9_-]+):/);
                    const toMatch = line.match(/to=<([^>]+)>/) || line.match(/to=([^,\s]+)/);
                    const destRelayMatch = line.match(/relay=([^,\s]+(?:\s+\[[^\]]+\])?)/);
                    const statMatch = line.match(/stat=([^$]+)/);

                    const qid = qidMatch ? qidMatch[1] : '';
                    const fromInfo = fromMap[qid] || {};

                    return {
                        time: timeMatch ? timeMatch[1] : '',
                        qid: qid,
                        from: fromInfo.from || 'Unknown (未查得來源)',
                        sourceRelay: fromInfo.sourceRelay || '',
                        msgId: fromInfo.msgId || '',
                        to: toMatch ? toMatch[1] : '',
                        relay: destRelayMatch ? destRelayMatch[1] : '',
                        stat: statMatch ? statMatch[1].trim() : '',
                        raw: line
                    };
                });

                results.push({ host, status: 'Success', items: parsed, count: parsed.length, rawLogs: rawOutput });
            } catch (err) {
                results.push({ host, status: 'Failed', error: err.message, items: [], count: 0, rawLogs: '' });
            }
        }
        res.json({ type, results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. List Backups
router.get('/backups', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
    try {
        const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.txt')).sort().reverse();
        res.json({ files });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Read Local Backup content
router.post('/backups/read', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
    const { filename } = req.body;
    try {
        const p = path.join(BACKUP_DIR, filename);
        if (fs.existsSync(p)) {
            res.json({ content: fs.readFileSync(p, 'utf8') });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --------------------------------------------------------------------------
// 6. POST /api/mail/ai-diagnose
// AI NDR Bounce & Queue Congestion Analyst
// --------------------------------------------------------------------------
router.post('/ai-diagnose', checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
    try {
        const { env, mode = 'bounce', stat, from, to, relay, queueOutput, rawText, items } = req.body;
        const aiConfig = aiRouter.getAiConfig ? aiRouter.getAiConfig() : { enabled: false };

        // Helper: Rule-based offline analysis generator
        function generateRuleBasedReport() {
            if (mode === 'queue') {
                const qText = queueOutput || rawText || '';
                const countMatch = qText.match(/Total requests:\s*(\d+)/i) || qText.match(/(\d+)\s+Requests/i);
                const reqCount = countMatch ? countMatch[1] : '多筆';
                return `### 📨 Mail Relay 佇列壅塞分析報告 (Queue Congestion Analysis)\n\n` +
                       `1. **🎯 佇列現況評估**：目前佇列中積壓 **${reqCount}** 封郵件待傳送。\n` +
                       `2. **🧭 常見塞車主因排查**：\n` +
                       `   - **外部目標限流 (Rate Limiting)**：大量信件同時寄往同一網域（如 gmail.com 或 hotmail.com），超出對端單一 IP 並行連線數上限。\n` +
                       `   - **DNS 解析或網路中斷**：對端 MX 記錄解析超時，或本地 DNS 轉發異常。\n` +
                       `   - **對端伺服器臨時維護 (451 / 4.4.1)**：連線超時，信件處於自動重試遞延狀態 (Deferred)。\n` +
                       `3. **🛠️ 建議處置指引**：\n` +
                       `   - **嘗試立即刷新佇列**：在佇列管理頁點擊 \`[⚡ Flush Queue (立即重試)]\`。\n` +
                       `   - **檢查特定卡滯郵件**：檢視最前方的 Queue ID，使用 Message Trace 追蹤其具體退信原因。\n` +
                       `   - **隔離垃圾郵件**：若發現大量異常寄件來源正在濫用 Relay，請至 Config Editor 在 \`/etc/mail/access\` 加入 \`REJECT\` 封鎖該 IP。`;
            }

            if (mode === 'batch_bounce' && Array.isArray(items) && items.length > 0) {
                const statsSummary = {};
                items.forEach(it => {
                    const s = (it.stat || 'Unknown').substring(0, 40);
                    statsSummary[s] = (statsSummary[s] || 0) + 1;
                });
                const topStats = Object.entries(statsSummary).slice(0, 5).map(([k, v]) => `- **${v} 筆**: \`${k}\``).join('\n');
                return `### 📊 今日批量退信與延遲群聚分析 (Batch Bounce Intelligence)\n\n` +
                       `1. **🎯 總體退信分佈統計**（分析樣本數: ${items.length} 筆）：\n${topStats}\n\n` +
                       `2. **🧭 核心瓶頸歸納**：\n` +
                       `   - 若大量出現 \`Deferred: Connection refused\` 或 \`timed out\`：通常代表我方對外 Port 25 遭防火牆阻斷，或目標機房線路異常。\n` +
                       `   - 若大量出現 \`550 5.7.1\` / \`SPF / DMARC\`：強烈指出我方發信 Public IP 未納入企業 SPF (\`v=spf1 ...\`) 記錄，遭主流郵件商反垃圾機制攔截。\n` +
                       `   - 若出現 \`User unknown\`：業務系統名單中包含大量失效離職信箱，應盡速自發信清單移除。\n\n` +
                       `3. **🛠️ 應急處置建議**：\n` +
                       `   - 點擊單筆退信旁的 \`[🤖 AI 診斷]\` 查看單一郵件的具體對應解法。\n` +
                       `   - 檢查系統 DNS 伺服器是否能正常 \`nslookup -type=mx <目標網域>\`。`;
            }

            // Default: Single bounce / Deferred / Raw analysis
            const errorText = (stat || rawText || '').trim();
            let codeExplanation = '郵件傳送未成功，伺服器返回了狀態碼。';
            let responsibility = '需依據對端回傳訊息進一步核對。';
            let actions = [];
            let hardening = [];

            if (/550\s+5\.7\.1|access\s+denied|relay\s+denied|not\s+permitted/i.test(errorText)) {
                codeExplanation = '🎯 **550 5.7.1 Relay Access Denied / Policy Rejection (拒絕轉發或安全政策攔截)**：目標郵件伺服器因發信人驗證不符、未開放 Relay 權限、或觸發反垃圾郵件安全政策而直接拒絕接收。';
                responsibility = '🧭 **責任歸屬**：通常為**我方發信伺服器設定**或**發信來源未被目標信任**。請檢查發信 IP 是否被允許 Relay，或 SPF 記錄未包含該發信節點。';
                actions.push('- 若發信為內部系統：檢查 `/etc/mail/access` 是否有加入該內部 IP 權限（例如 `Connect:203.0.113.240   RELAY`）。');
                actions.push('- 若為寄往外網：檢查我方 Public IP 是否已正確發布於 DNS SPF 記錄 (`v=spf1 ip4:... -all`)。');
                hardening.push('- 配置標準 DMARC (`p=reject` 或 `p=quarantine`) 與 DKIM 簽名，提升對各大企業伺服器的收件信任度。');
            } else if (/550\s+5\.1\.1|user\s+unknown|mailbox\s+unavailable|recipient\s+not\s+found/i.test(errorText)) {
                codeExplanation = '🎯 **550 5.1.1 User Unknown (收件人信箱不存在)**：目標郵件伺服器已連線，但對方的收件人帳號或信箱在該網域中不存在。';
                responsibility = '🧭 **責任歸屬**：**收件方帳號問題或使用者拼寫錯誤**（非我方 Mail Relay 伺服器故障）。';
                actions.push(`- 核對收件人地址是否拼寫正確（確認收件者: \`${to || '查閱收件人'}\`）。`);
                actions.push('- 請寄件同仁透過其他通訊管道與收件人確認信箱是否已異動或員工已離職。');
                hardening.push('- 建議內部應用程式發信模組對無效信箱建立 Blacklist 快取，避免持續重複發信影響 IP 評分。');
            } else if (/554\s+5\.4\.4|host\s+not\s+found|no\s+mx\s+records|name\s+server\s+error/i.test(errorText)) {
                codeExplanation = '🎯 **554 5.4.4 Host Not Found / Name Service Error (找不到目標郵件主機)**：Mail Relay 無法在公網 DNS 解析出目標網域的 MX (Mail Exchange) 記錄。';
                responsibility = '🧭 **責任歸屬**：**DNS 解析故障**（我方 Relay 節點 `/etc/resolv.conf` 配置錯誤或目標網域已失效）。';
                actions.push('- 在 Relay 伺服器執行 `dig MX <目標網域>` 或 `nslookup -query=mx <目標網域>` 驗證能否解析。');
                actions.push('- 確認 Relay 節點之 DNS Forwarders（如 8.8.8.8 或內部 DNS）運作正常。');
                hardening.push('- 在 Mail Relay 配置備用 DNS 快取伺服器，提高 DNS 解析韌性。');
            } else if (/deferred:\s+connection\s+refused|connection\s+timed\s+out|451\s+4\.4\.1/i.test(errorText)) {
                codeExplanation = '🎯 **Deferred: Connection Refused / Timed Out (連線拒絕或逾時)**：Mail Relay 嘗試與目標伺服器 Port 25 建立 TCP 三方交握失敗。';
                responsibility = '🧭 **責任歸屬**：**網路層通訊阻斷**（對方伺服器當機、防火牆封鎖我方 IP、或我方對外出口 Port 25 遭 ISP / 安全設備限制）。';
                actions.push(`- 在 Relay 節點使用指令測試連通性: \`nc -zv ${relay || '<目標Relay>'} 25\` 或 \`telnet ${relay || '<目標Relay>'} 25\`。`);
                actions.push('- 檢查企業出口防火牆 (FortiProxy/PaloAlto) 是否阻擋發往外網的 SMTP 流量。');
                hardening.push('- 考慮設定 Smart Host (如使用 Exchange 或第三方 SMTP 服務商作為統一外部轉送節點)。');
            } else if (/rbl|spamhaus|barracuda|blacklist|blocked/i.test(errorText)) {
                codeExplanation = '🎯 **RBL / IP Blacklist Rejection (遭國際反垃圾郵件黑名單封鎖)**：我方 Public IP 被收錄於知名黑名單資料庫（如 Spamhaus, Sorbs, Spamcop）。';
                responsibility = '🧭 **責任歸屬**：**企業對外 IP 信譽受損**（可能曾有內部電腦感染勒索病毒暗中大量發送垃圾信）。';
                actions.push('- 前往 https://www.spamhaus.org/lookup/ 輸入發信 IP 查詢封鎖原因。');
                actions.push('- 排查內部 maillog 是否有特定帳號被盜用爆量發信，停止發信後向 RBL 提出 Delist 解封申請。');
                hardening.push('- 在 Mail Relay 啟用發信速率限制 (Rate Limiting) 與 SASL 認證機制，防範帳號遭盜用。');
            } else {
                codeExplanation = `🎯 **SMTP 錯誤狀態解析**：\`${errorText || '一般遞延或退信'}\``;
                responsibility = '🧭 **責任歸屬**：請核對收發兩端 Relay 日誌與錯誤代碼前綴（5xx 代表永久性錯誤不再重試，4xx 代表暫時性錯誤將自動重試）。';
                actions.push('- 點擊 [🔍 Message Trace] 查看信件從接收、處理到嘗試遞送的完整生命週期歷程。');
                hardening.push('- 維護健康的反向解析 (Reverse DNS / PTR Record)，確保 PTR 與 HELO/EHLO 宣告名稱完全相符。');
            }

            return `### 🎯 SMTP 狀態碼白話解讀\n${codeExplanation}\n\n` +
                   `### 🧭 責任歸屬與排查方向\n${responsibility}\n\n` +
                   `### 🛠️ 建議處置指引\n${actions.join('\n')}\n\n` +
                   `### 🛡️ 長期郵件信譽防護\n${hardening.join('\n')}\n\n` +
                   `*(提示：當前為系統內建離線專家規則解析。至「System Settings > AI Service」啟用外接 LLM 即可啟用全自動上下文語義推理與專屬溝通範本生成)*`;
        }

        if (!aiConfig.enabled) {
            const ruleReport = generateRuleBasedReport();
            auditLog(req.user.username, 'Mail Relay', `Rule-based AI Diagnosis (${mode}) for Env: ${env || 'All'}`);
            return res.json({
                success: true,
                analysis: ruleReport,
                isAiGenerated: false,
                mode
            });
        }

        // Format prompt for LLM
        let contextData = '';
        if (mode === 'queue') {
            contextData = `Mode: Queue Congestion Analysis\nEnvironment: ${env}\nQueue Summary Output:\n\`\`\`\n${(queueOutput || rawText || '').slice(0, 3000)}\n\`\`\``;
        } else if (mode === 'batch_bounce') {
            const sampleItems = (items || []).slice(0, 20).map(it => `Time: ${it.time} | From: ${it.from} | To: ${it.to} | Relay: ${it.relay} | Stat: ${it.stat}`).join('\n');
            contextData = `Mode: Batch Bounce Analysis\nEnvironment: ${env}\nTotal Failed Samples: ${(items || []).length}\nSample Logs:\n\`\`\`\n${sampleItems}\n\`\`\``;
        } else {
            contextData = `Mode: Single Bounce / Deferred Delivery Inspection\nEnvironment: ${env}\nSender (From): ${from || 'N/A'}\nRecipient (To): ${to || 'N/A'}\nRelay Host: ${relay || 'N/A'}\nError / Status String:\n\`\`\`\n${stat || rawText || 'N/A'}\n\`\`\``;
        }

        const prompt = `--- MAIL RELAY TELEMETRY CONTEXT ---
${contextData}

--- INSTRUCTIONS ---
Analyze the email delivery failure or queue congestion and provide a concise, professional report in Traditional Chinese (繁體中文):
1. **🎯 SMTP 狀態碼與失敗原因白話解讀**: 精確解析 SMTP 5xx/4xx 狀態碼意涵、對端拒收的根本原因。
2. **🧭 責任歸屬與排查方向**: 明確判定是「我方發信配置問題（如 SPF/DKIM/PTR/Port 25/網段）」、「對端郵件系統政策攔截」、「收件人信箱不存在」還是「網路路由連通問題」。
3. **🛠️ 具體處置建議與操作步驟**: 提供具體指令（如 Sendmail access 設定、佇列管理、DNS 檢查）或向對端網管反映的專業溝通重點。
4. **🛡️ 長期郵件信譽與防禦建議**: 針對發信信譽、防垃圾機制、重試頻率等給予 2 點維運建議。`;

        const messages = [
            {
                role: 'system',
                content: 'You are an elite Enterprise Email Infrastructure & Sendmail/Exchange Mail Relay Specialist for SOMP Vanguard. Output structured, authoritative markdown.'
            },
            {
                role: 'user',
                content: prompt
            }
        ];

        const aiResponse = await aiRouter.callAiEngine(aiConfig, messages);
        auditLog(req.user.username, 'Mail Relay', `AI Mail Diagnosis (${mode}) executed for Env: ${env || 'General'}`);

        res.json({
            success: true,
            analysis: aiResponse.content,
            model: aiResponse.model,
            provider: aiResponse.provider,
            isAiGenerated: true,
            mode
        });

    } catch (e) {
        console.error('[AI Mail Diagnose] Error:', e.message);
        res.status(500).json({ success: false, error: aiRouter.formatAiError ? aiRouter.formatAiError(e) : e.message });
    }
});

module.exports = router;
