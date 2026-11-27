// The PR view's model of one analysis graph: its items by ID, the hierarchy, the lines in and out
// of each part, which parts use each responsibility (from the lines' `uses`), and the PR's
// changes in the stated order ("All changes, by kind"). Built once per graph; everything the
// panel and the canvas read goes through it.
import type { Graph, GraphAnalysis, ClaimStub } from "../analysis";
import type { Boundary, Change, Conflict, Edge, Facet, FacetAssignment, FileChange, Node, Purpose, Scenario } from "../bindings/analysis";

/** One item of "All changes, by kind": what it names, how it changed, and its words. */
export interface RankItem {
  kind: "part" | "line";
  id: string;
  change: Change;
  text: string;
}

/** A group of "All changes, by kind", by the stated rule. */
export interface RankGroup {
  title: string;
  rule: string;
  items: RankItem[];
}

export interface Model {
  g: Graph;
  a: GraphAnalysis;
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
  purposes: Map<string, Purpose>;
  conflicts: Map<string, Conflict>;
  scenarios: Map<string, Scenario>;
  facets: Map<string, Facet>;
  boundaries: Map<string, Boundary>;
  stubs: Map<string, ClaimStub>;
  /** The `system` node, the root. */
  system?: Node;
  /** Each node's children, in the analysis's order. */
  children: Map<string, Node[]>;
  /**
   * The node's name, or the ID when it isn't one; inside a top-level part, with that part's name
   * in front ("beghu › src"), as many parts share a folder's name.
   */
  name(id: string): string;
  /** The node's ancestors, nearest first, the system last. */
  ancestors(id: string): string[];
  /** Whether `id` is `of` or inside it. */
  within(id: string, of: string): boolean;
  /** `id` and every node inside it, at any depth. */
  subtree(id: string): ReadonlySet<string>;
  /**
   * Whether a node's path names a file rather than a folder: a changed file's path, or one with
   * nothing under it and an extension (`crates/server/src/live.rs`).
   */
  isFile(path: string): boolean;
  /** Lines out of and into `id` or anything inside it, from or to outside it. */
  connections(id: string): { out: Edge[]; into: Edge[] };
  /** The parts whose lines use the node's responsibility (from the lines' `uses`), in order. */
  usersOf(node: string, responsibility: string): string[];
  /** The changed files in `id`'s subtree, by path. */
  files(id: string): FileChange[];
  /** The PR's changes in the stated order. */
  ranked(): RankGroup[];
}

const byId = <T extends { id: string }>(xs: readonly T[]) => new Map(xs.map((x) => [x.id, x]));

export function buildModel(g: Graph): Model {
  const a = g.analysis;
  const nodes = byId(a.nodes);
  const edges = byId(a.edges);
  const children = new Map<string, Node[]>();
  for (const n of a.nodes) {
    if (n.parent === undefined) continue;
    const list = children.get(n.parent);
    if (list) list.push(n);
    else children.set(n.parent, [n]);
  }
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>([id]);
    for (let p = nodes.get(id)?.parent; p !== undefined && !seen.has(p); p = nodes.get(p)?.parent) {
      seen.add(p);
      out.push(p);
    }
    return out;
  };
  const within = (id: string, of: string) => id === of || ancestors(id).includes(of);
  /** Each node's subtree, worked out on first ask. */
  const subtrees = new Map<string, Set<string>>();
  const subtree = (id: string): Set<string> => {
    let s = subtrees.get(id);
    if (s) return s;
    s = new Set([id]);
    for (const c of children.get(id) ?? []) for (const x of subtree(c.id)) s.add(x);
    subtrees.set(id, s);
    return s;
  };

  // Each call line's `uses` is a responsibility of its `to` or of a node inside it: the nearest
  // that has one with that ID.
  const users = new Map<string, string[]>();
  for (const e of a.edges) {
    if (e.uses === undefined) continue;
    const owner = ownerOf(e.to, e.uses);
    if (owner === undefined) continue;
    const key = `${owner}\u0000${e.uses}`;
    const list = users.get(key) ?? [];
    if (!list.includes(e.from)) list.push(e.from);
    users.set(key, list);
  }
  function ownerOf(to: string, resp: string): string | undefined {
    const queue = [to];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (nodes.get(id)?.responsibilities.some((r) => r.id === resp)) return id;
      queue.push(...(children.get(id) ?? []).map((c) => c.id));
    }
    return undefined;
  }

  const filePaths = new Set(a.nodes.flatMap((n) => n.files.map((f) => f.path)));
  /** Every folder some node's path or changed file is under. */
  const folders = new Set<string>();
  for (const p of [...filePaths, ...a.nodes.flatMap((n) => n.paths)]) {
    for (let at = p.indexOf("/"); at > 0; at = p.indexOf("/", at + 1)) folders.add(p.slice(0, at));
  }

  const name = (id: string) => {
    const n = nodes.get(id);
    if (!n) return id;
    const chain = ancestors(id).filter((a) => nodes.has(a) && nodes.get(a)!.kind !== "system");
    const top = chain.at(-1);
    return top === undefined ? n.name : `${nodes.get(top)!.name} › ${n.name}`;
  };
  const lineText = (e: Edge) => `${name(e.from)} → ${name(e.to)}: ${e.label}`;

  return {
    g,
    a,
    nodes,
    edges,
    purposes: byId(a.purposes),
    conflicts: byId(a.conflicts),
    scenarios: byId(a.scenarios),
    facets: byId(a.facets),
    boundaries: byId(a.boundaries),
    stubs: byId(a.claims),
    system: a.nodes.find((n) => n.kind === "system"),
    children,
    name,
    ancestors,
    within,
    subtree,
    isFile(path) {
      const p = path.replace(/\/+$/, "");
      return filePaths.has(p) || (!folders.has(p) && /\.[^./]+$/.test(p.slice(p.lastIndexOf("/") + 1)));
    },
    connections(id) {
      const w = subtree(id);
      return {
        out: a.edges.filter((e) => w.has(e.from) && !w.has(e.to)),
        into: a.edges.filter((e) => w.has(e.to) && !w.has(e.from)),
      };
    },
    usersOf(node, responsibility) {
      return users.get(`${node}\u0000${responsibility}`) ?? [];
    },
    files(id) {
      const w = subtree(id);
      return a.nodes
        .filter((n) => w.has(n.id))
        .flatMap((n) => n.files)
        .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    },
    ranked() {
      const shape = (c: Change) => c === "added" || c === "removed";
      const part = (n: Node, change: Change, text: string): RankItem => ({ kind: "part", id: n.id, change, text: `${name(n.id)}: ${text}` });
      const lineItem = (e: Edge): RankItem => ({ kind: "line", id: e.id, change: e.change, text: lineText(e) });
      // Every changed line lands in exactly one of the first, second and fourth groups (by what
      // it crosses, then whether it's new or gone, else an edit); a facet it changed, in the
      // third as well, as a part's changed responsibilities are beside its edits.
      const crossings = a.edges.filter((e) => e.boundaries.length > 0 && e.change !== "unchanged").map(lineItem);
      const crossing = new Set(crossings.map((c) => c.id));
      const parts: RankItem[] = [
        ...a.nodes.filter((n) => n.kind !== "system" && shape(n.change)).map((n) => part(n, n.change, n.changeSummary ?? n.summary)),
        ...a.edges.filter((e) => shape(e.change) && !crossing.has(e.id)).map(lineItem),
      ];
      /** A facet assignment's change in words: "Storage SQLite → SQLite, blobs". */
      const facetChange = (f: FacetAssignment) => {
        const def = a.facets.find((x) => x.id === f.facet);
        const label = (v: string) => def?.values.find((x) => x.id === v)?.label ?? v;
        return `${def?.name ?? f.facet} ${(f.was ?? []).map(label).join(", ")} → ${f.values.map((v) => label(v.value)).join(", ")}`;
      };
      const responsibilities: RankItem[] = [];
      for (const n of a.nodes) {
        if (n.change !== "modified") continue;
        for (const r of n.responsibilities) {
          if (r.change !== "unchanged") responsibilities.push(part(n, r.change, r.text));
        }
        for (const f of n.facets) if (f.was) responsibilities.push(part(n, "modified", facetChange(f)));
      }
      for (const e of a.edges) {
        for (const f of e.facets) if (f.was) responsibilities.push({ kind: "line", id: e.id, change: "modified", text: `${lineText(e)} · ${facetChange(f)}` });
      }
      // A changed line that crosses no boundary keeps its two ends, so its place in the graph
      // stays the same: what changed is the code at its ends, an edit, as a changed part's is.
      const inside: RankItem[] = [
        ...a.nodes.filter((n) => n.change === "modified" && (children.get(n.id) ?? []).length === 0).map((n) => part(n, n.change, n.changeSummary ?? n.summary)),
        ...a.edges.filter((e) => e.change === "modified" && !crossing.has(e.id)).map(lineItem),
      ];
      return [
        { title: "Boundary crossings", rule: "New or changed lines that cross a trust, process, network or tenant boundary.", items: crossings },
        { title: "New and removed parts", rule: "Parts and lines that exist on only one side.", items: parts },
        { title: "Changed responsibilities or facets", rule: "What existing parts now do, or how they and their lines are described.", items: responsibilities },
        { title: "Edits inside parts", rule: "Changed parts, and changed lines between the same two parts, whose place in the graph stays the same.", items: inside },
      ];
    },
  };
}
