/**
 * Prism Central / Prism Element REST access shared by routes/nutanix.js.
 * - resolveConfig: PE/PC mode, target IPs and the account for that mode (process.env is already decrypted by loadEnv)
 * - createClient:  Basic-auth client for one host (TLS verification opt-in via NUTANIX_TLS_VERIFY / NUTANIX_CA_CERT_FILE)
 * - listV3 / listV2: follow paging so large clusters are not cut off at the first page
 * - normalizeV2Vm: map a PE v2.0 VM to the v3 shape the UI reads
 */
const axios = require('axios');
const https = require('https');
const fs = require('fs');

const V3_PAGE_SIZE = 500;
const MAX_PAGES = 200;

// Overridable in tests: (axiosRequestConfig) => Promise<{ data }>
let transport = (req) => axios.request(req);

function splitIps(value) {
    return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

function resolveConfig(env = process.env) {
    const peIps = splitIps(env.NUTANIX_PE_IP);
    const pcIp = String(env.NUTANIX_PC_IP || '').trim();
    const isPeMode = env.NUTANIX_MODE === 'PE' || (!pcIp && peIps.length > 0);
    return {
        isPeMode,
        pcIp,
        peIps,
        primaryIp: isPeMode ? (peIps[0] || '') : pcIp,
        account: (isPeMode ? env.NUTANIX_PE_ACCOUNT : env.NUTANIX_PC_ACCOUNT) || '',
        pwd: (isPeMode ? env.NUTANIX_PE_PWD : env.NUTANIX_PC_PWD) || '',
    };
}

let cachedAgent = null;
let cachedAgentKey = '';
function httpsAgent(env = process.env) {
    const verify = String(env.NUTANIX_TLS_VERIFY || '').toLowerCase() === 'true';
    const caFile = String(env.NUTANIX_CA_CERT_FILE || '').trim();
    const key = `${verify}|${caFile}`;
    if (!cachedAgent || cachedAgentKey !== key) {
        const opts = { rejectUnauthorized: verify, keepAlive: true };
        if (verify && caFile) opts.ca = fs.readFileSync(caFile);
        cachedAgent = new https.Agent(opts);
        cachedAgentKey = key;
    }
    return cachedAgent;
}

/** Client for one Prism host; methods resolve to the response body. */
function createClient(host, { account, pwd }) {
    const headers = {
        Authorization: `Basic ${Buffer.from(`${account}:${pwd}`).toString('base64')}`,
        'Content-Type': 'application/json',
    };
    const call = async (method, path, data, { timeout = 15000, params } = {}) => {
        const res = await transport({
            method, url: `https://${host}:9440/api/nutanix${path}`, data, params,
            headers, httpsAgent: httpsAgent(), proxy: false, timeout,
        });
        return res.data;
    };
    return {
        host,
        get: (path, opts) => call('get', path, undefined, opts),
        post: (path, body, opts) => call('post', path, body, opts),
        put: (path, body, opts) => call('put', path, body, opts),
    };
}

/** POST /v3/<kind>s/list, page by page, until metadata.total_matches is reached. */
async function listV3(client, kind, { filter, timeout, pageSize = V3_PAGE_SIZE } = {}) {
    const all = [];
    for (let page = 0; page < MAX_PAGES; page++) {
        const body = { kind, length: pageSize, offset: all.length };
        if (filter) body.filter = filter;
        const data = await client.post(`/v3/${kind}s/list`, body, { timeout });
        const entities = (data && data.entities) || [];
        all.push(...entities);
        const total = Number(data && data.metadata && data.metadata.total_matches);
        if (entities.length === 0) break;
        if (Number.isFinite(total) ? all.length >= total : entities.length < pageSize) break;
    }
    return all;
}

/**
 * GET a v2.0 collection. The first request is sent as before (no paging parameters);
 * only when metadata reports more entities than returned are further pages requested.
 */
async function listV2(client, path, { params, timeout } = {}) {
    const first = await client.get(path, { params, timeout });
    const all = [...((first && first.entities) || [])];
    const meta = (first && first.metadata) || {};
    const total = Number(meta.grand_total_entities ?? meta.total_entities);
    const pageSize = all.length;
    if (!Number.isFinite(total) || pageSize === 0) return all;
    const seen = new Set(all.map(e => e.uuid));
    for (let page = 1; page < MAX_PAGES && all.length < total; page++) {
        const data = await client.get(path, { params: { ...params, offset: all.length, length: pageSize }, timeout });
        const fresh = ((data && data.entities) || []).filter(e => !seen.has(e.uuid));
        if (fresh.length === 0) break; // server ignored offset: stop instead of looping
        fresh.forEach(e => seen.add(e.uuid));
        all.push(...fresh);
    }
    return all;
}

/** Runs fn over items with at most `limit` in flight; results keep input order. */
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function errorMessage(err) {
    return (err && err.response && err.response.data && err.response.data.message) || (err && err.message) || String(err);
}

function isCvm(name) {
    const upper = String(name || '').toUpperCase();
    return upper.startsWith('NTNX') || upper.endsWith('CVM');
}

function toMib(disk) {
    if (disk.disk_size_mib) return Number(disk.disk_size_mib);
    const bytes = disk.disk_size_in_bytes || disk.disk_size_bytes || disk.size || disk.container_max_capacity_bytes || 0;
    return Math.round(Number(bytes) / (1024 * 1024));
}

/** PE v2.0 VM (as returned with include_vm_disk_config / include_vm_nic_config) -> v3 shape read by NutanixManager. */
function normalizeV2Vm(vm, { clusterName, hostMap = {} }) {
    const ips = new Set(vm.ip_addresses || []);
    (vm.vm_nics || []).forEach(nic => {
        if (nic.ip_address) ips.add(nic.ip_address);
        (nic.ip_addresses || []).forEach(ip => ips.add(ip));
    });
    const disks = (vm.disk_list || vm.vm_disk_info || []).map(disk => ({
        disk_size_mib: toMib(disk),
        device_properties: { device_type: disk.is_cdrom ? 'CDROM' : (disk.device_properties?.device_type || 'DISK') },
    }));
    const power = String(vm.power_state || 'UNKNOWN').toUpperCase();
    // v2: num_vcpus = sockets, num_cores_per_vcpu = cores per socket
    const resources = {
        num_sockets: vm.num_vcpus || 1,
        num_vcpus_per_socket: vm.num_cores_per_vcpu || 1,
        memory_size_mib: vm.memory_mb || 0,
    };
    return {
        uuid: vm.uuid,
        metadata: { uuid: vm.uuid },
        spec: { name: vm.name, resources: { ...resources } },
        status: {
            name: vm.name,
            power_state: power,
            cluster_reference: { name: clusterName, uuid: vm.cluster_uuid || '' },
            resources: {
                ...resources,
                power_state: power,
                host_reference: { name: (vm.host_uuid && hostMap[vm.host_uuid]) || 'N/A', uuid: vm.host_uuid || '' },
                nic_list: [...ips].map(ip => ({ ip_endpoint_list: [{ ip }] })),
                disk_list: disks,
            },
        },
    };
}

module.exports = {
    resolveConfig, createClient, listV3, listV2, mapLimit, errorMessage, isCvm, normalizeV2Vm,
    setTransportForTest: (fn) => { transport = fn || ((req) => axios.request(req)); },
};
