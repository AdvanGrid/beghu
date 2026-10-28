// The token module: the only place a colour is written. Every colour is a light-dark() pair, so
// it follows the `color-scheme` theme.js sets on <html> (light, dark, or the system's). Values
// start from the list prototype (bench/candidates/list-prototype).
import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
  bg: "light-dark(#ffffff, #09090b)",
  bgRaised: "light-dark(#f8f8fa, #111114)",
  fg: "light-dark(#18181b, #f4f4f5)",
  muted: "light-dark(#71717a, #a1a1aa)",
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
