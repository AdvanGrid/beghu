// The list's stacked label and blocker columns: one slot column's width and the gap after it.
// Constants here, so the list's styles (IssueList.tsx) and its width arithmetic (columns.ts)
// read the same numbers.
import * as stylex from "@stylexjs/stylex";

export const slots = stylex.defineConsts({
  labelSlot: 88,
  labelGap: 8,
  blockerSlot: 96,
  blockerGap: 4,
});

/**
 * The list's column widths (columns.ts), set once on the list's column as custom properties and
 * read by every row cell's static style: resizing a column restyles no row.
 */
export const colW = stylex.defineVars({
  labels: "0px",
  blockers: "0px",
  progress: "0px",
  ref: "0px",
  who: "0px",
  updated: "0px",
});
