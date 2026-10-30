import React, { useState, useEffect, useRef, useCallback } from 'react';
import Guacamole from 'guacamole-common-js';
import api from '../../api';

// 6 Authentic OS Themes Specification (Deeply Aligned with DevTools.jsx)
const THEMES = {
  win7: {
    id: 'win7',
    name: 'Win 7',
    badge: 'Aero Glass',
    icon: 'Win',
    isDark: true,
    fontFamily: "'Segoe UI', -apple-system, sans-serif",
    windowBg: 'rgba(15, 23, 42, 0.94)',
    windowBorder: '1px solid rgba(255, 255, 255, 0.45)',
    windowShadow: '0 25px 60px rgba(0, 0, 0, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.85)',
    windowRadius: '8px 8px 6px 6px',
    windowBackdrop: 'blur(25px) saturate(180%)',
    titlebarBg: 'linear-gradient(to bottom, rgba(255,255,255,0.45) 0%, rgba(255,255,255,0.15) 35%, rgba(0,0,0,0.1) 100%)',
    titlebarColor: '#ffffff',
    titlebarTextShadow: '0 0 10px rgba(255,255,255,0.8), 0 0 3px rgba(0,0,0,0.8)',
    toolbarBg: 'rgba(15, 23, 42, 0.95)',
    textColor: '#f1f5f9',
    textMuted: '#94a3b8',
    panelBg: '#050811',
    accentColor: '#38bdf8',
    controlCloseBg: '#ef4444',
    btnBg: 'linear-gradient(to bottom, rgba(255,255,255,0.18) 0%, rgba(0,0,0,0.3) 100%)',
    btnBorder: '1px solid rgba(255,255,255,0.35)',
    btnColor: '#ffffff'
  },
  win31: {
    id: 'win31',
    name: 'Win 3.1',
    badge: '16-bit Classic',
    icon: 'Win',
    isDark: false,
    fontFamily: "'Courier New', 'Fixedsys', 'MS Sans Serif', monospace",
    windowBg: '#c0c0c0',
    windowBorder: '3px solid #000000',
    windowShadow: '8px 8px 0px rgba(0, 0, 0, 0.75)',
    windowRadius: '0px',
    windowBackdrop: 'none',
    titlebarBg: '#000080',
    titlebarColor: '#ffffff',
    titlebarTextShadow: 'none',
    toolbarBg: '#c0c0c0',
    textColor: '#000000',
    textMuted: '#333333',
    panelBg: '#000000',
    accentColor: '#000080',
    controlCloseBg: '#c0c0c0',
    btnBg: '#c0c0c0',
    btnBorder: '2px solid #000000',
    btnColor: '#000000'
  },
  win95: {
    id: 'win95',
    name: 'Win 95',
    badge: '32-bit Classic',
    icon: 'Win',
    isDark: false,
    fontFamily: "'Tahoma', 'MS Sans Serif', Arial, sans-serif",
    windowBg: '#c0c0c0',
    windowBorder: '2px outset #ffffff',
    windowShadow: '4px 4px 12px rgba(0, 0, 0, 0.6)',
    windowRadius: '0px',
    windowBackdrop: 'none',
    titlebarBg: 'linear-gradient(90deg, #000080 0%, #1084d0 100%)',
    titlebarColor: '#ffffff',
    titlebarTextShadow: 'none',
    toolbarBg: '#c0c0c0',
    textColor: '#000000',
    textMuted: '#555555',
    panelBg: '#000000',
    accentColor: '#000080',
    controlCloseBg: '#c0c0c0',
    btnBg: '#c0c0c0',
    btnBorder: '2px outset #ffffff',
    btnColor: '#000000'
  },
  winxp: {
    id: 'winxp',
    name: 'Win XP',
    badge: 'Luna Blue',
    icon: 'Win',
    isDark: false,
    fontFamily: "'Tahoma', 'Trebuchet MS', Arial, sans-serif",
    windowBg: '#ece9d8',
    windowBorder: '3px solid #0055ea',
    windowShadow: '0 16px 40px rgba(0, 0, 0, 0.55)',
    windowRadius: '8px 8px 0 0',
    windowBackdrop: 'none',
    titlebarBg: 'linear-gradient(to bottom, #0058ee 0%, #3593ff 5%, #036ffc 14%, #0057e5 60%, #004dd0 100%)',
    titlebarColor: '#ffffff',
    titlebarTextShadow: '1px 1px 2px #002e88',
    toolbarBg: '#f2f0e6',
    textColor: '#000000',
    textMuted: '#555555',
    panelBg: '#0c1017',
    accentColor: '#0055ea',
    controlCloseBg: '#e04343',
    btnBg: 'linear-gradient(to bottom, #ffffff 0%, #ece9d8 100%)',
    btnBorder: '1px solid #7f9db9',
    btnColor: '#000000'
  },
  win11: {
    id: 'win11',
    name: 'Win 11',
    badge: 'Mica Fluent',
    icon: 'Win',
    isDark: true,
    fontFamily: "'Segoe UI Variable', 'Segoe UI', sans-serif",
    windowBg: 'rgba(32, 32, 32, 0.94)',
    windowBorder: '1px solid rgba(255, 255, 255, 0.14)',
    windowShadow: '0 30px 70px rgba(0, 0, 0, 0.75)',
    windowRadius: '10px',
    windowBackdrop: 'blur(40px)',
    titlebarBg: 'rgba(32, 32, 32, 0.96)',
    titlebarColor: '#ffffff',
    titlebarTextShadow: 'none',
    toolbarBg: 'rgba(40, 40, 40, 0.95)',
    textColor: '#ffffff',
    textMuted: '#a0a0a0',
    panelBg: '#000000',
    accentColor: '#60cdff',
    controlCloseBg: '#c42b1c',
    btnBg: 'rgba(255, 255, 255, 0.08)',
    btnBorder: '1px solid rgba(255, 255, 255, 0.12)',
    btnColor: '#ffffff'
  },
  mac: {
    id: 'mac',
    name: 'macOS',
    badge: 'Aqua / Metal',
    icon: 'Mac',
    isDark: true,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
    windowBg: 'rgba(30, 30, 30, 0.95)',
    windowBorder: '1px solid rgba(255, 255, 255, 0.18)',
    windowShadow: '0 25px 65px rgba(0, 0, 0, 0.65)',
    windowRadius: '12px',
    windowBackdrop: 'blur(35px)',
    titlebarBg: 'rgba(40, 40, 40, 0.92)',
    titlebarColor: '#f5f5f7',
    titlebarTextShadow: 'none',
    toolbarBg: '#252526',
    textColor: '#f5f5f7',
    textMuted: '#a1a1aa',
    panelBg: '#000000',
    accentColor: '#0a84ff',
    controlCloseBg: '#ff5f56',
    btnBg: 'rgba(255, 255, 255, 0.12)',
    btnBorder: '1px solid rgba(255, 255, 255, 0.2)',
    btnColor: '#f5f5f7'
  }
};

export default function WebRemoteModal({ isOpen, onClose, target, initialTheme = 'win7' }) {
  // Session User: Default to logged-in somp-vanguard AD user
  const sessionUser = JSON.parse(localStorage.getItem('user') || '{}');
  const defaultLoginUser = sessionUser.username || 'Administrator';

  const [currentThemeId, setCurrentThemeId] = useState(initialTheme);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // 'connecting' | 'connected' | 'error' | 'disconnected'
  const [statusMessage, setStatusMessage] = useState('Initializing Guacamole tunnel...');
  const [displayMode, setDisplayMode] = useState('fit'); // 'fit' | '1:1' | 'fullscreen'
  const [showClipboard, setShowClipboard] = useState(false);
  const [clipboardText, setClipboardText] = useState('');
  const [tokenError, setTokenError] = useState(null);
  const [hideLocalCursor, setHideLocalCursor] = useState(false);

  const theme = THEMES[currentThemeId] || THEMES.win7;
  const targetIp = target?.ip || '';
  const targetName = target?.name || targetIp;
  const isWindows = (target?.os || '').toLowerCase() === 'windows' || (target?.protocol || '').toLowerCase() === 'rdp';
  const protocol = isWindows ? 'rdp' : 'ssh';

  // Credential Settings Panel
  // Requirement: Windows uses AD login user by default; SSH keeps username and password blank for user to fill
  const [showCredPanel, setShowCredPanel] = useState(true);
  const [authUsername, setAuthUsername] = useState(isWindows ? defaultLoginUser : '');
  const [authPassword, setAuthPassword] = useState('');
  const [authDomain, setAuthDomain] = useState(sessionUser.domain || '');
  const [nlaSecurity, setNlaSecurity] = useState('any'); // 'any', 'nla', 'tls', 'rdp'
  const [activeUserDisplay, setActiveUserDisplay] = useState(isWindows ? defaultLoginUser : '');

  // Draggable & Resizable Window State
  const [windowSize, setWindowSize] = useState({ width: 1280, height: 820 });
  const [windowPos, setWindowPos] = useState({ x: null, y: null });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartRef = useRef({ mouseX: 0, mouseY: 0, posX: 0, posY: 0 });
  const resizeStartRef = useRef({ mouseX: 0, mouseY: 0, width: 0, height: 0, posX: 0, posY: 0, dir: '' });

  const modalRef = useRef(null);
  const viewportRef = useRef(null);
  const displayContainerRef = useRef(null);
  const clientRef = useRef(null);
  const tunnelRef = useRef(null);
  const keyboardRef = useRef(null);
  const mouseRef = useRef(null);

  // Initialize centered window position and dimensions on open
  useEffect(() => {
    if (isOpen) {
      const initW = Math.min(1360, Math.max(760, window.innerWidth - 80));
      const initH = Math.min(880, Math.max(540, window.innerHeight - 80));
      setWindowSize({ width: initW, height: initH });
      setWindowPos({
        x: Math.max(20, Math.round((window.innerWidth - initW) / 2)),
        y: Math.max(20, Math.round((window.innerHeight - initH) / 2))
      });
    }
  }, [isOpen]);

  // Dragging handler
  const handleTitleMouseDown = (e) => {
    if (e.button !== 0 || displayMode === 'fullscreen') return;
    const tag = e.target.tagName;
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'INPUT' || tag === 'OPTION') return;

    e.preventDefault();
    const currentX = windowPos.x ?? Math.max(20, Math.round((window.innerWidth - windowSize.width) / 2));
    const currentY = windowPos.y ?? Math.max(20, Math.round((window.innerHeight - windowSize.height) / 2));
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      posX: currentX,
      posY: currentY
    };
    setIsDragging(true);
  };

  // Resizing handler
  const handleResizeMouseDown = (e, dir) => {
    if (e.button !== 0 || displayMode === 'fullscreen') return;
    e.preventDefault();
    e.stopPropagation();

    const currentX = windowPos.x ?? Math.max(20, Math.round((window.innerWidth - windowSize.width) / 2));
    const currentY = windowPos.y ?? Math.max(20, Math.round((window.innerHeight - windowSize.height) / 2));
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      width: windowSize.width,
      height: windowSize.height,
      posX: currentX,
      posY: currentY,
      dir
    };
    setIsResizing(true);
  };

  // Drag & Resize Mousemove & Mouseup listener
  useEffect(() => {
    if (!isDragging && !isResizing) return;

    const handleMouseMove = (e) => {
      if (isDragging) {
        const dx = e.clientX - dragStartRef.current.mouseX;
        const dy = e.clientY - dragStartRef.current.mouseY;
        const newX = Math.max(-windowSize.width + 150, Math.min(window.innerWidth - 100, dragStartRef.current.posX + dx));
        const newY = Math.max(0, Math.min(window.innerHeight - 50, dragStartRef.current.posY + dy));
        setWindowPos({ x: newX, y: newY });
      } else if (isResizing) {
        const { mouseX, mouseY, width, height, posX, posY, dir } = resizeStartRef.current;
        const dx = e.clientX - mouseX;
        const dy = e.clientY - mouseY;

        let newW = width;
        let newH = height;
        let newX = posX;
        let newY = posY;

        if (dir.includes('e')) {
          newW = Math.max(640, Math.min(window.innerWidth, width + dx));
        }
        if (dir.includes('s')) {
          newH = Math.max(480, Math.min(window.innerHeight, height + dy));
        }
        if (dir.includes('w')) {
          const possibleW = Math.max(640, Math.min(window.innerWidth, width - dx));
          newX = posX + (width - possibleW);
          newW = possibleW;
        }
        if (dir.includes('n')) {
          const possibleH = Math.max(480, Math.min(window.innerHeight, height - dy));
          newY = posY + (height - possibleH);
          newH = possibleH;
        }

        setWindowSize({ width: newW, height: newH });
        setWindowPos({ x: newX, y: newY });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, isResizing, windowSize]);

  // Connect to Guacamole Gateway
  const connectSession = useCallback(async (customUser = authUsername, customPwd = authPassword, customDomain = authDomain) => {
    if (!targetIp) return;

    // For SSH, if user has not entered username yet, guide them to fill in credentials
    const finalUser = isWindows ? (customUser || defaultLoginUser) : (customUser || '');
    if (!isWindows && !finalUser.trim()) {
      setConnectionStatus('disconnected');
      setStatusMessage(`[Web-SSH] 請在上方「帳號憑證設定」輸入 Linux 登入帳號與密碼後點擊「開始連線」`);
      setShowCredPanel(true);
      return;
    }
    // Web RDP: the password is always typed in (the server never fills in stored credentials)
    if (isWindows && !(customPwd && customPwd.trim())) {
      setConnectionStatus('disconnected');
      setStatusMessage(`[Web-RDP] 請輸入 ${finalUser} 的 Windows 密碼後點擊「開始連線」`);
      setShowCredPanel(true);
      return;
    }

    // Disconnect existing if any
    if (clientRef.current) {
      try { clientRef.current.disconnect(); } catch (e) {}
      clientRef.current = null;
    }
    if (displayContainerRef.current) {
      displayContainerRef.current.innerHTML = '';
    }

    setConnectionStatus('connecting');
    const displayAccount = isWindows && customDomain ? `${customDomain}\\${finalUser}` : finalUser;
    setStatusMessage(`Requesting Guacamole token for ${targetIp} (${protocol.toUpperCase()}) as [${displayAccount || 'Prompt'}]...`);
    setTokenError(null);

    try {
      // 1. Issue authentic connection token from backend
      const res = await api.post('/remote/token', {
        ip: targetIp,
        name: targetName,
        os: isWindows ? 'windows' : 'linux',
        protocol: protocol,
        username: finalUser,
        password: customPwd || '',
        domain: isWindows ? (customDomain || '') : undefined,
        security: nlaSecurity
      });

      const { token, effectiveUser } = res.data;
      setActiveUserDisplay(effectiveUser || finalUser || 'Remote User');

      // 2. Build WebSocket Tunnel Url (pass base path without query parameters)
      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const tunnelPath = `${wsProto}//${window.location.host}/guacamole`;

      // 3. Initialize Guacamole Client
      const tunnel = new Guacamole.WebSocketTunnel(tunnelPath);
      const client = new Guacamole.Client(tunnel);

      tunnelRef.current = tunnel;
      clientRef.current = client;

      // Tunnel-level error listener
      tunnel.onerror = (status) => {
        console.error('[Guacamole Tunnel Error]', status);
        setConnectionStatus('error');
        const code = status?.code;
        const msg = status?.message || `Tunnel connection failed (code: ${code || 'NETWORK_ERROR'})`;
        setTokenError(msg);
        setStatusMessage(`WebSocket Tunnel Error: ${msg}`);
      };

      tunnel.onstatechange = (state) => {
        // Guacamole.Tunnel.State: 0=CONNECTING, 1=OPEN, 2=CLOSED
        if (state === 2 && !hasEverConnected) {
          console.warn('[Guacamole Tunnel] WebSocket tunnel closed before session was established.');
        }
      };

      // 4. Attach Display Element to DOM
      const clientDisplay = client.getDisplay();
      const display = clientDisplay.getElement();
      display.style.cursor = hideLocalCursor ? 'none' : 'default';
      display.style.outline = 'none';
      if (displayContainerRef.current) {
        displayContainerRef.current.innerHTML = '';
        displayContainerRef.current.appendChild(display);
      }

      // Handle remote screen resolution changes dynamically to keep mouse in sync
      clientDisplay.onresize = () => {
        updateDisplayScale();
      };

      // 5. Mount Mouse Handler
      const mouse = new Guacamole.Mouse(display);
      mouseRef.current = mouse;
      mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (mouseState) => {
        if (clientRef.current) {
          clientRef.current.sendMouseState(mouseState);
        }
      };

      // 6. Mount Keyboard Handler (Prevent intercepting keys when user types in inputs)
      const keyboard = new Guacamole.Keyboard(document);
      keyboardRef.current = keyboard;
      keyboard.onkeydown = (keysym) => {
        const active = document.activeElement;
        const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
        if (isTyping || !clientRef.current) {
          return true; // Allow browser default handling for form inputs & shortcuts!
        }
        clientRef.current.sendKeyEvent(1, keysym);
        return false;
      };
      keyboard.onkeyup = (keysym) => {
        const active = document.activeElement;
        const isTyping = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
        if (isTyping || !clientRef.current) {
          return;
        }
        clientRef.current.sendKeyEvent(0, keysym);
      };

      // 7. Handle Client State Changes
      // 0: IDLE, 1: CONNECTING, 2: WAITING, 3: CONNECTED, 4: DISCONNECTING, 5: DISCONNECTED
      let hasEverConnected = false;
      client.onstatechange = (state) => {
        if (state === 1 || state === 2) {
          setConnectionStatus('connecting');
          setStatusMessage(`Handshaking with guacd (${protocol.toUpperCase()}: ${protocol === 'rdp' ? 3389 : 22})...`);
        } else if (state === 3) {
          hasEverConnected = true;
          setConnectionStatus('connected');
          setStatusMessage(`Active Guacamole Session. User: [${effectiveUser}] | Protocol: ${protocol.toUpperCase()}`);
        } else if (state === 5) {
          setConnectionStatus('disconnected');
          if (!hasEverConnected) {
            setStatusMessage('無法建立連線 (直接中斷)。請檢查後端日誌或確認 GUACD_HOST 是否為 127.0.0.1 以及 Docker guacd 容器運作狀況。');
          } else {
            setStatusMessage('Remote session disconnected.');
          }
        }
      };

      // 8. Handle Error Events
      client.onerror = (status) => {
        console.error('[Guacamole Client Error]', status);
        setConnectionStatus('error');
        const code = status.code;
        let errMsg = status.message || `Guacamole error (code: ${code})`;
        if (code === 514 || code === 515) errMsg = 'Authentication failed: Invalid username or password.';
        else if (code === 518) errMsg = 'Target server unreachable or port closed.';
        else if (code === 520) errMsg = 'Connection timed out waiting for guacd daemon.';
        setTokenError(errMsg);
        setStatusMessage(`Connection Error: ${errMsg}`);
      };

      // 9. Bi-directional Clipboard Bridge (Receive from remote)
      client.onclipboard = (stream, mimetype) => {
        if (/^text\//.test(mimetype)) {
          const reader = new Guacamole.StringReader(stream);
          let received = '';
          reader.ontext = (chunk) => { received += chunk; };
          reader.onend = () => {
            setClipboardText(received);
            setStatusMessage(`Received ${received.length} chars from remote clipboard.`);
            setTimeout(() => {
              if (clientRef.current) setStatusMessage(`Connected to ${targetName}`);
            }, 2500);
          };
        }
      };

      // Connect with token parameter (Guacamole.Client formats tunnelURL + "?" + data)
      client.connect(`token=${encodeURIComponent(token)}`);

    } catch (err) {
      console.error('[WebRemote] Connection failed:', err);
      const errMsg = err.response?.data?.error || err.message || 'Failed to establish Guacamole session';
      setTokenError(errMsg);
      setConnectionStatus('error');
      setStatusMessage(`Error: ${errMsg}`);
    }
  }, [targetIp, targetName, isWindows, protocol, authUsername, authPassword, nlaSecurity, defaultLoginUser]);

  // Initiate on Open
  useEffect(() => {
    if (!isOpen || !targetIp) return;

    const currentSessionUser = JSON.parse(localStorage.getItem('user') || '{}');
    const adUser = currentSessionUser.username || defaultLoginUser;
    const adDomain = currentSessionUser.domain || '';

    if (isWindows) {
      // Windows / RDP: Default to logged-in somp-vanguard AD user and domain
      setAuthUsername(adUser);
      setAuthDomain(adDomain);
      // If user has already entered a password (e.g. from previous connect attempt in session), auto-connect
      if (authPassword && authPassword.trim()) {
        setShowCredPanel(false);
        connectSession(adUser, authPassword, adDomain);
      } else {
        // Show credential settings panel so user can enter Windows password and check domain
        setShowCredPanel(true);
        setConnectionStatus('disconnected');
        setStatusMessage(`[Web-RDP] 請確認登入帳號 (${adDomain ? `${adDomain}\\${adUser}` : adUser}) 並輸入密碼後點擊「開始連線」`);
      }
    } else {
      // Linux / SSH: Keep username & password BLANK, let user fill them in
      setAuthUsername('');
      setAuthPassword('');
      setShowCredPanel(true);
      setConnectionStatus('disconnected');
      setStatusMessage(`[Web-SSH] 請在上方「帳號憑證設定」輸入 Linux 登入帳號與密碼後點擊「開始連線」`);
    }

    return () => {
      // Cleanup on unmount or close
      if (keyboardRef.current) {
        keyboardRef.current.reset();
      }
      if (clientRef.current) {
        try { clientRef.current.disconnect(); } catch (e) {}
        clientRef.current = null;
      }
    };
  }, [isOpen, targetIp, isWindows]);

  // Recalculate display scale to ensure mouse coordinate mapping is 100% accurate
  const updateDisplayScale = useCallback(() => {
    if (!clientRef.current || !viewportRef.current) return;
    const clientDisplay = clientRef.current.getDisplay();
    if (!clientDisplay) return;

    if (displayMode === 'fit') {
      const containerW = viewportRef.current.clientWidth || 1024;
      const containerH = viewportRef.current.clientHeight || 768;
      const dispW = clientDisplay.getWidth() || 1024;
      const dispH = clientDisplay.getHeight() || 768;
      if (dispW > 0 && dispH > 0 && containerW > 0 && containerH > 0) {
        const scale = Math.min(containerW / dispW, containerH / dispH);
        clientDisplay.scale(scale);
      }
    } else {
      clientDisplay.scale(1.0);
    }
  }, [displayMode]);

  // Adjust display scale based on displayMode and windowSize
  useEffect(() => {
    if (!clientRef.current || connectionStatus !== 'connected') return;
    updateDisplayScale();
  }, [displayMode, connectionStatus, windowSize, updateDisplayScale]);

  // Dynamic ResizeObserver on viewport to handle panel open/close & container changes immediately
  useEffect(() => {
    if (!viewportRef.current) return;
    const observer = new ResizeObserver(() => {
      updateDisplayScale();
    });
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [updateDisplayScale]);

  // Toggle hide local cursor
  const toggleHideLocalCursor = () => {
    setHideLocalCursor(prev => {
      const next = !prev;
      if (clientRef.current) {
        const d = clientRef.current.getDisplay()?.getElement();
        if (d) d.style.cursor = next ? 'none' : 'default';
      }
      return next;
    });
  };

  // Logout current session (Graceful termination, clear credentials, and open login prompt)
  const handleLogout = () => {
    // 1. If SSH, send exit command to gracefully terminate remote shell
    if (clientRef.current && !isWindows) {
      try {
        const exitCmd = 'exit\n';
        for (let i = 0; i < exitCmd.length; i++) {
          const code = exitCmd.charCodeAt(i);
          clientRef.current.sendKeyEvent(1, code);
          clientRef.current.sendKeyEvent(0, code);
        }
      } catch (_) {}
    }

    // 2. Disconnect Guacamole client
    if (clientRef.current) {
      try { clientRef.current.disconnect(); } catch (_) {}
      clientRef.current = null;
    }

    // 3. Clear credentials & reset session state
    setAuthPassword('');
    setConnectionStatus('disconnected');
    setStatusMessage('已登出遠端工作階段 (Session Logged Out)。若需切換帳號或重新連線，請輸入帳密。');
    setShowCredPanel(true);
  };

  // Send local clipboard text to remote host
  const sendClipboardToRemote = () => {
    if (!clientRef.current || !clipboardText) return;
    try {
      const stream = clientRef.current.createClipboardStream('text/plain');
      const writer = new Guacamole.StringWriter(stream);
      writer.sendText(clipboardText);
      writer.sendEnd();
      setStatusMessage(`Sent ${clipboardText.length} characters to remote clipboard.`);
      setTimeout(() => setStatusMessage(`Connected to ${targetName}`), 2000);
    } catch (e) {
      console.error('[Clipboard Error]', e);
    }
  };

  // Keyboard shortcut injector (Keysyms in Guacamole)
  const injectKey = (keyName) => {
    if (!clientRef.current || connectionStatus !== 'connected') return;

    if (keyName === 'Ctrl+Alt+Del') {
      // 0xFFE3 = Left Control, 0xFFE9 = Left Alt, 0xFFFF = Delete
      clientRef.current.sendKeyEvent(1, 0xFFE3);
      clientRef.current.sendKeyEvent(1, 0xFFE9);
      clientRef.current.sendKeyEvent(1, 0xFFFF);
      setTimeout(() => {
        if (clientRef.current) {
          clientRef.current.sendKeyEvent(0, 0xFFFF);
          clientRef.current.sendKeyEvent(0, 0xFFE9);
          clientRef.current.sendKeyEvent(0, 0xFFE3);
        }
      }, 100);
      setStatusMessage('Injected [Ctrl + Alt + Del] privilege interrupt.');
    } else if (keyName === 'Ctrl+Alt+End') {
      // 0xFFE3 = Left Control, 0xFFE9 = Left Alt, 0xFF57 = End (Windows RDP Security / Sign Out menu)
      clientRef.current.sendKeyEvent(1, 0xFFE3);
      clientRef.current.sendKeyEvent(1, 0xFFE9);
      clientRef.current.sendKeyEvent(1, 0xFF57);
      setTimeout(() => {
        if (clientRef.current) {
          clientRef.current.sendKeyEvent(0, 0xFF57);
          clientRef.current.sendKeyEvent(0, 0xFFE9);
          clientRef.current.sendKeyEvent(0, 0xFFE3);
        }
      }, 100);
      setStatusMessage('Injected [Ctrl + Alt + End] (Windows RDP 遠端安全選單 / 登出 Sign Out)');
    } else if (keyName === 'Win') {
      // 0xFFEB = Left Super (Windows Key)
      clientRef.current.sendKeyEvent(1, 0xFFEB);
      setTimeout(() => {
        if (clientRef.current) clientRef.current.sendKeyEvent(0, 0xFFEB);
      }, 100);
      setStatusMessage('Injected [Windows Key] start menu toggle.');
    } else if (keyName === 'Alt+Tab') {
      // 0xFFE9 = Left Alt, 0xFF09 = Tab
      clientRef.current.sendKeyEvent(1, 0xFFE9);
      clientRef.current.sendKeyEvent(1, 0xFF09);
      setTimeout(() => {
        if (clientRef.current) {
          clientRef.current.sendKeyEvent(0, 0xFF09);
          clientRef.current.sendKeyEvent(0, 0xFFE9);
        }
      }, 100);
      setStatusMessage('Injected [Alt + Tab] window switcher.');
    } else if (keyName === 'Esc') {
      clientRef.current.sendKeyEvent(1, 0xFF1B);
      setTimeout(() => {
        if (clientRef.current) clientRef.current.sendKeyEvent(0, 0xFF1B);
      }, 100);
      setStatusMessage('Injected [Escape] key.');
    }

    setTimeout(() => {
      if (clientRef.current) setStatusMessage(`Connected to ${targetName}`);
    }, 2500);
  };

  // Toggle Fullscreen
  const toggleFullscreen = () => {
    if (!modalRef.current) return;
    if (!document.fullscreenElement) {
      modalRef.current.requestFullscreen().catch(() => {});
      setDisplayMode('fullscreen');
    } else {
      document.exitFullscreen().catch(() => {});
      setDisplayMode('fit');
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: displayMode === 'fullscreen' ? 'transparent' : 'rgba(0, 0, 0, 0.75)',
        backdropFilter: displayMode === 'fullscreen' ? 'none' : 'blur(8px)',
        zIndex: 2000,
        overflow: 'hidden'
      }}
      onClick={displayMode === 'fullscreen' ? undefined : onClose}
    >
      <div
        ref={modalRef}
        style={{
          position: displayMode === 'fullscreen' ? 'fixed' : 'absolute',
          top: displayMode === 'fullscreen' ? 0 : (windowPos.y ?? 40),
          left: displayMode === 'fullscreen' ? 0 : (windowPos.x ?? 40),
          width: displayMode === 'fullscreen' ? '100vw' : windowSize.width,
          height: displayMode === 'fullscreen' ? '100vh' : windowSize.height,
          background: theme.windowBg,
          border: displayMode === 'fullscreen' ? 'none' : theme.windowBorder,
          boxShadow: displayMode === 'fullscreen' ? 'none' : theme.windowShadow,
          borderRadius: displayMode === 'fullscreen' ? 0 : theme.windowRadius,
          backdropFilter: theme.windowBackdrop,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: theme.fontFamily,
          color: theme.textColor,
          userSelect: isDragging || isResizing ? 'none' : 'auto',
          transition: isDragging || isResizing ? 'none' : 'box-shadow 0.2s ease'
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Window Titlebar (Draggable & Double-click to Maximize) */}
        <div
          onMouseDown={handleTitleMouseDown}
          onDoubleClick={() => setDisplayMode(prev => prev === 'fullscreen' ? 'fit' : 'fullscreen')}
          style={{
            height: 42,
            background: theme.titlebarBg,
            color: theme.titlebarColor,
            textShadow: theme.titlebarTextShadow,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 14px',
            userSelect: 'none',
            flexShrink: 0,
            borderBottom: '1px solid rgba(255, 255, 255, 0.15)',
            cursor: displayMode === 'fullscreen' ? 'default' : (isDragging ? 'grabbing' : 'grab'),
            gap: 12,
            whiteSpace: 'nowrap',
            overflow: 'hidden'
          }}
          title={displayMode === 'fullscreen' ? '' : '按住標題列可自由拖曳移動視窗，按兩下可最大化/還原'}
        >
          {/* Left: Host Title & Badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexShrink: 1, overflow: 'hidden' }}>
            {currentThemeId === 'mac' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginRight: 8, flexShrink: 0 }}>
                <button
                  onClick={onClose}
                  title="Close Session"
                  style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f56', border: 'none', cursor: 'pointer', padding: 0 }}
                />
                <button
                  onClick={() => setDisplayMode(prev => prev === 'fit' ? '1:1' : 'fit')}
                  title="Toggle Fit"
                  style={{ width: 12, height: 12, borderRadius: '50%', background: '#ffbd2e', border: 'none', cursor: 'pointer', padding: 0 }}
                />
                <button
                  onClick={toggleFullscreen}
                  title="Fullscreen"
                  style={{ width: 12, height: 12, borderRadius: '50%', background: '#27c93f', border: 'none', cursor: 'pointer', padding: 0 }}
                />
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1, overflow: 'hidden' }}>
              <span style={{ fontWeight: 800, fontSize: 13, letterSpacing: '0.02em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {targetName} ({targetIp}) - Guacamole Clientless Gateway
              </span>
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 12,
                  fontSize: 10,
                  fontWeight: 900,
                  background: isWindows ? 'rgba(59, 130, 246, 0.25)' : 'rgba(34, 197, 94, 0.25)',
                  color: isWindows ? '#60a5fa' : '#4ade80',
                  border: `1px solid ${isWindows ? '#3b82f6' : '#22c55e'}`,
                  flexShrink: 0,
                  whiteSpace: 'nowrap'
                }}
              >
                {isWindows ? 'Windows(RDP:3389)' : 'Linux(SSH:22)'}
              </span>
              {/* Effective AD User Indicator */}
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 12,
                  fontSize: 10,
                  fontWeight: 700,
                  background: 'rgba(99, 102, 241, 0.25)',
                  color: '#a5b4fc',
                  border: '1px solid rgba(99, 102, 241, 0.4)',
                  flexShrink: 0,
                  whiteSpace: 'nowrap'
                }}
                title="目前連線身份 (預設為登入 somp-vanguard 的 AD 帳號)"
              >
                👤 {activeUserDisplay}
              </span>
            </div>
          </div>

          {/* Center: UI Theme Selector Dropdown */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'rgba(0, 0, 0, 0.28)',
              padding: '2px 8px',
              borderRadius: 6,
              border: '1px solid rgba(255, 255, 255, 0.18)',
              flexShrink: 0,
              whiteSpace: 'nowrap'
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 800, color: theme.titlebarColor, letterSpacing: '0.04em', whiteSpace: 'nowrap', flexShrink: 0 }}>
              UI:
            </span>
            <select
              value={currentThemeId}
              onChange={e => setCurrentThemeId(e.target.value)}
              title="切換介面風格"
              style={{
                background: 'rgba(0, 0, 0, 0.45)',
                color: '#ffffff',
                border: '1px solid rgba(255, 255, 255, 0.3)',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: 11,
                fontWeight: 700,
                outline: 'none',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0
              }}
            >
              {Object.values(THEMES).map(t => (
                <option key={t.id} value={t.id} style={{ background: '#1e293b', color: '#ffffff' }}>
                  {t.name} ({t.badge})
                </option>
              ))}
            </select>
          </div>

          {/* Right: Window Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              onClick={toggleFullscreen}
              title="Toggle Fullscreen"
              style={{ ...themeBtn(theme), padding: '4px 10px', fontSize: 11 }}
            >
              ⛶
            </button>
            <button
              onClick={onClose}
              title="Close Session"
              style={{
                background: theme.controlCloseBg,
                color: '#ffffff',
                border: 'none',
                width: 28,
                height: 24,
                borderRadius: 4,
                cursor: 'pointer',
                fontWeight: 900,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Action Toolbar */}
        <div
          style={{
            height: 38,
            background: theme.toolbarBg,
            borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
            padding: '0 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0
          }}
        >
          {/* Left: Connection State & Message */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: connectionStatus === 'connected' ? '#10b981' : connectionStatus === 'connecting' ? '#f59e0b' : '#ef4444',
                boxShadow: connectionStatus === 'connected' ? '0 0 8px #10b981' : 'none'
              }}
            />
            <span style={{ fontSize: 11, fontWeight: 700, color: theme.textColor, textTransform: 'uppercase' }}>
              {connectionStatus}
            </span>
            <span style={{ fontSize: 11, color: theme.textMuted }}>
              • {statusMessage}
            </span>
          </div>

          {/* Right: Controls & Shortcuts */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Credential Switcher Button */}
            <button
              onClick={() => setShowCredPanel(prev => !prev)}
              style={{
                ...themeBtn(theme),
                padding: '4px 10px',
                fontSize: 11,
                background: showCredPanel ? 'rgba(99, 102, 241, 0.35)' : theme.btnBg,
                borderColor: showCredPanel ? '#818cf8' : undefined
              }}
              title="切換遠端登入帳號密碼 (預設為 somp-vanguard AD 帳號)"
            >
              🔑 帳號憑證設定
            </button>

            {/* Special Key Injectors */}
            {isWindows && (
              <>
                <button
                  onClick={() => injectKey('Ctrl+Alt+Del')}
                  style={{ ...themeBtn(theme), padding: '4px 8px', fontSize: 11 }}
                  title="Inject Ctrl+Alt+Del (解鎖登入畫面)"
                >
                  Ctrl+Alt+Del
                </button>
                <button
                  onClick={() => injectKey('Ctrl+Alt+End')}
                  style={{ ...themeBtn(theme), padding: '4px 8px', fontSize: 11 }}
                  title="Inject Ctrl+Alt+End (Windows RDP 遠端安全選單 / 登出 Sign Out)"
                >
                  Ctrl+Alt+End
                </button>
                <button
                  onClick={() => injectKey('Alt+Tab')}
                  style={{ ...themeBtn(theme), padding: '4px 8px', fontSize: 11 }}
                  title="Inject Alt+Tab"
                >
                  Alt+Tab
                </button>
              </>
            )}

            {!isWindows && (
              <button
                onClick={() => injectKey('Esc')}
                style={{ ...themeBtn(theme), padding: '4px 8px', fontSize: 11 }}
                title="Send Escape"
              >
                Esc
              </button>
            )}

            {/* Clipboard Toggle */}
            <button
              onClick={() => setShowClipboard(prev => !prev)}
              style={{
                ...themeBtn(theme),
                padding: '4px 10px',
                fontSize: 11,
                background: showClipboard ? 'rgba(56, 189, 248, 0.3)' : theme.btnBg
              }}
            >
              📋 Clipboard
            </button>

            {/* Display Fit Toggle */}
            <button
              onClick={() => setDisplayMode(prev => prev === 'fit' ? '1:1' : 'fit')}
              style={{ ...themeBtn(theme), padding: '4px 10px', fontSize: 11 }}
              title="切換 1:1 原生像素或自動適應視窗。若滑鼠無法對齊，建議切換為 1:1 Pixel 模式！"
            >
              {displayMode === 'fit' ? '🔍 1:1 Pixel' : '↔️ Fit Window'}
            </button>

            {/* Mouse Cursor Alignment Toggle */}
            <button
              onClick={toggleHideLocalCursor}
              style={{
                ...themeBtn(theme),
                padding: '4px 8px',
                fontSize: 11,
                background: hideLocalCursor ? 'rgba(168, 85, 247, 0.3)' : theme.btnBg,
                borderColor: hideLocalCursor ? '#c084fc' : undefined
              }}
              title="外層滑鼠與內層滑鼠對不齊或雙指標重疊時，點此隱藏本機外層滑鼠，僅保留遠端 Windows 指標"
            >
              {hideLocalCursor ? '🐭 顯示外層滑鼠' : '🎯 游標對齊'}
            </button>

            {/* Logout Button */}
            <button
              onClick={handleLogout}
              style={{
                background: 'rgba(239, 68, 68, 0.18)',
                border: '1px solid rgba(239, 68, 68, 0.45)',
                color: '#f87171',
                padding: '4px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: 11,
                display: 'flex',
                alignItems: 'center',
                gap: 4
              }}
              title="登出遠端工作階段並重設憑證 (Logout & Clear Session)"
            >
              🚪 Logout
            </button>

            {/* Disconnect */}
            <button
              onClick={onClose}
              style={{
                background: 'rgba(148, 163, 184, 0.15)',
                border: '1px solid rgba(148, 163, 184, 0.35)',
                color: '#cbd5e1',
                padding: '4px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: 11
              }}
              title="中斷連線並關閉視窗 (Disconnect & Close)"
            >
              🔌 Disconnect
            </button>
          </div>
        </div>

        {/* Credential Settings Panel (Dropdown) */}
        {showCredPanel && (
          <div
            style={{
              background: 'rgba(15, 23, 42, 0.98)',
              borderBottom: '1px solid rgba(99, 102, 241, 0.3)',
              padding: '10px 16px',
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8' }}>登入帳號:</span>
              <input
                type="text"
                value={authUsername}
                onChange={e => setAuthUsername(e.target.value)}
                placeholder={isWindows ? defaultLoginUser : "例如: root / ubuntu"}
                style={{
                  background: 'rgba(0,0,0,0.5)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: 4,
                  color: '#ffffff',
                  padding: '4px 8px',
                  fontSize: 12,
                  width: 140
                }}
              />
            </div>

            {isWindows && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8' }}>網域:</span>
                <input
                  type="text"
                  value={authDomain}
                  onChange={e => setAuthDomain(e.target.value)}
                  placeholder="例如: corp.example (本機留空)"
                  style={{
                    background: 'rgba(0,0,0,0.5)',
                    border: '1px solid rgba(255,255,255,0.2)',
                    borderRadius: 4,
                    color: '#ffffff',
                    padding: '4px 8px',
                    fontSize: 12,
                    width: 120
                  }}
                />
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8' }}>密碼:</span>
              <input
                type="password"
                value={authPassword}
                onChange={e => setAuthPassword(e.target.value)}
                placeholder={isWindows ? "輸入 Windows 密碼" : "輸入 SSH 密碼"}
                style={{
                  background: 'rgba(0,0,0,0.5)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: 4,
                  color: '#ffffff',
                  padding: '4px 8px',
                  fontSize: 12,
                  width: 140
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    setShowCredPanel(false);
                    connectSession(authUsername, authPassword, authDomain);
                  }
                }}
              />
            </div>

            {isWindows && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8' }}>NLA 安全:</span>
                <select
                  value={nlaSecurity}
                  onChange={e => setNlaSecurity(e.target.value)}
                  style={{
                    background: 'rgba(0,0,0,0.5)',
                    border: '1px solid rgba(255,255,255,0.2)',
                    borderRadius: 4,
                    color: '#ffffff',
                    padding: '4px 6px',
                    fontSize: 11
                  }}
                >
                  <option value="any">Any (自動協商)</option>
                  <option value="nla">NLA (網路層驗證)</option>
                  <option value="tls">TLS 加密 (顯示 Windows 登入)</option>
                  <option value="rdp">原生 RDP</option>
                </select>
              </div>
            )}

            <button
              onClick={() => {
                setShowCredPanel(false);
                connectSession(authUsername, authPassword, authDomain);
              }}
              style={{
                background: '#6366f1',
                color: '#ffffff',
                border: 'none',
                borderRadius: 4,
                padding: '5px 14px',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              {connectionStatus === 'connected' ? '🔄 重新連線' : '🚀 開始連線'}
            </button>
            <span style={{ fontSize: 10, color: '#94a3b8' }}>
              {isWindows ? (
                <>💡 預設自動帶入 AD 帳號 <code>{defaultLoginUser}</code>，請輸入密碼後連線；若為本機帳號網域請留空。</>
              ) : (
                <>💡 Linux SSH 連線請自訂目標主機帳號與密碼</>
              )}
            </span>
          </div>
        )}

        {/* Clipboard Bridge Panel */}
        {showClipboard && (
          <div
            style={{
              background: 'rgba(15, 23, 42, 0.95)',
              borderBottom: '1px solid rgba(255, 255, 255, 0.12)',
              padding: 12,
              display: 'flex',
              gap: 12,
              alignItems: 'center'
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#94a3b8', marginBottom: 4 }}>
                BI-DIRECTIONAL CLIPBOARD (雙向剪貼簿傳輸橋接)
              </div>
              <input
                type="text"
                value={clipboardText}
                onChange={e => setClipboardText(e.target.value)}
                placeholder="貼入文字後點擊右側按鈕傳送至遠端剪貼簿，亦可在此直接讀取遠端複製內容..."
                style={{
                  width: '100%',
                  background: 'rgba(0,0,0,0.5)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  borderRadius: 6,
                  color: '#ffffff',
                  padding: '6px 10px',
                  fontSize: 12,
                  outline: 'none'
                }}
              />
            </div>
            <button
              onClick={sendClipboardToRemote}
              style={{
                background: theme.accentColor,
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '8px 16px',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                marginTop: 16
              }}
            >
              📤 派送至遠端剪貼簿
            </button>
          </div>
        )}

        {/* Main Remote Display Viewport */}
        <div
          ref={viewportRef}
          style={{
            flex: 1,
            position: 'relative',
            background: theme.panelBg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: displayMode === '1:1' ? 'auto' : 'hidden'
          }}
        >
          {/* Error State */}
          {connectionStatus === 'error' && (
            <div
              style={{
                maxWidth: 520,
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: 12,
                padding: 24,
                textAlign: 'center'
              }}
            >
              <div style={{ fontSize: 42, marginBottom: 12 }}>🚨</div>
              <h3 style={{ margin: '0 0 8px', color: '#f87171', fontSize: 16, fontWeight: 800 }}>
                Guacamole Remote Gateway 連線失敗
              </h3>
              <p style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.6, margin: '0 0 16px' }}>
                {tokenError || '無法建立與目標主機的 Guacamole 會話，請確認帳密正確且目標 RDP/SSH 埠已開啟。'}
              </p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button
                  onClick={() => connectSession()}
                  style={{
                    background: '#ef4444',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    padding: '8px 18px',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer'
                  }}
                >
                  🔄 重試連線
                </button>
                <button
                  onClick={() => setShowCredPanel(true)}
                  style={{
                    background: 'rgba(255,255,255,0.15)',
                    color: '#fff',
                    border: '1px solid rgba(255,255,255,0.3)',
                    borderRadius: 6,
                    padding: '8px 18px',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer'
                  }}
                >
                  🔑 修改帳號密碼
                </button>
                <button
                  onClick={onClose}
                  style={{
                    background: 'transparent',
                    color: '#94a3b8',
                    border: '1px solid rgba(255,255,255,0.2)',
                    borderRadius: 6,
                    padding: '8px 18px',
                    fontSize: 12,
                    cursor: 'pointer'
                  }}
                >
                  ✕ 關閉
                </button>
              </div>
            </div>
          )}

          {/* SSH Waiting for Credentials State */}
          {!isWindows && !authUsername && connectionStatus !== 'connecting' && connectionStatus !== 'connected' && connectionStatus !== 'error' && (
            <div style={{ textAlign: 'center', position: 'absolute', zIndex: 10, maxWidth: 440, padding: 20 }}>
              <div style={{ fontSize: 44, marginBottom: 12 }}>
                🔐
              </div>
              <div style={{ fontWeight: 800, fontSize: 16, color: theme.textColor, marginBottom: 8 }}>
                Web-SSH 終端連線憑證
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted, lineHeight: 1.6, marginBottom: 16 }}>
                請於上方「帳號憑證設定」列輸入目標 Linux 主機帳號與密碼，完成後點擊「開始連線」。
              </div>
              <button
                onClick={() => setShowCredPanel(true)}
                style={{
                  background: '#6366f1',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: 6,
                  padding: '8px 20px',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
              >
                🔑 開啟帳號密碼輸入列
              </button>
            </div>
          )}

          {/* Connecting State */}
          {connectionStatus === 'connecting' && (
            <div style={{ textAlign: 'center', position: 'absolute', zIndex: 10 }}>
              <div style={{ fontSize: 42, animation: 'pulse 1.2s infinite', marginBottom: 12 }}>
                📡
              </div>
              <div style={{ fontWeight: 800, fontSize: 15, color: theme.textColor, marginBottom: 6 }}>
                Connecting to {targetName} via Apache Guacamole
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted }}>
                Target: <code>{targetIp}</code> ({protocol.toUpperCase()}) | User: <code>{authUsername || (isWindows ? defaultLoginUser : 'Prompt')}</code>
              </div>
            </div>
          )}

          {/* Real Guacamole Display Container (Where native Canvas is rendered) */}
          <div
            ref={displayContainerRef}
            style={{
              display: connectionStatus === 'connected' ? 'flex' : 'none',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              height: '100%'
            }}
          />
        </div>

        {/* Resize Handles (Only in windowed mode) */}
        {displayMode !== 'fullscreen' && (
          <>
            {/* Right edge */}
            <div
              onMouseDown={e => handleResizeMouseDown(e, 'e')}
              style={{ position: 'absolute', top: 42, right: 0, width: 8, bottom: 18, cursor: 'ew-resize', zIndex: 50 }}
            />
            {/* Bottom edge */}
            <div
              onMouseDown={e => handleResizeMouseDown(e, 's')}
              style={{ position: 'absolute', bottom: 0, left: 18, height: 8, right: 18, cursor: 'ns-resize', zIndex: 50 }}
            />
            {/* Left edge */}
            <div
              onMouseDown={e => handleResizeMouseDown(e, 'w')}
              style={{ position: 'absolute', top: 42, left: 0, width: 8, bottom: 18, cursor: 'ew-resize', zIndex: 50 }}
            />
            {/* Bottom-Right corner handle with grip dots */}
            <div
              onMouseDown={e => handleResizeMouseDown(e, 'se')}
              title="拖曳縮放視窗大小"
              style={{
                position: 'absolute',
                bottom: 2,
                right: 2,
                width: 18,
                height: 18,
                cursor: 'nwse-resize',
                zIndex: 60,
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'flex-end',
                padding: 2
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <circle cx="8.5" cy="8.5" r="1.2" fill="rgba(255,255,255,0.45)" />
                <circle cx="5" cy="8.5" r="1.2" fill="rgba(255,255,255,0.45)" />
                <circle cx="8.5" cy="5" r="1.2" fill="rgba(255,255,255,0.45)" />
                <circle cx="1.5" cy="8.5" r="1.2" fill="rgba(255,255,255,0.45)" />
                <circle cx="5" cy="5" r="1.2" fill="rgba(255,255,255,0.45)" />
                <circle cx="8.5" cy="1.5" r="1.2" fill="rgba(255,255,255,0.45)" />
              </svg>
            </div>
            {/* Bottom-Left corner handle */}
            <div
              onMouseDown={e => handleResizeMouseDown(e, 'sw')}
              style={{ position: 'absolute', bottom: 0, left: 0, width: 14, height: 14, cursor: 'nesw-resize', zIndex: 50 }}
            />
          </>
        )}

        {/* Transparent mouse event trap during active drag/resize */}
        {(isDragging || isResizing) && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 9999, cursor: isDragging ? 'grabbing' : 'nwse-resize' }} />
        )}
      </div>
    </div>
  );
}

// Helper for button styles based on theme
function themeBtn(theme) {
  return {
    background: theme.btnBg,
    border: theme.btnBorder,
    color: theme.btnColor,
    borderRadius: theme.id === 'win31' || theme.id === 'win95' ? 0 : 4,
    cursor: 'pointer',
    fontWeight: 700
  };
}
