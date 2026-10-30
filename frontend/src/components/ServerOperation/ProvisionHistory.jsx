import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api';
import { jobStatusTone, toneClass, jobSummaryLine, formatTime, formatDuration } from './provisionUtils';

const PAGE = 25;

// History tab: paged job list (newest first); selecting a job calls onOpenJob(id).
const ProvisionHistory = ({ onOpenJob, selectedId, refreshKey }) => {
    const [jobs, setJobs] = useState([]);
    const [nextBefore, setNextBefore] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const mountedRef = useRef(true);
    const seqRef = useRef(0);   // ignore out-of-order responses
    useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

    const load = useCallback(async (before) => {
        const seq = ++seqRef.current;
        setLoading(true);
        setError('');
        try {
            const params = { limit: PAGE };
            if (before) params.before = before;
            const res = await api.get('/install/jobs', { params });
            if (!mountedRef.current || seq !== seqRef.current) return;
            const list = (res.data && res.data.jobs) || [];
            setJobs(prev => before ? [...prev, ...list] : list);
            setNextBefore(res.data ? res.data.nextBefore : null);
        } catch (err) {
            if (mountedRef.current && seq === seqRef.current) setError(err.response?.data?.error || 'Failed to load history');
        } finally {
            if (mountedRef.current && seq === seqRef.current) setLoading(false);
        }
    }, []);

    // Deferred so no state is set synchronously in the effect body
    useEffect(() => { Promise.resolve().then(() => load(null)); }, [load, refreshKey]);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex justify-between items-center">
                <h4 className="text-warning">Job History</h4>
                <button className="btn btn-outline text-xs" disabled={loading} onClick={() => load(null)}>Refresh</button>
            </div>
            {error && <div className="text-xs text-danger">{error}</div>}
            {jobs.length === 0 && !loading && !error && <div className="text-sm text-secondary italic">No provisioning jobs yet.</div>}
            {jobs.map(j => (
                <button
                    key={j.id}
                    type="button"
                    onClick={() => onOpenJob(j.id)}
                    className={`text-left p-3 rounded border ${selectedId === j.id ? 'border-primary' : 'border-white/10'} bg-black/30 hover:bg-white/5`}
                    style={{ cursor: 'pointer' }}
                >
                    <div className="flex justify-between items-center">
                        <span className="text-sm"><span className="font-mono text-primary">{String(j.id).slice(0, 8)}</span> {j.buType} / {j.osType}</span>
                        <span className={`text-xs px-2 py-0.5 rounded ${toneClass(jobStatusTone(j.status))}`}>{j.status}</span>
                    </div>
                    <div className="text-xs text-secondary">{formatTime(j.createdAt)} by {j.createdBy} ({formatDuration(j.startedAt || j.createdAt, j.finishedAt)})</div>
                    <div className="text-xs text-muted">{jobSummaryLine(j)}</div>
                </button>
            ))}
            {loading && <div className="text-xs text-muted">Loading...</div>}
            {nextBefore !== null && nextBefore !== undefined && !loading && (
                <button className="btn btn-outline text-sm" onClick={() => load(nextBefore)}>Load more</button>
            )}
        </div>
    );
};

export default ProvisionHistory;
