import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { WEEKDAYS, normalizeSchedule, describeSchedule, cronLooksValid, buildConfigPayload, scanBadge, triggerLabel, formatNextRun, specsErrorText } from './inventoryScanUtils';
import { FiServer, FiActivity, FiSettings, FiSearch, FiCpu, FiHardDrive, FiCheckCircle, FiPlus, FiX, FiClock, FiGlobe, FiMonitor, FiFilter, FiTerminal, FiMail } from 'react-icons/fi';
import { FaWindows, FaLinux } from 'react-icons/fa';
import api from '../../api';
import { normalizeEnvs, defaultEnv, UNASSIGNED } from '../../utils/environments';
import HostDetailModal from '../Shared/HostDetailModal';
import { useToast } from '../../contexts/ToastContext';
import ServerDeleteModal from './ServerDeleteModal';
import { offlineDaysOf, showInventoryDeleteButton } from './serverDeleteUtils';
import ScanHistoryPanel, { Badge } from './ScanHistoryPanel';
import HostChangesModal from './HostChangesModal';
import { SubnetSettingsEditor, ProbeSettingsEditor, CredentialProfilesEditor } from './InventorySettingsTabs';
import { isNewHost, buildExportQuery, exportFileName, subnetSettingsToForm, buildSubnetSettingsPayload, keepConfiguredSubnetSettings, probeToForm, formToProbe, apiErrorText } from './inventoryHistoryUtils';

const ServerInventory = () => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const { showToast } = useToast();
    const [data, setData] = useState([]);
    const [ipamSubnets, setIpamSubnets] = useState([]);
    const [environments, setEnvironments] = useState([]);
    const [selectedEnvForOverview, setSelectedEnvForOverview] = useState('All Environments');
    const [config, setConfig] = useState({ 
        subnets: [], 
        schedule: { enabled: false, frequency: 'daily', time: '08:00', weekday: 1, cron: '' },
        defaultScanRange: [1, 254]
    });
    const [subnetsText, setSubnetsText] = useState('');
    const [monitoredIpsText, setMonitoredIpsText] = useState('');
    const [viewMode, setViewMode] = useState('devices'); // 'devices' | 'history'
    const [historyKey, setHistoryKey] = useState(0);
    const [hostChangesIp, setHostChangesIp] = useState(null);
    const [subnetForms, setSubnetForms] = useState({});
    const [probeTouched, setProbeTouched] = useState(false);
    const [probeForm, setProbeForm] = useState(probeToForm(null));
    const [profiles, setProfiles] = useState([]);
    const [exporting, setExporting] = useState(false);
    const [loading, setLoading] = useState(true);
    const [isScanning, setIsScanning] = useState(false);
    const [showSubnetModal, setShowSubnetModal] = useState(false);
    const [showSettingsModal, setShowSettingsModal] = useState(false);
    const [showConfirmScan, setShowConfirmScan] = useState(false);
    const [confirmMsg, setConfirmMsg] = useState('');
    const [showConfirmAction, setShowConfirmAction] = useState(false);
    const [confirmAbort, setConfirmAbort] = useState(false);
    const [showScanModal, setShowScanModal] = useState(false);
    const [scanStatus, setScanStatus] = useState(null);
    const [showReportDialog, setShowReportDialog] = useState(false);
    const [reporting, setReporting] = useState(false);
    const [selectedServer, setSelectedServer] = useState(null);
    const [sharedModalHost, setSharedModalHost] = useState(null);
    const [integrationSummary, setIntegrationSummary] = useState({});
    const canShowHostDetail = (ip) => { const s = integrationSummary[String(ip).trim()]; return [s?.hasMonitor, s?.hasInventory, s?.hasIpam].filter(Boolean).length >= 2; };
    const [filter, setFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [selectedSubnet, setSelectedSubnet] = useState(null);
    const [activeSettingsTab, setActiveSettingsTab] = useState('subnet');
    const [confirmDeleteIp, setConfirmDeleteIp] = useState(null);
    // Bulk "delete hosts offline > N days": ask for N, dry-run on the server, then confirm in the shared delete modal
    const [bulkAsk, setBulkAsk] = useState(null); // { days, loading }
    const [bulkDelete, setBulkDelete] = useState(null); // { days, ips }
    const [tzSearch, setTzSearch] = useState('');
    const [newExcl, setNewExcl] = useState({ target: '', reason: '' });
    const [newOffset, setNewOffset] = useState({ subnet: '', targetOffset: '', reason: '' });
    const [currentPage, setCurrentPage] = useState(1);
    const [deployingIps, setDeployingIps] = useState({});
    const [showLinkModal, setShowLinkModal] = useState(false);
    const [linkTargetIp, setLinkTargetIp] = useState(null);
    const PAGE_SIZE = 50;
    const logEndRef = useRef(null);

    const headers = () => ({ 'Authorization': `Bearer ${localStorage.getItem('token')}` });

    useEffect(() => { fetchData(); fetchConfig(); }, []);
    // Live scan status: the worker owns scans (manual and scheduled), so poll the shared status for the whole life of the screen
    const wasRunningRef = useRef(false);
    const startGraceRef = useRef(0);
    const showScanModalRef = useRef(false);
    useEffect(() => { showScanModalRef.current = showScanModal; }, [showScanModal]);
    const pollStatusOnce = useCallback(async () => {
        try {
            const r = await fetch('/api/inventory/scan-status', { headers: headers() });
            if (!r.ok) return false;
            const st = await r.json();
            const running = !!st.running;
            setScanStatus(st);
            // right after a start request the worker may not have published "running" yet
            if (running || Date.now() >= startGraceRef.current) setIsScanning(running);
            if (wasRunningRef.current && !running) { fetchData(); fetchConfig(); setHistoryKey(k => k + 1); }
            wasRunningRef.current = running;
            return running || Date.now() < startGraceRef.current;
        } catch (e) { console.error(e); return false; }
    }, []);
    useEffect(() => {
        let cancelled = false;
        let timer = null;
        let busyNow = false;
        const tick = async () => {
            if (timer) { clearTimeout(timer); timer = null; }
            if (cancelled) return;
            // idle polling pauses while the tab is hidden (a running scan keeps polling)
            const hidden = typeof document !== 'undefined' && document.hidden;
            if (!(hidden && !busyNow && !showScanModalRef.current)) busyNow = await pollStatusOnce();
            if (cancelled) return;
            if (!cancelled) timer = setTimeout(tick, busyNow || showScanModalRef.current ? 2000 : 10000);
        };
        const onVisible = () => { if (typeof document !== 'undefined' && !document.hidden) tick(); };
        document.addEventListener('visibilitychange', onVisible);
        tick();
        return () => { cancelled = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
    }, [pollStatusOnce]);
    useEffect(() => { if (logEndRef.current) logEndRef.current.scrollTop = logEndRef.current.scrollHeight; }, [scanStatus?.logs]);
    useEffect(() => {
        if (showSettingsModal && config.subnets) {
            setSubnetsText(config.subnets.join(', '));
            setMonitoredIpsText((config.monitoredIps || []).join(', '));
        }
    }, [showSettingsModal, config.subnets, config.monitoredIps]);
    const loadProfiles = useCallback(async () => {
        if (role !== 'SuperAdmin') return;
        try { const r = await api.get('/inventory/credential-profiles'); setProfiles(r.data.profiles || []); }
        catch (e) { console.error('Failed to load credential profiles', e); }
    }, [role]);
    // Opening the settings modal (re)loads the per-subnet and probe editors from the saved config
    useEffect(() => {
        if (!showSettingsModal) return;
        const forms = {};
        for (const [k, v] of Object.entries(config.subnetSettings || {})) forms[k] = subnetSettingsToForm(v);
        setSubnetForms(forms);
        setProbeTouched(false);
        setProbeForm(probeToForm(config.probe));
        loadProfiles();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showSettingsModal]);

    const fetchData = async () => {
        try { 
            const r = await fetch('/api/inventory/data', { headers: headers() }); 
            setData(await r.json()); 
            const r3 = await fetch('/api/ipam/subnets', { headers: headers() });
            setIpamSubnets(await r3.json());
            const r4 = await fetch('/api/environments', { headers: headers() });
            setEnvironments(normalizeEnvs(await r4.json()));
            const r5 = await fetch('/api/integration/summary', { headers: headers() });
            setIntegrationSummary(await r5.json());
        }
        catch (e) { console.error('Failed to fetch data:', e); }
        setLoading(false);
    };
    const fetchConfig = async () => {
        try { 
            const r = await fetch('/api/inventory/config', { headers: headers() }); 
            const res = await r.json();
            setConfig(prev => ({
                ...prev,
                ...res,
                defaultScanRange: res.defaultScanRange || prev.defaultScanRange || [1, 254]
            }));
        }
        catch (e) { console.error(e); }
    };
    const submitLinkIp = async (primaryIp, secondaryIp) => {
        try {
            const res = await fetch('/api/inventory/link', {
                method: 'POST',
                headers: { ...headers(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ primaryIp, secondaryIp })
            });
            const d = await res.json();
            if (d.success) {
                showToast(d.message || `Successfully linked ${secondaryIp} as VIP to ${primaryIp}`, 'success');
                setShowLinkModal(false);
                setLinkTargetIp(null);
                fetchData();
            } else {
                showToast(d.error || 'Failed to link IP', 'error');
            }
        } catch (e) {
            showToast(e.message, 'error');
        }
    };

    const submitUnlinkIp = async (ip) => {
        try {
            const res = await fetch('/api/inventory/unlink', {
                method: 'POST',
                headers: { ...headers(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip })
            });
            const d = await res.json();
            if (d.success) {
                showToast(d.message || `Unlinked ${ip} successfully`, 'success');
                setSelectedServer(null);
                fetchData();
            } else {
                showToast(d.error || 'Failed to unlink IP', 'error');
            }
        } catch (e) {
            showToast(e.message, 'error');
        }
    };


    const deployAgent = async (e, srv) => {
        e.stopPropagation();
        if (!['SuperAdmin', 'Operator'].includes(role)) return;
        
        setDeployingIps(prev => ({ ...prev, [srv.ip]: true }));
        showToast(`Deploying Scout Agent to ${srv.ip} (${srv.os})...`, 'info');
        
        try {
            const res = await fetch('/api/inventory/deploy-agent', {
                method: 'POST',
                headers: { ...headers(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip: srv.ip, os: srv.os, hostname: srv.hostname })
            });
            const data = await res.json();
            if (data.success) {
                showToast(`Successfully deployed agent to ${srv.ip}`, 'success');
                // Auto-refresh integration summary to show the new monitor icon soon
                setTimeout(() => {
                    fetch('/api/integration/summary', { headers: headers() })
                        .then(r => r.json())
                        .then(d => setIntegrationSummary(d));
                }, 5000);
            } else {
                showToast(`Failed to deploy: ${data.error}`, 'error');
            }
        } catch (err) {
            showToast(`Error deploying to ${srv.ip}`, 'error');
        } finally {
            setDeployingIps(prev => ({ ...prev, [srv.ip]: false }));
        }
    };

    const startPolling = useCallback(() => { startGraceRef.current = Date.now() + 10000; pollStatusOnce(); }, [pollStatusOnce]);

    const handleScanNow = () => {
        if (isScanning) { setShowScanModal(true); return; }
        setShowConfirmScan(true);
    };

    // Called by ServerDeleteModal after the delete request succeeded
    const handleInventoryDeleted = () => {
        setConfirmDeleteIp(null);
        setBulkDelete(null);
        fetchData();
    };

    const startBulkDelete = async () => {
        const days = Math.floor(Number(bulkAsk && bulkAsk.days));
        if (!Number.isFinite(days) || days < 1) { showToast('Enter a whole number of days (1 or more)', 'error'); return; }
        setBulkAsk(b => ({ ...b, loading: true }));
        try {
            const res = await api.post('/inventory/bulk-delete-offline', { days, dryRun: true });
            const ips = res.data?.ips || [];
            if (ips.length === 0) {
                showToast(`No hosts have been offline for more than ${res.data?.days ?? days} days`, 'info');
                setBulkAsk(null);
                return;
            }
            if (res.data?.truncated) showToast(`${res.data.total} hosts match; this request handles the ${res.data.max} that have been offline longest`, 'info');
            setBulkDelete({ days: res.data?.days ?? days, ips });
            setBulkAsk(null);
        } catch (err) {
            showToast(err.response?.data?.error || 'Failed to look up offline hosts', 'error');
            setBulkAsk(b => (b ? { ...b, loading: false } : b));
        }
    };

    
    const handleAddTag = async (ip, tag) => {
        if (!tag.trim()) return;
        const server = data.find(s => s.ip === ip);
        const tags = server.tags || [];
        if (tags.includes(tag.trim())) return;
        const newTags = [...tags, tag.trim()];
        
        // Optimistic update
        const newData = data.map(s => s.ip === ip ? { ...s, tags: newTags } : s);
        setData(newData);
        if (selectedServer && selectedServer.ip === ip) setSelectedServer({ ...selectedServer, tags: newTags });

        try {
            await api.post(`/inventory/server/${ip}/tags`, { tags: newTags });
        } catch (e) {
            console.error('Failed to add tag:', e);
            fetchData(); // revert on fail
        }
    };

    const handleRemoveTag = async (ip, tag) => {
        const server = data.find(s => s.ip === ip);
        const tags = server.tags || [];
        const newTags = tags.filter(t => t !== tag);
        
        const newData = data.map(s => s.ip === ip ? { ...s, tags: newTags } : s);
        setData(newData);
        if (selectedServer && selectedServer.ip === ip) setSelectedServer({ ...selectedServer, tags: newTags });

        try {
            await api.post(`/inventory/server/${ip}/tags`, { tags: newTags });
        } catch (e) {
            console.error('Failed to remove tag:', e);
            fetchData();
        }
    };

    // Turns a non-2xx response into readable text (lists every validation error returned by a 400)
    const readApiError = async (res, fallback) => {
        try {
            const d = await res.json();
            if (Array.isArray(d.errors) && d.errors.length) return `${d.error ? d.error.split(':')[0] : fallback}:\n- ${d.errors.slice(0, 10).join('\n- ')}`;
            return d.error || d.message || fallback;
        } catch (e) { return `${fallback} (HTTP ${res.status})`; }
    };

    const confirmStartScan = async () => {
        setShowConfirmScan(false);
        setIsScanning(true);
        startGraceRef.current = Date.now() + 10000;
        try {
            const cfgRes = await fetch('/api/inventory/config', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(buildConfigPayload(config)) });
            if (!cfgRes.ok) { setIsScanning(false); startGraceRef.current = 0; setConfirmMsg(await readApiError(cfgRes, 'Failed to save configuration')); setShowConfirmAction(true); return; }
            const scanRes = await fetch('/api/inventory/scan-now', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: '{}' });
            if (scanRes.status === 409) { setShowScanModal(true); startPolling(); return; }
            if (!scanRes.ok) { setIsScanning(false); startGraceRef.current = 0; setConfirmMsg(await readApiError(scanRes, 'Failed to start scan')); setShowConfirmAction(true); return; }
            setShowScanModal(true);
            startPolling();
        } catch (e) { setIsScanning(false); startGraceRef.current = 0; setConfirmMsg(e.message); setShowConfirmAction(true); }
    };


    const handleAbortScan = async () => {
        setConfirmAbort(true);
    };

    // Single-IP rescan (re-collects the specs of one host, e.g. after fixing credentials)
    const retryHostScan = async (e, srv) => {
        e.stopPropagation();
        try {
            const res = await fetch('/api/inventory/scan-now', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: srv.ip }) });
            if (res.status === 409) { showToast('A scan is already running.', 'error'); return; }
            if (!res.ok) { showToast(await readApiError(res, 'Failed to start the rescan'), 'error'); return; }
            showToast(`Rescan of ${srv.ip} requested.`, 'success');
            setShowScanModal(true);
            startPolling();
        } catch (err) { showToast(err.message, 'error'); }
    };

    const confirmAbortAction = async () => {
        try {
            const res = await fetch('/api/inventory/abort-scan', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: '{}' });
            setConfirmAbort(false);
            if (!res.ok) { setConfirmMsg(await readApiError(res, 'Failed to abort the scan')); setShowConfirmAction(true); return; }
            showToast('Abort requested; the scan stops after the current host.', 'success');
            pollStatusOnce();
        } catch (e) {
            console.error('Abort failed', e);
            setConfirmAbort(false);
            setConfirmMsg(e.message); setShowConfirmAction(true);
        }
    };


    const openScanMonitor = () => {
        setShowScanModal(true);
        startPolling();
    };
    const saveConfig = async (c) => {
        try {
            const res = await fetch('/api/inventory/config', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(buildConfigPayload(c)) });
            if (!res.ok) { setConfirmMsg(await readApiError(res, 'Failed to save configuration')); setShowConfirmAction(true); return; }
            const body = await res.json().catch(() => ({}));
            setConfig(prev => ({ ...c, subnetSettings: c.subnetSettings !== undefined ? c.subnetSettings : prev.subnetSettings, probe: c.probe !== undefined ? c.probe : prev.probe, lastScan: prev.lastScan, lastDiscovered: prev.lastDiscovered }));
            setShowSubnetModal(false); setShowSettingsModal(false);
            if (body.schedulerNote) { setConfirmMsg(`Configuration saved.\n${body.schedulerNote}`); setShowConfirmAction(true); }
            pollStatusOnce();
        } catch (e) { setConfirmMsg(e.message); setShowConfirmAction(true); }
    };

    // Downloads /export with the filters currently applied on screen (authenticated blob download)
    const exportCsv = async () => {
        setExporting(true);
        try {
            const res = await api.get(`/inventory/export?${buildExportQuery({ statusFilter, selectedSubnet, filter })}`, { responseType: 'blob' });
            const url = URL.createObjectURL(res.data);
            const a = document.createElement('a');
            a.href = url;
            a.download = exportFileName(res.headers && res.headers['content-disposition']);
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) {
            let msg = 'Export failed';
            try { const d = e.response && e.response.data instanceof Blob ? JSON.parse(await e.response.data.text()) : null; msg = (d && d.error) || apiErrorText(e, msg); } catch (x) { msg = apiErrorText(e, msg); }
            showToast(msg, 'error');
        }
        setExporting(false);
    };

    const processedData = useMemo(() => {
        let merged = [];
        const linkedMap = {};
        
        data.forEach(s => {
            if (s.linkedTo) {
                if (!linkedMap[s.linkedTo]) linkedMap[s.linkedTo] = [];
                linkedMap[s.linkedTo].push(s.ip);
            }
        });

        data.forEach(s => {
            if (s.linkedTo) return;
            const p = { ...s };
            if (linkedMap[s.ip]) {
                p.displayIps = [s.ip, ...linkedMap[s.ip]];
                p.vips = linkedMap[s.ip];
            } else {
                p.displayIps = [s.ip];
                p.vips = [];
            }
            merged.push(p);
        });
        return merged;
    }, [data]);

    const duplicateHostnames = useMemo(() => {
        const counts = {};
        processedData.forEach(d => {
            if (d.hostname && d.hostname !== 'Unknown Host' && d.hostname !== 'Unknown') {
                counts[d.hostname] = (counts[d.hostname] || 0) + 1;
            }
        });
        return Object.keys(counts).filter(k => counts[k] > 1);
    }, [processedData]);

    const winCount = processedData.filter(s => s.os === 'win' && s.status !== 'offline').length;
    const linuxCount = processedData.filter(s => s.os === 'linux' && s.status !== 'offline').length;
    const unknownCount = processedData.filter(s => s.os !== 'win' && s.os !== 'linux' && s.status !== 'offline').length;
    const offlineCount = processedData.filter(s => s.status === 'offline').length;
    const totalCpu = processedData.reduce((s, d) => s + (parseInt(d.cpu) || 0), 0);
    const totalMem = processedData.reduce((s, d) => s + (parseInt(d.mem) || 0), 0);

    const filtered = processedData.filter(s => {
        const matchText = (s.hostname || '').toLowerCase().includes(filter.toLowerCase()) || (s.ip || '').includes(filter) || (s.tags || []).some(t => t.toLowerCase().includes(filter.toLowerCase()));
        
        let matchSubnet = true;
        if (selectedSubnet) {
            const prefix = s.ip.split('.').slice(0, 3).join('.');
            matchSubnet = (prefix === selectedSubnet);
        }
        if (!matchSubnet) return false;

        if (statusFilter === 'win') return matchText && s.os === 'win' && s.status !== 'offline';
        if (statusFilter === 'linux') return matchText && s.os === 'linux' && s.status !== 'offline';
        if (statusFilter === 'unknown') return matchText && s.os !== 'win' && s.os !== 'linux' && s.status !== 'offline';
        if (statusFilter === 'offline') return matchText && s.status === 'offline';
        return matchText;
    });

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(currentPage, totalPages);
        const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });
    const handleSort = (key) => {
        let direction = 'asc';
        if (sortConfig.key === key && sortConfig.direction === 'asc') direction = 'desc';
        setSortConfig({ key, direction });
    };

    const sortedData = React.useMemo(() => {
        let sortableItems = [...filtered];
        if (sortConfig.key !== null) {
            sortableItems.sort((a, b) => {
                let aVal = a[sortConfig.key] || '';
                let bVal = b[sortConfig.key] || '';
                if (typeof aVal === 'string') aVal = aVal.toLowerCase();
                if (typeof bVal === 'string') bVal = bVal.toLowerCase();
                if (aVal < bVal) return sortConfig.direction === 'asc' ? -1 : 1;
                if (aVal > bVal) return sortConfig.direction === 'asc' ? 1 : -1;
                return 0;
            });
        }
        return sortableItems;
    }, [filtered, sortConfig]);

    const paged = sortedData.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

    // Reset page when filters change
    useEffect(() => { setCurrentPage(1); }, [filter, statusFilter]);

    const getOffset = (tz) => {
        if (!tz) return null;
        const winMatch = tz.match(/\(UTC([+-]\d{2}):(\d{2})\)/);
        if (winMatch) {
            const h = parseInt(winMatch[1]);
            const m = parseInt(winMatch[2]);
            return h + (m / 60) * (h < 0 ? -1 : 1);
        }
        try {
            const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
            const tzPart = parts.find(p => p.type === 'timeZoneName')?.value;
            if (tzPart) {
                const match = tzPart.match(/GMT([+-]\d+)/);
                if (match) return parseInt(match[1]);
            }
        } catch(e) {}
        return null;
    };

    const Pagination = () => {
        if (filtered.length <= PAGE_SIZE) return null;
        return (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 24px', borderTop: '1px solid var(--border-color)', borderBottom: '1px solid var(--border-color)' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>
                    Showing {((safePage - 1) * PAGE_SIZE) + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                    <button disabled={safePage <= 1} onClick={() => setCurrentPage(safePage - 1)} style={{ ...s.filterBtn, opacity: safePage <= 1 ? 0.4 : 1, cursor: safePage <= 1 ? 'default' : 'pointer', minWidth: 36, textAlign: 'center' }}>&lt;</button>
                    <span style={{ padding: '7px 14px', fontSize: 12, fontWeight: 900, color: 'var(--text-primary)' }}>{safePage} / {totalPages}</span>
                    <button disabled={safePage >= totalPages} onClick={() => setCurrentPage(safePage + 1)} style={{ ...s.filterBtn, opacity: safePage >= totalPages ? 0.4 : 1, cursor: safePage >= totalPages ? 'default' : 'pointer', minWidth: 36, textAlign: 'center' }}>&gt;</button>
                </div>
            </div>
        );
    };

    // IP to Environment mapping
    const getIpEnvironment = (ip) => {
        const prefix = ip.split('.').slice(0, 3).join('.') + '.0/24';
        const subnet = ipamSubnets.find(s => s.cidr === prefix);
        // no IPAM subnet: the isDefault environment (never a hard-coded name)
        return subnet ? subnet.environment : ((defaultEnv(environments) || {}).name || UNASSIGNED);
    };

    // Subnet card data
    const subnetGroups = {};
    processedData.forEach(s => { 
        const prefix = s.ip.split('.').slice(0, 3).join('.'); 
        const env = getIpEnvironment(s.ip);
        if (selectedEnvForOverview === 'All Environments' || selectedEnvForOverview === env) {
            subnetGroups[prefix] = (subnetGroups[prefix] || 0) + 1; 
        }
    });

    if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</div>;

    const s = styles; // shorthand

    return (
        <div style={s.page}>
            {/* Header */}
            <div style={s.header}>
                <div>
                    <h1 className="page-title">Server Inventory</h1>
                    <p className="page-subtitle">Automated asset discovery and hardware audit</p>
                </div>
                <div style={s.headerBtns}>
                    {role !== 'Viewer' ? (
                        <button style={isScanning ? { ...s.btnPrimary, background: 'var(--warning)', boxShadow: '0 4px 16px rgba(245,158,11,0.3)' } : s.btnOutline} onClick={isScanning ? openScanMonitor : handleScanNow}>
                            <FiActivity size={14} style={isScanning ? { animation: 'spin 1s linear infinite' } : {}} /> {isScanning ? '🔴LIVE 📊View Progress' : 'Manual Scan'}
                        </button>
                    ) : (
                        isScanning && (
                            <button style={{ ...s.btnPrimary, background: 'var(--warning)', boxShadow: '0 4px 16px rgba(245,158,11,0.3)' }} onClick={openScanMonitor}>
                                <FiActivity size={14} style={{ animation: 'spin 1s linear infinite' }} /> {'🔴LIVE 📊View Progress'}
                            </button>
                        )
                    )}
                    {['SuperAdmin', 'Operator'].includes(role) && (
                        <button style={{ ...s.btnOutline, color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.3)' }} onClick={() => setBulkAsk({ days: config.offlineDeleteDays !== undefined ? config.offlineDeleteDays : 7, loading: false })}>
                            Delete Hosts Offline &gt; N Days
                        </button>
                    )}
                    {['SuperAdmin', 'Operator'].includes(role) && (
                        <button style={s.btnOutline} disabled={exporting} onClick={exportCsv}>{exporting ? 'Exporting...' : 'Export CSV'}</button>
                    )}
                    <button style={s.btnPrimary} onClick={() => setShowSettingsModal(true)}><FiSettings size={14} /> Inventory Settings</button>
                </div>
            </div>

            {/* Top Section: Subnet Overview + Metrics */}
            <div style={s.topRow}>
                {/* Subnet Overview Card */}
                <div style={s.overviewCard}>
                    <div style={{...s.overviewHeader, flexWrap: 'wrap', gap: 10}}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                            <span style={s.overviewTitle}>SUBNET OVERVIEW</span>
                            <select 
                                value={selectedEnvForOverview}
                                onChange={e => setSelectedEnvForOverview(e.target.value)}
                                style={{
                                    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', 
                                    color: 'var(--text-primary)', borderRadius: 6, padding: '4px 10px', fontSize: 12, outline: 'none',
                                    fontFamily: 'inherit', fontWeight: 600
                                }}
                            >
                                <option value="All Environments">All Environments</option>
                                {environments.map(env => (
                                    <option key={env.id} value={env.name}>{env.name}</option>
                                ))}
                            </select>
                        </div>
                        <div style={s.statusDots}>
                            <span style={s.dot}><span style={{ ...s.dotCircle, background: 'var(--success)' }} /> Windows ({winCount})</span>
                            <span style={s.dot}><span style={{ ...s.dotCircle, background: 'var(--warning)' }} /> Linux ({linuxCount})</span>
                            <span style={s.dot}><span style={{ ...s.dotCircle, background: 'var(--text-muted)' }} /> Unknown ({unknownCount})</span>
                            <span style={s.dot}><span style={{ ...s.dotCircle, background: 'var(--danger)' }} /> Offline ({offlineCount})</span>
                        </div>
                    </div>
                    <div style={s.subnetGrid}>
                        {Object.entries(subnetGroups).map(([subnet, count]) => (
                            <div 
                                key={subnet} 
                                style={{
                                    ...s.subnetCard, 
                                    cursor: 'pointer',
                                    border: selectedSubnet === subnet ? '2px solid var(--accent-primary)' : '1px solid var(--border-color)',
                                    background: selectedSubnet === subnet ? 'rgba(59,130,246,0.1)' : 'var(--bg-glass)',
                                    transition: 'all 0.2s ease'
                                }}
                                onClick={() => {
                                    setSelectedSubnet(prev => prev === subnet ? null : subnet);
                                    setViewMode('devices');
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                    <FiServer size={14} style={{ color: 'var(--accent-primary)', opacity: 0.7 }} />
                                    <span style={s.subnetName}>{subnet}.*</span>
                                </div>
                                <span style={s.subnetMeta}>{count} devices discovered</span>
                                <div style={s.progressBg}>
                                    <div style={{ ...s.progressBar, width: `${Math.min((count / 254) * 100, 100)}%` }} />
                                </div>
                                <span style={s.subnetPercent}>{((count / 254) * 100).toFixed(1)}% scanned</span>
                            </div>
                        ))}
                        {Object.keys(subnetGroups).length === 0 && (
                            <div style={{ ...s.subnetCard, color: 'var(--text-muted)', textAlign: 'center', padding: 30 }}>No subnets scanned yet</div>
                        )}
                    </div>
                </div>

                {/* Right Metrics */}
                <div style={s.metricsCol}>
                    <div style={s.metricCard}>
                        <span style={s.metricLabel}>TOTAL CPU CORES</span>
                        <div style={s.metricValue}>{totalCpu}<span style={s.metricUnit}> cores</span></div>
                        <div style={s.miniBarRow}>
                            {[...Array(6)].map((_, i) => <div key={i} style={{ ...s.miniBar, height: 12 + (i * 3), background: i < 5 ? 'var(--accent-primary)' : 'var(--danger)' }} />)}
                        </div>
                    </div>
                    <div style={s.metricCard}>
                        <span style={s.metricLabel}>TOTAL MEMORY</span>
                        <div style={s.metricValue}>{totalMem}<span style={s.metricUnit}> GB</span></div>
                        <div style={s.miniBarRow}>
                            {[...Array(6)].map((_, i) => <div key={i} style={{ ...s.miniBar, height: 10 + (i * 4), background: i < 5 ? 'var(--accent-primary)' : 'var(--danger)' }} />)}
                        </div>
                    </div>
                </div>
            </div>

            {/* Active Devices Table */}
            <div style={s.tableSection}>
                <div style={{ ...s.tableHeader, flexWrap: 'wrap', gap: 12 }}>
                    {/* Left: Title + View Mode Toggle */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                        <div style={{ display: 'flex', gap: 8, background: 'var(--bg-secondary)', padding: 4, borderRadius: 8, border: '1px solid var(--border-color)' }}>
                            <button 
                                onClick={() => setViewMode('devices')} 
                                style={{
                                    padding: '6px 12px', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: viewMode === 'devices' ? 800 : 600,
                                    background: viewMode === 'devices' ? 'var(--accent-primary)' : 'transparent',
                                    color: viewMode === 'devices' ? '#fff' : 'var(--text-muted)',
                                    cursor: 'pointer', transition: 'all 0.15s'
                                }}
                            >
                                Devices
                            </button>
                            <button 
                                onClick={() => setViewMode('history')} 
                                style={{
                                    padding: '6px 12px', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: viewMode === 'history' ? 800 : 600,
                                    background: viewMode === 'history' ? 'var(--accent-primary)' : 'transparent',
                                    color: viewMode === 'history' ? '#fff' : 'var(--text-muted)',
                                    cursor: 'pointer', transition: 'all 0.15s'
                                }}
                            >
                                Scan History
                            </button>
                        </div>
                        {viewMode === 'devices' && (
                            <div style={s.searchBox}>
                                <FiFilter size={12} style={{ color: 'var(--text-muted)' }} />
                                <input type="text" placeholder="Filter" style={s.searchInput} value={filter} onChange={e => setFilter(e.target.value)} />
                            </div>
                        )}
                    </div>
                    {/* Center: Filter Tabs */}
                    {viewMode === 'devices' ? (
                        <div style={s.filterRow}>
                            {[
                                ['all', 'All Devices'],
                                ['win', 'Windows'],
                                ['linux', 'Linux'],
                                ['unknown', 'Unknown'],
                                ['offline', 'Offline']
                            ].map(([k, l]) => (
                                <button key={k} onClick={() => setStatusFilter(k)} style={statusFilter === k ? s.filterActive : s.filterBtn}>{l}</button>
                            ))}
                        </div>
                    ) : <div />}
                    {/* Right: Pagination */}
                    {viewMode === 'devices' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <button disabled={safePage <= 1} onClick={() => setCurrentPage(safePage - 1)} style={{ ...s.filterBtn, minWidth: 32, textAlign: 'center', padding: '5px 10px', opacity: safePage <= 1 ? 0.35 : 1, cursor: safePage <= 1 ? 'default' : 'pointer' }}>&lt;</button>
                                <span style={{ padding: '5px 12px', fontSize: 13, fontWeight: 900, color: 'var(--text-primary)' }}>{safePage} / {totalPages}</span>
                                <button disabled={safePage >= totalPages} onClick={() => setCurrentPage(safePage + 1)} style={{ ...s.filterBtn, minWidth: 32, textAlign: 'center', padding: '5px 10px', opacity: safePage >= totalPages ? 0.35 : 1, cursor: safePage >= totalPages ? 'default' : 'pointer' }}>&gt;</button>
                            </div>
                            {filtered.length > PAGE_SIZE && (
                                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>
                                    Showing {((safePage - 1) * PAGE_SIZE) + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
                                </span>
                            )}
                        </div>
                    ) : <div />}
                </div>

                {viewMode === 'devices' ? (
                    <>
                        <table style={s.table}>
                            <thead>
                                <tr>
                                    <th style={{...s.th, cursor: 'pointer'}} onClick={() => handleSort('hostname')}>DEVICE NAME / ENVIRONMENT {sortConfig.key === 'hostname' ? (sortConfig.direction === 'asc' ? '\u25B2' : '\u25BC') : ''}</th>
                                    <th style={{...s.th, cursor: 'pointer'}} onClick={() => handleSort('status')}>CURRENT STATUS {sortConfig.key === 'status' ? (sortConfig.direction === 'asc' ? '\u25B2' : '\u25BC') : ''}</th>
                                    <th style={{...s.th, cursor: 'pointer'}} onClick={() => handleSort('cpu')}>HEALTH METRICS {sortConfig.key === 'cpu' ? (sortConfig.direction === 'asc' ? '\u25B2' : '\u25BC') : ''}</th>
                                    <th style={{ ...s.th, textAlign: 'right' }}>ACTIONS</th>
                                </tr>
                            </thead>
                            <tbody>
                                {paged.map((srv, i) => (
                                    <tr key={i} style={s.tr}>
                                        <td style={s.td}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                                <div style={{ ...s.deviceIcon, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                    {String(srv.os).toLowerCase().startsWith('win') ? (
                                                        <FaWindows style={{ color: '#3b82f6', fontSize: 18 }} />
                                                    ) : String(srv.os).toLowerCase() === 'linux' ? (
                                                        <FaLinux style={{ color: '#facc15', fontSize: 18 }} />
                                                    ) : (
                                                        '💻'
                                                    )}
                                                </div>
                                                <div>
                                                    <div 
                                                        style={{
                                                            ...s.deviceName, 
                                                            cursor: canShowHostDetail(srv.ip) ? 'pointer' : 'default', 
                                                            color: canShowHostDetail(srv.ip) ? 'var(--accent-primary)' : 'inherit', 
                                                            textDecoration: canShowHostDetail(srv.ip) ? 'underline' : 'none'
                                                        }}
                                                        onClick={async (e) => {
                                                            e.stopPropagation();
                                                            if (!canShowHostDetail(srv.ip)) return;
                                                            try {
                                                                const res = await api.get('/integration/check?ip=' + srv.ip);
                                                                const hostObj = res.data.monitor || {
                                                                    ip: srv.ip,
                                                                    name: srv.hostname || res.data.inventory?.hostname || res.data.ipam?.hostname || srv.ip,
                                                                    os: srv.os || res.data.inventory?.os || 'unknown',
                                                                    status: srv.status || 'unknown',
                                                                    group: res.data.ipam?.subnetName || 'N/A',
                                                                    lastSeen: srv.lastSeen || new Date().toISOString(),
                                                                    reportInterval: 0,
                                                                    tags: [],
                                                                    lastMetric: null
                                                                };
                                                                setSharedModalHost(hostObj);
                                                            } catch (err) {}
                                                        }}
                                                    >
                                                        {srv.hostname || 'Unknown Host'}
                                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                                                            <span style={{ fontWeight: 700 }}>{srv.ip}</span>
                                                            {srv.vips && srv.vips.length > 0 && (
                                                                <span style={{ 
                                                                    padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 800, 
                                                                    background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', border: '1px solid rgba(168, 85, 247, 0.3)',
                                                                    display: 'inline-flex', alignItems: 'center', gap: 4
                                                                }}>
                                                                    👑 VIP: {srv.vips.join(', ')}
                                                                </span>
                                                            )}
                                                            {isNewHost(srv) && <Badge label="NEW" tone="success" title={`First seen ${new Date(srv.firstSeen).toLocaleString()}`} />}
                                                            {srv.domain && <span>· {srv.domain}</span>}
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        </td>
                                        <td style={s.td}>
                                            {(() => {
                                                const offlineDays = config.offlineDeleteDays !== undefined ? config.offlineDeleteDays : 7;
                                                const heldDays = offlineDaysOf(srv);
                                                return srv.status === 'offline' ? (
                                                    <span style={{ ...s.statusOnline, color: 'var(--danger)' }}><span style={{ ...s.dotCircle, background: 'var(--danger)' }} /> {heldDays !== null && heldDays >= offlineDays ? `Offline > ${offlineDays} Days` : 'Offline'}</span>
                                                ) : (
                                                    <span style={s.statusOnline}><span style={{ ...s.dotCircle, background: 'var(--success)' }} /> Online</span>
                                                );
                                            })()}
                                            {specsErrorText(srv) && srv.status === 'offline' && (
                                                <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }} title={specsErrorText(srv)}>Last probe: {specsErrorText(srv).slice(0, 60)}</div>
                                            )}
                                            {specsErrorText(srv) && srv.status !== 'offline' && (
                                                <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    <span title={specsErrorText(srv)} aria-label={`Probe error: ${specsErrorText(srv)}`} style={{ color: 'var(--danger)', fontSize: 12, cursor: 'help' }}>{'⚠'}</span>
                                                    {['SuperAdmin', 'Operator'].includes(role) && !specsErrorText(srv).startsWith('Unknown OS') && (
                                                        <button style={{ ...s.viewBtn, padding: '1px 8px', fontSize: 10 }} title="Rescan this host" onClick={(e) => retryHostScan(e, srv)}>Retry</button>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                        <td style={s.td}>
                                            {srv.cpu || srv.mem ? (
                                                <span style={s.healthBadge}>{srv.cpu ? `${srv.cpu}C` : ''}{srv.cpu && srv.mem ? ' / ' : ''}{srv.mem ? `${srv.mem}GB` : ''}</span>
                                            ) : (
                                                <span style={s.healthNone}>None Detected</span>
                                            )}
                                        </td>
                                        <td style={{ ...s.td, textAlign: 'right' }}>
                                            {srv.status !== 'offline' && !integrationSummary[srv.ip]?.hasMonitor && ['SuperAdmin', 'Operator'].includes(role) && (
                                                <button 
                                                    style={{...s.viewBtn, marginRight: '8px', background: deployingIps[srv.ip] ? 'var(--bg-secondary)' : 'var(--accent-primary)', color: '#fff', border: 'none'}} 
                                                    onClick={(e) => deployAgent(e, srv)}
                                                    disabled={deployingIps[srv.ip]}
                                                >
                                                    {deployingIps[srv.ip] ? 'DEPLOYING...' : 'DEPLOY SCOUT'}
                                                </button>
                                            )}
                                            {duplicateHostnames.includes(srv.hostname) && (
                                                <button style={{...s.viewBtn, marginRight: '8px'}} onClick={(e) => { e.stopPropagation(); setLinkTargetIp(srv.ip); setShowLinkModal(true); }}>🔗 LINK IP</button>
                                            )}
                                            <button style={{...s.viewBtn, marginRight: '8px'}} onClick={(e) => { e.stopPropagation(); setSelectedServer(srv); }}>VIEW DETAIL</button>
                                            <button style={{...s.viewBtn, marginRight: '8px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', boxShadow: 'none'}} title="Change history of this host" onClick={(e) => { e.stopPropagation(); setHostChangesIp(srv.ip); }}>HISTORY</button>
                                            {(() => {
                                                const offlineDays = config.offlineDeleteDays !== undefined ? config.offlineDeleteDays : 7;
                                                // Offline hosts only; the server enforces the guard, SuperAdmin may force below the threshold
                                                return showInventoryDeleteButton(srv, role, offlineDays) && (
                                                    <button style={{...s.viewBtn, color: 'var(--danger)', border: '1px solid rgba(239,68,68,0.3)'}} onClick={(e) => { e.stopPropagation(); setConfirmDeleteIp(srv.ip); }}>
                                                        DELETE & RELEASE IP
                                                    </button>
                                                );
                                            })()}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </>
                ) : (
                    <ScanHistoryPanel s={s} refreshKey={historyKey} />
                )}
            </div>

            {hostChangesIp && <HostChangesModal s={s} ip={hostChangesIp} onClose={() => setHostChangesIp(null)} />}

            {/* Link IP Modal */}
            {showLinkModal && (() => {
                const targetObj = processedData.find(d => d.ip === linkTargetIp);
                const targetHost = targetObj ? targetObj.hostname : null;
                const candidateHosts = processedData.filter(d => d.hostname && d.hostname === targetHost);
                return (
                    <div style={s.modalOverlay} onClick={() => { setShowLinkModal(false); setLinkTargetIp(null); }}>
                        <div style={{ ...s.modal, maxWidth: 540 }} onClick={e => e.stopPropagation()}>
                            <div style={s.modalHeader}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                    <span style={{ fontSize: 20 }}>🔗</span>
                                    <h3 style={{ ...s.overviewTitle, fontSize: 18 }}>Link Duplicate Host & VIP</h3>
                                </div>
                                <button onClick={() => { setShowLinkModal(false); setLinkTargetIp(null); }} style={s.closeBtn}><FiX size={20} /></button>
                            </div>
                            <div style={{ padding: 24 }}>
                                <div style={{ marginBottom: 16, padding: '12px 16px', background: 'rgba(59,130,246,0.08)', borderRadius: 12, border: '1px solid rgba(59,130,246,0.2)' }}>
                                    <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--accent-primary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>DUPLICATE HOSTNAME DETECTED</div>
                                    <div style={{ fontSize: 16, fontWeight: 900, color: 'var(--text-primary)', marginTop: 4 }}>{targetHost || 'Unknown Host'}</div>
                                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                                        Discovered IPs: <b>{candidateHosts.map(c => c.ip).join(', ')}</b>
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                                    <div>
                                        <label style={s.metricLabel}>PRIMARY HOST (主要實體 IP)</label>
                                        <select 
                                            id="linkPrimaryIp"
                                            style={s.input}
                                            defaultValue={candidateHosts.find(d => d.ip !== linkTargetIp)?.ip || linkTargetIp}
                                        >
                                            {candidateHosts.map(d => (
                                                <option key={d.ip} value={d.ip}>{d.ip} ({d.os || 'Host'})</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label style={s.metricLabel}>VIP / SECONDARY IP (虛擬 IP)</label>
                                        <select 
                                            id="linkSecondaryIp"
                                            style={s.input}
                                            defaultValue={linkTargetIp}
                                        >
                                            {candidateHosts.map(d => (
                                                <option key={d.ip} value={d.ip}>{d.ip} ({d.os || 'VIP'})</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>

                                <div style={{ ...s.hint, marginTop: 16, borderLeft: '3px solid #c084fc' }}>
                                    <b>⚡ Automated Cascade Actions upon Linking:</b>
                                    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
                                        <li><b>Server Inventory</b>: Attached to Primary Host as VIP; hidden from standalone list.</li>
                                        <li><b>IPAM Module</b>: IP status automatically marked as <span style={{ color: '#c084fc', fontWeight: 800 }}>VIP</span> with linked host notes.</li>
                                        <li><b>Server List (CMDB)</b>: Standalone record deleted and linked to Primary Host.</li>
                                        <li><b>Prometheus Targets</b>: VIP monitoring target removed automatically.</li>
                                    </ul>
                                </div>

                                <div style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                                    <button style={s.btnOutline} onClick={() => { setShowLinkModal(false); setLinkTargetIp(null); }}>CANCEL</button>
                                    <button 
                                        style={{ ...s.btnPrimary, background: 'linear-gradient(135deg, #8b5cf6, #ec4899)', border: 'none' }} 
                                        onClick={() => {
                                            const primaryIp = document.getElementById('linkPrimaryIp')?.value;
                                            const secondaryIp = document.getElementById('linkSecondaryIp')?.value;
                                            if (!primaryIp || !secondaryIp) {
                                                showToast('Please select both Primary and VIP addresses', 'error');
                                                return;
                                            }
                                            if (primaryIp === secondaryIp) {
                                                showToast('Primary IP and VIP cannot be the same address', 'error');
                                                return;
                                            }
                                            submitLinkIp(primaryIp, secondaryIp);
                                        }}
                                    >
                                        👑 LINK & SYNC VIP
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* Detail Modal */}
            {selectedServer && (
                <div style={s.modalOverlay} onClick={() => setSelectedServer(null)}>
                    <div style={s.modal} onClick={e => e.stopPropagation()}>
                        <div style={s.modalHeader}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                                <div style={{ fontSize: 32 }}>{String(selectedServer.os).toLowerCase().startsWith('win') ? <FaWindows style={{ color: '#3b82f6' }} /> : <FaLinux style={{ color: '#facc15' }} />}</div>
                                <div>
                                    <h3 style={{ ...s.overviewTitle, fontSize: 20 }}>{selectedServer.hostname || selectedServer.ip}</h3>
                                    <span style={{ ...s.subnetMeta }}>{selectedServer.ip} · {selectedServer.osname || selectedServer.os}</span>
                                </div>
                            </div>
                            <button onClick={() => setSelectedServer(null)} style={s.closeBtn}><FiX size={20} /></button>
                        </div>
                        <div style={{ padding: 32, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                            {[['CPU Cores', selectedServer.cpu || '-'], ['Memory', selectedServer.mem ? `${selectedServer.mem} GB` : '-'], ['Domain', selectedServer.domain || 'LOCAL'], ['Timezone', selectedServer.timezone || 'UTC'], ['OS Edition', selectedServer.osname || 'N/A'], ['Last Seen', selectedServer.lastSeen ? new Date(selectedServer.lastSeen).toLocaleString() : '-']].map(([k, v]) => (
                                <div key={k} style={s.detailItem}>
                                    <span style={s.metricLabel}>{k.toUpperCase()}</span>
                                    <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--text-primary)' }}>{v}</span>
                                </div>
                            ))}

                            {selectedServer.vips && selectedServer.vips.length > 0 && (
                                <div style={{ ...s.detailItem, gridColumn: '1 / -1', background: 'rgba(168, 85, 247, 0.06)', border: '1px solid rgba(168, 85, 247, 0.25)' }}>
                                    <span style={{ ...s.metricLabel, color: '#c084fc' }}>LINKED VIRTUAL IPS (VIP)</span>
                                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                                        {selectedServer.vips.map(vipIp => (
                                            <div key={vipIp} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: 'rgba(168, 85, 247, 0.15)', borderRadius: 8, border: '1px solid rgba(168, 85, 247, 0.3)' }}>
                                                <span style={{ fontSize: 13, fontWeight: 800, color: '#c084fc', fontFamily: 'monospace' }}>👑 {vipIp}</span>
                                                {['SuperAdmin', 'Operator'].includes(role) && (
                                                    <button 
                                                        onClick={() => submitUnlinkIp(vipIp)} 
                                                        style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', fontSize: 11, fontWeight: 800, padding: 0, textDecoration: 'underline' }}
                                                        title="Unlink VIP"
                                                    >
                                                        UNLINK
                                                    </button>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        
                            <div style={{ ...s.detailItem, gridColumn: '1 / -1' }}>
                                <span style={s.metricLabel}>TAGS</span>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                                    {(selectedServer.tags || []).map(tag => (
                                        <span key={tag} style={{ padding: '4px 10px', background: 'var(--accent-glow)', color: 'var(--accent-primary)', borderRadius: 16, fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <FiTag size={12} /> {tag}
                                            {['SuperAdmin', 'Operator'].includes(role) && (
                                                <button onClick={() => handleRemoveTag(selectedServer.ip, tag)} style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', padding: 0 }}><FiX size={12} /></button>
                                            )}
                                        </span>
                                    ))}
                                </div>
                                {['SuperAdmin', 'Operator'].includes(role) && (
                                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                                        <input type="text" id="newTagInput" placeholder="New tag..." style={{ ...s.input, width: 200, marginTop: 0, padding: '8px 12px' }} onKeyDown={e => {
                                            if (e.key === 'Enter') {
                                                handleAddTag(selectedServer.ip, e.target.value);
                                                e.target.value = '';
                                            }
                                        }} />
                                        <button onClick={() => {
                                            const input = document.getElementById('newTagInput');
                                            if (input && input.value) {
                                                handleAddTag(selectedServer.ip, input.value);
                                                input.value = '';
                                            }
                                        }} style={{ ...s.btnOutline, padding: '8px 16px' }}>Add Tag</button>
                                    </div>
                                )}
                            </div>
</div></div></div>)}

            {/* Custom Scan Confirmation Modal */}
            {showConfirmScan && (
                <div style={s.modalOverlay} onClick={() => setShowConfirmScan(false)}>
                    <div style={{ ...s.modal, maxWidth: 450 }} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: '32px 32px 24px', textAlign: 'center' }}>
                            <div style={{ width: 64, height: 64, borderRadius: 32, background: 'var(--accent-glow)', color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                                <FiActivity size={32} style={{ animation: 'pulse 2s infinite' }} />
                            </div>
                            <h3 style={{ fontSize: 22, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 12 }}>Start Discovery?</h3>
                            <p style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 24 }}>
                                You are about to initiate a manual network scan across <b>{config.subnets.length} subnets</b> ({config.subnets.length * 254} IPs). This may take several minutes.
                            </p>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <button style={{ ...s.btnOutline, justifyContent: 'center' }} onClick={() => setShowConfirmScan(false)}>CANCEL</button>
                                <button style={{ ...s.btnPrimary, justifyContent: 'center' }} onClick={confirmStartScan}>CONFIRM SCAN</button>
                            </div>
                        </div>
                        <div style={{ padding: '16px 32px', background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-color)', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
                            <FiClock size={10} /> Last scan: {config.lastScan ? new Date(config.lastScan).toLocaleString() : 'Never'}{scanStatus?.nextRunAt ? ` \u00B7 Next scheduled: ${formatNextRun(scanStatus.nextRunAt)}` : ''}
                        </div>
                    </div>
                </div>
            )}

            {/* Delete confirmation: the shared delete modal (preview + optional cleanup + inventory / IPAM lines) */}
            <ServerDeleteModal
                isOpen={!!confirmDeleteIp}
                ips={confirmDeleteIp ? [confirmDeleteIp] : []}
                servers={data}
                variant="inventory"
                role={role}
                onClose={() => setConfirmDeleteIp(null)}
                onDeleted={handleInventoryDeleted}
                showToast={showToast}
            />
            <ServerDeleteModal
                isOpen={!!bulkDelete}
                ips={bulkDelete ? bulkDelete.ips : []}
                servers={data}
                variant="inventory"
                role={role}
                bulkDays={bulkDelete ? bulkDelete.days : null}
                onClose={() => setBulkDelete(null)}
                onDeleted={handleInventoryDeleted}
                showToast={showToast}
            />

            {bulkAsk && (
                <div style={s.modalOverlay} onClick={() => !bulkAsk.loading && setBulkAsk(null)}>
                    <div style={{ ...s.modal, maxWidth: 430 }} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: '28px 28px 24px' }}>
                            <h3 style={{ fontSize: 20, fontWeight: 900, color: 'var(--text-primary)', marginBottom: 10 }}>Delete hosts offline &gt; N days</h3>
                            <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, marginBottom: 16 }}>
                                Finds hosts that have been offline for more than the number of days below (never less than the configured {config.offlineDeleteDays !== undefined ? config.offlineDeleteDays : 7}-day guard) and shows exactly what will be deleted before anything is removed. At most 500 hosts per request.
                            </p>
                            <input
                                type="number" min="1" value={bulkAsk.days}
                                onChange={e => setBulkAsk(b => ({ ...b, days: e.target.value }))}
                                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', marginBottom: 16, fontSize: 14 }}
                            />
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <button style={{ ...s.btnOutline, justifyContent: 'center' }} disabled={bulkAsk.loading} onClick={() => setBulkAsk(null)}>CANCEL</button>
                                <button style={{ ...s.btnPrimary, justifyContent: 'center' }} disabled={bulkAsk.loading} onClick={startBulkDelete}>{bulkAsk.loading ? 'SEARCHING...' : 'PREVIEW'}</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Unified Settings Modal */}
            {showSettingsModal && (
                <div style={s.modalOverlay} onClick={() => setShowSettingsModal(false)}>
                    <div style={{ ...s.modal, maxWidth: 850 }} onClick={e => e.stopPropagation()}>
                        <div style={s.modalHeader}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <FiSettings size={22} style={{ color: 'var(--accent-primary)' }} />
                                <h3 style={{ ...s.overviewTitle, fontSize: 20 }}>Inventory Settings</h3>
                            </div>
                            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                                {role !== 'Viewer' && (
                                    <button style={s.btnPrimary} onClick={() => {
                                        const parsedSubnets = subnetsText.split(',').map(x => x.trim()).filter(Boolean);
                                        const parsedMonitored = monitoredIpsText.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
                                        const ss = buildSubnetSettingsPayload(subnetForms);
                                        if (ss.error) { setConfirmMsg(`Per-subnet settings: ${ss.error}`); setShowConfirmAction(true); return; }
                                        const pr = formToProbe(probeForm);
                                        if (pr.error) { setConfirmMsg(`Probe settings: ${pr.error}`); setShowConfirmAction(true); return; }
                                        // PATCH: per-subnet settings and probe are sent only when that tab was edited (never echoed back)
                                        const next = { ...config, subnets: parsedSubnets, monitoredIps: parsedMonitored };
                                        if (probeTouched) { next.subnetSettings = keepConfiguredSubnetSettings(ss.settings, parsedSubnets); next.probe = pr.probe; }
                                        else { delete next.subnetSettings; delete next.probe; }
                                        saveConfig(next);
                                    }}><FiCheckCircle size={14} /> Save Changes</button>
                                )}
                                <button onClick={() => setShowSettingsModal(false)} style={s.closeBtn}><FiX size={20} /></button>
                            </div>
                        </div>
                        
                        {/* Tab Bar */}
                        <div style={s.tabBar}>
                            {[
                                { id: 'subnet', label: 'Target Subnets', icon: <FiGlobe size={14} /> },
                                { id: 'schedule', label: 'Scan Scheduler', icon: <FiClock size={14} /> },
                                { id: 'timezone', label: 'Timezone Check', icon: <FiMonitor size={14} /> },
                                { id: 'alerts', label: 'Status Alerts', icon: <FiActivity size={14} /> },
                                { id: 'probe', label: 'Probe & Subnets', icon: <FiCpu size={14} /> },
                                ...(role === 'SuperAdmin' ? [{ id: 'credentials', label: 'Credentials', icon: <FiHardDrive size={14} /> }] : [])
                            ].map(tab => (
                                <button 
                                    key={tab.id}
                                    onClick={() => setActiveSettingsTab(tab.id)}
                                    style={activeSettingsTab === tab.id ? s.activeTab : s.tabBtn}
                                >
                                    {tab.icon} {tab.label}
                                </button>
                            ))}
                        </div>

                        <div style={{ padding: 28, maxHeight: '60vh', overflowY: 'auto' }}>
                            {activeSettingsTab === 'subnet' && (
                                <div className={`animate-fade-in ${role === 'Viewer' ? 'pointer-events-none opacity-80' : ''}`}>
                                    <label style={s.metricLabel}>C-CLASS SUBNET PREFIXES</label>
                                    <textarea 
                                        style={s.textarea} 
                                        rows="6" 
                                        value={subnetsText} 
                                        onChange={e => setSubnetsText(e.target.value)}
                                        placeholder="10.99.25, 192.168.1:1~250" 
                                    />
                                              <label style={{ ...s.metricLabel, marginTop: 24 }}>DEFAULT SCAN RANGE (1-254)</label>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12, padding: '0 4px' }}>
                                        {(() => {
                                            const scanRange = config?.defaultScanRange || [1, 254];
                                            const s1 = scanRange[0] ?? 1;
                                            const s2 = scanRange[1] ?? 254;
                                            return (
                                                <>
                                                    <input 
                                                        type="number" min="1" max="254" 
                                                        value={s1}
                                                        onChange={e => {
                                                            const val = parseInt(e.target.value) || 1;
                                                            setConfig({...config, defaultScanRange: [Math.min(val, s2), s2]});
                                                        }}
                                                        style={{ ...s.input, width: 70, marginTop: 0, padding: '8px', textAlign: 'center', fontWeight: 900 }} 
                                                    />
                                                    
                                                    <div style={{ position: 'relative', flex: 1, height: 32, display: 'flex', alignItems: 'center' }}>
                                                        <style>{`
                                                            .sys-op-range { position: absolute; width: 100%; height: 32px; -webkit-appearance: none; appearance: none; background: transparent !important; pointer-events: none; outline: none; margin: 0; top: 0; border: none !important; z-index: 20; }
                                                            .sys-op-range::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; pointer-events: auto; width: 24px; height: 24px; border-radius: 50%; background: #d97706 !important; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.5); border: 2.5px solid #fff !important; position: relative; z-index: 50; }
                                                            .sys-op-range::-moz-range-thumb { pointer-events: auto; width: 24px; height: 24px; border-radius: 50%; background: #d97706; cursor: pointer; border: 2.5px solid #fff; z-index: 50; }
                                                            .sys-op-range::-webkit-slider-runnable-track { background: transparent !important; border: none !important; }
                                                        `}</style>
                                                        
                                                        <input 
                                                            type="range" min="1" max="254" 
                                                            className="sys-op-range"
                                                            value={s1}
                                                            onChange={e => {
                                                                const val = parseInt(e.target.value);
                                                                setConfig({...config, defaultScanRange: [Math.min(val, s2), s2]});
                                                            }}
                                                        />
                                                        <input 
                                                            type="range" min="1" max="254" 
                                                            className="sys-op-range"
                                                            value={s2}
                                                            onChange={e => {
                                                                const val = parseInt(e.target.value);
                                                                setConfig({...config, defaultScanRange: [s1, Math.max(val, s1)]});
                                                            }}
                                                        />
                                                    </div>

                                                    <input 
                                                        type="number" min="1" max="254" 
                                                        value={s2}
                                                        onChange={e => {
                                                            const val = parseInt(e.target.value) || 254;
                                                            setConfig({...config, defaultScanRange: [s1, Math.max(val, s1)]});
                                                        }}
                                                        style={{ ...s.input, width: 70, marginTop: 0, padding: '8px', textAlign: 'center', fontWeight: 900 }} 
                                                    />
                                                </>
                                            );
                                        })()}
                                    </div>

                                    <div style={s.hint}>
                                        Enter network prefixes separated by commas. Default scan range is <b>{config.defaultScanRange?.[0] || 1}-{config.defaultScanRange?.[1] || 254}</b>.<br/>
                                        You can override this for specific subnets using a colon. Example: <b>10.99.1</b>, <b>192.168.1:1~250</b>, <b>10.0.0:10~50</b>
                                    </div>
                                </div>
                            )}

                            {activeSettingsTab === 'schedule' && (
                                <div className={`animate-fade-in ${role === 'Viewer' ? 'pointer-events-none opacity-80' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 20, background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                                        <div>
                                            <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>Automatic Background Scan</div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Scan all target subnets on a fixed schedule</div>
                                        </div>
                                        <input 
                                            type="checkbox" 
                                            checked={config.schedule?.enabled} 
                                            onChange={e => setConfig({...config, schedule: {...config.schedule, enabled: e.target.checked}})}
                                            style={{ width: 22, height: 22, cursor: 'pointer', accentColor: 'var(--accent-primary)' }} 
                                        />
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                                        <div>
                                            <label style={s.metricLabel}>RECURRENCE</label>
                                            <select
                                                value={normalizeSchedule(config.schedule).frequency}
                                                onChange={e => setConfig({...config, schedule: {...normalizeSchedule(config.schedule), frequency: e.target.value, weekday: normalizeSchedule(config.schedule).weekday}})}
                                                style={s.input}
                                            >
                                                <option value="daily">Daily</option>
                                                <option value="weekly">Weekly</option>
                                                <option value="cron">Custom (cron expression)</option>
                                            </select>
                                        </div>
                                        {normalizeSchedule(config.schedule).frequency === 'weekly' && (
                                            <div>
                                                <label style={s.metricLabel}>DAY OF WEEK</label>
                                                <select
                                                    value={normalizeSchedule(config.schedule).weekday}
                                                    onChange={e => setConfig({...config, schedule: {...normalizeSchedule(config.schedule), weekday: Number(e.target.value)}})}
                                                    style={s.input}
                                                >
                                                    {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                                                </select>
                                            </div>
                                        )}
                                        {normalizeSchedule(config.schedule).frequency !== 'cron' && (
                                            <div>
                                                <label style={s.metricLabel}>SCAN TIME (server local time)</label>
                                                <input
                                                    type="time"
                                                    value={normalizeSchedule(config.schedule).time}
                                                    onChange={e => setConfig({...config, schedule: {...normalizeSchedule(config.schedule), time: e.target.value}})}
                                                    style={s.input}
                                                />
                                            </div>
                                        )}
                                        {normalizeSchedule(config.schedule).frequency === 'cron' && (
                                            <div style={{ gridColumn: '1 / -1' }}>
                                                <label style={s.metricLabel}>CRON EXPRESSION (minute hour day-of-month month day-of-week)</label>
                                                <input
                                                    type="text"
                                                    placeholder="0 2 * * 1-5"
                                                    value={normalizeSchedule(config.schedule).cron}
                                                    onChange={e => setConfig({...config, schedule: {...normalizeSchedule(config.schedule), cron: e.target.value}})}
                                                    style={{ ...s.input, fontFamily: 'monospace', borderColor: cronLooksValid(normalizeSchedule(config.schedule).cron) ? undefined : 'var(--warning)' }}
                                                />
                                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>Example: <code>0 2 * * 1-5</code> runs at 02:00 on weekdays. Evaluated in the server's local time zone.</div>
                                            </div>
                                        )}
                                    </div>
                                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        <div><b>Schedule:</b> {describeSchedule(config.schedule)}</div>
                                        <div><b>Next run:</b> {config.schedule?.enabled ? formatNextRun(scanStatus?.nextRunAt) : 'Not scheduled'}{scanStatus?.schedule?.lastScheduledRunAt ? ` \u00B7 last scheduled run ${new Date(scanStatus.schedule.lastScheduledRunAt).toLocaleString()}` : ''}</div>
                                        <div style={{ color: 'var(--text-muted)' }}>Scans always run in the background worker. A run missed within the last 6 hours (for example while the service restarted) is started once at worker start. Save to apply schedule changes.</div>
                                    </div>

                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 20, background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border-color)', marginTop: 10 }}>
                                        <div>
                                            <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>Auto-Email Report</div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Send Timezone report after scan completion</div>
                                        </div>
                                        <input 
                                            type="checkbox" 
                                            checked={config.timezoneCheck?.autoEmail} 
                                            onChange={e => setConfig({...config, timezoneCheck: {...(config.timezoneCheck || {}), autoEmail: e.target.checked}})}
                                            style={{ width: 22, height: 22, cursor: 'pointer', accentColor: 'var(--accent-primary)' }} 
                                        />
                                    </div>
                                </div>
                            )}

                            {activeSettingsTab === 'timezone' && (
                                <div className={`animate-fade-in ${role === 'Viewer' ? 'pointer-events-none opacity-80' : ''}`}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                                        <div style={{ flex: 1 }}>
                                            <label style={s.metricLabel}>TARGET COMPLIANCE OFFSET (UTC)</label>
                                            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
                                                <input 
                                                    type="number" 
                                                    step="0.5"
                                                    placeholder="e.g. -4 or 8" 
                                                    style={{ ...s.input, width: 150 }} 
                                                    value={config.timezoneCheck?.targetOffset || ''}
                                                    onChange={e => setConfig({...config, timezoneCheck: {...(config.timezoneCheck || {}), targetOffset: e.target.value}})}
                                                />
                                                <button 
                                                    style={{ ...s.viewBtn, whiteSpace: 'nowrap', height: 46 }}
                                                    onClick={() => setShowReportDialog(true)}
                                                >
                                                    {'\u{1F4C4} Generate Report'} ({data.filter(srv => {
                                                        let target = parseFloat(config.timezoneCheck?.targetOffset);
                                                        
                                                        // Check custom subnet offsets first
                                                        const subnetOffsets = config.timezoneCheck?.subnetOffsets || [];
                                                        const override = subnetOffsets.find(so => {
                                                            if (!so.subnet) return false;
                                                            return so.subnet.split(',').some(sub => {
                                                                let t = sub.trim();
                                                                if (!t) return false;
                                                                let prefix = '';
                                                                if (t.endsWith('.*')) prefix = t.slice(0, -1);
                                                                else if (t.endsWith('.0/24')) prefix = t.slice(0, -4) + '.';
                                                                else if (t === srv.ip) return true;
                                                                return prefix && srv.ip && srv.ip.startsWith(prefix);
                                                            });
                                                        });
                                                        if (override && !isNaN(parseFloat(override.targetOffset))) {
                                                            target = parseFloat(override.targetOffset);
                                                        }

                                                        if (isNaN(target) || srv.status === 'offline' || !srv.timezone) return false;
                                                        const isExcluded = (config.timezoneCheck?.exclusions || []).some(ex => {
                                                            if (!ex.target) return false;
                                                            if (ex.target === srv.ip || ex.target === srv.hostname) return true;
                                                            let prefix = '';
                                                            if (ex.target.endsWith('.*')) prefix = ex.target.slice(0, -1);
                                                            else if (ex.target.endsWith('.0/24')) prefix = ex.target.slice(0, -4) + '.';
                                                            if (prefix && srv.ip && srv.ip.startsWith(prefix)) return true;
                                                            return false;
                                                        });
                                                        if (isExcluded) return false;
                                                        const offset = getOffset(srv.timezone);
                                                        return offset !== null && Math.abs(offset - target) > 0.01;
                                                    }).length} issues)
                                                </button>
                                            </div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                                                System will automatically detect Windows (UTC±HH:mm) and Linux (IANA) timezone offsets.
                                            </div>
                                        </div>
                                    </div>

                                    <label style={s.metricLabel}>EXCLUSION LIST</label>
                                    <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, marginTop: 10, overflow: 'hidden' }}>
                                        <div style={{ padding: '12px 16px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: '150px 1fr 60px', gap: 12, fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                            <span>TARGET (IP/HOST)</span>
                                            <span>REASON</span>
                                            <span style={{ textAlign: 'right' }}>ACTION</span>
                                        </div>
                                        <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                                            {(config.timezoneCheck?.exclusions || []).map((ex, idx) => (
                                                <div key={idx} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: '150px 1fr 60px', gap: 12, alignItems: 'center', fontSize: 13 }}>
                                                    <span style={{ fontWeight: 700, fontFamily: 'monospace' }}>{ex.target}</span>
                                                    <span style={{ color: 'var(--text-secondary)' }}>{ex.reason}</span>
                                                    <div style={{ textAlign: 'right' }}>
                                                        <button 
                                                            onClick={() => {
                                                                const newList = [...config.timezoneCheck.exclusions];
                                                                newList.splice(idx, 1);
                                                                setConfig({...config, timezoneCheck: {...config.timezoneCheck, exclusions: newList}});
                                                            }}
                                                            style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 4 }}
                                                        >
                                                            <FiX size={14} />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                            <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: '150px 1fr 60px', gap: 12, alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
                                                <input 
                                                    placeholder="e.g. 192.168.1.1, 10.0.0.*..." 
                                                    style={{ ...s.input, marginTop: 0, padding: '8px 12px' }} 
                                                    value={newExcl.target}
                                                    onChange={e => setNewExcl({...newExcl, target: e.target.value})}
                                                />
                                                <input 
                                                    type="text" 
                                                    placeholder="Reason..." 
                                                    style={{ ...s.input, marginTop: 0, padding: '8px 12px' }} 
                                                    value={newExcl.reason}
                                                    onChange={e => setNewExcl({...newExcl, reason: e.target.value})}
                                                />
                                                {role !== 'Viewer' && (
                                                    <button 
                                                        onClick={() => {
                                                            if (!newExcl.target) return;
                                                            const current = config.timezoneCheck?.exclusions || [];
                                                            const targets = newExcl.target.split(',').map(t => t.trim()).filter(Boolean);
                                                            const newExcls = targets.map(t => ({ target: t, reason: newExcl.reason }));
                                                            setConfig({...config, timezoneCheck: {...(config.timezoneCheck || {}), exclusions: [...current, ...newExcls]}});
                                                            setNewExcl({ target: '', reason: '' });
                                                        }}
                                                        style={{ ...s.btnPrimary, padding: '8px', justifyContent: 'center', borderRadius: 8, minWidth: 0 }}
                                                    >
                                                        <FiPlus size={16} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <label style={{ ...s.metricLabel, marginTop: 24 }}>SUBNET TARGET OVERRIDES</label>
                                    <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, marginTop: 10, overflow: 'hidden' }}>
                                        <div style={{ padding: '12px 16px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: '150px 100px 1fr 60px', gap: 12, fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' }}>
                                            <span>SUBNET</span>
                                            <span>OFFSET (UTC)</span>
                                            <span>REASON</span>
                                            <span style={{ textAlign: 'right' }}>ACTION</span>
                                        </div>
                                        <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                                            {(config.timezoneCheck?.subnetOffsets || []).map((so, idx) => (
                                                <div key={idx} style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: '150px 100px 1fr 60px', gap: 12, alignItems: 'center', fontSize: 13 }}>
                                                    <input 
                                                        style={{ ...s.input, margin: 0, padding: '4px 8px', fontSize: 13, height: 28 }}
                                                        value={so.subnet}
                                                        onChange={e => {
                                                            const newList = [...config.timezoneCheck.subnetOffsets];
                                                            newList[idx].subnet = e.target.value;
                                                            setConfig({...config, timezoneCheck: {...config.timezoneCheck, subnetOffsets: newList}});
                                                        }}
                                                    />
                                                    <input 
                                                        type="number" step="0.5"
                                                        style={{ ...s.input, margin: 0, padding: '4px 8px', fontSize: 13, height: 28 }}
                                                        value={so.targetOffset}
                                                        onChange={e => {
                                                            const newList = [...config.timezoneCheck.subnetOffsets];
                                                            newList[idx].targetOffset = e.target.value;
                                                            setConfig({...config, timezoneCheck: {...config.timezoneCheck, subnetOffsets: newList}});
                                                        }}
                                                    />
                                                    <input 
                                                        style={{ ...s.input, margin: 0, padding: '4px 8px', fontSize: 13, height: 28 }}
                                                        value={so.reason}
                                                        onChange={e => {
                                                            const newList = [...config.timezoneCheck.subnetOffsets];
                                                            newList[idx].reason = e.target.value;
                                                            setConfig({...config, timezoneCheck: {...config.timezoneCheck, subnetOffsets: newList}});
                                                        }}
                                                    />
                                                    <div style={{ textAlign: 'right' }}>
                                                        <button 
                                                            onClick={() => {
                                                                const newList = [...config.timezoneCheck.subnetOffsets];
                                                                newList.splice(idx, 1);
                                                                setConfig({...config, timezoneCheck: {...config.timezoneCheck, subnetOffsets: newList}});
                                                            }}
                                                            style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: 4 }}
                                                        >
                                                            <FiX size={14} />
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                            <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: '150px 100px 1fr 60px', gap: 12, alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
                                                <input 
                                                    placeholder="e.g. 192.168.2.*" 
                                                    style={{ ...s.input, marginTop: 0, padding: '8px 12px' }} 
                                                    value={newOffset.subnet}
                                                    onChange={e => setNewOffset({...newOffset, subnet: e.target.value})}
                                                />
                                                <input 
                                                    type="number"
                                                    step="0.5"
                                                    placeholder="e.g. -5" 
                                                    style={{ ...s.input, marginTop: 0, padding: '8px 12px' }} 
                                                    value={newOffset.targetOffset}
                                                    onChange={e => setNewOffset({...newOffset, targetOffset: e.target.value})}
                                                />
                                                <input 
                                                    type="text" 
                                                    placeholder="Reason..." 
                                                    style={{ ...s.input, marginTop: 0, padding: '8px 12px' }} 
                                                    value={newOffset.reason}
                                                    onChange={e => setNewOffset({...newOffset, reason: e.target.value})}
                                                />
                                                {role !== 'Viewer' && (
                                                    <button 
                                                        onClick={() => {
                                                            if (!newOffset.subnet || !newOffset.targetOffset) return;
                                                            const current = config.timezoneCheck?.subnetOffsets || [];
                                                            const targets = newOffset.subnet.split(',').map(t => t.trim()).filter(Boolean);
                                                            const newOffsets = targets.map(t => ({ subnet: t, targetOffset: newOffset.targetOffset, reason: newOffset.reason }));
                                                            setConfig({...config, timezoneCheck: {...(config.timezoneCheck || {}), subnetOffsets: [...current, ...newOffsets]}});
                                                            setNewOffset({ subnet: '', targetOffset: '', reason: '' });
                                                        }}
                                                        style={{ ...s.btnPrimary, padding: '8px', justifyContent: 'center', borderRadius: 8, minWidth: 0 }}
                                                    >
                                                        <FiPlus size={16} />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeSettingsTab === 'probe' && (
                                <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                                    <ProbeSettingsEditor
                                        s={s}
                                        probeForm={probeForm}
                                        onProbeChange={patch => { setProbeTouched(true); setProbeForm(f => ({ ...f, ...patch })); }}
                                        config={config}
                                        onConfigChange={patch => { setProbeTouched(true); setConfig(c => ({ ...c, ...patch })); }}
                                        canEdit={['SuperAdmin', 'Operator'].includes(role)}
                                    />
                                    <div>
                                        <label style={s.metricLabel}>PER-SUBNET SETTINGS</label>
                                        <SubnetSettingsEditor
                                            s={s}
                                            entries={[...new Set(subnetsText.split(',').map(x => x.trim()).filter(Boolean))]}
                                            forms={subnetForms}
                                            onChange={(key, patch) => { setProbeTouched(true); setSubnetForms(f => ({ ...f, [key]: { ...(f[key] || subnetSettingsToForm(null)), ...patch } })); }}
                                            profiles={profiles}
                                            canEdit={['SuperAdmin', 'Operator'].includes(role)}
                                            canPickProfile={role === 'SuperAdmin'}
                                        />
                                    </div>
                                </div>
                            )}

                            {activeSettingsTab === 'credentials' && role === 'SuperAdmin' && (
                                <div className="animate-fade-in">
                                    <CredentialProfilesEditor s={s} profiles={profiles} onReload={loadProfiles} showToast={showToast} />
                                </div>
                            )}

                            {activeSettingsTab === 'alerts' && (
                                <div className={`animate-fade-in ${role === 'Viewer' ? 'pointer-events-none opacity-80' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                                    <div>
                                        <label style={s.metricLabel}>MONITORED IP WHITELIST (ALERTS ON OFFLINE)</label>
                                        <textarea 
                                            style={s.textarea} 
                                            rows="5" 
                                            value={monitoredIpsText} 
                                            onChange={e => setMonitoredIpsText(e.target.value)}
                                            placeholder="e.g. 10.18.33.11, 10.18.33.12" 
                                        />
                                        <div style={s.hint}>
                                            Enter the IP addresses of important servers that you want to monitor. 
                                            If any of these devices transition from <b>online</b> to <b>offline</b> during a scan, a Telegram alert will be sent immediately.
                                            Separate IPs with commas or newlines.
                                        </div>
                                    </div>

                                    <div style={{ padding: 20, background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border-color)' }}>
                                        <label style={s.metricLabel}>OFFLINE RETENTION THRESHOLD (DAYS FOR PURGE)</label>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                                            <input 
                                                type="number" 
                                                min="1" 
                                                max="365"
                                                value={config.offlineDeleteDays !== undefined ? config.offlineDeleteDays : 7}
                                                onChange={e => {
                                                    const val = parseInt(e.target.value, 10);
                                                    setConfig({ ...config, offlineDeleteDays: isNaN(val) ? 7 : Math.max(1, val) });
                                                }}
                                                style={{ ...s.input, width: 100, marginTop: 0, padding: '8px 12px', textAlign: 'center', fontWeight: 800 }}
                                            />
                                            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Days</span>
                                        </div>
                                        <div style={s.hint}>
                                            Servers that remain offline continuously for more than this number of days will show the <b>DELETE & RELEASE IP</b> action button in the inventory list. 
                                            Deleting removes the host from <b>Server Inventory</b> and <b>Server List (CMDB)</b> and releases its <b>IPAM</b> IP (status "used" only); removing <b>Prometheus Targets</b> and Scout history is optional in the delete dialog. Online hosts never show this button.
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Scan Progress Modal */}
            {showScanModal && scanStatus && (
                <div style={s.modalOverlay} onClick={() => setShowScanModal(false)}>
                    <div style={{ ...s.modal, maxWidth: 800 }} onClick={e => e.stopPropagation()}>
                        <div style={s.modalHeader}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <FiTerminal size={22} style={{ color: 'var(--accent-primary)' }} />
                                <h3 style={{ ...s.overviewTitle, fontSize: 20 }}>Scan Monitor</h3>
                                {(() => {
                                    const b = scanBadge(scanStatus);
                                    if (!b) return null;
                                    const bg = b.tone === 'warning' ? 'var(--warning)' : b.tone === 'danger' ? 'var(--danger)' : 'var(--success)';
                                    return <span style={{ padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 900, background: bg, color: '#fff', animation: scanStatus.running ? 'pulse 1.5s infinite' : undefined }}>{b.label}</span>;
                                })()}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                {scanStatus.running && (
                                    <button
                                        onClick={handleAbortScan}
                                        disabled={!!scanStatus.abortRequested}
                                        style={{ ...s.btnOutline, color: 'var(--danger)', borderColor: 'var(--danger)', padding: '6px 12px', fontSize: 11, borderRadius: 8 }}
                                    >
                                        {scanStatus.abortRequested ? 'Aborting...' : '\u23F9 Abort Scan'}
                                    </button>
                                )}
                                <button onClick={() => setShowScanModal(false)} style={s.closeBtn}><FiX size={20} /></button>
                            </div>
                        </div>
                        {/* Status Bar */}
                        <div style={{ padding: '20px 28px', borderBottom: '1px solid var(--border-color)', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 16 }}>
                            <div><span style={s.metricLabel}>CURRENT TARGET</span><div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{scanStatus.currentIp || '-'}</div></div>
                            <div><span style={s.metricLabel}>SUBNET PROGRESS</span><div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>{scanStatus.subnetProgress}</div></div>
                            <div><span style={s.metricLabel}>DISCOVERED</span><div style={{ fontSize: 15, fontWeight: 800, color: 'var(--accent-primary)' }}>{scanStatus.discovered} hosts</div></div>
                            <div><span style={s.metricLabel}>ELAPSED</span><div style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-primary)' }}>{Math.floor(scanStatus.elapsed / 60)}m {scanStatus.elapsed % 60}s</div></div>
                        </div>
                        {/* Run info: who/what started it, next scheduled run and per-subnet progress */}
                        <div style={{ padding: '12px 28px 0', display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}>
                            {scanStatus.trigger && <span><b>Trigger:</b> {triggerLabel(scanStatus)}</span>}
                            {scanStatus.startedAt && <span><b>Started:</b> {new Date(scanStatus.startedAt).toLocaleString()}</span>}
                            <span><b>Next scheduled run:</b> {formatNextRun(scanStatus.nextRunAt)}</span>
                            {scanStatus.aborted && <span style={{ color: 'var(--danger)' }}>{scanStatus.interrupted ? 'Interrupted: the worker restarted during the scan' : 'Scan was aborted'}</span>}
                            {scanStatus.degraded && <span style={{ color: 'var(--warning)' }}>Some subnets were degraded (results not trusted)</span>}
                            {scanStatus.error && <span style={{ color: 'var(--danger)' }}>Error: {scanStatus.error}</span>}
                        </div>
                        {Array.isArray(scanStatus.subnets) && scanStatus.subnets.length > 0 && (
                            <div style={{ padding: '12px 28px 0', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                {scanStatus.subnets.map(sn => (
                                    <span key={sn.subnet} style={{ padding: '3px 8px', borderRadius: 8, border: '1px solid var(--border-color)', fontSize: 10, fontFamily: 'monospace', color: sn.state === 'running' ? 'var(--accent-primary)' : (sn.state === 'degraded' || sn.state === 'error' ? 'var(--warning)' : 'var(--text-muted)') }} title={sn.state === 'degraded' ? 'Most previously online hosts did not answer: looks like an outage, host status was left unchanged' : undefined}>
                                        {sn.subnet} {sn.processed}/{sn.total} {sn.state}
                                    </span>
                                ))}
                            </div>
                        )}
                        {/* Progress Bar */}
                        <div style={{ padding: '0 28px', marginTop: 16 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)' }}>Overall Progress</span>
                                <span style={{ fontSize: 11, fontWeight: 900, color: 'var(--accent-primary)' }}>{scanStatus.overallProgress}%</span>
                            </div>
                            <div style={{ height: 8, borderRadius: 10, background: 'var(--border-color)', overflow: 'hidden' }}>
                                <div style={{ height: '100%', borderRadius: 10, background: 'var(--accent-primary)', width: `${scanStatus.overallProgress}%`, transition: 'width .5s ease', boxShadow: '0 0 8px var(--accent-glow)' }} />
                            </div>
                        </div>
                        {/* Log Console */}
                        <div style={{ padding: '16px 28px 28px' }}>
                            <span style={{ ...s.metricLabel, marginBottom: 10 }}>OUTPUT LOG</span>
                            <div ref={logEndRef} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, maxHeight: 260, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                                {scanStatus.logs.length === 0 && <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>Waiting for scan output...</div>}
                                {scanStatus.logs.map((line, i) => (
                                    <div key={i} style={{ color: line.includes('ALIVE') ? 'var(--success)' : line.includes('WARN') ? 'var(--warning)' : line.includes('OK:') ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>{line}</div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {showConfirmAction && (
                <div style={s.modalOverlay} onClick={() => setShowConfirmAction(false)}>
                    <div style={{ ...s.modal, maxWidth: 400 }} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: '32px', textAlign: 'center' }}>
                            <h3 style={{ margin: '0 0 16px', color: 'var(--text-primary)' }}>Notification</h3>
                            <p style={{ color: 'var(--text-secondary)', marginBottom: 24, whiteSpace: 'pre-line' }}>{confirmMsg}</p>
                            <button style={{ ...s.btnPrimary, margin: '0 auto' }} onClick={() => setShowConfirmAction(false)}>OK</button>
                        </div>
                    </div>
                </div>
            )}

            {confirmAbort && (
                <div style={s.modalOverlay} onClick={() => setConfirmAbort(false)}>
                    <div style={{ ...s.modal, maxWidth: 400 }} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: '32px', textAlign: 'center' }}>
                            <div style={{ width: 64, height: 64, borderRadius: 32, background: 'rgba(245,158,11,0.1)', color: 'var(--warning)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px' }}>
                                <FiActivity size={32} />
                            </div>
                            <h3 style={{ margin: '0 0 16px', color: 'var(--text-primary)' }}>Abort Scan?</h3>
                            <p style={{ color: 'var(--text-secondary)', marginBottom: 24 }}>Are you sure you want to abort the current scan?</p>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <button style={{ ...s.btnOutline, justifyContent: 'center' }} onClick={() => setConfirmAbort(false)}>CANCEL</button>
                                <button style={{ ...s.btnPrimary, background: 'var(--warning)', color: '#000', justifyContent: 'center' }} onClick={confirmAbortAction}>ABORT</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {showReportDialog && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }} onClick={() => setShowReportDialog(false)}>
                    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, padding: 32, width: '100%', maxWidth: 400, boxShadow: '0 30px 60px rgba(0,0,0,0.5)', textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: 40, marginBottom: 16 }}>{'\u{1F4E7}'}</div>
                        <h2 style={{ margin: '0 0 8px', color: 'var(--text-primary)' }}>Generate Report</h2>
                        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 24px', lineHeight: 1.5 }}>
                            Compile an inventory status report and dispatch it directly to your email inbox.
                        </p>
                        {reporting ? (
                            <div style={{ padding: '16px 0' }}>
                                <div style={{ width: 40, height: 40, border: '3px solid rgba(255,255,255,0.1)', borderTopColor: 'var(--accent-primary)', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 16px' }} />
                                <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Generating and sending report...</div>
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                <button 
                                    style={{ ...s.btnPrimary, width: '100%', justifyContent: 'center', height: 48 }}
                                    onClick={async () => {
                                        setReporting(true);
                                        try {
                                            const headers = () => {
                                                const userStr = localStorage.getItem('user');
                                                if (!userStr) return { 'Content-Type': 'application/json' };
                                                const u = JSON.parse(userStr);
                                                return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${u.token}` };
                                            };
                                            const res = await fetch('/api/inventory/send-report', { method: 'POST', headers: headers() });
                                            if (res.ok) showToast('Report sent successfully!', 'success');
                                            else showToast('Failed to send report.', 'error');
                                        } catch(e) {
                                            showToast('System error while sending report.', 'error');
                                        }
                                        setReporting(false);
                                        setShowReportDialog(false);
                                    }}
                                >
                                    SEND TO MY EMAIL
                                </button>
                                <button 
                                    onClick={() => setShowReportDialog(false)}
                                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 13, marginTop: 12, cursor: 'pointer' }}
                                >
                                    Cancel
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            <HostDetailModal isOpen={!!sharedModalHost} onClose={() => setSharedModalHost(null)} initialHost={sharedModalHost} />
        </div>
    );
};

const styles = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, color: 'var(--text-primary)', margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    headerBtns: { display: 'flex', gap: 10 },

    btnPrimary: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)', transition: 'all .2s' },
    btnOutline: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer', transition: 'all .2s' },

    topRow: { display: 'flex', gap: 20, marginBottom: 28 },
    overviewCard: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    overviewHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
    overviewTitle: { fontSize: 14, fontWeight: 900, color: 'var(--text-primary)', letterSpacing: '0.06em' },
    statusDots: { display: 'flex', gap: 18 },
    dot: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' },
    dotCircle: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },

    subnetGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 },
    subnetCard: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16 },
    subnetName: { fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' },
    subnetMeta: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 },
    progressBg: { height: 5, borderRadius: 10, background: 'var(--border-color)', marginTop: 10, overflow: 'hidden' },
    progressBar: { height: '100%', borderRadius: 10, background: 'var(--accent-primary)', transition: 'width .5s ease' },
    subnetPercent: { fontSize: 10, color: 'var(--text-muted)', marginTop: 4, display: 'block' },

    metricsCol: { width: 280, display: 'flex', flexDirection: 'column', gap: 20 },
    metricCard: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metricLabel: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', display: 'block', marginBottom: 8 },
    metricValue: { fontSize: 36, fontWeight: 900, color: 'var(--text-primary)', lineHeight: 1 },
    metricUnit: { fontSize: 14, fontWeight: 600, color: 'var(--text-muted)' },
    miniBarRow: { display: 'flex', alignItems: 'flex-end', gap: 5, marginTop: 14 },
    miniBar: { width: 20, borderRadius: 4, opacity: 0.7 },

    tableSection: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden' },
    tableHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border-color)' },
    tableTitle: { fontSize: 16, fontWeight: 900, margin: 0, color: 'var(--text-primary)' },
    filterRow: { display: 'flex', alignItems: 'center', gap: 4 },
    filterBtn: { padding: '7px 16px', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: 'transparent', color: 'var(--text-secondary)', transition: 'all .15s' },
    filterActive: { padding: '7px 16px', border: '1px solid var(--accent-primary)', borderRadius: 8, fontSize: 12, fontWeight: 800, cursor: 'pointer', background: 'var(--accent-primary)', color: '#fff', transition: 'all .15s' },
    searchBox: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid var(--border-color)', borderRadius: 8, marginLeft: 8 },
    searchInput: { border: 'none', background: 'transparent', outline: 'none', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', width: 160 },

    table: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background .15s' },
    td: { padding: '14px 24px', verticalAlign: 'middle' },
    deviceIcon: { width: 36, height: 36, borderRadius: 8, background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, border: '1px solid var(--border-color)' },
    deviceName: { fontSize: 14, fontWeight: 800, color: 'var(--text-primary)' },
    deviceSub: { fontSize: 11, color: 'var(--text-muted)' },
    statusOnline: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' },
    healthBadge: { padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' },
    healthNone: { padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'var(--bg-secondary)', color: 'var(--accent-primary)', border: '1px solid var(--accent-primary)' },
    viewBtn: { padding: '8px 18px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 11, fontWeight: 900, cursor: 'pointer', letterSpacing: '0.04em', boxShadow: '0 4px 12px var(--accent-glow)' },

    modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 700, boxShadow: '0 30px 60px rgba(0,0,0,0.3)', overflow: 'hidden', backdropFilter: 'blur(16px)' },
    modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px', borderBottom: '1px solid var(--border-color)' },
    closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 },
    detailItem: { padding: 20, background: 'var(--bg-primary)', borderRadius: 12, border: '1px solid var(--border-color)' },
    textarea: { width: '100%', borderRadius: 16, padding: 20, fontSize: 13, fontWeight: 600, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical', marginTop: 8, fontFamily: 'monospace' },
    input: { width: '100%', borderRadius: 12, padding: '14px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 8 },
    hint: { marginTop: 14, padding: 16, borderRadius: 12, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, lineHeight: 1.6, border: '1px solid var(--border-color)' },

    tabBar: { display: 'flex', background: 'var(--bg-secondary)', padding: '6px', borderBottom: '1px solid var(--border-color)' },
    tabBtn: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', border: 'none', background: 'transparent', color: 'var(--text-muted)', fontSize: 12, fontWeight: 700, cursor: 'pointer', borderRadius: 12, transition: 'all 0.2s' },
    activeTab: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', border: 'none', background: 'var(--bg-primary)', color: 'var(--accent-primary)', fontSize: 12, fontWeight: 900, cursor: 'pointer', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' },
};

export default ServerInventory;
