// Our layout's rules (#144, #163, #166, #180), checked through the engine's own seam (graph in,
// coordinates out) on the layout suite's committed synthetic graph (fixtures/pr-view/layout/:
// #2627's shape at 1×, and 3×), on a dense scope, and on random graphs. An exception to "tests go
// through public seams" (AGENTS.md): the rules are geometry no HTTP answer or page shows. Whether
// the drawing reads well is the browser suite's and the owner's; how big, crossed and fast it is,
// the `layout` perf suite's. `npm run test:lint`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { layoutInput, type DrawableEdge, type DrawableGraph, type DrawableNode, type View } from "./graph.ts";
import { layout } from "./layout.ts";
import type { Layout, LayoutInput, Line, P, Placed, Rect, Scope } from "./types.ts";

const graph = (scale: string) => JSON.parse(readFileSync(new URL(`../../../../fixtures/pr-view/layout/tiled-${scale}.json`, import.meta.url), "utf8")) as DrawableGraph;
const blocksOf = (g: DrawableGraph) => new Set(g.nodes.filter((n) => n.kind !== "system" && g.nodes.some((m) => m.parent === n.id)).map((n) => n.id));

/** The drawing's padding, and where a frame's first part may start below its top (its title strip). */
const PAD = 24;
const TOP_INSET = 44;
/** The room the engine gives each level routed through a gap: LEVEL apart, CLEAR from the parts. */
const LEVEL = 12;
const CLEAR = 10;
const EPS = 0.5;

/** Each input line, with its scope. */
function linesOf(input: LayoutInput) {
  const out = new Map<string, { scope: string; line: Line }>();
  const walk = (s: Scope) => {
    for (const l of s.lines) {
      assert.ok(!out.has(l.id), `two lines are ${l.id}`);
      out.set(l.id, { scope: s.id, line: l });
    }
    for (const p of s.parts) if (p.frame) walk(p.frame);
  };
  walk(input.root);
  return out;
}

const segments = (pts: P[]) => pts.slice(1).map((q, i) => [pts[i]!, q] as const);
const flat = ([p, q]: readonly [P, P]) => Math.abs(p.y - q.y) < EPS;
/** Whether a segment passes through the inside of a rectangle (touching its edge is fine). */
const through = ([a, b]: readonly [P, P], r: Rect) =>
  Math.max(a.x, b.x) > r.x + EPS && Math.min(a.x, b.x) < r.x + r.w - EPS && Math.max(a.y, b.y) > r.y + EPS && Math.min(a.y, b.y) < r.y + r.h - EPS;
const disjoint = (a: Rect, b: Rect) => a.x + a.w <= b.x + EPS || b.x + b.w <= a.x + EPS || a.y + a.h <= b.y + EPS || b.y + b.h <= a.y + EPS;
/** A straight stretch as its line (y of a horizontal, x of a vertical) and its range along it. */
const stretch = (s: readonly [P, P]) => {
  const h = flat(s);
  const [p, q] = s;
  return { h, at: h ? p.y : p.x, lo: h ? Math.min(p.x, q.x) : Math.min(p.y, q.y), hi: h ? Math.max(p.x, q.x) : Math.max(p.y, q.y) };
};

/** Whether `route` runs along all of the straight stretch from `a` to `b`. */
function covers(route: P[], s: readonly [P, P]): boolean {
  const t = stretch(s);
  const on = segments(route)
    .map(stretch)
    .filter((r) => r.h === t.h && Math.abs(r.at - t.at) < EPS)
    .sort((x, y) => x.lo - y.lo);
  let reached = t.lo;
  for (const r of on) if (r.lo <= reached + EPS) reached = Math.max(reached, r.hi);
  return reached >= t.hi - EPS;
}

/** Whether point `p` is on the left or right edge of `r`. */
const onSide = (p: P, r: Rect) => (Math.abs(p.x - r.x) < EPS || Math.abs(p.x - r.x - r.w) < EPS) && p.y >= r.y - EPS && p.y <= r.y + r.h + EPS;

/** Every rule the drawing must keep, whatever is open. */
function checkRules(L: Layout, input: LayoutInput) {
  const parts = [...L.parts];
  const ancestors = (scope: string): string[] => {
    const out: string[] = [];
    for (let s: string | undefined = scope; s !== undefined && L.parts.has(s); s = L.parts.get(s)!.scope) out.push(s);
    return out;
  };
  const lines = linesOf(input);

  // No two parts or frames overlap, and each sits inside its frame.
  const byScope = new Map<string, [string, Placed][]>();
  for (const e of parts) {
    const sibs = byScope.get(e[1].scope);
    if (sibs) sibs.push(e);
    else byScope.set(e[1].scope, [e]);
  }
  for (const [scope, sibs] of byScope) {
    const frame = L.scopes.get(scope)!.rect;
    for (let i = 0; i < sibs.length; i++) {
      const [a, ra] = sibs[i]!;
      assert.ok(ra.x >= frame.x - EPS && ra.y >= frame.y - EPS && ra.x + ra.w <= frame.x + frame.w + EPS && ra.y + ra.h <= frame.y + frame.h + EPS, `${a} sits outside ${scope}`);
      for (let j = i + 1; j < sibs.length; j++) assert.ok(disjoint(ra, sibs[j]![1]), `${a} overlaps ${sibs[j]![0]} in ${scope}`);
    }
  }

  // Each group frame holds its group's parts and no other.
  const root = L.scopes.get(input.root.id)!;
  if (input.root.parts.some((p) => p.column === "changed" || p.column === "unchanged")) assert.ok(root.groups.length > 0);
  for (const g of root.groups)
    for (const p of input.root.parts) {
      const r = L.parts.get(p.id)!;
      if (p.column === g.column) assert.ok(!disjoint(r, g.rect) && r.x >= g.rect.x && r.x + r.w <= g.rect.x + g.rect.w && r.y >= g.rect.y && r.y + r.h <= g.rect.y + g.rect.h, `${p.id} sits outside the ${g.column} group`);
      else assert.ok(disjoint(r, g.rect), `${p.id} sits in the ${g.column} group`);
    }

  // Both groups, and every frame's inside, packed from the top: in some column of each, the
  // first part sits at the top but for the room the levels routed above it take.
  const horizontals = [...L.routes.values()].flatMap(segments).filter(flat);
  const packed = (what: string, top: number, ps: Placed[]) => {
    if (!ps.length) return;
    const columns = new Map<number, Placed[]>();
    for (const p of ps) columns.set(p.x, [...(columns.get(p.x) ?? []), p]);
    const bands = [...columns.values()].map((col) => {
      const first = col.reduce((a, b) => (b.y < a.y ? b : a));
      const x1 = Math.max(...col.map((p) => p.x + p.w));
      const levels = new Set(horizontals.filter(([p, q]) => p.y > top - 24 - EPS && p.y < first.y && Math.min(p.x, q.x) < x1 && Math.max(p.x, q.x) > first.x).map(([p]) => p.y));
      return { band: first.y - top, room: levels.size ? levels.size * LEVEL + 2 * CLEAR : 0 };
    });
    assert.ok(bands.some((b) => b.band <= b.room + EPS), `${what}: an empty band above (${bands.map((b) => `${b.band} px for ${b.room}`).join(", ")})`);
  };
  for (const g of root.groups) {
    const inGroup = parts.filter(([, p]) => p.scope === input.root.id && !disjoint(p, g.rect)).map(([, p]) => p);
    packed(`the ${g.column} group`, root.rect.y + PAD + TOP_INSET, inGroup);
  }
  for (const [scope, sibs] of byScope) if (scope !== input.root.id) packed(scope, L.scopes.get(scope)!.rect.y + TOP_INSET, sibs.map(([, p]) => p));

  // One route per input line, from the edge of its `from` to the edge of its `to` (a port's end
  // on its frame's edge), laid one way and orthogonal.
  assert.deepEqual([...L.routes.keys()].sort(), [...lines.keys()].sort(), "one route per line");
  for (const [id, r] of L.routes) {
    const { scope, line } = lines.get(id)!;
    assert.ok(r.length >= 2, `${id} has no route`);
    const edge = (e: Line["from"]) => (typeof e === "string" ? L.parts.get(e)! : L.scopes.get(scope)!.rect);
    assert.ok(onSide(r[0]!, edge(line.from)), `${id} doesn't start on its from's edge`);
    assert.ok(onSide(r[r.length - 1]!, edge(line.to)), `${id} doesn't end on its to's edge`);
    const dx = segments(r).map(([p, q]) => Math.sign(Math.round(q.x - p.x)));
    assert.ok(!(dx.includes(1) && dx.includes(-1)), `${id} runs both ways`);
    for (const [p, q] of segments(r)) assert.ok(Math.abs(p.x - q.x) < EPS || Math.abs(p.y - q.y) < EPS, `${id} isn't orthogonal`);
  }

  // Parts joined by a line never share a column: their columns' x ranges don't meet.
  for (const [id, { line }] of lines) {
    if (typeof line.from !== "string" || typeof line.to !== "string") continue;
    const [a, b] = [L.parts.get(line.from)!, L.parts.get(line.to)!];
    assert.ok(a.x + a.w <= b.x + EPS || b.x + b.w <= a.x + EPS, `${id} joins two parts in one column`);
  }

  // No line passes through a part: only through the frames and boxes it's drawn inside.
  for (const [id, r] of L.routes) {
    const { scope, line } = lines.get(id)!;
    const ends = [line.from, line.to].flatMap((e) => (typeof e === "string" ? [e] : []));
    const inside = new Set([...ancestors(scope), ...ends.flatMap((e) => ancestors(L.parts.get(e)!.scope))]);
    for (const s of segments(r)) for (const [pid, p] of parts) if (!inside.has(pid)) assert.ok(!through(s, p), `${id} passes through ${pid}`);
  }

  // Trunks exactly where lines share a stretch: each carries two or more, all along it, and no
  // two routes run together anywhere but on a trunk carrying both.
  const rides = new Map<string, number[]>();
  L.trunks.forEach((t, k) => {
    assert.ok(new Set(t.lines).size > 1, `${t.id} carries one line`);
    for (const s of segments(t.points)) for (const id of t.lines) assert.ok(covers(L.routes.get(id)!, s), `${id} isn't on all of ${t.id}`);
    for (const id of t.lines) rides.set(id, [...(rides.get(id) ?? []), k]);
  });
  // Two stretches under a pixel apart read as one.
  const all = [...L.routes].flatMap(([id, r]) => segments(r).map((s) => ({ id, ...stretch(s) })));
  all.sort((a, b) => Number(a.h) - Number(b.h) || a.at - b.at);
  const trunkStretches = L.trunks.map((t) => segments(t.points).map(stretch));
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length && all[j]!.h === all[i]!.h && all[j]!.at - all[i]!.at < 1; j++) {
      const [a, b] = [all[i]!, all[j]!];
      const lo = Math.max(a.lo, b.lo), hi = Math.min(a.hi, b.hi);
      if (a.id === b.id || hi - lo < 1) continue;
      const shared = (rides.get(a.id) ?? []).some((t) => rides.get(b.id)?.includes(t) && trunkStretches[t]!.some((s) => s.h === a.h && Math.abs(s.at - a.at) < 1 && Math.min(s.hi, hi) - Math.max(s.lo, lo) > 0));
      assert.ok(shared, `${a.id} and ${b.id} run together at ${a.h ? "y" : "x"} ${a.at} from ${lo} to ${hi} on no trunk`);
    }
}

/** Every part and route in `a` is exactly as in `b`. */
function same(a: Layout, b: Layout, what: string) {
  assert.deepEqual([...b.parts.keys()].sort(), [...a.parts.keys()].sort(), `${what}: the same parts`);
  for (const [id, p] of a.parts) assert.deepEqual(b.parts.get(id), p, `${what}: ${id} moved`);
  assert.deepEqual([...b.routes.keys()].sort(), [...a.routes.keys()].sort(), `${what}: the same lines`);
  for (const [id, r] of a.routes) assert.deepEqual(b.routes.get(id), r, `${what}: ${id}'s route changed`);
}

/**
 * Opening (or folding) the block at the end of `path` moved only what it pushes. In each scope on
 * the way down (`[scope, the child on the way]`): parts left of the child, and in its column above
 * it, stay put; parts below it in its column move only down on an open (up on a fold), and parts
 * right of it only right (left); everything else keeps its y. Scopes off the way move whole.
 */
function pushedOnly(before: Layout, after: Layout, path: [string, string][], opening: boolean, what: string) {
  const on = new Set(path.map(([s]) => s));
  const rel = (L: Layout, id: string) => {
    const p = L.parts.get(id)!, s = L.scopes.get(p.scope)!.rect;
    return { x: p.x - s.x, y: p.y - s.y, w: p.w, h: p.h };
  };
  const way = (d: number) => (opening ? d >= 0 : d <= 0);
  for (const [id, p] of before.parts) {
    if (!after.parts.has(id)) continue;
    const [b, a] = [rel(before, id), rel(after, id)];
    const step = path.find(([s]) => s === p.scope);
    if (!step) {
      if (!on.has(id) && !path.some(([, c]) => c === id)) assert.deepEqual(a, b, `${what}: ${id} changed in a scope off the way`);
      continue;
    }
    const c = rel(before, step[1]);
    if (b.x <= c.x + EPS) assert.equal(a.x, b.x, `${what}: ${id}, left of ${step[1]}, moved sideways`);
    else assert.ok(way(a.x - b.x), `${what}: ${id}, right of ${step[1]}, moved the wrong way`);
    if (Math.abs(b.x - c.x) < EPS && b.y > c.y) assert.ok(way(a.y - b.y), `${what}: ${id}, below ${step[1]}, moved the wrong way`);
    else assert.equal(a.y, b.y, `${what}: ${id} moved up or down`);
  }
}

/** A seeded random number generator (mulberry32). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random drawable graph: `n` nodes in a tree up to three deep, `2n` lines. */
function randomGraph(seed: number, n: number): DrawableGraph {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const nodes: DrawableNode[] = [{ id: "sys", kind: "system", name: "sys", change: "modified", paths: [], facets: [] }];
  const depth = new Map<string, number>([["sys", 0]]);
  for (let i = 0; i < n; i++) {
    const parent = i < 4 || r() < 0.4 ? "sys" : pick(nodes.filter((m) => m.kind !== "actor" && m.kind !== "external" && m.kind !== "store" && depth.get(m.id)! < 3)).id;
    const top = parent === "sys";
    const kind = top ? pick(["actor", "external", "store", "service", "library", "library", "module"] as const) : pick(["module", "library"] as const);
    // IDs with the separators a drawn line's ID might be built with.
    const id = `n${i}${pick(["", "/x", "|y", ":z", "<w", ">v"])}`;
    nodes.push({ id, kind, parent, name: id, change: pick(["added", "modified", "unchanged", "unchanged"] as const), paths: [`${pick(["web", "crates", "perf"])}/${id}`], facets: [{ facet: "outside-kind", values: [{ value: pick(["db", "api"]) }] }] });
    depth.set(id, depth.get(parent)! + 1);
  }
  const edges: DrawableEdge[] = [];
  const real = nodes.slice(1);
  for (let i = 0; i < 2 * n; i++) {
    const [a, b] = [pick(real), pick(real)];
    if (a !== b) edges.push({ id: `e${i}`, from: a.id, to: b.id, kind: "call", when: "runtime", change: pick(["added", "unchanged"] as const) });
  }
  return { nodes, edges, facets: [{ id: "outside-kind", appliesTo: "node", multi: false, values: [{ id: "db" }, { id: "api" }] }] };
}

/** The chain of [scope, child] pairs from the drawing down to `block`. */
function wayTo(g: DrawableGraph, block: string): [string, string][] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const sys = g.nodes.find((n) => n.kind === "system")!.id;
  const out: [string, string][] = [];
  for (let id = block; ; ) {
    const p = byId.get(id)!.parent ?? sys;
    out.unshift([p, id]);
    if (p === sys) return out;
    id = p;
  }
}

/** Every open-and-fold rule, on graph `g`. */
function openAndFold(g: DrawableGraph) {
  const blocks = blocksOf(g);
  const run = (view: View, previous?: Layout) => {
    const { input } = layoutInput(g, view, previous);
    return { input, L: layout(input) };
  };
  const kids = (id: string): number => g.nodes.filter((n) => n.parent === id).reduce((s, n) => s + 1 + kids(n.id), 0);
  const depth = (id: string): number => {
    const p = g.nodes.find((n) => n.id === id)!.parent;
    return p && blocks.has(p) ? 1 + depth(p) : 0;
  };
  return {
    blocks,
    run,
    /** Opens the top-level block with the most inside, then folds it. */
    openOne() {
      const top = run({ open: new Set() });
      const block = [...blocks].filter((b) => top.L.parts.has(b)).sort((a, b) => kids(b) - kids(a) || (a < b ? -1 : 1))[0];
      if (!block) return;
      const opened = run({ open: new Set([block]) }, top.L);
      checkRules(opened.L, opened.input);
      pushedOnly(top.L, opened.L, wayTo(g, block), true, `opening ${block}`);
      same(top.L, run({ open: new Set() }, opened.L).L, `folding ${block}`);
    },
    /** Folds the deepest block from fully open, then opens it again. */
    foldDeep() {
      const full = run({ open: blocks }).L;
      const deep = [...blocks].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1))[0];
      if (!deep || depth(deep) < 1) return;
      const folded = run({ open: new Set([...blocks].filter((b) => b !== deep)) }, full);
      checkRules(folded.L, folded.input);
      pushedOnly(full, folded.L, wayTo(g, deep), false, `folding ${deep}`);
      same(full, run({ open: blocks }, folded.L).L, `reopening ${deep}`);
    },
    /** Folds everything from a fresh fully open drawing: the fresh top level's drawing. */
    foldAll() {
      const top = run({ open: new Set() }).L;
      const folded = run({ open: new Set() }, run({ open: blocks }).L);
      checkRules(folded.L, folded.input);
      same(top, folded.L, "folding all from fully open");
    },
  };
}

for (const scale of ["1x", "3x"]) {
  describe(`our layout at ${scale}`, () => {
    const g = graph(scale);
    const t = openAndFold(g);

    it("keeps the rules at the top level", () => {
      const { input, L } = t.run({ open: new Set() });
      checkRules(L, input);
    });

    it("keeps the rules fully open", () => {
      const { input, L } = t.run({ open: t.blocks });
      assert.ok([...L.parts.values()].some((p) => p.frame && p.scope !== input.root.id), "blocks open inside blocks");
      checkRules(L, input);
    });

    it("keeps the rules with boxes", () => {
      const { input, L } = t.run({ open: new Set(), boxes: true });
      assert.ok([...L.parts.values()].some((p) => p.box));
      checkRules(L, input);
    });

    it("moves only what an opened block pushes, and puts it back when it folds", () => t.openOne());
    it("folds a deep block from fully open, moving only what it pushed, and opens it back to where it was", () => t.foldDeep());
    it("folds everything from fully open into the top level's drawing", () => t.foldAll());
  });
}

describe("our layout on a dense scope", () => {
  // 20 changed parts, every one joined to every other: no two can share a column.
  const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
  const lines: Line[] = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => ({ id: `${a}-${b}`, from: a, to: b, count: 1, changed: true })));
  const input: LayoutInput = { root: { id: "root", parts: ids.map((id) => ({ id, w: 216, h: 74, column: "changed" })), lines } };

  it("keeps the rules", () => checkRules(layout(input), input));
});

describe("our layout on random graphs", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const g = randomGraph(seed, 60);
    const t = openAndFold(g);
    it(`keeps the rules at seed ${seed}`, () => {
      for (const view of [{ open: new Set<string>() }, { open: t.blocks }, { open: new Set<string>(), boxes: true }, { open: t.blocks, boxes: true, showLonely: true }]) {
        const { input, L } = t.run(view);
        checkRules(L, input);
      }
    });
    it(`moves only what an open or fold pushes at seed ${seed}`, () => {
      t.openOne();
      t.foldDeep();
      t.foldAll();
    });
  }
});

describe("the adapter", () => {
  const node = (id: string, parent?: string, kind: DrawableNode["kind"] = "module"): DrawableNode => ({ id, kind, parent, name: id, change: "added", paths: [], facets: [] });
  const edge = (from: string, to: string): DrawableEdge => ({ id: `${from}->${to}`, from, to, kind: "call", when: "runtime", change: "added" });

  it("gives every drawn line its own ID, whatever its parts' IDs hold", () => {
    // Inside the open b, the line a → b/c runs from b's port to c; the top level also draws a
    // line from a to the part `b/c`.
    const g: DrawableGraph = { nodes: [node("sys", undefined, "system"), node("a"), node("b"), node("c", "b"), node("b/c")], edges: [edge("a", "c"), edge("a", "b/c")], facets: [] };
    const { input, members } = layoutInput(g, { open: new Set(["b"]) });
    checkRules(layout(input), input);
    assert.equal(members.size, 3);
  });

  it("draws a part whose parent is missing, or in a loop, at the top level", () => {
    const g: DrawableGraph = { nodes: [node("sys", undefined, "system"), node("a"), node("b", "gone"), node("c", "d"), node("d", "c"), node("e", "e")], edges: [edge("a", "b"), edge("a", "c"), edge("a", "e")], facets: [] };
    const { input } = layoutInput(g, { open: new Set(["c", "d"]) });
    const L = layout(input);
    checkRules(L, input);
    for (const id of ["a", "b", "e"]) assert.equal(L.parts.get(id)?.scope, "sys", `${id} at the top level`);
    assert.ok(L.parts.has("c") && L.parts.has("d"));
  });
});
