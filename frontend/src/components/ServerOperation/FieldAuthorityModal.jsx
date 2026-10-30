import React, { useState, useEffect } from 'react';
import { FiSliders, FiCheckCircle, FiRefreshCw, FiAlertTriangle, FiX, FiInfo, FiLock, FiShield } from 'react-icons/fi';
import api from '../../api';

const POLICY_OPTIONS = [
    { value: 'manual_first', label: '👤 手動優先 (Manual First)', color: '#3b82f6', desc: '用戶手動填寫優先；若為空白則允許自動填補' },
    { value: 'discovery_first', label: '🔍 自動探測優先 (Discovery First)', color: '#a855f7', desc: '虛擬化與掃描探測為主，發現新值自動更新' },
    { value: 'agent_first', label: '🤖 Agent 遙測優先 (Agent First)', color: '#10b981', desc: '以主機內安裝的 Scout Agent 核心數據為準' },
    { value: 'ipam_only', label: '🌐 IPAM 專屬權威 (IPAM Only)', color: '#f59e0b', desc: '僅接受 IPAM 模組指派，其餘來源自動忽略' },
    { value: 'rack_only', label: '🖥️ 機櫃拓撲專屬 (Rack Only)', color: '#06b6d4', desc: '僅接受機房機櫃拓撲模組指派' },
    { value: 'manual_only', label: '🔒 嚴格手動鎖定 (Manual Only)', color: '#ef4444', desc: '嚴格鎖定，完全不接受任何自動覆蓋' }
];

export default function FieldAuthorityModal({ isOpen, onClose, showToast, userRole = 'Viewer' }) {
    const isReadOnly = userRole === 'Viewer';
    const [rules, setRules] = useState({});
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [confirmReset, setConfirmReset] = useState(false);

    useEffect(() => {
        if (isOpen) {
            fetchRules();
            setConfirmReset(false);
        }
    }, [isOpen]);

    const fetchRules = async () => {
        try {
            setLoading(true);
            const res = await api.get('/server-list/field-authority');
            if (res.data && res.data.rules) {
                setRules(res.data.rules);
            }
        } catch (err) {
            console.error('Failed to load field authority rules:', err);
            showToast?.('載入欄位權威規則失敗', 'error');
        } finally {
            setLoading(false);
        }
    };

    const handlePolicyChange = (fieldKey, newPolicy) => {
        if (isReadOnly) return;
        setRules(prev => ({
            ...prev,
            [fieldKey]: {
                ...prev[fieldKey],
                policy: newPolicy
            }
        }));
    };

    const handleSave = async () => {
        if (isReadOnly) return;
        try {
            setSaving(true);
            const res = await api.post('/server-list/field-authority', { rules });
            if (res.data && res.data.rules) {
                setRules(res.data.rules);
                showToast?.('CMDB 欄位權威規則已成功保存', 'success');
                onClose();
            }
        } catch (err) {
            console.error('Failed to save rules:', err);
            showToast?.('保存規則失敗', 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleReset = async () => {
        if (isReadOnly) return;
        try {
            setSaving(true);
            const res = await api.post('/server-list/field-authority/reset');
            if (res.data && res.data.rules) {
                setRules(res.data.rules);
                showToast?.('已重置為系統推薦欄位權威規則', 'success');
                setConfirmReset(false);
            }
        } catch (err) {
            console.error('Failed to reset rules:', err);
            showToast?.('重置規則失敗', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div style={styles.overlay}>
            <div style={styles.modal}>
                {/* Header */}
                <div style={styles.header}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={styles.iconCircle}>
                            <FiShield size={20} color="#10b981" />
                        </div>
                        <div>
                            <h3 style={styles.title}>⚙️ CMDB 欄位權威與資料覆蓋規則設定</h3>
                            <p style={styles.subtitle}>
                                設定當自動掃描、Scout Agent 遙測、IPAM 與手動維護產生數據差異時，系統採納的優先順序。
                            </p>
                        </div>
                    </div>
                    <button style={styles.closeBtn} onClick={onClose}>
                        <FiX size={18} />
                    </button>
                </div>

                {/* Read-only Alert for Viewer */}
                {isReadOnly && (
                    <div style={styles.alertBanner}>
                        <FiLock size={15} style={{ color: '#f59e0b' }} />
                        <span>唯讀模式：您目前的角色權限（Viewer）僅能查看設定，無法變更權威規則。</span>
                    </div>
                )}

                {/* Body */}
                <div style={styles.body}>
                    {loading ? (
                        <div style={styles.loadingContainer}>
                            <FiRefreshCw className="spin" size={24} color="var(--accent-primary)" />
                            <span>載入規則中...</span>
                        </div>
                    ) : (
                        <div style={styles.tableWrapper}>
                            <table style={styles.table}>
                                <thead>
                                    <tr>
                                        <th style={{ ...styles.th, width: '28%' }}>欄位名稱 (FIELD)</th>
                                        <th style={{ ...styles.th, width: '38%' }}>權威等級策略 (AUTHORITY POLICY)</th>
                                        <th style={{ ...styles.th, width: '34%' }}>運作說明 (BEHAVIOR)</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {Object.entries(rules).map(([key, item]) => {
                                        const currentPolicy = item.policy || 'manual_first';
                                        const opt = POLICY_OPTIONS.find(o => o.value === currentPolicy) || POLICY_OPTIONS[0];

                                        return (
                                            <tr key={key} style={styles.tr}>
                                                <td style={styles.td}>
                                                    <div style={{ fontWeight: 800, color: 'var(--text-primary)', fontSize: 13 }}>
                                                        {item.name || key}
                                                    </div>
                                                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                                                        key: {key}
                                                    </div>
                                                </td>
                                                <td style={styles.td}>
                                                    <select
                                                        value={currentPolicy}
                                                        onChange={e => handlePolicyChange(key, e.target.value)}
                                                        disabled={isReadOnly}
                                                        style={{
                                                            ...styles.select,
                                                            borderColor: opt.color,
                                                            background: `${opt.color}15`,
                                                            color: 'var(--text-primary)'
                                                        }}
                                                    >
                                                        {POLICY_OPTIONS.map(po => (
                                                            <option key={po.value} value={po.value} style={styles.option}>
                                                                {po.label}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </td>
                                                <td style={styles.td}>
                                                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                                                        {opt.desc}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div style={styles.footer}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {!isReadOnly && (
                            confirmReset ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span style={{ fontSize: 12, color: '#ef4444', fontWeight: 700 }}>確定要重置為預設值嗎？</span>
                                    <button 
                                        style={{ ...styles.btnDanger, padding: '4px 10px', fontSize: 12 }} 
                                        onClick={handleReset}
                                        disabled={saving}
                                    >
                                        確定重置
                                    </button>
                                    <button 
                                        style={{ ...styles.btnSecondary, padding: '4px 10px', fontSize: 12 }} 
                                        onClick={() => setConfirmReset(false)}
                                    >
                                        取消
                                    </button>
                                </div>
                            ) : (
                                <button 
                                    style={styles.btnSecondary} 
                                    onClick={() => setConfirmReset(true)}
                                    disabled={saving}
                                    title="將所有欄位權威規則恢復為系統推薦設定"
                                >
                                    <FiRefreshCw size={13} /> 重置為推薦預設值
                                </button>
                            )
                        )}
                    </div>

                    <div style={{ display: 'flex', gap: 10 }}>
                        <button style={styles.btnSecondary} onClick={onClose}>
                            關閉
                        </button>
                        {!isReadOnly && (
                            <button style={styles.btnPrimary} onClick={handleSave} disabled={saving || loading}>
                                {saving ? <FiRefreshCw className="spin" size={14} /> : <FiCheckCircle size={14} />} 儲存同步規則
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

const styles = {
    overlay: {
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        zIndex: 1200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
    },
    modal: {
        width: 860,
        maxWidth: '92%',
        maxHeight: '90vh',
        background: 'var(--bg-secondary, #0f172a)',
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
        borderRadius: 16,
        boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
    },
    header: {
        padding: '18px 24px',
        borderBottom: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'rgba(255, 255, 255, 0.02)'
    },
    iconCircle: {
        width: 40,
        height: 40,
        borderRadius: 10,
        background: 'rgba(16, 185, 129, 0.15)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid rgba(16, 185, 129, 0.3)'
    },
    title: {
        margin: 0,
        fontSize: 17,
        fontWeight: 800,
        color: 'var(--text-primary, #fff)'
    },
    subtitle: {
        margin: '3px 0 0 0',
        fontSize: 12,
        color: 'var(--text-muted, #94a3b8)'
    },
    closeBtn: {
        background: 'none',
        border: 'none',
        color: 'var(--text-muted, #94a3b8)',
        cursor: 'pointer',
        padding: 6,
        borderRadius: 6
    },
    alertBanner: {
        padding: '10px 20px',
        background: 'rgba(245, 158, 11, 0.12)',
        borderBottom: '1px solid rgba(245, 158, 11, 0.25)',
        color: '#fbbf24',
        fontSize: 12,
        fontWeight: 700,
        display: 'flex',
        alignItems: 'center',
        gap: 8
    },
    body: {
        padding: '20px 24px',
        overflowY: 'auto',
        flex: 1
    },
    loadingContainer: {
        padding: 40,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        color: 'var(--text-muted)'
    },
    tableWrapper: {
        borderRadius: 10,
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
        overflow: 'hidden',
        background: 'rgba(255, 255, 255, 0.01)'
    },
    table: {
        width: '100%',
        borderCollapse: 'collapse',
        textAlign: 'left'
    },
    th: {
        padding: '12px 16px',
        background: 'rgba(255, 255, 255, 0.03)',
        borderBottom: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
        fontSize: 11,
        fontWeight: 800,
        color: 'var(--text-muted)',
        letterSpacing: '0.05em'
    },
    tr: {
        borderBottom: '1px solid rgba(255, 255, 255, 0.04)'
    },
    td: {
        padding: '12px 16px',
        verticalAlign: 'middle'
    },
    select: {
        width: '100%',
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid',
        outline: 'none',
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
        colorScheme: 'dark'
    },
    option: {
        background: '#1e293b',
        color: '#f8fafc'
    },
    footer: {
        padding: '16px 24px',
        borderTop: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'rgba(255, 255, 255, 0.02)'
    },
    btnPrimary: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 18px',
        borderRadius: 8,
        background: 'var(--accent-primary, #6366f1)',
        color: '#fff',
        border: 'none',
        fontWeight: 700,
        fontSize: 13,
        cursor: 'pointer'
    },
    btnSecondary: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 16px',
        borderRadius: 8,
        background: 'rgba(255, 255, 255, 0.05)',
        color: 'var(--text-primary, #fff)',
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
        fontWeight: 700,
        fontSize: 13,
        cursor: 'pointer'
    },
    btnDanger: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 14px',
        borderRadius: 8,
        background: '#ef4444',
        color: '#fff',
        border: 'none',
        fontWeight: 700,
        fontSize: 12,
        cursor: 'pointer'
    }
};
