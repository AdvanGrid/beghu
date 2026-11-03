// Small pieces the list and the detail share: an issue's state icon, a PR's status icon and its
// review chip, a user's avatar, sub-issue progress as a ring, the button that reads as a link, and
// how a control the account's role leaves out is withheld.
import * as stylex from "@stylexjs/stylex";
import { Show, type Element } from "solid-js";
import type { PrStatus } from "./bindings/PrStatus";
import type { ReviewDecision } from "./bindings/ReviewDecision";
import { cx, cxMap, cxTable } from "./cx";
import { rowAvatars } from "./layout.stylex";
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

// The state icon's one path each: the ring (r 6.25), and inside it the open state's dot (a ring of
// r 0.75 under the 1.5 px stroke, so a disc of r 1.5), the completed state's check or the not
// planned state's slash. One element, with no marker for a choice between parts: a list row builds
// and styles one node for it. Plain constants, so a template that names one has it inlined.
const OPEN_PATH = "M8 1.75a6.25 6.25 0 1 1 0 12.5a6.25 6.25 0 1 1 0-12.5zM8 7.25a.75.75 0 1 1 0 1.5a.75.75 0 1 1 0-1.5z";
const DONE_PATH = "M8 1.75a6.25 6.25 0 1 1 0 12.5a6.25 6.25 0 1 1 0-12.5zM5.2 8.2 7.1 10l3.7-4";
const NOT_PLANNED_PATH = "M8 1.75a6.25 6.25 0 1 1 0 12.5a6.25 6.25 0 1 1 0-12.5zM3.8 12.2 12.2 3.8";
const STATE_PATH: Record<IssueState, string> = { open: OPEN_PATH, done: DONE_PATH, notPlanned: NOT_PLANNED_PATH };

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
      <path d={STATE_PATH[props.state]} fill="none" stroke="currentColor" stroke-width="1.5" />
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

/** What a list row's state icon shows: its issue's state, or its PR's status. */
export type RowIconKey = IssueState | `pr-${PrStatus}`;

/** A list row's icon key. */
export function rowIconKey(r: { state: string; state_reason: string | null; pr: { status: PrStatus } | null }): RowIconKey {
  return r.pr ? `pr-${r.pr.status}` : issueState(r);
}

/**
 * The state icons a list row shows, one static template per key: nothing in them is reactive, and
 * they carry no class (an element's `class` binding is an effect), so the row's state cell takes
 * the colour (ROW_ICON_COLOUR) and the icon paints in currentColor. The same shapes as StateIcon's
 * and PrIcon's. Unclipped as s.icon has them, by the `overflow` presentation attribute in the
 * template, which costs the row nothing.
 */
export const ROW_ICONS: Record<RowIconKey, () => Element> = {
  open: () => (
    <svg viewBox="0 0 16 16" width="16" height="16" overflow="visible" role="img" aria-label="Open">
      <path d={OPEN_PATH} fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  ),
  done: () => (
    <svg viewBox="0 0 16 16" width="16" height="16" overflow="visible" role="img" aria-label="Closed as completed">
      <path d={DONE_PATH} fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  ),
  notPlanned: () => (
    <svg viewBox="0 0 16 16" width="16" height="16" overflow="visible" role="img" aria-label="Closed as not planned">
      <path d={NOT_PLANNED_PATH} fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  ),
  "pr-open": () => prShape("open"),
  "pr-draft": () => prShape("draft"),
  "pr-closed": () => prShape("closed"),
  "pr-merged": () => (
    <svg viewBox="0 0 16 16" width="16" height="16" overflow="visible" role="img" aria-label="Merged pull request" data-pr-status="merged">
      <circle cx="4" cy="3.5" r="1.75" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="4" cy="12.5" r="1.75" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M4 5.25v5.5M4 5.5c0 3 2.5 3.5 6.25 3.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="12" cy="9" r="1.75" fill="none" stroke="currentColor" stroke-width="1.5" />
    </svg>
  ),
};

/** The pull-request shape (open, draft, closed), for ROW_ICONS. */
function prShape(status: Exclude<PrStatus, "merged">) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" overflow="visible" role="img" aria-label={PR_LABEL[status]} data-pr-status={status}>
      <circle cx="4" cy="3.5" r="1.75" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="4" cy="12.5" r="1.75" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path d="M4 5.25v5.5" fill="none" stroke="currentColor" stroke-width="1.5" />
      <circle cx="12" cy="12.5" r="1.75" fill="none" stroke="currentColor" stroke-width="1.5" />
      <path
        d="M12 10.75V6.5a2 2 0 0 0-2-2H7.25M8.75 3l-1.5 1.5 1.5 1.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-dasharray={status === "draft" ? "1.5 1.5" : undefined}
      />
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
      class={REVIEW_CHIP[props.compact ? 1 : 0]![props.review]}
      data-perf="review"
      data-review={props.review}
      title={`Review: ${REVIEW_LABEL[props.review]}`}
      textContent={(props.compact ? REVIEW_SHORT : REVIEW_LABEL)[props.review]}
    />
  );
}

/** A user's initial on a colour that stays the same for their login. */
export function Avatar(props: { login: string; size?: 11 | 14 | 18 | 20 }) {
  return <span title={props.login} class={AVATAR[avatarLook(props.login, props.size)]} textContent={props.login.slice(0, 1).toUpperCase()} />;
}

/** The entry of AVATAR for `login` at `size`. */
function avatarLook(login: string, size: 11 | 14 | 18 | 20 = 18): number {
  return SIZE_INDEX[size] * AVATARS.length + (hash(login) % AVATARS.length);
}

/** Sub-issue progress: closed descendants against all of them, as a ring. */
export function ProgressRing(props: { done: number; total: number }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" class={ICON}>
      <circle cx="8" cy="8" r="6" fill="none" stroke-width="3" class={RING} />
      <circle cx="8" cy="8" r="6" fill="none" stroke-width="3" stroke-dasharray={ringDash(props.done, props.total)} transform="rotate(-90 8 8)" class={RING_DONE} />
    </svg>
  );
}

/** The ring's circumference (r = 6). */
const C = 37.7;

/** The filled part of the ring's stroke, then the rest. */
function ringDash(done: number, total: number): string {
  return `${total > 0 ? (done / total) * C : 0} ${C}`;
}

/** A stable small hash, so a login keeps its avatar colour. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const s = stylex.create({
  // Nothing an icon draws leaves its viewBox, so it needn't clip as the UA's `svg { overflow:
  // hidden }` has it do: in a list row each clip is a paint chunk more for the compositor to sort
  // through on every frame that paints.
  icon: {
    overflow: "visible",
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
    height: rowAvatars.size,
    width: rowAvatars.size,
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
  // As tall as a list row's label pills and blocker chips.
  compactChip: {
    paddingInline: 5,
    fontSize: 10,
    height: 15,
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
const SIZES = [sizes.s11, sizes.s14, undefined, sizes.s20];
const SIZE_INDEX = { 11: 0, 14: 1, 18: 2, 20: 3 } as const;

const a = stylex.create({
  c0: { backgroundColor: colors.avatar0 },
  c1: { backgroundColor: colors.avatar1 },
  c2: { backgroundColor: colors.avatar2 },
  c3: { backgroundColor: colors.avatar3 },
  c4: { backgroundColor: colors.avatar4 },
  c5: { backgroundColor: colors.avatar5 },
});
const AVATARS = [a.c0, a.c1, a.c2, a.c3, a.c4, a.c5];

// The class strings of the parts above that a list row builds (cx.ts).
const ICON = cx(s.icon);
const RING = cx(s.ring);
const RING_DONE = cx(s.ringDone);
const REVIEWS = ["approved", "changes_requested", "review_required"] as const;
/** By compactness (0, 1), then decision. */
const REVIEW_CHIP = [cxMap(REVIEWS, (k) => [s.chip, review[k]]), cxMap(REVIEWS, (k) => [s.chip, s.compactChip, review[k]])];
/** By size (SIZE_INDEX), then colour. */
const AVATAR = cxTable(SIZES.length * AVATARS.length, (i) => [s.avatar, SIZES[Math.floor(i / AVATARS.length)], AVATARS[i % AVATARS.length]]);

/** The colour of a list row's state icon, for the cell it sits in (ROW_ICONS). */
export const ROW_ICON_COLOUR: Record<RowIconKey, stylex.StyleXStyles> = {
  open: s.open,
  done: s.done,
  notPlanned: s.notPlanned,
  "pr-open": pr.open,
  "pr-draft": pr.draft,
  "pr-merged": pr.merged,
  "pr-closed": pr.closed,
};
