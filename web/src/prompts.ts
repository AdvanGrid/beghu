// The prompts this browser keeps for Copy again (the PR panel's Analyse button, Analyse.tsx). The
// server keeps only a run token's hash, so it can't hand a prompt back: the tab that starts a run
// keeps its prompt in `localStorage`, under the account, the PR and the run
// (`beghu.prompt.<account>.<owner/repo#n>.<run>`), with the run's start and expiry (the server's
// Unix seconds) and when it was kept (this browser's `Date.now()`). Another browser holds none,
// and offers Copy a new link instead.
//
// A prompt holds the run's token, so it goes as soon as it can't be used:
// - when the PR's detail shows its run no longer live (ended, expired, or superseded by a newer
//   one), in any tab of this browser that shows the PR (`promptsSeen`, runs.ts);
// - when its account signs out, is disconnected or loses access, as the tab learns it (account.ts,
//   AccountMenu.tsx), and when `/api/me` no longer lists it among the browser's accounts (api.ts);
// - when the app loads: every one whose run has expired, and every one when nothing is signed in
//   ([`sweepPrompts`], account.ts).
//
// This module is first-load code (the load sweep, sign-out and `/api/me` need it), so it holds
// only what they do and imports nothing. Keeping, reading and the detail's checks are the PR
// panel's chunk's (runs.ts).

/** A kept prompt, as stored. */
export interface Kept {
  /** The prompt. */
  p: string;
  /** The run's start and expiry, Unix seconds on the server's clock. */
  s: number;
  e: number;
  /** When this browser kept it, just after the server started the run: `Date.now()`. */
  k: number;
}

export const ROOT = "beghu.prompt.";

/**
 * How much longer than its run's lifetime a prompt outlives, by this browser's clock, before the
 * load sweep drops it. The sweep compares the time gone by since the prompt was kept with the
 * run's lifetime (both from the server's times), so a browser clock that's wrong but steady
 * changes nothing; this is for one that's set (jumps) meanwhile. A prompt kept past its run is a
 * dead token, which the server refuses, and the PR's detail drops it when seen: the sweep only
 * tidies, so it errs long.
 */
const CLOCK_MARGIN_S = 6 * 3600;

export function parse(raw: string | null): Kept | undefined {
  if (raw === null) return undefined;
  try {
    const k = JSON.parse(raw) as Kept;
    return typeof k.p === "string" && typeof k.s === "number" && typeof k.e === "number" && typeof k.k === "number" ? k : undefined;
  } catch {
    return undefined;
  }
}

/** Every kept prompt's key, with its account. Storage refused: none. */
export function keys(): { key: string; account: number }[] {
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

export function remove(gone: string[]): void {
  try {
    for (const k of gone) localStorage.removeItem(k);
  } catch {
    // Storage refused: nothing was kept there either.
  }
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
 * of runs that have expired go, and any not kept in this module's form. A run has expired when
 * more time has gone by since its prompt was kept than it had left then (its expiry less its
 * start), with [`CLOCK_MARGIN_S`] on top.
 */
export function sweepPrompts(account: number | undefined): void {
  if (account === undefined) return forgetAccountPrompts();
  const now = Date.now();
  const gone: string[] = [];
  for (const { key } of keys()) {
    let kept: Kept | undefined;
    try {
      kept = parse(localStorage.getItem(key));
    } catch {
      return;
    }
    if (!kept || (now - kept.k) / 1000 > kept.e - kept.s + CLOCK_MARGIN_S) gone.push(key);
  }
  remove(gone);
}
