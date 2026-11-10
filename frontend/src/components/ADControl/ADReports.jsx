// Maintenance reports: locked accounts, accounts not signed in for N days, passwords expiring within N days.
// The lists use the shared user list, so accounts can be unlocked / disabled from here, one or many at a time.
import React, { useState } from 'react';
import { FiPlay } from 'react-icons/fi';
import api from '../../api';
import { dateColumn, formatAdDate } from './adModel';
import { fieldStyle } from './adStyle';
import { Btn, Banner, Pill } from './Shared';
import UserList from './UserList';

const REPORTS = [
    { id: 'locked', label: 'Locked accounts', days: null, help: 'Accounts locked out now.' },
    { id: 'inactive', label: 'Inactive accounts', days: 90, help: 'Accounts with no sign-in for this many days (from lastLogonTimestamp, which can lag up to about 14 days), or never.' },
    { id: 'pwdExpiring', label: 'Passwords expiring', days: 14, help: 'Enabled accounts whose password expires within this many days, or has expired (accounts whose password never expires are left out).' },
];

export default function ADReports() {
    const [type, setType] = useState('locked');
    const [days, setDays] = useState({ inactive: 90, pwdExpiring: 14 });
    const [result, setResult] = useState(null); // { type, days, rows, truncated, limit }
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const spec = REPORTS.find(r => r.id === type);

    const run = async (t = type) => {
        setLoading(true);
        setError(null);
        try {
            const params = { type: t };
            if (t !== 'locked') params.days = days[t];
            const r = await api.get('/ad/report', { params });
            setResult(r.data);
        } catch (e) {
            setError(e?.response?.data?.error || 'The report could not run.');
        } finally {
            setLoading(false);
        }
    };

    const extra = [];
    if (result && result.type === 'pwdExpiring') {
        extra.push({ ...dateColumn('PasswordExpires', 'Password expires'), render: u => (
            <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                {formatAdDate(u.PasswordExpires)}{new Date(u.PasswordExpires) < new Date() && <Pill tone="danger">Expired</Pill>}
            </span>
        ) });
    }
    if (result) extra.push({ ...dateColumn('LastLogonDate', 'Last logon (approx.)'), render: u => formatAdDate(u.LastLogonDate) || 'Never' });

    return (
        <div className="glass-panel animate-fade-in" style={{ padding: '16px', borderRadius: '16px', border: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '6px' }}>
                <select aria-label="Report" value={type} onChange={e => { setType(e.target.value); setResult(null); }} style={{ ...fieldStyle, minWidth: '200px' }}>
                    {REPORTS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
                {spec.days !== null && (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--text-secondary)' }}>
                        Days
                        <input type="number" min={1} max={3650} value={days[type]} onChange={e => setDays(d => ({ ...d, [type]: Math.max(1, Math.min(3650, parseInt(e.target.value, 10) || 1)) }))}
                            style={{ ...fieldStyle, width: '90px' }} />
                    </label>
                )}
                <Btn tone="primary" icon={<FiPlay />} label={loading ? 'Running…' : 'Run report'} disabled={loading} onClick={() => run()} />
            </div>
            <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginBottom: '12px' }}>{spec.help} Limited to AD_OU_SEARCH when it is set; at most 2000 accounts.</div>
            {error && <Banner message={{ type: 'error', text: error }} />}
            {loading && !result && <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Running the report…</div>}
            {result && (
                <>
                    {result.truncated && <div style={{ fontSize: '12.5px', color: '#f59e0b', marginBottom: '8px' }}>More than {result.limit} accounts match: only the first {result.limit} are listed.</div>}
                    <UserList users={result.rows} extraColumns={extra} onChanged={() => run(result.type)}
                        summary={REPORTS.find(r => r.id === result.type).label + (result.days ? ` (${result.days} days)` : '')}
                        exportName={`ad-report-${result.type}${result.days ? `-${result.days}d` : ''}`} />
                </>
            )}
        </div>
    );
}
