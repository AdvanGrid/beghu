// PROTOTYPE (PR view, #158): the graph's two explorers, Path and Clusters, on a phone. Three
// phone variants on the same page, switched with ?phone=1|2|3 and the bar at the bottom. A window
// narrower than 720 px gets variant 1 unless ?phone= says otherwise; ?phone=0 keeps the desktop
// page. ?x=path|clusters picks the explorer.
//
//   1 Screens: one thing per screen, like a phone's settings app. No drawing at all. Path is one
//     column per screen; Clusters is blocks, then a block's parts. A line is a row you tap.
//     Details are a pushed page. Pickers and the key are a "View" page.
//   2 Drawing and sheet: the drawing stays, like a maps app. Pinch and drag the canvas; tap
//     selects and a bottom sheet peeks; press and hold shows the hover card while held; a tap
//     among several lines asks which one. Path pages sideways, one column at a time with the
//     previous one peeking. Key and pickers are chips that open the sheet.
//   3 Map and list: the two explorers merge. The top of the screen is a small Clusters map, the
//     bottom is Path's list for whatever is picked. The map pinches and drags like 2's drawing;
//     tap a part on it to pick it, a block to open it. Lines are never touched on the drawing:
//     they are rows in the list, lit on the map. The key is a strip under the map.
import type { JSX } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
  untrack,
} from "solid-js";
import * as stylex from "@stylexjs/stylex";
import { colors, fonts } from "../src/tokens.stylex.ts";
import { pal } from "./tokens.stylex.ts";
import { arrow, layout, NODE_H, NODE_W, type Laid } from "./layout.ts";
import type { Lens, Model, VisEdge, VisNode } from "./model.ts";
import type { Change, Facet } from "./schema.ts";

type View = ReturnType<Model["view"]>;
type Scope = "all" | "near" | "changed";
export type PhoneSel =
  | { kind: "node"; id: string }
  | { kind: "edge"; ids: string[] }
  | { kind: string; [k: string]: unknown }
  | null;

/** What the desktop page lends the phone shell: its state, its panel and its hover cards. */
export interface PhoneCtx {
  m: Model;
  view: () => View;
  focus: () => string | null;
  setFocus: (id: string | null) => void;
  home: () => string | null;
  lens: () => Lens;
  setLens: (l: Lens) => void;
  lenses: { id: Lens; label: string }[];
  scope: () => Scope;
  setScope: (x: Scope) => void;
  colorBy: () => string;
  setColorBy: (x: string) => void;
  nodeFacets: Facet[];
  sel: () => PhoneSel;
  setSel: (x: PhoneSel) => void;
  /** The desktop panel: overview, or the selected thing's questions, claims and lines. */
  panel: () => JSX.Element;
  nodeCard: (id: string) => JSX.Element;
  edgeCard: (ids: string[]) => JSX.Element;
  groupOf: (id: string) => string | undefined;
}

const VARIANTS = [
  { key: "1", name: "Screens: one thing per screen, no drawing" },
  { key: "2", name: "Drawing and sheet: pinch, tap, hold" },
  { key: "3", name: "Map and list: Clusters above, Path below" },
] as const;
type Explorer = "path" | "clusters";

const params = new URLSearchParams(location.search);
/** Whether the phone shell is in charge: ?phone=1..3, or a narrow window with no ?phone=0. */
export function phoneWanted(): boolean {
  const p = params.get("phone");
  if (p === "0") return false;
  return !!p || window.innerWidth < 720;
}
const [variant, setVariantRaw] = createSignal(
  VARIANTS.find((x) => x.key === params.get("phone")) ?? VARIANTS[0],
);
const [explorer, setExplorerRaw] = createSignal<Explorer>(
  params.get("x") === "clusters" ? "clusters" : "path",
);
function put(k: string, v: string | null) {
  const p = new URLSearchParams(location.search);
  if (v === null) p.delete(k);
  else p.set(k, v);
  history.replaceState(null, "", `?${p}`);
}
const setVariant = (step: number) => {
  const i =
    (VARIANTS.indexOf(variant()) + step + VARIANTS.length) % VARIANTS.length;
  setVariantRaw(VARIANTS[i]!);
  put("phone", VARIANTS[i]!.key);
};
const setExplorer = (x: Explorer) => (
  setExplorerRaw(x),
  put("x", x === "path" ? null : x)
);

// ---------------------------------------------------------------------------------------------
// Shared helpers (copied from explore.tsx: this is a prototype).

const MARK: Record<Change | "mixed", string> = {
  added: "+ added",
  removed: "− removed",
  modified: "~ changed",
  unchanged: "unchanged",
  mixed: "~ mixed",
};
const SIGN: Record<Change | "mixed", string> = {
  added: "+ ",
  removed: "− ",
  modified: "~ ",
  unchanged: "",
  mixed: "~ ",
};
function changeOf(v: VisNode | undefined): Change {
  if (!v) return "unchanged";
  if (v.node.change !== "unchanged") return v.node.change;
  return v.touched ? "modified" : "unchanged";
}
function headline(m: Model, v: VisNode | undefined, id: string): string {
  const kind = m.kindLabel(id);
  return v && m.showsChange(id) ? `${kind} · ${MARK[changeOf(v)]}` : kind;
}
function bundleText(e: VisEdge): string {
  if (e.edges.length > 1) {
    const changed = e.edges.filter((x) => x.change !== "unchanged").length;
    return `${e.edges.length} connections${changed ? `, ${changed} new or changed` : ""}`;
  }
  return `${SIGN[e.edges[0]!.change]}${e.edges[0]!.label}`;
}
function neighbours(view: View, id: string) {
  const out: { other: string; e: VisEdge; dir: "out" | "in" | "both" }[] = [];
  for (const e of view.edges) {
    if (e.from !== id && e.to !== id) continue;
    out.push({
      other: e.from === id ? e.to : e.from,
      e,
      dir: e.both ? "both" : e.from === id ? "out" : "in",
    });
  }
  return out;
}
/** Path's first column: everything, in four groups. */
function firstColumn(m: Model, view: View): { title: string; ids: string[] }[] {
  const all = view.nodes;
  const byName = (a: VisNode, b: VisNode) =>
    m.name(a.node.id).localeCompare(m.name(b.node.id));
  return [
    [
      "Changed by this PR",
      all.filter((v) => v.touched && v.node.kind !== "actor"),
    ],
    ["People and callers", all.filter((v) => v.node.kind === "actor")],
    [
      "Not changed",
      all.filter(
        (v) => !v.touched && !m.isUsed(v.node.id) && v.node.kind !== "actor",
      ),
    ],
    [
      "Outside systems and stores",
      all.filter((v) => !v.touched && m.isUsed(v.node.id)),
    ],
  ]
    .filter(([, items]) => (items as VisNode[]).length)
    .map(([title, items]) => ({
      title: title as string,
      ids: [...(items as VisNode[])].sort(byName).map((v) => v.node.id),
    }));
}
/** A part's lines, split by direction, changed parts first. */
function linesOf(m: Model, view: View, id: string) {
  const vs = new Map(view.nodes.map((v) => [v.node.id, v]));
  const sort = (a: { other: string }, b: { other: string }) =>
    (vs.get(a.other)?.touched ? 0 : 1) - (vs.get(b.other)?.touched ? 0 : 1) ||
    m.name(a.other).localeCompare(m.name(b.other));
  const ns = neighbours(view, id);
  return {
    out: ns.filter((n) => n.dir !== "in").sort(sort),
    inn: ns.filter((n) => n.dir === "in").sort(sort),
  };
}
const edgeIds = (es: VisEdge[]) => es.flatMap((e) => e.edges.map((x) => x.id));
const lineChange = (es: VisEdge[]): Change =>
  es.some((e) => e.change !== "unchanged")
    ? es.every((e) => e.change === "added")
      ? "added"
      : "modified"
    : "unchanged";

/** Clusters' blocks: every part folded into one of a few blocks, or shown itself when its block is open. */
const CL = "cl:";
function clusters(c: PhoneCtx, view: View, open: Set<string>) {
  const m = c.m;
  const vs = new Map(view.nodes.map((v) => [v.node.id, v]));
  const keyOf = (v: VisNode) =>
    v.node.kind === "actor"
      ? "People and callers"
      : m.isUsed(v.node.id) && !v.touched
        ? (c.groupOf(v.node.id) ?? "Outside systems")
        : v.touched
          ? "Changed by this PR"
          : "Not changed";
  const members = new Map<string, string[]>();
  const rep = new Map<string, string>();
  const blockOf = new Map<string, string>();
  for (const v of vs.values()) {
    const k = keyOf(v);
    blockOf.set(v.node.id, k);
    members.set(k, [...(members.get(k) ?? []), v.node.id]);
    rep.set(v.node.id, open.has(k) ? v.node.id : `${CL}${k}`);
  }
  for (const [k, ids] of members)
    members.set(
      k,
      ids.sort(
        (a, b) =>
          (vs.get(a)?.touched ? 0 : 1) - (vs.get(b)?.touched ? 0 : 1) ||
          m.name(a).localeCompare(m.name(b)),
      ),
    );
  const links = new Map<
    string,
    { key: string; from: string; to: string; edges: VisEdge[] }
  >();
  for (const e of view.edges) {
    const a = rep.get(e.from),
      b = rep.get(e.to);
    if (!a || !b || a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const l = links.get(key) ?? { key, from: a, to: b, edges: [] };
    l.edges.push(e);
    links.set(key, l);
  }
  const ids = [...new Set(rep.values())];
  const groups = new Map<string, string>();
  for (const [id, r] of rep) if (r === id) groups.set(id, blockOf.get(id)!);
  const keys = [...members.keys()].sort((a, b) =>
    a === "Changed by this PR"
      ? -1
      : b === "Changed by this PR"
        ? 1
        : a.localeCompare(b),
  );
  return {
    ids,
    links: [...links.values()],
    members,
    groups,
    rep,
    blockOf,
    keys,
    vs,
  };
}
type Clustered = ReturnType<typeof clusters>;
/** Lines between whole blocks, for lists: block → (other block → edges). */
function blockLines(cl: Clustered, view: View, k: string) {
  const out = new Map<string, VisEdge[]>();
  for (const e of view.edges) {
    const a = cl.blockOf.get(e.from),
      b = cl.blockOf.get(e.to);
    if (!a || !b || a === b || (a !== k && b !== k)) continue;
    const other = a === k ? b : a;
    out.set(other, [...(out.get(other) ?? []), e]);
  }
  return [...out.entries()].sort(
    (x, y) => edgeIds(y[1]).length - edgeIds(x[1]).length,
  );
}

/** Press and hold: fires after 450 ms without moving; the click that ends it is swallowed. */
function holdable(onHold: () => void, onRelease?: () => void) {
  let timer = 0;
  let at = { x: 0, y: 0 };
  let held = false;
  return {
    onPointerDown: (e: PointerEvent) => {
      held = false;
      at = { x: e.clientX, y: e.clientY };
      timer = window.setTimeout(() => ((held = true), onHold()), 450);
    },
    onPointerMove: (e: PointerEvent) => {
      if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 8)
        clearTimeout(timer);
    },
    onPointerUp: () => (clearTimeout(timer), held && onRelease?.()),
    onPointerCancel: () => (clearTimeout(timer), held && onRelease?.()),
    onContextMenu: (e: Event) => e.preventDefault(),
    onClickCapture: (e: MouseEvent) =>
      held && (e.stopPropagation(), e.preventDefault(), (held = false)),
  };
}

// ---------------------------------------------------------------------------------------------
// Styles.

const slideIn = stylex.keyframes({
  from: { opacity: 0.4, translate: "40px 0" },
  to: { opacity: 1, translate: "0 0" },
});
const fadeIn = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const s = stylex.create({
  app: {
    backgroundColor: colors.bg,
    color: colors.fg,
    display: "flex",
    flexDirection: "column",
    fontFamily: fonts.ui,
    fontSize: 15,
    height: "100dvh",
    inset: 0,
    overflow: "hidden",
    position: "fixed",
    WebkitTapHighlightColor: "transparent",
  },
  top: {
    alignItems: "center",
    backgroundColor: colors.bgRaised,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    display: "flex",
    flexShrink: 0,
    gap: 6,
    minHeight: 48,
    paddingInline: 6,
  },
  topTitle: {
    flexGrow: 1,
    fontSize: 15,
    fontWeight: 600,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  topSub: {
    color: colors.muted,
    display: "block",
    fontSize: 11,
    fontWeight: 400,
  },
  iconBtn: {
    backgroundColor: "transparent",
    borderStyle: "none",
    color: colors.accent,
    flexShrink: 0,
    fontFamily: fonts.ui,
    fontSize: 15,
    minHeight: 44,
    minWidth: 44,
    paddingInline: 8,
  },
  seg: {
    backgroundColor: colors.hover,
    borderRadius: 9,
    display: "flex",
    flexShrink: 0,
    padding: 2,
  },
  segBtn: {
    backgroundColor: "transparent",
    borderRadius: 7,
    borderStyle: "none",
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 13,
    minHeight: 32,
    paddingInline: 10,
  },
  segOn: {
    backgroundColor: colors.bg,
    boxShadow: `0 1px 3px ${colors.popShadow}`,
    fontWeight: 600,
  },
  body: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
    position: "relative",
  },
  screen: {
    animationDuration: "220ms",
    animationFillMode: "both",
    animationName: slideIn,
    paddingBottom: 96,
  },
  crumbs: {
    display: "flex",
    gap: 6,
    overflowX: "auto",
    paddingBlock: 8,
    paddingInline: 10,
    scrollbarWidth: "none",
    whiteSpace: "nowrap",
  },
  crumb: {
    backgroundColor: colors.hover,
    borderRadius: 999,
    borderStyle: "none",
    color: colors.fg,
    flexShrink: 0,
    fontFamily: fonts.ui,
    fontSize: 13,
    minHeight: 32,
    paddingInline: 12,
  },
  crumbOn: {
    backgroundColor: colors.selected,
    color: colors.accent,
    fontWeight: 600,
  },
  section: {
    backgroundColor: colors.bg,
    color: colors.muted,
    fontSize: 12,
    fontWeight: 650,
    letterSpacing: "0.04em",
    paddingBottom: 6,
    paddingInline: 14,
    paddingTop: 18,
    position: "sticky",
    textTransform: "uppercase",
    top: 0,
    zIndex: 1,
  },
  row: {
    alignItems: "stretch",
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    display: "flex",
    minHeight: 56,
  },
  rowBar: { flexShrink: 0, width: 5 },
  rowMain: {
    backgroundColor: { default: "transparent", ":active": colors.hover },
    borderStyle: "none",
    color: colors.fg,
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    fontFamily: fonts.ui,
    gap: 2,
    justifyContent: "center",
    minWidth: 0,
    paddingBlock: 8,
    paddingInline: 12,
    textAlign: "start",
  },
  rowOn: { backgroundColor: colors.selected },
  rowKind: { color: colors.muted, fontSize: 12 },
  rowName: {
    fontSize: 15,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rowEnd: {
    alignItems: "center",
    color: colors.muted,
    display: "flex",
    flexShrink: 0,
    fontSize: 13,
    gap: 4,
    paddingInline: 12,
  },
  via: {
    alignSelf: "flex-start",
    backgroundColor: { default: colors.hover, ":active": colors.selected },
    borderRadius: 6,
    borderStyle: "none",
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 13,
    marginTop: 2,
    maxWidth: "100%",
    minHeight: 30,
    overflow: "hidden",
    paddingInline: 8,
    textAlign: "start",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  head: {
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    paddingBlock: 12,
    paddingInline: 14,
  },
  headName: { fontSize: 20, fontWeight: 700, marginBlock: 2 },
  actions: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 },
  actionsPad: { marginTop: 4, paddingInline: 14 },
  btn: {
    backgroundColor: { default: colors.bg, ":active": colors.hover },
    borderColor: colors.line,
    borderRadius: 10,
    borderStyle: "solid",
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 14,
    minHeight: 40,
    paddingInline: 14,
  },
  btnMain: {
    backgroundColor: colors.accentBg,
    borderColor: colors.accentBg,
    color: colors.accentFg,
  },
  tile: {
    backgroundColor: { default: colors.bgRaised, ":active": colors.hover },
    borderColor: colors.line,
    borderRadius: 12,
    borderStyle: "solid",
    borderWidth: 1,
    color: colors.fg,
    display: "block",
    fontFamily: fonts.ui,
    marginBlock: 10,
    marginInline: 12,
    paddingBlock: 14,
    paddingInline: 14,
    textAlign: "start",
    width: "calc(100% - 24px)",
  },
  tileName: { fontSize: 17, fontWeight: 700 },
  tileLines: { color: colors.muted, fontSize: 13, marginTop: 6 },
  panelWrap: { fontSize: 14, paddingBottom: 96, paddingInline: 14 },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    paddingBlock: 10,
    paddingInline: 14,
  },
  fieldLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: 650,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  select: {
    backgroundColor: colors.bg,
    borderColor: colors.line,
    borderRadius: 10,
    borderStyle: "solid",
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 16,
    minHeight: 44,
    paddingInline: 10,
  },
  note: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 1.45,
    paddingBlock: 10,
    paddingInline: 14,
  },
  keyRow: {
    alignItems: "center",
    display: "flex",
    gap: 10,
    minHeight: 36,
    paddingInline: 14,
  },
  keySample: { flexShrink: 0, width: 40 },
  switcher: {
    alignItems: "center",
    backgroundColor: colors.fg,
    borderRadius: 999,
    bottom: "calc(10px + env(safe-area-inset-bottom))",
    boxShadow: `0 4px 16px ${colors.popShadow}`,
    color: colors.bg,
    display: "flex",
    fontSize: 12,
    gap: 4,
    left: "50%",
    maxWidth: "calc(100vw - 16px)",
    paddingBlock: 2,
    paddingInline: 4,
    position: "fixed",
    transform: "translateX(-50%)",
    whiteSpace: "nowrap",
    zIndex: 50,
  },
  switcherLabel: { overflow: "hidden", textOverflow: "ellipsis" },
  switcherBtn: {
    backgroundColor: "transparent",
    borderStyle: "none",
    color: colors.bg,
    fontSize: 16,
    minHeight: 36,
    minWidth: 36,
  },
  // The drawing.
  canvas: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    overflow: "hidden",
    position: "relative",
    touchAction: "none",
  },
  stage: {
    left: 0,
    position: "absolute",
    top: 0,
    transform: "translate(var(--tx), var(--ty)) scale(var(--s))",
    transformOrigin: "0 0",
  },
  node: { fill: pal.nodeBg, strokeWidth: 1.5 },
  nodeSel: { stroke: colors.accent, strokeWidth: 4 },
  stack: { fill: pal.nodeBg, stroke: colors.line, strokeWidth: 1.2 },
  box: { fill: colors.bgRaised, stroke: colors.line, strokeWidth: 1.5 },
  svgTitle: {
    fill: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 15,
    fontWeight: 700,
  },
  svgText: {
    fill: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 14,
    fontWeight: 600,
  },
  svgSmall: { fill: colors.muted, fontFamily: fonts.ui, fontSize: 12 },
  line: { fill: "none" },
  lineOn: { stroke: colors.accent },
  faded: { opacity: 0.12 },
  chip: {
    backgroundColor: colors.pop,
    borderColor: colors.line,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: `0 2px 8px ${colors.popShadow}`,
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 13,
    minHeight: 36,
    paddingInline: 14,
    position: "absolute",
    zIndex: 5,
  },
  chipTL: { left: 10, top: 10 },
  chipTR: { right: 10, top: 10 },
  chipTR2: { right: 10, top: 52 },
  sheet: {
    backgroundColor: colors.pop,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    bottom: 0,
    boxShadow: `0 -4px 20px ${colors.popShadow}`,
    display: "flex",
    flexDirection: "column",
    height: "var(--sheet-h)",
    left: 0,
    position: "absolute",
    right: 0,
    transitionDuration: "220ms",
    transitionProperty: "height",
    zIndex: 20,
  },
  sheetDragging: { transitionDuration: "0ms" },
  grip: { flexShrink: 0, paddingBottom: 4, paddingTop: 8, touchAction: "none" },
  gripBar: {
    backgroundColor: colors.line,
    borderRadius: 3,
    height: 5,
    marginInline: "auto",
    width: 40,
  },
  sheetHead: {
    alignItems: "center",
    display: "flex",
    gap: 8,
    paddingBottom: 8,
    paddingInline: 14,
    touchAction: "none",
  },
  sheetBody: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  peek: {
    animationDuration: "120ms",
    animationName: fadeIn,
    backgroundColor: colors.pop,
    borderColor: colors.line,
    borderRadius: 12,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: `0 6px 24px ${colors.popShadow}`,
    fontSize: 13,
    left: 12,
    maxHeight: "45dvh",
    overflow: "hidden",
    paddingBlock: 10,
    paddingInline: 12,
    pointerEvents: "none",
    position: "fixed",
    right: 12,
    top: "var(--peek-y)",
    zIndex: 40,
  },
  pager: {
    display: "flex",
    flexGrow: 1,
    gap: 0,
    minHeight: 0,
    overflowX: "auto",
    overflowY: "hidden",
    scrollSnapType: "x mandatory",
    scrollbarWidth: "none",
  },
  page: {
    borderRightColor: colors.line,
    borderRightStyle: "solid",
    borderRightWidth: 1,
    flexShrink: 0,
    overflowY: "auto",
    paddingBottom: 140,
    paddingTop: 48,
    scrollSnapAlign: "end",
    width: "calc(100vw - 52px)",
  },
  pageFirst: { scrollSnapAlign: "start" },
  pageHead: {
    fontSize: 13,
    fontWeight: 650,
    paddingBlock: 10,
    paddingInline: 14,
  },
  map: {
    touchAction: "none",
    backgroundColor: colors.bgRaised,
    flexShrink: 0,
    height: "38dvh",
    overflow: "hidden",
    position: "relative",
  },
  mapBig: { height: "70dvh" },
  mapSvg: { display: "block", height: "100%", width: "100%" },
  strip: {
    alignItems: "center",
    backgroundColor: colors.bg,
    borderBlockColor: colors.line,
    borderBlockStyle: "solid",
    borderBlockWidth: 1,
    borderStyle: "none",
    color: colors.fg,
    display: "flex",
    flexShrink: 0,
    fontFamily: fonts.ui,
    fontSize: 12,
    gap: 10,
    minHeight: 34,
    overflowX: "auto",
    paddingInline: 10,
    textAlign: "start",
    whiteSpace: "nowrap",
    width: "100%",
  },
  dot: {
    borderRadius: 3,
    display: "inline-block",
    height: 10,
    marginInlineEnd: 4,
    verticalAlign: "-1px",
    width: 10,
  },
  muted: { color: colors.muted },
  gap: { flexShrink: 0, width: 8 },
});
const bar = stylex.create({
  added: { backgroundColor: pal.added },
  removed: { backgroundColor: pal.removed },
  modified: { backgroundColor: pal.modified },
  unchanged: { backgroundColor: pal.unchanged },
  mixed: { backgroundColor: pal.modified },
});
const strokeC = stylex.create({
  added: { stroke: pal.added },
  removed: { stroke: pal.removed },
  modified: { stroke: pal.modified },
  unchanged: { stroke: pal.unchanged },
  mixed: { stroke: pal.modified },
});
const fillC = stylex.create({
  added: { fill: pal.added },
  removed: { fill: pal.removed },
  modified: { fill: pal.modified },
  unchanged: { fill: pal.unchanged },
  mixed: { fill: pal.modified },
});
const textC = stylex.create({
  added: { color: pal.added },
  removed: { color: pal.removed },
  modified: { color: pal.modified },
  unchanged: { color: colors.muted },
  mixed: { color: pal.modified },
});

function barOf(c: Change | "mixed") {
  return bar[c];
}
function textOf(c: Change | "mixed") {
  return textC[c];
}
function strokeOf(c: Change | "mixed") {
  return strokeC[c];
}
function fillOf(c: Change | "mixed") {
  return fillC[c];
}

// ---------------------------------------------------------------------------------------------
// The shell: whichever variant, plus the switcher.

export function Phone(props: { c: PhoneCtx }) {
  return (
    <>
      <Show when={props.c.lens() === "order"}>
        <div {...stylex.attrs(s.app)}>
          <Top c={props.c} title="Order of actions" />
          <p {...stylex.attrs(s.note)}>
            Not part of this prototype: on a phone the order of actions runs
            time across, parts stacked down a pinned first column (view F on
            branch t3/pr-view-scenarios).
          </p>
          <div {...stylex.attrs(s.field)}>
            <Lenses c={props.c} />
          </div>
        </div>
      </Show>
      <Show when={props.c.lens() !== "order"}>
        <Show when={variant().key === "1"}>
          <Screens c={props.c} />
        </Show>
        <Show when={variant().key === "2"}>
          <DrawingAndSheet c={props.c} />
        </Show>
        <Show when={variant().key === "3"}>
          <MapAndList c={props.c} />
        </Show>
      </Show>
      <div {...stylex.attrs(s.switcher)}>
        <button {...stylex.attrs(s.switcherBtn)} onClick={() => setVariant(-1)}>
          ←
        </button>
        <span {...stylex.attrs(s.switcherLabel)}>
          Phone <b>{variant().key}</b> — {variant().name}
        </span>
        <button {...stylex.attrs(s.switcherBtn)} onClick={() => setVariant(1)}>
          →
        </button>
      </div>
    </>
  );
}

function Top(props: {
  c: PhoneCtx;
  title: string;
  sub?: string;
  back?: () => void;
  end?: JSX.Element;
}) {
  return (
    <div {...stylex.attrs(s.top)}>
      <Show when={props.back} fallback={<span {...stylex.attrs(s.gap)} />}>
        <button
          {...stylex.attrs(s.iconBtn)}
          onClick={() => props.back?.()}
          aria-label="Back"
        >
          ‹ Back
        </button>
      </Show>
      <span {...stylex.attrs(s.topTitle)}>
        {props.title}
        <span {...stylex.attrs(s.topSub)}>
          {props.sub ?? `#${props.c.m.a.pr.number} ${props.c.m.a.pr.title}`}
        </span>
      </span>
      {props.end}
    </div>
  );
}

function ExplorerSwitch() {
  return (
    <div {...stylex.attrs(s.seg)}>
      <button
        {...stylex.attrs(s.segBtn, explorer() === "path" && s.segOn)}
        onClick={() => setExplorer("path")}
      >
        Path
      </button>
      <button
        {...stylex.attrs(s.segBtn, explorer() === "clusters" && s.segOn)}
        onClick={() => setExplorer("clusters")}
      >
        Clusters
      </button>
    </div>
  );
}

/** A part as a row: a change bar, its kind, its name, the line that led here (its own target), its line count. */
function PartRow(props: {
  c: PhoneCtx;
  id: string;
  via?: { text: string; change: Change | "mixed"; onTap: () => void };
  on?: boolean;
  end?: string;
  onTap: () => void;
  hold?: ReturnType<typeof holdable>;
}) {
  const v = () => props.c.view().nodes.find((x) => x.node.id === props.id);
  const ch = () => changeOf(v());
  return (
    <div {...stylex.attrs(s.row, props.on && s.rowOn)}>
      <span {...stylex.attrs(s.rowBar, barOf(ch()))} />
      <div
        {...stylex.attrs(s.rowMain)}
        role="button"
        onClick={() => props.onTap()}
        {...(props.hold ?? {})}
      >
        <span {...stylex.attrs(s.rowKind, textOf(ch()))}>
          {headline(props.c.m, v(), props.id)}
        </span>
        <span {...stylex.attrs(s.rowName)}>{props.c.m.name(props.id)}</span>
        <Show when={props.via}>
          {(vv) => (
            <button
              {...stylex.attrs(s.via, textOf(vv().change))}
              onClick={(e) => (e.stopPropagation(), vv().onTap())}
            >
              {vv().text} ⓘ
            </button>
          )}
        </Show>
      </div>
      <span {...stylex.attrs(s.rowEnd)}>
        {props.end ?? `${neighbours(props.c.view(), props.id).length} ›`}
      </span>
    </div>
  );
}

function Lenses(props: { c: PhoneCtx }) {
  return (
    <select
      value={props.c.lens()}
      onChange={(e) => props.c.setLens(e.currentTarget.value as Lens)}
      {...stylex.attrs(s.select)}
    >
      <For each={props.c.lenses}>
        {(l) => <option value={l.id}>{l.label}</option>}
      </For>
    </select>
  );
}

/** The pickers: lens, Show, Colour by. One list, wherever a variant puts it. */
function ViewControls(props: { c: PhoneCtx; explorerSwitch?: boolean }) {
  return (
    <>
      <Show when={props.explorerSwitch}>
        <label {...stylex.attrs(s.field)}>
          <span {...stylex.attrs(s.fieldLabel)}>Explore by</span>
          <ExplorerSwitch />
        </label>
      </Show>
      <label {...stylex.attrs(s.field)}>
        <span {...stylex.attrs(s.fieldLabel)}>Lens</span>
        <Lenses c={props.c} />
      </label>
      <label {...stylex.attrs(s.field)}>
        <span {...stylex.attrs(s.fieldLabel)}>Show</span>
        <select
          value={props.c.scope()}
          onChange={(e) => props.c.setScope(e.currentTarget.value as Scope)}
          {...stylex.attrs(s.select)}
        >
          <option value="all">The whole system</option>
          <option value="near">The change and what it connects to</option>
          <option value="changed">Changed parts only</option>
        </select>
      </label>
      <label {...stylex.attrs(s.field)}>
        <span {...stylex.attrs(s.fieldLabel)}>Colour by</span>
        <select
          value={props.c.colorBy()}
          onChange={(e) => props.c.setColorBy(e.currentTarget.value)}
          {...stylex.attrs(s.select)}
        >
          <option value="change">How the PR changed it</option>
          <For each={props.c.nodeFacets}>
            {(f) => <option value={f.id}>{f.name}</option>}
          </For>
        </select>
      </label>
    </>
  );
}

/** The key: what each colour, line and block means. Its content was settled in #155; only where it sits is in question here. */
function Key(props: { drawing?: boolean }) {
  const swatch = (c: Change) => (
    <svg width={40} height={18} {...stylex.attrs(s.keySample)}>
      <rect
        x={1}
        y={1}
        width={38}
        height={16}
        rx={4}
        {...stylex.attrs(s.node, strokeOf(c))}
      />
      <rect x={1} y={1} width={5} height={16} {...stylex.attrs(fillOf(c))} />
    </svg>
  );
  const ln = (c: Change, w = 2) => (
    <svg width={40} height={18} {...stylex.attrs(s.keySample)}>
      <path
        d="M2,9 H30"
        stroke-width={w}
        {...stylex.attrs(s.line, strokeOf(c))}
      />
      <path
        d={arrow({ x: 38, y: 9, dx: 1, dy: 0 })}
        {...stylex.attrs(fillOf(c))}
      />
    </svg>
  );
  return (
    <>
      <div {...stylex.attrs(s.section)}>Parts</div>
      <div {...stylex.attrs(s.keyRow)}>{swatch("added")} added by this PR</div>
      <div {...stylex.attrs(s.keyRow)}>
        {swatch("modified")} changed by this PR, or inside
      </div>
      <div {...stylex.attrs(s.keyRow)}>
        {swatch("removed")} removed by this PR
      </div>
      <div {...stylex.attrs(s.keyRow)}>{swatch("unchanged")} not changed</div>
      <div {...stylex.attrs(s.section)}>Lines</div>
      <div {...stylex.attrs(s.keyRow)}>{ln("added")} a new connection</div>
      <div {...stylex.attrs(s.keyRow)}>
        {ln("modified")} a changed connection
      </div>
      <div {...stylex.attrs(s.keyRow)}>{ln("unchanged")} not changed</div>
      <Show when={props.drawing}>
        <div {...stylex.attrs(s.keyRow)}>
          {ln("unchanged", 5)} thicker: more connections; the number counts them
        </div>
        <div {...stylex.attrs(s.section)}>Blocks</div>
        <div {...stylex.attrs(s.keyRow)}>
          <svg width={40} height={22} {...stylex.attrs(s.keySample)}>
            <rect
              x={7}
              y={1}
              width={30}
              height={14}
              rx={3}
              {...stylex.attrs(s.stack)}
            />
            <rect
              x={4}
              y={4}
              width={30}
              height={14}
              rx={3}
              {...stylex.attrs(s.stack)}
            />
            <rect
              x={1}
              y={7}
              width={30}
              height={14}
              rx={3}
              {...stylex.attrs(s.node, strokeOf("unchanged"))}
            />
          </svg>
          a folded block: tap to open it
        </div>
      </Show>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Variant 1: Screens. A stack of full screens, no drawing.

type Scr =
  | { kind: "root" }
  | { kind: "part"; id: string }
  | { kind: "block"; k: string }
  | { kind: "details"; title: string }
  | { kind: "view" };

function Screens(props: { c: PhoneCtx }) {
  const c = props.c;
  const m = c.m;
  const [stack, setStack] = createSignal<Scr[]>([{ kind: "root" }]);
  const top = () => stack()[stack().length - 1]!;
  const push = (x: Scr) => {
    setStack((st) => [...st, x]);
    body?.scrollTo(0, 0);
  };
  const pop = () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st));
  let body: HTMLDivElement | undefined;
  // A new explorer, lens or zoom starts again from the top.
  createEffect(
    () => [explorer(), c.lens(), c.focus(), c.scope()],
    () => {
      setStack([{ kind: "root" }]);
    },
  );
  const details = (sel: PhoneSel, title: string) => (
    c.setSel(sel),
    push({ kind: "details", title })
  );
  const cl = createMemo(() => clusters(c, c.view(), new Set()));
  /** Path's crumb trail: the parts on the stack, in order. */
  const trail = () =>
    stack().flatMap((x, i) => (x.kind === "part" ? [{ id: x.id, i }] : []));

  const title = () => {
    const t = top();
    if (t.kind === "part") return m.name(t.id);
    if (t.kind === "block") return t.k;
    if (t.kind === "details") return t.title;
    if (t.kind === "view") return "View";
    return c.focus() && c.focus() !== c.home()
      ? m.name(c.focus()!)
      : "Whole system";
  };
  return (
    <div {...stylex.attrs(s.app)}>
      <Top
        c={c}
        title={title()}
        back={
          stack().length > 1
            ? pop
            : c.focus() !== c.home()
              ? () => c.setFocus(c.m.nodes.get(c.focus()!)?.parent ?? null)
              : undefined
        }
        end={
          <Show when={top().kind !== "view"}>
            <button
              {...stylex.attrs(s.iconBtn)}
              onClick={() => push({ kind: "view" })}
            >
              View
            </button>
          </Show>
        }
      />
      <Show
        when={
          explorer() === "path" && trail().length > 1 && top().kind === "part"
        }
      >
        <div {...stylex.attrs(s.crumbs)}>
          <For each={trail()}>
            {(t) => (
              <button
                {...stylex.attrs(
                  s.crumb,
                  t.i === stack().length - 1 && s.crumbOn,
                )}
                onClick={() => setStack((st) => st.slice(0, t.i + 1))}
              >
                {m.name(t.id)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div ref={body} {...stylex.attrs(s.body)}>
        <Show when={top()} keyed>
          {(t) => (
            <div {...stylex.attrs(s.screen)}>
              <Show when={t.kind === "root" && explorer() === "path"}>
                <div {...stylex.attrs(s.head)}>
                  <ExplorerSwitch />
                </div>
                <For each={firstColumn(m, c.view())}>
                  {(g) => (
                    <>
                      <div {...stylex.attrs(s.section)}>
                        {g.title} ({g.ids.length})
                      </div>
                      <For each={g.ids}>
                        {(id) => (
                          <PartRow
                            c={c}
                            id={id}
                            onTap={() => push({ kind: "part", id })}
                          />
                        )}
                      </For>
                    </>
                  )}
                </For>
              </Show>
              <Show when={t.kind === "root" && explorer() === "clusters"}>
                <div {...stylex.attrs(s.head)}>
                  <ExplorerSwitch />
                </div>
                <For each={cl().keys}>
                  {(k) => {
                    const ms = () => cl().members.get(k) ?? [];
                    const changed = () =>
                      ms().filter((id) => cl().vs.get(id)?.touched).length;
                    return (
                      <button
                        {...stylex.attrs(s.tile)}
                        onClick={() => push({ kind: "block", k })}
                      >
                        <div
                          {...stylex.attrs(
                            s.rowKind,
                            textOf(changed() ? "modified" : "unchanged"),
                          )}
                        >
                          {ms().length} parts
                          {changed() ? ` · ${changed()} changed` : ""}
                        </div>
                        <div {...stylex.attrs(s.tileName)}>{k} ›</div>
                        <div {...stylex.attrs(s.tileLines)}>
                          <For each={blockLines(cl(), c.view(), k).slice(0, 3)}>
                            {([o, es]) => (
                              <div>
                                ↔ {o} · {edgeIds(es).length}
                              </div>
                            )}
                          </For>
                        </div>
                      </button>
                    );
                  }}
                </For>
              </Show>
              <Show when={t.kind === "block" ? t : undefined}>
                {(b) => (
                  <>
                    <div {...stylex.attrs(s.section)}>
                      Parts ({cl().members.get(b().k)?.length ?? 0})
                    </div>
                    <For each={cl().members.get(b().k) ?? []}>
                      {(id) => (
                        <PartRow
                          c={c}
                          id={id}
                          onTap={() => push({ kind: "part", id })}
                        />
                      )}
                    </For>
                    <div {...stylex.attrs(s.section)}>
                      Lines to other blocks
                    </div>
                    <For each={blockLines(cl(), c.view(), b().k)}>
                      {([o, es]) => (
                        <div {...stylex.attrs(s.row)}>
                          <span
                            {...stylex.attrs(s.rowBar, barOf(lineChange(es)))}
                          />
                          <button
                            {...stylex.attrs(s.rowMain)}
                            onClick={() =>
                              details(
                                { kind: "edge", ids: edgeIds(es) },
                                `${b().k} ↔ ${o}`,
                              )
                            }
                          >
                            <span {...stylex.attrs(s.rowKind)}>
                              {edgeIds(es).length} connections
                            </span>
                            <span {...stylex.attrs(s.rowName)}>↔ {o}</span>
                          </button>
                          <span {...stylex.attrs(s.rowEnd)}>ⓘ</span>
                        </div>
                      )}
                    </For>
                  </>
                )}
              </Show>
              <Show when={t.kind === "part" ? t : undefined}>
                {(p) => (
                  <PartScreen
                    c={c}
                    id={p().id}
                    follow={(id) => push({ kind: "part", id })}
                    details={details}
                  />
                )}
              </Show>
              <Show when={t.kind === "details"}>
                <div {...stylex.attrs(s.panelWrap)}>{c.panel()}</div>
              </Show>
              <Show when={t.kind === "view"}>
                <ViewControls c={c} explorerSwitch />
                <Key />
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

/** One part, full screen: what it is, then its lines out and in, each a row to follow. */
function PartScreen(props: {
  c: PhoneCtx;
  id: string;
  follow: (id: string) => void;
  details: (x: PhoneSel, title: string) => void;
}) {
  const c = props.c;
  const m = c.m;
  const v = () => c.view().nodes.find((x) => x.node.id === props.id);
  const ls = createMemo(() => linesOf(m, c.view(), props.id));
  const kids = () => (m.children.get(props.id) ?? []).length;
  return (
    <>
      <div {...stylex.attrs(s.head)}>
        <div {...stylex.attrs(s.rowKind, textOf(changeOf(v())))}>
          {headline(m, v(), props.id)}
        </div>
        <div {...stylex.attrs(s.headName)}>{m.name(props.id)}</div>
        <div {...stylex.attrs(s.actions)}>
          <button
            {...stylex.attrs(s.btn, s.btnMain)}
            onClick={() =>
              props.details({ kind: "node", id: props.id }, m.name(props.id))
            }
          >
            Details
          </button>
          <Show when={kids()}>
            <button
              {...stylex.attrs(s.btn)}
              onClick={() => c.setFocus(props.id)}
            >
              Open inside ({kids()} parts)
            </button>
          </Show>
        </div>
      </div>
      <Show when={ls().out.length}>
        <div {...stylex.attrs(s.section)}>
          Uses or sends to ({ls().out.length})
        </div>
        <For each={ls().out}>
          {(n) => (
            <PartRow
              c={c}
              id={n.other}
              via={{
                text: `${n.dir === "both" ? "↔" : "→"} ${bundleText(n.e)}`,
                change: n.e.change,
                onTap: () =>
                  props.details(
                    { kind: "edge", ids: edgeIds([n.e]) },
                    `${m.name(props.id)} → ${m.name(n.other)}`,
                  ),
              }}
              onTap={() => props.follow(n.other)}
            />
          )}
        </For>
      </Show>
      <Show when={ls().inn.length}>
        <div {...stylex.attrs(s.section)}>
          Uses it or sends to it ({ls().inn.length})
        </div>
        <For each={ls().inn}>
          {(n) => (
            <PartRow
              c={c}
              id={n.other}
              via={{
                text: `← ${bundleText(n.e)}`,
                change: n.e.change,
                onTap: () =>
                  props.details(
                    { kind: "edge", ids: edgeIds([n.e]) },
                    `${m.name(n.other)} → ${m.name(props.id)}`,
                  ),
              }}
              onTap={() => props.follow(n.other)}
            />
          )}
        </For>
      </Show>
      <Show when={!ls().out.length && !ls().inn.length}>
        <p {...stylex.attrs(s.note)}>No lines in this lens.</p>
      </Show>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Variant 2: Drawing and sheet.

type SheetMode = "details" | "key" | "view" | "choose";
const PEEK = 128;

function DrawingAndSheet(props: { c: PhoneCtx }) {
  const c = props.c;
  const m = c.m;
  const [mode, setMode] = createSignal<SheetMode>("details");
  /** The sheet's height in px; snaps to peek, half and nearly full. */
  const [h, setH] = createSignal(PEEK);
  const [dragging, setDragging] = createSignal(false);
  const [choices, setChoices] = createSignal<
    { key: string; label: string; ids: string[]; change: Change }[]
  >([]);
  const [peekCard, setPeekCard] = createSignal<{
    node?: string;
    ids?: string[];
    y: number;
  } | null>(null);
  let app: HTMLDivElement | undefined;
  const full = () => (app?.clientHeight ?? 700) - 56;
  const half = () => Math.round((app?.clientHeight ?? 700) * 0.5);
  const snap = (x: number) =>
    [PEEK, half(), full()].reduce((a, b) =>
      Math.abs(b - x) < Math.abs(a - x) ? b : a,
    );
  const openSheet = (md: SheetMode, height?: number) => (
    setMode(md),
    setH(Math.max(untrack(h), height ?? half()))
  );
  const select = (x: PhoneSel) => (
    c.setSel(x),
    setMode("details"),
    setH((v) => (v < PEEK ? PEEK : v))
  );

  // Drag the sheet by its grip or head; a tap on them toggles peek and half.
  let drag: { y: number; h: number; moved: boolean } | null = null;
  const grip = {
    onPointerDown: (e: PointerEvent) => {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      drag = { y: e.clientY, h: h(), moved: false };
      setDragging(true);
    },
    onPointerMove: (e: PointerEvent) => {
      if (!drag) return;
      if (Math.abs(e.clientY - drag.y) > 6) drag.moved = true;
      if (drag.moved)
        setH(Math.max(56, Math.min(full(), drag.h - (e.clientY - drag.y))));
    },
    onPointerUp: () => {
      if (!drag) return;
      setDragging(false);
      setH(drag.moved ? snap(h()) : h() <= PEEK + 4 ? half() : PEEK);
      drag = null;
    },
  };
  const selNode = () => {
    const x = c.sel();
    return x?.kind === "node" ? (x as { id: string }).id : null;
  };
  const selEdges = () => {
    const x = c.sel();
    return x?.kind === "edge" ? new Set((x as { ids: string[] }).ids) : null;
  };
  const sheetTitle = () => {
    if (mode() === "key") return "Key";
    if (mode() === "view") return "View";
    if (mode() === "choose")
      return `${choices().length} lines here: which one?`;
    const n = selNode();
    if (n) return m.name(n);
    const es = selEdges();
    if (es) return es.size === 1 ? "1 connection" : `${es.size} connections`;
    return "Overview";
  };
  const showPeek = (p: { node?: string; ids?: string[] }, y: number) =>
    setPeekCard({ ...p, y: y > window.innerHeight / 2 ? 60 : y + 40 });

  return (
    <div ref={app} {...stylex.attrs(s.app)}>
      <Top
        c={c}
        title={
          c.focus() && c.focus() !== c.home()
            ? m.name(c.focus()!)
            : "Whole system"
        }
        back={
          c.focus() !== c.home()
            ? () => c.setFocus(m.nodes.get(c.focus()!)?.parent ?? null)
            : undefined
        }
        end={<ExplorerSwitch />}
      />
      <div {...stylex.attrs(s.canvas)}>
        <Show when={explorer() === "clusters"}>
          <ClusterCanvas
            c={c}
            select={select}
            choose={(cs) => (setChoices(cs), openSheet("choose", half()))}
            peek={showPeek}
            unpeek={() => setPeekCard(null)}
            selNode={selNode()}
            selEdges={selEdges()}
          />
        </Show>
        <Show when={explorer() === "path"}>
          <PathPager
            c={c}
            select={select}
            peek={showPeek}
            unpeek={() => setPeekCard(null)}
          />
        </Show>
        <button
          {...stylex.attrs(s.chip, s.chipTL)}
          onClick={() => openSheet("key")}
        >
          Key
        </button>
        <button
          {...stylex.attrs(s.chip, s.chipTR)}
          onClick={() => openSheet("view")}
        >
          View ▾
        </button>
        <div
          style={{ "--sheet-h": `${h()}px` }}
          {...stylex.attrs(s.sheet, dragging() && s.sheetDragging)}
        >
          <div {...stylex.attrs(s.grip)} {...grip}>
            <div {...stylex.attrs(s.gripBar)} />
          </div>
          <div {...stylex.attrs(s.sheetHead)} {...grip}>
            <span {...stylex.attrs(s.topTitle)}>
              {sheetTitle()}
              <span {...stylex.attrs(s.topSub)}>
                {mode() === "details" && selNode()
                  ? headline(
                      m,
                      c.view().nodes.find((v) => v.node.id === selNode()),
                      selNode()!,
                    )
                  : mode() === "details" && !c.sel()
                    ? "Tap a part or a line. Hold one to peek."
                    : ""}
              </span>
            </span>
            <Show when={mode() !== "details" || c.sel()}>
              <button
                {...stylex.attrs(s.iconBtn)}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() =>
                  mode() !== "details"
                    ? setMode("details")
                    : (c.setSel(null), setH(PEEK))
                }
              >
                ✕
              </button>
            </Show>
          </div>
          <div {...stylex.attrs(s.sheetBody)}>
            <Show when={mode() === "details"}>
              <Show
                when={selNode() && (m.children.get(selNode()!) ?? []).length}
              >
                <div {...stylex.attrs(s.actions, s.actionsPad)}>
                  <button
                    {...stylex.attrs(s.btn)}
                    onClick={() => (c.setFocus(selNode()), setH(PEEK))}
                  >
                    Open inside ({(m.children.get(selNode()!) ?? []).length}{" "}
                    parts)
                  </button>
                </div>
              </Show>
              <Show when={selEdges()}>
                {(es) => {
                  const far = () => {
                    const e = m.edges.get([...es()][0]!);
                    return e ? e.to : null;
                  };
                  return (
                    <div {...stylex.attrs(s.actions, s.actionsPad)}>
                      <Show when={far()}>
                        <button
                          {...stylex.attrs(s.btn)}
                          onClick={() => select({ kind: "node", id: far()! })}
                        >
                          Go to the far end: {m.name(far()!)}
                        </button>
                      </Show>
                    </div>
                  );
                }}
              </Show>
              <div {...stylex.attrs(s.panelWrap)}>{c.panel()}</div>
            </Show>
            <Show when={mode() === "key"}>
              <Key drawing={explorer() === "clusters"} />
            </Show>
            <Show when={mode() === "view"}>
              <ViewControls c={c} />
            </Show>
            <Show when={mode() === "choose"}>
              <For each={choices()}>
                {(ch) => (
                  <div {...stylex.attrs(s.row)}>
                    <span {...stylex.attrs(s.rowBar, barOf(ch.change))} />
                    <button
                      {...stylex.attrs(s.rowMain)}
                      onClick={() => select({ kind: "edge", ids: ch.ids })}
                    >
                      <span {...stylex.attrs(s.rowKind)}>
                        {ch.ids.length === 1
                          ? "1 connection"
                          : `${ch.ids.length} connections`}
                      </span>
                      <span {...stylex.attrs(s.rowName)}>{ch.label}</span>
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
      <Show when={peekCard()}>
        {(p) => (
          <div style={{ "--peek-y": `${p().y}px` }} {...stylex.attrs(s.peek)}>
            {p().node ? c.nodeCard(p().node!) : c.edgeCard(p().ids!)}
            <DrawnAsText c={c} node={p().node} ids={p().ids} />
          </div>
        )}
      </Show>
    </div>
  );
}

/** "Drawn as" in words, for the peek card: the reader can't hover the key on a phone. */
function DrawnAsText(props: { c: PhoneCtx; node?: string; ids?: string[] }) {
  const text = () => {
    if (props.node) {
      const v = props.c.view().nodes.find((x) => x.node.id === props.node);
      const ch = changeOf(v);
      return `a part with a ${ch === "unchanged" ? "grey" : ch === "added" ? "green" : ch === "removed" ? "red" : "amber"} edge: ${ch === "unchanged" ? "not changed" : MARK[ch]}`;
    }
    const es = (props.ids ?? [])
      .map((id) => props.c.m.edges.get(id)!)
      .filter(Boolean);
    const ch = es.some((e) => e.change !== "unchanged")
      ? "new or changed"
      : "not changed";
    return `a line${es.length > 1 ? `, thicker for ${es.length} connections` : ""}: ${ch}`;
  };
  return (
    <div {...stylex.attrs(s.rowKind)}>
      <b>Drawn as</b> {text()}
    </div>
  );
}

/** Clusters as a drawing you pinch, drag and tap. */
function ClusterCanvas(props: {
  c: PhoneCtx;
  select: (x: PhoneSel) => void;
  choose: (
    cs: { key: string; label: string; ids: string[]; change: Change }[],
  ) => void;
  peek: (p: { node?: string; ids?: string[] }, y: number) => void;
  unpeek: () => void;
  selNode: string | null;
  selEdges: Set<string> | null;
}) {
  const c = props.c;
  const m = c.m;
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const cl = createMemo(() => clusters(c, c.view(), open()));
  const [laid, setLaid] = createSignal<Laid | null>(null);
  const [t, setT] = createSignal({ x: 0, y: 0, s: 1 });
  let host: HTMLDivElement | undefined;
  let svg: SVGSVGElement | undefined;
  let first = true;
  let ticket = 0;
  createEffect(
    () => cl(),
    (x) => {
      const mine = ++ticket;
      const count = (l: { edges: VisEdge[] }) => edgeIds(l.edges).length;
      void layout(
        x.ids,
        x.links.map((l) => ({
          key: l.key,
          from: l.from,
          to: l.to,
          label: `${count(l)}`,
        })),
        undefined,
        x.groups,
      ).then((at) => {
        if (mine !== ticket) return;
        setLaid(at);
        if (first) {
          first = false;
          const w = host?.clientWidth ?? 390;
          const sc = Math.min(1, (w - 16) / at.width);
          setT({ x: 8, y: 56, s: sc });
        }
      });
    },
  );
  const toggle = (k: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (!n.delete(k)) n.add(k);
      return n;
    });

  /** The lines within a finger's width of a point on screen. */
  const linesNear = (cx: number, cy: number) => {
    if (!svg) return [];
    const r = svg.getBoundingClientRect();
    const sc = t().s;
    const px = (cx - r.left) / sc,
      py = (cy - r.top) / sc;
    const reach = 22 / sc;
    const hits: { key: string; d: number }[] = [];
    for (const el of svg.querySelectorAll<SVGPathElement>("[data-line]")) {
      const len = el.getTotalLength();
      let best = Infinity;
      for (let i = 0; i <= len; i += Math.max(3, reach / 4)) {
        const p = el.getPointAtLength(i);
        best = Math.min(best, Math.hypot(p.x - px, p.y - py));
      }
      if (best < reach) hits.push({ key: el.dataset.line!, d: best });
    }
    return hits
      .sort((a, b) => a.d - b.d)
      .map((h) => cl().links.find((l) => l.key === h.key)!)
      .filter(Boolean);
  };
  const nameOf = (id: string) =>
    id.startsWith(CL) ? id.slice(CL.length) : m.name(id);
  const linkLabel = (l: Clustered["links"][number]) =>
    `${nameOf(l.from)} ↔ ${nameOf(l.to)}`;
  const thingAt = (target: EventTarget | null) =>
    (target as Element | null)
      ?.closest?.("[data-id]")
      ?.getAttribute("data-id") ?? null;

  // Gestures: one finger drags, two pinch around their midpoint, a still tap selects, a still
  // hold peeks, two quick taps on a part open it.
  let lastTap = { id: "", at: 0 };
  const gestures = panZoom({
    host: () => host,
    t,
    setT,
    onHold: (target, x, y) => {
      const id = thingAt(target);
      if (id && !id.startsWith(CL)) props.peek({ node: id }, y);
      else {
        const near = linesNear(x, y);
        if (near[0]) props.peek({ ids: edgeIds(near[0].edges) }, y);
      }
    },
    onRelease: () => props.unpeek(),
    onTap: (target, x, y) => {
      const id = thingAt(target);
      if (id?.startsWith(CL)) return toggle(id.slice(CL.length));
      if (id?.startsWith("box:")) return toggle(id.slice(4));
      if (id) {
        const now = performance.now();
        if (
          lastTap.id === id &&
          now - lastTap.at < 320 &&
          (m.children.get(id) ?? []).length
        ) {
          lastTap = { id: "", at: 0 };
          return c.setFocus(id);
        }
        lastTap = { id, at: now };
        return props.select({ kind: "node", id });
      }
      const near = linesNear(x, y);
      if (near.length === 1)
        props.select({ kind: "edge", ids: edgeIds(near[0]!.edges) });
      else if (near.length > 1)
        props.choose(
          near.map((l) => ({
            key: l.key,
            label: linkLabel(l),
            ids: edgeIds(l.edges),
            change: lineChange(l.edges),
          })),
        );
      else props.select(null);
    },
  });
  const litNode = () => props.selNode;
  const lineOn = (l: Clustered["links"][number]) => {
    const es = props.selEdges;
    if (es) return edgeIds(l.edges).some((id) => es.has(id));
    const n = litNode();
    return !!n && (l.from === n || l.to === n);
  };
  const anySel = () => !!props.selEdges || !!litNode();
  return (
    <div ref={host} {...stylex.attrs(s.canvas)} {...gestures}>
      <Show when={laid()}>
        {(l) => (
          <div
            style={{
              "--tx": `${t().x}px`,
              "--ty": `${t().y}px`,
              "--s": `${t().s}`,
            }}
            {...stylex.attrs(s.stage)}
          >
            <ClusterSvg
              cl={cl()}
              l={l()}
              m={m}
              ref={(el) => (svg = el)}
              lineOn={lineOn}
              nodeOn={(id) => id === litNode()}
              faded={anySel()}
              open={open()}
            />
          </div>
        )}
      </Show>
    </div>
  );
}

/**
 * Pan and pinch for a drawing: one finger drags, two pinch around their midpoint (the drawing
 * under the fingers stays under them), a still tap is a tap, a still press of 450 ms is a hold.
 */
function panZoom(o: {
  host: () => HTMLElement | undefined;
  t: () => { x: number; y: number; s: number };
  setT: (v: { x: number; y: number; s: number }) => void;
  onTap: (target: EventTarget | null, x: number, y: number) => void;
  onHold?: (target: EventTarget | null, x: number, y: number) => void;
  onRelease?: () => void;
}) {
  const pts = new Map<number, { x: number; y: number }>();
  let g: {
    x: number;
    y: number;
    tx: number;
    ty: number;
    moved: boolean;
    pinched: boolean;
    target: EventTarget | null;
    held: boolean;
  } | null = null;
  let pinch: {
    d: number;
    s: number;
    mx: number;
    my: number;
    tx: number;
    ty: number;
  } | null = null;
  let holdTimer = 0;
  const midDist = () => {
    const [a, b] = [...pts.values()];
    return {
      mx: (a!.x + b!.x) / 2,
      my: (a!.y + b!.y) / 2,
      d: Math.hypot(a!.x - b!.x, a!.y - b!.y),
    };
  };
  const up = (e: PointerEvent) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size > 0 || !g) return;
    clearTimeout(holdTimer);
    const done = g;
    g = null;
    if (done.held) return o.onRelease?.();
    if (done.moved || done.pinched) return;
    o.onTap(done.target, done.x, done.y);
  };
  return {
    onPointerDown: (e: PointerEvent) => {
      const host = o.host()!;
      host.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const r = host.getBoundingClientRect();
      if (pts.size === 1) {
        g = {
          x: e.clientX,
          y: e.clientY,
          tx: o.t().x,
          ty: o.t().y,
          moved: false,
          pinched: false,
          target: e.target,
          held: false,
        };
        if (o.onHold)
          holdTimer = window.setTimeout(() => {
            if (!g || g.moved) return;
            g.held = true;
            o.onHold!(g.target, g.x, g.y);
          }, 450);
      }
      if (pts.size === 2) {
        clearTimeout(holdTimer);
        const md = midDist();
        pinch = {
          d: md.d,
          s: o.t().s,
          mx: md.mx - r.left,
          my: md.my - r.top,
          tx: o.t().x,
          ty: o.t().y,
        };
        if (g) g.pinched = true;
      }
    },
    onPointerMove: (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size === 2) {
        const r = o.host()!.getBoundingClientRect();
        const md = midDist();
        const sc = Math.max(0.1, Math.min(2.5, (pinch.s * md.d) / pinch.d));
        const k = sc / pinch.s;
        o.setT({
          s: sc,
          x: md.mx - r.left - (pinch.mx - pinch.tx) * k,
          y: md.my - r.top - (pinch.my - pinch.ty) * k,
        });
        return;
      }
      if (!g || g.pinched) return;
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 8) {
        g.moved = true;
        clearTimeout(holdTimer);
      }
      if (g.moved)
        o.setT({
          ...o.t(),
          x: g.tx + e.clientX - g.x,
          y: g.ty + e.clientY - g.y,
        });
    },
    onPointerUp: up,
    onPointerCancel: up,
    onContextMenu: (e: Event) => e.preventDefault(),
  };
}

/** The Clusters drawing itself, shared by variants 2 and 3. */
function ClusterSvg(props: {
  cl: Clustered;
  l: Laid;
  m: Model;
  ref?: (el: SVGSVGElement) => void;
  lineOn: (l: Clustered["links"][number]) => boolean;
  nodeOn: (id: string) => boolean;
  faded: boolean;
  open: Set<string>;
  fit?: boolean;
}) {
  const m = props.m;
  return (
    <svg
      ref={props.ref}
      width={props.fit ? undefined : props.l.width}
      height={props.fit ? undefined : props.l.height}
      viewBox={`-8 -8 ${props.l.width + 16} ${props.l.height + 16}`}
      preserveAspectRatio="xMidYMid meet"
      {...stylex.attrs(props.fit && s.mapSvg)}
    >
      <For each={props.l.boxes}>
        {(b) => (
          <g data-id={`box:${b.value}`}>
            <rect
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={10}
              {...stylex.attrs(s.box)}
            />
            <text x={b.x + 12} y={b.y + 24} {...stylex.attrs(s.svgTitle)}>
              {b.value} ▾ fold
            </text>
          </g>
        )}
      </For>
      <For each={props.cl.links}>
        {(k) => {
          const r = () => props.l.routes.get(k.key);
          const n = () => edgeIds(k.edges).length;
          const ch = () => lineChange(k.edges);
          const on = () => props.lineOn(k);
          const dim = () => props.faded && !on();
          return (
            <Show when={r()}>
              {(rr) => (
                <g {...stylex.attrs(dim() && s.faded)}>
                  <path
                    data-line={k.key}
                    d={rr().d}
                    stroke-width={1.3 + Math.log2(n()) * 1.1}
                    {...stylex.attrs(s.line, strokeOf(ch()), on() && s.lineOn)}
                  />
                  <path d={arrow(rr().end)} {...stylex.attrs(fillOf(ch()))} />
                  <Show when={rr().label}>
                    {(b) => (
                      <text
                        x={b().x + 6}
                        y={b().y + b().h - 4}
                        {...stylex.attrs(s.svgSmall)}
                      >
                        {n()}
                      </text>
                    )}
                  </Show>
                </g>
              )}
            </Show>
          );
        }}
      </For>
      <For each={props.cl.ids}>
        {(id) => {
          const p = () => props.l.at.get(id);
          const isBlock = id.startsWith(CL);
          const k = isBlock ? id.slice(CL.length) : "";
          const ms = () => props.cl.members.get(k) ?? [];
          const changed = () =>
            ms().filter((x) => props.cl.vs.get(x)?.touched).length;
          const ch = (): Change =>
            isBlock
              ? changed()
                ? "modified"
                : "unchanged"
              : changeOf(props.cl.vs.get(id));
          const neighbourOn = () =>
            props.cl.links.some(
              (l) => props.lineOn(l) && (l.from === id || l.to === id),
            );
          const on = () => props.nodeOn(id);
          const dim = () => props.faded && !on() && !neighbourOn();
          return (
            <Show when={p()}>
              {(pp) => (
                <g
                  data-id={id}
                  transform={`translate(${pp().x},${pp().y})`}
                  {...stylex.attrs(dim() && s.faded)}
                >
                  <Show when={isBlock}>
                    <rect
                      x={8}
                      y={-8}
                      width={NODE_W}
                      height={NODE_H}
                      rx={7}
                      {...stylex.attrs(s.stack)}
                    />
                    <rect
                      x={4}
                      y={-4}
                      width={NODE_W}
                      height={NODE_H}
                      rx={7}
                      {...stylex.attrs(s.stack)}
                    />
                  </Show>
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={7}
                    {...stylex.attrs(s.node, strokeOf(ch()), on() && s.nodeSel)}
                  />
                  <rect
                    width={7}
                    height={NODE_H}
                    {...stylex.attrs(fillOf(ch()))}
                  />
                  <text x={18} y={22} {...stylex.attrs(s.svgSmall)}>
                    {isBlock
                      ? `${ms().length} parts${changed() ? ` · ${changed()} changed` : ""}`
                      : headline(m, props.cl.vs.get(id), id)}
                  </text>
                  <text x={18} y={48} {...stylex.attrs(s.svgText)}>
                    {isBlock
                      ? k
                      : m.name(id).length > 24
                        ? `${m.name(id).slice(0, 23)}…`
                        : m.name(id)}
                  </text>
                </g>
              )}
            </Show>
          );
        }}
      </For>
    </svg>
  );
}

/** Path on a phone: one column per page, paged sideways; the previous column peeks on the left. */
function PathPager(props: {
  c: PhoneCtx;
  select: (x: PhoneSel) => void;
  peek: (p: { node?: string; ids?: string[] }, y: number) => void;
  unpeek: () => void;
}) {
  const c = props.c;
  const m = c.m;
  const [path, setPath] = createSignal<string[]>([]);
  let pager: HTMLDivElement | undefined;
  createEffect(
    () => [c.lens(), c.focus(), c.scope()],
    () => {
      setPath([]);
    },
  );
  const pick = (k: number, id: string) => {
    setPath((p) => [...p.slice(0, k), id]);
    props.select({ kind: "node", id });
    requestAnimationFrame(() =>
      pager?.scrollTo({ left: pager.scrollWidth, behavior: "smooth" }),
    );
  };
  const hold = (id: string) => {
    let y = 0;
    const h = holdable(
      () => props.peek({ node: id }, y),
      () => props.unpeek(),
    );
    return {
      ...h,
      onPointerDown: (e: PointerEvent) => ((y = e.clientY), h.onPointerDown(e)),
    };
  };
  return (
    <div ref={pager} {...stylex.attrs(s.pager)}>
      <div {...stylex.attrs(s.page, s.pageFirst)}>
        <div {...stylex.attrs(s.pageHead, s.muted)}>Everything</div>
        <For each={firstColumn(m, c.view())}>
          {(g) => (
            <>
              <div {...stylex.attrs(s.section)}>
                {g.title} ({g.ids.length})
              </div>
              <For each={g.ids}>
                {(id) => (
                  <PartRow
                    c={c}
                    id={id}
                    on={path()[0] === id}
                    onTap={() => pick(0, id)}
                    hold={hold(id)}
                  />
                )}
              </For>
            </>
          )}
        </For>
      </div>
      <For each={path()}>
        {(id, k) => {
          const ls = createMemo(() => linesOf(m, c.view(), id));
          const row = (
            n: { other: string; e: VisEdge; dir: string },
            arrowText: string,
          ) => (
            <PartRow
              c={c}
              id={n.other}
              on={path()[k() + 1] === n.other}
              via={{
                text: `${arrowText} ${bundleText(n.e)}`,
                change: n.e.change,
                onTap: () =>
                  props.select({ kind: "edge", ids: edgeIds([n.e]) }),
              }}
              onTap={() => pick(k() + 1, n.other)}
              hold={hold(n.other)}
            />
          );
          return (
            <div {...stylex.attrs(s.page)}>
              <div {...stylex.attrs(s.pageHead)}>
                <span {...stylex.attrs(s.muted)}>from </span>
                {m.name(id)}
              </div>
              <Show when={ls().out.length}>
                <div {...stylex.attrs(s.section)}>
                  Uses or sends to ({ls().out.length})
                </div>
                <For each={ls().out}>
                  {(n) => row(n, n.dir === "both" ? "↔" : "→")}
                </For>
              </Show>
              <Show when={ls().inn.length}>
                <div {...stylex.attrs(s.section)}>
                  Uses it or sends to it ({ls().inn.length})
                </div>
                <For each={ls().inn}>{(n) => row(n, "←")}</For>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Variant 3: Map and list. The map is Clusters; the list is Path's column for what's picked.

function MapAndList(props: { c: PhoneCtx }) {
  const c = props.c;
  const m = c.m;
  const [path, setPath] = createSignal<string[]>([]);
  const [showDetails, setShowDetails] = createSignal(false);
  const [keyOpen, setKeyOpen] = createSignal(false);
  const [bigMap, setBigMap] = createSignal(false);
  /** Blocks the reader opened on the map by tapping them, on top of the ones the path opens. */
  const [manual, setManual] = createSignal<Set<string>>(new Set());
  const [mt, setMt] = createSignal({ x: 0, y: 0, s: 1 });
  let mapHost: HTMLDivElement | undefined;
  const [lineSel, setLineSel] = createSignal<string[] | null>(null);
  const here = () => path()[path().length - 1] ?? null;
  createEffect(
    () => [c.lens(), c.focus(), c.scope()],
    () => {
      setPath([]);
      setLineSel(null);
      setShowDetails(false);
    },
  );
  /** The map opens the block holding what's picked, so it can be seen. */
  const open = createMemo(() => {
    const base = clusters(c, c.view(), new Set());
    const o = new Set<string>();
    for (const id of [here(), ...path()]) if (id) o.add(base.blockOf.get(id)!);
    for (const k of manual()) o.add(k);
    return o;
  });
  const cl = createMemo(() => clusters(c, c.view(), open()));
  const [laid, setLaid] = createSignal<Laid | null>(null);
  let ticket = 0;
  createEffect(
    () => cl(),
    (x) => {
      const mine = ++ticket;
      void layout(
        x.ids,
        x.links.map((l) => ({
          key: l.key,
          from: l.from,
          to: l.to,
          label: `${edgeIds(l.edges).length}`,
        })),
        undefined,
        x.groups,
      ).then((at) => {
        if (mine !== ticket) return;
        setLaid(at);
        // A new layout keeps the reader's zoom and brings what's picked to the middle; with
        // nothing picked, the whole drawing fits.
        const p = here() ? at.at.get(here()!) : undefined;
        if (p)
          centreOn(p.x + NODE_W / 2, p.y + NODE_H / 2, Math.max(mt().s, 0.45));
        else fit(at);
      });
    },
  );
  const fit = (at = laid()) => {
    if (!at || !mapHost) return;
    const w = mapHost.clientWidth,
      h = mapHost.clientHeight;
    const sc = Math.min(1, (w - 16) / at.width, (h - 16) / at.height);
    setMt({ s: sc, x: (w - at.width * sc) / 2, y: (h - at.height * sc) / 2 });
  };
  const centreOn = (x: number, y: number, sc: number) => {
    if (!mapHost) return;
    setMt({
      s: sc,
      x: mapHost.clientWidth / 2 - x * sc,
      y: mapHost.clientHeight / 2 - y * sc,
    });
  };
  const toggleBlock = (k: string) =>
    setManual((o) => {
      const n = new Set(o);
      if (!n.delete(k)) n.add(k);
      return n;
    });
  const mapGestures = panZoom({
    host: () => mapHost,
    t: mt,
    setT: setMt,
    onTap: (target) => {
      const id = (target as Element | null)
        ?.closest?.("[data-id]")
        ?.getAttribute("data-id");
      if (!id) return;
      if (id.startsWith(CL)) return toggleBlock(id.slice(CL.length));
      if (id.startsWith("box:")) return toggleBlock(id.slice(4));
      go(id);
    },
  });
  const go = (id: string) => {
    setPath((p) =>
      p.includes(id) ? p.slice(0, p.indexOf(id) + 1) : [...p, id],
    );
    setLineSel(null);
    c.setSel({ kind: "node", id });
    setShowDetails(false);
  };
  const ls = createMemo(() => (here() ? linesOf(m, c.view(), here()!) : null));
  const lineOn = (l: Clustered["links"][number]) => {
    const ls0 = lineSel();
    if (ls0) return edgeIds(l.edges).some((id) => ls0.includes(id));
    const n = here();
    return !!n && (l.from === n || l.to === n);
  };
  const row = (
    n: { other: string; e: VisEdge; dir: string },
    arrowText: string,
  ) => {
    const ids = edgeIds([n.e]);
    const on = () => !!lineSel() && lineSel()!.join() === ids.join();
    return (
      <PartRow
        c={c}
        id={n.other}
        on={on()}
        via={{
          text: `${arrowText} ${bundleText(n.e)}`,
          change: n.e.change,
          onTap: () => {
            setLineSel(on() ? null : ids);
            c.setSel(
              on() ? { kind: "node", id: here()! } : { kind: "edge", ids },
            );
          },
        }}
        end="Go ›"
        onTap={() => go(n.other)}
      />
    );
  };
  return (
    <div {...stylex.attrs(s.app)}>
      <Top
        c={c}
        title={
          here()
            ? m.name(here()!)
            : c.focus() && c.focus() !== c.home()
              ? m.name(c.focus()!)
              : "Whole system"
        }
        back={
          path().length
            ? () => (
                setPath((p) => p.slice(0, -1)),
                setLineSel(null),
                setShowDetails(false)
              )
            : c.focus() !== c.home()
              ? () => c.setFocus(m.nodes.get(c.focus()!)?.parent ?? null)
              : undefined
        }
      />
      <div
        ref={mapHost}
        {...stylex.attrs(s.map, bigMap() && s.mapBig)}
        {...mapGestures}
      >
        <Show when={laid()}>
          {(l) => (
            <div
              style={{
                "--tx": `${mt().x}px`,
                "--ty": `${mt().y}px`,
                "--s": `${mt().s}`,
              }}
              {...stylex.attrs(s.stage)}
            >
              <ClusterSvg
                cl={cl()}
                l={l()}
                m={m}
                lineOn={lineOn}
                nodeOn={(id) => id === here()}
                faded={!!here()}
                open={open()}
              />
            </div>
          )}
        </Show>
        <button
          {...stylex.attrs(s.chip, s.chipTR)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => fit()}
        >
          Fit
        </button>
        <button
          {...stylex.attrs(s.chip, s.chipTR2)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => (
            setBigMap((b) => !b),
            requestAnimationFrame(() => fit())
          )}
        >
          {bigMap() ? "Smaller" : "Bigger"}
        </button>
      </div>
      <button {...stylex.attrs(s.strip)} onClick={() => setKeyOpen((k) => !k)}>
        <b>Key</b>
        <span>
          <span {...stylex.attrs(s.dot, barOf("added"))} />
          added
        </span>
        <span>
          <span {...stylex.attrs(s.dot, barOf("modified"))} />
          changed
        </span>
        <span>
          <span {...stylex.attrs(s.dot, barOf("removed"))} />
          removed
        </span>
        <span>
          <span {...stylex.attrs(s.dot, barOf("unchanged"))} />
          not changed
        </span>
        <span {...stylex.attrs(s.muted)}>{keyOpen() ? "▴" : "more ▾"}</span>
      </button>
      <div {...stylex.attrs(s.body)}>
        <Show when={keyOpen()}>
          <Key drawing />
        </Show>
        <Show when={!keyOpen()}>
          <Show when={path().length > 1}>
            <div {...stylex.attrs(s.crumbs)}>
              <For each={path()}>
                {(id, i) => (
                  <button
                    {...stylex.attrs(
                      s.crumb,
                      i() === path().length - 1 && s.crumbOn,
                    )}
                    onClick={() => setPath((p) => p.slice(0, i() + 1))}
                  >
                    {m.name(id)}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show
            when={here()}
            fallback={
              <>
                <ViewControls c={c} />
                <For each={cl().keys}>
                  {(k) => (
                    <>
                      <div {...stylex.attrs(s.section)}>
                        {k} ({cl().members.get(k)?.length ?? 0})
                      </div>
                      <For each={cl().members.get(k) ?? []}>
                        {(id) => <PartRow c={c} id={id} onTap={() => go(id)} />}
                      </For>
                    </>
                  )}
                </For>
              </>
            }
          >
            {(id) => (
              <>
                <div {...stylex.attrs(s.actions, s.actionsPad)}>
                  <button
                    {...stylex.attrs(s.btn, showDetails() && s.btnMain)}
                    onClick={() => setShowDetails((d) => !d)}
                  >
                    {showDetails()
                      ? "Lines"
                      : lineSel()
                        ? "Details of this line"
                        : "Details"}
                  </button>
                  <Show when={(m.children.get(id()) ?? []).length}>
                    <button
                      {...stylex.attrs(s.btn)}
                      onClick={() => c.setFocus(id())}
                    >
                      Open inside
                    </button>
                  </Show>
                </div>
                <Show when={showDetails()}>
                  <div {...stylex.attrs(s.panelWrap)}>{c.panel()}</div>
                </Show>
                <Show when={!showDetails() && ls()}>
                  {(l) => (
                    <>
                      <Show when={l().out.length}>
                        <div {...stylex.attrs(s.section)}>
                          Uses or sends to ({l().out.length})
                        </div>
                        <For each={l().out}>
                          {(n) => row(n, n.dir === "both" ? "↔" : "→")}
                        </For>
                      </Show>
                      <Show when={l().inn.length}>
                        <div {...stylex.attrs(s.section)}>
                          Uses it or sends to it ({l().inn.length})
                        </div>
                        <For each={l().inn}>{(n) => row(n, "←")}</For>
                      </Show>
                    </>
                  )}
                </Show>
              </>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}
