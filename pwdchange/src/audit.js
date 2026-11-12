// Audit log: one JSON line per attempt in LOG_DIR/audit-YYYY-MM-DD.log. Never contains a password.
const fs = require('fs');
const path = require('path');

const clean = (v, max = 200) => String(v === undefined || v === null ? '' : v).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, max);
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function createAudit(logDir) {
    return function audit({ ip, account, outcome, reason }, now = new Date()) {
        const line = JSON.stringify({ time: now.toISOString(), ip: clean(ip, 64), account: clean(account, 256), outcome: clean(outcome, 32), reason: clean(reason, 300) });
        try {
            fs.mkdirSync(logDir, { recursive: true });
            fs.appendFileSync(path.join(logDir, `audit-${day(now)}.log`), line + '\n', 'utf8');
        } catch (err) {
            console.error('[pwdchange] Could not write the audit log:', err.message);
        }
        console.log(`[pwdchange] ${line}`);
    };
}

module.exports = { createAudit };
