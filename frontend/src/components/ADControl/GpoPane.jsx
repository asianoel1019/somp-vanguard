// Right pane for a GPO, as in GPMC: Scope, Details, Settings (the GPMC settings report) and Delegation.
import React, { useEffect, useState } from 'react';
import api from '../../api';
import { gpoLocations, securityFiltering, delegationRows, formatDate, GPO_STATUS_LABELS, GPO_STATUSES } from './gpmcModel';
import { Tabs, SectionLabel, Table, KeyValues, Notice } from './gpmcUi';
import { C, yesNo } from './gpmcStyle';

const TABS = [
    { id: 'scope', label: 'Scope' },
    { id: 'details', label: 'Details' },
    { id: 'settings', label: 'Settings' },
    { id: 'delegation', label: 'Delegation' },
];

const errorText = (e, fallback) => e?.response?.data?.error || fallback;

export default function GpoPane({ guid, tree, canEdit, canReport, refreshKey, onSetStatus, onOpenContainer }) {
    const [tab, setTab] = useState('scope');
    const [detail, setDetail] = useState({ guid: null, data: null, error: null });
    const [report, setReport] = useState({ guid: null, html: null, error: null });
    const gpo = tree.gpoById.get(guid);

    useEffect(() => {
        let alive = true;
        api.get('/gpo/detail', { params: { guid } })
            .then(r => { if (alive) setDetail({ guid, data: r.data, error: null }); })
            .catch(e => { if (alive) setDetail({ guid, data: null, error: errorText(e, 'Could not read the GPO.') }); });
        return () => { alive = false; };
    }, [guid, refreshKey]);

    useEffect(() => {
        if (tab !== 'settings' || !canReport) return undefined;
        let alive = true;
        api.get('/gpo/report', { params: { guid } })
            .then(r => { if (alive) setReport({ guid, html: r.data.html || '', error: null }); })
            .catch(e => { if (alive) setReport({ guid, html: null, error: errorText(e, 'Could not build the settings report.') }); });
        return () => { alive = false; };
    }, [tab, guid, canReport, refreshKey]);

    const d = detail.guid === guid ? detail.data : null;
    const detailError = detail.guid === guid ? detail.error : null;
    const name = (gpo && gpo.name) || (d && d.name) || guid;
    const locations = gpoLocations(guid, tree);

    const loadingOr = (content) => (detailError ? <Notice tone="error">{detailError}</Notice> : d ? content : <Notice>Reading the GPO from the domain controller…</Notice>);

    return (
        <div>
            <div style={{ padding: '14px 16px 6px', fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>{name}</div>
            <Tabs tabs={TABS} active={tab} onChange={setTab} />
            <div style={{ padding: '4px 16px 16px' }}>
                {tab === 'scope' && (
                    <>
                        <SectionLabel>Links — the following domains and OUs are linked to this GPO</SectionLabel>
                        <Table
                            columns={[
                                { key: 'location', label: 'Location' },
                                { key: 'enforced', label: 'Enforced', render: r => yesNo(r.enforced) },
                                { key: 'enabled', label: 'Link Enabled', render: r => yesNo(r.enabled) },
                                { key: 'path', label: 'Path' },
                            ]}
                            rows={locations.map(l => ({ ...l, key: `${l.path}:${l.order}` }))}
                            empty="This GPO is not linked anywhere."
                            onRowDoubleClick={(r) => onOpenContainer(r.node.dn)}
                        />
                        <SectionLabel>Security Filtering — the settings in this GPO only apply to</SectionLabel>
                        {loadingOr(
                            <Table columns={[{ key: 'name', label: 'Name' }, { key: 'sidType', label: 'Type' }]}
                                rows={securityFiltering(d && d.permissions)} empty="No one: this GPO applies to nobody." />
                        )}
                        <SectionLabel>WMI Filtering — this GPO is linked to the following WMI filter</SectionLabel>
                        <div style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{(gpo && gpo.wmiFilter) || '<none>'}</div>
                    </>
                )}

                {tab === 'details' && loadingOr(
                    <div style={{ paddingTop: '14px' }}>
                        <KeyValues items={[
                            ['Domain', d && d.domain],
                            ['Owner', d && d.owner],
                            ['Created', formatDate(d && d.created)],
                            ['Modified', formatDate(d && d.modified)],
                            ['User version', d && d.userVersion ? `${d.userVersion.ds} (AD), ${d.userVersion.sysvol} (SYSVOL)` : ''],
                            ['Computer version', d && d.computerVersion ? `${d.computerVersion.ds} (AD), ${d.computerVersion.sysvol} (SYSVOL)` : ''],
                            ['Unique ID', d && `{${String(d.id).toUpperCase()}}`],
                            ['GPO Status', canEdit ? (
                                <select value={(d && d.status) || ''} onChange={(e) => onSetStatus(guid, name, e.target.value)}
                                    style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: C.border, borderRadius: '6px', padding: '4px 6px', fontSize: '12.5px' }}>
                                    {GPO_STATUSES.map(s => <option key={s} value={s}>{GPO_STATUS_LABELS[s]}</option>)}
                                </select>
                            ) : (GPO_STATUS_LABELS[d && d.status] || (d && d.status))],
                            ['Comment', (d && d.description) || ''],
                        ]} />
                        {d && d.userVersion && (d.userVersion.ds !== d.userVersion.sysvol || d.computerVersion.ds !== d.computerVersion.sysvol) && (
                            <div style={{ marginTop: '14px', fontSize: '12.5px', color: '#f59e0b' }}>The AD and SYSVOL versions differ: replication may still be in progress.</div>
                        )}
                    </div>
                )}

                {tab === 'settings' && (!canReport ? (
                    <Notice>The settings report is available to Operators and SuperAdmins.</Notice>
                ) : report.guid !== guid ? (
                    <Notice>Generating report…</Notice>
                ) : report.error ? (
                    <Notice tone="error">{report.error}</Notice>
                ) : (
                    <iframe title={`Settings of ${name}`} sandbox="" srcDoc={report.html}
                        style={{ width: '100%', height: '65vh', marginTop: '12px', border: C.border, borderRadius: '8px', background: '#fff' }} />
                ))}

                {tab === 'delegation' && loadingOr(
                    <>
                        <SectionLabel>These groups and users have the specified permission for this GPO</SectionLabel>
                        <Table columns={[{ key: 'name', label: 'Name' }, { key: 'allowed', label: 'Allowed Permissions' }, { key: 'inherited', label: 'Inherited' }]}
                            rows={delegationRows(d && d.permissions)} />
                    </>
                )}
            </div>
        </div>
    );
}
