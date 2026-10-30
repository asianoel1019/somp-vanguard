import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { WEEKDAY_LABELS, STATUS_META, describeWindow, describeScope, buildWindowPayload, toLocalInput } from './alertQualityUtils';

const S = {
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 12, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnS: { padding: '6px 12px', background: 'var(--bg-glass)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 16, fontSize: 12, fontWeight: 700, cursor: 'pointer', marginLeft: 6 },
    btnDanger: { background: 'var(--bg-glass)', border: '1px solid #ef4444', color: '#ef4444', padding: '6px 12px', borderRadius: 16, fontSize: 12, fontWeight: 700, cursor: 'pointer', marginLeft: 6 },
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, marginBottom: 28 },
    cardHead: { padding: '16px 24px', borderBottom: '1px solid var(--border-color)', fontSize: 14, fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13, borderBottom: '1px solid var(--border-color)' },
    th: { padding: '14px 24px', textAlign: 'left', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.05em', borderBottom: '2px solid var(--border-color)' },
    modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    modalContent: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 620, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 48px rgba(0,0,0,0.4)' },
    modalHead: { padding: '20px 28px', borderBottom: '1px solid var(--border-color)' },
    modalBody: { padding: '24px 28px', overflowY: 'auto' },
    modalFoot: { padding: '16px 28px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: 12, background: 'var(--bg-secondary)' },
    inputGroup: { marginBottom: 16 },
    label: { display: 'block', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.05em' },
    input: { width: '100%', padding: '10px 14px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
    chk: { display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 12, fontSize: 13, cursor: 'pointer' },
    list: { maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 12, padding: '6px 10px', marginTop: 6 },
};

const emptyForm = () => ({
    name: '', reason: '', kind: 'once',
    startLocal: toLocalInput(new Date().toISOString()),
    endLocal: toLocalInput(new Date(Date.now() + 2 * 3600000).toISOString()),
    weekdays: [], startTime: '02:00', durationMin: 120,
    scopeType: 'all', scopeValues: [], tagsText: '', ruleIds: [],
});

const formFromWindow = (w) => ({
    name: w.name || '', reason: w.reason || '', kind: w.kind,
    startLocal: w.startAt ? toLocalInput(w.startAt) : '',
    endLocal: w.endAt ? toLocalInput(w.endAt) : '',
    weekdays: w.weekdays || [], startTime: w.startTime || '02:00', durationMin: w.durationMin || 60,
    scopeType: w.scopeType, scopeValues: w.scopeValues || [], tagsText: (w.scopeValues || []).join(', '), ruleIds: w.ruleIds || [],
});

function CheckList({ items, selected, onToggle, search }) {
    const [q, setQ] = useState('');
    const shown = items.filter(i => !q || i.label.toLowerCase().includes(q.toLowerCase()));
    return (
        <div>
            {search && <input style={S.input} placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} />}
            <div style={S.list}>
                {shown.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No items available</div>}
                {shown.map(i => (
                    <label key={i.value} style={{ ...S.chk, display: 'flex', marginRight: 0, padding: '3px 0' }}>
                        <input type="checkbox" checked={selected.includes(i.value)} onChange={() => onToggle(i.value)} />
                        <span>{i.label}</span>
                    </label>
                ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{selected.length} selected</div>
        </div>
    );
}

export default function MaintenancePanel({ monitors = [], rules = [], environments = [], canEdit = false }) {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const [windows, setWindows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(null); // { id|null, form }
    const [formErrors, setFormErrors] = useState([]);
    const [saving, setSaving] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const res = await api.get('/alert-quality/maintenance');
            setWindows(res.data || []);
        } catch (e) {
            console.error(e);
        } finally { setLoading(false); }
    }, []);

    useEffect(() => {
        refresh();
        const t = setInterval(refresh, 60000);
        return () => clearInterval(t);
    }, [refresh]);

    const monitorsById = useMemo(() => Object.fromEntries(monitors.map(m => [m.id, m])), [monitors]);
    const monitorItems = useMemo(() => monitors.map(m => ({ value: m.id, label: m.ip ? `${m.name} (${m.ip})` : (m.name || m.id) })), [monitors]);
    const envItemsFor = (selected) => {
        const nameOf = (id) => (environments.find(e => e.id === id)?.name) || id;
        const ids = [...new Set([...monitors.map(m => m.envId).filter(Boolean), ...(selected || [])])];
        return ids.map(v => ({ value: v, label: nameOf(v) }));
    };
    const ruleItems = useMemo(() => rules.map(r => ({ value: r.id, label: r.name || r.id })), [rules]);

    const setForm = (patch) => setEditing(e => ({ ...e, form: { ...e.form, ...patch } }));
    const toggleIn = (key, v) => setEditing(e => {
        const cur = e.form[key] || [];
        return { ...e, form: { ...e.form, [key]: cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v] } };
    });

    const openNew = () => { setFormErrors([]); setEditing({ id: null, form: emptyForm() }); };
    const openEdit = (w) => { setFormErrors([]); setEditing({ id: w.id, form: formFromWindow(w) }); };

    const save = async () => {
        const form = editing.form.scopeType === 'tags'
            ? { ...editing.form, scopeValues: (editing.form.tagsText || '').split(',').map(s => s.trim()).filter(Boolean) }
            : editing.form;
        const { ok, errors, payload } = buildWindowPayload(form);
        if (!ok) { setFormErrors(errors); return; }
        setSaving(true); setFormErrors([]);
        try {
            if (editing.id) await api.put(`/alert-quality/maintenance/${editing.id}`, payload);
            else await api.post('/alert-quality/maintenance', payload);
            showToast('✅ Maintenance window saved', 'success');
            setEditing(null);
            await refresh();
        } catch (e) {
            const d = e.response?.data;
            setFormErrors(d?.errors?.length ? d.errors : [d?.error || e.message]);
        } finally { setSaving(false); }
    };

    const toggleEnabled = async (w) => {
        try {
            await api.put(`/alert-quality/maintenance/${w.id}`, { enabled: !w.enabled });
            await refresh();
        } catch (e) {
            showToast(`Operation failed: ${e.response?.data?.error || e.message}`, 'error');
        }
    };

    const remove = async (w) => {
        const yes = await showConfirm(`Delete maintenance window "${w.name}"?`, 'Delete Maintenance Window');
        if (!yes) return;
        try {
            await api.delete(`/alert-quality/maintenance/${w.id}`);
            showToast('✅ Maintenance window deleted', 'success');
            await refresh();
        } catch (e) {
            showToast(`Delete failed: ${e.response?.data?.error || e.message}`, 'error');
        }
    };

    const f = editing?.form;

    return (
        <div style={S.card}>
            <div style={S.cardHead}>
                <span>🔧 Maintenance Windows</span>
                {canEdit && <button style={S.btnP} onClick={openNew}>+ New Maintenance Window</button>}
            </div>
            <div style={{ padding: '12px 24px', fontSize: 12, color: 'var(--text-muted)' }}>
                During a maintenance window, alerts in scope are still recorded but no notifications are sent.
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                    <tr>
                        <th style={S.th}>Status</th><th style={S.th}>Name</th><th style={S.th}>Time</th><th style={S.th}>Scope</th><th style={S.th}>Created by</th>
                        {canEdit && <th style={{ ...S.th, textAlign: 'right' }}>Actions</th>}
                    </tr>
                </thead>
                <tbody>
                    {windows.map(w => {
                        const meta = STATUS_META[w.status] || { label: w.status, color: 'var(--text-muted)' };
                        return (
                            <tr key={w.id}>
                                <td style={{ ...S.td, color: meta.color, fontWeight: 700, whiteSpace: 'nowrap' }}>{meta.label}</td>
                                <td style={{ ...S.td, fontWeight: 700 }} title={w.reason || ''}>
                                    {w.name}{w.source === 'quick-mute' && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)' }}>🔕 Quick mute</span>}
                                </td>
                                <td style={S.td}>{describeWindow(w)}</td>
                                <td style={S.td}>{describeScope(w, monitorsById)}</td>
                                <td style={{ ...S.td, color: 'var(--text-muted)' }}>{w.createdBy || '-'}</td>
                                {canEdit && (
                                    <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                        <button style={S.btnS} onClick={() => toggleEnabled(w)}>{w.enabled ? 'Disable' : 'Enable'}</button>
                                        <button style={S.btnS} onClick={() => openEdit(w)}>Edit</button>
                                        <button style={S.btnDanger} onClick={() => remove(w)}>Delete</button>
                                    </td>
                                )}
                            </tr>
                        );
                    })}
                    {!loading && windows.length === 0 && (
                        <tr><td colSpan={canEdit ? 6 : 5} style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No maintenance windows configured</td></tr>
                    )}
                </tbody>
            </table>

            {editing && (
                <div style={S.modalOverlay}>
                    <div style={S.modalContent}>
                        <div style={S.modalHead}><h3 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>{editing.id ? 'Edit Maintenance Window' : 'New Maintenance Window'}</h3></div>
                        <div style={S.modalBody}>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Name</label>
                                <input style={S.input} value={f.name} onChange={e => setForm({ name: e.target.value })} maxLength={100} />
                            </div>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Reason</label>
                                <input style={S.input} value={f.reason} onChange={e => setForm({ reason: e.target.value })} maxLength={500} />
                            </div>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Kind</label>
                                <label style={S.chk}><input type="radio" name="aqKind" checked={f.kind === 'once'} onChange={() => setForm({ kind: 'once' })} /> One-time</label>
                                <label style={S.chk}><input type="radio" name="aqKind" checked={f.kind === 'weekly'} onChange={() => setForm({ kind: 'weekly' })} /> Weekly</label>
                            </div>
                            {f.kind === 'once' ? (
                                <div style={{ display: 'flex', gap: 12 }}>
                                    <div style={{ ...S.inputGroup, flex: 1 }}>
                                        <label style={S.label}>Start</label>
                                        <input type="datetime-local" style={S.input} value={f.startLocal} onChange={e => setForm({ startLocal: e.target.value })} />
                                    </div>
                                    <div style={{ ...S.inputGroup, flex: 1 }}>
                                        <label style={S.label}>End</label>
                                        <input type="datetime-local" style={S.input} value={f.endLocal} onChange={e => setForm({ endLocal: e.target.value })} />
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div style={S.inputGroup}>
                                        <label style={S.label}>Weekdays (server local time)</label>
                                        {WEEKDAY_LABELS.map((d, i) => (
                                            <label key={i} style={S.chk}>
                                                <input type="checkbox" checked={f.weekdays.includes(i)} onChange={() => toggleIn('weekdays', i)} /> {d}
                                            </label>
                                        ))}
                                    </div>
                                    <div style={{ display: 'flex', gap: 12 }}>
                                        <div style={{ ...S.inputGroup, flex: 1 }}>
                                            <label style={S.label}>Start time</label>
                                            <input type="time" style={S.input} value={f.startTime} onChange={e => setForm({ startTime: e.target.value })} />
                                        </div>
                                        <div style={{ ...S.inputGroup, flex: 1 }}>
                                            <label style={S.label}>Duration (minutes)</label>
                                            <input type="number" min="1" max="10080" style={S.input} value={f.durationMin} onChange={e => setForm({ durationMin: e.target.value })} />
                                        </div>
                                    </div>
                                </>
                            )}
                            <div style={S.inputGroup}>
                                <label style={S.label}>Scope</label>
                                <select style={S.input} value={f.scopeType} onChange={e => setForm({ scopeType: e.target.value, scopeValues: [] })}>
                                    <option value="all">All hosts</option>
                                    <option value="monitors">Specific hosts</option>
                                    <option value="tags">By tag</option>
                                    <option value="envs">By environment</option>
                                </select>
                                {f.scopeType === 'monitors' && (
                                    <CheckList search items={monitorItems} selected={f.scopeValues} onToggle={v => toggleIn('scopeValues', v)} />
                                )}
                                {f.scopeType === 'tags' && (
                                    <input style={{ ...S.input, marginTop: 6 }} placeholder="Comma-separated, e.g. web, db"
                                        value={f.tagsText}
                                        onChange={e => setForm({ tagsText: e.target.value })} />
                                )}
                                {f.scopeType === 'envs' && (
                                    <CheckList items={envItemsFor(f.scopeValues)} selected={f.scopeValues} onToggle={v => toggleIn('scopeValues', v)} />
                                )}
                            </div>
                            <div style={S.inputGroup}>
                                <label style={S.label}>Limit to rules (none selected = all rules, including offline)</label>
                                <CheckList search items={ruleItems} selected={f.ruleIds} onToggle={v => toggleIn('ruleIds', v)} />
                            </div>
                            {formErrors.length > 0 && (
                                <div style={{ color: '#ef4444', fontSize: 13 }}>
                                    {formErrors.map((er, i) => <div key={i}>• {er}</div>)}
                                </div>
                            )}
                        </div>
                        <div style={S.modalFoot}>
                            <button style={{ ...S.btnS, padding: '9px 20px' }} onClick={() => setEditing(null)}>Cancel</button>
                            <button style={{ ...S.btnP, padding: '9px 20px' }} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
