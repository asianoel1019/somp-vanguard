// Display helpers for Server Provision results. Status comes from the structured fields the backend returns
// ({ ip, ok, packages: [{ name, exitCode, ok, message }], rebootRequired, error, log }), never from log text.

/** Normalises the /install/execute response (or a request error) into a list of result objects. */
export function normalizeResults(data, errorMessage) {
    if (errorMessage) {
        return [{ ip: 'Error', ok: false, packages: [], error: String(errorMessage), log: '' }];
    }
    const list = data && Array.isArray(data.results) ? data.results : [];
    return list.map(r => ({
        ip: String(r.ip),
        ok: r.ok === true,
        packages: Array.isArray(r.packages) ? r.packages : [],
        rebootRequired: r.rebootRequired === true,
        error: r.error ? String(r.error) : '',
        log: typeof r.log === 'string' ? r.log : ''
    }));
}

/** { label, tone } where tone is one of 'success' | 'warning' | 'danger'. */
export function hostStatus(r) {
    if (!r.ok) return { label: 'Failed', tone: 'danger' };
    if (r.rebootRequired) return { label: 'Completed - reboot required', tone: 'warning' };
    return { label: 'Completed', tone: 'success' };
}

export function packageSummary(r) {
    const pkgs = r.packages || [];
    const okCount = pkgs.filter(p => p.ok).length;
    return pkgs.length ? `${okCount}/${pkgs.length} packages OK` : '';
}

export function overallSummary(results) {
    const failed = results.filter(r => !r.ok).length;
    if (results.length === 0) return '';
    return failed === 0 ? `All ${results.length} host(s) succeeded` : `${failed} of ${results.length} host(s) failed`;
}

/** Converts GET /install/jobs/:id ({ job, hosts }) into the per-host result list used by normalizeResults. */
export function jobToResults(data) {
    const hosts = data && Array.isArray(data.hosts) ? data.hosts : [];
    return hosts.map(h => ({
        ip: h.ip,
        ok: h.status === 'ok',
        packages: h.packages,
        rebootRequired: h.rebootRequired === true,
        error: h.status === 'ok' ? '' : (h.error || `Host ${h.status}`),
        log: h.log
    }));
}

/** True while the job still has work to do (queued / running). */
export function isJobActive(data) {
    return !!(data && data.job && data.job.running);
}
