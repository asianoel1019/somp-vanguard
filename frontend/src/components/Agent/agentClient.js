import api from '../../api';
import { parseSseBuffer } from './agentProtocol';

export async function streamAgentChat({ message, conversationId, alertId, signal, onEvent }) {
    window.dispatchEvent(new Event('app-activity'));
    const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
        },
        body: JSON.stringify({ message, conversationId: conversationId || undefined, alertId: alertId || undefined }),
        signal,
    });
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const body = await res.json(); if (body.error) msg = body.error; } catch { /* non-JSON error body */ }
        if (res.status === 401) msg = '登入已過期，請重新登入。';
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseBuffer(buffer);
        buffer = rest;
        events.forEach(e => onEvent(e.event, e.data));
    }
    parseSseBuffer(`${buffer}\n\n`).events.forEach(e => onEvent(e.event, e.data));
}

export const listConversations = () => api.get('/agent/conversations').then(r => r.data);
export const getConversation = (id) => api.get(`/agent/conversations/${encodeURIComponent(id)}`).then(r => r.data);
export const deleteConversation = (id) => api.delete(`/agent/conversations/${encodeURIComponent(id)}`).then(r => r.data);

export function requestOpen(type, id, setActiveView) {
    window.__sompPendingOpen = { type, id };
    setActiveView(type === 'runbook' ? 'RUNBOOK' : 'WORKFLOW');
    window.dispatchEvent(new CustomEvent(`somp:open-${type}`, { detail: { id } }));
}
