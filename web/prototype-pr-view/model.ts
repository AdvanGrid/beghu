// PROTOTYPE (PR view). The graph logic: the zoom hierarchy, rolling edges up to what's visible,
// the four lenses, and the overview's stated ordering rule.
import type { Analysis, Boundary, Change, Claim, Edge, Facet, Node } from "./schema.ts";

export type Lens = "modules" | "data" | "external" | "order";

export interface VisNode {
  node: Node;
  /** Outside the zoomed-into node: shown for its connections only. */
  context: boolean;
  /** The node or something inside it changed. */
  touched: boolean;
  /** Dimmed by the lens (the external lens dims what isn't external or on a crossing). */
  dim: boolean;
}

export interface VisEdge {
  key: string;
  from: string;
  to: string;
  /** The underlying edges, rolled up to the visible nodes, both directions in one bundle. */
  edges: Edge[];
  /** Some of the bundle's edges go from `to` to `from`. */
  both: boolean;
  change: Change | "mixed";
  crosses: string[];
  label: string;
}

const EXTERNAL_KINDS = new Set(["external", "store", "actor"]);
const NON_CODE = EXTERNAL_KINDS;

export class Model {
  readonly a: Analysis;
  readonly nodes = new Map<string, Node>();
  readonly edges = new Map<string, Edge>();
  readonly claims = new Map<string, Claim>();
  readonly boundaries = new Map<string, Boundary>();
  readonly facets = new Map<string, Facet>();
  readonly children = new Map<string | null, Node[]>();
  private readonly touchedCache = new Map<string, boolean>();

  constructor(a: Analysis) {
    this.a = a;
    for (const n of a.nodes) this.nodes.set(n.id, n);
    for (const e of a.edges) this.edges.set(e.id, e);
    for (const c of a.claims) this.claims.set(c.id, c);
    for (const b of a.boundaries) this.boundaries.set(b.id, b);
    for (const f of a.facets) this.facets.set(f.id, f);
    for (const n of a.nodes) {
      const p = n.parent ?? null;
      if (!this.children.has(p)) this.children.set(p, []);
      this.children.get(p)!.push(n);
    }
    // "Changed" means its own code changed: a file the PR changed lies under its paths or a
    // child's. A person, an external system, or a store the PR only starts using keeps
    // "unchanged"; its new connections carry the change.
    const prFiles = a.nodes.flatMap((n) => n.files.map((f) => f.path));
    const under = (p: string) => {
      const dir = p.replace(/\/$/, "");
      return prFiles.some((f) => f === dir || f.startsWith(`${dir}/`));
    };
    const own = (n: Node): boolean =>
      n.files.length > 0 || n.paths.some(under) || (this.children.get(n.id) ?? []).some(own);
    for (const n of a.nodes) {
      if (n.change === "unchanged" || own(n)) continue;
      n.change = "unchanged";
      delete n.changeSummary;
      for (const r of n.responsibilities) r.change = "unchanged";
      this.connectedOnly.add(n.id);
    }
  }

  /** Nodes the analysis marked changed whose own code the PR didn't touch: only their connections are new. */
  readonly connectedOnly = new Set<string>();

  /** Code the repo holds (services, apps, libraries, modules), as opposed to people, external systems and stores. */
  /**
   * Outside the system: people and callers, and external systems (and a group of only those).
   * Data stores the system keeps count as inside it.
   */
  isExternal(id: string): boolean {
    const n = this.nodes.get(id)!;
    if (n.kind === "actor" || n.kind === "external") return true;
    const kids = this.children.get(id) ?? [];
    return kids.length > 0 && kids.every((c) => this.isExternal(c.id));
  }

  /** What kind of thing a node is, in words. */
  kindLabel(id: string): string {
    const n = this.nodes.get(id)!;
    if (n.kind === "actor") return "person or caller";
    if (n.kind === "external") return "external system";
    if (n.kind === "store") return "data store";
    if (this.isExternal(id)) return "external";
    return n.kind;
  }

  /** Whether "unchanged" means anything for it: not for people and external systems, which aren't code here. */
  showsChange(id: string): boolean {
    return !this.isExternal(id) || this.nodes.get(id)!.change !== "unchanged";
  }

  /** Whether a node is something the system uses rather than code: an external system or a data store. */
  isUsed(id: string): boolean {
    const k = this.nodes.get(id)!.kind;
    return k === "external" || k === "store";
  }

  /** Facets that describe the external systems and stores: the ones the page can group them by. */
  groupingFacets(): Facet[] {
    return this.a.facets.filter((f) => this.a.nodes.some((n) => this.isUsed(n.id) && n.facets.some((x) => x.facet === f.id && x.values.length > 0)));
  }

  /** A node's first value for a facet, if it has one. */
  valueOf(id: string, facet: string): string | undefined {
    return this.nodes.get(id)!.facets.find((x) => x.facet === facet)?.values[0];
  }

  isCode(id: string): boolean {
    let v = this.codeCache.get(id);
    if (v === undefined) {
      const n = this.nodes.get(id)!;
      const kids = this.children.get(id) ?? [];
      v = !NON_CODE.has(n.kind) && (kids.length === 0 || kids.some((c) => this.isCode(c.id)));
      this.codeCache.set(id, v);
    }
    return v;
  }
  private readonly codeCache = new Map<string, boolean>();

  /** The node's ancestors and itself, outermost first. */
  chain(id: string | null): string[] {
    const out: string[] = [];
    for (let p: string | undefined = id ?? undefined; p !== undefined; p = this.nodes.get(p)?.parent) out.unshift(p);
    return out;
  }

  /** The node `id` is drawn as when zoomed into `focus`: its ancestor where its chain leaves focus's. */
  rep(id: string, focus: string | null): { id: string; context: boolean } | null {
    const f = this.chain(focus);
    const n = this.chain(id);
    let i = 0;
    while (i < f.length && i < n.length && f[i] === n[i]) i++;
    // The zoomed-into node itself or one of its ancestors: an edge drawn at a coarser level than
    // this zoom shows; its detail is in the edges of the nodes inside.
    if (i === n.length) return null;
    return { id: n[i]!, context: i < f.length };
  }

  touched(id: string): boolean {
    let t = this.touchedCache.get(id);
    if (t === undefined) {
      const n = this.nodes.get(id)!;
      t = n.change !== "unchanged" || (this.children.get(id) ?? []).some((c) => this.touched(c.id));
      this.touchedCache.set(id, t);
    }
    return t;
  }

  /** The PR's files under a node (itself and everything inside), and their line counts. */
  diffSize(id: string): { files: number; add: number; del: number } {
    let files = 0, add = 0, del = 0;
    for (const x of this.within(id)) {
      for (const f of this.nodes.get(x)!.files) {
        files++;
        add += f.additions;
        del += f.deletions;
      }
    }
    return { files, add, del };
  }

  /** Every node inside `id`, itself included. */
  within(id: string): Set<string> {
    const out = new Set<string>([id]);
    const todo = [id];
    for (let x = todo.pop(); x !== undefined; x = todo.pop()) {
      for (const c of this.children.get(x) ?? []) {
        out.add(c.id);
        todo.push(c.id);
      }
    }
    return out;
  }

  private lensEdge(e: Edge, lens: Lens): boolean {
    if (lens === "data") return e.kind === "data" || e.kind === "event" || !!e.data;
    if (lens === "external") {
      const ext = (id: string) => EXTERNAL_KINDS.has(this.nodes.get(id)?.kind ?? "");
      return e.crosses.length > 0 || ext(e.from) || ext(e.to);
    }
    return true;
  }

  view(focus: string | null, lens: Lens, changedOnly: boolean): { nodes: VisNode[]; edges: VisEdge[] } {
    const inside = this.children.get(focus) ?? [];
    const shown = new Map<string, VisNode>();
    // The modules lens is the code's structure: people, external systems and stores stay out.
    const fits = (id: string) => lens !== "modules" || this.isCode(id);
    for (const n of inside) {
      if (changedOnly && !this.touched(n.id)) continue;
      if (!fits(n.id)) continue;
      shown.set(n.id, { node: n, context: false, touched: this.touched(n.id), dim: false });
    }
    const rolled = new Map<string, VisEdge>();
    for (const e of this.a.edges) {
      if (!this.lensEdge(e, lens)) continue;
      if (changedOnly && e.change === "unchanged") continue;
      const a = this.rep(e.from, focus);
      const b = this.rep(e.to, focus);
      if (!a || !b || a.id === b.id) continue; // inside one visible node
      if (a.context && b.context) continue; // entirely outside the zoomed-into node
      if (!fits(a.id) || !fits(b.id)) continue;
      for (const r of [a, b]) {
        if (!shown.has(r.id)) {
          if (!r.context) continue;
          const n = this.nodes.get(r.id)!;
          shown.set(r.id, { node: n, context: true, touched: this.touched(r.id), dim: false });
        }
      }
      if (!shown.has(a.id) || !shown.has(b.id)) continue;
      const key = a.id < b.id ? `${a.id}↔${b.id}` : `${b.id}↔${a.id}`;
      let v = rolled.get(key);
      if (!v) {
        v = { key, from: a.id, to: b.id, edges: [], both: false, change: e.change, crosses: [], label: "" };
        rolled.set(key, v);
      }
      if (v.from !== a.id) v.both = true;
      v.edges.push(e);
      if (v.change !== e.change) v.change = "mixed";
      for (const c of e.crosses) if (!v.crosses.includes(c)) v.crosses.push(c);
    }
    for (const v of rolled.values()) {
      const top = v.edges.find((e) => e.change !== "unchanged") ?? v.edges[0]!;
      const text = lens === "data" ? (top.data ?? top.label) : top.label;
      v.label = v.edges.length > 1 ? `${v.edges.length} connections` : text;
    }
    if (lens === "external") {
      const onCrossing = new Set<string>();
      for (const v of rolled.values()) {
        if (v.crosses.length > 0) {
          onCrossing.add(v.from);
          onCrossing.add(v.to);
        }
      }
      for (const s of shown.values()) s.dim = !EXTERNAL_KINDS.has(s.node.kind) && !onCrossing.has(s.node.id);
    }
    return { nodes: [...shown.values()], edges: [...rolled.values()] };
  }

  /** The overview's order: a stated rule, not a severity score. */
  ranked(): { title: string; rule: string; items: RankItem[] }[] {
    const a = this.a;
    const shape = (c: Change) => c === "added" || c === "removed";
    const crossings: RankItem[] = [
      ...a.boundaries.filter((b) => b.change !== "unchanged").map((b): RankItem => ({ kind: "boundary", id: b.id, change: b.change, text: b.name })),
      ...a.edges
        .filter((e) => e.crosses.length > 0 && e.change !== "unchanged")
        .map((e): RankItem => ({ kind: "edge", id: e.id, change: e.change, text: `${this.name(e.from)} → ${this.name(e.to)}: ${e.label}` })),
    ];
    const crossingEdges = new Set(crossings.filter((c) => c.kind === "edge").map((c) => c.id));
    const shapeItems: RankItem[] = [
      ...a.nodes.filter((n) => shape(n.change)).map((n): RankItem => ({ kind: "node", id: n.id, change: n.change, text: `${n.name}: ${n.changeSummary ?? n.summary}` })),
      ...a.edges
        .filter((e) => shape(e.change) && !crossingEdges.has(e.id))
        .map((e): RankItem => ({ kind: "edge", id: e.id, change: e.change, text: `${this.name(e.from)} → ${this.name(e.to)}: ${e.label}` })),
    ];
    const capability: RankItem[] = [];
    for (const n of a.nodes) {
      if (n.change !== "modified") continue;
      for (const r of n.responsibilities) {
        if (r.change !== "unchanged") capability.push({ kind: "node", id: n.id, change: r.change, text: `${n.name}: ${r.text}` });
      }
      for (const f of n.facets) {
        if (!f.was) continue;
        const def = this.facets.get(f.facet);
        const label = (v: string) => def?.values.find((x) => x.id === v)?.label ?? v;
        capability.push({ kind: "node", id: n.id, change: "modified", text: `${n.name}: ${def?.name ?? f.facet} ${f.was.map(label).join(", ")} → ${f.values.map(label).join(", ")}` });
      }
    }
    const inside: RankItem[] = a.nodes
      .filter((n) => n.change === "modified" && (this.children.get(n.id) ?? []).length === 0)
      .map((n) => ({ kind: "node", id: n.id, change: n.change, text: `${n.name}: ${n.changeSummary ?? ""}` }));
    return [
      { title: "Boundary crossings", rule: "new or changed edges that cross a trust, process or network boundary", items: crossings },
      { title: "New and removed parts", rule: "nodes and edges that exist on only one side", items: shapeItems },
      { title: "Changed responsibilities", rule: "what existing parts now do, or how they're built", items: capability },
      { title: "Edits inside parts", rule: "changed modules whose place in the graph stays the same", items: inside },
    ];
  }

  name(id: string): string {
    return this.nodes.get(id)?.name ?? id;
  }

  /** Edges into and out of `id` or anything inside it, from or to outside it. */
  connections(id: string): { out: Edge[]; in: Edge[] } {
    const w = this.within(id);
    return {
      out: this.a.edges.filter((e) => w.has(e.from) && !w.has(e.to)),
      in: this.a.edges.filter((e) => w.has(e.to) && !w.has(e.from)),
    };
  }
}

export interface RankItem {
  kind: "node" | "edge" | "boundary";
  id: string;
  change: Change;
  text: string;
}
