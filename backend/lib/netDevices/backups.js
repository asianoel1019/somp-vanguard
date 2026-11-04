// Configuration backups of managed network devices. Files: <DB_DATA_DIR>\netdevice_backups\<device id>\<time>.<ext>;
// index (no contents): network_service/device_config_backups.json. A backup identical to the latest one is not stored
// again (only its check time moves), so a quiet device keeps its history. Keeps NETDEVICE_BACKUP_KEEP per device.
// Contents hold hashed passwords and pre-shared keys: callers restrict reading them (SuperAdmin).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readDataSync } = require('../db');
const { mutateDocument } = require('../docStore');
const profileStore = require('./profileStore');
const { netError } = require('./errors');
const { unifiedDiff } = require('./lineDiff');

const KEY = 'network_service/device_config_backups.json';
const DEFAULT_KEEP = 30;
const ID_RE = /^[\w.-]{1,100}$/;
const BACKUP_ID_RE = /^\d{8}T\d{6}Z(?:-\d+)?$/;
const EXT = { conf: 'conf', xml: 'xml', json: 'json' };

let drivers = null; // set by lib/netDevices/index.js (avoids a require cycle)
const running = new Set();

function setDrivers(d) { drivers = d; }

function keepCount() {
    const n = parseInt(process.env.NETDEVICE_BACKUP_KEEP, 10);
    return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_KEEP;
}

function rootDir() {
    return path.join(process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard', 'netdevice_backups');
}

function deviceDir(id) {
    if (!ID_RE.test(String(id))) throw netError('BAD_REQUEST', 'Invalid device id');
    return path.join(rootDir(), id);
}

function readIndex() {
    const doc = readDataSync(KEY, {});
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
}

const devicesOf = (doc) => (doc.devices && typeof doc.devices === 'object' ? doc.devices : {});
const mutate = (fn, fnName) => mutateDocument(KEY, (doc) => {
    if (!doc.devices || typeof doc.devices !== 'object') doc.devices = {};
    return fn(doc);
}, { defaultValue: {}, fnName, label: 'Device config backups' });

/** Index entry of a device: { backups: [newest first], lastAttempt }. */
function listBackups(id) {
    const e = devicesOf(readIndex())[id] || {};
    return { backups: Array.isArray(e.backups) ? e.backups : [], lastAttempt: e.lastAttempt || null, keep: keepCount() };
}

function canBackup(vendor) {
    return !!(drivers && drivers[vendor] && typeof drivers[vendor].backupConfig === 'function');
}

const stampOf = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function writeFileAtomic(file, content) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
}

/**
 * Back up one device now.
 * @returns {Promise<{ unchanged: boolean, backup: object }>}
 */
async function runBackup(id, { by = 'system', trigger = 'manual', now = new Date() } = {}) {
    const profile = profileStore.getProfile(id);
    if (!profile) throw netError('NOT_CONFIGURED', 'This device has no management connection');
    if (profile.enabled === false) throw netError('NOT_CONFIGURED', 'The management connection of this device is disabled');
    if (!canBackup(profile.vendor)) throw netError('UNSUPPORTED', 'Configuration backup is not available for this vendor');
    if (running.has(id)) throw netError('BAD_REQUEST', 'A backup of this device is already running');
    running.add(id);
    const attempt = { at: now.toISOString(), by, trigger };
    try {
        let result;
        try {
            result = await drivers[profile.vendor].backupConfig(profile);
        } catch (err) {
            mutate((doc) => { doc.devices[id] = { ...(doc.devices[id] || {}), lastAttempt: { ...attempt, ok: false, error: String(err.message || err).slice(0, 300) } }; }, 'netDevices.backupFailed');
            throw err;
        }
        const content = String(result && result.content || '');
        if (!content.trim()) {
            const err = netError('OTHER', 'The device returned an empty configuration');
            mutate((doc) => { doc.devices[id] = { ...(doc.devices[id] || {}), lastAttempt: { ...attempt, ok: false, error: err.message } }; }, 'netDevices.backupFailed');
            throw err;
        }
        const sha256 = crypto.createHash('sha256').update(content).digest('hex');
        const latest = listBackups(id).backups[0];
        if (latest && latest.sha256 === sha256 && fs.existsSync(path.join(deviceDir(id), latest.file))) {
            let entry = latest;
            mutate((doc) => {
                const e = doc.devices[id] || { backups: [] };
                if (e.backups && e.backups[0] && e.backups[0].id === latest.id) {
                    e.backups[0] = { ...e.backups[0], checkedAt: attempt.at };
                    entry = e.backups[0];
                }
                e.lastAttempt = { ...attempt, ok: true, unchanged: true, backupId: latest.id };
                doc.devices[id] = e;
            }, 'netDevices.backupUnchanged');
            return { unchanged: true, backup: entry };
        }

        const dir = deviceDir(id);
        fs.mkdirSync(dir, { recursive: true });
        const ext = EXT[result.format] || 'conf';
        let backupId = stampOf(now);
        for (let n = 1; fs.existsSync(path.join(dir, `${backupId}.${ext}`)); n += 1) backupId = `${stampOf(now)}-${n}`;
        const file = `${backupId}.${ext}`;
        writeFileAtomic(path.join(dir, file), content);
        const entry = {
            id: backupId, file, at: attempt.at, checkedAt: attempt.at, size: Buffer.byteLength(content), sha256,
            lines: content.split('\n').length, vendor: profile.vendor, format: ext, by, trigger,
        };
        let removed = [];
        mutate((doc) => {
            const e = doc.devices[id] || { backups: [] };
            const list = [entry, ...(Array.isArray(e.backups) ? e.backups : [])];
            removed = list.slice(keepCount());
            e.backups = list.slice(0, keepCount());
            e.lastAttempt = { ...attempt, ok: true, unchanged: false, backupId };
            doc.devices[id] = e;
        }, 'netDevices.backupSaved');
        for (const old of removed) {
            try { fs.rmSync(path.join(dir, path.basename(old.file)), { force: true }); } catch (e) { /* next prune retries */ }
        }
        return { unchanged: false, backup: entry };
    } finally {
        running.delete(id);
    }
}

/** The stored entry and its file contents. */
function readBackup(id, backupId) {
    if (!BACKUP_ID_RE.test(String(backupId))) throw netError('BAD_REQUEST', 'Invalid backup id');
    const entry = listBackups(id).backups.find(b => b.id === backupId);
    if (!entry) return null;
    const file = path.join(deviceDir(id), path.basename(entry.file));
    if (!fs.existsSync(file)) throw netError('OTHER', 'The backup file is missing on the server');
    return { entry, content: fs.readFileSync(file, 'utf8') };
}

/** Differences between two backups of a device (`from` older, `to` newer). */
function diffBackups(id, fromId, toId) {
    const a = readBackup(id, fromId);
    const b = readBackup(id, toId);
    if (!a || !b) return null;
    return { from: a.entry, to: b.entry, ...unifiedDiff(a.content, b.content) };
}

/** Delete every backup of a removed device (files and index). */
function removeDevice(id) {
    if (!ID_RE.test(String(id))) return false;
    let existed = false;
    mutate((doc) => { existed = !!doc.devices[id]; delete doc.devices[id]; return existed; }, 'netDevices.backupRemoveDevice');
    try { fs.rmSync(deviceDir(id), { recursive: true, force: true }); } catch (e) { /* ignore */ }
    return existed;
}

// ---------------------------------------------------------------- daily schedule (worker)

/** 'HH:MM' of NETDEVICE_BACKUP_SCHEDULE, or null when off / invalid. */
function scheduleTime() {
    const v = String(process.env.NETDEVICE_BACKUP_SCHEDULE || '').trim();
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v);
    return m ? { h: Number(m[1]), m: Number(m[2]), text: `${m[1].padStart(2, '0')}:${m[2]}` } : null;
}

const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Due when the time has come today, within one hour after it, and today's run is not recorded yet. */
function isDue(now, lastRunDate) {
    const t = scheduleTime();
    if (!t) return false;
    const at = new Date(now);
    at.setHours(t.h, t.m, 0, 0);
    const diff = now.getTime() - at.getTime();
    return diff >= 0 && diff < 60 * 60 * 1000 && lastRunDate !== localDate(now);
}

/**
 * One scheduler tick: when due, records today's run first (a restart never runs it twice), then backs up every
 * enabled device whose vendor supports it, one at a time.
 * @returns {Promise<{ skipped: string } | { results: Array<{ id, ok, unchanged?, error? }> }>}
 */
async function scheduledRun(now = new Date()) {
    if (!scheduleTime()) return { skipped: 'disabled' };
    const doc = readIndex();
    if (!isDue(now, doc.schedule && doc.schedule.lastRunDate)) return { skipped: 'not-due' };
    let claimed = false;
    mutate((d) => {
        if (d.schedule && d.schedule.lastRunDate === localDate(now)) return false;
        d.schedule = { lastRunDate: localDate(now), startedAt: now.toISOString() };
        claimed = true;
        return true;
    }, 'netDevices.backupScheduleClaim');
    if (!claimed) return { skipped: 'already-ran' };

    const results = [];
    const profiles = profileStore.listSummaries();
    for (const [id, p] of Object.entries(profiles)) {
        if (!p.enabled || !canBackup(p.vendor)) continue;
        try {
            const r = await runBackup(id, { by: 'system', trigger: 'schedule' });
            results.push({ id, ok: true, unchanged: r.unchanged });
        } catch (err) {
            results.push({ id, ok: false, error: err.message });
        }
    }
    mutate((d) => {
        d.schedule = { ...(d.schedule || {}), finishedAt: new Date().toISOString(), devices: results.length, failed: results.filter(r => !r.ok).length };
    }, 'netDevices.backupScheduleDone');
    return { results };
}

function scheduleInfo() {
    const t = scheduleTime();
    const s = readIndex().schedule || null;
    return { schedule: t ? t.text : null, keep: keepCount(), lastRun: s };
}

module.exports = {
    KEY, setDrivers, canBackup, listBackups, runBackup, readBackup, diffBackups, removeDevice,
    scheduledRun, scheduleInfo, isDue, scheduleTime, keepCount, rootDir,
};
