import React, { useState, useEffect } from 'react';
import api from '../../api';
import cronstrue from 'cronstrue';

const S = {
    page: { padding: '24px 32px', fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)', minHeight: '100%' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    title: { fontSize: 22, fontWeight: 900, margin: 0 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
    headerBtns: { display: 'flex', gap: 10 },
    btnP: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' },
    btnO: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
    topRow: { display: 'flex', gap: 20, marginBottom: 28 },
    card: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metCol: { width: 280, display: 'flex', flexDirection: 'column', gap: 20 },
    metCard: { flex: 1, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24 },
    metLabel: { fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.08em', display: 'block', marginBottom: 8 },
    metVal: { fontSize: 36, fontWeight: 900, color: 'var(--text-primary)', lineHeight: 1 },
    dot: { width: 10, height: 10, borderRadius: '50%', display: 'inline-block' },
    tblWrap: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, overflow: 'visible' },
    tblHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap', gap: 12 },
    tblTitle: { fontSize: 16, fontWeight: 900, margin: 0 },
    sBox: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: '1px solid var(--border-color)', borderRadius: 8 },
    sInput: { border: 'none', background: 'transparent', outline: 'none', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', width: 180 },
    tbl: { width: '100%', borderCollapse: 'collapse' },
    th: { textAlign: 'left', padding: '14px 24px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' },
    td: { padding: '14px 24px', verticalAlign: 'middle', fontSize: 13 },
    badge: { padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-block' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 },
    modal: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 24, width: '100%', maxWidth: 700, boxShadow: '0 30px 60px rgba(0,0,0,0.3)', overflow: 'hidden', backdropFilter: 'blur(16px)', alignSelf: 'center' },
    modalH: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 28px', borderBottom: '1px solid var(--border-color)' },
    closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, fontSize: 20 },
    input: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box' },
    textarea: { width: '100%', borderRadius: 12, padding: 16, fontSize: 13, fontWeight: 600, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', resize: 'vertical', fontFamily: 'monospace', marginTop: 6, boxSizing: 'border-box' },
    gridRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 12 },
    select: { width: '100%', borderRadius: 12, padding: '12px 16px', fontSize: 13, fontWeight: 700, border: '1px solid var(--border-color)', background: 'var(--bg-primary)', color: 'var(--text-primary)', outline: 'none', marginTop: 6, boxSizing: 'border-box', appearance: 'none', cursor: 'pointer' },
    hint: { marginTop: 12, padding: 14, borderRadius: 12, background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-muted)', fontWeight: 500, lineHeight: 1.6, border: '1px solid var(--border-color)' },
    terminal: { background: '#0f172a', padding: 16, borderRadius: 12, border: '1px solid var(--border-color)', color: '#38bdf8', fontFamily: 'monospace', fontSize: 12, overflow: 'auto', maxHeight: 200, whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 6 },
    actionDropdown: { position: 'absolute', right: 0, top: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: '6px', minWidth: 140, boxShadow: '0 10px 30px rgba(0,0,0,0.3)', zIndex: 50, display: 'flex', flexDirection: 'column', gap: 4 },
    actionItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', borderRadius: 8, border: 'none', background: 'transparent', textAlign: 'left', width: '100%' }
};

const SchedulerManager = () => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const [tasks, setTasks] = useState([]);
    const [logs, setLogs] = useState([]);
    const [filter, setFilter] = useState('');
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState(null);
    const [deleteConfirmTask, setDeleteConfirmTask] = useState(null);
    const [runningTaskIds, setRunningTaskIds] = useState({}); // { [taskId]: initialLastRunTime }
    const [openDropdownId, setOpenDropdownId] = useState(null);
    
    const [stats, setStats] = useState({});

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = () => setOpenDropdownId(null);
        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
    }, []);
    
    // Add/Edit modal state
    const [showAddModal, setShowAddModal] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [form, setForm] = useState({
        id: '',
        name: '',
        cronExpression: '0 0 * * *',
        targetType: 'local_ps', // 'local_ps', 'remote_linux_ssh', 'remote_windows_cmd', 'remote_windows_task', 'remote_auto_cmd'
        targets: '',
        winCommand: '',
        nixCommand: '',
        executeAt: '09:00'
    });

    // Logs drawer state
    const [showLogsDrawer, setShowLogsDrawer] = useState(false);
    const [activeTab, setActiveTab] = useState('tasks'); // 'tasks' or 'history'

    useEffect(() => {
        fetchData();
        // Check query parameters to see if we were redirected from Remote Command
        const params = new URLSearchParams(window.location.search);
        const winCmd = params.get('winCmd');
        const nixCmd = params.get('nixCmd');
        const ips = params.get('ips');
        
        if (winCmd || nixCmd || ips) {
            let targetType = 'local_ps';
            if (winCmd && nixCmd) {
                targetType = 'remote_auto_cmd';
            } else if (nixCmd) {
                targetType = 'remote_linux_ssh';
            } else if (winCmd) {
                targetType = 'remote_windows_cmd';
            }

            setForm({
                id: '',
                name: 'Remote Command Scheduled Task',
                cronExpression: '0 9 * * *',
                targetType: targetType,
                targets: ips || '',
                winCommand: winCmd || '',
                nixCommand: nixCmd || '',
                executeAt: '09:00'
            });
            setShowAddModal(true);
            // Clean up address bar query params
            window.history.replaceState({}, document.title, window.location.pathname);
        }
    }, []);

    // Polling effect when there are running tasks
    useEffect(() => {
        const runningIds = Object.keys(runningTaskIds);
        if (runningIds.length === 0) return;

        let pollCount = 0;
        let timeoutId;

        const poll = async () => {
            try {
                const tRes = await api.get('/scheduler/tasks');
                const latestTasks = tRes.data || [];
                
                let completedSomething = false;
                const nextRunning = { ...runningTaskIds };

                for (const id of runningIds) {
                    const latestTask = latestTasks.find(t => t.id === id);
                    if (latestTask && latestTask.lastRunTime !== runningTaskIds[id]) {
                        completedSomething = true;
                        delete nextRunning[id];
                        
                        const statusColor = latestTask.lastRunStatus === 'Success' ? '🟢' : '🔴';
                        setStatus({
                            type: latestTask.lastRunStatus === 'Success' ? 'success' : 'error',
                            msg: `${statusColor} Task "${latestTask.name}" finished: ${latestTask.lastRunStatus}!`
                        });
                    }
                }

                if (completedSomething) {
                    setRunningTaskIds(nextRunning);
                    setTasks(latestTasks);
                    fetchData(); // re-fetch logs and stats
                } else {
                    pollCount++;
                    const nextInterval = pollCount > 10 ? 5000 : 2000;
                    timeoutId = setTimeout(poll, nextInterval);
                }
            } catch (err) {
                console.error('Error polling tasks state:', err);
                timeoutId = setTimeout(poll, 5000);
            }
        };

        timeoutId = setTimeout(poll, 2000);

        return () => clearTimeout(timeoutId);
    }, [runningTaskIds]);

    const fetchData = async () => {
        try {
            const tRes = await api.get('/scheduler/tasks');
            setTasks(tRes.data || []);
            const lRes = await api.get('/scheduler/logs');
            setLogs(lRes.data || []);
            const sRes = await api.get('/scheduler/stats');
            setStats(sRes.data || {});
        } catch (err) {
            console.error('Failed to load scheduler data:', err);
        }
    };

    const handleToggleTask = async (id, name) => {
        try {
            await api.post(`/scheduler/tasks/toggle/${id}`);
            setStatus({ type: 'success', msg: `Toggled status for task: ${name}` });
            fetchData();
        } catch (err) {
            setStatus({ type: 'error', msg: err.message });
        } finally {
            setTimeout(() => setStatus(null), 5000);
        }
    };

    const handleRunNow = async (id, name) => {
        const task = tasks.find(t => t.id === id);
        const initialLastRunTime = task ? task.lastRunTime : 'N/A';

        setRunningTaskIds(prev => ({ ...prev, [id]: initialLastRunTime }));
        setStatus({ type: 'info', msg: `⚡ Task "${name}" execution triggered...` });
        
        try {
            await api.post(`/scheduler/tasks/run/${id}`);
        } catch (err) {
            setStatus({ type: 'error', msg: `Execution failed: ${err.message}` });
            setRunningTaskIds(prev => {
                const next = { ...prev };
                delete next[id];
                return next;
            });
        }
    };

    const handleDeleteClick = (task) => {
        setDeleteConfirmTask(task);
    };

    const handleConfirmDelete = async () => {
        if (!deleteConfirmTask) return;
        const { id, name } = deleteConfirmTask;
        try {
            await api.delete(`/scheduler/tasks/delete/${id}`);
            setStatus({ type: 'success', msg: `Deleted task: ${name}` });
            fetchData();
        } catch (err) {
            setStatus({ type: 'error', msg: err.message });
        } finally {
            setDeleteConfirmTask(null);
            setTimeout(() => setStatus(null), 5000);
        }
    };

    const handleFormSubmit = async (e) => {
        e.preventDefault();
        if (form.targetType !== 'remote_windows_task' && !/^(\S+\s){4}\S+$/.test(form.cronExpression)) {
            setStatus({ type: 'error', msg: 'Invalid Cron Expression format.' });
            setTimeout(() => setStatus(null), 5000);
            return;
        }
        setLoading(true);
        try {
            if (isEditing) {
                await api.put('/scheduler/tasks/update', form);
                setStatus({ type: 'success', msg: `Updated task: ${form.name}` });
            } else {
                await api.post('/scheduler/tasks/add', form);
                setStatus({ type: 'success', msg: `Added new scheduled task: ${form.name}` });
            }
            setShowAddModal(false);
            setIsEditing(false);
            setForm({ id: '', name: '', cronExpression: '0 0 * * *', targetType: 'local_ps', targets: '', winCommand: '', nixCommand: '', executeAt: '09:00' });
            fetchData();
        } catch (err) {
            setStatus({ type: 'error', msg: err?.response?.data?.error || err.message });
        } finally {
            setLoading(false);
            setTimeout(() => setStatus(null), 5000);
        }
    };

    const handleEditClick = (task) => {
        setForm({
            id: task.id,
            name: task.name,
            cronExpression: task.cronExpression,
            targetType: task.targetType,
            targets: task.targets.join(', '),
            winCommand: task.winCommand,
            nixCommand: task.nixCommand,
            executeAt: task.executeAt || '09:00'
        });
        setIsEditing(true);
        setShowAddModal(true);
    };

    const filteredTasks = tasks.filter(t => {
        const query = `${t.name} ${t.targetType} ${t.cronExpression}`.toLowerCase();
        return query.includes(filter.toLowerCase());
    });

    const activeTasksCount = tasks.filter(t => t.status === 'active').length;
    let overallTotal = 0;
    let overallFailed = 0;
    Object.values(stats).forEach(s => {
        overallTotal += s.total;
        overallFailed += s.failed;
    });

    return (
        <div style={S.page}>
            {/* Header */}
            <div style={S.header}>
                <div>
                    <h1 className="page-title">Task Scheduler</h1>
                    <p className="page-subtitle">Dynamic Node-cron & remote distributed scheduled tasks center</p>
                </div>
                <div style={S.headerBtns}>
                    {role !== 'Viewer' && (
                        <button style={S.btnP} onClick={() => { setIsEditing(false); setForm({ id: '', name: '', cronExpression: '0 0 * * *', targetType: 'local_ps', targets: '', winCommand: '', nixCommand: '', executeAt: '09:00' }); setShowAddModal(true); }}>+ Create Task</button>
                    )}
                    <button style={S.btnO} onClick={() => setShowLogsDrawer(true)}>📋 View Logs Drawer</button>
                </div>
            </div>

            {/* Dashboard Cards */}
            <div style={S.topRow}>
                <div style={S.card}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                        <span style={{ fontSize: 13, fontWeight: 900, letterSpacing: '0.06em' }}>AUTOMATION OVERVIEW</span>
                        <div style={{ display: 'flex', gap: 18 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}><span style={{ ...S.dot, background: 'var(--success)' }} /> Active Tasks ({activeTasksCount})</span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}><span style={{ ...S.dot, background: 'var(--warning)' }} /> Total Schedules ({tasks.length})</span>
                        </div>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14 }}>
                        {[
                            { label: 'Active Scheduled Jobs', val: activeTasksCount, color: 'var(--success)' },
                            { label: 'Total Executions (All Time)', val: overallTotal, color: 'var(--accent-primary)' },
                            { label: 'Failed Executions (All Time)', val: overallFailed, color: overallFailed > 0 ? 'var(--danger)' : 'var(--success)' }
                        ].map((m, i) => (
                            <div key={i} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 16 }}>
                                <span style={{ fontSize: 12, fontWeight: 800 }}>⚙️ {m.label}</span>
                                <div style={{ fontSize: 24, fontWeight: 900, marginTop: 6, color: m.color }}>{m.val}</div>
                            </div>
                        ))}
                    </div>
                </div>
                <div style={S.metCol}>
                    <div style={S.metCard}>
                        <span style={S.metLabel}>ENGINE STATUS</span>
                        <div style={{ fontSize: 14, fontWeight: 900, color: 'var(--success)' }}>🟢 Cron daemon online</div>
                    </div>
                    <div style={S.metCard}>
                        <span style={S.metLabel}>SYSTEM INTEGRATION</span>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>Provides Local Windows powershell cmd & Remote Linux SSH task execution</div>
                    </div>
                </div>
            </div>

            {/* Main Tabs / Table */}
            <div style={S.tblWrap}>
                <div style={S.tblHead}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <h3 style={S.tblTitle}>Schedules Profiles</h3>
                        <div style={S.sBox}>
                            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>▽</span>
                            <input type="text" placeholder="Search tasks..." style={S.sInput} value={filter} onChange={e => setFilter(e.target.value)} />
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                        <button style={activeTab === 'tasks' ? S.btnP : S.btnO} onClick={() => setActiveTab('tasks')}>Active Schedules</button>
                        <button style={activeTab === 'history' ? S.btnP : S.btnO} onClick={() => setActiveTab('history')}>Execution logs ({logs.length})</button>
                    </div>
                </div>

                {activeTab === 'tasks' ? (
                    <table style={S.tbl}>
                        <thead>
                            <tr>
                                <th style={S.th}>TASK NAME</th>
                                <th style={S.th}>TARGET TYPE</th>
                                <th style={S.th}>CRON SCHEDULER</th>
                                <th style={S.th}>STATUS</th>
                                <th style={S.th}>LAST RUN TIME</th>
                                <th style={S.th}>LAST RESULT</th>
                                <th style={{ ...S.th, textAlign: 'right' }}>ACTIONS</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredTasks.length === 0 && (
                                <tr>
                                    <td colSpan="7" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                        No tasks found. Click "Create Task" to add one.
                                    </td>
                                </tr>
                            )}
                            {filteredTasks.map(t => {
                                let typeBadge = '';
                                if (t.targetType === 'local_ps') typeBadge = '💻 Local PS';
                                else if (t.targetType === 'remote_linux_ssh') typeBadge = '🐧 Remote SSH';
                                else if (t.targetType === 'remote_windows_cmd') typeBadge = '🖼️ Remote Windows WMI';
                                else if (t.targetType === 'remote_windows_task') typeBadge = '⏱️ Remote Task Scheduler';
                                else if (t.targetType === 'remote_auto_cmd') typeBadge = '🤖 OS Auto-Routing';

                                return (
                                    <tr key={t.id} style={S.tr}>
                                        <td style={{ ...S.td, fontWeight: 800 }}>{t.name}</td>
                                        <td style={S.td}><span style={S.badge}>{typeBadge}</span></td>
                                        <td style={{ ...S.td, color: 'var(--accent-primary)' }}>
                                            <div style={{ fontFamily: 'monospace', fontWeight: 700 }}>{t.cronExpression}</div>
                                            {t.targetType !== 'remote_windows_task' && (
                                                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                                                    {(() => {
                                                        try {
                                                            return cronstrue.toString(t.cronExpression);
                                                        } catch (e) {
                                                            return 'Invalid Format';
                                                        }
                                                    })()}
                                                </div>
                                            )}
                                        </td>
                                        <td style={S.td}>
                                            <span style={{ ...S.badge, padding: '4px 12px', background: t.status === 'active' ? 'rgba(16,185,129,0.1)' : 'transparent', color: t.status === 'active' ? 'var(--success)' : 'var(--text-muted)', border: `1px solid ${t.status === 'active' ? 'var(--success)' : 'var(--border-color)'}` }}>
                                                {t.status === 'active' ? 'Active' : 'Disabled'}
                                            </span>
                                        </td>
                                        <td style={{ ...S.td, fontSize: 12, color: 'var(--text-muted)' }}>{t.lastRunTime}</td>
                                        <td style={S.td}>
                                            {t.lastRunStatus === 'Success' ? (
                                                <span style={{ ...S.badge, color: 'var(--success)', background: 'rgba(16,185,129,0.1)', border: '1px solid var(--success)' }}>Success</span>
                                            ) : (t.lastRunStatus === 'Failed' ? (
                                                <span style={{ ...S.badge, color: 'var(--danger)', background: 'rgba(239,68,68,0.1)', border: '1px solid var(--danger)' }}>Failed</span>
                                            ) : (
                                                <span style={{ ...S.badge, color: 'var(--text-muted)' }}>Never Run</span>
                                            ))}
                                        </td>
                                        <td style={{ ...S.td, textAlign: 'right', position: 'relative' }}>
                                            {role !== 'Viewer' ? (
                                                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                                    {runningTaskIds[t.id] !== undefined && (
                                                        <span style={{ fontSize: 11, color: 'var(--accent-primary)', fontWeight: 800 }}>⏳ Running...</span>
                                                    )}
                                                    <button 
                                                        style={{ ...S.btnO, padding: '6px 12px', fontSize: 12, borderRadius: 8, background: openDropdownId === t.id ? 'var(--bg-secondary)' : 'transparent' }}
                                                        onClick={(e) => { e.stopPropagation(); setOpenDropdownId(openDropdownId === t.id ? null : t.id); }}
                                                    >
                                                        Actions ▾
                                                    </button>
                                                    {openDropdownId === t.id && (
                                                        <div style={S.actionDropdown} onClick={e => e.stopPropagation()}>
                                                            <button 
                                                                style={S.actionItem}
                                                                disabled={runningTaskIds[t.id] !== undefined}
                                                                onClick={() => { setOpenDropdownId(null); handleRunNow(t.id, t.name); }}
                                                                onMouseEnter={e => e.target.style.background = 'var(--bg-secondary)'}
                                                                onMouseLeave={e => e.target.style.background = 'transparent'}
                                                            >
                                                                ▶️ Run Now
                                                            </button>
                                                            <button 
                                                                style={S.actionItem}
                                                                onClick={() => { setOpenDropdownId(null); handleToggleTask(t.id, t.name); }}
                                                                onMouseEnter={e => e.target.style.background = 'var(--bg-secondary)'}
                                                                onMouseLeave={e => e.target.style.background = 'transparent'}
                                                            >
                                                                {t.status === 'active' ? '⏸️ Disable' : '▶️ Enable'}
                                                            </button>
                                                            <button 
                                                                style={S.actionItem}
                                                                onClick={() => { setOpenDropdownId(null); handleEditClick(t); }}
                                                                onMouseEnter={e => e.target.style.background = 'var(--bg-secondary)'}
                                                                onMouseLeave={e => e.target.style.background = 'transparent'}
                                                            >
                                                                ✏️ Edit
                                                            </button>
                                                            <button 
                                                                style={S.actionItem}
                                                                onClick={() => {
                                                                    setOpenDropdownId(null);
                                                                    setForm({
                                                                        id: '',
                                                                        name: t.name + ' (Copy)',
                                                                        cronExpression: t.cronExpression,
                                                                        targetType: t.targetType,
                                                                        targets: (t.targets || []).join(', '),
                                                                        winCommand: t.winCommand,
                                                                        nixCommand: t.nixCommand,
                                                                        executeAt: t.executeAt || '09:00'
                                                                    });
                                                                    setIsEditing(false);
                                                                    setShowAddModal(true);
                                                                }}
                                                                onMouseEnter={e => e.target.style.background = 'var(--bg-secondary)'}
                                                                onMouseLeave={e => e.target.style.background = 'transparent'}
                                                            >
                                                                📋 Clone
                                                            </button>
                                                            <div style={{ height: 1, background: 'var(--border-color)', margin: '4px 0' }} />
                                                            <button 
                                                                style={{ ...S.actionItem, color: 'var(--danger)' }}
                                                                onClick={() => { setOpenDropdownId(null); handleDeleteClick(t); }}
                                                                onMouseEnter={e => e.target.style.background = 'rgba(239,68,68,0.1)'}
                                                                onMouseLeave={e => e.target.style.background = 'transparent'}
                                                            >
                                                                🗑️ Delete
                                                            </button>
                                                        </div>
                                                    )}
                                                </div>
                                            ) : (
                                                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>🔒 Read Only</span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                ) : (
                    /* Logs View */
                    <table style={S.tbl}>
                        <thead>
                            <tr>
                                <th style={S.th}>TASK NAME</th>
                                <th style={S.th}>EXECUTION TIME</th>
                                <th style={S.th}>STATUS</th>
                                <th style={S.th}>DURATION</th>
                                <th style={S.th}>CONSOLES STDOUT/STDERR</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.length === 0 && (
                                <tr>
                                    <td colSpan="5" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                        No logs stored. Wait for scheduled jobs to tick.
                                    </td>
                                </tr>
                            )}
                            {logs.map(l => (
                                <tr key={l.id} style={S.tr}>
                                    <td style={{ ...S.td, fontWeight: 800 }}>{l.taskName}</td>
                                    <td style={S.td}>{l.runTime}</td>
                                    <td style={S.td}>
                                        <span style={{ ...S.badge, color: l.runStatus === 'Success' ? 'var(--success)' : 'var(--danger)', background: l.runStatus === 'Success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', border: '1px solid ' + (l.runStatus === 'Success' ? 'var(--success)' : 'var(--danger)') }}>
                                            {l.runStatus}
                                        </span>
                                    </td>
                                    <td style={S.td}>{l.executionTimeMs} ms</td>
                                    <td style={S.td}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                            <div style={S.terminal}>
                                                <strong>[STDOUT]</strong><br />
                                                {l.stdout}
                                            </div>
                                            {l.stderr && (
                                                <div style={{ ...S.terminal, color: '#f87171' }}>
                                                    <strong>[STDERR]</strong><br />
                                                    {l.stderr}
                                                </div>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Status Toast */}
            {status && (
                <div style={{ position: 'fixed', bottom: 24, right: 24, padding: '14px 24px', borderRadius: 16, fontSize: 13, fontWeight: 700, zIndex: 300, background: status.type === 'error' ? 'var(--danger)' : status.type === 'info' ? 'var(--warning)' : 'var(--success)', color: '#fff', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
                    {status.msg}
                </div>
            )}

            {/* Add / Edit Task Modal */}
            {showAddModal && (
                <div style={S.overlay} onClick={() => setShowAddModal(false)}>
                    <div style={S.modal} onClick={e => e.stopPropagation()}>
                        <div style={S.modalH}>
                            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>⏱️ {isEditing ? 'Modify Scheduled Task' : 'Create Scheduled Task'}</h3>
                            <button style={S.closeBtn} onClick={() => setShowAddModal(false)}>✕</button>
                        </div>
                        <form onSubmit={handleFormSubmit} style={{ padding: '20px 28px 28px', maxHeight: '80vh', overflowY: 'auto' }}>
                            <div>
                                <label style={S.metLabel}>TASK NAME *</label>
                                <input type="text" style={S.input} required placeholder="e.g. Restart Spooler Services" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
                            </div>

                            <div style={S.gridRow}>
                                <div>
                                    <label style={S.metLabel}>TARGET TYPE *</label>
                                    <select style={S.select} value={form.targetType} onChange={e => setForm({ ...form, targetType: e.target.value })}>
                                        <option value="local_ps">Local Windows PowerShell (CIM)</option>
                                        <option value="remote_linux_ssh">Remote Linux Server Command (SSH)</option>
                                        <option value="remote_windows_cmd">Remote Windows Server WMI Process</option>
                                        <option value="remote_windows_task">Remote Windows Task Scheduler (Permanent)</option>
                                        <option value="remote_auto_cmd">Intelligent OS Auto-routing Command</option>
                                    </select>
                                </div>
                                <div>
                                    <label style={S.metLabel}>CRON PATTERN * (Not used in permanent remote task)</label>
                                    <input type="text" style={{...S.input, borderColor: (form.targetType !== 'remote_windows_task' && form.cronExpression && !/^(\S+\s){4}\S+$/.test(form.cronExpression)) ? 'var(--danger)' : 'var(--border-color)'}} required={form.targetType !== 'remote_windows_task'} placeholder="e.g. 0 9 * * * (Everyday 9AM)" value={form.cronExpression} onChange={e => setForm({ ...form, cronExpression: e.target.value })} />
                                    {form.targetType !== 'remote_windows_task' && form.cronExpression && !/^(\S+\s){4}\S+$/.test(form.cronExpression) && (
                                        <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 4 }}>Invalid Cron Format (e.g. "0 9 * * *")</div>
                                    )}
                                    {form.targetType !== 'remote_windows_task' && form.cronExpression && (() => {
                                        try {
                                            const desc = cronstrue.toString(form.cronExpression, { locale: 'zh_TW' });
                                            return <div style={{ fontSize: 11, color: 'var(--accent-primary)', marginTop: 6, fontWeight: 700 }}>👉 {desc}</div>;
                                        } catch (e) {
                                            return null;
                                        }
                                    })()}
                                </div>
                            </div>

                            {form.targetType !== 'local_ps' && (
                                <div style={{ marginTop: 14 }}>
                                    <label style={S.metLabel}>TARGET IP HOSTS * (Comma-separated for multiple)</label>
                                    <input type="text" style={S.input} required placeholder="198.51.100.10, 198.51.100.11" value={form.targets} onChange={e => setForm({ ...form, targets: e.target.value })} />
                                </div>
                            )}

                            {form.targetType === 'remote_windows_task' && (
                                <div style={{ marginTop: 14 }}>
                                    <label style={S.metLabel}>WINDOWS TASK SCHEDULE TIME * (HH:MM format)</label>
                                    <input type="text" style={S.input} required placeholder="09:00" value={form.executeAt} onChange={e => setForm({ ...form, executeAt: e.target.value })} />
                                </div>
                            )}

                            {/* Scripts Fields */}
                            {(form.targetType === 'local_ps' || form.targetType === 'remote_windows_cmd' || form.targetType === 'remote_windows_task' || form.targetType === 'remote_auto_cmd') && (
                                <div style={{ marginTop: 14 }}>
                                    <label style={{ ...S.metLabel, color: 'var(--accent-primary)' }}>POWERSHELL COMMAND / SCRIPT {form.targetType === 'remote_auto_cmd' ? '' : '*'}</label>
                                    <textarea style={S.textarea} rows="6" required={form.targetType !== 'remote_auto_cmd'} placeholder="Restart-Service spooler" value={form.winCommand} onChange={e => setForm({ ...form, winCommand: e.target.value })} />
                                </div>
                            )}

                            {(form.targetType === 'remote_linux_ssh' || form.targetType === 'remote_auto_cmd') && (
                                <div style={{ marginTop: 14 }}>
                                    <label style={{ ...S.metLabel, color: 'var(--success)' }}>LINUX SHELL COMMAND {form.targetType === 'remote_auto_cmd' ? '' : '*'}</label>
                                    <textarea style={S.textarea} rows="6" required={form.targetType !== 'remote_auto_cmd'} placeholder="systemctl restart nginx" value={form.nixCommand} onChange={e => setForm({ ...form, nixCommand: e.target.value })} />
                                </div>
                            )}

                            <button style={{ ...S.btnP, width: '100%', justifyContent: 'center', marginTop: 20 }} type="submit" disabled={loading}>
                                {loading ? 'Saving task configurations...' : (isEditing ? 'Modify Scheduler Job' : 'Register Scheduled Job')}
                            </button>
                        </form>
                    </div>
                </div>
            )}

            {/* Logs Viewer Overlay */}
            {showLogsDrawer && (
                <div style={S.overlay} onClick={() => setShowLogsDrawer(false)}>
                    <div style={{ ...S.modal, maxWidth: 850 }} onClick={e => e.stopPropagation()}>
                        <div style={S.modalH}>
                            <h3 style={{ fontSize: 18, fontWeight: 900, margin: 0 }}>📋 Comprehensive Execution History</h3>
                            <button style={S.closeBtn} onClick={() => setShowLogsDrawer(false)}>✕</button>
                        </div>
                        <div style={{ padding: 28, maxHeight: '70vh', overflowY: 'auto' }}>
                            <table style={S.tbl}>
                                <thead>
                                    <tr>
                                        <th style={S.th}>TASK</th>
                                        <th style={S.th}>TIME</th>
                                        <th style={S.th}>STATUS</th>
                                        <th style={S.th}>DURATION</th>
                                        <th style={S.th}>CONSOLES STDOUT/STDERR</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {logs.length === 0 && (
                                        <tr>
                                            <td colSpan="5" style={{ ...S.td, textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
                                                No logs stored. Wait for scheduled jobs to tick.
                                            </td>
                                        </tr>
                                    )}
                                    {logs.map(l => (
                                        <tr key={l.id} style={S.tr}>
                                            <td style={{ ...S.td, fontWeight: 800 }}>{l.taskName}</td>
                                            <td style={S.td}>{l.runTime}</td>
                                            <td style={S.td}>
                                                <span style={{ ...S.badge, color: l.runStatus === 'Success' ? 'var(--success)' : 'var(--danger)', background: l.runStatus === 'Success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', border: '1px solid ' + (l.runStatus === 'Success' ? 'var(--success)' : 'var(--danger)') }}>
                                                    {l.runStatus}
                                                </span>
                                            </td>
                                            <td style={S.td}>{l.executionTimeMs} ms</td>
                                            <td style={S.td}>
                                                <div style={S.terminal}>
                                                    <strong>[STDOUT]</strong><br />
                                                    {l.stdout}
                                                </div>
                                                {l.stderr && (
                                                    <div style={{ ...S.terminal, color: '#f87171', marginTop: 4 }}>
                                                        <strong>[STDERR]</strong><br />
                                                        {l.stderr}
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
            {/* Custom Delete Confirmation Modal */}
            {deleteConfirmTask && (
                <div style={S.overlay} onClick={() => setDeleteConfirmTask(null)}>
                    <div style={{ ...S.modal, maxWidth: 420, padding: 28, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                        <div style={{ fontSize: '3.5rem', marginBottom: '16px' }}>⚠️</div>
                        <h3 style={{ margin: '0 0 12px 0', fontSize: '1.3rem', fontWeight: '900', color: 'var(--text-primary)' }}>Confirm Delete</h3>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.6', margin: '0 0 24px 0' }}>
                            Are you sure you want to delete the scheduled task <strong>{deleteConfirmTask.name}</strong>? This action cannot be undone.
                        </p>
                        <div style={{ display: 'flex', gap: 12 }}>
                            <button type="button" className="btn btn-secondary" onClick={() => setDeleteConfirmTask(null)} style={{ flex: 1, padding: '12px', borderRadius: 12, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)', fontWeight: '700', cursor: 'pointer' }}>
                                Cancel
                            </button>
                            <button type="button" className="btn btn-primary" onClick={handleConfirmDelete} style={{ flex: 1, padding: '12px', borderRadius: 12, border: 'none', background: 'var(--danger)', color: 'white', fontWeight: '700', cursor: 'pointer' }}>
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default SchedulerManager;
