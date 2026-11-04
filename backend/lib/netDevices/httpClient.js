// HTTPS client shared by the network device drivers: fixed timeout, no redirects, bounded responses, TLS checking per
// device, and failures turned into classified errors that never carry tokens or response bodies.
const https = require('https');
const axios = require('axios');
const { netError, NetDeviceError } = require('./errors');

const TIMEOUT_MS = 15000;
const MAX_BYTES = 20 * 1024 * 1024;
const TLS_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_NOT_YET_VALID',
]);
const NET_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN']);

let transport = null; // test hook: (config) => Promise<{ status, data }>

const hostForUrl = (host) => (String(host).includes(':') && !String(host).startsWith('[') ? `[${host}]` : String(host));

/** Error raised by a failed request, classified; `secrets` are cut out of any message that might quote them. */
function classify(err, secrets) {
    if (err instanceof NetDeviceError) return err;
    const status = err && err.response && err.response.status;
    const code = err && err.code;
    let out;
    if (status === 401) out = netError('AUTH', 'The device rejected the credentials (401)');
    else if (status === 403) out = netError('FORBIDDEN', 'The account has no permission for this request (403)');
    else if (status === 404 || status === 405 || status === 501) out = netError('UNSUPPORTED', `The device does not offer this request (${status})`);
    else if (status) out = netError('OTHER', `The device answered HTTP ${status}`);
    else if (TLS_CODES.has(code)) out = netError('TLS', `TLS certificate check failed (${code}): enable it only with the device's CA, or turn verification off`);
    else if (NET_CODES.has(code) || /timeout/i.test(String(err && err.message))) out = netError('UNREACHABLE', `The device did not answer (${code || 'timeout'})`);
    else out = netError('OTHER', String((err && err.message) || err || 'Request failed').slice(0, 200));
    for (const s of secrets) {
        if (s && String(s).length >= 4) out.message = out.message.split(String(s)).join('***');
    }
    return out;
}

/**
 * @param {{ host: string, port: number, tlsVerify?: boolean, caCert?: string, timeoutMs?: number, headers?: object }} target
 * @returns {{ request: (opts: { method?, path, params?, data?, headers? }) => Promise<any> }}
 */
function createClient({ host, port, tlsVerify = false, caCert, timeoutMs = TIMEOUT_MS, headers = {}, secrets = [] }) {
    const base = `https://${hostForUrl(host)}:${port}`;
    const httpsAgent = new https.Agent({ rejectUnauthorized: !!tlsVerify, ...(tlsVerify && caCert ? { ca: caCert } : {}) });
    return {
        async request({ method = 'GET', path, params, data, headers: extra = {}, responseType }) {
            const config = {
                method,
                url: `${base}${path}`,
                params,
                data,
                headers: { Accept: 'application/json', ...headers, ...extra },
                timeout: timeoutMs,
                maxRedirects: 0,
                maxContentLength: MAX_BYTES,
                maxBodyLength: MAX_BYTES,
                httpsAgent,
                proxy: false,
                ...(responseType ? { responseType } : {}),
            };
            try {
                const res = await (transport ? transport(config) : axios(config));
                return res.data;
            } catch (err) {
                const allSecrets = [...secrets, ...Object.values({ ...headers, ...extra }).map(v => String(v).replace(/^Bearer\s+/i, ''))];
                throw classify(err, allSecrets);
            }
        },
    };
}

/** Test hook: replace the network call; null restores axios. */
function setTransportForTest(fn) { transport = fn; }

module.exports = { createClient, setTransportForTest, classify, TIMEOUT_MS, MAX_BYTES };
