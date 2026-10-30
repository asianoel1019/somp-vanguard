import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';

// Pre-packaged SOMP Vanguard API Snippets
const API_SNIPPETS = [
  {
    category: '🌐 Scout Open API',
    items: [
      { name: 'List All Monitored Servers', method: 'GET', path: '/api/v1/open/servers', body: '' },
      { name: 'Get OS & Hardware Metrics', method: 'GET', path: '/api/v1/open/os?host=127.0.0.1', body: '' },
      { name: 'Get Windows Event Logs', method: 'GET', path: '/api/v1/open/events?host=127.0.0.1&level=error&limit=10', body: '' },
      { name: 'Get Linux Syslog Records', method: 'GET', path: '/api/v1/open/syslog?host=127.0.0.1&limit=10', body: '' },
      { name: 'Query All CMDB Servers', method: 'GET', path: '/api/v1/open/cmdb/servers', body: '' }
    ]
  },
  {
    category: '⚡ Workflow Automation',
    items: [
      { name: 'List All Workflows', method: 'GET', path: '/api/workflow', body: '' },
      { 
        name: 'Create Sample Workflow', 
        method: 'POST', 
        path: '/api/workflow', 
        body: JSON.stringify({
          name: "DevTools Sample Pipeline",
          description: "Created via DevTools console",
          nodes: [
            { id: "start-1", type: "start", position: { x: 100, y: 100 }, data: { label: "Start" } },
            { id: "http-1", type: "http", position: { x: 300, y: 100 }, data: { label: "Health Probe", url: "http://127.0.0.1:5000/api/health", method: "GET" } },
            { id: "end-1", type: "end", position: { x: 500, y: 100 }, data: { label: "End" } }
          ],
          edges: [
            { id: "e1", source: "start-1", target: "http-1" },
            { id: "e2", source: "http-1", target: "end-1" }
          ]
        }, null, 2)
      },
      { name: 'List Workflow Templates', method: 'GET', path: '/api/workflow/templates', body: '' }
    ]
  },
  {
    category: '☸️ Kubernetes Control Plane',
    items: [
      { name: 'List K8s Clusters', method: 'GET', path: '/api/kubernetes/clusters', body: '' },
      { name: 'Get Cluster Health / Nodes', method: 'GET', path: '/api/kubernetes/cluster/default/nodes', body: '' }
    ]
  },
  {
    category: '🖥️ CMDB & Server Operations',
    items: [
      { name: 'Get Server List', method: 'GET', path: '/api/servers', body: '' },
      { name: 'Get Subnet Inventory Data', method: 'GET', path: '/api/inventory/data', body: '' },
      { name: 'Get Environment List', method: 'GET', path: '/api/environments', body: '' }
    ]
  },
  {
    category: '🤖 AI Service & Copilot',
    items: [
      { name: 'Get AI Configuration Status', method: 'GET', path: '/api/ai/config', body: '' },
      { 
        name: 'AI Prompt-to-Workflow Generator', 
        method: 'POST', 
        path: '/api/ai/generate-workflow', 
        body: JSON.stringify({
          prompt: "Check disk usage on /var/log on 192.0.2.56, if > 85% clean tmp and send webhook alert"
        }, null, 2)
      }
    ]
  },
  {
    category: '👥 RBAC & Audit Logs',
    items: [
      { name: 'Get User Roles & Mappings', method: 'GET', path: '/api/rbac', body: '' },
      { name: 'Get AD Groups RBAC', method: 'GET', path: '/api/rbac/groups', body: '' },
      { name: 'Query System Audit Logs', method: 'GET', path: '/api/audit/logs', body: '' }
    ]
  }
];

// 6 Authentic OS Themes Specification
const THEMES = {
  win7: {
    id: 'win7',
    name: '4. Windows 7 (預設)',
    shortName: 'Windows 7',
    icon: '🪟',
    badge: 'Aero Glass',
    isDark: true,
    fontFamily: "'Segoe UI', 'Segoe UI Variable', -apple-system, sans-serif",
    desktopBg: 'radial-gradient(ellipse at 50% 0%, #174276 0%, #0c213d 50%, #040d18 100%)',
    windowBg: 'rgba(15, 23, 42, 0.88)',
    windowBorder: '1px solid rgba(255, 255, 255, 0.55)',
    windowShadow: '0 20px 60px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.85)',
    windowRadius: '8px 8px 6px 6px',
    windowBackdrop: 'blur(20px) saturate(180%)',
    titlebarBg: 'linear-gradient(to bottom, rgba(255,255,255,0.45) 0%, rgba(255,255,255,0.15) 35%, rgba(0,0,0,0.08) 100%)',
    titlebarColor: '#ffffff',
    titlebarTextShadow: '0 0 12px rgba(255,255,255,0.9), 0 0 3px rgba(0,0,0,0.8)',
    toolbarBg: 'rgba(15, 23, 42, 0.95)',
    leftPanelBg: '#090e17',
    rightPanelBg: '#0b121e',
    panelBorder: '1px solid rgba(255, 255, 255, 0.12)',
    textColor: '#f1f5f9',
    textMuted: '#94a3b8',
    inputBg: '#090e17',
    inputBorder: '1px solid rgba(56, 189, 248, 0.35)',
    inputColor: '#ffffff',
    buttonDefaultBg: 'linear-gradient(to bottom, rgba(255,255,255,0.18) 0%, rgba(0,0,0,0.3) 100%)',
    buttonDefaultBorder: '1px solid rgba(255,255,255,0.35)',
    buttonDefaultColor: '#ffffff',
    buttonPrimaryBg: 'linear-gradient(to bottom, #3b82f6 0%, #1d4ed8 100%)',
    buttonPrimaryBorder: '1px solid #60a5fa',
    buttonPrimaryShadow: '0 0 16px rgba(59, 130, 246, 0.4), inset 0 1px 0 rgba(255,255,255,0.4)',
    accentColor: '#38bdf8',
    controlBg: 'rgba(0, 0, 0, 0.5)',
    controlBorder: '1px solid rgba(255, 255, 255, 0.18)',
    controlRadius: '4px',
    headerBg: '#080d16',
    badgeBg: 'rgba(56, 189, 248, 0.2)',
    badgeColor: '#38bdf8',
    badgeBorder: '1px solid rgba(56, 189, 248, 0.4)'
  },
  win31: {
    id: 'win31',
    name: '1. Windows 3.1',
    shortName: 'Windows 3.1',
    icon: '💾',
    badge: '16-bit Classic',
    isDark: false,
    fontFamily: "'Courier New', 'Fixedsys', 'MS Sans Serif', monospace",
    desktopBg: '#008080',
    windowBg: '#c0c0c0',
    windowBorder: '3px solid #000000',
    windowShadow: '6px 6px 0px rgba(0, 0, 0, 0.65)',
    windowRadius: '0px',
    windowBackdrop: 'none',
    titlebarBg: '#000080',
    titlebarColor: '#ffffff',
    titlebarTextShadow: 'none',
    toolbarBg: '#c0c0c0',
    leftPanelBg: '#ffffff',
    rightPanelBg: '#ffffff',
    panelBorder: '2px solid #000000',
    textColor: '#000000',
    textMuted: '#333333',
    inputBg: '#ffffff',
    inputBorder: '2px solid #000000',
    inputColor: '#000000',
    buttonDefaultBg: '#c0c0c0',
    buttonDefaultBorder: '2px solid #000000',
    buttonDefaultColor: '#000000',
    buttonPrimaryBg: '#000080',
    buttonPrimaryBorder: '2px solid #000000',
    buttonPrimaryShadow: '2px 2px 0px #000000',
    accentColor: '#000080',
    controlBg: '#a0a0a0',
    controlBorder: '2px inset #ffffff',
    controlRadius: '0px',
    headerBg: '#c0c0c0',
    badgeBg: '#000080',
    badgeColor: '#ffffff',
    badgeBorder: '1px solid #ffffff'
  },
  win95: {
    id: 'win95',
    name: '2. Windows 95',
    shortName: 'Windows 95',
    icon: '🕹️',
    badge: '32-bit Classic',
    isDark: false,
    fontFamily: "'Tahoma', 'MS Sans Serif', Arial, sans-serif",
    desktopBg: '#008080',
    windowBg: '#c0c0c0',
    windowBorder: '2px outset #ffffff',
    windowShadow: '4px 4px 12px rgba(0, 0, 0, 0.6)',
    windowRadius: '0px',
    windowBackdrop: 'none',
    titlebarBg: 'linear-gradient(90deg, #000080 0%, #1084d0 100%)',
    titlebarColor: '#ffffff',
    titlebarTextShadow: 'none',
    toolbarBg: '#c0c0c0',
    leftPanelBg: '#ffffff',
    rightPanelBg: '#ffffff',
    panelBorder: '2px inset #ffffff',
    textColor: '#000000',
    textMuted: '#555555',
    inputBg: '#ffffff',
    inputBorder: '2px inset #ffffff',
    inputColor: '#000000',
    buttonDefaultBg: '#c0c0c0',
    buttonDefaultBorder: '2px outset #ffffff',
    buttonDefaultColor: '#000000',
    buttonPrimaryBg: '#c0c0c0',
    buttonPrimaryBorder: '2px outset #ffffff',
    buttonPrimaryShadow: 'inset 1px 1px 0px #fff',
    accentColor: '#000080',
    controlBg: '#b0b0b0',
    controlBorder: '2px inset #ffffff',
    controlRadius: '0px',
    headerBg: '#c0c0c0',
    badgeBg: '#000080',
    badgeColor: '#ffffff',
    badgeBorder: '1px solid #ffffff'
  },
  winxp: {
    id: 'winxp',
    name: '3. Windows XP',
    shortName: 'Windows XP',
    icon: '🌄',
    badge: 'Luna Blue',
    isDark: false,
    fontFamily: "'Tahoma', 'Trebuchet MS', Arial, sans-serif",
    desktopBg: 'linear-gradient(135deg, #0050d8 0%, #207ce5 50%, #4facfe 100%)',
    windowBg: '#ece9d8',
    windowBorder: '3px solid #0055ea',
    windowShadow: '0 14px 40px rgba(0, 0, 0, 0.5)',
    windowRadius: '8px 8px 0 0',
    windowBackdrop: 'none',
    titlebarBg: 'linear-gradient(to bottom, #0058ee 0%, #3593ff 5%, #288eff 8%, #036ffc 14%, #0057e5 60%, #004dd0 100%)',
    titlebarColor: '#ffffff',
    titlebarTextShadow: '1px 1px 2px #002e88',
    toolbarBg: '#f2f0e6',
    leftPanelBg: '#ffffff',
    rightPanelBg: '#f8f7f2',
    panelBorder: '1px solid #7f9db9',
    textColor: '#000000',
    textMuted: '#555555',
    inputBg: '#ffffff',
    inputBorder: '1px solid #7f9db9',
    inputColor: '#000000',
    buttonDefaultBg: 'linear-gradient(to bottom, #ffffff 0%, #ecebe5 85%, #d8d0c4 100%)',
    buttonDefaultBorder: '1px solid #003c74',
    buttonDefaultColor: '#000000',
    buttonPrimaryBg: 'linear-gradient(to bottom, #39b54a 0%, #228833 100%)',
    buttonPrimaryBorder: '1px solid #116622',
    buttonPrimaryShadow: 'inset 0 1px 0 #77dd88, 0 1px 2px rgba(0,0,0,0.2)',
    accentColor: '#0055ea',
    controlBg: '#dcd8c8',
    controlBorder: '1px solid #7f9db9',
    controlRadius: '3px',
    headerBg: '#ece9d8',
    badgeBg: '#0055ea',
    badgeColor: '#ffffff',
    badgeBorder: '1px solid #003c74'
  },
  win11: {
    id: 'win11',
    name: '5. Windows 11',
    shortName: 'Windows 11',
    icon: '🪟',
    badge: 'Fluent Mica Light',
    isDark: false,
    fontFamily: "'Segoe UI Variable Text', 'Segoe UI', -apple-system, sans-serif",
    desktopBg: 'radial-gradient(ellipse at 50% 15%, #edf2f7 0%, #e2e8f0 55%, #cbd5e1 100%)',
    windowBg: '#f9fafb',
    windowBorder: '1px solid #d1d5db',
    windowShadow: '0 16px 40px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.04)',
    windowRadius: '8px',
    windowBackdrop: 'blur(30px)',
    titlebarBg: '#f0f2f5',
    titlebarColor: '#111827',
    titlebarTextShadow: 'none',
    toolbarBg: '#f8fafc',
    leftPanelBg: '#ffffff',
    rightPanelBg: '#f8fafc',
    panelBorder: '1px solid #e5e7eb',
    textColor: '#111827',
    textMuted: '#64748b',
    inputBg: '#ffffff',
    inputBorder: '1px solid #cbd5e1',
    inputColor: '#0f172a',
    buttonDefaultBg: '#ffffff',
    buttonDefaultBorder: '1px solid #d1d5db',
    buttonDefaultColor: '#111827',
    buttonPrimaryBg: '#0067c0',
    buttonPrimaryBorder: '1px solid #005fb8',
    buttonPrimaryShadow: '0 2px 5px rgba(0, 103, 192, 0.3)',
    accentColor: '#0067c0',
    controlBg: '#e5e7eb',
    controlBorder: '1px solid #d1d5db',
    controlRadius: '6px',
    headerBg: '#f3f4f6',
    badgeBg: '#e0edff',
    badgeColor: '#005fb8',
    badgeBorder: '1px solid #b9d7fc'
  },
  mac: {
    id: 'mac',
    name: '6. MAC',
    shortName: 'macOS',
    icon: '🍎',
    badge: 'macOS Sonoma',
    isDark: true,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif",
    desktopBg: 'linear-gradient(135deg, #1f1035 0%, #351545 40%, #0d1b2a 100%)',
    windowBg: 'rgba(30, 30, 30, 0.95)',
    windowBorder: '1px solid rgba(255, 255, 255, 0.18)',
    windowShadow: '0 25px 65px rgba(0, 0, 0, 0.6), 0 0 1px rgba(255, 255, 255, 0.25)',
    windowRadius: '12px',
    windowBackdrop: 'blur(35px)',
    titlebarBg: 'rgba(40, 40, 40, 0.9)',
    titlebarColor: '#f5f5f7',
    titlebarTextShadow: 'none',
    toolbarBg: '#252526',
    leftPanelBg: '#1e1e1e',
    rightPanelBg: '#232325',
    panelBorder: '1px solid rgba(255, 255, 255, 0.08)',
    textColor: '#f5f5f7',
    textMuted: '#a1a1aa',
    inputBg: '#19191b',
    inputBorder: '1px solid rgba(255, 255, 255, 0.2)',
    inputColor: '#f5f5f7',
    buttonDefaultBg: 'rgba(255, 255, 255, 0.12)',
    buttonDefaultBorder: '1px solid rgba(255, 255, 255, 0.2)',
    buttonDefaultColor: '#f5f5f7',
    buttonPrimaryBg: '#0a84ff',
    buttonPrimaryBorder: '1px solid #0071e3',
    buttonPrimaryShadow: '0 2px 8px rgba(10, 132, 255, 0.4)',
    accentColor: '#0a84ff',
    controlBg: 'rgba(0, 0, 0, 0.35)',
    controlBorder: '1px solid rgba(255, 255, 255, 0.12)',
    controlRadius: '8px',
    headerBg: '#1c1c1e',
    badgeBg: 'rgba(255, 255, 255, 0.12)',
    badgeColor: '#f5f5f7',
    badgeBorder: '1px solid rgba(255, 255, 255, 0.25)'
  }
};

export default function DevTools() {
  // Theme State - Default: 'win7' (Windows 7)
  const [osTheme, setOsTheme] = useState(() => {
    return localStorage.getItem('vanguard_devtools_theme') || 'win7';
  });

  const currentTheme = THEMES[osTheme] || THEMES.win7;

  const handleThemeChange = (newTheme) => {
    setOsTheme(newTheme);
    localStorage.setItem('vanguard_devtools_theme', newTheme);
  };

  // Window State
  const [isMaximized, setIsMaximized] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);

  const [editorMode, setEditorMode] = useState('console'); // 'console' | 'visual'
  
  // Console Mode State (Kibana-style multi-request editor)
  const [consoleCode, setConsoleCode] = useState(
`# 🛠️ SOMP Vanguard Dev Tools Console
# Type HTTP Method followed by API endpoint path and optional JSON Body.
# Press Ctrl + Enter to execute the selected request.

GET /api/v1/open/servers

GET /api/kubernetes/clusters

GET /api/workflow

POST /api/health
`
  );

  // Visual Builder State
  const [method, setMethod] = useState('GET');
  const [pathInput, setPathInput] = useState('/api/v1/open/servers');
  const [requestHeaders, setRequestHeaders] = useState([
    { key: 'Content-Type', value: 'application/json' }
  ]);
  const [queryParams, setQueryParams] = useState([
    { key: '', value: '' }
  ]);
  const [bodyText, setBodyText] = useState('');

  // Response State
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [responseTab, setResponseTab] = useState('pretty'); // 'pretty' | 'raw' | 'headers'
  const [responseSearch, setResponseSearch] = useState('');
  const [history, setHistory] = useState([]);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const textareaRef = useRef(null);

  // Load history from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('vanguard_devtools_history');
      if (saved) setHistory(JSON.parse(saved));
    } catch (e) {}
  }, []);

  const saveHistoryItem = (item) => {
    const updated = [item, ...history.filter(h => h.path !== item.path || h.method !== item.method)].slice(0, 40);
    setHistory(updated);
    try {
      localStorage.setItem('vanguard_devtools_history', JSON.stringify(updated));
    } catch (e) {}
  };

  // Keyboard shortcut Ctrl+Enter to execute
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (editorMode === 'console') {
          executeConsoleSelection();
        } else {
          executeVisualRequest();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editorMode, consoleCode, method, pathInput, bodyText, queryParams, requestHeaders]);

  // Parse and execute request from console cursor position
  const parseCurrentConsoleBlock = () => {
    if (!textareaRef.current) return null;
    const text = consoleCode;
    const pos = textareaRef.current.selectionStart || 0;

    const lines = text.split('\n');
    let charCount = 0;
    let currentLineIdx = 0;

    for (let i = 0; i < lines.length; i++) {
      charCount += lines[i].length + 1;
      if (charCount > pos) {
        currentLineIdx = i;
        break;
      }
    }

    const methodRegex = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)/i;
    let startIdx = currentLineIdx;
    while (startIdx >= 0 && !lines[startIdx].trim().match(methodRegex)) {
      startIdx--;
    }

    if (startIdx < 0 || !lines[startIdx].trim().match(methodRegex)) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().match(methodRegex)) {
          startIdx = i;
          break;
        }
      }
    }

    if (startIdx < 0) return null;

    const headerMatch = lines[startIdx].trim().match(methodRegex);
    const reqMethod = headerMatch[1].toUpperCase();
    const reqPath = headerMatch[2];

    let bodyLines = [];
    let endIdx = startIdx + 1;
    while (endIdx < lines.length && !lines[endIdx].trim().match(methodRegex) && !lines[endIdx].trim().startsWith('#')) {
      bodyLines.push(lines[endIdx]);
      endIdx++;
    }

    let parsedBody = null;
    const rawBodyStr = bodyLines.join('\n').trim();
    if (rawBodyStr) {
      try {
        parsedBody = JSON.parse(rawBodyStr);
      } catch (e) {
        parsedBody = rawBodyStr;
      }
    }

    return { method: reqMethod, path: reqPath, body: parsedBody, rawBody: rawBodyStr };
  };

  const executeConsoleSelection = async () => {
    const parsed = parseCurrentConsoleBlock();
    if (!parsed) {
      setResponse({
        error: 'No valid request found at cursor. Format: GET /api/... followed by optional JSON body.',
        status: 400
      });
      return;
    }
    await dispatchExecute(parsed.method, parsed.path, parsed.body, {}, {});
  };

  const executeVisualRequest = async () => {
    let parsedBody = null;
    if (bodyText.trim() && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch (e) {
        setResponse({ error: `Invalid JSON body: ${e.message}`, status: 400 });
        return;
      }
    }

    const headersObj = {};
    requestHeaders.forEach(h => {
      if (h.key.trim()) headersObj[h.key.trim()] = h.value;
    });

    const paramsObj = {};
    queryParams.forEach(p => {
      if (p.key.trim()) paramsObj[p.key.trim()] = p.value;
    });

    await dispatchExecute(method, pathInput, parsedBody, headersObj, paramsObj);
  };

  const dispatchExecute = async (reqMethod, reqPath, reqBody, reqHeaders, reqParams) => {
    setLoading(true);
    setResponse(null);
    try {
      const res = await api.post('/devtools/execute', {
        method: reqMethod,
        path: reqPath,
        body: reqBody,
        headers: reqHeaders,
        params: reqParams
      });

      setResponse(res.data);
      saveHistoryItem({
        id: Date.now(),
        method: reqMethod,
        path: reqPath,
        status: res.data.status,
        durationMs: res.data.durationMs,
        timestamp: new Date().toISOString(),
        body: reqBody
      });
    } catch (err) {
      setResponse({
        success: false,
        status: err.response?.status || 500,
        statusText: err.response?.statusText || 'Error',
        error: err.response?.data?.error || err.message,
        durationMs: err.response?.data?.durationMs || 0,
        data: err.response?.data || null
      });
    } finally {
      setLoading(false);
    }
  };

  const loadSnippet = (snippet) => {
    if (editorMode === 'console') {
      const snippetBlock = `\n${snippet.method} ${snippet.path}\n${snippet.body ? snippet.body + '\n' : ''}`;
      setConsoleCode(prev => prev.trim() + '\n' + snippetBlock);
    } else {
      setMethod(snippet.method);
      setPathInput(snippet.path);
      setBodyText(snippet.body || '');
    }
  };

  const formatConsoleCode = () => {
    try {
      const lines = consoleCode.split('\n');
      const formatted = [];
      let inJson = false;
      let jsonLines = [];

      for (const line of lines) {
        if (line.trim().startsWith('{') || (inJson && !line.trim().match(/^(GET|POST|PUT|DELETE|PATCH|#)/))) {
          inJson = true;
          jsonLines.push(line);
          if (line.trim().endsWith('}') && jsonLines.length > 0) {
            try {
              const obj = JSON.parse(jsonLines.join('\n'));
              formatted.push(JSON.stringify(obj, null, 2));
            } catch (e) {
              formatted.push(...jsonLines);
            }
            jsonLines = [];
            inJson = false;
          }
        } else {
          if (jsonLines.length > 0) {
            formatted.push(...jsonLines);
            jsonLines = [];
            inJson = false;
          }
          formatted.push(line);
        }
      }
      setConsoleCode(formatted.join('\n'));
    } catch (e) {}
  };

  const copyResponse = () => {
    if (!response) return;
    const text = typeof response.data === 'object' ? JSON.stringify(response.data, null, 2) : String(response.data || response.error || '');
    navigator.clipboard.writeText(text);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  const getMethodColor = (m) => {
    switch (m?.toUpperCase()) {
      case 'GET': return '#38bdf8';
      case 'POST': return '#34d399';
      case 'PUT': return '#fbbf24';
      case 'DELETE': return '#f87171';
      case 'PATCH': return '#c084fc';
      default: return currentTheme.textMuted;
    }
  };

  const getStatusColor = (s) => {
    if (!s) return currentTheme.textMuted;
    if (s >= 200 && s < 300) return '#10b981';
    if (s >= 300 && s < 400) return '#3b82f6';
    if (s >= 400 && s < 500) return '#f59e0b';
    return '#ef4444';
  };

  // Render Window Titlebar Control Buttons for each specific OS
  const renderWindowControls = () => {
    if (osTheme === 'mac') {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 4 }}>
          <button 
            type="button"
            onClick={() => setResponse(null)}
            title="Close / Reset"
            style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f56', border: '1px solid #e0443e', cursor: 'pointer', padding: 0, outline: 'none' }}
          />
          <button 
            type="button"
            onClick={() => setIsMinimized(!isMinimized)}
            title="Minimize"
            style={{ width: 12, height: 12, borderRadius: '50%', background: '#ffbd2e', border: '1px solid #dea123', cursor: 'pointer', padding: 0, outline: 'none' }}
          />
          <button 
            type="button"
            onClick={() => setIsMaximized(!isMaximized)}
            title="Zoom / Fullscreen"
            style={{ width: 12, height: 12, borderRadius: '50%', background: '#27c93f', border: '1px solid #1aab29', cursor: 'pointer', padding: 0, outline: 'none' }}
          />
        </div>
      );
    }

    if (osTheme === 'win31') {
      return (
        <div style={{ display: 'flex', gap: 2 }}>
          <button 
            type="button"
            onClick={() => setIsMinimized(!isMinimized)}
            title="Minimize"
            style={{ width: 18, height: 16, background: '#c0c0c0', borderTop: '2px solid #fff', borderLeft: '2px solid #fff', borderRight: '2px solid #000', borderBottom: '2px solid #000', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 'bold', lineHeight: 1 }}
          >
            ▼
          </button>
          <button 
            type="button"
            onClick={() => setIsMaximized(!isMaximized)}
            title="Maximize"
            style={{ width: 18, height: 16, background: '#c0c0c0', borderTop: '2px solid #fff', borderLeft: '2px solid #fff', borderRight: '2px solid #000', borderBottom: '2px solid #000', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 'bold', lineHeight: 1 }}
          >
            ▲
          </button>
        </div>
      );
    }

    if (osTheme === 'win95') {
      return (
        <div style={{ display: 'flex', gap: 2 }}>
          <button 
            type="button"
            onClick={() => setIsMinimized(!isMinimized)}
            style={{ width: 16, height: 14, background: '#c0c0c0', borderTop: '1px solid #fff', borderLeft: '1px solid #fff', borderRight: '1px solid #000', borderBottom: '1px solid #000', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 900, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Minimize"
          >
            _
          </button>
          <button 
            type="button"
            onClick={() => setIsMaximized(!isMaximized)}
            style={{ width: 16, height: 14, background: '#c0c0c0', borderTop: '1px solid #fff', borderLeft: '1px solid #fff', borderRight: '1px solid #000', borderBottom: '1px solid #000', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 900, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Maximize"
          >
            □
          </button>
          <button 
            type="button"
            onClick={() => setResponse(null)}
            style={{ width: 16, height: 14, background: '#c0c0c0', borderTop: '1px solid #fff', borderLeft: '1px solid #fff', borderRight: '1px solid #000', borderBottom: '1px solid #000', cursor: 'pointer', padding: 0, fontSize: 10, fontWeight: 900, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Close"
          >
            ✕
          </button>
        </div>
      );
    }

    if (osTheme === 'winxp') {
      return (
        <div style={{ display: 'flex', gap: 3 }}>
          <button 
            type="button"
            onClick={() => setIsMinimized(!isMinimized)}
            title="Minimize"
            style={{ width: 21, height: 21, borderRadius: 3, background: 'linear-gradient(to bottom, #4282e3 0%, #1f57b5 100%)', border: '1px solid #fff', color: '#fff', fontSize: 12, fontWeight: 900, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            _
          </button>
          <button 
            type="button"
            onClick={() => setIsMaximized(!isMaximized)}
            title="Maximize"
            style={{ width: 21, height: 21, borderRadius: 3, background: 'linear-gradient(to bottom, #4282e3 0%, #1f57b5 100%)', border: '1px solid #fff', color: '#fff', fontSize: 11, fontWeight: 900, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            □
          </button>
          <button 
            type="button"
            onClick={() => setResponse(null)}
            title="Close"
            style={{ width: 21, height: 21, borderRadius: 3, background: 'linear-gradient(to bottom, #e05338 0%, #d03010 45%, #b01000 55%, #c02010 100%)', border: '1px solid #fff', color: '#fff', fontSize: 11, fontWeight: 900, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.4)' }}
          >
            ✕
          </button>
        </div>
      );
    }

    if (osTheme === 'win7') {
      return (
        <div style={{ display: 'flex', gap: 1 }}>
          <button 
            type="button"
            onClick={() => setIsMinimized(!isMinimized)}
            title="Minimize"
            className="win7-title-btn"
            style={{ width: 28, height: 20, background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '0 0 2px 2px', color: '#fff', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            ─
          </button>
          <button 
            type="button"
            onClick={() => setIsMaximized(!isMaximized)}
            title="Maximize"
            className="win7-title-btn"
            style={{ width: 28, height: 20, background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '0 0 2px 2px', color: '#fff', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            □
          </button>
          <button 
            type="button"
            onClick={() => setResponse(null)}
            title="Close"
            className="win7-close-btn"
            style={{ width: 44, height: 20, background: 'linear-gradient(to bottom, rgba(232,17,35,0.7) 0%, rgba(200,10,25,0.9) 100%)', border: '1px solid rgba(255,255,255,0.4)', borderRadius: '0 0 4px 0', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            ✕
          </button>
        </div>
      );
    }

    // Default: Windows 11
    return (
      <div style={{ display: 'flex' }}>
        <button 
          type="button"
          onClick={() => setIsMinimized(!isMinimized)}
          title="Minimize"
          style={{ width: 44, height: 28, background: 'transparent', border: 'none', color: currentTheme.titlebarColor, cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s' }}
          onMouseEnter={e => e.target.style.background = 'rgba(0, 0, 0, 0.07)'}
          onMouseLeave={e => e.target.style.background = 'transparent'}
        >
          ─
        </button>
        <button 
          type="button"
          onClick={() => setIsMaximized(!isMaximized)}
          title="Maximize"
          style={{ width: 44, height: 28, background: 'transparent', border: 'none', color: currentTheme.titlebarColor, cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s' }}
          onMouseEnter={e => e.target.style.background = 'rgba(0, 0, 0, 0.07)'}
          onMouseLeave={e => e.target.style.background = 'transparent'}
        >
          □
        </button>
        <button 
          type="button"
          onClick={() => setResponse(null)}
          title="Close"
          style={{ width: 44, height: 28, background: 'transparent', border: 'none', color: currentTheme.titlebarColor, cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s' }}
          onMouseEnter={e => { e.target.style.background = '#c42b1c'; e.target.style.color = '#ffffff'; }}
          onMouseLeave={e => { e.target.style.background = 'transparent'; e.target.style.color = currentTheme.titlebarColor; }}
        >
          ✕
        </button>
      </div>
    );
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      minHeight: 'calc(100vh - 110px)',
      background: currentTheme.desktopBg,
      fontFamily: currentTheme.fontFamily,
      padding: isMaximized ? 0 : 16,
      position: isMaximized ? 'fixed' : 'relative',
      inset: isMaximized ? 0 : 'auto',
      zIndex: isMaximized ? 9999 : 'auto',
      boxSizing: 'border-box',
      transition: 'background 0.3s ease'
    }}>
      {/* Scoped CSS styling for OS specifics & strict contrast protection */}
      <style>{`
        .win7-title-btn:hover { background: rgba(255,255,255,0.3) !important; }
        .win7-close-btn:hover { background: #e81123 !important; box-shadow: 0 0 12px rgba(232,17,35,0.8); }
        .theme-btn-hover:hover { opacity: 0.9; transform: translateY(-1px); }
        .os-tab-btn { transition: all 0.2s; }
        
        /* 嚴格防範暗色/淺色主題下 select option 出現白底白字 */
        .devtools-window select {
          color-scheme: ${currentTheme.isDark ? 'dark' : 'light'};
        }
        .devtools-window select option,
        .devtools-window select optgroup {
          background-color: ${currentTheme.isDark ? '#0f172a' : '#ffffff'} !important;
          color: ${currentTheme.isDark ? '#f8fafc' : '#111827'} !important;
        }
        .devtools-window input,
        .devtools-window textarea {
          color-scheme: ${currentTheme.isDark ? 'dark' : 'light'};
        }
        .devtools-window input::placeholder,
        .devtools-window textarea::placeholder {
          color: ${currentTheme.textMuted} !important;
          opacity: 0.85;
        }
        .devtools-window input:-webkit-autofill,
        .devtools-window textarea:-webkit-autofill {
          -webkit-text-fill-color: ${currentTheme.inputColor} !important;
          -webkit-box-shadow: 0 0 0px 1000px ${currentTheme.inputBg} inset !important;
          transition: background-color 5000s ease-in-out 0s;
        }
      `}</style>

      {/* Main OS Window Container */}
      <div 
        className="devtools-window"
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          background: currentTheme.windowBg,
          border: currentTheme.windowBorder,
          borderRadius: isMaximized ? 0 : currentTheme.windowRadius,
          boxShadow: isMaximized ? 'none' : currentTheme.windowShadow,
          backdropFilter: currentTheme.windowBackdrop,
          overflow: 'hidden',
          transition: 'all 0.25s ease'
        }}
      >
        
        {/* OS Window Titlebar */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: currentTheme.titlebarBg,
          color: currentTheme.titlebarColor,
          textShadow: currentTheme.titlebarTextShadow,
          padding: osTheme === 'win11' ? '0 0 0 14px' : (osTheme === 'mac' ? '10px 14px' : '4px 8px'),
          height: osTheme === 'win11' ? 32 : (osTheme === 'mac' ? 38 : (osTheme === 'winxp' ? 28 : 26)),
          userSelect: 'none',
          borderBottom: osTheme === 'win31' || osTheme === 'win95' ? '1px solid #808080' : 'none'
        }}>
          {/* Titlebar Left */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {osTheme === 'mac' && renderWindowControls()}

            {osTheme === 'win31' && (
              <div style={{ width: 18, height: 16, background: '#c0c0c0', borderTop: '2px solid #fff', borderLeft: '2px solid #fff', borderRight: '2px solid #000', borderBottom: '2px solid #000', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} title="Control Menu">
                <div style={{ width: 10, height: 2, background: '#000' }} />
              </div>
            )}

            {osTheme !== 'mac' && <span style={{ fontSize: 13 }}>{currentTheme.icon}</span>}
            
            <span style={{ fontSize: osTheme === 'mac' ? 12 : 12, fontWeight: 800, letterSpacing: 0.3 }}>
              SOMP Vanguard DevTools — [API Console]
            </span>

            <span style={{ 
              fontSize: 10, 
              background: currentTheme.badgeBg, 
              color: currentTheme.badgeColor, 
              border: currentTheme.badgeBorder, 
              borderRadius: osTheme === 'win11' || osTheme === 'mac' ? 10 : 3, 
              padding: '1px 6px', 
              fontWeight: 800 
            }}>
              {currentTheme.badge}
            </span>
          </div>

          {/* Titlebar Right */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {osTheme !== 'mac' && renderWindowControls()}
          </div>
        </div>

        {/* Authentic Classic Menu Bar (for Win3.1, Win95, WinXP) */}
        {(osTheme === 'win31' || osTheme === 'win95' || osTheme === 'winxp') && (
          <div style={{
            display: 'flex',
            gap: 16,
            padding: '3px 10px',
            background: osTheme === 'winxp' ? '#ece9d8' : '#c0c0c0',
            borderBottom: osTheme === 'win31' ? '1px solid #000' : '1px solid #808080',
            fontSize: 12,
            color: '#000000',
            userSelect: 'none'
          }}>
            <span style={{ cursor: 'pointer' }}><u>F</u>ile</span>
            <span style={{ cursor: 'pointer' }}><u>E</u>dit</span>
            <span style={{ cursor: 'pointer' }} onClick={() => setShowHistoryModal(true)}><u>H</u>istory</span>
            <span style={{ cursor: 'pointer' }} onClick={formatConsoleCode}><u>P</u>rettify</span>
            <span style={{ cursor: 'pointer' }} onClick={editorMode === 'console' ? executeConsoleSelection : executeVisualRequest}><u>R</u>un (F5)</span>
            <span style={{ cursor: 'pointer' }}><u>H</u>elp</span>
          </div>
        )}

        {!isMinimized && (
          <>
            {/* Top Toolbar: Theme Switcher & Actions */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 18px',
              background: currentTheme.toolbarBg,
              borderBottom: currentTheme.panelBorder,
              flexWrap: 'wrap',
              gap: 12
            }}>
              {/* Left Group: UI Theme Switcher */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ 
                  fontSize: 12, 
                  fontWeight: 800, 
                  color: currentTheme.textColor, 
                  display: 'flex', 
                  alignItems: 'center' 
                }}>
                  UI:
                </label>
                
                <select
                  value={osTheme}
                  onChange={(e) => handleThemeChange(e.target.value)}
                  style={{
                    background: currentTheme.inputBg,
                    color: currentTheme.inputColor,
                    border: currentTheme.inputBorder,
                    borderRadius: currentTheme.controlRadius,
                    padding: '5px 12px',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    outline: 'none',
                    boxShadow: osTheme === 'win7' ? '0 0 10px rgba(56,189,248,0.2)' : 'none'
                  }}
                >
                  <option value="win7" style={{ background: currentTheme.isDark ? '#0f172a' : '#ffffff', color: currentTheme.isDark ? '#f8fafc' : '#111827' }}>4. Windows 7 (預設)</option>
                  <option value="win31" style={{ background: currentTheme.isDark ? '#0f172a' : '#ffffff', color: currentTheme.isDark ? '#f8fafc' : '#111827' }}>1. Windows 3.1</option>
                  <option value="win95" style={{ background: currentTheme.isDark ? '#0f172a' : '#ffffff', color: currentTheme.isDark ? '#f8fafc' : '#111827' }}>2. Windows 95</option>
                  <option value="winxp" style={{ background: currentTheme.isDark ? '#0f172a' : '#ffffff', color: currentTheme.isDark ? '#f8fafc' : '#111827' }}>3. Windows XP</option>
                  <option value="win11" style={{ background: currentTheme.isDark ? '#0f172a' : '#ffffff', color: currentTheme.isDark ? '#f8fafc' : '#111827' }}>5. Windows 11</option>
                  <option value="mac" style={{ background: currentTheme.isDark ? '#0f172a' : '#ffffff', color: currentTheme.isDark ? '#f8fafc' : '#111827' }}>6. MAC (macOS)</option>
                </select>

                {/* Quick Segmented Mode Buttons */}
                <div style={{
                  display: 'flex',
                  background: currentTheme.controlBg,
                  border: currentTheme.controlBorder,
                  borderRadius: osTheme === 'win11' || osTheme === 'mac' ? 20 : currentTheme.controlRadius,
                  padding: 2,
                  marginLeft: 6
                }}>
                  <button
                    type="button"
                    onClick={() => setEditorMode('console')}
                    style={{
                      padding: '4px 12px',
                      fontSize: 11,
                      fontWeight: 800,
                      borderRadius: osTheme === 'win11' || osTheme === 'mac' ? 16 : 2,
                      border: 'none',
                      cursor: 'pointer',
                      background: editorMode === 'console' ? currentTheme.accentColor : 'transparent',
                      color: editorMode === 'console' ? '#ffffff' : currentTheme.textMuted
                    }}
                  >
                    💻 Kibana Console
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditorMode('visual')}
                    style={{
                      padding: '4px 12px',
                      fontSize: 11,
                      fontWeight: 800,
                      borderRadius: osTheme === 'win11' || osTheme === 'mac' ? 16 : 2,
                      border: 'none',
                      cursor: 'pointer',
                      background: editorMode === 'visual' ? currentTheme.accentColor : 'transparent',
                      color: editorMode === 'visual' ? '#ffffff' : currentTheme.textMuted
                    }}
                  >
                    ⚙️ Visual Builder
                  </button>
                </div>
              </div>

              {/* Right Group: Snippets, History, Prettify & Send Button */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                {/* Snippets Cheatsheet */}
                <select
                  onChange={(e) => {
                    const val = e.target.value;
                    if (!val) return;
                    const [catIdx, itemIdx] = val.split('-').map(Number);
                    const snippet = API_SNIPPETS[catIdx]?.items[itemIdx];
                    if (snippet) loadSnippet(snippet);
                    e.target.value = '';
                  }}
                  defaultValue=""
                  style={{
                    background: currentTheme.inputBg,
                    color: currentTheme.inputColor,
                    border: currentTheme.inputBorder,
                    borderRadius: currentTheme.controlRadius,
                    padding: '5px 10px',
                    fontSize: 11,
                    cursor: 'pointer',
                    fontWeight: 600
                  }}
                >
                  <option value="" disabled style={{ background: currentTheme.isDark ? '#0f172a' : '#ffffff', color: currentTheme.isDark ? '#f8fafc' : '#111827' }}>📚 API Snippets (範本速查)</option>
                  {API_SNIPPETS.map((cat, cIdx) => (
                    <optgroup key={cIdx} label={cat.category} style={{ background: currentTheme.isDark ? '#0f172a' : '#ffffff', color: currentTheme.isDark ? '#f8fafc' : '#111827' }}>
                      {cat.items.map((item, iIdx) => (
                        <option key={iIdx} value={`${cIdx}-${iIdx}`} style={{ background: currentTheme.isDark ? '#0f172a' : '#ffffff', color: currentTheme.isDark ? '#f8fafc' : '#111827' }}>
                          [{item.method}] {item.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() => setShowHistoryModal(true)}
                  style={{
                    background: currentTheme.buttonDefaultBg,
                    color: currentTheme.buttonDefaultColor,
                    border: currentTheme.buttonDefaultBorder,
                    borderRadius: currentTheme.controlRadius,
                    padding: '5px 12px',
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer'
                  }}
                  title="檢視歷史請求記錄"
                >
                  ⏳ 歷史 ({history.length})
                </button>

                {editorMode === 'console' && (
                  <button
                    type="button"
                    onClick={formatConsoleCode}
                    style={{
                      background: currentTheme.buttonDefaultBg,
                      color: currentTheme.buttonDefaultColor,
                      border: currentTheme.buttonDefaultBorder,
                      borderRadius: currentTheme.controlRadius,
                      padding: '5px 12px',
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                    title="整理/格式化 JSON 區塊"
                  >
                    🧹 美化 JSON
                  </button>
                )}

                {/* Primary Execute Button */}
                <button
                  type="button"
                  onClick={editorMode === 'console' ? executeConsoleSelection : executeVisualRequest}
                  disabled={loading}
                  style={{
                    background: currentTheme.buttonPrimaryBg,
                    color: '#ffffff',
                    border: currentTheme.buttonPrimaryBorder,
                    borderRadius: currentTheme.controlRadius,
                    boxShadow: currentTheme.buttonPrimaryShadow,
                    padding: '6px 18px',
                    fontWeight: 900,
                    fontSize: 12,
                    cursor: loading ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6
                  }}
                  title="執行目前請求 (快捷鍵: Ctrl + Enter)"
                >
                  {loading ? '⏳ 發送中...' : '▶ 執行 (Ctrl+Enter)'}
                </button>
              </div>
            </div>

            {/* Main Dual-Pane Console Workspace */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', flex: 1, overflow: 'hidden' }}>
              
              {/* LEFT PANEL: Request Editor */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                borderRight: currentTheme.panelBorder,
                background: currentTheme.leftPanelBg,
                color: currentTheme.textColor,
                overflow: 'hidden'
              }}>
                {editorMode === 'console' ? (
                  /* Kibana-Style Code Console */
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 16px',
                      background: currentTheme.headerBg,
                      borderBottom: currentTheme.panelBorder,
                      fontSize: 11,
                      color: currentTheme.textMuted
                    }}>
                      <span>💡 <b>提示:</b> 將游標移至任一 HTTP 區塊，點擊 <b>▶ 執行</b> 或按 <b>Ctrl + Enter</b></span>
                      <span style={{ fontFamily: 'monospace' }}>Target: 127.0.0.1:5000</span>
                    </div>

                    <textarea
                      ref={textareaRef}
                      value={consoleCode}
                      onChange={(e) => setConsoleCode(e.target.value)}
                      spellCheck="false"
                      style={{
                        flex: 1,
                        width: '100%',
                        boxSizing: 'border-box',
                        background: currentTheme.leftPanelBg,
                        color: currentTheme.textColor,
                        border: 'none',
                        outline: 'none',
                        padding: 16,
                        fontSize: 13,
                        fontFamily: osTheme === 'win31' ? "'Courier New', monospace" : "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
                        lineHeight: 1.6,
                        resize: 'none',
                        tabSize: 2
                      }}
                    />
                  </div>
                ) : (
                  /* Visual Request Builder */
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, padding: 16, gap: 14, overflowY: 'auto' }}>
                    {/* Method + Path */}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <select
                        value={method}
                        onChange={(e) => setMethod(e.target.value)}
                        style={{
                          background: currentTheme.inputBg,
                          border: `2px solid ${getMethodColor(method)}`,
                          borderRadius: currentTheme.controlRadius,
                          padding: '8px 12px',
                          color: getMethodColor(method),
                          fontWeight: 900,
                          fontSize: 13,
                          cursor: 'pointer'
                        }}
                      >
                        {['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'].map(m => (
                          <option 
                            key={m} 
                            value={m} 
                            style={{ 
                              background: currentTheme.isDark ? '#0f172a' : '#ffffff', 
                              color: getMethodColor(m), 
                              fontWeight: 800 
                            }}
                          >
                            {m}
                          </option>
                        ))}
                      </select>

                      <input
                        type="text"
                        value={pathInput}
                        onChange={(e) => setPathInput(e.target.value)}
                        placeholder="/api/v1/open/servers or /api/workflow"
                        style={{
                          flex: 1,
                          background: currentTheme.inputBg,
                          border: currentTheme.inputBorder,
                          borderRadius: currentTheme.controlRadius,
                          padding: '8px 12px',
                          color: currentTheme.inputColor,
                          fontSize: 13,
                          fontFamily: 'monospace',
                          fontWeight: 600
                        }}
                      />
                    </div>

                    {/* Query Parameters */}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: currentTheme.textMuted, textTransform: 'uppercase' }}>
                          Query Parameters (?key=value)
                        </span>
                        <button
                          type="button"
                          style={{
                            background: currentTheme.buttonDefaultBg,
                            color: currentTheme.buttonDefaultColor,
                            border: currentTheme.buttonDefaultBorder,
                            borderRadius: currentTheme.controlRadius,
                            padding: '2px 8px',
                            fontSize: 10,
                            fontWeight: 700,
                            cursor: 'pointer'
                          }}
                          onClick={() => setQueryParams([...queryParams, { key: '', value: '' }])}
                        >
                          + 新增 Param
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {queryParams.map((p, idx) => (
                          <div key={idx} style={{ display: 'flex', gap: 6 }}>
                            <input
                              placeholder="Key"
                              value={p.key}
                              onChange={(e) => {
                                const n = [...queryParams]; n[idx].key = e.target.value; setQueryParams(n);
                              }}
                              style={{ flex: 1, background: currentTheme.inputBg, border: currentTheme.inputBorder, borderRadius: currentTheme.controlRadius, padding: '6px 8px', fontSize: 12, color: currentTheme.inputColor, fontFamily: 'monospace' }}
                            />
                            <input
                              placeholder="Value"
                              value={p.value}
                              onChange={(e) => {
                                const n = [...queryParams]; n[idx].value = e.target.value; setQueryParams(n);
                              }}
                              style={{ flex: 1.5, background: currentTheme.inputBg, border: currentTheme.inputBorder, borderRadius: currentTheme.controlRadius, padding: '6px 8px', fontSize: 12, color: currentTheme.inputColor }}
                            />
                            <button
                              type="button"
                              onClick={() => setQueryParams(queryParams.filter((_, i) => i !== idx))}
                              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Request Headers */}
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: currentTheme.textMuted, textTransform: 'uppercase' }}>
                          HTTP Headers
                        </span>
                        <button
                          type="button"
                          style={{
                            background: currentTheme.buttonDefaultBg,
                            color: currentTheme.buttonDefaultColor,
                            border: currentTheme.buttonDefaultBorder,
                            borderRadius: currentTheme.controlRadius,
                            padding: '2px 8px',
                            fontSize: 10,
                            fontWeight: 700,
                            cursor: 'pointer'
                          }}
                          onClick={() => setRequestHeaders([...requestHeaders, { key: '', value: '' }])}
                        >
                          + 新增 Header
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {requestHeaders.map((h, idx) => (
                          <div key={idx} style={{ display: 'flex', gap: 6 }}>
                            <input
                              placeholder="Header (e.g. Authorization)"
                              value={h.key}
                              onChange={(e) => {
                                const n = [...requestHeaders]; n[idx].key = e.target.value; setRequestHeaders(n);
                              }}
                              style={{ flex: 1, background: currentTheme.inputBg, border: currentTheme.inputBorder, borderRadius: currentTheme.controlRadius, padding: '6px 8px', fontSize: 12, color: currentTheme.inputColor, fontFamily: 'monospace' }}
                            />
                            <input
                              placeholder="Value"
                              value={h.value}
                              onChange={(e) => {
                                const n = [...requestHeaders]; n[idx].value = e.target.value; setRequestHeaders(n);
                              }}
                              style={{ flex: 1.5, background: currentTheme.inputBg, border: currentTheme.inputBorder, borderRadius: currentTheme.controlRadius, padding: '6px 8px', fontSize: 12, color: currentTheme.inputColor }}
                            />
                            <button
                              type="button"
                              onClick={() => setRequestHeaders(requestHeaders.filter((_, i) => i !== idx))}
                              style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* JSON Body */}
                    {(method === 'POST' || method === 'PUT' || method === 'PATCH') && (
                      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 180 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 800, color: currentTheme.textMuted, textTransform: 'uppercase' }}>
                            JSON Request Body
                          </span>
                          <button
                            type="button"
                            style={{
                              background: currentTheme.buttonDefaultBg,
                              color: currentTheme.buttonDefaultColor,
                              border: currentTheme.buttonDefaultBorder,
                              borderRadius: currentTheme.controlRadius,
                              padding: '2px 8px',
                              fontSize: 10,
                              fontWeight: 700,
                              cursor: 'pointer'
                            }}
                            onClick={() => {
                              try {
                                if (bodyText) setBodyText(JSON.stringify(JSON.parse(bodyText), null, 2));
                              } catch (e) {}
                            }}
                          >
                            排版 JSON
                          </button>
                        </div>
                        <textarea
                          value={bodyText}
                          onChange={(e) => setBodyText(e.target.value)}
                          placeholder={'{\n  "key": "value"\n}'}
                          style={{
                            flex: 1,
                            background: currentTheme.inputBg,
                            border: currentTheme.inputBorder,
                            borderRadius: currentTheme.controlRadius,
                            padding: 12,
                            color: currentTheme.accentColor,
                            fontSize: 12,
                            fontFamily: 'monospace',
                            lineHeight: 1.5,
                            resize: 'vertical'
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* RIGHT PANEL: Response Inspector */}
              <div style={{ display: 'flex', flexDirection: 'column', background: currentTheme.rightPanelBg, color: currentTheme.textColor, overflow: 'hidden' }}>
                {/* Response Status Bar */}
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 16px',
                  background: currentTheme.headerBg,
                  borderBottom: currentTheme.panelBorder,
                  flexShrink: 0
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: currentTheme.textMuted, textTransform: 'uppercase' }}>回應結果:</span>
                    {response ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          fontSize: 12,
                          fontWeight: 900,
                          padding: '2px 8px',
                          borderRadius: currentTheme.controlRadius,
                          background: `${getStatusColor(response.status)}25`,
                          color: getStatusColor(response.status),
                          border: `1px solid ${getStatusColor(response.status)}`
                        }}>
                          {response.status} {response.statusText || (response.status === 200 ? 'OK' : '')}
                        </span>
                        <span style={{ fontSize: 11, color: currentTheme.textMuted, fontFamily: 'monospace' }}>
                          ⏱️ {response.durationMs}ms
                        </span>
                        {response.sizeBytes > 0 && (
                          <span style={{ fontSize: 11, color: currentTheme.textMuted, fontFamily: 'monospace' }}>
                            📦 {(response.sizeBytes / 1024).toFixed(2)} KB
                          </span>
                        )}
                      </div>
                    ) : (
                      <span style={{ fontSize: 12, color: currentTheme.textMuted, fontStyle: 'italic' }}>
                        {loading ? '正在發送請求至本地後端...' : '尚未有回應，請點擊左側「▶ 執行」按鈕'}
                      </span>
                    )}
                  </div>

                  {/* View Tabs & Copy */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {response && (
                      <>
                        <div style={{ display: 'flex', background: currentTheme.controlBg, borderRadius: currentTheme.controlRadius, border: currentTheme.controlBorder, padding: 2 }}>
                          {['pretty', 'raw', 'headers'].map(tab => (
                            <button
                              key={tab}
                              type="button"
                              onClick={() => setResponseTab(tab)}
                              style={{
                                padding: '2px 8px',
                                fontSize: 10,
                                fontWeight: 700,
                                borderRadius: currentTheme.controlRadius,
                                border: 'none',
                                cursor: 'pointer',
                                background: responseTab === tab ? currentTheme.accentColor : 'transparent',
                                color: responseTab === tab ? '#ffffff' : currentTheme.textMuted,
                                textTransform: 'uppercase'
                              }}
                            >
                              {tab}
                            </button>
                          ))}
                        </div>

                        <button
                          type="button"
                          style={{
                            background: currentTheme.buttonDefaultBg,
                            color: currentTheme.buttonDefaultColor,
                            border: currentTheme.buttonDefaultBorder,
                            borderRadius: currentTheme.controlRadius,
                            padding: '3px 10px',
                            fontSize: 10,
                            cursor: 'pointer'
                          }}
                          onClick={copyResponse}
                        >
                          {copyFeedback ? '✅ 已複製!' : '📋 複製'}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Search Filter Bar */}
                {response && responseTab === 'pretty' && (
                  <div style={{ padding: '6px 16px', background: currentTheme.rightPanelBg, borderBottom: currentTheme.panelBorder }}>
                    <input
                      type="text"
                      placeholder="🔍 過濾回應欄位鍵名或內容..."
                      value={responseSearch}
                      onChange={(e) => setResponseSearch(e.target.value)}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        background: currentTheme.inputBg,
                        border: currentTheme.inputBorder,
                        borderRadius: currentTheme.controlRadius,
                        padding: '4px 8px',
                        fontSize: 11,
                        color: currentTheme.inputColor
                      }}
                    />
                  </div>
                )}

                {/* Response Body Display */}
                <div style={{ flex: 1, overflowY: 'auto', padding: 16, position: 'relative' }}>
                  {loading ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: currentTheme.textMuted }}>
                      <div style={{ fontSize: 28, animation: 'spin 1s linear infinite' }}>⏳</div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>Dispatching request to local backend...</div>
                    </div>
                  ) : response ? (
                    responseTab === 'pretty' ? (
                      <PrettyJsonView 
                        data={response.data !== undefined ? response.data : response} 
                        filter={responseSearch} 
                        isDark={currentTheme.isDark}
                      />
                    ) : responseTab === 'raw' ? (
                      <pre style={{ 
                        margin: 0, 
                        fontSize: 12, 
                        fontFamily: 'monospace', 
                        color: currentTheme.textColor, 
                        whiteSpace: 'pre-wrap', 
                        wordBreak: 'break-word' 
                      }}>
                        {typeof response.data === 'object' ? JSON.stringify(response.data, null, 2) : String(response.data || response.error || '')}
                      </pre>
                    ) : (
                      /* Response Headers Table */
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'monospace' }}>
                        <thead>
                          <tr style={{ borderBottom: currentTheme.panelBorder, color: currentTheme.textMuted }}>
                            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Header Key</th>
                            <th style={{ textAlign: 'left', padding: '6px 8px' }}>Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(response.headers || {}).map(([k, v]) => (
                            <tr key={k} style={{ borderBottom: `1px solid ${currentTheme.isDark ? 'rgba(255,255,255,0.08)' : '#e5e7eb'}` }}>
                              <td style={{ padding: '6px 8px', color: currentTheme.accentColor, fontWeight: 700 }}>{k}</td>
                              <td style={{ padding: '6px 8px', color: currentTheme.textColor, wordBreak: 'break-all' }}>{String(v)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: currentTheme.textMuted }}>
                      <span style={{ fontSize: 36 }}>⚡</span>
                      <span style={{ fontSize: 13 }}>DevTools Console 準備就緒。請在左側輸入或挑選 API 並執行。</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Bottom Status Bar for Classic OS Styles */}
            {(osTheme === 'win31' || osTheme === 'win95' || osTheme === 'winxp') && (
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '3px 10px',
                background: osTheme === 'winxp' ? '#ece9d8' : '#c0c0c0',
                borderTop: osTheme === 'win31' ? '1px solid #000' : '2px groove #ffffff',
                fontSize: 11,
                color: '#000000',
                userSelect: 'none'
              }}>
                <div style={{ display: 'flex', gap: 16 }}>
                  <span>就緒 (Ready)</span>
                  <span>主機: 127.0.0.1:5000</span>
                  <span>模式: {editorMode.toUpperCase()}</span>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <span>風格: {currentTheme.shortName}</span>
                  <span>CAPS</span>
                  <span>NUM</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Query History Modal */}
      {showHistoryModal && (
        <div style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 99999, padding: 20
        }}>
          <div style={{
            background: currentTheme.windowBg,
            border: currentTheme.windowBorder,
            padding: 24,
            borderRadius: currentTheme.windowRadius,
            maxWidth: 640,
            width: '100%',
            maxHeight: '80vh',
            boxShadow: currentTheme.windowShadow,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            color: currentTheme.textColor,
            fontFamily: currentTheme.fontFamily
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: currentTheme.panelBorder, paddingBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 900 }}>⏳ 請求歷史記錄 (History)</h3>
              <button 
                onClick={() => setShowHistoryModal(false)} 
                style={{ background: 'none', border: 'none', color: currentTheme.textMuted, cursor: 'pointer', fontSize: 18 }}
              >
                ✕
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {history.length === 0 ? (
                <div style={{ padding: 30, textAlign: 'center', color: currentTheme.textMuted }}>尚無歷史記錄。</div>
              ) : (
                history.map(item => (
                  <div
                    key={item.id}
                    onClick={() => {
                      if (editorMode === 'console') {
                        const block = `\n${item.method} ${item.path}\n${item.body ? JSON.stringify(item.body, null, 2) + '\n' : ''}`;
                        setConsoleCode(prev => prev.trim() + '\n' + block);
                      } else {
                        setMethod(item.method);
                        setPathInput(item.path);
                        setBodyText(item.body ? JSON.stringify(item.body, null, 2) : '');
                      }
                      setShowHistoryModal(false);
                    }}
                    style={{
                      padding: '10px 14px',
                      background: currentTheme.inputBg,
                      border: currentTheme.inputBorder,
                      borderRadius: currentTheme.controlRadius,
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      transition: 'all 0.2s'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontWeight: 900, fontSize: 11, color: getMethodColor(item.method) }}>{item.method}</span>
                      <span style={{ fontFamily: 'monospace', fontSize: 12, color: currentTheme.textColor }}>{item.path}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: getStatusColor(item.status) }}>{item.status}</span>
                      <span style={{ fontSize: 10, color: currentTheme.textMuted }}>{new Date(item.timestamp).toLocaleTimeString()}</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: currentTheme.panelBorder, paddingTop: 10 }}>
              <button
                type="button"
                style={{
                  background: 'transparent',
                  color: '#ef4444',
                  border: '1px solid #ef4444',
                  borderRadius: currentTheme.controlRadius,
                  padding: '6px 14px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
                onClick={() => { setHistory([]); localStorage.removeItem('vanguard_devtools_history'); }}
              >
                清空歷史記錄
              </button>
              <button 
                type="button"
                style={{
                  background: currentTheme.buttonDefaultBg,
                  color: currentTheme.buttonDefaultColor,
                  border: currentTheme.buttonDefaultBorder,
                  borderRadius: currentTheme.controlRadius,
                  padding: '6px 14px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
                onClick={() => setShowHistoryModal(false)}
              >
                關閉
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Pretty Syntax-Highlighted JSON Viewer Component with Contrast-Safe Dark & Light mode
function PrettyJsonView({ data, filter, isDark = false }) {
  if (data === null || data === undefined) {
    return <div style={{ color: isDark ? '#94a3b8' : '#64748b' }}>null</div>;
  }

  const jsonStr = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
  const lines = jsonStr.split('\n');

  return (
    <pre style={{
      margin: 0,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New', monospace",
      lineHeight: 1.6,
      color: isDark ? '#f1f5f9' : '#111827'
    }}>
      {lines.map((line, i) => {
        const matchesFilter = filter && filter.trim() && line.toLowerCase().includes(filter.toLowerCase());
        return (
          <div
            key={i}
            style={{
              display: 'flex',
              background: matchesFilter ? (isDark ? 'rgba(234, 179, 8, 0.25)' : '#fef08a') : 'transparent',
              borderLeft: matchesFilter ? '3px solid #eab308' : 'none'
            }}
          >
            <span style={{ 
              width: 36, 
              color: isDark ? 'rgba(255,255,255,0.3)' : '#94a3b8', 
              userSelect: 'none', 
              textAlign: 'right', 
              paddingRight: 12, 
              flexShrink: 0 
            }}>
              {i + 1}
            </span>
            <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {highlightJsonSyntax(line, isDark)}
            </span>
          </div>
        );
      })}
    </pre>
  );
}

function highlightJsonSyntax(line, isDark) {
  const keyMatch = line.match(/^(\s*)(".*?")(\s*:\s*)(.*)$/);
  if (keyMatch) {
    const [, indent, key, colon, rest] = keyMatch;
    return (
      <>
        {indent}
        <span style={{ color: isDark ? '#818cf8' : '#005fb8', fontWeight: 700 }}>{key}</span>
        <span style={{ color: isDark ? '#94a3b8' : '#475569' }}>{colon}</span>
        {formatJsonValue(rest, isDark)}
      </>
    );
  }
  return formatJsonValue(line, isDark);
}

function formatJsonValue(val, isDark) {
  const v = val.trim();
  if (v.startsWith('"')) {
    return <span style={{ color: isDark ? '#38bdf8' : '#047857' }}>{val}</span>;
  }
  if (v === 'true' || v === 'false') {
    return <span style={{ color: isDark ? '#34d399' : '#7c3aed', fontWeight: 700 }}>{val}</span>;
  }
  if (v === 'null') {
    return <span style={{ color: isDark ? '#f87171' : '#b91c1c', fontWeight: 700 }}>{val}</span>;
  }
  if (!isNaN(Number(v.replace(',', '')))) {
    return <span style={{ color: isDark ? '#fbbf24' : '#b45309' }}>{val}</span>;
  }
  return <span style={{ color: isDark ? '#f1f5f9' : '#111827' }}>{val}</span>;
}
