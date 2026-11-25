// The PR panel's analysis runs (`analyses/` on the server): starting one, which answers the
// prompt to copy, and ending the PR's live one. Both go through `request`, so a failure is one of
// api.ts's named errors (`PrTooLarge`, `GitHubDown`, `Unreachable`, …). Part of the PR panel's
// chunk, never first-load.
//
// **Kept prompts.** The server keeps only the run token's hash, so it can't hand a prompt back.
// The tab that starts a run keeps its prompt in `localStorage`, under the account, the PR and the
// run, for Copy again; it's deleted once the PR's detail shows that run no longer live (ended,
// expired or superseded), in any tab of this browser that shows the PR. Another browser holds
// none, and offers Copy a new link instead.
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

/** Where the account's kept prompts for the PR live: one key per run under this prefix. */
function prefix(account: number, p: PrAt): string {
  return `beghu.prompt.${account}.${p.owner.toLowerCase()}/${p.repo.toLowerCase()}#${p.number}.`;
}

/** The prompt this browser kept for the run, if it did. */
export function keptPrompt(account: number, p: PrAt, run: string): string | undefined {
  try {
    return localStorage.getItem(prefix(account, p) + run) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the run's prompt, for Copy again. Storage refused (private mode, full): kept nowhere. */
export function keepPrompt(account: number, p: PrAt, run: string, prompt: string): void {
  try {
    localStorage.setItem(prefix(account, p) + run, prompt);
  } catch {
    // The button offers Copy a new link instead.
  }
}

/** Deletes every prompt kept for the PR but the live run's (none: all of them). */
export function forgetPrompts(account: number, p: PrAt, live?: string): void {
  try {
    const at = prefix(account, p);
    const gone: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(at) && k !== at + live) gone.push(k);
    }
    for (const k of gone) localStorage.removeItem(k);
  } catch {
    // Nothing kept, or nothing to delete it from.
  }
}
