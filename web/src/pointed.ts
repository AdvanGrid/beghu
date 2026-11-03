// The issue the pointer is on away from its own row: a blocker chip, or the blocker's line in the
// list's hover card (`blocker`), or a mention of it in a post (`mention`). Its row, when it's in
// view in the list or Tree mode, is outlined: red for a blocker, green for a mention.
import { createSignal } from "solid-js";

export type Pointed = { id: number; as: "blocker" | "mention" };

const [pointed, setPointed] = createSignal<Pointed>();

export { pointed };

/** The pointer is on `id`, as `as`. */
export function point(id: number, as: Pointed["as"]): void {
  setPointed({ id, as });
}

/** The pointer left what `as` marked: a later point from elsewhere stays. */
export function unpoint(as: Pointed["as"]): void {
  if (pointed()?.as === as) setPointed(undefined);
}
