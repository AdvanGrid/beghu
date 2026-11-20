// PROTOTYPE (PR view, #166): our layout (own-layout.ts, street routing) for nested blocks. An open
// block is a frame laid out inside by the same engine, its lines leaving through the frame's edge.
//
// Each line is rolled up per scope (the drawing, or an open block): in the scope where its two ends
// part ways it joins the two children that hold them; inside each open block on the way down it
// joins the child that holds its end to a stub, a zero-size part on the frame's edge, one per line
// of the scope above. So a frame's lines fan out from one point on its edge to the parts inside.
//
// Three passes:
// 1. Top down, columns only (they never depend on sizes): which side each stub sits on, from where
//    the line's other end stands in the scope above (left of the block: the left edge).
// 2. Bottom up, the layout: each open block's inside first, giving its frame's size and where each
//    stub sits on its edge; the scope above lays the frame out as one big part with those ports.
// 3. Top down, offsets: every scope's coordinates moved to the drawing's.
//
// Opening a block changes no scope's lines, only the block's size, so with `prev` every scope keeps
// its parts where they were: only what the grown block pushes moves (down its column, and the
// columns to its right).
import { columnsOf, ownLayout, type LNode, type Opts, type P, type Trunk } from "./own-layout.ts";

export interface TNode {
  id: string;
  /** Undefined for a top-level part. */
  parent?: string;
  /** The top level's side (0 people, 1 changed, 2 unchanged, 3 outside); ignored deeper. */
  side: 0 | 1 | 2 | 3;
  w: number;
  h: number;
}
export interface TLink {
  key: string;
  from: string;
  to: string;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  open: boolean;
  depth: number;
}
/** One scope's line: between two of its children, or a child and a stub on its frame. */
export interface SLine {
  key: string;
  scope: string;
  from: string;
  to: string;
  both: boolean;
  /** The analysis lines it carries. */
  members: string[];
}
export interface Nested {
  boxes: Map<string, Box>;
  /** Each scope line's route, in the drawing's coordinates, in its real direction. */
  routes: Map<string, P[]>;
  lines: Map<string, SLine>;
  /** For each analysis line, the scope lines it is drawn as. */
  drawnAs: Map<string, string[]>;
  trunks: (Trunk & { scope: string })[];
  rides: Map<string, string[]>;
  /** The top level's Changed and Not changed frames. */
  regions: { key: "C" | "U"; x: number; y: number; w: number; h: number }[];
  width: number;
  height: number;
  /** Per scope, each child's y in that scope's own coordinates: `prev` for the next layout. */
  rel: Map<string, Map<string, number>>;
  ms: { columns: number; layout: number; scopes: number };
}

const ROOT = "";
const FRAME_PAD = 20;
const FRAME_TOP = 24; // the engine's PAD: a frame's title sits between it and the first part

/**
 * How many parts a column holds so the scope comes out about `aspect` wide to 1 high, from its
 * parts' real sizes (an open block is as big as its frame): columns × (part + gutter) ≈ aspect ×
 * rows × (part + gap). The engine's default counts parts only, so frames chained left to right
 * made a fully open drawing several times wider than high.
 */
function packWidth(ns: LNode[], aspect: number): number {
  const parts = ns.filter((n) => n.side === 1 || n.side === 2);
  if (!parts.length) return 1;
  const area = parts.reduce((a, n) => a + (n.w + 120) * (n.h + 36), 0);
  const rowH = parts.reduce((a, n) => a + n.h + 36, 0) / parts.length;
  // Side by side, the parts' area fills width × height = aspect × height²; a column is height / rowH parts.
  const height = Math.sqrt(area / aspect);
  return Math.max(1, Math.min(parts.length, Math.round(height / rowH)));
}

export function nestedLayout(nodes: TNode[], links: TLink[], open: Set<string>, o: Opts & { aspect?: number }, prev?: Nested): Nested {
  const t0 = performance.now();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, string[]>();
  for (const n of nodes) kids.set(n.parent ?? ROOT, [...(kids.get(n.parent ?? ROOT) ?? []), n.id]);
  const chainOf = new Map<string, string[]>();
  const chain = (id: string): string[] => {
    let c = chainOf.get(id);
    if (!c) {
      const n = byId.get(id)!;
      c = n.parent ? [...chain(n.parent), id] : [id];
      chainOf.set(id, c);
    }
    return c;
  };
  /** The visible part holding `id`: the first closed one on the way down. */
  const visible = (id: string) => {
    const c = chain(id);
    const k = c.findIndex((x) => !open.has(x) || !(kids.get(x)?.length));
    return c.slice(0, k < 0 ? c.length : k + 1);
  };

  // Scope lines.
  const lines = new Map<string, SLine>();
  const drawnAs = new Map<string, string[]>();
  const stubs = new Map<string, Map<string, string>>(); // scope → stub id → the line above it
  const add = (scope: string, from: string, to: string, member: string, key: string) => {
    let l = lines.get(key);
    if (!l) lines.set(key, (l = { key, scope, from, to, both: false, members: [] }));
    if (l.from !== from) l.both = true;
    l.members.push(member);
    drawnAs.set(member, [...(drawnAs.get(member) ?? []), key]);
  };
  for (const ln of links) {
    if (!byId.has(ln.from) || !byId.has(ln.to)) continue;
    const A = visible(ln.from), Bc = visible(ln.to);
    let k = 0;
    while (k < A.length && k < Bc.length && A[k] === Bc[k]) k++;
    // Same part, or a line from a block to its own inside: nothing to draw at this zoom.
    if (k === A.length || k === Bc.length) continue;
    const scope = k ? A[k - 1]! : ROOT;
    const [a, b] = [A[k]!, Bc[k]!];
    const top = `${scope}|${a < b ? `${a}↔${b}` : `${b}↔${a}`}`;
    add(scope, a, b, ln.key, top);
    // Down each side: in every open block the line passes, from its child to the block's stub.
    for (const [side, other] of [[A, "out"], [Bc, "in"]] as const) {
      let above = top;
      for (let j = k + 1; j < side.length; j++) {
        const blk = side[j - 1]!, c = side[j]!;
        const stub = `stub:${blk}:${above}`;
        if (!stubs.has(blk)) stubs.set(blk, new Map());
        stubs.get(blk)!.set(stub, above);
        const key = `${blk}|${c}~${above}`;
        if (other === "out") add(blk, c, stub, ln.key, key);
        else add(blk, stub, c, ln.key, key);
        above = key;
      }
    }
  }
  const scopeLines = new Map<string, SLine[]>();
  for (const l of lines.values()) scopeLines.set(l.scope, [...(scopeLines.get(l.scope) ?? []), l]);

  // The scopes, top down: the drawing, then every open block that shows.
  const scopes: string[] = [ROOT];
  const depth = new Map<string, number>([[ROOT, 0]]);
  for (let i = 0; i < scopes.length; i++) {
    for (const c of members(scopes[i]!)) if (open.has(c) && kids.get(c)?.length) (scopes.push(c), depth.set(c, depth.get(scopes[i]!)! + 1));
  }
  /** A scope's children: at the top level only parts with a line (the locked rule), inside a block all of them. */
  function members(scope: string): string[] {
    const ks = kids.get(scope) ?? [];
    if (scope !== ROOT) return ks;
    const linked = new Set((scopeLines.get(ROOT) ?? []).flatMap((l) => [l.from, l.to]));
    return ks.filter((k) => linked.has(k));
  }

  // 0. Each scope's packing, from its parts' sizes estimated bottom up (a frame's area is its
  // parts' with their gaps), so the columns below and the layout after agree.
  const packOf = new Map<string, number | undefined>();
  if (o.aspect) {
    const est = new Map<string, { w: number; h: number }>();
    for (const sc of [...scopes].reverse()) {
      const ns = members(sc).map((id) => ({ id, side: 1 as const, ...(est.get(id) ?? { w: byId.get(id)!.w, h: byId.get(id)!.h }) }));
      packOf.set(sc, o.width ?? packWidth(sc === ROOT ? ns.filter((n) => byId.get(n.id)!.side === 1 || byId.get(n.id)!.side === 2) : ns, o.aspect));
      if (sc === ROOT) continue;
      const area = ns.reduce((a, n) => a + (n.w + 120) * (n.h + 36), 0);
      const w = Math.sqrt(area * o.aspect);
      est.set(sc, { w, h: area / w + 60 });
    }
  }

  // 1. Columns, top down: each stub's side.
  const stubSide = new Map<string, 0 | 3>();
  const lnodes = new Map<string, LNode[]>();
  for (const s of scopes) {
    const ns: LNode[] = members(s).map((id) => ({ id, side: s === ROOT ? byId.get(id)!.side : 1, w: byId.get(id)!.w, h: byId.get(id)!.h }));
    for (const [stub] of stubs.get(s) ?? []) ns.push({ id: stub, side: stubSide.get(stub) ?? 3, w: 0, h: 0 });
    lnodes.set(s, ns);
    const ls = (scopeLines.get(s) ?? []).map((l) => ({ key: l.key, from: l.from, to: l.to }));
    const { colOf } = columnsOf(ns, ls, { ...o, width: packOf.get(s) ?? o.width, inside: s !== ROOT });
    for (const l of scopeLines.get(s) ?? []) {
      for (const [blk, other] of [[l.from, l.to], [l.to, l.from]] as const) {
        const st = stubs.get(blk);
        if (!st) continue;
        for (const [stub, above] of st) if (above === l.key) stubSide.set(stub, colOf.get(other)! < colOf.get(blk)! ? 0 : 3);
      }
    }
  }
  const t1 = performance.now();

  // 2. Layout, bottom up.
  const laid = new Map<string, ReturnType<typeof ownLayout>>();
  const frame = new Map<string, { fx: number; fy: number; w: number; h: number; ports: Map<string, number> }>();
  for (const s of [...scopes].reverse()) {
    const ns = lnodes.get(s)!.map((n) => {
      const f = frame.get(n.id);
      return f ? { ...n, w: f.w, h: f.h, ports: f.ports } : n;
    });
    const out = ownLayout(
      ns,
      (scopeLines.get(s) ?? []).map((l) => ({ key: l.key, from: l.from, to: l.to })),
      { ...o, keep: prev?.rel.get(s), width: packOf.get(s) ?? o.width, inside: s !== ROOT },
    );
    laid.set(s, out);
    if (s === ROOT) continue;
    // The frame: the stubs on its edges, the parts inside with padding, a title strip on top.
    const sizeOf = new Map(ns.map((n) => [n.id, n]));
    let x0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [id, p] of out.at) {
      const n = sizeOf.get(id)!;
      if (id.startsWith("stub:")) {
        x0 = Math.min(x0, n.side === 0 ? p.x : Infinity);
        x1 = Math.max(x1, n.side === 3 ? p.x : -Infinity);
        y1 = Math.max(y1, p.y + 12);
      } else (x0 = Math.min(x0, p.x - FRAME_PAD), (x1 = Math.max(x1, p.x + n.w + FRAME_PAD)), (y1 = Math.max(y1, p.y + n.h + FRAME_PAD)));
    }
    const fy = FRAME_TOP;
    const ports = new Map<string, number>();
    for (const [stub, above] of stubs.get(s) ?? []) {
      const p = out.at.get(stub);
      if (p) ports.set(above, p.y - fy);
    }
    frame.set(s, { fx: x0, fy, w: x1 - x0, h: y1 - fy, ports });
  }
  const t2 = performance.now();

  // 3. Offsets, top down.
  const boxes = new Map<string, Box>();
  const routes = new Map<string, P[]>();
  const trunks: Nested["trunks"] = [];
  const rides = new Map<string, string[]>();
  const rel = new Map<string, Map<string, number>>();
  const origin = new Map<string, P>([[ROOT, { x: 0, y: 0 }]]);
  for (const s of scopes) {
    const out = laid.get(s)!;
    const f = frame.get(s);
    const o0 = origin.get(s)!;
    const dx = o0.x - (f?.fx ?? 0), dy = o0.y - (f?.fy ?? 0);
    const mv = (p: P) => ({ x: p.x + dx, y: p.y + dy });
    const r = new Map<string, number>();
    for (const [id, p] of out.at) {
      if (id.startsWith("stub:")) continue;
      r.set(id, p.y);
      const fc = frame.get(id);
      const q = mv(p);
      boxes.set(id, { ...q, w: fc?.w ?? byId.get(id)!.w, h: fc?.h ?? byId.get(id)!.h, open: !!fc, depth: depth.get(s)! });
      if (fc) origin.set(id, q);
    }
    rel.set(s, r);
    for (const [k, pts] of out.routes) routes.set(k, (out.flipped.has(k) ? [...pts].reverse() : pts).map(mv));
    for (const t of out.trunks) {
      const key = `${s}#${t.key}`;
      trunks.push({ ...t, key, scope: s, pts: t.pts.map(mv) });
    }
    for (const [k, ts] of out.rides) rides.set(k, ts.map((t) => `${s}#${t}`));
  }
  const root = laid.get(ROOT)!;
  return {
    boxes,
    routes,
    lines,
    drawnAs,
    trunks,
    rides,
    regions: root.regions,
    width: root.width,
    height: root.height,
    rel,
    ms: { columns: t1 - t0, layout: t2 - t1, scopes: scopes.length },
  };
}
