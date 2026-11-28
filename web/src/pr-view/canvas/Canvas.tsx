// The canvas (#182): the PR view's one drawing of the code view, laid out by our layout, in the
// Canvas tab. Layout A's four columns are foldable frames; parts open in place; the lenses,
// Show, Colour by, Boxes, Outlines and the Lines menu come from the toolbar (the URL's state).
//
// The DOM: one HTML layer of blocks and frames (absolutely placed, each at its custom
// properties' place, its stacking by depth), and one SVG layer over it for the lines and trunks
// (lines never pass through a block, so the SVG covers nothing it shouldn't). Pan and zoom
// transform the world they share. Every item that moves stays mounted in a fixed DOM order (the
// order it was first drawn in, only ever appended to): an inserted or moved element can't
// transition. Items no longer drawn are hidden, not removed.
//
// Opening and folding glide over 420 ms (the Web Animations API, transforms and opacity only, from
// where each item is drawn to its new place): an opened block's contents grow out of its corner, a
// folded one's shrink back in, the clicked block stays still, and the lines come back when the
// glide ends. An item that changes size never scales its text, and its border keeps its width:
// it wears a skin for the glide (glideItem, wearSkin), whose solid edges stretch only along their
// length and whose dashed ones only move, so no dash stretches. A glide cut short by another
// carries on from where it was.
// Then the canvas pans as little as it can to bring the frame's title and as much of the frame as
// fits into view, eased, with no zoom change. `prefers-reduced-motion` snaps.
//
// Under the fold (#183, fold.ts) the drawing is the place's fold plan: each block says how much of
// it serves the place and carries a dot per top-level purpose it serves (the stood-on one's
// larger), groups and rest blocks stand for what's left out, the place's own lines are strong in
// its purpose's colour and the rest faint. A click on the background goes back to the place, not
// to nothing; a double-click on a part with nothing inside to open goes to the code view at it.
//
// Gestures: a click selects (a block, a frame's body, a line), and on the selected block, if it
// has parts inside, opens it; a click on a frame's title folds it; a double-click opens a block
// with parts inside, or glides to a line's far end and selects it; a click on the background
// clears the selection; a drag on the background, or Space + drag anywhere, pans; Ctrl/Cmd +
// scroll zooms round the pointer, and scroll pans. Mid-glide nothing in the drawing takes the
// pointer. Keys are touchpoints (keys.ts, the `canvas` area): + − 0 Fit, Backspace out one level,
// Escape, the arrows to the nearest part, ] and [ through the selected part's lines. Each block is
// a button named by its face (kind, change, name) and, if it opens, the key that opens it
// (`aria-expanded` false; true on an open frame, box or column), `aria-current` while selected; a
// line is named by its ends.
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createProjection, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { keysIn, touch, type Action } from "../../keys";
import { showBinding } from "../../keyNames";
import { colors, fonts, graph } from "../../tokens.stylex";
import { cx, cxMap, cxTable } from "../../cx";
import type { P, Rect } from "../layout/types";
import type { Model } from "../model";
import { part, useNav } from "../nav";
import type { Sel } from "../state";
import { Cards, type Hover } from "./Cards";
import { Legend, useKeyRows } from "./Legend";
import { changeKey, faceOf, fillOf, ringsOf, titleOf, CHANGE_WORD, type ChangeKey, type Face } from "./look";
import { arrow, countAt, rounded, tipOf } from "./paths";
import type { DLine, Item, Scene } from "./scene";
import { useCanvas } from "./store";
import { FoldBar, StepBar, Toolbar, ZoomBar } from "./Bars";
import { purposesOf, selOfPlace } from "../purposes";
import { PURPOSE_DOT } from "../PurposeDot";
import { drawnFolders } from "../Panel";
import { columnGroup } from "../layout/graph";

/** The glide's length (ms), and its curve. */
export const GLIDE_MS = 420;
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
const MIN_Z = 0.1;
const MAX_Z = 2;
/** The least the start view zooms out to fit the drawing's width: past it, the reader pans or Fits. */
const START_Z = 0.85;
/** How far a press may move and still be a click (px). */
const CLICK_SLOP = 4;
/** The margin the canvas keeps round what it brings into view (px). */
const MARGIN = 24;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** An item as the glide draws it: its place, the size it's drawn at, its content's scale and its layer's opacity. */
interface Vis {
  x: number;
  y: number;
  w: number;
  h: number;
  k: number;
  o: number;
}

/** Where the drawing sits in the viewport: its origin's offset (px) and its scale. */
interface View {
  x: number;
  y: number;
  z: number;
}

/** What the canvas fades everything else for: items, lines and trunks. */
export interface Focus {
  items: ReadonlySet<string>;
  lines: ReadonlySet<string>;
  trunks: ReadonlySet<string>;
}

const EMPTY: ReadonlySet<string> = new Set();
const CHANGED = columnGroup("changed");

/**
 * A selector: whether each ID is in `set`, read per ID (`sel[id]`), so a change re-runs only the
 * readers of the IDs it adds or drops, not every item's.
 */
function selector(set: () => ReadonlySet<string>): Readonly<Record<string, true | undefined>> {
  let last: ReadonlySet<string> = EMPTY;
  return createProjection<Record<string, true | undefined>>((draft) => {
    const next = set();
    for (const k of last) if (!next.has(k)) delete draft[k];
    for (const k of next) if (!last.has(k)) draft[k] = true;
    last = new Set(next);
  }, {});
}

/** What an item's look reads of the canvas's state, each per item. */
interface Looks {
  stop: Readonly<Record<string, true | undefined>>;
  sel: Readonly<Record<string, true | undefined>>;
  lit: Readonly<Record<string, true | undefined>>;
  hovered: Readonly<Record<string, true | undefined>>;
  focusing: () => boolean;
  /** The keys that open or fold a block (openFold's), as its words say them. */
  openKeys: () => string;
}

export function Canvas() {
  const nav = useNav();
  const c = useCanvas();
  const m = () => nav.model();
  const scene = () => c.scene();
  const rows = useKeyRows();

  let viewport!: HTMLDivElement;
  const els = new Map<string, HTMLElement>();
  const [view, setView] = createSignal<View>({ x: MARGIN, y: MARGIN, z: 1 });
  // Unmeasured (0 × 0) until the viewport is laid out: the start view waits for its real size.
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  const [hover, setHover] = createSignal<Hover>();
  const [keyHover, setKeyHover] = createSignal<string>();
  const [keyPin, setKeyPin] = createSignal<string>();
  const [pinned, setPinned] = createSignal<{ trunk: string; x: number; y: number }>();
  /** A trunk card's row under the pointer: that line's whole route lights. */
  const [rowLine, setRowLine] = createSignal<string>();
  /** The line lit through a double-click's flight. */
  const [flying, setFlying] = createSignal<string>();
  const [space, setSpace] = createSignal(false);
  const [panning, setPanning] = createSignal(false);

  // Items, in the order first drawn: only ever appended to, so no element is ever moved. A newer
  // analysis (Show it) drops the old one's items that it doesn't draw: they'd never show again.
  const [order, setOrder] = createSignal<string[]>([]);
  const known = new Set<string>();
  let drawnFor: string | undefined;
  createEffect(
    () => [scene(), m().g.id] as const,
    ([sc, analysis]) => {
      if (drawnFor !== undefined && drawnFor !== analysis) {
        const gone = [...known].filter((id) => !sc.items.has(id));
        if (gone.length) {
          if (gone.some((id) => els.get(id) === document.activeElement)) refocus();
          for (const id of gone) known.delete(id), els.delete(id);
          setOrder((o) => o.filter((id) => known.has(id)));
        }
      }
      drawnFor = analysis;
      const added = [...sc.items.values()].filter((it) => !known.has(it.id)).sort((a, b) => a.depth - b.depth);
      if (!added.length) return;
      for (const it of added) known.add(it.id);
      setOrder((o) => [...o, ...added.map((it) => it.id)]);
    },
  );

  // ---- Selection and focus ----------------------------------------------------------------------

  const selItems = createMemo((): ReadonlySet<string> => {
    const s = nav.sel();
    const sc = scene();
    if (s?.kind === "part") return new Set(s.ids.map((id) => sc.holder(id)).filter((x): x is string => x !== undefined));
    if (s?.kind === "group" && sc.items.has(s.id)) return new Set([s.id]);
    return new Set();
  });
  const selLines = createMemo((): ReadonlySet<string> => {
    const s = nav.sel();
    const sc = scene();
    if (s?.kind !== "line") return new Set();
    return new Set(s.ids.flatMap((id) => sc.drawnAs.get(id) ?? []).filter((l) => sc.lines.has(l)));
  });

  /** Whether item `id` is drawn inside item `outer`. */
  const within = (sc: Scene, id: string, outer: string) => {
    for (let p = sc.items.get(id)?.parent; p !== undefined; p = sc.items.get(p)?.parent) if (p === outer) return true;
    return false;
  };
  /** Every item `id` is drawn inside, and itself. */
  const withParents = (sc: Scene, ids: Iterable<string>, into: Set<string>) => {
    for (const id of ids) for (let x: string | undefined = id; x !== undefined && !into.has(x); x = sc.items.get(x)?.parent) into.add(x);
  };
  /** The nodes an item stands for: a part's, or a group's parts, at every depth. */
  const nodesOf = (sc: Scene, id: string): Set<string> => {
    const it = sc.items.get(id);
    const out = new Set<string>();
    if (it?.node) for (const x of m().subtree(it.node.id)) out.add(x);
    if (it?.group) for (const top of it.group.members) for (const x of m().subtree(top)) out.add(x);
    for (const top of it?.stands ?? []) for (const x of m().subtree(top)) out.add(x);
    return out;
  };
  /** What's related to some analysis lines: their drawn lines and the items at their ends. */
  const relatedEdges = (sc: Scene, edges: Iterable<string>, items: Set<string>): Focus => {
    const lines = new Set<string>();
    const ends: string[] = [];
    for (const id of edges) {
      for (const l of sc.drawnAs.get(id) ?? []) if (sc.lines.has(l)) lines.add(l);
      const e = m().edges.get(id);
      if (!e) continue;
      for (const n of [e.from, e.to]) {
        const h = sc.holder(n);
        if (h !== undefined) ends.push(h);
      }
    }
    withParents(sc, ends, items);
    const trunks = new Set(sc.trunks.filter((t) => t.lines.some((l) => lines.has(l))).map((t) => t.id));
    return { items, lines, trunks };
  };
  const relatedItem = (sc: Scene, id: string): Focus => {
    const nodes = nodesOf(sc, id);
    const edges = sc.edges.filter((e) => nodes.has(e.from) || nodes.has(e.to)).map((e) => e.id);
    const items = new Set<string>();
    withParents(sc, [id], items);
    // An open frame's whole inside is related to it.
    for (const it of sc.items.values()) for (let p = it.parent; p !== undefined; p = sc.items.get(p)?.parent) if (p === id) items.add(it.id);
    return relatedEdges(sc, edges, items);
  };
  const relatedLines = (sc: Scene, ids: Iterable<string>): Focus => relatedEdges(sc, [...ids].flatMap((l) => sc.lines.get(l)?.members ?? []), new Set());

  /** What the pointer is over: its kind and ID, unchanged while the pointer moves across it. */
  const hovered = createMemo(
    (): { kind: Hover["kind"]; id: string } | undefined => {
      const h = hover();
      return h && { kind: h.kind, id: h.id };
    },
    { equals: (a, b) => a?.kind === b?.kind && a?.id === b?.id },
  );
  const focus = createMemo((): Focus | undefined => {
    const sc = scene();
    const row = keyHover() ?? keyPin();
    if (row !== undefined) {
      const r = rows().find((x) => x.id === row);
      if (r) return { items: r.items, lines: r.lines, trunks: r.trunks };
    }
    const fl = flying();
    if (fl !== undefined) return relatedLines(sc, [fl]);
    const rl = rowLine();
    if (rl !== undefined) return relatedLines(sc, [rl]);
    const h = hovered();
    if (h?.kind === "item" && sc.items.get(h.id)?.kind !== "column") return relatedItem(sc, h.id);
    if (h?.kind === "line") return relatedLines(sc, [h.id]);
    if (h?.kind === "trunk") {
      const t = sc.trunks.find((x) => x.id === h.id);
      if (t) return relatedLines(sc, t.lines);
    }
    const lit = c.lit();
    if (lit && (lit.nodes.length || lit.edges.length)) {
      const items = new Set<string>();
      withParents(sc, lit.nodes.map((n) => sc.holder(n)).filter((x): x is string => x !== undefined), items);
      return lit.edges.length ? relatedEdges(sc, lit.edges, items) : { items, lines: new Set(), trunks: new Set() };
    }
    if (selLines().size) return relatedLines(sc, selLines());
    const [first] = selItems();
    if (first !== undefined && sc.items.get(first)?.kind !== "column") return relatedItem(sc, first);
    return undefined;
  });
  /** The lines lit: a flight's, a trunk card row's, the hovered line or a hovered part's, else the selected ones. */
  const litLines = createMemo((): ReadonlySet<string> => {
    const f = flying() ?? rowLine();
    if (f !== undefined) return new Set([f]);
    const h = hovered();
    if (h?.kind === "line") return new Set([h.id]);
    // A hovered part's own lines, each lighting its route through the trunks it rides.
    if (h?.kind === "item") return focus()?.lines ?? new Set();
    return selLines();
  });
  const litTrunks = createMemo((): ReadonlySet<string> => {
    const lit = litLines();
    return new Set(scene().trunks.filter((t) => t.lines.some((l) => lit.has(l))).map((t) => t.id));
  });
  // Per ID, so a hover or a pick re-runs only the items and lines it changes.
  const isSel = selector(selItems);
  const isLitItem = selector(() => focus()?.items ?? EMPTY);
  const isFocusLine = selector(() => focus()?.lines ?? EMPTY);
  const isFocusTrunk = selector(() => focus()?.trunks ?? EMPTY);
  const isLitLine = selector(litLines);
  const isLitTrunk = selector(litTrunks);
  const isHovered = selector(() => {
    const h = hovered();
    return h?.kind === "item" ? new Set([h.id]) : EMPTY;
  });
  const focusing = createMemo(() => focus() !== undefined);

  // ---- The keyboard's place: one tab stop, on the selection ---------------------------------------

  /**
   * The canvas's one tab stop: the selected line or block, else the changed column (or the first
   * thing drawn). Tab into the canvas lands on it; the focus follows the selection.
   */
  const stop = createMemo(
    (): { kind: "item" | "line"; id: string } | undefined => {
      const [l] = selLines();
      if (l !== undefined) return { kind: "line", id: l };
      const [i] = selItems();
      if (i !== undefined) return { kind: "item", id: i };
      const sc = scene();
      if (sc.items.has(CHANGED)) return { kind: "item", id: CHANGED };
      const [first] = sc.items.keys();
      return first === undefined ? undefined : { kind: "item", id: first };
    },
    { equals: (a, b) => a?.kind === b?.kind && a?.id === b?.id },
  );
  const isStopItem = selector(() => {
    const t = stop();
    return t?.kind === "item" ? new Set([t.id]) : EMPTY;
  });
  const isStopLine = selector(() => {
    const t = stop();
    return t?.kind === "line" ? new Set([t.id]) : EMPTY;
  });
  const lineEls = new Map<string, Element>();
  const stopEl = (t = untrack(stop)) => (t?.kind === "item" ? els.get(t.id) : t ? lineEls.get(t.id) : undefined) as HTMLElement | SVGElement | undefined;
  /** The focused block or line went (Show it's newer analysis, a fold): the focus goes to the tab stop, not the page. */
  const refocus = () =>
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected && !a.closest("[hidden]")) return;
      stopEl()?.focus({ preventScroll: true });
    });
  /** A line's element, gone with its line: the focus moves on if it had it. */
  const lineGone = (id: string, el: Element | undefined) => {
    if (lineEls.get(id) === el) lineEls.delete(id);
    if (el && el === document.activeElement) refocus();
  };
  createEffect(stop, () => {
    // Only while the canvas has the focus, and not from a card's or the legend's button.
    const active = document.activeElement;
    if (!active || !viewport.contains(active) || active.closest("[data-chrome]")) return;
    queueMicrotask(() => {
      const el = stopEl();
      if (el && el !== document.activeElement) el.focus({ preventScroll: true });
    });
  });
  const openKeys = createMemo(() => keysFor("openFold"));
  const looks: Looks = { sel: isSel, lit: isLitItem, hovered: isHovered, focusing, stop: isStopItem, openKeys };

  // A pinned trunk's card goes with its trunk.
  createEffect(
    () => {
      const p = pinned();
      return p !== undefined && !scene().trunks.some((t) => t.id === p.trunk);
    },
    (gone) => {
      if (gone) setPinned(undefined);
    },
  );

  // ---- The viewport: pan and zoom ---------------------------------------------------------------

  const clampZ = (z: number) => Math.min(MAX_Z, Math.max(MIN_Z, z));
  const zoomAt = (px: number, py: number, z1: number) => {
    const v = untrack(view);
    const z = clampZ(z1);
    setView({ x: px - ((px - v.x) * z) / v.z, y: py - ((py - v.y) * z) / v.z, z });
  };
  const zoomBy = (f: number) => {
    const s = untrack(size);
    zoomAt(s.w / 2, s.h / 2, untrack(view).z * f);
  };
  const fitZ = () => {
    const sc = untrack(scene), s = untrack(size);
    return clampZ(Math.min(1, (s.w - 2 * MARGIN) / Math.max(1, sc.width), (s.h - 2 * MARGIN) / Math.max(1, sc.height)));
  };
  const fit = () => {
    const sc = untrack(scene), s = untrack(size);
    const z = fitZ();
    setView({ x: Math.max(MARGIN, (s.w - sc.width * z) / 2), y: MARGIN, z });
  };
  /** The pan under way: its frame, and what to undo if it's cut short (a flight's lit line). */
  let tween = 0;
  let onStop: (() => void) | undefined;
  /** Stops the pan under way, where it is: a drag, a wheel or another pan took over. */
  const stopTween = () => {
    cancelAnimationFrame(tween);
    const f = onStop;
    onStop = undefined;
    f?.();
  };
  /** A line's flight waiting for the glide that opens down to its far end. */
  let pendingFlight: ReturnType<typeof setTimeout> | undefined;
  /** The reader takes over (a drag, the wheel): the pan under way stops, and a flight waiting to start won't. */
  const takeOver = () => {
    clearTimeout(pendingFlight);
    stopTween();
  };
  /** Pans to `to` over `ms`, eased; `dip` zooms out on the way (a long flight); `stopped` runs if it's cut short. */
  const panTo = (to: View, ms: number, dip = 0, done?: () => void, stopped?: () => void) => {
    stopTween();
    const from = untrack(view);
    if (reduced() || ms <= 0) {
      setView(to);
      done?.();
      return;
    }
    onStop = stopped;
    const t0 = performance.now();
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const s = untrack(size);
    // The point in the middle of the viewport, in drawing coordinates, eased from one view's to the other's.
    const mid = (v: View) => ({ x: (s.w / 2 - v.x) / v.z, y: (s.h / 2 - v.y) / v.z });
    const a = mid(from), b = mid(to);
    const stepFn = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      const z = (from.z + (to.z - from.z) * e) * (1 - dip * Math.sin(Math.PI * t));
      const px = a.x + (b.x - a.x) * e, py = a.y + (b.y - a.y) * e;
      setView({ x: s.w / 2 - px * z, y: s.h / 2 - py * z, z });
      if (t < 1) tween = requestAnimationFrame(stepFn);
      else {
        onStop = undefined;
        setView(to);
        done?.();
      }
    };
    tween = requestAnimationFrame(stepFn);
  };
  /** The least pan that brings `r` into view: its top left first, then as much of it as fits. */
  const reveal = (r: Rect, ms = 300) => {
    const v = untrack(view), s = untrack(size);
    const axis = (pos: number, len: number, room: number) => {
      const a = pos * v.z, b = (pos + len) * v.z;
      const lo = MARGIN, hi = room - MARGIN;
      // Already in view, or as much as fits shown from its start.
      if (b - a > hi - lo) return a < lo || a > hi - 80 ? lo - a : 0;
      if (a < lo) return lo - a;
      if (b > hi) return hi - b;
      return 0;
    };
    const dx = axis(r.x + v.x / v.z, r.w, s.w), dy = axis(r.y + v.y / v.z, r.h, s.h);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    panTo({ ...v, x: v.x + dx, y: v.y + dy }, ms);
  };

  // The first drawing, once the viewport has its real size: the drawn content's width fitted,
  // clamped to [0.85, 1] (Fit is the way to see everything), its top at the changed column's
  // frame's, and its left too when the drawing is wider than the viewport. Only once: a newer
  // analysis (Show it) keeps the reader's pan and zoom.
  let placed = false;
  createEffect(
    () => [scene(), size()] as const,
    ([sc, s]) => {
      if (placed || s.w < 50 || s.h < 50 || !sc.items.size) return;
      placed = true;
      const z = clampZ(Math.max(START_Z, Math.min(1, (s.w - 2 * MARGIN) / Math.max(1, sc.width))));
      // Across, the changed column's left only when the drawing is wider than the viewport: when it
      // fits, the columns left of it (people) stay in view.
      const at = sc.items.get("column:changed")?.rect ?? { x: 0, y: 0 };
      const fits = sc.width * z <= s.w - 2 * MARGIN;
      setView({ x: MARGIN - (fits ? 0 : at.x) * z, y: MARGIN - at.y * z, z });
    },
  );

  // ---- The glide -------------------------------------------------------------------------------

  /** The item holding `id` in `sc` (it isn't drawn there): where it grows from, or shrinks into. */
  const holderIn = (sc: Scene, id: string): Item | undefined => {
    const it = sc.items.get(id);
    if (it) return it;
    const node = id.startsWith("rest:") ? id.slice(5) : id;
    const g = untrack(scene).groups.get(id) ?? sc.groups.get(id);
    const h = g ? sc.holder(g.members[0]!) : sc.holder(node);
    return h === undefined || h === id ? undefined : sc.items.get(h);
  };
  // What the glide has under way: its animations, the items wearing a skin, and each item's
  // track (where it glides from and to, and the animation whose progress says where it is now).
  const running: Animation[] = [];
  const skinned = new Set<HTMLElement>();
  const tracks = new Map<string, { a: Vis; b: Vis; anim: Animation }>();
  /** Where item `id` is drawn now, mid-glide: its track at its animation's eased progress. */
  const visNow = (id: string): Vis | undefined => {
    const t = tracks.get(id);
    if (!t) return undefined;
    const p = t.anim.effect?.getComputedTiming().progress ?? 1;
    const at = (a: number, b: number) => a + (b - a) * p;
    return { x: at(t.a.x, t.b.x), y: at(t.a.y, t.b.y), w: at(t.a.w, t.b.w), h: at(t.a.h, t.b.h), k: at(t.a.k, t.b.k), o: at(t.a.o, t.b.o) };
  };
  /** The glide's animations cancelled and its skins gone: every item drawn whole where it is in the layout. */
  const stopAnimations = () => {
    for (const a of running.splice(0)) a.cancel();
    for (const el of skinned) {
      el.querySelector(":scope > [data-skin]")?.remove();
      el.style.removeProperty("--bare");
      el.style.removeProperty("--worn");
    }
    skinned.clear();
    tracks.clear();
  };
  createEffect(
    () => c.glide(),
    (g) => {
      if (!g) return;
      const to = untrack(scene);
      const from = g.from;
      viewport.dataset.glide = String(g.n);
      setHover(undefined);
      // A glide cut short by another continues from where each item is drawn now; nothing of it lingers.
      const now0 = new Map<string, Vis>();
      for (const id of tracks.keys()) {
        const v = visNow(id);
        if (v) now0.set(id, v);
      }
      stopAnimations();
      if (reduced()) {
        c.endGlide();
        afterGlide(to, g.at);
        return;
      }
      const whole = (r: Rect): Vis => ({ x: r.x, y: r.y, w: r.w, h: r.h, k: 1, o: 1 });
      // The clicked block stays still: the view moves by what the layout moved it.
      const a0 = g.at === undefined ? undefined : (now0.get(g.at) ?? (from.items.get(g.at) && whole(from.items.get(g.at)!.rect)));
      const a1 = g.at === undefined ? undefined : to.items.get(g.at);
      const d = a0 && a1 ? { x: a1.rect.x - a0.x, y: a1.rect.y - a0.y } : { x: 0, y: 0 };
      if (d.x || d.y) {
        const v = untrack(view);
        setView({ ...v, x: v.x - d.x * v.z, y: v.y - d.y * v.z });
      }
      const shift = (v: Vis): Vis => ({ ...v, x: v.x + d.x, y: v.y + d.y });
      const corner = (h: Item | undefined): P | undefined => h && { x: h.rect.x + 12, y: h.rect.y + 30 };
      const leavers: HTMLElement[] = [];
      for (const id of new Set([...from.items.keys(), ...to.items.keys()])) {
        const el = els.get(id);
        if (!el) continue;
        const was = from.items.get(id), now = to.items.get(id);
        const cur = now0.get(id);
        if (now) {
          let a: Vis;
          if (cur) a = shift(cur);
          else if (was) a = shift(whole(was.rect));
          else {
            // Arriving: grows out of the corner of the block that held it.
            const h = corner(holderIn(from, id));
            if (!h) continue;
            a = shift({ x: h.x, y: h.y, w: now.rect.w * 0.4, h: now.rect.h * 0.4, k: 0.4, o: 0 });
          }
          glideItem(id, el, now, a, whole(now.rect), "auto");
        } else if (was) {
          // Leaving: shrinks back into the block that holds it now, and holds there until the glide ends.
          // One cut short mid-resize starts at a uniform scale of its own size, so it shrinks by
          // FLIP, its contents with it: a skin would leave its text sticking out as it shrinks.
          const h = corner(holderIn(to, id));
          const a = shift(cur ? uniformAt(cur, was.rect) : whole(was.rect));
          glideItem(id, el, was, a, { x: h?.x ?? a.x, y: h?.y ?? a.y, w: was.rect.w * 0.4, h: was.rect.h * 0.4, k: 0.4, o: 0 }, "forwards");
          leavers.push(el);
        }
      }
      const n = g.n;
      setTimeout(() => {
        if (untrack(c.glide)?.n !== n) return;
        // The leavers are hidden now; their held frames go, so a later glide or Back finds them whole.
        stopAnimations();
        c.endGlide();
        afterGlide(untrack(scene), g.at);
      }, GLIDE_MS);
    },
  );
  /** `v` at a uniform scale of `r` (the smaller of its two), where it is: as is if it's one already. */
  const uniformAt = (v: Vis, r: Rect): Vis => {
    const k = Math.min(v.w / Math.max(1, r.w), v.h / Math.max(1, r.h));
    return Math.abs(v.w - v.k * r.w) < 0.5 && Math.abs(v.h - v.k * r.h) < 0.5 ? v : { ...v, w: k * r.w, h: k * r.h, k };
  };
  /**
   * Glides one item from `a` to `b` (its places in the drawing, the size it's drawn at, its
   * content's scale and its layer's opacity). An item drawn at its own size, or at a uniform scale
   * of it (an arrival, a leaver), moves by FLIP: a transform from one place to the other. One whose
   * size changes wears a skin for the glide (wearSkin): its border and fill drawn in pieces
   * (corners that move, a middle that stretches, solid edges that stretch only along their length,
   * dashed ones in halves that only move), so its border and corners keep their width, no dash
   * stretches, and its text and title only move, never scale. Opacity glides on the item's layer,
   * never the item: a faded item stays faded.
   */
  const glideItem = (id: string, el: HTMLElement, it: Item, a: Vis, b: Vis, fill: FillMode) => {
    const r = it.rect;
    if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.k === b.k && a.o === b.o) return;
    const opts: KeyframeAnimationOptions = { duration: GLIDE_MS, easing: EASE, fill };
    const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
    const uniform = (v: Vis) => near(v.w, v.k * r.w) && near(v.h, v.k * r.h);
    const place = (v: Vis, k: number) => `translate(${v.x}px, ${v.y}px)${k === 1 ? "" : ` scale(${k})`}`;
    let anim: Animation;
    if (uniform(a) && uniform(b)) {
      anim = el.animate([{ transform: place(a, a.k) }, { transform: place(b, b.k) }], opts);
    } else {
      anim = el.animate([{ transform: place(a, 1) }, { transform: place(b, 1) }], opts);
      a = { ...a, k: 1 };
      b = { ...b, k: 1 };
      const l = lookOf(it);
      wearSkin(el, RADIUS[l], l === "column" || l === "shared" || l === "rest" || l === "outBlock" || l === "outFrame", r, a, b, opts);
    }
    running.push(anim);
    if (a.o !== b.o && el.parentElement) running.push(el.parentElement.animate([{ opacity: a.o }, { opacity: b.o }], opts));
    tracks.set(id, { a, b, anim });
  };
  /**
   * An item's skin, glided from `a`'s size to `b`'s: the item's own border and fill hidden
   * meanwhile. Its corners move; its middle (fill only) stretches; a solid edge stretches along
   * its length, which a solid line doesn't show. A dashed edge (a column's, a Shared box's, a rest
   * block's) is its fill stretched, under two halves of its dashes, each the longer of its old and
   * new length, anchored to its own corner and cut off at the edge's middle: they only move, so
   * the dashes never stretch.
   */
  const wearSkin = (el: HTMLElement, R: number, dashed: boolean, r: Rect, a: Vis, b: Vis, opts: KeyframeAnimationOptions) => {
    const skin = document.createElement("div");
    skin.setAttribute("class", SKIN);
    skin.setAttribute("aria-hidden", "true");
    skin.dataset.skin = "";
    // A dashed edge's halves' lengths, across and down.
    const hx = Math.max(0, Math.max(a.w, b.w) / 2 - R), hy = Math.max(0, Math.max(a.h, b.h) / 2 - R);
    skin.style.setProperty("--hx", `${hx}px`);
    skin.style.setProperty("--hy", `${hy}px`);
    const t = (x: number, y: number) => `translate(${x}px, ${y}px)`;
    // Each piece's transform at `v`, its class, and for a half its inner piece's: placed at the
    // item's layout size, moved (and a solid edge or the middle stretched) to `v`'s.
    type Geo = { dx: number; dy: number; sx: number; sy: number; mx: number; my: number };
    type Piece = { cls: string; at: (g: Geo) => string; inner?: string; innerAt?: (g: Geo) => string };
    const geo = (v: Vis): Geo => ({
      dx: v.w - r.w,
      dy: v.h - r.h,
      sx: Math.max(0, v.w - 2 * R) / Math.max(1, r.w - 2 * R),
      sy: Math.max(0, v.h - 2 * R) / Math.max(1, r.h - 2 * R),
      mx: v.w / 2,
      my: v.h / 2,
    });
    const pieces: Piece[] = [
      { cls: SKIN_CORNERS[0]!, at: () => t(0, 0) },
      { cls: SKIN_CORNERS[1]!, at: (g) => t(g.dx, 0) },
      { cls: SKIN_CORNERS[2]!, at: (g) => t(0, g.dy) },
      { cls: SKIN_CORNERS[3]!, at: (g) => t(g.dx, g.dy) },
      ...(dashed
        ? [
            // The edges' fill, one stretched strip each (no seam where the halves meet), under their halves' dashes.
            { cls: SKIN_EDGE_FILLS[0]!, at: (g: Geo) => `${t(0, 0)} scale(${g.sx}, 1)` },
            { cls: SKIN_EDGE_FILLS[1]!, at: (g: Geo) => `${t(0, g.dy)} scale(${g.sx}, 1)` },
            { cls: SKIN_EDGE_FILLS[2]!, at: (g: Geo) => `${t(0, 0)} scale(1, ${g.sy})` },
            { cls: SKIN_EDGE_FILLS[3]!, at: (g: Geo) => `${t(g.dx, 0)} scale(1, ${g.sy})` },
            // Top and bottom: the left half's clip ends at the middle, its dashes start at the left corner's end; the right half's mirror it.
            { cls: SKIN_HALVES[0]!, inner: SKIN_HALF_EDGES[0]!, at: (g: Geo) => t(g.mx - hx, 0), innerAt: (g: Geo) => t(R + hx - g.mx, 0) },
            { cls: SKIN_HALVES[0]!, inner: SKIN_HALF_EDGES[0]!, at: (g: Geo) => t(g.mx, 0), innerAt: (g: Geo) => t(g.mx - R - hx, 0) },
            { cls: SKIN_HALVES[1]!, inner: SKIN_HALF_EDGES[1]!, at: (g: Geo) => t(g.mx - hx, g.dy), innerAt: (g: Geo) => t(R + hx - g.mx, 0) },
            { cls: SKIN_HALVES[1]!, inner: SKIN_HALF_EDGES[1]!, at: (g: Geo) => t(g.mx, g.dy), innerAt: (g: Geo) => t(g.mx - R - hx, 0) },
            // Left and right, the same down.
            { cls: SKIN_HALVES[2]!, inner: SKIN_HALF_EDGES[2]!, at: (g: Geo) => t(0, g.my - hy), innerAt: (g: Geo) => t(0, R + hy - g.my) },
            { cls: SKIN_HALVES[2]!, inner: SKIN_HALF_EDGES[2]!, at: (g: Geo) => t(0, g.my), innerAt: (g: Geo) => t(0, g.my - R - hy) },
            { cls: SKIN_HALVES[3]!, inner: SKIN_HALF_EDGES[3]!, at: (g: Geo) => t(g.dx, g.my - hy), innerAt: (g: Geo) => t(0, R + hy - g.my) },
            { cls: SKIN_HALVES[3]!, inner: SKIN_HALF_EDGES[3]!, at: (g: Geo) => t(g.dx, g.my), innerAt: (g: Geo) => t(0, g.my - R - hy) },
          ]
        : [
            { cls: SKIN_EDGES[0]!, at: (g: Geo) => `${t(0, 0)} scale(${g.sx}, 1)` },
            { cls: SKIN_EDGES[1]!, at: (g: Geo) => `${t(0, g.dy)} scale(${g.sx}, 1)` },
            { cls: SKIN_EDGES[2]!, at: (g: Geo) => `${t(0, 0)} scale(1, ${g.sy})` },
            { cls: SKIN_EDGES[3]!, at: (g: Geo) => `${t(g.dx, 0)} scale(1, ${g.sy})` },
          ]),
      { cls: SKIN_MIDDLE, at: (g) => `scale(${g.sx}, ${g.sy})` },
    ];
    const [ga, gb] = [geo(a), geo(b)];
    const moves: [HTMLElement, string, string][] = [];
    for (const p of pieces) {
      const d = document.createElement("div");
      d.setAttribute("class", p.cls);
      moves.push([d, p.at(ga), p.at(gb)]);
      if (p.inner && p.innerAt) {
        const inner = document.createElement("div");
        inner.setAttribute("class", p.inner);
        d.append(inner);
        moves.push([inner, p.innerAt(ga), p.innerAt(gb)]);
      }
      skin.append(d);
    }
    el.prepend(skin);
    el.style.setProperty("--bare", "transparent");
    el.style.setProperty("--worn", "0");
    skinned.add(el);
    for (const [d, from, to] of moves) {
      // Its place once the glide is over (its animation's, while it runs): a piece that doesn't move is placed too.
      d.style.setProperty("--at", to);
      if (from !== to) running.push(d.animate([{ transform: from }, { transform: to }], opts));
    }
  };
  /** Once a glide lands: the frame (or block) it was about brought into view. */
  const afterGlide = (sc: Scene, at: string | undefined) => {
    const it = at === undefined ? undefined : sc.items.get(at);
    if (it) reveal(it.rect);
  };

  // A selection made elsewhere (the panel, back and forward, a link) opens down to it if it's
  // inside a folded block, and comes into view if it's off screen.
  createEffect(nav.sel, (s) => {
    if (untrack(() => c.openTo(s))) return;
    queueMicrotask(() => revealSel(s));
  });
  const revealSel = (s: Sel | undefined) => {
    if (!s || untrack(c.glide)) return;
    const sc = untrack(scene);
    const [id] = untrack(selItems);
    const it = id === undefined ? undefined : sc.items.get(id);
    if (!it) return;
    const v = untrack(view), sz = untrack(size);
    const x0 = it.rect.x * v.z + v.x, y0 = it.rect.y * v.z + v.y;
    const off = x0 + it.rect.w * v.z < 0 || x0 > sz.w || y0 + it.rect.h * v.z < 0 || y0 > sz.h;
    if (off) reveal(it.rect);
  };
  createEffect(
    () => c.glide(),
    (g) => {
      if (g) return;
      // After an open-down glide, the selection comes into view.
      queueMicrotask(() => revealSel(untrack(nav.sel)));
    },
  );

  // ---- Gestures ---------------------------------------------------------------------------------

  const itemAt = (t: EventTarget | null) => (t instanceof window.Element ? t.closest<HTMLElement>("[data-item]") : null);
  const lineAt = (t: EventTarget | null) => (t instanceof window.Element ? t.closest<SVGElement>("[data-line],[data-trunk]") : null);
  const selectItem = (id: string) => {
    const it = scene().items.get(id);
    if (!it) return;
    if (it.node) nav.select(part(it.node.id));
    else if (it.group) nav.select({ kind: "group", id: it.group.id });
    else if (it.rest) nav.select(part(it.rest.of));
    else if (it.fold?.kind === "rest") {
      // A rest block under the fold: the part whose frame it's in.
      const frame = it.parent === undefined ? undefined : scene().items.get(it.parent);
      if (frame?.node) nav.select(part(frame.node.id));
    }
  };
  /** Back to the place the fold stands on (the PR, a purpose, the unclaimed parts); in layout A, to nothing. */
  const clearSel = () => {
    const f = untrack(scene).fold;
    nav.select(f ? selOfPlace(f.place) : undefined);
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toDrawing = (p: { x: number; y: number }) => {
    const v = untrack(view);
    return { x: (p.x - v.x) / v.z, y: (p.y - v.y) / v.z };
  };

  const onTitle = (e: Event) => e.target instanceof window.Element && !!e.target.closest("[data-title]");
  let press: { x: number; y: number; pan: boolean; moved: boolean; v: View; id: number } | undefined;
  /** A press that moved past the slop, panning or not: its click selects nothing. */
  let dragged = false;
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    viewport.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    // Mid-flight the drawing moves under the pointer: a press anywhere takes over, so the flight
    // stops where it is and picks nothing, whatever it lands on.
    if (untrack(flying) !== undefined) takeOver();
    // A drag pans from the background or an open frame's body; Space + drag from anywhere.
    const el = itemAt(e.target);
    const onThing = (el && !isOpen(scene().items.get(el.dataset.item!))) || lineAt(e.target) || (e.target instanceof window.Element && e.target.closest("[data-chrome]"));
    const p = local(e);
    press = { ...p, pan: untrack(space) || !onThing, moved: false, v: untrack(view), id: e.pointerId };
    dragged = false;
    if (untrack(space)) e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!press || press.id !== e.pointerId) return;
    const p = local(e);
    if (!press.moved && Math.hypot(p.x - press.x, p.y - press.y) > CLICK_SLOP) {
      press.moved = true;
      if (press.pan) viewport.setPointerCapture(e.pointerId);
    }
    if (press.pan && press.moved) {
      setPanning(true);
      takeOver();
      setView({ ...press.v, x: press.v.x + p.x - press.x, y: press.v.y + p.y - press.y });
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!press || press.id !== e.pointerId) return;
    dragged = press.moved;
    press = undefined;
    setPanning(false);
    if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
  };
  const onClick = (e: MouseEvent) => {
    if (dragged || untrack(space)) {
      dragged = false;
      return;
    }
    // A double-click's second click is the double-click's. Mid-glide the items take no pointer
    // (they aren't drawn where they are): a click there lands on nothing, not the background.
    const chrome = e.target instanceof window.Element && !!e.target.closest("[data-chrome]");
    if (e.detail > 1 || (untrack(c.glide) && !chrome)) return;
    const l = lineAt(e.target);
    if (l) {
      const id = l.dataset.line;
      if (id !== undefined) {
        const line = scene().lines.get(id);
        if (line) nav.select({ kind: "line", ids: line.members });
      } else if (l.dataset.trunk !== undefined) {
        const p = local(e);
        const sz = untrack(size);
        setPinned({ trunk: l.dataset.trunk, x: Math.max(8, Math.min(p.x + 14, sz.w - 440)), y: Math.max(8, Math.min(p.y + 14, sz.h - 240)) });
      }
      return;
    }
    const el = itemAt(e.target);
    const it = el ? scene().items.get(el.dataset.item!) : undefined;
    // The background, or a column's own room, clears the selection.
    if (!it || (it.kind === "column" && !it.folded && !onTitle(e))) {
      if (chrome) return;
      clearSel();
      return;
    }
    // A click on an open frame's title folds it.
    if (isOpen(it) && onTitle(e)) {
      c.fold(it.id);
      return;
    }
    // A click with no pointer behind it (detail 0: a screen reader's browse mode sends Enter as
    // one) on the selected block opens it, as Enter does. A mouse click only ever selects; a
    // double-click opens.
    if (e.detail === 0 && untrack(selItems).has(it.id) && opensIn(m(), it)) {
      openOrFold(it);
      return;
    }
    selectItem(it.id);
  };
  const onDblClick = (e: MouseEvent) => {
    const l = lineAt(e.target);
    if (l?.dataset.line !== undefined) {
      fly(l.dataset.line, toDrawing(local(e)));
      return;
    }
    const el = itemAt(e.target);
    if (!el) return;
    if (e.target instanceof window.Element && e.target.closest("[data-title]")) return;
    const it = scene().items.get(el.dataset.item!);
    if (it && opensIn(m(), it)) c.open(it.id);
    // Under the fold, a part with nothing inside to open: the code view at it.
    else if (it?.node && scene().fold && !isOpen(it) && !it.grid) c.codeView(it.node.id);
  };
  const onWheel = (e: WheelEvent) => {
    // Over the legend or a card, the wheel scrolls it (Ctrl/Cmd + scroll still zooms the drawing,
    // never the page).
    if (!e.ctrlKey && !e.metaKey && e.target instanceof window.Element && e.target.closest("[data-chrome]")) return;
    e.preventDefault();
    takeOver();
    if (e.ctrlKey || e.metaKey) {
      const p = local(e);
      zoomAt(p.x, p.y, untrack(view).z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)));
      return;
    }
    const k = e.deltaMode === 1 ? 16 : 1;
    const v = untrack(view);
    setView({ ...v, x: v.x - e.deltaX * k, y: v.y - e.deltaY * k });
  };
  /** Whether a key is the drawing's: the viewport's own, or a part's or line's (never a button's in a card or the legend). */
  const onDrawing = (t: EventTarget | null) => t === viewport || (t instanceof window.Element && (t.hasAttribute("data-item") || t.hasAttribute("data-line")));
  const onKeyDown = (e: KeyboardEvent) => {
    if (!onDrawing(e.target)) {
      // A card's or the legend's own keys: Enter, Space and the arrows work its buttons and scroll it.
      if (e.target instanceof window.Element && e.target.closest("[data-chrome]") && ["Enter", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) e.stopPropagation();
      return;
    }
    if (e.key === " " && !e.repeat) {
      setSpace(true);
      e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " ") setSpace(false);
  };
  const onOver = (e: PointerEvent) => {
    if (press?.moved) return;
    const p = local(e);
    const l = lineAt(e.target);
    if (l?.dataset.line !== undefined) return setHover({ kind: "line", id: l.dataset.line, ...p });
    if (l?.dataset.trunk !== undefined) return setHover({ kind: "trunk", id: l.dataset.trunk, ...p });
    const el = itemAt(e.target);
    if (el) {
      const it = scene().items.get(el.dataset.item!);
      // A frame's own body is its context: a hover card only over its title.
      const open = it && (it.kind === "frame" || ((it.kind === "box" || it.kind === "column") && !it.folded));
      if (open && !(e.target instanceof window.Element && e.target.closest("[data-title]"))) return setHover(undefined);
      return setHover({ kind: "item", id: el.dataset.item!, ...p });
    }
    setHover(undefined);
  };

  /** A double-click on a line: a glide to its far end, opening down to it, then selecting it. */
  const fly = (id: string, at: { x: number; y: number }) => {
    const sc = untrack(scene);
    const line = sc.lines.get(id);
    if (!line) return;
    const ends = [line.from, line.to].map((x) => (x === undefined ? undefined : sc.items.get(x)));
    const dist = (it: Item | undefined) => (it ? Math.hypot(it.rect.x + it.rect.w / 2 - at.x, it.rect.y + it.rect.h / 2 - at.y) : -1);
    const far = dist(ends[0]) > dist(ends[1]) ? 0 : 1;
    const end = ends[far];
    if (!end) return;
    // A line of one connection names its real end: opened down to, when it's inside the block.
    const e = line.members.length === 1 ? m().edges.get(line.members[0]!) : undefined;
    // Whichever of its ends the far block holds: a line runs from its first connection's `from`,
    // whatever way its arrows point (a reversed Data flow line's included).
    const holds = (n: string) => sc.holder(n) === end.id;
    const real = e ? (holds(e.from) ? e.from : holds(e.to) ? e.to : undefined) : undefined;
    const target = real !== undefined && end.node && real !== end.node.id && m().within(real, end.node.id) ? real : undefined;
    const go = () => {
      const now = untrack(scene);
      const it = (target !== undefined ? now.items.get(now.holder(target) ?? "") : undefined) ?? now.items.get(end.id);
      if (!it) return;
      const v = untrack(view), s = untrack(size);
      const to = { x: s.w / 2 - (it.rect.x + it.rect.w / 2) * v.z, y: s.h / 2 - (it.rect.y + it.rect.h / 2) * v.z, z: v.z };
      const far2 = Math.hypot(to.x - v.x, to.y - v.y);
      const diag = Math.hypot(s.w, s.h);
      const dip = Math.min(0.6, Math.max(0, far2 / diag - 0.4));
      stopTween();
      setFlying(id);
      const land = () => {
        setFlying(undefined);
        if (target !== undefined && now.items.has(target)) nav.select(part(target));
        else selectItem(it.id);
      };
      // Cut short (a drag, the wheel): nothing stays lit, nothing selected.
      panTo(to, Math.min(1100, 360 + far2 * 0.35), dip, land, () => setFlying(undefined));
    };
    clearTimeout(pendingFlight);
    if (target !== undefined && !sc.items.has(target) && c.openTo(part(target))) pendingFlight = setTimeout(go, reduced() ? 0 : GLIDE_MS + 20);
    else go();
  };

  // ---- Keys -------------------------------------------------------------------------------------

  touch("zoomIn", () => zoomBy(1.25));
  touch("zoomOut", () => zoomBy(0.8));
  touch("zoomReset", () => {
    const s = untrack(size);
    zoomAt(s.w / 2, s.h / 2, 1);
  });
  touch("zoomFit", fit);
  touch("outLevel", () => {
    // Folds the innermost open frame round the selection, and selects it.
    const sc = untrack(scene);
    const [id] = untrack(selItems);
    if (id === undefined) return;
    const open = (x: string | undefined) => {
      const it = x === undefined ? undefined : sc.items.get(x);
      return it && (it.kind === "frame" || ((it.kind === "box" || it.kind === "column") && !it.folded));
    };
    let f: string | undefined = open(id) ? id : sc.items.get(id)?.parent;
    while (f !== undefined && !open(f)) f = sc.items.get(f)?.parent;
    if (f === undefined) return;
    c.fold(f);
    selectItem(f);
  });
  /** What the keyboard acts on: the selection, else the block or line with the focus. */
  const target = (): { kind: "item" | "line"; id: string } | undefined => {
    const [l] = untrack(selLines);
    if (l !== undefined) return { kind: "line", id: l };
    const [i] = untrack(selItems);
    if (i !== undefined) return { kind: "item", id: i };
    const a = document.activeElement;
    if (a instanceof HTMLElement && a.dataset.item !== undefined) return { kind: "item", id: a.dataset.item };
    return undefined;
  };
  /** Opens a block with parts inside; folds an open frame, box or column. */
  const openOrFold = (it: Item) => {
    if (it.grid) return;
    if (isOpen(it)) c.fold(it.id);
    else if (opensIn(m(), it)) c.open(it.id);
    else if (it.node && untrack(scene).fold) c.codeView(it.node.id);
  };
  touch("openFold", () => {
    // Opens a block with parts inside, folds an open one; a line glides to its far end.
    const t = target();
    const sc = untrack(scene);
    if (t?.kind === "line") {
      const l = sc.lines.get(t.id);
      const from = l?.from === undefined ? undefined : sc.items.get(l.from);
      const at = from ? { x: from.rect.x + from.rect.w / 2, y: from.rect.y + from.rect.h / 2 } : l?.route[0];
      if (l && at) fly(l.id, at);
      return;
    }
    const it = t ? sc.items.get(t.id) : undefined;
    if (it) openOrFold(it);
  });
  /** Selects the nearest closed block in a direction from the selection (or from the focus's top left). */
  const move = (dx: number, dy: number) => {
    const sc = untrack(scene);
    const t = target();
    let o: P | undefined;
    if (t?.kind === "line") {
      const r = sc.lines.get(t.id)?.route ?? [];
      o = r[Math.floor(r.length / 2)];
    } else if (t) {
      const it = sc.items.get(t.id);
      // From inside an open frame or column: its top left, so its first part is the nearest.
      if (it) o = isOpen(it) ? { x: it.rect.x, y: it.rect.y } : { x: it.rect.x + it.rect.w / 2, y: it.rect.y + it.rect.h / 2 };
    }
    o ??= { x: 0, y: 0 };
    const open = !t || (t.kind === "item" && isOpen(sc.items.get(t.id)));
    let best: { id: string; d: number } | undefined;
    for (const it of sc.items.values()) {
      if (it.id === t?.id || !(it.kind === "part" || it.kind === "rest" || it.folded)) continue;
      if (open && t && !within(sc, it.id, t.id)) continue;
      const cx = it.rect.x + it.rect.w / 2 - o.x, cy = it.rect.y + it.rect.h / 2 - o.y;
      // Along the direction, then twice the distance across it: the nearest in that direction.
      const along = cx * dx + cy * dy, across = Math.abs(cx * dy - cy * dx);
      if (!open && along <= 1) continue;
      const d = open ? Math.hypot(cx, cy) : along + 2 * across;
      if (!best || d < best.d) best = { id: it.id, d };
    }
    if (best) selectItem(best.id);
  };
  touch("partLeft", () => move(-1, 0));
  touch("partRight", () => move(1, 0));
  touch("partUp", () => move(0, -1));
  touch("partDown", () => move(0, 1));
  /** The part whose lines ] and [ walk, while the selection is one of them. */
  let lineHub: string | undefined;
  /** An item's lines, clockwise round it from twelve o'clock by where their far ends are. */
  const linesRound = (sc: Scene, id: string): string[] => {
    const it = sc.items.get(id);
    if (!it) return [];
    let ls = [...sc.lines.values()].filter((l) => l.from === id || l.to === id);
    // An open frame or column with no line of its own: the lines of what's inside it.
    if (!ls.length) ls = [...relatedItem(sc, id).lines].map((l) => sc.lines.get(l)!).filter(Boolean);
    const cx = it.rect.x + it.rect.w / 2, cy = it.rect.y + it.rect.h / 2;
    const inHub = (x: string | undefined) => x !== undefined && (x === id || within(sc, x, id));
    /** Where a line's far end is: the middle of its end that isn't the hub or inside it, else its route's point furthest out. */
    const farPoint = (l: DLine): P => {
      const [fromIn, toIn] = [inHub(l.from), inHub(l.to)];
      if (fromIn !== toIn) {
        const far = fromIn ? l.to : l.from;
        const at = far === undefined ? undefined : sc.items.get(far);
        if (at) return { x: at.rect.x + at.rect.w / 2, y: at.rect.y + at.rect.h / 2 };
        // A frame's edge: where the route ends there.
        const end = fromIn ? l.route.at(-1) : l.route[0];
        if (end) return end;
      }
      let best: P = { x: cx, y: cy };
      for (const p of l.route) if (Math.hypot(p.x - cx, p.y - cy) > Math.hypot(best.x - cx, best.y - cy)) best = p;
      return best;
    };
    const angle = (l: DLine) => {
      const p = farPoint(l);
      const a = Math.atan2(p.x - cx, cy - p.y);
      return a < 0 ? a + 2 * Math.PI : a;
    };
    return ls.map((l) => ({ id: l.id, a: angle(l) })).sort((a, b) => a.a - b.a || (a.id < b.id ? -1 : 1)).map((x) => x.id);
  };
  /** Selects the selected part's next (or previous) line; from a line, the next of its part's. */
  const stepLine = (dir: 1 | -1) => {
    const sc = untrack(scene);
    const [l] = untrack(selLines);
    let hub: string | undefined;
    if (l !== undefined) {
      const line = sc.lines.get(l);
      hub = lineHub !== undefined && linesRound(sc, lineHub).includes(l) ? lineHub : (line?.from ?? line?.to);
    } else hub = target()?.id;
    if (hub === undefined || !sc.items.has(hub)) return;
    const ls = linesRound(sc, hub);
    if (!ls.length) return;
    const i = l === undefined ? -1 : ls.indexOf(l);
    const next = sc.lines.get(i < 0 ? ls[dir > 0 ? 0 : ls.length - 1]! : ls[(i + dir + ls.length) % ls.length]!)!;
    lineHub = hub;
    nav.select({ kind: "line", ids: next.members });
    // Off screen, its route comes into view.
    const xs = next.route.map((p) => p.x), ys = next.route.map((p) => p.y);
    const r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    const v = untrack(view), sz = untrack(size);
    const x0 = r.x * v.z + v.x, y0 = r.y * v.z + v.y;
    if (x0 + r.w * v.z < 0 || x0 > sz.w || y0 + r.h * v.z < 0 || y0 > sz.h) reveal(r);
  };
  touch("nextLine", () => stepLine(1));
  touch("previousLine", () => stepLine(-1));
  touch("canvasEscape", () => {
    if (untrack(keyPin) !== undefined) return setKeyPin(undefined);
    if (untrack(pinned)) return setPinned(undefined);
    clearSel();
  });

  onSettled(() => {
    const ro = new ResizeObserver(() => setSize({ w: viewport.clientWidth, h: viewport.clientHeight }));
    ro.observe(viewport);
    setSize({ w: viewport.clientWidth, h: viewport.clientHeight });
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      ro.disconnect();
      viewport.removeEventListener("wheel", onWheel);
    };
  });
  onCleanup(() => {
    cancelAnimationFrame(tween);
    clearTimeout(pendingFlight);
  });

  // The drawing on screen, for the perf suite and the tests: the analysis it drew, set once the
  // DOM holds it (effects run after the render), so the next frame paints both.
  createEffect(
    () => [scene(), m().g.id] as const,
    ([, id]) => {
      viewport.dataset.drawn = id;
    },
  );

  const gliding = () => c.glide() !== undefined;
  // The drawing's words: its keys, as the keymap has them now.
  const drawingLabel = createMemo(() => {
    const open = openKeys(), next = keysFor("nextLine"), prev = keysFor("previousLine");
    const lines = next && prev ? `, ${next} and ${prev} step through its lines` : next || prev ? `, ${next || prev} steps through its lines` : "";
    return `The PR's parts and lines: arrow keys move the selection${open ? `, ${open} opens or folds it` : ""}${lines}`;
  });
  return (
    <div {...stylex.attrs(s.canvas)} data-perf="canvas" style={{ "--fade": focus() ? 0.2 : 1 }}>
      <Toolbar />
      <FoldBar />
      <StepBar />
      <div
        ref={viewport}
        {...stylex.attrs(s.viewport, (space() || panning()) && s.grab)}
        tabindex={stop() ? -1 : 0}
        role="group"
        aria-roledescription="drawing"
        aria-label={drawingLabel()}
        data-keys="canvas"
        data-perf="canvas-viewport"
        data-flying={flying() === undefined ? undefined : ""}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerOver={onOver}
        onPointerLeave={() => setHover(undefined)}
        onClick={onClick}
        onDblClick={onDblClick}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => setSpace(false)}
      >
        <div class={gliding() ? WORLD_GLIDING : WORLD} style={{ "--tx": `${view().x}px`, "--ty": `${view().y}px`, "--z": view().z }}>
          <Show when={scene().grid}>
            {(g) => (
              <div class={GRID} style={{ "--x": `${g().x}px`, "--y": `${g().y}px`, "--w": `${g().w}px`, "--h": `${g().h}px` }} data-perf="no-lines-grid">
                <span class={GRID_TITLE}>
                  {scene().lonely.length} {scene().lonely.length === 1 ? "part" : "parts"} with no lines
                </span>
              </div>
            )}
          </Show>
          <For each={order()}>{(id) => <ItemView id={id} els={els} looks={looks} />}</For>
          <LineLayer gliding={gliding()} lineEls={lineEls} lineGone={lineGone} stop={isStopLine} focusing={focusing} inFocus={isFocusLine} trunkInFocus={isFocusTrunk} lit={isLitLine} trunkLit={isLitTrunk} />
        </div>
        <ZoomBar zoom={() => view().z} zoomBy={zoomBy} fit={fit} />
        <Legend hover={setKeyHover} pin={keyPin} setPin={setKeyPin} />
        <Cards hover={hover} pinned={pinned} unpin={() => setPinned(undefined)} move={(x, y) => setPinned((p) => p && { ...p, x, y })} rowLine={setRowLine} keep={() => untrack(hover)} />
      </div>
    </div>
  );
}

// ---- Items -------------------------------------------------------------------------------------

/** Whether an item is drawn open: a frame, or a box or column not folded. */
const isOpen = (it: Item | undefined) => !!it && (it.kind === "frame" || ((it.kind === "box" || it.kind === "column") && !it.folded));
/**
 * Whether a closed block opens: a folded group, box or column, or a part with parts inside (none
 * in the no-lines grid); under the fold, a part with blocks inside it in the fold's tree.
 */
const opensIn = (m: Model, it: Item) => !it.grid && !isOpen(it) && (it.folded || (it.kind === "part" && !!it.node && (it.opens ?? (m.children.get(it.node.id) ?? []).length > 0)));
/** The keys that run `action` on the canvas now, as people read them: for the words a screen reader says. */
const keysFor = (action: Action): string => keysIn(action, "canvas").map(showBinding).join(" or ");

const KINDS = ["part", "frame", "box", "column", "rest", "shared", "changedColumn", "groupBlock", "outBlock", "outFrame"] as const;
type Look = (typeof KINDS)[number];
/** How an item is drawn. */
function lookOf(x: Item): Look {
  if (x.fold?.kind === "out") return "outBlock";
  if (x.kind === "column" && x.group?.column === "conflict" && !x.folded) return "outFrame";
  if (x.kind === "rest") return "rest";
  if (x.group && x.folded) return "groupBlock";
  if (x.kind === "column") return x.group?.column === "changed" ? "changedColumn" : "column";
  if (x.kind === "box") return x.group?.kind === "shared" ? "shared" : "box";
  return x.kind;
}
/** Each look's corner radius (px): its style's `--r`, and the size of its skin's corners mid-glide. */
const RADIUS: Readonly<Record<Look, number>> = { part: 8, frame: 10, box: 10, shared: 10, column: 14, changedColumn: 14, rest: 8, groupBlock: 10, outBlock: 8, outFrame: 10 };
const CHANGES: readonly ChangeKey[] = ["added", "modified", "inside", "removed", "unchanged", "none"];
/** An item's four flags: selected, lit, faded by the lens, hovered. */
const FLAGS = 16;
/**
 * An item's class, in `ITEM`: a closed part's by its change and flags (6 × 16), then every other
 * look's by its flags alone (7 × 16): only a closed part shows its change.
 */
const itemBits = (look: Look, change: ChangeKey, selected: boolean, lit: boolean, faded: boolean, hovered: boolean) => {
  const flags = Number(selected) | (Number(lit) << 1) | (Number(faded) << 2) | (Number(hovered) << 3);
  return (look === "part" ? CHANGES.indexOf(change) : CHANGES.length - 1 + KINDS.indexOf(look)) * FLAGS + flags;
};

function ItemView(props: { id: string; els: Map<string, HTMLElement>; looks: Looks }) {
  const nav = useNav();
  const c = useCanvas();
  const m = () => nav.model();
  const id = props.id;
  const it = createMemo(() => c.scene().items.get(id) ?? c.glide()?.from.items.get(id));
  const look = createMemo((): Look => {
    const x = it();
    return x ? lookOf(x) : "part";
  });
  const closed = () => {
    const l = look();
    return l === "part" || l === "groupBlock" || l === "rest" || l === "outBlock";
  };
  const change = createMemo((): ChangeKey => {
    const x = it();
    return x?.node && closed() ? changeKey(m(), x.node) : "none";
  });
  const L = props.looks;
  const bits = createMemo(() => itemBits(look(), change(), !!L.sel[id], L.focusing() && !!L.lit[id], c.scene().faded.has(id), !!L.hovered[id] && closed()));
  const z = () => {
    const x = it();
    return x ? x.depth * 2 + (closed() ? 1 : 0) : 0;
  };
  const shown = () => !!it() && (c.scene().items.has(id) || c.glide() !== undefined);
  // A closed block's face, an open one's title: what it shows, and what a screen reader says it is.
  const face = createMemo(() => {
    const x = it();
    return x && closed() ? faceOf(m(), x, c.settings(), c.scene().fold?.place) : undefined;
  });
  const title = createMemo(() => {
    const x = it();
    return x && !closed() ? titleOf(m(), x, (n) => drawnFolders(m(), n).length) : undefined;
  });
  // Whether it opens (a closed block with parts inside), or is open: `aria-expanded`, and how its words say to open or fold it.
  const opens = createMemo(() => {
    const x = it();
    return !!x && opensIn(m(), x);
  });
  const open = createMemo(() => isOpen(it()));
  const label = () => {
    const f = face();
    const keys = L.openKeys();
    if (f) {
      const name = `${f.kind ? `${f.kind}${f.change !== "none" ? ` · ${CHANGE_WORD[f.change]}` : ""}, ` : ""}${f.name}`;
      return opens() ? `${name}, has parts inside${keys ? `, ${keys} opens` : ""}` : name;
    }
    const t = title();
    return t === undefined ? undefined : `${t.replace(/^▾ /, "")}${keys ? `, ${keys} folds` : ""}`;
  };
  const perf = () => {
    const l = look();
    return l === "part" ? "block" : l === "groupBlock" ? "group-block" : l === "changedColumn" ? "column" : l === "shared" ? "box" : l === "outBlock" ? "outside-block" : l === "outFrame" ? "outside-frame" : l;
  };
  // A zero-size layer per item, at its stacking level (by depth: a frame under what it holds); the
  // item inside it is what moves.
  return (
    <div class={LAYER[Math.min(z(), LAYERS - 1)]!} hidden={!shown()}>
      <div
        ref={(el) => props.els.set(id, el)}
        class={ITEM[bits()]!}
        data-item={id}
        tabindex={L.stop[id] ? 0 : -1}
        data-id={it()?.node?.id ?? it()?.group?.id ?? id}
        data-perf={perf()}
        data-fold={it()?.fold?.kind}
        data-dots={it()?.dots?.join(" ") || undefined}
        data-serve={it()?.serve ? `${it()!.serve!.n}/${it()!.serve!.total}` : undefined}
        data-grid={it()?.grid ? "" : undefined}
        data-change={closed() ? change() : undefined}
        data-faded={c.scene().faded.has(id) ? "" : undefined}
        data-selected={L.sel[id] ? "" : undefined}
        data-focus={L.focusing() ? (L.lit[id] ? "lit" : "dim") : undefined}
        role="button"
        aria-label={label()}
        aria-expanded={open() ? "true" : opens() ? "false" : undefined}
        aria-current={L.sel[id] ? "true" : undefined}
        style={{
          "--x": `${it()?.rect.x ?? 0}px`,
          "--y": `${it()?.rect.y ?? 0}px`,
          "--w": `${it()?.rect.w ?? 0}px`,
          "--h": `${it()?.rect.h ?? 0}px`,
          // Room for its dots at its top right, which its face's top line keeps clear of.
          "--dots": `${dotsRoom(it()?.dots?.length ?? 0)}px`,
        }}
      >
        <Show when={it()}>{(x) => <Show when={face()} fallback={<FrameTitle it={x()} title={title() ?? ""} />}>{(f) => <Block it={x()} face={f()} />}</Show>}</Show>
      </div>
    </div>
  );
}

function FrameTitle(props: { it: Item; title: string }) {
  return (
    <div class={props.it.group?.column === "conflict" && props.it.kind === "column" ? OUT_TITLE : props.it.kind === "frame" ? FRAME_TITLE : GROUP_TITLE} data-title="" data-perf="frame-title">
      {props.title}
    </div>
  );
}

function Block(props: { it: Item; face: Face }) {
  const nav = useNav();
  const c = useCanvas();
  const face = () => props.face;
  const fill = createMemo(() => (props.it.node ? fillOf(nav.model(), props.it.node, c.settings()) : undefined));
  const rings = createMemo(() => (props.it.node ? ringsOf(nav.model(), props.it.node, c.settings()) : undefined));
  const stripes = () => {
    const f = fill();
    return f?.by === "facet" ? f : undefined;
  };
  return (
    <>
      <Show when={stripes()}>
        {(f) => (
          <div class={STRIPES} aria-hidden="true">
            <Show when={f().none}>
              <div class={STRIPE_FILL[12]!} data-perf="stripe" data-none="" />
            </Show>
            <For each={f().stripes}>{(i) => <div class={STRIPE_FILL[i]!} data-perf="stripe" data-colour={i} />}</For>
            <Show when={f().more > 0}>
              <div class={STRIPE_MORE} data-perf="stripe" data-more="">
                +{f().more}
              </div>
            </Show>
          </div>
        )}
      </Show>
      <div class={FACE}>
        {/* Kind · change: the kind gives way first, the change word is never cut. */}
        <div class={FACE_TOP} data-perf="face-top">
          <span class={FACE_KIND}>{face().kind}</span>
          <Show when={face().change !== "none" && face().kind}>
            <span class={CHANGE_TEXT[face().change]}>
              {" · "}
              {CHANGE_WORD[face().change]}
            </span>
          </Show>
        </div>
        <div class={FACE_NAME} data-perf="face-name">
          {face().name}
        </div>
        <div class={FACE_BOTTOM} data-perf="face-bottom">
          {face().bottom}
        </div>
        <Show when={face().opens || face().partial}>
          <div class={FACE_MARKS} data-perf="face-marks">
            {face().partial ? "partly drawn" : ""}
            {face().partial && face().opens ? " · " : ""}
            {face().opens ? "double-click ▸" : ""}
          </div>
        </Show>
      </div>
      <Show when={props.it.dots?.length}>
        <Dots ids={props.it.dots!} />
      </Show>
      <Show when={rings()}>
        {(r) => (
          <>
            <For each={r().rings}>{(colour, i) => <div class={RING[i() * 12 + colour]!} aria-hidden="true" data-perf="ring" data-colour={colour} />}</For>
            <Show when={r().more > 0}>
              <div class={RING_MORE} data-perf="ring" data-more="">
                +{r().more}
              </div>
            </Show>
          </>
        )}
      </Show>
    </>
  );
}

/** A block's dots: one per top-level purpose it serves, in its colour; the stood-on purpose's larger. */
function Dots(props: { ids: readonly string[] }) {
  const nav = useNav();
  const c = useCanvas();
  const p = () => purposesOf(nav.model());
  const big = () => c.scene().fold?.purpose;
  return (
    <div class={DOTS} aria-hidden="true" data-perf="dots">
      <For each={props.ids.slice(0, MAX_DOTS)}>{(id) => <span class={id === big() ? DOT_BIG[p().colour(id)]! : DOT[p().colour(id)]!} data-perf="dot" data-purpose={id} data-big={id === big() ? "" : undefined} />}</For>
      <Show when={props.ids.length > MAX_DOTS}>
        <span class={DOTS_MORE}>+{props.ids.length - MAX_DOTS}</span>
      </Show>
    </div>
  );
}

/** How many dots a block shows before "+N". */
const MAX_DOTS = 6;
/** The room a block's dots take at its top right (px): 8 px each and 3 between, the larger one's 4 more, "+N". */
const dotsRoom = (n: number) => (n === 0 ? 0 : Math.min(n, MAX_DOTS) * 11 + 4 + (n > MAX_DOTS ? 16 : 0));

// ---- Lines -------------------------------------------------------------------------------------


/** A line's stroke width, by how many connections it carries. */
export const lineWidth = (n: number) => Math.min(1.5 + 0.6 * (n - 1), 5);

function LineLayer(props: {
  gliding: boolean;
  lineEls: Map<string, Element>;
  lineGone: (id: string, el: Element | undefined) => void;
  stop: Readonly<Record<string, true | undefined>>;
  focusing: () => boolean;
  inFocus: Readonly<Record<string, true | undefined>>;
  trunkInFocus: Readonly<Record<string, true | undefined>>;
  lit: Readonly<Record<string, true | undefined>>;
  trunkLit: Readonly<Record<string, true | undefined>>;
}) {
  const c = useCanvas();
  const nav = useNav();
  // Keyed by ID: a line drawn before and after an open or a pick keeps its elements.
  const ids = createMemo(() => [...c.scene().lines.keys()]);
  /**
   * Under the fold, a line's tone: faint (0), or carried by the place: strong purple at the PR or
   * the unclaimed parts (1), the stood-on purpose's colour (2–9). Undefined in layout A.
   */
  const toneOf = (carried: boolean): number | undefined => {
    const f = c.scene().fold;
    if (!f) return undefined;
    if (!carried) return 0;
    return f.purpose === undefined ? 1 : 2 + purposesOf(nav.model()).colour(f.purpose);
  };
  const trunkTone = (t: { lines: string[] }) => toneOf(t.lines.some((l) => c.scene().lines.get(l)?.carried));
  /** A line's words for a screen reader, its focus being how the keyboard reaches it. */
  const lineLabel = (l: DLine) => {
    const sc = c.scene(), m = c.model();
    const end = (x: string | undefined) => (x === undefined ? "the frame's edge" : (sc.items.get(x)?.group?.title ?? m.name(x)));
    const way = l.heads.to && l.heads.from ? "↔" : l.heads.from ? "←" : "→";
    return `${end(l.from)} ${way} ${end(l.to)}, ${l.count === 1 ? "1 connection" : `${l.count} connections`}`;
  };
  return (
    <svg class={props.gliding ? LINES_HIDDEN : LINES} width={c.scene().width} height={c.scene().height} data-perf="canvas-lines" data-gliding={props.gliding ? "" : undefined}>
      <g aria-hidden="true">
        <For each={c.scene().trunks}>
          {(t) => {
            const flags = () => Number(!!props.trunkLit[t.id]) | (Number(props.focusing() && !props.trunkInFocus[t.id]) << 1);
            return <path d={rounded(t.points)} class={trunkTone(t) === undefined ? TRUNK[Number(t.changed) | (flags() << 1)]! : FOLD_TRUNK[trunkTone(t)! * 4 + flags()]!} stroke-width={t.width} />;
          }}
        </For>
        <For each={ids()}>
          {(id) => <Show when={c.scene().lines.get(id)}>{(l) => <LinePath l={l()} lit={!!props.lit[id]} dim={props.focusing() && !props.inFocus[id]} tone={toneOf(l().carried)} />}</Show>}
        </For>
      </g>
      <For each={ids()}>
        {(id) => {
          let el: Element | undefined;
          onCleanup(() => props.lineGone(id, el));
          return (
          <Show when={c.scene().lines.get(id)}>
            {(l) => (
              <path
                d={rounded(l().route)}
                ref={(x) => props.lineEls.set(id, (el = x))}
                class={props.gliding ? HIT_AWAY : HIT}
                tabindex={props.stop[id] ? 0 : -1}
                aria-label={lineLabel(l())}
                data-line={id}
                data-perf="canvas-line"
                data-count={l().count}
                data-members={l().members.join(" ")}
                data-heads={l().heads.to && l().heads.from ? "both" : l().heads.from ? "from" : "to"}
                data-style={[l().changed ? "strong" : "quiet", l().dotted ? "dotted" : l().dashed ? "dashed" : "solid"].join(" ")}
                data-carried={c.scene().fold ? (l().carried ? "strong" : "faint") : undefined}
              />
            )}
          </Show>
          );
        }}
      </For>
      <g aria-hidden="true">
        <For each={c.scene().trunks}>{(t) => <path d={rounded(t.points)} class={props.gliding ? TRUNK_HIT_AWAY : TRUNK_HIT} stroke-width={t.width + 4} data-trunk={t.id} data-perf="trunk" />}</For>
      </g>
    </svg>
  );
}

function LinePath(props: { l: DLine; lit: boolean; dim: boolean; tone?: number }) {
  const d = createMemo(() => rounded(props.l.route));
  const to = createMemo(() => (props.l.heads.to && props.l.to !== undefined ? tipOf(props.l.route, false) : undefined));
  const from = createMemo(() => (props.l.heads.from && props.l.from !== undefined ? tipOf(props.l.route, true) : undefined));
  // The count sits where the line leaves its part: its tail (the end with no arrowhead), unless
  // that's a frame's edge, then its part end.
  const at = createMemo(() => {
    const l = props.l;
    if (l.count < 2) return undefined;
    let atEnd = l.heads.from && !l.heads.to;
    if ((atEnd ? l.to : l.from) === undefined) atEnd = !atEnd;
    return (atEnd ? l.to : l.from) === undefined ? undefined : countAt(l.route, atEnd);
  });
  const bits = () => Number(props.l.changed) | (Number(props.l.dashed && !props.l.dotted) << 1) | (Number(props.l.dotted) << 2) | (Number(props.lit) << 3) | (Number(props.dim && !props.lit) << 4);
  const head = () => Number(props.l.changed) | (Number(props.lit) << 1) | (Number(props.dim && !props.lit) << 2);
  // Under the fold: its tone, its dashes, lit, dimmed.
  const foldBits = () => (props.tone ?? 0) * 12 + (props.l.dotted ? 2 : props.l.dashed ? 1 : 0) * 4 + Number(props.lit) * 2 + Number(props.dim && !props.lit);
  const foldHead = () => (props.tone ?? 0) * 4 + Number(props.lit) * 2 + Number(props.dim && !props.lit);
  return (
    <g data-line-drawn={props.l.id} data-lit={props.lit ? "" : undefined}>
      <path d={d()} class={props.tone === undefined ? LINE[bits()]! : FOLD_LINE[foldBits()]!} stroke-width={lineWidth(props.l.count) + (props.lit ? 1 : 0) + (props.tone !== undefined && props.tone > 0 ? 0.75 : 0)} />
      <Show when={to()}>{(t) => <path d={arrow(t())} class={props.tone === undefined ? HEAD[head()]! : FOLD_HEAD[foldHead()]!} />}</Show>
      <Show when={from()}>{(t) => <path d={arrow(t())} class={props.tone === undefined ? HEAD[head()]! : FOLD_HEAD[foldHead()]!} />}</Show>
      <Show when={at()}>
        {(p) => (
          <text x={p().x} y={p().y} class={COUNT[Number(props.dim && !props.lit)]!}>
            {props.l.count}
          </text>
        )}
      </Show>
    </g>
  );
}

// ---- Styles ------------------------------------------------------------------------------------

const s = stylex.create({
  canvas: { backgroundColor: graph.canvas, display: "flex", flexDirection: "column", position: "relative", height: "100%", minHeight: 0, },
  viewport: {
    outline: { default: "none", ":focus-visible": `2px solid ${colors.accent}` },
    // Clipped, never scrolled: a card or a focused button near the edge mustn't move the drawing.
    overflow: "clip",
    cursor: "default",
    flexGrow: 1,
    outlineOffset: -2,
    position: "relative",
    touchAction: "none",
    userSelect: "none",
    minHeight: 0,
  },
  grab: { cursor: "grabbing" },
});

const st = stylex.create({
  world: {
    position: "absolute",
    transform: "translate(var(--tx), var(--ty)) scale(var(--z))",
    transformOrigin: "0 0",
    left: 0,
    top: 0,
  },
  // Mid-glide nothing in the drawing takes the pointer: its items aren't drawn where they are, and
  // its lines are away. A press there pans; a click lands on nothing.
  worldGliding: { pointerEvents: "none" },
  // An item's border and fill are its look's custom properties (`--edge`, `--edge-w`, `--fill`,
  // `--r`; its border's style its skin inherits), so its skin's pieces draw the same mid-glide;
  // `--bare` (set while it wears one) hides its own.
  item: {
    "--edge-w": "1.5px",
    borderColor: "var(--bare, var(--edge))",
    borderRadius: "var(--r)",
    borderStyle: "solid",
    borderWidth: "var(--edge-w)",
    backgroundColor: "var(--bare, var(--fill))",
    boxSizing: "border-box",
    fontFamily: fonts.ui,
    opacity: "var(--fade, 1)",
    position: "absolute",
    transform: "translate(var(--x), var(--y))",
    transformOrigin: "0 0",
    transitionDuration: "120ms",
    transitionProperty: "opacity",
    height: "var(--h)",
    left: 0,
    top: 0,
    width: "var(--w)",
  },
  part: { "--edge": graph.partEdge, "--fill": graph.part, "--r": `${RADIUS.part}px`, cursor: "pointer" },
  frame: { "--edge": graph.partEdge, "--fill": graph.canvas, "--r": `${RADIUS.frame}px`, borderStyle: "solid", },
  box: { "--edge": graph.boxEdge, "--edge-w": "1px", "--fill": graph.boxFill, "--r": `${RADIUS.box}px`, borderStyle: "solid", },
  shared: { "--edge": graph.boxEdge, "--edge-w": "1px", "--fill": graph.boxFill, "--r": `${RADIUS.shared}px`, borderStyle: "dashed", },
  column: { "--edge": graph.groupEdge, "--edge-w": "1px", "--fill": "transparent", "--r": `${RADIUS.column}px`, borderStyle: "dashed", },
  changedColumn: { "--edge": colors.warn, "--fill": graph.changedGroup, "--r": `${RADIUS.changedColumn}px`, borderStyle: "solid", },
  rest: { "--edge": graph.partEdge, "--fill": graph.outsideFill, "--r": `${RADIUS.rest}px`, borderStyle: "dashed", color: colors.muted, cursor: "default", },
  groupBlock: { "--edge": graph.partEdge, "--edge-w": "2.5px", "--fill": graph.outsideFill, "--r": `${RADIUS.groupBlock}px`, cursor: "pointer" },
  // Under the fold: a part reached only through a conflict, and the column holding them.
  outBlock: { "--edge": colors.warn, "--fill": graph.part, "--r": `${RADIUS.outBlock}px`, borderStyle: "dashed", cursor: "pointer" },
  outFrame: { "--edge": colors.warn, "--edge-w": "1px", "--fill": "transparent", "--r": `${RADIUS.outFrame}px`, borderStyle: "dashed" },
  added: { "--edge": colors.open, "--fill": graph.addedFill },
  modified: { "--edge": colors.warn, "--fill": graph.modifiedFill },
  inside: { "--edge": colors.warn, "--fill": graph.insideFill },
  removed: { "--edge": colors.danger, "--fill": graph.removedFill },
  unchanged: {},
  none: {},
  outside: { "--fill": graph.outsideFill },
  selected: { outlineColor: `var(--bare, ${colors.accent})`, outlineOffset: 3, outlineStyle: "solid", outlineWidth: 2.5 },
  lit: { opacity: 1 },
  faded: { opacity: 0.4 },
  hovered: { boxShadow: `0 2px 10px ${colors.popShadow}` },
  // A resizing item's skin mid-glide, over its border box, under its content.
  skin: { inset: "calc(-1 * var(--edge-w))", borderStyle: "inherit", borderWidth: 0, pointerEvents: "none", position: "absolute", zIndex: -1, },
  // `--at`: its transform once the glide is over (wearSkin).
  piece: {
    borderColor: "var(--edge)",
    borderStyle: "inherit",
    borderWidth: 0,
    backgroundColor: "var(--fill)",
    boxSizing: "border-box",
    position: "absolute",
    transform: "var(--at)",
    transformOrigin: "0 0",
  },
  // A dashed edge's half: a clip (`--hx` or `--hy` long, from wearSkin) round its piece.
  half: { borderStyle: "inherit", borderWidth: 0, overflow: "hidden", position: "absolute", transform: "var(--at)", transformOrigin: "0 0", },
  halfAcross: { height: "var(--r)", left: 0, width: "var(--hx)" },
  halfDown: { height: "var(--hy)", top: 0, width: "var(--r)" },
  atTop: { top: 0 },
  atBottom: { bottom: 0 },
  atLeft: { left: 0 },
  atRight: { right: 0 },
  halfEdge: { inset: 0, backgroundColor: "transparent" },
  fillOnly: { borderBottomWidth: 0, borderLeftWidth: 0, borderRightWidth: 0, borderTopWidth: 0 },
  corner: { height: "var(--r)", width: "var(--r)" },
  across: { height: "var(--r)", left: "var(--r)", width: "calc(100% - 2 * var(--r))" },
  down: { height: "calc(100% - 2 * var(--r))", top: "var(--r)", width: "var(--r)" },
  tl: { borderLeftWidth: "var(--edge-w)", borderTopLeftRadius: "var(--r)", borderTopWidth: "var(--edge-w)", left: 0, top: 0 },
  tr: { borderRightWidth: "var(--edge-w)", borderTopRightRadius: "var(--r)", borderTopWidth: "var(--edge-w)", right: 0, top: 0 },
  bl: { borderBottomLeftRadius: "var(--r)", borderBottomWidth: "var(--edge-w)", borderLeftWidth: "var(--edge-w)", bottom: 0, left: 0 },
  br: { borderBottomRightRadius: "var(--r)", borderBottomWidth: "var(--edge-w)", borderRightWidth: "var(--edge-w)", bottom: 0, right: 0 },
  top: { borderTopWidth: "var(--edge-w)", top: 0 },
  bottom: { borderBottomWidth: "var(--edge-w)", bottom: 0 },
  left: { borderLeftWidth: "var(--edge-w)", left: 0 },
  right: { borderRightWidth: "var(--edge-w)", right: 0 },
  middle: { height: "calc(100% - 2 * var(--r))", left: "var(--r)", top: "var(--r)", width: "calc(100% - 2 * var(--r))" },
  // A block's stripes are at its own size: hidden while it wears a skin mid-glide (`--worn`), whose
  // fill stands in, and faded back in as it lands (at once out, eased in).
  stripes: {
    inset: 0,
    borderRadius: 7,
    overflow: "hidden",
    display: "flex",
    opacity: "var(--worn, 1)",
    pointerEvents: "none",
    position: "absolute",
    transitionDuration: "calc(var(--worn, 1) * 150ms)",
    transitionProperty: "opacity",
  },
  stripe: { flexBasis: 0, flexGrow: 1, borderTopStyle: "solid", borderTopWidth: 4, height: "100%", },
  stripeNone: { backgroundColor: graph.noValueFill, borderTopColor: graph.noValue },
  stripeMore: { backgroundColor: graph.noValueFill, color: colors.muted, fontSize: 10, fontWeight: 700, textAlign: "center", borderTopColor: graph.noValue, paddingTop: 50, },
  face: {
    gap: 1,
    overflow: "hidden",
    paddingBlock: 5,
    paddingInline: 10,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    pointerEvents: "none",
    position: "relative",
    height: "100%",
  },
  faceTop: { alignItems: "baseline", display: "flex", fontSize: 10.5, lineHeight: 1.25, paddingInlineEnd: "var(--dots, 0px)", whiteSpace: "pre", },
  faceKind: { overflow: "hidden", color: colors.muted, flexShrink: 1, textOverflow: "ellipsis", minWidth: 0, },
  faceMarks: { overflow: "hidden", color: colors.accent, fontSize: 10.5, fontWeight: 600, lineHeight: 1.25, textOverflow: "ellipsis", whiteSpace: "nowrap", },
  changeWord: { flexShrink: 0 },
  faceName: { overflow: "hidden", color: colors.fg, fontSize: 13, fontWeight: 650, lineHeight: 1.25, textOverflow: "ellipsis", whiteSpace: "nowrap", },
  faceBottom: { overflow: "hidden", color: colors.muted, fontSize: 11, lineHeight: 1.25, textOverflow: "ellipsis", whiteSpace: "nowrap", },
  ring: { borderRadius: 10, borderStyle: "solid", borderWidth: 2, pointerEvents: "none", position: "absolute" },
  // A block's purpose dots, at its top right, over its face.
  dots: { gap: 3, alignItems: "center", display: "flex", pointerEvents: "none", position: "absolute", right: 7, top: 6 },
  dot: { borderRadius: 999, flexShrink: 0, height: 8, width: 8 },
  dotBig: { borderRadius: 999, boxShadow: `0 0 0 1.5px ${graph.part}`, flexShrink: 0, height: 12, width: 12 },
  dotsMore: { color: colors.muted, fontSize: 9.5, fontWeight: 700 },
  // The Outside column's title: two lines in its title's room, never cut.
  outTitle: {
    overflow: "hidden",
    paddingInline: 12,
    boxSizing: "border-box",
    color: colors.warn,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 650,
    lineHeight: "15px",
    paddingBlockStart: 7,
    textWrap: "balance",
    height: 44,
  },
  ringMore: {
    borderColor: graph.partEdge,
    borderRadius: 999,
    borderStyle: "solid",
    borderWidth: 1,
    paddingInline: 4,
    backgroundColor: graph.part,
    color: colors.muted,
    fontSize: 10,
    fontWeight: 700,
    pointerEvents: "none",
    position: "absolute",
    right: -14,
    top: -14,
  },
  frameTitle: {
    overflow: "hidden",
    paddingInline: 12,
    boxSizing: "border-box",
    color: colors.fg,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 650,
    lineHeight: "34px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    height: 34,
  },
  groupTitle: {
    overflow: "hidden",
    paddingInline: 12,
    boxSizing: "border-box",
    color: colors.muted,
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 650,
    lineHeight: "30px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    height: 30,
  },
  grid: {
    borderColor: graph.groupEdge,
    borderRadius: 12,
    borderStyle: "dotted",
    borderWidth: 1.5,
    boxSizing: "border-box",
    position: "absolute",
    transform: "translate(var(--x), var(--y))",
    height: "var(--h)",
    left: 0,
    top: 0,
    width: "var(--w)",
  },
  gridTitle: { paddingBlock: 10, paddingInline: 12, color: colors.muted, display: "block", fontFamily: fonts.ui, fontSize: 12, fontWeight: 650, },
  lines: { overflow: "visible", pointerEvents: "none", position: "absolute", transitionDuration: "180ms", transitionProperty: "opacity", zIndex: 1000, left: 0, top: 0, },
  linesHidden: { opacity: 0, transitionDuration: "0s" },
});

/** Under the fold, a line's tone (`toneOf`): faint, strong purple, then each purpose colour. */
const toneStroke = stylex.create({
  faint: { stroke: graph.lineQuiet },
  strong: { stroke: graph.line },
  p0: { stroke: graph.purpose0 },
  p1: { stroke: graph.purpose1 },
  p2: { stroke: graph.purpose2 },
  p3: { stroke: graph.purpose3 },
  p4: { stroke: graph.purpose4 },
  p5: { stroke: graph.purpose5 },
  p6: { stroke: graph.purpose6 },
  p7: { stroke: graph.purpose7 },
});
const toneFill = stylex.create({
  faint: { fill: graph.lineQuiet },
  strong: { fill: graph.line },
  p0: { fill: graph.purpose0 },
  p1: { fill: graph.purpose1 },
  p2: { fill: graph.purpose2 },
  p3: { fill: graph.purpose3 },
  p4: { fill: graph.purpose4 },
  p5: { fill: graph.purpose5 },
  p6: { fill: graph.purpose6 },
  p7: { fill: graph.purpose7 },
});
const TONES = ["faint", "strong", "p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"] as const;

const ringAt = stylex.create({
  r0: { inset: -5 },
  r1: { inset: -9, borderRadius: 13 },
  r2: { inset: -13, borderRadius: 16 },
});
const RING_AT = [ringAt.r0, ringAt.r1, ringAt.r2];

const fills = stylex.create({
  f0: { backgroundColor: graph.facet0Fill, borderTopColor: graph.facet0 },
  f1: { backgroundColor: graph.facet1Fill, borderTopColor: graph.facet1 },
  f2: { backgroundColor: graph.facet2Fill, borderTopColor: graph.facet2 },
  f3: { backgroundColor: graph.facet3Fill, borderTopColor: graph.facet3 },
  f4: { backgroundColor: graph.facet4Fill, borderTopColor: graph.facet4 },
  f5: { backgroundColor: graph.facet5Fill, borderTopColor: graph.facet5 },
  f6: { backgroundColor: graph.facet6Fill, borderTopColor: graph.facet6 },
  f7: { backgroundColor: graph.facet7Fill, borderTopColor: graph.facet7 },
  f8: { backgroundColor: graph.facet8Fill, borderTopColor: graph.facet8 },
  f9: { backgroundColor: graph.facet9Fill, borderTopColor: graph.facet9 },
  f10: { backgroundColor: graph.facet10Fill, borderTopColor: graph.facet10 },
  f11: { backgroundColor: graph.facet11Fill, borderTopColor: graph.facet11 },
});
export const FACET_FILL = [fills.f0, fills.f1, fills.f2, fills.f3, fills.f4, fills.f5, fills.f6, fills.f7, fills.f8, fills.f9, fills.f10, fills.f11];
const edges = stylex.create({
  e0: { borderColor: graph.facet0 },
  e1: { borderColor: graph.facet1 },
  e2: { borderColor: graph.facet2 },
  e3: { borderColor: graph.facet3 },
  e4: { borderColor: graph.facet4 },
  e5: { borderColor: graph.facet5 },
  e6: { borderColor: graph.facet6 },
  e7: { borderColor: graph.facet7 },
  e8: { borderColor: graph.facet8 },
  e9: { borderColor: graph.facet9 },
  e10: { borderColor: graph.facet10 },
  e11: { borderColor: graph.facet11 },
});
export const FACET_EDGE = [edges.e0, edges.e1, edges.e2, edges.e3, edges.e4, edges.e5, edges.e6, edges.e7, edges.e8, edges.e9, edges.e10, edges.e11];

const changeText = stylex.create({
  added: { color: colors.open },
  modified: { color: colors.warn },
  inside: { color: colors.warn },
  removed: { color: colors.danger },
  unchanged: { color: colors.muted },
  none: { color: colors.muted },
});

const ln = stylex.create({
  line: { fill: "none", stroke: graph.lineQuiet, strokeLinecap: "round", strokeLinejoin: "round", opacity: "var(--fade, 1)", },
  changed: { stroke: graph.line },
  dashed: { strokeDasharray: "7 5" },
  dotted: { strokeDasharray: "1.5 4.5" },
  lit: { stroke: graph.lineLit, opacity: 1, },
  dim: { opacity: 0.12 },
  head: { fill: graph.lineQuiet, opacity: "var(--fade, 1)" },
  headChanged: { fill: graph.line },
  headLit: { fill: graph.lineLit, opacity: 1 },
  trunk: { fill: "none", stroke: graph.lineQuiet, strokeLinecap: "butt", strokeLinejoin: "round", opacity: 0.45, },
  trunkChanged: { stroke: graph.line },
  trunkLit: { stroke: graph.lineLit, opacity: 0.7, },
  dimTrunk: { opacity: 0.08 },
  count: {
    fill: colors.fg,
    stroke: graph.canvas,
    strokeLinejoin: "round",
    strokeWidth: 3,
    textAnchor: "middle",
    fontFamily: fonts.ui,
    fontSize: 11,
    fontWeight: 700,
    opacity: "var(--fade, 1)",
    paintOrder: "stroke",
  },
  hit: { fill: "none", stroke: "transparent", strokeWidth: 10, cursor: "pointer", pointerEvents: "stroke", },
  trunkHit: { fill: "none", stroke: "transparent", strokeLinecap: "butt", cursor: "pointer", pointerEvents: "stroke", },
  // Mid-glide the lines are away: they take no pointer.
  away: { pointerEvents: "none" },
  // Under the fold: a line the place doesn't carry, faint; a lit one the place carries keeps its colour.
  faint: { opacity: "calc(var(--fade, 1) * 0.5)" },
  litKeep: { opacity: 1 },
  trunkFaint: { opacity: 0.22 },
});

const LOOK_STYLE: Record<Look, stylex.StyleXStyles> = {
  part: st.part,
  frame: st.frame,
  box: st.box,
  column: st.column,
  rest: st.rest,
  shared: st.shared,
  changedColumn: st.changedColumn,
  groupBlock: st.groupBlock,
  outBlock: st.outBlock,
  outFrame: st.outFrame,
};
/** Stacking levels: two per depth (a frame, then the closed blocks it holds), 32 in all. */
const LAYERS = 32;
const layers = stylex.create({
  z0: { position: "absolute", zIndex: 0, left: 0, top: 0, },
  z1: { position: "absolute", zIndex: 1, left: 0, top: 0, },
  z2: { position: "absolute", zIndex: 2, left: 0, top: 0, },
  z3: { position: "absolute", zIndex: 3, left: 0, top: 0, },
  z4: { position: "absolute", zIndex: 4, left: 0, top: 0, },
  z5: { position: "absolute", zIndex: 5, left: 0, top: 0, },
  z6: { position: "absolute", zIndex: 6, left: 0, top: 0, },
  z7: { position: "absolute", zIndex: 7, left: 0, top: 0, },
  z8: { position: "absolute", zIndex: 8, left: 0, top: 0, },
  z9: { position: "absolute", zIndex: 9, left: 0, top: 0, },
  z10: { position: "absolute", zIndex: 10, left: 0, top: 0, },
  z11: { position: "absolute", zIndex: 11, left: 0, top: 0, },
  z12: { position: "absolute", zIndex: 12, left: 0, top: 0, },
  z13: { position: "absolute", zIndex: 13, left: 0, top: 0, },
  z14: { position: "absolute", zIndex: 14, left: 0, top: 0, },
  z15: { position: "absolute", zIndex: 15, left: 0, top: 0, },
  z16: { position: "absolute", zIndex: 16, left: 0, top: 0, },
  z17: { position: "absolute", zIndex: 17, left: 0, top: 0, },
  z18: { position: "absolute", zIndex: 18, left: 0, top: 0, },
  z19: { position: "absolute", zIndex: 19, left: 0, top: 0, },
  z20: { position: "absolute", zIndex: 20, left: 0, top: 0, },
  z21: { position: "absolute", zIndex: 21, left: 0, top: 0, },
  z22: { position: "absolute", zIndex: 22, left: 0, top: 0, },
  z23: { position: "absolute", zIndex: 23, left: 0, top: 0, },
  z24: { position: "absolute", zIndex: 24, left: 0, top: 0, },
  z25: { position: "absolute", zIndex: 25, left: 0, top: 0, },
  z26: { position: "absolute", zIndex: 26, left: 0, top: 0, },
  z27: { position: "absolute", zIndex: 27, left: 0, top: 0, },
  z28: { position: "absolute", zIndex: 28, left: 0, top: 0, },
  z29: { position: "absolute", zIndex: 29, left: 0, top: 0, },
  z30: { position: "absolute", zIndex: 30, left: 0, top: 0, },
  z31: { position: "absolute", zIndex: 31, left: 0, top: 0, },
});
const LAYER = cxTable(LAYERS, (i) => [layers[`z${i}` as keyof typeof layers]]);
const ITEM = cxTable((CHANGES.length + KINDS.length - 1) * FLAGS, (i) => {
  const at = Math.floor(i / FLAGS);
  const look = at < CHANGES.length ? "part" : (KINDS[at - CHANGES.length + 1] ?? "part");
  const change = at < CHANGES.length ? CHANGES[at]! : "none";
  const closedPart = look === "part";
  return [
    st.item,
    LOOK_STYLE[look],
    closedPart && st[change],
    closedPart && change === "none" && st.outside,
    !!(i & 1) && st.selected,
    !!(i & 4) && st.faded,
    !!(i & 2) && st.lit,
    !!(i & 8) && st.hovered,
  ];
});
const WORLD = cx(st.world);
const WORLD_GLIDING = cx(st.world, st.worldGliding);
const SKIN = cx(st.skin);
/** A skin's pieces: its four corners (top left, top right, bottom left, bottom right); its top, bottom, left and right edges, solid; a dashed one's halves' clips and edges; its middle. */
const SKIN_CORNERS = [cx(st.piece, st.corner, st.tl), cx(st.piece, st.corner, st.tr), cx(st.piece, st.corner, st.bl), cx(st.piece, st.corner, st.br)];
const SKIN_EDGES = [cx(st.piece, st.across, st.top), cx(st.piece, st.across, st.bottom), cx(st.piece, st.down, st.left), cx(st.piece, st.down, st.right)];
const SKIN_EDGE_FILLS = [
  cx(st.piece, st.across, st.top, st.fillOnly),
  cx(st.piece, st.across, st.bottom, st.fillOnly),
  cx(st.piece, st.down, st.left, st.fillOnly),
  cx(st.piece, st.down, st.right, st.fillOnly),
];
const SKIN_HALVES = [cx(st.half, st.halfAcross, st.atTop), cx(st.half, st.halfAcross, st.atBottom), cx(st.half, st.halfDown, st.atLeft), cx(st.half, st.halfDown, st.atRight)];
const SKIN_HALF_EDGES = [cx(st.piece, st.halfEdge, st.top), cx(st.piece, st.halfEdge, st.bottom), cx(st.piece, st.halfEdge, st.left), cx(st.piece, st.halfEdge, st.right)];
const SKIN_MIDDLE = cx(st.piece, st.middle);
const FACE = cx(st.face);
const FACE_TOP = cx(st.faceTop);
const FACE_KIND = cx(st.faceKind);
const FACE_MARKS = cx(st.faceMarks);
const FACE_NAME = cx(st.faceName);
const FACE_BOTTOM = cx(st.faceBottom);
const STRIPES = cx(st.stripes);
const FRAME_TITLE = cx(st.frameTitle);
const GROUP_TITLE = cx(st.groupTitle);
const GRID = cx(st.grid);
const GRID_TITLE = cx(st.gridTitle);
const LINES = cx(st.lines);
const LINES_HIDDEN = cx(st.lines, st.linesHidden);
const CHANGE_TEXT = cxMap(CHANGES, (k) => [changeText[k], st.changeWord]);
const STRIPE_FILL = cxTable(13, (i) => [st.stripe, i < 12 ? FACET_FILL[i] : st.stripeNone]);
const STRIPE_MORE = cx(st.stripe, st.stripeMore);
const RING = cxTable(36, (i) => [st.ring, RING_AT[Math.floor(i / 12)], FACET_EDGE[i % 12]]);
const RING_MORE = cx(st.ringMore);
/** A line's class: changed, dashed, dotted, lit, faded. */
const LINE = cxTable(32, (i) => [ln.line, !!(i & 1) && ln.changed, !!(i & 2) && ln.dashed, !!(i & 4) && ln.dotted, !!(i & 8) && ln.lit, !!(i & 16) && ln.dim]);
const HEAD = cxTable(8, (i) => [ln.head, !!(i & 1) && ln.headChanged, !!(i & 2) && ln.headLit, !!(i & 4) && ln.dim]);
const TRUNK = cxTable(8, (i) => [ln.trunk, !!(i & 1) && ln.trunkChanged, !!(i & 2) && ln.trunkLit, !!(i & 4) && ln.dimTrunk]);
const COUNT = cxTable(2, (i) => [ln.count, !!i && ln.dim]);
/** Under the fold, a line's class: its tone (10), dashes (solid, dashed, dotted), lit, dimmed. */
const FOLD_LINE = cxTable(TONES.length * 12, (i) => {
  const t = Math.floor(i / 12), dash = Math.floor((i % 12) / 4), lit = !!(i & 2), dim = !!(i & 1);
  return [ln.line, toneStroke[TONES[t]!], t === 0 && ln.faint, dash === 1 && ln.dashed, dash === 2 && ln.dotted, lit && (t === 0 ? ln.lit : ln.litKeep), dim && ln.dim];
});
const FOLD_HEAD = cxTable(TONES.length * 4, (i) => {
  const t = Math.floor(i / 4), lit = !!(i & 2), dim = !!(i & 1);
  return [ln.head, toneFill[TONES[t]!], t === 0 && ln.faint, lit && (t === 0 ? ln.headLit : ln.litKeep), dim && ln.dim];
});
const FOLD_TRUNK = cxTable(TONES.length * 4, (i) => {
  const t = Math.floor(i / 4), lit = !!(i & 1), dim = !!(i & 2);
  return [ln.trunk, toneStroke[TONES[t]!], t === 0 && ln.trunkFaint, lit && (t === 0 ? ln.trunkLit : ln.litKeep), dim && ln.dimTrunk];
});
const DOTS = cx(st.dots);
const DOT = cxTable(8, (i) => [st.dot, PURPOSE_DOT[i]]);
const DOT_BIG = cxTable(8, (i) => [st.dotBig, PURPOSE_DOT[i]]);
const DOTS_MORE = cx(st.dotsMore);
const OUT_TITLE = cx(st.outTitle);
const HIT = cx(ln.hit);
const HIT_AWAY = cx(ln.hit, ln.away);
const TRUNK_HIT = cx(ln.trunkHit);
const TRUNK_HIT_AWAY = cx(ln.trunkHit, ln.away);
