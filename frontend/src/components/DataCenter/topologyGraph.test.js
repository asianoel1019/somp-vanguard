import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CABLE_COLORS, buildTopology, filterTopology, layoutPositions, editTargetFor, searchNodes,
    resolveTarget, buildDeviceIndex, collectDevices, livePortStatus, endpointStatus, runLimited,
    describePollError, snmpCandidates, wayLabel, nodeTitle
} from './topologyGraph.js';

const dc = (id, racks, name = id.toUpperCase()) => ({ dc: { id, name }, racks });
const rack = (id, devices, extra = {}) => ({ id, name: `Rack ${id}`, devices, ...extra });
const dev = (id, hostname, type = 'Server', extra = {}) => ({ id, hostname, type, ...extra });
const link = (target, targetPort, cableColor = 'Blue') => ({ target, targetPort, cableColor });

const edgesBetween = (cables, x, y) => cables.filter(c =>
    (c.a.nodeId === x && c.b.nodeId === y) || (c.a.nodeId === y && c.b.nodeId === x));

test('back-rack devices are nodes with a 背面 location and links to them resolve', () => {
    const data = [dc('dc1', [
        rack('r1', [dev('sw', 'SW1', 'Switch', { portLinks: { 0: link('SRV-B', 'P2') } })], { partnerId: 'r1-back' }),
        rack('r1-back', [dev('b', 'SRV-B')], { isBack: true, partnerId: 'r1', name: 'Rack r1 (Back)' })
    ])];
    const topo = buildTopology(data, 'dc1');
    const back = topo.nodesById.get('b');
    assert.equal(back.kind, 'device');
    assert.equal(back.location, 'Rack r1 (背面)');
    assert.equal(topo.cables.length, 1);
    assert.equal(topo.cables[0].status, 'ok');
    assert.equal(topo.cables[0].b.nodeId, 'b');
});

test('a bidirectional pair is one undirected cable labelled P1 ↔ P3', () => {
    const data = [dc('dc1', [rack('r1', [
        dev('a', 'A', 'Switch', { portLinks: { 0: link('B', 'P3', 'Green') } }),
        dev('b', 'B', 'Server', { portLinks: { 2: link('A', 'P1', 'Green') } })
    ])])];
    const topo = buildTopology(data, 'dc1');
    assert.equal(topo.cables.length, 1);
    const c = topo.cables[0];
    assert.equal(c.bidirectional, true);
    assert.ok(c.label === 'P1 ↔ P3' || c.label === 'P3 ↔ P1');
    assert.equal(c.color, CABLE_COLORS.Green);
});

test('three cables between the same pair stay three distinguishable edges', () => {
    const data = [dc('dc1', [rack('r1', [
        dev('a', 'A', 'Switch', { portLinks: { 0: link('B', 'P1'), 1: link('B', 'P2'), 2: link('B', 'P3') } }),
        dev('b', 'B', 'Server', { portLinks: { 0: link('A', 'P1'), 1: link('A', 'P2'), 2: link('A', 'P3') } })
    ])])];
    const topo = buildTopology(data, 'dc1');
    const view = filterTopology(topo, {});
    const between = edgesBetween(view.cables, 'a', 'b');
    assert.equal(between.length, 3);
    assert.equal(new Set(between.map(c => c.id)).size, 3);
    assert.deepEqual(between.map(c => c.parallelIndex).sort(), [0, 1, 2]);
    assert.ok(between.every(c => c.parallelCount === 3));
    assert.equal(new Set(between.map(c => c.label)).size, 3);
});

test('legacy string links: merge with the unambiguous reverse record, otherwise stay separate', () => {
    // A.P1 -> 'B' (legacy) and B.P3 -> A "P1": one cable
    let topo = buildTopology([dc('dc1', [rack('r1', [
        dev('a', 'A', 'Switch', { portLinks: { 0: 'B' } }),
        dev('b', 'B', 'Server', { portLinks: { 2: link('A', 'P1') } })
    ])])], 'dc1');
    assert.equal(topo.cables.length, 1);
    assert.ok(['P1 ↔ P3', 'P3 ↔ P1'].includes(topo.cables[0].label));

    // both legacy, one record on each side: one cable
    topo = buildTopology([dc('dc1', [rack('r1', [
        dev('a', 'A', 'Switch', { portLinks: { 0: 'B' } }),
        dev('b', 'B', 'Server', { portLinks: { 4: 'A' } })
    ])])], 'dc1');
    assert.equal(topo.cables.length, 1);

    // two legacy on A, one on B: ambiguous pairing -> three separate cables, none lost
    topo = buildTopology([dc('dc1', [rack('r1', [
        dev('a', 'A', 'Switch', { portLinks: { 0: 'B', 1: 'B' } }),
        dev('b', 'B', 'Server', { portLinks: { 4: 'A' } })
    ])])], 'dc1');
    assert.equal(topo.cables.length, 3);
    assert.ok(topo.cables.some(c => c.label === 'P1 ↔ ?'));
});

test('duplicate hostname prefers the same DC, otherwise is ambiguous with candidates', () => {
    const data = [
        dc('dc1', [rack('r1', [dev('s1', 'SRC', 'Switch', { portLinks: { 0: 'DUP' } }), dev('d1', 'DUP')])]),
        dc('dc2', [rack('r2', [dev('d2', 'DUP')])])
    ];
    let topo = buildTopology(data, 'dc1');
    assert.equal(topo.cables[0].b.nodeId, 'd1');
    assert.equal(topo.cables[0].status, 'ok');

    const data2 = [
        dc('dc1', [rack('r1', [dev('s1', 'SRC', 'Switch', { portLinks: { 0: 'dup' } }), dev('d1', 'DUP'), dev('d3', 'DUP')])])
    ];
    topo = buildTopology(data2, 'dc1');
    assert.equal(topo.cables.length, 1);
    assert.equal(topo.cables[0].status, 'ambiguous');
    const amb = topo.nodesById.get(topo.cables[0].b.nodeId);
    assert.equal(amb.kind, 'ambiguous');
    assert.deepEqual(amb.candidates.map(c => c.id).sort(), ['d1', 'd3']);

    // match order: hostname before name before ip
    const index = buildDeviceIndex(collectDevices([dc('x', [rack('r', [
        dev('h', 'foo'), dev('n', '', 'Server', { name: 'FOO' }), dev('i', 'bar', 'Server', { ip: '10.0.0.1' }),
        dev('c', 'cv', 'Nutanix', { cvmIp: '10.0.0.9' })
    ])])]));
    assert.equal(resolveTarget(index, 'FOO', 'x').entry.id, 'h');
    assert.equal(resolveTarget(index, '10.0.0.1', 'x').entry.id, 'i');
    assert.equal(resolveTarget(index, '10.0.0.9', 'x').entry.id, 'c');
    assert.equal(resolveTarget(index, 'nothing', 'x').status, 'missing');
});

test('a target in another DC becomes an external node labelled hostname @ DC', () => {
    const data = [
        dc('dc1', [rack('r1', [dev('s1', 'SRC', 'Switch', { portLinks: { 0: link('CORE', 'P9') } })])], 'Taipei'),
        dc('dc2', [rack('r2', [dev('core', 'CORE', 'Router')])], 'Taichung')
    ];
    const topo = buildTopology(data, 'dc1');
    const ext = topo.nodesById.get('core');
    assert.equal(ext.kind, 'external');
    assert.equal(nodeTitle(ext), 'CORE @ Taichung');
    assert.equal(topo.cables[0].status, 'cross');
    assert.equal(topo.cables[0].a.nodeId, 's1');
    // a link recorded only in the other DC also shows
    const data2 = [
        dc('dc1', [rack('r1', [dev('s1', 'SRC', 'Switch')])]),
        dc('dc2', [rack('r2', [dev('core', 'CORE', 'Router', { portLinks: { 3: link('SRC', 'P1') } })])])
    ];
    const t2 = buildTopology(data2, 'dc1');
    assert.equal(t2.cables.length, 1);
    assert.equal(t2.cables[0].a.nodeId, 's1');
    // other DC's internal cables are not part of this DC's graph
    assert.equal(buildTopology([dc('dc1', []), dc('dc2', [rack('r', [dev('x', 'X', 'Switch', { portLinks: { 0: 'Y' } }), dev('y', 'Y')])])], 'dc1').cables.length, 0);
});

test('an unknown target becomes a red virtual node', () => {
    const topo = buildTopology([dc('dc1', [rack('r1', [dev('s1', 'SRC', 'Switch', { portLinks: { 0: 'ghost-01' } })])])], 'dc1');
    const v = topo.nodesById.get(topo.cables[0].b.nodeId);
    assert.equal(v.kind, 'virtual');
    assert.equal(v.label, 'ghost-01');
    assert.equal(topo.cables[0].status, 'missing');
});

test('isolated devices are hidden by default and shown on request', () => {
    const topo = buildTopology([dc('dc1', [rack('r1', [
        dev('a', 'A', 'Switch', { portLinks: { 0: link('B', 'P1') } }), dev('b', 'B'), dev('lonely', 'L'),
        dev('res', '', 'Reserve')
    ])])], 'dc1');
    const hidden = filterTopology(topo, {});
    assert.deepEqual(hidden.nodes.map(n => n.id).sort(), ['a', 'b']);
    assert.equal(hidden.hiddenIsolated, 1);
    const shown = filterTopology(topo, { showIsolated: true });
    assert.deepEqual(shown.nodes.map(n => n.id).sort(), ['a', 'b', 'lonely']);
});

test('network / power layers filter cables', () => {
    const topo = buildTopology([dc('dc1', [rack('r1', [
        dev('pdu', 'PDU-A', 'PowerBar', { wayLinks: { 0: { target: 'SRV', cableColor: 'Yellow' }, L2: 'SRV' } }),
        dev('sw', 'SW', 'Switch', { portLinks: { 0: link('SRV', 'P1') } }),
        dev('srv', 'SRV')
    ])])], 'dc1');
    assert.equal(topo.cables.filter(c => c.kind === 'power').length, 2);
    assert.ok(topo.cables.some(c => c.label === 'W1 ↔ ?'));
    assert.equal(wayLabel('L2'), 'WL3');
    const netOnly = filterTopology(topo, { showPower: false });
    assert.ok(netOnly.cables.every(c => c.kind === 'network'));
    assert.ok(!netOnly.nodes.some(n => n.id === 'pdu'));
    const powerOnly = filterTopology(topo, { showNetwork: false });
    assert.ok(powerOnly.cables.every(c => c.kind === 'power'));
    assert.equal(powerOnly.cables.length, 2);
});

test('type filter keeps only cables whose both ends have a selected type', () => {
    const topo = buildTopology([dc('dc1', [rack('r1', [
        dev('sw1', 'SW1', 'Switch', { portLinks: { 0: link('SW2', 'P1'), 1: link('SRV', 'P1') } }),
        dev('sw2', 'SW2', 'Switch'), dev('srv', 'SRV')
    ])])], 'dc1');
    assert.deepEqual(topo.types, ['Server', 'Switch']);
    const v = filterTopology(topo, { types: ['Switch'] });
    assert.deepEqual(v.nodes.map(n => n.id).sort(), ['sw1', 'sw2']);
    assert.equal(v.cables.length, 1);
    assert.equal(filterTopology(topo, { types: [] }).cables.length, 2);
});

test('chassis node edit target resolves to the stored parent chassis and its rack', () => {
    const chassis = dev('ch', 'NTNX-BLOCK', 'Nutanix', {
        isChassis: true,
        nodes: [{ hostname: 'NODE-1', portLinks: { 0: link('SW', 'P5') } }, { hostname: 'NODE-2' }]
    });
    const data = [dc('dc1', [rack('r9', [chassis, dev('sw', 'SW', 'Switch')])])];
    const topo = buildTopology(data, 'dc1');
    const nodeEntry = topo.nodes.find(n => n.device.hostname === 'NODE-1');
    assert.equal(nodeEntry.id, 'ch-node-0');
    assert.equal(nodeEntry.isChassisNode, true);
    const target = editTargetFor(nodeEntry, 'dc1');
    assert.equal(target.device, chassis);
    assert.equal(target.rackId, 'r9');
    assert.equal(target.viaChassis, true);
    assert.equal(target.otherDc, false);
    assert.equal(topo.cables.length, 1);
    assert.equal(editTargetFor(topo.nodesById.get('sw'), 'dc1').device.id, 'sw');
    assert.equal(editTargetFor({ id: 'virtual:x', kind: 'virtual' }, 'dc1'), null);
});

test('external node edit target points at its own DC', () => {
    const data = [
        dc('dc1', [rack('r1', [dev('s1', 'SRC', 'Switch', { portLinks: { 0: 'CORE' } })])]),
        dc('dc2', [rack('r2', [dev('core', 'CORE', 'Router')])], 'Second')
    ];
    const topo = buildTopology(data, 'dc1');
    const t = editTargetFor(topo.nodesById.get('core'), 'dc1');
    assert.equal(t.otherDc, true);
    assert.equal(t.dcId, 'dc2');
    assert.equal(t.rackId, 'r2');
});

test('layout keeps saved positions and lays out the rest', () => {
    const topo = buildTopology([dc('dc1', [rack('r1', [
        dev('a', 'A', 'Switch', { portLinks: { 0: link('B', 'P1') } }), dev('b', 'B')
    ])])], 'dc1');
    const v = filterTopology(topo, {});
    const pos = layoutPositions(v.nodes, v.cables, { a: { x: 5, y: 7 }, b: { x: 'bad' } });
    assert.deepEqual(pos.a, { x: 5, y: 7 });
    assert.ok(Number.isFinite(pos.b.x) && Number.isFinite(pos.b.y));
});

test('search matches hostname, name and ip, exact first', () => {
    const topo = buildTopology([dc('dc1', [rack('r1', [
        dev('a', 'web-01', 'Server', { ip: '10.1.1.1' }), dev('b', 'web', 'Server'), dev('c', '', 'Server', { name: 'Storage Box' })
    ])])], 'dc1');
    assert.deepEqual(searchNodes(topo.nodes, 'WEB'), ['b', 'a']);
    assert.deepEqual(searchNodes(topo.nodes, '10.1.1'), ['a']);
    assert.deepEqual(searchNodes(topo.nodes, 'storage'), ['c']);
    assert.deepEqual(searchNodes(topo.nodes, '  '), []);
});

test('SNMP helpers: port mapping, candidates, concurrency and error text', async () => {
    const ports = [{ port: 1, status: 'Up' }, { port: 2, status: 'Down' }, { port: 3, value: '1' }];
    assert.equal(livePortStatus(ports, 0), 'up');
    assert.equal(livePortStatus(ports, 1), 'down');
    assert.equal(livePortStatus(ports, 2), 'up');
    assert.equal(livePortStatus(ports, 7), 'unknown');
    assert.equal(endpointStatus({ sw: { ports } }, 'sw', 'P2'), 'down');
    assert.equal(endpointStatus({ sw: { ports } }, 'sw', 'W1'), 'unknown');
    assert.equal(endpointStatus({}, 'sw', 'P1'), 'unknown');

    const topo = buildTopology([dc('dc1', [rack('r1', [
        dev('sw', 'SW', 'Switch'), dev('srv', 'SRV'), dev('nas', 'NAS1', 'NAS'),
        dev('ch', 'C', 'Nutanix', { isChassis: true, nodes: [{ hostname: 'N1' }] })
    ])])], 'dc1');
    assert.deepEqual(snmpCandidates(topo.nodes).map(n => n.id).sort(), ['nas', 'sw']);

    let inFlight = 0;
    let peak = 0;
    const res = await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        if (n === 4) throw new Error('boom');
        return n * 2;
    });
    assert.equal(peak, 3);
    assert.equal(res.length, 7);
    assert.equal(res[3].ok, false);
    assert.equal(res[6].value, 14);

    assert.equal(describePollError({ response: { status: 409, data: { disabled: true } } }), 'SNMP 已停用');
    assert.match(describePollError({ response: { status: 400, data: { error: 'No IP' } } }), /未設定.*No IP/);
    assert.match(describePollError({ response: { status: 500, data: { error: 'timeout' } } }), /500.*timeout/);
});
