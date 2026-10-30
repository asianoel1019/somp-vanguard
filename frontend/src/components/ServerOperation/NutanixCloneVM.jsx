import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import useEnvironments from '../../hooks/useEnvironments';
import { validateEnvValue } from '../../utils/environments';

const S = {
    container: { display: 'flex', flexDirection: 'column', gap: 24, fontFamily: "'Inter', sans-serif", color: 'var(--text-primary)' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
    titleArea: { display: 'flex', flexDirection: 'column' },
    title: { fontSize: 22, fontWeight: 900, margin: 0, display: 'flex', alignItems: 'center', gap: 8 },
    subtitle: { fontSize: 12, color: 'var(--text-muted)', marginTop: 4 },
    backBtn: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: 'pointer', transition: 'all 0.2s' },
    
    tabs: { display: 'flex', gap: 12, borderBottom: '1px solid var(--border-color)', paddingBottom: 1 },
    tab: { padding: '12px 20px', background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 14, fontWeight: 700, cursor: 'pointer', borderBottom: '3px solid transparent', transition: 'all 0.2s' },
    activeTab: { color: 'var(--accent-primary)', borderBottomColor: 'var(--accent-primary)' },
    
    panel: { background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24, boxShadow: 'var(--shadow-lg)' },
    panelTitle: { fontSize: 16, fontWeight: 900, margin: '0 0 16px 0', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 },
    
    row: { display: 'flex', gap: 20, flexWrap: 'wrap' },
    col: { flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 16 },
    
    label: { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' },
    textarea: { width: '100%', height: 120, background: 'rgba(15, 23, 42, 0.4)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 12, color: 'var(--text-primary)', fontFamily: 'monospace', fontSize: 12, outline: 'none', resize: 'vertical' },
    input: { width: '100%', background: 'rgba(15, 23, 42, 0.4)', border: '1px solid var(--border-color)', borderRadius: 8, padding: '10px 14px', color: 'var(--text-primary)', fontSize: 13, outline: 'none' },
    
    btnP: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 20px', background: 'var(--accent-primary)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 12px var(--accent-glow)', transition: 'transform 0.2s' },
    btnO: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 20px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: 24, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
    btnDanger: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 20px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 24, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
    
    tbl: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
    th: { textAlign: 'left', padding: '12px 16px', fontSize: 11, fontWeight: 800, color: 'var(--text-muted)', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-color)' },
    tr: { borderBottom: '1px solid var(--border-color)', transition: 'background 0.2s' },
    td: { padding: '12px 16px', verticalAlign: 'middle' },
    
    badgeSuccess: { padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(16,185,129,0.15)', color: '#10b981', border: '1px solid rgba(16,185,129,0.3)' },
    badgeWarning: { padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.3)' },
    badgeDanger: { padding: '3px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, background: 'rgba(239,68,68,0.15)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' },
    
    credCard: { padding: 12, borderRadius: 10, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    
    terminal: { background: '#0e1716', border: '1px solid #14493f', borderRadius: 12, padding: 16, fontFamily: "'Fira Code', 'Courier New', monospace", fontSize: 12, color: '#38f3a3', overflowY: 'auto', height: 280, display: 'flex', flexDirection: 'column', gap: 4, boxShadow: 'inset 0 4px 20px rgba(0,0,0,0.8)' },
    
    modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 },
    modalContent: { width: '100%', maxWidth: 500, background: 'var(--bg-glass)', border: '1px solid var(--border-color)', borderRadius: 16, padding: 24, boxShadow: '0 20px 40px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', gap: 16 },
    modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
    modalTitle: { fontSize: 16, fontWeight: 900, margin: 0, color: 'var(--text-primary)' },
    modalBody: { fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 },
    modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
    
    searchBar: { display: 'flex', gap: 12, marginBottom: 16 },
    pulseDot: { width: 8, height: 8, borderRadius: '50%', background: '#10b981', display: 'inline-block', animation: 'pulse 1.5s infinite' }
};

const formatOuDisplay = (ouLayer) => {
    if (!ouLayer) return '';
    const parts = ouLayer.split(',');
    const ouParts = parts.filter(p => p.trim().toUpperCase().startsWith('OU='));
    if (ouParts.length > 2) {
        return `${ouParts[0]},${ouParts[1]}...`;
    }
    if (ouParts.length > 0) {
        const displayed = ouParts.slice(0, 2).join(',');
        if (parts.length > ouParts.slice(0, 2).length) {
            return displayed + '...';
        }
        return displayed;
    }
    return ouLayer;
};

const NutanixCloneVM = ({ onClose }) => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const [activeTab, setActiveTab] = useState('provision'); // 'provision' | 'mapping' | 'template-bu'
    
    // --- Shared States ---
    const [ipSwitchMap, setIpSwitchMap] = useState([]);
    const [settingsCheck, setSettingsCheck] = useState({ pcIp: false, pcAccount: false, pcPwd: false, adUser: false, adPwd: false, adDomain: false, pcIpValue: '', adUserValue: '', adDomainValue: '' });
    
    // --- Provision Tab States ---
    const [rawExcel, setRawExcel] = useState('');
    const [parsedVms, setParsedVms] = useState([]);
    const envs = useEnvironments();
    // Row environment chosen from the dropdown (canonical name); clears the row error
    const setVmEnv = (idx, name) => setParsedVms(list => list.map((vm, i) => {
        if (i !== idx) return vm;
        const rest = { ...vm };
        delete rest.envError;
        const zoneWasEnv = !vm.Zone || vm.Zone === vm.Env;
        return { ...rest, Env: name, Zone: zoneWasEnv ? name : vm.Zone, ...(name ? {} : { envError: 'Environment is required' }) };
    }));
    const [localAdminPassword, setLocalAdminPassword] = useState('');
    const [isDeploying, setIsDeploying] = useState(false);
    const [taskStatus, setTaskStatus] = useState({ running: false, startTime: null, vms: [] });
    const [logContent, setLogContent] = useState('');
    
    const isLinuxOnly = parsedVms.length > 0 && parsedVms.every(vm => {
        const os = vm.OS || '';
        return !!os.match(/linux|ubuntu|centos|rhel|redhat|debian|rocky|alma|suse|sles|oel|oracle/i);
    });
    
    // --- Mapping Tab States ---
    const [searchQuery, setSearchQuery] = useState('');
    const [editingMap, setEditingMap] = useState(null); // mapping object being edited, or 'new' for creating a new record
    
    // --- Template-BU Mapping Tab States ---
    const [templateBuMap, setTemplateBuMap] = useState([]);
    const [templates, setTemplates] = useState([]);
    const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
    const [editingTemplateMap, setEditingTemplateMap] = useState(null);
    const [searchTemplateQuery, setSearchTemplateQuery] = useState('');
    const [clusters, setClusters] = useState([]);
    const [isLoadingClusters, setIsLoadingClusters] = useState(false);

    // --- Custom Modal States (Rule #5 Avoid Browser pop-ups) ---
    const [modal, setModal] = useState({ show: false, type: 'info', title: '', message: '', onConfirm: null });
    
    const termEndRef = useRef(null);
    const logIntervalRef = useRef(null);
    const statusIntervalRef = useRef(null);

    // Initial Load
    useEffect(() => {
        fetchIpSwitchMap();
        fetchTemplateBuMap();
        fetchTemplates();
        fetchClusters();
        fetchSettingsCheck();
        checkTaskStatus();
        
        // Setup state checking loop
        statusIntervalRef.current = setInterval(checkTaskStatus, 3000);
        return () => {
            if (statusIntervalRef.current) clearInterval(statusIntervalRef.current);
            if (logIntervalRef.current) clearInterval(logIntervalRef.current);
        };
    }, []);

    // Check if task is running, start polling logs if it is
    useEffect(() => {
        if (taskStatus.running) {
            if (!logIntervalRef.current) {
                fetchLogs();
                logIntervalRef.current = setInterval(fetchLogs, 1500);
            }
        } else {
            if (logIntervalRef.current) {
                clearInterval(logIntervalRef.current);
                logIntervalRef.current = null;
                // Final fetch logs on exit
                fetchLogs();
            }
        }
    }, [taskStatus.running]);

    // Auto Scroll Terminal to bottom when new logs stream in
    useEffect(() => {
        if (termEndRef.current) {
            termEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logContent]);

    // Show Custom Modal wrapper instead of native alerts/confirms
    const showModal = (type, title, message, onConfirm = null) => {
        setModal({ show: true, type, title, message, onConfirm });
    };

    const closeModal = () => {
        setModal(prev => ({ ...prev, show: false }));
    };

    // --- Backend API Operations ---
    const fetchIpSwitchMap = async () => {
        try {
            const res = await api.get('/nutanix/ip-switch-map');
            setIpSwitchMap(res.data || []);
        } catch (err) {
            showModal('error', 'Error', 'Failed to load IP Switch Mapping: ' + (err.response?.data?.error || err.message));
        }
    };

    const fetchSettingsCheck = async () => {
        try {
            const res = await api.get('/nutanix/settings-check');
            setSettingsCheck(res.data);
        } catch (err) {
            showModal('error', 'Error', 'Failed to check system settings: ' + (err.response?.data?.error || err.message));
        }
    };

    const checkTaskStatus = async () => {
        try {
            const res = await api.get('/nutanix/clone-status');
            setTaskStatus(res.data);
        } catch (err) {
            console.error('Failed to get background clone task status:', err);
        }
    };

    const fetchLogs = async () => {
        try {
            const res = await api.get('/nutanix/clone-logs');
            setLogContent(res.data || '');
        } catch (err) {
            console.error('Failed to fetch clone logs:', err);
        }
    };

    const saveIpSwitchMap = async (updatedData) => {
        try {
            const res = await api.post('/nutanix/ip-switch-map', updatedData);
            if (res.data.success) {
                setIpSwitchMap(updatedData);
                showModal('success', 'Success', 'Subnet Switch Mapping updated successfully!');
            }
        } catch (err) {
            showModal('error', 'Error', 'Failed to save mapping: ' + (err.response?.data?.error || err.message));
        }
    };

    const fetchTemplateBuMap = async () => {
        try {
            const res = await api.get('/nutanix/template-bu-map');
            setTemplateBuMap(res.data || []);
        } catch (err) {
            showModal('error', 'Error', 'Failed to load Template-BU Mapping: ' + (err.response?.data?.error || err.message));
        }
    };

    const fetchTemplates = async (clusterName) => {
        setIsLoadingTemplates(true);
        try {
            const url = clusterName ? `/nutanix/templates?cluster=${encodeURIComponent(clusterName)}` : '/nutanix/templates';
            const res = await api.get(url);
            setTemplates(res.data || []);
        } catch (err) {
            console.error('Failed to load VM templates from Prism Central:', err);
        } finally {
            setIsLoadingTemplates(false);
        }
    };

    const fetchClusters = async () => {
        setIsLoadingClusters(true);
        try {
            const res = await api.get('/nutanix/clusters');
            setClusters(res.data || []);
        } catch (err) {
            console.error('Failed to load VM clusters from Prism Central:', err);
        } finally {
            setIsLoadingClusters(false);
        }
    };

    const saveTemplateBuMap = async (updatedData) => {
        try {
            const res = await api.post('/nutanix/template-bu-map', updatedData);
            if (res.data.success) {
                setTemplateBuMap(updatedData);
                showModal('success', 'Success', 'Template-BU Mapping updated successfully!');
            }
        } catch (err) {
            showModal('error', 'Error', 'Failed to save Template-BU mapping: ' + (err.response?.data?.error || err.message));
        }
    };

    // --- Excel Copy Paste Parser Logic ---
    const parseDiskSpecification = (diskStr) => {
        if (!diskStr) return { C: 0, L: 0, X: 0, Total: 0, Disks: [], Partitions: [], Raw: '', Display: 'None', Type: 'unknown', Note: '', IsPhysical: false };
        const raw = String(diskStr).trim();
        let c = 0, l = 0, x = 0;
        const disks = [];
        const partitions = [];

        const isPhysical = raw.toUpperCase().includes('PHY_') || raw.toUpperCase().includes('RAID');

        // Extract trailing/extra notes
        let note = raw
            .replace(/(?:VM|PHY)_\d+(?:\.\d+)?\s*(?:GB|G|TB|T)?/gi, '')
            .replace(/\([^)]*\)/g, '')
            .replace(/^[,\s;]+|[,\s;]+$/g, '')
            .trim();

        // Helper to normalize any size and unit to GB (e.g. 1TB -> 1000, 1.5TB -> 1500, 500GB -> 500, 512MB -> 1)
        function toGB(val, unit) {
            const num = parseFloat(val) || 0;
            if (!unit) return Math.round(num);
            const u = unit.toUpperCase().trim();
            if (u === 'TB' || u === 'T') return Math.round(num * 1000);
            if (u === 'MB' || u === 'M') return Math.round(num / 1024) || 1;
            return Math.round(num);
        }

        // Check all VM_## / PHY_## matches and brackets
        const prefixMatches = [...raw.matchAll(/(VM|PHY)_(\d+(?:\.\d+)?)\s*(TB|T|GB|G)?/gi)];
        const bracketMatches = [...raw.matchAll(/\(([^)]+)\)/g)];

        // Scenario 1: Multiple VM_## / PHY_## prefixes (e.g. 'VM_80GB (/:71GB, /boot:1GB, swap:8GB) VM_200GB' or 'VM_100GB (C:100GB) VM_1TB')
        if (prefixMatches.length > 1) {
            const tokens = [];
            prefixMatches.forEach((pm, idx) => {
                const start = pm.index;
                const prefixStr = pm[0];
                const size = toGB(pm[2], pm[3]);

                const nextStart = prefixMatches[idx + 1] ? prefixMatches[idx + 1].index : raw.length;
                const segment = raw.slice(start, nextStart);
                const segBrackets = [...segment.matchAll(/\(([^)]+)\)/g)];

                tokens.push({
                    prefix: prefixStr,
                    size: size,
                    type: pm[1].toUpperCase(),
                    brackets: segBrackets.map(b => b[1].trim())
                });
            });

            tokens.forEach((tok) => {
                if (tok.brackets.length > 0) {
                    tok.brackets.forEach(inner => {
                        const isLinux = inner.startsWith('/') || inner.toLowerCase().includes('swap') || inner.toLowerCase().includes('/boot');
                        const winDriveMatches = isLinux ? [] : [...inner.matchAll(/(?:^|[\s,(])([A-Za-z]):\s*(\d+(?:\.\d+)?)\s*(TB|T|GB|G|MB|M)?/gi)];

                        if (!isLinux && winDriveMatches.length > 0) {
                            let bracketSum = 0;
                            const primaryLetter = winDriveMatches[0][1].toUpperCase();
                            winDriveMatches.forEach(dm => {
                                const cleanSz = toGB(dm[2], dm[3]);
                                bracketSum += cleanSz;
                                partitions.push({ mount: dm[1].toUpperCase() + ':', size: cleanSz });
                            });
                            disks.push({
                                index: disks.length,
                                letter: primaryLetter,
                                size: bracketSum > 0 ? bracketSum : tok.size,
                                type: 'windows',
                                raw: inner
                            });
                            if (primaryLetter === 'C') c = bracketSum;
                            else if (primaryLetter === 'L') l = bracketSum;
                            else if (primaryLetter === 'X') x = bracketSum;
                        } else {
                            let bracketSum = 0;
                            const innerParts = inner.split(',').map(s => s.trim()).filter(Boolean);
                            innerParts.forEach(p => {
                                const partMatch = p.match(/([^:]+):\s*(\d+(?:\.\d+)?)\s*(TB|T|GB|G|MB|M)?/i);
                                if (partMatch) {
                                    const mountName = partMatch[1].trim();
                                    const cleanSz = toGB(partMatch[2], partMatch[3]);
                                    bracketSum += cleanSz;
                                    partitions.push({ mount: mountName, size: cleanSz });
                                } else {
                                    const numMatch = p.match(/(\d+(?:\.\d+)?)\s*(TB|T|GB|G|MB|M)?/i);
                                    if (numMatch) {
                                        const sz = toGB(numMatch[1], numMatch[2]);
                                        bracketSum += sz;
                                        partitions.push({ mount: p, size: sz });
                                    }
                                }
                            });
                            const diskIdx = disks.length;
                            const linuxDiskName = diskIdx === 0 ? 'sda' : (diskIdx === 1 ? 'sdb' : (diskIdx === 2 ? 'sdc' : 'sd' + String.fromCharCode(97 + diskIdx)));
                            disks.push({
                                index: diskIdx,
                                letter: linuxDiskName,
                                size: bracketSum > 0 ? bracketSum : tok.size,
                                type: 'linux',
                                raw: inner
                            });
                            if (diskIdx === 0) c = bracketSum;
                            else if (diskIdx === 1) l = bracketSum;
                            else if (diskIdx === 2) x = bracketSum;
                        }
                    });
                } else {
                    // No bracket: raw unmounted disk
                    const diskIdx = disks.length;
                    const linuxDiskName = diskIdx === 0 ? 'sda' : (diskIdx === 1 ? 'sdb' : (diskIdx === 2 ? 'sdc' : 'sd' + String.fromCharCode(97 + diskIdx)));
                    const letter = (disks.length === 0 ? 'C' : (disks[0]?.type === 'linux' ? linuxDiskName : (disks.length === 1 ? 'L' : 'X')));
                    disks.push({
                        index: diskIdx,
                        letter: letter,
                        size: tok.size,
                        type: disks[0]?.type || 'other',
                        raw: tok.prefix
                    });
                    if (letter === 'C' || (diskIdx === 0 && !c)) c = tok.size;
                    else if (letter === 'L' || (diskIdx === 1 && !l)) l = tok.size;
                    else if (letter === 'X' || (diskIdx === 2 && !x)) x = tok.size;
                }
            });

            const total = disks.reduce((sum, d) => sum + d.size, 0);
            const display = disks.map(d => d.letter + ':' + d.size + 'GB' + (d.raw && d.raw !== d.letter + ':' + d.size + 'GB' && !d.raw.startsWith('VM_') ? ' (' + d.raw + ')' : '')).join(' / ') + (total > 0 ? ' (Total: ' + total + 'GB)' : '') + (note ? ' | ' + note : '');

            return {
                C: c || (disks[0]?.size || 0),
                L: l || (disks[1]?.size || 0),
                X: x || (disks[2]?.size || 0),
                Total: total,
                Disks: disks,
                Partitions: partitions,
                Raw: raw,
                Display: display,
                Type: disks[0]?.type || 'other',
                Note: note,
                IsPhysical: isPhysical
            };
        }

        // Scenario 2: Single or zero prefix with brackets (e.g. VM_1TB (C:100GB)(D:900GB) or VM_1080GB (/:71GB...)(/data:1TB))
        let prefixTotal = 0;
        let prefixType = '';
        if (prefixMatches.length === 1) {
            prefixTotal = toGB(prefixMatches[0][2], prefixMatches[0][3]);
            prefixType = prefixMatches[0][1].toUpperCase();
        }

        if (bracketMatches.length > 0) {
            bracketMatches.forEach((m, idx) => {
                const inner = m[1].trim();

                const isLinux = inner.startsWith('/') || inner.toLowerCase().includes('swap') || inner.toLowerCase().includes('/boot');
                const winDriveMatches = isLinux ? [] : [...inner.matchAll(/(?:^|[\s,(])([A-Za-z]):\s*(\d+(?:\.\d+)?)\s*(TB|T|GB|G|MB|M)?/gi)];

                if (!isLinux && winDriveMatches.length > 0) {
                    let bracketSum = 0;
                    const primaryLetter = winDriveMatches[0][1].toUpperCase();
                    winDriveMatches.forEach(dm => {
                        const cleanSize = toGB(dm[2], dm[3]);
                        bracketSum += cleanSize;
                        partitions.push({ mount: dm[1].toUpperCase() + ':', size: cleanSize });
                    });

                    disks.push({
                        index: idx,
                        letter: primaryLetter,
                        size: bracketSum,
                        type: isPhysical ? 'physical' : 'windows',
                        raw: inner
                    });

                    if (primaryLetter === 'C') c = bracketSum;
                    else if (primaryLetter === 'L') l = bracketSum;
                    else if (primaryLetter === 'X') x = bracketSum;
                    else {
                        if (idx === 0 && !c) c = bracketSum;
                        else if (idx === 1 && !l) l = bracketSum;
                        else if (idx === 2 && !x) x = bracketSum;
                    }
                } else {
                    let bracketSum = 0;
                    const innerParts = inner.split(',').map(s => s.trim()).filter(Boolean);

                    innerParts.forEach(p => {
                        const partMatch = p.match(/([^:]+):\s*(\d+(?:\.\d+)?)\s*(TB|T|GB|G|MB|M)?/i);
                        if (partMatch) {
                            const mountName = partMatch[1].trim();
                            const cleanSize = toGB(partMatch[2], partMatch[3]);
                            bracketSum += cleanSize;
                            partitions.push({ mount: mountName, size: cleanSize });
                        } else {
                            const numMatch = p.match(/(\d+(?:\.\d+)?)\s*(TB|T|GB|G|MB|M)?/i);
                            if (numMatch) {
                                const sz = toGB(numMatch[1], numMatch[2]);
                                bracketSum += sz;
                                partitions.push({ mount: p, size: sz });
                            }
                        }
                    });

                    const linuxDiskName = idx === 0 ? 'sda' : (idx === 1 ? 'sdb' : (idx === 2 ? 'sdc' : 'sd' + String.fromCharCode(97 + idx)));
                    disks.push({
                        index: idx,
                        letter: linuxDiskName,
                        size: bracketSum,
                        type: 'linux',
                        raw: inner
                    });

                    if (idx === 0) c = bracketSum;
                    else if (idx === 1) l = bracketSum;
                    else if (idx === 2) x = bracketSum;
                }
            });

            const calculatedSum = disks.reduce((sum, d) => sum + d.size, 0);
            const total = prefixTotal > 0 ? prefixTotal : (calculatedSum > 0 ? calculatedSum : prefixTotal);
            const detectedType = isPhysical ? 'physical' : (disks[0]?.type || 'windows');

            let display = '';
            if (detectedType === 'windows' || detectedType === 'physical') {
                const parts = disks.map(d => d.letter + ':' + d.size + 'GB');
                display = parts.join(' / ');
                if (prefixTotal > 0 && prefixTotal !== calculatedSum) {
                    display += ' (' + (prefixType || (isPhysical ? 'PHY' : 'VM')) + '_' + prefixTotal + 'GB)';
                } else if (parts.length > 1 || prefixTotal > 0) {
                    display += ' (Total: ' + total + 'GB)';
                }
            } else if (detectedType === 'linux') {
                const parts = disks.map(d => d.letter + ':' + d.size + 'GB (' + d.raw + ')');
                display = parts.join(' / ') + (total > 0 ? ' (Total: ' + total + 'GB)' : '');
            }

            if (note) {
                display += (display ? ' | ' : '') + note;
            }

            return {
                C: c || (disks[0]?.size || 0),
                L: l || (disks[1]?.size || 0),
                X: x || (disks[2]?.size || 0),
                Total: total || calculatedSum,
                Disks: disks,
                Partitions: partitions,
                Raw: raw,
                Display: display || raw,
                Type: detectedType,
                Note: note,
                IsPhysical: isPhysical
            };
        }

        // Scenario 3: Traditional format without brackets (e.g. 'C:100GB, D:1TB')
        const allDriveMatches = [...raw.matchAll(/(?:^|[\s,])([A-Za-z]):\s*(\d+(?:\.\d+)?)\s*(TB|T|GB|G|MB|M)?/gi)];
        if (allDriveMatches.length > 0) {
            allDriveMatches.forEach((dm, idx) => {
                const letter = dm[1].toUpperCase();
                const sz = toGB(dm[2], dm[3]);
                disks.push({ index: idx, letter, size: sz, type: 'windows' });
                partitions.push({ mount: letter + ':', size: sz });
                if (letter === 'C') c = sz;
                else if (letter === 'L') l = sz;
                else if (letter === 'X') x = sz;
            });
            const total = prefixTotal > 0 ? prefixTotal : disks.reduce((s, d) => s + d.size, 0);
            const display = disks.map(d => d.letter + ':' + d.size + 'GB').join(' / ') + (disks.length > 1 ? ' (Total: ' + total + 'GB)' : '') + (note ? ' | ' + note : '');
            return { C: c, L: l, X: x, Total: total, Disks: disks, Partitions: partitions, Raw: raw, Display: display, Type: 'windows', Note: note, IsPhysical: isPhysical };
        }

        // Scenario 4: Pure total without brackets (e.g. VM_1TB, VM_1.5TB, PHY_2TB, 1.5TB)
        const pureMatch = raw.match(/(\d+(?:\.\d+)?)\s*(TB|T|GB|G)?/i);
        const total = prefixTotal > 0 ? prefixTotal : (pureMatch ? toGB(pureMatch[1], pureMatch[2]) : 0);
        const display = isPhysical ? 'PHY_' + total + 'GB' + (note ? ' | ' + note : '') : (prefixType ? prefixType + '_' + total + 'GB' + (note ? ' | ' + note : '') : total + 'GB' + (note ? ' | ' + note : ''));

        if (total > 0) {
            disks.push({ index: 0, letter: isPhysical ? 'Physical Disk' : 'Disk', size: total, type: isPhysical ? 'physical' : 'other', raw });
        }

        return {
            C: c || total,
            L: l,
            X: x,
            Total: total,
            Disks: disks,
            Partitions: partitions,
            Raw: raw,
            Display: display,
            Type: isPhysical ? 'physical' : 'other',
            Note: note,
            IsPhysical: isPhysical
        };
    };

    const handleParseExcel = () => {
        if (!rawExcel.trim()) {
            showModal('warning', 'Empty Paste Data', 'Please copy rows from Excel and paste them in the text box before parsing.');
            return;
        }

        const lines = rawExcel.split(/\r?\n/).filter(line => line.trim() !== "");
        const parsed = [];
        let errors = 0;

        lines.forEach((line, idx) => {
            const cols = line.split('\t');
            if (cols.length >= 7) {
                // Find IP column index (matches IPv4 address format)
                const ipColIdx = cols.findIndex(c => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(c.trim()));

                let env = ''; // must be chosen from Settings -> Environments (no hard-coded default)
                let name = '';
                let ip = '';
                let numCore = 4;
                let memoryGB = 8;
                let diskStr = '';
                let os = '';
                let zone = '';
                let application = '';
                let bu = 'Default';

                if (ipColIdx === 2) {
                    // Enterprise Format:
                    // Col 0: Environment (e.g. TRUST)
                    // Col 1: Hostname (e.g. JL-TRS-K01WRK010)
                    // Col 2: IP Address (e.g. 192.0.2.10)
                    // Col 5: vCPU (e.g. 16 vCPU)
                    // Col 6: Mem (e.g. 32)
                    // Col 7: Disk (e.g. VM_280GB (...))
                    // Col 8: OS (e.g. Redhat Ent 9.7)
                    // Col 9: Zone / Platform (e.g. JULY-CLUSTER-02)
                    // Col 10: Application (e.g. K8S Worker - ATS)
                    // Col 11: BU (e.g. TRS)
                    env = cols[0].trim();
                    name = cols[1].trim();
                    ip = cols[2].trim();

                    // vCPU (Col 5)
                    const cpuRaw = (cols[5] || '').replace(/\D/g, '');
                    numCore = cpuRaw ? parseInt(cpuRaw, 10) : 4;

                    // Memory (Col 6)
                    const memRaw = (cols[6] || '').replace(/\D/g, '');
                    memoryGB = memRaw ? parseInt(memRaw, 10) : 8;

                    // Disk (Col 7)
                    diskStr = (cols[7] || '').trim();

                    // OS (Col 8)
                    os = (cols[8] || '').trim();

                    // Zone / Platform (Col 9)
                    zone = (cols[9] || '').trim();

                    // Application (Col 10)
                    application = (cols[10] || '').trim();

                    // BU (Col 11)
                    bu = cols.length > 11 ? (cols[11] || '').trim() : (cols.length > 10 ? cols[10].trim() : 'Default');
                } else if (ipColIdx === 1) {
                    // Legacy Format: Hostname(0), IP(1), ..., vCPU(4), Mem(5), Disk(6), OS(7), [Zone(8)], [App(9)], [BU(10)]
                    name = cols[0].trim();
                    ip = cols[1].trim();

                    const cpuRaw = (cols[4] || '').replace(/\D/g, '');
                    numCore = cpuRaw ? parseInt(cpuRaw, 10) : 4;

                    const memRaw = (cols[5] || '').replace(/\D/g, '');
                    memoryGB = memRaw ? parseInt(memRaw, 10) : 8;

                    diskStr = (cols[6] || '').trim();
                    os = (cols[7] || '').trim();
                    zone = cols.length > 8 ? (cols[8] || '').trim() : '';
                    application = cols.length > 9 ? (cols[9] || '').trim() : '';
                    bu = cols.length > 10 ? (cols[10] || '').trim() : 'Default';
                } else {
                    // Fallback heuristics
                    name = (cols[0] || '').trim();
                    ip = (cols[1] || '').trim();
                    const cpuRaw = (cols[4] || '').replace(/\D/g, '');
                    numCore = cpuRaw ? parseInt(cpuRaw, 10) : 4;
                    const memRaw = (cols[5] || '').replace(/\D/g, '');
                    memoryGB = memRaw ? parseInt(memRaw, 10) : 8;
                    diskStr = (cols[6] || '').trim();
                    os = (cols[7] || '').trim();
                    bu = cols.length > 10 ? (cols[10] || '').trim() : 'Default';
                }

                if (!name || !ip) {
                    errors++;
                    return;
                }

                const diskInfo = parseDiskSpecification(diskStr);
                // Environment: canonical name when known; unknown / empty -> envError (fixed with the row dropdown)
                const envCheck = validateEnvValue(env, envs);
                const envName = envCheck.env ? envCheck.env.name : '';
                const envError = envCheck.error || (envCheck.empty ? 'Environment is required' : '');

                parsed.push({
                    Env: envName || env,
                    ...(envError ? { envError } : {}),
                    Zone: zone || envName || env,
                    Platform: zone,
                    Name: name,
                    IP: ip,
                    NumCore: numCore,
                    MemoryGB: memoryGB,
                    MemoryMiB: memoryGB * 1024,
                    OS: os,
                    BU: bu,
                    Application: application,
                    DiskInfo: diskInfo
                });
            } else {
                errors++;
            }
        });

        if (parsed.length === 0) {
            showModal('error', 'Parsing Failed', `Failed to parse any valid VM configurations. Please verify your columns are formatted in Excel correctly (Zone, Hostname, IP, vCPU, Mem, Disk, OS, Platform, App, BU).`);
        } else {
            setParsedVms(parsed);
            if (errors > 0) {
                showModal('warning', 'Parsing Completed with Warnings', `Successfully parsed ${parsed.length} VMs, but skipped ${errors} row(s) because of missing required fields.`);
            }
        }
    };

    // Subnet mapping resolution check helper
    const resolveSubnet = (ipAddress) => {
        if (!ipAddress) return null;
        const parts = ipAddress.split('.');
        if (parts.length !== 4) return null;
        const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
        return ipSwitchMap.find(item => item.subnetPrefix === prefix) || null;
    };

    // Trigger VM deploy execution
    const handleDeployVMs = async () => {
        if (parsedVms.length === 0) return;

        const hasWindowsVM = parsedVms.some(vm => {
            const os = vm.OS || '';
            return !os.match(/linux|ubuntu|centos|rhel|redhat|debian|rocky|alma|suse|sles|oel|oracle/i);
        });

        if (hasWindowsVM && !localAdminPassword) {
            showModal(
                'warning',
                'Local Password Required',
                'Please enter a local Administrator password to be customized within Sysprep.'
            );
            return;
        }

        // Every VM needs an environment from Settings -> Environments (checked again server-side before any clone starts)
        const envMissing = parsedVms.filter(vm => vm.envError || !vm.Env);
        if (envMissing.length > 0) {
            showModal('error', 'Environment Required', `Cannot deploy. ${envMissing.length} VM(s) (${envMissing.map(v => `${v.Name}: ${v.envError || 'Environment is required'}`).join('; ')}) need an environment from Settings -> Environments. Choose one in the ENV column.`);
            return;
        }

        // Validate that all subnets can be successfully resolved against ipSwitchMap
        const unmapped = parsedVms.filter(vm => !resolveSubnet(vm.IP));
        if (unmapped.length > 0) {
            showModal('error', 'Unresolved Subnets', `Cannot deploy. ${unmapped.length} VM(s) (${unmapped.map(v => v.Name).join(', ')}) have IP subnets that are not mapped in the IP Switch Mapping configuration.`);
            return;
        }

        // Validate that backend credentials are all set
        if (settingsCheck.isPeMode) {
            if (hasWindowsVM) {
                if (!settingsCheck.peIp || !settingsCheck.peAccount || !settingsCheck.pePwd || !settingsCheck.adUser || !settingsCheck.adPwd || !settingsCheck.adDomain) {
                    showModal('error', 'Credentials Missing', 'Nutanix Prism Element, AD Domain Admin credentials, or ALLOWED_AD_DOMAIN are not configured in system settings. Please setup settings first.');
                    return;
                }
            } else {
                if (!settingsCheck.peIp || !settingsCheck.peAccount || !settingsCheck.pePwd) {
                    showModal('error', 'Credentials Missing', 'Nutanix Prism Element credentials are not configured in system settings. Please setup settings first.');
                    return;
                }
            }
        } else {
            if (hasWindowsVM) {
                if (!settingsCheck.pcIp || !settingsCheck.pcAccount || !settingsCheck.pcPwd || !settingsCheck.adUser || !settingsCheck.adPwd || !settingsCheck.adDomain) {
                    showModal('error', 'Credentials Missing', 'Nutanix Prism Central, AD Domain Admin credentials, or ALLOWED_AD_DOMAIN are not configured in system settings. Please setup settings first.');
                    return;
                }
            } else {
                if (!settingsCheck.pcIp || !settingsCheck.pcAccount || !settingsCheck.pcPwd) {
                    showModal('error', 'Credentials Missing', 'Nutanix Prism Central credentials are not configured in system settings. Please setup settings first.');
                    return;
                }
            }
        }

        // Custom modal confirmation instead of browser confirm()
        showModal('confirm', 'Confirm VM Provisioning', `Are you absolutely sure you want to spawn the parallel deployment of ${parsedVms.length} VMs on Nutanix? This will launch a headless powershell task in the background.`, async () => {
            setIsDeploying(true);
            try {
                const res = await api.post('/nutanix/clone', { vms: parsedVms, localAdminPassword });
                if (res.data.success) {
                    showModal('success', 'Deployment Started', 'VM provisioning task has successfully launched in the background. You can monitor the system output in the console below.');
                    setParsedVms([]);
                    setRawExcel('');
                    checkTaskStatus();
                }
            } catch (err) {
                showModal('error', 'Deployment Failed', err.response?.data?.error || err.message);
            } finally {
                setIsDeploying(false);
            }
        });
    };

    // --- Tab 2: IP Switch Mapping Operations ---
    const handleEditMapping = (item) => {
        setEditingMap({ ...item });
    };

    const handleNewMapping = () => {
        setEditingMap({ subnetPrefix: '', ouLayer: '', cluster: '', zone: 'corp.example', dns1: '192.0.2.1', dns2: '192.0.2.2', vlan: '', clusterIp: '' });
    };

    const handleSaveMapping = () => {
        if (!editingMap.subnetPrefix || !editingMap.cluster || !editingMap.vlan || !editingMap.zone) {
            showModal('warning', 'Validation Error', 'Subnet Prefix, Cluster, DNS Zone and Target VLAN are required fields.');
            return;
        }
        
        // Verify format of Subnet Prefix
        const parts = editingMap.subnetPrefix.split('.');
        if (parts.length < 3 || parts.some(p => isNaN(p) || p === '')) {
            showModal('warning', 'Validation Error', 'Subnet prefix must consist of 3 octets (e.g. 10.99.25 or 172.20.1).');
            return;
        }

        const cleanPrefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
        const newRecord = { ...editingMap, subnetPrefix: cleanPrefix };

        let updated = [];
        const exists = ipSwitchMap.some(item => item.subnetPrefix === cleanPrefix);
        
        if (exists) {
            // Edit existing
            updated = ipSwitchMap.map(item => item.subnetPrefix === cleanPrefix ? newRecord : item);
        } else {
            // Create new
            updated = [...ipSwitchMap, newRecord];
        }

        saveIpSwitchMap(updated);
        setEditingMap(null);
    };

    const handleDeleteMapping = (prefix) => {
        showModal('confirm', 'Confirm Deletion', `Are you sure you want to delete the mapping for subnet "${prefix}"? This will prevent VMs on this subnet from being cloned.`, () => {
            const updated = ipSwitchMap.filter(item => item.subnetPrefix !== prefix);
            saveIpSwitchMap(updated);
        });
    };

    const filteredMap = ipSwitchMap.filter(item => {
        const query = searchQuery.toLowerCase();
        return (
            item.subnetPrefix.toLowerCase().includes(query) ||
            item.cluster.toLowerCase().includes(query) ||
            item.vlan.toLowerCase().includes(query) ||
            item.zone.toLowerCase().includes(query) ||
            item.ouLayer.toLowerCase().includes(query)
        );
    });

    // --- Tab 3: Template-BU Mapping Operations ---
    const handleEditTemplateMapping = (item) => {
        const clusterVal = item.cluster || 'All';
        setEditingTemplateMap({ ...item, cluster: clusterVal, isNew: false });
        fetchTemplates(clusterVal === 'All' ? '' : clusterVal);
    };

    const handleNewTemplateMapping = () => {
        const defaultCluster = clusters.length > 0 ? clusters[0] : 'All';
        setEditingTemplateMap({ os: 'Redhat Ent 9.7', bu: 'Default', template: '', cluster: defaultCluster, isNew: true });
        fetchTemplates(defaultCluster === 'All' ? '' : defaultCluster);
    };

    const handleSaveTemplateMapping = () => {
        if (!editingTemplateMap.os || !editingTemplateMap.bu || !editingTemplateMap.template) {
            showModal('warning', 'Validation Error', 'OS, BU, and Template are required fields.');
            return;
        }

        const newRecord = { 
            os: editingTemplateMap.os.trim(), 
            bu: editingTemplateMap.bu.trim(), 
            cluster: (editingTemplateMap.cluster || 'All').trim(),
            template: editingTemplateMap.template.trim() 
        };

        let updated = [];
        const exists = templateBuMap.some(item => 
            item.os.toLowerCase() === newRecord.os.toLowerCase() && 
            item.bu.toLowerCase() === newRecord.bu.toLowerCase() &&
            (item.cluster || 'All').toLowerCase() === newRecord.cluster.toLowerCase()
        );

        if (editingTemplateMap.isNew) {
            if (exists) {
                showModal('warning', 'Duplicate Entry', `A mapping for OS "${newRecord.os}", BU "${newRecord.bu}", and Cluster "${newRecord.cluster}" already exists. Please edit the existing entry instead.`);
                return;
            }
            updated = [...templateBuMap, newRecord];
        } else {
            updated = templateBuMap.map(item => 
                (item.os.toLowerCase() === editingTemplateMap.os.toLowerCase() && 
                 item.bu.toLowerCase() === editingTemplateMap.bu.toLowerCase() &&
                 (item.cluster || 'All').toLowerCase() === (editingTemplateMap.cluster || 'All').toLowerCase()) 
                ? newRecord 
                : item
            );
        }

        saveTemplateBuMap(updated);
        setEditingTemplateMap(null);
    };

    const handleDeleteTemplateMapping = (itemToDelete) => {
        const clusterLabel = itemToDelete.cluster || 'All';
        showModal('confirm', 'Confirm Deletion', `Are you sure you want to delete the mapping for OS "${itemToDelete.os}", BU "${itemToDelete.bu}" on Cluster "${clusterLabel}"?`, () => {
            const updated = templateBuMap.filter(item => 
                !(item.os.toLowerCase() === itemToDelete.os.toLowerCase() && 
                  item.bu.toLowerCase() === itemToDelete.bu.toLowerCase() &&
                  (item.cluster || 'All').toLowerCase() === (itemToDelete.cluster || 'All').toLowerCase())
            );
            saveTemplateBuMap(updated);
        });
    };

    const filteredTemplateMap = (templateBuMap || []).filter(item => {
        const query = searchTemplateQuery.toLowerCase();
        return (
            (item.os || '').toLowerCase().includes(query) ||
            (item.bu || '').toLowerCase().includes(query) ||
            (item.cluster || '').toLowerCase().includes(query) ||
            (item.template || '').toLowerCase().includes(query)
        );
    });

    return (
        <div style={S.container}>
            {/* Custom Modal for alert/confirm replacements */}
            {modal.show && (
                <div style={S.modalOverlay}>
                    <div style={S.modalContent}>
                        <div style={S.modalHeader}>
                            <h3 style={S.modalTitle}>
                                {modal.type === 'error' && '❌ '}
                                {modal.type === 'success' && '✅ '}
                                {modal.type === 'warning' && '⚠️ '}
                                {modal.type === 'confirm' && '❓ '}
                                {modal.title}
                            </h3>
                            <button style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: 16, cursor: 'pointer' }} onClick={closeModal}>✕</button>
                        </div>
                        <div style={S.modalBody}>{modal.message}</div>
                        <div style={S.modalFooter}>
                            {modal.onConfirm ? (
                                <>
                                    <button style={S.btnO} onClick={closeModal}>Cancel</button>
                                    <button style={S.btnP} onClick={() => { modal.onConfirm(); closeModal(); }}>Confirm</button>
                                </>
                            ) : (
                                <button style={S.btnP} onClick={closeModal}>OK</button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Header */}
            <div style={S.header}>
                <div style={S.titleArea}>
                    <h1 style={S.title}>🖥️ Nutanix VM Provisioning Workspace</h1>
                    <p style={S.subtitle}>Headless batch VM deployment, customization, and IP switch auto-resolution</p>
                </div>
                <button style={S.backBtn} onClick={onClose}>
                    ◀ Back to VM List
                </button>
            </div>

            {/* Tab Navigation */}
            <div style={S.tabs}>
                <button 
                    style={{ ...S.tab, ...(activeTab === 'provision' ? S.activeTab : {}) }} 
                    onClick={() => setActiveTab('provision')}
                >
                    🖥️ VM Provisioning Console
                </button>
                {role === 'SuperAdmin' && (
                    <>
                        <button 
                            style={{ ...S.tab, ...(activeTab === 'mapping' ? S.activeTab : {}) }} 
                            onClick={() => setActiveTab('mapping')}
                        >
                            🔀 IP Switch Mapping Manager ({ipSwitchMap.length})
                        </button>
                        <button 
                            style={{ ...S.tab, ...(activeTab === 'template-bu' ? S.activeTab : {}) }} 
                            onClick={() => setActiveTab('template-bu')}
                        >
                            📋 Template BU Mapping Manager ({templateBuMap.length})
                        </button>
                    </>
                )}
            </div>

            {/* --- VM PROVISIONING TAB --- */}
            {activeTab === 'provision' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    <div style={S.row}>
                        {/* Left Control Panel */}
                        <div style={{ ...S.col, flex: 2, minWidth: 400 }}>
                            <div style={S.panel}>
                                <h3 style={S.panelTitle}>📋 Paste Excel Specifications</h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    <div>
                                        <label style={S.label}>Copy columns directly from your deployment Excel and paste them here:</label>
                                        <textarea 
                                            placeholder="Paste Excel columns:&#10;Zone	Hostname	IP	vCPU	Mem	Disk	OS	Platform	Application	BU&#10;Example:&#10;TRUST	JL-TRS-K01WRK010	192.0.2.10			16 vCPU	32	VM_280GB (/:71GB, /boot:1GB, swap:8GB)(/var/lib/docker:100GB, /var/lib/kubelet:100GB)	Redhat Ent 9.7	JULY-CLUSTER-02	K8S Worker - ATS	TRS" 
                                            style={S.textarea}
                                            value={rawExcel}
                                            onChange={e => setRawExcel(e.target.value)}
                                            disabled={taskStatus.running}
                                        />
                                    </div>
                                    <div style={{ display: 'flex', gap: 12 }}>
                                        <button style={S.btnP} onClick={handleParseExcel} disabled={taskStatus.running}>
                                            📊 Parse and Resolve Subnets
                                        </button>
                                        {parsedVms.length > 0 && (
                                            <button style={S.btnO} onClick={() => setParsedVms([])} disabled={taskStatus.running}>
                                                ✕ Clear Parsed
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {parsedVms.length > 0 && (
                                <div style={S.panel}>
                                    <h3 style={S.panelTitle}>🔑 Deployment Customization</h3>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                        <div>
                                            <label style={S.label}>
                                                Windows template local admin password {isLinuxOnly ? (
                                                    <span style={{ color: 'var(--text-muted)', fontWeight: 'normal' }}>(Optional)</span>
                                                ) : (
                                                    <span style={{ color: 'var(--danger)', fontWeight: 900, fontSize: '13px' }}>(Required)</span>
                                                )}:
                                            </label>
                                            <input 
                                                type="password" 
                                                placeholder={isLinuxOnly ? "Not required for Linux (Cloud-Init uses default secure root)..." : "Enter local Administrator password..."} 
                                                style={S.input}
                                                value={localAdminPassword}
                                                onChange={e => setLocalAdminPassword(e.target.value)}
                                                disabled={taskStatus.running}
                                            />
                                            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                                                ⚠️ Password will be decrypted locally only for Windows Sysprep setup, then purged immediately on exit.
                                            </span>
                                        </div>
                                        
                                        <button 
                                            style={{ 
                                                ...S.btnP, 
                                                width: '100%', 
                                                height: 44, 
                                                fontSize: 14, 
                                                opacity: (isDeploying || taskStatus.running || (!isLinuxOnly && !localAdminPassword.trim())) ? 0.5 : 1,
                                                cursor: (isDeploying || taskStatus.running || (!isLinuxOnly && !localAdminPassword.trim())) ? 'not-allowed' : 'pointer'
                                            }} 
                                            onClick={handleDeployVMs}
                                            disabled={isDeploying || taskStatus.running || (!isLinuxOnly && !localAdminPassword.trim())}
                                        >
                                            {isDeploying ? '🚀 Dispatching Task...' : `🚀 Start Parallel VM Cloning (${parsedVms.length} VMs)`}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Right Parameters Check Status */}
                        <div style={{ ...S.col, flex: 1 }}>
                            <div style={S.panel}>
                                <h3 style={S.panelTitle}>🛡️ Shared Credentials Integration</h3>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                    <div style={S.credCard}>
                                        <div>
                                            <div style={{ fontWeight: 800, fontSize: 13 }}>
                                                {settingsCheck.isPeMode ? 'Nutanix Prism Element' : 'Nutanix Prism Central'}
                                            </div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                                {settingsCheck.isPeMode ? (settingsCheck.peIpValue || 'Not configured') : (settingsCheck.pcIpValue || 'Not configured')}
                                            </div>
                                        </div>
                                        <span style={
                                            (settingsCheck.isPeMode 
                                                ? (settingsCheck.peIp && settingsCheck.peAccount && settingsCheck.pePwd)
                                                : (settingsCheck.pcIp && settingsCheck.pcAccount && settingsCheck.pcPwd)
                                            ) ? S.badgeSuccess : S.badgeDanger
                                        }>
                                            {(settingsCheck.isPeMode 
                                                ? (settingsCheck.peIp && settingsCheck.peAccount && settingsCheck.pePwd)
                                                : (settingsCheck.pcIp && settingsCheck.pcAccount && settingsCheck.pcPwd)
                                            ) ? '🟢 READY' : '🔴 MISSING'}
                                        </span>
                                    </div>

                                    <div style={{ ...S.credCard, opacity: isLinuxOnly ? 0.7 : 1 }}>
                                        <div>
                                            <div style={{ fontWeight: 800, fontSize: 13 }}>AD Domain Admin</div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{settingsCheck.adUserValue || 'Not configured'}</div>
                                        </div>
                                        {isLinuxOnly ? (
                                            <span style={{ ...S.badgeSuccess, backgroundColor: 'rgba(74, 222, 128, 0.1)', color: '#4ade80', borderColor: 'rgba(74, 222, 128, 0.2)' }}>
                                                🟢 NOT REQUIRED
                                            </span>
                                        ) : (
                                            <span style={settingsCheck.adUser && settingsCheck.adPwd ? S.badgeSuccess : S.badgeDanger}>
                                                {settingsCheck.adUser && settingsCheck.adPwd ? '🟢 READY' : '🔴 MISSING'}
                                            </span>
                                        )}
                                    </div>

                                    <div style={{ ...S.credCard, opacity: isLinuxOnly ? 0.7 : 1 }}>
                                        <div>
                                            <div style={{ fontWeight: 800, fontSize: 13 }}>AD Domain (Trust)</div>
                                            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{settingsCheck.adDomainValue || 'Not configured'}</div>
                                        </div>
                                        {isLinuxOnly ? (
                                            <span style={{ ...S.badgeSuccess, backgroundColor: 'rgba(74, 222, 128, 0.1)', color: '#4ade80', borderColor: 'rgba(74, 222, 128, 0.2)' }}>
                                                🟢 NOT REQUIRED
                                            </span>
                                        ) : (
                                            <span style={settingsCheck.adDomain ? S.badgeSuccess : S.badgeDanger}>
                                                {settingsCheck.adDomain ? '🟢 READY' : '🔴 MISSING'}
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginTop: 12 }}>
                                    ℹ️ Shared parameters can be configured under the main settings panel on the navigation sidebar.
                                </span>
                            </div>
                        </div>
                    </div>

                    {/* Parsed List Preview Grid */}
                    {parsedVms.length > 0 && (
                        <div style={S.panel}>
                            <h3 style={S.panelTitle}>🔍 Parsed Specifications Preview ({parsedVms.length} rows)</h3>
                            <div style={{ overflowX: 'auto' }}>
                                <table style={S.tbl}>
                                    <thead>
                                        <tr>
                                            <th style={S.th}>ENV</th>
                                            <th style={S.th}>ZONE</th>
                                            <th style={S.th}>VM NAME</th>
                                            <th style={S.th}>IP ADDRESS</th>
                                            <th style={S.th}>COMPUTE</th>
                                            <th style={S.th}>DISKS</th>
                                            <th style={S.th}>OS / BU</th>
                                            <th style={S.th}>APPLICATION</th>
                                            <th style={S.th}>MAPPED SUBNET</th>
                                            <th style={S.th}>TARGET CLUSTER</th>
                                            <th style={S.th}>STATUS</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {parsedVms.map((vm, idx) => {
                                            const match = resolveSubnet(vm.IP);
                                            return (
                                                <tr key={idx} style={S.tr}>
                                                    <td style={S.td}>
                                                        <select
                                                            style={{ ...S.input, padding: '6px 8px', minWidth: 120, borderColor: vm.envError ? 'var(--danger)' : 'var(--border-color)' }}
                                                            value={vm.envError ? '' : vm.Env}
                                                            onChange={e => setVmEnv(idx, e.target.value)}
                                                            title={vm.envError || ''}
                                                        >
                                                            <option value="">Choose...</option>
                                                            {envs.map(env => <option key={env.id} value={env.name}>{env.name}</option>)}
                                                        </select>
                                                        {vm.envError && <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 4 }}>{vm.envError}</div>}
                                                    </td>
                                                    <td style={{ ...S.td, fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>{vm.Zone || '-'}</td>
                                                    <td style={{ ...S.td, fontWeight: 800, color: 'var(--accent-primary)' }}>{vm.Name}</td>
                                                    <td style={{ ...S.td, fontFamily: 'monospace' }}>{vm.IP}</td>
                                                    <td style={S.td}>vCPU: <strong>{vm.NumCore}</strong>, RAM: <strong>{vm.MemoryGB}G</strong></td>
                                                    <td style={S.td}>
                                                        <div style={{ fontWeight: 800, color: 'var(--text-primary)' }}>
                                                            {vm.DiskInfo?.Total ? `${vm.DiskInfo.Total}GB` : 'Default'}
                                                        </div>
                                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                                            {vm.DiskInfo?.Display || (vm.DiskInfo?.Disks?.length > 0 ? vm.DiskInfo.Disks.map(d => `${d.letter}:${d.size}GB`).join(' / ') : '-')}
                                                        </div>
                                                    </td>
                                                    <td style={S.td}>
                                                        <span style={{ marginRight: 6, fontWeight: 700 }}>{vm.OS}</span>
                                                        <span style={{ fontSize: 11, opacity: 0.7 }}>[{vm.BU}]</span>
                                                    </td>
                                                    <td style={{ ...S.td, fontSize: 11 }}>{vm.Application || '-'}</td>
                                                    <td style={S.td}>{match ? match.vlan : <span style={{ color: 'var(--danger)' }}>None</span>}</td>
                                                    <td style={S.td}>{vm.Platform || (match ? match.cluster : <span style={{ color: 'var(--danger)' }}>None</span>)}</td>
                                                    <td style={S.td}>
                                                        {match ? (
                                                            <span style={S.badgeSuccess}>✓ Resolved</span>
                                                        ) : (
                                                            <span style={S.badgeDanger}>⚠️ Subnet Unmapped</span>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Console Live Terminal */}
                    {(taskStatus.running || logContent) && (
                        <div style={S.panel}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                <h3 style={{ ...S.panelTitle, marginBottom: 0 }}>
                                    📟 Live Headless System Deployment Terminal
                                    {taskStatus.running && <span style={S.pulseDot} />}
                                </h3>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                        {taskStatus.running ? '🟢 Parallel deployment active (Throttle Limit 5)' : '⚪ Task execution idle'}
                                    </span>
                                    <button style={{ ...S.btnO, padding: '4px 10px', fontSize: 11 }} onClick={fetchLogs}>
                                        🔄 Reload Log
                                    </button>
                                </div>
                            </div>
                            <div style={S.terminal}>
                                {logContent ? (
                                    logContent.split('\n').map((line, idx) => (
                                        <div key={idx} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line}</div>
                                    ))
                                ) : (
                                    <div style={{ color: 'var(--text-muted)' }}>Initializing parallel execution engines... Logs will begin piping shortly.</div>
                                )}
                                <div ref={termEndRef} />
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* --- IP SWITCH MAPPING TAB --- */}
            {activeTab === 'mapping' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {editingMap ? (
                        <div style={S.panel}>
                            <h3 style={S.panelTitle}>
                                {editingMap.subnetPrefix ? `📝 Edit Subnet: ${editingMap.subnetPrefix}` : '➕ Add New Subnet Switch Map'}
                            </h3>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px 24px', marginBottom: 8 }}>
                                    {/* Row 1 / Col 1 */}
                                    <div>
                                        <label style={S.label}>Subnet IP Prefix (First 3 octets, e.g. 10.99.25):</label>
                                        <input 
                                            type="text" 
                                            placeholder="e.g. 10.99.25" 
                                            style={S.input}
                                            value={editingMap.subnetPrefix}
                                            onChange={e => setEditingMap(prev => ({ ...prev, subnetPrefix: e.target.value }))}
                                            disabled={!!editingMap.subnetPrefix && ipSwitchMap.some(i => i.subnetPrefix === editingMap.subnetPrefix)}
                                        />
                                    </div>

                                    {/* Row 1 / Col 2 */}
                                    <div>
                                        <label style={S.label}>Target VLAN Name (Must match Nutanix subnet exactly):</label>
                                        <input 
                                            type="text" 
                                            placeholder="e.g. VLAN725-br1" 
                                            style={S.input}
                                            value={editingMap.vlan}
                                            onChange={e => setEditingMap(prev => ({ ...prev, vlan: e.target.value }))}
                                        />
                                    </div>

                                    {/* Row 1 / Col 3 */}
                                    <div>
                                        <label style={S.label}>Nutanix Destination Cluster (e.g. MGT-CLUSTER-01):</label>
                                        <input 
                                            type="text" 
                                            placeholder="e.g. MGT-CLUSTER-01" 
                                            style={S.input}
                                            value={editingMap.cluster}
                                            onChange={e => setEditingMap(prev => ({ ...prev, cluster: e.target.value }))}
                                        />
                                    </div>

                                    {/* Row 2 / Col 1 & 2 (Spans 2 columns) */}
                                    <div style={{ gridColumn: 'span 2' }}>
                                        <label style={S.label}>AD OU Full Path (Full DN, e.g. OU=DMZ,OU=SUN,OU=Servers,OU=TWDC,DC=trz,DC=prd):</label>
                                        <input 
                                            type="text" 
                                            placeholder="e.g. OU=DMZ,OU=SUN,OU=Servers,OU=TWDC,DC=trz,DC=prd" 
                                            style={S.input}
                                            value={editingMap.ouLayer}
                                            onChange={e => setEditingMap(prev => ({ ...prev, ouLayer: e.target.value }))}
                                        />
                                    </div>

                                    {/* Row 2 / Col 3 */}
                                    <div>
                                        <label style={S.label}>Destination Cluster IP (PE IP for Clone VM routing):</label>
                                        <input 
                                            type="text" 
                                            placeholder="e.g. 192.168.10.15" 
                                            style={S.input}
                                            value={editingMap.clusterIp || ''}
                                            onChange={e => setEditingMap(prev => ({ ...prev, clusterIp: e.target.value }))}
                                        />
                                    </div>

                                    {/* Row 3 / Col 1 */}
                                    <div>
                                        <label style={S.label}>Active Directory Join Zone (Domain, e.g. corp.example):</label>
                                        <input 
                                            type="text" 
                                            placeholder="e.g. corp.example" 
                                            style={S.input}
                                            value={editingMap.zone}
                                            onChange={e => setEditingMap(prev => ({ ...prev, zone: e.target.value }))}
                                        />
                                    </div>

                                    {/* Row 3 / Col 2 */}
                                    <div>
                                        <label style={S.label}>Primary DNS Server (e.g. 198.51.100.1):</label>
                                        <input 
                                            type="text" 
                                            placeholder="Primary DNS" 
                                            style={S.input}
                                            value={editingMap.dns1}
                                            onChange={e => setEditingMap(prev => ({ ...prev, dns1: e.target.value }))}
                                        />
                                    </div>

                                    {/* Row 3 / Col 3 */}
                                    <div>
                                        <label style={S.label}>Secondary DNS Server (e.g. 198.51.100.2):</label>
                                        <input 
                                            type="text" 
                                            placeholder="Secondary DNS" 
                                            style={S.input}
                                            value={editingMap.dns2}
                                            onChange={e => setEditingMap(prev => ({ ...prev, dns2: e.target.value }))}
                                        />
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                                    <button style={S.btnO} onClick={() => setEditingMap(null)}>✕ Cancel</button>
                                    <button style={S.btnP} onClick={handleSaveMapping}>💾 Save Mapping</button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div style={S.panel}>
                            <div style={S.searchBar}>
                                <div style={{ ...S.input, flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 14px' }}>
                                    <span style={{ color: 'var(--text-muted)' }}>🔍</span>
                                    <input 
                                        type="text" 
                                        placeholder="Search mappings by Subnet, VLAN, Cluster..." 
                                        style={{ border: 'none', background: 'transparent', outline: 'none', color: '#fff', fontSize: 13, width: '100%', padding: '6px 0' }}
                                        value={searchQuery}
                                        onChange={e => setSearchQuery(e.target.value)}
                                    />
                                </div>
                                <button style={S.btnP} onClick={handleNewMapping}>
                                    ➕ Add Subnet Mapping
                                </button>
                            </div>

                            <div style={{ overflowX: 'auto' }}>
                                <table style={S.tbl}>
                                    <thead>
                                        <tr>
                                            <th style={S.th}>SUBNET PREFIX</th>
                                            <th style={S.th}>TARGET VLAN NAME</th>
                                            <th style={S.th}>NUTANIX CLUSTER</th>
                                            <th style={S.th}>AD OU LAYER</th>
                                            <th style={S.th}>JOIN DOMAIN</th>
                                            <th style={S.th}>DNS SERVERS</th>
                                            <th style={{ ...S.th, textAlign: 'center' }}>ACTIONS</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredMap.length === 0 ? (
                                            <tr>
                                                <td colSpan="7" style={{ ...S.td, textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                                                    No subnet switch mappings found.
                                                </td>
                                            </tr>
                                        ) : (
                                            filteredMap.map((item, idx) => (
                                                <tr key={idx} style={S.tr}>
                                                    <td style={{ ...S.td, fontWeight: 800, color: 'var(--accent-primary)', fontFamily: 'monospace' }}>
                                                        {item.subnetPrefix}.0/24
                                                    </td>
                                                    <td style={{ ...S.td, fontWeight: 700 }}>{item.vlan}</td>
                                                    <td style={S.td}>{item.cluster}</td>
                                                    <td style={{ ...S.td, color: 'var(--text-secondary)' }} title={item.ouLayer}>{formatOuDisplay(item.ouLayer)}</td>
                                                    <td style={S.td}>{item.zone}</td>
                                                    <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11 }}>
                                                        {item.dns1}, {item.dns2}
                                                    </td>
                                                    <td style={{ ...S.td, textAlign: 'center' }}>
                                                        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                                                            <button 
                                                                style={{ ...S.btnO, padding: '4px 10px', fontSize: 11, borderRadius: 6 }} 
                                                                onClick={() => handleEditMapping(item)}
                                                            >
                                                                ✏️ Edit
                                                            </button>
                                                            <button 
                                                                style={{ ...S.btnDanger, padding: '4px 10px', fontSize: 11, borderRadius: 6 }} 
                                                                onClick={() => handleDeleteMapping(item.subnetPrefix)}
                                                            >
                                                                ✕ Delete
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* --- TEMPLATE BU MAPPING TAB --- */}
            {activeTab === 'template-bu' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {editingTemplateMap ? (
                        <div style={S.panel}>
                            <h3 style={S.panelTitle}>
                                {!editingTemplateMap.isNew ? `📝 Edit Template BU Mapping: OS [${editingTemplateMap.os}] BU [${editingTemplateMap.bu}] Cluster [${editingTemplateMap.cluster || 'All'}]` : '➕ Add New Template BU Mapping'}
                            </h3>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                                <div style={S.row}>
                                    <div style={{ ...S.col, flex: 1 }}>
                                        <div>
                                            <label style={S.label}>Operating System (e.g. W2K16, W2K19, Redhat Ent 9.7):</label>
                                            <input 
                                                type="text" 
                                                placeholder="e.g. Redhat Ent 9.7 or W2K19" 
                                                style={S.input}
                                                value={editingTemplateMap.os}
                                                onChange={e => setEditingTemplateMap(prev => ({ ...prev, os: e.target.value }))}
                                                disabled={!editingTemplateMap.isNew}
                                            />
                                        </div>
                                        <div>
                                            <label style={S.label}>Business Unit (BU) Name (e.g. 188, DBA, or Default):</label>
                                            <input 
                                                type="text" 
                                                placeholder="e.g. 188 or Default" 
                                                style={S.input}
                                                value={editingTemplateMap.bu}
                                                onChange={e => setEditingTemplateMap(prev => ({ ...prev, bu: e.target.value }))}
                                                disabled={!editingTemplateMap.isNew}
                                            />
                                        </div>
                                    </div>

                                    <div style={{ ...S.col, flex: 1 }}>
                                        <div>
                                            <label style={S.label}>Step 1: Select Nutanix Cluster:</label>
                                            {isLoadingClusters ? (
                                                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '10px 14px' }}>
                                                    🔄 Fetching VM cluster from {settingsCheck.isPeMode ? 'Prism Element' : 'Prism Central'}...
                                                </div>
                                            ) : (
                                                <select
                                                    style={{ ...S.input, height: 40, background: 'rgba(15, 23, 42, 0.8)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: 8 }}
                                                    value={editingTemplateMap.cluster || 'All'}
                                                    disabled={!editingTemplateMap.isNew}
                                                    onChange={e => {
                                                        const selectedCluster = e.target.value;
                                                        setEditingTemplateMap(prev => ({ ...prev, cluster: selectedCluster, template: '' }));
                                                        fetchTemplates(selectedCluster === 'All' ? '' : selectedCluster);
                                                    }}
                                                >
                                                    <option value="All" style={{ background: '#1e293b', color: '#38bdf8', fontWeight: 'bold' }}>🌐 All Clusters (Global Fallback)</option>
                                                    {clusters.map((c, idx) => (
                                                        <option key={idx} value={c} style={{ background: '#1e293b', color: '#fff' }}>🏢 {c}</option>
                                                    ))}
                                                </select>
                                            )}
                                        </div>

                                        <div>
                                            <label style={S.label}>Step 2: Target Template VM (dropdown selection):</label>
                                            {isLoadingTemplates ? (
                                                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '10px 14px' }}>
                                                    🔄 Fetching VM templates from {settingsCheck.isPeMode ? 'Prism Element' : 'Prism Central'}...
                                                </div>
                                             ) : templates.length > 0 ? (
                                                <select
                                                    style={{ ...S.input, height: 40, background: 'rgba(15, 23, 42, 0.8)', border: '1px solid var(--border-color)', color: '#fff', borderRadius: 8 }}
                                                    value={editingTemplateMap.template || ''}
                                                    onChange={e => setEditingTemplateMap(prev => ({ ...prev, template: e.target.value }))}
                                                >
                                                    <option value="" disabled>-- Select a Template VM --</option>
                                                    {templates.map((t, idx) => (
                                                        <option key={idx} value={t} style={{ background: '#1e293b', color: '#fff' }}>{t}</option>
                                                    ))}
                                                </select>
                                            ) : (
                                                <div style={{ color: 'var(--text-muted)', fontSize: 12, padding: '8px 12px', border: '1px dashed var(--border-color)', borderRadius: 8, background: 'rgba(255,255,255,0.01)' }}>
                                                    ⚠️ {editingTemplateMap.cluster && editingTemplateMap.cluster !== 'All' ? `No templates starting with "Template_" found in cluster "${editingTemplateMap.cluster}".` : 'Please select a cluster above to load its templates.'}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                                    <button style={S.btnO} onClick={() => setEditingTemplateMap(null)}>✕ Cancel</button>
                                    <button style={S.btnP} onClick={handleSaveTemplateMapping}>💾 Save Mapping</button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div style={S.panel}>
                            <div style={S.searchBar}>
                                <div style={{ ...S.input, flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '4px 14px' }}>
                                    <span style={{ color: 'var(--text-muted)' }}>🔍</span>
                                    <input 
                                        type="text" 
                                        placeholder="Search mappings by OS, BU, Cluster, or Template VM..." 
                                        style={{ border: 'none', background: 'transparent', outline: 'none', color: '#fff', fontSize: 13, width: '100%', padding: '6px 0' }}
                                        value={searchTemplateQuery}
                                        onChange={e => setSearchTemplateQuery(e.target.value)}
                                    />
                                </div>
                                <button style={{ ...S.btnO, marginRight: 4, display: 'flex', gap: 6, alignItems: 'center' }} onClick={() => fetchTemplates(editingTemplateMap?.cluster === 'All' ? '' : editingTemplateMap?.cluster)} disabled={isLoadingTemplates}>
                                    🔄 Refresh Templates
                                </button>
                                <button style={S.btnP} onClick={handleNewTemplateMapping}>
                                    ➕ Add Template BU Mapping
                                </button>
                            </div>

                            <div style={{ overflowX: 'auto' }}>
                                <table style={S.tbl}>
                                    <thead>
                                        <tr>
                                            <th style={S.th}>OPERATING SYSTEM</th>
                                            <th style={S.th}>BUSINESS UNIT (BU)</th>
                                            <th style={S.th}>NUTANIX CLUSTER</th>
                                            <th style={S.th}>NUTANIX TEMPLATE VM NAME</th>
                                            <th style={{ ...S.th, textAlign: 'center' }}>ACTIONS</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredTemplateMap.length === 0 ? (
                                             <tr>
                                                 <td colSpan="5" style={{ ...S.td, textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                                                     No Template BU mappings found.
                                                 </td>
                                             </tr>
                                         ) : (
                                            filteredTemplateMap.map((item, idx) => (
                                                <tr key={idx} style={S.tr}>
                                                    <td style={{ ...S.td, fontWeight: 800, color: 'var(--accent-primary)' }}>
                                                        {item.os}
                                                    </td>
                                                    <td style={{ ...S.td, fontWeight: 700 }}>
                                                        {item.bu === 'Default' ? (
                                                            <span style={S.badgeSuccess}>Default Fallback</span>
                                                        ) : (
                                                            item.bu
                                                        )}
                                                    </td>
                                                    <td style={S.td}>
                                                        {item.cluster && item.cluster !== 'All' ? (
                                                            <span style={{ fontWeight: 700, color: '#38bdf8' }}>🏢 {item.cluster}</span>
                                                        ) : (
                                                            <span style={S.badgeSuccess}>🌐 All Clusters (Global)</span>
                                                        )}
                                                    </td>
                                                    <td style={{ ...S.td, fontFamily: 'monospace' }}>{item.template}</td>
                                                    <td style={{ ...S.td, textAlign: 'center' }}>
                                                        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                                                            <button 
                                                                style={{ ...S.btnO, padding: '4px 10px', fontSize: 11, borderRadius: 6 }} 
                                                                onClick={() => handleEditTemplateMapping(item)}
                                                            >
                                                                ✏️ Edit
                                                            </button>
                                                            <button 
                                                                style={{ ...S.btnDanger, padding: '4px 10px', fontSize: 11, borderRadius: 6 }} 
                                                                onClick={() => handleDeleteTemplateMapping(item)}
                                                            >
                                                                ✕ Delete
                                                            </button>
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default NutanixCloneVM;
