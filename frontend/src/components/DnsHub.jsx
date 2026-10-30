import React, { useState, useEffect } from 'react';
import { useSync } from '../contexts/WebSocketContext';
import { useToast } from '../contexts/ToastContext';
import api from '../api';
import * as XLSX from 'xlsx';

const ADServerList = () => {
    const { showToast } = useToast();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const [servers, setServers] = useState([]);
    const [showModal, setShowModal] = useState(false);
    const [errorModalLog, setErrorModalLog] = useState(null);
    const [viewDomainsServer, setViewDomainsServer] = useState(null);
    const [domainSearchText, setDomainSearchText] = useState('');
    const [formData, setFormData] = useState({ name: '', hostname: '' });
    const [loading, setLoading] = useState(false);
    const [actionLog, setActionLog] = useState('');
    const [confirmModal, setConfirmModal] = useState({ show: false, message: '', action: null });
    const [openDropdownId, setOpenDropdownId] = useState(null);
    const [openExportDropdown, setOpenExportDropdown] = useState(false);
    const [showScheduleModal, setShowScheduleModal] = useState(false);
    const [scheduleData, setScheduleData] = useState({
        enabled: false,
        frequency: 'daily',
        time: '00:00',
        dayOfWeek: 0,
        customCron: '',
        exportPath: 'C:\\DNS_Exports',
        targetServerId: 'ALL'
    });

    const fetchServers = async (force = false) => {
        try {
            const res = await api.get('/servers');
            const initialServers = res.data.map(s => ({
                ...s,
                status: s.disabled ? 'disabled' : 'checking'
            }));
            setServers(initialServers);

            initialServers.forEach(async (s) => {
                if (s.disabled) return;
                try {
                    const statusRes = await api.get(`/servers/${s.id}/status${force ? '?force=true' : ''}`);
                    setServers(prev => prev.map(server =>
                        server.id === s.id ? { ...server, status: statusRes.data.status } : server
                    ));
                } catch (err) {
                    setServers(prev => prev.map(server =>
                        server.id === s.id ? { ...server, status: 'offline' } : server
                    ));
                }
            });
        } catch (err) {
            console.error('Failed to fetch servers', err);
        }
    };

    const handleToggle = async (id) => {
        try {
            const res = await api.post(`/servers/${id}/toggle`);
            setActionLog(`✓ Server "${res.data.name}" ${res.data.disabled ? 'disabled' : 'enabled'} successfully.`);
            fetchServers();
        } catch (err) {
            setActionLog(`❌ Failed to toggle server status.`);
        }
    };

    useEffect(() => {
        fetchServers();
        fetchSchedule();

        const handleClickOutside = (e) => {
            if (!e.target.closest('.action-dropdown-container')) {
                setOpenDropdownId(null);
                setOpenExportDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const fetchSchedule = async () => {
        try {
            const res = await api.get('/records/schedule');
            setScheduleData(prev => ({ ...prev, ...res.data }));
        } catch (err) {
            console.error('Failed to fetch schedule', err);
        }
    };

    const handleSaveSchedule = async () => {
        try {
            await api.post('/records/schedule', scheduleData);
            setShowScheduleModal(false);
            setActionLog('✓ Export schedule saved successfully.');
        } catch (err) {
            showToast('Failed to save schedule', "error");
        }
    };

    const handleAdd = async (e) => {
        e.preventDefault();
        try {
            await api.post('/servers', formData);
            setShowModal(false);
            setFormData({ name: '', hostname: '' });
            fetchServers();
        } catch (err) {
            showToast('Error adding server', "error");
        }
    };

    const promptConfirm = (message, action) => {
        setConfirmModal({ show: true, message, action });
    };

    const executeConfirm = () => {
        if (confirmModal.action) confirmModal.action();
        setConfirmModal({ show: false, message: '', action: null });
    };

    const handleDelete = async (id) => {
        promptConfirm('Are you sure you want to delete this server?', async () => {
            try {
                await api.delete(`/servers/${id}`);
                fetchServers();
            } catch (err) {
                showToast('Error deleting server', "error");
            }
        });
    };

    const handleRestart = async (id, name) => {
        promptConfirm(`Restart DNS Service on ${name}?`, async () => {
            setLoading(true);
            setActionLog(`Restarting DNS on ${name}...`);
            try {
                await api.post(`/servers/${id}/restart`);
                setActionLog(`✓ Restarted DNS on ${name} successfully.`);
            } catch (err) {
                setActionLog(`❌ Failed to restart DNS on ${name}.`);
            }
            setLoading(false);
        });
    };

    const handleSyncAD = async (id, name) => {
        promptConfirm(`Force AD Sync on ${name} using repadmin?`, async () => {
            setLoading(true);
            setActionLog(`Executing AD Sync on ${name}...`);
            try {
                const res = await api.post(`/servers/${id}/sync-ad`);
                setActionLog(`✓ AD Sync on ${name} completed.`);
                console.log(res.data.log);
            } catch (err) {
                setActionLog(`❌ Failed to sync AD on ${name}.`);
            }
            setLoading(false);
        });
    };

    const handleCacheUpdate = async (id, name) => {
        setLoading(true);
        setActionLog(`Updating domain cache for ${name}...`);
        try {
            const res = await api.post(`/servers/${id}/cache-update`);
            setActionLog(`✓ Cache updated for ${name}. Found ${res.data.domains?.length || 0} domains.`);
            fetchServers();
        } catch (err) {
            setActionLog(`❌ Failed to update cache for ${name}.`);
        }
        setLoading(false);
    };

    const handleExportDomains = () => {
        setLoading(true);
        setActionLog('Exporting domain zones list...');
        try {
            let csv = "Server Name,Hostname,Domain Zone\n";
            servers.forEach(s => {
                if (s.cachedDomains) {
                    s.cachedDomains.forEach(d => {
                        csv += `"${s.name}","${s.hostname}","${d}"\n`;
                    });
                }
            });
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `dns_zones_list_${new Date().toISOString().split('T')[0]}.csv`;
            a.click();
            setActionLog('✓ Zones export complete.');
        } catch (err) {
            setActionLog('❌ Export failed.');
        }
        setLoading(false);
    };

    const handleExportAllRecords = async () => {
        setLoading(true);
        setActionLog('Fetching all DNS records from all servers. This may take a moment...');
        try {
            const res = await api.get('/records/export-all');
            downloadCsv(res.data.records, `dns_all_records_${new Date().toISOString().split('T')[0]}`);
            setActionLog('✓ Detailed global export complete.');
        } catch (err) {
            setActionLog('❌ Export failed.');
        }
        setLoading(false);
    };

    const handleExportServer = async (id, name) => {
        setLoading(true);
        setActionLog(`Fetching records for ${name}...`);
        try {
            const res = await api.get(`/records/export-server/${id}`);
            downloadCsv(res.data.records, `dns_records_${name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}`);
            setActionLog(`✓ Export for ${name} complete.`);
        } catch (err) {
            setActionLog('❌ Export failed.');
        }
        setLoading(false);
    };

    const downloadCsv = (records, filename) => {
        let csv = "Server,Zone,HostName,Type,Data\n";
        records.forEach(r => {
            csv += `"${r.server}","${r.zone}","${r.host}","${r.type}","${r.data}"\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${filename}.csv`;
        a.click();
    };

    return (
        <div>
            <div className="flex justify-between items-center mb-4">
                <h3>Managed DNS Servers</h3>
                <div className="flex gap-2">
                    <button className="btn btn-outline" onClick={() => fetchServers(true)}>Refresh Status</button>
                    <div className="action-dropdown-container" style={{ position: 'relative', display: 'inline-block' }}>
                        <button className="btn btn-outline" onClick={() => setOpenExportDropdown(!openExportDropdown)}>📊 Export ▾</button>
                        <div className="action-dropdown-menu glass-panel" style={{
                            position: 'absolute',
                            right: 0,
                            top: '100%',
                            zIndex: 100,
                            display: openExportDropdown ? 'flex' : 'none',
                            flexDirection: 'column',
                            gap: '2px',
                            padding: '0.5rem',
                            minWidth: '200px',
                            boxShadow: '0 8px 16px rgba(0,0,0,0.4)',
                            border: '1px solid var(--accent-primary)',
                            textAlign: 'left'
                        }}>
                            <button className="dropdown-item-btn" style={{ background: 'transparent', border: 'none', color: '#fff', padding: '0.5rem', textAlign: 'left', cursor: 'pointer', borderRadius: '4px', fontSize: '0.85rem' }} onClick={() => { handleExportDomains(); setOpenExportDropdown(false); }}>
                                🌐 Export All Domains
                            </button>
                            <button className="dropdown-item-btn" style={{ background: 'transparent', border: 'none', color: '#fff', padding: '0.5rem', textAlign: 'left', cursor: 'pointer', borderRadius: '4px', fontSize: '0.85rem' }} onClick={() => { handleExportAllRecords(); setOpenExportDropdown(false); }}>
                                📄 Export All Records
                            </button>
                            {role !== 'Viewer' && (
                                <button className="dropdown-item-btn" style={{ background: 'transparent', border: 'none', color: 'var(--accent-primary)', padding: '0.5rem', textAlign: 'left', cursor: 'pointer', borderRadius: '4px', fontSize: '0.85rem', borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: '4px' }} onClick={() => { setShowScheduleModal(true); setOpenExportDropdown(false); }}>
                                    📅 Schedule Auto-Export
                                </button>
                            )}
                        </div>
                    </div>
                    {role === 'SuperAdmin' && (
                        <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ Add Server</button>
                    )}
                </div>
            </div>

            {actionLog && <div className="success-message">{actionLog}</div>}

            <div className="grid grid-cols-2">
                {servers.map(server => (
                    <div key={server.id} className="glass-panel server-card" style={
                        server.disabled ? { opacity: 0.7, borderColor: 'rgba(255, 255, 255, 0.1)' } :
                            server.status === 'offline' ? { borderColor: 'rgba(239, 68, 68, 0.5)' } : {}
                    }>
                        <div className="server-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <h4 style={server.disabled ? { color: 'var(--text-muted)' } : {}}>{server.name}</h4>
                                <div className="text-secondary">{server.hostname}</div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span className={`badge ${server.disabled ? 'badge-secondary' :
                                        server.status === 'online' ? 'badge-success' :
                                            server.status === 'checking' ? 'badge-warning' : 'badge-danger'
                                    }`}>
                                    {(server.disabled ? 'disabled' : (server.status || 'unknown')).toUpperCase()}
                                </span>
                                {role !== 'Viewer' && (
                                    <div
                                        onClick={() => handleToggle(server.id)}
                                        title={server.disabled ? 'Enable Server' : 'Disable Server'}
                                        style={{
                                            width: '42px',
                                            height: '22px',
                                            borderRadius: '11px',
                                            background: server.disabled ? 'rgba(255,255,255,0.1)' : '#10b981',
                                            position: 'relative',
                                            cursor: 'pointer',
                                            transition: 'background 0.2s',
                                            border: '1px solid rgba(255,255,255,0.15)',
                                            display: 'inline-block'
                                        }}
                                    >
                                        <div
                                            style={{
                                                width: '16px',
                                                height: '16px',
                                                borderRadius: '50%',
                                                background: '#fff',
                                                position: 'absolute',
                                                top: '2px',
                                                left: server.disabled ? '2px' : '22px',
                                                transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                                                boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
                                            }}
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="server-card-body">
                            <div className="mb-2">
                                <span>Cached Domains: {server.cachedDomains?.length || 0}</span>
                                {server.cachedDomains && server.cachedDomains.length > 0 && (
                                    <button
                                        className="btn btn-outline btn-sm ml-2"
                                        style={{ padding: '0.1rem 0.5rem', fontSize: '0.75rem' }}
                                        onClick={() => setViewDomainsServer(server)}>
                                        View List
                                    </button>
                                )}
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
                                <div style={{ fontSize: '0.85rem', color: '#888' }}>
                                    Last Cache Update: {server.lastCacheUpdate ? new Date(server.lastCacheUpdate).toLocaleString() : 'Never'}
                                </div>
                                <div className="action-dropdown-container" style={{ position: 'relative', display: 'inline-block' }}>
                                    <button className="btn btn-outline btn-sm" style={{ padding: '0.2rem 0.8rem', fontSize: '0.75rem' }} onClick={() => setOpenDropdownId(openDropdownId === server.id ? null : server.id)}>Actions ▾</button>
                                    <div className="action-dropdown-menu glass-panel" style={{
                                        position: 'absolute',
                                        right: 0,
                                        top: '100%',
                                        zIndex: 1000,
                                        display: openDropdownId === server.id ? 'flex' : 'none',
                                        flexDirection: 'column',
                                        gap: '2px',
                                        padding: '0.5rem',
                                        minWidth: '160px',
                                        boxShadow: '0 8px 16px rgba(0,0,0,0.4)',
                                        border: '1px solid var(--accent-primary)',
                                        textAlign: 'left',
                                        marginTop: '5px'
                                    }}>
                                        {role !== 'Viewer' && (
                                            <>
                                                <button
                                                    className="dropdown-item-btn"
                                                    disabled={server.disabled}
                                                    style={{ background: 'transparent', border: 'none', color: server.disabled ? '#555' : '#fff', padding: '0.5rem', textAlign: 'left', cursor: server.disabled ? 'not-allowed' : 'pointer', borderRadius: '4px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '8px' }}
                                                    onClick={() => { if (!server.disabled) { handleCacheUpdate(server.id, server.name); setOpenDropdownId(null); } }}
                                                >
                                                    <span>🔄</span> Update Domains
                                                </button>
                                                <button
                                                    className="dropdown-item-btn"
                                                    disabled={server.disabled}
                                                    style={{ background: 'transparent', border: 'none', color: server.disabled ? '#555' : '#3b82f6', padding: '0.5rem', textAlign: 'left', cursor: server.disabled ? 'not-allowed' : 'pointer', borderRadius: '4px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '8px' }}
                                                    onClick={() => { if (!server.disabled) { handleSyncAD(server.id, server.name); setOpenDropdownId(null); } }}
                                                >
                                                    <span>⛓️</span> Force AD Sync
                                                </button>
                                                <button
                                                    className="dropdown-item-btn"
                                                    disabled={server.disabled}
                                                    style={{ background: 'transparent', border: 'none', color: server.disabled ? '#555' : '#f59e0b', padding: '0.5rem', textAlign: 'left', cursor: server.disabled ? 'not-allowed' : 'pointer', borderRadius: '4px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '8px' }}
                                                    onClick={() => { if (!server.disabled) { handleRestart(server.id, server.name); setOpenDropdownId(null); } }}
                                                >
                                                    <span>⚡</span> Restart DNS
                                                </button>
                                            </>
                                        )}
                                        <button
                                            className="dropdown-item-btn"
                                            disabled={server.disabled}
                                            style={{ background: 'transparent', border: 'none', color: server.disabled ? '#555' : 'var(--accent-primary)', padding: '0.5rem', textAlign: 'left', cursor: server.disabled ? 'not-allowed' : 'pointer', borderRadius: '4px', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '8px', borderTop: role !== 'Viewer' ? '1px solid rgba(255,255,255,0.1)' : 'none', marginTop: role !== 'Viewer' ? '4px' : '0' }}
                                            onClick={() => { if (!server.disabled) { handleExportServer(server.id, server.name); setOpenDropdownId(null); } }}
                                        >
                                            <span>📥</span> Export Records
                                        </button>
                                        {role !== 'Viewer' && (
                                            <button className="dropdown-item-btn" style={{ background: 'transparent', border: 'none', color: '#ef4444', padding: '0.5rem', textAlign: 'left', cursor: 'pointer', borderRadius: '4px', fontSize: '0.8rem', borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: '4px' }} onClick={() => { handleDelete(server.id); setOpenDropdownId(null); }}>
                                                <span>🗑️</span> Remove Server
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                            {server.lastError && (
                                <div className="mt-2">
                                    <span className="text-danger" style={{ cursor: 'pointer', textDecoration: 'underline', fontSize: '0.85rem' }} onClick={() => setErrorModalLog(server.lastError)}>
                                        ⚠️ View Last Error Log
                                    </span>
                                </div>
                            )}
                        </div>
                    </div>
                ))}
                {servers.length === 0 && <p className="text-secondary">No servers configured yet.</p>}
            </div>

            {showModal && (
                <div className="modal-overlay">
                    <div className="glass-panel modal-content" style={{ maxWidth: '500px', width: '95%', padding: '2rem', height: 'auto' }}>
                        <button className="modal-close" onClick={() => setShowModal(false)}>&times;</button>
                        <h3 className="mb-4">Add Windows DNS Server</h3>
                        <form onSubmit={handleAdd} className="flex-col gap-4">
                            <div>
                                <label>Friendly Name</label>
                                <input required value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="e.g. Primary DC" />
                            </div>
                            <div>
                                <label>Hostname or IP (must be reachable)</label>
                                <input required value={formData.hostname} onChange={e => setFormData({ ...formData, hostname: e.target.value })} placeholder="e.g. 192.168.1.10" />
                            </div>
                            <button type="submit" className="btn btn-primary mt-4">Save Server</button>
                        </form>
                    </div>
                </div>
            )}

            {errorModalLog && (
                <div className="modal-overlay">
                    <div className="glass-panel modal-content" style={{ maxWidth: '800px' }}>
                        <button className="modal-close" onClick={() => setErrorModalLog(null)}>&times;</button>
                        <h3 className="mb-4" style={{ color: 'var(--danger)' }}>PowerShell Error Log</h3>
                        <pre style={{
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                            backgroundColor: 'rgba(0,0,0,0.5)',
                            padding: '1rem',
                            borderRadius: '8px',
                            maxHeight: '400px',
                            overflowY: 'auto',
                            fontSize: '0.85rem',
                            color: '#f87171'
                        }}>
                            {errorModalLog}
                        </pre>
                    </div>
                </div>
            )}

            {showScheduleModal && (
                <div className="modal-overlay">
                    <div className="glass-panel modal-content" style={{ maxWidth: '600px', width: '95%', padding: '2rem', height: 'auto' }}>
                        <button className="modal-close" onClick={() => setShowScheduleModal(false)}>&times;</button>
                        <h2 className="mb-4" style={{ color: 'var(--accent-primary)' }}>📅 DNS Export Scheduler</h2>

                        <div className="flex items-center gap-2 mb-6 p-3" style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                            <input
                                type="checkbox"
                                id="schedEnabled"
                                checked={scheduleData.enabled}
                                onChange={e => setScheduleData({ ...scheduleData, enabled: e.target.checked })}
                                style={{ width: '20px', height: '20px' }}
                            />
                            <label htmlFor="schedEnabled" style={{ fontWeight: 'bold' }}>Enable Automated Background Export</label>
                        </div>

                        <div className="grid grid-cols-2 gap-4 mb-4">
                            <div className="form-group">
                                <label>Frequency</label>
                                <select
                                    className="form-control"
                                    value={scheduleData.frequency}
                                    onChange={e => setScheduleData({ ...scheduleData, frequency: e.target.value })}
                                >
                                    <option value="daily">Daily</option>
                                    <option value="weekly">Weekly</option>
                                    <option value="custom">Customize (Cron)</option>
                                </select>
                            </div>

                            {scheduleData.frequency === 'daily' && (
                                <div className="form-group">
                                    <label>Execution Time</label>
                                    <input type="time" className="form-control" value={scheduleData.time} onChange={e => setScheduleData({ ...scheduleData, time: e.target.value })} />
                                </div>
                            )}

                            {scheduleData.frequency === 'weekly' && (
                                <>
                                    <div className="form-group">
                                        <label>Day of Week</label>
                                        <select className="form-control" value={scheduleData.dayOfWeek} onChange={e => setScheduleData({ ...scheduleData, dayOfWeek: parseInt(e.target.value) })}>
                                            <option value={0}>Sunday</option>
                                            <option value={1}>Monday</option>
                                            <option value={2}>Tuesday</option>
                                            <option value={3}>Wednesday</option>
                                            <option value={4}>Thursday</option>
                                            <option value={5}>Friday</option>
                                            <option value={6}>Saturday</option>
                                        </select>
                                    </div>
                                    <div className="form-group">
                                        <label>Time</label>
                                        <input type="time" className="form-control" value={scheduleData.time} onChange={e => setScheduleData({ ...scheduleData, time: e.target.value })} />
                                    </div>
                                </>
                            )}

                            {scheduleData.frequency === 'custom' && (
                                <div className="form-group span-2">
                                    <label>Cron Expression (e.g. 0 0 * * 1-5)</label>
                                    <input type="text" className="form-control" value={scheduleData.customCron} onChange={e => setScheduleData({ ...scheduleData, customCron: e.target.value })} placeholder="mm HH DD MM DW" />
                                </div>
                            )}
                        </div>

                        <div className="form-group mb-4">
                            <label>Export Path (Server Local Path)</label>
                            <input type="text" className="form-control" value={scheduleData.exportPath} onChange={e => setScheduleData({ ...scheduleData, exportPath: e.target.value })} placeholder="e.g. C:\DNS_Exports" />
                        </div>

                        <div className="form-group mb-6">
                            <label>Target AD Server</label>
                            <select className="form-control" value={scheduleData.targetServerId} onChange={e => setScheduleData({ ...scheduleData, targetServerId: e.target.value })}>
                                <option value="ALL">All Domain Controllers</option>
                                {servers.map(s => <option key={s.id} value={s.id}>{s.name} ({s.hostname})</option>)}
                            </select>
                        </div>


                        <div className="flex justify-end gap-2 mt-4">
                            <button className="btn btn-outline" onClick={() => setShowScheduleModal(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleSaveSchedule}>💾 Save Configuration</button>
                        </div>
                    </div>
                </div>
            )}

            {confirmModal.show && (
                <div className="modal-overlay">
                    <div className="glass-panel modal-content" style={{ maxWidth: '400px', width: '95%', padding: '2rem', height: 'auto', textAlign: 'center' }}>
                        <h3 className="mb-4">Confirmation</h3>
                        <p className="mb-6">{confirmModal.message}</p>
                        <div className="flex justify-center gap-4">
                            <button className="btn btn-outline" onClick={() => setConfirmModal({ show: false, message: '', action: null })}>Cancel</button>
                            <button className="btn btn-primary" onClick={executeConfirm}>Confirm</button>
                        </div>
                    </div>
                </div>
            )}

            {viewDomainsServer && (
                <div className="modal-overlay">
                    <div className="glass-panel modal-content" style={{ maxWidth: '600px', width: '95%', padding: '2rem', height: 'auto' }}>
                        <button className="modal-close" onClick={() => { setViewDomainsServer(null); setDomainSearchText(''); }}>&times;</button>
                        <h3 className="mb-2">Domain Zones</h3>
                        <div className="text-secondary mb-4">{viewDomainsServer.name} ({viewDomainsServer.hostname})</div>

                        <input
                            type="text"
                            placeholder="Search domains..."
                            value={domainSearchText}
                            onChange={e => setDomainSearchText(e.target.value)}
                            style={{ marginBottom: '1.5rem' }}
                        />

                        <div style={{ maxHeight: '400px', overflowY: 'auto', background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.1)' }} className="custom-scrollbar">
                            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                                {(viewDomainsServer.cachedDomains || [])
                                    .filter(d => d.toLowerCase().includes(domainSearchText.toLowerCase()))
                                    .map((domain, index) => (
                                        <li key={index} style={{ padding: '0.6rem 0', borderBottom: '1px solid rgba(255,255,255,0.05)', fontFamily: 'monospace', fontSize: '0.9rem' }}>
                                            🌐 {domain}
                                        </li>
                                    ))}
                                {(viewDomainsServer.cachedDomains || [])
                                    .filter(d => d.toLowerCase().includes(domainSearchText.toLowerCase())).length === 0 && (
                                        <li style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                                            No domains found.
                                        </li>
                                    )}
                            </ul>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

const RecordManager = () => {
    const { showToast } = useToast();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const [inputText, setInputText] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [openImportDropdown, setOpenImportDropdown] = useState(false);

    const [showConfirm, setShowConfirm] = useState(false);
    const [deleteLines, setDeleteLines] = useState([]);
    const [validationError, setValidationError] = useState('');
    const [cachedZones, setCachedZones] = useState([]);

    const [showPreviewModal, setShowPreviewModal] = useState(false);
    const [previewRecords, setPreviewRecords] = useState([]);
    const [importLoading, setImportLoading] = useState(false);
    const fileInputRef = React.useRef(null);

    const [showHistoryModal, setShowHistoryModal] = useState(false);
    const [historyFqdn, setHistoryFqdn] = useState('');
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [historyLogs, setHistoryLogs] = useState([]);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (!e.target.closest('.action-dropdown-container')) {
                setOpenImportDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);

        const loadZones = async () => {
            try {
                const res = await api.get('/servers');
                const zones = res.data.flatMap(s => s.cachedDomains || []);
                setCachedZones(zones);
            } catch (e) {
                console.error('Failed to load zones for validation', e);
            }
        };
        loadZones();

        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleDownloadTemplateCSV = () => {
        const content = "FQDN,IP\ntest.domain.local,192.168.1.100\n";
        const blob = new Blob([content], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = window.URL.createObjectURL(blob);
        a.download = 'dns_import_template.csv';
        a.click();
    };

    const handleDownloadTemplateExcel = () => {
        const ws = XLSX.utils.json_to_sheet([{ FQDN: 'test.domain.local', IP: '192.168.1.100' }]);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Records");
        XLSX.writeFile(wb, "dns_import_template.xlsx");
    };

    const handleFileUpload = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (evt) => {
            try {
                let parsedRecords = [];
                if (file.name.endsWith('.csv')) {
                    const text = evt.target.result;
                    const lines = text.split('\n');
                    for (let i = 1; i < lines.length; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;
                        const parts = line.split(',');
                        parsedRecords.push({ fqdn: parts[0]?.trim(), ip: parts[1]?.trim() });
                    }
                } else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
                    const data = new Uint8Array(evt.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    const sheetName = workbook.SheetNames[0];
                    const sheet = workbook.Sheets[sheetName];
                    const json = XLSX.utils.sheet_to_json(sheet);
                    parsedRecords = json.map(r => ({ fqdn: r.FQDN?.trim() || r.fqdn?.trim(), ip: r.IP?.trim() || r.ip?.trim() }));
                }

                if (parsedRecords.length === 0) {
                    showToast('No valid records found in file.', "error");
                    return;
                }

                setImportLoading(true);
                const res = await api.post('/records/preview', { records: parsedRecords });
                setPreviewRecords(res.data.results || []);
                setShowPreviewModal(true);
            } catch (err) {
                console.error(err);
                showToast('Error parsing file.', "error");
            } finally {
                setImportLoading(false);
                if (fileInputRef.current) fileInputRef.current.value = '';
            }
        };
        if (file.name.endsWith('.csv')) reader.readAsText(file);
        else reader.readAsArrayBuffer(file);
    };

    const handleConfirmImport = () => {
        const validRecords = previewRecords.filter(r => r.status === 'Ready');
        if (validRecords.length === 0) {
            showToast('No valid records to import.', "error");
            return;
        }
        const textLines = validRecords.map(r => `${r.fqdn}\t${r.ip}`);
        setShowPreviewModal(false);
        handleAction('add', textLines);
    };

    const handleViewHistory = async (fqdn) => {
        setHistoryFqdn(fqdn);
        setShowHistoryModal(true);
        setLoadingHistory(true);
        try {
            const res = await api.get('/records/logs');
            const allLogs = res.data || [];
            const filtered = allLogs.filter(l => l.action && l.action.includes(fqdn));
            setHistoryLogs(filtered);
        } catch (e) {
            console.error(e);
        }
        setLoadingHistory(false);
    };

    // Universal DNS Record Line Parser for flexible separators (Tab, Space, -, /, ,, ;, |, :, =, ->)
    const parseDnsRecordLine = (rawLine) => {
        if (!rawLine || !rawLine.trim()) return null;
        const line = rawLine.trim();
        const ipRegex = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/;
        const ipMatch = line.match(ipRegex);

        if (ipMatch) {
            const ip = ipMatch[0];
            let remaining = line.replace(ip, '').trim();
            remaining = remaining.replace(/^[\s\t\/,;:|=><]+|[\s\t\/,;:|=><]+$/g, '').trim();
            remaining = remaining.replace(/^-\s*|\s*-$/g, '').trim();
            if (remaining) {
                return { fqdn: remaining, ip };
            }
        }

        const delimiterRegex = /[\t,;|/=]+|\s+[-/|:=,>]+\s*|\s+/;
        const parts = line.split(delimiterRegex).filter(p => p.trim().length > 0);
        if (parts.length >= 2 && (ipRegex.test(parts[0]) || ipRegex.test(parts[1]))) {
            let fqdn = parts[0].trim();
            let ip = parts[1].trim();
            if (ipRegex.test(fqdn) && !ipRegex.test(ip)) {
                const temp = fqdn;
                fqdn = ip;
                ip = temp;
            }
            return { fqdn, ip };
        }

        return { fqdn: line.replace(/^[\s\t\/,;:|=><]+|[\s\t\/,;:|=><]+$/g, '').replace(/^-\s*|\s*-$/g, '').trim(), ip: null };
    };

    const handleAction = async (endpoint, linesToProcess = null) => {
        setValidationError('');
        if (!linesToProcess && !inputText.trim()) {
            showToast('Please provide input records.', "error");
            return;
        }

        let lines = linesToProcess || inputText.split('\n').map(l => l.trim()).filter(l => l);

        if (endpoint === 'add') {
            for (let i = 0; i < lines.length; i++) {
                const parsed = parseDnsRecordLine(lines[i]);
                if (!parsed || !parsed.fqdn || !parsed.ip) {
                    setValidationError(`Line ${i + 1} is missing IP address or domain: "${lines[i]}" (Separators supported: Space, TAB, -, /, ,, |)`);
                    return;
                }
                const { fqdn, ip } = parsed;
                const fqdnRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
                const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
                if (!fqdnRegex.test(fqdn)) {
                    setValidationError(`Line ${i + 1} has invalid domain format: ${fqdn}`);
                    return;
                }
                if (!ipRegex.test(ip)) {
                    setValidationError(`Line ${i + 1} has invalid IPv4 format: ${ip}`);
                    return;
                }
            }
        }

        if (endpoint === 'query' || endpoint === 'delete') {
            lines = lines.map(l => {
                const parsed = parseDnsRecordLine(l);
                return parsed && parsed.fqdn ? parsed.fqdn : l.trim();
            });
        }

        if (endpoint === 'delete') {
            for (let i = 0; i < lines.length; i++) {
                const fqdn = lines[i].toLowerCase();
                const matchedZone = cachedZones.find(z => z.toLowerCase() === fqdn);
                if (matchedZone) {
                    setValidationError(`Delete aborted: Line ${i + 1} (${lines[i]}) matches a registered DNS Zone root. You cannot delete a zone root record here.`);
                    showToast(`Cannot delete zone root record: ${lines[i]}`, "error");
                    return;
                }
            }
        }

        if (endpoint === 'delete' && !linesToProcess) {
            setDeleteLines(lines);
            setShowConfirm(true);
            return;
        }

        setLoading(true);
        setResults([]);
        try {
            const res = await api.post(`/records/${endpoint}`, {
                [endpoint === 'query' ? 'queries' : 'records']: lines
            });
            setResults(res.data.results || []);
            if (endpoint === 'delete') {
                setShowConfirm(false);
            }
        } catch (err) {
            console.error(err);
            showToast('Action failed.', "error");
        }
        setLoading(false);
    };

    return (
        <div className="grid grid-cols-2 gap-4 relative">
            <div className="glass-panel p-6">
                <h3 className="mb-2">Smart Record Input</h3>
                <p className="text-secondary text-sm mb-4">
                    The system will automatically dispatch the record to the correct Server based on cached DNS zones.<br /><br />
                    <strong>Add/Modify supported separators:</strong><br />
                    <code>record.domain.com 192.168.1.1</code> <em>(Space / Multiple spaces)</em><br />
                    <code>record.domain.com - 192.168.1.1</code> <em>(Hyphen / Dash)</em><br />
                    <code>record.domain.com / 192.168.1.1</code> <em>(Slash)</em><br />
                    <code>record.domain.com, 192.168.1.1</code> <em>(Comma / CSV)</em><br />
                    <code>record.domain.com[TAB]192.168.1.1</code> <em>(Tab)</em><br />
                    <code>192.168.1.1 record.domain.com</code> <em>(/etc/hosts format)</em><br /><br />
                    <strong>Delete/Query format:</strong> <code>record.domain.com</code> (IPs and separators will be auto-ignored)
                </p>
                <textarea
                    rows={10}
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder={"nas.abc.com\t192.168.0.111\ndb.abc.com - 192.168.0.222\nweb.abc.com / 192.168.0.333\napi.abc.com, 192.168.0.444\n192.168.0.555 app.abc.com"}
                    style={{ fontFamily: 'monospace', whiteSpace: 'pre', width: '100%', padding: '10px', borderRadius: '8px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-primary)' }}
                />
                {validationError && (
                    <div className="text-danger text-sm mt-2 font-bold">
                        ⚠️ {validationError}
                    </div>
                )}

                <div className="flex justify-between mt-4">
                    <div className="flex gap-2">
                        {role !== 'Viewer' ? (
                            <>
                                <button className="btn btn-outline" onClick={() => handleAction('query')} disabled={loading}>Query</button>
                                <button className="btn btn-primary" onClick={() => handleAction('add')} disabled={loading}>Add / Modify</button>
                                <button className="btn btn-danger" onClick={() => handleAction('delete')} disabled={loading}>Delete</button>
                            </>
                        ) : (
                            <p className="text-secondary text-sm">Viewer role cannot operate records.</p>
                        )}
                    </div>
                    {role === 'SuperAdmin' && (
                        <div className="flex gap-2 items-center">
                            <input type="file" ref={fileInputRef} onChange={handleFileUpload} accept=".csv, .xlsx, .xls" style={{ display: 'none' }} />
                            <div className="action-dropdown-container" style={{ position: 'relative', display: 'inline-block' }}>
                                <button className="btn btn-outline" disabled={importLoading} onClick={() => setOpenImportDropdown(!openImportDropdown)}>
                                    {importLoading ? 'Processing...' : '📤 Batch Import ▾'}
                                </button>
                                <div className="action-dropdown-menu glass-panel" style={{
                                    position: 'absolute', right: 0, top: '100%', zIndex: 1000, display: openImportDropdown ? 'flex' : 'none', flexDirection: 'column', gap: '2px', padding: '0.5rem', minWidth: '180px', boxShadow: '0 8px 16px rgba(0,0,0,0.4)', border: '1px solid var(--accent-primary)', textAlign: 'left', marginTop: '5px'
                                }}>
                                    <button className="dropdown-item-btn" style={{ background: 'transparent', border: 'none', color: '#fff', padding: '0.5rem', textAlign: 'left', cursor: 'pointer', borderRadius: '4px', fontSize: '0.8rem' }} onClick={() => fileInputRef.current.click()}>📁 Upload File</button>
                                    <button className="dropdown-item-btn" style={{ background: 'transparent', border: 'none', color: '#888', padding: '0.5rem', textAlign: 'left', cursor: 'pointer', borderRadius: '4px', fontSize: '0.8rem', borderTop: '1px solid rgba(255,255,255,0.1)' }} onClick={handleDownloadTemplateCSV}>📄 Download CSV Template</button>
                                    <button className="dropdown-item-btn" style={{ background: 'transparent', border: 'none', color: '#888', padding: '0.5rem', textAlign: 'left', cursor: 'pointer', borderRadius: '4px', fontSize: '0.8rem' }} onClick={handleDownloadTemplateExcel}>📊 Download Excel Template</button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <div className="glass-panel p-6">
                <h3 className="mb-4">Results Matrix</h3>
                {loading && <p className="text-secondary animate-pulse">Processing request...</p>}

                {!loading && results.length > 0 && (
                    <div style={{ overflowX: 'auto', maxHeight: '400px' }}>
                        <table className="w-full text-left">
                            <thead>
                                <tr>
                                    <th className="pb-2 text-secondary font-semibold">Server</th>
                                    <th className="pb-2 text-secondary font-semibold">Record</th>
                                    <th className="pb-2 text-secondary font-semibold">IP / Status</th>
                                    <th className="pb-2 text-secondary font-semibold">Last Update</th>
                                    <th className="pb-2 text-secondary font-semibold text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {results.map((r, i) => (
                                    <tr key={i} className="border-t border-white/5">
                                        <td className="py-2">{r.serverName}</td>
                                        <td className="py-2" style={{ fontWeight: 500 }}>{r.record}</td>
                                        <td className="py-2">
                                            <span className={r.status && r.status !== 'Success' && r.status !== 'Deleted' ? 'text-danger' :
                                                (r.ip && r.ip !== 'N/A' && r.ip !== 'Error') || r.status === 'Success' || r.status === 'Deleted' ? 'text-success' : ''}>
                                                {r.status || r.ip}
                                            </span>
                                        </td>
                                        <td className="py-2 text-secondary text-sm">{r.lastUpdate || '-'}</td>
                                        <td className="py-2 text-right">
                                            <button className="btn btn-outline btn-sm" onClick={() => handleViewHistory(r.record)}>History</button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {!loading && results.length === 0 && (
                    <div className="flex justify-center items-center h-full text-secondary">
                        <p>No results to display.</p>
                    </div>
                )}
            </div>

            {/* Delete Confirm Modal */}
            {showConfirm && (
                <div className="modal-overlay">
                    <div className="glass-panel modal-content" style={{ maxWidth: '500px', width: '95%', padding: '2rem', height: 'auto' }}>
                        <div className="flex items-center mb-4 text-danger">
                            <svg style={{ width: '24px', height: '24px', marginRight: '8px', flexShrink: 0 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                            <h3 className="text-xl font-bold">Confirm Deletion</h3>
                        </div>
                        <p className="mb-4 text-gray-300">You are about to permanently delete the following records from the DNS servers. This action cannot be undone.</p>
                        <div className="bg-black/30 p-3 rounded-lg max-h-48 overflow-y-auto mb-6">
                            <ul className="list-disc pl-5 text-red-400 space-y-1 font-mono text-sm">
                                {deleteLines.map((line, idx) => (
                                    <li key={idx}>{line}</li>
                                ))}
                            </ul>
                        </div>
                        <div className="flex justify-end gap-3">
                            <button
                                className="btn btn-outline"
                                onClick={() => setShowConfirm(false)}
                                disabled={loading}
                            >
                                Cancel
                            </button>
                            <button
                                className="btn btn-danger"
                                onClick={() => handleAction('delete', deleteLines)}
                                disabled={loading}
                            >
                                {loading ? 'Deleting...' : 'Confirm Delete'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Batch Import Preview Modal */}
            {showPreviewModal && (
                <div className="modal-overlay" style={{ zIndex: 3000 }}>
                    <div className="glass-panel modal-content" style={{ maxWidth: '800px', width: '95%', padding: '2rem', height: 'auto' }}>
                        <button className="modal-close" onClick={() => setShowPreviewModal(false)}>&times;</button>
                        <h3 className="mb-4">Batch Import Preview</h3>
                        <p className="text-secondary mb-4">Please verify the Target DNS Server for each record before confirming import.</p>
                        <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
                            <table className="w-full text-left">
                                <thead>
                                    <tr>
                                        <th className="pb-2">FQDN</th>
                                        <th className="pb-2">IP</th>
                                        <th className="pb-2">Target Server</th>
                                        <th className="pb-2">Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {previewRecords.map((r, i) => (
                                        <tr key={i} className="border-t border-white/5">
                                            <td className="py-2 font-mono text-sm">{r.fqdn}</td>
                                            <td className="py-2 font-mono text-sm">{r.ip}</td>
                                            <td className="py-2">{r.serverName}</td>
                                            <td className="py-2">
                                                <span className={r.status === 'Ready' ? 'text-success' : 'text-danger'}>{r.status}</span>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        <div className="flex justify-end gap-3 mt-6">
                            <button className="btn btn-outline" onClick={() => setShowPreviewModal(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleConfirmImport}>Confirm Import</button>
                        </div>
                    </div>
                </div>
            )}

            {/* History Modal */}
            {showHistoryModal && (
                <div className="modal-overlay" style={{ zIndex: 3000 }}>
                    <div className="glass-panel modal-content" style={{ maxWidth: '700px', width: '95%', padding: '2rem', height: 'auto' }}>
                        <button className="modal-close" onClick={() => setShowHistoryModal(false)}>&times;</button>
                        <h3 className="mb-2">Change History</h3>
                        <div className="text-accent-primary mb-4 font-mono">{historyFqdn}</div>
                        {loadingHistory ? (
                            <p className="animate-pulse">Loading history...</p>
                        ) : historyLogs.length > 0 ? (
                            <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
                                <table className="w-full text-left">
                                    <thead>
                                        <tr>
                                            <th className="pb-2">Timestamp</th>
                                            <th className="pb-2">User</th>
                                            <th className="pb-2">Action</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {historyLogs.map((log, i) => (
                                            <tr key={i} className="border-t border-white/5">
                                                <td className="py-2 text-sm">{log.timestamp}</td>
                                                <td className="py-2 text-sm text-accent-primary">{log.user}</td>
                                                <td className="py-2 text-sm font-mono">{log.action}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <p className="text-secondary py-4 text-center">No history found for this record.</p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

const RecordChangeLog = () => {
    const { showToast } = useToast();
    const [changeLogs, setChangeLogs] = useState([]);
    const [loadingLogs, setLoadingLogs] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [logSearchQuery, setLogSearchQuery] = useState('');
    const pageSize = 50;

    useEffect(() => {
        fetchLogs();
    }, []);

    const fetchLogs = async () => {
        setLoadingLogs(true);
        try {
            const res = await api.get('/records/logs');
            setChangeLogs(res.data || []);
            setCurrentPage(1);
        } catch (e) {
            console.error(e);
        }
        setLoadingLogs(false);
    };

    const filteredLogs = changeLogs.filter(log => {
        const q = logSearchQuery.toLowerCase();
        return (
            (log.user || '').toLowerCase().includes(q) ||
            (log.action || '').toLowerCase().includes(q) ||
            (log.timestamp || '').toLowerCase().includes(q)
        );
    });

    const totalPages = Math.ceil(filteredLogs.length / pageSize);
    const paginatedLogs = filteredLogs.slice((currentPage - 1) * pageSize, currentPage * pageSize);

    return (
        <div className="glass-panel p-6 min-h-[500px]">
            <div className="flex justify-between items-center mb-4">
                <h3>DNS Change Logs</h3>
                <button className="btn btn-outline btn-sm" onClick={fetchLogs} disabled={loadingLogs}>
                    {loadingLogs ? 'Refreshing...' : 'Refresh'}
                </button>
            </div>

            <div className="mb-4">
                <input
                    type="text"
                    placeholder="Search logs by user, action details, or timestamp..."
                    className="input w-full text-sm bg-white/5 border border-white/10 rounded-lg px-4 py-2 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-accent-primary"
                    value={logSearchQuery}
                    onChange={e => {
                        setLogSearchQuery(e.target.value);
                        setCurrentPage(1);
                    }}
                />
            </div>

            {loadingLogs ? (
                <p className="text-secondary animate-pulse">Loading logs...</p>
            ) : filteredLogs.length > 0 ? (
                <>
                    <div style={{ overflowX: 'auto', maxHeight: '600px', marginBottom: '16px' }}>
                        <table className="w-full text-left">
                            <thead>
                                <tr>
                                    <th className="pb-2 text-secondary font-semibold">Timestamp</th>
                                    <th className="pb-2 text-secondary font-semibold">User</th>
                                    <th className="pb-2 text-secondary font-semibold">Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {paginatedLogs.map((log, i) => (
                                    <tr key={i} className="border-t border-white/5 hover:bg-white/5">
                                        <td className="py-3 text-sm text-gray-300 whitespace-nowrap">{log.timestamp}</td>
                                        <td className="py-3 text-sm text-accent-primary whitespace-nowrap pr-4">{log.user}</td>
                                        <td className="py-3 font-mono text-sm text-gray-200">
                                            {log.action}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {totalPages > 1 && (
                        <div className="flex justify-between items-center border-t border-white/10 pt-4">
                            <div className="text-secondary text-sm">
                                Showing {((currentPage - 1) * pageSize) + 1} to {Math.min(currentPage * pageSize, filteredLogs.length)} of {filteredLogs.length} entries
                            </div>
                            <div className="flex gap-2">
                                <button
                                    className="btn btn-outline btn-sm"
                                    disabled={currentPage === 1}
                                    onClick={() => setCurrentPage(prev => prev - 1)}
                                >
                                    Previous
                                </button>
                                <span className="flex items-center px-3 text-sm font-semibold">
                                    Page {currentPage} of {totalPages}
                                </span>
                                <button
                                    className="btn btn-outline btn-sm"
                                    disabled={currentPage === totalPages}
                                    onClick={() => setCurrentPage(prev => prev + 1)}
                                >
                                    Next
                                </button>
                            </div>
                        </div>
                    )}
                </>
            ) : (
                <div className="flex justify-center py-12 text-secondary">
                    <p>{changeLogs.length === 0 ? "No change logs found." : "No matching logs found."}</p>
                </div>
            )}
        </div>
    );
};

const DnsHub = () => {
    const { showToast } = useToast();
    const [activeTab, setActiveTab] = useState('servers');

    return (
        <div className="animate-fade-in p-4">
            <div className="mb-6 flex justify-between items-center px-1">
                <div>
                    <h1 className="page-title">
                        DNS Hub
                    </h1>
                    <p className="page-subtitle">Centralized Domain Name System Management</p>
                </div>
            </div>

            <div className="tabs">
                <button
                    className={`tab ${activeTab === 'servers' ? 'active' : ''}`}
                    onClick={() => setActiveTab('servers')}
                >
                    Server Management
                </button>
                <button
                    className={`tab ${activeTab === 'records' ? 'active' : ''}`}
                    onClick={() => setActiveTab('records')}
                >
                    Record Operations
                </button>
                <button
                    className={`tab ${activeTab === 'logs' ? 'active' : ''}`}
                    onClick={() => setActiveTab('logs')}
                >
                    Record Change Log
                </button>
            </div>

            <main className="animate-fade-in">
                {activeTab === 'servers' && <ADServerList />}
                {activeTab === 'records' && <RecordManager />}
                {activeTab === 'logs' && <RecordChangeLog />}
            </main>
            <style>{`
                .dropdown-item-btn:hover { background: rgba(255,255,255,0.1) !important; }
                .server-card { transition: transform 0.2s; position: relative; overflow: visible !important; }
                .server-card:hover { transform: translateY(-4px); z-index: 1500; }
            `}</style>
        </div>
    );
};

export default DnsHub;
