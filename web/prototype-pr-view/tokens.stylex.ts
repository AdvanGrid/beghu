// PROTOTYPE (PR view). Facet colours: eight categorical light-dark() pairs, told apart in both
// themes (and always shown with a text prefix, so colour is never the only cue), plus the
// tints the graph draws with. Kept here, not in src/tokens.stylex.ts, while this is a prototype.
import * as stylex from "@stylexjs/stylex";

export const pal = stylex.defineVars({
  c0: "light-dark(#2563eb, #60a5fa)",
  c1: "light-dark(#d97706, #fbbf24)",
  c2: "light-dark(#059669, #34d399)",
  c3: "light-dark(#db2777, #f472b6)",
  c4: "light-dark(#7c3aed, #a78bfa)",
  c5: "light-dark(#0891b2, #22d3ee)",
  c6: "light-dark(#65a30d, #a3e635)",
  c7: "light-dark(#dc2626, #f87171)",
  none: "light-dark(#d4d4d8, #3f3f46)",
  added: "light-dark(#1a7f37, #3fb950)",
  removed: "light-dark(#cf222e, #f85149)",
  modified: "light-dark(#9a6700, #d29922)",
  unchanged: "light-dark(#a1a1aa, #52525b)",
  addedTint: "light-dark(rgb(26 127 55 / 0.07), rgb(63 185 80 / 0.10))",
  removedTint: "light-dark(rgb(207 34 46 / 0.07), rgb(248 81 73 / 0.10))",
  modifiedTint: "light-dark(rgb(154 103 0 / 0.07), rgb(210 153 34 / 0.10))",
  // Lines and trunks (#166): their own purple, so they never read as a block's outline.
  line: "light-dark(#7c3aed, #a78bfa)",
  lineQuiet: "light-dark(#c4b5fd, #6d5aa8)",
  nodeBg: "light-dark(#ffffff, #18181b)",
  contextBg: "light-dark(#f4f4f5, #111114)",
  code: "light-dark(#f6f8fa, #0d1117)",
});
