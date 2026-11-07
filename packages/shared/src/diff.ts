export interface DiffLine {
  kind: 'same' | 'add' | 'del';
  text: string;
  old?: number;
  new?: number;
}
type Op = { kind: 'same'; a: number; b: number } | { kind: 'add'; b: number } | { kind: 'del'; a: number };
// Beyond this many edits the trace gets large; the changed span is shown as removed then added instead.
const MAX_EDITS = 2000;
// Line numbers count from 1, and a final newline does not start another line.
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}
// Myers' O(ND) shortest edit script, keeping only the diagonals each step can reach.
function myers(a: string[], b: string[]): Op[] | undefined {
  const n = a.length, m = b.length, off = n + m + 1, v = new Int32Array(2 * (n + m) + 3), trace: Int32Array[] = [];
  search: for (let d = 0; d <= n + m; d++) {
    if (d > MAX_EDITS) return undefined;
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1, y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) break search;
    }
  }
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const w = trace[d], at = (k: number) => w[k + d], k = x - y;
    const prev = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1, px = at(prev), py = px - prev;
    while (x > px && y > py) ops.push({ kind: 'same', a: --x, b: --y });
    ops.push(x === px ? { kind: 'add', b: --y } : { kind: 'del', a: --x });
  }
  while (x > 0 && y > 0) ops.push({ kind: 'same', a: --x, b: --y });
  return ops.reverse();
}
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before), b = splitLines(after);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const ops = (midA.length && midB.length ? myers(midA, midB) : undefined) ??
    [...midA.map((_, i): Op => ({ kind: 'del', a: i })), ...midB.map((_, i): Op => ({ kind: 'add', b: i }))];
  const out: DiffLine[] = a.slice(0, start).map((text, i) => ({ kind: 'same', text, old: i + 1, new: i + 1 }));
  for (const op of ops)
    out.push(op.kind === 'add' ? { kind: 'add', text: midB[op.b], new: start + op.b + 1 }
      : op.kind === 'del' ? { kind: 'del', text: midA[op.a], old: start + op.a + 1 }
        : { kind: 'same', text: midA[op.a], old: start + op.a + 1, new: start + op.b + 1 });
  for (let i = endA; i < a.length; i++) out.push({ kind: 'same', text: a[i], old: i + 1, new: endB + (i - endA) + 1 });
  return out;
}
