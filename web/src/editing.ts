// The title and body editors' state, per issue: what each holds, what it opened with, and the edit
// it sent. Small, in the issue panel's chunk, so the panel knows which editors are open; the
// editors themselves (Editor.tsx) are a chunk of their own, loaded when one first opens.
//
// An editor opens with the field as the tab has it from the server: the title from the detail,
// the body's Markdown from `/api/issues/:id/source` (the detail carries the body rendered). That
// text is the edit's `base`. Saving sends a `title_edit` or `body_edit` (writes.tsx) and hides the
// editor while the edit is on its way, the field showing the new text with a pending dot. GitHub
// confirming it closes the editor for good; a failure opens it again with the text, and a 409
// (someone changed the field since it opened) with GitHub's text beside it. An editor stays open,
// with its text, when the panel shows another issue, and is there again when it comes back.
//
// Its text is unsaved text (unsaved.ts) while it differs from what the editor opened with, or
// while its edit has failed: leaving the page asks first. An edit on its way alone doesn't.
import { createSignal } from "solid-js";
import { holdsText } from "./unsaved";

export type Field = "title" | "body";

export interface Editing {
  issue: number;
  field: Field;
  /** The text typed; undefined until the user types into a body editor that hasn't pinned its base. */
  text?: string;
  /** What the editor opened with, which the edit is made over; GitHub's, after "Overwrite with mine". */
  base?: string;
  /** For a body: the digest of the body it opened with, to tell a live change by the detail's. */
  digest?: string;
  /** Focus the editor as it shows: the user just opened it. */
  focus?: boolean;
  /** The edit sent from it, on its way or failed. */
  op?: string;
  /** Its edit is on its way: the editor is hidden meanwhile. */
  saving?: boolean;
  /** How its edit failed: the editor shows it. */
  error?: Error;
  /** After a 409: the field as GitHub has it now, shown beside the user's text. */
  theirs?: string;
}

const key = (issue: number, field: Field) => `${issue}:${field}`;

let editingNow: ReadonlyMap<string, Editing> = new Map();
const [editing, setEditing] = createSignal(editingNow);

function commit(next: Map<string, Editing>): void {
  editingNow = next;
  setEditing(next);
}

/** `issue`'s editor of `field`, if one is open (reactive). */
export function editorOf(issue: number, field: Field): Editing | undefined {
  return editing().get(key(issue, field));
}

/** The same, as it is now: for event handlers, which may run in the tick of a change. */
export function editorNow(issue: number, field: Field): Editing | undefined {
  return editingNow.get(key(issue, field));
}

/** Opens `issue`'s editor of `field` (or focuses it, if it's open): a title opens with `title`. */
export function openEditor(issue: number, field: Field, title?: string): void {
  const had = editingNow.get(key(issue, field));
  if (had?.saving) return;
  const next = new Map(editingNow);
  next.set(key(issue, field), had ? { ...had, focus: true } : { issue, field, text: title, base: title, focus: true });
  commit(next);
}

/** Changes what `issue`'s editor of `field` holds. */
export function updateEditor(issue: number, field: Field, change: Partial<Editing>): void {
  const had = editingNow.get(key(issue, field));
  if (!had) return;
  const next = new Map(editingNow);
  next.set(key(issue, field), { ...had, ...change });
  commit(next);
}

/** Closes `issue`'s editor of `field`, dropping its text. */
export function closeEditor(issue: number, field: Field): void {
  if (!editingNow.has(key(issue, field))) return;
  const next = new Map(editingNow);
  next.delete(key(issue, field));
  commit(next);
}

/**
 * Whether two texts of `field` are the same as GitHub keeps them (as the server compares them): a
 * title without the whitespace around it, a body with either line end.
 */
export function sameText(field: Field, a: string, b: string): boolean {
  if (field === "title") return a.trim() === b.trim();
  return a.replaceAll("\r\n", "\n") === b.replaceAll("\r\n", "\n");
}

/** Whether an editor holds text the user would lose. */
export function unsaved(e: Editing): boolean {
  if (e.saving || e.text === undefined) return false;
  return e.error !== undefined || !sameText(e.field, e.text, e.base ?? "");
}

holdsText(() => [...editingNow.values()].some(unsaved));
