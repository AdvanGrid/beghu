// The canvas's controls. The toolbar above it (shared with Path, slice 10): Lens, Show, Colour by,
// Boxes' two slots, Outlines, the Lines menu, and the no-lines grid's toggle; each a view-wide
// setting in the URL, replacing its history entry (slice 7). The bar under it: ← Back (saying
// what it undoes) and Start over. The zoom bar, floating over the canvas's bottom right: − / + /
// Fit and Fold to groups.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, onSettled, Show, type Element } from "solid-js";
import type { Edge } from "../../bindings/analysis";
import { colors, fonts } from "../../tokens.stylex";
import { useNav } from "../nav";
import { WHENS } from "../state";
import { ui } from "../ui";
import { facetsFor, lensHas, LENSES, SHOWS } from "./settings";
import { useCanvas } from "./store";

const WHEN_WORD = { runtime: "Run time", build: "Build", test: "Tests" } as const;
const KINDS = ["call", "data", "event"] as const;
const KIND_WORD = { call: "Calls", data: "Data", event: "Events" } as const;

export function Toolbar() {
  const nav = useNav();
  const c = useCanvas();
  const m = () => nav.model();
  const st = () => c.settings();
  const boxes = (own: string, outside: string) => nav.set("boxes", `${own},${outside}`);
  return (
    <div {...stylex.attrs(s.bar)} role="toolbar" aria-label="What the canvas draws" data-perf="canvas-toolbar">
      <Picker label="Lens" perf="lens" value={nav.state().lens === "order" ? "modules" : st().lens} onChange={(v) => nav.set("lens", v === "modules" ? undefined : v)}>
        <For each={LENSES}>
          {(l) => (
            <option value={l.id} disabled={l.disabled}>
              {l.name}
              {l.disabled ? " (coming soon)" : ""}
            </option>
          )}
        </For>
      </Picker>
      <Picker label="Show" perf="show" value={st().show} onChange={(v) => nav.set("show", v === "all" ? undefined : v)}>
        <For each={SHOWS}>{(x) => <option value={x.id}>{x.name}</option>}</For>
      </Picker>
      <Picker label="Colour by" perf="colour" value={st().colour ?? "change"} onChange={(v) => nav.set("colour", v === "change" ? undefined : v)}>
        <option value="change">The change</option>
        <For each={facetsFor(m())}>{(f) => <option value={f.id}>{f.name}</option>}</For>
      </Picker>
      <span {...stylex.attrs(s.group)} role="group" aria-label="Boxes">
        <span {...stylex.attrs(s.label)}>Boxes</span>
        <Picker label="Own parts" perf="boxes-own" small value={st().own ?? "none"} onChange={(v) => boxes(v, st().outside ?? "none")}>
          <option value="folder">Folder</option>
          <For each={facetsFor(m(), "inside-")}>{(f) => <option value={f.id}>{f.name}</option>}</For>
          <option value="none">None</option>
        </Picker>
        <Picker label="Outside" perf="boxes-outside" small value={st().outside ?? "none"} onChange={(v) => boxes(st().own ?? "none", v)}>
          <For each={facetsFor(m(), "outside-")}>{(f) => <option value={f.id}>{f.name}</option>}</For>
          <option value="none">None</option>
        </Picker>
      </span>
      <Picker label="Outlines" perf="outlines" value={st().outlines ?? "none"} onChange={(v) => nav.set("outlines", v === "none" ? undefined : v)}>
        <option value="none">None</option>
        <For each={facetsFor(m())}>{(f) => <option value={f.id}>{f.name}</option>}</For>
      </Picker>
      <LinesMenu />
      <Show when={c.scene().lonely.length > 0 || c.showLonely()}>
        <button type="button" {...stylex.attrs(ui.button)} aria-pressed={c.showLonely() ? "true" : "false"} data-perf="show-lonely" onClick={() => c.setShowLonely(!c.showLonely())}>
          {c.showLonely() ? "Hide" : "Show"} {c.scene().lonely.length} {c.scene().lonely.length === 1 ? "part" : "parts"} with no lines
        </button>
      </Show>
    </div>
  );
}

function Picker(props: { label: string; perf: string; value: string; small?: boolean; onChange: (v: string) => void; children: Element }) {
  return (
    <label {...stylex.attrs(s.picker)}>
      <span {...stylex.attrs(props.small ? s.subLabel : s.label)}>{props.label}</span>
      <select {...stylex.attrs(s.select)} data-perf={`picker-${props.perf}`} value={props.value} onChange={(e) => props.onChange(e.currentTarget.value)}>
        {props.children}
      </select>
    </label>
  );
}

/**
 * The Lines menu: When (run time on, build and test off) and Kind (calls, data, events), each
 * with the connections it draws at this level. Data flow fixes Kind to lines with `data`, shown
 * greyed.
 */
function LinesMenu() {
  const nav = useNav();
  const c = useCanvas();
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  const st = () => c.settings();
  /** The connections a value would draw at this level: the lens's lines with it whose ends are drawn apart. */
  const counts = createMemo(() => {
    const sc = c.scene();
    const m = nav.model();
    const drawnApart = (e: Edge) => {
      const a = sc.holder(e.from), b = sc.holder(e.to);
      return a !== undefined && b !== undefined && a !== b;
    };
    const es = m.a.edges.filter((e) => lensHas(e, st().lens, m) && drawnApart(e));
    const when = new Map<string, number>(), kind = new Map<string, number>();
    for (const e of es) {
      if (st().lens === "data" || st().lines.kind.has(e.kind)) when.set(e.when, (when.get(e.when) ?? 0) + 1);
      if (st().lines.when.has(e.when)) kind.set(e.kind, (kind.get(e.kind) ?? 0) + 1);
    }
    return { when, kind };
  });
  const toggle = (v: string) => {
    const l = st().lines;
    const on = new Set([...l.when, ...l.kind]);
    if (on.has(v)) on.delete(v);
    else on.add(v);
    nav.set("lines", [...on].join(",") || "none");
  };
  const close = (e: PointerEvent) => {
    if (!root.contains(e.target as Node)) setOpen(false);
  };
  onSettled(() => {
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  });
  const fixed = () => st().lens === "data";
  return (
    <div ref={root} {...stylex.attrs(s.menuRoot)}>
      <button type="button" {...stylex.attrs(ui.button)} aria-expanded={open() ? "true" : "false"} aria-haspopup="true" data-perf="lines-menu" onClick={() => setOpen(!open())}>
        Lines ▾
      </button>
      <Show when={open()}>
        <div {...stylex.attrs(s.menu)} role="group" aria-label="Lines shown" data-perf="lines-when" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          <div {...stylex.attrs(s.menuHead)}>When</div>
          <For each={WHENS}>
            {(w) => (
              <label {...stylex.attrs(s.check)} data-perf="lines-option" data-value={w}>
                <input type="checkbox" checked={st().lines.when.has(w)} onChange={() => toggle(w)} />
                <span {...stylex.attrs(s.grow)}>{WHEN_WORD[w]}</span>
                <span {...stylex.attrs(s.count)} data-perf="lines-count">{counts().when.get(w) ?? 0}</span>
              </label>
            )}
          </For>
          <div {...stylex.attrs(s.menuHead)}>Kind</div>
          <Show when={fixed()}>
            <p {...stylex.attrs(s.fixed)} data-perf="lines-fixed">
              Data flow draws lines with data only.
            </p>
          </Show>
          <For each={KINDS}>
            {(k) => (
              <label {...stylex.attrs(s.check, fixed() && s.greyed)} data-perf="lines-option" data-value={k} aria-disabled={fixed() ? "true" : undefined}>
                <input type="checkbox" checked={fixed() || st().lines.kind.has(k)} disabled={fixed()} onChange={() => toggle(k)} />
                <span {...stylex.attrs(s.grow)}>{KIND_WORD[k]}</span>
                <span {...stylex.attrs(s.count)} data-perf="lines-count">{counts().kind.get(k) ?? 0}</span>
              </label>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** ← Back and Start over, above the canvas. */
export function StepBar() {
  const c = useCanvas();
  const last = () => c.history().at(-1);
  return (
    <div {...stylex.attrs(s.steps)} data-perf="canvas-steps">
      <button type="button" {...stylex.attrs(ui.button)} disabled={!last()} data-perf="canvas-back" onClick={() => c.back()}>
        ← Back
      </button>
      <span {...stylex.attrs(ui.muted, ui.small, s.undoes)} data-perf="canvas-undoes">
        {last() ? `undoes: ${last()!.what}` : "Opens and folds you make can be undone here"}
      </span>
      <span {...stylex.attrs(s.grow)} />
      <button type="button" {...stylex.attrs(ui.button)} disabled={c.history().length === 0 && c.state().open.size === 0 && c.state().folded.size === 0} data-perf="canvas-start-over" onClick={() => c.startOver()}>
        Start over
      </button>
    </div>
  );
}

/** − / + / Fit and Fold to groups, over the canvas's bottom right. */
export function ZoomBar(props: { zoom: () => number; zoomBy: (f: number) => void; fit: () => void }) {
  const c = useCanvas();
  return (
    <div {...stylex.attrs(s.zoom)} data-chrome="" data-perf="zoom-bar" onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <button type="button" {...stylex.attrs(ui.button, s.zoomButton)} aria-label="Zoom out" data-perf="zoom-out" onClick={() => props.zoomBy(0.8)}>
        −
      </button>
      <span {...stylex.attrs(s.zoomText)} data-perf="zoom-level">
        {Math.round(props.zoom() * 100)}%
      </span>
      <button type="button" {...stylex.attrs(ui.button, s.zoomButton)} aria-label="Zoom in" data-perf="zoom-in" onClick={() => props.zoomBy(1.25)}>
        +
      </button>
      <button type="button" {...stylex.attrs(ui.button)} data-perf="zoom-fit" onClick={() => props.fit()}>
        Fit
      </button>
      <button type="button" {...stylex.attrs(ui.button)} data-perf="fold-to-groups" onClick={() => c.foldToGroups()}>
        Fold to groups
      </button>
    </div>
  );
}

const s = stylex.create({
  bar: {
    paddingBlock: 6,
    paddingInline: 12,
    alignItems: "center",
    backgroundColor: colors.bg,
    columnGap: 12,
    display: "flex",
    flexShrink: 0,
    flexWrap: "wrap",
    fontFamily: fonts.ui,
    rowGap: 6,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
  },
  picker: { gap: 5, alignItems: "center", display: "inline-flex", },
  label: { color: colors.muted, fontSize: 11.5, fontWeight: 600 },
  subLabel: { color: colors.muted, fontSize: 11 },
  group: { gap: 8, alignItems: "center", display: "inline-flex", },
  select: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.bg,
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 12,
    height: 24,
    maxWidth: 210,
  },
  menuRoot: { position: "relative" },
  menu: {
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 2,
    paddingBlock: 8,
    paddingInline: 10,
    backgroundColor: colors.pop,
    boxShadow: `0 6px 20px ${colors.popShadow}`,
    display: "flex",
    flexDirection: "column",
    position: "absolute",
    zIndex: 30,
    left: 0,
    minWidth: 220,
    top: 30,
  },
  menuHead: { color: colors.muted, fontSize: 11, fontWeight: 650, letterSpacing: "0.04em", textTransform: "uppercase", marginTop: 4, },
  check: { gap: 6, paddingBlock: 2, alignItems: "center", cursor: "pointer", display: "flex", fontSize: 12.5, },
  greyed: { color: colors.muted, cursor: "default", opacity: 0.6 },
  grow: { flexGrow: 1 },
  count: { color: colors.muted, fontSize: 11.5, fontVariantNumeric: "tabular-nums" },
  fixed: { margin: 0, color: colors.muted, fontSize: 11.5, },
  steps: {
    gap: 8,
    paddingBlock: 4,
    paddingInline: 12,
    alignItems: "center",
    backgroundColor: colors.bg,
    display: "flex",
    flexShrink: 0,
    fontFamily: fonts.ui,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
  },
  undoes: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  zoom: {
    padding: 4,
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 4,
    alignItems: "center",
    backgroundColor: colors.pop,
    boxShadow: `0 4px 14px ${colors.popShadow}`,
    display: "flex",
    fontFamily: fonts.ui,
    position: "absolute",
    zIndex: 20,
    bottom: 12,
    right: 12,
  },
  zoomButton: { width: 26 },
  zoomText: { color: colors.muted, fontSize: 11.5, fontVariantNumeric: "tabular-nums", textAlign: "center", width: 40 },
});
