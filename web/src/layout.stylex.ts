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
