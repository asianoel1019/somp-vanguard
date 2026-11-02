// Shared console format for the web and worker processes:
//   [2026-11-02T08:00:06.123] [Worker] [INFO] [Inventory] message
// Time is SYSTEM_TIMEZONE (default Asia/Taipei). A timestamp the caller already put at the start of its message is
// removed, so a line never carries two (differently zoned) times. Once enableFileSink() is called every line is also
// appended to <logDir>/app_YYYY-MM-DD.log (rotated and archived by lib/logger.js).
const fs = require('fs');
const path = require('path');
const util = require('util');

const LEVELS = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' };
// [2026-11-02T08:00:06] / [2026-11-02 08:00:06.123] / 2026-11-02T00:00:07.143Z: (optionally followed by a space)
const LEADING_TS = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?\]?:?\s*/;

const formatters = new Map();
function partsFormatter(tz) {
    if (!formatters.has(tz)) {
        formatters.set(tz, new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
        }));
    }
    return formatters.get(tz);
}

/** 'YYYY-MM-DDTHH:mm:ss.SSS' in the given time zone (falls back to UTC on an invalid zone). */
function localTimestamp(date = new Date(), tz = process.env.SYSTEM_TIMEZONE || 'Asia/Taipei') {
    let p;
    try { p = partsFormatter(tz).formatToParts(date); } catch (e) { return date.toISOString().slice(0, 23); }
    const v = {};
    for (const { type, value } of p) v[type] = value;
    return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}:${v.second}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function stripLeadingTimestamp(text) {
    return typeof text === 'string' ? text.replace(LEADING_TS, '') : text;
}

/** One formatted line (without newline) for a console call. */
function formatLine(role, method, args, date = new Date()) {
    const rest = args.length && typeof args[0] === 'string' ? [stripLeadingTimestamp(args[0]), ...args.slice(1)] : args;
    return `[${localTimestamp(date)}] [${role}] [${LEVELS[method] || 'INFO'}] ${util.format(...rest)}`;
}

let sink = null; // { dir, day, fd }

function writeToFile(line) {
    if (!sink) return;
    try {
        const day = line.slice(1, 11);
        if (sink.fd === null || sink.day !== day) {
            if (sink.fd !== null) { try { fs.closeSync(sink.fd); } catch (e) { /* already closed */ } }
            sink.day = day;
            sink.fd = fs.openSync(path.join(sink.dir, `app_${day}.log`), 'a');
        }
        fs.writeSync(sink.fd, line + '\n');
    } catch (e) {
        // the file is a copy of the console output: never let it break logging
        sink.fd = null;
    }
}

/** Replaces console.log / info / warn / error of this process with the shared format. */
function installConsole(role) {
    for (const method of Object.keys(LEVELS)) {
        const original = console[method].bind(console);
        console[method] = (...args) => {
            const line = formatLine(role, method, args);
            original(line);
            writeToFile(line);
        };
    }
}

/** Starts copying every console line to <dir>/app_YYYY-MM-DD.log (call once the data directory is known). */
function enableFileSink(dir) {
    if (process.env.APP_LOG_FILE === 'false') return false;
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        return false;
    }
    if (sink && sink.fd !== null) { try { fs.closeSync(sink.fd); } catch (e) { /* already closed */ } }
    sink = { dir, day: null, fd: null };
    return true;
}

function disableFileSink() {
    if (sink && sink.fd !== null) { try { fs.closeSync(sink.fd); } catch (e) { /* already closed */ } }
    sink = null;
}

module.exports = { installConsole, enableFileSink, disableFileSink, formatLine, localTimestamp, stripLeadingTimestamp, writeToFile };
