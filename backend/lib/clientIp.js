// The address a request really came from. X-Forwarded-For is written by whoever sends the request, so it is only
// believed when the TCP peer is a trusted proxy (TRUSTED_PROXY_IPS, default: this machine only). Then the right-most
// entry that is not itself a trusted proxy is the client, because each proxy appends the address it saw.

const normalize = (ip) => {
    const s = String(ip || '').trim();
    return s.startsWith('::ffff:') ? s.slice(7) : s;
};

function trustedProxies() {
    const configured = String(process.env.TRUSTED_PROXY_IPS || '').split(',').map(normalize).filter(Boolean);
    return new Set(['127.0.0.1', '::1', ...configured]);
}

/** @returns {string} client IP ('unknown' when the socket has no address) */
function clientIp(req) {
    const peer = normalize(req.socket && req.socket.remoteAddress);
    if (!peer) return 'unknown';
    const trusted = trustedProxies();
    const header = req.headers && req.headers['x-forwarded-for'];
    if (!header || !trusted.has(peer)) return peer;
    const hops = String(header).split(',').map(normalize).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
        if (!trusted.has(hops[i])) return hops[i];
    }
    return hops[0] || peer;
}

module.exports = { clientIp };
