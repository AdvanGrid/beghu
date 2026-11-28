// What the canvas draws, as one pure step: the model, the settings and the canvas's own state
// (which blocks are open, which groups are folded) in; our layout's answer, turned into the
// drawing's items, lines and trunks, out. No DOM.
//
// - The groups: the four columns, and the boxes Boxes draws inside each column frame (own parts
//   by Folder or an `inside-*` facet; outside systems by an `outside-*` facet). A part with
//   several values goes into its column's one "Shared: N ‹facet›" box, never into each. Folder is
//   the parent directory the part's paths share, "(root)", or "(several folders)". A column or a
//   box folds into one block (the layout adapter rolls its lines up), its ID kept, so the frame
//   and the block are one item that glides between the two.
// - A partly drawn part, opened, gets a rest block after its modules: "6 folders not drawn".
// - Top-level parts with no line in the lens go to the no-lines grid under the drawing, shown
//   only when asked for.
// - Each drawn line: the analysis lines it carries, its route, and its style's facts (changed,
//   crosses a boundary, not confirmed, how many, its arrowheads).
// - Under the fold (fold.ts, #183), the drawing is the fold plan's instead: the place's
//   member-holding parts, its groups and rest blocks in layout A's columns, and the parts only a
//   conflict reaches in a column of their own, "Outside the diff: only through a conflict", with
//   no boxes and every top-level block drawn (none goes to the no-lines grid). Each block carries
//   how many of its parts serve the place and the top-level purposes it, or a part inside it,
//   serves (its dots: a rest block's are its parts'), and each line whether the place carries it.
import type { Edge, Node } from "../../bindings/analysis";
import { columnGroup, layoutInput, PART_H, PART_W, type DrawableEdge, type DrawableGraph, type DrawableNode } from "../layout/graph";
import { layout } from "../layout/layout";
import type { Column, Layout, Line, P, Rect, Scope } from "../layout/types";
import type { Model } from "../model";
import { isCode, lensDraws, shownEdges, type Settings } from "./settings";
import { foldDrawing, isFoldOut, type FoldInput, type FoldMeta, type FoldPlan } from "./fold";
import type { Place, Purposes } from "../purposes";

export const COLUMNS: readonly Column[] = ["people", "changed", "unchanged", "outside", "conflict"];

export const COLUMN_NAME: Record<Column, string> = {
  people: "People and callers",
  changed: "Changed",
  unchanged: "Unchanged",
  outside: "Outside: external systems and stores",
  conflict: "Outside the diff: only through a conflict",
};

/** A group: a block on the canvas that isn't a part (a column, a box, the Shared box, a fold of siblings). */
export interface Group {
  id: string;
  kind: "column" | "box" | "shared" | "fold";
  column: Column;
  /** Its name on the canvas ("Changed", "crates", "Shared: 2 Product area"). */
  title: string;
  /** What groups it ("Column", "Folder", the facet's name). */
  by: string;
  /** A box's facet (none for Folder and for columns). */
  facet?: string;
  /** A box's value: the value's ID, or the folder. */
  value?: string;
  /** Its top-level parts, in the analysis's order. */
  members: string[];
}

/** The parent directory a part's paths share: "(root)", or "(several folders)". */
export function folderOf(paths: readonly string[]): string | undefined {
  if (paths.length === 0) return undefined;
  const parents = new Set(paths.map((p) => {
    const q = p.replace(/\/+$/, "");
    const at = q.lastIndexOf("/");
    return at <= 0 ? "(root)" : q.slice(0, at);
  }));
  return parents.size === 1 ? [...parents][0]! : "(several folders)";
}

/** Whether a top-level part's own code, or a part inside it, changed: it stands in the changed group. */
function touchedOf(m: Model): (id: string) => boolean {
  const memo = new Map<string, boolean>();
  const t = (id: string): boolean => {
    let v = memo.get(id);
    if (v === undefined) {
      memo.set(id, false);
      v = m.nodes.get(id)?.change !== "unchanged" || (m.children.get(id) ?? []).some((c) => t(c.id));
      memo.set(id, v);
    }
    return v;
  };
  return t;
}

/** A top-level part's column, as the layout adapter decides it. */
export function columnOfNode(n: Node, touched: (id: string) => boolean): Column {
  return n.kind === "actor" ? "people" : n.kind === "external" || n.kind === "store" ? "outside" : touched(n.id) ? "changed" : "unchanged";
}

/** The top-level parts the lens and Show draw. */
export function topParts(m: Model, s: Settings, edges: readonly Edge[] = shownEdges(m, s)): Node[] {
  const sys = m.system?.id;
  const touched = touchedOf(m);
  const tops = m.a.nodes.filter((n) => n.kind !== "system" && (n.parent === undefined || n.parent === sys || !m.nodes.has(n.parent)) && lensDraws(n, s.lens));
  if (s.show === "all") return tops;
  const changed = new Set(tops.filter((n) => isCode(n) && touched(n.id)).map((n) => n.id));
  if (s.show === "changed") return tops.filter((n) => changed.has(n.id));
  // The change and what it connects to: a part a shown line joins to a changed one.
  const topOf = (id: string) => {
    const c = [id, ...m.ancestors(id)].filter((x) => x !== sys);
    return c.at(-1);
  };
  const reach = new Set(changed);
  for (const e of edges) {
    const a = topOf(e.from), b = topOf(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    if (changed.has(a)) reach.add(b);
    if (changed.has(b)) reach.add(a);
  }
  return tops.filter((n) => reach.has(n.id));
}

/** The groups the settings draw: the columns and the boxes, by ID. */
export function groupsOf(m: Model, s: Settings, tops: readonly Node[] = topParts(m, s)): { groups: Map<string, Group>; boxOf: Map<string, string> } {
  const touched = touchedOf(m);
  const groups = new Map<string, Group>();
  for (const c of COLUMNS) {
    const members = tops.filter((n) => columnOfNode(n, touched) === c).map((n) => n.id);
    if (members.length) groups.set(columnGroup(c), { id: columnGroup(c), kind: "column", column: c, title: COLUMN_NAME[c], by: "Column", members });
  }
  const boxOf = new Map<string, string>();
  for (const n of tops) {
    const column = columnOfNode(n, touched);
    const slot = column === "people" ? undefined : column === "outside" ? s.outside : s.own;
    if (slot === undefined) continue;
    let key: { kind: "box" | "shared"; value: string; title: string; by: string; facet?: string } | undefined;
    if (slot === "folder") {
      const f = folderOf(n.paths);
      if (f !== undefined) key = { kind: "box", value: f, title: f, by: "Folder" };
    } else {
      const def = m.facets.get(slot);
      const values = (n.facets.find((f) => f.facet === slot)?.values ?? []).map((v) => v.value).filter((v) => v !== "unknown");
      if (def && values.length === 1) key = { kind: "box", value: values[0]!, title: def.values.find((v) => v.id === values[0])?.label ?? values[0]!, by: def.name, facet: slot };
      else if (def && values.length > 1) key = { kind: "shared", value: "", title: "", by: def.name, facet: slot };
    }
    if (!key) continue;
    const id = key.kind === "shared" ? `box:${column}:${slot}:*shared` : `box:${column}:${slot}:${key.value}`;
    const g = groups.get(id);
    if (g) g.members.push(n.id);
    else groups.set(id, { id, kind: key.kind, column, title: key.title, by: key.by, facet: key.facet, value: key.kind === "box" ? key.value : undefined, members: [n.id] });
    boxOf.set(n.id, id);
  }
  // The Shared box's name counts the values its parts have between them.
  for (const g of groups.values()) {
    if (g.kind !== "shared") continue;
    const values = new Set<string>();
    for (const id of g.members) for (const v of m.nodes.get(id)?.facets.find((f) => f.facet === g.facet)?.values ?? []) if (v.value !== "unknown") values.add(v.value);
    g.title = `Shared: ${values.size} ${g.by}`;
  }
  return { groups, boxOf };
}

export type ItemKind = "part" | "frame" | "box" | "column" | "rest";

/** One thing drawn as a block or a frame. */
export interface Item {
  id: string;
  kind: ItemKind;
  rect: Rect;
  /** How many frames hold it (column frames and boxes included). */
  depth: number;
  /** A column or box drawn folded, as one block. */
  folded: boolean;
  /** In the no-lines grid. */
  grid: boolean;
  /** The item it's drawn inside (a frame, box or column), if any. */
  parent?: string;
  /** A part's or frame's node. */
  node?: Node;
  group?: Group;
  /** A rest block: the part it stands in, and how many folders it stands for. */
  rest?: { of: string; folders: number };
  /** Under the fold: a block that isn't one of the analysis's parts (a group, rest block, outside block or frame). */
  fold?: FoldMeta;
  /** Under the fold: how many of its parts serve the place, of how many. */
  serve?: { n: number; total: number };
  /** Under the fold: the top-level purposes it serves, or a part inside it does, in reading order. */
  dots?: string[];
  /** The analysis nodes it stands for, when not its node's or group's (a rest block's, under the fold). */
  stands?: string[];
  /** Under the fold: whether it opens (it has blocks inside it in the fold's tree). */
  opens?: boolean;
}

/** A drawn line: one per pair of drawn things, carrying all its analysis lines. */
export interface DLine {
  id: string;
  scope: string;
  members: string[];
  route: P[];
  count: number;
  changed: boolean;
  /** Crosses a boundary: any of its lines does. */
  dashed: boolean;
  /** Not confirmed: only undetermined claims back every one of its lines. */
  dotted: boolean;
  heads: { to: boolean; from: boolean };
  /** Its ends' items (undefined: a frame's port, on the frame's edge). */
  from?: string;
  to?: string;
  /** The trunks it rides. */
  trunks: string[];
  /** Under the fold: the place carries one of its lines (drawn strong, in the purpose's colour). */
  carried: boolean;
}

export interface DTrunk {
  id: string;
  points: P[];
  lines: string[];
  width: number;
  changed: boolean;
}

export interface Scene {
  items: Map<string, Item>;
  lines: Map<string, DLine>;
  trunks: DTrunk[];
  width: number;
  height: number;
  /** The answer the next layout keeps places from. */
  layout: Layout;
  /** Each analysis line's drawn lines. */
  drawnAs: Map<string, string[]>;
  /** The lines the lens and the Lines menu draw. */
  edges: Edge[];
  /** Top-level parts (or folded groups) with no line, in the grid when it's shown. */
  lonely: string[];
  /** The groups the settings draw (drawn or not). */
  groups: Map<string, Group>;
  /** Parts faded by the lens: under External connections, not on a boundary-crossing line. */
  faded: Set<string>;
  /** The no-lines grid, when shown. */
  grid?: Rect;
  /**
   * Under the fold: the place it stands on, the stood-on purpose's top-level purpose (its dot is
   * larger, its lines its colour), and the block in the fold's tree standing for each node.
   */
  fold?: { place: Place; purpose?: string; rep(node: string): string | undefined };
  /** The drawn item holding a node: itself, the block it's folded into, or nothing (not drawn). */
  holder(node: string): string | undefined;
  /**
   * The item that would hold a node with the no-lines grid shown: `holder`'s, or for a part in
   * the hidden grid, its top-level part or folded group there. What the Lines menu counts by.
   */
  wouldHold(node: string): string | undefined;
}

export interface CanvasState {
  open: ReadonlySet<string>;
  folded: ReadonlySet<string>;
  /** Under the fold: the parts a pick pulled out of a rest block, each drawn as a block of its own. */
  pulled?: ReadonlySet<string>;
}

/** The rest block's ID inside partly drawn part `id`. */
export const restId = (id: string) => `rest:${id}`;

/** What the fold draws from: the place, its plan, and what the plan was made from. */
export interface FoldArgs {
  place: Place;
  purposes: Purposes;
  input: FoldInput;
  plan: FoldPlan;
}

/** The canvas's drawing of `m` under `s` at `state`, keeping `previous`'s places; under the fold, the fold plan's. */
export function sceneOf(m: Model, s: Settings, state: CanvasState, showLonely: boolean, previous?: Layout, drawnFolders?: (n: Node) => number, fold?: FoldArgs): Scene {
  const edges = shownEdges(m, s);
  // Under the fold: no boxes, Show ignored (the rest blocks stand for what isn't drawn), nothing in the grid.
  if (fold) {
    s = { ...s, own: undefined, outside: undefined, show: "all" };
    showLonely = true;
  }
  const tops = topParts(m, s, edges);
  const { groups, boxOf } = groupsOf(m, s, tops);
  const sys = m.system;
  const keepTop = new Set(tops.map((n) => n.id));
  // The drawable graph: the system, the drawn top-level parts with everything inside them, and a
  // rest block inside each partly drawn part.
  const nodes: DrawableNode[] = [];
  const kept = new Set<string>();
  const sysId = sys?.id;
  const topOf = new Map<string, string>();
  const walk = (n: Node, top: string) => {
    kept.add(n.id);
    topOf.set(n.id, top);
    nodes.push({ id: n.id, kind: n.kind, parent: n.parent, name: n.name, change: n.change, paths: n.paths, facets: n.facets });
    for (const c of m.children.get(n.id) ?? []) if (!kept.has(c.id)) walk(c, top);
    // No rest block when every folder is drawn after all ("0 folders not drawn" says nothing).
    if (n.drawn && n.drawn.folders - (drawnFolders?.(n) ?? 0) > 0) nodes.push({ id: restId(n.id), kind: "module", parent: n.id, name: "", change: "unchanged", paths: [], facets: [] });
  };
  if (sys) nodes.push({ id: sys.id, kind: "system", name: sys.name, change: sys.change, paths: sys.paths, facets: sys.facets });
  for (const n of tops) if (keepTop.has(n.id)) walk(n, n.id);
  const drawable: DrawableEdge[] = edges.filter((e) => kept.has(e.from) && kept.has(e.to)).map((e) => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, when: e.when, change: e.change, data: e.data }));
  const g: DrawableGraph = { nodes, edges: drawable, facets: m.a.facets };
  const direction = s.lens === "data" ? (e: DrawableEdge) => e.data?.direction ?? "forward" : undefined;
  const fd = fold && foldDrawing(fold.input, fold.plan, state, edges.map((e) => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, when: e.when, change: e.change, data: e.data })));
  if (fd) {
    for (const gr of fd.groups) groups.set(gr.id, gr);
    if (fold.input.outside.length) {
      const id = columnGroup("conflict");
      groups.set(id, { id, kind: "column", column: "conflict", title: COLUMN_NAME.conflict, by: "Column", members: fold.input.outside.map((o) => o.node) });
    }
  }
  const drawn = fd
    ? layoutInput(fd.graph, { open: fd.open, folded: new Set([...state.folded].filter((x) => x.startsWith("column:"))), showLonely: true, direction, column: (n) => fd.columns.get(n.id) }, previous)
    : layoutInput(g, { open: state.open, boxes: (n) => boxOf.get(n.id), folded: state.folded, direction }, previous);
  const L = layout(drawn.input);

  // Items: every placed part, frame and box, and the column frames.
  const items = new Map<string, Item>();
  const rootId = drawn.input.root.id;
  const root = L.scopes.get(rootId);
  const colRect = new Map<Column, Rect>();
  for (const gr of root?.groups ?? []) colRect.set(gr.column, gr.rect);
  // Column frames hold the top scope's parts and boxes in their column.
  const columnOfPart = new Map<string, Column>();
  for (const p of drawn.input.root.parts) columnOfPart.set(p.id, p.column);
  for (const [box, ps] of drawn.boxes) {
    const c = columnOfPart.get(ps[0]!);
    if (c !== undefined) columnOfPart.set(box, c);
  }
  /** What an item is drawn inside: the scope it was laid out in, or at the top, its column's frame. */
  const parentOf = (id: string): string | undefined => {
    const sc = L.parts.get(id)?.scope;
    if (sc !== undefined && sc !== rootId) return sc;
    const col = columnOfPart.get(id);
    return col !== undefined && items.has(columnGroup(col)) ? columnGroup(col) : undefined;
  };
  for (const c of COLUMNS) {
    const r = colRect.get(c);
    const gr = groups.get(columnGroup(c));
    if (!r || !gr || state.folded.has(gr.id)) continue;
    items.set(gr.id, { id: gr.id, kind: "column", rect: r, depth: 0, folded: false, grid: false, group: gr });
  }
  const depthOf = (id: string): number => {
    const p = parentOf(id);
    return p === undefined || p.startsWith("column:") ? (p === undefined ? 0 : 1) : 1 + depthOf(p);
  };
  for (const [id, pl] of L.parts) {
    const parent = parentOf(id);
    const rect = { x: pl.x, y: pl.y, w: pl.w, h: pl.h };
    const depth = depthOf(id);
    const md = fd?.meta.get(id);
    if (fd && md) {
      const base = { id, rect, depth, grid: false, parent, fold: md, serve: fd.serve(id), opens: fd.opens(id) };
      if (md.kind === "group") items.set(id, { ...base, kind: pl.frame ? "frame" : "box", folded: !pl.frame, group: md.group });
      else if (md.kind === "rest") items.set(id, { ...base, kind: "rest", folded: false, stands: md.ids });
      else items.set(id, { ...base, kind: "part", folded: false, node: m.nodes.get(md.node), stands: [md.node] });
      continue;
    }
    const gr = groups.get(id);
    if (pl.box || gr) {
      items.set(id, { id, kind: gr?.kind === "column" ? "column" : "box", rect, depth, folded: !pl.box, grid: false, parent, group: gr });
      continue;
    }
    if (id.startsWith("rest:") && !m.nodes.has(id)) {
      const of = id.slice(5);
      const n = m.nodes.get(of);
      const total = n?.drawn?.folders ?? 0;
      const folders = Math.max(0, total - (n && drawnFolders ? drawnFolders(n) : 0));
      items.set(id, { id, kind: "rest", rect, depth, folded: false, grid: false, parent, rest: { of, folders } });
      continue;
    }
    const node = m.nodes.get(id);
    if (!node) continue;
    items.set(id, { id, kind: pl.frame ? "frame" : "part", rect, depth, folded: false, grid: false, parent, node, serve: fd?.serve(id), opens: fd?.opens(id) });
  }
  // Under the fold, each block's dots: the top-level purposes it, or a part inside it, serves.
  if (fold) {
    const p = fold.purposes;
    const dotsOf = (ids: readonly string[]) => {
      const on = new Set(ids.flatMap((id) => p.servedBy(id)));
      return p.tops.filter((t) => on.has(t.id)).map((t) => t.id);
    };
    for (const it of items.values()) {
      if (it.kind === "frame" || (it.kind === "column" && !it.folded)) continue;
      const ids = it.stands ?? (it.group ? it.group.members : it.node ? [it.node.id] : []);
      it.dots = dotsOf(ids);
      if (it.kind === "column" && it.group) {
        // A folded column: what its drawn blocks hold.
        const sv = it.group.members.map((t) => fd!.serve(t)).filter((x): x is { n: number; total: number } => x !== undefined);
        it.serve = sv.reduce((a, b) => ({ n: a.n + b.n, total: a.total + b.total }), { n: 0, total: 0 });
      }
    }
  }

  // The no-lines grid, under the drawing.
  let width = L.width, height = L.height;
  let grid: Rect | undefined;
  if (showLonely && drawn.lonely.length) {
    const GAP = 16, TOP = 44, PAD = 24;
    const per = Math.max(4, Math.floor((Math.max(width, 4 * (PART_W + GAP)) - 2 * PAD + GAP) / (PART_W + GAP)));
    const rows = Math.ceil(drawn.lonely.length / per);
    grid = { x: PAD - 4, y: height + 8, w: Math.min(per, drawn.lonely.length) * (PART_W + GAP) - GAP + 8, h: TOP + rows * (PART_H + GAP) - GAP + 8 };
    drawn.lonely.forEach((id, i) => {
      const rect = { x: PAD + (i % per) * (PART_W + GAP), y: grid!.y + TOP + Math.floor(i / per) * (PART_H + GAP), w: PART_W, h: PART_H };
      const gr = groups.get(id);
      const node = m.nodes.get(id);
      if (gr) items.set(id, { id, kind: gr.kind === "column" ? "column" : "box", rect, depth: 1, folded: true, grid: true, group: gr });
      else if (node) items.set(id, { id, kind: "part", rect, depth: 1, folded: false, grid: true, node });
    });
    width = Math.max(width, grid.x + grid.w + PAD);
    height = grid.y + grid.h + PAD;
  }

  // Lines: each drawn line's facts, by the analysis lines it carries.
  const ends = new Map<string, { scope: string; line: Line }>();
  const walkLines = (sc: Scope) => {
    for (const l of sc.lines) ends.set(l.id, { scope: sc.id, line: l });
    for (const p of sc.parts) if (p.frame) walkLines(p.frame);
  };
  walkLines(drawn.input.root);
  const byEdge = new Map(edges.map((e) => [e.id, e]));
  const carries = fold?.purposes.carries(fold.place);
  const unconfirmed = (e: Edge) => e.claims.length > 0 && e.claims.every((c) => m.stubs.get(c)?.status === "undetermined");
  const rides = new Map<string, string[]>();
  const trunks: DTrunk[] = L.trunks.map((t) => {
    for (const l of t.lines) rides.set(l, [...(rides.get(l) ?? []), t.id]);
    return { id: t.id, points: t.points, lines: t.lines, width: t.width, changed: t.changed };
  });
  const lines = new Map<string, DLine>();
  for (const [id, route] of L.routes) {
    const members = drawn.members.get(id) ?? [];
    const es = members.map((x) => byEdge.get(x)).filter((e): e is Edge => e !== undefined);
    const at = ends.get(id);
    const endItem = (e: Line["from"] | undefined) => (typeof e === "string" ? e : undefined);
    lines.set(id, {
      id,
      scope: at?.scope ?? "",
      members,
      route,
      count: members.length,
      changed: es.some((e) => e.change !== "unchanged"),
      dashed: es.some((e) => e.boundaries.length > 0),
      dotted: es.length > 0 && es.every(unconfirmed),
      heads: drawn.heads.get(id) ?? { to: true, from: false },
      from: endItem(at?.line.from),
      to: endItem(at?.line.to),
      trunks: rides.get(id) ?? [],
      carried: !!carries && members.some((x) => carries.has(x)),
    });
  }

  // The drawn item holding each node.
  const holderMemo = new Map<string, string | undefined>();
  const isOpenItem = (it: Item) => it.kind === "frame" || ((it.kind === "box" || it.kind === "column") && !it.folded);
  const holder = (node: string): string | undefined => {
    if (holderMemo.has(node)) return holderMemo.get(node);
    let out: string | undefined;
    const top = topOf.get(node);
    if (fd) {
      const r = fd.rep(node);
      const realTop = [node, ...m.ancestors(node)].filter((x) => x !== sysId).at(-1);
      // Its column: the Outside column for a part only a conflict reaches, else its top-level part's.
      const col = r !== undefined && isFoldOut(r) ? groups.get(columnGroup("conflict")) : realTop === undefined ? undefined : [...groups.values()].find((gr) => gr.kind === "column" && gr.column !== "conflict" && gr.members.includes(realTop));
      if (r === undefined) out = undefined;
      else if (col && items.get(col.id)?.folded) out = col.id;
      else
        for (const x of fd.chain(r)) {
          const it = items.get(x);
          if (!it) break;
          out = x;
          if (!isOpenItem(it)) break;
        }
    } else if (top !== undefined) {
      const col = [...groups.values()].find((gr) => gr.kind === "column" && gr.members.includes(top));
      const box = boxOf.get(top);
      if (col && items.get(col.id)?.folded) out = col.id;
      else if (box !== undefined && items.get(box)?.folded) out = box;
      else {
        const chain = [node, ...m.ancestors(node)].filter((x) => x !== sysId);
        for (const x of chain.reverse()) {
          const it = items.get(x);
          if (!it) break;
          out = x;
          if (it.kind === "part") break;
        }
      }
    }
    holderMemo.set(node, out);
    return out;
  };

  // External connections: parts on no boundary-crossing line fade.
  const faded = new Set<string>();
  if (s.lens === "external") {
    const on = new Set<string>();
    for (const e of edges) {
      if (e.boundaries.length === 0) continue;
      for (const end of [e.from, e.to]) for (let x = holder(end); x !== undefined; x = items.get(x)?.parent) on.add(x);
    }
    for (const it of items.values()) if ((it.kind === "part" || it.folded) && !on.has(it.id)) faded.add(it.id);
  }

  // The hidden grid's parts: each node in one is held by its top-level part, or the folded group it's in.
  const lonely = new Set(drawn.lonely);
  const touched = touchedOf(m);
  const wouldHold = (node: string): string | undefined => {
    const h = holder(node);
    if (h !== undefined || showLonely) return h;
    const top = topOf.get(node);
    if (top === undefined) return undefined;
    const box = boxOf.get(top);
    const col = columnGroup(columnOfNode(m.nodes.get(top)!, touched));
    for (const g of [col, box]) if (g !== undefined && lonely.has(g)) return g;
    return lonely.has(top) ? top : undefined;
  };

  const at = fold?.place;
  const sceneFold = at && { place: at, purpose: at.kind === "purpose" ? fold!.purposes.top(at.id) : undefined, rep: fd!.rep };
  return { items, lines, trunks, width, height, layout: L, drawnAs: drawn.drawnAs, edges, lonely: drawn.lonely, groups, faded, grid, holder, wouldHold, fold: sceneFold };
}
