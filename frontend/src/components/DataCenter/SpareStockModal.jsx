import React, { useMemo, useState } from 'react';
import { TbX, TbPackageImport, TbPackageExport, TbClipboardCheck } from 'react-icons/tb';
import api from '../../api';
import { IN_REASONS, OUT_REASONS, parseSerials } from './sparePartUtils';
import './hwIssues.css';
import './contracts.css';
import './spareParts.css';

const MODES = {
    IN: { title: 'Stock in', tone: 'var(--success)', icon: TbPackageImport },
    OUT: { title: 'Stock out', tone: 'var(--danger)', icon: TbPackageExport },
    COUNT: { title: 'Stock count', tone: 'var(--accent-primary)', icon: TbClipboardCheck },
};

// Stock in / out (with a reason, an optional hardware issue and optional serial numbers) or a stock count.
export default function SpareStockModal({ item, mode, issues, onCancel, onSaved }) {
    const meta = MODES[mode];
    const Icon = meta.icon;
    const [qty, setQty] = useState(1);
    const [actual, setActual] = useState(item.quantity);
    const [reason, setReason] = useState(mode === 'IN' ? 'Purchase' : 'Repair');
    const [issueId, setIssueId] = useState('');
    const [note, setNote] = useState('');
    const [serialText, setSerialText] = useState('');
    const [outSerials, setOutSerials] = useState([]);
    const [replaceSerials, setReplaceSerials] = useState(false);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const onHand = item.serials || [];
    const openIssues = useMemo(() => (issues || [])
        .filter(i => i && i.status !== 'Closed')
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))), [issues]);

    const n = parseInt(qty, 10) || 0;
    const after = mode === 'IN' ? item.quantity + n : mode === 'OUT' ? item.quantity - n : parseInt(actual, 10);
    const serials = mode === 'OUT' ? outSerials : parseSerials(serialText);

    const toggleSerial = (s) => setOutSerials(prev => (prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]));

    const problem = () => {
        if (mode === 'COUNT') {
            if (!Number.isInteger(Number(actual)) || Number(actual) < 0 || actual === '') return 'Enter the counted quantity.';
            if (replaceSerials && serials.length > Number(actual)) return `${serials.length} serial numbers for ${actual} part(s).`;
            return '';
        }
        if (n < 1) return 'Enter a quantity of 1 or more.';
        if (mode === 'OUT' && n > item.quantity) return `Only ${item.quantity} in stock.`;
        if (serials.length > n) return `${serials.length} serial numbers for ${n} part(s).`;
        return '';
    };

    const submit = async (ev) => {
        ev.preventDefault();
        const p = problem();
        if (p) { setError(p); return; }
        setSaving(true);
        setError('');
        try {
            const res = mode === 'COUNT'
                ? await api.post(`/rack/spare-parts/${encodeURIComponent(item.id)}/count`, { actual: Number(actual), note, ...(replaceSerials ? { serials } : {}) })
                : await api.post(`/rack/spare-parts/${encodeURIComponent(item.id)}/stock`, {
                    type: mode, qty: n, reason, note, ...(serials.length ? { serials } : {}),
                    ...(mode === 'OUT' && reason === 'Repair' && issueId ? { issueId } : {}),
                });
            onSaved(res.data.item, mode);
        } catch (err) {
            setSaving(false);
            setError(err.response?.data?.error || 'Failed to save the stock change.');
        }
    };

    const reasons = mode === 'IN' ? IN_REASONS : OUT_REASONS;
    return (
        <div className="hw-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !saving) onCancel(); }}>
            <form className="glass-panel ct-form" style={{ width: 'min(520px, 94vw)', '--hw-tone': meta.tone }} onSubmit={submit} role="dialog" aria-modal="true" aria-label={`${meta.title}: ${item.name}`} noValidate>
                <div className="ct-form-head sp-stock-head">
                    <h3><Icon size={18} aria-hidden="true" /> {meta.title}</h3>
                    <button type="button" className="hw-icon-btn" onClick={onCancel} disabled={saving} aria-label="Close"><TbX size={18} /></button>
                </div>
                <div className="ct-form-body custom-scrollbar">
                    <div className="hw-section">
                        <div className="hw-card-title">{item.name}</div>
                        <div className="hw-muted hw-small">{[item.category, item.vendor, item.partNumber, item.location].filter(Boolean).join(' · ')}</div>
                    </div>
                    {mode === 'COUNT' ? (
                        <div className="hw-grid">
                            <div className="hw-field">
                                <label htmlFor="sp-actual">Counted quantity</label>
                                <input id="sp-actual" type="number" min="0" step="1" value={actual} onChange={e => setActual(e.target.value)} autoFocus />
                            </div>
                            <div className="hw-field">
                                <span className="hw-field-label">Recorded now</span>
                                <div className="hw-readonly">{item.quantity}</div>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="hw-field hw-section">
                                <span className="hw-field-label">Reason</span>
                                <div className="sp-reasons" role="radiogroup" aria-label="Reason">
                                    {reasons.map(r => (
                                        <button key={r} type="button" role="radio" aria-checked={reason === r} className={reason === r ? 'is-active' : ''} onClick={() => setReason(r)}>{r}</button>
                                    ))}
                                </div>
                            </div>
                            <div className="hw-grid">
                                <div className="hw-field">
                                    <label htmlFor="sp-move-qty">Quantity</label>
                                    <input id="sp-move-qty" type="number" min="1" step="1" max={mode === 'OUT' ? item.quantity : undefined} value={qty} onChange={e => setQty(e.target.value)} autoFocus />
                                </div>
                                {mode === 'OUT' && reason === 'Repair' ? (
                                    <div className="hw-field">
                                        <label htmlFor="sp-issue">Hardware issue (optional)</label>
                                        <select id="sp-issue" value={issueId} onChange={e => setIssueId(e.target.value)}>
                                            <option value="">Not linked</option>
                                            {openIssues.map(i => <option key={i.id} value={i.id}>{i.deviceName || '?'}: {i.failedParts || 'issue'} ({i.date || i.status})</option>)}
                                        </select>
                                    </div>
                                ) : <div />}
                            </div>
                        </>
                    )}

                    {mode === 'OUT' && onHand.length > 0 && (
                        <div className="hw-field hw-section">
                            <span className="hw-field-label">Serial numbers taken out (optional)</span>
                            <div className="sp-serial-pick">
                                {onHand.map(s => (
                                    <label key={s}><input type="checkbox" checked={outSerials.includes(s)} onChange={() => toggleSerial(s)} /> <span className="ct-mono">{s}</span></label>
                                ))}
                            </div>
                        </div>
                    )}
                    {mode === 'IN' && (
                        <div className="hw-field hw-section">
                            <label htmlFor="sp-in-serials">Serial numbers (optional)</label>
                            <textarea id="sp-in-serials" className="ct-mono" rows={2} value={serialText} onChange={e => setSerialText(e.target.value)} placeholder="One per line or comma separated" />
                        </div>
                    )}
                    {mode === 'COUNT' && (
                        <div className="hw-field hw-section">
                            <label className="hw-inline-label"><input type="checkbox" checked={replaceSerials} onChange={e => setReplaceSerials(e.target.checked)} /> Replace the serial number list ({onHand.length} recorded)</label>
                            {replaceSerials && (
                                <textarea className="ct-mono" rows={3} value={serialText} onChange={e => setSerialText(e.target.value)} placeholder="Serial numbers found, one per line" aria-label="Serial numbers found" style={{ marginTop: 6 }} />
                            )}
                        </div>
                    )}

                    <div className="hw-field hw-section">
                        <label htmlFor="sp-note">Note / reference</label>
                        <input id="sp-note" value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder={mode === 'IN' ? 'PO number, RMA case...' : mode === 'OUT' ? 'Ticket, RMA case, destination...' : 'Count reference'} />
                    </div>
                    {Number.isFinite(after) && (
                        <div className="sp-after">Stock after: <strong>{item.quantity} → {after}</strong>{item.minStock > 0 && after <= item.minStock ? ' (at or below the minimum)' : ''}</div>
                    )}
                </div>
                <div className="ct-form-foot">
                    <div>{error && <div className="ct-error" role="alert">{error}</div>}</div>
                    <div>
                        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : `Confirm ${meta.title.toLowerCase()}`}</button>
                    </div>
                </div>
            </form>
        </div>
    );
}
