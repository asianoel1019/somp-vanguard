import React, { createContext, useContext, useReducer, useCallback } from 'react';

const ToastContext = createContext();

const toastReducer = (state, action) => {
    switch (action.type) {
        case 'ADD_TOAST':
            return [...state, action.payload];
        case 'REMOVE_TOAST':
            return state.filter(toast => toast.id !== action.payload);
        default:
            return state;
    }
};

export const ToastProvider = ({ children }) => {
    const [toasts, dispatch] = useReducer(toastReducer, []);

    const showToast = useCallback((message, type = 'info') => {
        const id = Date.now() + Math.random().toString(36).substr(2, 9);
        dispatch({ type: 'ADD_TOAST', payload: { id, message, type } });
    }, []);

    const removeToast = useCallback((id) => {
        dispatch({ type: 'REMOVE_TOAST', payload: id });
    }, []);

    // Note: Global window overrides have been removed. Components should use the useToast hook directly.

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            {toasts.length > 0 && (
                <div className="modal-overlay" style={{ zIndex: 99999 }}>
                    <div className="glass-panel animate-scale-in" style={{ maxWidth: '400px', padding: '28px', textAlign: 'center', boxShadow: '0 20px 40px rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', background: 'var(--bg-glass)', backdropFilter: 'blur(20px)' }}>
                        <div style={{ fontSize: '3.5rem', marginBottom: '16px' }}>
                            {toasts[0].message?.includes('success') || toasts[0].message?.includes('✓') || toasts[0].message?.includes('✅') || toasts[0].message?.includes('Success') ? '✅' : '⚠️'}
                        </div>
                        <h3 style={{ margin: '0 0 12px 0', fontSize: '1.3rem', fontWeight: '900', color: 'var(--text-primary)' }}>System Alert</h3>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: '1.6', margin: '0 0 24px 0', wordBreak: 'break-word', fontWeight: '500' }}>
                            {toasts[0].message}
                        </p>
                        <button className="btn btn-primary w-full" onClick={() => removeToast(toasts[0].id)} style={{ height: '46px', borderRadius: '12px', background: 'var(--accent-primary)', border: 'none', color: 'white', fontWeight: '700', fontSize: '13px', cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)' }}>
                            Understand
                        </button>
                    </div>
                </div>
            )}
        </ToastContext.Provider>
    );
};

export const useToast = () => useContext(ToastContext);
