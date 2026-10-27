// The search's words in the detail: which spans of a title, body or comment the filter bar's
// free text matched, to mark them. The server's index decides what a row matches
// (crates/mirror-db/src/search.rs); this follows the same rules on the text the detail shows: a
// word matches the start of a word, a quoted phrase its words in a row, case folded and Latin
// letters' diacritics too. Words split where the index splits them, at anything that isn't a
// letter or a digit.
// Plain text until Markdown rendering lands (#98); its walker will mark the same spans.
import type { SearchField } from "./bindings/SearchField";
import { tokenize, wordOf } from "./query";

/** One search word: its parts, folded, and whether the last part is a prefix. */
export type Term = { parts: string[]; prefix: boolean };

/** The fields a search looks in (`in:`; none named is all three, as `Fields::searched`). */
export type Fields = Record<SearchField, boolean>;

/**
 * A run of the index's token characters: letters, digits, private use, and the combining marks
 * it folds away (U+0300–U+0331); anything else splits words.
 */
const WORD = /[\p{L}\p{N}\p{Co}\u0300-\u0331]+/gu;

/**
 * Lowercase, and without the diacritics of Latin letters, as `unicode61 remove_diacritics 2`
 * folds: é, ñ, ǖ lose theirs; ø and ß have none to lose; Greek and Cyrillic keep theirs (ά, й).
 * (The index also drops a combining mark typed after a non-Latin letter; text arrives composed.)
 */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/(\p{Script=Latin})[\u0300-\u036f]+/gu, "$1")
    .normalize("NFC")
    .toLowerCase();
}

/** `in:`'s names for the fields, as the server reads them (`comment` too). */
const FIELD_NAMES: Record<string, SearchField> = { title: "title", body: "body", comments: "comments", comment: "comments" };

/**
 * The positive words of a filter-bar query, each as the server reads it (`wordOf`), and the
 * fields they search: no qualifiers, no `-word`s.
 */
export function searchOf(query: string): { terms: Term[]; fields: Fields } {
  const terms: Term[] = [];
  const named: Fields = { title: false, body: false, comments: false };
  for (const t of tokenize(query)) {
    if (t.key === "in") {
      for (const f of (t.value ?? "").toLowerCase().split(",")) {
        const field = FIELD_NAMES[f.trim()];
        if (field) named[field] = true;
      }
      continue;
    }
    const w = wordOf(t.text);
    if (!w || w.exclude) continue;
    const parts = fold(w.text).match(WORD) ?? [];
    if (parts.length > 0) terms.push({ parts, prefix: !w.phrase });
  }
  const any = named.title || named.body || named.comments;
  return { terms, fields: any ? named : { title: true, body: true, comments: true } };
}

/** The spans of `text` the terms match, in order, not overlapping: `[start, end)` pairs. */
export function matchSpans(text: string, terms: Term[]): [number, number][] {
  if (terms.length === 0) return [];
  const words = [...text.matchAll(WORD)].map((m) => ({ at: m.index, end: m.index + m[0].length, w: fold(m[0]) }));
  const out: [number, number][] = [];
  let next = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.at < next) continue;
    for (const t of terms) {
      const n = t.parts.length;
      if (i + n > words.length) continue;
      const ok = t.parts.every((p, k) => {
        const w = words[i + k]!.w;
        return k === n - 1 && t.prefix ? w.startsWith(p) : w === p;
      });
      if (ok) {
        out.push([words[i]!.at, words[i + n - 1]!.end]);
        next = words[i + n - 1]!.end;
        break;
      }
    }
  }
  return out;
}
