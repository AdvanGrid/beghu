// The layout suite (#180): our layout (web/src/pr-view/layout/), pure TypeScript, run in Node on
// the committed synthetic graph (fixtures/pr-view/layout/, cut from the tiler's output: #2627's
// shape at 1×, and 3×), at the top level and fully open. No stack: the engine is a function.
//
// Each drawing is timed from the drawable graph to coordinates (the adapter's roll-up and the
// engine, as the view runs them on every open and fold), and its crossings and area counted, so
// a change that makes the drawing worse fails the way a slower one does.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Probe } from "./suite.ts";

export interface P {
  x: number;
  y: number;
}

/** What the suite reads of a layout (web/src/pr-view/layout/types.ts, `Layout`). */
export interface Drawing {
  routes: Map<string, P[]>;
  trunks: { id: string; lines: string[] }[];
  width: number;
  height: number;
}

/** The engine's two entry points, as a tree has them. */
interface Engine {
  layout(input: unknown): Drawing;
  layoutInput(graph: unknown, view: { open: ReadonlySet<string> }): { input: unknown };
}

/** The four drawings: a probe each, named as its gates' prefix. */
export const DRAWINGS = [
  { name: "layout.top", scale: "1x", open: false },
  { name: "layout.open", scale: "1x", open: true },
  { name: "layout.top-3x", scale: "3x", open: false },
  { name: "layout.open-3x", scale: "3x", open: true },
] as const;

const ENGINE = "web/src/pr-view/layout";
const GRAPHS = "fixtures/pr-view/layout";

/**
 * The crossings in a drawing, counted as the prototypes counted them (#163): a horizontal stretch
 * of one line crossing a vertical stretch of another, once per point (lines on one trunk overlap,
 * so a line crossing a trunk crosses it once), and never between two lines that share a trunk.
 */
export function crossings(d: Pick<Drawing, "routes" | "trunks">): number {
  type S = { line: string; a: number; b: number; at: number };
  const hs: S[] = [], vs: S[] = [];
  for (const [line, pts] of d.routes)
    for (let i = 0; i + 1 < pts.length; i++) {
      const [p, q] = [pts[i]!, pts[i + 1]!];
      if (Math.abs(p.y - q.y) < 0.5) hs.push({ line, a: Math.min(p.x, q.x), b: Math.max(p.x, q.x), at: p.y });
      else if (Math.abs(p.x - q.x) < 0.5) vs.push({ line, a: Math.min(p.y, q.y), b: Math.max(p.y, q.y), at: p.x });
    }
  const rides = new Map<string, Set<string>>();
  for (const t of d.trunks) for (const l of t.lines) rides.set(l, (rides.get(l) ?? new Set()).add(t.id));
  const share = (a: string, b: string) => {
    const [x, y] = [rides.get(a), rides.get(b)];
    if (!x || !y) return false;
    for (const t of x) if (y.has(t)) return true;
    return false;
  };
  vs.sort((p, q) => p.at - q.at);
  const seen = new Set<string>();
  for (const h of hs) {
    // The first vertical right of the horizontal's start.
    let lo = 0, hi = vs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (vs[m]!.at <= h.a + 0.5) lo = m + 1;
      else hi = m;
    }
    for (let i = lo; i < vs.length && vs[i]!.at < h.b - 0.5; i++) {
      const v = vs[i]!;
      if (v.line === h.line || !(h.at > v.a + 0.5 && h.at < v.b - 0.5) || share(h.line, v.line)) continue;
      seen.add(`${Math.round(v.at)}|${Math.round(h.at)}`);
    }
  }
  return seen.size;
}

/** The drawing's area (px²). */
export const area = (d: Pick<Drawing, "width" | "height">) => Math.round(d.width * d.height);

/** The layout probes of the tree at `root`, or null when it has no engine or graphs (an older main). */
export async function layoutProbes(root: string): Promise<Probe[] | null> {
  const files = ["layout.ts", "graph.ts"].map((f) => join(root, ENGINE, f));
  const graphs = new Map(["1x", "3x"].map((s) => [s, join(root, GRAPHS, `tiled-${s}.json`)]));
  if (![...files, ...graphs.values()].every((f) => existsSync(f))) return null;
  const [{ layout }, { layoutInput }] = (await Promise.all(files.map((f) => import(pathToFileURL(f).href)))) as [Pick<Engine, "layout">, Pick<Engine, "layoutInput">];
  return DRAWINGS.map(({ name, scale, open }) => {
    const graph = JSON.parse(readFileSync(graphs.get(scale)!, "utf8")) as { nodes: { id: string; parent?: string; kind: string }[] };
    const parents = new Set(graph.nodes.map((n) => n.parent));
    const blocks = new Set(open ? graph.nodes.filter((n) => n.kind !== "system" && parents.has(n.id)).map((n) => n.id) : []);
    let counts: { crossings: number; area: number } | undefined;
    return {
      name,
      gates: [`${name}.ms`, `${name}.crossings`, `${name}.area`],
      async sample() {
        const t0 = performance.now();
        const d = layout(layoutInput(graph, { open: blocks }).input);
        const ms = performance.now() - t0;
        // The same every time on the fixed graph: counted once.
        counts ??= { crossings: crossings(d), area: area(d) };
        return { values: { [`${name}.ms`]: ms, [`${name}.crossings`]: counts.crossings, [`${name}.area`]: counts.area } };
      },
    };
  });
}
