// The list's layout constants: here, so the styles that draw a row's parts and the width
// arithmetic about them (IssueList.tsx, columns.ts) read the same numbers.
import * as stylex from "@stylexjs/stylex";

/** The stacked label and blocker columns: one slot column's width and the gap after it. */
export const slots = stylex.defineConsts({
  labelSlot: 88,
  labelGap: 8,
  blockerSlot: 96,
  blockerGap: 4,
});

/**
 * A row's assignees: an avatar's size (bits.tsx's default) and the gap between them (the cell's
 * style). IssueList.tsx reads both to tell whether a row's avatars fit their cell, which then
 * needn't clip.
 */
export const rowAvatars = stylex.defineConsts({
  size: 18,
  gap: 2,
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
