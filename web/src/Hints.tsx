// The words for the keys: the hint bar's quick keys for where the focus is, and the `?` overlay
// with every binding in effect. Its own chunk, loaded after first paint (Root.tsx); the keys
// module (keys.ts) does the work. A setup page for the keymap (#113) can use `LABEL` and
// `showBinding` too.
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";
import { area, available, keysIn, MAC, touch, type Action, type Area } from "./keys";
import { writesPaused } from "./live";
import { colors, fonts } from "./tokens.stylex";

/** What each touchpoint does, as the hint bar and the overlay say it. */
export const LABEL: Record<Action, string> = {
  next: "Next issue",
  previous: "Previous issue",
  first: "First issue",
  last: "Last issue",
  openIssue: "Into the issue",
  toList: "Back to the list",
  focusFilter: "Filter",
  create: "New issue",
  toggleMode: "List / Tree",
  labels: "Labels",
  assignees: "Assignees",
  milestone: "Milestone",
  comment: "Comment",
  editTitle: "Edit title",
  closeReopen: "Close / reopen",
  send: "Send comment",
  saveEdit: "Save",
  cancelEdit: "Cancel editing",
  imageOpen: "Open image",
  imageClose: "Close image",
  help: "All keys",
};

/** The keys that write: dimmed while writes are paused (a banner shows), as their buttons are. */
const WRITES: ReadonlySet<Action> = new Set(["closeReopen", "send", "saveEdit"]);

/** Why a write key does nothing now, if it doesn't. */
function paused(action: Action): string | undefined {
  return WRITES.has(action) && writesPaused() ? "Writes are paused" : undefined;
}

/** The quick keys the hint bar offers in each area, those on offer and working there. */
const LIST_QUICK: Action[] = ["next", "previous", "openIssue", "focusFilter", "create", "toggleMode", "help"];
const QUICK: Record<"page" | "list" | "panel" | "composer" | "editor" | "lightbox" | "text", Action[]> = {
  page: LIST_QUICK,
  list: LIST_QUICK,
  panel: ["next", "previous", "labels", "assignees", "milestone", "comment", "editTitle", "closeReopen", "imageOpen", "toList", "help"],
  lightbox: ["imageClose"],
  // Only bindings with Ctrl or Cmd work while typing.
  composer: ["send", "openIssue", "focusFilter", "help"],
  editor: ["saveEdit", "cancelEdit", "help"],
  text: ["focusFilter", "help"],
};

/** A widget's own keys: what the hint bar shows while it has the focus. */
type Syntax = { syntax: string; does: string; off?: string };

/** The search syntax, while the filter box has the focus. */
const SEARCH: Syntax[] = [
  { syntax: "word", does: "starts a word" },
  { syntax: '"a phrase"', does: "as written" },
  { syntax: "-word", does: "leaves out" },
  { syntax: "in:title,body,comments", does: "where to look" },
  { syntax: "match:blend|best|off", does: "Match mode" },
];

/** A picker's keys (the pickers handle these themselves, as a listbox does). */
const PICKER: Syntax[] = [
  { syntax: "Type", does: "Filter" },
  { syntax: "↑ ↓", does: "Move" },
  { syntax: "Enter", does: "Pick" },
  { syntax: "Esc", does: "Close" },
];

/**
 * The overlay's sections: the actions in each, or a widget's own keys, with the areas each is
 * about (the first decides which keys show). The one for where the focus was comes first.
 */
const SECTIONS: { name: string; areas: Area[]; actions: Action[]; own?: Syntax[] }[] = [
  { name: "List", areas: ["list", "page"], actions: ["next", "previous", "first", "last", "openIssue", "create", "toggleMode"] },
  { name: "Issue", areas: ["panel"], actions: ["labels", "assignees", "milestone", "comment", "editTitle", "closeReopen", "imageOpen", "toList"] },
  { name: "Image", areas: ["lightbox"], actions: ["imageClose"] },
  { name: "Comment box", areas: ["composer"], actions: ["send", "openIssue"] },
  { name: "Title or description editor", areas: ["editor"], actions: ["saveEdit", "cancelEdit"] },
  { name: "Picker", areas: ["picker"], actions: [], own: PICKER },
  { name: "Anywhere", areas: ["page", "filter", "text"], actions: ["focusFilter", "help"] },
];

const ARROWS: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc" };

/** A binding as people read it: `Alt+KeyL` is Alt+L, `Shift+x` is Shift+X. */
export function showBinding(binding: string): string {
  return binding
    .split(/\+(?=.)/)
    .map((part) => ARROWS[part] ?? part.replace(/^(Key|Digit)(?=.)/, "").replace(/^[a-z]$/, (c) => (binding.includes("+") ? c.toUpperCase() : c)))
    .join("+")
    .replace(/^Mod\+/, MAC ? "⌘" : "Ctrl+");
}

/** The keys that run `action` now in `where`, as people read them. */
function keysOf(action: Action, where: Area): string[] {
  return keysIn(action, where).map(showBinding);
}

/**
 * The hint bar's right side, beside the status slot: the quick keys for where the focus is, those
 * on offer (a PR's panel offers no write keys); the search syntax in the filter box; a picker's
 * keys in a picker. Also mounts the `?` overlay.
 */
export function Hints() {
  const offered = (where: Area, actions: Action[]): Syntax[] =>
    actions.filter((x) => available(x) && keysOf(x, where).length > 0).map((x) => ({ syntax: keysOf(x, where).join(" "), does: LABEL[x], off: paused(x) }));
  const quick = (): Syntax[] => {
    const a = area();
    if (a === "filter") return SEARCH;
    if (a === "picker") return [...PICKER, ...offered(a, ["help"])];
    if (a === "help") return [{ syntax: "Esc", does: "Close" }];
    return offered(a, QUICK[a]);
  };
  return (
    <>
      <span role="group" data-perf="hints" data-area={area()} aria-label={area() === "filter" ? "Search syntax" : "Keys"} {...stylex.attrs(s.hints)}>
        <For each={quick()}>
          {(h) => (
            <span aria-disabled={h.off ? "true" : undefined} title={h.off} {...stylex.attrs(s.hint, h.off !== undefined && s.off)}>
              <kbd {...stylex.attrs(s.key)}>{h.syntax}</kbd> {h.does}
            </span>
          )}
        </For>
      </span>
      <Help />
    </>
  );
}

/**
 * The `?` overlay: every binding in effect, the section for where the focus was first. What
 * isn't on offer there is dimmed, with the reason. Escape closes it and gives the focus back.
 */
function Help() {
  let dialog!: HTMLDialogElement;
  let from: Area = "page";
  let back: HTMLElement | null = null;
  const order = () => [...SECTIONS].sort((a, b) => Number(b.areas.includes(from)) - Number(a.areas.includes(from)));
  const [shown, setShown] = createSignal(false);
  touch("help", () => {
    if (dialog.open) return;
    from = area();
    back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setShown(true);
    dialog.showModal();
  });
  return (
    <dialog
      ref={dialog}
      aria-label="Keyboard shortcuts"
      data-keys="help"
      data-perf="key-help"
      {...stylex.attrs(s.dialog)}
      onClose={() => {
        setShown(false);
        back?.focus({ preventScroll: true });
      }}
    >
      <Show when={shown()}>
        <h2 {...stylex.attrs(s.title)}>Keyboard shortcuts</h2>
        <For each={order()}>
          {(sec) => (
            <section>
              <h3 {...stylex.attrs(s.section)}>{sec.name}</h3>
              <table {...stylex.attrs(s.table)}>
                <tbody>
                  <For each={sec.own ?? []}>
                    {(k) => (
                      <tr>
                        <td {...stylex.attrs(s.does)}>{k.does}</td>
                        <td {...stylex.attrs(s.keys)}>
                          <kbd {...stylex.attrs(s.key)}>{k.syntax}</kbd>
                        </td>
                      </tr>
                    )}
                  </For>
                  <For each={sec.actions}>
                    {(a) => {
                      const keys = () => keysOf(a, sec.areas[0]!);
                      // Dimmed: nothing offers it (not built yet, or a PR's write keys), no key runs
                      // it where the focus was, or it writes and writes are paused.
                      const why = () =>
                        !available(a) ? "Nothing here offers this" : keysIn(a, from).length === 0 ? "Not with the focus where it was" : paused(a);
                      const off = () => why() !== undefined;
                      return (
                        <tr aria-disabled={off() ? "true" : undefined} title={why()} {...stylex.attrs(off() && s.off)}>
                          <td {...stylex.attrs(s.does)}>{LABEL[a]}</td>
                          <td {...stylex.attrs(s.keys)}>
                            <Show when={keys().length > 0} fallback={<span {...stylex.attrs(s.unbound)}>unbound</span>}>
                              <span {...stylex.attrs(s.chord)}>
                                <For each={keys()}>{(k) => <kbd {...stylex.attrs(s.key)}>{k}</kbd>}</For>
                              </span>
                            </Show>
                            <Show when={off()}>
                              <span {...stylex.attrs(s.unbound)}> · {why() === paused(a) ? "paused" : "not here"}</span>
                            </Show>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </section>
          )}
        </For>
        <p {...stylex.attrs(s.foot)}>Single keys don't fire while you type in a text field or a picker.</p>
      </Show>
    </dialog>
  );
}

const s = stylex.create({
  hints: {
    gap: 14,
    overflow: "hidden",
    color: colors.muted,
    display: "flex",
    fontSize: 11.5,
    marginInlineStart: "auto",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  hint: {
    flexShrink: 0,
  },
  key: {
    color: colors.fg,
    fontFamily: fonts.mono,
    fontSize: 11.5,
  },
  dialog: {
    padding: 20,
    borderColor: colors.line,
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    backgroundColor: colors.pop,
    boxShadow: `0 8px 30px ${colors.popShadow}`,
    color: colors.fg,
    fontFamily: fonts.ui,
    fontSize: 13,
    maxHeight: "80dvh",
    width: "min(520px, calc(100vw - 32px))",
    "::backdrop": {
      backgroundColor: colors.popShadow,
    },
  },
  title: {
    margin: 0,
    fontSize: 15,
  },
  section: {
    margin: 0,
    color: colors.muted,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    marginTop: 14,
  },
  table: {
    borderCollapse: "collapse",
    marginTop: 4,
    width: "100%",
  },
  does: {
    paddingBlock: 3,
  },
  keys: {
    paddingBlock: 3,
    textAlign: "end",
  },
  chord: {
    gap: 8,
    display: "inline-flex",
  },
  off: {
    opacity: 0.5,
  },
  unbound: {
    color: colors.muted,
    fontSize: 11.5,
  },
  foot: {
    margin: 0,
    color: colors.muted,
    fontSize: 11.5,
    marginTop: 14,
  },
});
