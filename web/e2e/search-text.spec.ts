// The detail marks a search's words as the server's index matches them (`unicode61
// remove_diacritics 2`, crates/mirror-db/src/search.rs), and the filter bar knows a query has
// free text when the server would search it (crates/server/src/query.rs). Checked on the
// client's own functions, without a browser: the expectations are what SQLite's tokenizer and
// the server's parser do.
import { expect, test } from "@playwright/test";
import { matchSpans, searchOf } from "../src/highlight";
import { hasText } from "../src/query";

/** The words of `text` that `query` marks. */
const marked = (query: string, text: string) => matchSpans(text, searchOf(query).terms).map(([a, b]) => text.slice(a, b));

test("diacritics fold on Latin letters only, as the index folds them", () => {
  expect(marked("cafe", "Café cafe CAFÉ")).toEqual(["Café", "cafe", "CAFÉ"]);
  expect(marked("CRÈME", "creme crème")).toEqual(["creme", "crème"]);
  // Cyrillic: й isn't и.
  expect(marked("йо", "Йогурт иогурт")).toEqual(["Йогурт"]);
  expect(marked("ио", "Йогурт иогурт")).toEqual(["иогурт"]);
  // Greek: the tonos stays.
  expect(marked("άλ", "Άλφα άλφα αλφα")).toEqual(["Άλφα", "άλφα"]);
  expect(marked("αλ", "άλφα αλφα")).toEqual(["αλφα"]);
  // ø and ß are letters of their own.
  expect(marked("sø", "Søren soren")).toEqual(["Søren"]);
  expect(marked("so", "Søren soren")).toEqual(["soren"]);
  expect(marked("straß", "Straße strasse")).toEqual(["Straße"]);
  expect(marked("strass", "Straße strasse")).toEqual(["strasse"]);
});

test("a quote inside a word joins it, as the server reads it", () => {
  expect(marked('ab"cd', "abcd abcde ab cd")).toEqual(["abcd", "abcde"]);
  expect(hasText('ab"cd')).toBe(true);
  expect(hasText('a"b')).toBe(true);
});

test("a query has free text when the server would search some of it", () => {
  // A phrase needs two letters or digits in all, not in a row.
  expect(hasText('"a b"')).toBe(true);
  expect(hasText('"a"')).toBe(false);
  // A word needs a part of two.
  expect(hasText("ab")).toBe(true);
  expect(hasText("a-b")).toBe(false);
  expect(hasText("x-ray")).toBe(true);
  // Exclusions and qualifiers don't rank.
  expect(hasText("-word")).toBe(false);
  expect(hasText("is:open label:bug")).toBe(false);
});
