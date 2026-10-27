// Live updates: one EventSource per tab on /api/stream. The server pushes `ids` (these items
// changed) and `reset` (refetch everything shown); every stream opens with a reset, so a change
// that landed before the stream was up is never missed. Views register a refetch with `onPush`
// (the list in IssueList.tsx, the open detail in IssuePanel.tsx); `coalesced` keeps a burst of
// pushes down to one fetch now and one after it.
//
// Reconnecting is the tab's own: about a second after a drop, never EventSource's backoff.
// `reconnecting()` turns true once the stream has been down for 3 s. `githubDown()` follows the
// server's `github` event, sent as each stream opens and whenever it changes: writes pause while
// it's true.
//
// `status` events say what the status slot shows besides: `importing()` is the account's import
// while one runs, and `sync()` its sync state while it's degraded or resyncing. Every `reset`
// (each stream open sends one) clears both and is followed by the current status, `null`s
// included, so a tab that was reconnecting when an import or a resync ended hears it.
import { query } from "@solidjs/router";
import { createSignal } from "solid-js";
import { forgetRemembered } from "./api";
import type { ImportStatus } from "./bindings/ImportStatus";
import type { StreamGitHub } from "./bindings/StreamGitHub";
import type { StreamIds } from "./bindings/StreamIds";
import type { StreamStatus } from "./bindings/StreamStatus";
import type { SyncStatus } from "./bindings/SyncStatus";

export type Push = { kind: "ids"; ids: number[] } | { kind: "reset" };

const RETRY_MS = 1000;
const RECONNECTING_AFTER_MS = 3000;

const listeners = new Set<(p: Push) => void>();
const [reconnecting, setReconnecting] = createSignal(false);
const [importing, setImporting] = createSignal<ImportStatus | null>(null);
const [sync, setSync] = createSignal<SyncStatus | null>(null);
const [githubDown, setGithubDown] = createSignal(false);

/** True while the stream has been down for 3 s or more. */
export { reconnecting };
/** The account's import while one runs: its phase and how many repos are through it. */
export { importing };
/** The account's sync while it's degraded or resyncing. */
export { sync };
/** True while the server finds GitHub unreachable. */
export { githubDown };

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
  if (p.kind === "reset") {
    lastReset = performance.now();
    forgetRemembered();
  }
  for (const fn of [...listeners]) fn(p);
}

/** Opens the tab's stream and keeps it open; the returned function closes it for good. */
export function connectLive(): () => void {
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let down: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const open = () => {
    const es = new EventSource("/api/stream");
    source = es;
    es.addEventListener("open", () => {
      clearTimeout(down);
      down = undefined;
      setReconnecting(false);
    });
    es.addEventListener("reset", () => {
      setImporting(null);
      setSync(null);
      emit({ kind: "reset" });
    });
    es.addEventListener("status", (e) => {
      const status = JSON.parse((e as MessageEvent<string>).data) as StreamStatus;
      setImporting(status.import);
      setSync(status.sync);
    });
    es.addEventListener("github", (e) => setGithubDown((JSON.parse((e as MessageEvent<string>).data) as StreamGitHub).state === "down"));
    es.addEventListener("ids", (e) => {
      const { ids } = JSON.parse((e as MessageEvent<string>).data) as StreamIds;
      emit({ kind: "ids", ids });
    });
    es.addEventListener("error", () => {
      // Our own retry, not EventSource's.
      es.close();
      if (closed || source !== es) return;
      down ??= setTimeout(() => setReconnecting(true), RECONNECTING_AFTER_MS);
      retry = setTimeout(open, RETRY_MS);
    });
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    clearTimeout(down);
    source?.close();
  };
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
