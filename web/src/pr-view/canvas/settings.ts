// The canvas's view-wide settings, read from the view's URL state (state.ts) against one analysis:
// the lens, Show, Colour by, Boxes' two slots, Outlines and the Lines menu, each falling back to
// its default when the URL names something the analysis doesn't have. Which lines and parts each
// lens and Show draw is here too, so the toolbar's counts, the canvas and the Group panel agree.
//
// - Modules and services (the default): code parts only (no people, outside systems or stores),
//   and every line between code parts the Lines menu shows.
// - Data flow: only lines with `data`, their arrows in the data's direction; the Lines menu's
//   Kind is fixed to them (shown greyed). Every kind of part.
// - External connections: lines that touch an outside system, a store or a person, and lines
//   crossing a boundary; parts on no boundary-crossing line are faded.
// - Order of actions is slice 11's: the toolbar lists it disabled, and a URL naming it draws
//   Modules and services.
//
// Show applies at the top level: the whole system; the change and what it connects to (the
// changed group's parts, and every part a drawn line joins to one); or changed parts only.
import type { Edge, Node } from "../../bindings/analysis";
import { outsideBoxFacet } from "../layout/graph";
import type { Model } from "../model";
import { parseLines, type Lines, type ViewState } from "../state";

export type Lens = "modules" | "data" | "external";

/** The lens picker's choices, in order. Order of actions comes with slice 11. */
export const LENSES: readonly { id: string; name: string; disabled?: boolean }[] = [
  { id: "modules", name: "Modules and services" },
  { id: "data", name: "Data flow" },
  { id: "external", name: "External connections" },
  { id: "order", name: "Order of actions", disabled: true },
];

export type ShowWhat = "all" | "reach" | "changed";

export const SHOWS: readonly { id: ShowWhat; name: string }[] = [
  { id: "all", name: "The whole system" },
  { id: "reach", name: "The change and what it connects to" },
  { id: "changed", name: "Changed parts only" },
];

export interface Settings {
  lens: Lens;
  show: ShowWhat;
  /** The facet parts are coloured by; undefined: by the change. */
  colour?: string;
  /** Boxes' own-parts slot: by folder, an `inside-*` facet, or none (undefined). */
  own?: "folder" | string;
  /** Boxes' outside slot: an `outside-*` facet, or none (undefined). */
  outside?: string;
  /** The facet drawn as outlines; undefined: none. */
  outlines?: string;
  lines: Lines;
}

const nodeFacet = (m: Model, id: string | undefined) => (id !== undefined && m.facets.get(id)?.appliesTo === "node" ? id : undefined);

/** The settings `st` names, for `m`: each one the analysis lacks at its default. */
export function settingsOf(st: ViewState, m: Model): Settings {
  const lens: Lens = st.lens === "data" || st.lens === "external" ? st.lens : "modules";
  const show: ShowWhat = st.show === "reach" || st.show === "changed" ? st.show : "all";
  const colour = st.colour === undefined || st.colour === "change" ? undefined : nodeFacet(m, st.colour);
  const [ownRaw = "", outsideRaw = ""] = (st.boxes ?? "").split(",");
  const own = ownRaw === "" || ownRaw === "folder" ? "folder" : ownRaw === "none" ? undefined : ownRaw.startsWith("inside-") ? nodeFacet(m, ownRaw) ?? "folder" : "folder";
  const fallback = outsideBoxFacet(m.a.facets);
  const outside = outsideRaw === "none" ? undefined : outsideRaw === "" ? fallback : outsideRaw.startsWith("outside-") ? (nodeFacet(m, outsideRaw) ?? fallback) : fallback;
  const outlines = st.outlines === undefined || st.outlines === "none" ? undefined : nodeFacet(m, st.outlines);
  return { lens, show, colour, own, outside, outlines, lines: parseLines(st.lines) };
}

/** Whether two settings draw the same: a selection's change (the URL's) keeps the drawing. */
export function sameSettings(a: Settings, b: Settings): boolean {
  const set = (x: ReadonlySet<string>, y: ReadonlySet<string>) => x.size === y.size && [...x].every((v) => y.has(v));
  return (
    a.lens === b.lens &&
    a.show === b.show &&
    a.colour === b.colour &&
    a.own === b.own &&
    a.outside === b.outside &&
    a.outlines === b.outlines &&
    set(a.lines.when, b.lines.when) &&
    set(a.lines.kind, b.lines.kind)
  );
}

/** Facets for nodes whose ID starts with `prefix` (`inside-`, `outside-`), or every node facet. */
export function facetsFor(m: Model, prefix?: string) {
  return m.a.facets.filter((f) => f.appliesTo === "node" && (prefix === undefined || f.id.startsWith(prefix)));
}

/** Whether a node is code: not a person, an outside system or a store. */
export const isCode = (n: Node) => n.kind !== "actor" && n.kind !== "external" && n.kind !== "store";
/** Whether a node is outside the code: a person, an outside system or a store. */
export const isOutside = (n: Node) => !isCode(n) && n.kind !== "system";

/** Whether `e` is one the lens draws, before the Lines menu (Modules: between code parts). */
export function lensHas(e: Edge, lens: Lens, m: Model): boolean {
  const a = m.nodes.get(e.from), b = m.nodes.get(e.to);
  if (!a || !b) return false;
  switch (lens) {
    case "modules":
      return isCode(a) && isCode(b);
    case "data":
      // The served graph writes an absent `data` as null.
      return !!e.data;
    case "external":
      return isOutside(a) || isOutside(b) || e.boundaries.length > 0;
  }
}

/** Whether the Lines menu shows `e`: its When, and its Kind (fixed to lines with `data` under Data flow). */
export function menuHas(e: Edge, s: Settings): boolean {
  if (!s.lines.when.has(e.when)) return false;
  return s.lens === "data" ? true : s.lines.kind.has(e.kind);
}

/** The lines the canvas draws: the lens's, as the Lines menu shows them. */
export function shownEdges(m: Model, s: Settings): Edge[] {
  return m.a.edges.filter((e) => lensHas(e, s.lens, m) && menuHas(e, s));
}

/** Whether the lens draws node `n` (Modules: code only). */
export function lensDraws(n: Node, lens: Lens): boolean {
  return lens !== "modules" || isCode(n);
}
