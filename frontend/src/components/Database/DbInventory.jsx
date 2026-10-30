import React, { useState, useEffect } from 'react';
import api from '../../api';
import { normalizeEnvs, defaultEnv } from '../../utils/environments';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnO: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
    filterBar: { display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'hidden' },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13 },
    badgeDanger: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)' },
    badgeSuccess: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: '1px solid rgba(16, 185, 129, 0.3)' },
    badgeInfo: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.3)' },
    engineBadge: { padding: '4px 12px', borderRadius: 8, fontSize: 11, fontWeight: 800, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', display: 'inline-block' },
    viewBtn: { padding: '6px 14px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: 'pointer' },
    testBtn: { padding: '6px 14px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: 'pointer' },
    delBtn: { padding: '6px 14px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 800, cursor: 'pointer' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 500, overflow: 'hidden', backdropFilter: 'blur(16px)', boxShadow: '0 25px 50px rgba(0,0,0,0.5)' },
    modalH: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px', borderBottom: '1px solid var(--border-color)' },
    closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, fontSize: 20 },
    input: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box' },
    filterInput: { borderRadius: 12, padding: '10px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-glass)', color: 'var(--text-primary)', outline: 'none', minWidth: 200 },
    label: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', display: 'block' },
    formGroup: { marginBottom: 16 },
    modalBtns: { display: 'flex', gap: 12, marginTop: 24 },
    btnDanger: { flex: 1, padding: '10px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 800, cursor: 'pointer' },
    btnCancel: { flex: 1, padding: '10px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, fontWeight: 800, cursor: 'pointer' }
};

const DbInventory = () => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';

    const [databases, setDatabases] = useState([]);
    const [environments, setEnvironments] = useState([]);
    const [showModal, setShowModal] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [formData, setFormData] = useState({
        id: '', name: '', environment: '', engine: 'MySQL', host: '', port: '', database: '', username: '', password: '', filePath: ''
    });

    // Filtering state
    const [searchTerm, setSearchTerm] = useState('');
    const [selectedEnv, setSelectedEnv] = useState('ALL');

    // Custom confirm delete modal state
    const [showDeleteModal, setShowDeleteModal] = useState(null); // database ID to delete

    // Test connection states per database row
    const [testStates, setTestStates] = useState({}); // { [dbId]: 'testing' | 'success' | 'failed' | '' }
    const [testError, setTestError] = useState({}); // { [dbId]: 'error message' }

    // Test connection state in forms
    const [formTesting, setFormTesting] = useState(false);
    const [formTestResult, setFormTestResult] = useState(''); // 'success' | 'failed' | ''
    const [formTestError, setFormTestError] = useState('');

    // Schema Diff modal state
    const [showDiffModal, setShowDiffModal] = useState(false);
    const [diffSourceId, setDiffSourceId] = useState('');
    const [diffTargetId, setDiffTargetId] = useState('');
    const [diffResult, setDiffResult] = useState(null);
    const [diffLoading, setDiffLoading] = useState(false);
    const [diffError, setDiffError] = useState('');
    const [copiedSql, setCopiedSql] = useState(false);

    const fetchEnvironments = async () => {
        try {
            const res = await api.get('/environments');
            setEnvironments(normalizeEnvs(res.data));
        } catch (e) { console.error('Failed to load envs:', e); }
    };

    const loadDatabases = async () => {
        try {
            const res = await api.get('/database/inventory');
            setDatabases(res.data.databases || []);
        } catch (e) { console.error('Failed to load DBs:', e); }
    };

    useEffect(() => {
        fetchEnvironments();
        loadDatabases();
    }, []);

    const handleSave = async (e) => {
        e.preventDefault();
        try {
            await api.post('/database/inventory', formData);
            setShowModal(false);
            loadDatabases();
        } catch (e) {
            console.error('Failed to save DB:', e);
            setFormTestResult('failed');
            setFormTestError(e.response?.data?.error || e.message || 'Error saving connection');
        }
    };

    const handleDelete = async () => {
        if (!showDeleteModal) return;
        try {
            await api.delete(`/database/inventory/${showDeleteModal}`);
            setShowDeleteModal(null);
            loadDatabases();
        } catch (e) {
            console.error('Failed to delete DB:', e);
        }
    };

    const testConnection = async (dbId) => {
        setTestStates(prev => ({ ...prev, [dbId]: 'testing' }));
        setTestError(prev => ({ ...prev, [dbId]: '' }));
        try {
            const res = await api.post('/database/test-connection', { id: dbId });
            if (res.data.success) {
                setTestStates(prev => ({ ...prev, [dbId]: 'success' }));
            } else {
                setTestStates(prev => ({ ...prev, [dbId]: 'failed' }));
                setTestError(prev => ({ ...prev, [dbId]: res.data.error || 'Connection Failed' }));
            }
        } catch (e) {
            setTestStates(prev => ({ ...prev, [dbId]: 'failed' }));
            setTestError(prev => ({ ...prev, [dbId]: e.message || 'Connection Failed' }));
        }
    };

    const testFormConnection = async () => {
        setFormTesting(true);
        setFormTestResult('');
        setFormTestError('');
        try {
            const res = await api.post('/database/test-connection', formData);
            if (res.data.success) {
                setFormTestResult('success');
            } else {
                setFormTestResult('failed');
                setFormTestError(res.data.error || 'Connection Failed');
            }
        } catch (e) {
            setFormTestResult('failed');
            setFormTestError(e.message || 'Connection Failed');
        } finally {
            setFormTesting(false);
        }
    };

    const handleOpenDiffModal = () => {
        setDiffError('');
        setDiffResult(null);
        setCopiedSql(false);
        if (databases.length >= 2) {
            setDiffSourceId(databases[0].id);
            setDiffTargetId(databases[1].id);
        } else if (databases.length === 1) {
            setDiffSourceId(databases[0].id);
            setDiffTargetId(databases[0].id);
        }
        setShowDiffModal(true);
    };

    const handleCompareSchema = async () => {
        if (!diffSourceId || !diffTargetId) {
            setDiffError('請選擇來源資料庫與目標資料庫');
            return;
        }
        setDiffLoading(true);
        setDiffError('');
        setDiffResult(null);
        setCopiedSql(false);
        try {
            const res = await api.post('/database/schema-diff', {
                sourceId: diffSourceId,
                targetId: diffTargetId
            });
            setDiffResult(res.data);
        } catch (e) {
            setDiffError(e.response?.data?.error || e.message || '比對失敗');
        } finally {
            setDiffLoading(false);
        }
    };

    const openModal = (db = null) => {
        setFormTestResult('');
        setFormTestError('');
        if (db) {
            setIsEditing(true);
            setFormData({
                ...db,
                environment: db.envId || '', // the form holds the environment id ('' = Unassigned)
                password: '',
                filePath: db.engine === 'SQLite' ? (db.database || db.host) : ''
            });
        } else {
            setIsEditing(false);
            setFormData({
                id: '', name: '', environment: (defaultEnv(environments) || {}).id || '', engine: 'MySQL', host: '', port: '', database: '', username: '', password: '', filePath: ''
            });
        }
        setShowModal(true);
    };

    // Filter logic
    const filteredDatabases = databases.filter(db => {
        const matchesSearch = db.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                              db.host.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesEnv = selectedEnv === 'ALL' || db.environment === selectedEnv;
        return matchesSearch && matchesEnv;
    });

    return (
        <div style={S.page} className="animate-fade-in">
            <div style={S.header}>
                <div>
                    <h1 style={S.title}>DB Connection Hub</h1>
                    <p style={S.subtitle}>Manage database clusters, connection strings, and schema diff across environments</p>
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                    <button 
                        style={{ ...S.btnO, background: 'rgba(59,130,246,0.15)', borderColor: 'rgba(59,130,246,0.4)', color: '#60a5fa', fontWeight: 700 }}
                        onClick={handleOpenDiffModal}
                    >
                        🔄 Schema Diff & Migration
                    </button>
                    {role !== 'Viewer' && (
                        <button style={S.btnP} onClick={() => openModal()}>+ Add Connection</button>
                    )}
                </div>
            </div>

            {/* Search and Filters */}
            <div style={S.filterBar}>
                <input 
                    type="text" 
                    placeholder="🔍 Search name or host..." 
                    style={S.filterInput} 
                    value={searchTerm} 
                    onChange={e => setSearchTerm(e.target.value)} 
                />
                <select 
                    style={S.filterInput} 
                    value={selectedEnv} 
                    onChange={e => setSelectedEnv(e.target.value)}
                >
                    <option value="ALL">All Environments</option>
                    {environments.map(env => <option key={env.id} value={env.name}>{env.name}</option>)}
                    <option value="Unassigned">Unassigned</option>
                </select>
            </div>

            <div style={S.tblWrap}>
                <table style={S.tbl}>
                    <thead>
                        <tr>
                            <th style={S.th}>NAME</th>
                            <th style={S.th}>ENV</th>
                            <th style={S.th}>ENGINE</th>
                            <th style={S.th}>HOST : PORT</th>
                            <th style={S.th}>DATABASE</th>
                            <th style={S.th}>USER</th>
                            <th style={S.th}>CONNECTION STATUS</th>
                            <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredDatabases.map(db => (
                            <tr key={db.id} style={S.tr}>
                                <td style={{ ...S.td, fontWeight: 800 }}>{db.name}</td>
                                <td style={S.td}>
                                    <span style={db.envIsProduction ? S.badgeDanger : S.badgeSuccess} title={db.envUnmapped ? `Stored value "${db.envUnmapped}" is not in Settings -> Environments` : ''}>{db.environment}</span>
                                </td>
                                <td style={S.td}>
                                    <span style={S.engineBadge}>{db.engine}</span>
                                </td>
                                <td style={{ ...S.td, fontFamily: 'monospace', color: 'var(--text-secondary)' }}>
                                    {db.engine === 'SQLite' ? (
                                        <span title={db.database} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent-primary)', fontWeight: 600 }}>
                                            📁 File Database
                                        </span>
                                    ) : (
                                        `${db.host}:${db.port}`
                                    )}
                                </td>
                                <td style={{ ...S.td, fontWeight: 700, fontFamily: db.engine === 'SQLite' ? 'monospace' : 'inherit', fontSize: db.engine === 'SQLite' ? 12 : 13 }}>
                                    {db.engine === 'SQLite' ? (
                                        <span title={db.database}>{db.database}</span>
                                    ) : (
                                        db.database
                                    )}
                                </td>
                                <td style={{ ...S.td, fontFamily: 'monospace' }}>{db.username}</td>
                                <td style={S.td}>
                                    {testStates[db.id] === 'testing' && <span style={{ color: 'var(--text-muted)' }}>⏳ Testing...</span>}
                                    {testStates[db.id] === 'success' && <span style={{ color: '#10b981', fontWeight: 'bold' }}>✅ Connected</span>}
                                    {testStates[db.id] === 'failed' && (
                                        <span style={{ color: '#ef4444', fontWeight: 'bold' }} title={testError[db.id]}>
                                            ❌ Connection Failed
                                        </span>
                                    )}
                                    {!testStates[db.id] && <span style={{ color: 'var(--text-muted)' }}>Not Verified</span>}
                                </td>
                                <td style={{ ...S.td, textAlign: 'right' }}>
                                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                        {role !== 'Viewer' ? (
                                            <>
                                                <button style={S.testBtn} onClick={() => testConnection(db.id)}>Test</button>
                                                <button style={S.viewBtn} onClick={() => openModal(db)}>Edit</button>
                                                <button style={S.delBtn} onClick={() => setShowDeleteModal(db.id)}>Delete</button>
                                            </>
                                        ) : (
                                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Read Only</span>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                        {filteredDatabases.length === 0 && (
                            <tr><td colSpan="8" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No database connections found matching filters.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Add/Edit Modal */}
            {showModal && (
                <div style={S.overlay} onClick={() => setShowModal(false)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={S.modalH}>
                            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>{isEditing ? '✏️ Edit Connection' : '🔗 Add Connection'}</h3>
                            <button style={S.closeBtn} onClick={() => setShowModal(false)}>✕</button>
                        </div>
                        <form onSubmit={handleSave} style={{ padding: 24 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                <div style={S.formGroup}>
                                    <label style={S.label}>Connection Name</label>
                                    <input type="text" style={S.input} value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="e.g. Local-SQLite-01" required />
                                </div>
                                <div style={S.formGroup}>
                                    <label style={S.label}>Environment</label>
                                    <select style={S.input} value={formData.environment} onChange={e => setFormData({...formData, environment: e.target.value})}>
                                        <option value="" disabled>Choose an environment...</option>
                                        {environments.map(env => <option key={env.id} value={env.id}>{env.name}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div style={S.formGroup}>
                                <label style={S.label}>Database Engine</label>
                                <select style={S.input} value={formData.engine} onChange={e => setFormData({...formData, engine: e.target.value})}>
                                    <option value="MySQL">MySQL / MariaDB</option>
                                    <option value="PostgreSQL">PostgreSQL</option>
                                    <option value="SQLServer">Microsoft SQL Server</option>
                                    <option value="SQLite">SQLite (本地檔案型資料庫)</option>
                                </select>
                            </div>

                            {formData.engine === 'SQLite' ? (
                                <div style={S.formGroup}>
                                    <label style={S.label}>
                                        SQLite 資料庫檔案路徑 (File Path) <span style={{ color: 'var(--danger)' }}>*</span>
                                    </label>
                                    <input 
                                        type="text" 
                                        style={{...S.input, fontFamily: 'monospace'}} 
                                        value={formData.filePath || formData.database || ''} 
                                        onChange={e => setFormData({...formData, filePath: e.target.value, database: e.target.value})} 
                                        placeholder="例如: C:\data\app.db 或 ./data/database.db" 
                                        required 
                                    />
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                                        💡 SQLite 為本地檔案型資料庫，直接讀取伺服器磁碟檔案，不需 Host、Port 或帳號密碼。
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: 16 }}>
                                        <div style={S.formGroup}>
                                            <label style={S.label}>Hostname / IP</label>
                                            <input type="text" style={{...S.input, fontFamily: 'monospace'}} value={formData.host} onChange={e => setFormData({...formData, host: e.target.value})} placeholder="10.0.0.1" required />
                                        </div>
                                        <div style={S.formGroup}>
                                            <label style={S.label}>Port</label>
                                            <input type="number" style={{...S.input, fontFamily: 'monospace'}} value={formData.port} onChange={e => setFormData({...formData, port: e.target.value})} placeholder={formData.engine === 'MySQL' ? '3306' : formData.engine === 'PostgreSQL' ? '5432' : '1433'} required />
                                        </div>
                                    </div>

                                    <div style={S.formGroup}>
                                        <label style={S.label}>Database Name</label>
                                        <input type="text" style={S.input} value={formData.database} onChange={e => setFormData({...formData, database: e.target.value})} placeholder="MainDB" required />
                                    </div>

                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                        <div style={S.formGroup}>
                                            <label style={S.label}>Username</label>
                                            <input type="text" style={{...S.input, fontFamily: 'monospace'}} value={formData.username} onChange={e => setFormData({...formData, username: e.target.value})} placeholder="dbadmin" required />
                                        </div>
                                        <div style={S.formGroup}>
                                            <label style={S.label}>Password {isEditing && <span style={{ color: 'var(--warning)', fontWeight: 500 }}>(Leave blank to keep)</span>}</label>
                                            <input type="password" style={{...S.input, fontFamily: 'monospace'}} value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} required={!isEditing} />
                                        </div>
                                    </div>
                                </>
                            )}

                            {/* Form test result status */}
                            {formTestResult === 'success' && <div style={{ color: '#10b981', fontSize: 13, marginBottom: 12, fontWeight: 'bold' }}>✅ Connected Successfully!</div>}
                            {formTestResult === 'failed' && (
                                <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12, fontWeight: 'bold' }}>
                                    ❌ Connection Failed: {formTestError}
                                </div>
                            )}

                            <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
                                <button type="button" style={{ ...S.btnO, flex: 1, justifyContent: 'center' }} onClick={testFormConnection} disabled={formTesting}>
                                    {formTesting ? '⏳ Testing...' : 'Test Connection'}
                                </button>
                                <button type="submit" style={{ ...S.btnP, flex: 1, justifyContent: 'center' }}>{isEditing ? 'Save Changes' : 'Create Connection'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Custom Confirm Delete Modal */}
            {showDeleteModal && (
                <div style={S.overlay} onClick={() => setShowDeleteModal(null)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: 24 }}>
                            <h2 style={{ fontSize: 18, fontWeight: 900, marginTop: 0, color: 'var(--danger)' }}>⚠️ Confirm Deletion</h2>
                            <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                Are you sure you want to remove this database connection?
                                <br/><br/>
                                This will delete the connection definition and credentials. This action cannot be undone.
                            </p>
                            <div style={S.modalBtns}>
                                <button style={S.btnCancel} onClick={() => setShowDeleteModal(null)}>Cancel</button>
                                <button style={S.btnDanger} onClick={handleDelete}>Yes, Delete Connection</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Schema Diff & Migration Modal */}
            {showDiffModal && (
                <div style={S.overlay} onClick={() => setShowDiffModal(false)}>
                    <div style={{ ...S.modal, maxWidth: 840, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: 24, borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontSize: 22 }}>🔄</span>
                                <div>
                                    <h2 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>Database Schema Diff & Migration</h2>
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Cross-environment table and column synchronization generator (e.g. DEV vs PRD)</span>
                                </div>
                            </div>
                            <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }} onClick={() => setShowDiffModal(false)}>✕</button>
                        </div>

                        <div style={{ padding: 24, overflowY: 'auto', flex: 1 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                                <div style={S.formGroup}>
                                    <label style={S.label}>來源資料庫 (Source DB - 基準庫 / 最新開發環境)</label>
                                    <select style={S.input} value={diffSourceId} onChange={e => setDiffSourceId(e.target.value)}>
                                        {databases.map(d => (
                                            <option key={d.id} value={d.id}>[{d.engine}] {d.name} ({d.environment})</option>
                                        ))}
                                    </select>
                                </div>
                                <div style={S.formGroup}>
                                    <label style={S.label}>目標資料庫 (Target DB - 待更新環境 / 生產庫)</label>
                                    <select style={S.input} value={diffTargetId} onChange={e => setDiffTargetId(e.target.value)}>
                                        {databases.map(d => (
                                            <option key={d.id} value={d.id}>[{d.engine}] {d.name} ({d.environment})</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <button 
                                style={{ ...S.btnP, width: '100%', justifyContent: 'center', padding: '10px 0', marginBottom: 20 }}
                                onClick={handleCompareSchema}
                                disabled={diffLoading}
                            >
                                {diffLoading ? '⏳ 正在比對兩端資料庫綱要結構 (Extracting Schemas)...' : '⚡ 開始跨庫結構比對 (Compare Now)'}
                            </button>

                            {diffError && (
                                <div style={{ padding: 12, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
                                    ❌ {diffError}
                                </div>
                            )}

                            {diffResult && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                                        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', padding: 12, borderRadius: 8, textAlign: 'center' }}>
                                            <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 700 }}>目標庫缺失資料表</div>
                                            <div style={{ fontSize: 20, fontWeight: 900, color: '#ef4444', marginTop: 4 }}>
                                                {diffResult.diffSummary.missingTablesCount}
                                            </div>
                                        </div>
                                        <div style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', padding: 12, borderRadius: 8, textAlign: 'center' }}>
                                            <div style={{ fontSize: 11, color: '#f59e0b', fontWeight: 700 }}>目標庫缺失欄位</div>
                                            <div style={{ fontSize: 20, fontWeight: 900, color: '#f59e0b', marginTop: 4 }}>
                                                {diffResult.diffSummary.missingColumnsCount}
                                            </div>
                                        </div>
                                        <div style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.3)', padding: 12, borderRadius: 8, textAlign: 'center' }}>
                                            <div style={{ fontSize: 11, color: '#60a5fa', fontWeight: 700 }}>資料型態不一致</div>
                                            <div style={{ fontSize: 20, fontWeight: 900, color: '#60a5fa', marginTop: 4 }}>
                                                {diffResult.diffSummary.typeMismatchesCount}
                                            </div>
                                        </div>
                                    </div>

                                    <div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                            <label style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)' }}>
                                                📝 自動生成之遷移補丁腳本 (Generated Migration DDL SQL)
                                            </label>
                                            <button 
                                                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}
                                                onClick={() => {
                                                    navigator.clipboard.writeText(diffResult.migrationSql);
                                                    setCopiedSql(true);
                                                    setTimeout(() => setCopiedSql(false), 2000);
                                                }}
                                            >
                                                {copiedSql ? '✅ Copied!' : '📋 Copy DDL'}
                                            </button>
                                        </div>
                                        <textarea 
                                            readOnly 
                                            style={{ ...S.input, width: '100%', minHeight: 180, fontFamily: 'monospace', fontSize: 12, background: 'rgba(0,0,0,0.3)', color: '#a7f3d0', boxSizing: 'border-box' }}
                                            value={diffResult.migrationSql}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DbInventory;
