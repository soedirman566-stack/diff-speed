// solve.js — an exact, faster stand-in for makefun-diff 1.0.0.
//
// run(input) returns the reference patch string for { old, new }, byte for
// byte, by the published rule: lines are cut after every "\n" (a "\r" belongs
// to its line, a trailing line without "\n" is a line of its own), the common
// prefix and then the common suffix of the rest are kept, and between them a
// greedy Myers search runs from the first lines — on each diagonal it keeps
// the path reaching furthest into the old text, a deletion wins a tie against
// an insertion, no move passes either text's end, no edge diagonal is pruned,
// and every run of lines equal in both texts is followed to its end. The
// first path reaching both ends is the script; the patch groups its change
// runs into hunks with up to 3 kept lines of context, runs at most 6 kept
// lines apart sharing a hunk, deletions listed before insertions in a run,
// and a final line that has no newline is written with one plus a "%" line.
//
// Where it is faster than the reference: lines are interned to small integer
// ids once per case, so every equality test in the search is an integer
// compare; the search state lives in flat typed arrays (one slot per
// diagonal, component chains as index-linked records in growable arrays)
// instead of an object per path; and the patch is assembled from the split
// parts directly, with no per-line string rebuilt until it is printed.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;
const CONTEXT = 3;

/**
 * A text's lines as integer ids. `parts` is the text split on "\n": line i
 * is parts[i] plus a "\n" for every i before the last part; the last part is
 * a line of its own only when it is not empty, and it carries no "\n". Two
 * lines share an id exactly when they are the same code units, newline or
 * its absence included, so the id packs the part's number and the flag.
 */
function splitLines(text, table) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const n = parts[last] === '' ? last : last + 1;
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let p = table.get(parts[i]);
    if (p === undefined) {
      p = table.size;
      table.set(parts[i], p);
    }
    ids[i] = p * 2 + (i < last ? 0 : 1);
  }
  return { parts, n, ids };
}

// The edit components of one search, as index-linked records in flat arrays
// that double when full: kind, line count, and the previous component's
// index (-1 for none). A path is the index of its last component. The arrays
// are kept between cases and rewritten from index 0 by every search.
let nodeKind = new Uint8Array(1024);
let nodeCount = new Int32Array(1024);
let nodePrev = new Int32Array(1024);

/**
 * The greedy Myers search over the middle slices aIds[a0, a1) and
 * bIds[b0, b1): appends the script's runs to `kinds` and `counts` in order
 * and returns how many it appended. State per diagonal k is the furthest
 * old-lines-consumed x a path of the current edit count reaches there, plus
 * that path's head component; slots are reused across edit counts because
 * step d reads only the diagonals of step d - 1 (the opposite parity) and
 * writes its own, marking a diagonal with no live path as -1.
 */
function search(aIds, a0, a1, bIds, b0, b1, kinds, counts) {
  const aLen = a1 - a0;
  const bLen = b1 - b0;
  if (aLen === 0) {
    kinds.push(INSERT);
    counts.push(bLen);
    return 1;
  }
  if (bLen === 0) {
    kinds.push(DELETE);
    counts.push(aLen);
    return 1;
  }
  const maxEdit = aLen + bLen;
  const offset = maxEdit + 1;
  const diagX = new Int32Array(2 * maxEdit + 3).fill(-1);
  const diagHead = new Int32Array(2 * maxEdit + 3).fill(-1);
  // The component records, held in locals for the search's hot loop; the
  // module-level arrays are refreshed from them before finish() reads them.
  let nk = nodeKind;
  let nc = nodeCount;
  let np = nodePrev;
  let nl = 0;

  // d = 0: the opening run of equal lines, from the first lines of both.
  let x = 0;
  while (x < aLen && x < bLen && aIds[a0 + x] === bIds[b0 + x]) x++;
  let head = -1;
  if (x > 0) {
    nk[0] = KEEP;
    nc[0] = x;
    np[0] = -1;
    head = 0;
    nl = 1;
  }
  if (x >= aLen && x >= bLen) {
    nodeKind = nk;
    nodeCount = nc;
    nodePrev = np;
    return finish(head, kinds, counts);
  }
  diagX[offset] = x;
  diagHead[offset] = head;

  for (let d = 1; d <= maxEdit; d++) {
    for (let k = -d; k <= d; k += 2) {
      const at = offset + k;
      const xDel = diagX[at - 1]; // path on k - 1, extended by a deletion
      const xIns = diagX[at + 1]; // path on k + 1, extended by an insertion
      const canDel = xDel !== -1 && xDel < aLen;
      const canIns = xIns !== -1 && xIns - 1 - k < bLen;
      if (!canDel && !canIns) {
        diagX[at] = -1;
        diagHead[at] = -1;
        continue;
      }
      // The candidate reaching further into the old text wins; the deletion
      // (whose resulting old position is xDel) wins a tie against the
      // insertion (whose resulting old position is xIns - 1). Extending the
      // winner's head by one edit grows a run of the same kind in place of
      // appending a new one, exactly as the component chain prescribes.
      let kind;
      if (canDel && (!canIns || xDel >= xIns - 1)) {
        head = diagHead[at - 1];
        kind = DELETE;
        x = xDel + 1;
      } else {
        head = diagHead[at + 1];
        kind = INSERT;
        x = xIns;
      }
      if (nl === nk.length) {
        const nk2 = new Uint8Array(nl * 2);
        const nc2 = new Int32Array(nl * 2);
        const np2 = new Int32Array(nl * 2);
        nk2.set(nk);
        nc2.set(nc);
        np2.set(np);
        nk = nk2;
        nc = nc2;
        np = np2;
      }
      if (head !== -1 && nk[head] === kind) {
        nk[nl] = kind;
        nc[nl] = nc[head] + 1;
        np[nl] = np[head];
      } else {
        nk[nl] = kind;
        nc[nl] = 1;
        np[nl] = head;
      }
      head = nl++;
      // Follow every line equal in both texts as far as it goes.
      let y = x - k;
      const from = x;
      while (x < aLen && y < bLen && aIds[a0 + x] === bIds[b0 + y]) {
        x++;
        y++;
      }
      if (x > from) {
        if (nl === nk.length) {
          const nk2 = new Uint8Array(nl * 2);
          const nc2 = new Int32Array(nl * 2);
          const np2 = new Int32Array(nl * 2);
          nk2.set(nk);
          nc2.set(nc);
          np2.set(np);
          nk = nk2;
          nc = nc2;
          np = np2;
        }
        nk[nl] = KEEP;
        nc[nl] = x - from;
        np[nl] = head;
        head = nl++;
      }
      if (x >= aLen && y >= bLen) {
        nodeKind = nk;
        nodeCount = nc;
        nodePrev = np;
        return finish(head, kinds, counts);
      }
      diagX[at] = x;
      diagHead[at] = head;
    }
  }
  throw new Error('makefun-diff: the search ended without reaching both ends');
}

/** A finished path's components, oldest first, appended as runs. */
function finish(head, kinds, counts) {
  let added = 0;
  for (let c = head; c !== -1; c = nodePrev[c]) added++;
  const chain = new Int32Array(added);
  let i = added;
  for (let c = head; c !== -1; c = nodePrev[c]) chain[--i] = c;
  for (let j = 0; j < added; j++) {
    kinds.push(nodeKind[chain[j]]);
    counts.push(nodeCount[chain[j]]);
  }
  return added;
}

/** One patch line: its op, the line's text, and "%" when it had no newline. */
function written(op, parts, i) {
  return i < parts.length - 1 ? op + parts[i] + '\n' : op + parts[i] + '\n%\n';
}

/** makefun-diff 1.0.0's patch of input.old into input.new. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const table = new Map();
  const a = splitLines(input.old, table);
  const b = splitLines(input.new, table);
  const n = a.n;
  const m = b.n;

  // The common prefix of the lines, then the common suffix of what is left.
  let prefix = 0;
  const lim = n < m ? n : m;
  while (prefix < lim && a.ids[prefix] === b.ids[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a.ids[n - 1 - suffix] === b.ids[m - 1 - suffix]) suffix++;

  const kinds = [];
  const counts = [];
  if (prefix < n - suffix || prefix < m - suffix) {
    search(a.ids, prefix, n - suffix, b.ids, prefix, m - suffix, kinds, counts);
  }

  // The change runs: stretches of deletions and insertions between kept
  // lines, each at old line o and new line p, totals counted on the way.
  const changes = [];
  let o = prefix;
  let p = prefix;
  let deleted = 0;
  let inserted = 0;
  for (let r = 0; r < kinds.length; r++) {
    const kind = kinds[r];
    const count = counts[r];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a.parts, at));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a.parts, c.o + i));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b.parts, c.p + i));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a.parts, at));
  }
  return out.join('');
}
