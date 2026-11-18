// PROTOTYPE (PR view). Renders one PR analysis (schema.ts) from ./data/<name>.json, chosen by
// `?a=<name>`: a graph with four lenses (modules, data flow, external, order of actions), zoom
// along the node hierarchy, colour by a facet, and a drill-down panel from questions to claims to
// the exact lines. Dev only: Vite serves /prototype-pr-view/index.html.
import { render, type JSX } from "@solidjs/web";
import { createMemo, createSignal, flush, For, Show } from "solid-js";
import * as stylex from "@stylexjs/stylex";
import { colors, fonts } from "../src/tokens.stylex.ts";
import { pal } from "./tokens.stylex.ts";
import { arrow, labelWidth, layout, NODE_H, NODE_W, type Laid, type Placed } from "./layout.ts";
import { Model, type Lens, type RankItem, type VisEdge } from "./model.ts";
import { Explore, type Api, type ExploreKind } from "./explore.tsx";
import type { Analysis, Change, Claim, Edge, FacetAssignment, Node, Question, Topic } from "./schema.ts";

const loaders = import.meta.glob<Analysis>("./data/*.json", { import: "default" });
// TOP-LEVEL VARIANTS (#144): made-up edges laid over an analysis (data/overlays/, gitignored), to
// see the layout at a realistic density. Not from the agent; ?overlay=0 leaves them out.
const overlays = import.meta.glob<{ edges: Edge[] }>("./data/overlays/*.json", { import: "default" });
const names = Object.keys(loaders).map((k) => k.replace("./data/", "").replace(/\.json$/, ""));

// ---------------------------------------------------------------------------------------------
// State, kept in the URL so a reload or a shared link lands on the same place.

type Sel =
  | { kind: "node"; id: string }
  | { kind: "edge"; ids: string[] }
  | { kind: "step"; scenario: string; i: number }
  | { kind: "boundary"; id: string }
  | { kind: "group"; facet: string; value: string }
  | null;

const params = new URLSearchParams(location.search);
const [focus, setFocusRaw] = createSignal<string | null>(params.get("focus"));
const [lens, setLensRaw] = createSignal<Lens>((params.get("lens") as Lens) ?? "modules");
const [colorBy, setColorByRaw] = createSignal<string>(params.get("color") ?? "change");
const [changedOnly, setChangedOnly] = createSignal(params.get("changed") === "1");
/** What the graph shows: the whole system, the change and what it connects to, or changed parts only. */
type Scope = "all" | "near" | "changed";
const [scope, setScopeRaw] = createSignal<Scope>(params.get("changed") === "1" ? "changed" : ((params.get("scope") as Scope) ?? "all"));
const setScope = (x: Scope) => (setScopeRaw(x), setChangedOnly(x === "changed"), setZoom(null), sync());
const [sel, setSel] = createSignal<Sel>(null);
/** What the pointer is over in the graph: a node's id or an edge bundle's key. */
const [hover, setHover] = createSignal<{ node?: string; edge?: string; ids?: string[] } | null>(null);
/** The pointer, in viewport coordinates, for placing the hover card. */
const [pointer, setPointer] = createSignal({ x: 0, y: 0 });
/** Space is held (panning armed), and a space-drag is under way. */
const [spaceHeld, setSpaceHeld] = createSignal(false);
const [panning, setPanning] = createSignal(false);
const [scenario, setScenario] = createSignal<string | null>(params.get("scenario"));
/** The facets that group external systems and stores: boxes, and overlapping outlines. "" is none; null is the default. */
const [groupBy, setGroupBy] = createSignal<string | null>(params.get("group"));
const [overlap, setOverlap] = createSignal<string | null>(params.get("overlap"));

// TOP-LEVEL VARIANTS (#144): the ways the top level is drawn, switched with ?v= and the bar at the bottom.
const VARIANTS = [
  // A: the layout settled in the first round (changed and unchanged groups side by side, changed
  // top left, no line labels, U-turns flattened), kept as the reference.
  { key: "A", name: "Locked layout: changed | not changed", fix: true, rollup: false, nolabels: true, pack: true, split: "RIGHT", explore: undefined },
  { key: "B", name: "Neighbourhood: one part at a time", fix: false, rollup: false, nolabels: false, pack: false, split: undefined, explore: "neighbourhood" },
  { key: "C", name: "Columns: trace a path", fix: false, rollup: false, nolabels: false, pack: false, split: undefined, explore: "columns" },
  { key: "D", name: "Matrix: every connection, no lines", fix: false, rollup: false, nolabels: false, pack: false, split: undefined, explore: "matrix" },
  { key: "E", name: "Clusters: open a block in place", fix: false, rollup: false, nolabels: false, pack: false, split: undefined, explore: "clusters" },
  { key: "F", name: "Rings: how far the change reaches", fix: false, rollup: false, nolabels: false, pack: false, split: undefined, explore: "rings" },
  { key: "G", name: "Path: columns of nodes (C's mechanics, B's look)", fix: false, rollup: false, nolabels: false, pack: false, split: undefined, explore: "path" },
] as const;
const [variant, setVariantRaw] = createSignal(VARIANTS.find((x) => x.key === params.get("v")) ?? VARIANTS[0]);
const setVariant = (step: number) => {
  const i = (VARIANTS.indexOf(variant()) + step + VARIANTS.length) % VARIANTS.length;
  setVariantRaw(VARIANTS[i]!);
  setZoom(null);
  sync();
};
/** Rolled-up groups the engineer opened in place ("facet:value"). */
/** Parts with no lines in the current lens: hidden unless ?lone=1. */
const [showLone, setShowLone] = createSignal(params.get("lone") === "1");
const [opened, setOpened] = createSignal<Set<string>>(new Set());
const toggleOpened = (k: string) =>
  setOpened((o) => {
    const n = new Set(o);
    if (!n.delete(k)) n.add(k);
    return n;
  });

function sync() {
  // Solid batches signal writes: apply them, so the URL gets the new values, not the old ones.
  flush();
  const p = new URLSearchParams(location.search);
  const put = (k: string, v: string | null) => (v === null ? p.delete(k) : p.set(k, v));
  put("focus", focus());
  put("lens", lens() === "modules" ? null : lens());
  put("color", colorBy() === "change" ? null : colorBy());
  put("changed", null);
  put("scope", scope() === "all" ? null : scope());
  put("scenario", scenario());
  put("group", groupBy());
  put("overlap", overlap());
  put("v", variant().key === "A" ? null : variant().key);
  put("lone", showLone() ? "1" : null);
  put("key", keyV().key === "1" ? null : keyV().key);
  put("keyopen", keyOpen() ? null : "0");
  history.replaceState(null, "", `?${p}`);
}
const setFocus = (f: string | null) => (setFocusRaw(f ?? home), setZoom(null), setHover(null), sync());
/** Where "Whole system" goes: the single top node, when there is only one. */
let home: string | null = null;
/** Out one level: to the zoomed-into node's parent, with the node you came out of selected. */
let goUp: () => void = () => {};
const setLens = (l: Lens) => (setLensRaw(l), setZoom(null), setHover(null), sync());

/** The glide under way (flyTo); bumping it stops the glide. */
let flight = 0;
// The view's zoom: null is the default (the graph's width fitted to the canvas, 70–100%).
const [zoom, setZoom] = createSignal<number | null>(null);
/** The scrolling canvas, and the drawing's natural size and default scale, for zooming. */
let scroller: HTMLDivElement | undefined;
let drawing = { width: 1, height: 1, scale: 1 };
const scaleNow = () => zoom() ?? drawing.scale;
/** Zooms to `next`, keeping the point under (ax, ay) in the canvas (default its centre) still. */
function zoomTo(next: number, ax?: number, ay?: number) {
  flight++; // the reader's own zoom stops a glide under way
  const el = scroller;
  const cur = scaleNow();
  next = Math.min(3, Math.max(0.15, next));
  if (!el || next === cur) return;
  ax ??= el.clientWidth / 2;
  ay ??= el.clientHeight / 2;
  const x = (el.scrollLeft + ax) / cur;
  const y = (el.scrollTop + ay) / cur;
  setZoom(next);
  requestAnimationFrame(() => el.scrollTo(x * next - ax, y * next - ay));
}
const zoomBy = (f: number) => zoomTo(scaleNow() * f);

/**
 * TOP-LEVEL VARIANTS (#144): glide the view so (tx, ty), in drawing coordinates, ends in the middle
 * of the canvas. The pan eases in and out and takes longer the further it goes; a long one also
 * zooms out part-way and back, so the reader sees where they're going from where they were.
 */
function flyTo(tx: number, ty: number, done?: () => void) {
  const el = scroller;
  if (!el) return;
  const id = ++flight;
  const s0 = scaleNow();
  const w = el.clientWidth, h = el.clientHeight;
  const x0 = (el.scrollLeft + w / 2) / s0, y0 = (el.scrollTop + h / 2) / s0;
  const dist = Math.hypot(tx - x0, ty - y0) * s0;
  const far = dist / Math.hypot(w, h);
  const dip = far > 0.6 ? Math.max(0.45, 1 / (1 + (far - 0.6) * 0.8)) : 1;
  const dur = Math.min(1200, 380 + dist * 0.35);
  const t0 = performance.now();
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const frame = (now: number) => {
    if (id !== flight) return;
    const t = Math.min(1, (now - t0) / dur);
    const e = ease(t);
    const sc = s0 * (1 - (1 - dip) * Math.sin(Math.PI * t));
    setZoom(sc);
    flush();
    el.scrollTo((x0 + (tx - x0) * e) * sc - w / 2, (y0 + (ty - y0) * e) * sc - h / 2);
    if (t < 1) requestAnimationFrame(frame);
    else done?.();
  };
  requestAnimationFrame(frame);
}
/** The whole drawing in the canvas, never above 100%. */
function zoomFit() {
  if (!scroller) return;
  zoomTo(Math.min(1, (scroller.clientWidth - 8) / drawing.width, (scroller.clientHeight - 8) / drawing.height));
  requestAnimationFrame(() => scroller?.scrollTo(0, 0));
}
const setColorBy = (c: string) => (setColorByRaw(c), sync());

// ---------------------------------------------------------------------------------------------
// Styles.

const s = stylex.create({
  app: {
    backgroundColor: colors.bg,
    color: colors.fg,
    display: "grid",
    fontFamily: fonts.ui,
    fontSize: 13,
    gridTemplateColumns: "minmax(0, 1fr) 460px",
    gridTemplateRows: "auto minmax(0, 1fr)",
    height: "100vh",
    inset: 0,
    position: "fixed",
  },
  bar: {
    alignItems: "center",
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    gridColumn: "1 / -1",
    paddingBlock: 8,
    paddingInline: 14,
  },
  title: { fontSize: 14, fontWeight: 600, margin: 0, maxWidth: 520, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  muted: { color: colors.muted },
  tabs: { display: "flex", gap: 2 },
  tab: {
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: colors.fg,
    cursor: "pointer",
    fontFamily: fonts.ui,
    fontSize: 13,
    paddingBlock: 4,
    paddingInline: 10,
  },
  tabOn: { backgroundColor: colors.selected, borderColor: colors.accent },
  select: {
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 13,
    paddingBlock: 3,
    paddingInline: 6,
  },
  label: { alignItems: "center", display: "flex", gap: 6 },
  canvasCol: { display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, position: "relative" },
  zoomBar: {
    alignItems: "center",
    backgroundColor: colors.pop,
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    bottom: 14,
    boxShadow: `0 2px 8px ${colors.popShadow}`,
    display: "flex",
    gap: 4,
    paddingBlock: 4,
    paddingInline: 6,
    position: "absolute",
    right: 14,
  },
  zoomButton: { fontSize: 15, minWidth: 30 },
  zoomSep: { backgroundColor: colors.line, height: 18, marginInline: 2, width: 1 },
  disabled: { cursor: "default", opacity: 0.4 },
  card: {
    backgroundColor: colors.pop,
    borderColor: colors.line,
    borderRadius: 10,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: `0 6px 24px ${colors.popShadow}`,
    color: colors.fg,
    fontSize: 12.5,
    left: "var(--card-x)",
    lineHeight: 1.45,
    paddingBlock: 10,
    paddingInline: 12,
    pointerEvents: "none",
    position: "fixed",
    top: "var(--card-y)",
    width: 340,
    zIndex: 10,
  },
  cardHead: { alignItems: "center", display: "flex", gap: 8, justifyContent: "space-between", marginBottom: 2 },
  cardKind: { color: colors.muted, fontSize: 11, letterSpacing: "0.04em", textTransform: "uppercase" },
  cardTitle: { fontSize: 15, fontWeight: 650, marginBottom: 4 },
  cardTitleSmall: { fontWeight: 600 },
  cardText: { marginBlock: 2 },
  cardChange: {
    borderLeftStyle: "solid",
    borderLeftWidth: 3,
    color: colors.fg,
    marginBlock: 6,
    paddingInlineStart: 8,
  },
  cardFoot: { color: colors.muted, columnGap: 10, display: "flex", flexWrap: "wrap", fontSize: 11.5, marginTop: 6 },
  cardEdge: { borderTopColor: colors.line, borderTopStyle: "solid", borderTopWidth: 1, marginTop: 6, paddingTop: 6 },
  cardRow: { alignItems: "center", display: "flex", gap: 8, justifyContent: "space-between" },
  badge: { borderRadius: 999, fontSize: 11, fontWeight: 600, paddingBlock: 1, paddingInline: 7, whiteSpace: "nowrap" },
  zoomLabel: { color: colors.muted, fontVariantNumeric: "tabular-nums", minWidth: 42, textAlign: "center" },
  crumbs: { alignItems: "center", display: "flex", flexWrap: "wrap", gap: 6, paddingBlock: 6, paddingInline: 14 },
  crumb: {
    backgroundColor: "transparent",
    borderWidth: 0,
    color: { default: colors.accent, ":hover": colors.fg },
    cursor: "pointer",
    fontFamily: fonts.ui,
    fontSize: 13,
    padding: 0,
  },
  legend: { alignItems: "center", display: "flex", flexWrap: "wrap", gap: 10, paddingBottom: 6, paddingInline: 14, rowGap: 4 },
  legendHead: { color: colors.fg, fontWeight: 650 },
  legendBreak: { flexBasis: "100%", height: 0 },
  sample: { flexShrink: 0, overflow: "visible" },
  // LEGEND VARIANTS (#155)
  keyGroup: { alignItems: "center", display: "inline-flex", flexWrap: "wrap", gap: 8, marginInlineEnd: 8 },
  keyFloat: {
    backgroundColor: colors.pop,
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    bottom: 14,
    boxShadow: `0 2px 8px ${colors.popShadow}`,
    fontSize: 12,
    left: 14,
    maxHeight: "55%",
    overflowY: "auto",
    padding: 8,
    position: "absolute",
    width: 300,
    zIndex: 5,
  },
  keyFloatHead: { alignItems: "center", display: "flex", gap: 8, marginBottom: 2 },
  keyClose: { backgroundColor: "transparent", borderStyle: "none", color: colors.muted, cursor: "pointer", fontSize: 16, marginInlineStart: "auto" },
  keySection: { color: colors.muted, fontSize: 11, letterSpacing: "0.04em", marginTop: 6, textTransform: "uppercase" },
  keyRow: { alignItems: "center", borderRadius: 4, cursor: "default", display: "flex", fontSize: 12, gap: 8, paddingBlock: 2, paddingInline: 4 },
  keyRowOn: { backgroundColor: colors.hover },
  keySampleCell: { display: "inline-flex", flexShrink: 0, width: 40 },
  keyCount: { color: colors.muted, fontVariantNumeric: "tabular-nums", marginInlineStart: "auto" },
  keyButtonOn: { backgroundColor: colors.selected },
  noFill: { fill: "none" },
  pin: { pointerEvents: "none" },
  pinLine: { fill: "none", stroke: colors.accent, strokeWidth: 1.2 },
  pinDot: { fill: colors.accent },
  pinBox: { fill: colors.pop, stroke: colors.accent, strokeWidth: 1.2 },
  pinText: { fill: colors.fg, fontFamily: fonts.ui, fontSize: 11 },
  canvas: { flexGrow: 1, minHeight: 0, overflow: "auto" },
  grab: { cursor: "grab", userSelect: "none" },
  grabbing: { cursor: "grabbing" },
  panel: {
    backgroundColor: colors.bgRaised,
    borderLeftColor: colors.line,
    borderLeftStyle: "solid",
    borderLeftWidth: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingBlock: 12,
    paddingInline: 16,
  },
  h2: { fontSize: 17, fontWeight: 600, marginBlock: 4 },
  h3: { color: colors.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", marginBottom: 6, marginTop: 18, textTransform: "uppercase" },
  p: { lineHeight: 1.45, marginBlock: 4 },
  link: { color: colors.accent, textDecoration: { default: "none", ":hover": "underline" } },
  button: {
    backgroundColor: { default: colors.bg, ":hover": colors.hover },
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: colors.fg,
    cursor: "pointer",
    fontFamily: fonts.ui,
    fontSize: 12,
    paddingBlock: 3,
    paddingInline: 8,
  },
  textButton: {
    backgroundColor: "transparent",
    borderWidth: 0,
    color: { default: colors.fg, ":hover": colors.accent },
    cursor: "pointer",
    fontFamily: fonts.ui,
    fontSize: 13,
    padding: 0,
    textAlign: "start",
  },
  row: { alignItems: "baseline", display: "flex", gap: 8, paddingBlock: 3 },
  list: { listStyle: "none", margin: 0, padding: 0 },
  details: { borderTopColor: colors.line, borderTopStyle: "solid", borderTopWidth: 1, paddingBlock: 6 },
  summary: { cursor: "pointer", lineHeight: 1.4 },
  answer: { lineHeight: 1.45, marginBlock: 6, paddingInlineStart: 14 },
  claims: { paddingInlineStart: 14 },
  claim: {
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    marginBlock: 6,
    paddingBlock: 6,
    paddingInline: 8,
  },
  evidence: { marginTop: 8 },
  pre: {
    backgroundColor: pal.code,
    borderRadius: 4,
    fontFamily: fonts.mono,
    fontSize: 11.5,
    lineHeight: 1.45,
    marginBlock: 4,
    overflowX: "auto",
    paddingBlock: 6,
    paddingInline: 8,
    whiteSpace: "pre",
  },
  lineNo: { color: colors.muted, display: "inline-block", marginInlineEnd: 10, textAlign: "end", userSelect: "none", width: 36 },
  mono: { fontFamily: fonts.mono, fontSize: 12 },
  files: { alignItems: "baseline", columnGap: 8, display: "grid", gridTemplateColumns: "max-content max-content minmax(0, 1fr)", rowGap: 8 },
  count: { fontFamily: fonts.mono, fontSize: 12, fontVariantNumeric: "tabular-nums", textAlign: "end" },
  zero: { color: colors.muted, opacity: 0.6 },
  fileCell: { minWidth: 0, overflowWrap: "anywhere" },
  fileSummary: { color: colors.muted, display: "block", lineHeight: 1.4, marginTop: 2 },
  chip: {
    alignItems: "center",
    borderColor: colors.line,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    display: "inline-flex",
    fontSize: 12,
    gap: 5,
    marginInlineEnd: 4,
    paddingBlock: 1,
    paddingInline: 7,
    whiteSpace: "nowrap",
  },
  swatch: { borderRadius: 3, display: "inline-block", flexShrink: 0, height: 10, width: 10 },
  prefix: { fontFamily: fonts.mono, fontSize: 11, fontWeight: 700 },
  desc: { fontFamily: fonts.ui, lineHeight: 1.45, maxHeight: 360, overflowY: "auto", whiteSpace: "pre-wrap" },
  undetermined: { color: colors.warn },
  // SVG.
  svgText: { fill: colors.fg, fontFamily: fonts.ui, fontSize: 13, fontWeight: 600, pointerEvents: "none" },
  svgSmall: { fill: colors.muted, fontFamily: fonts.ui, fontSize: 11, pointerEvents: "none" },
  svgMono: { fill: colors.muted, fontFamily: fonts.mono, fontSize: 10.5, pointerEvents: "none" },
  svgLabel: { fill: colors.fg, fontFamily: fonts.ui, fontSize: 11, pointerEvents: "none" },
  labelBg: { cursor: "pointer", fill: colors.bg, opacity: 0.94 },
  rowHit: { cursor: "pointer", fill: "transparent" },
  nodeBox: { cursor: "pointer", fill: pal.nodeBg, strokeWidth: 1.5 },
  contextBox: { fill: pal.contextBg, strokeDasharray: "5 4" },
  selectedBox: { stroke: colors.accent, strokeWidth: 3 },
  dim: { opacity: 0.35 },
  valueBox: { fill: colors.bg, stroke: colors.line, strokeWidth: 1.2 },
  valueBoxOn: { stroke: colors.accent, strokeWidth: 2.5 },
  valueTitle: { fill: colors.muted, fontFamily: fonts.ui, fontSize: 12, fontWeight: 650, pointerEvents: "none" },
  overlapFill: { cursor: "pointer", opacity: 0.12 },
  // TOP-LEVEL VARIANTS (#144)
  region: { fill: colors.bgRaised, stroke: colors.muted, strokeDasharray: "6 4", strokeWidth: 1.5 },
  regionChanged: { fill: pal.modifiedTint, stroke: pal.modified, strokeDasharray: "none", strokeWidth: 2 },
  shelfChip: { cursor: "pointer", fill: pal.nodeBg, stroke: colors.line, strokeWidth: 1 },
  switcher: {
    alignItems: "center",
    backgroundColor: colors.fg,
    borderRadius: 999,
    bottom: 16,
    boxShadow: `0 4px 16px ${colors.popShadow}`,
    color: colors.bg,
    display: "flex",
    gap: 10,
    left: "calc((100vw - 460px) / 2)",
    paddingBlock: 6,
    paddingInline: 10,
    position: "fixed",
    transform: "translateX(-50%)",
    zIndex: 10,
  },
  switcherButton: { backgroundColor: "transparent", borderStyle: "none", color: colors.bg, cursor: "pointer", fontSize: 16, paddingInline: 6 },
  overlapFillOn: { opacity: 0.28 },
  overlapLabel: { fontFamily: fonts.ui, fontSize: 10, fontWeight: 650, pointerEvents: "none", stroke: "none" },
  groupBox: { fill: colors.bgRaised, stroke: colors.line, strokeWidth: 1.5 },
  groupTitle: { fill: colors.fg, fontFamily: fonts.ui, fontSize: 15, fontWeight: 700, pointerEvents: "none" },
  edge: { fill: "none", strokeWidth: 1.6 },
  edgeHit: { cursor: "pointer", fill: "none", pointerEvents: "stroke", stroke: "transparent", strokeWidth: 14 },
  crossing: { strokeDasharray: "7 4", strokeWidth: 2.2 },
  edgeSelected: { strokeWidth: 3.5 },
  faded: { opacity: 0.1 },
  fadedNode: { opacity: 0.4 },
  countBg: { fill: colors.bg, strokeWidth: 1.2 },
  countText: { fontFamily: fonts.ui, fontSize: 10.5, fontWeight: 600, pointerEvents: "none" },
  lifeline: { stroke: colors.line, strokeDasharray: "4 4" },
  clickable: { cursor: "pointer" },
});

const PALETTE = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"] as const;
const swatch = stylex.create({
  c0: { backgroundColor: pal.c0, fill: pal.c0, stroke: pal.c0 },
  c1: { backgroundColor: pal.c1, fill: pal.c1, stroke: pal.c1 },
  c2: { backgroundColor: pal.c2, fill: pal.c2, stroke: pal.c2 },
  c3: { backgroundColor: pal.c3, fill: pal.c3, stroke: pal.c3 },
  c4: { backgroundColor: pal.c4, fill: pal.c4, stroke: pal.c4 },
  c5: { backgroundColor: pal.c5, fill: pal.c5, stroke: pal.c5 },
  c6: { backgroundColor: pal.c6, fill: pal.c6, stroke: pal.c6 },
  c7: { backgroundColor: pal.c7, fill: pal.c7, stroke: pal.c7 },
  none: { backgroundColor: pal.none, fill: pal.none, stroke: pal.none },
  added: { backgroundColor: pal.added, fill: pal.added, stroke: pal.added },
  removed: { backgroundColor: pal.removed, fill: pal.removed, stroke: pal.removed },
  modified: { backgroundColor: pal.modified, fill: pal.modified, stroke: pal.modified },
  unchanged: { backgroundColor: pal.unchanged, fill: pal.unchanged, stroke: pal.unchanged },
  mixed: { backgroundColor: pal.modified, fill: pal.modified, stroke: pal.modified },
});
type Swatch = keyof typeof swatch;
const stroke = stylex.create({
  added: { stroke: pal.added },
  removed: { stroke: pal.removed },
  modified: { stroke: pal.modified },
  unchanged: { stroke: pal.unchanged },
  mixed: { stroke: pal.modified },
});
const text = stylex.create({
  added: { color: pal.added, fill: pal.added },
  removed: { color: pal.removed, fill: pal.removed },
  modified: { color: pal.modified, fill: pal.modified },
  unchanged: { color: colors.muted, fill: colors.muted },
  mixed: { color: pal.modified, fill: pal.modified },
});

const badgeTint = stylex.create({
  added: { backgroundColor: pal.addedTint },
  removed: { backgroundColor: pal.removedTint },
  modified: { backgroundColor: pal.modifiedTint },
  unchanged: { backgroundColor: colors.hover },
  mixed: { backgroundColor: pal.modifiedTint },
});
const cardEdge = stylex.create({
  added: { borderLeftColor: pal.added },
  removed: { borderLeftColor: pal.removed },
  modified: { borderLeftColor: pal.modified },
});
const MARK: Record<Change | "mixed", string> = { added: "+ added", removed: "− removed", modified: "~ changed", unchanged: "unchanged", mixed: "~ mixed" };
const SIGN: Record<Change | "mixed", string> = { added: "+", removed: "−", modified: "~", unchanged: "", mixed: "~" };
const TOPICS: Topic[] = ["change", "design", "dependencies", "data", "interaction", "security", "failure", "organisation"];
const LENSES: { id: Lens; label: string }[] = [
  { id: "modules", label: "Modules & services" },
  { id: "data", label: "Data flow" },
  { id: "external", label: "External & boundaries" },
  { id: "order", label: "Order of actions" },
];

/** "3 connections: 2 added, 1 changed", or "3 connections, all added". */
function bundleLabel(edges: Edge[]): string {
  const by = new Map<Change, number>();
  for (const e of edges) by.set(e.change, (by.get(e.change) ?? 0) + 1);
  const word: Record<Change, string> = { added: "added", removed: "removed", modified: "changed", unchanged: "unchanged" };
  if (by.size === 1) return `${edges.length} connections, all ${word[edges[0]!.change]}`;
  const order: Change[] = ["added", "modified", "removed", "unchanged"];
  return `${edges.length} connections: ${order.filter((c) => by.has(c)).map((c) => `${by.get(c)} ${word[c]}`).join(", ")}`;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

// ---------------------------------------------------------------------------------------------

async function start() {
  const root = document.getElementById("root")!;
  const name = params.get("a") ?? (names.length === 1 ? names[0]! : null);
  if (!name || !loaders[`./data/${name}.json`]) {
    render(() => <Pick />, root);
    return;
  }
  const analysis = await loaders[`./data/${name}.json`]!();
  const overlay = overlays[`./data/overlays/${name}.json`];
  if (overlay && params.get("overlay") !== "0") analysis.edges.push(...(await overlay()).edges);
  const m = new Model(analysis);
  document.title = `#${m.a.pr.number} ${m.a.pr.title} · PR view`;
  // One node at the top (the whole repo) is nothing to look at: start inside it.
  const roots = m.children.get(null) ?? [];
  home = roots.length === 1 ? roots[0]!.id : null;
  if (focus() === null) setFocusRaw(home);
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable]")) return;
    if (e.key === " ") {
      // Held for panning, not scrolling the page or pressing a focused button.
      e.preventDefault();
      setSpaceHeld(true);
      return;
    }
    if (e.key === "Escape") setSel(null);
    if (e.key === "Backspace") goUp();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomBy(1.25);
    if (e.key === "-" || e.key === "_") zoomBy(0.8);
    if (e.key === "0") zoomFit();
    // Arrows switch the legend; Shift + arrows the layout (#144).
    if (e.key === "ArrowLeft") (e.shiftKey ? setVariant(-1) : setKeyV(-1));
    if (e.key === "ArrowRight") (e.shiftKey ? setVariant(1) : setKeyV(1));
    if ((e.key === "?" || e.key === "k") && keyV().key === "4") setCallouts((x) => !x);
  });
  goUp = () => {
    const from = focus();
    if (from === null || from === home) return;
    setFocus(m.nodes.get(from)?.parent ?? null);
    setSel({ kind: "node", id: from });
  };
  window.addEventListener("keyup", (e) => e.key === " " && setSpaceHeld(false));
  window.addEventListener("blur", () => setSpaceHeld(false));
  render(() => <App m={m} />, root);
}

function Pick() {
  return (
    <div {...stylex.attrs(s.panel)}>
      <h2 {...stylex.attrs(s.h2)}>PR analyses</h2>
      <Show when={names.length > 0} fallback={<p {...stylex.attrs(s.p)}>None yet: see web/prototype-pr-view/README.md.</p>}>
        <ul {...stylex.attrs(s.list)}>
          <For each={names}>
            {(n) => (
              <li {...stylex.attrs(s.row)}>
                <a href={`?a=${encodeURIComponent(n)}`} {...stylex.attrs(s.link)}>
                  {n}
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function App(props: { m: Model }) {
  const m = props.m;
  const nodeFacets = m.a.facets.filter((f) => f.appliesTo === "node");
  const edgeFacets = m.a.facets.filter((f) => f.appliesTo === "edge");

  /** Which palette entry each value of the coloured facet gets: its place in the facet's list. */
  const colour = (assign: FacetAssignment | undefined, facetId: string): Swatch[] => {
    const def = m.facets.get(facetId);
    if (!def || !assign || assign.values.length === 0) return ["none"];
    return assign.values.map((v) => {
      const i = def.values.filter((x) => x.id !== "unknown").findIndex((x) => x.id === v);
      return i < 0 ? "none" : PALETTE[i % PALETTE.length]!;
    });
  };

  const select = (x: Sel) => setSel(x);
  /** Selects something from the panel or overview, zooming so it's on screen. */
  const reveal = (x: Sel) => {
    if (x?.kind === "node") setFocus(m.nodes.get(x.id)?.parent ?? null);
    if (x?.kind === "edge") {
      const e = m.edges.get(x.ids[0]!)!;
      const a = m.chain(e.from);
      const b = m.chain(e.to);
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      setFocus(i > 0 ? a[i - 1]! : null);
      if (lens() === "order") setLens("modules");
    }
    select(x);
  };

  return (
    <div {...stylex.attrs(s.app)}>
      <div {...stylex.attrs(s.bar)}>
        <a href={m.a.pr.url} target="_blank" rel="noreferrer" {...stylex.attrs(s.link, s.title)} title={m.a.pr.title}>
          {m.a.pr.repo}#{m.a.pr.number} {m.a.pr.title}
        </a>
        <span {...stylex.attrs(s.muted)}>
          {m.a.pr.stats.files} files +{m.a.pr.stats.additions} −{m.a.pr.stats.deletions}
        </span>
        <div {...stylex.attrs(s.tabs)} role="tablist">
          <For each={LENSES}>
            {(l) => (
              <button role="tab" aria-selected={lens() === l.id ? "true" : "false"} onClick={() => setLens(l.id)} {...stylex.attrs(s.tab, lens() === l.id && s.tabOn)}>
                {l.label}
              </button>
            )}
          </For>
        </div>
        <label {...stylex.attrs(s.label)}>
          <span {...stylex.attrs(s.muted)}>Colour by</span>
          <select value={colorBy()} onChange={(e) => setColorBy(e.currentTarget.value)} {...stylex.attrs(s.select)}>
            <option value="change">How the PR changed it</option>
            <For each={nodeFacets}>{(f) => <option value={f.id}>{f.name}</option>}</For>
          </select>
        </label>
        <Show when={m.groupingFacets().length > 0}>
          <label {...stylex.attrs(s.label)}>
            <span {...stylex.attrs(s.muted)}>Boxes</span>
            <select value={groupFacet(m)} onChange={(e) => (setGroupBy(e.currentTarget.value), setOverlap(null), sync())} {...stylex.attrs(s.select)}>
              <option value="">none</option>
              <For each={m.groupingFacets()}>{(f) => <option value={f.id}>{f.name}</option>}</For>
            </select>
          </label>
          <label {...stylex.attrs(s.label)}>
            <span {...stylex.attrs(s.muted)}>Outlines</span>
            <select value={overlapFacet(m)} onChange={(e) => (setOverlap(e.currentTarget.value), sync())} {...stylex.attrs(s.select)}>
              <option value="">none</option>
              <For each={m.groupingFacets().filter((f) => f.id !== groupFacet(m))}>{(f) => <option value={f.id}>{f.name}</option>}</For>
            </select>
          </label>
        </Show>
        <label {...stylex.attrs(s.label)}>
          <span>Show</span>
          <select value={scope()} onChange={(e) => setScope(e.currentTarget.value as Scope)} {...stylex.attrs(s.select)}>
            <option value="all">The whole system</option>
            <option value="near">The change and what it connects to</option>
            <option value="changed">Changed parts only</option>
          </select>
        </label>
        <label {...stylex.attrs(s.label)}>
          <input type="checkbox" checked={showLone()} onChange={(e) => (setShowLone(e.currentTarget.checked), setZoom(null), sync())} />
          <span>Parts with no lines</span>
        </label>
        <Show when={Object.keys(overlays).length > 0}>
          <label {...stylex.attrs(s.label)} title="Edges made up from the head's imports to see a realistic density; not from the agent">
            <input
              type="checkbox"
              checked={params.get("overlay") !== "0"}
              onChange={(e) => {
                const p = new URLSearchParams(location.search);
                if (e.currentTarget.checked) p.delete("overlay");
                else p.set("overlay", "0");
                location.search = `?${p}`;
              }}
            />
            <span>Made-up import edges</span>
          </label>
        </Show>
        <button onClick={() => select(null)} {...stylex.attrs(s.button)}>
          Overview
        </button>
      </div>

      <div {...stylex.attrs(s.canvasCol)}>
        <Show when={lens() !== "order"}>
          <Crumbs m={m} />
        </Show>
        <Show when={lens() !== "order"} fallback={<Legend m={m} />}>
          <Show when={keyV().key === "0"}>
            <Legend m={m} />
          </Show>
          <Show when={keyV().key === "1"}>
            <KeyStrip m={m} />
          </Show>
          <Show when={keyV().key === "2"}>
            <KeyFloat m={m} />
          </Show>
        </Show>
        <div
          ref={(el: HTMLDivElement) => {
            scroller = el;
            // Ctrl/Cmd + wheel (and a trackpad pinch, which browsers send as one) zooms around the
            // pointer. Firefox counts a wheel notch in lines, Chrome in pixels: both become pixels.
            el.addEventListener(
              "wheel",
              (e) => {
                if (!e.ctrlKey && !e.metaKey) return;
                e.preventDefault();
                const px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? el.clientHeight : 1);
                const r = el.getBoundingClientRect();
                zoomTo(scaleNow() * Math.exp(-Math.max(-200, Math.min(200, px)) * 0.0022), e.clientX - r.left, e.clientY - r.top);
              },
              { passive: false },
            );
            el.addEventListener("mousemove", (e) => setPointer({ x: e.clientX, y: e.clientY }));
            let pending = false;
            el.addEventListener("scroll", () => {
              if (pending) return;
              pending = true;
              setTimeout(() => ((pending = false), setScrollTick((x) => x + 1)), 120);
            });
            // A click on the background (nothing that selects) clears the selection. Buttons
            // (the scenario picker) and links keep their own clicks.
            el.addEventListener("click", (e) => {
              const t = e.target as Element;
              if (!t.closest("[data-hit], button, a, input, select")) setSel(null);
            });
            // Space + drag pans: the press arms it, the drag moves the canvas under the pointer, and
            // the click that ends a drag selects nothing.
            let drag: { x: number; y: number; left: number; top: number; moved: boolean } | null = null;
            el.addEventListener("mousedown", (e) => {
              if (!spaceHeld() || e.button !== 0) return;
              e.preventDefault();
              flight++; // panning by hand stops a glide
              drag = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
              setPanning(true);
            });
            window.addEventListener("mousemove", (e) => {
              if (!drag) return;
              const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
              if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
              el.scrollTo(drag.left - dx, drag.top - dy);
            });
            window.addEventListener("mouseup", () => {
              if (!drag) return;
              const moved = drag.moved;
              drag = null;
              setPanning(false);
              if (moved) {
                const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
                window.addEventListener("click", swallow, { capture: true, once: true });
                setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
              }
            });
          }}
          {...stylex.attrs(s.canvas, spaceHeld() && s.grab, panning() && s.grabbing)}
        >
          <Show when={lens() === "order"} fallback={variant().explore ? <Explorer m={m} kind={variant().explore!} /> : <Graph m={m} colour={colour} />}>
            <Sequence m={m} colour={colour} />
          </Show>
        </div>
        <ZoomBar m={m} />
        <HoverCard m={m} />
        <div {...stylex.attrs(s.switcher)}>
          <button {...stylex.attrs(s.switcherButton)} onClick={() => setKeyV(-1)}>←</button>
          <span>
            Legend <b>{keyV().key}</b> — {keyV().name}
          </span>
          <button {...stylex.attrs(s.switcherButton)} onClick={() => setKeyV(1)}>→</button>
        </div>
      </div>

      <aside {...stylex.attrs(s.panel)}>
        <Panel m={m} reveal={reveal} colour={colour} edgeFacets={edgeFacets} />
      </aside>
    </div>
  );
}

/** The card beside the pointer over a node or a connection: what it is and what the PR did to it. */
function HoverCard(props: { m: Model }) {
  const m = props.m;
  const place = () => {
    const { x, y } = pointer();
    const left = x + 16 + CARD_W > window.innerWidth - 8 ? x - 16 - CARD_W : x + 16;
    return { "--card-x": `${Math.max(8, left)}px`, "--card-y": `${Math.min(y + 14, window.innerHeight - 220)}px` };
  };
  return (
    <Show when={!panning() && hover()}>
      {(h) => (
        <div {...stylex.attrs(s.card)} style={place()}>
          <Show when={h().node ? m.nodes.get(h().node!) : undefined}>{(n) => <NodeCard m={m} n={n()} />}</Show>
          <Show when={h().ids}>{(ids) => <EdgeCard m={m} edges={ids().map((id) => m.edges.get(id)!)} />}</Show>
          <Show when={(keyV().key === "3" || keyV().key === "4") && lens() !== "order"}>
            <DrawnAs m={m} node={h().node} edge={h().edge} />
          </Show>
        </div>
      )}
    </Show>
  );
}
const CARD_W = 340;

function Badge(props: { change: Change | "mixed"; label?: string }) {
  return <span {...stylex.attrs(s.badge, text[props.change], badgeTint[props.change])}>{props.label ?? MARK[props.change]}</span>;
}

function NodeCard(props: { m: Model; n: Node }) {
  const n = props.n;
  const d = props.m.diffSize(n.id);
  const kids = (props.m.children.get(n.id) ?? []).length;
  const touched = n.change === "unchanged" && props.m.touched(n.id);
  return (
    <>
      <div {...stylex.attrs(s.cardHead)}>
        <span {...stylex.attrs(s.cardKind)}>{props.m.kindLabel(n.id)}</span>
        <Show when={props.m.showsChange(n.id)}>
          <Badge change={touched ? "mixed" : n.change} label={touched ? "~ changed inside" : undefined} />
        </Show>
      </div>
      <div {...stylex.attrs(s.cardTitle)}>{n.name}</div>
      <p {...stylex.attrs(s.cardText)}>{n.summary}</p>
      <Show when={n.changeSummary}>
        {(t) => <p {...stylex.attrs(s.cardChange, n.change !== "unchanged" && cardEdge[n.change])}>{t()}</p>}
      </Show>
      <div {...stylex.attrs(s.cardFoot)}>
        <Show when={d.files > 0}>
          <span>
            {d.files} {d.files === 1 ? "file" : "files"} <span {...stylex.attrs(text.added)}>+{d.add.toLocaleString("en")}</span>{" "}
            <span {...stylex.attrs(text.removed)}>−{d.del.toLocaleString("en")}</span>
          </span>
        </Show>
        <Show when={kids > 0}>
          <span>{kids} inside · double-click to open</span>
        </Show>
      </div>
    </>
  );
}

function EdgeCard(props: { m: Model; edges: Edge[] }) {
  const m = props.m;
  const shown = () => props.edges.slice(0, 6);
  return (
    <>
      <div {...stylex.attrs(s.cardHead)}>
        <span {...stylex.attrs(s.cardKind)}>
          {props.edges.length === 1 ? "connection" : `${props.edges.length} connections`}
        </span>
      </div>
      <For each={shown()}>
        {(e) => (
          <div {...stylex.attrs(s.cardEdge)}>
            <div {...stylex.attrs(s.cardRow)}>
              <span {...stylex.attrs(s.cardTitleSmall)}>
                {m.name(e.from)} → {m.name(e.to)}
              </span>
              <Badge change={e.change} />
            </div>
            <p {...stylex.attrs(s.cardText)}>{e.label}</p>
            <div {...stylex.attrs(s.cardFoot)}>
              <span>
                {e.kind} · {e.mode}
              </span>
              <Show when={e.data}>{(d) => <span>carries {d()}</span>}</Show>
              <Show when={e.crosses.length > 0}>
                <span>⟂ {e.crosses.map((c) => m.boundaries.get(c)?.name ?? c).join(", ")}</span>
              </Show>
            </div>
          </div>
        )}
      </For>
      <Show when={props.edges.length > 6}>
        <p {...stylex.attrs(s.cardFoot)}>and {props.edges.length - 6} more: click to see them all</p>
      </Show>
    </>
  );
}

/** The facet whose values box the external systems and stores: the chosen one, else the first. */
function groupFacet(m: Model): string {
  const g = groupBy();
  if (g !== null) return g;
  return m.groupingFacets()[0]?.id ?? "";
}
/** The facet drawn as overlapping outlines: the chosen one, else the second. */
function overlapFacet(m: Model): string {
  const o = overlap();
  if (o !== null) return o === groupFacet(m) ? "" : o;
  return m.groupingFacets().find((f) => f.id !== groupFacet(m))?.id ?? "";
}
function valueLabel(m: Model, facet: string, value: string): string {
  return m.facets.get(facet)?.values.find((v) => v.id === value)?.label ?? value;
}
/**
 * TOP-LEVEL VARIANTS (#144): which side of the drawing a node belongs on, left to right. With the
 * groups split: people, then changed parts, then unchanged parts, then external systems.
 */
function side(m: Model, id: string, split: boolean, touched: (id: string) => boolean): number {
  const k = m.nodes.get(id)!.kind;
  if (split) return k === "actor" ? 0 : k === "external" ? 3 : touched(id) ? 1 : 2;
  return k === "actor" ? 0 : k === "store" ? 2 : k === "external" ? 3 : 1;
}

/** Each external system or store in `ids` with a value for the box facet, mapped to that value. */
function boxesFor(m: Model, ids: string[]): Map<string, string> {
  const f = groupFacet(m);
  const out = new Map<string, string>();
  if (!f) return out;
  for (const id of ids) {
    if (!m.isUsed(id) || m.synthetic.has(id)) continue;
    const v = m.valueOf(id, f);
    if (v !== undefined) out.set(id, v);
  }
  return out;
}

/**
 * The second grouping, drawn over the first: each value's members padded and merged into one
 * shape (a tint and an outline in the value's colour), so it crosses the boxes wherever its
 * members sit. Click a shape to select the group.
 */
function Overlaps(props: { m: Model; view: ReturnType<Model["view"]>; at: Laid }) {
  // Less than half the gap between nodes in a box (28), so two groups' outlines never touch;
  // neighbours in one group are joined by a bridge across the gap instead.
  const PADDING = 10;
  const NEAR = 14;
  const groups = createMemo(() => {
    const f = overlapFacet(props.m);
    const def = props.m.facets.get(f);
    if (!def) return [];
    const real = def.values.filter((v) => v.id !== "unknown");
    return real
      .map((v, i) => {
        const rects = props.view.nodes
          .filter((n) => props.m.isUsed(n.node.id) && props.m.valueOf(n.node.id, f) === v.id)
          .map((n) => props.at.at.get(n.node.id)!)
          .filter(Boolean)
          .map((p) => ({ x: p.x - PADDING, y: p.y - PADDING, w: NODE_W + PADDING * 2, h: NODE_H + PADDING * 2 }));
        // Join neighbours: rects in line (sharing a column or a row) with a small gap between them
        // get a bridge over the gap, overlapping both, so the outline runs round them as one.
        type R = (typeof rects)[number];
        const parent = rects.map((_, k) => k);
        const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
        const bridges: R[] = [];
        const INSET = 14;
        rects.forEach((a, k) =>
          rects.forEach((b, j) => {
            if (j <= k) return;
            const [top, bottom] = a.y <= b.y ? [a, b] : [b, a];
            const [left, right] = a.x <= b.x ? [a, b] : [b, a];
            const xs = Math.max(a.x, b.x), xe = Math.min(a.x + a.w, b.x + b.w);
            const ys = Math.max(a.y, b.y), ye = Math.min(a.y + a.h, b.y + b.h);
            const vGap = bottom.y - (top.y + top.h), hGap = right.x - (left.x + left.w);
            if (xe - xs > INSET * 2 && vGap <= NEAR) {
              bridges.push({ x: xs + INSET, y: top.y + top.h - INSET, w: xe - xs - INSET * 2, h: vGap + INSET * 2 });
            } else if (ye - ys > INSET * 2 && hGap <= NEAR) {
              bridges.push({ x: left.x + left.w - INSET, y: ys + INSET, w: hGap + INSET * 2, h: ye - ys - INSET * 2 });
            } else return;
            parent[find(j)] = find(k);
          }),
        );
        const byPiece = new Map<number, R[]>();
        rects.forEach((r, k) => byPiece.set(find(k), [...(byPiece.get(find(k)) ?? []), r]));
        // Each piece's label goes under its lowest rect, at the right.
        const labels = [...byPiece.values()].map((rs) => rs.reduce((a, r) => (r.y > a.y ? r : a)));
        return { facet: f, value: v.id, label: v.label, sw: PALETTE[i % PALETTE.length]!, rects, shapes: [...rects, ...bridges], labels };
      })
      .filter((g) => g.rects.length > 0);
  });
  return (
    <>
      <defs>
        {/* The outline of a shape: the shape grown by 1.5px, minus the shape. */}
        <filter id="ring" x="-5%" y="-5%" width="110%" height="110%">
          <feMorphology in="SourceGraphic" operator="dilate" radius="1.5" result="grown" />
          <feComposite in="grown" in2="SourceGraphic" operator="out" />
        </filter>
      </defs>
      <For each={groups()}>
        {(g) => {
          const on = () => {
            const x = sel();
            return x?.kind === "group" && x.facet === g.facet && x.value === g.value;
          };
          return (
            <g data-hit onClick={() => setSel({ kind: "group", facet: g.facet, value: g.value })}>
              <g {...stylex.attrs(s.overlapFill, on() && s.overlapFillOn)}>
                <For each={g.shapes}>{(r) => <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={10} {...stylex.attrs(swatch[g.sw])} />}</For>
              </g>
              <g filter="url(#ring)">
                <For each={g.shapes}>{(r) => <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={10} {...stylex.attrs(swatch[g.sw])} />}</For>
              </g>
              <For each={g.labels}>
                {(r) => (
                  <text x={r.x + r.w - 10} y={r.y + r.h - 2} text-anchor="end" {...stylex.attrs(swatch[g.sw], s.overlapLabel)}>
                    {g.label}
                  </text>
                )}
              </For>
            </g>
          );
        }}
      </For>
    </>
  );
}

function GroupPanel(props: { m: Model; facet: string; value: string; reveal: (x: Sel) => void }) {
  const m = props.m;
  const def = m.facets.get(props.facet);
  const v = def?.values.find((x) => x.id === props.value);
  const members = m.a.nodes.filter((n) => n.facets.some((x) => x.facet === props.facet && x.values.includes(props.value)));
  return (
    <div>
      <p {...stylex.attrs(s.p, s.muted)}>
        {def?.name ?? props.facet} · group
      </p>
      <h2 {...stylex.attrs(s.h2)}>{v?.label ?? props.value}</h2>
      <p {...stylex.attrs(s.p)}>{v?.description}</p>
      <p {...stylex.attrs(s.p, s.muted)}>{def?.question}</p>
      <h3 {...stylex.attrs(s.h3)}>In this group ({members.length})</h3>
      <For each={members}>
        {(n) => {
          const a = n.facets.find((x) => x.facet === props.facet)!;
          return (
            <details {...stylex.attrs(s.details)}>
              <summary {...stylex.attrs(s.summary)}>
                <button onClick={() => props.reveal({ kind: "node", id: n.id })} {...stylex.attrs(s.crumb)}>
                  {n.name}
                </button>{" "}
                <span {...stylex.attrs(s.muted)}>· {m.kindLabel(n.id)}</span>
              </summary>
              <p {...stylex.attrs(s.answer)}>{n.summary}</p>
              <Claims m={m} ids={a.claims} />
            </details>
          );
        }}
      </For>
    </div>
  );
}

function ZoomBar(props: { m: Model }) {
  const top = () => focus() === null || focus() === home;
  const parent = () => {
    const p = props.m.nodes.get(focus() ?? "")?.parent;
    return p === undefined || p === home ? "the whole system" : props.m.name(p);
  };
  return (
    <div {...stylex.attrs(s.zoomBar)} aria-label="Zoom">
      <button
        onClick={() => goUp()}
        disabled={top()}
        title={top() ? "Already at the top" : `Up to ${parent()} (Backspace)`}
        {...stylex.attrs(s.button, s.zoomButton, (focus() === null || focus() === home) && s.disabled)}
      >
        ↑
      </button>
      <span {...stylex.attrs(s.zoomSep)} />
      <button onClick={() => zoomBy(0.8)} title="Zoom out (-)" {...stylex.attrs(s.button, s.zoomButton)}>
        −
      </button>
      <span {...stylex.attrs(s.zoomLabel)}>{Math.round((zoom() ?? drawing.scale) * 100)}%</span>
      <button onClick={() => zoomBy(1.25)} title="Zoom in (+)" {...stylex.attrs(s.button, s.zoomButton)}>
        +
      </button>
      <button onClick={zoomFit} title="Fit the whole view (0)" {...stylex.attrs(s.button)}>
        Fit
      </button>
      <Show when={keyV().key === "4" && lens() !== "order"}>
        <span {...stylex.attrs(s.zoomSep)} />
        <button onClick={() => setCallouts((x) => !x)} title="Label each kind of line and box on the drawing (?)" {...stylex.attrs(s.button, callouts() && s.keyButtonOn)}>
          ? Key
        </button>
      </Show>
    </div>
  );
}

type ColourFn = (assign: FacetAssignment | undefined, facetId: string) => Swatch[];

function Crumbs(props: { m: Model }) {
  const chain = createMemo(() => props.m.chain(focus()));
  return (
    <div {...stylex.attrs(s.crumbs)}>
      <button onClick={() => setFocus(null)} {...stylex.attrs(s.crumb)}>
        Whole system
      </button>
      <For each={chain().filter((id) => id !== home)}>
        {(id) => (
          <>
            <span {...stylex.attrs(s.muted)}>›</span>
            <button onClick={() => (setFocus(id), setSel({ kind: "node", id }))} {...stylex.attrs(s.crumb)}>
              {props.m.name(id)}
            </button>
          </>
        )}
      </For>
      <span {...stylex.attrs(s.muted)}>· click to select, double-click to go inside, Backspace to go out</span>
    </div>
  );
}

/** A small drawn sample for the legend. */
function Sample(props: { children: JSX.Element; text: string; w?: number }) {
  return (
    <span {...stylex.attrs(s.label)}>
      <svg width={props.w ?? 36} height={16} viewBox={`0 0 ${props.w ?? 36} 16`} {...stylex.attrs(s.sample)}>
        {props.children}
      </svg>
      {props.text}
    </span>
  );
}

/** What each kind of line and box means: always shown, so no style is left to guess. */
function LineKey() {
  const head = (x: number) => `M${x},8 L${x - 7},4 L${x - 7},12 Z`;
  const tail = (x: number) => `M${x},8 L${x + 7},4 L${x + 7},12 Z`;
  return (
    <>
      <span {...stylex.attrs(s.legendBreak)} />
      <span {...stylex.attrs(s.legendHead)}>Lines</span>
      <Sample text="solid: a connection, arrow at the receiver">
        <path d="M2,8 L28,8" {...stylex.attrs(s.edge, stroke.unchanged)} />
        <path d={head(34)} {...stylex.attrs(swatch.unchanged)} />
      </Sample>
      <Sample text="dashed: crosses a boundary (trust, process, network, tenant)">
        <path d="M2,8 L28,8" {...stylex.attrs(s.edge, stroke.unchanged, s.crossing)} />
        <path d={head(34)} {...stylex.attrs(swatch.unchanged)} />
      </Sample>
      <Sample text="colour: how the PR changed it" w={56}>
        <path d="M2,4 L54,4" {...stylex.attrs(s.edge, stroke.added)} />
        <path d="M2,8 L54,8" {...stylex.attrs(s.edge, stroke.modified)} />
        <path d="M2,12 L54,12" {...stylex.attrs(s.edge, stroke.removed)} />
      </Sample>
      <Sample text="thick: several connections">
        <path d="M2,8 L28,8" stroke-width={4} {...stylex.attrs(s.edge, stroke.unchanged)} />
        <path d={head(34)} {...stylex.attrs(swatch.unchanged)} />
      </Sample>
      <Sample text="both ends: two-way">
        <path d="M8,8 L28,8" {...stylex.attrs(s.edge, stroke.unchanged)} />
        <path d={head(34)} {...stylex.attrs(swatch.unchanged)} />
        <path d={tail(2)} {...stylex.attrs(swatch.unchanged)} />
      </Sample>
      <Show when={variant().nolabels}>
        <span {...stylex.attrs(s.muted)}>· no line labels: hover a line</span>
      </Show>
      <span {...stylex.attrs(s.legendBreak)} />
      <span {...stylex.attrs(s.legendHead)}>Boxes</span>
      <Sample text="frame: inside what you opened">
        <rect x={1} y={1} width={34} height={14} rx={3} {...stylex.attrs(s.groupBox)} />
      </Sample>
      <Sample text="dashed node: outside it, shown for its connections">
        <rect x={1} y={2} width={34} height={12} rx={3} {...stylex.attrs(s.nodeBox, stroke.unchanged, s.contextBox)} />
      </Sample>
      <Sample text="grey box: a “Boxes” group">
        <rect x={1} y={1} width={34} height={14} rx={3} {...stylex.attrs(s.valueBox)} />
      </Sample>
      <Sample text="coloured outline: an “Outlines” group">
        <rect x={1} y={1} width={34} height={14} rx={4} fill="none" stroke-width={1.5} {...stylex.attrs(stroke.added)} />
      </Sample>
      <Show when={variant().split}>
        <Sample text="tinted group: parts this PR changed">
          <rect x={1} y={1} width={34} height={14} rx={3} {...stylex.attrs(s.region, s.regionChanged)} />
        </Sample>
        <Sample text="dashed group: parts it didn't change">
          <rect x={1} y={1} width={34} height={14} rx={3} {...stylex.attrs(s.region)} />
        </Sample>
      </Show>
      <Show when={variant().rollup}>
        <span {...stylex.attrs(s.muted)}>· an outside node with “N inside” is a whole group: double-click to open, double-click its box to close</span>
      </Show>
      <Show when={variant().pack && showLone()}>
        <span {...stylex.attrs(s.muted)}>· the grid in the frame: parts with no lines in this lens</span>
      </Show>
    </>
  );
}

function Legend(props: { m: Model }) {
  const facet = createMemo(() => props.m.facets.get(colorBy()));
  return (
    <div {...stylex.attrs(s.legend)}>
      <span {...stylex.attrs(s.legendHead)}>{facet() ? "Nodes" : "Nodes and lines"}</span>
      <Show
        when={facet()}
        fallback={
          <For each={["added", "modified", "removed", "unchanged"] as const}>
            {(c) => (
              <span {...stylex.attrs(s.label)}>
                <span {...stylex.attrs(s.swatch, swatch[c])} />
                {MARK[c]}
              </span>
            )}
          </For>
        }
      >
        {(f) => (
          <>
            <span {...stylex.attrs(s.muted)} title={f().question}>
              {f().question}
            </span>
            <For each={f().values}>
              {(v) => {
                const i = f().values.filter((x) => x.id !== "unknown").findIndex((x) => x.id === v.id);
                const sw: Swatch = i < 0 ? "none" : PALETTE[i % PALETTE.length]!;
                return (
                  <span {...stylex.attrs(s.label)} title={v.description}>
                    <span {...stylex.attrs(s.swatch, swatch[sw])} />
                    {v.label}
                  </span>
                );
              }}
            </For>
          </>
        )}
      </Show>
      <LineKey />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// LEGEND VARIANTS (#155): what the legend shows, how it follows the drawing, and where it sits.
// Switched with ?key= and the bar at the bottom (the layout stays on ?v=, A by default).

const KEYS = [
  { key: "0", name: "First draft: every style, always above the graph" },
  { key: "1", name: "Strip: only what's drawn, folds to one line" },
  { key: "2", name: "Floating key: over the canvas, hover a row to find it" },
  { key: "3", name: "In the panel, plus “Drawn as” on hover" },
  { key: "4", name: "On demand: labels pinned to the drawing (? key)" },
] as const;
const [keyV, setKeyVRaw] = createSignal<(typeof KEYS)[number]>(KEYS.find((x) => x.key === params.get("key")) ?? KEYS[1]);
const setKeyV = (step: number) => {
  const i = (KEYS.indexOf(keyV()) + step + KEYS.length) % KEYS.length;
  setKeyVRaw(KEYS[i]!);
  setKeyMatch(null);
  sync();
};
/** What the canvas draws right now: the Graph publishes each layout it lands. */
const [drawn, setDrawn] = createSignal<{ view: ReturnType<Model["view"]>; at: Laid } | null>(null);
/** The legend row under the pointer: the drawing fades everything not drawn in its style. */
const [keyMatch, setKeyMatch] = createSignal<KeyItem | null>(null);
/** Strip and floating key: shown or folded. On demand: labels on or off. */
const [keyOpen, setKeyOpen] = createSignal(params.get("keyopen") !== "0");
const [callouts, setCallouts] = createSignal(false);
/** Bumped as the canvas scrolls, so pinned labels move to examples on screen. */
const [scrollTick, setScrollTick] = createSignal(0);

interface KeyItem {
  id: string;
  section: string;
  text: string;
  sample: JSX.Element | null;
  w?: number;
  /** The drawn parts and lines (VisEdge keys) in this style. */
  nodes: Set<string>;
  edges: Set<string>;
  /** Where one of them is, in drawing coordinates, for a pinned label. */
  pts: { x: number; y: number }[];
}

const CHANGE_TEXT: Record<string, string> = {
  added: "added by this PR",
  modified: "changed by this PR",
  inside: "changed inside: a part within it changed",
  removed: "removed by this PR",
  unchanged: "not changed",
  outside: "no change word: a person or outside system",
};

function miniNode(sw: Swatch | Swatch[], opts: { dashed?: boolean; faded?: boolean } = {}) {
  const bands = Array.isArray(sw) ? sw : [sw];
  const edge = Array.isArray(sw) ? "unchanged" : (sw as Change | "mixed");
  return (
    <g {...stylex.attrs(opts.faded && s.dim)}>
      <rect x={1} y={1} width={34} height={14} rx={3} {...stylex.attrs(s.nodeBox, (stroke as Record<string, stylex.StyleXStyles>)[edge] ?? stroke.unchanged, opts.dashed && s.contextBox)} />
      <For each={bands}>{(b, i) => <rect x={1} y={1 + (i() * 14) / bands.length} width={4} height={14 / bands.length} {...stylex.attrs(swatch[b])} />}</For>
    </g>
  );
}
const head = (x: number) => `M${x},8 L${x - 7},4 L${x - 7},12 Z`;
const tail = (x: number) => `M${x},8 L${x + 7},4 L${x + 7},12 Z`;
function miniLine(c: Change | "mixed", o: { dashed?: boolean; thick?: boolean; both?: boolean } = {}) {
  const sw: Swatch = c === "mixed" ? "modified" : c;
  return (
    <>
      <path d={`M${o.both ? 8 : 2},8 L28,8`} stroke-width={o.thick ? 4 : undefined} {...stylex.attrs(s.edge, stroke[c], o.dashed && s.crossing)} />
      <path d={head(34)} {...stylex.attrs(swatch[sw])} />
      <Show when={o.both}>
        <path d={tail(2)} {...stylex.attrs(swatch[sw])} />
      </Show>
    </>
  );
}

/** The styles the current drawing uses, each with the parts and lines drawn in it. */
function keyItems(m: Model): KeyItem[] {
  const d = drawn();
  if (!d) return [];
  const { view, at } = d;
  const items: KeyItem[] = [];
  const centre = (id: string) => {
    const p = at.at.get(id);
    return p ? { x: p.x + NODE_W, y: p.y + NODE_H / 2 } : null;
  };
  const lineAt = (key: string) => {
    const r = at.routes.get(key);
    return r ? { x: r.end.x - r.end.dx * 26, y: r.end.y - r.end.dy * 26 } : null;
  };
  const add = (it: Omit<KeyItem, "pts">) => {
    if (it.nodes.size === 0 && it.edges.size === 0) return;
    // A style worn by parts and lines both is pinned to a part: a line's midpoint sits too near other parts.
    const ok = (p: { x: number; y: number } | null): p is { x: number; y: number } => !!p;
    const onNodes = [...it.nodes].map(centre).filter(ok);
    const pts = onNodes.length ? onNodes : [...it.edges].map(lineAt).filter(ok);
    items.push({ ...it, pts });
  };
  const inside = (r: { x: number; y: number; w: number; h: number }) =>
    new Set(view.nodes.filter((v) => {
      const p = at.at.get(v.node.id);
      return p && p.x >= r.x && p.y >= r.y && p.x + NODE_W <= r.x + r.w && p.y + NODE_H <= r.y + r.h;
    }).map((v) => v.node.id));
  const area = (it: Omit<KeyItem, "pts" | "edges" | "nodes">, r: { x: number; y: number; w: number; h: number }) =>
    items.push({ ...it, nodes: inside(r), edges: new Set(), pts: [{ x: r.x + 40, y: r.y + 6 }] });

  const c = colorBy();
  const def = m.facets.get(c);
  if (!def) {
    // Colour by change: parts and lines share the colours, so one row explains both.
    const PARTS = "Colour: how the PR changed it";
    for (const k of ["added", "modified", "inside", "removed", "unchanged", "outside"] as const) {
      const nodes = new Set(view.nodes.filter((v) => {
        const n = v.node;
        const kk = !m.showsChange(n.id) ? "outside" : n.change === "unchanged" && v.touched ? "inside" : n.change;
        return kk === k;
      }).map((v) => v.node.id));
      const edges = new Set(view.edges.filter((e) => (e.change === "mixed" ? "modified" : e.change) === k).map((e) => e.key));
      const sw: Swatch = k === "inside" ? "modified" : k === "outside" ? "unchanged" : k;
      add({ id: `c:${k}`, section: PARTS, text: k === "outside" || k === "inside" ? CHANGE_TEXT[k]! : `${MARK[k]}`, sample: k === "outside" ? miniNode("unchanged") : miniNode(sw), nodes, edges });
    }
  } else {
    const PARTS = `Colour: ${def.name}`;
    const real = def.values.filter((x) => x.id !== "unknown");
    let multi = new Set<string>();
    const none = new Set<string>();
    for (const v of view.nodes) {
      const f = v.node.facets.find((x) => x.facet === c);
      if (!f || f.values.length === 0) none.add(v.node.id);
      else if (f.values.length > 1) multi.add(v.node.id);
    }
    real.forEach((val, i) => {
      const nodes = new Set(view.nodes.filter((v) => v.node.facets.find((x) => x.facet === c)?.values.includes(val.id)).map((v) => v.node.id));
      add({ id: `f:${val.id}`, section: PARTS, text: val.label, sample: miniNode(PALETTE[i % PALETTE.length]!), nodes, edges: new Set() });
    });
    add({ id: "f:multi", section: PARTS, text: "split bar: several values", sample: miniNode(["c0", "c1", "c2"]), nodes: multi, edges: new Set() });
    add({ id: "f:none", section: PARTS, text: "grey bar: no value found", sample: miniNode("none"), nodes: none, edges: new Set() });
    multi = new Set();
    // Lines keep the change colours when parts are coloured by a facet.
    for (const k of ["added", "modified", "removed", "unchanged"] as const) {
      const edges = new Set(view.edges.filter((e) => (e.change === "mixed" ? "modified" : e.change) === k).map((e) => e.key));
      add({ id: `lc:${k}`, section: "Lines", text: `${MARK[k]} connection`, sample: miniLine(k), nodes: new Set(), edges });
    }
  }
  const PARTS2 = "Parts";
  add({ id: "context", section: PARTS2, text: "dashed: outside what you opened, here for its lines", sample: miniNode("unchanged", { dashed: true }), nodes: new Set(view.nodes.filter((v) => v.context).map((v) => v.node.id)), edges: new Set() });
  add({
    id: "kids",
    section: PARTS2,
    text: "double-click to open",
    w: 54,
    sample: (
      <text x={0} y={12} {...stylex.attrs(s.svgSmall)}>
        3 inside ▸
      </text>
    ),
    nodes: new Set(view.nodes.filter((v) => (m.children.get(v.node.id) ?? []).length > 0 && !v.context).map((v) => v.node.id)),
    edges: new Set(),
  });
  add({ id: "dim", section: PARTS2, text: "faded: not on a line that crosses a boundary", sample: miniNode("unchanged", { faded: true }), nodes: new Set(view.nodes.filter((v) => v.dim).map((v) => v.node.id)), edges: new Set() });

  const L = "Lines";
  add({ id: "solid", section: L, text: "solid: a connection, arrow at the receiver", sample: miniLine("unchanged"), nodes: new Set(), edges: new Set(view.edges.filter((e) => e.crosses.length === 0).map((e) => e.key)) });
  add({ id: "dashed", section: L, text: "dashed: crosses a boundary", sample: miniLine("unchanged", { dashed: true }), nodes: new Set(), edges: new Set(view.edges.filter((e) => e.crosses.length > 0).map((e) => e.key)) });
  add({ id: "thick", section: L, text: "thicker: several connections", sample: miniLine("unchanged", { thick: true }), nodes: new Set(), edges: new Set(view.edges.filter((e) => e.edges.length > 1).map((e) => e.key)) });
  add({ id: "both", section: L, text: "both ends: two-way", sample: miniLine("unchanged", { both: true }), nodes: new Set(), edges: new Set(view.edges.filter((e) => e.both).map((e) => e.key)) });
  if (variant().nolabels && view.edges.length > 0) items.push({ id: "nolabels", section: L, text: "no labels: hover or select a line", sample: null, nodes: new Set(), edges: new Set(), pts: [] });

  const A = "Areas";
  if (at.group) area({ id: "frame", section: A, text: `frame: inside ${focus() ? m.name(focus()!) : "the system"}`, sample: <rect x={1} y={1} width={34} height={14} rx={3} {...stylex.attrs(s.groupBox)} /> }, at.group);
  for (const r of at.regions)
    area(
      r.key === "C"
        ? { id: "regionC", section: A, text: "tinted: parts this PR changed", sample: <rect x={1} y={1} width={34} height={14} rx={3} {...stylex.attrs(s.region, s.regionChanged)} /> }
        : { id: "regionU", section: A, text: "dashed: parts it didn't change", sample: <rect x={1} y={1} width={34} height={14} rx={3} {...stylex.attrs(s.region)} /> },
      r,
    );
  if (at.boxes.length) {
    const f = m.facets.get(groupFacet(m));
    const b = at.boxes[0]!;
    const nodes = new Set<string>();
    for (const x of at.boxes) for (const id of inside(x)) nodes.add(id);
    items.push({ id: "boxes", section: A, text: `grey box: ${f?.name ?? "a group"}`, sample: <rect x={1} y={1} width={34} height={14} rx={3} {...stylex.attrs(s.valueBox)} />, nodes, edges: new Set(), pts: [{ x: b.x + 40, y: b.y + 4 }] });
  }
  // Outlines: one row per value drawn, in that value's colour (the same palette place Overlaps uses).
  const of = overlapFacet(m);
  const odef = m.facets.get(of);
  if (odef) {
    odef.values
      .filter((x) => x.id !== "unknown")
      .forEach((val, i) => {
        const sw = PALETTE[i % PALETTE.length]!;
        const nodes = new Set(view.nodes.filter((v) => m.isUsed(v.node.id) && m.valueOf(v.node.id, of) === val.id).map((v) => v.node.id));
        add({
          id: `outline:${val.id}`,
          section: `Outlines: ${odef.name}`,
          text: val.label,
          sample: <rect x={1} y={1} width={34} height={14} rx={4} stroke-width={1.5} {...stylex.attrs(swatch[sw], s.noFill)} />,
          nodes,
          edges: new Set(),
        });
      });
  }
  if (at.pack) items.push({ id: "pack", section: A, text: "grid: parts with no lines in this lens", sample: null, nodes: new Set(), edges: new Set(), pts: [{ x: at.pack.x, y: at.pack.y - 14 }] });
  return items;
}

const bySection = (items: KeyItem[]) => {
  const out = new Map<string, KeyItem[]>();
  for (const it of items) out.set(it.section, [...(out.get(it.section) ?? []), it]);
  return [...out];
};

function KeySample(props: { it: KeyItem }) {
  return (
    <Show when={props.it.sample}>
      <svg width={props.it.w ?? 36} height={16} viewBox={`0 0 ${props.it.w ?? 36} 16`} {...stylex.attrs(s.sample)}>
        {props.it.sample}
      </svg>
    </Show>
  );
}

/** K1: a strip above the canvas, only what's drawn, sections inline; folds to one line. */
function KeyStrip(props: { m: Model }) {
  const items = createMemo(() => keyItems(props.m));
  return (
    <div {...stylex.attrs(s.legend)}>
      <Show
        when={keyOpen()}
        fallback={
          <button onClick={() => (setKeyOpen(true), sync())} {...stylex.attrs(s.crumb)}>
            Key ▸ <span {...stylex.attrs(s.muted)}>· {items().length} styles in this drawing</span>
          </button>
        }
      >
        <For each={bySection(items())}>
          {([sec, its]) => (
            <span {...stylex.attrs(s.keyGroup)}>
              <span {...stylex.attrs(s.legendHead)}>{sec}</span>
              <For each={its}>
                {(it) => (
                  <span {...stylex.attrs(s.label)} onMouseEnter={() => setKeyMatch(it)} onMouseLeave={() => setKeyMatch(null)}>
                    <KeySample it={it} />
                    <span {...stylex.attrs(!it.sample && s.muted)}>{it.text}</span>
                  </span>
                )}
              </For>
            </span>
          )}
        </For>
        <button onClick={() => (setKeyOpen(false), setKeyMatch(null), sync())} {...stylex.attrs(s.crumb)}>
          Hide key
        </button>
      </Show>
    </div>
  );
}

/** K2: a card floating over the canvas's bottom left; each row counts its matches and lights them on hover. */
function KeyFloat(props: { m: Model }) {
  const items = createMemo(() => keyItems(props.m));
  return (
    <div {...stylex.attrs(s.keyFloat)}>
      <Show
        when={keyOpen()}
        fallback={
          <button onClick={() => (setKeyOpen(true), sync())} {...stylex.attrs(s.button)}>
            Key
          </button>
        }
      >
        <div {...stylex.attrs(s.keyFloatHead)}>
          <span {...stylex.attrs(s.legendHead)}>Key</span>
          <span {...stylex.attrs(s.muted)}>hover a row to find it</span>
          <button onClick={() => (setKeyOpen(false), setKeyMatch(null), sync())} {...stylex.attrs(s.keyClose)} title="Fold the key">
            ×
          </button>
        </div>
        <KeyRows items={items()} />
      </Show>
    </div>
  );
}

function KeyRows(props: { items: KeyItem[] }) {
  return (
    <For each={bySection(props.items)}>
      {([sec, its]) => (
        <>
          <div {...stylex.attrs(s.keySection)}>{sec}</div>
          <For each={its}>
            {(it) => (
              <div
                {...stylex.attrs(s.keyRow, keyMatch()?.id === it.id && s.keyRowOn)}
                onMouseEnter={() => setKeyMatch(it)}
                onMouseLeave={() => setKeyMatch(null)}
              >
                <span {...stylex.attrs(s.keySampleCell)}>
                  <KeySample it={it} />
                </span>
                <span {...stylex.attrs(!it.sample && s.muted)}>{it.text}</span>
                <span {...stylex.attrs(s.keyCount)}>{it.nodes.size + it.edges.size || ""}</span>
              </div>
            )}
          </For>
        </>
      )}
    </For>
  );
}

/** K3: the key as the overview's first section. */
function KeyPanel(props: { m: Model }) {
  const items = createMemo(() => keyItems(props.m));
  return (
    <details open={keyOpen()} onToggle={(e) => (setKeyOpen(e.currentTarget.open), sync())} {...stylex.attrs(s.details)}>
      <summary {...stylex.attrs(s.summary)}>How to read the drawing</summary>
      <KeyRows items={items()} />
    </details>
  );
}

/** K3 and K4: what the hovered thing's own style means, in the hover card. */
function DrawnAs(props: { m: Model; node?: string; edge?: string }) {
  const lines = createMemo(() => {
    const items = keyItems(props.m).filter((it) => it.sample && (props.node ? it.nodes.has(props.node) && !["frame", "regionC", "regionU", "boxes"].includes(it.id) : it.edges.has(props.edge ?? "")));
    return items;
  });
  return (
    <Show when={lines().length > 0}>
      <div {...stylex.attrs(s.cardEdge)}>
        <span {...stylex.attrs(s.cardKind)}>Drawn as</span>
        <For each={lines()}>
          {(it) => (
            <div {...stylex.attrs(s.label)}>
              <KeySample it={it} />
              {it.text}
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

/** K4: each style's meaning pinned to one example of it on the drawing, the one nearest the top left of what's on screen. */
function Callouts(props: { m: Model; scale: number }) {
  const pins = createMemo(() => {
    if (!callouts()) return [];
    scrollTick();
    const k = props.scale;
    const vx = (scroller?.scrollLeft ?? 0) / k, vy = (scroller?.scrollTop ?? 0) / k;
    const vw = (scroller?.clientWidth ?? 800) / k, vh = (scroller?.clientHeight ?? 600) / k;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const out: { it: KeyItem; p: { x: number; y: number }; box: { x: number; y: number; w: number; h: number } }[] = [];
    for (const it of keyItems(props.m)) {
      const seen = it.pts.filter((p) => p.x >= vx && p.y >= vy && p.x <= vx + vw - 40 && p.y <= vy + vh - 40);
      const p = (seen.length ? seen : it.pts).reduce<{ x: number; y: number } | null>((a, q) => (!a || q.y + q.x * 0.3 < a.y + a.x * 0.3 ? q : a), null);
      if (!p) continue;
      const w = labelWidth(it.text) + 16, h = 20;
      const box = { x: p.x + 14, y: p.y - 30, w, h };
      while (placed.some((r) => box.x < r.x + r.w && r.x < box.x + box.w && box.y < r.y + r.h + 4 && r.y < box.y + box.h + 4)) box.y += h + 4;
      placed.push(box);
      out.push({ it, p, box });
    }
    return out;
  });
  return (
    <For each={pins()}>
      {(x) => (
        <g {...stylex.attrs(s.pin)}>
          <path d={`M${x.p.x},${x.p.y} L${x.box.x},${x.box.y + x.box.h / 2}`} {...stylex.attrs(s.pinLine)} />
          <circle cx={x.p.x} cy={x.p.y} r={3} {...stylex.attrs(s.pinDot)} />
          <rect x={x.box.x} y={x.box.y} width={x.box.w} height={x.box.h} rx={10} {...stylex.attrs(s.pinBox)} />
          <text x={x.box.x + 8} y={x.box.y + 14} {...stylex.attrs(s.pinText)}>
            {x.it.text}
          </text>
        </g>
      )}
    </For>
  );
}

// ---------------------------------------------------------------------------------------------
// The graph.

/** TOP-LEVEL VARIANTS (#144): the explorers, on the same view the graph draws. */
function Explorer(props: { m: Model; kind: ExploreKind }) {
  const m = props.m;
  const view = createMemo(() => {
    const v = m.view(focus(), lens(), changedOnly(), { shelve: scope() === "near" });
    if (showLone()) return v;
    const linked = new Set(v.edges.flatMap((e) => [e.from, e.to]));
    return { ...v, nodes: v.nodes.filter((n) => linked.has(n.node.id)) };
  });
  const api: Api = {
    selected: () => {
      const x = sel();
      return x?.kind === "node" ? x.id : null;
    },
    select: (id) => setSel({ kind: "node", id }),
    selectEdges: (ids) => setSel({ kind: "edge", ids }),
    open: (id) => (m.children.get(id) ?? []).length > 0 && (setFocus(id), setSel({ kind: "node", id })),
    hoverNode: (id) => setHover(id ? { node: id } : null),
    hoverEdge: (key, ids) => setHover(key ? { edge: key, ids } : null),
    groupOf: (id) => {
      const f = groupFacet(m);
      const v = f ? m.valueOf(id, f) : undefined;
      return v ? valueLabel(m, f, v) : undefined;
    },
  };
  return <Explore kind={props.kind} m={m} view={view()} api={api} />;
}

function Graph(props: { m: Model; colour: ColourFn }) {
  const m = props.m;
  const view = createMemo(() => {
    const x = variant();
    const f = groupFacet(m);
    const open = opened();
    const rollup = (id: string) => {
      if (m.synthetic.has(id) || !f) return undefined;
      const v = m.valueOf(id, f);
      if (v === undefined || open.has(`${f}:${v}`)) return undefined;
      const members = m.a.nodes.filter((n) => m.isUsed(n.id) && m.valueOf(n.id, f) === v).map((n) => n.id);
      return m.groupNode(f, v, members);
    };
    const v = m.view(focus(), lens(), changedOnly(), { shelve: scope() === "near", rollup: x.rollup ? rollup : undefined });
    if (showLone()) return v;
    const linked = new Set(v.edges.flatMap((e) => [e.from, e.to]));
    return { ...v, nodes: v.nodes.filter((n) => linked.has(n.node.id)) };
  });
  /** Each bundle's label: its main edge's, the boundaries it crosses in the external lens, and how many more it carries. */
  const labelOf = (e: VisEdge) => {
    // A line carrying several connections says so and how they changed, without naming one of
    // them: picking one would make it look like the one that matters.
    if (e.edges.length > 1) return bundleLabel(e.edges);
    const one = e.edges[0]!;
    let t = lens() === "data" ? (one.data ?? one.label) : one.label;
    if (lens() === "external" && e.crosses.length) t += ` ⟂ ${e.crosses.map((c) => m.boundaries.get(c)?.name ?? c).join(", ")}`;
    const sign = SIGN[one.change];
    return `${sign ? `${sign} ` : ""}${clip(t, 38)}`;
  };
  // ELK lays out asynchronously: the latest view's layout lands in `laid`, and an older one that
  // finishes late is dropped.
  const [laid, setLaid] = createSignal<{ view: ReturnType<Model["view"]>; at: Laid } | null>(null);
  let ticket = 0;
  createMemo(() => {
    const v = view();
    const mine = ++ticket;
    // Inside nodes first, in the analysis's order, then the context around them.
    const ids = [...v.nodes.filter((n) => !n.context), ...v.nodes.filter((n) => n.context)].map((n) => n.node.id);
    const x = variant();
    const split = x.split;
    const touchedSet = new Set(v.nodes.filter((n) => n.touched && !m.synthetic.has(n.node.id)).map((n) => n.node.id));
    const touched = (id: string) => touchedSet.has(id);
    void layout(
      ids,
      v.edges.map((e) => ({ key: e.key, from: e.from, to: e.to, label: variant().nolabels ? "" : labelOf(e), reverse: variant().fix && side(m, e.from, !!split, touched) > side(m, e.to, !!split, touched) })),
      new Set(v.nodes.filter((n) => !n.context && !m.isExternal(n.node.id)).map((n) => n.node.id)),
      boxesFor(m, v.nodes.map((n) => n.node.id)),
      variant().pack,
      split
        ? new Map(
            v.nodes
              .filter((n) => !n.context && !m.isExternal(n.node.id))
              .map((n) => [n.node.id, touched(n.node.id) ? ("C" as const) : ("U" as const)]),
          )
        : undefined,
      split ?? "RIGHT",
    ).then((at) => {
      if (mine === ticket) (setLaid({ view: v, at }), setDrawn({ view: v, at }));
    });
  });

  const selectedEdges = createMemo(() => {
    const x = sel();
    return new Set(x?.kind === "edge" ? x.ids : []);
  });

  return (
    <Show when={laid()} fallback={<p {...stylex.attrs(s.p, s.muted)}>&nbsp;&nbsp;&nbsp;Laying out…</p>}>
      {(l) => <Drawing m={m} colour={props.colour} view={l().view} at={l().at} labelOf={labelOf} selectedEdges={selectedEdges()} />}
    </Show>
  );
}

function Drawing(props: {
  m: Model;
  colour: ColourFn;
  view: ReturnType<Model["view"]>;
  at: Laid;
  labelOf: (e: VisEdge) => string;
  selectedEdges: Set<string>;
}) {
  const m = props.m;
  /** The node whose connections are in focus: the hovered one, else the selected one. */
  const activeNode = createMemo(() => {
    // Only a node this view draws: a hover or selection from another zoom level doesn't count.
    const shown = (id: string) => props.view.nodes.some((n) => n.node.id === id);
    const h = hover();
    if (h?.node && shown(h.node)) return h.node;
    const x = sel();
    return x?.kind === "node" && shown(x.id) ? x.id : null;
  });
  /** Edge bundles in focus: the active node's, the hovered one, and the selected one. */
  const lit = createMemo(() => {
    const out = new Set<string>();
    const n = activeNode();
    const h = hover();
    for (const e of props.view.edges) {
      if (n && (e.from === n || e.to === n)) out.add(e.key);
      if (h?.edge === e.key) out.add(e.key);
      if (e.edges.some((x) => props.selectedEdges.has(x.id))) out.add(e.key);
    }
    return out;
  });
  const neighbours = createMemo(() => {
    const n = activeNode();
    const out = new Set<string>(n ? [n] : []);
    for (const e of props.view.edges) {
      if (e.from === n) out.add(e.to);
      if (e.to === n) out.add(e.from);
    }
    return out;
  });
  const width = (e: VisEdge) => 1.3 + Math.log2(e.edges.length) * 0.9;

  // TOP-LEVEL VARIANTS (#144): the shelf, a grid of small chips under the drawing, one row of
  // headings per kind, for the parts neither changed nor connected to a change.
  const shelf = createMemo(() => {
    const items = props.view.shelf;
    const CW = 176, CH = 28, GAP = 8, TOP = 56, HEAD = 22;
    const cols = Math.max(4, Math.floor((props.at.width - 48 + GAP) / (CW + GAP)));
    const byKind = new Map<string, typeof items>();
    for (const n of items) {
      const k = m.kindLabel(n.id);
      byKind.set(k, [...(byKind.get(k) ?? []), n]);
    }
    let y = props.at.height + TOP;
    const heads: { x: number; y: number; text: string }[] = [];
    const chips: { n: (typeof items)[number]; x: number; y: number }[] = [];
    for (const [k, ns] of byKind) {
      heads.push({ x: 24, y: y + 14, text: `${k} · ${ns.length}` });
      y += HEAD;
      ns.forEach((n, i) => chips.push({ n, x: 24 + (i % cols) * (CW + GAP), y: y + Math.floor(i / cols) * (CH + GAP) }));
      y += Math.ceil(ns.length / cols) * (CH + GAP) + 6;
    }
    return { CW, CH, heads, chips, top: props.at.height + 16, height: items.length ? y - props.at.height + 16 : 0 };
  });
  const totalH = () => props.at.height;

  // Fit the drawing's width to the canvas (no smaller than 70%; scroll for the rest), and start
  // each layout scrolled to its top left.
  const fit = createMemo(() => {
    const { width: w } = props.at;
    const h = totalH();
    const avail = (scroller?.clientWidth ?? window.innerWidth - 480) - 8;
    scroller?.scrollTo(0, 0);
    drawing = { width: w, height: h, scale: Math.min(1, Math.max(0.7, avail / w)) };
    return drawing.scale;
  });
  const scale = () => zoom() ?? fit();
  const select = (e: VisEdge) => setSel({ kind: "edge", ids: e.edges.map((x) => x.id) });

  return (
    <svg width={props.at.width * scale()} height={totalH() * scale()} viewBox={`0 0 ${props.at.width} ${totalH()}`}>
      <Show when={false}>
        <text x={24} y={shelf().top + 20} {...stylex.attrs(s.groupTitle)}>
          Not changed, and not connected to anything changed · {props.view.shelf.length}
        </text>
        <For each={shelf().heads}>
          {(h) => (
            <text x={h.x} y={h.y} {...stylex.attrs(s.svgSmall)}>
              {h.text}
            </text>
          )}
        </For>
        <For each={shelf().chips}>
          {(c) => (
            <g
              transform={`translate(${c.x},${c.y})`}
              data-hit
              onClick={() => setSel({ kind: "node", id: c.n.id })}
              onMouseEnter={() => setHover({ node: c.n.id })}
              onMouseLeave={() => setHover(null)}
            >
              <rect width={shelf().CW} height={shelf().CH} rx={5} {...stylex.attrs(s.shelfChip, sel()?.kind === "node" && (sel() as { id: string }).id === c.n.id && s.selectedBox)} />
              <text x={10} y={18} {...stylex.attrs(s.svgSmall)}>
                {clip(c.n.name, 26)}
              </text>
            </g>
          )}
        </For>
      </Show>
      {/* What's inside the zoomed-into node sits in this box; anything outside it is a connection elsewhere. */}
      <Show when={props.at.group}>
        {(g) => (
          <g>
            <rect x={g().x} y={g().y} width={g().w} height={g().h} rx={12} {...stylex.attrs(s.groupBox)} />
            <text x={g().x + 16} y={g().y + 26} {...stylex.attrs(s.groupTitle)}>
              {focus() ? m.name(focus()!) : ""}
            </text>
            <text x={g().x + g().w - 16} y={g().y + 26} text-anchor="end" {...stylex.attrs(s.svgSmall)}>
              inside · {props.view.nodes.filter((n) => !n.context && !m.isExternal(n.node.id)).length} parts
            </text>
          </g>
        )}
      </Show>
      <For each={props.at.regions}>
        {(r) => (
          <g>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={10} {...stylex.attrs(s.region, r.key === "C" && s.regionChanged)} />
            <text x={r.x + 14} y={r.y + 24} {...stylex.attrs(s.valueTitle)}>
              {r.key === "C" ? "Changed by this PR" : "Not changed"}
            </text>
          </g>
        )}
      </For>
      <Show when={props.at.pack}>
        {(p) => (
          <text x={p().x} y={p().y - 10} {...stylex.attrs(s.svgSmall)}>
            No lines in this lens · {p().n}
          </text>
        )}
      </Show>
      <For each={props.at.boxes}>
        {(b) => {
          const f = groupFacet(m);
          const on = () => {
            const x = sel();
            return x?.kind === "group" && x.facet === f && x.value === b.value;
          };
          return (
            <g
              data-hit
              onClick={() => setSel({ kind: "group", facet: f, value: b.value })}
              onDblClick={() => variant().rollup && toggleOpened(`${f}:${b.value}`)}
              {...stylex.attrs(s.clickable)}
            >
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={10} {...stylex.attrs(s.valueBox, on() && s.valueBoxOn)} />
              <text x={b.x + 12} y={b.y + 19} {...stylex.attrs(s.valueTitle)}>
                {valueLabel(m, f, b.value)}
              </text>
            </g>
          );
        }}
      </For>
      <Overlaps m={m} view={props.view} at={props.at} />
      <For each={props.view.nodes}>
        {(v) => {
          const p = (): Placed => props.at.at.get(v.node.id)!;
          return (
            <g
              onMouseEnter={() => setHover({ node: v.node.id })}
              onMouseLeave={() => setHover(null)}
              {...stylex.attrs(((activeNode() !== null && !neighbours().has(v.node.id)) || (keyMatch() !== null && !keyMatch()!.nodes.has(v.node.id))) && s.fadedNode)}
            >
              <NodeBox m={m} v={v} at={p()} colour={props.colour} />
            </g>
          );
        }}
      </For>
      <For each={props.view.edges}>
        {(e) => {
          const r = props.at.routes.get(e.key);
          if (!r) return null;
          const on = () => e.edges.some((x) => props.selectedEdges.has(x.id));
          return (
            <g
              data-hit
              onClick={() => select(e)}
              onDblClick={(ev) => {
                // Go to the end of the line furthest from the click, keeping the line lit on the way.
                const svg = (ev.currentTarget as SVGGElement).ownerSVGElement!;
                const box = svg.getBoundingClientRect();
                const k = box.width / props.at.width;
                const cx = (ev.clientX - box.left) / k, cy = (ev.clientY - box.top) / k;
                const centre = (id: string) => {
                  const p = props.at.at.get(id)!;
                  return { id, x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 };
                };
                const [a, b] = [centre(e.from), centre(e.to)];
                const far = Math.hypot(a.x - cx, a.y - cy) > Math.hypot(b.x - cx, b.y - cy) ? a : b;
                setSel({ kind: "edge", ids: e.edges.map((x) => x.id) });
                flyTo(far.x, far.y, () => setSel({ kind: "node", id: far.id }));
              }}
              onMouseEnter={() => setHover({ edge: e.key, ids: e.edges.map((x) => x.id) })}
              onMouseLeave={() => setHover(null)}
              {...stylex.attrs(((lit().size > 0 && !lit().has(e.key)) || (keyMatch() !== null && !keyMatch()!.edges.has(e.key))) && s.faded)}
            >
              <path d={r.d} stroke-width={width(e) + (on() ? 1.5 : 0)} {...stylex.attrs(s.edge, stroke[e.change], e.crosses.length > 0 && s.crossing)} />
              <path d={arrow(r.end)} {...stylex.attrs(swatch[e.change === "mixed" ? "modified" : e.change])} />
              <Show when={e.both}>
                <path d={arrow(r.start)} {...stylex.attrs(swatch[e.change === "mixed" ? "modified" : e.change])} />
              </Show>
              <path d={r.d} {...stylex.attrs(s.edgeHit)} />
              <Show when={r.label}>
                {(b) => (
                  <>
                    <rect x={b().x} y={b().y} width={b().w} height={b().h} rx={3} {...stylex.attrs(s.labelBg)} />
                    <text x={b().x + 6} y={b().y + b().h - 4.5} {...stylex.attrs(s.svgLabel, text[e.change])}>
                      {props.labelOf(e)}
                    </text>
                  </>
                )}
              </Show>
            </g>
          );
        }}
      </For>
      <Show when={keyV().key === "4"}>
        <Callouts m={m} scale={scale()} />
      </Show>
    </svg>
  );
}


function NodeBox(props: { m: Model; v: ReturnType<Model["view"]>["nodes"][number]; at: Placed; colour: ColourFn }) {
  const n = props.v.node;
  const kids = (props.m.children.get(n.id) ?? []).length;
  const bands = (): Swatch[] => {
    const c = colorBy();
    if (c === "change") return [n.change === "unchanged" && props.v.touched ? "modified" : n.change];
    return props.colour(
      n.facets.find((f) => f.facet === c),
      c,
    );
  };
  /** The bottom line: the coloured facet's value in words, or (colouring by change) the change's size. */
  const detail = () => {
    const c = colorBy();
    const def = props.m.facets.get(c);
    if (def) {
      const f = n.facets.find((x) => x.facet === c);
      if (!f) return "";
      return clip(f.values.map((v) => def.values.find((x) => x.id === v)?.label ?? v).join(", "), 34);
    }
    const d = props.m.diffSize(n.id);
    return d.files ? `${d.files} ${d.files === 1 ? "file" : "files"} · +${d.add.toLocaleString("en")} −${d.del.toLocaleString("en")}` : "";
  };
  const on = () => {
    const x = sel();
    return x?.kind === "node" && x.id === n.id;
  };
  const changeLabel = () => (n.change === "unchanged" && props.v.touched ? "~ changed inside" : MARK[n.change]);
  const header = () => (props.m.showsChange(n.id) ? `${props.m.kindLabel(n.id)} · ${changeLabel()}` : props.m.kindLabel(n.id));
  return (
    <g
      transform={`translate(${props.at.x},${props.at.y})`}
      data-hit
      onClick={() => setSel({ kind: "node", id: n.id })}
      onDblClick={() =>
        props.m.synthetic.has(n.id)
          ? toggleOpened(`${n.facets[0]!.facet}:${n.facets[0]!.values[0]}`)
          : kids > 0 && (setFocus(n.id), setSel({ kind: "node", id: n.id }))
      }
      {...stylex.attrs(s.clickable, props.v.dim && s.dim)}
    >
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={7}
        {...stylex.attrs(s.nodeBox, stroke[n.change === "unchanged" && props.v.touched ? "modified" : n.change], props.v.context && s.contextBox, on() && s.selectedBox)}
      />
      <For each={bands()}>
        {(b, i) => (
          <rect x={0} y={(i() * NODE_H) / bands().length} width={8} height={NODE_H / bands().length} {...stylex.attrs(swatch[b])} />
        )}
      </For>
      <text x={18} y={19} {...stylex.attrs(s.svgSmall, text[n.change === "unchanged" && props.v.touched ? "modified" : n.change])}>
        {header()}
      </text>
      <Show when={kids > 0}>
        <text x={NODE_W - 10} y={19} text-anchor="end" {...stylex.attrs(s.svgSmall)}>
          {kids} inside ▸
        </text>
      </Show>
      <text x={18} y={40} {...stylex.attrs(s.svgText)}>
        {clip(n.name, 25)}
      </text>
      <text x={18} y={60} {...stylex.attrs(s.svgMono)}>
        {detail()}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------------------------
// Order of actions: one scenario as a sequence diagram.

function Sequence(props: { m: Model; colour: ColourFn }) {
  const m = props.m;
  const current = createMemo(() => m.a.scenarios.find((x) => x.id === scenario()) ?? m.a.scenarios[0]);
  const COL = 190;
  const ROW = 46;
  const TOP = 92;
  const actors = createMemo(() => {
    const out: string[] = [];
    for (const st of current()?.steps ?? []) for (const id of [st.from, st.to]) if (!out.includes(id)) out.push(id);
    return out;
  });
  const x = (id: string) => 30 + actors().indexOf(id) * COL + COL / 2;
  const seqW = () => 60 + actors().length * COL;
  const seqH = () => TOP + (current()?.steps.length ?? 0) * ROW + 40;
  const seqScale = createMemo(() => {
    drawing = { width: seqW(), height: seqH(), scale: 1 };
    return zoom() ?? 1;
  });
  return (
    <div>
      <div {...stylex.attrs(s.crumbs)}>
        <For each={m.a.scenarios}>
          {(sc) => (
            <button
              onClick={() => (setScenario(sc.id), sync(), setSel(null))}
              {...stylex.attrs(s.tab, current()?.id === sc.id && s.tabOn)}
              title={sc.trigger}
            >
              {SIGN[sc.change]} {sc.name}
            </button>
          )}
        </For>
      </div>
      <Show when={current()}>
        {(sc) => (
          <>
            <p {...stylex.attrs(s.p, s.muted)}>
              <span>&nbsp;&nbsp;&nbsp;Starts when: {sc().trigger}</span>
            </p>
            <svg
              width={seqW() * seqScale()}
              height={seqH() * seqScale()}
              viewBox={`0 0 ${seqW()} ${seqH()}`}
            >
              <For each={actors()}>
                {(id) => {
                  const n = m.nodes.get(id)!;
                  const band = (): Swatch => {
                    const c = colorBy();
                    if (c === "change") return n.change;
                    return props.colour(
                      n.facets.find((f) => f.facet === c),
                      c,
                    )[0]!;
                  };
                  return (
                    <g data-hit onClick={() => setSel({ kind: "node", id })} {...stylex.attrs(s.clickable)}>
                      <line x1={x(id)} x2={x(id)} y1={TOP - 20} y2={TOP + sc().steps.length * ROW} {...stylex.attrs(s.lifeline)} />
                      <rect x={x(id) - COL / 2 + 8} y={10} width={COL - 16} height={52} rx={6} {...stylex.attrs(s.nodeBox, stroke[n.change])} />
                      <rect x={x(id) - COL / 2 + 8} y={10} width={7} height={52} {...stylex.attrs(swatch[band()])} />
                      <text x={x(id) - COL / 2 + 22} y={30} {...stylex.attrs(s.svgSmall, text[n.change])}>
                        {m.kindLabel(id)} {m.showsChange(id) ? SIGN[n.change] : ""}
                      </text>
                      <text x={x(id) - COL / 2 + 22} y={49} {...stylex.attrs(s.svgText)}>
                        {clip(n.name, 19)}
                      </text>
                      <title>{n.summary}</title>
                    </g>
                  );
                }}
              </For>
              <For each={sc().steps}>
                {(st, i) => {
                  const y = () => TOP + i() * ROW + 24;
                  const self = st.from === st.to;
                  const x1 = () => x(st.from);
                  const x2 = () => x(st.to);
                  const dir = () => (x2() >= x1() ? 1 : -1);
                  const on = () => {
                    const v = sel();
                    return v?.kind === "step" && v.scenario === sc().id && v.i === i();
                  };
                  const lx = () => (self ? x1() + 8 : Math.min(x1(), x2()) + 6);
                  return (
                    <g data-hit onClick={() => setSel({ kind: "step", scenario: sc().id, i: i() })} {...stylex.attrs(s.clickable)}>
                      <Show
                        when={!self}
                        fallback={<path d={`M${x1()},${y()} h40 v16 h-40`} {...stylex.attrs(s.edge, stroke[st.change], on() && s.edgeSelected)} />}
                      >
                        <line x1={x1()} x2={x2()} y1={y()} y2={y()} {...stylex.attrs(s.edge, stroke[st.change], on() && s.edgeSelected)} />
                        <path d={`M${x2()},${y()} l${-9 * dir()},-5 l0,10 z`} {...stylex.attrs(swatch[st.change])} />
                      </Show>
                      <rect x={Math.min(x1(), x2()) - 6} y={y() - 20} width={Math.abs(x2() - x1()) + (self ? 260 : 12)} height={30} {...stylex.attrs(s.rowHit)} />
                      <text x={lx()} y={y() - 6} {...stylex.attrs(s.svgLabel, text[st.change])}>
                        {i() + 1}. {SIGN[st.change]} {clip(st.action, self ? 40 : Math.max(12, Math.floor(Math.abs(x2() - x1()) / 6.4)))}
                      </text>
                      <title>{`${st.action}${st.data ? `\n${st.data}` : ""}`}</title>
                    </g>
                  );
                }}
              </For>
            </svg>
          </>
        )}
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The drill-down panel.

function Panel(props: { m: Model; reveal: (x: Sel) => void; colour: ColourFn; edgeFacets: unknown[] }) {
  const m = props.m;
  return (
    <Show when={sel()} keyed fallback={<Overview m={m} reveal={props.reveal} />}>
      {(x) => {
        if (x.kind === "node") return <NodePanel m={m} n={m.nodes.get(x.id)!} reveal={props.reveal} colour={props.colour} />;
        if (x.kind === "edge") return <EdgesPanel m={m} edges={x.ids.map((id) => m.edges.get(id)!)} reveal={props.reveal} colour={props.colour} />;
        if (x.kind === "boundary") return <BoundaryPanel m={m} id={x.id} reveal={props.reveal} />;
        if (x.kind === "group") return <GroupPanel m={m} facet={x.facet} value={x.value} reveal={props.reveal} />;
        return <StepPanel m={m} scenario={x.scenario} i={x.i} reveal={props.reveal} />;
      }}
    </Show>
  );
}

function Overview(props: { m: Model; reveal: (x: Sel) => void }) {
  const m = props.m;
  const a = m.a;
  const groups = m.ranked();
  const pick = (it: RankItem): Sel => (it.kind === "edge" ? { kind: "edge", ids: [it.id] } : it.kind === "node" ? { kind: "node", id: it.id } : { kind: "boundary", id: it.id });
  return (
    <div>
      <Show when={keyV().key === "3" && lens() !== "order"}>
        <KeyPanel m={m} />
      </Show>
      <h2 {...stylex.attrs(s.h2)}>What this PR changes</h2>
      <p {...stylex.attrs(s.p, s.muted)}>{a.coverage.summary}</p>
      <details {...stylex.attrs(s.details)}>
        <summary {...stylex.attrs(s.summary)}>The PR's own description</summary>
        <div {...stylex.attrs(s.desc)}>{a.pr.description}</div>
      </details>
      <details {...stylex.attrs(s.details)}>
        <summary {...stylex.attrs(s.summary)}>What the analysis didn't read</summary>
        <ul {...stylex.attrs(s.list)}>
          <For each={a.coverage.skipped}>
            {(k) => (
              <li {...stylex.attrs(s.row)}>
                <span>
                  {k.what} ({k.files} files): <span {...stylex.attrs(s.muted)}>{k.reason}</span>
                </span>
              </li>
            )}
          </For>
          <For each={a.coverage.notes}>{(n) => <li {...stylex.attrs(s.row)}>{n}</li>}</For>
        </ul>
      </details>
      <For each={groups}>
        {(g) => (
          <Show when={g.items.length > 0}>
            <h3 {...stylex.attrs(s.h3)}>
              {g.title} ({g.items.length})
            </h3>
            <p {...stylex.attrs(s.p, s.muted)}>{g.rule}</p>
            <ul {...stylex.attrs(s.list)}>
              <For each={g.items}>
                {(it) => (
                  <li {...stylex.attrs(s.row)}>
                    <span {...stylex.attrs(s.mono, text[it.change])}>{SIGN[it.change] || "·"}</span>
                    <button onClick={() => props.reveal(pick(it))} {...stylex.attrs(s.textButton)}>
                      {it.text}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        )}
      </For>
      <h3 {...stylex.attrs(s.h3)}>Facets found in this repo</h3>
      <For each={a.facets}>
        {(f) => (
          <details {...stylex.attrs(s.details)}>
            <summary {...stylex.attrs(s.summary)}>
              {f.name} <span {...stylex.attrs(s.muted)}>({f.appliesTo}s)</span>
            </summary>
            <p {...stylex.attrs(s.p, s.muted)}>{f.question}</p>
            <ul {...stylex.attrs(s.list)}>
              <For each={f.values}>
                {(v) => (
                  <li {...stylex.attrs(s.row)}>
                    <span>
                      {v.label}: <span {...stylex.attrs(s.muted)}>{v.description}</span>
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </details>
        )}
      </For>
    </div>
  );
}

function ChangeLine(props: { change: Change | "mixed"; summary?: string }) {
  return (
    <p {...stylex.attrs(s.p)}>
      <span {...stylex.attrs(text[props.change])}>{MARK[props.change]}</span>
      <Show when={props.summary}>
        {(t) => (
          <>
            {": "}
            {t()}
          </>
        )}
      </Show>
    </p>
  );
}

function NodePanel(props: { m: Model; n: Node; reveal: (x: Sel) => void; colour: ColourFn }) {
  const m = props.m;
  const n = props.n;
  const kids = m.children.get(n.id) ?? [];
  const conn = m.connections(n.id);
  const newConnections = [...conn.out, ...conn.in].filter((e) => e.change !== "unchanged").length;
  const sha = n.change === "removed" ? m.a.pr.baseSha : m.a.pr.headSha;
  return (
    <div>
      <p {...stylex.attrs(s.p, s.muted)}>
        {m.kindLabel(n.id)}
        <Show when={n.parent}>
          {(p) => (
            <>
              {" in "}
              <button onClick={() => props.reveal({ kind: "node", id: p() })} {...stylex.attrs(s.crumb)}>
                {m.name(p())}
              </button>
            </>
          )}
        </Show>
      </p>
      <h2 {...stylex.attrs(s.h2)}>{n.name}</h2>
      <p {...stylex.attrs(s.p)}>{n.summary}</p>
      <Show when={m.showsChange(n.id)}>
        <ChangeLine change={n.change} summary={n.changeSummary} />
      </Show>
      <Show when={newConnections > 0 && (m.isExternal(n.id) || m.connectedOnly.has(n.id) || n.change === "unchanged")}>
        <p {...stylex.attrs(s.p, s.muted)}>
          {m.isExternal(n.id)
            ? `${newConnections} of its connections are new or changed in this PR.`
            : `Its own code didn't change in this PR; ${newConnections} of its connections are new or changed.`}
        </p>
      </Show>
      <div {...stylex.attrs(s.row)}>
        <For each={n.paths}>
          {(p) => (
            <a href={`https://github.com/${m.a.pr.repo}/tree/${sha}/${p}`} target="_blank" rel="noreferrer" {...stylex.attrs(s.link, s.mono)}>
              {p}
            </a>
          )}
        </For>
      </div>
      <Show when={kids.length > 0}>
        <div {...stylex.attrs(s.row)}>
          <button onClick={() => setFocus(n.id)} {...stylex.attrs(s.button)}>
            Go inside ({kids.length})
          </button>
        </div>
      </Show>

      <Questions m={m} qs={n.questions} />

      <h3 {...stylex.attrs(s.h3)}>What it does</h3>
      <For each={n.responsibilities}>
        {(r) => (
          <details {...stylex.attrs(s.details)}>
            <summary {...stylex.attrs(s.summary)}>
              <span {...stylex.attrs(s.mono, text[r.change])}>{SIGN[r.change] || "·"}</span> {r.text}
            </summary>
            <Claims m={m} ids={r.claims} />
          </details>
        )}
      </For>

      <h3 {...stylex.attrs(s.h3)}>How it's built</h3>
      <Facets m={m} list={n.facets} colour={props.colour} />

      <Show when={conn.out.length + conn.in.length > 0}>
        <h3 {...stylex.attrs(s.h3)}>Connections</h3>
        <EdgeList m={m} edges={conn.out} reveal={props.reveal} />
        <EdgeList m={m} edges={conn.in} reveal={props.reveal} />
      </Show>

      <Show when={n.files.length > 0}>
        <h3 {...stylex.attrs(s.h3)}>Files ({n.files.length})</h3>
        {/* One grid for the whole list, so the counts line up in their own columns. */}
        <div {...stylex.attrs(s.files)}>
          <For each={n.files}>
            {(f) => (
              <>
                <span {...stylex.attrs(s.count, f.additions > 0 ? text.added : s.zero)}>+{f.additions.toLocaleString("en")}</span>
                <span {...stylex.attrs(s.count, f.deletions > 0 ? text.removed : s.zero)}>−{f.deletions.toLocaleString("en")}</span>
                <span {...stylex.attrs(s.fileCell)}>
                  <a
                    href={`https://github.com/${m.a.pr.repo}/blob/${f.status === "removed" ? m.a.pr.baseSha : m.a.pr.headSha}/${f.path}`}
                    target="_blank"
                    rel="noreferrer"
                    {...stylex.attrs(s.link, s.mono)}
                  >
                    {f.path}
                  </a>
                  <Show when={f.status !== "modified"}>
                    <span {...stylex.attrs(s.muted)}> ({f.status === "added" ? "new" : f.status === "removed" ? "deleted" : "renamed"})</span>
                  </Show>
                  <Show when={f.generated}>
                    <span {...stylex.attrs(s.muted)}> (generated)</span>
                  </Show>
                  <Show when={f.summary}>
                    {(t) => <span {...stylex.attrs(s.fileSummary)}>{t()}</span>}
                  </Show>
                </span>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function EdgeList(props: { m: Model; edges: Edge[]; reveal: (x: Sel) => void }) {
  return (
    <ul {...stylex.attrs(s.list)}>
      <For each={props.edges}>
        {(e) => (
          <li {...stylex.attrs(s.row)}>
            <span {...stylex.attrs(s.mono, text[e.change])}>{SIGN[e.change] || "·"}</span>
            <button onClick={() => props.reveal({ kind: "edge", ids: [e.id] })} {...stylex.attrs(s.textButton)}>
              {props.m.name(e.from)} → {props.m.name(e.to)}: {e.label}
              <Show when={e.crosses.length > 0}>
                <span {...stylex.attrs(s.muted)}> ⟂ {e.crosses.map((c) => props.m.boundaries.get(c)?.name ?? c).join(", ")}</span>
              </Show>
            </button>
          </li>
        )}
      </For>
    </ul>
  );
}

function Facets(props: { m: Model; list: FacetAssignment[]; colour: ColourFn }) {
  const label = (facet: string, v: string) => props.m.facets.get(facet)?.values.find((x) => x.id === v);
  return (
    <For each={props.list}>
      {(f) => {
        const def = props.m.facets.get(f.facet);
        const sw = props.colour(f, f.facet);
        return (
          <details {...stylex.attrs(s.details)}>
            <summary {...stylex.attrs(s.summary)}>
              <span {...stylex.attrs(s.muted)}>{def?.name ?? f.facet}: </span>
              <For each={f.values}>
                {(v, i) => (
                  <span {...stylex.attrs(s.chip)} title={label(f.facet, v)?.description}>
                    <span {...stylex.attrs(s.swatch, swatch[sw[i()] ?? "none"])} />
                    {label(f.facet, v)?.label ?? v}
                  </span>
                )}
              </For>
              <Show when={f.was}>
                {(was) => (
                  <span {...stylex.attrs(text.modified)}> (was {was().map((v) => label(f.facet, v)?.label ?? v).join(", ")})</span>
                )}
              </Show>
            </summary>
            <Claims m={props.m} ids={f.claims} />
          </details>
        );
      }}
    </For>
  );
}

function Questions(props: { m: Model; qs: Question[] }) {
  const sorted = () => [...props.qs].sort((a, b) => TOPICS.indexOf(a.topic) - TOPICS.indexOf(b.topic));
  return (
    <Show when={props.qs.length > 0}>
      <h3 {...stylex.attrs(s.h3)}>Questions</h3>
      <For each={sorted()}>
        {(q) => (
          <details {...stylex.attrs(s.details)}>
            <summary {...stylex.attrs(s.summary)}>
              <span {...stylex.attrs(s.muted)}>{q.topic} · </span>
              {q.q}
            </summary>
            <p {...stylex.attrs(s.answer)}>{q.a}</p>
            <Claims m={props.m} ids={q.claims} />
          </details>
        )}
      </For>
    </Show>
  );
}

function Claims(props: { m: Model; ids: string[] }) {
  const list = () => props.ids.map((id) => props.m.claims.get(id)).filter((c): c is Claim => !!c);
  return (
    <div {...stylex.attrs(s.claims)}>
      <For each={list()}>{(c) => <ClaimBox m={props.m} c={c} />}</For>
    </div>
  );
}

function ClaimBox(props: { m: Model; c: Claim }) {
  const c = props.c;
  const pr = props.m.a.pr;
  return (
    <details {...stylex.attrs(s.claim)}>
      <summary {...stylex.attrs(s.summary)}>
        <Show when={c.status === "undetermined"}>
          <span {...stylex.attrs(s.undetermined)}>couldn't determine: </span>
        </Show>
        {c.text}{" "}
        <span {...stylex.attrs(s.muted)}>
          ({c.evidence.length} {c.evidence.length === 1 ? "place" : "places"})
        </span>
      </summary>
      <Show when={c.lookedAt}>
        {(l) => <p {...stylex.attrs(s.p, s.muted)}>Looked at: {l()}</p>}
      </Show>
      <For each={c.evidence}>
        {(ev) => (
          <div {...stylex.attrs(s.evidence)}>
            <a
              href={`https://github.com/${pr.repo}/blob/${ev.side === "base" ? pr.baseSha : pr.headSha}/${ev.path}#L${ev.start}-L${ev.end}`}
              target="_blank"
              rel="noreferrer"
              {...stylex.attrs(s.link, s.mono)}
            >
              {ev.side === "base" ? "before: " : ""}
              {ev.path}:{ev.start}–{ev.end}
            </a>
            <p {...stylex.attrs(s.p, s.muted)}>{ev.note}</p>
            <div {...stylex.attrs(s.pre)}>
              <For each={ev.snippet.split("\n")}>
                {(line, i) => (
                  <div>
                    <span {...stylex.attrs(s.lineNo)}>{ev.start + i()}</span>
                    {line}
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </For>
    </details>
  );
}

function EdgesPanel(props: { m: Model; edges: Edge[]; reveal: (x: Sel) => void; colour: ColourFn }) {
  const m = props.m;
  return (
    <div>
      <Show when={props.edges.length > 1}>
        <p {...stylex.attrs(s.p, s.muted)}>{props.edges.length} connections between these parts at this zoom level</p>
      </Show>
      <For each={props.edges}>
        {(e) => (
          <div>
            <p {...stylex.attrs(s.p, s.muted)}>
              {e.kind} · {e.mode}
            </p>
            <h2 {...stylex.attrs(s.h2)}>
              <button onClick={() => props.reveal({ kind: "node", id: e.from })} {...stylex.attrs(s.crumb)}>
                {m.name(e.from)}
              </button>
              {" → "}
              <button onClick={() => props.reveal({ kind: "node", id: e.to })} {...stylex.attrs(s.crumb)}>
                {m.name(e.to)}
              </button>
            </h2>
            <p {...stylex.attrs(s.p)}>{e.label}</p>
            <Show when={e.data}>{(d) => <p {...stylex.attrs(s.p)}>Carries: {d()}</p>}</Show>
            <ChangeLine change={e.change} summary={e.changeSummary} />
            <Show when={e.crosses.length > 0}>
              <div {...stylex.attrs(s.row)}>
                <span {...stylex.attrs(s.muted)}>Crosses</span>
                <For each={e.crosses}>
                  {(b) => (
                    <button onClick={() => props.reveal({ kind: "boundary", id: b })} {...stylex.attrs(s.button)}>
                      ⟂ {m.boundaries.get(b)?.name ?? b}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Questions m={m} qs={e.questions} />
            <Show when={e.facets.length > 0}>
              <h3 {...stylex.attrs(s.h3)}>How it's built</h3>
              <Facets m={m} list={e.facets} colour={props.colour} />
            </Show>
            <h3 {...stylex.attrs(s.h3)}>Evidence for the connection</h3>
            <Claims m={m} ids={e.claims} />
          </div>
        )}
      </For>
    </div>
  );
}

function BoundaryPanel(props: { m: Model; id: string; reveal: (x: Sel) => void }) {
  const m = props.m;
  const b = m.boundaries.get(props.id)!;
  const crossing = m.a.edges.filter((e) => e.crosses.includes(b.id));
  const inside = m.a.nodes.filter((n) => n.zone === b.id);
  return (
    <div>
      <p {...stylex.attrs(s.p, s.muted)}>{b.kind} boundary</p>
      <h2 {...stylex.attrs(s.h2)}>{b.name}</h2>
      <p {...stylex.attrs(s.p)}>{b.description}</p>
      <ChangeLine change={b.change} />
      <h3 {...stylex.attrs(s.h3)}>Connections crossing it ({crossing.length})</h3>
      <EdgeList m={m} edges={crossing} reveal={props.reveal} />
      <Show when={inside.length > 0}>
        <h3 {...stylex.attrs(s.h3)}>Inside it</h3>
        <ul {...stylex.attrs(s.list)}>
          <For each={inside}>
            {(n) => (
              <li {...stylex.attrs(s.row)}>
                <button onClick={() => props.reveal({ kind: "node", id: n.id })} {...stylex.attrs(s.textButton)}>
                  {n.name}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <h3 {...stylex.attrs(s.h3)}>Evidence</h3>
      <Claims m={m} ids={b.claims} />
    </div>
  );
}

function StepPanel(props: { m: Model; scenario: string; i: number; reveal: (x: Sel) => void }) {
  const m = props.m;
  const sc = m.a.scenarios.find((x) => x.id === props.scenario)!;
  const st = sc.steps[props.i]!;
  const go = (i: number) => setSel({ kind: "step", scenario: sc.id, i });
  return (
    <div>
      <p {...stylex.attrs(s.p, s.muted)}>
        {sc.name} · step {props.i + 1} of {sc.steps.length}
      </p>
      <div {...stylex.attrs(s.row)}>
        <button disabled={props.i === 0} onClick={() => go(props.i - 1)} {...stylex.attrs(s.button)}>
          ← Previous
        </button>
        <button disabled={props.i === sc.steps.length - 1} onClick={() => go(props.i + 1)} {...stylex.attrs(s.button)}>
          Next →
        </button>
      </div>
      <h2 {...stylex.attrs(s.h2)}>{st.action}</h2>
      <p {...stylex.attrs(s.p)}>
        <button onClick={() => props.reveal({ kind: "node", id: st.from })} {...stylex.attrs(s.crumb)}>
          {m.name(st.from)}
        </button>
        {" → "}
        <button onClick={() => props.reveal({ kind: "node", id: st.to })} {...stylex.attrs(s.crumb)}>
          {m.name(st.to)}
        </button>
      </p>
      <Show when={st.data}>{(d) => <p {...stylex.attrs(s.p)}>Carries: {d()}</p>}</Show>
      <ChangeLine change={st.change} />
      <Show when={st.edge}>
        {(e) => (
          <div {...stylex.attrs(s.row)}>
            <button onClick={() => props.reveal({ kind: "edge", ids: [e()] })} {...stylex.attrs(s.button)}>
              Open the connection
            </button>
          </div>
        )}
      </Show>
      <h3 {...stylex.attrs(s.h3)}>Evidence</h3>
      <Claims m={m} ids={st.claims} />
      <h3 {...stylex.attrs(s.h3)}>The whole flow</h3>
      <p {...stylex.attrs(s.p, s.muted)}>Starts when: {sc.trigger}</p>
      <ol>
        <For each={sc.steps}>
          {(x, i) => (
            <li>
              <button onClick={() => go(i())} {...stylex.attrs(s.textButton, i() === props.i && text.modified)}>
                {SIGN[x.change]} {m.name(x.from)} → {m.name(x.to)}: {x.action}
              </button>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

void start();
