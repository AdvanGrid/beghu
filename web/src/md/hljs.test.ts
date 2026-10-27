// Reading highlight.js's output (hljs.ts) under hostile input. An allowed exception to testing
// through public seams (AGENTS.md): highlight.js only ever hands the reader its own escaped
// output, so no fixture or browser path can feed it markup to refuse. `npm run test:lint`.
import assert from "node:assert/strict";
import { it } from "node:test";
import { kindOf, pieces, type Piece } from "./hljs.ts";

/** The text a reading shows, spans dropped. */
const text = (list: Piece[]): string => list.map((p) => (typeof p === "string" ? p : text(p.children))).join("");

it("reads highlight.js's spans and entities as coloured text", () => {
  const read = pieces('<span class="hljs-keyword">fn</span> a &lt; b &amp;&amp; <span class="hljs-string">&quot;x&#x27;&gt;</span>');
  assert.ok(read);
  assert.equal(text(read), "fn a < b && \"x'>");
  assert.deepEqual(read[0], { kind: "keyword", children: ["fn"] });
});

it("refuses anything but text and class-only spans", () => {
  for (const html of [
    "<img src=x onerror=alert(1)>",
    '<img src="x" onerror="alert(1)">',
    "</span><script>alert(1)</script>",
    '<span class="hljs-keyword"></span><script>alert(1)</script>',
    '<span class="hljs-keyword" onclick="alert(1)">fn</span>',
    '<span style="color: red">fn</span>',
    '<span class="hljs-keyword"onmouseover="alert(1)">fn</span>',
    '<span class="hljs-keyword" >fn</span>',
    "<SPAN class=\"hljs-keyword\">fn</SPAN>",
    '<a href="javascript:alert(1)">x</a>',
  ]) {
    assert.equal(pieces(html), undefined, html);
  }
});

it("refuses unbalanced spans", () => {
  assert.equal(pieces("a</span>b"), undefined);
  assert.equal(pieces('<span class="hljs-string">a'), undefined);
  assert.equal(pieces('<span class="hljs-string">a</span></span>'), undefined);
});

it("refuses entities highlight.js never writes", () => {
  for (const html of ["&nbsp;", "&#60;script&#62;", "&#x3c;", "&lt", "a & b", "&amp"]) {
    assert.equal(pieces(html), undefined, html);
  }
});

it("keeps a span with a class it doesn't know as plain text", () => {
  assert.deepEqual(pieces('<span class="evil x">a</span>'), [{ kind: undefined, children: ["a"] }]);
});

it("colours only highlight.js's own scopes", () => {
  assert.equal(kindOf("hljs-keyword"), "keyword");
  assert.equal(kindOf("hljs-title function_"), "title");
  assert.equal(kindOf("hljs-title class_"), "type");
  assert.equal(kindOf("hljs-variable language_"), "number");
  assert.equal(kindOf("hljs-variable"), undefined);
  assert.equal(kindOf("keyword"), undefined);
  assert.equal(kindOf("x hljs-keyword"), undefined);
  assert.equal(kindOf(""), undefined);
  for (const inherited of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(kindOf(`hljs-${inherited}`), undefined, inherited);
  }
});
