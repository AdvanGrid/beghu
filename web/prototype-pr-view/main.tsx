// PROTOTYPE (PR view). Renders one PR analysis (schema.ts) from ./data/<name>.json, chosen by
// `?a=<name>`: a graph with four lenses (modules, data flow, external, order of actions), zoom
// along the node hierarchy, colour by a facet, and a drill-down panel from questions to claims to
// the exact lines. Dev only: Vite serves /prototype-pr-view/index.html.
import { render, type JSX } from "@solidjs/web";
import { createMemo, createSignal, flush, For, Match, Show, Switch } from "solid-js";
import * as stylex from "@stylexjs/stylex";
import { colors, fonts } from "../src/tokens.stylex.ts";
import { pal } from "./tokens.stylex.ts";
import { arrow, layout, NODE_H, NODE_W, type Laid, type Placed } from "./layout.ts";
import { Model, type Lens, type RankItem, type VisEdge } from "./model.ts";
import { Explore, type Api, type ExploreKind } from "./explore.tsx";
import type { Analysis, Boundary, Change, Claim, Edge, FacetAssignment, Node, Question, Scenario, Topic } from "./schema.ts";

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
// OVERVIEW VARIANTS (#145): how the "Boundary crossings" group is shown, switched with ?ov= and [ ].
const OV = [
  { key: "A", name: "Flat list (as is)" },
  { key: "B", name: "By boundary, folded" },
  { key: "C", name: "By line (top-level pair), folded" },
  { key: "D", name: "Boundary, then its lines" },
  { key: "E", name: "One sentence per boundary" },
] as const;
const [ov, setOvRaw] = createSignal(OV.find((x) => x.key === params.get("ov")) ?? OV[0]);
const setOv = (step: number) => {
  setOvRaw(OV[(OV.indexOf(ov()) + step + OV.length) % OV.length]!);
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
  put("ov", ov().key === "A" ? null : ov().key);
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

const fadeIn = stylex.keyframes({ from: { opacity: 0 } });
const s = stylex.create({
  app: {
    backgroundColor: colors.bg,
    color: colors.fg,
    display: "grid",
    fontFamily: fonts.ui,
    fontSize: 13,
    gridTemplateColumns: { default: "minmax(0, 1fr) 460px", "@media (max-width: 720px)": "minmax(0, 1fr)" },
    gridTemplateRows: { default: "auto minmax(0, 1fr)", "@media (max-width: 720px)": "auto auto auto" },
    height: { default: "100vh", "@media (max-width: 720px)": "auto" },
    inset: 0,
    position: { default: "fixed", "@media (max-width: 720px)": "static" },
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
    display: { default: "flex", "@media (max-width: 720px)": "none" },
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
  legend: { display: { default: "flex", "@media (max-width: 720px)": "none" }, alignItems: "center", flexWrap: "wrap", gap: 10, paddingBottom: 6, paddingInline: 14, rowGap: 4 },
  legendHead: { color: colors.fg, fontWeight: 650 },
  legendBreak: { flexBasis: "100%", height: 0 },
  sample: { flexShrink: 0, overflow: "visible" },
  canvas: { flexGrow: 1, minHeight: 0, overflow: { default: "auto", "@media (max-width: 720px)": "visible" } },
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
  ovBar: { alignItems: "center", borderColor: colors.accent, borderRadius: 6, borderStyle: "dashed", borderWidth: 1, display: "flex", fontSize: 12, gap: 8, marginTop: 12, padding: 4 },
  ovButton: { backgroundColor: "transparent", borderColor: colors.accent, borderRadius: 4, borderStyle: "solid", borderWidth: 1, color: colors.accent, cursor: "pointer", fontSize: 12, paddingBlock: 2, paddingInline: 8 },
  ovSub: { paddingInlineStart: 18 },
  ovHead: { fontWeight: 600 },
  ovSentence: { lineHeight: 1.6, marginBlock: 6 },
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
    display: { default: "flex", "@media (max-width: 720px)": "none" },
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
  chapterBand: { cursor: "pointer", fill: pal.contextBg, stroke: colors.line, strokeWidth: 1 },
  chapterSpan: { fill: "none", strokeDasharray: "3 3", strokeWidth: 1.5 },
  tFrame: { display: "flex", maxWidth: "100%", overflowX: "auto", paddingInlineEnd: 14 },
  tLeft: { backgroundColor: colors.bg, flexShrink: 0, left: 0, position: "sticky", zIndex: 1 },
  tRight: { flexShrink: 0, transition: { default: "width 320ms cubic-bezier(.4,0,.2,1)", "@media (prefers-reduced-motion: reduce)": "none" }, width: "var(--w)" },
  tCol: {
    opacity: 1,
    transform: "translateX(var(--tx)) scaleX(var(--sx, 1))",
    transformOrigin: "0 0",
    transition: { default: "transform 320ms cubic-bezier(.4,0,.2,1), opacity 240ms", "@media (prefers-reduced-motion: reduce)": "none" },
  },
  tColIn: { animationDuration: "240ms", animationFillMode: "backwards", animationName: fadeIn },
  dSvg: { height: "var(--h)", transition: { default: "height 320ms cubic-bezier(.4,0,.2,1)", "@media (prefers-reduced-motion: reduce)": "none" } },
  dRow: {
    opacity: 1,
    transform: "translateY(var(--ty)) scaleY(var(--sy, 1))",
    transformOrigin: "0 0",
    transition: { default: "transform 320ms cubic-bezier(.4,0,.2,1), opacity 240ms", "@media (prefers-reduced-motion: reduce)": "none" },
  },
  tColHidden: { opacity: 0, pointerEvents: "none" },
  tHead: { transition: { default: "width 320ms cubic-bezier(.4,0,.2,1)", "@media (prefers-reduced-motion: reduce)": "none" }, width: "var(--hw)" },
  foldPill: { cursor: "pointer", fill: pal.nodeBg, strokeDasharray: "4 3", strokeWidth: 1.4 },
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
  const chapterFile = chapterLoaders[`./data/chapters/${name}.json`];
  if (chapterFile) chapters = await chapterFile();
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
    // OVERVIEW VARIANTS (#145): the two keys right of P, whatever the layout types there.
    if (e.code === "BracketLeft") return setOv(-1);
    if (e.code === "BracketRight") return setOv(1);
    // SCENARIO VARIANTS (#146).
    if (e.code === "Comma") return setSq(-1);
    if (e.code === "Period") return setSq(1);
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomBy(1.25);
    if (e.key === "-" || e.key === "_") zoomBy(0.8);
    if (e.key === "0") zoomFit();
    if (e.key === "ArrowLeft") setVariant(-1);
    if (e.key === "ArrowRight") setVariant(1);
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
        <Legend m={m} />
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
          <button {...stylex.attrs(s.switcherButton)} onClick={() => setVariant(-1)}>←</button>
          <span>
            <b>{variant().key}</b> — {variant().name}
          </span>
          <button {...stylex.attrs(s.switcherButton)} onClick={() => setVariant(1)}>→</button>
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
      if (mine === ticket) setLaid({ view: v, at });
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
              {...stylex.attrs(activeNode() !== null && !neighbours().has(v.node.id) && s.fadedNode)}
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
              {...stylex.attrs(lit().size > 0 && !lit().has(e.key) && s.faded)}
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
//
// SCENARIO VARIANTS (#146): how a long flow is kept readable, switched with ?sq= and the , . keys.
// Lifelines can be drawn at a zoom level (steps inside one part fold into a row you can unfold),
// and a flow can be cut into chapters (hand-written in data/chapters/, standing in for the agent).
const SQ = [
  { key: "A", name: "As written", level: false, chapters: "none" },
  { key: "B", name: "Parts at a zoom level, steps inside a part folded", level: true, chapters: "none" },
  { key: "C", name: "Chapters, folded, in one diagram", level: false, chapters: "bands" },
  { key: "D", name: "Chapters + parts at a zoom level", level: true, chapters: "bands" },
  { key: "E", name: "Chapters as separate diagrams", level: false, chapters: "split" },
  { key: "F", name: "D on its side: parts down the left, time across", level: true, chapters: "bands" },
] as const;
const [sq, setSqRaw] = createSignal(SQ.find((x) => x.key === params.get("sq")) ?? SQ[0]);
const setSq = (step: number) => {
  setSqRaw(SQ[(SQ.indexOf(sq()) + step + SQ.length) % SQ.length]!);
  sync2();
};
/** The zoom level lifelines are drawn at: 1 is the system's top-level parts, 0 as the agent wrote them. */
const [sqLevel, setSqLevelRaw] = createSignal(Number(params.get("sql") ?? 1));
const setSqLevel = (l: number) => (setSqLevelRaw(l), setSqOpen(new Set<string>()), sync2());
/** Lifelines opened one level further (double-click a head), folds unfolded, chapters opened. */
const [sqOpen, setSqOpen] = createSignal(new Set<string>());
const [sqUnfold, setSqUnfold] = createSignal(new Set<string>());
const [sqChap, setSqChap] = createSignal(new Set<number>());
const flip = <T,>(set: (f: (o: Set<T>) => Set<T>) => void, k: T) =>
  set((o) => {
    const n = new Set(o);
    if (!n.delete(k)) n.add(k);
    return n;
  });
function sync2() {
  sync();
  const p = new URLSearchParams(location.search);
  p[sq().key === "A" ? "delete" : "set"]("sq", sq().key);
  p[sqLevel() === 1 ? "delete" : "set"]("sql", String(sqLevel()));
  history.replaceState(null, "", `?${p}`);
}
type Chapter = { title: string; from: number };
let chapters: Record<string, Chapter[]> = {};
const chapterLoaders = import.meta.glob<Record<string, Chapter[]>>("./data/chapters/*.json", { import: "default" });

type Row =
  | { t: "step"; i: number; from: string; to: string }
  | { t: "fold"; key: string; at: string; steps: number[]; open: boolean }
  | { t: "inner"; i: number; at: string }
  | { t: "chapter"; c: number; title: string; steps: number[]; open: boolean };
const ROW_H: Record<Row["t"], number> = { step: 46, fold: 34, inner: 28, chapter: 46 };

/** A scenario's chapters: the agent's (here, hand-written), or one chapter holding every step. */
function chaptersOf(sc: Scenario): { title: string; steps: number[] }[] {
  // The agent's chapters; hand-written ones (data/chapters/) for analyses made before the rule.
  const cs = sc.chapters?.length ? sc.chapters : chapters[sc.id];
  const all = sc.steps.map((_, i) => i);
  if (!cs?.length) return [{ title: sc.name, steps: all }];
  return cs.map((c, k) => ({ title: c.title, steps: all.slice(c.from, cs[k + 1]?.from ?? all.length) }));
}

function Sequence(props: { m: Model; colour: ColourFn }) {
  const m = props.m;
  const current = createMemo(() => m.a.scenarios.find((x) => x.id === scenario()) ?? m.a.scenarios[0]);
  // A new scenario starts folded again.
  createMemo(() => (current(), setSqOpen(new Set<string>()), setSqUnfold(new Set<string>()), setSqChap(new Set<number>())));
  const COL = 190;
  const TOP = 92;
  const levelOn = () => sq().level && sqLevel() > 0;
  /** The lifeline a node is drawn on: its ancestor at the chosen level, or deeper where opened. */
  const shown = (id: string) => {
    if (!levelOn()) return id;
    const ch = m.chain(id);
    let k = Math.min(ch.length - 1, sqLevel());
    while (k < ch.length - 1 && sqOpen().has(ch[k]!)) k++;
    return ch[k]!;
  };
  const rowsOf = (sc: Scenario, idx: number[]): Row[] => {
    const out: Row[] = [];
    for (const i of idx) {
      const st = sc.steps[i]!;
      const f = shown(st.from);
      const t = shown(st.to);
      if (f === t && st.from !== st.to) {
        const last = out.at(-1);
        if (last?.t === "fold" && last.at === f) last.steps.push(i);
        else out.push({ t: "fold", key: `${f}:${i}`, at: f, steps: [i], open: false });
      } else out.push({ t: "step", i, from: f, to: t });
    }
    // Unfold the opened folds; a fold of one step is just that step on its lifeline.
    return out.flatMap((r): Row[] => {
      if (r.t !== "fold") return [r];
      const open = r.steps.length === 1 || sqUnfold().has(r.key);
      const inner = r.steps.map((i): Row => ({ t: "inner", i, at: r.at }));
      return r.steps.length === 1 ? inner : open ? [{ ...r, open: true }, ...inner] : [r];
    });
  };
  /** One diagram: its lifelines (in order of first appearance) and its rows. */
  const diagrams = createMemo(() => {
    const sc = current();
    if (!sc) return [];
    const cs = chaptersOf(sc);
    const actorsOf = (idx: number[]) => {
      const a: string[] = [];
      for (const i of idx) for (const id of [sc.steps[i]!.from, sc.steps[i]!.to]) if (!a.includes(shown(id))) a.push(shown(id));
      return a;
    };
    const mode = sq().chapters;
    if (mode === "split") return cs.map((c, k) => ({ title: `${k + 1}. ${c.title}`, actors: actorsOf(c.steps), rows: rowsOf(sc, c.steps) }));
    const all = sc.steps.map((_, i) => i);
    if (mode === "none" || cs.length === 1) return [{ title: "", actors: actorsOf(all), rows: rowsOf(sc, all) }];
    const rows = cs.flatMap((c, k): Row[] => {
      const open = sqChap().has(k);
      return [{ t: "chapter", c: k, title: c.title, steps: c.steps, open }, ...(open ? rowsOf(sc, c.steps) : [])];
    });
    return [{ title: "", actors: actorsOf(all), rows }];
  });
  const seqScale = createMemo(() => {
    const ds = diagrams();
    const w = Math.max(...ds.map((d) => 60 + d.actors.length * COL), 400);
    const h = ds.reduce((n, d) => n + TOP + d.rows.reduce((a, r) => a + ROW_H[r.t], 0) + 70, 0);
    drawing = { width: w, height: h, scale: 1 };
    return zoom() ?? 1;
  });
  const changeOf = (sc: Scenario, idx: number[]): Change => {
    const cs = new Set(idx.map((i) => sc.steps[i]!.change));
    return cs.size === 1 ? [...cs][0]! : cs.has("added") ? "added" : "modified";
  };
  /** One row of the across-the-page diagram (C and D), drawn at `y0`. */
  const drawRow = (r: Row, y0: () => number, open: () => boolean, x: (id: string) => number, seqW: number): JSX.Element => {
    const sc = () => current()!;
    if (r.t === "chapter") {
      const parts = [...new Set(r.steps.flatMap((i) => [shown(sc().steps[i]!.from), shown(sc().steps[i]!.to)]))];
      const ch = changeOf(sc(), r.steps);
      const xs = parts.map(x);
      const x1 = Math.min(...xs);
      const x2 = Math.max(...xs);
      return (
        <g data-hit onClick={() => flip(setSqChap, r.c)} {...stylex.attrs(s.clickable)}>
          <rect x={10} y={y0() + 2} width={seqW - 20} height={ROW_H.chapter - 4} rx={6} {...stylex.attrs(s.chapterBand)} />
          <Show when={!open()}>
            {/* Which lifelines the folded chapter touches: a rail along the band's foot. */}
            <line x1={x1} x2={x2} y1={y0() + ROW_H.chapter - 7} y2={y0() + ROW_H.chapter - 7} {...stylex.attrs(s.chapterSpan, stroke[ch])} />
            <For each={xs}>{(cx) => <circle cx={cx} cy={y0() + ROW_H.chapter - 7} r={3.5} {...stylex.attrs(swatch[ch])} />}</For>
          </Show>
          <text x={20} y={y0() + 21} {...stylex.attrs(s.svgText)}>
            {open() ? "▾" : "▸"} {r.c + 1}. {SIGN[ch]} {r.title}
          </text>
          <text x={seqW - 20} y={y0() + 21} text-anchor="end" {...stylex.attrs(s.svgSmall)}>
            steps {r.steps[0]! + 1}–{r.steps.at(-1)! + 1}
          </text>
        </g>
      );
    }
    if (r.t === "fold") {
      const ch = changeOf(sc(), r.steps);
      return (
        <g data-hit onClick={() => flip(setSqUnfold, r.key)} {...stylex.attrs(s.clickable)}>
          <rect x={x(r.at) - COL / 2 + 14} y={y0() + 5} width={COL - 28} height={24} rx={12} {...stylex.attrs(s.foldPill, stroke[ch])} />
          <text x={x(r.at)} y={y0() + 21} text-anchor="middle" {...stylex.attrs(s.svgLabel)}>
            {open() ? "▾" : "▸"} {SIGN[ch]} {r.steps.length} steps inside
          </text>
          <title>{r.steps.map((i) => `${i + 1}. ${m.name(sc().steps[i]!.from)} → ${m.name(sc().steps[i]!.to)}: ${sc().steps[i]!.action}`).join("\n")}</title>
        </g>
      );
    }
    const st = sc().steps[r.i]!;
    const on = () => {
      const v = sel();
      return v?.kind === "step" && v.scenario === sc().id && v.i === r.i;
    };
    const pick = () => setSel({ kind: "step", scenario: sc().id, i: r.i });
    if (r.t === "inner") {
      // A step inside one lifeline: a short loop on it, labelled with the parts it joins.
      const y = () => y0() + 14;
      // Near the right edge the loop and its label go to the lifeline's left.
      const label = `${r.i + 1}. ${SIGN[st.change]} ${m.name(st.from)} → ${m.name(st.to)}: ${st.action}`;
      const w = Math.min(label.length, 70) * 6 + 8;
      const side = x(r.at) + 30 + w > seqW ? -1 : 1;
      const lx = side > 0 ? x(r.at) + 30 : x(r.at) - 30 - w + 6;
      return (
        <g data-hit onClick={pick} {...stylex.attrs(s.clickable)}>
          <path d={`M${x(r.at)},${y() - 6} h${22 * side} v12 h${-22 * side}`} {...stylex.attrs(s.edge, stroke[st.change], on() && s.edgeSelected)} />
          <rect x={lx - 3} y={y() - 11} width={w} height={18} rx={3} {...stylex.attrs(s.labelBg)} />
          <text x={lx} y={y() + 3} {...stylex.attrs(s.svgLabel, text[st.change])}>
            {clip(label, 70)}
          </text>
          <title>{`${st.action}${st.data ? `\n${st.data}` : ""}`}</title>
        </g>
      );
    }
    const y = () => y0() + 24;
    const self = r.from === r.to;
    const x1 = x(r.from);
    const x2 = x(r.to);
    const dir = x2 >= x1 ? 1 : -1;
    const lx = self ? x1 + 8 : Math.min(x1, x2) + 6;
    return (
      <g data-hit onClick={pick} {...stylex.attrs(s.clickable)}>
        <Show
          when={!self}
          fallback={<path d={`M${x1},${y()} h40 v16 h-40`} {...stylex.attrs(s.edge, stroke[st.change], on() && s.edgeSelected)} />}
        >
          <line x1={x1} x2={x2} y1={y()} y2={y()} {...stylex.attrs(s.edge, stroke[st.change], on() && s.edgeSelected)} />
          <path d={`M${x2},${y()} l${-9 * dir},-5 l0,10 z`} {...stylex.attrs(swatch[st.change])} />
        </Show>
        <rect x={Math.min(x1, x2) - 6} y={y() - 20} width={Math.abs(x2 - x1) + (self ? 260 : 12)} height={30} {...stylex.attrs(s.rowHit)} />
        <text x={lx} y={y() - 6} {...stylex.attrs(s.svgLabel, text[st.change])}>
          {r.i + 1}. {SIGN[st.change]} {clip(st.action, self ? 40 : Math.max(12, Math.floor(Math.abs(x2 - x1) / 6.4)))}
        </text>
        <title>{`${m.name(st.from)} → ${m.name(st.to)}\n${st.action}${st.data ? `\n${st.data}` : ""}`}</title>
      </g>
    );
  };
  // SCENARIO VARIANTS (#146), D animated: every row stays mounted in a fixed order, so opening a
  // chapter grows its steps out from under its band and slides the chapters below it down.
  type DItem = { key: string; r: Row; y: number; show: boolean };
  const dl = createMemo(() => {
    const sc = current();
    const actors = diagrams()[0]?.actors ?? [];
    if (!sc) return { items: [] as DItem[], bottom: TOP, actors };
    const cs = chaptersOf(sc);
    const one = cs.length === 1;
    const items: DItem[] = [];
    let y = TOP;
    cs.forEach((c, k) => {
      const open = one || sqChap().has(k);
      if (!one) {
        items.push({ key: `c:${k}`, r: { t: "chapter", c: k, title: c.title, steps: c.steps, open }, y, show: true });
        y += ROW_H.chapter;
      }
      const at = y;
      for (const r of rowsOf(sc, c.steps)) {
        const key = r.t === "fold" ? `f:${r.key}` : r.t === "chapter" ? "c?" : `s:${r.i}`;
        items.push({ key, r, y: open ? y : Math.max(TOP, at - ROW_H.chapter), show: open });
        if (open) y += ROW_H[r.t];
      }
    });
    return { items, bottom: y + 10, actors };
  });
  const Down = (props2: { colour: ColourFn }) => {
    const x = (id: string) => 30 + dl().actors.indexOf(id) * COL + COL / 2;
    const seqW = () => 60 + dl().actors.length * COL;
    const canOpen = (id: string) => levelOn() && (m.children.get(id)?.length ?? 0) > 0;
    return (
      <svg width={seqW()} style={{ "--h": `${dl().bottom + 20}px` }} {...stylex.attrs(s.dSvg)}>
        <For each={dl().actors}>
          {(id) => {
            const n = m.nodes.get(id)!;
            const band = (): Swatch => {
              const c = colorBy();
              if (c === "change") return n.change;
              return props2.colour(
                n.facets.find((f) => f.facet === c),
                c,
              )[0]!;
            };
            return (
              <g data-hit onClick={() => setSel({ kind: "node", id })} onDblClick={() => canOpen(id) && flip(setSqOpen, id)} {...stylex.attrs(s.clickable)}>
                <line x1={x(id)} x2={x(id)} y1={TOP - 20} y2={6000} {...stylex.attrs(s.lifeline)} />
                <rect x={x(id) - COL / 2 + 8} y={10} width={COL - 16} height={52} rx={6} {...stylex.attrs(s.nodeBox, stroke[n.change])} />
                <rect x={x(id) - COL / 2 + 8} y={10} width={7} height={52} {...stylex.attrs(swatch[band()])} />
                <text x={x(id) - COL / 2 + 22} y={30} {...stylex.attrs(s.svgSmall, text[n.change])}>
                  {m.kindLabel(id)} {m.showsChange(id) ? SIGN[n.change] : ""}
                </text>
                <text x={x(id) - COL / 2 + 22} y={49} {...stylex.attrs(s.svgText)}>
                  {clip(n.name, canOpen(id) ? 16 : 19)}
                </text>
                <Show when={canOpen(id)}>
                  <text x={x(id) + COL / 2 - 26} y={49} {...stylex.attrs(s.svgSmall)}>
                    ⊞
                  </text>
                </Show>
                <title>{`${n.summary}${canOpen(id) ? "\nDouble-click to open its parts as lifelines" : ""}`}</title>
              </g>
            );
          }}
        </For>
        <For each={dl().items} keyed={(it) => it.key}>
          {(it) => (
            <g style={{ "--ty": `${it().y}px`, "--sy": it().show ? "1" : "0.1" }} {...stylex.attrs(s.dRow, s.tColIn, !it().show && s.tColHidden)}>
              {drawRow(it().r, () => 0, () => (it().r as { open?: boolean }).open ?? false, x, seqW())}
            </g>
          )}
        </For>
      </svg>
    );
  };
  // SCENARIO VARIANTS (#146), F: D turned on its side. The parts stack down the first column (it
  // stays put while the rest scrolls sideways), time runs left to right, and each step is a
  // vertical line between the two parts' rows. Every column stays mounted in a fixed order, so
  // opening a chapter grows its steps out of it and slides the columns after it along.
  const LEFT = 136;
  const RH = 58;
  const HEAD = 84;
  const W = { step: 128, inner: 128, fold: 104, chapter: 160 } as const;
  type Item = { key: string; r: Row; x: number; show: boolean };
  const tl = createMemo(() => {
    const sc = current();
    const actors = diagrams()[0]?.actors ?? [];
    if (!sc) return { items: [] as Item[], heads: [], width: 0, actors };
    const cs = chaptersOf(sc);
    const one = cs.length === 1;
    const items: Item[] = [];
    const heads: { key: string; c: number; title: string; x: number; w: number; open: boolean; change: Change }[] = [];
    let x = 10;
    cs.forEach((c, k) => {
      const open = one || sqChap().has(k);
      const start = x;
      if (!one) {
        items.push({ key: `c:${k}`, r: { t: "chapter", c: k, title: c.title, steps: c.steps, open }, x: start, show: !open });
        if (!open) x += W.chapter;
      }
      for (const r of rowsOf(sc, c.steps)) {
        const key = r.t === "fold" ? `f:${r.key}` : r.t === "chapter" ? `c?` : `s:${r.i}`;
        items.push({ key, r, x: open ? x : start, show: open });
        if (open) x += W[r.t];
      }
      if (!one) heads.push({ key: `h:${k}`, c: k, title: c.title, x: start, w: open ? x - start : W.chapter, open, change: changeOf(sc, c.steps) });
    });
    return { items, heads, width: x + 10, actors };
  });
  const Transposed = () => {
    const sc = () => current()!;
    const cy = (id: string) => HEAD + tl().actors.indexOf(id) * RH + RH / 2;
    const H = () => HEAD + tl().actors.length * RH + 12;
    /** Words wrapped into lines of at most `n` characters. */
    const wrap = (t: string, n: number, max = 4) => {
      const out: string[] = [];
      for (const w of t.split(/\s+/)) {
        const last = out.at(-1);
        if (last !== undefined && last.length + 1 + w.length <= n) out[out.length - 1] = `${last} ${w}`;
        else out.push(w);
      }
      return out.length > max ? [...out.slice(0, max - 1), clip(out.slice(max - 1).join(" "), n)] : out;
    };
    const lines = (ls: string[], lx: number, ly: number, style: object) => (
      <For each={ls}>
        {(l, k) => (
          <text x={lx} y={ly + k() * 13} {...(style as Record<string, string>)}>
            {l}
          </text>
        )}
      </For>
    );
    /** One column's drawing, at x = 0; the column's group moves it into place. */
    const column = (it: () => Item) => {
      const r = it().r;
      const w = W[r.t];
      if (r.t === "chapter") {
        const ch = changeOf(sc(), r.steps);
        const parts = [...new Set(r.steps.flatMap((i) => [shown(sc().steps[i]!.from), shown(sc().steps[i]!.to)]))];
        const rx = w / 2;
        return (
          <g data-hit onClick={() => flip(setSqChap, r.c)} {...stylex.attrs(s.clickable)}>
            <rect x={4} y={4} width={w - 8} height={H() - 8} rx={6} {...stylex.attrs(s.chapterBand)} />
            {lines(wrap(`▸ ${r.c + 1}. ${SIGN[ch]} ${r.title}`, 20, 5), 12, 22, stylex.attrs(s.svgText))}
            <line x1={rx} x2={rx} y1={Math.min(...parts.map(cy))} y2={Math.max(...parts.map(cy))} {...stylex.attrs(s.chapterSpan, stroke[ch])} />
            <For each={parts}>{(id) => <circle cx={rx} cy={cy(id)} r={4} {...stylex.attrs(swatch[ch])} />}</For>
            <text x={rx} y={H() - 14} text-anchor="middle" {...stylex.attrs(s.svgSmall)}>
              steps {r.steps[0]! + 1}–{r.steps.at(-1)! + 1}
            </text>
          </g>
        );
      }
      if (r.t === "fold") {
        const ch = changeOf(sc(), r.steps);
        return (
          <g data-hit onClick={() => flip(setSqUnfold, r.key)} {...stylex.attrs(s.clickable)}>
            <rect x={6} y={cy(r.at) - 12} width={w - 12} height={24} rx={12} {...stylex.attrs(s.foldPill, stroke[ch])} />
            <text x={w / 2} y={cy(r.at) + 4} text-anchor="middle" {...stylex.attrs(s.svgLabel)}>
              {(it().r as { open: boolean }).open ? "▾" : "▸"} {SIGN[ch]} {r.steps.length} steps
            </text>
            <title>{r.steps.map((i) => `${i + 1}. ${m.name(sc().steps[i]!.from)} → ${m.name(sc().steps[i]!.to)}: ${sc().steps[i]!.action}`).join("\n")}</title>
          </g>
        );
      }
      const st = sc().steps[r.i]!;
      const on = () => {
        const v = sel();
        return v?.kind === "step" && v.scenario === sc().id && v.i === r.i;
      };
      const pick = () => setSel({ kind: "step", scenario: sc().id, i: r.i });
      const lx = 14;
      if (r.t === "inner" || r.from === r.to) {
        // A step inside one part: a small loop on its row, the label under it.
        const y = cy(r.t === "inner" ? r.at : r.from);
        const label = r.t === "inner" ? `${r.i + 1}. ${SIGN[st.change]} ${m.name(st.from)} → ${m.name(st.to)}: ${st.action}` : `${r.i + 1}. ${SIGN[st.change]} ${st.action}`;
        return (
          <g data-hit onClick={pick} {...stylex.attrs(s.clickable)}>
            <rect x={0} y={y - 14} width={w} height={RH - 4} {...stylex.attrs(s.rowHit)} />
            <path d={`M${lx},${y} v-10 h16 v10`} {...stylex.attrs(s.edge, stroke[st.change], on() && s.edgeSelected)} />
            <path d={`M${lx + 16},${y} l-4,-7 l8,0 z`} {...stylex.attrs(swatch[st.change])} />
            {lines(wrap(label, 18, 2), lx - 6, y + 14, stylex.attrs(s.svgLabel, text[st.change]))}
            <title>{`${m.name(st.from)} → ${m.name(st.to)}\n${st.action}${st.data ? `\n${st.data}` : ""}`}</title>
          </g>
        );
      }
      const y1 = cy(r.from);
      const y2 = cy(r.to);
      const dir = y2 >= y1 ? 1 : -1;
      const ls = wrap(`${r.i + 1}. ${SIGN[st.change]} ${st.action}`, 17, 4);
      // The label sits beside the line, in the middle of its run (or just past the receiver when
      // the run is short).
      const ly = Math.abs(y2 - y1) > ls.length * 13 + 16 ? (y1 + y2) / 2 - (ls.length * 13) / 2 + 10 : Math.max(y1, y2) + 16;
      return (
        <g data-hit onClick={pick} {...stylex.attrs(s.clickable)}>
          <rect x={0} y={Math.min(y1, y2)} width={w} height={Math.abs(y2 - y1)} {...stylex.attrs(s.rowHit)} />
          <line x1={lx} x2={lx} y1={y1} y2={y2 - 9 * dir} {...stylex.attrs(s.edge, stroke[st.change], on() && s.edgeSelected)} />
          <circle cx={lx} cy={y1} r={3} {...stylex.attrs(swatch[st.change])} />
          <path d={`M${lx},${y2} l-5,${-9 * dir} l10,0 z`} {...stylex.attrs(swatch[st.change])} />
          <rect x={lx + 5} y={ly - 11} width={w - 22} height={ls.length * 13 + 4} rx={3} {...stylex.attrs(s.labelBg)} />
          {lines(ls, lx + 8, ly, stylex.attrs(s.svgLabel, text[st.change]))}
          <title>{`${m.name(st.from)} → ${m.name(st.to)}\n${st.action}${st.data ? `\n${st.data}` : ""}`}</title>
        </g>
      );
    };
    return (
      <div {...stylex.attrs(s.tFrame)}>
        <svg width={LEFT} height={H()} {...stylex.attrs(s.tLeft)}>
          <For each={tl().actors}>
            {(id) => {
              const n = m.nodes.get(id)!;
              const open = levelOn() && (m.children.get(id)?.length ?? 0) > 0;
              const y = () => cy(id) - 22;
              return (
                <g data-hit onClick={() => setSel({ kind: "node", id })} onDblClick={() => open && flip(setSqOpen, id)} {...stylex.attrs(s.clickable)}>
                  <rect x={6} y={y()} width={LEFT - 12} height={44} rx={6} {...stylex.attrs(s.nodeBox, stroke[n.change])} />
                  <rect x={6} y={y()} width={6} height={44} {...stylex.attrs(swatch[n.change])} />
                  <text x={18} y={y() + 17} {...stylex.attrs(s.svgSmall, text[n.change])}>
                    {m.kindLabel(id)} {m.showsChange(id) ? SIGN[n.change] : ""}
                  </text>
                  <text x={18} y={y() + 34} {...stylex.attrs(s.svgText)}>
                    {clip(n.name, open ? 12 : 14)}
                  </text>
                  <Show when={open}>
                    <text x={LEFT - 24} y={y() + 34} {...stylex.attrs(s.svgSmall)}>
                      ⊞
                    </text>
                  </Show>
                  <title>{`${n.name}\n${n.summary}${open ? "\nDouble-click to open its parts" : ""}`}</title>
                </g>
              );
            }}
          </For>
        </svg>
        <svg height={H()} style={{ "--w": `${tl().width}px` }} {...stylex.attrs(s.tRight)}>
          <For each={tl().actors}>{(id) => <line x1={0} x2={6000} y1={cy(id)} y2={cy(id)} {...stylex.attrs(s.lifeline)} />}</For>
          <For each={tl().heads} keyed={(h) => h.key}>
            {(h) => (
              <g
                data-hit
                onClick={() => flip(setSqChap, h().c)}
                style={{ "--tx": `${h().x}px`, "--hw": `${Math.max(0, h().w - 4)}px` }}
                {...stylex.attrs(s.clickable, s.tCol, !h().open && s.tColHidden)}
              >
                <rect x={2} y={4} height={HEAD - 10} rx={6} {...stylex.attrs(s.chapterBand, s.tHead)} />
                {lines(wrap(`▾ ${h().c + 1}. ${SIGN[h().change]} ${h().title}`, 34, 3), 10, 22, stylex.attrs(s.svgText))}
              </g>
            )}
          </For>
          <For each={tl().items} keyed={(it) => it.key}>
            {(it) => (
              <g style={{ "--tx": `${it().x}px`, "--sx": it().show ? "1" : "0.1" }} {...stylex.attrs(s.tCol, s.tColIn, !it().show && s.tColHidden)}>
                {column(it)}
              </g>
            )}
          </For>
        </svg>
      </div>
    );
  };
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
              {SIGN[sc.change]} {sc.name} <span {...stylex.attrs(s.muted)}>({sc.steps.length})</span>
            </button>
          )}
        </For>
      </div>
      <div {...stylex.attrs(s.crumbs)}>
        <span {...stylex.attrs(s.ovBar)}>
          <button {...stylex.attrs(s.ovButton)} onClick={() => setSq(-1)}>← ,</button>
          <span>
            scenario view <b>{sq().key}</b> of {SQ.length} — {sq().name}
          </span>
          <button {...stylex.attrs(s.ovButton)} onClick={() => setSq(1)}>. →</button>
        </span>
        <Show when={sq().key === "D" || sq().key === "F"}>
          <span {...stylex.attrs(s.tabs)}>
            <button onClick={() => (setSqRaw(SQ[3]), sync2())} {...stylex.attrs(s.tab, sq().key === "D" && s.tabOn)} title="Parts across the top, time runs down">
              Time runs ↓
            </button>
            <button onClick={() => (setSqRaw(SQ[5]), sync2())} {...stylex.attrs(s.tab, sq().key === "F" && s.tabOn)} title="Parts down the left, time runs across">
              Time runs →
            </button>
          </span>
        </Show>
        <Show when={sq().level}>
          <label {...stylex.attrs(s.label)}>
            Lifelines:
            <select value={String(sqLevel())} onChange={(e) => setSqLevel(Number(e.currentTarget.value))} {...stylex.attrs(s.select)}>
              <option value="1">Top-level parts</option>
              <option value="2">One level in</option>
              <option value="3">Two levels in</option>
              <option value="0">As the agent wrote them</option>
            </select>
          </label>
          <For each={[...sqOpen()]}>
            {(id) => (
              <button {...stylex.attrs(s.crumb)} onClick={() => flip(setSqOpen, id)} title="Close it back into one lifeline">
                {m.name(id)} opened ✕
              </button>
            )}
          </For>
        </Show>
        <Show when={sq().chapters === "bands" && diagrams()[0]?.rows.some((r) => r.t === "chapter")}>
          <button {...stylex.attrs(s.crumb)} onClick={() => setSqChap(new Set(chaptersOf(current()!).map((_, k) => k)))}>
            Open all chapters
          </button>
          <button {...stylex.attrs(s.crumb)} onClick={() => setSqChap(new Set<number>())}>
            Fold all
          </button>
        </Show>
      </div>
      <Show when={current()}>
        {(sc) => (
          <>
            <p {...stylex.attrs(s.p, s.muted)}>
              <span>
                &nbsp;&nbsp;&nbsp;Starts when: {sc().trigger} · {sc().steps.length} steps
              </span>
            </p>
            <Show when={sq().key === "F"}>
              <Transposed />
            </Show>
            <Show when={sq().key === "D"}>
              <Down colour={props.colour} />
            </Show>
            <For each={sq().key === "F" || sq().key === "D" ? [] : diagrams()}>
              {(d) => {
                const x = (id: string) => 30 + d.actors.indexOf(id) * COL + COL / 2;
                const seqW = 60 + d.actors.length * COL;
                const ys: number[] = [];
                let yy = TOP;
                for (const r of d.rows) (ys.push(yy), (yy += ROW_H[r.t]));
                const bottom = yy + 10;
                const canOpen = (id: string) => levelOn() && (m.children.get(id)?.length ?? 0) > 0 && d.rows.some((r) => r.t !== "chapter");
                return (
                  <>
                    <Show when={d.title}>
                      <h3 {...stylex.attrs(s.h3)}>&nbsp;&nbsp;&nbsp;{d.title}</h3>
                    </Show>
                    <svg width={seqW * seqScale()} height={(bottom + 20) * seqScale()} viewBox={`0 0 ${seqW} ${bottom + 20}`}>
                      <For each={d.actors}>
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
                            <g
                              data-hit
                              onClick={() => setSel({ kind: "node", id })}
                              onDblClick={() => canOpen(id) && flip(setSqOpen, id)}
                              {...stylex.attrs(s.clickable)}
                            >
                              <line x1={x(id)} x2={x(id)} y1={TOP - 20} y2={bottom} {...stylex.attrs(s.lifeline)} />
                              <rect x={x(id) - COL / 2 + 8} y={10} width={COL - 16} height={52} rx={6} {...stylex.attrs(s.nodeBox, stroke[n.change])} />
                              <rect x={x(id) - COL / 2 + 8} y={10} width={7} height={52} {...stylex.attrs(swatch[band()])} />
                              <text x={x(id) - COL / 2 + 22} y={30} {...stylex.attrs(s.svgSmall, text[n.change])}>
                                {m.kindLabel(id)} {m.showsChange(id) ? SIGN[n.change] : ""}
                              </text>
                              <text x={x(id) - COL / 2 + 22} y={49} {...stylex.attrs(s.svgText)}>
                                {clip(n.name, canOpen(id) ? 16 : 19)}
                              </text>
                              <Show when={canOpen(id)}>
                                <text x={x(id) + COL / 2 - 26} y={49} {...stylex.attrs(s.svgSmall)}>
                                  ⊞
                                </text>
                              </Show>
                              <title>{`${n.summary}${canOpen(id) ? "\nDouble-click to open its parts as lifelines" : ""}`}</title>
                            </g>
                          );
                        }}
                      </For>
                      <For each={d.rows}>
                        {(r, k) => drawRow(r, () => ys[k()]!, () => (r as { open?: boolean }).open ?? false, x, seqW)}
                      </For>
                    </svg>
                  </>
                );
              }}
            </For>
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

// OVERVIEW VARIANTS (#145). Every variant keeps the same stated order: boundary kind (trust,
// tenant, process, network, other), then name; pairs by their parts' names. Never by count.
const KIND_ORDER = ["trust", "tenant", "process", "network", "other"];

function countLine(edges: Edge[]): string {
  const c = { added: 0, modified: 0, removed: 0 };
  for (const e of edges) if (e.change !== "unchanged") c[e.change]++;
  const parts = [c.added && `${c.added} added`, c.modified && `${c.modified} changed`, c.removed && `${c.removed} removed`].filter(Boolean);
  return edges.length === 1 ? parts.join("").replace(/^1 /, "") : `${edges.length} connections: ${parts.join(", ")}`;
}

function Crossings(props: { m: Model; reveal: (x: Sel) => void }) {
  const m = props.m;
  const a = m.a;
  const top = (id: string): string => {
    let n = m.nodes.get(id)!;
    while (n.parent && m.nodes.get(n.parent) && m.nodes.get(n.parent)!.kind !== "system") n = m.nodes.get(n.parent)!;
    return n.id;
  };
  const xs = a.edges.filter((e) => e.crosses.length > 0 && e.change !== "unchanged");
  const bounds = a.boundaries
    .map((b) => ({ b, edges: xs.filter((e) => e.crosses.includes(b.id)) }))
    .filter((x) => x.edges.length > 0 || x.b.change !== "unchanged")
    .sort((x, y) => KIND_ORDER.indexOf(x.b.kind) - KIND_ORDER.indexOf(y.b.kind) || x.b.name.localeCompare(y.b.name));
  type Pair = { from: string; to: string; edges: Edge[] };
  const pairsOf = (edges: Edge[]): Pair[] => {
    const map = new Map<string, Pair>();
    for (const e of edges) {
      const f = top(e.from), t = top(e.to);
      const k = `${f}>${t}`;
      if (!map.has(k)) map.set(k, { from: f, to: t, edges: [] });
      map.get(k)!.edges.push(e);
    }
    return [...map.values()].sort((x, y) => m.name(x.from).localeCompare(m.name(y.from)) || m.name(x.to).localeCompare(m.name(y.to)));
  };
  const bname = (id: string) => m.boundaries.get(id)?.name ?? id;
  const EdgeRows = (p: { edges: Edge[] }) => (
    <ul {...stylex.attrs(s.list, s.ovSub)}>
      <For each={p.edges}>
        {(e) => (
          <li {...stylex.attrs(s.row)}>
            <span {...stylex.attrs(s.mono, text[e.change])}>{SIGN[e.change] || "·"}</span>
            <button onClick={() => props.reveal({ kind: "edge", ids: [e.id] })} {...stylex.attrs(s.textButton)}>
              {m.name(e.from)} → {m.name(e.to)}: {e.label}
            </button>
          </li>
        )}
      </For>
    </ul>
  );
  const PairRow = (p: { pair: Pair; crosses?: boolean }) => (
    <details {...stylex.attrs(s.details)}>
      <summary {...stylex.attrs(s.summary)}>
        <button onClick={(ev) => (ev.preventDefault(), props.reveal({ kind: "edge", ids: p.pair.edges.map((e) => e.id) }))} {...stylex.attrs(s.textButton)}>
          {m.name(p.pair.from)} → {m.name(p.pair.to)}
        </button>{" "}
        <span {...stylex.attrs(s.muted)}>
          · {countLine(p.pair.edges)}
          {p.crosses ? ` · ⟂ ${[...new Set(p.pair.edges.flatMap((e) => e.crosses))].map(bname).join(", ")}` : ""}
        </span>
      </summary>
      <EdgeRows edges={p.pair.edges} />
    </details>
  );
  const changedBadge = (b: Boundary) => (b.change !== "unchanged" ? <span {...stylex.attrs(text[b.change])}> · the boundary itself {b.change === "modified" ? "changed" : b.change}</span> : null);
  const BoundaryName = (p: { b: Boundary }) => (
    <button onClick={(ev) => (ev.preventDefault(), props.reveal({ kind: "boundary", id: p.b.id }))} {...stylex.attrs(s.textButton, s.ovHead)}>
      ⟂ {p.b.name}
    </button>
  );
  const head = (n: number) => (
    <>
      <h3 {...stylex.attrs(s.h3)}>Boundary crossings ({n})</h3>
      <p {...stylex.attrs(s.p, s.muted)}>
        {xs.length} new or changed connections cross a trust, tenant, process or network boundary. Listed by boundary kind, then name.
      </p>
    </>
  );
  return (
    <Switch>
      <Match when={ov().key === "B"}>
        {head(bounds.length)}
        <For each={bounds}>
          {({ b, edges }) => (
            <details {...stylex.attrs(s.details)}>
              <summary {...stylex.attrs(s.summary)}>
                <BoundaryName b={b} /> <span {...stylex.attrs(s.muted)}>({b.kind}) · {edges.length ? countLine(edges) : "no connections changed"}</span>
                {changedBadge(b)}
              </summary>
              <EdgeRows edges={edges} />
            </details>
          )}
        </For>
      </Match>
      <Match when={ov().key === "C"}>
        {(() => {
          const pairs = pairsOf(xs);
          const changedB = bounds.filter((x) => x.b.change !== "unchanged");
          return (
            <>
              {head(pairs.length + changedB.length)}
              <For each={changedB}>
                {({ b }) => (
                  <div {...stylex.attrs(s.row)}>
                    <BoundaryName b={b} /> {changedBadge(b)}
                  </div>
                )}
              </For>
              <For each={pairs}>{(p) => <PairRow pair={p} crosses />}</For>
            </>
          );
        })()}
      </Match>
      <Match when={ov().key === "D"}>
        {head(bounds.length)}
        <For each={bounds}>
          {({ b, edges }) => (
            <div {...stylex.attrs(s.ovSentence)}>
              <div>
                <BoundaryName b={b} /> <span {...stylex.attrs(s.muted)}>({b.kind}) · {b.description}</span>
                {changedBadge(b)}
              </div>
              <div {...stylex.attrs(s.ovSub)}>
                <For each={pairsOf(edges)}>{(p) => <PairRow pair={p} />}</For>
              </div>
            </div>
          )}
        </For>
      </Match>
      <Match when={ov().key === "E"}>
        {head(bounds.length)}
        <For each={bounds}>
          {({ b, edges }) => {
            const pairs = pairsOf(edges);
            const NodeLink = (p: { id: string }) => (
              <button onClick={() => props.reveal({ kind: "node", id: p.id })} {...stylex.attrs(s.textButton, s.ovHead)}>
                {m.name(p.id)}
              </button>
            );
            return (
              <p {...stylex.attrs(s.p, s.ovSentence)}>
                <BoundaryName b={b} />
                {changedBadge(b)}
                <span {...stylex.attrs(s.muted)}>: </span>
                <Show when={edges.length} fallback={<span {...stylex.attrs(s.muted)}>no connections across it changed.</span>}>
                  <For each={pairs}>
                    {(p, i) => (
                      <>
                        {i() > 0 ? "; " : ""}
                        <NodeLink id={p.from} /> → <NodeLink id={p.to} />{" "}
                        <button onClick={() => props.reveal({ kind: "edge", ids: p.edges.map((e) => e.id) })} {...stylex.attrs(s.textButton, s.muted)}>
                          ({countLine(p.edges)})
                        </button>
                      </>
                    )}
                  </For>
                  .
                </Show>
              </p>
            );
          }}
        </For>
      </Match>
    </Switch>
  );
}

function Overview(props: { m: Model; reveal: (x: Sel) => void }) {
  const m = props.m;
  const a = m.a;
  const groups = m.ranked();
  const pick = (it: RankItem): Sel => (it.kind === "edge" ? { kind: "edge", ids: [it.id] } : it.kind === "node" ? { kind: "node", id: it.id } : { kind: "boundary", id: it.id });
  return (
    <div>
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
      <div {...stylex.attrs(s.ovBar)}>
        <button {...stylex.attrs(s.ovButton)} onClick={() => setOv(-1)}>← prev</button>
        <span>
          overview <b>{ov().key}</b> of {OV.length} — {ov().name}
        </span>
        <button {...stylex.attrs(s.ovButton)} onClick={() => setOv(1)}>next →</button>
      </div>
      <For each={groups}>
        {(g, gi) => (
          <Show when={g.items.length > 0}>
           <Show when={gi() > 0 || ov().key === "A"} fallback={<Crossings m={m} reveal={props.reveal} />}>
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
      <For each={sq().chapters === "none" ? [{ title: "", steps: sc.steps.map((_, i) => i) }] : chaptersOf(sc)}>
        {(c, k) => (
          <>
            <Show when={c.title}>
              <p {...stylex.attrs(s.p, s.ovHead)}>
                {k() + 1}. {c.title}
              </p>
            </Show>
            <ol start={c.steps[0]! + 1}>
              <For each={c.steps}>
                {(i) => {
                  const x = sc.steps[i]!;
                  return (
                    <li>
                      <button onClick={() => go(i)} {...stylex.attrs(s.textButton, i === props.i && text.modified)}>
                        {SIGN[x.change]} {m.name(x.from)} → {m.name(x.to)}: {x.action}
                      </button>
                    </li>
                  );
                }}
              </For>
            </ol>
          </>
        )}
      </For>
    </div>
  );
}

void start();
