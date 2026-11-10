// Details of one user account. "Last logon" from AD replicates late (lastLogonTimestamp, up to ~14 days behind);
// "Check exact" asks every domain controller for its own lastLogon and shows the newest.
import React, { useEffect, useState } from 'react';
import { FiLock, FiRefreshCw } from 'react-icons/fi';
import api from '../../api';
import { formatAdDate } from './adModel';
import { Modal, Btn, Pill } from './Shared';

function ExactLogon({ sam }) {
    const [state, setState] = useState(null); // null | 'loading' | { lastLogon, dc, checked, failed } | { error }
    const check = async () => {
        setState('loading');
        try {
            const r = await api.get(`/ad/user/${encodeURIComponent(sam)}/last-logon`);
            setState(r.data);
        } catch (e) {
            setState({ error: e?.response?.data?.error || 'Could not ask the domain controllers.' });
        }
    };
    if (state === null) return <Btn small icon={<FiRefreshCw />} label="Check exact" title="Ask every domain controller (can take a while)" onClick={check} />;
    if (state === 'loading') return <span style={{ color: 'var(--text-muted)' }}>Asking the domain controllers…</span>;
    if (state.error) return <span style={{ color: '#ef4444' }}>{state.error}</span>;
    return (
        <span>
            <strong>{state.lastLogon ? formatAdDate(state.lastLogon) : 'Never'}</strong>
            <span style={{ color: 'var(--text-muted)' }}>
                {state.lastLogon ? ` on ${state.dc}` : ''} · {state.checked} DC(s) checked{state.failed.length ? `, unreachable: ${state.failed.join(', ')}` : ''}
            </span>
        </span>
    );
}

export default function UserDetailsModal({ samAccountName, onClose }) {
    const [state, setState] = useState({ loading: true, user: null, error: null });

    useEffect(() => {
        let alive = true;
        api.get(`/ad/user/${encodeURIComponent(samAccountName)}`)
            .then(res => {
                if (!alive) return;
                const u = res.data.userInfo;
                setState(u && u.Name ? { loading: false, user: u, error: null } : { loading: false, user: null, error: 'No details found for this account.' });
            })
            .catch(e => { if (alive) setState({ loading: false, user: null, error: e?.response?.data?.error || 'Could not read the account.' }); });
        return () => { alive = false; };
    }, [samAccountName]);

    const u = state.user;
    const rows = u ? [
        ['Display name', u.Name],
        ['User principal name', u.UserPrincipalName],
        ['Title', u.Title],
        ['Department', u.Department],
        ['Company', u.Company],
        ['Manager', u.Manager],
        ['Email', u.EmailAddress],
        ['Description', u.Description],
        ['Status', <span key="s" style={{ display: 'inline-flex', gap: '6px' }}>
            {u.Enabled ? <Pill tone="success">Enabled</Pill> : <Pill tone="danger">Disabled</Pill>}
            {u.LockedOut ? <Pill tone="warning" icon={<FiLock />}>Locked</Pill> : <Pill>Not locked</Pill>}
        </span>],
        ['Bad logon count', u.BadLogonCount],
        ['Password last set', formatAdDate(u.PasswordLastSet)],
        ['Last logon (approx.)', <span key="l">
            {formatAdDate(u.LastLogonDate) || 'Never'}
            <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}> · replicated value, can lag up to about 14 days</span>
        </span>],
        ['Last logon (exact)', <ExactLogon key="e" sam={samAccountName} />],
        ['Account expires', formatAdDate(u.AccountExpirationDate) || 'Never'],
        ['Created', formatAdDate(u.Created)],
        ['Primary group', u.PrimaryGroup],
    ] : [];

    return (
        <Modal title={`User: ${samAccountName}`} width="680px" onClose={onClose} footer={<Btn label="Close" onClick={onClose} />}>
            {state.loading && <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Reading the account from Active Directory…</div>}
            {state.error && <div style={{ padding: '2rem', textAlign: 'center', color: '#ef4444' }}>{state.error}</div>}
            {u && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <tbody>
                        {rows.map(([k, v]) => (
                            <tr key={k} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                <td style={{ padding: '8px 10px', color: 'var(--text-secondary)', width: '32%', verticalAlign: 'top' }}>{k}</td>
                                <td style={{ padding: '8px 10px', color: 'var(--text-primary)', wordBreak: 'break-word' }}>{v === '' || v === null || v === undefined ? '—' : v}</td>
                            </tr>
                        ))}
                        <tr>
                            <td style={{ padding: '8px 10px', color: 'var(--text-secondary)', verticalAlign: 'top' }}>Member of ({(u.MemberOf || []).length})</td>
                            <td style={{ padding: '8px 10px' }}>
                                {(u.MemberOf || []).length
                                    ? <span style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>{u.MemberOf.map(g => <Pill key={g} tone="info">{g}</Pill>)}</span>
                                    : <span style={{ color: 'var(--text-muted)' }}>Only the primary group</span>}
                            </td>
                        </tr>
                    </tbody>
                </table>
            )}
        </Modal>
    );
}
