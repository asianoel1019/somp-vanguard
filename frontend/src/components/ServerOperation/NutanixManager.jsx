import React, { useState, useEffect } from 'react';
import api from '../../api';
import NutanixCloneVM from './NutanixCloneVM';
import WebRemoteModal from '../Shared/WebRemoteModal';
import { shouldFallbackToConfig } from '../Shared/webRemoteUtils';


const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    headerBtns: { display: 'flex', gap: 10, alignItems: 'center' },
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnO: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
    btnDanger: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden', position: 'relative' },
    tblHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 },
    tblTitle: { fontSize: 16, fontWeight: 900, margin: 0 },
    sBox: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid var(--border-color)', borderRadius: 8 },
    sInput: { border: 'none', background: 'transparent', outline: 'none', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', width: 160 },
    sel: { padding: '7px 12px', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, fontWeight: 600, background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', cursor: 'pointer' },
    fBtn: { padding: '7px 16px', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: 'var(--text-secondary)' },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)', cursor: 'pointer' },
    tr: { borderBottom: '1px solid var(--border-color)' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13 },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' },
    viewBtn: { padding: '8px 18px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 11, fontWeight: 900, cursor: 'pointer', letterSpacing: '0.04em', boxShadow: '0 4px 12px var(--accent-glow)', transition: 'all 0.2s' },
    btnDisabled: { padding: '8px 18px', background: 'rgba(51, 65, 85, 0.4)', color: '#94a3b8', border: '1px solid rgba(148, 163, 184, 0.2)', borderRadius: 8, fontSize: 11, fontWeight: 900, cursor: 'not-allowed', letterSpacing: '0.04em', opacity: 0.42, filter: 'grayscale(100%)' },
    metLabel: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', display: 'block', marginBottom: 8 },
    dot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 },
    loadOverlay: { position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 10, borderRadius: 16 },
    modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 },
    modalContent: { width: '100%', maxWidth: 500, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24, boxShadow: '0 20px 40px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', gap: 16 },
    modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    modalTitle: { fontSize: 16, fontWeight: 900, margin: 0, color: 'var(--text-primary)' },
    modalBody: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 },
    modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
};

const NutanixManager = () => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const [vms, setVms] = useState([]);
    const [loaded, setLoaded] = useState(false);
    const [pcStatus, setPcStatus] = useState('checking'); // 'checking', 'online', 'offline'
    const [pcError, setPcError] = useState('');
    const [pcIp, setPcIp] = useState('');
    const [isPeMode, setIsPeMode] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [currentPage, setCurrentPage] = useState(1);
    const PAGE_SIZE = 50;
    const [searchName, setSearchName] = useState('');
    const [filterCluster, setFilterCluster] = useState('');
    const [filterHost, setFilterHost] = useState('');
    const [filterPower, setFilterPower] = useState('');
    const [clusters, setClusters] = useState([]);
    const [hosts, setHosts] = useState([]);
    const [powerStates, setPowerStates] = useState([]);
    const [expandedVmId, setExpandedVmId] = useState(null);
    const [modalConfig, setModalConfig] = useState(null);
    const [hasGuacamole, setHasGuacamole] = useState(false);
    const [remoteTarget, setRemoteTarget] = useState(null);
    const [isRemoteOpen, setIsRemoteOpen] = useState(false);
    const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' });
    const [selectedVmIds, setSelectedVmIds] = useState([]);
    const [exportOpen, setExportOpen] = useState(false);
    const exportRef = React.useRef(null);
    const [viewMode, setViewMode] = useState('list'); // 'list' or 'clone'
    const [modal, setModal] = useState({ show: false, type: 'info', title: '', message: '', onConfirm: null, onCancel: null, confirmText: 'Confirm', cancelText: 'Cancel' });

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (exportRef.current && !exportRef.current.contains(event.target)) {
                setExportOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const showModal = (type, title, message, onConfirm = null, onCancel = null, confirmText = 'Confirm', cancelText = 'Cancel') => {
        setModal({ show: true, type, title, message, onConfirm, onCancel, confirmText, cancelText });
    };

    const closeModal = () => {
        setModal(prev => ({ ...prev, show: false }));
    };

    const fetchVms = async () => {
        setLoading(true); setError('');
        try {
            const res = await api.post('/nutanix/vms');
            const data = res.data.vms || [];
            if (res.data.pcIp) setPcIp(res.data.pcIp);
            setIsPeMode(!!res.data.isPeMode);
            const formatted = data.map(vm => {
                const name = vm.spec?.name || 'Unknown';
                const nicList = vm.status?.resources?.nic_list || [];
                const ips = []; nicList.forEach(nic => { (nic.ip_endpoint_list || []).forEach(ep => { if (ep.ip) ips.push(ep.ip); }); });
                const clusterName = vm.status?.cluster_reference?.name || 'Unknown Cluster';
                let hostName = vm.status?.resources?.host_reference?.name || vm.status?.host_reference?.name || 'Unknown Host';
                const powerState = vm.status?.resources?.power_state || 'UNKNOWN';
                const vcpuCount = (vm.status?.resources?.num_vcpus_per_socket || 1) * (vm.status?.resources?.num_sockets || 1);
                const memMiB = vm.status?.resources?.memory_size_mib || 0;
                return { id: vm.metadata?.uuid || name, name, ips: ips.length > 0 ? ips.join(', ') : 'No IP', cluster: clusterName, clusterUuid: vm.status?.cluster_reference?.uuid || '', host: hostName, powerState, vcpuCount, memoryGB: Math.round((memMiB / 1024) * 10) / 10, diskList: vm.status?.resources?.disk_list || [], guestOs: 'unknown' };
            });
            setVms(formatted);
            const uC = [...new Set(formatted.map(v => v.cluster))].sort();
            const uH = [...new Set(formatted.map(v => v.host))].sort();
            const uP = [...new Set(formatted.map(v => v.powerState))].sort();
            setClusters(uC); setHosts(uH); setPowerStates(uP);
            if (uC.length > 0) setFilterCluster(uC[0]);
            setLoaded(true);
            setPcStatus('online');
        } catch (err) { setError(err.response?.data?.error || err.message); } finally { setLoading(false); }
    };

    const checkConnection = async () => {
        setPcStatus('checking');
        setPcError('');
        try {
            const res = await api.get('/nutanix/connection-status');
            if (res.data.success) {
                setPcStatus('online');
                if (res.data.ip) setPcIp(res.data.ip);
                setIsPeMode(!!res.data.isPeMode);
            } else {
                setPcStatus('offline');
                setPcError(res.data.error || 'Connection failed.');
                if (res.data.ip) setPcIp(res.data.ip);
                setIsPeMode(!!res.data.isPeMode);
            }
        } catch (err) {
            setPcStatus('offline');
            setPcError(err.response?.data?.error || err.message);
            if (err.response?.data?.ip) setPcIp(err.response.data.ip);
            if (err.response?.data?.isPeMode !== undefined) setIsPeMode(!!err.response.data.isPeMode);
        }
    };

    useEffect(() => {
        checkConnection();
        // Check Guacamole gateway endpoint configuration
        api.get('/remote/status')
            .then(r => setHasGuacamole(!!r.data?.configured))
            .catch((err) => {
                // 403 = Web Remote not allowed for this user: hide the button instead of falling back
                if (!shouldFallbackToConfig(err)) { setHasGuacamole(false); return; }
                api.get('/auth/config')
                    .then(r => setHasGuacamole(!!r.data?.hasGuacamole))
                    .catch(() => setHasGuacamole(false));
            });
    }, []);

    const requestSort = (key) => { setSortConfig(prev => ({ key, direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc' })); };
    const sortArrow = (key) => sortConfig.key === key ? (sortConfig.direction === 'asc' ? ' ▲' : ' ▼') : '';

    let filteredVms = vms.filter(v => {
        if (filterCluster && v.cluster !== filterCluster) return false;
        if (filterHost && v.host !== filterHost) return false;
        if (filterPower && v.powerState !== filterPower) return false;
        if (searchName && !v.name.toLowerCase().includes(searchName.toLowerCase())) return false;
        return true;
    });
    filteredVms.sort((a, b) => { if (a[sortConfig.key] < b[sortConfig.key]) return sortConfig.direction === 'asc' ? -1 : 1; if (a[sortConfig.key] > b[sortConfig.key]) return sortConfig.direction === 'asc' ? 1 : -1; return 0; });

    const totalPages = Math.max(1, Math.ceil(filteredVms.length / PAGE_SIZE));
    const safePage = Math.min(currentPage, totalPages);
    const paged = filteredVms.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

    useEffect(() => { setCurrentPage(1); }, [searchName, filterCluster, filterHost, filterPower]);

    const handleBatchAction = async (actionType) => {
        if (selectedVmIds.length === 0) return;

        showModal(
            'confirm',
            'Confirm VM Action',
            `Are you sure you want to execute [${actionType}] on ${selectedVmIds.length} VM(s)?`,
            async () => {
                setLoading(true);
                try {
                    const res = await api.post('/nutanix/vm-action', { uuids: selectedVmIds, actionType });
                    if (res.data.success) {
                        const errs = (res.data.results || []).filter(r => r.status !== 'Success');
                        if (errs.length > 0) {
                            showModal('warning', 'Action Completed with Errors', `Completed with ${errs.length} errors.`);
                        } else {
                            showModal('success', 'Action Succeeded', `✅ ${actionType} triggered for all selected VMs.`);
                        }
                        setSelectedVmIds([]);
                        fetchVms();
                    }
                } catch (err) {
                    showModal('error', 'Action Failed', 'Failed: ' + (err.response?.data?.error || err.message));
                } finally {
                    setLoading(false);
                }
            }
        );
    };

    const exportToCSV = (scope) => {
        let items = scope === 'current' ? paged : scope === 'selected' ? vms.filter(v => selectedVmIds.includes(v.id)) : filteredVms;
        if (scope === 'selected' && items.length === 0) {
            showModal('warning', 'No VMs Selected', 'Please select one or more VMs first before exporting.');
            return;
        }
        if (items.length === 0) {
            showModal('warning', 'No Data to Export', 'There are no virtual machine entries matching this scope to export.');
            return;
        }
        const rows = ['Name,IP,Cluster,Host,PowerState', ...items.map(v => `"${v.name}","${v.ips}","${v.cluster}","${v.host}","${v.powerState}"`)];
        const blob = new Blob(["\uFEFF" + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `VM_List_${scope}_${new Date().toLocaleDateString()}.csv`; a.click();
        setExportOpen(false);
    };

    const handleSelectAll = (e) => {
        const ids = paged.map(vm => vm.id);
        if (e.target.checked) setSelectedVmIds(prev => [...new Set([...prev, ...ids])]);
        else setSelectedVmIds(prev => prev.filter(id => !ids.includes(id)));
    };

    const expandRow = (vm) => {
        const newId = expandedVmId === vm.id ? null : vm.id;
        setExpandedVmId(newId);
        if (newId && vm.guestOs === 'unknown') {
            const ip = (vm.ips || '').split(',')[0].trim();
            if (ip && ip !== 'No IP') {
                setVms(prev => prev.map(v => v.id === vm.id ? { ...v, guestOs: 'detecting' } : v));
                api.post('/nutanix/detect-os', { ip }).then(r => { setVms(prev => prev.map(v => v.id === vm.id ? { ...v, guestOs: (r.data.os || 'Unknown').toLowerCase() } : v)); }).catch(() => { setVms(prev => prev.map(v => v.id === vm.id ? { ...v, guestOs: 'unknown' } : v)); });
            }
        }
    };

    const handleRemote = (vm) => {
        if (!hasGuacamole) {
            showModal(
                'warning',
                '尚未配置 Guacamole 閘道',
                '系統尚未配置 Guacamole 閘道端點。請由管理員至「後台設定 (Settings) > 核心系統」填寫 GUACD_HOST 與 GUACD_PORT 後啟用連線。'
            );
            return;
        }

        const ip = (vm.ips || '').split(',')[0].trim();
        if (!ip || ip === 'No IP') {
            showModal('warning', 'No IP Assigned', 'Cannot connect. This virtual machine does not have an IP address assigned.');
            return;
        }
        if (vm.powerState !== 'ON') {
            showModal('warning', 'VM Powered Off', 'Cannot connect. The virtual machine must be powered ON to establish a remote connection.');
            return;
        }

        let os = vm.guestOs;
        if (os === 'unknown') {
            showModal(
                'confirm',
                'Select Remote Protocol',
                `Operating system not automatically detected for ${vm.name}. Please select the connection protocol:`,
                () => {
                    setRemoteTarget({ ip, name: vm.name, os: 'windows', protocol: 'rdp' });
                    setIsRemoteOpen(true);
                },
                () => {
                    setRemoteTarget({ ip, name: vm.name, os: 'linux', protocol: 'ssh' });
                    setIsRemoteOpen(true);
                },
                '🪟 Windows (Web RDP)',
                '🐧 Linux (Web SSH)'
            );
            return;
        }

        setRemoteTarget({
            ip,
            name: vm.name,
            os: os === 'windows' ? 'windows' : 'linux',
            protocol: os === 'windows' ? 'rdp' : 'ssh'
        });
        setIsRemoteOpen(true);
    };

    if (viewMode === 'clone') {
        return (
            <div style={S.page}>
                <NutanixCloneVM onClose={() => setViewMode('list')} />
            </div>
        );
    }

    return (
        <div style={S.page}>
            {/* Custom Modal for alert/confirm replacements */}
            {modal.show && (
                <div style={S.modalOverlay}>
                    <div style={S.modalContent}>
                        <div style={S.modalHeader}>
                            <h3 style={S.modalTitle}>
                                {modal.type === 'error' && '❌ '}
                                {modal.type === 'success' && '✅ '}
                                {modal.type === 'warning' && '⚠️ '}
                                {modal.type === 'confirm' && '❓ '}
                                {modal.title}
                            </h3>
                            <button style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer' }} onClick={closeModal}>✕</button>
                        </div>
                        <div style={S.modalBody}>{modal.message}</div>
                        <div style={S.modalFooter}>
                            {modal.onConfirm ? (
                                <>
                                    <button style={S.btnO} onClick={() => { if (modal.onCancel) { modal.onCancel(); } closeModal(); }}>{modal.cancelText}</button>
                                    <button style={S.btnP} onClick={() => { modal.onConfirm(); closeModal(); }}>{modal.confirmText}</button>
                                </>
                            ) : (
                                <button style={S.btnP} onClick={closeModal}>OK</button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <div style={S.header}>
                <div>
                    <h1 className="page-title">Nutanix VM Manager</h1>
                    <p className="page-subtitle">Virtual machine inventory and power management{pcIp ? ` — ${isPeMode ? 'Prism Element' : 'Prism Central'}: ${pcIp}` : ''}</p>
                </div>
                <div style={S.headerBtns}>
                    {selectedVmIds.length > 0 && role !== 'Viewer' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--accent-primary)' }}>{selectedVmIds.length} selected</span>
                            <select style={S.sel} onChange={e => { if (e.target.value) { handleBatchAction(e.target.value); e.target.value = ''; } }}>
                                <option value="">— Action —</option>
                                <option value="OFF">PowerOff</option>
                                <option value="POWER_CYCLE">PowerCycle</option>
                                <option value="RESET">Reset</option>
                                <option value="ACPI_SHUTDOWN">GuestShutdown</option>
                                <option value="ACPI_REBOOT">GuestReboot</option>
                            </select>
                        </div>
                    )}
                    <div style={{ position: 'relative' }} ref={exportRef}>
                        <button style={S.btnO} onClick={() => setExportOpen(!exportOpen)}>📥 Export</button>
                        {exportOpen && (
                            <div style={{ position: 'absolute', top: '110%', right: 0, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, boxShadow: '0 10px 30px rgba(0,0,0,0.3)', zIndex: 50, overflow: 'hidden', minWidth: 200 }}>
                                <div style={{ padding: '10px 16px', fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)', letterSpacing: '0.08em' }}>EXPORT SCOPE</div>
                                {[['current', `Current View (${paged.length})`], ['selected', `Selected (${selectedVmIds.length})`], ['all', `All VMs (${filteredVms.length})`]].map(([k, l]) => (
                                    <div key={k} onClick={() => exportToCSV(k)} style={{ padding: '10px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: 'var(--text-primary)' }}>{l}</div>
                                ))}
                            </div>
                        )}
                    </div>
                    <button
                        style={{ ...S.btnP, opacity: (loading || pcStatus !== 'online') && !loaded ? 0.5 : 1 }}
                        onClick={fetchVms}
                        disabled={(loading || pcStatus !== 'online') && !loaded}
                    >
                        {loading ? '⏳ Loading...' : loaded ? '🔄 Refresh' : '🔍 Get All VM List'}
                    </button>
                    {role !== 'Viewer' && (
                        <button
                            style={{ ...S.btnP, background: 'linear-gradient(135deg, var(--bg-secondary), var(--bg-tertiary))', border: '1px solid var(--border-color)' }}
                            onClick={() => setViewMode('clone')}
                        >
                            🌱 CloneVM
                        </button>
                    )}
                </div>
            </div>

            {/* Error Banner */}
            {error && (
                <div style={{ padding: '14px 24px', borderRadius: 16, background: 'var(--danger)', color: '#fff', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 700, fontSize: 13 }}>
                    <span>⚠️ {error}</span>
                    <button style={{ ...S.btnO, color: '#fff', borderColor: 'rgba(255,255,255,0.4)', padding: '6px 14px', fontSize: 12 }} onClick={fetchVms}>Retry</button>
                </div>
            )}

            {/* Table */}
            <div style={S.tblWrap}>
                {loading && <div style={S.loadOverlay}><div style={{ fontSize: 40, marginBottom: 12 }}>⚙️</div><span style={{ fontWeight: 800, fontSize: 14, color: 'var(--text-primary)' }}>Fetching VMs from Nutanix...</span></div>}
                <div style={S.tblHead}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <h3 style={S.tblTitle}>Virtual Machines</h3>
                        <div style={S.sBox}><span style={{ color: 'var(--text-muted)', fontSize: 12 }}>▽</span><input type="text" placeholder="Search VM name..." style={S.sInput} value={searchName} onChange={e => setSearchName(e.target.value)} /></div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <select style={S.sel} value={filterCluster} onChange={e => setFilterCluster(e.target.value)}><option value="">All Clusters</option>{clusters.map(c => <option key={c} value={c}>{c}</option>)}</select>
                        <select style={S.sel} value={filterHost} onChange={e => setFilterHost(e.target.value)}><option value="">All Hosts</option>{hosts.map(h => <option key={h} value={h}>{h}</option>)}</select>
                        <select style={S.sel} value={filterPower} onChange={e => setFilterPower(e.target.value)}><option value="">All States</option>{powerStates.map(p => <option key={p} value={p}>{p}</option>)}</select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <button disabled={safePage <= 1} onClick={() => setCurrentPage(safePage - 1)} style={{ ...S.fBtn, minWidth: 32, textAlign: 'center', padding: '5px 10px', opacity: safePage <= 1 ? 0.35 : 1 }}>&lt;</button>
                            <span style={{ padding: '5px 12px', fontSize: 13, fontWeight: 900 }}>{safePage} / {totalPages}</span>
                            <button disabled={safePage >= totalPages} onClick={() => setCurrentPage(safePage + 1)} style={{ ...S.fBtn, minWidth: 32, textAlign: 'center', padding: '5px 10px', opacity: safePage >= totalPages ? 0.35 : 1 }}>&gt;</button>
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>Total: {filteredVms.length} VMs</span>
                    </div>
                </div>
                <table style={S.tbl}>
                    <thead><tr>
                        <th style={{ ...S.th, width: 40, textAlign: 'center', cursor: 'default' }}><input type="checkbox" onChange={handleSelectAll} checked={paged.length > 0 && paged.every(vm => selectedVmIds.includes(vm.id))} style={{ accentColor: 'var(--accent-primary)' }} /></th>
                        <th style={S.th} onClick={() => requestSort('name')}>NAME{sortArrow('name')}</th>
                        <th style={S.th} onClick={() => requestSort('ips')}>IP{sortArrow('ips')}</th>
                        <th style={S.th}>CLUSTER</th>
                        <th style={S.th}>HOST</th>
                        <th style={{ ...S.th, textAlign: 'center' }}>POWER</th>
                    </tr></thead>
                    <tbody>
                        {!loaded && !loading ? (
                            <tr>
                                <td colSpan="6" style={{ ...S.td, textAlign: 'center', padding: 60 }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                                        {pcStatus === 'checking' && (
                                            <>
                                                <span style={{ fontSize: 48, animation: 'pulse 1.5s infinite' }}>📡</span>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                    <span style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)' }}>Connecting to Nutanix {isPeMode ? 'Prism Element' : 'Prism Central'}...</span>
                                                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Verifying network connection and credentials...</span>
                                                </div>
                                                <button style={{ ...S.btnP, padding: '10px 24px', fontSize: 13, gap: 10, width: 'fit-content', marginTop: 8, opacity: 0.5 }} disabled>
                                                    ⏳ Checking Status...
                                                </button>
                                            </>
                                        )}
                                        {pcStatus === 'online' && (
                                            <>
                                                <span style={{ fontSize: 48, filter: 'drop-shadow(0 0 10px rgba(34,197,94,0.3))' }}>✅</span>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                    <span style={{ fontWeight: 800, fontSize: 15, color: '#4ade80' }}>Nutanix {isPeMode ? 'Prism Element' : 'Prism Central'} is Online</span>
                                                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Connection established successfully. Click below to load the live list of virtual machines.</span>
                                                </div>
                                                <button style={{ ...S.btnP, padding: '10px 24px', fontSize: 13, gap: 10, width: 'fit-content', marginTop: 8 }} onClick={fetchVms}>
                                                    🔍 Get All VM List
                                                </button>
                                            </>
                                        )}
                                        {pcStatus === 'offline' && (
                                            <>
                                                <span style={{ fontSize: 48, filter: 'drop-shadow(0 0 10px rgba(239,68,68,0.3))' }}>🚨</span>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                    <span style={{ fontWeight: 800, fontSize: 15, color: '#f87171' }}>Nutanix {isPeMode ? 'Prism Element' : 'Prism Central'} is Offline</span>
                                                    <span style={{ fontSize: 12, color: 'var(--text-muted)', maxWidth: 450, margin: '0 auto' }}>
                                                        Failed to connect. Error: <code style={{ color: 'var(--danger)', background: 'rgba(239,68,68,0.1)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>{pcError || 'Unknown Error'}</code>.
                                                        <br />
                                                        Please verify the {isPeMode ? 'Prism Element' : 'Prism Central'} IP, account, or password in the Settings page.
                                                    </span>
                                                </div>
                                                <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                                                    <button style={{ ...S.btnP, padding: '10px 24px', fontSize: 13, gap: 10, width: 'fit-content', opacity: 0.5 }} disabled>
                                                        🔍 Get All VM List
                                                    </button>
                                                    <button style={{ ...S.btnO, padding: '10px 24px', fontSize: 13, gap: 8, width: 'fit-content' }} onClick={checkConnection}>
                                                        🔄 Retry Connection Test
                                                    </button>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ) : paged.length === 0 ? (
                            <tr>
                                <td colSpan="6" style={{ ...S.td, textAlign: 'center', padding: 50, color: 'var(--text-muted)' }}>
                                    {loading ? 'Loading...' : 'No VMs found.'}
                                </td>
                            </tr>
                        ) : null}
                        {paged.map(vm => (
                            <React.Fragment key={vm.id}>
                                <tr style={S.tr}>
                                    <td style={{ ...S.td, textAlign: 'center' }}><input type="checkbox" checked={selectedVmIds.includes(vm.id)} onChange={() => setSelectedVmIds(prev => prev.includes(vm.id) ? prev.filter(id => id !== vm.id) : [...prev, vm.id])} style={{ accentColor: 'var(--accent-primary)' }} /></td>
                                    <td style={S.td}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => expandRow(vm)}>
                                            <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, border: '1px solid var(--border-color)' }}>🖥️</div>
                                            <div><div style={{ fontWeight: 800, color: 'var(--accent-primary)' }}>{vm.name}</div></div>
                                            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{expandedVmId === vm.id ? '▼' : '▶'}</span>
                                        </div>
                                    </td>
                                    <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 12 }}>{vm.ips}</td>
                                    <td style={{ ...S.td, color: 'var(--text-secondary)', fontWeight: 600 }}>{vm.cluster}</td>
                                    <td style={{ ...S.td, color: 'var(--text-muted)' }}>{vm.host}</td>
                                    <td style={{ ...S.td, textAlign: 'center' }}><span style={{ fontWeight: 900, letterSpacing: '0.08em', color: vm.powerState === 'ON' ? 'var(--success)' : 'var(--text-muted)' }}>{vm.powerState === 'ON' ? 'ON' : 'OFF'}</span></td>
                                </tr>
                                {expandedVmId === vm.id && (
                                    <tr style={{ background: 'var(--bg-secondary)' }}>
                                        <td colSpan="6" style={{ padding: '20px 24px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                    <span style={{ fontWeight: 900, fontSize: 15 }}>⚙️ {vm.name}</span>
                                                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Properties</span>
                                                    {vm.guestOs === 'detecting' && <span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 10, fontWeight: 800, background: 'var(--warning)', color: '#fff' }}>⏳ Detecting...</span>}
                                                    {vm.guestOs !== 'unknown' && vm.guestOs !== 'detecting' && <span style={{ ...S.badge, background: vm.guestOs === 'windows' ? 'rgba(59,130,246,0.15)' : 'rgba(34,197,94,0.15)', color: vm.guestOs === 'windows' ? '#60a5fa' : '#4ade80', borderColor: vm.guestOs === 'windows' ? '#3b82f6' : '#22c55e' }}>{vm.guestOs === 'windows' ? 'Windows' : 'Linux'}</span>}
                                                </div>
                                                <div style={{ display: 'flex', gap: 8 }}>
                                                    <button
                                                        disabled={!hasGuacamole}
                                                        style={!hasGuacamole ? S.btnDisabled : S.viewBtn}
                                                        onClick={() => handleRemote(vm)}
                                                        title={!hasGuacamole ? "⚠️ 尚未配置 Guacamole 閘道端點，請由超級管理員至後台設定填寫 GUACD_HOST / GUACD_PORT 啟用連線" : "Open Web Remote Control"}
                                                    >
                                                        🖥️ Remote Control
                                                    </button>
                                                    <button style={{ ...S.fBtn, fontSize: 11 }} onClick={() => setExpandedVmId(null)}>✕ Close</button>
                                                </div>
                                            </div>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
                                                <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, textAlign: 'center', borderTop: '3px solid var(--accent-primary)' }}>
                                                    <span style={S.metLabel}>COMPUTE (vCPU)</span>
                                                    <div style={{ fontSize: 32, fontWeight: 900 }}>{vm.vcpuCount}</div>
                                                </div>
                                                <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, textAlign: 'center', borderTop: '3px solid var(--warning)' }}>
                                                    <span style={S.metLabel}>MEMORY (RAM)</span>
                                                    <div style={{ fontSize: 32, fontWeight: 900 }}>{vm.memoryGB} <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-muted)' }}>GB</span></div>
                                                </div>
                                                <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, maxHeight: 180, overflowY: 'auto' }}>
                                                    <span style={S.metLabel}>DISK INFO</span>
                                                    {vm.diskList && vm.diskList.length > 0 ? vm.diskList.map((disk, idx) => {
                                                        const gb = Math.round(((disk.disk_size_mib || 0) / 1024) * 10) / 10;
                                                        return (<div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderRadius: 8, background: 'var(--bg-secondary)', marginBottom: 4, fontSize: 12 }}>
                                                            <span style={{ fontWeight: 700 }}>💽 Disk {idx + 1}{disk.device_properties?.device_type ? ` (${disk.device_properties.device_type})` : ''}</span>
                                                            <span style={{ fontWeight: 900, color: 'var(--warning)' }}>{gb} GB</span>
                                                        </div>);
                                                    }) : <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>No disks found.</span>}
                                                </div>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </React.Fragment>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Guacamole Web Remote Modal */}
            <WebRemoteModal
                isOpen={isRemoteOpen}
                onClose={() => {
                    setIsRemoteOpen(false);
                    setRemoteTarget(null);
                }}
                target={remoteTarget}
            />
        </div>
    );
};

export default NutanixManager;
