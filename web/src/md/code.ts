// Fenced code blocks: the box, a header bar naming a labelled block's language (code icon,
// linguist dot, name), and highlighting.
//
// highlight.js colours a block once its language's code has loaded: its core and that one
// language, each a chunk of its own, loaded the first time a block needs them. Only highlight.js's
// common set is known (with its aliases, below); a block in any other language, or with no label,
// stays plain and loads nothing, and nothing is guessed. Its token kinds map to colour-only
// StyleX classes, so a block takes its colours in place: same text, same box, nothing moves. A
// language whose code fails to load leaves its blocks plain; the next block that needs it tries
// again.
import * as stylex from "@stylexjs/stylex";
import type { HLJSApi, LanguageFn } from "highlight.js";
import { colors, fonts } from "../tokens.stylex";
import { type Kind, type Piece, pieces } from "./hljs";
import { icon } from "./icons";
import { hl, lang, md } from "./tokens.stylex";

type Chunk = () => Promise<{ default: LanguageFn }>;

/**
 * highlight.js's common set, a chunk per language, by its name there. Plain text (`text`,
 * `txt`, `plaintext`) isn't here: it would load code to colour nothing.
 */
const LANGUAGES: Record<string, Chunk> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  "php-template": () => import("highlight.js/lib/languages/php-template"),
  python: () => import("highlight.js/lib/languages/python"),
  "python-repl": () => import("highlight.js/lib/languages/python-repl"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  shell: () => import("highlight.js/lib/languages/shell"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  vbnet: () => import("highlight.js/lib/languages/vbnet"),
  wasm: () => import("highlight.js/lib/languages/wasm"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

/**
 * Labels that name a language by another name: highlight.js's own aliases for the common set
 * (each language declares its own, which can't be read before its chunk loads). One departure:
 * `shell` is a shell script, as on GitHub, not highlight.js's session with prompts (`console`).
 */
const ALIASES: Record<string, string> = {
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  h: "c",
  cc: "cpp",
  "c++": "cpp",
  "h++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cxx: "cpp",
  cs: "csharp",
  "c#": "csharp",
  patch: "diff",
  golang: "go",
  gql: "graphql",
  toml: "ini",
  jsp: "java",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsonc: "json",
  json5: "json",
  kt: "kotlin",
  kts: "kotlin",
  ktm: "kotlin",
  ktx: "kotlin",
  pluto: "lua",
  mk: "makefile",
  mak: "makefile",
  make: "makefile",
  md: "markdown",
  mkdown: "markdown",
  mkd: "markdown",
  mm: "objectivec",
  objc: "objectivec",
  "obj-c": "objectivec",
  "obj-c++": "objectivec",
  "objective-c++": "objectivec",
  pl: "perl",
  pm: "perl",
  py: "python",
  gyp: "python",
  ipython: "python",
  pycon: "python-repl",
  rb: "ruby",
  gemspec: "ruby",
  podspec: "ruby",
  thor: "ruby",
  irb: "ruby",
  rs: "rust",
  console: "shell",
  shellsession: "shell",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  vb: "vbnet",
  html: "xml",
  xhtml: "xml",
  rss: "xml",
  atom: "xml",
  xjb: "xml",
  xsd: "xml",
  xsl: "xml",
  plist: "xml",
  wsf: "xml",
  svg: "xml",
  yml: "yaml",
};

/** Languages that colour parts of themselves as another: that one loads with them. */
const NEEDS: Record<string, string[]> = {
  shell: ["bash"],
  "python-repl": ["python"],
  "php-template": ["php", "xml"],
};

/** The common-set language a block labelled `label` is in, or undefined. */
function languageOf(label: string): string | undefined {
  const l = label.toLowerCase();
  const name = ALIASES[l] ?? l;
  return Object.hasOwn(LANGUAGES, name) ? name : undefined;
}

/** The header's name for a label: the language's, or the label as written. */
const NAMES: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  graphql: "GraphQL",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  less: "Less",
  lua: "Lua",
  makefile: "Makefile",
  markdown: "Markdown",
  objectivec: "Objective-C",
  perl: "Perl",
  php: "PHP",
  "php-template": "PHP",
  python: "Python",
  "python-repl": "Python",
  r: "R",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  shell: "Console",
  sql: "SQL",
  swift: "Swift",
  typescript: "TypeScript",
  vbnet: "Visual Basic .NET",
  wasm: "WebAssembly",
  xml: "XML",
  yaml: "YAML",
};

/** Labels named apart from their language. */
const LABEL_NAMES: Record<string, string> = {
  html: "HTML",
  jsx: "JSX",
  sh: "Shell",
  shell: "Shell",
  svg: "SVG",
  toml: "TOML",
  tsx: "TSX",
};

function nameOf(label: string): string {
  const l = label.toLowerCase();
  if (Object.hasOwn(LABEL_NAMES, l)) return LABEL_NAMES[l]!;
  const language = languageOf(l);
  return language === undefined ? label : NAMES[language]!;
}

const dot = stylex.create({
  bash: { backgroundColor: lang.bash },
  c: { backgroundColor: lang.c },
  cpp: { backgroundColor: lang.cpp },
  csharp: { backgroundColor: lang.csharp },
  css: { backgroundColor: lang.css },
  diff: { backgroundColor: lang.diff },
  go: { backgroundColor: lang.go },
  graphql: { backgroundColor: lang.graphql },
  html: { backgroundColor: lang.html },
  ini: { backgroundColor: lang.ini },
  java: { backgroundColor: lang.java },
  javascript: { backgroundColor: lang.javascript },
  json: { backgroundColor: lang.json },
  kotlin: { backgroundColor: lang.kotlin },
  less: { backgroundColor: lang.less },
  lua: { backgroundColor: lang.lua },
  makefile: { backgroundColor: lang.makefile },
  markdown: { backgroundColor: lang.markdown },
  // A language the header doesn't know.
  none: { backgroundColor: md.muted },
  objectivec: { backgroundColor: lang.objectivec },
  perl: { backgroundColor: lang.perl },
  php: { backgroundColor: lang.php },
  python: { backgroundColor: lang.python },
  r: { backgroundColor: lang.r },
  ruby: { backgroundColor: lang.ruby },
  rust: { backgroundColor: lang.rust },
  scss: { backgroundColor: lang.scss },
  sql: { backgroundColor: lang.sql },
  svg: { backgroundColor: lang.svg },
  swift: { backgroundColor: lang.swift },
  toml: { backgroundColor: lang.toml },
  typescript: { backgroundColor: lang.typescript },
  vbnet: { backgroundColor: lang.vbnet },
  wasm: { backgroundColor: lang.wasm },
  xml: { backgroundColor: lang.xml },
  yaml: { backgroundColor: lang.yaml },
});

/** The dot's colour for a label: its own (html, svg, toml), else its language's. */
function dotOf(label: string): stylex.StyleXStyles {
  const l = label.toLowerCase();
  const key = l === "html" || l === "svg" || l === "toml" ? l : languageOf(l);
  const by: Record<string, keyof typeof dot> = { shell: "bash", "python-repl": "python", "php-template": "php" };
  const k = key === undefined ? "none" : (by[key] ?? key);
  return Object.hasOwn(dot, k) ? dot[k as keyof typeof dot] : dot.none;
}

/**
 * A fenced code block's box: with a header naming the language when it's labelled, and the `pre`
 * its text goes in.
 */
export function codeBlock(label: string | undefined): { box: HTMLElement; pre: HTMLElement } {
  const box = document.createElement("div");
  box.className = stylex.props(s.box).className ?? "";
  if (label) {
    const head = document.createElement("div");
    head.className = stylex.props(s.head).className ?? "";
    head.dataset.perf = "code-head";
    const d = document.createElement("span");
    d.className = stylex.props(s.dot, dotOf(label)).className ?? "";
    const name = document.createElement("span");
    name.textContent = nameOf(label);
    head.append(icon("code"), d, name);
    box.append(head);
  }
  const pre = document.createElement("pre");
  pre.className = stylex.props(s.pre).className ?? "";
  box.append(pre);
  return { box, pre };
}

let core: Promise<HLJSApi> | undefined;
const languages = new Map<string, Promise<HLJSApi>>();

/** highlight.js's core, loading it the first time; a failed load is forgotten. */
function loadCore(): Promise<HLJSApi> {
  core ??= import("highlight.js/lib/core").then(
    (m) => m.default,
    (e: unknown) => {
      core = undefined;
      throw e;
    },
  );
  return core;
}

/** `name` and the languages it needs, registered with the core; a failed load is forgotten. */
function loadLanguage(name: string): Promise<HLJSApi> {
  let p = languages.get(name);
  if (!p) {
    p = Promise.all([loadCore(), LANGUAGES[name]!(), ...(NEEDS[name] ?? []).map(loadLanguage)]).then(
      ([h, l]) => {
        h.registerLanguage(name, l.default);
        return h;
      },
      (e: unknown) => {
        languages.delete(name);
        throw e;
      },
    );
    languages.set(name, p);
  }
  return p;
}

/**
 * Colours `code` (a block's text, labelled `label`) once its language has loaded. An unknown
 * language does nothing; so does a load that fails, leaving the block plain. A block a search
 * marked stays plain too: the marks say why the issue matched.
 */
export function highlight(code: HTMLElement, label: string): void {
  const name = languageOf(label);
  if (name === undefined) return;
  loadLanguage(name).then(
    (h) => {
      if (code.querySelector("mark")) return;
      const text = code.textContent ?? "";
      const coloured = tokens(h.highlight(text, { language: name, ignoreIllegals: true }).value);
      // Only ever the same text, coloured: anything else and the block stays as it was.
      if (coloured?.textContent === text) code.replaceChildren(coloured);
    },
    () => {},
  );
}

/**
 * highlight.js's output as DOM with StyleX classes, or undefined if it holds anything but text
 * and spans (./hljs.ts reads it).
 */
function tokens(html: string): DocumentFragment | undefined {
  const read = pieces(html);
  if (read === undefined) return undefined;
  const out = document.createDocumentFragment();
  const build = (into: ParentNode, list: Piece[]): void => {
    for (const piece of list) {
      if (typeof piece === "string") {
        into.append(piece);
        continue;
      }
      const span = document.createElement("span");
      if (piece.kind) span.className = TOKEN_CLASS[piece.kind];
      build(span, piece.children);
      into.append(span);
    }
  };
  build(out, read);
  return out;
}

const tok = stylex.create({
  attr: { color: hl.attr },
  comment: { color: hl.comment },
  keyword: { color: hl.keyword },
  number: { color: hl.number },
  string: { color: hl.string },
  title: { color: hl.title },
  type: { color: hl.type },
});

/** Each token kind's class, as the spans take it. */
const TOKEN_CLASS: Record<Kind, string> = {
  attr: stylex.props(tok.attr).className ?? "",
  comment: stylex.props(tok.comment).className ?? "",
  keyword: stylex.props(tok.keyword).className ?? "",
  number: stylex.props(tok.number).className ?? "",
  string: stylex.props(tok.string).className ?? "",
  title: stylex.props(tok.title).className ?? "",
  type: stylex.props(tok.type).className ?? "",
};
const s = stylex.create({
  box: {
    borderColor: md.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    overflow: "hidden",
    backgroundColor: colors.bg,
    // Flush with its post (or list item, alert…) when it comes last: walker.ts's LAST, spelled
    // out because StyleX reads each module's values on its own.
    marginBottom: { default: "0.7em", ":last-child": 0 },
  },
  head: {
    gap: 6,
    paddingBlock: 3,
    paddingInline: 10,
    alignItems: "center",
    backgroundColor: md.codeHead,
    color: md.muted,
    display: "flex",
    fontSize: 11.5,
    borderBottomColor: md.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
  },
  dot: {
    borderRadius: "50%",
    flexShrink: 0,
    height: 8,
    width: 8,
  },
  // A block's text: the pre's font, not inline code's.
  code: {
    fontFamily: "inherit",
    fontSize: "inherit",
  },
  pre: {
    margin: 0,
    paddingBlock: 8,
    paddingInline: 12,
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: 1.5,
    whiteSpace: "pre",
    overflowX: "auto",
  },
});

/** The style of the `code` inside a block's `pre`. */
export const inBlock = s.code;
