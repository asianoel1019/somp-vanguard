import React, { useEffect, useRef, useState } from 'react';
import { TbArrowsVertical, TbFilter, TbLayoutGrid, TbServer2, TbX } from 'react-icons/tb';
import { DEVICE_TYPES, getSplitLocation } from './rackShared';
import { usageLevel } from './rackUtils';

const CATEGORIES = ['Compute', 'Network', 'Storage', 'Other'];
const FIT_SIZES = [1, 2, 3, 4, 5, 6, 8, 10];

// Closes a popover on a click outside `ref` or on Escape.
function useDismiss(open, setOpen, ref) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, setOpen, ref]);
}

/**
 * The bar under the Server Rack header: capacity of the data center, the free-space finder and the device type
 * filter. Props: summary (capacitySummary), simple (overview mode on), fitSize / onFitSize (0 = off), freeList
 * (findFreeSpace), onJump(entry), hiddenTypes (Set) / onHiddenTypes(Set).
 */
export default function RackToolbar({ summary, simple, fitSize, onFitSize, freeList, onJump, hiddenTypes, onHiddenTypes }) {
  const [fitOpen, setFitOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const fitRef = useRef(null);
  const typeRef = useRef(null);
  useDismiss(fitOpen, setFitOpen, fitRef);
  useDismiss(typeOpen, setTypeOpen, typeRef);

  const level = usageLevel(summary.pct);
  const toggleType = (id) => {
    const next = new Set(hiddenTypes);
    if (next.has(id)) next.delete(id); else next.add(id);
    onHiddenTypes(next);
  };
  const setCategory = (cat, show) => {
    const next = new Set(hiddenTypes);
    for (const t of DEVICE_TYPES) if (t.category === cat) { if (show) next.delete(t.id); else next.add(t.id); }
    onHiddenTypes(next);
  };
  const onlyCategory = (cat) => onHiddenTypes(new Set(DEVICE_TYPES.filter(t => t.category !== cat).map(t => t.id)));

  return (
    <div className="rack-toolbar">
      <div className="rack-cap" title="Front faces of this data center">
        <TbServer2 className="rack-cap-icon" />
        <span><b>{summary.racks}</b> racks</span>
        <span className="rack-cap-sep" />
        <span><b>{summary.used}</b> / {summary.total}U used</span>
        <span className={`rack-usage-bar is-${level}`} aria-hidden="true"><span style={{ width: `${summary.pct}%` }} /></span>
        <span className={`rack-cap-pct is-${level}`}>{summary.pct}%</span>
        <span className="rack-cap-sep" />
        <span><b>{summary.free}</b>U free</span>
      </div>

      <div className="rack-toolbar-actions">
        {simple && (
          <span className="rack-chip is-info" title="Zoom 50% or less: devices are drawn without ports and outlets">
            <TbLayoutGrid /> Overview
          </span>
        )}

        <div className="rack-pop-wrap" ref={fitRef}>
          <button
            type="button" className={`rack-tool-btn${fitSize ? ' is-active' : ''}`}
            onClick={() => { if (!fitSize) onFitSize(1); setFitOpen(o => !o); }}
          >
            <TbArrowsVertical /> {fitSize ? `Free space ≥ ${fitSize}U (${freeList.length})` : 'Find free space'}
          </button>
          {fitSize > 0 && (
            <button type="button" className="rack-tool-clear" title="Stop highlighting free space" onClick={() => { onFitSize(0); setFitOpen(false); }}>
              <TbX />
            </button>
          )}
          {fitOpen && (
            <div className="rack-pop rack-fit-pop glass-panel">
              <div className="rack-pop-title">Device height</div>
              <div className="rack-fit-sizes">
                {FIT_SIZES.map(n => (
                  <button key={n} type="button" className={`rack-size-btn${fitSize === n ? ' is-active' : ''}`} onClick={() => onFitSize(n)}>{n}U</button>
                ))}
              </div>
              <div className="rack-pop-title">
                {freeList.length ? `${freeList.length} places fit (tightest first) — click the green slots to add` : 'No rack has room for this height'}
              </div>
              <div className="rack-fit-list custom-scrollbar">
                {freeList.map(f => (
                  <button key={`${f.rack.id}-${f.from}`} type="button" className="rack-fit-item" onClick={() => onJump(f)}>
                    <span className="rack-fit-name">{f.rack.name || 'Rack'}</span>
                    <span className="rack-fit-loc">ROW {f.rack.rowNumber || 1} · {getSplitLocation(f.rack, f.from)}{f.to !== f.from ? ` – ${getSplitLocation(f.rack, f.to)}` : ''}</span>
                    <span className="rack-fit-len">{f.length}U</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="rack-pop-wrap" ref={typeRef}>
          <button type="button" className={`rack-tool-btn${hiddenTypes.size ? ' is-active' : ''}`} onClick={() => setTypeOpen(o => !o)}>
            <TbFilter /> {hiddenTypes.size ? `Types (${DEVICE_TYPES.length - hiddenTypes.size}/${DEVICE_TYPES.length})` : 'Device types'}
          </button>
          {hiddenTypes.size > 0 && (
            <button type="button" className="rack-tool-clear" title="Show all device types" onClick={() => onHiddenTypes(new Set())}>
              <TbX />
            </button>
          )}
          {typeOpen && (
            <div className="rack-pop rack-type-pop glass-panel">
              <div className="rack-pop-title">Other types are dimmed</div>
              {CATEGORIES.map(cat => {
                const types = DEVICE_TYPES.filter(t => t.category === cat);
                const allShown = types.every(t => !hiddenTypes.has(t.id));
                return (
                  <div key={cat} className="rack-type-group">
                    <div className="rack-type-head">
                      <label className="rack-check">
                        <input type="checkbox" checked={allShown} onChange={() => setCategory(cat, !allShown)} />
                        <span>{cat}</span>
                      </label>
                      <button type="button" className="rack-link-btn" onClick={() => onlyCategory(cat)}>only</button>
                    </div>
                    <div className="rack-type-items">
                      {types.map(t => (
                        <label key={t.id} className="rack-check">
                          <input type="checkbox" checked={!hiddenTypes.has(t.id)} onChange={() => toggleType(t.id)} />
                          <span>{t.icon} {t.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
              <button type="button" className="rack-link-btn" onClick={() => onHiddenTypes(new Set())}>Show all</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
