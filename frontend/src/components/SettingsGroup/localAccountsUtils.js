// Pure helpers for the RBAC -> Local Accounts block. Rules mirror backend/lib/localAccounts.js.
export const ROLE_LABELS = { SuperAdmin: 'Admin (SuperAdmin)', Operator: 'Operator', Viewer: 'Viewer' };

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function validatePassword(pw) {
    const s = String(pw || '');
    if (s.length < 12 || s.length > 256) return 'Passwords need 12 to 256 characters.';
    if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return 'Passwords need at least one letter and one digit.';
    return '';
}

export function validateUsername(name, breakGlassName) {
    const n = String(name || '').trim();
    if (!NAME_RE.test(n)) return 'User names use letters, digits, ".", "_" or "-" (1-64 characters).';
    if (breakGlassName && n.toLowerCase() === String(breakGlassName).toLowerCase()) return 'That name is reserved for the break-glass admin.';
    return '';
}

export function statusLabel(account) {
    if (account && account.active) return { text: 'Active', tone: 'success', hint: '' };
    if (account && account.inactiveReason === 'free edition') {
        return { text: 'Inactive on free edition', tone: 'warning', hint: 'Created on the paid edition; it works again once a license is applied.' };
    }
    return { text: 'Disabled', tone: 'muted', hint: '' };
}

const QUOTA_ORDER = [['SuperAdmin', 'Admin'], ['Operator', 'Operator'], ['Viewer', 'Viewer']];

export function quotaText(list) {
    if (!list || list.edition === 'paid' || !list.quota) return '';
    const parts = QUOTA_ORDER.map(([role, label]) => {
        const q = list.quota[role] || { used: 0, limit: 1 };
        return `${label} ${q.used}/${q.limit}`;
    });
    return `Free edition: ${parts.join(' · ')}`;
}

export function roleFull(list, role) {
    if (!list || list.edition === 'paid' || !list.quota || !list.quota[role]) return false;
    const { used, limit } = list.quota[role];
    return typeof limit === 'number' && used >= limit;
}

export const QUOTA_MESSAGE = 'The free edition allows one local account per role.';
export const PAID_LOCKED_MESSAGE = 'Accounts created on the paid edition cannot be changed on the free edition; you can reset their password or delete them.';

// The add form starts on the least privileged role that still has room (free edition quota)
const DEFAULT_ROLE_ORDER = ['Viewer', 'Operator', 'SuperAdmin'];
export function defaultFormRole(list, current = 'Viewer') {
    if (!roleFull(list, current)) return current;
    return DEFAULT_ROLE_ORDER.find(r => !roleFull(list, r)) || current;
}

/**
 * What the free edition refuses for one row, so the page can disable it with the reason (the server refuses it too).
 * @returns {{ locked: string, enable: string, roleOption: (role: string) => string }} '' = allowed, else the reason
 */
export function rowLimits(list, account) {
    const none = { locked: '', enable: '', roleOption: () => '' };
    if (!list || list.edition === 'paid' || !account) return none;
    if (account.createdEdition !== 'free') return { locked: PAID_LOCKED_MESSAGE, enable: PAID_LOCKED_MESSAGE, roleOption: () => PAID_LOCKED_MESSAGE };
    return {
        locked: '',
        // a disabled account is not counted, so enabling it needs a free slot in its role
        enable: account.disabled && roleFull(list, account.role) ? QUOTA_MESSAGE : '',
        // moving an enabled account into another role needs a free slot there
        roleOption: (role) => (!account.disabled && role !== account.role && roleFull(list, role) ? QUOTA_MESSAGE : ''),
    };
}
