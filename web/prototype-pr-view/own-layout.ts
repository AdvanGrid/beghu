// PROTOTYPE (PR view, #163): a layout we write ourselves for the locked top level, to compare with
// ELK's. Three modes:
//
// - Lanes: the locked rules by construction. Columns in a fixed order (people, the changed group,
//   the unchanged group, outside systems); each group layered by its own lines, at most `width`
//   parts a column. Rows ordered by barycentre sweeps, y placed by isotonic regression (so
//   everything packs from the top and no part overlaps), and lines routed through the gutters
//   between columns, each vertical on its own track, ordered to cross least. Every line runs
//   left to right, so there are no U-turns to flatten and no groups to lift.
// - Highway, pull together: long lines whose spans share at least `threshold` of the shorter's
//   gutters, and that run near each other, share one row (a trunk) through the columns they share.
//   Placement then runs again with the trunks, so they pull their members together. Short lines
//   (fewer than `minGutters` gutters) never join one.
// - Highway, merge as found: Lanes as it is, then lines that already run side by side (same gap
//   in a column, close enough, for at least `threshold` of the shorter's gutters) snap onto one
//   trunk. Nothing else moves.
//
// Coordinates are the drawing's; each route is in laid direction (lower column to higher), and
// `flipped` lists the lines laid to → from (their arrows stay as they are).

export type P = { x: number; y: number };
export interface LNode {
  id: string;
  /** 0 people, 1 the changed group, 2 the unchanged group, 3 outside systems. */
  side: 0 | 1 | 2 | 3;
  w: number;
  h: number;
}
export interface LLink {
  key: string;
  from: string;
  to: string;
}
export type Mode = "lanes" | "pull" | "found" | "street";
export interface Opts {
  mode: Mode;
  /** Most parts in one column of a group. */
  width?: number;
  /** A trunk needs the lines to share this share of the shorter one's gutters. */
  threshold?: number;
  /** Lines spanning fewer gutters than this stay local. */
  minGutters?: number;
  /** Pull together: how many rows apart two lines may run and still be pulled into one trunk. */
  reach?: number;
  /** Merge as found: how close (px) two lines must run to count as following each other. */
  close?: number;
  /**
   * Highway: what may merge. `line`, a line joins a trunk when it shares `threshold` of its own
   * span; `trunks`, the same rule applied again with trunks counted as lines, until nothing
   * merges; `stretch`, any stretch where two run together for `minGutters` gutters, whatever share.
   */
  merge?: "line" | "trunks" | "stretch";
  /** Pack each group into as few columns as `width` allows (default on for street routing). */
  pack?: boolean;
  /** Street routing: what riding a stretch another line already uses costs, as a share of its length. */
  discount?: number;
  /** Street routing: place the parts on their own, then widen only the gaps the routes need (default on). */
  compact?: boolean;
  /** Street routing: what a bend costs, in px of length. */
  bend?: number;
  /** Move rows that make a line dip round a part back across it (default on). */
  undip?: boolean;
  /** Pull together: rounds of group, order and place (later rounds only add merges). */
  rounds?: number;
  /** Y placement: Brandes–Köpf alignment (default), or per-column isotonic regression. */
  placement?: "bk" | "iso";
}
export interface Trunk {
  key: string;
  members: string[];
  pts: P[];
  width: number;
}
export interface Own {
  at: Map<string, P>;
  regions: { key: "C" | "U"; x: number; y: number; w: number; h: number }[];
  routes: Map<string, P[]>;
  flipped: Set<string>;
  trunks: Trunk[];
  /** For each line, the trunks it rides, in order. */
  rides: Map<string, string[]>;
  width: number;
  height: number;
}

const PAD = 24;
const FRAME_TOP = 44;
const FRAME_PAD = 20;
const GAP_NN = 28;
const GAP_ND = 16;
const GAP_DD = 10;
const TRACK = 10;
const GUT_PAD = 14;
const GUT_MIN = 44;
/** A trunk's drawn width, from how many lines it carries. */
export const trunkWidth = (n: number) => Math.min(3 + 1.5 * n, 12);

interface Item {
  id: string;
  col: number;
  w: number;
  h: number;
  node?: LNode;
  /** The laid lines through this item (a dummy carries one, a trunk several). */
  links: string[];
  trunk?: number;
  ord: number;
  y: number;
}

interface Laid {
  key: string;
  a: string;
  b: string;
}

export function ownLayout(nodes: LNode[], links: LLink[], o: Opts): Own {
  const thr = o.threshold ?? 0.8;
  const minG = o.minGutters ?? 3;
  const reach = o.reach ?? 6;
  const close = o.close ?? 34;
  // Packed groups can stand taller: about 1.5 × √parts a column, else √(parts / 1.4).
  const W = o.width ?? ((o.pack ?? o.mode === "street") ? Math.ceil(1.5 * Math.sqrt(nodes.length)) : Math.max(5, Math.ceil(Math.sqrt(nodes.length / 1.4))));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 1. Columns: each side's layers, then one global column index.
  const layer = new Map<string, number>();
  const sideLayers = [0, 0, 0, 0];
  for (const side of [0, 1, 2, 3] as const) {
    const ids = nodes.filter((n) => n.side === side).map((n) => n.id);
    if (ids.length === 0) continue;
    if (side === 0 || side === 3) {
      const per = Math.max(W, Math.ceil(ids.length / 2));
      ids.forEach((id, i) => layer.set(id, Math.floor(i / per)));
    } else {
      const mine = new Set(ids);
      const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
      const intra = links.filter((l) => mine.has(l.from) && mine.has(l.to) && l.from !== l.to);
      for (const l of intra) adj.get(l.from)!.push(l.to);
      // Reverse postorder: a topological order once the lines that close a cycle are turned round.
      const pos = new Map<string, number>();
      const seen = new Set<string>();
      const post: string[] = [];
      const visit = (id: string) => {
        seen.add(id);
        for (const t of adj.get(id)!) if (!seen.has(t)) visit(t);
        post.push(id);
      };
      for (const id of ids) if (!seen.has(id)) visit(id);
      post.reverse().forEach((id, i) => pos.set(id, i));
      const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
      for (const l of intra) {
        const [a, b] = pos.get(l.from)! < pos.get(l.to)! ? [l.from, l.to] : [l.to, l.from];
        preds.get(b)!.push(a);
      }
      const count: number[] = [];
      // Packed (street routing's default): as few columns as `width` parts each allows; a part
      // goes in the column its calls want, clamped, or the nearest with room and no part it's
      // joined to. Lines that then run backwards are laid the other way round.
      const K = Math.ceil(ids.length / W);
      const packCols = (o.pack ?? o.mode === "street") && K >= 1;
      const joined = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
      for (const l of intra) (joined.get(l.from)!.add(l.to), joined.get(l.to)!.add(l.from));
      for (const id of [...ids].sort((a, b) => pos.get(a)! - pos.get(b)!)) {
        let L = Math.max(0, ...preds.get(id)!.map((p) => layer.get(p)! + 1));
        if (packCols) {
          const want = Math.min(L, K - 1);
          const ok = (c: number) => (count[c] ?? 0) < W && ![...joined.get(id)!].some((j) => layer.get(j) === c);
          let best = -1;
          for (let d = 0; d < K + 8 && best < 0; d++) for (const c of [want - d, want + d]) if (best < 0 && c >= 0 && ok(c)) best = c;
          L = best < 0 ? K + ids.length : best;
        } else while ((count[L] ?? 0) >= W) L++;
        count[L] = (count[L] ?? 0) + 1;
        layer.set(id, L);
      }
      // Close any empty columns a fallback left.
      const usedL = [...new Set(ids.map((id) => layer.get(id)!))].sort((a, b) => a - b);
      for (const id of ids) layer.set(id, usedL.indexOf(layer.get(id)!));
    }
    sideLayers[side] = Math.max(...ids.map((id) => layer.get(id)!)) + 1;
  }
  const offset = [0, sideLayers[0]!, sideLayers[0]! + sideLayers[1]!, sideLayers[0]! + sideLayers[1]! + sideLayers[2]!];
  const nCols = offset[3]! + sideLayers[3]!;
  const colOf = new Map(nodes.map((n) => [n.id, offset[n.side]! + layer.get(n.id)!]));
  const sideOfCol = (c: number) => (c < offset[1]! ? 0 : c < offset[2]! ? 1 : c < offset[3]! ? 2 : 3);

  // Every line laid from the lower column to the higher.
  const flipped = new Set<string>();
  const laid: Laid[] = [];
  for (const l of links) {
    if (l.from === l.to || !byId.has(l.from) || !byId.has(l.to)) continue;
    const flip = colOf.get(l.from)! > colOf.get(l.to)!;
    if (flip) flipped.add(l.key);
    laid.push({ key: l.key, a: flip ? l.to : l.from, b: flip ? l.from : l.to });
  }
  const span = (l: Laid) => colOf.get(l.b)! - colOf.get(l.a)!;
  const laidBy = new Map(laid.map((l) => [l.key, l]));

  // 2. Items: the parts, plus a dummy per line per column it passes through; a trunk shares one.
  type Cluster = { members: string[]; from: number; to: number; anchor?: string };
  const build = (clusters: Cluster[]) => {
    const items = new Map<string, Item>();
    const cols: Item[][] = Array.from({ length: nCols }, () => []);
    const add = (it: Item) => (items.set(it.id, it), cols[it.col]!.push(it), it);
    for (const n of nodes) add({ id: n.id, col: colOf.get(n.id)!, w: n.w, h: n.h, node: n, links: [], ord: 0, y: 0 });
    // Which trunk a line rides in each column, if any.
    const inCluster = new Map<string, number>();
    clusters.forEach((cl, k) => cl.members.forEach((m) => { for (let c = cl.from; c <= cl.to; c++) inCluster.set(`${m}|${c}`, k); }));
    const chains = new Map<string, Item[]>();
    for (const l of laid) {
      const chain = [items.get(l.a)!];
      for (let c = colOf.get(l.a)! + 1; c < colOf.get(l.b)!; c++) {
        const k = inCluster.get(`${l.key}|${c}`);
        let it: Item;
        if (k !== undefined) {
          const id = `t:${k}:${c}`;
          it = items.get(id) ?? add({ id, col: c, w: 0, h: 0, links: [], trunk: k, ord: 0, y: 0 });
        } else it = add({ id: `d:${l.key}:${c}`, col: c, w: 0, h: 0, links: [], ord: 0, y: 0 });
        it.links.push(l.key);
        chain.push(it);
      }
      chain.push(items.get(l.b)!);
      chains.set(l.key, chain);
    }
    for (const it of items.values()) if (it.trunk !== undefined) it.h = trunkWidth(it.links.length);
    // Neighbours across each gutter, weighted by how many lines join them.
    const left = new Map<Item, Map<Item, number>>();
    const right = new Map<Item, Map<Item, number>>();
    for (const it of items.values()) (left.set(it, new Map()), right.set(it, new Map()));
    for (const chain of chains.values()) {
      for (let i = 0; i + 1 < chain.length; i++) {
        const [p, q] = [chain[i]!, chain[i + 1]!];
        right.get(p)!.set(q, (right.get(p)!.get(q) ?? 0) + 1);
        left.get(q)!.set(p, (left.get(q)!.get(p) ?? 0) + 1);
      }
    }
    return { items, cols, chains, left, right };
  };
  type Built = ReturnType<typeof build>;

  // 3. Order each column: barycentre sweeps, keeping the order with the fewest crossings.
  const crossings = (B: Built) => {
    let n = 0;
    for (let c = 0; c + 1 < nCols; c++) {
      const es: [number, number, number][] = [];
      for (const p of B.cols[c]!) for (const [q, w] of B.right.get(p)!) es.push([p.ord, q.ord, w]);
      for (let i = 0; i < es.length; i++)
        for (let j = i + 1; j < es.length; j++) {
          const [a, b, w] = es[i]!, [x, y, v] = es[j]!;
          if ((a - x) * (b - y) < 0) n += w * v;
        }
    }
    return n;
  };
  const renumber = (B: Built) => B.cols.forEach((col) => col.forEach((it, i) => (it.ord = i)));
  const order = (B: Built, seeded: boolean) => {
    if (!seeded) {
      // Parts in the order given, dummies after; the first sweep places them.
      for (const col of B.cols) col.sort((a, b) => (a.node ? 0 : 1) - (b.node ? 0 : 1));
    } else for (const col of B.cols) col.sort((a, b) => a.ord - b.ord);
    renumber(B);
    const bary = (it: Item, side: Map<Item, Map<Item, number>>) => {
      let s = 0, w = 0;
      for (const [q, k] of side.get(it)!) (s += q.ord * k, (w += k));
      return w ? s / w : it.ord;
    };
    let best = crossings(B);
    let snap = B.cols.map((col) => [...col]);
    for (let it = 0; it < 10; it++) {
      for (let c = 1; c < nCols; c++) {
        const col = B.cols[c]!;
        const k = new Map(col.map((x) => [x, bary(x, B.left)]));
        col.sort((a, b) => k.get(a)! - k.get(b)! || a.ord - b.ord);
        col.forEach((x, i) => (x.ord = i));
      }
      for (let c = nCols - 2; c >= 0; c--) {
        const col = B.cols[c]!;
        const k = new Map(col.map((x) => [x, bary(x, B.right)]));
        col.sort((a, b) => k.get(a)! - k.get(b)! || a.ord - b.ord);
        col.forEach((x, i) => (x.ord = i));
      }
      const n = crossings(B);
      if (n < best) (best = n, (snap = B.cols.map((col) => [...col])));
    }
    B.cols.splice(0, B.cols.length, ...snap);
    renumber(B);
  };

  // 4. Y: everything packs from the top; each item pulled toward its neighbours' middle, in order
  // and never overlapping (weighted isotonic regression per column).
  const TOP = PAD + FRAME_TOP;
  const gap = (a: Item, b: Item) => (a.node && b.node ? GAP_NN : a.node || b.node ? GAP_ND : GAP_DD);
  const place = (B: Built) => {
    const packed = new Map<Item, number>();
    for (const col of B.cols) {
      let y = TOP;
      col.forEach((it, i) => {
        if (i > 0) y += gap(col[i - 1]!, it);
        it.y = y;
        packed.set(it, y);
        y += it.h;
      });
    }
    const mid = (it: Item) => it.y + it.h / 2;
    for (let pass = 0; pass < 8; pass++) {
      const cs = pass % 2 ? [...B.cols.keys()].reverse() : [...B.cols.keys()];
      for (const c of cs) {
        const col = B.cols[c]!;
        if (col.length === 0) continue;
        const off: number[] = [];
        let acc = 0;
        col.forEach((it, i) => {
          if (i > 0) acc += col[i - 1]!.h + gap(col[i - 1]!, it);
          off.push(acc);
        });
        const target: number[] = [];
        const weight: number[] = [];
        col.forEach((it) => {
          let s = 0, w = 0;
          for (const side of [B.left, B.right]) for (const [q, k] of side.get(it)!) (s += mid(q) * k, (w += k));
          // A light pull back to the packed place keeps the groups' tops full.
          const anchor = packed.get(it)!;
          const want = w ? s / w - it.h / 2 : anchor;
          // Dummies follow their line only; parts also feel the pull to the top.
          const pull = it.node ? 0.6 : 0.05;
          target.push(w ? (want * w + anchor * pull) / (w + pull) : anchor);
          weight.push(w + pull);
        });
        const z = isotonic(
          target.map((t, i) => t - off[i]!),
          weight,
        );
        col.forEach((it, i) => (it.y = Math.max(TOP, z[i]!) + off[i]!));
      }
    }
    // Straighten: each run of dummies (a long line, or a trunk, between two parts) takes one
    // height wherever its neighbours in every column it passes leave room, longest runs first.
    const runs: Item[][] = [];
    const seenRun = new Set<string>();
    for (const chain of B.chains.values()) {
      let run: Item[] = [];
      for (const it of chain) {
        if (!it.node) run.push(it);
        else if (run.length) (runs.push(run), (run = []));
      }
    }
    runs.sort((a, b) => b.length - a.length);
    for (let pass = 0; pass < 2; pass++)
      for (const run of runs) {
        const id = run.map((r) => r.id).join();
        if (pass === 0 && seenRun.has(id)) continue;
        seenRun.add(id);
        let lo = TOP, hi = Infinity;
        for (const it of run) {
          const col = B.cols[it.col]!;
          const p = col[it.ord - 1], q = col[it.ord + 1];
          if (p) lo = Math.max(lo, p.y + p.h + gap(p, it));
          if (q) hi = Math.min(hi, q.y - gap(it, q) - it.h);
        }
        if (lo > hi) continue;
        const ys = run.map((it) => it.y).sort((a, b) => a - b);
        const want = ys[Math.floor(ys.length / 2)]!;
        const y = Math.min(hi, Math.max(lo, want));
        for (const it of run) it.y = y;
      }
  };

  // 4b. Y by Brandes–Köpf: chains of items (a long line's dummies first) aligned into blocks that
  // share one height, then blocks packed as tight as their order allows. Four runs (aligning to
  // the left or right neighbours, packing from the top or the bottom); the shortest wins.
  const bk = (B: Built) => {
    const items = [...B.items.values()];
    const sep = (a: Item, b: Item) => a.h / 2 + gap(a, b) + b.h / 2;
    const isDummy = (it: Item) => !it.node;
    const run = (fromRight: boolean, fromBottom: boolean) => {
      const cols = (fromRight ? [...B.cols].reverse() : B.cols).map((c) => (fromBottom ? [...c].reverse() : [...c]));
      const pos = new Map<Item, number>();
      cols.forEach((c) => c.forEach((it, i) => pos.set(it, i)));
      const upper = (it: Item) => [...(fromRight ? B.right : B.left).get(it)!.keys()].sort((a, b) => pos.get(a)! - pos.get(b)!);
      // Type-1 conflicts: a line between a part and a dummy that crosses a dummy–dummy segment.
      const marked = new Set<string>();
      for (let i = 1; i + 1 < cols.length; i++) {
        const next = cols[i + 1]!;
        let k0 = 0, l = 0;
        for (let l1 = 0; l1 < next.length; l1++) {
          const v = next[l1]!;
          const inner = isDummy(v) ? upper(v).find((u) => isDummy(u)) : undefined;
          if (l1 === next.length - 1 || inner) {
            const k1 = inner ? pos.get(inner)! : cols[i]!.length - 1;
            for (; l <= l1; l++) {
              const w = next[l]!;
              for (const u of upper(w)) {
                const pu = pos.get(u)!;
                if ((pu < k0 || pu > k1) && !(isDummy(u) && isDummy(w))) marked.add(`${u.id}|${w.id}`);
              }
            }
            k0 = k1;
          }
        }
      }
      const root = new Map<Item, Item>(items.map((it) => [it, it]));
      const align = new Map<Item, Item>(items.map((it) => [it, it]));
      for (let i = 1; i < cols.length; i++) {
        let r = -1;
        for (const v of cols[i]!) {
          const d = upper(v);
          if (!d.length) continue;
          for (const m of [...new Set([Math.floor((d.length - 1) / 2), Math.ceil((d.length - 1) / 2)])]) {
            if (align.get(v) !== v) continue;
            const u = d[m]!;
            if (!marked.has(`${u.id}|${v.id}`) && r < pos.get(u)!) {
              align.set(u, v);
              root.set(v, root.get(u)!);
              align.set(v, root.get(v)!);
              r = pos.get(u)!;
            }
          }
        }
      }
      // Block graph: an edge from the block above to the block below, weighted by separation.
      const below = new Map<Item, Map<Item, number>>();
      const above = new Map<Item, Map<Item, number>>();
      for (const c of cols)
        for (let i = 1; i < c.length; i++) {
          const [a, b] = [root.get(c[i - 1]!)!, root.get(c[i]!)!];
          const w = sep(c[i - 1]!, c[i]!);
          if (!below.has(a)) below.set(a, new Map());
          if (!above.has(b)) above.set(b, new Map());
          below.get(a)!.set(b, Math.max(below.get(a)!.get(b) ?? 0, w));
          above.get(b)!.set(a, Math.max(above.get(b)!.get(a) ?? 0, w));
        }
      const roots = [...new Set(root.values())];
      const ys = new Map<Item, number>();
      const visit1 = (b: Item): number => {
        if (ys.has(b)) return ys.get(b)!;
        let y = 0;
        for (const [a, w] of above.get(b) ?? []) y = Math.max(y, visit1(a) + w);
        ys.set(b, y);
        return y;
      };
      roots.forEach(visit1);
      // Pull blocks with room below them down toward their lower neighbours, keeping the order.
      const done = new Set<Item>();
      const visit2 = (b: Item) => {
        if (done.has(b)) return;
        done.add(b);
        const out = below.get(b);
        if (!out || out.size === 0) return;
        let y = Infinity;
        for (const [c, w] of out) (visit2(c), (y = Math.min(y, ys.get(c)! - w)));
        if (y > ys.get(b)!) ys.set(b, y);
      };
      if (!fromBottom) roots.forEach(visit2);
      const at = new Map<Item, number>();
      for (const it of items) at.set(it, fromBottom ? -ys.get(root.get(it)!)! : ys.get(root.get(it)!)!);
      let lo = Infinity, hi = -Infinity;
      for (const it of items) (lo = Math.min(lo, at.get(it)! - it.h / 2), (hi = Math.max(hi, at.get(it)! + it.h / 2)));
      return { at, lo, hi };
    };
    const runs = [run(false, false), run(true, false), run(false, true), run(true, true)];
    const best = runs.reduce((a, b) => (b.hi - b.lo < a.hi - a.lo ? b : a));
    for (const it of items) it.y = best.at.get(it)! - it.h / 2 - best.lo + TOP;
  };

  // Clusters of lines that follow each other, longest first; each later line joins the first
  // cluster it shares enough of its span with, within `near`.
  const clusterBy = (near: (a: string, b: string, c: number) => boolean): Cluster[] => {
    const longs = laid.filter((l) => span(l) >= minG).sort((a, b) => span(b) - span(a) || (a.key < b.key ? -1 : 1));
    const clusters: (Omit<Cluster, "anchor"> & { anchor: Laid })[] = [];
    for (const l of longs) {
      const [lo, hi] = [colOf.get(l.a)! + 1, colOf.get(l.b)! - 1];
      let joined = false;
      for (const cl of clusters) {
        // The longest run of columns inside the cluster's core where the two run near.
        let bestFrom = 0, bestTo = -1, run = 0;
        for (let c = Math.max(lo, cl.from); c <= Math.min(hi, cl.to); c++) {
          if (near(cl.anchor.key, l.key, c)) {
            run++;
            if (run > bestTo - bestFrom + 1) (bestFrom = c - run + 1, (bestTo = c));
          } else run = 0;
        }
        const shared = bestTo - bestFrom + 1;
        // Shared gutters: the shared columns plus one.
        if (shared >= 1 && shared + 1 >= thr * span(l) && cl.members.every((m) => shared + 1 >= thr * Math.min(span(laidBy.get(m)!), span(l)) || m === cl.anchor.key)) {
          cl.members.push(l.key);
          cl.from = bestFrom;
          cl.to = bestTo;
          joined = true;
          break;
        }
      }
      if (!joined) clusters.push({ members: [l.key], from: lo, to: hi, anchor: l });
    }
    return clusters.map(({ members, from, to, anchor }) => ({ members, from, to, anchor: anchor.key }));
  };

  // Trunks merge too, or per stretch: sections (a run of columns where a set of lines share one
  // row) merge pairwise, the longest shared run first, until nothing more qualifies. Where two
  // merge, the shared run becomes one section, and what's left of each either side stays its own.
  const sections = (near: (a: string, b: string, c: number) => boolean, rule: "trunks" | "stretch", seed?: Cluster[]): Cluster[] => {
    type Sec = Cluster & { anchor: string };
    let secs: Sec[];
    if (seed) {
      // Keep every earlier merge; each line's columns outside them are sections of their own.
      secs = seed.map((c) => ({ ...c, anchor: c.anchor ?? c.members[0]! }));
      const covered = new Set(seed.flatMap((c) => c.members.flatMap((m) => Array.from({ length: c.to - c.from + 1 }, (_, i) => `${m}|${c.from + i}`))));
      for (const l of laid.filter((l) => span(l) >= minG)) {
        let from = -1;
        for (let c = colOf.get(l.a)! + 1; c <= colOf.get(l.b)!; c++) {
          const free = c < colOf.get(l.b)! && !covered.has(`${l.key}|${c}`);
          if (free && from < 0) from = c;
          if (!free && from >= 0) (secs.push({ members: [l.key], from, to: c - 1, anchor: l.key }), (from = -1));
        }
      }
    } else
      secs =
        rule === "trunks"
          ? clusterBy(near).map((c) => ({ ...c, anchor: c.anchor! }))
          : laid.filter((l) => span(l) >= minG).map((l) => ({ members: [l.key], from: colOf.get(l.a)! + 1, to: colOf.get(l.b)! - 1, anchor: l.key }));
    for (let iter = 0; iter < 2000; iter++) {
      let best: { i: number; j: number; r0: number; r1: number } | null = null;
      for (let i = 0; i < secs.length; i++)
        for (let j = i + 1; j < secs.length; j++) {
          const [S, T] = [secs[i]!, secs[j]!];
          const lo = Math.max(S.from, T.from), hi = Math.min(S.to, T.to);
          if (lo > hi) continue;
          let r0 = 0, r1 = -1, run = 0;
          for (let c = lo; c <= hi; c++) {
            if (near(S.anchor, T.anchor, c)) {
              run++;
              if (run > r1 - r0 + 1) (r0 = c - run + 1, (r1 = c));
            } else run = 0;
          }
          const r = r1 - r0 + 1;
          if (r < 1) continue;
          const ok = rule === "trunks" ? r + 1 >= thr * Math.min(S.to - S.from + 2, T.to - T.from + 2) : r + 1 >= minG;
          if (ok && (!best || r > best.r1 - best.r0 + 1)) best = { i, j, r0, r1 };
        }
      if (!best) break;
      const [S, T] = [secs[best.i]!, secs[best.j]!];
      const keep = S.members.length > T.members.length ? S : T;
      const next: Sec[] = [{ members: [...S.members, ...T.members], from: best.r0, to: best.r1, anchor: keep.anchor }];
      for (const X of [S, T]) {
        if (X.from < best.r0) next.push({ ...X, to: best.r0 - 1 });
        if (X.to > best.r1) next.push({ ...X, from: best.r1 + 1 });
      }
      secs = [...secs.filter((x) => x !== S && x !== T), ...next];
    }
    return secs;
  };
  const group = (near: (a: string, b: string, c: number) => boolean, seed?: Cluster[]): Cluster[] =>
    (o.merge === "trunks" || o.merge === "stretch" ? sections(near, o.merge, seed) : clusterBy(near)).filter((c) => c.members.length > 1);

  let B = build([]);
  order(B, false);
  (o.placement === "iso" ? place : bk)(B);
  let clusters: Cluster[] = [];
  // Where a line sits in a column: the item (its own dummy, or the trunk it rides) carrying it.
  const carrier = (key: string, c: number) => {
    const chain = B.chains.get(key)!;
    return chain[c - colOf.get(laidBy.get(key)!.a)!];
  };
  /** Lays the current clusters out again, seeding the order with the last layout's. */
  const rebuild = () => {
    const prev = B;
    B = build(clusters);
    // A trunk takes its members' mean row.
    for (const it of B.items.values()) {
      const old = it.links
        .map((k) => prev.chains.get(k)![it.col - colOf.get(laidBy.get(k)!.a)!]?.ord)
        .filter((v) => v !== undefined);
      it.ord = it.node ? prev.items.get(it.id)!.ord : old.reduce((s, v) => s + v, 0) / Math.max(1, old.length);
    }
    order(B, true);
    (o.placement === "iso" ? place : bk)(B);
  };
  /** For each trunk, the lines that dip to ride it (drop to it and climb back, or the reverse). */
  const dippers = () => {
    const out = new Map<number, Set<string>>();
    const mid0 = (it: Item) => it.y + it.h / 2;
    for (const [key, chain] of B.chains) {
      const m = chain.map(mid0);
      for (let k = 1; k + 1 < chain.length; k++) {
        const it = chain[k]!;
        if (it.trunk === undefined) continue;
        let a = k - 1, b = k + 1;
        while (a > 0 && Math.abs(m[a]! - m[k]!) < 1) a--;
        while (b < chain.length - 1 && Math.abs(m[b]! - m[k]!) < 1) b++;
        const da = m[a]! - m[k]!, db = m[b]! - m[k]!;
        if (Math.abs(da) > 20 && Math.abs(db) > 20 && Math.sign(da) === Math.sign(db)) out.set(it.trunk, (out.get(it.trunk) ?? new Set()).add(key));
      }
    }
    return out;
  };
  if (o.mode === "pull") {
    // Rounds: group by rows in the current layout, rebuild with the trunks, order and place
    // again; lines the last round pulled together can now join each other. Until nothing changes.
    let last = "";
    const rounds = o.merge === "trunks" || o.merge === "stretch" ? (o.rounds ?? 1) : 1;
    for (let round = 0; round < rounds; round++) {
      const ordAt = (key: string, c: number) => carrier(key, c)?.ord;
      const next = group((a, b, c) => {
        const x = ordAt(a, c), y = ordAt(b, c);
        return x !== undefined && y !== undefined && Math.abs(x - y) <= reach;
      }, round ? clusters : undefined);
      const sig = next.map((c) => `${c.from}-${c.to}:${[...c.members].sort().join()}`).sort().join("|");
      if (sig === last) break;
      last = sig;
      clusters = next;
      rebuild();
    }
    // A line doesn't ride a trunk that makes it dip: take it off that trunk and lay out again.
    for (let pass = 0; pass < 3 && o.undip !== false; pass++) {
      const d = dippers();
      if (!d.size) break;
      clusters = clusters
        .map((c, k) => ({ ...c, members: c.members.filter((m) => !d.get(k)?.has(m)) }))
        .filter((c) => c.members.length > 1);
      rebuild();
    }
  } else if (o.mode === "found") {
    const nodeYs = B.cols.map((col) => col.filter((it) => it.node).map((it) => [it.y, it.y + it.h] as const));
    const yAt = (key: string, c: number) => B.items.get(`d:${key}:${c}`)?.y;
    clusters = group((a, b, c) => {
      const x = yAt(a, c), y = yAt(b, c);
      if (x === undefined || y === undefined || Math.abs(x - y) > close) return false;
      const [lo, hi] = [Math.min(x, y), Math.max(x, y)];
      return !nodeYs[c]!.some(([t, b2]) => b2 > lo && t < hi);
    });
    const prev = B;
    B = build(clusters);
    // Nothing moves but the merged lines: a trunk sits at its members' mean height.
    for (const it of B.items.values()) {
      if (it.node) {
        const p = prev.items.get(it.id)!;
        (it.y = p.y, (it.ord = p.y));
      } else {
        const ys = it.links.map((k) => prev.items.get(`d:${k}:${it.col}`)!.y);
        it.y = ys.reduce((s, v) => s + v, 0) / ys.length - it.h / 2;
        it.ord = it.y + it.h / 2;
      }
    }
    for (const col of B.cols) col.sort((a, b) => a.ord - b.ord);
    renumber(B);
  }

  // 4c. Undip: a row that sits past a part from both its line's neighbours (the line drops round
  // the part and climbs back) moves back across, when that adds at most two crossings; then the
  // rows are placed again. Rule 8: no U-turn where a straight route is free.
  const crossAt = (Bb: Built, g: number) => {
    if (g < 0 || g + 1 >= nCols) return 0;
    let n = 0;
    const es: [number, number, number][] = [];
    for (const p of Bb.cols[g]!) for (const [q, w] of Bb.right.get(p)!) es.push([p.ord, q.ord, w]);
    for (let i = 0; i < es.length; i++)
      for (let j = i + 1; j < es.length; j++) {
        const [a, b, w] = es[i]!, [x, y, v] = es[j]!;
        if ((a - x) * (b - y) < 0) n += w * v;
      }
    return n;
  };
  const undip = (Bb: Built) => {
    const mid0 = (it: Item) => it.y + it.h / 2;
    for (let round = 0; round < 6; round++) {
      const wants = new Map<Item, number[]>();
      const veto = new Set<Item>();
      for (const chain of Bb.chains.values()) {
        const m = chain.map(mid0);
        for (let k = 1; k + 1 < chain.length; k++) {
          let a = k - 1, b = k + 1;
          while (a > 0 && Math.abs(m[a]! - m[k]!) < 1) a--;
          while (b < chain.length - 1 && Math.abs(m[b]! - m[k]!) < 1) b++;
          const da = m[a]! - m[k]!, db = m[b]! - m[k]!;
          const it = chain[k]!;
          if (Math.abs(da) >= 1 && Math.abs(db) >= 1 && Math.sign(da) === Math.sign(db)) {
            const target = da < 0 ? Math.max(m[a]!, m[b]!) : Math.min(m[a]!, m[b]!);
            wants.set(it, [...(wants.get(it) ?? []), target]);
          } else veto.add(it);
        }
      }
      let moved = false;
      for (const [it, ts] of wants) {
        if (veto.has(it)) continue;
        const target = ts.reduce((x, y) => x + y, 0) / ts.length;
        const col = Bb.cols[it.col]!;
        const rest = col.filter((x) => x !== it);
        const up = target < mid0(it);
        // Only worth it when a part stands between the row and where its line wants to be.
        const between = rest.filter((x) => x.node && (up ? mid0(x) < mid0(it) && x.y + x.h > target : mid0(x) > mid0(it) && x.y < target));
        if (!between.length) continue;
        let at = rest.findIndex((x) => mid0(x) > target);
        if (at < 0) at = rest.length;
        const before = crossAt(Bb, it.col - 1) + crossAt(Bb, it.col);
        const old = [...col];
        col.splice(0, col.length, ...rest.slice(0, at), it, ...rest.slice(at));
        col.forEach((x, i) => (x.ord = i));
        if (crossAt(Bb, it.col - 1) + crossAt(Bb, it.col) - before > 2) {
          col.splice(0, col.length, ...old);
          col.forEach((x, i) => (x.ord = i));
        } else moved = true;
      }
      if (!moved) break;
      (o.placement === "iso" ? place : bk)(Bb);
    }
  };

  // 4d. Street routing: parts stay where Lanes put them. Each line then picks the height it passes
  // each column at (a level: a part's middle or a gap's, free of parts in that column), as one
  // cheapest path: length, a cost per bend, and a discount on any stretch, along a column or up a
  // gutter, that a line already routed uses. Long lines go first (they lay the highways), then
  // each is routed again against all the others. Local lines take no discount and avoid others.
  if (o.mode === "street") {
    const D = o.discount ?? 0.85;
    const BEND = o.bend ?? 40;
    const M = 10; // a level's clearance from a part
    const mid0 = (it: Item) => it.y + it.h / 2;
    // Parts only: each column packed from the top in Lanes' order, pulled toward the middle of the
    // parts it connects to; `extra[c][i]` widens the gap above the column's i-th part.
    const nodeCols = B.cols.map((col) => col.filter((it) => it.node));
    const nbrs = new Map<Item, Item[]>();
    for (const l of laid) {
      const [a, b] = [B.items.get(l.a)!, B.items.get(l.b)!];
      nbrs.set(a, [...(nbrs.get(a) ?? []), b]);
      nbrs.set(b, [...(nbrs.get(b) ?? []), a]);
    }
    const GAP_S = 36;
    const placeParts = (extra: number[][]) => {
      const packed = new Map<Item, number>();
      nodeCols.forEach((col, c) => {
        let y = TOP;
        col.forEach((it, i) => {
          y += (i ? GAP_S : 0) + (extra[c]?.[i] ?? 0);
          it.y = y;
          packed.set(it, y);
          y += it.h;
        });
      });
      for (let pass = 0; pass < 10; pass++)
        nodeCols.forEach((col, c) => {
          if (!col.length) return;
          const off: number[] = [];
          let acc = extra[c]?.[0] ?? 0;
          col.forEach((_, i) => {
            if (i) acc += col[i - 1]!.h + GAP_S + (extra[c]?.[i] ?? 0);
            off.push(acc);
          });
          const t: number[] = [], w: number[] = [];
          col.forEach((it, i) => {
            const ns = nbrs.get(it) ?? [];
            const want = ns.length ? ns.reduce((s2, q) => s2 + q.y + q.h / 2, 0) / ns.length - it.h / 2 : packed.get(it)!;
            const anchor = packed.get(it)!;
            t.push((want * ns.length + anchor * 1.5) / (ns.length + 1.5) - off[i]!);
            w.push(ns.length + 1.5);
          });
          const z = isotonic(t, w);
          col.forEach((it, i) => (it.y = Math.max(TOP, z[i]!) + off[i]!));
        });
    };
    const compact = o.compact !== false;
    let extra: number[][] = B.cols.map(() => []);
    let hUse: Map<string, Set<string>>[] = [];
    let paths = new Map<string, { ys: number[]; long: boolean }>();
    for (let grow = 0; grow < (compact ? 3 : 1); grow++) {
    if (compact) placeParts(extra);
    const raw: number[] = [];
    for (const col of B.cols) {
      const ns = col.filter((it) => it.node).sort((a, b) => a.y - b.y);
      ns.forEach((n, i) => {
        raw.push(mid0(n));
        const nx = ns[i + 1];
        if (nx) raw.push((n.y + n.h + nx.y) / 2);
      });
      if (ns.length) (raw.push(ns[0]!.y - 24), raw.push(ns[ns.length - 1]!.y + ns[ns.length - 1]!.h + 24));
    }
    raw.sort((a, b) => a - b);
    const Y: number[] = [];
    for (const y of raw) if (!Y.length || y - Y[Y.length - 1]! >= 12) Y.push(y);
    const L = Y.length;
    const free: boolean[][] = B.cols.map((col) => Y.map((y) => !col.some((it) => it.node && y > it.y - M && y < it.y + it.h + M)));
    const colWidth = B.cols.map((col) => Math.max(0, ...col.map((it) => it.w)));
    // Usage: per column, per level, which lines ride it; per gutter, per level step, how many.
    hUse = B.cols.map(() => new Map());
    const vUse: number[][] = Array.from({ length: nCols }, () => new Array(L).fill(0));
    const levelOf = (y: number) => {
      let lo = 0, hi = L - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (Y[m]! < y) lo = m + 1;
        else hi = m;
      }
      return lo;
    };
    paths = new Map();
    const mark = (key: string, ys: number[], c0: number, sign: number) => {
      // ys: the y the line has in each gutter boundary: ys[0] at its start part, then a level per column, then its end part.
      for (let i = 1; i + 1 < ys.length; i++) {
        const c = c0 + i;
        const k = String(ys[i]);
        const set = hUse[c]!.get(k) ?? new Set();
        if (sign > 0) set.add(key);
        else set.delete(key);
        hUse[c]!.set(k, set);
      }
      for (let i = 0; i + 1 < ys.length; i++) {
        const g = c0 + i;
        const [a, b] = [levelOf(Math.min(ys[i]!, ys[i + 1]!)), levelOf(Math.max(ys[i]!, ys[i + 1]!))];
        for (let j = a; j < b; j++) vUse[g]![j]! += sign;
      }
    };
    const route = (l: Laid, long: boolean) => {
      const ca = colOf.get(l.a)!, cb = colOf.get(l.b)!;
      const ya = mid0(B.items.get(l.a)!), yb = mid0(B.items.get(l.b)!);
      const n = cb - ca - 1;
      if (n <= 0) return [ya, yb];
      // Vertical cost in gutter g between two ys, with the discount where others run.
      const pre = (g: number) => {
        const out = new Array(L).fill(0);
        for (let j = 0; j + 1 < L; j++) {
          const seg = Y[j + 1]! - Y[j]!;
          const shared = long && vUse[g]![j]! > 0;
          out[j + 1] = out[j] + (shared ? seg * D : !long && vUse[g]![j]! > 0 ? seg * 1.5 : seg);
        }
        return out;
      };
      const vcost = (P: number[], y0: number, y1: number) => {
        if (Math.abs(y0 - y1) < 0.5) return 0;
        const [lo, hi] = [Math.min(y0, y1), Math.max(y0, y1)];
        const i = levelOf(lo), j = levelOf(hi);
        // Ends off the level grid (a part's port) pay full length for the bit off it.
        const inner = j > i ? P[j]! - P[i]! : 0;
        return inner + Math.abs(Y[i]! - lo) + Math.abs(hi - Y[Math.min(j, L - 1)]!) + 2 * BEND;
      };
      let dp = new Array(L).fill(Infinity);
      const back: Int32Array[] = [];
      {
        const P = pre(ca);
        const c = ca + 1;
        for (let j = 0; j < L; j++) {
          if (!free[c]![j]) continue;
          const users = hUse[c]!.get(String(Y[j]))?.size ?? 0;
          const h = colWidth[c]! * (long && users ? D : !long && users ? 1.5 : 1);
          dp[j] = vcost(P, ya, Y[j]!) + h;
        }
        back.push(new Int32Array(L).fill(-1));
      }
      for (let k = 1; k < n; k++) {
        const g = ca + k;
        const c = g + 1;
        const P = pre(g);
        const next = new Array(L).fill(Infinity);
        const bk2 = new Int32Array(L).fill(-1);
        for (let j = 0; j < L; j++) {
          if (!free[c]![j]) continue;
          const users = hUse[c]!.get(String(Y[j]))?.size ?? 0;
          const h = colWidth[c]! * (long && users ? D : !long && users ? 1.5 : 1);
          let best = Infinity, arg = -1;
          for (let i = 0; i < L; i++) {
            if (dp[i] === Infinity) continue;
            const v = dp[i] + (i === j ? 0 : P[Math.max(i, j)]! - P[Math.min(i, j)]! + 2 * BEND);
            if (v < best) (best = v, (arg = i));
          }
          next[j] = best + h;
          bk2[j] = arg;
        }
        dp = next;
        back.push(bk2);
      }
      const Pe = pre(cb - 1);
      let best = Infinity, arg = -1;
      for (let j = 0; j < L; j++) if (dp[j] < Infinity) {
        const v = dp[j] + vcost(Pe, Y[j]!, yb);
        if (v < best) (best = v, (arg = j));
      }
      if (arg < 0) return null;
      const lv: number[] = [];
      for (let k = n - 1, j = arg; k >= 0; k--) (lv.unshift(Y[j]!), (j = back[k]![j]!));
      return [ya, ...lv, yb];
    };
    const order2 = [...laid].sort((a, b) => span(b) - span(a));
    for (let pass = 0; pass < 3; pass++)
      for (const l of order2) {
        const long = span(l) >= minG;
        const old = paths.get(l.key);
        if (old) mark(l.key, old.ys, colOf.get(l.a)!, -1);
        const ys = route(l, long);
        if (!ys) continue;
        paths.set(l.key, { ys, long });
        mark(l.key, ys, colOf.get(l.a)!, +1);
      }
    if (!compact) break;
    // Widen each gap to fit the levels routed through it (12 px apart, clear of the parts).
    let grew = false;
    const next = nodeCols.map((col, c) => {
      const used = [...hUse[c]!].filter(([, set]) => set.size > 0).map(([k]) => Number(k));
      return col.map((it, i) => {
        const top = i ? col[i - 1]!.y + col[i - 1]!.h : TOP - 24;
        const n = used.filter((y) => y > top && y < it.y).length;
        const need = n ? n * 12 + 2 * M : 0;
        const have = it.y - top;
        const add = Math.max(extra[c]![i] ?? 0, need - have + (extra[c]![i] ?? 0));
        if (add > (extra[c]![i] ?? 0) + 1) grew = true;
        return add;
      });
    });
    if (!grew) break;
    extra = next;
    }
    // Long lines sharing a level in a column ride one trunk there; runs of columns with the same
    // riders and level are one trunk.
    const per: { c: number; y: number; members: string[] }[] = [];
    for (let c = 0; c < nCols; c++)
      for (const [k, set] of hUse[c]!) {
        const members = [...set].filter((m) => paths.get(m)?.long);
        if (members.length > 1) per.push({ c, y: Number(k), members: members.sort() });
      }
    per.sort((a, b) => a.y - b.y || a.c - b.c);
    const cl2: Cluster[] = [];
    for (const p of per) {
      const lastC = cl2[cl2.length - 1];
      if (lastC && lastC.to === p.c - 1 && (lastC as Cluster & { y?: number }).y === p.y && lastC.members.join() === p.members.join()) lastC.to = p.c;
      else cl2.push({ members: p.members, from: p.c, to: p.c, y: p.y } as Cluster);
    }
    clusters = cl2;
    const placed = B;
    B = build(clusters);
    for (const it of B.items.values()) {
      if (it.node) it.y = placed.items.get(it.id)!.y;
      else {
        const k = it.links[0]!;
        const ys = paths.get(k)?.ys;
        const y = ys ? ys[it.col - colOf.get(laidBy.get(k)!.a)!]! : 0;
        it.y = y - it.h / 2;
      }
    }
    for (const col of B.cols) col.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
    renumber(B);
  }
  if (o.undip !== false && o.mode !== "street") undip(B);

  // 5. Ports: a part's lines leave (and arrive) spread down its side, ordered by the other end.
  const mid = (it: Item) => it.y + it.h / 2;
  const portR = new Map<string, number>(); // `${item}|${link}` → y
  const portL = new Map<string, number>();
  const spread = (it: Item, keys: { key: string; toward: number }[], into: Map<string, number>) => {
    keys.sort((a, b) => a.toward - b.toward || (a.key < b.key ? -1 : 1));
    const n = keys.length;
    const step = n > 1 ? Math.min(12, (it.h - 16) / (n - 1)) : 0;
    keys.forEach((k, i) => into.set(`${it.id}|${k.key}`, it.node ? mid(it) + (i - (n - 1) / 2) * step : mid(it)));
  };
  {
    const outs = new Map<Item, { key: string; toward: number }[]>();
    const ins = new Map<Item, { key: string; toward: number }[]>();
    for (const [key, chain] of B.chains) {
      for (let i = 0; i + 1 < chain.length; i++) {
        const [p, q] = [chain[i]!, chain[i + 1]!];
        outs.set(p, [...(outs.get(p) ?? []), { key, toward: mid(q) }]);
        ins.set(q, [...(ins.get(q) ?? []), { key, toward: mid(p) }]);
      }
    }
    for (const [it, ks] of outs) spread(it, ks, portR);
    for (const [it, ks] of ins) spread(it, ks, portL);
  }

  // 6. Each gutter: one vertical per line (one per trunk), on tracks ordered to cross least.
  type Seg = { keys: string[]; y1: number; y2: number; thick: number; track: number; x: number };
  const gutters: Seg[][] = Array.from({ length: Math.max(0, nCols - 1) }, () => []);
  const segOf = new Map<string, Seg>(); // `${gutter}|${link}`
  for (const [key, chain] of B.chains) {
    for (let i = 0; i + 1 < chain.length; i++) {
      const [p, q] = [chain[i]!, chain[i + 1]!];
      const g = p.col;
      const shared = p.trunk !== undefined && p.trunk === q.trunk;
      const sid = shared ? `${g}|t${p.trunk}` : `${g}|${key}`;
      let s = segOf.get(sid);
      if (!s) {
        s = { keys: [], y1: portR.get(`${p.id}|${key}`)!, y2: portL.get(`${q.id}|${key}`)!, thick: shared ? p.h : 1.5, track: -1, x: 0 };
        segOf.set(sid, s);
        gutters[g]!.push(s);
      }
      s.keys.push(key);
      segOf.set(`${g}|${key}`, s);
    }
  }
  const trackCount: number[] = [];
  const trackW: number[][] = [];
  // A track unit: one line's vertical, or (Highway) several verticals sharing one track, joining
  // and leaving it at their own heights.
  type V = { segs: Seg[]; ins: number[]; outs: number[]; lo: number; hi: number; thick: number; track: number };
  const vunits: V[][] = [];
  const highway = o.mode !== "lanes";
  /** Verticals shorter than this never share a track. */
  const SHORT = 40;
  /** Per stretch: verticals that run together this far share a track. */
  const STRETCH_PX = o.mode === "street" ? 20 : 120;
  const unit = (segs: Seg[]): V => {
    const ys = segs.flatMap((x) => [x.y1, x.y2]);
    const keys = segs.reduce((n, x) => n + x.keys.length, 0);
    return {
      segs,
      ins: segs.map((x) => x.y1),
      outs: segs.map((x) => x.y2),
      lo: Math.min(...ys),
      hi: Math.max(...ys),
      thick: segs.length > 1 ? Math.max(trunkWidth(keys), ...segs.map((x) => x.thick)) : segs[0]!.thick,
      track: 0,
    };
  };
  const overlap = (a: { lo: number; hi: number }, b: { lo: number; hi: number }) => Math.max(0, Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo));
  gutters.forEach((segs, g) => {
    const bends = segs.filter((x) => Math.abs(x.y1 - x.y2) >= 1);
    let units: V[];
    if (!highway) units = bends.map((x) => unit([x]));
    else {
      // Longest first; each joins the first group it runs along far enough (the merge rule).
      const span1 = (x: Seg) => ({ lo: Math.min(x.y1, x.y2), hi: Math.max(x.y1, x.y2) });
      const len = (r: { lo: number; hi: number }) => r.hi - r.lo;
      const groups: { segs: Seg[]; anchor: { lo: number; hi: number }; all: { lo: number; hi: number } }[] = [];
      for (const x of [...bends].sort((p, q) => len(span1(q)) - len(span1(p)))) {
        const r = span1(x);
        const fits = (gr: (typeof groups)[number]) =>
          len(r) >= SHORT &&
          (o.merge === "stretch" || o.mode === "street" ? overlap(r, gr.all) >= STRETCH_PX : overlap(r, gr.anchor) >= thr * Math.min(len(r), len(gr.anchor)));
        const gr = groups.find(fits);
        if (gr) (gr.segs.push(x), (gr.all = { lo: Math.min(gr.all.lo, r.lo), hi: Math.max(gr.all.hi, r.hi) }));
        else groups.push({ segs: [x], anchor: r, all: r });
      }
      // Trunks too: groups merge with groups by the same rule, counted on their whole stretch.
      if (o.merge === "trunks")
        for (let merged = true; merged; ) {
          merged = false;
          for (let i = 0; i < groups.length && !merged; i++)
            for (let j = i + 1; j < groups.length && !merged; j++) {
              const [A, Bg] = [groups[i]!, groups[j]!];
              if (A.segs.length + Bg.segs.length < 3 || len(A.all) < SHORT || len(Bg.all) < SHORT) continue;
              if (overlap(A.all, Bg.all) >= thr * Math.min(len(A.all), len(Bg.all))) {
                A.segs.push(...Bg.segs);
                A.all = { lo: Math.min(A.all.lo, Bg.all.lo), hi: Math.max(A.all.hi, Bg.all.hi) };
                groups.splice(j, 1);
                merged = true;
              }
            }
        }
      units = groups.map((gr) => unit(gr.segs));
    }
    vunits[g] = units;
    const inside = (y: number, v: V) => y > v.lo + 0.5 && y < v.hi - 0.5;
    // a left of b crosses where b's lines come in across a's vertical, or a's go out across b's.
    const cost = (a: V, b: V) => b.ins.filter((y) => inside(y, a)).length + a.outs.filter((y) => inside(y, b)).length;
    const prefs: { a: V; b: V; gain: number }[] = [];
    const clash = (a: V, b: V) => !(a.hi + 5 <= b.lo - 5 || b.hi + 5 <= a.lo - 5);
    for (let i = 0; i < units.length; i++)
      for (let j = i + 1; j < units.length; j++) {
        const [a, b] = [units[i]!, units[j]!];
        if (!clash(a, b)) continue;
        const ab = cost(a, b), ba = cost(b, a);
        // Ties: lines going down nest outside-in, so the longer drop sits further out.
        const down = (v: V) => v.outs[0]! - v.ins[0]! >= 0;
        const tie = down(a) ? (a.ins[0]! < b.ins[0]! ? 0.1 : -0.1) : a.ins[0]! > b.ins[0]! ? 0.1 : -0.1;
        prefs.push(ab < ba || (ab === ba && tie > 0) ? { a, b, gain: Math.abs(ab - ba) } : { a: b, b: a, gain: Math.abs(ab - ba) });
      }
    // Keep the strongest preferences that leave no cycle, then a track is a longest path.
    prefs.sort((x, y) => y.gain - x.gain);
    const after = new Map<V, V[]>(units.map((v) => [v, []]));
    const reaches = (from: V, to: V) => {
      const stack = [from];
      const seen = new Set<V>();
      while (stack.length) {
        const v = stack.pop()!;
        if (v === to) return true;
        if (seen.has(v)) continue;
        seen.add(v);
        stack.push(...after.get(v)!);
      }
      return false;
    };
    for (const p of prefs) if (!reaches(p.b, p.a)) after.get(p.a)!.push(p.b);
    const indeg = new Map(units.map((v) => [v, 0]));
    for (const vs of after.values()) for (const v of vs) indeg.set(v, indeg.get(v)! + 1);
    const queue = units.filter((v) => indeg.get(v) === 0);
    while (queue.length) {
      const v = queue.shift()!;
      for (const t of after.get(v)!) {
        t.track = Math.max(t.track, v.track + 1);
        indeg.set(t, indeg.get(t)! - 1);
        if (indeg.get(t) === 0) queue.push(t);
      }
    }
    // Two units on one track must not overlap: push the later one right.
    const byTrack = [...units].sort((a, b) => a.track - b.track);
    for (let i = 0; i < byTrack.length; i++)
      for (let j = 0; j < i; j++) {
        const [a, b] = [byTrack[j]!, byTrack[i]!];
        if (a.track === b.track && clash(a, b)) b.track++;
      }
    for (const v of units) for (const x of v.segs) x.track = v.track;
    const n = units.length ? Math.max(...units.map((v) => v.track)) + 1 : 0;
    trackCount[g] = n;
    trackW[g] = Array.from({ length: n }, (_, k) => Math.max(1.5, ...units.filter((v) => v.track === k).map((v) => v.thick)));
  });

  // 7. X: columns left to right; a gutter as wide as its tracks, plus the frames' padding.
  const colW = B.cols.map((col) => Math.max(0, ...col.map((it) => it.w)));
  const colX: number[] = [];
  const framed = (c: number) => sideOfCol(c) === 1 || sideOfCol(c) === 2;
  let x = PAD;
  for (let c = 0; c < nCols; c++) {
    colX[c] = x;
    x += colW[c]!;
    if (c + 1 === nCols) break;
    const crossing = sideOfCol(c) !== sideOfCol(c + 1);
    const padL = crossing && framed(c) ? FRAME_PAD : 0;
    const padR = crossing && framed(c + 1) ? FRAME_PAD : 0;
    const tw = trackW[c]!;
    const inner = tw.reduce((s, w) => s + w, 0) + Math.max(0, tw.length - 1) * TRACK;
    const width = Math.max(GUT_MIN, inner + 2 * GUT_PAD) + (crossing ? 24 : 0);
    // The tracks sit in the middle of the gutter, between the frames.
    let tx = x + padL + (width - inner) / 2;
    const xs = tw.map((w) => {
      const at = tx + w / 2;
      tx += w + TRACK;
      return at;
    });
    for (const s of gutters[c]!) s.x = s.track >= 0 && Math.abs(s.y1 - s.y2) >= 1 ? xs[s.track]! : 0;
    x += padL + width + padR;
  }

  // 8. Routes, trunks, frames.
  const at = new Map<string, P>();
  for (const it of B.items.values()) if (it.node) at.set(it.id, { x: colX[it.col]!, y: it.y });
  const routes = new Map<string, P[]>();
  for (const [key, chain] of B.chains) {
    const pts: P[] = [];
    for (let i = 0; i + 1 < chain.length; i++) {
      const [p, q] = [chain[i]!, chain[i + 1]!];
      const s = segOf.get(`${p.col}|${key}`)!;
      if (i === 0) pts.push({ x: colX[p.col]! + colW[p.col]!, y: s.y1 });
      if (Math.abs(s.y1 - s.y2) >= 1) pts.push({ x: s.x, y: s.y1 }, { x: s.x, y: s.y2 });
      if (i + 2 === chain.length) pts.push({ x: colX[q.col]!, y: s.y2 });
    }
    routes.set(key, tidy(pts));
  }
  const trunks: Trunk[] = [];
  const rides = new Map<string, string[]>();
  clusters.forEach((cl, k) => {
    const pts: P[] = [];
    for (let c = cl.from; c <= cl.to; c++) {
      const it = B.items.get(`t:${k}:${c}`);
      if (!it) continue;
      pts.push({ x: colX[c]!, y: mid(it) }, { x: colX[c]! + colW[c]!, y: mid(it) });
      if (c < cl.to) {
        const s = segOf.get(`${c}|t${k}`);
        if (s && Math.abs(s.y1 - s.y2) >= 1) pts.push({ x: s.x, y: s.y1 }, { x: s.x, y: s.y2 });
      }
    }
    if (pts.length < 2) return;
    const key = `trunk:${k}`;
    trunks.push({ key, members: cl.members, pts: tidy(pts), width: trunkWidth(cl.members.length) });
    for (const m of cl.members) rides.set(m, [...(rides.get(m) ?? []), key]);
  });
  // Vertical trunks: where two or more lines share a track, each stretch drawn as one.
  vunits.forEach((units, g) => {
    units.forEach((v, i) => {
      if (v.segs.length < 2) return;
      const x = v.segs[0]!.x;
      const cuts = [...new Set(v.segs.flatMap((sg) => [sg.y1, sg.y2]))].sort((p, q) => p - q);
      let piece: { from: number; to: number; members: string[] } | null = null;
      const flush = () => {
        if (piece && piece.members.length > 1 && piece.to - piece.from >= 1) {
          const key = `vtrunk:${g}:${i}:${Math.round(piece.from)}`;
          trunks.push({ key, members: piece.members, pts: [{ x, y: piece.from }, { x, y: piece.to }], width: trunkWidth(piece.members.length) });
          for (const m of piece.members) rides.set(m, [...(rides.get(m) ?? []), key]);
        }
        piece = null;
      };
      for (let k = 0; k + 1 < cuts.length; k++) {
        const [ya, yb] = [cuts[k]!, cuts[k + 1]!];
        const members = v.segs.filter((sg) => Math.min(sg.y1, sg.y2) <= ya + 0.5 && Math.max(sg.y1, sg.y2) >= yb - 0.5).flatMap((sg) => sg.keys);
        const same = piece && piece.members.length === members.length && piece.members.every((m) => members.includes(m));
        if (same) piece!.to = yb;
        else (flush(), (piece = { from: ya, to: yb, members }));
      }
      flush();
    });
  });
  const regions: Own["regions"] = [];
  for (const [side, key] of [[1, "C"], [2, "U"]] as const) {
    if (!sideLayers[side]) continue;
    const c0 = offset[side]!, c1 = offset[side]! + sideLayers[side]! - 1;
    let bottom = TOP;
    for (let c = c0; c <= c1; c++) for (const it of B.cols[c]!) bottom = Math.max(bottom, it.y + it.h);
    regions.push({ key, x: colX[c0]! - FRAME_PAD, y: PAD, w: colX[c1]! + colW[c1]! + FRAME_PAD - (colX[c0]! - FRAME_PAD), h: bottom + FRAME_PAD - PAD });
  }
  let height = 0;
  for (const it of B.items.values()) height = Math.max(height, it.y + it.h);
  for (const r of regions) height = Math.max(height, r.y + r.h);
  return { at, regions, routes, flipped, trunks, rides, width: x + PAD, height: height + PAD };
}

/** Drops repeated and collinear points. */
export function tidy(pts: P[]): P[] {
  const out: P[] = [];
  for (const p of pts) {
    const a = out[out.length - 1];
    if (a && Math.abs(a.x - p.x) < 0.5 && Math.abs(a.y - p.y) < 0.5) continue;
    const b = out[out.length - 2];
    if (a && b && ((Math.abs(b.x - a.x) < 0.5 && Math.abs(a.x - p.x) < 0.5) || (Math.abs(b.y - a.y) < 0.5 && Math.abs(a.y - p.y) < 0.5))) out.pop();
    out.push(p);
  }
  return out;
}

/** Weighted isotonic regression (pool adjacent violators): the non-decreasing fit closest to `t`. */
function isotonic(t: number[], w: number[]): number[] {
  const blocks: { v: number; w: number; n: number }[] = [];
  t.forEach((v, i) => {
    blocks.push({ v, w: w[i]!, n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2]!.v > blocks[blocks.length - 1]!.v) {
      const b = blocks.pop()!, a = blocks.pop()!;
      blocks.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
    }
  });
  return blocks.flatMap((b) => Array.from({ length: b.n }, () => b.v));
}

/**
 * Each orthogonal line's segments, for counting crossings and bends the same way for every
 * engine. `group` lines (a trunk's members) don't count as crossing each other.
 */
export function measure(routes: Map<string, P[]>, rides: Map<string, string[]> = new Map()) {
  type S = { k: string; h: boolean; a: number; b: number; c: number };
  const segs: S[] = [];
  let bends = 0;
  let length = 0;
  for (const [k, pts] of routes) {
    bends += Math.max(0, pts.length - 2);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [p, q] = [pts[i]!, pts[i + 1]!];
      length += Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      if (Math.abs(p.y - q.y) < 0.5) segs.push({ k, h: true, a: Math.min(p.x, q.x), b: Math.max(p.x, q.x), c: p.y });
      else if (Math.abs(p.x - q.x) < 0.5) segs.push({ k, h: false, a: Math.min(p.y, q.y), b: Math.max(p.y, q.y), c: p.x });
    }
  }
  const hs = segs.filter((s) => s.h), vs = segs.filter((s) => !s.h);
  let crossings = 0;
  const seen = new Set<string>();
  for (const h of hs)
    for (const v of vs) {
      if (h.k === v.k) continue;
      const g1 = rides.get(h.k)?.find((t) => rides.get(v.k)?.includes(t));
      if (g1) continue;
      if (v.c > h.a + 0.5 && v.c < h.b - 0.5 && h.c > v.a + 0.5 && h.c < v.b - 0.5) {
        // Lines on one trunk overlap, so a line crossing the trunk crosses it once.
        const id = `${Math.round(v.c)}|${Math.round(h.c)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        crossings++;
      }
    }
  return { crossings, bends, length: Math.round(length) };
}
