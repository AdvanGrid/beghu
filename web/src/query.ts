// The filter bar's text on the client: where its tokens are, which one is still being typed, and
// the query that applies. The server owns the language (crates/server/src/query.rs) and parses
// what the URL's `q` holds; the client only needs the token boundaries, the keys, and the sort.

/** The view when the URL has no `q`: the Open preset (the server's `query::DEFAULT`). */
export const DEFAULT_QUERY = "is:open";

export type Token = {
  /** The token as typed, quotes included. */
  text: string;
  start: number;
  end: number;
  /** For `key:value`: the key, lowercased, and the value without quotes. */
  key?: string;
  value?: string;
};

/** The bar's tokens: split on whitespace outside double quotes. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let start = -1;
  let quoted = false;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    const space = c === undefined || (/\s/.test(c) && !quoted);
    if (space && start >= 0) {
      out.push(token(text.slice(start, i), start, i));
      start = -1;
    } else if (!space && start < 0) start = i;
  }
  return out;
}

function token(text: string, start: number, end: number): Token {
  const m = /^([A-Za-z]+):(.*)$/s.exec(text);
  if (!m) return { text, start, end };
  return { text, start, end, key: m[1]!.toLowerCase(), value: m[2]!.replace(/^"|"$/g, "") };
}

/** The token the caret touches (inside it or at its end), if any. */
export function tokenAt(text: string, caret: number): Token | undefined {
  return tokenize(text).find((t) => t.start <= caret && caret <= t.end);
}

/**
 * The query that applies while the user types: everything but a `key:value` token the caret is
 * still in, so a half-typed qualifier never filters. Free words apply as they're typed. Pass no
 * caret once the text is committed (Enter, a pick, leaving the box).
 */
export function applied(text: string, caret?: number): string {
  return tokenize(text)
    .filter((t) => !(t.key !== undefined && caret !== undefined && t.start <= caret && caret <= t.end))
    .map((t) => t.text)
    .join(" ");
}

/** A value as the bar writes it: quoted when it holds a space. */
export function quote(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}

/** The URL's query: `q`, or the Open preset when there's none. */
export function queryOf(search: string): string {
  return new URLSearchParams(search).get("q") ?? DEFAULT_QUERY;
}

/** `search` with `q` set to `query`. */
export function withQuery(search: string, query: string): string {
  const p = new URLSearchParams(search);
  p.set("q", query);
  return `?${p}`;
}

export type SortValue = `${SortKey}` | `${SortKey}-asc`;
export type SortKey = "updated" | "created" | "closed" | "commented" | "comments";

const SORT_KEYS: readonly SortKey[] = ["updated", "created", "closed", "commented", "comments"];

/** The sorts, in the dropdown's order, each with its label. */
export const SORTS: readonly { value: SortValue; label: string }[] = [
  { value: "updated", label: "Recently updated" },
  { value: "updated-asc", label: "Least recently updated" },
  { value: "created", label: "Newest" },
  { value: "created-asc", label: "Oldest" },
  { value: "closed", label: "Recently closed" },
  { value: "closed-asc", label: "Least recently closed" },
  { value: "commented", label: "Recently commented" },
  { value: "commented-asc", label: "Least recently commented" },
  { value: "comments", label: "Most commented" },
  { value: "comments-asc", label: "Least commented" },
];

/** The sort a query asks for: its last valid `sort:` token, or `updated`. */
export function sortOf(query: string): { key: SortKey; asc: boolean } {
  let out: { key: SortKey; asc: boolean } = { key: "updated", asc: false };
  for (const t of tokenize(query)) {
    if (t.key !== "sort" || !t.value) continue;
    const v = t.value.toLowerCase();
    const asc = v.endsWith("-asc");
    const name = v.replace(/-(asc|desc)$/, "");
    if ((SORT_KEYS as readonly string[]).includes(name)) out = { key: name as SortKey, asc };
  }
  return out;
}

/** The sort a query asks for, as the dropdown names it. */
export function sortValueOf(query: string): SortValue {
  const s = sortOf(query);
  return s.asc ? `${s.key}-asc` : s.key;
}

/** `query` with its `sort:` tokens replaced by `sort` (none for the default). */
export function withSort(query: string, sort: SortValue): string {
  const rest = tokenize(query)
    .filter((t) => t.key !== "sort")
    .map((t) => t.text);
  if (sort !== "updated") rest.push(`sort:${sort}`);
  return rest.join(" ");
}

/** Two queries mean the same view, sort aside: the same tokens in any order and case. */
export function sameFilters(a: string, b: string): boolean {
  const set = (q: string) =>
    tokenize(q)
      .filter((t) => t.key !== "sort")
      .map((t) => t.text.toLowerCase())
      .sort()
      .join(" ");
  return set(a) === set(b);
}
