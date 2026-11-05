// Way selection of the drivers that can read a device over an API or over SSH (profile.transport):
// 'api' / 'ssh' use only that way; 'auto' tries the last way that worked (the API first when there is none) and
// changes over only when the device did not answer (UNREACHABLE) or does not offer the request (UNSUPPORTED).
// Wrong credentials, missing permissions, TLS and host key errors never change over: the same account tried twice
// could get locked.
const { netError } = require('./errors');

const FALLBACK_CODES = new Set(['UNREACHABLE', 'UNSUPPORTED']);

/**
 * Run `fns.api` or `fns.ssh` as the profile says.
 * `ctx.setTransport(t)` (from the registry) remembers the way that works; a connection test passes no ctx.
 * @param {object} profile
 * @param {{ api: () => Promise<any>, ssh: () => Promise<any> }} fns
 * @param {{ setTransport?: (t: 'api'|'ssh') => void }} [ctx]
 * @param {string} [apiName] name of the API in a combined error message (RESTCONF, NX-API, ...)
 * @returns {Promise<{ value: any, transport: 'api'|'ssh' }>}
 */
async function viaTransport(profile, fns, ctx = {}, apiName = 'API') {
    const mode = profile.transport || 'auto';
    if (mode === 'api' || mode === 'ssh') return { value: await fns[mode](), transport: mode };
    const remember = (t) => { if (ctx && ctx.setTransport && profile.lastTransport !== t) ctx.setTransport(t); };
    const [first, second] = profile.lastTransport === 'ssh' ? ['ssh', 'api'] : ['api', 'ssh'];
    let firstErr;
    try {
        const value = await fns[first]();
        remember(first);
        return { value, transport: first };
    } catch (err) {
        if (!FALLBACK_CODES.has(err.code)) throw err;
        firstErr = err;
    }
    try {
        const value = await fns[second]();
        // UNSUPPORTED may concern only this request (one model / command missing): keep the way already learned
        if (!profile.lastTransport || firstErr.code === 'UNREACHABLE') remember(second);
        return { value, transport: second };
    } catch (err) {
        if (!FALLBACK_CODES.has(err.code)) throw err;
        const name = (t) => (t === 'api' ? apiName : 'SSH');
        throw netError(err.code, `${name(first)}: ${firstErr.message}; ${name(second)}: ${err.message}`);
    }
}

/**
 * Run `requests` (functions returning promises) with the first one alone, so a wrong password fails once and not
 * once per request, then the rest in parallel. Returns their results in order.
 */
async function firstThenParallel(requests) {
    if (!requests.length) return [];
    const head = await requests[0]();
    const rest = await Promise.all(requests.slice(1).map(fn => fn()));
    return [head, ...rest];
}

module.exports = { viaTransport, firstThenParallel, FALLBACK_CODES };
