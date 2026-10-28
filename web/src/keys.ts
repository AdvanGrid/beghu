// The keys module: every shortcut in the app goes through here. Views never listen for keys;
// they offer named touchpoints (`touch`), and one keydown listener on the window maps a key
// to a touchpoint through the keymap in effect. Where the focus is (`area`) decides which
// touchpoints the hint bar and the `?` overlay show, and the list's ARIA keys apply only there.
//
// The keymap is the GitHub preset with the account's own bindings over it (`setKeymap`, from
// `/api/me`; the setup page, Prefs.tsx, changes them): each action's bindings, one per line, ""
// for one deliberately left unbound. A binding is a key written `Ctrl+Shift+x`, or a sequence of
// two plain keys written `g i`. One with Alt names the physical key (`Alt+KeyL`, matched on
// `e.code`), since Alt changes the character a key types on macOS and on many layouts. While
// text is typed (a text field, a picker), only Ctrl or Cmd chords without Alt fire: Alt and AltGr
// type characters there, and a sequence's keys are plain. Browser-reserved keys are refused
// (`refusal`). A preset key the account gave to another action stays theirs: the preset's action
// loses it, unbound if it had no other (as a new action does whose default an account already
// uses). A keymap change applies at once, except mid sequence: a sequence finishes on the map it
// started on.
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
// `blockedBy`, `blocking` and `relatesTo` are offered by an issue's Links row (Relationships.tsx)
// and open that kind's relationship picker, as the property rows' keys do theirs.
//
// `editTitle` (`e`) is offered by an issue's panel (not a PR's) and opens its title editor. A
// title or body editor is marked `data-keys="editor"`, a typing area: while the focus is in it, it
// offers `saveEdit` (Ctrl or Cmd+Enter) and `cancelEdit` (Escape, fixed there). Enter in the title
// box saves too, as its form's own submit.
//
// `create` is offered by the filter bar, always there: it opens the create form in the panel
// (CreateIssue.tsx), whose rows offer `labels`, `assignees` and `milestone` as an issue's do.
//
// `imageOpen` is offered by the issue panel while a post in it shows an image the lightbox can
// open: it opens the focused image (images are in the Tab order), else the first one in view.
// The lightbox offers `imageClose` while it's open; it's marked `data-keys="lightbox"`, an area
// where nothing else runs, so j/k and the list's keys don't drive the list behind it.
//
// Some touchpoints have no caller yet, pending their tickets: `toggleMode` for tree mode (#108).
// The `?` overlay shows it dimmed until then.
//
// This file is in first-load JS, so it holds only what dispatch needs; the words the hint bar
// and the overlay show are in Hints.tsx, loaded after first paint.
import { createSignal, getOwner, onCleanup } from "solid-js";
import type { KeyAction } from "./bindings/KeyAction";

/** The touchpoints the app offers to the keys module: the server's key actions (prefs.rs). */
export type Action = KeyAction;

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
  blockedBy: ["b"],
  blocking: ["Shift+b"],
  relatesTo: ["Shift+r"],
  comment: ["r"],
  editTitle: ["e"],
  closeReopen: ["Shift+x"],
  send: ["Mod+Enter"],
  saveEdit: ["Mod+Enter"],
  cancelEdit: [],
  imageOpen: ["i"],
  imageClose: ["Escape"],
  help: ["?", "Ctrl+?"],
};

/** Every action, in the preset's order. */
export const ACTIONS = Object.keys(GITHUB) as Action[];

/**
 * Where the focus is: nowhere in particular (`page`), the list, the issue panel, the comment box,
 * a title or body editor, a picker, the filter box, the `?` overlay, the lightbox, or another text
 * field. Views mark their region with `data-keys`.
 */
export type Area = "page" | "list" | "panel" | "composer" | "editor" | "picker" | "filter" | "help" | "lightbox" | "text";

/** The areas where text is typed: there only Ctrl or Cmd chords fire, and plain keys go to the widget. */
export const TYPING: readonly Area[] = ["composer", "editor", "picker", "filter", "text"];

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
  blockedBy: ["panel"],
  blocking: ["panel"],
  relatesTo: ["panel"],
  comment: ["panel"],
  editTitle: ["panel"],
  closeReopen: ["panel"],
  send: ["composer"],
  saveEdit: ["editor"],
  cancelEdit: ["editor"],
  imageOpen: ["panel"],
  imageClose: ["lightbox", ...BROWSE],
  help: ANYWHERE,
};

/**
 * Fixed keys, not rebindable, each in its area: the ARIA list keys while the focus is in the
 * list, Escape out of the comment box into the issue, and Escape cancelling an edit.
 */
const FIXED: Partial<Record<Area, Readonly<Record<string, Action>>>> = {
  list: { ArrowDown: "next", ArrowUp: "previous", Home: "first", End: "last" },
  composer: { Escape: "openIssue" },
  editor: { Escape: "cancelEdit" },
};

/** Whether `binding` can fire in `where`: while text is typed, only a Ctrl or Cmd chord without Alt. */
function firesIn(binding: string, where: Area): boolean {
  if (!TYPING.includes(where)) return true;
  const p = parse(binding);
  return p !== undefined && p.length === 1 && (p[0]!.ctrl || p[0]!.meta) && !p[0]!.alt;
}

/** The keys that run `action` in `where` now: its bindings that fire there, and the area's fixed keys. */
export function keysIn(action: Action, where: Area): string[] {
  const fixed = FIXED[where] ?? {};
  const bound = WHERE[action].includes(where) ? keymap()[action].filter((b) => firesIn(b, where)) : [];
  return [...bound, ...Object.keys(fixed).filter((k) => fixed[k] === action)];
}

/**
 * An account's own bindings, as `/api/me` carries them: each action's, one per line; absent is
 * the preset's, "" is unbound.
 */
export type Overrides = Partial<Record<Action, string>>;

/** A binding `setKeymap` refused, and why. */
export type Refused = { action: Action; binding: string; reason: string };

/** Whether this is a Mac: `Mod` is Cmd there, and Ctrl+Alt isn't AltGr. */
export const MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** One key of a binding, with its modifiers. */
type Key = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; key: string };

/** One key's parts; `Mod` is Cmd on a Mac and Ctrl elsewhere. Undefined if it isn't one. */
function parseKey(step: string): Key | undefined {
  // The key is whatever follows the last "+" joining a modifier ("Ctrl++" is Ctrl and "+").
  const m = /^((?:(?:Ctrl|Alt|Shift|Meta|Mod)\+)*)(.+)$/.exec(step);
  if (!m) return undefined;
  const mods = m[1]!.split("+").filter(Boolean);
  const p: Key = { ctrl: false, alt: false, shift: false, meta: false, key: m[2]! };
  for (const mod of mods) {
    if (mod === "Mod") p[MAC ? "meta" : "ctrl"] = true;
    else p[mod.toLowerCase() as "ctrl" | "alt" | "shift" | "meta"] = true;
  }
  // A named key is one word ("Escape", "ArrowDown", "F2", "Space"); with Alt, a physical key's code.
  if ((p.alt || p.key.length > 1) && !/^[A-Z][A-Za-z]*\d*$/.test(p.key)) return undefined;
  return p;
}

/** A binding's keys: one, or a sequence of two. Undefined if it isn't a binding. */
function parse(binding: string): Key[] | undefined {
  const steps = binding.split(" ").map(parseKey);
  return steps.length > 0 && steps.length <= 2 && steps.every((k) => k !== undefined) ? (steps as Key[]) : undefined;
}

/** Whether a key has no Ctrl, Cmd or Alt: what a sequence's keys must be. */
const plain = (k: Key) => !k.ctrl && !k.meta && !k.alt;

/** A key as bindings compare it: a character in lower case, a named key as it is. */
const norm = (key: string) => (key.length === 1 ? key.toLowerCase() : key);

/** Whether two keys are the same key on this platform (`Mod+x` is `Ctrl+x` off a Mac). */
const sameKey = (a: Key, b: Key) => a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta && norm(a.key) === norm(b.key);

/**
 * Whether two bindings get in each other's way: the same keys, or one a single key the other's
 * sequence starts with (it would fire before the sequence could go on).
 */
export function clash(a: string, b: string): boolean {
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return a === b;
  if (x.length !== y.length) return sameKey(x[0]!, y[0]!);
  return x.every((k, i) => sameKey(k, y[i]!));
}

/**
 * Actions that share a key on purpose, in the same areas: whichever was offered last takes it
 * (a lightbox's Escape closes it before the panel's goes back to the list).
 */
const SHARED: readonly (readonly Action[])[] = [["toList", "imageClose"]];

/** Whether a key bound to both `a` and `b` would be in the way: they work in an area together. */
export function overlap(a: Action, b: Action): boolean {
  if (a === b || SHARED.some((g) => g.includes(a) && g.includes(b))) return false;
  return WHERE[a].some((w) => WHERE[b].includes(w));
}

/**
 * The letter `e` types, for a Latin binding: on a layout that types another script (Cyrillic,
 * Greek), the Latin letter of the key's place.
 */
function letterOf(e: KeyboardEvent): string {
  if (/^\p{L}$/u.test(e.key) && !/^[a-z]$/i.test(e.key) && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase();
  return e.key.toLowerCase();
}

/** Whether `e` is the key `p` names. */
function matches(p: Key, e: KeyboardEvent): boolean {
  if (e.ctrlKey !== p.ctrl || e.metaKey !== p.meta || e.altKey !== p.alt) return false;
  if (p.alt) return e.code === p.key && e.shiftKey === p.shift;
  // A letter matches either case, Shift deciding (so Caps Lock changes nothing); other characters
  // already say whether Shift was down ("?").
  if (p.key.length === 1) {
    if (/^[a-z]$/i.test(p.key)) return letterOf(e) === norm(p.key) && e.shiftKey === p.shift;
    if (norm(p.key) !== p.key.toUpperCase()) return norm(e.key) === norm(p.key) && e.shiftKey === p.shift;
    return e.key === p.key;
  }
  if (p.key === "Space") return e.key === " " && e.shiftKey === p.shift;
  return e.key === p.key && e.shiftKey === p.shift;
}

/** The modifiers alone: no key yet. */
const MODIFIERS = new Set(["Control", "Alt", "AltGraph", "Shift", "Meta", "CapsLock", "Fn", "OS", "Hyper", "Super"]);

/**
 * The key `e` is, as a binding writes it (`Mod+Shift+k`, `Alt+KeyL`, `?`, `Space`), for the setup
 * page to record; undefined for a modifier pressed alone. Ctrl (Cmd on a Mac) is written `Mod`, so
 * a binding made on one follows the account to the other.
 */
export function keyOf(e: KeyboardEvent): string | undefined {
  if (MODIFIERS.has(e.key)) return undefined;
  // Alt names the key by its place, so the character it types doesn't matter: on a Mac, Option+E
  // or Option+U is a dead key (an accent waiting for its letter), and still a key to bind.
  const byPlace = e.altKey && /^(Key[A-Z]|Digit\d)$/.test(e.code);
  if (!byPlace && (e.key === "Dead" || e.key === "Unidentified")) return undefined;
  const mods: string[] = [];
  if (MAC ? e.metaKey : e.ctrlKey) mods.push("Mod");
  if (MAC ? e.ctrlKey : e.metaKey) mods.push(MAC ? "Ctrl" : "Meta");
  if (e.altKey) mods.push("Alt");
  let key: string;
  let shift = e.shiftKey;
  if (e.altKey) key = e.code;
  else if (e.key === " ") key = "Space";
  else if (e.key.length === 1) {
    const letter = letterOf(e);
    if (/^[a-z]$/.test(letter)) key = letter;
    else {
      // A character other than a letter says whether Shift was down ("?").
      key = e.key;
      shift = false;
    }
  } else key = e.key;
  if (shift) mods.push("Shift");
  return [...mods, key].join("+");
}

/** Keys the browser or the OS keeps, with Ctrl or Cmd (`Mod`): tabs, windows, history, find… */
const RESERVED_MOD = new Set(["t", "w", "n", "q", "r", "l", "d", "f", "g", "h", "j", "o", "p", "s", "u", "Tab", "PageUp", "PageDown", "+", "-", "=", "0"]);
/** The same, with Ctrl or Cmd and Shift. */
const RESERVED_MOD_SHIFT = new Set(["t", "n", "w", "q", "i", "j", "c", "Delete"]);

/** Why one key can't be bound, or undefined if it can. */
function keyRefusal(p: Key): string | undefined {
  if (MODIFIERS.has(p.key)) return "A modifier needs a key with it";
  if (p.key === "Tab" && !p.ctrl && !p.meta && !p.alt) return "Tab moves the focus";
  if (!MAC && p.ctrl && p.alt) return "Ctrl+Alt types characters on many layouts (AltGr)";
  if (/^F(5|11|12)$/.test(p.key)) return "The browser keeps this key";
  if (p.alt && !p.ctrl && !p.meta && ["ArrowLeft", "ArrowRight", "Home", "F4", "Tab"].includes(p.key)) return "The browser keeps this key";
  const mod = (p.ctrl || p.meta) && !p.alt;
  if (mod && (/^\d$/.test(p.key) || RESERVED_MOD.has(norm(p.key)))) return "The browser keeps this key";
  if (mod && p.shift && RESERVED_MOD_SHIFT.has(norm(p.key))) return "The browser keeps this key";
  return undefined;
}

/** Why `binding` can't be bound, or undefined if it can. */
export function refusal(binding: string): string | undefined {
  if (binding.split(" ").length > 2) return "A sequence is two keys";
  const p = parse(binding);
  if (!p) return "That isn't a key";
  if (p.length === 2 && !p.every(plain)) return "A sequence's keys go without Ctrl, Cmd or Alt";
  for (const k of p) {
    const why = keyRefusal(k);
    if (why) return why;
  }
  return undefined;
}

/** What an area's own keys are, as the setup page says why one can't be bound there. */
const FIXED_WHY: Partial<Record<Area, string>> = {
  list: "The list keeps the arrow keys, Home and End",
  composer: "Escape leaves the comment box",
  editor: "Escape cancels an edit",
};

/**
 * Why `binding` can't be bound to `action`, or undefined if it can: a key the browser keeps, a
 * key an area `action` works in keeps for itself (or a sequence starting with one), or a plain key
 * for an action that only works while text is typed.
 */
export function refusalFor(action: Action, binding: string): string | undefined {
  const why = refusal(binding);
  if (why) return why;
  // A key an area keeps never reaches the keymap there: alone, or as a sequence's first key.
  const p = parse(binding)!;
  if (plain(p[0]!) && !p[0]!.shift) {
    const at = WHERE[action].find((w) => FIXED[w]?.[p[0]!.key] !== undefined);
    if (at) return FIXED_WHY[at];
  }
  if (WHERE[action].every((w) => TYPING.includes(w)) && !firesIn(binding, WHERE[action][0]!)) return "This works while you type: it needs Ctrl or Cmd";
  return undefined;
}

/** An action's own bindings, if it has any of its own: [] for "" (unbound). */
function own(overrides: Overrides, a: Action): string[] | undefined {
  const o = overrides[a];
  return o === undefined ? undefined : o.split("\n").filter((b) => b !== "");
}

/**
 * The keymap in effect for `overrides`: each action's own bindings, or else the preset's. A
 * preset key the account has given to another action (one that works in an area with it) stays
 * theirs: the preset's action loses it.
 */
function keymapOf(overrides: Overrides): Record<Action, string[]> {
  const out = {} as Record<Action, string[]>;
  for (const a of ACTIONS) {
    out[a] = own(overrides, a) ?? GITHUB[a].filter((k) => !ACTIONS.some((b) => overlap(a, b) && own(overrides, b)?.some((x) => clash(x, k))));
  }
  return out;
}

const [keymap, setKeymapSignal] = createSignal<Record<Action, string[]>>(keymapOf({}));
/** The keymap in effect: each action's bindings. Reactive. */
export { keymap };

const [overrides, setOverrides] = createSignal<Overrides>({});
/** The account's own bindings, as last set (refused ones left out). Reactive. */
export { overrides };

/** A keymap waiting for the sequence under way to finish. */
let deferred: Record<Action, string[]> | undefined;

/**
 * Puts the account's bindings in effect: at once, or once a sequence under way has finished. A
 * browser-reserved or malformed binding is refused and returned with its reason; the action keeps
 * its others, or the preset's if it had none.
 */
export function setKeymap(given: Overrides): Refused[] {
  const refused: Refused[] = [];
  const ok: Overrides = {};
  for (const a of ACTIONS) {
    const lines = own(given, a);
    if (lines === undefined) continue;
    const kept = lines.filter((b) => {
      const why = refusalFor(a, b);
      if (why) refused.push({ action: a, binding: b, reason: why });
      return !why;
    });
    if (kept.length > 0 || lines.length === 0) ok[a] = kept.join("\n");
  }
  setOverrides(ok);
  const map = keymapOf(ok);
  if (pending) deferred = map;
  else setKeymapSignal(map);
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
export function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !["button", "checkbox", "radio", "range", "reset", "submit", "color", "file", "image"].includes((el as HTMLInputElement).type);
}

function areaOf(el: Element | null): Area {
  if (!el || el.tagName === "BODY") return "page";
  const marked = el.closest<HTMLElement>("[data-keys]")?.dataset.keys as Area | undefined;
  if (marked === "filter" || marked === "picker" || marked === "help" || marked === "composer" || marked === "editor") return marked;
  if (isTextField(el)) return "text";
  return marked ?? "page";
}

const [area, setArea] = createSignal<Area>("page");
/** Where the focus is now. Reactive. */
export { area };

/** The latest offered of `actions`, among those on offer that work in `where`. */
function latest(actions: Iterable<Action>, where: Area): Action | undefined {
  let best: { action: Action; seq: number } | undefined;
  for (const a of actions) {
    const h = handlers.get(a)?.at(-1);
    if (!h || (best && h.seq < best.seq) || !WHERE[a].includes(where)) continue;
    best = { action: a, seq: h.seq };
  }
  return best?.action;
}

/** The actions with a binding in `map` that `fits`. */
function bound(map: Record<Action, string[]>, fits: (keys: Key[]) => boolean): Action[] {
  return ACTIONS.filter((a) =>
    map[a].some((b) => {
      const p = parse(b);
      return p !== undefined && fits(p);
    }),
  );
}

/** The action `e` asks for in `where`, among those on offer: the latest offered wins. */
function actionFor(e: KeyboardEvent, where: Area): Action | undefined {
  const plainKey = !e.ctrlKey && !e.metaKey && !e.altKey;
  const fixed = plainKey && !e.shiftKey ? FIXED[where]?.[e.key] : undefined;
  if (fixed && available(fixed)) return fixed;
  if (TYPING.includes(where) && !((e.ctrlKey || e.metaKey) && !e.altKey)) return undefined;
  return latest(bound(keymap(), (p) => p.length === 1 && matches(p[0]!, e)), where);
}

/** How long a sequence waits for its second key. */
const SEQUENCE_MS = 1500;

/** A sequence under way: its first key, the keymap it started on, and its timeout. */
let pending: { first: Key; map: Record<Action, string[]>; timer: ReturnType<typeof setTimeout> } | undefined;

/** The sequence under way is over: a keymap that arrived meanwhile takes effect. */
function endSequence(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending = undefined;
  if (deferred) setKeymapSignal(deferred);
  deferred = undefined;
}

/** Starts a sequence if `e` is the first key of one on offer in `where`; whether it did. */
function startSequence(e: KeyboardEvent, where: Area): boolean {
  if (TYPING.includes(where) || e.ctrlKey || e.metaKey || e.altKey) return false;
  const map = keymap();
  if (latest(bound(map, (p) => p.length === 2 && matches(p[0]!, e)), where) === undefined) return false;
  const first = parseKey(keyOf(e)!);
  if (!first) return false;
  pending = { first, map, timer: setTimeout(endSequence, SEQUENCE_MS) };
  return true;
}

document.addEventListener("focusin", () => setArea(areaOf(document.activeElement)));
document.addEventListener("focusout", (e) => setArea(areaOf(e.relatedTarget as Element | null)));
// On the window, so it hears a key after the widgets (Solid delegates their handlers to the
// document): one that took the key has prevented its default. A key AltGr is down for, or one an
// input method is composing, is the text's.
window.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.getModifierState("AltGraph") || e.isComposing || e.keyCode === 229) return;
  // Holding Shift for a sequence's second key isn't that key yet.
  if (MODIFIERS.has(e.key)) return;
  const where = areaOf(document.activeElement);
  if (where === "help") return endSequence();
  // A sequence's second key, on the keymap it started on; any other key ends it, and counts as itself.
  if (pending) {
    const { first, map } = pending;
    endSequence();
    const second = TYPING.includes(where) ? undefined : latest(bound(map, (p) => p.length === 2 && sameKey(p[0]!, first) && matches(p[1]!, e)), where);
    if (second) {
      e.preventDefault();
      trigger(second);
      return;
    }
  }
  const action = actionFor(e, where);
  if (action !== undefined) {
    e.preventDefault();
    trigger(action);
  } else if (startSequence(e, where)) e.preventDefault();
});
