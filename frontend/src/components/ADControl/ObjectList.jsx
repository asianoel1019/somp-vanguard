// A filterable, exportable list of groups or computers (no per-row actions).
import React, { useMemo, useState } from 'react';
import { FiDownload } from 'react-icons/fi';
import { filterRows, toCsv, downloadText } from './adModel';
import { fieldStyle } from './adStyle';
import { Btn, DataTable, Pager } from './Shared';

const PAGE_SIZE = 50;

/** columns: [{ key, label, render?(row), csv?(row) }]; the filter looks at every column's raw value */
export default function ObjectList({ rows, columns, exportName, empty = 'Nothing found.', rowKey = r => r.SamAccountName || r.Name }) {
    const [filter, setFilter] = useState('');
    const [page, setPage] = useState(1);
    const filtered = useMemo(() => filterRows(rows, filter, columns.map(c => c.key)), [rows, filter, columns]);
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const current = Math.min(page, pages);
    const exportCsv = () => downloadText(`${exportName}.csv`, toCsv(filtered, columns.map(c => ({ key: c.key, label: c.label, value: c.csv }))));
    return (
        <div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' }}>
                <input type="search" placeholder="Filter" value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }} style={{ ...fieldStyle, flex: '1 1 240px', maxWidth: '420px' }} />
                <Btn icon={<FiDownload />} label="Export CSV" onClick={exportCsv} disabled={filtered.length === 0} />
                <span style={{ marginLeft: 'auto', fontSize: '12.5px', color: 'var(--text-muted)' }}>{filtered.length}{filter ? ` of ${rows.length}` : ''} item(s)</span>
            </div>
            <DataTable columns={columns} rows={filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)} rowKey={rowKey} empty={rows.length ? 'Nothing matches the filter.' : empty} />
            <Pager page={current} pages={pages} onPage={setPage} />
        </div>
    );
}
