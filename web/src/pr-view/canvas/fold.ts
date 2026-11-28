// The fold plan (#183): how the canvas rolls a place's members (a purpose's parts and its
// sub-purposes', every purpose's at the PR, the unclaimed parts) up to a budget of blocks, and
// the drawing a plan and the reader's opens and folds over it make. Its rules, all here:
//
// 1. Start from the top-level parts (those the lens draws) that hold members, each one block, and
//    in each column one rest block for the top-level parts that hold none. Every block counts
//    towards the budget: the members' blocks, the rest blocks, and the Outside-the-diff column's
//    (rule 4), which holds back up to a quarter of the budget for itself.
// 2. While it stays within the budget, open the block holding the most members (the first in the
//    analysis's order on a tie): it becomes a frame round its parts that hold members, and one
//    rest block for its parts that hold none.
// 3. If there are still too many blocks, fold siblings of one kind (inside one frame, or in one
//    column at the top level) into one block, the largest set first, until it's within budget:
//    a group, "middleware in 21 services", with a breakdown line ("store 22 · middleware 21").
//    Then rule 2 again, over the blocks no group holds, so the budget the groups freed is used.
// 4. A part a conflict shown here touches that no purpose names, outside every member's block,
//    is a dashed block standing for its whole subtree, in a column of its own at the top level:
//    "Outside the diff: only through a conflict". It takes the budget the rest left, at least
//    what it held back; past that, its first parts in reading order and one "and N more" block.
//
// The plan is made once per place and lens (`planOf`), so later opens never rearrange it: the
// reader's opens and folds (a `CanvasState`, starting from `planState`) are laid over it, and so
// are the parts a pick pulls out of a rest block (`pulled`: each drawn as a block of its own in
// its frame, with the blocks it sits in). Boxes are ignored under the fold.
//
// A line is drawn between the blocks its ends are drawn in: each end rolled up to its block in the
// fold's tree, then through the blocks and groups drawn closed. One whose two ends, so rolled up,
// are both rest or Outside-the-diff blocks is dropped (but between two of the latter, it's kept).
// A folded column doesn't count for that: with the columns folded (Fold to groups), a line runs
// between them only if it would be drawn with them open, so a line from a rest block to an Outside
// block is dropped either way.
import type { Node } from "../../bindings/analysis";
import { type DrawableEdge, type DrawableGraph, type DrawableNode } from "../layout/graph";
import type { Column } from "../layout/types";
import type { Model } from "../model";
import { touched } from "./look";
import type { CanvasState, Group } from "./scene";

/** The desktop's budget of blocks (the phone's, slice 12, is 8). */
export const FOLD_BUDGET = 16;

/** The column parts outside the diff stand in, at the top level. */
export const OUTSIDE_COLUMN: Column = "conflict";
const OUT = "fold-out:";
/** The Outside column's "and N more" block. */
export const OUT_MORE = "fold-out-more";
const REST = "fold-rest:";
const GROUP = "fold:";

export const isFoldRest = (id: string) => id.startsWith(REST);
export const isFoldOut = (id: string) => id.startsWith(OUT) || id === OUT_MORE;
export const isFoldGroup = (id: string) => id.startsWith(GROUP);

/** What the plan opens (parts) and folds (sibling sets, by their group's ID), and how many outside parts it draws. */
export interface FoldPlan {
  open: ReadonlySet<string>;
  fold: ReadonlySet<string>;
  /** How many of the parts outside the diff get a block of their own; the rest share one "and N more" block. */
  outside: number;
}

/** What a plan is made from. */
export interface FoldInput {
  m: Model;
  /** The parts that serve the place. */
  members: ReadonlySet<string>;
  /** The top-level parts the lens draws, in the analysis's order. */
  tops: readonly Node[];
  /** The parts that come in only through a conflict, each with its conflict's question, in reading order. */
  outside: readonly { node: string; question: string }[];
  budget: number;
}

/** A top-level part's column, as layout A has it. */
export function columnOfTop(m: Model, n: Node): Column {
  return n.kind === "actor" ? "people" : n.kind === "external" || n.kind === "store" ? "outside" : touched(m, n.id) ? "changed" : "unchanged";
}

/** How many of each node's subtree are members, and how many parts it holds (itself included). */
function counter(m: Model, members: ReadonlySet<string>) {
  const n = new Map<string, number>();
  const total = new Map<string, number>();
  const count = (id: string): number => {
    let v = n.get(id);
    if (v === undefined) {
      v = members.has(id) ? 1 : 0;
      let t = 1;
      for (const c of m.children.get(id) ?? []) {
        v += count(c.id);
        t += total.get(c.id)!;
      }
      n.set(id, v);
      total.set(id, t);
    }
    return v;
  };
  return {
    n: count,
    total: (id: string) => (count(id), total.get(id)!),
  };
}

/** A group's ID: siblings of one kind inside `where` (a part's ID, or a column at the top). */
const groupId = (where: string, kind: string) => GROUP + JSON.stringify([where, kind]);
/** A rest block's ID: in `where`'s frame (a part's ID, or `column:<column>` at the top). */
const restId = (where: string) => REST + where;

/** The plan for `x`: rules 1 to 4. */
export function planOf(x: FoldInput): FoldPlan {
  const { m } = x;
  const { n } = counter(m, x.members);
  const kids = (id: string) => m.children.get(id) ?? [];
  const holding = (id: string) => kids(id).filter((k) => n(k.id) > 0);
  const hasRest = (id: string) => kids(id).some((k) => n(k.id) === 0);
  const tops = x.tops.filter((t) => n(t.id) > 0);
  const restColumns = new Set(x.tops.filter((t) => n(t.id) === 0).map((t) => columnOfTop(m, t))).size;
  // What the Outside column holds back: a quarter of the budget at most.
  const reserve = Math.min(x.outside.length, Math.floor(x.budget / 4));
  const open = new Set<string>();
  const fold = new Set<string>();
  /** Each member block, with the frame it sits in (a part, or its column at the top). */
  let blocks: { id: string; where: string }[] = tops.map((t) => ({ id: t.id, where: `column:${columnOfTop(m, t)}` }));
  let count = blocks.length + restColumns + reserve;
  /** The blocks a group holds: opening one wouldn't show. */
  const grouped = new Set<string>();
  /** Rule 2: the block holding the most members opened, while it stays within the budget. */
  const opens = () => {
    for (;;) {
      let best: { at: number; cost: number } | undefined;
      blocks.forEach((b, at) => {
        if (grouped.has(b.id)) return;
        const ks = holding(b.id);
        if (!ks.length) return;
        const cost = ks.length - 1 + (hasRest(b.id) ? 1 : 0);
        if (count + cost > x.budget) return;
        if (!best || n(b.id) > n(blocks[best.at]!.id)) best = { at, cost };
      });
      if (!best) return;
      const { at, cost } = best;
      const b = blocks[at]!;
      open.add(b.id);
      blocks = [...blocks.slice(0, at), ...holding(b.id).map((k) => ({ id: k.id, where: b.id })), ...blocks.slice(at + 1)];
      count += cost;
    }
  };
  opens();
  if (count > x.budget) {
    const sets = new Map<string, string[]>();
    for (const b of blocks) {
      const k = groupId(b.where, m.nodes.get(b.id)!.kind);
      sets.set(k, [...(sets.get(k) ?? []), b.id]);
    }
    // The largest set first; a tie keeps the drawing's order (a Map keeps first-seen order).
    const order = [...sets].filter(([, ids]) => ids.length > 1).sort((a, b) => b[1].length - a[1].length);
    for (const [k, ids] of order) {
      if (count <= x.budget) break;
      fold.add(k);
      for (const id of ids) grouped.add(id);
      count -= ids.length - 1;
    }
    // The budget the groups freed, opened into.
    opens();
  }
  // Rule 4: what's left, at least what it held back.
  const room = Math.max(reserve, x.budget - count + reserve);
  return { open, fold, outside: x.outside.length <= room ? x.outside.length : Math.max(0, room - 1) };
}

/** The canvas's state a plan starts from: its opens, its sibling sets folded. */
export const planState = (p: FoldPlan): CanvasState => ({ open: new Set(p.open), folded: new Set(p.fold) });

/** A drawn block of the fold that isn't one of the analysis's parts. */
export type FoldMeta =
  | { kind: "group"; group: Group; breakdown: string }
  /** A rest block, or the Outside column's "and N more" (`line`: what its parts are, in place of what they don't do). */
  | { kind: "rest"; ids: string[]; label: string; line?: string }
  | { kind: "out"; node: string; question: string };

export interface FoldDrawing {
  graph: DrawableGraph;
  /** The blocks drawn open, for the layout: the state's and its unfolded groups. */
  open: Set<string>;
  /** Each top-level block's column. */
  columns: Map<string, Column>;
  /** Each block of the fold that isn't a part, by ID. */
  meta: Map<string, FoldMeta>;
  /** The fold's groups, by ID (the Group panel reads them). */
  groups: Group[];
  /** The block in the fold's tree standing for an analysis node, or undefined (not drawn). */
  rep(node: string): string | undefined;
  /** A block's chain in the fold's tree, from its top-level block down to itself. */
  chain(id: string): string[];
  /** How many of a block's parts are members, of how many. */
  serve(id: string): { n: number; total: number } | undefined;
  /** The analysis nodes a block stands for (its subtrees). */
  stands(id: string): string[];
  /** Whether a block opens under the fold: it has blocks inside it in the fold's tree. */
  opens(id: string): boolean;
}

const KIND_PLURAL: Record<string, string> = {
  service: "services",
  app: "apps",
  library: "libraries",
  module: "modules",
  store: "stores",
  external: "outside systems",
  actor: "people",
};
const plural = (kind: string, k: number) => (k === 1 ? (kind === "actor" ? "person" : kind === "external" ? "outside system" : kind === "library" ? "library" : kind) : (KIND_PLURAL[kind] ?? `${kind}s`));

/**
 * The fold's drawing: the drawable graph the layout reads (the place's member-holding parts, the
 * parts pulled out, its groups, rest blocks and Outside column, every line rolled up to them),
 * for `state` over `plan`. `edges` are the lines the lens and the Lines menu draw.
 */
export function foldDrawing(x: FoldInput, plan: FoldPlan, state: CanvasState, edges: readonly DrawableEdge[]): FoldDrawing {
  const { m } = x;
  const { n, total } = counter(m, x.members);
  const kids = (id: string) => m.children.get(id) ?? [];
  const sys = m.system;
  const ROOT = sys?.id ?? "system";
  const nodes: DrawableNode[] = [];
  const parent = new Map<string, string>();
  const meta = new Map<string, FoldMeta>();
  const groups: Group[] = [];
  const columns = new Map<string, Column>();
  const inTree = new Set<string>();
  const restOf = new Map<string, string>();
  const topRest = new Map<Column, string>();
  // The parts outside the diff: the plan's first ones each a block, the rest in "and N more".
  const outOf = new Map(x.outside.map((o, i) => [o.node, i < plan.outside ? OUT + o.node : OUT_MORE]));
  const topCol = new Map(x.tops.map((t) => [t.id, columnOfTop(m, t)]));
  // A part a pick pulled out, and every part it sits in, is drawn as a block of its own.
  const pulled = new Set<string>();
  for (const id of state.pulled ?? []) for (const a of [id, ...m.ancestors(id)]) pulled.add(a);
  const holds = (id: string) => n(id) > 0 || pulled.has(id);
  const add = (d: DrawableNode, under: string, column?: Column) => {
    nodes.push({ ...d, parent: under });
    parent.set(d.id, under);
    if (column) columns.set(d.id, column);
  };
  const real = (k: Node, under: string, column?: Column) => {
    inTree.add(k.id);
    add({ id: k.id, kind: k.kind, name: k.name, change: k.change, paths: k.paths, facets: k.facets }, under, column);
  };
  const breakdown = (ids: readonly string[]) => {
    const tally = new Map<string, number>();
    const inside = new Set<string>();
    for (const g of ids) for (const mem of x.members) if (mem !== g && m.within(mem, g)) inside.add(mem);
    for (const mem of inside) tally.set(m.nodes.get(mem)!.name, (tally.get(m.nodes.get(mem)!.name) ?? 0) + 1);
    return [...tally].sort((a, b) => b[1] - a[1]).slice(0, 4);
  };
  /**
   * A frame's inside: its member-holding parts (siblings of one kind the plan folds in a group),
   * the parts pulled out, and one rest block for the rest. `key` names the frame for group and
   * rest IDs; `column`, at the top, the column it fills.
   */
  const frame = (under: string, key: string, list: readonly Node[], column?: Column) => {
    const holding = list.filter((k) => holds(k.id));
    const others = list.filter((k) => !holds(k.id) && !outOf.has(k.id));
    const sets = new Map<string, Node[]>();
    // A part only pulled out never joins a group.
    for (const k of holding) {
      const g = groupId(key, k.kind);
      if (plan.fold.has(g) && n(k.id) > 0) sets.set(g, [...(sets.get(g) ?? []), k]);
    }
    const made = new Set<string>();
    for (const k of holding) {
      const g = groupId(key, k.kind);
      const set = sets.get(g);
      let at = under;
      if (set && set.length > 1 && set.includes(k)) {
        if (!made.has(g)) {
          made.add(g);
          const ids = set.map((s) => s.id);
          const names = breakdown(ids);
          // "middleware in 21 services": when every member inside them has one name.
          const one = names.length === 1 && ids.every((s) => !x.members.has(s)) ? `${names[0]![0]} in ` : "";
          const title = `${one}${set.length} ${plural(k.kind, set.length)}`;
          const group: Group = { id: g, kind: "fold", column: column ?? "changed", title, by: plural(k.kind, 2), members: ids };
          groups.push(group);
          meta.set(g, { kind: "group", group, breakdown: names.map(([name, c]) => `${name} ${c}`).join(" · ") });
          add({ id: g, kind: k.kind, name: title, change: ids.some((s) => touched(m, s)) ? "modified" : "unchanged", paths: [], facets: [] }, under, column);
        }
        at = g;
      }
      real(k, at, at === under ? column : undefined);
      if (kids(k.id).some((c) => holds(c.id))) frame(k.id, k.id, kids(k.id));
    }
    if (others.length) {
      const id = restId(column ? `column:${column}` : key);
      if (column) topRest.set(column, id);
      else restOf.set(under, id);
      const kind = others.every((o) => o.kind === others[0]!.kind) ? others[0]!.kind : "part";
      const label = `${others.length} other ${kind === "part" ? (others.length === 1 ? "part" : "parts") : plural(kind, others.length)}`;
      meta.set(id, { kind: "rest", ids: others.map((o) => o.id), label });
      add({ id, kind: column === "people" ? "actor" : column === "outside" ? "external" : "module", name: label, change: column === "changed" ? "modified" : "unchanged", paths: [], facets: [] }, under, column);
    }
  };

  if (sys) nodes.push({ id: sys.id, kind: "system", name: sys.name, change: sys.change, paths: sys.paths, facets: sys.facets });
  const tops: Column[] = ["people", "changed", "unchanged", "outside"];
  for (const c of tops) frame(ROOT, `column:${c}`, x.tops.filter((t) => topCol.get(t.id) === c), c);
  x.outside.forEach((o, i) => {
    if (i >= plan.outside) return;
    const nd = m.nodes.get(o.node)!;
    add({ id: OUT + o.node, kind: nd.kind, name: nd.name, change: nd.change, paths: nd.paths, facets: nd.facets }, ROOT, OUTSIDE_COLUMN);
    meta.set(OUT + o.node, { kind: "out", node: o.node, question: o.question });
  });
  if (x.outside.length > plan.outside) {
    const ids = x.outside.slice(plan.outside).map((o) => o.node);
    const label = plan.outside ? `and ${ids.length} more` : `${ids.length} ${ids.length === 1 ? "part" : "parts"}`;
    meta.set(OUT_MORE, { kind: "rest", ids, label, line: "unchanged · reached only through a conflict" });
    add({ id: OUT_MORE, kind: "module", name: label, change: "unchanged", paths: [], facets: [] }, ROOT, OUTSIDE_COLUMN);
  }

  const sysId = sys?.id;
  const rep = (id: string): string | undefined => {
    if (!m.nodes.has(id) || id === sysId) return undefined;
    const chain = [id, ...m.ancestors(id)].filter((a) => a !== sysId);
    for (const a of chain) {
      const o = outOf.get(a);
      if (o !== undefined) return o;
    }
    for (const a of chain) {
      if (!inTree.has(a)) continue;
      return a === id ? a : (restOf.get(a) ?? a);
    }
    const col = topCol.get(chain.at(-1)!);
    return col === undefined ? undefined : topRest.get(col);
  };

  const open = new Set<string>(state.open);
  for (const g of groups) if (!state.folded.has(g.id)) open.add(g.id);
  const inner = new Set(parent.values());
  const chain = (id: string): string[] => {
    const out: string[] = [];
    for (let a: string | undefined = id; a !== undefined && a !== ROOT; a = parent.get(a)) out.unshift(a);
    return out;
  };
  /**
   * The block a fold block is drawn in, for the drop rule: itself, or the first closed block or
   * group it sits in. A folded column doesn't count: the rule is the same with the columns folded
   * (Fold to groups) as with them open.
   */
  const visible = (id: string): string => {
    const c = chain(id);
    const k = c.findIndex((b) => !(open.has(b) && inner.has(b)));
    return k < 0 ? id : c[k]!;
  };
  const drawable: DrawableEdge[] = [];
  for (const e of edges) {
    const a = rep(e.from), b = rep(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    // Dropped: between two drawn rest blocks, or a drawn rest block and an outside one.
    const va = visible(a), vb = visible(b);
    if ((isFoldRest(va) || isFoldOut(va)) && (isFoldRest(vb) || isFoldOut(vb)) && !(isFoldOut(va) && isFoldOut(vb))) continue;
    drawable.push({ ...e, from: a, to: b });
  }

  const serve = (id: string): { n: number; total: number } | undefined => {
    const md = meta.get(id);
    if (md?.kind === "group") return md.group.members.reduce((s, g) => ({ n: s.n + n(g), total: s.total + total(g) }), { n: 0, total: 0 });
    if (md) return undefined;
    return m.nodes.has(id) ? { n: n(id), total: total(id) } : undefined;
  };
  const stands = (id: string): string[] => {
    const md = meta.get(id);
    if (md?.kind === "group") return md.group.members;
    if (md?.kind === "rest") return md.ids;
    if (md?.kind === "out") return [md.node];
    return [id];
  };
  return { graph: { nodes, edges: drawable, facets: m.a.facets }, open, columns, meta, groups, rep, chain, serve, stands, opens: (id) => inner.has(id) };
}
