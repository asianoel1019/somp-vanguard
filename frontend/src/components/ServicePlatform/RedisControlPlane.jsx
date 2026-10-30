import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';

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
    metUnit: { fontSize: 14, fontWeight: 600, color: 'var(--text-muted)' },
    dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden' },
    tblHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 },
    tblTitle: { fontSize: 16, fontWeight: 900, margin: 0 },
    sBox: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid var(--border-color)', borderRadius: 8 },
    sInput: { border: 'none', background: 'transparent', outline: 'none', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', width: 180 },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)', cursor: 'pointer' },
    tr: { borderBottom: '1px solid var(--border-color)' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13 },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'var(--bg-secondary)', color: 'var(--accent-primary)', border: '1px solid var(--accent-primary)' },
    viewBtn: { padding: '8px 18px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 11, fontWeight: 900, cursor: 'pointer', letterSpacing: '0.04em', boxShadow: '0 4px 12px var(--accent-glow)' },
    delBtn: { padding: '8px 18px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 11, fontWeight: 900, cursor: 'pointer' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 550, boxShadow: '0 30px 60px rgba(0,0,0,0.3)', overflow: 'hidden', backdropFilter: 'blur(16px)' },
    modalH: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px', borderBottom: '1px solid var(--border-color)' },
    closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, fontSize: 20 },
    input: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box' },
    label: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', display: 'block' },
};

const RedisControlPlane = ({ user }) => {
    const sessionUser = JSON.parse(localStorage.getItem('user') || '{}');
    const role = sessionUser.role || 'Viewer';
    const [connections, setConnections] = useState([]);
    const [selectedConnId, setSelectedConnId] = useState(null);
    const [configs, setConfigs] = useState([]);
    const [loading, setLoading] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [formData, setFormData] = useState({ id: '', host: '', ip: '', port: '6379', bu: '', password: '', tls: false });
    const [connSearch, setConnSearch] = useState('');
    const [selectedBu, setSelectedBu] = useState(null);
    const [hoveredBu, setHoveredBu] = useState(null);
    const [connSort, setConnSort] = useState({ key: 'host', dir: 'asc' });
    const [configSearch, setConfigSearch] = useState('');
    const [editingParam, setEditingParam] = useState(null);
    const [editValue, setEditValue] = useState('');
    const fileInputRef = useRef(null);

    const [infoModal, setInfoModal] = useState(null);
    const [confirmModal, setConfirmModal] = useState(null);

    useEffect(() => { fetchConnections(); }, []);

    const handleConfirmAction = () => {
        if (!confirmModal) return;
        const { action, actionParams } = confirmModal;
        if (action === 'delete') executeDeleteConnection(actionParams.id);
        else if (action === 'rewrite') executeConfigRewrite();
        setConfirmModal(null);
    };

    const fetchConnections = async () => { try { const r = await api.get('/redis/connections'); setConnections(r.data); } catch (e) { console.error(e); } };
    const handleSaveConnection = async (e) => { e.preventDefault(); try { if (isEditing) await api.put(`/redis/connections/${formData.id}`, formData); else await api.post('/redis/connections', formData); setShowForm(false); setFormData({ id: '', host: '', ip: '', port: '6379', bu: '', password: '', tls: false }); fetchConnections(); } catch (e) { setInfoModal({ title: 'Error', message: e.response?.data?.error || e.message, type: 'error' }); } };
    const handleDeleteConnection = (id) => { setConfirmModal({ title: '⚠️ Delete Connection', message: 'Delete this connection?', action: 'delete', actionParams: { id } }); };
    const executeDeleteConnection = async (id) => { try { await api.delete(`/redis/connections/${id}`); if (selectedConnId === id) setSelectedConnId(null); fetchConnections(); } catch (e) { setInfoModal({ title: 'Error', message: e.response?.data?.error || e.message, type: 'error' }); } };
    const fetchConfig = async (connId) => { setLoading(true); setSelectedConnId(connId); try { const r = await api.post('/redis/config/get', { connId }); setConfigs(r.data); } catch (e) { setInfoModal({ title: 'Error', message: e.response?.data?.error || e.message, type: 'error' }); setSelectedConnId(null); } finally { setLoading(false); } };
    const handleConfigSet = async (parameter, value) => { try { await api.post('/redis/config/set', { connId: selectedConnId, parameter, value }, { headers: { 'x-user': `${sessionUser.username}@${sessionUser.domain}` } }); setEditingParam(null); fetchConfig(selectedConnId); } catch (e) { setInfoModal({ title: 'Error', message: e.response?.data?.error || e.message, type: 'error' }); } };
    const handleConfigRewrite = () => { setConfirmModal({ title: '⚠️ CONFIG REWRITE', message: 'CONFIG REWRITE will overwrite redis.conf. Proceed?', action: 'rewrite' }); };
    const executeConfigRewrite = async () => { setLoading(true); try { const r = await api.post('/redis/config/rewrite', { connId: selectedConnId }, { headers: { 'x-user': `${sessionUser.username}@${sessionUser.domain}` } }); setInfoModal({ title: 'Success', message: 'Backup: ' + r.data.backup, type: 'success' }); } catch (e) { setInfoModal({ title: 'Error', message: e.response?.data?.error || e.message, type: 'error' }); } finally { setLoading(false); } };
    const handleExport = async () => { try { const r = await api.get('/redis/export'); const a = document.createElement('a'); a.href = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(r.data, null, 2)); a.download = "redis_connections_export.json"; a.click(); } catch (e) { setInfoModal({ title: 'Error', message: e.response?.data?.error || e.message, type: 'error' }); } };
    const handleImport = (e) => { const f = e.target.files[0]; if (!f) return; const reader = new FileReader(); reader.onload = async (ev) => { try { const d = JSON.parse(ev.target.result); if (!Array.isArray(d)) throw new Error('Invalid format'); for (const c of d) await api.post('/redis/connections', { host: c.host, ip: c.ip, port: c.port, bu: c.bu, password: c.password || '', tls: c.tls }); fetchConnections(); setInfoModal({ title: 'Success', message: 'Import successful!', type: 'success' }); } catch (e) { setInfoModal({ title: 'Error', message: e.response?.data?.error || e.message, type: 'error' }); } }; reader.readAsText(f); e.target.value = ''; };

    const sortedConns = [...connections]
        .sort((a, b) => {
            const va = (a[connSort.key] || '').toString().toLowerCase();
            const vb = (b[connSort.key] || '').toString().toLowerCase();
            if (va < vb) return connSort.dir === 'asc' ? -1 : 1;
            if (va > vb) return connSort.dir === 'asc' ? 1 : -1;
            return 0;
        })
        .filter(c => {
            if (selectedBu) {
                const itemBu = c.bu || 'Unassigned';
                if (itemBu !== selectedBu) return false;
            }
            return `${c.host} ${c.ip} ${c.bu}`.toLowerCase().includes(connSearch.toLowerCase());
        });
    const filteredConfigs = configs.filter(c => c.parameter.toLowerCase().includes(configSearch.toLowerCase()));
    const requestSort = (key) => { setConnSort(prev => ({ key, dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc' })); };
    const sortArrow = (key) => connSort.key === key ? (connSort.dir === 'asc' ? ' ▲' : ' ▼') : '';

    const buGroups = {};
    connections.forEach(c => { const bu = c.bu || 'Unassigned'; buGroups[bu] = (buGroups[bu] || 0) + 1; });

    return (
        <div style={S.page}>
            {/* Header */}
            <div style={S.header}>
                <div><h1 className="page-title">Redis Control Plane</h1><p className="page-subtitle">Manage connections and runtime configurations</p></div>
                <div style={S.headerBtns}>
                    {role !== 'Viewer' && <button style={S.btnP} onClick={() => { setIsEditing(false); setFormData({ id: '', host: '', ip: '', port: '6379', bu: '', password: '', tls: false }); setShowForm(true); }}>+ Add Connection</button>}
                    <button style={S.btnO} onClick={handleExport}>📤 Export</button>
                    {role !== 'Viewer' && <button style={S.btnO} onClick={() => fileInputRef.current.click()}>📥 Import</button>}
                    <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleImport} accept=".json" />
                </div>
            </div>

            {/* Top Stats */}
            <div style={S.topRow}>
                <div style={S.card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <span style={{ fontSize: 14, fontWeight: 900, letterSpacing: '0.06em' }}>CONNECTION OVERVIEW</span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
                        {Object.entries(buGroups).map(([bu, cnt]) => (
                            <div 
                                key={bu} 
                                onClick={() => setSelectedBu(selectedBu === bu ? null : bu)}
                                onMouseEnter={() => setHoveredBu(bu)}
                                onMouseLeave={() => setHoveredBu(null)}
                                style={{ 
                                    background: selectedBu === bu ? 'var(--bg-glass)' : (hoveredBu === bu ? 'var(--bg-glass-hover)' : 'var(--bg-primary)'), 
                                    border: selectedBu === bu ? '1.5px solid var(--accent-primary)' : (hoveredBu === bu ? '1.5px solid var(--text-muted)' : '1px solid var(--border-color)'), 
                                    borderRadius: 12, 
                                    padding: 16,
                                    cursor: 'pointer',
                                    boxShadow: selectedBu === bu ? '0 8px 20px var(--accent-glow)' : 'none',
                                    transform: selectedBu === bu || hoveredBu === bu ? 'translateY(-2px)' : 'translateY(0)',
                                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                    <span style={{ fontSize: 14 }}>🔴</span>
                                    <span style={{ fontSize: 13, fontWeight: 800 }}>{bu}</span>
                                </div>
                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{cnt} connection{cnt > 1 ? 's' : ''}</span>
                                <div style={{ height: 5, borderRadius: 10, background: 'var(--border-color)', marginTop: 10, overflow: 'hidden' }}>
                                    <div style={{ height: '100%', borderRadius: 10, background: 'var(--accent-primary)', width: `${connections.length ? (cnt / connections.length) * 100 : 0}%` }} />
                                </div>
                            </div>
                        ))}
                        {Object.keys(buGroups).length === 0 && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>No connections yet</div>}
                    </div>
                </div>
                <div style={S.metCol}>
                    <div style={S.metCard}><span style={S.metLabel}>TOTAL CONNECTIONS</span><div style={S.metVal}>{connections.length}</div></div>
                    <div style={S.metCard}><span style={S.metLabel}>BUSINESS UNITS</span><div style={S.metVal}>{Object.keys(buGroups).length}</div></div>
                </div>
            </div>

            {/* Connection Table */}
            <div style={S.tblWrap}>
                <div style={S.tblHead}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                        <h3 style={S.tblTitle}>Connections</h3>
                        {selectedBu && (
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '4px 12px',
                                borderRadius: 16,
                                fontSize: 11,
                                fontWeight: 800,
                                background: 'var(--bg-secondary)',
                                border: '1px solid var(--accent-primary)',
                                color: 'var(--text-primary)',
                                boxShadow: '0 2px 8px var(--accent-glow)',
                                animation: 'fadeIn 0.2s ease-out'
                            }}>
                                <span>BU: <strong>{selectedBu}</strong></span>
                                <button 
                                    onClick={() => setSelectedBu(null)} 
                                    style={{
                                        background: 'none',
                                        border: 'none',
                                        color: 'var(--text-muted)',
                                        cursor: 'pointer',
                                        fontSize: 12,
                                        fontWeight: 900,
                                        padding: '0 2px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                    }}
                                    title="Clear BU Filter"
                                >
                                    ✕
                                </button>
                            </div>
                        )}
                        <div style={S.sBox}><span style={{ color: 'var(--text-muted)', fontSize: 12 }}>▽</span><input type="text" placeholder="Filter connections..." style={S.sInput} value={connSearch} onChange={e => setConnSearch(e.target.value)} /></div>
                    </div>
                </div>
                <table style={S.tbl}>
                    <thead><tr>
                        <th style={S.th} onClick={() => requestSort('host')}>HOSTNAME{sortArrow('host')}</th>
                        <th style={S.th} onClick={() => requestSort('ip')}>IP{sortArrow('ip')}</th>
                        <th style={S.th} onClick={() => requestSort('port')}>PORT{sortArrow('port')}</th>
                        <th style={S.th} onClick={() => requestSort('bu')}>BU{sortArrow('bu')}</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                    </tr></thead>
                    <tbody>
                        {sortedConns.map(c => (
                            <tr key={c.id} style={{ ...S.tr, cursor: 'pointer' }} onClick={() => fetchConfig(c.id)}>
                                <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 800 }}>{c.host}</td>
                                <td style={{ ...S.td, fontFamily: 'monospace' }}>{c.ip}</td>
                                <td style={{ ...S.td, fontFamily: 'monospace' }}>{c.port}</td>
                                <td style={S.td}><span style={S.badge}>{c.bu || 'N/A'}</span></td>
                                <td style={{ ...S.td, textAlign: 'right' }}>
                                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                        {role !== 'Viewer' ? (
                                            <>
                                                <button style={S.viewBtn} onClick={e => { e.stopPropagation(); setIsEditing(true); setFormData({ ...c }); setShowForm(true); }}>EDIT</button>
                                                <button style={S.delBtn} onClick={e => { e.stopPropagation(); handleDeleteConnection(c.id); }}>DELETE</button>
                                            </>
                                        ) : (
                                            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Read Only</span>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                        {sortedConns.length === 0 && <tr><td colSpan="5" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No connections found.</td></tr>}
                    </tbody>
                </table>
            </div>

            {/* Config Overlay */}
            {selectedConnId && (() => {
                const conn = connections.find(c => c.id === selectedConnId);
                const slaveOf = configs.find(c => c.parameter === 'slaveof')?.value;
                const isMaster = !slaveOf || slaveOf.trim() === '';
                return (
                    <div style={S.overlay} onClick={() => setSelectedConnId(null)}>
                        <div style={{ ...S.modal, maxWidth: 900, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                            <div style={S.modalH}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                                    <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0, fontFamily: 'monospace' }}>📡 {conn?.ip}:{conn?.port}</h3>
                                    {configs.length > 0 && <span style={{ padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 900, background: isMaster ? 'var(--danger)' : 'var(--accent-primary)', color: '#fff' }}>{isMaster ? 'Master' : `Slave of ${slaveOf}`}</span>}
                                    <div style={S.sBox}><input type="text" placeholder="Search parameters..." style={S.sInput} value={configSearch} onChange={e => setConfigSearch(e.target.value)} /></div>
                                    {loading && <span style={{ fontSize: 12, color: 'var(--accent-primary)', fontWeight: 700 }}>Refreshing...</span>}
                                </div>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button style={S.btnO} onClick={() => fetchConfig(selectedConnId)}>🔄 Refresh</button>
                                    {role !== 'Viewer' && <button style={{ ...S.btnP, background: 'var(--danger)' }} onClick={handleConfigRewrite}>💾 REWRITE</button>}
                                    <button style={S.closeBtn} onClick={() => setSelectedConnId(null)}>✕</button>
                                </div>
                            </div>
                            <div style={{ flex: 1, overflowY: 'auto', padding: 0 }}>
                                <table style={S.tbl}>
                                    <thead><tr>
                                        <th style={S.th}>PARAMETER</th>
                                        <th style={{ ...S.th, textAlign: 'right' }}>VALUE</th>
                                        <th style={{ ...S.th, textAlign: 'center', width: 60 }}>STATUS</th>
                                    </tr></thead>
                                    <tbody>
                                        {filteredConfigs.map(c => (
                                            <tr key={c.parameter} style={S.tr}>
                                                <td style={{ ...S.td, fontFamily: 'monospace', fontWeight: 700, fontSize: 12 }}>{c.parameter}</td>
                                                <td style={{ ...S.td, textAlign: 'right' }}>
                                                    {editingParam === c.parameter ? (
                                                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
                                                            <input type="text" style={{ ...S.input, width: 200, marginTop: 0, padding: '8px 12px', textAlign: 'right', fontSize: 12 }} value={editValue} onChange={e => setEditValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleConfigSet(c.parameter, editValue); if (e.key === 'Escape') setEditingParam(null); }} autoFocus />
                                                            <button style={{ ...S.viewBtn, padding: '6px 14px' }} onClick={() => handleConfigSet(c.parameter, editValue)}>Save</button>
                                                            <button style={{ ...S.btnO, padding: '6px 14px', fontSize: 11 }} onClick={() => setEditingParam(null)}>Cancel</button>
                                                        </div>
                                                    ) : (
                                                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, alignItems: 'center' }}>
                                                            <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: 'var(--accent-primary)' }}>{c.value}</span>
                                                            {role !== 'Viewer' && <button style={{ ...S.btnO, padding: '4px 12px', fontSize: 10, opacity: 0.6, borderRadius: 6 }} onClick={() => { setEditingParam(c.parameter); setEditValue(c.value); }}>Edit</button>}
                                                        </div>
                                                    )}
                                                </td>
                                                <td style={{ ...S.td, textAlign: 'center', color: 'var(--success)', fontSize: 14 }}>✅</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* Connection Modal (Add/Edit) */}
            {showForm && (
                <div style={S.overlay} onClick={() => setShowForm(false)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={S.modalH}>
                            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>{isEditing ? '✏️ Edit Connection' : '🔴 New Redis Connection'}</h3>
                            <button style={S.closeBtn} onClick={() => setShowForm(false)}>✕</button>
                        </div>
                        <form onSubmit={handleSaveConnection} style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
                            <div><label style={S.label}>BU (Business Unit)</label><input type="text" style={S.input} value={formData.bu} onChange={e => setFormData({ ...formData, bu: e.target.value })} placeholder="e.g. Finance" /></div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px', gap: 12 }}>
                                <div><label style={S.label}>Hostname</label><input required type="text" style={S.input} value={formData.host} onChange={e => setFormData({ ...formData, host: e.target.value })} placeholder="redis-master" /></div>
                                <div><label style={S.label}>IP Address</label><input required type="text" style={S.input} value={formData.ip} onChange={e => setFormData({ ...formData, ip: e.target.value })} placeholder="10.0.0.1" /></div>
                                <div><label style={S.label}>Port</label><input required type="number" style={S.input} value={formData.port} onChange={e => setFormData({ ...formData, port: e.target.value })} placeholder="6379" /></div>
                            </div>
                            <div>
                                <label style={S.label}>Password {isEditing && <span style={{ fontSize: 10, color: 'var(--warning)', fontWeight: 500 }}>(Leave blank to keep current)</span>}</label>
                                <input type="password" style={S.input} value={formData.password} onChange={e => setFormData({ ...formData, password: e.target.value })} />
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8, cursor: 'pointer', marginTop: 4, width: '100%' }} onClick={() => setFormData({ ...formData, tls: !formData.tls })}>
                                <input type="checkbox" checked={formData.tls} readOnly style={{ margin: 0, accentColor: 'var(--accent-primary)', cursor: 'pointer' }} />
                                <label style={{ fontSize: 12, fontWeight: 700, cursor: 'pointer', margin: 0, textAlign: 'left' }}>Enable TLS Connection</label>
                            </div>
                            <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                                <button type="submit" style={{ ...S.btnP, flex: 1, justifyContent: 'center' }}>{isEditing ? 'Update Connection' : 'Save Connection'}</button>
                                <button type="button" style={{ ...S.btnO, flex: 1, justifyContent: 'center' }} onClick={() => setShowForm(false)}>Cancel</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Custom Info Modal */}
            {infoModal && (
                <div style={S.overlay} onClick={() => setInfoModal(null)}>
                    <div style={{...S.modal, maxWidth: 400}} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: 24 }}>
                            <h2 style={{ fontSize: 18, fontWeight: 900, marginTop: 0, color: infoModal.type === 'success' ? 'var(--success)' : 'var(--danger)' }}>
                                {infoModal.type === 'success' ? '✅ ' : '❌ '} {infoModal.title}
                            </h2>
                            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 20 }}>
                                {infoModal.message}
                            </p>
                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                <button style={{...S.btnO, background: 'var(--bg-secondary)'}} onClick={() => setInfoModal(null)}>Close</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Custom Confirm Modal */}
            {confirmModal && (
                <div style={S.overlay} onClick={() => setConfirmModal(null)}>
                    <div style={{...S.modal, maxWidth: 400}} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: 24 }}>
                            <h2 style={{ fontSize: 18, fontWeight: 900, marginTop: 0, color: 'var(--warning)' }}>
                                {confirmModal.title}
                            </h2>
                            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 24 }}>
                                {confirmModal.message}
                            </p>
                            <div style={{ display: 'flex', gap: 12 }}>
                                <button style={{...S.btnO, flex: 1, justifyContent: 'center'}} onClick={() => setConfirmModal(null)}>Cancel</button>
                                <button style={{...S.btnP, background: 'var(--danger)', flex: 1, justifyContent: 'center'}} onClick={handleConfirmAction}>Confirm</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default RedisControlPlane;
