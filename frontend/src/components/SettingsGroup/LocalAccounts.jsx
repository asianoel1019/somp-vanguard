import React, { useEffect, useState } from 'react';
import api from '../../api';
import { useConfirm } from '../../contexts/ConfirmContext';
import { ROLE_LABELS, validatePassword, validateUsername, statusLabel, quotaText, roleFull, defaultFormRole, rowLimits, formatDateTime } from './localAccountsUtils.js';

const ROLES = ['SuperAdmin', 'Operator', 'Viewer'];
const SELF_TITLE = 'You cannot change your own account here.';
const SELF_PASSWORD_TITLE = 'Use Change password in the user menu.';
const TONE_COLOR = { success: 'var(--accent-success, #22c55e)', muted: 'var(--text-muted)', warning: 'var(--accent-warning, #f59e0b)' };
const fmtDate = formatDateTime;
const small = { padding: '6px 14px', fontSize: 12 };
const labelStyle = { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)' };
const errStyle = { fontSize: 11, color: 'var(--accent-danger, #ef4444)', marginTop: 4 };
const EMPTY_FORM = { username: '', role: 'Viewer', password: '', confirm: '' };

// RBAC -> Local Accounts: accounts that sign in without AD. Everyone can read the list; a local SuperAdmin (break-glass
// admin or a page SuperAdmin) manages it; an AD SuperAdmin only reads it (the API answers 403).
export default function LocalAccounts({ currentUser, S }) {
    const { showConfirm } = useConfirm();
    const [list, setList] = useState(null);
    const [message, setMessage] = useState(null); // { type: 'error' | 'success', text }
    const [busy, setBusy] = useState(false);
    const [form, setForm] = useState(EMPTY_FORM);
    const [reset, setReset] = useState(null); // { username, password, confirm }

    const isAdmin = currentUser?.role === 'SuperAdmin' && currentUser?.domain === 'local';
    const isAdSuperAdmin = currentUser?.role === 'SuperAdmin' && currentUser?.domain !== 'local';
    const isSelf = (name) => currentUser?.domain === 'local'
        && String(name).toLowerCase() === String(currentUser?.username || '').toLowerCase();
    const showError = (err) => setMessage({ type: 'error', text: err.response?.data?.error || err.message });

    const load = async () => {
        try {
            const res = await api.get('/local-accounts');
            setList(res.data);
        } catch (err) {
            setMessage({ type: 'error', text: err.response?.data?.error || err.message });
        }
    };
    useEffect(() => {
        api.get('/local-accounts').then(res => setList(res.data))
            .catch(err => setMessage({ type: 'error', text: err.response?.data?.error || err.message }));
    }, []);

    // Runs one API call, shows a success / error line, then reloads the list.
    const run = async (fn, okText) => {
        setBusy(true);
        setMessage(null);
        let ok = false;
        try {
            await fn();
            setMessage({ type: 'success', text: okText });
            ok = true;
        } catch (err) {
            showError(err);
        }
        await load();
        setBusy(false);
        return ok;
    };

    const breakGlassName = list?.breakGlass?.username || '';
    const nameErr = form.username ? validateUsername(form.username, breakGlassName) : '';
    const pwErr = form.password ? validatePassword(form.password) : '';
    const confirmErr = form.confirm && form.confirm !== form.password ? 'Passwords do not match.' : '';
    const formRole = defaultFormRole(list, form.role); // a full role (free edition) moves to the first one with room
    const formValid = !validateUsername(form.username, breakGlassName) && !validatePassword(form.password)
        && form.password === form.confirm && !roleFull(list, formRole);

    const add = async () => {
        const name = form.username.trim();
        const ok = await run(() => api.post('/local-accounts', { username: name, role: formRole, password: form.password }), `Account ${name} added.`);
        if (ok) setForm(EMPTY_FORM);
    };
    const update = (a, body, okText) => run(() => api.put(`/local-accounts/${encodeURIComponent(a.username)}`, body), okText);
    const remove = async (a) => {
        if (!await showConfirm(`Delete local account ${a.username}? This cannot be undone.`)) return;
        await run(() => api.delete(`/local-accounts/${encodeURIComponent(a.username)}`), `Account ${a.username} deleted.`);
    };
    const resetErr = reset ? (validatePassword(reset.password) || (reset.confirm !== reset.password ? 'Passwords do not match.' : '')) : '';
    const submitReset = async () => {
        const ok = await update({ username: reset.username }, { password: reset.password }, `Password of ${reset.username} reset.`);
        if (ok) setReset(null);
    };

    const quota = quotaText(list);
    const headers = ['Username', 'Role', 'Status', 'Created', 'Last password change', ...(isAdmin ? ['Actions'] : [])];

    return (
        <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                <h3 style={{ ...S.tblTitle, margin: 0 }}>🔑 Local Accounts</h3>
                {quota && <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>{quota}</span>}
            </div>
            <div style={{ ...S.hint, marginTop: 0, marginBottom: 12 }}>Local accounts sign in without AD. The break-glass admin in .env always works and is not listed here.</div>
            {isAdSuperAdmin && (
                <div style={{ ...S.hint, marginTop: 0, marginBottom: 12 }}>Local accounts are managed by local SuperAdmins only (the break-glass admin or a SuperAdmin created here).</div>
            )}
            {message && (
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, color: message.type === 'error' ? 'var(--accent-danger, #ef4444)' : 'var(--accent-success, #22c55e)' }}>{message.text}</div>
            )}
            {list && !list.ok && list.error && <div style={{ ...errStyle, marginBottom: 10 }}>{list.error}</div>}
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 10 }}>
                Break-glass admin (.env): <span style={{ color: 'var(--text-primary)' }}>{breakGlassName || '-'}</span>
            </div>

            <div style={{ overflowX: 'auto' }}>
                <table style={S.tbl}>
                    <thead>
                        <tr>{headers.map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                        {list && list.accounts.length === 0 && (
                            <tr><td style={{ ...S.td, color: 'var(--text-muted)' }} colSpan={headers.length}>No local accounts yet.</td></tr>
                        )}
                        {list && list.accounts.map(a => {
                            const st = statusLabel(a);
                            const self = isSelf(a.username);
                            const lim = rowLimits(list, a);
                            const enableBlocked = a.disabled ? lim.enable : '';
                            return (
                                <React.Fragment key={a.username}>
                                    <tr style={S.tr}>
                                        <td style={{ ...S.td, fontWeight: 800 }}>{a.username}</td>
                                        <td style={S.td}>{ROLE_LABELS[a.role] || a.role}</td>
                                        <td style={S.td}>
                                            <span title={st.hint} style={{ fontSize: 11, fontWeight: 800, color: TONE_COLOR[st.tone] }}>{st.text}</span>
                                        </td>
                                        <td style={S.td}>{fmtDate(a.createdAt)} · {a.createdEdition === 'paid' ? 'Paid' : 'Free'}</td>
                                        <td style={S.td}>{fmtDate(a.passwordChangedAt)}</td>
                                        {isAdmin && (
                                            <td style={S.td}>
                                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                                    <select aria-label={`Change role of ${a.username}`} value={a.role} disabled={busy || self || !!lim.locked}
                                                        style={{ ...S.select, marginTop: 0, width: 'auto', padding: '6px 10px', fontSize: 12 }}
                                                        title={self ? SELF_TITLE : (lim.locked || 'Change role')}
                                                        onChange={e => update(a, { role: e.target.value }, `Role of ${a.username} changed to ${e.target.value}.`)}>
                                                        {ROLES.map(r => {
                                                            const why = lim.roleOption(r);
                                                            return <option key={r} value={r} disabled={!!why} title={why}>{ROLE_LABELS[r]}{why && !lim.locked ? ' (limit reached)' : ''}</option>;
                                                        })}
                                                    </select>
                                                    <button type="button" style={{ ...S.btnO, ...small }} disabled={busy || self} title={self ? SELF_PASSWORD_TITLE : ''}
                                                        onClick={() => setReset({ username: a.username, password: '', confirm: '' })}>Reset password</button>
                                                    <button type="button" style={{ ...S.btnO, ...small }} disabled={busy || self || !!enableBlocked} title={self ? SELF_TITLE : enableBlocked}
                                                        onClick={() => update(a, { disabled: !a.disabled }, `Account ${a.username} ${a.disabled ? 'enabled' : 'disabled'}.`)}>
                                                        {a.disabled ? 'Enable' : 'Disable'}
                                                    </button>
                                                    <button type="button" style={{ ...S.btnO, ...small }} disabled={busy || self} title={self ? SELF_TITLE : ''}
                                                        onClick={() => remove(a)}>Delete</button>
                                                </div>
                                            </td>
                                        )}
                                    </tr>
                                    {isAdmin && reset && reset.username === a.username && (
                                        <tr style={S.tr}>
                                            <td style={S.td} colSpan={headers.length}>
                                                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                                                    <input type="password" autoComplete="new-password" placeholder="New password" style={{ ...S.input, marginTop: 0, width: 220 }}
                                                        value={reset.password} onChange={e => setReset({ ...reset, password: e.target.value })} />
                                                    <input type="password" autoComplete="new-password" placeholder="Confirm new password" style={{ ...S.input, marginTop: 0, width: 220 }}
                                                        value={reset.confirm} onChange={e => setReset({ ...reset, confirm: e.target.value })} />
                                                    <button type="button" style={{ ...S.btnP, ...small }} disabled={busy || !!resetErr} onClick={submitReset}>Set password</button>
                                                    <button type="button" style={{ ...S.btnO, ...small }} onClick={() => setReset(null)}>Cancel</button>
                                                </div>
                                                {(reset.password || reset.confirm) && resetErr && <div style={errStyle}>{resetErr}</div>}
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {isAdmin && (
                <div style={{ marginTop: 16, borderTop: '1px solid var(--border-color)', paddingTop: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>Add account</div>
                    <div style={S.gridRow}>
                        <div style={S.fieldBlock}>
                            <label style={labelStyle}>Username</label>
                            <input type="text" autoComplete="off" style={S.input} value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
                            {nameErr && <div style={errStyle}>{nameErr}</div>}
                        </div>
                        <div style={S.fieldBlock}>
                            <label style={labelStyle}>Role</label>
                            <select style={S.select} value={formRole} onChange={e => setForm({ ...form, role: e.target.value })}>
                                {ROLES.map(r => {
                                    const full = roleFull(list, r);
                                    return <option key={r} value={r} disabled={full}>{ROLE_LABELS[r]}{full ? ' (limit reached)' : ''}</option>;
                                })}
                            </select>
                        </div>
                    </div>
                    <div style={S.gridRow}>
                        <div style={S.fieldBlock}>
                            <label style={labelStyle}>Password</label>
                            <input type="password" autoComplete="new-password" style={S.input} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
                            {pwErr && <div style={errStyle}>{pwErr}</div>}
                        </div>
                        <div style={S.fieldBlock}>
                            <label style={labelStyle}>Confirm password</label>
                            <input type="password" autoComplete="new-password" style={S.input} value={form.confirm} onChange={e => setForm({ ...form, confirm: e.target.value })} />
                            {confirmErr && <div style={errStyle}>{confirmErr}</div>}
                        </div>
                    </div>
                    <button type="button" style={{ ...S.btnP, opacity: busy || !formValid ? 0.5 : 1 }} disabled={busy || !formValid} onClick={add}>Add account</button>
                </div>
            )}
        </div>
    );
}
