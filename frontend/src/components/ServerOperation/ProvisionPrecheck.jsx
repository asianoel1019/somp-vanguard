import React from 'react';
import { TbCircleCheck, TbCircleX } from 'react-icons/tb';
import { Alert } from './ProvisionUi';
import { checkLabel, precheckColumns, installedNote } from './provisionUtils';

// Pre-check result table: one row per host, one column per check; the reason of every failed check is listed under its host.
const ProvisionPrecheck = ({ precheck }) => {
    if (!precheck) return null;
    const hosts = precheck.hosts || [];
    const cols = precheckColumns(hosts);
    return (
        <div className="pv-section">
            <Alert tone={precheck.ok ? 'success' : 'warning'}>
                {precheck.ok ? 'Pre-check passed for all hosts.' : 'Pre-check found problems. You can still install, but affected hosts may fail.'}
            </Alert>
            {precheck.note && <div className="pv-help" style={{ fontStyle: 'italic' }}>{precheck.note}</div>}
            {precheck.nas && !precheck.nas.ok && <Alert tone="danger">NAS: {precheck.nas.message}</Alert>}
            <div className="pv-scroll">
                <table className="pv-table">
                    <thead>
                        <tr>
                            <th>Host</th>
                            {cols.map(c => <th key={c} style={{ textAlign: 'center' }}>{checkLabel(c)}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {hosts.map(h => {
                            const failed = (h.checks || []).filter(x => !x.ok && x.message);
                            const note = installedNote(h);
                            return (
                                <React.Fragment key={h.ip}>
                                    <tr>
                                        <td><span className="pv-mono">{h.ip}</span>{h.hostname ? <span className="pv-host-name"> {h.hostname}</span> : null}</td>
                                        {cols.map(c => {
                                            const chk = (h.checks || []).find(x => x.id === c);
                                            if (!chk) return <td key={c} className="pv-muted" style={{ textAlign: 'center' }}>-</td>;
                                            const Icon = chk.ok ? TbCircleCheck : TbCircleX;
                                            return (
                                                <td key={c} style={{ textAlign: 'center' }} title={chk.message || ''}>
                                                    <Icon size={18} style={{ color: chk.ok ? 'var(--success)' : 'var(--danger)' }} aria-label={`${checkLabel(c)}: ${chk.ok ? 'ok' : 'failed'}`} />
                                                </td>
                                            );
                                        })}
                                    </tr>
                                    {(note || failed.length > 0) && (
                                        <tr>
                                            <td colSpan={cols.length + 1} className="pv-sub">
                                                {note && <div className="pv-muted">{checkLabel('installed')}: {note}</div>}
                                                {failed.map(x => <div key={x.id} style={{ color: 'var(--danger)' }}>{checkLabel(x.id)}: {x.message}</div>)}
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default ProvisionPrecheck;
