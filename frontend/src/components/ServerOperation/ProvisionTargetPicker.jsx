import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import { parseManualIps } from './provisionUtils';
import { TbSearch, TbX } from 'react-icons/tb';

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
        <div className="pv-section">
            <div ref={wrapRef}>
                <label className="pv-label" htmlFor="pv-target-search">Search CMDB / inventory</label>
                <div className="pv-search" style={{ maxWidth: 'none' }}>
                    <TbSearch size={16} aria-hidden="true" />
                    <input
                        id="pv-target-search"
                        type="text"
                        className="text-sm"
                        placeholder="Hostname or IP"
                        value={query}
                        disabled={disabled}
                        autoComplete="off"
                        onFocus={() => setOpen(true)}
                        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
                    />
                </div>
                {open && (
                    <div className="mt-1" style={{ maxHeight: '14rem', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
                        {searching && <div className="pv-help" style={{ padding: 8 }}>Searching...</div>}
                        {searchError && <div className="pv-help" style={{ padding: 8, color: 'var(--danger)' }}>{searchError}</div>}
                        {!searching && !searchError && results.length === 0 && <div className="pv-help" style={{ padding: 8, fontStyle: 'italic' }}>No matching targets.</div>}
                        {results.map(tg => (
                            <label key={tg.ip} className="flex items-center gap-2 text-sm hover:bg-white/5" style={{ cursor: 'pointer', padding: '7px 10px' }}>
                                <input type="checkbox" checked={isSelected(tg.ip)} disabled={disabled} onChange={() => toggle(tg)} />
                                <span className="pv-mono">{tg.ip}</span>
                                <span style={{ color: 'var(--text-secondary)' }}>{tg.hostname || ''}</span>
                                <span className="pv-help" style={{ marginLeft: 'auto' }}>{tg.os || ''} {tg.source ? `[${tg.source}]` : ''}</span>
                            </label>
                        ))}
                        <div style={{ padding: 6, textAlign: 'right' }}>
                            <button type="button" className="btn btn-outline text-xs" onClick={closeList}>Close list</button>
                        </div>
                    </div>
                )}
                {selected.length > 0 && (
                    <div className="pv-chips" style={{ marginTop: 8 }}>
                        {selected.map(tg => (
                            <span key={tg.ip} className="pv-chip" title={tg.hostname || ''}>
                                <span className="pv-mono">{tg.ip}</span>{tg.hostname ? <span style={{ color: 'var(--text-secondary)' }}>{tg.hostname}</span> : null}
                                {!disabled && (
                                    <button type="button" aria-label={`Remove ${tg.ip}`} onClick={() => toggle(tg)}><TbX size={13} aria-hidden="true" /></button>
                                )}
                            </span>
                        ))}
                    </div>
                )}
            </div>

            <div>
                <label className="pv-label" htmlFor="pv-manual-ips">Manual IPs (one per line)</label>
                <textarea
                    id="pv-manual-ips"
                    className="w-full font-mono text-sm"
                    rows="4"
                    placeholder="192.0.2.10"
                    value={manualText}
                    disabled={disabled}
                    onChange={(e) => setManualText(e.target.value)}
                />
                {parsedManual.invalid.length > 0 && (
                    <div className="pv-help" style={{ color: 'var(--danger)' }}>Invalid IPv4: {parsedManual.invalid.join(', ')}</div>
                )}
                {unknownIps.length > 0 && (
                    <div className="pv-help" style={{ color: 'var(--warning)' }}>
                        Not found in CMDB / inventory: {unknownIps.join(', ')}. Stored credentials are only used for known targets.
                    </div>
                )}
                {isSuperAdmin && (
                    <div className="pv-option" style={{ marginTop: 8 }}>
                        <input type="checkbox" id="allow-unknown-toggle" checked={allowUnknown} disabled={disabled} onChange={(e) => setAllowUnknown(e.target.checked)} />
                        <div>
                            <label htmlFor="allow-unknown-toggle">Allow unknown targets</label>
                            <div className="pv-help">SuperAdmin only: provision IPs that are not in the CMDB or Server Inventory.</div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default ProvisionTargetPicker;
