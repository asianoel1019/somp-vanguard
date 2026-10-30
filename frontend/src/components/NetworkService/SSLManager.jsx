import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import { useSync } from '../../contexts/WebSocketContext';
import { useToast } from '../../contexts/ToastContext';
import { normalizeEnvs, defaultEnv } from '../../utils/environments';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    headerBtns: { display: 'flex', gap: 10 },
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnO: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
    topRow: { display: 'flex', gap: 20, marginBottom: 28 },
    card: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metCol: { width: 280, display: 'flex', flexDirection: 'column', gap: 20 },
    metCard: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metLabel: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', display: 'block', marginBottom: 8 },
    metVal: { fontSize: 36, fontWeight: 900, color: 'var(--text-primary)', lineHeight: 1 },
    dot: { width: 10, height: 10, borderRadius: '50%', display: 'inline-block' },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden' },
    tblHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 },
    tblTitle: { fontSize: 16, fontWeight: 900, margin: 0 },
    sBox: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid var(--border-color)', borderRadius: 8 },
    sInput: { border: 'none', background: 'transparent', outline: 'none', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', width: 180 },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13 },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-block' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 650, boxShadow: '0 30px 60px rgba(0,0,0,0.3)', overflow: 'hidden', backdropFilter: 'blur(16px)' },
    modalH: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px', borderBottom: '1px solid var(--border-color)' },
    closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, fontSize: 20 },
    input: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box' },
    textarea: { width: '100%', borderRadius: 12, padding: 16, fontSize: 13, fontWeight: 600, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical', fontFamily: 'monospace', marginTop: 6, boxSizing: 'border-box' },
    gridRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 12 },
    hint: { marginTop: 12, padding: 14, borderRadius: 12, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, lineHeight: 1.6, border: '1px solid var(--border-color)' },
    fileUploadArea: { border: '2px dashed var(--border-color)', borderRadius: 12, padding: '20px', textAlign: 'center', cursor: 'pointer', background: 'var(--bg-primary)', transition: 'border-color 0.2s', marginTop: 12 },
    fileInfo: { marginTop: 8, padding: '8px 12px', background: 'rgba(59,130,246,0.1)', border: '1px solid var(--accent-primary)', borderRadius: 8, fontSize: 12, fontWeight: 700, color: 'var(--accent-primary)', display: 'inline-flex', alignItems: 'center', gap: 6 }
};

const EMPTY_FORM = {
    name: '',
    host: '',
    port: '443',
    environment: '', // environment id; '' = the isDefault environment on add, "unchanged" on edit
    certText: '',
    keyText: '',
    keyPassword: '',
    uploadedFileName: '',
    uploadedFileType: '',
    uploadedFileB64: '',
    clearKey: false
};
const MAX_UPLOAD_BYTES = 1024 * 1024;

const SSLManager = () => {
    const { lastEvent } = useSync();
    const { showToast } = useToast();
    const sessionUser = JSON.parse(localStorage.getItem('user') || '{}');
    const role = sessionUser.role || 'Viewer';
    const isSuperAdmin = role === 'SuperAdmin';
    const [records, setRecords] = useState([]);
    const [filter, setFilter] = useState('');
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState(null);
    const [showAddModal, setShowAddModal] = useState(false);
    const [editRecord, setEditRecord] = useState(null); // record being edited (null = add mode)
    const [deleteConfirmRecord, setDeleteConfirmRecord] = useState(null); // stores { id, host, name, hasKey }
    const [environments, setEnvironments] = useState([]);
    const [selectedEnvFilter, setSelectedEnvFilter] = useState('All Environments');
    const [thresholdDays, setThresholdDays] = useState(30);
    const [scanRunning, setScanRunning] = useState(false);

    // Add / edit form state (secrets are never prefilled)
    const [form, setForm] = useState(EMPTY_FORM);

    // Decrypted cert/key viewer states
    const [viewedKey, setViewedKey] = useState(null);
    const [showKeyModal, setShowKeyModal] = useState(false);

    const fetchRecords = useCallback(async () => {
        try {
            const res = await api.get('/ssl/list');
            setRecords(res.data || []);
            const envRes = await api.get('/environments');
            setEnvironments(normalizeEnvs(envRes.data));
        } catch (err) {
            console.error('Failed to load certificates:', err);
        }
    }, []);

    useEffect(() => {
        Promise.resolve().then(fetchRecords); // async: no synchronous setState inside the effect
        api.get('/ssl/settings').then(res => {
            const t = Number(res.data && res.data.thresholdDays);
            if (Number.isFinite(t)) setThresholdDays(t);
        }).catch(() => {});
        // a scan started elsewhere (other user / scheduler) is still running: follow it
        api.get('/ssl/scan-status').then(res => { if (res.data && res.data.running) setScanRunning(true); }).catch(() => {});
    }, [fetchRecords]);

    useEffect(() => {
        if (!lastEvent) return;
        if (lastEvent.type === 'SSL_EXPIRING_WARNING') {
            showToast(`SSL Expiry Warning: ${lastEvent.payload?.warningsCount} certificates are expiring soon`, 'warning');
            Promise.resolve().then(fetchRecords);
        }
    }, [lastEvent, showToast, fetchRecords]);

    // Background scan: poll /scan-status every 2 s while it runs, then reload the list
    useEffect(() => {
        if (!scanRunning) return undefined;
        let cancelled = false;
        let timer = null;
        const tick = async () => {
            try {
                const res = await api.get('/ssl/scan-status');
                if (cancelled) return;
                if (res.data && res.data.running) {
                    timer = setTimeout(tick, 2000);
                    return;
                }
                setScanRunning(false);
                const lr = res.data && res.data.lastResult;
                if (lr && lr.error) {
                    setStatus({ type: 'error', msg: `掃描失敗：${lr.error}` });
                } else {
                    const extra = lr && lr.notChecked ? `，${lr.notChecked} 筆逾時未檢查` : '';
                    setStatus({ type: 'success', msg: lr ? `掃描完成：檢查 ${lr.checked} 筆，失敗 ${lr.failed} 筆${extra}` : '掃描完成' });
                }
                fetchRecords();
                setTimeout(() => setStatus(null), 5000);
            } catch (err) {
                if (cancelled) return;
                setScanRunning(false);
                setStatus({ type: 'error', msg: err?.response?.data?.error || err.message });
                setTimeout(() => setStatus(null), 5000);
            }
        };
        timer = setTimeout(tick, 2000);
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
    }, [scanRunning, fetchRecords]);

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > MAX_UPLOAD_BYTES) {
            showToast('憑證檔過大（上限 1 MB）', 'warning');
            e.target.value = '';
            return;
        }

        const ext = file.name.split('.').pop().toLowerCase();
        // PEM / CRT / CER / DER: the server decides PEM vs DER by content
        let type = 'PEM';
        if (ext === 'der') type = 'DER';
        else if (['pfx', 'p12'].includes(ext)) type = 'PFX';

        const reader = new FileReader();
        reader.onload = (event) => {
            const result = event.target.result;
            let base64 = '';
            if (result.includes(',')) {
                base64 = result.split(',')[1];
            } else {
                base64 = btoa(result);
            }

            setForm(prev => {
                const newForm = {
                    ...prev,
                    uploadedFileName: file.name,
                    uploadedFileType: type,
                    uploadedFileB64: base64
                };
                if (!prev.name) {
                    newForm.name = file.name.split('.')[0];
                }
                return newForm;
            });
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    };

    const openAdd = () => {
        setEditRecord(null);
        setForm(EMPTY_FORM);
        setShowAddModal(true);
    };

    const openEdit = (r) => {
        setEditRecord(r);
        setForm({
            ...EMPTY_FORM,
            name: r.name || '',
            host: r.fileOnly || r.host === 'File Backup Only' ? '' : (r.host || ''),
            port: String(r.port || 443),
            environment: '', // '' = unchanged
            certText: r.certText || ''
        });
        setShowAddModal(true);
    };

    const closeModal = () => {
        setShowAddModal(false);
        setEditRecord(null);
        setForm(EMPTY_FORM);
    };

    const editHasStoredCert = !!(editRecord && (editRecord.hasFile || editRecord.hasCertText));

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!form.host && !form.uploadedFileB64 && !form.certText && !editHasStoredCert) {
            showToast('Please configure either a Host monitor endpoint or upload a certificate file.', 'warning');
            return;
        }

        setLoading(true);
        setStatus({ type: 'info', msg: 'Processing and saving record...' });

        try {
            if (editRecord) {
                const payload = {
                    name: form.name,
                    host: form.host,
                    port: form.port,
                    environment: form.environment,
                    certText: form.certText,
                    keyText: form.keyText,
                    keyPassword: form.keyPassword,
                    clearKey: !!form.clearKey
                };
                if (form.uploadedFileB64) {
                    payload.uploadedFileB64 = form.uploadedFileB64;
                    payload.uploadedFileType = form.uploadedFileType;
                    payload.uploadedFileName = form.uploadedFileName;
                }
                await api.put(`/ssl/${encodeURIComponent(editRecord.id)}`, payload);
                setStatus({ type: 'success', msg: `已更新 ${form.name || editRecord.name}` });
            } else {
                const { clearKey: _unused, ...payload } = form;
                await api.post('/ssl/add', payload);
                setStatus({ type: 'success', msg: `Successfully added ${form.name || 'monitor'}` });
            }
            closeModal();
            fetchRecords();
        } catch (err) {
            setStatus({ type: 'error', msg: err?.response?.data?.error || err.message });
        } finally {
            setLoading(false);
            setTimeout(() => setStatus(null), 5000);
        }
    };

    const handleCheckAll = async () => {
        try {
            await api.post('/ssl/check-all');
            setStatus({ type: 'info', msg: '已在背景開始掃描所有憑證…' });
            setScanRunning(true);
        } catch (err) {
            if (err?.response?.status === 409) {
                setStatus({ type: 'info', msg: '已有掃描正在執行，完成後會自動更新列表。' });
                setScanRunning(true);
            } else {
                setStatus({ type: 'error', msg: err?.response?.data?.error || err.message });
                setTimeout(() => setStatus(null), 5000);
            }
        }
    };

    const handleDeleteClick = (record) => {
        setDeleteConfirmRecord(record);
    };

    const handleConfirmDelete = async () => {
        if (!deleteConfirmRecord) return;
        const { id, host, name } = deleteConfirmRecord;

        try {
            await api.delete(`/ssl/delete/${encodeURIComponent(id)}`);
            setStatus({ type: 'success', msg: `Deleted certificate record for ${host !== 'File Backup Only' ? host : name}` });
            fetchRecords();
        } catch (err) {
            setStatus({ type: 'error', msg: err?.response?.data?.error || err.message });
        } finally {
            setDeleteConfirmRecord(null);
            setTimeout(() => setStatus(null), 5000);
        }
    };

    const handleViewKey = async (id, host) => {
        try {
            const res = await api.get(`/ssl/view-key/${encodeURIComponent(id)}`);
            setViewedKey({
                host,
                keyText: res.data.keyText || 'No Private Key Stored',
                keyPassword: res.data.keyPassword || ''
            });
            setShowKeyModal(true);
        } catch (err) {
            setStatus({ type: 'error', msg: 'Failed to decrypt key: ' + (err?.response?.data?.error || err.message) });
            setTimeout(() => setStatus(null), 5000);
        }
    };

    const filtered = records.filter(r => {
        if (selectedEnvFilter !== 'All Environments' && r.environment !== selectedEnvFilter) return false;
        const query = `${r.name} ${r.host} ${r.subject} ${r.issuer} ${r.uploadedFileName || ''}`.toLowerCase();
        return query.includes(filter.toLowerCase());
    });

    const activeCount = records.filter(r => r.status === 'active').length;
    const warningCount = records.filter(r => r.status === 'warning').length;
    const expiredCount = records.filter(r => r.status === 'expired').length;
    const errorCount = records.filter(r => r.status === 'error').length;

    return (
        <div style={S.page}>
            {/* Header */}
            <div style={S.header}>
                <div>
                    <h1 className="page-title">SSL/TLS Certificates</h1>
                    <p className="page-subtitle">Automatic certificate expiration monitoring & backup vault</p>
                </div>
                <div style={S.headerBtns}>
                    {role !== 'Viewer' && (
                        <>
                            <button style={S.btnP} onClick={openAdd}>+ Add Certificate</button>
                            <button style={S.btnO} onClick={handleCheckAll} disabled={scanRunning}>
                                {scanRunning ? '⚡ Scanning...' : '🔄 Scan All Now'}
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Top Cards */}
            <div style={S.topRow}>
                <div style={S.card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <span style={{ fontSize: 13, fontWeight: 900, letterSpacing: '0.06em' }}>DOMAINS HEALTH</span>
                        <div style={{ display: 'flex', gap: 18 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}><span style={{ ...S.dot, background: 'var(--success)' }} /> Active ({activeCount})</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}><span style={{ ...S.dot, background: 'var(--warning)' }} /> Expiring soon ({warningCount})</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}><span style={{ ...S.dot, background: '#991b1b' }} /> Expired ({expiredCount})</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}><span style={{ ...S.dot, background: 'var(--danger)' }} /> Probe error ({errorCount})</span>
                        </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
                        {[`Safe (> ${thresholdDays} days)`, `Expiring (≤ ${thresholdDays} days)`, 'Expired', 'Unreachable / No data'].map((lbl, i) => {
                            const cnt = [activeCount, warningCount, expiredCount, errorCount][i];
                            const color = ['var(--success)', 'var(--warning)', '#991b1b', 'var(--danger)'][i];
                            return (
                                <div key={lbl} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16 }}>
                                    <span style={{ fontSize: 12, fontWeight: 800 }}>⚡ {lbl}</span>
                                    <div style={{ fontSize: 24, fontWeight: 900, marginTop: 6, color }}>{cnt}</div>
                                </div>
                            );
                        })}
                    </div>
                </div>
                <div style={S.metCol}>
                    <div style={S.metCard}>
                        <span style={S.metLabel}>TOTAL CERTIFICATES</span>
                        <div style={S.metVal}>{records.length}</div>
                    </div>
                    <div style={S.metCard}>
                        <span style={S.metLabel}>ALERT SYSTEM</span>
                        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--warning)' }}>🔔 Active (Telegram & SMTP)</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>提醒門檻 {thresholdDays} 天（僅在狀態變化時通知）</div>
                    </div>
                </div>
            </div>

            {/* List Table */}
            <div style={S.tblWrap}>
                <div style={S.tblHead}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <h3 style={S.tblTitle}>Certificate List</h3>
                        <select 
                            value={selectedEnvFilter}
                            onChange={e => setSelectedEnvFilter(e.target.value)}
                            style={{
                                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', 
                                color: 'var(--text-primary)', borderRadius: 6, padding: '4px 10px', fontSize: 12, outline: 'none',
                                fontFamily: 'inherit', fontWeight: 600
                            }}
                        >
                            <option value="All Environments">All Environments</option>
                            {environments.map(env => (
                                <option key={env.id} value={env.name}>{env.name}</option>
                            ))}
                        </select>
                        <div style={S.sBox}>
                            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>▽</span>
                            <input type="text" placeholder="Search by domain, file..." style={S.sInput} value={filter} onChange={e => setFilter(e.target.value)} />
                        </div>
                    </div>
                </div>
                <table style={S.tbl}>
                    <thead>
                        <tr>
                            <th style={S.th}>FRIENDLY NAME</th>
                            <th style={S.th}>HOST / ENDPOINT</th>
                            <th style={S.th}>ISSUER</th>
                            <th style={S.th}>EXPIRATION DATE</th>
                            <th style={S.th}>DAYS REMAINING</th>
                            <th style={S.th}>ARCHIVE VAULT</th>
                            <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.length === 0 && (
                            <tr>
                                <td colSpan="7" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                    No SSL certificates monitored. Add one to start tracking.
                                </td>
                            </tr>
                        )}
                        {filtered.map((r) => {
                            // status is computed by the server at read time: active / warning / expired / error
                            const isWarning = r.status === 'warning';
                            const isExpired = r.status === 'expired';
                            const isError = r.status === 'error';
                            const isFileOnly = r.fileOnly || r.host === 'File Backup Only';
                            const probeFailed = !isError && !isFileOnly && !!r.error;

                            let statusBadge = (
                                <span style={{ ...S.badge, background: 'rgba(16,185,129,0.1)', color: 'var(--success)', border: '1px solid var(--success)', fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>
                                    Active
                                </span>
                            );
                            let daysColor = 'var(--text-primary)';

                            if (isWarning) {
                                statusBadge = (
                                    <span style={{ ...S.badge, background: 'rgba(245,158,11,0.1)', color: 'var(--warning)', border: '1px solid var(--warning)', fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>
                                        Expiring
                                    </span>
                                );
                                daysColor = 'var(--warning)';
                            } else if (isExpired) {
                                statusBadge = (
                                    <span style={{ ...S.badge, background: '#991b1b', color: '#fff', border: '1px solid #991b1b', fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>
                                        Expired
                                    </span>
                                );
                                daysColor = '#991b1b';
                            } else if (isError) {
                                statusBadge = (
                                    <span title={r.error || ''} style={{ ...S.badge, background: 'rgba(239,68,68,0.1)', color: 'var(--danger)', border: '1px solid var(--danger)', fontSize: 10, padding: '2px 6px', borderRadius: 4 }}>
                                        Error
                                    </span>
                                );
                                daysColor = 'var(--danger)';
                            }

                            const maxDays = 90;
                            const daysLeft = r.daysRemaining === -999 ? 0 : r.daysRemaining;
                            const percent = daysLeft > 0 ? Math.min(100, (daysLeft / maxDays) * 100) : 0;

                            let barColor = 'var(--success)';
                            if (isWarning) {
                                barColor = 'var(--warning)';
                            } else if (isExpired) {
                                barColor = '#991b1b';
                            } else if (isError) {
                                barColor = 'var(--danger)';
                            }

                            let expiryLabel = '';
                            if (r.daysRemaining === -999 || isError) {
                                expiryLabel = 'N/A';
                            } else if (isExpired) {
                                expiryLabel = `Expired ${Math.abs(r.daysRemaining)}d ago`;
                            } else {
                                expiryLabel = `${r.daysRemaining} days left`;
                            }

                            return (
                                <tr key={r.id} style={S.tr}>
                                    <td style={{ ...S.td, fontWeight: 800 }}>
                                        {r.name}
                                        <span style={{ marginLeft: 6, padding: '2px 6px', background: 'var(--bg-tertiary)', borderRadius: 4, fontSize: 10, color: r.envIsProduction ? '#ef4444' : 'var(--accent-primary)', fontWeight: 600 }} title={r.envUnmapped ? `Stored value "${r.envUnmapped}" is not in Settings -> Environments` : ''}>{r.environment || 'Unassigned'}</span>
                                        {r.uploadedFileName && (
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, marginTop: 4 }}>
                                                📄 {r.uploadedFileName} ({r.uploadedFileType})
                                            </div>
                                        )}
                                    </td>
                                    <td style={{ ...S.td, fontFamily: 'monospace', color: 'var(--accent-primary)' }}>
                                        {!isFileOnly ? `${r.host}:${r.port}` : <span style={{ color: 'var(--text-muted)' }}>Backup File Only</span>}
                                        {r.trusted === false && (
                                            <span title={r.trustError || '憑證不受信任'} style={{ ...S.badge, marginLeft: 6, background: 'rgba(239,68,68,0.1)', color: 'var(--danger)', border: '1px solid var(--danger)', fontSize: 10, padding: '1px 6px', borderRadius: 4, fontFamily: 'inherit', cursor: 'help' }}>
                                                不受信任
                                            </span>
                                        )}
                                        {probeFailed && (
                                            <div title={r.error} style={{ fontSize: 10, color: 'var(--danger)', fontFamily: 'inherit', marginTop: 4, cursor: 'help' }}>
                                                ⚠ 最近一次探測失敗（顯示先前資料）
                                            </div>
                                        )}
                                    </td>
                                    <td style={S.td}>{r.issuer}</td>
                                    <td style={S.td}>{r.validTo}</td>
                                    <td style={S.td}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 140 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span style={{ fontWeight: 900, color: daysColor, fontSize: 13 }}>{expiryLabel}</span>
                                                {statusBadge}
                                            </div>
                                            {r.daysRemaining !== -999 && !isError && (
                                                <div style={{ width: '100%', background: 'rgba(255,255,255,0.06)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                                                    <div style={{ height: '100%', background: barColor, width: `${percent}%`, transition: 'width 0.4s ease' }} />
                                                </div>
                                            )}
                                        </div>
                                    </td>
                                    <td style={S.td}>
                                        {r.hasCertStored ? (
                                            <span style={{ fontSize: 18 }} title="Certificate File Archived">📦 File Stored</span>
                                        ) : (
                                            <span style={{ fontSize: 18, opacity: 0.2 }} title="Domain Probed Only">🌐 Probed</span>
                                        )}
                                        {r.hasKey && isSuperAdmin && (
                                            <button
                                                style={{ ...S.btnO, padding: '4px 8px', fontSize: 10, marginLeft: 8, display: 'inline-flex' }}
                                                onClick={() => handleViewKey(r.id, isFileOnly ? r.name : r.host)}
                                                title="檢視私鑰（將記錄於稽核日誌）"
                                            >
                                                🔑 Decrypt Key
                                            </button>
                                        )}
                                    </td>
                                    <td style={{ ...S.td, textAlign: 'right' }}>
                                        {role !== 'Viewer' ? (
                                            <div style={{ display: 'inline-flex', gap: 8 }}>
                                                <button
                                                    style={{ ...S.btnO, padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}
                                                    onClick={() => openEdit(r)}
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    style={{ ...S.btnO, background: 'var(--danger)', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: 'pointer' }}
                                                    onClick={() => handleDeleteClick(r)}
                                                >
                                                    Delete
                                                </button>
                                            </div>
                                        ) : (
                                            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Read Only</span>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Status Toast */}
            {status && (
                <div style={{ position: 'fixed', bottom: 24, right: 24, padding: '14px 24px', borderRadius: 16, fontSize: 13, fontWeight: 700, zIndex: 300, background: status.type === 'error' ? 'var(--danger)' : status.type === 'info' ? 'var(--warning)' : 'var(--success)', color: '#fff', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
                    {status.msg}
                </div>
            )}

            {/* Add Modal */}
            {showAddModal && (
                <div style={S.overlay} onClick={closeModal}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={S.modalH}>
                            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>{editRecord ? `✏️ 編輯憑證監控 - ${editRecord.name}` : '🔑 Add Domain / SSL Certificate'}</h3>
                            <button style={S.closeBtn} onClick={closeModal}>✕</button>
                        </div>
                        <form onSubmit={handleSubmit} style={{ padding: '20px 28px 28px', maxHeight: '80vh', overflowY: 'auto' }}>
                            <div style={S.gridRow}>
                                        <div>
                                            <label style={S.metLabel}>FRIENDLY NAME / LABEL</label>
                                            <input type="text" style={S.input} placeholder="e.g. Mail Server Webmail" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                                        </div>
                                        <div>
                                            <label style={S.metLabel}>ENVIRONMENT</label>
                                            <select style={{...S.input, fontFamily: 'inherit'}} value={form.environment} onChange={e => setForm({ ...form, environment: e.target.value })}>
                                                <option value="">{editRecord ? `不變更（目前：${editRecord.environment || 'Unassigned'}）` : `Default (${(defaultEnv(environments) || {}).name || '-'})`}</option>
                                                {environments.map(env => (<option key={env.id} value={env.id}>{env.name}</option>))}
                                            </select>
                                        </div>
                            </div>

                            <div style={S.gridRow}>
                                <div>
                                    <label style={S.metLabel}>HOST / DOMAIN {!form.uploadedFileB64 && !editHasStoredCert && '*'}</label>
                                    <input type="text" style={S.input} required={!form.uploadedFileB64 && !editHasStoredCert} placeholder="mail.company.com" value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} />
                                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>主機名稱或 IPv4，勿含 https:// 或路徑；留空表示僅保存憑證檔（不探測）</div>
                                </div>
                                <div>
                                    <label style={S.metLabel}>PORT {!form.uploadedFileB64 && !editHasStoredCert && '*'}</label>
                                    <input type="number" min="1" max="65535" style={S.input} required={!form.uploadedFileB64 && !editHasStoredCert} placeholder="443" value={form.port} onChange={e => setForm({ ...form, port: e.target.value })} />
                                </div>
                            </div>

                            {/* File Upload Section */}
                            <div style={{ marginTop: 18, borderTop: '1px solid var(--border-color)', paddingTop: 14 }}>
                                <label style={S.metLabel}>{editRecord && editRecord.hasFile ? 'REPLACE CERTIFICATE FILE（已存憑證檔，留空表示不變）' : 'UPLOAD CERTIFICATE FILE (PEM, DER, PFX/P12)'}</label>
                                <div style={S.fileUploadArea} onClick={() => document.getElementById('certFileSelect').click()}>
                                    <span style={{ fontSize: '24px', display: 'block', marginBottom: '6px' }}>📁</span>
                                    <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                                        Click to Upload Certificate File
                                    </span>
                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 4 }}>
                                        Supports PEM (.pem,.crt,.cer), DER (.der,.cer) and PFX (.pfx,.p12), max 1 MB
                                    </div>
                                    <input 
                                        id="certFileSelect"
                                        type="file" 
                                        style={{ display: 'none' }} 
                                        accept=".pem,.crt,.cer,.der,.pfx,.p12" 
                                        onChange={handleFileChange} 
                                    />
                                </div>
                                {form.uploadedFileName && (
                                    <div style={{ textAlign: 'left', marginTop: 8 }}>
                                        <div style={S.fileInfo}>
                                            📄 {form.uploadedFileName} ({form.uploadedFileType})
                                            <button 
                                                type="button" 
                                                style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontWeight: 900, padding: '0 4px' }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setForm(prev => ({ ...prev, uploadedFileName: '', uploadedFileType: '', uploadedFileB64: '' }));
                                                }}
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                            
                            {!form.uploadedFileB64 && (
                                <div style={{ marginTop: 22, borderTop: '1.5px dashed var(--accent-primary)', paddingTop: 18 }}>
                                    <label style={{ ...S.metLabel, color: 'var(--accent-primary)', fontSize: '11.5px', fontWeight: '900', display: 'flex', alignItems: 'center', gap: '6px', letterSpacing: '0.08em' }}>
                                        <span>📝</span> OR PASTE CERTIFICATE TEXT (.CRT) - OPTIONAL
                                    </label>
                                    <textarea style={S.textarea} rows="3" placeholder="-----BEGIN CERTIFICATE-----&#10;..." value={form.certText} onChange={e => setForm({ ...form, certText: e.target.value })} />
                                </div>
                            )}

                            <div style={S.gridRow}>
                                <div>
                                    <label style={S.metLabel}>PRIVATE KEY (.KEY) - OPTIONAL</label>
                                    <textarea style={S.textarea} rows="3" disabled={!!form.clearKey} placeholder={editRecord && editRecord.hasKey ? '已存私鑰，留空表示不變' : '-----BEGIN PRIVATE KEY-----\n...'} value={form.keyText} onChange={e => setForm({ ...form, keyText: e.target.value })} />
                                </div>
                                <div>
                                    <label style={S.metLabel}>KEY / PFX PASSWORD - OPTIONAL</label>
                                    <input type="password" autoComplete="new-password" style={S.input} disabled={!!form.clearKey} placeholder={editRecord && editRecord.hasKey ? '留空表示不變' : 'Encrypted on submit'} value={form.keyPassword} onChange={e => setForm({ ...form, keyPassword: e.target.value })} />
                                </div>
                            </div>
                            {editRecord && editRecord.hasKey && (
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, fontWeight: 700, color: 'var(--danger)', cursor: 'pointer' }}>
                                    <input type="checkbox" checked={!!form.clearKey} onChange={e => setForm({ ...form, clearKey: e.target.checked, keyText: '', keyPassword: '' })} />
                                    清除已存的私鑰與密碼
                                </label>
                            )}

                            <div style={S.hint}>
                                🔒 <strong>Security Note:</strong> Private key, PFX credentials, and certificate backups are automatically encrypted using highly secure AES-256 standards before transit and storage.
                            </div>

                            <button style={{ ...S.btnP, width: '100%', justifyContent: 'center', marginTop: 20 }} type="submit" disabled={loading}>
                                {loading ? 'Processing and encrypting...' : (editRecord ? '儲存變更' : 'Add Certificate & Monitor')}
                            </button>
                        </form>
                    </div>
                </div>
            )}

            {/* Decrypted Vault Viewer Modal */}
            {showKeyModal && viewedKey && (
                <div style={S.overlay} onClick={() => { setShowKeyModal(false); setViewedKey(null); }}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={S.modalH}>
                            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>🔓 Decrypted Vault Credentials - {viewedKey.host}</h3>
                            <button style={S.closeBtn} onClick={() => { setShowKeyModal(false); setViewedKey(null); }}>✕</button>
                        </div>
                        <div style={{ padding: 28 }}>
                            <div>
                                <label style={S.metLabel}>DECRYPTED PRIVATE KEY</label>
                                <textarea style={{ ...S.textarea, color: 'var(--accent-primary)' }} readOnly rows="10" value={viewedKey.keyText} />
                            </div>
                            {viewedKey.keyPassword && (
                                <div style={{ marginTop: 14 }}>
                                    <label style={S.metLabel}>KEY PASSWORD</label>
                                    <input style={{ ...S.input, color: 'var(--accent-primary)' }} readOnly type="text" value={viewedKey.keyPassword} />
                                </div>
                            )}
                            <button style={{ ...S.btnO, width: '100%', justifyContent: 'center', marginTop: 20 }} onClick={() => { setShowKeyModal(false); setViewedKey(null); }}>
                                Done & Safe Lock
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {/* Custom Delete Confirmation Modal */}
            {deleteConfirmRecord && (
                <div style={S.overlay} onClick={() => setDeleteConfirmRecord(null)}>
                    <div style={{ ...S.modal, maxWidth: 420, padding: 28, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: '3.5rem', marginBottom: '16px' }}>⚠️</div>
                        <h3 style={{ margin: '0 0 12px 0', fontSize: '1.3rem', fontWeight: '900', color: 'var(--text-primary)' }}>Confirm Delete</h3>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.6', margin: '0 0 24px 0' }}>
                            Are you sure you want to delete SSL certificate monitor for <strong>{deleteConfirmRecord.host && deleteConfirmRecord.host !== 'File Backup Only' ? deleteConfirmRecord.host : deleteConfirmRecord.name}</strong>? This action cannot be undone.
                        </p>
                        <p style={{ color: 'var(--danger)', fontSize: '0.85rem', lineHeight: '1.6', margin: '-12px 0 24px 0', fontWeight: 700 }}>
                            {deleteConfirmRecord.hasKey || deleteConfirmRecord.hasFile
                                ? '已儲存的憑證檔與私鑰（含密碼）將一併永久刪除。The stored certificate file and private key are deleted too.'
                                : '此紀錄的所有資料將一併刪除。'}
                        </p>
                        <div style={{ display: 'flex', gap: 12 }}>
                            <button type="button" className="btn btn-secondary" onClick={() => setDeleteConfirmRecord(null)} style={{ flex: 1, padding: '12px', borderRadius: 12, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)', fontWeight: '700', cursor: 'pointer' }}>
                                Cancel
                            </button>
                            <button type="button" className="btn btn-primary" onClick={handleConfirmDelete} style={{ flex: 1, padding: '12px', borderRadius: 12, border: 'none', background: 'var(--danger)', color: 'white', fontWeight: '700', cursor: 'pointer' }}>
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SSLManager;
