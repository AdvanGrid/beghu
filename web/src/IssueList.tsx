import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, Errored, For, lazy, Loading, onSettled, Show, untrack, type Element } from "solid-js";
import { SessionEnded, getIssues, refetchIssues, signIn, type IssuePage, type IssueRow } from "./api";
import { Avatar, issueState, ProgressRing, StateIcon } from "./bits";
import { COLUMNS, createColumns, stackFit, type Column } from "./columns";
import { blockerStatus, type CardAt } from "./cards";
import { coalesced, onPush } from "./live";
import { queryOf, sortOf, type SortKey } from "./query";
import { ChunkFailed } from "./router";
import { createVirtualizer } from "./virtual";
import { ago, fullDate } from "./time";
import { slots } from "./layout.stylex";
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
 * The hover card over a row's labels or blockers: its own chunk, loaded on the first hover. A
 * failed load is tried again on the next hover.
 */
const ListCard = lazy(
  () =>
    import("./ListCard").catch((e: unknown) => {
      throw new ChunkFailed(`can't load the hover card: ${String(e)}`);
    }),
  { export: "ListCard" },
);

/**
 * The issue list: strict columns (state, title, labels, blockers, progress, `repo#number`,
 * assignees, updated) on 34 px rows, with only the rows on screen in the DOM. Pages load as the
 * window nears the end. Rows are plain links; the router's one listener opens them. Each column
 * right of the title resizes by its left edge in the header (double-click resets it). A blocked
 * row has a red edge and a chip per open blocker; hovering the chips (or labels past "+n") shows
 * a card that needs no fetch.
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

  let column!: HTMLDivElement;
  const [listWidth, setListWidth] = createSignal(0);
  onSettled(() => {
    const ro = new ResizeObserver(() => setListWidth(column.clientWidth));
    ro.observe(column);
    setListWidth(column.clientWidth);
    return () => ro.disconnect();
  });
  const cols = createColumns(listWidth);
  const card = createCard();

  return (
    <>
      <div ref={column} {...stylex.attrs(s.column)}>
        <div {...stylex.attrs(s.row, s.head)} data-perf="list-head">
          <span {...stylex.attrs(s.state)} />
          <span {...stylex.attrs(s.title)}>Title</span>
          <For each={COLUMNS}>
            {(c) => (
              <span {...stylex.attrs(s.cell, s.headCell, WIDE.has(c) && s.wide, END.has(c) && s.end, s.w(cols.width(c)))} data-col={c}>
                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${HEAD[c]}`}
                  title="Drag to resize; double-click to reset"
                  data-perf="col-grip"
                  {...stylex.attrs(s.grip)}
                  onPointerDown={(e) => cols.drag(c, e)}
                  onDblClick={() => cols.reset(c)}
                />
                <span {...stylex.attrs(cols.isSet(c) && s.headSet)}>{c === "updated" ? time().head : HEAD[c]}</span>
              </span>
            )}
          </For>
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
              cols={cols}
              card={card}
            />
          </Loading>
        </div>
      </div>
      <Show when={card.shown()}>
        {(c) => (
          // A card whose code failed to load shows nothing (an empty marker), never the list's
          // failure: the list stays, and the next hover mounts the card again, which loads it
          // again.
          <Errored fallback={<span data-perf="card-failed" hidden />}>
            <Loading fallback={null}>
              <ListCard card={c()} search={props.search} keep={card.keep} hide={card.hide} />
            </Loading>
          </Errored>
        )}
      </Show>
    </>
  );
}

/** The column headings. */
const HEAD: Record<Column, string> = {
  labels: "Labels",
  blockers: "Blocked by",
  progress: "Subs",
  ref: "Issue",
  who: "Who",
  // The sort's time (see TIME); this is the default sort's.
  updated: "Upd.",
};
/** The columns a narrow list leaves out. */
const WIDE = new Set<Column>(["labels", "blockers", "progress"]);
/** The columns whose content sits at their end. */
const END = new Set<Column>(["ref", "updated"]);

type Cols = ReturnType<typeof createColumns>;

/** The hover card's state: which row's labels or blockers it shows, and where. */
function createCard() {
  const [shown, setShown] = createSignal<CardAt>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Opens after a short rest, so sweeping across rows doesn't flash cards; stays while the
  // pointer is on it.
  const enter = (kind: CardAt["kind"], row: IssueRow, el: HTMLElement) => {
    clearTimeout(timer);
    timer = setTimeout(() => setShown({ kind, row, at: el.getBoundingClientRect() }), 300);
  };
  const keep = () => clearTimeout(timer);
  const hide = () => {
    clearTimeout(timer);
    timer = setTimeout(() => setShown(undefined), 150);
  };
  return { shown, enter, keep, hide };
}

type Card = ReturnType<typeof createCard>;

function Rows(props: {
  rows: IssueRow[];
  search: string;
  openId?: number;
  onNearEnd: () => void;
  time: (r: IssueRow) => number | null;
  cols: Cols;
  card: Card;
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
              {(r) => (
                <Row r={r} search={props.search} current={props.openId === r.id} time={props.time} cols={props.cols} card={props.card} />
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

function Row(props: {
  r: IssueRow;
  search: string;
  current: boolean;
  time: (r: IssueRow) => number | null;
  cols: Cols;
  card: Card;
}) {
  const r = () => props.r;
  const at = () => props.time(r());
  const w = (c: Column) => props.cols.width(c);
  const blocked = () => r().state === "open" && r().blocked_by > 0;
  return (
    <a
      href={`/issues/${r().id}${props.search}`}
      noscroll
      data-perf="row"
      data-id={r().id}
      data-blocked={blocked() ? "" : undefined}
      aria-current={props.current ? "page" : undefined}
      {...stylex.attrs(s.row, s.link, props.current && s.current, blocked() && s.blocked)}
    >
      <span {...stylex.attrs(s.state)}>
        <StateIcon state={issueState(r())} />
      </span>
      <span {...stylex.attrs(s.title)}>{r().title}</span>
      <Labels r={r()} width={w("labels")} card={props.card} />
      <span {...stylex.attrs(s.cell, s.wide, s.w(w("blockers")))} data-perf="blockers">
        <Show when={blocked()}>
          <Blockers r={r()} width={w("blockers")} card={props.card} />
        </Show>
      </span>
      <span {...stylex.attrs(s.cell, s.wide, s.w(w("progress")))} data-perf="progress">
        <Show when={r().progress}>
          {(p) => (
            <span {...stylex.attrs(s.progress)} title={`${p().done} of ${p().total} sub-issues closed, at every level`}>
              <ProgressRing done={p().done} total={p().total} />
              {p().done}/{p().total}
            </span>
          )}
        </Show>
      </span>
      <span {...stylex.attrs(s.cell, s.ref, s.end, s.w(w("ref")))} data-perf="ref">
        {r().repo}#{r().number}
      </span>
      <span {...stylex.attrs(s.cell, s.avatars, s.w(w("who")))}>
        <For each={r().assignees.slice(0, 3)}>{(u) => <Avatar login={u.login} />}</For>
      </span>
      <span {...stylex.attrs(s.cell, s.when, s.end, s.w(w("updated")))} title={at() === null ? undefined : fullDate(at()!)}>
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
 * How a kind of stacked cell lays out: two to a column of `slot` px, `gap` px apart, laid out by
 * `style`. Hovering shows its card `always`, or only `when-clipped` (some are left out).
 */
type StackKind = {
  kind: "labels" | "blockers";
  slot: number;
  gap: number;
  style: stylex.StyleXStyles;
  hoverable: "always" | "when-clipped";
  perf?: string;
};

/**
 * A cell of a row's labels or blockers: one on a line of its own; more stack as `stack` lays them
 * out, as many columns as the cell holds, the last slot saying "+n" when they don't all fit.
 * `items` is what the row carries of them, `total` how many there are.
 */
function Stack<T>(props: {
  stack: StackKind;
  r: IssueRow;
  items: T[];
  total: number;
  width: number;
  card: Card;
  xstyle?: stylex.StyleXStyles;
  children: (item: T, stacked: () => boolean) => Element;
}) {
  let el!: HTMLSpanElement;
  const stacked = () => props.total > 1;
  const shown = () => props.items.slice(0, stackFit(props.total, props.width, props.stack.slot, props.stack.gap));
  const more = () => props.total - shown().length;
  return (
    <span
      ref={el}
      {...stylex.attrs(props.xstyle, stacked() ? props.stack.style : s.labels)}
      data-perf={props.stack.perf}
      onPointerEnter={() =>
        (props.stack.hoverable === "always" || more() > 0) && props.card.enter(props.stack.kind, props.r, el)
      }
      onPointerLeave={props.card.hide}
    >
      <For each={shown()}>{(x) => props.children(x, stacked)}</For>
      <Show when={more() > 0}>
        <span {...stylex.attrs(s.more)}>+{more()}</span>
      </Show>
    </span>
  );
}

/** A row's labels, stacked when there's more than one. */
function Labels(props: { r: IssueRow; width: number; card: Card }) {
  return (
    <Stack
      stack={LABELS}
      r={props.r}
      items={props.r.labels}
      total={props.r.labels.length}
      width={props.width}
      card={props.card}
      xstyle={[s.cell, s.wide, s.w(props.width)]}
    >
      {(l, stacked) => (
        <span {...stylex.attrs(stacked() ? s.stacked : s.pill)} title={l.name}>
          <LabelDot color={l.color} />
          <span {...stylex.attrs(s.clip)}>{l.name}</span>
        </span>
      )}
    </Stack>
  );
}

/**
 * A blocked row's open blockers, one chip each (who has it, and its number), stacked as the
 * labels are. Amber and dashed when nobody has it; red when it's itself blocked. Hovering shows a
 * card with every open blocker the row carries, with no fetch.
 */
function Blockers(props: { r: IssueRow; width: number; card: Card }) {
  return (
    <Stack
      stack={BLOCKERS}
      r={props.r}
      items={props.r.blockers}
      total={props.r.blocked_by}
      width={props.width}
      card={props.card}
    >
      {(b, stacked) => (
        <span
          {...stylex.attrs(s.chip, stacked() && s.chipSmall, blockerStatus(b) === "chain" && s.chain, blockerStatus(b) === "nobody" && s.nobody)}
          data-perf="blocker"
        >
          <Show when={b.assignee} fallback={<span {...stylex.attrs(s.noone, stacked() && s.nooneSmall)} />}>
            {(who) => <Avatar login={who()} size={stacked() ? 11 : 14} />}
          </Show>
          <Show when={b.repo !== props.r.repo}>
            <span {...stylex.attrs(s.clip)}>{b.repo}</span>
          </Show>
          <span {...stylex.attrs(s.num)}>#{b.number}</span>
        </span>
      )}
    </Stack>
  );
}

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
  // Flex, not grid: every cell right of the title has its column's width, set per cell. (A
  // dynamic grid template would be a multi-word dynamic property; see the label dot below.)
  row: {
    paddingInline: 14,
    alignItems: "center",
    boxSizing: "border-box",
    columnGap: 12,
    display: "flex",
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
  headCell: {
    overflow: "visible",
    position: "relative",
  },
  headSet: {
    color: colors.fg,
  },
  // A column's left edge: drag it to resize the column, double-click to reset it.
  grip: {
    insetBlock: 4,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.accent,
    },
    cursor: "col-resize",
    position: "absolute",
    touchAction: "none",
    zIndex: 1,
    left: -7,
    width: 3,
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
  // A blocked row's red edge.
  blocked: {
    boxShadow: `inset 3px 0 0 ${colors.danger}`,
  },
  state: {
    display: "flex",
    flexShrink: 0,
    width: 16,
  },
  title: {
    overflow: "hidden",
    flexBasis: 0,
    flexGrow: 1,
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  cell: {
    overflow: "hidden",
    flexShrink: 0,
  },
  w: (width: number) => ({
    width,
  }),
  wide: {
    display: {
      [NARROW]: "none",
      default: "flex",
    },
  },
  end: {
    justifyContent: "flex-end",
    textAlign: "end",
  },
  labels: {
    gap: 4,
    overflow: "hidden",
    alignItems: "center",
    display: "flex",
    minWidth: 0,
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
    fontSize: 11.5,
    height: 18,
    maxWidth: "100%",
    minWidth: 0,
  },
  // Two to a column, filled column by column, each column one slot wide.
  stack: {
    alignContent: "center",
    columnGap: slots.labelGap,
    display: {
      [NARROW]: "none",
      default: "grid",
    },
    gridAutoColumns: slots.labelSlot,
    gridAutoFlow: "column",
    gridTemplateRows: "15px 15px",
    lineHeight: "15px",
  },
  stacked: {
    gap: 4,
    alignItems: "center",
    display: "flex",
    fontSize: 11,
    minWidth: 0,
  },
  clip: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  more: {
    alignSelf: "center",
    color: colors.muted,
    flexShrink: 0,
    fontSize: 11,
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
  // As the labels stack.
  chipStack: {
    alignContent: "center",
    columnGap: slots.blockerGap,
    display: "grid",
    gridAutoColumns: slots.blockerSlot,
    gridAutoFlow: "column",
    gridTemplateRows: "15px 15px",
    rowGap: 1,
  },
  chip: {
    borderColor: colors.line,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 3,
    alignItems: "center",
    backgroundColor: colors.bg,
    boxSizing: "border-box",
    display: "inline-flex",
    fontSize: 11.5,
    paddingInlineEnd: 6,
    paddingInlineStart: 2,
    height: 18,
    maxWidth: "100%",
    minWidth: 0,
    width: "max-content",
  },
  chipSmall: {
    gap: 2,
    fontSize: 10.5,
    paddingInlineEnd: 5,
    paddingInlineStart: 1,
    height: 15,
  },
  // Nobody has the blocker.
  nobody: {
    borderColor: colors.unowned,
    borderStyle: "dashed",
  },
  // The blocker is itself blocked.
  chain: {
    borderColor: colors.danger,
  },
  noone: {
    borderColor: colors.muted,
    borderRadius: "50%",
    borderStyle: "dashed",
    borderWidth: 1,
    boxSizing: "border-box",
    flexShrink: 0,
    height: 14,
    width: 14,
  },
  nooneSmall: {
    height: 11,
    width: 11,
  },
  num: {
    flexShrink: 0,
    fontFamily: fonts.mono,
  },
  progress: {
    gap: 4,
    alignItems: "center",
    color: colors.muted,
    display: "inline-flex",
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
  },
  ref: {
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

const LABELS: StackKind = {
  kind: "labels",
  slot: slots.labelSlot,
  gap: slots.labelGap,
  style: s.stack,
  hoverable: "when-clipped",
  perf: "labels",
};

const BLOCKERS: StackKind = {
  kind: "blockers",
  slot: slots.blockerSlot,
  gap: slots.blockerGap,
  style: s.chipStack,
  hoverable: "always",
};
