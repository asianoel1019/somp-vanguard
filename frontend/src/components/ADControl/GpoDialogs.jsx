// Dialogs of the GPMC-style Group Policy page: a name (New GPO / Rename / Copy), the comment, deleting a GPO,
// adding a user or group (security filtering / delegation) and the backups of a folder with restore.
import React, { useEffect, useState } from 'react';
import api from '../../api';
import { validGpoName, TRUSTEE_RE, DELEGATION_LEVELS, PERMISSION_LABELS, formatDate } from './gpmcModel';
import { C } from './gpmcStyle';

const field = { width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.05)', border: C.border, color: 'var(--text-primary)', borderRadius: '6px', fontSize: '13px' };
const label = { display: 'block', fontSize: '12px', color: C.secondary, margin: '12px 0 4px' };
const btn = { padding: '6px 16px', borderRadius: '8px', border: C.border, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '13px' };
const primary = (enabled, danger) => ({ ...btn, border: 'none', background: danger ? '#ef4444' : 'var(--accent-primary)', color: 'white', fontWeight: 700, opacity: enabled ? 1 : 0.5, cursor: enabled ? 'pointer' : 'default' });
const hint = { fontSize: '12px', color: '#ef4444', marginTop: '4px' };

function Shell({ title, children, width = '460px' }) {
    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div role="dialog" aria-label={title} style={{ background: 'var(--bg-secondary)', border: C.border, borderRadius: '16px', padding: '1.6rem', maxWidth: width, width: '92%', boxShadow: 'var(--shadow-lg)', maxHeight: '90vh', overflowY: 'auto' }}>
                <h3 style={{ marginTop: 0, marginBottom: '6px', color: 'var(--text-primary)' }}>{title}</h3>
                {children}
            </div>
        </div>
    );
}

function Buttons({ onCancel, okLabel, okEnabled, onOk, danger }) {
    return (
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '1.2rem' }}>
            <button style={btn} onClick={onCancel}>Cancel</button>
            <button style={primary(okEnabled, danger)} disabled={!okEnabled} onClick={onOk}>{okLabel}</button>
        </div>
    );
}

/**
 * New GPO / Rename / Copy: a GPO name, with an optional comment (New) or "copy the permissions" box (Copy).
 * onOk({ name, comment, copyAcl })
 */
export function NameDialog({ title, intro, initialName = '', requireChange, withComment, withCopyAcl, okLabel = 'OK', onCancel, onOk }) {
    const [name, setName] = useState(initialName);
    const [comment, setComment] = useState('');
    const [copyAcl, setCopyAcl] = useState(false);
    const ok = validGpoName(name) && (!requireChange || name.trim() !== initialName.trim());
    return (
        <Shell title={title}>
            {intro && <div style={{ fontSize: '12.5px', color: C.secondary }}>{intro}</div>}
            <label style={label}>Name</label>
            <input type="text" autoFocus value={name} maxLength={255} onChange={e => setName(e.target.value)} style={field}
                onKeyDown={e => { if (e.key === 'Enter' && ok) onOk({ name: name.trim(), comment, copyAcl }); }} />
            {withComment && (
                <>
                    <label style={label}>Comment (optional)</label>
                    <textarea value={comment} maxLength={2048} rows={3} onChange={e => setComment(e.target.value)} style={{ ...field, resize: 'vertical' }} />
                </>
            )}
            {withCopyAcl && (
                <label style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12.5px', color: 'var(--text-primary)', marginTop: '12px' }}>
                    <input type="checkbox" checked={copyAcl} onChange={e => setCopyAcl(e.target.checked)} />
                    Preserve the existing permissions (otherwise the copy gets default permissions)
                </label>
            )}
            <Buttons onCancel={onCancel} okLabel={okLabel} okEnabled={ok} onOk={() => onOk({ name: name.trim(), comment, copyAcl })} />
        </Shell>
    );
}

export function CommentDialog({ gpoName, initial, onCancel, onOk }) {
    const [comment, setComment] = useState(initial || '');
    return (
        <Shell title="GPO comment">
            <div style={{ fontSize: '12.5px', color: C.secondary }}>{gpoName}</div>
            <textarea autoFocus value={comment} maxLength={2048} rows={5} onChange={e => setComment(e.target.value)} style={{ ...field, resize: 'vertical', marginTop: '12px' }} />
            <Buttons onCancel={onCancel} okLabel="Save" okEnabled={comment !== (initial || '')} onOk={() => onOk(comment)} />
        </Shell>
    );
}

/** Delete a GPO: the name has to be typed again. */
export function DeleteGpoDialog({ gpo, linkCount, onCancel, onOk }) {
    const [typed, setTyped] = useState('');
    return (
        <Shell title="Delete GPO">
            <div style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.6 }}>
                Delete <strong>{gpo.name}</strong> and {linkCount === 1 ? 'its link' : `all ${linkCount} of its links`} in this domain?
                This cannot be undone; restoring needs a backup.
            </div>
            <label style={label}>Type the GPO name to confirm</label>
            <input type="text" autoFocus value={typed} onChange={e => setTyped(e.target.value)} style={field} />
            <Buttons onCancel={onCancel} okLabel="Delete GPO" danger okEnabled={typed === gpo.name} onOk={onOk} />
        </Shell>
    );
}

/**
 * Add a user, group or computer: Security Filtering (Apply) or Delegation (with a permission level).
 * onOk({ trustee, trusteeType, permission })
 */
export function TrusteeDialog({ title, intro, withPermission, initial, onCancel, onOk }) {
    // initial: an existing delegation row ({ trustee, trusteeType, permission }) whose permission is being changed
    const [trustee, setTrustee] = useState(initial ? initial.trustee : '');
    const [trusteeType, setTrusteeType] = useState(initial ? initial.trusteeType : 'Group');
    const [permission, setPermission] = useState(initial && DELEGATION_LEVELS.includes(initial.permission) ? initial.permission : 'GpoRead');
    const valid = TRUSTEE_RE.test(trustee.trim());
    return (
        <Shell title={title}>
            {intro && <div style={{ fontSize: '12.5px', color: C.secondary }}>{intro}</div>}
            <label style={label}>Name (account or group, optionally DOMAIN\name)</label>
            <input type="text" autoFocus={!initial} readOnly={!!initial} value={trustee} onChange={e => setTrustee(e.target.value)} placeholder="Kiosk Computers" style={field} />
            {trustee && !valid && <div style={hint}>Use an account or group name without " / [ ] : ; | = , + * ? &lt; &gt;</div>}
            <label style={label}>Object type</label>
            <select value={trusteeType} disabled={!!initial} onChange={e => setTrusteeType(e.target.value)} style={field}>
                <option value="Group">Group</option>
                <option value="User">User</option>
                <option value="Computer">Computer</option>
            </select>
            {withPermission && (
                <>
                    <label style={label}>Permissions</label>
                    <select value={permission} onChange={e => setPermission(e.target.value)} style={field}>
                        {DELEGATION_LEVELS.map(l => <option key={l} value={l}>{PERMISSION_LABELS[l]}</option>)}
                    </select>
                </>
            )}
            <Buttons onCancel={onCancel} okLabel="OK" okEnabled={valid} onOk={() => onOk({ trustee: trustee.trim(), trusteeType, permission })} />
        </Shell>
    );
}

/** Manage Backups: list the GPO backups of a folder and restore one. onRestore(backup, path) */
export function BackupsDialog({ initialPath, gpoExists, onClose, onRestore }) {
    const [path, setPath] = useState(initialPath || '');
    const [state, setState] = useState({ loading: true, path: null, backups: [], error: null });
    const [reload, setReload] = useState(0);
    const [query, setQuery] = useState(initialPath || '');

    useEffect(() => {
        let alive = true;
        api.get('/gpo/backups', { params: query ? { path: query } : {} })
            .then(r => { if (alive) setState({ loading: false, path: r.data.path, backups: r.data.backups || [], truncated: r.data.truncated, error: null }); })
            .catch(e => { if (alive) setState({ loading: false, path: null, backups: [], error: e?.response?.data?.error || 'Could not read the backups.' }); });
        return () => { alive = false; };
    }, [query, reload]);

    return (
        <Shell title="Manage Backups" width="760px">
            <label style={label}>Backup location on the domain controller or a share</label>
            <div style={{ display: 'flex', gap: '8px' }}>
                <input type="text" value={path} onChange={e => setPath(e.target.value)} placeholder="C:\GPO_Backups (default)" style={field}
                    onKeyDown={e => { if (e.key === 'Enter') { setState(s => ({ ...s, loading: true })); setQuery(path.trim()); setReload(n => n + 1); } }} />
                <button style={btn} onClick={() => { setState(s => ({ ...s, loading: true })); setQuery(path.trim()); setReload(n => n + 1); }}>Show</button>
            </div>
            <div style={{ marginTop: '12px', border: C.border, borderRadius: '8px', maxHeight: '45vh', overflowY: 'auto' }}>
                {state.loading ? <div style={{ padding: '12px', fontSize: '12.5px', color: C.muted }}>Reading backups…</div>
                    : state.error ? <div style={{ padding: '12px', fontSize: '12.5px', color: '#ef4444' }}>{state.error}</div>
                        : state.backups.length === 0 ? <div style={{ padding: '12px', fontSize: '12.5px', color: C.muted }}>No GPO backups in {state.path}.</div>
                            : (
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
                                    <thead>
                                        <tr>{['GPO', 'Time stamp', 'Comment', ''].map(h => <th key={h} style={{ textAlign: 'left', padding: '7px 10px', color: C.secondary, borderBottom: C.border, fontWeight: 600 }}>{h}</th>)}</tr>
                                    </thead>
                                    <tbody>
                                        {state.backups.map(b => (
                                            <tr key={b.id} style={{ borderTop: C.border }}>
                                                <td style={{ padding: '7px 10px', color: 'var(--text-primary)' }}>{b.name}{!gpoExists(b.gpoId) && <span style={{ color: C.muted }}> (deleted)</span>}</td>
                                                <td style={{ padding: '7px 10px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{formatDate(b.time)}</td>
                                                <td style={{ padding: '7px 10px', color: C.secondary }}>{b.comment}</td>
                                                <td style={{ padding: '7px 10px', textAlign: 'right' }}>
                                                    <button style={{ ...btn, padding: '3px 10px', fontSize: '12px' }} onClick={() => onRestore(b, state.path)}>Restore</button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
            </div>
            {state.truncated && <div style={{ fontSize: '12px', color: '#f59e0b', marginTop: '6px' }}>Only the newest 500 backups are listed.</div>}
            <div style={{ fontSize: '12px', color: C.muted, marginTop: '8px' }}>
                Restoring overwrites the GPO's settings with the backup. A GPO that no longer exists is created again under its backed-up name, with a new id and no links.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
                <button style={btn} onClick={onClose}>Close</button>
            </div>
        </Shell>
    );
}
