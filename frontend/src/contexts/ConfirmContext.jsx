import React, { createContext, useContext, useState, useCallback } from 'react';

const ConfirmContext = createContext();

export const ConfirmProvider = ({ children }) => {
    const [confirmState, setConfirmState] = useState({
        isOpen: false,
        message: '',
        title: 'Confirm Action',
        resolve: null
    });

    const showConfirm = useCallback((messageOrOptions, title = 'Confirm Action') => {
        let msg = messageOrOptions;
        let tit = title;
        let onConfirmCb = null;
        if (typeof messageOrOptions === 'object' && messageOrOptions !== null) {
            msg = messageOrOptions.message || '';
            tit = messageOrOptions.title || title || 'Confirm Action';
            if (typeof messageOrOptions.onConfirm === 'function') {
                onConfirmCb = messageOrOptions.onConfirm;
            }
        }
        return new Promise((resolve) => {
            setConfirmState({
                isOpen: true,
                message: typeof msg === 'string' ? msg : String(msg),
                title: typeof tit === 'string' ? tit : String(tit),
                onConfirmCb,
                resolve
            });
        });
    }, []);

    const handleConfirm = async () => {
        if (confirmState.onConfirmCb) {
            try {
                await confirmState.onConfirmCb();
            } catch (err) {
                console.error('Error in onConfirm callback:', err);
            }
        }
        if (confirmState.resolve) confirmState.resolve(true);
        setConfirmState({ isOpen: false, message: '', title: '', onConfirmCb: null, resolve: null });
    };

    const handleCancel = () => {
        if (confirmState.resolve) confirmState.resolve(false);
        setConfirmState({ isOpen: false, message: '', title: '', onConfirmCb: null, resolve: null });
    };

    return (
        <ConfirmContext.Provider value={{ showConfirm }}>
            {children}
            {confirmState.isOpen && (
                <div className="modal-overlay" style={{ zIndex: 99999 }}>
                    <div className="glass-panel animate-scale-in" style={{ maxWidth: '400px', width: '100%', padding: '28px', textAlign: 'center', boxShadow: '0 20px 40px rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', background: 'var(--bg-glass)', backdropFilter: 'blur(20px)' }}>
                        <div style={{ fontSize: '3.5rem', marginBottom: '16px', color: 'var(--warning-color, #f59e0b)' }}>
                            ⚠️
                        </div>
                        <h3 style={{ margin: '0 0 12px 0', fontSize: '1.3rem', fontWeight: '900', color: 'var(--text-primary)' }}>
                            {confirmState.title}
                        </h3>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.6', margin: '0 0 24px 0', wordBreak: 'break-word', fontWeight: '500' }}>
                            {confirmState.message}
                        </p>
                        <div style={{ display: 'flex', gap: '12px' }}>
                            <button className="btn w-full" onClick={handleCancel} style={{ height: '46px', borderRadius: '12px', background: 'rgba(255,255,255,0.1)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', fontWeight: '700', fontSize: '13px', cursor: 'pointer' }}>
                                Cancel
                            </button>
                            <button className="btn btn-primary w-full" onClick={handleConfirm} style={{ height: '46px', borderRadius: '12px', background: 'var(--accent-primary)', border: 'none', color: 'white', fontWeight: '700', fontSize: '13px', cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' }}>
                                Confirm
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </ConfirmContext.Provider>
    );
};

export const useConfirm = () => useContext(ConfirmContext);
