// The PR view's shared pieces: the panel's styles, the change marks, and the fold that mounts its
// content only once opened (depth is pulled, one level at a time: nothing under a fold renders,
// or reads the claims, until the reader opens it).
import * as stylex from "@stylexjs/stylex";
import { createSignal, Show, type Element } from "solid-js";
import type { Change } from "../bindings/analysis";
import { colors, fonts } from "../tokens.stylex";

/** A change's sign, for the eye beside its words. */
export const SIGN: Record<Change, string> = { added: "+", removed: "−", modified: "~", unchanged: "·" };
/** A change in words. */
export const CHANGE: Record<Change, string> = { added: "added", removed: "removed", modified: "changed", unchanged: "unchanged" };

export const changeText = stylex.create({
  added: { color: colors.open },
  removed: { color: colors.danger },
  modified: { color: colors.warn },
  unchanged: { color: colors.muted },
});

/** A change's sign, coloured, with its word for screen readers and the tooltip. */
export function Mark(props: { change: Change }) {
  return (
    <span {...stylex.attrs(ui.mark, changeText[props.change])} title={CHANGE[props.change]} aria-label={CHANGE[props.change]}>
      {SIGN[props.change]}
    </span>
  );
}

/** A change in words, coloured. */
export function ChangeWord(props: { change: Change }) {
  return <span {...stylex.attrs(changeText[props.change])}>{CHANGE[props.change]}</span>;
}

/**
 * A fold: its summary always, its content only from the first time it's opened (and kept after,
 * so a fold closed and opened again keeps what it loaded).
 */
export function Fold(props: { summary: Element; children: Element; open?: boolean; perf?: string; nested?: boolean }) {
  const [opened, setOpened] = createSignal(props.open ?? false);
  return (
    <details
      {...stylex.attrs(ui.fold, props.nested && ui.foldNested)}
      open={props.open}
      data-perf={props.perf}
      onToggle={(e) => {
        if (e.currentTarget.open) setOpened(true);
      }}
    >
      <summary {...stylex.attrs(ui.summary)}>{props.summary}</summary>
      <Show when={opened()}>
        <div {...stylex.attrs(ui.foldBody)}>{props.children}</div>
      </Show>
    </details>
  );
}

export const ui = stylex.create({
  h2: { margin: 0, fontSize: 16, fontWeight: 650, lineHeight: 1.3, overflowWrap: "anywhere" },
  h3: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: 650,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    marginBottom: 6,
    marginTop: 18,
  },
  p: { margin: 0, lineHeight: 1.45, overflowWrap: "anywhere" },
  muted: { color: colors.muted },
  small: { fontSize: 12 },
  mono: { fontFamily: fonts.mono, fontSize: 11.5 },
  stack: { gap: 6, display: "flex", flexDirection: "column" },
  row: { gap: 6, alignItems: "baseline", display: "flex", flexWrap: "wrap" },
  list: { margin: 0, padding: 0, gap: 4, listStyle: "none", display: "flex", flexDirection: "column" },
  item: { gap: 6, alignItems: "baseline", display: "flex", lineHeight: 1.4 },
  mark: { flexShrink: 0, fontFamily: fonts.mono, fontWeight: 700, textAlign: "center", width: 12 },
  faded: { opacity: 0.55 },
  // A pick: text that selects what it names.
  pick: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    textDecoration: { default: "none", ":hover": "underline" },
    backgroundColor: "transparent",
    color: colors.fg,
    cursor: "pointer",
    overflowWrap: "anywhere",
    textAlign: "start",
  },
  pickAccent: { color: colors.accent },
  link: {
    textDecoration: { default: "none", ":hover": "underline" },
    color: colors.accent,
    overflowWrap: "anywhere",
  },
  button: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 8,
    backgroundColor: { default: colors.bg, ":disabled": colors.bg, ":hover": colors.hover, },
    color: { default: colors.fg, ":disabled": colors.muted },
    cursor: { default: "pointer", ":disabled": "default" },
    fontFamily: fonts.ui,
    fontSize: 12,
    fontWeight: 600,
    height: 24,
  },
  fold: { marginTop: 4 },
  foldNested: { marginInlineStart: 2 },
  summary: { cursor: "pointer", lineHeight: 1.4, overflowWrap: "anywhere" },
  foldBody: {
    gap: 6,
    paddingBlock: 6,
    borderInlineStartColor: colors.line,
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 2,
    display: "flex",
    flexDirection: "column",
    marginInlineStart: 4,
    paddingInlineStart: 10,
  },
  chip: {
    borderColor: colors.line,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 6,
    color: colors.muted,
    fontSize: 11,
    whiteSpace: "nowrap",
  },
  warnChip: {
    borderColor: colors.warn,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 7,
    color: colors.warn,
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
  note: {
    margin: 0,
    padding: 8,
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.bgRaised,
    fontSize: 12,
    lineHeight: 1.45,
  },
});
