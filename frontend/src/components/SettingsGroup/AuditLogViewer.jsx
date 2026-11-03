import React, { useState, useEffect } from 'react';
import api from '../../api';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    card: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24, marginBottom: 20 },
    filterRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20 },
    input: { width: '100%', borderRadius: 12, padding: '10px 14px', fontSize: 13, fontWeight: 600, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' },
    select: { width: '100%', borderRadius: 12, padding: '10px 14px', fontSize: 13, fontWeight: 600, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box', cursor: 'pointer' },
    btnP: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 24px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)', transition: 'transform 0.1s' },
    btnO: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer', transition: 'background 0.2s' },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden' },
    tbl: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)', cursor: 'pointer', userSelect: 'none' },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' },
    td: { padding: '14px 24px', verticalAlign: 'middle' },
    paginationRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, padding: '0 8px' },
    badge: { display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 700, background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }
};

// The server filters, sorts and pages (it reads only the audit files of the chosen days, archive included)
const PAGE_SIZE = 15;

const AuditLogViewer = () => {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [displayedLogs, setDisplayedLogs] = useState([]);
    const [totalRecords, setTotalRecords] = useState(0);
    const [uniqueUsers, setUniqueUsers] = useState([]);
    const [uniqueModules, setUniqueModules] = useState([]);
    const [range, setRange] = useState(null);
    const [exporting, setExporting] = useState(false);

    // Filter states
    const [filterUser, setFilterUser] = useState('');
    const [filterModule, setFilterModule] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [searchKeyword, setSearchKeyword] = useState('');
    // the keyword is sent once typing pauses, not on every key stroke
    const [appliedKeyword, setAppliedKeyword] = useState('');

    // Pagination states
    const [currentPage, setCurrentPage] = useState(1);
    const pageSize = PAGE_SIZE;

    // Sorting states
    const [sortField, setSortField] = useState('timestamp');
    const [sortOrder, setSortOrder] = useState('desc'); // 'asc' | 'desc'

    useEffect(() => {
        const t = setTimeout(() => setAppliedKeyword(searchKeyword), 400);
        return () => clearTimeout(t);
    }, [searchKeyword]);

    const queryParams = () => ({
        from: startDate || undefined,
        to: endDate || undefined,
        user: filterUser || undefined,
        module: filterModule || undefined,
        q: appliedKeyword || undefined,
        sort: sortField,
        order: sortOrder
    });

    const fetchLogs = async () => {
        try {
            setLoading(true);
            const res = await api.get('/audit/logs', { params: { ...queryParams(), page: currentPage, limit: pageSize } });
            if (res.data) {
                setDisplayedLogs(res.data.logs || []);
                setTotalRecords(res.data.total || 0);
                setUniqueUsers(res.data.filters?.users || []);
                setUniqueModules(res.data.filters?.modules || []);
                setRange(res.data.range || null);
                if (res.data.page && res.data.page !== currentPage) setCurrentPage(res.data.page);
                setError(null);
            }
        } catch (err) {
            console.error('Failed to load audit logs:', err);
            setError('Failed to retrieve audit logs from backend.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchLogs();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filterUser, filterModule, startDate, endDate, appliedKeyword, sortField, sortOrder, currentPage]);

    const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));

    const handleSort = (field) => {
        if (sortField === field) {
            setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortField(field);
            setSortOrder('desc'); // Default to newest/descending
        }
        setCurrentPage(1);
    };

    const handleResetFilters = () => {
        setFilterUser('');
        setFilterModule('');
        setStartDate('');
        setEndDate('');
        setSearchKeyword('');
        setAppliedKeyword('');
        setCurrentPage(1);
    };

    // The server builds the file from every matching entry (not just this page) and protects cells from formula injection
    const handleExportCSV = async () => {
        if (totalRecords === 0) return;
        setExporting(true);
        try {
            const res = await api.get('/audit/logs', { params: { ...queryParams(), format: 'csv' }, responseType: 'blob' });
            const url = URL.createObjectURL(res.data);
            const link = document.createElement('a');
            link.setAttribute('href', url);
            link.setAttribute('download', `audit_logs_${range?.from || ''}_${range?.to || new Date().toISOString().slice(0, 10)}.csv`);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Failed to export audit logs:', err);
            setError('Failed to export audit logs.');
        } finally {
            setExporting(false);
        }
    };

    return (
        <div style={S.page} className="animate-fade-in">
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>Audit Log Viewer</h1>
                    <p style={S.subtitle}>Browse, search, and audit system operations and configuration changes</p>
                    {range && (
                        <p style={{ ...S.subtitle, marginTop: 4 }}>
                            顯示 {range.from} 至 {range.to}（未選日期時預設最近 30 天）· 最早可查到 {range.earliestDay || '-'} · 稽核紀錄保留 {range.retentionDays} 天（AUDIT_LOG_RETENTION_DAYS）
                        </p>
                    )}
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                    <button style={S.btnO} onClick={fetchLogs} disabled={loading}>
                        🔄 Refresh
                    </button>
                    <button style={S.btnP} onClick={handleExportCSV} disabled={loading || exporting || totalRecords === 0}>
                        {exporting ? 'Exporting…' : `📥 Export CSV (${totalRecords})`}
                    </button>
                </div>
            </div>

            {error && <div className="error-message mb-4">{error}</div>}

            {/* Filter controls */}
            <div style={S.card}>
                <div style={S.filterRow}>
                    <div>
                        <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>FILTER BY USER</label>
                        <select style={S.select} value={filterUser} onChange={e => { setFilterUser(e.target.value); setCurrentPage(1); }}>
                            <option value="">All Users</option>
                            {uniqueUsers.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                    </div>
                    <div>
                        <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>FILTER BY MODULE</label>
                        <select style={S.select} value={filterModule} onChange={e => { setFilterModule(e.target.value); setCurrentPage(1); }}>
                            <option value="">All Modules</option>
                            {uniqueModules.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                    </div>
                    <div>
                        <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>START DATE</label>
                        <input type="date" style={S.input} value={startDate} onChange={e => { setStartDate(e.target.value); setCurrentPage(1); }} />
                    </div>
                    <div>
                        <label style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>END DATE</label>
                        <input type="date" style={S.input} value={endDate} onChange={e => { setEndDate(e.target.value); setCurrentPage(1); }} />
                    </div>
                </div>

                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                    <div style={{ flex: 1, position: 'relative' }}>
                        <input 
                            type="text" 
                            style={S.input} 
                            placeholder="Search actions or keyword..." 
                            value={searchKeyword} 
                            onChange={e => { setSearchKeyword(e.target.value); setCurrentPage(1); }} 
                        />
                        {searchKeyword && (
                            <button onClick={() => setSearchKeyword('')} style={{ position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14 }}>✕</button>
                        )}
                    </div>
                    <button style={{ ...S.btnO, padding: '10px 20px', borderRadius: 12 }} onClick={handleResetFilters}>
                        Reset Filters
                    </button>
                </div>
            </div>

            {/* Logs Table */}
            {loading ? (
                <div style={{ textAlign: 'center', padding: 100 }}><span className="animate-pulse">Loading logs database...</span></div>
            ) : (
                <>
                    <div style={S.tblWrap}>
                        <table style={S.tbl}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid var(--border-color)' }}>
                                    <th style={{ ...S.th, width: '22%' }} onClick={() => handleSort('timestamp')}>
                                        TIMESTAMP {sortField === 'timestamp' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                                    </th>
                                    <th style={{ ...S.th, width: '18%' }} onClick={() => handleSort('user')}>
                                        USER ACCOUNT {sortField === 'user' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                                    </th>
                                    <th style={{ ...S.th, width: '18%' }} onClick={() => handleSort('module')}>
                                        MODULE {sortField === 'module' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                                    </th>
                                    <th style={{ ...S.th, width: '42%' }} onClick={() => handleSort('action')}>
                                        ACTION DETAILS {sortField === 'action' ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {displayedLogs.map((log, index) => (
                                    <tr key={index} style={S.tr}>
                                        <td style={{ ...S.td, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                                            {new Date(log.timestamp).toLocaleString()}
                                        </td>
                                        <td style={{ ...S.td, fontWeight: 700 }}>
                                            {log.user}
                                        </td>
                                        <td style={S.td}>
                                            <span style={S.badge}>{log.module}</span>
                                        </td>
                                        <td style={{ ...S.td, color: 'var(--text-secondary)' }}>
                                            {log.action}
                                        </td>
                                    </tr>
                                ))}
                                {totalRecords === 0 && (
                                    <tr>
                                        <td colSpan="4" style={{ ...S.td, textAlign: 'center', color: 'var(--text-muted)', padding: 48 }}>
                                            No audit logs matched the filters.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div style={S.paginationRow}>
                            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                Showing {((currentPage - 1) * pageSize) + 1} to {Math.min(currentPage * pageSize, totalRecords)} of {totalRecords} records
                            </span>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button 
                                    style={{ ...S.btnO, padding: '6px 16px', fontSize: 12 }} 
                                    onClick={() => setCurrentPage(p => Math.max(p - 1, 1))}
                                    disabled={currentPage === 1}
                                >
                                    Previous
                                </button>
                                <span style={{ display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 700, padding: '0 8px' }}>
                                    Page {currentPage} of {totalPages}
                                </span>
                                <button 
                                    style={{ ...S.btnO, padding: '6px 16px', fontSize: 12 }} 
                                    onClick={() => setCurrentPage(p => Math.min(p + 1, totalPages))}
                                    disabled={currentPage === totalPages}
                                >
                                    Next
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default AuditLogViewer;
