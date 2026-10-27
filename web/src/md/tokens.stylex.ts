// The Markdown token module: the colours of posts (Markdown style B, the tint frame, code
// highlighting and the language dots), each a light-dark() pair like every token in
// ../tokens.stylex.ts. They live apart from that module so that their JS rides only in the issue
// panel's lazy chunk, never first-load JS; their CSS goes in the one stylesheet either way (this
// splits JS, not CSS). Values start
// from the Markdown prototype (bench/candidates/list-prototype/web/src/md/md.css and frames.css,
// and app.css for the highlight colours).
import * as stylex from "@stylexjs/stylex";

export const md = stylex.defineVars({
  // Heading levels, h1 to h6: blue, orange, green, teal, purple, magenta.
  h1: "light-dark(#2f5fd0, #82aaff)",
  h2: "light-dark(#b45309, #ff9e64)",
  h3: "light-dark(#3f7d20, #9ece6a)",
  h4: "light-dark(#0e7a6e, #4fd6be)",
  h5: "light-dark(#7c3aed, #c099ff)",
  h6: "light-dark(#a21caf, #e0a3f0)",
  // h1's underline: a pale h1.
  h1Rule: "light-dark(#e9effc, #1f2a46)",
  // Alerts: the colour of the icon, title and border, and the box's tint (the colour at 8%). The
  // light halves are GitHub's, darkened so the title clears 4.5:1 on its tint over the post's
  // tint frame.
  note: "light-dark(#0858b8, #4493f8)",
  noteBorder: "light-dark(rgb(8 88 184 / 0.35), rgb(68 147 248 / 0.35))",
  noteBg: "light-dark(rgb(8 88 184 / 0.08), rgb(68 147 248 / 0.08))",
  tip: "light-dark(#166e30, #3fb950)",
  tipBorder: "light-dark(rgb(22 110 48 / 0.35), rgb(63 185 80 / 0.35))",
  tipBg: "light-dark(rgb(22 110 48 / 0.08), rgb(63 185 80 / 0.08))",
  important: "light-dark(#7340c9, #ab7df8)",
  importantBorder: "light-dark(rgb(115 64 201 / 0.35), rgb(171 125 248 / 0.35))",
  importantBg: "light-dark(rgb(115 64 201 / 0.08), rgb(171 125 248 / 0.08))",
  warning: "light-dark(#875a00, #d29922)",
  warningBorder: "light-dark(rgb(135 90 0 / 0.35), rgb(210 153 34 / 0.35))",
  warningBg: "light-dark(rgb(135 90 0 / 0.08), rgb(210 153 34 / 0.08))",
  caution: "light-dark(#b81e29, #f85149)",
  cautionBorder: "light-dark(rgb(184 30 41 / 0.35), rgb(248 81 73 / 0.35))",
  cautionBg: "light-dark(rgb(184 30 41 / 0.08), rgb(248 81 73 / 0.08))",
  // Bullets and list numbers.
  bullet: "light-dark(#c2410c, #ff966c)",
  muted: "light-dark(#59636e, #8b949e)",
  // An issue reference's state colour: the app's open, done and not-planned, darkened in light
  // mode so the text (weight 550) clears 4.5:1 on the tint frame and on every alert tint over it
  // (lowest: refNotPlanned 4.97 on cautionBg; dark lowest: refDone 4.83 on tipBg).
  refOpen: "light-dark(#166e30, #3fb950)",
  refDone: "light-dark(#7340c9, #a371f7)",
  refNotPlanned: "light-dark(#59636e, #8b949e)",
  line: "light-dark(#d8dee4, #30363d)",
  link: "light-dark(#0b62c4, #6cb6ff)",
  quote: "light-dark(#57606a, #9da7b3)",
  // Inline code.
  codeBg: "light-dark(#e6e9ee, #262b35)",
  codeFg: "light-dark(#24292f, #c9d1d9)",
  // A code block's header bar; the block itself takes the page's background inside a post.
  codeHead: "light-dark(#f6f8fa, #14171c)",
  tableLine: "light-dark(#d0d7de, #3b4261)",
  // Every other table row.
  zebra: "light-dark(#f6f8fa, #1a1f29)",
  mentionBg: "light-dark(#ddf4ff, #12263f)",
  // The tint frame: each post's surface.
  tint: "light-dark(#f5f6f8, #14161b)",
});

/**
 * highlight.js's token kinds, colour only (GitHub's light and dark highlight colours, as the
 * prototype had them): anything else stays the code's own colour.
 */
export const hl = stylex.defineVars({
  keyword: "light-dark(#cf222e, #ff7b72)",
  string: "light-dark(#0a3069, #a5d6ff)",
  number: "light-dark(#0550ae, #79c0ff)",
  title: "light-dark(#8250df, #d2a8ff)",
  type: "light-dark(#953800, #ffa657)",
  // #6e7781 is 4.55:1 on white, so only on a code block's page background; on the tint frame
  // (4.20) it would fail.
  comment: "light-dark(#6e7781, #8b949e)",
  attr: "light-dark(#0550ae, #79c0ff)",
});

/**
 * A code block's language dot: GitHub's linguist colour for the language, lightened in dark mode
 * where linguist's is too dark to see on a dark page (C, Less, Lua, Markdown, WebAssembly). One
 * per language the code header names (./code.ts).
 */
export const lang = stylex.defineVars({
  bash: "light-dark(#89e051, #89e051)",
  c: "light-dark(#555555, #a0a0a0)",
  cpp: "light-dark(#f34b7d, #f34b7d)",
  csharp: "light-dark(#178600, #2fb21a)",
  css: "light-dark(#663399, #a87fd6)",
  diff: "light-dark(#41b883, #41b883)",
  go: "light-dark(#00add8, #00add8)",
  graphql: "light-dark(#e10098, #e10098)",
  html: "light-dark(#e34c26, #e34c26)",
  ini: "light-dark(#d1dbe0, #d1dbe0)",
  java: "light-dark(#b07219, #b07219)",
  javascript: "light-dark(#f1e05a, #f1e05a)",
  json: "light-dark(#cbcb41, #cbcb41)",
  kotlin: "light-dark(#a97bff, #a97bff)",
  less: "light-dark(#1d365d, #5b82bd)",
  lua: "light-dark(#000080, #6b7cff)",
  makefile: "light-dark(#427819, #6aa83a)",
  markdown: "light-dark(#083fa1, #5b8be0)",
  objectivec: "light-dark(#438eff, #438eff)",
  perl: "light-dark(#0298c3, #0298c3)",
  php: "light-dark(#4f5d95, #8892bf)",
  python: "light-dark(#3572a5, #5a9bd5)",
  r: "light-dark(#198ce7, #198ce7)",
  ruby: "light-dark(#701516, #c2464a)",
  rust: "light-dark(#dea584, #dea584)",
  scss: "light-dark(#c6538c, #c6538c)",
  sql: "light-dark(#e38c00, #e38c00)",
  svg: "light-dark(#ff9900, #ff9900)",
  swift: "light-dark(#f05138, #f05138)",
  toml: "light-dark(#9c4221, #d06a3e)",
  typescript: "light-dark(#3178c6, #3178c6)",
  vbnet: "light-dark(#945db7, #945db7)",
  wasm: "light-dark(#04133b, #6c7fd0)",
  xml: "light-dark(#0060ac, #3d8fd6)",
  yaml: "light-dark(#cb171e, #e8474d)",
});
