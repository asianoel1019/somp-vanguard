import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState, useEffect, useMemo } from 'react';
import api from '../../api';
import {
    formatNoteTime, csvCell, initialOf, ageDays, isOverdue, closedRecently, filterIssues, sortIssues, issueKpis,
    SLA_DAYS, URGENCY_LABELS, RESOLUTIONS
} from './hwIssueUtils';
import HwStatusChangeModal from './HwStatusChangeModal';
import HwIssueLinked from './HwIssueLinked';

// One id per spare-part selection: the server deducts stock once per usageId even if the save is retried
const newUsageId = () => (typeof window !== 'undefined' && window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID()
    : `usage-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// Fields the form edits; the timeline, spare-part usages and times are kept by the server
const EDITABLE_FIELDS = ['date', 'datacenter', 'deviceName', 'deviceId', 'rackId', 'sn', 'rackLoc', 'failedParts', 'reporter', 'urgency', 'status',
    'partsInfo', 'assignee', 'rmaNumber', 'dueDate', 'resolution'];
const URGENCY_COLORS = { H: 'var(--danger)', M: '#f59e0b', L: 'var(--success)' };
const STATUS_COLORS = { Open: 'var(--text-primary)', Processing: '#3b82f6', Closed: 'var(--success)' };
const COLUMNS = [
    { status: 'Open', label: '🚨 Open', color: 'var(--text-primary)' },
    { status: 'Processing', label: '⚙️ Processing', color: '#3b82f6' },
    { status: 'Closed', label: '✅ Closed', color: 'var(--success)' },
];
const EMPTY_FILTERS = { q: '', dc: 'ALL', urgency: 'ALL', status: 'ALL', from: '', to: '', overdueOnly: false };
const SORTABLE = [['date', 'Date'], ['datacenter', 'Datacenter'], ['deviceName', 'Device / SN'], [null, 'Location'], [null, 'Failed Parts'],
    ['urgency', 'Urgency'], ['status', 'Status'], ['age', 'Age'], ['assignee', 'Assignee'], [null, 'Action']];

const inputStyle = { width: '100%', padding: 10, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6 };
const labelStyle = { fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, display: 'block' };
const thStyle = { padding: '12px 16px', color: 'var(--text-muted)', whiteSpace: 'nowrap' };
const tdStyle = { padding: '12px 16px' };

/** Very old issues kept the timeline as text lines. */
function withTimeline(i) {
    let notes = i.processNotes || [];
    if (typeof notes === 'string') {
        notes = notes.split('\n').filter(Boolean).map(n => {
            const match = n.match(/\[(.*?)\] (.*?): (.*)/);
            return match
                ? { timestamp: match[1], status: match[2], note: match[3], user: 'System' }
                : { timestamp: '', status: 'Legacy Note', note: n, user: 'System' };
        });
    }
    return { ...i, processNotes: notes };
}

/** "3d" age chip; red with "overdue" when past its deadline. */
function AgeChip({ issue, now }) {
    const days = ageDays(issue, now);
    if (days === null) return null;
    const late = isOverdue(issue, now);
    return (
        <span title={late ? 'Past its due date' : issue.status === 'Closed' ? 'Days it was open' : 'Days open'}
            style={{ fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 4, whiteSpace: 'nowrap',
                background: late ? 'rgba(239,68,68,0.18)' : 'rgba(255,255,255,0.08)', color: late ? 'var(--danger)' : 'var(--text-muted)' }}>
            {days}d{late ? ' · overdue' : ''}
        </span>
    );
}

function UrgencyBadge({ urgency, closed }) {
    if (closed) return <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.1)', color: 'var(--text-muted)', fontSize: 10, fontWeight: 700 }}>CLOSED</span>;
    return (
        <span style={{ padding: '2px 6px', borderRadius: 4, background: URGENCY_COLORS[urgency] || URGENCY_COLORS.M, color: '#fff', fontSize: 10, fontWeight: 700 }}>
            {(URGENCY_LABELS[urgency] || 'Medium').toUpperCase()}
        </span>
    );
}

function IssueCard({ issue, now, draggable, onOpen, onDragStart }) {
    const closed = issue.status === 'Closed';
    return (
        <div className={`kanban-card ${issue.urgency === 'H' && !closed ? 'glow-red' : ''}`} onClick={onOpen}
            draggable={draggable} onDragStart={onDragStart} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}
            style={{ borderLeft: isOverdue(issue, now) ? '3px solid var(--danger)' : undefined, cursor: draggable ? 'grab' : 'pointer' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 14, textDecoration: closed ? 'line-through' : 'none', opacity: closed ? 0.7 : 1 }}>{issue.deviceName}</div>
                <UrgencyBadge urgency={issue.urgency} closed={closed} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>📍 {issue.datacenter}{issue.rackLoc ? ` | ${issue.rackLoc}` : ''}</div>
            {!closed && <div style={{ fontSize: 12, color: 'var(--text-primary)', marginTop: 4 }}>🔧 {issue.failedParts}</div>}
            {closed && issue.resolution && <div style={{ fontSize: 12, color: 'var(--success)', marginTop: 4 }}>✔ {issue.resolution}</div>}
            {issue.rmaNumber && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>RMA {issue.rmaNumber}</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <div style={{ width: 20, height: 20, flexShrink: 0, borderRadius: '50%', background: closed ? 'var(--bg-tertiary)' : 'var(--accent-primary)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800 }}>
                        {initialOf(issue.assignee || issue.reporter)}
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {issue.assignee ? `→ ${issue.assignee}` : issue.reporter}
                    </span>
                </div>
                <AgeChip issue={issue} now={now} />
            </div>
        </div>
    );
}

export default function HardwareIssues({ onShowInRack }) {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const canWrite = role !== 'Viewer';

    const [hwIssues, setHwIssues] = useState([]);
    const [initialLoaded, setInitialLoaded] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    // UI state
    const [viewMode, setViewMode] = useState('kanban');
    const [filters, setFilters] = useState(EMPTY_FILTERS);
    const [showAllClosed, setShowAllClosed] = useState(false);
    const [sort, setSort] = useState({ key: 'date', dir: 'desc' });
    const [showHWFormModal, setShowHWFormModal] = useState(false);
    const [activeDropdownId, setActiveDropdownId] = useState(null);
    const [currentHWForm, setCurrentHWForm] = useState(null);
    const [isHWFormReadOnly, setIsHWFormReadOnly] = useState(false);
    const [statusChange, setStatusChange] = useState(null); // { issue, to } while a dragged card waits for its note
    const [dragOver, setDragOver] = useState(null);

    // Process Note State inside Drawer
    const [processType, setProcessType] = useState('Note'); // 'Note', 'Processing', 'Closed' or 'Open' (reopen)
    const [processNote, setProcessNote] = useState('');
    const [processResolution, setProcessResolution] = useState('');

    // Datacenter & Device selection state
    const [dcs, setDcs] = useState([]);
    const [formRacks, setFormRacks] = useState([]);
    const [contracts, setContracts] = useState([]);

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
        api.get('/rack/datacenters').then(res => {
            if (res.data) setDcs(res.data);
        }).catch(err => console.error('Failed to fetch datacenters:', err));

        api.get('/rack/issues').then(res => {
            if (res.data) setHwIssues(res.data.map(withTimeline));
            setInitialLoaded(true);
        }).catch(err => {
            console.error('Failed to fetch issues:', err);
            setInitialLoaded(true);
        });

        api.get('/rack/spare-parts').then(res => {
            if (res.data) setSparePartsData(res.data);
        }).catch(err => console.error('Failed to fetch spare parts:', err));

        // warranties are optional context
        api.get('/rack/contracts').then(res => setContracts(Array.isArray(res.data) ? res.data : [])).catch(() => {});

        // Click outside logic for Action Menu in table view
        const closeDropdown = (e) => {
            if (!e.target.closest('.action-dropdown-container')) setActiveDropdownId(null);
        };
        document.addEventListener('click', closeDropdown);
        // ages and overdue marks move with the clock
        const tick = setInterval(() => setNow(Date.now()), 60 * 1000);
        return () => { document.removeEventListener('click', closeDropdown); clearInterval(tick); };
    }, []);

    const loadRacksOf = (dcName) => {
        const dc = dcs.find(d => d.name === dcName);
        if (!dc) { setFormRacks([]); return; }
        api.get(`/rack?dcId=${dc.id}`).then(res => { if (res.data) setFormRacks(res.data); }).catch(console.error);
    };

    // Load racks when a DC is selected
    const handleDCChange = (dcName) => {
        setCurrentHWForm(prev => ({ ...prev, datacenter: dcName, deviceName: '', deviceId: '', rackId: '', sn: '', rackLoc: '' }));
        loadRacksOf(dcName);
    };

    const availableDevices = useMemo(() => {
        const devs = [];
        formRacks.forEach(r => {
            (r.devices || []).forEach(d => {
                if (!['Shelf', 'Reserve', 'PatchPanel'].includes(d.type)) devs.push({ ...d, rackId: r.id, rackLoc: `${r.name} - U${d.u}` });
            });
        });
        return devs.sort((a, b) => (a.hostname || '').localeCompare(b.hostname || ''));
    }, [formRacks]);

    const handleDeviceChange = (deviceId) => {
        const dev = availableDevices.find(d => d.id === deviceId);
        if (dev) setCurrentHWForm(prev => ({ ...prev, deviceName: dev.hostname, deviceId: dev.id, rackId: dev.rackId, sn: dev.sn || '', rackLoc: dev.rackLoc }));
        else setCurrentHWForm(prev => ({ ...prev, deviceName: deviceId, deviceId: '', rackId: '', sn: '', rackLoc: '' }));
    };

    const resetPartSelection = () => {
        setUseSparePart(false);
        setSelectedSparePartId('');
        setSparePartQty(1);
        setSparePartUsageId('');
    };

    const resetTimelineInput = () => {
        setProcessNote('');
        setProcessType('Note');
        setProcessResolution('');
    };

    const openCreateForm = () => {
        setFormRacks([]);
        setIsHWFormReadOnly(false);
        resetTimelineInput();
        resetPartSelection();
        setCurrentHWForm({
            date: new Date().toISOString().split('T')[0],
            datacenter: '', deviceName: '', deviceId: '', rackId: '', sn: '', rackLoc: '', failedParts: '',
            reporter: user.username || '', urgency: 'M', status: 'Open', partsInfo: '',
            assignee: '', rmaNumber: '', dueDate: '', processNotes: []
        });
        setShowHWFormModal(true);
    };

    const openEditForm = (issue, readOnly = false) => {
        setIsHWFormReadOnly(readOnly);
        setCurrentHWForm(issue);
        resetTimelineInput();
        resetPartSelection();
        loadRacksOf(issue.datacenter);
        setShowHWFormModal(true);
    };

    const applySavedIssue = (saved) => {
        const s = withTimeline(saved);
        setHwIssues(prev => (prev.some(i => i.id === s.id) ? prev.map(i => (i.id === s.id ? s : i)) : [...prev, s]));
        return s;
    };

    const handleSaveIssue = (e) => {
        e.preventDefault();
        if (!canWrite) { setShowHWFormModal(false); return; }
        const finalForm = {};
        EDITABLE_FIELDS.forEach(k => { if (currentHWForm[k] !== undefined) finalForm[k] = currentHWForm[k]; });
        if (currentHWForm.id && currentHWForm.updatedAt) finalForm.expectedUpdatedAt = currentHWForm.updatedAt;

        const usesPart = useSparePart && selectedSparePartId && sparePartQty > 0;
        if (usesPart) {
            finalForm.sparePartUsage = { partId: selectedSparePartId, qty: sparePartQty, usageId: sparePartUsageId || newUsageId() };
        }
        const request = currentHWForm.id
            ? api.put(`/rack/issues/${currentHWForm.id}`, finalForm)
            : api.post('/rack/issues/single', finalForm);
        request.then(res => {
            applySavedIssue(res.data.issue);
            setShowHWFormModal(false);
            if (usesPart) reloadSpareParts();
        }).catch(err => {
            console.error('Failed to save issue:', err);
            const current = err.response?.status === 409 && err.response.data && err.response.data.issue;
            // someone else saved first: show their version; the user applies the changes again
            if (current) setCurrentHWForm(applySavedIssue(current));
            // otherwise keep the form (and the usageId) so a retry does not deduct twice
            showToast(err.response?.data?.error || 'Failed to save issue.', 'error');
        });
    };

    const handleDeleteIssue = async (id) => {
        if (!await showConfirm('Delete this issue?')) return;
        api.delete(`/rack/issues/${id}`).then(() => {
            setHwIssues(prev => prev.filter(i => i.id !== id));
            if (currentHWForm && currentHWForm.id === id) setShowHWFormModal(false);
        }).catch(err => {
            console.error('Failed to delete issue:', err);
            showToast(err.response?.data?.error || 'Failed to delete issue.', 'error');
        });
    };

    // Timeline entries are added by the server, which stamps the time and the user
    const handleUpdateProcessStatus = () => {
        if (!canWrite || !currentHWForm.id) return;
        const body = { type: processType, note: processNote.trim() };
        if (processType === 'Closed' && processResolution) body.resolution = processResolution;
        const usesPart = useSparePart && selectedSparePartId && sparePartQty > 0;
        if (usesPart) {
            body.sparePartUsage = { partId: selectedSparePartId, qty: sparePartQty, usageId: sparePartUsageId || newUsageId() };
            if (!sparePartUsageId) setSparePartUsageId(body.sparePartUsage.usageId);
        }
        api.post(`/rack/issues/${currentHWForm.id}/notes`, body).then(res => {
            setCurrentHWForm(applySavedIssue(res.data.issue));
            resetTimelineInput();
            resetPartSelection();
            if (usesPart) reloadSpareParts();
        }).catch(err => {
            console.error('Failed to update issue:', err);
            showToast(err.response?.data?.error || 'Failed to update issue.', 'error');
        });
    };

    // ---- derived lists ------------------------------------------------------------------------------------------
    const filteredIssues = useMemo(() => filterIssues(hwIssues, filters, now), [hwIssues, filters, now]);
    const sortedIssues = useMemo(() => sortIssues(filteredIssues, sort.key, sort.dir, now), [filteredIssues, sort, now]);
    const kpis = useMemo(() => issueKpis(hwIssues, now), [hwIssues, now]);
    const dcNames = useMemo(() => [...new Set([...dcs.map(d => d.name), ...hwIssues.map(i => i.datacenter).filter(Boolean)])].sort(), [dcs, hwIssues]);
    const peopleNames = useMemo(() => [...new Set(hwIssues.flatMap(i => [i.reporter, i.assignee]).filter(Boolean))].sort(), [hwIssues]);
    const filtersActive = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);
    const setFilter = (key, value) => setFilters(prev => ({ ...prev, [key]: value }));

    const exportIssuesToCSV = () => {
        const headers = ['Date', 'Datacenter', 'Device', 'SN', 'Location', 'Failed Parts', 'Reporter', 'Assignee', 'RMA / Case', 'Urgency', 'Status',
            'Due Date', 'Days Open', 'Overdue', 'Resolution', 'Closed At', 'Process Notes'];
        const rows = sortedIssues.map(i => [
            i.date, i.datacenter, i.deviceName, i.sn, i.rackLoc, i.failedParts, i.reporter, i.assignee, i.rmaNumber,
            URGENCY_LABELS[i.urgency] || i.urgency, i.status, i.dueDate, ageDays(i, now) ?? '', isOverdue(i, now) ? 'yes' : '', i.resolution,
            formatNoteTime(i.closedAt),
            (Array.isArray(i.processNotes) ? i.processNotes : []).map(n => `[${formatNoteTime(n.timestamp)}] ${n.user ? `${n.user} ` : ''}${n.status}: ${n.note}`).join(' | ')
        ].map(csvCell));
        const blob = new Blob(['﻿' + [headers.join(','), ...rows.map(e => e.join(','))].join('\r\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `hw_issues_${new Date().toISOString().split('T')[0]}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 0);
    };

    // ---- drag and drop between columns (writers) ----------------------------------------------------------------
    const onDropTo = (status) => (e) => {
        e.preventDefault();
        setDragOver(null);
        const id = e.dataTransfer.getData('text/plain');
        const issue = hwIssues.find(i => i.id === id);
        if (issue && issue.status !== status) setStatusChange({ issue, to: status });
    };

    if (!initialLoaded) return <div style={{ padding: 40, textAlign: 'center' }}>Loading Issues...</div>;

    const columnIssues = (status) => sortIssues(filteredIssues.filter(i => i.status === status && (status !== 'Closed' || showAllClosed || closedRecently(i, now))), 'date', 'desc', now);
    const hiddenClosed = filteredIssues.filter(i => i.status === 'Closed' && !closedRecently(i, now)).length;
    const dcOfForm = currentHWForm ? dcs.find(d => d.name === currentHWForm.datacenter) : null;
    const formLocked = isHWFormReadOnly || !canWrite;

    const kpiCards = [
        { label: 'Open', value: kpis.open, icon: '🚨', color: '#ef4444', sub: `High ${kpis.openByUrgency.H} · Med ${kpis.openByUrgency.M} · Low ${kpis.openByUrgency.L}` },
        { label: 'Processing', value: kpis.processing, icon: '⚙️', color: '#3b82f6' },
        { label: 'Overdue', value: kpis.overdue, icon: '⏰', color: kpis.overdue ? '#ef4444' : '#94a3b8', sub: `High ${SLA_DAYS.H}d · Med ${SLA_DAYS.M}d · Low ${SLA_DAYS.L}d`,
            onClick: () => setFilters({ ...EMPTY_FILTERS, overdueOnly: true }), title: 'Show the overdue issues' },
        { label: 'Closed (30 days)', value: kpis.closed30, icon: '✅', color: '#10b981' },
        { label: 'Avg days to close', value: kpis.avgDaysToClose ?? '-', icon: '⏱️', color: '#8b5cf6', sub: kpis.closedCounted ? `${kpis.closedCounted} closed in 90 days` : 'none closed in 90 days' },
        { label: 'Active by DC', value: kpis.activeByDc.length, icon: '🏢', color: '#06b6d4', sub: kpis.activeByDc.slice(0, 3).map(([dc, n]) => `${dc} ${n}`).join(' · ') || 'none' },
    ];

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Header & Ribbon */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
                <h1 className="page-title" style={{ margin: 0 }}>Hardware Issues & Maintenance</h1>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', background: 'rgba(0,0,0,0.2)', padding: 4, borderRadius: 8, border: '1px solid var(--border-color)' }}>
                        {[['table', '📄 Table'], ['kanban', '📇 Kanban']].map(([mode, text]) => (
                            <button key={mode} className={`btn ${viewMode === mode ? 'btn-primary' : ''}`} onClick={() => setViewMode(mode)}
                                style={{ padding: '6px 12px', background: viewMode === mode ? 'var(--accent-primary)' : 'transparent', color: viewMode === mode ? '#fff' : 'var(--text-muted)', border: 'none', boxShadow: 'none' }}>
                                {text}
                            </button>
                        ))}
                    </div>
                    <button className="btn btn-outline" onClick={exportIssuesToCSV} title="Exports the issues that match the filters" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        📥 Export CSV
                    </button>
                    {canWrite && (
                        <button className="btn btn-primary" onClick={openCreateForm} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>+ Report Issue</button>
                    )}
                </div>
            </div>

            {/* Figures */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 16 }}>
                {kpiCards.map(k => (
                    <div key={k.label} className="glass-panel" onClick={k.onClick} title={k.title} role={k.onClick ? 'button' : undefined}
                        style={{ padding: '12px 16px', borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12, cursor: k.onClick ? 'pointer' : 'default' }}>
                        <div style={{ background: `${k.color}33`, color: k.color, width: 38, height: 38, flexShrink: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>{k.icon}</div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{k.label}</div>
                            <div style={{ fontSize: 22, fontWeight: 800, color: k.label === 'Overdue' && kpis.overdue ? 'var(--danger)' : undefined }}>{k.value}</div>
                            {k.sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{k.sub}</div>}
                        </div>
                    </div>
                ))}
            </div>

            {/* Filters */}
            <div className="glass-panel" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 14px', borderRadius: 12, marginBottom: 16 }}>
                <input type="search" value={filters.q} onChange={e => setFilter('q', e.target.value)} aria-label="Search issues"
                    placeholder="Search device, SN, part, reporter, assignee, RMA..." style={{ flex: '1 1 240px', padding: '8px 10px', borderRadius: 8 }} />
                <select value={filters.dc} onChange={e => setFilter('dc', e.target.value)} aria-label="Datacenter" style={{ padding: '8px 10px', borderRadius: 8 }}>
                    <option value="ALL">All datacenters</option>
                    {dcNames.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <select value={filters.urgency} onChange={e => setFilter('urgency', e.target.value)} aria-label="Urgency" style={{ padding: '8px 10px', borderRadius: 8 }}>
                    <option value="ALL">All urgencies</option>
                    {['H', 'M', 'L'].map(u => <option key={u} value={u}>{URGENCY_LABELS[u]}</option>)}
                </select>
                <select value={filters.status} onChange={e => setFilter('status', e.target.value)} aria-label="Status" style={{ padding: '8px 10px', borderRadius: 8 }}>
                    <option value="ALL">All statuses</option>
                    {COLUMNS.map(c => <option key={c.status} value={c.status}>{c.status}</option>)}
                </select>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                    From <input type="date" value={filters.from} onChange={e => setFilter('from', e.target.value)} style={{ padding: '6px 8px', borderRadius: 8 }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                    To <input type="date" value={filters.to} onChange={e => setFilter('to', e.target.value)} style={{ padding: '6px 8px', borderRadius: 8 }} />
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={filters.overdueOnly} onChange={e => setFilter('overdueOnly', e.target.checked)} /> Overdue only
                </label>
                {filtersActive && <button type="button" className="btn btn-outline" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</button>}
                <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{filteredIssues.length} of {hwIssues.length} issues</span>
            </div>

            {/* Views */}
            {viewMode === 'kanban' ? (
                <div className="kanban-board">
                    {COLUMNS.map(col => {
                        const list = columnIssues(col.status);
                        return (
                            <div key={col.status} className="kanban-column"
                                style={{ opacity: col.status === 'Closed' ? 0.85 : 1, outline: dragOver === col.status ? '2px dashed var(--accent-primary)' : 'none', outlineOffset: -4 }}
                                onDragOver={canWrite ? (e) => { e.preventDefault(); if (dragOver !== col.status) setDragOver(col.status); } : undefined}
                                onDragLeave={canWrite ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(null); } : undefined}
                                onDrop={canWrite ? onDropTo(col.status) : undefined}>
                                <div className="kanban-header">
                                    <span style={{ color: col.color }}>{col.label}</span>
                                    <span style={{ fontSize: 12, background: 'rgba(255,255,255,0.1)', padding: '2px 8px', borderRadius: 12 }}>{list.length}</span>
                                </div>
                                {col.status === 'Closed' && (hiddenClosed > 0 || showAllClosed) && (
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)', padding: '0 4px 8px', cursor: 'pointer' }}>
                                        <input type="checkbox" checked={showAllClosed} onChange={e => setShowAllClosed(e.target.checked)} />
                                        Show older closed issues{hiddenClosed && !showAllClosed ? ` (${hiddenClosed})` : ''}
                                    </label>
                                )}
                                <div className="kanban-cards">
                                    {list.map(issue => (
                                        <IssueCard key={issue.id} issue={issue} now={now} draggable={canWrite}
                                            onOpen={() => openEditForm(issue, !canWrite)}
                                            onDragStart={(e) => { e.dataTransfer.setData('text/plain', issue.id); e.dataTransfer.effectAllowed = 'move'; }} />
                                    ))}
                                    {list.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>{canWrite ? 'Drop a card here' : 'No issues'}</div>}
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div style={{ flex: 1, overflow: 'auto', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, minHeight: '300px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-primary)', zIndex: 10 }}>
                            <tr style={{ borderBottom: '1px solid var(--border-color)', textAlign: 'left' }}>
                                {SORTABLE.map(([key, text]) => (
                                    <th key={text} style={{ ...thStyle, cursor: key ? 'pointer' : 'default' }}
                                        aria-sort={key && sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                                        onClick={key ? () => setSort(prev => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' })) : undefined}>
                                        {text}{key && sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {sortedIssues.map(issue => (
                                <tr key={issue.id} style={{ borderBottom: '1px solid var(--border-color)', background: isOverdue(issue, now) ? 'rgba(239,68,68,0.06)' : undefined }}>
                                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{issue.date}</td>
                                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{issue.datacenter}</td>
                                    <td style={{ ...tdStyle, cursor: 'pointer' }} onClick={() => openEditForm(issue, !canWrite)}>
                                        <span style={{ color: 'var(--accent-primary)', textDecoration: 'underline' }}>{issue.deviceName}</span>
                                        <br />
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>SN: {issue.sn}</span>
                                    </td>
                                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>{issue.rackLoc}</td>
                                    <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{issue.failedParts}</td>
                                    <td style={tdStyle}>
                                        <span style={{ padding: '4px 8px', borderRadius: 4, background: URGENCY_COLORS[issue.urgency] || URGENCY_COLORS.M, color: '#fff', fontSize: 11, fontWeight: 700 }}>{URGENCY_LABELS[issue.urgency] || issue.urgency}</span>
                                    </td>
                                    <td style={{ ...tdStyle, whiteSpace: 'nowrap', fontWeight: 700, color: STATUS_COLORS[issue.status] || 'var(--text-primary)' }}>
                                        {issue.status}
                                        {issue.status === 'Closed' && issue.resolution && <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>{issue.resolution}</div>}
                                    </td>
                                    <td style={tdStyle}><AgeChip issue={issue} now={now} /></td>
                                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{issue.assignee || <span style={{ color: 'var(--text-muted)' }}>-</span>}{issue.rmaNumber && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>RMA {issue.rmaNumber}</div>}</td>
                                    <td style={tdStyle}>
                                        <div className="action-dropdown-container" style={{ position: 'relative', display: 'inline-block' }}>
                                            <button className="btn btn-outline" style={{ padding: '4px 12px', fontSize: 12 }} onClick={() => setActiveDropdownId(activeDropdownId === issue.id ? null : issue.id)}>Actions ▾</button>
                                            {activeDropdownId === issue.id && (
                                                <div className="action-dropdown-menu glass-panel" style={{
                                                    position: 'absolute', right: 0, top: '100%', bottom: 'auto', marginTop: '4px', zIndex: 100, display: 'flex', flexDirection: 'column', gap: 2, padding: 8, minWidth: 150, boxShadow: '0 8px 16px rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: 8, textAlign: 'left'
                                                }}>
                                                    <button className="dropdown-item-btn" style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', padding: 8, textAlign: 'left', cursor: 'pointer', borderRadius: 4, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => openEditForm(issue, !canWrite)}>
                                                        {canWrite ? <><span style={{ width: 16 }}>✏️</span> View / Edit</> : <><span style={{ width: 16 }}>👁️</span> View</>}
                                                    </button>
                                                    {canWrite && (
                                                        <button className="dropdown-item-btn" style={{ background: 'transparent', border: 'none', color: 'var(--danger)', padding: 8, textAlign: 'left', cursor: 'pointer', borderRadius: 4, fontSize: 12, borderTop: '1px solid var(--border-color)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }} onClick={() => handleDeleteIssue(issue.id)}>
                                                            <span style={{ width: 16 }}>🗑️</span> Delete
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {sortedIssues.length === 0 && (
                                <tr><td colSpan={SORTABLE.length} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>{filtersActive ? 'No issues match the filters.' : 'No issues reported.'}</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            {statusChange && (
                <HwStatusChangeModal issue={statusChange.issue} to={statusChange.to}
                    onCancel={() => setStatusChange(null)}
                    onSaved={(saved) => { applySavedIssue(saved); setStatusChange(null); }}
                    onError={(msg) => showToast(msg, 'error')} />
            )}

            {/* Slide-out Drawer Panel */}
            {showHWFormModal && currentHWForm && (
                <div className="drawer-overlay" onClick={(e) => { if (e.target.className === 'drawer-overlay') setShowHWFormModal(false); }}>
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
                                        <label style={labelStyle}>Date</label>
                                        <input type="date" value={currentHWForm.date || ''} onChange={e => setCurrentHWForm({ ...currentHWForm, date: e.target.value })} disabled={formLocked} required style={inputStyle} />
                                    </div>
                                    <div className="form-group">
                                        <label style={labelStyle}>Reporter</label>
                                        <input type="text" value={currentHWForm.reporter || ''} onChange={e => setCurrentHWForm({ ...currentHWForm, reporter: e.target.value })} disabled={formLocked} required style={inputStyle} />
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }}>
                                    <div className="form-group">
                                        <label style={labelStyle}>Datacenter</label>
                                        {isHWFormReadOnly ? (
                                            <div style={inputStyle}>{currentHWForm.datacenter || 'N/A'}</div>
                                        ) : (
                                            <select value={currentHWForm.datacenter || ''} onChange={e => handleDCChange(e.target.value)} required style={inputStyle}>
                                                <option value="">Select DC</option>
                                                {dcs.map(dc => <option key={dc.id} value={dc.name}>{dc.name}</option>)}
                                                {currentHWForm.datacenter && !dcs.find(d => d.name === currentHWForm.datacenter) && <option value={currentHWForm.datacenter}>{currentHWForm.datacenter} (Legacy)</option>}
                                            </select>
                                        )}
                                    </div>

                                    <div className="form-group">
                                        <label style={labelStyle}>Device</label>
                                        {isHWFormReadOnly ? (
                                            <div style={inputStyle}>{currentHWForm.deviceName || 'N/A'}{currentHWForm.sn ? ` (SN ${currentHWForm.sn})` : ''}</div>
                                        ) : (
                                            <select value={availableDevices.find(d => d.id === currentHWForm.deviceId || d.hostname === currentHWForm.deviceName)?.id || currentHWForm.deviceName || ''} onChange={e => handleDeviceChange(e.target.value)} required style={inputStyle}>
                                                <option value="">Select Device</option>
                                                {availableDevices.map(d => <option key={d.id} value={d.id}>{d.hostname} {d.sn ? `(${d.sn})` : ''}</option>)}
                                                {currentHWForm.deviceName && !availableDevices.find(d => d.id === currentHWForm.deviceId || d.hostname === currentHWForm.deviceName) && <option value={currentHWForm.deviceName}>{currentHWForm.deviceName} (Manual/Legacy)</option>}
                                            </select>
                                        )}
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16, marginBottom: 16 }}>
                                    <div className="form-group">
                                        <label style={labelStyle}>Location</label>
                                        <input type="text" value={currentHWForm.rackLoc || ''} onChange={e => setCurrentHWForm({ ...currentHWForm, rackLoc: e.target.value })} disabled={formLocked} placeholder="e.g. Rack A - U10" required style={inputStyle} />
                                    </div>
                                    <div className="form-group">
                                        <label style={labelStyle}>Failed Parts</label>
                                        <input type="text" value={currentHWForm.failedParts || ''} onChange={e => setCurrentHWForm({ ...currentHWForm, failedParts: e.target.value })} disabled={formLocked} required style={inputStyle} />
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                                    <div className="form-group">
                                        <label style={labelStyle}>Urgency</label>
                                        <select value={currentHWForm.urgency || 'M'} onChange={e => setCurrentHWForm({ ...currentHWForm, urgency: e.target.value })} disabled={formLocked} style={{ ...inputStyle, color: URGENCY_COLORS[currentHWForm.urgency] || 'var(--text-primary)' }}>
                                            <option value="H" style={{ color: 'var(--danger)' }}>High</option>
                                            <option value="M" style={{ color: 'var(--text-primary)' }}>Medium</option>
                                            <option value="L" style={{ color: 'var(--success)' }}>Low</option>
                                        </select>
                                    </div>
                                    <div className="form-group" title={currentHWForm.id ? 'Change the status from the Process Timeline below, or drag the card' : undefined}>
                                        <label style={labelStyle}>Status</label>
                                        <select value={currentHWForm.status || 'Open'} onChange={e => setCurrentHWForm({ ...currentHWForm, status: e.target.value })} disabled={formLocked || !!currentHWForm.id} style={inputStyle}>
                                            {COLUMNS.map(c => <option key={c.status} value={c.status}>{c.status}</option>)}
                                        </select>
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                                    <div className="form-group">
                                        <label style={labelStyle}>Assignee</label>
                                        <input type="text" list="hw-people" value={currentHWForm.assignee || ''} onChange={e => setCurrentHWForm({ ...currentHWForm, assignee: e.target.value })} disabled={formLocked} maxLength={100} placeholder="Who handles it" style={inputStyle} />
                                        <datalist id="hw-people">{peopleNames.map(n => <option key={n} value={n} />)}</datalist>
                                    </div>
                                    <div className="form-group">
                                        <label style={labelStyle}>RMA / vendor case no.</label>
                                        <input type="text" value={currentHWForm.rmaNumber || ''} onChange={e => setCurrentHWForm({ ...currentHWForm, rmaNumber: e.target.value })} disabled={formLocked} maxLength={100} style={inputStyle} />
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
                                    <div className="form-group">
                                        <label style={labelStyle}>Due date</label>
                                        <input type="date" value={currentHWForm.dueDate || ''} onChange={e => setCurrentHWForm({ ...currentHWForm, dueDate: e.target.value })} disabled={formLocked} style={inputStyle} />
                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Empty: {SLA_DAYS.H} / {SLA_DAYS.M} / {SLA_DAYS.L} days for High / Medium / Low.</div>
                                    </div>
                                    {currentHWForm.status === 'Closed' && (
                                        <div className="form-group">
                                            <label style={labelStyle}>Resolution</label>
                                            <select value={currentHWForm.resolution || ''} onChange={e => setCurrentHWForm({ ...currentHWForm, resolution: e.target.value })} disabled={formLocked} style={inputStyle}>
                                                <option value="">(not specified)</option>
                                                {RESOLUTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                                            </select>
                                        </div>
                                    )}
                                </div>

                                {(currentHWForm.id || currentHWForm.deviceName) && (
                                    <HwIssueLinked issue={currentHWForm} contracts={contracts} spareItems={sparePartsData.items} now={now} dc={dcOfForm}
                                        onShowInRack={onShowInRack ? (dcId, rackId) => { setShowHWFormModal(false); onShowInRack(dcId, rackId); } : null} />
                                )}

                                {/* Spare Parts Integration Option */}
                                {!formLocked && (
                                    <div style={{ background: 'rgba(59,130,246,0.05)', padding: 16, borderRadius: 8, marginBottom: 24, border: '1px solid rgba(59,130,246,0.2)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: useSparePart ? 12 : 0 }}>
                                            <input type="checkbox" id="useSparePart" checked={useSparePart} onChange={e => setUseSparePart(e.target.checked)} style={{ cursor: 'pointer' }} />
                                            <label htmlFor="useSparePart" style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent-primary)', margin: 0, cursor: 'pointer' }}>🛠️ Use Spare Part for Repair (Auto Deduct Inventory)</label>
                                        </div>
                                        {useSparePart && (
                                            <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                                                <div style={{ flex: 1 }}>
                                                    <label style={{ ...labelStyle, fontSize: 11 }}>Select Spare Part</label>
                                                    <select value={selectedSparePartId} onChange={e => { setSelectedSparePartId(e.target.value); setSparePartUsageId(e.target.value ? newUsageId() : ''); }} required={useSparePart} style={{ ...inputStyle, padding: 8, color: 'var(--text-primary)' }}>
                                                        <option value="">-- Choose Part --</option>
                                                        {(sparePartsData.items || []).map(item => (
                                                            <option key={item.id} value={item.id} disabled={!(item.quantity > 0)}>
                                                                {item.name} ({item.category}) - Stock: {item.quantity ?? 0}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div style={{ width: '80px' }}>
                                                    <label style={{ ...labelStyle, fontSize: 11 }}>Qty</label>
                                                    <input type="number" min="1" value={sparePartQty} onChange={e => setSparePartQty(parseInt(e.target.value) || 1)} required={useSparePart} style={{ ...inputStyle, padding: 8, color: 'var(--text-primary)' }} />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Process Timeline Integration in Drawer */}
                                <div className="form-group" style={{ marginBottom: 24 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                                        <label style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Process Timeline</label>
                                        {currentHWForm.id && (
                                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                                {currentHWForm.createdBy ? `Created by ${currentHWForm.createdBy}` : ''}
                                                {currentHWForm.createdAt ? ` on ${formatNoteTime(currentHWForm.createdAt)}` : ''}
                                                {currentHWForm.closedAt ? ` · Closed ${formatNoteTime(currentHWForm.closedAt)}` : ''}
                                            </span>
                                        )}
                                    </div>

                                    {!formLocked && currentHWForm.id && (
                                        <div style={{ background: 'rgba(0,0,0,0.2)', padding: 16, borderRadius: 8, marginBottom: 16, border: '1px solid rgba(255,255,255,0.05)' }}>
                                            <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                                                <select value={processType} onChange={e => setProcessType(e.target.value)} style={{ padding: 8, borderRadius: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', width: 130 }}>
                                                    <option value="Note">📝 Note</option>
                                                    <option value="Processing">⚙️ Process</option>
                                                    <option value="Closed">✅ Close</option>
                                                    {currentHWForm.status === 'Closed' && <option value="Open">↩️ Reopen</option>}
                                                </select>
                                                {processType === 'Closed' && (
                                                    <select value={processResolution} onChange={e => setProcessResolution(e.target.value)} aria-label="Resolution" style={{ padding: 8, borderRadius: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)' }}>
                                                        <option value="">Resolution...</option>
                                                        {RESOLUTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                                                    </select>
                                                )}
                                                <input
                                                    type="text"
                                                    value={processNote}
                                                    onChange={e => setProcessNote(e.target.value)}
                                                    placeholder="Add an update note..."
                                                    maxLength={2000}
                                                    style={{ flex: 1, minWidth: 180, padding: 8, borderRadius: 6, background: 'var(--bg-primary)', border: '1px solid var(--border-color)' }}
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
                                                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatNoteTime(note.timestamp)}</span>
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
                                {!formLocked && currentHWForm.id && (
                                    <button type="button" className="btn btn-outline" style={{ color: 'var(--danger)', borderColor: 'var(--danger)', marginRight: 'auto' }} onClick={() => handleDeleteIssue(currentHWForm.id)}>Delete</button>
                                )}
                                {formLocked ? (
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
