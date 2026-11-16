// PROTOTYPE (PR view, #144): five ways to explore the graph other than drawing it all at once.
// Each shows a small, readable part and lets the reader move through the rest without losing
// their place. They read the same view the graph does (zoom level, lens, "Show"), and select and
// hover through the page, so the panel and hover cards work the same.
//
//   Neighbourhood: one part in the middle, what feeds it on the left, what it uses on the right.
//   Columns: a column browser; each pick lists what that part connects to in the next column.
//   Matrix: changed parts by every part; a cell is a connection, no lines to route.
//   Clusters: everything folded into a few blocks; open one in place, the rest stay folded.
//   Rings: changed parts in the middle, then one step out, two steps out; lines only on hover.
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import * as stylex from "@stylexjs/stylex";
import { colors, fonts } from "../src/tokens.stylex.ts";
import { pal } from "./tokens.stylex.ts";
import { arrow, layout, NODE_H, NODE_W, type Laid } from "./layout.ts";
import type { Model, VisEdge, VisNode } from "./model.ts";
import type { Change } from "./schema.ts";

type View = ReturnType<Model["view"]>;

export interface Api {
  selected: () => string | null;
  select: (id: string) => void;
  selectEdges: (ids: string[]) => void;
  open: (id: string) => void;
  hoverNode: (id: string | null) => void;
  hoverEdge: (key: string | null, ids?: string[]) => void;
  /** The "Boxes" grouping of an external system or store, in words. */
  groupOf: (id: string) => string | undefined;
}

export type ExploreKind = "neighbourhood" | "columns" | "matrix" | "clusters" | "rings" | "path";

const MARK: Record<Change | "mixed", string> = { added: "+ added", removed: "− removed", modified: "~ changed", unchanged: "unchanged", mixed: "~ mixed" };
const SIGN: Record<Change | "mixed", string> = { added: "+ ", removed: "− ", modified: "~ ", unchanged: "", mixed: "~ " };

const appear = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const nb = stylex.create({
  stage: { height: "var(--h)", position: "relative", transition: "height 480ms" },
  lines: { left: 0, position: "absolute", top: 0 },
  sized: { height: "var(--hh)", width: "var(--w)" },
  gone: { opacity: 0, pointerEvents: "none" },
});
/** cubic-bezier(.4, 0, .2, 1), the curve the CSS glides use, for motion driven from script. */
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
const linesAppear = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
/** Clusters: things glide to new targets; boxes grow and shrink; lines return once things settle. */
const cl = stylex.create({
  svg: { display: "block" },
  place: { opacity: 1, transform: "translate(var(--x), var(--y))" },
  glide: { transition: "transform 500ms cubic-bezier(.4,0,.2,1), opacity 380ms" },
  gone: { opacity: 0, pointerEvents: "none" },
  boxSize: { height: "var(--bh)", transition: "width 500ms cubic-bezier(.4,0,.2,1), height 500ms cubic-bezier(.4,0,.2,1)", width: "var(--bw)" },
  linesIn: { animationDuration: "220ms", animationFillMode: "both", animationName: linesAppear },
});
const picked = stylex.create({ on: { stroke: colors.accent, strokeWidth: 3 } });
const s = stylex.create({
  wrap: { fontFamily: fonts.ui, fontSize: 13, padding: 16, position: "relative" },
  full: { boxSizing: "border-box", height: "100%" },
  muted: { color: colors.muted },
  small: { color: colors.muted, fontSize: 11 },
  h: { color: colors.muted, fontSize: 11, fontWeight: 650, letterSpacing: "0.04em", marginBlock: 8, textTransform: "uppercase" },
  trail: { alignItems: "center", display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  crumb: { backgroundColor: "transparent", borderColor: colors.line, borderRadius: 999, borderStyle: "solid", borderWidth: 1, color: colors.fg, cursor: "pointer", fontSize: 12, paddingBlock: 2, paddingInline: 8 },
  crumbOn: { borderColor: colors.accent, color: colors.accent },
  card: {
    backgroundColor: pal.nodeBg,
    borderColor: colors.line,
    borderLeftWidth: 6,
    borderRadius: 7,
    borderStyle: "solid",
    borderWidth: 1.5,
    boxSizing: "border-box",
    cursor: "pointer",
    left: 0,
    overflow: "hidden",
    paddingBlock: 6,
    paddingInline: 10,
    position: "absolute",
    top: 0,
    transform: "translate(var(--x), var(--y))",
    transition: "transform 480ms cubic-bezier(.4,0,.2,1), opacity 300ms, width 480ms, height 480ms",
    whiteSpace: "nowrap",
  },
  cardCentre: { borderWidth: 2.5, boxShadow: `0 6px 24px ${colors.popShadow}`, paddingBlock: 12, paddingInline: 14 },
  cardSel: { outlineColor: colors.accent, outlineStyle: "solid", outlineWidth: 2.5 },
  name: { color: colors.fg, fontSize: 13, fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis" },
  nameBig: { fontSize: 17 },
  via: { color: colors.muted, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" },
  fadeIn: { animationDelay: "380ms", animationDuration: "260ms", animationFillMode: "both", animationName: appear },
  // Columns
  cols: { display: "flex", gap: 0, height: "calc(100% - 8px)", overflowX: "auto", scrollBehavior: "smooth" },
  col: { borderRightColor: colors.line, borderRightStyle: "solid", borderRightWidth: 1, flexShrink: 0, overflowY: "auto", paddingInline: 8, width: 290 },
  row: { alignItems: "center", borderRadius: 6, cursor: "pointer", display: "flex", gap: 8, paddingBlock: 5, paddingInline: 8 },
  rowOn: { backgroundColor: colors.selected },
  rowPath: { fontWeight: 650 },
  dot: { borderRadius: 999, flexShrink: 0, height: 9, width: 9 },
  rowText: { display: "flex", flexDirection: "column", minWidth: 0 },
  more: { color: colors.muted, marginLeft: "auto" },
  // Matrix
  table: { borderCollapse: "separate", borderSpacing: 0, fontSize: 11 },
  th: { backgroundColor: colors.bg, color: colors.muted, fontWeight: 500, position: "sticky", top: 0, zIndex: 1 },
  thCol: { height: 150, paddingBottom: 4, verticalAlign: "bottom" },
  vert: { display: "inline-block", maxHeight: 146, overflow: "hidden", textOverflow: "ellipsis", transform: "rotate(180deg)", whiteSpace: "nowrap", writingMode: "vertical-rl" },
  thRow: { backgroundColor: colors.bg, left: 0, maxWidth: 220, overflow: "hidden", paddingRight: 8, position: "sticky", textAlign: "right", textOverflow: "ellipsis", whiteSpace: "nowrap", zIndex: 1 },
  corner: { left: 0, zIndex: 2 },
  cell: { borderColor: colors.line, borderStyle: "solid", borderWidth: 0.5, cursor: "default", height: 18, padding: 0, textAlign: "center", width: 18 },
  cellOn: { cursor: "pointer", fontWeight: 700 },
  cross: { backgroundColor: colors.hover },
  groupStart: { borderLeftColor: colors.muted, borderLeftWidth: 2 },
  groupHead: { color: colors.fg, fontWeight: 650, textAlign: "left" },
  // Clusters and rings (SVG)
  svgText: { fill: colors.fg, fontFamily: fonts.ui, fontSize: 13, fontWeight: 650, pointerEvents: "none" },
  svgSmall: { fill: colors.muted, fontFamily: fonts.ui, fontSize: 11, pointerEvents: "none" },
  svgTitle: { fill: colors.muted, fontFamily: fonts.ui, fontSize: 12, fontWeight: 650 },
  box: { fill: colors.bgRaised, stroke: colors.line, strokeWidth: 1.5 },
  stackBack: { fill: pal.contextBg, stroke: colors.line, strokeWidth: 1.2 },
  node: { cursor: "pointer", fill: pal.nodeBg, strokeWidth: 1.5 },
  move: { transform: "translate(var(--x), var(--y))", transition: "transform 480ms cubic-bezier(.4,0,.2,1)" },
  line: { fill: "none", strokeWidth: 1.6 },
  faded: { opacity: 0.12 },
  ring: { fill: "none", stroke: colors.line, strokeDasharray: "4 6" },
  pill: { cursor: "pointer", fill: pal.nodeBg, strokeWidth: 1.5 },
  hit: { cursor: "pointer", fill: "none", pointerEvents: "stroke", stroke: "transparent", strokeWidth: 12 },
  click: { cursor: "pointer" },
});
const stroke = stylex.create({
  added: { stroke: pal.added },
  removed: { stroke: pal.removed },
  modified: { stroke: pal.modified },
  unchanged: { stroke: pal.unchanged },
  mixed: { stroke: pal.modified },
});
const fill = stylex.create({
  added: { backgroundColor: pal.added, fill: pal.added },
  removed: { backgroundColor: pal.removed, fill: pal.removed },
  modified: { backgroundColor: pal.modified, fill: pal.modified },
  unchanged: { backgroundColor: pal.unchanged, fill: pal.unchanged },
  mixed: { backgroundColor: pal.modified, fill: pal.modified },
});
const edgeBorder = stylex.create({
  added: { borderColor: pal.added },
  removed: { borderColor: pal.removed },
  modified: { borderColor: pal.modified },
  unchanged: { borderColor: pal.unchanged },
  mixed: { borderColor: pal.modified },
});
const textC = stylex.create({
  added: { color: pal.added, fill: pal.added },
  removed: { color: pal.removed, fill: pal.removed },
  modified: { color: pal.modified, fill: pal.modified },
  unchanged: { color: colors.muted, fill: colors.muted },
  mixed: { color: pal.modified, fill: pal.modified },
});

/** Style lookups by change, as calls: StyleX's compiler can't follow some keys, and leaves calls to run time. */
function strokeOf(c: Change | "mixed") {
  return stroke[c];
}
function fillOf(c: Change | "mixed") {
  return fill[c];
}
function textOf(c: Change | "mixed") {
  return textC[c];
}
function borderOf(c: Change | "mixed") {
  return edgeBorder[c];
}

// ---------------------------------------------------------------------------------------------
// Shared helpers.

/** A node's change as the views show it: a part with changes inside it counts as changed. */
/** The change of a node that may not be drawn: unchanged when it isn't. */
function changeIn(vs: Map<string, VisNode>, id: string): Change {
  const v = vs.get(id);
  return v ? changeOf(v) : "unchanged";
}
function changeOf(v: VisNode): Change {
  if (v.node.change !== "unchanged") return v.node.change;
  return v.touched ? "modified" : "unchanged";
}
function headline(m: Model, v: VisNode): string {
  const kind = m.kindLabel(v.node.id);
  return m.showsChange(v.node.id) ? `${kind} · ${MARK[changeOf(v)]}` : kind;
}
function bundleText(e: VisEdge): string {
  if (e.edges.length > 1) {
    const changed = e.edges.filter((x) => x.change !== "unchanged").length;
    return `${e.edges.length} connections${changed ? `, ${changed} new or changed` : ""}`;
  }
  return `${SIGN[e.edges[0]!.change]}${e.edges[0]!.label}`;
}
/** Each node's bundles, the other end, and which way the traffic goes from this node. */
function neighbours(view: View, id: string) {
  const out: { other: string; e: VisEdge; dir: "out" | "in" | "both" }[] = [];
  for (const e of view.edges) {
    if (e.from !== id && e.to !== id) continue;
    const other = e.from === id ? e.to : e.from;
    const dir = e.both ? "both" : e.from === id ? "out" : "in";
    out.push({ other, e, dir });
  }
  return out;
}
const byChangeThenName = (m: Model, vs: Map<string, VisNode>) => (a: string, b: string) => {
  const ca = vs.get(a)?.touched ? 0 : 1, cb = vs.get(b)?.touched ? 0 : 1;
  return ca - cb || m.name(a).localeCompare(m.name(b));
};

export function Explore(props: { kind: ExploreKind; m: Model; view: View; api: Api }) {
  return (
    <>
      <Show when={props.kind === "neighbourhood"}>
        <Neighbourhood m={props.m} view={props.view} api={props.api} />
      </Show>
      <Show when={props.kind === "columns"}>
        <Columns m={props.m} view={props.view} api={props.api} />
      </Show>
      <Show when={props.kind === "matrix"}>
        <Matrix m={props.m} view={props.view} api={props.api} />
      </Show>
      <Show when={props.kind === "clusters"}>
        <Clusters m={props.m} view={props.view} api={props.api} />
      </Show>
      <Show when={props.kind === "rings"}>
        <Rings m={props.m} view={props.view} api={props.api} />
      </Show>
      <Show when={props.kind === "path"}>
        <Path m={props.m} view={props.view} api={props.api} />
      </Show>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// 1. Neighbourhood: one part in the middle and only what it touches directly.

function Neighbourhood(props: { m: Model; view: View; api: Api }) {
  const m = props.m;
  const vs = createMemo(() => new Map(props.view.nodes.map((v) => [v.node.id, v])));
  const start = () => {
    const sel = props.api.selected();
    if (sel && vs().has(sel)) return sel;
    // The changed part with the most connections.
    const count = (id: string) => props.view.edges.filter((e) => e.from === id || e.to === id).length;
    return [...vs().values()].filter((v) => v.touched).sort((a, b) => count(b.node.id) - count(a.node.id))[0]?.node.id ?? props.view.nodes[0]?.node.id;
  };
  const [centre, setCentre] = createSignal<string | undefined>(start());
  const [trail, setTrail] = createSignal<string[]>(centre() ? [centre()!] : []);
  const go = (id: string) => {
    setCentre(id);
    setTrail((t) => (t.includes(id) ? t.slice(0, t.indexOf(id) + 1) : [...t, id]));
    // The panel's re-render is heavy: select once the glide has landed, so it doesn't stall the motion.
    setTimeout(() => props.api.select(id), 520);
  };
  createEffect(
    () => vs(),
    (map) => {
      const c = centre();
      if (!c || !map.has(c)) {
        const s0 = start();
        setCentre(s0);
        setTrail(s0 ? [s0] : []);
      }
    },
  );

  // Fit the canvas: the three columns share its width, the gaps take what's left.
  const [width, setWidth] = createSignal(900);
  let stage: HTMLDivElement | undefined;
  const watch = (el: HTMLDivElement) => {
    stage = el;
    new ResizeObserver(() => stage && setWidth(stage.clientWidth)).observe(el);
  };
  const CH = 56, GAP = 12, BIG_H = 104, TOP = 30;
  const CW = () => Math.max(190, Math.min(260, (width() - 80) * 0.28));
  const BIG_W = () => Math.max(240, Math.min(340, (width() - 80) * 0.34));
  const X_LEFT = 0;
  const gapX = () => Math.max(40, (width() - 2 * CW() - BIG_W()) / 2);
  const X_MID = () => CW() + gapX();
  const X_RIGHT = () => X_MID() + BIG_W() + gapX();
  /** Where every card goes: the centre, its inbound on the left, outbound on the right. */
  const place = createMemo(() => {
    const c = centre();
    const out = new Map<string, { x: number; y: number; role: "centre" | "left" | "right"; e?: VisEdge; dir?: string }>();
    if (!c) return { out, height: 0, left: [] as string[], right: [] as string[] };
    const ns = neighbours(props.view, c);
    const sort = byChangeThenName(m, vs());
    const left = ns.filter((n) => n.dir === "in").map((n) => n.other).sort(sort);
    const right = ns.filter((n) => n.dir !== "in").map((n) => n.other).sort(sort);
    const find = (id: string) => ns.find((n) => n.other === id)!;
    left.forEach((id, i) => out.set(id, { x: X_LEFT, y: TOP + i * (CH + GAP), role: "left", e: find(id).e, dir: "in" }));
    right.forEach((id, i) => out.set(id, { x: X_RIGHT(), y: TOP + i * (CH + GAP), role: "right", e: find(id).e, dir: find(id).dir }));
    out.set(c, { x: X_MID(), y: TOP, role: "centre" });
    const height = TOP + Math.max(left.length, right.length, 2) * (CH + GAP) + 40;
    return { out, height, left, right };
  });
  /** Cards stay mounted while their id stays, so a neighbour that becomes the centre glides there. */
  // Every part keeps a mounted card, in a fixed order: a card that's inserted or moved in the DOM
  // can't glide. Cards outside the neighbourhood fade out where they last were.
  const ids = createMemo(() => [...vs().keys()].sort());
  const lastAt = new Map<string, { x: number; y: number; role: "centre" | "left" | "right"; e?: VisEdge; dir?: string }>();

  return (
    <div {...stylex.attrs(s.wrap)}>
      <div {...stylex.attrs(s.trail)}>
        <span {...stylex.attrs(s.small)}>Where you've been:</span>
        <For each={trail()}>
          {(id) => (
            <button {...stylex.attrs(s.crumb, id === centre() && s.crumbOn)} onClick={() => go(id)}>
              {m.name(id)}
            </button>
          )}
        </For>
        <span {...stylex.attrs(s.small)}>· click a part to move to it · double-click to open it</span>
      </div>
      <div {...stylex.attrs(s.h)}>
        <span>Sends to it or uses it ({place().left.length})</span>
      </div>
      <div ref={watch} style={{ "--h": `${place().height}px` }} {...stylex.attrs(nb.stage)}>
        <Show keyed when={centre()}>
          {(c) => (
            <svg width={X_RIGHT() + CW()} height={place().height} {...stylex.attrs(nb.lines, s.fadeIn)}>
              {/* A trunk on each side, each card joined to it: no line crosses another. */}
              <For each={[...place().out.entries()].filter(([, p]) => p.role !== "centre")}>
                {([, p]) => {
                  const midY = TOP + BIG_H / 2;
                  const y = p.y + CH / 2;
                  const trunkX = p.role === "left" ? X_LEFT + CW() + gapX() / 2 : X_RIGHT() - gapX() / 2;
                  const d =
                    p.role === "left"
                      ? `M${X_LEFT + CW()},${y} H${trunkX} V${midY} H${X_MID()}`
                      : `M${X_MID() + BIG_W()},${midY} H${trunkX} V${y} H${X_RIGHT()}`;
                  const ch = (): Change | "mixed" => p.e?.change ?? "unchanged";
                  return (
                    <g onMouseEnter={() => props.api.hoverEdge(p.e!.key, p.e!.edges.map((x) => x.id))} onMouseLeave={() => props.api.hoverEdge(null)} onClick={() => props.api.selectEdges(p.e!.edges.map((x) => x.id))}>
                      <path d={d} {...stylex.attrs(s.line, strokeOf(ch()))} />
                      <path d={d} {...stylex.attrs(s.hit)} />
                    </g>
                  );
                }}
              </For>
              <text x={X_RIGHT()} y={TOP - 10} {...stylex.attrs(s.svgSmall)}>
                {c && `it uses or sends to (${place().right.length})`}
              </text>
            </svg>
          )}
        </Show>
        <For each={ids()}>
          {(id) => {
            // Always mounted while the id is in view, so a change of place is a glide, not a new card.
            const here = () => place().out.has(id);
            const p = () => {
              const at = place().out.get(id);
              if (at) lastAt.set(id, at);
              return at ?? lastAt.get(id) ?? { x: X_MID(), y: TOP, role: "left" as const, e: undefined, dir: undefined };
            };
            const v = () => vs().get(id)!;
            const big = () => p().role === "centre";
            return (
                <div
                  style={{ "--x": `${p().x}px`, "--y": `${p().y}px`, "--w": `${big() ? BIG_W() : CW()}px`, "--hh": `${big() ? BIG_H : CH}px` }}
                  {...stylex.attrs(s.card, nb.sized, borderOf(changeIn(vs(), id)), big() && s.cardCentre, props.api.selected() === id && s.cardSel, here() ? null : nb.gone)}
                  onClick={() => (big() ? props.api.select(id) : go(id))}
                  onDblClick={() => props.api.open(id)}
                  onMouseEnter={() => props.api.hoverNode(id)}
                  onMouseLeave={() => props.api.hoverNode(null)}
                >
                  <div {...stylex.attrs(s.small, textOf(changeIn(vs(), id)))}>{headline(m, v())}</div>
                  <div {...stylex.attrs(s.name, big() && s.nameBig)}>{m.name(id)}</div>
                  <Show when={!big() && p().e}>
                    <div {...stylex.attrs(s.via)}>
                      {p().dir === "both" ? "↔ " : p().dir === "in" ? "→ " : "→ "}
                      {bundleText(p().e!)}
                    </div>
                  </Show>
                  <Show when={big()}>
                    <div {...stylex.attrs(s.via)}>{v().node.summary}</div>
                  </Show>
                </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------------------------
// 2. Columns: pick a part, the next column lists what it connects to.

function Columns(props: { m: Model; view: View; api: Api }) {
  const m = props.m;
  const vs = createMemo(() => new Map(props.view.nodes.map((v) => [v.node.id, v])));
  const [path, setPath] = createSignal<string[]>([]);
  let strip: HTMLDivElement | undefined;
  const first = createMemo(() => {
    const all = [...vs().values()];
    const sort = (a: VisNode, b: VisNode) => m.name(a.node.id).localeCompare(m.name(b.node.id));
    return [
      { title: "People and callers", items: all.filter((v) => v.node.kind === "actor").sort(sort) },
      { title: "Changed by this PR", items: all.filter((v) => v.touched && v.node.kind !== "actor").sort(sort) },
      { title: "Not changed", items: all.filter((v) => !v.touched && !m.isUsed(v.node.id) && v.node.kind !== "actor").sort(sort) },
      { title: "Outside systems and stores", items: all.filter((v) => !v.touched && m.isUsed(v.node.id)).sort(sort) },
    ].filter((g) => g.items.length > 0);
  });
  const pick = (k: number, id: string) => {
    setPath((p) => [...p.slice(0, k), id]);
    props.api.select(id);
    requestAnimationFrame(() => strip?.scrollTo({ left: strip.scrollWidth }));
  };
  const Row = (rp: { id: string; k: number; via?: string; dir?: string; change?: Change | "mixed" }) => {
    const v = () => vs().get(rp.id);
    const onPath = () => path()[rp.k] === rp.id;
    const count = () => props.view.edges.filter((e) => e.from === rp.id || e.to === rp.id).length;
    return (
      <Show when={v()}>
        <div
          {...stylex.attrs(s.row, onPath() && s.rowOn, path().includes(rp.id) && s.rowPath)}
          onClick={() => pick(rp.k, rp.id)}
          onDblClick={() => props.api.open(rp.id)}
          onMouseEnter={() => props.api.hoverNode(rp.id)}
          onMouseLeave={() => props.api.hoverNode(null)}
        >
          <span {...stylex.attrs(s.dot, fillOf(changeIn(vs(), rp.id)))} />
          <span {...stylex.attrs(s.rowText)}>
            <span {...stylex.attrs(s.name)}>{m.name(rp.id)}</span>
            <span {...stylex.attrs(s.via, rp.change && textOf(rp.change))}>{rp.via ?? headline(m, v()!)}</span>
          </span>
          <span {...stylex.attrs(s.more)}>{count()} ▸</span>
        </div>
      </Show>
    );
  };
  return (
    <div {...stylex.attrs(s.wrap, s.full)}>
      <div {...stylex.attrs(s.small)}>Pick a part; the next column lists what it connects to. Double-click to open a part.</div>
      <div ref={strip} {...stylex.attrs(s.cols)}>
        <div {...stylex.attrs(s.col)}>
          <For each={first()}>
            {(g) => (
              <>
                <div {...stylex.attrs(s.h)}>
                  {g.title} ({g.items.length})
                </div>
                <For each={g.items}>{(v) => <Row id={v.node.id} k={0} />}</For>
              </>
            )}
          </For>
        </div>
        <For each={path()}>
          {(id, k) => {
            const ns = () => {
              const sort = byChangeThenName(m, vs());
              const list = neighbours(props.view, id);
              return {
                out: list.filter((n) => n.dir !== "in").sort((a, b) => sort(a.other, b.other)),
                in: list.filter((n) => n.dir === "in").sort((a, b) => sort(a.other, b.other)),
              };
            };
            return (
              <div {...stylex.attrs(s.col)}>
                <div {...stylex.attrs(s.h)}>{m.name(id)}</div>
                <Show when={ns().out.length > 0}>
                  <div {...stylex.attrs(s.h)}>It uses or sends to ({ns().out.length})</div>
                  <For each={ns().out}>
                    {(n) => <Row id={n.other} k={k() + 1} via={`${n.dir === "both" ? "↔" : "→"} ${bundleText(n.e)}`} change={n.e.change} />}
                  </For>
                </Show>
                <Show when={ns().in.length > 0}>
                  <div {...stylex.attrs(s.h)}>Uses it or sends to it ({ns().in.length})</div>
                  <For each={ns().in}>{(n) => <Row id={n.other} k={k() + 1} via={`← ${bundleText(n.e)}`} change={n.e.change} />}</For>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Matrix: changed parts down the side, every part across; a cell is a connection.

function Matrix(props: { m: Model; view: View; api: Api }) {
  const m = props.m;
  const vs = createMemo(() => new Map(props.view.nodes.map((v) => [v.node.id, v])));
  const [allRows, setAllRows] = createSignal(false);
  const [hot, setHot] = createSignal<{ r?: string; c?: string }>({});
  const groups = createMemo(() => {
    const all = [...vs().values()];
    const sort = (a: VisNode, b: VisNode) => m.name(a.node.id).localeCompare(m.name(b.node.id));
    return [
      { title: "Changed", ids: all.filter((v) => v.touched && v.node.kind !== "actor").sort(sort) },
      { title: "Not changed", ids: all.filter((v) => !v.touched && !m.isUsed(v.node.id) && v.node.kind !== "actor").sort(sort) },
      { title: "People", ids: all.filter((v) => v.node.kind === "actor").sort(sort) },
      { title: "Outside and stores", ids: all.filter((v) => !v.touched && m.isUsed(v.node.id)).sort(sort) },
    ]
      .filter((g) => g.ids.length > 0)
      .map((g) => ({ title: g.title, ids: g.ids.map((v) => v.node.id) }));
  });
  const cols = createMemo(() => groups().flatMap((g, gi) => g.ids.map((id, i) => ({ id, start: i === 0 && gi > 0 }))));
  const rows = createMemo(() => (allRows() ? groups().flatMap((g) => g.ids) : (groups().find((g) => g.title === "Changed")?.ids ?? [])));
  const pair = createMemo(() => {
    const map = new Map<string, VisEdge>();
    for (const e of props.view.edges) {
      map.set(`${e.from}|${e.to}`, e);
      map.set(`${e.to}|${e.from}`, e);
    }
    return map;
  });
  return (
    <div {...stylex.attrs(s.wrap)}>
      <div {...stylex.attrs(s.trail)}>
        <span {...stylex.attrs(s.small)}>Rows:</span>
        <button {...stylex.attrs(s.crumb, !allRows() && s.crumbOn)} onClick={() => setAllRows(false)}>
          changed parts
        </button>
        <button {...stylex.attrs(s.crumb, allRows() && s.crumbOn)} onClick={() => setAllRows(true)}>
          every part
        </button>
        <span {...stylex.attrs(s.small)}>· → the row's part uses or sends to the column's · ← the other way · ↔ both · colour: how the PR changed it</span>
      </div>
      <table {...stylex.attrs(s.table)} onMouseLeave={() => setHot({})}>
        <thead>
          <tr>
            <th {...stylex.attrs(s.th, s.corner)} />
            <For each={groups()}>
              {(g) => (
                <th colspan={g.ids.length} {...stylex.attrs(s.th, s.groupHead)}>
                  {g.title}
                </th>
              )}
            </For>
          </tr>
          <tr>
            <th {...stylex.attrs(s.th, s.corner)} />
            <For each={cols()}>
              {(c) => (
                <th
                  {...stylex.attrs(s.th, s.thCol, c.start && s.groupStart, hot().c === c.id && s.cross)}
                  onClick={() => props.api.select(c.id)}
                  onMouseEnter={() => (setHot({ c: c.id }), props.api.hoverNode(c.id))}
                  onMouseLeave={() => props.api.hoverNode(null)}
                >
                  <span {...stylex.attrs(s.vert, textOf(changeIn(vs(), c.id)))}>{m.name(c.id)}</span>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(r) => (
              <tr>
                <th
                  {...stylex.attrs(s.thRow, hot().r === r && s.cross, textOf(changeIn(vs(), r)))}
                  onClick={() => props.api.select(r)}
                  onMouseEnter={() => props.api.hoverNode(r)}
                  onMouseLeave={() => props.api.hoverNode(null)}
                >
                  {m.name(r)}
                </th>
                <For each={cols()}>
                  {(c) => {
                    const e = () => pair().get(`${r}|${c.id}`);
                    const glyph = () => {
                      const x = e();
                      if (!x) return r === c.id ? "·" : "";
                      return x.both ? "↔" : x.from === r ? "→" : "←";
                    };
                    return (
                      <td
                        {...stylex.attrs(
                          s.cell,
                          c.start && s.groupStart,
                          (hot().r === r || hot().c === c.id) && s.cross,
                          e() && s.cellOn,
                          e() && textOf(e()?.change ?? "unchanged"),
                        )}
                        onMouseEnter={() => {
                          setHot({ r, c: c.id });
                          const x = e();
                          props.api.hoverEdge(x?.key ?? null, x?.edges.map((y) => y.id));
                        }}
                        onMouseLeave={() => props.api.hoverEdge(null)}
                        onClick={() => {
                          const x = e();
                          if (x) props.api.selectEdges(x.edges.map((y) => y.id));
                        }}
                      >
                        {glyph()}
                      </td>
                    );
                  }}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Clusters: a few blocks; open one in place and the lines re-fold around it.

function Clusters(props: { m: Model; view: View; api: Api }) {
  const m = props.m;
  const vs = createMemo(() => new Map(props.view.nodes.map((v) => [v.node.id, v])));
  const keyOf = (v: VisNode) =>
    v.node.kind === "actor" ? "People and callers" : m.isUsed(v.node.id) && !v.touched ? (props.api.groupOf(v.node.id) ?? "Outside systems") : v.touched ? "Changed by this PR" : "Not changed";
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const [moving, setMoving] = createSignal(false);
  /** What the reader clicked, so the canvas can keep it where it was on screen. */
  let anchor: { opening: boolean; k: string } | null = null;
  /** The block being opened or folded while its layout runs: answered at once, before ELK is done. */
  const [busy, setBusy] = createSignal<string | null>(null);
  const toggle = (k: string) => {
    anchor = { opening: !open().has(k), k };
    setBusy(k);
    setMoving(true);
    setOpen((o) => {
      const n = new Set(o);
      if (!n.delete(k)) n.add(k);
      return n;
    });
  };
  const CL = "cl:";
  const keys = createMemo(() => [...new Set([...vs().values()].map(keyOf))].sort());
  /**
   * Every part and every block stays mounted, in a fixed order, whether shown or not: a hidden part
   * sits on its folded block, a hidden block on its open box. Each change is then only a new target
   * that CSS glides to from wherever things are, so nothing pops in.
   */
  const everything = createMemo(() => [...[...vs().keys()].sort(), ...keys().map((k) => `${CL}${k}`)]);
  const shown = createMemo(() => {
    const members = new Map<string, string[]>();
    const rep = new Map<string, string>();
    for (const v of vs().values()) {
      const k = keyOf(v);
      members.set(k, [...(members.get(k) ?? []), v.node.id]);
      rep.set(v.node.id, open().has(k) ? v.node.id : `${CL}${k}`);
    }
    const links = new Map<string, { key: string; from: string; to: string; edges: VisEdge[] }>();
    for (const e of props.view.edges) {
      const a = rep.get(e.from), b = rep.get(e.to);
      if (!a || !b || a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      const l = links.get(key) ?? { key, from: a, to: b, edges: [] };
      l.edges.push(e);
      links.set(key, l);
    }
    const ids = [...new Set(rep.values())];
    const groups = new Map<string, string>();
    for (const [id, r] of rep) if (r === id) groups.set(id, keyOf(vs().get(id)!));
    return { ids, links: [...links.values()], members, groups, rep };
  });
  const visible = createMemo(() => new Set(shown().ids));

  type R = { x: number; y: number; w: number; h: number };
  const [laid, setLaid] = createSignal<Laid | null>(null);
  /** Set once, on the first layout, and kept: opening a block grows the drawing, it never re-zooms. */
  const [scale, setScale] = createSignal<number | null>(null);
  const [pos, setPos] = createSignal(new Map<string, { x: number; y: number }>());
  const [boxAt, setBoxAt] = createSignal(new Map<string, R>());
  /** Off for the first placement, so nothing glides in from the corner on load. */
  const [ready, setReady] = createSignal(false);
  let wrap: HTMLDivElement | undefined;
  const scroller = () => {
    let box = wrap?.parentElement ?? null;
    while (box && !/auto|scroll/.test(getComputedStyle(box).overflow)) box = box.parentElement;
    return box;
  };
  let ticket = 0;
  createEffect(
    () => shown(),
    (sh) => {
      const mine = ++ticket;
      const count = (l: { edges: VisEdge[] }) => l.edges.reduce((n, e) => n + e.edges.length, 0);
      void layout(
        sh.ids,
        sh.links.map((l) => ({ key: l.key, from: l.from, to: l.to, label: `${count(l)}` })),
        undefined,
        sh.groups,
      ).then((at) => {
        if (mine !== ticket) return;
        const sc = scale() ?? Math.min(1, ((wrap?.clientWidth ?? 800) - 8) / at.width);
        if (scale() === null) setScale(sc);
        const boxes = new Map(at.boxes.map((b) => [b.value, { x: b.x, y: b.y, w: b.w, h: b.h }]));
        // Targets for everything: shown things where ELK put them, a hidden part on its block, a
        // hidden block on (the top of) its box, a folded box shrunk onto its block.
        const target = new Map<string, { x: number; y: number }>();
        for (const id of everything()) {
          const p = at.at.get(id);
          if (p) target.set(id, p);
          else if (id.startsWith(CL)) {
            const b = boxes.get(id.slice(CL.length));
            if (b) target.set(id, { x: b.x, y: b.y });
          } else {
            const blockAt = at.at.get(sh.rep.get(id) ?? "");
            if (blockAt) target.set(id, blockAt);
          }
        }
        const boxTarget = new Map<string, R>();
        for (const k of keys()) {
          const b = boxes.get(k);
          const blockAt = at.at.get(`${CL}${k}`);
          if (b) boxTarget.set(k, b);
          else if (blockAt) boxTarget.set(k, { x: blockAt.x, y: blockAt.y, w: NODE_W, h: NODE_H });
        }
        // Keep what was clicked where it was on screen: scroll by however far it moves, once the
        // drawing has grown to make room for the scroll.
        const k = anchor?.k;
        const before = anchor && pos().size ? (anchor.opening ? pos().get(`${CL}${k}`) : boxAt().get(k!)) : undefined;
        const after = anchor ? (anchor.opening ? boxTarget.get(k!) : target.get(`${CL}${k}`)) : undefined;
        anchor = null;
        setMoving(true);
        setLaid(at);
        setPos(target);
        setBoxAt(boxTarget);
        setBusy(null);
        // Scroll in step with the glide (same duration and curve as the CSS), so what was clicked
        // stays still on screen while everything else moves around it.
        const el = scroller();
        if (before && after && el) {
          const x0 = el.scrollLeft, y0 = el.scrollTop;
          const dx = (after.x - before.x) * sc, dy = (after.y - before.y) * sc;
          const t0 = performance.now();
          const frame = (now: number) => {
            const t = Math.min(1, (now - t0) / 500);
            const e = glideCurve(t);
            el.scrollTo(x0 + dx * e, y0 + dy * e);
            if (t < 1) requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }
        setTimeout(() => mine === ticket && setMoving(false), 520);
        if (!ready()) requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
      });
    },
  );
  const [lit, setLit] = createSignal<string | null>(null);
  return (
    <div ref={wrap} {...stylex.attrs(s.wrap)}>
      <div {...stylex.attrs(s.trail)}>
        <span {...stylex.attrs(s.small)}>Click a block to open it in place; click an open block's title to fold it. Numbers on lines count connections.</span>
      </div>
      <Show when={laid()}>
        {(l) => (
          <svg width={l().width * (scale() ?? 1)} height={l().height * (scale() ?? 1)} viewBox={`0 0 ${l().width} ${l().height}`} {...stylex.attrs(cl.svg)}>
            {/* Group boxes: one per block, always mounted; folded, it sits on its block, unseen. */}
            <For each={keys()}>
              {(k) => {
                const b = () => boxAt().get(k);
                const isOpen = () => open().has(k);
                return (
                  <g
                    style={{ "--x": `${b()?.x ?? 0}px`, "--y": `${b()?.y ?? 0}px`, "--bw": `${b()?.w ?? NODE_W}px`, "--bh": `${b()?.h ?? NODE_H}px` }}
                    {...stylex.attrs(cl.place, ready() ? cl.glide : null, s.click, isOpen() ? null : cl.gone)}
                    onClick={() => toggle(k)}
                  >
                    <rect rx={10} {...stylex.attrs(s.box, cl.boxSize)} />
                    <text x={12} y={22} {...stylex.attrs(s.svgTitle)}>
                      {busy() === k ? `${k} · folding…` : `${k} ▾ fold`}
                    </text>
                  </g>
                );
              }}
            </For>
            {/* Lines: out of the way while things move, back once they've settled. */}
            <Show keyed when={moving() ? null : l()}>
              {(ll) => (
                <g {...stylex.attrs(cl.linesIn)}>
                  <For each={shown().links}>
                    {(k) => {
                      const r = ll.routes.get(k.key);
                      if (!r) return null;
                      const n = k.edges.reduce((a, e) => a + e.edges.length, 0);
                      const ch = (): Change => (k.edges.some((e) => e.change !== "unchanged") ? (k.edges.every((e) => e.change === "added") ? "added" : "modified") : "unchanged");
                      const on = () => !lit() || k.from === lit() || k.to === lit();
                      return (
                        <g
                          onMouseEnter={() => props.api.hoverEdge(k.key, k.edges.flatMap((e) => e.edges.map((x) => x.id)))}
                          onMouseLeave={() => props.api.hoverEdge(null)}
                          onClick={() => props.api.selectEdges(k.edges.flatMap((e) => e.edges.map((x) => x.id)))}
                          {...stylex.attrs(on() ? null : s.faded)}
                        >
                          <path d={r.d} stroke-width={1.3 + Math.log2(n) * 1.1} {...stylex.attrs(s.line, strokeOf(ch()))} />
                          <path d={arrow(r.end)} {...stylex.attrs(fillOf(ch()))} />
                          <path d={r.d} {...stylex.attrs(s.hit)} />
                          <Show when={r.label}>
                            {(b) => (
                              <text x={b().x + 6} y={b().y + b().h - 4} {...stylex.attrs(s.svgSmall)}>
                                {n}
                              </text>
                            )}
                          </Show>
                        </g>
                      );
                    }}
                  </For>
                </g>
              )}
            </Show>
            <For each={everything()}>
              {(id) => {
                const p = () => pos().get(id) ?? { x: 0, y: 0 };
                const isBlock = id.startsWith(CL);
                const k = isBlock ? id.slice(CL.length) : "";
                const ms = () => shown().members.get(k) ?? [];
                const changed = () => ms().filter((x) => vs().get(x)?.touched).length;
                const v = () => vs().get(id);
                const ch = (): Change => (isBlock ? (changed() ? "modified" : "unchanged") : changeIn(vs(), id));
                return (
                  <g
                    style={{ "--x": `${p().x}px`, "--y": `${p().y}px` }}
                    {...stylex.attrs(cl.place, ready() ? cl.glide : null, s.click, visible().has(id) ? null : cl.gone)}
                    onClick={() => (isBlock ? toggle(k) : props.api.select(id))}
                    onDblClick={() => !isBlock && props.api.open(id)}
                    onMouseEnter={() => (setLit(id), isBlock ? null : props.api.hoverNode(id))}
                    onMouseLeave={() => (setLit(null), props.api.hoverNode(null))}
                  >
                    <Show when={isBlock}>
                      <rect x={8} y={-8} width={NODE_W} height={NODE_H} rx={7} {...stylex.attrs(s.stackBack)} />
                      <rect x={4} y={-4} width={NODE_W} height={NODE_H} rx={7} {...stylex.attrs(s.stackBack)} />
                    </Show>
                    <rect width={NODE_W} height={NODE_H} rx={7} {...stylex.attrs(s.node, strokeOf(ch()), props.api.selected() === id && picked.on)} />
                    <rect width={7} height={NODE_H} {...stylex.attrs(fillOf(ch()))} />
                    <text x={18} y={20} {...stylex.attrs(s.svgSmall, textOf(ch()))}>
                      {isBlock ? (busy() === k ? "opening…" : `${ms().length} parts${changed() ? ` · ${changed()} changed` : ""} · click to open`) : v() ? headline(m, v()!) : ""}
                    </text>
                    <text x={18} y={44} {...stylex.attrs(s.svgText)}>
                      {isBlock ? k : m.name(id)}
                    </text>
                  </g>
                );
              }}
            </For>
          </svg>
        )}
      </Show>
    </div>
  );
}
// ---------------------------------------------------------------------------------------------
// 5. Rings: how far the change reaches. Lines only for the part under the pointer or selected.

function Rings(props: { m: Model; view: View; api: Api }) {
  const m = props.m;
  const vs = createMemo(() => new Map(props.view.nodes.map((v) => [v.node.id, v])));
  const [hover, setHover] = createSignal<string | null>(null);
  const PW = 156, PH = 28;
  const g = createMemo(() => {
    // Steps from the change, over the connections, either direction.
    const dist = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const e of props.view.edges) {
      adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
      adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
    }
    let frontier = [...vs().values()].filter((v) => v.touched && v.node.kind !== "actor").map((v) => v.node.id);
    frontier.forEach((id) => dist.set(id, 0));
    for (let d = 1; frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) for (const o of adj.get(id) ?? []) if (!dist.has(o)) (dist.set(o, d), next.push(o));
      frontier = next;
    }
    const RINGS = ["changed", "one step from a change", "two steps", "further, or not connected"];
    const rings: string[][] = [[], [], [], []];
    for (const id of vs().keys()) rings[Math.min(3, dist.get(id) ?? 3)]!.push(id);
    // Radii: room for every pill round its ring.
    const radii: number[] = [];
    let r = 0;
    rings.forEach((ids, i) => {
      const need = (ids.length * (PW + 14)) / (2 * Math.PI);
      r = Math.max(i === 0 ? 120 : r + 150, need);
      radii.push(r);
    });
    // Angles: the change in name order; each outer ring ordered by where its neighbours inside sit.
    const angle = new Map<string, number>();
    rings.forEach((ids, i) => {
      const keyed = ids.map((id) => {
        if (i === 0) return { id, k: m.name(id) as string | number };
        const inner = (adj.get(id) ?? []).map((o) => angle.get(o)).filter((a): a is number => a !== undefined);
        if (!inner.length) return { id, k: 10 + m.name(id).charCodeAt(0) / 100 };
        const sx = inner.reduce((a, t) => a + Math.cos(t), 0), sy = inner.reduce((a, t) => a + Math.sin(t), 0);
        return { id, k: (Math.atan2(sy, sx) + 2 * Math.PI) % (2 * Math.PI) };
      });
      keyed.sort((a, b) => (typeof a.k === "string" ? String(a.k).localeCompare(String(b.k)) : (a.k as number) - (b.k as number)));
      keyed.forEach((x, j) => angle.set(x.id, (j / Math.max(1, keyed.length)) * 2 * Math.PI - Math.PI / 2));
    });
    const R = radii[3]! + PW;
    const at = new Map<string, { x: number; y: number }>();
    rings.forEach((ids, i) => ids.forEach((id) => at.set(id, { x: R + Math.cos(angle.get(id)!) * radii[i]!, y: R + Math.sin(angle.get(id)!) * radii[i]! })));
    return { rings, RINGS, radii, at, size: 2 * R, centre: R, dist };
  });
  const active = () => hover() ?? props.api.selected();
  const near = createMemo(() => {
    const a = active();
    const out = new Set<string>(a ? [a] : []);
    if (a) for (const e of props.view.edges) if (e.from === a || e.to === a) (out.add(e.from), out.add(e.to));
    return out;
  });
  return (
    <div {...stylex.attrs(s.wrap)}>
      <div {...stylex.attrs(s.trail)}>
        <span {...stylex.attrs(s.small)}>
          Changed parts in the middle, then one and two steps out. Point at or select a part to see its connections; double-click to open it.
        </span>
      </div>
      <svg width={g().size} height={g().size}>
        {/* Open on the middle: the changed parts, at full size so their names stay readable. */}
        <circle
          ref={(el) =>
            requestAnimationFrame(() => {
              // Scroll only the canvas (the nearest scrolling box), never the page.
              let box = el.parentElement;
              const scrolls = (e: HTMLElement) => /auto|scroll/.test(getComputedStyle(e).overflow);
              while (box && !scrolls(box)) box = box.parentElement;
              if (!box) return;
              const r = el.getBoundingClientRect(), b = box.getBoundingClientRect();
              box.scrollTo(box.scrollLeft + r.left - b.left - box.clientWidth / 2, box.scrollTop + r.top - b.top - box.clientHeight / 2);
            })
          }
          cx={g().centre}
          cy={g().centre}
          r={1}
          fill="none"
        />
        <For each={g().radii}>
          {(r, i) => (
            <>
              <circle cx={g().centre} cy={g().centre} r={r} {...stylex.attrs(s.ring)} />
              <text x={g().centre + 8} y={g().centre - r - 18} {...stylex.attrs(s.svgTitle)}>
                {g().RINGS[i()]} ({g().rings[i()]!.length})
              </text>
            </>
          )}
        </For>
        <Show keyed when={active()}>
          {(a) => (
            <g {...stylex.attrs(s.fadeIn)}>
              <For each={props.view.edges.filter((e) => e.from === a || e.to === a)}>
                {(e) => {
                  const p = g().at.get(e.from)!, q = g().at.get(e.to)!;
                  // Bend towards the middle, so a line between two parts on one ring doesn't cut across the others.
                  const cx = (p.x + q.x) / 2 + (g().centre - (p.x + q.x) / 2) * 0.35;
                  const cy = (p.y + q.y) / 2 + (g().centre - (p.y + q.y) / 2) * 0.35;
                  const d = `M${p.x},${p.y} Q${cx},${cy} ${q.x},${q.y}`;
                  return (
                    <g onClick={() => props.api.selectEdges(e.edges.map((x) => x.id))} onMouseEnter={() => props.api.hoverEdge(e.key, e.edges.map((x) => x.id))} onMouseLeave={() => props.api.hoverEdge(null)}>
                      <path d={d} stroke-width={1.6 + Math.log2(e.edges.length)} {...stylex.attrs(s.line, strokeOf(e.change))} />
                      <path d={d} {...stylex.attrs(s.hit)} />
                    </g>
                  );
                }}
              </For>
            </g>
          )}
        </Show>
        <For each={[...g().at.entries()]}>
          {([id, p]) => {
            return (
              <g
                transform={`translate(${p.x - PW / 2},${p.y - PH / 2})`}
                {...stylex.attrs(s.click, active() === null || near().has(id) ? null : s.faded)}
                onMouseEnter={() => (setHover(id), props.api.hoverNode(id))}
                onMouseLeave={() => (setHover(null), props.api.hoverNode(null))}
                onClick={() => props.api.select(id)}
                onDblClick={() => props.api.open(id)}
              >
                <rect width={PW} height={PH} rx={PH / 2} {...stylex.attrs(s.pill, strokeOf(changeIn(vs(), id)), props.api.selected() === id && picked.on)} />
                <circle cx={13} cy={PH / 2} r={4.5} {...stylex.attrs(fillOf(changeIn(vs(), id)))} />
                <text x={24} y={PH / 2 + 4.5} {...stylex.attrs(s.svgText)} font-size="12">
                  {m.name(id).length > 19 ? `${m.name(id).slice(0, 18)}…` : m.name(id)}
                </text>
              </g>
            );
          }}
        </For>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 6. Path: Columns' mechanics drawn as Neighbourhood's cards and lines. Columns stay where they
// are; picking a part adds the next column beside it, picking in an earlier column cuts back to
// there. Each new column starts level with the part it came from, so the path reads as a
// staircase of short lines. Parts already explored keep a mark.

function Path(props: { m: Model; view: View; api: Api }) {
  const m = props.m;
  const vs = createMemo(() => new Map(props.view.nodes.map((v) => [v.node.id, v])));
  const [path, setPath] = createSignal<string[]>([]);
  const [seen, setSeen] = createSignal<Set<string>>(new Set());
  const CW = 232, CH = 54, GAP = 8, COLGAP = 120, HEAD = 26;
  type Row = { key: string; kind: "head"; text: string } | { key: string; kind: "item"; id: string; via?: string; change?: Change | "mixed"; dir?: string };
  /** Each column's rows: column 0 is everything, grouped; column k lists what path[k-1] connects to. */
  const columns = createMemo(() => {
    const sortV = (a: VisNode, b: VisNode) => m.name(a.node.id).localeCompare(m.name(b.node.id));
    const all = [...vs().values()];
    const first: Row[] = [];
    for (const [title, items] of [
      ["Changed by this PR", all.filter((v) => v.touched && v.node.kind !== "actor")],
      ["People and callers", all.filter((v) => v.node.kind === "actor")],
      ["Not changed", all.filter((v) => !v.touched && !m.isUsed(v.node.id) && v.node.kind !== "actor")],
      ["Outside systems and stores", all.filter((v) => !v.touched && m.isUsed(v.node.id))],
    ] as const) {
      if (!items.length) continue;
      first.push({ key: `h:${title}`, kind: "head", text: `${title} (${items.length})` });
      for (const v of [...items].sort(sortV)) first.push({ key: `0:${v.node.id}`, kind: "item", id: v.node.id });
    }
    const cols: Row[][] = [first];
    const sort = byChangeThenName(m, vs());
    path().forEach((id, k) => {
      const ns = neighbours(props.view, id);
      const out = ns.filter((n) => n.dir !== "in").sort((a, b) => sort(a.other, b.other));
      const inn = ns.filter((n) => n.dir === "in").sort((a, b) => sort(a.other, b.other));
      const rows: Row[] = [];
      const col = k + 1;
      if (out.length) {
        rows.push({ key: `${col}:h:out`, kind: "head", text: `${m.name(id)} uses or sends to (${out.length})` });
        for (const n of out) rows.push({ key: `${col}:${id}:${n.other}`, kind: "item", id: n.other, via: `${n.dir === "both" ? "↔" : "→"} ${bundleText(n.e)}`, change: n.e.change, dir: n.dir });
      }
      if (inn.length) {
        rows.push({ key: `${col}:h:in`, kind: "head", text: `Uses ${m.name(id)} or sends to it (${inn.length})` });
        for (const n of inn) rows.push({ key: `${col}:${id}:${n.other}`, kind: "item", id: n.other, via: `← ${bundleText(n.e)}`, change: n.e.change, dir: "in" });
      }
      cols.push(rows);
    });
    return cols;
  });
  /** Where every row sits: columns side by side, each new one starting level with its parent. */
  const geo = createMemo(() => {
    const at = new Map<string, { x: number; y: number; col: number; row: Row }>();
    const tops: number[] = [];
    let height = 0;
    let parentY = 0;
    columns().forEach((rows, k) => {
      const x = k * (CW + COLGAP);
      const top = k === 0 ? 0 : Math.max(0, parentY - HEAD);
      tops.push(top);
      let y = top;
      for (const r of rows) {
        at.set(r.key, { x, y, col: k, row: r });
        y += r.kind === "head" ? HEAD : CH + GAP;
      }
      height = Math.max(height, y);
      const picked = path()[k];
      const hit = rows.find((r) => r.kind === "item" && r.id === picked);
      parentY = hit ? at.get(hit.key)!.y : top;
    });
    return { at, height: height + 40, width: columns().length * (CW + COLGAP), tops };
  });
  /** The picked card in column k (the one the next column hangs off). */
  const pickedKey = (k: number) => columns()[k]?.find((r) => r.kind === "item" && r.id === path()[k])?.key;

  let stage: HTMLDivElement | undefined;
  const scroller = () => {
    let box = stage?.parentElement ?? null;
    while (box && !/auto|scroll/.test(getComputedStyle(box).overflow)) box = box.parentElement;
    return box;
  };
  const pick = (k: number, id: string) => {
    setPath((p) => [...p.slice(0, k), id]);
    setSeen((s0) => new Set([...s0, id]));
    setTimeout(() => props.api.select(id), 380);
    // Bring the new column into view, smoothly, keeping the picked card on screen.
    requestAnimationFrame(() => {
      const el = scroller();
      if (!el || !stage) return;
      const g = geo();
      const k2 = Math.min(k + 1, g.tops.length - 1);
      const colRight = (k2 + 1) * (CW + COLGAP) - COLGAP + 24;
      const left = Math.max(0, stage.offsetLeft + colRight - el.clientWidth);
      const top = Math.max(0, stage.offsetTop + g.tops[k2]! - 60);
      el.scrollTo({ left: Math.max(left, Math.min(el.scrollLeft, stage.offsetLeft + k2 * (CW + COLGAP))), top, behavior: "smooth" });
    });
  };
  const count = (id: string) => props.view.edges.filter((e) => e.from === id || e.to === id).length;
  return (
    <div {...stylex.attrs(s.wrap)}>
      <div {...stylex.attrs(s.trail)}>
        <span {...stylex.attrs(s.small)}>Your path:</span>
        <Show when={path().length} fallback={<span {...stylex.attrs(s.small)}>pick a part to start</span>}>
          <For each={path()}>
            {(id, k) => (
              <button {...stylex.attrs(s.crumb, k() === path().length - 1 && s.crumbOn)} onClick={() => setPath((p) => p.slice(0, k() + 1))}>
                {m.name(id)}
              </button>
            )}
          </For>
        </Show>
        <span {...stylex.attrs(s.small)}>· click a card to follow it · click an earlier column to go back · ✓ explored · double-click to open</span>
      </div>
      <div ref={stage} style={{ "--w": `${geo().width}px`, "--h": `${geo().height}px` }} {...stylex.attrs(pth.stage)}>
        <svg width={geo().width} height={geo().height} {...stylex.attrs(pth.lines)}>
          {/* From each picked card, a trunk in the gap, a branch to every card of the next column. */}
          <For each={path().map((id, k) => `${k}:${id}`)}>
            {(kk) => {
              const k = Number(kk.split(":")[0]);
              const from = () => geo().at.get(pickedKey(k) ?? "");
              const kids = () => (columns()[k + 1] ?? []).filter((r): r is Extract<Row, { kind: "item" }> => r.kind === "item");
              return (
                <g {...stylex.attrs(pth.lineIn)}>
                  <For each={kids()}>
                    {(r) => {
                      const d = () => {
                        const f = from(), t = geo().at.get(r.key);
                        if (!f || !t) return "";
                        const y0 = f.y + CH / 2, y1 = t.y + CH / 2, x0 = f.x + CW, x1 = t.x, mid = x0 + COLGAP / 2;
                        const sy = Math.sign(y1 - y0);
                        if (sy === 0) return `M${x0},${y0} H${x1}`;
                        return `M${x0},${y0} H${mid - 6} Q${mid},${y0} ${mid},${y0 + sy * 6} V${y1 - sy * 6} Q${mid},${y1} ${mid + 6},${y1} H${x1}`;
                      };
                      return <PathLine d={d()} change={r.change ?? "unchanged"} />;
                    }}
                  </For>
                </g>
              );
            }}
          </For>
        </svg>
        <For each={[...geo().at.keys()]}>
          {(key) => {
            const g = () => geo().at.get(key);
            return (
              <Show when={g()}>
                {(gg) => {
                  const row = gg().row;
                  if (row.kind === "head") return <PathHead x={gg().x} y={gg().y} text={row.text} />;
                  return (
                    <PathCard
                      m={m}
                      api={props.api}
                      v={vs().get(row.id)}
                      id={row.id}
                      x={gg().x}
                      y={gg().y}
                      w={CW}
                      h={CH}
                      via={row.via}
                      viaChange={row.change ?? "unchanged"}
                      change={changeIn(vs(), row.id)}
                      onPath={path()[gg().col] === row.id}
                      seen={seen().has(row.id)}
                      count={count(row.id)}
                      onPick={() => pick(gg().col, row.id)}
                    />
                  );
                }}
              </Show>
            );
          }}
        </For>
      </div>
    </div>
  );
}
/** A line from a picked card to one of the next column's. */
function PathLine(props: { d: string; change: Change | "mixed" }) {
  return <path d={props.d} {...stylex.attrs(s.line, strokeOf(props.change))} />;
}
function PathHead(props: { x: number; y: number; text: string }) {
  return (
    <div style={{ "--x": `${props.x}px`, "--y": `${props.y}px` }} {...stylex.attrs(pth.head, pth.enter)}>
      {props.text}
    </div>
  );
}
function PathCard(props: {
  m: Model;
  api: Api;
  v: VisNode | undefined;
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  via: string | undefined;
  viaChange: Change | "mixed";
  change: Change;
  onPath: boolean;
  seen: boolean;
  count: number;
  onPick: () => void;
}) {
  return (
    <div
      style={{ "--x": `${props.x}px`, "--y": `${props.y}px`, "--w": `${props.w}px`, "--hh": `${props.h}px` }}
      {...stylex.attrs(s.card, nb.sized, pth.enter, borderOf(props.change), props.onPath ? pth.onPath : null, props.api.selected() === props.id ? s.cardSel : null)}
      onClick={props.onPick}
      onDblClick={() => props.api.open(props.id)}
      onMouseEnter={() => props.api.hoverNode(props.id)}
      onMouseLeave={() => props.api.hoverNode(null)}
    >
      <div {...stylex.attrs(s.small, textOf(props.change))}>
        {props.v ? headline(props.m, props.v) : ""}
        <span {...stylex.attrs(pth.count)}>
          {props.seen ? "✓ " : ""}
          {props.count} ▸
        </span>
      </div>
      <div {...stylex.attrs(s.name)}>{props.m.name(props.id)}</div>
      <Show when={props.via}>
        <div {...stylex.attrs(s.via, textOf(props.viaChange))}>{props.via}</div>
      </Show>
    </div>
  );
}
const slideIn = stylex.keyframes({ from: { opacity: 0, translate: "-18px 0" }, to: { opacity: 1, translate: "0 0" } });
const pth = stylex.create({
  stage: { height: "var(--h)", position: "relative", width: "var(--w)" },
  lines: { left: 0, position: "absolute", top: 0 },
  lineIn: { animationDelay: "120ms", animationDuration: "260ms", animationFillMode: "both", animationName: linesAppear },
  enter: { animationDuration: "260ms", animationFillMode: "both", animationName: slideIn },
  head: { color: colors.muted, fontSize: 11, fontWeight: 650, left: 0, letterSpacing: "0.04em", position: "absolute", textTransform: "uppercase", top: 0, transform: "translate(var(--x), calc(var(--y) + 8px))", whiteSpace: "nowrap" },
  onPath: { backgroundColor: colors.selected, borderWidth: 2.5 },
  count: { color: colors.muted, float: "right" },
});
