// Pure graph building for the Topology Map (no React, no api).
// Reads the rack data written by ServerRack.jsx:
//   device.portLinks[portIndex0] = 'hostname' (legacy) | { target, targetPort: 'P3', cableColor }
//   device.wayLinks[key]         = 'hostname' | { target, cableColor }   (key: 0..n, 'L0'.., 'R0'..)
//   chassis: device.isChassis + device.nodes[]; back racks: rack.isBack + rack.partnerId
import dagre from 'dagre';

export const CABLE_COLORS = {
    Red: '#ef4444', Blue: '#3b82f6', Yellow: '#eab308', Green: '#22c55e',
    Orange: '#f97316', Purple: '#a855f7', Black: '#1e293b', White: '#f8fafc'
};
export const DEFAULT_NETWORK_COLOR = CABLE_COLORS.Blue;
export const DEFAULT_POWER_COLOR = CABLE_COLORS.Yellow;
export const MISSING_COLOR = '#ef4444';
export const AMBIGUOUS_COLOR = '#f97316';
export const EXTERNAL_COLOR = '#14b8a6';
export const STATUS_COLORS = { up: '#22c55e', down: '#ef4444', unknown: '#64748b' };

// Device types that never take part in cabling
export const SKIPPED_TYPES = ['Reserve', 'Shelf'];
// Types for which ServerRack offers SNMP settings / polling
export const SNMP_TYPES = ['Switch', 'Router', 'Firewall', 'LoadBalancer', 'Proxy', 'ISE', 'NAS', 'TapeLibrary'];
export const NETWORK_DEVICE_TYPES = ['Switch', 'Router', 'Firewall', 'LoadBalancer'];

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 120;

const str = (v) => (typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : ''));
const lc = (v) => str(v).toLowerCase();
const normPort = (p) => str(p).toUpperCase();

/** Label of a rack location; back racks read "<front rack name> (背面)". */
export function rackLocationLabel(rack, frontById) {
    if (!rack) return '';
    if (!rack.isBack) return rack.name || String(rack.id || '');
    const front = frontById && frontById.get(rack.partnerId);
    const base = (front && front.name) || String(rack.name || rack.id || '').replace(/\s*\(back\)\s*$/i, '');
    return `${base} (背面)`;
}

/**
 * Flattens every connectable device of every DC (front + back racks, chassis nodes).
 * @param {Array<{dc:{id,name}, racks:Array}>} dcData
 */
export function collectDevices(dcData) {
    const entries = [];
    const usedIds = new Set();
    const uniqueId = (base) => {
        let id = base;
        let n = 2;
        while (usedIds.has(id)) id = `${base}~${n++}`;
        usedIds.add(id);
        return id;
    };
    (dcData || []).forEach(({ dc, racks }) => {
        if (!dc) return;
        const list = Array.isArray(racks) ? racks.filter(Boolean) : [];
        const frontById = new Map(list.filter(r => !r.isBack).map(r => [r.id, r]));
        list.forEach((rack, ri) => {
            const location = rackLocationLabel(rack, frontById);
            (Array.isArray(rack.devices) ? rack.devices : []).forEach((device, di) => {
                if (!device || SKIPPED_TYPES.includes(device.type)) return;
                const baseId = device.id != null && device.id !== '' ? String(device.id) : `dev-${dc.id}-${rack.id ?? ri}-${di}`;
                const id = uniqueId(baseId);
                const common = {
                    stored: device, rackId: rack.id, location, isBack: !!rack.isBack,
                    dcId: dc.id, dcName: dc.name || String(dc.id)
                };
                entries.push({ ...common, id, device, chassisIndex: null });
                if (device.isChassis && Array.isArray(device.nodes)) {
                    device.nodes.forEach((n, i) => {
                        if (!n) return;
                        entries.push({
                            ...common,
                            id: uniqueId(`${baseId}-node-${i}`),
                            device: {
                                ...n,
                                type: device.type === 'BladeChassis' ? 'Blade Node' : 'Nutanix Node',
                                chassisName: device.hostname || device.name || ''
                            },
                            chassisIndex: i
                        });
                    });
                }
            });
        });
    });
    return entries;
}

/** Lookup maps: hostname / name (lower-case) and ip / cvmIp. */
export function buildDeviceIndex(entries) {
    const byHost = new Map();
    const byName = new Map();
    const byIp = new Map();
    const add = (map, key, e) => {
        if (!key) return;
        let arr = map.get(key);
        if (!arr) map.set(key, (arr = []));
        if (!arr.includes(e)) arr.push(e);
    };
    (entries || []).forEach(e => {
        add(byHost, lc(e.device.hostname), e);
        add(byName, lc(e.device.name), e);
        add(byIp, lc(e.device.ip), e);
        add(byIp, lc(e.device.cvmIp), e);
    });
    return { byHost, byName, byIp };
}

/**
 * Resolves a link target: hostname, then name, then ip / cvmIp (case-insensitive).
 * Several matches: the single one in the source's DC wins, otherwise ambiguous.
 * @returns {{status:'ok', entry}|{status:'ambiguous', candidates}|{status:'missing'}}
 */
export function resolveTarget(index, targetStr, sourceDcId, excludeId) {
    const key = lc(targetStr);
    if (!key) return { status: 'missing' };
    for (const map of [index.byHost, index.byName, index.byIp]) {
        const cands = (map.get(key) || []).filter(e => e.id !== excludeId);
        if (cands.length === 0) continue;
        if (cands.length === 1) return { status: 'ok', entry: cands[0] };
        const same = cands.filter(e => e.dcId === sourceDcId);
        if (same.length === 1) return { status: 'ok', entry: same[0] };
        return { status: 'ambiguous', candidates: same.length > 1 ? same : cands };
    }
    return { status: 'missing' };
}

export function portLabel(key) {
    const n = parseInt(key, 10);
    return Number.isFinite(n) && String(n) === String(key).trim() ? `P${n + 1}` : `P${key}`;
}

export function wayLabel(key) {
    const s = String(key);
    const m = /^([LR])(\d+)$/i.exec(s);
    if (m) return `W${m[1].toUpperCase()}${parseInt(m[2], 10) + 1}`;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? `W${n + 1}` : `W${s}`;
}

/** Link records of one device entry (network = portLinks, power = wayLinks). */
export function extractLinks(entry) {
    const out = [];
    const read = (links, kind) => {
        if (!links || typeof links !== 'object') return;
        Object.entries(links).forEach(([key, v]) => {
            let target = '';
            let targetPort = '';
            let colorName = '';
            let legacy = false;
            if (typeof v === 'string') {
                target = v.trim();
                legacy = true;
            } else if (v && typeof v === 'object') {
                target = str(v.target);
                targetPort = str(v.targetPort);
                colorName = typeof v.cableColor === 'string' ? v.cableColor : '';
            }
            if (!target) return;
            const dflt = kind === 'power' ? DEFAULT_POWER_COLOR : DEFAULT_NETWORK_COLOR;
            out.push({
                sourceId: entry.id,
                sourceDcId: entry.dcId,
                kind,
                port: kind === 'power' ? wayLabel(key) : portLabel(key),
                target,
                targetPort,
                colorName,
                color: CABLE_COLORS[colorName] || dflt,
                legacy
            });
        });
    };
    read(entry.device.portLinks, 'network');
    read(entry.device.wayLinks, 'power');
    return out;
}

const cableLabel = (c) => `${c.a.port || '?'} ↔ ${c.b.port || '?'}`;

function newCable(kind, aId, aPort, bId, bPort, status, rec) {
    const c = {
        id: '',
        kind,
        a: { nodeId: aId, port: aPort || '' },
        b: { nodeId: bId, port: bPort || '' },
        status,
        color: rec.color,
        colorName: rec.colorName,
        records: [rec]
    };
    return c;
}

const portOf = (c, nodeId) => (c.a.nodeId === nodeId ? normPort(c.a.port) : normPort(c.b.port));

/** Merges the link records between one pair of devices into physical cables. */
function mergePair(records) {
    const cables = [];
    const byKey = new Map();
    const endKey = (id, port) => `${id}\u0000${normPort(port)}`;
    const cableKey = (x, px, y, py) => {
        const k1 = endKey(x, px);
        const k2 = endKey(y, py);
        return k1 < k2 ? `${k1}\u0001${k2}` : `${k2}\u0001${k1}`;
    };
    const status = records[0].status;
    const kind = records[0].kind;
    records.filter(r => r.targetPort).forEach(r => {
        const k = cableKey(r.sourceId, r.port, r.targetId, r.targetPort);
        const existing = byKey.get(k);
        if (existing) {
            existing.records.push(r);
        } else {
            const c = newCable(kind, r.sourceId, r.port, r.targetId, r.targetPort, status, r);
            byKey.set(k, c);
            cables.push(c);
        }
    });
    const pending = new Map();
    records.filter(r => !r.targetPort).forEach(r => {
        const matches = cables.filter(c => portOf(c, r.sourceId) === normPort(r.port)
            && !c.records.some(x => x.sourceId === r.sourceId));
        if (matches.length === 1) {
            matches[0].records.push(r);
            return;
        }
        if (!pending.has(r.sourceId)) pending.set(r.sourceId, []);
        pending.get(r.sourceId).push(r);
    });
    const sides = [...pending.keys()];
    if (sides.length === 2 && pending.get(sides[0]).length === 1 && pending.get(sides[1]).length === 1) {
        const r1 = pending.get(sides[0])[0];
        const r2 = pending.get(sides[1])[0];
        const c = newCable(kind, r1.sourceId, r1.port, r2.sourceId, r2.port, status, r1);
        c.records.push(r2);
        cables.push(c);
    } else {
        pending.forEach(list => list.forEach(r => {
            cables.push(newCable(kind, r.sourceId, r.port, r.targetId, '', status, r));
        }));
    }
    return cables;
}

function nodeFromEntry(e, activeDcId) {
    return {
        id: e.id,
        kind: e.dcId === activeDcId ? 'device' : 'external',
        device: e.device,
        entry: e,
        location: e.location,
        dcId: e.dcId,
        dcName: e.dcName,
        isChassisNode: e.chassisIndex != null
    };
}

/**
 * Builds the full (unfiltered) topology of the active DC.
 * Link records of every DC are read so that cables recorded only on a device of another DC still show.
 * @returns {{ nodes:Array, nodesById:Map, cables:Array, types:string[] }}
 */
export function buildTopology(dcData, activeDcId) {
    const entries = collectDevices(dcData);
    const index = buildDeviceIndex(entries);
    const nodesById = new Map();
    const ensure = (e) => {
        if (!nodesById.has(e.id)) nodesById.set(e.id, nodeFromEntry(e, activeDcId));
        return e.id;
    };
    entries.filter(e => e.dcId === activeDcId).forEach(ensure);

    const groups = new Map();
    const loose = [];
    entries.forEach(e => {
        const srcActive = e.dcId === activeDcId;
        extractLinks(e).forEach(rec => {
            const r = resolveTarget(index, rec.target, e.dcId, e.id);
            if (r.status === 'ok') {
                if (!srcActive && r.entry.dcId !== activeDcId) return;
                ensure(e);
                ensure(r.entry);
                const resolved = { ...rec, targetId: r.entry.id, status: r.entry.dcId === e.dcId ? 'ok' : 'cross' };
                const [x, y] = e.id <= r.entry.id ? [e.id, r.entry.id] : [r.entry.id, e.id];
                const gk = `${rec.kind}\u0000${x}\u0000${y}`;
                if (!groups.has(gk)) groups.set(gk, []);
                groups.get(gk).push(resolved);
                return;
            }
            if (!srcActive) return;
            const key = lc(rec.target);
            if (r.status === 'missing') {
                const id = `virtual:${key}`;
                if (!nodesById.has(id)) nodesById.set(id, { id, kind: 'virtual', label: rec.target });
                loose.push({ ...rec, targetId: id, status: 'missing' });
            } else {
                const id = `ambiguous:${key}`;
                if (!nodesById.has(id)) {
                    nodesById.set(id, {
                        id, kind: 'ambiguous', label: rec.target,
                        candidates: r.candidates.map(c => ({
                            id: c.id, hostname: c.device.hostname || '', name: c.device.name || '',
                            type: c.device.type || '', ip: c.device.ip || c.device.cvmIp || '',
                            location: c.location, dcId: c.dcId, dcName: c.dcName
                        }))
                    });
                }
                loose.push({ ...rec, targetId: id, status: 'ambiguous' });
            }
        });
    });

    const cables = [];
    groups.forEach(records => cables.push(...mergePair(records)));
    loose.forEach(r => cables.push(newCable(r.kind, r.sourceId, r.port, r.targetId, r.targetPort, r.status, r)));

    const usedIds = new Set();
    cables.forEach(c => {
        // keep the active-DC end as "a" when only one side is local
        const aNode = nodesById.get(c.a.nodeId);
        const bNode = nodesById.get(c.b.nodeId);
        if (aNode && bNode && aNode.kind === 'external' && bNode.kind === 'device') {
            const t = c.a; c.a = c.b; c.b = t;
        }
        c.bidirectional = new Set(c.records.map(r => r.sourceId)).size > 1;
        c.label = cableLabel(c);
        const base = `cable:${c.kind}:${c.a.nodeId}:${c.a.port}|${c.b.nodeId}:${c.b.port}`;
        let id = base;
        let n = 2;
        while (usedIds.has(id)) id = `${base}#${n++}`;
        usedIds.add(id);
        c.id = id;
    });

    const nodes = [...nodesById.values()];
    const types = [...new Set(nodes.filter(n => n.device && n.device.type).map(n => n.device.type))].sort();
    return { nodes, nodesById, cables, types };
}

/** Gives cables between the same two nodes distinct offsets (parallelIndex / parallelCount). */
export function assignParallel(cables) {
    const byPair = new Map();
    cables.forEach(c => {
        const [x, y] = c.a.nodeId <= c.b.nodeId ? [c.a.nodeId, c.b.nodeId] : [c.b.nodeId, c.a.nodeId];
        const k = `${x}\u0000${y}`;
        if (!byPair.has(k)) byPair.set(k, []);
        byPair.get(k).push(c);
    });
    const out = [];
    byPair.forEach(list => list.forEach((c, i) => out.push({ ...c, parallelIndex: i, parallelCount: list.length })));
    return out;
}

/**
 * Visible subgraph.
 * @param {object} topo  result of buildTopology
 * @param {{showNetwork?:boolean, showPower?:boolean, types?:string[]|null, showIsolated?:boolean}} opts
 *        types: device types to keep (empty / null = all); a cable stays only if both ends pass
 */
export function filterTopology(topo, opts = {}) {
    const { showNetwork = true, showPower = true, types = null, showIsolated = false } = opts;
    const typeSet = types && types.length ? new Set(types) : null;
    const nodePass = (n) => !!n && (!typeSet || !n.device || typeSet.has(n.device.type));
    const cables = topo.cables.filter(c => (c.kind === 'power' ? showPower : showNetwork)
        && nodePass(topo.nodesById.get(c.a.nodeId)) && nodePass(topo.nodesById.get(c.b.nodeId)));
    const connected = new Set();
    cables.forEach(c => { connected.add(c.a.nodeId); connected.add(c.b.nodeId); });
    let hiddenIsolated = 0;
    const nodes = topo.nodes.filter(n => {
        if (connected.has(n.id)) return true;
        if (n.kind !== 'device' || !nodePass(n)) return false;
        if (showIsolated) return true;
        hiddenIsolated++;
        return false;
    });
    return { nodes, cables: assignParallel(cables), hiddenIsolated };
}

/**
 * Node positions: saved positions win, everything else from dagre on the given subgraph.
 * @returns {Object<string,{x:number,y:number}>}
 */
export function layoutPositions(nodes, cables, saved) {
    const savedOk = (id) => {
        const s = saved && saved[id];
        return s && Number.isFinite(s.x) && Number.isFinite(s.y) ? s : null;
    };
    const pos = {};
    let laidOut = null;
    if (nodes.some(n => !savedOk(n.id))) {
        try {
            const g = new dagre.graphlib.Graph();
            g.setDefaultEdgeLabel(() => ({}));
            g.setGraph({ rankdir: 'TB', nodesep: 100, ranksep: 200 });
            nodes.forEach(n => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
            cables.forEach(c => {
                if (c.a.nodeId !== c.b.nodeId) g.setEdge(c.a.nodeId, c.b.nodeId);
            });
            dagre.layout(g);
            laidOut = g;
        } catch {
            laidOut = null;
        }
    }
    nodes.forEach((n, i) => {
        const s = savedOk(n.id);
        if (s) { pos[n.id] = { x: s.x, y: s.y }; return; }
        const p = laidOut && laidOut.node(n.id);
        pos[n.id] = p && Number.isFinite(p.x) && Number.isFinite(p.y)
            ? { x: p.x - NODE_WIDTH / 2, y: p.y - NODE_HEIGHT / 2 }
            : { x: (i % 8) * 220, y: Math.floor(i / 8) * 160 };
    });
    return pos;
}

/**
 * What "Config Ports & Cables" should open for a node: the stored device (chassis parent for a
 * chassis node) and its rack / DC. Null for virtual / ambiguous nodes.
 */
export function editTargetFor(node, activeDcId) {
    if (!node || !node.entry) return null;
    const e = node.entry;
    return {
        device: e.stored,
        rackId: e.rackId,
        dcId: e.dcId,
        dcName: e.dcName,
        otherDc: e.dcId !== activeDcId,
        viaChassis: e.chassisIndex != null
    };
}

/** Case-insensitive search over hostname / name / ip / cvmIp (virtual nodes: their label). */
export function searchNodes(nodes, query) {
    const q = lc(query);
    if (!q) return [];
    const exact = [];
    const partial = [];
    (nodes || []).forEach(n => {
        const d = n.device || {};
        const fields = [d.hostname, d.name, d.ip, d.cvmIp, n.label].map(lc).filter(Boolean);
        if (fields.some(f => f === q)) exact.push(n.id);
        else if (fields.some(f => f.includes(q))) partial.push(n.id);
    });
    return [...exact, ...partial];
}

/** Display name of a node. */
export function nodeTitle(node) {
    if (!node) return '';
    if (!node.device) return node.label || '';
    const name = node.device.hostname || node.device.name || node.device.type || '';
    return node.kind === 'external' ? `${name} @ ${node.dcName}` : name;
}

// ---------------- SNMP overlay ----------------

/** Devices of the visible graph that may be polled (stored device id, SNMP-capable type, not a chassis node). */
export function snmpCandidates(nodes) {
    return (nodes || []).filter(n => n.entry && !n.isChassisNode && n.device
        && SNMP_TYPES.includes(n.device.type) && n.entry.stored && n.entry.stored.id);
}

export function portIndexFromLabel(label) {
    const m = /^P(\d+)$/i.exec(str(label));
    return m ? parseInt(m[1], 10) - 1 : null;
}

/** Same rule as ServerRack: livePorts[i] for port index i; Up when status 'Up' or value '1'. */
export function livePortStatus(livePorts, portIndex) {
    if (!Array.isArray(livePorts) || portIndex == null || portIndex < 0) return 'unknown';
    const p = livePorts[portIndex];
    if (!p) return 'unknown';
    return (p.status === 'Up' || p.value === '1' || p.value === 1) ? 'up' : 'down';
}

/** Status of one cable end from the poll results ({ [nodeId]: { ports } }). */
export function endpointStatus(pollByNode, nodeId, port) {
    const poll = pollByNode && pollByNode[nodeId];
    if (!poll || !Array.isArray(poll.ports)) return 'unknown';
    return livePortStatus(poll.ports, portIndexFromLabel(port));
}

/** Runs worker over items with at most `limit` in flight; never rejects. */
export async function runLimited(items, limit, worker) {
    const list = items || [];
    const results = new Array(list.length);
    let next = 0;
    const run = async () => {
        while (next < list.length) {
            const i = next++;
            try {
                results[i] = { ok: true, value: await worker(list[i], i) };
            } catch (error) {
                results[i] = { ok: false, error };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, run));
    return results;
}

/** Human message (繁中) for a failed poll (axios-like error). */
export function describePollError(err) {
    const status = err && err.response && err.response.status;
    const data = (err && err.response && err.response.data) || {};
    const msg = (typeof data.error === 'string' && data.error) || (err && err.message) || '';
    if (status === 409 || data.disabled) return 'SNMP 已停用';
    if (status === 400) return `SNMP 未設定或缺少 IP${msg ? `：${msg}` : ''}`;
    if (status === 403) return '沒有查詢權限';
    return `查詢失敗${status ? ` (${status})` : ''}${msg ? `：${msg}` : ''}`;
}
