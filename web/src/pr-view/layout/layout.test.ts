// Our layout's rules (#144, #163, #166, #180), checked on the layout suite's committed synthetic
// graph (fixtures/pr-view/layout/: #2627's shape at 1×, and 3×) through the engine's own seam:
// graph in, coordinates out. An exception to "tests go through public seams" (AGENTS.md): the
// rules are geometry no HTTP answer or page shows. Whether the drawing reads well is the browser
// suite's and the owner's; how big, crossed and fast it is, the `layout` perf suite's.
// `npm run test:lint`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { layoutInput, type DrawableGraph, type View } from "./graph.ts";
import { layout } from "./layout.ts";
import type { Layout, LayoutInput, P, Placed, Rect, Scope } from "./types.ts";

const graph = (scale: string) => JSON.parse(readFileSync(new URL(`../../../../fixtures/pr-view/layout/tiled-${scale}.json`, import.meta.url), "utf8")) as DrawableGraph;
const blocksOf = (g: DrawableGraph) => new Set(g.nodes.filter((n) => n.kind !== "system" && g.nodes.some((m) => m.parent === n.id)).map((n) => n.id));

/** The engine's padding round a scope, and where a scope's first part may start below its top. */
const PAD = 24;
const TOP_INSET = 44;
const EPS = 0.5;

/** Each input line's scope and the parts its ends are (a port's end is its frame). */
function linesOf(input: LayoutInput) {
  const out = new Map<string, { scope: string; ends: string[] }>();
  const walk = (s: Scope) => {
    for (const l of s.lines) out.set(l.id, { scope: s.id, ends: [l.from, l.to].map((e) => (typeof e === "string" ? e : s.id)) });
    for (const p of s.parts) if (p.frame) walk(p.frame);
  };
  walk(input.root);
  return out;
}

const segments = (pts: P[]) => pts.slice(1).map((q, i) => [pts[i]!, q] as const);
/** Whether a segment passes through the inside of a rectangle (touching its edge is fine). */
const through = ([a, b]: readonly [P, P], r: Rect) =>
  Math.max(a.x, b.x) > r.x + EPS && Math.min(a.x, b.x) < r.x + r.w - EPS && Math.max(a.y, b.y) > r.y + EPS && Math.min(a.y, b.y) < r.y + r.h - EPS;
const disjoint = (a: Rect, b: Rect) => a.x + a.w <= b.x + EPS || b.x + b.w <= a.x + EPS || a.y + a.h <= b.y + EPS || b.y + b.h <= a.y + EPS;

/** Whether `route` runs along all of the straight stretch from `a` to `b`. */
function covers(route: P[], [a, b]: readonly [P, P]): boolean {
  const flat = Math.abs(a.y - b.y) < EPS;
  const [lo, hi] = flat ? [Math.min(a.x, b.x), Math.max(a.x, b.x)] : [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  const on = segments(route)
    .filter(([p, q]) => (flat ? Math.abs(p.y - a.y) < EPS && Math.abs(q.y - a.y) < EPS : Math.abs(p.x - a.x) < EPS && Math.abs(q.x - a.x) < EPS))
    .map(([p, q]) => (flat ? [Math.min(p.x, q.x), Math.max(p.x, q.x)] : [Math.min(p.y, q.y), Math.max(p.y, q.y)]))
    .sort((x, y) => x[0]! - y[0]!);
  let reached = lo;
  for (const [s, e] of on) if (s! <= reached + EPS) reached = Math.max(reached, e!);
  return reached >= hi - EPS;
}

/** Every rule the drawing must keep, whatever is open. */
function checkRules(L: Layout, input: LayoutInput) {
  const parts = [...L.parts];
  const ancestors = (scope: string): string[] => {
    const out: string[] = [];
    for (let s: string | undefined = scope; s !== undefined && L.parts.has(s); s = L.parts.get(s)!.scope) out.push(s);
    return out;
  };

  // No two parts or frames overlap, and each sits inside its frame.
  const byScope = new Map<string, [string, Placed][]>();
  for (const e of parts) byScope.set(e[1].scope, [...(byScope.get(e[1].scope) ?? []), e]);
  for (const [scope, sibs] of byScope) {
    const frame = L.scopes.get(scope)!.rect;
    for (let i = 0; i < sibs.length; i++) {
      const [a, ra] = sibs[i]!;
      assert.ok(ra.x >= frame.x - EPS && ra.y >= frame.y - EPS && ra.x + ra.w <= frame.x + frame.w + EPS && ra.y + ra.h <= frame.y + frame.h + EPS, `${a} sits outside ${scope}`);
      for (let j = i + 1; j < sibs.length; j++) assert.ok(disjoint(ra, sibs[j]![1]), `${a} overlaps ${sibs[j]![0]} in ${scope}`);
    }
  }

  // Both groups, and every frame's inside, packed from the top: the group frames start at the
  // drawing's top, and above a group's highest part there's nothing but the lines routed there.
  const root = L.scopes.get(input.root.id)!;
  assert.ok(root.groups.length > 0);
  const horizontals = [...L.routes.values()].flatMap(segments).filter(([p, q]) => Math.abs(p.y - q.y) < EPS);
  const packed = (what: string, top: number, ps: Placed[]) => {
    if (!ps.length) return;
    const first = ps.reduce((a, b) => (b.y < a.y ? b : a));
    const band = horizontals.some(([p, q]) => p.y > top - EPS && p.y < first.y && Math.min(p.x, q.x) < first.x + first.w && Math.max(p.x, q.x) > first.x);
    assert.ok(Math.abs(first.y - top) < EPS || band, `${what}: an empty band above ${first.y - top} px`);
  };
  for (const g of root.groups) {
    assert.equal(g.rect.y, PAD, `the ${g.column} group starts at the top`);
    packed(`the ${g.column} group`, g.rect.y + TOP_INSET, parts.filter(([, p]) => p.scope === input.root.id && p.x >= g.rect.x && p.x + p.w <= g.rect.x + g.rect.w).map(([, p]) => p));
  }
  for (const [scope, sibs] of byScope) if (scope !== input.root.id) packed(scope, L.scopes.get(scope)!.rect.y + TOP_INSET, sibs.map(([, p]) => p));

  // Every line laid one way: a route never turns back on itself left to right.
  for (const [id, r] of L.routes) {
    const dx = segments(r).map(([p, q]) => Math.sign(Math.round(q.x - p.x)));
    assert.ok(!(dx.includes(1) && dx.includes(-1)), `${id} runs both ways`);
    for (const [p, q] of segments(r)) assert.ok(Math.abs(p.x - q.x) < EPS || Math.abs(p.y - q.y) < EPS, `${id} isn't orthogonal`);
  }

  // No line passes through a part: only through the frames and boxes it's drawn inside.
  const lines = linesOf(input);
  for (const [id, r] of L.routes) {
    const l = lines.get(id)!;
    const inside = new Set([...ancestors(l.scope), ...l.ends.flatMap((e) => (e === l.scope ? [] : ancestors(L.parts.get(e)!.scope)))]);
    for (const s of segments(r)) for (const [pid, p] of parts) if (!inside.has(pid)) assert.ok(!through(s, p), `${id} passes through ${pid}`);
  }

  // Trunks only where lines share a stretch: each carries two or more, all along it.
  for (const t of L.trunks) {
    assert.ok(new Set(t.lines).size > 1, `${t.id} carries one line`);
    for (const s of segments(t.points)) for (const id of t.lines) assert.ok(covers(L.routes.get(id)!, s), `${id} isn't on all of ${t.id}`);
  }
}

/** Every part's rectangle in `a` is the same in `b`. */
function samePlaces(a: Layout, b: Layout, what: string) {
  for (const [id, p] of a.parts) {
    const q = b.parts.get(id);
    assert.ok(q, `${what}: ${id} is gone`);
    for (const k of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(p[k] - q[k]) < 0.01, `${what}: ${id}'s ${k} went from ${p[k]} to ${q[k]}`);
  }
}

for (const scale of ["1x", "3x"]) {
  describe(`our layout at ${scale}`, () => {
    const g = graph(scale);
    const blocks = blocksOf(g);
    const run = (view: View, previous?: Layout) => {
      const { input } = layoutInput(g, view, previous);
      return { input, L: layout(input) };
    };

    it("keeps the rules at the top level", () => {
      const { input, L } = run({ open: new Set() });
      checkRules(L, input);
    });

    it("keeps the rules fully open", () => {
      const { input, L } = run({ open: blocks });
      assert.ok([...L.parts.values()].some((p) => p.frame && p.scope !== input.root.id), "blocks open inside blocks");
      checkRules(L, input);
    });

    it("keeps the rules with boxes", () => {
      const { input, L } = run({ open: new Set(), boxes: true });
      assert.ok([...L.parts.values()].some((p) => p.box));
      checkRules(L, input);
    });

    it("moves only what an opened block pushes, and puts it back when it folds", () => {
      const top = run({ open: new Set() }).L;
      // The top-level block with the most inside.
      const kids = (id: string): number => g.nodes.filter((n) => n.parent === id).reduce((s, n) => s + 1 + kids(n.id), 0);
      const block = [...blocks].filter((b) => top.parts.has(b)).sort((a, b) => kids(b) - kids(a))[0]!;
      const opened = run({ open: new Set([block]) }, top);
      checkRules(opened.L, opened.input);
      for (const [id, p] of top.parts) assert.ok(opened.L.parts.get(id)!.y >= p.y - 0.01, `opening ${block} moved ${id} up`);
      samePlaces(top, run({ open: new Set() }, opened.L).L, `folding ${block}`);
    });

    it("folds a deep block from fully open and opens it back to where it was", () => {
      const full = run({ open: blocks }).L;
      const depth = (id: string): number => {
        const p = g.nodes.find((n) => n.id === id)!.parent;
        return p && blocks.has(p) ? 1 + depth(p) : 0;
      };
      const deep = [...blocks].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1))[0]!;
      assert.ok(depth(deep) >= 1);
      const folded = run({ open: new Set([...blocks].filter((b) => b !== deep)) }, full);
      checkRules(folded.L, folded.input);
      samePlaces(full, run({ open: blocks }, folded.L).L, `reopening ${deep}`);
    });
  });
}
