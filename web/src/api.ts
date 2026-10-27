// The API layer: every read goes through `request`, which turns a failure into one of the named
// error classes below (the spec's closed list for reads, plus `Unavailable` for a 503 with
// `retry-after`); every `ErrorKind` the server sends, and every answer from whatever is in front
// of it, maps to one of them. Every read is a router `query`, so a preload and the read that uses
// it share one fetch. The wire types come from the server through ts-rs (./bindings).
import { query, revalidate } from "@solidjs/router";
import type { ErrorBody } from "./bindings/ErrorBody";
import type { ErrorKind } from "./bindings/ErrorKind";
import type { CommentPage } from "./bindings/CommentPage";
import type { CommentOrder } from "./bindings/CommentOrder";
import type { Comment } from "./bindings/Comment";
import type { IssueDetail } from "./bindings/IssueDetail";
import type { IssuePage } from "./bindings/IssuePage";
import type { IssueRef } from "./bindings/IssueRef";
import type { Me } from "./bindings/Me";

export type { Comment, CommentOrder, CommentPage, IssueDetail, IssuePage, IssueRef, Me };
export type { IssueRow } from "./bindings/IssueRow";

/** beghu can't be reached: offline, or the server is down. */
export class Unreachable extends Error {}
/** No session, or it ended: the user must sign in. */
export class SessionEnded extends Error {}
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

/** The error body the server sent, if it sent one. */
async function bodyOf(res: Response): Promise<Partial<ErrorBody>> {
  try {
    return (await res.json()) as ErrorBody;
  } catch {
    return {};
  }
}

async function request<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Unreachable(`can't reach beghu: ${String(e)}`);
  }
  if (res.ok) return (await res.json()) as T;
  const why = `${res.status} from ${url}`;
  const body = await bodyOf(res);
  const kind: ErrorKind | undefined = body.error;
  switch (kind) {
    case "signed_out":
      throw new SessionEnded(why);
    case "unavailable":
      throw new Unavailable(why, Math.max(1, Number(res.headers.get("retry-after")) || 1));
    case "not_found":
    case "gone":
      throw new Gone(why);
    case "no_access":
      throw new NoAccess(why, body.issue);
    case "bad_request":
    case "internal":
      throw new ServerError(why);
    case undefined:
      break;
    default:
      // A new kind on the server fails the typecheck here until it has its class.
      kind satisfies never;
  }
  // No error body: a proxy or something else in front of beghu.
  switch (res.status) {
    case 401:
      throw new SessionEnded(why);
    case 403:
      throw new NoAccess(why);
    case 404:
    case 410:
      throw new Gone(why);
    default:
      throw new ServerError(why);
  }
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

export const getMe = query(() => request<Me>("/api/me"), "me");

export const getIssues = query((search: string, after?: string) => request<IssuePage>(issuesUrl(search, after)), "issues");

/**
 * The issue an `/issues/:id` path names: its digits as a number, leading zeros dropped as the
 * shell's preload drops them (crates/server/src/shell.rs). Anything else is NaN, which names no
 * issue: the server answers Gone.
 */
export function issueId(raw: string | undefined): number {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : NaN;
}

/** When each detail's fetch began, for telling an older read from a newer one. */
const startedAt = new WeakMap<IssueDetail, number>();

/**
 * An issue's detail: its properties, body and first page of comments. A hover or tap on its row
 * preloads it, so the click that opens it finds it ready. The URL must match the shell's preload
 * for `/issues/:id` (crates/server/src/shell.rs).
 */
export const getIssue = query(async (id: number) => {
  const at = performance.now();
  const detail = await request<IssueDetail>(`/api/issues/${id}`);
  startedAt.set(detail, at);
  return detail;
}, "issue");

/**
 * The detail the last hover or tap preloaded, kept past the router's 5 s preload window so a click
 * after a long hover can show it at once. The tab keeps no data store: this is one issue, the
 * next to open, and it lasts until it's opened (once), another issue opens, the list's view
 * changes, a push names it or the tab resets.
 */
let remembered: { id: number; at: number; detail: IssueDetail } | undefined;
/** When the remembered detail was last forgotten: a read that began before is too old to remember. */
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

/** For a hover or tap on an issue's row: preloads its detail and remembers it. */
export function preloadIssue(id: number): void {
  getIssue(id).then(
    (detail) => {
      const at = startedAt.get(detail) ?? -Infinity;
      const fresh = at > forgottenAt && at > (pushedAt.get(id) ?? -Infinity);
      // Only a newer read replaces what's remembered: hovers can resolve out of order.
      if (fresh && (remembered === undefined || at > remembered.at)) remembered = { id, at, detail };
    },
    // A failed preload stays silent: the click reads again.
    () => {},
  );
}

/**
 * For the issue being opened: the remembered detail, if it's this issue's and the router no
 * longer serves it as a preload (a hover that rested longer than that before its click). It shows
 * at once while a refetch replaces it. Whatever was remembered is used up either way.
 */
export function takeRemembered(id: number): IssueDetail | undefined {
  const r = remembered;
  forgetRemembered();
  const age = r && r.id === id ? performance.now() - r.at : Infinity;
  return age >= PRELOAD_FRESH && age < REMEMBER_FOR ? r!.detail : undefined;
}

/** Forgets the remembered detail. Reads already on their way are too old to remember once they land. */
export function forgetRemembered(): void {
  remembered = undefined;
  forgottenAt = performance.now();
}

/**
 * For a live push naming `ids`: nothing read of them before now shows again. The remembered
 * detail goes if it's among them, reads of them on their way won't be remembered, and the
 * router's cached reads of them are dropped, so the next open fetches afresh.
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
  if (remembered && ids.includes(remembered.id)) remembered = undefined;
  revalidate(ids.map((id) => getIssue.keyFor(id)));
}

// A page restored from the bfcache resets (spec #86): what it remembered may be long stale.
addEventListener("pageshow", (e) => {
  if (e.persisted) forgetRemembered();
});

/** A comment's place in its thread, as cursors name it: `<created_at>.<id>`. */
export function cursorOf(c: Comment): string {
  return `${c.created_at}.${c.id}`;
}

/** The detail again, with every comment from the top of the thread through `through`. */
export function refetchIssue(id: number, through?: Comment): Promise<IssueDetail> {
  return request<IssueDetail>(through === undefined ? `/api/issues/${id}` : `/api/issues/${id}?through=${cursorOf(through)}`);
}

/** The page of an issue's comments after the cursor `after`, in `order`. */
export function getComments(id: number, order: CommentOrder, after: string): Promise<CommentPage> {
  return request<CommentPage>(`/api/issues/${id}/comments?order=${order}&after=${after}`);
}

let signingIn = false;

/** Leaves for sign-in, once, coming back to this URL afterwards. */
export function signIn(): void {
  if (signingIn) return;
  signingIn = true;
  location.replace(signInUrl());
}

export function signInUrl(): string {
  return `/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}
