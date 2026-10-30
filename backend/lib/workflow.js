const store = require('./db');
const crypto = require('crypto');
const { encryptText, decryptText } = require('./crypto');
const { executeSSH } = require('./ssh');
const { readEnv } = require('./envEditor');
const { evaluate } = require('./safeExpression');
const { runScript } = require('./scriptRunner');

// ─── Node Execution Handlers ───────────────────────

const HANDLERS = {};

HANDLERS.ssh = async (node, ctx) => {
  const d = node.data || {};
  const rawCmd = d.command || d.script || d.cmd || '';
  if (!rawCmd || !rawCmd.trim()) {
    throw new Error(`SSH node "${d.label || node.id}" has empty command configuration.`);
  }
  const cmd = resolveVars(rawCmd, ctx);
  const host = resolveVars(d.host, ctx);
  
  // All Linux operations default to LINUX_ADMIN_USER & LINUX_ADMIN_PWD
  const user = (d.username && d.username.trim()) ? resolveVars(d.username, ctx) : (process.env.LINUX_ADMIN_USER || 'root');
  const key = d.authMethod === 'key' ? resolveVars(d.sshKey, ctx) : null;
  let password = (d.password && d.password.trim()) ? resolveVars(d.password, ctx) : (process.env.LINUX_ADMIN_PWD || '');
  if (password && password.startsWith('enc:')) password = decryptText(password.slice(4));

  const result = await executeSSH(host, user, cmd, {
    privateKey: key, password, timeout: (d.timeout || 30) * 1000
  });
  if (result.code !== 0 && d.failOnExitCode !== false) {
    throw new Error(result.stderr?.trim() || `SSH command exited with non-zero exit code: ${result.code}`);
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
};

HANDLERS.powershell = async (node, ctx) => {
  const d = node.data || {};
  const rawCmd = d.command || d.script || d.cmd || d.code || '';
  if (!rawCmd || !rawCmd.trim()) {
    throw new Error(`PowerShell node "${d.label || node.id}" has empty command/script configuration.`);
  }
  const cmd = resolveVars(rawCmd, ctx);
  const host = resolveVars(d.host, ctx);
  
  // All Windows operations default to AD_ADMIN_USER & AD_ADMIN_PWD
  const user = (d.username && d.username.trim()) ? resolveVars(d.username, ctx) : (process.env.AD_ADMIN_USER || 'Administrator');
  let password = (d.password && d.password.trim()) ? resolveVars(d.password, ctx) : (process.env.AD_ADMIN_PWD || '');
  if (password && password.startsWith('enc:')) password = decryptText(password.slice(4));

  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], {
      env: { 
        ...process.env, 
        SSH_HOST: host, 
        SSH_USER: user, 
        SSH_PASS: password,
        WIN_HOST: host,
        WIN_USER: user,
        WIN_PASS: password,
        AD_ADMIN_USER: user,
        AD_ADMIN_PWD: password
      }
    });
    let stdout = '', stderr = '';
    ps.stdout.on('data', d => stdout += d);
    ps.stderr.on('data', d => stderr += d);
    ps.on('close', code => {
      if (code !== 0 && d.failOnExitCode !== false) {
        return reject(new Error(stderr.trim() || `PowerShell process exited with non-zero exit code: ${code}`));
      }
      resolve({ stdout, stderr, exitCode: code });
    });
    ps.on('error', reject);
  });
};

HANDLERS.http = async (node, ctx) => {
  const d = node.data || {};

  // 1. Integration Preset: Global Telegram Bot
  if (d.integrationType === 'telegram' || d.integrationId === '__telegram__') {
    const { sendTelegramAlert } = require('./logger');
    const msg = resolveVars(d.message || d.body || '🚨 [Workflow Alert] Execution Notification', ctx);
    try {
      await sendTelegramAlert(msg, 'Workflow');
      return {
        status: 200,
        output: 'Telegram alert dispatched successfully via System Integration Hub',
        stdout: `[Telegram Alert Dispatched]\n${msg}`
      };
    } catch (e) {
      throw new Error(`Failed to send Telegram alert: ${e.message}`);
    }
  }

  // 2. Integration Preset: Pre-configured System Webhook Target
  let targetUrl = resolveVars(d.url, ctx);
  let targetMethod = (d.method || 'POST').toUpperCase();
  let targetHeaders = { ...(d.headers || {}) };
  let targetBody = d.body ? resolveVars(d.body, ctx) : undefined;

  if (d.integrationId && d.integrationId !== '__custom__') {
    try {
      const webhookService = require('../services/webhookService');
      const allWebhooks = webhookService.loadWebhooks();
      const matchedWh = allWebhooks.find(w => w.id === d.integrationId || w.name?.toLowerCase() === d.integrationId?.toLowerCase());
      if (matchedWh) {
        targetUrl = resolveVars(matchedWh.url, ctx);
        targetMethod = (matchedWh.method || 'POST').toUpperCase();
        if (matchedWh.headers) {
          const whHdr = typeof matchedWh.headers === 'string' ? JSON.parse(matchedWh.headers) : matchedWh.headers;
          targetHeaders = { ...whHdr, ...targetHeaders };
        }
        if (!targetBody && matchedWh.bodyTemplate) {
          let tpl = matchedWh.bodyTemplate;
          const msgVal = resolveVars(d.message || 'Workflow notification', ctx);
          tpl = tpl.replace(/{{\s*message\s*}}/g, msgVal);
          tpl = tpl.replace(/{{\s*module\s*}}/g, 'Workflow');
          tpl = tpl.replace(/{{\s*timestamp\s*}}/g, new Date().toISOString());
          targetBody = resolveVars(tpl, ctx);
        }
      }
    } catch (whErr) {
      console.warn('[Workflow HTTP] Failed to load webhook preset:', whErr.message);
    }
  }

  if (!targetUrl || !targetUrl.trim()) {
    throw new Error(`HTTP / Webhook node "${d.label || node.id}" has no URL or Integration configured.`);
  }

  const axios = require('axios');
  const https = require('https');
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  let parsedBody = targetBody;
  if (typeof targetBody === 'string' && (targetBody.startsWith('{') || targetBody.startsWith('['))) {
    try { parsedBody = JSON.parse(targetBody); } catch {}
  }

  try {
    const res = await axios({
      method: targetMethod,
      url: targetUrl,
      data: parsedBody,
      headers: { 'Content-Type': 'application/json', ...targetHeaders },
      timeout: (d.timeout || 15) * 1000,
      httpsAgent,
      validateStatus: () => true
    });

    if (res.status >= 400 && d.failOnHttpError !== false) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data || '').slice(0, 300)}`);
    }

    return {
      status: res.status,
      body: res.data,
      headers: res.headers,
      stdout: typeof res.data === 'object' ? JSON.stringify(res.data, null, 2) : String(res.data)
    };
  } catch (err) {
    if (err.response) {
      throw new Error(`HTTP ${err.response.status} ${err.response.statusText}: ${typeof err.response.data === 'object' ? JSON.stringify(err.response.data) : String(err.response.data)}`);
    }
    throw new Error(`Webhook / HTTP Request failed (${targetUrl}): ${err.message}`);
  }
};

HANDLERS.k8s = async (node, ctx) => {
  const d = node.data || {};
  const clusterIdOrName = resolveVars(d.cluster || d.clusterId || '', ctx);
  let kubeconfig = resolveVars(d.kubeconfig, ctx);
  const command = resolveVars(d.command, ctx);
  const ns = d.namespace ? `-n ${resolveVars(d.namespace, ctx)}` : '';

  let tempKubeconfigPath = null;
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  // If cluster selected from Control Plane, resolve its decrypted kubeconfig/token
  if (clusterIdOrName && clusterIdOrName !== '__custom__') {
    const clusters = store.readDataSync('service_platform/k8s_clusters.json', []);
    const matched = clusters.find(c => c.id === clusterIdOrName || c.name.toLowerCase() === clusterIdOrName.toLowerCase());
    if (matched) {
      if (matched.authType === 'kubeconfig' && matched.kubeconfig_enc) {
        const rawKube = decryptText(matched.kubeconfig_enc);
        tempKubeconfigPath = path.join(os.tmpdir(), `k8s_wf_${Date.now()}_${Math.random().toString(36).slice(2)}.yaml`);
        fs.writeFileSync(tempKubeconfigPath, rawKube, 'utf8');
        kubeconfig = tempKubeconfigPath;
      } else if (matched.authType === 'token' && matched.apiUrl && matched.token_enc) {
        const rawToken = decryptText(matched.token_enc);
        const syntheticKube = `apiVersion: v1
clusters:
- cluster:
    server: ${matched.apiUrl}
    insecure-skip-tls-verify: ${matched.skipTlsVerify ? 'true' : 'false'}
  name: ${matched.name}
contexts:
- context:
    cluster: ${matched.name}
    user: ${matched.name}-user
  name: ${matched.name}
current-context: ${matched.name}
kind: Config
preferences: {}
users:
- name: ${matched.name}-user
  user:
    token: ${rawToken}
`;
        tempKubeconfigPath = path.join(os.tmpdir(), `k8s_wf_${Date.now()}_${Math.random().toString(36).slice(2)}.yaml`);
        fs.writeFileSync(tempKubeconfigPath, syntheticKube, 'utf8');
        kubeconfig = tempKubeconfigPath;
      }
    }
  }

  const { exec } = require('child_process');
  const env = { ...process.env };
  if (kubeconfig) env.KUBECONFIG = kubeconfig;

  try {
    const output = await new Promise((resolve, reject) => {
      exec(`kubectl ${ns} ${command}`, { env, timeout: (d.timeout || 60) * 1000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout);
        }
      });
    });
    return { stdout: output };
  } finally {
    if (tempKubeconfigPath && fs.existsSync(tempKubeconfigPath)) {
      try { fs.unlinkSync(tempKubeconfigPath); } catch {}
    }
  }
};

HANDLERS.nutanix = async (node, ctx) => {
  const d = node.data || {};
  const action = resolveVars(d.action || 'GET_STATUS', ctx).toUpperCase();
  const vmTarget = resolveVars(d.vmName || d.uuid || '', ctx);
  const clusterHost = resolveVars(d.cluster || process.env.NUTANIX_PC_IP || process.env.NUTANIX_PRIMARY_PE_IP || '', ctx);
  const user = resolveVars(d.username || process.env.NUTANIX_ACCOUNT || '', ctx);
  let pwd = resolveVars(d.password || process.env.NUTANIX_PASSWORD || '', ctx);
  if (pwd && pwd.startsWith('enc:')) pwd = decryptText(pwd.slice(4));

  if (!clusterHost || !user || !pwd) {
    throw new Error('Nutanix AHV connection parameters missing. Please specify Cluster IP and credentials or configure Nutanix in System Settings.');
  }

  const https = require('https');
  const axios = require('axios');
  const auth = Buffer.from(`${user}:${pwd}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  // 1. Resolve VM UUID if target is a name
  let targetUuid = vmTarget;
  let vmDetails = null;

  // Try fetching VM list from Prism Central (v3) or PE (v2.0)
  try {
    const listUrl = `https://${clusterHost}:9440/api/nutanix/v3/vms/list`;
    const listRes = await axios.post(listUrl, { kind: 'vm', length: 500 }, { headers, httpsAgent, timeout: 10000 });
    const entities = listRes.data?.entities || [];
    const matched = entities.find(e => e.metadata?.uuid === vmTarget || e.spec?.name?.toLowerCase() === vmTarget.toLowerCase());
    if (matched) {
      targetUuid = matched.metadata?.uuid;
      vmDetails = matched;
    }
  } catch (e) {
    // Fallback to PE v2.0
    try {
      const peUrl = `https://${clusterHost}:9440/api/nutanix/v2.0/vms`;
      const peRes = await axios.get(peUrl, { headers, httpsAgent, timeout: 10000 });
      const entities = peRes.data?.entities || [];
      const matched = entities.find(e => e.uuid === vmTarget || e.name?.toLowerCase() === vmTarget.toLowerCase());
      if (matched) {
        targetUuid = matched.uuid;
        vmDetails = matched;
      }
    } catch (err2) {}
  }

  if (action === 'LIST_VMS') {
    return { success: true, count: vmDetails ? 1 : 0, target: vmTarget, details: vmDetails };
  }

  if (action === 'GET_STATUS' || action === 'INFO') {
    if (!vmDetails) throw new Error(`VM "${vmTarget}" not found on Nutanix cluster ${clusterHost}`);
    const powerState = vmDetails.status?.resources?.power_state || vmDetails.power_state || 'UNKNOWN';
    const numVcpus = vmDetails.status?.resources?.num_vcpus_per_socket || vmDetails.num_vcpus || 0;
    const memoryMb = vmDetails.status?.resources?.memory_size_mib || vmDetails.memory_mb || 0;
    return {
      uuid: targetUuid,
      name: vmDetails.spec?.name || vmDetails.name || vmTarget,
      powerState,
      numVcpus,
      memoryMb,
      details: vmDetails
    };
  }

  if (['ON', 'OFF', 'ACPI_SHUTDOWN', 'RESET', 'POWER_ON', 'POWER_OFF'].includes(action)) {
    if (!targetUuid) throw new Error(`Target VM UUID or name "${vmTarget}" could not be resolved.`);
    const powerTransition = action === 'POWER_ON' ? 'ON' : (action === 'POWER_OFF' ? 'OFF' : action);

    // Try PE v2.0 power transition
    try {
      const pUrl = `https://${clusterHost}:9440/api/nutanix/v2.0/vms/${targetUuid}/set_power_state`;
      await axios.post(pUrl, { transition: powerTransition }, { headers, httpsAgent, timeout: 15000 });
      return { success: true, uuid: targetUuid, action: powerTransition, mode: 'PE v2.0' };
    } catch (peErr) {
      // Try PC v3 power transition
      const v3Url = `https://${clusterHost}:9440/api/nutanix/v3/vms/${targetUuid}`;
      const getRes = await axios.get(v3Url, { headers, httpsAgent, timeout: 10000 });
      const vmSpec = getRes.data;
      if (!vmSpec.spec?.resources) throw new Error(`Failed to update power state: ${peErr.message}`);
      vmSpec.spec.resources.power_state = powerTransition;
      await axios.put(v3Url, { spec: vmSpec.spec, metadata: vmSpec.metadata }, { headers, httpsAgent, timeout: 15000 });
      return { success: true, uuid: targetUuid, action: powerTransition, mode: 'PC v3' };
    }
  }

  throw new Error(`Unsupported Nutanix action: ${action}`);
};

HANDLERS.condition = async (node, ctx) => {
  const d = node.data || {};
  const expr = resolveVars(d.expression, ctx);
  // Throws on syntax errors / missing data so a typo never silently picks the false branch
  const result = !!evaluate(expr, ctx);
  return { condition: result, selectedBranch: result ? 'true' : 'false' };
};

HANDLERS.loop = async (node, ctx) => {
  const d = node.data || {};
  const items = resolveVars(d.items, ctx);
  const list = Array.isArray(items) ? items : [];
  const results = [];
  for (let i = 0; i < list.length; i++) {
    ctx[`${d.itemVar || 'item'}`] = list[i];
    ctx[`${d.indexVar || 'index'}`] = i;
    results.push(list[i]);
  }
  return { total: list.length, processed: results };
};

// Only used by the single-node tester; executeWorkflow pauses on approval nodes instead.
HANDLERS.approval = async (node, ctx) => {
  const d = node.data || {};
  return { approved: false, status: 'pending_approval', message: resolveVars(d.message, ctx) || '' };
};

HANDLERS.script = async (node, ctx) => {
  if (ctx.TRIGGER_USER_ROLE !== 'SuperAdmin') {
    throw new Error('Access denied: Script node execution is restricted to SuperAdmin role.');
  }
  const d = node.data || {};
  const code = resolveVars(d.code, ctx);

  // Isolated child process + vm context (see lib/scriptRunner.js)
  const { result, ctx: newCtx, logs } = await runScript(code, ctx, { timeoutMs: 5000 });
  for (const line of logs) console.log('[Workflow Script]', line);

  // Scripts may add/update ctx values, but not the execution identity used for authorization
  const { EXECUTION_ID, TRIGGERED_BY, TRIGGER_USER_ROLE } = ctx;
  Object.assign(ctx, newCtx, { EXECUTION_ID, TRIGGERED_BY, TRIGGER_USER_ROLE });

  return { result, stdout: logs.join('\n') };
};

HANDLERS.sleep = async (node, _ctx) => {
  const d = node.data || {};
  const ms = (d.seconds || 5) * 1000;
  await new Promise(r => setTimeout(r, ms));
  return { slept: ms };
};

// ─── Variable / Secret Resolution ──────────────────

function resolveVars(template, ctx) {
  if (!template || typeof template !== 'string') return template;
  const secrets = loadSecrets();
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (ctx[key] !== undefined) return String(ctx[key]);
    if (secrets[key] !== undefined) return secrets[key];
    if (process.env[key] !== undefined) return process.env[key];
    return `{{${key}}}`;
  });
}

function loadSecrets() {
  try {
    const env = readEnv();
    const secrets = {};
    for (const [k, v] of Object.entries(env)) {
      if (k.endsWith('_PWD') || k.endsWith('_PASSWORD') || k.endsWith('_TOKEN') || k.endsWith('_SECRET') || k.endsWith('_KEY')) {
        secrets[k] = v;
      }
    }
    return secrets;
  } catch { return {}; }
}

// ─── DAG Execution Engine ──────────────────────────

function topoSort(nodes, edges) {
  if (!nodes || !edges) return [];
  const adj = {};
  const inDeg = {};
  for (const n of nodes) { adj[n.id] = []; inDeg[n.id] = 0; }
  for (const e of edges) {
    if (adj[e.source]) adj[e.source].push(e.target);
    if (inDeg[e.target] !== undefined) inDeg[e.target]++;
  }
  const queue = nodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj[id] || []) {
      inDeg[next]--;
      if (inDeg[next] === 0) queue.push(next);
    }
  }
  return order;
}

// System credentials are injected at run time and must never be persisted with a paused execution
const SYSTEM_CTX_KEYS = ['AD_ADMIN_USER', 'AD_ADMIN_PWD', 'LINUX_ADMIN_USER', 'LINUX_ADMIN_PWD'];
const MAX_EXECUTION_HISTORY = 200;

function injectSystemContext(ctx) {
  // System credentials auto-injected for dynamic variable resolution
  for (const key of SYSTEM_CTX_KEYS) ctx[key] = process.env[key] || '';
  return ctx;
}

function sanitizeContext(ctx) {
  const copy = { ...ctx };
  for (const key of SYSTEM_CTX_KEYS) delete copy[key];
  return copy;
}

function saveExecution(execution) {
  const history = store.readDataSync('workflow_executions.json', []);
  const idx = history.findIndex(e => e.id === execution.id);
  if (idx >= 0) history[idx] = execution;
  else history.push(execution);

  // Trim oldest finished executions first; executions waiting for approval are kept
  let excess = history.length - MAX_EXECUTION_HISTORY;
  for (let i = 0; i < history.length && excess > 0;) {
    if (history[i].status !== 'waiting_approval') {
      history.splice(i, 1);
      excess--;
    } else {
      i++;
    }
  }
  store.writeDataSync('workflow_executions.json', history);
}

function recordOutput(ctx, nodeId, output) {
  ctx[nodeId] = output;                 // ctx.node_1.stdout (documented syntax)
  ctx[`${nodeId}.output`] = output;     // ctx["node_1.output"] (legacy flat keys)
  ctx[`${nodeId}.stdout`] = output?.stdout;
}

// An edge carries flow only when its source succeeded; condition edges only on the selected branch
function isEdgeLive(e, nodesById, nodeResults) {
  const src = nodeResults[e.source];
  if (!src || src.status !== 'success') return false;
  const srcNode = nodesById[e.source];
  if (srcNode?.type === 'condition' && (e.sourceHandle === 'true' || e.sourceHandle === 'false')) {
    return src.output?.selectedBranch === e.sourceHandle;
  }
  return true;
}

function isReachable(nodeId, edges, nodesById, nodeResults) {
  const incoming = edges.filter(e => e.target === nodeId && nodesById[e.source]);
  if (incoming.length === 0) return true;
  return incoming.some(e => isEdgeLive(e, nodesById, nodeResults));
}

function notifyApprovalRequested(execution) {
  try {
    const { sendTelegramAlert } = require('./logger');
    const link = process.env.BACKEND_URL ? `\nOpen: ${process.env.BACKEND_URL}` : '';
    const msg = `👤 [Workflow Approval Required]\nWorkflow: ${execution.workflowName || execution.workflowId}\n` +
      `Execution: ${execution.id}\nTriggered by: ${execution.triggerUser}\n` +
      `Message: ${execution.approval.message || '(none)'}\n` +
      `A SuperAdmin can approve or reject it in SOMP > Workflow > Executions.${link}`;
    Promise.resolve(sendTelegramAlert(msg, 'Workflow')).catch(() => {});
  } catch (e) {}
}

async function runNode(node, ctx, result) {
  const d = node.data || {};
  const retryCount = d?.retry?.count || 0;
  const retryDelay = d?.retry?.delay || 1;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    result.attempts = attempt + 1;
    try {
      const handler = HANDLERS[node.type];
      if (!handler) throw new Error(`Unknown node type: ${node.type}`);
      const output = await handler(node, ctx);
      result.output = output;
      result.error = null;
      recordOutput(ctx, node.id, output);
      result.status = 'success';
      return;
    } catch (err) {
      result.error = err.message;
      if (attempt < retryCount) {
        result.status = 'retrying';
        await new Promise(r => setTimeout(r, retryDelay * 1000));
      } else {
        result.status = 'failed';
      }
    }
  }
}

/**
 * Runs every still-pending node in topological order.
 * Stops and persists the execution when an approval node is reached.
 */
async function runPendingNodes(execution, ctx) {
  const { nodes, edges } = execution.workflowSnapshot;
  const nodesById = Object.fromEntries(nodes.map(n => [n.id, n]));
  const { nodeResults } = execution;

  for (const nodeId of topoSort(nodes, edges)) {
    const node = nodesById[nodeId];
    const result = nodeResults[nodeId];
    if (!node || result.status !== 'pending') continue;

    if (!isReachable(nodeId, edges, nodesById, nodeResults)) {
      result.status = 'skipped';
      continue;
    }

    result.startedAt = new Date().toISOString();

    if (node.type === 'start' || node.type === 'end') {
      result.status = 'success';
      result.completedAt = result.startedAt;
      continue;
    }

    if (node.type === 'approval') {
      result.status = 'pending_approval';
      result.output = { status: 'pending_approval' };
      execution.status = 'waiting_approval';
      execution.approval = {
        nodeId,
        message: resolveVars((node.data || {}).message, ctx) || '',
        requestedAt: result.startedAt,
      };
      execution.ctx = sanitizeContext(ctx);
      saveExecution(execution);
      notifyApprovalRequested(execution);
      return execution;
    }

    result.status = 'running';
    await runNode(node, ctx, result);
    result.completedAt = new Date().toISOString();
  }

  // Nodes never reached by the topological sort (e.g. cycles) did not run
  for (const r of Object.values(nodeResults)) {
    if (r.status === 'pending') r.status = 'skipped';
  }

  const anyFailed = Object.values(nodeResults).some(r => r.status === 'failed');
  execution.status = anyFailed ? 'failed' : 'success';
  execution.completedAt = new Date().toISOString();
  delete execution.ctx;
  saveExecution(execution);
  return execution;
}

async function executeWorkflow(workflow, triggerOpts = {}) {
  const executionId = `exec-${crypto.randomUUID().slice(0, 12)}`;
  const ctx = { ...(workflow.variables || {}), ...triggerOpts.inputs };
  ctx.EXECUTION_ID = executionId;
  ctx.TRIGGERED_BY = triggerOpts.triggeredBy || 'manual';
  ctx.TRIGGER_USER_ROLE = triggerOpts.triggerRole || 'system';
  injectSystemContext(ctx);

  const nodes = workflow.nodes || [];
  const nodeResults = {};
  for (const n of nodes) {
    nodeResults[n.id] = { status: 'pending', output: null, error: null, attempts: 0, startedAt: null, completedAt: null };
  }

  const execution = {
    id: executionId, workflowId: workflow.id, workflowName: workflow.name, status: 'running',
    startedAt: new Date().toISOString(), completedAt: null,
    triggeredBy: triggerOpts.triggeredBy || 'manual',
    triggerUser: triggerOpts.triggerUser || 'system',
    nodeResults, inputs: triggerOpts.inputs || {},
    // Snapshot so a paused execution resumes the graph it started with, even if the workflow is edited meanwhile
    workflowSnapshot: { nodes, edges: workflow.edges || [] },
  };

  return runPendingNodes(execution, ctx);
}

function decisionError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Approves or rejects an execution paused on an approval node, then resumes it.
 * @param {string} executionId
 * @param {{ approved: boolean, user: string, comment?: string }} decision
 */
async function resolveApproval(executionId, { approved, user, comment = '' }) {
  const execution = getExecution(executionId);
  if (!execution) throw decisionError(`Execution ${executionId} not found`, 'NOT_FOUND');
  if (execution.status !== 'waiting_approval' || !execution.approval) {
    throw decisionError(`Execution ${executionId} is not waiting for approval (status: ${execution.status})`, 'NOT_WAITING');
  }

  // Claim the execution synchronously so a concurrent second decision is rejected
  const { nodeId } = execution.approval;
  const result = execution.nodeResults[nodeId];
  const decidedAt = new Date().toISOString();
  result.output = { approved: !!approved, decidedBy: user, decidedAt, comment };
  result.completedAt = decidedAt;
  execution.approval = { ...execution.approval, approved: !!approved, decidedBy: user, decidedAt, comment };
  const ctx = injectSystemContext({ ...execution.ctx });

  if (!approved) {
    result.status = 'rejected';
    for (const r of Object.values(execution.nodeResults)) {
      if (r.status === 'pending') r.status = 'skipped';
    }
    execution.status = 'rejected';
    execution.completedAt = decidedAt;
    delete execution.ctx;
    saveExecution(execution);
    return execution;
  }

  result.status = 'success';
  recordOutput(ctx, nodeId, result.output);
  execution.status = 'running';
  saveExecution(execution);

  return runPendingNodes(execution, ctx);
}

// ─── CRUD ──────────────────────────────────────────

function getAllWorkflows() {
  return store.readDataSync('workflows.json', []);
}

function getWorkflow(id) {
  return getAllWorkflows().find(w => w.id === id) || null;
}

function createWorkflow(data) {
  const workflows = getAllWorkflows();
  const now = new Date().toISOString();
  const nodes = data.nodes || [];
  nodes.forEach(n => {
    if ((n.type === 'ssh' || n.type === 'powershell') && n.data && n.data.password) {
      if (!n.data.password.startsWith('enc:')) {
        n.data.password = 'enc:' + encryptText(n.data.password);
      }
    }
  });

  const wf = {
    id: `wf-${crypto.randomUUID().slice(0, 8)}`,
    name: data.name || 'New Workflow',
    description: data.description || '',
    version: 1,
    nodes: nodes,
    edges: data.edges || [],
    variables: data.variables || {},
    tags: data.tags || [],
    createdAt: now,
    updatedAt: now,
    createdBy: data.createdBy || 'system'
  };
  workflows.push(wf);
  store.writeDataSync('workflows.json', workflows);
  
  // Save initial version to history
  const history = store.readDataSync('workflow_history.json', []);
  history.push(JSON.parse(JSON.stringify(wf)));
  store.writeDataSync('workflow_history.json', history);
  
  return wf;
}

function updateWorkflow(id, patch) {
  const workflows = getAllWorkflows();
  const idx = workflows.findIndex(w => w.id === id);
  if (idx === -1) return null;

  // Save pre-update snapshot to history
  const history = store.readDataSync('workflow_history.json', []);
  history.push(JSON.parse(JSON.stringify(workflows[idx])));
  const wfHistory = history.filter(h => h.id === id);
  if (wfHistory.length > 10) {
    const toRemove = wfHistory[0];
    history.splice(history.indexOf(toRemove), 1);
  }
  store.writeDataSync('workflow_history.json', history);

  if (patch.name !== undefined) workflows[idx].name = patch.name;
  if (patch.description !== undefined) workflows[idx].description = patch.description;
  if (patch.nodes !== undefined) {
    patch.nodes.forEach(n => {
      if ((n.type === 'ssh' || n.type === 'powershell') && n.data && n.data.password) {
        if (!n.data.password.startsWith('enc:')) {
           n.data.password = 'enc:' + encryptText(n.data.password);
        }
      }
    });
    workflows[idx].nodes = patch.nodes;
  }
  if (patch.edges !== undefined) workflows[idx].edges = patch.edges;
  if (patch.variables !== undefined) workflows[idx].variables = patch.variables;
  if (patch.tags !== undefined) workflows[idx].tags = patch.tags;
  
  workflows[idx].version++;
  workflows[idx].updatedAt = new Date().toISOString();
  store.writeDataSync('workflows.json', workflows);
  return workflows[idx];
}

function deleteWorkflow(id) {
  const workflows = getAllWorkflows().filter(w => w.id !== id);
  store.writeDataSync('workflows.json', workflows);
  
  // Clean up history
  const history = store.readDataSync('workflow_history.json', []).filter(h => h.id !== id);
  store.writeDataSync('workflow_history.json', history);
  
  return true;
}

function getWorkflowHistory(id) {
  return store.readDataSync('workflow_history.json', []).filter(h => h.id === id);
}

// ─── Execution History ─────────────────────────────

function getExecutions(workflowId, limit = 20) {
  return store.readDataSync('workflow_executions.json', [])
    .filter(e => !workflowId || e.workflowId === workflowId)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, limit);
}

function getExecution(id) {
  return store.readDataSync('workflow_executions.json', []).find(e => e.id === id) || null;
}

async function rerunExecution(executionId, triggerOpts = {}) {
  const exec = getExecution(executionId);
  if (!exec) return null;
  const workflow = getWorkflow(exec.workflowId);
  if (!workflow) return null;
  return executeWorkflow(workflow, {
    triggeredBy: 'rerun',
    triggerUser: triggerOpts.triggerUser || exec.triggerUser,
    triggerRole: triggerOpts.triggerRole || 'system',
    inputs: exec.inputs
  });
}

async function executeSingleNode(node, sampleCtx = {}) {
  const handler = HANDLERS[node.type];
  if (!handler) {
    throw new Error(`Unsupported or unknown node type: "${node.type}"`);
  }
  const ctx = { ...sampleCtx };
  const startTime = Date.now();
  try {
    const result = await handler(node, ctx);
    const durationMs = Date.now() - startTime;
    return {
      success: true,
      durationMs,
      output: result,
      context: ctx
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    return {
      success: false,
      durationMs,
      error: err.message || String(err),
      stderr: err.stderr || err.message,
      context: ctx
    };
  }
}

module.exports = {
  getAllWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow,
  executeWorkflow, resolveApproval, getExecutions, getExecution, rerunExecution, getWorkflowHistory,
  executeSingleNode
};