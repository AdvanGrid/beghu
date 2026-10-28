// The account's preferences: the `/prefs` route, in the panel's place beside the list, its own
// chunk (router.tsx). Comment order, and the keymap's setup: every action, rebound from the GitHub
// preset. Both are account preferences, stored on the server (`PATCH /api/prefs`, one field per
// call) and pushed to the account's other tabs; theme and widths are this browser's (theme.js,
// the header's switch).
//
// Rebinding records what's pressed: one key or chord, or two plain keys in a row (a sequence,
// `g i`). Escape cancels. A key the browser keeps is refused with the reason (keys.ts, `refusal`);
// some never reach the page at all (⌘/Ctrl+W closes the tab first), which the page says up front.
// A key another action has is offered as a swap: that action takes this one's keys instead (`plan`,
// here rather than in keys.ts, which is first-load JS). A change takes effect in this tab at once;
// if it can't be stored, it's undone and says so.
import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, Errored, For, Loading, Match, onCleanup, Show, Switch } from "solid-js";
import { commentOrder, forgetFailure, getMe, prefsSetHere, SessionEnded, setAccountOrder, setPref, signIn, type CommentOrder } from "./api";
import { stale } from "./account";
import { ACTIONS, clash, keymap, keyOf, overlap, overrides, refusal, refusalFor, setKeymap, type Action, type Overrides } from "./keys";
import { LABEL, showBinding } from "./Hints";
import { cantReach } from "./live";
import { Failure } from "./Root";
import { StillImporting } from "./WhileImporting";
import { colors, fonts } from "./tokens.stylex";

/** How long a recorded key waits for a second one, to make a sequence. */
const SECOND_KEY_MS = 1200;

export function PrefsPanel() {
  return (
    <section aria-label="Preferences" data-perf="prefs" {...stylex.attrs(s.panel)}>
      <Errored fallback={(err, reset) => <PrefsFailure error={err()} reset={reset} />}>
        <Loading fallback={<div {...stylex.attrs(s.grow)} aria-busy="true" />}>
          <Prefs />
        </Loading>
      </Errored>
    </section>
  );
}

/** Whether preferences can't be changed now: the tab is stale, or beghu can't be reached. */
const paused = () => stale() !== undefined || cantReach();

function Prefs() {
  const me = createMemo(() => getMe());
  return (
    <div {...stylex.attrs(s.scroller)}>
      <div {...stylex.attrs(s.head)}>
        <h2 {...stylex.attrs(s.title)}>Preferences</h2>
        <a href="/" {...stylex.attrs(s.close)} aria-label="Close" title="Close">
          ×
        </a>
      </div>
      <p {...stylex.attrs(s.intro)}>
        These follow {me().account.login} to every browser. The theme and the widths stay with this browser.
      </p>
      <Order fallback={me().comment_order} />
      <Keys />
      <StillImporting />
    </div>
  );
}

/** Newest or oldest first: how the thread shows when an issue opens. */
function Order(props: { fallback: CommentOrder }) {
  const order = () => commentOrder() ?? props.fallback;
  const [failed, setFailed] = createSignal(false);
  const choose = async (to: CommentOrder) => {
    setFailed(false);
    try {
      await setAccountOrder(to);
    } catch (e) {
      if (e instanceof SessionEnded) signIn();
      setFailed(true);
    }
  };
  return (
    <fieldset {...stylex.attrs(s.group)} data-perf="prefs-order">
      <legend {...stylex.attrs(s.legend)}>Comments</legend>
      <For each={["newest", "oldest"] as const}>
        {(o) => (
          <label {...stylex.attrs(s.choice)}>
            <input
              type="radio"
              name="comment-order"
              value={o}
              checked={order() === o}
              disabled={paused()}
              onChange={() => void choose(o)}
              {...stylex.attrs(s.radio)}
            />
            {o === "newest" ? "Newest first" : "Oldest first"}
          </label>
        )}
      </For>
      <Show when={failed()}>
        <p role="alert" {...stylex.attrs(s.error)}>
          Couldn't change the order. It's as it was.
        </p>
      </Show>
    </fieldset>
  );
}

/** One change of the account's bindings: an action's bindings, "" for none, null for the preset's. */
type Change = { action: Action; binding: string | null };

/** How binding a key to an action goes: refused, and why; or the changes that bind it. */
type Plan =
  | { refused: string }
  /** With `swap`, the key was `swap.action`'s, which takes `swap.gets`. */
  | { changes: Change[]; swap?: { action: Action; gets: string[] } };

/** "A", "A and B", "A, B and C". */
const listOf = (items: string[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(items);

/**
 * Binding `binding` (alone) to `action`, in the keymap in effect. If another action has the key
 * (or one in its way, where the two work together), it's a swap: that action takes `action`'s
 * keys in its place, those of them no action it works with has. If more than one action has it,
 * it's refused: which of them gives it up is the user's to choose. The swap's own change comes
 * first, so the key is never bound twice for longer than the first change.
 */
function plan(action: Action, binding: string): Plan {
  const why = refusalFor(action, binding);
  if (why) return { refused: why };
  const map = keymap();
  const has = (a: Action, key: string) => map[a].some((k) => clash(k, key));
  const holders = ACTIONS.filter((b) => overlap(action, b) && has(b, binding));
  const set = { action, binding };
  if (holders.length === 0) return { changes: [set] };
  if (holders.length > 1) return { refused: `${listOf(holders.map((h) => LABEL[h]))} have it; change one of them first` };
  const holder = holders[0]!;
  const theirs = map[holder].flatMap((k) => (clash(k, binding) ? map[action].filter((m) => !clash(m, binding)) : [k]));
  const free = (k: string) => refusalFor(holder, k) === undefined && !ACTIONS.some((c) => c !== holder && c !== action && overlap(holder, c) && has(c, k));
  const gets = [...new Set(theirs)].filter(free);
  return { changes: [{ action: holder, binding: gets.join("\n") }, set], swap: { action: holder, gets } };
}

/**
 * What a row says under its keys: why a key was refused, a swap to confirm, or a failed save
 * (`undone`: the changes stored before the failure were taken back).
 */
type Note = { kind: "refused"; binding: string; reason: string } | { kind: "swap"; binding: string; with: Action; gets: string[]; changes: Change[] } | { kind: "failed"; undone: boolean };

/** The keymap's setup: each action, its keys in effect, and Change, Reset and Unbind. */
function Keys() {
  /** The action whose key is being recorded, and the first key of a sequence once pressed. */
  const [recording, setRecording] = createSignal<{ action: Action; first?: string }>();
  const [note, setNote] = createSignal<{ action: Action; note: Note }>();
  const [saving, setSaving] = createSignal(false);
  let second: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(second));

  /** Ends the recording, dropping a first key that waits for a second. */
  const end = () => {
    clearTimeout(second);
    setRecording(undefined);
  };

  /** Ends the recording; the focus goes back to its row's Change button. */
  const stop = () => {
    const was = recording()?.action;
    end();
    if (was !== undefined) queueMicrotask(() => document.querySelector<HTMLElement>(`[data-perf="prefs"] [data-change="${was}"]`)?.focus());
  };

  /** Stores `changes` one by one, in effect here at once; if one fails, all are undone. */
  const apply = async (action: Action, changes: Change[]) => {
    const before: Overrides = { ...overrides() };
    const after: Overrides = { ...before };
    for (const c of changes) {
      if (c.binding === null) delete after[c.action];
      else after[c.action] = c.binding;
    }
    prefsSetHere();
    setKeymap(after);
    setNote(undefined);
    setSaving(true);
    const done: Change[] = [];
    try {
      for (const c of changes) {
        await setPref({ field: "key", action: c.action, binding: c.binding });
        done.push(c);
      }
    } catch (e) {
      if (e instanceof SessionEnded) signIn();
      // Undone, those that were stored as well, so the account is as it was.
      prefsSetHere();
      setKeymap(before);
      let undone = true;
      for (const c of done.reverse()) {
        await setPref({ field: "key", action: c.action, binding: before[c.action] ?? null }).catch(() => {
          undone = false;
        });
      }
      setNote({ action, note: { kind: "failed", undone } });
    } finally {
      setSaving(false);
    }
  };

  /** A key was recorded for `action`: refused, a swap to confirm, or bound. */
  const recorded = (action: Action, binding: string) => {
    stop();
    const p = plan(action, binding);
    if ("refused" in p) return setNote({ action, note: { kind: "refused", binding, reason: p.refused } });
    if (p.swap) {
      setNote({ action, note: { kind: "swap", binding, with: p.swap.action, gets: p.swap.gets, changes: p.changes } });
      // The focus goes to the question's Swap button.
      queueMicrotask(() => document.querySelector<HTMLElement>('[data-perf="prefs"] [data-perf="key-swap"] [data-swap]')?.focus());
      return;
    }
    void apply(action, p.changes);
  };

  const onKey = (action: Action, e: KeyboardEvent) => {
    // Every key is the recording's: none reaches the keys module, the browser's own (Tab) or the page.
    e.preventDefault();
    e.stopPropagation();
    const key = keyOf(e);
    if (key === undefined) return;
    const first = recording()?.first;
    if (key === "Escape") return stop();
    if (first !== undefined) return recorded(action, `${first} ${key}`);
    if (/^(Shift\+)?[^+]+$/.test(key) && refusal(key) === undefined) {
      // A plain key may start a sequence: wait a moment for a second.
      setRecording({ action, first: key });
      clearTimeout(second);
      second = setTimeout(() => {
        // Unless the recording ended meanwhile (Escape, or the focus left it).
        if (recording()?.action === action) recorded(action, key);
      }, SECOND_KEY_MS);
      return;
    }
    recorded(action, key);
  };

  return (
    <fieldset {...stylex.attrs(s.group)} data-perf="prefs-keys">
      <legend {...stylex.attrs(s.legend)}>Keys</legend>
      <p {...stylex.attrs(s.help)}>
        GitHub's shortcuts, with your changes. Change one, then press its new key, or two keys in a row for a sequence (like <kbd {...stylex.attrs(s.key)}>g i</kbd>
        ); Esc cancels. Keys the browser keeps can't be bound: <kbd {...stylex.attrs(s.key)}>⌘/Ctrl+W</kbd>, <kbd {...stylex.attrs(s.key)}>T</kbd>,{" "}
        <kbd {...stylex.attrs(s.key)}>N</kbd>, <kbd {...stylex.attrs(s.key)}>L</kbd>, <kbd {...stylex.attrs(s.key)}>Tab</kbd> and others.
      </p>
      <table {...stylex.attrs(s.table)}>
        <tbody>
          <For each={ACTIONS}>
            {(a) => {
              const keys = () => keymap()[a];
              const mine = () => overrides()[a] !== undefined;
              const rec = () => (recording()?.action === a ? recording() : undefined);
              const rowNote = () => (note()?.action === a ? note()!.note : undefined);
              return (
                <>
                  <tr data-perf="key-row" data-action={a} {...stylex.attrs(s.row)}>
                    <th scope="row" {...stylex.attrs(s.label)}>
                      {LABEL[a]}
                    </th>
                    <td {...stylex.attrs(s.keys)} data-perf="keys" aria-live="polite">
                      <Show
                        when={rec()}
                        fallback={
                          <Show when={keys().length > 0} fallback={<span {...stylex.attrs(s.muted)}>unbound</span>}>
                            <span {...stylex.attrs(s.chord)}>
                              <For each={keys()}>{(k) => <kbd {...stylex.attrs(s.key)}>{showBinding(k)}</kbd>}</For>
                            </span>
                          </Show>
                        }
                      >
                        {(r) => <span {...stylex.attrs(s.muted)}>{r().first === undefined ? "Press a key…" : `${showBinding(r().first!)} …`}</span>}
                      </Show>
                    </td>
                    <td {...stylex.attrs(s.actions)}>
                      <Show
                        when={rec()}
                        fallback={
                          <button
                            type="button"
                            data-change={a}
                            aria-label={`Change ${LABEL[a]}`}
                            disabled={saving() || paused()}
                            {...stylex.attrs(s.button)}
                            onClick={(e) => {
                              setNote(undefined);
                              setRecording({ action: a });
                              // The row's recorder takes the focus once it shows.
                              const row = e.currentTarget.closest("tr");
                              queueMicrotask(() => row?.querySelector<HTMLElement>('[data-perf="recorder"]')?.focus());
                            }}
                          >
                            Change
                          </button>
                        }
                      >
                        <button
                          type="button"
                          data-perf="recorder"
                          aria-label={`Recording a key for ${LABEL[a]}: press it, or Esc to cancel`}
                          {...stylex.attrs(s.button, s.recording)}
                          onKeyDown={(e) => onKey(a, e)}
                          onBlur={() => recording()?.action === a && end()}
                          onClick={stop}
                        >
                          Cancel
                        </button>
                      </Show>
                      <Show when={mine()}>
                        <button
                          type="button"
                          aria-label={`Reset ${LABEL[a]} to GitHub's`}
                          disabled={saving() || paused()}
                          {...stylex.attrs(s.button)}
                          onClick={() => void apply(a, [{ action: a, binding: null }])}
                        >
                          Reset
                        </button>
                      </Show>
                      <Show when={keys().length > 0}>
                        <button
                          type="button"
                          aria-label={`Unbind ${LABEL[a]}`}
                          disabled={saving() || paused()}
                          {...stylex.attrs(s.button)}
                          onClick={() => void apply(a, [{ action: a, binding: "" }])}
                        >
                          Unbind
                        </button>
                      </Show>
                    </td>
                  </tr>
                  <Show when={rowNote()}>
                    {(n) => (
                      <tr>
                        <td colspan={3} {...stylex.attrs(s.noteCell)}>
                          <RowNote action={a} note={n()} apply={apply} dismiss={() => setNote(undefined)} saving={saving()} />
                        </td>
                      </tr>
                    )}
                  </Show>
                </>
              );
            }}
          </For>
        </tbody>
      </table>
    </fieldset>
  );
}

function RowNote(props: { action: Action; note: Note; apply: (action: Action, changes: Change[]) => Promise<void>; dismiss: () => void; saving: boolean }) {
  const of = <K extends Note["kind"]>(kind: K) => (props.note.kind === kind ? (props.note as Extract<Note, { kind: K }>) : undefined);
  return (
    <Switch>
      <Match when={of("refused")}>
        {(r) => (
          <p role="alert" data-perf="key-refused" {...stylex.attrs(s.note, s.error)}>
            <kbd {...stylex.attrs(s.key)}>{showBinding(r().binding)}</kbd> can't be bound: {r().reason}.
          </p>
        )}
      </Match>
      <Match when={of("swap")}>
        {(w) => (
          <p role="status" data-perf="key-swap" {...stylex.attrs(s.note)}>
            <kbd {...stylex.attrs(s.key)}>{showBinding(w().binding)}</kbd> is {LABEL[w().with]}'s. Swap, and {LABEL[w().with]} gets{" "}
            {w().gets.length > 0 ? w().gets.map(showBinding).join(", ") : "no key"}?{" "}
            <button type="button" data-swap disabled={props.saving || paused()} {...stylex.attrs(s.button)} onClick={() => void props.apply(props.action, w().changes)}>
              Swap
            </button>{" "}
            <button type="button" {...stylex.attrs(s.button)} onClick={() => props.dismiss()}>
              Cancel
            </button>
          </p>
        )}
      </Match>
      <Match when={of("failed")}>
        {(f) => (
          <p role="alert" data-perf="key-failed" {...stylex.attrs(s.note, s.error)}>
            <Show when={f().undone} fallback="Couldn't save that change, nor take back the part that was saved. Reload to see your keys as they're stored.">
              Couldn't save that change. Your keys are as they were.
            </Show>
          </p>
        )}
      </Match>
    </Switch>
  );
}

function PrefsFailure(props: { error: unknown; reset: () => void }) {
  return (
    <Failure error={props.error}>
      <p {...stylex.attrs(s.intro)} role="alert">
        Couldn't load your preferences ·{" "}
        <button
          type="button"
          {...stylex.attrs(s.link)}
          onClick={() => {
            forgetFailure(getMe);
            props.reset();
          }}
        >
          Retry
        </button>
      </p>
    </Failure>
  );
}

const s = stylex.create({
  panel: {
    backgroundColor: colors.bg,
    borderInlineStartColor: colors.line,
    borderInlineStartStyle: "solid",
    borderInlineStartWidth: 1,
    display: "flex",
    flexBasis: 0,
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  grow: {
    flexGrow: 1,
  },
  scroller: {
    flexGrow: 1,
    overflowY: "auto",
  },
  head: {
    paddingBlock: 12,
    paddingInline: 16,
    alignItems: "center",
    display: "flex",
  },
  title: {
    margin: 0,
    flexGrow: 1,
    fontSize: 18,
    fontWeight: 600,
  },
  close: {
    textDecoration: "none",
    color: {
      default: colors.muted,
      ":hover": colors.fg,
    },
  },
  intro: {
    margin: 0,
    paddingInline: 16,
    color: colors.muted,
    paddingBottom: 12,
  },
  group: {
    margin: 0,
    borderWidth: 0,
    paddingBlock: 10,
    paddingInline: 16,
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  legend: {
    padding: 0,
    color: colors.muted,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    paddingBottom: 6,
  },
  choice: {
    gap: 8,
    alignItems: "center",
    cursor: "pointer",
    display: "flex",
    height: 28,
  },
  radio: {
    margin: 0,
    accentColor: colors.accent,
  },
  help: {
    margin: 0,
    color: colors.muted,
    paddingBottom: 8,
  },
  table: {
    borderCollapse: "collapse",
    width: "100%",
  },
  row: {
    borderTopColor: colors.line,
    borderTopStyle: "solid",
    borderTopWidth: 1,
  },
  label: {
    paddingBlock: 5,
    fontWeight: 400,
    paddingInlineEnd: 12,
    textAlign: "start",
  },
  keys: {
    paddingBlock: 5,
    paddingInlineEnd: 12,
  },
  chord: {
    gap: 8,
    display: "inline-flex",
    flexWrap: "wrap",
  },
  key: {
    color: colors.fg,
    fontFamily: fonts.mono,
    fontSize: 12,
  },
  muted: {
    color: colors.muted,
  },
  actions: {
    gap: 6,
    paddingBlock: 5,
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  button: {
    font: "inherit",
    borderColor: colors.line,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    paddingBlock: 1,
    paddingInline: 8,
    backgroundColor: {
      default: colors.bgRaised,
      ":hover:not(:disabled)": colors.hover,
    },
    color: colors.fg,
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    fontSize: 12,
    opacity: {
      default: 1,
      ":disabled": 0.5,
    },
  },
  recording: {
    borderColor: colors.accent,
  },
  noteCell: {
    paddingBottom: 6,
  },
  note: {
    margin: 0,
    fontSize: 12,
  },
  error: {
    color: colors.danger,
  },
  link: {
    font: "inherit",
    padding: 0,
    borderWidth: 0,
    textDecoration: "underline",
    backgroundColor: "transparent",
    color: colors.accent,
    cursor: "pointer",
  },
});
