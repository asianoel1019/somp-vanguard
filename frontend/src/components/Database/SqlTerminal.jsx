import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%', display: 'flex', flexDirection: 'column' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnO: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
    select: { padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-glass)', color: 'var(--text-primary)', outline: 'none', minWidth: 200 },
    editorContainer: { display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20, marginBottom: 20 },
    editorWrap: { background: '#0f172a', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' },
    editorHeader: { background: 'var(--bg-glass)', padding: '12px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    textareaWrap: { position: 'relative', flex: 1, minHeight: 180 },
    textarea: { width: '100%', height: '100%', minHeight: 180, background: 'transparent', border: 'none', color: 'transparent', caretColor: '#e2e8f0', fontFamily: 'monospace', fontSize: 14, padding: '16px 20px', outline: 'none', resize: 'vertical', position: 'absolute', top: 0, left: 0, zIndex: 2, boxSizing: 'border-box', whiteSpace: 'pre', overflow: 'auto' },
    highlightOverlay: { width: '100%', height: '100%', minHeight: 180, fontFamily: 'monospace', fontSize: 14, padding: '16px 20px', position: 'absolute', top: 0, left: 0, zIndex: 1, boxSizing: 'border-box', whiteSpace: 'pre', overflow: 'hidden', pointerEvents: 'none', color: '#94a3b8' },
    sidebar: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' },
    sidebarTitle: { fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', marginBottom: 12, display: 'block' },
    historyList: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 180 },
    historyItem: { padding: '8px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 11, fontFamily: 'monospace', color: 'var(--text-secondary)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' },
    resultWrap: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 12, overflow: 'auto', minHeight: 300 },
    tbl: { width: '100%', borderCollapse: 'collapse', whiteSpace: 'nowrap' },
    th: { textAlign: 'left', padding: '12px 16px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.2)', position: 'sticky', top: 0 },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' },
    td: { padding: '12px 16px', fontSize: 12, fontFamily: 'monospace' },
    errorBox: { padding: 16, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8, color: '#ef4444', margin: 20, fontSize: 13, fontWeight: 600 },
    metaBar: { display: 'flex', gap: 16, padding: '10px 20px', background: 'rgba(0,0,0,0.15)', borderBottom: '1px solid var(--border-color)', fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600 }
};

const SqlTerminal = () => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';

    const [databases, setDatabases] = useState([]);
    const [selectedDb, setSelectedDb] = useState('');
    const [query, setQuery] = useState('SELECT * FROM information_schema.tables LIMIT 10;');
    const [results, setResults] = useState(null);
    const [error, setError] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    
    // Performance & Stats
    const [stats, setStats] = useState({ count: 0, duration: 0 });

    // Pagination
    const [currentPage, setCurrentPage] = useState(1);
    const ROWS_PER_PAGE = 100;

    // History state
    const [history, setHistory] = useState([]);

    // Schema Explorer state
    const [showSchema, setShowSchema] = useState(true);
    const [schemaData, setSchemaData] = useState({});
    const [loadingSchema, setLoadingSchema] = useState(false);
    const [schemaFilter, setSchemaFilter] = useState('');
    const [expandedTables, setExpandedTables] = useState({});

    // AI SQL Advisor state
    const [showAiModal, setShowAiModal] = useState(false);
    const [aiLoading, setAiLoading] = useState(false);
    const [aiAnalysis, setAiAnalysis] = useState('');
    const [aiModelInfo, setAiModelInfo] = useState('');
    const [aiWarning, setAiWarning] = useState('');

    // Data Masking state
    const [showRaw, setShowRaw] = useState(false);
    const [isMasked, setIsMasked] = useState(false);
    const [maskedColumns, setMaskedColumns] = useState([]);
    const [canUnmask, setCanUnmask] = useState(false);

    const textareaRef = useRef(null);
    const overlayRef = useRef(null);

    const loadSchema = async (dbId) => {
        if (!dbId) return;
        setLoadingSchema(true);
        try {
            const res = await api.get(`/database/schema/${dbId}`);
            setSchemaData(res.data.schema || {});
        } catch (e) {
            console.error('Failed to load schema:', e);
            setSchemaData({});
        } finally {
            setLoadingSchema(false);
        }
    };

    useEffect(() => {
        const loadDatabases = async () => {
            try {
                const res = await api.get('/database/inventory');
                const list = res.data.databases || [];
                setDatabases(list);
                if (list.length > 0) {
                    setSelectedDb(list[0].id);
                    loadSchema(list[0].id);
                }
            } catch (e) { console.error('Failed to load DBs:', e); }
        };

        const loadHistory = () => {
            try {
                const raw = localStorage.getItem('sql_query_history');
                if (!raw) {
                    setHistory([]);
                    return;
                }
                let saved = [];
                try {
                    saved = JSON.parse(decodeURIComponent(atob(raw)));
                } catch (e) {
                    saved = JSON.parse(raw);
                }
                setHistory(saved);
            } catch (e) { console.error(e); }
        };

        loadDatabases();
        loadHistory();
    }, []);

    const handleDbChange = (newDbId) => {
        setSelectedDb(newDbId);
        loadSchema(newDbId);
    };

    const toggleTableExpand = (tbl) => {
        setExpandedTables(prev => ({ ...prev, [tbl]: !prev[tbl] }));
    };

    const handleAskAiAdvisor = async () => {
        if (!query.trim()) {
            setError('Please write a SQL query before asking AI Advisor.');
            return;
        }
        setShowAiModal(true);
        setAiLoading(true);
        setAiAnalysis('');
        setAiWarning('');
        try {
            const res = await api.post('/database/ai-explain', { id: selectedDb, query });
            setAiAnalysis(res.data.analysis || '');
            setAiWarning(res.data.warning || '');
            if (res.data.model) {
                setAiModelInfo(`${res.data.provider || 'AI'} (${res.data.model})`);
            } else {
                setAiModelInfo('');
            }
        } catch (e) {
            setAiAnalysis(`❌ AI 分析失敗: ${e.response?.data?.error || e.message}`);
        } finally {
            setAiLoading(false);
        }
    };

    const saveQueryToHistory = (newQuery) => {
        if (!newQuery.trim()) return;
        
        const sensitiveRegex = /(password|key|secret|token|pwd|credential|auth)\s*(=|LIKE|IN)/i;
        if (sensitiveRegex.test(newQuery)) {
            console.warn('Skipping history save for potentially sensitive query');
            return;
        }

        const filtered = history.filter(q => q.trim() !== newQuery.trim());
        const updated = [newQuery, ...filtered].slice(0, 20);
        setHistory(updated);
        localStorage.setItem('sql_query_history', btoa(encodeURIComponent(JSON.stringify(updated))));
    };

    const executeQuery = async (unmaskOverride = null) => {
        if (!selectedDb) {
            setError('Please select a target database first.');
            return;
        }
        if (!query.trim()) return;

        setIsProcessing(true);
        setError('');
        setResults(null);
        setCurrentPage(1);

        const shouldShowRaw = unmaskOverride !== null ? unmaskOverride : showRaw;

        try {
            const res = await api.post('/database/query', { 
                id: selectedDb, 
                query,
                showRaw: shouldShowRaw
            });
            setResults(res.data.rows || []);
            setStats({
                count: res.data.rowCount || 0,
                duration: res.data.executionMs || 0
            });
            setIsMasked(!!res.data.isMasked);
            setMaskedColumns(res.data.maskedColumns || []);
            setCanUnmask(!!res.data.canUnmask);
            saveQueryToHistory(query);
        } catch (e) {
            console.error('Query failed:', e);
            setError(e.response?.data?.error || e.message);
        } finally {
            setIsProcessing(false);
        }
    };

    const toggleMasking = () => {
        const nextShowRaw = !showRaw;
        setShowRaw(nextShowRaw);
        if (results && results.length > 0) {
            executeQuery(nextShowRaw);
        }
    };

    const exportToCSV = () => {
        if (!results || results.length === 0) return;
        const columns = Object.keys(results[0]);
        const header = columns.join(',');
        const rows = results.map(row => 
            columns.map(col => {
                let val = row[col];
                if (val === null) return 'NULL';
                val = String(val).replace(/"/g, '""');
                if (/^[=+\-@]/.test(val)) val = "'" + val; // CSV Injection protection
                return `"${val}"`;
            }).join(',')
        );
        const csvContent = [header, ...rows].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.setAttribute('href', url);
        link.setAttribute('download', `query_result_${Date.now()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const handleTextareaScroll = () => {
        if (textareaRef.current && overlayRef.current) {
            overlayRef.current.scrollTop = textareaRef.current.scrollTop;
            overlayRef.current.scrollLeft = textareaRef.current.scrollLeft;
        }
    };

    const highlightSQL = (text) => {
        if (!text) return '';
        // Escape HTML
        let escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Highlight Keywords
        const keywords = [
            'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'LIMIT', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'ON', 
            'GROUP', 'BY', 'ORDER', 'HAVING', 'AS', 'IN', 'LIKE', 'NULL', 'IS', 'NOT', 'UNION', 'ALL'
        ];
        
        const regex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'gi');
        escaped = escaped.replace(regex, '<span style="color: #60a5fa; font-weight: bold;">$1</span>');

        // Highlight Strings
        escaped = escaped.replace(/('[^']*')/g, '<span style="color: #34d399;">$1</span>');
        escaped = escaped.replace(/("[^"]*")/g, '<span style="color: #34d399;">$1</span>');

        // Highlight Numbers
        escaped = escaped.replace(/\b(\d+)\b/g, '<span style="color: #f59e0b;">$1</span>');

        // Highlight Comments
        escaped = escaped.replace(/(--.*)/g, '<span style="color: #6b7280; font-style: italic;">$1</span>');

        return escaped;
    };

    if (role === 'Viewer') {
        return (
            <div style={S.page} className="animate-fade-in">
                <div style={{ padding: 40, textAlign: 'center', background: 'var(--bg-glass)', borderRadius: 16, border: '1px solid var(--border-color)' }}>
                    <h2 style={{ color: 'var(--danger)', fontSize: 24, marginBottom: 12 }}>🔒 Access Denied</h2>
                    <p style={{ color: 'var(--text-secondary)' }}>You do not have permission to execute SQL queries. Contact your administrator if you need access.</p>
                </div>
            </div>
        );
    }

    const renderTable = () => {
        if (!results) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Write a query and hit Execute to view results.</div>;
        if (results.length === 0) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>0 rows returned.</div>;

        const columns = Object.keys(results[0]);
        const totalPages = Math.ceil(results.length / ROWS_PER_PAGE);
        const paginated = results.slice((currentPage - 1) * ROWS_PER_PAGE, currentPage * ROWS_PER_PAGE);

        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div style={{ flex: 1, overflow: 'auto' }}>
                    <table style={S.tbl}>
                        <thead>
                            <tr>
                                <th style={S.th}>#</th>
                                {columns.map((col, i) => <th key={i} style={S.th}>{col}</th>)}
                            </tr>
                        </thead>
                        <tbody>
                            {paginated.map((row, rIndex) => {
                                const actualRowIndex = (currentPage - 1) * ROWS_PER_PAGE + rIndex + 1;
                                return (
                                    <tr key={actualRowIndex} style={S.tr}>
                                        <td style={{ ...S.td, color: 'var(--text-muted)' }}>{actualRowIndex}</td>
                                        {columns.map((col, cIndex) => {
                                            let val = row[col];
                                            if (val === null) val = <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>NULL</span>;
                                            else if (typeof val === 'object') val = JSON.stringify(val);
                                            return <td key={cIndex} style={S.td}>{val}</td>;
                                        })}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                {totalPages > 1 && (
                    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16, padding: '12px 20px', borderTop: '1px solid var(--border-color)', background: 'var(--bg-primary)' }}>
                        <button style={{ ...S.btnO, padding: '6px 16px', fontSize: 11 }} disabled={currentPage === 1} onClick={() => setCurrentPage(p => p - 1)}>Previous</button>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>Page {currentPage} of {totalPages}</span>
                        <button style={{ ...S.btnO, padding: '6px 16px', fontSize: 11 }} disabled={currentPage === totalPages} onClick={() => setCurrentPage(p => p + 1)}>Next</button>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div style={S.page} className="animate-fade-in">
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>SQL Query Terminal</h1>
                    <p style={S.subtitle}>Execute read-only queries with AI advisor, schema explorer, and dynamic data masking</p>
                </div>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <select style={S.select} value={selectedDb} onChange={e => handleDbChange(e.target.value)}>
                        {databases.length === 0 && <option value="">No databases configured</option>}
                        {databases.map(db => (
                            <option key={db.id} value={db.id}>[{db.engine}] {db.name} ({db.environment})</option>
                        ))}
                    </select>

                    <button 
                        style={{ ...S.btnO, background: showSchema ? 'rgba(59,130,246,0.15)' : 'transparent', color: showSchema ? '#60a5fa' : 'var(--text-secondary)' }}
                        onClick={() => setShowSchema(!showSchema)}
                        title="Toggle Schema Tree Explorer"
                    >
                        📑 Schema
                    </button>

                    <button 
                        style={{ ...S.btnO, background: 'linear-gradient(135deg, rgba(139,92,246,0.2), rgba(59,130,246,0.2))', borderColor: 'rgba(139,92,246,0.4)', color: '#c084fc', fontWeight: 800 }}
                        onClick={handleAskAiAdvisor}
                        title="Analyze SQL query and suggest index & optimization"
                    >
                        🤖 AI Advisor
                    </button>

                    {results && results.length > 0 && (
                        <button style={S.btnO} onClick={exportToCSV}>
                            📥 Export CSV
                        </button>
                    )}

                    <button style={{ ...S.btnP, opacity: isProcessing ? 0.7 : 1 }} onClick={() => executeQuery()} disabled={isProcessing}>
                        {isProcessing ? '⏳ Executing...' : '▶ Execute (F5)'}
                    </button>
                </div>
            </div>

            {/* Main Workbench: Schema Explorer + SQL Editor + History */}
            <div style={{ display: 'grid', gridTemplateColumns: showSchema ? '260px 1fr 240px' : '1fr 240px', gap: 16, marginBottom: 20, alignItems: 'stretch' }}>
                {/* 1. Schema Explorer Panel */}
                {showSchema && (
                    <div style={{ ...S.sidebar, padding: '14px', maxHeight: 380, overflowY: 'auto' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                            <span style={{ fontSize: 11, fontWeight: 900, color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                                📑 TABLES & COLUMNS
                            </span>
                            <button 
                                onClick={() => loadSchema(selectedDb)} 
                                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}
                                title="Refresh schema"
                            >
                                🔄
                            </button>
                        </div>
                        <input
                            type="text"
                            placeholder="Filter tables..."
                            value={schemaFilter}
                            onChange={e => setSchemaFilter(e.target.value)}
                            style={{ ...S.input, width: '100%', padding: '6px 10px', fontSize: 11, marginBottom: 10, boxSizing: 'border-box' }}
                        />
                        {loadingSchema && <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>Loading schema...</div>}
                        {!loadingSchema && Object.keys(schemaData).length === 0 && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>No tables found or connection offline.</div>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            {Object.keys(schemaData)
                                .filter(tbl => tbl.toLowerCase().includes(schemaFilter.toLowerCase()))
                                .map(tbl => {
                                    const isExpanded = !!expandedTables[tbl];
                                    const cols = schemaData[tbl] || [];
                                    return (
                                        <div key={tbl} style={{ borderRadius: 6, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
                                            <div 
                                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}
                                                onClick={() => toggleTableExpand(tbl)}
                                            >
                                                <span style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{isExpanded ? '▼' : '▶'}</span>
                                                    <span>📁 {tbl}</span>
                                                </span>
                                                <button
                                                    style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', fontSize: 10, cursor: 'pointer', padding: '2px 4px' }}
                                                    title="Preview table rows"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        setQuery(`SELECT * FROM ${tbl} LIMIT 50;`);
                                                    }}
                                                >
                                                    SELECT
                                                </button>
                                            </div>
                                            {isExpanded && (
                                                <div style={{ padding: '6px 12px 8px 24px', background: 'rgba(0,0,0,0.2)', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                    {cols.map(c => (
                                                        <div 
                                                            key={c.name} 
                                                            style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontFamily: 'monospace', color: c.pk ? '#f59e0b' : 'var(--text-secondary)', cursor: 'pointer' }}
                                                            onClick={() => setQuery(prev => prev + (prev.endsWith(' ') || prev.length === 0 ? '' : ' ') + c.name)}
                                                            title="Click to insert column into query"
                                                        >
                                                            <span>{c.pk ? '🔑 ' : ''}{c.name}</span>
                                                            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>{c.type}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                        </div>
                    </div>
                )}

                {/* 2. SQL Editor */}
                <div style={S.editorWrap}>
                    <div style={S.editorHeader}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>
                            SQL Editor <span style={{ color: 'var(--warning)', marginLeft: 8 }}>⚠️ Only SELECT operations are allowed</span>
                        </span>
                        <div style={{ display: 'flex', gap: 8 }}>
                            {databases.find(d => String(d.id) === String(selectedDb))?.engine === 'SQLite' ? (
                                <button
                                    type="button"
                                    onClick={() => setQuery("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view');")}
                                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}
                                    title="Show tables in SQLite"
                                >
                                    📋 List Tables (sqlite_master)
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setQuery("SELECT table_name, table_schema FROM information_schema.tables LIMIT 20;")}
                                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}
                                    title="Show schema tables"
                                >
                                    📋 List Tables (information_schema)
                                </button>
                            )}
                        </div>
                    </div>
                    <div style={S.textareaWrap}>
                        <textarea 
                            ref={textareaRef}
                            style={S.textarea} 
                            value={query} 
                            onChange={e => setQuery(e.target.value)} 
                            onScroll={handleTextareaScroll}
                            onKeyDown={e => {
                                if (e.key === 'F5' || (e.ctrlKey && e.key === 'Enter')) {
                                    e.preventDefault();
                                    executeQuery();
                                }
                            }}
                            placeholder="Type your SQL query here... e.g. SELECT * FROM users;"
                            spellCheck="false"
                        />
                        <div 
                            ref={overlayRef}
                            style={S.highlightOverlay}
                            dangerouslySetInnerHTML={{ __html: highlightSQL(query) }}
                        />
                    </div>
                </div>

                {/* 3. History Sidebar */}
                <div style={{ ...S.sidebar, maxHeight: 380 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <span style={{ ...S.sidebarTitle, marginBottom: 0 }}>📜 QUERY HISTORY</span>
                        {history.length > 0 && (
                            <button 
                                style={{ background: 'transparent', border: 'none', color: 'var(--danger)', fontSize: 10, cursor: 'pointer', padding: '2px 4px', fontWeight: 'bold' }} 
                                onClick={() => { setHistory([]); localStorage.removeItem('sql_query_history'); }}
                            >
                                Clear
                            </button>
                        )}
                    </div>
                    <div style={S.historyList}>
                        {history.map((h, i) => (
                            <button 
                                key={i} 
                                style={S.historyItem} 
                                title={h}
                                onClick={() => setQuery(h)}
                            >
                                {h}
                            </button>
                        ))}
                        {history.length === 0 && (
                            <span style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 20 }}>No queries in history yet.</span>
                        )}
                    </div>
                </div>
            </div>

            {/* Results Grid & Data Masking Bar */}
            <div style={S.resultWrap}>
                {results && !error && (
                    <div style={{ ...S.metaBar, justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                            <span>📊 Rows: <strong>{stats.count}</strong></span>
                            <span>⚡ Duration: <strong>{stats.duration} ms</strong></span>
                            {isMasked && (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(59,130,246,0.15)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.3)', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700 }}>
                                    🛡️ 敏感欄位脫敏保護中 ({maskedColumns.join(', ')})
                                </span>
                            )}
                        </div>
                        {canUnmask && isMasked && (
                            <button 
                                style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}
                                onClick={toggleMasking}
                            >
                                {showRaw ? '🔒 恢復資料脫敏' : '👁️ 檢視未脫敏原始資料 (Audit Logged)'}
                            </button>
                        )}
                    </div>
                )}
                {error && <div style={S.errorBox}>{error}</div>}
                {!error && renderTable()}
            </div>

            {/* AI SQL Advisor Modal */}
            {showAiModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                    <div style={{ background: '#0f172a', border: '1px solid var(--border-color)', borderRadius: 16, width: '100%', maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 24px', borderBottom: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.02)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontSize: 20 }}>🤖</span>
                                <div>
                                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>AI SQL Performance Advisor</h3>
                                    {aiModelInfo && <span style={{ fontSize: 10, color: '#c084fc', fontWeight: 700 }}>{aiModelInfo}</span>}
                                </div>
                            </div>
                            <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }} onClick={() => setShowAiModal(false)}>✕</button>
                        </div>

                        <div style={{ flex: 1, overflowY: 'auto', padding: 24, fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)' }}>
                            {aiLoading && (
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 16 }}>
                                    <div className="animate-spin" style={{ width: 32, height: 32, border: '3px solid rgba(255,255,255,0.1)', borderTopColor: 'var(--accent-primary)', borderRadius: '50%' }}></div>
                                    <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>正在透過 AI 引擎分析 SQL 語句與執行瓶頸...</span>
                                </div>
                            )}
                            {!aiLoading && aiWarning && (
                                <div style={{ padding: '10px 14px', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, color: '#f59e0b', marginBottom: 16, fontSize: 12 }}>
                                    ⚠️ {aiWarning}
                                </div>
                            )}
                            {!aiLoading && aiAnalysis && (
                                <div style={{ whiteSpace: 'pre-wrap', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
                                    {aiAnalysis}
                                </div>
                            )}
                        </div>

                        <div style={{ padding: '14px 24px', borderTop: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.02)', display: 'flex', justifyContent: 'flex-end' }}>
                            <button style={S.btnP} onClick={() => setShowAiModal(false)}>
                                關閉建議視窗
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SqlTerminal;

