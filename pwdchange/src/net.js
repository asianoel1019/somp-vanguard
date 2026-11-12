// Allowed client networks (CIDR, IPv4 and IPv6) and the client address of a request.
const net = require('net');

/** IPv4 / IPv6 text -> BigInt and bit length; IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as IPv4. */
function toBig(ip) {
    let s = String(ip || '').trim();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
    if (mapped) s = mapped[1];
    if (net.isIPv4(s)) {
        return { value: s.split('.').reduce((acc, o) => (acc << 8n) + BigInt(Number(o)), 0n), bits: 32 };
    }
    if (net.isIPv6(s)) {
        const zone = s.indexOf('%');
        if (zone >= 0) s = s.slice(0, zone);
        let [head, tail] = s.split('::');
        const parts = (x) => (x ? x.split(':') : []);
        let h = parts(head);
        let t = tail === undefined ? [] : parts(tail);
        // an embedded IPv4 tail (::ffff:1.2.3.4 forms other than the mapped one above)
        const last = (tail === undefined ? h : t);
        if (last.length && last[last.length - 1].includes('.')) {
            const v4 = toBig(last.pop()).value;
            last.push((v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16));
        }
        const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
        return { value: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n), bits: 128 };
    }
    return null;
}

/** "10.0.0.0/8, 192.168.1.10, fd00::/8" -> { list: [{ base, prefix, bits, text }] } or { error } */
function parseNets(value) {
    const list = [];
    for (const raw of String(value || '').split(/[,;\s]+/).filter(Boolean)) {
        const [addr, len] = raw.split('/');
        const ip = toBig(addr);
        if (!ip) return { error: `not an IP address or network: ${raw}` };
        const prefix = len === undefined ? ip.bits : Number(len);
        if (!/^\d+$/.test(String(prefix)) || prefix < 0 || prefix > ip.bits) return { error: `bad prefix length: ${raw}` };
        const shift = BigInt(ip.bits - prefix);
        list.push({ base: (ip.value >> shift) << shift, prefix, bits: ip.bits, text: raw });
    }
    return { list };
}

/** Whether ip is inside one of the networks. */
function inNets(ip, nets) {
    const a = toBig(ip);
    if (!a) return false;
    return nets.some(n => n.bits === a.bits && ((a.value >> BigInt(n.bits - n.prefix)) << BigInt(n.bits - n.prefix)) === n.base);
}

/**
 * The client address: the socket peer, or with trustProxy the right-most X-Forwarded-For entry (the one the
 * proxy in front of this server added; left-most entries can be set by the client).
 */
function clientIp(req, trustProxy) {
    if (trustProxy) {
        const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
        if (xff.length) return xff[xff.length - 1];
    }
    return String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
}

module.exports = { toBig, parseNets, inNets, clientIp };
