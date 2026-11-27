// The adapter: an analysis's drawable graph rolled up into our layout's input for one view of
// it (which blocks are open, whether boxes are drawn). Kept apart from the engine (layout.ts),
// which knows nothing of analyses.
//
// The drawable graph is the analysis with only what a drawing needs: its nodes, lines (`edges`),
// and facets with their values. An `Analysis` is one, and so is the layout suite's committed
// synthetic graph (fixtures/pr-view/layout/, cut from the tiler's output).
//
// A line is drawn in the scope where its two ends part ways, between the two children holding
// them: one drawn line per pair, its analysis lines rolled up into its count. Inside each open
// block on its way down, it runs from the child holding its end to the block's port for the line
// above. A line between a block and its own inside isn't drawn.
import type { AppliesTo, Change, Direction, EdgeKind, NodeKind, When } from "../../bindings/analysis.ts";
import type { Box, Column, Layout, LayoutInput, Line, Part, Scope } from "./types.ts";

export interface DrawableNode {
  id: string;
  kind: NodeKind;
  parent?: string;
  name: string;
  change: Change;
  paths: string[];
  facets: { facet: string; values: { value: string }[] }[];
}

export interface DrawableEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  when: When;
  change: Change;
  data?: { direction: Direction };
}

export interface DrawableFacet {
  id: string;
  appliesTo: AppliesTo;
  multi: boolean;
  values: { id: string }[];
}

export interface DrawableGraph {
  nodes: DrawableNode[];
  edges: DrawableEdge[];
  facets: DrawableFacet[];
}

/** A part's size, closed. */
export const PART_W = 216;
export const PART_H = 74;

export interface View {
  /** The blocks drawn open (a block with no children never opens). */
  open: ReadonlySet<string>;
  /** Boxes at the top level: own parts by folder, outside systems by their first `outside-*` facet. */
  boxes?: boolean;
  /** Top-level parts with no line, which are hidden by default (#144, rule 6). */
  showLonely?: boolean;
}

export interface Drawn {
  input: LayoutInput;
  /** Each drawn line's analysis lines. */
  members: Map<string, string[]>;
  /** Each analysis line's drawn lines, from the scope it's drawn in down each side. */
  drawnAs: Map<string, string[]>;
  /** Drawn lines carrying analysis lines both ways. */
  both: Set<string>;
}

/** The layout's input for `view` of `g`, keeping `previous`'s places. */
export function layoutInput(g: DrawableGraph, view: View, previous?: Layout): Drawn {
  const system = g.nodes.find((n) => n.kind === "system");
  const ROOT = system?.id ?? "system";
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  // Each node's parent: the root for none, the system, an unknown one, or one closing a loop
  // (where the walk up from a node first comes back to itself, that step is cut).
  const parent = new Map<string, string>();
  for (const n of g.nodes) if (n !== system) parent.set(n.id, n.parent === undefined || n.parent === system?.id || !byId.has(n.parent) || n.parent === n.id ? ROOT : n.parent);
  {
    const done = new Set<string>();
    for (const n of g.nodes) {
      if (n === system) continue;
      const on = new Set<string>();
      let last = n.id;
      for (let x = n.id; x !== ROOT && !done.has(x); x = parent.get(x)!) {
        if (on.has(x)) {
          parent.set(last, ROOT);
          break;
        }
        on.add(x);
        last = x;
      }
      for (const x of on) done.add(x);
    }
  }
  const kids = new Map<string, string[]>();
  for (const [id, p] of parent) {
    const ks = kids.get(p);
    if (ks) ks.push(id);
    else kids.set(p, [id]);
  }
  const isOpen = (id: string) => view.open.has(id) && (kids.get(id)?.length ?? 0) > 0;
  const chains = new Map<string, string[]>();
  const chain = (id: string): string[] => {
    let c = chains.get(id);
    if (!c) {
      const p = parent.get(id)!;
      c = p === ROOT ? [id] : [...chain(p), id];
      chains.set(id, c);
    }
    return c;
  };
  /** The drawn node holding `id`: its chain down to the first closed block. */
  const visible = (id: string) => {
    const c = chain(id);
    const k = c.findIndex((x) => !isOpen(x));
    return k < 0 ? c : c.slice(0, k + 1);
  };

  type Drawing = { scope: string; line: Line; members: string[] };
  const lines = new Map<string, Drawing>();
  const drawnAs = new Map<string, string[]>();
  const both = new Set<string>();
  const sameEnd = (x: Line["from"], y: Line["from"]) => (typeof x === "string" ? x === y : typeof y !== "string" && x.port === y.port);
  const add = (scope: string, id: string, from: Line["from"], to: Line["to"], e: DrawableEdge) => {
    let d = lines.get(id);
    if (!d) lines.set(id, (d = { scope, line: { id, from, to, count: 0, changed: false }, members: [] }));
    else if (!sameEnd(d.line.from, from)) both.add(id);
    d.members.push(e.id);
    d.line.count++;
    d.line.changed ||= e.change !== "unchanged";
    const as = drawnAs.get(e.id);
    if (as) as.push(id);
    else drawnAs.set(e.id, [id]);
  };
  for (const e of g.edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === system?.id || e.to === system?.id) continue;
    const A = visible(e.from), B = visible(e.to);
    let k = 0;
    while (k < A.length && k < B.length && A[k] === B[k]) k++;
    // One part, or a block and its own inside: nothing to draw at this depth.
    if (k === A.length || k === B.length) continue;
    const scope = k ? A[k - 1]! : ROOT;
    const [a, b] = [A[k]!, B[k]!];
    // A drawn line's ID is the JSON of its path: its two parts at the top, then each child it
    // passes on the way down one side. Any part IDs make distinct paths, and any paths distinct
    // IDs (a part's ID may hold any separator: a purpose's holds `/`).
    const path = a < b ? [a, b] : [b, a];
    const top = JSON.stringify(path);
    add(scope, top, a, b, e);
    // Down each side: in every open block it passes, from its child to the block's port.
    for (const [side, from] of [[A, true], [B, false]] as const) {
      let above = top;
      const down = [...path];
      for (let j = k + 1; j < side.length; j++) {
        const blk = side[j - 1]!, c = side[j]!;
        down.push(c);
        const id = JSON.stringify(down);
        if (from) add(blk, id, c, { port: above }, e);
        else add(blk, id, { port: above }, c, e);
        above = id;
      }
    }
  }
  const byScope = new Map<string, Line[]>();
  for (const d of lines.values()) {
    const ls = byScope.get(d.scope);
    if (ls) ls.push(d.line);
    else byScope.set(d.scope, [d.line]);
  }

  const touched = new Map<string, boolean>();
  const isTouched = (id: string): boolean => {
    let t = touched.get(id);
    if (t === undefined) touched.set(id, (t = byId.get(id)!.change !== "unchanged" || (kids.get(id) ?? []).some(isTouched)));
    return t;
  };
  const columnOf = (n: DrawableNode): Column =>
    n.kind === "actor" ? "people" : n.kind === "external" || n.kind === "store" ? "outside" : isTouched(n.id) ? "changed" : "unchanged";

  const scopeOf = (id: string): Scope => {
    let members = kids.get(id) ?? [];
    if (id === ROOT && !view.showLonely) {
      const linked = new Set((byScope.get(ROOT) ?? []).flatMap((l) => [l.from, l.to]));
      members = members.filter((m) => linked.has(m));
    }
    const parts: Part[] = members.map((m) => {
      const n = byId.get(m)!;
      const p: Part = { id: m, w: PART_W, h: PART_H, column: id === ROOT ? columnOf(n) : "changed" };
      if (isOpen(m)) p.frame = scopeOf(m);
      return p;
    });
    const s: Scope = { id, parts, lines: byScope.get(id) ?? [] };
    if (id === ROOT && view.boxes) s.boxes = boxesOf(parts);
    return s;
  };
  const outsideFacet = g.facets.find((f) => f.id.startsWith("outside-") && f.appliesTo === "node")?.id;
  const boxesOf = (parts: Part[]): Box[] => {
    const groups = new Map<string, string[]>();
    for (const p of parts) {
      const n = byId.get(p.id)!;
      let k: string | undefined;
      if (p.column === "changed" || p.column === "unchanged") {
        const path = n.paths[0];
        k = path === undefined ? undefined : path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";
      } else if (p.column === "outside" && outsideFacet) k = n.facets.find((f) => f.facet === outsideFacet)?.values[0]?.value;
      if (k === undefined) continue;
      const id = JSON.stringify(["box", p.column, k]);
      const ps = groups.get(id);
      if (ps) ps.push(p.id);
      else groups.set(id, [p.id]);
    }
    return [...groups].filter(([, ps]) => ps.length > 1).map(([id, ps]) => ({ id, parts: ps }));
  };

  const members = new Map([...lines].map(([id, d]) => [id, d.members]));
  return { input: { root: scopeOf(ROOT), previous }, members, drawnAs, both };
}
