import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    TbPlus, TbSearch, TbTable, TbLayoutGrid, TbFileExport, TbShieldCheck, TbHourglassHigh, TbShieldX, TbCalendarDue,
    TbReceipt2, TbLicense, TbTrash, TbFileText, TbServer2, TbAlertTriangle, TbRestore,
} from 'react-icons/tb';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import {
    STATUSES, SORTS, contractKpis, moneyText, filterContracts, sortContracts, vendorsOf, contractsCsv, emptyContract,
    editDraft, renewalDraft, relatedIssues, seatUsage, formatMoney, contractStatus,
} from './contractUtils';
import { formatNoteTime } from './hwIssueUtils';
import { CONTRACT_STATUS_META } from './contractTheme';
import { ContractStatusBadge, DaysChip, TermBar } from './ContractParts';
import ContractForm from './ContractForm';
import ContractDrawer from './ContractDrawer';
import './hwIssues.css';
import './contracts.css';

const TABS = [
    ['Hardware Warranties', 'Hardware Warranties', TbShieldCheck],
    ['Software Licenses', 'Software Licenses', TbLicense],
    ['Trash', 'Trash', TbTrash],
];
const VIEW_KEY = 'contracts_view_mode';

function readView() {
    try { return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'table'; } catch { return 'table'; }
}

function Kpi({ label, value, sub, tone, icon, active, onClick, alert }) {
    const Icon = icon;
    return (
        <div
            className={`glass-panel hw-kpi${onClick ? ' is-clickable' : ''}`}
            style={{ '--hw-tone': tone, ...(active ? { outline: `2px solid ${tone}` } : {}) }}
            onClick={onClick}
            onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
            aria-pressed={onClick ? !!active : undefined}
        >
            <span className="hw-kpi-icon"><Icon size={20} aria-hidden="true" /></span>
            <div className="hw-kpi-body">
                <div className="hw-kpi-label">{label}</div>
                <div className={`hw-kpi-value${alert ? ' is-alert' : ''}`}>{value}</div>
                {sub && <div className="hw-kpi-sub" title={sub}>{sub}</div>}
            </div>
        </div>
    );
}

const ContractsWarranties = ({ onShowInRack }) => {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const role = useMemo(() => {
        try { return JSON.parse(localStorage.getItem('user') || '{}').role || 'Viewer'; } catch { return 'Viewer'; }
    }, []);
    const canWrite = role === 'SuperAdmin' || role === 'Operator';
    const isSuperAdmin = role === 'SuperAdmin';

    const [contracts, setContracts] = useState([]);
    const [devices, setDevices] = useState([]);
    const [issues, setIssues] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [tab, setTab] = useState('Hardware Warranties');
    const [view, setView] = useState(readView);
    const [q, setQ] = useState('');
    const [status, setStatus] = useState('ALL');
    const [vendor, setVendor] = useState('ALL');
    const [sort, setSort] = useState('end');
    const [selectedId, setSelectedId] = useState(null);
    const [formState, setFormState] = useState(null); // { draft, stored, renewing }
    const [now, setNow] = useState(() => Date.now()); // refreshed with every load

    const [reloadKey, setReloadKey] = useState(0);
    const load = useCallback(() => setReloadKey(k => k + 1), []);

    useEffect(() => {
        let alive = true;
        Promise.all([
            api.get('/rack/contracts'),
            api.get('/rack/contracts/devices').catch(() => ({ data: [] })),
            api.get('/rack/issues').catch(() => ({ data: [] })),
        ]).then(([con, dev, iss]) => {
            if (!alive) return;
            setContracts(Array.isArray(con.data) ? con.data : []);
            setDevices(Array.isArray(dev.data) ? dev.data : []);
            setIssues(Array.isArray(iss.data) ? iss.data : []);
            setLoadError('');
            setNow(Date.now());
        }).catch(err => {
            if (alive) setLoadError(err.response?.data?.error || 'Failed to load the contracts.');
        }).finally(() => {
            if (alive) setLoading(false);
        });
        return () => { alive = false; };
    }, [reloadKey]);

    const changeView = (v) => {
        setView(v);
        try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ }
    };
    const changeTab = (t) => { setTab(t); setStatus('ALL'); setVendor('ALL'); };

    const devicesById = useMemo(() => new Map(devices.map(d => [d.id, d])), [devices]);
    const kpis = useMemo(() => contractKpis(contracts, tab === 'Trash' ? null : tab, now), [contracts, tab, now]);
    const counts = useMemo(() => ({
        'Hardware Warranties': contracts.filter(c => !c.deletedAt && c.type === 'Hardware Warranties').length,
        'Software Licenses': contracts.filter(c => !c.deletedAt && c.type === 'Software Licenses').length,
        Trash: contracts.filter(c => c.deletedAt).length,
    }), [contracts]);
    const tabContracts = useMemo(() => contracts.filter(c => (tab === 'Trash' ? c.deletedAt : !c.deletedAt && c.type === tab)), [contracts, tab]);
    const vendors = useMemo(() => vendorsOf(tabContracts), [tabContracts]);
    const shown = useMemo(
        () => sortContracts(filterContracts(contracts, { tab, q, status, vendor }, now, devicesById), tab === 'Trash' ? 'updated' : sort, now),
        [contracts, tab, q, status, vendor, sort, now, devicesById],
    );
    const selected = selectedId ? contracts.find(c => c.id === selectedId) : null;
    const covered = useMemo(() => new Set(contracts.filter(c => !c.deletedAt && !c.renewedTo).flatMap(c => c.linkedDevices || [])).size, [contracts]);

    const toggleStatus = (s) => setStatus(prev => (prev === s ? 'ALL' : s));

    // ---- actions ----
    const openNew = () => setFormState({ draft: emptyContract(tab === 'Trash' ? 'Hardware Warranties' : tab), stored: null, renewing: false });
    const openEdit = (c) => setFormState({ draft: editDraft(c), stored: c, renewing: false });
    const openRenew = (c) => setFormState({ draft: renewalDraft(c), stored: c, renewing: true });

    const saved = (c) => {
        setFormState(null);
        showToast(formState && formState.renewing ? 'Renewal saved' : 'Contract saved', 'success');
        setSelectedId(c.id);
        load();
    };
    const conflict = (current) => {
        setContracts(prev => prev.map(c => (c.id === current.id ? current : c)));
    };

    const trash = async (c) => {
        if (!await showConfirm(`Move "${c.name}" to the trash? It can be restored from the Trash tab.`)) return;
        try {
            await api.delete(`/rack/contracts/${c.id}`);
            showToast('Moved to trash', 'success');
            setSelectedId(null);
            load();
        } catch (err) {
            showToast(err.response?.data?.error || 'Failed to move the contract to the trash.', 'error');
        }
    };
    const restore = async (c) => {
        try {
            await api.post(`/rack/contracts/${c.id}/restore`);
            showToast('Contract restored', 'success');
            load();
        } catch (err) {
            showToast(err.response?.data?.error || 'Restore failed.', 'error');
        }
    };
    const forceDelete = async (c) => {
        if (!await showConfirm(`Permanently delete "${c.name}" and its file? This cannot be undone.`)) return;
        try {
            await api.delete(`/rack/contracts/${c.id}/force`);
            showToast('Contract permanently deleted', 'success');
            setSelectedId(null);
            load();
        } catch (err) {
            showToast(err.response?.data?.error || 'Delete failed.', 'error');
        }
    };
    const download = async (c) => {
        try {
            const res = await api.get(`/rack/contracts/download/${encodeURIComponent(c.savedFileName)}`, { responseType: 'blob' });
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const link = document.createElement('a');
            link.href = url;
            link.download = c.originalFileName || c.savedFileName;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        } catch {
            showToast('Failed to download the file.', 'error');
        }
    };
    const copy = async (text) => {
        try {
            await navigator.clipboard.writeText(text);
            showToast('Copied', 'success');
        } catch {
            showToast('Copy is not available here.', 'error');
        }
    };
    const exportCsv = () => {
        const blob = new Blob(['﻿' + contractsCsv(shown, now, devicesById)], { type: 'text/csv;charset=utf-8' });
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `contracts_${tab === 'Trash' ? 'trash' : tab === 'Software Licenses' ? 'licenses' : 'warranties'}_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    };

    if (loading) return <div className="hw-empty-row">Loading contracts...</div>;

    const isTrash = tab === 'Trash';
    return (
        <div className="hw-page">
            <div className="hw-header">
                <div>
                    <h1 className="page-title">Contracts &amp; Warranties</h1>
                    <div className="ct-subtitle">{counts['Hardware Warranties']} warranties · {counts['Software Licenses']} licenses · {covered} device(s) covered</div>
                </div>
                <div className="hw-actions">
                    <div className="hw-seg" role="group" aria-label="View">
                        {[['table', 'Table', TbTable], ['cards', 'Cards', TbLayoutGrid]].map(([mode, text, icon]) => {
                            const Icon = icon;
                            return <button key={mode} type="button" className={view === mode ? 'is-active' : ''} onClick={() => changeView(mode)} aria-pressed={view === mode}><Icon size={15} aria-hidden="true" />{text}</button>;
                        })}
                    </div>
                    <button type="button" className="btn btn-outline hw-btn" onClick={exportCsv} disabled={!shown.length}><TbFileExport size={16} aria-hidden="true" /> Export CSV</button>
                    {canWrite && <button type="button" className="btn btn-primary hw-btn" onClick={openNew}><TbPlus size={16} aria-hidden="true" /> Add contract</button>}
                </div>
            </div>

            {loadError && <div className="ct-error" role="alert">{loadError}</div>}

            <div className="hw-seg" role="tablist" aria-label="Contract type" style={{ alignSelf: 'flex-start' }}>
                {TABS.map(([key, text, icon]) => {
                    const Icon = icon;
                    return (
                        <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'is-active' : ''} onClick={() => changeTab(key)}>
                            <Icon size={15} aria-hidden="true" />{text}<span className="ct-tab-count">{counts[key]}</span>
                        </button>
                    );
                })}
            </div>

            {!isTrash && (
                <div className="hw-kpis">
                    <Kpi label="Active" value={kpis.Active} tone={CONTRACT_STATUS_META.Active.tone} icon={TbShieldCheck} active={status === 'Active'} onClick={() => toggleStatus('Active')} />
                    <Kpi label="Expiring within 60 days" value={kpis.Expiring} tone={CONTRACT_STATUS_META.Expiring.tone} icon={TbHourglassHigh} active={status === 'Expiring'} onClick={() => toggleStatus('Expiring')} />
                    <Kpi label="Expired" value={kpis.Expired} tone={CONTRACT_STATUS_META.Expired.tone} icon={TbShieldX} alert={kpis.Expired > 0} active={status === 'Expired'} onClick={() => toggleStatus('Expired')} />
                    <Kpi label="Renewals due in 90 days" value={kpis.renewalCount} sub={moneyText(kpis.renewalDue)} tone="var(--accent-primary)" icon={TbCalendarDue} />
                    <Kpi label="Spend of running terms" value={kpis.spend.length ? formatMoney(kpis.spend[0].total, kpis.spend[0].currency) : '-'} sub={kpis.spend.length > 1 ? moneyText(kpis.spend.slice(1)) : 'Per currency, never converted'} tone="var(--text-secondary)" icon={TbReceipt2} />
                </div>
            )}

            <div className="glass-panel hw-filters ct-filters">
                <div className="hw-search">
                    <TbSearch size={15} aria-hidden="true" />
                    <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, vendor, serial, key, device..." aria-label="Search contracts" />
                </div>
                {!isTrash && (
                    <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
                        <option value="ALL">All statuses</option>
                        {STATUSES.map(s => <option key={s} value={s}>{CONTRACT_STATUS_META[s].label}</option>)}
                    </select>
                )}
                <select value={vendor} onChange={e => setVendor(e.target.value)} aria-label="Vendor">
                    <option value="ALL">All vendors</option>
                    {vendors.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
                {!isTrash && (
                    <select value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort">
                        {Object.entries(SORTS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select>
                )}
                <span className="hw-count">{shown.length} of {tabContracts.length}</span>
            </div>

            {!shown.length ? (
                <div className="glass-panel hw-empty-row">
                    {tabContracts.length ? 'No contract matches the filters.' : isTrash ? 'The trash is empty.' : `No ${tab.toLowerCase()} yet.${canWrite ? ' Use "Add contract" to create one.' : ''}`}
                </div>
            ) : view === 'cards' ? (
                <div className="ct-cards">
                    {shown.map(c => {
                        const tone = c.deletedAt ? 'var(--text-muted)' : CONTRACT_STATUS_META[contractStatus(c, now)].tone;
                        const open = relatedIssues(c, issues).filter(i => i.status !== 'Closed').length;
                        const seats = seatUsage(c);
                        return (
                            <button key={c.id} type="button" className="glass-panel ct-card" style={{ '--hw-tone': tone }} onClick={() => setSelectedId(c.id)}>
                                <div className="ct-card-head">
                                    <div>
                                        <div className="ct-card-title">{c.name}</div>
                                        <div className="hw-muted hw-small">{c.vendor}{c.serialNumber ? ` · SN ${c.serialNumber}` : ''}</div>
                                    </div>
                                    <ContractStatusBadge contract={c} now={now} />
                                </div>
                                <TermBar contract={c} now={now} />
                                <div className="ct-card-foot">
                                    {c.deletedAt ? <span>In trash since {formatNoteTime(c.deletedAt)}</span> : <DaysChip contract={c} now={now} />}
                                    <span className="ct-icons">
                                        {seats && <span title="Seats used">{seats.used}/{seats.total}</span>}
                                        <span title="Linked devices"><TbServer2 size={14} aria-hidden="true" /> {(c.linkedDevices || []).length}</span>
                                        {open > 0 && <span className="is-alert" title="Open hardware issues"><TbAlertTriangle size={14} aria-hidden="true" /> {open}</span>}
                                        {c.savedFileName && <TbFileText size={14} aria-label="Has a file" />}
                                    </span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            ) : (
                <div className="hw-table-wrap">
                    <table className="hw-table">
                        <thead>
                            <tr>
                                <th>Name</th>
                                <th>Vendor</th>
                                <th>Term</th>
                                <th>{isTrash ? 'In trash since' : 'Remaining'}</th>
                                <th>Cost</th>
                                <th>Devices</th>
                                <th>Status</th>
                                {isTrash && canWrite && <th aria-label="Actions" />}
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map(c => {
                                const st = c.deletedAt ? '' : contractStatus(c, now);
                                const open = relatedIssues(c, issues).filter(i => i.status !== 'Closed').length;
                                const seats = seatUsage(c);
                                return (
                                    <tr key={c.id} className={`ct-row is-${st.toLowerCase()}`} onClick={() => setSelectedId(c.id)}>
                                        <td>
                                            <div className="ct-name">
                                                <button type="button" className="hw-link" onClick={(e) => { e.stopPropagation(); setSelectedId(c.id); }}>{c.name}</button>
                                                <span className="hw-muted hw-small">
                                                    {c.type === 'Hardware Warranties' ? (c.serialNumber ? `SN ${c.serialNumber}` : '') : seats ? `${seats.used} / ${seats.total} seats${seats.over ? ' · over' : ''}` : ''}
                                                </span>
                                            </div>
                                        </td>
                                        <td>{c.vendor}</td>
                                        <td><TermBar contract={c} now={now} /></td>
                                        <td className="hw-nowrap">{c.deletedAt ? <span className="hw-muted hw-small">{formatNoteTime(c.deletedAt)}{c.deletedBy ? ` · ${c.deletedBy}` : ''}</span> : <DaysChip contract={c} now={now} />}</td>
                                        <td className="hw-nowrap">{c.cost !== '' && c.cost !== null && c.cost !== undefined ? formatMoney(c.cost, c.currency) : <span className="hw-muted">-</span>}</td>
                                        <td>
                                            <span className="ct-icons">
                                                <span title="Linked devices"><TbServer2 size={14} aria-hidden="true" /> {(c.linkedDevices || []).length}</span>
                                                {open > 0 && <span className="is-alert" title="Open hardware issues"><TbAlertTriangle size={14} aria-hidden="true" /> {open}</span>}
                                                {c.savedFileName && <TbFileText size={14} aria-label="Has a file" />}
                                            </span>
                                        </td>
                                        <td><ContractStatusBadge contract={c} now={now} /></td>
                                        {isTrash && canWrite && (
                                            <td className="hw-nowrap">
                                                <button type="button" className="btn btn-outline hw-btn hw-btn-sm" onClick={(e) => { e.stopPropagation(); restore(c); }}><TbRestore size={14} aria-hidden="true" /> Restore</button>
                                            </td>
                                        )}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {selected && (
                <ContractDrawer
                    contract={selected} contracts={contracts} devicesById={devicesById} issues={issues} now={now}
                    canWrite={canWrite} isSuperAdmin={isSuperAdmin}
                    onClose={() => setSelectedId(null)} onEdit={openEdit} onRenew={openRenew} onTrash={trash} onRestore={restore}
                    onForceDelete={forceDelete} onDownload={download} onSelect={setSelectedId} onCopy={copy}
                    onShowInRack={onShowInRack}
                />
            )}
            {formState && (
                <ContractForm
                    draft={formState.draft} stored={formState.stored} renewing={formState.renewing} devices={devices}
                    onCancel={() => setFormState(null)} onSaved={saved} onConflict={conflict}
                />
            )}
        </div>
    );
};

export default ContractsWarranties;
