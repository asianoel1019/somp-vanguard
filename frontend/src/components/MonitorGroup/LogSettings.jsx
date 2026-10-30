import React, { useState, useEffect } from 'react';
import WindowsEvent from './WindowsEvent';
import LinuxLog from './LinuxLog';
import { useToast } from '../../contexts/ToastContext';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%', position: 'relative' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    tabRow: { display: 'flex', gap: 24, borderBottom: '1px solid var(--border-color)', marginBottom: 24 },
    tabActive: { padding: '12px 16px', cursor: 'pointer', borderBottom: '2px solid var(--accent-primary)', color: 'var(--text-primary)', fontWeight: 800, background: 'none', borderTop: 'none', borderLeft: 'none', borderRight: 'none', fontSize: 15 },
    tabInactive: { padding: '12px 16px', cursor: 'pointer', borderBottom: '2px solid transparent', color: 'var(--text-muted)', fontWeight: 500, background: 'none', border: 'none', fontSize: 15 },
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, marginBottom: 28 },
    cardHead: { padding: '16px 24px', borderBottom: '1px solid var(--border-color)', fontSize: 14, fontWeight: 800 },
    cardBody: { padding: '20px 24px' },
    label: { display: 'block', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' },
    input: { width: '100%', padding: '12px 16px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
    btnP: { padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' }
};

export default function LogSettings() {
    const [activeTab, setActiveTab] = useState('windows');
    const { showToast } = useToast();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const isViewer = user?.role === 'Viewer';

    // Log Rotation state
    const [rotationSettings, setRotationSettings] = useState([
        { id: 'windows_events', maxRetentionDays: 30, maxRecords: 200000, enabled: 1 },
        { id: 'linux_logs', maxRetentionDays: 30, maxRecords: 200000, enabled: 1 },
        { id: 'agent_metrics', maxRetentionDays: 7, maxRecords: 1000, enabled: 1 }
    ]);

    // TLS settings state
    const [tlsSettings, setTlsSettings] = useState({ tlsEnabled: false, tlsSkipVerify: true });
    // Active DB engine name ('SQLite', 'PostgreSQL', 'MariaDB', 'MSSQL')
    const [dbEngine, setDbEngine] = useState('SQLite');

    useEffect(() => {
        // Fetch active DB engine
        fetch('/api/health')
            .then(res => res.json())
            .then(data => {
                if (data.database?.engineName) {
                    setDbEngine(data.database.engineName);
                }
            })
            .catch(() => {});

        if (activeTab === 'rotation') {
            // Load rotation
            fetch('/api/monitor/logrotation', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            })
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data) && data.length > 0) {
                    setRotationSettings(data.map(item => ({
                        ...item,
                        enabled: !!item.enabled
                    })));
                }
            })
            .catch(err => console.error('Failed to load log rotation settings:', err));

            // Load TLS settings
            fetch('/api/monitor/tls_settings', {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
            })
            .then(res => res.json())
            .then(data => {
                if (data && typeof data === 'object') {
                    setTlsSettings({
                        tlsEnabled: !!data.tlsEnabled,
                        tlsSkipVerify: !!data.tlsSkipVerify
                    });
                }
            })
            .catch(err => console.error('Failed to load agent TLS settings:', err));
        }
    }, [activeTab]);

    const [isVacuuming, setIsVacuuming] = useState(false);
    const [isRotating, setIsRotating] = useState(false);

    const getTiers = (days) => {
        const total = Math.max(1, Number(days) || 30);
        let hot = 14;
        if (total < 28) {
            hot = Math.max(1, Math.floor(total / 2));
        } else {
            hot = 14;
        }
        const cold = Math.max(0, total - hot);
        return { total, hot, cold };
    };

    const handleRunRotation = () => {
        if (isViewer) {
            showToast('Viewers cannot perform manual rotation', 'error');
            return;
        }
        setIsRotating(true);
        fetch('/api/monitor/logrotation/run', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        })
        .then(res => res.json())
        .then(data => {
            setIsRotating(false);
            if (data.success) {
                showToast('Two-Tier Log Rotation completed! Hot data purged & cold archived.', 'success');
            } else {
                showToast(data.error || 'Failed to run rotation', 'error');
            }
        })
        .catch(err => {
            setIsRotating(false);
            showToast('Failed to run rotation: ' + err.message, 'error');
        });
    };

    const handleVacuumDatabase = () => {
        if (isViewer) {
            showToast('Viewers cannot perform database maintenance', 'error');
            return;
        }
        setIsVacuuming(true);
        fetch('/api/monitor/vacuum', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        })
        .then(res => res.json())
        .then(data => {
            setIsVacuuming(false);
            if (data.success) {
                showToast(data.message || `${dbEngine} optimization completed successfully!`, 'success');
            } else {
                showToast(data.error || 'Failed to compact database', 'error');
            }
        })
        .catch(err => {
            setIsVacuuming(false);
            showToast('Failed to compact database: ' + err.message, 'error');
        });
    };

    const handleSaveRotationAndTls = () => {
        if (isViewer) {
            showToast('Viewers cannot update policies', 'error');
            return;
        }

        // Save rotation
        const saveRotation = fetch('/api/monitor/logrotation', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify(rotationSettings)
        });

        // Save TLS
        const saveTls = fetch('/api/monitor/tls_settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify(tlsSettings)
        });

        Promise.all([saveRotation, saveTls])
        .then(([res1, res2]) => Promise.all([res1.json(), res2.json()]))
        .then(([data1, data2]) => {
            if (data1.success && data2.success) {
                showToast('Log Rotation and TLS policies saved successfully', 'success');
            } else {
                showToast('Failed to save settings', 'error');
            }
        })
        .catch(() => showToast('Failed to save settings', 'error'));
    };

    const updateRotationSetting = (id, field, value) => {
        setRotationSettings(rotationSettings.map(item => {
            if (item.id === id) {
                return { ...item, [field]: value };
            }
            return item;
        }));
    };

    return (
        <div style={S.page}>
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>⚙️ Agent Log Policies</h1>
                    <div style={{ color: 'var(--text-muted)', fontSize: 14, marginTop: 4 }}>Configure Windows & Linux agent log subscription, outputs, and log rotation policies.</div>
                </div>
            </div>

            <div style={S.tabRow}>
                <button 
                    style={activeTab === 'windows' ? S.tabActive : S.tabInactive} 
                    onClick={() => setActiveTab('windows')}
                >
                    Windows Event Policies
                </button>
                <button 
                    style={activeTab === 'linux' ? S.tabActive : S.tabInactive} 
                    onClick={() => setActiveTab('linux')}
                >
                    Linux Log Subscription
                </button>
                <button 
                    style={activeTab === 'rotation' ? S.tabActive : S.tabInactive} 
                    onClick={() => setActiveTab('rotation')}
                >
                    Log Rotation & Security
                </button>
            </div>

            {activeTab === 'windows' && <WindowsEvent configOnly={true} />}
            {activeTab === 'linux' && <LinuxLog />}
            
            {activeTab === 'rotation' && (
                <div>
                    {rotationSettings.map(set => (
                        <div key={set.id} style={S.card}>
                            <div style={{ ...S.cardHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <span style={{ textTransform: 'capitalize' }}>
                                    {set.id === 'agent_metrics' ? 'Host Performance Metrics Retention' : set.id.replace('_', ' ') + ' Rotation Policy'}
                                </span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                    <span style={{ fontSize: 12, fontWeight: 800, color: set.enabled ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                                        {set.enabled ? 'Enabled' : 'Disabled'}
                                    </span>
                                    <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                                        <input 
                                            type="checkbox" 
                                            style={{ opacity: 0, width: 0, height: 0 }} 
                                            checked={set.enabled} 
                                            onChange={e => updateRotationSetting(set.id, 'enabled', e.target.checked)} 
                                            disabled={isViewer} 
                                        />
                                        <span style={{ position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: set.enabled ? 'var(--accent-primary)' : 'var(--border-color)', transition: '.4s', borderRadius: 34 }}>
                                            <span style={{ position: 'absolute', content: '""', height: 16, width: 16, left: 4, bottom: 4, backgroundColor: 'white', transition: '.4s', borderRadius: '50%', transform: set.enabled ? 'translateX(20px)' : 'none' }}></span>
                                        </span>
                                    </label>
                                </div>
                            </div>
                            <div style={{ ...S.cardBody, opacity: set.enabled ? 1 : 0.5, pointerEvents: set.enabled ? 'auto' : 'none' }}>
                                <div style={{ display: 'grid', gridTemplateColumns: set.id === 'agent_metrics' ? '1fr' : '1fr 1fr', gap: 24 }}>
                                    <div>
                                        <label style={S.label}>Total Retention Days (總保存天數)</label>
                                        <input 
                                            type="number" 
                                            style={S.input} 
                                            value={set.maxRetentionDays} 
                                            onChange={e => updateRotationSetting(set.id, 'maxRetentionDays', parseInt(e.target.value) || 0)} 
                                            disabled={isViewer || !set.enabled} 
                                            placeholder="e.g. 30" 
                                        />
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                                            {set.id === 'agent_metrics' 
                                                ? "Deletes host performance metrics (CPU, Memory, Disks, Ping checks, and Process resources) older than this limit. Set to 0 to disable." 
                                                : "The total searchable time span for users & APIs before permanent deletion. Set to 0 to disable."}
                                        </div>

                                        {set.id !== 'agent_metrics' && set.maxRetentionDays > 0 && (() => {
                                            const { hot, cold, total } = getTiers(set.maxRetentionDays);
                                            return (
                                                <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 10, border: '1px solid var(--border-color)', fontSize: 12 }}>
                                                    <div style={{ fontWeight: 800, color: 'var(--text-primary)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                                                        <span>⚡ 兩段式動態分層分佈 (Dynamic Tiering):</span>
                                                    </div>
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
                                                        <span style={{ color: '#fb923c', fontWeight: 800 }}>🔥 熱資料 ({dbEngine === 'SQLite' ? 'SQLite 秒開' : `${dbEngine} 快速查詢`}): {hot} 天</span>
                                                        <span style={{ color: '#38bdf8', fontWeight: 800 }}>🧊 冷資料 (Gzip 壓縮歸檔): {cold} 天</span>
                                                        <span style={{ color: 'var(--text-muted)' }}>(總可查天數: {total} 天)</span>
                                                    </div>
                                                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                                                        {total < 28 
                                                            ? `設定小於 28 天，自動折半 (÷2) 保留 ${hot} 天熱資料，其餘 ${cold} 天移至冷歸檔。` 
                                                            : `設定滿 28 天以上，維持上限 14 天熱資料，其餘 ${cold} 天移至 Gzip 冷歸檔以維持最佳效能。`}
                                                    </div>
                                                </div>
                                            );
                                        })()}
                                    </div>
                                    {set.id !== 'agent_metrics' && (
                                        <div>
                                            <label style={S.label}>Max Records Count (筆數保護上限)</label>
                                            <input 
                                                type="number" 
                                                style={S.input} 
                                                value={set.maxRecords} 
                                                onChange={e => updateRotationSetting(set.id, 'maxRecords', parseInt(e.target.value) || 0)} 
                                                disabled={isViewer || !set.enabled} 
                                                placeholder="e.g. 200000" 
                                            />
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Keeps only this amount of latest logs in the database. Set to 0 to disable.</div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}

                    <div style={S.card}>
                        <div style={S.cardHead}>Global Agent Connection Settings (TLS)</div>
                        <div style={S.cardBody}>
                            <div style={{ color: 'var(--text-secondary)', marginBottom: 20, fontSize: 13 }}>
                                Configure if Scout Agents should enforce secure TLS (HTTPS) check when communicating back to the central Vanguard Backend.
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                                <div>
                                    <label style={S.label}>Enable Agent TLS (HTTPS)</label>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                                        <span style={{ fontSize: 12, fontWeight: 800, color: tlsSettings.tlsEnabled ? 'var(--accent-primary)' : 'var(--text-muted)' }}>
                                            {tlsSettings.tlsEnabled ? 'Enabled' : 'Disabled'}
                                        </span>
                                        <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                                            <input 
                                                type="checkbox" 
                                                style={{ opacity: 0, width: 0, height: 0 }} 
                                                checked={tlsSettings.tlsEnabled} 
                                                onChange={e => setTlsSettings({ ...tlsSettings, tlsEnabled: e.target.checked })} 
                                                disabled={isViewer} 
                                            />
                                            <span style={{ position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: tlsSettings.tlsEnabled ? 'var(--accent-primary)' : 'var(--border-color)', transition: '.4s', borderRadius: 34 }}>
                                                <span style={{ position: 'absolute', content: '""', height: 16, width: 16, left: 4, bottom: 4, backgroundColor: 'white', transition: '.4s', borderRadius: '50%', transform: tlsSettings.tlsEnabled ? 'translateX(20px)' : 'none' }}></span>
                                            </span>
                                        </label>
                                    </div>
                                </div>
                                <div style={{ opacity: tlsSettings.tlsEnabled ? 1 : 0.5, pointerEvents: tlsSettings.tlsEnabled ? 'auto' : 'none' }}>
                                    <label style={S.label}>Skip SSL Certificate Verification (InsecureSkipVerify)</label>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                                        <span style={{ fontSize: 12, fontWeight: 800, color: tlsSettings.tlsSkipVerify ? '#f59e0b' : 'var(--text-muted)' }}>
                                            {tlsSettings.tlsSkipVerify ? 'Yes (Ignore Errors)' : 'No (Strict Check)'}
                                        </span>
                                        <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24 }}>
                                            <input 
                                                type="checkbox" 
                                                style={{ opacity: 0, width: 0, height: 0 }} 
                                                checked={tlsSettings.tlsSkipVerify} 
                                                onChange={e => setTlsSettings({ ...tlsSettings, tlsSkipVerify: e.target.checked })} 
                                                disabled={isViewer || !tlsSettings.tlsEnabled} 
                                            />
                                            <span style={{ position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: tlsSettings.tlsSkipVerify ? '#f59e0b' : 'var(--border-color)', transition: '.4s', borderRadius: 34 }}>
                                                <span style={{ position: 'absolute', content: '""', height: 16, width: 16, left: 4, bottom: 4, backgroundColor: 'white', transition: '.4s', borderRadius: '50%', transform: tlsSettings.tlsSkipVerify ? 'translateX(20px)' : 'none' }}></span>
                                            </span>
                                        </label>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div style={S.card}>
                        <div style={S.cardHead}>Database Maintenance & Storage Optimization ({dbEngine})</div>
                        <div style={S.cardBody}>
                            <div style={{ color: 'var(--text-secondary)', marginBottom: 16, fontSize: 13 }}>
                                {dbEngine === 'SQLite' ? (
                                    <>When historical logs or metrics are rotated and purged, SQLite marks the data pages as free without shrinking the physical <code>.sqlite</code> file. You can manually run two-tier rotation or execute <b>VACUUM</b> to defragment indexes and reclaim unallocated disk space immediately.</>
                                ) : (
                                    <>Historical data is dynamically archived and purged. You can trigger manual two-tier rotation or execute native <b>{dbEngine}</b> maintenance to defragment tables and update query planner statistics.</>
                                )}
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '16px 20px' }}>
                                    <div>
                                        <div style={{ fontWeight: 800, fontSize: 14, color: 'var(--text-primary)', marginBottom: 4 }}>Run Two-Tier Log Rotation Now (立即執行兩段式輪替)</div>
                                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Executes the dynamic split: archives hot data older than the threshold to Gzip <code>.json.gz</code> files and purges expired cold archives.</div>
                                    </div>
                                    {!isViewer && (
                                        <button 
                                            style={{ ...S.btnP, background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)', opacity: isRotating ? 0.7 : 1, cursor: isRotating ? 'not-allowed' : 'pointer', minWidth: 150 }}
                                            onClick={handleRunRotation}
                                            disabled={isRotating}
                                        >
                                            {isRotating ? '🔄 Processing...' : '🔄 Run Rotation Now'}
                                        </button>
                                    )}
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '16px 20px' }}>
                                    <div>
                                        <div style={{ fontWeight: 800, fontSize: 14, color: 'var(--text-primary)', marginBottom: 4 }}>
                                            {dbEngine === 'SQLite' ? 'Compact SQLite Database (VACUUM 釋放磁碟空間)' : `Optimize & Defragment Database (${dbEngine} 維護優化)`}
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                            {dbEngine === 'SQLite' ? 'Shrinks scout.sqlite and frees unallocated disk space back to Windows Server.' : `Executes native ${dbEngine} optimization and recalculates query planner statistics.`}
                                        </div>
                                    </div>
                                    {!isViewer && (
                                        <button 
                                            style={{ ...S.btnP, background: 'linear-gradient(135deg, #10b981, #059669)', opacity: isVacuuming ? 0.7 : 1, cursor: isVacuuming ? 'not-allowed' : 'pointer', minWidth: 150 }}
                                            onClick={handleVacuumDatabase}
                                            disabled={isVacuuming}
                                        >
                                            {isVacuuming ? '⚡ Optimizing...' : (dbEngine === 'SQLite' ? '⚡ Reclaim Space (VACUUM)' : `⚡ Optimize (${dbEngine})`)}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    {!isViewer && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
                            <button style={S.btnP} onClick={handleSaveRotationAndTls}>Save Rotation & Security Policies</button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
