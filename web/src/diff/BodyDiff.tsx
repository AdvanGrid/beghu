// Diff mode (#194): what changed in an issue's or PR's body between two of its versions, in the
// body's post. Its own chunk, loaded the first time Diff is turned on (IssuePanel.tsx), so it
// stays out of first-load JS.
//
// The versions are the body's history (`getHistory`, every earlier version at once, so stepping
// the ends reads nothing more) and the current body, which the detail holds. When the detail's
// body changes (a push refetched it), the history is read again: the newer end stays on
// "current" if it was there, and otherwise each end keeps its version by when it was made.
//
// A sticky header sits at the top of the post, under the detail's sticky title bar: the timeline
// (a tick per version, oldest on the left, the range between the ends shaded, the older end red
// and the newer green, a stepper for each end) and a row with the counts, the two versions, the
// fold toggle and the change navigation. Under it the body renders block by block (diff/blocks.ts):
// removed blocks on a red tint with a − in the gutter, added ones on a green tint with a +,
// unchanged runs folded. The ends can't cross, and a version deleted from the history on GitHub
// is a greyed tick the steppers skip. Its keys (`fromOlder`, `fromNewer`, `toOlder`, `toNewer`,
// `nextChange`, `previousChange`) are offered while it shows a diff.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, Errored, For, Loading, onSettled, Show, untrack } from "solid-js";
import { fetchHistory, forgetFailure, getHistory, Gone, HistoryUnavailable, NoAccess, SessionEnded, signIn, Unreachable, type BodyHistory } from "../api";
import { touch } from "../keys";
import type { Md } from "../md/ast";
import type { Links } from "../md/links";
import { Markdown } from "../md/Markdown";
import { md as mdTone } from "../md/tokens.stylex";
import { ago, fullDate } from "../time";
import { detailBars } from "../layout.stylex";
import { colors, fonts } from "../tokens.stylex";
import { counts, diffBlocks, layout, type Line } from "./blocks";

/** The narrowest a tick may be and keep its label: narrower, only the ends keep theirs. */
const LABELLED_TICK = 30;

type Props = {
  /** The issue's or PR's id. */
  id: number;
  /** The current body, as GitHub confirmed it, and its digest (the detail's `body_digest`). */
  body: Md;
  digest: string;
  /** What links and media in a version resolve against, with the history's refs and media. */
  links: (history: BodyHistory) => Links;
};

/** Diff mode in the body's post: its history read under its own boundary, so a failure stays in the post. */
export function BodyDiff(props: Props) {
  return (
    <Errored fallback={(err, reset) => <HistoryFailure error={err()} reset={reset} />}>
      <Loading
        fallback={
          <p {...stylex.attrs(s.note)} aria-busy="true" data-perf="diff-loading">
            Loading earlier versions…
          </p>
        }
      >
        <Versions {...props} />
      </Loading>
    </Errored>
  );
}

/** Why the history didn't load, with Retry. A lapsed session goes to sign in instead. */
function HistoryFailure(props: { error: unknown; reset: () => void }) {
  const why = () => {
    const e = props.error;
    if (e instanceof HistoryUnavailable) return e.message;
    if (e instanceof Unreachable) return "beghu can't be reached";
    if (e instanceof NoAccess) return "you can't see this any more";
    if (e instanceof Gone) return "it isn't there any more";
    if (e instanceof SessionEnded) return "you're signed out";
    return "something went wrong";
  };
  return (
    <p {...stylex.attrs(s.note)} role="alert" data-perf="diff-failed">
      Couldn't load the earlier versions: {why()} ·{" "}
      <button
        type="button"
        {...stylex.attrs(s.link)}
        data-perf="diff-retry"
        onClick={() => {
          if (props.error instanceof SessionEnded) return signIn();
          forgetFailure(getHistory);
          props.reset();
        }}
      >
        Retry
      </button>
    </p>
  );
}

/** One version: the current body (age 0) or an earlier one, `age` versions back. */
type Version = {
  age: number;
  /** When it was made, and by whom (login; null for a deleted account): not known for the current body. */
  at?: number;
  editor?: string | null;
  /** Deleted from the history on GitHub: no body, and the ends skip it. */
  deleted: boolean;
  body: Md;
};

/** Where the ends are, by version: `from` by when it was made, `to` the same or null for the current body. */
type Ends = { from: number; to: number | null };

/** A version's short name: `current`, or how many versions back it is. */
const labelOf = (age: number) => (age === 0 ? "current" : `−${age}`);

function Versions(props: Props) {
  // Read for the body the detail shows: the history the query cache has, if it's for that body,
  // else afresh.
  const history = createMemo(async () => {
    const digest = props.digest;
    const id = props.id;
    const h = await getHistory(id);
    return h.body_digest === digest ? h : fetchHistory(id);
  });
  const versions = createMemo((): Version[] => [
    { age: 0, deleted: false, body: props.body },
    ...history().revisions.map((r, i) => ({ age: i + 1, at: r.edited_at, editor: r.editor, deleted: r.deleted, body: r.body ?? [] })),
  ]);
  const shown = () => versions().some((v) => v.age > 0 && !v.deleted);
  return (
    <Show
      when={versions().length > 1}
      fallback={
        <p {...stylex.attrs(s.note)} data-perf="diff-never">
          This body has never been edited.
        </p>
      }
    >
      <Show
        when={shown()}
        fallback={
          <p {...stylex.attrs(s.note)} data-perf="diff-all-deleted">
            Every earlier version of this body was deleted from its history on GitHub.
          </p>
        }
      >
        <Diff versions={versions()} includesCreated={history().includes_created} links={props.links(history())} />
      </Show>
    </Show>
  );
}

function Diff(props: { versions: Version[]; includesCreated: boolean; links: Links }) {
  const oldest = () => props.versions.length - 1;
  const usable = (age: number) => age >= 0 && age <= oldest() && !props.versions[age]!.deleted;
  /** The first version from `age` going `dir` (1 older, -1 newer) the ends may be on, if any. */
  const step = (age: number, dir: 1 | -1, until = dir > 0 ? oldest() : 0): number | undefined => {
    for (let a = age + dir; dir > 0 ? a <= until : a >= until; a += dir) if (usable(a)) return a;
    return undefined;
  };

  // It opens on the newest earlier version → current. Kept by version, so a body changing under
  // it (a newer current, the history read again) leaves each end on its version.
  const [ends, setEnds] = createSignal<Ends>(untrack(() => ({ from: props.versions[step(0, 1)!]!.at!, to: null })));
  const ageOf = (at: number | null) => (at === null ? 0 : props.versions.findIndex((v) => v.at === at && !v.deleted));
  /** The ends as ages: from older than to, each on a version that isn't deleted. */
  const at = createMemo(() => {
    const e = ends();
    let to = ageOf(e.to);
    if (to < 0) to = 0;
    let from = ageOf(e.from);
    if (from <= to) from = step(to, 1) ?? -1;
    // An end's version left the history: the newer end moves newer until one is older than it.
    if (from < 0) {
      to = 0;
      from = step(0, 1)!;
    }
    return { from, to };
  });
  const set = (from: number, to: number) => setEnds({ from: props.versions[from]!.at!, to: to === 0 ? null : props.versions[to]!.at! });
  const moves = {
    fromOlder: () => step(at().from, 1),
    fromNewer: () => step(at().from, -1, at().to + 1),
    toOlder: () => step(at().to, 1, at().from - 1),
    toNewer: () => step(at().to, -1),
  };
  const move = (which: keyof typeof moves) => {
    const to = untrack(moves[which]);
    if (to === undefined) return;
    const now = untrack(at);
    if (which.startsWith("from")) set(to, now.to);
    else set(now.from, to);
  };
  touch("fromOlder", () => move("fromOlder"));
  touch("fromNewer", () => move("fromNewer"));
  touch("toOlder", () => move("toOlder"));
  touch("toNewer", () => move("toNewer"));

  const from = () => props.versions[at().from]!;
  const to = () => props.versions[at().to]!;
  const lines = createMemo(() => diffBlocks(from().body, to().body));
  const items = createMemo(() => layout(lines()));
  const n = createMemo(() => counts(lines()));
  const changes = () => items().filter((x) => x.kind === "change").length;
  const folds = () => items().flatMap((x) => (x.kind === "fold" ? [x.id] : []));

  const [open, setOpen] = createSignal<ReadonlySet<number>>(new Set());
  const allOpen = () => folds().length > 0 && folds().every((id) => open().has(id));
  const toggleFold = (id: number, on: boolean) =>
    setOpen((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  // The change the navigation is on: none until it's used.
  const [current, setCurrent] = createSignal(-1);
  // Other ends: every run folded again, and the navigation from the top.
  createEffect(
    () => `${at().from}:${at().to}`,
    () => {
      setOpen(new Set<number>());
      setCurrent(-1);
    },
  );
  let root!: HTMLDivElement;
  const go = (dir: 1 | -1) => {
    const total = untrack(changes);
    if (total === 0) return;
    const was = untrack(current);
    const next = was < 0 ? (dir > 0 ? 0 : total - 1) : (was + dir + total) % total;
    setCurrent(next);
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.querySelector(`[data-change="${next}"]`)?.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  };
  touch("nextChange", () => go(1));
  touch("previousChange", () => go(-1));

  const byline = (v: Version) => {
    if (v.age === 0) return "current";
    const known = v.age === oldest() && !props.includesCreated ? " (oldest known)" : "";
    return `${labelOf(v.age)}${known} by ${v.editor ?? "ghost"}, ${ago(v.at!)} ago`;
  };

  return (
    <div ref={root} data-perf="body-diff" data-from={at().from} data-to={at().to}>
      <div {...stylex.attrs(s.head)} data-perf="diff-head">
        <Timeline versions={props.versions} from={at().from} to={at().to} includesCreated={props.includesCreated} moves={moves} move={move} />
        <div {...stylex.attrs(s.row)}>
          <span data-perf="diff-counts">
            <span {...stylex.attrs(s.added)}>+{n().add}</span> <span {...stylex.attrs(s.removed)}>−{n().del}</span> blocks
          </span>
          <span {...stylex.attrs(s.muted, s.ends)} data-perf="diff-ends">
            · {byline(from())} → {byline(to())}
          </span>
          <span {...stylex.attrs(s.spacer)} />
          <Show when={folds().length > 0}>
            <button type="button" {...stylex.attrs(s.link)} data-perf="diff-fold-all" onClick={() => setOpen(allOpen() ? new Set<number>() : new Set(folds()))}>
              {allOpen() ? "Fold unchanged" : "Unfold all"}
            </button>
          </Show>
          <span {...stylex.attrs(s.nav)}>
            <button type="button" {...stylex.attrs(s.step)} data-perf="diff-prev" disabled={changes() === 0} onClick={() => go(-1)} aria-label="Previous change" title="Previous change">
              ↑
            </button>
            <span {...stylex.attrs(s.muted, s.at)} data-perf="diff-at">
              {changes() === 0 ? "no changes" : `${current() < 0 ? "–" : current() + 1} / ${changes()}`}
            </span>
            <button type="button" {...stylex.attrs(s.step)} data-perf="diff-next" disabled={changes() === 0} onClick={() => go(1)} aria-label="Next change" title="Next change">
              ↓
            </button>
          </span>
        </div>
      </div>
      <Show when={changes() === 0}>
        <p {...stylex.attrs(s.note)} data-perf="diff-same">
          No change between these versions.
        </p>
      </Show>
      <For each={items()}>
        {(item) => {
          if (item.kind === "same") return <Block line={item.line} links={props.links} />;
          if (item.kind === "change")
            return (
              <div data-perf="diff-change" data-change={item.n} data-current={current() === item.n ? "true" : undefined} {...stylex.attrs(s.change, current() === item.n && s.current)}>
                <For each={item.lines}>{(line) => <Block line={line} links={props.links} />}</For>
              </div>
            );
          const count = `${item.lines.length} unchanged ${item.lines.length === 1 ? "block" : "blocks"}`;
          return (
            <Show
              when={open().has(item.id)}
              fallback={
                <button type="button" {...stylex.attrs(s.fold)} data-perf="diff-fold" aria-expanded="false" onClick={() => toggleFold(item.id, true)}>
                  ⋯ {count}
                </button>
              }
            >
              <button type="button" {...stylex.attrs(s.fold, s.foldOpen)} data-perf="diff-refold" aria-expanded="true" onClick={() => toggleFold(item.id, false)}>
                ▴ Fold {count}
              </button>
              <For each={item.lines}>{(line) => <Block line={line} links={props.links} />}</For>
            </Show>
          );
        }}
      </For>
    </div>
  );
}

/** One block: its gutter sign and tint, and the block as the body renders it. */
function Block(props: { line: Line; links: Links }) {
  const kind = () => props.line.kind;
  return (
    <div
      {...stylex.attrs(s.block, props.line.kind === "add" && s.addBlock, props.line.kind === "del" && s.delBlock)}
      data-perf="diff-block"
      data-kind={kind()}
      data-paired={props.line.paired ? "true" : undefined}
    >
      <span
        {...stylex.attrs(s.sign, props.line.kind === "add" && s.added, props.line.kind === "del" && s.removed)}
        role={kind() === "same" ? undefined : "img"}
        aria-label={kind() === "add" ? "Added" : kind() === "del" ? "Removed" : undefined}
      >
        {kind() === "add" ? "+" : kind() === "del" ? "−" : ""}
      </span>
      <div {...stylex.attrs(s.blockBody, props.line.kind === "del" && !props.line.paired && s.struck)}>
        <Markdown md={[props.line.block]} links={props.links} terms={[]} />
      </div>
    </div>
  );
}

/**
 * The versions, oldest on the left, with a stepper for each end: the older end's on the left, the
 * newer end's on the right. When the ticks are too narrow for their labels, only the ends keep
 * theirs; every tick names its version, editor and date on hover.
 */
function Timeline(props: {
  versions: Version[];
  from: number;
  to: number;
  includesCreated: boolean;
  moves: Record<"fromOlder" | "fromNewer" | "toOlder" | "toNewer", () => number | undefined>;
  move: (which: "fromOlder" | "fromNewer" | "toOlder" | "toNewer") => void;
}) {
  const oldestFirst = () => [...props.versions].reverse();
  let track!: HTMLDivElement;
  const [roomy, setRoomy] = createSignal(true);
  onSettled(() => {
    const measure = () => setRoomy(track.clientWidth / Math.max(1, props.versions.length) >= LABELLED_TICK);
    const ro = new ResizeObserver(measure);
    ro.observe(track);
    measure();
    return () => ro.disconnect();
  });
  const titleOf = (v: Version) => {
    if (v.age === 0) return "current: the body as it is now";
    const what = v.deleted ? "deleted from the history" : v.age === props.versions.length - 1 ? (props.includesCreated ? "the original" : "the oldest version GitHub kept") : "";
    return [labelOf(v.age), what, v.deleted ? "" : `by ${v.editor ?? "ghost"}`, fullDate(v.at!)].filter(Boolean).join(" · ");
  };
  return (
    <div {...stylex.attrs(s.timeline)}>
      <Stepper which="from" age={props.from} older={props.moves.fromOlder() !== undefined} newer={props.moves.fromNewer() !== undefined} move={props.move} />
      <div ref={track} {...stylex.attrs(s.track)} data-perf="diff-timeline">
        <For each={oldestFirst()}>
          {(v) => {
            const end = () => (v.age === props.from ? "from" : v.age === props.to ? "to" : undefined);
            return (
              <span
                {...stylex.attrs(s.tick, v.age <= props.from && v.age >= props.to && s.tickIn, v.age === props.from && s.tickFrom, v.age === props.to && s.tickTo, v.deleted && s.tickDeleted)}
                data-perf="diff-tick"
                data-age={v.age}
                data-end={end()}
                data-deleted={v.deleted ? "true" : undefined}
                title={titleOf(v)}
              >
                {roomy() || end() !== undefined ? (v.deleted ? "deleted" : labelOf(v.age)) : " "}
              </span>
            );
          }}
        </For>
      </div>
      <Stepper which="to" age={props.to} older={props.moves.toOlder() !== undefined} newer={props.moves.toNewer() !== undefined} move={props.move} />
    </div>
  );
}

/** An end's stepper, `‹ label ›`: ‹ moves it to an older version, › to a newer one. */
function Stepper(props: { which: "from" | "to"; age: number; older: boolean; newer: boolean; move: (which: "fromOlder" | "fromNewer" | "toOlder" | "toNewer") => void }) {
  const end = () => (props.which === "from" ? "Older end" : "Newer end");
  return (
    <span {...stylex.attrs(s.stepper, props.which === "from" ? s.stepperFrom : s.stepperTo)} data-perf={`diff-${props.which}`}>
      <button
        type="button"
        {...stylex.attrs(s.step)}
        data-perf={`diff-${props.which}-older`}
        disabled={!props.older}
        onClick={() => props.move(props.which === "from" ? "fromOlder" : "toOlder")}
        aria-label={`${end()}: an older version`}
        title={`${end()}: an older version`}
      >
        ‹
      </button>
      <b {...stylex.attrs(s.stepLabel)} data-perf={`diff-${props.which}-label`}>
        {labelOf(props.age)}
      </b>
      <button
        type="button"
        {...stylex.attrs(s.step)}
        data-perf={`diff-${props.which}-newer`}
        disabled={!props.newer}
        onClick={() => props.move(props.which === "from" ? "fromNewer" : "toNewer")}
        aria-label={`${end()}: a newer version`}
        title={`${end()}: a newer version`}
      >
        ›
      </button>
    </span>
  );
}

const s = stylex.create({
  note: {
    margin: 0,
    color: mdTone.muted,
  },
  muted: {
    color: mdTone.muted,
  },
  spacer: {
    flexGrow: 1,
  },
  link: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: {
      default: colors.accent,
      ":hover": colors.fg,
    },
    cursor: "pointer",
    fontSize: 12,
  },
  // The header: across the post's width, stuck under the detail's sticky title bar.
  head: {
    marginInline: -14,
    paddingBlock: 6,
    paddingInline: 14,
    alignItems: "stretch",
    backgroundColor: colors.bgRaised,
    boxShadow: `0 2px 6px ${colors.popShadow}`,
    display: "flex",
    flexDirection: "column",
    fontSize: 12,
    position: "sticky",
    zIndex: 2,
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    marginBottom: 10,
    top: detailBars.titleBar,
  },
  row: {
    gap: 6,
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
  },
  ends: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  nav: {
    gap: 2,
    alignItems: "center",
    display: "inline-flex",
  },
  // Wide enough for "12 / 34", so the arrows don't move as it counts.
  at: {
    fontVariantNumeric: "tabular-nums",
    textAlign: "center",
    minWidth: "7ch",
  },
  added: {
    color: colors.open,
    fontWeight: 600,
  },
  removed: {
    color: colors.danger,
    fontWeight: 600,
  },
  timeline: {
    gap: 8,
    alignItems: "center",
    display: "flex",
    marginBottom: 6,
  },
  track: {
    gap: 2,
    display: "flex",
    flexGrow: 1,
    minWidth: 0,
  },
  tick: {
    borderRadius: 3,
    overflow: "hidden",
    paddingBlock: 2,
    color: mdTone.muted,
    flexBasis: 0,
    flexGrow: 1,
    fontFamily: fonts.mono,
    fontSize: 10.5,
    textAlign: "center",
    whiteSpace: "nowrap",
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 3,
    minWidth: 0,
  },
  tickIn: {
    backgroundColor: colors.hover,
    color: colors.fg,
  },
  tickFrom: {
    fontWeight: 700,
    borderBottomColor: colors.danger,
  },
  tickTo: {
    fontWeight: 700,
    borderBottomColor: colors.open,
  },
  tickDeleted: {
    opacity: 0.5,
    textDecorationLine: "line-through",
    borderBottomStyle: "dotted",
  },
  stepper: {
    borderRadius: 4,
    borderStyle: "solid",
    borderWidth: 1,
    alignItems: "center",
    display: "inline-flex",
    flexShrink: 0,
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  stepperFrom: {
    borderColor: colors.danger,
  },
  stepperTo: {
    borderColor: colors.open,
  },
  step: {
    font: "inherit",
    borderWidth: 0,
    paddingBlock: 0,
    paddingInline: 6,
    backgroundColor: {
      default: "transparent",
      ":hover:not(:disabled)": colors.hover,
    },
    color: {
      default: colors.fg,
      ":disabled": colors.line,
    },
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    fontSize: 14,
    lineHeight: "20px",
  },
  // Wide enough for "−12" and "current", so the arrows stay put as the end moves.
  stepLabel: {
    paddingInline: 4,
    textAlign: "center",
    minWidth: "7ch",
  },
  // A run of changes: the navigation's current one is outlined.
  change: {
    borderRadius: 3,
  },
  current: {
    outlineColor: colors.accent,
    outlineOffset: 2,
    outlineStyle: "solid",
    outlineWidth: 2,
  },
  block: {
    borderRadius: 3,
    gap: 6,
    marginInline: -8,
    paddingBlock: 3,
    paddingInline: 8,
    display: "flex",
    marginBottom: "0.4em",
  },
  addBlock: {
    backgroundColor: colors.diffAddBg,
  },
  delBlock: {
    backgroundColor: colors.diffDelBg,
  },
  // A removed block that pairs with none: struck through whole.
  struck: {
    opacity: 0.75,
    textDecorationColor: colors.danger,
    textDecorationLine: "line-through",
  },
  blockBody: {
    flexGrow: 1,
    minWidth: 0,
  },
  sign: {
    flexShrink: 0,
    fontFamily: fonts.mono,
    fontWeight: 700,
    textAlign: "center",
    userSelect: "none",
    width: 12,
  },
  fold: {
    font: "inherit",
    borderColor: colors.line,
    borderRadius: 4,
    borderStyle: "dashed",
    borderWidth: 1,
    marginBlock: 6,
    paddingBlock: 4,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.hover,
    },
    color: mdTone.muted,
    cursor: "pointer",
    display: "block",
    fontSize: 12,
    width: "100%",
  },
  foldOpen: {
    borderStyle: "solid",
    marginBottom: 4,
  },
});
