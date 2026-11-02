// Tree mode's expand state, a device preference: the nodes the user opened beyond the default and
// the ones they closed that open by default (context: an ancestor shown for a match below it).
// It's one state for every query, so a node stays as the user left it while they change the
// filter: typing narrows an open tree rather than closing it. It's kept in localStorage and shared
// with the browser's other tabs through `storage` events. Without storage (a private window that
// refuses it) it lasts as long as the tab.
import { createSignal } from "solid-js";

/** Where it's kept. */
const KEY = "beghu.tree-opens";
/** Where it was kept per query, before it was one state: cleared. */
const OLD_KEY = "beghu.tree-expand";
/**
 * How many ids each list keeps, the newest (as many as the server reads, and they go in the URL):
 * opening more pushes out the ones opened longest ago.
 */
export const IDS_MAX = 200;

/** The state: what the user opened, and the context they closed. */
export type Opens = { open: readonly number[]; shut: readonly number[] };

const NONE: Opens = { open: [], shut: [] };

function load(): Opens {
  try {
    localStorage.removeItem(OLD_KEY);
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return NONE;
    const ids = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is number => Number.isSafeInteger(n)).slice(-IDS_MAX) : []);
    return { open: ids((raw as Opens).open), shut: ids((raw as Opens).shut) };
  } catch {
    return NONE;
  }
}

// As it is now, for code that changes it (a signal read in the same tick as its write still gives
// the old value), and as a signal for what shows it.
let opensNowValue = load();
const [opensSignal, setOpensSignal] = createSignal<Opens>(opensNowValue);

function set(next: Opens): void {
  opensNowValue = next;
  setOpensSignal(next);
}

/** The state as its contents: what tells a change from the same state read again. */
export function opensKey(o: Opens): string {
  return `${o.open.join(",")}/${o.shut.join(",")}`;
}

// Another tab changed it: this one takes it up (Tree mode refetches when it changed).
addEventListener("storage", (e) => {
  if (e.key !== KEY && e.key !== null) return;
  const next = load();
  if (opensKey(next) !== opensKey(opensNowValue)) set(next);
});

/** The expand state. Reactive: another tab's change shows. */
export function opens(): Opens {
  return opensSignal();
}

/** The expand state as it is this moment, for a request to carry. Not reactive. */
export function opensNow(): Opens {
  return opensNowValue;
}

/** Sets the expand state: as `opens` gives it from now on. */
export function setOpens(next: Opens): Opens {
  const o: Opens = { open: [...new Set(next.open)].slice(-IDS_MAX), shut: [...new Set(next.shut)].slice(-IDS_MAX) };
  set(o);
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    // Full, or refused: this tab keeps it.
  }
  return o;
}
