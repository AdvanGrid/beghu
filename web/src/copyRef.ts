import { createSignal } from "solid-js";

/**
 * Click-to-copy for an issue's number (`#123`), from a list or Tree row's number cell and the
 * detail's. The issue copied last says "Copied" in its number's place for a moment. The row is a
 * link: the click is prevented, so it copies without opening the issue (the router skips a
 * prevented click; Solid's delegated handler runs at the app's root, before the router's own on
 * the document).
 */
const [copied, setCopied] = createSignal<number | null>(null);
let clear: ReturnType<typeof setTimeout> | undefined;

/** The id of the issue whose number was just copied, if any. */
export { copied };

export function copyRef(e: MouseEvent, issue: { id: number; number: number }): void {
  // A modified click keeps the link's own meaning (a new tab, a download).
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigator.clipboard.writeText(`#${issue.number}`).then(
    () => {
      clearTimeout(clear);
      setCopied(issue.id);
      clear = setTimeout(() => setCopied(null), 1500);
    },
    // No clipboard (a page on plain http, or permission refused): nothing to show.
    () => {},
  );
}
