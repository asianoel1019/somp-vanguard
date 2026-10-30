import React, { useCallback, useEffect, useRef, useState } from 'react';
import MarkdownView from './MarkdownView.jsx';
import { streamAgentChat, listConversations, getConversation, deleteConversation, requestOpen } from './agentClient';

const TOOL_ICONS = {
    find_host: '🔍', get_host_metrics: '📈', list_alerts: '🔔', search_logs: '📜',
    get_host_change_history: '🕘', search_runbooks: '📖', get_runbook: '📖', list_workflows: '⚡', suggest_actions: '💡',
};

const S = {
    panel: {
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, maxWidth: '100vw', zIndex: 900,
        background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border-color)',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column',
    },
    header: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border-color)' },
    iconBtn: { background: 'none', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', cursor: 'pointer', padding: '3px 8px', fontSize: 12 },
    body: { flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 },
    user: { alignSelf: 'flex-end', maxWidth: '85%', background: 'var(--accent-primary)', color: '#fff', padding: '8px 12px', borderRadius: '12px 12px 2px 12px', fontSize: 13, whiteSpace: 'pre-wrap' },
    assistant: { background: 'var(--bg-primary)', border: '1px solid var(--border-color)', padding: '10px 12px', borderRadius: '12px 12px 12px 2px' },
    step: { fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' },
    card: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 10px', marginTop: 6, borderRadius: 8, border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.03)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12 },
    footer: { borderTop: '1px solid var(--border-color)', padding: 10, display: 'flex', gap: 8 },
    input: { flex: 1, resize: 'none', minHeight: 44, maxHeight: 140, background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 8, fontSize: 13 },
    history: { position: 'absolute', top: 48, left: 10, right: 10, maxHeight: 320, overflowY: 'auto', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 8, zIndex: 1, boxShadow: '0 8px 24px rgba(0,0,0,0.35)' },
};

function formatArgs(args) {
    try {
        const s = Object.entries(args || {}).map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`).join(', ');
        return s.length > 80 ? `${s.slice(0, 80)}…` : s;
    } catch {
        return '';
    }
}

function StepLine({ step }) {
    const status = step.running ? '⏳' : step.ok ? '✓' : '✗';
    return (
        <details style={S.step}>
            <summary style={{ cursor: 'pointer' }}>
                {TOOL_ICONS[step.tool] || '🔧'} {step.tool}({formatArgs(step.args)}) {status}
                {step.durationMs !== undefined && !step.running ? ` ${step.durationMs}ms` : ''}
            </summary>
            <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', fontSize: 11 }}>
                {JSON.stringify(step.args || {}, null, 2)}
                {step.summary ? `\n→ ${step.summary}` : ''}
            </pre>
        </details>
    );
}

const updateLastMessage = (setMessages, fn) => setMessages(prev => {
    if (!prev.length) return prev;
    const next = [...prev];
    next[next.length - 1] = fn({ ...next[next.length - 1] });
    return next;
});

export default function AgentPanel({ open, onClose, request, setActiveView }) {
    const [conversationId, setConversationId] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [running, setRunning] = useState(false);
    const [history, setHistory] = useState([]);
    const [showHistory, setShowHistory] = useState(false);
    const abortRef = useRef(null);
    const endRef = useRef(null);
    const handledRequestRef = useRef(null);

    useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);
    useEffect(() => () => abortRef.current?.abort(), []);

    const refreshHistory = useCallback(async () => {
        try { setHistory(await listConversations()); } catch { setHistory([]); }
    }, []);
    useEffect(() => {
        if (open) refreshHistory();
    }, [open, refreshHistory]);

    const send = useCallback(async (text, alertId, { fresh = false } = {}) => {
        const message = (text || '').trim();
        if (!message || running) return;
        const convId = fresh ? null : conversationId;
        if (fresh) setConversationId(null);
        setMessages(prev => [...(fresh ? [] : prev),
            { role: 'user', content: message },
            { role: 'assistant', content: '', steps: [], suggestions: [], pending: true }]);
        setInput('');
        setRunning(true);
        const controller = new AbortController();
        abortRef.current = controller;
        const updateLast = (fn) => updateLastMessage(setMessages, fn);
        try {
            await streamAgentChat({
                message, conversationId: convId, alertId, signal: controller.signal,
                onEvent: (event, data) => {
                    if (event === 'conversation') setConversationId(data.conversationId);
                    else if (event === 'step_start') updateLast(m => ({ ...m, steps: [...m.steps, { ...data, running: true }] }));
                    else if (event === 'step_end') updateLast(m => ({ ...m, steps: m.steps.map(s => (s.id === data.id ? { ...s, ...data, running: false } : s)) }));
                    else if (event === 'notice') updateLast(m => ({ ...m, notice: data.message }));
                    else if (event === 'answer') updateLast(m => ({ ...m, content: data.text, suggestions: data.suggestions || [], notice: undefined }));
                    else if (event === 'error') updateLast(m => ({ ...m, error: data.message }));
                },
            });
        } catch (e) {
            updateLast(m => ({ ...m, error: e.name === 'AbortError' ? '已停止' : e.message }));
        } finally {
            updateLast(m => ({ ...m, pending: false, steps: (m.steps || []).map(s => ({ ...s, running: false })) }));
            setRunning(false);
            abortRef.current = null;
            refreshHistory();
        }
    }, [conversationId, running, refreshHistory]);

    // "🤖 調查" from alert lists: start a fresh conversation
    useEffect(() => {
        if (!open || !request || handledRequestRef.current === request || running) return;
        handledRequestRef.current = request;
        send(request.prompt, request.alertId, { fresh: true });
    }, [open, request, running, send]);

    const stop = () => abortRef.current?.abort();
    const newChat = () => { if (running) return; setConversationId(null); setMessages([]); setShowHistory(false); };
    const openConversation = async (id) => {
        if (running) return;
        try {
            const conv = await getConversation(id);
            setConversationId(conv.id);
            setMessages(conv.messages.map(m => ({ ...m, steps: m.steps || [], suggestions: m.suggestions || [] })));
        } catch (e) {
            setMessages([{ role: 'assistant', content: '', error: `無法載入對話：${e.response?.data?.error || e.message}`, steps: [], suggestions: [] }]);
        }
        setShowHistory(false);
    };
    const removeConversation = async (id) => {
        try { await deleteConversation(id); } catch { /* already gone */ }
        if (id === conversationId) newChat();
        refreshHistory();
    };

    if (!open) return null;

    return (
        <div style={S.panel} role="dialog" aria-label="AI Ops Agent">
            <div style={{ ...S.header, position: 'relative' }}>
                <span style={{ fontSize: 18 }}>🤖</span>
                <span style={{ fontWeight: 800, fontSize: 14, flex: 1 }}>AI Ops Agent</span>
                <button style={S.iconBtn} onClick={() => setShowHistory(s => !s)} disabled={running}>🕘 歷史</button>
                <button style={S.iconBtn} onClick={newChat} disabled={running}>＋ 新對話</button>
                <button style={S.iconBtn} onClick={onClose} aria-label="關閉">✕</button>
                {showHistory && (
                    <div style={S.history}>
                        {history.length === 0 && <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>沒有對話紀錄</div>}
                        {history.map(c => (
                            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--border-color)' }}>
                                <button style={{ ...S.card, marginTop: 0, border: 'none', background: 'none', padding: 0, flex: 1 }} onClick={() => openConversation(c.id)}>
                                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
                                    <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{new Date(c.updatedAt).toLocaleString('zh-TW', { hour12: false })}</span>
                                </button>
                                <button style={S.iconBtn} onClick={() => removeConversation(c.id)} aria-label="刪除對話">🗑</button>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div style={S.body}>
                {messages.length === 0 && (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.7 }}>
                        描述你要調查的問題，例如：<br />
                        「web-03 從下午兩點開始 CPU 很高，幫我查原因」<br />
                        「db-01 昨晚有沒有異常的日誌？」<br /><br />
                        Agent 只會查詢資料並提供建議，不會執行任何動作。
                    </div>
                )}
                {messages.map((m, i) => (m.role === 'user' ? (
                    <div key={i} style={S.user}>{m.content}</div>
                ) : (
                    <div key={i} style={S.assistant}>
                        {(m.steps || []).length > 0 && (
                            <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                {m.steps.map(s => <StepLine key={s.id} step={s} />)}
                            </div>
                        )}
                        {m.pending && !m.content && !m.error && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>⏳ 調查中…</div>}
                        {m.pending && m.notice && !m.content && <div style={{ fontSize: 12, color: '#f59e0b', marginTop: 4 }}>{m.notice}</div>}
                        {m.content && <MarkdownView text={m.content} />}
                        {(m.suggestions || []).map(s => (
                            <button key={`${s.type}:${s.id}`} style={S.card} onClick={() => requestOpen(s.type, s.id, setActiveView)}>
                                <span>{s.type === 'runbook' ? '📖' : '⚡'}</span>
                                <span style={{ flex: 1 }}>{s.title}</span>
                                <span style={{ color: 'var(--accent-primary)', fontWeight: 700 }}>{s.type === 'runbook' ? '開啟 Runbook →' : '前往 Workflow →'}</span>
                            </button>
                        ))}
                        {m.error && <div style={{ marginTop: 6, color: '#ef4444', fontSize: 12 }}>⚠️ {m.error}</div>}
                    </div>
                )))}
                <div ref={endRef} />
            </div>

            <div style={S.footer}>
                <textarea
                    style={S.input}
                    value={input}
                    placeholder="輸入問題，Enter 送出，Shift+Enter 換行"
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
                    disabled={running}
                />
                {running
                    ? <button style={{ ...S.iconBtn, background: '#ef4444', color: '#fff', border: 'none' }} onClick={stop}>■ 停止</button>
                    : <button style={{ ...S.iconBtn, background: 'var(--accent-primary)', color: '#fff', border: 'none' }} onClick={() => send(input)} disabled={!input.trim()}>送出</button>}
            </div>
        </div>
    );
}
