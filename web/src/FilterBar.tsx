import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled, Show, untrack } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { SessionEnded, forgetFailure, getFacets, readThen, signIn, type Facets } from "./api";
import { touch } from "./keys";
import { coalesced, onPush } from "./live";
import type { Suggestions as SuggestionsComponent, SuggestionsControl } from "./Suggestions";
import type { MatchMode } from "./bindings/MatchMode";
import { applied, blendFits, effectiveMatch, hasText, MATCHES, queryOf, sameFilters, SORTS, sortValueOf, tokenAt, withMatch, withQuery, withSort, type SortValue } from "./query";
import { colors, fonts } from "./tokens.stylex";

const PRESETS: { name: string; query: string }[] = [
  { name: "Open", query: "is:open" },
  { name: "Assigned to me", query: "is:open assignee:me" },
  { name: "Created by me", query: "is:open author:me" },
  { name: "PRs", query: "is:pr is:open" },
];

/**
 * The filter bar: one text box holding the whole query, suggestions as you type, presets and a
 * sort under it. The query lives in the URL (`?q=`): typing replaces the history entry, a
 * finished action (a pick, Enter, a preset, a sort) pushes one, and the box is filled from the
 * URL only on load and on Back/Forward, never while typing.
 *
 * The suggestions (`Suggestions.tsx`) aren't in the first load: the box's first focus loads
 * them. Until they arrive the box filters as usual, only without a list. Their popover floats
 * over the list, so its arrival moves nothing.
 */
export function FilterBar() {
  const location = useLocation();
  /** Whether the box has focus. (The hint bar learns it from the keys module.) */
  const [focused, setFocused] = createSignal(false);
  const navigate = useNavigate();
  let box!: HTMLInputElement;
  // The keys' way in (keys.ts): the caret goes to the end, to add a token.
  touch("focusFilter", () => {
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  });
  // "New issue" beside the presets, by key: the create form in the panel, the view kept.
  touch("create", () => navigate(`/new${location.search}`));
  // Filled from the URL once; after that only typing, picks and Back/Forward change it.
  const initial = untrack(() => queryOf(location.search));
  const [text, setText] = createSignal(initial);
  const [caret, setCaret] = createSignal(initial.length);
  /** Where the token being typed starts: set by typing, cleared once the caret leaves it. */
  let editing: number | undefined;
  const [dismissed, setDismissed] = createSignal(false);
  /** The query that applies now: what the URL holds, or is about to. */
  const [current, setCurrent] = createSignal(initial);

  // The suggestions' values: fetched at load, here rather than with the suggestions so the
  // shell's preload is used at once. Without them the bar still filters; the list says they
  // failed and offers a retry. Every live push refetches them (spec #86), the stream's opening
  // reset included: a webhook can bring a new label, author, milestone or type. The push has
  // cleared the query cache, so the read fetches. A failed refetch keeps the values shown.
  const [facets, setFacets] = createSignal<Facets>();
  const [facetsFailed, setFacetsFailed] = createSignal(false);
  const loadFacets = () => {
    setFacetsFailed(false);
    readThen(getFacets(), setFacets, () => setFacetsFailed(true));
  };
  onSettled(loadFacets);
  const refetchFacets = coalesced(async () => {
    try {
      setFacets(await getFacets());
      setFacetsFailed(false);
    } catch (e) {
      if (e instanceof SessionEnded) signIn();
      // Values already shown stay; with none, the failure stands (or now shows).
      else if (untrack(facets) === undefined) setFacetsFailed(true);
    }
  });
  onSettled(() => onPush(() => void refetchFacets()));
  const retryFacets = () => {
    forgetFailure(getFacets);
    loadFacets();
  };

  // The suggestions module, loaded on the box's first focus, and what it shows the box once
  // it's on screen.
  const [loaded, setLoaded] = createSignal<typeof SuggestionsComponent>();
  const [control, setControl] = createSignal<SuggestionsControl>();
  let loading: Promise<void> | undefined;
  const loadSuggestions = () => {
    loading ??= import("./Suggestions").then(
      (m) => void setLoaded(() => m.Suggestions),
      // Offline, say: the next focus tries again.
      () => void (loading = undefined),
    );
  };

  // Back and Forward refill the box from the URL.
  onSettled(() => {
    const refill = () => {
      editing = undefined;
      const q = queryOf(window.location.search);
      setCurrent(q);
      box.value = q;
      setText(q);
      setCaret(q.length);
    };
    window.addEventListener("popstate", refill);
    return () => window.removeEventListener("popstate", refill);
  });

  /** Points the URL at `query`, unless it's there already. */
  const go = (query: string, push: boolean) => {
    setCurrent(query);
    const search = withQuery(window.location.search, query);
    if (search === window.location.search) return;
    navigate(window.location.pathname + search, { replace: !push, scroll: false });
  };

  /**
   * The box changed (`typed`) or its caret moved: apply what's complete, keeping the URL entry.
   * Only a token being typed waits; moving the caret into a finished one doesn't unapply it.
   */
  const sync = (typed: boolean) => {
    const at = box.selectionStart ?? box.value.length;
    const t = tokenAt(box.value, at);
    if (typed) editing = t?.start;
    else if (t?.start !== editing) editing = undefined;
    setText(box.value);
    setCaret(at);
    go(applied(box.value, editing === undefined ? undefined : at), false);
  };

  /** Sets the box and applies all of it, as a new history entry. */
  const commit = (next: string) => {
    editing = undefined;
    box.value = next;
    setText(next);
    setCaret(next.length);
    go(applied(next), true);
  };

  /**
   * A suggestion was taken: `insert` replaces the token being typed. Read from the box itself:
   * `text()` and `caret()` are held while a view typing asked for loads.
   */
  const pick = (insert: string, done: boolean) => {
    const cur = box.value;
    const at0 = box.selectionStart ?? cur.length;
    const t = tokenAt(cur, at0);
    const [start, end] = t ? [t.start, t.end] : [at0, at0];
    const before = cur.slice(0, start);
    const after = cur.slice(end).trimStart();
    const put = done ? `${insert} ` : insert;
    const next = before + put + after;
    const at = before.length + put.length;
    // A key goes on being typed; a value is finished.
    editing = done ? undefined : before.length;
    box.value = next;
    box.setSelectionRange(at, at);
    setText(next);
    setCaret(at);
    go(applied(next, editing === undefined ? undefined : at), done);
  };

  return (
    <div {...stylex.attrs(s.wrap)}>
      <div {...stylex.attrs(s.barRow)}>
        <div {...stylex.attrs(s.bar, focused() && s.barFocused)}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" {...stylex.attrs(s.glass)}>
            <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="m10.5 10.5 3.5 3.5" stroke="currentColor" stroke-width="1.5" />
          </svg>
          <input
            ref={(el) => {
              box = el;
              el.value = initial;
            }}
            type="text"
            role="combobox"
            aria-label="Filter issues"
            aria-expanded={control()?.open() ? "true" : "false"}
            aria-controls="filter-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={control()?.active()}
            spellcheck={false}
            autocomplete="off"
            placeholder="Filter: label:, assignee:me, repo:, is:pr… or search text"
            data-perf="filter"
            data-keys="filter"
            {...stylex.attrs(s.input)}
            onFocus={() => {
              setFocused(true);
              loadSuggestions();
            }}
            onBlur={() => {
              setFocused(false);
              // Leaving the box finishes the token being typed.
              editing = undefined;
              go(applied(box.value), false);
            }}
            onInput={() => {
              setDismissed(false);
              sync(true);
            }}
            onKeyUp={(e) => {
              if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") sync(false);
            }}
            onClick={() => sync(false)}
            onKeyDown={(e) => {
              if (control()?.key(e)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                setDismissed(true);
                commit(box.value);
              } else if (e.key === "Escape") {
                box.blur();
              }
            }}
          />
        </div>
        <label {...stylex.attrs(s.sortLabel)}>
          <span {...stylex.attrs(s.hidden)}>Sort</span>
          <select
            aria-label="Sort"
            data-perf="sort"
            value={sortValueOf(current())}
            {...stylex.attrs(s.select)}
            onChange={(e) => commit(withSort(text(), e.currentTarget.value as SortValue))}
          >
            <For each={SORTS}>{(o) => <option value={o.value}>{o.label}</option>}</For>
          </select>
        </label>
        {/* Match mode: how free text orders the list. Only free text ranks, so without any the
            choice waits, disabled. Blend needs a descending time sort: under any other the server
            runs Best match, so the dropdown shows that and Blend can't be picked. Kept in sync
            with the `match:` token, as the sort is. */}
        <label {...stylex.attrs(s.sortLabel)}>
          <span {...stylex.attrs(s.hidden)}>Match</span>
          <select
            aria-label="Match"
            data-perf="match"
            title={blendFits(current()) ? "How search text orders the list" : "Blend needs a newest-first time sort, so this sort uses Best match"}
            disabled={!hasText(current())}
            value={effectiveMatch(current())}
            {...stylex.attrs(s.select, s.match)}
            onChange={(e) => commit(withMatch(text(), e.currentTarget.value as MatchMode))}
          >
            <For each={MATCHES}>
              {(o) => (
                <option value={o.value} disabled={o.value === "blend" && !blendFits(current())}>
                  {o.label}
                </option>
              )}
            </For>
          </select>
        </label>
      </div>
      <Show when={loaded()}>
        {(component) => {
          // Loaded once and never replaced: a snapshot, not a dependency.
          const Suggestions = untrack(component);
          return (
            <Suggestions
              text={text()}
              caret={caret()}
              current={current()}
              focused={focused()}
              dismissed={dismissed()}
              dismiss={() => setDismissed(true)}
              facets={facets()}
              facetsFailed={facetsFailed()}
              retryFacets={retryFacets}
              pick={pick}
              expose={setControl}
            />
          );
        }}
      </Show>
      <div role="group" aria-label="Presets" {...stylex.attrs(s.presets)}>
        <For each={PRESETS}>
          {(p) => (
            <button
              type="button"
              // Presets are filters: one shows as pressed under any sort, and keeps the sort.
              aria-pressed={sameFilters(current(), p.query) ? "true" : "false"}
              {...stylex.attrs(s.preset, sameFilters(current(), p.query) && s.presetOn)}
              onClick={() => commit(withSort(p.query, sortValueOf(current())))}
            >
              {p.name}
            </button>
          )}
        </For>
        <a href={`/new${location.search}`} noscroll {...stylex.attrs(s.preset, s.create)} data-perf="new-issue">
          New issue
        </a>
      </div>
    </div>
  );
}

const s = stylex.create({
  wrap: {
    gap: 8,
    paddingBlock: 10,
    paddingInline: 14,
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    position: "relative",
    borderBottomColor: colors.line,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
  },
  barRow: {
    gap: 8,
    display: "flex",
  },
  bar: {
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    gap: 6,
    paddingInline: 8,
    alignItems: "center",
    backgroundColor: colors.bg,
    display: "flex",
    flexGrow: 1,
    height: 30,
    minWidth: 0,
  },
  barFocused: {
    borderColor: colors.accent,
  },
  glass: {
    color: colors.muted,
    flexShrink: 0,
  },
  input: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    outline: "none",
    backgroundColor: "transparent",
    color: colors.fg,
    flexGrow: 1,
    fontFamily: fonts.mono,
    fontSize: 12.5,
    minWidth: 0,
  },
  sortLabel: {
    display: "flex",
    flexShrink: 0,
    maxWidth: "45%",
  },
  hidden: {
    overflow: "hidden",
    clipPath: "inset(50%)",
    position: "absolute",
    whiteSpace: "nowrap",
    height: 1,
    width: 1,
  },
  select: {
    font: "inherit",
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 6,
    backgroundColor: colors.bg,
    color: colors.fg,
    cursor: "pointer",
    fontSize: 12,
    height: 30,
    width: "100%",
  },
  match: {
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    opacity: {
      default: 1,
      ":disabled": 0.5,
    },
  },
  presets: {
    gap: 6,
    display: "flex",
    flexWrap: "wrap",
  },
  preset: {
    font: "inherit",
    borderColor: colors.line,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 2,
    paddingInline: 10,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.hover,
    },
    color: colors.muted,
    cursor: "pointer",
    fontSize: 12,
  },
  // "New issue": a link, at the end of the presets' row.
  create: {
    textDecoration: "none",
    color: colors.accent,
    marginInlineStart: "auto",
  },
  presetOn: {
    borderColor: colors.accent,
    backgroundColor: {
      default: colors.selected,
      ":hover": colors.selected,
    },
    color: colors.fg,
  },
});
