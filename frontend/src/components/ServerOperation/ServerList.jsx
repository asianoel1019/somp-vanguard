import React, { useState, useEffect, useMemo } from 'react';
import { 
    FiServer, FiSearch, FiCpu, FiHardDrive, FiActivity, FiFilter, 
    FiDownload, FiEdit3, FiCheckCircle, FiAlertTriangle, FiXCircle, 
    FiLayers, FiDatabase, FiGrid, FiEye, FiEyeOff, FiX, FiCheck, FiRefreshCw,
    FiSliders, FiArrowUp, FiArrowDown, FiTrash2
} from 'react-icons/fi';
import { FaWindows, FaLinux } from 'react-icons/fa';
import api from '../../api';
import HostDetailModal from '../Shared/HostDetailModal';
import { useToast } from '../../contexts/ToastContext';
import ServerListExcelDiffModal from './ServerListExcelDiffModal';
import FieldAuthorityModal from './FieldAuthorityModal';
import ServerDeleteModal from './ServerDeleteModal';
import DeletedServersModal from './DeletedServersModal';

// Helper to sort IPs numerically
function compareIPs(ipA, ipB) {
    const partsA = (ipA || '').split('.').map(n => parseInt(n, 10) || 0);
    const partsB = (ipB || '').split('.').map(n => parseInt(n, 10) || 0);
    
    for (let i = 0; i < 4; i++) {
        if (partsA[i] !== partsB[i]) {
            return partsA[i] - partsB[i];
        }
    }
    return 0;
}

const DEFAULT_COLUMNS = {
    ip: true,
    applicationName: true,
    businessUnit: true,
    zone: true,
    envName: true,
    scoutStatus: true,
    prometheusStatus: true,
    datacenterName: true,
    os: true
};

const DEFAULT_COLUMN_ORDER = [
    'ip',
    'applicationName',
    'businessUnit',
    'zone',
    'envName',
    'scoutStatus',
    'prometheusStatus',
    'datacenterName',
    'os'
];

const COLUMN_LABELS = {
    ip: 'IP / HOSTNAME',
    applicationName: 'APPLICATION NAME',
    businessUnit: 'BUSINESS UNIT',
    zone: 'PLATFORM',
    envName: 'ENVIRONMENT',
    scoutStatus: 'SCOUT MONITOR',
    prometheusStatus: 'PROMETHEUS & REDIS',
    datacenterName: 'LOCATION / RACK',
    os: 'OS SPECS'
};

const DEFAULT_KPI_CARDS = {
    totalServers: true,
    scoutMonitored: true,
    prometheusScraped: true,
    redisDeployed: true
};

export default function ServerList() {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const { showToast } = useToast();
    const [servers, setServers] = useState([]);
    const [environments, setEnvironments] = useState([]);
    const [loading, setLoading] = useState(true);

    // Page Edit & Customize Mode
    const [isPageEditMode, setIsPageEditMode] = useState(false);
    const [showColumnDropdown, setShowColumnDropdown] = useState(false);
    const [showDiffModal, setShowDiffModal] = useState(false);
    const [showAuthorityModal, setShowAuthorityModal] = useState(false);

    // Customization Settings (Persisted in browser localStorage)
    const [visibleColumns, setVisibleColumns] = useState(() => {
        try {
            const saved = localStorage.getItem('serverList_visibleColumns');
            if (saved) {
                const parsed = JSON.parse(saved);
                delete parsed.diskGB;
                return { ...DEFAULT_COLUMNS, ...parsed };
            }
            return DEFAULT_COLUMNS;
        } catch { return DEFAULT_COLUMNS; }
    });

    const [columnOrder, setColumnOrder] = useState(() => {
        try {
            const saved = localStorage.getItem('serverList_columnOrder');
            if (saved) {
                const parsed = JSON.parse(saved).filter(k => k !== 'diskGB');
                const missing = DEFAULT_COLUMN_ORDER.filter(k => !parsed.includes(k));
                return [...parsed, ...missing];
            }
            return DEFAULT_COLUMN_ORDER;
        } catch { return DEFAULT_COLUMN_ORDER; }
    });

    const [visibleKpis, setVisibleKpis] = useState(() => {
        try {
            const saved = localStorage.getItem('serverList_visibleKpis');
            return saved ? { ...DEFAULT_KPI_CARDS, ...JSON.parse(saved) } : DEFAULT_KPI_CARDS;
        } catch { return DEFAULT_KPI_CARDS; }
    });

    // Auto-persist layout changes to localStorage
    useEffect(() => {
        try {
            localStorage.setItem('serverList_visibleColumns', JSON.stringify(visibleColumns));
        } catch (e) { console.error(e); }
    }, [visibleColumns]);

    useEffect(() => {
        try {
            localStorage.setItem('serverList_columnOrder', JSON.stringify(columnOrder));
        } catch (e) { console.error(e); }
    }, [columnOrder]);

    useEffect(() => {
        try {
            localStorage.setItem('serverList_visibleKpis', JSON.stringify(visibleKpis));
        } catch (e) { console.error(e); }
    }, [visibleKpis]);

    // View Mode & Matrix Grouping State
    const [viewMode, setViewMode] = useState('table'); // 'table' | 'matrix'
    const [matrixGroupBy, setMatrixGroupBy] = useState('businessUnit'); // 'businessUnit' | 'zone' | 'envName' | 'datacenterName'

    // Unified All-in-One Filter Bar State
    const [search, setSearch] = useState('');
    const [envFilter, setEnvFilter] = useState('all');
    const [zoneFilter, setZoneFilter] = useState('all');
    const [buFilter, setBuFilter] = useState('all');

    // Bulk Selection State
    const [selectedIps, setSelectedIps] = useState([]);
    const [showBulkEditModal, setShowBulkEditModal] = useState(false);
    const [bulkEditForm, setBulkEditForm] = useState({
        applicationName: '',
        businessUnit: '',
        zone: '',
        envId: '',
        criticality: '',
        maintenanceWindow: '',
        purpose: ''
    });
    const [isBulkSaving, setIsBulkSaving] = useState(false);

    // Delete Confirmation Modal State (Rule 5: No native window.confirm)
    const [deleteConfirmModal, setDeleteConfirmModal] = useState({
        show: false,
        isBulk: false,
        targetServer: null,
        targetIps: []
    });
    const [showDeletedModal, setShowDeletedModal] = useState(false);

    const closeDeleteModal = () => setDeleteConfirmModal({ show: false, isBulk: false, targetServer: null, targetIps: [] });

    const openSingleDeleteModal = (server) => {
        setDeleteConfirmModal({
            show: true,
            isBulk: false,
            targetServer: server,
            targetIps: [server.ip]
        });
    };

    const openBulkDeleteModal = () => {
        if (selectedIps.length === 0) return;
        setDeleteConfirmModal({
            show: true,
            isBulk: true,
            targetServer: null,
            targetIps: selectedIps
        });
    };

    // Called by ServerDeleteModal after the delete request succeeded
    const handleDeleted = (ips) => {
        if (deleteConfirmModal.isBulk) setSelectedIps([]);
        if (selectedServer && ips.includes(selectedServer.ip)) setSelectedServer(null);
        closeDeleteModal();
        fetchServers();
    };

    const [isGlobalSyncing, setIsGlobalSyncing] = useState(false);

    // Pagination & Numerical IP Sorting
    const [currentPage, setCurrentPage] = useState(1);
    const [pageSize, setPageSize] = useState(25);
    const [sortField, setSortField] = useState('ip');
    const [sortDirection, setSortDirection] = useState('asc');

    // Modals & Drawer
    const [selectedServer, setSelectedServer] = useState(null);
    const [sharedModalHost, setSharedModalHost] = useState(null);
    const [isEditingMeta, setIsEditingMeta] = useState(false);
    const [cmdbHistory, setCmdbHistory] = useState([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

    // Single Edit Form State
    const [editForm, setEditForm] = useState({
        applicationName: '',
        businessUnit: '',
        zone: 'Intranet',
        fqdn: '',
        envId: '',
        criticality: 'Tier 2 - Business Operational',
        maintenanceWindow: 'Sun 02:00 - 04:00',
        purpose: '',
        os: '',
        cpuCores: '',
        memoryGB: '',
        arch: '',
        mac: '',
        vendor: ''
    });
    const [isSavingMeta, setIsSavingMeta] = useState(false);

    const fetchCmdbHistory = async (ip) => {
        if (!ip) return;
        setLoadingHistory(true);
        try {
            const res = await api.get(`/server-list/cmdb-history/${ip}`);
            setCmdbHistory(res.data.history || []);
        } catch (e) {
            console.error('Failed to fetch CMDB history:', e);
            setCmdbHistory([]);
        } finally {
            setLoadingHistory(false);
        }
    };

    const fetchServers = async () => {
        setLoading(true);
        try {
            let res;
            try {
                res = await api.get('/cmdb-server-list');
            } catch (err1) {
                if (err1.response && (err1.response.status === 404 || err1.response.status === 500)) {
                    res = await api.get('/server-list?mode=full');
                } else {
                    throw err1;
                }
            }
            if (res && res.data) {
                setServers(res.data.servers || []);
                setEnvironments(res.data.environments || []);
            }
        } catch (err) {
            console.error('Error fetching Server List:', err);
            try {
                const fallbackRes = await api.get('/server-list');
                if (fallbackRes && fallbackRes.data) {
                    setServers(fallbackRes.data.servers || []);
                    setEnvironments(fallbackRes.data.environments || []);
                    return;
                }
            } catch (fallbackErr) {}
            showToast?.('Failed to load Server List CMDB data', 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchServers();
    }, []);

    // Save Column / KPI preferences to localStorage
    const toggleColumn = (key) => {
        setVisibleColumns(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const moveColumn = (index, direction) => {
        const targetIndex = index + direction;
        if (targetIndex < 0 || targetIndex >= columnOrder.length) return;
        const newOrder = [...columnOrder];
        const temp = newOrder[index];
        newOrder[index] = newOrder[targetIndex];
        newOrder[targetIndex] = temp;
        setColumnOrder(newOrder);
    };

    const toggleKpi = (key) => {
        setVisibleKpis(prev => ({ ...prev, [key]: !prev[key] }));
    };

    const resetLayoutToDefault = () => {
        setVisibleColumns(DEFAULT_COLUMNS);
        setColumnOrder(DEFAULT_COLUMN_ORDER);
        setVisibleKpis(DEFAULT_KPI_CARDS);
        localStorage.removeItem('serverList_visibleColumns');
        localStorage.removeItem('serverList_columnOrder');
        localStorage.removeItem('serverList_visibleKpis');
        showToast?.('Layout preferences reset to default', 'info');
    };

    // Dynamic Zone Options extracted exclusively from actual servers data
    const availableZones = useMemo(() => {
        const set = new Set();
        servers.forEach(s => {
            if (s.zone && String(s.zone).trim()) {
                set.add(String(s.zone).trim());
            }
        });
        return Array.from(set).sort();
    }, [servers]);

    // Dynamic Business Unit Options extracted exclusively from actual servers data
    const availableBUs = useMemo(() => {
        const set = new Set();
        servers.forEach(s => {
            if (s.businessUnit && String(s.businessUnit).trim()) {
                set.add(String(s.businessUnit).trim());
            }
        });
        return Array.from(set).sort();
    }, [servers]);

    // Filtering & Numerical IP Sorting
    const filteredServers = useMemo(() => {
        return servers.filter(srv => {
            if (search.trim()) {
                const kw = search.toLowerCase();
                const matchIp = String(srv.ip || '').toLowerCase().includes(kw);
                const matchHost = String(srv.hostname || '').toLowerCase().includes(kw);
                const matchFqdn = String(srv.fqdn || '').toLowerCase().includes(kw);
                const matchApp = String(srv.applicationName || '').toLowerCase().includes(kw);
                const matchBu = String(srv.businessUnit || '').toLowerCase().includes(kw);
                const matchZone = String(srv.zone || '').toLowerCase().includes(kw);
                const matchSubnet = String(srv.subnetName || '').toLowerCase().includes(kw);
                if (!matchIp && !matchHost && !matchFqdn && !matchApp && !matchBu && !matchZone && !matchSubnet) return false;
            }

            if (envFilter !== 'all') {
                if (srv.envId !== envFilter && srv.envName !== envFilter) return false;
            }

            if (zoneFilter !== 'all') {
                if ((srv.zone || 'Intranet').toLowerCase() !== zoneFilter.toLowerCase()) return false;
            }

            if (buFilter !== 'all') {
                if ((srv.businessUnit || 'Unassigned').toLowerCase() !== buFilter.toLowerCase()) return false;
            }

            return true;
        }).sort((a, b) => {
            if (sortField === 'ip') {
                const cmp = compareIPs(a.ip, b.ip);
                return sortDirection === 'asc' ? cmp : -cmp;
            }

            let valA = a[sortField] || '';
            let valB = b[sortField] || '';
            if (typeof valA === 'string') valA = valA.toLowerCase();
            if (typeof valB === 'string') valB = valB.toLowerCase();

            if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
            if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
            return 0;
        });
    }, [servers, search, envFilter, zoneFilter, buFilter, sortField, sortDirection]);

    // KPI Summary Calculations (Dynamic based on filtered results)
    const stats = useMemo(() => {
        const total = filteredServers.length;
        const online = filteredServers.filter(s => s.status === 'alive' || s.status === 'online' || s.scoutStatus === 'online').length;
        const scoutCovered = filteredServers.filter(s => s.scoutStatus === 'online' || s.scoutStatus === 'offline' || s.agentInstalled === 1 || s.agentInstalled === true || s.agentInstalled === '1').length;
        const promCovered = filteredServers.filter(s => s.prometheusStatus === 'scraped' || s.prometheusStatus === true || s.isPrometheusScraped).length;
        const redisCount = filteredServers.filter(s => s.hasRedis || (Array.isArray(s.redisInstances) && s.redisInstances.length > 0)).length;

        return {
            total,
            online,
            onlineRate: total > 0 ? Math.round((online / total) * 100) : 0,
            scoutCovered,
            scoutRate: total > 0 ? Math.round((scoutCovered / total) * 100) : 0,
            promCovered,
            promRate: total > 0 ? Math.round((promCovered / total) * 100) : 0,
            redisCount
        };
    }, [filteredServers]);

    // Pagination
    const totalPages = Math.ceil(filteredServers.length / pageSize) || 1;
    const pagedServers = useMemo(() => {
        const start = (currentPage - 1) * pageSize;
        return filteredServers.slice(start, start + pageSize);
    }, [filteredServers, currentPage, pageSize]);

    // Selection Handling
    const handleSelectAll = (checked) => {
        if (checked) {
            setSelectedIps(pagedServers.map(s => s.ip));
        } else {
            setSelectedIps([]);
        }
    };

    const handleSelectRow = (ip, checked) => {
        if (checked) {
            setSelectedIps(prev => [...prev, ip]);
        } else {
            setSelectedIps(prev => prev.filter(x => x !== ip));
        }
    };

    // Active Visible Order
    const activeColumns = useMemo(() => {
        return columnOrder.filter(key => visibleColumns[key] !== false);
    }, [columnOrder, visibleColumns]);

    // Grouped Servers for Matrix View
    const groupedMatrix = useMemo(() => {
        const map = {};
        filteredServers.forEach(srv => {
            const key = srv[matrixGroupBy] || 'Unassigned / Default';
            if (!map[key]) map[key] = [];
            map[key].push(srv);
        });
        return map;
    }, [filteredServers, matrixGroupBy]);

    // Open Drawer
    const openServerDrawer = (srv) => {
        setSelectedServer(srv);
        setEditForm({
            applicationName: srv.applicationName || '',
            businessUnit: srv.businessUnit || '',
            zone: srv.zone || 'Intranet',
            fqdn: srv.fqdn || '',
            envId: srv.envId || '', // '' = Unassigned (never a silent production default)
            criticality: srv.criticality || 'Tier 2 - Business Operational',
            maintenanceWindow: srv.maintenanceWindow || 'Sun 02:00 - 04:00',
            purpose: srv.purpose || '',
            os: srv.os || '',
            cpuCores: srv.cpuCores || '',
            memoryGB: srv.memoryGB || '',
            diskGB: srv.diskGB || '',
            arch: srv.arch || '',
            mac: srv.mac || '',
            vendor: srv.vendor || '',
            sn: srv.sn || '',
            iloIp: srv.iloIp || '',
            cvmIp: srv.cvmIp || '',
            datacenterName: srv.datacenterName || '',
            rackId: srv.rackId || '',
            unitPosition: srv.unitPosition || ''
        });
        setIsEditingMeta(false);
        fetchCmdbHistory(srv.ip);
    };

    // Save Single CMDB Meta
    const handleSaveCMDBMeta = async (e) => {
        e.preventDefault();
        if (!selectedServer) return;

        setIsSavingMeta(true);
        try {
            // envId '' = still Unassigned: omit it so an unmapped stored value is not overwritten
            const { envId, ...rest } = editForm;
            await api.put(`/server-list/cmdb-meta/${selectedServer.ip}`, envId ? { ...rest, envId } : rest);
            showToast?.(`CMDB Metadata updated & synced for IP: ${selectedServer.ip}`, 'success');
            
            fetchServers();
            setIsEditingMeta(false);
            fetchCmdbHistory(selectedServer.ip);
        } catch (err) {
            console.error('Failed to update CMDB metadata:', err);
            showToast?.('Failed to save CMDB metadata', 'error');
        } finally {
            setIsSavingMeta(false);
        }
    };

    // Auto-Fill missing fields from Inventory and Prometheus
    const handleSyncRaw = () => {
        if (!selectedServer || !selectedServer.rawModules) return;
        const raw = selectedServer.rawModules;
        
        // Only override if raw has a value and it differs from current
        const updates = {};
        if (raw.inventoryOs && (!editForm.os || editForm.os === 'win' || editForm.os === 'linux')) updates.os = raw.inventoryOs;
        if (raw.promApp && !editForm.applicationName) updates.applicationName = raw.promApp;
        if (raw.promBu && !editForm.businessUnit) updates.businessUnit = raw.promBu;
        if (raw.promZone && !editForm.zone) updates.zone = raw.promZone;
        
        if (Object.keys(updates).length > 0) {
            setEditForm(prev => ({ ...prev, ...updates }));
            showToast?.('Auto-filled missing fields from Server Inventory & Prometheus!', 'info');
        } else {
            showToast?.('No new missing data found in modules to sync.', 'info');
        }
    };

    // Global Auto-Sync
    const handleGlobalSync = async () => {
        setIsGlobalSyncing(true);
        try {
            const res = await api.post('/server-list/sync-all');
            showToast?.(`Global Auto-Sync complete. Updated ${res.data.count} servers!`, 'success');
            fetchServers();
        } catch (err) {
            console.error('Global Sync error:', err);
            showToast?.('Global Auto-Sync failed.', 'error');
        } finally {
            setIsGlobalSyncing(false);
        }
    };

    // Save Bulk CMDB Meta
    const handleSaveBulkMeta = async (e) => {
        e.preventDefault();
        if (selectedIps.length === 0) return;

        setIsBulkSaving(true);
        try {
            const bulkRes = await api.post('/server-list/bulk-cmdb-meta', {
                ips: selectedIps,
                data: bulkEditForm
            });
            const skippedDeleted = bulkRes?.data?.skipped || 0;
            showToast?.(
                skippedDeleted > 0
                    ? `Bulk edit: ${bulkRes.data.count} updated, ${skippedDeleted} skipped (deleted)`
                    : `Successfully bulk updated CMDB Metadata for ${selectedIps.length} servers`,
                skippedDeleted > 0 ? 'warning' : 'success'
            );
            
            fetchServers();
            setShowBulkEditModal(false);
            setSelectedIps([]);
            setBulkEditForm({
                applicationName: '',
                businessUnit: '',
                zone: '',
                envId: '',
                criticality: '',
                maintenanceWindow: '',
                purpose: ''
            });
        } catch (err) {
            console.error('Failed to bulk update CMDB metadata:', err);
            showToast?.('Failed to bulk update CMDB metadata', 'error');
        } finally {
            setIsBulkSaving(false);
        }
    };

    const handleUnlinkVip = async (vipIp) => {
        try {
            await api.post('/server-list/unlink', { ip: vipIp });
            showToast?.(`Successfully unlinked VIP ${vipIp}`, 'success');
            fetchServers();
            if (selectedServer) {
                setSelectedServer(prev => ({
                    ...prev,
                    secondaryIps: (prev.secondaryIps || []).filter(ip => ip !== vipIp)
                }));
            }
        } catch (err) {
            console.error('Failed to unlink VIP:', err);
            showToast?.('Failed to unlink VIP', 'error');
        }
    };

    const resetAllFilters = () => {
        setSearch('');
        setEnvFilter('all');
        setZoneFilter('all');
        setBuFilter('all');
        setCurrentPage(1);
    };

    const hasActiveFilters = search || envFilter !== 'all' || zoneFilter !== 'all' || buFilter !== 'all';

    // Helper to render table cell by column key
    const renderTableCell = (colKey, srv) => {
        switch (colKey) {
            case 'ip':
                return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {String(srv.os).toLowerCase().includes('win') ? (
                            <FaWindows style={{ color: '#3b82f6', fontSize: 16 }} />
                        ) : String(srv.os).toLowerCase().includes('linux') || String(srv.os).toLowerCase().includes('ubuntu') ? (
                            <FaLinux style={{ color: '#facc15', fontSize: 16 }} />
                        ) : (
                            <FiServer style={{ color: 'var(--accent-primary)', fontSize: 16 }} />
                        )}
                        <div>
                            <div style={{ fontWeight: 800, fontFamily: 'monospace', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                {srv.ip}
                                {srv.secondaryIps && srv.secondaryIps.length > 0 && (
                                    <span style={{ fontSize: 10, padding: '1px 6px', background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: 4, fontWeight: 800 }} title={`Dual-NIC / VIP associated IPs: ${srv.secondaryIps.join(', ')}`}>
                                        🔗 +{srv.secondaryIps.length} VIP
                                    </span>
                                )}
                                {srv.hardwareDrift && (
                                    <span style={{ fontSize: 10, padding: '1px 6px', background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 4, fontWeight: 900 }} title={srv.driftDetails ? srv.driftDetails.join(' | ') : 'Hardware drift detected'}>
                                        ⚡ Drift
                                    </span>
                                )}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {srv.hostname || 'N/A'} {srv.fqdn ? `(${srv.fqdn})` : ''}
                            </div>
                        </div>
                    </div>
                );
            case 'applicationName':
                return (
                    <span style={{ fontWeight: 700, color: srv.applicationName ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {srv.applicationName || 'Unassigned'}
                    </span>
                );
            case 'businessUnit':
                return (
                    <span style={{ fontSize: 12, color: srv.businessUnit ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                        {srv.businessUnit || 'Unassigned'}
                    </span>
                );
            case 'zone':
                const str = srv.zone || 'Intranet';
                let hash = 0;
                for (let i = 0; i < str.length; i++) { hash = str.charCodeAt(i) + ((hash << 5) - hash); }
                const h = Math.abs(hash) % 360;
                return (
                    <span style={{ ...styles.badge, background: `hsla(${h}, 70%, 60%, 0.15)`, color: `hsl(${h}, 70%, 70%)`, border: `1px solid hsla(${h}, 70%, 60%, 0.3)` }}>
                        🌐 {str}
                    </span>
                );
            case 'envName':
                return (
                    <span style={{
                        ...styles.badge,
                        background: `${srv.envColor}22`,
                        color: srv.envColor,
                        border: `1px solid ${srv.envColor}44`
                    }}>
                        {srv.envName}
                        {srv.envIsProduction && <span title="Production environment" style={{ marginLeft: 4, fontWeight: 900 }}>●</span>}
                        {!srv.envId && srv.envUnmapped && <span title={`Stored value "${srv.envUnmapped}" is not in Settings -> Environments`} style={{ marginLeft: 4 }}>⚠</span>}
                    </span>
                );
            case 'scoutStatus':
                return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {srv.scoutStatus === 'online' ? (
                            <span style={{ ...styles.badge, background: 'rgba(16, 185, 129, 0.15)', color: '#10b981' }}>
                                🟢 Scout Online
                            </span>
                        ) : srv.scoutStatus === 'offline' ? (
                            <span style={{ ...styles.badge, background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}>
                                🔴 Scout Offline
                            </span>
                        ) : (
                            <span style={{ ...styles.badge, background: 'rgba(156, 163, 175, 0.15)', color: '#9ca3af' }}>
                                ⚪ Not Installed
                            </span>
                        )}
                    </div>
                );
            case 'prometheusStatus':
                const isPromScraped = srv.prometheusStatus === 'scraped' || srv.prometheusStatus === true || srv.isPrometheusScraped;
                return (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {isPromScraped && (
                            <span style={{ ...styles.badge, background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' }}>
                                🎯 Prom
                            </span>
                        )}
                        {srv.hasRedis && (
                            <span style={{ ...styles.badge, background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444' }}>
                                📕 Redis ({srv.redisInstances.length})
                            </span>
                        )}
                        {!isPromScraped && !srv.hasRedis && (
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>-</span>
                        )}
                    </div>
                );
            case 'datacenterName':
                return srv.datacenterName ? (
                    <div>
                        <div style={{ fontSize: 11, fontWeight: 700 }}>{srv.datacenterName}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{srv.rackId} ({srv.unitPosition})</div>
                    </div>
                ) : <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>-</span>;
            case 'os':
                const cpuVal = srv.cpuCores || srv.cpu;
                const ramVal = srv.memoryGB || srv.ram || srv.mem;
                const diskVal = srv.diskGB || srv.disk;
                return (
                    <div>
                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{srv.os || 'Unknown OS'}</div>
                        {(cpuVal || ramVal || diskVal) ? (
                            <div style={{ fontSize: 11, color: srv.hardwareDrift ? '#ef4444' : 'var(--text-muted)', fontWeight: srv.hardwareDrift ? 800 : 500, marginTop: 2 }}>
                                {cpuVal ? `${cpuVal}C` : ''}{cpuVal && ramVal ? ' / ' : ''}{ramVal ? `${ramVal}GB RAM` : ''}{diskVal ? ` / ${diskVal}G` : ''} {srv.hardwareDrift && '⚡ Drift'}
                            </div>
                        ) : (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>-</div>
                        )}
                    </div>
                );
            default:
                return null;
        }
    };

    return (
        <div style={styles.container}>
            {/* Top Header & Page Customization Toggle Button */}
            <div style={styles.header}>
                <div>
                    <h2 style={styles.title}>💻 Server List (Simplified CMDB)</h2>
                    <p style={styles.subtitle}>Unified server inventory correlating Scout Monitor, Prometheus, Redis, IPAM & Data Centers</p>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <button 
                        style={{
                            ...styles.btnSecondary,
                            background: isPageEditMode ? 'var(--accent-primary)' : 'rgba(255, 255, 255, 0.05)',
                            color: isPageEditMode ? '#fff' : 'var(--text-primary)',
                            borderColor: isPageEditMode ? 'var(--accent-primary)' : 'var(--border-color)',
                            boxShadow: isPageEditMode ? '0 0 12px rgba(99, 102, 241, 0.4)' : 'none'
                        }}
                        onClick={() => {
                            const nextState = !isPageEditMode;
                            setIsPageEditMode(nextState);
                            if (!nextState) {
                                setShowColumnDropdown(false);
                                showToast?.('Layout preferences saved to browser', 'success');
                            }
                        }}
                    >
                        <FiEdit3 size={15} /> {isPageEditMode ? 'Done Editing' : 'Edit Mode'}
                    </button>

                    {isPageEditMode && (
                        <>
                            <button 
                                style={{ 
                                    ...styles.btnSecondary, 
                                    background: 'rgba(245, 158, 11, 0.15)', 
                                    color: '#f59e0b', 
                                    borderColor: 'rgba(245, 158, 11, 0.35)',
                                    fontWeight: 800
                                }} 
                                onClick={() => setShowDiffModal(true)}
                                title="Paste Excel specifications (200~300+ servers) to compare with Server List CMDB"
                            >
                                <FiLayers size={14} /> 📋 Excel Batch Diff (比對表)
                            </button>
                            <button style={{ ...styles.btnSecondary, background: 'rgba(99, 102, 241, 0.1)', color: 'var(--accent-primary)', borderColor: 'rgba(99, 102, 241, 0.3)' }} onClick={handleGlobalSync} disabled={isGlobalSyncing || loading}>
                                <FiRefreshCw className={isGlobalSyncing ? 'spin' : ''} size={14} /> {isGlobalSyncing ? 'Syncing...' : 'Global Auto-Sync'}
                            </button>
                            <button 
                                style={{ 
                                    ...styles.btnSecondary, 
                                    background: 'rgba(16, 185, 129, 0.12)', 
                                    color: '#10b981', 
                                    borderColor: 'rgba(16, 185, 129, 0.3)',
                                    fontWeight: 800
                                }} 
                                onClick={() => setShowAuthorityModal(true)}
                                title="CMDB 欄位權威與資料覆蓋規則設定 (Field Authority & Overwrite Policy)"
                            >
                                <FiSliders size={14} /> ⚙️ 欄位權威 (Field Authority)
                            </button>
                        </>
                    )}

                    {role !== 'Viewer' && (
                        <button style={styles.btnSecondary} onClick={() => setShowDeletedModal(true)} title="Show servers deleted from Server List and restore them">
                            <FiTrash2 size={14} /> Deleted servers
                        </button>
                    )}

                    <button style={styles.btnSecondary} onClick={fetchServers} disabled={loading}>
                        <FiRefreshCw className={loading ? 'spin' : ''} size={14} /> Refresh
                    </button>
                </div>
            </div>

            {/* KPI Cards Header */}
            <div style={styles.kpiGrid}>
                {(visibleKpis.totalServers || isPageEditMode) && (
                    <div 
                        style={{
                            ...styles.kpiCard,
                            opacity: visibleKpis.totalServers ? 1 : 0.45,
                            border: isPageEditMode ? (visibleKpis.totalServers ? '1px dashed var(--accent-primary)' : '1px dashed rgba(255,255,255,0.2)') : '1px solid var(--border-color)',
                            cursor: isPageEditMode ? 'pointer' : 'default'
                        }}
                        onClick={() => isPageEditMode && toggleKpi('totalServers')}
                    >
                        <div style={styles.kpiHeader}>
                            <span style={styles.kpiLabel}>TOTAL SERVERS</span>
                            {isPageEditMode ? (
                                <span style={{ color: visibleKpis.totalServers ? '#10b981' : 'var(--text-muted)', fontSize: 13 }}>
                                    {visibleKpis.totalServers ? <FiEye size={16} /> : <FiEyeOff size={16} />}
                                </span>
                            ) : (
                                <FiServer style={{ color: 'var(--accent-primary)', fontSize: 18 }} />
                            )}
                        </div>
                        <div style={styles.kpiValue}>{stats.total}</div>
                        <div style={styles.kpiSub}>Online Rate: <span style={{ color: '#10b981', fontWeight: 800 }}>{stats.onlineRate}%</span></div>
                    </div>
                )}

                {(visibleKpis.scoutMonitored || isPageEditMode) && (
                    <div 
                        style={{
                            ...styles.kpiCard,
                            opacity: visibleKpis.scoutMonitored ? 1 : 0.45,
                            border: isPageEditMode ? (visibleKpis.scoutMonitored ? '1px dashed var(--accent-primary)' : '1px dashed rgba(255,255,255,0.2)') : '1px solid var(--border-color)',
                            cursor: isPageEditMode ? 'pointer' : 'default'
                        }}
                        onClick={() => isPageEditMode && toggleKpi('scoutMonitored')}
                    >
                        <div style={styles.kpiHeader}>
                            <span style={styles.kpiLabel}>SCOUT MONITORED</span>
                            {isPageEditMode ? (
                                <span style={{ color: visibleKpis.scoutMonitored ? '#10b981' : 'var(--text-muted)', fontSize: 13 }}>
                                    {visibleKpis.scoutMonitored ? <FiEye size={16} /> : <FiEyeOff size={16} />}
                                </span>
                            ) : (
                                <FiActivity style={{ color: '#3b82f6', fontSize: 18 }} />
                            )}
                        </div>
                        <div style={styles.kpiValue}>{stats.scoutCovered}</div>
                        <div style={styles.kpiSub}>Coverage: <span style={{ color: '#3b82f6', fontWeight: 800 }}>{stats.scoutRate}%</span></div>
                    </div>
                )}

                {(visibleKpis.prometheusScraped || isPageEditMode) && (
                    <div 
                        style={{
                            ...styles.kpiCard,
                            opacity: visibleKpis.prometheusScraped ? 1 : 0.45,
                            border: isPageEditMode ? (visibleKpis.prometheusScraped ? '1px dashed var(--accent-primary)' : '1px dashed rgba(255,255,255,0.2)') : '1px solid var(--border-color)',
                            cursor: isPageEditMode ? 'pointer' : 'default'
                        }}
                        onClick={() => isPageEditMode && toggleKpi('prometheusScraped')}
                    >
                        <div style={styles.kpiHeader}>
                            <span style={styles.kpiLabel}>PROMETHEUS SCRAPED</span>
                            {isPageEditMode ? (
                                <span style={{ color: visibleKpis.prometheusScraped ? '#10b981' : 'var(--text-muted)', fontSize: 13 }}>
                                    {visibleKpis.prometheusScraped ? <FiEye size={16} /> : <FiEyeOff size={16} />}
                                </span>
                            ) : (
                                <FiLayers style={{ color: '#f59e0b', fontSize: 18 }} />
                            )}
                        </div>
                        <div style={styles.kpiValue}>{stats.promCovered}</div>
                        <div style={styles.kpiSub}>Scrape Coverage: <span style={{ color: '#f59e0b', fontWeight: 800 }}>{stats.promRate}%</span></div>
                    </div>
                )}

                {(visibleKpis.redisDeployed || isPageEditMode) && (
                    <div 
                        style={{
                            ...styles.kpiCard,
                            opacity: visibleKpis.redisDeployed ? 1 : 0.45,
                            border: isPageEditMode ? (visibleKpis.redisDeployed ? '1px dashed var(--accent-primary)' : '1px dashed rgba(255,255,255,0.2)') : '1px solid var(--border-color)',
                            cursor: isPageEditMode ? 'pointer' : 'default'
                        }}
                        onClick={() => isPageEditMode && toggleKpi('redisDeployed')}
                    >
                        <div style={styles.kpiHeader}>
                            <span style={styles.kpiLabel}>REDIS DEPLOYED</span>
                            {isPageEditMode ? (
                                <span style={{ color: visibleKpis.redisDeployed ? '#10b981' : 'var(--text-muted)', fontSize: 13 }}>
                                    {visibleKpis.redisDeployed ? <FiEye size={16} /> : <FiEyeOff size={16} />}
                                </span>
                            ) : (
                                <FiDatabase style={{ color: '#ef4444', fontSize: 18 }} />
                            )}
                        </div>
                        <div style={styles.kpiValue}>{stats.redisCount}</div>
                        <div style={styles.kpiSub}>Active Redis Nodes</div>
                    </div>
                )}
            </div>

            {/* Unified All-in-One Filter Bar */}
            <div style={styles.allInOneBar}>
                <div style={styles.allInOneSearchBlock}>
                    <FiSearch size={16} style={{ color: 'var(--text-muted)' }} />
                    <input 
                        type="text" 
                        placeholder="Search IP, Hostname, FQDN, Application, Business Unit, Platform..." 
                        value={search}
                        onChange={e => { setSearch(e.target.value); setCurrentPage(1); }}
                        style={styles.allInOneSearchInput}
                    />
                </div>

                <div style={styles.allInOneFilterGroup}>
                    {/* Environment Filter */}
                    <div style={styles.inlineSelectWrapper}>
                        <span style={styles.inlineSelectLabel}>Env:</span>
                        <select 
                            value={envFilter} 
                            onChange={e => { setEnvFilter(e.target.value); setCurrentPage(1); }}
                            style={styles.inlineSelect}
                        >
                            <option value="all" style={styles.inlineOption}>All Environments</option>
                            {environments.map(e => (
                                <option key={e.id || e.name} value={e.id || e.name} style={styles.inlineOption}>{e.name}</option>
                            ))}
                        </select>
                    </div>

                    {/* Platform Filter */}
                    <div style={styles.inlineSelectWrapper}>
                        <span style={styles.inlineSelectLabel}>Platform:</span>
                        <select 
                            value={zoneFilter} 
                            onChange={e => { setZoneFilter(e.target.value); setCurrentPage(1); }}
                            style={styles.inlineSelect}
                        >
                            <option value="all" style={styles.inlineOption}>All Platforms</option>
                            {availableZones.map(z => (
                                <option key={z} value={z} style={styles.inlineOption}>{z}</option>
                            ))}
                        </select>
                    </div>

                    {/* Business Unit (BU) Filter */}
                    <div style={styles.inlineSelectWrapper}>
                        <span style={styles.inlineSelectLabel}>BU:</span>
                        <select 
                            value={buFilter} 
                            onChange={e => { setBuFilter(e.target.value); setCurrentPage(1); }}
                            style={styles.inlineSelect}
                        >
                            <option value="all" style={styles.inlineOption}>All BUs</option>
                            {availableBUs.map(bu => (
                                <option key={bu} value={bu} style={styles.inlineOption}>{bu}</option>
                            ))}
                        </select>
                    </div>

                    {/* View Mode Toggle Segmented Control */}
                    <div style={{ display: 'flex', border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden', padding: 2, background: 'rgba(0,0,0,0.2)' }}>
                        <button 
                            style={{
                                padding: '4px 10px',
                                fontSize: 12,
                                border: 'none',
                                background: viewMode === 'table' ? 'var(--accent-primary)' : 'transparent',
                                color: viewMode === 'table' ? '#fff' : 'var(--text-muted)',
                                cursor: 'pointer',
                                borderRadius: 6,
                                fontWeight: 800
                            }}
                            onClick={() => setViewMode('table')}
                        >
                            📋 Table
                        </button>
                        <button 
                            style={{
                                padding: '4px 10px',
                                fontSize: 12,
                                border: 'none',
                                background: viewMode === 'matrix' ? 'var(--accent-primary)' : 'transparent',
                                color: viewMode === 'matrix' ? '#fff' : 'var(--text-muted)',
                                cursor: 'pointer',
                                borderRadius: 6,
                                fontWeight: 800
                            }}
                            onClick={() => setViewMode('matrix')}
                        >
                            🧱 Matrix
                        </button>
                    </div>

                    {/* Matrix Group By Selector */}
                    {viewMode === 'matrix' && (
                        <div style={styles.inlineSelectWrapper}>
                            <span style={styles.inlineSelectLabel}>Group By:</span>
                            <select value={matrixGroupBy} onChange={e => setMatrixGroupBy(e.target.value)} style={styles.inlineSelect}>
                                <option value="businessUnit" style={styles.inlineOption}>BU / Owner</option>
                                <option value="zone" style={styles.inlineOption}>Zone / Network</option>
                                <option value="envName" style={styles.inlineOption}>Environment</option>
                                <option value="datacenterName" style={styles.inlineOption}>Data Center</option>
                            </select>
                        </div>
                    )}

                    {/* 1. Columns Button appears ONLY when isPageEditMode === true */}
                    {isPageEditMode && (
                        <div style={{ position: 'relative' }}>
                            <button 
                                style={{
                                    ...styles.btnSecondary,
                                    padding: '5px 12px',
                                    fontSize: 12,
                                    background: showColumnDropdown ? 'var(--accent-primary)' : 'rgba(255, 255, 255, 0.08)',
                                    color: showColumnDropdown ? '#fff' : 'var(--text-primary)',
                                    borderColor: 'var(--accent-primary)'
                                }} 
                                onClick={() => setShowColumnDropdown(!showColumnDropdown)}
                            >
                                <FiSliders size={13} /> Columns
                            </button>

                            {/* 2. Columns Popover with Checkbox+Text aligned Left and Up/Down Buttons aligned Right */}
                            {showColumnDropdown && (
                                <div style={styles.columnDropdownPopover}>
                                    <div style={{ fontSize: 11, fontWeight: 900, color: 'var(--accent-primary)', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <span>CUSTOMIZE & REORDER COLUMNS</span>
                                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                            <button 
                                                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                                                onClick={resetLayoutToDefault}
                                                title="Reset Layout to Default"
                                            >
                                                Reset
                                            </button>
                                            <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }} onClick={() => setShowColumnDropdown(false)}>
                                                <FiX size={14} />
                                            </button>
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
                                        {columnOrder.map((colKey, index) => (
                                            <div key={colKey} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
                                                {/* Strictly Left-Aligned Checkbox + Text */}
                                                <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 10, flex: 1, cursor: 'pointer', textAlign: 'left', margin: 0, overflow: 'hidden' }}>
                                                    <input 
                                                        type="checkbox" 
                                                        checked={visibleColumns[colKey] !== false} 
                                                        onChange={() => toggleColumn(colKey)} 
                                                        style={{ cursor: 'pointer', margin: 0, width: 16, height: 16, flexShrink: 0 }}
                                                    />
                                                    <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', textAlign: 'left', display: 'block' }}>
                                                        {COLUMN_LABELS[colKey] || colKey}
                                                    </span>
                                                </label>

                                                {/* Right Aligned Up/Down Reorder Buttons */}
                                                <div style={{ display: 'flex', gap: 4, marginLeft: 12, flexShrink: 0 }}>
                                                    <button 
                                                        disabled={index === 0}
                                                        onClick={() => moveColumn(index, -1)}
                                                        style={styles.reorderBtn}
                                                        title="Move Up"
                                                    >
                                                        <FiArrowUp size={11} />
                                                    </button>
                                                    <button 
                                                        disabled={index === columnOrder.length - 1}
                                                        onClick={() => moveColumn(index, 1)}
                                                        style={styles.reorderBtn}
                                                        title="Move Down"
                                                    >
                                                        <FiArrowDown size={11} />
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {hasActiveFilters && (
                        <button style={styles.clearFilterBtn} onClick={resetAllFilters}>
                            <FiX size={12} /> Clear Filters
                        </button>
                    )}
                </div>
            </div>

            {/* Bulk Selection Floating Action Bar */}
            {selectedIps.length > 0 && (
                <div style={styles.bulkFloatingBar}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={styles.bulkBadge}>{selectedIps.length} Servers Selected</span>
                        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Choose an action to perform bulk updates across all selected hosts</span>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <button style={styles.btnSecondary} onClick={() => setSelectedIps([])}>
                            Deselect All
                        </button>
                        <button style={styles.btnPrimary} onClick={() => setShowBulkEditModal(true)}>
                            <FiEdit3 size={14} /> Bulk Edit CMDB Metadata
                        </button>
                        <button 
                            style={{ ...styles.btnPrimary, background: '#ef4444', borderColor: '#ef4444' }} 
                            onClick={openBulkDeleteModal}
                        >
                            <FiTrash2 size={14} /> Delete Selected ({selectedIps.length})
                        </button>
                    </div>
                </div>
            )}

            {/* View Mode Switching: Table View vs Matrix View */}
            {viewMode === 'table' ? (
                <>
                    {/* Server CMDB Table */}
                    <div style={styles.tableWrapper}>
                        <table style={styles.table}>
                            <thead>
                                <tr>
                                    {isPageEditMode && (
                                        <th style={{ ...styles.th, width: 40, textAlign: 'center' }}>
                                            <input 
                                                type="checkbox" 
                                                checked={pagedServers.length > 0 && selectedIps.length === pagedServers.length}
                                                onChange={e => handleSelectAll(e.target.checked)}
                                                style={{ cursor: 'pointer' }}
                                            />
                                        </th>
                                    )}
                                    {activeColumns.map(colKey => (
                                        <th key={colKey} style={styles.th} onClick={() => handleSort(colKey)}>
                                            {COLUMN_LABELS[colKey] || colKey.toUpperCase()} {sortField === colKey ? (sortDirection === 'asc' ? '▲' : '▼') : ''}
                                        </th>
                                    ))}
                                    <th style={{ ...styles.th, textAlign: 'right' }}>ACTIONS</th>
                                </tr>
                            </thead>
                            <tbody>
                                {loading ? (
                                    <tr>
                                        <td colSpan={activeColumns.length + 2} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                            Loading Server CMDB Data...
                                        </td>
                                    </tr>
                                ) : pagedServers.length === 0 ? (
                                    <tr>
                                        <td colSpan={activeColumns.length + 2} style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                            No servers match the selected criteria.
                                        </td>
                                    </tr>
                                ) : (
                                    pagedServers.map((srv, idx) => {
                                        const isSelected = selectedIps.includes(srv.ip);
                                        return (
                                            <tr 
                                                key={srv.ip || idx} 
                                                style={{
                                                    ...styles.tr,
                                                    background: isSelected ? 'rgba(59, 130, 246, 0.08)' : 'transparent'
                                                }} 
                                                onClick={() => openServerDrawer(srv)}
                                            >
                                                {isPageEditMode && (
                                                    <td style={{ ...styles.td, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                                                        <input 
                                                            type="checkbox" 
                                                            checked={isSelected}
                                                            onChange={e => handleSelectRow(srv.ip, e.target.checked)}
                                                            style={{ cursor: 'pointer' }}
                                                        />
                                                    </td>
                                                )}

                                                {activeColumns.map(colKey => (
                                                    <td key={colKey} style={styles.td}>
                                                        {renderTableCell(colKey, srv)}
                                                    </td>
                                                ))}

                                                {/* Actions */}
                                                <td style={{ ...styles.td, textAlign: 'right' }}>
                                                    <div style={{ display: 'inline-flex', gap: 6 }} onClick={e => e.stopPropagation()}>
                                                        <button 
                                                            style={styles.btnIcon}
                                                            title="View Integration Modal"
                                                            onClick={() => setSharedModalHost({ ip: srv.ip, hostname: srv.hostname })}
                                                        >
                                                            <FiEye size={14} />
                                                        </button>
                                                        {isPageEditMode && (
                                                            <>
                                                                <button 
                                                                    style={styles.btnIcon}
                                                                    title="Edit CMDB Meta & Drawer"
                                                                    onClick={() => {
                                                                        openServerDrawer(srv);
                                                                        setIsEditingMeta(true);
                                                                    }}
                                                                >
                                                                    <FiEdit3 size={14} />
                                                                </button>
                                                                <button 
                                                                    style={{ ...styles.btnIcon, color: '#ef4444' }}
                                                                    title="Delete Server from Server List"
                                                                    onClick={() => openSingleDeleteModal(srv)}
                                                                >
                                                                    <FiTrash2 size={14} />
                                                                </button>
                                                            </>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination Row */}
                    <div style={styles.paginationRow}>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            Showing {filteredServers.length > 0 ? (currentPage - 1) * pageSize + 1 : 0} to {Math.min(currentPage * pageSize, filteredServers.length)} of {filteredServers.length} servers
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <button 
                                disabled={currentPage <= 1}
                                onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                                style={styles.pageBtn}
                            >
                                Previous
                            </button>
                            <span style={{ fontSize: 12, fontWeight: 800 }}>{currentPage} / {totalPages}</span>
                            <button 
                                disabled={currentPage >= totalPages}
                                onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                                style={styles.pageBtn}
                            >
                                Next
                            </button>
                        </div>
                    </div>
                </>
            ) : (
                /* FEAT-04: Matrix Grouped Card View */
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {Object.keys(groupedMatrix).length === 0 ? (
                        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', background: 'var(--bg-glass)', borderRadius: 16 }}>
                            No servers match the selected criteria.
                        </div>
                    ) : (
                        Object.entries(groupedMatrix).map(([groupName, groupServers]) => {
                            const onlineCount = groupServers.filter(s => s.status === 'alive' || s.scoutStatus === 'online').length;
                            const onlineRate = groupServers.length > 0 ? Math.round((onlineCount / groupServers.length) * 100) : 0;

                            return (
                                <div key={groupName} style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 20 }}>
                                    {/* Group Header */}
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900, color: 'var(--text-primary)' }}>
                                                🏢 {groupName}
                                            </h3>
                                            <span style={{ padding: '2px 8px', borderRadius: 6, background: 'var(--accent-primary)', color: '#fff', fontSize: 11, fontWeight: 900 }}>
                                                {groupServers.length} Servers
                                            </span>
                                        </div>
                                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                            Online Rate: <strong style={{ color: '#10b981' }}>{onlineRate}%</strong> ({onlineCount}/{groupServers.length})
                                        </div>
                                    </div>

                                    {/* Server Cards Grid */}
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                                        {groupServers.map(srv => {
                                            const isSelected = selectedIps.includes(srv.ip);
                                            return (
                                                <div 
                                                    key={srv.ip}
                                                    style={{
                                                        background: isSelected ? 'rgba(59, 130, 246, 0.12)' : 'rgba(255, 255, 255, 0.03)',
                                                        border: srv.hardwareDrift ? '1px solid #ef4444' : (isSelected ? '1px solid var(--accent-primary)' : '1px solid var(--border-color)'),
                                                        borderRadius: 12,
                                                        padding: 14,
                                                        cursor: 'pointer',
                                                        transition: 'all 0.2s',
                                                        position: 'relative'
                                                    }}
                                                    onClick={() => openServerDrawer(srv)}
                                                >
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                            {String(srv.os).toLowerCase().includes('win') ? (
                                                                <FaWindows style={{ color: '#3b82f6', fontSize: 18 }} />
                                                            ) : String(srv.os).toLowerCase().includes('linux') ? (
                                                                <FaLinux style={{ color: '#facc15', fontSize: 18 }} />
                                                            ) : (
                                                                <FiServer style={{ color: 'var(--accent-primary)', fontSize: 18 }} />
                                                            )}
                                                            <div>
                                                                <div style={{ fontWeight: 900, fontFamily: 'monospace', fontSize: 14, color: 'var(--text-primary)' }}>{srv.ip}</div>
                                                                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{srv.hostname || 'N/A'}</div>
                                                            </div>
                                                        </div>
                                                        <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: srv.scoutStatus === 'online' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)', color: srv.scoutStatus === 'online' ? '#10b981' : '#ef4444', fontWeight: 800 }}>
                                                            {srv.scoutStatus === 'online' ? '🟢 Scout' : '🔴 Scout Off'}
                                                        </span>
                                                    </div>

                                                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                                        <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(99,102,241,0.15)', color: '#818cf8', fontWeight: 700 }}>{srv.zone || 'Intranet'}</span>
                                                        <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)' }}>{srv.applicationName || 'Unassigned'}</span>
                                                    </div>

                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                                                        <span style={{ color: srv.hardwareDrift ? '#ef4444' : 'var(--text-muted)', fontWeight: srv.hardwareDrift ? 800 : 500 }}>
                                                            {srv.cpuCores}C / {srv.memoryGB}GB RAM {srv.hardwareDrift && '⚡ Drift'}
                                                        </span>
                                                        {srv.secondaryIps && srv.secondaryIps.length > 0 && (
                                                            <span style={{ color: '#3b82f6', fontWeight: 800 }} title={`Dual-NIC associated IPs: ${srv.secondaryIps.join(', ')}`}>
                                                                🔗 +{srv.secondaryIps.length} NIC
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>
            )}

            {/* Bulk Edit CMDB Metadata Modal */}
            {showBulkEditModal && (
                <div style={styles.modalOverlay} onClick={() => setShowBulkEditModal(false)}>
                    <div style={styles.modalContent} onClick={e => e.stopPropagation()}>
                        <div style={styles.modalHeader}>
                            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>✏️ Bulk Edit CMDB Metadata ({selectedIps.length} Servers)</h3>
                            <button style={styles.closeBtn} onClick={() => setShowBulkEditModal(false)}><FiX size={18} /></button>
                        </div>
                        <form onSubmit={handleSaveBulkMeta} style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                            <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                                Specify fields to update across all {selectedIps.length} selected servers. Leave fields empty to keep existing values.
                            </p>

                            <div style={styles.grid2}>
                                <div>
                                    <label style={styles.fieldLabel}>Application Name (Syncs IPAM & Prom)</label>
                                    <input 
                                        type="text" 
                                        style={styles.input} 
                                        placeholder="Leave empty to keep unchanged" 
                                        value={bulkEditForm.applicationName}
                                        onChange={e => setBulkEditForm({ ...bulkEditForm, applicationName: e.target.value })}
                                    />
                                </div>

                                <div>
                                    <label style={styles.fieldLabel}>Business Unit / Owner (Syncs IPAM & Prom)</label>
                                    <input 
                                        type="text" 
                                        style={styles.input} 
                                        placeholder="Leave empty to keep unchanged" 
                                        value={bulkEditForm.businessUnit}
                                        onChange={e => setBulkEditForm({ ...bulkEditForm, businessUnit: e.target.value })}
                                    />
                                </div>

                                <div>
                                    <label style={styles.fieldLabel}>Platform</label>
                                    <input 
                                        type="text" 
                                        style={styles.input} 
                                        placeholder="e.g. VMware, AWS, Nutanix" 
                                        value={bulkEditForm.zone}
                                        onChange={e => setBulkEditForm({ ...bulkEditForm, zone: e.target.value })}
                                    />
                                </div>

                                <div>
                                    <label style={styles.fieldLabel}>Environment</label>
                                    <select 
                                        style={styles.select}
                                        value={bulkEditForm.envId}
                                        onChange={e => setBulkEditForm({ ...bulkEditForm, envId: e.target.value })}
                                    >
                                        <option value="">-- Keep Unchanged --</option>
                                        {environments.map(env => (
                                            <option key={env.id} value={env.id}>{env.name}</option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <label style={styles.fieldLabel}>Criticality Tier</label>
                                    <select 
                                        style={styles.select}
                                        value={bulkEditForm.criticality}
                                        onChange={e => setBulkEditForm({ ...bulkEditForm, criticality: e.target.value })}
                                    >
                                        <option value="">-- Keep Unchanged --</option>
                                        <option value="Tier 1 - Mission Critical">Tier 1 - Mission Critical</option>
                                        <option value="Tier 2 - Business Operational">Tier 2 - Business Operational</option>
                                        <option value="Tier 3 - Non-critical">Tier 3 - Non-critical</option>
                                    </select>
                                </div>

                                <div>
                                    <label style={styles.fieldLabel}>Maintenance Window</label>
                                    <input 
                                        type="text" 
                                        style={styles.input} 
                                        placeholder="e.g. Sun 02:00 - 04:00" 
                                        value={bulkEditForm.maintenanceWindow}
                                        onChange={e => setBulkEditForm({ ...bulkEditForm, maintenanceWindow: e.target.value })}
                                    />
                                </div>
                            </div>

                            <div>
                                <label style={styles.fieldLabel}>Purpose / Description Notes</label>
                                <textarea 
                                    style={styles.textarea} 
                                    rows="2"
                                    placeholder="Leave empty to keep unchanged" 
                                    value={bulkEditForm.purpose}
                                    onChange={e => setBulkEditForm({ ...bulkEditForm, purpose: e.target.value })}
                                />
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
                                <button type="button" style={styles.btnSecondary} onClick={() => setShowBulkEditModal(false)}>
                                    Cancel
                                </button>
                                <button type="submit" style={styles.btnPrimary} disabled={isBulkSaving}>
                                    {isBulkSaving ? 'Bulk Updating...' : `Apply to ${selectedIps.length} Servers`}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* 360° CMDB Server Detail & Edit Drawer */}
            {selectedServer && (
                <div style={styles.overlay} onClick={() => setSelectedServer(null)}>
                    <div style={styles.drawer} onClick={e => e.stopPropagation()}>
                        <div style={styles.drawerHeader}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <div style={styles.avatarIcon}>
                                    <FiServer size={20} style={{ color: 'var(--accent-primary)' }} />
                                </div>
                                <div>
                                    <h3 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>{selectedServer.ip}</h3>
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                        {selectedServer.hostname || 'No Hostname'} {selectedServer.fqdn ? `• ${selectedServer.fqdn}` : ''}
                                    </div>
                                </div>
                            </div>
                            <button style={styles.closeBtn} onClick={() => setSelectedServer(null)}>
                                <FiX size={18} />
                            </button>
                        </div>

                        <div style={styles.drawerBody}>
                            {/* FEAT-05: Hardware Drift Alert Banner */}
                            {selectedServer.hardwareDrift && (
                                <div style={{ padding: 14, borderRadius: 10, background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444' }}>
                                    <div style={{ fontSize: 13, fontWeight: 900, marginBottom: 4 }}>⚡ Hardware Drift Detected</div>
                                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                                        {selectedServer.driftDetails ? selectedServer.driftDetails.join(' | ') : 'Scanned hardware specs differ from CMDB metadata record.'}
                                    </div>
                                </div>
                            )}

                            {/* BUG-03: Dual-NIC / VIP Secondary IPs Banner */}
                            {selectedServer.secondaryIps && selectedServer.secondaryIps.length > 0 && (
                                <div style={{ padding: 14, borderRadius: 10, background: 'rgba(59, 130, 246, 0.12)', border: '1px solid rgba(59, 130, 246, 0.3)', color: '#3b82f6' }}>
                                    <div style={{ fontSize: 13, fontWeight: 900, marginBottom: 4 }}>🔗 Associated Multi-NIC / VIP IPs</div>
                                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>
                                        The following VIP / secondary IP(s) belong to host <strong>{selectedServer.hostname}</strong> and are grouped under this primary server:
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                        {selectedServer.secondaryIps.map(secIp => (
                                            <div key={secIp} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', background: 'rgba(59, 130, 246, 0.2)', borderRadius: 6, fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color: '#60a5fa' }}>
                                                <span>🌐 {secIp}</span>
                                                {role !== 'Viewer' && (
                                                    <button 
                                                        style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 11, padding: '0 2px' }}
                                                        title="Unlink VIP from this server"
                                                        onClick={() => handleUnlinkVip(secIp)}
                                                    >
                                                        ✕
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Hardware & OS Specifications PLACED AT VERY TOP */}
                            <div style={styles.sectionCard}>
                                <h4 style={styles.sectionTitle}>💻 Hardware & OS Specifications</h4>
                                <div style={styles.grid2}>
                                    <div>
                                        <span style={styles.fieldLabel}>Operating System</span>
                                        <div style={styles.fieldValue}>{selectedServer.os || 'Unknown OS'}</div>
                                    </div>
                                    <div>
                                        <span style={styles.fieldLabel}>CPU & Cores</span>
                                        <div style={styles.fieldValue}>{selectedServer.cpuCores} Cores ({selectedServer.arch || 'x64'})</div>
                                    </div>
                                    <div>
                                        <span style={styles.fieldLabel}>Memory (RAM)</span>
                                        <div style={styles.fieldValue}>{selectedServer.memoryGB} GB</div>
                                    </div>
                                    <div>
                                        <span style={styles.fieldLabel}>Storage (Total Disk)</span>
                                        <div style={styles.fieldValue}>
                                            {selectedServer.diskGB ? `${Math.round(selectedServer.diskGB)} GB` : 'N/A'}
                                            {selectedServer.diskDetails && selectedServer.diskDetails.length > 0 && (
                                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                                                    {selectedServer.diskDetails.map(d => `${d.mount}: ${Math.round(d.totalGB || 0)}GB`).join(' / ')}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div>
                                        <span style={styles.fieldLabel}>MAC Address</span>
                                        <div style={styles.fieldValue}>{selectedServer.mac || 'N/A'}</div>
                                    </div>
                                    <div>
                                        <span style={styles.fieldLabel}>Vendor / Hypervisor</span>
                                        <div style={styles.fieldValue}>{selectedServer.vendor || 'N/A'}</div>
                                    </div>
                                    <div>
                                        <span style={styles.fieldLabel}>Last Discovery Scan</span>
                                        <div style={styles.fieldValue}>{selectedServer.lastScan || 'N/A'}</div>
                                    </div>
                                    <div>
                                        <span style={styles.fieldLabel}>Serial Number (SN)</span>
                                        <div style={{ ...styles.fieldValue, color: '#93c5fd', fontFamily: 'monospace' }}>{selectedServer.sn || 'N/A'}</div>
                                    </div>
                                    <div>
                                        <span style={styles.fieldLabel}>iLO / OOB IP</span>
                                        <div style={{ ...styles.fieldValue, fontFamily: 'monospace' }}>{selectedServer.iloIp || 'N/A'}</div>
                                    </div>
                                    {selectedServer.cvmIp && (
                                        <div>
                                            <span style={styles.fieldLabel}>CVM IP</span>
                                            <div style={{ ...styles.fieldValue, fontFamily: 'monospace' }}>{selectedServer.cvmIp}</div>
                                        </div>
                                    )}
                                    {selectedServer.datacenterName && (
                                        <div>
                                            <span style={styles.fieldLabel}>Location / Rack</span>
                                            <div style={styles.fieldValue}>
                                                🏢 {selectedServer.datacenterName} ({selectedServer.rackId || 'Rack'} {selectedServer.unitPosition ? `• ${selectedServer.unitPosition}` : ''})
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Section: CMDB Metadata & Multi-Module Sync */}
                            <div style={styles.sectionCard}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                                    <h4 style={styles.sectionTitle}>⚙️ CMDB Metadata & Cross-Module Sync</h4>
                                    {isPageEditMode && (
                                        !isEditingMeta ? (
                                            <div style={{ display: 'flex', gap: 8 }}>
                                                <button style={styles.btnSecondary} onClick={() => setIsEditingMeta(true)}>
                                                    <FiEdit3 size={12} /> Edit Metadata
                                                </button>
                                                <button 
                                                    style={{ ...styles.btnSecondary, color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }} 
                                                    onClick={() => openSingleDeleteModal(selectedServer)}
                                                >
                                                    <FiTrash2 size={12} /> Delete Server
                                                </button>
                                            </div>
                                        ) : (
                                            <button style={{ ...styles.btnSecondary, border: '1px solid var(--border-color)' }} onClick={() => setIsEditingMeta(false)}>
                                                Cancel
                                            </button>
                                        )
                                    )}
                                </div>

                                {!isEditingMeta ? (
                                    <div style={styles.grid2}>
                                        <div>
                                            <span style={styles.fieldLabel}>Application Name</span>
                                            <div style={styles.fieldValue}>{selectedServer.applicationName || 'Unassigned'}</div>
                                        </div>
                                        <div>
                                            <span style={styles.fieldLabel}>Business Unit / Owner</span>
                                            <div style={styles.fieldValue}>{selectedServer.businessUnit || 'Unassigned'}</div>
                                        </div>
                                        <div>
                                            <span style={styles.fieldLabel}>Zone</span>
                                            <div style={styles.fieldValue}>{selectedServer.zone || 'Intranet'}</div>
                                        </div>
                                        <div>
                                            <span style={styles.fieldLabel}>Environment</span>
                                            <div style={styles.fieldValue}>{selectedServer.envName}</div>
                                        </div>
                                        <div>
                                            <span style={styles.fieldLabel}>Criticality Tier</span>
                                            <div style={styles.fieldValue}>{selectedServer.criticality}</div>
                                        </div>
                                        <div>
                                            <span style={styles.fieldLabel}>Maintenance Window</span>
                                            <div style={styles.fieldValue}>{selectedServer.maintenanceWindow}</div>
                                        </div>
                                        <div>
                                            <span style={styles.fieldLabel}>FQDN</span>
                                            <div style={styles.fieldValue}>{selectedServer.fqdn || 'N/A'}</div>
                                        </div>
                                        <div style={{ gridColumn: 'span 2' }}>
                                            <span style={styles.fieldLabel}>Purpose / Description</span>
                                            <div style={styles.fieldValue}>{selectedServer.purpose || 'No notes provided.'}</div>
                                        </div>
                                    </div>
                                ) : (
                                    <form onSubmit={handleSaveCMDBMeta} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                        <div style={styles.grid2}>
                                            <div>
                                                <label style={styles.fieldLabel}>Operating System (OS Edition)</label>
                                                <input 
                                                    type="text" 
                                                    style={styles.input} 
                                                    value={editForm.os}
                                                    onChange={e => setEditForm({ ...editForm, os: e.target.value })}
                                                    placeholder="e.g. win (Windows Server 2016)"
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>CPU Cores</label>
                                                <input 
                                                    type="number" 
                                                    style={styles.input} 
                                                    value={editForm.cpuCores}
                                                    onChange={e => setEditForm({ ...editForm, cpuCores: e.target.value })}
                                                    placeholder="e.g. 8"
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>Memory RAM (GB)</label>
                                                <input 
                                                    type="number" 
                                                    style={styles.input} 
                                                    value={editForm.memoryGB}
                                                    onChange={e => setEditForm({ ...editForm, memoryGB: e.target.value })}
                                                    placeholder="e.g. 16"
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>Storage Disk (GB)</label>
                                                <input 
                                                    type="number" 
                                                    style={styles.input} 
                                                    value={editForm.diskGB}
                                                    onChange={e => setEditForm({ ...editForm, diskGB: e.target.value })}
                                                    placeholder="e.g. 280"
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>Architecture</label>
                                                <input 
                                                    type="text" 
                                                    style={styles.input} 
                                                    value={editForm.arch}
                                                    onChange={e => setEditForm({ ...editForm, arch: e.target.value })}
                                                    placeholder="e.g. x64 / arm64"
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>MAC Address</label>
                                                <input 
                                                    type="text" 
                                                    style={styles.input} 
                                                    value={editForm.mac}
                                                    onChange={e => setEditForm({ ...editForm, mac: e.target.value })}
                                                    placeholder="e.g. 00:50:56:AB:CD:EF"
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>Vendor / Hypervisor</label>
                                                <input 
                                                    type="text" 
                                                    style={styles.input} 
                                                    value={editForm.vendor}
                                                    onChange={e => setEditForm({ ...editForm, vendor: e.target.value })}
                                                    placeholder="e.g. VMware / Nutanix / Dell"
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>Application Name (Syncs IPAM & Prom)</label>
                                                <input 
                                                    type="text" 
                                                    style={styles.input} 
                                                    value={editForm.applicationName}
                                                    onChange={e => setEditForm({ ...editForm, applicationName: e.target.value })}
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>Business Unit / Owner (Syncs IPAM & Prom)</label>
                                                <input 
                                                    type="text" 
                                                    style={styles.input} 
                                                    value={editForm.businessUnit}
                                                    onChange={e => setEditForm({ ...editForm, businessUnit: e.target.value })}
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>Platform</label>
                                                <input 
                                                    type="text" 
                                                    style={styles.input} 
                                                    value={editForm.zone}
                                                    onChange={e => setEditForm({ ...editForm, zone: e.target.value })}
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>Environment</label>
                                                <select 
                                                    style={styles.select}
                                                    value={editForm.envId}
                                                    onChange={e => setEditForm({ ...editForm, envId: e.target.value })}
                                                >
                                                    <option value="" disabled>Unassigned{selectedServer?.envUnmapped ? ` (stored: ${selectedServer.envUnmapped})` : ''}</option>
                                                    {environments.map(env => (
                                                        <option key={env.id} value={env.id}>{env.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>Criticality Tier</label>
                                                <select 
                                                    style={styles.select}
                                                    value={editForm.criticality}
                                                    onChange={e => setEditForm({ ...editForm, criticality: e.target.value })}
                                                >
                                                    <option value="Tier 1 - Mission Critical">Tier 1 - Mission Critical</option>
                                                    <option value="Tier 2 - Business Operational">Tier 2 - Business Operational</option>
                                                    <option value="Tier 3 - Non-critical">Tier 3 - Non-critical</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>Maintenance Window</label>
                                                <input 
                                                    type="text" 
                                                    style={styles.input} 
                                                    value={editForm.maintenanceWindow}
                                                    onChange={e => setEditForm({ ...editForm, maintenanceWindow: e.target.value })}
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>Serial Number (SN)</label>
                                                <input 
                                                    type="text" 
                                                    style={styles.input} 
                                                    value={editForm.sn || ''}
                                                    onChange={e => setEditForm({ ...editForm, sn: e.target.value })}
                                                    placeholder="e.g. SN123456789"
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>iLO / OOB IP</label>
                                                <input 
                                                    type="text" 
                                                    style={styles.input} 
                                                    value={editForm.iloIp || ''}
                                                    onChange={e => setEditForm({ ...editForm, iloIp: e.target.value })}
                                                    placeholder="e.g. 10.10.10.50"
                                                />
                                            </div>
                                            <div>
                                                <label style={styles.fieldLabel}>CVM IP</label>
                                                <input 
                                                    type="text" 
                                                    style={styles.input} 
                                                    value={editForm.cvmIp || ''}
                                                    onChange={e => setEditForm({ ...editForm, cvmIp: e.target.value })}
                                                    placeholder="e.g. 10.10.10.60"
                                                />
                                            </div>
                                        </div>
                                        <div>
                                            <label style={styles.fieldLabel}>Purpose / Description</label>
                                            <textarea 
                                                style={styles.textarea} 
                                                rows="3"
                                                value={editForm.purpose}
                                                onChange={e => setEditForm({ ...editForm, purpose: e.target.value })}
                                            />
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 }}>
                                            <button type="button" style={{ ...styles.btnSecondary, background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.3)' }} onClick={handleSyncRaw} title="Auto-fill empty fields from Server Inventory and Prometheus targets">
                                                🔄 Auto-Fill from Modules
                                            </button>
                                            <button type="button" style={styles.btnSecondary} onClick={() => setIsEditingMeta(false)}>
                                                Cancel
                                            </button>
                                            <button type="submit" style={styles.btnPrimary} disabled={isSavingMeta}>
                                                {isSavingMeta ? 'Syncing...' : 'Save & Cross-Sync Modules'}
                                            </button>
                                        </div>
                                    </form>
                                )}
                            </div>

                            {/* Section: Scout Monitor */}
                            <div style={styles.sectionCard}>
                                <h4 style={styles.sectionTitle}>📊 Scout Monitor Health</h4>
                                <div style={styles.grid2}>
                                    <div>
                                        <span style={styles.fieldLabel}>Agent Status</span>
                                        <div style={styles.fieldValue}>
                                            {selectedServer.scoutStatus === 'online' ? '🟢 Online' : '🔴 Offline'} (Version: {selectedServer.agentVersion || 'v1.0'})
                                        </div>
                                    </div>
                                    <div>
                                        <span style={styles.fieldLabel}>Last Heartbeat</span>
                                        <div style={styles.fieldValue}>{selectedServer.lastSeen || 'N/A'}</div>
                                    </div>
                                </div>
                            </div>

                            {/* FEAT-03: Section: CMDB Audit History */}
                            <div style={styles.sectionCard}>
                                <h4 style={styles.sectionTitle}>📜 CMDB Audit Trail & Change History</h4>
                                {loadingHistory ? (
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading audit trail...</div>
                                ) : cmdbHistory.length === 0 ? (
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No audit history records found for this server.</div>
                                ) : (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 220, overflowY: 'auto' }}>
                                        {cmdbHistory.map(h => (
                                            <div key={h.id} style={{ padding: '8px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 11 }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                                    <span style={{ fontWeight: 800, color: 'var(--accent-primary)' }}>👤 {h.username} ({h.action})</span>
                                                    <span style={{ color: 'var(--text-muted)' }}>{new Date(h.timestamp).toLocaleString()}</span>
                                                </div>
                                                <div style={{ color: 'var(--text-secondary)' }}>
                                                    Updated fields for IP: <strong style={{ color: 'var(--text-primary)' }}>{h.ip}</strong>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Shared Integration Modal */}
            <HostDetailModal
                isOpen={!!sharedModalHost}
                onClose={() => setSharedModalHost(null)}
                initialHost={sharedModalHost}
            />

            {/* Delete confirmation: preview + optional cleanup (Rule 5 compliance: No native confirm/alert) */}
            <ServerDeleteModal
                isOpen={deleteConfirmModal.show}
                ips={deleteConfirmModal.targetIps}
                servers={servers}
                onClose={closeDeleteModal}
                onDeleted={handleDeleted}
                showToast={showToast}
            />

            {/* Deleted servers list with Restore */}
            <DeletedServersModal
                isOpen={showDeletedModal}
                onClose={() => setShowDeletedModal(false)}
                onRestored={() => fetchServers()}
                showToast={showToast}
            />

            {/* Batch Excel Diff & Comparison Modal */}
            <ServerListExcelDiffModal
                isOpen={showDiffModal}
                onClose={() => setShowDiffModal(false)}
                currentServers={servers}
                onSyncSuccess={() => {
                    fetchServers();
                    showToast?.('Server List successfully updated from Excel diff!', 'success');
                }}
                showToast={showToast}
            />

            {/* CMDB Field Authority & Sync Policy Modal */}
            <FieldAuthorityModal
                isOpen={showAuthorityModal}
                onClose={() => setShowAuthorityModal(false)}
                showToast={showToast}
                userRole={role}
            />
        </div>
    );
}

const styles = {
    container: {
        padding: 24,
        color: 'var(--text-primary)',
        display: 'flex',
        flexDirection: 'column',
        gap: 18
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
    },
    title: {
        margin: 0,
        fontSize: 22,
        fontWeight: 900,
        color: 'var(--text-primary)'
    },
    subtitle: {
        margin: '4px 0 0 0',
        fontSize: 13,
        color: 'var(--text-muted)'
    },
    kpiGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 16
    },
    kpiCard: {
        padding: 16,
        borderRadius: 12,
        background: 'rgba(255, 255, 255, 0.03)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transition: 'all 0.2s ease'
    },
    kpiHeader: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
    },
    kpiLabel: {
        fontSize: 11,
        fontWeight: 800,
        color: 'var(--text-muted)',
        letterSpacing: '0.05em'
    },
    kpiValue: {
        fontSize: 26,
        fontWeight: 900,
        color: 'var(--text-primary)'
    },
    kpiSub: {
        fontSize: 11,
        color: 'var(--text-muted)'
    },

    // Unified All-in-One Filter Bar Styling
    allInOneBar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 12px',
        borderRadius: 12,
        background: 'rgba(255, 255, 255, 0.03)',
        border: '1px solid var(--border-color)',
        gap: 16,
        flexWrap: 'wrap'
    },
    allInOneSearchBlock: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flex: 1,
        minWidth: 260
    },
    allInOneSearchInput: {
        background: 'none',
        border: 'none',
        outline: 'none',
        color: 'var(--text-primary)',
        fontSize: 13,
        width: '100%'
    },
    allInOneFilterGroup: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap'
    },
    inlineSelectWrapper: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: 'rgba(255, 255, 255, 0.04)',
        border: '1px solid var(--border-color)',
        padding: '4px 10px',
        borderRadius: 8
    },
    inlineSelectLabel: {
        fontSize: 11,
        fontWeight: 800,
        color: 'var(--text-muted)'
    },
    inlineSelect: {
        background: 'var(--bg-secondary, #1e293b)',
        border: 'none',
        outline: 'none',
        color: 'var(--text-primary, #f8fafc)',
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
        colorScheme: 'dark',
        borderRadius: 4,
        padding: '2px 4px'
    },
    inlineOption: {
        background: 'var(--bg-secondary, #1e293b)',
        color: 'var(--text-primary, #f8fafc)'
    },
    columnDropdownPopover: {
        position: 'absolute',
        top: 36,
        right: 0,
        width: 320,
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: 10,
        padding: 12,
        boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
        zIndex: 500
    },
    reorderBtn: {
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid var(--border-color)',
        borderRadius: 4,
        color: 'var(--text-primary)',
        cursor: 'pointer',
        padding: '2px 4px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center'
    },
    clearFilterBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 10px',
        borderRadius: 8,
        background: 'rgba(239, 68, 68, 0.15)',
        color: '#ef4444',
        border: '1px solid rgba(239, 68, 68, 0.3)',
        fontSize: 11,
        fontWeight: 800,
        cursor: 'pointer'
    },

    // Floating Bulk Action Bar
    bulkFloatingBar: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '12px 20px',
        borderRadius: 12,
        background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.15) 0%, rgba(99, 102, 241, 0.15) 100%)',
        border: '1px solid var(--accent-primary)'
    },
    bulkBadge: {
        padding: '4px 10px',
        borderRadius: 6,
        background: 'var(--accent-primary)',
        color: '#fff',
        fontWeight: 900,
        fontSize: 12
    },

    btnPrimary: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 16px',
        borderRadius: 8,
        background: 'var(--accent-primary)',
        color: '#fff',
        border: 'none',
        fontWeight: 700,
        fontSize: 13,
        cursor: 'pointer'
    },
    btnSecondary: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 14px',
        borderRadius: 8,
        background: 'rgba(255, 255, 255, 0.05)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-color)',
        fontWeight: 700,
        fontSize: 13,
        cursor: 'pointer'
    },
    btnIcon: {
        padding: 6,
        borderRadius: 6,
        background: 'rgba(255, 255, 255, 0.05)',
        border: '1px solid var(--border-color)',
        color: 'var(--text-muted)',
        cursor: 'pointer'
    },
    tableWrapper: {
        overflowX: 'auto',
        borderRadius: 12,
        border: '1px solid var(--border-color)',
        background: 'rgba(255, 255, 255, 0.02)'
    },
    table: {
        width: '100%',
        borderCollapse: 'collapse',
        textAlign: 'left',
        fontSize: 13
    },
    th: {
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-color)',
        color: 'var(--text-muted)',
        fontWeight: 800,
        fontSize: 11,
        letterSpacing: '0.05em',
        cursor: 'pointer',
        userSelect: 'none'
    },
    tr: {
        borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
        cursor: 'pointer',
        transition: 'background 0.15s'
    },
    td: {
        padding: '14px 16px',
        verticalAlign: 'middle'
    },
    badge: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 8px',
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 800
    },
    paginationRow: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 8
    },
    pageBtn: {
        padding: '6px 12px',
        borderRadius: 6,
        background: 'rgba(255, 255, 255, 0.05)',
        border: '1px solid var(--border-color)',
        color: 'var(--text-primary)',
        fontSize: 12,
        cursor: 'pointer'
    },
    modalOverlay: {
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(6px)',
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
    },
    modalContent: {
        width: 600,
        maxWidth: '90%',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: 14,
        boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
        overflow: 'hidden'
    },
    modalHeader: {
        padding: '16px 20px',
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
    },
    overlay: {
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0, 0, 0, 0.65)',
        backdropFilter: 'blur(6px)',
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'flex-end'
    },
    drawer: {
        width: 580,
        maxWidth: '100%',
        height: '100%',
        background: 'var(--bg-secondary)',
        borderLeft: '1px solid var(--border-color)',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '-10px 0 30px rgba(0,0,0,0.5)'
    },
    drawerHeader: {
        padding: 20,
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
    },
    avatarIcon: {
        width: 42,
        height: 42,
        borderRadius: 10,
        background: 'rgba(255, 255, 255, 0.05)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
    },
    closeBtn: {
        background: 'none',
        border: 'none',
        color: 'var(--text-muted)',
        cursor: 'pointer'
    },
    drawerBody: {
        padding: 20,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 20
    },
    sectionCard: {
        padding: 16,
        borderRadius: 10,
        background: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid var(--border-color)'
    },
    sectionTitle: {
        margin: '0 0 12px 0',
        fontSize: 14,
        fontWeight: 800,
        color: 'var(--accent-primary)'
    },
    grid2: {
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 12
    },
    fieldLabel: {
        fontSize: 10,
        fontWeight: 800,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em'
    },
    fieldValue: {
        fontSize: 13,
        fontWeight: 700,
        marginTop: 2,
        color: 'var(--text-primary)'
    },
    input: {
        width: '100%',
        padding: '8px 12px',
        borderRadius: 6,
        background: 'rgba(255, 255, 255, 0.05)',
        border: '1px solid var(--border-color)',
        color: 'var(--text-primary)',
        fontSize: 13,
        marginTop: 4,
        outline: 'none'
    },
    select: {
        width: '100%',
        padding: '8px 12px',
        borderRadius: 6,
        background: 'var(--bg-secondary, #1e293b)',
        border: '1px solid var(--border-color)',
        color: 'var(--text-primary, #f8fafc)',
        fontSize: 13,
        marginTop: 4,
        outline: 'none',
        colorScheme: 'dark'
    },
    textarea: {
        width: '100%',
        padding: '8px 12px',
        borderRadius: 6,
        background: 'rgba(255, 255, 255, 0.05)',
        border: '1px solid var(--border-color)',
        color: 'var(--text-primary)',
        fontSize: 13,
        marginTop: 4,
        outline: 'none',
        resize: 'vertical'
    }
};
