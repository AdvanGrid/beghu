// The keys module: every shortcut in the app goes through here. Views never listen for keys;
// they offer named touchpoints (`touch`), and one keydown listener on the window maps a key
// to a touchpoint through the keymap in effect. Where the focus is (`area`) decides which
// touchpoints the hint bar and the `?` overlay show, and the list's ARIA keys apply only there.
//
// The keymap is the GitHub preset with the account's own bindings over it (`setKeymap`): each
// action's binding, "" for one deliberately left unbound. Bindings are written `Ctrl+Shift+x`;
// one with Alt names the physical key (`Alt+KeyL`, matched on `e.code`), since Alt changes the
// character a key types on macOS and on many layouts. While text is typed (a text field, a
// picker), only Ctrl or Cmd chords without Alt fire: Alt and AltGr type characters there.
// Browser-reserved keys are refused (`refusal`).
//
// A view offers a touchpoint while it can act on it, and the offer goes with the view: the
// composer offers `comment`, `closeReopen` and `send`, so a PR's panel (no composer) offers none
// of them and the hint bar leaves them out. Each touchpoint also has the areas it works in
// (`WHERE`): an issue's write keys work only with the focus in its panel, never from the list.
//
// `labels`, `assignees` and `milestone` are offered by the detail's property rows (IssuePanel.tsx)
// and open that row's picker, for an issue only (`d().kind === "issue"`, as the composer is
// shown): the panel shows those rows for a PR too, but a PR's write keys are no-ops, left out of
// the hint bar. A picker is marked `data-keys="picker"`, a typing area: what's typed filters it,
// and its arrows, Enter and Escape are the listbox's own (Escape closes it, focus back on its
// row's button).
//
// Some touchpoints have no caller yet, pending their tickets: `editTitle` for title editing
// (#103), `create` for the create form (#104), `toggleMode` for tree mode (#108), and `imageOpen`
// and `imageClose` for the lightbox (#100). The `?` overlay shows them dimmed until then.
//
// This file is in first-load JS, so it holds only what dispatch needs; the words the hint bar
// and the overlay show are in Hints.tsx, loaded after first paint.
import { createSignal, getOwner, onCleanup } from "solid-js";

/** The touchpoints the app offers to the keys module. */
export const ACTIONS = [
  "next",
  "previous",
  "first",
  "last",
  "openIssue",
  "toList",
  "focusFilter",
  "create",
  "toggleMode",
  "labels",
  "assignees",
  "milestone",
  "comment",
  "editTitle",
  "closeReopen",
  "send",
  "imageOpen",
  "imageClose",
  "help",
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * The GitHub preset: GitHub's own shortcuts where it has one (j/k, o, s and /, Ctrl+/, c, l, a,
 * m, r, ?), beghu's where it doesn't. Escape is shared: whichever of its touchpoints was offered
 * last takes it (a lightbox over the panel closes first). `?` has a chord too, for a picker.
 */
export const GITHUB: Readonly<Record<Action, readonly string[]>> = {
  next: ["j"],
  previous: ["k"],
  first: [],
  last: [],
  openIssue: ["o"],
  toList: ["Escape"],
  focusFilter: ["/", "s", "Mod+/"],
  create: ["c"],
  toggleMode: ["t"],
  labels: ["l"],
  assignees: ["a"],
  milestone: ["m"],
  comment: ["r"],
  editTitle: ["e"],
  closeReopen: ["Shift+x"],
  send: ["Mod+Enter"],
  imageOpen: ["i"],
  imageClose: ["Escape"],
  help: ["?", "Ctrl+?"],
};

/**
 * Where the focus is: nowhere in particular (`page`), the list, the issue panel, the comment box,
 * a picker, the filter box, the `?` overlay, or another text field. Views mark their region with
 * `data-keys`.
 */
export type Area = "page" | "list" | "panel" | "composer" | "picker" | "filter" | "help" | "text";

/** The areas where text is typed: there only Ctrl or Cmd chords fire, and plain keys go to the widget. */
export const TYPING: readonly Area[] = ["composer", "picker", "filter", "text"];

const BROWSE: readonly Area[] = ["page", "list", "panel"];
const ANYWHERE: readonly Area[] = ["page", "list", "panel", ...TYPING];

/** The areas each touchpoint works in. An issue's write keys need the focus in its panel. */
export const WHERE: Readonly<Record<Action, readonly Area[]>> = {
  next: BROWSE,
  previous: BROWSE,
  first: BROWSE,
  last: BROWSE,
  openIssue: ["page", "list"],
  toList: ["panel"],
  focusFilter: ANYWHERE,
  create: BROWSE,
  toggleMode: ["page", "list"],
  labels: ["panel"],
  assignees: ["panel"],
  milestone: ["panel"],
  comment: ["panel"],
  editTitle: ["panel"],
  closeReopen: ["panel"],
  send: ["composer"],
  imageOpen: ["panel"],
  imageClose: BROWSE,
  help: ANYWHERE,
};

/**
 * Fixed keys, not rebindable, each in its area: the ARIA list keys while the focus is in the
 * list, and Escape out of the comment box into the issue.
 */
const FIXED: Partial<Record<Area, Readonly<Record<string, Action>>>> = {
  list: { ArrowDown: "next", ArrowUp: "previous", Home: "first", End: "last" },
  composer: { Escape: "openIssue" },
};

/** Whether `binding` can fire in `where`: while text is typed, only a Ctrl or Cmd chord without Alt. */
function firesIn(binding: string, where: Area): boolean {
  if (!TYPING.includes(where)) return true;
  const p = parse(binding);
  return p !== undefined && (p.ctrl || p.meta) && !p.alt;
}

/** The keys that run `action` in `where` now: its bindings that fire there, and the area's fixed keys. */
export function keysIn(action: Action, where: Area): string[] {
  const fixed = FIXED[where] ?? {};
  const bound = WHERE[action].includes(where) ? keymap()[action].filter((b) => firesIn(b, where)) : [];
  return [...bound, ...Object.keys(fixed).filter((k) => fixed[k] === action)];
}

/** An account's own bindings, as #113 stores them: absent is the preset's, "" is unbound. */
export type Overrides = Partial<Record<Action, string>>;

/** A binding `setKeymap` refused, and why. */
export type Refused = { action: Action; binding: string; reason: string };

/** Whether this is a Mac: `Mod` is Cmd there, and Ctrl+Alt isn't AltGr. */
export const MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform);

type Parsed = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string };

/** A binding's parts; `Mod` is Cmd on a Mac and Ctrl elsewhere. Undefined if it isn't one. */
function parse(binding: string): Parsed | undefined {
  // The key is whatever follows the last "+" joining a modifier ("Ctrl++" is Ctrl and "+").
  const m = /^((?:(?:Ctrl|Alt|Shift|Meta|Mod)\+)*)(.+)$/.exec(binding);
  if (!m) return undefined;
  const mods = m[1]!.split("+").filter(Boolean);
  const p: Parsed = { ctrl: false, alt: false, shift: false, meta: false, key: m[2]! };
  for (const mod of mods) {
    if (mod === "Mod") p[MAC ? "meta" : "ctrl"] = true;
    else p[mod.toLowerCase() as "ctrl" | "alt" | "shift" | "meta"] = true;
  }
  // A named key is one word ("Escape", "ArrowDown", "F2"); with Alt, a physical key's code.
  if ((p.alt || p.key.length > 1) && !/^[A-Z][A-Za-z]*\d*$/.test(p.key)) return undefined;
  return p;
}

/** A key as bindings compare it: a character in lower case, a named key as it is. */
const norm = (key: string) => (key.length === 1 ? key.toLowerCase() : key);

/**
 * The letter `e` types, for a Latin binding: on a layout that types another script (Cyrillic,
 * Greek), the Latin letter of the key's place.
 */
function letterOf(e: KeyboardEvent): string {
  if (/^\p{L}$/u.test(e.key) && !/^[a-z]$/i.test(e.key) && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  return e.key.toLowerCase();
}

/** Whether `e` is the key `p` names. */
function matches(p: Parsed, e: KeyboardEvent): boolean {
  if (e.ctrlKey !== p.ctrl || e.metaKey !== p.meta || e.altKey !== p.alt) return false;
  if (p.alt) return e.code === p.key && e.shiftKey === p.shift;
  // A letter matches either case, Shift deciding (so Caps Lock changes nothing); other characters
  // already say whether Shift was down ("?").
  if (p.key.length === 1) {
    if (/^[a-z]$/i.test(p.key)) return letterOf(e) === norm(p.key) && e.shiftKey === p.shift;
    if (norm(p.key) !== p.key.toUpperCase()) return norm(e.key) === norm(p.key) && e.shiftKey === p.shift;
    return e.key === p.key;
  }
  return e.key === p.key && e.shiftKey === p.shift;
}

/** Keys the browser or the OS keeps, with Ctrl or Cmd (`Mod`): tabs, windows, history, find… */
const RESERVED_MOD = new Set(["t", "w", "n", "q", "r", "l", "d", "f", "g", "h", "j", "o", "p", "s", "u", "Tab", "PageUp", "PageDown", "+", "-", "=", "0"]);
/** The same, with Ctrl or Cmd and Shift. */
const RESERVED_MOD_SHIFT = new Set(["t", "n", "w", "q", "i", "j", "c", "Delete"]);

/** Why `binding` can't be bound, or undefined if it can. */
export function refusal(binding: string): string | undefined {
  const p = parse(binding);
  if (!p) return "That isn't a key";
  if (["Control", "Alt", "Shift", "Meta", "CapsLock"].includes(p.key)) return "A modifier needs a key with it";
  if (p.key === "Tab" && !p.ctrl && !p.meta && !p.alt) return "Tab moves the focus";
  if (!MAC && p.ctrl && p.alt) return "Ctrl+Alt types characters on many layouts (AltGr)";
  if (/^F(5|11|12)$/.test(p.key)) return "The browser keeps this key";
  if (p.alt && !p.ctrl && !p.meta && ["ArrowLeft", "ArrowRight", "Home", "F4", "Tab"].includes(p.key)) return "The browser keeps this key";
  const mod = (p.ctrl || p.meta) && !p.alt;
  if (mod && (/^\d$/.test(p.key) || RESERVED_MOD.has(norm(p.key)))) return "The browser keeps this key";
  if (mod && p.shift && RESERVED_MOD_SHIFT.has(norm(p.key))) return "The browser keeps this key";
  return undefined;
}

/**
 * The keymap in effect for `overrides`: each action's own binding, or else the preset's. A
 * preset key the account has given to another action stays theirs: the preset's action loses it.
 */
function keymapOf(overrides: Overrides): Record<Action, string[]> {
  const taken = new Set(Object.values(overrides).filter((b) => b));
  const out = {} as Record<Action, string[]>;
  for (const a of ACTIONS) {
    const own = overrides[a];
    out[a] = own === undefined ? GITHUB[a].filter((b) => !taken.has(b)) : own === "" ? [] : [own];
  }
  return out;
}

const [keymap, setKeymapSignal] = createSignal<Record<Action, string[]>>(keymapOf({}));
export { keymap };

/**
 * Puts the account's bindings in effect, at once. A browser-reserved or malformed binding is
 * refused (the preset's stays) and returned with its reason.
 */
export function setKeymap(overrides: Overrides): Refused[] {
  const refused: Refused[] = [];
  const ok: Overrides = {};
  for (const a of ACTIONS) {
    const b = overrides[a];
    if (b === undefined) continue;
    const why = b === "" ? undefined : refusal(b);
    if (why) refused.push({ action: a, binding: b, reason: why });
    else ok[a] = b;
  }
  setKeymapSignal(keymapOf(ok));
  return refused;
}

/** The touchpoints on offer: each action's handlers, the latest last. */
const handlers = new Map<Action, { run: () => void; seq: number }[]>();
let seq = 0;
const [offered, setOffered] = createSignal(0);
/** Tells the hint bar and the overlay the offers changed: after the current update, never inside it. */
const changed = () => queueMicrotask(() => setOffered((n) => n + 1));

/**
 * Offers `action`: its key runs `run`. The latest offer of an action wins until it's withdrawn,
 * which happens with the calling component (or by calling the result).
 */
export function touch(action: Action, run: () => void): () => void {
  const entry = { run, seq: ++seq };
  const list = handlers.get(action) ?? [];
  list.push(entry);
  handlers.set(action, list);
  changed();
  const withdraw = () => {
    const now = handlers.get(action);
    const at = now?.indexOf(entry) ?? -1;
    if (at < 0) return;
    now!.splice(at, 1);
    changed();
  };
  if (getOwner()) onCleanup(withdraw);
  return withdraw;
}

/** Whether `action` is on offer now. Reactive. */
export function available(action: Action): boolean {
  offered();
  return (handlers.get(action)?.length ?? 0) > 0;
}

/** Runs `action`'s touchpoint: the latest offer of it. */
function trigger(action: Action): void {
  handlers.get(action)?.at(-1)?.run();
}

/** Whether `el` takes typing: there, single keys type. */
function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !["button", "checkbox", "radio", "range", "reset", "submit", "color", "file", "image"].includes((el as HTMLInputElement).type);
}

function areaOf(el: Element | null): Area {
  if (!el || el.tagName === "BODY") return "page";
  const marked = el.closest<HTMLElement>("[data-keys]")?.dataset.keys as Area | undefined;
  if (marked === "filter" || marked === "picker" || marked === "help" || marked === "composer") return marked;
  if (isTextField(el)) return "text";
  return marked ?? "page";
}

const [area, setArea] = createSignal<Area>("page");
/** Where the focus is now. Reactive. */
export { area };

/** The action `e` asks for in `where`, among those on offer: the latest offered wins. */
function actionFor(e: KeyboardEvent, where: Area): Action | undefined {
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  const fixed = plain && !e.shiftKey ? FIXED[where]?.[e.key] : undefined;
  if (fixed && available(fixed)) return fixed;
  if (TYPING.includes(where) && !((e.ctrlKey || e.metaKey) && !e.altKey)) return undefined;
  const map = keymap();
  let best: { action: Action; seq: number } | undefined;
  for (const a of ACTIONS) {
    const h = handlers.get(a)?.at(-1);
    if (!h || (best && h.seq < best.seq) || !WHERE[a].includes(where)) continue;
    const hit = map[a].some((b) => {
      const p = parse(b);
      return p !== undefined && matches(p, e);
    });
    if (hit) best = { action: a, seq: h.seq };
  }
  return best?.action;
}

document.addEventListener("focusin", () => setArea(areaOf(document.activeElement)));
document.addEventListener("focusout", (e) => setArea(areaOf(e.relatedTarget as Element | null)));
// On the window, so it hears a key after the widgets (Solid delegates their handlers to the
// document): one that took the key has prevented its default. A key AltGr is down for, or one an
// input method is composing, is the text's.
window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.getModifierState("AltGraph") || e.isComposing || e.keyCode === 229) return;
  const where = areaOf(document.activeElement);
  if (where === "help") return;
  const action = actionFor(e, where);
  if (action === undefined) return;
  e.preventDefault();
  trigger(action);
});
