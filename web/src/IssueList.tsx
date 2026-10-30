import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, Errored, For, lazy, Loading, onCleanup, onSettled, Show, untrack } from "solid-js";
import { useNavigate, usePreloadRoute } from "@solidjs/router";
import { effect } from "@solidjs/web";
import { Gone, NoAccess, SessionEnded, commentOrder, getIssues, readAt, refetchIssue, refetchIssues, signIn, stamp, type IssuePage, type IssueRow } from "./api";
import type { Blocker } from "./bindings/Blocker";
import type { SearchField } from "./bindings/SearchField";
import { avatarNode, issueState, prIconNode, progressRingNode, reviewChipNode, stateIconNode } from "./bits";
import { COLUMNS, createColumns, stackFit, type Column } from "./columns";
import { blockerStatus, type CardAt } from "./cards";
import { StillImporting } from "./WhileImporting";
import { stale } from "./account";
import { cueStyles } from "./cue";
import { applyNextAtOnce, createHeld } from "./held";
import { touch } from "./keys";
import { coalesced, onPush } from "./live";
import { overlay } from "./overlay";
import { queryOf, sortOf, type SortKey } from "./query";
import { ChunkFailed } from "./router";
import { createVirtualizer } from "./virtual";
import { ago, fullDate } from "./time";
import { colW, slots } from "./layout.stylex";
import { colors, fonts } from "./tokens.stylex";

/** Every row is exactly this tall, border included: the virtualizer's pitch. */
export const ROW_HEIGHT = 34;
/** Rows past either edge of the window kept in the DOM at rest (virtual.ts: while scrolling, most go ahead). */
const OVERSCAN = 6;
/**
 * Load the next page when the last row on screen gets this close to the last loaded row: 45 rows
 * (1,530 px) ahead, against the 34 the window's last row left before, so a fling has the next page
 * before it reaches the end. With the server's 100-row pages, a list area taller than 56 rows
 * (1,904 px) asks for the second page as it loads, as one taller than 1,870 px did before.
 */
const NEAR_END = 45;
/** A view change that takes longer than this pulses the list's outline, over the old rows. */
export const PULSE_AFTER_MS = 200;
/**
 * How long the selection rests before its neighbours preload: a held key's repeats never do. The
 * preload's read is remembered too (api.ts), so a step after the router's 5 s shows it at once.
 */
const PRELOAD_REST_MS = 150;

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
 * asked for again from the refetched rows, so rows never vanish and come back. A refetch's new
 * contents show at once; its new order is a held change (held.ts).
 *
 * The tab's pending writes show on their rows (overlay.ts) but never add, remove or move one.
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
    untrack(overlay)?.listShown(readAt(p));
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
          // As old as its oldest part: the rows already shown.
          const next = stamp({ rows: [...have.rows, ...more.rows], next: more.next, last: more.last }, readAt(have));
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
  // What the user wrote to from the panel keeps the list's selection only while the panel stays on
  // it (writes.tsx).
  createEffect(
    () => ({ o: overlay(), open: props.openId }),
    ({ o, open }) => o?.panelOn(open),
  );
  // A `defs` push changes no row.
  onSettled(() =>
    onPush((p) => {
      // Back restored the page: its refetched order applies at once (held.ts).
      if (p.kind === "reset" && p.restored) applyNextAtOnce();
      // What the account may do changes no row.
      if (p.kind === "ids" || p.kind === "reset") void refetch();
    }),
  );

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
      <div ref={column} {...stylex.attrs(s.column, widthsOf(cols))}>
        <ListHead cols={cols} time={time().head} />
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
              readStart={readAt(page())}
              search={props.search}
              openId={props.openId}
              more={page().next !== null}
              onNearEnd={loadMore}
              time={time().of}
              cols={cols}
              card={card}
            />
          </Loading>
        </div>
      </div>
      <CardLayer card={card} search={props.search} />
    </>
  );
}

/** The list's header: a heading per column, each resizing its column by its left edge. `time` heads the last. */
export function ListHead(props: { cols: Cols; time: string }) {
  const cols = props.cols;
  return (
    <div {...stylex.attrs(s.row, s.head)} data-perf="list-head">
      <span {...stylex.attrs(s.state)} />
      <span {...stylex.attrs(s.title)}>Title</span>
      <For each={COLUMNS}>
        {(c) => (
          <span {...stylex.attrs(s.cell, s.headCell, WIDE.has(c) && s.wide, END.has(c) && s.end, WIDTH[c])} data-col={c}>
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
            <span {...stylex.attrs(cols.isSet(c) && s.headSet)}>{c === "updated" ? props.time : HEAD[c]}</span>
          </span>
        )}
      </For>
    </div>
  );
}

/** The hover card over a row's labels or blockers, once one shows. */
export function CardLayer(props: { card: Card; search: string }) {
  const card = props.card;
  return (
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

export type Cols = ReturnType<typeof createColumns>;

/** The columns' widths as the custom properties every cell reads: set on the list's (or tree's) column. */
export function widthsOf(cols: Cols) {
  return s.widths(cols.width("labels"), cols.width("blockers"), cols.width("progress"), cols.width("ref"), cols.width("who"), cols.width("updated"));
}

/** The hover card's state: which row's labels or blockers it shows, and where. */
export function createCard() {
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

export type Card = ReturnType<typeof createCard>;

function Rows(props: {
  rows: IssueRow[];
  /** When the rows' read began: the tab's writes show over anything older. */
  readStart: number;
  search: string;
  openId?: number;
  /** More pages follow the loaded rows. */
  more: boolean;
  onNearEnd: () => void;
  time: (r: IssueRow) => number | null;
  cols: Cols;
  card: Card;
}) {
  let scroller!: HTMLDivElement;
  // The rows in the order shown: a live change to the order is held while the user may be about
  // to act (held.ts). When a batch takes the selected issue out of the list, the selection goes to
  // the issue that took its row, unless the panel needs it kept (`keepsSelection`).
  const held = createHeld({
    target: () => props.rows,
    view: () => props.search,
    scroller: () => scroller,
    pitch: ROW_HEIGHT,
    // The hover card floats over the list: the pointer on it is still on the list.
    region: (t) => t.closest('[data-perf="card"]') !== null,
    onApplied: ({ gone, taker, place }) => {
      const was = untrack(selected);
      if (was === undefined || !gone.has(was)) return;
      const next = taker(was);
      if (next === undefined) return;
      // Until the check below answers, j and k step from the place the issue had, and the focus,
      // if the list had it, goes to the row that took its place.
      anchor = { id: was, index: place(was), taker: next.id };
      void keepsSelection(was).then((keep) => {
        if (keep || untrack(stale) !== undefined || untrack(selected) !== was) return;
        chosenNow = next.id;
        setChosen(next.id);
        // The focus goes with it only if the list had it and the row is on screen to take it.
        const onScreen = inView(next.index);
        const has = document.activeElement instanceof HTMLElement && document.activeElement.dataset.id === String(next.id);
        if ((scroller.contains(document.activeElement) || hadFocus) && onScreen && !has) setFocusing(next.id);
        if (going === undefined) go(next.id);
      });
    },
  });
  const rows = held.rows;
  const v = createVirtualizer({
    count: () => rows().length,
    getScrollElement: () => scroller,
    size: ROW_HEIGHT,
    overscan: OVERSCAN,
  });
  const visible = createMemo(() => {
    const items = v.items();
    const first = items[0]?.index ?? 0;
    return { first, rows: rows().slice(first, first + items.length) };
  });

  // The selection is the open issue, and the keys move it (keys.ts): the next or previous row,
  // or the first or last. The row is scrolled into view and opened; if the list had the focus,
  // the focus moves to the row (roving focus: the selected row is the one in the tab order).
  // Selection follows the issue, not the row's index.
  const navigate = useNavigate();
  // The keys' choice, as a signal for the rows to show, and as it is this moment for the next
  // key: a write to a signal can wait for the navigation's transition, and a key can't. One
  // navigation goes at a time: keys pressed meanwhile (a held key) move the choice, and once the
  // route has caught up it goes on to the latest. Any other change of route (a click, Back) drops
  // the choice.
  const [chosen, setChosen] = createSignal<number>();
  let chosenNow: number | undefined;
  /** The issue the keys' navigation is on its way to. */
  let going: number | undefined;
  // A step replaces the history entry, so Back leaves the issue for where it was opened from
  // rather than walking back through every issue the keys stepped past; the first open pushes.
  const go = (id: number) => {
    going = id;
    navigate(`/issues/${id}${untrack(() => props.search)}`, { scroll: false, replace: untrack(() => props.openId) !== undefined });
  };
  createEffect(
    () => props.openId,
    (open) => {
      // Navigating builds the route's computations: not in an effect's callback.
      const next = chosenNow;
      if (going !== undefined && open === going && next !== undefined && next !== open) return queueMicrotask(() => go(next));
      going = chosenNow = undefined;
      setChosen(undefined);
    },
  );
  const selected = () => chosen() ?? props.openId;
  const index = (id = selected()) => (id === undefined ? -1 : rows().findIndex((r) => r.id === id));
  /** Whether the selected row is in the DOM: then it's the row in the tab order, else the first row there is. */
  const selectedShown = createMemo(() => {
    const at = index();
    const { first, rows } = visible();
    return at >= first && at < first + rows.length;
  });
  /** Where a step starts: the selection, or with none, a row that has the focus. */
  const from = () => {
    const at = index(chosenNow ?? props.openId);
    if (at >= 0) return at;
    const focused = document.activeElement instanceof HTMLElement && scroller.contains(document.activeElement) ? document.activeElement.dataset.id : undefined;
    return focused === undefined ? -1 : rows().findIndex((r) => String(r.id) === focused);
  };
  /**
   * The selected issue that a batch took out of the list, and the index of the row that took its
   * place: while the list checks whether the selection stays on it, a step goes from there.
   */
  let anchor: { id: number; index: number; taker: number } | undefined;
  /** The anchor, while the selection `sel` is the issue it's for and that issue isn't in the list. */
  const anchored = (sel = chosenNow ?? untrack(() => props.openId)) => (anchor !== undefined && anchor.id === sel && index(sel) < 0 ? anchor : undefined);
  /** Steps the selection by `d` rows. */
  const step = (d: 1 | -1) => {
    // From where the selected issue was in the list's order: the next row is the first after it
    // that stayed. Before any row the focus fell to.
    const a = anchored();
    if (a) return select(d > 0 ? a.index : a.index - 1);
    const at = from();
    select(at < 0 ? 0 : at + d);
  };
  /** The index of the first row inside the window: not one of the rows kept past its edge. */
  const firstInView = () => Math.ceil(scroller.scrollTop / ROW_HEIGHT);
  /** Whether row `i` is inside the window. */
  const inView = (i: number) => i >= firstInView() && (i + 1) * ROW_HEIGHT <= scroller.scrollTop + scroller.clientHeight;
  /** The row to give the focus to once it's in the DOM. */
  const [focusing, setFocusing] = createSignal<number>();
  const select = (i: number) => {
    const at = Math.max(0, Math.min(i, rows().length - 1));
    const r = rows()[at];
    if (!r) return;
    chosenNow = r.id;
    setChosen(r.id);
    v.scrollToIndex(at);
    if (scroller.contains(document.activeElement)) setFocusing(r.id);
    if (going === undefined && r.id !== props.openId) go(r.id);
  };
  // A row that moves (its own issue edited elsewhere) or leaves the window loses the DOM's focus,
  // which falls to the page. If the list had it, it goes back to the selected row, or the row in
  // the tab order if that one isn't shown. The list had the focus if it was the last to take it
  // and no press elsewhere came since (a press on the page's plain parts puts it there too).
  let hadFocus = false;
  const onFocusIn = () => (hadFocus = true);
  const away = (e: Event) => {
    if (!scroller.contains(e.target as Node)) hadFocus = false;
  };
  document.addEventListener("focusin", away);
  document.addEventListener("pointerdown", away, true);
  onCleanup(() => {
    document.removeEventListener("focusin", away);
    document.removeEventListener("pointerdown", away, true);
  });
  createEffect(
    // A fresh object on every change of the window's rows, with the row the focus would go to.
    // Otherwise, the row that took the place of a selected issue that left, while the list checks
    // it, or the first row inside the window (not one the window keeps past its edge).
    () => {
      visible();
      return { back: selectedShown() ? selected() : undefined, sel: selected() };
    },
    ({ back, sel }) => {
      if (!hadFocus || (document.activeElement !== document.body && document.activeElement !== null)) return;
      const id = back ?? untrack(() => anchored(sel)?.taker ?? rows()[firstInView()]?.id);
      if (id === undefined) return;
      scroller.querySelector<HTMLElement>(`[data-perf="row"][data-id="${id}"]`)?.focus({ preventScroll: true });
    },
  );
  // What the rows read, as functions: a conditional written in a row's props would build a new
  // computation on each read.
  /** Whether the row for `id`, `i` rows into the window, is the one in the tab order. */
  const tabbable = (id: number, i: number) => (selectedShown() ? selected() === id : i === 0);
  const setSize = createMemo(() => (props.more ? -1 : rows().length));
  const leaving = (id: number) => held.cue()?.leaving.has(id) ?? false;
  touch("next", () => step(1));
  touch("previous", () => step(-1));
  touch("first", () => select(0));
  touch("last", () => select(rows().length - 1));
  touch("toList", () => {
    const at = Math.max(from(), 0);
    const r = rows()[at];
    if (!r) return;
    v.scrollToIndex(at);
    setFocusing(r.id);
  });

  // Once the selection has rested, its neighbours' details preload (code and data, as a hover
  // does), so the next step shows them with no placeholder.
  const preload = usePreloadRoute();
  let rest: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    () => {
      const i = index();
      return i < 0 ? "" : [rows()[i - 1]?.id, rows()[i + 1]?.id].filter((id) => id !== undefined).join(",");
    },
    (ids) => {
      clearTimeout(rest);
      if (!ids) return;
      const search = untrack(() => props.search);
      rest = setTimeout(() => {
        for (const id of ids.split(",")) preload(`/issues/${id}${search}`, { preloadData: true });
      }, PRELOAD_REST_MS);
    },
  );
  onCleanup(() => clearTimeout(rest));
  // Near the end of what's loaded, ask for the next page. Driven by the last row on screen, which
  // the virtualizer moves after its own scroll handling.
  createEffect(
    () => v.end() > rows().length - NEAR_END,
    (near) => {
      if (near) props.onNearEnd();
    },
  );

  return (
    <div
      ref={scroller}
      {...stylex.attrs(s.scroller)}
      role="listbox"
      aria-label="Issues"
      data-keys="list"
      data-perf="list"
      data-perf-rows={rows().length}
      onFocusIn={onFocusIn}
      onPointerOver={rowOver}
      onPointerOut={rowOut}
    >
      <Show when={rows().length > 0} fallback={<p {...stylex.attrs(s.empty)}>Nothing matches this view.</p>}>
        <div {...stylex.attrs(s.sizer(v.totalSize()))}>
          {/* The shift cue's lines, where rows will arrive: zero height, so the cue moves nothing. */}
          <For each={held.cue()?.lines ?? []}>{(line) => <div data-perf="cue-line" {...stylex.attrs(s.cueLine(line * ROW_HEIGHT))} />}</For>
          {/* Rows that left the list, fading out where they were (copies: nothing to act on). */}
          <For each={held.ghosts()}>
            {(g) => (
              <div aria-hidden="true" inert data-perf="ghost" ref={(el) => held.fade(el, g)} {...stylex.attrs(s.ghost(g.y))}>
                {g.node}
              </div>
            )}
          </For>
          {/* Each row sits at its own place: a row that stays in the window keeps its DOM node,
              and so the focus, through a refetch that replaces its data (rows are keyed by
              issue, not by object), and the window moving never moves it, so nothing but the
              rows that came in is painted again. */}
          <For each={visible().rows} keyed={(r) => r.id}>
            {(r, i) => (
              <Row
                r={r()}
                y={(visible().first + i()) * ROW_HEIGHT}
                readStart={props.readStart}
                search={props.search}
                current={props.openId === r().id}
                selected={selected() === r().id}
                tabbable={tabbable(r().id, i())}
                pos={visible().first + i() + 1}
                of={setSize()}
                leaving={leaving(r().id)}
                takeFocus={focusing() === r().id}
                onFocusTaken={() => setFocusing(undefined)}
                time={props.time}
                cols={props.cols}
                card={props.card}
              />
            )}
          </For>
        </div>
      </Show>
      <StillImporting />
    </div>
  );
}

/**
 * What a row shows of its place in Tree mode's tree (IssueTree.tsx): an ARIA treeitem at `level`
 * (from 1), open or closed when it has children, dimmed when it's context (an ancestor shown for
 * a match below it), with `lead` (its indent, chevron and grip) before its state icon. `lead` is
 * built once for the row's life and keeps itself current.
 */
export type TreeLook = { level: number; expanded: boolean | undefined; context: boolean; lead: Element };

/**
 * A row: a link with the row's look, its place and its state on it (a few direct attributes, set
 * by one effect), and cells whose styles are static (their widths are the column's custom
 * properties, `widthsOf`). The cells' contents are plain DOM built by one more effect from the row
 * (rowParts), each part rebuilt only when what it shows changes. The pointer's work (the hover
 * cards, a PR's code preloading, the full date) is the scroller's (`rowOver`, `rowOut`).
 */
export function Row(props: {
  r: IssueRow;
  /** Where it sits in the list, in px from the top. */
  y: number;
  readStart: number;
  search: string;
  /** The open issue. */
  current: boolean;
  /** The selection: the open issue, or the one the keys just chose. */
  selected: boolean;
  /** The row in the tab order. */
  tabbable: boolean;
  /** Its place in the list, from 1, and how many rows there are (-1 while more may load). */
  pos: number;
  of: number;
  /** The shift cue marks it: it will leave this spot. */
  leaving: boolean;
  /** Take the focus, then call `onFocusTaken`. */
  takeFocus: boolean;
  onFocusTaken: () => void;
  time: (r: IssueRow) => number | null;
  cols: Cols;
  card: Card;
  /** In Tree mode: its place in the tree. */
  tree?: TreeLook;
}) {
  // A memo: every part of the row reads it, and with a write pending each read would apply the
  // write again, into a new object.
  const r = createMemo(() => overlay()?.rowWithWrites(props.r, props.readStart) ?? props.r);
  const tree = props.tree;
  let el!: HTMLAnchorElement;
  let state!: HTMLSpanElement;
  let title!: HTMLSpanElement;
  let labels!: HTMLSpanElement;
  let blockers!: HTMLSpanElement;
  let progress!: HTMLSpanElement;
  let ref!: HTMLSpanElement;
  let who!: HTMLSpanElement;
  let when!: HTMLSpanElement;
  createEffect(
    () => props.takeFocus,
    (take) => {
      if (!take) return;
      el.focus({ preventScroll: true });
      props.onFocusTaken();
    },
  );
  // An option in the list's listbox (the ARIA list pattern), or an item of the tree (its tree
  // pattern), and still a plain link the router opens on click. Its `href` is written directly, so
  // the router's link claim (its `aria-current` and `data-active`) never runs: the row sets its
  // own `aria-current`.
  const view = (
    <a ref={el} data-perf="row" noscroll>
      <span ref={state} {...stylex.attrs(s.state)} />
      <span ref={title} {...stylex.attrs(s.title)}>
        <span {...stylex.attrs(s.titleText)} />
      </span>
      <span ref={labels} data-perf="labels" />
      <span ref={blockers} {...stylex.attrs(s.cell, s.wide, s.wBlockers)} data-perf="blockers" />
      <span ref={progress} {...stylex.attrs(s.cell, s.wide, s.wProgress)} data-perf="progress" />
      <span ref={ref} {...stylex.attrs(s.cell, s.ref, s.end, s.wRef)} data-perf="ref" />
      <span ref={who} {...stylex.attrs(s.cell, s.avatars, s.wWho)} />
      <span ref={when} {...stylex.attrs(s.cell, s.when, s.end, s.wUpdated)} />
    </a>
  );
  el.setAttribute("role", tree ? "treeitem" : "option");
  if (tree) el.prepend(tree.lead);
  rowInfo.set(el, { row: r, at: () => props.time(r()), cols: props.cols, card: props.card });

  let atClass = "";
  effect(
    () => {
      const row = r();
      const blocked = row.state === "open" && row.blocked_by > 0;
      const context = tree?.context ?? false;
      return {
        href: `/issues/${row.id}${props.search}`,
        id: row.id,
        look: (props.selected ? 1 : 0) | (blocked ? 2 : 0) | (props.leaving ? 4 : 0) | (context ? 8 : 0),
        y: props.y,
        selected: props.selected,
        blocked,
        leaving: props.leaving,
        context,
        current: props.current,
        tabbable: props.tabbable,
        pos: props.pos,
        of: props.of,
        level: tree?.level,
        expanded: tree?.expanded,
      };
    },
    (v, p) => {
      // Before the first look, none of the flags is on the link.
      const q: Partial<typeof v> = p ?? { blocked: false, leaving: false, current: false, context: false };
      if (v.href !== q.href) el.setAttribute("href", v.href);
      if (v.id !== q.id) el.setAttribute("data-id", String(v.id));
      if (v.y !== q.y) {
        const at = stylex.attrs(s.at(v.y));
        atClass = at.class ?? "";
        el.setAttribute("style", at.style ?? "");
      }
      if (v.look !== q.look || v.y !== q.y) el.setAttribute("class", `${rowLook(v.look)} ${atClass}`);
      if (v.selected !== q.selected) el.setAttribute("aria-selected", v.selected ? "true" : "false");
      if (v.pos !== q.pos) el.setAttribute("aria-posinset", String(v.pos));
      if (v.of !== q.of) el.setAttribute("aria-setsize", String(v.of));
      if (v.tabbable !== q.tabbable) el.setAttribute("tabindex", v.tabbable ? "0" : "-1");
      if (v.blocked !== q.blocked) flag(el, "data-blocked", v.blocked ? "" : undefined);
      if (v.leaving !== q.leaving) flag(el, "data-cue", v.leaving ? "leave" : undefined);
      if (v.current !== q.current) flag(el, "aria-current", v.current ? "page" : undefined);
      if (tree) {
        if (v.level !== q.level) flag(el, "aria-level", v.level === undefined ? undefined : String(v.level));
        if (v.expanded !== q.expanded) flag(el, "aria-expanded", v.expanded === undefined ? undefined : v.expanded ? "true" : "false");
        if (v.context !== q.context) flag(el, "data-context", v.context ? "" : undefined);
      }
    },
  );

  const parts = rowParts({ state, title, labels, blockers, progress, ref, who, when });
  effect(
    () => {
      const row = r();
      return { row, at: props.time(row), labels: props.cols.width("labels"), blockers: props.cols.width("blockers") };
    },
    (v) => parts(v.row, v.at, v.labels, v.blockers),
  );
  return view;
}

/** Sets attribute `name` to `value`, or removes it for `undefined`. */
function flag(el: Element, name: string, value: string | undefined) {
  if (value === undefined) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

/**
 * Whether the selection stays on `id` now that it has left the list: the panel is in use on it
 * (overlay.ts), or the issue is gone from GitHub (deleted, or transferred), which the panel says in
 * place. One that's only out of this view (closed under `is:open`) lets the selection go. When
 * beghu can't say which, it stays.
 */
export async function keepsSelection(id: number): Promise<boolean> {
  // A stale tab (on another account, or signed out) can't read the issue to tell: it stays.
  if (untrack(stale) !== undefined || untrack(overlay)?.keepsSelection(id)) return true;
  try {
    // Not the cached read: the panel's own may be from before the issue went.
    // Only whether it answers matters, so any comment order will do.
    await refetchIssue(id, untrack(commentOrder) ?? "oldest");
    return false;
  } catch (e) {
    // Gone from GitHub (or out of reach): the panel says so in place.
    if (e instanceof Gone || e instanceof NoAccess) return true;
    // Any other failure: beghu can't say which, so it stays.
    return true;
  }
}

/**
 * A PR's panel shows parts an issue's doesn't, in a chunk of their own (Pull.tsx): the pointer
 * reaching a PR's row starts loading it with the panel, so a click finds it there.
 */
function preloadPull() {
  // A failure shows when the panel needs the chunk, which asks again.
  import("./Pull").catch(() => undefined);
}

/** What the scroller's pointer handlers need of a row: its issue (writes on it), its time, the columns, the card. */
type RowInfo = { row: () => IssueRow; at: () => number | null; cols: Cols; card: Card };
const rowInfo = new WeakMap<Element, RowInfo>();

/** A row's stacked cells that show a hover card: its labels, and its blockers' stack. */
const STACKS = '[data-perf="labels"], [data-perf="blockers"] > span';

/**
 * The pointer coming onto a part of a row (the list's or the tree's scroller hears it for every
 * row): a PR's row preloads its code; a row's labels (when some are left out) or blockers open
 * their card after a rest; the time shows its full date.
 */
export function rowOver(e: PointerEvent) {
  const t = e.target as Element;
  const a = t.closest('[data-perf="row"]');
  const info = a && rowInfo.get(a);
  if (!a || !info) return;
  const from = e.relatedTarget as Node | null;
  if (!a.contains(from) && info.row().pr) preloadPull();
  const stack = t.closest(STACKS);
  if (stack && a.contains(stack) && !stack.contains(from)) {
    const row = info.row();
    if (stack.matches('[data-perf="labels"]')) {
      const total = row.labels.length + (row.pr?.review ? 1 : 0);
      if (stackFit(total, info.cols.width("labels"), slots.labelSlot, slots.labelGap) < total) info.card.enter("labels", row, stack as HTMLElement);
    } else info.card.enter("blockers", row, stack as HTMLElement);
  }
  // The full date, only once the pointer is on it.
  if (t === a.lastElementChild) {
    const at = info.at();
    flag(t, "title", at === null ? undefined : fullDate(at));
  }
}

/** The pointer leaving a row's labels or blockers: their card goes after a moment. */
export function rowOut(e: PointerEvent) {
  const stack = (e.target as Element).closest(STACKS);
  const a = stack?.closest('[data-perf="row"]');
  const info = a && rowInfo.get(a);
  if (!stack || !info || stack.contains(e.relatedTarget as Node | null)) return;
  info.card.hide();
}

/** A muted mark for a field the search matched in: the title, the description, a comment. */
const MATCH_ICON: Record<SearchField, () => Element> = {
  title: () =>
    (
      <svg viewBox="0 0 16 16" width="12" height="12" role="img" aria-label="Matched in the title" {...stylex.attrs(s.matchIcon)}>
        <title>Matched in the title</title>
        <path d="M3 3.5h10M8 3.5V13" fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg>
    ) as Element,
  body: () =>
    (
      <svg viewBox="0 0 16 16" width="12" height="12" role="img" aria-label="Matched in the description" {...stylex.attrs(s.matchIcon)}>
        <title>Matched in the description</title>
        <path d="M2.5 4h11M2.5 8h11M2.5 12h7" fill="none" stroke="currentColor" stroke-width="1.5" />
      </svg>
    ) as Element,
  comments: () =>
    (
      <svg viewBox="0 0 16 16" width="12" height="12" role="img" aria-label="Matched in a comment" {...stylex.attrs(s.matchIcon)}>
        <title>Matched in a comment</title>
        <path d="M2.75 2.75h10.5v8H7.5l-3 2.5v-2.5H2.75z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      </svg>
    ) as Element,
};

/** A label's colour dot. GitHub's label colours are data, so they come in as a dynamic style. */
export function LabelDot(props: { color: string }) {
  return <span {...stylex.attrs(s.dot(`#${props.color}`))} />;
}

/** A span with `look` (a `stylex.attrs` result's class) and, if given, `text`. */
function span(look: string, text?: string): HTMLSpanElement {
  const el = document.createElement("span");
  if (look) el.className = look;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Each label colour's dot, as `stylex.attrs` gives it: label colours repeat, so built once each. */
const dots = new Map<string, { class?: string; style?: string }>();

function dotNode(color: string): HTMLSpanElement {
  let look = dots.get(color);
  if (!look) dots.set(color, (look = stylex.attrs(s.dot(`#${color}`))));
  const el = span(look.class ?? "");
  if (look.style) el.setAttribute("style", look.style);
  return el;
}

/**
 * Fills a row's cells from its issue, as LabelDot, ReviewChip, Avatar and the rest show them, as
 * plain DOM: each call rebuilds only the parts whose content changed since the last.
 */
function rowParts(c: {
  state: HTMLElement;
  title: HTMLElement;
  labels: HTMLElement;
  blockers: HTMLElement;
  progress: HTMLElement;
  ref: HTMLElement;
  who: HTMLElement;
  when: HTMLElement;
}) {
  const was: Record<"icon" | "title" | "matched" | "labels" | "blockers" | "progress" | "ref" | "who" | "when", string | undefined> = {
    icon: undefined,
    title: undefined,
    matched: undefined,
    labels: undefined,
    blockers: undefined,
    progress: undefined,
    ref: undefined,
    who: undefined,
    when: undefined,
  };
  /** Whether part `k` now shows `key`, noting it. */
  const changed = (k: keyof typeof was, key: string) => {
    if (was[k] === key) return false;
    was[k] = key;
    return true;
  };
  return (r: IssueRow, at: number | null, labelsWidth: number, blockersWidth: number) => {
    const icon = r.pr ? `pr ${r.pr.status}` : issueState(r);
    if (changed("icon", icon)) c.state.replaceChildren(r.pr ? prIconNode[r.pr.status]() : stateIconNode[issueState(r)]());
    if (changed("title", r.title)) c.title.firstElementChild!.textContent = r.title;
    if (changed("matched", r.matched.join(" "))) {
      c.title.firstElementChild!.nextElementSibling?.remove();
      if (r.matched.length > 0) {
        const m = span(LOOK.matched);
        m.dataset.perf = "matched";
        m.dataset.fields = r.matched.join(" ");
        m.append(...r.matched.map((f) => MATCH_ICON[f]()));
        c.title.append(m);
      }
    }
    const review = r.pr?.review ?? null;
    if (changed("labels", `${labelsWidth} ${review ?? ""} ${r.labels.map((l) => `${l.color}:${l.name}`).join("\u0000")}`)) {
      const total = r.labels.length + (review ? 1 : 0);
      const stacked = total > 1;
      const fit = stackFit(total, labelsWidth, slots.labelSlot, slots.labelGap);
      c.labels.className = stacked ? LOOK.labelsStacked : LOOK.labelsFlat;
      const nodes: Node[] = [];
      if (review && fit > 0) nodes.push(reviewChipNode(review));
      for (const l of r.labels.slice(0, fit - nodes.length)) {
        const pill = span(stacked ? LOOK.stacked : LOOK.pill);
        pill.title = l.name;
        pill.append(dotNode(l.color), span(LOOK.clip, l.name));
        nodes.push(pill);
      }
      if (total > nodes.length) nodes.push(span(LOOK.more, `+${total - nodes.length}`));
      c.labels.replaceChildren(...nodes);
    }
    const blocked = r.state === "open" && r.blocked_by > 0;
    if (changed("blockers", blocked ? `${blockersWidth} ${r.repo} ${r.blocked_by} ${r.blockers.map(blockerKey).join(" ")}` : "")) {
      if (!blocked) c.blockers.replaceChildren();
      else {
        const stacked = r.blocked_by > 1;
        const stack = span(stacked ? LOOK.chipStack : LOOK.labelsPlain);
        const shown = r.blockers.slice(0, stackFit(r.blocked_by, blockersWidth, slots.blockerSlot, slots.blockerGap));
        for (const b of shown) stack.append(blockerChip(b, r.repo, stacked));
        if (r.blocked_by > shown.length) stack.append(span(LOOK.more, `+${r.blocked_by - shown.length}`));
        c.blockers.replaceChildren(stack);
      }
    }
    const p = r.progress;
    if (changed("progress", p ? `${p.done}/${p.total}` : "")) {
      if (!p) c.progress.replaceChildren();
      else {
        const el = span(LOOK.progress);
        el.title = `${p.done} of ${p.total} sub-issues closed, at every level`;
        el.append(progressRingNode(p.done, p.total), `${p.done}/${p.total}`);
        c.progress.replaceChildren(el);
      }
    }
    const ref = `${r.repo}#${r.number}`;
    if (changed("ref", ref)) c.ref.textContent = ref;
    const who = r.assignees.slice(0, 3).map((u) => u.login);
    if (changed("who", who.join(" "))) c.who.replaceChildren(...who.map((login) => avatarNode(login)));
    const when = at === null ? "" : ago(at);
    const first = was.when === undefined;
    if (changed("when", when)) {
      c.when.textContent = when;
      // Its full date comes when the pointer reaches it (rowOver).
      if (!first) c.when.removeAttribute("title");
    }
  };
}

/** What a blocker's chip shows. */
function blockerKey(b: Blocker): string {
  return `${b.repo}#${b.number}:${b.assignee ?? ""}:${blockerStatus(b)}`;
}

/**
 * A blocker's chip (who has it, and its number). Amber and dashed when nobody has it; red when
 * it's itself blocked.
 */
function blockerChip(b: Blocker, repo: string, stacked: boolean): HTMLSpanElement {
  const status = blockerStatus(b);
  const chip = span(LOOK.chip[`${stacked ? "small" : "full"} ${status}`]!);
  chip.dataset.perf = "blocker";
  chip.append(b.assignee ? avatarNode(b.assignee, stacked ? 11 : 14) : span(stacked ? LOOK.nooneSmall : LOOK.noone));
  if (b.repo !== repo) chip.append(span(LOOK.clip, b.repo));
  chip.append(span(LOOK.num, `#${b.number}`));
  return chip;
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
    // The list places its rows and keeps its own scroll position through a held change
    // (held.ts): the browser's scroll anchoring would move it again.
    overflowAnchor: "none",
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
  // A row's place in the list. Not a transform: the held changes' slide animates that.
  at: (y: number) => ({
    position: "absolute",
    left: 0,
    right: 0,
    top: y,
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
  // Tree mode's context: an ancestor shown for a match below it, its text dimmed.
  context: {
    color: colors.context,
  },
  // A blocked row's red edge.
  blocked: {
    boxShadow: `inset 3px 0 0 ${colors.danger}`,
  },
  // A row that left the list, over the rows while it fades out.
  ghost: (y: number) => ({
    pointerEvents: "none",
    position: "absolute",
    zIndex: 1,
    left: 0,
    right: 0,
    top: y,
  }),
  // The shift cue where a row will arrive: a 2 px line on the boundary between two rows.
  cueLine: (y: number) => ({
    backgroundColor: colors.accent,
    pointerEvents: "none",
    position: "absolute",
    zIndex: 1,
    height: 2,
    left: 0,
    right: 0,
    top: Math.max(0, y - 1),
  }),
  state: {
    display: "flex",
    flexShrink: 0,
    width: 16,
  },
  title: {
    gap: 6,
    alignItems: "center",
    display: "flex",
    flexBasis: 0,
    flexGrow: 1,
    minWidth: 0,
  },
  titleText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  // The fields a search matched in, after the title.
  matched: {
    gap: 3,
    color: colors.muted,
    display: "flex",
    flexShrink: 0,
  },
  matchIcon: {
    display: "block",
  },
  cell: {
    overflow: "hidden",
    flexShrink: 0,
  },
  // The columns' widths, set once for every cell (widthsOf).
  widths: (labels: number, blockers: number, progress: number, ref: number, who: number, updated: number) => ({
    [colW.labels]: `${labels}px`,
    [colW.blockers]: `${blockers}px`,
    [colW.progress]: `${progress}px`,
    [colW.ref]: `${ref}px`,
    [colW.who]: `${who}px`,
    [colW.updated]: `${updated}px`,
  }),
  wLabels: {
    width: colW.labels,
  },
  wBlockers: {
    width: colW.blockers,
  },
  wProgress: {
    width: colW.progress,
  },
  wRef: {
    width: colW.ref,
  },
  wWho: {
    width: colW.who,
  },
  wUpdated: {
    width: colW.updated,
  },
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

/** The class of `styles`, as `stylex.attrs` gives it: for the looks built once, below. */
function cls(...styles: (stylex.StyleXStyles | false)[]): string {
  return stylex.attrs(...styles).class ?? "";
}

/** Each header cell's width. */
const WIDTH: Record<Column, stylex.StyleXStyles> = {
  labels: s.wLabels,
  blockers: s.wBlockers,
  progress: s.wProgress,
  ref: s.wRef,
  who: s.wWho,
  updated: s.wUpdated,
};

/** The row's own look for each mix of selected (1), blocked (2), leaving (4) and context (8). */
const ROW_LOOK = Array.from({ length: 16 }, (_, f) =>
  cls(s.row, s.link, (f & 1) !== 0 && s.current, (f & 2) !== 0 && s.blocked, (f & 4) !== 0 && cueStyles.leave, (f & 8) !== 0 && s.context),
);

function rowLook(f: number): string {
  return ROW_LOOK[f]!;
}

/** The looks of a row's parts (rowParts). */
const LOOK = {
  matched: cls(s.matched),
  labelsFlat: cls(s.cell, s.wide, s.wLabels, s.labels),
  labelsStacked: cls(s.cell, s.wide, s.wLabels, s.stack),
  labelsPlain: cls(s.labels),
  stacked: cls(s.stacked),
  pill: cls(s.pill),
  clip: cls(s.clip),
  more: cls(s.more),
  chipStack: cls(s.chipStack),
  progress: cls(s.progress),
  noone: cls(s.noone),
  nooneSmall: cls(s.noone, s.nooneSmall),
  num: cls(s.num),
  /** A blocker's chip, by size (`full` or `small`, stacked) and status (blockerStatus). */
  chip: Object.fromEntries(
    (["full", "small"] as const).flatMap((z) =>
      (["chain", "nobody", "moving"] as const).map((st) => [`${z} ${st}`, cls(s.chip, z === "small" && s.chipSmall, st === "chain" && s.chain, st === "nobody" && s.nobody)]),
    ),
  ) as Record<string, string>,
};
