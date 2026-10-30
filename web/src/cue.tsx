// The shift cue's parts that the list's held changes (held.ts) and the detail's (HeldDetail.tsx)
// share: its timing and easing, its timer, the hidden-tab signal that holds every change, the line
// where something will open, and the looks of what will change, what will go and what just arrived.
import * as stylex from "@stylexjs/stylex";
import { createSignal, onCleanup, onSettled, type Accessor } from "solid-js";
import { colors } from "./tokens.stylex";

/** A range of a post's top-level blocks, by position. */
export type Span = { from: number; to: number };

/** What a post shows of held changes: a line before block `at`, blocks that go, blocks that just arrived. */
export type BodyMarks = { line?: { at: number; label: string }; leaving?: Span; tint?: Span };

/** How long the shift cue shows before held changes apply. */
export const CUE_MS = 700;
/** With reduced motion: the still mark's time; then the changes swap in unanimated. */
export const STILL_CUE_MS = 900;
/** The easing every held change moves with. */
export const EASE = "cubic-bezier(0.2, 0, 0, 1)";
/** How long what just arrived keeps its tint. */
export const TINT_MS = 1600;

/** Whether the tab is hidden, kept current: a hidden tab holds every change, so none applies unseen. */
export function createHidden(): Accessor<boolean> {
  const [hidden, setHidden] = createSignal(document.hidden);
  onSettled(() => {
    const visibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  });
  return hidden;
}

/**
 * The cue's timer: `start` runs `done` once the cue has shown (`CUE_MS`, or `STILL_CUE_MS` with
 * reduced motion), restarting it if it's running; `stop` cancels it; `running` says whether it is.
 */
export function createCueTimer(reduced: MediaQueryList) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  onCleanup(stop);
  return {
    start(done: () => void) {
      stop();
      timer = setTimeout(
        () => {
          timer = undefined;
          done();
        },
        reduced.matches ? STILL_CUE_MS : CUE_MS,
      );
    },
    stop,
    running: () => timer !== undefined,
  };
}

/**
 * The shift cue where something will open: a 2 px labelled line of zero height. A span, so that
 * blocks spaced by their type's first and last (md/Markdown.tsx) don't count it.
 */
export function CueLine(props: { label: string; inset?: boolean }) {
  return (
    <span data-perf="cue-line" aria-hidden="true" {...stylex.attrs(s.spot, props.inset && s.inset)}>
      <span {...stylex.attrs(s.line)} />
      <span {...stylex.attrs(s.label)}>{props.label}</span>
    </span>
  );
}

const fade = stylex.keyframes({
  from: { boxShadow: `inset 0 0 0 100vmax ${colors.cueTint}` },
  to: { boxShadow: "inset 0 0 0 100vmax transparent" },
});

/** The cue's looks, and the tint on what just arrived. */
export const cueStyles = stylex.create({
  // A part that will change: outlined on its own line.
  change: {
    backgroundColor: colors.cueTint,
    outlineColor: colors.accent,
    outlineOffset: -2,
    outlineStyle: "solid",
    outlineWidth: 2,
  },
  // What will go: an outline inside it (a list row's paint is contained) and a tint, hovered too.
  leave: {
    backgroundColor: {
      default: colors.cueLeave,
      ":hover": colors.cueLeave,
    },
    outlineColor: colors.danger,
    outlineOffset: -2,
    outlineStyle: "solid",
    outlineWidth: 2,
  },
  // What just arrived, its tint fading.
  tint: {
    animationDuration: `${TINT_MS}ms`,
    animationName: fade,
    animationTimingFunction: "ease-out",
  },
});

const s = stylex.create({
  spot: {
    display: "block",
    pointerEvents: "none",
    position: "relative",
    zIndex: 1,
    height: 0,
  },
  inset: {
    marginInline: 16,
  },
  line: {
    borderRadius: 1,
    backgroundColor: colors.accent,
    position: "absolute",
    height: 2,
    left: -6,
    right: -6,
    top: -1,
  },
  // White on the deeper accent: 5.17:1 in both themes.
  label: {
    borderRadius: 8,
    paddingInline: 6,
    backgroundColor: colors.accentBg,
    color: colors.accentFg,
    fontSize: 11,
    fontWeight: 500,
    lineHeight: "16px",
    position: "absolute",
    whiteSpace: "nowrap",
    right: 0,
    top: -9,
  },
});
