// The PR panel's analysis runs (`analyses/` on the server): starting one, which answers the
// prompt to copy, and ending the PR's live one. Both go through `request`, so a failure is one of
// api.ts's named errors (`PrTooLarge`, `GitHubDown`, `Unreachable`, …). Part of the PR panel's
// chunk, never first-load. The prompts kept for Copy again are prompts.ts's.
import { request } from "./api";
import type { RunStarted } from "./bindings/RunStarted";

/** A PR, as a run names it. */
export interface PrAt {
  owner: string;
  repo: string;
  number: number;
}

const path = (p: PrAt) => `/api/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.repo)}/pulls/${p.number}`;

/** Starts a run on the PR, superseding its live one: the run and the prompt to paste. */
export function startRun(p: PrAt): Promise<RunStarted> {
  return request<RunStarted>(`${path(p)}/runs`, { method: "POST" });
}

/** Ends the PR's live run, if it has one. */
export async function endRun(p: PrAt): Promise<void> {
  await request<null>(`${path(p)}/run`, { method: "DELETE" });
}
