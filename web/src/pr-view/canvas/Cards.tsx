// The canvas's hover cards: styled cards in the app's tokens, never native tooltips, placed clear
// of the pointer. A part: kind, change, name, summary, a change line with a coloured bar, size,
// "N inside", then Drawn as. A line: each connection (from → to, change, label, kind, when, mode,
// what it carries, two rows for both ways, boundaries crossed, "not confirmed"), then Drawn as
// ("a line, riding N trunks", "through the edge of ‹block›", and its key rows). A trunk: "N lines
// share this stretch" and the list. A click on a trunk pins its card: it drags by its head,
// closes with × or Escape, and hovering a row lights that line's whole route. A card stays while
// the pointer moves onto it, so a line's boundaries can be picked from it.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type Element } from "solid-js";
import type { Edge } from "../../bindings/analysis";
import { colors, fonts } from "../../tokens.stylex";
import { useNav } from "../nav";
import { CHANGE } from "../ui";
import { drawnAs, type KeyRow } from "./key";
import { SampleView } from "./Legend";
import { changeKey, CHANGE_WORD, kindWord, sizeLine } from "./look";
import type { DLine, Item, Scene } from "./scene";
import { useCanvas } from "./store";

/** What the pointer is over: an item, a drawn line or a trunk, and where (viewport px). */
export type Hover = { kind: "item" | "line" | "trunk"; id: string; x: number; y: number };

const WHEN = { runtime: "run time", build: "build", test: "tests" } as const;
const MODE = { sync: "synchronous", async: "asynchronous", "n/a": "not a call" } as const;
/** How many connections a line's card lists before "+N more". */
const LIST = 6;

export function Cards(props: {
  hover: () => Hover | undefined;
  pinned: () => { trunk: string; x: number; y: number } | undefined;
  unpin: () => void;
  move: (x: number, y: number) => void;
  rowLine: (id: string | undefined) => void;
  keep: () => Hover | undefined;
}) {
  const c = useCanvas();
  // The card on screen: the hover's, kept a moment after the pointer leaves, and while it's over the card.
  const [card, setCard] = createSignal<Hover>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let over = false;
  createEffect(props.hover, (h) => {
    clearTimeout(timer);
    if (h) setCard(h);
    else timer = setTimeout(() => !over && setCard(undefined), 250);
  });
  onCleanup(() => clearTimeout(timer));
  const stop = (e: Event) => e.stopPropagation();
  return (
    <>
      <Show when={card()}>
        {(h) => (
          <Placed
            x={h().x}
            y={h().y}
            interactive={h().kind === "line"}
            perf="hover-card"
            onEnter={() => (over = true)}
            onLeave={() => {
              over = false;
              setCard(undefined);
            }}
          >
            {/* Keyed: each thing hovered gets its own card. */}
            <Show when={h().kind === "item" && c.scene().items.get(h().id)} keyed>
              {(it) => untrack(() => <ItemCard it={it} />)}
            </Show>
            <Show when={h().kind === "line" && c.scene().lines.get(h().id)} keyed>
              {(l) => untrack(() => <LineCard l={l} />)}
            </Show>
            <Show when={h().kind === "trunk" && c.scene().trunks.find((t) => t.id === h().id)} keyed>
              {(t) => <TrunkCard lines={t.lines} rowLine={props.rowLine} />}
            </Show>
          </Placed>
        )}
      </Show>
      <Show when={props.pinned()}>
        {(p) => {
          const t = () => c.scene().trunks.find((x) => x.id === p().trunk);
          let drag: { x: number; y: number; px: number; py: number } | undefined;
          let card!: HTMLDivElement;
          /** Dragged, the card stays inside the canvas. */
          const moveTo = (x: number, y: number) => {
            const box = card.offsetParent as HTMLElement | null;
            const w = box ? box.clientWidth - card.offsetWidth - 8 : x, h = box ? box.clientHeight - card.offsetHeight - 8 : y;
            props.move(Math.max(8, Math.min(x, w)), Math.max(8, Math.min(y, h)));
          };
          return (
            <Show when={t()}>
              {(tr) => (
                <div
                  ref={card}
                  {...stylex.attrs(s.card, s.pinnedCard)}
                  style={{ "--cx": `${p().x}px`, "--cy": `${p().y}px` }}
                  data-chrome=""
                  data-perf="trunk-card"
                  role="dialog"
                  aria-label="Lines sharing this stretch"
                  onPointerDown={stop}
                  onPointerOver={stop}
                  onClick={stop}
                  onDblClick={stop}
                  onPointerLeave={() => props.rowLine(undefined)}
                >
                  <div
                    {...stylex.attrs(s.dragHead)}
                    data-perf="trunk-card-head"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      drag = { x: e.clientX, y: e.clientY, px: p().x, py: p().y };
                    }}
                    onPointerMove={(e) => drag && moveTo(drag.px + e.clientX - drag.x, drag.py + e.clientY - drag.y)}
                    onPointerUp={() => (drag = undefined)}
                  >
                    <span {...stylex.attrs(s.headTitle)}>{tr().lines.length} lines share this stretch</span>
                    <button type="button" {...stylex.attrs(s.close)} aria-label="Close" data-perf="trunk-card-close" onPointerDown={stop} onClick={() => props.unpin()}>
                      ×
                    </button>
                  </div>
                  <TrunkRows lines={tr().lines} rowLine={props.rowLine} />
                </div>
              )}
            </Show>
          );
        }}
      </Show>
    </>
  );
}

/** A card placed clear of the pointer, inside the viewport. */
function Placed(props: { x: number; y: number; perf: string; interactive: boolean; onEnter: () => void; onLeave: () => void; children: Element }) {
  let el!: HTMLDivElement;
  const [at, setAt] = createSignal(untrack(() => ({ x: props.x + 16, y: props.y + 18 })));
  createEffect(
    () => [props.x, props.y] as const,
    ([x, y]) => {
      // After it's laid out: flipped to the pointer's other side where it would run off the viewport.
      requestAnimationFrame(() => {
        const box = el?.offsetParent as HTMLElement | null;
        if (!el || !box) return;
        const w = el.offsetWidth, h = el.offsetHeight;
        const nx = x + 16 + w > box.clientWidth - 8 ? Math.max(8, x - 16 - w) : x + 16;
        const ny = y + 18 + h > box.clientHeight - 8 ? Math.max(8, y - 12 - h) : y + 18;
        setAt({ x: nx, y: ny });
      });
      setAt({ x: x + 16, y: y + 18 });
    },
  );
  const stop = (e: Event) => e.stopPropagation();
  return (
    <div
      ref={el}
      {...stylex.attrs(s.card, !props.interactive && s.inert)}
      style={{ "--cx": `${at().x}px`, "--cy": `${at().y}px` }}
      data-chrome=""
      data-perf={props.perf}
      role="tooltip"
      onPointerEnter={props.onEnter}
      onPointerLeave={props.onLeave}
      onPointerOver={stop}
      onPointerDown={stop}
      onClick={stop}
      onDblClick={stop}
    >
      {props.children}
    </div>
  );
}

function DrawnAs(props: { rows: KeyRow[]; lead?: string[] }) {
  return (
    <Show when={props.rows.length > 0 || (props.lead?.length ?? 0) > 0}>
      <div {...stylex.attrs(s.drawnAs)} data-perf="drawn-as">
        <div {...stylex.attrs(s.label)}>Drawn as</div>
        <For each={props.lead ?? []}>{(t) => <div {...stylex.attrs(s.small)} data-perf="drawn-as-line">{t}</div>}</For>
        <For each={props.rows}>
          {(r) => (
            <div {...stylex.attrs(s.drawnRow)} data-perf="drawn-as-row" data-row={r.id}>
              <SampleView sample={r.sample} />
              <span>{r.words}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function ItemCard(props: { it: Item }) {
  const nav = useNav();
  const c = useCanvas();
  const m = () => untrack(() => nav.model());
  const rows = createMemo(() => drawnAs(c.rows(), { item: props.it.id }));
  // Keyed on the item (Cards): its words are read once.
  const it = untrack(() => props.it);
  if (it.group) {
    const g = it.group;
    const changed = g.members.filter((id) => changeKey(m(), m().nodes.get(id)!) !== "unchanged" && changeKey(m(), m().nodes.get(id)!) !== "none").length;
    return (
      <div data-perf="group-card">
        <div {...stylex.attrs(s.kind)}>{g.kind === "column" ? "Column" : g.kind === "shared" ? `Shared box · ${g.by}` : `Box · ${g.by}`}</div>
        <div {...stylex.attrs(s.name)}>{g.title}</div>
        <div {...stylex.attrs(s.small)}>
          {g.members.length} {g.members.length === 1 ? "part" : "parts"} · {changed} changed
        </div>
        <DrawnAs rows={rows()} />
      </div>
    );
  }
  if (it.rest) {
    return (
      <div data-perf="rest-card">
        <div {...stylex.attrs(s.name)}>
          {it.rest.folders} {it.rest.folders === 1 ? "folder" : "folders"} not drawn
        </div>
        <div {...stylex.attrs(s.small)}>No line, step, purpose or conflict in this PR reaches them. It can't be opened.</div>
        <DrawnAs rows={rows()} />
      </div>
    );
  }
  const n = it.node!;
  const key = changeKey(m(), n);
  const inside = (m().children.get(n.id) ?? []).length;
  return (
    <div data-perf="part-card">
      <div {...stylex.attrs(s.kind)}>
        {kindWord(n)}
        <Show when={key !== "none"}>
          {" "}
          <span {...stylex.attrs(s.badge, changeBadge[key])}>{CHANGE_WORD[key]}</span>
        </Show>
      </div>
      <div {...stylex.attrs(s.name)}>{m().name(n.id)}</div>
      <p {...stylex.attrs(s.p)}>{n.summary}</p>
      <Show when={n.changeSummary}>
        <p {...stylex.attrs(s.p, s.changeLine, changeBar[key])} data-perf="change-line">
          {n.changeSummary}
        </p>
      </Show>
      <div {...stylex.attrs(s.small)}>
        {[sizeLine(m(), n.id), inside ? `${inside} inside` : undefined].filter(Boolean).join(" · ")}
      </div>
      <DrawnAs rows={rows()} />
    </div>
  );
}

/** The frames a drawn line crosses the edge of: every frame one of its pieces meets at a port. */
function edgesCrossed(sc: Scene, l: DLine): string[] {
  const out = new Set<string>();
  for (const id of sc.drawnAs.get(l.members[0] ?? "") ?? []) {
    const piece = sc.lines.get(id);
    if (piece && (piece.from === undefined || piece.to === undefined)) out.add(piece.scope);
  }
  return [...out];
}

function LineCard(props: { l: DLine }) {
  const nav = useNav();
  const c = useCanvas();
  const m = () => nav.model();
  // Keyed on the line (Cards): its words are read once.
  const l = untrack(() => props.l);
  const edges = () => l.members.map((id) => m().edges.get(id)).filter((e): e is Edge => e !== undefined);
  const rows = createMemo(() => drawnAs(c.rows(), { line: l.id }).filter((r) => r.id !== "line:labels"));
  const lead = () => {
    const sc = c.scene();
    const n = l.trunks.length;
    const crossed = edgesCrossed(sc, l).map((f) => `through the edge of ${m().name(f)}`);
    return [n ? `a line, riding ${n} ${n === 1 ? "trunk" : "trunks"}` : "a line", ...crossed];
  };
  const unconfirmed = (e: Edge) => e.claims.length > 0 && e.claims.every((x) => m().stubs.get(x)?.status === "undetermined");
  return (
    <div data-perf="line-card">
      <div {...stylex.attrs(s.kind)}>
        {l.count === 1 ? "1 connection" : `${l.count} connections`}
      </div>
      <ul {...stylex.attrs(s.list)}>
        <For each={edges().slice(0, LIST)}>
          {(e) => (
            <li {...stylex.attrs(s.connection)} data-perf="card-connection" data-id={e.id}>
              <div>
                <span {...stylex.attrs(s.strong)}>
                  {m().name(e.from)} → {m().name(e.to)}
                </span>{" "}
                <span {...stylex.attrs(s.badge, changeBadge[e.change === "modified" ? "modified" : e.change])}>{CHANGE[e.change]}</span>
              </div>
              <div>{e.label}</div>
              <div {...stylex.attrs(s.small)}>
                {e.kind} · {WHEN[e.when]} · {MODE[e.mode]}
              </div>
              <Show when={e.data}>
                {(d) => (
                  <Show
                    when={d().direction === "both"}
                    fallback={
                      <div {...stylex.attrs(s.small)} data-perf="carries">
                        carries {d().what}, {d().direction === "back" ? `${m().name(e.to)} → ${m().name(e.from)}` : `${m().name(e.from)} → ${m().name(e.to)}`}
                      </div>
                    }
                  >
                    <div {...stylex.attrs(s.small)} data-perf="carries">
                      → {m().name(e.from)} to {m().name(e.to)}: {d().what}
                    </div>
                    <div {...stylex.attrs(s.small)} data-perf="carries">
                      ← {m().name(e.to)} to {m().name(e.from)}: {d().what}
                    </div>
                  </Show>
                )}
              </Show>
              <Show when={e.boundaries.length > 0}>
                <div {...stylex.attrs(s.small)}>
                  crosses{" "}
                  <For each={e.boundaries}>
                    {(b, i) => (
                      <>
                        {i() > 0 ? ", " : ""}
                        <button type="button" {...stylex.attrs(s.pick)} data-perf="card-boundary" onClick={() => nav.select({ kind: "boundary", id: b })}>
                          {m().boundaries.get(b)?.name ?? b}
                        </button>
                      </>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={unconfirmed(e)}>
                <div {...stylex.attrs(s.small, s.warn)}>not confirmed</div>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={edges().length > LIST}>
        <div {...stylex.attrs(s.small)}>+{edges().length - LIST} more: select the line for all of them</div>
      </Show>
      <DrawnAs rows={rows()} lead={lead()} />
    </div>
  );
}

function TrunkCard(props: { lines: string[]; rowLine: (id: string | undefined) => void }) {
  const c = useCanvas();
  const row = () => c.rows().filter((r) => r.id === "trunk");
  return (
    <div data-perf="trunk-hover">
      <div {...stylex.attrs(s.name)}>{props.lines.length} lines share this stretch</div>
      <div {...stylex.attrs(s.small)}>Click to pin this list.</div>
      <TrunkRows lines={props.lines} rowLine={props.rowLine} />
      <DrawnAs rows={row()} />
    </div>
  );
}

function TrunkRows(props: { lines: string[]; rowLine: (id: string | undefined) => void }) {
  const nav = useNav();
  const c = useCanvas();
  const label = (id: string) => {
    const sc = c.scene();
    const l = sc.lines.get(id);
    if (!l) return id;
    const e = l.count === 1 ? nav.model().edges.get(l.members[0]!) : undefined;
    if (e) return `${nav.model().name(e.from)} → ${nav.model().name(e.to)}: ${e.label}`;
    const end = (x: string | undefined) => (x === undefined ? "the frame's edge" : (sc.items.get(x)?.group?.title ?? nav.model().name(x)));
    return `${end(l.from)} → ${end(l.to)} · ${l.count} connections`;
  };
  return (
    <ul {...stylex.attrs(s.list, s.rows)}>
      <For each={props.lines}>
        {(id) => (
          <li>
            <button
              type="button"
              {...stylex.attrs(s.row)}
              data-perf="trunk-row"
              data-line={undefined}
              data-id={id}
              onPointerEnter={() => props.rowLine(id)}
              onPointerLeave={() => props.rowLine(undefined)}
              onClick={() => {
                const l = c.scene().lines.get(id);
                if (l) nav.select({ kind: "line", ids: l.members });
              }}
            >
              {label(id)}
            </button>
          </li>
        )}
      </For>
    </ul>
  );
}

const changeBadge = stylex.create({
  added: { borderColor: colors.open, color: colors.open },
  modified: { borderColor: colors.warn, color: colors.warn },
  inside: { borderColor: colors.warn, color: colors.warn },
  removed: { borderColor: colors.danger, color: colors.danger },
  unchanged: { borderColor: colors.line, color: colors.muted },
  none: { borderColor: colors.line, color: colors.muted },
});

const changeBar = stylex.create({
  added: { borderInlineStartColor: colors.open },
  modified: { borderInlineStartColor: colors.warn },
  inside: { borderInlineStartColor: colors.warn },
  removed: { borderInlineStartColor: colors.danger },
  unchanged: { borderInlineStartColor: colors.line },
  none: { borderInlineStartColor: colors.line },
});

const s = stylex.create({
  card: {
    borderColor: colors.line,
    borderRadius: 10,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 10,
    paddingInline: 12,
    backgroundColor: colors.pop,
    boxShadow: `0 8px 24px ${colors.popShadow}`,
    boxSizing: "border-box",
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 12.5,
    position: "absolute",
    transform: "translate(var(--cx), var(--cy))",
    zIndex: 40,
    left: 0,
    maxHeight: "70%",
    maxWidth: 380,
    overflowY: "auto",
    top: 0,
    width: "max-content",
  },
  // A part's or trunk's card never takes the pointer: it's only read. A line's stays for its picks.
  inert: { pointerEvents: "none" },
  pinnedCard: { zIndex: 41, maxWidth: 420, paddingTop: 0, },
  dragHead: { gap: 8, marginInline: -12, paddingBlock: 8, paddingInline: 12, alignItems: "center", cursor: "grab", display: "flex", touchAction: "none", borderBottomColor: colors.line, borderBottomStyle: "solid", borderBottomWidth: 1, marginBottom: 6, },
  headTitle: { flexGrow: 1, fontWeight: 650 },
  close: { padding: 2, borderWidth: 0, backgroundColor: "transparent", color: colors.muted, cursor: "pointer", fontSize: 16, lineHeight: 1, },
  kind: { color: colors.muted, fontSize: 11.5 },
  name: { marginBlock: 2, fontSize: 14, fontWeight: 650, overflowWrap: "anywhere", },
  p: { marginBlock: 4, lineHeight: 1.4, overflowWrap: "anywhere", },
  changeLine: { borderInlineStartStyle: "solid", borderInlineStartWidth: 3, paddingInlineStart: 8 },
  small: { color: colors.muted, fontSize: 11.5, lineHeight: 1.4 },
  strong: { fontWeight: 600 },
  warn: { color: colors.warn },
  badge: { borderRadius: 999, borderStyle: "solid", borderWidth: 1, paddingInline: 6, fontSize: 10.5, fontWeight: 600, },
  list: { margin: 0, padding: 0, gap: 6, listStyle: "none", display: "flex", flexDirection: "column", marginTop: 4, },
  rows: { gap: 0 },
  connection: { borderTopColor: colors.line, borderTopStyle: "solid", borderTopWidth: 1, paddingTop: 5 },
  drawnAs: { gap: 3, display: "flex", flexDirection: "column", borderTopColor: colors.line, borderTopStyle: "solid", borderTopWidth: 1, marginTop: 8, paddingTop: 6, },
  label: { color: colors.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" },
  drawnRow: { gap: 8, alignItems: "center", display: "flex", fontSize: 12, },
  pick: { padding: 0, borderWidth: 0, textDecoration: { default: "none", ":hover": "underline" }, backgroundColor: "transparent", color: colors.accent, cursor: "pointer", fontFamily: fonts.ui, fontSize: 11.5, },
  row: {
    borderRadius: 5,
    borderWidth: 0,
    paddingBlock: 3,
    paddingInline: 6,
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    color: colors.fg,
    cursor: "pointer",
    fontFamily: fonts.ui,
    fontSize: 12,
    textAlign: "start",
    width: "100%",
  },
});
