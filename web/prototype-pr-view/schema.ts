// PROTOTYPE (PR view). The shape of one PR analysis: the system graph at the PR's base and head,
// merged into one graph where every element says how the PR changed it, plus the claims that back
// every statement with code lines. The analysing agent writes it (ANALYSIS.md), validate.ts
// checks it, and the page (main.tsx) renders it.

/** How the PR changed an element: the head graph compared with the base graph. */
export type Change = "added" | "removed" | "modified" | "unchanged";

export interface Analysis {
  version: 1;
  pr: Pr;
  /** What the agent read, skipped and couldn't do: honest coverage, shown to the reader. */
  coverage: Coverage;
  /** The dimensions nodes and edges are described by, discovered in this repo. */
  facets: Facet[];
  nodes: Node[];
  edges: Edge[];
  boundaries: Boundary[];
  scenarios: Scenario[];
  claims: Claim[];
}

export interface Pr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  /** The PR's own description, verbatim, for the reader to hold the graph against. Never an input. */
  description: string;
  baseSha: string;
  headSha: string;
  stats: { files: number; additions: number; deletions: number };
}

export interface Coverage {
  /** One or two sentences: how much of the change the analysis covers. */
  summary: string;
  /** Files not read line by line, grouped (generated code, lockfiles, translations, fixtures). */
  skipped: { what: string; reason: string; files: number }[];
  /** Anything else the reader should know about the analysis's limits. */
  notes: string[];
}

/**
 * A facet: one question every node (or edge) answers from a set of values discovered in this
 * repo, such as "How is effectful code written?" with "Effect", "plain async/await".
 */
export interface Facet {
  id: string;
  name: string;
  /** The question the facet answers, for the reader. */
  question: string;
  appliesTo: "node" | "edge";
  /** Whether one element can hold more than one value (responsibility kinds can). */
  multi: boolean;
  values: FacetValue[];
}

export interface FacetValue {
  id: string;
  label: string;
  /** Two to four characters shown beside the colour, so colour is never the only cue. */
  prefix: string;
  description: string;
}

/** An element's value(s) for one facet, backed by claims. */
export interface FacetAssignment {
  facet: string;
  values: string[];
  /** The values at base, when the PR changed them. */
  was?: string[];
  claims: string[];
}

export type NodeKind = "system" | "service" | "app" | "library" | "module" | "store" | "external" | "actor";

export interface Node {
  id: string;
  name: string;
  kind: NodeKind;
  /** The enclosing node in the zoom hierarchy (system → service → module). */
  parent?: string;
  /** The code the node is, as repo paths (directories or files). Empty only for external and actor nodes. */
  paths: string[];
  /** One line: what this is, from the code. */
  summary: string;
  change: Change;
  /** One line: what the PR did to it. Present unless unchanged. */
  changeSummary?: string;
  responsibilities: Responsibility[];
  facets: FacetAssignment[];
  /** The boundary zone the node sits in, if any. */
  zone?: string;
  questions: Question[];
  /** The PR's files under this node (only for the deepest node that holds each file). */
  files: FileChange[];
}

export interface Responsibility {
  id: string;
  /** What the node does, in a few words ("sends report emails through Gmail"). */
  text: string;
  change: Change;
  claims: string[];
}

export interface FileChange {
  path: string;
  status: "added" | "removed" | "modified" | "renamed";
  additions: number;
  deletions: number;
  /** Generated, vendored or lock files: listed, not explained. */
  generated?: boolean;
  /** One line: what the change in this file does. */
  summary?: string;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  kind: "call" | "data" | "event" | "dependency";
  /** A few words, shown on the line. */
  label: string;
  /** What flows, in a few words ("probe session rows", "OpenAI chat requests"). */
  data?: string;
  mode: "sync" | "async" | "n/a";
  change: Change;
  changeSummary?: string;
  /** The boundaries this edge crosses. */
  crosses: string[];
  facets: FacetAssignment[];
  questions: Question[];
  claims: string[];
}

export interface Boundary {
  id: string;
  name: string;
  kind: "trust" | "process" | "network" | "tenant" | "other";
  /** One line: what is on each side. */
  description: string;
  change: Change;
  claims: string[];
}

/** An ordered path through the graph: which things happen in which order. */
export interface Scenario {
  id: string;
  name: string;
  /** What starts it ("an admin starts a probe from the audit page"). */
  trigger: string;
  change: Change;
  /** Every hop, in order, each naming the deepest node it happens in. No limit on the count: the
   * view folds steps inside a part and folds chapters. */
  steps: Step[];
  /** The flow cut into moments, in order, covering every step. The first starts at step 0. */
  chapters: Chapter[];
}

/** One moment of a flow: it ends where the flow hands over (a person acts, a write is picked up
 * later by another part, a deploy stage ends). Usually 2–6 steps. */
export interface Chapter {
  /** What happens in it, as a short sentence ("advagent-v3 takes the message and replies"). */
  title: string;
  /** The 0-based index of its first step; each chapter runs to the next one's `from`. */
  from: number;
}

export interface Step {
  from: string;
  to: string;
  /** What happens, in a few words. */
  action: string;
  data?: string;
  edge?: string;
  change: Change;
  claims: string[];
}

export type Topic = "change" | "design" | "dependencies" | "security" | "data" | "interaction" | "failure" | "organisation";

export interface Question {
  topic: Topic;
  q: string;
  /** At most two short sentences of fact. */
  a: string;
  claims: string[];
}

/** A statement of fact about the code, and the lines that show it. */
export interface Claim {
  id: string;
  text: string;
  /** supported: the evidence shows it. undetermined: the agent couldn't tell (lookedAt says where it looked). */
  status: "supported" | "undetermined";
  evidence: Evidence[];
  lookedAt?: string;
}

export interface Evidence {
  side: "base" | "head";
  path: string;
  /** 1-based, inclusive. */
  start: number;
  end: number;
  /** What these lines show. */
  note: string;
  /** The exact lines start..end (at most 25 lines; trim the range rather than the text). */
  snippet: string;
}
