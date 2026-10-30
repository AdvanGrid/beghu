// Live updates: one EventSource per tab on /api/stream. The server pushes `ids` (these items
// changed), `defs` (a repo's labels or milestones changed, no row did: what offers them reads
// again) and `reset` (refetch everything shown); every stream opens with a reset, so a change
// that landed before the stream was up is never missed. A reset names the build beghu runs
// (build.ts); a page the back-forward cache restores opens its stream again, and so resets too.
// Views register a refetch with `onPush` (the list in IssueList.tsx, the open detail in
// IssuePanel.tsx); `coalesced` keeps a burst of pushes down to one fetch now and one after it.
//
// Reconnecting is the tab's own: about a second after a drop, never EventSource's backoff.
// `reconnecting()` turns true once the stream has been down for 3 s, and `cantReach()` (the
// "Can't reach beghu" banner) at 15 s. `githubDown()` follows the server's `github` event, sent as
// each stream opens and whenever it changes. Writes pause while any banner shows
// (`writesPaused()`).
//
// The stream names the tab's account (account.ts). A `switched` event (the browser's active account
// changed, or the tab's lost access) makes the tab stale, and the stream ends for good; beghu sends
// one too to a stream that opens once the tab's account can't be used. A stream that fails
// otherwise asks `/api/me` whether beghu refuses the account, so a 401 or 409 in front of it reads
// as the tab going stale, not as "Can't reach beghu".
//
// A `prefs` event (the account's preferences changed, in this tab or another) reads `/api/me`
// again (api.ts, `prefsChanged`): a new keymap takes effect, and a new comment order with the
// next issue opened.
//
// A `roles` event (what the account may do changed: a role re-read from GitHub, a repo archived)
// reads `/api/me` again (`rolesChanged`), and pushes `roles`, on which the open detail refetches
// its `can` set and role line. Nothing typed is lost: drafts and editors live outside the reads.
//
// `status` events say what the status slot shows besides: `importing()` is the account's import
// while one runs, and `sync()` its sync state while it's degraded or resyncing. Every `reset`
// (each stream open sends one) clears both and is followed by the current status, `null`s
// included, so a tab that was reconnecting when an import or a resync ended hears it.
import { query } from "@solidjs/router";
import { createSignal } from "solid-js";
import { forgetRemembered, prefsChanged, rolesChanged } from "./api";
import { accountHeaders, cookieAccount, noteActive, noteSignInAgain, noteSwitched, stale, tabAccount } from "./account";
import { noteBuild } from "./build";
import type { ImportStatus } from "./bindings/ImportStatus";
import type { StreamGitHub } from "./bindings/StreamGitHub";
import type { StreamIds } from "./bindings/StreamIds";
import type { StreamReset } from "./bindings/StreamReset";
import type { StreamStatus } from "./bindings/StreamStatus";
import type { StreamSwitched } from "./bindings/StreamSwitched";
import type { SyncStatus } from "./bindings/SyncStatus";

/**
 * A push. A `reset` with `restored` is the first of a stream opened again as the back-forward
 * cache restored the page: the user came back to it (Back), rather than the world changing under
 * them. `roles`: what the account may do changed.
 */
export type Push = { kind: "ids"; ids: number[] } | { kind: "defs" } | { kind: "reset"; restored?: true } | { kind: "roles" };

const RETRY_MS = 1000;
const RECONNECTING_AFTER_MS = 3000;
const CANT_REACH_AFTER_MS = 15_000;

const listeners = new Set<(p: Push) => void>();
const [reconnecting, setReconnecting] = createSignal(false);
const [importing, setImporting] = createSignal<ImportStatus | null>(null);
const [sync, setSync] = createSignal<SyncStatus | null>(null);
const [githubDown, setGithubDown] = createSignal(false);
const [cantReach, setCantReach] = createSignal(false);

/** True while the stream has been down for 3 s or more. */
export { reconnecting };
/** The account's import while one runs: its phase and how many repos are through it. */
export { importing };
/** The account's sync while it's degraded or resyncing. */
export { sync };
/** True while the server finds GitHub unreachable. */
export { githubDown };
/** True once the stream has been down for 15 s: the "Can't reach beghu" banner. */
export { cantReach };

/** Writes pause while any banner shows: the tab is stale, beghu or GitHub can't be reached. */
export function writesPaused(): boolean {
  return stale() !== undefined || cantReach() || githubDown();
}

/** When the stream last reset (`performance.now()`): anything read before may be stale. */
let lastReset = -Infinity;
export function resetAt(): number {
  return lastReset;
}

/**
 * Calls `fn` on every push until the returned function is called: the one place a view hears
 * about changes. The list refetches what it shows on any push. The issue detail's code subscribes
 * once it has loaded, refetching the open issue on a `reset` or on `ids` that name it, and
 * forgetting what the tab read earlier of every issue `ids` names (IssuePanel.tsx).
 */
export function onPush(fn: (p: Push) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Refetches what's shown of `ids` as a push naming them would. For a write GitHub just confirmed:
 * its pending change goes once a read that began after the confirmation is on screen.
 */
export function refetchShown(ids: number[]): void {
  emit({ kind: "ids", ids });
}

function emit(p: Push): void {
  // Anything cached may be stale now: the next read of it fetches. After a reset, so may the
  // detail a hover remembered, whether or not the panel's code has loaded.
  query.clear();
  if (p.kind === "reset") lastReset = performance.now();
  // A detail a hover remembered may offer what the account can no longer do, too.
  if (p.kind === "reset" || p.kind === "roles") forgetRemembered();
  for (const fn of [...listeners]) fn(p);
}

/**
 * Opens the tab's stream and keeps it open; the returned function closes it for good. A page
 * going into the back-forward cache closes it: Chrome evicts a cached page whose request is still
 * open after about two minutes, and Back would then reload. Restored, still on the browser's
 * active account (account.ts reloads one that isn't), the page opens it again, and its opening
 * `reset` refetches what the page shows, which may be minutes old, and names the build beghu runs
 * now (build.ts).
 */
export function connectLive(): () => void {
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let down: ReturnType<typeof setTimeout> | undefined;
  let gone: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  /** In the back-forward cache: the stream is closed until the page is restored. */
  let away = false;
  /** The stream was opened as the page was restored: its first `reset` says so. */
  let restoring = false;
  const account = tabAccount();

  const open = () => {
    const es = new EventSource(account === undefined ? "/api/stream" : `/api/stream?account=${account}`);
    source = es;
    es.addEventListener("open", () => {
      clearTimeout(down);
      clearTimeout(gone);
      down = gone = undefined;
      setReconnecting(false);
      setCantReach(false);
    });
    es.addEventListener("switched", (e) => {
      const sw = JSON.parse((e as MessageEvent<string>).data) as StreamSwitched;
      if (sw.sign_in_again) noteSignInAgain();
      else noteActive(sw.account);
      // The tab's account is done here: no more pushes, and no reconnecting.
      closed = true;
      es.close();
    });
    es.addEventListener("reset", (e) => {
      noteBuild((JSON.parse((e as MessageEvent<string>).data) as Partial<StreamReset>).build);
      setImporting(null);
      setSync(null);
      emit(restoring ? { kind: "reset", restored: true } : { kind: "reset" });
      restoring = false;
    });
    es.addEventListener("status", (e) => {
      const status = JSON.parse((e as MessageEvent<string>).data) as StreamStatus;
      setImporting(status.import);
      setSync(status.sync);
    });
    es.addEventListener("github", (e) => setGithubDown((JSON.parse((e as MessageEvent<string>).data) as StreamGitHub).state === "down"));
    es.addEventListener("defs", () => emit({ kind: "defs" }));
    // A failed read leaves the preferences as they were; the next push or load reads them again.
    es.addEventListener("prefs", () => void prefsChanged().catch(() => {}));
    es.addEventListener("roles", () => {
      void rolesChanged().catch(() => {});
      emit({ kind: "roles" });
    });
    es.addEventListener("ids", (e) => {
      const { ids } = JSON.parse((e as MessageEvent<string>).data) as StreamIds;
      emit({ kind: "ids", ids });
    });
    es.addEventListener("error", () => {
      // Our own retry, not EventSource's.
      es.close();
      if (closed || away || stale() || source !== es) return;
      down ??= setTimeout(() => setReconnecting(true), RECONNECTING_AFTER_MS);
      gone ??= setTimeout(() => setCantReach(true), CANT_REACH_AFTER_MS);
      retry = setTimeout(open, RETRY_MS);
      // beghu may be up and refusing the tab's account (something in front of it answered the
      // stream for it): asked plainly, it says, and the tab goes stale, not "Can't reach".
      void refused().then((why) => {
        if (why === undefined || closed || away) return;
        why();
        closed = true;
        clearTimeout(retry);
        clearTimeout(down);
        clearTimeout(gone);
        setReconnecting(false);
        setCantReach(false);
        source?.close();
      });
    });
  };
  const hide = () => {
    if (closed) return;
    away = true;
    clearTimeout(retry);
    clearTimeout(down);
    clearTimeout(gone);
    down = gone = undefined;
    source?.close();
    source = undefined;
  };
  const show = (e: PageTransitionEvent) => {
    if (!e.persisted || !away) return;
    away = false;
    setReconnecting(false);
    setCantReach(false);
    if (closed || stale() || cookieAccount() !== account) return;
    restoring = true;
    open();
  };
  addEventListener("pagehide", hide);
  addEventListener("pageshow", show);
  open();
  return () => {
    closed = true;
    removeEventListener("pagehide", hide);
    removeEventListener("pageshow", show);
    clearTimeout(retry);
    clearTimeout(down);
    clearTimeout(gone);
    source?.close();
  };
}

/**
 * Whether beghu refuses the tab's account, asked through `/api/me` after the stream failed: how to
 * mark the tab stale (`switched` for a 409; for a 401, by the cookie, signed out, switched or
 * sign in again), or undefined if it answered otherwise or not at all.
 */
async function refused(): Promise<(() => void) | undefined> {
  let res: Response;
  try {
    res = await fetch("/api/me", { headers: accountHeaders() });
  } catch {
    return undefined;
  }
  noteBuild(res.headers.get("x-beghu-build"));
  if (res.status === 409) return noteSwitched;
  if (res.status !== 401) return undefined;
  const now = cookieAccount();
  if (now === undefined) return () => noteActive(null);
  if (now !== tabAccount()) return () => noteActive(now);
  return noteSignInAgain;
}

/**
 * Runs `fetch` for a push: at once if none is running, otherwise once more after the one that
 * is. However many pushes arrive during a fetch, they cost one trailing fetch, and none is lost.
 * The returned promise settles once a fetch that began after the call has; it never rejects.
 */
export function coalesced(fetch: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  let queued: Promise<void> | undefined;
  const start = (): Promise<void> =>
    (running = fetch()
      // A failed refetch leaves what's on screen; the next push tries again.
      .catch(() => {})
      .finally(() => {
        running = undefined;
      }));
  return () => {
    if (!running) return start();
    return (queued ??= running.then(() => {
      queued = undefined;
      // Another call may have started one already: it began after this call too.
      return running ?? start();
    }));
  };
}
