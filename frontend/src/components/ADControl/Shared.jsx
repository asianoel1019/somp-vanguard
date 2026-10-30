import React from 'react';

export const STATUS_BADGE = ({ ok, trueLabel = 'Yes', falseLabel = 'No' }) => (
  <span style={{
    display: 'inline-block', padding: '2px 10px', borderRadius: '20px', fontSize: '0.75rem', fontWeight: 700,
    background: 'var(--bg-primary)',
    color: ok ? '#10b981' : '#ef4444',
    border: `1px solid ${ok ? '#10b981' : '#ef4444'}`,
    boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
  }}>{ok ? trueLabel : falseLabel}</span>
);

export const ActionBtn = ({ label, icon, color, onClick, loading, disabled }) => {
  const colors = {
    green: { bg: 'rgba(16,185,129,0.15)', border: '#10b981', text: '#10b981', hover: 'rgba(16,185,129,0.3)' },
    red: { bg: 'rgba(239,68,68,0.15)', border: '#ef4444', text: '#ef4444', hover: 'rgba(239,68,68,0.3)' },
    blue: { bg: 'rgba(59,130,246,0.15)', border: '#3b82f6', text: '#3b82f6', hover: 'rgba(59,130,246,0.3)' },
    yellow: { bg: 'rgba(245,158,11,0.15)', border: '#f59e0b', text: '#f59e0b', hover: 'rgba(245,158,11,0.3)' },
    purple: { bg: 'rgba(139,92,246,0.15)', border: '#8b5cf6', text: '#8b5cf6', hover: 'rgba(139,92,246,0.3)' },
  };
  const c = colors[color] || colors.blue;
  return (
    <button
      disabled={disabled || loading}
      onClick={onClick}
      style={{
        padding: '5px 12px', fontSize: '0.76rem', fontWeight: 700, borderRadius: '8px', cursor: disabled || loading ? 'not-allowed' : 'pointer',
        background: 'var(--bg-primary)', border: `2px solid ${c.border}`, color: c.text, transition: 'all 0.2s',
        opacity: disabled || loading ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap',
        boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
      }}
      onMouseEnter={e => { if (!disabled && !loading) e.currentTarget.style.background = c.hover; }}
      onMouseLeave={e => { e.currentTarget.style.background = c.bg; }}
    >
      {loading ? '⏳' : icon} {label}
    </button>
  );
};
