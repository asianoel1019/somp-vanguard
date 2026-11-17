import axios from 'axios';

// Using relative URL so Vite's dev proxy forwards /api/* to backend port 5000.
// This works regardless of hostname, IP, or port the frontend is accessed from.
const api = axios.create({
    baseURL: '/api'
});

api.interceptors.request.use(config => {
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    // Notify App of activity to reset inactivity timer
    window.dispatchEvent(new Event('app-activity'));
    return config;
}, error => {
    return Promise.reject(error);
});

api.interceptors.response.use(response => response, error => {
    const isLoginRequest = error.config && error.config.url && error.config.url.includes('/auth/login');

    // 1. Handle explicit 401 Unauthorized for active sessions (ignore login failure responses)
    if (error.response && error.response.status === 401 && !isLoginRequest) {
        const code = error.response.data && error.response.data.code;
        if (code === 'LICENSE_REQUIRED' || code === 'ACCOUNT_INACTIVE' || code === 'ACCOUNTS_UNAVAILABLE') {
            const fallback = code === 'LICENSE_REQUIRED' ? 'This account needs a paid license.'
                : (code === 'ACCOUNTS_UNAVAILABLE' ? 'Local accounts are unavailable.' : 'Your account was disabled.');
            try { sessionStorage.setItem('somp.logoutReason', error.response.data.error || fallback); } catch { /* storage unavailable */ }
            handleLogout(code === 'LICENSE_REQUIRED' ? 'license' : 'account');
            return Promise.reject(error);
        }
        // Role / account change (password reset, role change): show why on the login page; logout type unchanged below
        if (code === 'SESSION_REVOKED') {
            try { sessionStorage.setItem('somp.logoutReason', error.response.data.error || 'Please sign in again.'); } catch { /* storage unavailable */ }
        }
        const lastAct = parseInt(localStorage.getItem('lastActivity') || '0', 10);
        const elapsed = Date.now() - lastAct;
        // If elapsed is large (> 60s) or no activity recorded, this is a cold-start or stale token rejection.
        // Clean up silently without triggering delayed timeout alerts.
        const isStaleOrColdStart = !lastAct || elapsed > 60000;
        handleLogout(isStaleOrColdStart ? 'cold_start_cleanup' : 'timeout');
    } 
    // 2. Handle Network timeouts (Axios timeout)
    else if (!isLoginRequest && (error.code === 'ECONNABORTED' || (!error.response && error.message && error.message.includes('timeout')))) {
        handleLogout('frontend_timeout');
    }
    return Promise.reject(error);
});

// Helper function to centralize logout and alerting
function handleLogout(type) {
    const userStr = localStorage.getItem('user');
    const token = localStorage.getItem('token');
    if (userStr) {
        try {
            const u = JSON.parse(userStr);
            const username = `${u.username}@${u.domain}`;
            fetch('/api/auth/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, type, token }),
                keepalive: true
            }).catch(() => {});
        } catch (e) {}
    }
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.reload();
}

export default api;
