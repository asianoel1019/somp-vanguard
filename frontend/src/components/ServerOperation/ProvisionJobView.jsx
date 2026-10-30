import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import { createPoller } from './pollController';
import {
    jobStatusTone, toneClass, packageLine, packageClass, jobSummaryLine, jobProgress,
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
            {error && <div className="p-3 bg-danger/20 border border-danger/35 rounded text-danger text-sm flex items-center gap-2">
                <span>{error}</span>
                {!/not found/i.test(error) && <button className="btn btn-outline text-xs ml-2" onClick={restart}>Refresh</button>}
            </div>}
            {unknownList.length > 0 && (
                <div className="p-3 bg-warning/20 border border-warning/35 rounded text-warning text-sm">
                    <div>Retry rejected: these hosts are no longer known targets (not in CMDB or Server Inventory): {unknownList.join(', ')}</div>
                    {isSuperAdmin && <button className="btn btn-outline text-xs mt-2" disabled={busy} onClick={() => handleRetry(true)}>Retry allowing unknown targets</button>}
                </div>
            )}
            {lost && (
                <div className="p-3 bg-warning/20 border border-warning/35 rounded text-warning text-sm">
                    Lost track of job {String(jobId).slice(0, 8)}; the job may still be running on the server. Check its status again later.
                    <button className="btn btn-outline text-xs ml-2" onClick={restart}>Refresh</button>
                </div>
            )}
        </>
    );

    if (!data) {
        return (
            <div className="flex flex-col gap-3">
                {notice}
                {!error && !lost && <div className="text-sm text-secondary">Loading job...</div>}
            </div>
        );
    }
    const job = data.job;
    const hosts = data.hosts || [];
    const prog = jobProgress(hosts);
    const statusLabel = cancelling && running ? 'cancelling' : job.status;

    return (
        <div className="flex flex-col gap-4">
            {notice}
            <div className="flex justify-between items-center flex-wrap gap-2">
                <div>
                    <div className="text-sm">
                        <span className="font-mono text-primary">{String(job.id).slice(0, 8)}</span>{' '}
                        <span className={`text-xs px-2 py-0.5 rounded ${toneClass(cancelling && running ? 'warning' : jobStatusTone(job.status))}`}>{statusLabel}</span>
                        {resumedBadge(job) && <span className={`text-xs px-2 py-0.5 rounded ml-1 ${toneClass('warning')}`} title="Queued hosts were run again after a service / worker restart; hosts that were mid-install are marked interrupted">{resumedBadge(job)}</span>}
                    </div>
                    <div className="text-xs text-secondary mt-1">
                        {job.buType} / {job.osType} / {formatTime(job.createdAt)} / {formatDuration(job.startedAt || job.createdAt, job.finishedAt)}
                        {runnerLabel(job) && <> / runs in: {runnerLabel(job)}</>}
                    </div>
                    {jobAccountsLine(job) && <div className="text-xs text-secondary">{jobAccountsLine(job)}</div>}
                    <div className="text-xs text-secondary">
                        {running ? `${prog.finished}/${prog.total} hosts finished` : jobSummaryLine(job)}
                    </div>
                    {job.note && <div className="text-xs text-muted italic">{job.note}</div>}
                    {job.unknownTargets && job.unknownTargets.length > 0 && (
                        <div className="text-xs text-warning">Unknown targets allowed: {job.unknownTargets.join(', ')}</div>
                    )}
                </div>
                <div className="flex gap-2">
                    {canWrite && running && <button className="btn btn-outline text-sm" disabled={busy || cancelling} onClick={handleCancel}>{cancelling ? 'Cancelling...' : 'Cancel job'}</button>}
                    {canWrite && canRetry(job, hosts) && <button className="btn btn-primary text-sm" disabled={busy} onClick={() => handleRetry(false)}>Retry failed hosts</button>}
                </div>
            </div>

            {hosts.map(h => (
                <div key={h.ip} className="p-4 bg-black/40 rounded border border-white/10">
                    <div className="flex justify-between items-center mb-2">
                        <span className="font-bold text-primary">{h.ip}{h.hostname ? <span className="text-secondary font-normal text-xs"> {h.hostname}</span> : null}</span>
                        <span className="flex gap-2 items-center">
                            {h.rebootRequired && <span className="text-xs px-2 py-0.5 rounded bg-warning/20 text-warning">Reboot required</span>}
                            <span className={`text-xs px-2 py-0.5 rounded ${toneClass(jobStatusTone(h.status))}`}>{h.status}</span>
                        </span>
                    </div>
                    {h.error && <div className="text-xs text-danger mb-2">{h.error}</div>}
                    {(h.packages || []).length > 0 && (
                        <ul className="text-xs mb-2 flex flex-col gap-1">
                            {h.packages.map(p => (
                                <li key={p.name} className={packageClass(p)}>{packageLine(p)}{p.rebootRequired ? ' [reboot]' : ''}</li>
                            ))}
                        </ul>
                    )}
                    {h.logHidden
                        ? <div className="text-xs text-muted italic">Log visible to Operators only</div>
                        : <button className="btn btn-outline text-xs" onClick={() => toggleLog(h.ip)}>{expanded[h.ip] ? 'Hide log' : 'Show log'}</button>}
                    {!h.logHidden && expanded[h.ip] && (
                        <pre className="text-xs font-mono text-muted whitespace-pre-wrap max-h-40 overflow-y-auto mt-2">
                            {logs[h.ip] === undefined ? 'Loading...' : (logs[h.ip] || '(empty)')}
                        </pre>
                    )}
                </div>
            ))}
        </div>
    );
};

export default ProvisionJobView;
