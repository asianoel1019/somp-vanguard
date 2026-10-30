import React, { useState, useEffect, useMemo } from 'react';
import { useToast } from '../../contexts/ToastContext';
import api from '../../api';
import { downloadCSV } from '../../utils/exportUtils';
import { resolveEnv } from '../../utils/environments';
import { FiSettings, FiCopy, FiCheck, FiRefreshCw, FiActivity, FiFilter } from 'react-icons/fi';

// Shared style factory (same design language as ServerInventory & SOMP Vanguard)
const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    headerBtns: { display: 'flex', gap: 10 },
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)', transition: 'all 0.2s ease' },
    btnO: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer', transition: 'all 0.2s ease' },
    topRow: { display: 'flex', gap: 20, marginBottom: 28 },
    card: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metCol: { width: 280, display: 'flex', flexDirection: 'column', gap: 20 },
    metCard: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metLabel: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', display: 'block', marginBottom: 8 },
    metVal: { fontSize: 36, fontWeight: 900, color: 'var(--text-primary)', lineHeight: 1 },
    metUnit: { fontSize: 14, fontWeight: 600, color: 'var(--text-muted)' },
    dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden' },
    tblHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 },
    tblTitle: { fontSize: 16, fontWeight: 900, margin: 0 },
    fRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    fBtn: { padding: '7px 16px', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: 'var(--text-secondary)', transition: 'all 0.15s ease' },
    fAct: { padding: '7px 16px', border: '1px solid var(--accent-primary)', borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: 'pointer', background: 'var(--accent-primary)', color: '#fff' },
    sBox: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-primary)' },
    sInput: { border: 'none', background: 'transparent', outline: 'none', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', width: 180 },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background-color 0.15s ease' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13 },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' },
    viewBtn: { padding: '6px 14px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 11, fontWeight: 900, cursor: 'pointer', letterSpacing: '0.04em', boxShadow: '0 4px 12px var(--accent-glow)', transition: 'opacity 0.2s' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 },
    modal: { background: 'var(--bg-card, #1e293b)', border: '1px solid var(--border-color)', borderRadius: 20, width: '100%', maxWidth: 720, boxShadow: '0 30px 60px rgba(0,0,0,0.4)', overflow: 'hidden', backdropFilter: 'blur(16px)', maxHeight: '90vh', display: 'flex', flexDirection: 'column' },
    modalH: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px', borderBottom: '1px solid var(--border-color)' },
    closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, fontSize: 20 },
    input: { width: '100%', borderRadius: 10, padding: '10px 14px', fontSize: 13, fontWeight: 600, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 4 },
    textarea: { width: '100%', borderRadius: 12, padding: 16, fontSize: 13, fontWeight: 600, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical', fontFamily: 'monospace', marginTop: 6 },
    hint: { marginTop: 12, padding: 14, borderRadius: 12, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, lineHeight: 1.6, border: '1px solid var(--border-color)' },
};

// Helper for 4-octet numerical IP comparison (1 to 255)
function compareIPs(ipA, ipB) {
    const partsA = String(ipA || '').trim().split('.').map(n => parseInt(n, 10) || 0);
    const partsB = String(ipB || '').trim().split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 4; i++) {
        const a = partsA[i] !== undefined ? partsA[i] : 0;
        const b = partsB[i] !== undefined ? partsB[i] : 0;
        if (a !== b) return a - b;
    }
    return 0;
}

const PrometheusSD = () => {
    const { showToast } = useToast();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';

    const [targets, setTargets] = useState([]);
    // Global environments (Settings -> Environments): the zone / env label must be one of these NAMES
    const [envOptions, setEnvOptions] = useState([]);
    const [pastedData, setPastedData] = useState('');
    const [filter, setFilter] = useState('');
    const [selectedBU, setSelectedBU] = useState('');
    const [selectedEnv, setSelectedEnv] = useState('');
    const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'windows' | 'linux' | 'offline'
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState(null);
    const [sdToken, setSdToken] = useState('YOUR_TOKEN_HERE');
    const [currentPage, setCurrentPage] = useState(1);
    const [selectedIPs, setSelectedIPs] = useState(new Set());
    const [editingIp, setEditingIp] = useState(null);
    const [editForm, setEditForm] = useState({});
    const [showAddModal, setShowAddModal] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(null);
    const [copiedYaml, setCopiedYaml] = useState(false);
    const [isScanning, setIsScanning] = useState(false);

    // Health check configuration state
    const [healthCheckConfig, setHealthCheckConfig] = useState({
        enabled: false,
        intervalMinutes: 15,
        lastRun: null
    });
    const [formHealthEnabled, setFormHealthEnabled] = useState(false);
    const [formHealthInterval, setFormHealthInterval] = useState(15);
    const [savingSettings, setSavingSettings] = useState(false);

    const PAGE_SIZE = 50;

    useEffect(() => {
        fetchTargets();
    }, []);

    const fetchTargets = async () => {
        try {
            const res = await api.get('/prometheus/list');
            setTargets(res.data.targets || []);
            setEnvOptions(Array.isArray(res.data.environments) ? res.data.environments : []);
            setSdToken(res.data.token || 'MISSING_TOKEN');
            if (res.data.healthCheckConfig) {
                setHealthCheckConfig(res.data.healthCheckConfig);
                setFormHealthEnabled(!!res.data.healthCheckConfig.enabled);
                setFormHealthInterval(res.data.healthCheckConfig.intervalMinutes || 15);
            }
        } catch (err) {
            console.error('[PrometheusSD] Fetch error:', err);
        }
    };

    // Extract unique Business Units (BU)
    const uniqueBUs = useMemo(() => {
        const buSet = new Set();
        let hasUnassigned = false;
        targets.forEach(t => {
            const bu = (t.labels?.group || '').trim();
            if (bu && bu !== '-') {
                buSet.add(bu);
            } else {
                hasUnassigned = true;
            }
        });
        const list = Array.from(buSet).sort();
        if (hasUnassigned) list.push('-');
        return list;
    }, [targets]);

    // Extract unique Environments
    const uniqueEnvs = useMemo(() => {
        const envSet = new Set();
        let hasUnassigned = false;
        targets.forEach(t => {
            const env = (t.labels?.zone || t.labels?.env || t.labels?.environment || '').trim();
            if (env && env !== '-') {
                envSet.add(env);
            } else {
                hasUnassigned = true;
            }
        });
        const list = Array.from(envSet).sort();
        if (hasUnassigned) list.push('-');
        return list;
    }, [targets]);

    const handleParse = async () => {
        if (!pastedData.trim()) return;
        setLoading(true);
        setStatus({ type: 'info', msg: 'Parsing and auto-detecting OS via ports...' });
        try {
            const res = await api.post('/prometheus/parse', { pastedText: pastedData });
            const added = res.data.addedCount || 0;
            const updated = res.data.updatedCount || 0;
            const skipped = Array.isArray(res.data.skippedLines) ? res.data.skippedLines : [];
            const skippedText = skipped.length
                ? ` Skipped ${skipped.length} line(s): ${skipped.slice(0, 5).map(s => `line ${s.line} (${s.reason})`).join(', ')}${skipped.length > 5 ? ', ...' : ''}.`
                : '';
            setStatus({ type: skipped.length ? 'info' : 'success', msg: `Processed: Added ${added} new targets, updated ${updated} existing targets.${skippedText}` });
            setPastedData('');
            fetchTargets();
            setShowAddModal(false);
        } catch (err) {
            setStatus({ type: 'error', msg: err?.response?.data?.error || err.message });
        } finally {
            setLoading(false);
            setTimeout(() => setStatus(null), 8000);
        }
    };

    const handleExportCSV = () => {
        if (!targets || targets.length === 0) {
            showToast('No targets available to export', 'error');
            return;
        }
        const exportList = filtered.length > 0 ? filtered : targets;
        const exportData = exportList.map(t => ({
            'IP': t.labels.addr || '',
            'HOSTNAME': t.labels.host || '-',
            'ENVIRONMENT': t.labels.zone || t.labels.env || t.labels.environment || '-',
            'ZONE': t.labels.zone || '-',
            'APPLICATION': t.labels.application || '-',
            'BU': t.labels.group || '-',
            'PORT': (t.targets[0] || '').split(':')[1] || '9100',
            'STATUS': t._status || 'unknown',
            'DISABLED': t.isPaused ? 'YES' : 'NO'
        }));
        downloadCSV(exportData, `Prometheus_Targets_${new Date().toISOString().split('T')[0]}.csv`);
        showToast(`Exported ${exportData.length} targets to CSV`, 'success');
    };

    // Single Target Actions
    const handleDelete = (ip) => setConfirmDelete({ type: 'single', payload: ip });

    const executeDelete = async (ip) => {
        try {
            await api.delete(`/prometheus/target/${encodeURIComponent(ip)}`);
            fetchTargets();
            showToast(`Deleted target ${ip}`, 'success');
        } catch (e) {
            showToast(e.response?.data?.error || e.message, 'error');
        }
        setConfirmDelete(null);
    };

    const handleTogglePause = async (ip, currentStatus) => {
        try {
            await api.put('/prometheus/pause', { ip, isPaused: !currentStatus });
            fetchTargets();
            showToast(`Target ${!currentStatus ? 'disabled' : 'enabled'}`, 'success');
        } catch (e) {
            showToast(e.response?.data?.error || e.message, 'error');
        }
    };

    // Multi-select Selection Handlers
    const handleSelectAll = (e) => {
        if (e.target.checked) {
            setSelectedIPs(new Set(paged.map(t => t.labels.addr)));
        } else {
            setSelectedIPs(new Set());
        }
    };

    const handleSelectRow = (ip) => {
        const s = new Set(selectedIPs);
        s.has(ip) ? s.delete(ip) : s.add(ip);
        setSelectedIPs(s);
    };

    // Batch Delete
    const handleBulkDelete = () => {
        if (selectedIPs.size === 0) return;
        setConfirmDelete({ type: 'bulk', payload: Array.from(selectedIPs) });
    };

    const executeBulkDelete = async (ips) => {
        try {
            await api.post('/prometheus/bulk-delete', { ips });
            setSelectedIPs(new Set());
            fetchTargets();
            showToast(`Deleted ${ips.length} targets`, 'success');
        } catch (e) {
            showToast(e.response?.data?.error || e.message, 'error');
        }
        setConfirmDelete(null);
    };

    // Batch Disable / Enable
    const handleBulkPause = async (isPaused) => {
        if (selectedIPs.size === 0) return;
        const ips = Array.from(selectedIPs);
        try {
            await api.post('/prometheus/bulk-pause', { ips, isPaused });
            setSelectedIPs(new Set());
            fetchTargets();
            showToast(`${isPaused ? 'Disabled' : 'Enabled'} ${ips.length} targets`, 'success');
        } catch (e) {
            showToast(e.response?.data?.error || e.message, 'error');
        }
    };

    // Inline Edit Handlers
    const toggleEdit = (t) => {
        if (editingIp === t.labels.addr) {
            setEditingIp(null);
        } else {
            setEditingIp(t.labels.addr);
            const port = t.targets[0].split(':')[1];
            setEditForm({
                originalIp: t.labels.addr,
                newIp: t.labels.addr,
                hostname: t.labels.host,
                application: t.labels.application,
                // canonical name when the label is a known environment, '' (choose) otherwise
                zone: (resolveEnv(t.labels.zone, envOptions) || {}).name || '',
                bu: t.labels.group,
                port
            });
        }
    };

    const handleSaveEdit = async () => {
        try {
            await api.put('/prometheus/update', editForm);
            setEditingIp(null);
            fetchTargets();
            showToast('Target updated successfully', 'success');
        } catch (e) {
            showToast(e?.response?.data?.error || e.message, "error");
        }
    };

    // Health Check Settings Handlers
    const handleSaveHealthCheckConfig = async () => {
        setSavingSettings(true);
        try {
            const res = await api.post('/prometheus/health-check-config', {
                enabled: formHealthEnabled,
                intervalMinutes: parseInt(formHealthInterval, 10) || 15
            });
            if (res.data?.config) {
                setHealthCheckConfig(res.data.config);
            }
            showToast('Health check configuration saved!', 'success');
            fetchTargets();
        } catch (err) {
            showToast(err.response?.data?.error || err.message, 'error');
        } finally {
            setSavingSettings(false);
        }
    };

    const handleRunScanNow = async () => {
        setIsScanning(true);
        try {
            const res = await api.post('/prometheus/health-check-run');
            showToast(`Health scan complete: ${res.data?.result?.offline || 0} offline`, 'success');
            fetchTargets();
        } catch (err) {
            showToast(err.response?.data?.error || err.message, 'error');
        } finally {
            setIsScanning(false);
        }
    };

    const copyYamlToClipboard = () => {
        navigator.clipboard.writeText(configYaml);
        setCopiedYaml(true);
        showToast('YAML configuration copied to clipboard', 'info');
        setTimeout(() => setCopiedYaml(false), 2000);
    };

    // Metric Calculations
    const winCount = targets.filter(t => t.targets[0]?.includes(':9182')).length;
    const linuxCount = targets.filter(t => t.targets[0]?.includes(':9100')).length;
    const offlineCount = targets.filter(t => t._status === 'offline').length;

    // Filter Logic
    const filtered = targets.filter(t => {
        // Status / OS filter
        if (statusFilter === 'windows' && !t.targets[0]?.includes(':9182')) return false;
        if (statusFilter === 'linux' && !t.targets[0]?.includes(':9100')) return false;
        if (statusFilter === 'offline' && t._status !== 'offline') return false;

        // BU filter
        if (selectedBU && (t.labels?.group || '-') !== selectedBU) return false;

        // Environment filter
        if (selectedEnv && (t.labels?.zone || t.labels?.env || t.labels?.environment || '-') !== selectedEnv) return false;

        // Text search filter
        if (filter.trim()) {
            const s = `${t.labels?.addr || ''} ${t.labels?.host || ''} ${t.labels?.zone || ''} ${t.labels?.application || ''} ${t.labels?.group || ''}`.toLowerCase();
            return s.includes(filter.toLowerCase().trim());
        }

        return true;
    }).sort((a, b) => compareIPs(a.labels?.addr, b.labels?.addr));

    useEffect(() => { setCurrentPage(1); }, [filter, selectedBU, selectedEnv, statusFilter]);

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(currentPage, totalPages);
    const paged = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

    const configYaml = `scrape_configs:\n  - job_name: 'dynamic-http'\n    http_sd_configs:\n      - url: "${window.location.origin}/api/prometheus/targets"\n        bearer_token: "${sdToken}"\n        refresh_interval: 30s`;

    return (
        <div style={S.page}>
            {/* Header */}
            <div style={S.header}>
                <div>
                    <h1 className="page-title">Prometheus Targets</h1>
                    <p className="page-subtitle">Service Discovery API for File-Based SD & Health Monitoring</p>
                </div>
                <div style={S.headerBtns}>
                    <button style={S.btnO} onClick={handleExportCSV}>📥 Export CSV / Excel</button>
                    {role !== 'Viewer' && (
                        <button style={S.btnP} onClick={() => setShowAddModal(true)}>+ Add / Update Targets</button>
                    )}
                    <button style={S.btnO} onClick={() => setShowSettingsModal(true)}>
                        <FiSettings style={{ fontSize: 15 }} /> Settings
                    </button>
                </div>
            </div>

            {/* Top Stats & Overview */}
            <div style={S.topRow}>
                <div style={S.card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 14, fontWeight: 900, letterSpacing: '0.06em' }}>TARGET OVERVIEW</span>
                            {(statusFilter !== 'all' || selectedBU || selectedEnv) && (
                                <button
                                    onClick={() => {
                                        setStatusFilter('all');
                                        setSelectedBU('');
                                        setSelectedEnv('');
                                    }}
                                    style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '2px 8px', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', cursor: 'pointer' }}
                                >
                                    Clear Filter ✕
                                </button>
                            )}
                        </div>
                        <div style={{ display: 'flex', gap: 18 }}>
                            <span
                                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer' }}
                                onClick={() => setStatusFilter(statusFilter === 'windows' ? 'all' : 'windows')}
                            >
                                <span style={{ ...S.dot, background: 'var(--success)' }} /> Windows ({winCount})
                            </span>
                            <span
                                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', cursor: 'pointer' }}
                                onClick={() => setStatusFilter(statusFilter === 'linux' ? 'all' : 'linux')}
                            >
                                <span style={{ ...S.dot, background: 'var(--warning)' }} /> Linux ({linuxCount})
                            </span>
                            {healthCheckConfig.enabled && (
                                <span
                                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--danger)', cursor: 'pointer' }}
                                    onClick={() => setStatusFilter(statusFilter === 'offline' ? 'all' : 'offline')}
                                >
                                    <span style={{ ...S.dot, background: 'var(--danger)' }} /> Offline ({offlineCount})
                                </span>
                            )}
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
                        {/* Windows Card */}
                        <div
                            onClick={() => setStatusFilter(statusFilter === 'windows' ? 'all' : 'windows')}
                            style={{
                                background: statusFilter === 'windows' ? 'var(--accent-glow)' : 'var(--bg-primary)',
                                border: `1px solid ${statusFilter === 'windows' ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                borderRadius: 12,
                                padding: 16,
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                            }}
                        >
                            <span style={{ fontSize: 13, fontWeight: 800 }}>🪟 Windows (9182)</span>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{winCount} targets registered</div>
                            <div style={{ height: 5, borderRadius: 10, background: 'var(--border-color)', marginTop: 10, overflow: 'hidden' }}>
                                <div style={{ height: '100%', borderRadius: 10, background: 'var(--accent-primary)', width: `${targets.length ? (winCount / targets.length) * 100 : 0}%` }} />
                            </div>
                        </div>

                        {/* Linux Card */}
                        <div
                            onClick={() => setStatusFilter(statusFilter === 'linux' ? 'all' : 'linux')}
                            style={{
                                background: statusFilter === 'linux' ? 'var(--accent-glow)' : 'var(--bg-primary)',
                                border: `1px solid ${statusFilter === 'linux' ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                borderRadius: 12,
                                padding: 16,
                                cursor: 'pointer',
                                transition: 'all 0.2s'
                            }}
                        >
                            <span style={{ fontSize: 13, fontWeight: 800 }}>🐧 Linux (9100)</span>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{linuxCount} targets registered</div>
                            <div style={{ height: 5, borderRadius: 10, background: 'var(--border-color)', marginTop: 10, overflow: 'hidden' }}>
                                <div style={{ height: '100%', borderRadius: 10, background: 'var(--warning)', width: `${targets.length ? (linuxCount / targets.length) * 100 : 0}%` }} />
                            </div>
                        </div>

                        {/* Offline Card (Only displayed when health check is enabled) */}
                        {healthCheckConfig.enabled && (
                            <div
                                onClick={() => setStatusFilter(statusFilter === 'offline' ? 'all' : 'offline')}
                                style={{
                                    background: statusFilter === 'offline' ? 'rgba(239, 68, 68, 0.15)' : 'var(--bg-primary)',
                                    border: `1px solid ${statusFilter === 'offline' ? 'var(--danger)' : 'var(--border-color)'}`,
                                    borderRadius: 12,
                                    padding: 16,
                                    cursor: 'pointer',
                                    transition: 'all 0.2s'
                                }}
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--danger)' }}>🚨 Offline</span>
                                    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(239,68,68,0.2)', color: 'var(--danger)', fontWeight: 700 }}>HEALTH SCAN</span>
                                </div>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{offlineCount} targets unreachable</div>
                                <div style={{ height: 5, borderRadius: 10, background: 'var(--border-color)', marginTop: 10, overflow: 'hidden' }}>
                                    <div style={{ height: '100%', borderRadius: 10, background: 'var(--danger)', width: `${targets.length ? (offlineCount / targets.length) * 100 : 0}%` }} />
                                </div>
                            </div>
                        )}

                        {/* Environment Dropdown Filter Card */}
                        <div
                            style={{
                                background: selectedEnv ? 'var(--accent-glow)' : 'var(--bg-primary)',
                                border: `1px solid ${selectedEnv ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                borderRadius: 12,
                                padding: 14,
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'space-between',
                                transition: 'all 0.2s'
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <FiFilter style={{ color: 'var(--accent-primary)' }} /> Environment Filter
                                </span>
                                {selectedEnv && (
                                    <button
                                        onClick={() => setSelectedEnv('')}
                                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}
                                    >
                                        Clear
                                    </button>
                                )}
                            </div>
                            <div style={{ marginTop: 8 }}>
                                <select
                                    value={selectedEnv}
                                    onChange={(e) => setSelectedEnv(e.target.value)}
                                    style={{
                                        width: '100%',
                                        padding: '7px 10px',
                                        borderRadius: 8,
                                        border: '1px solid var(--border-color)',
                                        background: 'var(--bg-secondary)',
                                        color: 'var(--text-primary)',
                                        fontSize: 12,
                                        fontWeight: 700,
                                        outline: 'none',
                                        cursor: 'pointer'
                                    }}
                                >
                                    <option value="">All Environments ({targets.length})</option>
                                    {uniqueEnvs.map(env => {
                                        const count = targets.filter(t => (t.labels?.zone || t.labels?.env || t.labels?.environment || '-') === env).length;
                                        return (
                                            <option key={env} value={env}>
                                                {env === '-' ? 'Unassigned (-)' : env} ({count})
                                            </option>
                                        );
                                    })}
                                </select>
                            </div>
                        </div>

                        {/* Business Unit (BU) Dropdown Filter Card */}
                        <div
                            style={{
                                background: selectedBU ? 'var(--accent-glow)' : 'var(--bg-primary)',
                                border: `1px solid ${selectedBU ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                borderRadius: 12,
                                padding: 14,
                                display: 'flex',
                                flexDirection: 'column',
                                justifyContent: 'space-between'
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ fontSize: 13, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <FiFilter style={{ color: 'var(--accent-primary)' }} /> BU Filter
                                </span>
                                {selectedBU && (
                                    <button
                                        onClick={() => setSelectedBU('')}
                                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer', fontWeight: 700 }}
                                    >
                                        Clear
                                    </button>
                                )}
                            </div>
                            <div style={{ marginTop: 8 }}>
                                <select
                                    value={selectedBU}
                                    onChange={(e) => setSelectedBU(e.target.value)}
                                    style={{
                                        width: '100%',
                                        padding: '7px 10px',
                                        borderRadius: 8,
                                        border: '1px solid var(--border-color)',
                                        background: 'var(--bg-secondary)',
                                        color: 'var(--text-primary)',
                                        fontSize: 12,
                                        fontWeight: 700,
                                        outline: 'none',
                                        cursor: 'pointer'
                                    }}
                                >
                                    <option value="">All BUs ({targets.length})</option>
                                    {uniqueBUs.map(bu => {
                                        const count = targets.filter(t => (t.labels?.group || '-') === bu).length;
                                        return (
                                            <option key={bu} value={bu}>
                                                {bu} ({count})
                                            </option>
                                        );
                                    })}
                                </select>
                            </div>
                        </div>
                    </div>
                </div>

                <div style={S.metCol}>
                    <div style={S.metCard}>
                        <span style={S.metLabel}>TOTAL TARGETS</span>
                        <div style={S.metVal}>{targets.length}</div>
                    </div>
                    <div style={S.metCard}>
                        <span style={S.metLabel}>HEALTH CHECK</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                            <span style={{ ...S.dot, background: healthCheckConfig.enabled ? 'var(--success)' : 'var(--text-muted)' }} />
                            <span style={{ fontSize: 13, fontWeight: 800, color: healthCheckConfig.enabled ? 'var(--success)' : 'var(--text-muted)' }}>
                                {healthCheckConfig.enabled ? `Active (${healthCheckConfig.intervalMinutes}m)` : 'Disabled'}
                            </span>
                        </div>
                        {healthCheckConfig.lastRun && (
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                                Last check: {new Date(healthCheckConfig.lastRun).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Targets Table */}
            <div style={S.tblWrap}>
                <div style={S.tblHead}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                        <h3 style={S.tblTitle}>Registered Targets</h3>
                        <div style={S.sBox}>
                            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>🔍</span>
                            <input
                                type="text"
                                placeholder="Filter by IP, Host, App..."
                                style={S.sInput}
                                value={filter}
                                onChange={e => setFilter(e.target.value)}
                            />
                        </div>

                        {selectedEnv && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, background: 'var(--accent-glow)', border: '1px solid var(--accent-primary)', fontSize: 12, fontWeight: 800, color: 'var(--accent-primary)' }}>
                                Env: {selectedEnv === '-' ? 'Unassigned' : selectedEnv}
                                <span style={{ cursor: 'pointer', marginLeft: 2 }} onClick={() => setSelectedEnv('')} title="Clear Environment filter">✕</span>
                            </span>
                        )}
                        {selectedBU && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 8, background: 'var(--accent-glow)', border: '1px solid var(--accent-primary)', fontSize: 12, fontWeight: 800, color: 'var(--accent-primary)' }}>
                                BU: {selectedBU === '-' ? 'Unassigned' : selectedBU}
                                <span style={{ cursor: 'pointer', marginLeft: 2 }} onClick={() => setSelectedBU('')} title="Clear BU filter">✕</span>
                            </span>
                        )}

                        {/* Multi-select Action Buttons inside Registered Targets card */}
                        {role !== 'Viewer' && selectedIPs.size > 0 && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-secondary)', padding: '4px 10px', borderRadius: 10, border: '1px solid var(--border-color)' }}>
                                <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent-primary)' }}>
                                    {selectedIPs.size} selected
                                </span>
                                <button
                                    style={{ ...S.btnO, padding: '5px 12px', fontSize: 11, color: 'var(--warning)', borderColor: 'var(--warning)' }}
                                    onClick={() => handleBulkPause(true)}
                                    title="Disable selected targets"
                                >
                                    ⏸️ Disable
                                </button>
                                <button
                                    style={{ ...S.btnO, padding: '5px 12px', fontSize: 11, color: 'var(--success)', borderColor: 'var(--success)' }}
                                    onClick={() => handleBulkPause(false)}
                                    title="Enable selected targets"
                                >
                                    ▶️ Enable
                                </button>
                                <button
                                    style={{ ...S.btnO, padding: '5px 12px', fontSize: 11, color: 'var(--danger)', borderColor: 'var(--danger)' }}
                                    onClick={handleBulkDelete}
                                    title="Delete selected targets"
                                >
                                    🗑️ Delete
                                </button>
                            </div>
                        )}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <button
                                disabled={safePage <= 1}
                                onClick={() => setCurrentPage(safePage - 1)}
                                style={{ ...S.fBtn, minWidth: 32, textAlign: 'center', padding: '5px 10px', opacity: safePage <= 1 ? 0.35 : 1 }}
                            >
                                &lt;
                            </button>
                            <span style={{ padding: '5px 12px', fontSize: 13, fontWeight: 900 }}>{safePage} / {totalPages}</span>
                            <button
                                disabled={safePage >= totalPages}
                                onClick={() => setCurrentPage(safePage + 1)}
                                style={{ ...S.fBtn, minWidth: 32, textAlign: 'center', padding: '5px 10px', opacity: safePage >= totalPages ? 0.35 : 1 }}
                            >
                                &gt;
                            </button>
                        </div>
                        {filtered.length > PAGE_SIZE && (
                            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                                Showing {((safePage - 1) * PAGE_SIZE) + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
                            </span>
                        )}
                    </div>
                </div>

                <table style={S.tbl}>
                    <thead>
                        <tr>
                            <th style={{ ...S.th, width: 40, textAlign: 'center' }}>
                                <input
                                    type="checkbox"
                                    onChange={handleSelectAll}
                                    checked={paged.length > 0 && paged.every(t => selectedIPs.has(t.labels.addr))}
                                    style={{ accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                                />
                            </th>
                            <th style={S.th}>IP ADDRESS</th>
                            <th style={S.th}>HOSTNAME</th>
                            <th style={S.th}>APPLICATION</th>
                            <th style={S.th}>ENVIRONMENT</th>
                            <th style={S.th}>BU</th>
                            <th style={S.th}>STATUS</th>
                            <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                        </tr>
                    </thead>
                    <tbody>
                        {paged.length === 0 && (
                            <tr>
                                <td colSpan="8" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                    No targets found matching criteria.
                                </td>
                            </tr>
                        )}
                        {paged.map((t, i) => {
                            const port = t.targets[0].split(':')[1];
                            const osTag = port === '9182' ? 'Win' : port === '9100' ? 'Linux' : '?';
                            const isEd = editingIp === t.labels.addr;

                            // Health and pause status badges
                            let statusBadge = null;
                            if (t.isPaused) {
                                statusBadge = (
                                    <span style={{ ...S.badge, background: 'rgba(148, 163, 184, 0.15)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }}>
                                        ⏸️ Paused
                                    </span>
                                );
                            } else if (healthCheckConfig.enabled) {
                                if (t._status === 'online') {
                                    statusBadge = (
                                        <span style={{ ...S.badge, background: 'rgba(34, 197, 94, 0.15)', color: 'var(--success)', border: '1px solid rgba(34, 197, 94, 0.3)' }}>
                                            🟢 Online
                                        </span>
                                    );
                                } else if (t._status === 'offline') {
                                    statusBadge = (
                                        <span style={{ ...S.badge, background: 'rgba(239, 68, 68, 0.15)', color: 'var(--danger)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                                            🔴 Offline
                                        </span>
                                    );
                                } else {
                                    statusBadge = (
                                        <span style={{ ...S.badge, background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                                            ⚪ Unknown
                                        </span>
                                    );
                                }
                            } else {
                                statusBadge = (
                                    <span style={{ ...S.badge, background: 'rgba(59, 130, 246, 0.15)', color: 'var(--accent-primary)' }}>
                                        Active
                                    </span>
                                );
                            }

                            return (
                                <React.Fragment key={i}>
                                    <tr style={{ ...S.tr, opacity: t.isPaused ? 0.5 : 1, filter: t.isPaused ? 'grayscale(100%)' : 'none' }}>
                                        <td style={{ ...S.td, textAlign: 'center' }}>
                                            <input
                                                type="checkbox"
                                                checked={selectedIPs.has(t.labels.addr)}
                                                onChange={() => role !== 'Viewer' && handleSelectRow(t.labels.addr)}
                                                style={{ accentColor: 'var(--accent-primary)', cursor: role === 'Viewer' ? 'not-allowed' : 'pointer' }}
                                                disabled={role === 'Viewer'}
                                            />
                                        </td>
                                        <td
                                            style={{ ...S.td, fontFamily: 'monospace', fontWeight: 800, color: 'var(--accent-primary)', cursor: role !== 'Viewer' ? 'pointer' : 'default' }}
                                            onClick={() => role !== 'Viewer' && toggleEdit(t)}
                                        >
                                            {t.labels.addr} <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({port})</span>
                                        </td>
                                        <td style={S.td}>
                                            {t.labels.host} <span style={S.badge}>{osTag}</span>
                                        </td>
                                        <td style={{ ...S.td, color: 'var(--text-muted)' }}>{t.labels.application}</td>
                                        <td style={S.td}>
                                            <span
                                                style={{ ...S.badge, cursor: 'pointer', transition: 'all 0.15s ease' }}
                                                onClick={() => setSelectedEnv(t.labels.zone || '-')}
                                                title="Click to filter by this Environment"
                                            >
                                                {t.labels.zone}
                                            </span>
                                            {(t.envWarning || []).length > 0 && (
                                                <span
                                                    style={{ ...S.badge, marginLeft: 6, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.35)' }}
                                                    title={`Not in Settings -> Environments: ${t.envWarning.map(w => `${w.label}=${w.value}`).join(', ')}`}
                                                >
                                                    ⚠ not in Environments
                                                </span>
                                            )}
                                        </td>
                                        <td style={S.td}>
                                            <span
                                                style={{ ...S.badge, cursor: 'pointer', transition: 'all 0.15s ease' }}
                                                onClick={() => setSelectedBU(t.labels.group || '-')}
                                                title="Click to filter by this BU"
                                            >
                                                {t.labels.group}
                                            </span>
                                        </td>
                                        <td style={S.td}>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                                {statusBadge}
                                                {healthCheckConfig.enabled && t._lastChecked && (
                                                    <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>
                                                        {new Date(t._lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td style={{ ...S.td, textAlign: 'right' }}>
                                            {role !== 'Viewer' ? (
                                                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                                    <button
                                                        style={{
                                                            ...S.viewBtn,
                                                            background: t.isPaused ? 'var(--success)' : 'var(--warning)',
                                                            color: t.isPaused ? '#fff' : '#000'
                                                        }}
                                                        onClick={() => handleTogglePause(t.labels.addr, t.isPaused)}
                                                    >
                                                        {t.isPaused ? 'ENABLE' : 'DISABLE'}
                                                    </button>
                                                    <button
                                                        style={{ ...S.viewBtn, background: 'var(--danger)' }}
                                                        onClick={() => handleDelete(t.labels.addr)}
                                                    >
                                                        DELETE
                                                    </button>
                                                </div>
                                            ) : (
                                                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Read Only</span>
                                            )}
                                        </td>
                                    </tr>
                                    {isEd && (
                                        <tr style={{ background: 'var(--bg-secondary)' }}>
                                            <td colSpan="8" style={{ padding: '16px 24px' }}>
                                                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                                                    {[
                                                        ['IP', 'newIp', 130],
                                                        ['Port', 'port', 80],
                                                        ['Hostname', 'hostname', 160],
                                                        ['Application', 'application', 200],
                                                        ['Environment', 'zone', 110],
                                                        ['BU', 'bu', 110]
                                                    ].map(([lbl, key, w]) => (
                                                        <div key={key} style={{ width: w }}>
                                                            <label style={S.metLabel}>{lbl}</label>
                                                            {key === 'zone' ? (
                                                                <select
                                                                    style={{ ...S.input, marginTop: 2, padding: '8px 10px', fontSize: 12 }}
                                                                    value={editForm.zone || ''}
                                                                    onChange={e => setEditForm({ ...editForm, zone: e.target.value })}
                                                                >
                                                                    <option value="" disabled>Choose...</option>
                                                                    {envOptions.map(env => <option key={env.id} value={env.name}>{env.name}</option>)}
                                                                </select>
                                                            ) : (
                                                                <input
                                                                    type="text"
                                                                    style={{ ...S.input, marginTop: 2, padding: '8px 10px', fontSize: 12 }}
                                                                    value={editForm[key] || ''}
                                                                    onChange={e => setEditForm({ ...editForm, [key]: e.target.value })}
                                                                />
                                                            )}
                                                        </div>
                                                    ))}
                                                    <div style={{ display: 'flex', gap: 8 }}>
                                                        <button style={{ ...S.btnP, padding: '8px 16px', fontSize: 12 }} onClick={handleSaveEdit}>
                                                            Save
                                                        </button>
                                                        <button style={{ ...S.btnO, padding: '8px 16px', fontSize: 12 }} onClick={() => setEditingIp(null)}>
                                                            Cancel
                                                        </button>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Status Toast Notification */}
            {status && (
                <div style={{
                    position: 'fixed',
                    bottom: 24,
                    right: 24,
                    padding: '14px 24px',
                    borderRadius: 16,
                    fontSize: 13,
                    fontWeight: 700,
                    zIndex: 300,
                    background: status.type === 'error' ? 'var(--danger)' : status.type === 'info' ? 'var(--warning)' : 'var(--success)',
                    color: '#fff',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.3)'
                }}>
                    {status.msg}
                </div>
            )}

            {/* Add / Batch Update Targets Modal */}
            {showAddModal && (
                <div style={S.overlay} onClick={() => setShowAddModal(false)}>
                    <div style={{ ...S.modal, maxWidth: 650 }} onClick={e => e.stopPropagation()}>
                        <div style={S.modalH}>
                            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>🎯 Add / Batch Update Targets</h3>
                            <button style={S.closeBtn} onClick={() => setShowAddModal(false)}>✕</button>
                        </div>
                        <div style={{ padding: 28, overflowY: 'auto' }}>
                            <div style={S.hint}>
                                <strong>Paste Excel / CSV / TSV format:</strong><br/>
                                <code>IP, HOSTNAME, ZONE, APPLICATION, BU</code> (Comma or Tab separated, 1 target per line).<br/>
                                <i>Tip: Existing IPs will be updated with new APPLICATION, ZONE, and BU labels automatically!</i>
                            </div>
                            <textarea
                                style={{ ...S.textarea, marginTop: 16 }}
                                rows="8"
                                value={pastedData}
                                onChange={e => setPastedData(e.target.value)}
                                placeholder={"IP, HOSTNAME, ZONE, APPLICATION, BU\n10.99.26.112, N-SYS-PROME01, MM_C1, Prometheus server, INFRA-SYS"}
                                disabled={loading}
                            />
                            <button
                                style={{ ...S.btnP, width: '100%', justifyContent: 'center', marginTop: 16, opacity: loading || !pastedData.trim() ? 0.5 : 1 }}
                                onClick={handleParse}
                                disabled={loading || !pastedData.trim()}
                            >
                                {loading ? 'Probing OS & Updating Targets...' : 'Parse & Process Targets'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Settings Modal (Health Check + Config YAML) */}
            {showSettingsModal && (
                <div style={S.overlay} onClick={() => setShowSettingsModal(false)}>
                    <div style={{ ...S.modal, maxWidth: 680 }} onClick={e => e.stopPropagation()}>
                        <div style={S.modalH}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <FiSettings style={{ fontSize: 18, color: 'var(--accent-primary)' }} />
                                <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>Prometheus & Health Check Settings</h3>
                            </div>
                            <button style={S.closeBtn} onClick={() => setShowSettingsModal(false)}>✕</button>
                        </div>

                        <div style={{ padding: 28, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
                            {/* Section 1: Health Check Configuration */}
                            <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 20 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                    <div>
                                        <h4 style={{ margin: 0, fontSize: 15, fontWeight: 900, display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <FiActivity style={{ color: formHealthEnabled ? 'var(--success)' : 'var(--text-muted)' }} />
                                            Target Health Check Engine
                                        </h4>
                                        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                                            Background TCP port probe (9182 for Windows, 9100 for Linux) using native OS polling.
                                        </p>
                                    </div>

                                    {/* Enable / Disable Toggle Switch */}
                                    <button
                                        type="button"
                                        onClick={() => role !== 'Viewer' && setFormHealthEnabled(!formHealthEnabled)}
                                        disabled={role === 'Viewer'}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: 8,
                                            padding: '8px 16px',
                                            borderRadius: 20,
                                            border: `1px solid ${formHealthEnabled ? 'var(--success)' : 'var(--border-color)'}`,
                                            background: formHealthEnabled ? 'rgba(34, 197, 94, 0.15)' : 'var(--bg-secondary)',
                                            color: formHealthEnabled ? 'var(--success)' : 'var(--text-muted)',
                                            fontWeight: 800,
                                            fontSize: 12,
                                            cursor: role === 'Viewer' ? 'not-allowed' : 'pointer',
                                            transition: 'all 0.2s'
                                        }}
                                    >
                                        <span style={{ ...S.dot, background: formHealthEnabled ? 'var(--success)' : 'var(--text-muted)' }} />
                                        {formHealthEnabled ? 'ENABLED' : 'DISABLED'}
                                    </button>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
                                    <div>
                                        <label style={S.metLabel}>CHECK INTERVAL</label>
                                        <select
                                            value={formHealthInterval}
                                            onChange={(e) => setFormHealthInterval(parseInt(e.target.value, 10))}
                                            disabled={!formHealthEnabled || role === 'Viewer'}
                                            style={{
                                                ...S.input,
                                                opacity: !formHealthEnabled ? 0.5 : 1,
                                                cursor: !formHealthEnabled ? 'not-allowed' : 'pointer'
                                            }}
                                        >
                                            <option value={5}>Every 5 minutes</option>
                                            <option value={10}>Every 10 minutes</option>
                                            <option value={15}>Every 15 minutes (Default)</option>
                                            <option value={30}>Every 30 minutes</option>
                                            <option value={60}>Every 60 minutes (1 hour)</option>
                                            <option value={120}>Every 2 hours</option>
                                        </select>
                                    </div>

                                    <div>
                                        <label style={S.metLabel}>LAST INSPECTION</label>
                                        <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                                            {healthCheckConfig.lastRun
                                                ? new Date(healthCheckConfig.lastRun).toLocaleString()
                                                : 'No scans executed yet'}
                                        </div>
                                    </div>
                                </div>

                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-color)' }}>
                                    <button
                                        type="button"
                                        style={{
                                            ...S.btnO,
                                            padding: '8px 16px',
                                            fontSize: 12,
                                            opacity: isScanning || role === 'Viewer' ? 0.5 : 1
                                        }}
                                        onClick={handleRunScanNow}
                                        disabled={isScanning || role === 'Viewer'}
                                    >
                                        <FiRefreshCw style={{ animation: isScanning ? 'spin 1s linear infinite' : 'none' }} />
                                        {isScanning ? 'Scanning...' : 'Run Scan Now'}
                                    </button>

                                    {role !== 'Viewer' && (
                                        <button
                                            type="button"
                                            style={{ ...S.btnP, padding: '8px 20px', fontSize: 12 }}
                                            onClick={handleSaveHealthCheckConfig}
                                            disabled={savingSettings}
                                        >
                                            {savingSettings ? 'Saving...' : 'Save Settings'}
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Section 2: Prometheus SD Config YAML */}
                            <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 20 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                    <div>
                                        <h4 style={{ margin: 0, fontSize: 15, fontWeight: 900 }}>📄 Prometheus Scrape Config YAML</h4>
                                        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
                                            Copy this configuration into your <code>prometheus.yml</code>.
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        style={{ ...S.btnO, padding: '6px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}
                                        onClick={copyYamlToClipboard}
                                    >
                                        {copiedYaml ? <FiCheck style={{ color: 'var(--success)' }} /> : <FiCopy />}
                                        {copiedYaml ? 'Copied' : 'Copy YAML'}
                                    </button>
                                </div>
                                <pre style={{ ...S.textarea, whiteSpace: 'pre-wrap', color: 'var(--accent-primary)', lineHeight: 1.7, cursor: 'text', userSelect: 'all', margin: 0, fontSize: 12 }}>
                                    {configYaml}
                                </pre>
                            </div>
                        </div>

                        <div style={{ padding: '16px 28px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', background: 'var(--bg-secondary)' }}>
                            <button style={S.btnO} onClick={() => setShowSettingsModal(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Delete Confirmation Modal (Rule 5: No native browser confirm) */}
            {confirmDelete && (
                <div style={S.overlay} onClick={() => setConfirmDelete(null)}>
                    <div style={{ ...S.modal, maxWidth: 420, padding: 32, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: 44, marginBottom: 14 }}>⚠️</div>
                        <h3 style={{ fontSize: 20, fontWeight: 900, margin: '0 0 12px 0' }}>Confirm Deletion</h3>
                        <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 24, lineHeight: 1.5 }}>
                            {confirmDelete.type === 'single'
                                ? `Are you sure you want to delete the target ${confirmDelete.payload}?`
                                : `Are you sure you want to delete ${confirmDelete.payload.length} targets?`}
                        </p>
                        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                            <button style={{ ...S.btnO, padding: '10px 24px' }} onClick={() => setConfirmDelete(null)}>Cancel</button>
                            <button
                                style={{ ...S.btnP, padding: '10px 24px', background: 'var(--danger)' }}
                                onClick={() => confirmDelete.type === 'single' ? executeDelete(confirmDelete.payload) : executeBulkDelete(confirmDelete.payload)}
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PrometheusSD;
