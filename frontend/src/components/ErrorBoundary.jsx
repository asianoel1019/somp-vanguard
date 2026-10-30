import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', backgroundColor: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderLeft: '4px solid var(--danger)', borderRadius: '12px', margin: '20px', backdropFilter: 'blur(16px)' }}>
          <h2 style={{ color: 'var(--danger)', marginTop: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>⚠️</span> Something went wrong
          </h2>
          <p style={{ color: 'var(--text-secondary)' }}>We're sorry, an unexpected error occurred while loading this module.</p>
          <pre style={{ overflowX: 'auto', background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px', color: 'var(--text-muted)', fontSize: '12px', marginTop: '16px' }}>
            {this.state.error && this.state.error.toString()}
          </pre>
          <button 
            style={{ marginTop: '16px', padding: '8px 20px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}
            onClick={() => this.setState({ hasError: false })}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
