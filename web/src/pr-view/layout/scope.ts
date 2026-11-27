// One scope laid out by street routing (#163, "Highway by street routing"): the drawing's top
// level, or the inside of one frame (an open block or a box), whose ports are zero-size parts on
// its edges. layout.ts runs it once per scope and nests the answers.
//
// 1. Columns in the locked order (people, the changed group, the unchanged group, outside), each
//    group packed into as few columns as about 1.5 × √parts a column allows. Parts joined by a
//    line never share a column, and a line then pointing backwards is laid the other way round,
//    so every line runs left to right.
// 2. Rows: barycentre sweeps order each column, keeping the order with the fewest crossings.
// 3. Parts placed on their own: each column packed from the top and pulled toward what it
//    connects to by isotonic regression, so nothing overlaps; or, given the last answer, kept
//    where they were and pushed down only by what grew above them.
// 4. Every line routed as one cheapest path through the levels it can pass each column at:
//    length, 40 px a bend, ×0.85 on any stretch another line already uses. Long lines first,
//    then each again against the rest. Lines spanning fewer than 3 gutters are local: no
//    discount, and they avoid busy stretches.
// 5. Gaps widen only where routes pass, then everything is routed again.
// 6. Trunks: long lines on one level through a column ride one trunk there; verticals sharing a
//    gutter's stretch share a track, and each shared piece is a trunk.
// 7. Tracks: each gutter's verticals sit on tracks ordered to cross least; every gap between
//    columns also gets the count room.
//
// Coordinates are the scope's own, from (0, 0); routes are in laid direction (lower column to
// higher), with `flipped` naming the lines laid `to` → `from`.
import type { P } from "./types.ts";

/** Padding round a scope's contents (px); a frame's title sits between it and the first part. */
export const PAD = 24;
/** A group frame's (or a frame's) title strip above its first part. */
const FRAME_TOP = 44;
/** A group frame's padding round its parts. */
export const FRAME_PAD = 20;
/** Where each column's first part may start. */
export const TOP = PAD + FRAME_TOP;
/** Between two parts in a column, and between two ports. */
const GAP = 36;
const PORT_GAP = 12;
/** A level's clearance from a part. */
const CLEAR = 10;
/** Routed levels through a gap sit this far apart. */
const LEVEL = 12;
/** Levels closer than this are one. */
const LEVEL_MERGE = 12;
const BEND = 40;
const DISCOUNT = 0.85;
/** What a local line pays for a stretch another line uses. */
const BUSY = 1.5;
/** Lines spanning fewer gutters than this are local. */
const LOCAL_GUTTERS = 3;
/** Between two tracks in a gutter. */
const TRACK = 10;
const GUT_PAD = 14;
const GUT_MIN = 44;
/** Extra room where a gutter crosses from one group to the next (the top scope's). */
const CROSS_ROOM = 24;
/** Verticals shorter than this never share a track. */
const SHORT = 40;
/** Verticals that run together this far share a track. */
const STRETCH = 20;
/** Between two of a part's lines where they meet it. */
const SLOT = 12;
/** Horizontals closer than this would read as one. */
const NEAR = 4;
/** A track order that must hold, ahead of any that saves crossings. */
const MUST = 1e9;
/** An anchor's weight against a neighbour's pull: kept parts stay put. */
const KEEP = 1000;
/** A part's pull back to its packed place, against its neighbours'; a port's is light. */
const PULL = 1.5;
const PORT_PULL = 0.05;

/** A trunk's drawn width, from how many lines it carries. */
export const trunkWidth = (n: number) => Math.min(3 + 1.5 * n, 12);

/** 0 people, 1 the changed group (inside a frame: every part), 2 the unchanged group, 3 outside. */
export type Side = 0 | 1 | 2 | 3;

export interface SPart {
  id: string;
  side: Side;
  w: number;
  h: number;
  /** A port: a zero-size part on a frame's edge. */
  port: boolean;
  /** A frame's fixed ports: where each line of this scope meets its edge, as y from its top. */
  ports?: Map<string, number>;
}

export interface SLine {
  id: string;
  from: string;
  to: string;
}

export interface SOpts {
  /** A frame's inside: one group, its ports in a column on each edge, no group frames. */
  inside: boolean;
  /** Each part's y from the last answer. */
  keep?: Map<string, number>;
  countRoom: number;
}

export interface STrunk {
  lines: string[];
  pts: P[];
  width: number;
}

export interface SOut {
  /** Each part's top left. */
  at: Map<string, P>;
  routes: Map<string, P[]>;
  flipped: Set<string>;
  trunks: STrunk[];
  /** The changed and unchanged groups' frames (not inside a frame). */
  groups: { side: 1 | 2; x: number; y: number; w: number; h: number }[];
  width: number;
  height: number;
  /** Each part's place for the next answer: its anchor where it had one, else where it is. */
  anchors: Map<string, number>;
}

/**
 * Step 1 alone: each part's column. It depends only on the parts, their sides and the lines,
 * never on sizes, so the nesting's first pass decides each port's edge from it.
 */
export function columnsOf(parts: readonly SPart[], lines: readonly SLine[], inside: boolean) {
  const W = Math.ceil(1.5 * Math.sqrt(parts.length));
  const sideOf = new Map(parts.map((p) => [p.id, p.side]));
  const layer = new Map<string, number>();
  const sideCols = [0, 0, 0, 0];
  for (const side of [0, 1, 2, 3] as const) {
    const ids = parts.filter((p) => p.side === side).map((p) => p.id);
    if (ids.length === 0) continue;
    const intra = lines.filter((l) => l.from !== l.to && sideOf.get(l.from) === side && sideOf.get(l.to) === side);
    const joined = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const l of intra) (joined.get(l.from)!.push(l.to), joined.get(l.to)!.push(l.from));
    const count: number[] = [];
    const ok = (id: string, c: number, cap: number) => (count[c] ?? 0) < cap && !joined.get(id)!.some((j) => layer.get(j) === c);
    if (side === 0 || side === 3) {
      // People and outside systems fill columns in the order given; a part joined to one
      // already in a column goes to the next.
      const per = inside ? ids.length : Math.max(W, Math.ceil(ids.length / 2));
      for (const id of ids) {
        let c = 0;
        while (!ok(id, c, per)) c++;
        layer.set(id, c);
        count[c] = (count[c] ?? 0) + 1;
      }
    } else {
      // Reverse postorder: a topological order once the lines that close a cycle are turned round.
      const out = new Map<string, string[]>(ids.map((id) => [id, []]));
      for (const l of intra) out.get(l.from)!.push(l.to);
      const seen = new Set<string>();
      const post: string[] = [];
      const visit = (id: string) => {
        seen.add(id);
        for (const t of out.get(id)!) if (!seen.has(t)) visit(t);
        post.push(id);
      };
      for (const id of ids) if (!seen.has(id)) visit(id);
      const pos = new Map<string, number>();
      post.reverse().forEach((id, i) => pos.set(id, i));
      const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
      for (const l of intra) {
        const [a, b] = pos.get(l.from)! < pos.get(l.to)! ? [l.from, l.to] : [l.to, l.from];
        preds.get(b)!.push(a);
      }
      // As few columns as W parts each allows; a part goes in the column its lines want,
      // clamped, or the nearest with room and no part it's joined to.
      const K = Math.ceil(ids.length / W);
      for (const id of [...ids].sort((a, b) => pos.get(a)! - pos.get(b)!)) {
        let want = 0;
        for (const p of preds.get(id)!) want = Math.max(want, layer.get(p)! + 1);
        want = Math.min(want, K - 1);
        // Unbounded: past every used column there's an empty one.
        let best = -1;
        for (let d = 0; best < 0; d++) for (const c of [want - d, want + d]) if (best < 0 && c >= 0 && ok(id, c, W)) best = c;
        count[best] = (count[best] ?? 0) + 1;
        layer.set(id, best);
      }
    }
    // Close any empty columns.
    const used = [...new Set(ids.map((id) => layer.get(id)!))].sort((a, b) => a - b);
    const at = new Map(used.map((c, i) => [c, i]));
    for (const id of ids) layer.set(id, at.get(layer.get(id)!)!);
    sideCols[side] = used.length;
  }
  const offset = [0, sideCols[0]!, sideCols[0]! + sideCols[1]!, sideCols[0]! + sideCols[1]! + sideCols[2]!];
  const nCols = offset[3]! + sideCols[3]!;
  const colOf = new Map(parts.map((p) => [p.id, offset[p.side]! + layer.get(p.id)!]));
  const sideOfCol = (c: number): Side => (c < offset[1]! ? 0 : c < offset[2]! ? 1 : c < offset[3]! ? 2 : 3);
  return { colOf, nCols, offset, sideCols, sideOfCol };
}

interface Item {
  id: string;
  col: number;
  part?: SPart;
  ord: number;
  y: number;
  h: number;
  left: Map<Item, number>;
  right: Map<Item, number>;
}

interface Laid {
  id: string;
  a: string;
  b: string;
  ca: number;
  cb: number;
}

/** Weighted crossings between two columns' rows: pairs (a, b), (x, y) with (a - x)(b - y) < 0. */
function crossingsBetween(es: [number, number, number][], size: number): number {
  es.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const tree = new Float64Array(size + 1);
  let total = 0;
  let n = 0;
  for (let i = 0; i < es.length; ) {
    let j = i;
    while (j < es.length && es[j]![0] === es[i]![0]) j++;
    // Each edge crosses the earlier (smaller a) ones that end below it.
    for (let k = i; k < j; k++) {
      const [, b, w] = es[k]!;
      let upTo = 0;
      for (let x = b + 1; x > 0; x -= x & -x) upTo += tree[x]!;
      n += w * (total - upTo);
    }
    for (let k = i; k < j; k++) {
      const [, b, w] = es[k]!;
      for (let x = b + 1; x <= size; x += x & -x) tree[x] = tree[x]! + w;
      total += w;
    }
    i = j;
  }
  return n;
}

/** Weighted isotonic regression (pool adjacent violators): the non-decreasing fit closest to `t`. */
function isotonic(t: number[], w: number[]): number[] {
  const v: number[] = [], wt: number[] = [], n: number[] = [];
  for (let i = 0; i < t.length; i++) {
    v.push(t[i]!), wt.push(w[i]!), n.push(1);
    while (v.length > 1 && v[v.length - 2]! > v[v.length - 1]!) {
      const b = v.pop()!, bw = wt.pop()!, bn = n.pop()!;
      const a = v.pop()!, aw = wt.pop()!, an = n.pop()!;
      v.push((a * aw + b * bw) / (aw + bw)), wt.push(aw + bw), n.push(an + bn);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) for (let k = 0; k < n[i]!; k++) out.push(v[i]!);
  return out;
}

/**
 * Whether two coordinates differ: exactly, but for float noise, so every corner is drawn from
 * exact geometry and no stretch is ever slightly sloped (#144, rule 8).
 */
const apart = (a: number, b: number) => Math.abs(a - b) > 1e-6;

/** Drops repeated and collinear points. */
export function tidy(pts: P[]): P[] {
  const out: P[] = [];
  for (const p of pts) {
    const a = out[out.length - 1];
    if (a && !apart(a.x, p.x) && !apart(a.y, p.y)) continue;
    const b = out[out.length - 2];
    if (a && b && ((!apart(b.x, a.x) && !apart(a.x, p.x)) || (!apart(b.y, a.y) && !apart(a.y, p.y)))) out.pop();
    out.push(p);
  }
  return out;
}

export function layoutScope(parts: readonly SPart[], lines: readonly SLine[], o: SOpts): SOut {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const { colOf, nCols, offset, sideCols, sideOfCol } = columnsOf(parts, lines, o.inside);

  // Every line laid from the lower column to the higher.
  const flipped = new Set<string>();
  const laid: Laid[] = [];
  for (const l of lines) {
    if (l.from === l.to || !byId.has(l.from) || !byId.has(l.to)) continue;
    const flip = colOf.get(l.from)! > colOf.get(l.to)!;
    if (flip) flipped.add(l.id);
    const [a, b] = flip ? [l.to, l.from] : [l.from, l.to];
    laid.push({ id: l.id, a, b, ca: colOf.get(a)!, cb: colOf.get(b)! });
  }
  const span = (l: Laid) => l.cb - l.ca;

  // 2. Rows: the parts, plus a dummy per line per column it passes through, ordered by
  // barycentre sweeps.
  const cols: Item[][] = Array.from({ length: nCols }, () => []);
  const mk = (id: string, col: number, part?: SPart): Item => {
    const it: Item = { id, col, part, ord: 0, y: 0, h: part?.h ?? 0, left: new Map(), right: new Map() };
    cols[col]!.push(it);
    return it;
  };
  const partItem = new Map<string, Item>();
  for (const p of parts) partItem.set(p.id, mk(p.id, colOf.get(p.id)!, p));
  const chains = new Map<string, Item[]>();
  for (const l of laid) {
    const chain = [partItem.get(l.a)!];
    for (let c = l.ca + 1; c < l.cb; c++) chain.push(mk(`d:${l.id}:${c}`, c));
    chain.push(partItem.get(l.b)!);
    for (let i = 0; i + 1 < chain.length; i++) {
      const [p, q] = [chain[i]!, chain[i + 1]!];
      p.right.set(q, (p.right.get(q) ?? 0) + 1);
      q.left.set(p, (q.left.get(p) ?? 0) + 1);
    }
    chains.set(l.id, chain);
  }
  const renumber = () => cols.forEach((col) => col.forEach((it, i) => (it.ord = i)));
  const crossings = () => {
    let n = 0;
    for (let c = 0; c + 1 < nCols; c++) {
      const es: [number, number, number][] = [];
      for (const p of cols[c]!) for (const [q, w] of p.right) es.push([p.ord, q.ord, w]);
      n += crossingsBetween(es, cols[c + 1]!.length);
    }
    return n;
  };
  {
    renumber();
    const bary = (it: Item, side: Map<Item, number>) => {
      let s = 0, w = 0;
      for (const [q, k] of side) (s += q.ord * k), (w += k);
      return w ? s / w : it.ord;
    };
    const sweep = (c: number, side: (it: Item) => Map<Item, number>) => {
      const col = cols[c]!;
      const k = new Map(col.map((x) => [x, bary(x, side(x))]));
      col.sort((a, b) => k.get(a)! - k.get(b)! || a.ord - b.ord);
      col.forEach((x, i) => (x.ord = i));
    };
    let best = crossings();
    let snap = cols.map((col) => [...col]);
    for (let it = 0; it < 10 && best > 0; it++) {
      for (let c = 1; c < nCols; c++) sweep(c, (x) => x.left);
      for (let c = nCols - 2; c >= 0; c--) sweep(c, (x) => x.right);
      const n = crossings();
      if (n < best) (best = n), (snap = cols.map((col) => [...col]));
    }
    cols.splice(0, cols.length, ...snap);
    renumber();
  }

  // 3. Parts placed on their own; `extra[c][i]` widens the gap above column c's i-th part.
  const partCols = cols.map((col) => col.filter((it) => it.part));
  const nbrs = new Map<Item, Item[]>();
  for (const l of laid) {
    const [a, b] = [partItem.get(l.a)!, partItem.get(l.b)!];
    nbrs.set(a, [...(nbrs.get(a) ?? []), b]);
    nbrs.set(b, [...(nbrs.get(b) ?? []), a]);
  }
  const isPort = (it: Item) => it.part!.port;
  const gapOf = (a: Item, b: Item) => (isPort(a) && isPort(b) ? PORT_GAP : GAP);
  const mid = (it: Item) => it.y + it.h / 2;
  // A group with no part kept from the last answer has its top flush with the scope's (no empty
  // band): the groups, and inside a frame everything but the ports.
  const groupOf = (c: number) => (o.inside ? (sideOfCol(c) === 1 ? 1 : -1) : sideOfCol(c) === 1 || sideOfCol(c) === 2 ? sideOfCol(c) : -1);
  const placeParts = (extra: number[][]) => {
    const packed = new Map<Item, number>();
    partCols.forEach((col, c) => {
      let y = TOP;
      col.forEach((it, i) => {
        y += (i ? gapOf(col[i - 1]!, it) : 0) + (extra[c]![i] ?? 0);
        it.y = y;
        packed.set(it, y);
        y += it.h;
      });
    });
    const offs = partCols.map((col, c) => {
      const off: number[] = [];
      let acc = extra[c]![0] ?? 0;
      col.forEach((_, i) => {
        if (i) acc += col[i - 1]!.h + gapOf(col[i - 1]!, col[i]!) + (extra[c]![i] ?? 0);
        off.push(acc);
      });
      return off;
    });
    const kept = (it: Item) => o.keep?.get(it.id);
    for (let pass = 0; pass < 10; pass++)
      partCols.forEach((col, c) => {
        if (!col.length) return;
        const off = offs[c]!;
        if (col.every((it) => kept(it) !== undefined)) {
          // Where they were, exactly: order kept, and only what grew above a part pushes it down.
          col.forEach((it, i) => {
            const prev = col[i - 1];
            it.y = Math.max(kept(it)!, prev ? prev.y + prev.h + gapOf(prev, it) + (extra[c]![i] ?? 0) : TOP + off[0]!);
          });
          return;
        }
        const t: number[] = [], w: number[] = [];
        col.forEach((it, i) => {
          const k = kept(it);
          if (k !== undefined) return void (t.push(k - off[i]!), w.push(KEEP));
          const ns = nbrs.get(it) ?? [];
          const anchor = packed.get(it)!;
          let want = anchor;
          if (ns.length) {
            let s = 0;
            for (const q of ns) s += mid(q);
            want = s / ns.length - it.h / 2;
          }
          const pull = isPort(it) ? PORT_PULL : PULL;
          t.push((want * ns.length + anchor * pull) / (ns.length + pull) - off[i]!);
          w.push(ns.length + pull);
        });
        const z = isotonic(t, w);
        col.forEach((it, i) => (it.y = Math.max(TOP, z[i]!) + off[i]!));
      });
    const groups = new Map<number, number>();
    partCols.forEach((col, c) => {
      const g = groupOf(c);
      if (g < 0 || !col.length) return;
      const free = col[0]!.y - TOP - (extra[c]![0] ?? 0);
      groups.set(g, Math.min(groups.get(g) ?? Infinity, col.some((it) => kept(it) !== undefined) ? 0 : free));
    });
    partCols.forEach((col, c) => {
      const lift = groups.get(groupOf(c)) ?? 0;
      if (lift > 0.01) for (const it of col) it.y -= lift;
    });
  };

  // 4–5. Street routing, and the gaps widened where routes pass.
  const endY = (it: Item, key: string) => {
    const p = it.part?.ports?.get(key);
    return p === undefined ? mid(it) : it.y + p;
  };
  const colWidth = cols.map((col) => Math.max(0, ...col.map((it) => it.part?.w ?? 0)));
  let extra: number[][] = cols.map(() => []);
  let Y: number[] = [];
  let hUse: Int32Array[] = [];
  let paths = new Map<string, { lv: number[]; long: boolean }>();
  for (let grow = 0; grow < 8; grow++) {
    placeParts(extra);
    const raw: number[] = [];
    for (const col of partCols) {
      const ns = [...col].sort((a, b) => a.y - b.y);
      ns.forEach((n, i) => {
        raw.push(mid(n));
        const nx = ns[i + 1];
        if (nx) raw.push((n.y + n.h + nx.y) / 2);
      });
      if (ns.length) raw.push(ns[0]!.y - 24, ns[ns.length - 1]!.y + ns[ns.length - 1]!.h + 24);
    }
    raw.sort((a, b) => a - b);
    Y = [];
    for (const y of raw) if (!Y.length || y - Y[Y.length - 1]! > LEVEL_MERGE - 1e-6) Y.push(y);
    const L = Y.length;
    const free: Uint8Array[] = partCols.map((col) => {
      const f = new Uint8Array(L).fill(1);
      for (const it of col) for (let j = 0; j < L; j++) if (Y[j]! > it.y - CLEAR && Y[j]! < it.y + it.h + CLEAR) f[j] = 0;
      return f;
    });
    // Per column, per level, how many lines ride it; per gutter, per level step, how many.
    hUse = cols.map(() => new Int32Array(L));
    const hLocal = cols.map(() => new Int32Array(L));
    const vUse: Int32Array[] = cols.map(() => new Int32Array(L));
    /** Bumped whenever a stretch of the gutter goes from unused to used or back. */
    const version = new Int32Array(nCols);
    const levelOf = (y: number) => {
      let lo = 0, hi = L - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (Y[m]! < y) lo = m + 1;
        else hi = m;
      }
      return lo;
    };
    const ysOf = (l: Laid, lv: number[]) => [endY(partItem.get(l.a)!, l.id), ...lv.map((j) => Y[j]!), endY(partItem.get(l.b)!, l.id)];
    paths = new Map();
    const mark = (l: Laid, lv: number[], sign: number) => {
      for (let i = 0; i < lv.length; i++) hUse[l.ca + 1 + i]![lv[i]!]! += sign;
      if (span(l) < LOCAL_GUTTERS) for (let i = 0; i < lv.length; i++) hLocal[l.ca + 1 + i]![lv[i]!]! += sign;
      const ys = ysOf(l, lv);
      for (let i = 0; i + 1 < ys.length; i++) {
        const g = l.ca + i;
        const a = levelOf(Math.min(ys[i]!, ys[i + 1]!)), b = levelOf(Math.max(ys[i]!, ys[i + 1]!));
        const use = vUse[g]!;
        for (let j = a; j < b; j++) {
          const was = use[j]! > 0;
          use[j]! += sign;
          if (was !== use[j]! > 0) version[g]!++;
        }
      }
    };
    // A gutter's running cost up its levels, for a long line or a local one: kept until a route
    // starts or stops using one of its stretches.
    const cached = Array.from({ length: 2 * nCols }, () => new Float64Array(L));
    const cachedAt = new Int32Array(2 * nCols).fill(-1);
    let P = cached[0]!;
    const pre = (g: number, long: boolean) => {
      const k = 2 * g + (long ? 1 : 0);
      P = cached[k]!;
      if (cachedAt[k] === version[g]) return;
      cachedAt[k] = version[g]!;
      const use = vUse[g]!;
      P[0] = 0;
      for (let j = 0; j + 1 < L; j++) {
        const seg = Y[j + 1]! - Y[j]!;
        P[j + 1] = P[j]! + (use[j]! > 0 ? seg * (long ? DISCOUNT : BUSY) : seg);
      }
    };
    // From a part's port at y (off the level grid, whose next level up is `at`) to level j: the
    // stretch along the grid, the bit off it at full length, and the two bends.
    const toLevel = (y: number, at: number, j: number) => (Math.abs(y - Y[j]!) < 0.5 ? 0 : Math.abs(P[j]! - P[at]!) + Math.abs(Y[at]! - y) + 2 * BEND);
    let dp = new Float64Array(L);
    let next = new Float64Array(L);
    const loV = new Float64Array(L), hiV = new Float64Array(L);
    const loI = new Int32Array(L), hiI = new Int32Array(L);
    let back = new Int32Array(0);
    const route = (l: Laid, long: boolean, strict = true): number[] | null => {
      const n = l.cb - l.ca - 1;
      if (n <= 0) return [];
      const ya = endY(partItem.get(l.a)!, l.id), yb = endY(partItem.get(l.b)!, l.id);
      const busy = long ? DISCOUNT : BUSY;
      if (back.length < n * L) back = new Int32Array(n * L);
      pre(l.ca, long);
      {
        const c = l.ca + 1, f = free[c]!, use = hUse[c]!, loc = hLocal[c]!, w = colWidth[c]!, at = levelOf(ya);
        for (let j = 0; j < L; j++) dp[j] = f[j] && !(strict && (long ? loc[j] : use[j])) ? toLevel(ya, at, j) + w * (use[j] ? busy : 1) : Infinity;
      }
      for (let k = 1; k < n; k++) {
        const g = l.ca + k, c = g + 1, f = free[c]!, use = hUse[c]!, loc = hLocal[c]!, w = colWidth[c]!;
        pre(g, long);
        // The cheapest level to come from, in O(L): from below j costs dp[i] - P[i] + P[j],
        // from above dp[i] + P[i] - P[j] (P is a running sum), so a running minimum from each
        // end gives both. Ties go to the lowest i.
        for (let j = 0, m = Infinity, mi = -1; j < L; j++) {
          loV[j] = m;
          loI[j] = mi;
          const d = dp[j]!;
          if (d < Infinity && d - P[j]! < m) (m = d - P[j]!), (mi = j);
        }
        for (let j = L - 1, m = Infinity, mi = -1; j >= 0; j--) {
          hiV[j] = m;
          hiI[j] = mi;
          const d = dp[j]!;
          if (d < Infinity && d + P[j]! <= m) (m = d + P[j]!), (mi = j);
        }
        const row = k * L;
        for (let j = 0; j < L; j++) {
          if (!f[j] || (strict && (long ? loc[j] : use[j]))) {
            next[j] = Infinity;
            back[row + j] = -1;
            continue;
          }
          let best = Infinity, arg = -1;
          if (loI[j]! >= 0) (best = loV[j]! + P[j]! + 2 * BEND), (arg = loI[j]!);
          if (dp[j]! < best) (best = dp[j]!), (arg = j);
          if (hiI[j]! >= 0 && hiV[j]! - P[j]! + 2 * BEND < best) (best = hiV[j]! - P[j]! + 2 * BEND), (arg = hiI[j]!);
          next[j] = best + w * (use[j] ? busy : 1);
          back[row + j] = arg;
        }
        [dp, next] = [next, dp];
      }
      pre(l.cb - 1, long);
      const at = levelOf(yb);
      let best = Infinity, arg = -1;
      for (let j = 0; j < L; j++) {
        if (dp[j]! === Infinity) continue;
        const v = dp[j]! + toLevel(yb, at, j);
        if (v < best) (best = v), (arg = j);
      }
      if (arg < 0) return null;
      const lv = new Array<number>(n);
      for (let k = n - 1, j = arg; k >= 0; k--) (lv[k] = j), (j = back[k * L + j]!);
      return lv;
    };
    const longFirst = [...laid].sort((a, b) => span(b) - span(a));
    for (let pass = 0; pass < 3; pass++)
      for (const l of longFirst) {
        const long = span(l) >= LOCAL_GUTTERS;
        const old = paths.get(l.id);
        if (old) mark(l, old.lv, -1);
        const lv = route(l, long) ?? route(l, long, false);
        if (!lv) continue;
        paths.set(l.id, { lv, long });
        mark(l, lv, +1);
      }
    // Widen each gap to fit the levels routed through it, LEVEL apart and clear of the parts.
    let grew = false;
    const widened = partCols.map((col, c) => {
      const used: number[] = [];
      hUse[c]!.forEach((n, j) => n > 0 && used.push(Y[j]!));
      return col.map((it, i) => {
        const top = i ? col[i - 1]!.y + col[i - 1]!.h : TOP - 24;
        const n = used.filter((y) => y > top && y < it.y).length;
        const need = n ? n * LEVEL + 2 * CLEAR : 0;
        const was = extra[c]![i] ?? 0;
        const add = Math.max(was, need - (it.y - top) + was);
        if (add > was + 1) grew = true;
        return add;
      });
    });
    if (!grew) break;
    extra = widened;
  }

  // 6. Trunks along columns: long lines sharing a level in a column ride one trunk there; runs
  // of columns with the same riders on the same level are one trunk.
  const riders: Map<number, string[]>[] = cols.map(() => new Map());
  for (const l of laid) {
    const p = paths.get(l.id);
    if (!p) continue;
    p.lv.forEach((j, i) => {
      const m = riders[l.ca + 1 + i]!;
      const ids = m.get(j);
      if (ids) ids.push(l.id);
      else m.set(j, [l.id]);
    });
  }
  const per: { c: number; j: number; members: string[] }[] = [];
  riders.forEach((m, c) => m.forEach((ids, j) => ids.length > 1 && per.push({ c, j, members: ids.sort() })));
  per.sort((a, b) => a.j - b.j || a.c - b.c);
  const clusters: { members: string[]; from: number; to: number; j: number }[] = [];
  for (const p of per) {
    const last = clusters[clusters.length - 1];
    if (last && last.to === p.c - 1 && last.j === p.j && last.members.join() === p.members.join()) last.to = p.c;
    else clusters.push({ members: p.members, from: p.c, to: p.c, j: p.j });
  }
  // Each line's cluster in each column it rides one.
  const trunkAt = new Map<string, Map<number, number>>();
  clusters.forEach((cl, k) =>
    cl.members.forEach((m) => {
      let at = trunkAt.get(m);
      if (!at) trunkAt.set(m, (at = new Map()));
      for (let c = cl.from; c <= cl.to; c++) at.set(c, k);
    }),
  );

  // Each line's chain of stops: its parts, and between them its level in each column (its own,
  // or its trunk's).
  interface Stop {
    col: number;
    part?: Item;
    trunk?: number;
    y: number;
  }
  const stops = new Map<string, Stop[]>();
  for (const l of laid) {
    const p = paths.get(l.id);
    const a = partItem.get(l.a)!, b = partItem.get(l.b)!;
    const s: Stop[] = [{ col: l.ca, part: a, y: mid(a) }];
    const at = trunkAt.get(l.id);
    (p?.lv ?? []).forEach((j, i) => s.push({ col: l.ca + 1 + i, trunk: at?.get(l.ca + 1 + i), y: Y[j]! }));
    // A line no level could carry runs straight to its part (it never happens on a free column).
    if (!p) for (let c = l.ca + 1; c < l.cb; c++) s.push({ col: c, y: mid(a) });
    s.push({ col: l.cb, part: b, y: mid(b) });
    stops.set(l.id, s);
  }

  // Ports: a part's lines leave (and arrive) spread down its side, ordered by the other end; a
  // port's all meet at its point, and a frame's at its fixed ports.
  // Each line's y where it leaves its first part (its right side) and meets its last (left).
  const portR = new Map<string, number>();
  const portL = new Map<string, number>();
  {
    const outs = new Map<Item, { key: string; toward: number }[]>();
    const ins = new Map<Item, { key: string; toward: number }[]>();
    const add = (m: Map<Item, { key: string; toward: number }[]>, it: Item, e: { key: string; toward: number }) => {
      const es = m.get(it);
      if (es) es.push(e);
      else m.set(it, [e]);
    };
    for (const [key, s] of stops) {
      const [first, second, last, before] = [s[0]!, s[1]!, s[s.length - 1]!, s[s.length - 2]!];
      add(outs, first.part!, { key, toward: second.y });
      add(ins, last.part!, { key, toward: before.y });
    }
    const spread = (it: Item, keys: { key: string; toward: number }[], into: Map<string, number>) => {
      keys.sort((a, b) => a.toward - b.toward || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const fixed: number[] = [];
      const free: typeof keys = [];
      for (const k of keys) {
        const f = it.part!.ports?.get(k.key);
        if (f === undefined) free.push(k);
        else into.set(k.key, it.y + f), fixed.push(it.y + f);
      }
      if (isPort(it)) return free.forEach((k) => into.set(k.key, mid(it)));
      const n = free.length;
      if (!fixed.length) {
        const step = n > 1 ? Math.min(12, (it.h - 16) / (n - 1)) : 0;
        return free.forEach((k, i) => into.set(k.key, mid(it) + (i - (n - 1) / 2) * step));
      }
      // A frame's other lines take slots round its middle, clear of its fixed ports.
      const slots: number[] = [];
      const [lo, hi] = [it.y + 8, it.y + it.h - 8];
      for (let d = 0; slots.length < n && (mid(it) - d * SLOT >= lo || mid(it) + d * SLOT <= hi); d++)
        for (const y of d ? [mid(it) - d * SLOT, mid(it) + d * SLOT] : [mid(it)])
          if (slots.length < n && y >= lo && y <= hi && fixed.every((f) => Math.abs(f - y) >= SLOT / 2)) slots.push(y);
      slots.sort((a, b) => a - b);
      free.forEach((k, i) => into.set(k.key, slots[i] ?? mid(it)));
    };
    for (const [it, ks] of outs) spread(it, ks, portR);
    for (const [it, ks] of ins) spread(it, ks, portL);
  }

  // 7. Each gutter: one vertical per line (one per trunk), on tracks ordered to cross least.
  interface Seg {
    keys: string[];
    y1: number;
    y2: number;
    thick: number;
    track: number;
    x: number;
    /** The port it leaves (on the gutter's left) or meets (right): a port's lines share a track. */
    port?: Item;
  }
  const gutters: Seg[][] = Array.from({ length: Math.max(0, nCols - 1) }, () => []);
  // Per gutter, each line's vertical there, and each trunk's.
  const segOf: Map<string, Seg>[] = gutters.map(() => new Map());
  const trunkSeg: Map<number, Seg>[] = gutters.map(() => new Map());
  for (const [key, s] of stops) {
    for (let i = 0; i + 1 < s.length; i++) {
      const [p, q] = [s[i]!, s[i + 1]!];
      const g = p.col;
      const shared = p.trunk !== undefined && p.trunk === q.trunk;
      let seg = shared ? trunkSeg[g]!.get(p.trunk!) : undefined;
      if (!seg) {
        const y1 = p.part ? portR.get(key)! : p.y;
        const y2 = q.part ? portL.get(key)! : q.y;
        const port = p.part && isPort(p.part) ? p.part : q.part && isPort(q.part) ? q.part : undefined;
        seg = { keys: [], y1, y2, thick: shared ? trunkWidth(clusters[p.trunk!]!.members.length) : 1.5, track: -1, x: 0, port };
        if (shared) trunkSeg[g]!.set(p.trunk!, seg);
        gutters[g]!.push(seg);
      }
      seg.keys.push(key);
      segOf[g]!.set(key, seg);
    }
  }
  interface V {
    segs: Seg[];
    ins: number[];
    outs: number[];
    lo: number;
    hi: number;
    thick: number;
    track: number;
  }
  const vunits: V[][] = [];
  const trackW: number[][] = [];
  const overlap = (a: { lo: number; hi: number }, b: { lo: number; hi: number }) => Math.max(0, Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo));
  gutters.forEach((segs, g) => {
    const bends = segs.filter((x) => apart(x.y1, x.y2));
    // Longest first; each shares the track of the first group it runs along far enough.
    const span1 = (x: Seg) => ({ lo: Math.min(x.y1, x.y2), hi: Math.max(x.y1, x.y2) });
    const groups: { segs: Seg[]; all: { lo: number; hi: number } }[] = [];
    for (const x of [...bends].sort((p, q) => span1(q).hi - span1(q).lo - (span1(p).hi - span1(p).lo))) {
      const r = span1(x);
      const gr = r.hi - r.lo >= SHORT ? groups.find((gr) => overlap(r, gr.all) >= STRETCH) : undefined;
      if (gr) gr.segs.push(x), (gr.all = { lo: Math.min(gr.all.lo, r.lo), hi: Math.max(gr.all.hi, r.hi) });
      else groups.push({ segs: [x], all: r });
    }
    const unitOf = (ss: Seg[]): V => {
      const ys = ss.flatMap((x) => [x.y1, x.y2]);
      const keys = ss.reduce((n, x) => n + x.keys.length, 0);
      return {
        segs: ss,
        ins: ss.map((x) => x.y1),
        outs: ss.map((x) => x.y2),
        lo: Math.min(...ys),
        hi: Math.max(...ys),
        thick: ss.length > 1 ? Math.max(trunkWidth(keys), ...ss.map((x) => x.thick)) : ss[0]!.thick,
        track: 0,
      };
    };
    const inside = (y: number, v: V) => y > v.lo + 0.5 && y < v.hi - 0.5;
    // a left of b crosses where b's lines come in across a's vertical, or a's go out across b's.
    const cost = (a: V, b: V) => b.ins.filter((y) => inside(y, a)).length + a.outs.filter((y) => inside(y, b)).length;
    // A line leaving left at the level another leaves right at would run on top of it between
    // their tracks unless the one going left sits left.
    const must = (a: V, b: V) => a.ins.some((y) => b.outs.some((z) => Math.abs(y - z) < NEAR));
    const clash = (a: V, b: V) => !(a.hi + 5 <= b.lo - 5 || b.hi + 5 <= a.lo - 5);
    const units: V[] = groups.map(({ segs: ss }) => unitOf(ss));
    // Two that must each sit left of the other share a track: their stubs then only meet.
    for (let merged = true; merged; ) {
      merged = false;
      for (let i = 0; i < units.length && !merged; i++)
        for (let j = i + 1; j < units.length && !merged; j++) {
          const [a, b] = [units[i]!, units[j]!];
          if (clash(a, b) && must(a, b) && must(b, a)) (units[i] = unitOf([...a.segs, ...b.segs])), units.splice(j, 1), (merged = true);
        }
    }
    vunits[g] = units;
    const index = new Map(units.map((v, i) => [v, i]));
    const prefs: { a: number; b: number; gain: number }[] = [];
    for (let i = 0; i < units.length; i++)
      for (let j = i + 1; j < units.length; j++) {
        const [a, b] = [units[i]!, units[j]!];
        if (!clash(a, b)) continue;
        const mab = must(a, b), mba = must(b, a);
        if (mab !== mba) {
          prefs.push(mab ? { a: i, b: j, gain: MUST } : { a: j, b: i, gain: MUST });
          continue;
        }
        const ab = cost(a, b), ba = cost(b, a);
        // Ties: lines going down nest outside-in, so the longer drop sits further out.
        const down = a.outs[0]! - a.ins[0]! >= 0;
        const tie = down ? (a.ins[0]! < b.ins[0]! ? 1 : -1) : a.ins[0]! > b.ins[0]! ? 1 : -1;
        prefs.push(ab < ba || (ab === ba && tie > 0) ? { a: i, b: j, gain: Math.abs(ab - ba) } : { a: j, b: i, gain: Math.abs(ab - ba) });
      }
    // Keep the strongest preferences that leave no cycle (reachability kept as bitsets), then a
    // track is a longest path.
    prefs.sort((x, y) => y.gain - x.gain);
    const n = units.length, words = (n + 31) >>> 5;
    const reach = Array.from({ length: n }, (_, i) => {
      const r = new Uint32Array(words);
      r[i >>> 5] = 1 << (i & 31);
      return r;
    });
    const has = (r: Uint32Array, i: number) => (r[i >>> 5]! >>> (i & 31)) & 1;
    const after: number[][] = units.map(() => []);
    for (const p of prefs) {
      // b already reaching a would close a cycle; a already reaching b changes no track.
      if (has(reach[p.b]!, p.a) || has(reach[p.a]!, p.b)) continue;
      after[p.a]!.push(p.b);
      const rb = reach[p.b]!;
      for (let u = 0; u < n; u++) {
        const ru = reach[u]!;
        if (!has(ru, p.a)) continue;
        for (let w = 0; w < words; w++) ru[w] = ru[w]! | rb[w]!;
      }
    }
    const indeg = new Int32Array(n);
    for (const vs of after) for (const v of vs) indeg[v]!++;
    const queue: number[] = [];
    for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi]!;
      for (const t of after[v]!) {
        units[t]!.track = Math.max(units[t]!.track, units[v]!.track + 1);
        if (--indeg[t]! === 0) queue.push(t);
      }
    }
    // Two units on one track must not overlap: push the later one right.
    const byTrack = [...units].sort((a, b) => a.track - b.track || index.get(a)! - index.get(b)!);
    for (let i = 0; i < byTrack.length; i++)
      for (let j = 0; j < i; j++) {
        const [a, b] = [byTrack[j]!, byTrack[i]!];
        if (a.track === b.track && clash(a, b)) b.track++;
      }
    for (const v of units) for (const x of v.segs) x.track = v.track;
    const tracks = units.length ? Math.max(...units.map((v) => v.track)) + 1 : 0;
    const tw = new Array<number>(tracks).fill(1.5);
    for (const v of units) tw[v.track] = Math.max(tw[v.track]!, v.thick);
    trackW[g] = tw;
  });

  // X: columns left to right; a gutter as wide as its tracks, the count room and the frames'
  // padding.
  const colX: number[] = [];
  const framed = (c: number) => !o.inside && (sideOfCol(c) === 1 || sideOfCol(c) === 2);
  let x = PAD;
  for (let c = 0; c < nCols; c++) {
    colX[c] = x;
    x += colWidth[c]!;
    if (c + 1 === nCols) break;
    const crossing = !o.inside && sideOfCol(c) !== sideOfCol(c + 1);
    const padL = crossing && framed(c) ? FRAME_PAD : 0;
    const padR = crossing && framed(c + 1) ? FRAME_PAD : 0;
    const tw = trackW[c]!;
    const inner = tw.reduce((s, w) => s + w, 0) + Math.max(0, tw.length - 1) * TRACK;
    const room = o.countRoom;
    const width = Math.max(GUT_MIN, inner + 2 * GUT_PAD) + (crossing ? CROSS_ROOM : 0) + room;
    // The tracks sit in the middle of the gutter, between the frames, after the count room.
    let tx = x + padL + room + (width - room - inner) / 2;
    const xs = tw.map((w) => {
      const at = tx + w / 2;
      tx += w + TRACK;
      return at;
    });
    for (const s of gutters[c]!) s.x = s.track >= 0 && apart(s.y1, s.y2) ? xs[s.track]! : 0;
    x += padL + width + padR;
  }

  // Routes, trunks, group frames.
  const at = new Map<string, P>();
  for (const it of partItem.values()) at.set(it.id, { x: colX[it.col]!, y: it.y });
  const routes = new Map<string, P[]>();
  for (const [key, s] of stops) {
    const pts: P[] = [];
    for (let i = 0; i + 1 < s.length; i++) {
      const [p, q] = [s[i]!, s[i + 1]!];
      const seg = segOf[p.col]!.get(key)!;
      if (i === 0) pts.push({ x: colX[p.col]! + p.part!.part!.w, y: seg.y1 });
      if (apart(seg.y1, seg.y2)) pts.push({ x: seg.x, y: seg.y1 }, { x: seg.x, y: seg.y2 });
      if (i + 2 === s.length) pts.push({ x: colX[q.col]!, y: seg.y2 });
    }
    routes.set(key, tidy(pts));
  }
  const trunks: STrunk[] = [];
  for (const cl of clusters) {
    const y = Y[cl.j]!;
    trunks.push({ lines: cl.members, pts: [{ x: colX[cl.from]!, y }, { x: colX[cl.to]! + colWidth[cl.to]!, y }], width: trunkWidth(cl.members.length) });
  }
  // Vertical trunks: where two or more lines share a track, each shared stretch is one.
  vunits.forEach((units) => {
    for (const v of units) {
      if (v.segs.length < 2) continue;
      const vx = v.segs[0]!.x;
      const cuts = [...new Set(v.segs.flatMap((sg) => [sg.y1, sg.y2]))].sort((p, q) => p - q);
      let piece: { from: number; to: number; members: string[] } | null = null;
      const flush = () => {
        if (piece && piece.members.length > 1 && piece.to - piece.from >= 1) {
          trunks.push({ lines: piece.members, pts: [{ x: vx, y: piece.from }, { x: vx, y: piece.to }], width: trunkWidth(piece.members.length) });
        }
        piece = null;
      };
      for (let k = 0; k + 1 < cuts.length; k++) {
        const [ya, yb] = [cuts[k]!, cuts[k + 1]!];
        const members = v.segs.filter((sg) => Math.min(sg.y1, sg.y2) <= ya + 0.5 && Math.max(sg.y1, sg.y2) >= yb - 0.5).flatMap((sg) => sg.keys);
        const cur = piece as { from: number; to: number; members: string[] } | null;
        if (cur && cur.members.length === members.length && cur.members.every((m) => members.includes(m))) cur.to = yb;
        else flush(), (piece = { from: ya, to: yb, members });
      }
      flush();
    }
  });
  // A port's fan: its lines run together from the port to their track.
  gutters.forEach((segs, g) => {
    const fans = new Map<Item, Seg[]>();
    for (const sg of segs) {
      if (!sg.port) continue;
      const ss = fans.get(sg.port);
      if (ss) ss.push(sg);
      else fans.set(sg.port, [sg]);
    }
    for (const [port, ss] of fans) {
      if (ss.length < 2) continue;
      // Out from the port, each line turns off at its track (one that runs straight on, at the
      // gutter's far side), so the stretch to each turn is shared by every line not off yet.
      const left = port.col === g;
      const y = left ? ss[0]!.y1 : ss[0]!.y2;
      const px = colX[port.col]!;
      const far = left ? colX[g + 1]! : colX[g]! + colWidth[g]!;
      const turns = ss.map((sg) => ({ keys: sg.keys, at: Math.abs((apart(sg.y1, sg.y2) ? sg.x : far) - px) })).sort((a, b) => a.at - b.at);
      let from = 0;
      turns.forEach((t, i) => {
        const on = turns.slice(i).flatMap((u) => u.keys);
        if (on.length > 1 && t.at - from >= 1) {
          const [x0, x1] = left ? [px + from, px + t.at] : [px - t.at, px - from];
          trunks.push({ lines: on, pts: [{ x: x0, y }, { x: x1, y }], width: trunkWidth(on.length) });
        }
        from = Math.max(from, t.at);
      });
    }
  });
  const groups: SOut["groups"] = [];
  if (!o.inside)
    for (const side of [1, 2] as const) {
      if (!sideCols[side]) continue;
      const c0 = offset[side]!, c1 = offset[side]! + sideCols[side]! - 1;
      let bottom = TOP;
      for (let c = c0; c <= c1; c++) for (const it of partCols[c]!) bottom = Math.max(bottom, it.y + it.h);
      groups.push({ side, x: colX[c0]! - FRAME_PAD, y: PAD, w: colX[c1]! + colWidth[c1]! + FRAME_PAD - (colX[c0]! - FRAME_PAD), h: bottom + FRAME_PAD - PAD });
    }
  let height = 0;
  for (const it of partItem.values()) height = Math.max(height, it.y + it.h);
  for (const r of groups) height = Math.max(height, r.y + r.h);
  for (const r of routes.values()) for (const p of r) height = Math.max(height, p.y);
  const anchors = new Map<string, number>();
  for (const it of partItem.values()) anchors.set(it.id, o.keep?.get(it.id) ?? it.y);
  return { at, routes, flipped, trunks, groups, width: x + PAD, height: height + PAD, anchors };
}
