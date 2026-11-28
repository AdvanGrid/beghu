// The canvas's state, owned by the view's body so the panel reads the same drawing (the Group
// panel's groups, what a hover on the panel lights): the settings from the URL, the canvas's own
// opens and folds with their ← Back steps, the no-lines grid's toggle, and the scene laid out from
// them. Opens and folds are the canvas's (never in the URL, slice 7): each is one Back step that
// says what it undoes; Start over returns to the starting state (layout A, columns open, parts
// folded); a selection's change opens down to it when it's inside a folded block (one Back step).
//
// The fold (#183): while the panel stands on the whole PR, a purpose or the unclaimed parts, the
// canvas draws that place's fold plan (fold.ts), made once per place and lens; its opens and
// folds lay over the plan, Start over returns to it, and standing on another place starts afresh
// (a fresh Back history), as does another lens. Picking a part, a line or anything else keeps the
// canvas as it is when the fold draws it. A pick of a part the fold draws only inside a rest
// block, a folded group or a closed block (from the panel, a conflict, the next level, a cold
// `?sel=part:…`) opens the fold down to it, one Back step: the blocks it sits in open, a group
// holding one of them unfolds, and a part in a rest block is pulled out of it, a block of its own
// in that frame. A pick of a line the fold doesn't draw does the same for its two ends. A part the
// fold can't draw at all (one the lens leaves out, or inside a part outside the diff) is shown in
// the code view instead, as "Code view at" does. "Code view at ‹part›" (or a double-click on a
// part with nothing inside) leaves the fold for layout A opened down to that part; "← Back to
// ‹place›" returns to the fold as it was, as does picking that place in the panel (another place
// starts afresh). It starts on the PR's fold when the analysis has purposes, else in layout A
// (the fallback, `unbacked`); the order lens (slice 11) keeps its own drawing.
//
// Show it (a newer analysis) rebases the canvas onto it, with a fresh Back history: under the
// fold, the new analysis's plan for the place (the PR's if the place went), with the reader's own
// opens and closes of the old plan that still name a part kept; in layout A, the opens that still
// name a part. If the new analysis can't fold (`unbacked`), the canvas goes to layout A. Only the
// shown analysis's plans are kept. What the panel lights goes with every change of the selection.
import { createContext, createEffect, createMemo, createSignal, onCleanup, untrack, useContext, type Accessor } from "solid-js";
import type { Node } from "../../bindings/analysis";
import { columnGroup } from "../layout/graph";
import type { Layout } from "../layout/types";
import type { Model } from "../model";
import { part, type Nav } from "../nav";
import { drawnFolders } from "../Panel";
import type { Sel } from "../state";
import { placeOf, purposesOf, samePlace, selOfPlace, type Place } from "../purposes";
import { FOLD_BUDGET, isFoldOut, planOf, planState, type FoldInput, type FoldPlan } from "./fold";
import { keyRows, type KeyRow } from "./key";
import { COLUMNS, sceneOf, topParts, type CanvasState, type FoldArgs, type Scene } from "./scene";
import { sameSettings, settingsOf, shownEdges, type Settings } from "./settings";

export const START: CanvasState = { open: new Set(), folded: new Set() };

/** One step ← Back undoes: the state before it, what it did, and the block it was about (it stays still going back). */
export interface Step {
  state: CanvasState;
  what: string;
  at?: string;
}

/** A glide under way: the drawing it leaves, the block that stays still, and its number. */
export interface Glide {
  from: Scene;
  at?: string;
  n: number;
}

/** What the canvas draws: a place's fold, or layout A (`from`: the fold it left by "Code view at", if it did). */
export type Mode = { kind: "fold"; place: Place } | { kind: "code"; from?: Place };

export interface CanvasStore {
  settings: Accessor<Settings>;
  mode: Accessor<Mode>;
  /** Leaves the fold for layout A, opened down to `part` and with it selected (unless it is already: `select` false). */
  codeView: (part: string, select?: boolean) => void;
  /** Back from the code view to the fold it left, as it was. */
  backToFold: () => void;
  state: Accessor<CanvasState>;
  scene: Accessor<Scene>;
  history: Accessor<Step[]>;
  glide: Accessor<Glide | undefined>;
  endGlide: () => void;
  showLonely: Accessor<boolean>;
  setShowLonely: (on: boolean) => void;
  /** Opens a part or unfolds a group, as a Back step. */
  open: (id: string, at?: string) => void;
  /** Folds a frame, a box or a column, and whatever is open inside it, as a Back step. */
  fold: (id: string) => void;
  foldToGroups: () => void;
  back: () => void;
  startOver: () => void;
  /** Whether Start over has nothing to do: the state is the start (the plan, under the fold) and there's no Back step. */
  atStart: Accessor<boolean>;
  /** Opens down to what `sel` names, if it's inside a folded block (under the fold, a rest block too): one Back step. Whether it did. */
  openTo: (sel: Sel | undefined) => boolean;
  /** The legend's rows for the drawing on screen. */
  rows: Accessor<KeyRow[]>;
  /** What the panel lights on the canvas (a responsibility's users, a row, a conflict), or nothing. */
  lit: Accessor<Lit | undefined>;
  light: (what: readonly string[] | Lit | undefined) => void;
  model: Accessor<Model>;
}

/** Parts and lines the panel lights. */
export interface Lit {
  nodes: readonly string[];
  edges: readonly string[];
}

/** The canvas's budget of blocks under the fold: the desktop's (the phone's is slice 12's). */
export const budget = () => FOLD_BUDGET;

export const CanvasContext = createContext<CanvasStore>();

export function useCanvas(): CanvasStore {
  const c = useContext(CanvasContext);
  if (!c) throw new Error("used outside the PR view's canvas");
  return c;
}

/** What one of the panel's rows or cards lights on the canvas while hovered or focused: it goes when the row is left, or goes away. */
export function useLight(): { on: (what: readonly string[] | Lit) => void; off: () => void } {
  const c = useCanvas();
  let lit = false;
  onCleanup(() => {
    if (lit) c.light(undefined);
  });
  return {
    on: (what) => {
      lit = true;
      c.light(what);
    },
    off: () => {
      lit = false;
      c.light(undefined);
    },
  };
}

export function createCanvasStore(nav: Nav): CanvasStore {
  const model = () => nav.model();
  // Equal settings are the same: a selection's change of the URL keeps the drawing as it is.
  const settings = createMemo(() => settingsOf(nav.state(), nav.model()), { equals: sameSettings });
  const purposes = createMemo(() => purposesOf(nav.model()));
  /** Whether the analysis can fold at `pl`: it has purposes (unclaimed parts, for that place), and the lens isn't the order of actions. */
  const folds = (pl: Place) => nav.state().lens !== "order" && (pl.kind === "unclaimed" ? model().a.unclaimed.length > 0 : purposes().tops.length > 0);
  /** The mode the view starts in: the fold of the place the selection names, else the PR's, else layout A. */
  const startMode = (): Mode => {
    const pl = placeOf(nav.sel(), purposes()) ?? { kind: "pr" as const };
    return folds(pl) ? { kind: "fold", place: pl } : folds({ kind: "pr" }) ? { kind: "fold", place: { kind: "pr" } } : { kind: "code" };
  };
  // The mode and the state are derived from the graph (which may still be on its way) until the
  // first change sets them.
  const [modeSet, setMode] = createSignal<Mode>();
  const mode = createMemo(() => modeSet() ?? startMode());
  // Each place's plan, made once per analysis, place and lens: only the shown analysis's are kept.
  const plans = new Map<string, { input: FoldInput; plan: FoldPlan }>();
  const planKey = (graph: string, lens: string, pl: Place) => `${graph}\u0000${lens}\u0000${pl.kind === "purpose" ? pl.id : pl.kind}`;
  const planFor = (pl: Place): { input: FoldInput; plan: FoldPlan } => {
    const m = model(), st = settings();
    const key = planKey(m.g.id, st.lens, pl);
    let x = plans.get(key);
    if (!x) {
      const p = purposes();
      const input: FoldInput = {
        m,
        members: p.members(pl),
        tops: topParts(m, { ...st, show: "all" }, shownEdges(m, st)),
        outside: p.outside(pl).map((o) => ({ node: o.node, question: o.conflict.question })),
        budget: budget(),
      };
      plans.set(key, (x = { input, plan: planOf(input) }));
    }
    return x;
  };
  const startState = (md: Mode): CanvasState => (md.kind === "fold" ? planState(untrack(() => planFor(md.place)).plan) : START);
  const [stateSet, setState] = createSignal<CanvasState>();
  const state = createMemo(() => stateSet() ?? startState(mode()));
  const [history, setHistory] = createSignal<Step[]>([]);
  /** The fold the code view left, kept as it was for ← Back to it. */
  let left: { place: Place; state: CanvasState; history: Step[] } | undefined;
  const [showLonely, setShowLonely] = createSignal(false);
  const [glide, setGlide] = createSignal<Glide>();
  const [lit, setLit] = createSignal<Lit | undefined>(undefined);
  const light = (what: readonly string[] | Lit | undefined) => setLit(what === undefined ? undefined : Array.isArray(what) ? { nodes: what, edges: [] } : (what as Lit));
  // A light never outlives the selection it was set under (a row clicked, a card gone).
  createEffect(nav.sel, () => setLit(undefined));
  let glides = 0;
  let last: Layout | undefined;
  const folders = (n: Node) => drawnFolders(nav.model(), n).length;
  const scene = createMemo(() => {
    const md = mode();
    const fold: FoldArgs | undefined = md.kind === "fold" ? { place: md.place, purposes: purposes(), ...planFor(md.place) } : undefined;
    const sc = sceneOf(nav.model(), settings(), state(), showLonely(), last, folders, fold);
    last = sc.layout;
    return sc;
  });
  /** The state Start over returns to: the fold's plan, or layout A's start. */
  const start = () => startState(untrack(mode));
  /** Changes what the canvas draws, gliding from the drawing on screen. */
  const switchTo = (md: Mode, st: CanvasState, h: Step[], at?: string) => {
    setGlide({ from: untrack(scene), at, n: ++glides });
    setMode(md);
    setState(st);
    setHistory(h);
  };
  // Standing on a place: its fold (afresh, or as the code view left it); anything else keeps the canvas.
  createEffect(
    () => [placeOf(nav.sel(), purposes()), nav.state().lens === "order"] as const,
    ([pl, order]) => {
      untrack(() => {
        const md = mode();
        // Pinned from here on: the start's mode and state no longer follow the selection.
        if (modeSet() === undefined) {
          setMode(md);
          setState(state());
        }
        if (order) {
          if (md.kind === "fold") switchTo({ kind: "code" }, START, []);
          return;
        }
        if (!pl || !folds(pl)) return;
        if (md.kind === "fold" && samePlace(md.place, pl)) return;
        if (md.kind === "code" && left && samePlace(left.place, pl)) {
          const back = left;
          left = undefined;
          switchTo({ kind: "fold", place: back.place }, back.state, back.history);
          return;
        }
        left = undefined;
        switchTo({ kind: "fold", place: pl }, planState(planFor(pl).plan), []);
      });
    },
  );

  // Another lens under the fold: that lens's plan for the place, afresh (plans are per lens).
  createEffect(
    () => settings().lens,
    (lens, was) => {
      if (was === undefined || lens === was) return;
      untrack(() => {
        const md = mode();
        if (md.kind === "fold") switchTo(md, planState(planFor(md.place).plan), []);
      });
    },
  );

  // Show it: the canvas rebased onto the newer analysis, with a fresh Back history.
  createEffect(
    () => model().g.id,
    (id, was) => {
      if (was === undefined || id === was) return;
      untrack(() => {
        const m = model(), lens = settings().lens;
        const md = mode();
        // The plans the old analysis made, before they're let go.
        const previous = new Map([...plans].filter(([k]) => k.startsWith(`${was}\u0000${lens}\u0000`)).map(([k, v]) => [k, v.plan]));
        const old = (pl: Place) => previous.get(planKey(was, lens, pl));
        for (const k of [...plans.keys()]) if (!k.startsWith(`${id}\u0000`)) plans.delete(k);
        if (modeSet() === undefined) return; // still the start's: it follows the new analysis by itself
        const exists = (pl: Place) => pl.kind !== "purpose" || purposes().byId.has(pl.id);
        /** A fold's state on the new plan for `pl`: the reader's own opens and closes of `before` over `was`'s plan kept, where they still name a part. */
        const rebase = (pl: Place, from: Place, before: CanvasState): CanvasState => {
          const plan = planFor(pl).plan;
          const prev = samePlace(pl, from) ? old(from) : undefined;
          const opened = prev ? [...before.open].filter((x) => !prev.open.has(x) && m.nodes.has(x)) : [];
          const closed = prev ? new Set([...prev.open].filter((x) => !before.open.has(x))) : new Set<string>();
          return { open: new Set([...[...plan.open].filter((x) => !closed.has(x)), ...opened]), folded: new Set(plan.fold) };
        };
        /** Where a fold of `pl` goes: the same place, the PR's if it went, or none (the new analysis can't fold). */
        const where = (pl: Place): Place | undefined => (exists(pl) && folds(pl) ? pl : folds({ kind: "pr" }) ? { kind: "pr" } : undefined);
        if (md.kind === "fold") {
          const sel = placeOf(nav.sel(), purposes());
          const to = sel && folds(sel) ? sel : where(md.place);
          left = undefined;
          if (to) switchTo({ kind: "fold", place: to }, rebase(to, md.place, state()), []);
          else switchTo({ kind: "code" }, START, []);
          return;
        }
        // Layout A: its opens that still name a part; the fold it left, rebased too.
        const s = state();
        if (left) {
          const to = where(left.place);
          left = to && { place: to, state: rebase(to, left.place, left.state), history: [] };
        }
        switchTo({ kind: "code", from: left?.place }, { open: new Set([...s.open].filter((x) => m.nodes.has(x))), folded: s.folded }, []);
      });
    },
  );

  const rows = createMemo(() => {
    const sc = scene();
    const at = sc.fold?.purpose;
    return keyRows(nav.model(), settings(), sc, at === undefined ? undefined : purposes().colour(at));
  });
  const name = (id: string) => {
    const g = untrack(scene).groups.get(id);
    return g ? g.title : model().name(id);
  };
  const step = (next: CanvasState, what: string, at?: string) => {
    const before = untrack(state);
    if (same(before, next)) return;
    setHistory((h) => [...h, { state: before, what, at }]);
    setGlide({ from: untrack(scene), at, n: ++glides });
    setState(next);
  };
  /** `s` without `id` open, nor any block inside it (in the analysis, or in the group's parts). */
  const without = (s: CanvasState, id: string): CanvasState => {
    const m = model();
    const g = untrack(scene).groups.get(id);
    const inside = (x: string) => (g ? g.members.some((top) => m.within(x, top)) : m.within(x, id));
    return { ...s, open: new Set([...s.open].filter((x) => !inside(x))) };
  };

  const atStart = createMemo(() => history().length === 0 && same(state(), untrack(() => startState(mode()))));
  const store: CanvasStore = {
    settings,
    mode,
    atStart,
    codeView(id, select = true) {
      const md = untrack(mode);
      const m = model();
      if (!m.nodes.has(id)) return;
      if (md.kind === "fold") left = { place: md.place, state: untrack(state), history: untrack(history) };
      const from = md.kind === "fold" ? md.place : md.from;
      // Layout A opened down to the part: every block it sits in.
      const sys = m.system?.id;
      const open = new Set(m.ancestors(id).filter((x) => x !== sys));
      switchTo({ kind: "code", from }, { open, folded: new Set() }, [], id);
      if (select) nav.select(part(id));
    },
    backToFold() {
      const md = untrack(mode);
      if (md.kind !== "code" || !left) return;
      const back = left;
      left = undefined;
      switchTo({ kind: "fold", place: back.place }, back.state, back.history);
      const sel = selOfPlace(back.place);
      nav.select(sel);
    },
    state,
    scene,
    rows,
    history,
    glide,
    endGlide: () => setGlide(undefined),
    showLonely,
    setShowLonely,
    model,
    lit,
    light,
    open(id, at) {
      const s = untrack(state);
      if (s.folded.has(id)) {
        const folded = new Set(s.folded);
        folded.delete(id);
        // A column opened after Fold to groups brings its boxes out folded.
        step({ ...s, folded }, `opened ${name(id)}`, at ?? id);
        return;
      }
      if ((model().children.get(id) ?? []).length === 0 || s.open.has(id)) return;
      step({ ...s, open: new Set([...s.open, id]) }, `opened ${name(id)}`, at ?? id);
    },
    fold(id) {
      const s = untrack(state);
      const g = untrack(scene).groups.get(id);
      if (g) {
        const next = without(s, id);
        step({ open: next.open, folded: new Set([...next.folded, id]) }, `folded ${g.title}`, id);
        return;
      }
      if (!s.open.has(id)) return;
      step(without(s, id), `folded ${model().name(id)}`, id);
    },
    foldToGroups() {
      const groups = untrack(scene).groups;
      // The four columns folded; their boxes come out folded when a column opens.
      const folded = new Set<string>([...COLUMNS.map(columnGroup), ...[...groups.values()].filter((g) => g.kind !== "column").map((g) => g.id)]);
      step({ open: new Set(), folded }, "folded to groups");
    },
    back() {
      const h = untrack(history);
      const last = h.at(-1);
      if (!last) return;
      setHistory(h.slice(0, -1));
      // The block the step was about stays still, and comes into view once the glide lands.
      setGlide({ from: untrack(scene), at: last.at, n: ++glides });
      setState(last.state);
    },
    startOver() {
      const h = untrack(history);
      const to = start();
      if (same(untrack(state), to) && h.length === 0) return;
      setHistory([]);
      // The first step's block stays still: the one the reader started from.
      setGlide({ from: untrack(scene), at: h[0]?.at, n: ++glides });
      setState(to);
    },
    openTo(sel) {
      if (untrack(mode).kind === "fold") {
        const need = pulls(model(), untrack(scene), sel);
        if (!need) return false;
        if ("code" in need) {
          store.codeView(need.code, false);
          return true;
        }
        const s = untrack(state);
        const next = { open: new Set([...s.open, ...need.open]), folded: new Set([...s.folded].filter((x) => !need.unfold.has(x))), pulled: new Set([...(s.pulled ?? []), ...need.pull]) };
        if (same(s, next)) return false;
        step(next, `opened down to ${need.name}`);
        return true;
      }
      const need = openings(model(), untrack(scene), sel);
      if (!need) return false;
      const s = untrack(state);
      const next = { open: new Set([...s.open, ...need.open]), folded: new Set([...s.folded].filter((x) => !need.unfold.has(x))) };
      if (same(s, next)) return false;
      step(next, `opened down to ${need.name}`);
      return true;
    },
  };
  return store;
}

function same(a: CanvasState, b: CanvasState): boolean {
  const eq = (x: ReadonlySet<string>, y: ReadonlySet<string>) => x.size === y.size && [...x].every((v) => y.has(v));
  return eq(a.open, b.open) && eq(a.folded, b.folded) && eq(a.pulled ?? NONE, b.pulled ?? NONE);
}
const NONE: ReadonlySet<string> = new Set();

/**
 * Under the fold, what a pick of `sel` needs to be drawn: the blocks to open, the groups and
 * columns to unfold, and the parts to pull out of their rest blocks; or the code view, for a part
 * the fold can't draw. Undefined if it's drawn already (or names no part).
 */
function pulls(m: Model, sc: Scene, sel: Sel | undefined): { open: Set<string>; unfold: Set<string>; pull: Set<string>; name: string } | { code: string } | undefined {
  const f = sc.fold;
  if (!sel || !f) return undefined;
  const sys = m.system?.id;
  let ids: string[] = [];
  if (sel.kind === "part") ids = sel.ids.filter((id) => m.nodes.has(id));
  else if (sel.kind === "line")
    for (const id of sel.ids) {
      const e = m.edges.get(id);
      // A line the fold draws (rolled up to its blocks) is drawn: only one it drops opens down to its ends.
      if (e && !(sc.drawnAs.get(id) ?? []).some((l) => sc.lines.has(l))) ids.push(e.from, e.to);
    }
  const open = new Set<string>(), unfold = new Set<string>(), pull = new Set<string>();
  let name = "";
  for (const id of new Set(ids)) {
    if (id === sys || sc.holder(id) === id) continue;
    const r = f.rep(id);
    // Not drawn by the fold at all, or only as the part outside the diff it's inside: the code view.
    if (r === undefined || (isFoldOut(r) && r !== `fold-out:${id}`)) {
      if (sel.kind === "part" && sel.ids.length === 1) return { code: id };
      continue;
    }
    if (isFoldOut(r)) {
      // A part outside the diff, in its folded column.
      const col = columnGroup("conflict");
      if (sc.items.get(col)?.folded) unfold.add(col);
      name ||= m.name(id);
      continue;
    }
    const chain = [...m.ancestors(id)].filter((x) => x !== sys);
    for (const x of chain) open.add(x);
    if (r !== id) pull.add(id);
    for (const g of sc.groups.values()) {
      if (g.kind === "fold" && [id, ...chain].some((x) => g.members.includes(x))) unfold.add(g.id);
      if (g.kind === "column" && g.column !== "conflict" && sc.items.get(g.id)?.folded && g.members.includes(chain.at(-1) ?? id)) unfold.add(g.id);
    }
    name ||= m.name(id);
  }
  if (!open.size && !unfold.size && !pull.size) return undefined;
  return { open, unfold, pull, name };
}

/**
 * What must open for `sel` to be drawn: a part's every enclosing block, and the folded group its
 * top-level part is in; a line's, down to where its ends part ways, when they're inside one
 * drawn block. Undefined if it's drawn already, or not drawable.
 */
function openings(m: Model, sc: Scene, sel: Sel | undefined): { open: Set<string>; unfold: Set<string>; name: string } | undefined {
  if (!sel) return undefined;
  const open = new Set<string>();
  const unfold = new Set<string>();
  const sys = m.system?.id;
  const chainOf = (id: string) => [...m.ancestors(id)].reverse().filter((x) => x !== sys);
  const groupsOf = (top: string) => [...sc.groups.values()].filter((g) => g.members.includes(top) && sc.items.get(g.id)?.folded).map((g) => g.id);
  let name = "";
  if (sel.kind === "part") {
    for (const id of sel.ids) {
      if (!m.nodes.has(id) || sc.items.has(id)) continue;
      const chain = chainOf(id);
      const top = chain[0] ?? id;
      if (sc.holder(top) === undefined) continue; // not drawn at all (the lens, Show, or no lines)
      for (const g of groupsOf(top)) unfold.add(g);
      for (const x of chain) open.add(x);
      name ||= m.name(id);
    }
  } else if (sel.kind === "line") {
    for (const id of sel.ids) {
      const e = m.edges.get(id);
      if (!e || (sc.drawnAs.get(id) ?? []).some((l) => sc.lines.has(l))) continue;
      const a = [...chainOf(e.from), e.from], b = [...chainOf(e.to), e.to];
      if (sc.holder(a[0]!) === undefined || sc.holder(b[0]!) === undefined) continue;
      for (const g of [...groupsOf(a[0]!), ...groupsOf(b[0]!)]) unfold.add(g);
      for (let k = 0; k < Math.min(a.length, b.length) - 1 && a[k] === b[k]; k++) open.add(a[k]!);
      name ||= `${m.name(e.from)} → ${m.name(e.to)}`;
    }
  } else if (sel.kind === "group") {
    const g = sc.groups.get(sel.id);
    if (g && g.kind !== "column") for (const c of sc.groups.values()) if (c.kind === "column" && c.members.includes(g.members[0]!) && sc.items.get(c.id)?.folded) unfold.add(c.id);
    name = g?.title ?? sel.id;
  }
  if (!open.size && !unfold.size) return undefined;
  return { open, unfold, name };
}
