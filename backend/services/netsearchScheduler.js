const fs = require('fs');
const path = require('path');
const { resolveDevicePaths } = require('../lib/netsearchDiscovery');
const { parseConfig, parseFqdnFile } = require('../lib/netsearchParser');
const { auditLog } = require('../lib/logger');

// Cache path
const BASE_DATA_DIR = process.env.DB_DATA_DIR || 'C:\\ProgramData\\somp-vanguard';
const CACHE_PATH = path.join(BASE_DATA_DIR, 'network_service', 'netsearch_cache.json');

// In-memory state
const state = {
  parsedConfigs: [],   // [{ id, filename, parsed }]
  fqdnRecords:   [],   // [{ id, fqdn, domain, ip, owner, type, geoInfo }]
  lastLoaded:    null, // ISO string
  loading:       false,
};

const { readDataSync, writeDataSync } = require('../lib/db');

function readCache() {
  try {
    const cached = readDataSync('network_service/netsearch_cache.json', null);
    if (cached) {
      state.parsedConfigs = cached.parsedConfigs || [];
      state.fqdnRecords   = cached.fqdnRecords   || [];
      state.lastLoaded    = cached.lastLoaded     || null;
      console.log(`[NetSearch] Restored ${state.parsedConfigs.length} devices from cache (${state.lastLoaded})`);
    }
  } catch (err) {
    console.warn('[NetSearch] Could not read cache:', err.message);
  }
}

function writeCache() {
  try {
    writeDataSync('network_service/netsearch_cache.json', {
      parsedConfigs: state.parsedConfigs,
      fqdnRecords:   state.fqdnRecords,
      lastLoaded:    state.lastLoaded,
    });
    console.log('[NetSearch] Cache written.');
  } catch (err) {
    console.warn('[NetSearch] Could not write cache:', err.message);
  }
}

async function loadAllConfigs() {
  if (state.loading) return { ok: false, error: 'Already loading' };

  let backupRoot = (process.env.NETSEARCH_BACKUP_ROOT || '').replace(/['"]/g, '').trim();
  if (!backupRoot) {
    console.log('[NetSearch] NETSEARCH_BACKUP_ROOT is not configured. Feature is disabled.');
    return { ok: false, error: 'NETSEARCH_BACKUP_ROOT not configured (feature disabled)', disabled: true };
  }

  state.loading = true;
  console.log('[NetSearch] Starting config reload...');
  try {
    backupRoot = path.normalize(backupRoot);

    let fqdnFile = (process.env.NETSEARCH_FQDN_FILE || '').replace(/['"]/g, '').trim();
    if (fqdnFile) fqdnFile = path.normalize(fqdnFile);

    let devices = [];
    try {
      devices = JSON.parse(process.env.NETSEARCH_DEVICES || '[]');
    } catch (err) {
      console.error('[NetSearch] Invalid NETSEARCH_DEVICES format:', err.message);
    }

    if (!fs.existsSync(backupRoot)) {
      console.warn(`[NetSearch] backupRoot path does not exist: ${backupRoot}`);
      state.loading = false;
      return { ok: false, error: `backupRoot path does not exist: ${backupRoot}` };
    }

    const newParsedConfigs = [];
    const resolvedFiles = resolveDevicePaths(devices, backupRoot);

    for (const entry of resolvedFiles) {
      const filePath = entry.path;
      if (!fs.existsSync(filePath)) {
        console.warn(`[NetSearch] File not found, skipping: ${filePath}`);
        continue;
      }
      const text = fs.readFileSync(filePath, 'utf8');
      const parsed = parseConfig(text);
      if (parsed.hostname && /^Unknown-/.test(parsed.hostname)) {
        const stem = path.basename(filePath)
          .replace(/\.[^.]+$/, '')
          .replace(/[_\-]+config$/i, '')
          .replace(/[_\-]+running$/i, '')
          .trim();
        if (stem) parsed.hostname = stem;
      }
      const id = `cfg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      newParsedConfigs.push({ id, filename: path.basename(filePath), parsed });
      console.log(`[NetSearch] Parsed: ${parsed.hostname} (${parsed.type})`);
    }

    let newFqdnRecords = [];
    if (fqdnFile && fs.existsSync(fqdnFile)) {
      const text = fs.readFileSync(fqdnFile, 'utf8');
      newFqdnRecords = parseFqdnFile(text);
      console.log(`[NetSearch] FQDN records: ${newFqdnRecords.length}`);
    }

    state.parsedConfigs = newParsedConfigs;
    state.fqdnRecords   = newFqdnRecords;
    state.lastLoaded = new Date().toISOString();
    console.log(`[NetSearch] Config reload complete. Loaded ${newParsedConfigs.length} devices.`);
    writeCache();
    
    try { require('../lib/websocket').broadcastEvent('IPAM_SCAN_FINISHED', { timestamp: state.lastLoaded }); } catch(e) {}
    
    return { ok: true, count: newParsedConfigs.length };
  } catch (err) {
    console.error('[NetSearch] Failed to load configs:', err);
    return { ok: false, error: err.message };
  } finally {
    state.loading = false;
  }
}

let lastTickMinute = -1;
let schedulerInterval = null;

function initNetSearchScheduler() {
  readCache();

  // Load configs on start only if cache is empty AND backupRoot is configured
  const initialBackupRoot = (process.env.NETSEARCH_BACKUP_ROOT || '').replace(/['"]/g, '').trim();
  if (state.parsedConfigs.length === 0 && initialBackupRoot) {
    loadAllConfigs();
  }

  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }

  // Scheduler Poller on native local time
  console.log('[Scheduler] NetSearch Scheduler initialized.');

  const matchCronField = (value, field) => {
    if (field === '*') return true;
    if (field.includes(',')) return field.split(',').some(part => matchCronField(value, part));
    if (field.includes('/')) {
        const step = parseInt(field.split('/')[1], 10);
        return value % step === 0;
    }
    return value === parseInt(field, 10);
  };

  schedulerInterval = setInterval(() => {
    // 1. If NETSEARCH_BACKUP_ROOT is blank, NetSearch is completely disabled
    const currentBackupRoot = (process.env.NETSEARCH_BACKUP_ROOT || '').replace(/['"]/g, '').trim();
    if (!currentBackupRoot) {
      return;
    }

    // 2. If NETSEARCH_CRON_SCHEDULE is blank or not set, cron schedule is disabled
    const cronSchedule = (process.env.NETSEARCH_CRON_SCHEDULE || '').trim();
    if (!cronSchedule) {
      return;
    }
    const schedules = cronSchedule.split(',').map(s => s.trim()).filter(s => s);
    if (schedules.length === 0) return;

    const now = new Date();
    const currentM = now.getMinutes();
    const currentH = now.getHours();

    let trigger = false;
    for (const schedule of schedules) {
      const parts = schedule.split(/\s+/);
      if (parts.length >= 5) {
        const minMatch = matchCronField(currentM, parts[0]);
        const hourMatch = matchCronField(currentH, parts[1]);
        const domMatch = matchCronField(now.getDate(), parts[2]);
        const monMatch = matchCronField(now.getMonth() + 1, parts[3]);
        const dowMatch = matchCronField(now.getDay(), parts[4]);

        if (minMatch && hourMatch && domMatch && monMatch && dowMatch) {
          trigger = true;
          break;
        }
      }
    }

    if (trigger && lastTickMinute !== currentM) {
      lastTickMinute = currentM;
      console.log(`[Scheduler] [${new Date().toLocaleString()}] NetSearch Scheduled Import Triggered.`);
      auditLog('SYSTEM', 'NetSearch', 'Scheduled configuration reload started');
      loadAllConfigs().then(res => {
        if (res.ok) {
          auditLog('SYSTEM', 'NetSearch', 'Scheduled configuration reload completed');
        } else {
          auditLog('SYSTEM', 'NetSearch', `Scheduled configuration reload failed: ${res.error}`);
        }
      });
    } else if (!trigger) {
      let minMatchesAny = false;
      for (const schedule of schedules) {
        const parts = schedule.split(/\s+/);
        if (parts.length >= 5 && matchCronField(currentM, parts[0])) {
          minMatchesAny = true;
        }
      }
      if (!minMatchesAny) {
        lastTickMinute = -1;
      }
    }
  }, 10000);
}

module.exports = {
  initNetSearchScheduler,
  loadAllConfigs,
  state
};
