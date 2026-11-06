import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import ConnectionTab from './mgmt/ConnectionTab';
import CapabilityTab from './mgmt/CapabilityTab';
import BackupTab from './mgmt/BackupTab';
import { capabilityTabs } from './mgmt/mgmtTabs.js';
import { OPEN_EVENT, takePendingTarget } from '../../utils/networkDeviceLink.js';
import { TbShieldLock, TbSwitchHorizontal, TbRouter, TbScale, TbServer2, TbSearch, TbPlus, TbAlertTriangle, TbCircleCheck, TbPlugConnectedX, TbDevices, TbAntenna, TbRefresh } from 'react-icons/tb';
import { deviceHealth, snmpState, summarize, typeCounts, filterDevices, sortDevices, connectionNote } from './deviceList.js';

const DEFAULT_SNMP = { enabled: false, version: 'v2c', community: '', port: 161 };
const errText = (err) => err?.response?.data?.error || err?.message || 'Unknown error';

const TYPE_ICONS = { Firewall: TbShieldLock, Switch: TbSwitchHorizontal, Router: TbRouter, LoadBalancer: TbScale };
const TypeIcon = ({ type, size = 16 }) => { const I = TYPE_ICONS[type] || TbServer2; return <I size={size} aria-hidden="true" style={{ flexShrink: 0 }} />; };
const HEALTH = {
    ok: { color: 'var(--success)', label: '連線正常' },
    error: { color: 'var(--danger)', label: '連線異常' },
    pending: { color: 'var(--warning)', label: '尚未讀取' },
    disabled: { color: 'var(--text-muted)', label: '管理連線停用' },
    none: { color: 'var(--text-muted)', label: '未設定管理連線' },
};
const HealthDot = ({ health }) => (
    <span title={HEALTH[health].label} style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: health === 'none' || health === 'disabled' ? 'transparent' : HEALTH[health].color, border: `2px solid ${HEALTH[health].color}`, boxShadow: health === 'error' ? '0 0 0 3px rgba(239,68,68,0.18)' : 'none' }} />
);
const SNMP_BADGE = {
    ok: (d) => ({ text: d.snmp && d.snmp.version ? d.snmp.version : 'SNMP', bg: 'rgba(34,197,94,0.1)', color: 'var(--success)' }),
    missing: () => ({ text: '未設定', bg: 'rgba(245,158,11,0.12)', color: 'var(--warning)' }),
    off: () => ({ text: '停用', bg: 'rgba(148,163,184,0.15)', color: 'var(--text-muted)' }),
};

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
    // Vendor API connection of the open device: { device, profile, vendors, capabilities }
    const [mgmtInfo, setMgmtInfo] = useState(null);
    // A device to open, sent from Server Rack / Topology Map (see utils/networkDeviceLink.js)
    const devicesRef = useRef([]);
    const pendingRef = useRef(null);

    const [selectedFilterDC, setSelectedFilterDC] = useState('All');
    const [selectedFilterType, setSelectedFilterType] = useState('All');
    // Summary card filter: all | ok | error | none | snmpMissing
    const [quickFilter, setQuickFilter] = useState('all');
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
           .then(res => {
               setDevices(res.data);
               devicesRef.current = Array.isArray(res.data) ? res.data : [];
               const target = pendingRef.current;
               if (target) { pendingRef.current = null; openTarget(target, devicesRef.current); }
           })
           .catch(console.error)
           .finally(() => setLoading(false));
    };

    // Opened from another screen: a managed device starts on Overview, others on Info & SNMP
    const openTarget = (target, list) => {
        const device = list.find(d => d.id === target.id);
        if (!device) {
            setSysAlert({ message: '在 Network Device 找不到這台設備（可能已被移除，或不是 Switch / Router / Firewall / Load Balancer）。' });
            return;
        }
        openDeviceModal(device, target.tab || (device.mgmt && device.mgmt.enabled ? 'cap:summary' : 'info'));
    };

    const openDeviceModal = (device, tab = 'info') => {
        setSelectedDevice(device);
        setDeviceForm({ hostname: device.hostname || '', ip: device.ip || '' });
        setSnmpForm({ ...DEFAULT_SNMP, ...(device.snmp || {}), enabled: device.enabled ?? device.snmp?.enabled ?? false });
        setPollData(null);
        setActiveTab(tab);
        setMgmtInfo(null);
        api.get(`/network-device/${device.id}/mgmt`).then(res => setMgmtInfo(res.data)).catch(console.error);
    };

    const onMgmtSaved = (info) => {
        setMgmtInfo(info);
        if (activeTab.startsWith('cap:') && !capabilityTabs(info).some(t => `cap:${t.key}` === activeTab)) setActiveTab('mgmt');
        if (activeTab === 'backup' && !(info && info.profile && info.backup)) setActiveTab('mgmt');
        fetchDevices();
    };

    useEffect(() => {
        pendingRef.current = takePendingTarget();
        const onOpen = (e) => {
            takePendingTarget(); // the same target was also stored for a fresh mount
            if (devicesRef.current.length) openTarget(e.detail, devicesRef.current);
            else pendingRef.current = e.detail;
        };
        window.addEventListener(OPEN_EVENT, onOpen);
        fetchDevices();
        api.get('/rack/datacenters').then(res => setDatacenters(res.data)).catch(console.error);
        return () => window.removeEventListener(OPEN_EVENT, onOpen);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        tabContainer: { display: 'flex', flexWrap: 'wrap', gap: 10, padding: '16px 24px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-secondary)' },
        tab: active => ({ padding: '8px 16px', borderRadius: 20, fontSize: 13, fontWeight: 800, cursor: 'pointer', border: 'none', background: active ? 'var(--accent-primary)' : 'transparent', color: active ? '#fff' : 'var(--text-muted)', transition: 'all 0.2s' }),
        inputGroup: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 },
        label: { fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' },
        input: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px 12px', borderRadius: 8, fontSize: 14, outline: 'none', width: '100%' },
        portGrid: cols => ({ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8, marginTop: 16 }),
        portBox: up => ({ aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', background: up ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${up ? 'var(--success)' : 'var(--danger)'}`, borderRadius: 4, color: up ? 'var(--success)' : 'var(--danger)', fontSize: 11, fontWeight: 800 })
    };

    const summary = summarize(devices);
    const types = typeCounts(devices);
    const filteredDevices = sortDevices(filterDevices(devices, { dc: selectedFilterDC, type: selectedFilterType, quick: quickFilter, search: searchText }));
    const uniqueDCs = Array.from(new Set(devices.map(d => d.datacenter))).filter(Boolean).sort();
    const filtersOn = selectedFilterDC !== 'All' || selectedFilterType !== 'All' || quickFilter !== 'all' || searchText.trim() !== '';
    const clearFilters = () => { setSelectedFilterDC('All'); setSelectedFilterType('All'); setQuickFilter('all'); setSearchText(''); };

    const CARDS = [
        { key: 'all', label: '全部設備', value: summary.total, icon: TbDevices, color: 'var(--accent-primary)' },
        { key: 'ok', label: '連線正常', value: summary.ok, icon: TbCircleCheck, color: 'var(--success)' },
        { key: 'error', label: '連線異常', value: summary.error, icon: TbAlertTriangle, color: 'var(--danger)', alert: summary.error > 0 },
        { key: 'none', label: '未設管理連線', value: summary.none, icon: TbPlugConnectedX, color: 'var(--warning)' },
        { key: 'snmpMissing', label: 'SNMP 未設定', value: summary.snmpMissing, icon: TbAntenna, color: 'var(--text-muted)' },
    ];
    const chip = (active, danger) => ({
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer',
        border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-color)'}`,
        background: active ? 'var(--accent-primary)' : 'var(--bg-secondary)',
        color: active ? '#fff' : danger ? 'var(--danger)' : 'var(--text-secondary)', transition: 'all 0.15s',
    });
    const cellTd = { ...s.td, padding: '12px 14px', verticalAlign: 'middle' };
    const sub = { fontSize: 12, color: 'var(--text-muted)', marginTop: 3 };

    return (
        <div style={s.container}>
            <div style={{ ...s.header, marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
                <div>
                    <div style={s.title}><TbDevices size={30} aria-hidden="true" style={{ color: 'var(--accent-primary)' }} /> Network Devices</div>
                    <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
                        {loading ? '載入中…' : `共 ${summary.total} 台${filtersOn ? `，符合條件 ${filteredDevices.length} 台` : ''}`}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button style={{ ...s.btnPrimary, background: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', opacity: loading ? 0.6 : 1 }} disabled={loading} onClick={fetchDevices} title="重新整理">
                        <TbRefresh size={16} aria-hidden="true" /> 重新整理
                    </button>
                    {role !== 'Viewer' && (
                        <button style={s.btnPrimary} onClick={handleOpenAddModal}><TbPlus size={16} aria-hidden="true" /> 新增設備</button>
                    )}
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 20 }}>
                {CARDS.map(c => {
                    const active = quickFilter === c.key;
                    const Icon = c.icon;
                    return (
                        <button key={c.key} onClick={() => setQuickFilter(active && c.key !== 'all' ? 'all' : c.key)}
                            style={{
                                textAlign: 'left', cursor: 'pointer', padding: '14px 16px', borderRadius: 14, transition: 'all 0.15s',
                                background: c.alert ? 'rgba(239,68,68,0.06)' : 'var(--bg-secondary)',
                                border: `1px solid ${active ? c.color : c.alert ? 'rgba(239,68,68,0.45)' : 'var(--border-color)'}`,
                                boxShadow: active ? `0 0 0 2px ${c.color}33` : 'var(--shadow-sm, none)', color: 'var(--text-primary)',
                            }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-muted)', fontSize: 12, fontWeight: 700 }}>
                                {c.label}
                                <span style={{ display: 'inline-flex', padding: 6, borderRadius: 10, background: 'var(--bg-tertiary)', color: c.color }}><Icon size={16} aria-hidden="true" /></span>
                            </div>
                            <div style={{ fontSize: 28, fontWeight: 900, marginTop: 6, color: c.key === 'all' || !c.value ? 'var(--text-primary)' : c.color }}>{loading ? '–' : c.value}</div>
                        </button>
                    );
                })}
            </div>

            <div style={{ ...s.card, padding: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button style={chip(selectedFilterType === 'All')} onClick={() => setSelectedFilterType('All')}>全部 <span style={{ opacity: 0.75 }}>{devices.length}</span></button>
                        {types.map(tc => (
                            <button key={tc.type} style={chip(selectedFilterType === tc.type)} onClick={() => setSelectedFilterType(selectedFilterType === tc.type ? 'All' : tc.type)}>
                                <TypeIcon type={tc.type} size={14} /> {tc.type} <span style={{ opacity: 0.75 }}>{tc.count}</span>
                            </button>
                        ))}
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <div style={{ position: 'relative' }}>
                            <TbSearch size={16} aria-hidden="true" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                            <input type="text" placeholder="主機名稱、IP、廠牌、型號" style={{ ...s.input, width: 240, paddingLeft: 32 }} value={searchText} onChange={e => setSearchText(e.target.value)} />
                        </div>
                        <select style={{ ...s.input, width: 'auto' }} value={selectedFilterDC} onChange={e => setSelectedFilterDC(e.target.value)}>
                            <option value="All">全部機房</option>
                            {uniqueDCs.map(dc => <option key={dc} value={dc}>{dc}</option>)}
                        </select>
                    </div>
                </div>
                {loading && !devices.length ? <p style={{ padding: 24, color: 'var(--text-muted)' }}>載入設備中…</p> : (
                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ ...s.table, marginTop: 0 }}>
                            <thead>
                                <tr>
                                    {['', '設備', 'IP', '類型', '廠牌 / 型號', 'SNMP', '位置'].map(h => <th key={h} style={{ ...s.th, padding: '10px 14px', background: 'var(--bg-tertiary)' }}>{h}</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {filteredDevices.length === 0 ? (
                                    <tr><td colSpan="7" style={{ ...cellTd, textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>
                                        {filtersOn ? (<>沒有符合條件的設備。<button onClick={clearFilters} style={{ marginLeft: 8, background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontWeight: 700 }}>清除篩選</button></>) : '還沒有網路設備，從 Server Rack 加入或按「新增設備」。'}
                                    </td></tr>
                                ) : filteredDevices.map(d => {
                                    const health = deviceHealth(d);
                                    const m = d.mgmt;
                                    const snmp = SNMP_BADGE[snmpState(d)](d);
                                    const note = connectionNote(d);
                                    const rowBg = health === 'error' ? 'rgba(239,68,68,0.05)' : 'transparent';
                                    return (
                                        <tr key={d.id} style={{ cursor: 'pointer', background: rowBg, transition: 'background 0.15s' }} onClick={() => openDeviceModal(d)}
                                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-tertiary)'; }} onMouseLeave={e => { e.currentTarget.style.background = rowBg; }}>
                                            <td style={{ ...cellTd, width: 28, paddingRight: 0 }}><HealthDot health={health} /></td>
                                            <td style={cellTd}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, color: health === 'error' ? 'var(--danger)' : 'var(--accent-primary)' }}>
                                                    <TypeIcon type={d.type} /> {d.hostname || 'Unknown'}
                                                </div>
                                            </td>
                                            <td style={{ ...cellTd, fontFamily: 'monospace', fontSize: 13 }}>{d.ip || '-'}</td>
                                            <td style={{ ...cellTd, color: 'var(--text-secondary)' }}>{d.type}</td>
                                            <td style={cellTd} title={m && m.lastError ? m.lastError : ''}>
                                                {m ? <div style={{ fontWeight: 700 }}>{m.vendorLabel}{m.model ? ` · ${m.model}` : ''}{m.version ? <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> {m.version}</span> : null}</div> : null}
                                                <div style={{ ...sub, color: health === 'error' ? 'var(--danger)' : health === 'none' ? 'var(--warning)' : sub.color, marginTop: m ? 3 : 0 }}>{note}</div>
                                            </td>
                                            <td style={cellTd}><span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: snmp.bg, color: snmp.color }}>{snmp.text}</span></td>
                                            <td style={{ ...cellTd, fontSize: 13, color: 'var(--text-secondary)' }}>{[d.datacenter, d.rackName, d.startU ? `U${d.startU}` : null].filter(Boolean).join(' / ') || '-'}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Selected Device Modal */}
            {selectedDevice && (
                <div style={s.modalOverlay} onClick={() => setSelectedDevice(null)}>
                    <div style={{ ...s.modal, maxWidth: 1100 }} onClick={e => e.stopPropagation()}>
                        <div style={s.modalHeader}>
                            {(() => {
                                const health = deviceHealth(selectedDevice);
                                const m = selectedDevice.mgmt;
                                return (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                                        <span style={{ display: 'inline-flex', padding: 10, borderRadius: 12, background: 'var(--bg-tertiary)', color: 'var(--accent-primary)' }}><TypeIcon type={selectedDevice.type} size={24} /></span>
                                        <div style={{ minWidth: 0 }}>
                                            <h3 style={{ fontSize: 20, fontWeight: 900, margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                                                {selectedDevice.hostname}
                                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: 'var(--bg-tertiary)', color: HEALTH[health].color }}>
                                                    <HealthDot health={health} /> {HEALTH[health].label}
                                                </span>
                                            </h3>
                                            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
                                                <span style={{ fontFamily: 'monospace' }}>{selectedDevice.ip}</span>
                                                {` · ${selectedDevice.type}`}
                                                {m ? ` · ${m.vendorLabel}${m.model ? ` ${m.model}` : ''}${m.version ? ` ${m.version}` : ''}` : ''}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()}
                            <button onClick={() => setSelectedDevice(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 24 }}>&times;</button>
                        </div>
                        <div style={s.tabContainer}>
                            <button style={s.tab(activeTab === 'info')} onClick={() => setActiveTab('info')}>Info & SNMP</button>
                            <button style={s.tab(activeTab === 'ports')} onClick={() => { setActiveTab('ports'); if(!pollData && snmpEnabled && !ipUnsaved) handlePoll(); }}>Port Status</button>
                            <button style={s.tab(activeTab === 'arp')} onClick={() => { setActiveTab('arp'); if(!pollData && snmpEnabled && !ipUnsaved) handlePoll(); }}>ARP Table</button>
                            <button style={s.tab(activeTab === 'mac')} onClick={() => { setActiveTab('mac'); if(!pollData && snmpEnabled && !ipUnsaved) handlePoll(); }}>MAC Table</button>
                            <button style={s.tab(activeTab === 'mgmt')} onClick={() => setActiveTab('mgmt')}>Connection</button>
                            {capabilityTabs(mgmtInfo).map(t => (
                                <button key={t.key} style={s.tab(activeTab === `cap:${t.key}`)} onClick={() => setActiveTab(`cap:${t.key}`)}>{t.label}</button>
                            ))}
                            {role !== 'Viewer' && mgmtInfo && mgmtInfo.profile && mgmtInfo.backup && (
                                <button style={s.tab(activeTab === 'backup')} onClick={() => setActiveTab('backup')}>Config Backup</button>
                            )}
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

                            {activeTab === 'mgmt' && (mgmtInfo
                                ? <ConnectionTab key={mgmtInfo.profile ? mgmtInfo.profile.updatedAt || 'saved' : 'new'} device={selectedDevice} info={mgmtInfo} role={role} s={s} onSaved={onMgmtSaved}
                                    onAlert={(message) => setSysAlert({ message })} onConfirm={(message, onConfirm) => setSysConfirm({ message, onConfirm })} />
                                : <p>Loading...</p>)}
                            {activeTab === 'backup' && mgmtInfo && (
                                <BackupTab device={selectedDevice} s={s} onAlert={(message) => setSysAlert({ message })} />
                            )}
                            {activeTab.startsWith('cap:') && (
                                <CapabilityTab key={activeTab} device={selectedDevice} capability={activeTab.slice(4)} s={s} />
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
