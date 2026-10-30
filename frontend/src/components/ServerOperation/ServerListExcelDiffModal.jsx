import React, { useState, useMemo, useEffect } from 'react';
import { 
    FiX, FiCheck, FiAlertTriangle, FiRefreshCw, FiDownload, 
    FiFilter, FiSearch, FiLayers, FiCpu, FiHardDrive, FiServer, FiArrowRight 
} from 'react-icons/fi';
import api from '../../api';
import useEnvironments from '../../hooks/useEnvironments';
import { applyEnvValidation } from '../../utils/environments';

// Helper to parse disk specifications with bracketed partition sums and Windows drive letters
// e.g. "VM_200GB (C:100GB)(L:60GB)(X:40 GB)" or "VM_280GB (/:71GB, /boot:1GB, swap:8GB)(/var/lib/docker:100GB, /var/lib/kubelet:100GB)"
export function parseDiskSpecification(diskStr) {
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
}

// Helper for OS normalization and fuzzy matching (Red Hat Ent 9.7 vs RHEL 9.7 vs Red Hat Enterprise Linux 9.7)
export function normalizeOs(osStr) {
    if (!osStr) return { family: '', version: '', raw: '' };
    const str = String(osStr).toLowerCase().trim();

    let family = '';
    if (str.includes('red hat') || str.includes('redhat') || str.includes('rhel')) {
        family = 'rhel';
    } else if (str.includes('centos')) {
        family = 'centos';
    } else if (str.includes('ubuntu')) {
        family = 'ubuntu';
    } else if (str.includes('debian')) {
        family = 'debian';
    } else if (str.includes('rocky')) {
        family = 'rocky';
    } else if (str.includes('alma')) {
        family = 'alma';
    } else if (str.includes('suse') || str.includes('sles')) {
        family = 'suse';
    } else if (str.includes('oracle') || str.includes('oel')) {
        family = 'oracle';
    } else if (str.includes('win') || str.includes('w2k')) {
        family = 'windows';
    }

    let version = '';
    const winYearMatch = str.match(/(?:20\d{2}|2k\d{2})/i);
    if (winYearMatch) {
        let y = winYearMatch[0].toLowerCase();
        if (y.startsWith('2k')) y = '20' + y.slice(2);
        version = y;
    } else {
        const verMatch = str.match(/(\d+(?:\.\d+)?)/);
        if (verMatch) {
            version = verMatch[1];
        }
    }

    return { family, version, raw: str };
}

export function isOsMatch(osA, osB) {
    if (!osA || !osB) return false;
    const a = normalizeOs(osA);
    const b = normalizeOs(osB);

    if (a.family && b.family) {
        if (a.family !== b.family) return false;

        if (a.version && b.version) {
            const aMajor = a.version.split('.')[0];
            const bMajor = b.version.split('.')[0];
            if (a.version === b.version) return true;
            if (aMajor === bMajor && (!a.version.includes('.') || !b.version.includes('.'))) {
                return true;
            }
            return a.version === b.version;
        }
        return true;
    }

    return a.raw.includes(b.raw) || b.raw.includes(a.raw);
}

// Helper to parse pasted raw lines into structured objects
export function parseExcelRows(text) {
    if (!text || !text.trim()) return [];
    const lines = text.split(/\r?\n/).filter(line => line.trim() !== "");
    const parsed = [];

    lines.forEach(line => {
        const cols = line.split('\t');
        if (cols.length >= 7) {
            const ipColIdx = cols.findIndex(c => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(c.trim()));

            let env = ''; // no hard-coded default: empty keeps the server's current environment
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

                const cpuRaw = (cols[5] || '').replace(/\D/g, '');
                numCore = cpuRaw ? parseInt(cpuRaw, 10) : 4;

                const memRaw = (cols[6] || '').replace(/\D/g, '');
                memoryGB = memRaw ? parseInt(memRaw, 10) : 8;

                diskStr = (cols[7] || '').trim();
                os = (cols[8] || '').trim();
                zone = (cols[9] || '').trim(); // Platform is Zone in Server List
                application = (cols[10] || '').trim();
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

            if (name && ip) {
                const diskInfo = parseDiskSpecification(diskStr);
                parsed.push({
                    Env: env,
                    envName: env,
                    Name: name,
                    hostname: name,
                    IP: ip,
                    ip: ip,
                    NumCore: numCore,
                    cpuCores: numCore,
                    MemoryGB: memoryGB,
                    memoryGB: memoryGB,
                    MemoryMiB: memoryGB * 1024,
                    OS: os,
                    os: os,
                    BU: bu,
                    businessUnit: bu,
                    Zone: zone,
                    zone: zone,
                    Platform: zone,
                    platform: zone,
                    Application: application,
                    applicationName: application,
                    DiskInfo: diskInfo
                });
            }
        }
    });

    return parsed;
}

export default function ServerListExcelDiffModal({ isOpen, onClose, currentServers = [], onSyncSuccess, showToast }) {
    const [rawInput, setRawInput] = useState('');
    const [filterStatus, setFilterStatus] = useState('all'); // 'all' | 'diff' | 'new' | 'match'
    const [searchKeyword, setSearchKeyword] = useState('');
    const [selectedIps, setSelectedIps] = useState([]);
    const [isApplying, setIsApplying] = useState(false);
    const [hasParsed, setHasParsed] = useState(false);
    // IPs deleted from Server List: syncing these rows re-creates (restores) the server
    const [deletedIps, setDeletedIps] = useState(() => new Set());
    const envs = useEnvironments();

    useEffect(() => {
        if (!isOpen) return undefined;
        let cancelled = false;
        api.get('/server-list/deleted')
            .then(res => { if (!cancelled) setDeletedIps(new Set((res.data?.servers || []).map(d => String(d.ip).trim()))); })
            .catch(() => { if (!cancelled) setDeletedIps(new Set()); });
        return () => { cancelled = true; };
    }, [isOpen]);

    // Map existing servers by IP
    const serverMap = useMemo(() => {
        const map = new Map();
        currentServers.forEach(s => {
            if (s.ip) map.set(String(s.ip).trim(), s);
        });
        return map;
    }, [currentServers]);

    // Parse pasted rows; the environment column must be in Settings -> Environments (name, id or code)
    const parsedVms = useMemo(() => {
        return applyEnvValidation(parseExcelRows(rawInput), envs);
    }, [rawInput, envs]);

    // Run Diff comparison
    const diffResults = useMemo(() => {
        if (!parsedVms || parsedVms.length === 0) return [];

        return parsedVms.map(item => {
            const existing = serverMap.get(item.IP);
            const diffs = [];

            if (item.envError) {
                return {
                    status: existing ? 'diff' : 'new',
                    pasted: item,
                    existing: existing || null,
                    rejected: true,
                    diffs: [{ field: 'Environment', oldVal: existing ? (existing.envName || 'Unassigned') : 'Not in CMDB', newVal: `REJECTED: ${item.envError}` }]
                };
            }

            if (!existing) {
                return {
                    status: 'new', // New server not currently in Server List
                    pasted: item,
                    existing: null,
                    diffs: [{ field: 'Server Status', oldVal: 'Not in CMDB', newVal: 'New Server' }]
                };
            }

            // Compare Hostname (Case-insensitive & whitespace trimmed)
            const cleanNewHost = String(item.Name || '').toLowerCase().trim();
            const cleanOldHost = String(existing.hostname || '').toLowerCase().trim();
            const shortNewHost = cleanNewHost.split('.')[0];
            const shortOldHost = cleanOldHost.split('.')[0];

            if (cleanNewHost && cleanOldHost && cleanNewHost !== cleanOldHost && shortNewHost !== shortOldHost) {
                diffs.push({
                    field: 'Hostname',
                    oldVal: existing.hostname || 'None',
                    newVal: item.Name
                });
            }

            // Compare vCPU
            const oldCpu = Number(existing.cpuCores) || 0;
            const newCpu = Number(item.NumCore) || 0;
            if (newCpu > 0 && oldCpu > 0 && oldCpu !== newCpu) {
                diffs.push({
                    field: 'vCPU',
                    oldVal: `${oldCpu}C`,
                    newVal: `${newCpu}C`
                });
            }

            // Compare RAM
            const oldRam = Number(existing.memoryGB) || 0;
            const newRam = Number(item.MemoryGB) || 0;
            if (newRam > 0 && oldRam > 0 && oldRam !== newRam) {
                diffs.push({
                    field: 'Memory',
                    oldVal: `${oldRam}GB`,
                    newVal: `${newRam}GB`
                });
            }

            // Compare Total Disk
            const oldDisk = Number(existing.diskGB) || 0;
            const newDisk = Number(item.DiskInfo?.Total) || 0;
            if (newDisk > 0 && oldDisk > 0 && oldDisk !== newDisk) {
                diffs.push({
                    field: 'Disk',
                    oldVal: `${oldDisk}GB`,
                    newVal: `${newDisk}GB`
                });
            }

            // Compare OS with fuzzy matching (Red Hat Ent 9.7 vs RHEL 9.7 vs Red Hat Enterprise Linux 9.7)
            if (item.OS && existing.os && !isOsMatch(existing.os, item.OS)) {
                diffs.push({
                    field: 'OS',
                    oldVal: existing.os || 'None',
                    newVal: item.OS
                });
            }

            // Compare Environment (Col 0 in Excel)
            const oldEnv = existing.envName || existing.envId || '';
            if (item.Env && oldEnv && item.Env.toLowerCase() !== oldEnv.toLowerCase()) {
                diffs.push({
                    field: 'Environment',
                    oldVal: oldEnv || 'None',
                    newVal: item.Env
                });
            }

            // Compare Application
            if (item.Application && existing.applicationName && item.Application.toLowerCase() !== existing.applicationName.toLowerCase()) {
                diffs.push({
                    field: 'Application',
                    oldVal: existing.applicationName || 'None',
                    newVal: item.Application
                });
            }

            // Compare BU
            if (item.BU && existing.businessUnit && item.BU.toLowerCase() !== existing.businessUnit.toLowerCase()) {
                diffs.push({
                    field: 'BU',
                    oldVal: existing.businessUnit || 'None',
                    newVal: item.BU
                });
            }

            // Compare Zone / Platform (Col 9 in Excel)
            if (item.Zone && existing.zone && item.Zone.toLowerCase() !== existing.zone.toLowerCase()) {
                diffs.push({
                    field: 'Zone / Platform',
                    oldVal: existing.zone || 'None',
                    newVal: item.Zone
                });
            }

            return {
                status: diffs.length > 0 ? 'diff' : 'match',
                pasted: item,
                existing: existing,
                diffs: diffs
            };
        });
    }, [parsedVms, serverMap]);

    // Summary counters
    const summary = useMemo(() => {
        const total = diffResults.length;
        const diffCount = diffResults.filter(r => r.status === 'diff').length;
        const newCount = diffResults.filter(r => r.status === 'new').length;
        const matchCount = diffResults.filter(r => r.status === 'match').length;
        return { total, diffCount, newCount, matchCount };
    }, [diffResults]);

    // Filtered diff results based on tab and search
    const filteredResults = useMemo(() => {
        return diffResults.filter(r => {
            if (filterStatus !== 'all' && r.status !== filterStatus) return false;

            if (searchKeyword.trim()) {
                const kw = searchKeyword.toLowerCase();
                const ip = String(r.pasted.IP).toLowerCase();
                const host = String(r.pasted.Name).toLowerCase();
                const app = String(r.pasted.Application || '').toLowerCase();
                const bu = String(r.pasted.BU || '').toLowerCase();
                const os = String(r.pasted.OS || '').toLowerCase();
                if (!ip.includes(kw) && !host.includes(kw) && !app.includes(kw) && !bu.includes(kw) && !os.includes(kw)) {
                    return false;
                }
            }
            return true;
        });
    }, [diffResults, filterStatus, searchKeyword]);

    // Select all / toggle
    const handleToggleSelectAll = (checked) => {
        if (checked) {
            setSelectedIps(filteredResults.map(r => r.pasted.IP));
        } else {
            setSelectedIps([]);
        }
    };

    const handleToggleSelectRow = (ip, checked) => {
        if (checked) {
            setSelectedIps(prev => [...prev, ip]);
        } else {
            setSelectedIps(prev => prev.filter(x => x !== ip));
        }
    };

    // Apply updates to Server List (CMDB)
    const handleApplySync = async (targetIps = null) => {
        const ipsToSync = targetIps || selectedIps;
        if (ipsToSync.length === 0) {
            showToast?.('Please select at least one item to sync.', 'warning');
            return;
        }

        const chosen = diffResults.filter(r => ipsToSync.includes(r.pasted.IP));
        // Rows with an unknown environment are rejected (never synced with a default)
        const rejectedRows = chosen.filter(r => r.rejected);
        const itemsToUpdate = chosen.filter(r => !r.rejected).map(r => {
            const vm = { ...r.pasted };
            delete vm.envError;
            return vm;
        });
        if (itemsToUpdate.length === 0) {
            showToast?.(`${rejectedRows.length} row(s) rejected: unknown environment. Fix the Environment column (see Settings -> Environments).`, 'error');
            return;
        }

        setIsApplying(true);
        try {
            const res = await api.post('/server-list/upsert-vms', { vms: itemsToUpdate });
            const serverRejected = Array.isArray(res.data.rejected) ? res.data.rejected.length : 0;
            const skipped = rejectedRows.length + serverRejected;
            showToast?.(
                `Successfully synced and updated ${res.data.count ?? itemsToUpdate.length} servers in Server List!${skipped ? ` ${skipped} row(s) rejected: unknown environment.` : ''}`,
                skipped ? 'warning' : 'success'
            );
            if (onSyncSuccess) onSyncSuccess();
            setSelectedIps([]);
        } catch (err) {
            console.error('Failed to sync diff updates:', err);
            showToast?.('Failed to sync updates: ' + (err.response?.data?.error || err.message), 'error');
        } finally {
            setIsApplying(false);
        }
    };

    // Export Diff report as CSV
    const handleExportCSV = () => {
        if (diffResults.length === 0) return;

        const headers = ['Status', 'IP', 'Hostname (New)', 'Hostname (Old)', 'vCPU (New)', 'vCPU (Old)', 'RAM GB (New)', 'RAM GB (Old)', 'Disk GB (New)', 'Disk GB (Old)', 'OS (New)', 'OS (Old)', 'Application', 'BU', 'Zone', 'Platform', 'Diff Summary'];
        
        const rows = diffResults.map(r => {
            const p = r.pasted;
            const e = r.existing || {};
            const diffText = r.status === 'new' ? 'New Server' : r.diffs.map(d => `${d.field}: ${d.oldVal} -> ${d.newVal}`).join('; ');
            
            return [
                r.status.toUpperCase(),
                p.IP,
                p.Name,
                e.hostname || '',
                p.NumCore,
                e.cpuCores || '',
                p.MemoryGB,
                e.memoryGB || '',
                p.DiskInfo?.Total || 0,
                e.diskGB || '',
                p.OS,
                e.os || '',
                p.Application || '',
                p.BU || '',
                p.Zone || '',
                p.Platform || '',
                `"${diffText}"`
            ].join(',');
        });

        const csvContent = 'data:text/csv;charset=utf-8,\uFEFF' + [headers.join(','), ...rows].join('\n');
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement('a');
        link.setAttribute('href', encodedUri);
        link.setAttribute('download', `server_list_excel_diff_${new Date().toISOString().slice(0, 10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast?.('Diff report exported successfully!', 'success');
    };

    // Load sample 12-column row for easy testing
    const handleLoadSample = () => {
        const sample = `TRUST\tJL-TRS-K01WRK010\t10.88.20.10\t\t\t16 vCPU\t32\tVM_280GB (/:71GB, /boot:1GB, swap:8GB)(/var/lib/docker:100GB, /var/lib/kubelet:100GB)\tRedhat Ent 9.7\tJULY-CLUSTER-02\tK8S Worker - ATS\tTRS\nTRUST\tJL-TRS-K01WRK011\t10.88.20.11\t\t\t8 vCPU\t16\tVM_160GB (/:80GB)(/data:80GB)\tRedhat Ent 9.7\tJULY-CLUSTER-02\tK8S Worker - ATS\tTRS`;
        setRawInput(sample);
        setHasParsed(true);
    };

    if (!isOpen) return null;

    return (
        <div style={S.modalOverlay}>
            <div style={S.modalContent}>
                {/* Header */}
                <div style={S.modalHeader}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <div style={S.iconBox}>
                            <FiLayers size={20} color="var(--accent-primary, #6366f1)" />
                        </div>
                        <div>
                            <h3 style={S.title}>📋 Batch Excel Specification Diff & Sync (批次 Excel 規格比對)</h3>
                            <p style={S.subtitle}>貼上 200~300+ 台伺服器 Excel 規格，智慧解析分割區容量並即時與 Server List CMDB 進行差異比對</p>
                        </div>
                    </div>
                    <button style={S.closeBtn} onClick={onClose}>
                        <FiX size={20} />
                    </button>
                </div>

                {/* Body */}
                <div style={S.modalBody}>
                    {/* Paste Input Section */}
                    <div style={S.card}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                            <label style={S.label}>
                                📄 Paste Excel Columns (Zone, Hostname, IP, vCPU, RAM, Disks, OS, Platform, App, BU):
                            </label>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button style={S.btnGhost} onClick={handleLoadSample}>
                                    💡 Load Example (載入範例)
                                </button>
                                {rawInput && (
                                    <button style={S.btnGhost} onClick={() => { setRawInput(''); setHasParsed(false); }}>
                                        ✕ Clear (清空)
                                    </button>
                                )}
                            </div>
                        </div>

                        <textarea
                            style={S.textarea}
                            rows={hasParsed && parsedVms.length > 0 ? 3 : 5}
                            placeholder={"Paste Excel tab-separated rows here...\nExample:\nTRUST\tJL-TRS-K01WRK010\t10.88.20.10\t\t\t16 vCPU\t32\tVM_280GB (/:71GB, /boot:1GB, swap:8GB)(/var/lib/docker:100GB, /var/lib/kubelet:100GB)\tRedhat Ent 9.7\tJULY-CLUSTER-02\tK8S Worker - ATS\tTRS"}
                            value={rawInput}
                            onChange={e => {
                                setRawInput(e.target.value);
                                setHasParsed(true);
                            }}
                        />
                    </div>

                    {/* Stats & Filter Bar */}
                    {parsedVms.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {/* Counters KPI */}
                            <div style={S.kpiRow}>
                                <div 
                                    style={{ ...S.kpiCard, borderColor: filterStatus === 'all' ? 'var(--accent-primary, #6366f1)' : 'var(--border-color, rgba(255,255,255,0.1))' }}
                                    onClick={() => setFilterStatus('all')}
                                >
                                    <span style={S.kpiLabel}>TOTAL PARSED</span>
                                    <span style={{ ...S.kpiVal, color: 'var(--text-primary)' }}>{summary.total}</span>
                                </div>
                                <div 
                                    style={{ ...S.kpiCard, borderColor: filterStatus === 'diff' ? '#f59e0b' : 'var(--border-color, rgba(255,255,255,0.1))', background: filterStatus === 'diff' ? 'rgba(245, 158, 11, 0.08)' : S.kpiCard.background }}
                                    onClick={() => setFilterStatus('diff')}
                                >
                                    <span style={{ ...S.kpiLabel, color: '#f59e0b' }}>⚡ DIFFERENCES FOUND</span>
                                    <span style={{ ...S.kpiVal, color: '#f59e0b' }}>{summary.diffCount}</span>
                                </div>
                                <div 
                                    style={{ ...S.kpiCard, borderColor: filterStatus === 'new' ? '#10b981' : 'var(--border-color, rgba(255,255,255,0.1))', background: filterStatus === 'new' ? 'rgba(16, 185, 129, 0.08)' : S.kpiCard.background }}
                                    onClick={() => setFilterStatus('new')}
                                >
                                    <span style={{ ...S.kpiLabel, color: '#10b981' }}>🆕 NEW TO SERVER LIST</span>
                                    <span style={{ ...S.kpiVal, color: '#10b981' }}>{summary.newCount}</span>
                                </div>
                                <div 
                                    style={{ ...S.kpiCard, borderColor: filterStatus === 'match' ? '#9ca3af' : 'var(--border-color, rgba(255,255,255,0.1))' }}
                                    onClick={() => setFilterStatus('match')}
                                >
                                    <span style={S.kpiLabel}>✅ FULLY MATCHED</span>
                                    <span style={{ ...S.kpiVal, color: '#9ca3af' }}>{summary.matchCount}</span>
                                </div>
                            </div>

                            {/* Action Toolbar */}
                            <div style={S.toolbar}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
                                    <div style={S.searchBox}>
                                        <FiSearch size={14} color="var(--text-muted)" />
                                        <input
                                            type="text"
                                            placeholder="Search IP, Hostname, BU, App, OS..."
                                            style={S.searchInput}
                                            value={searchKeyword}
                                            onChange={e => setSearchKeyword(e.target.value)}
                                        />
                                    </div>
                                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                                        Showing <strong>{filteredResults.length}</strong> of {summary.total}
                                    </span>
                                </div>

                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button style={S.btnGhost} onClick={handleExportCSV}>
                                        <FiDownload size={14} /> Export CSV
                                    </button>

                                    {summary.diffCount + summary.newCount > 0 && (
                                        <button 
                                            style={S.btnSecondary} 
                                            onClick={() => {
                                                const diffOrNewIps = diffResults.filter(r => r.status === 'diff' || r.status === 'new').map(r => r.pasted.IP);
                                                handleApplySync(diffOrNewIps);
                                            }}
                                            disabled={isApplying}
                                        >
                                            <FiRefreshCw className={isApplying ? 'spin' : ''} size={14} />
                                            Sync All Diff & New ({summary.diffCount + summary.newCount})
                                        </button>
                                    )}

                                    <button 
                                        style={S.btnPrimary} 
                                        onClick={() => handleApplySync()}
                                        disabled={isApplying || selectedIps.length === 0}
                                    >
                                        <FiCheck size={14} />
                                        Apply Selected ({selectedIps.length})
                                    </button>
                                </div>
                            </div>

                            {/* Diff Table */}
                            <div style={S.tableWrapper}>
                                <table style={S.table}>
                                    <thead>
                                        <tr>
                                            <th style={{ ...S.th, width: 40, textAlign: 'center' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={filteredResults.length > 0 && selectedIps.length === filteredResults.length}
                                                    onChange={e => handleToggleSelectAll(e.target.checked)}
                                                />
                                            </th>
                                            <th style={S.th}>STATUS</th>
                                            <th style={S.th}>IP & HOSTNAME</th>
                                            <th style={S.th}>COMPUTE (CPU / RAM)</th>
                                            <th style={S.th}>DISK SPECIFICATION</th>
                                            <th style={S.th}>OS & BU</th>
                                            <th style={S.th}>APPLICATION & ZONE</th>
                                            <th style={S.th}>DIFF ANALYSIS DETAILS</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredResults.map((row, idx) => {
                                            const p = row.pasted;
                                            const e = row.existing;
                                            const isSelected = selectedIps.includes(p.IP);

                                            return (
                                                <tr 
                                                    key={idx} 
                                                    style={{ 
                                                        ...S.tr, 
                                                        background: isSelected 
                                                            ? 'rgba(99, 102, 241, 0.08)' 
                                                            : row.status === 'diff' 
                                                                ? 'rgba(245, 158, 11, 0.03)' 
                                                                : row.status === 'new' 
                                                                    ? 'rgba(16, 185, 129, 0.03)' 
                                                                    : 'transparent'
                                                    }}
                                                >
                                                    <td style={{ ...S.td, textAlign: 'center' }}>
                                                        <input
                                                            type="checkbox"
                                                            checked={isSelected}
                                                            onChange={evt => handleToggleSelectRow(p.IP, evt.target.checked)}
                                                        />
                                                    </td>

                                                    <td style={S.td}>
                                                        {row.status === 'diff' && (
                                                            <span style={S.badgeDiff}>⚡ DIFF</span>
                                                        )}
                                                        {row.status === 'new' && (
                                                            <span style={S.badgeNew}>🆕 NEW</span>
                                                        )}
                                                        {row.status === 'new' && deletedIps.has(String(row.pasted.IP).trim()) && (
                                                            <span style={{ ...S.badgeNew, marginLeft: 6, background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' }} title="This IP was deleted from Server List; syncing it re-creates the server">♻️ previously deleted — will be restored</span>
                                                        )}
                                                        {row.status === 'match' && (
                                                            <span style={S.badgeMatch}>✅ MATCH</span>
                                                        )}
                                                    </td>

                                                    <td style={S.td}>
                                                        <div style={{ fontFamily: 'monospace', fontWeight: 800, color: 'var(--text-primary)' }}>
                                                            {p.IP}
                                                        </div>
                                                        {(() => {
                                                            const hasHostDiff = e && e.hostname && String(e.hostname).toLowerCase().trim().split('.')[0] !== String(p.Name).toLowerCase().trim().split('.')[0];
                                                            return (
                                                                <div style={{ fontSize: 11, color: hasHostDiff ? '#f59e0b' : 'var(--text-muted)' }}>
                                                                    {p.Name}
                                                                    {hasHostDiff && (
                                                                        <span style={{ fontSize: 10, opacity: 0.8 }}> (was: {e.hostname})</span>
                                                                    )}
                                                                </div>
                                                            );
                                                        })()}
                                                    </td>

                                                    <td style={S.td}>
                                                        <div style={{ fontSize: 12, fontWeight: 700 }}>
                                                            {p.NumCore}C / {p.MemoryGB}GB
                                                        </div>
                                                        {e && (e.cpuCores !== p.NumCore || e.memoryGB !== p.MemoryGB) && (
                                                            <div style={{ fontSize: 10, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 4 }}>
                                                                <span>CMDB: {e.cpuCores || 0}C / {e.memoryGB || 0}GB</span>
                                                                <FiArrowRight size={10} />
                                                            </div>
                                                        )}
                                                    </td>

                                                    <td style={S.td}>
                                                        <div style={{ fontSize: 12, fontWeight: 700 }}>
                                                            {p.DiskInfo.Total} GB
                                                        </div>
                                                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, wordBreak: 'break-all' }}>
                                                            {p.DiskInfo.Display || (p.DiskInfo.Disks?.length > 0 ? p.DiskInfo.Disks.map(d => `${d.letter}:${d.size}GB`).join(' / ') : `${p.DiskInfo.Total}GB`)}
                                                        </div>
                                                        {e && Number(e.diskGB) !== Number(p.DiskInfo.Total) && (
                                                            <div style={{ fontSize: 10, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                                                                <span>CMDB: {e.diskGB || 0}GB</span>
                                                                <FiArrowRight size={10} />
                                                                <span>{p.DiskInfo.Total}GB</span>
                                                            </div>
                                                        )}
                                                    </td>

                                                    <td style={S.td}>
                                                        <div style={{ fontSize: 12, fontWeight: 700 }}>{p.OS}</div>
                                                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                                            BU: <strong>{p.BU}</strong>
                                                        </div>
                                                    </td>

                                                    <td style={S.td}>
                                                        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
                                                            {p.Application || 'Unassigned'}
                                                        </div>
                                                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                                                            {p.Zone} {p.Platform ? `| ${p.Platform}` : ''}
                                                        </div>
                                                    </td>

                                                    <td style={S.td}>
                                                        {row.status === 'new' ? (
                                                            <span style={{ fontSize: 11, color: '#10b981', fontWeight: 700 }}>
                                                                Ready to register as new server
                                                            </span>
                                                        ) : row.status === 'match' ? (
                                                            <span style={{ fontSize: 11, color: '#9ca3af' }}>
                                                                Specifications perfectly match CMDB
                                                            </span>
                                                        ) : (
                                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                                                {row.diffs.map((d, i) => (
                                                                    <div key={i} style={S.diffItem}>
                                                                        <span style={{ fontWeight: 800 }}>{d.field}:</span> {d.oldVal} ➔ <span style={{ color: '#10b981', fontWeight: 800 }}>{d.newVal}</span>
                                                                    </div>
                                                                ))}
                                                            </div>
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
                </div>

                {/* Footer */}
                <div style={S.modalFooter}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        ℹ️ Applying updates will write directly to CMDB Meta, synchronize IPAM & Prometheus, and preserve audit history.
                    </span>
                    <button style={S.btnGhost} onClick={onClose}>
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
}

const S = {
    modalOverlay: {
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        zIndex: 1200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24
    },
    modalContent: {
        width: 1250,
        maxWidth: '96vw',
        height: '92vh',
        background: 'var(--bg-secondary, #111827)',
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
        borderRadius: 16,
        boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
    },
    modalHeader: {
        padding: '18px 24px',
        borderBottom: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'rgba(255, 255, 255, 0.02)'
    },
    iconBox: {
        width: 40,
        height: 40,
        borderRadius: 10,
        background: 'rgba(99, 102, 241, 0.15)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
    },
    title: {
        margin: 0,
        fontSize: 16,
        fontWeight: 800,
        color: 'var(--text-primary, #f8fafc)'
    },
    subtitle: {
        margin: '2px 0 0 0',
        fontSize: 12,
        color: 'var(--text-muted, #94a3b8)'
    },
    closeBtn: {
        background: 'none',
        border: 'none',
        color: 'var(--text-muted, #94a3b8)',
        cursor: 'pointer',
        padding: 4,
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
    },
    modalBody: {
        padding: 20,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        flex: 1
    },
    card: {
        padding: 16,
        borderRadius: 10,
        background: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))'
    },
    label: {
        fontSize: 12,
        fontWeight: 800,
        color: 'var(--text-muted, #94a3b8)',
        display: 'block'
    },
    textarea: {
        width: '100%',
        padding: '10px 14px',
        borderRadius: 8,
        background: 'rgba(0, 0, 0, 0.25)',
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
        color: 'var(--text-primary, #f8fafc)',
        fontFamily: 'monospace',
        fontSize: 12,
        lineHeight: 1.5,
        outline: 'none',
        resize: 'vertical'
    },
    kpiRow: {
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12
    },
    kpiCard: {
        padding: '12px 16px',
        borderRadius: 10,
        background: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))',
        cursor: 'pointer',
        transition: 'all 0.2s',
        display: 'flex',
        flexDirection: 'column',
        gap: 4
    },
    kpiLabel: {
        fontSize: 10,
        fontWeight: 800,
        color: 'var(--text-muted, #94a3b8)',
        letterSpacing: '0.05em'
    },
    kpiVal: {
        fontSize: 22,
        fontWeight: 900
    },
    toolbar: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        padding: '10px 14px',
        borderRadius: 10,
        background: 'rgba(255, 255, 255, 0.02)',
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))'
    },
    searchBox: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 6,
        background: 'rgba(0, 0, 0, 0.2)',
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
        width: 280
    },
    searchInput: {
        background: 'transparent',
        border: 'none',
        color: 'var(--text-primary, #f8fafc)',
        fontSize: 12,
        outline: 'none',
        width: '100%'
    },
    tableWrapper: {
        borderRadius: 10,
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))',
        overflowX: 'auto',
        background: 'rgba(0, 0, 0, 0.15)'
    },
    table: {
        width: '100%',
        borderCollapse: 'collapse',
        textAlign: 'left'
    },
    th: {
        padding: '10px 14px',
        fontSize: 11,
        fontWeight: 800,
        color: 'var(--text-muted, #94a3b8)',
        borderBottom: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))',
        background: 'rgba(255, 255, 255, 0.03)',
        whiteSpace: 'nowrap'
    },
    tr: {
        borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
        transition: 'background 0.15s'
    },
    td: {
        padding: '10px 14px',
        verticalAlign: 'middle',
        fontSize: 12
    },
    badgeDiff: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 6,
        fontSize: 10,
        fontWeight: 900,
        background: 'rgba(245, 158, 11, 0.15)',
        color: '#f59e0b',
        border: '1px solid rgba(245, 158, 11, 0.3)'
    },
    badgeNew: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 6,
        fontSize: 10,
        fontWeight: 900,
        background: 'rgba(16, 185, 129, 0.15)',
        color: '#10b981',
        border: '1px solid rgba(16, 185, 129, 0.3)'
    },
    badgeMatch: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 6,
        fontSize: 10,
        fontWeight: 800,
        background: 'rgba(156, 163, 175, 0.15)',
        color: '#9ca3af',
        border: '1px solid rgba(156, 163, 175, 0.3)'
    },
    diffItem: {
        fontSize: 11,
        color: 'var(--text-secondary, #cbd5e1)',
        background: 'rgba(245, 158, 11, 0.1)',
        padding: '2px 6px',
        borderRadius: 4,
        display: 'inline-block',
        width: 'fit-content'
    },
    btnPrimary: {
        padding: '6px 14px',
        borderRadius: 6,
        background: 'var(--accent-primary, #6366f1)',
        border: 'none',
        color: '#fff',
        fontWeight: 700,
        fontSize: 12,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6
    },
    btnSecondary: {
        padding: '6px 14px',
        borderRadius: 6,
        background: 'rgba(245, 158, 11, 0.15)',
        border: '1px solid rgba(245, 158, 11, 0.3)',
        color: '#f59e0b',
        fontWeight: 700,
        fontSize: 12,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6
    },
    btnGhost: {
        padding: '6px 12px',
        borderRadius: 6,
        background: 'rgba(255, 255, 255, 0.05)',
        border: '1px solid var(--border-color, rgba(255, 255, 255, 0.1))',
        color: 'var(--text-primary, #f8fafc)',
        fontSize: 12,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 6
    },
    modalFooter: {
        padding: '14px 24px',
        borderTop: '1px solid var(--border-color, rgba(255, 255, 255, 0.08))',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'rgba(255, 255, 255, 0.01)'
    }
};
