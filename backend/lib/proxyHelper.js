function getAxiosProxyConfig(moduleName) {
    const enabledModules = (process.env.PROXY_ENABLED_MODULES || '').split(',').map(s => s.trim());
    if (enabledModules.includes(moduleName) && global.SYSTEM_PROXY) {
        try {
            const pUrl = new URL(global.SYSTEM_PROXY);
            const proxyConfig = {
                protocol: pUrl.protocol.replace(':', ''),
                host: pUrl.hostname,
                port: parseInt(pUrl.port || 80)
            };
            const user = process.env.PROXY_USER || pUrl.username;
            const pwd = process.env.PROXY_PWD || pUrl.password;
            if (user && pwd) {
                proxyConfig.auth = {
                    username: decodeURIComponent(user),
                    password: decodeURIComponent(pwd)
                };
            }
            return proxyConfig;
        } catch (e) {
            console.error(`[ProxyHelper] Invalid global.SYSTEM_PROXY URL for ${moduleName}:`, e.message);
            return false;
        }
    }
    return false; // Direct connection
}

module.exports = { getAxiosProxyConfig };
