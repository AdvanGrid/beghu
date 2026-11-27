// Our layout's rules (#144, #163, #166, #180), checked through the engine's own seam (graph in,
// coordinates out) on the layout suite's committed synthetic graph (fixtures/pr-view/layout/:
// #2627's shape at 1×, and 3×), on a dense scope, and on random graphs; and at 1× through runs of
// opens and folds as the view lays them out (each from the last answer), boxes and lonely parts
// turned on and off, and a later analysis laid out from this one's answer. An exception to "tests
// go through public seams" (AGENTS.md): the rules are geometry no HTTP answer or page shows.
// Whether the drawing reads well is the browser suite's and the owner's; how big, crossed and fast
// it is, the `layout` perf suite's. `npm run test:lint`.
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
/** Two stretches closer than this read as one (the engine's NEAR). */
const NEAR = 4;

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

/** Whether a route (as its stretches) runs along all of the straight stretch from `a` to `b`. */
function covers(route: ReturnType<typeof stretch>[], s: readonly [P, P]): boolean {
  const t = stretch(s);
  const on = route.filter((r) => r.h === t.h && Math.abs(r.at - t.at) < EPS).sort((x, y) => x.lo - y.lo);
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

  // Both groups, and every frame's inside, packed from the top: in every column of each, the
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
    assert.ok(bands.every((b) => b.band <= b.room + EPS), `${what}: an empty band above (${bands.map((b) => `${b.band} px for ${b.room}`).join(", ")})`);
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

  // No line passes through a part: only through the frames and boxes it's drawn inside. (Parts
  // found by the 256 px bands of x they cover.)
  const bands = new Map<number, [string, Placed][]>();
  for (const e of parts) for (let b = Math.floor(e[1].x / 256); b <= Math.floor((e[1].x + e[1].w) / 256); b++) bands.set(b, [...(bands.get(b) ?? []), e]);
  for (const [id, r] of L.routes) {
    const { scope, line } = lines.get(id)!;
    const ends = [line.from, line.to].flatMap((e) => (typeof e === "string" ? [e] : []));
    const inside = new Set([...ancestors(scope), ...ends.flatMap((e) => ancestors(L.parts.get(e)!.scope))]);
    for (const s of segments(r)) {
      const near = new Set<[string, Placed]>();
      for (let b = Math.floor(Math.min(s[0].x, s[1].x) / 256); b <= Math.floor(Math.max(s[0].x, s[1].x) / 256); b++) for (const e of bands.get(b) ?? []) near.add(e);
      for (const [pid, p] of near) if (!inside.has(pid)) assert.ok(!through(s, p), `${id} passes through ${pid}`);
    }
  }

  // Trunks exactly where lines share a stretch: each carries two or more, all along it, and no
  // two routes run together anywhere but on a trunk carrying both.
  const rides = new Map<string, number[]>();
  const stretches = new Map([...L.routes].map(([id, r]) => [id, segments(r).map(stretch)]));
  L.trunks.forEach((t, k) => {
    assert.ok(new Set(t.lines).size > 1, `${t.id} carries one line`);
    for (const s of segments(t.points)) for (const id of t.lines) assert.ok(covers(stretches.get(id)!, s), `${id} isn't on all of ${t.id}`);
    for (const id of t.lines) {
      const ks = rides.get(id);
      if (ks) ks.push(k);
      else rides.set(id, [k]);
    }
  });
  // Two stretches under NEAR apart read as one. (Compared in runs of stretches each under NEAR
  // from the last, by where they start.)
  const all = [...stretches].flatMap(([id, ss]) => ss.map((s) => ({ id, ...s })));
  all.sort((a, b) => Number(a.h) - Number(b.h) || a.at - b.at);
  const trunkStretches = L.trunks.map((t) => segments(t.points).map(stretch));
  const runs: (typeof all)[] = [];
  for (const [i, x] of all.entries()) {
    const w = all[i - 1];
    if (w && w.h === x.h && x.at - w.at < NEAR) runs[runs.length - 1]!.push(x);
    else runs.push([x]);
  }
  for (const run of runs) run.sort((a, b) => a.lo - b.lo);
  for (const run of runs)
    for (let i = 0; i < run.length; i++)
      for (let j = i + 1; j < run.length && run[j]!.lo < run[i]!.hi - 1; j++) {
        const [a, b] = [run[i]!, run[j]!];
        const lo = Math.max(a.lo, b.lo), hi = Math.min(a.hi, b.hi);
        if (a.id === b.id || hi - lo < 1 || Math.abs(a.at - b.at) >= NEAR) continue;
        const shared = (rides.get(a.id) ?? []).some((t) => rides.get(b.id)?.includes(t) && trunkStretches[t]!.some((s) => s.h === a.h && Math.abs(s.at - a.at) < NEAR && Math.min(s.hi, hi) - Math.max(s.lo, lo) > 0));
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

/** Each scope's drawing with every block in it folded: what its anchors are, by graph and scope. */
const foldedDrawings = new WeakMap<DrawableGraph, Map<string, Layout>>();
function foldedOf(g: DrawableGraph, scope: string): Layout {
  let m = foldedDrawings.get(g);
  if (!m) foldedDrawings.set(g, (m = new Map()));
  let L = m.get(scope);
  if (!L) {
    const sys = g.nodes.find((n) => n.kind === "system")!.id;
    const open = new Set(scope === sys ? [] : wayTo(g, scope).map(([, c]) => c));
    m.set(scope, (L = layout(layoutInput(g, { open }).input)));
  }
  return L;
}

/**
 * Opening (or folding) `block` moved only what it pushes. In each scope on the way down to it
 * (`[scope, the child on the way]`):
 * - y: parts below the child in its column move only down on an open (up on a fold); every other
 *   part keeps its y;
 * - x: a column's parts move alike, and every column keeps its width but the child's, which only
 *   widens on an open (narrows on a fold). Every gutter keeps the width it has in the scope's
 *   folded drawing (its anchor) but where its tracks need more, and then it's the least width that
 *   fits them: so a gutter that changed is wider than its anchor in one of the two drawings, and
 *   never narrower in either. Next to the block, that's its lines' ends on the frame's edge
 *   needing more tracks: everything right of the gutter moves the change's way. Further off it's
 *   the lines re-routed round the block (the level grid is shared by every column), which can
 *   need more tracks there or fewer, so a column right of the block can move by less than the
 *   block's growth, or against it.
 * Scopes off the way don't change. Returns whether a column left of the child moved, and whether
 * one right of it moved against the change.
 */
function pushedOnly(g: DrawableGraph, before: Layout, after: Layout, block: string, opening: boolean, what: string) {
  const path = wayTo(g, block);
  const on = new Set(path.map(([s]) => s));
  const rel = (L: Layout, id: string) => {
    const p = L.parts.get(id)!, s = L.scopes.get(p.scope)!.rect;
    return { x: p.x - s.x, y: p.y - s.y, w: p.w, h: p.h };
  };
  const way = (d: number) => (opening ? d >= -1e-9 : d <= 1e-9);
  for (const [id, p] of before.parts) {
    if (!after.parts.has(id)) continue;
    const [b, a] = [rel(before, id), rel(after, id)];
    const step = path.find(([s]) => s === p.scope);
    if (!step) {
      if (!on.has(id) && !path.some(([, c]) => c === id)) assert.deepEqual(a, b, `${what}: ${id} changed in a scope off the way`);
      continue;
    }
    const c = rel(before, step[1]);
    if (Math.abs(b.x - c.x) < EPS && b.y > c.y) assert.ok(way(a.y - b.y), `${what}: ${id}, below ${step[1]}, moved the wrong way`);
    else assert.equal(a.y, b.y, `${what}: ${id} moved up or down`);
  }
  let left = false, against = false;
  for (const [scope, child] of path) {
    const folded = foldedOf(g, scope);
    // The scope's columns, left to right, as their parts.
    const byX = new Map<number, string[]>();
    for (const [id, p] of before.parts) if (p.scope === scope) byX.set(rel(before, id).x, [...(byX.get(rel(before, id).x) ?? []), id]);
    const cols = [...byX].sort((p, q) => p[0] - q[0]).map(([, ids]) => ids);
    const geo = (L: Layout) =>
      cols.map((ids) => {
        const xs = ids.map((id) => rel(L, id).x);
        assert.ok(xs.every((x) => x === xs[0]), `${what}: a column of ${scope} moved apart`);
        return { x: xs[0]!, w: Math.max(...ids.map((id) => rel(L, id).w)) };
      });
    const [b, a, f] = [geo(before), geo(after), geo(folded)];
    const k0 = cols.findIndex((ids) => ids.includes(child));
    cols.forEach((ids, k) => {
      if (k === k0) assert.ok(way(a[k]!.w - b[k]!.w), `${what}: ${child}'s column changed width the wrong way`);
      else assert.equal(a[k]!.w, b[k]!.w, `${what}: a column of ${scope} changed width`);
      if (k < k0 && a[k]!.x !== b[k]!.x) left = true;
      if (k > k0 && !way(a[k]!.x - b[k]!.x)) against = true;
      if (k + 1 === cols.length) return;
      const gap = (m: typeof b) => m[k + 1]!.x - m[k]!.x - m[k]!.w;
      const [gb, ga, gf] = [gap(b), gap(a), gap(f)];
      assert.ok(Math.min(gb, ga) >= gf - 1e-6, `${what}: the gutter right of ${ids[0]} in ${scope} is narrower than its anchor`);
      if (Math.abs(gb - ga) > 1e-6) assert.ok(Math.max(gb, ga) > gf + 1e-6, `${what}: the gutter right of ${ids[0]} in ${scope} changed at its anchor's width`);
    });
  }
  return { left, against };
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

/**
 * Opens and folds on graph `g` in `view`, each laid out from the last answer, as the view does.
 * Each step checks the push rules (`pushedOnly`), and every rule but when `rules` is false; and
 * coming back to an open set seen before gives exactly the drawing it had then.
 */
function session(g: DrawableGraph, view: Omit<View, "open"> = {}) {
  const blocks = blocksOf(g);
  const parentOf = new Map(g.nodes.map((n) => [n.id, n.parent]));
  const within = (id: string, block: string) => {
    for (let p = parentOf.get(id); p !== undefined; p = parentOf.get(p)) if (p === block) return true;
    return false;
  };
  const keyOf = (open: ReadonlySet<string>) => JSON.stringify([...open].sort());
  let open = new Set<string>();
  let L = layout(layoutInput(g, { ...view, open }).input);
  const seen = new Map([[keyOf(open), L]]);
  const moved = { left: 0, against: 0, steps: 0 };
  return {
    get open(): ReadonlySet<string> {
      return open;
    },
    /** The blocks drawn now, open or not. */
    drawn: () => [...L.parts.keys()].filter((id) => blocks.has(id)).sort(),
    /** How many steps moved a column left of the changed block, and right of it against the change. */
    moved,
    /** Opens or folds `block`; folding it folds what's open inside it. */
    toggle(block: string, rules = true) {
      const opening = !open.has(block);
      const next = new Set([...open].filter((b) => opening || (b !== block && !within(b, block))));
      if (opening) next.add(block);
      const { input } = layoutInput(g, { ...view, open: next }, L);
      const after = layout(input);
      const what = `${opening ? "opening" : "folding"} ${block} (to ${keyOf(next)})`;
      if (rules) checkRules(after, input);
      const m = pushedOnly(g, L, after, block, opening, what);
      (moved.left += +m.left), (moved.against += +m.against), moved.steps++;
      const k = keyOf(next);
      const was = seen.get(k);
      if (was) same(was, after, `${what}: back`);
      else seen.set(k, after);
      [open, L] = [next, after];
    },
  };
}

/**
 * `g` as a later analysis of the PR might have it: about one node in ten renamed and one in ten
 * dropped, with its lines (its children move up to its parent).
 */
function nextVersion(g: DrawableGraph, seed: number): DrawableGraph {
  const r = rng(seed);
  const dropped = new Set<string>();
  const renamed = new Map<string, string>();
  for (const n of g.nodes) {
    if (n.kind === "system") continue;
    const x = r();
    if (x < 0.1) dropped.add(n.id);
    else if (x < 0.2) renamed.set(n.id, `${n.id}~2`);
  }
  const parentOf = new Map(g.nodes.map((n) => [n.id, n.parent]));
  const up = (p: string | undefined) => {
    while (p !== undefined && dropped.has(p)) p = parentOf.get(p);
    return p;
  };
  const name = (id: string) => renamed.get(id) ?? id;
  const nodes = g.nodes.filter((n) => !dropped.has(n.id)).map((n) => ({ ...n, id: name(n.id), parent: up(n.parent) && name(up(n.parent)!) }));
  const edges = g.edges.filter((e) => !dropped.has(e.from) && !dropped.has(e.to)).map((e) => ({ ...e, from: name(e.from), to: name(e.to) }));
  return { ...g, nodes, edges };
}

/** Every open-and-fold rule, on graph `g`. */
function openAndFold(g: DrawableGraph) {
  const blocks = blocksOf(g);
  // A view's fresh drawing, laid out once.
  const fresh = new Map<string, { input: LayoutInput; L: Layout }>();
  const run = (view: View, previous?: Layout) => {
    const key = JSON.stringify({ ...view, open: [...view.open].sort() });
    const was = previous ? undefined : fresh.get(key);
    if (was) return was;
    const { input } = layoutInput(g, view, previous);
    const out = { input, L: layout(input) };
    if (!previous) fresh.set(key, out);
    return out;
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
      pushedOnly(g, top.L, opened.L, block, true, `opening ${block}`);
      same(top.L, run({ open: new Set() }, opened.L).L, `folding ${block}`);
    },
    /** Folds the deepest block from fully open, then opens it again. */
    foldDeep() {
      const full = run({ open: blocks }).L;
      const deep = [...blocks].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1))[0];
      if (!deep || depth(deep) < 1) return;
      const folded = run({ open: new Set([...blocks].filter((b) => b !== deep)) }, full);
      checkRules(folded.L, folded.input);
      pushedOnly(g, full, folded.L, deep, false, `folding ${deep}`);
      same(full, run({ open: blocks }, folded.L).L, `reopening ${deep}`);
    },
    /** Folds everything from a fresh fully open drawing, in `view`: the fresh top level's drawing. */
    foldAll(view: Omit<View, "open"> = {}) {
      const top = run({ ...view, open: new Set() }).L;
      const folded = run({ ...view, open: new Set() }, run({ ...view, open: blocks }).L);
      checkRules(folded.L, folded.input);
      same(top, folded.L, `folding all from fully open (${JSON.stringify(view)})`);
    },
    /**
     * Each view laid out from the last one's answer (the first from `previous`'s, or afresh) as it
     * is afresh: a change of boxes, of lonely parts or of the graph lays out afresh every scope it
     * changes, and the rest from the same anchors, whatever was open.
     */
    chain(views: View[], previous?: Layout) {
      const name = (v: View) => JSON.stringify({ ...v, open: [...v.open].sort() });
      let L = previous ?? run(views[0]!).L;
      for (const [i, v] of views.entries()) {
        if (i === 0 && !previous) continue;
        const now = run(v, L);
        checkRules(now.L, now.input);
        same(run(v).L, now.L, `${name(v)}, after ${views.slice(0, i).map(name).join(" then ")}`);
        L = now.L;
      }
      return L;
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

describe("opens and folds at 1x", () => {
  const g = graph("1x");
  const t = openAndFold(g);
  const top = session(g).drawn();

  it("opens and folds every top-level block, moving only what it pushes, and folds back exactly", () => {
    const s = session(g);
    for (const b of top) s.toggle(b), s.toggle(b);
  });

  it("opens two blocks and folds them, in either order, back exactly", () => {
    // 60 of the 182 ordered pairs, a fixed seeded sample (all of them take too long for
    // test:lint): +A, +B, -A, -B, each state checked against its first drawing.
    const s = session(g);
    const r = rng(2);
    const pairs = top.flatMap((a) => top.filter((b) => b !== a).map((b) => [a, b] as const));
    for (let i = 0; i < 60; i++) {
      const [a, b] = pairs.splice(Math.floor(r() * pairs.length), 1)[0]!;
      for (const x of [a, b, a, b]) s.toggle(x, false);
    }
  });

  it("opens a block inside an open block and folds it back exactly", () => {
    const s = session(g);
    for (const b of ["crates-analysis", "crates-analysis.tests", "crates-analysis.tests", "crates-analysis"]) s.toggle(b);
  });

  it("keeps every rule on a random walk of opens and folds, and comes back exactly", (c) => {
    const s = session(g);
    const r = rng(180);
    for (let i = 0; i < 200; i++) {
      const drawn = s.drawn();
      s.toggle(drawn[Math.floor(r() * drawn.length)]!);
    }
    assert.ok(s.open.size > 0);
    c.diagnostic(`${s.moved.steps} steps: ${s.moved.left} moved a column left of the block, ${s.moved.against} one right of it against the change`);
  });

  it("folds everything from fully open with boxes into the top level's drawing with boxes", () => t.foldAll({ boxes: true }));

  it("lays out afresh when boxes or lonely parts are turned on or off with blocks open", () => {
    const [none, full, some] = [new Set<string>(), t.blocks, new Set(["crates-server", "crates-analysis", "web"])];
    t.chain([{ open: full }, { open: full, boxes: true }, { open: none, boxes: true }]);
    t.chain([{ open: full }, { open: full, showLonely: true }, { open: none, showLonely: true }]);
    t.chain([{ open: full, boxes: true }, { open: full }, { open: none }]);
    t.chain([{ open: some }, { open: some, showLonely: true }, { open: some }, { open: some, boxes: true, showLonely: true }, { open: none }]);
  });

  it("lays out another analysis of the PR from this one's answer as it lays it out afresh", () => {
    // About one node in ten renamed and one in ten dropped.
    const v2 = nextVersion(g, 2);
    const t2 = openAndFold(v2);
    const none = new Set<string>();
    const full = t.run({ open: t.blocks }).L;
    t2.chain([{ open: t2.blocks }, { open: none }], full);
    // One step from there (folding a top-level block with a block inside), then all.
    const one = [...t2.blocks].find((b) => t2.run({ open: none }).L.parts.has(b) && [...t2.blocks].some((c) => v2.nodes.find((n) => n.id === c)?.parent === b))!;
    t2.chain([{ open: t2.blocks }, { open: new Set([...t2.blocks].filter((b) => b !== one)) }, { open: none }], full);
    // And from the first analysis's top level.
    t2.chain([{ open: t2.blocks }], t.run({ open: none }).L);
  });
});

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
