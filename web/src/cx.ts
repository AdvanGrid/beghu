// Class strings from StyleX, computed once at module level, for the elements a list builds by the
// thousand (its rows and their parts). `{...stylex.attrs(…)}` is a spread, which Solid applies
// by its general path on every element of every row it builds, and merges the styles again each
// time; `class={ROW}` bound to one of these is a plain attribute in the template's one effect.
//
// The lint (eslint-rules.js, no-class-or-style) lets a `class` attribute take only a module-level
// constant made by a function of this module, or an entry of one (a table indexed by a variant),
// so every class still comes from StyleX's compiled styles: none is written by hand. A style with
// a dynamic value can't be one of these (its value is per element): such an element reads a CSS
// custom property, set by `style={{ "--name": value }}`, from a static style.
import * as stylex from "@stylexjs/stylex";

/** What `stylex.attrs` takes: compiled styles (arrays of them nest), or a falsy value for none. */
type Styles = (stylex.StyleXStyles | false | null | undefined)[];

/** The class string of `styles`, all static (no dynamic style: it would need an inline style). */
export function cx(...styles: Styles): string {
  const a = stylex.attrs(...styles);
  if (a.style) throw new Error(`cx(): a dynamic style (${a.style}) can't be a class constant`);
  return a.class ?? "";
}

/**
 * One class string per variant: `look(i)` gives the styles of variant `i`, for `i` from 0 to
 * `n - 1` (typically a bit mask of the element's flags: selected, blocked, …).
 */
export function cxTable(n: number, look: (i: number) => Styles): string[] {
  return Array.from({ length: n }, (_, i) => cx(...look(i)));
}

/** One class string per key, `look(key)` giving its styles. */
export function cxMap<K extends string>(keys: readonly K[], look: (key: K) => Styles): Record<K, string> {
  return Object.fromEntries(keys.map((k) => [k, cx(...look(k))])) as Record<K, string>;
}
