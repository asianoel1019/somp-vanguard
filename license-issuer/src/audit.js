// Audit log: one JSON line per event in logs/audit.log (login ok/fail/locked, issue, download, logout).
// Only the fields below are written: never a password, a hash, a token or key material.
const fs = require('fs');
const path = require('path');

const clean = (v, max = 300) => String(v === undefined || v === null ? '' : v).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, max);
const FIELDS = ['licenseId', 'customer', 'issuedAt', 'expiresAt', 'file', 'reason'];

function createAudit(logDir, { echo = true } = {}) {
    const file = path.join(logDir, 'audit.log');
    function audit(event, details = {}, now = new Date()) {
        const entry = { time: now.toISOString(), event: clean(event, 40) };
        for (const k of FIELDS) if (details[k] !== undefined && details[k] !== null && details[k] !== '') entry[k] = clean(details[k]);
        const line = JSON.stringify(entry);
        try {
            fs.mkdirSync(logDir, { recursive: true });
            fs.appendFileSync(file, line + '\n', 'utf8');
        } catch (err) {
            console.error('[license-issuer] Could not write the audit log:', err.code || err.message);
        }
        if (echo) console.log(`[license-issuer] ${line}`);
    }
    audit.file = file;
    return audit;
}

module.exports = { createAudit };
