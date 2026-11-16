import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shareUnchanged, isSideMounted, occupiedUs, rackUsage, usageLevel, freeRanges, rangeUs, capacitySummary, findFreeSpace, typeFilterKey,
  stepIndex,
} from './rackUtils.js';

const dev = (id, startU, sizeU, type = 'Server') => ({ id, startU, sizeU, type });

test('shareUnchanged keeps the objects of unchanged racks', () => {
  const a = { id: 'a', devices: [dev('d1', 1, 2)] };
  const b = { id: 'b', devices: [] };
  const next = JSON.parse(JSON.stringify([a, b]));
  next[1].devices.push(dev('d2', 3, 1));
  const { racks, changed } = shareUnchanged([a, b], next);
  assert.equal(racks[0], a);
  assert.notEqual(racks[1], b);
  assert.deepEqual(changed.map(r => r.id), ['b']);
});

test('shareUnchanged treats new racks as changed and handles empty input', () => {
  const { racks, changed } = shareUnchanged([], [{ id: 'n' }]);
  assert.equal(racks.length, 1);
  assert.equal(changed.length, 1);
  assert.deepEqual(shareUnchanged(undefined, undefined), { racks: [], changed: [] });
});

test('occupiedUs and rackUsage count distinct U inside the rack', () => {
  const rack = { height: 10, devices: [dev('a', 1, 2), dev('b', 2, 2), dev('c', 10, 3)] };
  assert.deepEqual([...occupiedUs(rack)].sort((x, y) => x - y), [1, 2, 3, 10, 11, 12]);
  assert.deepEqual(rackUsage(rack), { total: 10, used: 4, free: 6, pct: 40 });
  assert.deepEqual(rackUsage({ height: 0 }), { total: 0, used: 0, free: 0, pct: 0 });
  assert.deepEqual(rackUsage({ height: 4, devices: [dev('x', '1', '2')] }), { total: 4, used: 2, free: 2, pct: 50 });
});

test('side-mounted (vertical) PowerBars take no U', () => {
  const pdu = { id: 'p', type: 'PowerBar', orientation: 'vertical', startU: 1, sizeU: 10 };
  assert.equal(isSideMounted(pdu), true);
  assert.equal(isSideMounted({ ...pdu, orientation: 'horizontal' }), false);
  const rack = { height: 10, devices: [pdu, dev('a', 1, 2)] };
  assert.deepEqual(rackUsage(rack), { total: 10, used: 2, free: 8, pct: 20 });
  assert.deepEqual(freeRanges(rack, 1), [{ from: 3, to: 10, length: 8 }]);
});

test('usageLevel thresholds', () => {
  assert.equal(usageLevel(0), 'ok');
  assert.equal(usageLevel(69), 'ok');
  assert.equal(usageLevel(70), 'warn');
  assert.equal(usageLevel(89), 'warn');
  assert.equal(usageLevel(90), 'full');
});

test('freeRanges finds contiguous gaps of at least the size', () => {
  const rack = { height: 10, devices: [dev('a', 3, 2), dev('b', 8, 1)] };
  assert.deepEqual(freeRanges(rack, 1), [
    { from: 1, to: 2, length: 2 }, { from: 5, to: 7, length: 3 }, { from: 9, to: 10, length: 2 },
  ]);
  assert.deepEqual(freeRanges(rack, 3), [{ from: 5, to: 7, length: 3 }]);
  assert.deepEqual(freeRanges(rack, 4), []);
  assert.deepEqual(freeRanges({ height: 3, devices: [] }, 0), [{ from: 1, to: 3, length: 3 }]);
});

test('freeRanges does not cross the split of a split rack', () => {
  const rack = { height: 10, isSplitDesign: true, lowerU: 5, devices: [] };
  assert.deepEqual(freeRanges(rack, 1), [{ from: 1, to: 5, length: 5 }, { from: 6, to: 10, length: 5 }]);
  assert.deepEqual(freeRanges(rack, 6), []);
});

test('rangeUs lists every U of the ranges', () => {
  assert.deepEqual([...rangeUs([{ from: 2, to: 3 }, { from: 7, to: 7 }])], [2, 3, 7]);
  assert.equal(rangeUs(null).size, 0);
});

test('capacitySummary counts front faces only', () => {
  const racks = [
    { id: 'f1', height: 10, devices: [dev('a', 1, 5)] },
    { id: 'b1', isBack: true, height: 10, devices: [dev('b', 1, 10)] },
    { id: 'f2', height: 10, devices: [] },
  ];
  assert.deepEqual(capacitySummary(racks), { racks: 2, total: 20, used: 5, free: 15, pct: 25 });
  assert.deepEqual(capacitySummary([]), { racks: 0, total: 0, used: 0, free: 0, pct: 0 });
});

test('findFreeSpace lists the tightest fits first, front faces only', () => {
  const racks = [
    { id: 'r1', name: 'B', height: 6, devices: [dev('a', 3, 1)] },   // free 1-2 (2), 4-6 (3)
    { id: 'r2', name: 'A', height: 4, devices: [dev('b', 1, 2)] },   // free 3-4 (2)
    { id: 'rb', name: 'A (Back)', isBack: true, height: 4, devices: [] },
  ];
  const found = findFreeSpace(racks, 2).map(f => `${f.rack.name}:${f.from}-${f.to}`);
  assert.deepEqual(found, ['A:3-4', 'B:1-2', 'B:4-6']);
  assert.deepEqual(findFreeSpace(racks, 4), []);
});

test('typeFilterKey lists the shown types, empty when all are shown', () => {
  assert.equal(typeFilterKey(new Set(), ['A', 'B']), '');
  assert.equal(typeFilterKey(new Set(['B']), ['A', 'B', 'C']), '|A|C|');
  assert.equal(typeFilterKey(['A', 'B'], ['A', 'B']), '||');
});

test('stepIndex wraps around', () => {
  assert.equal(stepIndex(-1, 0, 1), -1);
  assert.equal(stepIndex(-1, 3, 1), 0);
  assert.equal(stepIndex(-1, 3, -1), 2);
  assert.equal(stepIndex(2, 3, 1), 0);
  assert.equal(stepIndex(0, 3, -1), 2);
});
