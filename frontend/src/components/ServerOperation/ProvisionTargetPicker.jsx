import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import { parseManualIps } from './provisionUtils';

// Target picker: debounced CMDB / inventory search (multi-select chips) plus manual IP entry.
// Manual IPs that do not match a known target are flagged; SuperAdmin may allow unknown targets.
const ProvisionTargetPicker = ({
    selected, setSelected, manualText, setManualText, disabled,
    isSuperAdmin, allowUnknown, setAllowUnknown, knownRef, onUnknownChange
}) => {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState('');
    const [open, setOpen] = useState(false);
    const [unknownIps, setUnknownIps] = useState([]);
    const mountedRef = useRef(true);
    const checkedRef = useRef(new Set());   // IPs already looked up (found or not): never queried twice
    const wrapRef = useRef(null);
    useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

    // Debounced search (300 ms)
    useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        const t = setTimeout(async () => {
            setSearching(true);
            setSearchError('');
            try {
                const res = await api.get('/install/targets', { params: { q: query.trim(), limit: 30 } });
                if (cancelled || !mountedRef.current) return;
                const list = (res.data && res.data.targets) || [];
                list.forEach(tg => knownRef.current.add(tg.ip));
                setResults(list);
            } catch (err) {
                if (!cancelled && mountedRef.current) setSearchError(err.response?.data?.error || 'Target search failed');
            } finally {
                if (!cancelled && mountedRef.current) setSearching(false);
            }
        }, 300);
        return () => { cancelled = true; clearTimeout(t); };
    }, [query, open, knownRef]);

    // Look up manual IPs once (debounced) to flag unknown ones
    const manualKey = parseManualIps(manualText).valid.join(',');
    useEffect(() => {
        const ips = manualKey ? manualKey.split(',') : [];
        let cancelled = false;
        const t = setTimeout(async () => {
            const toCheck = ips.filter(ip => !knownRef.current.has(ip) && !checkedRef.current.has(ip)).slice(0, 20);
            for (const ip of toCheck) {
                if (cancelled) return;
                try {
                    const res = await api.get('/install/targets', { params: { q: ip, limit: 5 } });
                    ((res.data && res.data.targets) || []).forEach(tg => { if (tg.ip === ip) knownRef.current.add(ip); });
                    checkedRef.current.add(ip);
                } catch { /* not cached: a transient error may be retried on the next edit */ }
            }
            if (cancelled || !mountedRef.current) return;
            const unk = ips.filter(ip => !knownRef.current.has(ip));
            setUnknownIps(unk);
            if (onUnknownChange) onUnknownChange(unk);
        }, 500);
        return () => { cancelled = true; clearTimeout(t); };
    }, [manualKey, knownRef, onUnknownChange]);

    const closeList = () => { setOpen(false); setSearching(false); };

    // Close the list on outside click / Escape
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setSearching(false); } };
        const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setSearching(false); } };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    }, [open]);

    const isSelected = (ip) => selected.some(s => s.ip === ip);
    const toggle = (tg) => {
        if (isSelected(tg.ip)) setSelected(selected.filter(s => s.ip !== tg.ip));
        else setSelected([...selected, tg]);
    };
    const parsedManual = parseManualIps(manualText);

    return (
        <div className="flex flex-col gap-3">
            <div ref={wrapRef}>
                <label className="text-secondary text-sm mb-2 block">Search CMDB / inventory</label>
                <input
                    type="text"
                    className="w-full text-sm"
                    placeholder="Hostname or IP"
                    value={query}
                    disabled={disabled}
                    onFocus={() => setOpen(true)}
                    onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
                />
                {open && (
                    <div className="mt-1 border border-white/10 rounded bg-black/40" style={{ maxHeight: '12rem', overflowY: 'auto' }}>
                        {searching && <div className="p-2 text-xs text-muted">Searching...</div>}
                        {searchError && <div className="p-2 text-xs text-danger">{searchError}</div>}
                        {!searching && !searchError && results.length === 0 && <div className="p-2 text-xs text-muted italic">No matching targets.</div>}
                        {results.map(tg => (
                            <label key={tg.ip} className="flex items-center gap-2 p-2 text-sm hover:bg-white/5" style={{ cursor: 'pointer' }}>
                                <input type="checkbox" checked={isSelected(tg.ip)} disabled={disabled} onChange={() => toggle(tg)} />
                                <span className="font-mono">{tg.ip}</span>
                                <span className="text-secondary">{tg.hostname || ''}</span>
                                <span className="text-xs text-muted ml-auto">{tg.os || ''} {tg.source ? `[${tg.source}]` : ''}</span>
                            </label>
                        ))}
                        <div className="p-1 text-right">
                            <button type="button" className="btn btn-outline text-xs" onClick={closeList}>Close list</button>
                        </div>
                    </div>
                )}
                {selected.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                        {selected.map(tg => (
                            <span key={tg.ip} className="text-xs px-2 py-1 rounded bg-primary/20 text-primary flex items-center gap-1" title={tg.hostname || ''}>
                                {tg.ip}{tg.hostname ? ` (${tg.hostname})` : ''}
                                {!disabled && (
                                    <button type="button" aria-label={`Remove ${tg.ip}`} onClick={() => toggle(tg)} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}>x</button>
                                )}
                            </span>
                        ))}
                    </div>
                )}
            </div>

            <div>
                <label className="text-secondary text-sm mb-2 block">Manual IPs (One per line)</label>
                <textarea
                    className="w-full font-mono text-sm"
                    rows="5"
                    placeholder="10.99.x.x"
                    value={manualText}
                    disabled={disabled}
                    onChange={(e) => setManualText(e.target.value)}
                />
                {parsedManual.invalid.length > 0 && (
                    <div className="text-xs text-danger mt-1">Invalid IPv4: {parsedManual.invalid.join(', ')}</div>
                )}
                {unknownIps.length > 0 && (
                    <div className="text-xs text-warning mt-1">
                        Not found in CMDB / inventory: {unknownIps.join(', ')}. Stored credentials are only used for known targets.
                    </div>
                )}
                {isSuperAdmin && (
                    <div className="flex items-center gap-2 mt-2">
                        <input type="checkbox" id="allow-unknown-toggle" checked={allowUnknown} disabled={disabled} onChange={(e) => setAllowUnknown(e.target.checked)} />
                        <label htmlFor="allow-unknown-toggle" className="text-sm" style={{ cursor: 'pointer' }}>Allow unknown targets</label>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ProvisionTargetPicker;
