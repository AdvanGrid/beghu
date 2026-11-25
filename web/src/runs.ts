// The PR panel's analysis runs (`analyses/` on the server): starting one, which answers the
// prompt to copy, and ending the PR's live one, both through `request`, so a failure is one of
// api.ts's named errors (`PrTooLarge`, `GitHubDown`, `Unreachable`, …); and the prompts this
// browser keeps for Copy again: keeping and reading them, and dropping those the PR's detail shows
// can't be used any more. Part of the PR panel's chunk, never first-load: what the load sweep and
// sign-out need of the kept prompts is prompts.ts's, which says how they're kept.
import { request } from "./api";
import type { RunStarted } from "./bindings/RunStarted";
import { keys, parse, remove, ROOT, type Kept } from "./prompts";

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

/** A run as the PR's detail shows it: enough to know whether a kept prompt is still of use. */
export interface SeenRun {
  id: string;
  state: string;
  startedAt: number;
  expiresAt: number;
}

/**
 * How long a kept prompt outlives a detail that doesn't show its run, when when that read began
 * isn't known: a read begun before the run started may land after it was kept.
 */
const FRESH_MS = 15_000;

function prefix(account: number, p: PrAt): string {
  return `${ROOT}${account}.${p.owner.toLowerCase()}/${p.repo.toLowerCase()}#${p.number}.`;
}

/** The prompt this browser kept for the run, if it did. */
export function keptPrompt(account: number, p: PrAt, run: string): string | undefined {
  try {
    return parse(localStorage.getItem(prefix(account, p) + run))?.p;
  } catch {
    return undefined;
  }
}

/** Keeps the run's prompt, for Copy again. Storage refused (private mode, full): kept nowhere. */
export function keepPrompt(account: number, p: PrAt, run: string, prompt: string, startedAt: number, expiresAt: number): void {
  try {
    const kept: Kept = { p: prompt, s: startedAt, e: expiresAt, k: Date.now() };
    localStorage.setItem(prefix(account, p) + run, JSON.stringify(kept));
  } catch {
    // The button offers Copy a new link instead.
  }
}

/** Deletes every prompt kept for the PR but `except`'s (none: all of them). */
export function forgetPrompts(account: number, p: PrAt, except?: string): void {
  const at = prefix(account, p);
  remove(
    keys()
      .map((k) => k.key)
      .filter((k) => k.startsWith(at) && k !== at + except),
  );
}

/**
 * The PR's detail, read from `readStart` (`Date.now()`'s clock; not finite when unknown), shows
 * `run` (its latest, live or expired; none when there's neither): the prompts it shows can't be
 * used any more go. That's the run's own once it isn't live, and any other run's that started
 * before it by the server's clock (superseded). Another the detail doesn't show goes too if the
 * read began after it was kept (it ended, or a run started in the same second superseded it), or,
 * not knowing when, unless it was kept just now. A live run's prompt takes its expiry as it
 * stands. Only for a detail that read the PR's runs: one that couldn't (`run_unknown`) says
 * nothing of them.
 */
export function promptsSeen(account: number, p: PrAt, run: SeenRun | undefined, readStart: number): void {
  const at = prefix(account, p);
  const now = Date.now();
  const gone: string[] = [];
  for (const { key } of keys()) {
    if (!key.startsWith(at)) continue;
    let kept: Kept | undefined;
    try {
      kept = parse(localStorage.getItem(key));
    } catch {
      return;
    }
    if (!kept) {
      gone.push(key);
      continue;
    }
    const id = key.slice(at.length);
    if (run && id === run.id) {
      if (run.state === "expired") gone.push(key);
      else if (kept.e !== run.expiresAt) {
        try {
          localStorage.setItem(key, JSON.stringify({ ...kept, e: run.expiresAt }));
        } catch {
          // Kept as it was: the load sweep may drop it early, and Copy a new link replaces it.
        }
      }
    } else if ((run && run.startedAt > kept.s) || (Number.isFinite(readStart) ? readStart > kept.k : now - kept.k > FRESH_MS)) gone.push(key);
  }
  remove(gone);
}
