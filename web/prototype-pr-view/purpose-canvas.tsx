// PROTOTYPE (PR view, #160): showing a purpose on the canvas. Four canvases, switched with ?pc=A|B|C|D
// (or ← → in the bottom bar); ?pc=0 is the code view with the walkthrough's fading only. Each runs
// where the walkthrough panel stands: the whole PR (nothing picked) or a purpose. Picking a part keeps
// the canvas; "Code view ›" (or a double-click) goes to the code view at that part, and "← Back to
// ‹purpose›" returns.
//   A — Purpose groups: a fourth view. Purposes are boxes, opened into sub-purposes, then parts.
//   B — Fold the rest: the code view, with everything the purpose doesn't touch folded into stubs.
//   C — Journey line: the purpose's stops left to right, other purposes crossing where they share parts.
//   D — Purpose × area map: purposes down, top-level parts across, counts in the cells.
// All four roll a purpose's parts up to a budget of blocks ("store · 21 of 24 modules"), so a purpose
// of hundreds of parts reads as a dozen blocks; a block opens in place.
import { createMemo, createSignal, For, Show } from "solid-js";
import * as stylex from "@stylexjs/stylex";
import { colors, fonts } from "../src/tokens.stylex.ts";
import { pal } from "./tokens.stylex.ts";
import { layout, NODE_H, NODE_W, type Laid } from "./layout.ts";
import type { Model } from "./model.ts";
import type { Change, Node } from "./schema.ts";
import type { Conflict, Purpose, Purposes } from "./purpose.ts";
import type { WSel } from "./walkthrough.tsx";

const sws = stylex.create({
  c0: { backgroundColor: pal.c0 },
  c1: { backgroundColor: pal.c1 },
  c2: { backgroundColor: pal.c2 },
  c3: { backgroundColor: pal.c3 },
  c4: { backgroundColor: pal.c4 },
  c5: { backgroundColor: pal.c5 },
  c6: { backgroundColor: pal.c6 },
  c7: { backgroundColor: pal.c7 },
});
const fills = stylex.create({
  c0: { fill: pal.c0 },
  c1: { fill: pal.c1 },
  c2: { fill: pal.c2 },
  c3: { fill: pal.c3 },
  c4: { fill: pal.c4 },
  c5: { fill: pal.c5 },
  c6: { fill: pal.c6 },
  c7: { fill: pal.c7 },
});
const strokes = stylex.create({
  c0: { stroke: pal.c0 },
  c1: { stroke: pal.c1 },
  c2: { stroke: pal.c2 },
  c3: { stroke: pal.c3 },
  c4: { stroke: pal.c4 },
  c5: { stroke: pal.c5 },
  c6: { stroke: pal.c6 },
  c7: { stroke: pal.c7 },
});
const borders = stylex.create({
  c0: { borderColor: pal.c0 },
  c1: { borderColor: pal.c1 },
  c2: { borderColor: pal.c2 },
  c3: { borderColor: pal.c3 },
  c4: { borderColor: pal.c4 },
  c5: { borderColor: pal.c5 },
  c6: { borderColor: pal.c6 },
  c7: { borderColor: pal.c7 },
});
const rails = stylex.create({
  c0: { backgroundColor: pal.c0 },
  c1: { backgroundColor: pal.c1 },
  c2: { backgroundColor: pal.c2 },
  c3: { backgroundColor: pal.c3 },
  c4: { backgroundColor: pal.c4 },
  c5: { backgroundColor: pal.c5 },
  c6: { backgroundColor: pal.c6 },
  c7: { backgroundColor: pal.c7 },
});
const changeFill = stylex.create({
  added: { fill: pal.added },
  removed: { fill: pal.removed },
  modified: { fill: pal.modified },
  unchanged: { fill: pal.unchanged },
});
const changeBg = stylex.create({
  added: { backgroundColor: pal.added },
  removed: { backgroundColor: pal.removed },
  modified: { backgroundColor: pal.modified },
  unchanged: { backgroundColor: pal.unchanged },
});

const s = stylex.create({
  wrap: { color: colors.fg, fontFamily: fonts.ui, fontSize: 13, minHeight: "100%" },
  head: { alignItems: "center", backgroundColor: colors.bg, borderBottomColor: colors.line, borderBottomStyle: "solid", borderBottomWidth: 1, display: "flex", flexWrap: "wrap", gap: 6, left: 0, paddingBlock: 8, paddingInline: 12, position: "sticky", top: 0, zIndex: 2 },
  crumb: { alignItems: "center", backgroundColor: "transparent", borderStyle: "none", color: colors.accent, cursor: "pointer", display: "inline-flex", font: "inherit", gap: 4, padding: 0 },
  crumbOn: { color: colors.fg, fontWeight: 700 },
  codeBtn: { backgroundColor: colors.bgRaised, borderColor: colors.line, borderRadius: 6, borderStyle: "solid", borderWidth: 1, color: colors.fg, cursor: "pointer", font: "inherit", marginInlineStart: "auto", paddingBlock: 3, paddingInline: 8 },
  muted: { color: colors.muted },
  small: { fontSize: 12 },
  warn: { color: colors.warn },
  pad: { padding: 16 },
  click: { cursor: "pointer" },
  faded: { opacity: 0.25 },
  dot: { borderRadius: 999, display: "inline-block", flexShrink: 0, height: 8, verticalAlign: "middle", width: 8 },
  dotBig: { height: 11, width: 11 },
  dots: { display: "inline-flex", gap: 3, marginInlineStart: 6, verticalAlign: "middle" },
  // Scene
  svg: { display: "block" },
  box: { fill: colors.bgRaised, stroke: colors.line, strokeWidth: 2 },
  boxDashed: { stroke: colors.muted, strokeDasharray: "6 4" },
  boxTitle: { fill: colors.fg, fontFamily: fonts.ui, fontSize: 14, fontWeight: 700 },
  line: { fill: "none", strokeWidth: 2 },
  lineStrong: { stroke: colors.fg },
  lineWeak: { stroke: colors.line, strokeWidth: 1.2 },
  head2: { stroke: "none" },
  fillStrong: { fill: colors.fg },
  fillWeak: { fill: colors.line },
  block: { fill: pal.nodeBg, stroke: colors.muted, strokeWidth: 1.2 },
  blockRest: { fill: pal.contextBg, stroke: colors.line, strokeDasharray: "4 3" },
  blockOutside: { fill: pal.contextBg, stroke: colors.warn, strokeDasharray: "5 3", strokeWidth: 1.8 },
  blockSel: { stroke: colors.accent, strokeWidth: 3 },
  t1: { fill: colors.fg, fontFamily: fonts.ui, fontSize: 13, fontWeight: 600, pointerEvents: "none" },
  t2: { fill: colors.muted, fontFamily: fonts.ui, fontSize: 11, pointerEvents: "none" },
  tMuted: { fill: colors.muted, fontWeight: 500 },
  // A at the PR
  cards: { alignItems: "start", display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", padding: 16 },
  card: { backgroundColor: colors.bg, borderLeftWidth: 5, borderRadius: 10, borderStyle: "solid", borderWidth: 1, display: "flex", flexDirection: "column", gap: 8, padding: 12 },
  cardHead: { alignItems: "center", backgroundColor: "transparent", borderStyle: "none", color: colors.fg, cursor: "pointer", display: "flex", flexWrap: "wrap", font: "inherit", gap: 6, padding: 0, textAlign: "start" },
  cardOutside: { borderColor: colors.warn, borderStyle: "dashed" },
  subBox: { backgroundColor: colors.bgRaised, borderRadius: 7, display: "flex", flexDirection: "column", gap: 5, padding: 8 },
  subHead: { backgroundColor: "transparent", borderStyle: "none", color: colors.fg, cursor: "pointer", font: "inherit", fontWeight: 600, padding: 0, textAlign: "start" },
  share: { display: "inline-flex", alignItems: "center", gap: 3, marginInlineEnd: 8 },
  chips: { display: "flex", flexWrap: "wrap", gap: 4 },
  chip: { alignItems: "center", backgroundColor: colors.bg, borderColor: colors.line, borderRadius: 6, borderStyle: "solid", borderWidth: 1, color: colors.fg, cursor: "pointer", display: "inline-flex", font: "inherit", fontSize: 12, gap: 4, paddingBlock: 2, paddingInline: 6 },
  chipGroup: { borderStyle: "dashed", fontWeight: 600 },
  chipSel: { borderColor: colors.accent, boxShadow: `0 0 0 1px ${colors.accent}` },
  chipOutside: { borderColor: colors.warn, borderStyle: "dashed" },
  bar: { borderRadius: 2, display: "inline-block", height: 12, width: 3 },
  // C
  journey: { overflowX: "auto", padding: 16 },
  track: { display: "flex", gap: 0 },
  station: { display: "flex", flexDirection: "column", gap: 6, minWidth: 230, paddingInlineEnd: 18, position: "relative", width: 230 },
  rail: { height: 6, left: 0, position: "absolute", right: 0, top: 13 },
  stop: { backgroundColor: colors.bg, borderRadius: 999, borderStyle: "solid", borderWidth: 4, color: colors.fg, cursor: "pointer", font: "inherit", fontWeight: 700, height: 32, position: "relative", width: 32, zIndex: 1 },
  stopBig: { borderWidth: 6 },
  stationName: { fontWeight: 700 },
  crossings: { display: "flex", flexDirection: "column", gap: 3 },
  cross: { alignItems: "center", backgroundColor: colors.bg, borderRadius: 6, borderStyle: "solid", borderWidth: 1, color: colors.fg, cursor: "pointer", display: "flex", font: "inherit", fontSize: 12, gap: 4, paddingBlock: 2, paddingInline: 6, textAlign: "start" },
  branch: { borderInlineStartColor: colors.warn, borderInlineStartStyle: "dashed", borderInlineStartWidth: 2, display: "flex", flexDirection: "column", gap: 4, marginBlockStart: 6, paddingInlineStart: 10 },
  metro: { display: "flex", flexDirection: "column", gap: 18, padding: 16 },
  metroRow: { alignItems: "start", display: "flex", gap: 12 },
  metroName: { backgroundColor: "transparent", borderStyle: "none", color: colors.fg, cursor: "pointer", flexShrink: 0, font: "inherit", fontWeight: 700, padding: 0, textAlign: "start", width: 220 },
  metroLine: { display: "flex", position: "relative" },
  metroRail: { height: 5, left: 20, position: "absolute", right: 20, top: 10 },
  metroStop: { alignItems: "center", display: "flex", flexDirection: "column", gap: 3, position: "relative", width: 130 },
  metroDot: { backgroundColor: colors.bg, borderRadius: 999, borderStyle: "solid", borderWidth: 4, cursor: "pointer", height: 24, padding: 0, width: 24, zIndex: 1 },
  interchange: { boxShadow: `0 0 0 3px ${colors.bg}, 0 0 0 5px ${colors.fg}` },
  metroLabel: { fontSize: 11.5, textAlign: "center" },
  // D
  mapWrap: { display: "flex", flexDirection: "column", gap: 8, padding: 12 },
  mapScroll: { overflow: "auto" },
  table: { borderCollapse: "collapse" },
  th: { borderBottomColor: colors.line, borderBottomStyle: "solid", borderBottomWidth: 1, fontWeight: 500, height: 150, padding: 0, verticalAlign: "bottom" },
  corner: { width: 240 },
  colHead: { backgroundColor: "transparent", borderStyle: "none", color: colors.fg, cursor: "pointer", font: "inherit", fontSize: 11.5, padding: 2, width: 30 },
  vert: { display: "inline-block", textAlign: "start", whiteSpace: "nowrap", writingMode: "vertical-rl", transform: "rotate(180deg)" },
  rowHead: { backgroundColor: colors.bg, borderInlineEndColor: colors.line, borderInlineEndStyle: "solid", borderInlineEndWidth: 1, fontWeight: 500, left: 0, position: "sticky", textAlign: "start", whiteSpace: "nowrap" },
  rowOn: { backgroundColor: colors.selected, fontWeight: 700 },
  rowBtn: { alignItems: "center", backgroundColor: "transparent", borderStyle: "none", color: colors.fg, cursor: "pointer", display: "flex", font: "inherit", gap: 5, paddingBlock: 4, paddingInlineEnd: 8, paddingInlineStart: "calc(6px + var(--indent))" },
  td: { borderColor: colors.line, borderStyle: "solid", borderWidth: 1, cursor: "pointer", height: 28, minWidth: 30, padding: 0, position: "relative", textAlign: "center", width: 30 },
  tdSel: { outlineColor: colors.accent, outlineStyle: "solid", outlineWidth: 2 },
  tdOut: { borderColor: colors.warn, borderStyle: "dashed" },
  tdLit: { boxShadow: `inset 0 0 0 2px ${colors.fg}` },
  heat: { inset: 0, opacity: "var(--heat)", position: "absolute" },
  count: { fontSize: 11, fontWeight: 600, position: "relative" },
  warnMark: { color: colors.warn, fontSize: 10, position: "absolute", right: 1, top: -1 },
  cellList: { backgroundColor: colors.bgRaised, borderRadius: 8, display: "flex", flexDirection: "column", gap: 6, padding: 10 },
  linkBtn: { backgroundColor: "transparent", borderStyle: "none", color: colors.accent, cursor: "pointer", font: "inherit", marginInlineStart: 10 },
});

export const PC_VARIANTS = [
  { key: "0", name: "Code view, fading only (#159)" },
  { key: "A", name: "Purpose groups: a fourth view" },
  { key: "B", name: "Fold the rest: the code view, folded" },
  { key: "C", name: "Journey line: stops in order" },
  { key: "D", name: "Purpose × area map" },
] as const;
export type PcKey = (typeof PC_VARIANTS)[number]["key"];

export interface PCtx {
  m: Model;
  p: Purposes;
  sel: () => WSel;
  pick: (x: WSel) => void;
  /** The purpose the canvas shows (null: the whole PR). */
  at: () => string | null;
  /** What the panel lights (a hovered stop, row or conflict). */
  spot: () => { nodes: string[]; edges: string[] } | null;
  /** Leave for the code view at a part. */
  openCode: (node: string) => void;
}

// ---------------------------------------------------------------------------------------------
// The crossing, worked out once: who serves what, and roll-ups.

const SW = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"] as const;
type Sw = (typeof SW)[number];

class PData {
  readonly root: string | null;
  readonly tops: string[];
  private readonly size = new Map<string, number>();
  constructor(
    readonly m: Model,
    readonly p: Purposes,
  ) {
    const roots = m.children.get(null) ?? [];
    this.root = roots.length === 1 ? roots[0]!.id : null;
    this.tops = (this.root ? (m.children.get(this.root) ?? []) : roots).map((n) => n.id);
  }
  kids(id: string): Node[] {
    return this.m.children.get(id) ?? [];
  }
  total(id: string): number {
    let n = this.size.get(id);
    if (n === undefined) {
      n = 1 + this.kids(id).reduce((a, k) => a + this.total(k.id), 0);
      this.size.set(id, n);
    }
    return n;
  }
  /** id and its ancestors, innermost first. */
  up(id: string): string[] {
    const out: string[] = [];
    for (let x: string | undefined = id; x; x = this.m.nodes.get(x)?.parent) out.push(x);
    return out;
  }
  topOf(id: string): string {
    const u = this.up(id);
    return u.find((x) => this.tops.includes(x)) ?? u[u.length - 1]!;
  }
  purpose(id: string): Purpose {
    return this.p.purposes.find((x) => x.id === id)!;
  }
  subs(id: string | null): Purpose[] {
    return this.p.purposes.filter((x) => (x.parent ?? null) === id);
  }
  tree(id: string): string[] {
    return [id, ...this.subs(id).flatMap((x) => this.tree(x.id))];
  }
  topPurpose(id: string): string {
    let q = this.purpose(id);
    while (q.parent) q = this.purpose(q.parent);
    return q.id;
  }
  sw(pid: string): Sw {
    const i = this.subs(null).findIndex((x) => x.id === this.topPurpose(pid));
    return SW[(i < 0 ? 0 : i) % SW.length]!;
  }
  /** Parts a purpose names itself (not its sub-purposes). */
  direct(pid: string): string[] {
    const q = this.purpose(pid);
    return [...new Set([...q.serves.map((s) => s.node), ...q.stops.filter((s) => s.kind === "node").map((s) => s.id)])].filter((id) => this.m.nodes.has(id));
  }
  nodes(pid: string): Set<string> {
    return new Set(this.tree(pid).flatMap((x) => this.direct(x)));
  }
  edges(pid: string): Set<string> {
    const ps = this.tree(pid).map((x) => this.purpose(x));
    return new Set(ps.flatMap((q) => [...q.edges.map((e) => e.edge), ...q.stops.filter((s) => s.kind === "edge").map((s) => s.id)]).filter((id) => this.m.edges.has(id)));
  }
  /** Top-level purposes a part serves: it, a part inside it, or a part it sits in. */
  servedBy(id: string): string[] {
    const inside = (x: string) => this.up(x).includes(id) || this.up(id).includes(x);
    return this.subs(null)
      .filter((q) => [...this.nodes(q.id)].some(inside))
      .map((q) => q.id);
  }
  conflicts(pid: string | null): Conflict[] {
    if (!pid) return this.p.conflicts;
    const t = new Set(this.tree(pid));
    return this.p.conflicts.filter((c) => c.touches.purposes.some((x) => t.has(x)));
  }
  /** Parts that come in only through a conflict: no purpose names them. */
  outside(pid: string | null): { node: string; conflict: Conflict }[] {
    const all = new Set(this.p.purposes.flatMap((q) => this.direct(q.id)));
    return this.conflicts(pid).flatMap((c) => c.touches.nodes.filter((n) => this.m.nodes.has(n) && !all.has(n)).map((node) => ({ node, conflict: c })));
  }
  change(id: string): Change {
    return this.m.nodes.get(id)?.change ?? "unchanged";
  }
  name(id: string): string {
    return this.m.nodes.get(id)?.name ?? id;
  }
  /** "orders › store" for a part below the top level. */
  path(id: string): string {
    const u = this.up(id).reverse().filter((x) => x !== this.root);
    return u.map((x) => this.name(x)).join(" › ");
  }
}

export interface Block {
  id: string;
  /** Parts inside it (itself included) that serve the purpose. */
  n: number;
  total: number;
  /** A fold of parts that don't serve it: "8 other services". */
  rest?: { label: string; ids: string[] };
  /** A fold of sibling blocks of one kind, when there are too many: "middleware in 21 services". */
  group?: { label: string; ids: string[]; inside: string };
}

/**
 * Rolls a set of parts up to at most `budget` blocks: start at the top level, then open the block
 * holding the most members while the count stays within budget. `opened` blocks always open.
 * With `rest`, the parts that hold no member are folded too, one fold per parent (and per kind at
 * the top level).
 */
function rollup(d: PData, members: Set<string>, budget: number, opened: Set<string>, rest = false): Block[] {
  const count = (id: string): number => (members.has(id) ? 1 : 0) + d.kids(id).reduce((a, k) => a + count(k.id), 0);
  const memo = new Map<string, number>();
  const n = (id: string) => (memo.has(id) ? memo.get(id)! : (memo.set(id, count(id)), memo.get(id)!));
  let blocks: string[] = d.tops.filter((t) => n(t) > 0);
  const open = (b: string) => d.kids(b).filter((k) => n(k.id) > 0).map((k) => k.id);
  for (;;) {
    let best: string | null = null;
    for (const b of blocks) {
      const ks = open(b);
      if (ks.length === 0) continue;
      if (opened.has(b)) {
        best = b;
        break;
      }
      if (blocks.length - 1 + ks.length > budget) continue;
      if (!best || n(b) > n(best)) best = b;
    }
    if (!best) break;
    const i = blocks.indexOf(best);
    blocks = [...blocks.slice(0, i), ...open(best), ...blocks.slice(i + 1)];
  }
  let out: Block[] = blocks.map((id) => ({ id, n: n(id), total: d.total(id) }));
  // Too many blocks even at the top: fold siblings of one kind, the biggest set first.
  if (out.length > budget) {
    const sets = new Map<string, Block[]>();
    for (const b of out) {
      const k = `grp:${d.m.nodes.get(b.id)?.parent ?? ""}:${d.m.nodes.get(b.id)?.kind ?? ""}`;
      if (!opened.has(k)) sets.set(k, [...(sets.get(k) ?? []), b]);
    }
    const order = [...sets].filter(([, bs]) => bs.length > 1).sort((a, b) => b[1].length - a[1].length);
    for (const [k, bs] of order) {
      if (out.length <= budget) break;
      const kind = d.m.nodes.get(bs[0]!.id)?.kind ?? "part";
      const inside = [...members].filter((m) => bs.some((b) => d.up(m).includes(b.id)));
      const names = new Set(inside.map((m) => (bs.some((b) => b.id === m) ? "" : d.name(m))));
      const what = names.size === 1 && !names.has("") ? `${[...names][0]} in ` : "";
      const label = `${what}${bs.length} ${KIND_PLURAL[kind] ?? `${kind}s`}`;
      const tally = new Map<string, number>();
      for (const m of inside) if (!bs.some((b) => b.id === m)) tally.set(d.name(m), (tally.get(d.name(m)) ?? 0) + 1);
      const insideText = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(" · ");
      const at = out.indexOf(bs[0]!);
      out = out.filter((b) => !bs.includes(b));
      out.splice(Math.min(at, out.length), 0, { id: k, n: bs.reduce((a, b) => a + b.n, 0), total: bs.reduce((a, b) => a + b.total, 0), group: { label, ids: bs.map((b) => b.id), inside: insideText } });
    }
    blocks = out.flatMap((b) => (b.group ? b.group.ids : [b.id]));
  }
  if (rest) {
    const shown = new Set(blocks);
    const parents = new Set(blocks.map((b) => d.m.nodes.get(b)?.parent ?? null));
    for (const par of parents) {
      const others = (par && par !== d.root ? d.kids(par).map((k) => k.id) : d.tops).filter((x) => !shown.has(x) && n(x) === 0);
      if (others.length === 0) continue;
      if (par && par !== d.root) {
        out.push({ id: `rest:${par}`, n: 0, total: others.length, rest: { label: `${d.name(par)}: ${others.length} other ${others.length === 1 ? "part" : "parts"}`, ids: others } });
      } else {
        const byKind = new Map<string, string[]>();
        for (const x of others) {
          const k = d.m.nodes.get(x)?.kind ?? "part";
          byKind.set(k, [...(byKind.get(k) ?? []), x]);
        }
        for (const [k, ids] of byKind) out.push({ id: `rest:top:${k}`, n: 0, total: ids.length, rest: { label: `${ids.length} other ${KIND_PLURAL[k] ?? `${k}s`}`, ids } });
      }
    }
  }
  return out;
}
const KIND_PLURAL: Record<string, string> = { service: "services", store: "stores", external: "outside systems", actor: "people", library: "libraries", module: "modules", app: "apps", system: "systems" };

/** The block standing for a part: the part itself or the nearest shown ancestor. */
function blockOf(d: PData, blocks: Block[], id: string): string | null {
  const ids = new Set(blocks.map((b) => b.id));
  for (const x of d.up(id)) if (ids.has(x)) return x;
  for (const b of blocks) if (b.rest?.ids.some((r) => d.up(id).includes(r)) || b.group?.ids.some((r) => d.up(id).includes(r))) return b.id;
  return null;
}

/** Lines rolled up to blocks: one per pair, `strong` when any of them carries the purpose. */
function rollLines(d: PData, blocks: Block[], strong: Set<string>, all: boolean): { key: string; from: string; to: string; strong: boolean; n: number }[] {
  const out = new Map<string, { key: string; from: string; to: string; strong: boolean; n: number }>();
  for (const e of d.m.a.edges) {
    if (!all && !strong.has(e.id)) continue;
    const a = blockOf(d, blocks, e.from), b = blockOf(d, blocks, e.to);
    if (!a || !b || a === b) continue;
    const k = `${a}→${b}`;
    const x = out.get(k) ?? { key: k, from: a, to: b, strong: false, n: 0 };
    x.n++;
    x.strong ||= strong.has(e.id);
    out.set(k, x);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------

export function PurposeCanvas(props: { c: PCtx; variant: Exclude<PcKey, "0"> }) {
  const d = new PData(props.c.m, props.c.p);
  return (
    <div {...stylex.attrs(s.wrap)}>
      <Head c={props.c} d={d} />
      <Show when={props.variant === "A"}>
        <GroupsView c={props.c} d={d} />
      </Show>
      <Show when={props.variant === "B"}>
        <FoldView c={props.c} d={d} />
      </Show>
      <Show when={props.variant === "C"}>
        <JourneyView c={props.c} d={d} />
      </Show>
      <Show when={props.variant === "D"}>
        <MapView c={props.c} d={d} />
      </Show>
    </div>
  );
}

/** Where the canvas stands, and the trail back up. Shared by all four. */
function Head(props: { c: PCtx; d: PData }) {
  const trail = () => {
    const at = props.c.at();
    if (!at) return [];
    const out: Purpose[] = [];
    for (let q: Purpose | undefined = props.d.purpose(at); q; q = q.parent ? props.d.purpose(q.parent) : undefined) out.unshift(q);
    return out;
  };
  const counts = () => {
    const at = props.c.at();
    const ns = at ? props.d.nodes(at) : new Set(props.c.p.purposes.flatMap((q) => props.d.direct(q.id)));
    return `${ns.size} parts · ${props.d.conflicts(at).length} conflicts`;
  };
  return (
    <div {...stylex.attrs(s.head)}>
      <button {...stylex.attrs(s.crumb)} onClick={() => props.c.pick(null)}>
        All purposes
      </button>
      <For each={trail()}>
        {(q) => (
          <>
            <span {...stylex.attrs(s.muted)}>›</span>
            <button {...stylex.attrs(s.crumb, q.id === props.c.at() && s.crumbOn)} onClick={() => props.c.pick({ kind: "purpose", id: q.id })}>
              <Dot sw={props.d.sw(q.id)} /> {q.name}
            </button>
          </>
        )}
      </For>
      <span {...stylex.attrs(s.muted, s.small)}>{counts()}</span>
      <Show when={props.c.sel()?.kind === "node"}>
        <button {...stylex.attrs(s.codeBtn)} onClick={() => props.c.openCode((props.c.sel() as { id: string }).id)}>
          Code view at {props.d.name((props.c.sel() as { id: string }).id)} ›
        </button>
      </Show>
    </div>
  );
}

function Dot(props: { sw: Sw; big?: boolean }) {
  return <span {...stylex.attrs(s.dot, sws[props.sw], props.big && s.dotBig)} />;
}

/** The purposes a part serves, as dots; the one you stand in drawn larger. */
function Dots(props: { d: PData; id: string; at: string | null }) {
  const ps = () => props.d.servedBy(props.id);
  return (
    <span {...stylex.attrs(s.dots)}>
      <For each={ps()}>{(q) => <Dot sw={props.d.sw(q)} big={props.at !== null && props.d.topPurpose(props.at) === q} />}</For>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// A drawing of blocks and lines, laid out by ELK. A and B draw with it.

interface SceneBlock {
  key: string;
  node?: string;
  title: string;
  sub: string;
  change: Change;
  kind: "part" | "rest" | "outside";
  /** Can open in place. */
  opens: boolean;
  /** What opening it adds to the opened set: a part's id or a fold's. */
  openId?: string;
}

function Scene(props: {
  c: PCtx;
  d: PData;
  blocks: SceneBlock[];
  lines: { key: string; from: string; to: string; strong: boolean; n: number }[];
  groups?: Map<string, string>;
  groupLabel?: (v: string) => { text: string; sw?: Sw; purpose?: string; dashed?: boolean };
  sw: Sw | null;
  onOpen: (b: SceneBlock) => void;
}) {
  const [laid, setLaid] = createSignal<{ at: Laid; key: string } | null>(null);
  let ticket = 0;
  createMemo(() => {
    const ids = props.blocks.map((b) => b.key);
    const key = ids.join("|") + props.lines.map((l) => l.key).join("|");
    const mine = ++ticket;
    void layout(
      ids,
      props.lines.map((l) => ({ key: l.key, from: l.from, to: l.to, label: "" })),
      undefined,
      props.groups,
      true,
    ).then((at) => {
      if (mine === ticket) setLaid({ at, key });
    });
  });
  const lit = createMemo(() => {
    const sp = props.c.spot();
    if (!sp) return null;
    const set = new Set<string>();
    for (const b of props.blocks) if (b.node && sp.nodes.some((n) => props.d.up(n).includes(b.node!) || props.d.up(b.node!).includes(n))) set.add(b.key);
    return set;
  });
  const selNode = () => {
    const x = props.c.sel();
    return x?.kind === "node" ? x.id : null;
  };
  return (
    <Show when={laid()} fallback={<p {...stylex.attrs(s.muted, s.pad)}>Laying out…</p>}>
      {(l) => (
        <svg width={l().at.width} height={l().at.height} {...stylex.attrs(s.svg)}>
          <For each={l().at.boxes}>
            {(b) => {
              const g = createMemo(() => (props.groupLabel ? props.groupLabel(b.value) : { text: b.value }));
              const dashed = () => !!g().dashed;
              const boxSw = () => g().sw ?? null;
              const isP = () => !!g().purpose;
              const boxStroke = () => { const w = boxSw(); return w ? strokes[w] : null; };
              return (
                <g>
                  <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={10} {...stylex.attrs(s.box, dashed() && s.boxDashed, boxStroke())} />
                  <text
                    x={b.x + 14}
                    y={b.y + 26}
                    {...stylex.attrs(s.boxTitle, isP() && s.click)}
                    onClick={() => g().purpose && props.c.pick({ kind: "purpose", id: g().purpose! })}
                  >
                    {g().text}
                    {g().purpose ? "  ›" : ""}
                  </text>
                </g>
              );
            }}
          </For>
          <For each={props.lines}>
            {(ln) => {
              const r = () => l().at.routes.get(ln.key);
              return (
                <Show when={r()}>
                  {(rr) => (
                    <g>
                      <path d={rr().d} {...stylex.attrs(s.line, s.lineWeak, ln.strong && s.lineStrong, ln.strong && props.sw !== null && strokes[props.sw ?? "c0"])} />
                      <path d={arrowD(rr().end)} {...stylex.attrs(s.head2, s.fillWeak, ln.strong && s.fillStrong, ln.strong && props.sw !== null && fills[props.sw ?? "c0"])} />
                    </g>
                  )}
                </Show>
              );
            }}
          </For>
          <For each={props.blocks}>
            {(b) => {
              const p = () => l().at.at.get(b.key);
              const faded = () => lit() !== null && !lit()!.has(b.key);
              return (
                <Show when={p()}>
                  {(pp) => (
                    <g
                      data-hit
                      {...stylex.attrs(s.click, faded() && s.faded)}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (b.opens) props.onOpen(b);
                        else if (b.node) props.c.pick({ kind: "node", id: b.node });
                      }}
                      onDblClick={() => b.node && props.c.openCode(b.node)}
                    >
                      <rect
                        x={pp().x}
                        y={pp().y}
                        width={NODE_W}
                        height={NODE_H}
                        rx={7}
                        {...stylex.attrs(s.block, b.kind === "rest" && s.blockRest, b.kind === "outside" && s.blockOutside, b.node === selNode() && s.blockSel)}
                      />
                      <rect x={pp().x} y={pp().y + 6} width={4} height={NODE_H - 12} {...stylex.attrs(changeFill[b.change])} />
                      <text x={pp().x + 14} y={pp().y + 24} {...stylex.attrs(s.t1, b.kind === "rest" && s.tMuted)}>
                        {clip(b.title, 26)}
                      </text>
                      <text x={pp().x + 14} y={pp().y + 42} {...stylex.attrs(s.t2)}>
                        {clip(b.sub, 34)}
                      </text>
                      <Show when={b.opens}>
                        <text x={pp().x + NODE_W - 16} y={pp().y + 24} {...stylex.attrs(s.t2)}>
                          ▸
                        </text>
                      </Show>
                      <Show when={b.node && b.kind !== "rest"}>
                        <For each={props.d.servedBy(b.node!)}>
                          {(q, i) => (
                            <circle
                              cx={pp().x + 18 + i() * 14}
                              cy={pp().y + NODE_H - 14}
                              r={props.c.at() && props.d.topPurpose(props.c.at()!) === q ? 6 : 4.5}
                              {...stylex.attrs(fills[props.d.sw(q)])}
                            />
                          )}
                        </For>
                      </Show>
                    </g>
                  )}
                </Show>
              );
            }}
          </For>
        </svg>
      )}
    </Show>
  );
}

function arrowD(t: { x: number; y: number; dx: number; dy: number }): string {
  const L = 8, W = 4.5;
  const bx = t.x - t.dx * L, by = t.y - t.dy * L;
  return `M${t.x},${t.y} L${bx - t.dy * W},${by + t.dx * W} L${bx + t.dy * W},${by - t.dx * W} Z`;
}
const isSel = (x: WSel, id: string) => x !== null && x.kind === "node" && x.id === id;
const isCell = (x: { row: string; col: string } | null, row: string, col: string) => x !== null && x.row === row && x.col === col;
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function sceneBlock(d: PData, b: Block, kind: SceneBlock["kind"] = "part", key = b.id): SceneBlock {
  if (b.rest) return { key, title: b.rest.label, sub: "don't serve it", change: "unchanged", kind: "rest", opens: false };
  if (b.group) return { key, title: b.group.label, sub: b.group.inside || `${b.n} parts serve it`, change: "modified", kind: "part", opens: true, openId: b.id };
  const kids = d.kids(b.id).length;
  const n = d.m.nodes.get(b.id);
  return {
    key,
    node: b.id,
    title: d.path(b.id),
    sub: kids === 0 ? (n?.changeSummary ?? n?.summary ?? "") : `${b.n} of ${b.total} parts serve it`,
    change: d.change(b.id),
    kind,
    opens: kids > 0 && b.n > 0,
    openId: b.id,
  };
}

// ---------------------------------------------------------------------------------------------
// A — Purpose groups: the PR as purpose boxes; a purpose as its sub-purposes' boxes; a leaf purpose
// as its parts and lines. A part serving several purposes is drawn in each box, with its dots.

function GroupsView(props: { c: PCtx; d: PData }) {
  const d = props.d;
  const [opened, setOpened] = createSignal(new Set<string>());
  const open = (id: string) => setOpened((o) => new Set(o).add(id));
  return (
    <Show when={props.c.at()} keyed fallback={<PurposeCards c={props.c} d={d} />}>
      {(at) => {
        const subs = () => d.subs(at);
        const scene = createMemo(() => {
          const o = opened();
          const strong = d.edges(at);
          if (subs().length === 0) {
            const blocks = rollup(d, d.nodes(at), 14, o);
            const out = d.outside(at);
            const sb = [...blocks.map((b) => sceneBlock(d, b)), ...out.map((x) => ({ ...sceneBlock(d, { id: x.node, n: 0, total: 1 }, "outside"), key: `out:${x.node}`, sub: `unchanged · ${x.conflict.title}`, opens: false }))];
            const groups = new Map(out.map((x) => [`out:${x.node}`, "outside"]));
            const lines = rollLines(d, blocks, strong, false);
            return { sb, lines, groups };
          }
          // One box per sub-purpose (and one for the parts the purpose names itself); a shared part is in each.
          const sb: SceneBlock[] = [];
          const groups = new Map<string, string>();
          const per: { gid: string; blocks: Block[] }[] = [];
          const add = (gid: string, members: Set<string>, budget: number) => {
            const blocks = rollup(d, members, budget, o);
            per.push({ gid, blocks });
            for (const b of blocks) {
              const key = `${gid}|${b.id}`;
              sb.push(sceneBlock(d, b, "part", key));
              groups.set(key, gid);
            }
          };
          const own = new Set(d.direct(at));
          if (own.size > 0) add("own", own, 4);
          for (const q of subs()) add(q.id, d.nodes(q.id), 5);
          const out = d.outside(at);
          for (const x of out) {
            sb.push({ ...sceneBlock(d, { id: x.node, n: 0, total: 1 }, "outside"), key: `out:${x.node}`, sub: `unchanged · ${x.conflict.title}`, opens: false });
            groups.set(`out:${x.node}`, "outside");
          }
          // Lines between boxes: the purpose's lines rolled up, each end in the box that names it first.
          const lines = new Map<string, { key: string; from: string; to: string; strong: boolean; n: number }>();
          for (const eid of strong) {
            const e = d.m.edges.get(eid)!;
            const end = (id: string) => {
              for (const g of per) {
                const b = blockOf(d, g.blocks, id);
                if (b) return `${g.gid}|${b}`;
              }
              return null;
            };
            const a = end(e.from), b = end(e.to);
            if (!a || !b || a === b) continue;
            const k = `${a}→${b}`;
            const x = lines.get(k) ?? { key: k, from: a, to: b, strong: true, n: 0 };
            x.n++;
            lines.set(k, x);
          }
          return { sb, lines: [...lines.values()], groups };
        });
        return (
          <Show when={subs().length === 0} fallback={<SubCards c={props.c} d={d} at={at} />}>
          <Scene
            c={props.c}
            d={d}
            blocks={scene().sb}
            lines={scene().lines}
            groups={scene().groups}
            sw={d.sw(at)}
            groupLabel={(v) =>
              v === "own"
                ? { text: "Named by the purpose itself", sw: d.sw(at) }
                : v === "outside"
                  ? { text: "Outside the diff: only through a conflict", dashed: true }
                  : { text: `${d.purpose(v).name} · ${d.nodes(v).size} parts`, sw: d.sw(v), purpose: v }
            }
            onOpen={(b) => (open(b.openId!), b.node && props.c.pick({ kind: "node", id: b.node }))}
          />
          </Show>
        );
      }}
    </Show>
  );
}

/** A at a purpose with sub-purposes: one card per sub-purpose, in journey order, saying what each hands on to. */
function SubCards(props: { c: PCtx; d: PData; at: string }) {
  const d = props.d;
  const subs = d.subs(props.at);
  const own = d.direct(props.at);
  const handsTo = (q: Purpose) => {
    const mine = d.nodes(q.id);
    return subs
      .filter((o) => o.id !== q.id)
      .map((o) => {
        const theirs = d.nodes(o.id);
        const n = d.m.a.edges.filter((e) => mine.has(e.from) && theirs.has(e.to) && !mine.has(e.to)).length;
        return { o, n };
      })
      .filter((x) => x.n > 0);
  };
  const outside = d.outside(props.at);
  return (
    <div {...stylex.attrs(s.cards)}>
      <Show when={own.length > 0}>
        <div {...stylex.attrs(s.card, borders[d.sw(props.at)])}>
          <b>Named by the purpose itself</b>
          <Chips c={props.c} d={d} members={new Set(own)} budget={6} />
        </div>
      </Show>
      <For each={subs}>
        {(q, i) => (
          <div {...stylex.attrs(s.card, borders[d.sw(q.id)])}>
            <button {...stylex.attrs(s.cardHead)} onClick={() => props.c.pick({ kind: "purpose", id: q.id })}>
              <b>
                {i() + 1}. {q.name} ›
              </b>
              <span {...stylex.attrs(s.muted, s.small)}>
                {q.kind} · {d.nodes(q.id).size} parts
              </span>
            </button>
            <div {...stylex.attrs(s.small)}>{q.walk.intro}</div>
            <Chips c={props.c} d={d} members={d.nodes(q.id)} budget={8} />
            <For each={handsTo(q)}>
              {(x) => (
                <button {...stylex.attrs(s.linkBtn, s.small)} onClick={() => props.c.pick({ kind: "purpose", id: x.o.id })}>
                  → hands on to {x.o.name} ({x.n} lines)
                </button>
              )}
            </For>
            <For each={d.conflicts(q.id)}>{(c) => <div {...stylex.attrs(s.small, s.warn)}>⚠ {c.title}</div>}</For>
          </div>
        )}
      </For>
      <Show when={outside.length > 0}>
        <div {...stylex.attrs(s.card, s.cardOutside)}>
          <b>Outside the diff: only through a conflict</b>
          <For each={outside}>
            {(x) => (
              <button {...stylex.attrs(s.chip, s.chipOutside)} onClick={() => props.c.pick({ kind: "node", id: x.node })} onDblClick={() => props.c.openCode(x.node)}>
                {d.path(x.node)} <span {...stylex.attrs(s.muted)}>· unchanged · ⚠ {x.conflict.title}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** A at the PR: one card per purpose, in reading order. */
function PurposeCards(props: { c: PCtx; d: PData }) {
  const d = props.d;
  return (
    <div {...stylex.attrs(s.cards)}>
      <For each={d.subs(null)}>
        {(q, i) => {
          const subs = d.subs(q.id);
          const shares = () =>
            d
              .subs(null)
              .filter((o) => o.id !== q.id)
              .map((o) => ({ o, n: [...d.nodes(q.id)].filter((x) => d.nodes(o.id).has(x)).length }))
              .filter((x) => x.n > 0);
          return (
            <div {...stylex.attrs(s.card, borders[d.sw(q.id)])}>
              <button {...stylex.attrs(s.cardHead)} onClick={() => props.c.pick({ kind: "purpose", id: q.id })}>
                <Dot sw={d.sw(q.id)} big />
                <b>
                  {i() + 1}. {q.name}
                </b>
                <span {...stylex.attrs(s.muted, s.small)}>
                  {q.kind} · {d.nodes(q.id).size} parts
                </span>
              </button>
              <Show
                when={subs.length > 0}
                fallback={
                  <Chips c={props.c} d={d} members={d.nodes(q.id)} budget={6} />
                }
              >
                <For each={subs}>
                  {(sq) => (
                    <div {...stylex.attrs(s.subBox)}>
                      <button {...stylex.attrs(s.subHead)} onClick={() => props.c.pick({ kind: "purpose", id: sq.id })}>
                        {sq.name} <span {...stylex.attrs(s.muted, s.small)}>· {d.nodes(sq.id).size} parts</span>
                      </button>
                      <Chips c={props.c} d={d} members={d.nodes(sq.id)} budget={4} />
                    </div>
                  )}
                </For>
              </Show>
              <Show when={shares().length > 0}>
                <div {...stylex.attrs(s.small, s.muted)}>
                  Shares parts with:{" "}
                  <For each={shares()}>
                    {(x) => (
                      <span {...stylex.attrs(s.share)}>
                        <Dot sw={d.sw(x.o.id)} /> {x.o.name} ({x.n})
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={d.conflicts(q.id).length > 0}>
                <div {...stylex.attrs(s.small, s.warn)}>⚠ {d.conflicts(q.id).length} conflicts</div>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

function Chips(props: { c: PCtx; d: PData; members: Set<string>; budget: number }) {
  const d = props.d;
  const [opened, setOpened] = createSignal(new Set<string>());
  const blocks = createMemo(() => rollup(d, props.members, props.budget, opened()));
  return (
    <div {...stylex.attrs(s.chips)}>
      <For each={blocks()}>
        {(b) => (
          <Show
            when={!b.group}
            fallback={
              <button {...stylex.attrs(s.chip, s.chipGroup)} onClick={() => setOpened((o) => new Set(o).add(b.id))}>
                ▸ {b.group!.label}
              </button>
            }
          >
          <button
            {...stylex.attrs(s.chip, isSel(props.c.sel(), b.id) && s.chipSel)}
            onClick={() => props.c.pick({ kind: "node", id: b.id })}
            onDblClick={() => props.c.openCode(b.id)}
          >
            <span {...stylex.attrs(s.bar, changeBg[d.change(b.id)])} />
            {d.path(b.id)}
            <Show when={b.total > 1}>
              <span {...stylex.attrs(s.muted)}>
                {" "}
                {b.n}/{b.total}
              </span>
            </Show>
            <Show when={d.servedBy(b.id).length > 1}>
              <Dots d={d} id={b.id} at={null} />
            </Show>
          </button>
          </Show>
        )}
      </For>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// B — Fold the rest: the code view's top level, the purpose's parts rolled up, everything else folded.

function FoldView(props: { c: PCtx; d: PData }) {
  const d = props.d;
  // What's opened, for the purpose it was opened in: standing elsewhere starts folded again.
  const [openedAt, setOpenedAt] = createSignal<{ at: string | null; ids: Set<string> }>({ at: null, ids: new Set() });
  const opened = () => (openedAt().at === props.c.at() ? openedAt().ids : new Set<string>());
  const setOpened = (f: (o: Set<string>) => Set<string>) => setOpenedAt({ at: props.c.at(), ids: f(opened()) });
  const scene = createMemo(() => {
    const at = props.c.at();
    const members = at ? d.nodes(at) : new Set(props.c.p.purposes.flatMap((q) => d.direct(q.id)));
    const strong = at ? d.edges(at) : new Set(props.c.p.purposes.flatMap((q) => [...d.edges(q.id)]));
    const blocks = rollup(d, members, 16, opened(), true);
    const out = d.outside(at).filter((x) => !blocks.some((b) => b.id === x.node));
    const sb = [
      ...blocks.map((b) => sceneBlock(d, b)),
      ...out.map((x) => ({ ...sceneBlock(d, { id: x.node, n: 0, total: 1 }, "outside"), key: `out:${x.node}`, sub: `unchanged · ⚠ ${x.conflict.title}`, opens: false })),
    ];
    // Lines between two folds say nothing about the purpose: only lines with a purpose part at one end at least.
    const isRest = (id: string) => id.startsWith("rest:");
    const lines = rollLines(d, blocks, strong, true).filter((l) => l.strong || !(isRest(l.from) && isRest(l.to)));
    for (const x of out) {
      for (const e of d.m.a.edges) {
        const other = e.from === x.node || d.up(e.from).includes(x.node) ? e.to : e.to === x.node ? e.from : null;
        if (!other) continue;
        const b = blockOf(d, blocks, other);
        if (b) lines.push({ key: `out:${x.node}→${b}`, from: `out:${x.node}`, to: b, strong: false, n: 1 });
      }
    }
    return { sb, lines, groups: new Map(out.map((x) => [`out:${x.node}`, "outside"])), at };
  });
  return (
    <Scene
      c={props.c}
      d={d}
      blocks={scene().sb}
      lines={scene().lines}
      groups={scene().groups}
      sw={scene().at ? d.sw(scene().at!) : null}
      groupLabel={() => ({ text: "Outside the diff: only through a conflict", dashed: true })}
      onOpen={(b) => (setOpened((o) => new Set(o).add(b.openId!)), b.node && props.c.pick({ kind: "node", id: b.node }))}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// C — Journey line: a purpose's stops in order along a line. At the PR, one line per purpose.

function JourneyView(props: { c: PCtx; d: PData }) {
  const d = props.d;
  return (
    <Show when={props.c.at()} keyed fallback={<MetroMap c={props.c} d={d} />}>
      {(at) => {
        const q = d.purpose(at);
        const mine = d.nodes(at);
        const others = d
          .subs(null)
          .filter((o) => o.id !== d.topPurpose(at))
          .map((o) => ({ o, shared: [...mine].filter((x) => d.nodes(o.id).has(x)) }))
          .filter((x) => x.shared.length > 0);
        const stationOf = (node: string) =>
          q.stops.findIndex((st) =>
            st.kind === "purpose" ? d.nodes(st.id).has(node) : st.kind === "node" ? d.up(node).includes(st.id) || d.up(st.id).includes(node) : (() => {
              const e = d.m.edges.get(st.id);
              return !!e && (e.from === node || e.to === node);
            })(),
          );
        return (
          <div {...stylex.attrs(s.journey)}>
            <div {...stylex.attrs(s.track)}>
              <For each={q.stops}>
                {(st, i) => {
                  const parts = (): Set<string> =>
                    st.kind === "purpose"
                      ? d.nodes(st.id)
                      : st.kind === "node"
                        ? new Set([st.id])
                        : (() => {
                            const e = d.m.edges.get(st.id)!;
                            return new Set([e.from, e.to]);
                          })();
                  const crossing = () => others.filter((x) => x.shared.some((n) => stationOf(n) === i()));
                  const conflicts = () => d.conflicts(at).filter((c) => c.touches.nodes.some((n) => stationOf(n) === i()) || (st.kind === "purpose" && c.touches.purposes.includes(st.id)));
                  return (
                    <div {...stylex.attrs(s.station)}>
                      <div {...stylex.attrs(s.rail, rails[d.sw(at)])} />
                      <button
                        {...stylex.attrs(s.stop, borders[d.sw(at)], st.kind === "purpose" && s.stopBig)}
                        onClick={() => props.c.pick(st.kind === "purpose" ? { kind: "purpose", id: st.id } : st.kind === "node" ? { kind: "node", id: st.id } : { kind: "edge", ids: [st.id] })}
                      >
                        {i() + 1}
                      </button>
                      <div {...stylex.attrs(s.stationName)}>{st.kind === "purpose" ? d.purpose(st.id).name : st.kind === "node" ? d.path(st.id) : `${d.name(d.m.edges.get(st.id)!.from)} → ${d.name(d.m.edges.get(st.id)!.to)}`}</div>
                      <div {...stylex.attrs(s.small, s.muted)}>{st.line}</div>
                      <Show when={crossing().length > 0}>
                        <div {...stylex.attrs(s.crossings)}>
                          <For each={crossing()}>
                            {(x) => (
                              <button {...stylex.attrs(s.cross, borders[d.sw(x.o.id)])} onClick={() => props.c.pick({ kind: "purpose", id: x.o.id })}>
                                <Dot sw={d.sw(x.o.id)} /> crosses: {x.o.name}
                                <span {...stylex.attrs(s.muted)}> · {x.shared.filter((n) => stationOf(n) === i()).map((n) => d.name(n)).slice(0, 2).join(", ")}</span>
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                      <Chips c={props.c} d={d} members={parts()} budget={5} />
                      <For each={conflicts()}>
                        {(c) => (
                          <div {...stylex.attrs(s.branch)}>
                            <div {...stylex.attrs(s.warn, s.small)}>⚠ {c.title}</div>
                            <For each={c.touches.nodes.filter((n) => d.outside(at).some((o) => o.node === n))}>
                              {(n) => (
                                <button {...stylex.attrs(s.chip, s.chipOutside)} onClick={() => props.c.pick({ kind: "node", id: n })} onDblClick={() => props.c.openCode(n)}>
                                  {d.path(n)} <span {...stylex.attrs(s.muted)}>· unchanged, outside the diff</span>
                                </button>
                              )}
                            </For>
                          </div>
                        )}
                      </For>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

/** C at the PR: each purpose a line of its stops; interchanges list the purposes sharing parts. */
function MetroMap(props: { c: PCtx; d: PData }) {
  const d = props.d;
  return (
    <div {...stylex.attrs(s.metro)}>
      <For each={d.subs(null)}>
        {(q) => {
          const stops = q.stops;
          return (
            <div {...stylex.attrs(s.metroRow)}>
              <button {...stylex.attrs(s.metroName)} onClick={() => props.c.pick({ kind: "purpose", id: q.id })}>
                <Dot sw={d.sw(q.id)} big /> {q.name}
                <div {...stylex.attrs(s.small, s.muted)}>{d.nodes(q.id).size} parts</div>
              </button>
              <div {...stylex.attrs(s.metroLine)}>
                <div {...stylex.attrs(s.metroRail, rails[d.sw(q.id)])} />
                <For each={stops}>
                  {(st) => {
                    const ns = st.kind === "purpose" ? d.nodes(st.id) : new Set(st.kind === "node" ? [st.id] : []);
                    const xs = d.subs(null).filter((o) => o.id !== q.id && [...ns].some((n) => d.nodes(o.id).has(n)));
                    return (
                      <div {...stylex.attrs(s.metroStop)}>
                        <button
                          {...stylex.attrs(s.metroDot, borders[d.sw(q.id)], xs.length > 0 && s.interchange)}
                          onClick={() => props.c.pick(st.kind === "purpose" ? { kind: "purpose", id: st.id } : st.kind === "node" ? { kind: "node", id: st.id } : { kind: "edge", ids: [st.id] })}
                        />
                        <div {...stylex.attrs(s.metroLabel)}>
                          {clip(st.kind === "purpose" ? d.purpose(st.id).name : st.kind === "node" ? d.name(st.id) : d.name(d.m.edges.get(st.id)?.to ?? ""), 26)}
                        </div>
                        <div>
                          <For each={xs}>{(o) => <Dot sw={d.sw(o.id)} />}</For>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          );
        }}
      </For>
      <p {...stylex.attrs(s.small, s.muted)}>A ring around a stop is an interchange: the dots under it are the other purposes that share its parts.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// D — Purpose × area map: rows are purposes (sub-purposes under their purpose), columns the top-level
// parts any purpose reaches. A column header opens into its parts; a cell lists its parts below.

function MapView(props: { c: PCtx; d: PData }) {
  const d = props.d;
  const [openCols, setOpenCols] = createSignal(new Set<string>());
  const [cell, setCell] = createSignal<{ row: string; col: string } | null>(null);
  const [onlyMine, setOnlyMine] = createSignal(true);
  const rows = createMemo(() => {
    const at = props.c.at();
    const out: { q: Purpose; depth: number }[] = [];
    const walk = (q: Purpose, depth: number) => {
      out.push({ q, depth });
      const show = at !== null && (d.tree(q.id).includes(at) || d.up(at).includes(q.id) || d.tree(d.topPurpose(at)).includes(q.id));
      if (show) for (const sq of d.subs(q.id)) walk(sq, depth + 1);
    };
    for (const q of d.subs(null)) walk(q, 0);
    return out;
  });
  const all = createMemo(() => new Set(props.c.p.purposes.flatMap((q) => d.direct(q.id))));
  const cols = createMemo(() => {
    const at = props.c.at();
    const scope = at && onlyMine() ? d.nodes(at) : all();
    const outside = d.outside(at).map((x) => x.node);
    const reach = (id: string) => [...scope, ...outside].some((n) => d.up(n).includes(id));
    const expand = (ids: string[]): string[] => ids.flatMap((id) => (openCols().has(id) ? expand(d.kids(id).map((k) => k.id).filter(reach)) : [id]));
    const cs = expand(d.tops.filter(reach));
    const order = ["actor", "app", "service", "library", "module", "store", "external", "system"];
    return cs.sort((a, b) => order.indexOf(d.m.nodes.get(a)?.kind ?? "") - order.indexOf(d.m.nodes.get(b)?.kind ?? ""));
  });
  const inCell = (row: string, col: string) => [...d.nodes(row)].filter((n) => d.up(n).includes(col));
  const max = createMemo(() => Math.max(1, ...rows().flatMap((r) => cols().map((c) => inCell(r.q.id, c).length))));
  const conflictIn = (row: string, col: string) => d.conflicts(row).filter((c) => c.touches.nodes.some((n) => d.up(n).includes(col)));
  const outIn = (row: string, col: string) => d.outside(row).filter((x) => d.up(x.node).includes(col));
  const lit = () => {
    const sp = props.c.spot();
    return sp ? new Set(sp.nodes) : null;
  };
  return (
    <div {...stylex.attrs(s.mapWrap)}>
      <Show when={props.c.at()}>
        <label {...stylex.attrs(s.small)}>
          <input type="checkbox" checked={onlyMine()} onChange={(e) => setOnlyMine(e.currentTarget.checked)} /> Only the columns this purpose reaches
        </label>
      </Show>
      <div {...stylex.attrs(s.mapScroll)}>
        <table {...stylex.attrs(s.table)}>
          <thead>
            <tr>
              <th {...stylex.attrs(s.th, s.corner)} />
              <For each={cols()}>
                {(col) => (
                  <th {...stylex.attrs(s.th)}>
                    <button
                      {...stylex.attrs(s.colHead)}
                      title={d.path(col)}
                      onClick={() => (d.kids(col).length > 0 ? setOpenCols((o) => new Set(o).add(col)) : props.c.pick({ kind: "node", id: col }))}
                    >
                      <span {...stylex.attrs(s.vert)}>
                        {d.kids(col).length > 0 ? "▸ " : ""}
                        {clip(d.path(col), 28)}
                      </span>
                    </button>
                  </th>
                )}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(r) => {
                const on = () => props.c.at() === r.q.id;
                const dim = () => props.c.at() !== null && !d.tree(d.topPurpose(props.c.at()!)).includes(r.q.id);
                return (
                  <tr {...stylex.attrs(dim() && s.faded)}>
                    <th {...stylex.attrs(s.rowHead, on() && s.rowOn)}>
                      <button {...stylex.attrs(s.rowBtn)} style={{ "--indent": `${r.depth * 14}px` }} onClick={() => props.c.pick({ kind: "purpose", id: r.q.id })}>
                        <Dot sw={d.sw(r.q.id)} big={r.depth === 0} /> {clip(r.q.name, 30)}
                      </button>
                    </th>
                    <For each={cols()}>
                      {(col) => {
                        const n = () => inCell(r.q.id, col).length;
                        const cf = () => conflictIn(r.q.id, col);
                        const ot = () => outIn(r.q.id, col);
                        const here = createMemo(() => isCell(cell(), r.q.id, col));
                        const hasOut = () => ot().length > 0;
                        const isLit = () => lit() !== null && inCell(r.q.id, col).some((x) => lit()!.has(x));
                        return (
                          <td
                            {...stylex.attrs(s.td, here() && s.tdSel, hasOut() && s.tdOut, isLit() && s.tdLit)}
                            onClick={() => (n() > 0 || ot().length > 0) && setCell({ row: r.q.id, col })}
                          >
                            <Show when={n() > 0}>
                              <span {...stylex.attrs(s.heat, sws[d.sw(r.q.id)])} style={{ "--heat": `${0.15 + (0.75 * n()) / max()}` }} />
                              <span {...stylex.attrs(s.count)}>{n()}</span>
                            </Show>
                            <Show when={cf().length > 0}>
                              <span {...stylex.attrs(s.warnMark)}>⚠</span>
                            </Show>
                          </td>
                        );
                      }}
                    </For>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>
      <Show when={cell()}>
        {(c) => {
          const parts = () => inCell(c().row, c().col);
          return (
            <div {...stylex.attrs(s.cellList)}>
              <div>
                <Dot sw={d.sw(c().row)} /> <b>{d.purpose(c().row).name}</b> in <b>{d.path(c().col)}</b>: {parts().length} parts
                <button {...stylex.attrs(s.linkBtn)} onClick={() => setCell(null)}>
                  close
                </button>
              </div>
              <Chips c={props.c} d={d} members={new Set(parts())} budget={12} />
              <For each={outIn(c().row, c().col)}>
                {(x) => (
                  <button {...stylex.attrs(s.chip, s.chipOutside)} onClick={() => props.c.pick({ kind: "node", id: x.node })}>
                    {d.path(x.node)} <span {...stylex.attrs(s.muted)}>· unchanged, through ⚠ {x.conflict.title}</span>
                  </button>
                )}
              </For>
            </div>
          );
        }}
      </Show>
    </div>
  );
}

