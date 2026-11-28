// A facet value's colour: one of the 12 categorical tokens (`graph.facet0`–`facet11`), derived
// from the facet's and the value's IDs, so kept IDs keep their colours between analyses. A stable
// hash of the two IDs picks one; a collision within the facet takes the next free one, the values
// taken in value-ID order. A facet with more than 12 values reuses colours past the twelfth (each
// value is still named in words wherever its colour shows). A migration that renames IDs may
// change colours, accepted (#182). `unknown` has none: it's drawn grey, "no value found".
import type { Facet } from "../../bindings/analysis";

export const FACET_COLOURS = 12;

/** FNV-1a, 32 bits: stable across runs, builds and browsers. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Each value's colour index (0–11) in `facet`, `unknown` left out. */
export function valueColours(facet: Pick<Facet, "id" | "values">): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  const ids = facet.values.map((v) => v.id).filter((id) => id !== "unknown").sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const id of ids) {
    let c = hash(`${facet.id}\u0000${id}`) % FACET_COLOURS;
    if (taken.size < FACET_COLOURS) while (taken.has(c)) c = (c + 1) % FACET_COLOURS;
    taken.add(c);
    out.set(id, c);
  }
  return out;
}

/**
 * Up to this many stripes or rings show a value each; past it, a "+N" stripe (or badge) counts
 * the rest: "equal vertical stripes, up to 3, then a '+N' stripe" (#170, #182), so 4 values draw
 * 3 stripes and "+1".
 */
export const MAX_SHOWN = 3;
