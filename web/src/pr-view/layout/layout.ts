// Our layout (#180): one pure function lays out every drawing in the PR view. The drawing is a
// tree of scopes (the top level, and each open block's inside), each laid out by street routing
// (scope.ts); an open block is a frame, laid out inside by the same engine, its lines leaving
// through ports on its edge (#166).
//
// Three passes:
// 1. Top down, columns only (they never depend on sizes): each port's edge, from where the line's
//    other end stands in the scope above (left of the block: the left edge).
// 2. Bottom up, the layout: each frame's inside first, giving its size and where each port sits
//    on its edge; the scope above lays the frame out as one big part with those fixed ports.
// 3. Top down, offsets: every scope's coordinates moved to the drawing's.
//
// Opening or folding a block changes no scope's lines, only the block's size, so with the last
// answer every scope is laid out from the same anchors (its drawing with every block in it
// folded): its parts where that drawing had them, pushed down by the open blocks above them, and
// its lines on that drawing's routes, so only what the changed block pushes moves (the parts below
// it, and the columns right of it), and folding it back puts them back.
//
// Boxes (group frames round some of a scope's parts) are frames too: each is laid out as a scope
// of its own, its lines crossing its edge through ports, and joined back into one route. A box
// never folds, but its folded size (its blocks folded) is what the scope's folded drawing has.
import { columnsOf, layoutScope, tidy, type SFrame, type SLine, type SOut, type SPart, type Side } from "./scope.ts";
import type { Anchors, Column, Layout, LayoutInput, Line, P, Part, Placed, Scope, ScopeLayout, Trunk } from "./types.ts";

/** Room in each gap between columns for a line's count (px). */
export const COUNT_ROOM = 30;

const SIDE: Record<Column, Side> = { people: 0, changed: 1, unchanged: 2, outside: 3 };

// Made IDs are JSON arrays, so no ID's own characters can make two of them one.
const portId = (scope: string, line: string) => JSON.stringify(["port", scope, line]);
const pieceId = (line: string, box: string, into: boolean) => JSON.stringify([line, into ? ">" : "<", box]);
const end = (scope: string, e: Line["from"]) => (typeof e === "string" ? e : portId(scope, e.port));

/** A frame as the scope above has it: its ports by the line of that scope each stands for. */
interface Frame extends SFrame {
  closed?: { w: number; h: number; ports: Map<string, number> };
}

interface Work {
  id: string;
  scope: Scope;
  inside: boolean;
  /** This scope's ports: their IDs, by the line of the scope above each stands for. */
  ports: Map<string, string>;
  out?: SOut;
}

export function layout(input: LayoutInput): Layout {
  const countRoom = input.countRoom ?? COUNT_ROOM;
  const pieces = new Map<string, string[]>();
  const boxes = new Set<string>();
  const root = unbox(input.root, pieces, boxes);

  // The scopes, parents before children.
  const work: Work[] = [];
  const frameOf = new Map<string, Part>();
  const collect = (s: Scope, id: string, inside: boolean) => {
    const ports = new Map<string, string>();
    for (const l of s.lines) for (const e of [l.from, l.to]) if (typeof e !== "string") ports.set(e.port, portId(id, e.port));
    work.push({ id, scope: s, inside, ports });
    for (const p of s.parts) if (p.frame) frameOf.set(p.id, p);
    for (const p of s.parts) if (p.frame) collect(p.frame, p.id, true);
  };
  collect(root, root.id, false);
  const lineOf = new Map<string, Line>();
  for (const w of work) for (const l of w.scope.lines) lineOf.set(l.id, l);

  /** An open block's size closed, a box's with its blocks folded: where the parts below go back to when it folds. */
  const closed = (p: Part, f?: Frame) => {
    if (!p.frame) return {};
    if (!boxes.has(p.id)) return { closedW: p.w, closedH: p.h };
    return f?.closed ? { closedW: f.closed.w, closedH: f.closed.h, closedPorts: f.closed.ports } : {};
  };
  const sParts = (w: Work, sized: (p: Part) => { w: number; h: number; ports?: Map<string, number> }, portSide: Map<string, Side>): SPart[] => [
    ...w.scope.parts.map((p) => ({ id: p.id, side: w.inside ? 1 : SIDE[p.column], port: false, ...sized(p), ...closed(p, frames.get(p.id)) })),
    ...[...w.ports.values()].map((id) => ({ id, side: portSide.get(id) ?? 3, w: 0, h: 0, port: true })),
  ];
  const sLines = (w: Work): SLine[] => w.scope.lines.map((l) => ({ id: l.id, from: end(w.id, l.from), to: end(w.id, l.to) }));

  const frames = new Map<string, Frame>();
  // 1. Columns, top down: each port's edge.
  const portSide = new Map<string, Side>();
  for (const w of work) {
    const lines = sLines(w);
    const { colOf } = columnsOf(sParts(w, (p) => p, portSide), lines, w.inside);
    for (const l of lines)
      for (const [blk, other] of [[l.from, l.to], [l.to, l.from]] as const) {
        if (!frameOf.has(blk)) continue;
        portSide.set(portId(blk, l.id), colOf.get(other)! < colOf.get(blk)! ? 0 : 3);
      }
  }

  // 2. Layout, bottom up.
  for (const w of [...work].reverse()) {
    const parts = sParts(w, (p) => frames.get(p.id) ?? p, portSide);
    // From the last answer's anchors for this scope, if they're for the same folded scope.
    const out = layoutScope(parts, sLines(w), { inside: w.inside, keep: input.previous?.anchors.get(w.id), countRoom });
    w.out = out;
    if (!out.frame) continue;
    // The frame's ports, and its folded one's, by the lines of the scope above.
    const above = (ports: Map<string, number>) => new Map([...w.ports].map(([line, id]) => [line, ports.get(id)!]));
    const folded = out.anchors.frame;
    frames.set(w.id, { ...out.frame, ports: above(out.frame.ports), closed: folded && { w: folded.w, h: folded.h, ports: above(folded.ports) } });
  }

  // 3. Offsets, top down.
  const placed = new Map<string, Placed>();
  const routes = new Map<string, P[]>();
  const trunks: Trunk[] = [];
  const scopes = new Map<string, ScopeLayout>();
  const anchors = new Map<string, Anchors>();
  const origin = new Map<string, P>([[root.id, { x: 0, y: 0 }]]);
  const pieceOf = new Map<string, string>();
  for (const [line, ps] of pieces) for (const p of ps) pieceOf.set(p, line);
  const out0 = work[0]!.out!;
  for (const w of work) {
    const out = w.out!;
    const f = frames.get(w.id);
    const o0 = origin.get(w.id)!;
    const dx = o0.x - (f?.fx ?? 0), dy = o0.y - (f?.fy ?? 0);
    const mv = (p: P): P => ({ x: p.x + dx, y: p.y + dy });
    for (const p of w.scope.parts) {
      const q = mv(out.at.get(p.id)!);
      const fc = frames.get(p.id);
      placed.set(p.id, { ...q, w: fc?.w ?? p.w, h: fc?.h ?? out.grown.get(p.id) ?? p.h, scope: w.id, frame: !!fc && !boxes.has(p.id), box: boxes.has(p.id) });
      if (fc) origin.set(p.id, q);
    }
    for (const [k, pts] of out.routes) routes.set(k, (out.flipped.has(k) ? [...pts].reverse() : pts).map(mv));
    for (const t of out.trunks) {
      const ls = [...new Set(t.lines.map((l) => pieceOf.get(l) ?? l))];
      trunks.push({ id: `${w.id}#${trunks.length}`, scope: w.id, points: t.pts.map(mv), lines: ls, width: t.width, changed: t.lines.some((l) => lineOf.get(l)?.changed) });
    }
    const rect = f ? { x: o0.x, y: o0.y, w: f.w, h: f.h } : { x: 0, y: 0, w: out.width, h: out.height };
    scopes.set(w.id, { rect, groups: out.groups.map((g) => ({ column: g.side === 1 ? "changed" : "unchanged", rect: { x: g.x + dx, y: g.y + dy, w: g.w, h: g.h } })) });
    anchors.set(w.id, out.anchors);
  }
  // A boxed line's pieces, joined into its one route.
  for (const [line, ps] of pieces) {
    const pts: P[] = [];
    for (const p of ps) pts.push(...(routes.get(p) ?? []));
    for (const p of ps) routes.delete(p);
    routes.set(line, tidy(pts));
  }
  return { parts: placed, routes, trunks, scopes, anchors, width: out0.width, height: out0.height };
}

/**
 * The scope with each box turned into a frame of its own (and its frames' insides likewise): a
 * line between two of a box's parts moves inside it; one leaving a box runs inside it from its
 * part to the box's port, then on from the box's edge. `pieces` gets each split line's pieces in
 * order, from → to.
 */
function unbox(s: Scope, pieces: Map<string, string[]>, boxIds: Set<string>): Scope {
  let parts = s.parts.map((p) => (p.frame ? { ...p, frame: unbox(p.frame, pieces, boxIds) } : p));
  if (!s.boxes?.length) return { id: s.id, parts, lines: s.lines };
  const boxOf = new Map<string, string>();
  for (const b of s.boxes) for (const m of b.parts) boxOf.set(m, b.id);
  const inner = new Map<string, { parts: Part[]; lines: Line[] }>(s.boxes.map((b) => [b.id, { parts: [], lines: [] }]));
  // A frame inside a box meets the box's piece of a line now, not the line.
  const renamed = new Map<string, Map<string, string>>();
  const rename = (part: string, from: string, to: string) => renamed.set(part, (renamed.get(part) ?? new Map()).set(from, to));
  const lines: Line[] = [];
  for (const l of s.lines) {
    const fb = typeof l.from === "string" ? boxOf.get(l.from) : undefined;
    const tb = typeof l.to === "string" ? boxOf.get(l.to) : undefined;
    if (fb !== undefined && fb === tb) {
      inner.get(fb)!.lines.push(l);
      continue;
    }
    if (fb === undefined && tb === undefined) {
      lines.push(l);
      continue;
    }
    const chain: string[] = [];
    let { from, to } = l;
    if (fb !== undefined) {
      const id = pieceId(l.id, fb, false);
      inner.get(fb)!.lines.push({ ...l, id, to: { port: l.id } });
      rename(l.from as string, l.id, id);
      chain.push(id);
      from = fb;
    }
    chain.push(l.id);
    if (tb !== undefined) {
      const id = pieceId(l.id, tb, true);
      inner.get(tb)!.lines.push({ ...l, id, from: { port: l.id } });
      rename(l.to as string, l.id, id);
      chain.push(id);
      to = tb;
    }
    lines.push({ ...l, from, to });
    pieces.set(l.id, chain);
  }
  parts = parts.map((p) => {
    const r = renamed.get(p.id);
    if (!r || !p.frame) return p;
    const port = (e: Line["from"]) => (typeof e === "string" ? e : { port: r.get(e.port) ?? e.port });
    return { ...p, frame: { ...p.frame, lines: p.frame.lines.map((l) => ({ ...l, from: port(l.from), to: port(l.to) })) } };
  });
  // Each box stands where its first part stood.
  const out: Part[] = [];
  const done = new Set<string>();
  for (const p of parts) {
    const b = boxOf.get(p.id);
    if (b === undefined) out.push(p);
    else {
      inner.get(b)!.parts.push(p);
      if (!done.has(b)) done.add(b), boxIds.add(b), out.push({ id: b, w: 0, h: 0, column: p.column, frame: { id: b, ...inner.get(b)! } });
    }
  }
  return { id: s.id, parts: out, lines };
}
