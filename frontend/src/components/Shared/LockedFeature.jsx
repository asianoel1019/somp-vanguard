import React from 'react';
import { TbLock, TbKey } from 'react-icons/tb';
import { PAID_FEATURE_INFO } from '../../utils/licenseUtils.js';
import { LICENSE_CONTACT } from '../../constants/license.js';

// Shown instead of a paid screen on the free edition (App.jsx). canManage: SuperAdmin (can upload a license).
export default function LockedFeature({ item, canManage, onOpenLicense }) {
    const info = PAID_FEATURE_INFO[item && item.flag] || { name: item ? item.label : '', desc: '' };
    return (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 16px' }}>
            <div className="glass-panel" style={{ maxWidth: 560, width: '100%', padding: 32, borderRadius: 20, textAlign: 'center' }}>
                <div style={{ width: 56, height: 56, margin: '0 auto 16px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(245, 158, 11, 0.12)', color: 'var(--warning)', fontSize: 28 }}>
                    <TbLock />
                </div>
                <h2 style={{ margin: '0 0 6px', fontSize: 22 }}>{item ? item.label : info.name}</h2>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--warning)', marginBottom: 16 }}>此功能需要付費授權</div>
                {info.desc && <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, margin: '0 0 20px' }}>{info.desc}</p>}
                {canManage ? (
                    <button type="button" className="btn btn-primary" onClick={onOpenLicense} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <TbKey /> 前往 License 頁上傳授權
                    </button>
                ) : (
                    <div style={{ color: 'var(--text-secondary)' }}>請聯絡系統管理員。</div>
                )}
                <div style={{ marginTop: 20, fontSize: 12, color: 'var(--text-muted)' }}>
                    取得授權：{LICENSE_CONTACT.vendor}（{LICENSE_CONTACT.email}）
                </div>
            </div>
        </div>
    );
}
