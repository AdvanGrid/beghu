// How each drawn item reads: a part's face (kind, change, name, then a bottom line), its fill (by
// the change, or a facet's values as stripes), its outline rings, and a frame's title. Colour is
// always paired with words: the face says what the fill and rings mean, and so do the hover card
// and the legend.
import type { Node } from "../../bindings/analysis";
import type { Model } from "../model";
import { MAX_SHOWN, valueColours } from "./colour";
import type { Item } from "./scene";
import { isOutside, type Settings } from "./settings";

/** How the PR changed a part, as its colour says it. People and outside systems have no change word. */
export type ChangeKey = "added" | "modified" | "inside" | "removed" | "unchanged" | "none";

export const CHANGE_KEYS: readonly ChangeKey[] = ["added", "modified", "inside", "removed", "unchanged", "none"];

export const CHANGE_WORD: Record<ChangeKey, string> = {
  added: "added",
  modified: "changed",
  inside: "changed inside",
  removed: "removed",
  unchanged: "unchanged",
  none: "",
};

const KIND_WORD: Record<string, string> = {
  system: "system",
  service: "service",
  app: "app",
  library: "library",
  module: "module",
  store: "store",
  external: "external system",
  actor: "person or caller",
};

export const kindWord = (n: Node) => KIND_WORD[n.kind] ?? n.kind;

/** Each model's parts whose own code, or a part's inside them, changed: worked out once. */
const touchedCache = new WeakMap<Model, Set<string>>();

/** Whether a part's own code, or a part inside it, changed. */
export function touched(m: Model, id: string): boolean {
  let t = touchedCache.get(m);
  if (!t) {
    t = new Set();
    for (const n of m.a.nodes) if (n.change !== "unchanged") for (let x: string | undefined = n.id; x !== undefined && !t.has(x); x = m.nodes.get(x)?.parent ?? undefined) t.add(x);
    touchedCache.set(m, t);
  }
  return t.has(id);
}

export function changeKey(m: Model, n: Node): ChangeKey {
  if (isOutside(n)) return "none";
  if (n.change !== "unchanged") return n.change;
  return touched(m, n.id) ? "inside" : "unchanged";
}

/** A fill: by the change, or by a facet's values (up to 3 stripes, then "+N"), or grey for none. */
export type Fill = { by: "change"; key: ChangeKey } | { by: "facet"; stripes: number[]; more: number; none: boolean };

/** The values `n` has for `facet` (its `unknown` left out). */
export function valuesOf(n: Node, facet: string): string[] {
  return (n.facets.find((f) => f.facet === facet)?.values ?? []).map((v) => v.value).filter((v) => v !== "unknown");
}

/** Each facet's value colours, worked out once per model. */
const colourCache = new WeakMap<Model, Map<string, Map<string, number>>>();
export function colourOf(m: Model, facet: string, value: string): number {
  let byFacet = colourCache.get(m);
  if (!byFacet) colourCache.set(m, (byFacet = new Map()));
  let cs = byFacet.get(facet);
  if (!cs) {
    const def = m.facets.get(facet);
    byFacet.set(facet, (cs = def ? valueColours(def) : new Map()));
  }
  return cs.get(value) ?? 0;
}

export function fillOf(m: Model, n: Node, s: Settings): Fill {
  if (s.colour === undefined) return { by: "change", key: changeKey(m, n) };
  const vs = valuesOf(n, s.colour);
  const shown = vs.slice(0, MAX_SHOWN);
  return { by: "facet", stripes: shown.map((v) => colourOf(m, s.colour!, v)), more: vs.length - shown.length, none: vs.length === 0 };
}

/** Outline rings: up to 3 nested, in the values' colours, then "+N". */
export function ringsOf(m: Model, n: Node, s: Settings): { rings: number[]; more: number } | undefined {
  if (s.outlines === undefined) return undefined;
  const vs = valuesOf(n, s.outlines);
  if (!vs.length) return undefined;
  const shown = vs.slice(0, MAX_SHOWN);
  return { rings: shown.map((v) => colourOf(m, s.outlines!, v)), more: vs.length - shown.length };
}

/** A value's label in its facet. */
export function valueLabel(m: Model, facet: string, value: string): string {
  return m.facets.get(facet)?.values.find((v) => v.id === value)?.label ?? value;
}

const num = (n: number) => n.toLocaleString("en-US");

/** "12 files · +1,840 −22", or undefined for a part the PR left alone. */
export function sizeLine(m: Model, id: string): string | undefined {
  const files = m.files(id);
  if (!files.length) return undefined;
  let add = 0, del = 0;
  for (const f of files) (add += f.added), (del += f.removed);
  return `${files.length} ${files.length === 1 ? "file" : "files"} · +${num(add)} −${num(del)}`;
}

/** "3 of 5 connections are new or changed", for people and outside systems. */
export function connectionsLine(m: Model, id: string): string {
  const { out, into } = m.connections(id);
  const all = [...out, ...into];
  const changed = all.filter((e) => e.change !== "unchanged").length;
  return `${changed} of ${all.length} ${all.length === 1 ? "connection" : "connections"} new or changed`;
}

export interface Face {
  kind: string;
  change: ChangeKey;
  name: string;
  bottom: string;
  /** "double-click ▸" */
  opens: boolean;
  partial: boolean;
}

/** A closed part's or folded group's face. */
export function faceOf(m: Model, it: Item, s: Settings): Face {
  if (it.group) {
    const g = it.group;
    const changed = g.members.filter((id) => touched(m, id) && !isOutside(m.nodes.get(id)!)).length;
    return {
      kind: g.kind === "column" ? "column" : g.kind === "shared" ? "shared box" : `box · ${g.by}`,
      change: "none",
      name: g.title,
      bottom: `${g.members.length} ${g.members.length === 1 ? "part" : "parts"} · ${changed} changed`,
      opens: !it.grid,
      partial: false,
    };
  }
  if (it.rest) {
    const k = it.rest.folders;
    return { kind: "", change: "none", name: `${k} ${k === 1 ? "folder" : "folders"} not drawn`, bottom: "no line, step, purpose or conflict in this PR reaches them", opens: false, partial: false };
  }
  const n = it.node!;
  const change = changeKey(m, n);
  let bottom: string;
  if (s.colour !== undefined) {
    const vs = valuesOf(n, s.colour);
    bottom = vs.length ? vs.map((v) => valueLabel(m, s.colour!, v)).join(", ") : "no value found";
  } else bottom = isOutside(n) ? connectionsLine(m, n.id) : (sizeLine(m, n.id) ?? "no files changed");
  return { kind: kindWord(n), change, name: n.name, bottom, opens: !it.grid && (m.children.get(n.id) ?? []).length > 0, partial: !!n.drawn };
}

/** A frame's title: "▾ advagent-v3 › runtime", "▾ sandbox · 3 of 9 folders drawn", "▾ Folder: crates". */
export function titleOf(m: Model, it: Item, drawnFolders: (n: Node) => number): string {
  if (it.group) return it.group.kind === "box" ? `▾ ${it.group.by}: ${it.group.title}` : `▾ ${it.group.title}`;
  const n = it.node!;
  const sys = m.system?.id;
  const path = [...m.ancestors(n.id)].reverse().filter((x) => x !== sys).map((x) => m.nodes.get(x)?.name ?? x);
  const title = `▾ ${[...path, n.name].join(" › ")}`;
  return n.drawn ? `${title} · ${drawnFolders(n)} of ${n.drawn.folders} folders drawn` : title;
}
