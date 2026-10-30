import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    useNodesState,
    Handle,
    Position,
    BaseEdge,
    EdgeLabelRenderer
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import api from '../../api';
import {
    buildTopology,
    filterTopology,
    layoutPositions,
    editTargetFor,
    searchNodes,
    nodeTitle,
    snmpCandidates,
    endpointStatus,
    runLimited,
    describePollError,
    NETWORK_DEVICE_TYPES,
    MISSING_COLOR,
    AMBIGUOUS_COLOR,
    EXTERNAL_COLOR,
    STATUS_COLORS
} from './topologyGraph';
import './TopologyMap.css';

const TYPE_ICONS = {
    Switch: '🖧',
    Router: '🌐',
    Firewall: '🧱',
    Server: '🖥️',
    PowerBar: '⚡',
    Nutanix: '🧊',
    'Nutanix Node': '🧊',
    'Blade Node': '🗄️',
    LoadBalancer: '⚖️',
    Reserve: '🚧'
};

const STATUS_TEXT = { up: 'Up', down: 'Down', unknown: '未知' };
const MAX_CONCURRENT = 3;

// -----------------------------
// Saved node positions (per DC)
// -----------------------------
const positionsKey = (dcId) => `topology_positions_${dcId}`;

function readPositions(dcId) {
    if (!dcId) return {};
    try {
        const raw = localStorage.getItem(positionsKey(dcId));
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function savePositions(dcId, moved) {
    if (!dcId) return;
    try {
        const next = { ...readPositions(dcId) };
        moved.forEach(n => {
            if (n && n.position) next[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
        });
        localStorage.setItem(positionsKey(dcId), JSON.stringify(next));
    } catch {
        // storage unavailable: positions simply are not remembered
    }
}

function clearPositions(dcId) {
    if (!dcId) return;
    try {
        localStorage.removeItem(positionsKey(dcId));
    } catch {
        // ignore
    }
}

const errorText = (err) => (err && err.response && err.response.data && err.response.data.error) || (err && err.message) || '未知錯誤';

// -----------------------------
// Custom Node / Edge Components
// -----------------------------
const DeviceNode = ({ data }) => {
    const { node, dimmed, focused, snmpProblem } = data;
    const device = node.device;
    const external = node.kind === 'external';
    const isNetwork = NETWORK_DEVICE_TYPES.includes(device.type);
    const badge = external ? EXTERNAL_COLOR : (isNetwork ? '#a855f7' : (device.type === 'PowerBar' ? '#eab308' : '#38bdf8'));
    return (
        <div className={`custom-node${external ? ' external-node' : ''}${dimmed ? ' dimmed' : ''}${focused ? ' focused' : ''}`}>
            <Handle type="target" position={Position.Top} style={{ background: '#38bdf8' }} />
            <div className="node-type" style={{ background: badge }}>
                {external ? `${device.type || ''} · 跨 DC` : device.type}
            </div>
            <div className="node-icon">{TYPE_ICONS[device.type] || '💻'}</div>
            <div className="node-label">{nodeTitle(node)}</div>
            {(device.ip || device.cvmIp) && <div className="node-ip">{device.ip || device.cvmIp}</div>}
            {node.location && <div className="node-location">{node.location}</div>}
            {snmpProblem && <div className="node-snmp-problem" title={snmpProblem}>SNMP ⚠</div>}
            <Handle type="source" position={Position.Bottom} style={{ background: '#38bdf8' }} />
        </div>
    );
};

const UnresolvedNode = ({ data }) => {
    const { node, dimmed, focused } = data;
    const ambiguous = node.kind === 'ambiguous';
    return (
        <div className={`virtual-node${ambiguous ? ' ambiguous-node' : ''}${dimmed ? ' dimmed' : ''}${focused ? ' focused' : ''}`}>
            <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
            <div className="node-icon">{ambiguous ? '⚠️' : '❓'}</div>
            <div className="node-label">{node.label}</div>
            {ambiguous && <div className="node-sub">{node.candidates.length} 台同名設備</div>}
            <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        </div>
    );
};

// Quadratic curve; parallel cables between the same two nodes bend apart so none hides another.
const CableEdge = ({ id, sourceX, sourceY, targetX, targetY, data, style }) => {
    const count = data?.parallelCount || 1;
    const offset = ((data?.parallelIndex || 0) - (count - 1) / 2) * 40;
    const dx = targetX - sourceX;
    const dy = targetY - sourceY;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const mx = (sourceX + targetX) / 2;
    const my = (sourceY + targetY) / 2;
    const cx = mx + nx * offset * 2;
    const cy = my + ny * offset * 2;
    const path = `M ${sourceX},${sourceY} Q ${cx},${cy} ${targetX},${targetY}`;
    const at = (t) => ({
        x: (1 - t) * (1 - t) * sourceX + 2 * (1 - t) * t * cx + t * t * targetX,
        y: (1 - t) * (1 - t) * sourceY + 2 * (1 - t) * t * cy + t * t * targetY
    });
    const lx = mx + nx * offset;
    const ly = my + ny * offset;
    const endA = at(0.1);
    const endB = at(0.9);
    return (
        <>
            <BaseEdge id={id} path={path} style={style} interactionWidth={16} />
            {data?.showStatus && (
                <>
                    <circle cx={endA.x} cy={endA.y} r={6} fill={STATUS_COLORS[data.statusA]} stroke="#0f172a" strokeWidth={2} style={{ opacity: data.dimmed ? 0.2 : 1 }}>
                        <title>{`${data.portA}: ${STATUS_TEXT[data.statusA]}`}</title>
                    </circle>
                    <circle cx={endB.x} cy={endB.y} r={6} fill={STATUS_COLORS[data.statusB]} stroke="#0f172a" strokeWidth={2} style={{ opacity: data.dimmed ? 0.2 : 1 }}>
                        <title>{`${data.portB || '?'}: ${STATUS_TEXT[data.statusB]}`}</title>
                    </circle>
                </>
            )}
            <EdgeLabelRenderer>
                <div
                    className={`cable-label nodrag nopan${data?.dimmed ? ' dimmed' : ''}`}
                    style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
                >
                    {data?.label}
                </div>
            </EdgeLabelRenderer>
        </>
    );
};

const nodeTypes = {
    device: DeviceNode,
    unresolved: UnresolvedNode
};

const edgeTypes = {
    cable: CableEdge
};

const edgeVisual = (c) => {
    if (c.status === 'missing') return { color: MISSING_COLOR, dash: '5 5' };
    if (c.status === 'ambiguous') return { color: AMBIGUOUS_COLOR, dash: '8 4' };
    if (c.status === 'cross') return { color: c.color, dash: '2 5' };
    return { color: c.color, dash: undefined };
};

const minimapColor = (n) => {
    const kind = n.data?.node?.kind;
    if (kind === 'virtual') return MISSING_COLOR;
    if (kind === 'ambiguous') return AMBIGUOUS_COLOR;
    if (kind === 'external') return EXTERNAL_COLOR;
    return '#38bdf8';
};

// -----------------------------
// Main Component
// -----------------------------
/**
 * TopologyMap Component
 * Displays a graphical representation of network and power connections in the selected Datacenter.
 * @component
 * @param {Object} props
 * @param {string} props.selectedDCId - The currently selected DataCenter ID
 * @param {Function} props.onEditDevice - (storedDevice, defaultTab, { dcId }?) opens the device in ServerRack
 */
export default function TopologyMap({ selectedDCId, onEditDevice }) {
    const requestKey = selectedDCId || '';
    const [reloadToken, setReloadToken] = useState(0);
    // { forDc, token, activeDcId, activeDcName, dcData, failed, error }
    const [loaded, setLoaded] = useState(null);

    // Load the DC list + racks of every DC (targets may live in another DC). Stale responses are dropped.
    useEffect(() => {
        let cancelled = false;
        const token = reloadToken;
        (async () => {
            try {
                const dcRes = await api.get('/rack/datacenters');
                const dcs = Array.isArray(dcRes.data) ? dcRes.data.filter(d => d && d.id) : [];
                const active = dcs.find(d => d.id === requestKey) || dcs[0] || null;
                if (!active) {
                    if (!cancelled) setLoaded({ forDc: requestKey, token, activeDcId: null, activeDcName: '', dcData: [], failed: [], error: null });
                    return;
                }
                const results = await runLimited(dcs, MAX_CONCURRENT, d => api.get(`/rack?dcId=${encodeURIComponent(d.id)}`));
                if (cancelled) return;
                const activeResult = results[dcs.indexOf(active)];
                if (!activeResult.ok) throw activeResult.error;
                const dcData = [];
                const failed = [];
                results.forEach((r, i) => {
                    if (r.ok) dcData.push({ dc: dcs[i], racks: Array.isArray(r.value.data) ? r.value.data : [] });
                    else failed.push(dcs[i].name || dcs[i].id);
                });
                setLoaded({ forDc: requestKey, token, activeDcId: active.id, activeDcName: active.name || active.id, dcData, failed, error: null });
            } catch (err) {
                if (!cancelled) setLoaded({ forDc: requestKey, token, activeDcId: null, activeDcName: '', dcData: null, failed: [], error: errorText(err) });
            }
        })();
        return () => { cancelled = true; };
    }, [requestKey, reloadToken]);

    // Data of another DC is never shown while the new one loads
    const current = loaded && loaded.forDc === requestKey ? loaded : null;
    const refreshing = !current || current.token !== reloadToken;
    const activeDcId = current ? current.activeDcId : null;

    // ---- filters ----
    const [showNetwork, setShowNetwork] = useState(true);
    const [showPower, setShowPower] = useState(true);
    const [showIsolated, setShowIsolated] = useState(false);
    const [selectedTypes, setSelectedTypes] = useState([]);
    const [layoutVersion, setLayoutVersion] = useState(0);

    const topo = useMemo(
        () => (current && current.dcData && current.activeDcId ? buildTopology(current.dcData, current.activeDcId) : null),
        [current]
    );
    const effectiveTypes = useMemo(
        () => (topo ? selectedTypes.filter(t => topo.types.includes(t)) : []),
        [topo, selectedTypes]
    );
    const view = useMemo(
        () => (topo ? filterTopology(topo, { showNetwork, showPower, showIsolated, types: effectiveTypes }) : null),
        [topo, showNetwork, showPower, showIsolated, effectiveTypes]
    );
    const layout = useMemo(() => {
        if (!view) return null;
        return { view, version: layoutVersion, positions: layoutPositions(view.nodes, view.cables, readPositions(activeDcId)) };
    }, [view, activeDcId, layoutVersion]);

    // React Flow owns positions while dragging; reset them whenever the laid-out graph changes
    const [nodes, setNodes, onNodesChange] = useNodesState([]);
    const [syncedLayout, setSyncedLayout] = useState(null);
    if (layout !== syncedLayout) {
        setSyncedLayout(layout);
        setNodes(layout ? layout.view.nodes.map(n => ({
            id: n.id,
            type: n.device ? 'device' : 'unresolved',
            position: layout.positions[n.id],
            data: { node: n }
        })) : []);
    }

    // ---- selection / search ----
    const [selectedId, setSelectedId] = useState(null);
    const [search, setSearch] = useState('');
    const [searchState, setSearchState] = useState({ query: '', index: -1, message: '' });
    const [rf, setRf] = useState(null);

    const visibleIds = useMemo(() => new Set(view ? view.nodes.map(n => n.id) : []), [view]);
    const effectiveSelectedId = selectedId && visibleIds.has(selectedId) ? selectedId : null;
    const selectedNode = effectiveSelectedId && topo ? topo.nodesById.get(effectiveSelectedId) : null;

    const highlight = useMemo(() => {
        if (!effectiveSelectedId || !view) return null;
        const nodeIds = new Set([effectiveSelectedId]);
        const edgeIds = new Set();
        view.cables.forEach(c => {
            if (c.a.nodeId === effectiveSelectedId || c.b.nodeId === effectiveSelectedId) {
                edgeIds.add(c.id);
                nodeIds.add(c.a.nodeId);
                nodeIds.add(c.b.nodeId);
            }
        });
        return { nodeIds, edgeIds };
    }, [effectiveSelectedId, view]);

    const runSearch = () => {
        if (!topo || !view) return;
        const q = search.trim();
        const ids = searchNodes(topo.nodes, q);
        if (!q) {
            setSearchState({ query: '', index: -1, message: '' });
            return;
        }
        if (ids.length === 0) {
            setSearchState({ query: q, index: -1, message: '找不到符合的設備' });
            return;
        }
        const visible = ids.filter(id => visibleIds.has(id));
        if (visible.length === 0) {
            setSearchState({ query: q, index: -1, message: '符合的設備目前被篩選條件隱藏 (可開啟「顯示未接線設備」或調整篩選)' });
            return;
        }
        const index = searchState.query === q ? (searchState.index + 1) % visible.length : 0;
        const hit = visible[index];
        setSearchState({ query: q, index, message: visible.length > 1 ? `第 ${index + 1} / ${visible.length} 筆 (按 Enter 下一筆)` : '' });
        setSelectedId(hit);
        if (rf) rf.fitView({ nodes: [{ id: hit }], duration: 500, padding: 0.6, maxZoom: 1.2 });
    };

    // ---- SNMP live port overlay (on demand only) ----
    // { dcId, running, polls: {nodeId: pollData}, problems: {nodeId: message}, polled, skipped }
    const [snmp, setSnmp] = useState(null);
    const snmpSeq = useRef(0);
    const snmpOn = !!snmp && snmp.dcId === activeDcId;

    const runSnmp = useCallback(async (dcId, candidates) => {
        const seq = ++snmpSeq.current;
        setSnmp({ dcId, running: true, polls: {}, problems: {}, polled: 0, skipped: 0 });
        const problems = {};
        const deviceIdOf = (n) => String(n.entry.stored.id);

        // Which devices have SNMP enabled: the network-device list if this user may read it,
        // otherwise (or for types it does not cover) the per-device settings.
        let enabledById = null;
        try {
            const res = await api.get('/network-device/devices');
            enabledById = new Map((Array.isArray(res.data) ? res.data : []).map(d => [String(d.id), !!d.enabled]));
        } catch {
            enabledById = null;
        }
        if (seq !== snmpSeq.current) return;
        const unknown = candidates.filter(n => !enabledById || !enabledById.has(deviceIdOf(n)));
        const checks = await runLimited(unknown, MAX_CONCURRENT,
            n => api.get(`/network-device/${encodeURIComponent(deviceIdOf(n))}/snmp`));
        if (seq !== snmpSeq.current) return;
        const enabled = new Map(enabledById || []);
        unknown.forEach((n, i) => {
            const r = checks[i];
            enabled.set(deviceIdOf(n), !!(r.ok && r.value.data && r.value.data.enabled));
            if (!r.ok) problems[n.id] = `無法讀取 SNMP 設定：${describePollError(r.error)}`;
        });

        const toPoll = [];
        let skipped = 0;
        candidates.forEach(n => {
            if (enabled.get(deviceIdOf(n))) toPoll.push(n);
            else {
                skipped++;
                if (!problems[n.id]) problems[n.id] = 'SNMP 未啟用，未查詢';
            }
        });

        const polls = {};
        const results = await runLimited(toPoll, MAX_CONCURRENT,
            n => api.get(`/network-device/${encodeURIComponent(deviceIdOf(n))}/poll`));
        if (seq !== snmpSeq.current) return;
        toPoll.forEach((n, i) => {
            const r = results[i];
            if (!r.ok) {
                problems[n.id] = describePollError(r.error);
                return;
            }
            const data = r.value.data || {};
            if (Array.isArray(data.ports)) {
                polls[n.id] = data;
                if (data.success === false) problems[n.id] = `SNMP 回應不完整${data.error ? `：${data.error}` : ''}`;
            } else {
                problems[n.id] = `SNMP 無埠資料${data.error ? `：${data.error}` : ''}`;
            }
        });
        setSnmp({ dcId, running: false, polls, problems, polled: toPoll.length, skipped });
    }, []);

    const toggleSnmp = () => {
        if (snmpOn) {
            snmpSeq.current++;
            setSnmp(null);
        } else if (view && activeDcId) {
            runSnmp(activeDcId, snmpCandidates(view.nodes));
        }
    };

    const refresh = () => {
        setReloadToken(t => t + 1);
        if (snmpOn && view && activeDcId) runSnmp(activeDcId, snmpCandidates(view.nodes));
    };

    const relayout = () => {
        clearPositions(activeDcId);
        setLayoutVersion(v => v + 1);
        if (rf) setTimeout(() => rf.fitView({ padding: 0.2, duration: 400 }), 50);
    };

    const onNodeDragStop = useCallback((event, node, dragged) => {
        savePositions(activeDcId, dragged && dragged.length ? dragged : [node]);
    }, [activeDcId]);

    // ---- render data ----
    const snmpPolls = snmpOn ? snmp.polls : null;
    const snmpProblems = snmpOn ? snmp.problems : null;

    const displayNodes = useMemo(() => nodes.map(n => ({
        ...n,
        selected: n.id === effectiveSelectedId,
        data: {
            ...n.data,
            dimmed: !!highlight && !highlight.nodeIds.has(n.id),
            focused: n.id === effectiveSelectedId,
            snmpProblem: snmpProblems ? snmpProblems[n.id] : null
        }
    })), [nodes, highlight, effectiveSelectedId, snmpProblems]);

    const edges = useMemo(() => (view ? view.cables.map(c => {
        const { color, dash } = edgeVisual(c);
        const hl = !!highlight && highlight.edgeIds.has(c.id);
        const dimmed = !!highlight && !hl;
        const showStatus = !!snmpPolls && c.kind === 'network';
        return {
            id: c.id,
            source: c.a.nodeId,
            target: c.b.nodeId,
            type: 'cable',
            animated: hl,
            style: { stroke: color, strokeWidth: hl ? 3 : 2, strokeDasharray: dash, opacity: dimmed ? 0.15 : 1 },
            data: {
                label: c.label,
                parallelIndex: c.parallelIndex,
                parallelCount: c.parallelCount,
                dimmed,
                showStatus,
                portA: c.a.port,
                portB: c.b.port,
                statusA: showStatus ? endpointStatus(snmpPolls, c.a.nodeId, c.a.port) : 'unknown',
                statusB: showStatus ? endpointStatus(snmpPolls, c.b.nodeId, c.b.port) : 'unknown'
            }
        };
    }) : []), [view, highlight, snmpPolls]);

    const selectedCables = useMemo(() => {
        if (!selectedNode || !view) return [];
        return view.cables
            .filter(c => c.a.nodeId === selectedNode.id || c.b.nodeId === selectedNode.id)
            .map(c => {
                const mine = c.a.nodeId === selectedNode.id ? c.a : c.b;
                const other = c.a.nodeId === selectedNode.id ? c.b : c.a;
                return { cable: c, mine, other, peer: topo.nodesById.get(other.nodeId) };
            })
            .sort((x, y) => x.mine.port.localeCompare(y.mine.port, undefined, { numeric: true }));
    }, [selectedNode, view, topo]);

    const editTarget = editTargetFor(selectedNode, activeDcId);
    const openEdit = () => {
        if (!editTarget || !onEditDevice) return;
        const tab = editTarget.device.type === 'PowerBar' ? 'powerLinks' : 'portsCables';
        onEditDevice(editTarget.device, tab, editTarget.otherDc ? { dcId: editTarget.dcId } : undefined);
    };

    const toggleType = (t) => {
        setSelectedTypes(prev => {
            const base = prev.filter(x => topo && topo.types.includes(x));
            return base.includes(t) ? base.filter(x => x !== t) : [...base, t];
        });
    };

    const cableCounts = useMemo(() => {
        if (!view) return null;
        const counts = { network: 0, power: 0, missing: 0, ambiguous: 0, cross: 0 };
        view.cables.forEach(c => {
            counts[c.kind]++;
            if (c.status !== 'ok') counts[c.status]++;
        });
        return counts;
    }, [view]);

    // -----------------------------
    // Render
    // -----------------------------
    const renderBody = () => {
        if (!current) {
            return <div className="topology-message" style={{ color: 'var(--accent-primary)', fontSize: 18 }}>Analyzing connections...</div>;
        }
        if (current.error) {
            return (
                <div className="topology-message topology-error">
                    <p style={{ fontSize: 18, marginBottom: 8 }}>⚠ 無法載入機櫃資料</p>
                    <p style={{ fontSize: 14, marginBottom: 16 }}>{current.error}</p>
                    <button className="btn btn-primary" onClick={() => setReloadToken(t => t + 1)} disabled={refreshing}>
                        {refreshing ? '重新載入中…' : '重試'}
                    </button>
                </div>
            );
        }
        if (!view || view.nodes.length === 0) {
            return (
                <div className="topology-message" style={{ color: '#94a3b8' }}>
                    <p style={{ fontSize: 18, marginBottom: 8 }}>No connectable devices found</p>
                    <p style={{ fontSize: 14 }}>
                        {topo && topo.nodes.length > 0
                            ? '目前的篩選條件下沒有可顯示的連線，請調整圖層 / 類型篩選或開啟「顯示未接線設備」。'
                            : 'Please add Switches, Servers, or PowerBars with port links.'}
                    </p>
                </div>
            );
        }
        return (
            <>
                <div className="topology-flow-wrapper">
                    <ReactFlow
                        nodes={displayNodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onNodeClick={(event, node) => setSelectedId(node.id)}
                        onPaneClick={() => setSelectedId(null)}
                        onNodeDragStop={onNodeDragStop}
                        onInit={setRf}
                        nodeTypes={nodeTypes}
                        edgeTypes={edgeTypes}
                        nodesConnectable={false}
                        fitView
                        fitViewOptions={{ padding: 0.2 }}
                        defaultEdgeOptions={{ zIndex: 0 }}
                        colorMode="dark"
                    >
                        <Background color="#334155" gap={24} size={2} />
                        <Controls style={{ background: 'rgba(15, 23, 42, 0.9)', border: '1px solid #334155', borderRadius: 8, overflow: 'hidden' }} />
                        <MiniMap
                            nodeColor={minimapColor}
                            maskColor="rgba(15, 23, 42, 0.7)"
                            style={{ background: 'rgba(15, 23, 42, 0.9)', border: '1px solid #334155', borderRadius: 8 }}
                        />
                    </ReactFlow>
                </div>
                {renderSidePanel()}
            </>
        );
    };

    const renderPeer = (peer) => {
        if (!peer) return '?';
        if (peer.kind === 'virtual') return <span style={{ color: '#fca5a5' }}>{peer.label} (未知)</span>;
        if (peer.kind === 'ambiguous') return <span style={{ color: '#fdba74' }}>{peer.label} (不明確)</span>;
        return (
            <button className="link-btn" onClick={() => setSelectedId(peer.id)}>
                {nodeTitle(peer)}
            </button>
        );
    };

    const renderSidePanel = () => {
        const n = selectedNode;
        const d = n && n.device;
        const problem = n && snmpProblems ? snmpProblems[n.id] : null;
        const poll = n && snmpPolls ? snmpPolls[n.id] : null;
        return (
            <div className={`topology-side-panel ${n ? 'open' : ''}`}>
                <button className="panel-close-btn" onClick={() => setSelectedId(null)}>✕</button>
                {n && (
                    <>
                        <h3 style={{ marginBottom: 4 }}>
                            {n.kind === 'virtual' && '❓ 未知設備'}
                            {n.kind === 'ambiguous' && '⚠️ 名稱不明確'}
                            {d && `${nodeTitle(n) || 'Unknown'} Details`}
                        </h3>
                        {d && (
                            <div style={{ color: n.kind === 'external' ? EXTERNAL_COLOR : 'var(--accent-primary)', fontSize: '0.85rem', fontWeight: 600 }}>
                                {d.type}{n.kind === 'external' ? ` · 位於其他資料中心 (${n.dcName})` : ''}
                            </div>
                        )}

                        {n.kind === 'virtual' && (
                            <div className="node-detail-row" style={{ color: '#fca5a5', fontSize: 14, lineHeight: 1.5 }}>
                                連線指向「{n.label}」，但所有資料中心都找不到這台設備 (比對 hostname、名稱、IP / CVM IP)。可能是拼字錯誤，或設備已被移除 / 改名。
                            </div>
                        )}

                        {n.kind === 'ambiguous' && (
                            <div className="node-detail-row">
                                <div style={{ color: '#fdba74', fontSize: 14, lineHeight: 1.5, marginBottom: 8 }}>
                                    「{n.label}」對應到多台設備，無法判斷連到哪一台。請修正重複的 hostname 或改用唯一名稱。候選設備：
                                </div>
                                {n.candidates.map(c => (
                                    <div key={c.id} className="node-detail-value" style={{ marginBottom: 6 }}>
                                        {visibleIds.has(c.id)
                                            ? <button className="link-btn" onClick={() => setSelectedId(c.id)}>{c.hostname || c.name || c.id}</button>
                                            : <span>{c.hostname || c.name || c.id}</span>}
                                        <div style={{ fontSize: 12, color: '#94a3b8' }}>
                                            {[c.type, c.ip, c.location, c.dcName].filter(Boolean).join(' · ')}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {d && (
                            <>
                                {n.location && (
                                    <div className="node-detail-row">
                                        <span className="node-detail-label">Rack Location</span>
                                        <span className="node-detail-value">{n.location}{n.kind === 'external' ? ` @ ${n.dcName}` : ''}</span>
                                    </div>
                                )}
                                {n.isChassisNode && (
                                    <div className="node-detail-row">
                                        <span className="node-detail-label">Chassis</span>
                                        <span className="node-detail-value">{d.chassisName || n.entry.stored.hostname || n.entry.stored.name}</span>
                                    </div>
                                )}
                                {!n.isChassisNode && n.entry.stored.sizeU && (
                                    <div className="node-detail-row">
                                        <span className="node-detail-label">Size (U)</span>
                                        <span className="node-detail-value">{n.entry.stored.sizeU}U (Starts at U{n.entry.stored.startU})</span>
                                    </div>
                                )}
                                {(d.ip || d.cvmIp) && (
                                    <div className="node-detail-row">
                                        <span className="node-detail-label">IP Address</span>
                                        <span className="node-detail-value">{d.ip || d.cvmIp}</span>
                                    </div>
                                )}
                                <div className="node-detail-row">
                                    <span className="node-detail-label">Total Ports</span>
                                    <span className="node-detail-value">{d.ports || d.ways || 0}</span>
                                </div>
                            </>
                        )}

                        {(problem || poll) && (
                            <div className="node-detail-row">
                                <span className="node-detail-label">即時埠狀態 (SNMP)</span>
                                <span className="node-detail-value" style={{ color: problem ? '#fca5a5' : '#86efac' }}>
                                    {problem || `已查詢 ${poll.ports.length} 個埠${poll.live === false ? ' (非即時資料)' : ''}`}
                                </span>
                            </div>
                        )}

                        <div className="node-detail-row">
                            <span className="node-detail-label">連線 ({selectedCables.length})</span>
                            {selectedCables.length === 0 && <span className="node-detail-value" style={{ color: '#94a3b8' }}>目前顯示的圖層中沒有連線</span>}
                            <div className="cable-list">
                                {selectedCables.map(({ cable, mine, other, peer }) => {
                                    const statusMine = snmpPolls && cable.kind === 'network' ? endpointStatus(snmpPolls, mine.nodeId, mine.port) : null;
                                    const statusOther = snmpPolls && cable.kind === 'network' ? endpointStatus(snmpPolls, other.nodeId, other.port) : null;
                                    return (
                                        <div key={cable.id} className="cable-row" style={{ borderLeftColor: edgeVisual(cable).color }}>
                                            <div className="cable-row-ports">
                                                {statusMine && <span className="status-dot" style={{ background: STATUS_COLORS[statusMine] }} title={STATUS_TEXT[statusMine]} />}
                                                {cable.kind === 'power' ? '⚡ ' : ''}{mine.port || '?'} ↔ {other.port || '?'}
                                                {statusOther && <span className="status-dot" style={{ background: STATUS_COLORS[statusOther] }} title={STATUS_TEXT[statusOther]} />}
                                            </div>
                                            <div className="cable-row-peer">{renderPeer(peer)}</div>
                                            {cable.status === 'cross' && <div className="cable-row-note">跨資料中心連線</div>}
                                            {!cable.bidirectional && cable.status === 'ok' && <div className="cable-row-note">僅單側有紀錄</div>}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {editTarget && onEditDevice && (
                            <div style={{ marginTop: 8 }}>
                                <button
                                    className="btn btn-primary"
                                    style={{ width: '100%', padding: '10px 0', display: 'flex', justifyContent: 'center', gap: 8 }}
                                    onClick={openEdit}
                                >
                                    🔌 {editTarget.otherDc ? `切換至 ${editTarget.dcName} 並設定` : 'Config'} {editTarget.device.type === 'PowerBar' ? 'Power Links' : 'Ports & Cables'}
                                </button>
                                {editTarget.viaChassis && (
                                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>
                                        此節點屬於機箱「{editTarget.device.hostname || editTarget.device.name || editTarget.device.type}」，將開啟機箱設備進行設定。
                                    </div>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        );
    };

    const hasGraph = !!(current && !current.error && view);

    return (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="mb-2 flex justify-between items-center px-1 shrink-0">
                <div>
                    <h1 className="page-title" style={{ margin: 0 }}>Network Topology</h1>
                    <p className="page-subtitle">
                        Auto-generated layout based on rack port mappings{current && current.activeDcName ? ` · ${current.activeDcName}` : ''}
                    </p>
                </div>
            </div>

            <div className="topology-toolbar">
                <form className="topology-search" onSubmit={(e) => { e.preventDefault(); runSearch(); }}>
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="搜尋 hostname / 名稱 / IP"
                        disabled={!hasGraph}
                    />
                    <button type="submit" className="btn btn-secondary" disabled={!hasGraph}>搜尋</button>
                </form>

                <label className="topology-toggle">
                    <input type="checkbox" checked={showNetwork} onChange={e => setShowNetwork(e.target.checked)} /> 網路線
                </label>
                <label className="topology-toggle">
                    <input type="checkbox" checked={showPower} onChange={e => setShowPower(e.target.checked)} /> 電源線
                </label>
                <label className="topology-toggle">
                    <input type="checkbox" checked={showIsolated} onChange={e => setShowIsolated(e.target.checked)} /> 顯示未接線設備
                    {view && !showIsolated && view.hiddenIsolated > 0 ? ` (${view.hiddenIsolated})` : ''}
                </label>

                <div className="topology-toolbar-actions">
                    <button className="btn btn-secondary" onClick={toggleSnmp} disabled={!hasGraph || (snmpOn && snmp.running)}>
                        {snmpOn ? (snmp.running ? 'SNMP 查詢中…' : '隱藏即時埠狀態') : '顯示即時埠狀態'}
                    </button>
                    <button className="btn btn-secondary" onClick={relayout} disabled={!hasGraph}>重新排版</button>
                    <button className="btn btn-secondary" onClick={refresh} disabled={refreshing && !!current}>
                        {refreshing && current ? '整理中…' : '重新整理'}
                    </button>
                </div>
            </div>

            {topo && topo.types.length > 0 && (
                <div className="topology-type-chips">
                    <span className="chip-label">設備類型：</span>
                    <button className={`type-chip${effectiveTypes.length === 0 ? ' active' : ''}`} onClick={() => setSelectedTypes([])}>全部</button>
                    {topo.types.map(t => (
                        <button key={t} className={`type-chip${effectiveTypes.includes(t) ? ' active' : ''}`} onClick={() => toggleType(t)}>
                            {TYPE_ICONS[t] || '💻'} {t}
                        </button>
                    ))}
                </div>
            )}

            {(searchState.message || (current && current.failed && current.failed.length > 0) || (snmpOn && !snmp.running) || cableCounts) && hasGraph && (
                <div className="topology-status-line">
                    {cableCounts && (
                        <span>
                            網路線 {cableCounts.network} · 電源線 {cableCounts.power}
                            {cableCounts.cross > 0 && <span style={{ color: EXTERNAL_COLOR }}> · 跨 DC {cableCounts.cross}</span>}
                            {cableCounts.ambiguous > 0 && <span style={{ color: AMBIGUOUS_COLOR }}> · 不明確 {cableCounts.ambiguous}</span>}
                            {cableCounts.missing > 0 && <span style={{ color: MISSING_COLOR }}> · 找不到目標 {cableCounts.missing}</span>}
                        </span>
                    )}
                    {snmpOn && !snmp.running && (
                        <span>
                            SNMP：已查詢 {snmp.polled} 台{snmp.skipped > 0 ? `，${snmp.skipped} 台未啟用` : ''}
                            {Object.keys(snmp.problems).length > 0 ? `，${Object.keys(snmp.problems).length} 台有訊息 (點選設備查看)` : ''}
                            {' · '}
                            <span className="status-dot" style={{ background: STATUS_COLORS.up }} /> Up
                            <span className="status-dot" style={{ background: STATUS_COLORS.down }} /> Down
                            <span className="status-dot" style={{ background: STATUS_COLORS.unknown }} /> 未知
                        </span>
                    )}
                    {current && current.failed && current.failed.length > 0 && (
                        <span style={{ color: '#fdba74' }}>部分資料中心載入失敗 ({current.failed.join(', ')})，指向它們的連線可能顯示為未知設備</span>
                    )}
                    {searchState.message && <span style={{ color: '#fde68a' }}>{searchState.message}</span>}
                </div>
            )}

            <div className="topology-container">
                {renderBody()}
            </div>
        </div>
    );
}
