// Our layout's rules (#144, #163, #166, #180), checked through the engine's own seam (graph in,
// coordinates out) on the layout suite's committed synthetic graph (fixtures/pr-view/layout/:
// #2627's shape at 1×, and 3×), on a dense scope, and on random graphs; through runs of opens and
// folds as the view lays them out (each from the last answer: at 1×, and on random graphs with
// boxes on and off), boxes and lonely parts turned on and off, the fold's column for code only a
// conflict reaches (fresh, and through walks of opens and folds), drawings laid out from their own answers, and a later analysis laid out from
// this one's answer. An exception to "tests go through public seams" (AGENTS.md): the rules are
// geometry no HTTP answer or page shows.
// Whether the drawing reads well is the browser suite's and the owner's; how big, crossed and fast
// it is, the `layout` perf suite's. `npm run test:lint`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { columnGroup, layoutInput, type DrawableEdge, type DrawableGraph, type DrawableNode, type View } from "./graph.ts";
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
/** The least room between two verticals side by side (the engine's TRACK_MIN). */
const TRACK_MIN = 6;
/** A random graph's walks of opens and folds, in steps. */
const WALK = 24;

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
      for (let j = i + 1; j < sibs.length; j++) if (!disjoint(ra, sibs[j]![1])) assert.fail(`${a} overlaps ${sibs[j]![0]} in ${scope}`);
    }
  }

  // Every column with parts has one frame (people, both groups, outside), which holds its
  // column's parts and no other, with its title's room above the first; no two frames touch.
  const root = L.scopes.get(input.root.id)!;
  const columns = new Set(input.root.parts.map((p) => p.column));
  assert.deepEqual(root.groups.map((g) => g.column).sort(), [...columns].sort(), "one frame per column with parts");
  for (const g of root.groups) {
    for (const p of input.root.parts) {
      const r = L.parts.get(p.id)!;
      if (p.column === g.column) assert.ok(!disjoint(r, g.rect) && r.x >= g.rect.x && r.x + r.w <= g.rect.x + g.rect.w && r.y >= g.rect.y && r.y + r.h <= g.rect.y + g.rect.h, `${p.id} sits outside the ${g.column} group`);
      else assert.ok(disjoint(r, g.rect), `${p.id} sits in the ${g.column} group`);
    }
    const first = Math.min(...input.root.parts.filter((p) => p.column === g.column).map((p) => L.parts.get(p.id)!.y));
    assert.ok(first - g.rect.y >= TOP_INSET - EPS, `the ${g.column} frame has no room for its title`);
    for (const h of root.groups) if (h !== g) assert.ok(g.rect.x + g.rect.w < h.rect.x - EPS || h.rect.x + h.rect.w < g.rect.x - EPS, `the ${g.column} and ${h.column} frames touch`);
  }

  // Both groups, and every frame's inside, packed from the top: in every column of each, the
  // first part sits at the top but for the room the levels routed above it take.
  // (The horizontals by y, each column's from the first at or below the band's top.)
  const horizontals = [...L.routes.values()].flatMap(segments).filter(flat).sort((a, b) => a[0].y - b[0].y);
  const packed = (what: string, top: number, ps: Placed[]) => {
    if (!ps.length) return;
    const columns = new Map<number, Placed[]>();
    for (const p of ps) {
      const col = columns.get(p.x);
      if (col) col.push(p);
      else columns.set(p.x, [p]);
    }
    let from = 0;
    for (let hi = horizontals.length; from < hi; ) {
      const m = (from + hi) >> 1;
      if (horizontals[m]![0].y <= top - 24 - EPS) from = m + 1;
      else hi = m;
    }
    const bands = [...columns.values()].map((col) => {
      const first = col.reduce((a, b) => (b.y < a.y ? b : a));
      const x1 = Math.max(...col.map((p) => p.x + p.w));
      const levels = new Set<number>();
      for (let i = from; i < horizontals.length && horizontals[i]![0].y < first.y; i++) {
        const [p, q] = horizontals[i]!;
        if (Math.min(p.x, q.x) < x1 && Math.max(p.x, q.x) > first.x) levels.add(p.y);
      }
      return { band: first.y - top, room: levels.size ? levels.size * LEVEL + 2 * CLEAR : 0 };
    });
    assert.ok(bands.every((b) => b.band <= b.room + EPS), `${what}: an empty band above (${bands.map((b) => `${b.band} px for ${b.room}`).join(", ")})`);
  };
  // (People and outside systems aren't packed: each column is pulled whole toward what it connects to.)
  for (const g of root.groups) {
    if (g.column !== "changed" && g.column !== "unchanged") continue;
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
  for (const e of parts)
    for (let b = Math.floor(e[1].x / 256); b <= Math.floor((e[1].x + e[1].w) / 256); b++) {
      const es = bands.get(b);
      if (es) es.push(e);
      else bands.set(b, [e]);
    }
  for (const [id, r] of L.routes) {
    const { scope, line } = lines.get(id)!;
    const ends = [line.from, line.to].flatMap((e) => (typeof e === "string" ? [e] : []));
    const inside = new Set([...ancestors(scope), ...ends.flatMap((e) => ancestors(L.parts.get(e)!.scope))]);
    for (const s of segments(r)) {
      const near = new Set<[string, Placed]>();
      for (let b = Math.floor(Math.min(s[0].x, s[1].x) / 256); b <= Math.floor(Math.max(s[0].x, s[1].x) / 256); b++) for (const e of bands.get(b) ?? []) near.add(e);
      for (const [pid, p] of near) if (!inside.has(pid) && through(s, p)) assert.fail(`${id} passes through ${pid}`);
    }
  }

  // Trunks exactly where lines share a stretch: each carries two or more, all along it, and no
  // two routes run together anywhere but on a trunk carrying both.
  const rides = new Map<string, Set<number>>();
  const stretches = new Map([...L.routes].map(([id, r]) => [id, segments(r).map(stretch)]));
  L.trunks.forEach((t, k) => {
    assert.ok(new Set(t.lines).size > 1, `${t.id} carries one line`);
    for (const s of segments(t.points)) for (const id of t.lines) if (!covers(stretches.get(id)!, s)) assert.fail(`${id} isn't on all of ${t.id}`);
    for (const id of t.lines) {
      const ks = rides.get(id);
      if (ks) ks.add(k);
      else rides.set(id, new Set([k]));
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
        let shared = false;
        const [ra, rb] = [rides.get(a.id), rides.get(b.id)];
        if (ra && rb)
          for (const t of ra.size < rb.size ? ra : rb)
            if ((ra.size < rb.size ? rb : ra).has(t) && trunkStretches[t]!.some((s) => s.h === a.h && Math.abs(s.at - a.at) < NEAR && Math.min(s.hi, hi) - Math.max(s.lo, lo) > 0)) {
              shared = true;
              break;
            }
        if (!shared) assert.fail(`${a.id} and ${b.id} run together at ${a.h ? "y" : "x"} ${a.at} from ${lo} to ${hi} on no trunk`);
      }
  // Two verticals side by side on different tracks sit at least TRACK_MIN apart.
  const verticals = all.filter((s) => !s.h);
  for (const [i, a] of verticals.entries())
    for (let j = i + 1; j < verticals.length && verticals[j]!.at - a.at < TRACK_MIN - EPS; j++) {
      const b = verticals[j]!;
      if (a.id === b.id || b.at - a.at < EPS || Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) < 1) continue;
      assert.fail(`${a.id} and ${b.id} run side by side ${b.at - a.at} px apart at x ${a.at}, from ${Math.max(a.lo, b.lo)} to ${Math.min(a.hi, b.hi)}`);
    }
}

/** `b` is exactly `a`: every part, route and trunk, every scope's rectangle and group frames, and the size. */
function same(a: Layout, b: Layout, what: string) {
  assert.deepEqual([...b.parts.keys()].sort(), [...a.parts.keys()].sort(), `${what}: the same parts`);
  for (const [id, p] of a.parts) assert.deepEqual(b.parts.get(id), p, `${what}: ${id} moved`);
  assert.deepEqual([...b.routes.keys()].sort(), [...a.routes.keys()].sort(), `${what}: the same lines`);
  for (const [id, r] of a.routes) assert.deepEqual(b.routes.get(id), r, `${what}: ${id}'s route changed`);
  assert.equal(b.trunks.length, a.trunks.length, `${what}: the same number of trunks`);
  a.trunks.forEach((t, i) => assert.deepEqual(b.trunks[i], t, `${what}: trunk ${t.id} changed`));
  assert.deepEqual([...b.scopes.keys()].sort(), [...a.scopes.keys()].sort(), `${what}: the same scopes`);
  for (const [id, s] of a.scopes) assert.deepEqual(b.scopes.get(id), s, `${what}: scope ${id}'s rectangle or group frames changed`);
  assert.deepEqual([b.width, b.height], [a.width, a.height], `${what}: the drawing's size changed`);
}

/** Each scope's folded drawing (its anchors), by graph, view and the blocks on the way down to it. */
const foldedDrawings = new WeakMap<DrawableGraph, Map<string, Layout>>();
function foldedOf(g: DrawableGraph, view: Omit<View, "open">, way: readonly string[]): Layout {
  let m = foldedDrawings.get(g);
  if (!m) foldedDrawings.set(g, (m = new Map()));
  const key = JSON.stringify([!!view.boxes, !!view.showLonely, way]);
  let L = m.get(key);
  if (!L) {
    const blocks = blocksOf(g);
    m.set(key, (L = layout(layoutInput(g, { ...view, open: new Set(way.filter((id) => blocks.has(id))) }).input)));
  }
  return L;
}

/**
 * Opening (or folding) `block` moved only what it pushes. In each scope on the way down to it
 * (`[scope, the child on the way]`, boxes included):
 * - y: parts below the child in its column move only down on an open (up on a fold); every other
 *   part keeps its y;
 * - x: a column's parts move alike, and every column keeps its width but the child's, which only
 *   widens on an open (narrows on a fold). Every line keeps the levels the scope's folded drawing
 *   routed it on, moved down with its column's parts, so only the child's column moves anything
 *   up or down, and only the two gutters beside it (for a frame's first column, the gutter from
 *   its left ports) get other verticals: every other gutter keeps its width exactly. Those two are
 *   never narrower than in the folded drawing (their anchors), and a change leaves them wider than
 *   that in one of the two drawings: as wide as their tracks need, compressed down to 6 px apart.
 *   So the columns left of the child's keep their places, and every column right of it moves by
 *   the same amount: the child column's change of width, and those two gutters'.
 * Scopes off the way don't change. The two gutters' tracks depend on how far both their columns'
 * parts are pushed: opening a block can line its column's ends back up with the next column's
 * (pushed by an earlier open), and the gutter then needs fewer tracks than it had. Returns how far
 * a column right of the child moved against the change for that, at most (px), which is never
 * more than the two gutters were wider than their anchors.
 */
function pushedOnly(g: DrawableGraph, view: Omit<View, "open">, before: Layout, after: Layout, block: string, opening: boolean, what: string) {
  const path = wayTo(before, block);
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
      if (!on.has(id) && !path.some(([, c]) => c === id) && (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h)) assert.deepEqual(a, b, `${what}: ${id} changed in a scope off the way`);
      continue;
    }
    const c = rel(before, step[1]);
    if (Math.abs(b.x - c.x) < EPS && b.y > c.y) {
      if (!way(a.y - b.y)) assert.fail(`${what}: ${id}, below ${step[1]}, moved the wrong way`);
    } else if (a.y !== b.y) assert.equal(a.y, b.y, `${what}: ${id} moved up or down`);
  }
  let against = 0;
  path.forEach(([scope, child], i) => {
    const folded = foldedOf(g, view, path.slice(0, i).map(([, c]) => c));
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
    cols.forEach((_, k) => {
      if (k === k0) assert.ok(way(a[k]!.w - b[k]!.w), `${what}: ${child}'s column changed width the wrong way`);
      else assert.equal(a[k]!.w, b[k]!.w, `${what}: a column of ${scope} changed width`);
    });
    // Gutter j runs right of column j; gutter -1 is the room left of the first column (none right of the last).
    const gap = (m: typeof b, j: number) => (j < 0 ? m[0]!.x : j + 1 < m.length ? m[j + 1]!.x - m[j]!.x - m[j]!.w : 0);
    let room = 0;
    for (let j = -1; j + 1 < cols.length; j++) {
      const [gb, ga, gf] = [gap(b, j), gap(a, j), gap(f, j)];
      const name = `${what}: the gutter ${j < 0 ? `left of ${cols[0]![0]}` : `right of ${cols[j]![0]}`} in ${scope}`;
      if (j !== k0 - 1 && j !== k0) {
        assert.equal(ga, gb, `${name} changed: only the two beside ${child}'s column may`);
        continue;
      }
      assert.ok(Math.min(gb, ga) >= gf - 1e-6, `${name} is narrower than its anchor`);
      if (Math.abs(gb - ga) > 1e-6) assert.ok(Math.max(gb, ga) > gf + 1e-6, `${name} changed at its anchor's width`);
      room += Math.max(gb, ga) - gf;
    }
    const by = a[k0]!.x - b[k0]!.x + a[k0]!.w - b[k0]!.w + gap(a, k0) - gap(b, k0);
    cols.forEach((_, k) => {
      const d = a[k]!.x - b[k]!.x;
      if (k < k0) assert.equal(d, 0, `${what}: a column of ${scope} left of ${child}'s moved`);
      if (k <= k0) return;
      assert.ok(Math.abs(d - by) < 1e-6, `${what}: a column of ${scope} right of ${child}'s moved ${d}, not ${by}`);
    });
    if (k0 + 1 < cols.length && !way(by)) {
      assert.ok(Math.abs(by) <= room + 1e-6, `${what}: the columns of ${scope} right of ${child}'s moved against the change by more than its gutters gave back`);
      against = Math.max(against, Math.abs(by));
    }
  });
  return against;
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

/** The chain of [scope, child] pairs from the drawing down to `block` in `L` (boxes included). */
function wayTo(L: Layout, block: string): [string, string][] {
  const out: [string, string][] = [];
  for (let id = block; L.parts.has(id); id = L.parts.get(id)!.scope) out.unshift([L.parts.get(id)!.scope, id]);
  return out;
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
  const moved = { steps: 0, against: 0, most: 0 };
  return {
    get open(): ReadonlySet<string> {
      return open;
    },
    /** The blocks drawn now, open or not. */
    drawn: () => [...L.parts.keys()].filter((id) => blocks.has(id)).sort(),
    /** How many steps moved columns right of the changed block against the change, and how far at most (px). */
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
      const back = pushedOnly(g, view, L, after, block, opening, what);
      (moved.steps += 1), (moved.against += +(back > 0)), (moved.most = Math.max(moved.most, back));
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
      pushedOnly(g, {}, top.L, opened.L, block, true, `opening ${block}`);
      same(top.L, run({ open: new Set() }, opened.L).L, `folding ${block}`);
    },
    /** Folds the deepest block from fully open, then opens it again. */
    foldDeep() {
      const full = run({ open: blocks }).L;
      const deep = [...blocks].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1))[0];
      if (!deep || depth(deep) < 1) return;
      const folded = run({ open: new Set([...blocks].filter((b) => b !== deep)) }, full);
      checkRules(folded.L, folded.input);
      pushedOnly(g, {}, full, folded.L, deep, false, `folding ${deep}`);
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
    // Every step moved the columns right of the block by its column's change of width and the two
    // gutters' beside it (pushedOnly). Only those gutters giving back room they took for an earlier
    // open can move them against the change: no step of this walk (or the random graphs') does.
    // (Longer walks find a few: 300 steps from seeds 11 and 12 have 3 and 1, up to 28.5 px.)
    c.diagnostic(`${s.moved.steps} steps: ${s.moved.against} moved columns right of the block against the change, at most ${s.moved.most} px`);
    assert.equal(s.moved.against, 0, `${s.moved.against} steps moved columns against the change, up to ${s.moved.most} px`);
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
    it(`keeps every rule on random walks of opens and folds at seed ${seed}, boxes on and off, and comes back exactly`, () => {
      for (const view of [{}, { boxes: true }]) {
        const s = session(g, view);
        const r = rng(seed);
        for (let i = 0; i < WALK; i++) {
          const drawn = s.drawn();
          s.toggle(drawn[Math.floor(r() * drawn.length)]!);
        }
        assert.equal(s.moved.against, 0, `${JSON.stringify(view)}: ${s.moved.against} steps moved columns against the change, up to ${s.moved.most} px`);
      }
    });
  }
});

describe("our layout with a column for code only a conflict reaches (the fold's, #183)", () => {
  // Every fourth top-level part in the fifth column: it gets its own frame, right of the others,
  // and every rule holds, fresh and laid out again from its own answer.
  for (const seed of [1, 2, 3]) {
    it(`keeps the rules at seed ${seed}`, () => {
      const g = randomGraph(seed, 60);
      const tops = g.nodes.filter((n) => n.parent === "sys");
      const conflict = new Set(tops.filter((_, i) => i % 4 === 3).map((n) => n.id));
      const column = (n: DrawableNode) => (conflict.has(n.id) ? ("conflict" as const) : undefined);
      for (const open of [new Set<string>(), blocksOf(g)]) {
        const { input } = layoutInput(g, { open, showLonely: true, column });
        const L = layout(input);
        checkRules(L, input);
        const frames = L.scopes.get(input.root.id)!.groups;
        const own = frames.find((f) => f.column === "conflict")!;
        assert.ok(own, "the conflict column has its frame");
        for (const f of frames) if (f !== own) assert.ok(f.rect.x + f.rect.w < own.rect.x, `the ${f.column} frame isn't left of the conflict column's`);
        same(L, layout(layoutInput(g, { open, showLonely: true, column }, L).input), "from itself");
      }
    });
    it(`keeps every rule on a random walk of opens and folds at seed ${seed}, each from its anchors, and comes back exactly`, (c) => {
      const g = randomGraph(seed, 60);
      const tops = g.nodes.filter((n) => n.parent === "sys");
      const conflict = new Set(tops.filter((_, i) => i % 4 === 3).map((n) => n.id));
      const column = (n: DrawableNode) => (conflict.has(n.id) ? ("conflict" as const) : undefined);
      const s = session(g, { showLonely: true, column });
      const r = rng(seed + 183);
      let inConflict = 0;
      for (let i = 0; i < WALK; i++) {
        const drawn = s.drawn();
        const b = drawn[Math.floor(r() * drawn.length)]!;
        if ([b, ...chainOf(g, b)].some((x) => conflict.has(x))) inConflict++;
        s.toggle(b);
      }
      assert.ok(inConflict > 0, "the walk opens or folds a block in the conflict column");
      // Every step moved columns right of the block only as pushedOnly allows: by the change, or
      // against it by no more than the gutters beside it gave back. Seed 1's walk has one such
      // step, 0.5 px; the other walks none.
      c.diagnostic(`${s.moved.steps} steps: ${s.moved.against} moved columns right of the block against the change, at most ${s.moved.most} px`);
    });
  }
});

describe("our layout from its own answer", () => {
  // A drawing's anchors are the drawing: laid out again from them, it comes back exactly. On
  // random graphs of 40 to 160 nodes, at the top level and fully open, boxes on and off. (Before
  // the anchors kept the room the drawing was placed with, seeds 2, 5 and 6 moved parts.)
  for (let seed = 0; seed < 8; seed++) {
    const n = 40 + ((seed * 37) % 121);
    it(`at seed ${seed} (${n} nodes)`, () => {
      const g = randomGraph(seed, n);
      const t = openAndFold(g);
      for (const view of [{ open: new Set<string>() }, { open: new Set<string>(), boxes: true }, { open: t.blocks }, { open: t.blocks, boxes: true }]) {
        const fresh = t.run(view).L;
        same(fresh, t.run(view, fresh).L, `${JSON.stringify({ ...view, open: view.open.size })} from itself`);
      }
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

  it("draws a folded column or box as one block, its lines rolled up to it and summed, and keeps the rules", () => {
    const g = graph("1x");
    const { input: top } = layoutInput(g, { open: new Set() });
    const changed = top.root.parts.filter((p) => p.column === "changed").map((p) => p.id);
    const folded = layoutInput(g, { open: new Set(), folded: new Set([columnGroup("changed")]) });
    const L = layout(folded.input);
    checkRules(L, folded.input);
    // One block stands for the changed column: none of its parts is drawn, and it holds them all.
    assert.deepEqual(folded.input.root.parts.filter((p) => p.column === "changed").map((p) => p.id), [columnGroup("changed")]);
    for (const id of changed) assert.ok(!L.parts.has(id), `${id} is drawn inside a folded column`);
    for (const id of changed) assert.ok(folded.groups.get(columnGroup("changed"))!.includes(id), `the folded column stands for ${id}`);
    // Every analysis line with one end inside it and the other outside is on one of its lines; none between its own parts.
    const inside = new Set<string>();
    for (const m of folded.groups.get(columnGroup("changed"))!) for (const n of g.nodes) if (n.id === m || chainOf(g, n.id).includes(m)) inside.add(n.id);
    for (const e of g.edges) {
      const ends = [inside.has(e.from), inside.has(e.to)];
      const drawn = folded.drawnAs.get(e.id) ?? [];
      if (ends[0] && ends[1]) assert.deepEqual(drawn, [], `${e.id} runs inside the folded column`);
    }
    const count = folded.input.root.lines.filter((l) => l.from === columnGroup("changed") || l.to === columnGroup("changed")).reduce((n, l) => n + l.count, 0);
    assert.equal(count, g.edges.filter((e) => inside.has(e.from) !== inside.has(e.to) && !isSystem(g, e.from) && !isSystem(g, e.to)).length, "the folded column's lines carry every line in or out of it");

    // A folded box likewise, its column's other parts drawn as they were.
    const boxOf = (n: DrawableNode, column: string) => (column === "changed" ? `box:${n.paths[0]?.split("/")[0] ?? ""}` : undefined);
    const boxed = layoutInput(g, { open: new Set(), boxes: boxOf });
    checkRules(layout(boxed.input), boxed.input);
    const [box, ps] = [...boxed.boxes].sort((a, b) => b[1].length - a[1].length)[0]!;
    const shut = layoutInput(g, { open: new Set(), boxes: boxOf, folded: new Set([box]) });
    const S = layout(shut.input);
    checkRules(S, shut.input);
    assert.ok(S.parts.has(box) && !S.parts.get(box)!.box, "the folded box is a closed block");
    for (const id of ps) assert.ok(!S.parts.has(id), `${id} is drawn inside a folded box`);
    assert.ok(!shut.boxes.has(box));
  });

  it("draws a Boxes picker's box of one part, and every box's parts share a column", () => {
    const g: DrawableGraph = {
      nodes: [node("sys", undefined, "system"), node("a"), node("b"), node("c"), node("d"), node("x", undefined, "external")],
      edges: [edge("a", "b"), edge("c", "d"), edge("a", "x"), edge("d", "x")],
      facets: [],
    };
    const { input, boxes } = layoutInput(g, { open: new Set(), boxes: (n) => (n.id === "x" ? "box:outside" : n.id === "a" ? "box:one" : "box:many") });
    const L = layout(input);
    checkRules(L, input);
    assert.deepEqual(boxes.get("box:one"), ["a"]);
    assert.deepEqual(boxes.get("box:outside"), ["x"]);
    for (const [id, ps] of boxes) for (const p of ps) assert.equal(L.parts.get(p)!.scope, id, `${p} is drawn in ${id}`);
  });

  it("puts each drawn line's arrowheads where its lines point, both ends for both ways", () => {
    const g: DrawableGraph = {
      nodes: [node("sys", undefined, "system"), node("a"), node("b"), node("c"), node("d", "c"), node("e", "c")],
      edges: [edge("a", "b"), { ...edge("b", "a"), id: "back" }, edge("a", "d"), edge("e", "a")],
      facets: [],
    };
    const fwd = layoutInput(g, { open: new Set() });
    const ab = JSON.stringify(["a", "b"]);
    assert.deepEqual(fwd.heads.get(ab), { to: true, from: true });
    assert.ok(fwd.both.has(ab));
    // a → d and e → a roll up to one line between a and c, each way.
    assert.deepEqual(fwd.heads.get(JSON.stringify(["a", "c"])), { to: true, from: true });
    // Read back (the data's direction): a → d points at a; inside the open c, its piece too.
    const back = layoutInput(g, { open: new Set(["c"]), direction: (e) => (e.id === "a->d" ? "back" : "forward") });
    const ad = back.drawnAs.get("a->d")!;
    assert.equal(ad.length, 2);
    for (const id of ad) assert.deepEqual(back.heads.get(id), { to: false, from: true }, id);
    checkRules(layout(back.input), back.input);
  });
});

/** `id`'s ancestors in `g`, nearest first. */
function chainOf(g: DrawableGraph, id: string): string[] {
  const out: string[] = [];
  for (let p = g.nodes.find((n) => n.id === id)?.parent; p !== undefined && !out.includes(p); p = g.nodes.find((n) => n.id === p)?.parent) out.push(p);
  return out;
}

const isSystem = (g: DrawableGraph, id: string) => g.nodes.find((n) => n.id === id)?.kind === "system";
