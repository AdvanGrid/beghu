// Reading highlight.js's output: `<span class="hljs-…">`s around its own escaped copy of the
// code, read as a tree of text and token spans rather than set as HTML, so nothing but text and
// colour spans can come of it. No DOM and no StyleX here: ./code.ts turns the tree into DOM with
// its classes, and hljs.test.ts feeds it hostile input under plain Node.

/** The colours a token takes; anything else stays the code's own colour. */
export type Kind = "attr" | "comment" | "keyword" | "number" | "string" | "title" | "type";

/** A piece of highlighted code: text, or a span (coloured if it has a kind) around more pieces. */
export type Piece = string | { kind: Kind | undefined; children: Piece[] };

/** Matches one piece of the output, from where the last left off. */
const PIECE = /<span class="([\w -]*)">|<\/span>|&(amp|lt|gt|quot|#x27);|[^<&]+/y;

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'" };

/** highlight.js's output as pieces, or undefined if it holds anything but text and spans. */
export function pieces(html: string): Piece[] | undefined {
  const out: Piece[] = [];
  const open: Piece[][] = [out];
  const re = new RegExp(PIECE);
  while (re.lastIndex < html.length) {
    const at = re.lastIndex;
    const m = re.exec(html);
    if (!m || m.index !== at) return undefined;
    const into = open.at(-1)!;
    if (m[1] !== undefined) {
      const span = { kind: kindOf(m[1]), children: [] };
      into.push(span);
      open.push(span.children);
    } else if (m[0] === "</span>") {
      if (open.length === 1) return undefined;
      open.pop();
    } else into.push(m[2] === undefined ? m[0] : ENTITY[m[2]]!);
  }
  return open.length === 1 ? out : undefined;
}

/** highlight.js's scopes, by the colour each takes. */
const KIND: Record<string, Kind> = {
  keyword: "keyword",
  "selector-tag": "keyword",
  name: "keyword",
  deletion: "keyword",
  string: "string",
  regexp: "string",
  "template-string": "string",
  addition: "string",
  number: "number",
  literal: "number",
  symbol: "number",
  bullet: "number",
  title: "title",
  section: "title",
  type: "type",
  built_in: "type",
  comment: "comment",
  quote: "comment",
  meta: "comment",
  attr: "attr",
  property: "attr",
  attribute: "attr",
  params: "attr",
  "selector-class": "attr",
  "selector-id": "attr",
};

/** The colour a span's classes (`hljs-title function_`) take, if any. */
export function kindOf(cls: string): Kind | undefined {
  const [main = "", ...sub] = cls.split(" ");
  if (!main.startsWith("hljs-")) return undefined;
  const scope = main.slice("hljs-".length);
  if (scope === "title" && sub.includes("class_")) return "type";
  if (scope === "variable" && sub.includes("language_")) return "number";
  return Object.hasOwn(KIND, scope) ? KIND[scope] : undefined;
}

