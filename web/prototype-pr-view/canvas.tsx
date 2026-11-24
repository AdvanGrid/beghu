// PROTOTYPE (PR view, #173): are the drawn graph and Clusters one canvas or two? Throwaway.
//
// Open /prototype-pr-view/canvas.html?a=<name> (AdvanGrid-advangrid-2627, or acme-shop-77 for many
// purposes). The bar at the bottom (or ← →) switches between:
//
// - one:   ONE CANVAS. A switch for Canvas | Path. The canvas is the locked top level (people, changed,
//          not changed, outside); every part opens in place (double-click), and standing on the PR or
//          a purpose folds what doesn't serve it, on this same canvas. No zoom scenes.
// - three: THREE CANVASES. A switch for Drawn graph | Clusters | Path. The drawn graph is the locked top
//          level; a double-click zooms into a part (a scene of its inside, with the parts it connects
//          to around it), and standing on the PR or a purpose folds the rest on it. Clusters starts
//          folded into four group blocks that open in place, and ignores purposes.
//
// Both share the panel, the selection and Path. Everything is laid out by our own engine
// (nested-layout.ts). Left out: lenses, Colour by, Boxes, hover cards, the legend, sibling folds.
import { render, type JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import * as stylex from "@stylexjs/stylex";
import { colors, fonts } from "../src/tokens.stylex.ts";
import { pal } from "./tokens.stylex.ts";
import { arrow, rounded } from "./layout.ts";
import { tidy, type P } from "./own-layout.ts";
import { nestedLayout, type Nested, type TLink, type TNode } from "./nested-layout.ts";
import { NODE_H, NODE_W } from "./layout-size.ts";
import { Explore, type Api } from "./explore.tsx";
import { Model, type Lens } from "./model.ts";
import type { Purposes } from "./purpose.ts";
import type { Analysis, Change, Edge, Node } from "./schema.ts";

const loaders = import.meta.glob<Analysis>("./data/*.json", { import: "default" });
const overlays = import.meta.glob<{ edges: Edge[] }>("./data/overlays/*.json", { import: "default" });
const purposeLoaders = import.meta.glob<Purposes>("./data/purposes/*.json", { import: "default" });
const params = new URLSearchParams(location.search);
const name = params.get("a") ?? "AdvanGrid-advangrid-2627";
const sync = (k: string, v: string | null) => {
  const p = new URLSearchParams(location.search);
  if (v === null) p.delete(k);
  else p.set(k, v);
  history.replaceState(null, "", `?${p}`);
};

const SHAPES = [
  { key: "one", name: "One canvas: Canvas | Path" },
  { key: "three", name: "Three canvases: Drawn graph | Clusters | Path" },
] as const;
type ShapeKey = (typeof SHAPES)[number]["key"];
type Tab = "canvas" | "graph" | "clusters" | "path";
type Sel = null | { kind: "node"; id: string } | { kind: "purpose"; id: string } | { kind: "line"; members: string[] };
const BUDGET = 16;
const glide = 420;

// ---------------------------------------------------------------------------------------------
// Data

interface Data {
  a: Analysis;
  m: Model;
  p: Purposes | null;
  sys: string;
  info: Map<string, Node>;
  kids: Map<string, string[]>;
  top: string[];
  side: Map<string, 0 | 1 | 2 | 3>;
  links: TLink[];
  edges: Map<string, Edge>;
  chain: (id: string) => string[];
  within: (id: string) => Set<string>;
  /** Top-level purposes in reading order. */
  tops: string[];
  /** A purpose's members: its parts and its sub-purposes' parts. */
  members: (pid: string | null) => Set<string>;
  /** The top-level purposes a part serves, itself or through a part inside it. */
  dots: (id: string) => string[];
}

function prepare(a: Analysis, p: Purposes | null): Data {
  const info = new Map(a.nodes.map((n) => [n.id, n]));
  const sys = a.nodes.find((n) => n.kind === "system")!.id;
  const kids = new Map<string, string[]>();
  for (const n of a.nodes) if (n.parent && n.parent !== sys) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.id]);
  const top = a.nodes.filter((n) => n.parent === sys).map((n) => n.id);
  const touched = (id: string): boolean => info.get(id)!.change !== "unchanged" || (kids.get(id) ?? []).some(touched);
  const side = new Map<string, 0 | 1 | 2 | 3>();
  for (const id of top) {
    const n = info.get(id)!;
    side.set(id, n.kind === "actor" ? 0 : n.kind === "external" ? 3 : touched(id) ? 1 : 2);
  }
  const chainOf = new Map<string, string[]>();
  const chain = (id: string): string[] => {
    let c = chainOf.get(id);
    if (!c) {
      const par = info.get(id)?.parent;
      c = par && par !== sys ? [...chain(par), id] : [id];
      chainOf.set(id, c);
    }
    return c;
  };
  const within = (id: string) => {
    const out = new Set([id]);
    const todo = [id];
    for (let x = todo.pop(); x !== undefined; x = todo.pop()) for (const c of kids.get(x) ?? []) (out.add(c), todo.push(c));
    return out;
  };
  const links = a.edges.filter((e) => info.has(e.from) && info.has(e.to) && e.from !== sys && e.to !== sys).map((e) => ({ key: e.id, from: e.from, to: e.to }));
  const ps = p?.purposes ?? [];
  const tops = ps.filter((q) => !q.parent).map((q) => q.id);
  const members = (pid: string | null): Set<string> => {
    const out = new Set<string>();
    for (const q of ps) if (pid === null || q.id === pid || q.parent === pid) for (const s of q.serves) if (info.has(s.node)) out.add(s.node);
    return out;
  };
  const dotCache = new Map<string, string[]>();
  const topMembers = new Map(tops.map((t) => [t, members(t)]));
  const dots = (id: string) => {
    let d = dotCache.get(id);
    if (!d) {
      const w = within(id);
      d = tops.filter((t) => [...topMembers.get(t)!].some((x) => w.has(x)));
      dotCache.set(id, d);
    }
    return d;
  };
  return { a, m: new Model(a), p, sys, info, kids, top, side, links, edges: new Map(a.edges.map((e) => [e.id, e])), chain, within, tops, members, dots };
}

// ---------------------------------------------------------------------------------------------
// Scenes: what each canvas lays out

/** How a drawn box reads. */
interface Look {
  name: string;
  sub: string;
  change: Change;
  stub?: boolean;
  group?: boolean;
  dots?: string[];
  canOpen: boolean;
  /** Faded: drawn for context only. */
  context?: boolean;
}
interface Scene {
  nodes: TNode[];
  links: TLink[];
  open: Set<string>;
  regions: boolean;
  look: (id: string) => Look;
  /** In purpose mode: which analysis lines carry the purpose (the rest draw faint). */
  strong?: (edge: string) => boolean;
  /** The real part a drawn id stands for (stubs and groups stand for nothing). */
  real: (id: string) => string | null;
}


function baseLook(d: Data, id: string, extra: Partial<Look> = {}): Look {
  const n = d.info.get(id)!;
  const inside = d.kids.get(id)?.length ?? 0;
  const ch = n.change === "unchanged" && d.side.get(id) === 1 ? "modified" : n.change;
  return { name: n.name, sub: `${n.kind}${inside ? ` · ▸ ${inside} inside` : ""}`, change: ch, canOpen: inside > 0, dots: d.dots(id), ...extra };
}

/** The plain code view: every part, its top level in the locked groups, `open` opened in place. */
function plainScene(d: Data, open: Set<string>): Scene {
  const nodes: TNode[] = d.a.nodes
    .filter((n) => n.id !== d.sys)
    .map((n) => ({ id: n.id, parent: n.parent === d.sys ? undefined : n.parent, side: d.side.get(n.id) ?? 1, w: NODE_W, h: NODE_H }));
  return { nodes, links: d.links, open, regions: true, look: (id) => baseLook(d, id), real: (id) => id };
}

/** Three canvases' drawn graph zoomed into `focus`: its inside, opened, with the parts it connects to around it. */
function zoomScene(d: Data, focus: string, open: Set<string>): Scene {
  const ch = d.chain(focus);
  const inF = d.within(focus);
  const linkedTo = new Set<string>();
  for (const l of d.links) {
    if (inF.has(l.from) && !inF.has(l.to)) linkedTo.add(l.to);
    if (inF.has(l.to) && !inF.has(l.from)) linkedTo.add(l.from);
  }
  const keep = (id: string): boolean => {
    if (inF.has(id) || ch.includes(id)) return true;
    // Context: a top-level part, or a sibling of something on the chain, with a line to the zoomed part.
    const par = d.info.get(id)!.parent;
    const onChainLevel = par === d.sys || ch.includes(par!);
    if (!onChainLevel) return false;
    return [...d.within(id)].some((x) => linkedTo.has(x));
  };
  const ok = new Set<string>();
  for (const n of d.a.nodes) {
    if (n.id === d.sys) continue;
    // Context parts keep their insides (folded) so lines roll up to them.
    if (keep(n.id) || d.chain(n.id).some((x) => x !== n.id && keep(x) && !ch.includes(x))) ok.add(n.id);
  }
  const nodes: TNode[] = [...ok].map((id) => {
    const par = d.info.get(id)!.parent;
    return { id, parent: par === d.sys ? undefined : par, side: d.side.get(id) ?? 1, w: NODE_W, h: NODE_H };
  });
  const o = new Set([...ch, ...open]);
  const ctx = (id: string) => !inF.has(id) && !ch.includes(id);
  return { nodes, links: d.links, open: o, regions: true, look: (id) => baseLook(d, id, { context: ctx(id) }), real: (id) => id };
}

/** Three canvases' Clusters: four group blocks (people, changed, not changed, outside) that open in place. */
function clustersScene(d: Data, open: Set<string>): Scene {
  const G = ["g:0", "g:1", "g:2", "g:3"] as const;
  const GN = ["People and callers", "Changed", "Not changed", "Outside systems"];
  const nodes: TNode[] = G.map((g, i) => ({ id: g, side: i as 0 | 1 | 2 | 3, w: NODE_W, h: NODE_H }));
  for (const n of d.a.nodes) {
    if (n.id === d.sys) continue;
    nodes.push({ id: n.id, parent: n.parent === d.sys ? G[d.side.get(n.id)!] : n.parent, side: 1, w: NODE_W, h: NODE_H });
  }
  const count = G.map((_, i) => d.top.filter((t) => d.side.get(t) === i).length);
  return {
    nodes: nodes.filter((n) => !n.id.startsWith("g:") || count[Number(n.id[2])]! > 0),
    links: d.links,
    open,
    regions: false,
    look: (id) =>
      id.startsWith("g:")
        ? { name: GN[Number(id[2])]!, sub: `${count[Number(id[2])]} parts`, change: id === "g:1" ? "modified" : "unchanged", group: true, canOpen: true }
        : baseLook(d, id),
    real: (id) => (id.startsWith("g:") ? null : id),
  };
}

/**
 * Fold the rest (#160's B) on our layout: the parts holding members stay, every frame's other
 * children fold into one dashed stub, and blocks holding members open greedily while the drawing
 * stays within the budget (a plan made once per purpose). `extra` are the reader's own opens.
 */
function purposeScene(d: Data, pid: string | null, extra: Set<string>, folded: Set<string>): Scene {
  const M = d.members(pid);
  const holds = new Set<string>();
  for (const m of M) for (const x of d.chain(m)) holds.add(x);
  const near = new Set<string>(holds);
  for (const m of M) for (const x of d.within(m)) near.add(x);
  // The plan: open the block holding the most members while the count of drawn blocks stays in budget.
  const memberCount = (id: string) => [...d.within(id)].filter((x) => M.has(x)).length;
  const plan = new Set<string>();
  const sides = new Set(d.top.filter((t) => !holds.has(t)).map((t) => d.side.get(t)));
  let count = d.top.filter((t) => holds.has(t)).length + sides.size;
  const tried = new Set<string>();
  for (;;) {
    const visible = [...holds].filter((x) => {
      const par = d.info.get(x)!.parent;
      return (par === d.sys || plan.has(par!)) && !plan.has(x) && !tried.has(x) && (d.kids.get(x)?.length ?? 0) > 0 && !M.has(x);
    });
    if (!visible.length) break;
    visible.sort((x, y) => memberCount(y) - memberCount(x));
    const b = visible[0]!;
    const ks = d.kids.get(b)!;
    const serving = ks.filter((k) => holds.has(k)).length;
    const next = count - 1 + serving + (serving < ks.length ? 1 : 0);
    if (next > BUDGET) {
      tried.add(b);
      continue;
    }
    plan.add(b);
    count = next;
  }
  const open = new Set([...plan, ...extra].filter((x) => !folded.has(x)));
  // Drawn ids: a real part that holds members, or one opened by the reader; everything else is the stub of its frame.
  const stubOf = (id: string): string => {
    const par = d.info.get(id)!.parent!;
    return par === d.sys ? `other:${d.side.get(id)}` : `other:${par}`;
  };
  const shown = (id: string): string => {
    for (const x of d.chain(id)) {
      const par = d.info.get(x)!.parent!;
      const parOpenByReader = par !== d.sys && extra.has(par);
      if (!holds.has(x) && !parOpenByReader) return stubOf(x);
    }
    return id;
  };
  const nodes: TNode[] = [];
  const stubCount = new Map<string, number>();
  for (const n of d.a.nodes) {
    if (n.id === d.sys) continue;
    const s = shown(n.id);
    if (s === n.id) nodes.push({ id: n.id, parent: n.parent === d.sys ? undefined : n.parent, side: d.side.get(n.id) ?? 1, w: NODE_W, h: NODE_H });
    else if (s === stubOf(n.id)) stubCount.set(s, (stubCount.get(s) ?? 0) + 1);
  }
  for (const s of stubCount.keys()) {
    const par = s.slice(6);
    nodes.push({ id: s, parent: /^\d$/.test(par) ? undefined : par, side: /^\d$/.test(par) ? (Number(par) as 0 | 1 | 2 | 3) : 1, w: NODE_W, h: 54 });
  }
  const links: TLink[] = [];
  for (const l of d.links) {
    const f = shown(l.from), t = shown(l.to);
    if (f.startsWith("other:") && t.startsWith("other:")) continue;
    links.push({ key: l.key, from: f, to: t });
  }
  const pname = pid ? d.p!.purposes.find((q) => q.id === pid)!.name : "this PR's purposes";
  return {
    nodes,
    links,
    open,
    regions: true,
    strong: (e) => {
      const x = d.edges.get(e)!;
      return near.has(x.from) && near.has(x.to);
    },
    look: (id) => {
      if (id.startsWith("other:")) {
        const k = stubCount.get(id) ?? 0;
        return { name: `${k} other part${k === 1 ? "" : "s"}`, sub: `don't serve ${pname}`, change: "unchanged", stub: true, canOpen: false };
      }
      const all = d.within(id).size;
      const mc = memberCount(id);
      const l = baseLook(d, id);
      const owner = d.chain(id).slice(0, -1).find((x) => M.has(x));
      const how = M.has(id) ? "serves it" : owner ? `inside ${d.info.get(owner)!.name}, which serves it` : `${mc} of ${all} parts serve it`;
      return { ...l, sub: `${M.has(id) || owner ? `${d.info.get(id)!.kind} · ` : ""}${how}${l.canOpen ? " · double-click ▸" : ""}` };
    },
    real: (id) => (id.startsWith("other:") ? null : id),
  };
}

// ---------------------------------------------------------------------------------------------
// Styles

const appear = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const s = stylex.create({
  page: { backgroundColor: colors.bg, color: colors.fg, display: "flex", flexDirection: "column", fontFamily: fonts.ui, fontSize: 13, height: "100vh", margin: 0 },
  bar: { alignItems: "center", borderBottom: `1px solid ${colors.line}`, display: "flex", flexWrap: "wrap", gap: 10, padding: "8px 12px" },
  title: { fontWeight: 650 },
  muted: { color: colors.muted },
  tabs: { border: `1px solid ${colors.line}`, borderRadius: 6, display: "flex", overflow: "hidden" },
  tab: { backgroundColor: colors.bg, border: "none", borderRight: `1px solid ${colors.line}`, color: colors.fg, cursor: "pointer", padding: "4px 12px" },
  tabOn: { backgroundColor: colors.accentBg, color: colors.accentFg },
  btn: { backgroundColor: colors.bg, border: `1px solid ${colors.line}`, borderRadius: 4, color: colors.fg, cursor: "pointer", padding: "2px 8px" },
  btnOff: { cursor: "default", opacity: 0.4 },
  body: { display: "flex", flex: 1, minHeight: 0 },
  col: { display: "flex", flex: 1, flexDirection: "column", minWidth: 0 },
  head: { alignItems: "center", borderBottom: `1px solid ${colors.line}`, display: "flex", flexWrap: "wrap", gap: 8, minHeight: 34, padding: "4px 12px" },
  crumb: { backgroundColor: "transparent", border: "none", color: colors.accent, cursor: "pointer", padding: 0 },
  scroll: { flex: 1, overflow: "auto", position: "relative" },
  status: { borderTop: `1px solid ${colors.line}`, color: colors.muted, fontSize: 12, minHeight: 20, padding: "3px 12px" },
  panel: { borderLeft: `1px solid ${colors.line}`, overflow: "auto", padding: "12px 14px 80px", width: 380 },
  kind: { color: colors.muted, fontSize: 12 },
  h2: { fontSize: 17, margin: "2px 0 8px" },
  h3: { color: colors.muted, fontSize: 12, fontWeight: 650, margin: "14px 0 4px", textTransform: "uppercase" },
  p: { lineHeight: 1.45, margin: "4px 0" },
  row: { alignItems: "center", borderRadius: 4, cursor: "pointer", display: "flex", gap: 6, padding: "4px 6px" },
  rowHot: { backgroundColor: colors.hover },
  frameC: { fill: pal.modifiedTint, stroke: pal.modified, strokeWidth: 2 },
  frameU: { fill: colors.bgRaised, stroke: colors.muted, strokeDasharray: "6 4", strokeWidth: 1.5 },
  frameLabel: { fill: colors.muted, fontSize: 12, fontWeight: 650 },
  shape: { cursor: "pointer", strokeWidth: 1.5 },
  node: { fill: pal.nodeBg },
  open: { fill: "transparent" },
  group: { fill: colors.bgRaised, strokeWidth: 2.5 },
  stub: { cursor: "default", fill: colors.bgRaised, strokeDasharray: "5 4" },
  context: { opacity: 0.55, strokeDasharray: "6 4" },
  hot: { strokeWidth: 3 },
  picked: { stroke: colors.accent, strokeWidth: 3.5 },
  added: { stroke: pal.added },
  modified: { stroke: pal.modified },
  removed: { stroke: pal.removed },
  unchanged: { stroke: pal.unchanged },
  name: { fill: colors.fg, fontSize: 13, fontWeight: 600, pointerEvents: "none" },
  sub: { fill: colors.muted, fontSize: 11, pointerEvents: "none" },
  frameTitle: { cursor: "pointer", fill: colors.fg, fontSize: 13, fontWeight: 650 },
  lines: { animationDuration: "180ms", animationFillMode: "both", animationName: appear },
  line: { fill: "none", stroke: pal.lineQuiet, strokeWidth: 1.5 },
  lineChanged: { stroke: pal.line },
  lineStrong: { stroke: pal.c0, strokeWidth: 2.5 },
  faint: { opacity: 0.2 },
  lineHot: { stroke: colors.accent, strokeWidth: 3 },
  hit: { cursor: "pointer", fill: "none", pointerEvents: "stroke", stroke: "transparent", strokeWidth: 10 },
  headQ: { fill: pal.lineQuiet },
  headC: { fill: pal.line },
  headS: { fill: pal.c0 },
  headHot: { fill: colors.accent },
  trunk: { fill: "none", opacity: 0.45, stroke: pal.lineQuiet, strokeLinecap: "butt", strokeLinejoin: "round", strokeWidth: "var(--tw)", pointerEvents: "none" },
  trunkChanged: { stroke: pal.line },
  dot: { stroke: colors.bg, strokeWidth: 1 },
  chip: { borderRadius: "50%", display: "inline-block", flexShrink: 0, height: 9, width: 9 },
  switcher: {
    alignItems: "center",
    backgroundColor: colors.fg,
    borderRadius: 999,
    bottom: 14,
    boxShadow: `0 6px 20px ${colors.popShadow}`,
    color: colors.bg,
    display: "flex",
    gap: 10,
    left: "50%",
    padding: "6px 10px",
    position: "fixed",
    transform: "translateX(-50%)",
    zIndex: 5,
  },
  swBtn: { backgroundColor: "transparent", border: "none", color: colors.bg, cursor: "pointer", fontSize: 15 },
  backBar: { backgroundColor: colors.accentBg, border: "none", borderRadius: 4, color: colors.accentFg, cursor: "pointer", padding: "3px 10px" },
});
const dotFill = stylex.create({
  c0: { fill: pal.c0, backgroundColor: pal.c0 },
  c1: { fill: pal.c1, backgroundColor: pal.c1 },
  c2: { fill: pal.c2, backgroundColor: pal.c2 },
  c3: { fill: pal.c3, backgroundColor: pal.c3 },
  c4: { fill: pal.c4, backgroundColor: pal.c4 },
  c5: { fill: pal.c5, backgroundColor: pal.c5 },
  c6: { fill: pal.c6, backgroundColor: pal.c6 },
  c7: { fill: pal.c7, backgroundColor: pal.c7 },
});
const SW = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"] as const;

// ---------------------------------------------------------------------------------------------
// The board: one drawn canvas (our layout, open and fold glide), whatever scene it's handed

interface BoardProps {
  d: Data;
  scene: Scene;
  selected: string | null;
  litEdges: Set<string>;
  onPick: (id: string) => void;
  onOpen: (id: string) => void;
  onFold: (id: string) => void;
  onLine: (members: string[]) => void;
  onBackground: () => void;
  setStatus: (t: string) => void;
}

function Board(props: BoardProps) {
  const d = props.d;
  const swatch = (pid: string) => dotFill[SW[d.tops.indexOf(pid) % 8]!];
  const fillOf = (open: boolean, group: boolean) => (open ? s.open : group ? s.group : s.node);
  const changeStroke = (c: Change) => (c === "added" ? s.added : c === "removed" ? s.removed : c === "modified" ? s.modified : s.unchanged);
  const [scale, setScale] = createSignal(Number(params.get("z") ?? 0.6));
  let el!: HTMLDivElement;
  let last: Nested | undefined;
  /** Every scene's look of every id it drew: a part leaving mid-glide keeps the look it had. */
  const looks = new Map<string, Look>();
  const lookOf = (sc: Scene, id: string): Look => {
    if (sc.nodes.some((n) => n.id === id)) looks.set(id, sc.look(id));
    return looks.get(id) ?? { name: id, sub: "", change: "unchanged", canOpen: false };
  };
  const laid = createMemo(() => {
    const sc = props.scene;
    const n = nestedLayout(sc.nodes, sc.links, sc.open, { mode: "street", labelRoom: 30 }, last);
    last = n;
    return { n, sc };
  });
  const parentOf = createMemo(() => new Map(laid().sc.nodes.map((n) => [n.id, n.parent])));
  const ancestors = (id: string): string[] => {
    const p = parentOf().get(id);
    return p ? [p, ...ancestors(p)] : [];
  };

  // Glide (as the nested lab): arrivals grow out of the block that holds them, leavers shrink back in.
  type Shown = { x: number; y: number; w: number; h: number; o: number; open: boolean; depth: number };
  type Frame = { boxes: Map<string, Shown>; regions: Nested["regions"]; width: number; height: number; moving: boolean };
  const [frame, setFrame] = createSignal<Frame | null>(null);
  const [order, setOrder] = createSignal<string[]>([]);
  let raf = 0;
  createEffect(
    () => laid(),
    (l) => {
      cancelAnimationFrame(raf);
      const to = new Map([...l.n.boxes].map(([id, b]) => [id, { ...b, o: 1 }]));
      const was = frame();
      const end: Frame = { boxes: to, regions: l.n.regions, width: l.n.width, height: l.n.height, moving: false };
      const byDepth = (m: Map<string, Shown>) => [...m].sort((a, b) => a[1].depth - b[1].depth || Number(b[1].open) - Number(a[1].open)).map(([id]) => id);
      if (!was || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setOrder(byDepth(to));
        setFrame(end);
        return;
      }
      const holder = (id: string, boxes: Map<string, Shown>) => {
        let p = d.info.get(id)?.parent;
        while (p && !boxes.has(p)) p = d.info.get(p)?.parent;
        return p;
      };
      const from = new Map<string, Shown>();
      const goal = new Map<string, Shown>();
      for (const [id, b] of to) {
        const p = was.boxes.get(id);
        const h = p ? undefined : holder(id, was.boxes);
        const hb = h ? was.boxes.get(h)! : undefined;
        from.set(id, p ? { ...p, o: 1 } : hb ? { ...b, x: hb.x + 12, y: hb.y + 30, w: b.w * 0.4, h: b.h * 0.4, o: 0 } : { ...b, o: 0 });
        goal.set(id, b);
      }
      for (const [id, p] of was.boxes) {
        if (to.has(id)) continue;
        const h = holder(id, to);
        const hb = h ? to.get(h)! : undefined;
        from.set(id, { ...p, o: 1 });
        goal.set(id, hb ? { ...p, x: hb.x + 12, y: hb.y + 30, w: p.w * 0.4, h: p.h * 0.4, o: 0 } : { ...p, o: 0 });
      }
      setOrder(byDepth(from).concat(byDepth(to).filter((id) => !from.has(id))));
      const rf = was.regions;
      const t0 = performance.now();
      const mix = (a: number, b: number, t: number) => a + (b - a) * t;
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / glide);
        const e = glideCurve(t);
        if (t >= 1) {
          setOrder(byDepth(to));
          setFrame(end);
          return;
        }
        const boxes = new Map<string, Shown>();
        for (const [id, a] of from) {
          const b = goal.get(id)!;
          boxes.set(id, { x: mix(a.x, b.x, e), y: mix(a.y, b.y, e), w: mix(a.w, b.w, e), h: mix(a.h, b.h, e), o: mix(a.o, b.o, e), open: a.open || b.open, depth: b.depth });
        }
        const regions = l.n.regions.map((r) => {
          const q = rf.find((x) => x.key === r.key) ?? r;
          return { ...r, x: mix(q.x, r.x, e), y: mix(q.y, r.y, e), w: mix(q.w, r.w, e), h: mix(q.h, r.h, e) };
        });
        setFrame({ boxes, regions, width: Math.max(was.width, l.n.width), height: Math.max(was.height, l.n.height), moving: true });
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    },
  );

  // Keep the picked part on screen once things settle.
  createEffect(
    () => [props.selected, frame()?.moving] as const,
    ([id, moving]) => {
      if (!id || moving || !el) return;
      const b = laid().n.boxes.get(id);
      if (!b) return;
      const sc = scale();
      const x = b.x * sc, y = b.y * sc;
      if (x < el.scrollLeft || x + b.w * sc > el.scrollLeft + el.clientWidth || y < el.scrollTop || y + b.h * sc > el.scrollTop + el.clientHeight)
        el.scrollTo({ left: x - el.clientWidth / 2 + (b.w * sc) / 2, top: y - el.clientHeight / 3, behavior: "smooth" });
    },
  );

  const [hoverLine, setHoverLine] = createSignal<string | null>(null);
  const [hoverNode, setHoverNode] = createSignal<string | null>(null);
  /** Scope lines lit: the hovered line, the hovered or picked part's lines, the panel's lit lines. */
  const lit = createMemo(() => {
    const n = laid().n;
    const out = new Set<string>();
    const light = (sl: string) => {
      for (const m of n.lines.get(sl)?.members ?? []) for (const k of n.drawnAs.get(m) ?? []) out.add(k);
    };
    const h = hoverLine();
    if (h) light(h);
    const at = hoverNode() ?? props.selected;
    if (at) for (const l of n.lines.values()) if (l.from === at || l.to === at) light(l.key);
    for (const e of props.litEdges) for (const k of n.drawnAs.get(e) ?? []) out.add(k);
    return out;
  });

  const fit = () => setScale(Math.min(1, Math.max(0.08, (el.clientWidth - 24) / laid().n.width, 0)));
  let clickT = 0;

  return (
    <div {...stylex.attrs(s.col)}>
      <div {...stylex.attrs(s.head)}>
        <button {...stylex.attrs(s.btn)} onClick={() => setScale((v) => Math.max(0.08, v / 1.25))}>
          −
        </button>
        <button {...stylex.attrs(s.btn)} onClick={() => setScale((v) => Math.min(2, v * 1.25))}>
          +
        </button>
        <button {...stylex.attrs(s.btn)} onClick={fit}>
          Fit
        </button>
        <span {...stylex.attrs(s.muted)}>
          {Math.round(laid().n.width)} × {Math.round(laid().n.height)} px · {laid().n.boxes.size} drawn
        </span>
      </div>
      <div
        ref={el}
        {...stylex.attrs(s.scroll)}
        onClick={(e) => {
          if (!(e.target as Element).closest("[data-hit]")) props.onBackground();
        }}
      >
        <Show when={frame()}>
          {(f) => (
            <svg width={f().width * scale()} height={f().height * scale()} viewBox={`0 0 ${f().width} ${f().height}`}>
              <Show when={laid().sc.regions}>
                <For each={f().regions}>
                  {(r) => (
                    <g>
                      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={10} {...stylex.attrs(r.key === "C" ? s.frameC : s.frameU)} />
                      <text x={r.x + 14} y={r.y + 26} {...stylex.attrs(s.frameLabel)}>
                        {r.key === "C" ? "Changed" : "Not changed"}
                      </text>
                    </g>
                  )}
                </For>
              </Show>
              <For each={order()}>
                {(id) => {
                  const b = createMemo(() => f().boxes.get(id) ?? { x: 0, y: 0, w: 0, h: 0, o: 0, open: false, depth: 0 });
                  const look = createMemo(() => lookOf(laid().sc, id));
                  const fillS = createMemo(() => fillOf(b().open, !!look().group));
                  const strokeS = createMemo(() => changeStroke(look().change));
                  return (
                    <g
                      data-hit
                      transform={`translate(${b().x} ${b().y})`}
                      opacity={b().o}
                      onMouseEnter={() => (setHoverNode(id), props.setStatus(`${look().name} · ${look().sub}`))}
                      onMouseLeave={() => (setHoverNode(null), props.setStatus(""))}
                      onClick={(e) => {
                        e.stopPropagation();
                        // A click on an open frame's title folds it; elsewhere a click picks and a double-click opens.
                        const now = performance.now();
                        if (now - clickT < 320) return;
                        clickT = now;
                        if (b().open && (e.target as Element).closest("[data-title]")) return props.onFold(id);
                        if (!look().stub && !b().open) props.onPick(id);
                        else if (b().open) props.onPick(id);
                      }}
                      onDblClick={(e) => {
                        e.stopPropagation();
                        if (!b().open && look().canOpen) props.onOpen(id);
                      }}
                    >
                      <rect
                        width={b().w}
                        height={b().h}
                        rx={b().open ? 10 : 8}
                        {...stylex.attrs(
                          s.shape,
                          fillS(),
                          strokeS(),
                          look().stub && s.stub,
                          look().context && s.context,
                          hoverNode() === id && s.hot,
                          props.selected === id && s.picked,
                        )}
                      />
                      <Show
                        when={b().open}
                        fallback={
                          <>
                            <text x={12} y={look().stub ? 24 : 28} {...stylex.attrs(s.name)}>
                              {clip(look().name, 26)}
                            </text>
                            <Show when={b().h > 40}>
                              <text x={12} y={look().stub ? 42 : 48} {...stylex.attrs(s.sub)}>
                                {clip(look().sub, 34)}
                              </text>
                            </Show>
                          </>
                        }
                      >
                        <text data-title x={12} y={22} {...stylex.attrs(s.frameTitle)}>
                          ▾ {look().name}
                        </text>
                      </Show>
                      <For each={look().dots ?? []}>
                        {(pid, i) => {
                          const sw = createMemo(() => swatch(pid));
                          return <circle cx={b().w - 12 - i() * 13} cy={12} r={5} {...stylex.attrs(s.dot, sw())} />;
                        }}
                      </For>
                    </g>
                  );
                }}
              </For>
              <Show when={!f().moving && laid()} keyed>
                {(l) => (
                  <g {...stylex.attrs(s.lines)}>
                    <For each={l.n.trunks}>
                      {(t) => (
                        <path
                          d={rounded(t.pts)}
                          style={{ "--tw": `${t.width}px` }}
                          {...stylex.attrs(
                            s.trunk,
                            t.members.some((m) => l.n.lines.get(m)!.members.some((e) => d.edges.get(e)!.change !== "unchanged")) && s.trunkChanged,
                            !!l.sc.strong && !t.members.some((m) => l.n.lines.get(m)!.members.some((e) => l.sc.strong!(e))) && s.faint,
                          )}
                        />
                      )}
                    </For>
                    <For each={[...l.n.routes]}>
                      {([k, pts]) => {
                        const sl = l.n.lines.get(k)!;
                        const changed = sl.members.some((m) => d.edges.get(m)!.change !== "unchanged");
                        const strong = l.sc.strong ? sl.members.some((m) => l.sc.strong!(m)) : undefined;
                        const hot = createMemo(() => lit().has(k));
                        return (
                          <g>
                            <path d={rounded(pts)} {...stylex.attrs(s.line, changed && s.lineChanged, strong && s.lineStrong, strong === false && s.faint, hot() && s.lineHot)} />
                            <Show when={!sl.to.startsWith("stub:")}>
                              <path d={arrow(tipOf(pts, true))} {...stylex.attrs(s.headQ, changed && s.headC, strong && s.headS, strong === false && s.faint, hot() && s.headHot)} />
                            </Show>
                            <path
                              data-hit
                              d={rounded(pts)}
                              {...stylex.attrs(s.hit)}
                              onMouseEnter={() => (setHoverLine(k), props.setStatus(lineText(d, sl.members)))}
                              onMouseLeave={() => (setHoverLine(null), props.setStatus(""))}
                              onClick={(e) => (e.stopPropagation(), props.onLine(sl.members))}
                            />
                          </g>
                        );
                      }}
                    </For>
                  </g>
                )}
              </Show>
            </svg>
          )}
        </Show>
      </div>
    </div>
  );
}

function lineText(d: Data, members: string[]): string {
  if (members.length > 1) return `${members.length} connections: ${members.slice(0, 3).map((m) => d.edges.get(m)!.label).join("; ")}${members.length > 3 ? "…" : ""}`;
  const e = d.edges.get(members[0]!)!;
  return `${d.info.get(e.from)!.name} → ${d.info.get(e.to)!.name}: ${e.label}`;
}

// ---------------------------------------------------------------------------------------------
// The app: shared selection and panel, each canvas keeping its own state

function App(props: { d: Data }) {
  const d = props.d;
  const [shape, setShapeRaw] = createSignal<ShapeKey>((params.get("v") as ShapeKey) ?? "one");
  const [tab, setTabRaw] = createSignal<Tab>((params.get("tab") as Tab) ?? (shape() === "one" ? "canvas" : "graph"));
  const setShape = (step: number) => {
    const i = (SHAPES.findIndex((x) => x.key === shape()) + step + SHAPES.length) % SHAPES.length;
    const k = SHAPES[i]!.key;
    setShapeRaw(k);
    setTab(k === "one" ? "canvas" : "graph");
    sync("v", k);
  };
  const setTab = (t: Tab) => (setTabRaw(t), sync("tab", t));
  const [sel, setSelRaw] = createSignal<Sel>(null);
  const setSel = (x: Sel) => setSelRaw(x);
  const [status, setStatus] = createSignal("");
  const [litEdges, setLitEdges] = createSignal<Set<string>>(new Set());

  // Where the panel stands for purposes: the last purpose stood on, or the whole PR. Picking a part keeps it.
  const hasPurposes = d.p !== null && d.p.purposes.length > 0;
  const [standing, setStanding] = createSignal<string | null>(null);
  createEffect(
    () => sel(),
    (x) => {
      if (x === null) setStanding(null);
      else if (x.kind === "purpose") setStanding(x.id);
    },
  );
  /** The purpose fold is on until "Code view at ‹part›" leaves for the code view. */
  const [codeView, setCodeView] = createSignal(!hasPurposes);

  // Purpose fold state (shared by whichever canvas shows it): the reader's opens and folds, with Back.
  const [pOpen, setPOpen] = createSignal<Set<string>>(new Set());
  const [pFold, setPFold] = createSignal<Set<string>>(new Set());
  const [pHist, setPHist] = createSignal<{ open: Set<string>; fold: Set<string>; what: string }[]>([]);
  createEffect(
    () => standing(),
    () => {
      setPOpen(new Set<string>());
      setPFold(new Set<string>());
      setPHist([]);
    },
  );
  const pStep = (what: string, open: Set<string>, fold: Set<string>) => {
    setPHist((h) => [...h, { open: pOpen(), fold: pFold(), what }]);
    setPOpen(open);
    setPFold(fold);
  };
  const pBack = () => {
    const h = pHist();
    if (!h.length) return;
    const last = h[h.length - 1]!;
    setPOpen(last.open);
    setPFold(last.fold);
    setPHist(h.slice(0, -1));
  };

  // One canvas: its own opens. Three canvases: the drawn graph's zoom and opens, and Clusters' opens.
  const [oneOpen, setOneOpen] = createSignal<Set<string>>(new Set());
  const [zoom, setZoom] = createSignal<string | null>(null);
  const [cOpen, setCOpen] = createSignal<Set<string>>(new Set());

  /** `o` without `id` and anything opened inside it (in the scene's own nesting, groups included). */
  const withoutInside = (sc: Scene, o: Set<string>, id: string) => {
    const par = new Map(sc.nodes.map((n) => [n.id, n.parent]));
    const under = (x: string): boolean => {
      for (let p = par.get(x); p; p = par.get(p)) if (p === id) return true;
      return false;
    };
    return new Set([...o].filter((x) => x !== id && !under(x)));
  };

  const purposeOn = () => hasPurposes && !codeView();
  const oneScene = createMemo(() => (purposeOn() ? purposeScene(d, standing(), pOpen(), pFold()) : plainScene(d, oneOpen())));
  const graphScene = createMemo(() => (purposeOn() ? purposeScene(d, standing(), pOpen(), pFold()) : zoom() ? zoomScene(d, zoom()!, new Set()) : plainScene(d, new Set())));
  const clusterScene = createMemo(() => {
    // Clusters' groups hold the top-level parts: folding a group drops opens inside it.
    return clustersScene(d, cOpen());
  });

  const pickNode = (id: string) => setSel({ kind: "node", id });
  const leaveToCode = (id: string) => {
    // "Code view at ‹part›": one canvas opens the part's chain in place; three canvases zoom the drawn graph into it.
    setCodeView(true);
    if (shape() === "one") setOneOpen(new Set(d.chain(id).filter((x) => x !== id || (d.kids.get(x)?.length ?? 0) > 0)));
    else setZoom((d.kids.get(id)?.length ?? 0) > 0 ? id : (d.chain(id).at(-2) ?? null));
    setSel({ kind: "node", id });
  };
  const backToPurpose = () => (setCodeView(false), setSel(standing() ? { kind: "purpose", id: standing()! } : null));

  const boardFor = (which: "one" | "graph" | "clusters") => {
    const scene = () => (which === "one" ? oneScene() : which === "graph" ? graphScene() : clusterScene());
    const selected = () => {
      const x = sel();
      if (x?.kind !== "node") return null;
      // The drawn box for the picked part: itself, or the nearest drawn block holding it.
      const ids = new Set(scene().nodes.map((n) => n.id));
      for (const c of [...d.chain(x.id)].reverse()) if (ids.has(c)) return c;
      return null;
    };
    const onOpen = (id: string) => {
      if (which === "clusters") return setCOpen((o) => new Set([...o, id]));
      if (purposeOn()) return pStep(`opened ${d.info.get(id)?.name ?? id}`, new Set([...pOpen(), id]), new Set([...pFold()].filter((x) => x !== id)));
      if (which === "one") return setOneOpen((o) => new Set([...o, id]));
      setZoom(id); // the drawn graph: a double-click zooms into the part
      setSel({ kind: "node", id });
    };
    const onFold = (id: string) => {
      if (which === "clusters") return setCOpen((o) => withoutInside(scene(), o, id));
      if (purposeOn()) return pStep(`folded ${d.info.get(id)?.name ?? id}`, withoutInside(scene(), pOpen(), id), new Set([...pFold(), id]));
      if (which === "one") return setOneOpen((o) => withoutInside(scene(), o, id));
      // The drawn graph's zoom frame: folding its title goes up one level.
      const up = d.chain(id).at(-2) ?? null;
      setZoom(up);
    };
    return (
      <Board
        d={d}
        scene={scene()}
        selected={selected()}
        litEdges={litEdges()}
        onPick={(id) => {
          const r = scene().real(id);
          if (r) pickNode(r);
          else if (id.startsWith("g:")) setSel(null);
        }}
        onOpen={onOpen}
        onFold={onFold}
        onLine={(members) => setSel({ kind: "line", members })}
        onBackground={() => setSel(purposeOn() && standing() ? { kind: "purpose", id: standing()! } : null)}
        setStatus={setStatus}
      />
    );
  };

  const pathView = createMemo(() => d.m.view(d.sys, "all" as Lens, false));
  const pathApi: Api = {
    selected: () => {
      const x = sel();
      return x?.kind === "node" ? x.id : null;
    },
    select: (id) => setSel({ kind: "node", id }),
    selectEdges: (ids) => setSel({ kind: "line", members: ids }),
    open: () => {},
    hoverNode: () => {},
    hoverEdge: () => {},
    groupOf: () => undefined,
  };

  addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select")) return;
    if (e.key === "ArrowLeft") setShape(-1);
    if (e.key === "ArrowRight") setShape(1);
    if (e.key === "Escape") setSel(null);
    if (e.key === "Backspace" && shape() === "three" && tab() === "graph" && zoom()) setZoom(d.chain(zoom()!).at(-2) ?? null);
  });

  const tabs = () =>
    shape() === "one"
      ? ([["canvas", "Canvas"], ["path", "Path"]] as const)
      : ([["graph", "Drawn graph"], ["clusters", "Clusters"], ["path", "Path"]] as const);
  const purposeName = (id: string | null) => (id ? d.p!.purposes.find((q) => q.id === id)!.name : "all purposes");

  return (
    <div {...stylex.attrs(s.page)}>
      <div {...stylex.attrs(s.bar)}>
        <span {...stylex.attrs(s.title)}>
          {d.a.pr.repo}#{d.a.pr.number} {clip(d.a.pr.title, 60)}
        </span>
        <div {...stylex.attrs(s.tabs)} role="tablist">
          <For each={tabs()}>
            {([k, label]) => (
              <button role="tab" onClick={() => setTab(k)} {...stylex.attrs(s.tab, tab() === k && s.tabOn)}>
                {label}
              </button>
            )}
          </For>
        </div>
        <Show when={hasPurposes && (tab() === "canvas" || tab() === "graph")}>
          <Show
            when={purposeOn()}
            fallback={
              <button {...stylex.attrs(s.backBar)} onClick={backToPurpose}>
                ← Back to {purposeName(standing())}
              </button>
            }
          >
            <span {...stylex.attrs(s.muted)}>Showing {purposeName(standing())}, the rest folded</span>
            <button {...stylex.attrs(s.btn, !pHist().length && s.btnOff)} onClick={pBack} title={pHist().length ? `undoes: ${pHist().at(-1)!.what}` : ""}>
              ← Back{pHist().length ? ` (undoes: ${clip(pHist().at(-1)!.what, 30)})` : ""}
            </button>
            <button {...stylex.attrs(s.btn)} onClick={() => (setPOpen(new Set<string>()), setPFold(new Set<string>()), setPHist([]))}>
              Start over
            </button>
            <Show when={sel()?.kind === "node"}>
              <button {...stylex.attrs(s.btn)} onClick={() => leaveToCode((sel() as { id: string }).id)}>
                Code view at {d.info.get((sel() as { id: string }).id)!.name} ›
              </button>
            </Show>
          </Show>
        </Show>
        <Show when={shape() === "three" && tab() === "graph" && !purposeOn()}>
          <span {...stylex.attrs(s.muted)}>Zoom:</span>
          <button {...stylex.attrs(s.crumb)} onClick={() => setZoom(null)}>
            System
          </button>
          <For each={zoom() ? d.chain(zoom()!) : []}>
            {(c) => (
              <>
                <span {...stylex.attrs(s.muted)}>›</span>
                <button {...stylex.attrs(s.crumb)} onClick={() => setZoom(c)}>
                  {d.info.get(c)!.name}
                </button>
              </>
            )}
          </For>
        </Show>
      </div>
      <div {...stylex.attrs(s.body)}>
        <div {...stylex.attrs(s.col)}>
          {/* Every canvas stays mounted, so switching keeps its state; only the shown one is visible. */}
          <Show when={shape() === "one" && tab() === "canvas"}>{boardFor("one")}</Show>
          <Show when={shape() === "three" && tab() === "graph"}>{boardFor("graph")}</Show>
          <Show when={shape() === "three" && tab() === "clusters"}>{boardFor("clusters")}</Show>
          <Show when={tab() === "path"}>
            <div {...stylex.attrs(s.scroll)}>
              <Explore kind="path" m={d.m} view={pathView()} api={pathApi} />
            </div>
          </Show>
          <div {...stylex.attrs(s.status)}>{status() || "Click picks · double-click opens · click an open frame's title to fold it"}</div>
        </div>
        <aside {...stylex.attrs(s.panel)}>
          <PanelView d={d} sel={sel()} setSel={setSel} standing={standing()} setLit={setLitEdges} />
        </aside>
      </div>
      <div {...stylex.attrs(s.switcher)}>
        <button {...stylex.attrs(s.swBtn)} onClick={() => setShape(-1)}>
          ←
        </button>
        <span>
          <b>{shape()}</b> — {SHAPES.find((x) => x.key === shape())!.name}
        </span>
        <button {...stylex.attrs(s.swBtn)} onClick={() => setShape(1)}>
          →
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The shared panel (a stand-in for the walkthrough panel: enough to see what selection does)

function PanelView(props: { d: Data; sel: Sel; setSel: (x: Sel) => void; standing: string | null; setLit: (s: Set<string>) => void }) {
  const d = props.d;
  const Row = (rp: { onClick: () => void; edges?: string[]; children: JSX.Element }) => (
    <div
      {...stylex.attrs(s.row)}
      onClick={rp.onClick}
      onMouseEnter={() => props.setLit(new Set(rp.edges ?? []))}
      onMouseLeave={() => props.setLit(new Set())}
    >
      {rp.children}
    </div>
  );
  const Chip = (cp: { pid: string }) => {
    const top = () => d.p!.purposes.find((q) => q.id === cp.pid)!;
    const t = () => top().parent ?? cp.pid;
    const sw = createMemo(() => dotFill[SW[d.tops.indexOf(t()) % 8]!]);
    return <span {...stylex.attrs(s.chip, sw())} />;
  };
  const x = () => props.sel;
  return (
    <>
      <Show when={x() === null}>
        <div {...stylex.attrs(s.kind)}>The whole PR{d.p ? ` · ${d.tops.length} purposes` : ""}</div>
        <h2 {...stylex.attrs(s.h2)}>{d.a.pr.title}</h2>
        <Show when={d.p}>
          <p {...stylex.attrs(s.p)}>{d.p!.walk.intro} {d.p!.walk.journey}</p>
          <h3 {...stylex.attrs(s.h3)}>Its purposes, in order</h3>
          <For each={d.p!.purposes.filter((q) => !q.parent)}>
            {(q, i) => (
              <Row onClick={() => props.setSel({ kind: "purpose", id: q.id })} edges={q.edges.map((e) => e.edge)}>
                <Chip pid={q.id} />
                {i() + 1}. {q.name}
              </Row>
            )}
          </For>
        </Show>
      </Show>
      <Show when={x()?.kind === "purpose" && d.p!.purposes.find((q) => q.id === (x() as { id: string }).id)}>
        {(q) => (
          <>
            <div>
              <button {...stylex.attrs(s.crumb)} onClick={() => props.setSel(q().parent ? { kind: "purpose", id: q().parent! } : null)}>
                ‹ {q().parent ? d.p!.purposes.find((z) => z.id === q().parent)!.name : "The whole PR"}
              </button>
            </div>
            <div {...stylex.attrs(s.kind)}>
              {q().parent ? "Sub-purpose" : "Purpose"} · {q().kind}
            </div>
            <h2 {...stylex.attrs(s.h2)}>
              <Chip pid={q().id} /> {q().name}
            </h2>
            <p {...stylex.attrs(s.p)}>
              {q().walk.intro} {q().walk.journey} {q().walk.destination}
            </p>
            <h3 {...stylex.attrs(s.h3)}>The journey</h3>
            <For each={q().stops}>
              {(st, i) => (
                <Row
                  onClick={() => props.setSel(st.kind === "purpose" ? { kind: "purpose", id: st.id } : st.kind === "node" ? { kind: "node", id: st.id } : { kind: "line", members: [st.id] })}
                  edges={st.kind === "edge" ? [st.id] : []}
                >
                  {i() + 1}. {st.kind === "purpose" ? d.p!.purposes.find((z) => z.id === st.id)?.name : st.kind === "node" ? d.info.get(st.id)?.name : "a connection"}
                  <span {...stylex.attrs(s.muted)}> · {clip(st.line, 60)}</span>
                </Row>
              )}
            </For>
          </>
        )}
      </Show>
      <Show when={x()?.kind === "node" && d.info.get((x() as { id: string }).id)}>
        {(n) => {
          const ins = () => d.a.edges.filter((e) => e.to === n().id);
          const outs = () => d.a.edges.filter((e) => e.from === n().id);
          const roles = () => (d.p?.purposes ?? []).flatMap((q) => q.serves.filter((sv) => sv.node === n().id).map((sv) => ({ q, role: sv.role })));
          return (
            <>
              <div>
                <For each={d.chain(n().id).slice(0, -1)}>
                  {(c) => (
                    <button {...stylex.attrs(s.crumb)} onClick={() => props.setSel({ kind: "node", id: c })}>
                      {d.info.get(c)!.name} ›{" "}
                    </button>
                  )}
                </For>
              </div>
              <div {...stylex.attrs(s.kind)}>
                Part · {n().kind} · {n().change}
                {props.standing ? ` · standing on ${d.p!.purposes.find((q) => q.id === props.standing)!.name}` : ""}
              </div>
              <h2 {...stylex.attrs(s.h2)}>{n().name}</h2>
              <p {...stylex.attrs(s.p)}>{n().summary}</p>
              <Show when={d.p}>
                <h3 {...stylex.attrs(s.h3)}>In this PR's purposes</h3>
                <Show when={roles().length} fallback={<p {...stylex.attrs(s.p, s.muted)}>None: the PR's purposes don't pass through it.</p>}>
                  <For each={roles()}>
                    {(r) => (
                      <Row onClick={() => props.setSel({ kind: "purpose", id: r.q.id })}>
                        <Chip pid={r.q.id} />
                        {r.q.name}
                        <span {...stylex.attrs(s.muted)}> · {clip(r.role, 50)}</span>
                      </Row>
                    )}
                  </For>
                </Show>
              </Show>
              <Show when={(d.kids.get(n().id) ?? []).length}>
                <h3 {...stylex.attrs(s.h3)}>Inside it</h3>
                <For each={d.kids.get(n().id)}>
                  {(k) => <Row onClick={() => props.setSel({ kind: "node", id: k })}>{d.info.get(k)!.name}</Row>}
                </For>
              </Show>
              <h3 {...stylex.attrs(s.h3)}>Uses or sends to ({outs().length})</h3>
              <For each={outs()}>
                {(e) => (
                  <Row onClick={() => props.setSel({ kind: "line", members: [e.id] })} edges={[e.id]}>
                    → {d.info.get(e.to)!.name}
                    <span {...stylex.attrs(s.muted)}> · {clip(e.label, 40)}</span>
                  </Row>
                )}
              </For>
              <h3 {...stylex.attrs(s.h3)}>Uses it or sends to it ({ins().length})</h3>
              <For each={ins()}>
                {(e) => (
                  <Row onClick={() => props.setSel({ kind: "line", members: [e.id] })} edges={[e.id]}>
                    ← {d.info.get(e.from)!.name}
                    <span {...stylex.attrs(s.muted)}> · {clip(e.label, 40)}</span>
                  </Row>
                )}
              </For>
            </>
          );
        }}
      </Show>
      <Show when={x()?.kind === "line"}>
        <div {...stylex.attrs(s.kind)}>Connection{(x() as { members: string[] }).members.length > 1 ? "s" : ""}</div>
        <For each={(x() as { members: string[] }).members}>
          {(m) => {
            const e = d.edges.get(m)!;
            return (
              <div>
                <h2 {...stylex.attrs(s.h2)}>
                  <button {...stylex.attrs(s.crumb)} onClick={() => props.setSel({ kind: "node", id: e.from })}>
                    {d.info.get(e.from)!.name}
                  </button>{" "}
                  →{" "}
                  <button {...stylex.attrs(s.crumb)} onClick={() => props.setSel({ kind: "node", id: e.to })}>
                    {d.info.get(e.to)!.name}
                  </button>
                </h2>
                <p {...stylex.attrs(s.p)}>
                  {e.label} <span {...stylex.attrs(s.muted)}>· {e.kind} · {e.change}</span>
                </p>
              </div>
            );
          }}
        </For>
      </Show>
    </>
  );
}

// ---------------------------------------------------------------------------------------------

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

function glideCurve(t: number): number {
  const x1 = 0.4, y1 = 0, x2 = 0.2, y2 = 1;
  const bx = (u: number) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const by = (u: number) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bx(mid) < t) lo = mid;
    else hi = mid;
  }
  return by((lo + hi) / 2);
}

function tipOf(pts: P[], end: boolean) {
  const t = tidy(pts);
  const [a, b] = end ? [t[t.length - 2]!, t[t.length - 1]!] : [t[1]!, t[0]!];
  const sg = (v: number) => (Math.abs(v) < 0.5 ? 0 : Math.sign(v));
  return { x: b.x, y: b.y, dx: sg(b.x - a.x), dy: sg(b.y - a.y) };
}

async function main() {
  const load = loaders[`./data/${name}.json`];
  if (!load) {
    document.getElementById("root")!.textContent = `No data/${name}.json`;
    return;
  }
  const a = structuredClone(await load());
  const ov = overlays[`./data/overlays/${name}.json`];
  if (ov && params.get("overlay") !== "0") a.edges.push(...(await ov()).edges);
  const pl = purposeLoaders[`./data/purposes/${name}.json`];
  const p = pl ? await pl() : null;
  document.title = `#${a.pr.number} · one canvas or three (prototype)`;
  render(() => <App d={prepare(a, p)} />, document.getElementById("root")!);
}
void main();
