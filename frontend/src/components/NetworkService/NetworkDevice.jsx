import React, { useState, useEffect } from 'react';
import api from '../../api';

const DEFAULT_SNMP = { enabled: false, version: 'v2c', community: '', port: 161 };
const errText = (err) => err?.response?.data?.error || err?.message || 'Unknown error';

export default function NetworkDevice() {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';

    const [devices, setDevices] = useState([]);
    const [loading, setLoading] = useState(false);
    
    // Modal states
    const [selectedDevice, setSelectedDevice] = useState(null);
    const [deviceForm, setDeviceForm] = useState({ hostname: '', ip: '' });
    const [activeTab, setActiveTab] = useState('info');
    const [snmpForm, setSnmpForm] = useState(DEFAULT_SNMP);
    const [pollData, setPollData] = useState(null);
    const [pollLoading, setPollLoading] = useState(false);

    const [selectedFilterDC, setSelectedFilterDC] = useState('All');
    const [selectedFilterType, setSelectedFilterType] = useState('All');
    const [searchText, setSearchText] = useState('');
    const [sysAlert, setSysAlert] = useState(null);
    const [sysConfirm, setSysConfirm] = useState(null);

    // Add device modal
    const [showAddModal, setShowAddModal] = useState(false);
    const [datacenters, setDatacenters] = useState([]);
    const [racks, setRacks] = useState([]);
    const [addForm, setAddForm] = useState({
        datacenterId: 'default',
        rackId: '',
        type: 'Switch',
        hostname: '',
        ip: '',
        startU: 1,
        sizeU: 1
    });

    useEffect(() => {
        fetchDevices();
        api.get('/rack/datacenters').then(res => setDatacenters(res.data)).catch(console.error);
    }, []);

    useEffect(() => {
        if (addForm.datacenterId) {
            api.get(`/rack?dcId=${addForm.datacenterId}`).then(res => {
                setRacks(res.data || []);
                if (res.data && res.data.length > 0) {
                    setAddForm(prev => ({ ...prev, rackId: res.data[0].id }));
                }
            }).catch(console.error);
        }
    }, [addForm.datacenterId]);

    const fetchDevices = () => {
        setLoading(true);
        api.get('/network-device/devices')
           .then(res => setDevices(res.data))
           .catch(console.error)
           .finally(() => setLoading(false));
    };

    const openDeviceModal = (device) => {
        setSelectedDevice(device);
        setDeviceForm({ hostname: device.hostname || '', ip: device.ip || '' });
        setSnmpForm({ ...DEFAULT_SNMP, ...(device.snmp || {}), enabled: device.enabled ?? device.snmp?.enabled ?? false });
        setPollData(null);
        setActiveTab('info');
    };

    const saveDeviceInfo = () => {
        if (!selectedDevice || role === 'Viewer') return;
        const payload = {
            hostname: deviceForm.hostname,
            ip: deviceForm.ip,
            fileKey: selectedDevice.fileKey,
            rackId: selectedDevice.rackId
        };
        api.put(`/network-device/devices/${selectedDevice.id}`, payload).then(() => {
            setSysAlert({ message: 'Device Info Saved and synced to Server Rack' });
            fetchDevices();
            setSelectedDevice(prev => ({ ...prev, hostname: (deviceForm.hostname || '').trim(), ip: (deviceForm.ip || '').trim() }));
        }).catch(err => setSysAlert({ message: 'Error saving device info: ' + errText(err) }));
    };

    const saveSnmp = () => {
        if (!selectedDevice || role === 'Viewer') return;
        const payload = { ...snmpForm, enabled: !!snmpForm.enabled };
        api.post(`/network-device/${selectedDevice.id}/snmp`, payload).then(() => {
            setSysAlert({ message: 'SNMP Settings Saved' });
            setSelectedDevice(prev => (prev ? { ...prev, enabled: payload.enabled } : prev));
            if (!payload.enabled) setPollData(null);
            fetchDevices();
        }).catch(err => setSysAlert({ message: 'Error saving SNMP settings: ' + errText(err) }));
    };

    // SNMP query switch as saved on the server (the form toggle only applies after Save)
    const snmpEnabled = !!selectedDevice?.enabled;
    const ipUnsaved = !!selectedDevice && (deviceForm.ip || '').trim() !== (selectedDevice.ip || '');

    const handlePoll = () => {
        if (!selectedDevice || !snmpEnabled) return;
        if (ipUnsaved) {
            setSysAlert({ message: 'IP 位址已修改但尚未儲存，請先按「Save Device Info」儲存後再查詢 (SNMP 查詢一律使用已儲存的 IP)。' });
            return;
        }
        setPollLoading(true);
        api.get(`/network-device/${selectedDevice.id}/poll`).then(res => {
            setPollData(res.data);
        }).catch(err => {
            setPollData(null);
            setSysAlert({ message: 'Poll failed: ' + errText(err) });
        }).finally(() => {
            setPollLoading(false);
        });
    };

    const handleAddSubmit = (e) => {
        e.preventDefault();
        const payload = {
            datacenterId: addForm.datacenterId,
            rackId: addForm.rackId,
            device: {
                type: addForm.type,
                hostname: addForm.hostname,
                ip: addForm.ip,
                startU: parseInt(addForm.startU),
                sizeU: parseInt(addForm.sizeU),
                ports: 24 // default
            }
        };
        api.post('/network-device/devices', payload).then(() => {
            setShowAddModal(false);
            fetchDevices();
        }).catch(err => {
            setSysAlert({ message: 'Failed to add: ' + errText(err) });
        });
    };

    const handleOpenAddModal = () => {
        const fetchDcId = addForm.datacenterId || 'default';
        api.get(`/rack?dcId=${fetchDcId}`).then(res => {
            setRacks(res.data || []);
            if (res.data && res.data.length > 0) {
                setAddForm(prev => ({ ...prev, rackId: res.data[0].id }));
            }
            setShowAddModal(true);
        }).catch(console.error);
    };

    const handleDeleteDevice = () => {
        if (role === 'Viewer') return;
        setSysConfirm({
            message: 'Are you sure you want to delete this network device? This will also remove it from the Server Rack.',
            onConfirm: () => {
                api.delete(`/network-device/devices/${selectedDevice.id}?fileKey=${encodeURIComponent(selectedDevice.fileKey)}`)
                .then(() => {
                    setSysAlert({ message: 'Device deleted successfully' });
                    setSelectedDevice(null);
                    fetchDevices();
                })
                .catch(err => setSysAlert({ message: 'Error deleting device: ' + errText(err) }));
            }
        });
    };

    // Shared Styles
    const s = {
        container: { padding: 32, maxWidth: 1200, margin: '0 auto', color: 'var(--text-primary)' },
        header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
        title: { fontSize: 28, fontWeight: 900, display: 'flex', alignItems: 'center', gap: 12 },
        card: { background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24, boxShadow: 'var(--shadow-md)' },
        btnPrimary: { display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--accent-primary)', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 8, cursor: 'pointer', fontWeight: 600, transition: 'all 0.2s' },
        table: { width: '100%', borderCollapse: 'collapse', marginTop: 16 },
        th: { textAlign: 'left', padding: '12px 16px', color: 'var(--text-muted)', fontSize: 12, fontWeight: 800, borderBottom: '1px solid var(--border-color)', letterSpacing: 0.5 },
        td: { padding: '16px', borderBottom: '1px solid var(--border-color)', fontSize: 14 },
        modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(4px)' },
        modal: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 16, width: '90%', maxWidth: 800, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-xl)' },
        modalHeader: { padding: '20px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
        tabContainer: { display: 'flex', gap: 10, padding: '16px 24px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-secondary)' },
        tab: active => ({ padding: '8px 16px', borderRadius: 20, fontSize: 13, fontWeight: 800, cursor: 'pointer', border: 'none', background: active ? 'var(--accent-primary)' : 'transparent', color: active ? '#fff' : 'var(--text-muted)', transition: 'all 0.2s' }),
        inputGroup: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 },
        label: { fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' },
        input: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px 12px', borderRadius: 8, fontSize: 14, outline: 'none', width: '100%' },
        portGrid: cols => ({ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8, marginTop: 16 }),
        portBox: up => ({ aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', background: up ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${up ? 'var(--success)' : 'var(--danger)'}`, borderRadius: 4, color: up ? 'var(--success)' : 'var(--danger)', fontSize: 11, fontWeight: 800 })
    };

    const filteredDevices = devices.filter(d => {
        if (selectedFilterDC !== 'All' && d.datacenter !== selectedFilterDC) return false;
        if (selectedFilterType !== 'All' && d.type !== selectedFilterType) return false;
        if (searchText) {
            const query = searchText.toLowerCase();
            const hn = (d.hostname || '').toLowerCase();
            const ip = (d.ip || '').toLowerCase();
            if (!hn.includes(query) && !ip.includes(query)) return false;
        }
        return true;
    });

    const uniqueDCs = Array.from(new Set(devices.map(d => d.datacenter))).filter(Boolean).sort();
    const uniqueTypes = Array.from(new Set(devices.map(d => d.type))).filter(Boolean).sort();

    return (
        <div style={s.container}>
            <div style={s.header}>
                <div style={s.title}>🖧 Network Devices</div>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                    <input 
                        type="text" 
                        placeholder="Search Hostname/IP..." 
                        style={{ ...s.input, width: '220px' }} 
                        value={searchText} 
                        onChange={e => setSearchText(e.target.value)} 
                    />
                    <select style={{ ...s.input, width: 'auto' }} value={selectedFilterDC} onChange={e => setSelectedFilterDC(e.target.value)}>
                        <option value="All">All Datacenters</option>
                        {uniqueDCs.map(dc => <option key={dc} value={dc}>{dc}</option>)}
                    </select>
                    <select style={{ ...s.input, width: 'auto' }} value={selectedFilterType} onChange={e => setSelectedFilterType(e.target.value)}>
                        <option value="All">All Types</option>
                        {uniqueTypes.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    {role !== 'Viewer' && (
                        <button style={s.btnPrimary} onClick={handleOpenAddModal}>+ Add Device</button>
                    )}
                </div>
            </div>

            <div style={s.card}>
                {loading ? <p>Loading devices...</p> : (
                    <table style={s.table}>
                        <thead>
                            <tr>
                                <th style={s.th}>HOSTNAME</th>
                                <th style={s.th}>IP ADDRESS</th>
                                <th style={s.th}>TYPE</th>
                                <th style={s.th}>LOCATION</th>
                                <th style={s.th}>SNMP SETUP</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredDevices.length === 0 ? (
                                <tr><td colSpan="5" style={{...s.td, textAlign: 'center', color: 'var(--text-muted)'}}>No network devices found</td></tr>
                            ) : filteredDevices.map(d => (
                                <tr key={d.id} style={{ cursor: 'pointer', transition: 'background 0.2s' }} onClick={() => openDeviceModal(d)} onMouseEnter={e => e.currentTarget.style.background='var(--bg-tertiary)'} onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                                    <td style={{...s.td, fontWeight: 800, color: 'var(--accent-primary)'}}>{d.hostname || 'Unknown'}</td>
                                    <td style={{...s.td, fontFamily: 'monospace'}}>{d.ip}</td>
                                    <td style={s.td}>{d.type}</td>
                                    <td style={s.td}>{d.datacenter} / {d.rackName} / U{d.startU}</td>
                                    <td style={s.td}>
                                        {d.enabled === false ? (
                                            <span style={{ padding: '4px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: 'rgba(148,163,184,0.15)', color: 'var(--text-muted)' }}>
                                                SNMP 停用
                                            </span>
                                        ) : (
                                            <span style={{ padding: '4px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: (d.snmp?.community || d.snmp?.v3User) ? 'rgba(34,197,94,0.1)' : 'rgba(245,158,11,0.1)', color: (d.snmp?.community || d.snmp?.v3User) ? 'var(--success)' : 'var(--warning)'}}>
                                                {d.snmp?.version || 'Not Configured'}
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Selected Device Modal */}
            {selectedDevice && (
                <div style={s.modalOverlay} onClick={() => setSelectedDevice(null)}>
                    <div style={s.modal} onClick={e => e.stopPropagation()}>
                        <div style={s.modalHeader}>
                            <h3 style={{ fontSize: 20, fontWeight: 900, margin: 0 }}>{selectedDevice.hostname} ({selectedDevice.ip})</h3>
                            <button onClick={() => setSelectedDevice(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 24 }}>&times;</button>
                        </div>
                        <div style={s.tabContainer}>
                            <button style={s.tab(activeTab === 'info')} onClick={() => setActiveTab('info')}>Info & SNMP</button>
                            <button style={s.tab(activeTab === 'ports')} onClick={() => { setActiveTab('ports'); if(!pollData && snmpEnabled && !ipUnsaved) handlePoll(); }}>Port Status</button>
                            <button style={s.tab(activeTab === 'arp')} onClick={() => { setActiveTab('arp'); if(!pollData && snmpEnabled && !ipUnsaved) handlePoll(); }}>ARP Table</button>
                            <button style={s.tab(activeTab === 'mac')} onClick={() => { setActiveTab('mac'); if(!pollData && snmpEnabled && !ipUnsaved) handlePoll(); }}>MAC Table</button>
                        </div>
                        <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
                            {activeTab === 'info' && (
                                <div style={{ maxWidth: 600 }}>
                                    {/* Basic Info Section */}
                                    <div style={{ padding: 16, border: '1px solid var(--border-color)', borderRadius: 12, marginBottom: 24, background: 'var(--bg-primary)' }}>
                                        <h4 style={{ margin: '0 0 16px', fontSize: 16 }}>Basic Information</h4>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                            <div style={s.inputGroup}>
                                                <label style={s.label}>Hostname</label>
                                                <input type="text" style={s.input} value={deviceForm.hostname} onChange={e => setDeviceForm({...deviceForm, hostname: e.target.value})} />
                                            </div>
                                            <div style={s.inputGroup}>
                                                <label style={s.label}>IP Address</label>
                                                <input type="text" style={s.input} value={deviceForm.ip} onChange={e => setDeviceForm({...deviceForm, ip: e.target.value})} />
                                            </div>
                                        </div>
                                        {role !== 'Viewer' && (
                                            <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                                                <button style={{...s.btnPrimary, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)'}} onClick={saveDeviceInfo}>Save Device Info</button>
                                                <button style={{...s.btnPrimary, background: 'rgba(239,68,68,0.1)', border: '1px solid var(--danger)', color: 'var(--danger)'}} onClick={handleDeleteDevice}>Delete Device</button>
                                            </div>
                                        )}
                                    </div>

                                    {/* SNMP Section */}
                                    <div style={{ padding: 16, border: '1px solid var(--border-color)', borderRadius: 12, background: 'var(--bg-primary)' }}>
                                        <h4 style={{ margin: '0 0 16px', fontSize: 16 }}>SNMP Configuration</h4>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 14, fontWeight: 700, cursor: role === 'Viewer' ? 'default' : 'pointer' }}>
                                            <input type="checkbox" checked={!!snmpForm.enabled} disabled={role === 'Viewer'} onChange={e => setSnmpForm({...snmpForm, enabled: e.target.checked})} />
                                            啟用 SNMP 查詢
                                        </label>
                                        {!snmpForm.enabled && (
                                            <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>停用時不會對此設備進行 SNMP 查詢，下方設定可先不填。</p>
                                        )}
                                        <div style={s.inputGroup}>
                                            <label style={s.label}>SNMP Version</label>
                                            <select style={s.input} value={snmpForm.version} onChange={e => setSnmpForm({...snmpForm, version: e.target.value})}>
                                                <option value="v1">v1</option>
                                                <option value="v2c">v2c</option>
                                                <option value="v3">v3</option>
                                            </select>
                                        </div>
                                    <div style={s.inputGroup}>
                                        <label style={s.label}>Port</label>
                                        <input type="number" style={s.input} value={snmpForm.port} onChange={e => setSnmpForm({...snmpForm, port: e.target.value})} />
                                    </div>
                                    {(snmpForm.version === 'v2c' || snmpForm.version === 'v1') && (
                                        <div style={s.inputGroup}>
                                            <label style={s.label}>Community String</label>
                                            <input type="password" style={s.input} value={snmpForm.community || ''} onChange={e => setSnmpForm({...snmpForm, community: e.target.value})} />
                                        </div>
                                    )}
                                    {snmpForm.version === 'v3' && (
                                        <>
                                            <div style={s.inputGroup}>
                                                <label style={s.label}>Security Name (User)</label>
                                                <input type="text" style={s.input} value={snmpForm.v3User || ''} onChange={e => setSnmpForm({...snmpForm, v3User: e.target.value})} />
                                            </div>
                                            <div style={s.inputGroup}>
                                                <label style={s.label}>Auth Password (SHA)</label>
                                                <input type="password" style={s.input} value={snmpForm.v3AuthPass || ''} onChange={e => setSnmpForm({...snmpForm, v3AuthPass: e.target.value})} />
                                            </div>
                                            <div style={s.inputGroup}>
                                                <label style={s.label}>Priv Password (AES)</label>
                                                <input type="password" style={s.input} value={snmpForm.v3PrivPass || ''} onChange={e => setSnmpForm({...snmpForm, v3PrivPass: e.target.value})} />
                                            </div>
                                        </>
                                    )}
                                        {role !== 'Viewer' && (
                                            <button style={{...s.btnPrimary, marginTop: 16}} onClick={saveSnmp}>Save SNMP Settings</button>
                                        )}
                                    </div>
                                </div>
                            )}

                            {(activeTab === 'ports' || activeTab === 'arp' || activeTab === 'mac') && (
                                <div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                        <h4 style={{ margin: 0 }}>Poll Results</h4>
                                        {snmpEnabled && (
                                            <button style={{ ...s.btnPrimary, opacity: (pollLoading || ipUnsaved) ? 0.6 : 1 }} onClick={handlePoll} disabled={pollLoading || ipUnsaved}>
                                                {pollLoading ? 'Polling...' : 'Refresh SNMP Data'}
                                            </button>
                                        )}
                                    </div>

                                    {!snmpEnabled && <p style={{ color: 'var(--text-muted)' }}>此設備未啟用 SNMP 查詢。請在「Info &amp; SNMP」頁籤勾選「啟用 SNMP 查詢」並儲存後再查詢。</p>}
                                    {snmpEnabled && ipUnsaved && <p style={{ color: 'var(--warning)' }}>IP 位址已修改但尚未儲存，請先儲存 Device Info 再查詢。</p>}
                                    {snmpEnabled && !pollData && !pollLoading && <p style={{ color: 'var(--text-muted)' }}>No data. Click refresh to poll device.</p>}
                                    {pollLoading && <p style={{ color: 'var(--accent-primary)' }}>Polling device via SNMP, please wait...</p>}
                                    
                                    {pollData && activeTab === 'ports' && (
                                        <div>
                                            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Physical Interface Status (ifOperStatus)</p>
                                            <div style={s.portGrid(pollData.ports.length > 10 ? Math.ceil(pollData.ports.length / 2) : pollData.ports.length)}>
                                                {pollData.ports.map((p, i) => {
                                                    const isUp = p.status === 'Up' || p.value === '1'; // 1=Up in SNMP
                                                    return (
                                                        <div key={i} style={s.portBox(isUp)} title={`Port ${p.port || i+1} - ${p.speed || 'Unknown'}`}>
                                                            {p.name || p.port || i+1}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {pollData && activeTab === 'arp' && (
                                        <table style={s.table}>
                                            <thead><tr><th style={s.th}>IP ADDRESS</th><th style={s.th}>MAC ADDRESS</th></tr></thead>
                                            <tbody>
                                                {pollData.arp.map((a, i) => (
                                                    <tr key={i}><td style={{...s.td, fontFamily:'monospace'}}>{a.ip || a.oid}</td><td style={{...s.td, fontFamily:'monospace'}}>{a.mac || a.value}</td></tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )}

                                    {pollData && activeTab === 'mac' && (
                                        <table style={s.table}>
                                            <thead><tr><th style={s.th}>MAC ADDRESS</th><th style={s.th}>SWITCH PORT</th></tr></thead>
                                            <tbody>
                                                {pollData.mac.map((m, i) => (
                                                    <tr key={i}><td style={{...s.td, fontFamily:'monospace'}}>{m.mac || m.oid}</td><td style={{...s.td, fontFamily:'monospace'}}>Port {m.port || m.value}</td></tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Add Device Modal */}
            {showAddModal && (
                <div style={s.modalOverlay} onClick={() => setShowAddModal(false)}>
                    <div style={{...s.modal, maxWidth: 500}} onClick={e => e.stopPropagation()}>
                        <div style={s.modalHeader}>
                            <h3 style={{ fontSize: 20, fontWeight: 900, margin: 0 }}>Add Network Device</h3>
                            <button onClick={() => setShowAddModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 24 }}>&times;</button>
                        </div>
                        <form onSubmit={handleAddSubmit} style={{ padding: 24 }}>
                            <div style={s.inputGroup}>
                                <label style={s.label}>Data Center</label>
                                <select style={s.input} required value={addForm.datacenterId} onChange={e => setAddForm({...addForm, datacenterId: e.target.value})}>
                                    <option value="default">Default Data Center</option>
                                    {datacenters.map(dc => <option key={dc.id} value={dc.id}>{dc.name}</option>)}
                                </select>
                            </div>
                            <div style={s.inputGroup}>
                                <label style={s.label}>Target Rack</label>
                                <select style={s.input} required value={addForm.rackId} onChange={e => setAddForm({...addForm, rackId: e.target.value})}>
                                    <option value="">-- Select Rack --</option>
                                    {racks.filter(r => !r.isBack).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                                </select>
                            </div>
                            <div style={s.inputGroup}>
                                <label style={s.label}>Device Type</label>
                                <select style={s.input} required value={addForm.type} onChange={e => setAddForm({...addForm, type: e.target.value})}>
                                    <option value="Switch">Switch</option>
                                    <option value="Router">Router</option>
                                    <option value="Firewall">Firewall</option>
                                    <option value="LoadBalancer">Load Balancer</option>
                                </select>
                            </div>
                            <div style={s.inputGroup}>
                                <label style={s.label}>Hostname</label>
                                <input type="text" style={s.input} required value={addForm.hostname} onChange={e => setAddForm({...addForm, hostname: e.target.value})} />
                            </div>
                            <div style={s.inputGroup}>
                                <label style={s.label}>IP Address (Management)</label>
                                <input type="text" style={s.input} required value={addForm.ip} onChange={e => setAddForm({...addForm, ip: e.target.value})} />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                <div style={s.inputGroup}>
                                    <label style={s.label}>Start U (Bottom-up)</label>
                                    <input type="number" style={s.input} required min="1" max="42" value={addForm.startU} onChange={e => setAddForm({...addForm, startU: e.target.value})} />
                                </div>
                                <div style={s.inputGroup}>
                                    <label style={s.label}>Size (U)</label>
                                    <input type="number" style={s.input} required min="1" max="42" value={addForm.sizeU} onChange={e => setAddForm({...addForm, sizeU: e.target.value})} />
                                </div>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
                                <button type="submit" style={s.btnPrimary}>Add & Sync to Rack</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
            {/* Custom Alert Modal */}
            {sysAlert && (
                <div style={s.modalOverlay}>
                    <div style={{ ...s.modal, maxWidth: 400, padding: 24, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <h3 style={{ fontSize: 18, marginBottom: 16 }}>Notice</h3>
                        <p style={{ marginBottom: 24, color: 'var(--text-secondary)' }}>{sysAlert.message}</p>
                        <button style={s.btnPrimary} onClick={() => setSysAlert(null)}>OK</button>
                    </div>
                </div>
            )}
            {/* Custom Confirm Modal */}
            {sysConfirm && (
                <div style={s.modalOverlay}>
                    <div style={{ ...s.modal, maxWidth: 400, padding: 24, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <h3 style={{ fontSize: 18, marginBottom: 16 }}>Confirm Action</h3>
                        <p style={{ marginBottom: 24, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{sysConfirm.message}</p>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 12 }}>
                            <button style={{ ...s.btnPrimary, background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }} onClick={() => setSysConfirm(null)}>Cancel</button>
                            <button style={{ ...s.btnPrimary, background: 'var(--danger)' }} onClick={() => { sysConfirm.onConfirm(); setSysConfirm(null); }}>Delete</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
