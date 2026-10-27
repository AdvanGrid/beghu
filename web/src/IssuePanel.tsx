// The issue detail panel: the `/issues/:id` route, beside the list, or under it below 900 px. Its
// own chunk, loaded lazily (router.tsx). The detail is a router `query` that a hover or tap on its
// row preloads with this chunk, so a click shows it with no placeholder; after a hover longer than
// the router keeps a preload, the remembered detail (api.ts) shows at once while a refetch
// replaces it, and if that refetch fails, the detail's failure replaces it instead.
// Comments come newest first (or oldest, by the account's preference), 15 at a time: page 2 after
// the first paint, later pages as the reader nears the end. A live push refetches the open detail
// through its last loaded comment in one request, and drops what the tab read earlier of every
// issue it names (`refetchOpenIssue`).
// The composer (with Close and Reopen) is a chunk of its own, the writes code (writes.tsx), loaded
// once the detail shows; the tab's pending writes show over the detail through overlay.ts. The
// Labels, Assignees and Milestone rows each open a picker (Pickers.tsx, another chunk, loaded the
// first time one opens); a pick shows on its own row only, which grows only itself, and its dot
// and failure in the row's marker slot, a line the row always keeps.
// A PR opens in the same layout, read-only: no composer, no pickers and no write affordances.
// What only a PR shows (its status badge, branches and review chip, "Open on GitHub" as the
// primary action, the link out to reviews) is a chunk of its own too (Pull.tsx); an issue shows
// its linked PRs, and a PR the issues it closes, each in a property row.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, Errored, For, lazy, Loading, onCleanup, onSettled, Show, untrack, type Element } from "solid-js";
import { revalidate, useLocation, type RouteSectionProps } from "@solidjs/router";
import { Dynamic } from "@solidjs/web";
import {
  Deleted,
  Gone,
  Moved,
  NoAccess,
  SessionEnded,
  forgetPushed,
  getComments,
  getIssue,
  issueId,
  mergeRefs,
  readAt,
  readBefore,
  refetchIssue,
  signIn,
  stamp,
  takeRemembered,
  type Comment,
  type IssueDetail,
  type IssueRef,
} from "./api";
import { Avatar, issueState, StateIcon, type IssueState } from "./bits";
import type { SearchField } from "./bindings/SearchField";
import { StillImporting } from "./WhileImporting";
import type { User } from "./bindings/User";
import { searchOf, type Term } from "./highlight";
import { touch } from "./keys";
import { coalesced, onPush, resetAt } from "./live";
import { overlay, type Prop, type ShownComment, type ShownDetail } from "./overlay";
import { queryOf } from "./query";
import { Blocks, Linked, ParentCrumb, RelatesTo, SubIssues } from "./Relationships";
import { Markdown } from "./md/Markdown";
import { md } from "./md/tokens.stylex";
import { marked } from "./md/walker";
import type { Links } from "./md/links";
import { IssueNotice, reloadOnce, resetOnChange } from "./Root";
import { ChunkFailed } from "./router";
import { ago, fullDate } from "./time";
import { colors, fonts, media as mediaQueries } from "./tokens.stylex";

/** Below 900 px of viewport the panel sits under the list (Root.tsx lays that out). */
const STACKED = mediaQueries.stacked.replace(/^@media /, "");
/** The narrowest either side of the divider may be. */
const MIN_SIDE = 360;
/** The divider's own width. */
const DIVIDER = 4;
/** Where the panel's width is kept on this device. */
const WIDTH_KEY = "beghu.detail-width";

/** The composer and the rest of the writes code: not needed for the detail's first paint. */
const Composer = lazy(() => import("./writes"), { export: "Composer" });
/** A lost issue's unsent text, from the same code. */
const KeptText = lazy(() => import("./writes"), { export: "KeptText" });
/**
 * The label, assignee and milestone pickers: loaded when one first opens. A failed load reloads
 * the URL once, as a route's does (a deploy replaced the build), then says so in place.
 */
const Picker = lazy(
  () =>
    import("./Pickers").catch((e: unknown) => {
      throw new ChunkFailed(`can't load the pickers: ${String(e)}`);
    }),
  { export: "Picker" },
);

/** What only a PR's panel shows: its own chunk, which an issue's panel never loads. */
const PullBadge = lazy(() => import("./Pull"), { export: "PullBadge" });
const PullBranches = lazy(() => import("./Pull"), { export: "PullBranches" });
const OpenOnGitHub = lazy(() => import("./Pull"), { export: "OpenOnGitHub" });
const ReviewsElsewhere = lazy(() => import("./Pull"), { export: "ReviewsElsewhere" });

/** The open issue and what a push naming it does: refetch its detail, or retry its failure. */
let openDetail: { id: number; onPush: () => Promise<void> } | undefined;

/**
 * What the live stream's push handler (#90) calls with the ids of the issues a push names. For
 * each, nothing the tab read before shows again: a hover's remembered detail goes, a hover read
 * still on its way won't be remembered, and the router's cached `getIssue` read is revalidated, so
 * the next open fetches afresh (api.ts, `forgetPushed`). If the open issue is among them, its
 * detail is refetched through its last loaded comment, in one request; a failed refetch keeps
 * what's on screen, except that a deleted or inaccessible issue shows its in-place state. If the
 * open issue's detail is showing its failure, the push acts as Retry. Never rejects.
 */
export function refetchOpenIssue(ids: readonly number[]): Promise<void> {
  forgetPushed(ids);
  return openDetail && ids.includes(openDetail.id) ? openDetail.onPush() : Promise.resolve();
}

// The live stream (live.ts), from when this code loads: `ids` go to `refetchOpenIssue`, and a
// reset refetches the open issue (live.ts itself forgets the remembered detail and the cached
// reads). Before this code loads no issue is open, and the router's cache is cleared on every push.
const unsubscribe = onPush((p) => {
  if (p.kind === "defs") return;
  void refetchOpenIssue(p.kind === "ids" ? p.ids : openDetail ? [openDetail.id] : []);
});
// A hot reload of this file in development subscribes its new copy instead.
import.meta.hot?.dispose(unsubscribe);

export function IssuePanel(props: RouteSectionProps) {
  const location = useLocation();
  // A path id that isn't a number asks for an issue that can't exist; the server says Gone.
  const id = () => issueId(props.params.id);
  const stacked = media(STACKED);
  const [preferred, setPreferred] = createSignal<number | undefined>(readWidth());
  const [room, setRoom] = createSignal(0);
  let panel!: HTMLElement;

  // Both sides keep at least MIN_SIDE; with no width kept, the panel takes half.
  const width = () => {
    const total = room() - DIVIDER;
    const want = preferred() ?? total / 2;
    return Math.round(Math.max(MIN_SIDE, Math.min(want, total - MIN_SIDE)));
  };

  onSettled(() => {
    const main = panel.parentElement!;
    const ro = new ResizeObserver(() => setRoom(main.clientWidth));
    ro.observe(main);
    setRoom(main.clientWidth);
    // Another tab moved its divider: the device's width follows.
    const onStorage = (e: StorageEvent) => {
      if (e.key === WIDTH_KEY) setPreferred(readWidth());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      ro.disconnect();
      window.removeEventListener("storage", onStorage);
    };
  });

  const drag = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const right = panel.parentElement!.getBoundingClientRect().right;
    const move = (m: PointerEvent) => setPreferred(right - m.clientX);
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
      handle.removeEventListener("pointercancel", done);
      writeWidth(width());
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
    handle.addEventListener("pointercancel", done);
  };

  return (
    <>
      <Show when={!stacked()}>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the issue panel"
          aria-valuemin={MIN_SIDE}
          aria-valuemax={Math.max(MIN_SIDE, room() - DIVIDER - MIN_SIDE)}
          aria-valuenow={width()}
          data-perf="divider"
          title="Drag to resize; double-click to reset"
          {...stylex.attrs(s.divider)}
          onPointerDown={drag}
          onDblClick={() => {
            setPreferred(undefined);
            writeWidth(undefined);
          }}
        />
      </Show>
      <section
        ref={panel}
        aria-label="Issue"
        data-perf="panel"
        data-keys="panel"
        {...stylex.attrs(s.panel, stacked() ? s.stacked : s.side(width()))}
      >
        <Errored fallback={(err, reset) => <DetailFailure error={err()} reset={reset} id={id()} search={location.search} />}>
          <Loading fallback={<div data-perf="detail-loading" {...stylex.attrs(s.loading)} aria-busy="true" />}>
            <Detail id={id()} search={location.search} />
          </Loading>
        </Errored>
      </section>
    </>
  );
}

function Detail(props: { id: number; search: string }) {
  /** The issue showing a remembered detail, until its refetch is under way. */
  let fromMemory: number | undefined;
  /**
   * The refetch that was to replace a remembered detail failed: `d` throws it, once, to the
   * detail's Errored. Its Retry re-runs `d`, which then reads afresh.
   */
  let failure: { error: unknown } | undefined;
  /** Bumped to re-run `d`, to throw a `failure`. */
  const [rerun, setRerun] = createSignal(0);
  /** The issue last opened at its top; `d` reading afresh (a new id, or a Retry) clears it. */
  let shown: number | undefined;
  // Follows the route's id; later comment pages and refetches write into it. The read is
  // untracked: only a new id, or a rerun, replaces the detail, never a revalidation of the read
  // (a push revalidates it, and refetches the detail in its own way).
  const [d, setD] = createSignal<IssueDetail>(() => {
    rerun();
    shown = undefined;
    if (failure) {
      const { error } = failure;
      failure = undefined;
      throw error;
    }
    const id = props.id;
    const remembered = takeRemembered(id);
    fromMemory = remembered && id;
    return remembered ?? untrack(() => getIssue(id));
  });
  /** The detail on screen; undefined while it shows its failure, or isn't there yet. */
  const current = (): IssueDetail | undefined => {
    try {
      return d();
    } catch {
      return undefined;
    }
  };
  const [lost, setLost] = createSignal<Gone | NoAccess>();
  let scroller!: HTMLDivElement;
  /** The issue whose next comment page is on its way. */
  let loadingFor: number | undefined;

  /**
   * Looking for the search's first match to bring into view: from when an issue opens or the
   * search changes until a match is on screen, or the user scrolls the detail themselves, or the
   * issue's opening reads have settled with no match. Each of those reads landing looks again,
   * so a match that comment page 2 brings is still found; nothing is fetched to find one, and
   * nothing that lands later (a live push's refetch, a later page) ever moves the detail.
   */
  let seeking = false;
  /**
   * The open issue's opening reads still on their way: its first comment page, and the refetch
   * that replaces a remembered detail.
   */
  let opening: { due: number } | undefined;
  /** The one look scheduled, to cancel before scheduling another. */
  let frame: number | undefined;
  // A scroll lands near, not on, a match far down: the comments it passes skip layout until
  // they come near (`content-visibility`), and lay out a frame or two after it lands, moving
  // the match. So it looks again each frame until the match has stayed put on screen.
  const seek = (tries = 30, last?: number) => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!seeking) return;
      const at = scrollToMatch(scroller);
      // No match yet: wait for the opening reads, if any are still on their way.
      if (at === undefined) seeking = opening !== undefined;
      else if (at === last || tries === 0) seeking = false;
      else seek(tries - 1, at);
    });
  };
  /** One of the opening reads `o` counts has landed, or failed: once all have, a last look. */
  const settle = (o: { due: number }) => {
    if (o !== opening || --o.due > 0) return;
    opening = undefined;
    seek();
  };
  onCleanup(() => {
    seeking = false;
    opening = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame);
  });
  const userScrolls = (el: HTMLDivElement) => {
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) el.addEventListener(type, () => (seeking = false), { passive: true });
  };
  // A new search on the open issue looks for its first match (an issue opening does, below).
  let searched: string | undefined;
  createEffect(
    () => JSON.stringify(searchOf(queryOf(props.search)).terms),
    (key) => {
      const changed = searched !== undefined && key !== searched;
      searched = key;
      if (changed) {
        seeking = true;
        seek();
      }
    },
  );

  /** Near the loaded end (within about one screen), ask for the next page. */
  const nearEnd = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < scroller.clientHeight;

  const loadMore = async () => {
    const have = current();
    const after = have?.comments.next ?? null;
    if (!have || loadingFor === have.id || after === null) return;
    loadingFor = have.id;
    try {
      const page = await getComments(have.id, have.comment_order, after);
      const now = d();
      // Only onto the end it was asked for: a refetch may have replaced the thread meanwhile.
      if (now.id !== have.id || now.comments.next !== after) return;
      const comments = { comments: merge(now.comments.comments, page.comments), next: page.next, refs: mergeRefs(now.comments.refs, page.refs) };
      setD(stamp({ ...now, comments }, readAt(now)));
    } catch (e) {
      // A failed page never replaces what's on screen; the next scroll asks again.
      if (e instanceof SessionEnded) signIn();
      return;
    } finally {
      if (loadingFor === have.id) loadingFor = undefined;
    }
    // Still near the end (a short page, a tall screen): keep going.
    requestAnimationFrame(() => {
      if (nearEnd()) void loadMore();
    });
  };

  /**
   * Replaces the detail with a fresh read: by default through its last loaded comment. A signed-
   * out read goes to sign in, and a deleted or inaccessible issue shows its in-place state; any
   * other failure rejects, for the caller to decide, as long as the issue is still on screen.
   */
  const refetch = async (read: (id: number, last?: Comment) => Promise<IssueDetail> = refetchIssue) => {
    const have = current();
    if (!have) return;
    const last = have.comments.comments.at(-1);
    let fresh: IssueDetail;
    try {
      fresh = await read(have.id, last);
    } catch (e) {
      if (e instanceof SessionEnded) signIn();
      else if (current()?.id !== have.id) return;
      else if (e instanceof Gone || e instanceof NoAccess) setLost(e);
      else throw e;
      return;
    }
    const now = current();
    if (now?.id !== have.id) return;
    setLost(undefined);
    // Pages that landed after the refetch left stay, after the comment it went through.
    const got = fresh.comments.comments;
    const at = last === undefined ? -1 : now.comments.comments.findIndex((c) => c.id === last.id);
    const tail = got.at(-1)?.id === last?.id && at >= 0 ? now.comments.comments.slice(at + 1) : [];
    setD(
      stamp(
        {
          ...fresh,
          comments: {
            comments: merge(got, tail),
            next: tail.length > 0 ? now.comments.next : fresh.comments.next,
            refs: tail.length > 0 ? mergeRefs(now.comments.refs, fresh.comments.refs) : fresh.comments.refs,
          },
        },
        readAt(fresh),
      ),
    );
  };

  /**
   * What a live push calls: the default refetch, whose failure keeps what's on screen. A burst of
   * pushes costs one refetch now and one after it, so an older read never lands over a newer one.
   */
  const refetchForPush = coalesced(() => refetch());

  // Each issue opens at its top, and fetches comment page 2 once it has painted; so does a Retry.
  // (The effect also runs for every write to `d`, a page or a refetch: those keep their place.)
  createEffect(
    () => d(),
    (detail) => {
      const id = detail.id;
      if (id === shown) {
        if (seeking) seek();
        return;
      }
      shown = id;
      scroller.scrollTop = 0;
      // Under a search, to its first match once it's loaded: the first comment page, and a
      // remembered detail's refetch, may bring it.
      const o = { due: fromMemory === id ? 2 : 1 };
      opening = o;
      seeking = true;
      seek();
      setLost(undefined);
      openDetail = { id, onPush: refetchForPush };
      // A remembered detail is on screen (its first page), maybe minutes old: replace it with the
      // read the click's own preload started (the router's cache keys on every argument: pass the
      // id alone). If that fails, the detail shows the failure, with Retry, which opens the issue
      // afresh, page 2 and all.
      if (fromMemory === id) {
        fromMemory = undefined;
        untrack(() => refetch((id) => getIssue(id)))
          .catch((e: unknown) => {
            failure = { error: e };
            setRerun((n) => n + 1);
          })
          .finally(() => settle(o));
      } else if (readBefore(detail, resetAt())) {
        // Its read began before a push named it or the stream reset, while nothing was open for
        // that push to refetch (the read was on its way, or the panel's code was): refetch it now.
        void untrack(refetchForPush);
      }
      requestAnimationFrame(() => setTimeout(() => void loadMore().finally(() => settle(o))));
    },
  );
  onSettled(() => () => {
    if (openDetail?.onPush === refetchForPush) openDetail = undefined;
  });

  return (
    <Show when={lost()} fallback={<Body d={d()} search={props.search} scroller={(el) => {
            scroller = el;
            userScrolls(el);
          }} onScroll={() => nearEnd() && void loadMore()} />}>
      {(e) => <LostIssue error={e()} search={props.search} id={props.id} />}
    </Show>
  );
}

/** Comments in thread order, each once: `more` after `have`, minus any `have` already holds. */
function merge(have: Comment[], more: Comment[]): Comment[] {
  if (more.length === 0) return have;
  const seen = new Set(have.map((c) => c.id));
  return [...have, ...more.filter((c) => !seen.has(c.id))];
}

/**
 * Brings the detail's first marked match into view, unless it's already on screen (the title's
 * is), and gives where it is then (a moved one's top is NaN: it's still on its way), or
 * undefined for none.
 */
function scrollToMatch(scroller: HTMLDivElement): number | undefined {
  // The walker's marks only: a post may have `<mark>`s of its own.
  const mark = scroller.querySelector('mark[data-perf="match"]');
  if (!mark) return undefined;
  const box = mark.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (box.top >= view.top && box.bottom <= view.bottom) return box.top;
  mark.scrollIntoView({ block: "center" });
  return NaN;
}

function Body(props: { d: IssueDetail; search: string; scroller: (el: HTMLDivElement) => void; onScroll: () => void }) {
  /** When the detail's read began: the tab's writes show over anything older. */
  const at = () => readAt(props.d);
  const d = createMemo((): ShownDetail => overlay()?.detailWithWrites(props.d, at()) ?? props.d);
  // The writes code learns which read the detail shows, so it can drop the writes it has caught
  // up with.
  createEffect(
    () => ({ o: overlay(), issue: props.d.id, at: at() }),
    ({ o, issue, at }) => o?.detailShown(issue, at),
  );
  // The filter bar's free text, marked in the fields it searched.
  const search = createMemo(() => searchOf(queryOf(props.search)));
  const terms = (field: SearchField): Term[] => (search().fields[field] ? search().terms : []);
  const state = () => issueState(d());
  let scroller!: HTMLDivElement;
  // Into the issue from the list: the arrows and Page keys then scroll it.
  touch("openIssue", () => scroller.focus());
  /** The property row whose picker is open. */
  const [picking, setPicking] = createSignal<Prop>();
  // Another issue opens with every picker closed. (The effect runs for every new read of the
  // detail, a refetch of the same issue too: only a new id closes them.)
  let pickingOn = untrack(() => props.d.id);
  createEffect(
    () => props.d.id,
    (id) => {
      if (id === pickingOn) return;
      pickingOn = id;
      setPicking(undefined);
    },
  );
  const setOpen = (prop: Prop) => (open: boolean) => setPicking(open ? prop : undefined);
  return (
    <>
      <div
        ref={(el) => {
          scroller = el;
          props.scroller(el);
        }}
        tabindex={-1}
        {...stylex.attrs(s.scroller)}
        data-perf="detail"
        data-id={d().id}
        onScroll={props.onScroll}
      >
        {/* Nothing here moves when a value changes length: the badge has a fixed width and comes
            first, and each property is one row of its own, so more labels only grow their row. */}
        <div {...stylex.attrs(s.status)}>
          <Show
            when={d().pr}
            fallback={
              <span {...stylex.attrs(s.badge, badgeBg[state()])} data-perf="badge" aria-describedby={`state-note-${d().id}`}>
                <StateIcon state={state()} plain />
                {BADGE_TEXT[state()]}
              </span>
            }
          >
            {(pr) => <PullBadge status={pr().status} />}
          </Show>
          <span {...stylex.attrs(s.ref)} title={`${d().owner}/${d().repo}#${d().number}`}>
            {d().repo}#{d().number}
          </span>
          <Show when={d().locked}>
            <span {...stylex.attrs(s.locked)} data-perf="locked" title="Conversation locked on GitHub">
              Locked
            </span>
          </Show>
          <Show when={!d().pr}>
            <Dynamic component={overlay()?.StateNote} issue={d().id} at={at()} />
          </Show>
          <span {...stylex.attrs(s.spacer)} />
          <Show
            when={d().pr}
            fallback={
              <a href={githubUrl(d())} target="_blank" rel="noreferrer external" {...stylex.attrs(s.action)} title="Open on GitHub">
                GitHub ↗
              </a>
            }
          >
            <OpenOnGitHub href={githubUrl(d())} />
          </Show>
          <a href={`/${props.search}`} noscroll {...stylex.attrs(s.action)} aria-label={d().kind === "pr" ? "Close the PR panel" : "Close the issue"} title="Close">
            ×
          </a>
        </div>
        <ParentCrumb rels={d().relationships} search={props.search} />
        <h2 {...stylex.attrs(s.title)} data-perf="title">
          {marked(d().title, terms("title"))}
        </h2>
        <Show when={d().pr}>{(pr) => <PullBranches pr={pr()} />}</Show>
        <dl {...stylex.attrs(s.props)}>
          <PropRow prop="assignees" title="Assignees" d={d()} at={at()} open={picking() === "assignees"} setOpen={setOpen("assignees")}>
            <For each={d().assignees} keyed={(u) => u.login} fallback={<span {...stylex.attrs(s.muted)}>No one</span>}>
              {(u) => (
                <span {...stylex.attrs(s.person)} data-perf="assignee">
                  <Avatar login={u().login} />
                  {u().login}
                </span>
              )}
            </For>
          </PropRow>
          <PropRow prop="labels" title="Labels" d={d()} at={at()} open={picking() === "labels"} setOpen={setOpen("labels")}>
            <For each={d().labels} keyed={(l) => l.name} fallback={<span {...stylex.attrs(s.muted, s.noLabels)}>None</span>}>
              {(l) => (
                <span {...stylex.attrs(s.pill)} data-perf="label">
                  <span {...stylex.attrs(s.dot(`#${l().color}`))} />
                  {l().name}
                </span>
              )}
            </For>
          </PropRow>
          <PropRow prop="milestone" title="Milestone" d={d()} at={at()} open={picking() === "milestone"} setOpen={setOpen("milestone")}>
            <Show when={d().milestone} fallback={<span {...stylex.attrs(s.muted)}>None</span>}>
              {(m) => <span data-perf="milestone-title">{m().title}</span>}
            </Show>
          </PropRow>
          <Show
            when={d().pr}
            fallback={
              <>
                <dt {...stylex.attrs(s.key)}>Linked PRs</dt>
                <dd {...stylex.attrs(s.value)}>
                  <Linked items={d().linked_prs} search={props.search} empty="None" perf="linked-prs" />
                </dd>
              </>
            }
          >
            <dt {...stylex.attrs(s.key)}>Closes</dt>
            <dd {...stylex.attrs(s.value)}>
              <Linked items={d().closes} search={props.search} empty="Nothing" perf="closes" />
            </dd>
          </Show>
        </dl>
        <Blocks rels={d().relationships} open={d().state === "open"} search={props.search} />
        <RelatesTo rels={d().relationships} search={props.search} />
        {/* The body is a post like each comment: on its tint, its byline inside. */}
        <div {...stylex.attrs(s.bodySlot)}>
          <div {...stylex.attrs(s.post)}>
            <Byline author={d().author}>
              opened <Ago at={d().created_at} /> · {d().comment_total} {d().comment_total === 1 ? "comment" : "comments"}
            </Byline>
            <div {...stylex.attrs(s.text)} data-perf="body">
              <Show when={d().body.length > 0} fallback={<span {...stylex.attrs(s.postMuted)}>No description provided.</span>}>
                <Markdown md={d().body} links={links(d(), d().refs, props.search)} terms={terms("body")} />
              </Show>
            </div>
          </div>
        </div>
        <Show when={!d().pr}>
          <SubIssues rels={d().relationships} search={props.search} />
        </Show>
        <h3 {...stylex.attrs(s.section)}>
          Comments <span {...stylex.attrs(s.muted, s.count)}>{d().comment_total}</span>
          <span {...stylex.attrs(s.muted, s.order)} data-perf="comment-order">{d().comment_order === "newest" ? "newest first" : "oldest first"}</span>
          <Show when={d().pr}>
            <ReviewsElsewhere href={githubUrl(d())} />
          </Show>
        </h3>
        <div {...stylex.attrs(s.comments)} data-perf="comments" data-perf-loaded={d().comments.comments.length}>
          <For each={d().comments.comments} keyed={(c) => c.id}>
            {(c) => <CommentView c={c()} at={at()} links={links(d(), d().comments.refs, props.search)} terms={terms("comments")} />}
          </For>
        </div>
        <Show when={d().comments.next !== null}>
          <p {...stylex.attrs(s.more)} aria-live="polite">
            Loading more comments…
          </p>
        </Show>
        <StillImporting />
      </div>
      {/* PRs take no writes in beghu. If the composer's code doesn't load, it says so in its
          place, and the detail stays. */}
      <Show when={d().kind === "issue"}>
        <Errored
          fallback={(_, reset) => (
            <p {...stylex.attrs(s.more)} role="alert">
              Couldn't load the comment box ·{" "}
              <button type="button" {...stylex.attrs(s.link)} onClick={() => reset()}>
                Retry
              </button>
            </p>
          )}
        >
          <Loading>
            <Composer d={d()} />
          </Loading>
        </Errored>
      </Show>
    </>
  );
}

/**
 * One property row: its name, which opens its picker on an issue (a PR takes no writes), as does
 * its key (`l`, `a`, `m`) with the focus in the panel; and its
 * values, then what the tab's picks on it show (a pending dot, a failed pick with Retry). The
 * picker opens over what follows, so nothing moves.
 */
function PropRow(props: { prop: Prop; title: string; d: ShownDetail; at: number; open: boolean; setOpen: (open: boolean) => void; children: Element }) {
  let button: HTMLButtonElement | undefined;
  let value: HTMLElement | undefined;
  // The marker slot describes the row's opener: a failed pick is read out with it.
  const noteId = () => `prop-note-${props.prop}-${props.d.id}`;
  const close = (refocus: boolean) => {
    props.setOpen(false);
    if (refocus) button?.focus();
  };
  // The row's key: opens the picker, or puts the focus back in it (its filter box) if it's open.
  // While the picker's code is still loading, or failed to, there's no filter box yet and the key
  // does nothing: the picker focuses its filter itself once it's there, and a failure has Retry.
  const open = () => {
    if (props.open) value?.querySelector<HTMLElement>('[data-keys="picker"] input')?.focus();
    else props.setOpen(true);
  };
  return (
    <>
      <dt {...stylex.attrs(s.key)}>
        <Show when={props.d.kind === "issue"} fallback={props.title}>
          <Offer action={props.prop} run={open} />
          <button
            ref={button}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={props.open ? "true" : "false"}
            aria-describedby={noteId()}
            data-perf={`pick-${props.prop}`}
            {...stylex.attrs(s.keyButton)}
            onClick={() => props.setOpen(!props.open)}
          >
            {props.title}
          </button>
        </Show>
      </dt>
      <dd ref={value} {...stylex.attrs(s.value, s.anchor)} data-perf={props.prop}>
        {props.children}
        {/* The row's marker slot: one line it always keeps, so a pick's dot or failure moves
            nothing. Only an issue takes picks. */}
        <Show when={props.d.kind === "issue"}>
          <span id={noteId()} {...stylex.attrs(s.noteSlot)} data-perf="prop-note">
            <Dynamic component={overlay()?.PropNote} issue={props.d.id} prop={props.prop} at={props.at} />
          </span>
        </Show>
        <Show when={props.open}>
          <Errored fallback={(err, reset) => <PickerFailure error={err()} reset={reset} />}>
            <Loading>
              <Picker prop={props.prop} d={props.d} onClose={close} opener={button} />
            </Loading>
          </Errored>
        </Show>
      </dd>
    </>
  );
}

/** Offers `action` (keys.ts) while it's shown: a PR's rows don't show it, so offer no write keys. */
function Offer(props: { action: Prop; run: () => void }) {
  touch(props.action, () => props.run());
  return null;
}

/**
 * A picker's code didn't load: the URL reloads once (a deploy that replaced the build is the
 * usual cause, and a fresh page names the new chunks), then it says so with Retry.
 */
function PickerFailure(props: { error: unknown; reset: () => void }) {
  const location = useLocation();
  // Decided once, as the failure shows: a reload leaves the page, and Retry must not flash first.
  const chunk = untrack(() => props.error instanceof ChunkFailed);
  const reloading = chunk && reloadOnce(location.pathname + location.search + location.hash);
  return (
    <Show when={!reloading}>
      <span {...stylex.attrs(s.muted)} role="alert">
        Couldn't load the picker{chunk ? "; beghu may have been updated" : ""} ·{" "}
        <button type="button" {...stylex.attrs(s.link)} onClick={() => props.reset()}>
          Retry
        </button>
      </span>
    </Show>
  );
}

/** What the links in `d`'s posts resolve against: their place, the list's view, and `refs`. */
function links(d: Pick<IssueDetail, "owner" | "repo" | "number">, refs: IssueDetail["refs"], search: string): Links {
  return { place: { owner: d.owner, repo: d.repo, number: d.number }, search, refs: (key) => refs[key] };
}

function CommentView(props: { c: ShownComment; at: number; links: Links; terms: Term[] }) {
  const body = () => ("body" in props.c ? props.c.body : undefined);
  const typed = () => ("typed" in props.c ? props.c.typed : undefined);
  return (
    <article {...stylex.attrs(s.post, s.comment)} data-perf="comment" data-id={props.c.id} data-comment-id={props.c.id} data-op={props.c.op}>
      <Byline author={props.c.author}>
        <Ago at={props.c.created_at} />
        <Show when={props.c.op}>{(op) => <Dynamic component={overlay()?.CommentNote} op={op()} at={props.at} />}</Show>
      </Byline>
      {/* A comment GitHub hasn't confirmed has no AST yet: its text shows as typed. */}
      <Show when={body()} fallback={<div {...stylex.attrs(s.text, s.plain)}>{marked(typed() ?? "", props.terms)}</div>}>
        {(md) => (
          <div {...stylex.attrs(s.text)}>
            <Markdown md={md()} links={props.links} terms={props.terms} />
          </div>
        )}
      </Show>
    </article>
  );
}

/** Who wrote something (a deleted GitHub account shows as "ghost"), then `children`, muted. */
function Byline(props: { author: User | null; children: Element }) {
  const login = () => props.author?.login ?? "ghost";
  return (
    <div {...stylex.attrs(s.byline)}>
      <Avatar login={login()} size={20} />
      <span>
        <b {...stylex.attrs(s.who)}>{login()}</b> <span {...stylex.attrs(s.postMuted)}>{props.children}</span>
      </span>
    </div>
  );
}

/** How long ago, with the full date on hover. */
function Ago(props: { at: number }) {
  return (
    <time datetime={new Date(props.at * 1000).toISOString()} title={fullDate(props.at)}>
      {ago(props.at)} ago
    </time>
  );
}

/** Where an issue or PR is on GitHub. */
function githubUrl(i: Pick<IssueRef, "kind" | "owner" | "repo" | "number">): string {
  return `https://github.com/${i.owner}/${i.repo}/${i.kind === "pr" ? "pull" : "issues"}/${i.number}`;
}

/**
 * The detail failed to load: a deleted or inaccessible issue says so in place; anything else
 * offers Retry. A new issue opened from the list tries again, and so does a push naming this one.
 */
function DetailFailure(props: { error: unknown; reset: () => void; id: number; search: string }) {
  resetOnChange(() => props.id, props.reset);
  const retry = () => {
    // Drop the failed read from the query cache, so the retry fetches again.
    void revalidate(getIssue.keyFor(props.id));
    props.reset();
  };
  onSettled(() => {
    const mine = { id: untrack(() => props.id), onPush: async () => retry() };
    openDetail = mine;
    return () => {
      if (openDetail === mine) openDetail = undefined;
    };
  });
  return (
    <Show when={props.error instanceof Gone || props.error instanceof NoAccess} fallback={<IssueNotice error={props.error} retry={retry} />}>
      <LostIssue error={props.error as Gone | NoAccess} search={props.search} id={props.id} />
    </Show>
  );
}

/** What a lost issue says happened to it. */
function lostWhy(e: Gone | NoAccess): string {
  if (e instanceof NoAccess) return "This issue is in a repo that isn't synced.";
  if (e instanceof Deleted) return "This issue was deleted.";
  if (e instanceof Moved) return e.id === undefined ? "This issue moved out of your synced repos." : "This issue moved.";
  return "This issue was deleted, or it moved out of your synced repos.";
}

/**
 * A deleted issue, one moved (to where it is now: in-app when it's still in the synced repos, else
 * a link out to GitHub), or one outside the synced repos, in place of the detail. Any text the tab
 * hadn't sent on it stays, to copy.
 */
function LostIssue(props: { error: Gone | NoAccess; search: string; id: number }) {
  const elsewhere = () => {
    const e = props.error;
    if (e instanceof NoAccess) return e.issue;
    return e instanceof Moved && e.id === undefined ? e.issue : undefined;
  };
  const movedHere = () => (props.error instanceof Moved && props.error.id !== undefined ? props.error : undefined);
  return (
    <div {...stylex.attrs(s.notice)} role="status" data-perf="detail-lost">
      <p {...stylex.attrs(s.lostTitle)}>{lostWhy(props.error)}</p>
      <Show when={movedHere()}>
        {(m) => (
          <p {...stylex.attrs(s.elsewhere)}>
            It's {m().issue.owner}/{m().issue.repo}#{m().issue.number} now · {m().issue.title} ·{" "}
            <a href={`/issues/${m().id}${props.search}`} noscroll {...stylex.attrs(s.link)}>
              Open it
            </a>
          </p>
        )}
      </Show>
      <Show when={elsewhere()}>
        {(i) => (
          <p {...stylex.attrs(s.elsewhere)}>
            {i().owner}/{i().repo}#{i().number} · {i().title} ·{" "}
            <a href={githubUrl(i())} target="_blank" rel="noreferrer external" {...stylex.attrs(s.link)}>
              Open on GitHub
            </a>
          </p>
        )}
      </Show>
      {/* The writes code is loaded by then if the tab wrote anything here; if it can't load,
          there's nothing of the tab's to show. */}
      <Errored fallback={() => null}>
        <Loading>
          <KeptText issue={props.id} />
        </Loading>
      </Errored>
      <a href={`/${props.search}`} noscroll {...stylex.attrs(s.link)}>
        Back to the list
      </a>
    </div>
  );
}

/** A media query's match, kept current. */
function media(query: string) {
  const mq = window.matchMedia(query);
  const [matches, setMatches] = createSignal(mq.matches);
  onSettled(() => {
    const on = () => setMatches(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  });
  return matches;
}

function readWidth(): number | undefined {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeWidth(px: number | undefined) {
  try {
    if (px === undefined) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(px));
  } catch {
    // Storage blocked: the width lasts until the tab closes.
  }
}

const BADGE_TEXT: Record<IssueState, string> = { open: "Open", done: "Closed", notPlanned: "Not planned" };

const s = stylex.create({
  divider: {
    backgroundColor: {
      default: colors.line,
      ":hover": colors.accent,
    },
    cursor: "col-resize",
    flexShrink: 0,
    touchAction: "none",
    width: DIVIDER,
  },
  panel: {
    backgroundColor: colors.bg,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    minWidth: 0,
  },
  side: (width: number) => ({
    flexShrink: 0,
    width,
  }),
  stacked: {
    flexBasis: 0,
    flexGrow: 6,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  loading: {
    flexGrow: 1,
  },
  scroller: {
    flexGrow: 1,
    overflowAnchor: "none",
    overflowY: "auto",
  },
  status: {
    gap: 10,
    paddingBlock: 12,
    paddingInline: 16,
    alignItems: "center",
    display: "flex",
    whiteSpace: "nowrap",
  },
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
  ref: {
    overflow: "hidden",
    color: colors.muted,
    fontFamily: fonts.mono,
    fontSize: 12,
    textOverflow: "ellipsis",
    minWidth: 0,
  },
  spacer: {
    flexGrow: 1,
  },
  locked: {
    borderColor: colors.line,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 8,
    color: colors.muted,
    flexShrink: 0,
    fontSize: 12,
    lineHeight: "20px",
  },
  action: {
    textDecoration: "none",
    color: {
      default: colors.muted,
      ":hover": colors.fg,
    },
    fontSize: 12,
  },
  title: {
    margin: 0,
    paddingInline: 16,
    fontSize: 18,
    fontWeight: 600,
    lineHeight: 1.3,
    overflowWrap: "anywhere",
    paddingBottom: 12,
  },
  props: {
    margin: 0,
    paddingInline: 16,
    display: "grid",
    gridTemplateColumns: "88px minmax(0, 1fr)",
    paddingBottom: 8,
  },
  key: {
    paddingBlock: 4,
    color: colors.muted,
    fontSize: 12,
    lineHeight: "20px",
  },
  // A row's name as the button that opens its picker: it reads as the name, with a hover.
  keyButton: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: {
      default: colors.muted,
      ":hover": colors.fg,
    },
    cursor: "pointer",
    textAlign: "start",
  },
  value: {
    margin: 0,
    gap: 4,
    paddingBlock: 4,
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    minWidth: 0,
  },
  // A property row's marker slot: a line of its own under the row's values, always there.
  noteSlot: {
    gap: 4,
    overflow: "hidden",
    alignItems: "center",
    display: "flex",
    flexBasis: "100%",
    fontSize: 12,
    lineHeight: "16px",
    whiteSpace: "nowrap",
    height: 16,
    minWidth: 0,
  },
  // What a row's picker opens under.
  anchor: {
    position: "relative",
  },
  person: {
    gap: 5,
    alignItems: "center",
    display: "inline-flex",
    paddingInlineEnd: 6,
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
  },
  // A dynamic style sets only `color`, painted through currentColor: see the list's label dot
  // (IssueList.tsx) for why.
  dot: (color: string) => ({
    borderRadius: "50%",
    backgroundColor: "currentColor",
    color,
    flexShrink: 0,
    height: 8,
    width: 8,
  }),
  byline: {
    gap: 8,
    alignItems: "center",
    display: "flex",
  },
  // The body's post, under the relationships.
  bodySlot: {
    paddingBlock: 10,
    paddingInline: 16,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  // A post (the body or a comment): its own faint surface, no border, its byline inside.
  post: {
    borderRadius: 8,
    paddingInline: 14,
    backgroundColor: md.tint,
    paddingBottom: 14,
    paddingTop: 10,
  },
  who: {
    fontWeight: 600,
  },
  muted: {
    color: colors.muted,
    fontWeight: 400,
  },
  // Muted text on a post's tint frame, where the app's muted (4.47:1) falls short of 4.5:1.
  postMuted: {
    color: md.muted,
    fontWeight: 400,
  },
  // As tall as a label's pill (18 px and its border), so the first label picked, or the last
  // removed, moves nothing below the row.
  noLabels: {
    lineHeight: "20px",
  },
  text: {
    overflowWrap: "anywhere",
    paddingTop: 8,
  },
  // A comment's text as typed, before GitHub confirms it.
  plain: {
    whiteSpace: "pre-wrap",
  },
  section: {
    margin: 0,
    paddingBlock: 10,
    paddingInline: 16,
    backgroundColor: colors.bgRaised,
    fontSize: 13,
    fontWeight: 600,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  // Room for four digits and more, each as wide as the next, so the order label never moves.
  count: {
    display: "inline-block",
    fontVariantNumeric: "tabular-nums",
    minWidth: "5ch",
  },
  order: {
    fontSize: 12,
    paddingInlineStart: 8,
  },
  // Off-screen comments skip layout and paint, with a size estimate standing in for them.
  comment: {
    containIntrinsicSize: "auto 140px",
    marginInline: 16,
    contentVisibility: "auto",
    marginBottom: 10,
  },
  comments: {
    paddingTop: 10,
  },
  more: {
    margin: 0,
    paddingBlock: 12,
    paddingInline: 16,
    color: colors.muted,
  },
  notice: {
    margin: 0,
    padding: 24,
    color: colors.muted,
  },
  elsewhere: {
    margin: 0,
    overflowWrap: "anywhere",
    paddingBottom: 8,
  },
  lostTitle: {
    margin: 0,
    color: colors.fg,
    fontWeight: 600,
    paddingBottom: 8,
  },
  link: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    textDecoration: "underline",
    backgroundColor: "transparent",
    color: colors.accent,
    cursor: "pointer",
  },
});

const badgeBg = stylex.create({
  open: { backgroundColor: colors.openBg },
  done: { backgroundColor: colors.doneBg },
  notPlanned: { backgroundColor: colors.notPlannedBg },
});
