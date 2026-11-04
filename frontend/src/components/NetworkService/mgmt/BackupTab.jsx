import React, { useState, useEffect, useCallback } from 'react';
import api from '../../../api';
import { formatBytes, describeError, orderPair } from './mgmtTabs.js';

const DIFF_COLORS = {
    '+': { background: 'rgba(34,197,94,0.12)', color: 'var(--success)' },
    '-': { background: 'rgba(239,68,68,0.12)', color: 'var(--danger)' },
    ' ': { color: 'var(--text-secondary)' },
};

// Configuration backups of one device. Operator: run + list; SuperAdmin also views, compares and downloads.
export default function BackupTab({ device, s, onAlert }) {
    const [info, setInfo] = useState(null);
    const [error, setError] = useState('');
    const [running, setRunning] = useState(false);
    const [selected, setSelected] = useState([]);
    const [view, setView] = useState(null); // { kind: 'content', backup, content } | { kind: 'diff', ... }
    const [viewLoading, setViewLoading] = useState(false);

    const load = useCallback(() => {
        api.get(`/network-device/${device.id}/mgmt/backups`)
            .then(res => { setInfo(res.data); setError(''); })
            .catch(err => setError(describeError(err)));
    }, [device.id]);

    useEffect(() => { load(); }, [load]);

    const runNow = () => {
        setRunning(true);
        api.post(`/network-device/${device.id}/mgmt/backups`)
            .then(res => { onAlert(res.data.unchanged ? '設定與上一份備份相同，未另存新檔（已更新檢查時間）。' : `備份完成（${formatBytes(res.data.backup.size)}）`); load(); })
            .catch(err => { onAlert('備份失敗：' + describeError(err)); load(); })
            .finally(() => setRunning(false));
    };

    const openContent = (b) => {
        setViewLoading(true);
        api.get(`/network-device/${device.id}/mgmt/backups/${b.id}`)
            .then(res => setView({ kind: 'content', backup: res.data.backup, content: res.data.content }))
            .catch(err => onAlert('讀取失敗：' + describeError(err)))
            .finally(() => setViewLoading(false));
    };

    const compare = () => {
        const [from, to] = orderPair(info.backups, selected);
        setViewLoading(true);
        api.get(`/network-device/${device.id}/mgmt/backups/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
            .then(res => setView({ kind: 'diff', ...res.data }))
            .catch(err => onAlert('比對失敗：' + describeError(err)))
            .finally(() => setViewLoading(false));
    };

    const download = (b) => {
        api.get(`/network-device/${device.id}/mgmt/backups/${b.id}/download`, { responseType: 'blob' })
            .then(res => {
                const cd = res.headers['content-disposition'] || '';
                const name = (/filename="([^"]+)"/.exec(cd) || [])[1] || `${b.id}.${b.format || 'conf'}`;
                const url = URL.createObjectURL(res.data);
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
            .catch(err => onAlert('下載失敗：' + describeError(err)));
    };

    const toggle = (id) => setSelected(sel => (sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id].slice(-2)));

    if (error) return <div style={{ padding: 12, borderRadius: 8, background: 'rgba(239,68,68,0.1)', color: 'var(--danger)', fontSize: 13 }}>{error}</div>;
    if (!info) return <p>Loading...</p>;

    const td = { ...s.td, padding: '10px 12px', fontSize: 13 };
    const small = { ...s.btnPrimary, padding: '4px 10px', fontSize: 12 };
    const last = info.lastAttempt;

    return (
        <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                    <div>排程備份：{info.schedule ? `每日 ${info.schedule}` : '未啟用（System Settings 的 NETDEVICE_BACKUP_SCHEDULE）'} · 保留：每台最近 {info.keep} 份（內容相同不重複儲存）</div>
                    {last && (
                        <div style={{ color: last.ok ? 'var(--text-secondary)' : 'var(--danger)' }}>
                            上次執行：{new Date(last.at).toLocaleString()}（{last.trigger === 'schedule' ? '排程' : last.by}）
                            {last.ok ? (last.unchanged ? '：成功，設定未變更' : '：成功') : `：失敗 — ${last.error}`}
                        </div>
                    )}
                    {!info.canView && <div style={{ color: 'var(--text-muted)' }}>備份內容含加密密碼與預先共享金鑰，只有 SuperAdmin 可以查看、比對與下載。</div>}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                    {info.canView && (
                        <button style={{ ...s.btnPrimary, background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', opacity: selected.length === 2 ? 1 : 0.5 }}
                            disabled={selected.length !== 2 || viewLoading} onClick={compare}>Compare Selected</button>
                    )}
                    <button style={{ ...s.btnPrimary, opacity: running ? 0.6 : 1 }} disabled={running} onClick={runNow}>{running ? 'Backing up...' : 'Back Up Now'}</button>
                </div>
            </div>

            <div style={{ overflowX: 'auto' }}>
                <table style={s.table}>
                    <thead><tr>
                        {info.canView && <th style={s.th}></th>}
                        {['TIME', 'SIZE', 'LINES', 'BY', 'LAST CHECKED', ''].map(h => <th key={h} style={s.th}>{h}</th>)}
                    </tr></thead>
                    <tbody>
                        {info.backups.length === 0 ? (
                            <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: 'var(--text-muted)' }}>尚無備份</td></tr>
                        ) : info.backups.map(b => (
                            <tr key={b.id}>
                                {info.canView && <td style={td}><input type="checkbox" checked={selected.includes(b.id)} onChange={() => toggle(b.id)} /></td>}
                                <td style={{ ...td, fontWeight: 700 }}>{new Date(b.at).toLocaleString()}</td>
                                <td style={td}>{formatBytes(b.size)}</td>
                                <td style={td}>{b.lines}</td>
                                <td style={td}>{b.trigger === 'schedule' ? '排程' : b.by}</td>
                                <td style={td}>{b.checkedAt && b.checkedAt !== b.at ? new Date(b.checkedAt).toLocaleString() : '-'}</td>
                                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                                    {info.canView && (
                                        <>
                                            <button style={small} disabled={viewLoading} onClick={() => openContent(b)}>View</button>{' '}
                                            <button style={small} onClick={() => download(b)}>Download</button>
                                        </>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {view && (
                <div style={{ marginTop: 16, border: '1px solid var(--border-color)', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--bg-secondary)', fontSize: 13 }}>
                        <b>
                            {view.kind === 'content'
                                ? `備份 ${new Date(view.backup.at).toLocaleString()}`
                                : `${new Date(view.from.at).toLocaleString()} → ${new Date(view.to.at).toLocaleString()}：+${view.added} / -${view.removed}`}
                        </b>
                        <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }} onClick={() => setView(null)}>&times;</button>
                    </div>
                    <div style={{ maxHeight: 520, overflow: 'auto', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}>
                        {view.kind === 'content' && <pre style={{ margin: 0, padding: 12, whiteSpace: 'pre' }}>{view.content}</pre>}
                        {view.kind === 'diff' && (view.hunks.length === 0
                            ? <p style={{ padding: 12, margin: 0 }}>兩份備份內容相同。</p>
                            : view.hunks.map((h, i) => (
                                <div key={i} style={{ borderTop: i ? '1px dashed var(--border-color)' : 'none' }}>
                                    <div style={{ padding: '2px 12px', color: 'var(--text-muted)', background: 'var(--bg-tertiary)' }}>@@ 舊 {h.aStart} / 新 {h.bStart} @@</div>
                                    {h.lines.map((l, j) => (
                                        <div key={j} style={{ padding: '0 12px', whiteSpace: 'pre', ...DIFF_COLORS[l.t] }}>{l.t}{' '}{l.s}</div>
                                    ))}
                                </div>
                            )))}
                        {view.kind === 'diff' && view.truncated && <p style={{ padding: 12, margin: 0, color: 'var(--warning)' }}>差異過多，只顯示前 5000 行；請下載兩份備份自行比對。</p>}
                    </div>
                </div>
            )}
        </div>
    );
}
