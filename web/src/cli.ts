// The beghu CLI's side of the web app (server: crates/server/src/cli/): the setup page's "CLI
// sign-ins" (list, Revoke) and `/cli/login`'s read of a login by its code, Approve and Deny, all
// through `request`, so a failure is one of api.ts's named errors (`Gone` for a code that isn't a
// live login's, `Unreachable`, …). Never first-load JS: the setup page's chunk and the confirm
// page's import it.
import { query, revalidate } from "@solidjs/router";
import { request } from "./api";
import type { CliCode } from "./bindings/CliCode";
import type { CliSignIn } from "./bindings/CliSignIn";

export type { CliCode, CliSignIn };

/** The account's CLI sign-ins, the newest first. */
export const getCliSignIns = query(() => request<CliSignIn[]>("/api/cli/sign-ins"), "cli-sign-ins");

/**
 * Revokes one: its next call answers 401, and the CLI forgets it. Once the server took it, the
 * list is read again, so the setup page shown again later doesn't list it from the cache.
 */
export async function revokeSignIn(id: string): Promise<void> {
  await request<null>(`/api/cli/sign-ins/${encodeURIComponent(id)}`, { method: "DELETE" });
  void revalidate(getCliSignIns.key);
}

/** A code as typed: its letters, upper case, without spaces or the dash; "" when it can't be one. */
export function normaliseCode(raw: string): string {
  const c = raw.replace(/[\s-]/g, "").toUpperCase();
  return /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(c) ? c : "";
}

/** `BCDFGHJK` as the CLI prints it: `BCDF-GHJK`. */
export function shownCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The `beghu login` waiting with `code` (normalised). */
export const getCliCode = query((code: string) => request<CliCode>(`/api/cli/codes/${code}`), "cli-code");

/** Approves (as the browser's active account) or Denies the login with `code`. */
export async function decideCliLogin(code: string, approve: boolean): Promise<void> {
  await request<null>(`/api/cli/codes/${code}/${approve ? "approve" : "deny"}`, { method: "POST" });
}

/** The line that installs this deployment's CLI. */
export function installLine(): string {
  return `curl -fsSL ${location.origin}/cli/install.sh | sh`;
}

/** `beghu login`, naming this deployment unless it's the hosted one. */
export function loginLine(): string {
  return location.origin === "https://beghu.dev" ? "beghu login" : `beghu login --host ${location.origin}`;
}
