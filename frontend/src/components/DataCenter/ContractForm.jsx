import React, { useMemo, useRef, useState } from 'react';
import { TbX, TbSearch, TbFileText, TbRefresh } from 'react-icons/tb';
import api from '../../api';
import { CONTRACT_TYPES, CURRENCIES, FILE_ACCEPT, FILE_MAX_BYTES, formProblem, groupDevices } from './contractUtils';
import './hwIssues.css';
import './contracts.css';

// Create / edit / renew dialog. draft: emptyContract() / editDraft() / renewalDraft(); stored: the saved contract
// (edit) for its file. onSaved(contract), onConflict(currentContract) when someone else changed it meanwhile.
export default function ContractForm({ draft, stored, renewing, devices, onCancel, onSaved, onConflict }) {
    const [form, setForm] = useState(draft);
    const [file, setFile] = useState(null); // { fileBase64, originalFileName, size }
    const [removeFile, setRemoveFile] = useState(false);
    const [deviceQuery, setDeviceQuery] = useState('');
    const [selectedOnly, setSelectedOnly] = useState(false);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const fileRef = useRef(null);

    const set = (key, value) => setForm(prev => ({ ...prev, [key]: value }));
    const isHw = form.type === 'Hardware Warranties';
    const linked = useMemo(() => new Set(form.linkedDevices || []), [form.linkedDevices]);
    const groups = useMemo(() => groupDevices(devices, deviceQuery, selectedOnly ? linked : null), [devices, deviceQuery, selectedOnly, linked]);
    const knownIds = useMemo(() => new Set((devices || []).map(d => d.id)), [devices]);
    const missing = (form.linkedDevices || []).filter(id => !knownIds.has(id));

    const toggleDevice = (d) => setForm(prev => {
        const list = prev.linkedDevices || [];
        if (list.includes(d.id)) return { ...prev, linkedDevices: list.filter(x => x !== d.id) };
        // The first linked device of a warranty fills in an empty serial number
        const serialNumber = prev.type === 'Hardware Warranties' && !String(prev.serialNumber || '').trim() && d.sn ? d.sn : prev.serialNumber;
        return { ...prev, serialNumber, linkedDevices: [...list, d.id] };
    });

    const pickFile = (e) => {
        const f = e.target.files && e.target.files[0];
        setError('');
        if (!f) { setFile(null); return; }
        if (f.size > FILE_MAX_BYTES) {
            setError('The file is larger than 5 MB.');
            e.target.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = (ev) => { setFile({ fileBase64: ev.target.result, originalFileName: f.name, size: f.size }); setRemoveFile(false); };
        reader.onerror = () => setError('Could not read the file.');
        reader.readAsDataURL(f);
    };

    const submit = async (e) => {
        e.preventDefault();
        const problem = formProblem(form);
        if (problem) { setError(problem); return; }
        setSaving(true);
        setError('');
        try {
            const body = { ...form, ...(file ? { fileBase64: file.fileBase64, originalFileName: file.originalFileName } : {}), ...(removeFile ? { removeFile: true } : {}) };
            const res = await api.post('/rack/contracts', body);
            onSaved(res.data.contract);
        } catch (err) {
            setSaving(false);
            if (err.response?.status === 409 && err.response.data?.contract) {
                setError(err.response.data.error);
                onConflict(err.response.data.contract);
                return;
            }
            setError(err.response?.data?.error || 'Failed to save the contract.');
        }
    };

    const title = renewing ? `Renew: ${stored ? stored.name : form.name}` : form.id ? 'Edit contract' : 'New contract';
    return (
        <div className="hw-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !saving) onCancel(); }}>
            <form className="glass-panel ct-form" onSubmit={submit} role="dialog" aria-modal="true" aria-label={title} noValidate>
                <div className="ct-form-head">
                    <h3>{title}</h3>
                    <button type="button" className="hw-icon-btn" onClick={onCancel} disabled={saving} aria-label="Close"><TbX size={18} /></button>
                </div>
                <div className="ct-form-body">
                    {renewing && (
                        <div className="ct-info hw-section">
                            <TbRefresh size={14} aria-hidden="true" /> The new term starts the day after the current one ends. Once saved, the current
                            term is kept as history and marked renewed, so it no longer raises expiry alerts.
                        </div>
                    )}
                    <div className="hw-grid">
                        <div className="hw-field">
                            <label htmlFor="ct-type">Type</label>
                            <select id="ct-type" value={form.type} onChange={e => set('type', e.target.value)} disabled={renewing || !!form.id}>
                                {CONTRACT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                        </div>
                        <div className="hw-field">
                            <label htmlFor="ct-vendor">Vendor *</label>
                            <input id="ct-vendor" value={form.vendor} onChange={e => set('vendor', e.target.value)} maxLength={200} placeholder="e.g. Dell, Microsoft" />
                        </div>
                    </div>
                    <div className="hw-grid">
                        <div className="hw-field">
                            <label htmlFor="ct-name">{isHw ? 'Warranty level / name *' : 'Software name *'}</label>
                            <input id="ct-name" value={form.name} onChange={e => set('name', e.target.value)} maxLength={200} placeholder={isHw ? 'e.g. ProSupport Plus 4h' : 'e.g. Windows Server 2025 Datacenter'} />
                        </div>
                        {isHw ? (
                            <div className="hw-field">
                                <label htmlFor="ct-sn">Serial number / service tag</label>
                                <input id="ct-sn" className="ct-mono" value={form.serialNumber} onChange={e => set('serialNumber', e.target.value)} maxLength={200} placeholder="Filled from the first linked device" />
                            </div>
                        ) : (
                            <div className="hw-grid" style={{ marginBottom: 0 }}>
                                <div className="hw-field">
                                    <label htmlFor="ct-seats">Seats</label>
                                    <input id="ct-seats" type="number" min="0" step="1" value={form.seats} onChange={e => set('seats', e.target.value)} />
                                </div>
                                <div className="hw-field">
                                    <label htmlFor="ct-used">Seats used</label>
                                    <input id="ct-used" type="number" min="0" step="1" value={form.seatsUsed} onChange={e => set('seatsUsed', e.target.value)} placeholder="Linked devices" />
                                </div>
                            </div>
                        )}
                    </div>
                    <div className="hw-grid">
                        <div className="hw-field">
                            <label htmlFor="ct-start">Start date *</label>
                            <input id="ct-start" type="date" value={form.startDate} onChange={e => set('startDate', e.target.value)} />
                        </div>
                        <div className="hw-field">
                            <label htmlFor="ct-end">End date *</label>
                            <input id="ct-end" type="date" value={form.endDate} min={form.startDate || undefined} onChange={e => set('endDate', e.target.value)} />
                        </div>
                    </div>
                    <div className="hw-grid">
                        <div className="hw-grid" style={{ marginBottom: 0, gridTemplateColumns: '2fr 1fr' }}>
                            <div className="hw-field">
                                <label htmlFor="ct-cost">Cost</label>
                                <input id="ct-cost" type="number" min="0" step="any" value={form.cost} onChange={e => set('cost', e.target.value)} />
                            </div>
                            <div className="hw-field">
                                <label htmlFor="ct-cur">Currency</label>
                                <select id="ct-cur" value={form.currency || 'TWD'} onChange={e => set('currency', e.target.value)}>
                                    {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                            </div>
                        </div>
                        <div className="hw-field">
                            <label htmlFor="ct-contact">Support contact</label>
                            <input id="ct-contact" value={form.contact} onChange={e => set('contact', e.target.value)} maxLength={200} placeholder="Hotline, contract no., account manager" />
                        </div>
                    </div>

                    <div className="hw-field hw-section">
                        <span className="hw-field-label">Linked devices ({linked.size})</span>
                        <div className="ct-picker">
                            <div className="ct-picker-bar">
                                <div className="hw-search">
                                    <TbSearch size={14} aria-hidden="true" />
                                    <input value={deviceQuery} onChange={e => setDeviceQuery(e.target.value)} placeholder="Search host, model, serial, rack..." aria-label="Search devices" />
                                </div>
                                <label className="hw-inline-label"><input type="checkbox" checked={selectedOnly} onChange={e => setSelectedOnly(e.target.checked)} /> Selected only</label>
                            </div>
                            <div className="ct-picker-list">
                                {groups.map(g => (
                                    <div key={g.key}>
                                        <div className="ct-picker-group">{g.label}</div>
                                        {g.devices.map(d => (
                                            <label key={d.id} className="ct-picker-item">
                                                <input type="checkbox" checked={linked.has(d.id)} onChange={() => toggleDevice(d)} />
                                                <span>{d.hostname || d.id} <span className="hw-muted">{[d.model, d.sn && `SN ${d.sn}`, d.u && `U${d.u}`].filter(Boolean).join(' · ')}</span></span>
                                            </label>
                                        ))}
                                    </div>
                                ))}
                                {!groups.length && <div className="hw-column-empty">{(devices || []).length ? 'No device matches.' : 'No devices in the data centers yet.'}</div>}
                            </div>
                        </div>
                        {missing.length > 0 && <div className="hw-field-help">{missing.length} linked device(s) no longer exist in the racks; they stay linked until you clear them.</div>}
                    </div>

                    {!isHw && (
                        <div className="hw-field hw-section">
                            <label htmlFor="ct-key">License key</label>
                            <textarea id="ct-key" className="ct-mono" value={form.licenseKey} onChange={e => set('licenseKey', e.target.value)} maxLength={4000} placeholder="Paste the product key" />
                        </div>
                    )}
                    <div className="hw-field hw-section">
                        <label htmlFor="ct-notes">Notes</label>
                        <textarea id="ct-notes" rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} maxLength={2000} placeholder="Coverage, terms, purchase order..." />
                    </div>

                    <div className="ct-file">
                        <label className="hw-field-label" htmlFor="ct-file">Contract / license file (PDF, DOCX, PNG, JPG; up to 5 MB)</label>
                        <input id="ct-file" ref={fileRef} type="file" accept={FILE_ACCEPT} onChange={pickFile} />
                        {file && <div className="ct-file-row"><TbFileText size={14} aria-hidden="true" /> {file.originalFileName} will be uploaded on save</div>}
                        {!file && stored && stored.savedFileName && (
                            <div className="ct-file-row">
                                <TbFileText size={14} aria-hidden="true" /> Current: {stored.originalFileName || stored.savedFileName}
                                <label className="hw-inline-label"><input type="checkbox" checked={removeFile} onChange={e => setRemoveFile(e.target.checked)} /> Remove it</label>
                            </div>
                        )}
                    </div>
                </div>
                <div className="ct-form-foot">
                    <div>{error && <div className="ct-error" role="alert">{error}</div>}</div>
                    <div>
                        <button type="button" className="btn btn-outline" onClick={onCancel} disabled={saving}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : renewing ? 'Save renewal' : 'Save contract'}</button>
                    </div>
                </div>
            </form>
        </div>
    );
}
