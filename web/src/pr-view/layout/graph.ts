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
import type { Column, Layout, LayoutInput, Line, Part, Scope } from "./types.ts";

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

/** A top-level part's box: the box's ID (unique in the drawing), or undefined for none. */
export type BoxOf = (n: DrawableNode, column: Column) => string | undefined;

export interface View {
  /** The blocks drawn open (a block with no children never opens). */
  open: ReadonlySet<string>;
  /**
   * Boxes at the top level. `true`: own parts by their first path's first folder, outside systems
   * by their first `outside-*` facet, a box only where two or more parts share it. A function:
   * each top-level part's box (the Boxes picker's), a box of one part too.
   */
  boxes?: boolean | BoxOf;
  /** Top-level parts with no line, which are hidden by default (#144, rule 6). */
  showLonely?: boolean;
  /**
   * Groups drawn folded, each as one closed block standing for its parts, in their column: a
   * column (`columnGroup(column)`) or a box (its ID). Lines roll up to it as to a folded part.
   * A folded column's boxes fold with it.
   */
  folded?: ReadonlySet<string>;
  /**
   * Which way each line's arrow points: `forward` (the default) from `from` to `to`, `back` the
   * other way (the Data flow lens: the data's direction), `both` each way.
   */
  direction?: (e: DrawableEdge) => Direction;
}

/** A column's ID as a folded group (`View.folded`): `column:changed`. */
export const columnGroup = (c: Column) => `column:${c}`;

export interface Drawn {
  input: LayoutInput;
  /** Each drawn line's analysis lines. */
  members: Map<string, string[]>;
  /** Each analysis line's drawn lines, from the scope it's drawn in down each side. */
  drawnAs: Map<string, string[]>;
  /** Drawn lines carrying analysis lines both ways. */
  both: Set<string>;
  /** Each drawn line's arrowheads: at its `to` end, at its `from` end (`View.direction`). */
  heads: Map<string, { to: boolean; from: boolean }>;
  /** The boxes drawn open at the top level: each one's parts, in the drawing's order. */
  boxes: Map<string, string[]>;
  /** The folded groups drawn: each one's top-level parts. */
  groups: Map<string, string[]>;
  /** Top-level parts (or folded groups) left out for having no line (`showLonely` off). */
  lonely: string[];
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
  const touched = new Map<string, boolean>();
  const isTouched = (id: string): boolean => {
    let t = touched.get(id);
    if (t === undefined) touched.set(id, (t = byId.get(id)!.change !== "unchanged" || (kids.get(id) ?? []).some(isTouched)));
    return t;
  };
  const columnOf = (n: DrawableNode): Column =>
    n.kind === "actor" ? "people" : n.kind === "external" || n.kind === "store" ? "outside" : isTouched(n.id) ? "changed" : "unchanged";

  // Each top-level part's box, and the folded group standing for it, if any.
  const boxFn: BoxOf | undefined = typeof view.boxes === "function" ? view.boxes : view.boxes ? defaultBoxes(g.facets) : undefined;
  const boxOfTop = new Map<string, string>();
  if (boxFn) for (const m of kids.get(ROOT) ?? []) {
    const n = byId.get(m)!;
    const b = boxFn(n, columnOf(n));
    if (b !== undefined) boxOfTop.set(m, b);
  }
  const holderOf = new Map<string, string>();
  const groups = new Map<string, string[]>();
  if (view.folded?.size)
    for (const m of kids.get(ROOT) ?? []) {
      const col = columnGroup(columnOf(byId.get(m)!));
      const box = boxOfTop.get(m);
      const h = view.folded.has(col) ? col : box !== undefined && view.folded.has(box) ? box : undefined;
      if (h === undefined) continue;
      holderOf.set(m, h);
      const ms = groups.get(h);
      if (ms) ms.push(m);
      else groups.set(h, [m]);
    }

  /** The drawn node holding `id`: its chain down to the first closed block (a folded group at the top). */
  const visible = (id: string) => {
    const c = chain(id);
    const h = holderOf.get(c[0]!);
    if (h !== undefined) return [h];
    const k = c.findIndex((x) => !isOpen(x));
    return k < 0 ? c : c.slice(0, k + 1);
  };

  type Drawing = { scope: string; line: Line; members: string[] };
  const lines = new Map<string, Drawing>();
  const drawnAs = new Map<string, string[]>();
  const both = new Set<string>();
  const heads = new Map<string, { to: boolean; from: boolean }>();
  const sameEnd = (x: Line["from"], y: Line["from"]) => (typeof x === "string" ? x === y : typeof y !== "string" && x.port === y.port);
  const add = (scope: string, id: string, from: Line["from"], to: Line["to"], e: DrawableEdge) => {
    let d = lines.get(id);
    if (!d) lines.set(id, (d = { scope, line: { id, from, to, count: 0, changed: false }, members: [] }));
    else if (!sameEnd(d.line.from, from)) both.add(id);
    // The arrow: toward the end the line points to, as this drawn line runs.
    const way = view.direction?.(e) ?? "forward";
    const along = sameEnd(d.line.from, from);
    const h = heads.get(id) ?? { to: false, from: false };
    if (way === "both") (h.to = true), (h.from = true);
    else if ((way === "forward") === along) h.to = true;
    else h.from = true;
    heads.set(id, h);
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

  const lonely: string[] = [];
  const drawnBoxes = new Map<string, string[]>();
  const scopeOf = (id: string): Scope => {
    let members = kids.get(id) ?? [];
    if (id === ROOT) {
      // A folded group stands where its first part would.
      const seen = new Set<string>();
      members = members.flatMap((m) => {
        const h = holderOf.get(m) ?? m;
        if (seen.has(h)) return [];
        seen.add(h);
        return [h];
      });
      if (!view.showLonely) {
        const linked = new Set((byScope.get(ROOT) ?? []).flatMap((l) => [l.from, l.to]));
        lonely.push(...members.filter((m) => !linked.has(m)));
        members = members.filter((m) => linked.has(m));
      }
    }
    const parts: Part[] = members.map((m) => {
      const ms = groups.get(m);
      if (ms) return { id: m, w: PART_W, h: PART_H, column: columnOf(byId.get(ms[0]!)!) };
      const n = byId.get(m)!;
      const p: Part = { id: m, w: PART_W, h: PART_H, column: id === ROOT ? columnOf(n) : "changed" };
      if (isOpen(m)) p.frame = scopeOf(m);
      return p;
    });
    const s: Scope = { id, parts, lines: byScope.get(id) ?? [] };
    if (id === ROOT && boxOfTop.size) {
      for (const p of parts) {
        const b = boxOfTop.get(p.id);
        if (b === undefined || groups.has(p.id)) continue;
        const ps = drawnBoxes.get(b);
        if (ps) ps.push(p.id);
        else drawnBoxes.set(b, [p.id]);
      }
      // The defaults draw a box only where two or more drawn parts share it.
      if (view.boxes === true) for (const [bid, ps] of drawnBoxes) if (ps.length < 2) drawnBoxes.delete(bid);
      s.boxes = [...drawnBoxes].map(([bid, ps]) => ({ id: bid, parts: ps }));
    }
    return s;
  };

  const root = scopeOf(ROOT);
  const members = new Map([...lines].map(([id, d]) => [id, d.members]));
  return { input: { root, previous }, members, drawnAs, both, heads, boxes: drawnBoxes, groups, lonely };
}

/** The defaults' boxes (`View.boxes` true): own parts by their first path's first folder, outside systems by `outsideBoxFacet`. */
function defaultBoxes(facets: DrawableGraph["facets"]): BoxOf {
  const outsideFacet = outsideBoxFacet(facets);
  return (n, column) => {
    let k: string | undefined;
    if (column === "changed" || column === "unchanged") {
      const path = n.paths[0];
      k = path === undefined ? undefined : path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";
    } else if (column === "outside" && outsideFacet) k = n.facets.find((f) => f.facet === outsideFacet)?.values[0]?.value;
    return k === undefined ? undefined : JSON.stringify(["box", column, k]);
  };
}

/**
 * The facet that boxes outside systems at the top level by default (Boxes' outside slot, empty):
 * the first `outside-*` facet for nodes, the required "What it does for this system".
 */
export function outsideBoxFacet(facets: readonly { id: string; appliesTo: AppliesTo }[]): string | undefined {
  return facets.find((f) => f.id.startsWith("outside-") && f.appliesTo === "node")?.id;
}
