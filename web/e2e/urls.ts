// An issue's URL in the app, as GitHub's: `/acme/web/issues/12`, `/acme/web/pull/7` for a PR
// (web/src/at.ts). Its id never shows in one; a test that has only an id reads where it is first.
import type { APIRequestContext, Page } from "@playwright/test";

/** Where an issue or PR is: what its URL names. `kind` is `issue` without one. */
export type Where = { owner: string; repo: string; number: number; kind?: string };

/** The issue's path in the app, with `search` after it. */
export function issueUrl(i: Where, search = ""): string {
  return `/${i.owner}/${i.repo}/${i.kind === "pr" ? "pull" : "issues"}/${i.number}${search}`;
}

/** Focus view's `focus=` value for the issue, as the app writes it: `acme/web/12`. */
export function focusOf(i: Where): string {
  return `${i.owner}/${i.repo}/${i.number}`;
}

/** `s` as a RegExp source matching it literally. */
export function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The issue's path as a RegExp source, for `toHaveURL`. */
export function urlRe(i: Where, search = ""): string {
  return esc(issueUrl(i, search));
}

/** The API `first read` of an issue opened at its URL: its detail by where it is. */
export function atApi(i: Where): string {
  return `/api/at/${i.owner}/${i.repo}/${i.number}`;
}

/** Where the issue with id `id` is, from its detail. */
export async function whereIs(from: Page | APIRequestContext, id: number): Promise<Where & { id: number }> {
  const request = "request" in from ? from.request : from;
  const res = await request.get(`/api/issues/${id}`);
  if (!res.ok()) throw new Error(`issue ${id}: ${res.status()}`);
  const d = (await res.json()) as { id: number; owner: string; repo: string; number: number; kind: string };
  return { id: d.id, owner: d.owner, repo: d.repo, number: d.number, kind: d.kind };
}

/** The URL of the issue with id `id`, with `search` after it. */
export async function urlOf(from: Page | APIRequestContext, id: number, search = ""): Promise<string> {
  return issueUrl(await whereIs(from, id), search);
}
