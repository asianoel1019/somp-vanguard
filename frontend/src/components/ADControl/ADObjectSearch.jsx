// AD Object Search: users, groups or computers by name (wildcards added by the server, at most 200 matches).
import React, { useState } from 'react';
import { FiSearch } from 'react-icons/fi';
import api from '../../api';
import { formatAdDate, dateColumn } from './adModel';
import { fieldStyle } from './adStyle';
import { Btn, Banner, Pill } from './Shared';
import UserList from './UserList';
import ObjectList from './ObjectList';

const TYPES = [
    { id: 'User', label: 'Users' },
    { id: 'Group', label: 'Groups' },
    { id: 'Computer', label: 'Computers' },
];

export default function ADObjectSearch() {
    const [type, setType] = useState('User');
    const [query, setQuery] = useState('');
    const [result, setResult] = useState(null); // { type, q, rows, truncated, limit }
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState(null);

    const search = async (q = query, t = type) => {
        const term = q.trim();
        if (term.length < 2 || term.includes('*')) {
            setMessage({ type: 'error', text: 'Enter at least 2 characters, without * (wildcards are added automatically).' });
            return;
        }
        setLoading(true);
        setMessage(null);
        try {
            const r = await api.post('/ad/search', { type: t, q: term });
            const rows = (r.data.results || []).sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || '')));
            setResult({ type: t, q: term, rows, truncated: r.data.truncated, limit: r.data.limit });
            if (r.data.truncated) setMessage({ type: 'info', text: `Only the first ${r.data.limit} matches are shown. Refine the search to see the rest.` });
        } catch (e) {
            setMessage({ type: 'error', text: e?.response?.data?.error || 'Search failed.' });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="glass-panel animate-fade-in" style={{ padding: '16px', borderRadius: '16px', border: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
                <select aria-label="Object type" value={type} onChange={e => { setType(e.target.value); setResult(null); }} style={{ ...fieldStyle, minWidth: '130px' }}>
                    {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                <input type="search" placeholder={`Search ${type.toLowerCase()}s by name or account`} value={query} onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') search(); }} style={{ ...fieldStyle, flex: '1 1 260px' }} />
                <Btn tone="primary" icon={<FiSearch />} label={loading ? 'Searching…' : 'Search'} disabled={loading} onClick={() => search()} />
            </div>
            <Banner message={message} onClose={() => setMessage(null)} />
            {loading && !result && <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Searching Active Directory…</div>}
            {result && result.rows.length === 0 && <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>No {result.type.toLowerCase()}s match “{result.q}”.</div>}

            {result && result.rows.length > 0 && result.type === 'User' && (
                <UserList users={result.rows} summary={`matches for “${result.q}”`} exportName={`ad-search-users-${result.q}`} onChanged={() => search(result.q, 'User')} />
            )}
            {result && result.rows.length > 0 && result.type === 'Group' && (
                <ObjectList rows={result.rows} exportName={`ad-search-groups-${result.q}`} columns={[
                    { key: 'Name', label: 'Group', render: g => <span style={{ fontWeight: 600 }}>{g.Name}</span> },
                    { key: 'SamAccountName', label: 'Account' },
                    { key: 'Members', label: 'Members', csv: g => (g.Members || []).join('; '), render: g => (
                        (g.Members || []).length
                            ? <span style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>{g.Members.map((m, i) => <Pill key={i}>{m}</Pill>)}</span>
                            : <span style={{ color: 'var(--text-muted)' }}>No members</span>
                    ) },
                ]} />
            )}
            {result && result.rows.length > 0 && result.type === 'Computer' && (
                <ObjectList rows={result.rows} exportName={`ad-search-computers-${result.q}`} columns={[
                    { key: 'Name', label: 'Computer', render: c => <span style={{ fontWeight: 600 }}>{c.Name}</span> },
                    { key: 'OperatingSystem', label: 'Operating system' },
                    { ...dateColumn('LastLogonDate', 'Last logon (approx.)'), render: c => formatAdDate(c.LastLogonDate) || 'Never' },
                    { key: 'Enabled', label: 'Status', csv: c => (c.Enabled ? 'Enabled' : 'Disabled'), render: c => (c.Enabled ? <Pill tone="success">Enabled</Pill> : <Pill tone="danger">Disabled</Pill>) },
                    { key: 'OU', label: 'Location', render: c => <span style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{c.OU}</span> },
                ]} />
            )}
        </div>
    );
}
