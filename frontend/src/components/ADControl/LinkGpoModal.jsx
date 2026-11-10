// "Link an Existing GPO" for a domain or OU: pick one of the GPOs not linked there yet.
import React, { useState } from 'react';
import { linkableGpos, GPO_STATUS_LABELS } from './gpmcModel';
import { C } from './gpmcStyle';

export default function LinkGpoModal({ node, gpoById, onCancel, onLink }) {
    const [filter, setFilter] = useState('');
    const [picked, setPicked] = useState(null);
    const gpos = linkableGpos(node, gpoById, filter);

    return (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div role="dialog" aria-label="Select GPO" style={{ background: 'var(--bg-secondary)', border: C.border, borderRadius: '16px', padding: '1.6rem', maxWidth: '520px', width: '92%', boxShadow: 'var(--shadow-lg)' }}>
                <h3 style={{ marginTop: 0, marginBottom: '4px', color: 'var(--text-primary)' }}>Select GPO</h3>
                <div style={{ fontSize: '12.5px', color: C.secondary, marginBottom: '12px' }}>Link a GPO to <strong>{node.name}</strong>. The new link is enabled and gets the last link order.</div>
                <input type="text" autoFocus value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter by name"
                    style={{ width: '100%', padding: '8px 12px', background: 'rgba(0,0,0,0.05)', border: C.border, color: 'var(--text-primary)', borderRadius: '6px', marginBottom: '10px' }} />
                <div role="listbox" aria-label="Group Policy objects" style={{ maxHeight: '320px', overflowY: 'auto', border: C.border, borderRadius: '8px' }}>
                    {gpos.length === 0 && <div style={{ padding: '12px', fontSize: '12.5px', color: C.muted }}>{filter ? 'No GPO matches.' : 'Every GPO is already linked here.'}</div>}
                    {gpos.map((g, i) => (
                        <div key={g.id} role="option" aria-selected={picked === g.id} onClick={() => setPicked(g.id)} onDoubleClick={() => onLink(g)}
                            style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '13px', borderTop: i ? C.border : 'none',
                                background: picked === g.id ? 'rgba(59,130,246,0.18)' : 'transparent', color: picked === g.id ? C.accent : 'var(--text-primary)' }}>
                            {g.name}
                            {g.status !== 'AllSettingsEnabled' && <span style={{ marginLeft: '8px', fontSize: '11.5px', color: C.muted }}>{GPO_STATUS_LABELS[g.status] || g.status}</span>}
                        </div>
                    ))}
                </div>
                <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '1.2rem' }}>
                    <button onClick={onCancel} style={{ padding: '6px 16px', borderRadius: '8px', border: C.border, background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer' }}>Cancel</button>
                    <button disabled={!picked} onClick={() => onLink(gpoById.get(picked))}
                        style={{ padding: '6px 16px', borderRadius: '8px', border: 'none', background: 'var(--accent-primary)', color: 'white', fontWeight: 700, cursor: picked ? 'pointer' : 'default', opacity: picked ? 1 : 0.5 }}>OK</button>
                </div>
            </div>
        </div>
    );
}
