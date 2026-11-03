const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { requireAuth, checkRole } = require('../middleware/auth');
const { auditRetentionDays } = require('../lib/logger');

const gunzip = promisify(zlib.gunzip);

router.use(requireAuth);
router.use(checkRole(['SuperAdmin']));

const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const LOG_DIR = path.join(BASE_DATA_DIR, 'logs');
// audit files older than 7 days are compressed into logs\archive by the daily rotation
const ARCHIVE_DIR = path.join(LOG_DIR, 'archive');
const AUDIT_FILE_RE = /^auth_(\d{4}-\d{2}-\d{2})\.log(\.gz)?$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;
const MAX_PAGE_SIZE = 200;
const MAX_EXPORT_ROWS = 100000;

// Helper to parse log line
function parseLogLine(line) {
    // Matches formats like:
    // [2026-05-12T07:28:24.701Z] [Audit] User: admin | Module: Inventory | Action: Updated inventory configuration
    // [2026-05-12T07:28:24.701Z] [Audit-Batch] User: admin | Module: Inventory | Actions (5): Updated config...
    const auditRegex = /^\[(.*?)\] \[(Audit(?:-Batch)?)\] User: (.*?) \| Module: (.*?) \| Actions?(?: \(\d+\))?: (.*)$/;
    const match = line.match(auditRegex);
    if (match) {
        return {
            timestamp: match[1],
            user: match[3].trim(),
            module: match[4].trim(),
            action: match[5].trim()
        };
    }
    return null;
}

const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Audit files of both folders as [{ day, file }], one per day (the uncompressed one wins), oldest first. */
function listAuditFiles() {
    const byDay = new Map();
    for (const dir of [ARCHIVE_DIR, LOG_DIR]) {
        let names = [];
        try { names = fs.readdirSync(dir); } catch (e) { continue; }
        for (const name of names) {
            const m = name.match(AUDIT_FILE_RE);
            if (!m) continue;
            const existing = byDay.get(m[1]);
            if (!existing || (existing.gz && !m[2])) byDay.set(m[1], { day: m[1], file: path.join(dir, name), gz: !!m[2] });
        }
    }
    return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

async function readAuditFile(entry) {
    try {
        const raw = await fs.promises.readFile(entry.file);
        return (entry.gz ? (await gunzip(raw)).toString('utf8') : raw.toString('utf8')).split('\n');
    } catch (err) {
        console.error(`[Audit API] Failed to read audit log file ${path.basename(entry.file)}: ${err.message}`);
        return [];
    }
}

/**
 * Entries of the requested days. Only files whose day falls in the range are read, so a query costs what it asks
 * for rather than the whole retention period.
 */
async function loadEntries(fromDay, toDay) {
    const entries = [];
    for (const f of listAuditFiles().filter(x => x.day >= fromDay && x.day <= toDay)) {
        for (const line of await readAuditFile(f)) {
            if (!line.includes('[Audit')) continue;
            const parsed = parseLogLine(line);
            if (!parsed) continue;
            const day = parsed.timestamp.slice(0, 10);
            if (day >= fromDay && day <= toDay) entries.push(parsed);
        }
    }
    return entries;
}

function resolveRange(query) {
    const today = localDay(new Date());
    const to = DAY_RE.test(query.to || '') ? query.to : today;
    let from = DAY_RE.test(query.from || '') ? query.from : null;
    if (!from) {
        const d = new Date(`${to}T00:00:00`);
        d.setDate(d.getDate() - (DEFAULT_RANGE_DAYS - 1));
        from = localDay(d);
    }
    return from <= to ? { from, to } : { from: to, to: from };
}

function applyFilters(entries, { user, module, q }) {
    const kw = String(q || '').trim().toLowerCase();
    return entries.filter(e => {
        if (user && e.user !== user) return false;
        if (module && e.module !== module) return false;
        if (kw && !`${e.user}\n${e.module}\n${e.action}`.toLowerCase().includes(kw)) return false;
        return true;
    });
}

const SORT_FIELDS = ['timestamp', 'user', 'module'];
function sortEntries(entries, field, order) {
    const f = SORT_FIELDS.includes(field) ? field : 'timestamp';
    const dir = order === 'asc' ? 1 : -1;
    // timestamps share one fixed format, so text order is time order
    return entries.sort((a, b) => {
        const x = f === 'timestamp' ? a[f] : String(a[f]).toLowerCase();
        const y = f === 'timestamp' ? b[f] : String(b[f]).toLowerCase();
        return x < y ? -dir : x > y ? dir : 0;
    });
}

// One CSV cell: quoted, quotes doubled, and a leading = + - @ tab or CR neutralised so Excel does not run it as a formula
function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

// GET /api/audit/logs - Filtered, sorted, paged audit entries
// Query: from, to (YYYY-MM-DD, default the last 30 days), user, module, q, sort, order, page, limit; format=csv exports
router.get('/logs', async (req, res) => {
    try {
        const { from, to } = resolveRange(req.query);
        const inRange = await loadEntries(from, to);
        const filtered = sortEntries(applyFilters(inRange, req.query), req.query.sort, req.query.order);

        if (req.query.format === 'csv') {
            const rows = filtered.slice(0, MAX_EXPORT_ROWS)
                .map(e => [e.timestamp, e.user, e.module, e.action].map(csvCell).join(','));
            const csv = '\uFEFF' + [['Timestamp', 'User Account', 'Module', 'Action Details'].map(csvCell).join(','), ...rows].join('\r\n');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${from}_${to}.csv"`);
            return res.send(csv);
        }

        const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(req.query.limit, 10) || 15));
        const totalPages = Math.max(1, Math.ceil(filtered.length / limit));
        const page = Math.min(totalPages, Math.max(1, parseInt(req.query.page, 10) || 1));
        const files = listAuditFiles();

        res.json({
            logs: filtered.slice((page - 1) * limit, page * limit),
            total: filtered.length,
            page,
            limit,
            // dropdown values come from the whole range, not just the filtered rows
            filters: {
                users: [...new Set(inRange.map(l => l.user))].sort(),
                modules: [...new Set(inRange.map(l => l.module))].sort()
            },
            range: { from, to, earliestDay: files.length ? files[0].day : null, retentionDays: auditRetentionDays() }
        });
    } catch (err) {
        console.error('[Audit API] Error in GET /api/audit/logs:', err);
        res.status(500).json({ error: 'Internal server error reading audit logs' });
    }
});

module.exports = router;
