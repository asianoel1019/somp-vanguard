import React, { useState, useEffect } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';

const DataCenters = ({ onSelectDC }) => {
    const { showToast } = useToast();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';

    const [dataCenters, setDataCenters] = useState([]);
    const [loading, setLoading] = useState(true);
    const [dcSortOrder, setDcSortOrder] = useState('asc'); // 'asc' | 'desc'
    
    // Modal states
    const [showDCModal, setShowDCModal] = useState(false);
    const [currentDCForm, setCurrentDCForm] = useState(null);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [deleteConfirmText, setDeleteConfirmText] = useState('');
    const [saving, setSaving] = useState(false);

    // Top-down view states
    const [showTopDownModal, setShowTopDownModal] = useState(false);
    const [selectedDCForTopDown, setSelectedDCForTopDown] = useState(null);
    const [dcRacks, setDcRacks] = useState([]);
    const [loadingRacks, setLoadingRacks] = useState(false);

    useEffect(() => {
        fetchDataCenters();
    }, []);

    const fetchDataCenters = async ({ silent = false } = {}) => {
        if (!silent) setLoading(true);
        try {
            const res = await api.get('/rack/datacenters');
            setDataCenters(res.data || []);
            return true;
        } catch (err) {
            console.error('Failed to load Data Centers:', err);
            return false;
        } finally {
            if (!silent) setLoading(false);
        }
    };

    const openTopDownView = async (dc) => {
        setSelectedDCForTopDown(dc);
        setShowTopDownModal(true);
        setLoadingRacks(true);
        try {
            const res = await api.get(`/rack?dcId=${dc.id}`);
            const racksForDC = res.data || [];
            // Optional: filter just in case, but backend should return correct ones
            setDcRacks(racksForDC.filter(r => !r.isBack));
        } catch (err) {
            console.error('Failed to load racks:', err);
            showToast('Failed to load racks for Top-Down View.', 'error');
        } finally {
            setLoadingRacks(false);
        }
    };

    const openEditDC = (dc) => {
        setCurrentDCForm({ 
            rackOrder: 'asc',
            rowOrder: 'asc',
            uOrder: 'desc',
            ...dc 
        });
        setShowDeleteModal(false);
        setShowDCModal(true);
    };

    const openAddDC = () => {
        // no id: the server assigns one on create
        setCurrentDCForm({
            name: 'New Data Center',
            address: '',
            contact: '',
            contactNumber: '',
            emergencyHotline: '',
            totalRacks: 0,
            powerCapacity: '',
            certifications: '',
            rackOrder: 'asc',   // 'asc': 正序 (Left to Right), 'desc': 反序 (Right to Left)
            rowOrder: 'asc',    // 'asc': 正序 (Row 1 to N), 'desc': 反序 (Row N to 1)
            uOrder: 'desc',     // 'desc': 標準 (42U to 1U), 'asc': 反序 (1U to 42U)
            acl: []
        });
        setShowDeleteModal(false);
        setShowDCModal(true);
    };

    // After any save the list comes from the server, never from local state
    const reloadAfterChange = () => fetchDataCenters({ silent: true }).then(ok => {
        if (!ok) showToast('重新載入 Data Center 清單失敗', 'error');
    });

    const isExistingDC = (form) => !!(form && form.id && dataCenters.some(dc => dc.id === form.id));

    const saveDCInfo = async (e) => {
        e.preventDefault();
        if (saving) return;
        // id goes in the URL; usedRacks is computed by the server on read and never saved
        const payload = { ...currentDCForm };
        delete payload.id;
        delete payload.usedRacks;
        setSaving(true);
        try {
            if (isExistingDC(currentDCForm)) {
                await api.put(`/rack/datacenters/${encodeURIComponent(currentDCForm.id)}`, payload);
            } else {
                await api.post('/rack/datacenters/item', payload);
            }
            setShowDCModal(false);
            showToast('Data Center saved successfully', 'success');
        } catch (err) {
            console.error('Failed to save DC:', err);
            showToast(`Failed to save Data Center: ${err.response?.data?.error || err.message}`, 'error');
        } finally {
            setSaving(false);
            reloadAfterChange();
        }
    };

    const deleteDC = async () => {
        if (saving || deleteConfirmText !== currentDCForm.name) return;
        setSaving(true);
        try {
            await api.delete(`/rack/datacenters/${encodeURIComponent(currentDCForm.id)}`, { data: { confirmName: deleteConfirmText } });
            setShowDeleteModal(false);
            setShowDCModal(false);
            showToast('Data Center deleted successfully', 'success');
        } catch (err) {
            console.error('Failed to delete DC:', err);
            showToast(`Failed to delete Data Center: ${err.response?.data?.error || err.message}`, 'error');
        } finally {
            setSaving(false);
            reloadAfterChange();
        }
    };

    const updateACL = (idx, field, val) => {
        const newACL = [...(currentDCForm.acl || [])];
        if (!newACL[idx]) newACL[idx] = { name: '', phone: '' };
        newACL[idx][field] = val;
        setCurrentDCForm({ ...currentDCForm, acl: newACL });
    };

    const addACLRow = () => {
        setCurrentDCForm({ ...currentDCForm, acl: [...(currentDCForm.acl || []), { name: '', phone: '' }] });
    };

    const removeACLRow = (idx) => {
        setCurrentDCForm({ ...currentDCForm, acl: currentDCForm.acl.filter((_, i) => i !== idx) });
    };

    if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading Data Centers...</div>;

    const sortedDataCenters = [...dataCenters].sort((a, b) => {
        const cmp = (a.name || '').localeCompare(b.name || '');
        return dcSortOrder === 'asc' ? cmp : -cmp;
    });

    return (
        <div style={{ height: '100%', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <h1 className="page-title" style={{ margin: 0 }}>Managed Data Centers</h1>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button 
                        className="btn btn-outline" 
                        onClick={() => setDcSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, background: 'var(--bg-glass)', border: '1px solid var(--border-color)' }}
                        title="切換 Data Center 正序 / 反序排列"
                    >
                        <span>{dcSortOrder === 'asc' ? '⬇️ 順序: 正序 (A→Z)' : '⬆️ 順序: 反序 (Z→A)'}</span>
                    </button>
                    {role !== 'Viewer' && (
                        <button className="btn btn-primary" onClick={openAddDC} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>➕</span> Add Data Center
                        </button>
                    )}
                </div>
            </div>

            {sortedDataCenters.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-glass)', borderRadius: 12, border: '1px dashed var(--border-color)' }}>
                    No Data Centers defined. Click "Add Data Center" to create one.
                </div>
            ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 20 }}>
                    {sortedDataCenters.map(dc => (
                        <div key={dc.id} style={{ background: 'var(--bg-glass)', borderRadius: 12, border: '1px solid var(--border-color)', padding: 20, display: 'flex', flexDirection: 'column' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                                <h3 
                                    style={{ margin: 0, fontSize: 16, color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                                    onClick={() => openTopDownView(dc)}
                                    title="Click to view Floor Plan"
                                >
                                    <span>🏢</span> {dc.name}
                                </h3>
                                {role !== 'Viewer' && (
                                    <button 
                                        onClick={() => openEditDC(dc)}
                                        style={{ background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', borderRadius: 6, padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
                                    >
                                        Edit
                                    </button>
                                )}
                            </div>

                            {/* Layout Orientation Badges */}
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                                {dc.rackOrder === 'desc' && (
                                    <span style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', borderRadius: 12, border: '1px solid rgba(245, 158, 11, 0.3)', fontWeight: 800 }}>
                                        🔀 機櫃反序 (R→L)
                                    </span>
                                )}
                                {dc.rowOrder === 'desc' && (
                                    <span style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', borderRadius: 12, border: '1px solid rgba(245, 158, 11, 0.3)', fontWeight: 800 }}>
                                        ↕️ 通道反序 (N→1)
                                    </span>
                                )}
                                {dc.uOrder === 'asc' && (
                                    <span style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(168, 85, 247, 0.15)', color: '#a855f7', borderRadius: 12, border: '1px solid rgba(168, 85, 247, 0.3)', fontWeight: 800 }}>
                                        🔢 U數反序 (1U→42U)
                                    </span>
                                )}
                            </div>

                            {/* Certifications Tags */}
                            {dc.certifications && (
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                                    {dc.certifications.split(',').map(cert => cert.trim()).filter(Boolean).map((cert, idx) => (
                                        <span key={idx} style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', padding: '2px 8px', borderRadius: 12, fontSize: 10, fontWeight: 700, border: '1px solid rgba(59, 130, 246, 0.3)' }}>
                                            {cert}
                                        </span>
                                    ))}
                                </div>
                            )}

                            {/* Capacity Tracking */}
                            {(Number(dc.totalRacks) > 0) && (
                                <div style={{ marginBottom: 16, background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px solid var(--border-color)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                                        <span>SPACE UTILIZATION</span>
                                        <span>{dc.usedRacks || 0} / {dc.totalRacks} Racks</span>
                                    </div>
                                    <div style={{ width: '100%', height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
                                        <div style={{ 
                                            width: `${Math.min(((dc.usedRacks || 0) / dc.totalRacks) * 100, 100)}%`, 
                                            height: '100%', 
                                            background: ((dc.usedRacks || 0) / dc.totalRacks) >= 0.8 ? 'var(--danger)' : 'var(--success)', 
                                            borderRadius: 3 
                                        }} />
                                    </div>
                                    {dc.powerCapacity && (
                                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6, display: 'flex', justifyContent: 'space-between' }}>
                                            <span>Power Limit:</span>
                                            <span style={{ color: 'var(--text-primary)' }}>{dc.powerCapacity} kW</span>
                                        </div>
                                    )}
                                </div>
                            )}
                            
                            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
                                <strong>Address:</strong> <span style={{ color: 'var(--text-primary)' }}>{dc.address || 'N/A'}</span>
                            </div>
                            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>
                                <strong>Contact:</strong> <span style={{ color: 'var(--text-primary)' }}>{dc.contact || 'N/A'}</span>
                            </div>
                            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: dc.emergencyHotline ? 6 : 16 }}>
                                <strong>Phone:</strong> <span style={{ color: 'var(--text-primary)' }}>{dc.contactNumber || 'N/A'}</span>
                            </div>
                            {dc.emergencyHotline && (
                                <div style={{ fontSize: 13, color: 'var(--danger)', marginBottom: 16, fontWeight: 600, background: 'rgba(239, 68, 68, 0.05)', padding: '6px 8px', borderRadius: 6, border: '1px dashed rgba(239, 68, 68, 0.3)' }}>
                                    🚨 24/7 EOC: {dc.emergencyHotline}
                                </div>
                            )}

                            <div style={{ marginTop: 'auto', borderTop: '1px solid var(--border-color)', paddingTop: 12 }}>
                                <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 8 }}>AUTHORIZED PERSONNEL (ACL)</div>
                                {(!dc.acl || dc.acl.length === 0) ? (
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No personnel registered.</div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        {dc.acl.map((p, i) => (
                                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                                                <span style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                                                <span style={{ color: 'var(--text-secondary)' }}>{p.phone}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* DC Form Modal */}
            {showDCModal && (
                <div className="modal-overlay" onClick={() => setShowDCModal(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(4px)' }}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, width: 560, maxWidth: '95%', maxHeight: '90vh', overflowY: 'auto', padding: 24 }}>
                        <h3 style={{ margin: '0 0 20px 0', color: 'var(--text-primary)' }}>{isExistingDC(currentDCForm) ? 'Edit Data Center' : 'Add New Data Center'}</h3>
                        <form onSubmit={saveDCInfo}>
                            <div className="form-group" style={{ marginBottom: 16 }}>
                                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Data Center Name</label>
                                <input required type="text" value={currentDCForm.name} onChange={e => setCurrentDCForm({ ...currentDCForm, name: e.target.value })} style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                            </div>
                            <div className="form-group" style={{ marginBottom: 16 }}>
                                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Certifications / Tier (comma separated)</label>
                                <input type="text" value={currentDCForm.certifications || ''} onChange={e => setCurrentDCForm({ ...currentDCForm, certifications: e.target.value })} placeholder="e.g. Tier III, ISO 27001" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                            </div>

                            {/* Physical Layout & Orientation Settings */}
                            <div style={{ marginBottom: 16, background: 'rgba(59, 130, 246, 0.05)', padding: 14, borderRadius: 10, border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                                <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent-primary)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span>📐</span> Physical Layout &amp; Orientation (實體排列方向)
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                                    <div className="form-group">
                                        <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>機櫃橫向順序 (Rack)</label>
                                        <select 
                                            value={currentDCForm.rackOrder || 'asc'} 
                                            onChange={e => setCurrentDCForm({ ...currentDCForm, rackOrder: e.target.value })}
                                            style={{ width: '100%', padding: '6px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }}
                                        >
                                            <option value="asc">正序 (Left → Right)</option>
                                            <option value="desc">反序 (Right → Left)</option>
                                        </select>
                                    </div>
                                    <div className="form-group">
                                        <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>通道縱向順序 (Row)</label>
                                        <select 
                                            value={currentDCForm.rowOrder || 'asc'} 
                                            onChange={e => setCurrentDCForm({ ...currentDCForm, rowOrder: e.target.value })}
                                            style={{ width: '100%', padding: '6px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }}
                                        >
                                            <option value="asc">正序 (Row 1 → N)</option>
                                            <option value="desc">反序 (Row N → 1)</option>
                                        </select>
                                    </div>
                                    <div className="form-group">
                                        <label style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>U 數編號方向 (U-Slot)</label>
                                        <select 
                                            value={currentDCForm.uOrder || 'desc'} 
                                            onChange={e => setCurrentDCForm({ ...currentDCForm, uOrder: e.target.value })}
                                            style={{ width: '100%', padding: '6px 8px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }}
                                        >
                                            <option value="desc">標準正序 (42U → 1U)</option>
                                            <option value="asc">反向排列 (1U → 42U)</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                            
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16, background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px dashed var(--border-color)' }}>
                                <div className="form-group" style={{ gridColumn: 'span 2' }}>
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Total Racks</label>
                                    <input type="number" min="0" value={currentDCForm.totalRacks || ''} onChange={e => setCurrentDCForm({ ...currentDCForm, totalRacks: e.target.value })} style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                                </div>
                                <div className="form-group">
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Power Cap. (kW)</label>
                                    <input type="number" min="0" value={currentDCForm.powerCapacity || ''} onChange={e => setCurrentDCForm({ ...currentDCForm, powerCapacity: e.target.value })} style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                                </div>
                            </div>

                            <div className="form-group" style={{ marginBottom: 16 }}>
                                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Address</label>
                                <input type="text" value={currentDCForm.address} onChange={e => setCurrentDCForm({ ...currentDCForm, address: e.target.value })} style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                                <div className="form-group">
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Contact Person</label>
                                    <input type="text" value={currentDCForm.contact} onChange={e => setCurrentDCForm({ ...currentDCForm, contact: e.target.value })} style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                                </div>
                                <div className="form-group">
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Contact Number</label>
                                    <input type="text" value={currentDCForm.contactNumber} onChange={e => setCurrentDCForm({ ...currentDCForm, contactNumber: e.target.value })} style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)' }} />
                                </div>
                            </div>
                            <div className="form-group" style={{ marginBottom: 16 }}>
                                <label style={{ display: 'block', fontSize: 12, color: 'var(--danger)', fontWeight: 600, marginBottom: 4 }}>24/7 EOC / Emergency Hotline</label>
                                <input type="text" value={currentDCForm.emergencyHotline || ''} onChange={e => setCurrentDCForm({ ...currentDCForm, emergencyHotline: e.target.value })} placeholder="e.g. +1-800-555-0199" style={{ width: '100%', padding: '8px 12px', background: 'rgba(239,68,68,0.05)', border: '1px solid var(--danger)', borderRadius: 8, color: 'var(--text-primary)' }} />
                            </div>
                            
                            <div style={{ marginBottom: 20 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                    <label style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>Access Control List (ACL)</label>
                                    <button type="button" onClick={addACLRow} style={{ background: 'transparent', border: '1px solid var(--accent-primary)', color: 'var(--accent-primary)', padding: '2px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>+ Add</button>
                                </div>
                                {(!currentDCForm.acl || currentDCForm.acl.length === 0) ? (
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>No ACL configured.</div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        {currentDCForm.acl.map((p, i) => (
                                            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                                <input type="text" placeholder="Name" value={p.name} onChange={e => updateACL(i, 'name', e.target.value)} style={{ flex: 1, padding: '6px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 12 }} />
                                                <input type="text" placeholder="Phone" value={p.phone} onChange={e => updateACL(i, 'phone', e.target.value)} style={{ flex: 1, padding: '6px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 12 }} />
                                                <button type="button" onClick={() => removeACLRow(i)} style={{ background: 'transparent', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: '0 4px' }}>🗑️</button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border-color)' }}>
                                {role === 'SuperAdmin' && isExistingDC(currentDCForm) && currentDCForm.id !== 'default' ? (
                                    <button type="button" className="btn btn-danger" onClick={() => { setDeleteConfirmText(''); setShowDeleteModal(true); }}>Delete DC</button>
                                ) : <div />}
                                <div style={{ display: 'flex', gap: 12 }}>
                                    <button type="button" className="btn btn-outline" onClick={() => setShowDCModal(false)}>Cancel</button>
                                    <button type="submit" className="btn btn-primary" disabled={saving}>Save Info</button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {showDeleteModal && (
                <div className="modal-overlay" onClick={() => setShowDeleteModal(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, backdropFilter: 'blur(4px)' }}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, width: 400, maxWidth: '90%', padding: 24, textAlign: 'center' }}>
                        <div style={{ fontSize: '3.5rem', marginBottom: '16px' }}>⚠️</div>
                        <h3 style={{ margin: '0 0 12px 0', color: 'var(--text-primary)' }}>Delete Data Center</h3>
                        <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>
                            Are you sure you want to delete <strong>{currentDCForm?.name}</strong>? This will clear all server racks and devices inside it. This action cannot be undone.
                        </p>
                        <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 8 }}>
                            請輸入 Data Center 名稱 <strong>{currentDCForm?.name}</strong> 以確認刪除：
                        </p>
                        <input
                            type="text"
                            value={deleteConfirmText}
                            onChange={e => setDeleteConfirmText(e.target.value)}
                            placeholder={currentDCForm?.name}
                            style={{ width: '100%', padding: '8px 12px', marginBottom: 20, background: 'var(--bg-primary)', border: '1px solid var(--danger)', borderRadius: 8, color: 'var(--text-primary)' }}
                        />
                        <div style={{ display: 'flex', gap: 12 }}>
                            <button type="button" className="btn btn-outline" style={{ flex: 1 }} onClick={() => setShowDeleteModal(false)}>Cancel</button>
                            <button type="button" className="btn btn-danger" style={{ flex: 1 }} onClick={deleteDC} disabled={saving || deleteConfirmText !== currentDCForm?.name}>Yes, Delete</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Top-Down View Modal */}
            {showTopDownModal && (
                <div className="modal-overlay" onClick={() => setShowTopDownModal(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200, backdropFilter: 'blur(8px)' }}>
                    <div className="modal-content glass-panel" onClick={e => e.stopPropagation()} style={{ width: '90%', maxWidth: '1200px', height: '80vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
                        <div style={{ padding: '16px 24px', borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                            <h2 style={{ margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', fontSize: 18 }}>
                                <span>🗺️</span> {selectedDCForTopDown?.name} - Floor Plan
                            </h2>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                {selectedDCForTopDown?.rackOrder === 'desc' && (
                                    <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
                                        🔀 機櫃反序 (R→L)
                                    </span>
                                )}
                                {selectedDCForTopDown?.rowOrder === 'desc' && (
                                    <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
                                        ↕️ 通道反序 (N→1)
                                    </span>
                                )}
                                <button className="modal-close" onClick={() => setShowTopDownModal(false)} style={{ fontSize: '24px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 8 }}>&times;</button>
                            </div>
                        </div>
                        <div style={{ flex: 1, padding: '24px', overflowY: 'auto' }}>
                            {loadingRacks ? (
                                <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>Loading Floor Plan...</div>
                            ) : dcRacks.length === 0 ? (
                                <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>No racks found in this Data Center.</div>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                                    {Object.keys(dcRacks.reduce((acc, rack) => {
                                        const rNum = rack.rowNumber || 1;
                                        if (!acc[rNum]) acc[rNum] = [];
                                        acc[rNum].push(rack);
                                        return acc;
                                    }, {})).sort((a, b) => (selectedDCForTopDown?.rowOrder || 'asc') === 'desc' ? Number(b) - Number(a) : Number(a) - Number(b)).map(rowNum => {
                                        const rows = dcRacks.reduce((acc, rack) => {
                                            const rNum = rack.rowNumber || 1;
                                            if (!acc[rNum]) acc[rNum] = [];
                                            acc[rNum].push(rack);
                                            return acc;
                                        }, {});
                                        const sortedRowRacks = [...rows[rowNum]].sort((a, b) => {
                                            const cmp = a.name.localeCompare(b.name);
                                            return (selectedDCForTopDown?.rackOrder || 'asc') === 'desc' ? -cmp : cmp;
                                        });
                                        return (
                                            <div key={rowNum} style={{ background: 'rgba(0,0,0,0.3)', padding: '24px', borderRadius: '16px', border: '1px solid var(--border-color)', position: 'relative' }}>
                                                <div style={{ position: 'absolute', top: '-14px', left: '24px', background: 'var(--bg-glass)', padding: '4px 16px', borderRadius: '12px', border: '1px solid var(--border-color)', fontSize: '14px', fontWeight: 'bold', color: 'var(--accent-primary)', backdropFilter: 'blur(8px)' }}>
                                                    Row {rowNum}
                                                </div>
                                                <div style={{ display: 'flex', gap: '20px', flexWrap: 'nowrap', overflowX: 'auto', padding: '16px 4px 8px 4px' }}>
                                                    {sortedRowRacks.map(rack => {
                                                        const usedCount = rack.devices?.length || 0;
                                                        const usageRatio = Math.min((usedCount / rack.height) * 100, 100) || 0;
                                                        const isCritical = usageRatio >= 85;
                                                        return (
                                                            <div 
                                                                key={rack.id} 
                                                                onClick={() => {
                                                                    setShowTopDownModal(false);
                                                                    try {
                                                                        sessionStorage.setItem('dc_selected_dc_id', selectedDCForTopDown.id);
                                                                        sessionStorage.setItem('dc_target_rack_id', rack.id);
                                                                        localStorage.setItem('dc_selected_dc_id', selectedDCForTopDown.id);
                                                                        localStorage.setItem('dc_target_rack_id', rack.id);
                                                                    } catch (e) {}
                                                                    if (onSelectDC) onSelectDC(selectedDCForTopDown.id, rack.id);
                                                                }}
                                                                style={{ 
                                                                    minWidth: '120px', 
                                                                    height: '160px', 
                                                                    background: 'var(--bg-primary)', 
                                                                    border: `2px solid ${isCritical ? 'var(--danger)' : 'var(--accent-primary)'}`, 
                                                                    borderRadius: '8px', 
                                                                    display: 'flex', 
                                                                    flexDirection: 'column', 
                                                                    cursor: 'pointer',
                                                                    transition: 'all 0.3s ease',
                                                                    position: 'relative',
                                                                    overflow: 'hidden',
                                                                    boxShadow: '0 8px 16px rgba(0,0,0,0.3)'
                                                                }}
                                                                onMouseEnter={e => {
                                                                    e.currentTarget.style.transform = 'translateY(-6px)';
                                                                    e.currentTarget.style.boxShadow = '0 12px 24px rgba(0,0,0,0.5)';
                                                                }}
                                                                onMouseLeave={e => {
                                                                    e.currentTarget.style.transform = 'none';
                                                                    e.currentTarget.style.boxShadow = '0 8px 16px rgba(0,0,0,0.3)';
                                                                }}
                                                                title="Click to focus Server Rack"
                                                            >
                                                                <div style={{ padding: '10px 8px', textAlign: 'center', fontSize: '14px', fontWeight: 'bold', color: 'var(--text-primary)', borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(255,255,255,0.02)' }}>
                                                                    {rack.name}
                                                                </div>
                                                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
                                                                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '1px' }}>Capacity</div>
                                                                    <div style={{ fontSize: '18px', fontWeight: '900', color: isCritical ? 'var(--danger)' : 'var(--success)' }}>
                                                                        {usedCount} <span style={{ fontSize: '14px', fontWeight: 'normal', color: 'var(--text-muted)' }}>/ {rack.height}</span>
                                                                    </div>
                                                                </div>
                                                                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '6px', background: 'rgba(0,0,0,0.5)' }}>
                                                                    <div style={{ width: `${usageRatio}%`, height: '100%', background: isCritical ? 'var(--danger)' : 'var(--success)', transition: 'width 1s ease-in-out' }} />
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DataCenters;
