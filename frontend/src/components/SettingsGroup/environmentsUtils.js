// Pure helpers for Settings -> Environments (limits mirror backend/routes/environments.js).
export const NAME_MAX = 64;
export const PURPOSE_MAX = 256;
// Display sentinels (unknown reference / no value): reserved, case-insensitive (mirrors the backend)
export const RESERVED_NAMES = ['unassigned', '(empty)'];

export function isDefaultEnvironment(env) {
    return !!env && String(env.name || '').trim().toLowerCase() === 'others';
}

export function nonZeroUsage(usage) {
    return (usage && Array.isArray(usage.items) ? usage.items : []).filter(i => i.count > 0);
}

export function usageSummary(usage) {
    if (!usage) return '';
    const items = nonZeroUsage(usage);
    if (items.length === 0) return 'Not referenced anywhere';
    return items.map(i => `${i.consumer}: ${i.count}`).join(', ');
}

// Returns why an environment cannot be deleted, or null when it can.
export function deleteBlockReason(env, envs, usage) {
    if (isDefaultEnvironment(env)) return 'The default Others environment cannot be deleted';
    if ((envs || []).length <= 1) return 'The last remaining environment cannot be deleted';
    if (env && env.isDefault) return 'The default environment cannot be deleted (mark another one as default first)';
    if (!usage) return 'Usage is still loading';
    if (usage.complete === false) return 'Usage could not be determined';
    if (usage.total > 0) return `Still used by ${usage.total} reference${usage.total === 1 ? '' : 's'}`;
    return null;
}

// Returns an error message, or null when the form is valid. editingId is the id being edited (null when adding).
export function validateEnvironmentForm(form, envs, editingId) {
    const name = String((form && form.name) || '').trim();
    const purpose = String((form && form.purpose) || '').trim();
    if (!name) return 'Name is required';
    if (name.length > NAME_MAX) return `Name must be at most ${NAME_MAX} characters`;
    if (purpose.length > PURPOSE_MAX) return `Purpose must be at most ${PURPOSE_MAX} characters`;
    const current = (envs || []).find(e => e.id === editingId);
    if (RESERVED_NAMES.includes(name.toLowerCase()) && !(current && String(current.name).trim() === name)) {
        return `"${name}" is reserved and cannot be used as an environment name`;
    }
    const taken = (envs || []).some(e => e.id !== editingId && String(e.name).trim().toLowerCase() === name.toLowerCase());
    if (taken) return 'Environment name already exists';
    return null;
}

// Per-consumer results of a failed rename cascade (as returned in the 500 body)
export function failedConsumers(cascade) {
    return (Array.isArray(cascade) ? cascade : []).filter(c => c && c.error);
}

export function cascadeSummary(cascade) {
    return (Array.isArray(cascade) ? cascade : [])
        .map(c => `${c.consumer}: ${c.error ? `FAILED (${c.error})` : c.count}`)
        .join(', ');
}

// Unmapped values (GET /environments/unmapped): consumers with values first; read-only ones (Prometheus) last
export function unmappedRows(consumers) {
    const rows = [];
    for (const c of (Array.isArray(consumers) ? consumers : [])) {
        for (const v of (Array.isArray(c.values) ? c.values : [])) {
            rows.push({ key: c.key, consumer: c.consumer, readOnly: !!c.readOnly, value: v.value, count: v.count });
        }
    }
    return rows.sort((a, b) => (a.readOnly - b.readOnly) || (b.count - a.count) || a.consumer.localeCompare(b.consumer));
}

export const unmappedLabel = (value) => (value === '' || value == null ? '(empty)' : value);

// A name is a rename only when it differs from the stored name after trimming
export function isRename(env, name) {
    return !!env && String(name || '').trim() !== String(env.name || '').trim();
}
