import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState, useEffect } from 'react';
import api from '../../api';

// One id per spare-part selection: the server deducts stock once per usageId even if the save is retried
const newUsageId = () => (typeof window !== 'undefined' && window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID()
    : `usage-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export default function HardwareIssues() {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';

    const [hwIssues, setHwIssues] = useState([]);
    const [initialLoaded, setInitialLoaded] = useState(false);
    
    // UI state
    const [viewMode, setViewMode] = useState('kanban');
    const [hwFilterStatus, setHwFilterStatus] = useState('ALL');
    const [showHWFormModal, setShowHWFormModal] = useState(false);
    const [activeDropdownId, setActiveDropdownId] = useState(null);
    const [currentHWForm, setCurrentHWForm] = useState(null);
    const [isHWFormReadOnly, setIsHWFormReadOnly] = useState(false);
    
    // Process Note State inside Drawer
    const [processType, setProcessType] = useState('Note'); // 'Processing', 'Closed', or 'Note'
    const [processNote, setProcessNote] = useState('');

    // Datacenter & Device selection state
    const [dcs, setDcs] = useState([]);
    const [formRacks, setFormRacks] = useState([]);

    // Spare Parts Integration State
    const [sparePartsData, setSparePartsData] = useState({ categories: [], items: [] });
    const [useSparePart, setUseSparePart] = useState(false);
    const [selectedSparePartId, setSelectedSparePartId] = useState('');
    const [sparePartQty, setSparePartQty] = useState(1);
    const [sparePartUsageId, setSparePartUsageId] = useState('');

    const reloadSpareParts = () => {
        api.get('/rack/spare-parts').then(res => {
            if (res.data) setSparePartsData(res.data);
        }).catch(err => console.error('Failed to fetch spare parts:', err));
    };

    useEffect(() => {
        // Fetch datacenters
        api.get('/rack/datacenters').then(res => {
            if (res.data) setDcs(res.data);
        }).catch(err => console.error('Failed to fetch datacenters:', err));

        // Fetch issues
        api.get('/rack/issues').then(res => {
            if (res.data) {
                const parsed = res.data.map(i => {
                    let notes = i.processNotes || [];
                    if (typeof notes === 'string') {
                        notes = notes.split('\n').filter(Boolean).map(n => {
                            const match = n.match(/\[(.*?)\] (.*?): (.*)/);
                            if (match) {
                                return { timestamp: match[1], status: match[2], note: match[3], user: 'System' };
                            } else {
                                return { timestamp: '', status: 'Legacy Note', note: n, user: 'System' };
                            }
                        });
                    }
                    return { ...i, processNotes: notes };
                });
                setHwIssues(parsed);
            }
            setInitialLoaded(true);
        }).catch(err => {
            console.error('Failed to fetch issues:', err);
            setInitialLoaded(true);
        });

        // Fetch spare parts for dropdown
        api.get('/rack/spare-parts').then(res => {
            if (res.data) setSparePartsData(res.data);
        }).catch(err => console.error('Failed to fetch spare parts:', err));
        // Click outside logic for Action Menu in table view
        const closeDropdown = (e) => {
            if (!e.target.closest('.action-dropdown-container')) {
                setActiveDropdownId(null);
            }
        };
        document.addEventListener('click', closeDropdown);
        return () => document.removeEventListener('click', closeDropdown);
    }, []);

    // Load racks when a DC is selected
    const handleDCChange = (dcName) => {
        setCurrentHWForm(prev => ({ ...prev, datacenter: dcName, deviceName: '', sn: '', rackLoc: '' }));
        const dc = dcs.find(d => d.name === dcName);
        if (dc) {
            api.get(`/rack?dcId=${dc.id}`).then(res => {
                if (res.data) setFormRacks(res.data);
            }).catch(console.error);
        } else {
            setFormRacks([]);
        }
    };

    const availableDevices = React.useMemo(() => {
        let devs = [];
        formRacks.forEach(r => {
            (r.devices || []).forEach(d => {
                if (!['Shelf', 'Reserve', 'PatchPanel'].includes(d.type)) {
                    devs.push({ ...d, rackLoc: `${r.name} - U${d.u}` });
                }
            });
        });
        return devs.sort((a, b) => (a.hostname || '').localeCompare(b.hostname || ''));
    }, [formRacks]);

    const handleDeviceChange = (deviceId) => {
        const dev = availableDevices.find(d => d.id === deviceId);
        if (dev) {
            setCurrentHWForm(prev => ({ ...prev, deviceName: dev.hostname, sn: dev.sn || '', rackLoc: dev.rackLoc }));
        } else {
            setCurrentHWForm(prev => ({ ...prev, deviceName: deviceId, sn: '', rackLoc: '' }));
        }
    };

    const openCreateForm = () => {
        setFormRacks([]);
        setIsHWFormReadOnly(false);
        setProcessNote('');
        setProcessType('Note');
        setUseSparePart(false);
        setSelectedSparePartId('');
        setSparePartQty(1);
        setSparePartUsageId('');
        setCurrentHWForm({
            date: new Date().toISOString().split('T')[0],
            datacenter: '',
            deviceName: '',
            sn: '',
            rackLoc: '',
            failedParts: '',
            reporter: user.username || '',
            urgency: 'M',
            status: 'Open',
            partsInfo: '',
            processNotes: []
        });
        setShowHWFormModal(true);
    };

    const openEditForm = (issue, readOnly = false) => {
        setIsHWFormReadOnly(readOnly);
        setCurrentHWForm(issue);
        setProcessNote('');
        setProcessType('Note');
        setUseSparePart(false);
        setSelectedSparePartId('');
        setSparePartQty(1);
        setSparePartUsageId('');
        
        // Pre-fetch racks if DC is selected
        const dc = dcs.find(d => d.name === issue.datacenter);
        if (dc) {
            api.get(`/rack?dcId=${dc.id}`).then(res => {
                if (res.data) setFormRacks(res.data);
            }).catch(console.error);
        } else {
            setFormRacks([]);
        }
        setShowHWFormModal(true);
    };

    const handleSaveIssue = (e) => {
        e.preventDefault();
        let finalForm = { ...currentHWForm };
        
        const usesPart = useSparePart && selectedSparePartId && sparePartQty > 0;
        if (usesPart) {
            finalForm.sparePartUsage = { partId: selectedSparePartId, qty: sparePartQty, usageId: sparePartUsageId || newUsageId() };
        }

        if (role !== 'Viewer') {
            const request = finalForm.id
                ? api.put(`/rack/issues/${finalForm.id}`, finalForm)
                : api.post('/rack/issues/single', finalForm);
            request.then(res => {
                const saved = res.data.issue;
                setHwIssues(prev => (prev.some(i => i.id === saved.id) ? prev.map(i => (i.id === saved.id ? saved : i)) : [...prev, saved]));
                setShowHWFormModal(false);
                if (usesPart) reloadSpareParts();
            }).catch(err => {
                console.error('Failed to save issue:', err);
                // keep the form (and the usageId) so a retry does not deduct twice
                showToast(err.response?.data?.error || 'Failed to save issue.', 'error');
            });
            return;
        }
        setShowHWFormModal(false);
    };

    const handleDeleteIssue = async (id) => {
        if (!await showConfirm('Delete this issue?')) return;
        api.delete(`/rack/issues/${id}`).then(() => {
            setHwIssues(hwIssues.filter(i => i.id !== id));
            if (currentHWForm && currentHWForm.id === id) {
                setShowHWFormModal(false);
            }
        }).catch(err => {
            console.error('Failed to delete issue:', err);
            showToast(err.response?.data?.error || 'Failed to delete issue.', 'error');
        });
    };

    const handleUpdateProcessStatus = () => {
        const timestamp = new Date().toLocaleString();
        const newNoteEntry = {
            timestamp,
            user: user.username || 'Unknown',
            status: processType === 'Note' ? 'General Note' : processType,
            note: processNote
        };

        const updatedIssue = { 
            ...currentHWForm, 
            processNotes: [newNoteEntry, ...(currentHWForm.processNotes || [])] 
        };
        
        if (processType !== 'Note') {
            updatedIssue.status = processType;
        }

        const usesPart = useSparePart && selectedSparePartId && sparePartQty > 0;
        if (usesPart) {
            updatedIssue.sparePartUsage = { partId: selectedSparePartId, qty: sparePartQty, usageId: sparePartUsageId || newUsageId() };
        }

        if (role !== 'Viewer' && updatedIssue.id) {
            api.put(`/rack/issues/${updatedIssue.id}`, updatedIssue).then(res => {
                const saved = res.data.issue;
                setHwIssues(prev => prev.map(i => i.id === saved.id ? saved : i));
                setCurrentHWForm(saved);
                setProcessNote('');
                setProcessType('Note');
                setUseSparePart(false);
                setSelectedSparePartId('');
                setSparePartQty(1);
                setSparePartUsageId('');
                if (usesPart) reloadSpareParts();
            }).catch(err => {
                console.error('Failed to update issue:', err);
                showToast(err.response?.data?.error || 'Failed to update issue.', 'error');
            });
            return;
        }

        const { sparePartUsage: _unsent, ...localIssue } = updatedIssue;
        setCurrentHWForm(localIssue);
        setProcessNote('');
        setProcessType('Note');
        setUseSparePart(false);
        setSelectedSparePartId('');
        setSparePartQty(1);
        setSparePartUsageId('');
    };

    const exportIssuesToCSV = () => {
        const escapeCSV = (val) => '"' + String(val || '').replace(/"/g, '""') + '"';
        const headers = ['Date', 'Datacenter', 'Device', 'SN', 'Location', 'Failed Parts', 'Reporter', 'Urgency', 'Status', 'Process Notes'];
        const rows = hwIssues.map(i => [
            escapeCSV(i.date),
            escapeCSV(i.datacenter),
            escapeCSV(i.deviceName),
            escapeCSV(i.sn),
            escapeCSV(i.rackLoc),
            escapeCSV(i.failedParts),
            escapeCSV(i.reporter),
            escapeCSV(i.urgency),
            escapeCSV(i.status),
            escapeCSV((i.processNotes || []).map(n => `[${n.timestamp}] ${n.status}: ${n.note}`).join(' | '))
        ]);
        const csvContent = "data:text/csv;charset=utf-8,\uFEFF" + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement('a');
        link.setAttribute('href', encodedUri);
        link.setAttribute('download', `hw_issues_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    if (!initialLoaded) return <div style={{ padding: 40, textAlign: 'center' }}>Loading Issues...</div>;

    // Filter issues for columns
    const filteredIssues = hwIssues.filter(i => hwFilterStatus === 'ALL' || i.status === hwFilterStatus);
    const openIssues = filteredIssues.filter(i => i.status === 'Open');
    const processingIssues = filteredIssues.filter(i => i.status === 'Processing');
    const closedIssues = filteredIssues.filter(i => i.status === 'Closed');

    const totalOpen = hwIssues.filter(i => i.status === 'Open').length;
    const totalProcessing = hwIssues.filter(i => i.status === 'Processing').length;
    const totalClosed = hwIssues.filter(i => i.status === 'Closed').length;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Header & Ribbon */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
                <div>
                    <h1 className="page-title" style={{ margin: 0, marginBottom: 16 }}>Hardware Issues & Maintenance</h1>
                    
                    {/* Metrics Ribbon */}
                    <div style={{ display: 'flex', gap: 16 }}>
                        <div className="glass-panel" style={{ padding: '12px 20px', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12, minWidth: 160 }}>
                            <div style={{ background: 'rgba(239, 68, 68, 0.2)', color: '#ef4444', width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>🚨</div>
                            <div>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Open Issues</div>
                                <div style={{ fontSize: 24, fontWeight: 800 }}>{totalOpen}</div>
                            </div>
                        </div>
                        <div className="glass-panel" style={{ padding: '12px 20px', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12, minWidth: 160 }}>
                            <div style={{ background: 'rgba(59, 130, 246, 0.2)', color: '#3b82f6', width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>⚙️</div>
                            <div>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Processing</div>
                                <div style={{ fontSize: 24, fontWeight: 800 }}>{totalProcessing}</div>
                            </div>
                        </div>
                        <div className="glass-panel" style={{ padding: '12px 20px', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12, minWidth: 160 }}>
                            <div style={{ background: 'rgba(16, 185, 129, 0.2)', color: '#10b981', width: 40, height: 40, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>✅</div>
                            <div>
                                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Closed</div>
                                <div style={{ fontSize: 24, fontWeight: 800 }}>{totalClosed}</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                    <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: 4, borderRadius: 8, border: '1px solid var(--border-color)' }}>
                        <button 
                            className={`btn ${viewMode === 'table' ? 'btn-primary' : ''}`} 
                            onClick={() => setViewMode('table')} 
                            style={{ padding: '6px 12px', background: viewMode === 'table' ? 'var(--accent-primary)' : 'transparent', color: viewMode === 'table' ? '#fff' : 'var(--text-muted)', border: 'none', boxShadow: 'none' }}>
                            📄 Table
                        </button>
                        <button 
                            className={`btn ${viewMode === 'kanban' ? 'btn-primary' : ''}`} 
                            onClick={() => setViewMode('kanban')} 
                            style={{ padding: '6px 12px', background: viewMode === 'kanban' ? 'var(--accent-primary)' : 'transparent', color: viewMode === 'kanban' ? '#fff' : 'var(--text-muted)', border: 'none', boxShadow: 'none' }}>
                            📇 Kanban
                        </button>
                    </div>

                    <button className="btn btn-outline" onClick={exportIssuesToCSV} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        📥 Export Excel
                    </button>
                    {role !== 'Viewer' && (
                        <button className="btn btn-primary" onClick={openCreateForm} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            + Report Issue
                        </button>
                    )}
                </div>
            </div>

            {/* Views */}
            {viewMode === 'kanban' ? (
                <div className="kanban-board">
                {/* Column: Open */}
                <div className="kanban-column">
                    <div className="kanban-header">
                        <span>🚨 Open</span>
                        <span style={{ fontSize: 12, background: 'rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: 12 }}>{openIssues.length}</span>
                    </div>
                    <div className="kanban-cards">
                        {openIssues.map(issue => (
                            <div key={issue.id} className={`kanban-card ${issue.urgency === 'H' ? 'glow-red' : ''}`} onClick={() => openEditForm(issue, role === 'Viewer')}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                    <div style={{ fontWeight: 700, fontSize: 14 }}>{issue.deviceName}</div>
                                    <span style={{ padding: '2px 6px', borderRadius: 4, background: issue.urgency === 'H' ? 'var(--danger)' : issue.urgency === 'M' ? '#f59e0b' : 'var(--success)', color: '#fff', fontSize: 10, fontWeight: 700 }}>
                                        {issue.urgency === 'H' ? 'HIGH' : issue.urgency === 'M' ? 'MED' : 'LOW'}
                                    </span>
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>📍 {issue.datacenter} | {issue.rackLoc}</div>
                                <div style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 4 }}>🔧 {issue.failedParts}</div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--accent-primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800 }}>
                                            {issue.reporter.charAt(0).toUpperCase()}
                                        </div>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{issue.reporter}</span>
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{issue.date}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Column: Processing */}
                <div className="kanban-column">
                    <div className="kanban-header">
                        <span style={{ color: '#3b82f6' }}>⚙️ Processing</span>
                        <span style={{ fontSize: 12, background: 'rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: 12 }}>{processingIssues.length}</span>
                    </div>
                    <div className="kanban-cards">
                        {processingIssues.map(issue => (
                            <div key={issue.id} className={`kanban-card ${issue.urgency === 'H' ? 'glow-red' : ''}`} onClick={() => openEditForm(issue, role === 'Viewer')}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                    <div style={{ fontWeight: 700, fontSize: 14 }}>{issue.deviceName}</div>
                                    <span style={{ padding: '2px 6px', borderRadius: 4, background: issue.urgency === 'H' ? 'var(--danger)' : issue.urgency === 'M' ? '#f59e0b' : 'var(--success)', color: '#fff', fontSize: 10, fontWeight: 700 }}>
                                        {issue.urgency === 'H' ? 'HIGH' : issue.urgency === 'M' ? 'MED' : 'LOW'}
                                    </span>
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>📍 {issue.datacenter} | {issue.rackLoc}</div>
                                <div style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 4 }}>🔧 {issue.failedParts}</div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--accent-primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800 }}>
                                            {issue.reporter.charAt(0).toUpperCase()}
                                        </div>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{issue.reporter}</span>
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{issue.date}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Column: Closed */}
                <div className="kanban-column" style={{ opacity: 0.8 }}>
                    <div className="kanban-header">
                        <span style={{ color: 'var(--success)' }}>✅ Closed</span>
                        <span style={{ fontSize: 12, background: 'rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: 12 }}>{closedIssues.length}</span>
                    </div>
                    <div className="kanban-cards">
                        {closedIssues.map(issue => (
                            <div key={issue.id} className="kanban-card" onClick={() => openEditForm(issue, role === 'Viewer')}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                    <div style={{ fontWeight: 700, fontSize: 14, textDecoration: 'line-through', opacity: 0.7 }}>{issue.deviceName}</div>
                                    <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.1)', color: 'var(--text-muted)', fontSize: 10, fontWeight: 700 }}>
                                        CLOSED
                                    </span>
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>📍 {issue.datacenter} | {issue.rackLoc}</div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--bg-tertiary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800 }}>
                                            {issue.reporter.charAt(0).toUpperCase()}
                                        </div>
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{issue.reporter}</span>
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{issue.date}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
                </div>
            ) : (
                <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, minHeight: '300px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-primary)', zIndex: 10 }}>
                            <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Date</th>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Datacenter</th>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Device / SN</th>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Location</th>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Failed Parts</th>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Urgency</th>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Status</th>
                                <th style={{ padding: '12px 16px', color: 'var(--text-muted)' }}>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredIssues.map(issue => (
                                <tr key={issue.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '12px 16px', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{issue.date}</td>
                                    <td style={{ padding: '12px 16px', whiteSpace: 'nowrap' }}>{issue.datacenter}</td>
                                    <td style={{ padding: '12px 16px', cursor: 'pointer' }} onClick={() => openEditForm(issue, true)}>
                                        <span style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}>{issue.deviceName}</span> 
                                        <br />
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>SN: {issue.sn}</span>
                                    </td>
                                    <td style={{ padding: '12px 16px', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>{issue.rackLoc}</td>
                                    <td style={{ padding: '12px 16px', color: 'var(--text-secondary)' }}>{issue.failedParts}</td>
                                    <td style={{ padding: '12px 16px' }}>
                                        <span style={{ padding: '4px 8px', borderRadius: 4, background: issue.urgency === 'H' ? 'var(--danger)' : issue.urgency === 'M' ? '#f59e0b' : 'var(--success)', color: '#fff', fontSize: 11, fontWeight: 700 }}>{issue.urgency}</span>
                                    </td>
                                    <td style={{ padding: '12px 16px', whiteSpace: 'nowrap', fontWeight: 700, color: issue.status === 'Closed' ? 'var(--success)' : issue.status === 'Processing' ? '#3b82f6' : 'var(--text-primary)' }}>{issue.status}</td>
                                    <td style={{ padding: '12px 16px' }}>
                                        <div className="action-dropdown-container" style={{ position: 'relative', display: 'inline-block' }}>
                                            <button className="btn btn-outline" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => setActiveDropdownId(activeDropdownId === issue.id ? null : issue.id)}>Actions ▾</button>
                                            {activeDropdownId === issue.id && (
                                                <div className="action-dropdown-menu glass-panel" style={{ 
                                                    position: 'absolute', right: 0, top: '100%', bottom: 'auto', marginTop: '4px', zIndex: 100, display: 'flex', flexDirection: 'column', gap: 2, padding: 8, minWidth: 150, boxShadow: '0 8px 16px rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: 8, textAlign: 'left'
                                                }}>
                                                    <button className="dropdown-item-btn" style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', padding: 8, textAlign: 'left', cursor: 'pointer', borderRadius: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => openEditForm(issue, role === 'Viewer')}>
                                                        {role === 'Viewer' ? <><span style={{width: 16}}>👁️</span> View</> : <><span style={{width: 16}}>✏️</span> View / Edit</>}
                                                    </button>
                                                    {role !== 'Viewer' && (
                                                        <button className="dropdown-item-btn" style={{ background: 'transparent', border: 'none', color: 'var(--danger)', padding: 8, textAlign: 'left', cursor: 'pointer', borderRadius: 4, fontSize: 12, borderTop: '1px solid var(--border-color)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => handleDeleteIssue(issue.id)}>
                                                            <span style={{width: 16}}>🗑️</span> Delete
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {filteredIssues.length === 0 && (
                                <tr><td colSpan="8" style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>No issues reported.</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Slide-out Drawer Panel */}
            {showHWFormModal && currentHWForm && (
                <div className="drawer-overlay" onClick={async (e) => { if (e.target.className === 'drawer-overlay') setShowHWFormModal(false); }}>
                    <div className="drawer-panel">
                        <div className="drawer-header">
                            <h2 style={{ color: 'var(--accent-primary)', margin: 0, fontSize: 20 }}>
                                {isHWFormReadOnly ? 'Issue Details' : currentHWForm.id ? 'Edit Issue' : 'Report HW Issue'}
                            </h2>
                            <button className="btn btn-outline" style={{ border: 'none', padding: '4px 8px', fontSize: 18 }} onClick={() => setShowHWFormModal(false)}>✕</button>
                        </div>

                        <form onSubmit={handleSaveIssue} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                            <div className="drawer-body">
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                                    <div className="form-group">
                                        <label style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>Date</label>
                                        <input type="date" value={currentHWForm.date} onChange={e => setCurrentHWForm({ ...currentHWForm, date: e.target.value })} disabled={isHWFormReadOnly || role === 'Viewer'} required style={{ width: '100%', padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6 }} />
                                    </div>
                                    <div className="form-group">
                                        <label style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>Reporter</label>
                                        <input type="text" value={currentHWForm.reporter} onChange={e => setCurrentHWForm({ ...currentHWForm, reporter: e.target.value })} disabled={isHWFormReadOnly || role === 'Viewer'} required style={{ width: '100%', padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6 }} />
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }}>
                                    <div className="form-group">
                                        <label style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>Datacenter</label>
                                        {isHWFormReadOnly ? (
                                            <div style={{ width: '100%', padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6 }}>{currentHWForm.datacenter || 'N/A'}</div>
                                        ) : (
                                            <select value={currentHWForm.datacenter} onChange={e => handleDCChange(e.target.value)} required style={{ width: '100%', padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6 }}>
                                                <option value="">Select DC</option>
                                                {dcs.map(dc => <option key={dc.id} value={dc.name}>{dc.name}</option>)}
                                                {currentHWForm.datacenter && !dcs.find(d => d.name === currentHWForm.datacenter) && <option value={currentHWForm.datacenter}>{currentHWForm.datacenter} (Legacy)</option>}
                                            </select>
                                        )}
                                    </div>
                                    
                                    <div className="form-group">
                                        <label style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>Device</label>
                                        {isHWFormReadOnly ? (
                                            <div style={{ width: '100%', padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6 }}>{currentHWForm.deviceName || 'N/A'}</div>
                                        ) : (
                                            <select value={availableDevices.find(d => d.hostname === currentHWForm.deviceName)?.id || currentHWForm.deviceName} onChange={e => handleDeviceChange(e.target.value)} required style={{ width: '100%', padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6 }}>
                                                <option value="">Select Device</option>
                                                {availableDevices.map(d => <option key={d.id} value={d.id}>{d.hostname} {d.sn ? `(${d.sn})` : ''}</option>)}
                                                {currentHWForm.deviceName && !availableDevices.find(d => d.hostname === currentHWForm.deviceName) && <option value={currentHWForm.deviceName}>{currentHWForm.deviceName} (Manual/Legacy)</option>}
                                            </select>
                                        )}
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }}>
                                    <div className="form-group">
                                        <label style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>Location</label>
                                        <input type="text" value={currentHWForm.rackLoc} onChange={e => setCurrentHWForm({ ...currentHWForm, rackLoc: e.target.value })} disabled={isHWFormReadOnly || role === 'Viewer'} placeholder="e.g. Rack A - U10" required style={{ width: '100%', padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6 }} />
                                    </div>
                                    <div className="form-group">
                                        <label style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>Failed Parts</label>
                                        <input type="text" value={currentHWForm.failedParts} onChange={e => setCurrentHWForm({ ...currentHWForm, failedParts: e.target.value })} disabled={isHWFormReadOnly || role === 'Viewer'} required style={{ width: '100%', padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6 }} />
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
                                    <div className="form-group">
                                        <label style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>Urgency</label>
                                        <select value={currentHWForm.urgency} onChange={e => setCurrentHWForm({ ...currentHWForm, urgency: e.target.value })} disabled={isHWFormReadOnly || role === 'Viewer'} style={{ width: '100%', padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', color: currentHWForm.urgency === 'H' ? 'var(--danger)' : currentHWForm.urgency === 'M' ? '#f59e0b' : 'var(--success)', borderRadius: 6 }}>
                                            <option value="H" style={{ color: 'var(--danger)' }}>High</option>
                                            <option value="M" style={{ color: 'var(--text-primary)' }}>Medium</option>
                                            <option value="L" style={{ color: 'var(--success)' }}>Low</option>
                                        </select>
                                    </div>
                                    <div className="form-group">
                                        <label style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>Status</label>
                                        <select value={currentHWForm.status} onChange={e => setCurrentHWForm({ ...currentHWForm, status: e.target.value })} disabled={isHWFormReadOnly || role === 'Viewer' || currentHWForm.id} style={{ width: '100%', padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6 }}>
                                            <option value="Open">Open</option>
                                            <option value="Processing">Processing</option>
                                            <option value="Closed">Closed</option>
                                        </select>
                                    </div>
                                </div>

                                {/* Spare Parts Integration Option */}
                                {!isHWFormReadOnly && role !== 'Viewer' && (
                                    <div style={{ background: 'rgba(59,130,246,0.05)', padding: 16, borderRadius: 8, marginBottom: 24, border: '1px solid rgba(59,130,246,0.2)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: useSparePart ? 12 : 0 }}>
                                            <input type="checkbox" id="useSparePart" checked={useSparePart} onChange={e => setUseSparePart(e.target.checked)} style={{ cursor: 'pointer' }} />
                                            <label htmlFor="useSparePart" style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent-primary)', margin: 0, cursor: 'pointer' }}>🛠️ Use Spare Part for Repair (Auto Deduct Inventory)</label>
                                        </div>
                                        {useSparePart && (
                                            <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                                                <div style={{ flex: 1 }}>
                                                    <label style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>Select Spare Part</label>
                                                    <select value={selectedSparePartId} onChange={e => { setSelectedSparePartId(e.target.value); setSparePartUsageId(e.target.value ? newUsageId() : ''); }} required={useSparePart} style={{ width: '100%', padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)' }}>
                                                        <option value="">-- Choose Part --</option>
                                                        {(sparePartsData.items || []).map(item => (
                                                            <option key={item.id} value={item.id} disabled={!(item.quantity > 0)}>
                                                                {item.name} ({item.category}) - Stock: {item.quantity ?? 0}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div style={{ width: '80px' }}>
                                                    <label style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>Qty</label>
                                                    <input type="number" min="1" value={sparePartQty} onChange={e => setSparePartQty(parseInt(e.target.value) || 1)} required={useSparePart} style={{ width: '100%', padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)' }} />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Process Timeline Integration in Drawer */}
                                <div className="form-group" style={{ marginBottom: 24 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                                        <label style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Process Timeline</label>
                                    </div>
                                    
                                    {!isHWFormReadOnly && role !== 'Viewer' && currentHWForm.id && (
                                        <div style={{ background: 'rgba(0,0,0,0.2)', padding: 16, borderRadius: 8, marginBottom: 16, border: '1px solid rgba(255,255,255,0.05)' }}>
                                            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                                                <select value={processType} onChange={e => setProcessType(e.target.value)} style={{ padding: 8, borderRadius: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', width: 120 }}>
                                                    <option value="Note">📝 Note</option>
                                                    <option value="Processing">⚙️ Process</option>
                                                    <option value="Closed">✅ Close</option>
                                                </select>
                                                <input 
                                                    type="text" 
                                                    value={processNote} 
                                                    onChange={e => setProcessNote(e.target.value)} 
                                                    placeholder="Add an update note..." 
                                                    style={{ flex: 1, padding: 8, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }}
                                                />
                                            </div>
                                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                                <button type="button" className="btn btn-primary" style={{ padding: '6px 12px', fontSize: 12 }} onClick={handleUpdateProcessStatus} disabled={!processNote.trim()}>Add Update</button>
                                            </div>
                                        </div>
                                    )}

                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                        {(currentHWForm.processNotes || []).length === 0 ? (
                                            <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '20px 0' }}>No process notes yet.</div>
                                        ) : (
                                            (currentHWForm.processNotes || []).map((note, idx) => (
                                                <div key={idx} style={{ display: 'flex', gap: 12 }}>
                                                    <div style={{ width: 2, background: 'var(--border-color)', position: 'relative', marginTop: 8 }}>
                                                        <div style={{ position: 'absolute', top: 0, left: -4, width: 10, height: 10, borderRadius: '50%', background: note.status === 'Closed' ? 'var(--success)' : note.status === 'Processing' ? '#3b82f6' : 'var(--accent-primary)' }}></div>
                                                    </div>
                                                    <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', padding: 12, borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)' }}>
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                                            <span style={{ fontSize: 12, fontWeight: 700, color: note.status === 'Closed' ? 'var(--success)' : note.status === 'Processing' ? '#3b82f6' : 'var(--text-primary)' }}>{note.status}</span>
                                                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{note.timestamp}</span>
                                                        </div>
                                                        <div style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{note.note}</div>
                                                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 8 }}>By: {note.user || 'Unknown'}</div>
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="drawer-footer">
                                {!isHWFormReadOnly && role !== 'Viewer' && currentHWForm.id && (
                                    <button type="button" className="btn btn-outline" style={{ color: 'var(--danger)', borderColor: 'var(--danger)', marginRight: 'auto' }} onClick={() => handleDeleteIssue(currentHWForm.id)}>Delete</button>
                                )}
                                {isHWFormReadOnly || role === 'Viewer' ? (
                                    <button type="button" className="btn btn-primary" onClick={() => setShowHWFormModal(false)}>Close</button>
                                ) : (
                                    <>
                                        <button type="button" className="btn btn-outline" onClick={() => setShowHWFormModal(false)}>Cancel</button>
                                        <button type="submit" className="btn btn-primary">{currentHWForm.id ? 'Save Changes' : 'Create Issue'}</button>
                                    </>
                                )}
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
