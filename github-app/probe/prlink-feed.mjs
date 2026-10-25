// Linked-PR probe, part 2 (wayfinder ticket #69): how fast a manual link reaches the repo issue-events feed, and what ETag polls cost.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { api } from "./app.mjs";
const R = JSON.parse(readFileSync(new URL("../../.dev/probe-prlink/results.json", import.meta.url)));
const { I, P } = R.setup;
const inst = (await api("/app/installations/170902907/access_tokens", { method: "POST" })).json.token;
const url = "https://api.github.com/repos/tomsjansons/beghu-scratch-pr-a/issues/events?per_page=5";
const get = (etag) => fetch(url, { headers: { authorization: `Bearer ${inst}`, accept: "application/vnd.github+json", ...(etag ? { "if-none-match": etag } : {}) } });
const gql = (m) => execFileSync("gh", ["api", "graphql", "-f", `query=mutation{${m}(input:{issueId:"${I.node_id}",pullRequestIds:["${P.pr_node}"]}){clientMutationId}}`]);
const out = [];
for (const [i, m] of ["addCloseIssueReferences", "removeCloseIssueReferences", "addCloseIssueReferences", "removeCloseIssueReferences"].entries()) {
  let r = await get(); let etag = r.headers.get("etag"); const top = (await r.json())[0]?.id;
  const rl0 = Number(r.headers.get("x-ratelimit-remaining"));
  const t0 = Date.now(); gql(m); const t1 = Date.now();
  let polls = 0, n304 = 0, seen = null;
  while (Date.now() - t0 < 120000) {
    r = await get(etag); polls++;
    if (r.status === 304) { n304++; } else { etag = r.headers.get("etag"); const j = await r.json(); if (j[0]?.id !== top) { seen = Date.now() - t0; break; } }
    await new Promise((s) => setTimeout(s, 250));
  }
  const rl1 = Number(r.headers.get("x-ratelimit-remaining"));
  out.push({ step: `${m} #${i + 1}`, mutation_ms: t1 - t0, feed_ms: seen, polls, n304, ratelimit_used: rl0 - rl1, poll_interval: r.headers.get("x-poll-interval"), cache: r.headers.get("cache-control") });
  console.log(JSON.stringify(out.at(-1)));
  await new Promise((s) => setTimeout(s, 5000));
}
