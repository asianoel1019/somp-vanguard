import React, { useState } from 'react';
import api from '../api';

const Login = ({ onLogin }) => {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState(null);
    const [shake, setShake] = useState(false);
    const [loading, setLoading] = useState(false);
    const [config, setConfig] = useState(null);

    React.useEffect(() => {
        api.get('/auth/config').then(res => setConfig(res.data)).catch(e => console.error(e));
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError(null);
        setShake(false);

        setLoading(true);
        try {
            const res = await api.post('/auth/login', { username, password });
            const { token, user } = res.data;
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(user));
            onLogin(user);
        } catch (err) {
            console.error('Login error details:', err);
            const serverError = err.response?.data?.error;
            const networkError = err.message;
            const finalError = serverError || (err.response?.status === 401 ? 'Invalid Operator ID or Security Key.' : `Network/Connection Error: ${networkError}`);
            setError(finalError);
            setShake(true);
            setTimeout(() => setShake(false), 600);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, 
            background: 'linear-gradient(135deg, #020202 0%, #0a0f16 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'Inter', sans-serif",
            color: '#fff'
        }}>
            {/* Vanguard glowing background effects and shake animation */}
            <style>
                {`
                    .login-input::placeholder {
                        color: rgba(255, 255, 255, 0.25) !important;
                    }
                    @keyframes vanguardShake {
                        0%, 100% { transform: translateX(0); }
                        15%, 45%, 75% { transform: translateX(-8px); }
                        30%, 60%, 90% { transform: translateX(8px); }
                    }
                    .shake-card {
                        animation: vanguardShake 0.5s ease-in-out;
                    }
                `}
            </style>
            <div style={{
                position: 'absolute', inset: 0,
                backgroundImage: 'radial-gradient(circle at 50% 0%, rgba(0, 150, 255, 0.15) 0%, transparent 60%), radial-gradient(circle at 50% 100%, rgba(0, 150, 255, 0.05) 0%, transparent 60%)',
                pointerEvents: 'none'
            }} />
            
            {/* Main Auth Card */}
            <div className={shake ? 'shake-card' : ''} style={{
                position: 'relative',
                width: '100%', maxWidth: 460,
                background: 'rgba(10, 15, 25, 0.75)',
                backdropFilter: 'blur(24px)',
                border: error ? '1px solid rgba(239, 68, 68, 0.6)' : '1px solid rgba(0, 150, 255, 0.3)',
                boxShadow: error 
                    ? '0 0 60px rgba(239, 68, 68, 0.2), inset 0 0 20px rgba(239, 68, 68, 0.05)'
                    : '0 0 60px rgba(0, 150, 255, 0.1), inset 0 0 20px rgba(0, 150, 255, 0.05)',
                borderRadius: 4,
                padding: '44px 40px',
                zIndex: 1,
                transition: 'border 0.3s, box-shadow 0.3s'
            }}>
                <div style={{ textAlign: 'center', marginBottom: 36 }}>
                    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16, marginBottom: 16 }}>
                        <div style={{ width: 12, height: 12, background: '#0096ff', boxShadow: '0 0 15px #0096ff', transform: 'rotate(45deg)' }} />
                        <h1 style={{ fontSize: 32, fontWeight: 900, margin: 0, letterSpacing: '0.05em', textTransform: 'uppercase', textShadow: '0 0 20px rgba(0, 150, 255, 0.5)' }}>
                            SOMP <span style={{ color: '#0096ff' }}>Vanguard</span>
                        </h1>
                        <div style={{ width: 12, height: 12, background: '#0096ff', boxShadow: '0 0 15px #0096ff', transform: 'rotate(45deg)' }} />
                    </div>
                    <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', letterSpacing: '0.3em', textTransform: 'uppercase', margin: 0, fontFamily: 'monospace' }}>
                        Sys Operation Management Platform
                    </p>
                    {config?.allowedDomain && (
                        <div style={{ marginTop: 16, display: 'inline-block', padding: '5px 14px', background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: 20, fontSize: 11, color: '#10b981', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                            SECURE DOMAIN: {config.allowedDomain}
                        </div>
                    )}
                </div>

                {/* Enhanced Persistent Error Banner */}
                {error && (
                    <div style={{
                        background: 'rgba(239, 68, 68, 0.15)',
                        border: '1px solid rgba(239, 68, 68, 0.4)',
                        borderLeft: '4px solid #ef4444',
                        color: '#fff',
                        padding: '14px 16px',
                        marginBottom: 24,
                        borderRadius: 2,
                        boxShadow: '0 4px 16px rgba(239, 68, 68, 0.15)'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <span style={{ fontSize: 16 }}>⚠️</span>
                            <span style={{ fontWeight: 800, fontSize: 12, color: '#f87171', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                                Authentication Failed
                            </span>
                        </div>
                        <div style={{ fontSize: 13, color: '#fecaca', fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' }}>
                            {error}
                        </div>
                        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 6 }}>
                            Please verify your Operator ID and Security Key or contact system administrator.
                        </div>
                    </div>
                )}

                <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    <div>
                        <label htmlFor="username" style={{ display: 'block', fontSize: 11, fontWeight: 800, color: error ? '#f87171' : '#0096ff', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 8, fontFamily: 'monospace' }}>Operator ID</label>
                        <input
                            id="username"
                            className="login-input"
                            type="text"
                            placeholder="administrator"
                            value={username}
                            onChange={(e) => {
                                setUsername(e.target.value);
                                if (error) setError(null);
                            }}
                            required
                            autoComplete="username"
                            style={{
                                width: '100%', boxSizing: 'border-box',
                                background: 'rgba(0,0,0,0.5)',
                                border: error ? '1px solid rgba(239, 68, 68, 0.5)' : '1px solid rgba(255,255,255,0.1)',
                                color: '#fff', padding: '15px', fontSize: 15,
                                outline: 'none', transition: 'all 0.2s', borderRadius: 2, fontWeight: 600
                            }}
                            onFocus={e => { e.target.style.borderColor = error ? '#ef4444' : '#0096ff'; e.target.style.boxShadow = error ? '0 0 20px rgba(239, 68, 68, 0.2)' : '0 0 20px rgba(0, 150, 255, 0.15)'; }}
                            onBlur={e => { e.target.style.borderColor = error ? 'rgba(239, 68, 68, 0.5)' : 'rgba(255,255,255,0.1)'; e.target.style.boxShadow = 'none'; }}
                        />
                    </div>
                    <div>
                        <label htmlFor="password" style={{ display: 'block', fontSize: 11, fontWeight: 800, color: error ? '#f87171' : '#0096ff', letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 8, fontFamily: 'monospace' }}>Security Key</label>
                        <input
                            id="password"
                            className="login-input"
                            type="password"
                            placeholder="••••••••"
                            value={password}
                            onChange={(e) => {
                                setPassword(e.target.value);
                                if (error) setError(null);
                            }}
                            required
                            autoComplete="current-password"
                            style={{
                                width: '100%', boxSizing: 'border-box',
                                background: 'rgba(0,0,0,0.5)',
                                border: error ? '1px solid rgba(239, 68, 68, 0.5)' : '1px solid rgba(255,255,255,0.1)',
                                color: '#fff', padding: '15px', fontSize: 15,
                                outline: 'none', transition: 'all 0.2s', borderRadius: 2, fontWeight: 600, letterSpacing: '0.2em'
                            }}
                            onFocus={e => { e.target.style.borderColor = error ? '#ef4444' : '#0096ff'; e.target.style.boxShadow = error ? '0 0 20px rgba(239, 68, 68, 0.2)' : '0 0 20px rgba(0, 150, 255, 0.15)'; }}
                            onBlur={e => { e.target.style.borderColor = error ? 'rgba(239, 68, 68, 0.5)' : 'rgba(255,255,255,0.1)'; e.target.style.boxShadow = 'none'; }}
                        />
                    </div>
                    <button 
                        type="submit" 
                        disabled={loading}
                        style={{
                            width: '100%', marginTop: 12, padding: '16px',
                            background: loading ? 'rgba(0, 150, 255, 0.3)' : (error ? '#ef4444' : '#0096ff'),
                            color: '#fff', border: 'none', fontSize: 14, fontWeight: 900,
                            letterSpacing: '0.2em', textTransform: 'uppercase',
                            cursor: loading ? 'wait' : 'pointer', transition: 'all 0.2s',
                            borderRadius: 2,
                            boxShadow: loading ? 'none' : (error ? '0 0 30px rgba(239, 68, 68, 0.4)' : '0 0 30px rgba(0, 150, 255, 0.4)')
                        }}
                        onMouseOver={e => !loading && (e.target.style.background = error ? '#dc2626' : '#33aaff')}
                        onMouseOut={e => !loading && (e.target.style.background = error ? '#ef4444' : '#0096ff')}
                    >
                        {loading ? 'Authenticating...' : (error ? 'Retry Authentication' : 'Initialize Uplink')}
                    </button>
                </form>
            </div>
        </div>
    );
};

export default Login;
