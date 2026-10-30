import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  ReactFlow, addEdge, useNodesState, useEdgesState, Controls, Background, MiniMap,
  Handle, Position, Panel, useReactFlow, ReactFlowProvider
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import api from '../../api';

const rfStyles = `
.react-flow { background: var(--bg-primary) !important; }
.react-flow__background { background: var(--bg-primary) !important; }
.react-flow__background pattern circle { fill: var(--text-muted) !important; opacity: 0.15; }
.react-flow__controls { background: var(--bg-secondary) !important; border: 1px solid var(--border-color) !important; border-radius: 10px !important; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.2) !important; }
.react-flow__controls button { background: var(--bg-secondary) !important; color: var(--text-primary) !important; border-bottom: 1px solid var(--border-color) !important; fill: var(--text-primary) !important; width: 28px !important; height: 28px !important; }
.react-flow__controls button:hover { background: var(--bg-hover) !important; }
.react-flow__minimap { background: var(--bg-secondary) !important; border: 1px solid var(--border-color) !important; border-radius: 10px !important; box-shadow: 0 8px 24px rgba(0,0,0,0.2) !important; }
.react-flow__minimap svg { background: var(--bg-primary) !important; }
.react-flow__attribution { display: none !important; }
.react-flow__handle { background: var(--accent-primary) !important; border: 2px solid var(--bg-primary) !important; width: 10px !important; height: 10px !important; transition: transform 0.2s; }
.react-flow__handle:hover { transform: scale(1.4); }
.react-flow__edge-path { stroke: var(--text-muted) !important; stroke-width: 2; transition: stroke 0.3s, stroke-width 0.3s; }
.react-flow__edge:hover .react-flow__edge-path { stroke: var(--accent-primary) !important; stroke-width: 3; }
.react-flow__connection-path { stroke: var(--accent-primary) !important; stroke-width: 2.5; stroke-dasharray: 5,5; }
.react-flow__node.selected > div { border-color: var(--accent-primary) !important; box-shadow: 0 0 0 3px rgba(139,92,246,0.35), 0 12px 30px rgba(0,0,0,0.3) !important; }

.wf-node-card {
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 6px 20px rgba(0,0,0,0.2);
}
.wf-node-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 28px rgba(0,0,0,0.35);
}

.pulse-running {
  animation: wfPulse 1.8s infinite;
}
@keyframes wfPulse {
  0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.6); }
  70% { box-shadow: 0 0 0 10px rgba(245, 158, 11, 0); }
  100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
}

.btn-action-pill {
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 700;
  border-radius: 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 0.2s;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
}
.btn-action-pill:hover {
  background: var(--bg-hover);
  border-color: var(--accent-primary);
  transform: translateY(-1px);
}
`;

let toastRef = { current: null };
const toast = (type, msg) => {
  if (toastRef.current) {
    toastRef.current(type, msg);
  } else {
    console.log(`[${type.toUpperCase()}] ${msg}`);
  }
};

const NODE_TYPES = {
  ssh: { type: 'ssh', label: 'SSH Command', icon: '🔑', color: '#3b82f6', category: 'execution', desc: 'Run bash commands on remote Linux servers', inputs: ['host','command','username','password','authMethod','sshKey','timeout'] },
  powershell: { type: 'powershell', label: 'PowerShell', icon: '🪟', color: '#06b6d4', category: 'execution', desc: 'Execute PowerShell script on Windows hosts', inputs: ['host','command','username','password','timeout'] },
  http: { type: 'http', label: 'HTTP / Webhook', icon: '🌐', color: '#10b981', category: 'execution', desc: 'Send HTTP REST requests or Webhook alerts', inputs: ['url','method','headers','body','timeout'] },
  k8s: { type: 'k8s', label: 'Kubernetes', icon: '☸️', color: '#6366f1', category: 'execution', desc: 'Manage pods, deployments, and namespaces', inputs: ['command','namespace','kubeconfig','timeout'] },
  nutanix: { type: 'nutanix', label: 'Nutanix AHV', icon: '🏢', color: '#f59e0b', category: 'execution', desc: 'Control Nutanix Prism VM operations', inputs: ['action','cluster','vmName','params'] },
  condition: { type: 'condition', label: 'Condition (If/Else)', icon: '🔀', color: '#f97316', category: 'logic', desc: 'Evaluate expression and branch to true/false', inputs: ['expression'] },
  loop: { type: 'loop', label: 'For-Each Loop', icon: '🔄', color: '#8b5cf6', category: 'logic', desc: 'Iterate over array variables in context', inputs: ['items','itemVar','indexVar'] },
  approval: { type: 'approval', label: 'Manual Approval', icon: '👤', color: '#ec4899', category: 'control', desc: 'Pause workflow until a SuperAdmin approves', inputs: ['message'] },
  script: { type: 'script', label: 'JS Script (Sandboxed)', icon: '📜', color: '#14b8a6', category: 'execution', desc: 'Run custom JavaScript logic with ctx access', inputs: ['code'] },
  sleep: { type: 'sleep', label: 'Sleep Delay', icon: '⏳', color: '#64748b', category: 'control', desc: 'Pause execution for specified seconds', inputs: ['seconds'] },
};

// Empty value for every configurable input of a node type
const getInitialNodeData = (type) => (NODE_TYPES[type]?.inputs || []).reduce((a, k) => ({ ...a, [k]: '' }), {});

// Node & execution status display (node: running/success/failed/skipped/pending_approval/rejected/pending,
// execution: success/failed/waiting_approval/rejected/running)
const STATUS_META = {
  running:          { label: '⏳ RUNNING...', badge: '⏳ Running',  color: '#f59e0b', bg: 'rgba(245,158,11,0.2)' },
  success:          { label: '✅ SUCCESS',    badge: '🟢 Success',  color: '#10b981', bg: 'rgba(16,185,129,0.2)' },
  failed:           { label: '❌ FAILED',     badge: '🔴 Failed',   color: '#ef4444', bg: 'rgba(239,68,68,0.2)' },
  skipped:          { label: '⏭️ SKIPPED',    badge: '⏭️ Skipped',  color: '#6b7280', bg: 'rgba(107,114,128,0.2)' },
  pending:          { label: '… PENDING',     badge: '… Pending',   color: '#6b7280', bg: 'rgba(107,114,128,0.15)' },
  pending_approval: { label: '👤 AWAITING APPROVAL', badge: '👤 Awaiting', color: '#ec4899', bg: 'rgba(236,72,153,0.2)' },
  waiting_approval: { label: '👤 AWAITING APPROVAL', badge: '👤 Awaiting Approval', color: '#ec4899', bg: 'rgba(236,72,153,0.2)' },
  rejected:         { label: '⛔ REJECTED',   badge: '⛔ Rejected', color: '#ef4444', bg: 'rgba(239,68,68,0.2)' },
};
const statusMeta = (status) => STATUS_META[status] || { label: String(status || '').toUpperCase(), badge: String(status || ''), color: '#6b7280', bg: 'rgba(107,114,128,0.2)' };

function WorkflowNode({ data, selected }) {
  const isCondition = data.nodeType === 'condition';
  const nodeDef = NODE_TYPES[data.nodeType] || { color: '#8b5cf6', icon: '⚡', label: data.label || 'Node' };
  
  let diffBorder = '';
  let diffBg = '';
  if (data.diffStatus === 'added') { diffBorder = '#10b981'; diffBg = 'rgba(16,185,129,0.15)'; }
  else if (data.diffStatus === 'deleted') { diffBorder = '#ef4444'; diffBg = 'rgba(239,68,68,0.15)'; }
  else if (data.diffStatus === 'modified') { diffBorder = '#f59e0b'; diffBg = 'rgba(245,158,11,0.15)'; }

  // Execution Status indicator
  const execStatus = data.executionStatus; // see STATUS_META
  const execMeta = execStatus ? statusMeta(execStatus) : null;

  return (
    <div className={`wf-node-card ${execStatus === 'running' ? 'pulse-running' : ''}`} style={{
      padding: '0px',
      borderRadius: 14,
      border: `2px ${diffBorder ? 'dashed' : 'solid'} ${
        diffBorder || (execMeta && execStatus !== 'pending' ? execMeta.color : selected ? 'var(--accent-primary)' : 'rgba(255,255,255,0.08)')
      }`,
      background: diffBg || 'var(--bg-secondary)',
      backdropFilter: 'blur(16px)',
      minWidth: 200,
      maxWidth: 260,
      fontSize: 12,
      position: 'relative',
      overflow: 'hidden',
      opacity: data.diffStatus === 'deleted' ? 0.6 : 1
    }}>
      {/* Top Handle */}
      <Handle type="target" position={Position.Top} style={{ background: nodeDef.color }} />

      {/* Header Bar */}
      <div style={{
        background: `linear-gradient(90deg, ${nodeDef.color}25, rgba(255,255,255,0.02))`,
        borderBottom: `1px solid ${nodeDef.color}35`,
        padding: '8px 12px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 800, color: 'var(--text-primary)', fontSize: 12 }}>
          <span style={{ fontSize: 14 }}>{nodeDef.icon}</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.label || nodeDef.label}</span>
        </div>
        <span style={{
          fontSize: 9,
          fontWeight: 800,
          textTransform: 'uppercase',
          padding: '2px 6px',
          borderRadius: 6,
          background: `${nodeDef.color}30`,
          color: nodeDef.color,
          letterSpacing: '0.04em'
        }}>
          {data.nodeType}
        </span>
      </div>

      {/* Body Content / Parameters Preview */}
      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {data.host && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-secondary)', fontSize: 11 }}>
            <span style={{ opacity: 0.7 }}>🖥️</span>
            <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{data.host}</span>
          </div>
        )}
        {data.command && (
          <div style={{
            fontSize: 11,
            fontFamily: 'monospace',
            background: 'rgba(0,0,0,0.25)',
            padding: '4px 6px',
            borderRadius: 6,
            color: '#38bdf8',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}>
            {data.command}
          </div>
        )}
        {data.url && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
            <span style={{
              background: data.method === 'POST' ? 'rgba(59,130,246,0.2)' : 'rgba(16,185,129,0.2)',
              color: data.method === 'POST' ? '#60a5fa' : '#34d399',
              padding: '1px 5px',
              borderRadius: 4,
              fontSize: 9,
              fontWeight: 800
            }}>{data.method || 'GET'}</span>
            <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
              {data.url}
            </span>
          </div>
        )}
        {data.expression && (
          <div style={{
            fontSize: 11,
            fontFamily: 'monospace',
            color: '#fb923c',
            background: 'rgba(249,115,22,0.1)',
            padding: '4px 6px',
            borderRadius: 6
          }}>
            {data.expression}
          </div>
        )}
        {data.code && (
          <div style={{ fontSize: 10, fontFamily: 'monospace', color: '#2dd4bf', background: 'rgba(0,0,0,0.2)', padding: '3px 6px', borderRadius: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            JS: {data.code.slice(0, 35)}...
          </div>
        )}
      </div>

      {/* Execution / Diff Badges */}
      {execStatus && (
        <div style={{
          padding: '3px 8px',
          fontSize: 10,
          fontWeight: 800,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          background: execMeta.bg,
          color: execMeta.color,
          borderTop: '1px solid rgba(255,255,255,0.05)'
        }}>
          {execMeta.label}
          {execStatus === 'success' && data.executionDuration ? ` (${data.executionDuration}ms)` : ''}
          {execStatus === 'failed' && data.executionError ? `: ${data.executionError.slice(0, 20)}` : ''}
        </div>
      )}

      {/* Bottom Handles */}
      {isCondition ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 16px 6px 16px', fontSize: 10, fontWeight: 800 }}>
          <div style={{ position: 'relative', color: '#10b981' }}>
            <Handle type="source" position={Position.Bottom} id="true" style={{ background: '#10b981', left: 10 }} />
            <span style={{ fontSize: 9 }}>TRUE</span>
          </div>
          <div style={{ position: 'relative', color: '#ef4444' }}>
            <Handle type="source" position={Position.Bottom} id="false" style={{ background: '#ef4444', left: 10 }} />
            <span style={{ fontSize: 9 }}>FALSE</span>
          </div>
        </div>
      ) : (
        <Handle type="source" position={Position.Bottom} style={{ background: nodeDef.color }} />
      )}
    </div>
  );
}

const nodeTypes = { workflowNode: WorkflowNode };

// Clears the cross-page pending-open marker set by agentClient.requestOpen
function clearPendingOpen(type) {
  if (window.__sompPendingOpen?.type === type) window.__sompPendingOpen = null;
}

function WorkflowEditor() {
  const { setCenter, getZoom } = useReactFlow();
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const role = user.role || 'Viewer';
  const [workflows, setWorkflows] = useState([]);
  // Agent cross-page open: id waiting to be loaded once the list is fetched (ref avoids set-state-in-effect)
  const pendingWorkflowRef = useRef(window.__sompPendingOpen?.type === 'workflow' ? window.__sompPendingOpen.id : null);
  const fetchWorkflowsRef = useRef(null);
  const [alertConfig, setAlertConfig] = useState(null);
  const [showTemplatesModal, setShowTemplatesModal] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [saveAsTemplateName, setSaveAsTemplateName] = useState('');
  const [saveAsTemplateDesc, setSaveAsTemplateDesc] = useState('');

  // Server Inventory
  const [inventoryList, setInventoryList] = useState([]);
  const [k8sClusters, setK8sClusters] = useState([]);
  const [systemWebhooks, setSystemWebhooks] = useState([]);

  // Toast setup
  useEffect(() => {
    toastRef.current = (type, msg) => {
      setAlertConfig({ type, message: msg });
    };
    return () => {
      toastRef.current = null;
    };
  }, []);

  const [activeWorkflow, setActiveWorkflow] = useState(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDesc, setWorkflowDesc] = useState('');
  const [varList, setVarList] = useState([{ key: '', value: '' }]);
  const [executions, setExecutions] = useState([]);
  const [selectedExecution, setSelectedExecution] = useState(null);
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [running, setRunning] = useState(false);
  const reactFlowWrapper = useRef(null);

  // Versions & Diff
  const [showVersionsModal, setShowVersionsModal] = useState(false);
  const [workflowHistory, setWorkflowHistory] = useState([]);
  const [diffMode, setDiffMode] = useState(false);
  const [diffBase, setDiffBase] = useState(null);

  // Quick-Add Palette Modal
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddSearch, setQuickAddSearch] = useState('');
  const [quickAddPos, setQuickAddPos] = useState({ x: 250, y: 150 });

  // Single-Node Live Tester Modal/Drawer
  const [showTestModal, setShowTestModal] = useState(false);
  const [testingNode, setTestingNode] = useState(false);
  const [nodeTestResult, setNodeTestResult] = useState(null);

  // AI Workflow Copilot Modal
  const [showAiCopilot, setShowAiCopilot] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiAuditResult, setAiAuditResult] = useState(null);

  // Delete Workflow Modal
  const [showDeleteWorkflowConfirm, setShowDeleteWorkflowConfirm] = useState(false);

  const deleteCurrentWorkflow = async () => {
    if (!activeWorkflow) return;
    try {
      await api.delete(`/workflow/${activeWorkflow.id}`);
      toast('success', `Deleted workflow "${activeWorkflow.name}"`);
      setShowDeleteWorkflowConfirm(false);
      const remaining = workflows.filter(w => w.id !== activeWorkflow.id);
      setWorkflows(remaining);
      if (remaining.length > 0) {
        loadWorkflow(remaining[0]);
      } else {
        setActiveWorkflow(null);
        setWorkflowName('');
        setWorkflowDesc('');
        setNodes([]);
        setEdges([]);
      }
    } catch (e) {
      toast('error', 'Failed to delete workflow: ' + (e.response?.data?.error || e.message));
    }
  };

  useEffect(() => {
    fetchWorkflows();
    fetchInventory();
    fetchK8sClusters();
    fetchWebhooks();
  }, []);

  const fetchWebhooks = async () => {
    try {
      const res = await api.get('/webhooks');
      if (Array.isArray(res.data)) {
        setSystemWebhooks(res.data);
      }
    } catch (e) {
      console.warn('Webhooks unavailable:', e.message);
    }
  };

  const fetchK8sClusters = async () => {
    try {
      const res = await api.get('/kubernetes/clusters');
      if (res.data?.clusters) {
        setK8sClusters(res.data.clusters);
      }
    } catch (e) {
      console.warn('Kubernetes clusters unavailable:', e.message);
    }
  };

  useEffect(() => {
    if (activeWorkflow) fetchExecutions();
  }, [activeWorkflow]);

  // Keyboard Shortcuts (Ctrl+S, Delete, Space/Slash)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveWorkflow();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && selectedNode) {
        e.preventDefault();
        duplicateSelectedNode();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        autoLayout('TB');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNode, nodes, edges, activeWorkflow, workflowName, workflowDesc, varList]);

  const fetchWorkflows = async () => {
    try {
      const res = await api.get('/workflow');
      setWorkflows(res.data);
      const pendingId = pendingWorkflowRef.current;
      const target = pendingId ? res.data.find(w => w.id === pendingId) : null;
      if (pendingId) {
        pendingWorkflowRef.current = null;
        clearPendingOpen('workflow');
      }
      if (target) loadWorkflow(target);
      else if (!activeWorkflow && res.data.length > 0) loadWorkflow(res.data[0]);
    } catch (e) {
      console.error('Failed to load workflows:', e);
    }
  };

  useEffect(() => { fetchWorkflowsRef.current = fetchWorkflows; });

  useEffect(() => {
    const onOpen = (e) => {
      pendingWorkflowRef.current = e.detail?.id || null;
      if (fetchWorkflowsRef.current) fetchWorkflowsRef.current();
    };
    window.addEventListener('somp:open-workflow', onOpen);
    return () => window.removeEventListener('somp:open-workflow', onOpen);
  }, []);

  const fetchInventory = async () => {
    try {
      const res = await api.get('/inventory/data');
      const list = [];
      if (res.data && typeof res.data === 'object') {
        Object.entries(res.data).forEach(([subnet, hosts]) => {
          if (Array.isArray(hosts)) {
            hosts.forEach(h => {
              if (h.ip) list.push({ ip: h.ip, hostname: h.hostname || h.name || '', os: h.os || '' });
            });
          }
        });
      }
      setInventoryList(list);
    } catch (e) {
      try {
        const res2 = await api.get('/servers');
        setInventoryList(Array.isArray(res2.data) ? res2.data : []);
      } catch (err) {
        console.warn('Inventory list unavailable:', err.message);
      }
    }
  };

  const loadWorkflow = (wf) => {
    setActiveWorkflow(wf);
    setWorkflowName(wf.name);
    setWorkflowDesc(wf.description || '');
    const varsObj = wf.variables || {};
    const parsedList = Object.entries(varsObj).map(([k, v]) => ({ key: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
    setVarList(parsedList.length > 0 ? parsedList : [{ key: '', value: '' }]);
    setNodes(wf.nodes.map(n => ({
      ...n,
      type: 'workflowNode',
      data: { ...n.data, nodeType: n.type, color: NODE_TYPES[n.type]?.color || 'var(--text-muted)', icon: NODE_TYPES[n.type]?.icon || '⬜', label: n.data?.label || NODE_TYPES[n.type]?.label || n.type }
    })));
    setEdges(wf.edges || []);
    setSelectedNode(null);
    setDiffMode(false);
    setDiffBase(null);
  };

  const fetchExecutions = async () => {
    try {
      const res = await api.get(`/workflow/${activeWorkflow.id}/executions?limit=25`);
      setExecutions(res.data);
      if (res.data?.length > 0) {
        setSelectedExecution(prev => prev ? (res.data.find(e => e.id === prev.id) || res.data[0]) : res.data[0]);
      }
    } catch (e) {}
  };

  const onConnect = useCallback((params) => {
    setEdges(eds => addEdge({ ...params, animated: true }, eds));
  }, [setEdges]);

  const onNodeClick = useCallback((_, node) => setSelectedNode(node), []);

  const onPaneDoubleClick = useCallback((event) => {
    const position = reactFlowWrapper.current
      ? reactFlowWrapper.current.getBoundingClientRect()
      : { left: 0, top: 0 };
    setQuickAddPos({
      x: event.clientX - position.left - 100,
      y: event.clientY - position.top - 40
    });
    setShowQuickAdd(true);
    setQuickAddSearch('');
  }, []);

  const addNodeByType = (type, customPos) => {
    const def = NODE_TYPES[type];
    if (!def) return;
    const pos = customPos || quickAddPos || { x: 250, y: 150 };
    const newId = `${type}-${Date.now().toString(36)}`;
    const newNode = {
      id: newId,
      type: 'workflowNode',
      position: pos,
      data: {
        nodeType: type,
        label: def.label,
        icon: def.icon,
        color: def.color,
        ...getInitialNodeData(type)
      }
    };
    setNodes(nds => [...nds, newNode]);
    setShowQuickAdd(false);
    setSelectedNode(newNode);
  };

  const onDrop = useCallback((event) => {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/reactflow');
    if (!type || !NODE_TYPES[type]) return;

    const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
    const position = {
      x: event.clientX - reactFlowBounds.left - 100,
      y: event.clientY - reactFlowBounds.top - 40
    };

    const newNodeId = `${type}-${Date.now().toString(36)}`;
    const newNode = {
      id: newNodeId,
      type: 'workflowNode',
      position,
      data: {
        nodeType: type,
        label: NODE_TYPES[type].label,
        color: NODE_TYPES[type].color,
        icon: NODE_TYPES[type].icon,
        ...getInitialNodeData(type),
        timeout: 30,
        authMethod: 'password'
      }
    };
    setNodes(nds => [...nds, newNode]);
    setSelectedNode(newNode);
  }, [setNodes]);

  const onDragOver = useCallback((event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }, []);

  const updateNodeData = (key, val) => {
    if (!selectedNode) return;
    setNodes(nds => nds.map(n => {
      if (n.id === selectedNode.id) {
        const updatedNode = { ...n, data: { ...n.data, [key]: val } };
        setSelectedNode(updatedNode);
        return updatedNode;
      }
      return n;
    }));
  };

  const deleteNode = () => {
    if (!selectedNode) return;
    setNodes(nds => nds.filter(n => n.id !== selectedNode.id));
    setEdges(eds => eds.filter(e => e.source !== selectedNode.id && e.target !== selectedNode.id));
    setSelectedNode(null);
  };

  const duplicateSelectedNode = () => {
    if (!selectedNode) return;
    const newId = `${selectedNode.data.nodeType}-${Date.now().toString(36)}`;
    const duplicatedNode = {
      ...selectedNode,
      id: newId,
      position: { x: selectedNode.position.x + 40, y: selectedNode.position.y + 40 },
      data: { ...selectedNode.data, label: `${selectedNode.data.label || selectedNode.data.nodeType} (Copy)` }
    };
    setNodes(nds => [...nds, duplicatedNode]);
    setSelectedNode(duplicatedNode);
    toast('success', `Duplicated ${selectedNode.data.label}`);
  };

  const deleteSelectedNodes = () => {
    const selectedIds = nodes.filter(n => n.selected).map(n => n.id);
    setNodes(nds => nds.filter(n => !selectedIds.includes(n.id)));
    setEdges(eds => eds.filter(e => !selectedIds.includes(e.source) && !selectedIds.includes(e.target)));
    if (selectedNode && selectedIds.includes(selectedNode.id)) setSelectedNode(null);
  };

  // ─── Auto-Layout (DAG Topological Rank Layout) ─────
  const autoLayout = (direction = 'TB', overrideNodes = null, overrideEdges = null) => {
    const targetNodes = overrideNodes || nodes;
    const targetEdges = overrideEdges || edges;
    if (!targetNodes || targetNodes.length === 0) return;
    const isHorizontal = direction === 'LR';

    // Build Adjacency & In-degrees
    const inDegree = {};
    const adj = {};
    targetNodes.forEach(n => {
      inDegree[n.id] = 0;
      adj[n.id] = [];
    });
    targetEdges.forEach(e => {
      if (adj[e.source]) adj[e.source].push(e.target);
      if (inDegree[e.target] !== undefined) inDegree[e.target]++;
    });

    // Compute ranks via BFS
    const ranks = {};
    const queue = [];
    targetNodes.forEach(n => {
      if (inDegree[n.id] === 0) {
        ranks[n.id] = 0;
        queue.push(n.id);
      }
    });

    // Fallback if cycles exist
    if (queue.length === 0 && targetNodes.length > 0) {
      ranks[targetNodes[0].id] = 0;
      queue.push(targetNodes[0].id);
    }

    while (queue.length > 0) {
      const u = queue.shift();
      const nextRank = (ranks[u] || 0) + 1;
      (adj[u] || []).forEach(v => {
        if (ranks[v] === undefined || ranks[v] < nextRank) {
          ranks[v] = nextRank;
          queue.push(v);
        }
      });
    }

    // Group by rank
    const rankGroups = {};
    targetNodes.forEach(n => {
      const r = ranks[n.id] || 0;
      if (!rankGroups[r]) rankGroups[r] = [];
      rankGroups[r].push(n.id);
    });

    // Position assignments
    const updatedNodes = targetNodes.map(n => {
      const r = ranks[n.id] || 0;
      const group = rankGroups[r] || [n.id];
      const indexInGroup = group.indexOf(n.id);
      const groupSize = group.length;

      let x, y;
      if (isHorizontal) {
        x = 100 + r * 280;
        y = 150 + (indexInGroup - (groupSize - 1) / 2) * 160;
      } else {
        x = 350 + (indexInGroup - (groupSize - 1) / 2) * 260;
        y = 80 + r * 170;
      }
      return { ...n, position: { x, y } };
    });

    setNodes(updatedNodes);
    toast('success', `Auto-aligned workflow (${direction === 'TB' ? 'Vertical' : 'Horizontal'})`);
  };

  const saveWorkflow = async () => {
    let vars = {};
    varList.forEach(item => {
      if (item.key && item.key.trim()) {
        let parsedVal = item.value;
        try {
          if ((item.value.startsWith('{') && item.value.endsWith('}')) || (item.value.startsWith('[') && item.value.endsWith(']'))) {
            parsedVal = JSON.parse(item.value);
          }
        } catch {}
        vars[item.key.trim()] = parsedVal;
      }
    });

    const payload = {
      name: workflowName || 'New Automation Workflow',
      description: workflowDesc || '',
      nodes: nodes.map(n => ({
        id: n.id,
        type: n.data?.nodeType || n.type || 'ssh',
        position: n.position || { x: 250, y: 100 },
        data: n.data || {}
      })),
      edges: edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle || null
      })),
      variables: vars
    };

    try {
      if (activeWorkflow && activeWorkflow.id) {
        const res = await api.put(`/workflow/${activeWorkflow.id}`, payload);
        setActiveWorkflow(res.data);
        toast('success', `Workflow "${res.data.name}" saved successfully`);
      } else {
        const res = await api.post('/workflow', payload);
        setActiveWorkflow(res.data);
        toast('success', `Workflow "${res.data.name}" created and saved!`);
      }
      await fetchWorkflows();
    } catch (e) {
      toast('error', 'Failed to save workflow: ' + (e.response?.data?.error || e.message));
    }
  };

  const createWorkflow = async () => {
    try {
      const res = await api.post('/workflow', { name: 'New Automation Workflow', description: '' });
      setActiveWorkflow(res.data);
      toast('success', 'Workflow created');
      await fetchWorkflows();
      loadWorkflow(res.data);
    } catch (e) {
      toast('error', 'Failed to create workflow');
    }
  };

  const executeWorkflow = async () => {
    await saveWorkflow();
    setRunning(true);
    try {
      // Mark initial running state
      setNodes(nds => nds.map(n => ({ ...n, data: { ...n.data, executionStatus: 'running' } })));
      const res = await api.post(`/workflow/${activeWorkflow.id}/execute`, {});

      // Map node results back onto canvas nodes
      if (res.data.nodeResults) {
        setNodes(nds => nds.map(n => {
          const resObj = res.data.nodeResults[n.id];
          if (resObj) {
            return {
              ...n,
              data: {
                ...n.data,
                executionStatus: resObj.status,
                executionDuration: resObj.durationMs,
                executionError: resObj.error
              }
            };
          }
          return n;
        }));
      }

      if (res.data.status === 'failed') {
        const failedNodeEntry = Object.entries(res.data.nodeResults || {}).find(([_, r]) => r.status === 'failed');
        const nodeName = nodes.find(n => n.id === failedNodeEntry?.[0])?.data?.label || failedNodeEntry?.[0] || 'Node';
        toast('error', `Execution failed at step "${nodeName}": ${failedNodeEntry?.[1]?.error || 'Check Logs'}`);
      } else if (res.data.status === 'waiting_approval') {
        toast('success', `Execution paused for approval: ${res.data.id}. A SuperAdmin must approve it in Execution Logs.`);
      } else {
        toast('success', `Execution ${res.data.status}: ${res.data.id}`);
      }

      setSelectedExecution(res.data);
      fetchExecutions();
    } catch (e) {
      toast('error', 'Execution failed: ' + (e.response?.data?.error || e.message));
    } finally {
      setRunning(false);
    }
  };

  // ─── Single-Node Live Tester ───────────────────────
  const testCurrentNode = async () => {
    if (!selectedNode) return;
    setTestingNode(true);
    setNodeTestResult(null);
    setShowTestModal(true);

    try {
      let vars = {};
      varList.forEach(item => {
        if (item.key.trim()) vars[item.key.trim()] = item.value;
      });

      const res = await api.post('/workflow/test-node', {
        node: {
          id: selectedNode.id,
          type: selectedNode.data.nodeType,
          data: selectedNode.data
        },
        sampleContext: vars
      });
      setNodeTestResult(res.data);
    } catch (e) {
      setNodeTestResult({
        success: false,
        error: e.response?.data?.error || e.message,
        durationMs: 0
      });
    } finally {
      setTestingNode(false);
    }
  };

  // ─── AI Workflow Copilot ───────────────────────────
  const handleAiGenerate = async () => {
    if (!aiPrompt.trim()) {
      toast('error', 'Please enter your prompt for AI generation');
      return;
    }
    setAiGenerating(true);
    try {
      const res = await api.post('/workflow/ai-generate', { prompt: aiPrompt });
      if (res.data.workflow) {
        const wfData = res.data.workflow;
        setWorkflowName(wfData.name || workflowName);
        setWorkflowDesc(wfData.description || workflowDesc);
        if (wfData.variables) {
          const parsed = Object.entries(wfData.variables).map(([k, v]) => ({ key: k, value: String(v) }));
          setVarList(parsed.length > 0 ? parsed : [{ key: '', value: '' }]);
        }
        let mappedNodes = [];
        if (wfData.nodes && Array.isArray(wfData.nodes)) {
          mappedNodes = wfData.nodes
            .filter(n => n.type !== 'start' && n.type !== 'end')
            .map(n => ({
              ...n,
              type: 'workflowNode',
              data: {
                ...n.data,
                nodeType: n.type,
                color: NODE_TYPES[n.type]?.color || 'var(--text-muted)',
                icon: NODE_TYPES[n.type]?.icon || '⬜',
                label: n.data?.label || NODE_TYPES[n.type]?.label || n.type
              }
            }));
        }
        const mappedEdges = (wfData.edges || []).filter(e => {
          const srcNode = wfData.nodes?.find(n => n.id === e.source);
          const tgtNode = wfData.nodes?.find(n => n.id === e.target);
          return srcNode?.type !== 'start' && srcNode?.type !== 'end' && tgtNode?.type !== 'start' && tgtNode?.type !== 'end';
        });

        setNodes(mappedNodes);
        setEdges(mappedEdges);
        setShowAiCopilot(false);
        setAiPrompt('');
        toast('success', `✨ AI Generated "${wfData.name}" with ${mappedNodes.length} nodes!`);
        
        // Pass mapped nodes and edges directly into autoLayout
        setTimeout(() => autoLayout('TB', mappedNodes, mappedEdges), 60);
      }
    } catch (e) {
      const errMsg = e.response?.data?.error || e.message;
      toast('error', `AI Generation failed: ${errMsg}`);
    } finally {
      setAiGenerating(false);
    }
  };

  const handleAiAudit = async () => {
    setAiGenerating(true);
    try {
      const res = await api.post('/workflow/ai-audit', {
        workflow: {
          name: workflowName,
          nodes,
          edges,
          variables: varList
        }
      });
      setAiAuditResult(res.data.audit);
      toast('success', 'AI Workflow Audit completed');
    } catch (e) {
      const errMsg = e.response?.data?.error || e.message;
      toast('error', `AI Audit failed: ${errMsg}`);
    } finally {
      setAiGenerating(false);
    }
  };

  const rerun = async (execId) => {
    await api.post(`/workflow/executions/${execId}/rerun`);
    toast('success', 'Rerun started');
    fetchExecutions();
  };

  const decideApproval = async (execId, approved) => {
    const comment = window.prompt(approved ? 'Approve this execution? Optional comment:' : 'Reject this execution? Optional reason:', '');
    if (comment === null) return;
    try {
      const res = await api.post(`/workflow/executions/${execId}/${approved ? 'approve' : 'reject'}`, { comment });
      toast(res.data.status === 'failed' ? 'error' : 'success', `Execution ${execId}: ${statusMeta(res.data.status).badge}`);
      setSelectedExecution(res.data);
      fetchExecutions();
    } catch (e) {
      toast('error', `Failed to ${approved ? 'approve' : 'reject'}: ` + (e.response?.data?.error || e.message));
    }
  };

  const renderApprovalPanel = (exec) => {
    if (exec?.status !== 'waiting_approval') return null;
    return (
      <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(236,72,153,0.1)', border: '1px solid rgba(236,72,153,0.35)', borderRadius: 6, fontSize: 11 }}>
        <div style={{ fontWeight: 800, color: '#ec4899', marginBottom: 4 }}>👤 Waiting for SuperAdmin approval</div>
        {exec.approval?.message && <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{exec.approval.message}</div>}
        {role === 'SuperAdmin' ? (
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="btn-action-pill" style={{ padding: '3px 10px', fontSize: 11, background: '#10b981', color: '#fff', border: 'none' }} onClick={(e) => { e.stopPropagation(); decideApproval(exec.id, true); }}>✅ Approve</button>
            <button className="btn-action-pill" style={{ padding: '3px 10px', fontSize: 11, background: '#ef4444', color: '#fff', border: 'none' }} onClick={(e) => { e.stopPropagation(); decideApproval(exec.id, false); }}>⛔ Reject</button>
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>Only a SuperAdmin can approve or reject.</div>
        )}
      </div>
    );
  };

  const fetchTemplates = async () => {
    try {
      const res = await api.get('/workflow/templates');
      setTemplates(res.data);
    } catch (e) {
      toast('error', 'Failed to fetch templates');
    }
  };

  const createFromTemplate = async (templateId) => {
    try {
      const res = await api.post('/workflow/templates/create-workflow', { templateId });
      toast('success', `Created workflow "${res.data.name}"`);
      setShowTemplatesModal(false);
      await fetchWorkflows();
      loadWorkflow(res.data);
    } catch (e) {
      toast('error', 'Failed to create from template: ' + (e.response?.data?.error || e.message));
    }
  };

  const saveAsTemplate = async () => {
    if (!activeWorkflow) return;
    if (!saveAsTemplateName.trim()) {
      toast('error', 'Please enter a template name');
      return;
    }
    let vars = {};
    varList.forEach(item => {
      if (item.key.trim()) {
        let parsedVal = item.value;
        try {
          if ((item.value.startsWith('{') && item.value.endsWith('}')) || (item.value.startsWith('[') && item.value.endsWith(']'))) {
            parsedVal = JSON.parse(item.value);
          }
        } catch {}
        vars[item.key.trim()] = parsedVal;
      }
    });

    try {
      await api.post('/workflow/templates', {
        name: saveAsTemplateName,
        description: saveAsTemplateDesc,
        variables: vars,
        nodes: nodes.map(n => ({ id: n.id, type: n.data.nodeType, position: n.position, data: n.data })),
        edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle }))
      });
      toast('success', 'Saved as template successfully');
      setSaveAsTemplateName('');
      setSaveAsTemplateDesc('');
      fetchTemplates();
    } catch (e) {
      toast('error', 'Failed to save template: ' + (e.response?.data?.error || e.message));
    }
  };

  const deleteTemplate = async (id) => {
    if (role !== 'SuperAdmin') return;
    try {
      await api.delete(`/workflow/templates/${id}`);
      toast('success', 'Template deleted');
      fetchTemplates();
    } catch (e) {
      toast('error', 'Failed to delete template');
    }
  };

  const fetchVersions = async () => {
    if (!activeWorkflow) return;
    try {
      const res = await api.get(`/workflow/${activeWorkflow.id}/history`);
      setWorkflowHistory(res.data);
      setShowVersionsModal(true);
    } catch (e) {
      toast('error', 'Failed to fetch version history');
    }
  };

  const compareWithVersion = (versionData) => {
    setDiffBase(versionData);
    setDiffMode(true);
    setShowVersionsModal(false);
  };
  
  const exitDiffMode = () => {
    setDiffMode(false);
    setDiffBase(null);
  };

  const displayNodes = useMemo(() => {
    if (!diffMode || !diffBase) return nodes;
    const currentIds = new Set(nodes.map(n => n.id));
    const baseIds = new Set(diffBase.nodes.map(n => n.id));
    
    const combined = [...nodes];
    diffBase.nodes.forEach(bn => {
      if (!currentIds.has(bn.id)) {
        combined.push({
          ...bn,
          type: 'workflowNode',
          data: { ...bn.data, nodeType: bn.type, diffStatus: 'deleted', color: NODE_TYPES[bn.type]?.color || 'var(--text-muted)', icon: NODE_TYPES[bn.type]?.icon || '⬜', label: bn.data?.label || NODE_TYPES[bn.type]?.label || bn.type }
        });
      }
    });
    
    return combined.map(n => {
      if (!n.data.diffStatus) {
        if (!baseIds.has(n.id)) {
          return { ...n, data: { ...n.data, diffStatus: 'added' } };
        } else {
          const bn = diffBase.nodes.find(x => x.id === n.id);
          const changed = JSON.stringify(n.data) !== JSON.stringify(bn.data);
          if (changed) {
            return { ...n, data: { ...n.data, diffStatus: 'modified' } };
          }
        }
      }
      return n;
    });
  }, [nodes, diffMode, diffBase]);

  const displayEdges = useMemo(() => {
     if (!diffMode || !diffBase) return edges;
     const currentIds = new Set(edges.map(e => e.id));
     const baseIds = new Set(diffBase.edges.map(e => e.id));
     
     const combined = [...edges];
     diffBase.edges.forEach(be => {
       if (!currentIds.has(be.id)) combined.push({ ...be, animated: true, style: { stroke: '#ef4444', strokeWidth: 2, strokeDasharray: '5,5' } });
     });
     
     return combined.map(e => {
       if (!baseIds.has(e.id)) return { ...e, style: { stroke: '#10b981', strokeWidth: 2 } };
       return e;
     });
  }, [edges, diffMode, diffBase]);

  const filteredNodeTypes = Object.values(NODE_TYPES).filter(n =>
    n.label.toLowerCase().includes(quickAddSearch.toLowerCase()) ||
    n.type.toLowerCase().includes(quickAddSearch.toLowerCase()) ||
    n.desc.toLowerCase().includes(quickAddSearch.toLowerCase())
  );

  return (
    <>
    <style>{rfStyles}</style>
    <div style={{ height: '100%', display: 'flex', gap: 0, position: 'relative', overflow: 'hidden' }}>
      
      {/* Left Node Palette */}
      <div style={{ width: 220, background: 'var(--bg-secondary)', borderRight: '1px solid var(--border-color)', padding: 14, overflowY: 'auto', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontWeight: 900, fontSize: 12, color: 'var(--accent-primary)', textTransform: 'uppercase', letterSpacing: 1.2 }}>Component Palette</div>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Drag or Double-Click</span>
        </div>

        {['execution', 'logic', 'control'].map(cat => (
          <div key={cat} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.8 }}>
              {cat === 'execution' ? '⚡ Execution' : cat === 'logic' ? '🔀 Logic & Flow' : '🛡️ Control & Pauses'}
            </div>
            {Object.values(NODE_TYPES).filter(n => n.category === cat).map(def => (
              <div key={def.type} draggable
                onDragStart={e => e.dataTransfer.setData('application/reactflow', def.type)}
                onClick={() => addNodeByType(def.type)}
                style={{
                  padding: '8px 10px',
                  marginBottom: 6,
                  borderRadius: 10,
                  cursor: 'grab',
                  fontSize: 12,
                  fontWeight: 600,
                  background: `${def.color}15`,
                  border: `1px solid ${def.color}35`,
                  color: 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  transition: 'all 0.2s'
                }}
                className="wf-node-palette-item"
              >
                <span style={{ fontSize: 14 }}>{def.icon}</span>
                <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <div>{def.label}</div>
                  <div style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400 }}>{def.desc}</div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Center Canvas Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        
        {/* Top Floating Command Bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          borderBottom: '1px solid var(--border-color)',
          background: 'var(--bg-secondary)',
          flexWrap: 'wrap',
          gap: 8,
          zIndex: 10
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select
              value={activeWorkflow?.id || ''}
              onChange={e => loadWorkflow(workflows.find(w => w.id === e.target.value))}
              style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                padding: '6px 10px',
                fontSize: 13,
                fontWeight: 700,
                color: 'var(--text-primary)',
                minWidth: 160
              }}
            >
              <option value="">Select Workflow</option>
              {workflows.map(w => <option key={w.id} value={w.id}>{w.name} (v{w.version})</option>)}
            </select>
            <input
              value={workflowName}
              onChange={e => setWorkflowName(e.target.value)}
              placeholder="Workflow Name"
              style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                padding: '6px 10px',
                fontSize: 13,
                color: 'var(--text-primary)',
                width: 220,
                fontWeight: 600
              }}
            />
          </div>

          {/* Action Button Strip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn-action-pill" style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none' }} onClick={saveWorkflow} title="Save Workflow (Ctrl+S)">
              💾 Save
            </button>
            <button className="btn-action-pill" onClick={createWorkflow}>
              ➕ New
            </button>
            <button
              className="btn-action-pill"
              style={{ background: running ? '#f59e0b' : 'rgba(16,185,129,0.15)', color: running ? '#fff' : '#34d399', borderColor: '#10b981' }}
              onClick={executeWorkflow}
              disabled={running}
            >
              ▶ {running ? 'Running...' : 'Execute'}
            </button>
            
            {/* Auto-Layout Controls */}
            <button className="btn-action-pill" onClick={() => autoLayout('TB')} title="Auto Layout Vertical (Ctrl+Shift+A)">
              📐 Align Vertical
            </button>
            <button className="btn-action-pill" onClick={() => autoLayout('LR')} title="Auto Layout Horizontal">
              ↔️ Align Horizontal
            </button>

            {/* AI Copilot Button */}
            <button
              className="btn-action-pill"
              style={{ background: 'linear-gradient(135deg, rgba(139,92,246,0.25), rgba(59,130,246,0.25))', borderColor: 'var(--accent-primary)', color: '#c084fc' }}
              onClick={() => setShowAiCopilot(true)}
            >
              ✨ AI Copilot
            </button>

            <button className="btn-action-pill" onClick={() => setShowConfigPanel(!showConfigPanel)}>
              ⚙️ Variables
            </button>
            <button className="btn-action-pill" onClick={() => { setShowTemplatesModal(true); fetchTemplates(); }}>
              📦 Templates
            </button>
            <button className="btn-action-pill" onClick={fetchVersions}>
              ⏳ History
            </button>
            <button className="btn-action-pill" onClick={() => setShowHistory(!showHistory)}>
              📋 Logs
            </button>
            {activeWorkflow && role !== 'Viewer' && (
              <button
                className="btn-action-pill"
                style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444', borderColor: '#ef4444' }}
                onClick={() => setShowDeleteWorkflowConfirm(true)}
                title="Delete this workflow"
              >
                🗑️ Delete WF
              </button>
            )}

            {nodes.filter(n => n.selected).length > 1 && (
              <button className="btn-action-pill" style={{ background: 'rgba(239,68,68,0.2)', color: '#f87171', borderColor: '#ef4444' }} onClick={deleteSelectedNodes}>
                🗑️ Delete ({nodes.filter(n => n.selected).length})
              </button>
            )}
          </div>
        </div>

        {/* Global Variables & Settings Drawer */}
        {showConfigPanel && (
          <div style={{ display: 'flex', gap: 20, padding: '16px 20px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
            <div style={{ flex: 1.2 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 700, textTransform: 'uppercase' }}>Workflow Description</div>
              <textarea
                value={workflowDesc}
                onChange={e => setWorkflowDesc(e.target.value)}
                placeholder="Describe what this automation pipeline does..."
                style={{ width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: 'var(--text-primary)', minHeight: 75, resize: 'vertical' }}
              />
            </div>
            <div style={{ flex: 1.8, display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 700, textTransform: 'uppercase' }}>Global Context Variables</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 110, overflowY: 'auto', paddingRight: 4 }}>
                {varList.map((item, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input 
                      style={{ flex: 1, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '6px 10px', fontSize: 12, color: 'var(--text-primary)', fontFamily: 'monospace' }}
                      placeholder="Variable Key (e.g. TARGET_HOST)"
                      value={item.key} 
                      onChange={e => {
                        const newList = [...varList];
                        newList[idx].key = e.target.value;
                        setVarList(newList);
                      }} 
                    />
                    <span style={{ color: 'var(--text-muted)', fontWeight: 800 }}>=</span>
                    <input 
                      style={{ flex: 1.5, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '6px 10px', fontSize: 12, color: 'var(--text-primary)' }}
                      placeholder="Value (e.g. 192.168.1.10 or JSON)"
                      value={item.value} 
                      onChange={e => {
                        const newList = [...varList];
                        newList[idx].value = e.target.value;
                        setVarList(newList);
                      }} 
                    />
                    <button 
                      onClick={() => {
                        const newList = varList.filter((_, i) => i !== idx);
                        setVarList(newList.length > 0 ? newList : [{ key: '', value: '' }]);
                      }}
                      style={{ background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}
                      title="Remove"
                    >
                      🗑️
                    </button>
                  </div>
                ))}
              </div>
              <button 
                className="btn-action-pill" 
                onClick={() => setVarList([...varList, { key: '', value: '' }])}
                style={{ alignSelf: 'flex-start', marginTop: 8, padding: '4px 12px', fontSize: 11 }}
              >
                ➕ Add Variable
              </button>
            </div>
          </div>
        )}

        {/* Diff View Banner */}
        {diffMode && (
          <div style={{ background: 'rgba(245,158,11,0.15)', borderBottom: '1px solid #f59e0b', padding: '8px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, fontWeight: 800, color: '#f59e0b' }}>🔍 VERSION COMPARISON: Comparing with Version {diffBase?.version}</span>
            <button className="btn-action-pill" style={{ background: '#f59e0b', color: '#000', border: 'none' }} onClick={exitDiffMode}>Exit Diff View</button>
          </div>
        )}

        {/* ReactFlow Canvas */}
        <div style={{ flex: 1, display: 'flex', position: 'relative' }}>
          <div ref={reactFlowWrapper} style={{ flex: 1, position: 'relative' }} onDrop={onDrop} onDragOver={onDragOver} onDoubleClick={onPaneDoubleClick}>
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={onNodeClick}
              nodeTypes={nodeTypes}
              fitView
              attributionPosition="bottom-left"
              selectionOnDrag={true}
              panOnDrag={[1, 2]}
              selectionMode="partial"
            >
              <Controls />
              <Background gap={18} size={1} />
              <MiniMap
                pannable={true}
                zoomable={true}
                nodeColor={n => n.data?.color || 'var(--accent-primary)'}
                maskColor="rgba(0, 0, 0, 0.45)"
                nodeStrokeWidth={3}
                nodeBorderRadius={6}
                onClick={(_, position) => {
                  if (position && typeof position.x === 'number' && typeof position.y === 'number') {
                    setCenter(position.x, position.y, { zoom: getZoom() || 1, duration: 400 });
                  }
                }}
                onNodeClick={(_, node) => {
                  if (node && node.position) {
                    setCenter(node.position.x + 100, node.position.y + 40, { zoom: 1.1, duration: 400 });
                    setSelectedNode(node);
                  }
                }}
                style={{ cursor: 'pointer', height: 120, width: 170 }}
              />
              
              {/* Floating Canvas Tips */}
              <Panel position="bottom-center">
                <div style={{
                  background: 'rgba(0,0,0,0.6)',
                  backdropFilter: 'blur(8px)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 20,
                  padding: '4px 14px',
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  display: 'flex',
                  gap: 12
                }}>
                  <span>💡 <b>Double-Click</b> or <b>Drag</b> to add node</span>
                  <span>⌨️ <b>Ctrl+S</b> Save</span>
                  <span>⌨️ <b>Ctrl+D</b> Duplicate</span>
                  <span>⌨️ <b>Ctrl+Shift+A</b> Align</span>
                </div>
              </Panel>
            </ReactFlow>
          </div>

          {/* Right Node Configuration Drawer */}
          {selectedNode && (
            <div style={{ 
              position: 'absolute', top: 0, right: 0, bottom: 0, width: 360, 
              background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border-color)', 
              padding: 20, overflowY: 'auto', zIndex: 100, backdropFilter: 'blur(16px)',
              boxShadow: '-12px 0 32px rgba(0,0,0,0.3)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid var(--border-color)', paddingBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>{NODE_TYPES[selectedNode.data.nodeType]?.icon}</span>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 14 }}>{selectedNode.data.label || NODE_TYPES[selectedNode.data.nodeType]?.label}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>ID: {selectedNode.id}</div>
                  </div>
                </div>
                <button onClick={() => setSelectedNode(null)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
              </div>

              {/* Node Label */}
              <Label>Node Label</Label>
              <Input value={selectedNode.data.label} onChange={v => updateNodeData('label', v)} placeholder="e.g. Health Check Step" />

              {/* Specific Field Editors with Inventory Linkage */}
              {(selectedNode.data.nodeType === 'ssh' || selectedNode.data.nodeType === 'powershell') && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                    <Label>Target Host / IP *</Label>
                    {inventoryList.length > 0 && (
                      <span style={{ fontSize: 10, color: 'var(--accent-primary)', cursor: 'pointer' }}>
                        🖥️ Select from Inventory
                      </span>
                    )}
                  </div>
                  
                  {/* Host with Inventory Dropdown */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Input value={selectedNode.data.host} onChange={v => updateNodeData('host', v)} placeholder="192.168.1.10 or {{HOST}}" />
                    {inventoryList.length > 0 && (
                      <select
                        style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 11, maxWidth: 100 }}
                        onChange={e => { if (e.target.value) updateNodeData('host', e.target.value); }}
                        value=""
                      >
                        <option value="">Quick Pick</option>
                        {inventoryList.map(item => (
                          <option key={item.id || item.ip} value={item.ip}>
                            {item.hostname ? `${item.hostname} (${item.ip})` : item.ip}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>

                  <Label>Command / Script *</Label>
                  <Textarea
                    value={selectedNode.data.command}
                    onChange={v => updateNodeData('command', v)}
                    placeholder={selectedNode.data.nodeType === 'ssh' ? "uptime && df -h" : "Get-Service | Where-Object Status -eq 'Stopped'"}
                    style={{ minHeight: 80, color: '#38bdf8' }}
                  />

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <Label>{selectedNode.data.nodeType === 'ssh' ? 'Username (Linux)' : 'Username (Windows / AD)'}</Label>
                      <Input
                        value={selectedNode.data.username}
                        onChange={v => updateNodeData('username', v)}
                        placeholder={selectedNode.data.nodeType === 'ssh' ? "Default: LINUX_ADMIN_USER" : "Default: AD_ADMIN_USER"}
                      />
                    </div>
                    <div>
                      <Label>Timeout (s)</Label>
                      <Input value={selectedNode.data.timeout} onChange={v => updateNodeData('timeout', v)} placeholder="30" />
                    </div>
                  </div>

                  {selectedNode.data.nodeType === 'ssh' && (
                    <>
                      <Label>Auth Method</Label>
                      <select
                        value={selectedNode.data.authMethod || 'password'}
                        onChange={e => updateNodeData('authMethod', e.target.value)}
                        style={{ width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: 'var(--text-primary)' }}
                      >
                        <option value="password">Password (LINUX_ADMIN_PWD)</option>
                        <option value="key">SSH Private Key</option>
                      </select>
                    </>
                  )}

                  <Label>{selectedNode.data.nodeType === 'ssh' ? 'Password (LINUX_ADMIN_PWD)' : 'Password (AD_ADMIN_PWD)'}</Label>
                  <Input
                    value={selectedNode.data.password}
                    onChange={v => updateNodeData('password', v)}
                    placeholder={selectedNode.data.nodeType === 'ssh' ? "Default: LINUX_ADMIN_PWD from settings" : "Default: AD_ADMIN_PWD from settings"}
                    type="password"
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    💡 <b>System Default:</b> Left empty to automatically use{' '}
                    <code style={{ color: 'var(--accent-primary)' }}>
                      {selectedNode.data.nodeType === 'ssh' ? 'LINUX_ADMIN_USER & LINUX_ADMIN_PWD' : 'AD_ADMIN_USER & AD_ADMIN_PWD'}
                    </code>{' '}
                    configured in System Settings.
                  </div>
                </>
              )}

              {selectedNode.data.nodeType === 'http' && (
                <>
                  <Label>Integration Preset (Webhook &amp; Integration Hub)</Label>
                  <select
                    value={selectedNode.data.integrationId || ''}
                    onChange={e => {
                      const val = e.target.value;
                      if (val === '__telegram__') {
                        updateNodeData('integrationId', '__telegram__');
                        updateNodeData('integrationType', 'telegram');
                        if (!selectedNode.data.label || selectedNode.data.label === 'HTTP Request') {
                          updateNodeData('label', 'Telegram Alert');
                        }
                      } else if (val && val !== '__custom__') {
                        const matched = systemWebhooks.find(w => w.id === val);
                        updateNodeData('integrationId', val);
                        updateNodeData('integrationType', 'webhook');
                        if (matched) {
                          updateNodeData('url', matched.url);
                          updateNodeData('method', matched.method || 'POST');
                          if (matched.headers) {
                            updateNodeData('headers', typeof matched.headers === 'object' ? JSON.stringify(matched.headers, null, 2) : matched.headers);
                          }
                          if (matched.bodyTemplate) {
                            updateNodeData('body', matched.bodyTemplate);
                          }
                          if (!selectedNode.data.label || selectedNode.data.label === 'HTTP Request') {
                            updateNodeData('label', matched.name);
                          }
                        }
                      } else {
                        updateNodeData('integrationId', '');
                        updateNodeData('integrationType', 'custom');
                      }
                    }}
                    style={{ width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '7px 10px', fontSize: 12, color: 'var(--text-primary)', fontWeight: 700 }}
                  >
                    <option value="">-- Custom HTTP Request / Webhook --</option>
                    <option value="__telegram__">📱 System Telegram Alert Bot (Global Telegram)</option>
                    {systemWebhooks.length > 0 && (
                      <optgroup label="🔌 Configured Webhooks (Integration Hub)">
                        {systemWebhooks.map(wh => (
                          <option key={wh.id} value={wh.id}>
                            🔌 {wh.name} ({wh.method} {wh.url.slice(0, 35)}...)
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>

                  {selectedNode.data.integrationId === '__telegram__' ? (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ padding: '8px 12px', background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.3)', borderRadius: 6, fontSize: 11, color: '#38bdf8', lineHeight: 1.5 }}>
                        📱 <b>System Telegram Preset:</b> Uses the global Bot Token, Chat ID, and Proxy configured in <b>System Settings &gt; Network / Integration Hub</b>.
                      </div>
                      <Label>Alert Message Content *</Label>
                      <Textarea
                        value={selectedNode.data.message || selectedNode.data.body || ''}
                        onChange={v => {
                          updateNodeData('message', v);
                          updateNodeData('body', v);
                        }}
                        placeholder="🚨 [Workflow Alert] Host {{TARGET_HOST}} is offline! Execution ID: {{EXECUTION_ID}}"
                        style={{ minHeight: 80 }}
                      />
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        Variables supported: <code>{'{{EXECUTION_ID}}'}</code>, <code>{'{{TARGET_HOST}}'}</code>, <code>{'{{STATUS}}'}</code>
                      </div>
                    </div>
                  ) : (
                    <>
                      {selectedNode.data.integrationId && selectedNode.data.integrationId !== '__custom__' && (
                        <div style={{ marginTop: 8, padding: '6px 10px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 6, fontSize: 11, color: '#34d399' }}>
                          ✅ Linked to Integration Hub Webhook. Parameters below have been pre-filled.
                        </div>
                      )}

                      <Label>URL Endpoint *</Label>
                      <Input value={selectedNode.data.url} onChange={v => updateNodeData('url', v)} placeholder="https://api.example.com/health or webhook URL" />
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <div>
                          <Label>HTTP Method</Label>
                          <select
                            value={selectedNode.data.method || 'POST'}
                            onChange={e => updateNodeData('method', e.target.value)}
                            style={{ width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: 'var(--text-primary)' }}
                          >
                            {['POST','GET','PUT','DELETE','PATCH'].map(m => <option key={m} value={m}>{m}</option>)}
                          </select>
                        </div>
                        <div>
                          <Label>Timeout (s)</Label>
                          <Input value={selectedNode.data.timeout} onChange={v => updateNodeData('timeout', v)} placeholder="30" />
                        </div>
                      </div>
                      <Label>Headers (JSON)</Label>
                      <Textarea value={selectedNode.data.headers} onChange={v => updateNodeData('headers', v)} placeholder='{"Content-Type": "application/json"}' />
                      <Label>Request Body (JSON / Template)</Label>
                      <Textarea value={selectedNode.data.body} onChange={v => updateNodeData('body', v)} placeholder='{"text": "{{message}}"}' />
                    </>
                  )}
                </>
              )}

              {selectedNode.data.nodeType === 'condition' && (
                <>
                  <Label>Condition Expression *</Label>
                  <Textarea
                    value={selectedNode.data.expression}
                    onChange={v => updateNodeData('expression', v)}
                    placeholder="parseInt(ctx.node_1.stdout) > 85"
                    style={{ color: '#fb923c', minHeight: 70 }}
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                    Read previous outputs via <code>ctx.&lt;nodeId&gt;</code>, e.g. <code>ctx.http_step.status === 200</code>.<br />
                    Allowed: comparisons, <code>&amp;&amp; || !</code>, arithmetic, <code>a ? b : c</code>,
                    <code> parseInt parseFloat Number String Boolean isNaN Math.max/min/round/floor/ceil/abs</code>,
                    string <code>.includes .startsWith .endsWith .trim .toLowerCase .split …</code>, array <code>.includes .join .length</code>.
                    Errors (typos, missing data) fail the node instead of taking the FALSE branch.
                  </div>
                </>
              )}

              {selectedNode.data.nodeType === 'approval' && (
                <>
                  <Label>Approval Message</Label>
                  <Textarea
                    value={selectedNode.data.message}
                    onChange={v => updateNodeData('message', v)}
                    placeholder="Reboot {{TARGET_IP}} in production?"
                    style={{ minHeight: 60 }}
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                    The workflow pauses here and a Telegram notification is sent. Any SuperAdmin can approve or reject
                    it from Execution Logs. Supports <code>{'{{VAR}}'}</code>. There is no timeout.
                  </div>
                </>
              )}

              {selectedNode.data.nodeType === 'k8s' && (
                <>
                  <Label>Target Kubernetes Cluster (Control Plane) *</Label>
                  <select
                    value={selectedNode.data.cluster || ''}
                    onChange={e => updateNodeData('cluster', e.target.value)}
                    style={{ width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}
                  >
                    <option value="">-- Select Control Plane Cluster --</option>
                    {k8sClusters.map(c => (
                      <option key={c.id || c.name} value={c.id || c.name}>
                        ☸️ {c.name} ({c.environment || 'Default'})
                      </option>
                    ))}
                    <option value="__custom__">⚙️ Custom File Kubeconfig Path</option>
                  </select>

                  <Label>Kubectl Command *</Label>
                  <Textarea
                    value={selectedNode.data.command}
                    onChange={v => updateNodeData('command', v)}
                    placeholder="rollout restart deployment/web-app"
                    style={{ color: '#818cf8', minHeight: 70 }}
                  />

                  {/* Common Kubectl Snippets Helper */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                    {[
                      { label: 'Rollout Restart', cmd: 'rollout restart deployment/web-app' },
                      { label: 'Scale Replicas', cmd: 'scale deployment/web-app --replicas=3' },
                      { label: 'Get Pods', cmd: 'get pods -o wide' },
                      { label: 'Get Events', cmd: 'get events --sort-by=.metadata.creationTimestamp' }
                    ].map(snippet => (
                      <button
                        key={snippet.label}
                        type="button"
                        className="btn-action-pill"
                        style={{ fontSize: 10, padding: '2px 8px' }}
                        onClick={() => updateNodeData('command', snippet.cmd)}
                      >
                        + {snippet.label}
                      </button>
                    ))}
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                    <div>
                      <Label>Namespace</Label>
                      <Input value={selectedNode.data.namespace} onChange={v => updateNodeData('namespace', v)} placeholder="default or {{NAMESPACE}}" />
                    </div>
                    <div>
                      <Label>Timeout (s)</Label>
                      <Input value={selectedNode.data.timeout} onChange={v => updateNodeData('timeout', v)} placeholder="60" />
                    </div>
                  </div>

                  {(!selectedNode.data.cluster || selectedNode.data.cluster === '__custom__') && (
                    <>
                      <Label>Custom Kubeconfig Path (Optional)</Label>
                      <Input value={selectedNode.data.kubeconfig} onChange={v => updateNodeData('kubeconfig', v)} placeholder="/etc/kubernetes/admin.conf or C:\k8s\config" />
                    </>
                  )}
                </>
              )}

              {selectedNode.data.nodeType === 'nutanix' && (
                <>
                  <Label>Nutanix Action *</Label>
                  <select
                    value={selectedNode.data.action || 'GET_STATUS'}
                    onChange={e => updateNodeData('action', e.target.value)}
                    style={{ width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: 'var(--text-primary)', fontWeight: 600 }}
                  >
                    <option value="GET_STATUS">🔍 Query VM Status & Metadata (GET_STATUS)</option>
                    <option value="POWER_ON">⚡ Power On VM (POWER_ON)</option>
                    <option value="ACPI_SHUTDOWN">🛑 Graceful ACPI Shutdown (ACPI_SHUTDOWN)</option>
                    <option value="POWER_OFF">🔌 Force Power Off (POWER_OFF)</option>
                    <option value="RESET">🔄 Reboot / Reset VM (RESET)</option>
                  </select>

                  <Label>Target VM Name or UUID *</Label>
                  <Input
                    value={selectedNode.data.vmName}
                    onChange={v => updateNodeData('vmName', v)}
                    placeholder="e.g. prd-app-web01 or {{VM_NAME}}"
                  />

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <Label>Cluster / Prism IP (Optional)</Label>
                      <Input
                        value={selectedNode.data.cluster}
                        onChange={v => updateNodeData('cluster', v)}
                        placeholder="Default PC / PE IP"
                      />
                    </div>
                    <div>
                      <Label>Timeout (s)</Label>
                      <Input
                        value={selectedNode.data.timeout}
                        onChange={v => updateNodeData('timeout', v)}
                        placeholder="30"
                      />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <Label>Account (Optional)</Label>
                      <Input
                        value={selectedNode.data.username}
                        onChange={v => updateNodeData('username', v)}
                        placeholder="Default System User"
                      />
                    </div>
                    <div>
                      <Label>Password (Optional)</Label>
                      <Input
                        value={selectedNode.data.password}
                        onChange={v => updateNodeData('password', v)}
                        placeholder="enc:... or plaintext"
                        type="password"
                      />
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    Leave cluster credentials blank to use default settings from <b>System Settings &gt; Nutanix</b>.
                  </div>
                </>
              )}

              {selectedNode.data.nodeType === 'script' && (
                <>
                  <Label>JavaScript Code (Node.js Sandboxed) *</Label>
                  <Textarea
                    value={selectedNode.data.code}
                    onChange={v => updateNodeData('code', v)}
                    placeholder="return { totalCount: ctx.servers.length, timestamp: Date.now() };"
                    style={{ minHeight: 120, color: '#2dd4bf' }}
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Access <code>ctx</code> to read/write context. Return a value to store in node output
                    (<code>ctx.&lt;nodeId&gt;.result</code>). <code>await</code> is supported; <code>console.log</code> output appears as STDOUT.
                    Runs in an isolated process with a 5 s timeout: no <code>require</code>, file system, network modules or child processes.
                    Return values and <code>ctx</code> must be JSON data (Date becomes a string).
                  </div>
                </>
              )}

              {selectedNode.data.nodeType === 'sleep' && (
                <>
                  <Label>Delay Duration (Seconds) *</Label>
                  <Input value={selectedNode.data.seconds} onChange={v => updateNodeData('seconds', v)} placeholder="5" type="number" />
                </>
              )}

              {/* Retry Strategy Card */}
              <div style={{ marginTop: 14, padding: 10, background: 'var(--bg-primary)', borderRadius: 8, fontSize: 11, border: '1px solid var(--border-color)' }}>
                <div style={{ fontWeight: 800, marginBottom: 6, color: 'var(--text-muted)' }}>🔄 Retry Strategy</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <Label>Max Retries</Label>
                    <Input value={selectedNode.data.retry?.count ?? ''} onChange={v => updateNodeData('retry', { ...(selectedNode.data.retry || {}), count: parseInt(v) || 0 })} placeholder="0" />
                  </div>
                  <div>
                    <Label>Interval (s)</Label>
                    <Input value={selectedNode.data.retry?.delay ?? ''} onChange={v => updateNodeData('retry', { ...(selectedNode.data.retry || {}), delay: parseInt(v) || 1 })} placeholder="1" />
                  </div>
                </div>
              </div>

              {/* Action Buttons: Live Test & Delete */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
                <button
                  className="btn-action-pill"
                  style={{ width: '100%', justifyContent: 'center', background: 'linear-gradient(135deg, #0ea5e9, #3b82f6)', color: '#fff', border: 'none', padding: '10px' }}
                  onClick={testCurrentNode}
                >
                  ⚡ Test This Node (Dry Run)
                </button>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn-action-pill"
                    style={{ flex: 1, justifyContent: 'center' }}
                    onClick={duplicateSelectedNode}
                  >
                    📋 Duplicate
                  </button>
                  <button
                    className="btn-action-pill"
                    style={{ flex: 1, justifyContent: 'center', background: 'rgba(239,68,68,0.15)', color: '#ef4444', borderColor: '#ef4444' }}
                    onClick={deleteNode}
                  >
                    🗑️ Delete
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Execution Logs Drawer */}
      {showHistory && (
        <div style={{ width: 360, background: 'var(--bg-secondary)', borderLeft: '1px solid var(--border-color)', overflowY: 'auto', flexShrink: 0, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 10, borderBottom: '1px solid var(--border-color)', marginBottom: 12 }}>
            <div style={{ fontWeight: 800, fontSize: 13 }}>📋 Execution History</div>
            <button onClick={() => setShowHistory(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>✕</button>
          </div>
          {executions.map(exec => (
            <div key={exec.id} style={{ padding: '10px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, marginBottom: 8, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{
                  background: statusMeta(exec.status).bg,
                  color: statusMeta(exec.status).color,
                  padding: '2px 8px', borderRadius: 4, fontWeight: 800, fontSize: 11
                }}>{statusMeta(exec.status).badge}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{new Date(exec.startedAt).toLocaleTimeString()}</span>
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>
                by {exec.triggerUser} · {exec.id?.slice(0, 10)}
              </div>
              {exec.status === 'failed' && (
                <div style={{ marginTop: 6, padding: '4px 8px', background: 'rgba(239,68,68,0.1)', borderRadius: 4, color: 'var(--danger)', fontSize: 11 }}>
                  {Object.entries(exec.nodeResults || {}).filter(([, r]) => r.status === 'failed').map(([nid, r]) => (
                    <div key={nid}>⚠ {nid}: {r.error}</div>
                  ))}
                </div>
              )}
              {renderApprovalPanel(exec)}
              <button className="btn-action-pill" style={{ marginTop: 8, padding: '3px 8px', fontSize: 10 }} onClick={() => rerun(exec.id)}>🔄 Rerun</button>
            </div>
          ))}
          {executions.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No execution runs recorded yet.</div>}
        </div>
      )}
    </div>

    {/* ─── Quick-Add Palette Modal (Double-Click / Space) ───── */}
    {showQuickAdd && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99999 }} onClick={() => setShowQuickAdd(false)}>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 16, width: 440, padding: 20, boxShadow: '0 20px 50px rgba(0,0,0,0.4)' }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h4 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>➕ Add Workflow Node</h4>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Esc to close</span>
          </div>
          <input
            autoFocus
            value={quickAddSearch}
            onChange={e => setQuickAddSearch(e.target.value)}
            placeholder="Search nodes (e.g. ssh, http, condition)..."
            style={{ width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--accent-primary)', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: 'var(--text-primary)', marginBottom: 12 }}
          />
          <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filteredNodeTypes.map(def => (
              <div
                key={def.type}
                onClick={() => addNodeByType(def.type)}
                style={{
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border-color)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  transition: 'all 0.15s'
                }}
                onMouseEnter={e => e.currentTarget.style.borderColor = def.color}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}
              >
                <span style={{ fontSize: 18 }}>{def.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{def.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{def.desc}</div>
                </div>
                <span style={{ fontSize: 10, color: def.color, fontWeight: 800 }}>{def.category}</span>
              </div>
            ))}
            {filteredNodeTypes.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16 }}>No matching node types found.</div>
            )}
          </div>
        </div>
      </div>
    )}

    {/* ─── Single-Node Live Tester Modal ───────────────────── */}
    {showTestModal && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99999 }} onClick={() => setShowTestModal(false)}>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 16, width: 620, padding: 24, boxShadow: '0 24px 60px rgba(0,0,0,0.5)' }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 12, marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>⚡ Single-Node Dry Run Terminal</h3>
            <button onClick={() => setShowTestModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18 }}>✕</button>
          </div>

          <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text-muted)' }}>
            Testing Node: <b>{selectedNode?.data?.label || selectedNode?.data?.nodeType}</b> ({selectedNode?.data?.nodeType})
          </div>

          {testingNode ? (
            <div style={{ padding: 36, textAlign: 'center' }}>
              <div style={{ fontSize: 24, marginBottom: 10 }}>⏳</div>
              <div style={{ fontWeight: 700 }}>Executing step against target...</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Resolving context variables and establishing connection</div>
            </div>
          ) : nodeTestResult ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{
                  padding: '3px 10px',
                  borderRadius: 6,
                  fontWeight: 800,
                  fontSize: 12,
                  background: nodeTestResult.success ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                  color: nodeTestResult.success ? '#10b981' : '#ef4444'
                }}>
                  {nodeTestResult.success ? '✅ SUCCESS' : '❌ FAILED'}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                  ⏱️ {nodeTestResult.durationMs}ms
                </span>
              </div>

              {/* Terminal Output */}
              <div style={{
                background: '#090d16',
                border: '1px solid #1e293b',
                borderRadius: 10,
                padding: 14,
                fontFamily: 'monospace',
                fontSize: 12,
                maxHeight: 280,
                overflowY: 'auto',
                color: '#e2e8f0',
                lineHeight: 1.5
              }}>
                {nodeTestResult.output?.stdout && (
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ color: '#10b981', fontWeight: 700 }}>[STDOUT]:</span>
                    <pre style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap' }}>{nodeTestResult.output.stdout}</pre>
                  </div>
                )}
                {nodeTestResult.output?.stderr && (
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ color: '#f59e0b', fontWeight: 700 }}>[STDERR]:</span>
                    <pre style={{ margin: '4px 0 0 0', color: '#fca5a5', whiteSpace: 'pre-wrap' }}>{nodeTestResult.output.stderr}</pre>
                  </div>
                )}
                {nodeTestResult.output?.body && (
                  <div style={{ marginBottom: 8 }}>
                    <span style={{ color: '#38bdf8', fontWeight: 700 }}>[HTTP BODY] (Status {nodeTestResult.output.status}):</span>
                    <pre style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap' }}>{nodeTestResult.output.body}</pre>
                  </div>
                )}
                {nodeTestResult.error && (
                  <div>
                    <span style={{ color: '#ef4444', fontWeight: 700 }}>[ERROR]:</span>
                    <pre style={{ margin: '4px 0 0 0', color: '#ef4444', whiteSpace: 'pre-wrap' }}>{nodeTestResult.error}</pre>
                  </div>
                )}
                {nodeTestResult.output?.result !== undefined && (
                  <div>
                    <span style={{ color: '#2dd4bf', fontWeight: 700 }}>[RETURN VALUE]:</span>
                    <pre style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap' }}>{JSON.stringify(nodeTestResult.output.result, null, 2)}</pre>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <button className="btn-action-pill" onClick={testCurrentNode} disabled={testingNode}>
              🔄 Re-run Test
            </button>
            <button className="btn-action-pill" style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none' }} onClick={() => setShowTestModal(false)}>
              Done
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ─── AI Workflow Copilot Modal ──────────────────────── */}
    {showAiCopilot && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99999 }} onClick={() => setShowAiCopilot(false)}>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 20, width: 680, padding: 28, boxShadow: '0 30px 70px rgba(0,0,0,0.5)' }} onClick={e => e.stopPropagation()}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 12, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 22 }}>✨</span>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>Vanguard AI Workflow Copilot</h3>
            </div>
            <button onClick={() => setShowAiCopilot(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20 }}>✕</button>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Describe your DevOps or SecOps automation scenario in natural language, and Vanguard AI will generate structured DAG nodes, parameters, and flow logic.
          </div>

          {/* Quick Preset Prompts */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {[
              { label: '🚀 Linux Log Rotation & Cleanup', prompt: 'Create a Linux maintenance workflow that checks /var/log disk usage on 192.168.1.10. If > 85%, compress logs, clean /tmp, and send HTTP alert webhook.' },
              { label: '🛡️ Windows Service Auto-Recovery', prompt: 'Create a Windows health workflow that checks W3SVC (IIS) service status on 192.168.1.20 via PowerShell. If stopped, restart service and verify.' },
              { label: '☸️ K8s Pod Restart & Alert', prompt: 'Create a Kubernetes pipeline that queries CrashLoopBackOff pods in default namespace, executes rollout restart on affected deployment, and sleeps 10s.' },
              { label: '🌐 Multi-Stage Health Verification', prompt: 'Create a workflow that probes https://api.corp.example/health. If HTTP 200, log success; otherwise SSH to host to dump diagnostics.' }
            ].map((p, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setAiPrompt(p.prompt)}
                style={{
                  padding: '4px 10px',
                  borderRadius: 20,
                  fontSize: 11,
                  background: 'rgba(139,92,246,0.1)',
                  border: '1px solid rgba(139,92,246,0.3)',
                  color: '#c084fc',
                  cursor: 'pointer'
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <Textarea
            value={aiPrompt}
            onChange={setAiPrompt}
            placeholder="Type instructions here... (e.g. Check disk space on server 10.0.0.5, if space is under 10GB then run log clean script and send Telegram notification)"
            style={{ minHeight: 90, fontSize: 13, color: 'var(--text-primary)' }}
          />

          {aiAuditResult && (
            <div style={{ marginTop: 14, padding: 14, background: 'rgba(0,0,0,0.3)', borderRadius: 10, border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 800, fontSize: 13 }}>Workflow Health Score: {aiAuditResult.score}/100</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{aiAuditResult.summary}</span>
              </div>
              {aiAuditResult.issues?.map((iss, i) => (
                <div key={i} style={{ fontSize: 11, color: iss.severity === 'HIGH' ? '#ef4444' : '#f59e0b', marginTop: 4 }}>
                  • <b>[{iss.severity}]</b> {iss.title}: {iss.recommendation}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18 }}>
            <button
              className="btn-action-pill"
              onClick={handleAiAudit}
              disabled={aiGenerating}
            >
              🔍 AI Audit & Lint Workflow
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-action-pill" onClick={() => setShowAiCopilot(false)}>Cancel</button>
              <button
                className="btn-action-pill"
                style={{ background: 'linear-gradient(135deg, #8b5cf6, #3b82f6)', color: '#fff', border: 'none', padding: '8px 18px' }}
                onClick={handleAiGenerate}
                disabled={aiGenerating}
              >
                {aiGenerating ? '✨ Generating...' : '✨ Generate & Load Canvas'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {/* ─── Templates Library Modal ────────────────────────── */}
    {showTemplatesModal && (
      <div style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: 20
      }}>
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
          padding: 28, borderRadius: 24, maxWidth: 800, width: '100%',
          boxShadow: '0 30px 60px rgba(0,0,0,0.3)', backdropFilter: 'blur(16px)',
          display: 'flex', flexDirection: 'column', gap: 20
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 18, fontWeight: 900 }}>📦 Workflow Template Library</h3>
            <button onClick={() => setShowTemplatesModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20 }}>✕</button>
          </div>
          
          <div style={{ display: 'flex', gap: 24, minHeight: 400 }}>
            {/* Templates List */}
            <div style={{ flex: 1.2, display: 'flex', flexDirection: 'column', gap: 12, borderRight: '1px solid var(--border-color)', paddingRight: 20, maxHeight: 450, overflowY: 'auto' }}>
              <h4 style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Available Templates</h4>
              {templates.map(t => (
                <div key={t.id} style={{ padding: 12, borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{t.description}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    <button className="btn-action-pill" style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none' }} onClick={() => createFromTemplate(t.id)}>Use</button>
                    {role === 'SuperAdmin' && !t.id.startsWith('tmpl-') && (
                      <button className="btn-action-pill" style={{ color: '#ef4444', borderColor: '#ef4444' }} onClick={() => deleteTemplate(t.id)}>Delete</button>
                    )}
                  </div>
                </div>
              ))}
              {templates.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No templates available</div>
              )}
            </div>

            {/* Save Current as Template Form */}
            <div style={{ flex: 0.8, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <h4 style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>Save Current As Template</h4>
              {activeWorkflow ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <Label>Template Name</Label>
                    <Input value={saveAsTemplateName} onChange={setSaveAsTemplateName} placeholder="e.g. Production Deployment Pipeline" />
                  </div>
                  <div>
                    <Label>Template Description</Label>
                    <Textarea value={saveAsTemplateDesc} onChange={setSaveAsTemplateDesc} placeholder="Describe the purpose of this template..." style={{ minHeight: 80 }} />
                  </div>
                  <button className="btn-action-pill" style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none', padding: '8px 16px', marginTop: 8 }} onClick={saveAsTemplate}>Save Template</button>
                </div>
              ) : (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, background: 'rgba(255,255,255,0.01)', borderRadius: 8, border: '1px dotted var(--border-color)' }}>
                  Select or create a workflow first to save it as a template.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    )}

    {/* ─── Versions History Modal ─────────────────────────── */}
    {showVersionsModal && (
      <div style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: 20
      }}>
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
          padding: 24, borderRadius: 16, maxWidth: 600, width: '100%',
          boxShadow: '0 30px 60px rgba(0,0,0,0.3)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 12, marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>⏳ Version History</h3>
            <button onClick={() => setShowVersionsModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20 }}>✕</button>
          </div>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {workflowHistory.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No previous versions found.</div>
            ) : (
              workflowHistory.map((h, i) => (
                <div key={i} style={{ padding: '12px 16px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 8, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>Version {h.version}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Saved on: {new Date(h.updatedAt).toLocaleString()}</div>
                  </div>
                  {h.version !== activeWorkflow?.version && (
                    <button className="btn-action-pill" style={{ padding: '4px 12px', fontSize: 11 }} onClick={() => compareWithVersion(h)}>Compare</button>
                  )}
                  {h.version === activeWorkflow?.version && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Current Active</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    )}

    {/* ─── Execution Logs & Debugger Modal ─────────────────── */}
    {showHistory && (
      <div style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: 20
      }}>
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
          padding: 24, borderRadius: 20, maxWidth: 960, width: '100%', maxHeight: '90vh',
          boxShadow: '0 30px 60px rgba(0,0,0,0.4)', backdropFilter: 'blur(16px)',
          display: 'flex', flexDirection: 'column', gap: 16
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 20 }}>📋</span>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 900 }}>Workflow Execution Logs &amp; Step Inspector</h3>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Inspect real-time execution outputs, step errors, and execution timeline</div>
              </div>
            </div>
            <button onClick={() => setShowHistory(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 20 }}>✕</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 20, flex: 1, minHeight: 450, overflow: 'hidden' }}>
            {/* Left: Execution Runs History List */}
            <div style={{ borderRight: '1px solid var(--border-color)', paddingRight: 16, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Recent Runs ({executions.length})</span>
                <button className="btn-action-pill" style={{ padding: '2px 8px', fontSize: 10 }} onClick={fetchExecutions}>🔄 Refresh</button>
              </div>

              {executions.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No execution logs yet. Run the workflow to view logs.</div>
              ) : (
                executions.map(exec => {
                  const isSelected = selectedExecution?.id === exec.id;
                  const execMeta = statusMeta(exec.status);
                  return (
                    <div
                      key={exec.id}
                      onClick={() => setSelectedExecution(exec)}
                      style={{
                        padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                        background: isSelected ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.02)',
                        border: isSelected ? '1px solid #3b82f6' : '1px solid var(--border-color)',
                        transition: 'all 0.2s'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontWeight: 800, fontSize: 12, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{exec.id}</span>
                        <span style={{
                          fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
                          background: execMeta.bg,
                          color: execMeta.color
                        }}>
                          {execMeta.badge}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
                        <span>👤 {exec.triggerUser || 'system'}</span>
                        <span>{exec.startedAt ? new Date(exec.startedAt).toLocaleTimeString() : ''}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Right: Selected Run Detail & Step Breakdown */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', paddingRight: 4 }}>
              {selectedExecution ? (
                <>
                  {/* Summary Bar */}
                  <div style={{ padding: '12px 16px', background: statusMeta(selectedExecution.status).bg, border: `1px solid ${statusMeta(selectedExecution.status).color}55`, borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text-primary)' }}>Execution: {selectedExecution.id} · {statusMeta(selectedExecution.status).badge}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                        Started: {new Date(selectedExecution.startedAt).toLocaleString()} | Trigger: {selectedExecution.triggeredBy} ({selectedExecution.triggerUser})
                      </div>
                      {selectedExecution.approval?.decidedBy && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                          {selectedExecution.approval.approved ? 'Approved' : 'Rejected'} by {selectedExecution.approval.decidedBy} at {new Date(selectedExecution.approval.decidedAt).toLocaleString()}
                          {selectedExecution.approval.comment ? ` — "${selectedExecution.approval.comment}"` : ''}
                        </div>
                      )}
                      {renderApprovalPanel(selectedExecution)}
                    </div>
                    <button
                      className="btn-action-pill"
                      style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none', padding: '6px 14px' }}
                      onClick={async () => {
                        try {
                          const res = await api.post(`/workflow/executions/${selectedExecution.id}/rerun`);
                          toast('success', `Rerun triggered: ${res.data.id}`);
                          fetchExecutions();
                          setSelectedExecution(res.data);
                        } catch (e) {
                          toast('error', 'Failed to rerun execution: ' + (e.response?.data?.error || e.message));
                        }
                      }}
                    >
                      🔁 Rerun This Flow
                    </button>
                  </div>

                  {/* Step Results */}
                  <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Step-by-Step Node Execution Breakdown</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {Object.entries(selectedExecution.nodeResults || {}).map(([nodeId, resObj]) => {
                      const canvasNode = nodes.find(n => n.id === nodeId);
                      const nodeType = canvasNode?.data?.nodeType || 'action';
                      const nodeLabel = canvasNode?.data?.label || nodeId;
                      const nodeDef = NODE_TYPES[nodeType] || { icon: '⚡', color: '#3b82f6' };
                      const isFailed = resObj.status === 'failed';

                      return (
                        <div
                          key={nodeId}
                          style={{
                            background: isFailed ? 'rgba(239,68,68,0.06)' : 'rgba(255,255,255,0.02)',
                            border: isFailed ? '1px solid rgba(239,68,68,0.4)' : '1px solid var(--border-color)',
                            borderRadius: 10, padding: 14
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 16 }}>{nodeDef.icon}</span>
                              <span style={{ fontWeight: 800, fontSize: 13, color: 'var(--text-primary)' }}>{nodeLabel}</span>
                              <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: `${nodeDef.color}20`, color: nodeDef.color, fontWeight: 700 }}>{nodeType.toUpperCase()}</span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>⏱️ {resObj.attempts > 1 ? `(Tries: ${resObj.attempts})` : ''}</span>
                              <span style={{
                                fontSize: 11, fontWeight: 800, padding: '3px 8px', borderRadius: 4,
                                background: statusMeta(resObj.status).color,
                                color: '#fff'
                              }}>
                                {resObj.status?.replace('_', ' ').toUpperCase()}
                              </span>
                              {canvasNode && (
                                <button
                                  className="btn-action-pill"
                                  style={{ padding: '2px 8px', fontSize: 10 }}
                                  onClick={() => {
                                    setShowHistory(false);
                                    setSelectedNode(canvasNode);
                                    setCenter(canvasNode.position.x + 100, canvasNode.position.y + 40, { zoom: 1.1, duration: 400 });
                                  }}
                                  title="Locate this node on canvas"
                                >
                                  🎯 View Node
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Error Message Box */}
                          {resObj.error && (
                            <div style={{
                              background: 'rgba(239, 68, 68, 0.15)',
                              border: '1px solid rgba(239, 68, 68, 0.4)',
                              borderLeft: '4px solid #ef4444',
                              borderRadius: 6, padding: '8px 12px', marginTop: 8,
                              color: '#fecaca', fontSize: 12, fontFamily: 'monospace', lineHeight: 1.4
                            }}>
                              <b>[ERROR REASON]:</b> {resObj.error}
                            </div>
                          )}

                          {/* Node Output / STDERR */}
                          {resObj.output && (
                            <div style={{ marginTop: 8 }}>
                              <div style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)', marginBottom: 4 }}>OUTPUT / STDOUT:</div>
                              <pre style={{
                                margin: 0, padding: 10, background: '#090d16', border: '1px solid rgba(255,255,255,0.08)',
                                borderRadius: 6, fontSize: 11, color: '#38bdf8', fontFamily: 'monospace',
                                maxHeight: 150, overflowY: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                              }}>
                                {typeof resObj.output === 'object' ? (resObj.output.stdout || resObj.output.stderr || JSON.stringify(resObj.output, null, 2)) : String(resObj.output)}
                              </pre>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Select an execution run from the left panel to inspect step details.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    )}

    {/* Custom Delete Workflow Confirmation Modal */}
    {showDeleteWorkflowConfirm && (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 99999
      }}>
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
          padding: 24, borderRadius: 16, maxWidth: 420, width: '90%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', textAlign: 'center'
        }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
          <h3 style={{ marginTop: 0, marginBottom: 10, color: 'var(--text-primary)', textTransform: 'uppercase', fontSize: 14, letterSpacing: 1 }}>
            Delete Workflow
          </h3>
          <p style={{ color: 'var(--text-muted)', marginBottom: 20, fontSize: 13, wordBreak: 'break-word', lineHeight: 1.5 }}>
            Are you sure you want to permanently delete workflow <b>"{activeWorkflow?.name}"</b>? All associated execution logs and version history will also be removed.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10 }}>
            <button className="btn-action-pill" onClick={() => setShowDeleteWorkflowConfirm(false)}>Cancel</button>
            <button className="btn-action-pill" style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '8px 20px' }} onClick={deleteCurrentWorkflow}>
              Confirm Delete
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Alert Modal */}
    {alertConfig && (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 99999
      }}>
        <div style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
          padding: 24, borderRadius: 16, maxWidth: 400, width: '90%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)', textAlign: 'center'
        }}>
          <h3 style={{ marginTop: 0, marginBottom: 12, color: 'var(--text-primary)', textTransform: 'uppercase', fontSize: 14, letterSpacing: 1 }}>
            {alertConfig.type === 'success' ? '✅ Success' : alertConfig.type === 'error' ? '❌ Error' : 'ℹ️ Notification'}
          </h3>
          <p style={{ color: 'var(--text-muted)', marginBottom: 20, fontSize: 13, wordBreak: 'break-word', lineHeight: 1.5 }}>{alertConfig.message}</p>
          <button className="btn-action-pill" style={{ background: 'var(--accent-primary)', color: '#fff', border: 'none', padding: '8px 24px', margin: '0 auto' }} onClick={() => setAlertConfig(null)}>Confirm</button>
        </div>
      </div>
    )}
    </>
  );
}

function Label({ children }) { return <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginTop: 8, marginBottom: 4, textTransform: 'uppercase' }}>{children}</div>; }
function Input({ value, onChange, placeholder, type }) { return <input value={value || ''} onChange={e => onChange(e.target.value)} placeholder={placeholder} type={type || 'text'} style={{ width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: 'var(--text-primary)' }} />; }
function Textarea({ value, onChange, placeholder, style }) { return <textarea value={value || ''} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ width: '100%', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: 'var(--text-primary)', minHeight: 60, resize: 'vertical', fontFamily: 'monospace', ...style }} />; }

export default function WorkflowEditorWrapper(props) {
  return (
    <ReactFlowProvider>
      <WorkflowEditor {...props} />
    </ReactFlowProvider>
  );
}