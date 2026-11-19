// PROTOTYPE (PR view, #159). The purpose view's data, hand-written for now (data/purposes/, gitignored:
// it quotes the PR and its issues). It sits beside the code view's analysis and points into it by
// node, edge and claim id. The panel's walkthrough (walkthrough.tsx) reads it; the agent's version of
// this shape is decided later ("Decide the purpose and conflict data the agent produces").

/** Where a purpose claim comes from. Code sources point at the analysis's claims, which hold the lines. */
export type Source =
  | { kind: "description"; quote: string }
  | { kind: "issue"; number: number; title: string; quote: string }
  | { kind: "code"; claim: string };

/**
 * A statement about why or what for. `backed`: a stated source and the code agree. `stated`: only the
 * description or an issue says it (not found in code). `code`: only the code shows it.
 */
export interface PClaim {
  id: string;
  text: string;
  status: "backed" | "stated" | "code";
  sources: Source[];
}

/** One level of walkthrough: three short sentences. Each names the claims it rests on. */
export interface Walk {
  /** Where you are and what it's for. */
  intro: string;
  /** How it gets there: the route through the code, at this level. */
  journey: string;
  /** What it ends in: what is true once it's done. */
  destination: string;
  claims: string[];
}

/** A stop on a journey, in order: the next level down. Picking one drives the canvas. */
export type Stop =
  | { kind: "purpose"; id: string; line: string }
  | { kind: "node"; id: string; line: string }
  | { kind: "edge"; id: string; line: string };

export interface Purpose {
  id: string;
  name: string;
  parent?: string;
  /** "feature" | "process" | "security" | "fix" | "groundwork" …, a word for the reader. */
  kind: string;
  walk: Walk;
  stops: Stop[];
  /** Every node serving it, with its role in this purpose (one line). */
  serves: { node: string; role: string; claims: string[] }[];
  /** Edges that carry it, with why they exist for it. */
  edges: { edge: string; why: string; claims: string[] }[];
}

/** A node's walkthrough. Roles per purpose come from Purpose.serves. */
export interface NodeWalk {
  node: string;
  walk: Walk;
  /** How it's built: decisions, constraints, assumptions. */
  built: { kind: "decision" | "constraint" | "assumption"; text: string; claims: string[] }[];
  /** What it now does that it didn't (or one line, if unchanged). */
  now: string;
}

export interface EdgeWalk {
  edge: string;
  walk: Walk;
  /** What flows, and when. */
  flows: string;
  when: string;
  /** What depends on it: parts or purposes that break without it. */
  dependents: { text: string; node?: string; purpose?: string }[];
}

/** One side of a conflict: a fact and its source. */
export interface Fact {
  text: string;
  source: Source;
  purpose?: string;
}

export interface Conflict {
  id: string;
  kind: "stated-code" | "purpose-purpose" | "purpose-outside";
  /** A few words naming what the two facts are about. No verdict. */
  title: string;
  a: Fact;
  b: Fact;
  touches: { purposes: string[]; nodes: string[]; edges: string[] };
  /** The prototype made it up, where #2627 has none of this kind. */
  madeUp?: boolean;
}

export interface Purposes {
  /** The whole PR's walkthrough. */
  walk: Walk;
  /** Top-level purposes in reading order, then their sub-purposes by parent. */
  purposes: Purpose[];
  nodes: NodeWalk[];
  edges: EdgeWalk[];
  conflicts: Conflict[];
  claims: PClaim[];
  /** When the purposes can't be backed: what's missing (the panel then leads with All changes, by kind). */
  unbacked?: string;
}
