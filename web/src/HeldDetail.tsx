// Held changes in the issue detail (#110): a user reading a long issue never has text jump under
// them. Part of the issue panel's chunk.
//
// A live refetch of the open issue (IssuePanel.tsx) is the detail's target. What in it moves
// layout is a **held change** while the user is in **intent mode** over the panel (`createIntent`,
// held.ts, with the panel's scroller as its region): new or removed comments, a body change,
// a property row that gains or loses items (Assignees, Labels, Linked PRs or Closes), and the
// relationship units (the parent link, Blocks, Relates to, Sub-issues). Everything else (the
// title, the state, counts, the role line, a comment's or a related issue's contents, a label's
// colour) shows at once, and so does the user's own comment once GitHub confirms it: it's on
// screen already, as pending. (Its timing and looks are the shift cue's, shared with the list's:
// cue.tsx.)
//
// In **reading mode** the held changes apply together, each behind its **shift cue** for 700 ms:
// a zero-height 2 px labelled line where something will open (a comment, a body block, a first
// blocker in an empty section, which keeps a zero-height spot for it) and a red outline on what
// will go; a property row or a unit that changes otherwise is outlined, on its own line only.
// Then the heights animate with `cubic-bezier(0.2, 0, 0, 1)`, 250 ms plus 1 ms per px past ~3
// lines, capped at 1.2 s, and what arrived keeps a tint that fades over 1.6 s. Intent during the
// cue cancels it, holding the changes again; an animation that has started finishes. A change that
// lands mid-cue joins it and restarts the cue; one that lands mid-animation waits for it to end.
// With reduced motion the cue is a still mark for 900 ms and the changes swap in unanimated. A
// hidden tab holds every change, so none applies unseen.
//
// Changes wholly off screen apply at once, even in intent mode, with no cue. The reading position
// is kept by anchoring: the first keyed element (`data-k`) at the viewport's top stays at the same
// offset through every change (the panel sets `overflow-anchor: none`); a visible change pushes
// what's below it down, until the user scrolls or acts: then their scroll stands, and the
// animation runs on. Body blocks are keyed by position, units by name and comments by id.
//
// Another issue, or the thread in another order, ends whatever animates where it is: nothing of
// the old issue's changes (an animation, the anchor, a tint) carries over.
//
// Changes the user started apply at once: another issue, the thread in another order, a next
// comment page (only what lies past the loaded end), and a read marked `applyAtOnce` (the read
// that replaces what the panel opened with, and the first after Back restored the page).
import { createEffect, createMemo, createSignal, flush, onCleanup, onSettled, untrack } from "solid-js";
import { mergeRefs, readAt, stamp, type Comment, type IssueDetail } from "./api";
import { createCueTimer, createHidden, EASE, TINT_MS, type BodyMarks, type Span } from "./cue";
import { createIntent } from "./held";
import type { Md } from "./md/ast";
import { overlay, type ShownComment, type ShownDetail } from "./overlay";

/** A change up to about three lines tall (`THREE_LINES` px) opens or closes in this time. */
const BASE_MS = 250;
const THREE_LINES = 60;
/** The longest a change takes to open or close: past ~3 lines each px adds 1 ms, up to this. */
const MAX_MS = 1200;

/** A property row or a relationship section that is held, marked and animated on its own. */
export type Unit = "parent" | "assignees" | "labels" | "linked" | "blocks" | "relates" | "subs";

/** A unit's cue: an outline on what changes or goes, or a labelled line in its empty spot. */
export type UnitCue = "change" | "leave" | { line: string };


/** A body change: blocks `at` to `at + drop` of `from` go, and `add` blocks of `to` open there. */
type BodyChange = { at: number; drop: number; add: number; from: Md; to: Md };

/** The held changes between what the screen shows and the latest read. */
type Plan = {
  units: readonly Unit[];
  /** Units that will be empty: their cue is red. */
  emptied: ReadonlySet<Unit>;
  /** What each unit's line says, if its cue is a line. */
  labels: ReadonlyMap<Unit, string>;
  /** Comments that arrive, and comments that go, by id. */
  arriving: ReadonlySet<number>;
  leaving: ReadonlySet<number>;
  /** Where comments will open: before the comment with this id, or at the thread's end, and what the line says. */
  lines: ReadonlyMap<number | "end", string>;
  body?: BodyChange;
};

type Cue = {
  units: ReadonlyMap<Unit, UnitCue>;
  lines: ReadonlyMap<number | "end", string>;
  leaving: ReadonlySet<number>;
  body?: BodyMarks;
};

type Tint = { comments: ReadonlySet<number>; units: ReadonlySet<Unit>; body?: Span };

/** Reads to apply at once, as a change the user started (`applyAtOnce`). */
const atOnce = new WeakSet<IssueDetail>();

/** `read` applies at once when it becomes the detail's target: the user started it. */
export function applyAtOnce(read: IssueDetail): IssueDetail {
  atOnce.add(read);
  return read;
}

/** An end of a relationship, by place: a pending one may have no id yet. */
const end = (r: { owner: string; repo: string; number: number }) => `${r.owner}/${r.repo}#${r.number}`;
const ends = (xs: readonly { owner: string; repo: string; number: number }[]) => xs.map(end);

const sorted = (xs: readonly string[]) => [...xs].sort().join(" ");

/** A unit: what decides whether it moves layout, when it's empty, its line's label, and how it's held. */
type UnitDef = {
  /** Equal on both sides: the unit takes the same lines. */
  key: (v: ShownDetail) => string;
  /** Empty, it takes no room: a first item opens from its spot, and emptying it is a red cue. */
  empty?: (v: ShownDetail) => boolean;
  /** What its line says when something opens in its empty spot. */
  line: (v: ShownDetail) => string;
  /** Puts `base`'s value of it into `out`, the copy that shows while it's held. */
  hold: (out: IssueDetail, base: IssueDetail) => void;
};

/**
 * The units. A related issue is a line of its own, so a relationship section changes with who is
 * in it (Blocks and Relates to show their ends sorted, so only membership counts; Sub-issues in
 * GitHub's order, so order counts too). Labels and assignees wrap in their row: which ones there
 * are counts, while a label's colour or description changes in place.
 */
const UNITS: Record<Unit, UnitDef> = {
  parent: {
    key: (v) => (v.relationships.parent ? end(v.relationships.parent) : ""),
    empty: (v) => v.relationships.parent === null,
    line: () => "parent set",
    hold: (out, base) => (out.relationships.parent = base.relationships.parent),
  },
  assignees: {
    key: (v) => sorted(v.assignees.map((u) => u.login)),
    line: () => "assigned",
    hold: (out, base) => (out.assignees = base.assignees),
  },
  labels: {
    key: (v) => sorted(v.labels.map((l) => l.name)),
    line: () => "label added",
    hold: (out, base) => (out.labels = base.labels),
  },
  linked: {
    key: (v) => ends(v.pr ? v.closes : v.linked_prs).join(" "),
    line: (v) => (v.pr ? "issue linked" : "PR linked"),
    hold: (out, base) => Object.assign(out, { linked_prs: base.linked_prs, closes: base.closes }),
  },
  blocks: {
    key: (v) => `${sorted(ends(v.relationships.blocked_by))}|${sorted(ends(v.relationships.blocking))}`,
    empty: (v) => v.relationships.blocked_by.length === 0 && v.relationships.blocking.length === 0,
    line: (v) => (v.relationships.blocked_by.length > 0 ? "blocker added" : "blocked issue added"),
    hold: (out, base) => Object.assign(out.relationships, { blocked_by: base.relationships.blocked_by, blocking: base.relationships.blocking }),
  },
  relates: {
    key: (v) => sorted(ends(v.relationships.relates_to)),
    empty: (v) => v.relationships.relates_to.length === 0,
    line: () => "link added",
    hold: (out, base) => (out.relationships.relates_to = base.relationships.relates_to),
  },
  subs: {
    key: (v) => ends(v.relationships.sub_issues).join(" "),
    line: () => "sub-issue added",
    hold: (out, base) => (out.relationships.sub_issues = base.relationships.sub_issues),
  },
};

/** `d` as the screen shows it: with the tab's pending writes over it. */
const viewOf = (d: IssueDetail): ShownDetail => overlay()?.detailWithWrites(d, readAt(d)) ?? d;

/** A comment's key: its GitHub id, for one of the tab's own as soon as GitHub has confirmed it. */
const keyOf = (c: ShownComment) => ("of" in c && c.of !== undefined ? c.of : c.id);

/** Whether a comment lies past where `d`'s loaded thread ends: a next page brings it, not a change. */
function pastEnd(d: IssueDetail): (c: Comment) => boolean {
  const next = d.comments.next;
  if (next === null) return () => false;
  const [at, id] = next.split(".").map(Number) as [number, number];
  const after = (c: Comment) => c.created_at - at || c.id - id;
  return d.comment_order === "newest" ? (c) => after(c) < 0 : (c) => after(c) > 0;
}

/** The blocks that changed between two bodies: what's the same at their start and end stays. */
function bodyChange(from: Md, to: Md): BodyChange | undefined {
  const a = from.map((b) => JSON.stringify(b));
  const b = to.map((x) => JSON.stringify(x));
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  let tail = 0;
  while (tail < a.length - at && tail < b.length - at && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const drop = a.length - at - tail;
  const add = b.length - at - tail;
  return drop === 0 && add === 0 ? undefined : { at, drop, add, from, to };
}

/** The held changes from `base` (on screen, nothing held) to `target`, or undefined for none. */
function planOf(base: IssueDetail, target: IssueDetail): Plan | undefined {
  const bv = viewOf(base);
  const tv = viewOf(target);
  const units = (Object.keys(UNITS) as Unit[]).filter((u) => UNITS[u].key(bv) !== UNITS[u].key(tv));
  const emptied = new Set(units.filter((u) => UNITS[u].empty?.(tv)));
  const labels = new Map(units.map((u) => [u, UNITS[u].line(tv)]));
  // The comments the screen has, by key: the tab's own confirmed one is there as pending.
  const had = new Set(bv.comments.comments.map(keyOf));
  const has = new Set(tv.comments.comments.map(keyOf));
  const paged = pastEnd(base);
  const arriving = new Set(target.comments.comments.filter((c) => !had.has(c.id) && !paged(c)).map((c) => c.id));
  const leaving = new Set(base.comments.comments.filter((c) => !has.has(c.id)).map((c) => c.id));
  const lines = new Map<number | "end", string>();
  let group: Comment[] = [];
  const close = (before: number | "end") => {
    if (group.length > 0) lines.set(before, group.length === 1 ? `${group[0]!.author?.login ?? "ghost"} commented` : `${group.length} new comments`);
    group = [];
  };
  for (const c of target.comments.comments) {
    if (arriving.has(c.id)) group.push(c);
    else close(c.id);
  }
  close("end");
  // A body edit of the tab's own shows as typed until GitHub renders it: not a held change.
  const body = bv.typedBody === undefined && tv.typedBody === undefined ? bodyChange(bv.body, tv.body) : undefined;
  if (units.length === 0 && arriving.size === 0 && leaving.size === 0 && !body) return undefined;
  return { units, emptied, labels, arriving, leaving, lines, body };
}

/**
 * The thread with `target`'s comments, those `keep` turns down left out, and `base`'s that
 * `target` no longer has where they were: each before the next comment that stays.
 */
function union(base: readonly Comment[], target: readonly Comment[], keep: (c: Comment) => boolean): Comment[] {
  const inTarget = new Set(target.map((c) => c.id));
  const inBase = new Set(base.map((c) => c.id));
  const before = new Map<number | "end", Comment[]>();
  let group: Comment[] = [];
  for (const c of base) {
    if (!inTarget.has(c.id)) group.push(c);
    else if (group.length > 0) {
      before.set(c.id, group);
      group = [];
    }
  }
  if (group.length > 0) before.set("end", group);
  const out: Comment[] = [];
  for (const c of target) {
    out.push(...(before.get(c.id) ?? []));
    if (inBase.has(c.id) || keep(c)) out.push(c);
  }
  out.push(...(before.get("end") ?? []));
  return out;
}

/** `target` with its held parts as `base` has them: what shows while the changes are held. */
function heldCopy(base: IssueDetail, target: IssueDetail, p: Plan): IssueDetail {
  const out: IssueDetail = { ...target, relationships: { ...target.relationships } };
  for (const u of p.units) UNITS[u].hold(out, base);
  // The body's digest stays the latest: an open body editor says at once that it changed.
  if (p.body) Object.assign(out, { body: base.body, refs: mergeRefs(base.refs, target.refs), media: { ...base.media, ...target.media } });
  if (p.arriving.size > 0 || p.leaving.size > 0) {
    out.comments = {
      ...target.comments,
      comments: union(base.comments.comments, target.comments.comments, (c) => !p.arriving.has(c.id)),
      refs: mergeRefs(base.comments.refs, target.comments.refs),
      media: { ...base.comments.media, ...target.comments.media },
    };
  }
  // Read when `base` was: the tab's writes it doesn't show yet keep showing over it.
  return stamp(out, readAt(base));
}

/** `target` with what goes still in it, where it was: what shows while the changes animate. */
function animCopy(base: IssueDetail, target: IssueDetail, p: Plan): IssueDetail {
  const out: IssueDetail = { ...target };
  const b = p.body;
  if (b) {
    out.body = [...b.to.slice(0, b.at), ...b.from.slice(b.at, b.at + b.drop), ...b.to.slice(b.at)];
    out.refs = mergeRefs(base.refs, target.refs);
    out.media = { ...base.media, ...target.media };
  }
  if (p.leaving.size > 0) {
    out.comments = {
      ...target.comments,
      comments: union(base.comments.comments, target.comments.comments, () => true),
      refs: mergeRefs(base.comments.refs, target.comments.refs),
      media: { ...base.comments.media, ...target.comments.media },
    };
  }
  return stamp(out, readAt(target));
}

/** How long a change `px` tall takes to open or close. */
const durationFor = (px: number) => Math.round(Math.min(MAX_MS, BASE_MS + Math.max(0, px - THREE_LINES)));

/** Where the viewport's top is, as the first keyed element there and its offset from the top. */
type Anchor = { k: string; y: number };

function anchorOf(sc: HTMLElement): Anchor | undefined {
  const top = sc.getBoundingClientRect().top;
  for (const el of sc.querySelectorAll<HTMLElement>("[data-k]")) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && r.bottom > top) return { k: el.dataset.k!, y: r.top - top };
  }
  return undefined;
}

/**
 * The same anchor once body blocks have shifted: into the animated copy (`anim`, what goes still
 * there), or from it to the latest read (`final`).
 */
function shifted(a: Anchor | undefined, b: BodyChange | undefined, stage: "anim" | "final"): Anchor | undefined {
  if (!a || !b || !a.k.startsWith("b:")) return a;
  const i = Number(a.k.slice(2));
  if (i < b.at) return a;
  if (stage === "anim") return i >= b.at + b.drop ? { ...a, k: `b:${i + b.add}` } : a;
  // A block that went sat where the first block in its place now starts.
  return { ...a, k: `b:${i < b.at + b.drop ? b.at : i - b.drop}` };
}

/**
 * Whether every part of `p` sits wholly above or below the scroller's window: a unit, a comment
 * or a block that goes by its whole box, and a line where something will open by its point.
 */
function offscreen(sc: HTMLElement, p: Plan): boolean {
  const top = sc.getBoundingClientRect().top;
  const bottom = top + sc.clientHeight;
  const spots: { top: number; bottom: number }[] = [];
  let unknown = false;
  const box = (sel: string) => {
    const el = sc.querySelector(sel);
    if (el) spots.push(el.getBoundingClientRect());
    else unknown = true;
  };
  const point = (sel: string, at: "top" | "bottom") => {
    const el = sc.querySelector(sel);
    if (!el) return void (unknown = true);
    const y = el.getBoundingClientRect()[at];
    spots.push({ top: y, bottom: y });
  };
  for (const u of p.units) box(`[data-unit="${u}"]`);
  for (const id of p.leaving) box(`[data-k="c:${id}"]`);
  for (const k of p.lines.keys()) point(k === "end" ? '[data-perf="comments"]' : `[data-k="c:${k}"]`, k === "end" ? "bottom" : "top");
  const b = p.body;
  if (b) {
    for (let i = b.at; i < b.at + b.drop; i++) box(`[data-k="b:${i}"]`);
    if (b.add > 0) {
      const next = `[data-k="b:${b.at + b.drop}"]`;
      if (sc.querySelector(next)) point(next, "top");
      else point('[data-perf="body"]', "bottom");
    }
  }
  if (unknown || spots.length === 0) return false;
  return spots.every((r) => (r.bottom <= top && r.top < top) || r.top >= bottom);
}

const heightOf = (el: Element | null) => (el ? el.getBoundingClientRect().height : 0);

/**
 * The detail as the screen shows it, with its layout changes held as described above: `target` is
 * the latest read, `scroller` the panel's scroller (every part it keeps in place marked `data-k`,
 * each unit `data-unit`), and `region` adds what else counts as the panel for the pointer (its
 * composer). Besides the detail to show: each part's cue and tint.
 */
export function createDetailHeld(opts: { target: () => IssueDetail; scroller: () => HTMLElement; region: (t: Element) => boolean }) {
  const intent = createIntent(opts.scroller, opts.region);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  /** The read the screen shows with nothing held: the last one applied. */
  let committed = untrack(opts.target);
  const [held, setHeld] = createSignal<IssueDetail>(committed);
  // Another issue, or its thread in another order: the read shows as it is, at once.
  const same = (a: IssueDetail, b: IssueDetail) => a.id === b.id && a.comment_order === b.comment_order;
  const shown = createMemo(() => {
    const t = opts.target();
    const h = held();
    return same(h, t) ? h : t;
  });
  const [cue, setCue] = createSignal<Cue>();
  const [tint, setTint] = createSignal<Tint>();
  const hidden = createHidden();
  const timer = createCueTimer(reduced);
  /** The held changes, and what tells them apart from another plan's. */
  let plan: Plan | undefined;
  let planned = "";
  /**
   * The changes animating: their animations, the read they bring, the anchor kept in place, and
   * whether it still is (`follow`: not once the user scrolls or acts), with the scroll it last set.
   */
  type Running = { runs: Animation[]; anchor: Anchor | undefined; follow: boolean; wrote: number };
  let running: Running | undefined;
  let tintTimer: ReturnType<typeof setTimeout> | undefined;
  const latest = () => untrack(opts.target);

  /** Ends the changes animating where they are: another issue, or another order, took the detail. */
  const abandon = () => {
    const r = running;
    if (!r) return;
    running = undefined;
    for (const a of r.runs) a.cancel();
  };
  const clearTint = () => {
    clearTimeout(tintTimer);
    setTint(undefined);
  };
  onCleanup(() => {
    abandon();
    clearTimeout(tintTimer);
  });

  /** Puts the anchor back where it was: the app's own scroll, not the user's. */
  const restore = (sc: HTMLElement, a: Anchor | undefined) => {
    if (!a) return;
    const el = sc.querySelector(`[data-k="${CSS.escape(a.k)}"]`);
    if (!el) return;
    const dy = el.getBoundingClientRect().top - sc.getBoundingClientRect().top - a.y;
    if (dy !== 0) intent.scrollTo(sc.scrollTop + dy);
  };
  /** Shows `d`, keeping the reading position. */
  const put = (d: IssueDetail) => {
    const sc = opts.scroller();
    const a = anchorOf(sc);
    setHeld(d);
    flush();
    restore(sc, a);
  };

  const stopCue = () => {
    timer.stop();
    setCue(undefined);
  };

  /** The latest read: shown at once, or with its layout changes held. */
  const offer = () => {
    const t = latest();
    if (!same(committed, t)) {
      abandon();
      clearTint();
      stopCue();
      plan = undefined;
      planned = "";
      committed = t;
      setHeld(t);
      return;
    }
    if (running) return;
    const p = atOnce.has(t) ? undefined : planOf(committed, t);
    if (!p) {
      stopCue();
      plan = undefined;
      planned = "";
      committed = t;
      put(t);
      return;
    }
    // The same changes again (a read that brings nothing new, the tab's own writes moving on):
    // a cue showing for them goes on.
    const sig = signature(p);
    const changed = sig !== planned;
    plan = p;
    planned = sig;
    put(heldCopy(committed, t, p));
    consider(changed);
  };

  /** Decides what the held changes do now: wait, apply at once, or show their cue (afresh if `changed`). */
  const consider = (changed = false) => {
    if (!plan || running) return;
    if (untrack(hidden)) return stopCue();
    if (offscreen(opts.scroller(), plan)) return commit(false);
    if (!untrack(intent.reading)) return stopCue();
    if (timer.running() && !changed) return;
    startCue(plan);
  };

  const startCue = (p: Plan) => {
    const sc = opts.scroller();
    const units = new Map<Unit, UnitCue>();
    for (const u of p.units) {
      const empty = heightOf(sc.querySelector(`[data-unit="${u}"]`)) < 1;
      units.set(u, empty ? { line: p.labels.get(u)! } : p.emptied.has(u) ? "leave" : "change");
    }
    const b = p.body;
    const body: BodyMarks | undefined = b && {
      leaving: b.drop > 0 ? { from: b.at, to: b.at + b.drop } : undefined,
      line: b.add > 0 ? { at: b.at + b.drop, label: b.drop > 0 ? "edited" : "added" } : undefined,
    };
    setCue({ units, lines: p.lines, leaving: p.leaving, body });
    timer.start(() => {
      if (untrack(intent.reading) && !untrack(hidden)) commit(true);
      else stopCue();
    });
  };

  /** Applies the held changes: animated after their cue, or at once (off screen, reduced motion). */
  const commit = (animate: boolean) => {
    const p = plan;
    stopCue();
    if (!p) return;
    plan = undefined;
    planned = "";
    const t = latest();
    const sc = opts.scroller();
    const a = anchorOf(sc);
    if (!animate || reduced.matches) {
      committed = t;
      setHeld(t);
      flush();
      restore(sc, a);
      return;
    }
    const before = new Map(p.units.map((u) => [u, heightOf(sc.querySelector(`[data-unit="${u}"]`))]));
    setHeld(animCopy(committed, t, p));
    // What goes stays marked while it closes.
    setCue({
      units: new Map(p.units.filter((u) => p.emptied.has(u)).map((u) => [u, "leave" as const])),
      lines: new Map(),
      leaving: p.leaving,
      body: p.body && p.body.drop > 0 ? { leaving: { from: p.body.at, to: p.body.at + p.body.drop } } : undefined,
    });
    flush();
    // Every height first, then every animation: what opens from nothing or closes to nothing
    // (its padding, which holds its gap, too), and each unit from its old height to its new.
    const moves: { el: HTMLElement; from: number | undefined; to: number | undefined; h: number; pad: Keyframe }[] = [];
    const add = (sel: string, from: number | undefined, to: number | undefined) => {
      const el = sc.querySelector<HTMLElement>(sel);
      if (!el) return;
      const cs = getComputedStyle(el);
      moves.push({ el, from, to, h: heightOf(el), pad: { paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom } });
    };
    for (const id of p.arriving) add(`[data-k="c:${id}"]`, 0, undefined);
    for (const id of p.leaving) add(`[data-k="c:${id}"]`, undefined, 0);
    const b = p.body;
    if (b) {
      for (let i = b.at; i < b.at + b.drop; i++) add(`[data-k="b:${i}"]`, undefined, 0);
      for (let i = b.at + b.drop; i < b.at + b.drop + b.add; i++) add(`[data-k="b:${i}"]`, 0, undefined);
    }
    for (const u of p.units) add(`[data-unit="${u}"]`, before.get(u), undefined);
    const nothing: Keyframe = { paddingTop: "0px", paddingBottom: "0px" };
    const frame = (h: number, pad: Keyframe): Keyframe => ({ boxSizing: "border-box", overflow: "hidden", height: `${h}px`, ...(h === 0 ? nothing : pad) });
    const runs = moves.flatMap(({ el, from, to, h, pad }) => {
      const start = from ?? h;
      const end = to ?? h;
      if (Math.abs(end - start) < 1) return [];
      return [el.animate([frame(start, pad), frame(end, pad)], { duration: durationFor(Math.abs(end - start)), easing: EASE, fill: end === 0 ? "forwards" : "none" })];
    });
    const r: Running = { runs, anchor: shifted(a, b, "anim"), follow: true, wrote: sc.scrollTop };
    running = r;
    // Whatever was at the viewport's top stays put while they run: changes above it are made up
    // for by the scroll, and a visible one pushes what's below it. Until the user scrolls, or
    // acts: then their scroll stands, and the animations run on.
    const keep = () => {
      restore(sc, r.anchor);
      r.wrote = sc.scrollTop;
    };
    keep();
    const follow = () => {
      if (running !== r || !r.follow) return;
      // A scroll that isn't the app's own; one the scroller's end clamped is.
      const clamped = sc.scrollTop < r.wrote && sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 1;
      if ((Math.abs(sc.scrollTop - r.wrote) > 1 && !clamped) || !untrack(intent.reading)) {
        r.follow = false;
        return;
      }
      keep();
      requestAnimationFrame(follow);
    };
    requestAnimationFrame(follow);
    void Promise.all(runs.map((x) => x.finished.catch(() => {}))).then(() => {
      // Another issue or order took the detail meanwhile: nothing of these changes is its.
      if (running !== r) return;
      running = undefined;
      committed = t;
      setCue(undefined);
      setHeld(t);
      flush();
      // What closed holds its end state until now: it's gone from the page with this.
      for (const x of runs) if (x.effect?.getTiming().fill === "forwards") x.cancel();
      if (r.follow) restore(sc, shifted(r.anchor, b, "final"));
      // The tint on what arrived, from its start even if an earlier one still fades.
      clearTint();
      flush();
      setTint({
        comments: p.arriving,
        units: new Set(p.units.filter((u) => !p.emptied.has(u))),
        body: b && b.add > 0 ? { from: b.at, to: b.at + b.add } : undefined,
      });
      tintTimer = setTimeout(() => setTint(undefined), TINT_MS);
      // A read that landed meanwhile is held now, and cued if the user is still reading.
      offer();
    });
  };

  // Effects only schedule: what they decide flushes and measures the DOM.
  createEffect(opts.target, () => queueMicrotask(offer));
  // The tab's own writes move on (a comment GitHub confirms, a pick that fails): what's held is
  // weighed again, so a confirmed comment of its own never waits.
  createEffect(
    () => (overlay() ? viewOf(opts.target()).comments.comments.map(keyOf).join() : ""),
    () => queueMicrotask(offer),
  );
  createEffect(intent.reading, (r) =>
    queueMicrotask(() => {
      if (r) consider();
      else if (!running) stopCue();
    }),
  );
  createEffect(hidden, (h) =>
    queueMicrotask(() => {
      if (!h) consider();
      else if (!running) stopCue();
    }),
  );
  onSettled(() => {
    const sc = opts.scroller();
    // Held changes the scroll takes off screen apply at once; ones it brings on screen wait.
    const scrolled = () => {
      if (plan && !running && !timer.running()) consider();
    };
    sc.addEventListener("scroll", scrolled, { passive: true });
    return () => sc.removeEventListener("scroll", scrolled);
  });

  return {
    /** The read to show, its held parts as they were. */
    shown,
    /** Unit `u`'s cue, while it shows. */
    unitCue: (u: Unit) => cue()?.units.get(u),
    /** Whether unit `u` just changed, and keeps its tint. */
    unitTint: (u: Unit) => tint()?.units.has(u) ?? false,
    /** The line where comments will open before comment `id` (or at the end), and what it says. */
    lineBefore: (id: number | "end") => cue()?.lines.get(id),
    /** Whether comment `id` is about to go. */
    leaving: (id: number) => cue()?.leaving.has(id) ?? false,
    /** Whether comment `id` just arrived, and keeps its tint. */
    arrived: (id: number) => tint()?.comments.has(id) ?? false,
    /** The body's marks. */
    body: (): BodyMarks | undefined => {
      const c = cue()?.body;
      const g = tint()?.body;
      return c || g ? { ...c, tint: g } : undefined;
    },
  };
}

/** What tells one plan's changes from another's. */
function signature(p: Plan): string {
  const b = p.body;
  return JSON.stringify([p.units, [...p.arriving], [...p.leaving], [...p.lines], b && [b.at, b.drop, b.add]]);
}
