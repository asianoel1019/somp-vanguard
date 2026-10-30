import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
    FiServer, FiSearch, FiFilter, FiDownload, FiCheckCircle, 
    FiAlertTriangle, FiXCircle, FiRefreshCw, FiCopy, FiCheck, 
    FiFileText, FiUploadCloud, FiSliders, FiList, FiLayers, 
    FiInfo, FiExternalLink, FiClipboard, FiSettings, FiSlash
} from 'react-icons/fi';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { buildCompareRequest, nextPinnedFile, pinChipLabel, describeFileSource, formatFileSize, interpretCompareFailure, activeFileFromStatus, EMPTY_SUMMARY, ignoredEnvsToNames, namesToIgnoredEnvs, envBadgeIsProduction } from './hmCheckerUtils';

// Helper to sort IPs numerically
function compareIPs(ipA, ipB) {
    const partsA = (ipA || '').split('.').map(n => parseInt(n, 10) || 0);
    const partsB = (ipB || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 4; i++) {
        if (partsA[i] !== partsB[i]) return partsA[i] - partsB[i];
    }
    return 0;
}

// OS family from the CMDB: decides which HostMonitor methods the import file uses for CPU / Mem / Disk
const OS_BADGES = {
    windows: { label: 'Windows', color: '#60a5fa' },
    linux: { label: 'Linux', color: '#34d399' },
    unknown: { label: 'OS 未知', color: '#fbbf24' }
};
function OsBadge({ osFamily, os }) {
    const badge = OS_BADGES[osFamily];
    if (!badge) return null;
    return (
        <span
            title={osFamily === 'unknown' ? `CMDB OS: ${os || '(未填)'}，產出匯入檔時會略過 CPU / Mem / Disk` : `CMDB OS: ${os}`}
            style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 6, color: badge.color, border: `1px solid ${badge.color}55` }}
        >
            {badge.label}
        </span>
    );
}

const HmChecker = () => {
    const { showToast } = useToast();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const isOperatorOrAdmin = ['SuperAdmin', 'Operator'].includes(user.role);

    // Main States
    const [loading, setLoading] = useState(true);
    const [statusData, setStatusData] = useState(null);
    const [activeFile, setActiveFile] = useState(null); // file actually used: { filename, directory, modifiedAt, size, source }
    const [pinnedFile, setPinnedFile] = useState(null); // null = always the latest file (default); set only by an explicit pick: { filename, directory }
    const [useUploads, setUseUploads] = useState(false); // explicit "使用已上傳的備份"
    const [uncError, setUncError] = useState('');
    const [scanTimeoutInput, setScanTimeoutInput] = useState('20');
    const [filePatternInput, setFilePatternInput] = useState('');
    const [comparisonSource, setComparisonSource] = useState('cmdb'); // 'cmdb' | 'custom'
    const [customText, setCustomText] = useState('');
    const [cmdbEnvFilter, setCmdbEnvFilter] = useState('ALL');
    const [availableEnvs, setAvailableEnvs] = useState([]);
    const [ignoredEnvs, setIgnoredEnvs] = useState([]);
    const [envOptions, setEnvOptions] = useState([]); // global environments: [{ id, name, isProduction, isDefault }]
    const [lastComparedAt, setLastComparedAt] = useState(null);
    const [isFromCache, setIsFromCache] = useState(false);
    
    // Comparison Results
    const [summary, setSummary] = useState({
        totalServers: 0,
        allMonitored: 0,
        missingPing: 0,
        missingCpu: 0,
        missingMem: 0,
        missingDisk: 0,
        unmonitored: 0,
        ignoredServers: 0
    });
    const [results, setResults] = useState([]);

    // Filter & Search
    const [searchKeyword, setSearchKeyword] = useState('');
    const [activeQuickFilter, setActiveQuickFilter] = useState('ALL'); // 'ALL' | 'NO_PING' | 'NO_CPU' | 'NO_MEM' | 'NO_DISK' | 'ANY_MISSING' | 'ALL_OK'
    const [envFilter, setEnvFilter] = useState('ALL');

    // Selection
    const [selectedIps, setSelectedIps] = useState(new Set());

    // Modals
    const [showImportModal, setShowImportModal] = useState(false);
    const [importModalTargetServers, setImportModalTargetServers] = useState([]);
    const [importMetrics, setImportMetrics] = useState({ ping: true, cpu: true, mem: true, disk: true });
    const [importOptions, setImportOptions] = useState({
        rmAgent: '10.88.105.97',
        mode: 'missing_only' // 'missing_only' | 'force_all'
    });
    const [generatedImportText, setGeneratedImportText] = useState('');
    const [importSkipped, setImportSkipped] = useState([]);
    const [isGenerating, setIsGenerating] = useState(false);

    // Detail Modal
    const [detailServer, setDetailServer] = useState(null);

    // Backup & UNC Manager Modal
    const [showBackupModal, setShowBackupModal] = useState(false);
    const [uncPathInput, setUncPathInput] = useState('');
    const [uncTestStatus, setUncTestStatus] = useState(null);
    const [isTestingUnc, setIsTestingUnc] = useState(false);
    const [uploadFilename, setUploadFilename] = useState('');
    const [uploadContent, setUploadContent] = useState('');
    const [isUploading, setIsUploading] = useState(false);

    // Ignored Envs Modal
    const [showIgnoredEnvsModal, setShowIgnoredEnvsModal] = useState(false);
    const [tempIgnoredEnvs, setTempIgnoredEnvs] = useState([]);
    const [isSavingEnvs, setIsSavingEnvs] = useState(false);

    // Initial Load: Check Today's Cache and load config
    useEffect(() => {
        initPageData();
    }, []);

    // Fetch the backup file list (the server re-scans the UNC path on every call). Returns the status payload.
    const refreshStatus = async (uploads = useUploads, pin = pinnedFile) => {
        const statusRes = await api.get('/hm-checker/status', { params: uploads ? { backupSource: 'upload' } : {} });
        setStatusData(statusRes.data);
        setUncError(statusRes.data.uncError || '');
        const header = activeFileFromStatus(statusRes.data, pin);
        if (header.set) setActiveFile(header.file);
        return statusRes.data;
    };

    // Forget the previous result (header file, summary, rows) so nothing stale stays on screen
    const clearView = () => {
        setActiveFile(null);
        setSummary({ ...EMPTY_SUMMARY });
        setResults([]);
        setSelectedIps(new Set());
    };

    const initPageData = async () => {
        setLoading(true);
        // Opening the screen never pins a file: always start from the latest one
        setPinnedFile(nextPinnedFile(null, { type: 'pageLoad' }));
        try {
            // 1. Fetch config and environments
            const cfgRes = await api.get('/hm-checker/config');
            if (cfgRes.data?.success) {
                setUncPathInput(cfgRes.data.uncPath || '');
                // stored as ids; the modal and chips work with names
                const envList = cfgRes.data.environments || [];
                setEnvOptions(envList);
                setIgnoredEnvs(ignoredEnvsToNames(cfgRes.data.ignoredEnvs || [], envList));
                setAvailableEnvs(cfgRes.data.availableEnvs || []);
                setScanTimeoutInput(String(cfgRes.data.scanTimeoutSec || 20));
                setFilePatternInput(cfgRes.data.filePattern || '');
            }

            // 2. Scan for the latest backup file
            const st = await refreshStatus(false, null);
            if (st.uncError) {
                // UNC is configured but unreachable: show the reason, never fall back silently
                clearView();
                setLoading(false);
                return;
            }

            // 3. Compare silently against the latest file (the server reuses today's result only if it
            //    was computed from this very file)
            if (st.hasBackup) {
                await executeComparison('cmdb', 'ALL', '', false, true, '', false);
            } else {
                setLoading(false);
            }
        } catch (e) {
            console.error('Initialization error:', e);
            showToast('初始化 HostMonitor 檢查程式時發生錯誤: ' + (e.response?.data?.error || e.message), 'error');
            setLoading(false);
        }
    };

    /**
     * Execute comparison
     * @param {string} source - 'cmdb' | 'custom'
     * The target file is the pinned one (explicit pick in the backup modal) or, by default, the latest file.
     * @param {string} source - 'cmdb' | 'custom'
     * @param {string} envVal - environment filter
     * @param {string} textContent - pasted text if custom
     * @param {boolean} force - if true, bypass today's cache
     * @param {boolean} isSilent - if true, do not pop toast
     * @param {string} [pinOverride] - pin to use instead of state (use '' to force latest right after un-pinning)
     * @param {boolean} [uploadsOverride] - upload source to use instead of state
     */
    const executeComparison = async (source, envVal, textContent, force = false, isSilent = false, pinOverride, uploadsOverride) => {
        setLoading(true);
        try {
            const res = await api.post('/hm-checker/compare', buildCompareRequest({
                source,
                envFilter: envVal,
                customText: textContent,
                force,
                pinnedFile: pinOverride === undefined ? pinnedFile : (pinOverride || null),
                useUploads: uploadsOverride === undefined ? useUploads : uploadsOverride
            }));

            setSummary(res.data.summary || {});
            setResults(res.data.results || []);
            setSelectedIps(new Set());
            setLastComparedAt(res.data.cachedAt || new Date().toISOString());
            setIsFromCache(!!res.data.fromCache);
            setUncError('');
            if (res.data.file) {
                setActiveFile(res.data.file);
            }

            // Only show toast on manual click or when not silent
            if (!isSilent) {
                const actionDesc = res.data.fromCache ? '已載入今日比對結果' : '比對完成！';
                showToast(`${actionDesc} (使用檔案: ${res.data.backupFile}, 共 ${res.data.summary?.totalServers || 0} 台主機)`, 'success');
            }
        } catch (e) {
            console.error('Comparison error:', e);
            const effectivePin = pinOverride === undefined ? pinnedFile : pinOverride;
            const outcome = interpretCompareFailure({
                status: e.response?.status,
                data: e.response?.data,
                pinned: !!effectivePin,
                fallbackMessage: e.message
            });
            if (outcome.clearView) clearView();
            if (outcome.uncError) setUncError(outcome.uncError);
            if (outcome.unpin) setPinnedFile(null);
            showToast(outcome.message, 'error');
        } finally {
            setLoading(false);
        }
    };

    // Filtered Results
    const filteredResults = useMemo(() => {
        let list = results;

        // Quick filter
        if (activeQuickFilter === 'NO_PING') {
            list = list.filter(r => !r.hasPing);
        } else if (activeQuickFilter === 'NO_CPU') {
            list = list.filter(r => !r.hasCpu);
        } else if (activeQuickFilter === 'NO_MEM') {
            list = list.filter(r => !r.hasMem);
        } else if (activeQuickFilter === 'NO_DISK') {
            list = list.filter(r => !r.hasDisk);
        } else if (activeQuickFilter === 'ANY_MISSING') {
            list = list.filter(r => !r.isAllMonitored);
        } else if (activeQuickFilter === 'ALL_OK') {
            list = list.filter(r => r.isAllMonitored);
        }

        // ENV filter
        if (envFilter !== 'ALL') {
            list = list.filter(r => (r.env || '').toUpperCase() === envFilter.toUpperCase());
        }

        // Search Keyword
        if (searchKeyword.trim()) {
            const kw = searchKeyword.trim().toLowerCase();
            list = list.filter(r => 
                (r.hostname || '').toLowerCase().includes(kw) ||
                (r.ip || '').toLowerCase().includes(kw) ||
                (r.env || '').toLowerCase().includes(kw) ||
                (r.zone || '').toLowerCase().includes(kw) ||
                (r.applicationName || '').toLowerCase().includes(kw)
            );
        }

        // Sort by IP
        return [...list].sort((a, b) => compareIPs(a.ip, b.ip));
    }, [results, activeQuickFilter, envFilter, searchKeyword]);

    // Selection handlers
    const handleSelectAll = (e) => {
        if (e.target.checked) {
            const allIps = new Set(filteredResults.map(r => r.ip));
            setSelectedIps(allIps);
        } else {
            setSelectedIps(new Set());
        }
    };

    const handleToggleSelect = (ip) => {
        const next = new Set(selectedIps);
        if (next.has(ip)) next.delete(ip);
        else next.add(ip);
        setSelectedIps(next);
    };

    // Open Import Modal
    const handleOpenImportModal = (targetServers = null) => {
        let targets = [];
        if (targetServers) {
            targets = Array.isArray(targetServers) ? targetServers : [targetServers];
        } else if (selectedIps.size > 0) {
            targets = results.filter(r => selectedIps.has(r.ip));
        } else {
            // Default to all filtered items that have missing monitors
            targets = filteredResults.filter(r => !r.isAllMonitored);
            if (targets.length === 0) targets = filteredResults;
        }

        if (targets.length === 0) {
            showToast('目前沒有可供產出匯入檔的主機項目', 'warning');
            return;
        }

        setImportModalTargetServers(targets);
        setShowImportModal(true);
        generateImportPreview(targets, importMetrics, importOptions);
    };

    // Generate Import Content Preview
    const generateImportPreview = async (servers, metrics, opts) => {
        setIsGenerating(true);
        setImportSkipped([]);
        try {
            const activeMetrics = Object.entries(metrics).filter(([_, v]) => v).map(([k]) => k);
            if (activeMetrics.length === 0) {
                setGeneratedImportText('; 請至少勾選一種需要產出的監控項目 (Ping / CPU / Mem / Disk)');
                setIsGenerating(false);
                return;
            }

            const prepared = servers.map(s => ({
                ...s,
                forceGenerate: opts.mode === 'force_all'
            }));

            const res = await api.post('/hm-checker/generate-import', {
                servers: prepared,
                metrics: activeMetrics,
                options: {
                    rmAgent: opts.rmAgent
                }
            });

            setGeneratedImportText(res.data.content || '');
            setImportSkipped(Array.isArray(res.data.skippedUnknownOs) ? res.data.skippedUnknownOs : []);
        } catch (e) {
            console.error('Generate import error:', e);
            setGeneratedImportText('; 產生匯入內容時發生錯誤: ' + (e.response?.data?.error || e.message));
        } finally {
            setIsGenerating(false);
        }
    };

    // Copy Generated Text
    const handleCopyImportText = () => {
        if (!generatedImportText) return;
        navigator.clipboard.writeText(generatedImportText);
        showToast('已複製匯入內容至剪貼簿！', 'success');
    };

    // Download Generated Text as .txt file
    const handleDownloadImportFile = () => {
        if (!generatedImportText) return;
        const blob = new Blob([generatedImportText], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const dateStr = new Date().toISOString().split('T')[0];
        a.href = url;
        a.download = `HM-Import-Missing-${dateStr}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('HostMonitor 匯入檔 (.txt) 下載成功！', 'success');
    };

    // Export Matrix to CSV
    const handleExportCSV = () => {
        if (filteredResults.length === 0) {
            showToast('沒有可匯出的比對資料', 'warning');
            return;
        }

        const headers = ['ENV', 'Hostname', 'IP', 'OS', 'Zone', 'Application', 'Ping', 'CPU', 'Mem', 'Disk', 'Status'];
        const rows = filteredResults.map(r => [
            r.env,
            r.hostname,
            r.ip,
            r.os || '',
            r.zone,
            r.applicationName,
            r.pingCell || 'OK',
            r.cpuCell || 'OK',
            r.memCell || 'OK',
            r.diskCell || 'OK',
            r.isAllMonitored ? 'All Monitored' : (r.isUnmonitored ? 'Unmonitored' : 'Partially Monitored')
        ]);

        const csvContent = '\uFEFF' + [headers, ...rows].map(row => row.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `HM-Coverage-Matrix-${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('比對矩陣 CSV 匯出成功！', 'success');
    };

    // Test & Save UNC Path
    const handleTestAndSaveUnc = async () => {
        if (!uncPathInput.trim()) {
            showToast('請輸入 UNC 或目錄路徑', 'warning');
            return;
        }
        setIsTestingUnc(true);
        setUncTestStatus(null);
        try {
            const testRes = await api.post('/hm-checker/test-unc', { uncPath: uncPathInput.trim(), filePattern: filePatternInput.trim() || undefined });
            setUncTestStatus(testRes.data);

            if (testRes.data.success) {
                // Save config
                const payload = { uncPath: uncPathInput.trim(), filePattern: filePatternInput.trim() };
                if (scanTimeoutInput.trim()) payload.scanTimeoutSec = Number(scanTimeoutInput);
                await api.post('/hm-checker/config', payload);
                showToast(`UNC 路徑儲存成功！找到 ${testRes.data.backupFilesFound || 0} 個備份檔`, 'success');
                // Back to the latest file on the (new) UNC path
                setUseUploads(false);
                setPinnedFile(nextPinnedFile(pinnedFile, { type: 'clear' }));
                const st = await refreshStatus(false, null);
                if (st.hasBackup) {
                    await executeComparison(comparisonSource, cmdbEnvFilter, customText, true, false, null, false);
                } else {
                    clearView();
                }
            } else {
                showToast('UNC 路徑無法存取: ' + testRes.data.error, 'error');
            }
        } catch (e) {
            console.error('UNC test error:', e);
            showToast('測試 UNC 路徑失敗: ' + (e.response?.data?.error || e.message), 'error');
            setUncTestStatus({ success: false, error: e.message });
        } finally {
            setIsTestingUnc(false);
        }
    };

    // Save Ignored Environments
    const handleSaveIgnoredEnvs = async () => {
        setIsSavingEnvs(true);
        try {
            await api.post('/hm-checker/config', { ignoredEnvs: namesToIgnoredEnvs(tempIgnoredEnvs, envOptions) });
            setIgnoredEnvs(tempIgnoredEnvs);
            setShowIgnoredEnvsModal(false);
            showToast('略過環境設定已更新！正在重新比對...', 'success');
            await executeComparison(comparisonSource, cmdbEnvFilter, customText, true);
        } catch (e) {
            console.error('Save ignored envs error:', e);
            showToast('儲存失敗: ' + (e.response?.data?.error || e.message), 'error');
        } finally {
            setIsSavingEnvs(false);
        }
    };

    // Upload / Paste new Backup File
    const handleUploadBackup = async (overwrite = false) => {
        if (!uploadContent.trim()) {
            showToast('請提供備份檔內容', 'warning');
            return;
        }
        setIsUploading(true);
        try {
            const res = await api.post('/hm-checker/upload-backup', {
                filename: uploadFilename.trim() || undefined,
                content: uploadContent,
                overwrite: overwrite === true
            });
            showToast(`備份檔 ${res.data.filename} 上傳儲存成功！`, 'success');
            setShowBackupModal(false);
            setUploadContent('');
            setUploadFilename('');
            // Saving an upload explicitly chooses the uploaded backups as the source (latest uploaded file)
            setUseUploads(true);
            setPinnedFile(nextPinnedFile(pinnedFile, { type: 'clear' }));
            await refreshStatus(true, null);
            await executeComparison(comparisonSource, cmdbEnvFilter, customText, true, false, null, true);
        } catch (e) {
            console.error('Upload backup error:', e);
            if (e.response?.status === 409 && e.response?.data?.exists) {
                if (window.confirm(`${e.response.data.error}

是否覆蓋現有檔案？(取消後可更換檔名再儲存)`)) {
                    setIsUploading(false);
                    return handleUploadBackup(true);
                }
                return;
            }
            showToast('上傳失敗: ' + (e.response?.data?.error || e.message), 'error');
        } finally {
            setIsUploading(false);
        }
    };

    return (
        <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Header Title (v1.0.0 removed as requested) */}
            <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center', 
                flexWrap: 'wrap', 
                gap: 16,
                borderBottom: '1px solid var(--border-color)',
                paddingBottom: 16
            }}>
                <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 26 }}>📡</span>
                        <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
                            HostMonitor 監控覆蓋率比對 (HM_checker)
                        </h1>
                        {/* Daily Cache Status Indicator */}
                        {lastComparedAt && (
                            <span style={{
                                background: isFromCache ? 'rgba(16, 185, 129, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                                color: isFromCache ? '#10b981' : '#60a5fa',
                                fontSize: 11,
                                fontWeight: 700,
                                padding: '3px 10px',
                                borderRadius: 14,
                                border: `1px solid ${isFromCache ? 'rgba(16, 185, 129, 0.3)' : 'rgba(59, 130, 246, 0.3)'}`
                            }}>
                                {isFromCache ? `🟢 今日已比對 (${lastComparedAt.substring(11, 19)}) · 無需重複比對` : `🔄 最新比對 (${lastComparedAt.substring(11, 19)})`}
                            </span>
                        )}
                    </div>
                    <p style={{ margin: '6px 0 0 0', fontSize: 13, color: 'var(--text-muted)' }}>
                        自動比對 CMDB 伺服器庫與 HostMonitor 現有測試項目 (Ping, CPU, Memory, Disk)，一鍵篩選缺漏並產出補齊匯入檔
                    </p>
                </div>

                {/* Right controls: Backup status tag & actions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                        background: 'var(--bg-glass)',
                        border: '1px solid var(--border-color)',
                        padding: '8px 14px',
                        borderRadius: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                        minWidth: 240
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>當前比對來源備份檔</span>
                            {uncError
                                ? <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 700 }}>● UNC 無法存取</span>
                                : <span style={{ fontSize: 11, color: '#10b981', fontWeight: 700 }}>● {pinnedFile ? '固定檔案' : '自動取用最新檔'}</span>}
                        </div>
                        <div style={{
                            fontSize: 13,
                            fontWeight: 700,
                            color: 'var(--text-primary)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis'
                        }} title={activeFile?.filename || ''}>
                            📄 {activeFile?.filename || '未檢測到備份檔'}
                        </div>
                        {activeFile && (
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                <span title={activeFile.directory}>📁 {activeFile.directory}</span>
                                {activeFile.modifiedAt && (
                                    <span>· 🕒 {activeFile.modifiedAt.replace('T', ' ').substring(0, 19)}</span>
                                )}
                                {activeFile.size !== undefined && <span>· {formatFileSize(activeFile.size)}</span>}
                                {activeFile.source && <span>· 來源: {describeFileSource(activeFile.source)}</span>}
                            </div>
                        )}
                        {pinnedFile && (
                            <button
                                onClick={async () => {
                                    setPinnedFile(nextPinnedFile(pinnedFile, { type: 'clear' }));
                                    clearView();
                                    await executeComparison(comparisonSource, cmdbEnvFilter, customText, true, false, null);
                                }}
                                style={{
                                    alignSelf: 'flex-start',
                                    marginTop: 2,
                                    padding: '2px 8px',
                                    borderRadius: 10,
                                    border: '1px solid rgba(245, 158, 11, 0.4)',
                                    background: 'rgba(245, 158, 11, 0.15)',
                                    color: '#f59e0b',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    cursor: 'pointer'
                                }}
                                title="取消固定，改用目錄中最新的備份檔"
                            >
                                📌 {pinChipLabel(pinnedFile)}
                            </button>
                        )}
                        {statusData?.meta && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                共 {statusData.meta.totalTests?.toLocaleString()} 個測試 (Tests) · {statusData.meta.totalFolders} 個目錄
                            </div>
                        )}
                    </div>

                    {/* Ignored Envs Button */}
                    <button
                        onClick={() => {
                            setTempIgnoredEnvs([...ignoredEnvs]);
                            setShowIgnoredEnvsModal(true);
                        }}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '10px 14px',
                            background: ignoredEnvs.length > 0 ? 'rgba(239, 68, 68, 0.12)' : 'var(--bg-secondary)',
                            color: ignoredEnvs.length > 0 ? '#ef4444' : 'var(--text-primary)',
                            border: `1px solid ${ignoredEnvs.length > 0 ? 'rgba(239, 68, 68, 0.3)' : 'var(--border-color)'}`,
                            borderRadius: 12,
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: 'pointer'
                        }}
                        title="設定略過比對的環境 (如特定不用監控的環境)"
                    >
                        <FiSlash /> 略過環境 {ignoredEnvs.length > 0 && `(${ignoredEnvs.length})`}
                    </button>

                    {/* Backup Management Button (with UNC setting) */}
                    <button 
                        onClick={() => setShowBackupModal(true)}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '10px 16px',
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 12,
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: 'pointer'
                        }}
                    >
                        <FiUploadCloud /> 備份與 UNC 管理
                    </button>

                    {/* Manual Force Re-compare Button */}
                    <button 
                        onClick={() => executeComparison(comparisonSource, cmdbEnvFilter, customText, true, false)}
                        disabled={loading}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '10px 16px',
                            background: 'var(--primary)',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 12,
                            fontSize: 13,
                            fontWeight: 700,
                            cursor: loading ? 'not-allowed' : 'pointer',
                            opacity: loading ? 0.7 : 1
                        }}
                        title="強制重新與最新備份檔交叉比對"
                    >
                        <FiRefreshCw className={loading ? 'animate-spin' : ''} /> 重新比對
                    </button>
                </div>
            </div>

            {/* UNC scan failure: shown prominently, uploaded files are never used silently */}
            {uncError && (
                <div style={{
                    background: 'rgba(239, 68, 68, 0.12)',
                    border: '1px solid rgba(239, 68, 68, 0.45)',
                    borderRadius: 14,
                    padding: '14px 18px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 12
                }}>
                    <div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: '#ef4444' }}>❌ 無法存取 UNC 備份目錄，未進行比對</div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, wordBreak: 'break-all' }}>{uncError}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                            請確認網路共享與權限，或在「備份與 UNC 管理」調整逾時秒數。系統不會在 UNC 失敗時自動改用已上傳的備份。
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button
                            onClick={() => executeComparison(comparisonSource, cmdbEnvFilter, customText, true)}
                            disabled={loading}
                            style={{ padding: '6px 14px', borderRadius: 8, background: 'var(--primary)', color: '#fff', border: 'none', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                        >
                            重試
                        </button>
                        <button
                            onClick={async () => {
                                setUseUploads(true);
                                setPinnedFile(null);
                                try { await refreshStatus(true, null); } catch { /* shown by compare below */ }
                                await executeComparison(comparisonSource, cmdbEnvFilter, customText, true, false, null, true);
                            }}
                            disabled={loading}
                            style={{ padding: '6px 14px', borderRadius: 8, background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                        >
                            使用已上傳的備份
                        </button>
                    </div>
                </div>
            )}
            {useUploads && statusData?.uncConfigured && (
                <div style={{ fontSize: 12, color: '#f59e0b', background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.35)', borderRadius: 12, padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <span>⚠️ 目前使用「已上傳的備份」，而非 UNC 目錄中的最新檔案。</span>
                    <button
                        onClick={async () => {
                            setUseUploads(false);
                            setPinnedFile(null);
                            try { await refreshStatus(false, null); } catch { /* shown by compare below */ }
                            await executeComparison(comparisonSource, cmdbEnvFilter, customText, true, false, null, false);
                        }}
                        style={{ padding: '4px 12px', borderRadius: 8, background: '#f59e0b', color: '#fff', border: 'none', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                    >
                        改用 UNC 最新檔
                    </button>
                </div>
            )}

            {/* Source Mode Switcher & Dynamic Environment Filter */}
            <div style={{
                background: 'var(--bg-glass)',
                border: '1px solid var(--border-color)',
                borderRadius: 16,
                padding: '16px 20px',
                display: 'flex',
                flexDirection: 'column',
                gap: 14
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)' }}>比對主機來源：</span>
                        <div style={{ display: 'flex', background: 'var(--bg-secondary)', padding: 3, borderRadius: 10, border: '1px solid var(--border-color)' }}>
                            <button
                                onClick={() => {
                                    setComparisonSource('cmdb');
                                    executeComparison('cmdb', cmdbEnvFilter, customText, false);
                                }}
                                style={{
                                    padding: '6px 14px',
                                    borderRadius: 8,
                                    border: 'none',
                                    background: comparisonSource === 'cmdb' ? 'var(--primary)' : 'transparent',
                                    color: comparisonSource === 'cmdb' ? '#fff' : 'var(--text-secondary)',
                                    fontSize: 12,
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6
                                }}
                            >
                                <FiServer /> 📦 CMDB 伺服器庫 (自動取用)
                            </button>
                            <button
                                onClick={() => setComparisonSource('custom')}
                                style={{
                                    padding: '6px 14px',
                                    borderRadius: 8,
                                    border: 'none',
                                    background: comparisonSource === 'custom' ? 'var(--primary)' : 'transparent',
                                    color: comparisonSource === 'custom' ? '#fff' : 'var(--text-secondary)',
                                    fontSize: 12,
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6
                                }}
                            >
                                <FiClipboard /> 📋 自訂貼上 Excel 清單
                            </button>
                        </div>
                    </div>

                    {/* Dynamic Actual Environment Dropdown (No DEV, SIT) */}
                    {comparisonSource === 'cmdb' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>CMDB 環境過濾:</span>
                            <select
                                value={cmdbEnvFilter}
                                onChange={(e) => {
                                    setCmdbEnvFilter(e.target.value);
                                    executeComparison('cmdb', e.target.value, customText, true);
                                }}
                                style={{
                                    padding: '6px 12px',
                                    borderRadius: 8,
                                    background: 'var(--bg-secondary)',
                                    color: 'var(--text-primary)',
                                    border: '1px solid var(--border-color)',
                                    fontSize: 12,
                                    fontWeight: 600
                                }}
                            >
                                <option value="ALL">全部環境 (ALL Environments)</option>
                                {availableEnvs.map(env => (
                                    <option key={env} value={env}>{env}</option>
                                ))}
                            </select>
                        </div>
                    )}
                </div>

                {/* Custom Excel Textarea Drawer */}
                {comparisonSource === 'custom' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: '1px solid var(--border-color)', paddingTop: 14 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }}>
                                貼上從 Excel 複製的清單（欄位順序或標題包含：<code>ZONE</code>、<code>HOSTNAME</code>、<code>ServiceLAN IP</code>，支援 Tab 分隔）:
                            </span>
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                提示：直接由 Excel 框選多列複製後貼入即可
                            </span>
                        </div>
                        <textarea
                            rows={4}
                            value={customText}
                            onChange={(e) => setCustomText(e.target.value)}
                            placeholder={`範例格式 (Excel 複製直接貼上)：\nZONE\tHOSTNAME\tServiceLAN IP\nTRUST\tJH-SBK-APP040\t10.88.18.40\nTRUST\tJH-SBK-APP108\t10.88.18.108`}
                            style={{
                                width: '100%',
                                padding: 12,
                                borderRadius: 10,
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                                border: '1px solid var(--border-color)',
                                fontFamily: 'monospace',
                                fontSize: 12,
                                resize: 'vertical'
                            }}
                        />
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                            <button
                                onClick={() => setCustomText('')}
                                style={{
                                    padding: '6px 14px',
                                    borderRadius: 8,
                                    background: 'transparent',
                                    color: 'var(--text-secondary)',
                                    border: '1px solid var(--border-color)',
                                    fontSize: 12,
                                    cursor: 'pointer'
                                }}
                            >
                                清空內容
                            </button>
                            <button
                                onClick={() => executeComparison('custom', cmdbEnvFilter, customText, true)}
                                disabled={!customText.trim() || loading}
                                style={{
                                    padding: '6px 18px',
                                    borderRadius: 8,
                                    background: 'var(--primary)',
                                    color: '#fff',
                                    border: 'none',
                                    fontSize: 12,
                                    fontWeight: 700,
                                    cursor: !customText.trim() || loading ? 'not-allowed' : 'pointer'
                                }}
                            >
                                開始解析並比對
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* KPI Summary Cards */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: 12
            }}>
                {/* Total */}
                <div 
                    onClick={() => setActiveQuickFilter('ALL')}
                    style={{
                        background: 'var(--bg-glass)',
                        border: activeQuickFilter === 'ALL' ? '2px solid var(--primary)' : '1px solid var(--border-color)',
                        borderRadius: 14,
                        padding: 14,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        boxShadow: activeQuickFilter === 'ALL' ? '0 0 12px rgba(59, 130, 246, 0.25)' : 'none'
                    }}
                >
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>總比對主機</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', marginTop: 4 }}>
                        {summary.totalServers || 0}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {summary.ignoredServers > 0 ? `(已略過 ${summary.ignoredServers} 台)` : '主機清單'}
                    </div>
                </div>

                {/* All Monitored */}
                <div 
                    onClick={() => setActiveQuickFilter('ALL_OK')}
                    style={{
                        background: 'var(--bg-glass)',
                        border: activeQuickFilter === 'ALL_OK' ? '2px solid #10b981' : '1px solid var(--border-color)',
                        borderRadius: 14,
                        padding: 14,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        boxShadow: activeQuickFilter === 'ALL_OK' ? '0 0 12px rgba(16, 185, 129, 0.25)' : 'none'
                    }}
                >
                    <div style={{ fontSize: 11, color: '#10b981', fontWeight: 600 }}>四大項全齊備</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#10b981', marginTop: 4 }}>
                        {summary.allMonitored || 0}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>Ping+CPU+Mem+Disk</div>
                </div>

                {/* Missing Ping */}
                <div 
                    onClick={() => setActiveQuickFilter('NO_PING')}
                    style={{
                        background: activeQuickFilter === 'NO_PING' ? 'rgba(239, 68, 68, 0.12)' : 'var(--bg-glass)',
                        border: activeQuickFilter === 'NO_PING' ? '2px solid #ef4444' : '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: 14,
                        padding: 14,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        boxShadow: activeQuickFilter === 'NO_PING' ? '0 0 12px rgba(239, 68, 68, 0.25)' : 'none'
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#ef4444', fontWeight: 700 }}>缺 Ping (未建立)</span>
                        <span style={{ fontSize: 10, background: '#ef4444', color: '#fff', padding: '1px 5px', borderRadius: 4, fontWeight: 900 }}>X</span>
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#ef4444', marginTop: 4 }}>
                        {summary.missingPing || 0}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>點擊立即篩選</div>
                </div>

                {/* Missing CPU */}
                <div 
                    onClick={() => setActiveQuickFilter('NO_CPU')}
                    style={{
                        background: activeQuickFilter === 'NO_CPU' ? 'rgba(245, 158, 11, 0.12)' : 'var(--bg-glass)',
                        border: activeQuickFilter === 'NO_CPU' ? '2px solid #f59e0b' : '1px solid rgba(245, 158, 11, 0.3)',
                        borderRadius: 14,
                        padding: 14,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        boxShadow: activeQuickFilter === 'NO_CPU' ? '0 0 12px rgba(245, 158, 11, 0.25)' : 'none'
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 700 }}>缺 CPU (未建立)</span>
                        <span style={{ fontSize: 10, background: '#f59e0b', color: '#fff', padding: '1px 5px', borderRadius: 4, fontWeight: 900 }}>X</span>
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#f59e0b', marginTop: 4 }}>
                        {summary.missingCpu || 0}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>點擊立即篩選</div>
                </div>

                {/* Missing Mem */}
                <div 
                    onClick={() => setActiveQuickFilter('NO_MEM')}
                    style={{
                        background: activeQuickFilter === 'NO_MEM' ? 'rgba(236, 72, 153, 0.12)' : 'var(--bg-glass)',
                        border: activeQuickFilter === 'NO_MEM' ? '2px solid #ec4899' : '1px solid rgba(236, 72, 153, 0.3)',
                        borderRadius: 14,
                        padding: 14,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        boxShadow: activeQuickFilter === 'NO_MEM' ? '0 0 12px rgba(236, 72, 153, 0.25)' : 'none'
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#ec4899', fontWeight: 700 }}>缺 Memory (未建立)</span>
                        <span style={{ fontSize: 10, background: '#ec4899', color: '#fff', padding: '1px 5px', borderRadius: 4, fontWeight: 900 }}>X</span>
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#ec4899', marginTop: 4 }}>
                        {summary.missingMem || 0}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>點擊立即篩選</div>
                </div>

                {/* Missing Disk */}
                <div 
                    onClick={() => setActiveQuickFilter('NO_DISK')}
                    style={{
                        background: activeQuickFilter === 'NO_DISK' ? 'rgba(168, 85, 247, 0.12)' : 'var(--bg-glass)',
                        border: activeQuickFilter === 'NO_DISK' ? '2px solid #a855f7' : '1px solid rgba(168, 85, 247, 0.3)',
                        borderRadius: 14,
                        padding: 14,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        boxShadow: activeQuickFilter === 'NO_DISK' ? '0 0 12px rgba(168, 85, 247, 0.25)' : 'none'
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#a855f7', fontWeight: 700 }}>缺 Disk (未建立)</span>
                        <span style={{ fontSize: 10, background: '#a855f7', color: '#fff', padding: '1px 5px', borderRadius: 4, fontWeight: 900 }}>X</span>
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#a855f7', marginTop: 4 }}>
                        {summary.missingDisk || 0}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>點擊立即篩選</div>
                </div>

                {/* Unmonitored */}
                <div 
                    onClick={() => setActiveQuickFilter('ANY_MISSING')}
                    style={{
                        background: 'var(--bg-glass)',
                        border: activeQuickFilter === 'ANY_MISSING' ? '2px solid #eab308' : '1px solid var(--border-color)',
                        borderRadius: 14,
                        padding: 14,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        boxShadow: activeQuickFilter === 'ANY_MISSING' ? '0 0 12px rgba(234, 179, 8, 0.25)' : 'none'
                    }}
                >
                    <div style={{ fontSize: 11, color: '#eab308', fontWeight: 600 }}>任一項缺漏</div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#eab308', marginTop: 4 }}>
                        {(summary.totalServers - summary.allMonitored) || 0}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>需補齊項目</div>
                </div>
            </div>

            {/* Filter Pills, Search Bar & Main Action Buttons */}
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 12
            }}>
                {/* Left: Quick Filter Pills & Search */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', background: 'var(--bg-secondary)', padding: 3, borderRadius: 10, border: '1px solid var(--border-color)' }}>
                        {[
                            { key: 'ALL', label: '全部' },
                            { key: 'NO_PING', label: '🔴 缺 Ping (X)', count: summary.missingPing },
                            { key: 'NO_CPU', label: '🟡 缺 CPU (X)', count: summary.missingCpu },
                            { key: 'NO_MEM', label: '🟡 缺 Mem (X)', count: summary.missingMem },
                            { key: 'NO_DISK', label: '🟡 缺 Disk (X)', count: summary.missingDisk },
                            { key: 'ANY_MISSING', label: '⚠️ 任一缺漏' },
                            { key: 'ALL_OK', label: '✅ 全數齊備' }
                        ].map(f => (
                            <button
                                key={f.key}
                                onClick={() => setActiveQuickFilter(f.key)}
                                style={{
                                    padding: '6px 12px',
                                    borderRadius: 8,
                                    border: 'none',
                                    background: activeQuickFilter === f.key ? 'var(--primary)' : 'transparent',
                                    color: activeQuickFilter === f.key ? '#fff' : 'var(--text-secondary)',
                                    fontSize: 12,
                                    fontWeight: 700,
                                    cursor: 'pointer'
                                }}
                            >
                                {f.label} {f.count !== undefined && f.count > 0 ? `(${f.count})` : ''}
                            </button>
                        ))}
                    </div>

                    {availableEnvs.length > 0 && (
                        <select
                            value={envFilter}
                            onChange={(e) => setEnvFilter(e.target.value)}
                            style={{
                                padding: '8px 12px',
                                borderRadius: 10,
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                                border: '1px solid var(--border-color)',
                                fontSize: 12,
                                fontWeight: 600
                            }}
                        >
                            <option value="ALL">所有環境 (ENV)</option>
                            {availableEnvs.map(env => (
                                <option key={env} value={env}>{env}</option>
                            ))}
                        </select>
                    )}

                    <div style={{ position: 'relative', width: 220 }}>
                        <FiSearch style={{ position: 'absolute', left: 10, top: 10, color: 'var(--text-muted)' }} />
                        <input
                            type="text"
                            placeholder="搜尋 Hostname / IP..."
                            value={searchKeyword}
                            onChange={(e) => setSearchKeyword(e.target.value)}
                            style={{
                                width: '100%',
                                padding: '8px 12px 8px 32px',
                                borderRadius: 10,
                                background: 'var(--bg-secondary)',
                                color: 'var(--text-primary)',
                                border: '1px solid var(--border-color)',
                                fontSize: 12
                            }}
                        />
                    </div>
                </div>

                {/* Right: Actions */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                        onClick={handleExportCSV}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '9px 16px',
                            borderRadius: 10,
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            border: '1px solid var(--border-color)',
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: 'pointer'
                        }}
                    >
                        <FiDownload /> 匯出 CSV 矩陣
                    </button>

                    <button
                        onClick={() => handleOpenImportModal()}
                        disabled={filteredResults.length === 0}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '9px 18px',
                            borderRadius: 10,
                            background: '#10b981',
                            color: '#fff',
                            border: 'none',
                            fontSize: 13,
                            fontWeight: 700,
                            cursor: filteredResults.length === 0 ? 'not-allowed' : 'pointer',
                            boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)'
                        }}
                    >
                        <FiFileText /> 📥 產出 HostMonitor 匯入檔 (.txt)
                        {selectedIps.size > 0 && ` (${selectedIps.size} 台)`}
                    </button>
                </div>
            </div>

            {/* Matrix Table (Matching the user's screenshot) */}
            <div style={{
                background: 'var(--bg-glass)',
                border: '1px solid var(--border-color)',
                borderRadius: 16,
                overflow: 'hidden',
                boxShadow: '0 8px 24px rgba(0,0,0,0.1)'
            }}>
                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
                        <thead>
                            <tr style={{ 
                                background: 'rgba(15, 23, 42, 0.8)', 
                                borderBottom: '2px solid var(--border-color)',
                                color: '#f8fafc'
                            }}>
                                <th style={{ padding: '12px 14px', width: 44, textAlign: 'center' }}>
                                    <input 
                                        type="checkbox"
                                        checked={filteredResults.length > 0 && selectedIps.size === filteredResults.length}
                                        onChange={handleSelectAll}
                                        style={{ cursor: 'pointer' }}
                                    />
                                </th>
                                <th style={{ padding: '12px 14px', fontWeight: 800, width: 90, color: '#f87171' }}>ENV</th>
                                <th style={{ padding: '12px 14px', fontWeight: 800, minWidth: 150, color: '#f87171' }}>Hostname</th>
                                <th style={{ padding: '12px 14px', fontWeight: 800, minWidth: 130, color: '#f87171' }}>IP</th>
                                <th style={{ padding: '12px 14px', fontWeight: 800, textAlign: 'center', width: 80, color: '#f87171' }}>Ping</th>
                                <th style={{ padding: '12px 14px', fontWeight: 800, textAlign: 'center', width: 80, color: '#f87171' }}>CPU</th>
                                <th style={{ padding: '12px 14px', fontWeight: 800, textAlign: 'center', width: 80, color: '#f87171' }}>Mem</th>
                                <th style={{ padding: '12px 14px', fontWeight: 800, textAlign: 'center', width: 80, color: '#f87171' }}>Disk</th>
                                <th style={{ padding: '12px 14px', fontWeight: 700, textAlign: 'center', width: 140 }}>監控狀態</th>
                                <th style={{ padding: '12px 14px', fontWeight: 700, textAlign: 'center', width: 120 }}>操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr>
                                    <td colSpan={10} style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
                                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                                            <FiRefreshCw className="animate-spin" style={{ fontSize: 24 }} />
                                            <span>正在交叉比對 HostMonitor 測試項目中...</span>
                                        </div>
                                    </td>
                                </tr>
                            ) : filteredResults.length === 0 ? (
                                <tr>
                                    <td colSpan={10} style={{ padding: 48, textAlign: 'center', color: 'var(--text-muted)' }}>
                                        查無符合條件的伺服器項目
                                    </td>
                                </tr>
                            ) : (
                                filteredResults.map((r, idx) => {
                                    const isSelected = selectedIps.has(r.ip);
                                    return (
                                        <tr 
                                            key={`${r.ip}-${idx}`}
                                            style={{
                                                borderBottom: '1px solid var(--border-color)',
                                                background: isSelected 
                                                    ? 'rgba(59, 130, 246, 0.08)' 
                                                    : (idx % 2 === 0 ? 'rgba(255, 255, 255, 0.015)' : 'transparent'),
                                                transition: 'background 0.15s'
                                            }}
                                        >
                                            <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                                                <input 
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    onChange={() => handleToggleSelect(r.ip)}
                                                    style={{ cursor: 'pointer' }}
                                                />
                                            </td>

                                            {/* ENV */}
                                            <td style={{ padding: '10px 14px' }}>
                                                <span style={{
                                                    fontSize: 11,
                                                    fontWeight: 800,
                                                    padding: '3px 8px',
                                                    borderRadius: 6,
                                                    // production environments (isProduction flag) are highlighted
                                                    background: envBadgeIsProduction(r, envOptions) ? 'rgba(59, 130, 246, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                                                    color: envBadgeIsProduction(r, envOptions) ? '#60a5fa' : '#34d399',
                                                    border: `1px solid ${envBadgeIsProduction(r, envOptions) ? 'rgba(59, 130, 246, 0.3)' : 'rgba(16, 185, 129, 0.3)'}`
                                                }}>
                                                    {r.env}
                                                </span>
                                            </td>

                                            {/* Hostname */}
                                            <td style={{ padding: '10px 14px' }}>
                                                <span style={{ fontWeight: 700, fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                                                    {r.hostname}
                                                </span>
                                                <OsBadge osFamily={r.osFamily} os={r.os} />
                                                {r.applicationName && r.applicationName !== '-' && (
                                                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                                        {r.applicationName}
                                                    </div>
                                                )}
                                            </td>

                                            {/* IP */}
                                            <td style={{ padding: '10px 14px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    <span style={{ fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                                                        {r.ip}
                                                    </span>
                                                    <button
                                                        onClick={() => {
                                                            navigator.clipboard.writeText(r.ip);
                                                            showToast(`已複製 IP: ${r.ip}`, 'info');
                                                        }}
                                                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}
                                                        title="複製 IP"
                                                    >
                                                        <FiCopy style={{ fontSize: 12 }} />
                                                    </button>
                                                </div>
                                            </td>

                                            {/* PING (Blank if Monitored; 'X' if Missing) */}
                                            <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                                                {r.pingCell === 'X' ? (
                                                    <span style={{ 
                                                        color: '#ef4444', 
                                                        fontWeight: 900, 
                                                        fontSize: 16,
                                                        background: 'rgba(239, 68, 68, 0.12)',
                                                        padding: '2px 8px',
                                                        borderRadius: 6,
                                                        border: '1px solid rgba(239, 68, 68, 0.3)'
                                                    }} title="未建立 Ping 測試">
                                                        X
                                                    </span>
                                                ) : null}
                                            </td>

                                            {/* CPU (Blank if Monitored; 'X' if Missing) */}
                                            <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                                                {r.cpuCell === 'X' ? (
                                                    <span style={{ 
                                                        color: '#ef4444', 
                                                        fontWeight: 900, 
                                                        fontSize: 16,
                                                        background: 'rgba(239, 68, 68, 0.12)',
                                                        padding: '2px 8px',
                                                        borderRadius: 6,
                                                        border: '1px solid rgba(239, 68, 68, 0.3)'
                                                    }} title="未建立 CPU 測試">
                                                        X
                                                    </span>
                                                ) : null}
                                            </td>

                                            {/* MEM (Blank if Monitored; 'X' if Missing) */}
                                            <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                                                {r.memCell === 'X' ? (
                                                    <span style={{ 
                                                        color: '#ef4444', 
                                                        fontWeight: 900, 
                                                        fontSize: 16,
                                                        background: 'rgba(239, 68, 68, 0.12)',
                                                        padding: '2px 8px',
                                                        borderRadius: 6,
                                                        border: '1px solid rgba(239, 68, 68, 0.3)'
                                                    }} title="未建立 Memory 測試">
                                                        X
                                                    </span>
                                                ) : null}
                                            </td>

                                            {/* DISK (Blank if Monitored; 'X' if Missing) */}
                                            <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                                                {r.diskCell === 'X' ? (
                                                    <span style={{ 
                                                        color: '#ef4444', 
                                                        fontWeight: 900, 
                                                        fontSize: 16,
                                                        background: 'rgba(239, 68, 68, 0.12)',
                                                        padding: '2px 8px',
                                                        borderRadius: 6,
                                                        border: '1px solid rgba(239, 68, 68, 0.3)'
                                                    }} title="未建立 Disk Space 測試">
                                                        X
                                                    </span>
                                                ) : null}
                                            </td>

                                            {/* Status Badge */}
                                            <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                                                {r.isAllMonitored ? (
                                                    <span style={{
                                                        background: 'rgba(16, 185, 129, 0.12)',
                                                        color: '#10b981',
                                                        fontSize: 11,
                                                        fontWeight: 700,
                                                        padding: '3px 8px',
                                                        borderRadius: 8,
                                                        border: '1px solid rgba(16, 185, 129, 0.3)'
                                                    }}>
                                                        齊備 (4/4)
                                                    </span>
                                                ) : r.isUnmonitored ? (
                                                    <span style={{
                                                        background: 'rgba(239, 68, 68, 0.15)',
                                                        color: '#ef4444',
                                                        fontSize: 11,
                                                        fontWeight: 700,
                                                        padding: '3px 8px',
                                                        borderRadius: 8,
                                                        border: '1px solid rgba(239, 68, 68, 0.3)'
                                                    }}>
                                                        未建置 (0/4)
                                                    </span>
                                                ) : (
                                                    <span style={{
                                                        background: 'rgba(245, 158, 11, 0.15)',
                                                        color: '#f59e0b',
                                                        fontSize: 11,
                                                        fontWeight: 700,
                                                        padding: '3px 8px',
                                                        borderRadius: 8,
                                                        border: '1px solid rgba(245, 158, 11, 0.3)'
                                                    }}>
                                                        部分缺漏 ({[r.hasPing, r.hasCpu, r.hasMem, r.hasDisk].filter(Boolean).length}/4)
                                                    </span>
                                                )}
                                            </td>

                                            {/* Actions */}
                                            <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                                                <div style={{ display: 'flex', justifyContent: 'center', gap: 6 }}>
                                                    <button
                                                        onClick={() => setDetailServer(r)}
                                                        style={{
                                                            background: 'var(--bg-secondary)',
                                                            border: '1px solid var(--border-color)',
                                                            color: 'var(--text-secondary)',
                                                            borderRadius: 6,
                                                            padding: '4px 8px',
                                                            fontSize: 11,
                                                            cursor: 'pointer',
                                                            display: 'flex',
                                                            alignItems: 'center',
                                                            gap: 4
                                                        }}
                                                        title="查看比對到的 HostMonitor 測試"
                                                    >
                                                        <FiInfo /> 詳情
                                                    </button>
                                                    {!r.isAllMonitored && (
                                                        <button
                                                            onClick={() => handleOpenImportModal([r])}
                                                            style={{
                                                                background: 'rgba(16, 185, 129, 0.15)',
                                                                border: '1px solid rgba(16, 185, 129, 0.3)',
                                                                color: '#34d399',
                                                                borderRadius: 6,
                                                                padding: '4px 8px',
                                                                fontSize: 11,
                                                                fontWeight: 700,
                                                                cursor: 'pointer'
                                                            }}
                                                            title="產出此台主機的補齊匯入檔"
                                                        >
                                                            補齊
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>

                {/* Table Footer Stats */}
                <div style={{
                    padding: '12px 18px',
                    borderTop: '1px solid var(--border-color)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 12,
                    color: 'var(--text-muted)'
                }}>
                    <span>
                        顯示 {filteredResults.length} 台主機 (總計 {results.length} 台) · 已勾選 {selectedIps.size} 台
                    </span>
                    <span>
                        圖示說明：紅色 <strong>X</strong> 代表尚未建立該項監控，空白代表已存在監控 Test
                    </span>
                </div>
            </div>

            {/* MODAL 1: Generate HostMonitor Import File */}
            {showImportModal && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.6)',
                    backdropFilter: 'blur(8px)',
                    zIndex: 200,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 20
                }}>
                    <div style={{
                        background: 'var(--bg-glass)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 20,
                        width: '100%',
                        maxWidth: 780,
                        maxHeight: '90vh',
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden',
                        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)'
                    }}>
                        <div style={{
                            padding: '18px 24px',
                            borderBottom: '1px solid var(--border-color)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                        }}>
                            <div>
                                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: 'var(--text-primary)' }}>
                                    📥 產出 HostMonitor 匯入檔 (Import from Text file)
                                </h3>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                                    目標主機數：<strong>{importModalTargetServers.length}</strong> 台
                                </div>
                            </div>
                            <button
                                onClick={() => setShowImportModal(false)}
                                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}
                            >
                                ✕
                            </button>
                        </div>

                        <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 14 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>需要產出的監控項目：</span>
                                {[
                                    { key: 'ping', label: 'Ping (Method: Ping)' },
                                    { key: 'cpu', label: 'CPU (SNMP / 1.3.6.1.4.1.2021.11.9.0)' },
                                    { key: 'mem', label: 'Memory (Method: Memory / SNMP)' },
                                    { key: 'disk', label: 'Disk (SNMP / 1.3.6.1.4.1.2021.9.1.9.1)' }
                                ].map(m => (
                                    <label key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={importMetrics[m.key]}
                                            onChange={(e) => {
                                                const next = { ...importMetrics, [m.key]: e.target.checked };
                                                setImportMetrics(next);
                                                generateImportPreview(importModalTargetServers, next, importOptions);
                                            }}
                                        />
                                        {m.label}
                                    </label>
                                ))}
                            </div>

                            <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>監控 Agent (RMAgent):</span>
                                    <input
                                        type="text"
                                        value={importOptions.rmAgent}
                                        onChange={(e) => {
                                            const next = { ...importOptions, rmAgent: e.target.value };
                                            setImportOptions(next);
                                            generateImportPreview(importModalTargetServers, importMetrics, next);
                                        }}
                                        style={{
                                            padding: '4px 10px',
                                            borderRadius: 8,
                                            background: 'var(--bg-secondary)',
                                            color: 'var(--text-primary)',
                                            border: '1px solid var(--border-color)',
                                            fontSize: 12,
                                            width: 140
                                        }}
                                    />
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>產出策略:</span>
                                    <select
                                        value={importOptions.mode}
                                        onChange={(e) => {
                                            const next = { ...importOptions, mode: e.target.value };
                                            setImportOptions(next);
                                            generateImportPreview(importModalTargetServers, importMetrics, next);
                                        }}
                                        style={{
                                            padding: '4px 10px',
                                            borderRadius: 8,
                                            background: 'var(--bg-secondary)',
                                            color: 'var(--text-primary)',
                                            border: '1px solid var(--border-color)',
                                            fontSize: 12
                                        }}
                                    >
                                        <option value="missing_only">只產出缺漏的項目 (推薦)</option>
                                        <option value="force_all">全部項目強制產出</option>
                                    </select>
                                </div>

                                <div style={{ fontSize: 11, color: '#60a5fa', background: 'rgba(59, 130, 246, 0.12)', padding: '6px 12px', borderRadius: 8, border: '1px solid rgba(59, 130, 246, 0.25)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span>🔔</span>
                                    <span>
                                        <strong>Action Profile 規則：</strong>專屬 BU (BI, SBKTW, SBKPH, TA, TRS) 自動對應 <code>[BU] + Test Item</code>；其餘主機皆採用預設 <code>[SYS] Monitor Email, SYS Skype, SYS Teams</code>
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div style={{ padding: '14px 24px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>檔案內容預覽 (符合 HostMonitor 13.14 匯入規格)：</span>
                                {isGenerating && <span style={{ fontSize: 11, color: 'var(--primary)' }}>正在產出預覽...</span>}
                            </div>
                            {!isGenerating && importSkipped.length > 0 && (
                                <div style={{ fontSize: 12, padding: '8px 12px', borderRadius: 8, background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.4)', color: '#fbbf24' }}>
                                    ⚠️ {new Set(importSkipped.map(k => k.ip)).size} 台主機在 CMDB 未填 OS（或非 Windows / Linux），已略過其 {importSkipped.length} 個 CPU / Mem / Disk 測試（Ping 照常產出）。
                                    請先至 CMDB 補上 OS 後再產出；略過清單列在檔案最後。
                                </div>
                            )}
                            <pre style={{
                                margin: 0,
                                padding: 14,
                                borderRadius: 12,
                                background: 'rgba(0, 0, 0, 0.4)',
                                color: '#a5f3fc',
                                border: '1px solid var(--border-color)',
                                fontFamily: 'monospace',
                                fontSize: 11,
                                lineHeight: 1.5,
                                maxHeight: 320,
                                overflowY: 'auto',
                                whiteSpace: 'pre-wrap'
                            }}>
                                {generatedImportText}
                            </pre>
                        </div>

                        <div style={{
                            padding: '16px 24px',
                            borderTop: '1px solid var(--border-color)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                        }}>
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                💡 匯出後，可在 HostMonitor 主選單點選 <strong>File ➔ Import from text file...</strong> 即可批次匯入
                            </span>
                            <div style={{ display: 'flex', gap: 10 }}>
                                <button
                                    onClick={handleCopyImportText}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        padding: '8px 16px',
                                        borderRadius: 10,
                                        background: 'var(--bg-secondary)',
                                        color: 'var(--text-primary)',
                                        border: '1px solid var(--border-color)',
                                        fontSize: 13,
                                        fontWeight: 600,
                                        cursor: 'pointer'
                                    }}
                                >
                                    <FiCopy /> 複製內容
                                </button>
                                <button
                                    onClick={handleDownloadImportFile}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        padding: '8px 20px',
                                        borderRadius: 10,
                                        background: '#10b981',
                                        color: '#fff',
                                        border: 'none',
                                        fontSize: 13,
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)'
                                    }}
                                >
                                    <FiDownload /> 下載匯入檔 (.txt)
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* MODAL 2: Test Details Modal */}
            {detailServer && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.6)',
                    backdropFilter: 'blur(8px)',
                    zIndex: 200,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 20
                }}>
                    <div style={{
                        background: 'var(--bg-glass)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 20,
                        width: '100%',
                        maxWidth: 650,
                        maxHeight: '85vh',
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden'
                    }}>
                        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>
                                    🔍 伺服器監控詳情: {detailServer.hostname} ({detailServer.ip})
                                </h3>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                                    ENV: {detailServer.env} · 區域: {detailServer.zone} · 應用: {detailServer.applicationName}
                                </div>
                            </div>
                            <button onClick={() => setDetailServer(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16 }}>✕</button>
                        </div>
                        <div style={{ padding: '18px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
                            {['pingTests', 'cpuTests', 'memTests', 'diskTests'].map(typeKey => {
                                const list = detailServer.details?.[typeKey] || [];
                                const typeNames = {
                                    pingTests: 'Ping 測試項目',
                                    cpuTests: 'CPU 測試項目',
                                    memTests: 'Memory 測試項目',
                                    diskTests: 'Disk Space 測試項目'
                                };
                                return (
                                    <div key={typeKey} style={{ background: 'var(--bg-secondary)', borderRadius: 12, padding: 12, border: '1px solid var(--border-color)' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                                                {typeNames[typeKey]}
                                            </span>
                                            <span style={{ fontSize: 11, fontWeight: 700, color: list.length > 0 ? '#10b981' : '#ef4444' }}>
                                                {list.length > 0 ? `已建立 (${list.length})` : '未建立 (X)'}
                                            </span>
                                        </div>
                                        {list.length === 0 ? (
                                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>尚未在 HostMonitor 找到此項目的測試設定</div>
                                        ) : (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                {list.map((item, idx) => (
                                                    <div key={idx} style={{ background: 'rgba(0,0,0,0.2)', padding: '6px 10px', borderRadius: 8, fontSize: 12 }}>
                                                        <div style={{ fontWeight: 600, color: '#38bdf8' }}>{item.title}</div>
                                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                                            Method: {item.method} · Folder: {item.folder}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end' }}>
                            <button onClick={() => setDetailServer(null)} style={{ padding: '6px 16px', borderRadius: 8, background: 'var(--primary)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>關閉</button>
                        </div>
                    </div>
                </div>
            )}

            {/* MODAL 3: Backup & UNC Manager Modal */}
            {showBackupModal && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.6)',
                    backdropFilter: 'blur(8px)',
                    zIndex: 200,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 20
                }}>
                    <div style={{
                        background: 'var(--bg-glass)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 20,
                        width: '100%',
                        maxWidth: 720,
                        maxHeight: '90vh',
                        display: 'flex',
                        flexDirection: 'column',
                        overflow: 'hidden'
                    }}>
                        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>📁 HostMonitor 備份與 UNC 路徑管理</h3>
                            <button onClick={() => setShowBackupModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16 }}>✕</button>
                        </div>
                        <div style={{ padding: '16px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
                            
                            {/* Section A: UNC Path Configuration */}
                            <div style={{ background: 'var(--bg-secondary)', borderRadius: 14, padding: 16, border: '1px solid var(--border-color)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>
                                        🌐 備份目錄 UNC 網路共享路徑
                                    </span>
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                        每次開啟或比對時，系統會自動掃描此目錄並使用最新的備份檔，無需重新輸入路徑
                                    </span>
                                </div>
                                <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                                    <input
                                        type="text"
                                        placeholder="例如: \\10.88.105.97\HostMonitor\Backup 或 D:\HostMonitor\Backup"
                                        value={uncPathInput}
                                        onChange={(e) => setUncPathInput(e.target.value)}
                                        style={{
                                            flex: 1,
                                            padding: '8px 12px',
                                            borderRadius: 8,
                                            background: 'rgba(0,0,0,0.2)',
                                            color: 'var(--text-primary)',
                                            border: '1px solid var(--border-color)',
                                            fontFamily: 'monospace',
                                            fontSize: 12
                                        }}
                                    />
                                    {isOperatorOrAdmin && (
                                        <button
                                            onClick={handleTestAndSaveUnc}
                                            disabled={isTestingUnc || !uncPathInput.trim()}
                                            style={{
                                                padding: '8px 16px',
                                                borderRadius: 8,
                                                background: 'var(--primary)',
                                                color: '#fff',
                                                border: 'none',
                                                fontSize: 12,
                                                fontWeight: 700,
                                                cursor: isTestingUnc || !uncPathInput.trim() ? 'not-allowed' : 'pointer'
                                            }}
                                        >
                                            {isTestingUnc ? '連線中...' : '測試並儲存 UNC'}
                                        </button>
                                    )}
                                </div>

                                {isOperatorOrAdmin && (
                                    <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                                        <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                            掃描逾時 (秒, 5-120)
                                            <input
                                                type="number"
                                                min={5}
                                                max={120}
                                                value={scanTimeoutInput}
                                                onChange={(e) => setScanTimeoutInput(e.target.value)}
                                                style={{ width: 70, padding: '4px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.2)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', fontSize: 12 }}
                                            />
                                        </label>
                                        <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 260 }}>
                                            檔名規則 (僅支援 * 萬用字元)
                                            <input
                                                type="text"
                                                value={filePatternInput}
                                                onChange={(e) => setFilePatternInput(e.target.value)}
                                                placeholder="hostmonitor-item-backup-*.txt"
                                                style={{ flex: 1, padding: '4px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.2)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', fontFamily: 'monospace', fontSize: 12 }}
                                            />
                                        </label>
                                    </div>
                                )}

                                {uncTestStatus && (
                                    <div style={{
                                        marginTop: 10, 
                                        fontSize: 12, 
                                        color: uncTestStatus.success ? '#10b981' : '#ef4444',
                                        background: uncTestStatus.success ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                                        padding: '8px 12px',
                                        borderRadius: 8
                                    }}>
                                        {uncTestStatus.success ? (
                                            <div>
                                                ✅ 路徑存取成功！共掃描到 <strong>{uncTestStatus.backupFilesFound}</strong> 個備份檔。
                                                {uncTestStatus.latestBackupFile && ` 最新檔案: ${uncTestStatus.latestBackupFile}`}
                                            </div>
                                        ) : (
                                            <div>❌ 連線失敗: {uncTestStatus.error}</div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Section B: Existing files list */}
                            <div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>可用備份檔案列表 (依日期與修改時間排序，最上方為最新檔案)：</span>
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>共 {statusData?.totalAvailable ?? (statusData?.availableFiles || []).length} 個檔案{statusData?.totalAvailable > (statusData?.availableFiles || []).length ? ` (顯示最新 ${(statusData?.availableFiles || []).length} 個)` : ''}</span>
                                </div>
                                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 180, overflowY: 'auto' }}>
                                    {(statusData?.availableFiles || []).map((f, idx) => (
                                        <div 
                                            key={idx} 
                                            style={{ 
                                                display: 'flex', 
                                                justifyContent: 'space-between', 
                                                alignItems: 'center',
                                                padding: '8px 12px',
                                                borderRadius: 10,
                                                background: (f.filename === activeFile?.filename && f.directory === activeFile?.directory) ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-secondary)',
                                                border: `1px solid ${(f.filename === activeFile?.filename && f.directory === activeFile?.directory) ? 'rgba(59, 130, 246, 0.4)' : 'var(--border-color)'}`
                                            }}
                                        >
                                            <div>
                                                <div style={{ fontWeight: 700, fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    {f.filename}
                                                    {idx === 0 && (
                                                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(16, 185, 129, 0.2)', color: '#10b981', fontWeight: 800 }}>
                                                            🌟 最新檔案
                                                        </span>
                                                    )}
                                                </div>
                                                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                                    路徑: {f.directory} · 大小: {formatFileSize(f.size)} · 修改時間: {f.modifiedAt?.replace('T', ' ').substring(0, 19)} · 來源: {describeFileSource(f.source)}
                                                </div>
                                            </div>
                                            <button
                                                onClick={async () => {
                                                    // Explicit pick: pin this file until the user switches back to "latest"
                                                    const pin = nextPinnedFile(pinnedFile, { type: 'pick', filename: f.filename, directory: f.directory });
                                                    setPinnedFile(pin);
                                                    setShowBackupModal(false);
                                                    await executeComparison(comparisonSource, cmdbEnvFilter, customText, true, false, pin);
                                                }}
                                                style={{
                                                    padding: '4px 12px',
                                                    borderRadius: 6,
                                                    background: f.filename === activeFile?.filename ? '#10b981' : 'var(--primary)',
                                                    color: '#fff',
                                                    border: 'none',
                                                    fontSize: 11,
                                                    fontWeight: 700,
                                                    cursor: 'pointer'
                                                }}
                                            >
                                                {f.filename === activeFile?.filename ? '使用中' : '固定使用此檔'}
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Section C: Upload / Paste new backup section */}
                            {isOperatorOrAdmin && (
                                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                                    <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>手動貼上備份檔文字內容 (備用)：</span>
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                        已上傳的備份僅在未設定 UNC 路徑，或儲存後明確選擇「使用已上傳的備份」時使用 (檔名僅允許英數字、點、底線、連字號，副檔名需為 .txt，大小上限 50 MB)。
                                    </span>
                                    <div style={{ display: 'flex', gap: 10 }}>
                                        <input
                                            type="text"
                                            placeholder={`自訂檔名 (預設: hostmonitor-item-backup-${new Date().toISOString().split('T')[0]}.txt)`}
                                            value={uploadFilename}
                                            onChange={(e) => setUploadFilename(e.target.value)}
                                            style={{
                                                flex: 1,
                                                padding: '6px 12px',
                                                borderRadius: 8,
                                                background: 'var(--bg-secondary)',
                                                color: 'var(--text-primary)',
                                                border: '1px solid var(--border-color)',
                                                fontSize: 12
                                            }}
                                        />
                                    </div>
                                    <textarea
                                        rows={3}
                                        placeholder="貼上 HostMonitor 匯出檔文字內容..."
                                        value={uploadContent}
                                        onChange={(e) => setUploadContent(e.target.value)}
                                        style={{
                                            width: '100%',
                                            padding: 10,
                                            borderRadius: 8,
                                            background: 'var(--bg-secondary)',
                                            color: 'var(--text-primary)',
                                            border: '1px solid var(--border-color)',
                                            fontSize: 11,
                                            fontFamily: 'monospace'
                                        }}
                                    />
                                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                        <button
                                            onClick={() => handleUploadBackup(false)}
                                            disabled={isUploading || !uploadContent.trim()}
                                            style={{
                                                padding: '6px 18px',
                                                borderRadius: 8,
                                                background: 'var(--primary)',
                                                color: '#fff',
                                                border: 'none',
                                                fontSize: 12,
                                                fontWeight: 700,
                                                cursor: isUploading || !uploadContent.trim() ? 'not-allowed' : 'pointer'
                                            }}
                                        >
                                            {isUploading ? '儲存中...' : '儲存並立即比對'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* MODAL 4: Ignored Environments Settings Modal */}
            {showIgnoredEnvsModal && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    background: 'rgba(0,0,0,0.6)',
                    backdropFilter: 'blur(8px)',
                    zIndex: 200,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 20
                }}>
                    <div style={{
                        background: 'var(--bg-glass)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 20,
                        width: '100%',
                        maxWidth: 520,
                        overflow: 'hidden'
                    }}>
                        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>🚫 略過比對環境設定</h3>
                            <button onClick={() => setShowIgnoredEnvsModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16 }}>✕</button>
                        </div>
                        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                                    勾選的環境將在比對時自動<strong>排除略過</strong>：
                                </p>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button
                                        type="button"
                                        onClick={() => setTempIgnoredEnvs([...availableEnvs])}
                                        style={{
                                            padding: '3px 8px',
                                            borderRadius: 6,
                                            fontSize: 11,
                                            fontWeight: 600,
                                            background: 'rgba(239, 68, 68, 0.15)',
                                            color: '#f87171',
                                            border: '1px solid rgba(239, 68, 68, 0.3)',
                                            cursor: 'pointer'
                                        }}
                                    >
                                        全選略過
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setTempIgnoredEnvs([])}
                                        style={{
                                            padding: '3px 8px',
                                            borderRadius: 6,
                                            fontSize: 11,
                                            fontWeight: 600,
                                            background: 'rgba(255, 255, 255, 0.08)',
                                            color: 'var(--text-secondary)',
                                            border: '1px solid var(--border-color)',
                                            cursor: 'pointer'
                                        }}
                                    >
                                        全部比對
                                    </button>
                                </div>
                            </div>
                            <div style={{
                                display: 'grid',
                                gridTemplateColumns: 'repeat(2, 1fr)',
                                gap: 10,
                                background: 'rgba(0, 0, 0, 0.25)',
                                padding: 14,
                                borderRadius: 12,
                                border: '1px solid var(--border-color)',
                                maxHeight: 300,
                                overflowY: 'auto'
                            }}>
                                {availableEnvs.map(env => {
                                    const isIgnored = tempIgnoredEnvs.includes(env);
                                    return (
                                        <label
                                            key={env}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'flex-start',
                                                gap: 10,
                                                padding: '9px 12px',
                                                borderRadius: 8,
                                                background: isIgnored ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                                                border: isIgnored ? '1px solid rgba(239, 68, 68, 0.45)' : '1px solid rgba(255, 255, 255, 0.08)',
                                                cursor: 'pointer',
                                                userSelect: 'none',
                                                marginBottom: 0,
                                                transition: 'all 0.15s ease'
                                            }}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={isIgnored}
                                                onChange={(e) => {
                                                    if (e.target.checked) {
                                                        setTempIgnoredEnvs([...tempIgnoredEnvs, env]);
                                                    } else {
                                                        setTempIgnoredEnvs(tempIgnoredEnvs.filter(x => x !== env));
                                                    }
                                                }}
                                                style={{
                                                    width: 16,
                                                    height: 16,
                                                    minWidth: 16,
                                                    maxWidth: 16,
                                                    margin: 0,
                                                    padding: 0,
                                                    cursor: 'pointer',
                                                    accentColor: '#ef4444',
                                                    flexShrink: 0
                                                }}
                                            />
                                            <span style={{
                                                fontSize: 13,
                                                fontWeight: 700,
                                                whiteSpace: 'nowrap',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                color: isIgnored ? '#f87171' : 'var(--text-primary)',
                                                flex: 1
                                            }}>
                                                {env}
                                            </span>
                                            {isIgnored && (
                                                <span style={{
                                                    fontSize: 10,
                                                    fontWeight: 700,
                                                    padding: '1px 5px',
                                                    borderRadius: 4,
                                                    background: 'rgba(239, 68, 68, 0.25)',
                                                    color: '#fca5a5',
                                                    border: '1px solid rgba(239, 68, 68, 0.4)',
                                                    flexShrink: 0
                                                }}>
                                                    略過
                                                </span>
                                            )}
                                        </label>
                                    );
                                })}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-secondary)' }}>
                                <span>目前狀態：{tempIgnoredEnvs.length === 0 ? '無略過 (全部納入比對)' : `已略過 ${tempIgnoredEnvs.length} 個環境 (${tempIgnoredEnvs.join(', ')})`}</span>
                                <span style={{ opacity: 0.7 }}>共 {availableEnvs.length} 個環境</span>
                            </div>
                        </div>
                        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                            <button
                                onClick={() => setShowIgnoredEnvsModal(false)}
                                style={{ padding: '6px 14px', borderRadius: 8, background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', cursor: 'pointer', fontSize: 12 }}
                            >
                                取消
                            </button>
                            <button
                                onClick={handleSaveIgnoredEnvs}
                                disabled={isSavingEnvs}
                                style={{ padding: '6px 18px', borderRadius: 8, background: 'var(--primary)', color: '#fff', border: 'none', cursor: isSavingEnvs ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700 }}
                            >
                                {isSavingEnvs ? '儲存中...' : '儲存設定'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default HmChecker;
