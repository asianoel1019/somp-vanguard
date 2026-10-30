import React from 'react';
import { checkLabel, precheckColumns, installedNote } from './provisionUtils';

// Pre-check result table: one row per host, one column per check (icon + tooltip message).
const ProvisionPrecheck = ({ precheck }) => {
    if (!precheck) return null;
    const hosts = precheck.hosts || [];
    const cols = precheckColumns(hosts);
    return (
        <div className="flex flex-col gap-2">
            <div className={`text-sm ${precheck.ok ? 'text-success' : 'text-warning'}`}>
                {precheck.ok ? 'Pre-check passed for all hosts.' : 'Pre-check found problems. You can still install, but affected hosts may fail.'}
            </div>
            {precheck.note && <div className="text-xs text-muted italic">{precheck.note}</div>}
            {precheck.nas && !precheck.nas.ok && <div className="text-xs text-danger">NAS: {precheck.nas.message}</div>}
            <div style={{ overflowX: 'auto' }}>
                <table className="w-full text-xs">
                    <thead>
                        <tr className="text-secondary text-left">
                            <th className="p-1">Host</th>
                            {cols.map(c => <th key={c} className="p-1">{checkLabel(c)}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {hosts.map(h => (
                            <React.Fragment key={h.ip}>
                                <tr className="border-t border-white/10">
                                    <td className="p-1 font-mono">{h.ip}{h.hostname ? <span className="text-secondary"> {h.hostname}</span> : null}</td>
                                    {cols.map(c => {
                                        const chk = (h.checks || []).find(x => x.id === c);
                                        if (!chk) return <td key={c} className="p-1 text-muted">-</td>;
                                        return (
                                            <td key={c} className={`p-1 ${chk.ok ? 'text-success' : 'text-danger'}`} title={chk.message || ''}>
                                                {chk.ok ? '✔' : '✖'}
                                            </td>
                                        );
                                    })}
                                </tr>
                                {installedNote(h) && (
                                    <tr>
                                        <td colSpan={cols.length + 1} className="px-1 pb-1 text-secondary">{checkLabel('installed')}: {installedNote(h)}</td>
                                    </tr>
                                )}
                                {(h.checks || []).filter(x => !x.ok && x.message).map(x => (
                                    <tr key={`${h.ip}-${x.id}`}>
                                        <td colSpan={cols.length + 1} className="px-1 pb-1 text-danger">{checkLabel(x.id)}: {x.message}</td>
                                    </tr>
                                ))}
                            </React.Fragment>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

export default ProvisionPrecheck;
