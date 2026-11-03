import React, { useState, useEffect, useRef } from 'react';
import { useToast } from '../../contexts/ToastContext';
import api from '../../api';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    layout: { display: 'grid', gridTemplateColumns: '250px 1fr', gap: 24, alignItems: 'flex-start' },
    
    // Sidebar
    sidebar: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 16, boxShadow: '0 10px 30px rgba(0,0,0,0.2)', backdropFilter: 'blur(12px)', minHeight: 400 },
    sidebarTitle: { fontSize: 13, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--border-color)' },
    dbItem: { padding: '10px 12px', borderRadius: 8, cursor: 'pointer', transition: 'all 0.2s', marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    dbItemActive: { background: 'var(--accent-primary)', color: '#fff', boxShadow: '0 4px 12px var(--accent-glow)' },
    
    // Main Panel
    mainPanel: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24, boxShadow: '0 10px 30px rgba(0,0,0,0.2)', backdropFilter: 'blur(12px)', minHeight: 400 },
    panelHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid var(--border-color)' },
    
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    
    // Table
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '12px 16px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)' },
    td: { padding: '12px 16px', verticalAlign: 'middle', fontSize: 13 },
    
    badgeFull: { padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 800, background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.3)' },
    badgeInc: { padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 800, background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)' },
    
    btnRestore: { padding: '6px 12px', background: 'transparent', color: 'var(--warning)', border: '1px solid var(--warning)', borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: 'pointer', transition: 'all 0.2s', marginRight: 8 },
    btnDelBackup: { padding: '6px 12px', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: 'pointer', transition: 'all 0.2s' },
    
    // Overlay / Modal
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24, width: 400, boxShadow: '0 20px 40px rgba(0,0,0,0.5)', backdropFilter: 'blur(16px)' },
    modalBtns: { display: 'flex', gap: 12, marginTop: 24 },
    btnDanger: { flex: 1, padding: '10px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 800, cursor: 'pointer' },
    btnCancel: { flex: 1, padding: '10px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, fontWeight: 800, cursor: 'pointer' },

    badgeOk: { padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 800, background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)' },
    badgeRunning: { padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 800, background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)' },
    badgeFailed: { padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 800, background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)' },
    badgeMuted: { padding: '3px 8px', borderRadius: 4, fontSize: 10, fontWeight: 800, background: 'rgba(148, 163, 184, 0.15)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }
};

// While a backup or restore runs on the server, the list refreshes at this interval
const POLL_MS = 3000;

const isBusy = (b) => b.status === 'running' || b.restore?.status === 'running';

const latestCompleted = (list) => list
    .filter(b => b.status === 'completed' && !b.simulated)
    .sort((x, y) => new Date(y.timestamp) - new Date(x.timestamp))[0];

const DbBackup = () => {
    const { showToast } = useToast();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';

    const [databases, setDatabases] = useState([]);
    const [selectedDbId, setSelectedDbId] = useState(null);
    const [backups, setBackups] = useState([]);

    // Map of database ID to relative last backup string
    const [lastBackupMap, setLastBackupMap] = useState({});

    const [isStarting, setIsStarting] = useState(false);

    // Active confirm modals states
    const [showRestoreModal, setShowRestoreModal] = useState(null); // stores backup id
    const [showDeleteModal, setShowDeleteModal] = useState(null);   // stores backup id

    const pollRef = useRef(null);
    const [settings, setSettings] = useState(null);

    const getRelativeTimeString = (date) => {
        const diffMs = Date.now() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        return `${Math.floor(diffHours / 24)}d ago`;
    };

    const lastBackupLabel = (list) => {
        const last = latestCompleted(list);
        return last ? getRelativeTimeString(new Date(last.timestamp)) : 'N/A';
    };

    const loadDatabases = async () => {
        try {
            const res = await api.get('/database/inventory');
            if (res.data.success) {
                const dbs = res.data.databases || [];
                setDatabases(dbs);
                if (dbs.length > 0) setSelectedDbId(dbs[0].id);

                // Fetch the last completed backup time for each database in parallel, updating state once
                try {
                    const allResponses = await Promise.all(
                        dbs.map(db => api.get(`/database/backups/${db.id}`).catch(() => null))
                    );
                    const newLastBackupMap = {};
                    dbs.forEach((db, i) => {
                        const bRes = allResponses[i];
                        newLastBackupMap[db.id] = bRes?.data?.success ? lastBackupLabel(bRes.data.backups || []) : 'N/A';
                    });
                    setLastBackupMap(newLastBackupMap);
                } catch (e) { console.error('Failed fetching backup times:', e); }
            }
        } catch (e) {
            console.error('Failed to load DBs:', e);
        }
    };

    const loadBackups = async (dbId) => {
        try {
            const res = await api.get(`/database/backups/${dbId}`);
            if (res.data.success) {
                const list = res.data.backups || [];
                setBackups(list);
                setLastBackupMap(prev => ({ ...prev, [dbId]: lastBackupLabel(list) }));
            }
        } catch (e) {
            console.error('Failed to load backups:', e);
        }
    };

    useEffect(() => {
        loadDatabases();
        api.get('/database/backup-settings').then(res => setSettings(res.data)).catch(() => setSettings(null));
        return () => clearTimeout(pollRef.current);
    }, []);

    useEffect(() => {
        if (selectedDbId) {
            loadBackups(selectedDbId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedDbId]);

    // Keep refreshing while anything on this database is still running; finished runs report their own outcome
    useEffect(() => {
        clearTimeout(pollRef.current);
        if (selectedDbId && backups.some(isBusy)) {
            pollRef.current = setTimeout(() => loadBackups(selectedDbId), POLL_MS);
        }
        return () => clearTimeout(pollRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [backups, selectedDbId]);

    const handleBackup = async () => {
        if (!selectedDbId) return;
        setIsStarting(true);
        try {
            await api.post('/database/backups/create', { dbId: selectedDbId, type: 'full' });
            showToast('Backup started', 'success');
            await loadBackups(selectedDbId);
        } catch (e) {
            showToast(e.response?.data?.error || 'Backup failed to start', 'error');
            console.error(e);
        } finally {
            setIsStarting(false);
        }
    };

    const handleRestore = async () => {
        if (!showRestoreModal) return;
        try {
            await api.post(`/database/backups/restore/${showRestoreModal}`);
            showToast('Restore started; the result appears in the list when it finishes', 'success');
            setShowRestoreModal(null);
            if (selectedDbId) loadBackups(selectedDbId);
        } catch (e) {
            showToast(e.response?.data?.error || 'Restore failed', 'error');
            console.error(e);
        }
    };

    const handleDeleteBackup = async () => {
        if (!showDeleteModal) return;
        try {
            await api.delete(`/database/backups/${showDeleteModal}`);
            setShowDeleteModal(null);
            if (selectedDbId) loadBackups(selectedDbId);
        } catch (e) {
            showToast(e.response?.data?.error || 'Delete failed', 'error');
            console.error(e);
        }
    };

    const handleDownload = async (b) => {
        try {
            const res = await api.get(`/database/backups/${b.id}/download`, { responseType: 'blob' });
            const url = URL.createObjectURL(res.data);
            const link = document.createElement('a');
            link.href = url;
            link.download = (b.file || b.id).split(/[\\/]/).pop();
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (e) {
            // a failed blob request carries its JSON error as a Blob
            let message = 'Download failed';
            try { message = JSON.parse(await e.response.data.text()).error || message; } catch { /* not JSON */ }
            showToast(message, 'error');
        }
    };

    const statusCell = (b) => {
        if (b.simulated) return <span style={S.badgeMuted} title="舊版排程寫入的模擬紀錄，沒有實際備份檔">SIMULATED</span>;
        if (b.status === 'running') return <span style={S.badgeRunning}>RUNNING</span>;
        if (b.status === 'failed') return <span style={S.badgeFailed} title={b.error || ''}>FAILED</span>;
        return <span style={S.badgeOk}>COMPLETED</span>;
    };

    const restoreNote = (b) => {
        if (!b.restore) return null;
        const color = b.restore.status === 'failed' ? 'var(--danger)' : b.restore.status === 'running' ? 'var(--warning)' : 'var(--success)';
        const label = b.restore.status === 'running' ? '還原中…' : b.restore.status === 'failed' ? `還原失敗：${b.restore.error || ''}` : `已於 ${new Date(b.restore.completedAt).toLocaleString()} 還原`;
        return <div style={{ fontSize: 11, color, marginTop: 4 }}>{label}</div>;
    };

    const runningNow = backups.some(b => b.status === 'running');

    const selectedDb = databases.find(d => d.id === selectedDbId);

    return (
        <div style={S.page} className="animate-fade-in">
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>Backup & Restore</h1>
                    <p style={S.subtitle}>Manage snapshot schedules, point-in-time recoveries, and archives</p>
                    {settings && (
                        <p style={{ ...S.subtitle, marginTop: 6 }}>
                            排程備份：{settings.schedule ? `每天 ${settings.schedule}${settings.lastRunDay ? `（上次 ${settings.lastRunDay}）` : ''}` : '未啟用（DB_BACKUP_SCHEDULE）'}
                            {' · '}保留：{settings.retentionDays ? `${settings.retentionDays} 天（每個資料庫至少保留最新一份）` : '全部保留（DB_BACKUP_RETENTION_DAYS）'}
                        </p>
                    )}
                </div>
            </div>

            <div style={S.layout}>
                {/* DB Selector Sidebar */}
                <div style={S.sidebar}>
                    <h3 style={S.sidebarTitle}>DATABASE CLUSTERS</h3>
                    {databases.map(db => {
                        const isActive = selectedDbId === db.id;
                        return (
                            <div 
                                key={db.id} 
                                style={{ ...S.dbItem, ...(isActive ? S.dbItemActive : { color: 'var(--text-secondary)' }) }}
                                onClick={() => setSelectedDbId(db.id)}
                            >
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    <span style={{ fontSize: 13, fontWeight: 700 }}>{db.name}</span>
                                    <span style={{ fontSize: 10, opacity: 0.8 }}>{db.engine} - {db.environment}</span>
                                    {/* Age indicator */}
                                    <span style={{ fontSize: 9, fontStyle: 'italic', opacity: 0.7, marginTop: 4 }}>
                                        Last: {lastBackupMap[db.id] || 'Loading...'}
                                    </span>
                                </div>
                                <span style={{ fontSize: 16 }}>›</span>
                            </div>
                        );
                    })}
                    {databases.length === 0 && (
                        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No databases available.</div>
                    )}
                </div>

                {/* Main Backup Panel */}
                <div style={S.mainPanel}>
                    {selectedDb ? (
                        <>
                            <div style={S.panelHeader}>
                                <div>
                                    <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0 }}>{selectedDb.name} Backups</h2>
                                    <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 0 0' }}>
                                        {selectedDb.host}:{selectedDb.port} / {selectedDb.database}
                                    </p>
                                </div>
                                {role !== 'Viewer' && (
                                    <div style={{ display: 'flex', gap: 12 }}>
                                        <button style={{ ...S.btnP, background: '#3b82f6', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.4)' }} onClick={handleBackup} disabled={isStarting || runningNow}>
                                            {runningNow ? '⏳ Backup running…' : '+ Full Backup'}
                                        </button>
                                    </div>
                                )}
                            </div>

                            <table style={S.tbl}>
                                <thead>
                                    <tr>
                                        <th style={S.th}>SNAPSHOT ID</th>
                                        <th style={S.th}>TYPE</th>
                                        <th style={S.th}>STATUS</th>
                                        <th style={S.th}>TIMESTAMP</th>
                                        <th style={S.th}>SIZE</th>
                                        <th style={S.th}>DURATION</th>
                                        {role !== 'Viewer' && <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {backups.slice().reverse().map(b => (
                                        <tr key={b.id} style={S.tr}>
                                            <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-secondary)' }}>
                                                {b.id}
                                                {b.status === 'failed' && b.error && (
                                                    <div style={{ fontSize: 11, fontFamily: 'inherit', fontWeight: 400, color: 'var(--danger)', marginTop: 4, maxWidth: 360, whiteSpace: 'normal' }}>{b.error}</div>
                                                )}
                                                {restoreNote(b)}
                                            </td>
                                            <td style={S.td}>
                                                {b.type === 'full' ? <span style={S.badgeFull}>FULL</span> : <span style={S.badgeInc}>INCREMENTAL</span>}
                                            </td>
                                            <td style={S.td}>{statusCell(b)}</td>
                                            <td style={S.td}>{new Date(b.timestamp).toLocaleString()}</td>
                                            <td style={{ ...S.td, fontWeight: 600 }} title={b.engine === 'SQLServer' ? '備份檔位於 SQL Server 主機上' : undefined}>
                                                {b.size || (b.engine === 'SQLServer' && b.status === 'completed' ? 'on SQL Server' : '-')}
                                            </td>
                                            <td style={{ ...S.td, color: 'var(--text-muted)' }}>{b.duration || '-'}</td>
                                            {role !== 'Viewer' && (
                                                <td style={{ ...S.td, textAlign: 'right' }}>
                                                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                                        {role === 'SuperAdmin' && (
                                                            <button
                                                                style={{ ...S.btnRestore, ...(b.restorable && !isBusy(b) ? {} : { opacity: 0.35, cursor: 'not-allowed' }) }}
                                                                disabled={!b.restorable || isBusy(b)}
                                                                title={b.restorable ? undefined : '此紀錄沒有可還原的備份檔'}
                                                                onMouseOver={e => { if (!e.currentTarget.disabled) { e.currentTarget.style.background = 'var(--warning)'; e.currentTarget.style.color = '#000'; } }}
                                                                onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--warning)'; }}
                                                                onClick={() => setShowRestoreModal(b.id)}
                                                            >
                                                                RESTORE
                                                            </button>
                                                        )}
                                                        {role === 'SuperAdmin' && b.restorable && b.engine !== 'SQLServer' && (
                                                            <button style={{ ...S.btnRestore, color: 'var(--accent-primary)', borderColor: 'var(--accent-primary)' }} onClick={() => handleDownload(b)}>
                                                                DOWNLOAD
                                                            </button>
                                                        )}
                                                        {role === 'SuperAdmin' && (
                                                            <button 
                                                                style={S.btnDelBackup}
                                                                onMouseOver={e => { e.currentTarget.style.background = 'var(--danger)'; e.currentTarget.style.color = '#fff'; }}
                                                                onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--danger)'; }}
                                                                onClick={() => setShowDeleteModal(b.id)}
                                                            >
                                                                DELETE
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                            )}
                                        </tr>
                                    ))}
                                    {backups.length === 0 && (
                                        <tr>
                                            <td colSpan={role === 'Viewer' ? 6 : 7} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
                                                No backups found for this database.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </>
                    ) : (
                        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                            Select a database to view backups
                        </div>
                    )}
                </div>
            </div>

            {/* Restore Confirmation Modal */}
            {showRestoreModal && (
                <div style={S.overlay} onClick={() => setShowRestoreModal(null)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <h2 style={{ fontSize: 18, fontWeight: 900, marginTop: 0, color: 'var(--danger)' }}>⚠️ Confirm Restore</h2>
                        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                            Are you sure you want to restore the snapshot <strong>{showRestoreModal}</strong>?
                            <br/><br/>
                            This action will overwrite the current database state and cannot be undone. All active connections will be dropped.
                        </p>
                        <div style={S.modalBtns}>
                            <button style={S.btnCancel} onClick={() => setShowRestoreModal(null)}>Cancel</button>
                            <button style={S.btnDanger} onClick={handleRestore}>Yes, Restore Data</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {showDeleteModal && (
                <div style={S.overlay} onClick={() => setShowDeleteModal(null)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <h2 style={{ fontSize: 18, fontWeight: 900, marginTop: 0, color: 'var(--danger)' }}>⚠️ Delete Snapshot</h2>
                        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                            Are you sure you want to delete the backup snapshot <strong>{showDeleteModal}</strong>?
                            <br/><br/>
                            This will permanently remove the backup file and record. This action cannot be undone.
                        </p>
                        <div style={S.modalBtns}>
                            <button style={S.btnCancel} onClick={() => setShowDeleteModal(null)}>Cancel</button>
                            <button style={S.btnDanger} onClick={handleDeleteBackup}>Yes, Delete Snapshot</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DbBackup;
