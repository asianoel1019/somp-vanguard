import React, { useState, useRef, useCallback } from 'react';
import api from '../../api';
import ProvisionTargetPicker from './ProvisionTargetPicker';
import ProvisionPrecheck from './ProvisionPrecheck';
import ProvisionJobView from './ProvisionJobView';
import ProvisionHistory from './ProvisionHistory';
import { Segmented, Alert, EmptyState } from './ProvisionUi';
import { TbRocket, TbHistory, TbBrandWindows, TbTerminal2, TbTarget, TbAdjustmentsHorizontal, TbPackage, TbShieldCheck, TbPlayerPlay, TbListDetails } from 'react-icons/tb';
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

    const busy = loading || prechecking;
    const osOptions = [
        { id: 'windows', label: 'Windows', icon: TbBrandWindows },
        { id: 'linux', label: 'Linux', icon: TbTerminal2 },
    ];
    const tabs = [
        ...(canWrite ? [{ id: 'provision', label: 'Provision', icon: TbRocket }] : []),
        { id: 'history', label: 'History', icon: TbHistory },
    ];

    return (
        <div className="animate-fade-in p-4 pv-page">
            <div className="pv-header">
                <div>
                    <h1 className="page-title">Server Provision</h1>
                    <p className="page-subtitle">Install the software of a template on Windows or Linux servers, with a pre-check and a job history.</p>
                </div>
                <Segmented options={tabs} value={tab} onChange={setTab} ariaLabel="Server Provision views" />
            </div>

            {tab === 'history' && (
                <ProvisionHistory canWrite={canWrite} refreshKey={historyKey} onActiveChange={handleJobActive} />
            )}

            {tab === 'provision' && canWrite && (
                <div className="pv-grid">
                    {/* Configuration */}
                    <div className="glass-panel pv-card">
                        <h4 className="pv-card-title">
                            <span>Configuration</span>
                            <Segmented small options={osOptions} value={osType} disabled={busy} ariaLabel="Operating system"
                                onChange={(v) => { setOsType(v); resetChecks(); }} />
                        </h4>
                        {errorMsg && <Alert tone="danger">{errorMsg}</Alert>}

                        <section className="pv-section">
                            <div className="pv-section-title">
                                <TbTarget size={16} aria-hidden="true" /> Targets
                                <span className="pv-count">{ipList.length} host{ipList.length === 1 ? '' : 's'}</span>
                            </div>
                            <ProvisionTargetPicker
                                selected={selected} setSelected={(v) => { setSelected(v); invalidate(); }}
                                manualText={manualText} setManualText={(v) => { setManualText(v); invalidate(); }}
                                disabled={busy}
                                isSuperAdmin={isSuperAdmin} allowUnknown={allowUnknown} setAllowUnknown={(v) => { setAllowUnknown(v); invalidate(); }}
                                knownRef={knownRef}
                            />
                        </section>

                        <section className="pv-section">
                            <div className="pv-section-title"><TbAdjustmentsHorizontal size={16} aria-hidden="true" /> Template &amp; options</div>
                            <div>
                                <label className="pv-label" htmlFor="pv-bu">Business unit (template)</label>
                                <select id="pv-bu" value={buType} disabled={prechecking} onChange={(e) => { setBuType(e.target.value); invalidate(); }}>
                                    {config.bus.map(bu => <option key={bu} value={bu}>{bu}</option>)}
                                </select>
                            </div>
                            <div className="pv-option">
                                <input type="checkbox" id="reboot-toggle" checked={reboot} onChange={(e) => setReboot(e.target.checked)} />
                                <div><label htmlFor="reboot-toggle">Auto reboot</label><div className="pv-help">Restart a host when a package asks for it.</div></div>
                            </div>
                            <div className="pv-option">
                                <input type="checkbox" id="force-reinstall-toggle" checked={forceReinstall} onChange={(e) => { setForceReinstall(e.target.checked); invalidate(); }} />
                                <div>
                                    <label htmlFor="force-reinstall-toggle">Force reinstall</label>
                                    <div className="pv-help">Packages with a detect rule that are already installed are skipped. Force reinstall ignores the rules.</div>
                                </div>
                            </div>
                            {osType === 'windows' && (
                                <div className="pv-option">
                                    <input type="checkbox" id="keep-installers-toggle" checked={keepInstallers} onChange={(e) => setKeepInstallers(e.target.checked)} />
                                    <div>
                                        <label htmlFor="keep-installers-toggle">Keep installers (troubleshooting)</label>
                                        <div className="pv-help">Installers are copied to X:\SOMP_Provision\&lt;job id&gt; and removed afterwards (kept folders are swept after 7 days). Drive X: must already exist (Nutanix Clone VM prepares it).</div>
                                    </div>
                                </div>
                            )}
                        </section>

                        <section className="pv-section">
                            <div className="pv-section-title">
                                <TbPackage size={16} aria-hidden="true" /> Included packages
                                <span className="pv-count">{activeMapping.length}</span>
                            </div>
                            {activeMapping.length > 0
                                ? <div className="pv-chips">{activeMapping.map((sw, idx) => <span key={`${sw}-${idx}`} className="pv-chip">{sw}</span>)}</div>
                                : <div className="pv-help">No software configured for this business unit.</div>}
                        </section>

                        <div className="pv-btn-row">
                            <button type="button" className="btn btn-outline" onClick={handlePrecheck} disabled={busy || ipList.length === 0}>
                                <TbShieldCheck size={16} aria-hidden="true" /> {prechecking ? 'Checking...' : 'Pre-check'}
                            </button>
                            <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={handleExecute} disabled={busy || ipList.length === 0}>
                                <TbPlayerPlay size={16} aria-hidden="true" /> {loading ? 'Starting...' : `Start ${osType === 'windows' ? 'Windows' : 'Linux'} provisioning`}
                            </button>
                        </div>
                    </div>

                    {/* Pre-check and execution */}
                    <div className="glass-panel pv-card">
                        {precheck && (
                            <section className="pv-section">
                                <div className="pv-section-title"><TbShieldCheck size={16} aria-hidden="true" /> Pre-check</div>
                                <ProvisionPrecheck precheck={precheck} />
                            </section>
                        )}
                        <section className="pv-section">
                            <div className="pv-section-title"><TbListDetails size={16} aria-hidden="true" /> Execution</div>
                            {jobId ? (
                                <ProvisionJobView key={jobId} jobId={jobId} canWrite={canWrite} onOpenJob={(id) => { setJobId(id); setHistoryKey(k => k + 1); }} onActiveChange={handleJobActive} />
                            ) : (
                                <EmptyState icon={TbRocket} title="No active deployment"
                                    hint={'Select targets, optionally run Pre-check, then click "Start" to begin.'} />
                            )}
                        </section>
                    </div>
                </div>
            )}
        </div>
    );
};

export default RemoteInstall;
