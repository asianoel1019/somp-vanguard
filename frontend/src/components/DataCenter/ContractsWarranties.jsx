import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';

const ContractsWarranties = () => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';

    const [contracts, setContracts] = useState([]);
    const [devices, setDevices] = useState([]);
    const [issues, setIssues] = useState([]);
    const [activeTab, setActiveTab] = useState('Hardware Warranties');
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');

    const [showModal, setShowModal] = useState(false);
    const [currentForm, setCurrentForm] = useState(null);
    const [uploading, setUploading] = useState(false);
    const fileInputRef = useRef(null);

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        setLoading(true);
        try {
            const [conRes, rackRes, issuesRes] = await Promise.all([
                api.get('/rack/contracts'),
                api.get('/rack'),
                api.get('/rack/issues')
            ]);
            setContracts(conRes.data || []);
            
            const racks = rackRes.data || [];
            const allDevices = racks.flatMap(r => r.servers || []);
            setDevices(allDevices);
            
            setIssues(issuesRes.data || []);
        } catch (err) {
            console.error('Failed to load data:', err);
        } finally {
            setLoading(false);
        }
    };

    const openAddContract = () => {
        setCurrentForm({
            id: '',
            type: activeTab,
            name: '',
            vendor: '',
            startDate: '',
            endDate: '',
            linkedDevices: [],
            licenseKey: '',
            serialNumber: '',
            seats: '',
            cost: '',
            currency: 'TWD',
            fileBase64: null,
            originalFileName: null,
            fileType: null
        });
        if (fileInputRef.current) fileInputRef.current.value = '';
        setShowModal(true);
    };

    const openEditContract = (c) => {
        setCurrentForm({ ...c, fileBase64: null, originalFileName: null, fileType: null }); // Reset file upload state for edit
        if (fileInputRef.current) fileInputRef.current.value = '';
        setShowModal(true);
    };

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (ev) => {
            setCurrentForm(prev => ({
                ...prev,
                fileBase64: ev.target.result,
                originalFileName: file.name,
                fileType: file.type || 'application/octet-stream'
            }));
        };
        reader.readAsDataURL(file);
    };

    const toggleDeviceLink = (deviceId) => {
        setCurrentForm(prev => {
            const currentLinks = prev.linkedDevices || [];
            if (currentLinks.includes(deviceId)) {
                return { ...prev, linkedDevices: currentLinks.filter(id => id !== deviceId) };
            } else {
                return { ...prev, linkedDevices: [...currentLinks, deviceId] };
            }
        });
    };

    const saveContract = async (e) => {
        e.preventDefault();
        try {
            setUploading(true);
            const res = await api.post('/rack/contracts', currentForm);
            if (res.data.success) {
                setShowModal(false);
                fetchData();
            }
        } catch (err) {
            console.error(err);
            showToast('Failed to save contract');
        } finally {
            setUploading(false);
        }
    };

    const deleteContract = async (id) => {
        if (!await showConfirm('Are you sure you want to move this contract to Trash?')) return;
        try {
            await api.delete(`/rack/contracts/${id}`);
            setShowModal(false);
            fetchData();
        } catch (err) {
            showToast('Delete failed');
        }
    };

    const restoreContract = async (id) => {
        try {
            await api.post(`/rack/contracts/${id}/restore`);
            fetchData();
            showToast('Contract restored successfully', 'success');
        } catch (err) {
            showToast('Restore failed', 'error');
        }
    };

    const forceDeleteContract = async (id) => {
        if (!await showConfirm('Are you sure you want to permanently delete this contract? This cannot be undone.')) return;
        try {
            await api.delete(`/rack/contracts/${id}/force`);
            fetchData();
            showToast('Contract permanently deleted', 'success');
        } catch (err) {
            showToast('Delete failed', 'error');
        }
    };

    const downloadLicense = async (filename, originalName) => {
        try {
            const res = await api.get(`/rack/contracts/download/${filename}`, { responseType: 'blob' });
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', originalName || filename);
            document.body.appendChild(link);
            link.click();
            link.parentNode.removeChild(link);
        } catch (err) {
            showToast('Failed to download file');
        }
    };

    // Helpers to render status and progress
    const getStatus = (startDate, endDate) => {
        const now = new Date();
        const end = new Date(endDate);
        const daysLeft = Math.ceil((end - now) / (1000 * 60 * 60 * 24));
        
        if (daysLeft < 0) return { label: 'Expired', color: 'var(--danger)', bg: 'rgba(239, 68, 68, 0.1)', days: daysLeft };
        if (daysLeft <= 60) return { label: 'Expiring Soon', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.1)', days: daysLeft };
        return { label: 'Active', color: 'var(--success)', bg: 'rgba(16, 185, 129, 0.1)', days: daysLeft };
    };

    const getProgress = (start, end) => {
        if (!start || !end) return 0;
        const s = new Date(start).getTime();
        const e = new Date(end).getTime();
        const n = Date.now();
        if (n <= s) return 0;
        if (n >= e) return 100;
        return Math.floor(((n - s) / (e - s)) * 100);
    };

    const calcTotalCost = (type) => {
        return contracts
            .filter(c => !c.deletedAt && c.type === type && c.cost && getStatus(c.startDate, c.endDate).days >= 0)
            .reduce((sum, c) => sum + Number(c.cost || 0), 0)
            .toLocaleString();
    };

    const filteredContracts = contracts
        .filter(c => activeTab === 'Trash' ? c.deletedAt : (!c.deletedAt && c.type === activeTab))
        .filter(c => {
            if (!searchTerm) return true;
            const term = searchTerm.toLowerCase();
            return (c.name || '').toLowerCase().includes(term) || 
                   (c.vendor || '').toLowerCase().includes(term) || 
                   (c.serialNumber || '').toLowerCase().includes(term) ||
                   (c.licenseKey || '').toLowerCase().includes(term);
        })
        .sort((a, b) => {
            const aDays = getStatus(a.startDate, a.endDate).days;
            const bDays = getStatus(b.startDate, b.endDate).days;
            return aDays - bDays; // Nearest expiration first
        });
    
    if (loading) return <div style={{ padding: 40, textAlign: 'center' }}>Loading Contracts...</div>;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <h1 className="page-title" style={{ margin: 0 }}>Contracts & Warranties</h1>
                <div style={{ display: 'flex', gap: 12 }}>
                    <input 
                        type="text" 
                        placeholder="🔍 Search vendor, name, key..." 
                        value={searchTerm} 
                        onChange={e => setSearchTerm(e.target.value)} 
                        style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-glass)', color: 'var(--text-primary)', width: 250, outline: 'none' }}
                    />
                    {role !== 'Viewer' && (
                        <button className="btn btn-primary" onClick={openAddContract} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>➕</span> Add Contract
                        </button>
                    )}
                </div>
            </div>

            {/* TCO Dashboard */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
                <div style={{ background: 'var(--bg-glass)', borderRadius: 12, padding: 16, border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ fontSize: 32 }}>🖥️</div>
                    <div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>ACTIVE HARDWARE WARRANTY SPEND</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)' }}>TWD ${calcTotalCost('Hardware Warranties')}</div>
                    </div>
                </div>
                <div style={{ background: 'var(--bg-glass)', borderRadius: 12, padding: 16, border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ fontSize: 32 }}>💿</div>
                    <div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>ACTIVE SOFTWARE LICENSE SPEND</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)' }}>TWD ${calcTotalCost('Software Licenses')}</div>
                    </div>
                </div>
            </div>

            <div style={{ display: 'flex', gap: 16, marginBottom: 24, borderBottom: '1px solid var(--border-color)' }}>
                {['Hardware Warranties', 'Software Licenses', 'Trash'].map(t => (
                    <div 
                        key={t}
                        onClick={() => setActiveTab(t)}
                        style={{
                            padding: '10px 16px',
                            cursor: 'pointer',
                            color: activeTab === t ? (t === 'Trash' ? 'var(--danger)' : 'var(--accent-primary)') : 'var(--text-secondary)',
                            borderBottom: activeTab === t ? `2px solid ${t === 'Trash' ? 'var(--danger)' : 'var(--accent-primary)'}` : '2px solid transparent',
                            fontWeight: activeTab === t ? 700 : 500,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8
                        }}
                    >
                        <span>{t === 'Hardware Warranties' ? '🖥️' : t === 'Trash' ? '🗑️' : '💿'}</span> {t}
                    </div>
                ))}
            </div>

            {/* Contract List */}
            {filteredContracts.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', background: 'var(--bg-glass)', borderRadius: 12, border: '1px dashed var(--border-color)', color: 'var(--text-muted)' }}>
                    No {activeTab} contracts found. Click "Add Contract" to create one.
                </div>
            ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: 20, overflowY: 'auto' }}>
                    {filteredContracts.map(c => {
                        const statusObj = getStatus(c.startDate, c.endDate);
                        const progress = getProgress(c.startDate, c.endDate);
                        const relatedIssues = issues.filter(issue => c.linkedDevices?.includes(issue.deviceId));
                        
                        return (
                            <div key={c.id} style={{ background: 'var(--bg-glass)', borderRadius: 12, border: `1px solid ${statusObj.color}`, padding: 20, display: 'flex', flexDirection: 'column', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                    <h3 style={{ margin: '0 0 8px 0', color: 'var(--text-primary)', fontSize: 16 }}>{c.name}</h3>
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <span style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, background: statusObj.bg, color: statusObj.color, fontWeight: 600 }}>
                                            {statusObj.label}
                                        </span>
                                        {role !== 'Viewer' && (
                                            <button onClick={() => openEditContract(c)} style={{ background: 'transparent', border: '1px solid var(--border-color)', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer', padding: '2px 8px', fontSize: 11 }}>Edit</button>
                                        )}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
                                    <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}><strong>Vendor:</strong> {c.vendor}</div>
                                    {c.cost && <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>💰 {c.currency} ${Number(c.cost).toLocaleString()}</div>}
                                </div>
                                
                                <div style={{ marginBottom: 16 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                                        <span style={{ color: 'var(--text-muted)' }}>{c.startDate || 'N/A'}</span>
                                        <span style={{ color: statusObj.color, fontWeight: 600 }}>{c.endDate || 'N/A'}</span>
                                    </div>
                                    <div style={{ width: '100%', height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
                                        <div style={{ width: `${progress}%`, height: '100%', background: statusObj.color, borderRadius: 3, transition: 'width 0.5s ease' }} />
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'right', marginTop: 4 }}>
                                        {statusObj.days >= 0 ? `${statusObj.days} days remaining` : `${Math.abs(statusObj.days)} days expired`}
                                    </div>
                                </div>

                                {/* Linked Devices */}
                                {c.linkedDevices && c.linkedDevices.length > 0 && (
                                    <div style={{ marginBottom: 16 }}>
                                        <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 6 }}>LINKED DEVICES</div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                            {c.linkedDevices.map(did => {
                                                const dev = devices.find(d => d.id === did);
                                                return <span key={did} style={{ fontSize: 11, padding: '4px 8px', background: 'rgba(255,255,255,0.05)', borderRadius: 4, border: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                                                    {dev ? dev.name : did}
                                                </span>
                                            })}
                                        </div>
                                    </div>
                                )}

                                {/* Hardware Issues Integration */}
                                {relatedIssues.length > 0 && (
                                    <div style={{ marginBottom: 16, padding: 12, background: 'rgba(245, 158, 11, 0.05)', borderRadius: 8, border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--warning)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <span>⚠️</span> Related Hardware Issues
                                        </div>
                                        {relatedIssues.map(issue => (
                                            <div key={issue.id} style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
                                                <span>• {issue.issueTitle}</span>
                                                <span style={{ color: issue.status === 'Closed' ? 'var(--success)' : 'var(--warning)' }}>[{issue.status}]</span>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {/* Specific Fields & File */}
                                <div style={{ marginTop: 'auto', paddingTop: 16, borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    {c.type === 'Hardware Warranties' && c.serialNumber && (
                                        <div>
                                            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 4 }}>SERIAL NUMBER / SERVICE TAG:</div>
                                            <code style={{ display: 'block', fontSize: 12, background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: 6, wordBreak: 'break-all', border: '1px solid rgba(255,255,255,0.05)', color: 'var(--accent-primary)' }}>{c.serialNumber}</code>
                                        </div>
                                    )}
                                    {c.type === 'Software Licenses' && (
                                        <>
                                            {c.licenseKey && (
                                                <div>
                                                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 4 }}>LICENSE KEY:</div>
                                                    <code style={{ display: 'block', fontSize: 12, background: 'rgba(0,0,0,0.2)', padding: '8px', borderRadius: 6, wordBreak: 'break-all', border: '1px solid rgba(255,255,255,0.05)' }}>{c.licenseKey}</code>
                                                </div>
                                            )}
                                            {c.seats && (
                                                <div style={{ marginTop: 8 }}>
                                                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 4 }}>SEATS UTILIZATION:</div>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                                        <div style={{ flex: 1, height: 8, background: 'rgba(255,255,255,0.1)', borderRadius: 4, overflow: 'hidden' }}>
                                                            <div style={{ 
                                                                width: `${Math.min(((c.linkedDevices?.length || 0) / c.seats) * 100, 100)}%`, 
                                                                height: '100%', 
                                                                background: (c.linkedDevices?.length || 0) > c.seats ? 'var(--danger)' : '#3b82f6', 
                                                                borderRadius: 4 
                                                            }} />
                                                        </div>
                                                        <span style={{ fontSize: 12, color: (c.linkedDevices?.length || 0) > c.seats ? 'var(--danger)' : 'var(--text-primary)', fontWeight: 600 }}>
                                                            {c.linkedDevices?.length || 0} / {c.seats} Used
                                                        </span>
                                                    </div>
                                                </div>
                                            )}
                                        </>
                                    )}
                                    
                                    {c.savedFileName && (
                                        <button 
                                            onClick={() => downloadLicense(c.savedFileName, c.originalFileName || c.savedFileName)}
                                            style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(59, 130, 246, 0.1)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)', padding: '8px 12px', borderRadius: 6, cursor: 'pointer', alignSelf: 'flex-start', fontSize: 12, transition: 'all 0.2s' }}
                                        >
                                            📄 Download File ({c.originalFileName || c.savedFileName})
                                        </button>
                                    )}

                                    {activeTab === 'Trash' && role !== 'Viewer' && (
                                        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                            <button onClick={() => restoreContract(c.id)} style={{ flex: 1, background: 'var(--success)', color: '#fff', border: 'none', padding: '8px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Restore</button>
                                            <button onClick={() => forceDeleteContract(c.id)} style={{ flex: 1, background: 'var(--danger)', color: '#fff', border: 'none', padding: '8px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>Delete Permanently</button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Modal */}
            {showModal && (
                <div className="modal-overlay" onClick={() => setShowModal(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(4px)' }}>
                    <div className="modal-content" onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-glass)', width: 600, maxWidth: '90%', padding: 28, borderRadius: 16, border: '1px solid var(--border-color)' }}>
                        <h2 style={{ margin: '0 0 24px 0', color: 'var(--text-primary)', fontSize: 20 }}>{currentForm.id ? 'Edit Contract' : 'New Contract'}</h2>
                        
                        <form onSubmit={saveContract}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                                <div className="form-group">
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Type</label>
                                    <select value={currentForm.type} onChange={e => setCurrentForm({...currentForm, type: e.target.value})} style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }}>
                                        <option value="Hardware Warranties">Hardware Warranties</option>
                                        <option value="Software Licenses">Software Licenses</option>
                                    </select>
                                </div>
                                <div className="form-group">
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Vendor</label>
                                    <input required type="text" value={currentForm.vendor} onChange={e => setCurrentForm({...currentForm, vendor: e.target.value})} style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }} placeholder="e.g. Dell, Microsoft..." />
                                </div>
                            </div>
                            
                            <div style={{ display: 'grid', gridTemplateColumns: currentForm.type === 'Software Licenses' ? '2fr 1fr' : '1fr 1fr', gap: 16, marginBottom: 16 }}>
                                <div className="form-group">
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                                        {currentForm.type === 'Hardware Warranties' ? 'Warranty Level / Name' : 'Software Name'}
                                    </label>
                                    <input required type="text" value={currentForm.name} onChange={e => setCurrentForm({...currentForm, name: e.target.value})} style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }} placeholder={currentForm.type === 'Hardware Warranties' ? "e.g. ProSupport Plus" : "e.g. Windows Server 2022"} />
                                </div>
                                
                                {currentForm.type === 'Hardware Warranties' && (
                                    <div className="form-group">
                                        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Serial Number / Service Tag</label>
                                        <input required type="text" value={currentForm.serialNumber || ''} onChange={e => setCurrentForm({...currentForm, serialNumber: e.target.value})} style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }} placeholder="e.g. D1XYZ2" />
                                    </div>
                                )}
                                
                                {currentForm.type === 'Software Licenses' && (
                                    <div className="form-group">
                                        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Seats / Quantity</label>
                                        <input type="number" value={currentForm.seats || ''} onChange={e => setCurrentForm({...currentForm, seats: e.target.value})} style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }} placeholder="e.g. 50" min="1" />
                                    </div>
                                )}
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                                <div className="form-group">
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Cost / Amount</label>
                                    <input type="number" value={currentForm.cost || ''} onChange={e => setCurrentForm({...currentForm, cost: e.target.value})} style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }} placeholder="e.g. 5000" min="0" />
                                </div>
                                <div className="form-group">
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Currency</label>
                                    <select value={currentForm.currency || 'TWD'} onChange={e => setCurrentForm({...currentForm, currency: e.target.value})} style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }}>
                                        <option value="TWD">TWD</option>
                                        <option value="USD">USD</option>
                                        <option value="EUR">EUR</option>
                                    </select>
                                </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                                <div className="form-group">
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Start Date</label>
                                    <input required type="date" value={currentForm.startDate} onChange={e => setCurrentForm({...currentForm, startDate: e.target.value})} style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }} />
                                </div>
                                <div className="form-group">
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>End Date</label>
                                    <input required type="date" value={currentForm.endDate} onChange={e => setCurrentForm({...currentForm, endDate: e.target.value})} style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 14 }} />
                                </div>
                            </div>

                            <div className="form-group" style={{ marginBottom: 16 }}>
                                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Linked Devices (from Server Rack)</label>
                                <div className="custom-scrollbar" style={{ maxHeight: 160, overflowY: 'auto', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 12px' }}>
                                    {devices.map(d => (
                                        <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                            <input 
                                                type="checkbox" 
                                                checked={(currentForm.linkedDevices || []).includes(d.id)}
                                                onChange={() => toggleDeviceLink(d.id)}
                                                style={{ cursor: 'pointer', width: 16, height: 16 }}
                                            />
                                            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{d.name} <span style={{ color: 'var(--text-muted)' }}>({d.model})</span></span>
                                        </label>
                                    ))}
                                    {devices.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '10px 0' }}>No devices found in data center.</div>}
                                </div>
                            </div>

                            {currentForm.type === 'Software Licenses' && (
                                <div className="form-group" style={{ marginBottom: 16 }}>
                                    <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>License Key (Optional)</label>
                                    <textarea value={currentForm.licenseKey || ''} onChange={e => setCurrentForm({...currentForm, licenseKey: e.target.value})} style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)', minHeight: 80, fontSize: 13, fontFamily: 'monospace' }} placeholder="Paste product key here..." />
                                </div>
                            )}

                            <div className="form-group" style={{ marginBottom: 24, padding: 16, background: 'rgba(255,255,255,0.02)', border: '1px dashed var(--border-color)', borderRadius: 8 }}>
                                <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 700 }}>Upload License File (PDF, LIC, PEM) (Optional)</label>
                                <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)' }} />
                                {currentForm.originalFileName && (
                                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--success)' }}>
                                        ✓ Selected: {currentForm.originalFileName} (Will upload on save)
                                    </div>
                                )}
                                {currentForm.savedFileName && !currentForm.originalFileName && (
                                    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                                        Current file on server: {currentForm.originalFileName || currentForm.savedFileName}
                                    </div>
                                )}
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: 20 }}>
                                {currentForm.id ? (
                                    <button type="button" className="btn btn-danger" onClick={() => deleteContract(currentForm.id)} style={{ padding: '8px 16px', borderRadius: 8 }}>Delete Contract</button>
                                ) : <div />}
                                <div style={{ display: 'flex', gap: 12 }}>
                                    <button type="button" className="btn btn-outline" onClick={() => setShowModal(false)} style={{ padding: '8px 16px', borderRadius: 8 }}>Cancel</button>
                                    <button type="submit" className="btn btn-primary" disabled={uploading} style={{ padding: '8px 24px', borderRadius: 8 }}>
                                        {uploading ? 'Saving...' : 'Save Contract'}
                                    </button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ContractsWarranties;
