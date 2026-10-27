// The filter bar's suggestions: what to offer for the token being typed, the counts beside a
// value list that stays open, and the popover that shows them. Loaded on demand (the bar asks
// for this module when the box takes focus), so none of it is in the first load.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, latest, onSettled, Show } from "solid-js";
import { forgetFailure, getFacetCounts, readThen, type Facet, type Facets } from "./api";
import { LabelDot } from "./IssueList";
import { onPush } from "./live";
import { MATCHES, quote, SORTS, tokenAt, tokenize } from "./query";
import { colors, fonts } from "./tokens.stylex";

/** A value list must stay open this long before its counts are fetched. */
export const COUNTS_AFTER_MS = 400;

/** The keys the bar knows, with what each does. */
const KEYS: { key: string; hint: string }[] = [
  { key: "is", hint: "open, closed, pr, any" },
  { key: "label", hint: "has every label" },
  { key: "assignee", hint: "assigned to every one" },
  { key: "author", hint: "opened by any" },
  { key: "repo", hint: "in any repo" },
  { key: "milestone", hint: "in any milestone" },
  { key: "type", hint: "issue type: any of" },
  { key: "no", hint: "label, assignee, milestone" },
  { key: "sort", hint: "updated, created, closed, …" },
  { key: "in", hint: "search title, body, comments" },
  { key: "match", hint: "blend, best, off" },
];

/** Fixed values, for the keys that take a closed set. */
const FIXED: Record<string, { value: string; hint: string }[]> = {
  is: [
    { value: "open", hint: "open" },
    { value: "closed", hint: "closed" },
    { value: "issue", hint: "issues (the default)" },
    { value: "pr", hint: "pull requests" },
    { value: "any", hint: "issues and pull requests" },
  ],
  no: [
    { value: "label", hint: "no labels" },
    { value: "assignee", hint: "nobody assigned" },
    { value: "milestone", hint: "no milestone" },
  ],
  sort: SORTS.map((s) => ({ value: s.value, hint: s.label })),
  in: [
    { value: "title", hint: "search titles" },
    { value: "body", hint: "search descriptions" },
    { value: "comments", hint: "search comments" },
  ],
  match: MATCHES.map((m) => ({ value: m.value, hint: m.label })),
};

type Suggestion = {
  /** What it puts in place of the token being typed. */
  insert: string;
  /** A finished `key:value`, applied at once; otherwise a key to go on typing after. */
  done: boolean;
  hint?: string;
  color?: string;
  facet?: Facet;
  value?: string;
};

const MAX = 8;

/** The values a facet suggests, from `/api/facets`. */
function facetValues(f: Facets | undefined, facet: Facet): { value: string; color?: string }[] {
  if (!f) return [];
  switch (facet) {
    case "label":
      return f.labels.map((l) => ({ value: l.name, color: l.color }));
    case "assignee":
      return [{ value: "me" }, ...f.assignees.map((value) => ({ value }))];
    case "author":
      return [{ value: "me" }, ...f.authors.map((value) => ({ value }))];
    case "repo":
      return f.repos.map((value) => ({ value }));
    case "milestone":
      return f.milestones.map((value) => ({ value }));
    case "type":
      return f.types.map((value) => ({ value }));
  }
}

const FACETS: readonly Facet[] = ["label", "repo", "assignee", "author", "milestone", "type"];
const isFacet = (k: string | undefined): k is Facet => (FACETS as readonly string[]).includes(k ?? "");

/** Values starting with `typed` first, then those containing it. */
function matching<T extends { value: string }>(items: T[], typed: string): T[] {
  const t = typed.toLowerCase();
  const starts = items.filter((i) => i.value.toLowerCase().startsWith(t));
  const contains = items.filter((i) => !i.value.toLowerCase().startsWith(t) && i.value.toLowerCase().includes(t));
  return [...starts, ...contains];
}

/** What the bar reads back from its suggestions once they've loaded. */
export type SuggestionsControl = {
  open: () => boolean;
  /** The highlighted option's element id, for `aria-activedescendant`. */
  active: () => string | undefined;
  /** Handles a key pressed in the box, if it's one for the list; true if it did. */
  key: (e: KeyboardEvent) => boolean;
};

export function Suggestions(props: {
  text: string;
  caret: number;
  /** The query that applies now: counts are for this view. */
  current: string;
  focused: boolean;
  dismissed: boolean;
  dismiss: () => void;
  /** `/api/facets`, which the bar fetches at load (the shell preloads it). */
  facets: Facets | undefined;
  facetsFailed: boolean;
  retryFacets: () => void;
  /** Puts `insert` in place of the token being typed; `done` applies it. */
  pick: (insert: string, done: boolean) => void;
  expose: (control: SuggestionsControl) => void;
}) {
  const [active, setActive] = createSignal(0);
  const [counts, setCounts] = createSignal<Record<string, Map<string, number>>>({});
  // The box as it is now. Typing navigates, and while the new view loads its writes are held:
  // `props.text` would still be the text from before (the click that put `?q=is:open` in the URL,
  // say), and a quick Enter would take a value from that old list and drop the typed word.
  const text = () => latest(() => props.text);
  const caret = () => latest(() => props.caret);
  // Typing starts the highlight over at the top.
  createEffect(
    () => text(),
    () => void setActive(0),
  );

  const live = createMemo(() => tokenAt(text(), caret()));

  const suggestions = createMemo<Suggestion[]>(() => {
    const t = live();
    const f = props.facets;
    const present = new Set(
      tokenize(text())
        .filter((x) => x.start !== t?.start)
        .map((x) => x.text.toLowerCase()),
    );
    const fresh = (s: Suggestion) => !present.has(s.insert.toLowerCase());
    if (t?.key !== undefined) {
      const key = t.key;
      const typed = t.value ?? "";
      if (isFacet(key)) {
        return matching(facetValues(f, key), typed)
          .map((v) => ({ insert: `${key}:${quote(v.value)}`, done: true, color: v.color, facet: key, value: v.value }))
          .filter(fresh)
          .slice(0, MAX);
      }
      return matching(FIXED[key] ?? [], typed)
        .map((v) => ({ insert: `${key}:${v.value}`, done: true, hint: v.hint }))
        .filter(fresh)
        .slice(0, MAX);
    }
    const word = t?.text ?? "";
    const keys = KEYS.filter((k) => k.key.startsWith(word.toLowerCase())).map((k) => ({
      insert: `${k.key}:`,
      done: false,
      hint: k.hint,
    }));
    if (!word) return keys;
    // A plain word also matches values across every facet, so "bug" offers label:bug.
    const across = FACETS.flatMap((facet) =>
      matching(facetValues(f, facet), word)
        .filter((v) => v.value !== "me")
        .map((v) => ({ insert: `${facet}:${quote(v.value)}`, done: true, color: v.color, facet, value: v.value })),
    ).filter(fresh);
    return [...keys.slice(0, 3), ...across].slice(0, MAX);
  });

  // Values the facets would have offered here, had they loaded: a facet's value list, or a
  // plain word.
  const wantsFacets = () => {
    const t = live();
    return t !== undefined && (t.key === undefined || isFacet(t.key));
  };

  // Counts fill in once a value list has stayed open: the facets it shows, for the view as it
  // applies now. Typing within the same list doesn't restart the wait.
  const countsWanted = createMemo(() => {
    if (!props.focused || props.dismissed) return "";
    const fs = [...new Set(suggestions().flatMap((s) => (s.facet ? [s.facet] : [])))];
    return fs.length ? JSON.stringify([fs, props.current]) : "";
  });
  /** The list whose counts failed to load, until they're fetched again. */
  const [countsFailed, setCountsFailed] = createSignal("");
  const [attempt, setAttempt] = createSignal(0);
  createEffect(
    () => [countsWanted(), attempt()] as const,
    ([want]) => {
      if (!want) return;
      const [fs, q] = JSON.parse(want) as [Facet[], string];
      const timer = setTimeout(() => {
        // This list's counts are being fetched again: an earlier failure of them no longer stands.
        setCountsFailed((failed) => (failed === want ? "" : failed));
        for (const facet of fs) {
          readThen(
            getFacetCounts(facet, q),
            (rows) => setCounts((c) => ({ ...c, [`${facet}\n${q}`]: new Map(rows.map((r) => [r.value.toLowerCase(), r.count])) })),
            () => setCountsFailed(want),
          );
        }
      }, COUNTS_AFTER_MS);
      return () => clearTimeout(timer);
    },
  );
  // A live push may change any count: the open list's counts are fetched again (after the same
  // wait, so a burst of pushes costs one fetch). Until they land the old ones stay, as for any
  // list reopened later.
  onSettled(() => onPush(() => setAttempt((n) => n + 1)));
  const retryCounts = () => {
    forgetFailure(getFacetCounts);
    setCountsFailed("");
    setAttempt((n) => n + 1);
  };
  const countOf = (s: Suggestion) => {
    if (!s.facet || s.value === undefined || s.value === "me") return undefined;
    const got = counts()[`${s.facet}\n${props.current}`];
    return got && (got.get(s.value.toLowerCase()) ?? 0);
  };

  /** What went wrong for the list as it stands, with how to retry it. */
  const notice = createMemo(() => {
    if (props.facetsFailed && wantsFacets()) return { text: "Couldn't load suggestions", retry: props.retryFacets };
    const want = countsWanted();
    if (want && countsFailed() === want) return { text: "Couldn't load counts", retry: retryCounts };
    return undefined;
  });

  const open = () => props.focused && !props.dismissed && (suggestions().length > 0 || notice() !== undefined);

  const pick = (s: Suggestion) => props.pick(s.insert, s.done);

  onSettled(() => {
    props.expose({
      open,
      active: () => (open() && suggestions().length > 0 ? `filter-suggestion-${active()}` : undefined),
      key: (e) => {
        if (!open()) return false;
        const list = suggestions();
        if (e.key === "ArrowDown" && list.length) setActive((active() + 1) % list.length);
        else if (e.key === "ArrowUp" && list.length) setActive((active() - 1 + list.length) % list.length);
        else if ((e.key === "Enter" || e.key === "Tab") && list[active()] && (live()?.key !== undefined || e.key === "Tab")) {
          // A value list: Enter or Tab takes the highlighted value. Over a plain word only Tab
          // does, so Enter still searches for the word.
          pick(list[active()]!);
        } else if (e.key === "Escape") props.dismiss();
        else return false;
        e.preventDefault();
        return true;
      },
    });
  });

  return (
    <Show when={open()}>
      <div data-perf="suggestions" {...stylex.attrs(s.pop)}>
        <Show when={suggestions().length > 0}>
          <div id="filter-suggestions" role="listbox" aria-label="Suggestions">
            <For each={suggestions()}>
              {(sg, i) => (
                <div
                  id={`filter-suggestion-${i()}`}
                  role="option"
                  aria-selected={i() === active() ? "true" : "false"}
                  {...stylex.attrs(s.option, i() === active() && s.optionActive)}
                  // Keep focus in the box: the pick happens on press.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    pick(sg);
                  }}
                  onPointerMove={() => setActive(i())}
                >
                  <Show when={sg.color}>{(c) => <LabelDot color={c()} />}</Show>
                  <span {...stylex.attrs(s.mono)}>{sg.insert}</span>
                  <span {...stylex.attrs(s.hint)}>{sg.hint ?? ""}</span>
                  <span {...stylex.attrs(s.count)} data-perf="count">
                    {countOf(sg)?.toLocaleString("en") ?? ""}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={notice()}>
          {(n) => (
            <p role="status" {...stylex.attrs(s.notice)}>
              {n().text} ·{" "}
              <button
                type="button"
                {...stylex.attrs(s.retry)}
                // Keep focus in the box, so the list stays open for the retried values.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => n().retry()}
              >
                Retry
              </button>
            </p>
          )}
        </Show>
      </div>
    </Show>
  );
}

const s = stylex.create({
  pop: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 4,
    backgroundColor: colors.bgRaised,
    insetInlineStart: 14,
    position: "absolute",
    zIndex: 10,
    maxWidth: 520,
    top: 42,
    width: "calc(100% - 28px)",
  },
  option: {
    gap: 8,
    paddingInline: 10,
    alignItems: "center",
    cursor: "pointer",
    display: "flex",
    whiteSpace: "nowrap",
    height: 28,
  },
  optionActive: {
    backgroundColor: colors.hover,
  },
  mono: {
    fontFamily: fonts.mono,
    fontSize: 12.5,
  },
  hint: {
    overflow: "hidden",
    color: colors.muted,
    flexGrow: 1,
    textOverflow: "ellipsis",
  },
  count: {
    color: colors.muted,
    fontVariantNumeric: "tabular-nums",
  },
  notice: {
    margin: 0,
    gap: 4,
    paddingInline: 10,
    alignItems: "center",
    color: colors.muted,
    display: "flex",
    height: 28,
  },
  retry: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    textDecoration: "underline",
    backgroundColor: "transparent",
    color: colors.accent,
    cursor: "pointer",
  },
});
