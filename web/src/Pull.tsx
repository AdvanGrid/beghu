// What only a PR's panel shows (its own chunk, loaded when a PR opens, or when the pointer reaches a
// PR's row): the status badge (Open, Draft, Merged, Closed), `head → base` with the review chip,
// "Open on GitHub" as the primary action, and the link out to reviews and diff comments over the
// thread. A PR is read-only in beghu: its panel offers no writes.
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";
import { PR_LABEL, PrIcon, ReviewChip } from "./bits";
import type { PrStatus } from "./bindings/PrStatus";
import type { PullDetail } from "./bindings/PullDetail";
import { colors, fonts } from "./tokens.stylex";

const BADGE_TEXT: Record<PrStatus, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

/** The PR's status, in the same fixed-width badge an issue's state takes. */
export function PullBadge(props: { status: PrStatus }) {
  return (
    <span {...stylex.attrs(s.badge, badgeBg[props.status])} data-perf="badge" title={PR_LABEL[props.status]}>
      <PrIcon status={props.status} plain />
      {BADGE_TEXT[props.status]}
    </span>
  );
}

/** "Open on GitHub", the PR's primary action. */
export function OpenOnGitHub(props: { href: string }) {
  return (
    <a href={props.href} target="_blank" rel="noreferrer external" data-perf="open-on-github" {...stylex.attrs(s.primary)}>
      Open on GitHub ↗
    </a>
  );
}

/** Under the title: the branch it merges from and into, and its review decision. */
export function PullBranches(props: { pr: PullDetail }) {
  return (
    <div {...stylex.attrs(s.branches)} data-perf="branches">
      <span {...stylex.attrs(s.branch)} title={props.pr.head ?? undefined}>
        {props.pr.head ?? "?"}
      </span>
      <span aria-label="into" {...stylex.attrs(s.into)}>
        →
      </span>
      <span {...stylex.attrs(s.branch)} title={props.pr.base ?? undefined}>
        {props.pr.base ?? "?"}
      </span>
      <Show when={props.pr.review}>{(r) => <ReviewChip review={r()} />}</Show>
    </div>
  );
}

/** Over the thread: beghu holds only the conversation; reviews and diff comments are on GitHub. */
export function ReviewsElsewhere(props: { href: string }) {
  return (
    <a href={props.href} target="_blank" rel="noreferrer external" data-perf="reviews-elsewhere" {...stylex.attrs(s.elsewhere)}>
      Reviews and diff comments are on GitHub →
    </a>
  );
}

const s = stylex.create({
  badge: {
    borderRadius: 999,
    gap: 5,
    paddingInline: 10,
    alignItems: "center",
    boxSizing: "border-box",
    color: colors.accentFg,
    display: "inline-flex",
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 600,
    height: 24,
    width: 112,
  },
  primary: {
    borderRadius: 6,
    paddingInline: 10,
    textDecoration: "none",
    alignItems: "center",
    backgroundColor: {
      default: colors.accentBg,
      ":hover": colors.fg,
    },
    color: {
      default: colors.accentFg,
      ":hover": colors.bg,
    },
    display: "inline-flex",
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 600,
    height: 24,
  },
  branches: {
    gap: 6,
    paddingInline: 16,
    alignItems: "center",
    display: "flex",
    fontSize: 12,
    minWidth: 0,
    paddingBottom: 10,
  },
  branch: {
    borderRadius: 4,
    overflow: "hidden",
    paddingInline: 6,
    backgroundColor: colors.bgRaised,
    color: colors.fg,
    fontFamily: fonts.mono,
    fontSize: 11.5,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  into: {
    color: colors.muted,
    flexShrink: 0,
  },
  elsewhere: {
    textDecoration: {
      default: "none",
      ":hover": "underline",
    },
    color: colors.accent,
    fontSize: 12,
    fontWeight: 400,
    paddingInlineStart: 8,
  },
});

const badgeBg = stylex.create({
  open: { backgroundColor: colors.openBg },
  draft: { backgroundColor: colors.notPlannedBg },
  merged: { backgroundColor: colors.doneBg },
  closed: { backgroundColor: colors.dangerBg },
});
