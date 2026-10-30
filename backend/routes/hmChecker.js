const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const {
    getTodayLocalDateStr,
    getConfig,
    saveConfig,
    validateConfigInput,
    getTodayCache,
    saveTodayCache,
    clearTodayCache,
    getActualEnvironments,
    getEnvironmentOptions,
    resolveBackupFiles,
    pickBackupFile,
    toFileInfo,
    testDirectoryAccessAsync,
    saveUploadedBackup,
    getOrParseFile,
    clearParseCache,
    clearScanCache,
    loadCmdbServers,
    compareServersWithHostMonitor,
    buildHostMonitorImport,
    attachCmdbOs,
    parseExcelPastedText,
    MAX_UPLOAD_BYTES
} = require('../services/hostMonitorCheckerService');

router.use(requireAuth);
router.use(checkFeature('hmChecker'));
router.use(checkRole(['Viewer', 'Operator', 'SuperAdmin']));

const MAX_STATUS_FILES = 50;
const MAX_CUSTOM_TEXT = 2 * 1024 * 1024;
// Upload bodies may reach 50 MB of text; index.js skips its global 10 MB parser for this path, so the
// (larger) parser below only ever runs after authentication / feature / role checks.
const uploadJson = express.json({ limit: Math.ceil(MAX_UPLOAD_BYTES * 1.2) });

function noBackupMessage(resolved) {
    if (resolved.source === 'upload') {
        return resolved.uploadError
            ? `無法讀取已上傳的備份檔: ${resolved.uploadError}`
            : (resolved.uncPath
                ? '尚未上傳任何備份檔，請先於「備份與 UNC 管理」上傳備份檔內容'
                : '尚未設定 UNC 備份目錄，也沒有已上傳的備份檔。請於「備份與 UNC 管理」設定 UNC 路徑或上傳備份檔');
    }
    return `在 UNC 目錄找不到符合檔名規則 (${resolved.config.filePattern}) 的 HostMonitor 備份檔: ${resolved.uncPath}`;
}

/**
 * GET /api/hm-checker/config
 */
router.get('/config', (req, res) => {
    try {
        const config = getConfig();
        res.json({
            success: true,
            uncPath: config.uncPath,
            ignoredEnvs: config.ignoredEnvs,
            scanTimeoutSec: config.scanTimeoutSec,
            filePattern: config.filePattern,
            availableEnvs: getActualEnvironments(),
            environments: getEnvironmentOptions()
        });
    } catch (e) {
        console.error('[HM_checker] /config GET error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/hm-checker/config
 * Save UNC path, ignored environments, scan timeout and file name pattern (validated)
 */
router.post('/config', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const checked = validateConfigInput(req.body || {});
        if (!checked.ok) return res.status(400).json({ error: checked.error });
        const updated = saveConfig(checked.value);

        // Config changes affect which file / which servers are compared
        clearParseCache();
        clearScanCache();
        clearTodayCache();

        auditLog(
            req.user?.username || 'SYSTEM',
            'HostMonitor Checker',
            `Updated HM_checker config (UNC: ${updated.uncPath || 'none'}, Pattern: ${updated.filePattern}, Timeout: ${updated.scanTimeoutSec}s, Ignored Envs: ${(updated.ignoredEnvs || []).join(',')})`
        );

        res.json({ success: true, config: updated });
    } catch (e) {
        console.error('[HM_checker] /config POST error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/hm-checker/test-unc
 */
router.post('/test-unc', checkRole(['Operator', 'SuperAdmin']), async (req, res) => {
    try {
        const { uncPath, filePattern } = req.body || {};
        if (typeof uncPath !== 'string' || uncPath.length > 1024) {
            return res.json({ success: false, error: '路徑不得為空，且長度不得超過 1024 字元' });
        }
        let pattern = null;
        if (filePattern !== undefined) {
            const checked = validateConfigInput({ filePattern });
            if (!checked.ok) return res.json({ success: false, error: checked.error });
            pattern = checked.value.filePattern;
        }
        res.json(await testDirectoryAccessAsync(uncPath, { pattern }));
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * GET /api/hm-checker/status
 * One async scan: which backup files exist, which is the latest (active), and whether the scan failed (uncError)
 */
router.get('/status', async (req, res) => {
    try {
        const resolved = await resolveBackupFiles({ backupSource: req.query.backupSource });
        const { config, files } = resolved;
        const availableEnvs = getActualEnvironments();
        const base = {
            success: true,
            source: resolved.source,
            uncConfigured: !!resolved.uncPath,
            uncPath: resolved.uncPath,
            availableEnvs,
            environments: getEnvironmentOptions(),
            config
        };

        if (resolved.uncError) {
            return res.json({ ...base, hasBackup: false, uncError: resolved.uncError, availableFiles: [], hasTodayCache: false });
        }
        if (files.length === 0) {
            return res.json({ ...base, hasBackup: false, message: noBackupMessage(resolved), uploadError: resolved.uploadError, availableFiles: [], hasTodayCache: false });
        }

        const activeFile = toFileInfo(files[0]);
        const todayCache = getTodayCache(files[0], config.ignoredEnvs);
        let meta = null;
        let parseError;
        try {
            const parsed = await getOrParseFile(files[0]);
            meta = { totalTests: parsed.totalTests, totalFolders: parsed.totalFolders, headerMeta: parsed.headerMeta };
        } catch (e) {
            parseError = e.message;
        }

        res.json({
            ...base,
            hasBackup: true,
            activeFile,
            availableFiles: files.slice(0, MAX_STATUS_FILES).map(toFileInfo),
            totalAvailable: files.length,
            hasTodayCache: !!todayCache,
            cachedAt: todayCache?.cachedAt,
            meta,
            parseError
        });
    } catch (e) {
        console.error('[HM_checker] /status error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * GET /api/hm-checker/today-cache
 * Today's comparison, only when it was computed from the CURRENT latest file
 */
router.get('/today-cache', async (req, res) => {
    try {
        const resolved = await resolveBackupFiles({ backupSource: req.query.backupSource });
        const latest = resolved.files[0];
        const todayCache = latest ? getTodayCache(latest, resolved.config.ignoredEnvs) : null;
        if (todayCache) {
            return res.json({ success: true, hasCache: true, ...todayCache });
        }
        res.json({ success: true, hasCache: false, uncError: resolved.uncError });
    } catch (e) {
        console.error('[HM_checker] /today-cache error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/hm-checker/compare
 * Compare CMDB/custom servers with a HostMonitor backup. backupFilename '' (default) = latest file, re-scanned on
 * every request; a non-empty name pins that exact file. backupSource 'upload' = use uploaded files instead of UNC.
 */
router.post('/compare', async (req, res) => {
    try {
        const body = req.body || {};
        const source = body.source === 'custom' ? 'custom' : 'cmdb';
        const customText = typeof body.customText === 'string' ? body.customText : '';
        const backupFilename = typeof body.backupFilename === 'string' ? body.backupFilename : '';
        const backupDirectory = typeof body.backupDirectory === 'string' ? body.backupDirectory : '';
        const envFilter = typeof body.envFilter === 'string' ? body.envFilter : '';
        const force = body.force === true;
        if (customText.length > MAX_CUSTOM_TEXT) {
            return res.status(400).json({ error: '貼上的清單過大' });
        }

        const resolved = await resolveBackupFiles({ backupSource: body.backupSource });
        if (resolved.uncError) {
            return res.status(503).json({
                success: false,
                error: `無法存取 UNC 備份目錄，未使用任何備份檔: ${resolved.uncError}`,
                uncError: resolved.uncError,
                uncPath: resolved.uncPath
            });
        }
        if (resolved.files.length === 0) {
            return res.status(404).json({ error: noBackupMessage(resolved) });
        }

        const pinned = !!backupFilename && backupFilename !== 'latest';
        const targetBackup = pickBackupFile(resolved.files, backupFilename, backupDirectory);
        if (!targetBackup) {
            return res.status(404).json({ error: `找不到指定的備份檔: ${backupFilename}（可能已被移除，請改用最新檔案）`, pinnedMissing: true });
        }
        const file = toFileInfo(targetBackup);
        const ignoredEnvs = resolved.config.ignoredEnvs || [];
        const cacheable = source === 'cmdb' && (!envFilter || envFilter === 'ALL') && !pinned;

        if (cacheable && !force) {
            const todayCache = getTodayCache(targetBackup, ignoredEnvs);
            if (todayCache) {
                return res.json({
                    success: true,
                    fromCache: true,
                    pinned: false,
                    source: todayCache.source,
                    backupFile: todayCache.backupFile,
                    file,
                    backupMeta: todayCache.backupMeta,
                    summary: todayCache.summary,
                    results: todayCache.results,
                    cachedAt: todayCache.cachedAt
                });
            }
        }

        const parsedData = await getOrParseFile(targetBackup);

        let servers;
        if (source === 'custom') {
            servers = attachCmdbOs(parseExcelPastedText(customText));
            if (servers.length === 0) {
                return res.status(400).json({ error: '未在貼上內容中解析出有效的主機資料。格式請包含：ZONE, HOSTNAME, ServiceLAN IP' });
            }
        } else {
            servers = loadCmdbServers(envFilter);
        }

        const comparison = compareServersWithHostMonitor(servers, parsedData, ignoredEnvs);

        const responsePayload = {
            success: true,
            fromCache: false,
            pinned,
            source,
            backupFile: targetBackup.filename,
            file,
            backupMeta: parsedData.headerMeta,
            summary: comparison.summary,
            results: comparison.results
        };

        if (cacheable) {
            saveTodayCache({ ...responsePayload, ignoredEnvs });
        }

        res.json(responsePayload);
    } catch (e) {
        console.error('[HM_checker] /compare error:', e);
        res.status(e.status || 500).json({ error: e.message });
    }
});

/**
 * POST /api/hm-checker/generate-import
 */
router.post('/generate-import', checkRole(['Operator', 'SuperAdmin']), (req, res) => {
    try {
        const { servers = [], metrics = ['ping'], options = {} } = req.body || {};

        if (!Array.isArray(servers) || servers.length === 0) {
            return res.status(400).json({ error: 'No servers provided to generate import file.' });
        }

        // CPU / MEM / Disk methods differ between Windows and Linux: the OS always comes from the CMDB (by IP)
        const { content, skipped } = buildHostMonitorImport(attachCmdbOs(servers), metrics, options);
        const dateStr = getTodayLocalDateStr();
        const metricName = metrics.join('-');
        const filename = `HM-Import-${metricName}-${dateStr}.txt`;

        auditLog(
            req.user?.username || 'SYSTEM',
            'HostMonitor Checker',
            `Generated HostMonitor import text file for ${servers.length} servers (metrics: ${metrics.join(',')})`
        );

        res.json({
            success: true,
            filename,
            content,
            totalServers: servers.length,
            skippedUnknownOs: skipped
        });
    } catch (e) {
        console.error('[HM_checker] /generate-import error:', e);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /api/hm-checker/upload-backup
 * Stores a pasted backup in the private upload directory (app data dir, never under /docs)
 */
router.post('/upload-backup', checkRole(['Operator', 'SuperAdmin']), uploadJson, async (req, res) => {
    try {
        const { filename, content } = req.body || {};
        const saved = await saveUploadedBackup({ filename, content, overwrite: (req.body || {}).overwrite === true });

        clearParseCache();
        clearScanCache();
        clearTodayCache();

        auditLog(
            req.user?.username || 'SYSTEM',
            'HostMonitor Checker',
            `Uploaded new HostMonitor backup file: ${saved.filename} (${saved.size} bytes)`
        );

        res.json({ success: true, filename: saved.filename, size: saved.size, overwritten: saved.overwritten });
    } catch (e) {
        if (e.status) return res.status(e.status).json({ error: e.message, ...(e.status === 409 ? { exists: true } : {}) });
        console.error('[HM_checker] /upload-backup error:', e);
        res.status(500).json({ error: e.message });
    }
});

// JSON errors (oversized / malformed bodies) instead of Express's default HTML page
router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: `備份檔大小超過上限 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` });
    }
    if (err && err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: '請求內容不是有效的 JSON' });
    }
    if (err && err.status && err.status < 500) {
        return res.status(err.status).json({ error: err.message });
    }
    return next(err);
});

module.exports = router;
