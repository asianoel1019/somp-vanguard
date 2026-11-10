// Browse BU Hierarchy: the company / BU OUs configured in .env (AD_COMPANIES, AD_BUS_*, AD_OU_*), with the shared
// user list and the Grant action where AD_GRANT_COMPANIES allows it.
import React, { useCallback, useEffect, useState } from 'react';
import { FiRefreshCw } from 'react-icons/fi';
import api from '../../api';
import { Btn, Banner } from './Shared';
import { fieldStyle } from './adStyle';
import UserList from './UserList';

export default function ADDirectoryBrowse() {
    const [mappings, setMappings] = useState({ companies: [], grantCompanies: [] });
    const [mappingError, setMappingError] = useState(null);
    const [category, setCategory] = useState('');
    const [bu, setBu] = useState('');
    const [state, setState] = useState({ loading: false, users: null, truncatedAt: null, error: null });

    useEffect(() => {
        api.get('/ad/mappings')
            .then(r => {
                setMappings(r.data);
                if (r.data.companies && r.data.companies.length) setCategory(r.data.companies[0]);
            })
            .catch(e => setMappingError(`Could not load the BU list: ${e?.response?.data?.error || e.message}`));
    }, []);

    const loadUsers = useCallback(async (cat, b) => {
        if (!b) return;
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const r = await api.post('/ad/users', { category: cat, bu: b });
            const users = (r.data.users || []).sort((x, y) => String(x.SamAccountName).localeCompare(String(y.SamAccountName)));
            setState({ loading: false, users, truncatedAt: r.data.truncated ? r.data.limit : null, error: null });
        } catch (e) {
            setState({ loading: false, users: null, truncatedAt: null, error: e?.response?.data?.error || 'Could not load the accounts.' });
        }
    }, []);

    const chooseCompany = (cat) => { setCategory(cat); setBu(''); setState({ loading: false, users: null, truncatedAt: null, error: null }); };
    const chooseBu = (b) => { setBu(b); loadUsers(category, b); };
    const bus = mappings[category] || [];
    const canGrant = (mappings.grantCompanies || []).includes(category);

    return (
        <div className="glass-panel animate-fade-in" style={{ padding: '16px', borderRadius: '16px', border: '1px solid var(--border-color)' }}>
            {mappingError && <Banner message={{ type: 'error', text: mappingError }} />}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
                <div role="tablist" aria-label="Company" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {(mappings.companies || []).map(c => (
                        <button key={c} role="tab" aria-selected={category === c} onClick={() => chooseCompany(c)}
                            style={{ padding: '6px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer',
                                border: `1px solid ${category === c ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                                background: category === c ? 'rgba(59,130,246,0.12)' : 'transparent', color: category === c ? 'var(--accent-primary)' : 'var(--text-secondary)' }}>{c}</button>
                    ))}
                </div>
                <label style={{ fontSize: '13px', color: 'var(--text-secondary)', marginLeft: '8px' }}>BU</label>
                <select value={bu} onChange={e => chooseBu(e.target.value)} disabled={state.loading || !category} style={{ ...fieldStyle, minWidth: '200px' }}>
                    <option value="">Select a BU</option>
                    {bus.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
                {bu && <Btn icon={<FiRefreshCw />} label={state.loading ? 'Loading…' : 'Refresh'} disabled={state.loading} onClick={() => loadUsers(category, bu)} />}
            </div>

            {state.error && <Banner message={{ type: 'error', text: state.error }} />}
            {state.loading && !state.users && <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Reading accounts from Active Directory…</div>}
            {!bu && !state.loading && <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Choose a company and a BU to list its accounts.</div>}
            {state.users && (
                <>
                    <UserList users={state.users} summary={`${category} / ${bu}`} exportName={`ad-${category}-${bu}`}
                        grant={canGrant ? { label: `Grant (_Guardian_${bu})`, body: { category, bu } } : null}
                        onChanged={() => loadUsers(category, bu)} />
                    {state.truncatedAt && (
                        <div style={{ marginTop: '8px', fontSize: '12.5px', color: '#f59e0b' }}>
                            This OU has more than {state.truncatedAt} accounts: only the first {state.truncatedAt} are loaded. Use Object Search to find the others.
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
