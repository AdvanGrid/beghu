// PROTOTYPE (PR view, #159): the panel's walkthrough of purposes. Three layouts, switched with
// ?wt=A|B|C (or ← → in the bottom bar); ?wt=0 is the old panel. All three read the hand-written
// purpose data in data/purposes/ (gitignored) and stand in the same places: the whole PR, a purpose,
// a node and an edge.
//   A — Reader: three sentences, then the next level as a list to drill into.
//   B — Tour: one step at a time (intro, each stop, destination), each step driving the canvas.
//   C — Crossing: tables of purposes × parts, the walkthrough cut to one sentence.
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import * as stylex from "@stylexjs/stylex";
import { colors, fonts } from "../src/tokens.stylex.ts";
import { pal } from "./tokens.stylex.ts";
import type { Model } from "./model.ts";
import type { Change, Edge, Node } from "./schema.ts";
import type { Conflict, EdgeWalk, Fact, NodeWalk, PClaim, Purpose, Purposes, Source, Stop, Walk } from "./purpose.ts";

export type WSel = { kind: "purpose"; id: string } | { kind: "node"; id: string } | { kind: "edge"; ids: string[] } | null;

export interface WalkCtx {
  m: Model;
  p: Purposes;
  /** Where the reader stands. Other selections (a step, a boundary, a group) keep the old panel. */
  sel: () => WSel;
  /** Stand somewhere: selects it and moves the canvas there. */
  pick: (x: WSel) => void;
  /** Light parts and lines on the canvas, fading the rest (null clears it). Doesn't select. */
  light: (x: { nodes: string[]; edges: string[] } | null) => void;
  /** Moves the canvas to show something without selecting it. */
  show: (x: { node?: string; edge?: string }) => void;
  /** The old panel's content for the current place: questions, facets, files, evidence. */
  reference: () => JSX.Element;
  /** The old overview's stated-rule list. */
  allChanges: () => JSX.Element;
  /** The code view's claim, with its lines. */
  codeClaim: (id: string) => JSX.Element;
}

export const WT_VARIANTS = [
  { key: "0", name: "Old panel (stated-rule overview)" },
  { key: "A", name: "Reader: three sentences, then drill in" },
  { key: "B", name: "Tour: one step at a time, driving the canvas" },
  { key: "C", name: "Crossing: purposes × parts in tables" },
] as const;
export type WtKey = (typeof WT_VARIANTS)[number]["key"];

// ---------------------------------------------------------------------------------------------
// The crossing: what the purpose data says about a place, worked out once per place.

interface Place {
  kind: "pr" | "purpose" | "node" | "edge";
  title: string;
  /** Breadcrumb, outermost first. */
  trail: { label: string; to: WSel }[];
  walk: Walk;
  /** True when the walk is made from the code view's one-liners, not written for the purpose view. */
  derived: boolean;
  stops: Stop[];
  /** Purposes this place serves, and its role in each (node, edge), or the purpose's sub-purposes. */
  roles: { purpose: Purpose; role: string; claims: string[]; via?: string }[];
  built: NodeWalk["built"];
  now?: string;
  edge?: { flows: string; when: string; dependents: EdgeWalk["dependents"] };
  conflicts: Conflict[];
  /** Parts and lines to light on the canvas for this place. */
  lit: { nodes: string[]; edges: string[] };
}

function purposeTree(p: Purposes, id: string): string[] {
  const out = [id];
  for (const x of p.purposes) if (x.parent === id) out.push(...purposeTree(p, x.id));
  return out;
}

export function purposeLit(p: Purposes, id: string) {
  const ids = purposeTree(p, id);
  const ps = p.purposes.filter((x) => ids.includes(x.id));
  return {
    nodes: [...new Set(ps.flatMap((x) => [...x.serves.map((s) => s.node), ...x.stops.filter((s) => s.kind === "node").map((s) => s.id)]))],
    edges: [...new Set(ps.flatMap((x) => [...x.edges.map((e) => e.edge), ...x.stops.filter((s) => s.kind === "edge").map((s) => s.id)]))],
  };
}

function placeOf(c: WalkCtx, x: WSel): Place {
  const { m, p } = c;
  const pr = m.a.pr;
  const home = { label: `#${pr.number}`, to: null as WSel };
  if (!x) {
    return {
      kind: "pr",
      title: pr.title,
      trail: [home],
      walk: p.walk,
      derived: false,
      stops: p.purposes.filter((q) => !q.parent).map((q) => ({ kind: "purpose", id: q.id, line: q.walk.intro })),
      roles: [],
      built: [],
      conflicts: p.conflicts,
      lit: { nodes: [], edges: [] },
    };
  }
  if (x.kind === "purpose") {
    const q = p.purposes.find((y) => y.id === x.id)!;
    const trail = [home];
    const up: Purpose[] = [];
    for (let a = q.parent; a; a = p.purposes.find((y) => y.id === a)?.parent) up.unshift(p.purposes.find((y) => y.id === a)!);
    for (const a of up) trail.push({ label: a.name, to: { kind: "purpose", id: a.id } });
    trail.push({ label: q.name, to: x });
    const tree = purposeTree(p, q.id);
    return {
      kind: "purpose",
      title: q.name,
      trail,
      walk: q.walk,
      derived: false,
      stops: q.stops,
      roles: [],
      built: [],
      conflicts: p.conflicts.filter((k) => k.touches.purposes.some((id) => tree.includes(id))),
      lit: purposeLit(p, q.id),
    };
  }
  if (x.kind === "node") {
    const n = m.nodes.get(x.id)!;
    const chain = m.chain(n.id);
    const nw = p.nodes.find((y) => y.node === n.id);
    // Roles: where it serves directly, or through a part inside it, or as a part of something that serves.
    const roles: Place["roles"] = [];
    for (const q of p.purposes) {
      const direct = q.serves.find((s) => s.node === n.id);
      if (direct) {
        roles.push({ purpose: q, role: direct.role, claims: direct.claims });
        continue;
      }
      const inside = q.serves.find((s) => m.chain(s.node).includes(n.id));
      if (inside) roles.push({ purpose: q, role: inside.role, claims: inside.claims, via: inside.node });
    }
    const kids = new Set(m.nodes.size ? [...m.nodes.values()].filter((y) => m.chain(y.id).includes(n.id)).map((y) => y.id) : []);
    const stops: Stop[] = (m.children.get(n.id) ?? [])
      .filter((k) => k.change !== "unchanged" || roles.length > 0)
      .slice(0, 8)
      .map((k) => ({ kind: "node", id: k.id, line: k.changeSummary ?? k.summary }));
    return {
      kind: "node",
      title: n.name,
      trail: [home, ...chain.slice(1).map((id) => ({ label: m.nodes.get(id)!.name, to: { kind: "node", id } as WSel }))],
      walk: nw?.walk ?? derivedNodeWalk(n, roles),
      derived: !nw,
      stops,
      roles,
      built: nw?.built ?? [],
      now: nw?.now ?? n.changeSummary,
      conflicts: p.conflicts.filter((k) => k.touches.nodes.some((id) => kids.has(id) || m.chain(n.id).includes(id))),
      lit: { nodes: [n.id], edges: [] },
    };
  }
  const es = x.ids.map((id) => m.edges.get(id)!);
  const e = es[0]!;
  const ew = p.edges.find((y) => es.some((z) => z.id === y.edge));
  const roles: Place["roles"] = [];
  for (const q of p.purposes) {
    const hit = q.edges.find((y) => es.some((z) => z.id === y.edge));
    if (hit) roles.push({ purpose: q, role: hit.why, claims: hit.claims });
    else if (q.stops.some((s) => s.kind === "edge" && es.some((z) => z.id === s.id))) roles.push({ purpose: q, role: q.stops.find((s) => s.kind === "edge" && es.some((z) => z.id === s.id))!.line, claims: [] });
  }
  const name = (id: string) => m.nodes.get(id)?.name ?? id;
  return {
    kind: "edge",
    title: es.length > 1 ? `${es.length} connections` : `${name(e.from)} → ${name(e.to)}`,
    trail: [home, { label: es.length > 1 ? `${es.length} connections` : e.label, to: x }],
    walk: ew?.walk ?? derivedEdgeWalk(m, es),
    derived: !ew,
    stops: es.length > 1 ? es.slice(0, 10).map((y) => ({ kind: "edge", id: y.id, line: `${name(y.from)} → ${name(y.to)}: ${y.label}` })) : [],
    roles,
    built: [],
    edge: ew ? { flows: ew.flows, when: ew.when, dependents: ew.dependents } : { flows: e.data ?? e.label, when: e.mode === "async" ? "Later, asynchronously" : e.mode === "sync" ? "In the caller's request" : "At build time", dependents: [] },
    conflicts: p.conflicts.filter((k) => k.touches.edges.some((id) => es.some((z) => z.id === id))),
    lit: { nodes: [e.from, e.to], edges: es.map((y) => y.id) },
  };
}

function derivedNodeWalk(n: Node, roles: Place["roles"]): Walk {
  return {
    intro: n.summary,
    journey: n.changeSummary ?? "The PR doesn't change it.",
    destination: roles.length ? `It serves ${roles.map((r) => r.purpose.name.toLowerCase()).join("; ")}.` : "It serves none of the PR's purposes.",
    claims: [],
  };
}

function derivedEdgeWalk(m: Model, es: Edge[]): Walk {
  const e = es[0]!;
  const name = (id: string) => m.nodes.get(id)?.name ?? id;
  return {
    intro: `${name(e.from)} ${e.label} (${e.kind}).`,
    journey: e.data ? `What flows: ${e.data}.` : "Nothing flows: it's a dependency.",
    destination: e.changeSummary ?? "The PR doesn't change it.",
    claims: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Shared bits: sources, conflicts, stops. Every variant uses the same pieces, laid out differently.

const st = stylex.create({
  root: { display: "flex", flexDirection: "column", gap: 2 },
  trail: { color: colors.muted, display: "flex", flexWrap: "wrap", fontSize: 12, gap: 4, marginBottom: 4 },
  crumb: { backgroundColor: "transparent", borderWidth: 0, color: colors.accent, cursor: "pointer", fontFamily: fonts.ui, fontSize: 12, padding: 0 },
  h2: { fontSize: 17, fontWeight: 600, lineHeight: 1.3, marginBlock: 2 },
  kind: { color: colors.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" },
  h3: { color: colors.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", marginBottom: 6, marginTop: 16, textTransform: "uppercase" },
  p: { lineHeight: 1.5, marginBlock: 4 },
  walk: { fontSize: 14, lineHeight: 1.55, marginBlock: 6 },
  muted: { color: colors.muted },
  small: { fontSize: 12 },
  derived: { color: colors.muted, fontSize: 11, fontStyle: "italic" },
  list: { listStyle: "none", margin: 0, padding: 0 },
  stop: {
    alignItems: "baseline",
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    borderRadius: 4,
    borderWidth: 0,
    color: colors.fg,
    cursor: "pointer",
    display: "flex",
    fontFamily: fonts.ui,
    fontSize: 13,
    gap: 8,
    lineHeight: 1.4,
    paddingBlock: 4,
    paddingInline: 6,
    textAlign: "left",
    width: "100%",
  },
  num: { color: colors.muted, flexShrink: 0, fontVariantNumeric: "tabular-nums", minWidth: 16 },
  stopName: { fontWeight: 600 },
  arrow: { color: colors.muted, marginLeft: "auto", paddingLeft: 6 },
  chip: {
    backgroundColor: { default: colors.bgRaised, ":hover": colors.hover },
    borderColor: colors.line,
    borderRadius: 3,
    borderStyle: "solid",
    borderWidth: 1,
    color: colors.muted,
    cursor: "pointer",
    fontFamily: fonts.ui,
    fontSize: 10,
    marginLeft: 3,
    paddingBlock: 0,
    paddingInline: 4,
    verticalAlign: "1px",
  },
  chipOn: { borderColor: colors.accent, color: colors.accent },
  stated: { color: pal.modified, fontSize: 11, fontStyle: "italic", marginLeft: 4 },
  quote: {
    borderLeftColor: colors.line,
    borderLeftStyle: "solid",
    borderLeftWidth: 3,
    color: colors.muted,
    fontSize: 12,
    lineHeight: 1.45,
    marginBlock: 4,
    paddingLeft: 8,
  },
  sources: { backgroundColor: colors.bgRaised, borderRadius: 4, marginBlock: 4, paddingBlock: 4, paddingInline: 8 },
  conflict: { borderColor: colors.line, borderRadius: 6, borderStyle: "solid", borderWidth: 1, marginBlock: 6, overflow: "hidden" },
  conflictHead: { alignItems: "baseline", backgroundColor: colors.bgRaised, display: "flex", fontSize: 12, fontWeight: 600, gap: 6, paddingBlock: 4, paddingInline: 8 },
  pair: { display: "grid", gridTemplateColumns: "1fr 1fr" },
  side: { fontSize: 12, lineHeight: 1.45, paddingBlock: 6, paddingInline: 8 },
  sideB: { borderLeftColor: colors.line, borderLeftStyle: "solid", borderLeftWidth: 1 },
  madeUp: { color: colors.muted, fontSize: 10, fontStyle: "italic", fontWeight: 400, marginLeft: "auto" },
  srcTag: { color: colors.muted, display: "block", fontSize: 11, marginTop: 4 },
  details: { borderTopColor: colors.line, borderTopStyle: "solid", borderTopWidth: 1, marginTop: 10, paddingBlock: 6 },
  summary: { cursor: "pointer", fontWeight: 600, lineHeight: 1.4 },
  role: { lineHeight: 1.45, paddingBlock: 3 },
  link: { backgroundColor: "transparent", borderWidth: 0, color: colors.accent, cursor: "pointer", fontFamily: fonts.ui, fontSize: 13, fontWeight: 600, padding: 0, textAlign: "left" },
  builtKind: { color: colors.muted, display: "inline-block", fontSize: 11, minWidth: 74 },
  // B: the tour.
  tabs: { borderBottomColor: colors.line, borderBottomStyle: "solid", borderBottomWidth: 1, display: "flex", gap: 2, marginBlock: 8 },
  tab: { backgroundColor: "transparent", borderBottomColor: "transparent", borderBottomStyle: "solid", borderBottomWidth: 2, borderWidth: 0, color: colors.muted, cursor: "pointer", fontFamily: fonts.ui, fontSize: 13, paddingBlock: 6, paddingInline: 10 },
  tabOn: { borderBottomColor: colors.accent, color: colors.fg, fontWeight: 600 },
  card: { backgroundColor: colors.bgRaised, borderColor: colors.line, borderRadius: 8, borderStyle: "solid", borderWidth: 1, minHeight: 150, paddingBlock: 12, paddingInline: 14 },
  stepLabel: { color: colors.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" },
  stepText: { fontSize: 15, lineHeight: 1.55, marginBlock: 8 },
  nav: { alignItems: "center", display: "flex", gap: 8, marginTop: 10 },
  navButton: { backgroundColor: colors.bg, borderColor: colors.line, borderRadius: 4, borderStyle: "solid", borderWidth: 1, color: colors.fg, cursor: "pointer", fontFamily: fonts.ui, fontSize: 13, paddingBlock: 4, paddingInline: 10 },
  goIn: { backgroundColor: colors.accentBg, borderColor: colors.accentBg, color: colors.accentFg },
  dots: { display: "flex", flexWrap: "wrap", gap: 4, marginInline: "auto" },
  dot: { backgroundColor: colors.line, borderRadius: 4, borderWidth: 0, cursor: "pointer", height: 8, padding: 0, width: 8 },
  dotOn: { backgroundColor: colors.accent },
  dotEnds: { borderRadius: 1 },
  // C: the crossing.
  table: { borderCollapse: "collapse", fontSize: 12, marginBlock: 4, width: "100%" },
  th: { borderBottomColor: colors.line, borderBottomStyle: "solid", borderBottomWidth: 1, color: colors.muted, fontSize: 11, fontWeight: 600, paddingBlock: 4, paddingInline: 4, textAlign: "left" },
  td: { borderBottomColor: colors.line, borderBottomStyle: "solid", borderBottomWidth: 1, lineHeight: 1.4, paddingBlock: 5, paddingInline: 4, verticalAlign: "top" },
  tr: { backgroundColor: { default: "transparent", ":hover": colors.hover }, cursor: "pointer" },
  num2: { fontVariantNumeric: "tabular-nums", textAlign: "right" },
  indent: { paddingLeft: 16 },
  three: { display: "grid", gap: 8, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" },
  col: { fontSize: 12, lineHeight: 1.45 },
  added: { color: pal.added },
  removed: { color: pal.removed },
  modified: { color: pal.modified },
  unchanged: { color: colors.muted },
});

const CHANGE_SIGN: Record<Change, string> = { added: "+", removed: "−", modified: "~", unchanged: "·" };

function sourceLabel(s: Source): string {
  if (s.kind === "description") return "PR";
  if (s.kind === "issue") return `#${s.number}`;
  return "code";
}

/** Chips for a sentence's sources: PR description, issues, code. Clicking one opens it under the text. */
function SourceChips(props: { c: WalkCtx; claims: string[]; open: () => string | null; setOpen: (k: string | null) => void; at: string }) {
  const claims = () => props.claims.map((id) => props.c.p.claims.find((x) => x.id === id)).filter((x): x is PClaim => !!x);
  const groups = () => {
    const out = new Map<string, number>();
    for (const cl of claims()) for (const s of cl.sources) out.set(sourceLabel(s), (out.get(sourceLabel(s)) ?? 0) + 1);
    return [...out.entries()];
  };
  const statedOnly = () => claims().some((cl) => cl.status === "stated");
  return (
    <>
      <For each={groups()}>
        {([label, n]) => {
          const k = `${props.at}:${label}`;
          return (
            <button onClick={() => props.setOpen(props.open() === k ? null : k)} {...stylex.attrs(st.chip, props.open() === k && st.chipOn)} title="Show where this comes from">
              {label}
              {n > 1 && label === "code" ? ` ×${n}` : ""}
            </button>
          );
        }}
      </For>
      <Show when={statedOnly()}>
        <span {...stylex.attrs(st.stated)} title="The description or an issue says so; the analysis found no code that shows it">
          stated, not found in code
        </span>
      </Show>
    </>
  );
}

/** The opened chip's sources: quotes for the description and issues, the code view's claims for code. */
function SourceBox(props: { c: WalkCtx; claims: string[]; label: string }) {
  const items = () =>
    props.claims
      .map((id) => props.c.p.claims.find((x) => x.id === id))
      .filter((x): x is PClaim => !!x)
      .flatMap((cl) => cl.sources.filter((s) => sourceLabel(s) === props.label).map((s) => ({ cl, s })));
  return (
    <div {...stylex.attrs(st.sources)}>
      <For each={items()}>
        {({ cl, s }) => (
          <div>
            <Show
              when={s.kind !== "code"}
              fallback={props.c.codeClaim((s as Extract<Source, { kind: "code" }>).claim)}
            >
              <div {...stylex.attrs(st.small, st.muted)}>
                {s.kind === "description" ? "The PR's description" : `#${(s as Extract<Source, { kind: "issue" }>).number} ${(s as Extract<Source, { kind: "issue" }>).title}`}, for: {cl.text}
              </div>
              <div {...stylex.attrs(st.quote)}>“{(s as { quote: string }).quote}”</div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

/** The walk's three sentences, each with its chips; the claims are shared, so chips sit at the end. */
function WalkText(props: { c: WalkCtx; place: Place; style?: "walk" | "p" }) {
  const [open, setOpen] = createSignal<string | null>(null);
  const w = () => props.place.walk;
  return (
    <div>
      <p {...stylex.attrs(props.style === "p" ? st.p : st.walk)}>
        {w().intro} {w().journey} {w().destination}
        <SourceChips c={props.c} claims={w().claims} open={open} setOpen={setOpen} at="walk" />
      </p>
      <Show when={props.place.derived}>
        <div {...stylex.attrs(st.derived)}>No walkthrough was written for this; it's built from the code view's one-liners.</div>
      </Show>
      <Show when={open()}>{(k) => <SourceBox c={props.c} claims={w().claims} label={k().split(":")[1]!} />}</Show>
    </div>
  );
}

function stopTarget(s: Stop): WSel {
  if (s.kind === "purpose") return { kind: "purpose", id: s.id };
  if (s.kind === "node") return { kind: "node", id: s.id };
  return { kind: "edge", ids: [s.id] };
}

function stopName(c: WalkCtx, s: Stop): string {
  if (s.kind === "purpose") return c.p.purposes.find((x) => x.id === s.id)!.name;
  if (s.kind === "node") return c.m.nodes.get(s.id)?.name ?? s.id;
  const e = c.m.edges.get(s.id)!;
  return `${c.m.nodes.get(e.from)?.name ?? e.from} → ${c.m.nodes.get(e.to)?.name ?? e.to}`;
}

function stopLit(c: WalkCtx, s: Stop) {
  if (s.kind === "purpose") return purposeLit(c.p, s.id);
  if (s.kind === "node") return { nodes: [s.id], edges: [] };
  const e = c.m.edges.get(s.id)!;
  return { nodes: [e.from, e.to], edges: [s.id] };
}

const STOP_ICON = { purpose: "◆", node: "▢", edge: "→" } as const;

function Trail(props: { c: WalkCtx; place: Place }) {
  return (
    <div {...stylex.attrs(st.trail)}>
      <For each={props.place.trail}>
        {(t, i) => (
          <>
            <Show when={i() > 0}>›</Show>
            <Show when={i() < props.place.trail.length - 1} fallback={<span>{t.label}</span>}>
              <button onClick={() => props.c.pick(t.to)} {...stylex.attrs(st.crumb)}>
                {t.label}
              </button>
            </Show>
          </>
        )}
      </For>
    </div>
  );
}

function sourceLine(s: Source, c: WalkCtx): string {
  if (s.kind === "description") return "the PR's description";
  if (s.kind === "issue") return `#${s.number} ${s.title}`;
  const cl = c.m.claims.get(s.claim);
  const ev = cl?.evidence[0];
  return ev ? `${ev.path}:${ev.start}` : "code";
}

const CONFLICT_KIND: Record<Conflict["kind"], string> = {
  "stated-code": "Stated vs code",
  "purpose-purpose": "Purpose vs purpose",
  "purpose-outside": "Purpose vs code outside the diff",
};

/** A conflict: two facts side by side, each with its source, and no verdict. */
function ConflictCard(props: { c: WalkCtx; k: Conflict }) {
  const [open, setOpen] = createSignal<"a" | "b" | null>(null);
  const side = (f: Fact, which: "a" | "b") => (
    <div {...stylex.attrs(st.side, which === "b" && st.sideB)}>
      <Show when={f.purpose}>
        {(id) => (
          <button onClick={() => props.c.pick({ kind: "purpose", id: id() })} {...stylex.attrs(st.crumb)}>
            {props.c.p.purposes.find((x) => x.id === id())?.name}
          </button>
        )}
      </Show>
      <div>{f.text}</div>
      <button onClick={() => setOpen(open() === which ? null : which)} {...stylex.attrs(st.chip, open() === which && st.chipOn)}>
        {sourceLine(f.source, props.c)}
      </button>
    </div>
  );
  const opened = () => {
    const f = open() === "a" ? props.k.a : open() === "b" ? props.k.b : null;
    if (!f) return null;
    if (f.source.kind === "code") return props.c.codeClaim(f.source.claim);
    return <div {...stylex.attrs(st.quote)}>“{(f.source as { quote: string }).quote}”</div>;
  };
  return (
    <div
      {...stylex.attrs(st.conflict)}
      onMouseEnter={() => props.c.light({ nodes: props.k.touches.nodes, edges: props.k.touches.edges })}
      onMouseLeave={() => props.c.light(null)}
    >
      <div {...stylex.attrs(st.conflictHead)}>
        <span {...stylex.attrs(st.muted)}>{CONFLICT_KIND[props.k.kind]}:</span> {props.k.title}
        <Show when={props.k.madeUp}>
          <span {...stylex.attrs(st.madeUp)}>made up for the prototype</span>
        </Show>
      </div>
      <div {...stylex.attrs(st.pair)}>
        {side(props.k.a, "a")}
        {side(props.k.b, "b")}
      </div>
      <Show when={opened()}>
        <div {...stylex.attrs(st.side)}>{opened()}</div>
      </Show>
    </div>
  );
}

function Conflicts(props: { c: WalkCtx; list: Conflict[]; title?: boolean }) {
  return (
    <Show when={props.list.length > 0}>
      <Show when={props.title !== false}>
        <h3 {...stylex.attrs(st.h3)}>Conflicts ({props.list.length})</h3>
      </Show>
      <For each={props.list}>{(k) => <ConflictCard c={props.c} k={k} />}</For>
    </Show>
  );
}

function StopList(props: { c: WalkCtx; stops: Stop[] }) {
  return (
    <ol {...stylex.attrs(st.list)}>
      <For each={props.stops}>
        {(s, i) => (
          <li>
            <button
              onClick={() => props.c.pick(stopTarget(s))}
              onMouseEnter={() => props.c.light(stopLit(props.c, s))}
              onMouseLeave={() => props.c.light(null)}
              {...stylex.attrs(st.stop)}
            >
              <span {...stylex.attrs(st.num)}>{i() + 1}</span>
              <span>
                <span {...stylex.attrs(st.stopName)}>
                  {STOP_ICON[s.kind]} {stopName(props.c, s)}
                </span>
                <br />
                <span {...stylex.attrs(st.muted)}>{s.line}</span>
              </span>
              <span {...stylex.attrs(st.arrow)}>›</span>
            </button>
          </li>
        )}
      </For>
    </ol>
  );
}

function Roles(props: { c: WalkCtx; place: Place }) {
  return (
    <ul {...stylex.attrs(st.list)}>
      <For each={props.place.roles}>
        {(r) => (
          <li
            {...stylex.attrs(st.role)}
            onMouseEnter={() => props.c.light(purposeLit(props.c.p, r.purpose.id))}
            onMouseLeave={() => props.c.light(null)}
          >
            <button onClick={() => props.c.pick({ kind: "purpose", id: r.purpose.id })} {...stylex.attrs(st.link)}>
              {r.purpose.name}
            </button>
            <Show when={r.via}>
              {(v) => <span {...stylex.attrs(st.muted, st.small)}> (through {props.c.m.nodes.get(v())?.name})</span>}
            </Show>
            <div>{r.role}</div>
          </li>
        )}
      </For>
    </ul>
  );
}

const BUILT: Record<NodeWalk["built"][number]["kind"], string> = { decision: "Decision", constraint: "Constraint", assumption: "Assumption" };

function Built(props: { place: Place }) {
  return (
    <ul {...stylex.attrs(st.list)}>
      <For each={props.place.built}>
        {(b) => (
          <li {...stylex.attrs(st.role)}>
            <span {...stylex.attrs(st.builtKind)}>{BUILT[b.kind]}</span>
            {b.text}
          </li>
        )}
      </For>
    </ul>
  );
}

function EdgeFacts(props: { c: WalkCtx; place: Place }) {
  return (
    <Show when={props.place.edge}>
      {(e) => (
        <ul {...stylex.attrs(st.list)}>
          <li {...stylex.attrs(st.role)}>
            <span {...stylex.attrs(st.builtKind)}>What flows</span>
            {e().flows}
          </li>
          <li {...stylex.attrs(st.role)}>
            <span {...stylex.attrs(st.builtKind)}>When</span>
            {e().when}
          </li>
          <Show when={e().dependents.length > 0}>
            <li {...stylex.attrs(st.role)}>
              <span {...stylex.attrs(st.builtKind)}>Needed by</span>
              <For each={e().dependents}>
                {(d, i) => (
                  <>
                    {i() > 0 ? "; " : ""}
                    <Show when={d.purpose ?? d.node} fallback={d.text}>
                      <button onClick={() => props.c.pick(d.purpose ? { kind: "purpose", id: d.purpose } : { kind: "node", id: d.node! })} {...stylex.attrs(st.crumb)}>
                        {d.text}
                      </button>
                    </Show>
                  </>
                )}
              </For>
            </li>
          </Show>
        </ul>
      )}
    </Show>
  );
}

/** The folded reference: All changes, by kind (at the PR) or the old panel (elsewhere). */
function Reference(props: { c: WalkCtx; place: Place }) {
  return (
    <Show
      when={props.place.kind === "pr"}
      fallback={
        <details {...stylex.attrs(st.details)}>
          <summary {...stylex.attrs(st.summary)}>Questions, facets, files and evidence</summary>
          {props.c.reference()}
        </details>
      }
    >
      <details {...stylex.attrs(st.details)}>
        <summary {...stylex.attrs(st.summary)}>All changes, by kind</summary>
        {props.c.allChanges()}
      </details>
    </Show>
  );
}

function Title(props: { place: Place; c: WalkCtx }) {
  const kind = () => {
    const pl = props.place;
    if (pl.kind === "pr") return `The whole PR · ${props.c.p.purposes.filter((q) => !q.parent).length} purposes`;
    if (pl.kind === "purpose") {
      const q = props.c.p.purposes.find((x) => x.name === pl.title)!;
      return `${q.parent ? "Sub-purpose" : "Purpose"} · ${q.kind}`;
    }
    if (pl.kind === "node") return `Part · ${pl.roles.length} ${pl.roles.length === 1 ? "purpose" : "purposes"}`;
    return "Connection";
  };
  return (
    <>
      <Trail c={props.c} place={props.place} />
      <div {...stylex.attrs(st.kind)}>{kind()}</div>
      <h2 {...stylex.attrs(st.h2)}>{props.place.title}</h2>
    </>
  );
}

function nextLabel(place: Place): string {
  if (place.kind === "pr") return "Its purposes, in order";
  if (place.kind === "purpose") return "The journey";
  if (place.kind === "node") return "Inside it";
  return "The connections";
}

// ---------------------------------------------------------------------------------------------
// A — Reader.

function Reader(props: { c: WalkCtx; place: Place }) {
  const pl = () => props.place;
  return (
    <div {...stylex.attrs(st.root)}>
      <Title c={props.c} place={pl()} />
      <WalkText c={props.c} place={pl()} />
      <Show when={pl().kind === "node" || pl().kind === "edge"}>
        <h3 {...stylex.attrs(st.h3)}>In this PR's purposes</h3>
        <Show when={pl().roles.length > 0} fallback={<p {...stylex.attrs(st.p, st.muted)}>None: the PR's purposes don't pass through it.</p>}>
          <Roles c={props.c} place={pl()} />
        </Show>
      </Show>
      <Show when={pl().kind === "edge"}>
        <EdgeFacts c={props.c} place={pl()} />
      </Show>
      <Show when={pl().built.length > 0}>
        <h3 {...stylex.attrs(st.h3)}>How it's built</h3>
        <Built place={pl()} />
      </Show>
      <Show when={pl().kind === "node" && pl().now}>
        <h3 {...stylex.attrs(st.h3)}>What it now does</h3>
        <p {...stylex.attrs(st.p)}>{pl().now}</p>
      </Show>
      <Show when={pl().stops.length > 0}>
        <h3 {...stylex.attrs(st.h3)}>{nextLabel(pl())}</h3>
        <StopList c={props.c} stops={pl().stops} />
      </Show>
      <Conflicts c={props.c} list={pl().conflicts} />
      <Reference c={props.c} place={pl()} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// B — Tour: intro, each stop, destination, one at a time. Stepping lights and moves the canvas but
// doesn't select; "Go in" stands on the stop.

function Tour(props: { c: WalkCtx; place: Place }) {
  const [tab, setTab] = createSignal<"walk" | "conflicts" | "about" | "ref">("walk");
  const [i, setI] = createSignal(0);
  const pl = () => props.place;
  const steps = createMemo(() => {
    const p = pl();
    const out: { label: string; text: JSX.Element; stop?: Stop }[] = [{ label: "Where you are", text: p.walk.intro }];
    if (p.stops.length === 0) out.push({ label: "How", text: p.walk.journey });
    p.stops.forEach((s, k) => {
      const deeper = s.kind === "purpose" ? props.c.p.purposes.find((x) => x.id === s.id)!.walk.intro : s.line;
      out.push({
        label: `${k + 1} of ${p.stops.length} · ${stopName(props.c, s)}`,
        text: k === 0 ? (
          <>
            <span {...stylex.attrs(st.muted)}>{p.walk.journey} </span>
            <br />
            <br />
            {deeper}
          </>
        ) : (
          deeper
        ),
        stop: s,
      });
    });
    out.push({ label: "Where it ends", text: p.walk.destination });
    return out;
  });
  const go = (k: number) => {
    const n = Math.max(0, Math.min(steps().length - 1, k));
    setI(n);
    const s = steps()[n]!.stop;
    if (!s) return props.c.light(pl().lit.nodes.length ? pl().lit : null);
    props.c.light(stopLit(props.c, s));
    if (s.kind === "node") props.c.show({ node: s.id });
    if (s.kind === "edge") props.c.show({ edge: s.id });
  };
  const step = () => steps()[Math.min(i(), steps().length - 1)]!;
  const tabs = () => [
    { id: "walk" as const, label: "Walkthrough" },
    ...(pl().kind === "node" || pl().kind === "edge" ? [{ id: "about" as const, label: `Purposes (${pl().roles.length})` }] : []),
    { id: "conflicts" as const, label: `Conflicts (${pl().conflicts.length})` },
    { id: "ref" as const, label: pl().kind === "pr" ? "All changes" : "Reference" },
  ];
  return (
    <div {...stylex.attrs(st.root)}>
      <Title c={props.c} place={pl()} />
      <div {...stylex.attrs(st.tabs)} role="tablist">
        <For each={tabs()}>
          {(t) => (
            <button role="tab" onClick={() => setTab(t.id)} {...stylex.attrs(st.tab, tab() === t.id && st.tabOn)}>
              {t.label}
            </button>
          )}
        </For>
      </div>
      <Show when={tab() === "walk"}>
        <div {...stylex.attrs(st.card)}>
          <div {...stylex.attrs(st.stepLabel)}>{step().label}</div>
          <div {...stylex.attrs(st.stepText)}>{step().text}</div>
          <Show when={step().stop}>
            {(s) => (
              <button onClick={() => props.c.pick(stopTarget(s()))} {...stylex.attrs(st.navButton, st.goIn)}>
                Go in ›
              </button>
            )}
          </Show>
        </div>
        <div {...stylex.attrs(st.nav)}>
          <button disabled={i() === 0} onClick={() => go(i() - 1)} {...stylex.attrs(st.navButton)}>
            ‹ Back
          </button>
          <div {...stylex.attrs(st.dots)}>
            <For each={steps()}>
              {(x, k) => <button title={x.label} onClick={() => go(k())} {...stylex.attrs(st.dot, !x.stop && st.dotEnds, k() === i() && st.dotOn)} />}
            </For>
          </div>
          <button disabled={i() === steps().length - 1} onClick={() => go(i() + 1)} {...stylex.attrs(st.navButton)}>
            Next ›
          </button>
        </div>
        <Show when={pl().derived}>
          <p {...stylex.attrs(st.derived)}>No walkthrough was written for this; it's built from the code view's one-liners.</p>
        </Show>
        <Show when={pl().conflicts.length > 0}>
          <p {...stylex.attrs(st.p, st.small)}>
            <button onClick={() => setTab("conflicts")} {...stylex.attrs(st.crumb)}>
              {pl().conflicts.length} {pl().conflicts.length === 1 ? "conflict" : "conflicts"} touch this
            </button>
          </p>
        </Show>
      </Show>
      <Show when={tab() === "about"}>
        <Roles c={props.c} place={pl()} />
        <EdgeFacts c={props.c} place={pl()} />
        <Show when={pl().built.length > 0}>
          <h3 {...stylex.attrs(st.h3)}>How it's built</h3>
          <Built place={pl()} />
        </Show>
        <Show when={pl().now}>
          <h3 {...stylex.attrs(st.h3)}>What it now does</h3>
          <p {...stylex.attrs(st.p)}>{pl().now}</p>
        </Show>
        <h3 {...stylex.attrs(st.h3)}>Sources</h3>
        <WalkText c={props.c} place={pl()} style="p" />
      </Show>
      <Show when={tab() === "conflicts"}>
        <Show when={pl().conflicts.length > 0} fallback={<p {...stylex.attrs(st.p, st.muted)}>No conflicts touch this.</p>}>
          <Conflicts c={props.c} list={pl().conflicts} title={false} />
        </Show>
      </Show>
      <Show when={tab() === "ref"}>{pl().kind === "pr" ? props.c.allChanges() : props.c.reference()}</Show>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// C — Crossing: one sentence of walkthrough, then tables where purposes and parts cross.

function Crossing(props: { c: WalkCtx; place: Place }) {
  const pl = () => props.place;
  const c = props.c;
  const [more, setMore] = createSignal(false);
  const top = () => c.p.purposes.filter((q) => !q.parent);
  const subs = (id: string) => c.p.purposes.filter((q) => q.parent === id);
  const conflictsOf = (id: string) => {
    const tree = purposeTree(c.p, id);
    return c.p.conflicts.filter((k) => k.touches.purposes.some((x) => tree.includes(x))).length;
  };
  const srcOf = (q: Purpose) => {
    const ids = [...q.walk.claims, ...q.serves.flatMap((s) => s.claims)];
    const set = new Set<string>();
    let stated = false;
    for (const id of ids) {
      const cl = c.p.claims.find((x) => x.id === id);
      if (!cl) continue;
      if (cl.status === "stated") stated = true;
      for (const s of cl.sources) set.add(s.kind === "code" ? "code" : s.kind === "issue" ? "issue" : "PR");
    }
    return { set: [...set].join(" · "), stated };
  };
  const row = (q: Purpose, sub: boolean) => (
    <tr
      onClick={() => c.pick({ kind: "purpose", id: q.id })}
      onMouseEnter={() => c.light(purposeLit(c.p, q.id))}
      onMouseLeave={() => c.light(null)}
      {...stylex.attrs(st.tr)}
    >
      <td {...stylex.attrs(st.td, sub && st.indent)}>
        <b>{q.name}</b>
        <div {...stylex.attrs(st.muted)}>{q.kind}</div>
      </td>
      <td {...stylex.attrs(st.td, st.num2)}>{purposeLit(c.p, q.id).nodes.length}</td>
      <td {...stylex.attrs(st.td, st.num2)}>{conflictsOf(q.id) || ""}</td>
      <td {...stylex.attrs(st.td)}>
        {srcOf(q).set}
        <Show when={srcOf(q).stated}>
          <div {...stylex.attrs(st.stated)}>some stated only</div>
        </Show>
      </td>
    </tr>
  );
  const changeOf = (id: string): Change => c.m.nodes.get(id)?.change ?? "unchanged";
  const builtBy = (k: NodeWalk["built"][number]["kind"]) => pl().built.filter((b) => b.kind === k);
  return (
    <div {...stylex.attrs(st.root)}>
      <Title c={c} place={pl()} />
      <p {...stylex.attrs(st.walk)}>
        {pl().walk.intro}{" "}
        <Show when={more()} fallback={<button onClick={() => setMore(true)} {...stylex.attrs(st.chip)}>more</button>}>
          {pl().walk.journey} {pl().walk.destination}
        </Show>
      </p>
      <Show when={more()}>
        <WalkText c={c} place={{ ...pl(), walk: { ...pl().walk, intro: "", journey: "", destination: "" } }} style="p" />
      </Show>

      <Show when={pl().kind === "pr"}>
        <table {...stylex.attrs(st.table)}>
          <thead>
            <tr>
              <th {...stylex.attrs(st.th)}>Purpose, in order</th>
              <th {...stylex.attrs(st.th, st.num2)}>Parts</th>
              <th {...stylex.attrs(st.th, st.num2)}>Conflicts</th>
              <th {...stylex.attrs(st.th)}>From</th>
            </tr>
          </thead>
          <tbody>
            <For each={top()}>
              {(q) => (
                <>
                  {row(q, false)}
                  <For each={subs(q.id)}>{(x) => row(x, true)}</For>
                </>
              )}
            </For>
          </tbody>
        </table>
      </Show>

      <Show when={pl().kind === "purpose"}>
        {(() => {
          const q = () => c.p.purposes.find((x) => x.name === pl().title)!;
          return (
            <>
              <Show when={subs(q().id).length > 0}>
                <h3 {...stylex.attrs(st.h3)}>Sub-purposes</h3>
                <table {...stylex.attrs(st.table)}>
                  <tbody>
                    <For each={subs(q().id)}>{(x) => row(x, false)}</For>
                  </tbody>
                </table>
              </Show>
              <h3 {...stylex.attrs(st.h3)}>Parts that serve it</h3>
              <table {...stylex.attrs(st.table)}>
                <thead>
                  <tr>
                    <th {...stylex.attrs(st.th)}>Part</th>
                    <th {...stylex.attrs(st.th)}>Its role here</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={q().serves}>
                    {(s) => (
                      <tr
                        onClick={() => c.pick({ kind: "node", id: s.node })}
                        onMouseEnter={() => c.light({ nodes: [s.node], edges: [] })}
                        onMouseLeave={() => c.light(null)}
                        {...stylex.attrs(st.tr)}
                      >
                        <td {...stylex.attrs(st.td)}>
                          <span {...stylex.attrs(st[changeOf(s.node)])}>{CHANGE_SIGN[changeOf(s.node)]}</span> <b>{c.m.nodes.get(s.node)?.name}</b>
                        </td>
                        <td {...stylex.attrs(st.td)}>{s.role}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={q().edges.length > 0}>
                <h3 {...stylex.attrs(st.h3)}>Connections that carry it</h3>
                <table {...stylex.attrs(st.table)}>
                  <tbody>
                    <For each={q().edges}>
                      {(e) => (
                        <tr
                          onClick={() => c.pick({ kind: "edge", ids: [e.edge] })}
                          onMouseEnter={() => c.light(stopLit(c, { kind: "edge", id: e.edge, line: "" }))}
                          onMouseLeave={() => c.light(null)}
                          {...stylex.attrs(st.tr)}
                        >
                          <td {...stylex.attrs(st.td)}>
                            <b>{stopName(c, { kind: "edge", id: e.edge, line: "" })}</b>
                            <div {...stylex.attrs(st.muted)}>{c.m.edges.get(e.edge)?.label}</div>
                          </td>
                          <td {...stylex.attrs(st.td)}>{e.why}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
              <h3 {...stylex.attrs(st.h3)}>The journey</h3>
              <StopList c={c} stops={pl().stops} />
            </>
          );
        })()}
      </Show>

      <Show when={pl().kind === "node" || pl().kind === "edge"}>
        <h3 {...stylex.attrs(st.h3)}>Purposes × this {pl().kind === "node" ? "part" : "connection"}</h3>
        <table {...stylex.attrs(st.table)}>
          <thead>
            <tr>
              <th {...stylex.attrs(st.th)}>Purpose</th>
              <th {...stylex.attrs(st.th)}>Role</th>
            </tr>
          </thead>
          <tbody>
            <Show when={pl().roles.length > 0} fallback={<tr><td {...stylex.attrs(st.td, st.muted)} colspan={2}>None of the PR's purposes pass through it.</td></tr>}>
              <For each={pl().roles}>
                {(r) => (
                  <tr
                    onClick={() => c.pick({ kind: "purpose", id: r.purpose.id })}
                    onMouseEnter={() => c.light(purposeLit(c.p, r.purpose.id))}
                    onMouseLeave={() => c.light(null)}
                    {...stylex.attrs(st.tr)}
                  >
                    <td {...stylex.attrs(st.td)}>
                      <b>{r.purpose.name}</b>
                    </td>
                    <td {...stylex.attrs(st.td)}>
                      {r.role}
                      <Show when={r.via}>{(v) => <div {...stylex.attrs(st.muted)}>through {c.m.nodes.get(v())?.name}</div>}</Show>
                    </td>
                  </tr>
                )}
              </For>
            </Show>
          </tbody>
        </table>
        <EdgeFacts c={c} place={pl()} />
        <Show when={pl().built.length > 0}>
          <h3 {...stylex.attrs(st.h3)}>How it's built</h3>
          <div {...stylex.attrs(st.three)}>
            <For each={["decision", "constraint", "assumption"] as const}>
              {(k) => (
                <div {...stylex.attrs(st.col)}>
                  <div {...stylex.attrs(st.builtKind)}>{BUILT[k]}s</div>
                  <For each={builtBy(k)} fallback={<div {...stylex.attrs(st.muted)}>none</div>}>
                    {(b) => <div {...stylex.attrs(st.role)}>{b.text}</div>}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={pl().kind === "node" && pl().now}>
          <h3 {...stylex.attrs(st.h3)}>What it now does</h3>
          <p {...stylex.attrs(st.p)}>{pl().now}</p>
        </Show>
        <Show when={pl().stops.length > 0}>
          <h3 {...stylex.attrs(st.h3)}>{nextLabel(pl())}</h3>
          <StopList c={c} stops={pl().stops} />
        </Show>
      </Show>

      <Conflicts c={c} list={pl().conflicts} />
      <Reference c={c} place={pl()} />
    </div>
  );
}

export function Walkthrough(props: { c: WalkCtx; variant: Exclude<WtKey, "0"> }) {
  const place = createMemo(() => placeOf(props.c, props.c.sel()));
  return (
    <Show when={place()} keyed>
      {(pl) => (
        <Switch>
          <Match when={props.variant === "A"}>
            <Reader c={props.c} place={pl} />
          </Match>
          <Match when={props.variant === "B"}>
            <Tour c={props.c} place={pl} />
          </Match>
          <Match when={props.variant === "C"}>
            <Crossing c={props.c} place={pl} />
          </Match>
        </Switch>
      )}
    </Show>
  );
}
