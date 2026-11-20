// PROTOTYPE (PR view, #163): writes made-up call lines over an analysis, to see the layouts at the
// density "Decide what the agent must draw in the graph" (#156) expects: every direct connection
// between top-level parts, unchanged ↔ unchanged included, about 70–100 more top-level lines on
// #2627 than the re-run drew. Nothing here is from the code or the agent. Seeded, so every run
// writes the same lines.
// Run: `node web/prototype-pr-view/make-calls.ts <owner>-<repo>-<n> [new pairs, default 85]`;
// writes data/overlays/<name>.json (gitignored: it names private parts).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Analysis, Edge, Node } from "./schema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2] ?? "AdvanGrid-advangrid-2627";
const want = Number(process.argv[3] ?? 85);
const a = JSON.parse(readFileSync(join(here, "data", `${name}.json`), "utf8")) as Analysis;

let seed = 2627;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);

const byId = new Map(a.nodes.map((n) => [n.id, n]));
const top = (id: string): string => {
  let n = byId.get(id)!;
  while (n.parent && byId.get(n.parent)?.kind !== "system") n = byId.get(n.parent)!;
  return n.id;
};
const leaves = new Map<string, string[]>();
for (const n of a.nodes) {
  if (n.kind === "system") continue;
  const hasKids = a.nodes.some((c) => c.parent === n.id);
  if (hasKids) continue;
  const t = top(n.id);
  leaves.set(t, [...(leaves.get(t) ?? []), n.id]);
}
const pairs = new Set(a.edges.map((e) => [top(e.from), top(e.to)].sort().join("|")));
const code = (n: Node) => ["service", "library", "app", "store"].includes(n.kind);
const tops = a.nodes.filter((n) => byId.get(n.parent ?? "")?.kind === "system");
const callers = tops.filter((n) => n.kind === "service" || n.kind === "app" || n.kind === "library");
// Libraries and stores are called by many; a few services are hubs.
const weight = (n: Node) => (n.kind === "library" ? 4 : n.kind === "store" ? 3 : n.kind === "external" ? 1 : 1.5);
const callees = tops.filter((n) => code(n) || n.kind === "external");
const total = callees.reduce((s, n) => s + weight(n), 0);
const pick = () => {
  let r = rnd() * total;
  for (const n of callees) if ((r -= weight(n)) <= 0) return n;
  return callees[callees.length - 1]!;
};

const edges: Edge[] = [];
for (let tries = 0; edges.length < want && tries < 20000; tries++) {
  const from = callers[Math.floor(rnd() * callers.length)]!;
  const to = pick();
  if (from.id === to.id || from.kind === "library" && to.kind !== "library" && to.kind !== "store") continue;
  const key = [from.id, to.id].sort().join("|");
  if (pairs.has(key)) continue;
  pairs.add(key);
  const fl = leaves.get(from.id) ?? [from.id];
  const tl = leaves.get(to.id) ?? [to.id];
  edges.push({
    id: `mk${edges.length + 1}`,
    from: fl[Math.floor(rnd() * fl.length)]!,
    to: tl[Math.floor(rnd() * tl.length)]!,
    kind: to.kind === "store" ? "data" : "call",
    label: `calls ${to.name} (made up)`,
    mode: "sync",
    change: "unchanged",
    crosses: [],
    facets: [],
    questions: [],
    claims: [],
  });
}
mkdirSync(join(here, "data", "overlays"), { recursive: true });
writeFileSync(join(here, "data", "overlays", `${name}.json`), JSON.stringify({ edges }, null, 1));
console.log(`${edges.length} made-up lines (new top-level pairs) → data/overlays/${name}.json; ${pairs.size} top-level pairs in all`);
