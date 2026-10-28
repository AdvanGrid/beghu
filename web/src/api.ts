// The API layer: every read goes through `request`, and every write through `sendOp`; both turn
// a failure into one of the named error classes below (the spec's closed list for reads, plus
// `Unavailable` for a 503 with `retry-after`, and one per way a write fails), through one
// mapping: every `ErrorKind` the server sends, and every answer from whatever is in front of it,
// maps to one of them. Every read is a router `query`, so a preload and the read that uses it
// share one fetch. The wire types come from the server through ts-rs (./bindings).
import { query, revalidate } from "@solidjs/router";
import { createSignal } from "solid-js";
import { noteBuild, whileWriting } from "./build";
import { accountHeaders, noteActive, noteAnswered, noteSignedOut, noteSwitched, stale, tabAccount } from "./account";
import type { ErrorBody } from "./bindings/ErrorBody";
import type { ErrorKind } from "./bindings/ErrorKind";
import type { Facet } from "./bindings/Facet";
import type { FacetCount } from "./bindings/FacetCount";
import type { Facets } from "./bindings/Facets";
import type { CommentPage } from "./bindings/CommentPage";
import type { CommentOrder } from "./bindings/CommentOrder";
import type { Comment } from "./bindings/Comment";
import type { IssueDetail } from "./bindings/IssueDetail";
import type { IssuePage } from "./bindings/IssuePage";
import type { IssueRef } from "./bindings/IssueRef";
import type { IssueSource } from "./bindings/IssueSource";
import type { Me } from "./bindings/Me";
import type { Op } from "./bindings/Op";
import type { OpReply } from "./bindings/OpReply";
import type { OpRequest } from "./bindings/OpRequest";
import type { PrefChange } from "./bindings/PrefChange";
import type { ResyncReply } from "./bindings/ResyncReply";
import { LOST_MESSAGE } from "./bindings/lostMessage";
import { setKeymap } from "./keys";

export type { Comment, CommentOrder, CommentPage, Facet, FacetCount, Facets, IssueDetail, IssuePage, IssueRef, Me, Op, OpReply, PrefChange };
export type { IssueRow } from "./bindings/IssueRow";

/** Every write but a new issue: each names the issue it changes. */
export type IssueOp = Exclude<Op, { kind: "create" }>;
/** A new issue: it names its repo, and its reply names the issue GitHub made. */
export type CreateOp = Extract<Op, { kind: "create" }>;

/** The longest title GitHub takes, in characters, as the server checks it (ops.rs). */
export const MAX_TITLE = 256;
/** The longest body or comment GitHub takes, in characters, as the server checks it (ops.rs). */
export const MAX_BODY = 65_536;

/** A `refs` map: what the mirror holds of the items some posts refer to. */
export type Refs = IssueDetail["refs"];

/** `refs` maps of posts shown together, as one; where two read the same item, the later wins. */
export function mergeRefs(...maps: Refs[]): Refs {
  return Object.assign({}, ...maps) as Refs;
}

/** beghu can't be reached: offline, or the server is down. */
export class Unreachable extends Error {}
/** No session, or it ended: the user must sign in. */
export class SessionEnded extends Error {}
/**
 * The tab is on another account than the browser's active one: the user switched or signed out
 * in another tab. Nothing was done; the tab shows the switched banner.
 */
export class Switched extends Error {}
/** The account can't see this. For an issue outside the synced repos, `issue` says where it is. */
export class NoAccess extends Error {
  constructor(
    message: string,
    readonly issue?: IssueRef,
  ) {
    super(message);
  }
}
/** It's not there (any more). */
export class Gone extends Error {}
/** GitHub deleted it. */
export class Deleted extends Gone {}
/**
 * GitHub transferred it: it's `issue` now, which opens in-app as `id` when it's in the synced
 * repos (no `id` when it moved out of them).
 */
export class Moved extends Gone {
  constructor(
    message: string,
    readonly issue: IssueRef,
    readonly id?: number,
  ) {
    super(message);
  }
}
/** beghu is busy (at its connection cap, or a mirror is still opening): try again later. */
export class Unavailable extends Error {
  constructor(
    message: string,
    /** Seconds to wait before trying again, from `retry-after`. */
    readonly retryAfter: number,
  ) {
    super(message);
  }
}
/**
 * Something failed that trying again won't fix: beghu failed on its side, refused the request as
 * malformed (a bug in the client), or a proxy in front of it failed.
 */
export class ServerError extends Error {}

// Writes only: how a write GitHub didn't take failed. The message is the server's, for the user.

/**
 * GitHub refused the write, or accepted it without applying it; or beghu refused it as it stands
 * (a comment too long), which sending it again can't fix (`retry` false).
 */
export class Refused extends Error {
  constructor(
    message: string,
    readonly retry = true,
  ) {
    super(message);
  }
}
/** GitHub's rate limit held the write back for longer than the server waits quietly. */
export class RateLimited extends Error {
  constructor(
    message: string,
    /** Seconds until GitHub takes writes again. */
    readonly retryAfter: number,
  ) {
    super(message);
  }
}
/** GitHub answered the write with a conflict. */
export class Conflict extends Error {}
/**
 * A title or body edit found the field changed on GitHub since its editor opened, and wasn't
 * made: `current` is GitHub's text now, `digest` its digest (as the detail's `body_digest`).
 */
export class Changed extends Error {
  constructor(
    message: string,
    readonly current: string,
    readonly digest: string,
  ) {
    super(message);
  }
}
/** Asked again too soon (a Resync, once an hour): the message says when it's available. */
export class TooSoon extends Error {
  constructor(
    message: string,
    /** Seconds until it can be asked for again. */
    readonly retryAfter: number,
  ) {
    super(message);
  }
}
/** GitHub couldn't be reached for the write: it's down, or kept failing. */
export class GitHubDown extends Error {}
/**
 * The write may or may not have reached GitHub: beghu has no record of it (it restarted, or
 * forgot it), or didn't answer its resends for 9 minutes, so it was never sent again.
 */
export class Lost extends Error {
  constructor(
    message: string,
    /** For a comment, if beghu said: its Markdown's digest (see `ErrorBody`). */
    readonly digest?: string,
  ) {
    super(message);
  }
}
/**
 * GitHub failed on a comment, answered it with a 2xx beghu couldn't read, or didn't answer: it may
 * have been posted all the same.
 */
export class MaybePosted extends Error {
  constructor(
    message: string,
    /** Only a comment with a greater id can be it (see `ErrorBody`), if beghu said. */
    readonly after?: number,
    /** Its Markdown's digest (see `ErrorBody`), if beghu said. */
    readonly digest?: string,
  ) {
    super(message);
  }
}

/** The error body the server sent, if it sent one. */
async function bodyOf(res: Response): Promise<Partial<ErrorBody>> {
  try {
    return (await res.json()) as ErrorBody;
  } catch {
    return {};
  }
}

/** The named error for a failed answer from beghu: by its body's kind, else by its status. */
function failure(res: Response, body: Partial<ErrorBody>, why: string): Error {
  const kind: ErrorKind | undefined = body.error;
  const said = body.message ?? why;
  const retryAfter = Math.max(1, Number(res.headers.get("retry-after")) || 1);
  switch (kind) {
    case "signed_out":
      noteSignedOut();
      return new SessionEnded(why);
    case "switched":
      noteSwitched();
      return new Switched(said);
    case "unavailable":
      return new Unavailable(why, retryAfter);
    case "not_found":
    case "gone":
      return new Gone(said);
    case "deleted":
      return new Deleted(said);
    case "moved":
      return body.issue ? new Moved(said, body.issue, body.moved_to ?? undefined) : new Gone(said);
    case "forbidden":
      return new NoAccess(why);
    case "no_access":
      return new NoAccess(why, body.issue);
    case "bad_request":
    case "internal":
      return new ServerError(why);
    case "refused":
      return new Refused(said);
    case "rate_limited":
      return new RateLimited(said, retryAfter);
    case "conflict":
      return new Conflict(said);
    case "changed":
      return new Changed(said, body.current ?? "", body.digest ?? "");
    case "too_soon":
      return new TooSoon(said, retryAfter);
    case "github_down":
      return new GitHubDown(said);
    case "lost":
      return new Lost(said, body.digest);
    case "maybe_posted":
      return new MaybePosted(said, body.after, body.digest);
    case undefined:
      break;
    default:
      // A new kind on the server fails the typecheck here until it has its class.
      kind satisfies never;
  }
  // No error body: a proxy or something else in front of beghu.
  switch (res.status) {
    case 401:
      noteSignedOut();
      return new SessionEnded(why);
    case 403:
      return new NoAccess(why);
    case 404:
    case 410:
      return new Gone(why);
    default:
      return new ServerError(why);
  }
}

/**
 * The reads the shell preloads (`<link rel=preload as=fetch>`), until each has been fetched once.
 * The browser hands a preload over only to a fetch with the same headers, so those go without the
 * tab's account: they're for whoever was active as the page loaded. Each answer names the account
 * it was made as (`X-Beghu-Account`), and one made for another account than the tab's is
 * dropped and asked again as the tab's, which beghu answers `switched`.
 */
const preloaded = new Set(
  [...document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="fetch"]')].map((l) => {
    const u = new URL(l.href);
    return u.pathname + u.search;
  }),
);

/** How long a read waits out beghu being busy (503 with `retry-after`) before it fails. */
const READY_FOR_MS = 60_000;

/** How many reads are waiting out a 503 now. */
const [waiting, setWaiting] = createSignal(0);
/**
 * True while a read waits for beghu to be ready: at its connection cap, a mirror still opening,
 * or the account's data being deleted or rebuilt (signed in again just after it lost access). The
 * status slot says "Getting this account ready…".
 */
export function gettingReady(): boolean {
  return waiting() > 0;
}

/**
 * A call to beghu's API: its JSON, or the named error for how it failed. A read beghu answers
 * busy (`Unavailable`) is asked again after the `retry-after` it gave, for up to a minute: busy
 * passes, and the view loads rather than fail.
 */
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  if ((init?.method ?? "GET") !== "GET") return requestOnce(url, init);
  const since = performance.now();
  let counted = false;
  try {
    for (;;) {
      try {
        return await requestOnce<T>(url, init);
      } catch (e) {
        if (!(e instanceof Unavailable) || performance.now() - since + e.retryAfter * 1000 > READY_FOR_MS) throw e;
        if (!counted) {
          counted = true;
          setWaiting((n) => n + 1);
        }
        await new Promise((r) => setTimeout(r, e.retryAfter * 1000));
      }
    }
  } finally {
    if (counted) setWaiting((n) => n - 1);
  }
}

async function requestOnce<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  // Only a GET can be a preload's: every write names the tab's account.
  const preload = (init?.method ?? "GET") === "GET" && preloaded.delete(url);
  const headers = new Headers(init?.headers);
  if (!preload) for (const [k, v] of Object.entries(accountHeaders())) if (!headers.has(k)) headers.set(k, v);
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    throw new Unreachable(`can't reach beghu: ${String(e)}`);
  }
  noteBuild(res.headers.get("x-beghu-build"));
  const mine = tabAccount();
  if (preload && res.ok && mine !== undefined && res.headers.get("x-beghu-account") !== String(mine)) return requestOnce(url, init);
  if (res.ok) {
    noteAnswered();
    // A write with nothing to say (204).
    if (res.status === 204) return null as T;
    return (await res.json()) as T;
  }
  throw failure(res, await bodyOf(res), `${res.status} from ${url}`);
}

/**
 * Sends one write once; GitHub's confirmation, or the named error for how it failed. `resend`:
 * an earlier send of this `op_id` may have reached beghu (see `OpRequest`).
 */
async function postOp(op_id: string, op: Op, resend: boolean): Promise<OpReply> {
  let res: Response;
  try {
    res = await fetch("/api/ops", {
      method: "POST",
      headers: { "content-type": "application/json", ...accountHeaders() },
      body: JSON.stringify({ op_id, op, ...(resend && { resend }) } satisfies OpRequest),
    });
    noteBuild(res.headers.get("x-beghu-build"));
    // A 2xx is GitHub's confirmation; one cut short on the way back is a lost answer, and the
    // resend gets it again.
    if (res.ok) return (await res.json()) as OpReply;
  } catch (e) {
    throw new Unreachable(`can't reach beghu: ${String(e)}`);
  }
  const body = await bodyOf(res);
  // No error body, and not the edge's sign-in answer: something in front of beghu failed on the
  // way (a 502, a 408, a 499…), and the write may or may not have arrived.
  if (body.error === undefined && res.status !== 401 && res.status !== 403) throw new Unreachable(`${res.status} from /api/ops`);
  // beghu refused the write as it stands: a message for the user, and no use sending it again.
  if (body.error === "bad_request") throw new Refused(body.message ?? "beghu refused this change", false);
  throw failure(res, body, `${res.status} from /api/ops`);
}

/** The longest wait between resends while beghu can't be reached. */
const RESEND_MAX_MS = 5_000;
/**
 * How long a write is sent again while beghu can't be reached or is busy: under the 10 minutes
 * the server remembers an op for, so a resend it has no record of always means it lost the write.
 */
const RESEND_FOR_MS = 9 * 60_000;

/**
 * Sends one write until it has an answer: GitHub's confirmation, or the named error for how it
 * failed. While beghu can't be reached, or is busy (503), it sends the same `op_id` again, for up
 * to 9 minutes. A send that may have arrived (the tab was online, or something in front of beghu
 * answered) marks the ones after it as resends, which the server joins to the write it has, or
 * answers `Lost`; one sent while the browser was offline didn't arrive. After 9 minutes the write
 * fails: `Lost` (in the server's words) if a send may have arrived, else `Unreachable`, saying
 * whether beghu was busy or didn't answer. A resend after a send that may have arrived, turned
 * away as `Switched` or `SessionEnded`, is `Lost` too: the first may have been made.
 */
export function sendOp(op_id: string, op: Op): Promise<OpReply> {
  // A full document load for a new build waits for it (build.ts).
  return whileWriting(() => sendUntilAnswered(op_id, op));
}

async function sendUntilAnswered(op_id: string, op: Op): Promise<OpReply> {
  const since = performance.now();
  let reached = false;
  let busy = false;
  for (let wait = 1000; ; wait = Math.min(wait * 2, RESEND_MAX_MS)) {
    if (performance.now() - since >= RESEND_FOR_MS) {
      if (reached) throw new Lost(LOST_MESSAGE[op.kind]);
      throw new Unreachable(busy ? "beghu was busy, so this change wasn't sent" : "beghu didn't answer, so this change wasn't sent");
    }
    const offline = navigator.onLine === false;
    try {
      return await postOp(op_id, op, reached);
    } catch (e) {
      if (e instanceof Unreachable) {
        // Unless the browser was offline, the send may have arrived, its answer lost on the way back.
        reached ||= !offline;
        busy = false;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (e instanceof Unavailable) {
        // beghu answered without starting it.
        busy = true;
        await new Promise((r) => setTimeout(r, e.retryAfter * 1000));
        continue;
      }
      // A send that may have reached beghu, then a resend turned away because the tab's
      // account is no longer the browser's (a switch, a sign-out, Disconnect): the write may
      // have been made all the same, its answer lost. Nothing says it wasn't.
      if (reached && (e instanceof Switched || e instanceof SessionEnded)) throw new Lost(LOST_MESSAGE[op.kind]);
      throw e;
    }
  }
}

/**
 * Asks for a Resync: a full sweep of the account's synced repos. Its answer is the sync state as
 * the sweep starts; a second within the hour is refused with `TooSoon`.
 */
export function resync(): Promise<ResyncReply> {
  return request<ResyncReply>("/api/resync", { method: "POST" });
}

/**
 * The list page URL for a view (the page's query string) and, for later pages, a cursor. The
 * first page's URL must match the shell's preload exactly (crates/server/src/shell.rs).
 */
export function issuesUrl(search: string, after?: string): string {
  if (!after) return `/api/issues${search.length > 1 ? search : ""}`;
  const p = new URLSearchParams(search);
  p.set("after", after);
  return `/api/issues?${p}`;
}

/**
 * When the preferences in effect here were read or set: a read of `/api/me` begun before then
 * lands with older ones, and leaves them be.
 */
let prefsAt = -Infinity;

/** This tab changed its preferences itself, ahead of the store: reads begun before now are older. */
export function prefsSetHere(): void {
  prefsAt = performance.now();
}

/**
 * The active account and the browser's others, and the account's preferences. One that isn't the
 * tab's makes the tab stale; the tab's own keymap takes effect as it lands (preloaded with the
 * shell, so before the first key), and again whenever a `prefs` push reads it afresh: unless a
 * read begun later, or a change made here since it began, already put newer ones in effect.
 */
export const getMe = query(async () => {
  const at = performance.now();
  const me = await request<Me>("/api/me");
  if (tabAccount() !== undefined && me.account.id !== tabAccount()) noteActive(me.account.id);
  else if (at >= prefsAt) {
    prefsAt = at;
    setKeymap(me.keymap);
    setCommentOrder(me.comment_order);
  }
  return me;
}, "me");

const [commentOrder, setCommentOrder] = createSignal<CommentOrder>();
/**
 * The account's comment order, as `/api/me` last said (or as this tab just set it); undefined
 * until it has. An open issue keeps the order it opened in. Reactive.
 */
export { commentOrder };

/**
 * A `prefs` push: the account's preferences changed, here or in another tab. `/api/me` is read
 * again, and its keymap takes effect (keys.ts holds it back while a sequence is under way). If
 * the comment order changed, the details read in the old one are dropped, so the next issue
 * opened comes in the new one; the open issue keeps its order.
 */
export async function prefsChanged(): Promise<void> {
  const before = commentOrder();
  void revalidate(getMe.key);
  await getMe();
  // As in effect now: an older read that landed late changed nothing.
  if (before !== undefined && commentOrder() !== before) {
    forgetRemembered();
    void revalidate(getIssue.key);
  }
}

/**
 * Sets the account's comment order: stored, then pushed to its other tabs. Until it's stored, this
 * tab takes it as set; if it isn't, it goes back. Fails with the named error.
 */
export async function setAccountOrder(order: CommentOrder): Promise<void> {
  const was = commentOrder();
  prefsSetHere();
  setCommentOrder(order);
  try {
    await setPref({ field: "comment_order", value: order });
  } catch (e) {
    if (commentOrder() === order) setCommentOrder(was);
    throw e;
  }
  // The details this tab read before come in the old order.
  forgetRemembered();
  void revalidate(getIssue.key);
}

/**
 * Sets one account preference (comment order, or one action's key bindings). Last write wins;
 * every tab of the account hears `prefs` and reads `/api/me` again. Fails with the named error.
 */
export async function setPref(change: PrefChange): Promise<void> {
  await request<null>("/api/prefs", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  });
}

/** When each read's fetch began (`performance.now()`), for telling an older read from a newer one. */
const startedAt = new WeakMap<object, number>();

/** When `read`'s fetch began; -Infinity if unknown. */
export function readAt(read: object): number {
  return startedAt.get(read) ?? -Infinity;
}

/** Marks `read` as fetched from `at`: a page or detail built from older reads takes the oldest. */
export function stamp<T extends object>(read: T, at: number): T {
  startedAt.set(read, at);
  return read;
}

/** A read, stamped with when its fetch began. */
async function timed<T extends object>(url: string): Promise<T> {
  const at = performance.now();
  return stamp(await request<T>(url), at);
}

export const getIssues = query((search: string, after?: string) => timed<IssuePage>(issuesUrl(search, after)), "issues");

/** The filter bar's values per facet. The URL matches the shell's preload. */
export const getFacets = query(() => request<Facets>("/api/facets"), "facets");

/** How many rows of the view `q` carry each of `facet`'s values. */
export const getFacetCounts = query(
  (facet: Facet, q: string) =>
    request<FacetCount[]>(`/api/facets/${facet}/counts?${new URLSearchParams({ q })}`),
  "facetCounts",
);

/**
 * Hands `read`'s value to `ok`. A lapsed session leaves for sign-in (unless the tab went stale);
 * any other failure calls
 * `failed`, for a notice whose Retry calls `forgetFailure` before reading again.
 */
export function readThen<T>(read: Promise<T>, ok: (value: T) => void, failed: () => void): void {
  read.then(ok, (e: unknown) => {
    // A tab that holds a view went stale instead (its banner offers sign-in): a notice then.
    if (e instanceof SessionEnded && !stale()) signIn();
    else failed();
  });
}

/** A failed read stays in the query cache for a few seconds: drop `q`'s, so a retry asks again. */
export function forgetFailure(q: { key: string }): void {
  void revalidate(q.key);
}

/**
 * A live refetch of a view, bypassing the query cache: from the top through `through` (the cursor
 * of the last row the tab shows, the page's `last`) in one request, or the first page when it
 * shows none yet.
 */
export function refetchIssues(search: string, through?: string): Promise<IssuePage> {
  if (!through) return timed<IssuePage>(issuesUrl(search));
  const p = new URLSearchParams(search);
  p.set("through", through);
  return timed<IssuePage>(`/api/issues?${p}`);
}

/**
 * The issue an `/issues/:id` path names: its digits as a number, leading zeros dropped as the
 * shell's preload drops them (crates/server/src/shell.rs). Anything else is NaN, which names no
 * issue: the server answers Gone.
 */
export function issueId(raw: string | undefined): number {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
}

/**
 * An issue's detail: its properties, body and first page of comments. A hover or tap on its row
 * preloads it, so the click that opens it finds it ready. The URL must match the shell's preload
 * for `/issues/:id` (crates/server/src/shell.rs).
 */
export const getIssue = query((id: number) => timed<IssueDetail>(`/api/issues/${id}`), "issue");

/**
 * The details the last hovers, taps and keyboard neighbours preloaded, kept past the router's 5 s
 * preload window so a click after a long hover, or a `j` after a long read, can show one at once.
 * The tab keeps no data store: these are the next issues to open (the newest REMEMBERED reads),
 * and they last until one is opened (once), another issue opens, the list's view changes, a push
 * names one or the tab resets.
 */
let remembered: { id: number; at: number; detail: IssueDetail }[] = [];
/** How many details are remembered: the selection's two neighbours. */
const REMEMBERED = 2;
/** When the remembered details were last forgotten: a read that began before is too old to remember. */
let forgottenAt = -Infinity;
/**
 * When a push last named each issue: a read of it that began before is too old to remember.
 * Oldest first; entries older than REMEMBER_FOR are dropped, as nothing that old is shown.
 */
const pushedAt = new Map<number, number>();
/** How long the router serves a preloaded read (its PRELOAD_TIMEOUT is 5 s), with a margin. */
const PRELOAD_FRESH = 4_000;
/** The longest a remembered detail may show before its refetch replaces it. */
const REMEMBER_FOR = 3 * 60_000;

/** For a hover or tap on an issue's row, or a keyboard neighbour: preloads its detail and remembers it. */
export function preloadIssue(id: number): void {
  getIssue(id).then(
    (detail) => {
      const at = readAt(detail);
      const fresh = at > forgottenAt && at > (pushedAt.get(id) ?? -Infinity);
      // Only newer reads are kept: hovers can resolve out of order.
      if (!fresh || remembered.some((r) => r.id === id && r.at >= at)) return;
      remembered = [...remembered.filter((r) => r.id !== id), { id, at, detail }].sort((a, b) => a.at - b.at).slice(-REMEMBERED);
    },
    // A failed preload stays silent: the click reads again.
    () => {},
  );
}

/**
 * For the issue being opened: its remembered detail, if the router no longer serves it as a
 * preload (a hover that rested longer than that before its click). It shows at once while a
 * refetch replaces it. Whatever was remembered is used up either way, but reads on their way, or
 * cached by the router, stay rememberable: the new selection's neighbours preload from those
 * (the issue just left among them, read before this open).
 */
export function takeRemembered(id: number): IssueDetail | undefined {
  const r = remembered.find((r) => r.id === id);
  remembered = [];
  const age = r ? performance.now() - r.at : Infinity;
  return age >= PRELOAD_FRESH && age < REMEMBER_FOR ? r!.detail : undefined;
}

/** Forgets the remembered details. Reads already on their way are too old to remember once they land. */
export function forgetRemembered(): void {
  remembered = [];
  forgottenAt = performance.now();
}

/**
 * For a live push naming `ids`: nothing read of them before now shows again. Their remembered
 * details go, reads of them on their way won't be remembered, and the router's cached reads of
 * them are dropped, so the next open fetches afresh.
 */
export function forgetPushed(ids: readonly number[]): void {
  if (ids.length === 0) return;
  const now = performance.now();
  for (const [id, at] of pushedAt) {
    if (now - at < REMEMBER_FOR) break;
    pushedAt.delete(id);
  }
  for (const id of ids) {
    pushedAt.delete(id);
    pushedAt.set(id, now);
  }
  remembered = remembered.filter((r) => !ids.includes(r.id));
  revalidate(ids.map((id) => getIssue.keyFor(id)));
}

/**
 * Whether `detail`'s read began before `since` (the stream's last reset) or before a push last
 * named its issue: it may predate a change no refetch has covered yet.
 */
export function readBefore(detail: IssueDetail, since: number): boolean {
  const at = startedAt.get(detail);
  return at !== undefined && at < Math.max(since, pushedAt.get(detail.id) ?? -Infinity);
}

/** A comment's place in its thread, as cursors name it: `<created_at>.<id>`. */
export function cursorOf(c: Comment): string {
  return `${c.created_at}.${c.id}`;
}

/**
 * The detail again, in the thread's `order` (the one the tab shows: another tab may have changed
 * the account's), with every comment from the top of the thread through `through`.
 */
export function refetchIssue(id: number, order: CommentOrder, through?: Comment): Promise<IssueDetail> {
  const p = new URLSearchParams(through === undefined ? {} : { through: cursorOf(through) });
  p.set("order", order);
  return timed<IssueDetail>(`/api/issues/${id}?${p}`);
}

/** The page of an issue's comments after the cursor `after` (the first page without), in `order`. */
export function getComments(id: number, order: CommentOrder, after?: string): Promise<CommentPage> {
  return request<CommentPage>(`/api/issues/${id}/comments?order=${order}${after === undefined ? "" : `&after=${after}`}`);
}

/** An issue's body as Markdown, for its editor, with its digest (as the detail's `body_digest`). */
export function getSource(id: number): Promise<IssueSource> {
  return request<IssueSource>(`/api/issues/${id}/source`);
}

let signingIn = false;

/**
 * Leaves for sign-in, once, coming back to this URL afterwards. Not from a stale tab (a 401 makes
 * one that holds a view stale, account.ts): its banner offers sign-in, and leaving now would lose
 * its drafts.
 */
export function signIn(): void {
  if (signingIn || stale()) return;
  signingIn = true;
  location.replace(signInUrl());
}

export function signInUrl(): string {
  return `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}
