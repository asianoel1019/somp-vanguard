import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState, useEffect, useMemo } from 'react';
import {
    TbAlertTriangle, TbProgress, TbAlarm, TbCircleCheck, TbStopwatch, TbBuilding, TbTable, TbLayoutKanban, TbDownload, TbPlus,
    TbSearch, TbFilterOff, TbMapPin, TbTool, TbTicket, TbArrowRight, TbChevronDown, TbPencil, TbEye, TbTrash, TbX, TbNote, TbTools
} from 'react-icons/tb';
import api from '../../api';
import {
    formatNoteTime, csvCell, initialOf, ageDays, isOverdue, closedRecently, filterIssues, sortIssues, issueKpis,
    SLA_DAYS, URGENCY_LABELS, RESOLUTIONS
} from './hwIssueUtils';
import { URGENCY_TONE, STATUS_META, entryTone } from './hwIssueTheme';
import { UrgencyBadge, StatusBadge, AgeChip } from './HwIssueParts';
import HwStatusChangeModal from './HwStatusChangeModal';
import HwIssueLinked from './HwIssueLinked';
import './hwIssues.css';

// One id per spare-part selection: the server deducts stock once per usageId even if the save is retried
const newUsageId = () => (typeof window !== 'undefined' && window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID()
    : `usage-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// Fields the form edits; the timeline, spare-part usages and times are kept by the server
const EDITABLE_FIELDS = ['date', 'datacenter', 'deviceName', 'deviceId', 'rackId', 'sn', 'rackLoc', 'failedParts', 'reporter', 'urgency', 'status',
    'partsInfo', 'assignee', 'rmaNumber', 'dueDate', 'resolution'];
const STATUSES = ['Open', 'Processing', 'Closed'];
const EMPTY_FILTERS = { q: '', dc: 'ALL', urgency: 'ALL', status: 'ALL', from: '', to: '', overdueOnly: false };
const SORTABLE = [['date', 'Date'], ['datacenter', 'Datacenter'], ['deviceName', 'Device / SN'], [null, 'Location'], [null, 'Failed Parts'],
    ['urgency', 'Urgency'], ['status', 'Status'], ['age', 'Age'], ['assignee', 'Assignee'], [null, 'Action']];

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

function IssueCard({ issue, now, draggable, onOpen, onDragStart }) {
    const closed = issue.status === 'Closed';
    const classes = ['kanban-card', 'hw-card', issue.urgency === 'H' && !closed ? 'glow-red' : '', closed ? 'is-closed' : '',
        isOverdue(issue, now) ? 'is-overdue' : '', draggable ? 'is-draggable' : ''].filter(Boolean).join(' ');
    return (
        <div className={classes} onClick={onOpen} draggable={draggable} onDragStart={onDragStart} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
            <div className="hw-card-head">
                <div className="hw-card-title">{issue.deviceName}</div>
                {closed ? <StatusBadge status="Closed" /> : <UrgencyBadge urgency={issue.urgency} />}
            </div>
            <div className="hw-line"><TbMapPin size={14} aria-hidden="true" />{issue.datacenter}{issue.rackLoc ? ` · ${issue.rackLoc}` : ''}</div>
            {!closed && <div className="hw-line is-strong"><TbTool size={14} aria-hidden="true" />{issue.failedParts}</div>}
            {closed && issue.resolution && <div className="hw-line is-good"><TbCircleCheck size={14} aria-hidden="true" />{issue.resolution}</div>}
            {issue.rmaNumber && <div className="hw-line"><TbTicket size={14} aria-hidden="true" />RMA {issue.rmaNumber}</div>}
            <div className="hw-card-foot">
                <div className="hw-person">
                    <div className={`hw-avatar${closed ? ' is-muted' : ''}`}>{initialOf(issue.assignee || issue.reporter)}</div>
                    {issue.assignee ? <><TbArrowRight size={12} aria-hidden="true" /><span>{issue.assignee}</span></> : <span>{issue.reporter}</span>}
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
            if (!e.target.closest('.hw-menu-wrap')) setActiveDropdownId(null);
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
    const setFormField = (key, value) => setCurrentHWForm(prev => ({ ...prev, [key]: value }));

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

    if (!initialLoaded) return <div className="hw-empty-row">Loading Issues...</div>;

    const columnIssues = (status) => sortIssues(filteredIssues.filter(i => i.status === status && (status !== 'Closed' || showAllClosed || closedRecently(i, now))), 'date', 'desc', now);
    const hiddenClosed = filteredIssues.filter(i => i.status === 'Closed' && !closedRecently(i, now)).length;
    const dcOfForm = currentHWForm ? dcs.find(d => d.name === currentHWForm.datacenter) : null;
    const formLocked = isHWFormReadOnly || !canWrite;

    const kpiCards = [
        { id: 'open', label: 'Open', value: kpis.open, icon: TbAlertTriangle, tone: 'var(--danger)', sub: `High ${kpis.openByUrgency.H} · Med ${kpis.openByUrgency.M} · Low ${kpis.openByUrgency.L}` },
        { id: 'processing', label: 'Processing', value: kpis.processing, icon: TbProgress, tone: 'var(--accent-primary)' },
        { id: 'overdue', label: 'Overdue', value: kpis.overdue, icon: TbAlarm, tone: kpis.overdue ? 'var(--danger)' : 'var(--text-muted)', alert: kpis.overdue > 0,
            sub: `High ${SLA_DAYS.H}d · Med ${SLA_DAYS.M}d · Low ${SLA_DAYS.L}d`, onClick: () => setFilters({ ...EMPTY_FILTERS, overdueOnly: true }), title: 'Show the overdue issues' },
        { id: 'closed', label: 'Closed (30 days)', value: kpis.closed30, icon: TbCircleCheck, tone: 'var(--success)' },
        { id: 'avg', label: 'Avg days to close', value: kpis.avgDaysToClose ?? '-', icon: TbStopwatch, tone: 'var(--accent-primary)',
            sub: kpis.closedCounted ? `${kpis.closedCounted} closed in 90 days` : 'none closed in 90 days' },
        { id: 'dc', label: 'Active by DC', value: kpis.activeByDc.length, icon: TbBuilding, tone: 'var(--text-secondary)',
            sub: kpis.activeByDc.slice(0, 3).map(([dc, n]) => `${dc} ${n}`).join(' · ') || 'none' },
    ];

    return (
        <div className="hw-page">
            <div className="hw-header">
                <h1 className="page-title">Hardware Issues & Maintenance</h1>
                <div className="hw-actions">
                    <div className="hw-seg" role="tablist" aria-label="View">
                        {[['table', 'Table', TbTable], ['kanban', 'Kanban', TbLayoutKanban]].map(([mode, text, icon]) => {
                            const Icon = icon;
                            return (
                                <button key={mode} type="button" role="tab" aria-selected={viewMode === mode} className={viewMode === mode ? 'is-active' : ''} onClick={() => setViewMode(mode)}>
                                    <Icon size={16} aria-hidden="true" />{text}
                                </button>
                            );
                        })}
                    </div>
                    <button className="btn btn-outline hw-btn" onClick={exportIssuesToCSV} title="Exports the issues that match the filters">
                        <TbDownload size={16} aria-hidden="true" /> Export CSV
                    </button>
                    {canWrite && (
                        <button className="btn btn-primary hw-btn" onClick={openCreateForm}><TbPlus size={16} aria-hidden="true" /> Report Issue</button>
                    )}
                </div>
            </div>

            {/* Figures */}
            <div className="hw-kpis">
                {kpiCards.map(k => {
                    const Icon = k.icon;
                    return (
                        <div key={k.id} className={`glass-panel hw-kpi${k.onClick ? ' is-clickable' : ''}`} style={{ '--hw-tone': k.tone }}
                            onClick={k.onClick} title={k.title} role={k.onClick ? 'button' : undefined} tabIndex={k.onClick ? 0 : undefined}
                            onKeyDown={k.onClick ? (e) => { if (e.key === 'Enter') k.onClick(); } : undefined}>
                            <div className="hw-kpi-icon"><Icon size={20} aria-hidden="true" /></div>
                            <div className="hw-kpi-body">
                                <div className="hw-kpi-label">{k.label}</div>
                                <div className={`hw-kpi-value${k.alert ? ' is-alert' : ''}`}>{k.value}</div>
                                {k.sub && <div className="hw-kpi-sub">{k.sub}</div>}
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Filters */}
            <div className="glass-panel hw-filters">
                <div className="hw-search">
                    <TbSearch size={16} aria-hidden="true" />
                    <input type="search" value={filters.q} onChange={e => setFilter('q', e.target.value)} aria-label="Search issues"
                        placeholder="Search device, SN, part, reporter, assignee, RMA..." />
                </div>
                <select value={filters.dc} onChange={e => setFilter('dc', e.target.value)} aria-label="Datacenter">
                    <option value="ALL">All datacenters</option>
                    {dcNames.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <select value={filters.urgency} onChange={e => setFilter('urgency', e.target.value)} aria-label="Urgency">
                    <option value="ALL">All urgencies</option>
                    {['H', 'M', 'L'].map(u => <option key={u} value={u}>{URGENCY_LABELS[u]}</option>)}
                </select>
                <select value={filters.status} onChange={e => setFilter('status', e.target.value)} aria-label="Status">
                    <option value="ALL">All statuses</option>
                    {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <label className="hw-inline-label">From <input type="date" value={filters.from} onChange={e => setFilter('from', e.target.value)} /></label>
                <label className="hw-inline-label">To <input type="date" value={filters.to} onChange={e => setFilter('to', e.target.value)} /></label>
                <label className="hw-inline-label">
                    <input type="checkbox" checked={filters.overdueOnly} onChange={e => setFilter('overdueOnly', e.target.checked)} /> Overdue only
                </label>
                {filtersActive && (
                    <button type="button" className="btn btn-outline hw-btn hw-btn-sm" onClick={() => setFilters(EMPTY_FILTERS)}>
                        <TbFilterOff size={14} aria-hidden="true" /> Clear filters
                    </button>
                )}
                <span className="hw-count">{filteredIssues.length} of {hwIssues.length} issues</span>
            </div>

            {/* Views */}
            {viewMode === 'kanban' ? (
                <div className="kanban-board">
                    {STATUSES.map(status => {
                        const list = columnIssues(status);
                        const meta = STATUS_META[status];
                        const Icon = meta.icon;
                        return (
                            <div key={status} className={`kanban-column hw-column${status === 'Closed' ? ' is-closed' : ''}${dragOver === status ? ' is-drop-target' : ''}`}
                                onDragOver={canWrite ? (e) => { e.preventDefault(); if (dragOver !== status) setDragOver(status); } : undefined}
                                onDragLeave={canWrite ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(null); } : undefined}
                                onDrop={canWrite ? onDropTo(status) : undefined}>
                                <div className="kanban-header">
                                    <span className="hw-column-title" style={{ '--hw-tone': meta.tone }}><Icon size={16} aria-hidden="true" />{status}</span>
                                    <span className="hw-column-count">{list.length}</span>
                                </div>
                                {status === 'Closed' && (hiddenClosed > 0 || showAllClosed) && (
                                    <label className="hw-older">
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
                                    {list.length === 0 && <div className="hw-column-empty">{canWrite ? 'Drop a card here' : 'No issues'}</div>}
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <div className="hw-table-wrap">
                    <table className="hw-table">
                        <thead>
                            <tr>
                                {SORTABLE.map(([key, text]) => (
                                    <th key={text} className={key ? 'is-sortable' : undefined}
                                        aria-sort={key && sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                                        onClick={key ? () => setSort(prev => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' })) : undefined}>
                                        {text}{key && sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {sortedIssues.map(issue => (
                                <tr key={issue.id} className={isOverdue(issue, now) ? 'is-overdue' : undefined}>
                                    <td className="hw-nowrap hw-muted">{issue.date}</td>
                                    <td className="hw-nowrap">{issue.datacenter}</td>
                                    <td>
                                        <button type="button" className="hw-link" onClick={() => openEditForm(issue, !canWrite)}>{issue.deviceName}</button>
                                        <div className="hw-muted hw-small">SN: {issue.sn || '-'}</div>
                                    </td>
                                    <td className="hw-nowrap">{issue.rackLoc}</td>
                                    <td className="hw-muted">{issue.failedParts}</td>
                                    <td><UrgencyBadge urgency={issue.urgency} /></td>
                                    <td className="hw-nowrap">
                                        <StatusBadge status={issue.status} />
                                        {issue.status === 'Closed' && issue.resolution && <div className="hw-muted hw-small">{issue.resolution}</div>}
                                    </td>
                                    <td><AgeChip issue={issue} now={now} /></td>
                                    <td className="hw-nowrap">
                                        {issue.assignee || <span className="hw-muted">-</span>}
                                        {issue.rmaNumber && <div className="hw-muted hw-small">RMA {issue.rmaNumber}</div>}
                                    </td>
                                    <td>
                                        <div className="hw-menu-wrap">
                                            <button type="button" className="btn btn-outline hw-btn hw-btn-sm" aria-haspopup="menu" aria-expanded={activeDropdownId === issue.id}
                                                onClick={() => setActiveDropdownId(activeDropdownId === issue.id ? null : issue.id)}>
                                                Actions <TbChevronDown size={14} aria-hidden="true" />
                                            </button>
                                            {activeDropdownId === issue.id && (
                                                <div className="glass-panel hw-menu" role="menu">
                                                    <button type="button" role="menuitem" onClick={() => openEditForm(issue, !canWrite)}>
                                                        {canWrite ? <><TbPencil size={14} aria-hidden="true" /> View / Edit</> : <><TbEye size={14} aria-hidden="true" /> View</>}
                                                    </button>
                                                    {canWrite && (
                                                        <button type="button" role="menuitem" className="is-danger" onClick={() => handleDeleteIssue(issue.id)}>
                                                            <TbTrash size={14} aria-hidden="true" /> Delete
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                            {sortedIssues.length === 0 && (
                                <tr><td colSpan={SORTABLE.length} className="hw-empty-row">{filtersActive ? 'No issues match the filters.' : 'No issues reported.'}</td></tr>
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
                <div className="drawer-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowHWFormModal(false); }}>
                    <div className="drawer-panel" role="dialog" aria-modal="true" aria-label="Hardware issue">
                        <div className="drawer-header">
                            <h2 className="hw-drawer-title">{isHWFormReadOnly ? 'Issue Details' : currentHWForm.id ? 'Edit Issue' : 'Report HW Issue'}</h2>
                            <button type="button" className="hw-icon-btn" aria-label="Close" onClick={() => setShowHWFormModal(false)}><TbX size={20} aria-hidden="true" /></button>
                        </div>

                        <form onSubmit={handleSaveIssue} className="hw-form-form">
                            <div className="drawer-body">
                                <div className="hw-grid">
                                    <div className="hw-field">
                                        <label htmlFor="hw-date">Date</label>
                                        <input id="hw-date" type="date" value={currentHWForm.date || ''} onChange={e => setFormField('date', e.target.value)} disabled={formLocked} required />
                                    </div>
                                    <div className="hw-field">
                                        <label htmlFor="hw-reporter">Reporter</label>
                                        <input id="hw-reporter" type="text" value={currentHWForm.reporter || ''} onChange={e => setFormField('reporter', e.target.value)} disabled={formLocked} required />
                                    </div>
                                </div>

                                <div className="hw-grid is-one">
                                    <div className="hw-field">
                                        <label htmlFor="hw-dc">Datacenter</label>
                                        {isHWFormReadOnly ? (
                                            <div className="hw-readonly">{currentHWForm.datacenter || 'N/A'}</div>
                                        ) : (
                                            <select id="hw-dc" value={currentHWForm.datacenter || ''} onChange={e => handleDCChange(e.target.value)} required>
                                                <option value="">Select DC</option>
                                                {dcs.map(dc => <option key={dc.id} value={dc.name}>{dc.name}</option>)}
                                                {currentHWForm.datacenter && !dcs.find(d => d.name === currentHWForm.datacenter) && <option value={currentHWForm.datacenter}>{currentHWForm.datacenter} (Legacy)</option>}
                                            </select>
                                        )}
                                    </div>
                                    <div className="hw-field">
                                        <label htmlFor="hw-device">Device</label>
                                        {isHWFormReadOnly ? (
                                            <div className="hw-readonly">{currentHWForm.deviceName || 'N/A'}{currentHWForm.sn ? ` (SN ${currentHWForm.sn})` : ''}</div>
                                        ) : (
                                            <select id="hw-device" value={availableDevices.find(d => d.id === currentHWForm.deviceId || d.hostname === currentHWForm.deviceName)?.id || currentHWForm.deviceName || ''} onChange={e => handleDeviceChange(e.target.value)} required>
                                                <option value="">Select Device</option>
                                                {availableDevices.map(d => <option key={d.id} value={d.id}>{d.hostname} {d.sn ? `(${d.sn})` : ''}</option>)}
                                                {currentHWForm.deviceName && !availableDevices.find(d => d.id === currentHWForm.deviceId || d.hostname === currentHWForm.deviceName) && <option value={currentHWForm.deviceName}>{currentHWForm.deviceName} (Manual/Legacy)</option>}
                                            </select>
                                        )}
                                    </div>
                                    <div className="hw-field">
                                        <label htmlFor="hw-loc">Location</label>
                                        <input id="hw-loc" type="text" value={currentHWForm.rackLoc || ''} onChange={e => setFormField('rackLoc', e.target.value)} disabled={formLocked} placeholder="e.g. Rack A - U10" required />
                                    </div>
                                    <div className="hw-field">
                                        <label htmlFor="hw-parts">Failed Parts</label>
                                        <input id="hw-parts" type="text" value={currentHWForm.failedParts || ''} onChange={e => setFormField('failedParts', e.target.value)} disabled={formLocked} required />
                                    </div>
                                </div>

                                <div className="hw-grid">
                                    <div className="hw-field">
                                        <label htmlFor="hw-urgency">Urgency</label>
                                        <select id="hw-urgency" value={currentHWForm.urgency || 'M'} onChange={e => setFormField('urgency', e.target.value)} disabled={formLocked}
                                            style={{ color: URGENCY_TONE[currentHWForm.urgency] || 'var(--text-primary)' }}>
                                            {['H', 'M', 'L'].map(u => <option key={u} value={u}>{URGENCY_LABELS[u]}</option>)}
                                        </select>
                                    </div>
                                    <div className="hw-field" title={currentHWForm.id ? 'Change the status from the Process Timeline below, or drag the card' : undefined}>
                                        <label htmlFor="hw-status">Status</label>
                                        <select id="hw-status" value={currentHWForm.status || 'Open'} onChange={e => setFormField('status', e.target.value)} disabled={formLocked || !!currentHWForm.id}>
                                            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                        </select>
                                    </div>
                                    <div className="hw-field">
                                        <label htmlFor="hw-assignee">Assignee</label>
                                        <input id="hw-assignee" type="text" list="hw-people" value={currentHWForm.assignee || ''} onChange={e => setFormField('assignee', e.target.value)} disabled={formLocked} maxLength={100} placeholder="Who handles it" />
                                        <datalist id="hw-people">{peopleNames.map(n => <option key={n} value={n} />)}</datalist>
                                    </div>
                                    <div className="hw-field">
                                        <label htmlFor="hw-rma">RMA / vendor case no.</label>
                                        <input id="hw-rma" type="text" value={currentHWForm.rmaNumber || ''} onChange={e => setFormField('rmaNumber', e.target.value)} disabled={formLocked} maxLength={100} />
                                    </div>
                                    <div className="hw-field">
                                        <label htmlFor="hw-due">Due date</label>
                                        <input id="hw-due" type="date" value={currentHWForm.dueDate || ''} onChange={e => setFormField('dueDate', e.target.value)} disabled={formLocked} />
                                        <div className="hw-field-help">Empty: {SLA_DAYS.H} / {SLA_DAYS.M} / {SLA_DAYS.L} days for High / Medium / Low.</div>
                                    </div>
                                    {currentHWForm.status === 'Closed' && (
                                        <div className="hw-field">
                                            <label htmlFor="hw-resolution">Resolution</label>
                                            <select id="hw-resolution" value={currentHWForm.resolution || ''} onChange={e => setFormField('resolution', e.target.value)} disabled={formLocked}>
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
                                    <div className="hw-box is-accent hw-section">
                                        <label className="hw-check">
                                            <input type="checkbox" checked={useSparePart} onChange={e => setUseSparePart(e.target.checked)} />
                                            <TbTools size={16} aria-hidden="true" /> Use a spare part for the repair (deducted from the inventory)
                                        </label>
                                        {useSparePart && (
                                            <div className="hw-box-row">
                                                <div className="hw-field" style={{ flex: 1 }}>
                                                    <label htmlFor="hw-spare">Spare part</label>
                                                    <select id="hw-spare" value={selectedSparePartId} onChange={e => { setSelectedSparePartId(e.target.value); setSparePartUsageId(e.target.value ? newUsageId() : ''); }} required={useSparePart}>
                                                        <option value="">-- Choose Part --</option>
                                                        {(sparePartsData.items || []).map(item => (
                                                            <option key={item.id} value={item.id} disabled={!(item.quantity > 0)}>
                                                                {item.name} ({item.category}) - Stock: {item.quantity ?? 0}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div className="hw-field" style={{ width: 90 }}>
                                                    <label htmlFor="hw-spare-qty">Qty</label>
                                                    <input id="hw-spare-qty" type="number" min="1" value={sparePartQty} onChange={e => setSparePartQty(parseInt(e.target.value) || 1)} required={useSparePart} />
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Process Timeline */}
                                <div className="hw-section">
                                    <div className="hw-section-head">
                                        <span className="hw-section-title"><TbNote size={16} aria-hidden="true" /> Process Timeline</span>
                                        {currentHWForm.id && (
                                            <span className="hw-muted hw-small">
                                                {currentHWForm.createdBy ? `Created by ${currentHWForm.createdBy}` : ''}
                                                {currentHWForm.createdAt ? ` on ${formatNoteTime(currentHWForm.createdAt)}` : ''}
                                                {currentHWForm.closedAt ? ` · Closed ${formatNoteTime(currentHWForm.closedAt)}` : ''}
                                            </span>
                                        )}
                                    </div>

                                    {!formLocked && currentHWForm.id && (
                                        <div className="hw-box hw-section">
                                            <div className="hw-box-row">
                                                <select value={processType} onChange={e => setProcessType(e.target.value)} aria-label="Update type">
                                                    <option value="Note">Note</option>
                                                    <option value="Processing">Move to Processing</option>
                                                    <option value="Closed">Close</option>
                                                    {currentHWForm.status === 'Closed' && <option value="Open">Reopen</option>}
                                                </select>
                                                {processType === 'Closed' && (
                                                    <select value={processResolution} onChange={e => setProcessResolution(e.target.value)} aria-label="Resolution">
                                                        <option value="">Resolution...</option>
                                                        {RESOLUTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                                                    </select>
                                                )}
                                                <input type="text" value={processNote} onChange={e => setProcessNote(e.target.value)} placeholder="Add an update note..." maxLength={2000} aria-label="Update note" />
                                            </div>
                                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                                <button type="button" className="btn btn-primary hw-btn-sm" onClick={handleUpdateProcessStatus} disabled={!processNote.trim()}>Add Update</button>
                                            </div>
                                        </div>
                                    )}

                                    <div className="hw-timeline">
                                        {(currentHWForm.processNotes || []).length === 0 ? (
                                            <div className="hw-empty-row">No process notes yet.</div>
                                        ) : (
                                            (currentHWForm.processNotes || []).map((note, idx) => (
                                                <div key={idx} className="hw-entry" style={{ '--hw-tone': entryTone(note.status) }}>
                                                    <div className="hw-entry-rail" />
                                                    <div className="hw-entry-body">
                                                        <div className="hw-entry-head">
                                                            <span className="hw-entry-status">{note.status}</span>
                                                            <span className="hw-muted hw-small">{formatNoteTime(note.timestamp)}</span>
                                                        </div>
                                                        <div className="hw-entry-note">{note.note}</div>
                                                        <div className="hw-entry-by">By: {note.user || 'Unknown'}</div>
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </div>

                            <div className="drawer-footer">
                                {!formLocked && currentHWForm.id && (
                                    <button type="button" className="btn btn-outline hw-btn hw-btn-danger" style={{ marginRight: 'auto' }} onClick={() => handleDeleteIssue(currentHWForm.id)}>
                                        <TbTrash size={16} aria-hidden="true" /> Delete
                                    </button>
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
