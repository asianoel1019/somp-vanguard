/**
 * Per-user AI Agent conversation history in document_store.
 * Key: agent/conversations/<username@domain>.json — max 50 conversations, 30-day retention.
 */
const crypto = require('crypto');
const { readDataSync, writeDataSync } = require('../db');

const MAX_CONVERSATIONS = 50;
const RETENTION_MS = 30 * 24 * 3600 * 1000;
const TITLE_CHARS = 40;
const MAX_MESSAGES_PER_CONVERSATION = 100;
const ID_RE = /^conv-[0-9a-f-]{12}$/;

function userKey(user) {
    const raw = `${user.username}@${user.domain || 'local'}`.toLowerCase();
    const safe = raw.replace(/[^a-z0-9@._-]/g, '_');
    if (safe === raw) return safe;
    return `${safe}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)}`;
}

const storeKey = (user) => `agent/conversations/${userKey(user)}.json`;

function newConversationId() {
    return `conv-${crypto.randomUUID().slice(0, 12)}`;
}

function load(user, now) {
    const list = readDataSync(storeKey(user), []);
    const cutoff = now.getTime() - RETENTION_MS;
    return (Array.isArray(list) ? list : []).filter(c => new Date(c.updatedAt).getTime() >= cutoff);
}

function save(user, list) {
    list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    writeDataSync(storeKey(user), list.slice(0, MAX_CONVERSATIONS));
}

function listConversations(user, now = new Date()) {
    return load(user, now)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
}

function getConversation(user, id, now = new Date()) {
    return load(user, now).find(c => c.id === id) || null;
}

function appendTurn(user, { conversationId, question, answer, steps = [], suggestions = [], error, title }, now = new Date()) {
    const list = load(user, now);
    const iso = now.toISOString();
    const id = typeof conversationId === 'string' && ID_RE.test(conversationId) ? conversationId : newConversationId();
    let conv = list.find(c => c.id === id);
    if (!conv) {
        conv = { id, title: String(title || question).slice(0, TITLE_CHARS), createdAt: iso, updatedAt: iso, messages: [] };
        list.push(conv);
    }
    conv.messages.push({ role: 'user', content: question, at: iso });
    conv.messages.push({ role: 'assistant', content: answer || '', at: iso, steps, suggestions, ...(error ? { error } : {}) });
    if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
        conv.messages = conv.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
    }
    conv.updatedAt = iso;
    save(user, list);
    return conv;
}

function deleteConversation(user, id) {
    const list = load(user, new Date());
    const idx = list.findIndex(c => c.id === id);
    if (idx < 0) return false;
    list.splice(idx, 1);
    save(user, list);
    return true;
}

function historyForModel(conversation) {
    if (!conversation) return [];
    return conversation.messages
        .filter(m => m.content && !m.error)
        .map(m => ({ role: m.role, content: m.content }));
}

module.exports = { userKey, newConversationId, listConversations, getConversation, appendTurn, deleteConversation, historyForModel };
