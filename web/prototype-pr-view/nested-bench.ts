// PROTOTYPE (PR view, #166): times our nested layout outside the browser, and counts what moves
// when a block opens. Run: node web/prototype-pr-view/nested-bench.ts [name] [times]
import { readFileSync } from "node:fs";
import { measure } from "./own-layout.ts";
import { nestedLayout, type Nested } from "./nested-layout.ts";
import { grow, input } from "./nested-input.ts";
import type { Analysis } from "./schema.ts";

const here = new URL(".", import.meta.url).pathname;
const name = process.argv[2] ?? "AdvanGrid-advangrid-2627";
const times = Number(process.argv[3] ?? 1);
const a = JSON.parse(readFileSync(`${here}data/${name}.json`, "utf8")) as Analysis;
try {
  a.edges.push(...JSON.parse(readFileSync(`${here}data/overlays/${name}.json`, "utf8")).edges);
} catch {}
const inp = input(grow(a, times));
const blocks = inp.nodes.filter((n) => inp.kids.get(n.id)?.length).map((n) => n.id);
const o = { mode: "street" as const, labelRoom: 30, aspect: Number(process.env.ASPECT ?? 1.6) || undefined };
const run = (open: Set<string>, prev?: Nested) => {
  const t0 = performance.now();
  const n = nestedLayout(inp.nodes, inp.links, open, o, prev);
  return { n, ms: performance.now() - t0 };
};
const show = (label: string, r: { n: Nested; ms: number }) => {
  const m = measure(r.n.routes, r.n.rides);
  console.log(`${label}: ${r.ms.toFixed(0)} ms, ${r.n.ms.scopes} scopes, ${r.n.boxes.size} boxes, ${Math.round(r.n.width)}×${Math.round(r.n.height)}, ${m.crossings} crossings, ${m.bends} bends, ${r.n.trunks.length} trunks`);
};
console.log(`${inp.nodes.length} parts, ${inp.links.length} lines, ${blocks.length} blocks`);
for (let i = 0; i < 2; i++) show("top level", run(new Set()));
for (let i = 0; i < 2; i++) show("fully open", run(new Set(blocks)));

// Stability: open each top-level block alone, from the top level, with and without keeping.
const ancestors = (id: string): string[] => {
  const p = inp.info.get(id)?.parent;
  return p && inp.info.has(p) ? [p, ...ancestors(p)] : [];
};
for (const keep of [false, true]) {
  const base = run(new Set());
  let ys = 0, xs = 0, n = 0, tot = 0;
  const tops = blocks.filter((b) => !inp.nodes.find((x) => x.id === b)!.parent && base.n.boxes.has(b));
  for (const b of tops) {
    const r = run(new Set([b]), keep ? base.n : undefined);
    for (const [id, p] of base.n.boxes) {
      if (id === b) continue;
      const q = r.n.boxes.get(id)!;
      tot++;
      if (Math.abs(p.y - q.y) > 1) ys++;
      else if (Math.abs(p.x - q.x) > 1) xs++;
    }
    n++;
  }
  console.log(`open one top-level block (${n} tried), ${keep ? "keeping" : "fresh"}: of ${tot} part-positions, ${ys} moved up/down, ${xs} sideways only`);
}
// Deep: from fully open, fold and reopen one deep block.
{
  const full = run(new Set(blocks));
  const deep = blocks.filter((b) => ancestors(b).length >= 2);
  let ys = 0, xs = 0, tot = 0;
  for (const b of deep) {
    const without = new Set(blocks.filter((x) => x !== b && !ancestors(x).includes(b)));
    const r = run(without, full.n);
    for (const [id, p] of full.n.boxes) {
      if (id === b || ancestors(id).includes(b) || !r.n.boxes.has(id)) continue;
      const q = r.n.boxes.get(id)!;
      tot++;
      if (Math.abs(p.y - q.y) > 1) ys++;
      else if (Math.abs(p.x - q.x) > 1) xs++;
    }
  }
  console.log(`fold one deep block from fully open (${deep.length} tried), keeping: of ${tot} part-positions, ${ys} moved up/down, ${xs} sideways only`);
}
