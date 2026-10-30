import React, { useMemo } from 'react';
import { parseMarkdown } from './safeMarkdown.js';

const S = {
    code: { background: 'rgba(255,255,255,0.08)', padding: '1px 5px', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.9em' },
    pre: { background: 'rgba(0,0,0,0.35)', padding: 10, borderRadius: 8, overflowX: 'auto', fontSize: 12, lineHeight: 1.5, margin: '8px 0' },
    table: { borderCollapse: 'collapse', width: '100%', fontSize: 12, margin: '8px 0' },
    cell: { border: '1px solid var(--border-color)', padding: '4px 8px', textAlign: 'left', verticalAlign: 'top' },
};

function Inline({ nodes }) {
    return nodes.map((n, i) => {
        switch (n.type) {
            case 'strong': return <strong key={i}><Inline nodes={n.children} /></strong>;
            case 'em': return <em key={i}><Inline nodes={n.children} /></em>;
            case 'code': return <code key={i} style={S.code}>{n.value}</code>;
            case 'link': return <a key={i} href={n.href}><Inline nodes={n.children} /></a>;
            default: return <React.Fragment key={i}>{n.value}</React.Fragment>;
        }
    });
}

export default function MarkdownView({ text }) {
    const blocks = useMemo(() => parseMarkdown(text), [text]);
    return (
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)', wordBreak: 'break-word' }}>
            {blocks.map((b, i) => {
                switch (b.type) {
                    case 'heading': {
                        const size = { 1: 17, 2: 15, 3: 14 }[b.level] || 13;
                        return <div key={i} style={{ fontSize: size, fontWeight: 800, margin: '12px 0 4px' }}><Inline nodes={b.children} /></div>;
                    }
                    case 'list': {
                        const Tag = b.ordered ? 'ol' : 'ul';
                        return <Tag key={i} style={{ margin: '4px 0', paddingLeft: 20 }}>{b.items.map((it, j) => <li key={j}><Inline nodes={it} /></li>)}</Tag>;
                    }
                    case 'code':
                        return <pre key={i} style={S.pre}><code>{b.value}</code></pre>;
                    case 'table':
                        return (
                            <div key={i} style={{ overflowX: 'auto' }}>
                                <table style={S.table}>
                                    <thead><tr>{b.header.map((c, j) => <th key={j} style={S.cell}><Inline nodes={c} /></th>)}</tr></thead>
                                    <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} style={S.cell}><Inline nodes={c} /></td>)}</tr>)}</tbody>
                                </table>
                            </div>
                        );
                    default:
                        return <p key={i} style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}><Inline nodes={b.children} /></p>;
                }
            })}
        </div>
    );
}
