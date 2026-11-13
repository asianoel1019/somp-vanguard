import React, { useMemo, useState } from 'react';
import { TbX, TbSearch, TbBooks } from 'react-icons/tb';
import api from '../../api';
import { VENDORS, searchCatalog } from './sparePartCatalog';
import { CONDITIONS, CURRENCIES, spareBody, spareFormProblem } from './sparePartUtils';
import './hwIssues.css';
import './contracts.css';
import './spareParts.css';

// Create / edit one part. A new part can be filled from the catalog. draft: emptySpare() / spareEditDraft().
// onSaved(item); onConflict(currentItem) when someone else changed it meanwhile.
export default function SparePartForm({ draft, categories, locations, suppliers, onCancel, onSaved, onConflict }) {
    const [form, setForm] = useState(draft);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [catalogQ, setCatalogQ] = useState('');
    const isNew = !form.id;
    const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));
    const suggestions = useMemo(() => (catalogQ.trim() ? searchCatalog('ALL', catalogQ).slice(0, 8) : []), [catalogQ]);
    const categoryOptions = useMemo(() => (form.category && !categories.includes(form.category) ? [...categories, form.category] : categories), [categories, form.category]);

    const fill = (e) => {
        setForm(prev => ({ ...prev, category: e.category, name: e.name, spec: e.spec, minStock: e.minStock }));
        setCatalogQ('');
    };

    const submit = async (ev) => {
        ev.preventDefault();
        const problem = spareFormProblem(form);
        if (problem) { setError(problem); return; }
        setSaving(true);
        setError('');
        try {
            const body = spareBody(form, { create: isNew });
            const res = isNew
                ? await api.post('/rack/spare-parts/items', body)
                : await api.patch(`/rack/spare-parts/${encodeURIComponent(form.id)}`, body);
            onSaved(res.data.item);
        } catch (err) {
            setSaving(false);
            if (err.response?.status === 409 && err.response.data?.item) {
                setError(err.response.data.error);
                onConflict(err.response.data.item);
                return;
            }
            setError(err.response?.data?.error || 'Failed to save the part.');
        }
    };

    const title = isNew ? 'New spare part' : `Edit: ${draft.name}`;
    return (
        <div className="hw-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !saving) onCancel(); }}>
            <form className="glass-panel ct-form" onSubmit={submit} role="dialog" aria-modal="true" aria-label={title} noValidate>
                <div className="ct-form-head">
                    <h3>{title}</h3>
                    <button type="button" className="hw-icon-btn" onClick={onCancel} disabled={saving} aria-label="Close"><TbX size={18} /></button>
                </div>
                <div className="ct-form-body custom-scrollbar">
                    {isNew && (
                        <div className="hw-field hw-section">
                            <label htmlFor="sp-cat-search"><TbBooks size={13} aria-hidden="true" /> Fill from the catalog</label>
                            <div className="hw-search">
                                <TbSearch size={15} aria-hidden="true" />
                                <input id="sp-cat-search" value={catalogQ} onChange={e => setCatalogQ(e.target.value)} placeholder="Type e.g. 32gb ddr4, sfp+ sr, 2.4tb sas, 800w" autoComplete="off" />
                            </div>
                            {suggestions.length > 0 && (
                                <div className="ct-list" style={{ marginTop: 6 }}>
                                    {suggestions.map(e => (
                                        <button key={e.key} type="button" className="ct-list-item" onClick={() => fill(e)} style={{ cursor: 'pointer', textAlign: 'left' }}>
                                            <span><strong>{e.name}</strong> <span className="hw-muted hw-small">{e.category} · {e.spec}</span></span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    <div className="hw-grid">
                        <div className="hw-field">
                            <label htmlFor="sp-category">Category *</label>
                            <select id="sp-category" value={form.category} onChange={e => set('category', e.target.value)}>
                                <option value="">Choose...</option>
                                {categoryOptions.map(c => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </div>
                        <div className="hw-field">
                            <label htmlFor="sp-name">Name *</label>
                            <input id="sp-name" value={form.name} onChange={e => set('name', e.target.value)} maxLength={200} placeholder="e.g. 32GB DDR4-3200 RDIMM" />
                        </div>
                    </div>
                    <div className="hw-grid">
                        <div className="hw-grid" style={{ marginBottom: 0 }}>
                            <div className="hw-field">
                                <label htmlFor="sp-vendor">Brand</label>
                                <input id="sp-vendor" list="sp-form-vendors" value={form.vendor} onChange={e => set('vendor', e.target.value)} maxLength={100} />
                                <datalist id="sp-form-vendors">{VENDORS.map(v => <option key={v} value={v} />)}</datalist>
                            </div>
                            <div className="hw-field">
                                <label htmlFor="sp-cond">Condition</label>
                                <select id="sp-cond" value={form.condition || 'New'} onChange={e => set('condition', e.target.value)}>{CONDITIONS.map(c => <option key={c}>{c}</option>)}</select>
                            </div>
                        </div>
                        <div className="hw-grid" style={{ marginBottom: 0 }}>
                            <div className="hw-field">
                                <label htmlFor="sp-pn">Part number / FRU</label>
                                <input id="sp-pn" className="ct-mono" value={form.partNumber} onChange={e => set('partNumber', e.target.value)} maxLength={100} />
                            </div>
                            <div className="hw-field">
                                <label htmlFor="sp-model">Model</label>
                                <input id="sp-model" value={form.model} onChange={e => set('model', e.target.value)} maxLength={200} />
                            </div>
                        </div>
                    </div>
                    <div className="hw-field hw-section">
                        <label htmlFor="sp-spec">Specification</label>
                        <textarea id="sp-spec" rows={2} value={form.spec} onChange={e => set('spec', e.target.value)} maxLength={1000} />
                    </div>
                    <div className="hw-field hw-section">
                        <label htmlFor="sp-compat">Compatible with</label>
                        <input id="sp-compat" value={form.compatibleWith} onChange={e => set('compatibleWith', e.target.value)} maxLength={1000} placeholder="Server / switch models, e.g. PowerEdge R650, R750; ProLiant DL380 Gen10" />
                    </div>
                    <div className="hw-grid">
                        <div className="hw-field">
                            <label htmlFor="sp-loc">Location / bin</label>
                            <input id="sp-loc" list="sp-locations" value={form.location} onChange={e => set('location', e.target.value)} maxLength={200} placeholder="e.g. Cage A / Shelf 2 / Bin 4" />
                            <datalist id="sp-locations">{locations.map(v => <option key={v} value={v} />)}</datalist>
                        </div>
                        <div className="hw-field">
                            <label htmlFor="sp-supplier">Supplier</label>
                            <input id="sp-supplier" list="sp-suppliers" value={form.supplier} onChange={e => set('supplier', e.target.value)} maxLength={200} />
                            <datalist id="sp-suppliers">{suppliers.map(v => <option key={v} value={v} />)}</datalist>
                        </div>
                    </div>
                    <div className="hw-grid">
                        <div className="hw-grid" style={{ marginBottom: 0 }}>
                            <div className="hw-field">
                                <label htmlFor="sp-min">Minimum stock</label>
                                <input id="sp-min" type="number" min="0" step="1" value={form.minStock} onChange={e => set('minStock', e.target.value)} />
                            </div>
                            <div className="hw-field">
                                <label htmlFor="sp-reorder">Reorder qty</label>
                                <input id="sp-reorder" type="number" min="0" step="1" value={form.reorderQty} onChange={e => set('reorderQty', e.target.value)} placeholder="Auto" />
                            </div>
                        </div>
                        <div className="hw-grid" style={{ marginBottom: 0, gridTemplateColumns: '2fr 1fr' }}>
                            <div className="hw-field">
                                <label htmlFor="sp-price">Unit price</label>
                                <input id="sp-price" type="number" min="0" step="any" value={form.unitPrice} onChange={e => set('unitPrice', e.target.value)} />
                            </div>
                            <div className="hw-field">
                                <label htmlFor="sp-cur">Currency</label>
                                <select id="sp-cur" value={form.currency || 'TWD'} onChange={e => set('currency', e.target.value)}>{CURRENCIES.map(c => <option key={c}>{c}</option>)}</select>
                            </div>
                        </div>
                    </div>
                    <div className="hw-field-help hw-section">Low stock = at or below the minimum. Reorder qty empty: order back up to twice the minimum.</div>
                    {isNew && (
                        <div className="hw-grid">
                            <div className="hw-field">
                                <label htmlFor="sp-qty">Opening quantity</label>
                                <input id="sp-qty" type="number" min="0" step="1" value={form.quantity} onChange={e => set('quantity', e.target.value)} />
                            </div>
                            <div className="hw-field">
                                <label htmlFor="sp-serials">Serial numbers (optional)</label>
                                <textarea id="sp-serials" className="ct-mono" rows={2} value={form.serialsText} onChange={e => set('serialsText', e.target.value)} placeholder="One per line or comma separated" />
                            </div>
                        </div>
                    )}
                    {!isNew && <div className="hw-field-help hw-section">Quantity and serial numbers change through Stock in / out and Stock count.</div>}
                    <div className="hw-field">
                        <label htmlFor="sp-notes">Notes</label>
                        <textarea id="sp-notes" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} maxLength={2000} />
                    </div>
                </div>
                <div className="ct-form-foot">
                    <div>{error && <div className="ct-error" role="alert">{error}</div>}</div>
                    <div>
                        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : 'Save part'}</button>
                    </div>
                </div>
            </form>
        </div>
    );
}
