// A committed analysis of AdvanGrid/beghu#191 (a hand-written case in fixtures/pr-view/cases/, or
// a recorded version) served as the account's graph and claims, for a page: the stack's own graph
// is fetched (its envelope, ETag and caching as served), and its analysis swapped for the
// committed one as the server's split stores it (crates/server/src/analyses/stored.rs, `split`):
// each claim cut down to its stub, the claims whole at their own URL.
//
// Each account takes #191's first analysis once per reset (./dev-ctl analyse), and the stack's
// other accounts can't read the repo or belong to other specs, so the purpose view's cases reach
// the browser this way (#183).
//
// `stub` repeats the server's split rather than calling it (the browser suite reaches the server
// only over HTTP): purposes.spec.ts holds the two to one answer, the stack's own graph of the
// recorded v2 against `stub` over v2's claims.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page, Route } from "@playwright/test";

type Json = Record<string, any>;

export const GRAPH = "**/api/AdvanGrid/beghu/pulls/191/analysis";

/** A committed analysis: `cases/<name>.json`, or `beghu-191/analysis-v<n>.json` for `v1`, `v2`. */
export function committed(name: string): Json {
  const file = /^v\d$/.test(name) ? `beghu-191/analysis-${name}.json` : `cases/${name}.json`;
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../fixtures/pr-view/${file}`, import.meta.url)), "utf8")) as Json;
}

/** A claim as the graph holds it (`split`'s stub). */
export function stub(c: Json): Json {
  let code = 0, description = 0, issue = 0;
  const issues: string[] = [];
  for (const e of c.evidence as Json[]) {
    if (e.kind === "code") code++;
    else if (e.kind === "description") description++;
    else if (e.kind === "issue") {
      issue++;
      const r = `${e.repo}#${e.number}`;
      if (!issues.includes(r)) issues.push(r);
    }
  }
  return { id: c.id, status: c.status, code, description, issue, ...(issues.length ? { issues } : {}) };
}

/**
 * Serves `name` as #191's analysis on `page` (from its next load), with `edit` applied to the
 * analysis first, if given. Returns the analysis served.
 */
export async function serve(page: Page, name: string, edit?: (a: Json) => void): Promise<Json> {
  const a = committed(name);
  edit?.(a);
  const claims = a.claims as Json[];
  await page.route(GRAPH, async (route: Route) => {
    const res = await route.fetch();
    const g = (await res.json()) as Json;
    g.analysis = { ...a, claims: claims.map(stub) };
    // Its own claims file, so the view's cache never mixes it with the stack's.
    g.claimsUrl = `${g.claimsUrl}-${name}`;
    await route.fulfill({ response: res, json: g });
  });
  await page.route(`**/api/AdvanGrid/beghu/pulls/191/analysis/*/v*/claims-${name}`, (route: Route) => route.fulfill({ json: { id: "case", version: a.version, claims } }));
  return a;
}

/**
 * Offers `name` as a newer analysis of #191 on `page` (from its next load): the PR's detail says
 * one is ready, so the view shows its pill, and Show it reads the graph again and gets `name`
 * (with `edit` applied), as the stack's split would serve it. Returns the analysis offered.
 */
export async function serveNewer(page: Page, name: string, edit?: (a: Json) => void): Promise<Json> {
  const a = committed(name);
  edit?.(a);
  const claims = a.claims as Json[];
  const id = `e2e-newer-${name}`;
  let newer: number | undefined;
  await page.route("**/api/at/AdvanGrid/beghu/191", async (route: Route) => {
    const res = await route.fetch();
    const d = (await res.json()) as Json;
    if (d.pr?.analysis) {
      newer ??= d.pr.analysis.createdAt + 1;
      d.pr.analysis = { ...d.pr.analysis, id, createdAt: newer };
    }
    await route.fulfill({ response: res, json: d });
  });
  let reads = 0;
  await page.route(GRAPH, async (route: Route) => {
    const res = await route.fetch();
    const g = (await res.json()) as Json;
    // The first read is the analysis shown; Show it's is the newer one.
    if (reads++ > 0) {
      g.analysis = { ...a, claims: claims.map(stub) };
      g.id = id;
      g.createdAt = newer ?? g.createdAt + 1;
      g.claimsUrl = `${g.claimsUrl}-${name}`;
    }
    await route.fulfill({ response: res, json: g });
  });
  await page.route(`**/api/AdvanGrid/beghu/pulls/191/analysis/*/v*/claims-${name}`, (route: Route) => route.fulfill({ json: { id, version: a.version, claims } }));
  return a;
}
