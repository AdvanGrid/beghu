// The legend's rows (#155, #166, #182): only the styles the current drawing uses, recomputed from
// what the canvas last drew, each with a small sample in the real style, its words, and a count
// of what's drawn in it. A row with nothing drawn is left out. Each row also names what it
// matches, so hovering it fades the rest and a hover card's "Drawn as" lists its item's rows.
//
// Sections, in order: Colour (by the change, or by the facet: a row per value drawn, then
// stripes and grey), Parts, Lines, Areas, and Outlines (a row per value drawn, in its colour).
// Under the fold (#183), Parts adds the dots ("● Dots: the purposes it serves (the panel names
// them)"), groups and the parts reached only through a conflict, and Lines says strong (the
// place's own lines, in the purpose's colour) and faint (the rest) in place of the change's
// strong and quiet.
import type { Model } from "../model";
import { CHANGE_KEYS, changeKey, colourOf, ringsOf, valuesOf, valueLabel, type ChangeKey } from "./look";
import type { Item, Scene } from "./scene";
import type { Settings } from "./settings";

export type Sample =
  | { kind: "part"; change?: ChangeKey; colour?: number; stripes?: boolean; none?: boolean; dashed?: boolean; faded?: boolean; group?: boolean; outside?: boolean }
  | { kind: "dots"; purpose?: number }
  | { kind: "text"; text: string }
  | { kind: "line"; changed?: boolean; dashed?: boolean; dotted?: boolean; thick?: boolean; both?: boolean; tone?: number }
  | { kind: "trunk" }
  | { kind: "area"; area: "column" | "changed" | "frame" | "box" | "shared" | "grid" }
  | { kind: "ring"; colour?: number; more?: boolean };

export interface KeyRow {
  id: string;
  section: string;
  words: string;
  sample: Sample;
  count: number;
  items: ReadonlySet<string>;
  lines: ReadonlySet<string>;
  trunks: ReadonlySet<string>;
}

const CHANGE_ROW: Record<ChangeKey, string> = {
  added: "Added",
  modified: "Changed",
  inside: "Changed inside: a part within it changed",
  removed: "Removed",
  unchanged: "Unchanged",
  none: "No change word: people and outside systems",
};

/** The legend's rows for `sc`, drawn under `s`; `purpose`, the colour of the purpose the fold stands on. */
export function keyRows(m: Model, s: Settings, sc: Scene, purpose?: number): KeyRow[] {
  const rows: KeyRow[] = [];
  const add = (r: Omit<KeyRow, "count" | "items" | "lines" | "trunks"> & { items?: Set<string>; lines?: Set<string>; trunks?: Set<string>; count?: number }) => {
    const items = r.items ?? new Set<string>(), lines = r.lines ?? new Set<string>(), trunks = r.trunks ?? new Set<string>();
    const count = r.count ?? items.size + lines.size + trunks.size;
    if (count === 0) return;
    rows.push({ ...r, items, lines, trunks, count });
  };
  const parts = [...sc.items.values()].filter((it) => it.kind === "part" && it.node);
  const blocks = [...sc.items.values()].filter((it) => it.kind === "part" || it.folded);
  const where = (pred: (it: Item) => boolean, from: Item[] = parts) => new Set(from.filter(pred).map((it) => it.id));

  // Colour.
  if (s.colour === undefined) {
    const section = "Colour: how the PR changed it";
    const keyOf = new Map(parts.map((it) => [it.id, changeKey(m, it.node!)]));
    for (const k of CHANGE_KEYS) add({ id: `change:${k}`, section, words: CHANGE_ROW[k], sample: { kind: "part", change: k }, items: where((it) => keyOf.get(it.id) === k) });
  } else {
    const def = m.facets.get(s.colour)!;
    const section = def.name;
    for (const v of def.values) {
      if (v.id === "unknown") continue;
      add({ id: `value:${v.id}`, section, words: v.label, sample: { kind: "part", colour: colourOf(m, def.id, v.id) }, items: where((it) => valuesOf(it.node!, def.id).includes(v.id)) });
    }
    add({ id: "value:*stripes", section, words: "Stripes: several values", sample: { kind: "part", stripes: true }, items: where((it) => valuesOf(it.node!, def.id).length > 1) });
    add({ id: "value:*none", section, words: "Grey: no value found", sample: { kind: "part", none: true }, items: where((it) => valuesOf(it.node!, def.id).length === 0) });
  }

  // Parts.
  {
    const section = "Parts";
    add({ id: "opens", section, words: "double-click ▸: has parts inside", sample: { kind: "text", text: "double-click ▸" }, items: where((it) => !it.grid && (it.group !== undefined || (m.children.get(it.id) ?? []).length > 0), blocks) });
    add({ id: "partial", section, words: "Partly drawn: some folders not drawn", sample: { kind: "text", text: "partly drawn" }, items: where((it) => !!it.node?.drawn, [...sc.items.values()]) });
    add({ id: "rest", section, words: "Dashed, muted: stands for parts left out", sample: { kind: "part", dashed: true }, items: where((it) => it.kind === "rest", [...sc.items.values()]) });
    add({ id: "faded", section, words: "Faded: not on a line that crosses a boundary", sample: { kind: "part", faded: true }, items: new Set(sc.faded) });
    if (sc.fold) {
      const all = [...sc.items.values()];
      add({ id: "dots", section, words: "● Dots: the purposes it serves (the panel names them)", sample: { kind: "dots" }, items: where((it) => (it.dots?.length ?? 0) > 0, all) });
      add({ id: "fold-group", section, words: "Group: parts of one kind, folded together", sample: { kind: "part", group: true }, items: where((it) => it.fold?.kind === "group" && it.folded, all) });
      add({ id: "fold-outside", section, words: "Dashed amber: reached only through a conflict", sample: { kind: "part", outside: true }, items: where((it) => it.fold?.kind === "out", all) });
    }
  }

  // Lines.
  {
    const section = "Lines";
    const ls = [...sc.lines.values()];
    const lw = (pred: (l: (typeof ls)[number]) => boolean) => new Set(ls.filter(pred).map((l) => l.id));
    if (sc.fold) {
      const at = sc.fold.place;
      const tone = at.kind === "purpose" && purpose !== undefined ? 2 + purpose : 1;
      add({ id: "line:carried", section, words: at.kind === "purpose" ? "Strong, in its colour: the purpose's own lines" : "Strong: a purpose's own lines", sample: { kind: "line", tone }, lines: lw((l) => l.carried) });
      add({ id: "line:faint", section, words: "Faint: lines it doesn't follow", sample: { kind: "line", tone: 0 }, lines: lw((l) => !l.carried) });
    } else {
      add({ id: "line:quiet", section, words: "Quiet purple: unchanged", sample: { kind: "line" }, lines: lw((l) => !l.changed) });
      add({ id: "line:strong", section, words: "Strong purple: added, changed or removed", sample: { kind: "line", changed: true }, lines: lw((l) => l.changed) });
    }
    add({ id: "line:dashed", section, words: "Dashed: crosses a boundary", sample: { kind: "line", dashed: true }, lines: lw((l) => l.dashed && !l.dotted) });
    add({ id: "line:dotted", section, words: "Dotted: not confirmed", sample: { kind: "line", dotted: true }, lines: lw((l) => l.dotted) });
    add({ id: "line:thick", section, words: "Thicker, with a number: several connections", sample: { kind: "line", thick: true }, lines: lw((l) => l.count > 1) });
    add({ id: "line:both", section, words: "Arrowheads at both ends: both ways", sample: { kind: "line", both: true }, lines: lw((l) => l.heads.to && l.heads.from) });
    add({ id: "trunk", section, words: "Trunk: lines sharing a stretch", sample: { kind: "trunk" }, trunks: new Set(sc.trunks.map((t) => t.id)) });
    add({ id: "line:labels", section, words: "No labels: hover or select a line", sample: { kind: "line" }, lines: lw(() => true) });
  }

  // Areas.
  {
    const section = "Areas";
    const all = [...sc.items.values()];
    const inside = (id: string) => new Set(all.filter((it) => it.parent === id).map((it) => it.id));
    for (const it of all) {
      if (it.kind !== "column" || it.folded) continue;
      add({ id: `column:${it.id}`, section, words: `Column: ${it.group!.title}`, sample: { kind: "area", area: it.group!.column === "changed" ? "changed" : "column" }, items: new Set([it.id, ...inside(it.id)]), count: inside(it.id).size });
    }
    add({ id: "frame", section, words: "Frame: an open part or group", sample: { kind: "area", area: "frame" }, items: new Set(all.filter((it) => it.kind === "frame").map((it) => it.id)) });
    const boxes = all.filter((it) => it.kind === "box" && !it.folded && it.group?.kind === "box");
    const byFacet = new Map<string, Item[]>();
    for (const b of boxes) byFacet.set(b.group!.by, [...(byFacet.get(b.group!.by) ?? []), b]);
    for (const [by, bs] of byFacet) add({ id: `box:${by}`, section, words: `Box: grouped by ${by}`, sample: { kind: "area", area: "box" }, items: new Set(bs.map((b) => b.id)) });
    add({ id: "shared", section, words: "Shared box: parts with several values", sample: { kind: "area", area: "shared" }, items: new Set(all.filter((it) => it.group?.kind === "shared" && !it.folded).map((it) => it.id)) });
    if (sc.grid) add({ id: "grid", section, words: "Grid: parts with no lines", sample: { kind: "area", area: "grid" }, items: where((it) => it.grid, all), count: sc.lonely.length });
  }

  // Outlines.
  if (s.outlines !== undefined) {
    const def = m.facets.get(s.outlines)!;
    const section = `Outlines: ${def.name}`;
    for (const v of def.values) {
      if (v.id === "unknown") continue;
      add({ id: `ring:${v.id}`, section, words: valueLabel(m, def.id, v.id), sample: { kind: "ring", colour: colourOf(m, def.id, v.id) }, items: where((it) => valuesOf(it.node!, def.id).includes(v.id)) });
    }
    add({ id: "ring:*more", section, words: "+N: more values", sample: { kind: "ring", more: true }, items: where((it) => (ringsOf(m, it.node!, s)?.more ?? 0) > 0) });
  }
  return rows;
}

/** The rows that describe one item's or line's own style: its "Drawn as". */
export function drawnAs(rows: readonly KeyRow[], what: { item?: string; line?: string }): KeyRow[] {
  return rows.filter((r) => (what.item !== undefined && r.items.has(what.item) && !r.id.startsWith("column:")) || (what.line !== undefined && r.lines.has(what.line)));
}
