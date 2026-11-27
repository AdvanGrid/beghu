// PLACEHOLDER until slice 8 (#182) draws the canvas with our layout (pr-view/layout/): the frame
// the selection sits in, as plain blocks, so the view can be read and its panel driven. Click
// selects a block; double-click (or Enter on a selected one) opens it, showing what's inside;
// "↑ Up" goes back out. Its opens are its own, never in the URL: it opens down to the
// selection on every pick, as the canvas will.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { Node } from "../bindings/analysis";
import { line, part, useNav } from "./nav";
import { ChangeWord, ui } from "./ui";
import { colors } from "../tokens.stylex";

export function Canvas() {
  const nav = useNav();
  const m = () => nav.model();
  /** The part opened by hand, if one is: else the frame the selection sits in. */
  const [opened, setOpened] = createSignal<string>();
  // Every pick opens down to the selection again: the opens by hand go.
  createEffect(nav.sel, () => setOpened(undefined));
  const selected = () => {
    const s = nav.sel();
    return s?.kind === "part" ? s.ids : [];
  };
  /** The frame shown: the opened part, else the parent of the selection's first part, else the system. */
  const frame = createMemo(() => {
    const o = opened();
    if (o !== undefined && m().nodes.has(o)) return o;
    const first = selected()[0];
    const parent = first === undefined ? undefined : m().nodes.get(first)?.parent;
    return parent ?? m().system?.id;
  });
  const blocks = (): Node[] => (frame() === undefined ? [] : (m().children.get(frame()!) ?? []));
  const crumbs = () => {
    const f = frame();
    if (f === undefined) return [];
    return [...m().ancestors(f)].reverse().filter((id) => m().nodes.get(id)?.kind !== "system").concat(m().nodes.get(f)?.kind === "system" ? [] : [f]);
  };
  const open = (n: Node) => {
    if ((m().children.get(n.id) ?? []).length > 0) setOpened(n.id);
  };
  const up = () => {
    const f = frame();
    const parent = f === undefined ? undefined : m().nodes.get(f)?.parent;
    setOpened(parent);
  };
  return (
    <div {...stylex.attrs(s.canvas)} data-perf="canvas" data-placeholder="">
      <div {...stylex.attrs(s.bar)}>
        <button type="button" {...stylex.attrs(ui.button)} disabled={frame() === m().system?.id} onClick={up}>
          ↑ Up
        </button>
        <span {...stylex.attrs(ui.muted, ui.small)} data-perf="canvas-frame">
          {crumbs().length ? crumbs().map((id) => m().nodes.get(id)?.name ?? id).join(" › ") : "The whole system"}
        </span>
        <span {...stylex.attrs(s.spacer)} />
        <span {...stylex.attrs(ui.muted, ui.small)}>The drawing comes with the canvas; a plain list of the frame stands in for it.</span>
      </div>
      <ul {...stylex.attrs(s.blocks)}>
        <For each={blocks()}>
          {(n) => {
            const inside = () => (m().children.get(n.id) ?? []).length;
            // A block body: StyleX evaluates an expression-bodied arrow read inside `attrs`.
            const sel = () => {
              return selected().includes(n.id);
            };
            return (
              <li>
                <button
                  type="button"
                  {...stylex.attrs(s.block, sel() && s.selected)}
                  data-perf="block"
                  data-id={n.id}
                  aria-pressed={sel() ? "true" : "false"}
                  onClick={() => nav.select(part(n.id))}
                  onDblClick={() => open(n)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && sel()) {
                      e.preventDefault();
                      open(n);
                    }
                  }}
                >
                  <span {...stylex.attrs(ui.small, ui.muted)}>
                    {n.kind} · <ChangeWord change={n.change} />
                  </span>
                  <span {...stylex.attrs(s.name)}>{n.name}</span>
                  <Show when={inside() > 0}>
                    <span {...stylex.attrs(ui.small, ui.muted)}>{inside()} inside · double-click ▸</span>
                  </Show>
                </button>
              </li>
            );
          }}
        </For>
      </ul>
      <Show when={nav.sel()?.kind === "line"}>
        <p {...stylex.attrs(ui.p, ui.muted, ui.small, s.lineNote)}>
          Selected: {(nav.sel() as { ids: string[] }).ids.map((id) => {
            const e = m().edges.get(id);
            return e ? `${m().name(e.from)} → ${m().name(e.to)}` : id;
          }).join(", ")}
          {" · "}
          <button type="button" {...stylex.attrs(ui.pick, ui.pickAccent)} onClick={() => nav.select(undefined)}>
            Deselect
          </button>
        </p>
      </Show>
      <Show when={nav.sel() === undefined && m().a.edges.length > 0}>
        <p {...stylex.attrs(ui.p, ui.muted, ui.small, s.lineNote)}>
          {m().a.edges.length} lines · {m().a.edges.filter((e) => e.change !== "unchanged").length} new or changed ·{" "}
          <button type="button" {...stylex.attrs(ui.pick, ui.pickAccent)} onClick={() => nav.select(line(m().a.edges[0]!.id))}>
            the first
          </button>
        </p>
      </Show>
    </div>
  );
}

const s = stylex.create({
  canvas: {
    padding: 16,
    gap: 12,
    overflow: "auto",
    backgroundColor: colors.bgRaised,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    height: "100%",
  },
  bar: { gap: 10, alignItems: "center", display: "flex", flexWrap: "wrap" },
  spacer: { flexGrow: 1 },
  blocks: {
    margin: 0,
    padding: 0,
    gap: 10,
    listStyle: "none",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  },
  block: {
    font: "inherit",
    padding: 10,
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 3,
    backgroundColor: { default: colors.bg, ":hover": colors.hover },
    color: colors.fg,
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    textAlign: "start",
    minHeight: 64,
    width: "100%",
  },
  selected: { borderColor: colors.accent, backgroundColor: colors.selected },
  name: { fontWeight: 600, overflowWrap: "anywhere" },
  lineNote: { marginTop: 4 },
});
