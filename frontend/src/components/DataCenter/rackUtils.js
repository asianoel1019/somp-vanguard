// Pure helpers of the Server Rack screen (no React): kept here so they can be unit tested.

/**
 * Keeps the object of every rack whose content did not change, so memoized racks (RackCard / RackBody) skip
 * re-rendering after a save. Returns `next` with unchanged racks replaced by their `prev` object, plus the racks that
 * changed (compared by JSON).
 */
export function shareUnchanged(prev, next) {
  const prevById = new Map((prev || []).map(r => [r.id, r]));
  const changed = [];
  const racks = (next || []).map(r => {
    const old = prevById.get(r.id);
    if (old && (old === r || JSON.stringify(old) === JSON.stringify(r))) return old;
    changed.push(r);
    return r;
  });
  return { racks, changed };
}

/** A vertical (side-mounted) PowerBar takes no U (same rule as the server, backend/lib/rackLayout.js). */
export const isSideMounted = (device) => !!device && device.type === 'PowerBar' && device.orientation === 'vertical';

/** The set of U numbers taken by devices on this face (side-mounted PowerBars take none). */
export function occupiedUs(rack) {
  const out = new Set();
  for (const d of rack?.devices || []) {
    if (isSideMounted(d)) continue;
    const start = Number(d.startU) || 0;
    const size = Number(d.sizeU) || 0;
    for (let u = start; u < start + size; u++) out.add(u);
  }
  return out;
}

/** U usage of one face: total U, used U (distinct), free U and the used percentage (0-100, rounded). */
export function rackUsage(rack) {
  const total = Number(rack?.height) || 0;
  const taken = occupiedUs(rack);
  let used = 0;
  for (const u of taken) if (u >= 1 && u <= total) used++;
  const free = Math.max(0, total - used);
  return { total, used, free, pct: total ? Math.round((used / total) * 100) : 0 };
}

/** Usage level for colours: 'ok' below 70 %, 'warn' below 90 %, 'full' from 90 %. */
export const usageLevel = (pct) => (pct >= 90 ? 'full' : pct >= 70 ? 'warn' : 'ok');

/** Sections of a face as [from, to] U ranges: a split rack has a lower and an upper part a device cannot cross. */
function sections(rack) {
  const height = Number(rack?.height) || 0;
  const lowerU = Number(rack?.lowerU) || 0;
  if (rack?.isSplitDesign && lowerU > 0 && lowerU < height) return [[1, lowerU], [lowerU + 1, height]];
  return height > 0 ? [[1, height]] : [];
}

/**
 * Contiguous free ranges of at least `size` U on this face, as { from, to, length } (U numbers, from <= to).
 * Ranges never cross the split of a split rack, because a device cannot either.
 */
export function freeRanges(rack, size = 1) {
  const need = Math.max(1, Number(size) || 1);
  const taken = occupiedUs(rack);
  const out = [];
  for (const [lo, hi] of sections(rack)) {
    let start = null;
    for (let u = lo; u <= hi + 1; u++) {
      const free = u <= hi && !taken.has(u);
      if (free && start === null) start = u;
      if (!free && start !== null) {
        if (u - start >= need) out.push({ from: start, to: u - 1, length: u - start });
        start = null;
      }
    }
  }
  return out;
}

/** The U numbers covered by `ranges`, as a Set (for highlighting slots). */
export function rangeUs(ranges) {
  const out = new Set();
  for (const r of ranges || []) for (let u = r.from; u <= r.to; u++) out.add(u);
  return out;
}

/**
 * Totals over the front faces of a data center (back faces are the same cabinets): racks, total / used / free U and
 * the used percentage.
 */
export function capacitySummary(racks) {
  let total = 0;
  let used = 0;
  let count = 0;
  for (const r of racks || []) {
    if (r.isBack) continue;
    const u = rackUsage(r);
    total += u.total;
    used += u.used;
    count++;
  }
  return { racks: count, total, used, free: total - used, pct: total ? Math.round((used / total) * 100) : 0 };
}

/**
 * Where a device of `size` U fits, over the front faces: one entry per free range, { rack, from, to, length },
 * the tightest ranges first (they waste the least space), then by rack name and U.
 */
export function findFreeSpace(racks, size = 1) {
  const out = [];
  for (const rack of racks || []) {
    if (rack.isBack) continue;
    for (const r of freeRanges(rack, size)) out.push({ rack, ...r });
  }
  return out.sort((a, b) => a.length - b.length
    || String(a.rack.name || '').localeCompare(String(b.rack.name || ''))
    || a.from - b.from);
}

/** "|A|B|" text of the device types to show, '' when every type is shown (a stable string prop for memoized racks). */
export function typeFilterKey(hiddenTypes, allTypes) {
  const hidden = hiddenTypes instanceof Set ? hiddenTypes : new Set(hiddenTypes || []);
  if (hidden.size === 0) return '';
  const shown = allTypes.filter(t => !hidden.has(t));
  return `|${shown.join('|')}|`;
}

/** Next index when stepping through `count` search results (wraps around); -1 when there are none. */
export function stepIndex(current, count, delta) {
  if (!count) return -1;
  if (current < 0) return delta < 0 ? count - 1 : 0;
  return (((current + delta) % count) + count) % count;
}

/** sessionStorage key of a "Report HW issue" request from Server Rack, read by Hardware Issues. */
export const REPORT_REQUEST_KEY = 'dc_report_request';
