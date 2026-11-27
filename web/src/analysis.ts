// The PR view's first read, in first-load code so the router can start it alongside the view's
// chunk (router.tsx): the analysis graph, `GET /api/{owner}/{repo}/pulls/{n}/analysis`. Everything
// else of the view (its claims, its model, its panel) is in its own chunk, `pr-view/`.
//
// The graph is the server's stored blob as is (crates/server/src/analyses/stored.rs, `split`):
// an envelope naming the analysis, and the analysis with each claim cut down to its ID, its
// status and how many evidence items of each kind it holds. The claims, whole, are at the
// envelope's `claimsUrl`. The server builds the envelope as JSON, not from a ts-rs type, so its
// shape is written here, after `split`'s.
import { query } from "@solidjs/router";
import { untrack } from "solid-js";
import { getIssue, getIssueAt, request, type IssueDetail } from "./api";
import { atString, idAt, type At } from "./at";
import type { Analysis, Claim, ClaimStatus } from "./bindings/analysis";

/** A claim as the graph holds it: enough for its status and chips such as `code ×3`. */
export type ClaimStub = { id: string; status: ClaimStatus; code: number; description: number; issue: number };

/** The analysis as the graph holds it: every claim a stub. */
export type GraphAnalysis = Omit<Analysis, "claims"> & { claims: ClaimStub[] };

/** An ID a schema migration renamed (`migratedIds`): old URLs forward to it silently. */
export type MigratedId = { old: string; new: string; step: number };

/** `GET /api/{owner}/{repo}/pulls/{n}/analysis`'s answer. */
export interface Graph {
  /** The analysis's ID: an `analysis` push naming another means a newer upload. */
  id: string;
  /** Its schema version, as stored (migrated on read). */
  version: number;
  /** `owner/name`. */
  repo: string;
  number: number;
  /** The head it was made at. */
  headSha: string;
  mergeBase: string;
  /** Unix seconds. */
  createdAt: number;
  /** Whether the uploader's tool checked every snippet against the checkouts (`Beghu-Snippets`). */
  snippets: "checked" | "not-checked";
  /** Where its claims are, per analysis and version (immutable). */
  claimsUrl: string;
  migratedIds: MigratedId[];
  /** The analysis this one replaced (an upload over an earlier one), or null for the PR's first. */
  previous?: string | null;
  analysis: GraphAnalysis;
}

/** The claims file at a graph's `claimsUrl`. */
export interface Claims {
  id: string;
  version: number;
  claims: Claim[];
}

/** The PR view's path: `/acme/web/pull/7/view`. */
export function viewPath(a: At): string {
  return `/${a.owner}/${a.repo}/pull/${a.number}/view`;
}

/** Whether an app path is a PR view's (`/acme/web/pull/7/view`). */
export function isViewPath(path: string): boolean {
  return /^\/[^/]+\/[^/]+\/pull\/[^/]+\/view$/.test(path);
}

/** The graph's URL for a PR (`atString`'s form): what the shell preloads (crates/server/src/shell.rs). */
export function graphUrl(where: string): string {
  const [owner = "-", repo = "-", number = "-"] = where.split("/");
  return `/api/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/analysis`;
}

/**
 * The PR's analysis graph, by where the PR is (`atString`'s form). `NoAnalysis` when the account
 * has none, `AnalysisMigrationFailed` when beghu couldn't bring it to its schema. The browser
 * revalidates it (`ETag`, `no-cache`): a revisit costs a `304`.
 */
export const getGraph = query((where: string) => request<Graph>(graphUrl(where)), "analysisGraph");

/**
 * The reads the last route preload of a visit started (a cold load's or a navigation's, not a
 * hover's), until the view takes each (`takePreloaded`). Every visit's preload replaces it, and
 * the view's first ask for any other PR drops it, so what the view takes is always its own
 * visit's, never an abandoned visit's kept for a later one: no age to check, which on a loaded
 * machine (the view's chunk slow to arrive) would only fetch everything twice.
 */
let handoff: { where: string; graph?: Promise<Graph>; detail?: Promise<IssueDetail> } | undefined;

/**
 * The PR view's route preload (router.tsx): the graph's fetch and the PR's detail's, started
 * alongside the view's chunk. On a visit, the view takes both promises as they are
 * (`takePreloaded`), rather than asking the query cache again: the live stream's opening `reset`
 * clears that cache, which on a cold load lands between the preload and the view's first read,
 * and would fetch them twice. A hover's preload (`intent` `preload`) only warms the query cache,
 * which the view reads if it's still there: a hover may be minutes before the visit.
 */
export function preloadView(a: At, intent: "initial" | "native" | "navigate" | "preload"): void {
  const where = atString(a);
  const graph = getGraph(where);
  // A failed preload is the view's to show: it reads the same promise.
  graph.catch(() => {});
  const id = untrack(() => idAt(a));
  const detail = id === undefined ? getIssueAt(where) : getIssue(id);
  detail.catch(() => {});
  if (intent !== "preload") handoff = { where: where.toLowerCase(), graph, detail };
}

/**
 * The read of `part` the visit's route preload started for `where`, once. Asked for another PR,
 * it drops the handoff: that visit's view never came, and a later one starts its own.
 */
export function takePreloaded<K extends "graph" | "detail">(where: string, part: K): NonNullable<NonNullable<typeof handoff>[K]> | undefined {
  const h = handoff;
  if (!h) return undefined;
  if (h.where !== where.toLowerCase()) {
    handoff = undefined;
    return undefined;
  }
  const got = h[part];
  h[part] = undefined;
  if (!h.graph && !h.detail) handoff = undefined;
  return got as NonNullable<NonNullable<typeof handoff>[K]> | undefined;
}
