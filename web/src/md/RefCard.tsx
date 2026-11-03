// A post's reference to an issue or PR the mirror holds, on hover or focus: a small card with its
// state, kind, `owner/repo#n` and title, everything from the refs map the post came with (no
// fetch). The pointer on it also outlines the issue's own row in the list, when it's in view
// (pointed.ts).
import * as stylex from "@stylexjs/stylex";
import { createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "@solidjs/web";
import { issueState, STATE_LABEL, StateIcon } from "../bits";
import { point, unpoint } from "../pointed";
import { colors, fonts } from "../tokens.stylex";
import { refAt, type RefAt } from "./walker";

/** The card's width, as its style sets it. */
const WIDTH = 320;

type Shown = RefAt & { at: DOMRect };

/**
 * The card's state for one post, and the handlers that drive it: `over` and `out` (pointer or
 * focus, delegated from the post), opening the card after a short rest and closing it a little
 * after the pointer leaves the link and the card.
 */
export function createRefCard() {
  const [shown, setShown] = createSignal<Shown>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Whether this post's reference (or its card) has the pointer: what its cleanup must undo.
  let pointing = false;
  const over = (e: Event) => {
    const hit = refAt(e.target);
    if (!hit) return;
    clearTimeout(timer);
    pointing = true;
    point(hit.at.target.id, "mention");
    timer = setTimeout(() => hit.a.isConnected && setShown({ ...hit.at, at: hit.a.getBoundingClientRect() }), 300);
  };
  const hide = () => {
    clearTimeout(timer);
    pointing = false;
    unpoint("mention");
    timer = setTimeout(() => setShown(undefined), 150);
  };
  const out = (e: Event & { relatedTarget: EventTarget | null }) => {
    const from = refAt(e.target);
    if (from && !from.a.contains(e.relatedTarget as Node | null)) hide();
  };
  const keep = (id: number) => {
    clearTimeout(timer);
    pointing = true;
    point(id, "mention");
  };
  // A post that goes (another issue opened) takes its card and its row's outline with it.
  onCleanup(() => {
    clearTimeout(timer);
    if (pointing) unpoint("mention");
  });
  return { shown, over, out, keep, hide };
}

export type RefCardState = ReturnType<typeof createRefCard>;

/** The card, over everything, under its link. */
export function RefCard(props: { card: RefCardState }) {
  return (
    <Show when={props.card.shown()}>
      {(c) => {
        const state = () => issueState(c().target);
        const left = () => Math.max(8, Math.min(c().at.left, innerWidth - WIDTH - 8));
        return (
          <Portal>
            <div
              role="tooltip"
              data-perf="ref-card"
              {...stylex.attrs(s.card, s.place(left(), c().at.bottom + 4))}
              onPointerEnter={() => props.card.keep(c().target.id)}
              onPointerLeave={props.card.hide}
            >
              <div {...stylex.attrs(s.head)}>
                <StateIcon state={state()} />
                <span>
                  {c().target.kind === "pr" ? "Pull request" : "Issue"} · {STATE_LABEL[state()]}
                </span>
              </div>
              <div {...stylex.attrs(s.title)}>{c().target.title}</div>
              <div {...stylex.attrs(s.ref)}>{c().ref}</div>
            </div>
          </Portal>
        );
      }}
    </Show>
  );
}

const s = stylex.create({
  card: {
    padding: 10,
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 4,
    backgroundColor: colors.pop,
    boxShadow: `0 8px 24px ${colors.popShadow}`,
    boxSizing: "border-box",
    color: colors.fg,
    display: "flex",
    flexDirection: "column",
    // Portalled to <body>, outside the app's root: its font isn't inherited.
    fontFamily: fonts.ui,
    fontSize: 12.5,
    lineHeight: 1.4,
    position: "fixed",
    zIndex: 50,
    width: 320,
  },
  place: (left: number, top: number) => ({
    left,
    top,
  }),
  head: {
    gap: 6,
    alignItems: "center",
    color: colors.muted,
    display: "flex",
    fontSize: 11.5,
  },
  title: {
    fontWeight: 600,
    overflowWrap: "anywhere",
  },
  ref: {
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 11.5,
  },
});
