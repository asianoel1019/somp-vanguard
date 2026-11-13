import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api';
import { TbSearch, TbRefresh, TbX, TbBrandWindows, TbTerminal2, TbHistory } from 'react-icons/tb';
import ProvisionJobView from './ProvisionJobView';
import { Segmented, StatusBadge, ProgressBar, Alert, EmptyState } from './ProvisionUi';
import {
    HISTORY_STATUS_FILTERS, historyParams, historyKpis, jobResultSegments, toneColor, formatTime, formatDuration
} from './provisionUtils';

const PAGE = 25;
const REFRESH_MS = 15000;   // while a listed job is running
const OS_FILTERS = [
    { id: 'all', label: 'All OS' },
    { id: 'windows', label: 'Windows', icon: TbBrandWindows },
    { id: 'linux', label: 'Linux', icon: TbTerminal2 },
];

// History tab: figures of the last 30 days, filters, the job table and a drawer with the selected job.
const ProvisionHistory = ({ canWrite, refreshKey, onActiveChange }) => {
    const [jobs, setJobs] = useState([]);
    const [nextBefore, setNextBefore] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [stats, setStats] = useState(null);
    const [status, setStatus] = useState('all');
    const [os, setOs] = useState('all');
    const [query, setQuery] = useState('');
    const [search, setSearch] = useState('');
    const [openId, setOpenId] = useState(null);
    const mountedRef = useRef(true);
    const seqRef = useRef(0);   // ignore out-of-order responses
    const jobsRef = useRef([]);
    useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
    useEffect(() => { jobsRef.current = jobs; }, [jobs]);

    // The search is sent once typing stops
    useEffect(() => {
        const t = setTimeout(() => setSearch(query.trim()), 300);
        return () => clearTimeout(t);
    }, [query]);

    const loadStats = useCallback(async () => {
        try {
            const res = await api.get('/install/jobs/stats', { params: { days: 30 } });
            if (mountedRef.current) setStats(res.data);
        } catch { /* the figures are optional; the table shows its own error */ }
    }, []);

    // before: next page; refresh: reload the rows already shown (keeps "Load more" pages)
    const load = useCallback(async ({ before = null, refresh = false } = {}) => {
        const seq = ++seqRef.current;
        if (!refresh) setLoading(true);
        setError('');
        try {
            const limit = refresh ? Math.min(200, Math.max(PAGE, jobsRef.current.length)) : PAGE;
            const res = await api.get('/install/jobs', { params: historyParams({ status, os, q: search, limit, before }) });
            if (!mountedRef.current || seq !== seqRef.current) return;
            const list = (res.data && res.data.jobs) || [];
            setJobs(prev => (before ? [...prev, ...list] : list));
            setNextBefore(res.data ? res.data.nextBefore : null);
        } catch (err) {
            if (mountedRef.current && seq === seqRef.current) setError(err.response?.data?.error || 'Failed to load history');
        } finally {
            if (mountedRef.current && seq === seqRef.current) setLoading(false);
        }
    }, [status, os, search]);

    // Deferred so no state is set synchronously in the effect body
    useEffect(() => { Promise.resolve().then(() => { load(); loadStats(); }); }, [load, loadStats, refreshKey]);

    // Keep running jobs current
    const anyRunning = jobs.some(j => j.running);
    useEffect(() => {
        if (!anyRunning) return undefined;
        const t = setInterval(() => { if (!document.hidden) { load({ refresh: true }); loadStats(); } }, REFRESH_MS);
        return () => clearInterval(t);
    }, [anyRunning, load, loadStats]);

    // Drawer: Escape closes it
    useEffect(() => {
        if (!openId) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setOpenId(null); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [openId]);

    const refreshAll = () => { load(); loadStats(); };
    const openRetried = (id) => { setOpenId(id); refreshAll(); };
    const filtered = status !== 'all' || os !== 'all' || !!search;

    return (
        <div className="pv-page">
            {stats && (
                <div className="pv-kpis">
                    {historyKpis(stats).map(k => (
                        <div key={k.id} className="glass-panel pv-kpi" style={{ '--pv-tone': toneColor(k.tone) }}>
                            <span className="pv-kpi-label">{k.label}</span>
                            <span className="pv-kpi-value">{k.value}</span>
                            <span className="pv-kpi-sub">{k.sub}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="glass-panel pv-card">
                <div className="pv-filters">
                    <div className="pv-search">
                        <TbSearch size={16} aria-hidden="true" />
                        <input type="search" placeholder="Job ID, user, template, host IP or name" value={query} maxLength={100}
                            aria-label="Search jobs" onChange={(e) => setQuery(e.target.value)} />
                    </div>
                    <Segmented small options={HISTORY_STATUS_FILTERS} value={status} onChange={setStatus} ariaLabel="Job status" />
                    <Segmented small options={OS_FILTERS} value={os} onChange={setOs} ariaLabel="Operating system" />
                    <button type="button" className="btn btn-outline pv-icon-btn" style={{ marginLeft: 'auto' }} disabled={loading} onClick={refreshAll}>
                        <TbRefresh size={16} aria-hidden="true" /> Refresh
                    </button>
                </div>

                {error && <Alert tone="danger">{error}</Alert>}

                {jobs.length === 0 && !loading && !error ? (
                    <EmptyState icon={TbHistory} title={filtered ? 'No jobs match the filters.' : 'No provisioning jobs yet.'}
                        hint={filtered ? 'Change the search text or the filters.' : 'Jobs started on the Provision tab are listed here.'} />
                ) : (
                    <div className="pv-scroll">
                        <table className="pv-table pv-history-table">
                            <thead>
                                <tr>
                                    <th>Job</th><th>Status</th><th>Template / OS</th><th>Hosts</th><th>Result</th><th>Started</th><th>Duration</th><th>By</th>
                                </tr>
                            </thead>
                            <tbody>
                                {jobs.map(j => {
                                    const seg = jobResultSegments(j);
                                    const OsIcon = j.osType === 'linux' ? TbTerminal2 : TbBrandWindows;
                                    return (
                                        <tr key={j.id} tabIndex={0} className={openId === j.id ? 'is-selected' : ''}
                                            onClick={() => setOpenId(j.id)}
                                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(j.id); } }}>
                                            <td className="pv-mono">{String(j.id).slice(0, 8)}</td>
                                            <td><StatusBadge status={j.status} /></td>
                                            <td><span className="pv-meta"><span><OsIcon size={14} aria-hidden="true" />{j.buType}</span></span></td>
                                            <td>{j.hostCount}</td>
                                            <td>
                                                <div className="pv-result">
                                                    <ProgressBar thin segments={seg} label={`${seg.ok} of ${seg.total} hosts ok, ${seg.failed} failed`} />
                                                    <small>{seg.ok}/{seg.total}{seg.failed ? `, ${seg.failed} failed` : ''}</small>
                                                </div>
                                            </td>
                                            <td style={{ whiteSpace: 'nowrap' }}>{formatTime(j.createdAt)}</td>
                                            <td className="pv-muted">{formatDuration(j.startedAt || j.createdAt, j.finishedAt)}</td>
                                            <td>{j.createdBy}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
                {loading && <div className="pv-help">Loading...</div>}
                {nextBefore !== null && nextBefore !== undefined && !loading && (
                    <button type="button" className="btn btn-outline" style={{ alignSelf: 'center' }} onClick={() => load({ before: nextBefore })}>Load more</button>
                )}
            </div>

            {openId && (
                <>
                    <div className="pv-drawer-backdrop" onClick={() => setOpenId(null)} aria-hidden="true" />
                    <aside className="pv-drawer" role="dialog" aria-modal="true" aria-label={`Job ${String(openId).slice(0, 8)}`}>
                        <div className="pv-drawer-head">
                            <h3>Job <span className="pv-mono">{String(openId).slice(0, 8)}</span></h3>
                            <span className="pv-spacer" />
                            <button type="button" className="pv-close" aria-label="Close" autoFocus onClick={() => setOpenId(null)}>
                                <TbX size={20} aria-hidden="true" />
                            </button>
                        </div>
                        <div className="pv-drawer-body">
                            <ProvisionJobView key={openId} jobId={openId} canWrite={canWrite} onOpenJob={openRetried} onActiveChange={onActiveChange} />
                        </div>
                    </aside>
                </>
            )}
        </div>
    );
};

export default ProvisionHistory;
