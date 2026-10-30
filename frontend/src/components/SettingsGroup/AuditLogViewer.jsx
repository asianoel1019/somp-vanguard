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

const AuditLogViewer = () => {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [rawLogs, setRawLogs] = useState([]);
    const [uniqueUsers, setUniqueUsers] = useState([]);
    const [uniqueModules, setUniqueModules] = useState([]);

    // Filter states
    const [filterUser, setFilterUser] = useState('');
    const [filterModule, setFilterModule] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [searchKeyword, setSearchKeyword] = useState('');

    // Pagination states
    const [currentPage, setCurrentPage] = useState(1);
    const pageSize = 15;

    // Sorting states
    const [sortField, setSortField] = useState('timestamp');
    const [sortOrder, setSortOrder] = useState('desc'); // 'asc' | 'desc'

    useEffect(() => {
        fetchLogs();
    }, []);

    const fetchLogs = async () => {
        try {
            setLoading(true);
            const res = await api.get('/audit/logs');
            if (res.data) {
                setRawLogs(res.data.logs || []);
                setUniqueUsers(res.data.filters?.users || []);
                setUniqueModules(res.data.filters?.modules || []);
                setError(null);
            }
        } catch (err) {
            console.error('Failed to load audit logs:', err);
            setError('Failed to retrieve audit logs from backend.');
        } finally {
            setLoading(false);
        }
    };

    // Filter logic
    const filteredLogs = rawLogs.filter(log => {
        if (filterUser && log.user !== filterUser) return false;
        if (filterModule && log.module !== filterModule) return false;

        // Date range filter
        if (startDate) {
            const start = new Date(startDate);
            const logDate = new Date(log.timestamp);
            if (logDate < start) return false;
        }
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999); // include full end day
            const logDate = new Date(log.timestamp);
            if (logDate > end) return false;
        }

        // Keyword search (User, Module, or Action)
        if (searchKeyword) {
            const kw = searchKeyword.toLowerCase();
            const inUser = log.user.toLowerCase().includes(kw);
            const inModule = log.module.toLowerCase().includes(kw);
            const inAction = log.action.toLowerCase().includes(kw);
            if (!inUser && !inModule && !inAction) return false;
        }

        return true;
    });

    // Sort logic
    const sortedLogs = [...filteredLogs].sort((a, b) => {
        let valA = a[sortField];
        let valB = b[sortField];

        // Date parsing for timestamp comparison
        if (sortField === 'timestamp') {
            valA = new Date(valA);
            valB = new Date(valB);
        } else {
            valA = String(valA).toLowerCase();
            valB = String(valB).toLowerCase();
        }

        if (valA < valB) return sortOrder === 'asc' ? -1 : 1;
        if (valA > valB) return sortOrder === 'asc' ? 1 : -1;
        return 0;
    });

    // Pagination slicing
    const totalRecords = sortedLogs.length;
    const totalPages = Math.ceil(totalRecords / pageSize);
    const displayedLogs = sortedLogs.slice((currentPage - 1) * pageSize, currentPage * pageSize);

    // Adjust page if total pages decreases below current
    useEffect(() => {
        if (currentPage > totalPages && totalPages > 0) {
            setCurrentPage(totalPages);
        }
    }, [totalPages, currentPage]);

    const handleSort = (field) => {
        if (sortField === field) {
            setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortField(field);
            setSortOrder('desc'); // Default to newest/descending
        }
    };

    const handleResetFilters = () => {
        setFilterUser('');
        setFilterModule('');
        setStartDate('');
        setEndDate('');
        setSearchKeyword('');
        setCurrentPage(1);
    };

    const handleExportCSV = () => {
        if (sortedLogs.length === 0) return;

        const headers = ['Timestamp', 'User Account', 'Module', 'Action Details'];
        const csvRows = [headers.join(',')];

        sortedLogs.forEach(log => {
            const values = [
                log.timestamp,
                `"${log.user.replace(/"/g, '""')}"`,
                `"${log.module.replace(/"/g, '""')}"`,
                `"${log.action.replace(/"/g, '""')}"`
            ];
            csvRows.push(values.join(','));
        });

        const csvContent = '\uFEFF' + csvRows.join('\n'); // Add BOM for Excel UTF-8 compatibility
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `audit_logs_${new Date().toISOString().slice(0,10)}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    return (
        <div style={S.page} className="animate-fade-in">
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>Audit Log Viewer</h1>
                    <p style={S.subtitle}>Browse, search, and audit system operations and configuration changes</p>
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                    <button style={S.btnO} onClick={fetchLogs} disabled={loading}>
                        🔄 Refresh
                    </button>
                    <button style={S.btnP} onClick={handleExportCSV} disabled={loading || sortedLogs.length === 0}>
                        📥 Export CSV ({sortedLogs.length})
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
