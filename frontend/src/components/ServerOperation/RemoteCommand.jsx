import { useConfirm } from '../../contexts/ConfirmContext';
import React, { useState, useRef } from 'react';
import { useToast } from '../../contexts/ToastContext';

// Same rule as the backend (services/remoteCommandService.js): IPv4 or DNS host name only
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const isValidTarget = (t) => (/^[0-9.]+$/.test(t) ? IPV4.test(t) : HOSTNAME.test(t));
const MAX_TARGETS = 200;

function parseTargets(text) {
    const seen = new Set();
    const targets = [];
    for (const raw of text.split('\n')) {
        const t = raw.trim();
        if (!t || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        targets.push(t);
    }
    return targets;
}

function currentUser() {
    try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; }
}

const RemoteCommand = ({ linuxPassword, setLinuxPassword, linuxAdminUser }) => {
    const { showToast } = useToast();
    const { showConfirm } = useConfirm();
    const abortRef = useRef(null);
    const [winPassword, setWinPassword] = useState('');
    const [ips, setIps] = useState('');
    const [winCommand, setWinCommand] = useState('');
    const [nixCommand, setNixCommand] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [library, setLibrary] = useState([]);
    const [showLibrary, setShowLibrary] = useState(false);
    const [newCmd, setNewCmd] = useState({ name: '', category: 'Custom', winCommand: '', nixCommand: '' });
    const [monitors, setMonitors] = useState([]);

    React.useEffect(() => {
        fetchLibrary();
        const token = localStorage.getItem('token');
        fetch('/api/monitor/data/dashboard', { headers: { 'Authorization': `Bearer ${token}` } })
            .then(r => r.json())
            .then(data => setMonitors(data.monitors || []))
            .catch(err => console.error('Failed to fetch monitors:', err));
    }, []);

    const fetchLibrary = async () => {
        try {
            const token = localStorage.getItem('token');
            const r = await fetch('/api/cmd-library', { headers: { 'Authorization': `Bearer ${token}` } });
            const data = await r.json();
            if (data.success) setLibrary(data.commands);
        } catch (e) {
            console.error('Failed to load command library', e);
        }
    };

    const handleSaveCustom = async (e) => {
        e.preventDefault();
        try {
            const token = localStorage.getItem('token');
            const r = await fetch('/api/cmd-library', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(newCmd)
            });
            const data = await r.json();
            if (data.success) {
                setNewCmd({ name: '', category: 'Custom', winCommand: '', nixCommand: '' });
                fetchLibrary();
            } else {
                showToast('Failed: ' + data.error, "error");
            }
        } catch (e) {
            console.error(e);
        }
    };

    const handleDeleteCustom = async (id) => {
        if (!await showConfirm('Delete this custom command?')) return;
        try {
            const token = localStorage.getItem('token');
            const r = await fetch(`/api/cmd-library/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await r.json();
            if (data.success) fetchLibrary();
        } catch (e) {
            console.error(e);
        }
    };

    const applyCommand = (cmd) => {
        if (cmd.winCommand) setWinCommand(cmd.winCommand);
        if (cmd.nixCommand) setNixCommand(cmd.nixCommand);
        setShowLibrary(false);
    };

    const handleExecute = async () => {
        const ipList = parseTargets(ips);
        if (ipList.length === 0) {
            showToast('請輸入目標 IP / 主機名稱', 'error');
            return;
        }
        if (!winCommand.trim() && !nixCommand.trim()) {
            showToast('請至少輸入一個指令（Windows 或 Linux）', 'error');
            return;
        }
        const invalid = ipList.filter(t => !isValidTarget(t));
        if (invalid.length > 0) {
            showToast(`IP / 主機名稱格式不正確：${invalid.slice(0, 5).join(', ')}${invalid.length > 5 ? ` 等 ${invalid.length} 筆` : ''}`, 'error');
            return;
        }
        if (ipList.length > MAX_TARGETS) {
            showToast(`一次最多 ${MAX_TARGETS} 台主機（目前 ${ipList.length} 台）`, 'error');
            return;
        }

        setLoading(true);
        const controller = new AbortController();
        abortRef.current = controller;

        // Initialize results with "Processing" state for each IP
        setResults(ipList.map(ip => ({ ip, status: 'Processing', os: 'Checking...', output: 'Waiting for progress...' })));

        try {
            const token = localStorage.getItem('token');
            const response = await fetch('/api/ops/command', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    ips: ipList,
                    winCommand,
                    nixCommand,
                    linuxPassword,
                    winPassword
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const errText = await response.text();
                let message = errText;
                try { message = JSON.parse(errText).error || errText; } catch { /* plain text */ }
                throw new Error(message || 'Network response was not ok');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let partialBuffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                partialBuffer += decoder.decode(value, { stream: true });
                const lines = partialBuffer.split('\n');
                partialBuffer = lines.pop(); // Keep the last partial line in buffer

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const chunk = JSON.parse(line);
                        setResults(prev => prev.map(r => r.ip === chunk.ip ? chunk : r));
                    } catch (e) {
                        console.error('Error parsing NDJSON chunk:', e, line);
                    }
                }
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                showToast('已停止：尚未開始的主機不會執行', 'info');
            } else {
                console.error(err);
                showToast('Command execution failed: ' + err.message, "error");
            }
        } finally {
            abortRef.current = null;
            // Hosts that never reported back (stopped, or the stream ended early): not started ones never run,
            // ones already running on the server finish there without a result here
            setResults(prev => prev.map(r => r.status === 'Processing'
                ? { ...r, status: 'Stopped', os: '-', output: '已停止，未收到結果。尚未開始的主機不會執行；若此主機已在執行中，指令仍會在遠端跑完。' }
                : r));
            setLoading(false);
        }
    };

    const handleStop = () => {
        if (abortRef.current) abortRef.current.abort();
    };

    return (
        <div className="animate-fade-in p-4">
            {/* Header */}
            <div className="mb-6 flex justify-between items-center px-1">
                <div>
                        <h1 className="page-title">
                            Remote Command
                        </h1>
                        <p className="page-subtitle">Remote Shell Execution Framework</p>
                </div>
                <button 
                    className="btn btn-secondary px-4 py-2" 
                    style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                    onClick={() => setShowLibrary(true)}
                >
                    📚 Command Library
                </button>
            </div>

            <div className="glass-panel p-6 mb-6">
                <h3 className="mb-4">⚡ Intelligent Remote Command</h3>

                <div className="grid grid-cols-2 gap-4 mb-4">
                    <div>
                        <label className="text-secondary text-sm mb-2 block">Target IPs / Hostnames (One per line)</label>
                        <textarea
                            className="w-full"
                            rows="4"
                            style={{ height: '140px' }}
                            placeholder="192.168.1.10&#10;192.168.1.11"
                            value={ips}
                            onChange={(e) => setIps(e.target.value)}
                        />
                    </div>
                    <div>
                        <label className="text-secondary text-sm mb-2 block">Linux SSH Credential</label>
                        <p className="text-muted text-xs mb-2">Password for <code>{linuxAdminUser}</code>.</p>
                        <input
                            type="password"
                            className="w-full mb-4"
                            placeholder={`Password for '${linuxAdminUser}'`}
                            value={linuxPassword}
                            onChange={(e) => setLinuxPassword(e.target.value)}
                        />
                        <label className="text-secondary text-sm mb-2 block">Windows 帳密</label>
                        {(() => {
                            const u = currentUser();
                            const isAd = u.username && u.domain && u.domain !== 'local';
                            return (
                                <>
                                    <p className="text-muted text-xs mb-2">
                                        {isAd
                                            ? <>以 <code>{u.domain}\{u.username}</code> 執行（輸入你的 Windows 密碼）；連線失敗或未輸入密碼時改用服務帳號。</>
                                            : <>本機帳號登入：Windows 一律以服務帳號執行。</>}
                                    </p>
                                    {isAd && (
                                        <input
                                            type="password"
                                            className="w-full mb-4"
                                            placeholder="你的 Windows 密碼（選填）"
                                            autoComplete="off"
                                            value={winPassword}
                                            onChange={(e) => setWinPassword(e.target.value)}
                                        />
                                    )}
                                </>
                            );
                        })()}
                        <div className="p-3 rounded bg-blue-500/10 border border-blue-500/20">
                            <h4 className="text-xs font-bold text-blue-400 uppercase tracking-wider mb-1">System Intelligence</h4>
                            <p className="text-xs text-muted">OS will be auto-detected per IP. Commands will be routed accordingly.</p>
                        </div>
                    </div>
                </div>

                {(() => {
                    const ipList = parseTargets(ips);
                    let winCount = 0;
                    let nixCount = 0;
                    let unknownCount = 0;

                    ipList.forEach(ip => {
                        const found = monitors.find(m => m.ip === ip || m.name === ip);
                        if (!found) {
                            unknownCount++;
                        } else if (String(found.os || '').toLowerCase().includes('win')) {
                            winCount++;
                        } else {
                            nixCount++;
                        }
                    });

                    return (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
                            <div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                    <label className="text-secondary text-sm block font-semibold text-blue-400">🖼️ Windows (PowerShell)</label>
                                    {ipList.length > 0 && (
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                            {winCount > 0 ? `Targeting ${winCount} Win host(s)` : unknownCount > 0 ? `(${unknownCount} Auto-detect)` : 'No Win targets'}
                                        </span>
                                    )}
                                </div>
                                <textarea
                                    className="w-full"
                                    rows="3"
                                    style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
                                    placeholder="e.g. Restart-Service spooler"
                                    value={winCommand}
                                    onChange={(e) => setWinCommand(e.target.value)}
                                />
                                <p className="text-xs text-muted mt-1">If empty, Windows targets will be skipped.</p>
                            </div>
                            <div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                    <label className="text-secondary text-sm block font-semibold text-green-400">🐧 Linux (Shell Script)</label>
                                    {ipList.length > 0 && (
                                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                            {nixCount > 0 ? `Targeting ${nixCount} Linux host(s)` : unknownCount > 0 ? `(${unknownCount} Auto-detect)` : 'No Linux targets'}
                                        </span>
                                    )}
                                </div>
                                <textarea
                                    className="w-full"
                                    rows="3"
                                    style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
                                    placeholder="e.g. systemctl restart nginx"
                                    value={nixCommand}
                                    onChange={(e) => setNixCommand(e.target.value)}
                                />
                                <p className="text-xs text-muted mt-1">If empty, Linux targets will be skipped.</p>
                            </div>
                        </div>
                    );
                })()}

                <div className="flex justify-end gap-3 flex-wrap">
                    {(winCommand.trim() || nixCommand.trim()) && (
                        <button 
                            className="btn btn-secondary px-6 py-3"
                            style={{ background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '8px', cursor: 'pointer', marginRight: '5px', fontSize: '13px', fontWeight: 'bold' }}
                            onClick={async () => {
                                const winEsc = encodeURIComponent(winCommand.trim());
                                const nixEsc = encodeURIComponent(nixCommand.trim());
                                const ipsEsc = encodeURIComponent(ips.trim());
                                window.location.href = `/?winCmd=${winEsc}&nixCmd=${nixEsc}&ips=${ipsEsc}`;
                            }}
                        >
                            📅 Save as Scheduled Task
                        </button>
                    )}
                    {loading && (
                        <button
                            className="btn btn-secondary px-6 py-3"
                            style={{ background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold' }}
                            onClick={handleStop}
                            title="停止派送：尚未開始的主機不會執行"
                        >
                            ⏹ 停止
                        </button>
                    )}
                    <button className="btn btn-primary px-8 py-3" onClick={handleExecute} disabled={loading}>
                        {loading ? (
                            <span className="flex items-center">
                                <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                Executing Streams...
                            </span>
                        ) : '⚡ Execute on All Targets'}
                    </button>
                </div>
            </div>

            {results.length > 0 && (
                <div className="grid grid-cols-1 gap-4">
                    <h3 className="px-2 text-sm font-bold text-secondary uppercase tracking-widest">Real-time Execution Output</h3>
                    {results.map((r, idx) => (
                        <div key={idx} className="glass-panel p-4" style={{
                            backgroundColor: r.status === 'Processing' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(0,0,0,0.3)',
                            borderLeft: r.status === 'Processing' ? '4px solid #3b82f6' : (r.status === 'Skipped' ? '4px solid #94a3b8' : 'none')
                        }}>
                            <div className="flex justify-between items-center mb-3">
                                <div>
                                    <span className="font-semibold text-lg">{r.ip}</span>
                                    <span className={`ml-2 text-xs px-2 py-0.5 rounded ${r.os === 'Windows' ? 'bg-blue-500/20 text-blue-400' : 'bg-green-500/20 text-green-400'}`}>
                                        {r.os}
                                    </span>
                                    {r.runAs && (
                                        <span
                                            className={`ml-2 text-xs px-2 py-0.5 rounded ${r.runAs === 'service' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-blue-500/20 text-blue-400'}`}
                                            title={r.runAsName || ''}
                                        >
                                            {r.runAs === 'service' ? '服務帳號' : '個人帳號'}
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center">
                                    {r.status === 'Processing' && <div className="dot-loading mr-3"></div>}
                                    <span className={`inline-block px-2 py-1 rounded text-xs font-bold ${r.status === 'Online' ? 'badge-success' :
                                            (r.status === 'Processing' ? 'bg-blue-500 text-white' :
                                                (r.status === 'Skipped' ? 'bg-gray-500 text-white' : 'badge-danger'))
                                        }`}>
                                        {r.status}
                                    </span>
                                </div>
                            </div>
                            <div style={{ background: '#0f172a', borderRadius: '8px', border: '1px solid #1e293b', overflow: 'hidden', marginTop: 12 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', padding: '6px 16px', fontSize: 11, color: 'var(--text-secondary)' }}>
                                    <span style={{ fontFamily: 'monospace' }}>CONSOLE LOGS ({r.ip})</span>
                                    <button 
                                        onClick={() => {
                                            navigator.clipboard.writeText(r.output || '');
                                            showToast('Console output copied!');
                                        }}
                                        style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 10 }}
                                    >
                                        📋 Copy Logs
                                    </button>
                                </div>
                                <pre style={{
                                    margin: 0,
                                    padding: '12px 16px',
                                    color: r.status === 'Processing' ? '#38bdf8' : (r.status === 'Failed' ? '#f87171' : '#34d399'),
                                    fontFamily: "'Fira Code', monospace",
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-all',
                                    fontSize: '12.5px',
                                    maxHeight: '220px',
                                    overflowY: 'auto',
                                    minHeight: '3.5rem'
                                }}>
                                    {r.output || (r.status === 'Processing' ? 'Detecting OS and establishing connection...' : 'No output returned.')}
                                </pre>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {showLibrary && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: 'center' }} onClick={() => setShowLibrary(false)}>
                    <div style={{ background: 'var(--bg-primary)', width: '85%', maxWidth: 1000, maxHeight: '90vh', borderRadius: 12, display: 'flex', flexDirection: 'column', border: '1px solid var(--border-color)', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
                        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-secondary)' }}>
                            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>📚 Command Library</h2>
                            <button onClick={() => setShowLibrary(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 20, cursor: 'pointer' }}>✕</button>
                        </div>
                        <div style={{ flex: 1, overflowY: 'auto', padding: 24, display: 'flex', gap: 24 }}>
                            <div style={{ flex: 2 }}>
                                <h3 style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 16 }}>Available Commands</h3>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                    {library.map(c => (
                                        <div key={c.id} style={{ background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                                            <div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                                    <span style={{ fontWeight: 800, color: c.type === 'preset' ? 'var(--accent-primary)' : 'var(--success)' }}>{c.name}</span>
                                                    <span style={{ fontSize: 10, padding: '2px 6px', background: 'rgba(255,255,255,0.1)', borderRadius: 4, color: 'var(--text-muted)' }}>{c.category}</span>
                                                </div>
                                                <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace', marginBottom: 12 }}>
                                                    {c.winCommand && <div style={{ marginBottom: 4 }}><span style={{color:'var(--blue)'}}>Win:</span> <span title={c.winCommand}>{c.winCommand.substring(0,50)}{c.winCommand.length>50?'...':''}</span></div>}
                                                    {c.nixCommand && <div><span style={{color:'var(--green)'}}>Nix:</span> <span title={c.nixCommand}>{c.nixCommand.substring(0,50)}{c.nixCommand.length>50?'...':''}</span></div>}
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-color)' }}>
                                                <button style={{ padding: '6px 16px', background: 'var(--accent-primary)', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 'bold' }} onClick={() => applyCommand(c)}>Use Command</button>
                                                {c.type === 'custom' && <button style={{ padding: '6px 12px', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 4, cursor: 'pointer', fontSize: 12 }} onClick={() => handleDeleteCustom(c.id)}>Del</button>}
                                            </div>
                                        </div>
                                    ))}
                                    {library.length === 0 && <div style={{ color: 'var(--text-muted)' }}>No commands available.</div>}
                                </div>
                            </div>
                            <div style={{ flex: 1, background: 'var(--bg-secondary)', padding: 20, borderRadius: 8, border: '1px solid var(--border-color)', height: 'fit-content', position: 'sticky', top: 0 }}>
                                <h3 style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 16 }}>➕ Save Custom Command</h3>
                                <form onSubmit={handleSaveCustom} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                    <div>
                                        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Command Name *</label>
                                        <input type="text" required style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'white', fontSize: 13 }} value={newCmd.name} onChange={e => setNewCmd({...newCmd, name: e.target.value})} placeholder="e.g. Check Custom App Status" />
                                    </div>
                                    <div>
                                        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>Category</label>
                                        <input type="text" style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'white', fontSize: 13 }} value={newCmd.category} onChange={e => setNewCmd({...newCmd, category: e.target.value})} placeholder="e.g. My Apps" />
                                    </div>
                                    <div>
                                        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', display: 'block', marginBottom: 4 }}>Windows Command</label>
                                        <textarea rows="3" style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'white', fontFamily: 'monospace', fontSize: 12 }} value={newCmd.winCommand} onChange={e => setNewCmd({...newCmd, winCommand: e.target.value})} placeholder="Get-Service customApp" />
                                    </div>
                                    <div>
                                        <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--green)', display: 'block', marginBottom: 4 }}>Linux Command</label>
                                        <textarea rows="3" style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'white', fontFamily: 'monospace', fontSize: 12 }} value={newCmd.nixCommand} onChange={e => setNewCmd({...newCmd, nixCommand: e.target.value})} placeholder="systemctl status customapp" />
                                    </div>
                                    <button type="submit" style={{ padding: '12px 16px', background: 'var(--accent-primary)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 800, marginTop: 8 }}>Save Command</button>
                                </form>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default RemoteCommand;
