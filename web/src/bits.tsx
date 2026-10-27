// Small pieces the list and the detail share: an issue's state icon, a user's avatar, and
// sub-issue progress as a ring.
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";
import { colors } from "./tokens.stylex";

export type IssueState = "open" | "done" | "notPlanned";

/** Which of the three states an issue shows: open, closed as completed, or not planned. */
export function issueState(i: { state: string; state_reason: string | null }): IssueState {
  return i.state === "open" ? "open" : i.state_reason === "not_planned" ? "notPlanned" : "done";
}

export const STATE_LABEL: Record<IssueState, string> = {
  open: "Open",
  done: "Closed as completed",
  notPlanned: "Closed as not planned",
};

/** The state icon, in the state's colour unless `plain` (then it takes the text colour). */
export function StateIcon(props: { state: IssueState; plain?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      role="img"
      aria-label={STATE_LABEL[props.state]}
      {...stylex.attrs(s.icon, !props.plain && s[props.state])}
    >
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" />
      <Show when={props.state === "open"}>
        <circle cx="8" cy="8" r="1.5" fill="currentColor" />
      </Show>
      <Show when={props.state === "done"}>
        <path d="M5.2 8.2 7.1 10l3.7-4" fill="none" stroke="currentColor" stroke-width="1.5" />
      </Show>
      <Show when={props.state === "notPlanned"}>
        <path d="M3.8 12.2 12.2 3.8" stroke="currentColor" stroke-width="1.5" />
      </Show>
    </svg>
  );
}

/** A user's initial on a colour that stays the same for their login. */
export function Avatar(props: { login: string; size?: 11 | 14 | 18 | 20 }) {
  return (
    <span
      title={props.login}
      {...stylex.attrs(s.avatar, props.size && SIZES[props.size], AVATARS[hash(props.login) % AVATARS.length])}
    >
      {props.login.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Sub-issue progress: closed descendants against all of them, as a ring. */
export function ProgressRing(props: { done: number; total: number }) {
  // The ring's circumference (r = 6).
  const C = 37.7;
  const filled = () => (props.total > 0 ? (props.done / props.total) * C : 0);
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" {...stylex.attrs(s.icon)}>
      <circle cx="8" cy="8" r="6" fill="none" stroke-width="3" {...stylex.attrs(s.ring)} />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke-width="3"
        stroke-dasharray={`${filled()} ${C}`}
        transform="rotate(-90 8 8)"
        {...stylex.attrs(s.ringDone)}
      />
    </svg>
  );
}

/** A stable small hash, so a login keeps its avatar colour. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const s = stylex.create({
  icon: {
    flexShrink: 0,
  },
  open: {
    color: colors.open,
  },
  done: {
    color: colors.done,
  },
  notPlanned: {
    color: colors.notPlanned,
  },
  avatar: {
    borderRadius: "50%",
    alignItems: "center",
    color: colors.avatarFg,
    display: "inline-flex",
    flexShrink: 0,
    fontSize: 10,
    fontWeight: 600,
    justifyContent: "center",
    height: 18,
    width: 18,
  },
  ring: {
    stroke: colors.line,
  },
  ringDone: {
    stroke: colors.done,
  },
});

const sizes = stylex.create({
  s11: { fontSize: 7, height: 11, width: 11 },
  s14: { fontSize: 8, height: 14, width: 14 },
  s20: { fontSize: 11, height: 20, width: 20 },
});
const SIZES = { 11: sizes.s11, 14: sizes.s14, 18: undefined, 20: sizes.s20 };

const a = stylex.create({
  c0: { backgroundColor: colors.avatar0 },
  c1: { backgroundColor: colors.avatar1 },
  c2: { backgroundColor: colors.avatar2 },
  c3: { backgroundColor: colors.avatar3 },
  c4: { backgroundColor: colors.avatar4 },
  c5: { backgroundColor: colors.avatar5 },
});
const AVATARS = [a.c0, a.c1, a.c2, a.c3, a.c4, a.c5];
