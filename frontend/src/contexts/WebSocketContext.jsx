import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { useToast } from './ToastContext';

const WebSocketContext = createContext();

export const WebSocketProvider = ({ children }) => {
    const { showToast } = useToast();
    const [lastEvent, setLastEvent] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    
    const wsRef = useRef(null);
    const bcRef = useRef(null);
    const reconnectTimeoutRef = useRef(null);
    const retryCountRef = useRef(0);

    // BroadcastChannel Initialization
    useEffect(() => {
        const bc = new BroadcastChannel('somp-vanguard-sync');
        bcRef.current = bc;

        bc.onmessage = (event) => {
            // event.data is the payload we broadcasted
            console.log('[BroadcastChannel] Received:', event.data);
            setLastEvent({ source: 'broadcast', ...event.data, _t: Date.now() });
        };

        return () => {
            bc.close();
        };
    }, []);

    // WebSocket Initialization
    const connectWebSocket = useCallback(() => {
        const token = localStorage.getItem('token');
        if (!token) return; // Wait until logged in

        if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
            return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws?token=${token}`;

        console.log('[WebSocket] Connecting to:', wsUrl);
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log('[WebSocket] Connected');
            setIsConnected(true);
            retryCountRef.current = 0; // Reset retry
        };

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type !== 'SCOUT_REPORT') {
                    console.log('[WebSocket] Received:', data);
                }
                // The server payload is { type, payload, timestamp }
                setLastEvent({ source: 'websocket', ...data, _t: Date.now() });
            } catch (err) {
                console.error('[WebSocket] Failed to parse message', err);
            }
        };

        ws.onclose = (event) => {
            console.log('[WebSocket] Disconnected:', event.code, event.reason);
            setIsConnected(false);
            wsRef.current = null;
            
            // Reconnect logic
            const delay = Math.min(10000, 1000 * Math.pow(2, retryCountRef.current));
            retryCountRef.current++;
            console.log(`[WebSocket] Reconnecting in ${delay}ms...`);
            reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
        };

        ws.onerror = (error) => {
            console.error('[WebSocket] Error:', error);
            // onclose will handle the reconnection
            if (ws.readyState === WebSocket.OPEN) {
                ws.close();
            }
        };
    }, []);

    // Monitor token to connect/disconnect
    useEffect(() => {
        const checkAuth = () => {
            const token = localStorage.getItem('token');
            if (token && (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED)) {
                connectWebSocket();
            } else if (!token && wsRef.current) {
                wsRef.current.close();
                clearTimeout(reconnectTimeoutRef.current);
            }
        };

        // Initial check
        checkAuth();

        // Listen for storage changes (login/logout from other tabs)
        window.addEventListener('storage', checkAuth);
        // Custom app activity event
        window.addEventListener('app-activity', checkAuth);

        return () => {
            window.removeEventListener('storage', checkAuth);
            window.removeEventListener('app-activity', checkAuth);
            clearTimeout(reconnectTimeoutRef.current);
            if (wsRef.current) {
                wsRef.current.close();
            }
        };
    }, [connectWebSocket]);

    // Function to manually broadcast an event to other tabs
    const broadcast = useCallback((type, payload = {}) => {
        const eventData = { type, payload };
        if (bcRef.current) {
            bcRef.current.postMessage(eventData);
        }
        // Also trigger locally so the sender tab updates itself if needed
        setLastEvent({ source: 'local', ...eventData, _t: Date.now() });
    }, []);

    return (
        <WebSocketContext.Provider value={{ lastEvent, isConnected, broadcast }}>
            {children}
        </WebSocketContext.Provider>
    );
};

export const useSync = () => useContext(WebSocketContext);
