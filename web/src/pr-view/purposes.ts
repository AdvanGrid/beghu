// The purpose view's model (#183): the PR's purposes read across the code view, worked out once
// per graph. Everything the walkthrough, the conflict cards and the canvas's fold plan read about
// purposes goes through it.
//
// - A top-level purpose's colour is its place in reading order, over the 8 purpose tokens
//   (`graph.purpose0`–`purpose7`; they repeat after 8); a sub-purpose takes its parent's.
// - A purpose's members are the parts its tree serves (its own `serves` and its sub-purposes'),
//   its lines the ones they carry. The whole PR's are every purpose's.
// - A part serves a top-level purpose when it, or a part inside it, is a member of that purpose's
//   tree: the canvas's dots and the panel's "Part · 2 purposes" count the same.
// - Which conflicts show where: every one at the PR; at a purpose, those touching it or its
//   sub-purposes; at a part, those touching it, a part inside it or a part it sits in; at a line,
//   those touching it. Cause cards come first, then lone conflicts, each in reading order.
// - "Outside the diff": a part a shown conflict touches that no purpose names, isn't inside a
//   member and holds none (so it isn't drawn already): its own frame on the canvas.
import type { Conflict, Edge, Node, Purpose, Walk } from "../bindings/analysis";
import type { Model } from "./model";
import type { Sel } from "./state";

/** How many purpose colours there are: past it they repeat. */
export const PURPOSE_COLOURS = 8;

/** Where the purpose view stands: the whole PR, a purpose or sub-purpose, or the unclaimed parts. */
export type Place = { kind: "pr" } | { kind: "purpose"; id: string } | { kind: "unclaimed" };

export const samePlace = (a: Place | undefined, b: Place | undefined) =>
  a?.kind === b?.kind && (a?.kind !== "purpose" || a.id === (b as { id: string }).id);

/** The place a selection stands on, if it is one: nothing (the PR), one purpose, the unclaimed parts. */
export function placeOf(sel: Sel | undefined, p: Purposes): Place | undefined {
  if (!sel) return { kind: "pr" };
  if (sel.kind === "purpose" && sel.ids.length === 1 && p.byId.has(sel.ids[0]!)) return { kind: "purpose", id: sel.ids[0]! };
  if (sel.kind === "unclaimed") return { kind: "unclaimed" };
  return undefined;
}

/** A place's selection. */
export const selOfPlace = (pl: Place): Sel | undefined => (pl.kind === "pr" ? undefined : pl.kind === "unclaimed" ? { kind: "unclaimed" } : { kind: "purpose", ids: [pl.id] });

/** A part's or line's role in one purpose: what it does for it, and the part inside it that does (`via`). */
export interface Role {
  purpose: string;
  role: string;
  claims: string[];
  via?: string;
}

/** One card in the Conflicts section: a lone conflict, or the conflicts sharing a cause. */
export type Card = { kind: "one"; conflict: Conflict } | { kind: "cause"; cause: string; conflicts: Conflict[] };

export interface Purposes {
  byId: ReadonlyMap<string, Purpose>;
  /** Top-level purposes, in reading order. */
  tops: readonly Purpose[];
  /** A purpose's colour, 0–7: its top-level purpose's place in reading order. */
  colour(id: string): number;
  /** A purpose's top-level purpose. */
  top(id: string): string;
  /** A purpose's ancestors, outermost first. */
  ancestors(id: string): string[];
  /** A purpose's sub-purposes, in reading order. */
  subs(id: string): Purpose[];
  /** A purpose and its sub-purposes, at any depth. */
  tree(id: string): string[];
  /** The parts a place's members are: its tree's `serves` (every purpose's at the PR; the unclaimed parts). */
  members(pl: Place): ReadonlySet<string>;
  /** The lines a place carries: its tree's `carries` (every purpose's at the PR). */
  carries(pl: Place): ReadonlySet<string>;
  /** The top-level purposes a part serves: it or a part inside it, in reading order. */
  servedBy(node: string): string[];
  /** A part's roles: in each purpose that it serves, or a part inside it does ("through ‹part›"). */
  roles(node: string): Role[];
  /** Lines' roles: in each purpose that carries one of them. */
  lineRoles(edges: readonly string[]): Role[];
  /** The conflicts shown at a place or selection. */
  conflictsAt(at: Place | Sel): Conflict[];
  /** Conflicts as cards: those sharing a cause together, first, then the rest, each in reading order. */
  cards(list: readonly Conflict[]): Card[];
  /** The parts that come in only through a place's conflicts, each with the first conflict touching it. */
  outside(pl: Place): { node: string; conflict: Conflict }[];
}

/** Each model's purposes, worked out once. */
const cache = new WeakMap<Model, Purposes>();

export function purposesOf(m: Model): Purposes {
  let p = cache.get(m);
  if (!p) cache.set(m, (p = build(m)));
  return p;
}

function build(m: Model): Purposes {
  const all = m.a.purposes;
  const byId = new Map(all.map((p) => [p.id, p]));
  const parentOf = (p: Purpose) => (p.parent != null && byId.has(p.parent) && p.parent !== p.id ? p.parent : undefined);
  const tops = all.filter((p) => parentOf(p) === undefined);
  const topIndex = new Map(tops.map((p, i) => [p.id, i]));
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set([id]);
    for (let x = byId.get(id) && parentOf(byId.get(id)!); x !== undefined && !seen.has(x); x = parentOf(byId.get(x)!)) {
      seen.add(x);
      out.unshift(x);
    }
    return out;
  };
  const top = (id: string) => ancestors(id)[0] ?? id;
  const subs = (id: string) => all.filter((p) => parentOf(p) === id);
  const trees = new Map<string, string[]>();
  const tree = (id: string): string[] => {
    let t = trees.get(id);
    if (!t) {
      t = [id];
      trees.set(id, t);
      for (const s of subs(id)) t.push(...tree(s.id).filter((x) => !t!.includes(x)));
    }
    return t;
  };

  const own = (ids: readonly string[], pick: (p: Purpose) => string[]) => new Set(ids.flatMap((id) => (byId.has(id) ? pick(byId.get(id)!) : [])));
  const servesOf = (p: Purpose) => p.serves.map((s) => s.node).filter((n) => m.nodes.has(n));
  const carriesOf = (p: Purpose) => p.carries.map((c) => c.edge).filter((e) => m.edges.has(e));
  const everyone = all.map((p) => p.id);
  const memberMemo = new Map<string, ReadonlySet<string>>();
  const key = (pl: Place) => (pl.kind === "purpose" ? `purpose\u0000${pl.id}` : pl.kind);
  const members = (pl: Place): ReadonlySet<string> => {
    let s = memberMemo.get(key(pl));
    if (!s) {
      s = pl.kind === "unclaimed" ? new Set(m.a.unclaimed.map((u) => u.node).filter((n) => m.nodes.has(n))) : own(pl.kind === "pr" ? everyone : tree(pl.id), servesOf);
      memberMemo.set(key(pl), s);
    }
    return s;
  };
  const carries = (pl: Place): ReadonlySet<string> => (pl.kind === "unclaimed" ? new Set() : own(pl.kind === "pr" ? everyone : tree(pl.id), carriesOf));

  // Each top-level purpose's members and every part they sit in: what serves it, there or inside.
  const servedMemo = new Map<string, string[]>();
  const holders = tops.map((t) => {
    const out = new Set<string>();
    for (const n of members({ kind: "purpose", id: t.id })) for (const x of [n, ...m.ancestors(n)]) out.add(x);
    return out;
  });
  const servedBy = (node: string) => {
    let s = servedMemo.get(node);
    if (!s) servedMemo.set(node, (s = tops.filter((_, i) => holders[i]!.has(node)).map((t) => t.id)));
    return s;
  };

  const roles = (node: string): Role[] => {
    const out: Role[] = [];
    for (const p of all) {
      const direct = p.serves.find((s) => s.node === node);
      if (direct) {
        out.push({ purpose: p.id, role: direct.role, claims: direct.claims });
        continue;
      }
      const inside = p.serves.find((s) => s.node !== node && m.within(s.node, node));
      if (inside) out.push({ purpose: p.id, role: inside.role, claims: inside.claims, via: inside.node });
    }
    return out;
  };
  const lineRoles = (edges: readonly string[]): Role[] => {
    const want = new Set(edges);
    const out: Role[] = [];
    for (const p of all) {
      const hit = p.carries.find((c) => want.has(c.edge));
      if (hit) out.push({ purpose: p.id, role: hit.why, claims: hit.claims });
    }
    return out;
  };

  const conflictsAt = (at: Place | Sel): Conflict[] => {
    const cs = m.a.conflicts;
    switch (at.kind) {
      case "pr":
        return cs;
      case "purpose": {
        const ids = "id" in at ? [at.id] : at.ids;
        const t = new Set(ids.flatMap(tree));
        return cs.filter((c) => c.touches.purposes.some((x) => t.has(x)));
      }
      case "part": {
        const touches = (n: string) => at.ids.some((id) => m.within(n, id) || m.within(id, n));
        return cs.filter((c) => c.touches.nodes.some(touches));
      }
      case "line": {
        const ids = new Set(at.ids);
        return cs.filter((c) => c.touches.edges.some((e) => ids.has(e)));
      }
      case "unclaimed": {
        const us = [...members({ kind: "unclaimed" })];
        return cs.filter((c) => c.touches.nodes.some((n) => us.some((u) => m.within(n, u) || m.within(u, n))));
      }
      case "conflict":
        return cs.filter((c) => c.id === at.id);
      default:
        return [];
    }
  };

  const cards = (list: readonly Conflict[]): Card[] => {
    const known = new Set(m.a.causes.map((c) => c.id));
    const byCause = new Map<string, Conflict[]>();
    for (const c of list) {
      if (c.cause == null || !known.has(c.cause)) continue;
      byCause.set(c.cause, [...(byCause.get(c.cause) ?? []), c]);
    }
    const out: Card[] = [];
    for (const cause of m.a.causes) {
      const cs = byCause.get(cause.id);
      if (cs) out.push({ kind: "cause", cause: cause.id, conflicts: cs });
    }
    for (const c of list) if (c.cause == null || !known.has(c.cause)) out.push({ kind: "one", conflict: c });
    return out;
  };

  const outside = (pl: Place): { node: string; conflict: Conflict }[] => {
    if (pl.kind === "unclaimed") return [];
    const named = members({ kind: "pr" });
    const mine = members(pl);
    // Drawn already: a member, inside one, or holding one.
    const drawn = new Set<string>();
    for (const n of mine) for (const x of [n, ...m.ancestors(n)]) drawn.add(x);
    const out: { node: string; conflict: Conflict }[] = [];
    const seen = new Set<string>();
    for (const c of conflictsAt(pl)) {
      for (const n of c.touches.nodes) {
        if (!m.nodes.has(n) || seen.has(n) || named.has(n) || drawn.has(n) || [...mine].some((x) => m.within(n, x))) continue;
        if (m.nodes.get(n)!.kind === "system") continue;
        seen.add(n);
        out.push({ node: n, conflict: c });
      }
    }
    // A part inside another listed is drawn in that one's block.
    return out.filter((x) => !out.some((y) => y.node !== x.node && m.within(x.node, y.node)));
  };

  return {
    byId,
    tops,
    colour: (id) => (topIndex.get(top(id)) ?? 0) % PURPOSE_COLOURS,
    top,
    ancestors,
    subs,
    tree,
    members,
    carries,
    servedBy,
    roles,
    lineRoles,
    conflictsAt,
    cards,
    outside,
  };
}

/** A walk and whether it was built from the code view's one-liners (none was written for it). */
export interface Walked {
  walk: Walk;
  built: boolean;
}

/** A part's walk: its own, or one built from its one-liners and the purposes it serves. */
export function partWalk(p: Purposes, n: Node): Walked {
  if (n.walk) return { walk: n.walk, built: false };
  const tops = p.servedBy(n.id).map((id) => p.byId.get(id)!.name);
  return {
    walk: {
      intro: sentence(n.summary),
      journey: n.change === "unchanged" ? "The PR doesn't change its own code." : sentence(n.changeSummary ?? "The PR changes its code."),
      destination: tops.length ? `It serves ${list(tops)}.` : "It serves none of the PR's purposes.",
      claims: [],
    },
    built: true,
  };
}

const WHEN_WORDS = { runtime: "at run time", build: "at build time", test: "in tests" } as const;
const KIND_WORDS = { call: "a call", data: "a read or write of data", event: "an event" } as const;

/** A line's walk: its own (the first of several that has one), or one built from its one-liners. */
export function lineWalk(m: Model, edges: readonly Edge[]): Walked {
  const own = edges.find((e) => e.walk);
  if (own?.walk) return { walk: own.walk, built: false };
  const e = edges[0]!;
  const many = edges.length > 1;
  return {
    walk: {
      intro: many ? `${edges.length} connections between ${m.name(e.from)} and ${m.name(e.to)}.` : `${m.name(e.from)} → ${m.name(e.to)}: ${e.label}.`,
      journey: e.data ? `It carries ${e.data.what}, ${KIND_WORDS[e.kind]} ${WHEN_WORDS[e.when]}.` : `It's ${KIND_WORDS[e.kind]} ${WHEN_WORDS[e.when]}.`,
      destination: e.occurs ? sentence(`It happens ${e.occurs}`) : e.change === "unchanged" ? "The PR doesn't change it." : `The PR ${e.change === "added" ? "adds" : e.change === "removed" ? "removes" : "changes"} it.`,
      claims: [],
    },
    built: true,
  };
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** What a walk's claims rest on, from the graph's stubs: before the claims arrive. */
export interface Sources {
  /** Description quotes. */
  description: number;
  /** Each issue quoted, `owner/repo#N`, in first-seen order; with how many quotes. */
  issues: { ref: string; n: number }[];
  /** Issue quotes the graph doesn't say the number of (an analysis stored before it did). */
  unnamedIssues: number;
  /** Code evidence items. */
  code: number;
  /** Some claim behind it rests only on what the description or an issue says. */
  stated: boolean;
}

export function sourcesOf(m: Model, ids: readonly string[]): Sources {
  const out: Sources = { description: 0, issues: [], unnamedIssues: 0, code: 0, stated: false };
  for (const id of ids) {
    const s = m.stubs.get(id);
    if (!s) continue;
    out.description += s.description;
    out.code += s.code;
    if (s.issues) {
      for (const ref of s.issues) {
        const at = out.issues.find((x) => x.ref === ref);
        if (at) at.n++;
        else out.issues.push({ ref, n: 1 });
      }
      out.unnamedIssues += Math.max(0, s.issue - s.issues.length);
    } else out.unnamedIssues += s.issue;
    if (s.code === 0 && s.description + s.issue > 0) out.stated = true;
  }
  return out;
}

/** An issue's chip: `#N` in the PR's own repo, else `owner/repo#N`. */
export function issueLabel(m: Model, ref: string): string {
  const at = ref.lastIndexOf("#");
  return ref.slice(0, at).toLowerCase() === m.g.repo.toLowerCase() ? ref.slice(at) : ref;
}
