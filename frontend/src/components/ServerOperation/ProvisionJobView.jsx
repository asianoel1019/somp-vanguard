import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import { createPoller } from './pollController';
import {
    TbBrandWindows, TbTerminal2, TbClock, TbServer2, TbUsers, TbPlayerStop, TbRepeat, TbCircleCheck, TbCircleX, TbCircleMinus,
    TbChevronDown, TbChevronRight, TbFileText
} from 'react-icons/tb';
import { StatusBadge, ProgressBar, Alert } from './ProvisionUi';
import {
    jobStatusTone, toneColor, packageLine, packageState, jobSummaryLine, jobProgress, progressSegments,
    formatDuration, formatTime, canRetry, runnerLabel, resumedBadge, jobAccountsLine
} from './provisionUtils';

const POLL_MS = 2000;
const LOG_REFRESH_MS = 10000;

const hostSignature = (hosts) => (hosts || []).map(h => `${h.ip}:${h.status}:${(h.packages || []).length}`).join('|');

// Job view: per-host rows with status / packages / reboot, polling while running, expandable log, cancel, retry.
const ProvisionJobView = ({ jobId, canWrite, onOpenJob, onActiveChange }) => {
    const [data, setData] = useState(null);          // { job, hosts }
    const [logs, setLogs] = useState({});            // ip -> log text
    const [expanded, setExpanded] = useState({});
    const [error, setError] = useState('');
    const [lost, setLost] = useState(false);
    const [busy, setBusy] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [unknownList, setUnknownList] = useState([]); // unknown targets rejected by retry-failed
    const isSuperAdmin = (() => { try { return (JSON.parse(localStorage.getItem('user') || '{}').role) === 'SuperAdmin'; } catch { return false; } })();
    const [reloadKey, setReloadKey] = useState(0);
    const [, setTick] = useState(0);
    const mountedRef = useRef(true);
    const activeCbRef = useRef(onActiveChange);
    const expandedRef = useRef({});
    const logStateRef = useRef({ at: 0, sig: '' });
    useEffect(() => { activeCbRef.current = onActiveChange; });
    useEffect(() => { expandedRef.current = expanded; }, [expanded]);

    useEffect(() => {
        mountedRef.current = true;
        const report = (active) => { if (activeCbRef.current) activeCbRef.current(active); };

        const loadLogs = async (force) => {
            const ips = Object.keys(expandedRef.current).filter(ip => expandedRef.current[ip]);
            if (!force && ips.length === 0) return;
            logStateRef.current.at = Date.now();
            try {
                const res = await api.get(`/install/jobs/${jobId}`);
                if (!mountedRef.current) return;
                const l = {};
                ((res.data && res.data.hosts) || []).forEach(h => { if (typeof h.log === 'string') l[h.ip] = h.log; });
                setLogs(prev => ({ ...prev, ...l }));
            } catch { /* keep the previous log text */ }
        };

        const poller = createPoller({
            intervalMs: POLL_MS,
            isHidden: () => document.hidden,
            fetchLight: async () => (await api.get(`/install/jobs/${jobId}`, { params: { log: 0 } })).data,
            fetchFull: async () => (await api.get(`/install/jobs/${jobId}`)).data,
            onData: (d) => {
                setData(d);
                setError('');
                setLost(false);
                // Refresh expanded logs when progress was reported for a host, or at most every 10 s
                const sig = hostSignature(d && d.hosts);
                const st = logStateRef.current;
                if (sig !== st.sig || Date.now() - st.at >= LOG_REFRESH_MS) { st.sig = sig; loadLogs(false); }
            },
            onFull: (d) => {
                setData(d);
                const l = {};
                ((d && d.hosts) || []).forEach(h => { if (typeof h.log === 'string') l[h.ip] = h.log; });
                setLogs(l);
            },
            onFullError: () => setError(`Job ${jobId} finished but its details could not be loaded; use Refresh to try again.`),
            onLost: () => setLost(true),
            onNotFound: () => setError('Job not found.'),
            onActive: report
        });

        const onVisible = () => { if (!document.hidden) poller.resume(); };
        document.addEventListener('visibilitychange', onVisible);
        poller.start();

        return () => {
            poller.stop();
            mountedRef.current = false;
            document.removeEventListener('visibilitychange', onVisible);
            report(false);
        };
    }, [jobId, reloadKey]);

    // Refresh the elapsed time while running
    const running = !!(data && data.job && data.job.running);
    useEffect(() => {
        if (!running) return undefined;
        const t = setInterval(() => setTick(x => x + 1), 1000);
        return () => clearInterval(t);
    }, [running]);


    const restart = () => { setLost(false); setError(''); setReloadKey(k => k + 1); };

    const toggleLog = async (ip) => {
        const next = !expanded[ip];
        setExpanded(prev => ({ ...prev, [ip]: next }));
        expandedRef.current = { ...expandedRef.current, [ip]: next };
        if (next && logs[ip] === undefined) {
            try {
                const res = await api.get(`/install/jobs/${jobId}`);
                const h = ((res.data && res.data.hosts) || []).find(x => x.ip === ip);
                if (mountedRef.current && h) setLogs(prev => ({ ...prev, [ip]: typeof h.log === 'string' ? h.log : '' }));
            } catch { if (mountedRef.current) setLogs(prev => ({ ...prev, [ip]: '(log could not be loaded)' })); }
        }
    };

    const handleCancel = async () => {
        if (!window.confirm('Cancel this job? Hosts already running will finish their current work.')) return;
        setBusy(true);
        setCancelling(true);
        try { await api.post(`/install/jobs/${jobId}/cancel`); }
        catch (err) { setCancelling(false); setError(err.response?.data?.error || err.message); }
        finally { if (mountedRef.current) setBusy(false); }
    };

    const handleRetry = async (allowUnknownTargets = false) => {
        setBusy(true);
        setUnknownList([]);
        try {
            const res = await api.post(`/install/jobs/${jobId}/retry-failed`, allowUnknownTargets ? { allowUnknownTargets: true } : {});
            if (res.data && res.data.jobId && onOpenJob) onOpenJob(res.data.jobId);
        } catch (err) {
            const body = err.response?.data;
            if (err.response?.status === 400 && body && Array.isArray(body.unknownTargets) && body.unknownTargets.length) setUnknownList(body.unknownTargets);
            else setError(body?.error || err.message);
        }
        finally { if (mountedRef.current) setBusy(false); }
    };

    const notice = (
        <>
            {error && (
                <Alert tone="danger">
                    <span>{error}</span>
                    {!/not found/i.test(error) && <div><button type="button" className="btn btn-outline text-xs" onClick={restart}>Refresh</button></div>}
                </Alert>
            )}
            {unknownList.length > 0 && (
                <Alert tone="warning">
                    <span>Retry rejected: these hosts are no longer known targets (not in CMDB or Server Inventory): {unknownList.join(', ')}</span>
                    {isSuperAdmin && <div><button type="button" className="btn btn-outline text-xs" disabled={busy} onClick={() => handleRetry(true)}>Retry allowing unknown targets</button></div>}
                </Alert>
            )}
            {lost && (
                <Alert tone="warning">
                    <span>Lost track of job {String(jobId).slice(0, 8)}; the job may still be running on the server. Check its status again later.</span>
                    <div><button type="button" className="btn btn-outline text-xs" onClick={restart}>Refresh</button></div>
                </Alert>
            )}
        </>
    );

    if (!data) {
        return (
            <div className="pv-section">
                {notice}
                {!error && !lost && <div className="pv-help">Loading job...</div>}
            </div>
        );
    }
    const job = data.job;
    const hosts = data.hosts || [];
    const prog = jobProgress(hosts);
    const seg = progressSegments(hosts);
    const statusLabel = cancelling && running ? 'cancelling' : job.status;
    const OsIcon = job.osType === 'linux' ? TbTerminal2 : TbBrandWindows;

    return (
        <div className="pv-section" style={{ gap: 14 }}>
            {notice}
            <div className="pv-host-head">
                <span className="pv-host-ip">{String(job.id).slice(0, 8)}</span>
                <StatusBadge status={statusLabel} tone={cancelling && running ? 'warning' : undefined} />
                {resumedBadge(job) && (
                    <span title="Queued hosts were run again after a service / worker restart; hosts that were mid-install are marked interrupted">
                        <StatusBadge status="resumed" tone="warning" label={resumedBadge(job)} />
                    </span>
                )}
                <span className="pv-spacer" />
                {canWrite && running && (
                    <button type="button" className="btn btn-outline pv-icon-btn text-sm" disabled={busy || cancelling} onClick={handleCancel}>
                        <TbPlayerStop size={16} aria-hidden="true" /> {cancelling ? 'Cancelling...' : 'Cancel job'}
                    </button>
                )}
                {canWrite && canRetry(job, hosts) && (
                    <button type="button" className="btn btn-primary pv-icon-btn text-sm" disabled={busy} onClick={() => handleRetry(false)}>
                        <TbRepeat size={16} aria-hidden="true" /> Retry failed hosts
                    </button>
                )}
            </div>

            <div className="pv-meta">
                <span><OsIcon size={14} aria-hidden="true" />{job.buType} / {job.osType}</span>
                <span><TbClock size={14} aria-hidden="true" />{formatTime(job.createdAt)} ({formatDuration(job.startedAt || job.createdAt, job.finishedAt)})</span>
                {runnerLabel(job) && <span><TbServer2 size={14} aria-hidden="true" />{runnerLabel(job)}</span>}
                {jobAccountsLine(job) && <span><TbUsers size={14} aria-hidden="true" />{jobAccountsLine(job)}</span>}
            </div>

            <div className="pv-section" style={{ gap: 6 }}>
                <ProgressBar segments={seg} />
                <div className="pv-legend">
                    <span>{running ? `${prog.finished}/${prog.total} hosts finished` : jobSummaryLine(job)}</span>
                    {seg.ok > 0 && <span><i style={{ background: 'var(--success)' }} />{seg.ok} ok</span>}
                    {seg.failed > 0 && <span><i style={{ background: 'var(--danger)' }} />{seg.failed} failed</span>}
                    {seg.running > 0 && <span><i style={{ background: 'var(--accent-primary)' }} />{seg.running} running</span>}
                    {seg.queued > 0 && <span><i style={{ background: 'color-mix(in srgb, var(--accent-primary) 35%, transparent)' }} />{seg.queued} queued</span>}
                    {seg.other > 0 && <span><i style={{ background: 'var(--warning)' }} />{seg.other} skipped / cancelled</span>}
                </div>
            </div>

            {job.note && <div className="pv-help" style={{ fontStyle: 'italic' }}>{job.note}</div>}
            {job.unknownTargets && job.unknownTargets.length > 0 && (
                <Alert tone="warning">Unknown targets allowed: {job.unknownTargets.join(', ')}</Alert>
            )}

            {hosts.map(h => (
                <div key={h.ip} className="pv-host" style={{ '--pv-tone': toneColor(jobStatusTone(h.status)) }}>
                    <div className="pv-host-head">
                        <span className="pv-host-ip">{h.ip}</span>
                        {h.hostname && <span className="pv-host-name">{h.hostname}</span>}
                        <span className="pv-spacer" />
                        {h.rebootRequired && <StatusBadge status="reboot" tone="warning" label="Reboot required" />}
                        <StatusBadge status={h.status} />
                    </div>
                    {h.error && <div className="pv-help" style={{ color: 'var(--danger)' }}>{h.error}</div>}
                    {(h.packages || []).length > 0 && (
                        <ul className="pv-pkgs">
                            {h.packages.map(p => {
                                const st = packageState(p);
                                const Icon = st === 'ok' ? TbCircleCheck : st === 'skipped' ? TbCircleMinus : TbCircleX;
                                const color = st === 'ok' ? 'var(--success)' : st === 'skipped' ? 'var(--text-muted)' : 'var(--danger)';
                                const code = p.exitCode === undefined || p.exitCode === null ? '' : ` (exit ${p.exitCode})`;
                                return (
                                    <li key={p.name} title={packageLine(p)}>
                                        <Icon size={15} style={{ color }} aria-label={st} />
                                        <span>
                                            <span style={{ color: st === 'failed' ? 'var(--danger)' : 'var(--text-primary)' }}>{p.name}</span>
                                            <span className="pv-pkg-msg">{code}{p.message ? `: ${p.message}` : ''}{st === 'skipped' ? ' (already installed)' : ''}{p.rebootRequired ? ' [reboot]' : ''}</span>
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {h.logHidden
                        ? <div className="pv-help" style={{ fontStyle: 'italic' }}>Log visible to Operators only</div>
                        : (
                            <button type="button" className="pv-link" aria-expanded={!!expanded[h.ip]} onClick={() => toggleLog(h.ip)}>
                                {expanded[h.ip] ? <TbChevronDown size={14} aria-hidden="true" /> : <TbChevronRight size={14} aria-hidden="true" />}
                                <TbFileText size={14} aria-hidden="true" /> {expanded[h.ip] ? 'Hide log' : 'Show log'}
                            </button>
                        )}
                    {!h.logHidden && expanded[h.ip] && (
                        <pre className="pv-log">{logs[h.ip] === undefined ? 'Loading...' : (logs[h.ip] || '(empty)')}</pre>
                    )}
                </div>
            ))}
        </div>
    );
};

export default ProvisionJobView;
