// Small pieces the list and the detail share: an issue's state icon, a PR's status icon and its
// review chip, a user's avatar, sub-issue progress as a ring, the button that reads as a link, and
// how a control the account's role leaves out is withheld.
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";
import type { PrStatus } from "./bindings/PrStatus";
import type { ReviewDecision } from "./bindings/ReviewDecision";
import { colors } from "./tokens.stylex";

/** A button that reads as a link: underlined, in the accent colour (Retry, Resync). */
export const link = stylex.create({
  button: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    textDecoration: "underline",
    backgroundColor: "transparent",
    color: colors.accent,
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
  },
});

/**
 * A control the account's role leaves out (roles.rs): hidden by `hide.withheld` (its room kept, so
 * a role change moves nothing), and `withheld`'s attributes take it out of the tab order and the
 * accessibility tree.
 */
export const hide = stylex.create({
  withheld: {
    pointerEvents: "none",
    visibility: "hidden",
  },
});

export function withheld(gone: boolean) {
  return gone ? { "aria-hidden": "true" as const, tabindex: -1, "data-withheld": "true" } : {};
}

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

export const PR_LABEL: Record<PrStatus, string> = {
  open: "Open pull request",
  draft: "Draft pull request",
  merged: "Merged pull request",
  closed: "Closed pull request",
};

/** A PR's status icon (GitHub's pull-request shape; merged, its merge shape), in the status's colour unless `plain`. */
export function PrIcon(props: { status: PrStatus; plain?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      role="img"
      aria-label={PR_LABEL[props.status]}
      data-pr-status={props.status}
      {...stylex.attrs(s.icon, !props.plain && pr[props.status])}
    >
      <circle cx="4" cy="3.5" r="1.75" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="4" cy="12.5" r="1.75" fill="none" stroke="currentColor" stroke-width="1.5" />
      <Show
        when={props.status === "merged"}
        fallback={
          <>
            <path d="M4 5.25v5.5" fill="none" stroke="currentColor" stroke-width="1.5" />
            <circle cx="12" cy="12.5" r="1.75" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path
              d="M12 10.75V6.5a2 2 0 0 0-2-2H7.25M8.75 3l-1.5 1.5 1.5 1.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-dasharray={props.status === "draft" ? "1.5 1.5" : undefined}
            />
          </>
        }
      >
        <path d="M4 5.25v5.5M4 5.5c0 3 2.5 3.5 6.25 3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <circle cx="12" cy="9" r="1.75" fill="none" stroke="currentColor" stroke-width="1.5" />
      </Show>
    </svg>
  );
}

export const REVIEW_LABEL: Record<ReviewDecision, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "Review required",
};

/** The review decision in a list row's labels column, where room is short. */
const REVIEW_SHORT: Record<ReviewDecision, string> = {
  approved: "Approved",
  changes_requested: "Changes",
  review_required: "Review",
};

/** A PR's review decision as a chip, in its colour; `compact` in a list row. */
export function ReviewChip(props: { review: ReviewDecision; compact?: boolean }) {
  return (
    <span
      {...stylex.attrs(s.chip, props.compact && s.compactChip, review[props.review])}
      data-perf="review"
      data-review={props.review}
      title={`Review: ${REVIEW_LABEL[props.review]}`}
    >
      {(props.compact ? REVIEW_SHORT : REVIEW_LABEL)[props.review]}
    </span>
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
  chip: {
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    overflow: "hidden",
    paddingInline: 7,
    alignItems: "center",
    boxSizing: "border-box",
    display: "inline-flex",
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 500,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    height: 18,
    maxWidth: "100%",
  },
  compactChip: {
    paddingInline: 5,
    fontSize: 10,
    height: 14,
  },
  ring: {
    stroke: colors.line,
  },
  ringDone: {
    stroke: colors.done,
  },
});

const pr = stylex.create({
  open: { color: colors.open },
  draft: { color: colors.notPlanned },
  merged: { color: colors.done },
  closed: { color: colors.danger },
});

const review = stylex.create({
  approved: { borderColor: colors.open, color: colors.open },
  changes_requested: { borderColor: colors.danger, color: colors.danger },
  review_required: { borderColor: colors.unowned, color: colors.unowned },
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
