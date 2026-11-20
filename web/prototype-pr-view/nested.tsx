// PROTOTYPE (PR view, #166): our layout for nested blocks. Clusters on the analysis: the top level
// as locked, every block opens in place (click), and our layout lays each open block out inside
// by the same columns, packing and street routing (nested-layout.ts). The bar says how long it
// took, and after each open or fold how many of the other parts moved.
//
// Open /prototype-pr-view/nested.html?a=<name>. ?x=3 lays out a made-up graph three times the
// analysis's size (three copies, a quarter of each copy's lines crossing to the next). ?open=all
// starts fully open. ?labels=room|card picks where a line's count goes. ?touch=1 is the phone:
// a 390 px pane, no hover, trunks not tappable; tap a part to pick it, its lines are rows under
// the map, and a row lights the line's whole route.
import { render } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import * as stylex from "@stylexjs/stylex";
import { colors, fonts } from "../src/tokens.stylex.ts";
import { pal } from "./tokens.stylex.ts";
import { arrow, rounded } from "./layout.ts";
import { measure, tidy, type P } from "./own-layout.ts";
import { nestedLayout, type Nested, type SLine } from "./nested-layout.ts";
import type { Analysis, Change, Edge } from "./schema.ts";
import { grow, input, type Input } from "./nested-input.ts";

const loaders = import.meta.glob<Analysis>("./data/*.json", { import: "default" });
const overlays = import.meta.glob<{ edges: Edge[] }>("./data/overlays/*.json", { import: "default" });
const params = new URLSearchParams(location.search);
const name = params.get("a") ?? "AdvanGrid-advangrid-2627";
const sync = (k: string, v: string | null) => {
  const p = new URLSearchParams(location.search);
  if (v === null) p.delete(k);
  else p.set(k, v);
  history.replaceState(null, "", `?${p}`);
};

// ---------------------------------------------------------------------------------------------

const glide = 420;
const appear = stylex.keyframes({ from: { opacity: 0 }, to: { opacity: 1 } });
const s = stylex.create({
  page: { backgroundColor: colors.bg, color: colors.fg, display: "flex", flexDirection: "column", fontFamily: fonts.ui, fontSize: 13, height: "100vh", margin: 0 },
  bar: { alignItems: "center", borderBottom: `1px solid ${colors.line}`, display: "flex", flexWrap: "wrap", gap: 12, padding: "8px 12px" },
  title: { fontWeight: 650 },
  stats: { color: colors.muted, fontVariantNumeric: "tabular-nums" },
  moved: { color: colors.fg, fontVariantNumeric: "tabular-nums" },
  select: { backgroundColor: colors.bg, border: `1px solid ${colors.line}`, borderRadius: 4, color: colors.fg, padding: "2px 4px" },
  btn: { backgroundColor: colors.bg, border: `1px solid ${colors.line}`, borderRadius: 4, color: colors.fg, cursor: "pointer", padding: "1px 8px" },
  body: { display: "flex", flex: 1, justifyContent: "flex-start", minHeight: 0 },
  scroll: { flex: 1, overflow: "auto", position: "relative" },
  phone: { borderLeft: `1px solid ${colors.line}`, borderRight: `1px solid ${colors.line}`, display: "flex", flexDirection: "column", marginLeft: 24, width: 390 },
  phoneMap: { flex: 1, minHeight: 0, overflow: "auto", touchAction: "pan-x pan-y pinch-zoom" },
  drawer: { borderTop: `1px solid ${colors.line}`, maxHeight: "42%", overflow: "auto", padding: 8 },
  drawerHead: { color: colors.muted, fontSize: 12, padding: "2px 4px 6px" },
  frameC: { fill: pal.modifiedTint, stroke: pal.modified, strokeWidth: 2 },
  frameU: { fill: colors.bgRaised, stroke: colors.muted, strokeDasharray: "6 4", strokeWidth: 1.5 },
  frameLabel: { fill: colors.muted, fontSize: 12, fontWeight: 650 },
  box: { transform: "translate(var(--x), var(--y))", transition: `transform ${glide}ms cubic-bezier(.4,0,.2,1)` },
  boxRect: { height: "var(--h)", transition: `width ${glide}ms cubic-bezier(.4,0,.2,1), height ${glide}ms cubic-bezier(.4,0,.2,1)`, width: "var(--w)" },
  node: { cursor: "pointer", fill: pal.nodeBg, strokeWidth: 1.5 },
  open: { fill: "transparent", strokeWidth: 1.5 },
  nodeHot: { strokeWidth: 3 },
  picked: { stroke: colors.accent, strokeWidth: 3 },
  added: { stroke: pal.added },
  modified: { stroke: pal.modified },
  removed: { stroke: pal.removed },
  unchanged: { stroke: pal.unchanged },
  nodeName: { fill: colors.fg, fontSize: 13, fontWeight: 600, pointerEvents: "none" },
  nodeKind: { fill: colors.muted, fontSize: 11, pointerEvents: "none" },
  lines: { animationDelay: `${glide}ms`, animationDuration: "160ms", animationFillMode: "both", animationName: appear },
  line: { fill: "none", stroke: pal.unchanged, strokeWidth: 1.5 },
  lineChanged: { stroke: pal.modified },
  dim: { opacity: 0.15 },
  lineHot: { stroke: colors.accent, strokeWidth: 2.5 },
  hit: { cursor: "pointer", fill: "none", pointerEvents: "stroke", stroke: "transparent", strokeWidth: 12 },
  head2: { fill: pal.unchanged },
  headHot: { fill: colors.accent },
  count: { fill: colors.muted, fontSize: 10, fontVariantNumeric: "tabular-nums", fontWeight: 600, pointerEvents: "none" },
  countBg: { fill: colors.bg },
  trunk: { fill: "none", opacity: 0.8, stroke: pal.unchanged, strokeLinecap: "butt", strokeLinejoin: "round", strokeWidth: "var(--tw)" },
  trunkChanged: { stroke: pal.modified },
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
    position: "fixed",
    top: "var(--y)",
    width: 340,
    zIndex: 3,
  },
  cardHead: { alignItems: "center", color: colors.muted, display: "flex", fontSize: 11, gap: 8, padding: "2px 2px 6px 6px" },
  cardTitle: { flex: 1 },
  cardClose: { backgroundColor: "transparent", border: "none", borderRadius: 4, color: colors.muted, cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "2px 6px" },
  row: { borderRadius: 4, cursor: "pointer", padding: "5px 6px" },
  rowHot: { backgroundColor: colors.hover },
});

type Labels = "room" | "card";
const LABEL_ROOM = 30;

function App(props: { inp: Input; overlay: number; times: number }) {
  const inp = props.inp;
  const all = () => new Set(inp.nodes.filter((n) => inp.kids.get(n.id)?.length).map((n) => n.id));
  const [open, setOpen] = createSignal<Set<string>>(params.get("open") === "all" ? all() : new Set());
  const [labels, setLabels] = createSignal<Labels>((params.get("labels") as Labels) ?? "room");
  const [touch, setTouch] = createSignal(params.get("touch") === "1");
  const [scale, setScale] = createSignal(Number(params.get("z") ?? 0.5));
  const [stable, setStable] = createSignal(params.get("stable") !== "0");
  const [hover, setHover] = createSignal<{ node?: string; line?: string; trunk?: string } | null>(null);
  const [picked, setPicked] = createSignal<string | null>(null);
  const [row, setRow] = createSignal<string | null>(null);
  const [card, setCard] = createSignal<{ trunk: string; x: number; y: number } | null>(null);
  addEventListener("keydown", (e) => e.key === "Escape" && (setCard(null), setRow(null), setPicked(null)));

  let last: Nested | undefined;
  let lastOpen = new Set<string>();
  const drawn = createMemo(() => {
    const o = open();
    const t0 = performance.now();
    const n = nestedLayout(inp.nodes, inp.links, o, { mode: "street", labelRoom: labels() === "room" ? LABEL_ROOM : 0 }, stable() ? last : undefined);
    const ms = performance.now() - t0;
    // What moved besides what the change touched (the block and its inside).
    let moved = "";
    if (last) {
      const changed = [...o].filter((x) => !lastOpen.has(x)).concat([...lastOpen].filter((x) => !o.has(x)));
      const inside = (id: string) => changed.some((c) => id === c || ancestors(id).includes(c));
      let dy = 0, dxOnly = 0, same = 0;
      const ys: string[] = [];
      for (const [id, b] of n.boxes) {
        const p = last.boxes.get(id);
        if (!p || inside(id)) continue;
        const mx = Math.abs(p.x - b.x) > 1, my = Math.abs(p.y - b.y) > 1;
        if (my) (dy++, ys.push(inp.info.get(id)!.name));
        else if (mx) dxOnly++;
        else same++;
      }
      moved = changed.length === 1 ? `${o.has(changed[0]!) ? "Opened" : "Folded"} ${inp.info.get(changed[0]!)!.name}: ${same} stayed, ${dxOnly} moved sideways only, ${dy} moved up or down${ys.length ? ` (${ys.slice(0, 8).join(", ")}${ys.length > 8 ? "…" : ""})` : ""}` : "";
    }
    last = n;
    lastOpen = o;
    return { n, ms, moved, stats: measure(n.routes, n.rides), version: Math.random() };
  });
  const ancestors = (id: string): string[] => {
    const p = inp.info.get(id)?.parent;
    return p && inp.info.has(p) ? [p, ...ancestors(p)] : [];
  };
  const toggle = (id: string) => {
    if (!inp.kids.get(id)?.length) return;
    const o = new Set(open());
    if (o.has(id)) for (const x of [id, ...[...o].filter((y) => ancestors(y).includes(id))]) o.delete(x);
    else o.add(id);
    setCard(null);
    setOpen(o);
  };

  /** Scope lines lit by what the pointer (or a pick, or a row) is on: every scope line of the analysis lines it touches. */
  const lit = createMemo(() => {
    const d = drawn().n;
    const out = new Set<string>();
    const light = (sl: string) => {
      for (const m of d.lines.get(sl)?.members ?? []) for (const k of d.drawnAs.get(m) ?? []) out.add(k);
    };
    const h = hover();
    const r = row();
    if (r) light(r);
    if (h?.line) light(h.line);
    const at = h?.node ?? (r ? null : picked());
    if (at) for (const l of d.lines.values()) if (l.from === at || l.to === at) light(l.key);
    return out;
  });
  const trunkBy = createMemo(() => new Map(drawn().n.trunks.map((t) => [t.key, t])));
  const lineName = (l: SLine) => {
    const nm = (id: string) => (id.startsWith("stub:") ? `(edge of ${inp.info.get(id.split(":")[1]!)!.name})` : inp.info.get(id)!.name);
    return `${nm(l.from)} ${l.both ? "↔" : "→"} ${nm(l.to)}`;
  };
  /** The far ends of a scope line's analysis lines, for the card. */
  const ends = (l: SLine) => {
    const d = drawn().n;
    const vis = (id: string) => {
      let x = id;
      for (const a of ancestors(id).reverse()) if (d.boxes.has(a) && !d.boxes.get(a)!.open) return a;
      return d.boxes.has(x) ? x : id;
    };
    const pairs = new Set(l.members.map((m) => { const e = inp.edges.get(m)!; return `${inp.info.get(vis(e.from))!.name} → ${inp.info.get(vis(e.to))!.name}`; }));
    return [...pairs];
  };

  const Canvas = (cp: { phone: boolean }) => {
    const d = () => drawn().n;
    const sc = () => (cp.phone ? Math.min(scale(), 370 / d().width) : scale());
    let tapAt = 0;
    return (
      <svg width={d().width * sc()} height={d().height * sc()} viewBox={`0 0 ${d().width} ${d().height}`} onMouseLeave={() => !cp.phone && setHover(null)}>
        <For each={d().regions}>
          {(f) => (
            <g>
              <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={10} {...stylex.attrs(f.key === "C" ? s.frameC : s.frameU)} />
              <text x={f.x + 14} y={f.y + 26} {...stylex.attrs(s.frameLabel)}>
                {f.key === "C" ? "Changed" : "Not changed"}
              </text>
            </g>
          )}
        </For>
        {/* Blocks, outermost first so open frames sit under what they hold. */}
        <For each={[...d().boxes].sort((a, b) => a[1].depth - b[1].depth || Number(b[1].open) - Number(a[1].open))}>
          {([id, b]) => {
            const n = inp.info.get(id)!;
            const ch = n.change === "unchanged" && inp.nodes.find((x) => x.id === id)!.side === 1 ? "modified" : n.change;
            const inside = inp.kids.get(id)?.length ?? 0;
            return (
              <g
                style={{ "--x": `${b.x}px`, "--y": `${b.y}px` }}
                {...stylex.attrs(s.box)}
                onMouseEnter={() => !cp.phone && setHover({ node: id })}
                onMouseLeave={() => !cp.phone && setHover(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!cp.phone) return toggle(id);
                  // Phone: a tap picks, a second tap within 350 ms opens or folds.
                  const now = performance.now();
                  if (now - tapAt < 350 && picked() === id) toggle(id);
                  tapAt = now;
                  setPicked(id);
                  setRow(null);
                }}
              >
                <rect
                  x={0}
                  y={0}
                  rx={b.open ? 10 : 8}
                  style={{ "--w": `${b.w}px`, "--h": `${b.h}px` }}
                  {...stylex.attrs(s.boxRect, b.open ? s.open : s.node, s[ch as Change], hover()?.node === id && s.nodeHot, picked() === id && s.picked)}
                />
                <text x={12} y={b.open ? 26 : 30} {...stylex.attrs(s.nodeName)}>
                  {b.open ? "▾ " : ""}
                  {n.name.length > 26 ? `${n.name.slice(0, 25)}…` : n.name}
                </text>
                <Show when={!b.open}>
                  <text x={12} y={50} {...stylex.attrs(s.nodeKind)}>
                    {n.kind}
                    {inside ? ` · ▸ ${inside} inside` : ""}
                  </text>
                </Show>
              </g>
            );
          }}
        </For>
        <Show when={drawn().version} keyed>
          {(_) => (
            <g {...stylex.attrs(s.lines)}>
              <For each={[...d().routes]}>
                {([k, pts]) => {
                  const l = d().lines.get(k)!;
                  const changed = l.members.some((m) => inp.edges.get(m)!.change !== "unchanged");
                  const dim = () => lit().size > 0 && !lit().has(k);
                  const left = pts[0]!.x <= pts[pts.length - 1]!.x ? pts[0]! : pts[pts.length - 1]!;
                  return (
                    <g>
                      <path d={rounded(pts)} {...stylex.attrs(s.line, changed && s.lineChanged, dim() && s.dim)} />
                      <Show when={!l.to.startsWith("stub:")}>
                        <path d={arrow(tipOf(pts, true))} {...stylex.attrs(s.head2, dim() && s.dim)} />
                      </Show>
                      <Show when={l.both && !l.from.startsWith("stub:")}>
                        <path d={arrow(tipOf(pts, false))} {...stylex.attrs(s.head2, dim() && s.dim)} />
                      </Show>
                      <Show when={labels() === "room" && l.members.length > 1}>
                        <rect x={left.x + 3} y={left.y - 6} width={String(l.members.length).length * 6 + 6} height={12} rx={3} {...stylex.attrs(s.countBg, dim() && s.dim)} />
                        <text x={left.x + 6} y={left.y + 4} {...stylex.attrs(s.count, dim() && s.dim)}>
                          {l.members.length}
                        </text>
                      </Show>
                      <Show when={!cp.phone}>
                        <path d={rounded(pts)} {...stylex.attrs(s.hit)} onMouseEnter={() => setHover({ line: k })} onMouseLeave={() => setHover(null)} />
                      </Show>
                    </g>
                  );
                }}
              </For>
              <For each={d().trunks}>
                {(t) => (
                  <path
                    d={rounded(t.pts)}
                    style={{ "--tw": `${t.width}px` }}
                    {...stylex.attrs(
                      s.trunk,
                      t.members.some((m) => d().lines.get(m)!.members.some((e) => inp.edges.get(e)!.change !== "unchanged")) && s.trunkChanged,
                      (card()?.trunk === t.key || hover()?.trunk === t.key) && s.trunkHot,
                      lit().size > 0 && !t.members.some((m) => lit().has(m)) && s.dim,
                    )}
                  />
                )}
              </For>
              <Show when={!cp.phone}>
                <For each={d().trunks}>
                  {(t) => (
                    <path
                      d={rounded(t.pts)}
                      {...stylex.attrs(s.trunkHit)}
                      onMouseEnter={() => setHover({ trunk: t.key })}
                      onMouseLeave={() => setHover(null)}
                      onClick={(e) => setCard({ trunk: t.key, x: e.clientX + 12, y: e.clientY + 12 })}
                    />
                  )}
                </For>
              </Show>
              <For each={[...lit()]}>
                {(k) => (
                  <Show when={d().routes.get(k)}>
                    {(p) => (
                      <g>
                        <path d={rounded(p())} {...stylex.attrs(s.line, s.lineHot)} />
                        <Show when={!d().lines.get(k)!.to.startsWith("stub:")}>
                          <path d={arrow(tipOf(p(), true))} {...stylex.attrs(s.headHot)} />
                        </Show>
                      </g>
                    )}
                  </Show>
                )}
              </For>
            </g>
          )}
        </Show>
      </svg>
    );
  };

  /** The picked part's lines, as rows (the phone's Elements tab). */
  const pickedLines = createMemo(() => {
    const p = picked();
    if (!p) return [];
    return [...drawn().n.lines.values()].filter((l) => l.from === p || l.to === p);
  });

  return (
    <div {...stylex.attrs(s.page)}>
      <div {...stylex.attrs(s.bar)}>
        <span {...stylex.attrs(s.title)}>Nested layout</span>
        <span {...stylex.attrs(s.stats)}>
          {inp.nodes.length} parts, {inp.links.length} lines{props.times > 1 ? ` (${props.times}× the analysis)` : ""}
          {props.overlay ? ` (${props.overlay} made up)` : ""}
        </span>
        <button {...stylex.attrs(s.btn)} onClick={() => (setOpen(all()), sync("open", "all"))}>
          Open all
        </button>
        <button {...stylex.attrs(s.btn)} onClick={() => (setOpen(new Set<string>()), sync("open", null))}>
          Fold all
        </button>
        <select value={labels()} onChange={(e) => (setLabels(e.currentTarget.value as Labels), sync("labels", e.currentTarget.value))} {...stylex.attrs(s.select)}>
          <option value="room">Counts: room on the line</option>
          <option value="card">Counts: in the trunk's card</option>
        </select>
        <label>
          <input type="checkbox" checked={stable()} onChange={(e) => (setStable(e.currentTarget.checked), sync("stable", e.currentTarget.checked ? null : "0"))} /> Keep parts where they were
        </label>
        <label>
          <input type="checkbox" checked={touch()} onChange={(e) => (setTouch(e.currentTarget.checked), sync("touch", e.currentTarget.checked ? "1" : null))} /> Phone
        </label>
        <button {...stylex.attrs(s.btn)} onClick={() => (setScale((v) => Math.max(0.05, v / 1.25)), sync("z", scale().toFixed(2)))}>
          −
        </button>
        <button {...stylex.attrs(s.btn)} onClick={() => (setScale((v) => Math.min(3, v * 1.25)), sync("z", scale().toFixed(2)))}>
          +
        </button>
        <span {...stylex.attrs(s.stats)}>
          {drawn().ms.toFixed(0)} ms ({drawn().n.ms.scopes} scopes) · {Math.round(drawn().n.width)}×{Math.round(drawn().n.height)} · {drawn().stats.crossings} crossings · {drawn().stats.bends} bends · {drawn().n.trunks.length} trunks
        </span>
        <Show when={drawn().moved}>
          <span {...stylex.attrs(s.moved)}>{drawn().moved}</span>
        </Show>
      </div>
      <div {...stylex.attrs(s.body)}>
        <Show
          when={touch()}
          fallback={
            <div {...stylex.attrs(s.scroll)}>
              <Canvas phone={false} />
            </div>
          }
        >
          <div {...stylex.attrs(s.phone)}>
            <div {...stylex.attrs(s.phoneMap)}>
              <Canvas phone={true} />
            </div>
            <div {...stylex.attrs(s.drawer)}>
              <Show when={picked()} fallback={<div {...stylex.attrs(s.drawerHead)}>Tap a part to see its lines. Tap it again to open or fold it.</div>}>
                {(p) => (
                  <>
                    <div {...stylex.attrs(s.drawerHead)}>
                      {inp.info.get(p())!.name}: {pickedLines().length} lines
                    </div>
                    <For each={pickedLines()}>
                      {(l) => (
                        <div {...stylex.attrs(s.row, row() === l.key && s.rowHot)} onClick={() => setRow(row() === l.key ? null : l.key)}>
                          {lineName(l)}
                          <span {...stylex.attrs(s.stats)}> · {l.members.length > 1 ? `${l.members.length} connections` : inp.edges.get(l.members[0]!)!.label}</span>
                        </div>
                      )}
                    </For>
                  </>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </div>
      <Show when={card() && trunkBy().get(card()!.trunk)}>
        {(t) => (
          <div style={{ "--x": `${card()!.x}px`, "--y": `${card()!.y}px` }} {...stylex.attrs(s.card)}>
            <div {...stylex.attrs(s.cardHead)}>
              <span {...stylex.attrs(s.cardTitle)}>
                {t().members.length} lines share this stretch, {t().members.reduce((n, m) => n + drawn().n.lines.get(m)!.members.length, 0)} connections
              </span>
              <button {...stylex.attrs(s.cardClose)} aria-label="Close" onClick={() => (setCard(null), setRow(null))}>
                ×
              </button>
            </div>
            <For each={t().members}>
              {(k) => {
                const l = drawn().n.lines.get(k)!;
                return (
                  <div {...stylex.attrs(s.row, row() === k && s.rowHot)} onMouseEnter={() => setRow(k)} onMouseLeave={() => setRow(null)}>
                    {ends(l).slice(0, 2).join("; ")}
                    {ends(l).length > 2 ? ` and ${ends(l).length - 2} more` : ""}
                    <span {...stylex.attrs(s.stats)}> · {l.members.length > 1 ? `${l.members.length} connections` : inp.edges.get(l.members[0]!)!.label}</span>
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
  let a = structuredClone(await load());
  const ov = overlays[`./data/overlays/${name}.json`];
  let overlay = 0;
  if (ov && params.get("overlay") !== "0") {
    const extra = (await ov()).edges;
    a.edges.push(...extra);
    overlay = extra.length;
  }
  const times = Number(params.get("x") ?? 1);
  a = grow(a, times);
  render(() => <App inp={input(a)} overlay={overlay} times={times} />, document.getElementById("root")!);
}
void main();
