// IPAM core helpers: CIDR parse / normalise / validate, longest-prefix match, lazy IP materialisation, auto-create.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../lib/ipamCore');

test('parseCidr / normalizeCidr: network address, malformed input', () => {
    assert.equal(core.normalizeCidr('10.1.2.3/24'), '10.1.2.0/24');
    assert.equal(core.normalizeCidr(' 10.1.2.0 / 24 '), '10.1.2.0/24');
    assert.equal(core.normalizeCidr('10.1.2.0/33'), null);
    assert.equal(core.normalizeCidr('10.1.256.0/24'), null);
    assert.equal(core.normalizeCidr('10.1.2/24'), null);
    assert.equal(core.normalizeCidr('abc'), null);
    const p = core.parseCidr('192.168.5.77/30');
    assert.equal(p.cidr, '192.168.5.76/30');
    assert.equal(p.isNetworkAddress, false);
    assert.equal(core.intToIp(p.broadcast), '192.168.5.79');
});

test('validateNewCidr: masks /20 - /30 only, normalisation reported', () => {
    assert.equal(core.validateNewCidr('10.0.0.0/19').ok, false);
    assert.match(core.validateNewCidr('10.0.0.0/16').error, /\/20 to \/30/);
    assert.equal(core.validateNewCidr('10.0.0.0/31').ok, false);
    assert.equal(core.validateNewCidr('nope').ok, false);
    const ok = core.validateNewCidr('10.0.16.9/20');
    assert.deepEqual([ok.ok, ok.cidr, ok.normalized], [true, '10.0.16.0/20', true]);
    assert.equal(core.validateNewCidr('10.0.0.0/30').normalized, false);
});

test('findConflict: duplicate and overlap', () => {
    const subnets = [{ name: 'a', cidr: '10.0.0.0/24' }, { name: 'big', cidr: '10.1.0.0/16' }];
    assert.equal(core.findConflict(subnets, '10.0.0.0/24').duplicate.name, 'a');
    assert.equal(core.findConflict(subnets, '10.1.4.0/24').overlap.name, 'big');
    assert.equal(core.findConflict(subnets, '10.0.0.0/23').overlap.name, 'a');
    const none = core.findConflict(subnets, '10.2.0.0/24');
    assert.deepEqual([none.duplicate, none.overlap], [null, null]);
});

test('ipInCidr, isPrivateIp', () => {
    assert.equal(core.ipInCidr('10.0.0.5', '10.0.0.0/24'), true);
    assert.equal(core.ipInCidr('10.0.1.5', '10.0.0.0/24'), false);
    assert.equal(core.ipInCidr('bad', '10.0.0.0/24'), false);
    for (const ip of ['10.9.9.9', '172.16.0.1', '172.31.255.254', '192.168.1.1', '100.64.0.1', '100.127.255.1']) assert.equal(core.isPrivateIp(ip), true, ip);
    for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '100.128.0.1', '11.0.0.1', 'x']) assert.equal(core.isPrivateIp(ip), false, ip);
});

test('findSubnetForIp: longest prefix wins regardless of order', () => {
    const subnets = [
        { id: 'wide', cidr: '10.0.0.0/16' },
        { id: 'mid', cidr: '10.0.4.0/22' },
        { id: 'narrow', cidr: '10.0.5.0/24' }
    ];
    assert.equal(core.findSubnetForIp(subnets, '10.0.5.9').id, 'narrow');
    assert.equal(core.findSubnetForIp([...subnets].reverse(), '10.0.5.9').id, 'narrow');
    assert.equal(core.findSubnetForIp(subnets, '10.0.6.9').id, 'mid');
    assert.equal(core.findSubnetForIp(subnets, '10.0.9.9').id, 'wide');
    assert.equal(core.findSubnetForIp(subnets, '10.1.0.1'), null);
});

test('generateIPs: usable hosts, capped at 4094 for legacy /16', () => {
    const ips = core.generateIPs('10.0.0.0/30', { environment: 'X' });
    assert.deepEqual(ips.map(i => i.address), ['10.0.0.1', '10.0.0.2']);
    assert.equal(ips[0].status, 'free');
    assert.equal(ips[0].environment, 'X');
    assert.equal(core.generateIPs('10.0.0.0/24').length, 254);
    assert.equal(core.generateIPs('10.0.0.0/16').length, 4094);
    assert.equal(core.generateIPs('10.0.0.0/8').length, 0);
});

test('ensureIpEntry: materialises an address past the truncated IPs of a /16, in address order', () => {
    const subnet = { cidr: '10.5.0.0/16', envId: 'e1', environment: 'Env', ips: core.generateIPs('10.5.0.0/16') };
    assert.equal(core.truncationOf(subnet).truncated, true);
    assert.equal(core.truncationOf(subnet).hostCount, 65534);
    const last = subnet.ips[subnet.ips.length - 1].address; // 10.5.15.254
    const a = core.ensureIpEntry(subnet, '10.5.200.7');
    assert.equal(a.address, '10.5.200.7');
    assert.equal(a.envId, 'e1');
    const b = core.ensureIpEntry(subnet, '10.5.100.1');
    assert.equal(subnet.ips.length, 4096);
    const idx = (ip) => subnet.ips.findIndex(i => i.address === ip);
    assert.ok(idx(last) < idx('10.5.100.1') && idx('10.5.100.1') < idx('10.5.200.7'));
    assert.equal(core.ensureIpEntry(subnet, '10.5.100.1'), b, 'existing entry returned, not duplicated');
    assert.equal(core.ensureIpEntry(subnet, '10.6.0.1'), null, 'outside the CIDR');
    assert.equal(core.ensureIpEntry(subnet, '10.5.255.255'), null, 'broadcast');
    assert.equal(subnet.ips.length, 4096);
});

test('autoCreateSubnetFor: /24 for private IPs only', () => {
    const s = core.autoCreateSubnetFor('192.168.7.42', { envId: 'd', environment: 'Def' });
    assert.equal(s.cidr, '192.168.7.0/24');
    assert.equal(s.envId, 'd');
    assert.equal(s.ips.length, 254);
    assert.equal(core.autoCreateSubnetFor('8.8.8.8', {}), null);
    assert.equal(core.autoCreateSubnetFor('not-an-ip', {}), null);
});

test('gateway / reserved / nextAvailable', () => {
    assert.equal(core.firstUsableHost('10.0.0.0/24'), '10.0.0.1');
    assert.equal(core.effectiveGateway({ cidr: '10.0.0.0/24' }), '10.0.0.1');
    assert.equal(core.effectiveGateway({ cidr: '10.0.0.0/24', gateway: '' }), '');
    assert.equal(core.validateGateway('10.0.0.254', '10.0.0.0/24'), null);
    assert.match(core.validateGateway('10.0.0.255', '10.0.0.0/24'), /not a usable host/);
    assert.match(core.validateGateway('10.0.1.1', '10.0.0.0/24'), /not a usable host/);
    assert.deepEqual(core.parseReserved(['10.0.0.2', '10.0.0.10 - 10.0.0.12'], '10.0.0.0/24').values, ['10.0.0.2', '10.0.0.10-10.0.0.12']);
    assert.match(core.parseReserved(['10.0.1.2'], '10.0.0.0/24').error, /outside/);
    assert.match(core.parseReserved(['10.0.0.9-10.0.0.3'], '10.0.0.0/24').error, /end before start/);
    assert.match(core.parseReserved('10.0.0.1', '10.0.0.0/24').error, /array/);

    const subnet = { cidr: '10.0.0.0/28', reserved: ['10.0.0.2-10.0.0.3'], ips: core.generateIPs('10.0.0.0/28') };
    subnet.ips[3].status = 'used'; // .4
    subnet.ips[4].reservedUntil = new Date(Date.now() + 60000).toISOString(); // .5 reserved
    subnet.ips[5].reservedUntil = new Date(Date.now() - 60000).toISOString(); // .6 reservation expired
    assert.equal(core.nextAvailable(subnet).address, '10.0.0.6');
    subnet.gateway = '';
    assert.equal(core.nextAvailable(subnet).address, '10.0.0.1');
});
