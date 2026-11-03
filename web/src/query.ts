// The filter bar's text on the client: where its tokens are, which one is still being typed, and
// the query that applies. The server owns the language (crates/server/src/query.rs) and parses
// what the URL's `q` holds; the client only needs the token boundaries, the keys, the sort and
// Match mode, and which words are free text (`wordOf`, as the server reads them).
import type { MatchMode } from "./bindings/MatchMode";

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

/** Whether `query` holds `token` (a `key:value`, in any case). */
export function hasToken(query: string, token: string): boolean {
  const want = token.toLowerCase();
  return tokenize(query).some((t) => t.text.toLowerCase() === want);
}

/**
 * `query` with `token` turned on or off, every other token kept as typed: off drops each copy of
 * it; on drops the tokens it `clashes` with (`is:closed` for `is:open`) and adds it before the sort.
 */
export function withToken(query: string, token: string, on: boolean, clashes: readonly string[] = []): string {
  const drop = new Set([token, ...(on ? clashes : [])].map((x) => x.toLowerCase()));
  const kept = tokenize(query).filter((t) => !drop.has(t.text.toLowerCase()));
  const rest = kept.filter((t) => t.key !== "sort").map((t) => t.text);
  const sorts = kept.filter((t) => t.key === "sort").map((t) => t.text);
  return [...rest, ...(on ? [token] : []), ...sorts].join(" ");
}

/** The Match modes, in the dropdown's order, each with its label. */
export const MATCHES: readonly { value: MatchMode; label: string }[] = [
  { value: "blend", label: "Blend" },
  { value: "best", label: "Best match" },
  { value: "off", label: "Off" },
];

/** A free word as the server reads it (`parse` and `searchable` in query.rs). */
export type Word = { text: string; phrase: boolean; exclude: boolean };

/** A letter or digit, as Rust's `char::is_alphanumeric` has it. */
const ALNUM = /[\p{Alphabetic}\p{N}]/u;

/**
 * The free word a token is, if any: not a qualifier (`-key:value` is a dropped one), and with
 * enough of it to search. A leading `-` excludes; a leading quote makes a phrase; every quote is
 * dropped, so `ab"cd` is `abcd`. A phrase needs two letters or digits in all; a word, a last part
 * of two (split where it isn't a letter or digit), or else it searches the parts before it.
 */
export function wordOf(raw: string): Word | undefined {
  const exclude = raw.startsWith("-") && raw.length > 1;
  const t = exclude ? raw.slice(1) : raw;
  if (/^[A-Za-z]+:/.test(t)) return undefined;
  const phrase = t.startsWith('"');
  const cps = [...t.replace(/"/g, "")];
  if (phrase) return cps.filter((c) => ALNUM.test(c)).length >= 2 ? { text: cps.join(""), phrase, exclude } : undefined;
  let end = cps.length;
  while (end > 0 && !ALNUM.test(cps[end - 1]!)) end--;
  for (;;) {
    let start = end;
    while (start > 0 && ALNUM.test(cps[start - 1]!)) start--;
    if (end - start >= 2) return { text: cps.slice(0, end).join(""), phrase, exclude };
    if (start === 0) return undefined;
    end = start;
    while (end > 0 && !ALNUM.test(cps[end - 1]!)) end--;
  }
}

/** Whether a query has free text to search: a word that isn't a qualifier or an exclusion. */
export function hasText(query: string): boolean {
  return tokenize(query).some((t) => {
    const w = wordOf(t.text);
    return w !== undefined && !w.exclude;
  });
}

/** The Match mode a query asks for: its last valid `match:` token, or Blend. */
export function matchOf(query: string): MatchMode {
  let out: MatchMode = "blend";
  for (const t of tokenize(query)) {
    const v = t.key === "match" ? t.value?.toLowerCase() : undefined;
    if (MATCHES.some((m) => m.value === v)) out = v as MatchMode;
  }
  return out;
}

/** Whether Blend can order a query's sort: it needs a descending time sort (`rank::mode`). */
export function blendFits(query: string): boolean {
  const s = sortOf(query);
  return !s.asc && s.key !== "comments";
}

/** The Match mode that runs for a query: the one it asks for, but Best for a Blend that can't. */
export function effectiveMatch(query: string): MatchMode {
  const m = matchOf(query);
  return m === "blend" && !blendFits(query) ? "best" : m;
}

/** `query` with its `match:` tokens replaced by `match` (none for the default). */
export function withMatch(query: string, match: MatchMode): string {
  const rest = tokenize(query)
    .filter((t) => t.key !== "match")
    .map((t) => t.text);
  if (match !== "blend") rest.push(`match:${match}`);
  return rest.join(" ");
}

/** How the list shows its view: rows, or Tree mode's sub-issues nested under their parents. */
export type Mode = "list" | "tree";

/** The URL's mode: `?mode=tree`, or the list. */
export function modeOf(search: string): Mode {
  return new URLSearchParams(search).get("mode") === "tree" ? "tree" : "list";
}

/** `search` with the mode set to `mode`: the list is the default, so it drops `mode`. */
export function withMode(search: string, mode: Mode): string {
  const p = new URLSearchParams(search);
  if (mode === "tree") p.set("mode", "tree");
  else p.delete("mode");
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Set by the List | Tree toggle as it switches: the view that opens next keeps the selection. */
let switching = false;

/** The toggle is switching the view's mode. */
export function markModeSwitch(): void {
  switching = true;
}

/** Whether the mode was just switched (the toggle), once: the view that asks takes it. */
export function takeModeSwitch(): boolean {
  const was = switching;
  switching = false;
  return was;
}
