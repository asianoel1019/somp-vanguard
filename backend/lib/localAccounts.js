// Built-in local accounts (.env): the break-glass local admin (SuperAdmin role through lib/rbac getUserRole) and an
// optional local operator / viewer, usable on the free edition too. An operator / viewer account is enabled only when
// both its user name and password are set. Names compare case-insensitively; the first match (admin, operator,
// viewer) wins, so a name clash never shadows the local admin.
const env = (k) => String(process.env[k] || '').trim();

function list() {
    const out = [{ user: env('LOCAL_ADMIN_USER') || 'admin', pass: env('LOCAL_ADMIN_PWD'), role: null, label: 'Local admin' }];
    if (env('LOCAL_OPERATOR_USER') && env('LOCAL_OPERATOR_PWD')) {
        out.push({ user: env('LOCAL_OPERATOR_USER'), pass: env('LOCAL_OPERATOR_PWD'), role: 'Operator', label: 'Local operator' });
    }
    if (env('LOCAL_VIEWER_USER') && env('LOCAL_VIEWER_PWD')) {
        out.push({ user: env('LOCAL_VIEWER_USER'), pass: env('LOCAL_VIEWER_PWD'), role: 'Viewer', label: 'Local viewer' });
    }
    return out;
}

function find(username) {
    const name = String(username || '').trim().toLowerCase();
    if (!name) return null;
    return list().find(a => a.user.toLowerCase() === name) || null;
}

/** A signed-in local operator / viewer (not the local admin). */
function isBuiltinLocalUser(user) {
    if (!user || user.domain !== 'local') return false;
    const a = find(user.username);
    return !!(a && a.role);
}

module.exports = { list, find, isBuiltinLocalUser };
