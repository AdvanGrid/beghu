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
// (a fresh Back history). Picking a part, a line or anything else keeps the canvas as it is, and
// opens nothing down to it. "Code view at ‹part›" (or a double-click on a part with nothing
// inside) leaves the fold for layout A opened down to that part; "← Back to ‹place›" returns to
// the fold as it was, as does picking that place in the panel (another place starts afresh).
// It starts on the PR's fold when the analysis has purposes, else in layout A (the fallback,
// `unbacked`); the order lens (slice 11) keeps its own drawing.
import { createContext, createEffect, createMemo, createSignal, untrack, useContext, type Accessor } from "solid-js";
import type { Node } from "../../bindings/analysis";
import { columnGroup } from "../layout/graph";
import type { Layout } from "../layout/types";
import type { Model } from "../model";
import { part, type Nav } from "../nav";
import { drawnFolders } from "../Panel";
import type { Sel } from "../state";
import { placeOf, purposesOf, samePlace, selOfPlace, type Place } from "../purposes";
import { FOLD_BUDGET, planOf, planState, type FoldInput, type FoldPlan } from "./fold";
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
  /** Leaves the fold for layout A, opened down to `part` and with it selected. */
  codeView: (part: string) => void;
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
  /** Opens down to what `sel` names, if it's inside a folded block: one Back step. Whether it did. */
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
  // Each place's plan, made once per analysis, place and lens.
  const plans = new Map<string, { input: FoldInput; plan: FoldPlan }>();
  const planFor = (pl: Place): { input: FoldInput; plan: FoldPlan } => {
    const m = model(), st = settings();
    const key = `${m.g.id}\u0000${st.lens}\u0000${pl.kind === "purpose" ? pl.id : pl.kind}`;
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
    return { open: new Set([...s.open].filter((x) => !inside(x))), folded: s.folded };
  };

  const atStart = createMemo(() => history().length === 0 && same(state(), untrack(() => startState(mode()))));
  const store: CanvasStore = {
    settings,
    mode,
    atStart,
    codeView(id) {
      const md = untrack(mode);
      const m = model();
      if (!m.nodes.has(id)) return;
      if (md.kind === "fold") left = { place: md.place, state: untrack(state), history: untrack(history) };
      const from = md.kind === "fold" ? md.place : md.from;
      // Layout A opened down to the part: every block it sits in.
      const sys = m.system?.id;
      const open = new Set(m.ancestors(id).filter((x) => x !== sys));
      switchTo({ kind: "code", from }, { open, folded: new Set() }, [], id);
      nav.select(part(id));
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
        step({ open: s.open, folded }, `opened ${name(id)}`, at ?? id);
        return;
      }
      if ((model().children.get(id) ?? []).length === 0 || s.open.has(id)) return;
      step({ open: new Set([...s.open, id]), folded: s.folded }, `opened ${name(id)}`, at ?? id);
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
      // Under the fold, a pick keeps the canvas as it is.
      if (untrack(mode).kind === "fold") return false;
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
  return eq(a.open, b.open) && eq(a.folded, b.folded);
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
