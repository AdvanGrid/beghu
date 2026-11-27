// Moving around the PR view: picks change the selection (a history entry each, desktop's rule;
// the phone's is slice 12's), a tab switch pushes one too, and the view-wide settings (lens,
// Show, Colour by, Boxes, Outlines, Lines) replace the current entry. Every move keeps the
// history entry's state: the PR panel's place the view's ← link goes back to.
import { createContext, useContext } from "solid-js";
import type { Model } from "./model";
import type { Replacing, Sel, Tab, ViewState } from "./state";

export interface Nav {
  /** The view's state, from its URL. */
  state: () => ViewState;
  /** The selection the view shows: the URL's, forwarded to this analysis. */
  sel: () => Sel | undefined;
  /** Selects `sel` (undefined: the PR), as a new history entry. */
  select: (sel: Sel | undefined) => void;
  /** Switches the tab, as a new history entry. */
  tab: (tab: Tab) => void;
  /** Sets a view-wide setting (undefined: its default), in place of the current entry. */
  set: (key: Replacing, value: string | undefined) => void;
  model: () => Model;
}

export const NavContext = createContext<Nav>();

export function useNav(): Nav {
  const n = useContext(NavContext);
  if (!n) throw new Error("used outside the PR view");
  return n;
}

/** What `ids` name in `m`, selected together: parts, lines or purposes (the first's kind). */
export function selOf(m: Model, ids: string[]): Sel {
  const first = ids[0] ?? "";
  const kind = m.edges.has(first) ? "line" : m.purposes.has(first) ? "purpose" : "part";
  return { kind, ids };
}

/** A part's selection. */
export const part = (id: string): Sel => ({ kind: "part", ids: [id] });
/** A line's selection. */
export const line = (id: string): Sel => ({ kind: "line", ids: [id] });
