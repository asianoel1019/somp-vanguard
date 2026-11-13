import React, { useMemo, useState } from 'react';
import { TbX, TbSearch, TbBooks } from 'react-icons/tb';
import api from '../../api';
import { DEFAULT_CATEGORIES, VENDORS, catalogCounts, searchCatalog } from './sparePartCatalog';
import { CONDITIONS, CURRENCIES } from './sparePartUtils';
import { categoryIcon } from './spareTheme';
import './hwIssues.css';
import './contracts.css';
import './spareParts.css';

// Adds several catalog parts at once: tick the parts, set the opening quantity of each, and the brand / location /
// condition / currency they share. onAdded(items) after the save.
export default function SpareCatalogPicker({ items, initialCategory, onCancel, onAdded }) {
    const [cat, setCat] = useState(DEFAULT_CATEGORIES.includes(initialCategory) ? initialCategory : 'ALL');
    const [q, setQ] = useState('');
    const [picked, setPicked] = useState(() => new Map()); // key -> quantity
    const [shared, setShared] = useState({ vendor: '', location: '', condition: 'New', currency: 'TWD' });
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const counts = useMemo(() => catalogCounts(), []);
    const shown = useMemo(() => searchCatalog(cat, q), [cat, q]);
    const owned = useMemo(() => new Set((items || []).map(i => `${i.category}|${String(i.name || '').toLowerCase()}`)), [items]);
    const byKey = useMemo(() => new Map(searchCatalog('ALL', '').map(e => [e.key, e])), []);

    const toggle = (key) => setPicked(prev => {
        const next = new Map(prev);
        if (next.has(key)) next.delete(key); else next.set(key, 0);
        return next;
    });
    const setQty = (key, v) => setPicked(prev => new Map(prev).set(key, Math.max(0, parseInt(v, 10) || 0)));
    const setShare = (k, v) => setShared(prev => ({ ...prev, [k]: v }));

    const submit = async () => {
        if (!picked.size) return;
        setSaving(true);
        setError('');
        try {
            const body = [...picked.entries()].map(([key, quantity]) => {
                const e = byKey.get(key);
                return { name: e.name, category: e.category, spec: e.spec, minStock: e.minStock, quantity, ...shared };
            });
            const res = await api.post('/rack/spare-parts/items/bulk', { items: body });
            onAdded(res.data.items || []);
        } catch (err) {
            setSaving(false);
            setError(err.response?.data?.error || 'Failed to add the parts.');
        }
    };

    return (
        <div className="hw-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !saving) onCancel(); }}>
            <div className="glass-panel ct-form sp-picker" role="dialog" aria-modal="true" aria-label="Add from catalog">
                <div className="ct-form-head">
                    <h3><TbBooks size={18} aria-hidden="true" /> Add from catalog</h3>
                    <button type="button" className="hw-icon-btn" onClick={onCancel} disabled={saving} aria-label="Close"><TbX size={18} /></button>
                </div>
                <div className="sp-picker-body">
                    <div className="sp-picker-cats custom-scrollbar">
                        <button type="button" className={`sp-cat${cat === 'ALL' ? ' is-active' : ''}`} onClick={() => setCat('ALL')}>
                            <span className="sp-cat-name">All</span><span className="sp-cat-count">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
                        </button>
                        {DEFAULT_CATEGORIES.map(c => {
                            const Icon = categoryIcon(c);
                            return (
                                <button key={c} type="button" className={`sp-cat${cat === c ? ' is-active' : ''}`} onClick={() => setCat(c)}>
                                    <Icon size={15} aria-hidden="true" /><span className="sp-cat-name">{c}</span><span className="sp-cat-count">{counts[c] || 0}</span>
                                </button>
                            );
                        })}
                    </div>
                    <div className="sp-picker-main">
                        <div className="hw-search">
                            <TbSearch size={15} aria-hidden="true" />
                            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search e.g. ddr5 64gb, sfp28 sr, om4 3m, 1100w" aria-label="Search the catalog" autoFocus />
                        </div>
                        <div className="sp-picker-list custom-scrollbar">
                            {shown.map(e => {
                                const isOwned = owned.has(`${e.category}|${e.name.toLowerCase()}`);
                                const on = picked.has(e.key);
                                return (
                                    <div key={e.key} className={`sp-picker-item${isOwned ? ' is-owned' : ''}`}>
                                        <label className="sp-picker-label">
                                            <input type="checkbox" checked={on} onChange={() => toggle(e.key)} />
                                            <span>
                                                <span className="sp-picker-name">{e.name}</span>{isOwned && <span className="sp-chip sp-picker-owned">already in the list</span>}
                                                <span className="sp-picker-spec">{cat === 'ALL' ? `${e.category} · ` : ''}{e.spec} · suggested min {e.minStock}</span>
                                            </span>
                                        </label>
                                        {on && (
                                            <label className="sp-picker-qty">
                                                Qty
                                                <input type="number" min="0" value={picked.get(e.key)} onChange={ev => setQty(e.key, ev.target.value)} aria-label={`Opening quantity of ${e.name}`} />
                                            </label>
                                        )}
                                    </div>
                                );
                            })}
                            {!shown.length && <div className="hw-column-empty">No catalog part matches. Use "New part" to enter it yourself.</div>}
                        </div>
                        <div className="sp-picker-defaults">
                            <div className="hw-field">
                                <label htmlFor="sp-c-vendor">Brand (all picked)</label>
                                <input id="sp-c-vendor" list="sp-vendors" value={shared.vendor} onChange={e => setShare('vendor', e.target.value)} placeholder="e.g. Dell" />
                                <datalist id="sp-vendors">{VENDORS.map(v => <option key={v} value={v} />)}</datalist>
                            </div>
                            <div className="hw-field">
                                <label htmlFor="sp-c-loc">Location</label>
                                <input id="sp-c-loc" value={shared.location} onChange={e => setShare('location', e.target.value)} placeholder="e.g. Cage A / Bin 3" />
                            </div>
                            <div className="hw-field">
                                <label htmlFor="sp-c-cond">Condition</label>
                                <select id="sp-c-cond" value={shared.condition} onChange={e => setShare('condition', e.target.value)}>{CONDITIONS.map(c => <option key={c}>{c}</option>)}</select>
                            </div>
                            <div className="hw-field">
                                <label htmlFor="sp-c-cur">Currency</label>
                                <select id="sp-c-cur" value={shared.currency} onChange={e => setShare('currency', e.target.value)}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="ct-form-foot">
                    <div>{error ? <div className="ct-error" role="alert">{error}</div> : <span className="hw-muted hw-small">Part numbers, prices and serial numbers can be added per part afterwards.</span>}</div>
                    <div>
                        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>Cancel</button>
                        <button type="button" className="btn btn-primary" onClick={submit} disabled={saving || !picked.size}>{saving ? 'Adding...' : `Add ${picked.size} part(s)`}</button>
                    </div>
                </div>
            </div>
        </div>
    );
}
