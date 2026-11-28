// The canvas's state, owned by the view's body so the panel reads the same drawing (the Group
// panel's groups, what a hover on the panel lights): the settings from the URL, the canvas's own
// opens and folds with their ← Back steps, the no-lines grid's toggle, and the scene laid out from
// them. Opens and folds are the canvas's (never in the URL, slice 7): each is one Back step that
// says what it undoes; Start over returns to the starting state (layout A, columns open, parts
// folded); a selection's change opens down to it when it's inside a folded block (one Back step).
import { createContext, createMemo, createSignal, untrack, useContext, type Accessor } from "solid-js";
import type { Node } from "../../bindings/analysis";
import { columnGroup } from "../layout/graph";
import type { Layout } from "../layout/types";
import type { Model } from "../model";
import type { Nav } from "../nav";
import { drawnFolders } from "../Panel";
import type { Sel } from "../state";
import { keyRows, type KeyRow } from "./key";
import { COLUMNS, sceneOf, type CanvasState, type Scene } from "./scene";
import { settingsOf, type Settings } from "./settings";

export const START: CanvasState = { open: new Set(), folded: new Set() };

/** One step ← Back undoes: the state before it, and what it did. */
export interface Step {
  state: CanvasState;
  what: string;
}

/** A glide under way: the drawing it leaves, the block that stays still, and its number. */
export interface Glide {
  from: Scene;
  at?: string;
  n: number;
  /** Fold: the contents shrink back in, rather than growing out. */
  fold: boolean;
}

export interface CanvasStore {
  settings: Accessor<Settings>;
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
  /** Opens down to what `sel` names, if it's inside a folded block: one Back step. Whether it did. */
  openTo: (sel: Sel | undefined) => boolean;
  /** The legend's rows for the drawing on screen. */
  rows: Accessor<KeyRow[]>;
  /** Parts the panel lights on the canvas (a responsibility's users), or none. */
  lit: Accessor<readonly string[] | undefined>;
  light: (nodes: readonly string[] | undefined) => void;
  model: Accessor<Model>;
}

export const CanvasContext = createContext<CanvasStore>();

export function useCanvas(): CanvasStore {
  const c = useContext(CanvasContext);
  if (!c) throw new Error("used outside the PR view's canvas");
  return c;
}

export function createCanvasStore(nav: Nav): CanvasStore {
  const model = () => nav.model();
  const settings = createMemo(() => settingsOf(nav.state(), nav.model()));
  const [state, setState] = createSignal<CanvasState>(START);
  const [history, setHistory] = createSignal<Step[]>([]);
  const [showLonely, setShowLonely] = createSignal(false);
  const [glide, setGlide] = createSignal<Glide>();
  const [lit, light] = createSignal<readonly string[] | undefined>(undefined);
  let glides = 0;
  let last: Layout | undefined;
  const folders = (n: Node) => drawnFolders(nav.model(), n).length;
  const scene = createMemo(() => {
    const sc = sceneOf(nav.model(), settings(), state(), showLonely(), last, folders);
    last = sc.layout;
    return sc;
  });

  const rows = createMemo(() => keyRows(nav.model(), settings(), scene()));
  const name = (id: string) => {
    const g = untrack(scene).groups.get(id);
    return g ? g.title : model().name(id);
  };
  const step = (next: CanvasState, what: string, at?: string, fold = false) => {
    const before = untrack(state);
    if (same(before, next)) return;
    setHistory((h) => [...h, { state: before, what }]);
    setGlide({ from: untrack(scene), at, n: ++glides, fold });
    setState(next);
  };
  /** `s` without `id` open, nor any block inside it (in the analysis, or in the group's parts). */
  const without = (s: CanvasState, id: string): CanvasState => {
    const m = model();
    const g = untrack(scene).groups.get(id);
    const inside = (x: string) => (g ? g.members.some((top) => m.within(x, top)) : m.within(x, id));
    return { open: new Set([...s.open].filter((x) => !inside(x))), folded: s.folded };
  };

  const store: CanvasStore = {
    settings,
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
        step({ open: next.open, folded: new Set([...next.folded, id]) }, `folded ${g.title}`, id, true);
        return;
      }
      if (!s.open.has(id)) return;
      step(without(s, id), `folded ${model().name(id)}`, id, true);
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
      setGlide({ from: untrack(scene), n: ++glides, fold: true });
      setState(last.state);
    },
    startOver() {
      if (same(untrack(state), START) && untrack(history).length === 0) return;
      setHistory([]);
      setGlide({ from: untrack(scene), n: ++glides, fold: true });
      setState(START);
    },
    openTo(sel) {
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
