import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, Loading, onSettled, Show, untrack } from "solid-js";
import { SessionEnded, getIssues, refetchIssues, signIn, type IssuePage, type IssueRow } from "./api";
import { Avatar, issueState, StateIcon } from "./bits";
import { coalesced, onPush } from "./live";
import { queryOf, sortOf, type SortKey } from "./query";
import { createVirtualizer } from "./virtual";
import { ago, fullDate } from "./time";
import { colors, fonts } from "./tokens.stylex";

/** Every row is exactly this tall, border included: the virtualizer's pitch. */
export const ROW_HEIGHT = 34;
/** Rows past either edge of the window kept in the DOM. */
const OVERSCAN = 6;
/** Load the next page when the window gets this close to the last loaded row. */
const NEAR_END = 40;
/** A view change that takes longer than this pulses the list's outline, over the old rows. */
export const PULSE_AFTER_MS = 200;

/** The time the last column shows: the sort's, or the last update. */
const TIME: Record<SortKey, { head: string; of: (r: IssueRow) => number | null }> = {
  updated: { head: "Upd.", of: (r) => r.updated_at },
  created: { head: "Opened", of: (r) => r.created_at },
  closed: { head: "Closed", of: (r) => r.closed_at },
  commented: { head: "Comm.", of: (r) => r.commented_at },
  comments: { head: "Upd.", of: (r) => r.updated_at },
};

/**
 * The issue list: strict columns (state, title, labels, blockers, progress, `repo#number`,
 * assignees, updated) on 34 px rows, with only the rows on screen in the DOM. Pages load as the
 * window nears the end. Rows are plain links; the router's one listener opens them.
 *
 * Every live push refetches the list from the top through the last loaded row, in one request:
 * the first push at once, and any during that fetch in one more after it. A failed refetch
 * leaves the rows on screen as they are. A page that loads while a refetch is in flight is
 * asked for again from the refetched rows, so rows never vanish and come back.
 */
export function IssueList(props: { search: string; openId?: number }) {
  // The first page follows the view (the URL's query string); later pages are appended. A new
  // view keeps the old rows on screen until its page lands. Each view's fetch is a generation.
  // The list is waiting from the first view change until the newest generation lands; once it
  // has waited PULSE_AFTER_MS it pulses, however many views were asked for meanwhile, so steady
  // typing pulses too. Only the newest landing ends the wait, so an older view landing late
  // never clears it while the newest is on its way. The first view has no old rows to pulse
  // over: the boundary's fallback shows instead.
  const [pulse, setPulse] = createSignal(false);
  let generation = 0;
  /** When the list began waiting (`performance.now()`), while it waits. */
  let waitingSince: number | undefined;
  let pulseTimer: ReturnType<typeof setTimeout> | undefined;
  const [page, setPage] = createSignal<IssuePage>(() => {
    const mine = ++generation;
    const fetched = getIssues(props.search);
    if (mine > 1) {
      waitingSince ??= performance.now();
      clearTimeout(pulseTimer);
      pulseTimer = setTimeout(() => setPulse(true), Math.max(0, waitingSince + PULSE_AFTER_MS - performance.now()));
      const landed = () => {
        if (mine !== generation) return;
        clearTimeout(pulseTimer);
        waitingSince = undefined;
        setPulse(false);
      };
      fetched.then(landed, landed);
    }
    return fetched;
  });
  const time = createMemo(() => TIME[sortOf(queryOf(props.search)).key]);
  // What's on screen and for which view, once it has loaded: where a refetch starts from. Set
  // here as each page lands, and by the effect below for the first page of a view.
  let shown: { view: string; page: IssuePage } | undefined;
  // Refetches waiting for the view's first page to be shown.
  let waitingForShown: (() => void)[] = [];
  const recordShown = (view: string, p: IssuePage) => {
    shown = { view, page: p };
    for (const f of waitingForShown.splice(0)) f();
  };
  createEffect(
    () => ({ view: props.search, page: page() }),
    (now) => recordShown(now.view, now.page),
  );
  // A failed read never replaces what's on screen; a lapsed session goes to sign-in.
  const signInIfEnded = (e: unknown) => {
    if (e instanceof SessionEnded) signIn();
  };

  // Bumped as each refetch starts: a page that was loading meanwhile would be appended to rows
  // the refetch is about to replace, so it's dropped and asked for again from the fresh rows.
  let refetchesStarted = 0;
  let refetching: Promise<void> | undefined;
  let loadingMore = false;
  // Called from the rows' near-end effect: these reads are a snapshot, not dependencies.
  const loadMore = async () => {
    if (loadingMore) return;
    loadingMore = true;
    const view = untrack(() => props.search);
    try {
      for (;;) {
        while (refetching) await refetching;
        const have = untrack(page);
        if (!have.next || view !== untrack(() => props.search)) return;
        const started = refetchesStarted;
        const more = await getIssues(view, have.next);
        if (view !== untrack(() => props.search)) return;
        if (started === refetchesStarted) {
          const next = { rows: [...have.rows, ...more.rows], next: more.next, last: more.last };
          setPage(next);
          recordShown(view, next);
          return;
        }
      }
    } catch (e) {
      // The next scroll asks again.
      signInIfEnded(e);
    } finally {
      loadingMore = false;
    }
  };

  const refetch = coalesced(async () => {
    // A push that beats the first page waits for it: that page may predate the change.
    while (shown?.view !== props.search) await new Promise<void>((r) => waitingForShown.push(r));
    const { view, page: have } = shown;
    refetchesStarted++;
    let done!: () => void;
    refetching = new Promise<void>((r) => (done = r));
    try {
      const fresh = await refetchIssues(view, have.last ?? undefined);
      if (view !== props.search) return;
      setPage(fresh);
      recordShown(view, fresh);
    } catch (e) {
      // The next push tries again.
      signInIfEnded(e);
      throw e;
    } finally {
      refetching = undefined;
      done();
    }
  });
  onSettled(() => onPush(refetch));

  return (
    <div {...stylex.attrs(s.column)}>
      <div {...stylex.attrs(s.row, s.head)} aria-hidden="true">
        <span />
        <span>Title</span>
        <span {...stylex.attrs(s.wide)}>Labels</span>
        <span {...stylex.attrs(s.wide)}>Blocked by</span>
        <span {...stylex.attrs(s.wide)}>Subs</span>
        <span {...stylex.attrs(s.end)}>Issue</span>
        <span>Who</span>
        <span {...stylex.attrs(s.end)}>{time().head}</span>
      </div>
      {/* The pulse lives on a frame outside the rows' Loading boundary, which holds the old
          rows while the next view loads. */}
      <div
        {...stylex.attrs(s.frame, pulse() && s.pulse)}
        data-perf="list-frame"
        aria-busy={pulse() ? "true" : undefined}
      >
      <Loading fallback={<div {...stylex.attrs(s.scroller)} data-perf="list" aria-busy="true" />}>
        <Rows
          rows={page().rows}
          search={props.search}
          openId={props.openId}
          onNearEnd={loadMore}
          time={time().of}
        />
      </Loading>
      </div>
    </div>
  );
}

function Rows(props: {
  rows: IssueRow[];
  search: string;
  openId?: number;
  onNearEnd: () => void;
  time: (r: IssueRow) => number | null;
}) {
  let scroller!: HTMLDivElement;
  const v = createVirtualizer({
    count: () => props.rows.length,
    getScrollElement: () => scroller,
    size: ROW_HEIGHT,
    overscan: OVERSCAN,
  });
  const visible = createMemo(() => {
    const items = v.items();
    const first = items[0]?.index ?? 0;
    return { first, rows: props.rows.slice(first, first + items.length) };
  });
  // Near the end of what's loaded, ask for the next page. Driven by the window, which the
  // virtualizer moves after its own scroll handling.
  createEffect(
    () => (v.items().at(-1)?.index ?? 0) > props.rows.length - NEAR_END,
    (near) => {
      if (near) props.onNearEnd();
    },
  );

  return (
    <div
      ref={scroller}
      {...stylex.attrs(s.scroller)}
      data-perf="list"
      data-perf-rows={props.rows.length}
    >
      <Show when={props.rows.length > 0} fallback={<p {...stylex.attrs(s.empty)}>Nothing matches this view.</p>}>
        <div {...stylex.attrs(s.sizer(v.totalSize()))}>
          {/* One translated wrapper around rows in normal flow: a row that stays in the window
              keeps its DOM node. */}
          <div {...stylex.attrs(s.window(visible().first * ROW_HEIGHT))}>
            <For each={visible().rows}>
              {(r) => <Row r={r} search={props.search} current={props.openId === r.id} time={props.time} />}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

function Row(props: { r: IssueRow; search: string; current: boolean; time: (r: IssueRow) => number | null }) {
  const r = () => props.r;
  const at = () => props.time(r());
  return (
    <a
      href={`/issues/${r().id}${props.search}`}
      noscroll
      data-perf="row"
      data-id={r().id}
      aria-current={props.current ? "page" : undefined}
      {...stylex.attrs(s.row, s.link, props.current && s.current)}
    >
      <StateIcon state={issueState(r())} />
      <span {...stylex.attrs(s.title)}>{r().title}</span>
      <span {...stylex.attrs(s.wide, s.labels)}>
        <For each={r().labels}>
          {(l) => (
            <span {...stylex.attrs(s.pill)} title={l.name}>
              <LabelDot color={l.color} />
              {l.name}
            </span>
          )}
        </For>
      </span>
      {/* Blockers and sub-issue progress fill in with relationships (#94). */}
      <span {...stylex.attrs(s.wide)} />
      <span {...stylex.attrs(s.wide)} />
      <span {...stylex.attrs(s.ref, s.end)}>
        {r().repo}#{r().number}
      </span>
      <span {...stylex.attrs(s.avatars)}>
        <For each={r().assignees.slice(0, 3)}>{(u) => <Avatar login={u.login} />}</For>
      </span>
      <span {...stylex.attrs(s.when, s.end)} title={at() === null ? undefined : fullDate(at()!)}>
        {at() === null ? "" : ago(at()!)}
      </span>
    </a>
  );
}

/** A label's colour dot. GitHub's label colours are data, so they come in as a dynamic style. */
export function LabelDot(props: { color: string }) {
  return <span {...stylex.attrs(s.dot(`#${props.color}`))} />;
}

const pulseOutline = stylex.keyframes({
  from: { outlineColor: "transparent" },
  to: { outlineColor: colors.accent },
});

/**
 * A wide list shows every column; a narrow one keeps state, title, number, assignees and age. The
 * list's own width decides, as the issue panel beside it takes part of the screen.
 */
const NARROW = "@container (max-width: 700px)";

const s = stylex.create({
  column: {
    containerType: "inline-size",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  frame: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    outlineColor: "transparent",
    outlineOffset: -2,
    outlineStyle: "solid",
    outlineWidth: 2,
    minHeight: 0,
  },
  scroller: {
    scrollbarGutter: "stable",
    contain: "strict",
    flexGrow: 1,
    overflowY: "auto",
  },
  pulse: {
    animationDirection: "alternate",
    animationDuration: "0.6s",
    animationIterationCount: "infinite",
    animationName: pulseOutline,
    animationTimingFunction: "ease-in-out",
  },
  sizer: (height: number) => ({
    position: "relative",
    height,
  }),
  window: (y: number) => ({
    transform: `translateY(${y}px)`,
    willChange: "transform",
  }),
  row: {
    paddingInline: 14,
    alignItems: "center",
    boxSizing: "border-box",
    columnGap: 12,
    display: "grid",
    gridTemplateColumns: {
      [NARROW]: "16px minmax(0, 1fr) 96px 40px 30px",
      default: "16px minmax(0, 1fr) 192px 100px 52px 104px 46px 32px",
    },
    whiteSpace: "nowrap",
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    height: ROW_HEIGHT,
  },
  head: {
    scrollbarGutter: "stable",
    overflow: "hidden",
    color: colors.muted,
    flexShrink: 0,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    height: 26,
  },
  link: {
    textDecoration: "none",
    backgroundColor: {
      default: null,
      ":hover": colors.hover,
    },
    color: "inherit",
    contain: "strict",
  },
  current: {
    backgroundColor: {
      default: colors.selected,
      ":hover": colors.selected,
    },
  },
  wide: {
    display: {
      [NARROW]: "none",
      default: "flex",
    },
  },
  end: {
    textAlign: "end",
  },
  title: {
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  labels: {
    gap: 4,
    overflow: "hidden",
  },
  pill: {
    borderColor: colors.line,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 5,
    paddingInline: 7,
    alignItems: "center",
    display: "inline-flex",
    flexShrink: 0,
    fontSize: 11.5,
    height: 18,
  },
  // A dynamic style sets only `color`, painted through currentColor. StyleX 0.19.1's attrs()
  // kebab-cases every key of the inline style, the generated custom properties included, so a
  // multi-word dynamic property sets `--x-background-color` while the compiled rule reads
  // `var(--x-backgroundColor)` (custom properties are case-sensitive) and the colour never
  // applies. Upstream: https://github.com/facebook/stylex/issues/1709, fixed by
  // https://github.com/facebook/stylex/pull/1711 (merged after 0.19.1; drop this once released).
  dot: (color: string) => ({
    borderRadius: "50%",
    backgroundColor: "currentColor",
    color,
    flexShrink: 0,
    height: 8,
    width: 8,
  }),
  ref: {
    overflow: "hidden",
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 12,
    textOverflow: "ellipsis",
  },
  avatars: {
    gap: 2,
    display: "flex",
  },
  when: {
    color: colors.muted,
    fontVariantNumeric: "tabular-nums",
  },
  empty: {
    margin: 0,
    padding: 24,
    color: colors.muted,
  },
});
