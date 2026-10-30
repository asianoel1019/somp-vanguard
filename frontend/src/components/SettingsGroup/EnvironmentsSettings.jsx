import { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import { useToast } from '../../contexts/ToastContext';
import {
    NAME_MAX, PURPOSE_MAX, isDefaultEnvironment, nonZeroUsage, usageSummary, deleteBlockReason, validateEnvironmentForm, failedConsumers, cascadeSummary, isRename,
    unmappedRows, unmappedLabel
} from './environmentsUtils';

const cannotDelete = (env) => isDefaultEnvironment(env) || !!env.isDefault;

// Stored values that do not resolve to an environment (per consumer); SuperAdmin maps each to an environment
function UnmappedValues({ envs, onApplied }) {
    const { showToast } = useToast();
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [targets, setTargets] = useState({});
    const [busy, setBusy] = useState('');

    const [reloadKey, setReloadKey] = useState(0);
    const load = useCallback(() => setReloadKey(k => k + 1), []);

    useEffect(() => {
        let alive = true;
        api.get('/environments/unmapped')
            .then(res => {
                if (!alive) return;
                setError('');
                setData(Array.isArray(res.data?.consumers) ? res.data.consumers : []);
            })
            .catch(e => { if (alive) setError(e.response?.data?.error || 'Failed to load unmapped values'); });
        return () => { alive = false; };
    }, [reloadKey]);

    const rows = unmappedRows(data);
    const failed = (data || []).filter(c => c.error);
    const rowKey = (r) => `${r.key}|${r.value}`;

    const apply = async (r) => {
        const envId = targets[rowKey(r)];
        if (!envId) return;
        setBusy(rowKey(r));
        try {
            const res = await api.post('/environments/unmapped/apply', { consumer: r.key, value: r.value, envId });
            showToast(`${res.data.count} record(s) of ${r.consumer} assigned`, 'success');
            await load();
            if (onApplied) onApplied();
        } catch (e) {
            showToast(e.response?.data?.error || 'Failed to apply', 'error');
        } finally {
            setBusy('');
        }
    };

    return (
        <div style={{ ...S.wrap, marginTop: 20 }}>
            <div style={S.head}>
                <div>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>Unmapped values</h3>
                    <div style={S.muted}>Stored environment values that match no environment (shown as &quot;Unassigned&quot;). Choose an environment per value and apply.</div>
                </div>
                <button style={S.btnO} onClick={load}>Refresh</button>
            </div>
            {error && <div style={{ padding: '14px 24px', color: 'var(--danger)', fontSize: 13 }}>{error}</div>}
            {failed.length > 0 && <div style={{ padding: '14px 24px', color: 'var(--warning)', fontSize: 12 }}>Could not be read: {failed.map(c => c.consumer).join(', ')}</div>}
            {!data && !error && <div style={{ padding: 24, ...S.muted }}>Loading...</div>}
            {data && rows.length === 0 && <div style={{ padding: 24, ...S.muted }}>Every stored value maps to an environment.</div>}
            {rows.length > 0 && (
                <table style={S.tbl}>
                    <thead>
                        <tr>
                            <th style={S.th}>CONSUMER</th>
                            <th style={S.th}>VALUE</th>
                            <th style={S.th}>RECORDS</th>
                            <th style={{ ...S.th, textAlign: 'right' }}>MAP TO</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(r => (
                            <tr key={rowKey(r)}>
                                <td style={S.td}>{r.consumer}</td>
                                <td style={{ ...S.td, fontFamily: 'monospace' }}>{unmappedLabel(r.value)}</td>
                                <td style={S.td}>{r.count}</td>
                                <td style={{ ...S.td, textAlign: 'right' }}>
                                    {r.readOnly ? (
                                        <span style={S.muted}>Read-only: edit these targets in Prometheus SD</span>
                                    ) : (
                                        <span style={{ display: 'inline-flex', gap: 8 }}>
                                            <select
                                                style={{ ...S.input, marginTop: 0, width: 180, padding: '8px 10px' }}
                                                value={targets[rowKey(r)] || ''}
                                                onChange={e => setTargets(t => ({ ...t, [rowKey(r)]: e.target.value }))}
                                            >
                                                <option value="">Choose...</option>
                                                {envs.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
                                            </select>
                                            <button style={S.btnO} disabled={!targets[rowKey(r)] || busy === rowKey(r)} onClick={() => apply(r)}>
                                                {busy === rowKey(r) ? 'Applying...' : 'Apply'}
                                            </button>
                                        </span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

const S = {
    wrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden' },
    head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13, borderBottom: '1px solid var(--border-color)' },
    input: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box' },
    btnP: { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 24px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
    btnO: { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 18px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 12, fontWeight: 700, cursor: 'pointer' },
    btnD: { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 18px', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 24, fontSize: 12, fontWeight: 700, cursor: 'pointer' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 520, boxShadow: '0 30px 60px rgba(0,0,0,0.3)', backdropFilter: 'blur(16px)', padding: 28 },
    label: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' },
    note: { marginTop: 12, padding: 14, borderRadius: 12, background: 'var(--bg-secondary)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6, border: '1px solid var(--border-color)' },
    muted: { color: 'var(--text-muted)', fontSize: 12 }
};

function UsageList({ usage }) {
    const items = nonZeroUsage(usage);
    if (!usage) return <div style={S.muted}>Loading usage...</div>;
    const unknown = usage.complete === false;
    if (items.length === 0 && !unknown) return <div style={S.muted}>Not referenced anywhere.</div>;
    return (
        <>
        {unknown && <div style={{ color: 'var(--warning)', fontSize: 12, fontWeight: 700 }}>Usage could not be determined for: {usage.items.filter(i => i.error).map(i => i.consumer).join(', ')}.</div>}
        <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
            {items.map(i => (
                <li key={i.consumer}>
                    <b>{i.consumer}</b>: {i.count} <span style={S.muted}>({i.keyedBy === 'id' ? 'linked by id' : 'matched by name'})</span>
                </li>
            ))}
        </ul>
        </>
    );
}

export default function EnvironmentsSettings() {
    const { showToast } = useToast();
    const role = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}').role || 'Viewer'; } catch { return 'Viewer'; } })();
    const canEdit = role === 'SuperAdmin';

    const [envs, setEnvs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [usageMap, setUsageMap] = useState({});
    const [usageLoading, setUsageLoading] = useState({});
    const [editor, setEditor] = useState(null); // { env|null, form, error, cascade, saving }
    const [deleting, setDeleting] = useState(null); // { env, saving }

    const load = useCallback(async () => {
        try {
            const res = await api.get('/environments');
            setEnvs(Array.isArray(res.data) ? res.data : []);
        } catch (e) {
            showToast(e.response?.data?.error || 'Failed to load environments', 'error');
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => { load(); }, [load]);

    const loadUsage = useCallback(async (id) => {
        if (!canEdit) return null;
        setUsageLoading(m => ({ ...m, [id]: true }));
        try {
            const res = await api.get(`/environments/${id}/usage`);
            setUsageMap(m => ({ ...m, [id]: res.data }));
            return res.data;
        } catch (e) {
            showToast(e.response?.data?.error || 'Failed to load usage', 'error');
            return null;
        } finally {
            setUsageLoading(m => ({ ...m, [id]: false }));
        }
    }, [canEdit, showToast]);

    const openAdd = () => setEditor({ env: null, form: { name: '', purpose: '', isProduction: false, isDefault: false }, error: '', cascade: true, saving: false });
    const openEdit = (env) => {
        setEditor({ env, form: { name: env.name, purpose: env.purpose || '', isProduction: !!env.isProduction, isDefault: !!env.isDefault }, error: '', cascade: true, saving: false });
        loadUsage(env.id);
    };
    const openDelete = (env) => {
        setDeleting({ env, saving: false });
        loadUsage(env.id);
    };

    const renamed = !!(editor && editor.env && isRename(editor.env, editor.form.name));
    const editorUsage = editor && editor.env ? usageMap[editor.env.id] : null;
    const editorRefs = editorUsage ? editorUsage.items.filter(i => i.keyedBy === 'name').reduce((s, i) => s + i.count, 0) : 0;

    const save = async () => {
        const err = validateEnvironmentForm(editor.form, envs, editor.env ? editor.env.id : null);
        if (err) return setEditor(e => ({ ...e, error: err }));
        setEditor(e => ({ ...e, saving: true, error: '' }));
        try {
            const body = { name: editor.form.name.trim(), purpose: editor.form.purpose.trim(), isProduction: !!editor.form.isProduction };
            // isDefault can only be turned on (exactly one default: choosing another one moves it)
            if (editor.form.isDefault && !(editor.env && editor.env.isDefault)) body.isDefault = true;
            if (editor.env) {
                if (renamed) body.cascade = editor.cascade;
                const res = await api.put(`/environments/${editor.env.id}`, body);
                const upd = (res.data.cascade || []).reduce((s, c) => s + c.count, 0);
                showToast(renamed && editor.cascade ? `Environment renamed, ${upd} reference(s) updated` : 'Environment saved', 'success');
            } else {
                await api.post('/environments', body);
                showToast('Environment added', 'success');
            }
            setEditor(null);
            setUsageMap({});
            load();
        } catch (e) {
            // A failed cascade changes nothing in the list; show which consumers were updated so Save can simply be retried
            const cascade = e.response?.data?.cascade;
            const detail = cascade ? ` Results: ${cascadeSummary(cascade)}.` : '';
            setEditor(cur => ({
                ...cur, saving: false, failed: failedConsumers(cascade).length > 0,
                error: (e.response?.data?.error || 'Failed to save environment') + detail
            }));
        }
    };

    const confirmDelete = async () => {
        setDeleting(d => ({ ...d, saving: true }));
        try {
            await api.delete(`/environments/${deleting.env.id}`);
            showToast('Environment deleted', 'success');
            setDeleting(null);
            setUsageMap({});
            load();
        } catch (e) {
            showToast(e.response?.data?.error || 'Failed to delete environment', 'error');
            if (e.response?.data?.usage) setUsageMap(m => ({ ...m, [deleting.env.id]: e.response.data.usage }));
            setDeleting(d => d && ({ ...d, saving: false }));
        }
    };

    const delUsage = deleting ? usageMap[deleting.env.id] : null;
    const delBlock = deleting ? deleteBlockReason(deleting.env, envs, delUsage) : null;

    if (loading) return <div style={{ textAlign: 'center', padding: 60 }}>Loading environments...</div>;

    return (
        <div>
            <div style={S.wrap}>
                <div style={S.head}>
                    <div>
                        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>Global Environments</h3>
                        <div style={S.muted}>
                            Used by IPAM, SSL, Database, Kubernetes, Scout, CMDB and more.
                            {!canEdit && ' Only SuperAdmin can change this list.'}
                        </div>
                    </div>
                    {canEdit && <button style={S.btnP} onClick={openAdd}>+ Add Environment</button>}
                </div>
                <table style={S.tbl}>
                    <thead>
                        <tr>
                            <th style={S.th}>NAME</th>
                            <th style={S.th}>PURPOSE</th>
                            <th style={S.th}>ID</th>
                            {canEdit && <th style={S.th}>USAGE</th>}
                            {canEdit && <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {envs.map(env => {
                            const usage = usageMap[env.id];
                            return (
                                <tr key={env.id}>
                                    <td style={{ ...S.td, fontWeight: 800 }}>
                                        {env.name}
                                        {env.isDefault && <span style={{ ...S.muted, marginLeft: 8 }}>(default)</span>}
                                        {env.isProduction && <span style={{ marginLeft: 8, padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 800, background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>PRODUCTION</span>}
                                    </td>
                                    <td style={S.td}>{env.purpose || <span style={S.muted}>-</span>}</td>
                                    <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11, color: 'var(--text-muted)' }}>{env.id}</td>
                                    {canEdit && (
                                        <td style={S.td}>
                                            {usage
                                                ? <span title={usageSummary(usage)}>{usage.total} reference{usage.total === 1 ? '' : 's'}</span>
                                                : <button style={S.btnO} disabled={usageLoading[env.id]} onClick={() => loadUsage(env.id)}>{usageLoading[env.id] ? 'Loading...' : 'Show usage'}</button>}
                                        </td>
                                    )}
                                    {canEdit && (
                                        <td style={{ ...S.td, textAlign: 'right' }}>
                                            <span style={{ display: 'inline-flex', gap: 8 }}>
                                                <button style={S.btnO} onClick={() => openEdit(env)}>Edit</button>
                                                <button
                                                    style={{ ...S.btnD, opacity: cannotDelete(env) ? 0.4 : 1 }}
                                                    disabled={cannotDelete(env)}
                                                    title={cannotDelete(env) ? 'The default environment (and Others) cannot be deleted' : ''}
                                                    onClick={() => openDelete(env)}
                                                >Delete</button>
                                            </span>
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <div style={S.note}>
                Every screen stores the environment id (CMDB / Server List, IPAM, SSL, Database, Kubernetes, Scout monitors, alert rule bindings, maintenance windows) and shows the current name, so a rename is visible everywhere at once.
                Only Prometheus labels keep the name as text: renaming with &quot;Also update references&quot; rewrites them (and refreshes the stored name copies).
                Values that match no environment are shown as &quot;Unassigned&quot; and listed below.
            </div>
            {canEdit && <UnmappedValues envs={envs} onApplied={() => setUsageMap({})} />}

            {editor && (
                <div style={S.overlay} onClick={() => !editor.saving && setEditor(null)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <h3 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 900 }}>{editor.env ? 'Edit Environment' : 'Add Environment'}</h3>
                        <div style={{ marginBottom: 14 }}>
                            <label style={S.label}>Name</label>
                            <input
                                style={S.input} maxLength={NAME_MAX} autoFocus
                                disabled={editor.env && isDefaultEnvironment(editor.env)}
                                value={editor.form.name}
                                onChange={e => setEditor(c => ({ ...c, form: { ...c.form, name: e.target.value }, error: '' }))}
                            />
                        </div>
                        <div style={{ marginBottom: 14 }}>
                            <label style={S.label}>Purpose</label>
                            <input
                                style={S.input} maxLength={PURPOSE_MAX}
                                value={editor.form.purpose}
                                onChange={e => setEditor(c => ({ ...c, form: { ...c.form, purpose: e.target.value }, error: '' }))}
                            />
                        </div>
                        <div style={{ display: 'flex', gap: 24, marginBottom: 6, flexWrap: 'wrap' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                                <input type="checkbox" checked={!!editor.form.isProduction} onChange={e => setEditor(c => ({ ...c, form: { ...c.form, isProduction: e.target.checked } }))} />
                                Production (red badge on every screen)
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, cursor: editor.env && editor.env.isDefault ? 'not-allowed' : 'pointer' }}
                                title={editor.env && editor.env.isDefault ? 'Exactly one environment is the default: mark another one as default instead' : ''}>
                                <input type="checkbox" checked={!!editor.form.isDefault} disabled={!!(editor.env && editor.env.isDefault)}
                                    onChange={e => setEditor(c => ({ ...c, form: { ...c.form, isDefault: e.target.checked } }))} />
                                Default (used when a new record has no environment)
                            </label>
                        </div>
                        {editor.env && (
                            <div style={S.note}>
                                <b>Current usage</b>
                                <UsageList usage={editorUsage} />
                                {renamed && (
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontWeight: 700, color: 'var(--text-primary)', cursor: 'pointer' }}>
                                        <input type="checkbox" checked={editor.cascade} onChange={e => setEditor(c => ({ ...c, cascade: e.target.checked }))} />
                                        Also update references ({editorRefs} item{editorRefs === 1 ? '' : 's'})
                                    </label>
                                )}
                                {renamed && !editor.cascade && editorRefs > 0 && (
                                    <div style={{ marginTop: 8, color: 'var(--warning)' }}>
                                        Without this, the {editorRefs} item(s) matched by name keep the old name and will no longer match this environment.
                                    </div>
                                )}
                            </div>
                        )}
                        {editor.error && <div style={{ marginTop: 12, color: 'var(--danger)', fontSize: 13, fontWeight: 700 }}>{editor.error}</div>}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                            <button style={S.btnO} disabled={editor.saving} onClick={() => setEditor(null)}>Cancel</button>
                            <button style={S.btnP} disabled={editor.saving} onClick={save}>{editor.saving ? 'Saving...' : (editor.failed ? 'Retry updating references' : 'Save')}</button>
                        </div>
                    </div>
                </div>
            )}

            {deleting && (
                <div style={S.overlay} onClick={() => !deleting.saving && setDeleting(null)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <h3 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 900 }}>Delete Environment</h3>
                        <div style={{ fontSize: 13 }}>Delete <b>{deleting.env.name}</b>?</div>
                        <div style={S.note}>
                            <b>Usage</b>
                            <UsageList usage={delUsage} />
                            {delBlock && delUsage && <div style={{ marginTop: 10, color: 'var(--danger)', fontWeight: 700 }}>{delBlock}. Move or remove these references first.</div>}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                            <button style={S.btnO} disabled={deleting.saving} onClick={() => setDeleting(null)}>Cancel</button>
                            <button style={{ ...S.btnP, background: 'var(--danger)', opacity: delBlock || deleting.saving ? 0.5 : 1 }} disabled={!!delBlock || deleting.saving} onClick={confirmDelete}>
                                {deleting.saving ? 'Deleting...' : 'Delete'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
