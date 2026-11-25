// The prompts this browser keeps for Copy again (the PR panel's Analyse button, Analyse.tsx). The
// server keeps only a run token's hash, so it can't hand a prompt back: the tab that starts a run
// keeps its prompt in `localStorage`, under the account, the PR and the run
// (`beghu.prompt.<account>.<owner/repo#n>.<run>`), with the run's start and expiry (the server's
// Unix seconds) and when it was kept (this browser's clock). Another browser holds none, and
// offers Copy a new link instead.
//
// A prompt holds the run's token, so it goes as soon as it can't be used:
// - when the PR's detail shows its run no longer live (ended, expired, or superseded by a newer
//   one), in any tab of this browser that shows the PR ([`promptsSeen`]);
// - when its account signs out, is disconnected or loses access, as the tab learns it (account.ts,
//   AccountMenu.tsx), and when `/api/me` no longer lists it among the browser's accounts (api.ts);
// - when the app loads: every expired prompt, and every one when nothing is signed in
//   ([`sweepPrompts`], account.ts).
//
// First-load code (the load sweep and sign-out need it), so it imports nothing.

/** A PR, as a prompt is kept under it. */
export interface PromptPr {
  owner: string;
  repo: string;
  number: number;
}

/** A run as the PR's detail shows it: enough to know whether a kept prompt is still of use. */
export interface SeenRun {
  id: string;
  state: string;
  startedAt: number;
  expiresAt: number;
}

interface Kept {
  /** The prompt. */
  p: string;
  /** The run's start and expiry, Unix seconds on the server's clock. */
  s: number;
  e: number;
  /** When this browser kept it: ms on its own clock (`performance.timeOrigin + performance.now()`). */
  k: number;
}

const ROOT = "beghu.prompt.";
/**
 * How long a kept prompt outlives a detail that doesn't show its run, when when that read began
 * isn't known: a read begun before the run started may land after it was kept.
 */
const FRESH_MS = 15_000;

/** Now, on the clock `Kept.k` and a read's start are on: ms, comparable across this browser's tabs. */
export function wallNow(): number {
  return performance.timeOrigin + performance.now();
}

function prefix(account: number, p: PromptPr): string {
  return `${ROOT}${account}.${p.owner.toLowerCase()}/${p.repo.toLowerCase()}#${p.number}.`;
}

function parse(raw: string | null): Kept | undefined {
  if (raw === null) return undefined;
  try {
    const k = JSON.parse(raw) as Kept;
    return typeof k.p === "string" && typeof k.s === "number" && typeof k.e === "number" && typeof k.k === "number" ? k : undefined;
  } catch {
    return undefined;
  }
}

/** Every kept prompt's key, with its account. Storage refused: none. */
function keys(): { key: string; account: number }[] {
  const out: { key: string; account: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(ROOT)) continue;
      const m = /^(\d+)\./.exec(key.slice(ROOT.length));
      out.push({ key, account: m ? Number(m[1]) : NaN });
    }
  } catch {
    // Nothing kept, or nothing to read it from.
  }
  return out;
}

function remove(gone: string[]): void {
  try {
    for (const k of gone) localStorage.removeItem(k);
  } catch {
    // Storage refused: nothing was kept there either.
  }
}

/** The prompt this browser kept for the run, if it did. */
export function keptPrompt(account: number, p: PromptPr, run: string): string | undefined {
  try {
    return parse(localStorage.getItem(prefix(account, p) + run))?.p;
  } catch {
    return undefined;
  }
}

/** Keeps the run's prompt, for Copy again. Storage refused (private mode, full): kept nowhere. */
export function keepPrompt(account: number, p: PromptPr, run: string, prompt: string, startedAt: number, expiresAt: number): void {
  try {
    const kept: Kept = { p: prompt, s: startedAt, e: expiresAt, k: wallNow() };
    localStorage.setItem(prefix(account, p) + run, JSON.stringify(kept));
  } catch {
    // The button offers Copy a new link instead.
  }
}

/** Deletes every prompt kept for the PR but `except`'s (none: all of them). */
export function forgetPrompts(account: number, p: PromptPr, except?: string): void {
  const at = prefix(account, p);
  remove(
    keys()
      .map((k) => k.key)
      .filter((k) => k.startsWith(at) && k !== at + except),
  );
}

/**
 * The PR's detail, read from `readStart` (`wallNow`'s clock; not finite when unknown), shows
 * `run` (its latest, live or expired; none when there's neither): the prompts it shows can't be
 * used any more go. That's the run's own once it isn't live, and any other run's that started
 * before it by the server's clock (superseded). Another the detail doesn't show goes too if the
 * read began after it was kept (it ended, or a run started in the same second superseded it), or,
 * not knowing when, unless it was kept just now. A live run's prompt takes its expiry as it
 * stands.
 */
export function promptsSeen(account: number, p: PromptPr, run: SeenRun | undefined, readStart: number): void {
  const at = prefix(account, p);
  const now = wallNow();
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

/** Deletes every prompt kept for `account`, or for every account. */
export function forgetAccountPrompts(account?: number): void {
  remove(
    keys()
      .filter((k) => account === undefined || k.account === account)
      .map((k) => k.key),
  );
}

/** The browser's accounts are `accounts` (`/api/me`): every other's kept prompts go. */
export function keepPromptsOf(accounts: readonly number[]): void {
  remove(
    keys()
      .filter((k) => !accounts.includes(k.account))
      .map((k) => k.key),
  );
}

/**
 * The app loaded as `account` (undefined: nothing signed in, so every prompt goes): the prompts
 * of runs that have expired go, and any not kept in this module's form.
 */
export function sweepPrompts(account: number | undefined): void {
  if (account === undefined) return forgetAccountPrompts();
  const now = Date.now() / 1000;
  const gone: string[] = [];
  for (const { key } of keys()) {
    let kept: Kept | undefined;
    try {
      kept = parse(localStorage.getItem(key));
    } catch {
      return;
    }
    if (!kept || kept.e <= now) gone.push(key);
  }
  remove(gone);
}
