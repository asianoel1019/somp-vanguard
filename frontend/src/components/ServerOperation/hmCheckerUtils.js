// Pure helpers for the HostMonitor Checker screen: which backup file a request targets, labels, and how the
// view state reacts to compare / status outcomes.
// Default is always "latest" (backupFilename ''), the server re-scans the UNC path on every request.
// A file is only sent while the user has explicitly pinned it in the backup modal. A pin is
// { filename, directory } so two files with the same name in different folders are never confused.

import { resolveEnv } from '../../utils/environments.js';

// ignoredEnvs are stored as environment ids (names / codes still accepted, case-insensitive).
// The modal works with names: ids -> names for display, names -> ids when saving (unknown values kept as typed).
export function ignoredEnvsToNames(ignored, envs) {
    return [...new Set((Array.isArray(ignored) ? ignored : []).map(v => { const e = resolveEnv(v, envs); return e ? e.name : String(v); }))];
}

export function namesToIgnoredEnvs(names, envs) {
    return [...new Set((Array.isArray(names) ? names : []).map(v => { const e = resolveEnv(v, envs); return e ? e.id : String(v); }))];
}

// Badge colour of an environment cell: production environments (isProduction flag) are highlighted
export function envBadgeIsProduction(row, envs) {
    const e = resolveEnv(row && row.envId, envs) || resolveEnv(row && row.env, envs);
    return !!(e && e.isProduction);
}

export function normalizePin(pin) {
    if (!pin) return null;
    if (typeof pin === 'string') {
        const f = pin.trim();
        return f ? { filename: f, directory: '' } : null;
    }
    const filename = typeof pin.filename === 'string' ? pin.filename.trim() : '';
    if (!filename) return null;
    return { filename, directory: typeof pin.directory === 'string' ? pin.directory : '' };
}

export function resolveBackupFilename(pin) {
    const p = normalizePin(pin);
    return p ? p.filename : '';
}

export function buildCompareRequest({ source = 'cmdb', envFilter = 'ALL', customText = '', force = false, pinnedFile = null, useUploads = false } = {}) {
    const pin = normalizePin(pinnedFile);
    const req = {
        source,
        backupFilename: pin ? pin.filename : '',
        envFilter,
        customText,
        force
    };
    if (pin && pin.directory) req.backupDirectory = pin.directory;
    if (useUploads) req.backupSource = 'upload';
    return req;
}

// action: { type: 'pageLoad' } | { type: 'pick', filename, directory } | { type: 'clear' }
export function nextPinnedFile(current, action) {
    switch (action && action.type) {
        case 'pageLoad':
        case 'clear':
            return null;
        case 'pick':
            return normalizePin({ filename: action.filename, directory: action.directory });
        default:
            return normalizePin(current);
    }
}

export function pinChipLabel(pin) {
    const p = normalizePin(pin);
    return `已固定：${p ? p.filename : ''}（改用最新）`;
}

export function describeFileSource(source) {
    if (source === 'unc') return 'UNC 共享';
    if (source === 'upload') return '已上傳的備份';
    return '';
}

export function formatFileSize(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

export const EMPTY_SUMMARY = {
    totalServers: 0,
    allMonitored: 0,
    missingPing: 0,
    missingCpu: 0,
    missingMem: 0,
    missingDisk: 0,
    unmonitored: 0,
    ignoredServers: 0
};

/**
 * What the screen must do after a failed compare request.
 * `data` is the error response body, `pinned` whether a file was pinned for that request.
 * Returns { clearView, uncError, unpin, message }.
 */
export function interpretCompareFailure({ status, data, pinned, fallbackMessage } = {}) {
    const body = data || {};
    const message = '比對失敗: ' + (body.error || fallbackMessage || '未知錯誤');
    if (body.uncError) {
        return { clearView: true, uncError: body.uncError, unpin: false, message };
    }
    if (status === 404 && (body.pinnedMissing || pinned)) {
        return { clearView: true, uncError: '', unpin: true, message: message + ' (已改回最新檔案，請重新比對)' };
    }
    return { clearView: false, uncError: '', unpin: false, message };
}

/**
 * Header file after a status refresh: the latest file unless a file is pinned (then the compare result decides),
 * and nothing at all when the scan failed or found no file.
 */
export function activeFileFromStatus(status, pin) {
    if (!status || status.uncError || !status.hasBackup) return { set: true, file: null };
    if (normalizePin(pin)) return { set: false, file: null };
    return { set: true, file: status.activeFile || null };
}
