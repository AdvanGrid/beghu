// PROTOTYPE (PR view, #163): the layout lab. Two panes side by side, each laying out the same
// locked top level (version A's input: people, the changed group, the unchanged group, outside
// systems; parts with no lines hidden; no line labels) with an engine of its own: ELK as the
// prototype runs it (with its fix-ups), or own-layout.ts's Lanes and Highway. Each pane says how
// long its layout took and counts crossings, bends and length the same way.
// Open /prototype-pr-view/lab.html?a=<name>; the made-up calls in data/overlays/ are laid over
// the analysis unless ?overlay=0.
import { render } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import * as stylex from "@stylexjs/stylex";
import { colors, fonts } from "../src/tokens.stylex.ts";
import { pal } from "./tokens.stylex.ts";
import { arrow, layout, NODE_H, NODE_W, rounded } from "./layout.ts";
import { measure, ownLayout, tidy, type LNode, type Mode, type P, type Trunk } from "./own-layout.ts";
import type { Analysis, Edge } from "./schema.ts";
import { input, type Input } from "./lab-input.ts";

const loaders = import.meta.glob<Analysis>("./data/*.json", { import: "default" });
const overlays = import.meta.glob<{ edges: Edge[] }>("./data/overlays/*.json", { import: "default" });
const params = new URLSearchParams(location.search);
const name = params.get("a") ?? "AdvanGrid-advangrid-2627";

type Engine = "elk" | Mode;
type Look = "split" | "popover" | "ribbon";
type Merge = "line" | "trunks" | "stretch";
const MERGES: { id: Merge; name: string }[] = [
  { id: "line", name: "Merge: lines (share of the line)" },
  { id: "trunks", name: "Merge: trunks too (share of the trunk)" },
  { id: "stretch", name: "Merge: per stretch (≥ local gutters)" },
];
const ENGINES: { id: Engine; name: string }[] = [
  { id: "elk", name: "ELK (as prototyped, with fix-ups)" },
  { id: "lanes", name: "Lanes" },
  { id: "pull", name: "Highway: pull together" },
  { id: "found", name: "Highway: merge as found" },
  { id: "street", name: "Highway: street routing" },
];
const LOOKS: { id: Look; name: string }[] = [
  { id: "split", name: "Thick, splits on focus" },
  { id: "popover", name: "Thick, lines in a card" },
  { id: "ribbon", name: "Tight strands" },
];

const num = (k: string, d: number) => {
  const v = Number(params.get(k));
  return params.has(k) && Number.isFinite(v) ? v : d;
};
const [threshold, setThreshold] = createSignal(num("thr", 0.8));
const [minGutters, setMinGutters] = createSignal(num("min", 3));
const [width, setWidth] = createSignal(num("w", 0));
const [reach, setReach] = createSignal(num("reach", 6));
const [close, setClose] = createSignal(num("close", 34));
const [rounds, setRounds] = createSignal(num("rounds", 1));
const [discount, setDiscount] = createSignal(num("disc", 0.85));
const [bendCost, setBendCost] = createSignal(num("bend", 40));
const sync = (k: string, v: string | number | null) => {
  const p = new URLSearchParams(location.search);
  if (v === null || v === "") p.delete(k);
  else p.set(k, String(v));
  history.replaceState(null, "", `?${p}`);
};

// ---------------------------------------------------------------------------------------------
// The input: version A's top level.

// ---------------------------------------------------------------------------------------------
// One drawing, whichever engine made it. Routes run in each line's real direction.

interface Drawn {
  at: Map<string, P>;
  frames: { key: string; kind: "S" | "C" | "U"; x: number; y: number; w: number; h: number }[];
  routes: Map<string, P[]>;
  trunks: Trunk[];
  rides: Map<string, string[]>;
  /** Lines laid to → from (their trunk runs the other way). */
  flipped: Set<string>;
  width: number;
  height: number;
  ms: number;
  stats: { crossings: number; bends: number; length: number };
}

async function draw(inp: Input, engine: Engine, merge: Merge): Promise<Drawn> {
  const t0 = performance.now();
  if (engine === "elk") {
    const ids = inp.nodes.map((n) => n.id);
    const inner = inp.nodes.filter((n) => inp.side.get(n.id) === 1 || inp.side.get(n.id) === 2);
    const l = await layout(
      ids,
      inp.lines.map((x) => ({ key: x.key, from: x.from, to: x.to, label: "", reverse: inp.side.get(x.from)! > inp.side.get(x.to)! })),
      new Set(inner.map((n) => n.id)),
      undefined,
      false,
      new Map(inner.map((n) => [n.id, inp.side.get(n.id) === 1 ? ("C" as const) : ("U" as const)])),
      "RIGHT",
    );
    const ms = performance.now() - t0;
    const routes = new Map([...l.routes].map(([k, r]) => [k, r.pts]));
    return {
      at: l.at,
      frames: [...(l.group ? [{ key: "S", kind: "S" as const, ...l.group }] : []), ...l.regions.map((r) => ({ key: r.key, kind: r.key, x: r.x, y: r.y, w: r.w, h: r.h }))],
      routes,
      trunks: [],
      rides: new Map(),
      flipped: new Set(),
      width: l.width,
      height: l.height,
      ms,
      stats: measure(routes),
    };
  }
  const nodes: LNode[] = inp.nodes.map((n) => ({ id: n.id, side: inp.side.get(n.id)!, w: NODE_W, h: NODE_H }));
  const o = ownLayout(
    nodes,
    inp.lines.map((x) => ({ key: x.key, from: x.from, to: x.to })),
    { mode: engine, merge, threshold: threshold(), minGutters: minGutters(), width: width() || undefined, reach: reach(), close: close(), rounds: rounds(), discount: discount(), bend: bendCost(), undip: params.get("undip") !== "0" },
  );
  const ms = performance.now() - t0;
  // Real direction: a line laid to → from runs backwards.
  const routes = new Map([...o.routes].map(([k, pts]) => [k, o.flipped.has(k) ? [...pts].reverse() : pts]));
  const frames: Drawn["frames"] = o.regions.map((r) => ({ ...r, kind: r.key }));
  if (frames.length) {
    const x0 = Math.min(...frames.map((f) => f.x)) - 12, x1 = Math.max(...frames.map((f) => f.x + f.w)) + 12;
    const y1 = Math.max(...frames.map((f) => f.y + f.h)) + 12;
    frames.unshift({ key: "S", kind: "S", x: x0, y: 8, w: x1 - x0, h: y1 - 8 });
  }
  return { at: o.at, frames, routes, trunks: o.trunks, rides: o.rides, flipped: o.flipped, width: o.width, height: o.height + 12, ms, stats: measure(routes, o.rides) };
}

// ---------------------------------------------------------------------------------------------
// Strands: a trunk's members drawn side by side inside it.

const on = (a: P, b: P, t: P[]) =>
  t.slice(1).some((q, i) => {
    const p = t[i]!;
    if (Math.abs(p.y - q.y) < 0.5 && Math.abs(a.y - p.y) < 0.5 && Math.abs(b.y - p.y) < 0.5)
      return Math.min(a.x, b.x) >= Math.min(p.x, q.x) - 0.5 && Math.max(a.x, b.x) <= Math.max(p.x, q.x) + 0.5;
    if (Math.abs(p.x - q.x) < 0.5 && Math.abs(a.x - p.x) < 0.5 && Math.abs(b.x - p.x) < 0.5)
      return Math.min(a.y, b.y) >= Math.min(p.y, q.y) - 0.5 && Math.max(a.y, b.y) <= Math.max(p.y, q.y) + 0.5;
    return false;
  });

/** The route with the trunks' ends cut into it, so the parts on a trunk can be offset alone. */
function cut(pts: P[], ts: P[][]): P[] {
  const ends = ts.flatMap((t) => [t[0]!, t[t.length - 1]!]);
  const out: P[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1]!, pts[i]!];
    const inner = ends
      .filter((e) => (Math.abs(a.y - b.y) < 0.5 && Math.abs(e.y - a.y) < 0.5 && e.x > Math.min(a.x, b.x) + 0.5 && e.x < Math.max(a.x, b.x) - 0.5) || (Math.abs(a.x - b.x) < 0.5 && Math.abs(e.x - a.x) < 0.5 && e.y > Math.min(a.y, b.y) + 0.5 && e.y < Math.max(a.y, b.y) - 0.5))
      .sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
    out.push(...inner, b);
  }
  return out;
}

/** The route offset (to the left of travel) wherever it runs along one of the trunks, by that trunk's `o`. */
function strand(route: P[], ts: { t: P[]; o: number }[]): P[] {
  const pts = cut(route, ts.map((x) => x.t));
  const n = pts.length - 1;
  const segs = Array.from({ length: n }, (_, i) => {
    const [a, b] = [pts[i]!, pts[i + 1]!];
    const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
    const off = ts.find((x) => on(a, b, x.t))?.o ?? 0;
    return { nx: dy * off, ny: -dx * off };
  });
  const dir = (i: number) => Math.abs(pts[i + 1]!.y - pts[i]!.y) < 0.5;
  return pts.flatMap((p, i) => {
    const s1 = segs[i - 1], s2 = segs[i];
    if (!s1) return [{ x: p.x + s2!.nx, y: p.y + s2!.ny }];
    if (!s2) return [{ x: p.x + s1.nx, y: p.y + s1.ny }];
    // Same direction on both sides (where the line joins or leaves the trunk): a small step.
    if (dir(i - 1) === dir(i)) return [{ x: p.x + s1.nx, y: p.y + s1.ny }, { x: p.x + s2.nx, y: p.y + s2.ny }];
    // Two segments at right angles: each shifts the corner along its own normal.
    return [{ x: p.x + s1.nx + s2.nx, y: p.y + s1.ny + s2.ny }];
  });
}

// ---------------------------------------------------------------------------------------------

const s = stylex.create({
  page: { backgroundColor: colors.bg, color: colors.fg, display: "flex", flexDirection: "column", fontFamily: fonts.ui, fontSize: 13, height: "100vh", margin: 0 },
  bar: { alignItems: "center", borderBottom: `1px solid ${colors.line}`, display: "flex", flexWrap: "wrap", gap: 14, padding: "8px 12px" },
  title: { fontWeight: 650 },
  field: { alignItems: "center", display: "flex", gap: 6 },
  numIn: { backgroundColor: colors.bg, border: `1px solid ${colors.line}`, borderRadius: 4, color: colors.fg, padding: "2px 4px", width: 56 },
  select: { backgroundColor: colors.bg, border: `1px solid ${colors.line}`, borderRadius: 4, color: colors.fg, padding: "2px 4px" },
  panes: { display: "flex", flex: 1, minHeight: 0 },
  pane: { borderRight: `1px solid ${colors.line}`, display: "flex", flex: 1, flexDirection: "column", minWidth: 0, position: "relative" },
  head: { alignItems: "center", borderBottom: `1px solid ${colors.line}`, display: "flex", flexWrap: "wrap", gap: 10, padding: "6px 10px" },
  stats: { color: colors.muted, fontVariantNumeric: "tabular-nums" },
  scroll: { flex: 1, overflow: "auto" },
  btn: { backgroundColor: colors.bg, border: `1px solid ${colors.line}`, borderRadius: 4, color: colors.fg, cursor: "pointer", padding: "1px 8px" },
  frameS: { fill: "none", stroke: colors.line, strokeWidth: 1.5 },
  frameC: { fill: pal.modifiedTint, stroke: pal.modified, strokeWidth: 2 },
  frameU: { fill: colors.bgRaised, stroke: colors.muted, strokeDasharray: "6 4", strokeWidth: 1.5 },
  frameLabel: { fill: colors.muted, fontSize: 12, fontWeight: 650 },
  node: { fill: pal.nodeBg, strokeWidth: 1.5 },
  nodeHot: { strokeWidth: 3 },
  added: { stroke: pal.added },
  modified: { stroke: pal.modified },
  removed: { stroke: pal.removed },
  unchanged: { stroke: pal.unchanged },
  nodeName: { fill: colors.fg, fontSize: 13, fontWeight: 600, pointerEvents: "none" },
  nodeKind: { fill: colors.muted, fontSize: 11, pointerEvents: "none" },
  line: { fill: "none", stroke: pal.unchanged, strokeWidth: 1.5 },
  lineChanged: { stroke: pal.modified },
  lineDim: { opacity: 0.15 },
  lineHot: { stroke: colors.accent, strokeWidth: 2.5 },
  hit: { cursor: "pointer", fill: "none", pointerEvents: "stroke", stroke: "transparent", strokeWidth: 12 },
  head2: { fill: pal.unchanged },
  headHot: { fill: colors.accent },
  trunk: { fill: "none", opacity: 0.8, stroke: pal.unchanged, strokeLinecap: "butt", strokeLinejoin: "round", strokeWidth: "var(--tw)" },
  trunkHot: { opacity: 0.9, stroke: colors.accent },
  trunkHit: { cursor: "pointer", fill: "none", pointerEvents: "stroke", stroke: "transparent", strokeWidth: 18 },
  card: {
    backgroundColor: colors.bg,
    border: `1px solid ${colors.line}`,
    borderRadius: 6,
    boxShadow: `0 6px 20px ${colors.popShadow}`,
    left: "var(--x)",
    maxHeight: 320,
    overflow: "auto",
    padding: 6,
    position: "absolute",
    top: "var(--y)",
    width: 320,
    zIndex: 3,
  },
  cardHead: { color: colors.muted, fontSize: 11, padding: "2px 6px 6px" },
  row: { borderRadius: 4, cursor: "default", padding: "3px 6px" },
  rowHot: { backgroundColor: colors.hover },
});

function App(props: { inp: Input; overlay: number }) {
  return (
    <div {...stylex.attrs(s.page)}>
      <div {...stylex.attrs(s.bar)}>
        <span {...stylex.attrs(s.title)}>Layout lab</span>
        <span {...stylex.attrs(s.stats)}>
          {props.inp.nodes.length} parts, {props.inp.lines.length} lines ({props.overlay} made up)
        </span>
        <Num label="Share ≥" get={threshold} set={(v) => (setThreshold(v), sync("thr", v))} step={0.05} />
        <Num label="Local below (gutters)" get={minGutters} set={(v) => (setMinGutters(v), sync("min", v))} step={1} />
        <Num label="Parts per column (0 auto)" get={width} set={(v) => (setWidth(v), sync("w", v || null))} step={1} />
        <Num label="Pull reach (rows)" get={reach} set={(v) => (setReach(v), sync("reach", v))} step={1} />
        <Num label="Pull rounds" get={rounds} set={(v) => (setRounds(v), sync("rounds", v))} step={1} />
        <Num label="Street: shared costs ×" get={discount} set={(v) => (setDiscount(v), sync("disc", v))} step={0.05} />
        <Num label="Street: bend costs (px)" get={bendCost} set={(v) => (setBendCost(v), sync("bend", v))} step={10} />
        <Num label="Found: close (px)" get={close} set={(v) => (setClose(v), sync("close", v))} step={2} />
      </div>
      <div {...stylex.attrs(s.panes)}>
        <Pane inp={props.inp} id="l" initial="elk" />
        <Pane inp={props.inp} id="r" initial="pull" />
      </div>
    </div>
  );
}

function Num(props: { label: string; get: () => number; set: (v: number) => void; step: number }) {
  return (
    <label {...stylex.attrs(s.field)}>
      {props.label}
      <input type="number" step={props.step} value={props.get()} onChange={(e) => props.set(Number(e.currentTarget.value))} {...stylex.attrs(s.numIn)} />
    </label>
  );
}

function Pane(props: { inp: Input; id: "l" | "r"; initial: Engine }) {
  const inp = props.inp;
  const [engine, setEngine] = createSignal<Engine>((params.get(props.id) as Engine) ?? props.initial);
  const [look, setLook] = createSignal<Look>((params.get(`${props.id}look`) as Look) ?? "split");
  const [merge, setMerge] = createSignal<Merge>((params.get(`${props.id}merge`) as Merge) ?? "line");
  const [scale, setScale] = createSignal(num(`${props.id}z`, 0.5));
  const [drawn, setDrawn] = createSignal<Drawn | null>(null);
  const [hover, setHover] = createSignal<{ node?: string; line?: string; trunk?: string } | null>(null);
  const [card, setCard] = createSignal<{ trunk: Trunk; x: number; y: number } | null>(null);
  const [row, setRow] = createSignal<string | null>(null);
  let ticket = 0;
  createMemo(() => {
    const e = engine();
    const mg = merge();
    // Read the knobs so a change relays out.
    void [threshold(), minGutters(), width(), reach(), close(), rounds(), discount(), bendCost()];
    const mine = ++ticket;
    void draw(inp, e, mg).then((d) => mine === ticket && setDrawn(d));
  });
  const lineBy = new Map(inp.lines.map((l) => [l.key, l]));
  const nodeBy = new Map(inp.nodes.map((n) => [n.id, n]));
  /** The lines lit by what the pointer is on. */
  const lit = createMemo(() => {
    const h = hover();
    const r = row();
    const out = new Set<string>();
    if (r) out.add(r);
    if (h?.line) out.add(h.line);
    if (h?.node) for (const l of inp.lines) if (l.from === h.node || l.to === h.node) out.add(l.key);
    return out;
  });
  /** Trunks drawn as strands right now. */
  const opened = createMemo(() => {
    const d = drawn();
    const out = new Set<string>();
    if (!d) return out;
    if (look() === "ribbon") for (const t of d.trunks) out.add(t.key);
    if (look() === "split") {
      const h = hover();
      if (h?.trunk) out.add(h.trunk);
      for (const k of lit()) {
        for (const t of d.rides.get(k) ?? []) out.add(t);
      }
    }
    return out;
  });
  /** Each line's drawn points: offset into its strand when its trunk is open. */
  const shapes = createMemo(() => {
    const d = drawn();
    const out = new Map<string, P[]>();
    if (!d) return out;
    const open = opened();
    const trunkBy = new Map(d.trunks.map((t) => [t.key, t]));
    for (const [k, pts] of d.routes) {
      const ts = (d.rides.get(k) ?? []).filter((tk) => open.has(tk)).map((tk) => trunkBy.get(tk)!);
      if (!ts.length) {
        out.set(k, pts);
        continue;
      }
      // Members in the order they sit as they enter, 3 px apart across each trunk. Offset in laid
      // direction, so every member shifts to the same side of the trunk.
      const flip = d.flipped.has(k);
      const laid = strand(
        flip ? [...pts].reverse() : pts,
        ts.map((t) => ({ t: t.pts, o: (t.members.indexOf(k) - (t.members.length - 1) / 2) * 3 })),
      );
      out.set(k, tidy(flip ? laid.reverse() : laid));
    }
    return out;
  });

  return (
    <div {...stylex.attrs(s.pane)}>
      <div {...stylex.attrs(s.head)}>
        <select value={engine()} onChange={(e) => (setEngine(e.currentTarget.value as Engine), sync(props.id, e.currentTarget.value))} {...stylex.attrs(s.select)}>
          <For each={ENGINES}>{(x) => <option value={x.id}>{x.name}</option>}</For>
        </select>
        <Show when={engine() !== "elk" && engine() !== "lanes"}>
          <select value={look()} onChange={(e) => (setLook(e.currentTarget.value as Look), sync(`${props.id}look`, e.currentTarget.value), setCard(null))} {...stylex.attrs(s.select)}>
            <For each={LOOKS}>{(x) => <option value={x.id}>{x.name}</option>}</For>
          </select>
          <Show when={engine() !== "street"}>
          <select value={merge()} onChange={(e) => (setMerge(e.currentTarget.value as Merge), sync(`${props.id}merge`, e.currentTarget.value))} {...stylex.attrs(s.select)}>
            <For each={MERGES}>{(x) => <option value={x.id}>{x.name}</option>}</For>
          </select>
          </Show>
        </Show>
        <button {...stylex.attrs(s.btn)} onClick={() => (setScale((v) => Math.max(0.1, v / 1.25)), sync(`${props.id}z`, scale().toFixed(2)))}>
          −
        </button>
        <button {...stylex.attrs(s.btn)} onClick={() => (setScale((v) => Math.min(3, v * 1.25)), sync(`${props.id}z`, scale().toFixed(2)))}>
          +
        </button>
        <Show when={drawn()}>
          {(d) => (
            <span {...stylex.attrs(s.stats)}>
              {d().ms.toFixed(0)} ms · {Math.round(d().width)}×{Math.round(d().height)} · {d().stats.crossings} crossings · {d().stats.bends} bends ·{" "}
              {(d().stats.length / 1000).toFixed(1)}k length
              <Show when={d().trunks.length}>
                {" "}
                · {d().trunks.length} trunks carrying {d().rides.size} lines
              </Show>
            </span>
          )}
        </Show>
      </div>
      <div {...stylex.attrs(s.scroll)} onScroll={() => setCard(null)}>
        <Show when={drawn()}>
          {(d) => (
            <svg width={d().width * scale()} height={d().height * scale()} viewBox={`0 0 ${d().width} ${d().height}`} onMouseLeave={() => setHover(null)}>
              <For each={d().frames}>
                {(f) => (
                  <g>
                    <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={10} {...stylex.attrs(f.kind === "S" ? s.frameS : f.kind === "C" ? s.frameC : s.frameU)} />
                    <text x={f.x + 14} y={f.y + 26} {...stylex.attrs(s.frameLabel)}>
                      {f.kind === "S" ? "" : f.kind === "C" ? "Changed" : "Not changed"}
                    </text>
                  </g>
                )}
              </For>
              {/* Lines first, then trunks over them, then whatever is lit, then the parts. */}
              <For each={[...d().routes.keys()]}>
                {(k) => {
                  const l = lineBy.get(k)!;
                  const pts = () => shapes().get(k)!;
                  return (
                    <g>
                      <path d={rounded(pts())} {...stylex.attrs(s.line, l.change !== "unchanged" && s.lineChanged, lit().size > 0 && !lit().has(k) && s.lineDim)} />
                      <path d={arrow(tipOf(pts(), true))} {...stylex.attrs(s.head2, lit().size > 0 && !lit().has(k) && s.lineDim)} />
                      <Show when={l.both}>
                        <path d={arrow(tipOf(pts(), false))} {...stylex.attrs(s.head2, lit().size > 0 && !lit().has(k) && s.lineDim)} />
                      </Show>
                      <path d={rounded(pts())} {...stylex.attrs(s.hit)} onMouseEnter={() => setHover({ line: k })} onMouseLeave={() => setHover(null)} />
                    </g>
                  );
                }}
              </For>
              <For each={d().trunks}>
                {(t) => (
                  <Show when={!opened().has(t.key)}>
                    <path
                      d={rounded(t.pts)}
                      style={{ "--tw": `${t.width}px` }}
                      {...stylex.attrs(s.trunk, (card()?.trunk.key === t.key || hover()?.trunk === t.key) && s.trunkHot, lit().size > 0 && !t.members.some((m) => lit().has(m)) && s.lineDim)}
                    />
                  </Show>
                )}
              </For>
              <For each={d().trunks}>
                {(t) => (
                  <path
                    d={rounded(t.pts)}
                    {...stylex.attrs(s.trunkHit)}
                    onMouseEnter={(e) => {
                      setHover({ trunk: t.key });
                      if (look() === "popover") {
                        const box = (e.currentTarget.ownerSVGElement!.parentElement!.parentElement as HTMLElement).getBoundingClientRect();
                        setCard({ trunk: t, x: e.clientX - box.left + 12, y: e.clientY - box.top + 12 });
                      }
                    }}
                    onMouseLeave={() => look() !== "popover" && setHover(null)}
                  />
                )}
              </For>
              <For each={[...lit()]}>
                {(k) => {
                  const pts = () => shapes().get(k);
                  return (
                    <Show when={pts()}>
                      {(p) => (
                        <g>
                          <path d={rounded(p())} {...stylex.attrs(s.line, s.lineHot)} />
                          <path d={arrow(tipOf(p(), true))} {...stylex.attrs(s.headHot)} />
                        </g>
                      )}
                    </Show>
                  );
                }}
              </For>
              <For each={[...d().at]}>
                {([id, p]) => {
                  const n = nodeBy.get(id)!;
                  const ch = inp.side.get(id) === 1 && n.change === "unchanged" ? "modified" : n.change;
                  return (
                    <g onMouseEnter={() => setHover({ node: id })} onMouseLeave={() => setHover(null)}>
                      <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={8} {...stylex.attrs(s.node, s[ch], hover()?.node === id && s.nodeHot)} />
                      <text x={p.x + 12} y={p.y + 30} {...stylex.attrs(s.nodeName)}>
                        {n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name}
                      </text>
                      <text x={p.x + 12} y={p.y + 50} {...stylex.attrs(s.nodeKind)}>
                        {n.kind}
                      </text>
                    </g>
                  );
                }}
              </For>
            </svg>
          )}
        </Show>
      </div>
      <Show when={card()}>
        {(c) => (
          <div style={{ "--x": `${c().x}px`, "--y": `${c().y + 40}px` }} {...stylex.attrs(s.card)} onMouseLeave={() => (setCard(null), setRow(null), setHover(null))}>
            <div {...stylex.attrs(s.cardHead)}>{c().trunk.members.length} lines share this stretch</div>
            <For each={c().trunk.members}>
              {(k) => {
                const l = lineBy.get(k)!;
                return (
                  <div {...stylex.attrs(s.row, row() === k && s.rowHot)} onMouseEnter={() => setRow(k)} onMouseLeave={() => setRow(null)}>
                    {nodeBy.get(l.from)!.name} {l.both ? "↔" : "→"} {nodeBy.get(l.to)!.name}
                    <span {...stylex.attrs(s.stats)}> · {l.edges.length > 1 ? `${l.edges.length} connections` : l.edges[0]!.label}</span>
                  </div>
                );
              }}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

/** The arrowhead at a route's end (or start), pointing the way the line arrives. */
function tipOf(pts: P[], end: boolean) {
  const [a, b] = end ? [pts[pts.length - 2]!, pts[pts.length - 1]!] : [pts[1]!, pts[0]!];
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
  let overlay = 0;
  if (ov && params.get("overlay") !== "0") {
    const extra = (await ov()).edges;
    a.edges.push(...extra);
    overlay = extra.length;
  }
  const inp = input(a);
  render(() => <App inp={inp} overlay={overlay} />, document.getElementById("root")!);
}
void main();
