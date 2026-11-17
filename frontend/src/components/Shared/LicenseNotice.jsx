import React from 'react';
import { TbLock } from 'react-icons/tb';

// Page-level notice for a feature the free edition limits (e.g. "notifications are not sent").
export default function LicenseNotice({ children }) {
    return (
        <div role="status" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', marginBottom: 16, borderRadius: 12,
            fontSize: 13, fontWeight: 600, color: 'var(--warning)', background: 'rgba(245, 158, 11, 0.10)', border: '1px solid rgba(245, 158, 11, 0.35)' }}>
            <TbLock style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>{children}</div>
        </div>
    );
}
