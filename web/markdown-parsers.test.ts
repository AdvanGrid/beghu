// The build's Markdown-parser check (markdown-parsers.ts): which modules count as a Markdown
// parser or HTML sanitiser. `npm run test:lint`.
import assert from "node:assert/strict";
import { it } from "node:test";
import { parserIn } from "./markdown-parsers.ts";

const mod = (pkg: string, file = "dist/index.js") => `/app/node_modules/${pkg}/${file}`;

it("finds Markdown parsers and HTML sanitisers, scoped ones too", () => {
  for (const pkg of [
    "marked",
    "marked-highlight",
    "markdown-it",
    "markdown-it-anchor",
    "micromark",
    "micromark-extension-gfm",
    "mdast-util-from-markdown",
    "remark",
    "remark-gfm",
    "rehype-sanitize",
    "unified",
    "hast-util-sanitize",
    "dompurify",
    "isomorphic-dompurify",
    "sanitize-html",
    "xss",
    "commonmark",
    "showdown",
    "snarkdown",
    "@lezer/markdown",
    "@codemirror/lang-markdown",
    "@mdx-js/mdx",
    "@mdx-js/react",
    "parse5",
    "htmlparser2",
  ]) {
    assert.equal(parserIn(mod(pkg)), pkg, pkg);
  }
  // The package that holds the module, however deep the node_modules nest; and Windows paths.
  assert.equal(parserIn("/app/node_modules/foo/node_modules/parse5/dist/index.js"), "parse5");
  assert.equal(parserIn("C:\\app\\node_modules\\@lezer\\markdown\\dist\\index.js"), "@lezer/markdown");
});

it("leaves other packages alone, whatever their names hold", () => {
  for (const pkg of ["sanitize-filename", "solid-js", "@solidjs/router", "@stylexjs/stylex", "markdown-table-formatter-x", "remarkable-x"]) {
    assert.equal(parserIn(mod(pkg)), undefined, pkg);
  }
  // A module of the app's own, or a file in another package that only mentions Markdown.
  assert.equal(parserIn("/app/src/md/walker.ts"), undefined);
  assert.equal(parserIn(mod("solid-js", "markdown.js")), undefined);
});
