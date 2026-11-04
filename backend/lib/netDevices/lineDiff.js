// Line diff for configuration backups (no dependency). Patience-style: lines that occur exactly once in both texts
// anchor the match (longest increasing run of them), the gaps between anchors are diffed recursively, and a gap small
// enough falls back to a plain LCS table. A gap too large for the table is shown as removed + added, never slow.
const MAX_LCS_CELLS = 2000000;

/** Edit script of two line arrays: [{ t: ' ' | '-' | '+', s }]. */
function diffLines(a, b) {
    const out = [];
    diffRange(a, 0, a.length, b, 0, b.length, out);
    return out;
}

function diffRange(a, a0, a1, b, b0, b1, out) {
    // common prefix / suffix
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { out.push({ t: ' ', s: a[a0] }); a0 += 1; b0 += 1; }
    const tail = [];
    while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) { tail.push({ t: ' ', s: a[a1 - 1] }); a1 -= 1; b1 -= 1; }

    if (a0 === a1 || b0 === b1) {
        for (let i = a0; i < a1; i += 1) out.push({ t: '-', s: a[i] });
        for (let j = b0; j < b1; j += 1) out.push({ t: '+', s: b[j] });
    } else {
        const anchors = uniqueAnchors(a, a0, a1, b, b0, b1);
        if (anchors.length) {
            let pa = a0;
            let pb = b0;
            for (const [i, j] of anchors) {
                diffRange(a, pa, i, b, pb, j, out);
                out.push({ t: ' ', s: a[i] });
                pa = i + 1;
                pb = j + 1;
            }
            diffRange(a, pa, a1, b, pb, b1, out);
        } else {
            lcs(a, a0, a1, b, b0, b1, out);
        }
    }
    for (let k = tail.length - 1; k >= 0; k -= 1) out.push(tail[k]);
}

/** Pairs [i, j] of lines unique in both ranges, longest run increasing in both. */
function uniqueAnchors(a, a0, a1, b, b0, b1) {
    const count = new Map(); // line -> [countA, countB, indexA, indexB]
    for (let i = a0; i < a1; i += 1) {
        const c = count.get(a[i]) || [0, 0, -1, -1];
        c[0] += 1; c[2] = i;
        count.set(a[i], c);
    }
    for (let j = b0; j < b1; j += 1) {
        const c = count.get(b[j]);
        if (c) { c[1] += 1; c[3] = j; }
    }
    const pairs = [];
    for (const c of count.values()) if (c[0] === 1 && c[1] === 1) pairs.push([c[2], c[3]]);
    if (!pairs.length) return [];
    pairs.sort((x, y) => x[0] - y[0]);
    // longest increasing subsequence on j (patience sorting)
    const tails = [];
    const prev = new Array(pairs.length);
    for (let k = 0; k < pairs.length; k += 1) {
        const j = pairs[k][1];
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[tails[mid]][1] < j) lo = mid + 1; else hi = mid; }
        prev[k] = lo > 0 ? tails[lo - 1] : -1;
        tails[lo] = k;
    }
    const seq = [];
    for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) seq.push(pairs[k]);
    return seq.reverse();
}

function lcs(a, a0, a1, b, b0, b1, out) {
    const n = a1 - a0;
    const m = b1 - b0;
    if (n * m > MAX_LCS_CELLS) {
        for (let i = a0; i < a1; i += 1) out.push({ t: '-', s: a[i] });
        for (let j = b0; j < b1; j += 1) out.push({ t: '+', s: b[j] });
        return;
    }
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            t[i * w + j] = a[a0 + i] === b[b0 + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[a0 + i] === b[b0 + j]) { out.push({ t: ' ', s: a[a0 + i] }); i += 1; j += 1; }
        else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { out.push({ t: '-', s: a[a0 + i] }); i += 1; }
        else { out.push({ t: '+', s: b[b0 + j] }); j += 1; }
    }
    for (; i < n; i += 1) out.push({ t: '-', s: a[a0 + i] });
    for (; j < m; j += 1) out.push({ t: '+', s: b[b0 + j] });
}

/**
 * Hunks of changed lines with `context` unchanged lines around them.
 * @returns {{ added: number, removed: number, hunks: Array<{ aStart, bStart, lines: Array<{ t, s }> }>, truncated: boolean }}
 */
function unifiedDiff(textA, textB, { context = 3, maxLines = 5000 } = {}) {
    const split = (t) => String(t || '').replace(/\r\n/g, '\n').split('\n');
    const ops = diffLines(split(textA), split(textB));
    let added = 0;
    let removed = 0;
    const lineA = [];
    const lineB = [];
    let ia = 1;
    let ib = 1;
    for (const o of ops) {
        lineA.push(ia); lineB.push(ib);
        if (o.t === '+') { added += 1; ib += 1; } else if (o.t === '-') { removed += 1; ia += 1; } else { ia += 1; ib += 1; }
    }
    const hunks = [];
    let shown = 0;
    let truncated = false;
    let k = 0;
    while (k < ops.length) {
        if (ops[k].t === ' ') { k += 1; continue; }
        const start = Math.max(0, k - context);
        let end = k;
        // extend while the next change is within 2 * context unchanged lines
        for (;;) {
            while (end < ops.length && ops[end].t !== ' ') end += 1;
            let next = end;
            while (next < ops.length && ops[next].t === ' ' && next - end < context * 2 + 1) next += 1;
            if (next < ops.length && ops[next].t !== ' ') { end = next; continue; }
            break;
        }
        const stop = Math.min(ops.length, end + context);
        const lines = ops.slice(start, stop);
        if (shown + lines.length > maxLines) { truncated = true; break; }
        shown += lines.length;
        hunks.push({ aStart: lineA[start], bStart: lineB[start], lines });
        k = stop;
    }
    return { added, removed, hunks, truncated };
}

module.exports = { diffLines, unifiedDiff };
