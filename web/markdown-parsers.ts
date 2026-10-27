// The packages that parse Markdown or sanitise HTML: no chunk of the web app may bundle one
// (vite.config.ts's noMarkdownParser). The server renders Markdown to an AST and sanitises it
// (crates/md-ast); the browser only walks the AST (src/md/walker.ts).
//
// A curated list, matched on the whole package name: a name that merely contains "markdown" or
// "sanitize" (sanitize-filename) isn't one. An entry ending in `*` takes every package whose name
// starts with what comes before it: a family (`remark-*`) or a scope (`@mdx-js/*`).

const PARSERS: readonly string[] = [
  // Markdown parsers and their plugin families.
  "marked",
  "marked-*",
  "markdown-it",
  "markdown-it-*",
  "micromark",
  "micromark-*",
  "mdast-util-*",
  "remark",
  "remark-*",
  "rehype",
  "rehype-*",
  "unified",
  "commonmark",
  "showdown",
  "snarkdown",
  "remarkable",
  "markdown-to-jsx",
  "solid-markdown",
  "@lezer/markdown",
  "@codemirror/lang-markdown",
  "@mdx-js/*",
  // HTML parsers and sanitisers.
  "parse5",
  "parse5-*",
  "htmlparser2",
  "hast-util-sanitize",
  "hast-util-from-html",
  "dompurify",
  "isomorphic-dompurify",
  "sanitize-html",
  "xss",
];

/**
 * The parser or sanitiser package module `id` belongs to (the innermost `node_modules` entry on
 * its path), or undefined.
 */
export function parserIn(id: string): string | undefined {
  const path = id.replace(/\\/g, "/");
  const at = path.lastIndexOf("/node_modules/");
  if (at < 0) return undefined;
  const [first, second] = path.slice(at + "/node_modules/".length).split("/");
  const pkg = first?.startsWith("@") ? `${first}/${second}` : first;
  if (!pkg) return undefined;
  const hit = PARSERS.some((p) => (p.endsWith("*") ? pkg.startsWith(p.slice(0, -1)) : pkg === p));
  return hit ? pkg : undefined;
}
