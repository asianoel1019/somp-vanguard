const scoutDb = require('../../../services/scoutDb');
const { parseRange, findMonitors, splitIps, truncateText } = require('./common');

const MESSAGE_CHARS = 500;

function hostClause(names, params) {
    if (!names.length) return '';
    params.push(...names.map(n => n.toLowerCase()));
    return ` AND LOWER(host) IN (${names.map(() => '?').join(',')})`;
}

module.exports = {
    name: 'search_logs',
    // any of the screens that show these logs (Scout Monitor, Live Event Viewer, Log Settings)
    feature: ['monitorScout', 'monitorWinEvent', 'monitorLinuxLog'],
    description: 'Search Windows event logs and Linux logs collected by Scout agents (last 24 hours by default, max 7 days, newest first). Filters: host, os, level (Windows: Critical/Error/Warning/Information; Linux: tag such as error), keyword (substring of message), eventId (Windows only).',
    parameters: {
        type: 'object',
        properties: {
            host: { type: 'string', maxLength: 100, description: 'Hostname or IP' },
            os: { type: 'string', enum: ['windows', 'linux', 'any'], description: 'Default "any"' },
            level: { type: 'string', maxLength: 30 },
            keyword: { type: 'string', maxLength: 100 },
            eventId: { type: 'integer', minimum: 0, maximum: 65535 },
            from: { type: 'string', maxLength: 40, description: 'ISO 8601 start time' },
            to: { type: 'string', maxLength: 40, description: 'ISO 8601 end time' },
            limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 50' },
        },
    },
    async run({ host, os = 'any', level, keyword, eventId, from, to, limit = 50 }, { now }) {
        const range = parseRange({ from, to }, now, { defaultHours: 24, maxDays: 7 });

        let names = [];
        if (host) {
            const { rows, exact } = await findMonitors(host, 20);
            const matched = exact.length ? exact : rows;
            names = matched.length ? [...new Set(matched.flatMap(r => [r.name, ...splitIps(r.ip)]).filter(Boolean))] : [host];
        }

        const events = [];
        if (os !== 'linux') {
            const params = [range.from, range.to];
            let sql = "SELECT host, level, eventID, provider AS source, message, timestamp FROM windows_events WHERE timestamp >= ? AND timestamp <= ?";
            sql += hostClause(names, params);
            if (level) { sql += ' AND LOWER(level) = LOWER(?)'; params.push(level); }
            if (eventId !== undefined) { sql += ' AND eventID = ?'; params.push(eventId); }
            if (keyword) { sql += ' AND message LIKE ?'; params.push(`%${keyword}%`); }
            sql += ' ORDER BY timestamp DESC LIMIT ?';
            params.push(limit);
            for (const r of (await scoutDb.all(sql, params)) || []) events.push({ ...r, os: 'windows' });
        }
        if (os !== 'windows' && eventId === undefined) {
            const params = [range.from, range.to];
            let sql = 'SELECT host, tags AS level, filePath AS source, message, timestamp FROM linux_logs WHERE timestamp >= ? AND timestamp <= ?';
            sql += hostClause(names, params);
            if (level) { sql += ' AND LOWER(tags) LIKE LOWER(?)'; params.push(`%${level}%`); }
            if (keyword) { sql += ' AND message LIKE ?'; params.push(`%${keyword}%`); }
            sql += ' ORDER BY timestamp DESC LIMIT ?';
            params.push(limit);
            for (const r of (await scoutDb.all(sql, params)) || []) events.push({ ...r, eventID: null, os: 'linux' });
        }

        events.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
        const page = events.slice(0, limit).map(e => ({
            timestamp: e.timestamp,
            host: e.host,
            os: e.os,
            level: e.level,
            eventID: e.eventID,
            source: e.source,
            message: truncateText(e.message, MESSAGE_CHARS),
        }));
        return { range, count: page.length, events: page };
    },
};
