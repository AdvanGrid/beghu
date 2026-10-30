// Held changes in the list (#109): a live refetch never moves a row under the user's pointer.
//
// Row contents update in place at once. Moves, arrivals and removals are **held changes** while
// the user is in **intent mode** (`createIntent`): the pointer moving (or the list scrolling) over
// the list or a card floating over it, or resting there under 5 s, a press, drag or text selection
// in it, a key pressed outside a text field in the last 5 s, or a touch in the last 1 s. In
// **reading mode** they apply as one batch, built from the latest refetch, behind a **shift cue**
// (a line where a row will arrive, an outline on one that will leave, 700 ms), then a 180 ms
// slide: rows that stay or move slide from where they were, new ones fade in, and ones that left
// fade out where they were. Re-entering intent mode during the cue cancels it and holds the batch
// again; a slide that has started finishes. A hidden tab holds every batch, so none applies (or
// animates) unseen; on its return the batch goes through the cue as usual.
//
// Most visible rows stay still: the half of the viewport nearer a change absorbs it (an arrival or
// removal above the middle moves the top edge, one below moves the bottom edge), so a change off
// screen moves nothing visible. A batch with nothing visible applies at once, even in intent mode,
// with its scroll compensation. The exception: scrolled to the top, an arrival at row 0 shows and
// pushes the rows down. A move counts as a removal plus an arrival.
//
// A change the user starts applies at once: another view (filter, sort, Back), the next page the
// scroll asks for, which only appends, and the row of an issue the user just created and opened
// (`applyNow`): the batch that brings it applies at once, without the cue. So does the order the
// first refetch brings after Back restored the page from the back-forward cache
// (`applyNextAtOnce`): the user wasn't on it while it changed.
//
// With reduced motion the cue is a still mark for 900 ms, and the batch swaps in unanimated.
import { createEffect, createMemo, createSignal, flush, onSettled, untrack } from "solid-js";
import { createCueTimer, createHidden, EASE } from "./cue";
import { area, type Area } from "./keys";

/** How long the pointer rests, or how long after a key, before held changes apply. */
export const REST_MS = 5000;
/** How long after a touch ends held changes stay held. */
const TOUCH_MS = 1000;
/** The slide that applies a batch. */
const SLIDE_MS = 180;

/** The areas whose keys mean the user may be about to act on the list: not typing. */
const ACTING: readonly Area[] = ["page", "list", "panel"];

/**
 * Whether the user is in reading mode over `el` (true) or intent mode (false), reactive, and a way
 * to say the next scroll of `el` is the app's own. The pointer counts only while over `el` or an
 * element `region` adds to it (a card that floats over it); keys count anywhere but in a text
 * field.
 */
export function createIntent(el: () => HTMLElement, region: (t: Element) => boolean = () => false) {
  const [reading, setReading] = createSignal(true);
  let over = false;
  let movedAt = -Infinity;
  // Where the pointer last moved, anywhere: unknown until it first does.
  let at = { x: NaN, y: NaN };
  let pressing = false;
  let touching = false;
  let touchedAt = -Infinity;
  let keyAt = -Infinity;
  let selecting = false;
  /** The scroll position the app's own scroll will land on, until its scroll event comes. */
  let ownTop: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // When intent mode ends, if nothing new happens: never while a press, touch or selection lasts.
  const until = () => {
    if (pressing || touching || selecting) return Infinity;
    return Math.max(over ? movedAt + REST_MS : -Infinity, keyAt + REST_MS, touchedAt + TOUCH_MS);
  };
  const check = () => {
    clearTimeout(timer);
    const left = until() - performance.now();
    setReading(left <= 0);
    if (left > 0 && left !== Infinity) timer = setTimeout(check, left);
  };

  const inside = (t: EventTarget | null) => t instanceof Element && (el().contains(t) || region(t));
  // Entering an element only says where the pointer is: a row sliding under a still pointer fires
  // it too. Only a move to new coordinates is the user moving it.
  const entered = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const now = inside(e.target);
    if (now === over) return;
    over = now;
    check();
  };
  const outOfPage = (e: PointerEvent) => {
    if (e.pointerType === "touch" || e.relatedTarget !== null || !over) return;
    over = false;
    check();
  };
  const moved = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const still = e.clientX === at.x && e.clientY === at.y;
    at = { x: e.clientX, y: e.clientY };
    over = inside(e.target);
    if (still || !over) return;
    movedAt = performance.now();
    check();
  };
  const wheel = () => {
    movedAt = performance.now();
    check();
  };
  // A scroll the user makes (a fling after the wheel or a drag, the scrollbar) is a move; the
  // app's own isn't.
  const scrolled = () => {
    if (ownTop !== undefined) {
      const ours = el().scrollTop === ownTop;
      ownTop = undefined;
      if (ours) return;
    }
    if (!over) return;
    movedAt = performance.now();
    check();
  };
  const down = (e: PointerEvent) => {
    if (e.pointerType === "touch") touching = true;
    else pressing = true;
    check();
  };
  const up = (e: PointerEvent) => {
    if (e.pointerType === "touch") {
      if (!touching) return;
      touching = false;
      touchedAt = performance.now();
    } else {
      if (!pressing) return;
      pressing = false;
      // The press counts as a move: the pointer rests from here.
      movedAt = performance.now();
    }
    check();
  };
  // A press whose release the page never hears (a context menu opened, the window lost focus, the
  // tab hid) ends there, as a release would.
  const lost = () => {
    if (!pressing && !touching) return;
    if (pressing) movedAt = performance.now();
    if (touching) touchedAt = performance.now();
    pressing = touching = false;
    check();
  };
  const hid = () => {
    if (document.hidden) lost();
  };
  const key = () => {
    if (!ACTING.includes(area())) return;
    keyAt = performance.now();
    check();
  };
  const selection = () => {
    const s = document.getSelection();
    const now = !!s && !s.isCollapsed && !!s.anchorNode && el().contains(s.anchorNode);
    if (now === selecting) return;
    selecting = now;
    check();
  };

  onSettled(() => {
    const target = el();
    document.addEventListener("pointerover", entered, true);
    document.addEventListener("pointerout", outOfPage, true);
    document.addEventListener("pointermove", moved, true);
    target.addEventListener("pointerdown", down);
    target.addEventListener("wheel", wheel, { passive: true });
    target.addEventListener("scroll", scrolled, { passive: true });
    // Released anywhere: a drag can end outside the list.
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("contextmenu", lost, true);
    window.addEventListener("blur", lost);
    document.addEventListener("visibilitychange", hid);
    window.addEventListener("keydown", key, true);
    document.addEventListener("selectionchange", selection);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", entered, true);
      document.removeEventListener("pointerout", outOfPage, true);
      document.removeEventListener("pointermove", moved, true);
      target.removeEventListener("pointerdown", down);
      target.removeEventListener("wheel", wheel);
      target.removeEventListener("scroll", scrolled);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("contextmenu", lost, true);
      window.removeEventListener("blur", lost);
      document.removeEventListener("visibilitychange", hid);
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("selectionchange", selection);
    };
  });
  return {
    reading,
    /** The app scrolls `el` to `top` now: its scroll event isn't the user's. */
    scrollTo(top: number) {
      const target = el();
      const before = target.scrollTop;
      // Unchanged, it isn't written: a write would stop a fling.
      if (Math.round(top) === Math.round(before)) return;
      target.scrollTop = top;
      if (target.scrollTop !== before) ownTop = target.scrollTop;
    },
  };
}

/** How long a created issue's row is waited for to apply at once (`applyNow`). */
const WANTED_MS = 60_000;
/** Issues the user created and opened, with when: the batch that brings each row applies at once. */
const wanted = new Map<number, number>();
const [wantedNow, setWantedNow] = createSignal(0);

/**
 * The user created issue `id` and opens it: the list's batch that brings its row (now, or once the
 * push that names it has been refetched) applies at once, as a change the user started.
 */
export function applyNow(id: number): void {
  wanted.set(id, performance.now());
  setWantedNow((n) => n + 1);
}

/** Until when the next refetch's order applies at once (`applyNextAtOnce`). */
let atOnceUntil = -Infinity;

/**
 * The user came back to the page (Back restored it from the back-forward cache): the order the
 * next refetch brings applies at once, as a page that loads now would show it. Waited for up to
 * `WANTED_MS`.
 */
export function applyNextAtOnce(): void {
  atOnceUntil = performance.now() + WANTED_MS;
}

/** Whether `shift` brings a row `applyNow` asked for (forgetting it, if so, and any expired). */
function bringsWanted(shift: Shift): boolean {
  const now = performance.now();
  let brings = false;
  for (const [id, at] of wanted) {
    if (now - at > WANTED_MS) wanted.delete(id);
    else if (shift.arriving.has(id)) {
      wanted.delete(id);
      brings = true;
    }
  }
  return brings;
}

/** A held batch: what changes between the order shown and the latest refetch's. */
export type Shift = {
  /** Rows shown now that go from where they are: removed, or moving away. */
  leaving: ReadonlySet<number>;
  /** Rows that will open somewhere: arriving, or moving there. */
  arriving: ReadonlySet<number>;
  /** Where rows will open, as indexes into the order shown: a line just above that row. */
  lines: readonly number[];
};

/**
 * The batch that turns `shown` into `target`, or undefined when they're the same order. The rows
 * that keep their relative order are the longest run of them in both; every other row shown
 * leaves, and every other row of the target arrives.
 */
export function shiftOf(shown: readonly number[], target: readonly number[]): Shift | undefined {
  if (shown.length === target.length && shown.every((id, i) => target[i] === id)) return undefined;
  const inTarget = new Map(target.map((id, i) => [id, i]));
  const kept = longestRun(shown.map((id) => inTarget.get(id) ?? -1));
  const stable = new Set(kept.map((i) => shown[i]!));
  const leaving = new Set(shown.filter((id) => !stable.has(id)));
  const arriving = new Set(target.filter((id) => !stable.has(id)));
  const shownAt = new Map(shown.map((id, i) => [id, i]));
  const lines: number[] = [];
  let after = 0;
  for (const id of target) {
    if (stable.has(id)) after = shownAt.get(id)! + 1;
    else lines.push(after);
  }
  return { leaving, arriving, lines };
}

/** The indexes of the longest strictly increasing run of `seq`'s non-negative values. */
function longestRun(seq: readonly number[]): number[] {
  // Patience sorting: `tails[k]` ends the best run of length k + 1 found so far.
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  seq.forEach((v, i) => {
    if (v < 0) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]!]! < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const out: number[] = [];
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i]!) out.push(i);
  return out.reverse();
}

function sameShift(a: Shift, b: Shift): boolean {
  const same = (x: ReadonlySet<number>, y: ReadonlySet<number>) => x.size === y.size && [...x].every((id) => y.has(id));
  return same(a.leaving, b.leaving) && same(a.arriving, b.arriving) && a.lines.join() === b.lines.join();
}

/** The scroller's window, in px. */
type View = { top: number; height: number };

/**
 * Whether any part of `shift` is on screen: a leaving row, or a line inside the window. `at` maps
 * each row shown to its index.
 */
function onScreen(shift: Shift, at: ReadonlyMap<number, number>, v: View, pitch: number): boolean {
  for (const id of shift.leaving) {
    const y = at.get(id)! * pitch;
    if (y + pitch > v.top && y < v.top + v.height) return true;
  }
  return shift.lines.some((line) => {
    const y = line * pitch;
    return (y > v.top || (v.top === 0 && y === 0)) && y < v.top + v.height;
  });
}

/**
 * Where the scroller goes once `shift` applies: the half of the window nearer each change absorbs
 * it, so the rows about the middle stay where they are on screen. At the top, an arrival at row 0
 * pushes the rows down instead. Past the end, the browser clamps it to what the scroller holds
 * then (rows, and any note after them).
 */
function scrollAfter(shift: Shift, at: ReadonlyMap<number, number>, v: View, pitch: number): number {
  const middle = v.top + v.height / 2;
  let rows = 0;
  for (const id of shift.leaving) if ((at.get(id)! + 0.5) * pitch < middle) rows--;
  for (const line of shift.lines) if (line * pitch < middle && !(v.top === 0 && line === 0)) rows++;
  return Math.max(0, v.top + rows * pitch);
}

/** What a batch did, for the selection to follow its issue. */
export type Applied = {
  /** The rows that left the list. */
  gone: ReadonlySet<number>;
  /** The row that now sits where `id` was on screen, and its index. */
  taker: (id: number) => { id: number; index: number } | undefined;
  /** Where `id` was in the list's order: the index of the first row after it that stays. */
  place: (id: number) => number;
};

/** A row that left the list, fading out where it was on screen: a copy of its last DOM. */
export type Ghost = { id: number; node: Node; y: number };

/**
 * The rows the list shows, with the order held as described above. `target` is the latest read,
 * `view` the view it belongs to, `scroller` the element that scrolls them, every row `pitch` px
 * tall and marked `data-perf="row"` and `data-id`; `region` adds elements that float over the
 * list (a hover card) to it for the pointer. `onApplied` hears each batch as it applies.
 *
 * Besides the rows: the cue to show, and the ghosts of rows that left, to show over the rows until
 * `fade` (given each ghost's element) has faded them.
 */
export function createHeld<R extends { id: number }>(opts: {
  target: () => readonly R[];
  view: () => string;
  scroller: () => HTMLElement;
  pitch: number;
  region?: (t: Element) => boolean;
  onApplied: (a: Applied) => void;
}) {
  const intent = createIntent(opts.scroller, opts.region);
  const reading = intent.reading;
  // The order shown, the view it's of, and the target order it was last brought up to date with
  // (for telling a next page, which only appends, from a refetch).
  type Shown = { view?: string; ids: readonly number[]; base: readonly number[] };
  const [shown, setShown] = createSignal<Shown>({ ids: [], base: [] });
  const [cue, setCue] = createSignal<Shift>();
  const [ghosts, setGhosts] = createSignal<readonly Ghost[]>([]);
  // A hidden tab holds every batch, so none applies unseen; it's considered again on return.
  const hidden = createHidden();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  /** A batch is held: the last look found the order shown differs from the latest read's. */
  let pending = false;

  /** `base` plus whatever a next page appended to it, if that's all that changed. */
  const appended = (ids: readonly number[], base: readonly number[], target: readonly number[]) => {
    if (target.length <= base.length || !base.every((id, i) => target[i] === id)) return ids;
    const have = new Set(ids);
    return [...ids, ...target.slice(base.length).filter((id) => !have.has(id))];
  };

  // A held row the latest read no longer has keeps the contents it last showed.
  let known = new Map<number, R>();
  const rows = createMemo(() => {
    const target = opts.target();
    const s = shown();
    if (s.view !== opts.view()) {
      known = new Map();
      return target;
    }
    const ids = appended(s.ids, s.base, target.map((r) => r.id));
    const byId = new Map(target.map((r) => [r.id, r]));
    const out: R[] = [];
    for (const id of ids) {
      const r = byId.get(id) ?? known.get(id);
      if (r) out.push(r);
    }
    known = new Map(out.map((r) => [r.id, r]));
    return out;
  });

  const timer = createCueTimer(reduced);
  const cancelCue = () => {
    timer.stop();
    setCue(undefined);
  };

  const targetIds = () => untrack(opts.target).map((r) => r.id);
  const viewport = (): View => ({ top: opts.scroller().scrollTop, height: opts.scroller().clientHeight });
  const indexes = (ids: readonly number[]) => new Map(ids.map((id, i) => [id, i]));

  /** Applies the latest batch: the order becomes the latest read's, then slides there. */
  const apply = (animate: boolean) => {
    cancelCue();
    pending = false;
    const s = untrack(shown);
    const target = targetIds();
    const shift = shiftOf(s.ids, target);
    if (!shift) return;
    const el = opts.scroller();
    const before = viewport();
    const was = indexes(s.ids);
    const top = scrollAfter(shift, was, before, opts.pitch);
    const now = indexes(target);
    const gone = new Set(s.ids.filter((id) => !now.has(id)));
    const motion = animate && !reduced.matches;
    // The rows that leave the list fade out where they were: copies of them, taken before they go.
    const copies: { id: number; node: Element }[] = [];
    if (motion) {
      for (const row of el.querySelectorAll<HTMLElement>('[data-perf="row"][data-id]')) {
        const id = Number(row.dataset.id);
        if (!gone.has(id)) continue;
        const node = row.cloneNode(true) as Element;
        // Nothing in the copy is a row, a part of one, or reachable: its markers go, inside too.
        const strip = ["data-perf", "data-id", "data-cue", "id", "tabindex", "aria-selected", "aria-current", "href"];
        for (const n of [node, ...node.querySelectorAll(strip.map((a) => `[${a}]`).join(","))]) for (const a of strip) n.removeAttribute(a);
        // Its place in the list goes too (a row's inline style holds only that): the ghost puts
        // it where it was on screen.
        node.removeAttribute("style");
        copies.push({ id, node });
      }
    }
    setShown({ view: s.view, ids: target, base: target });
    flush();
    intent.scrollTo(top);
    const after = el.scrollTop;
    opts.onApplied({
      gone,
      taker: (id) => {
        const at = was.get(id);
        if (at === undefined || target.length === 0) return undefined;
        const i = Math.max(0, Math.min(Math.round((at * opts.pitch - before.top + after) / opts.pitch), target.length - 1));
        return { id: target[i]!, index: i };
      },
      place: (id) => {
        const at = was.get(id);
        if (at === undefined) return target.length;
        for (const next of s.ids.slice(at + 1)) {
          const i = now.get(next);
          if (i !== undefined) return i;
        }
        return target.length;
      },
    });
    if (!motion) return;
    if (copies.length) setGhosts((g) => [...g, ...copies.map(({ id, node }) => ({ id, node, y: was.get(id)! * opts.pitch - before.top + after }))]);
    // Once the window has caught up with the scroll (before the next paint), each row that stays
    // or moves slides from where it was on screen, and each new one fades in.
    requestAnimationFrame(() => {
      for (const row of el.querySelectorAll<HTMLElement>('[data-perf="row"][data-id]')) {
        const id = Number(row.dataset.id);
        const to = now.get(id);
        if (to === undefined) continue;
        const from = was.get(id);
        if (from === undefined) {
          row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SLIDE_MS, easing: EASE });
          continue;
        }
        const dy = from * opts.pitch - before.top - (to * opts.pitch - after);
        if (dy === 0) continue;
        const clamped = Math.max(-before.height, Math.min(dy, before.height));
        row.animate([{ transform: `translateY(${clamped}px)` }, { transform: "none" }], { duration: SLIDE_MS, easing: EASE });
      }
    });
  };

  /** Fades out a ghost's element, then drops it. */
  const fade = (node: HTMLElement, g: Ghost) => {
    const drop = () => setGhosts((all) => all.filter((x) => x !== g));
    node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SLIDE_MS, easing: EASE, fill: "forwards" }).finished.then(drop, drop);
  };

  /**
   * Decides what the held batch does now: nothing, apply at once, or show its cue. `s` is the
   * order shown, as it is now (a write to `shown` reads back only after a flush).
   */
  const consider = (s: Shown = untrack(shown), atOnce = false) => {
    if (s.view !== untrack(opts.view)) return;
    const shift = shiftOf(s.ids, targetIds());
    pending = shift !== undefined;
    // A created issue whose row is already shown needs nothing more.
    if (wanted.size) {
      const have = new Set(s.ids);
      for (const id of wanted.keys()) if (have.has(id)) wanted.delete(id);
    }
    if (!shift) return cancelCue();
    if (untrack(hidden)) return cancelCue();
    // The first order after the user came back to the page: at once, unanimated, as a page that
    // loads now would show it.
    if (atOnce) {
      cancelCue();
      queueMicrotask(() => apply(false));
      return;
    }
    // It brings the row of an issue the user just created: at once, as the user started it.
    if (wanted.size && bringsWanted(shift)) {
      cancelCue();
      queueMicrotask(() => apply(true));
      return;
    }
    // Nothing on screen moves: at once, once the update that brought it has settled.
    if (!onScreen(shift, indexes(s.ids), viewport(), opts.pitch)) {
      cancelCue();
      queueMicrotask(() => apply(false));
      return;
    }
    if (!untrack(reading)) return cancelCue();
    // A batch that changes mid-cue shows its new cue, from the start.
    const showing = untrack(cue);
    if (showing && timer.running() && sameShift(showing, shift)) return;
    setCue(shift);
    timer.start(() => {
      if (untrack(reading) && !untrack(hidden)) apply(true);
      else cancelCue();
    });
  };

  createEffect(
    () => ({ view: opts.view(), target: opts.target().map((r) => r.id) }),
    ({ view, target }) => {
      const s = untrack(shown);
      // Another view, or the first: it shows as it is.
      if (s.view !== view) {
        cancelCue();
        pending = false;
        // A created issue waited for in the view left behind isn't this one's to bring.
        if (s.view !== undefined) wanted.clear();
        setShown({ view, ids: target, base: target });
        return;
      }
      const next = { view, ids: appended(s.ids, s.base, target), base: target };
      setShown(next);
      // The read after a page restore (`applyNextAtOnce`): this one.
      const atOnce = performance.now() < atOnceUntil;
      atOnceUntil = -Infinity;
      consider(next, atOnce);
    },
  );
  createEffect(reading, (r) => (r ? consider() : cancelCue()));
  createEffect(hidden, (h) => (h ? cancelCue() : consider()));
  createEffect(wantedNow, () => consider());
  onSettled(() => {
    const el = opts.scroller();
    // A held batch the scroll takes off screen applies at once; one it brings on screen waits.
    const scrolled = () => {
      if (pending) consider();
    };
    el.addEventListener("scroll", scrolled, { passive: true });
    return () => el.removeEventListener("scroll", scrolled);
  });

  return { rows, cue, ghosts, fade };
}
