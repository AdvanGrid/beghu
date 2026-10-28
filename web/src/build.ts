// Which build the tab runs, and whether beghu has moved on to another (spec #86). The shell names
// its build (`<meta name="beghu-build">`, crates/server/src/shell.rs); in dev, where Vite serves
// the shell, the tab takes the first build beghu names as its own. Every API answer names the
// server's build (`X-Beghu-Build`, api.ts), and so does the stream's `reset` (live.ts), which
// every stream opens with: a tab whose stream reconnects after a deploy hears at once.
//
// Once beghu names another build, the tab's next in-app navigation is a full document load, which
// gets the new build's shell and code; the old build's lazy chunks may be gone (pruned a day after
// the deploy, docs/deploy.md). It waits while the tab holds unsaved text (unsaved.ts), while a
// write is on its way, and while the focus is in a text field (typing in the filter box changes
// the URL at every token): those navigations stay in the app, and the first one made without
// goes. So does a search the filter box changes in place (a `replace` to the same path): the next
// navigation that adds a history entry loads.

import { useBeforeLeave } from "@solidjs/router";
import { isTextField } from "./keys";
import { unsavedText } from "./unsaved";

let mine = document.querySelector<HTMLMetaElement>('meta[name="beghu-build"]')?.content || undefined;
let behind = false;
/** Writes on their way (`whileWriting`). */
let writes = 0;

/** beghu says it runs `build` (a header's value, or the stream's). */
export function noteBuild(build: string | null | undefined): void {
  if (!build) return;
  if (mine === undefined) mine = build;
  else if (build !== mine) behind = true;
}

/** Runs `send` (a write, with its resends) as a write on its way: the load waits for it. */
export async function whileWriting<T>(send: () => Promise<T>): Promise<T> {
  writes++;
  try {
    return await send();
  } finally {
    writes--;
  }
}

/** Whether a full load now would cost the user something: text, a write, a field being typed in. */
function busy(): boolean {
  return unsavedText() || writes > 0 || isTextField(document.activeElement);
}

/**
 * Loads `url` as a whole document, its shell fetched afresh: it puts `url` in the address bar
 * (as a new history entry, or in place of this one) and reloads. A plain navigation could take
 * the old build's shell from the HTTP cache (`private, max-age=300`), naming chunks that are
 * gone; a reload revalidates it.
 */
export function loadAfresh(url: string, replace: boolean): void {
  if (url !== location.pathname + location.search + location.hash) {
    if (replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
  }
  location.reload();
}

/**
 * The rule, in the router (call once, under it): once beghu runs another build, a navigation the
 * app would make in place loads the document instead, unless it would cost the user something
 * (`busy`) or only replaces the search. Back and Forward between the app's own pages have moved
 * the address bar already, so they reload it.
 */
export function newBuildOnNavigate(): void {
  useBeforeLeave((e) => {
    if (!behind || e.defaultPrevented || busy()) return;
    if (typeof e.to === "number") {
      location.reload();
      return;
    }
    if (e.options?.replace && new URL(e.to, location.href).pathname === location.pathname) return;
    e.preventDefault();
    loadAfresh(e.to, e.options?.replace === true);
  });
}
