import React, { useState } from 'react';
import ADDirectoryBrowse from './ADDirectoryBrowse';
import ADObjectSearch from './ADObjectSearch';
import GPOManager from './GPOManager';

export default function ADControlHub() {
  const [activeTab, setActiveTab] = useState('browse');

  return (
    <div style={{ padding: '0 0.5rem' }}>
      {/* Header */}
      <div className="mb-6 flex justify-between items-center px-1">
          <div>
              <h1 className="page-title">AD Control</h1>
              <p className="page-subtitle">Active Directory & Group Policy Management</p>
          </div>
      </div>
      
      {/* Top row: Mode Tabs Folder Selector */}
      <div style={{ display: 'flex', gap: '12px', borderBottom: '1px solid var(--border-color)', paddingBottom: '1px', marginBottom: '1.5rem', overflowX: 'auto' }}>
        <button
          onClick={() => setActiveTab('browse')}
          style={{
            padding: '12px 20px', background: 'transparent', border: 'none',
            color: activeTab === 'browse' ? 'var(--accent-primary)' : 'var(--text-muted)',
            fontSize: '14px', fontWeight: 700, cursor: 'pointer',
            borderBottom: activeTab === 'browse' ? '3px solid var(--accent-primary)' : '3px solid transparent',
            transition: 'all 0.2s', outline: 'none', whiteSpace: 'nowrap'
          }}
        >
          📁 Browse BU Hierarchy
        </button>
        <button
          onClick={() => setActiveTab('search')}
          style={{
            padding: '12px 20px', background: 'transparent', border: 'none',
            color: activeTab === 'search' ? 'var(--accent-primary)' : 'var(--text-muted)',
            fontSize: '14px', fontWeight: 700, cursor: 'pointer',
            borderBottom: activeTab === 'search' ? '3px solid var(--accent-primary)' : '3px solid transparent',
            transition: 'all 0.2s', outline: 'none', whiteSpace: 'nowrap'
          }}
        >
          🔍 AD Object Search Console
        </button>
        <button
          onClick={() => setActiveTab('gpo')}
          style={{
            padding: '12px 20px', background: 'transparent', border: 'none',
            color: activeTab === 'gpo' ? 'var(--accent-primary)' : 'var(--text-muted)',
            fontSize: '14px', fontWeight: 700, cursor: 'pointer',
            borderBottom: activeTab === 'gpo' ? '3px solid var(--accent-primary)' : '3px solid transparent',
            transition: 'all 0.2s', outline: 'none', whiteSpace: 'nowrap'
          }}
        >
          🛡️ Group Policy (GPO) Manager
        </button>
      </div>

      <div className="animate-fade-in" style={{ height: 'calc(100% - 130px)' }}>
        {activeTab === 'browse' && <ADDirectoryBrowse />}
        {activeTab === 'search' && <ADObjectSearch />}
        {activeTab === 'gpo' && <GPOManager />}
      </div>
    </div>
  );
}
