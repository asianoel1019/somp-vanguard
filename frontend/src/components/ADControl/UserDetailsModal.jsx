import React, { useState, useEffect } from 'react';
import api from '../../api';

const formatDate = (val) => {
    if (!val) return 'N/A';
    if (typeof val === 'string' && val.includes('/Date(')) {
        const m = val.match(/\d+/);
        if (m) return new Date(parseInt(m[0])).toLocaleString();
    }
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d.toLocaleString();
    return String(val);
};

export default function UserDetailsModal({ samAccountName, onClose }) {
    const [userDetails, setUserDetails] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        let isMounted = true;
        const fetchDetails = async () => {
            try {
                const res = await api.get(`/ad/user/${samAccountName}`);
                if (isMounted) {
                    if (res.data.userInfo && res.data.userInfo.Name) {
                        setUserDetails(res.data.userInfo);
                    } else {
                        setError('No detailed info found for this user.');
                    }
                    setLoading(false);
                }
            } catch (err) {
                if (isMounted) {
                    setError('Failed to fetch user details');
                    setLoading(false);
                }
            }
        };
        fetchDetails();
        return () => { isMounted = false; };
    }, [samAccountName]);

    return (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(4px)' }}>
            <div className="glass-panel animate-fade-in" style={{ width: '100%', maxWidth: '650px', background: 'var(--bg-primary)', borderRadius: '16px', border: '1px solid var(--border-color)', overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)' }}>
                <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-secondary)' }}>
                    <h3 style={{ margin: 0, fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        👤 User Information: <span style={{ color: 'var(--accent-primary)', fontFamily: 'monospace' }}>{samAccountName}</span>
                    </h3>
                    <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '24px', cursor: 'pointer' }}>&times;</button>
                </div>
                <div style={{ padding: '24px', maxHeight: '70vh', overflowY: 'auto' }}>
                    {loading ? (
                        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>⏳ Loading details from Active Directory...</div>
                    ) : error ? (
                        <div style={{ textAlign: 'center', padding: '40px', color: '#ef4444' }}>❌ {error}</div>
                    ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                            <tbody>
                                {[
                                    ['Display Name', userDetails.Name],
                                    ['User Principal Name', userDetails.UserPrincipalName],
                                    ['Title', userDetails.Title],
                                    ['Department', userDetails.Department],
                                    ['Company', userDetails.Company],
                                    ['Manager', userDetails.Manager],
                                    ['Email', userDetails.EmailAddress],
                                    ['Description', userDetails.Description],
                                    ['Account Status', userDetails.Enabled ? '✅ Enabled' : '🚫 Disabled'],
                                    ['Lockout Status', userDetails.LockedOut ? '🔒 Locked' : '🔓 Unlocked'],
                                    ['Bad Logon Count', userDetails.BadLogonCount],
                                    ['Password Last Set', formatDate(userDetails.PasswordLastSet)],
                                    ['Last Logon', formatDate(userDetails.LastLogonDate)],
                                    ['Account Expires', formatDate(userDetails.AccountExpirationDate)],
                                    ['Created At', formatDate(userDetails.Created)],
                                ].map(([key, val], idx) => (
                                    <tr key={key} style={{ borderBottom: '1px solid var(--border-color)', background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                                        <td style={{ padding: '12px 16px', fontWeight: 600, color: 'var(--text-secondary)', width: '35%' }}>{key}</td>
                                        <td style={{ padding: '12px 16px', color: 'var(--text-primary)', wordBreak: 'break-word' }}>{val || '—'}</td>
                                    </tr>
                                ))}
                                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <td style={{ padding: '12px 16px', fontWeight: 600, color: 'var(--text-secondary)', width: '35%', verticalAlign: 'top' }}>Group Memberships</td>
                                    <td style={{ padding: '12px 16px', color: 'var(--text-primary)' }}>
                                        {userDetails.MemberOf && userDetails.MemberOf.length > 0 ? (
                                            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                                                {userDetails.MemberOf.map((g, i) => <span key={i} style={{ display: 'inline-block', padding: '3px 8px', borderRadius: '4px', background: 'rgba(59,130,246,0.1)', color: 'var(--accent-primary)', fontSize: '12px', border: '1px solid rgba(59,130,246,0.2)' }}>{g}</span>)}
                                            </div>
                                        ) : '—'}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    )}
                </div>
                <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border-color)', background: 'var(--bg-secondary)', textAlign: 'right' }}>
                    <button onClick={onClose} style={{ padding: '8px 24px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>Close</button>
                </div>
            </div>
        </div>
    );
}
