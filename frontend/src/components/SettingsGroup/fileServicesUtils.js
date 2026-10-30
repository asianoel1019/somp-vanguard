// Pure helpers for Settings -> File Services (limits mirror backend/services/nasDevices.js).
export const FILE_SERVICES_CATEGORY = 'fileservices';
export const FILE_SERVICES_TABS = ['sftp', 'nas'];
export const NAS_TYPES = ['synology', 'qnap', 'windows', 'linux'];
export const NAME_MAX = 64;
export const USERNAME_MAX = 128;

/**
 * Maps a deep-link category (+ optional tab) to the real Settings category.
 * The retired 'sftp' category now lives under File Services -> SFTP Servers.
 */
export function resolveCategoryLink(category, tab) {
    if (!category) return null;
    if (category === 'sftp') return { category: FILE_SERVICES_CATEGORY, tab: 'sftp' };
    if (category === FILE_SERVICES_CATEGORY) {
        return { category, tab: FILE_SERVICES_TABS.includes(tab) ? tab : 'sftp' };
    }
    return { category, tab: null };
}

export function defaultPortForType(type) {
    if (type === 'synology') return 5000;
    if (type === 'qnap') return 8080;
    return '';
}

export function emptyDeviceForm() {
    return { name: '', type: 'synology', ip: '', port: 5000, username: '', password: '' };
}

/** The API never returns passwords, so the form always starts with a blank one (blank = keep). */
export function deviceToForm(dev) {
    return {
        name: dev.name || '',
        type: dev.type || 'synology',
        ip: dev.ip || '',
        port: dev.port || defaultPortForType(dev.type),
        username: dev.username || '',
        password: ''
    };
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function isValidHost(h) {
    if (typeof h !== 'string') return false;
    if (/^[0-9.]+$/.test(h)) return IPV4.test(h);
    return HOSTNAME.test(h);
}

/** Returns an error message or null. editingId = null when creating (password then required). */
export function validateNasDeviceForm(form, devices, editingId) {
    const name = String(form.name || '').trim();
    if (!name) return 'Device name is required.';
    if (name.length > NAME_MAX) return `Device name must be ${NAME_MAX} characters or fewer.`;
    if (!NAS_TYPES.includes(form.type)) return 'Driver type is not supported.';
    if (!isValidHost(String(form.ip || '').trim())) return 'IP address or hostname is invalid.';
    if (form.port !== '' && form.port !== null && form.port !== undefined) {
        const p = Number(form.port);
        if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port must be a whole number between 1 and 65535.';
    }
    const username = String(form.username || '');
    if (!username.trim()) return 'Username is required.';
    if (username.length > USERNAME_MAX) return `Username must be ${USERNAME_MAX} characters or fewer.`;
    if (!editingId && !form.password) return 'Password is required for a new device.';
    const lc = name.toLowerCase();
    if ((devices || []).some(d => d.id !== editingId && String(d.name || '').toLowerCase() === lc)) {
        return `A device named "${name}" already exists.`;
    }
    return null;
}

/** editing=true sends port: null for a blank port so the backend clears it (driver falls back to the type default). */
export function buildDevicePayload(form, editing = false) {
    const out = {
        name: String(form.name).trim(),
        type: form.type,
        ip: String(form.ip).trim(),
        username: form.username
    };
    if (form.port !== '' && form.port !== null && form.port !== undefined) out.port = Number(form.port);
    else if (editing) out.port = null;
    if (form.password) out.password = form.password;
    return out;
}

/** Test-connection payload; id lets the backend reuse the stored password when the field is blank. */
export function buildTestPayload(form, deviceId) {
    const out = buildDevicePayload(form);
    if (out.port === undefined && deviceId) out.port = null;
    if (deviceId) out.id = deviceId;
    return out;
}

export function isShareEditor(role) {
    return role === 'SuperAdmin' || role === 'Operator';
}

export function deviceErrorMessage(err, fallback) {
    return err?.response?.data?.error || err?.response?.data?.message || fallback;
}
