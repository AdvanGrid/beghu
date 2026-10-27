// The issue detail panel: the `/issues/:id` route, beside the list, or under it below 900 px. Its
// own chunk, loaded lazily (router.tsx). The detail is a router `query` that a hover or tap on its
// row preloads with this chunk, so a click shows it with no placeholder; after a hover longer than
// the router keeps a preload, the remembered detail (api.ts) shows at once while a refetch
// replaces it, and if that refetch fails, the detail's failure replaces it instead.
// Comments come newest first (or oldest, by the account's preference), 15 at a time: page 2 after
// the first paint, later pages as the reader nears the end. A live push refetches the open detail
// through its last loaded comment in one request, and drops what the tab read earlier of every
// issue it names (`refetchOpenIssue`).
import * as stylex from "@stylexjs/stylex";
import { createEffect, createSignal, Errored, For, Loading, onSettled, Show, untrack, type Element } from "solid-js";
import { revalidate, useLocation, type RouteSectionProps } from "@solidjs/router";
import {
  Gone,
  NoAccess,
  SessionEnded,
  forgetPushed,
  getComments,
  getIssue,
  issueId,
  refetchIssue,
  signIn,
  takeRemembered,
  type Comment,
  type IssueDetail,
  type IssueRef,
} from "./api";
import { Avatar, issueState, StateIcon, type IssueState } from "./bits";
import type { User } from "./bindings/User";
import { IssueNotice, resetOnChange } from "./Root";
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
 *
 * Until #90 lands, only the e2e suite calls it (web/e2e/detail.spec.ts), in place of a push.
 */
export function refetchOpenIssue(ids: readonly number[]): Promise<void> {
  forgetPushed(ids);
  return openDetail && ids.includes(openDetail.id) ? openDetail.onPush() : Promise.resolve();
}

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
      setD({ ...now, comments: { comments: merge(now.comments.comments, page.comments), next: page.next } });
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
    setD({
      ...fresh,
      comments: { comments: merge(got, tail), next: tail.length > 0 ? now.comments.next : fresh.comments.next },
    });
  };

  /** What a live push calls: the default refetch, whose failure keeps what's on screen. */
  const onPush = () => refetch().catch(() => {});

  // Each issue opens at its top, and fetches comment page 2 once it has painted; so does a Retry.
  // (The effect also runs for every write to `d`, a page or a refetch: those keep their place.)
  createEffect(
    () => d().id,
    (id) => {
      if (id === shown) return;
      shown = id;
      scroller.scrollTop = 0;
      setLost(undefined);
      openDetail = { id, onPush };
      // A remembered detail is on screen (its first page), maybe minutes old: replace it with the
      // read the click's own preload started (the router's cache keys on every argument: pass the
      // id alone). If that fails, the detail shows the failure, with Retry, which opens the issue
      // afresh, page 2 and all.
      if (fromMemory === id) {
        fromMemory = undefined;
        untrack(() => refetch((id) => getIssue(id))).catch((e: unknown) => {
          failure = { error: e };
          setRerun((n) => n + 1);
        });
      }
      requestAnimationFrame(() => setTimeout(() => void loadMore()));
    },
  );
  onSettled(() => () => {
    if (openDetail?.onPush === onPush) openDetail = undefined;
  });

  return (
    <Show when={lost()} fallback={<Body d={d()} search={props.search} scroller={(el) => (scroller = el)} onScroll={() => nearEnd() && void loadMore()} />}>
      {(e) => <LostIssue error={e()} search={props.search} />}
    </Show>
  );
}

/** Comments in thread order, each once: `more` after `have`, minus any `have` already holds. */
function merge(have: Comment[], more: Comment[]): Comment[] {
  if (more.length === 0) return have;
  const seen = new Set(have.map((c) => c.id));
  return [...have, ...more.filter((c) => !seen.has(c.id))];
}

function Body(props: { d: IssueDetail; search: string; scroller: (el: HTMLDivElement) => void; onScroll: () => void }) {
  const d = () => props.d;
  const state = () => issueState(d());
  return (
    <div ref={props.scroller} {...stylex.attrs(s.scroller)} data-perf="detail" data-id={d().id} onScroll={props.onScroll}>
      {/* Nothing here moves when a value changes length: the badge has a fixed width and comes
          first, and each property is one row of its own, so more labels only grow their row. */}
      <div {...stylex.attrs(s.status)}>
        <span {...stylex.attrs(s.badge, badgeBg[state()])} data-perf="badge">
          <StateIcon state={state()} plain />
          {BADGE_TEXT[state()]}
        </span>
        <span {...stylex.attrs(s.ref)} title={`${d().owner}/${d().repo}#${d().number}`}>
          {d().repo}#{d().number}
        </span>
        <span {...stylex.attrs(s.spacer)} />
        <a href={githubUrl(d())} target="_blank" rel="noreferrer external" {...stylex.attrs(s.action)} title="Open on GitHub">
          GitHub ↗
        </a>
        <a href={`/${props.search}`} noscroll {...stylex.attrs(s.action)} aria-label="Close the issue" title="Close">
          ×
        </a>
      </div>
      <h2 {...stylex.attrs(s.title)}>{d().title}</h2>
      <dl {...stylex.attrs(s.props)}>
        <dt {...stylex.attrs(s.key)}>Assignees</dt>
        <dd {...stylex.attrs(s.value)} data-perf="assignees">
          <For each={d().assignees} keyed={(u) => u.login} fallback={<span {...stylex.attrs(s.muted)}>No one</span>}>
            {(u) => (
              <span {...stylex.attrs(s.person)}>
                <Avatar login={u().login} />
                {u().login}
              </span>
            )}
          </For>
        </dd>
        <dt {...stylex.attrs(s.key)}>Labels</dt>
        <dd {...stylex.attrs(s.value)} data-perf="labels">
          <For each={d().labels} keyed={(l) => l.name} fallback={<span {...stylex.attrs(s.muted)}>None</span>}>
            {(l) => (
              <span {...stylex.attrs(s.pill)}>
                <span {...stylex.attrs(s.dot(`#${l().color}`))} />
                {l().name}
              </span>
            )}
          </For>
        </dd>
        <dt {...stylex.attrs(s.key)}>Milestone</dt>
        <dd {...stylex.attrs(s.value)} data-perf="milestone">
          <Show when={d().milestone} fallback={<span {...stylex.attrs(s.muted)}>None</span>}>
            {(m) => m().title}
          </Show>
        </dd>
      </dl>
      <Byline author={d().author} top>
        opened <Ago at={d().created_at} /> · {d().comment_total} {d().comment_total === 1 ? "comment" : "comments"}
      </Byline>
      {/* Plain text until Markdown rendering lands (#98). */}
      <div {...stylex.attrs(s.text, s.body)} data-perf="body">
        <Show when={d().body.trim()} fallback={<span {...stylex.attrs(s.muted)}>No description provided.</span>}>
          {d().body}
        </Show>
      </div>
      <h3 {...stylex.attrs(s.section)}>
        Comments <span {...stylex.attrs(s.muted, s.count)}>{d().comment_total}</span>
        <span {...stylex.attrs(s.muted, s.order)} data-perf="comment-order">{d().comment_order === "newest" ? "newest first" : "oldest first"}</span>
      </h3>
      <div data-perf="comments" data-perf-loaded={d().comments.comments.length}>
        <For each={d().comments.comments} keyed={(c) => c.id}>
          {(c) => <CommentView c={c()} />}
        </For>
      </div>
      <Show when={d().comments.next !== null}>
        <p {...stylex.attrs(s.more)} aria-live="polite">
          Loading more comments…
        </p>
      </Show>
    </div>
  );
}

function CommentView(props: { c: Comment }) {
  return (
    <article {...stylex.attrs(s.comment)} data-perf="comment" data-id={props.c.id}>
      <Byline author={props.c.author}>
        <Ago at={props.c.created_at} />
      </Byline>
      <div {...stylex.attrs(s.text)}>{props.c.body}</div>
    </article>
  );
}

/** Who wrote something (a deleted GitHub account shows as "ghost"), then `children`, muted. */
function Byline(props: { author: User | null; top?: boolean; children: Element }) {
  const login = () => props.author?.login ?? "ghost";
  return (
    <div {...stylex.attrs(s.byline, props.top && s.bylineTop)}>
      <Avatar login={login()} size={20} />
      <span>
        <b {...stylex.attrs(s.who)}>{login()}</b> <span {...stylex.attrs(s.muted)}>{props.children}</span>
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
      <LostIssue error={props.error as Gone | NoAccess} search={props.search} />
    </Show>
  );
}

/** A deleted issue, or one outside the synced repos (with a link out to it), in place of the detail. */
function LostIssue(props: { error: Gone | NoAccess; search: string }) {
  const elsewhere = () => (props.error instanceof NoAccess ? props.error.issue : undefined);
  return (
    <div {...stylex.attrs(s.notice)} role="status" data-perf="detail-lost">
      <p {...stylex.attrs(s.lostTitle)}>
        {props.error instanceof NoAccess ? "This issue is in a repo that isn't synced." : "This issue was deleted, or it moved out of your synced repos."}
      </p>
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
  value: {
    margin: 0,
    gap: 4,
    paddingBlock: 4,
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    minWidth: 0,
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
  bylineTop: {
    paddingBlock: 10,
    paddingInline: 16,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  who: {
    fontWeight: 600,
  },
  muted: {
    color: colors.muted,
    fontWeight: 400,
  },
  text: {
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
    paddingTop: 6,
  },
  body: {
    paddingInline: 16,
    paddingBottom: 16,
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
    paddingBlock: 12,
    paddingInline: 16,
    contentVisibility: "auto",
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
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
