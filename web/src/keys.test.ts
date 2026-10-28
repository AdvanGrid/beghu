// The keys module on its own, in Node: synthetic key events against stand-in elements, with no
// view involved. An exception to "tests go through public seams" (AGENTS.md): the browser suite
// can't drive what this covers. It runs on one platform and one layout, with no input method, so
// a Mac's Cmd and Alt, AltGr, a non-Latin layout and IME composition are only reachable here,
// as is what the setup page records for a Mac's keys and a non-Latin letter (`keyOf`; an Alt
// binding is set through the module's own `setKeymap` to reach them); and no view yet
// offers some touchpoints (tree mode) to reach their areas through. What the browser can
// drive (j/k, the list's arrows, Escape out of the comment box, the lightbox's keys) is in
// e2e/keys.spec.ts and e2e/media.spec.ts, and rebinding (swaps, refusals, sequences, other tabs)
// through the setup page in e2e/prefs.spec.ts, not here.
// `npm run test:lint`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

type Keys = typeof import("./keys.ts");

/** A stand-in element: what the keys module reads of one (its tag, type and `data-keys` region). */
class El {
  dataset: Record<string, string> = {};
  isContentEditable = false;
  readonly tagName: string;
  readonly parent: El | undefined;
  readonly type: string;
  constructor(tagName: string, parent?: El, keys?: string, type = "text") {
    this.tagName = tagName;
    this.parent = parent;
    this.type = type;
    if (keys) this.dataset.keys = keys;
  }
  closest(selector: string): El | null {
    assert.equal(selector, "[data-keys]");
    for (let e: El | undefined = this; e; e = e.parent) if (e.dataset.keys !== undefined) return e;
    return null;
  }
}

/** The page's regions, as the views mark them, and a focusable element in each area. */
function page() {
  const body = new El("BODY");
  const listPane = new El("DIV", body, "list");
  const panel = new El("SECTION", body, "panel");
  const picker = new El("DIV", panel, "picker");
  return {
    body,
    page: body,
    list: new El("A", listPane),
    panel: new El("DIV", panel),
    composer: new El("TEXTAREA", panel, "composer"),
    editor: new El("INPUT", new El("FORM", panel, "editor")),
    picker: new El("INPUT", picker),
    pickerOption: new El("DIV", picker),
    filter: new El("INPUT", new El("DIV", listPane, "filter")),
    text: new El("INPUT", panel),
    checkbox: new El("INPUT", panel, undefined, "checkbox"),
    button: new El("INPUT", panel, undefined, "button"),
    help: new El("BUTTON", new El("DIALOG", body, "help")),
    lightbox: new El("BUTTON", new El("DIALOG", body, "lightbox")),
  };
}

type Press = { key: string; code?: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean; altGraph?: boolean; isComposing?: boolean; keyCode?: number; prevented?: boolean };

/**
 * A fresh copy of the keys module on `platform`, with its own window and document: `press`
 * focuses an element and sends a key, saying whether the module took it.
 */
async function load(platform: string) {
  const window = new EventTarget();
  const els = page();
  const document = Object.assign(new EventTarget(), { activeElement: els.body as El | null, body: els.body });
  Object.assign(globalThis, { window, document });
  Object.defineProperty(globalThis.navigator, "platform", { value: platform, configurable: true });
  const keys = (await import(`./keys.ts?${platform}-${Math.random()}`)) as Keys;
  const press = (at: El, p: Press): boolean => {
    document.activeElement = at;
    document.dispatchEvent(new Event("focusin"));
    const e = Object.assign(new Event("keydown", { cancelable: true }), {
      key: p.key,
      code: p.code ?? "",
      ctrlKey: !!p.ctrl,
      altKey: !!p.alt,
      shiftKey: !!p.shift,
      metaKey: !!p.meta,
      isComposing: !!p.isComposing,
      keyCode: p.keyCode ?? 0,
      getModifierState: (m: string) => m === "AltGraph" && !!p.altGraph,
    });
    // A widget that took the key first.
    if (p.prevented) e.preventDefault();
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };
  return { keys, els, press };
}

/** A key press as a binding writes it (`Shift+x`, `Alt+KeyL`, `Mod+Enter`), on `mac` or not. */
function asPress(binding: string, mac: boolean): Press {
  const parts = binding.split(/\+(?=.)/);
  const key = parts.pop()!;
  const has = (m: string) => parts.includes(m);
  const p: Press = {
    key,
    ctrl: has("Ctrl") || (has("Mod") && !mac),
    meta: has("Meta") || (has("Mod") && mac),
    alt: has("Alt"),
    shift: has("Shift"),
  };
  if (p.alt) return { ...p, code: key, key: "ł" };
  if (/^[a-z]$/.test(key)) return { ...p, key: p.shift ? key.toUpperCase() : key, code: `Key${key.toUpperCase()}` };
  return p;
}

for (const platform of ["Linux x86_64", "MacIntel"]) {
  const mac = platform === "MacIntel";
  describe(`on ${platform}`, () => {
    it("drives every touchpoint by its binding, in each area it works in", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      for (const action of keys.ACTIONS) {
        const where = keys.WHERE[action];
        assert.ok(where.length > 0, `${action} works somewhere`);
        const withdraw = keys.touch(action, () => ran.push(action));
        for (const area of where) {
          for (const binding of keys.keymap()[action].filter((b) => !keys.TYPING.includes(area) || /^(Ctrl|Meta|Mod)\+/.test(b))) {
            ran.length = 0;
            assert.ok(press(els[area], asPress(binding, mac)), `${binding} is taken in ${area}`);
            assert.deepEqual(ran, [action], `${binding} runs ${action} in ${area}`);
          }
        }
        withdraw();
      }
    });

    it("keeps Alt and Ctrl+Alt chords out of text fields, where they type characters", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      keys.touch("next", () => ran.push("next"));
      assert.deepEqual(keys.setKeymap({ next: "Alt+KeyL" }), []);
      const altL = { key: mac ? "¬" : "ł", code: "KeyL", alt: true };
      for (const at of [els.composer, els.filter, els.text, els.picker]) assert.equal(press(at, altL), false);
      assert.equal(ran.length, 0);
      // Outside a text field it's a shortcut, unless AltGr is what's down.
      assert.ok(press(els.list, altL));
      assert.equal(press(els.list, { ...altL, altGraph: true }), false);
      assert.deepEqual(ran, ["next"]);

      // Ctrl+Alt is AltGr on Windows and Linux layouts: refused there; on a Mac, still never while typing.
      const ctrlAltL = { key: "l", code: "KeyL", ctrl: true, alt: true };
      if (!mac) {
        assert.deepEqual(keys.setKeymap({ next: "Ctrl+Alt+KeyL" }), [{ action: "next", binding: "Ctrl+Alt+KeyL", reason: "Ctrl+Alt types characters on many layouts (AltGr)" }]);
        assert.equal(keys.refusal("Mod+Alt+KeyL"), "Ctrl+Alt types characters on many layouts (AltGr)");
      } else {
        assert.deepEqual(keys.setKeymap({ next: "Ctrl+Alt+KeyL" }), []);
        for (const at of [els.composer, els.filter]) assert.equal(press(at, ctrlAltL), false);
        assert.deepEqual(ran, ["next"]);
      }
      // A Ctrl or Cmd chord without Alt still fires while typing.
      keys.touch("focusFilter", () => ran.push("focusFilter"));
      assert.deepEqual(keys.setKeymap({ focusFilter: "Mod+Shift+e" }), []);
      assert.ok(press(els.composer, { key: "E", code: "KeyE", shift: true, ctrl: !mac, meta: mac }));
      assert.deepEqual(ran, ["next", "focusFilter"]);
    });

    it("records a key as the binding that the same key then runs: Cmd or Ctrl as Mod, Alt by the key's place", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      keys.touch("next", () => ran.push("next"));
      const presses: [Press, string][] = [
        [{ key: "K", code: "KeyK", shift: true, ctrl: !mac, meta: mac }, "Mod+Shift+k"],
        // Alt types a character on a Mac (and on many layouts): the binding names the key's place.
        [{ key: mac ? "¬" : "ł", code: "KeyL", alt: true }, "Alt+KeyL"],
        // Option+E on a Mac is a dead key (an accent waiting for its letter): still the key in E's place.
        [{ key: "Dead", code: "KeyE", alt: true }, "Alt+KeyE"],
        [{ key: "Dead", code: "Digit6", alt: true, shift: true }, "Alt+Shift+Digit6"],
        // A Russian layout's key in J's place.
        [{ key: "о", code: "KeyJ" }, "j"],
        [{ key: "?", code: "Slash", shift: true }, "?"],
        [{ key: " ", code: "Space" }, "Space"],
      ];
      for (const [p, binding] of presses) {
        const e = Object.assign(new Event("keydown"), { key: p.key, code: p.code, ctrlKey: !!p.ctrl, altKey: !!p.alt, shiftKey: !!p.shift, metaKey: !!p.meta }) as unknown as KeyboardEvent;
        assert.equal(keys.keyOf(e), binding);
        assert.deepEqual(keys.setKeymap({ next: binding }), []);
        ran.length = 0;
        assert.ok(press(els.list, p), `${binding} runs what it was recorded for`);
        assert.deepEqual(ran, ["next"]);
      }
      // A dead key without Alt (an accent key) is no key to bind: what it types isn't known yet.
      assert.equal(keys.keyOf(Object.assign(new Event("keydown"), { key: "Dead", code: "Equal" }) as unknown as KeyboardEvent), undefined);
      // A modifier alone is no key yet.
      assert.equal(keys.keyOf(Object.assign(new Event("keydown"), { key: "Shift", code: "ShiftLeft", shiftKey: true }) as unknown as KeyboardEvent), undefined);
    });

    it("leaves a key alone while an input method composes it", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      keys.touch("next", () => ran.push("next"));
      assert.equal(press(els.list, { key: "j", code: "KeyJ", isComposing: true }), false);
      assert.equal(press(els.list, { key: "j", code: "KeyJ", keyCode: 229 }), false);
      assert.equal(ran.length, 0);
    });

    it("runs an issue's write keys only with the focus in its panel", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      const writes = ["closeReopen", "comment", "labels", "assignees", "milestone", "editTitle", "blockedBy", "blocking", "relatesTo"] as const;
      for (const a of writes) keys.touch(a, () => ran.push(a));
      const keysOf = [
        { key: "X", code: "KeyX", shift: true },
        { key: "r", code: "KeyR" },
        { key: "l", code: "KeyL" },
        { key: "a", code: "KeyA" },
        { key: "m", code: "KeyM" },
        { key: "e", code: "KeyE" },
        { key: "b", code: "KeyB" },
        { key: "B", code: "KeyB", shift: true },
        { key: "R", code: "KeyR", shift: true },
      ];
      for (const at of [els.list, els.body]) for (const k of keysOf) assert.equal(press(at, k), false);
      assert.equal(ran.length, 0);
      for (const k of keysOf) assert.ok(press(els.panel, k));
      assert.deepEqual(ran, [...writes]);
    });

    it("keeps every touchpoint silent outside the areas it works in", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      const areas = ["page", "list", "panel", "composer", "editor", "picker", "filter", "text", "help", "lightbox"] as const;
      for (const action of keys.ACTIONS) {
        const withdraw = keys.touch(action, () => ran.push(action));
        for (const area of areas.filter((a) => !keys.WHERE[action].includes(a))) {
          for (const binding of keys.keymap()[action]) {
            assert.equal(press(els[area], asPress(binding, mac)), false, `${binding} is left alone in ${area}`);
          }
        }
        withdraw();
      }
      assert.deepEqual(ran, []);
    });

    it("gives Escape to the latest of its offers, and to the one before once that's withdrawn", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      keys.touch("toList", () => ran.push("toList"));
      // A lightbox opens over the issue: Escape closes it first.
      const closeImage = keys.touch("imageClose", () => ran.push("imageClose"));
      assert.ok(press(els.panel, { key: "Escape" }));
      closeImage();
      assert.ok(press(els.panel, { key: "Escape" }));
      assert.deepEqual(ran, ["imageClose", "toList"]);
    });

    it("treats a checkbox or a button input as no text field: plain keys still fire there", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      keys.touch("next", () => ran.push("next"));
      assert.ok(press(els.checkbox, { key: "j", code: "KeyJ" }));
      assert.ok(press(els.button, { key: "j", code: "KeyJ" }));
      assert.equal(press(els.text, { key: "j", code: "KeyJ" }), false);
      assert.deepEqual(ran, ["next", "next"]);
    });

    it("leaves a key a widget already took", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      keys.touch("next", () => ran.push("next"));
      keys.touch("toList", () => ran.push("toList"));
      press(els.list, { key: "j", code: "KeyJ", prevented: true });
      press(els.panel, { key: "Escape", prevented: true });
      assert.deepEqual(ran, []);
    });

    it("gives plain keys to a picker, as to the filter box", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      keys.touch("next", () => ran.push("next"));
      keys.touch("help", () => ran.push("help"));
      assert.equal(press(els.pickerOption, { key: "j", code: "KeyJ" }), false);
      assert.equal(press(els.pickerOption, { key: "?", code: "Slash", shift: true }), false);
      // The overlay still opens from a picker, by its chord.
      assert.ok(press(els.pickerOption, { key: "?", code: "Slash", shift: true, ctrl: true }));
      assert.deepEqual(ran, ["help"]);
    });

    it("finds a letter's binding by its key's place on a non-Latin layout", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      keys.touch("next", () => ran.push("next"));
      keys.touch("previous", () => ran.push("previous"));
      assert.ok(press(els.list, { key: "о", code: "KeyJ" })); // Russian
      assert.ok(press(els.list, { key: "κ", code: "KeyK" })); // Greek
      assert.deepEqual(ran, ["next", "previous"]);
    });

    it("sends a comment by its chord from the comment box only, and Escape leaves the box for the issue", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      keys.touch("send", () => ran.push("send"));
      keys.touch("openIssue", () => ran.push("openIssue"));
      const send = { key: "Enter", ctrl: !mac, meta: mac };
      assert.equal(press(els.filter, send), false);
      assert.equal(press(els.text, send), false);
      assert.ok(press(els.composer, send));
      assert.ok(press(els.composer, { key: "Escape" }));
      assert.deepEqual(ran, ["send", "openIssue"]);
    });

    it("saves an edit by its chord and cancels it by Escape from the editor only, where single keys type", async () => {
      const { keys, els, press } = await load(platform);
      const ran: string[] = [];
      for (const a of ["saveEdit", "cancelEdit", "send", "editTitle", "toList"] as const) keys.touch(a, () => ran.push(a));
      const save = { key: "Enter", ctrl: !mac, meta: mac };
      assert.equal(press(els.composer, { key: "Escape" }), false);
      assert.ok(press(els.composer, save));
      assert.equal(press(els.editor, { key: "e" }), false);
      assert.ok(press(els.editor, save));
      assert.ok(press(els.editor, { key: "Escape" }));
      // In the panel, Escape is back to the list, and `e` edits the title.
      assert.ok(press(els.panel, { key: "Escape" }));
      assert.ok(press(els.panel, { key: "e" }));
      assert.deepEqual(ran, ["send", "saveEdit", "cancelEdit", "toList", "editTitle"]);
    });
  });
}
