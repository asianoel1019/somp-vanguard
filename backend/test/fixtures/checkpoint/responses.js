// Recorded-shape Check Point Management API answers (addresses from the documentation ranges), keyed by command.
const gw = {
    uid: 'gw-uid-1', name: 'gw-lab-01', type: 'simple-gateway', 'ipv4-address': '192.0.2.10', version: 'R81.20',
    hardware: 'Open server', 'os-name': 'Gaia', 'sic-state': 'communicating',
    policy: { 'access-policy-installed': true, 'access-policy-name': 'Standard' },
};
const cluster = {
    uid: 'cl-uid-1', name: 'cl-lab', type: 'CpmiGatewayCluster', 'ipv4-address': '192.0.2.20', version: 'R81.20',
    policy: { 'access-policy-installed': true, 'access-policy-name': 'Standard' },
};

module.exports = {
    login: { sid: 'SID-0001', 'session-timeout': 600, 'api-server-version': '1.9' },
    'show-api-versions': { 'current-version': '1.9', 'supported-versions': ['1.8', '1.9'] },
    'show-gateways-and-servers': {
        from: 1, to: 3, total: 3,
        objects: [{ uid: 'mgmt', name: 'mgmt-lab', type: 'CpmiHostCkp', 'ipv4-address': '192.0.2.5' }, gw, cluster],
    },
    'show-simple-gateway': {
        ...gw,
        interfaces: [
            { name: 'eth1', 'ipv4-address': '203.0.113.2', 'ipv4-mask-length': 29, topology: 'external' },
            { name: 'eth2', 'ipv4-address': '192.0.2.1', 'ipv4-mask-length': 24, topology: 'internal', comments: 'LAN' },
        ],
    },
    'show-simple-cluster': {
        ...cluster,
        'cluster-mode': 'cluster-xl-ha',
        interfaces: [{ name: 'eth1', 'ipv4-address': '203.0.113.6', 'ipv4-mask-length': 29, topology: 'external' }],
        'cluster-members': [{ name: 'cl-member-a', 'ip-address': '192.0.2.21' }, { name: 'cl-member-b', 'ip-address': '192.0.2.22' }],
    },
    'show-package': { name: 'Standard', 'access-layers': [{ uid: 'layer-uid', name: 'Network' }] },
    'show-access-rulebase': {
        uid: 'layer-uid', name: 'Network', from: 1, to: 3, total: 3,
        rulebase: [
            {
                type: 'access-section', name: 'Outbound', rulebase: [
                    { type: 'access-rule', uid: 'r1', 'rule-number': 1, name: 'LAN out', enabled: true, action: 'act-accept',
                        source: ['net-lan'], destination: ['any'], service: ['svc-https', 'svc-http'], comments: 'web',
                        hits: { value: 5120, 'last-date': { 'iso-8601': '2026-11-03T10:00:00+0000' } } },
                    { type: 'access-rule', uid: 'r2', 'rule-number': 2, name: 'No telnet', enabled: false, action: 'act-drop',
                        source: ['any'], 'destination-negate': true, destination: ['net-lan'], service: ['svc-telnet'], hits: { value: 0 } },
                ],
            },
            { type: 'access-rule', uid: 'r3', 'rule-number': 3, name: 'Cleanup', enabled: true, action: 'act-drop', source: ['any'], destination: ['any'], service: ['any'] },
        ],
        'objects-dictionary': [
            { uid: 'act-accept', name: 'Accept' }, { uid: 'act-drop', name: 'Drop' }, { uid: 'any', name: 'Any' },
            { uid: 'net-lan', name: 'LAN_192.0.2.0' }, { uid: 'svc-https', name: 'https' }, { uid: 'svc-http', name: 'http' }, { uid: 'svc-telnet', name: 'telnet' },
        ],
    },
};
