// The token module: the only place a colour is written. Every colour is a light-dark() pair, so
// it follows the `color-scheme` theme.js sets on <html> (light, dark, or the system's). Values
// start from the list prototype (bench/candidates/list-prototype, in history at aba7a01).
import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
  bg: "light-dark(#ffffff, #09090b)",
  bgRaised: "light-dark(#f8f8fa, #111114)",
  fg: "light-dark(#18181b, #f4f4f5)",
  muted: "light-dark(#71717a, #a1a1aa)",
  // Tree mode's context, the ancestors shown only for a match below them: dimmed text, still at
  // least 5.3:1 on bg, hover and selected, light and dark.
  context: "light-dark(#63636c, #a1a1aa)",
  line: "light-dark(#e4e4e7, #27272a)",
  hover: "light-dark(#f4f4f5, #18181b)",
  selected: "light-dark(#eef2ff, #1e2235)",
  accent: "light-dark(#2563eb, #3b82f6)",
  accentFg: "light-dark(#ffffff, #ffffff)",
  // A filled accent control under accentFg text: dark mode's accent (#3b82f6) is too light for
  // white text (3.68:1), so it fills with the deeper blue there too (5.17:1; light: 5.17:1).
  accentBg: "light-dark(#2563eb, #2563eb)",
  open: "light-dark(#1a7f37, #3fb950)",
  done: "light-dark(#8250df, #a371f7)",
  notPlanned: "light-dark(#6e7781, #8b949e)",
  // Also a blocked issue's edge and count, and a blocker that is itself blocked.
  danger: "light-dark(#cf222e, #f85149)",
  // A blocker nobody owns.
  unowned: "light-dark(#9a6700, #d29922)",
  // A title or body changed on GitHub under its open editor: at least 5.3:1 on bg, bgRaised and a
  // post's tint frame, light and dark.
  warn: "light-dark(#8a5c00, #d29922)",
  // The shift cue's tint on a row that will leave (held.ts): danger at 8% (light) and 12% (dark).
  cueLeave: "light-dark(rgb(207 34 46 / 0.08), rgb(248 81 73 / 0.12))",
  // The detail's held changes (HeldDetail.tsx): the tint under a part that will change, and on
  // what just arrived, fading out: accent at 8% (light) and 14% (dark).
  cueTint: "light-dark(rgb(37 99 235 / 0.08), rgb(59 130 246 / 0.14))",
  // A search's matched words in the detail.
  mark: "light-dark(#fff1a8, #5c4a00)",
  // Hover cards, over the list.
  pop: "light-dark(#ffffff, #18181b)",
  popShadow: "light-dark(rgb(0 0 0 / 0.12), rgb(0 0 0 / 0.6))",
  // State badges: filled, under accentFg text.
  openBg: "light-dark(#1f883d, #238636)",
  doneBg: "light-dark(#8250df, #8957e5)",
  notPlannedBg: "light-dark(#6e7781, #6e7681)",
  // A closed (unmerged) PR's badge.
  dangerBg: "light-dark(#cf222e, #da3633)",
  avatarFg: "light-dark(#ffffff, #ffffff)",
  avatar0: "light-dark(#b45309, #92400e)",
  avatar1: "light-dark(#047857, #065f46)",
  avatar2: "light-dark(#1d4ed8, #1e40af)",
  avatar3: "light-dark(#7c3aed, #5b21b6)",
  avatar4: "light-dark(#be185d, #9d174d)",
  avatar5: "light-dark(#0e7490, #155e75)",
});

export const fonts = stylex.defineVars({
  ui: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, monospace",
});

export const media = stylex.defineConsts({
  /** Below 900 px of viewport the issue panel sits under the list instead of beside it. */
  stacked: "@media (max-width: 899px)",
});

/**
 * The PR view's canvas (pr-view/canvas/). Lines and trunks are purple, apart from the change
 * colours, so a frame's lines never read as part of the group it opens in (#166): `lineQuiet` for
 * an unchanged line, `line` for an added, changed or removed one. (Named apart from `colors.line`,
 * the app's borders.) The change fills tint a part by how the PR changed it; its border takes the
 * change colour itself (`colors.open`, `warn`, `danger`). `facet0`–`facet11` are the categorical
 * colours a facet's values take (canvas/colour.ts), each with the tint its stripe fills with: told
 * apart in both themes, and always paired with words, and none of them is a line's colour (`line`,
 * `lineQuiet`, `lineLit`), so a part's fill never reads as a line. Their tints are the colour at
 * 16% (light) and 24% (dark).
 */
export const graph = stylex.defineVars({
  line: "light-dark(#7c3aed, #a78bfa)",
  lineQuiet: "light-dark(#b9a6e8, #5b4a8a)",
  // Lit: a hovered or selected line, a route lit through its trunks. Purple still, only stronger:
  // a lit line never reads as a facet's colour.
  lineLit: "light-dark(#4c1d95, #ddd6fe)",
  canvas: "light-dark(#fbfbfc, #0c0c0f)",
  part: "light-dark(#ffffff, #17171b)",
  partEdge: "light-dark(#a1a1aa, #52525b)",
  // People and outside systems: no change word, and a fill of their own.
  outsideFill: "light-dark(#f4f4f5, #1c1c21)",
  addedFill: "light-dark(rgb(26 127 55 / 0.10), rgb(63 185 80 / 0.14))",
  modifiedFill: "light-dark(rgb(154 103 0 / 0.10), rgb(210 153 34 / 0.14))",
  insideFill: "light-dark(rgb(154 103 0 / 0.04), rgb(210 153 34 / 0.06))",
  removedFill: "light-dark(rgb(207 34 46 / 0.10), rgb(248 81 73 / 0.14))",
  // The column frames: the changed group tinted, the others plain.
  changedGroup: "light-dark(rgb(154 103 0 / 0.035), rgb(210 153 34 / 0.05))",
  groupEdge: "light-dark(#d4d4d8, #3f3f46)",
  boxFill: "light-dark(rgb(113 113 122 / 0.06), rgb(161 161 170 / 0.07))",
  boxEdge: "light-dark(#a1a1aa, #52525b)",
  // A facet's "no value found".
  noValue: "light-dark(#d4d4d8, #3f3f46)",
  noValueFill: "light-dark(rgb(161 161 170 / 0.14), rgb(113 113 122 / 0.22))",
  facet0: "light-dark(#2563eb, #60a5fa)",
  facet1: "light-dark(#d97706, #fbbf24)",
  facet2: "light-dark(#059669, #34d399)",
  facet3: "light-dark(#db2777, #f472b6)",
  facet4: "light-dark(#ea580c, #fb923c)",
  facet5: "light-dark(#0891b2, #22d3ee)",
  facet6: "light-dark(#65a30d, #a3e635)",
  facet7: "light-dark(#dc2626, #f87171)",
  facet8: "light-dark(#9333ea, #c084fc)",
  facet9: "light-dark(#0d9488, #2dd4bf)",
  facet10: "light-dark(#a16207, #facc15)",
  facet11: "light-dark(#4f46e5, #818cf8)",
  facet0Fill: "light-dark(rgb(37 99 235 / 0.16), rgb(96 165 250 / 0.24))",
  facet1Fill: "light-dark(rgb(217 119 6 / 0.16), rgb(251 191 36 / 0.24))",
  facet2Fill: "light-dark(rgb(5 150 105 / 0.16), rgb(52 211 153 / 0.24))",
  facet3Fill: "light-dark(rgb(219 39 119 / 0.16), rgb(244 114 182 / 0.24))",
  facet4Fill: "light-dark(rgb(234 88 12 / 0.16), rgb(251 146 60 / 0.24))",
  facet5Fill: "light-dark(rgb(8 145 178 / 0.16), rgb(34 211 238 / 0.24))",
  facet6Fill: "light-dark(rgb(101 163 13 / 0.16), rgb(163 230 53 / 0.24))",
  facet7Fill: "light-dark(rgb(220 38 38 / 0.16), rgb(248 113 113 / 0.24))",
  facet8Fill: "light-dark(rgb(147 51 234 / 0.16), rgb(192 132 252 / 0.24))",
  facet9Fill: "light-dark(rgb(13 148 136 / 0.16), rgb(45 212 191 / 0.24))",
  facet10Fill: "light-dark(rgb(161 98 7 / 0.16), rgb(250 204 21 / 0.24))",
  facet11Fill: "light-dark(rgb(79 70 229 / 0.16), rgb(129 140 248 / 0.24))",
});
