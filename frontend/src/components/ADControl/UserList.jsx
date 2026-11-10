// The user account list every AD Control mode shares: filter, pages, per-account actions (details, enable / disable,
// unlock, reset password, optional grant), selection with batch Unlock / Enable / Disable, and CSV export.
import React, { useMemo, useState } from 'react';
import { FiUnlock, FiCheckCircle, FiSlash, FiKey, FiShield, FiDownload, FiLock, FiX, FiAlertOctagon } from 'react-icons/fi';
import api from '../../api';
import { BATCH_ACTIONS, MAX_BATCH, batchPreview, filterRows, toCsv, downloadText } from './adModel';
import { fieldStyle } from './adStyle';
import { Btn, Pill, Banner, ConfirmModal, PasswordModal, DataTable, Pager, Modal } from './Shared';
import UserDetailsModal from './UserDetailsModal';

const PAGE_SIZE = 50;
const SINGLE_ACTIONS = {
    enable: 'Enable the account',
    disable: 'Disable the account',
    unlock: 'Unlock the account',
    reset_password: 'Reset the password to a random one (the user must change it at the next sign-in)',
};

/**
 * users: [{ Name, SamAccountName, Description, Enabled, LockedOut, ... }]
 * extraColumns: [{ key, label, render?(u), csv?(u) }] shown after Description
 * grant: optional { label, body: { category, bu } } — the Grant action of the BU mode
 * onChanged(): reload after a change; exportName: CSV file name without extension
 */
export default function UserList({ users, extraColumns = [], grant, onChanged, exportName = 'ad-users', summary }) {
    const role = (JSON.parse(localStorage.getItem('user') || '{}').role) || 'Viewer';
    const canEdit = role !== 'Viewer';
    const [filter, setFilter] = useState('');
    const [page, setPage] = useState(1);
    const [selected, setSelected] = useState(() => new Set());
    const [confirm, setConfirm] = useState(null); // { sam, action, label }
    const [busy, setBusy] = useState(false);
    const [password, setPassword] = useState(null);
    const [details, setDetails] = useState(null);
    const [batch, setBatch] = useState(null); // { action, change, unchanged, results? }
    const [message, setMessage] = useState(null);

    const filtered = useMemo(() => filterRows(users, filter, ['Name', 'SamAccountName', 'Description']), [users, filter]);
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const current = Math.min(page, pages);
    const shown = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
    // selection only counts accounts still listed
    const listedSel = useMemo(() => new Set((users || []).filter(u => selected.has(u.SamAccountName)).map(u => u.SamAccountName)), [users, selected]);

    const toggle = (sam) => setSelected(prev => { const n = new Set(prev); if (n.has(sam)) n.delete(sam); else n.add(sam); return n; });
    const toggleAll = (allSelected) => setSelected(prev => {
        const n = new Set(prev);
        for (const u of shown) { if (allSelected) n.delete(u.SamAccountName); else n.add(u.SamAccountName); }
        return n;
    });

    const runSingle = async () => {
        const { sam, action } = confirm;
        setBusy(true);
        try {
            const res = await api.post('/ad/action', { sam, action, ...(action === 'grant' ? grant.body : {}) });
            if (action === 'reset_password' && res.data.password) setPassword({ sam, password: res.data.password });
            setMessage({ type: 'success', text: `${confirm.label}: ${sam} done.` });
            setConfirm(null);
            if (onChanged) onChanged();
        } catch (e) {
            setMessage({ type: 'error', text: e?.response?.data?.error || `Could not finish the action on ${sam}.` });
            setConfirm(null);
        } finally {
            setBusy(false);
        }
    };

    const openBatch = (action) => setBatch({ action, ...batchPreview(users, listedSel, action) });
    const runBatch = async () => {
        setBusy(true);
        try {
            const res = await api.post('/ad/batch-action', { action: batch.action, sams: batch.change.map(u => u.SamAccountName) });
            setBatch(b => ({ ...b, results: res.data.results }));
            setSelected(new Set());
            if (onChanged) onChanged();
        } catch (e) {
            setBatch(b => ({ ...b, results: [], error: e?.response?.data?.error || 'The batch could not run.' }));
        } finally {
            setBusy(false);
        }
    };

    const exportCsv = () => downloadText(`${exportName}.csv`, toCsv(filtered, [
        { key: 'Name', label: 'Name' },
        { key: 'SamAccountName', label: 'Account' },
        { key: 'Description', label: 'Description' },
        { key: 'Enabled', label: 'Enabled', value: u => (u.Enabled ? 'Yes' : 'No') },
        { key: 'LockedOut', label: 'Locked', value: u => (u.LockedOut ? 'Yes' : 'No') },
        ...extraColumns.map(c => ({ key: c.key, label: c.label, value: c.csv || (u => u[c.key]) })),
    ]));

    const columns = [
        { key: 'Name', label: 'Name', render: u => <span style={{ fontWeight: 600 }}>{u.Name}</span> },
        { key: 'SamAccountName', label: 'Account', render: u => (
            <button type="button" onClick={() => setDetails(u.SamAccountName)} title="Show details"
                style={{ background: 'transparent', border: 'none', padding: 0, color: 'var(--accent-primary)', fontFamily: 'monospace', cursor: 'pointer', textDecoration: 'underline' }}>{u.SamAccountName}</button>
        ) },
        { key: 'Description', label: 'Description', render: u => <span style={{ color: 'var(--text-secondary)' }}>{u.Description || ''}</span> },
        ...extraColumns,
        { key: 'status', label: 'Status', render: u => (
            <span style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
                {u.Enabled ? <Pill tone="success">Enabled</Pill> : <Pill tone="danger">Disabled</Pill>}
                {u.LockedOut && <Pill tone="warning" icon={<FiLock />}>Locked</Pill>}
                {u.Protected && <Pill tone="info" icon={<FiAlertOctagon />}>Protected</Pill>}
            </span>
        ) },
        ...(canEdit ? [{ key: 'actions', label: 'Actions', render: u => (u.Protected ? (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }} title="Administrator accounts (adminCount = 1), krbtgt and the service account cannot be changed from AD Control">Protected account</span>
        ) : (
            <span style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap' }}>
                {u.LockedOut && <Btn small tone="warning" icon={<FiUnlock />} label="Unlock" onClick={() => setConfirm({ sam: u.SamAccountName, action: 'unlock', label: SINGLE_ACTIONS.unlock })} />}
                {u.Enabled
                    ? <Btn small tone="danger" icon={<FiSlash />} label="Disable" onClick={() => setConfirm({ sam: u.SamAccountName, action: 'disable', label: SINGLE_ACTIONS.disable })} />
                    : <Btn small tone="success" icon={<FiCheckCircle />} label="Enable" onClick={() => setConfirm({ sam: u.SamAccountName, action: 'enable', label: SINGLE_ACTIONS.enable })} />}
                <Btn small tone="info" icon={<FiKey />} label="Reset password" onClick={() => setConfirm({ sam: u.SamAccountName, action: 'reset_password', label: SINGLE_ACTIONS.reset_password })} />
                {grant && <Btn small icon={<FiShield />} label={grant.label} onClick={() => setConfirm({ sam: u.SamAccountName, action: 'grant', label: grant.label })} />}
            </span>
        )) }] : []),
    ];

    return (
        <div>
            <Banner message={message} onClose={() => setMessage(null)} />
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' }}>
                <input type="search" placeholder="Filter by name, account or description" value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }}
                    style={{ ...fieldStyle, flex: '1 1 260px', maxWidth: '420px' }} />
                <Btn icon={<FiDownload />} label="Export CSV" onClick={exportCsv} disabled={filtered.length === 0} title="Export the listed accounts" />
                <span style={{ marginLeft: 'auto', fontSize: '12.5px', color: 'var(--text-muted)' }}>
                    {summary ? `${summary} · ` : ''}{filtered.length}{filter ? ` of ${users.length}` : ''} account(s) · enabled {users.filter(u => u.Enabled).length} · locked {users.filter(u => u.LockedOut).length}
                </span>
            </div>
            {canEdit && listedSel.size > 0 && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', marginBottom: '10px', borderRadius: '10px', border: '1px solid #3b82f666', background: 'rgba(59,130,246,0.08)' }}>
                    <strong style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{listedSel.size} selected</strong>
                    {listedSel.size > MAX_BATCH && <span style={{ fontSize: '12.5px', color: '#ef4444' }}>At most {MAX_BATCH} accounts at a time</span>}
                    {Object.entries(BATCH_ACTIONS).map(([a, spec]) => (
                        <Btn key={a} small label={spec.label} tone={a === 'disable' ? 'danger' : a === 'enable' ? 'success' : 'warning'} disabled={listedSel.size > MAX_BATCH} onClick={() => openBatch(a)} />
                    ))}
                    <Btn small icon={<FiX />} label="Clear" onClick={() => setSelected(new Set())} />
                </div>
            )}
            <DataTable columns={columns} rows={shown} rowKey={u => u.SamAccountName} empty={users.length ? 'No account matches the filter.' : 'No accounts.'}
                selected={canEdit ? selected : null} onToggle={toggle} onToggleAll={toggleAll} />
            <Pager page={current} pages={pages} onPage={setPage} />

            {confirm && (
                <ConfirmModal title="Confirm" confirmLabel="Confirm" danger={confirm.action !== 'unlock' && confirm.action !== 'enable'} busy={busy}
                    onCancel={() => setConfirm(null)} onConfirm={runSingle}>
                    {confirm.label} for <code>{confirm.sam}</code>?
                </ConfirmModal>
            )}
            {password && <PasswordModal sam={password.sam} password={password.password} onClose={() => setPassword(null)} />}
            {details && <UserDetailsModal samAccountName={details} onClose={() => setDetails(null)} />}
            {batch && (
                <Modal title={`${BATCH_ACTIONS[batch.action].label} ${batch.results ? '— results' : 'selected accounts'}`} width="640px"
                    onClose={busy ? undefined : () => setBatch(null)}
                    footer={batch.results ? <Btn label="Close" onClick={() => setBatch(null)} /> : (
                        <>
                            <Btn label="Cancel" disabled={busy} onClick={() => setBatch(null)} />
                            <Btn label={`${BATCH_ACTIONS[batch.action].label} ${batch.change.length} account(s)`} tone={batch.action === 'disable' ? 'danger' : 'primary'}
                                loading={busy} disabled={batch.change.length === 0} onClick={runBatch} />
                        </>
                    )}>
                    {batch.results ? (
                        <>
                            {batch.error && <Banner message={{ type: 'error', text: batch.error }} />}
                            {batch.results.length > 0 && (
                                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                                    {batch.results.filter(r => r.ok).length} {BATCH_ACTIONS[batch.action].done}, {batch.results.filter(r => !r.ok).length} failed.
                                </div>
                            )}
                            <DataTable rowKey={r => r.sam} rows={batch.results}
                                columns={[{ key: 'sam', label: 'Account' }, { key: 'ok', label: 'Result', render: r => (r.ok ? <Pill tone="success">Done</Pill> : r.refused ? <Pill tone="warning">Refused</Pill> : <Pill tone="danger">Failed</Pill>) }, { key: 'error', label: 'Error' }]} />
                        </>
                    ) : (
                        <>
                            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                                {batch.change.length} account(s) will be {BATCH_ACTIONS[batch.action].done}.
                                {batch.unchanged.length > 0 && ` ${batch.unchanged.length} already are and are left out.`}
                                {batch.protected.length > 0 && ` ${batch.protected.length} protected account(s) cannot be changed here and are left out.`} Each account is recorded in the audit log.
                            </div>
                            <DataTable rowKey={u => u.SamAccountName} rows={[...batch.change, ...batch.unchanged, ...batch.protected]} columns={[
                                { key: 'SamAccountName', label: 'Account' },
                                { key: 'Name', label: 'Name' },
                                { key: 'will', label: '', render: u => (batch.change.includes(u) ? <Pill tone="info">{BATCH_ACTIONS[batch.action].label}</Pill> : u.Protected ? <Pill tone="warning">Protected</Pill> : <Pill>No change</Pill>) },
                            ]} />
                        </>
                    )}
                </Modal>
            )}
        </div>
    );
}

