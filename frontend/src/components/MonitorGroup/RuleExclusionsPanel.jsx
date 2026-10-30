import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { useConfirm } from '../../contexts/ConfirmContext';
import { exclusionsByRule, exclusionLabel, explicitBindingConflicts, filterMonitors, monitorLabel } from './ruleExclusionUtils';

const S = {
    btnP: { padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 12, fontWeight: 800, cursor: 'pointer' },
    btnS: { padding: '6px 14px', background: 'var(--bg-glass)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 16, fontSize: 12, fontWeight: 700, cursor: 'pointer' },
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, marginBottom: 28 },
    cardHead: { padding: '16px 24px', borderBottom: '1px solid var(--border-color)', fontSize: 14, fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    td: { padding: '14px 24px', verticalAlign: 'top', fontSize: 13, borderBottom: '1px solid var(--border-color)' },
    th: { padding: '14px 24px', textAlign: 'left', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.05em', borderBottom: '2px solid var(--border-color)' },
    chip: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 6, fontSize: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)' },
    x: { background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '0 4px', fontSize: 14, fontWeight: 'bold' },
    overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    modal: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 560, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 48px rgba(0,0,0,0.4)' },
    head: { padding: '20px 28px', borderBottom: '1px solid var(--border-color)' },
    body: { padding: '24px 28px', overflowY: 'auto' },
    foot: { padding: '16px 28px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: 12, background: 'var(--bg-secondary)' },
    group: { marginBottom: 16 },
    label: { display: 'block', fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.05em' },
    input: { width: '100%', padding: '10px 14px', background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, color: 'var(--text-primary)', fontSize: 14, outline: 'none', boxSizing: 'border-box' },
    list: { maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 12, padding: '6px 10px', marginTop: 6 },
    chk: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', fontSize: 13, cursor: 'pointer' },
    warn: { marginTop: 8, padding: '8px 12px', borderRadius: 10, fontSize: 12, background: 'rgba(245, 158, 11, 0.12)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.4)' },
};

const emptyForm = (ruleId = '') => ({ ruleId, scopeType: 'monitor', monitorIds: [], tag: '', reason: '', q: '' });

/**
 * "Excluded hosts" per alert rule: lists exclusions (host or tag, reason, who/when) and adds new ones.
 * An excluded host never evaluates that rule (no alert, no notification); exclusion beats every binding.
 */
export default function RuleExclusionsPanel({ rules = [], monitors = [], bindings = [], canEdit = false }) {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const [exclusions, setExclusions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [form, setForm] = useState(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const load = useCallback(() => api.get('/monitor/rules/exclusions')
        .then(res => Array.isArray(res.data) ? res.data : [])
        .catch(e => { console.error(e); return null; }), []);

    const refresh = useCallback(async () => {
        const rows = await load();
        if (rows) setExclusions(rows);
    }, [load]);

    useEffect(() => {
        let alive = true;
        load().then(rows => {
            if (!alive) return;
            if (rows) setExclusions(rows);
            setLoading(false);
        });
        return () => { alive = false; };
    }, [load]);

    const monitorsById = useMemo(() => Object.fromEntries(monitors.map(m => [m.id, m])), [monitors]);
    const grouped = useMemo(() => exclusionsByRule(exclusions), [exclusions]);
    const rulesWithExclusions = rules.filter(r => grouped[r.id]?.length);

    const patch = (p) => setForm(f => ({ ...f, ...p }));
    const toggleMonitor = (id) => setForm(f => ({ ...f, monitorIds: f.monitorIds.includes(id) ? f.monitorIds.filter(x => x !== id) : [...f.monitorIds, id] }));

    const alreadyExcluded = form ? new Set((grouped[form.ruleId] || []).filter(e => e.scopeType === 'monitor').map(e => String(e.scopeValue))) : new Set();
    const shownMonitors = form ? filterMonitors(monitors, form.q) : [];
    const conflicts = form && form.scopeType === 'monitor' ? explicitBindingConflicts(form.ruleId, form.monitorIds, bindings) : [];

    const save = async () => {
        setError('');
        if (!form.ruleId) { setError('Select a rule'); return; }
        const targets = form.scopeType === 'monitor'
            ? form.monitorIds.map(id => ({ scopeType: 'monitor', scopeValue: id }))
            : [{ scopeType: 'tag', scopeValue: form.tag.trim() }];
        if (form.scopeType === 'monitor' && targets.length === 0) { setError('Select at least one host'); return; }
        if (form.scopeType === 'tag' && !targets[0].scopeValue) { setError('Enter a tag'); return; }
        setSaving(true);
        let added = 0, resolved = 0, skipped = 0;
        try {
            for (const t of targets) {
                try {
                    const res = await api.post('/monitor/rules/exclusions', { ruleId: form.ruleId, ...t, reason: form.reason });
                    added++; resolved += res.data?.resolvedAlerts || 0;
                } catch (e) {
                    if (e.response?.status === 409) { skipped++; continue; }
                    throw e;
                }
            }
            showToast(`Excluded ${added} target(s)${skipped ? `, ${skipped} already excluded` : ''}${resolved ? `; ${resolved} open alert(s) resolved` : ''}`, 'success');
            setForm(null);
        } catch (e) {
            setError(e.response?.data?.error || e.message);
        } finally {
            setSaving(false);
            refresh();
        }
    };

    const remove = async (e, ruleName) => {
        const yes = await showConfirm(`Remove the exclusion of ${exclusionLabel(e, monitorsById)} from "${ruleName}"? The rule will apply to it again.`, 'Remove Exclusion');
        if (!yes) return;
        try {
            await api.delete(`/monitor/rules/exclusions/${e.id}`);
            showToast('Exclusion removed', 'success');
            refresh();
        } catch (err) {
            showToast(`Failed to remove exclusion: ${err.response?.data?.error || err.message}`, 'error');
        }
    };

    return (
        <div style={S.card}>
            <div style={S.cardHead}>
                <span>🚫 Excluded Hosts</span>
                {canEdit && <button style={S.btnS} onClick={() => { setError(''); setForm(emptyForm(rules[0]?.id || '')); }} disabled={rules.length === 0}>Exclude host…</button>}
            </div>
            <div style={{ padding: '12px 24px', fontSize: 12, color: 'var(--text-muted)' }}>
                An excluded host or tag never evaluates the rule (no alert, no notification), even when the rule is assigned to it by environment, tag, API key or directly.
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                    <tr><th style={S.th}>Rule Template</th><th style={S.th}>Excluded hosts / tags</th></tr>
                </thead>
                <tbody>
                    {rulesWithExclusions.map(rule => (
                        <tr key={rule.id}>
                            <td style={{ ...S.td, fontWeight: 700 }}>{rule.name}</td>
                            <td style={S.td}>
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    {grouped[rule.id].map(e => (
                                        <div key={e.id} style={S.chip} title={[e.reason && `Reason: ${e.reason}`, e.createdBy && `By ${e.createdBy}`, e.createdAt && new Date(e.createdAt).toLocaleString()].filter(Boolean).join('\n')}>
                                            <span>
                                                <strong style={{ color: '#ef4444' }}>{exclusionLabel(e, monitorsById)}</strong>
                                                {e.reason && <span style={{ color: 'var(--text-muted)' }}> — {e.reason}</span>}
                                                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}> · {e.createdBy || '-'}{e.createdAt ? `, ${new Date(e.createdAt).toLocaleDateString()}` : ''}</span>
                                            </span>
                                            {canEdit && <button style={S.x} title="Remove exclusion" onClick={() => remove(e, rule.name)}>×</button>}
                                        </div>
                                    ))}
                                </div>
                            </td>
                        </tr>
                    ))}
                    {!loading && rulesWithExclusions.length === 0 && (
                        <tr><td colSpan="2" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 40 }}>No excluded hosts</td></tr>
                    )}
                </tbody>
            </table>

            {form && (
                <div style={S.overlay}>
                    <div style={S.modal}>
                        <div style={S.head}><h3 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>Exclude Hosts from Rule</h3></div>
                        <div style={S.body}>
                            <div style={S.group}>
                                <label style={S.label}>Rule</label>
                                <select style={S.input} value={form.ruleId} onChange={e => patch({ ruleId: e.target.value })}>
                                    {rules.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                                </select>
                            </div>
                            <div style={S.group}>
                                <label style={S.label}>Exclude by</label>
                                <label style={{ ...S.chk, display: 'inline-flex', marginRight: 16 }}><input type="radio" name="exScope" checked={form.scopeType === 'monitor'} onChange={() => patch({ scopeType: 'monitor' })} /> Hosts</label>
                                <label style={{ ...S.chk, display: 'inline-flex' }}><input type="radio" name="exScope" checked={form.scopeType === 'tag'} onChange={() => patch({ scopeType: 'tag' })} /> Tag</label>
                            </div>
                            {form.scopeType === 'monitor' ? (
                                <div style={S.group}>
                                    <input style={S.input} placeholder="Search name, IP or tag…" value={form.q} onChange={e => patch({ q: e.target.value })} />
                                    <div style={S.list}>
                                        {shownMonitors.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No matching hosts</div>}
                                        {shownMonitors.map(m => {
                                            const done = alreadyExcluded.has(String(m.id));
                                            return (
                                                <label key={m.id} style={{ ...S.chk, opacity: done ? 0.5 : 1 }}>
                                                    <input type="checkbox" disabled={done} checked={done || form.monitorIds.includes(m.id)} onChange={() => toggleMonitor(m.id)} />
                                                    <span>{monitorLabel(m)}{done ? ' — already excluded' : ''}</span>
                                                </label>
                                            );
                                        })}
                                    </div>
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{form.monitorIds.length} selected</div>
                                    {conflicts.length > 0 && (
                                        <div style={S.warn}>
                                            ⚠️ {conflicts.map(id => monitorLabel(monitorsById[id]) || id).join(', ')} {conflicts.length === 1 ? 'is' : 'are'} also assigned this rule directly. The exclusion wins: the rule will NOT run there until the exclusion is removed.
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div style={S.group}>
                                    <label style={S.label}>Tag</label>
                                    <input style={S.input} maxLength={64} placeholder="e.g. legacy" value={form.tag} onChange={e => patch({ tag: e.target.value })} />
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Every host carrying this tag (now or later) is excluded.</div>
                                </div>
                            )}
                            <div style={S.group}>
                                <label style={S.label}>Reason (optional)</label>
                                <input style={S.input} maxLength={500} placeholder="e.g. decommissioning, known noisy host" value={form.reason} onChange={e => patch({ reason: e.target.value })} />
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Open alerts of this rule on the excluded hosts are resolved without a recovery notification.</div>
                            {error && <div style={{ color: '#ef4444', fontSize: 13, marginTop: 10 }}>• {error}</div>}
                        </div>
                        <div style={S.foot}>
                            <button style={{ ...S.btnS, padding: '9px 20px' }} onClick={() => setForm(null)}>Cancel</button>
                            <button style={S.btnP} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Exclude'}</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
