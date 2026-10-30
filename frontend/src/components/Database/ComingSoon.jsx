import React from 'react';

const S = {
    page: { 
        padding: '40px', 
        fontFamily: "'Inter', sans-serif", 
        color: 'var(--text-primary)', 
        minHeight: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center'
    },
    title: { 
        fontSize: 32, 
        fontWeight: 900, 
        margin: '0 0 16px 0',
        background: 'linear-gradient(90deg, #fff, var(--text-muted))',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent'
    },
    subtitle: { 
        fontSize: 16, 
        color: 'var(--text-secondary)', 
        maxWidth: 500,
        lineHeight: 1.6
    },
    iconWrap: {
        fontSize: 64,
        marginBottom: 24,
        filter: 'drop-shadow(0 0 20px var(--accent-glow))'
    },
    badge: {
        display: 'inline-block',
        padding: '6px 16px',
        borderRadius: 20,
        fontSize: 12,
        fontWeight: 800,
        letterSpacing: '0.1em',
        background: 'var(--accent-primary)',
        color: '#fff',
        marginBottom: 24,
        boxShadow: '0 4px 12px var(--accent-glow)'
    }
};

const ComingSoon = ({ title, description, icon }) => {
    return (
        <div style={S.page} className="animate-fade-in">
            <div style={S.badge}>COMING SOON</div>
            <div style={S.iconWrap}>{icon || '🚀'}</div>
            <h1 style={S.title}>{title}</h1>
            <p style={S.subtitle}>
                {description || "We are currently building this feature to supercharge your database operations. Stay tuned for the next major update!"}
            </p>
        </div>
    );
};

export default ComingSoon;
