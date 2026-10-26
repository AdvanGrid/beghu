// The API layer: every read goes through `request`, which turns a failure into one of the named
// error classes below (the spec's closed list for reads, plus `Unavailable` for a 503 with
// `retry-after`); every `ErrorKind` the server sends, and every answer from whatever is in front
// of it, maps to one of them. Every read is a router `query`, so a preload and the read that uses
// it share one fetch. The wire types come from the server through ts-rs (./bindings).
import { query } from "@solidjs/router";
import type { ErrorBody } from "./bindings/ErrorBody";
import type { ErrorKind } from "./bindings/ErrorKind";
import type { IssuePage } from "./bindings/IssuePage";
import type { Me } from "./bindings/Me";

export type { IssuePage, Me };
export type { IssueRow } from "./bindings/IssueRow";

/** beghu can't be reached: offline, or the server is down. */
export class Unreachable extends Error {}
/** No session, or it ended: the user must sign in. */
export class SessionEnded extends Error {}
/** The account can't see this. */
export class NoAccess extends Error {}
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

/** The failure kind the server named in its error body, if it sent one. */
async function kindOf(res: Response): Promise<ErrorKind | undefined> {
  try {
    return ((await res.json()) as ErrorBody).error;
  } catch {
    return undefined;
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
  const kind = await kindOf(res);
  switch (kind) {
    case "signed_out":
      throw new SessionEnded(why);
    case "unavailable":
      throw new Unavailable(why, Math.max(1, Number(res.headers.get("retry-after")) || 1));
    case "not_found":
      throw new Gone(why);
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
