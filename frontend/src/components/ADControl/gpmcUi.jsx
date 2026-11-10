// Small shared pieces of the GPMC-style Group Policy page: underline tabs, simple tables and a section label.
import React from 'react';
import { C } from './gpmcStyle';

export function Tabs({ tabs, active, onChange }) {
    return (
        <div role="tablist" style={{ display: 'flex', gap: '18px', borderBottom: C.border, padding: '0 16px', overflowX: 'auto' }}>
            {tabs.map(t => (
                <button key={t.id} role="tab" aria-selected={active === t.id} onClick={() => onChange(t.id)}
                    style={{ background: 'transparent', border: 'none', padding: '10px 0', cursor: 'pointer', whiteSpace: 'nowrap', fontSize: '13px',
                        fontWeight: active === t.id ? 700 : 500, color: active === t.id ? 'var(--text-primary)' : C.secondary,
                        borderBottom: active === t.id ? `2px solid ${C.accent}` : '2px solid transparent' }}>
                    {t.label}
                </button>
            ))}
        </div>
    );
}

export function SectionLabel({ children }) {
    return <div style={{ fontSize: '12px', fontWeight: 700, color: C.secondary, margin: '16px 0 6px' }}>{children}</div>;
}

/** columns: [{ key, label, width?, render? }] */
export function Table({ columns, rows, empty = 'None', onRowContextMenu, onRowDoubleClick }) {
    return (
        <div style={{ border: C.border, borderRadius: '8px', overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
                <thead>
                    <tr>
                        {columns.map(c => (
                            <th key={c.key} style={{ textAlign: 'left', fontWeight: 600, color: C.secondary, padding: '7px 10px', borderBottom: C.border, background: 'rgba(127,127,127,0.06)', width: c.width, whiteSpace: 'nowrap' }}>{c.label}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.length === 0 && (
                        <tr><td colSpan={columns.length} style={{ padding: '10px', color: C.muted }}>{empty}</td></tr>
                    )}
                    {rows.map((r, i) => (
                        <tr key={r.key || i} onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(e, r) : undefined}
                            onDoubleClick={onRowDoubleClick ? () => onRowDoubleClick(r) : undefined}
                            style={{ borderTop: i ? C.border : 'none', cursor: onRowDoubleClick ? 'pointer' : 'default' }}>
                            {columns.map(c => (
                                <td key={c.key} style={{ padding: '7px 10px', color: 'var(--text-primary)', verticalAlign: 'top' }}>{c.render ? c.render(r) : r[c.key]}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export function KeyValues({ items }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '8px 18px', fontSize: '13px' }}>
            {items.map(([k, v]) => (
                <React.Fragment key={k}>
                    <div style={{ color: C.secondary }}>{k}:</div>
                    <div style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>{v}</div>
                </React.Fragment>
            ))}
        </div>
    );
}

export function Notice({ children, tone = 'muted' }) {
    const color = tone === 'error' ? '#ef4444' : C.muted;
    return <div style={{ padding: '24px 16px', color, fontSize: '13px' }}>{children}</div>;
}
