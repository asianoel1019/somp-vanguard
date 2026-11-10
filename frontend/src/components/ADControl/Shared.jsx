// Shared pieces of AD Control: buttons, status pills, the message banner, dialogs and a selectable table.
import React, { useState } from 'react';
import { FiCheckCircle, FiAlertCircle, FiInfo, FiX, FiCopy } from 'react-icons/fi';
import { useToast } from '../../contexts/ToastContext';

const TONES = {
    default: { fg: 'var(--text-primary)', border: 'var(--border-color)', bg: 'transparent' },
    primary: { fg: '#fff', border: 'var(--accent-primary)', bg: 'var(--accent-primary)' },
    success: { fg: '#10b981', border: '#10b98166', bg: 'rgba(16,185,129,0.08)' },
    danger: { fg: '#ef4444', border: '#ef444466', bg: 'rgba(239,68,68,0.08)' },
    warning: { fg: '#f59e0b', border: '#f59e0b66', bg: 'rgba(245,158,11,0.08)' },
    info: { fg: '#3b82f6', border: '#3b82f666', bg: 'rgba(59,130,246,0.08)' },
};

export function Btn({ icon, label, tone = 'default', onClick, disabled, loading, title, small }) {
    const t = TONES[tone] || TONES.default;
    return (
        <button type="button" title={title} disabled={disabled || loading} onClick={onClick}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap', cursor: disabled || loading ? 'default' : 'pointer',
                padding: small ? '3px 9px' : '6px 12px', fontSize: small ? '12px' : '12.5px', fontWeight: 600, borderRadius: '8px',
                color: t.fg, border: `1px solid ${t.border}`, background: t.bg, opacity: disabled || loading ? 0.55 : 1 }}>
            {icon}{loading ? '…' : label}
        </button>
    );
}

export function Pill({ tone = 'default', children, icon }) {
    const t = TONES[tone] || TONES.default;
    return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 8px', borderRadius: '999px', fontSize: '11.5px', fontWeight: 600,
            color: t.fg === '#fff' ? 'var(--accent-primary)' : t.fg, border: `1px solid ${t.border}`, background: t.bg === 'transparent' ? 'transparent' : t.bg, whiteSpace: 'nowrap' }}>
            {icon}{children}
        </span>
    );
}

/** message: { type: 'success' | 'error' | 'info', text } */
export function Banner({ message, onClose }) {
    if (!message) return null;
    const tone = message.type === 'success' ? 'success' : message.type === 'error' ? 'danger' : 'info';
    const t = TONES[tone];
    const Icon = message.type === 'success' ? FiCheckCircle : message.type === 'error' ? FiAlertCircle : FiInfo;
    return (
        <div role={message.type === 'error' ? 'alert' : 'status'} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '0.7rem 1rem', borderRadius: '10px',
            marginBottom: '12px', fontSize: '13px', color: t.fg, border: `1px solid ${t.border}`, background: t.bg }}>
            <Icon style={{ flexShrink: 0, marginTop: '2px' }} />
            <div style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{message.text}</div>
            {onClose && <button type="button" aria-label="Dismiss" onClick={onClose} style={{ background: 'transparent', border: 'none', color: t.fg, cursor: 'pointer', padding: 0 }}><FiX /></button>}
        </div>
    );
}

export function Modal({ title, children, footer, width = '460px', onClose }) {
    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div role="dialog" aria-label={title} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '16px', padding: '1.4rem 1.6rem',
                maxWidth: width, width: '92%', maxHeight: '90vh', overflowY: 'auto', boxShadow: 'var(--shadow-lg)' }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
                    <h3 style={{ margin: 0, fontSize: '16px', color: 'var(--text-primary)', flex: 1 }}>{title}</h3>
                    {onClose && <button type="button" aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px' }}><FiX /></button>}
                </div>
                {children}
                {footer && <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '1.2rem' }}>{footer}</div>}
            </div>
        </div>
    );
}

export function ConfirmModal({ title = 'Confirm', children, confirmLabel = 'Confirm', danger, busy, onCancel, onConfirm }) {
    return (
        <Modal title={title} footer={(
            <>
                <Btn label="Cancel" onClick={onCancel} disabled={busy} />
                <Btn label={confirmLabel} tone={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm} />
            </>
        )}>
            <div style={{ fontSize: '13.5px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{children}</div>
        </Modal>
    );
}

/** The new password of a reset account, shown once. */
export function PasswordModal({ sam, password, onClose }) {
    const { showToast } = useToast();
    const [copied, setCopied] = useState(false);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(password);
            setCopied(true);
            showToast('Password copied');
        } catch {
            showToast('Copy failed: select the password and copy it by hand', 'error');
        }
    };
    return (
        <Modal title="Password reset" footer={<Btn label="Close" onClick={onClose} />}>
            <div style={{ fontSize: '13.5px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                New password of <code>{sam}</code>. The user has to change it at the next sign-in. It is not shown again after you close this window.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.15)' }}>
                <span style={{ fontFamily: 'monospace', fontSize: '1.1rem', color: '#10b981', userSelect: 'all', wordBreak: 'break-all' }}>{password}</span>
                <Btn small icon={<FiCopy />} label={copied ? 'Copied' : 'Copy'} onClick={copy} />
            </div>
        </Modal>
    );
}

/**
 * A table. columns: [{ key, label, width?, render?(row) }]. With selection (a Set of row keys), a checkbox column
 * selects rows; onToggleAll gets whether every listed row is selected.
 */
export function DataTable({ columns, rows, rowKey, empty = 'Nothing to show.', selected, onToggle, onToggleAll }) {
    const selectable = !!selected;
    const allSelected = selectable && rows.length > 0 && rows.every(r => selected.has(rowKey(r)));
    return (
        <div style={{ border: '1px solid var(--border-color)', borderRadius: '10px', overflow: 'auto', background: 'var(--bg-secondary)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                    <tr>
                        {selectable && (
                            <th style={{ width: '34px', padding: '8px 10px', borderBottom: '1px solid var(--border-color)' }}>
                                <input type="checkbox" aria-label="Select all listed" checked={allSelected} onChange={() => onToggleAll(allSelected)} />
                            </th>
                        )}
                        {columns.map(c => (
                            <th key={c.key} style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600, fontSize: '12px', color: 'var(--text-secondary)',
                                borderBottom: '1px solid var(--border-color)', background: 'rgba(127,127,127,0.06)', width: c.width, whiteSpace: 'nowrap' }}>{c.label}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.length === 0 && <tr><td colSpan={columns.length + (selectable ? 1 : 0)} style={{ padding: '14px 10px', color: 'var(--text-muted)' }}>{empty}</td></tr>}
                    {rows.map((r, i) => {
                        const k = rowKey(r);
                        const isSel = selectable && selected.has(k);
                        return (
                            <tr key={k} style={{ borderTop: i ? '1px solid var(--border-color)' : 'none', background: isSel ? 'rgba(59,130,246,0.08)' : 'transparent' }}>
                                {selectable && (
                                    <td style={{ padding: '7px 10px' }}><input type="checkbox" aria-label={`Select ${k}`} checked={isSel} onChange={() => onToggle(k)} /></td>
                                )}
                                {columns.map(c => (
                                    <td key={c.key} style={{ padding: '7px 10px', color: 'var(--text-primary)', verticalAlign: 'middle' }}>{c.render ? c.render(r) : r[c.key]}</td>
                                ))}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/** Page buttons under a long list. */
export function Pager({ page, pages, onPage }) {
    if (pages <= 1) return null;
    return (
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', alignItems: 'center', marginTop: '8px', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
            <Btn small label="Previous" disabled={page <= 1} onClick={() => onPage(page - 1)} />
            <span>Page {page} / {pages}</span>
            <Btn small label="Next" disabled={page >= pages} onClick={() => onPage(page + 1)} />
        </div>
    );
}

