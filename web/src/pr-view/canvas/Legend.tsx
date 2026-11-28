// The legend (the key, #155): a card floating over the canvas's bottom left, clear of the zoom
// bar, about 300 px wide and at most about half the canvas's height (it scrolls past that), never
// taking room from the layout. Open on a first visit; × folds it to a "Key" button, remembered per
// browser. It lists only the styles the current drawing uses (key.ts), each row a sample in the
// real style, its words and a count. Hovering a row fades everything not drawn in that style;
// clicking pins it (until clicked again, another row is clicked, or Escape), and the pinned row
// stays highlighted.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, Show } from "solid-js";
import { colors, fonts, graph } from "../../tokens.stylex";
import type { KeyRow, Sample } from "./key";
import { useCanvas } from "./store";
import { FACET_EDGE, FACET_FILL } from "./Canvas";

const KEY_OPEN = "beghu.pr-view-key";

function readOpen(): boolean {
  try {
    return localStorage.getItem(KEY_OPEN) !== "folded";
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    if (open) localStorage.removeItem(KEY_OPEN);
    else localStorage.setItem(KEY_OPEN, "folded");
  } catch {
    // Kept for this page only.
  }
}

/** The legend's rows for what's on screen. */
export function useKeyRows() {
  return useCanvas().rows;
}

export function Legend(props: { hover: (id: string | undefined) => void; pin: () => string | undefined; setPin: (id: string | undefined) => void }) {
  const c = useCanvas();
  const [open, setOpen] = createSignal(readOpen());
  const sections = createMemo(() => {
    const out: { name: string; rows: KeyRow[] }[] = [];
    for (const r of c.rows()) {
      const last = out.at(-1);
      if (last?.name === r.section) last.rows.push(r);
      else out.push({ name: r.section, rows: [r] });
    }
    return out;
  });
  const fold = (on: boolean) => {
    setOpen(on);
    writeOpen(on);
    if (!on) {
      props.hover(undefined);
      props.setPin(undefined);
    }
  };
  // Keep the legend's own pointer from panning or picking on the canvas under it.
  const stop = (e: Event) => e.stopPropagation();
  return (
    <div {...stylex.attrs(s.slot)} data-chrome="" onPointerDown={stop} onClick={stop} onDblClick={stop}>
      <Show
        when={open()}
        fallback={
          <button type="button" {...stylex.attrs(s.keyButton)} data-perf="legend-open" onClick={() => fold(true)}>
            Key
          </button>
        }
      >
        <section {...stylex.attrs(s.card)} aria-label="Key" data-perf="legend" onPointerLeave={() => props.hover(undefined)}>
          <header {...stylex.attrs(s.head)}>
            <span {...stylex.attrs(s.title)}>Key</span>
            <button type="button" {...stylex.attrs(s.close)} aria-label="Fold the key" data-perf="legend-close" onClick={() => fold(false)}>
              ×
            </button>
          </header>
          <div {...stylex.attrs(s.body)} data-perf="legend-body">
            <For each={sections()}>
              {(sec) => (
                <div data-perf="legend-section" data-section={sec.name}>
                  <div {...stylex.attrs(s.section)}>{sec.name}</div>
                  <For each={sec.rows}>
                    {(r) => (
                      <button
                        type="button"
                        {...stylex.attrs(s.row, props.pin() === r.id && s.pinned)}
                        aria-pressed={props.pin() === r.id ? "true" : "false"}
                        data-perf="legend-row"
                        data-row={r.id}
                        onPointerEnter={() => props.hover(r.id)}
                        onPointerLeave={() => props.hover(undefined)}
                        onFocus={() => props.hover(r.id)}
                        onBlur={() => props.hover(undefined)}
                        onClick={() => props.setPin(props.pin() === r.id ? undefined : r.id)}
                      >
                        <SampleView sample={r.sample} />
                        <span {...stylex.attrs(s.words)}>{r.words}</span>
                        <span {...stylex.attrs(s.count)} data-perf="legend-count">
                          {r.count}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </section>
      </Show>
    </div>
  );
}

/** A small drawn sample of a style, as the canvas draws it. */
export function SampleView(props: { sample: Sample }) {
  const x = props.sample;
  switch (x.kind) {
    case "part":
      return (
        <span
          {...stylex.attrs(
            sm.part,
            x.change !== undefined && sm[x.change],
            x.change === "none" && sm.outside,
            x.colour !== undefined && FACET_FILL[x.colour],
            x.none && sm.noValue,
            x.dashed && sm.rest,
            x.faded && sm.faded,
          )}
          aria-hidden="true"
        >
          <Show when={x.stripes}>
            <span {...stylex.attrs(sm.stripe, FACET_FILL[0])} />
            <span {...stylex.attrs(sm.stripe, FACET_FILL[1])} />
            <span {...stylex.attrs(sm.stripe, FACET_FILL[2])} />
          </Show>
        </span>
      );
    case "text":
      return (
        <span {...stylex.attrs(sm.text)} aria-hidden="true">
          {x.text}
        </span>
      );
    case "line":
      return (
        <svg width="36" height="16" viewBox="0 0 36 16" {...stylex.attrs(sm.svg)} aria-hidden="true">
          <path d={`M${x.both ? 9 : 2},8 L27,8`} {...stylex.attrs(sm.line, x.changed && sm.lineStrong, x.dashed && sm.dashed, x.dotted && sm.dotted)} stroke-width={x.thick ? 4 : 1.5} />
          <path d="M34,8 L25,3.5 L25,12.5 Z" {...stylex.attrs(sm.head, x.changed && sm.headStrong)} />
          <Show when={x.both}>
            <path d="M2,8 L11,3.5 L11,12.5 Z" {...stylex.attrs(sm.head, x.changed && sm.headStrong)} />
          </Show>
          <Show when={x.thick}>
            <text x="14" y="5" {...stylex.attrs(sm.count)}>
              3
            </text>
          </Show>
        </svg>
      );
    case "trunk":
      return (
        <svg width="36" height="16" viewBox="0 0 36 16" {...stylex.attrs(sm.svg)} aria-hidden="true">
          <path d="M2,8 L34,8" {...stylex.attrs(sm.trunk)} stroke-width="9" />
          <path d="M2,8 L34,8" {...stylex.attrs(sm.line)} stroke-width="1.5" />
        </svg>
      );
    case "area":
      return <span {...stylex.attrs(sm.area, sm[x.area])} aria-hidden="true" />;
    case "ring":
      return <span {...stylex.attrs(sm.ring, x.colour !== undefined && FACET_EDGE[x.colour], x.more && sm.ringMore)} aria-hidden="true">{x.more ? "+N" : ""}</span>;
  }
}

const s = stylex.create({
  slot: { display: "flex", flexDirection: "column", justifyContent: "flex-end", position: "absolute", zIndex: 20, bottom: 12, left: 12, maxHeight: "50%", },
  keyButton: {
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 6,
    paddingInline: 12,
    backgroundColor: colors.pop,
    boxShadow: `0 4px 14px ${colors.popShadow}`,
    color: colors.fg,
    cursor: "pointer",
    fontFamily: fonts.ui,
    fontSize: 12,
    fontWeight: 650,
  },
  card: {
    borderColor: colors.line,
    borderRadius: 10,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.pop,
    boxShadow: `0 6px 20px ${colors.popShadow}`,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    fontFamily: fonts.ui,
    maxHeight: "100%",
    minHeight: 0,
    width: 300,
  },
  head: { paddingBlock: 6, paddingInline: 12, alignItems: "center", display: "flex", borderBottomColor: colors.line, borderBottomStyle: "solid", borderBottomWidth: 1, },
  title: { flexGrow: 1, fontSize: 12.5, fontWeight: 700 },
  close: { padding: 2, borderWidth: 0, backgroundColor: "transparent", color: colors.muted, cursor: "pointer", fontSize: 16, lineHeight: 1, },
  body: { paddingBlock: 6, paddingInline: 6, overflowY: "auto", },
  section: { paddingBlock: 4, paddingInline: 6, color: colors.muted, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", },
  row: {
    borderRadius: 6,
    borderWidth: 0,
    gap: 8,
    paddingBlock: 3,
    paddingInline: 6,
    alignItems: "center",
    backgroundColor: { default: "transparent", ":hover": colors.hover },
    color: colors.fg,
    cursor: "pointer",
    display: "flex",
    fontFamily: fonts.ui,
    fontSize: 12,
    textAlign: "start",
    width: "100%",
  },
  pinned: { backgroundColor: { default: colors.selected, ":hover": colors.selected }, outlineColor: colors.accent, outlineStyle: "solid", outlineWidth: 1 },
  words: { flexGrow: 1, lineHeight: 1.3 },
  count: { color: colors.muted, fontSize: 11.5, fontVariantNumeric: "tabular-nums" },
});

export const sm = stylex.create({
  part: { borderColor: graph.partEdge, borderRadius: 3, borderStyle: "solid", borderWidth: 1.5, overflow: "hidden", backgroundColor: graph.part, boxSizing: "border-box", display: "inline-flex", flexShrink: 0, height: 16, width: 36, },
  added: { borderColor: colors.open, backgroundColor: graph.addedFill, },
  modified: { borderColor: colors.warn, backgroundColor: graph.modifiedFill, },
  inside: { borderColor: colors.warn, backgroundColor: graph.insideFill, },
  removed: { borderColor: colors.danger, backgroundColor: graph.removedFill, },
  unchanged: {},
  none: {},
  outside: { backgroundColor: graph.outsideFill },
  noValue: { backgroundColor: graph.noValueFill, borderTopColor: graph.noValue },
  rest: { borderStyle: "dashed", backgroundColor: graph.outsideFill, },
  faded: { opacity: 0.4 },
  stripe: { flexGrow: 1, borderTopStyle: "solid", borderTopWidth: 3, },
  text: { color: colors.accent, flexShrink: 0, fontSize: 10, fontWeight: 600, textAlign: "center", whiteSpace: "nowrap", width: 84 },
  svg: { flexShrink: 0 },
  line: { fill: "none", stroke: graph.lineQuiet },
  lineStrong: { stroke: graph.line },
  dashed: { strokeDasharray: "5 3" },
  dotted: { strokeDasharray: "1.5 3" },
  head: { fill: graph.lineQuiet },
  headStrong: { fill: graph.line },
  count: { fill: colors.fg, fontSize: 8, fontWeight: 700 },
  trunk: { stroke: graph.lineQuiet, opacity: 0.45, },
  area: { borderRadius: 4, borderStyle: "solid", borderWidth: 1, boxSizing: "border-box", display: "inline-block", flexShrink: 0, height: 16, width: 36 },
  column: { borderColor: graph.groupEdge, borderStyle: "dashed" },
  changed: { borderColor: colors.warn, borderWidth: 1.5, backgroundColor: graph.changedGroup, },
  frame: { borderColor: graph.partEdge, borderWidth: 1.5, backgroundColor: graph.canvas, },
  box: { borderColor: graph.boxEdge, backgroundColor: graph.boxFill, },
  shared: { borderColor: graph.boxEdge, borderStyle: "dashed", backgroundColor: graph.boxFill, },
  grid: { borderColor: graph.groupEdge, borderStyle: "dotted", borderWidth: 1.5 },
  ring: { borderRadius: 4, borderStyle: "solid", borderWidth: 2, boxSizing: "border-box", color: colors.muted, display: "inline-block", flexShrink: 0, fontSize: 9, fontWeight: 700, lineHeight: "12px", textAlign: "center", height: 16, width: 36, },
  ringMore: { borderColor: graph.partEdge },
});
