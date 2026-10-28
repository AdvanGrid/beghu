// The tab's account, and whether the browser still uses it. URLs carry no account: a tab is on
// the account that was active when it loaded (the `beghu_acct` hint cookie), and says so on every
// API request (`X-Beghu-Account`) and its stream (`?account=`). Once the browser's active account
// is another (a switch, a sign-in or a sign-out in another tab, Disconnect elsewhere), or the
// account lost access to GitHub, the tab is **stale**: the top banner says so, writes freeze,
// and drafts stay where they are, to copy out. It learns from the server's `switched` (an answer
// or a push), and checks the cookie itself whenever it gets focus or becomes visible.
import { createSignal } from "solid-js";

/** Why the tab's account is no longer the one it can use. */
export type Stale = "switched" | "signed_out" | "sign_in_again";

/** The account `beghu_acct` names now; undefined with none signed in. */
export function cookieAccount(): number | undefined {
  const m = /(?:^|;\s*)beghu_acct=(\d+)/.exec(document.cookie);
  return m ? Number(m[1]) : undefined;
}

const mine = cookieAccount();
const [stale, setStale] = createSignal<Stale>();

/** Whether beghu has answered the tab as its account yet: from then on the tab holds a view. */
let answered = false;

/**
 * A tab that has shown nothing yet holds no view and no drafts: once the cookie names another
 * account (beghu puts it right on every answer), it loads afresh as that one rather than go
 * stale. Returns whether it does. It can't loop: the reloaded tab is on the cookie's account.
 */
function reloadIfBlank(): boolean {
  const now = cookieAccount();
  if (answered || now === undefined || now === mine) return false;
  location.reload();
  return true;
}

/** Why the tab is stale; undefined while its account is the browser's active one. */
export { stale };

/** The tab's account, as the browser's active one when it loaded. */
export function tabAccount(): number | undefined {
  return mine;
}

/** What every API request carries: the tab's account. */
export function accountHeaders(): Record<string, string> {
  return mine === undefined ? {} : { "x-beghu-account": String(mine) };
}

/**
 * The browser's active account is now `now` (`null`: nothing is signed in): the tab is stale
 * unless that's its own. The first reason found stands.
 */
export function noteActive(now: number | null): void {
  if (stale() || now === mine || reloadIfBlank()) return;
  setStale(now === null ? "signed_out" : "switched");
}

/** The server answered `switched` without saying to whom: the cookie says. */
export function noteSwitched(): void {
  if (stale() || reloadIfBlank()) return;
  setStale(cookieAccount() === undefined ? "signed_out" : "switched");
}

/** The tab's account lost access to GitHub: it must sign in again. */
export function noteSignInAgain(): void {
  if (!stale()) setStale("sign_in_again");
}

/** beghu answered a request of the tab's: it has a view, maybe drafts, from now on. */
export function noteAnswered(): void {
  answered = true;
}

/**
 * beghu answered the tab's account signed out (401). Once the tab holds a view, that makes it
 * stale rather than leave for sign-in, so its drafts stay: by the cookie, the browser signed out
 * or switched in another tab, or the account must sign in again. Returns whether it did; a tab
 * that has shown nothing yet goes to sign in.
 */
export function noteSignedOut(): boolean {
  if (mine === undefined || !answered) return false;
  if (!stale()) {
    const now = cookieAccount();
    setStale(now === undefined ? "signed_out" : now !== mine ? "switched" : "sign_in_again");
  }
  return true;
}

function check(): void {
  if (mine === undefined) return;
  const now = cookieAccount();
  if (now !== mine) noteActive(now ?? null);
}

addEventListener("focus", check);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") check();
});

// A page restored from the back-forward cache after a sign-out or a switch never shows the old
// account's data: it's hidden at once and loaded afresh.
addEventListener("pageshow", (e) => {
  if (e.persisted && mine !== undefined && cookieAccount() !== mine) {
    document.body.hidden = true;
    location.replace(location.href);
  }
});
