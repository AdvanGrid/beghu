// PROTOTYPE (PR view, #166): the nested lab's input: the analysis's parts as a tree (the top level
// in side order, as the lab's input has it) and its lines; or `times` copies of it, for scale.
import { NODE_H, NODE_W } from "./layout-size.ts";
import type { TLink, TNode } from "./nested-layout.ts";
import type { Analysis, Edge, Node } from "./schema.ts";

export interface Input {
  nodes: TNode[];
  links: TLink[];
  info: Map<string, Node>;
  edges: Map<string, Edge>;
  kids: Map<string, string[]>;
}

/** `times` copies of the analysis; a quarter of each copy's lines go to the next copy instead. */
export function grow(a: Analysis, times: number): Analysis {
  if (times <= 1) return a;
  const sys = a.nodes.find((n) => n.kind === "system")!;
  const nodes: Node[] = [sys];
  const edges: Edge[] = [];
  const id = (x: string, i: number) => (x === sys.id || i === 0 ? x : `${x}~${i}`);
  for (let i = 0; i < times; i++) {
    for (const n of a.nodes) if (n !== sys) nodes.push({ ...n, id: id(n.id, i), name: i ? `${n.name} ${i + 1}` : n.name, parent: n.parent && id(n.parent, i) });
    a.edges.forEach((e, j) => edges.push({ ...e, id: `${e.id}~${i}`, from: id(e.from, i), to: id(e.to, j % 4 === 0 ? (i + 1) % times : i) }));
  }
  return { ...a, nodes, edges };
}

export function input(a: Analysis): Input {
  const byId = new Map(a.nodes.map((n) => [n.id, n]));
  const sys = a.nodes.find((n) => n.kind === "system")!;
  const kids = new Map<string, string[]>();
  for (const n of a.nodes) if (n.parent && n.parent !== sys.id) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n.id]);
  const touched = (id: string): boolean => byId.get(id)!.change !== "unchanged" || (kids.get(id) ?? []).some(touched);
  const nodes: TNode[] = a.nodes
    .filter((n) => n !== sys)
    .map((n) => ({
      id: n.id,
      parent: n.parent === sys.id ? undefined : n.parent,
      side: n.kind === "actor" ? 0 : n.kind === "external" ? 3 : touched(n.id) ? 1 : 2,
      w: NODE_W,
      h: NODE_H,
    }));
  // The top level in side order, as the lab's input has it.
  nodes.sort((x, y) => (x.parent ? 1 : 0) - (y.parent ? 1 : 0) || (x.parent ? 0 : x.side - y.side));
  const links = a.edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== sys.id && e.to !== sys.id).map((e) => ({ key: e.id, from: e.from, to: e.to }));
  return { nodes, links, info: byId, edges: new Map(a.edges.map((e) => [e.id, e])), kids };
}

