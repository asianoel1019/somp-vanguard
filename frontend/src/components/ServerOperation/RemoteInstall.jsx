import React, { useState, useRef, useCallback } from 'react';
import api from '../../api';
import ProvisionTargetPicker from './ProvisionTargetPicker';
import ProvisionPrecheck from './ProvisionPrecheck';
import ProvisionJobView from './ProvisionJobView';
import ProvisionHistory from './ProvisionHistory';
import { mergeTargets, parseManualIps, buildExecuteBody, buildPrecheckBody, installWarning } from './provisionUtils';

const RemoteInstall = ({ setIsProcessing }) => {
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const role = user.role || 'Viewer';
    const canWrite = role === 'Operator' || role === 'SuperAdmin';
    const isSuperAdmin = role === 'SuperAdmin';
    const [tab, setTab] = useState(canWrite ? 'provision' : 'history');
    const [selected, setSelected] = useState([]);
    const [manualText, setManualText] = useState('');
    const [allowUnknown, setAllowUnknown] = useState(false);
    const [buType, setBuType] = useState('Basic');
    const [osType, setOsType] = useState('windows');
    const [reboot, setReboot] = useState(true);
    const [forceReinstall, setForceReinstall] = useState(false);
    const [keepInstallers, setKeepInstallers] = useState(false);
    const [loading, setLoading] = useState(false);
    const [prechecking, setPrechecking] = useState(false);
    const [precheck, setPrecheck] = useState(null);
    const [precheckIps, setPrecheckIps] = useState([]);
    const [jobId, setJobId] = useState(null);
    const [historyJobId, setHistoryJobId] = useState(null);
    const [historyKey, setHistoryKey] = useState(0);
    const [errorMsg, setErrorMsg] = useState('');
    const [config, setConfig] = useState({ bus: [], mapping: {}, linuxMapping: {} });
    const knownRef = useRef(new Set());
    const precheckSeq = useRef(0);

    React.useEffect(() => {
        const fetchConfig = async () => {
            try {
                const res = await api.get('/install/config');
                let data = res.data;
                let busList = data.bus || [];
                if (!busList.includes('Basic')) {
                    busList = ['Basic', ...busList];
                }
                data.bus = busList;
                setConfig(data);
                setBuType('Basic');
            } catch (err) {
                console.error('Failed to fetch install config', err);
            }
        };
        fetchConfig();
    }, []);

    const ipList = mergeTargets(selected, manualText);
    const invalidManual = parseManualIps(manualText).invalid;
    // Any change that affects the request invalidates the pre-check (and ignores a response still in flight)
    const invalidate = () => { precheckSeq.current++; setPrecheck(null); setPrecheckIps([]); setPrechecking(false); };
    const resetChecks = () => { invalidate(); setErrorMsg(''); };

    const handleJobActive = useCallback((active) => { setIsProcessing(!!active); }, [setIsProcessing]);

    const validate = () => {
        if (ipList.length === 0) { setErrorMsg('Please select or enter at least one IP address.'); return false; }
        if (invalidManual.length) { setErrorMsg(`Invalid IPv4 address: ${invalidManual.join(', ')}`); return false; }
        if (ipList.length > 50) { setErrorMsg('At most 50 hosts per request.'); return false; }
        setErrorMsg('');
        return true;
    };

    const activeMapping = osType === 'windows'
        ? (config.mapping[buType] || [])
        : (config.linuxMapping?.[buType] || []);

    const handlePrecheck = async () => {
        if (!validate()) return;
        const seq = ++precheckSeq.current;
        setPrechecking(true);
        setPrecheck(null);
        try {
            const res = await api.post('/install/precheck', buildPrecheckBody({
                ips: ipList, buType, osType, software: activeMapping, forceReinstall, allowUnknownTargets: allowUnknown, isSuperAdmin
            }));
            if (seq !== precheckSeq.current) return;
            setPrecheck(res.data);
            setPrecheckIps(ipList);
        } catch (err) {
            if (seq === precheckSeq.current) setErrorMsg(err.response?.data?.error || err.message);
        } finally {
            if (seq === precheckSeq.current) setPrechecking(false);
        }
    };

    const handleExecute = async () => {
        if (!validate()) return;
        const warning = installWarning(precheck, ipList, precheckIps);
        const msg = `${warning ? warning + ' ' : ''}Start ${osType} provisioning on ${ipList.length} host(s)?`;
        if (!window.confirm(msg)) return;
        setLoading(true);
        try {
            const res = await api.post('/install/execute', buildExecuteBody({
                ips: ipList, buType, reboot, osType, forceReinstall, keepInstallers, allowUnknownTargets: allowUnknown, isSuperAdmin
            }));
            const id = res.data && res.data.jobId;
            if (!id) { setErrorMsg('Unexpected response: no job id returned.'); return; }
            setJobId(id);
            setHistoryKey(k => k + 1);
        } catch (err) {
            console.error(err);
            const d = err.response?.data;
            setErrorMsg(d ? `${d.error || 'Request failed'}${d.unknownTargets ? `: ${d.unknownTargets.join(', ')}` : ''}` : err.message);
        } finally {
            setLoading(false);
        }
    };

    const openFromHistory = (id) => { setHistoryJobId(id); };
    const openRetried = (id) => { setHistoryJobId(id); setHistoryKey(k => k + 1); };

    return (
        <div className="animate-fade-in p-4">
            {/* Header */}
            <div className="mb-6 flex justify-between items-end px-1">
                <div>
                    <h1 className="page-title">
                        Server Provision
                    </h1>
                    <p className="page-subtitle">
                        Remote Server Provisioning ({osType === 'windows' ? 'Windows OS' : 'Linux OS'})
                    </p>
                </div>
            </div>

            <div className="flex gap-4 mb-4">
                {canWrite && (
                    <button className={`btn ${tab === 'provision' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('provision')}>Provision</button>
                )}
                <button className={`btn ${tab === 'history' ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab('history')}>History</button>
            </div>

            {tab === 'history' && (
                <div className="grid grid-cols-2 gap-6">
                    <div className="glass-panel p-6">
                        <ProvisionHistory onOpenJob={openFromHistory} selectedId={historyJobId} refreshKey={historyKey} />
                    </div>
                    <div className="glass-panel p-6">
                        <h4 className="mb-4 text-warning">Job Details</h4>
                        {historyJobId ? (
                            <ProvisionJobView key={historyJobId} jobId={historyJobId} canWrite={canWrite} onOpenJob={openRetried} onActiveChange={handleJobActive} />
                        ) : (
                            <div className="text-secondary text-sm italic">Select a job from the list.</div>
                        )}
                    </div>
                </div>
            )}

            {tab === 'provision' && canWrite && (<>
            <div className="flex gap-4 mb-6" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
                <button 
                    className={`btn ${osType === 'windows' ? 'btn-primary' : 'btn-outline'}`}
                    disabled={prechecking || loading}
                    onClick={() => { setOsType('windows'); resetChecks(); }}
                >
                    Windows Provisioning
                </button>
                <button 
                    className={`btn ${osType === 'linux' ? 'btn-primary' : 'btn-outline'}`}
                    disabled={prechecking || loading}
                    onClick={() => { setOsType('linux'); resetChecks(); }}
                >
                    Linux Provisioning
                </button>
            </div>

            <div className="grid grid-cols-2 gap-6">
                {/* Configuration Panel */}
                <div className="glass-panel p-6">
                    <h4 className={`mb-4 ${osType === 'windows' ? 'text-primary' : 'text-success'}`}>
                        {osType === 'windows' ? 'Windows Infrastructure' : 'Linux Infrastructure'}
                    </h4>
                    <div className="flex flex-col gap-4">
                        {errorMsg && (
                            <div className="p-3 bg-danger/20 border border-danger/35 rounded text-danger text-sm flex items-center gap-2">
                                ⚠️ {errorMsg}
                            </div>
                        )}
                        <ProvisionTargetPicker
                            selected={selected} setSelected={(v) => { setSelected(v); invalidate(); }}
                            manualText={manualText} setManualText={(v) => { setManualText(v); invalidate(); }}
                            disabled={loading || prechecking}
                            isSuperAdmin={isSuperAdmin} allowUnknown={allowUnknown} setAllowUnknown={(v) => { setAllowUnknown(v); invalidate(); }}
                            knownRef={knownRef}
                        />

                        <div className="flex items-end" style={{ gap: '3rem' }}>
                            <div className="flex-1">
                                <label className="text-secondary text-sm mb-2 block">Business Unit (Template)</label>
                                <select value={buType} disabled={prechecking} onChange={(e) => { setBuType(e.target.value); invalidate(); }}>
                                    {config.bus.map(bu => (
                                        <option key={bu} value={bu}>{bu}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex flex-col gap-1 mb-2">
                                <div className="flex items-center gap-2">
                                    <input 
                                        type="checkbox" 
                                        id="reboot-toggle" 
                                        checked={reboot} 
                                        onChange={(e) => setReboot(e.target.checked)} 
                                    />
                                    <label htmlFor="reboot-toggle" className="text-sm" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>Auto Reboot</label>
                                </div>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        id="force-reinstall-toggle"
                                        checked={forceReinstall}
                                        onChange={(e) => { setForceReinstall(e.target.checked); invalidate(); }}
                                    />
                                    <label htmlFor="force-reinstall-toggle" className="text-sm" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>Force reinstall</label>
                                </div>
                                <div className="text-xs text-muted" style={{ maxWidth: '16rem' }}>
                                    Packages with a detect rule that are already installed are skipped. Force reinstall ignores the rules.
                                </div>
                                {osType === 'windows' && (
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="checkbox"
                                            id="keep-installers-toggle"
                                            checked={keepInstallers}
                                            onChange={(e) => setKeepInstallers(e.target.checked)}
                                        />
                                        <label htmlFor="keep-installers-toggle" className="text-sm" style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>Keep installers (troubleshooting)</label>
                                    </div>
                                )}
                                {osType === 'windows' && (
                                    <div className="text-xs text-muted" style={{ maxWidth: '16rem' }}>
                                        Installers are copied to X:\SOMP_Provision\&lt;job id&gt; and removed afterwards (kept folders are swept after 7 days). Drive X: must already exist (Nutanix Clone VM prepares it).
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="mt-2 p-4 bg-black/20 border border-white/5 rounded">
                            <h5 className="text-xs font-bold text-secondary uppercase tracking-wider mb-2">Included in this template:</h5>
                            <ul className="text-sm flex flex-col gap-1 text-muted" style={{ listStyleType: 'disc', listStylePosition: 'inside', paddingLeft: '0.5rem' }}>
                                {activeMapping.length > 0 ? (
                                    activeMapping.map((sw, idx) => (
                                        <li key={idx} style={{ marginLeft: '-0.2rem' }}>{sw}</li>
                                    ))
                                ) : (
                                    <li className="list-none italic text-secondary">No software configured for this BU</li>
                                )}
                            </ul>
                        </div>

                        <button
                            className="btn btn-outline mt-2"
                            onClick={handlePrecheck}
                            disabled={prechecking || loading || ipList.length === 0}
                        >
                            {prechecking ? 'Checking...' : 'Pre-check'}
                        </button>
                        <button
                            className={`btn transition-all duration-300 ${(ipList.length === 0 || loading || prechecking) ? 'bg-white/5 text-white/30 border-white/10 cursor-not-allowed' : 'btn-primary shadow-lg shadow-primary/30'}`}
                            onClick={handleExecute}
                            disabled={loading || prechecking || ipList.length === 0}
                        >
                            {loading ? 'Starting...' : `🚀 Start Remote ${osType === 'windows' ? 'Windows' : 'Linux'} Provisioning`}
                        </button>
                    </div>
                </div>

                {/* Status / Log Panel */}
                <div className="glass-panel p-6">
                    {precheck && (
                        <div className="mb-6">
                            <h4 className="mb-2 text-warning">Pre-check</h4>
                            <ProvisionPrecheck precheck={precheck} />
                        </div>
                    )}
                    <h4 className="mb-4 text-warning">Execution</h4>
                    {jobId ? (
                        <ProvisionJobView key={jobId} jobId={jobId} canWrite={canWrite} onOpenJob={(id) => { setJobId(id); setHistoryKey(k => k + 1); }} onActiveChange={handleJobActive} />
                    ) : (
                        <div className="flex flex-col items-center justify-center text-secondary border border-dashed border-white/10 rounded p-8">
                            <p>No active deployment.</p>
                            <span className="text-xs mt-2 italic">Select targets, optionally run Pre-check, then click "Start" to begin.</span>
                        </div>
                    )}
                </div>
            </div>
            </>)}
        </div>
    );
};

export default RemoteInstall;
