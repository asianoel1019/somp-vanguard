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

    // Progress
    progressBarBg: { width: '100%', height: 6, background: 'var(--bg-secondary)', borderRadius: 3, marginTop: 12, overflow: 'hidden' },
    progressBarFill: { height: '100%', background: 'var(--accent-primary)', boxShadow: '0 0 10px var(--accent-glow)' }
};

const DbBackup = () => {
    const { showToast } = useToast();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    
    const [databases, setDatabases] = useState([]);
    const [selectedDbId, setSelectedDbId] = useState(null);
    const [backups, setBackups] = useState([]);
    
    // Map of database ID to relative last backup string
    const [lastBackupMap, setLastBackupMap] = useState({});

    const [isBackingUp, setIsBackingUp] = useState(false);
    const [backupProgress, setBackupProgress] = useState(0);
    
    // Active confirm modals states
    const [showRestoreModal, setShowRestoreModal] = useState(null); // stores backup id
    const [showDeleteModal, setShowDeleteModal] = useState(null);   // stores backup id

    // Store active timer interval references to clear on unmount or DB switch
    const backupIntervalRef = useRef(null);
    const checkNewBackupRef = useRef(null);
    
    // Clear intervals helper
    const clearTimers = () => {
        if (backupIntervalRef.current) clearInterval(backupIntervalRef.current);
        if (checkNewBackupRef.current) clearInterval(checkNewBackupRef.current);
    };

    const loadDatabases = async () => {
        try {
            const res = await api.get('/database/inventory');
            if (res.data.success) {
                const dbs = res.data.databases || [];
                setDatabases(dbs);
                if (dbs.length > 0) setSelectedDbId(dbs[0].id);

                // Fetch relative last backup time stamps for each database in parallel, updating state once
                try {
                    const allResponses = await Promise.all(
                        dbs.map(db => api.get(`/database/backups/${db.id}`).catch(() => null))
                    );
                    const newLastBackupMap = {};
                    dbs.forEach((db, i) => {
                        const bRes = allResponses[i];
                        if (bRes && bRes.data && bRes.data.success && bRes.data.backups?.length > 0) {
                            const sorted = bRes.data.backups.sort((x, y) => new Date(y.timestamp) - new Date(x.timestamp));
                            newLastBackupMap[db.id] = getRelativeTimeString(new Date(sorted[0].timestamp));
                        } else {
                            newLastBackupMap[db.id] = 'N/A';
                        }
                    });
                    setLastBackupMap(newLastBackupMap);
                } catch (e) { console.error('Failed fetching backup times:', e); }
            }
        } catch (e) {
            console.error('Failed to load DBs:', e);
        }
    };

    const getRelativeTimeString = (date) => {
        const diffMs = Date.now() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ago`;
        return `${Math.floor(diffHours / 24)}d ago`;
    };

    const loadBackups = async (dbId) => {
        try {
            const res = await api.get(`/database/backups/${dbId}`);
            if (res.data.success) {
                setBackups(res.data.backups || []);
            }
        } catch (e) {
            console.error('Failed to load backups:', e);
        }
    };

    useEffect(() => {
        loadDatabases();
        return () => {
            clearTimers();
        };
    }, []);

    useEffect(() => {
        clearTimers(); // clear stale polling if DB switches
        if (selectedDbId) {
            loadBackups(selectedDbId);
        }
    }, [selectedDbId]);

    const handleBackup = async (type) => {
        if (!selectedDbId) return;
        setIsBackingUp(true);
        setBackupProgress(0);
        
        try {
            await api.post('/database/backups/create', { dbId: selectedDbId, type });
            
            // Progress loader incrementing every 150ms
            let prog = 0;
            backupIntervalRef.current = setInterval(async () => {
                prog += 5;
                setBackupProgress(prog);
                if (prog >= 100) {
                    clearInterval(backupIntervalRef.current);
                    
                    // Poll backend to confirm the new backup is ready, resolving race condition
                    let attempts = 0;
                    checkNewBackupRef.current = setInterval(async () => {
                        try {
                            const res = await api.get(`/database/backups/${selectedDbId}`);
                            if (res.data.success) {
                                setBackups(res.data.backups || []);
                                if (res.data.backups.length > 0) {
                                    const sorted = res.data.backups.sort((x, y) => new Date(y.timestamp) - new Date(x.timestamp));
                                    setLastBackupMap(prev => ({
                                        ...prev,
                                        [selectedDbId]: getRelativeTimeString(new Date(sorted[0].timestamp))
                                    }));
                                }
                                clearInterval(checkNewBackupRef.current);
                                setIsBackingUp(false);
                            }
                        } catch (err) {
                            console.error(err);
                        }
                        attempts++;
                        if (attempts > 5) {
                            clearInterval(checkNewBackupRef.current);
                            setIsBackingUp(false);
                        }
                    }, 1000);
                }
            }, 150);
            
        } catch (e) {
            showToast('Backup failed to start', "error");
            setIsBackingUp(false);
            console.error(e);
        }
    };

    const handleRestore = async () => {
        if (!showRestoreModal) return;
        try {
            await api.post(`/database/backups/restore/${showRestoreModal}`);
            showToast('Restore initiated successfully', "error");
            setShowRestoreModal(null);
        } catch (e) {
            showToast('Restore failed', "error");
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
            showToast('Delete failed', "error");
            console.error(e);
        }
    };

    const selectedDb = databases.find(d => d.id === selectedDbId);

    return (
        <div style={S.page} className="animate-fade-in">
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>Backup & Restore</h1>
                    <p style={S.subtitle}>Manage snapshot schedules, point-in-time recoveries, and archives</p>
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
                                        <button style={S.btnP} onClick={() => handleBackup('incremental')} disabled={isBackingUp}>
                                            + Incremental Backup
                                        </button>
                                        <button style={{ ...S.btnP, background: '#3b82f6', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.4)' }} onClick={() => handleBackup('full')} disabled={isBackingUp}>
                                            + Full Snapshot
                                        </button>
                                    </div>
                                )}
                            </div>

                            {isBackingUp && (
                                <div style={{ padding: 16, background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: 12, marginBottom: 20 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, color: '#10b981' }}>
                                        <span>Backup in progress...</span>
                                        <span>{backupProgress}%</span>
                                    </div>
                                    <div style={S.progressBarBg}>
                                        <div style={{ ...S.progressBarFill, width: `${backupProgress}%`, transition: 'width 0.2s' }}></div>
                                    </div>
                                </div>
                            )}

                            <table style={S.tbl}>
                                <thead>
                                    <tr>
                                        <th style={S.th}>SNAPSHOT ID</th>
                                        <th style={S.th}>TYPE</th>
                                        <th style={S.th}>TIMESTAMP</th>
                                        <th style={S.th}>SIZE</th>
                                        <th style={S.th}>DURATION</th>
                                        {role !== 'Viewer' && <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {backups.slice().reverse().map(b => (
                                        <tr key={b.id} style={S.tr}>
                                            <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 700, color: 'var(--text-secondary)' }}>{b.id}</td>
                                            <td style={S.td}>
                                                {b.type === 'full' ? <span style={S.badgeFull}>FULL</span> : <span style={S.badgeInc}>INCREMENTAL</span>}
                                            </td>
                                            <td style={S.td}>{new Date(b.timestamp).toLocaleString()}</td>
                                            <td style={{ ...S.td, fontWeight: 600 }}>{b.size}</td>
                                            <td style={{ ...S.td, color: 'var(--text-muted)' }}>{b.duration}</td>
                                            {role !== 'Viewer' && (
                                                <td style={{ ...S.td, textAlign: 'right' }}>
                                                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                                        <button 
                                                            style={S.btnRestore} 
                                                            onMouseOver={e => { e.currentTarget.style.background = 'var(--warning)'; e.currentTarget.style.color = '#000'; }}
                                                            onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--warning)'; }}
                                                            onClick={() => setShowRestoreModal(b.id)}
                                                        >
                                                            RESTORE
                                                        </button>
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
                                            <td colSpan={role === 'Viewer' ? 5 : 6} style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
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
