// AD Control: the BU mode and the OU tree mode side by side, object search, maintenance reports and Group Policy.
import React, { useState } from 'react';
import { FiLayers, FiGitBranch, FiSearch, FiClipboard, FiShield } from 'react-icons/fi';
import ADDirectoryBrowse from './ADDirectoryBrowse';
import ADOuTree from './ADOuTree';
import ADObjectSearch from './ADObjectSearch';
import ADReports from './ADReports';
import GPOManager from './GPOManager';

const TABS = [
    { id: 'browse', label: 'Browse BU Hierarchy', icon: FiLayers },
    { id: 'tree', label: 'OU Tree', icon: FiGitBranch },
    { id: 'search', label: 'Object Search', icon: FiSearch },
    { id: 'reports', label: 'Reports', icon: FiClipboard },
    { id: 'gpo', label: 'Group Policy', icon: FiShield },
];

export default function ADControlHub() {
    const [active, setActive] = useState(() => {
        try { return TABS.some(t => t.id === localStorage.getItem('adControlTab')) ? localStorage.getItem('adControlTab') : 'browse'; } catch { return 'browse'; }
    });
    const choose = (id) => {
        setActive(id);
        try { localStorage.setItem('adControlTab', id); } catch { /* the choice just isn't remembered */ }
    };

    return (
        <div style={{ padding: '0 0.5rem' }}>
            <div className="mb-6 px-1">
                <h1 className="page-title">AD Control</h1>
                <p className="page-subtitle">Active Directory and Group Policy management</p>
            </div>
            <div role="tablist" aria-label="AD Control" style={{ display: 'flex', gap: '4px', borderBottom: '1px solid var(--border-color)', marginBottom: '1.2rem', overflowX: 'auto' }}>
                {TABS.map(t => {
                    const Icon = t.icon;
                    const on = active === t.id;
                    return (
                        <button key={t.id} role="tab" aria-selected={on} onClick={() => choose(t.id)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '10px 16px', background: 'transparent', border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                                fontSize: '14px', fontWeight: 700, color: on ? 'var(--accent-primary)' : 'var(--text-muted)',
                                borderBottom: on ? '3px solid var(--accent-primary)' : '3px solid transparent' }}>
                            <Icon /> {t.label}
                        </button>
                    );
                })}
            </div>
            <div className="animate-fade-in">
                {active === 'browse' && <ADDirectoryBrowse />}
                {active === 'tree' && <ADOuTree />}
                {active === 'search' && <ADObjectSearch />}
                {active === 'reports' && <ADReports />}
                {active === 'gpo' && <GPOManager />}
            </div>
        </div>
    );
}
