const express = require('express');
const router = express.Router();
const { requireAuth, checkRole, checkFeature } = require('../middleware/auth');
const { auditLog } = require('../lib/logger');
const wf = require('../lib/workflow');

router.use(requireAuth);
router.use(checkFeature('workflow'));

// ─── Templates API ─────────────────────────────────

const { readDataSync, writeDataSync } = require('../lib/db');

const PREBUILT_TEMPLATES = [
  {
    id: 'tmpl-health-check',
    name: 'Server Health Check',
    description: 'Check disk space, CPU load and memory usage on target servers.',
    variables: { HOST: '127.0.0.1' },
    nodes: [
      { id: 'start', type: 'start', position: { x: 250, y: 0 }, data: { label: 'Start' } },
      { id: 'checkDisk', type: 'ssh', position: { x: 250, y: 120 }, data: { label: 'Check Disk Space', command: 'df -h', host: '{{HOST}}', username: 'root', authMethod: 'password', password: '' } },
      { id: 'checkCpu', type: 'ssh', position: { x: 250, y: 240 }, data: { label: 'Check CPU Load', command: 'uptime', host: '{{HOST}}', username: 'root', authMethod: 'password', password: '' } },
      { id: 'end', type: 'end', position: { x: 250, y: 360 }, data: { label: 'End' } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'checkDisk' },
      { id: 'e2', source: 'checkDisk', target: 'checkCpu' },
      { id: 'e3', source: 'checkCpu', target: 'end' }
    ]
  },
  {
    id: 'tmpl-cert-renewal',
    name: 'Certificate Renewal Pipeline',
    description: 'Query remote certificate status and run acme renewal command.',
    variables: { DOMAIN: 'example.com', HOST: '127.0.0.1' },
    nodes: [
      { id: 'start', type: 'start', position: { x: 250, y: 0 }, data: { label: 'Start' } },
      { id: 'checkCert', type: 'http', position: { x: 250, y: 120 }, data: { label: 'Query Cert Status', url: 'https://{{DOMAIN}}', method: 'GET' } },
      { id: 'renewCert', type: 'ssh', position: { x: 250, y: 240 }, data: { label: 'Renew Certificate', command: 'certbot renew', host: '{{HOST}}', username: 'root', authMethod: 'password', password: '' } },
      { id: 'end', type: 'end', position: { x: 250, y: 360 }, data: { label: 'End' } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'checkCert' },
      { id: 'e2', source: 'checkCert', target: 'renewCert' },
      { id: 'e3', source: 'renewCert', target: 'end' }
    ]
  },
  {
    id: 'tmpl-ssh-command',
    name: 'Batch SSH Command',
    description: 'Run commands on remote server via SSH connection.',
    variables: { HOST: '127.0.0.1', COMMAND: 'uptime' },
    nodes: [
      { id: 'start', type: 'start', position: { x: 250, y: 0 }, data: { label: 'Start' } },
      { id: 'sshCommand', type: 'ssh', position: { x: 250, y: 120 }, data: { label: 'Execute SSH Command', command: '{{COMMAND}}', host: '{{HOST}}', username: 'root', authMethod: 'password', password: '' } },
      { id: 'end', type: 'end', position: { x: 250, y: 240 }, data: { label: 'End' } }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'sshCommand' },
      { id: 'e2', source: 'sshCommand', target: 'end' }
    ]
  }
];

router.get('/templates', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
  try {
    let templates = readDataSync('workflow_templates.json', null);
    if (templates === null || templates.length === 0) {
      templates = PREBUILT_TEMPLATES;
      writeDataSync('workflow_templates.json', templates);
    }
    res.json(templates);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/templates', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
  try {
    const { name, description, variables, nodes, edges } = req.body;
    if (!name) return res.status(400).json({ error: 'Template name is required' });

    let templates = readDataSync('workflow_templates.json', null);
    if (templates === null || templates.length === 0) {
      templates = [...PREBUILT_TEMPLATES];
    }

    const newTemplate = {
      id: `tmpl-${Date.now().toString(36)}`,
      name,
      description: description || '',
      variables: variables || {},
      nodes: nodes || [],
      edges: edges || []
    };

    templates.push(newTemplate);
    writeDataSync('workflow_templates.json', templates);
    auditLog(req.user.username, 'Workflow', `Saved workflow as template: ${name}`);
    res.status(201).json(newTemplate);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/templates/create-workflow', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
  try {
    const { templateId, name } = req.body;
    if (!templateId) return res.status(400).json({ error: 'templateId is required' });

    let templates = readDataSync('workflow_templates.json', null);
    if (templates === null || templates.length === 0) {
      templates = PREBUILT_TEMPLATES;
    }

    const template = templates.find(t => t.id === templateId);
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const newWf = wf.createWorkflow({
      name: name || `Copy of ${template.name}`,
      description: template.description,
      variables: template.variables,
      createdBy: req.user.username
    });

    wf.updateWorkflow(newWf.id, {
      nodes: template.nodes,
      edges: template.edges
    });

    const populatedWf = wf.getWorkflow(newWf.id);
    auditLog(req.user.username, 'Workflow', `Created workflow "${populatedWf.name}" from template`);
    res.status(201).json(populatedWf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/templates/:id', checkRole(['SuperAdmin']), (req, res) => {
  try {
    let templates = readDataSync('workflow_templates.json', null);
    if (templates === null || templates.length === 0) {
      templates = [...PREBUILT_TEMPLATES];
    }

    const filtered = templates.filter(t => t.id !== req.params.id);
    writeDataSync('workflow_templates.json', filtered);
    auditLog(req.user.username, 'Workflow', `Deleted template ID: ${req.params.id}`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Workflow CRUD ─────────────────────────────────

router.get('/', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
  try { res.json(wf.getAllWorkflows()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
  try {
    const workflow = wf.getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    res.json(workflow);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/history', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
  try {
    const history = wf.getWorkflowHistory(req.params.id);
    res.json(history.sort((a, b) => b.version - a.version));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
  try {
    const workflow = wf.createWorkflow({ ...req.body, createdBy: req.user.username });
    auditLog(req.user.username, 'Workflow', `Created workflow: ${workflow.name}`);
    res.status(201).json(workflow);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/:id', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
  try {
    const workflow = wf.updateWorkflow(req.params.id, req.body);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    auditLog(req.user.username, 'Workflow', `Updated workflow: ${workflow.name}`);
    res.json(workflow);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', checkRole(['SuperAdmin', 'Operator']), (req, res) => {
  try {
    wf.deleteWorkflow(req.params.id);
    auditLog(req.user.username, 'Workflow', `Deleted workflow: ${req.params.id}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Execution ─────────────────────────────────────

router.post('/:id/execute', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
  try {
    const workflow = wf.getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
    const execution = await wf.executeWorkflow(workflow, {
      triggeredBy: 'manual',
      triggerUser: req.user.username,
      triggerRole: req.user.role,
      inputs: req.body.inputs || {}
    });
    auditLog(req.user.username, 'Workflow', `Executed workflow: ${workflow.name} (${execution.id})`);
    res.json(execution);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/executions', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    res.json(wf.getExecutions(req.params.id, limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/executions/:execId/rerun', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
  try {
    const execution = await wf.rerunExecution(req.params.execId, {
      triggerUser: req.user.username,
      triggerRole: req.user.role
    });
    if (!execution) return res.status(404).json({ error: 'Execution not found' });
    auditLog(req.user.username, 'Workflow', `Rerun execution: ${execution.id}`);
    res.json(execution);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Manual Approval ───────────────────────────────

function decideApproval(approved) {
  return async (req, res) => {
    try {
      const decidedBy = req.user.domain ? `${req.user.username}@${req.user.domain}` : req.user.username;
      const execution = await wf.resolveApproval(req.params.execId, {
        approved,
        user: decidedBy,
        comment: String((req.body && req.body.comment) || '').slice(0, 500)
      });
      auditLog(req.user.username, 'Workflow', `${approved ? 'Approved' : 'Rejected'} execution: ${req.params.execId}`);
      res.json(execution);
    } catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
      if (e.code === 'NOT_WAITING') return res.status(409).json({ error: e.message });
      res.status(500).json({ error: e.message });
    }
  };
}

router.post('/executions/:execId/approve', checkRole(['SuperAdmin']), decideApproval(true));
router.post('/executions/:execId/reject', checkRole(['SuperAdmin']), decideApproval(false));

router.get('/executions/:execId', checkRole(['SuperAdmin', 'Operator', 'Viewer']), (req, res) => {
  try {
    const execution = wf.getExecution(req.params.execId);
    if (!execution) return res.status(404).json({ error: 'Execution not found' });
    res.json(execution);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Single-Node Live Testing ──────────────────────
router.post('/test-node', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
  try {
    const { node, sampleContext } = req.body;
    if (!node || !node.type) {
      return res.status(400).json({ error: 'Node configuration is required' });
    }

    const userRole = req.user.role || 'Viewer';
    const ctx = {
      ...(sampleContext || {}),
      TRIGGER_USER: req.user.username,
      TRIGGER_USER_ROLE: userRole
    };

    const result = await wf.executeSingleNode(node, ctx);
    auditLog(req.user.username, 'Workflow', `Tested single node: ${node.type} (${node.data?.label || node.id})`);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

function repairJsonString(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        const next = text[i + 1];
        if (next && !['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'].includes(next)) {
          out += '\\\\';
        } else {
          out += '\\';
          escaped = true;
        }
      } else if (ch === '"') {
        inString = false;
        out += ch;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        // skip carriage return
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
        out += ch;
      } else {
        out += ch;
      }
    }
  }

  if (inString) {
    out += '"';
  }

  // Clean trailing commas before closing braces/brackets
  out = out.replace(/,\s*([}\]])/g, '$1');

  // Balance unclosed braces and brackets using a stack for truncated responses
  const stack = [];
  let inStr2 = false;
  let esc2 = false;

  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (inStr2) {
      if (esc2) esc2 = false;
      else if (ch === '\\') esc2 = true;
      else if (ch === '"') inStr2 = false;
    } else {
      if (ch === '"') {
        inStr2 = true;
      } else if (ch === '{') {
        stack.push('}');
      } else if (ch === '[') {
        stack.push(']');
      } else if (ch === '}' || ch === ']') {
        if (stack.length && stack[stack.length - 1] === ch) {
          stack.pop();
        }
      }
    }
  }

  out = out.replace(/,\s*$/, '');
  while (stack.length > 0) {
    out += stack.pop();
  }

  return out;
}

function extractAndParseJson(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    throw new Error('AI returned an empty response.');
  }

  let text = rawText.trim();

  // 1. Remove markdown code fences if present
  const markdownMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (markdownMatch) {
    text = markdownMatch[1].trim();
  }

  // 2. Extract substring from first '{' to last '}'
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  // 3. Try direct parse first
  try {
    return JSON.parse(text);
  } catch (e1) {
    // 4. Strip JavaScript-style comments
    let sanitized = text
      .replace(/(?<!https?:)\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    // 5. Apply deterministic state-machine repair for unescaped newlines, backslashes, and truncated brackets
    const repaired = repairJsonString(sanitized);

    try {
      return JSON.parse(repaired);
    } catch (e2) {
      console.error('[extractAndParseJson Error] Raw AI response:\n', rawText);
      console.error('[extractAndParseJson Error] Repaired attempt:\n', repaired);
      throw new Error(`AI generated malformed JSON: ${e2.message}`);
    }
  }
}

// ─── AI Workflow Copilot ───────────────────────────
const { getAiConfig, callAiEngine, validateAiConfig, formatAiError } = require('./ai');

router.post('/ai-generate', checkRole(['SuperAdmin', 'Operator']), async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const aiConfig = getAiConfig();
    const check = validateAiConfig(aiConfig);
    if (!check.valid) {
      return res.status(400).json({ error: check.message });
    }

    const systemPrompt = `You are the SOMP Vanguard Workflow Architect AI.
Your job is to generate a complete, production-ready, multi-step DevOps / SecOps automation workflow DAG matching the user's prompt.

CRITICAL ARCHITECTURE RULES:
1. DO NOT generate placeholder "start" or "end" nodes. All nodes MUST be one of the supported actionable types:
   - "ssh": remote Linux bash command
   - "powershell": Windows PowerShell script
   - "http": REST API request or Webhook notification
   - "condition": safe expression (NOT full JavaScript) branching to true/false. Read outputs via ctx.<nodeId>.<field>. Allowed: comparisons, && || !, arithmetic, ternary, parseInt/parseFloat/Number/String/Boolean/isNaN, Math.max/min/round/floor/ceil/abs, string includes/startsWith/endsWith/indexOf/toLowerCase/toUpperCase/trim/split/slice, array includes/join/length. No arrow functions, regex, assignments or other globals.
   - "k8s": kubectl command
   - "sleep": delay seconds
   - "approval": manual approval gate (pauses until a SuperAdmin approves; data: { "message": "..." })
   - "loop": for-each iterator
   - "script": custom sandboxed JS code
2. You MUST generate ALL intermediate steps requested by the user (e.g. initial check -> condition -> remediation actions -> webhook alert notifications).
3. If branching with "condition", connect the condition node to the True branch using "sourceHandle": "true" and to the False branch using "sourceHandle": "false".
4. Output MUST be ONLY a strictly valid JSON object adhering to the schema. Do NOT include markdown text outside JSON, comments, or trailing commas.

FEW-SHOT EXAMPLE:
User: "Check disk usage on 192.0.2.56. If > 85%, compress logs, clean /tmp, and send HTTP alert webhook."
Output:
{
  "name": "Linux Disk Maintenance & Alert",
  "description": "Automated disk health monitor, log rotation, and alert pipeline",
  "variables": {
    "TARGET_HOST": "192.0.2.56"
  },
  "nodes": [
    {
      "id": "check_disk",
      "type": "ssh",
      "position": { "x": 250, "y": 80 },
      "data": {
        "label": "Check /var/log Usage",
        "host": "192.0.2.56",
        "command": "df -h /var/log | awk 'NR==2 {print $5}' | tr -d '%'",
        "username": "root",
        "timeout": 30
      }
    },
    {
      "id": "eval_disk",
      "type": "condition",
      "position": { "x": 250, "y": 240 },
      "data": {
        "label": "Is Usage > 85%?",
        "expression": "parseInt(ctx.check_disk.stdout) > 85"
      }
    },
    {
      "id": "clean_logs",
      "type": "ssh",
      "position": { "x": 100, "y": 400 },
      "data": {
        "label": "Compress Logs & Clean /tmp",
        "host": "192.0.2.56",
        "command": "journalctl --vacuum-size=200M && find /var/log -type f -name '*.log.1' -exec gzip -f {} + && rm -rf /tmp/*",
        "username": "root",
        "timeout": 60
      }
    },
    {
      "id": "send_alert",
      "type": "http",
      "position": { "x": 100, "y": 560 },
      "data": {
        "label": "Send Webhook Alert",
        "url": "https://webhook.site/alert",
        "method": "POST",
        "headers": "{\"Content-Type\": \"application/json\"}",
        "body": "{\"level\": \"WARNING\", \"message\": \"Disk usage on 192.0.2.56 exceeded 85%. Auto-cleanup executed.\"}",
        "timeout": 15
      }
    },
    {
      "id": "normal_sleep",
      "type": "sleep",
      "position": { "x": 400, "y": 400 },
      "data": {
        "label": "Disk Usage Normal",
        "seconds": 1
      }
    }
  ],
  "edges": [
    { "id": "e1", "source": "check_disk", "target": "eval_disk" },
    { "id": "e2", "source": "eval_disk", "target": "clean_logs", "sourceHandle": "true" },
    { "id": "e3", "source": "clean_logs", "target": "send_alert" },
    { "id": "e4", "source": "eval_disk", "target": "normal_sleep", "sourceHandle": "false" }
  ]
}`;

    const userMessage = `Generate an enterprise workflow for: ${prompt}`;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];
    const aiResult = await callAiEngine(aiConfig, messages, {
      json: true,
      maxTokens: Math.max(aiConfig.maxTokens || 2048, 4096)
    });
    const rawAiResponse = aiResult?.content || '';

    const parsed = extractAndParseJson(rawAiResponse);
    auditLog(req.user.username, 'Workflow', `Generated AI Workflow from prompt: "${prompt.slice(0, 50)}..."`);
    res.json({ success: true, workflow: parsed });
  } catch (e) {
    console.error('[AI Workflow Generate Error]', e.response?.data || e.message);
    const errMsg = formatAiError ? formatAiError(e) : (e.message || String(e));
    res.status(500).json({ error: errMsg });
  }
});

router.post('/ai-audit', checkRole(['SuperAdmin', 'Operator', 'Viewer']), async (req, res) => {
  try {
    const { workflow } = req.body;
    if (!workflow) return res.status(400).json({ error: 'Workflow data is required' });

    const aiConfig = getAiConfig();
    const check = validateAiConfig(aiConfig);
    if (!check.valid) {
      return res.status(400).json({ error: check.message });
    }

    const systemPrompt = `You are a Senior Security & DevOps Code Auditor reviewing an automation workflow.
Analyze the provided workflow for:
1. Security risks (plaintext passwords, destructive commands).
2. Logic issues (orphaned nodes, unreachable branches, infinite loops).
3. Best practices & reliability (timeout settings, error handling).

CRITICAL: Return ONLY a valid JSON object matching:
{
  "score": 85,
  "summary": "High-level summary of review",
  "issues": [
    { "severity": "HIGH", "nodeId": "node_1", "title": "Missing Timeout", "description": "SSH command has no timeout.", "recommendation": "Set timeout to 30s." }
  ],
  "optimizations": ["Add error handling branch", "Use environment variable for target host"]
}`;

    const userMessage = `Review this workflow:\n${JSON.stringify(workflow, null, 2)}`;
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];
    const aiResult = await callAiEngine(aiConfig, messages, {
      json: true,
      maxTokens: Math.max(aiConfig.maxTokens || 2048, 3072)
    });
    const rawAiResponse = aiResult?.content || '';

    const auditResult = extractAndParseJson(rawAiResponse);
    res.json({ success: true, audit: auditResult });
  } catch (e) {
    console.error('[AI Workflow Audit Error]', e.response?.data || e.message);
    const errMsg = formatAiError ? formatAiError(e) : (e.message || String(e));
    res.status(500).json({ error: errMsg });
  }
});

module.exports = router;