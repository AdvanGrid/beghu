// Tree mode's expand state, a device preference (spec #86): per query, normalised (its tokens in
// any order or case, `sort:` included; `normalized` in query.ts), the nodes the user opened beyond
// the default and the ones they closed that open by default (context: an ancestor shown for a
// match below it). It's kept in localStorage for the 50 queries used last, and shared with the
// browser's other tabs through `storage` events. Without storage (a private window that refuses
// it) it lasts as long as the tab.
import { createSignal } from "solid-js";
import { normalized } from "./query";

/** Where it's kept. */
const KEY = "beghu.tree-expand";
/** How many queries keep theirs: the ones used last. */
export const KEEP = 50;
/**
 * How many ids each list keeps, the newest (as many as the server reads, and they go in the URL):
 * opening more pushes out the ones opened longest ago.
 */
export const IDS_MAX = 200;

/** One query's state: what the user opened, and the context they closed. */
export type Opens = { open: readonly number[]; shut: readonly number[] };
type Entry = Opens & { q: string };

const NONE: Opens = { open: [], shut: [] };

function load(): Entry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    const ids = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is number => Number.isSafeInteger(n)).slice(-IDS_MAX) : []);
    return raw
      .filter((e): e is Entry => typeof e === "object" && e !== null && typeof (e as Entry).q === "string")
      .map((e) => ({ q: e.q, open: ids(e.open), shut: ids(e.shut) }))
      .slice(0, KEEP);
  } catch {
    return [];
  }
}

// Newest used first: as they are now, for code that changes them (a signal read in the same tick
// as its write still gives the old value), and as a signal for what shows them.
let entriesNow = load();
const [entries, setEntries] = createSignal<Entry[]>(entriesNow);

function set(next: Entry[]): void {
  entriesNow = next;
  setEntries(next);
}

function save(next: Entry[]): void {
  set(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Full, or refused: this tab keeps it.
  }
}

/** A query's state as its contents: what tells a change from the same state read again. */
export function opensKey(o: Opens): string {
  return `${o.open.join(",")}/${o.shut.join(",")}`;
}

// Another tab changed it: this one takes it up (Tree mode refetches a tree whose state changed).
// An entry whose contents didn't change stays the same object, and a new order (another tab used
// a query, the LRU's order) changes no query's state.
addEventListener("storage", (e) => {
  if (e.key !== KEY && e.key !== null) return;
  const was = new Map(entriesNow.map((x) => [x.q, x]));
  set(
    load().map((x) => {
      const old = was.get(x.q);
      return old && opensKey(old) === opensKey(x) ? old : x;
    }),
  );
});

/** The expand state of `query` (the bar's query). Reactive: another tab's change shows. */
export function opensOf(query: string): Opens {
  const q = normalized(query);
  return entries().find((e) => e.q === q) ?? NONE;
}

/** The expand state of `query` as it is this moment, for a request to carry. Not reactive. */
export function opensNow(query: string): Opens {
  const q = normalized(query);
  return entriesNow.find((e) => e.q === q) ?? NONE;
}

/**
 * Sets the expand state of `query`, which becomes the newest used; past `KEEP`, the oldest go. The
 * state as `opensOf` gives it from now on.
 */
export function setOpens(query: string, opens: Opens): Opens {
  const q = normalized(query);
  const entry: Entry = { q, open: [...new Set(opens.open)].slice(-IDS_MAX), shut: [...new Set(opens.shut)].slice(-IDS_MAX) };
  save([entry, ...entriesNow.filter((e) => e.q !== q)].slice(0, KEEP));
  return entry;
}

/** `query` was used: its state, if it keeps one, becomes the newest used. */
export function used(query: string): void {
  const q = normalized(query);
  const all = entriesNow;
  const at = all.findIndex((e) => e.q === q);
  if (at > 0) save([all[at]!, ...all.slice(0, at), ...all.slice(at + 1)]);
}
