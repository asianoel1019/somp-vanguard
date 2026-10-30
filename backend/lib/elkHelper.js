const http = require('http');
const https = require('https');
const { readEnv } = require('./envEditor');

// Custom agents supporting keep-alive and self-signed / internal CA HTTPS certs
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true
});

function isEsVersionAtLeast76(versionStr) {
    if (!versionStr) return true; // Default to modern
    const clean = String(versionStr).trim().toLowerCase().replace(/^v/, '');
    const parts = clean.split('.').map(n => parseInt(n, 10) || 0);
    const major = parts[0] || 0;
    const minor = parts[1] || 0;
    if (major > 7) return true; // 8.x, 9.x+
    if (major === 7) return minor >= 6; // 7.6, 7.17, etc.
    return false; // < 7.6 (e.g. 7.5, 7.0, 6.8, 5.6)
}

function getEnvMap() {
    const envMap = {};
    const parsedEnv = readEnv();

    Object.keys(parsedEnv).forEach(key => {
        const match = key.match(/^ELK_([A-Z0-9_]+)_MASTER$/);
        if (match) {
            const cluster = match[1];
            const rawMaster = parsedEnv[`ELK_${cluster}_MASTER`] || '';
            const explicitProto = parsedEnv[`ELK_${cluster}_PROTO`] || (rawMaster.startsWith('https://') ? 'https' : 'http');
            const version = parsedEnv[`ELK_${cluster}_VERSION`] || parsedEnv[`ELK_VERSION`] || '7.17';
            const apiUser = parsedEnv[`ELK_${cluster}_API_USER`] || parsedEnv[`ELK_${cluster}_ACCOUNT`] || "";
            const apiPwd = parsedEnv[`ELK_${cluster}_API_PWD`] || parsedEnv[`ELK_${cluster}_PWD`] || "";
            envMap[cluster] = {
                master: rawMaster,
                proto: explicitProto,
                version: String(version).trim(),
                nodes: parsedEnv[`ELK_${cluster}_NODES`] ? parsedEnv[`ELK_${cluster}_NODES`].split(',') : [],
                ls: parsedEnv[`LS_${cluster}_NODES`] ? parsedEnv[`LS_${cluster}_NODES`].split(',') : [],
                ls_path: parsedEnv[`SYSNAS_LS_${cluster}_PATH`] || "",
                account: apiUser,
                apiUser: apiUser,
                apiPwd: apiPwd
            };
        }
    });
    return envMap;
}

function getElkCredentials(env) {
    const uEnv = (env || '').toUpperCase();
    const customUser = process.env[`ELK_${uEnv}_USER`];
    const customPwd = process.env[`ELK_${uEnv}_PWD`];
    return {
        user: (customUser && customUser.trim()) ? customUser.trim() : (process.env.LINUX_ADMIN_USER || 'xyuser'),
        pwd: (customPwd && customPwd.trim()) ? customPwd.trim() : null
    };
}

// Normalizes Elasticsearch master configuration into full base URL (e.g. https://198.51.100.10:9200)
function getEsBaseUrl(master, proto) {
    if (!master) return '';
    let target = master.trim();

    // If master already contains http:// or https://
    if (/^https?:\/\//i.test(target)) {
        try {
            const parsed = new URL(target);
            const protocol = parsed.protocol;
            const host = parsed.hostname;
            const port = parsed.port || '9200';
            return `${protocol}//${host}:${port}`;
        } catch {
            return target.replace(/\/+$/, '');
        }
    }

    const defaultProto = (proto && proto.toLowerCase() === 'https') ? 'https://' : 'http://';
    if (target.includes(':')) {
        const [host, port] = target.split(':');
        return `${defaultProto}${host}:${port || 9200}`;
    }
    return `${defaultProto}${target}:9200`;
}

function getHttpConfig(envData) {
    const baseConfig = {
        headers: { 'Content-Type': 'application/json' },
        timeout: 50000,
        proxy: false,
        httpAgent,
        httpsAgent
    };
    const apiUser = envData?.apiUser || envData?.account;
    const apiPwd = envData?.apiPwd;
    if (!apiUser || !apiPwd) return baseConfig;
    const creds = Buffer.from(`${apiUser}:${apiPwd}`).toString('base64');
    baseConfig.headers['Authorization'] = `Basic ${creds}`;
    return baseConfig;
}

module.exports = {
    httpAgent,
    httpsAgent,
    isEsVersionAtLeast76,
    getEnvMap,
    getElkCredentials,
    getEsBaseUrl,
    getHttpConfig
};
