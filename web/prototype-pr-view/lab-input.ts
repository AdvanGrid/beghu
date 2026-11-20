// PROTOTYPE (PR view, #163): the layout lab's input, version A's top level: every top-level part
// with a line, on its side (people, changed, unchanged, outside), and one line per pair of parts.
import type { Analysis, Change, Edge, Node } from "./schema.ts";

export interface Line {
  key: string;
  from: string;
  to: string;
  both: boolean;
  change: Change | "mixed";
  edges: Edge[];
}
export interface Input {
  nodes: Node[];
  side: Map<string, 0 | 1 | 2 | 3>;
  lines: Line[];
}

export function input(a: Analysis): Input {
  const byId = new Map(a.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, Node[]>();
  for (const n of a.nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const top = (id: string): string => {
    let n = byId.get(id)!;
    while (n.parent && byId.get(n.parent)?.kind !== "system") n = byId.get(n.parent)!;
    return n.id;
  };
  const touched = (id: string): boolean => byId.get(id)!.change !== "unchanged" || (kids.get(id) ?? []).some((k) => touched(k.id));
  const lines = new Map<string, Line>();
  for (const e of a.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const [f, t] = [top(e.from), top(e.to)];
    if (f === t || byId.get(f)!.kind === "system" || byId.get(t)!.kind === "system") continue;
    const key = f < t ? `${f}↔${t}` : `${t}↔${f}`;
    let l = lines.get(key);
    if (!l) lines.set(key, (l = { key, from: f, to: t, both: false, change: e.change, edges: [] }));
    if (l.from !== f) l.both = true;
    if (l.change !== e.change) l.change = "mixed";
    l.edges.push(e);
  }
  const linked = new Set([...lines.values()].flatMap((l) => [l.from, l.to]));
  const side = new Map<string, 0 | 1 | 2 | 3>();
  const nodes = a.nodes.filter((n) => byId.get(n.parent ?? "")?.kind === "system" && linked.has(n.id));
  for (const n of nodes) side.set(n.id, n.kind === "actor" ? 0 : n.kind === "external" ? 3 : touched(n.id) ? 1 : 2);
  nodes.sort((x, y) => side.get(x.id)! - side.get(y.id)!);
  return { nodes, side, lines: [...lines.values()] };
}
