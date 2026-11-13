import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    TbPlus, TbSearch, TbFileExport, TbShoppingCart, TbBooks, TbPackage, TbStack2, TbAlertTriangle, TbCircleX, TbCash,
    TbPackageExport, TbPackageImport, TbPencil, TbTrash, TbCheck, TbX, TbMapPin, TbCategory,
} from 'react-icons/tb';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { DEFAULT_CATEGORIES } from './sparePartCatalog';
import {
    SORTS, spareKpis, moneyText, filterSpares, sortSpares, valuesOf, categoryCounts, stockStatus, suggestedOrder,
    emptySpare, spareEditDraft, sparesCsv, reorderCsv,
} from './sparePartUtils';
import { SPARE_STATUS_META, categoryIcon } from './spareTheme';
import SparePartForm from './SparePartForm';
import SpareCatalogPicker from './SpareCatalogPicker';
import SpareStockModal from './SpareStockModal';
import SpareDrawer, { SpareStatusBadge } from './SpareDrawer';
import './hwIssues.css';
import './contracts.css';
import './spareParts.css';

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

function download(text, name) {
    const url = window.URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

export default function SpareParts() {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const role = useMemo(() => {
        try { return JSON.parse(localStorage.getItem('user') || '{}').role || 'Viewer'; } catch { return 'Viewer'; }
    }, []);
    const canWrite = role === 'SuperAdmin' || role === 'Operator';
    const isSuperAdmin = role === 'SuperAdmin';

    const [data, setData] = useState({ categories: [], items: [] });
    const [issues, setIssues] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [now, setNow] = useState(() => Date.now());
    const [reloadKey, setReloadKey] = useState(0);
    const reload = useCallback(() => setReloadKey(k => k + 1), []);

    const [category, setCategory] = useState('ALL');
    const [q, setQ] = useState('');
    const [status, setStatus] = useState('ALL');
    const [vendor, setVendor] = useState('ALL');
    const [location, setLocation] = useState('ALL');
    const [sort, setSort] = useState('restock');
    const [selectedId, setSelectedId] = useState(null);
    const [formDraft, setFormDraft] = useState(null);
    const [picker, setPicker] = useState(false);
    const [stock, setStock] = useState(null); // { item, mode }
    const [newCat, setNewCat] = useState('');
    const [renaming, setRenaming] = useState(null); // { from, to }

    useEffect(() => {
        let alive = true;
        Promise.all([
            api.get('/rack/spare-parts'),
            api.get('/rack/issues').catch(() => ({ data: [] })),
        ]).then(([sp, iss]) => {
            if (!alive) return;
            setData({ categories: sp.data?.categories || [], items: sp.data?.items || [] });
            setIssues(Array.isArray(iss.data) ? iss.data : []);
            setLoadError('');
            setNow(Date.now());
        }).catch(err => {
            if (alive) setLoadError(err.response?.data?.error || 'Failed to load the spare parts.');
        }).finally(() => {
            if (alive) setLoading(false);
        });
        return () => { alive = false; };
    }, [reloadKey]);

    const items = data.items;
    const kpis = useMemo(() => spareKpis(items, now), [items, now]);
    const cats = useMemo(() => categoryCounts(data.categories, items), [data.categories, items]);
    const vendors = useMemo(() => valuesOf(items, 'vendor'), [items]);
    const locations = useMemo(() => valuesOf(items, 'location'), [items]);
    const suppliers = useMemo(() => valuesOf(items, 'supplier'), [items]);
    const shown = useMemo(() => sortSpares(filterSpares(items, { category, q, status, vendor, location }), sort), [items, category, q, status, vendor, location, sort]);
    const selected = selectedId ? items.find(i => i.id === selectedId) : null;
    const missingDefaults = DEFAULT_CATEGORIES.filter(c => !data.categories.includes(c));
    const toggleStatus = (s) => setStatus(prev => (prev === s ? 'ALL' : s));

    // ---- categories ----
    const saveCategories = async (categories, okText) => {
        try {
            await api.put('/rack/spare-parts/categories', { categories });
            if (okText) showToast(okText, 'success');
            reload();
        } catch (err) {
            showToast(err.response?.data?.error || 'Failed to save the categories.', 'error');
        }
    };
    const addCategory = () => {
        const v = newCat.trim();
        if (!v) return;
        if (data.categories.includes(v)) { showToast('That category already exists.', 'error'); return; }
        setNewCat('');
        saveCategories([...data.categories, v], `Category "${v}" added`);
    };
    const removeCategory = async (c) => {
        if (c.parts) { showToast(`"${c.name}" still has ${c.parts} part(s); move or delete them first.`, 'error'); return; }
        if (!await showConfirm(`Delete the category "${c.name}"?`)) return;
        if (category === c.name) setCategory('ALL');
        saveCategories(data.categories.filter(x => x !== c.name), 'Category deleted');
    };
    const rename = async () => {
        const to = renaming.to.trim();
        if (!to || to === renaming.from) { setRenaming(null); return; }
        try {
            const res = await api.post('/rack/spare-parts/categories/rename', { from: renaming.from, to });
            showToast(`Renamed; ${res.data.moved} part(s) moved`, 'success');
            if (category === renaming.from) setCategory(to);
            setRenaming(null);
            reload();
        } catch (err) {
            showToast(err.response?.data?.error || 'Rename failed.', 'error');
        }
    };
    const addDefaults = () => saveCategories([...data.categories, ...missingDefaults], `${missingDefaults.length} categories added`);

    // ---- parts ----
    const openNew = () => setFormDraft(emptySpare(category !== 'ALL' ? category : data.categories[0] || ''));
    const saved = (item) => {
        setFormDraft(null);
        showToast('Part saved', 'success');
        setSelectedId(item.id);
        reload();
    };
    const conflict = (current) => setData(prev => ({ ...prev, items: prev.items.map(i => (i.id === current.id ? current : i)) }));
    const stockSaved = (item, mode) => {
        setStock(null);
        showToast(mode === 'COUNT' ? 'Count recorded' : mode === 'IN' ? 'Stock added' : 'Stock booked out', 'success');
        setData(prev => ({ ...prev, items: prev.items.map(i => (i.id === item.id ? item : i)) }));
        reload();
    };
    const remove = async (item) => {
        const text = item.quantity > 0
            ? `Delete "${item.name}" with ${item.quantity} still in stock? Its history is deleted too; hardware issues keep the part name.`
            : `Delete "${item.name}"? Its history is deleted too; hardware issues keep the part name.`;
        if (!await showConfirm(text)) return;
        try {
            await api.delete(`/rack/spare-parts/${encodeURIComponent(item.id)}`);
            showToast('Part deleted', 'success');
            setSelectedId(null);
            reload();
        } catch (err) {
            showToast(err.response?.data?.error || 'Delete failed.', 'error');
        }
    };
    const added = (list) => {
        setPicker(false);
        showToast(`${list.length} part(s) added`, 'success');
        reload();
    };

    if (loading) return <div className="hw-empty-row">Loading spare parts...</div>;

    const stamp = new Date().toISOString().slice(0, 10);
    return (
        <div className="hw-page">
            <div className="hw-header">
                <div>
                    <h1 className="page-title">Spare Parts Inventory</h1>
                    <div className="ct-subtitle">{kpis.parts} part types · {kpis.units} units · {data.categories.length} categories</div>
                </div>
                <div className="hw-actions">
                    <button type="button" className="btn btn-outline hw-btn" onClick={() => download(reorderCsv(items), `spare_parts_reorder_${stamp}.csv`)} disabled={!kpis.restock} title="Parts at or below their minimum, with the quantity to order">
                        <TbShoppingCart size={16} aria-hidden="true" /> Reorder list ({kpis.restock})
                    </button>
                    <button type="button" className="btn btn-outline hw-btn" onClick={() => download(sparesCsv(shown, now), `spare_parts_${stamp}.csv`)} disabled={!shown.length}>
                        <TbFileExport size={16} aria-hidden="true" /> Export CSV
                    </button>
                    {canWrite && <button type="button" className="btn btn-outline hw-btn" onClick={() => setPicker(true)}><TbBooks size={16} aria-hidden="true" /> Add from catalog</button>}
                    {canWrite && <button type="button" className="btn btn-primary hw-btn" onClick={openNew}><TbPlus size={16} aria-hidden="true" /> New part</button>}
                </div>
            </div>

            {loadError && <div className="ct-error" role="alert">{loadError}</div>}

            <div className="hw-kpis">
                <Kpi label="Part types" value={kpis.parts} sub={`${kpis.units} units in stock`} tone="var(--accent-primary)" icon={TbPackage} />
                <Kpi label="Low stock" value={kpis.low} sub="At or below the minimum" tone={SPARE_STATUS_META.Low.tone} icon={TbAlertTriangle} active={status === 'Low'} onClick={() => toggleStatus('Low')} />
                <Kpi label="Out of stock" value={kpis.out} tone={SPARE_STATUS_META.Out.tone} icon={TbCircleX} alert={kpis.out > 0} active={status === 'Out'} onClick={() => toggleStatus('Out')} />
                <Kpi label="To reorder" value={kpis.restock} sub="Minimum set and reached" tone="var(--warning)" icon={TbShoppingCart} active={status === 'RESTOCK'} onClick={() => toggleStatus('RESTOCK')} />
                <Kpi label="Stock value" value={kpis.value.length ? `${kpis.value[0].currency} ${kpis.value[0].total.toLocaleString()}` : '-'} sub={kpis.value.length > 1 ? moneyText(kpis.value.slice(1)) : 'Per currency, never converted'} tone="var(--success)" icon={TbCash} />
                <Kpi label="Used, last 30 days" value={kpis.used30} sub="Units booked out" tone="var(--text-secondary)" icon={TbPackageExport} />
            </div>

            <div className="sp-body">
                <aside className="glass-panel sp-side" aria-label="Categories">
                    <div className="sp-side-title"><span><TbCategory size={13} aria-hidden="true" /> Categories</span></div>
                    <div className="sp-cats custom-scrollbar">
                        <button type="button" className={`sp-cat${category === 'ALL' ? ' is-active' : ''}`} onClick={() => setCategory('ALL')}>
                            <TbStack2 size={15} aria-hidden="true" /><span className="sp-cat-name">All parts</span><span className="sp-cat-count">{items.length}</span>
                        </button>
                        {cats.map(c => {
                            const Icon = categoryIcon(c.name);
                            if (renaming && renaming.from === c.name) {
                                return (
                                    <div key={c.name} className="sp-cat-row">
                                        <input value={renaming.to} onChange={e => setRenaming({ ...renaming, to: e.target.value })} aria-label={`New name for ${c.name}`} autoFocus
                                            onKeyDown={e => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setRenaming(null); }} style={{ flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, fontSize: 12 }} />
                                        <button type="button" className="hw-icon-btn" onClick={rename} aria-label="Save name"><TbCheck size={14} /></button>
                                        <button type="button" className="hw-icon-btn" onClick={() => setRenaming(null)} aria-label="Cancel rename"><TbX size={14} /></button>
                                    </div>
                                );
                            }
                            return (
                                <div key={c.name} className="sp-cat-row">
                                    <button type="button" className={`sp-cat${category === c.name ? ' is-active' : ''}${c.unlisted ? ' sp-cat-unlisted' : ''}`} onClick={() => setCategory(c.name)} title={c.unlisted ? 'Used by parts but not in the category list' : undefined}>
                                        <Icon size={15} aria-hidden="true" /><span className="sp-cat-name">{c.name}</span>
                                        {c.alerts > 0 && <span className="sp-cat-alert" title={`${c.alerts} to reorder`}><TbAlertTriangle size={13} aria-label={`${c.alerts} to reorder`} /></span>}
                                        <span className="sp-cat-count">{c.parts}</span>
                                    </button>
                                    {canWrite && !c.unlisted && (
                                        <span className="sp-cat-tools">
                                            <button type="button" className="hw-icon-btn" onClick={() => setRenaming({ from: c.name, to: c.name })} aria-label={`Rename ${c.name}`}><TbPencil size={13} /></button>
                                            <button type="button" className="hw-icon-btn" onClick={() => removeCategory(c)} aria-label={`Delete ${c.name}`}><TbTrash size={13} /></button>
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    {canWrite && (
                        <>
                            <div className="sp-side-add">
                                <input value={newCat} onChange={e => setNewCat(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addCategory(); }} placeholder="New category" maxLength={100} aria-label="New category" />
                                <button type="button" className="btn btn-outline hw-btn hw-btn-sm" onClick={addCategory} disabled={!newCat.trim()} aria-label="Add category"><TbPlus size={14} /></button>
                            </div>
                            {missingDefaults.length > 0 && (
                                <button type="button" className="hw-link hw-small" style={{ marginTop: 8 }} onClick={addDefaults}>Add {missingDefaults.length} standard categories</button>
                            )}
                        </>
                    )}
                </aside>

                <div className="sp-main">
                    <div className="glass-panel hw-filters ct-filters">
                        <div className="hw-search">
                            <TbSearch size={15} aria-hidden="true" />
                            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, part number, spec, model, location, serial..." aria-label="Search spare parts" />
                        </div>
                        <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Stock status">
                            <option value="ALL">All stock levels</option>
                            <option value="RESTOCK">To reorder</option>
                            <option value="Low">Low</option>
                            <option value="Out">Out of stock</option>
                            <option value="OK">In stock</option>
                        </select>
                        <select value={vendor} onChange={e => setVendor(e.target.value)} aria-label="Brand">
                            <option value="ALL">All brands</option>
                            {vendors.map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                        <select value={location} onChange={e => setLocation(e.target.value)} aria-label="Location">
                            <option value="ALL">All locations</option>
                            {locations.map(v => <option key={v} value={v}>{v}</option>)}
                        </select>
                        <select value={sort} onChange={e => setSort(e.target.value)} aria-label="Sort">
                            {Object.entries(SORTS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                        </select>
                        <span className="hw-count">{shown.length} of {items.length}</span>
                    </div>

                    {!shown.length ? (
                        <div className="glass-panel hw-empty-row">
                            {items.length ? 'No part matches the filters.' : <>No spare parts yet.{canWrite && <> Use <strong>Add from catalog</strong> to pick common parts, or <strong>New part</strong>.</>}</>}
                        </div>
                    ) : (
                        <div className="hw-table-wrap custom-scrollbar">
                            <table className="hw-table">
                                <thead>
                                    <tr>
                                        <th>Part</th>
                                        <th>Brand / P/N</th>
                                        <th>Location</th>
                                        <th>Stock</th>
                                        <th>Value</th>
                                        <th>Status</th>
                                        {canWrite && <th aria-label="Actions" />}
                                    </tr>
                                </thead>
                                <tbody>
                                    {shown.map(item => {
                                        const st = stockStatus(item);
                                        const tone = SPARE_STATUS_META[st].tone;
                                        const order = suggestedOrder(item);
                                        const min = Number(item.minStock) || 0;
                                        const pct = min > 0 ? Math.min(100, Math.round((item.quantity / (min * 2)) * 100)) : (item.quantity > 0 ? 100 : 0);
                                        const value = (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0);
                                        const Icon = categoryIcon(item.category);
                                        return (
                                            <tr key={item.id} className={`ct-row${st === 'Out' ? ' is-expired' : st === 'Low' ? ' is-expiring' : ''}`} onClick={() => setSelectedId(item.id)}>
                                                <td>
                                                    <div className="ct-name">
                                                        <button type="button" className="hw-link" onClick={(e) => { e.stopPropagation(); setSelectedId(item.id); }}>{item.name}</button>
                                                        <span className="hw-muted hw-small"><Icon size={11} aria-hidden="true" /> {item.category}{item.spec ? ` · ${item.spec.length > 60 ? `${item.spec.slice(0, 60)}...` : item.spec}` : ''}</span>
                                                    </div>
                                                </td>
                                                <td>
                                                    <div>{item.vendor || <span className="hw-muted">-</span>}</div>
                                                    {item.partNumber && <div className="hw-small ct-mono hw-muted">{item.partNumber}</div>}
                                                </td>
                                                <td className="hw-small">{item.location ? <><TbMapPin size={12} aria-hidden="true" /> {item.location}</> : <span className="hw-muted">Unassigned</span>}</td>
                                                <td>
                                                    <div className="sp-qty" style={{ '--hw-tone': tone }}>
                                                        <div className="sp-qty-line">
                                                            <span className="sp-qty-num">{item.quantity}</span>
                                                            <span className="sp-qty-min">{min ? `min ${min}` : 'no minimum'}</span>
                                                            {order > 0 && <span className="sp-chip sp-order" title="Suggested order quantity">order {order}</span>}
                                                        </div>
                                                        <div className="ct-bar"><span style={{ width: `${pct}%` }} /></div>
                                                    </div>
                                                </td>
                                                <td className="hw-nowrap">{value ? `${item.currency || 'TWD'} ${value.toLocaleString()}` : <span className="hw-muted">-</span>}</td>
                                                <td><SpareStatusBadge item={item} /></td>
                                                {canWrite && (
                                                    <td className="hw-nowrap">
                                                        <span className="sp-actions">
                                                            <button type="button" className="btn btn-outline hw-btn hw-btn-sm sp-in" onClick={(e) => { e.stopPropagation(); setStock({ item, mode: 'IN' }); }} aria-label={`Stock in ${item.name}`}><TbPackageImport size={14} aria-hidden="true" /> In</button>
                                                            <button type="button" className="btn btn-outline hw-btn hw-btn-sm sp-out" onClick={(e) => { e.stopPropagation(); setStock({ item, mode: 'OUT' }); }} disabled={!item.quantity} aria-label={`Stock out ${item.name}`}><TbPackageExport size={14} aria-hidden="true" /> Out</button>
                                                        </span>
                                                    </td>
                                                )}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {selected && (
                <SpareDrawer
                    item={selected} issues={issues} now={now} canWrite={canWrite} isSuperAdmin={isSuperAdmin}
                    onClose={() => setSelectedId(null)} onEdit={(i) => setFormDraft(spareEditDraft(i))} onDelete={remove}
                    onStock={(i, mode) => setStock({ item: i, mode })}
                />
            )}
            {formDraft && (
                <SparePartForm
                    draft={formDraft} categories={data.categories} locations={locations} suppliers={suppliers}
                    onCancel={() => setFormDraft(null)} onSaved={saved} onConflict={conflict}
                />
            )}
            {picker && <SpareCatalogPicker items={items} initialCategory={category} onCancel={() => setPicker(false)} onAdded={added} />}
            {stock && <SpareStockModal item={stock.item} mode={stock.mode} issues={issues} onCancel={() => setStock(null)} onSaved={stockSaved} />}
        </div>
    );
}
