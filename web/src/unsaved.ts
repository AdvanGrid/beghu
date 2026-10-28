// Unsaved text: what the tab would lose by leaving, reloading or signing out. Code that holds such
// text (the comment drafts and comments not sent in writes.tsx, the title and body editors in
// editing.ts) says so here as it loads. Only unsaved text asks before leaving (spec #86): a pending
// write alone doesn't, since it's on its way and the server finishes it without the tab.
//
// `beforeunload` covers closing and reloading. A reload the app makes itself (a route's code
// failing to load, Root.tsx) waits while there's unsaved text, as the build-id reload (#115) and
// sign-out (#112) are to: they call `unsavedText`.

/** Each holder of text says whether it has some unsaved now. */
const holders = new Set<() => boolean>();

/** Counts `has` among the tab's unsaved text; the result stops counting it. */
export function holdsText(has: () => boolean): () => void {
  holders.add(has);
  return () => holders.delete(has);
}

/** Whether the tab holds text the user would lose by leaving. */
export function unsavedText(): boolean {
  for (const has of holders) if (has()) return true;
  return false;
}

addEventListener("beforeunload", (e) => {
  if (unsavedText()) e.preventDefault();
});
