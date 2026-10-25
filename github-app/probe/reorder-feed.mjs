// Sub-issue reorder probe (wayfinder ticket #70): do reorders and re-parents made outside beghu reach the repo issue-events feed?
// Per step: ETag-poll /issues/events with the installation token, plus updated_at, GitHub's delivery log and the parent's timeline.
// node github-app/probe/reorder-feed.mjs          run the API steps
// node github-app/probe/reorder-feed.mjs watch    poll both feeds for 3 min and print every new event (for a UI drag)
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { api } from "./app.mjs";
const DIR = new URL("../../.dev/probe-reorder/", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });
const OWNER = "tomsjansons", RA = "beghu-scratch-pr-a", RB = "beghu-scratch-pr-b", OUT = DIR + "results.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gh = (...a) => execFileSync("gh", a, { encoding: "utf8" });
const ghj = (...a) => JSON.parse(gh(...a) || "null");
const gql = (q) => { const r = spawnSync("gh", ["api", "graphql", "-f", `query=${q}`], { encoding: "utf8" }); const j = JSON.parse(r.stdout || "null"); if (j?.errors) console.error(JSON.stringify(j.errors)); return j; };
const R = existsSync(OUT) ? JSON.parse(readFileSync(OUT)) : {};
const save = () => writeFileSync(OUT, JSON.stringify(R, null, 2));
const inst = (await api("/app/installations/170902907/access_tokens", { method: "POST" })).json.token;

const feedUrl = (repo) => `https://api.github.com/repos/${OWNER}/${repo}/issues/events?per_page=20`;
const feed = (repo, etag) => fetch(feedUrl(repo), { headers: { authorization: `Bearer ${inst}`, accept: "application/vnd.github+json", ...(etag ? { "if-none-match": etag } : {}) } });
const brief = (e) => ({ id: e.id, event: e.event, issue: e.issue?.number, created_at: e.created_at, keys: Object.keys(e).filter((k) => !["id", "node_id", "url", "actor", "event", "commit_id", "commit_url", "created_at", "issue", "performed_via_github_app"].includes(k)) });
const top = async (repo) => { const r = await feed(repo); return { etag: r.headers.get("etag"), top: (await r.json())[0]?.id ?? 0 }; };

const item = (repo, n) => { const i = ghj("api", `repos/${OWNER}/${repo}/issues/${n}`); return { repo, n, id: i.id, node_id: i.node_id }; };
const create = (repo, title) => item(repo, Number(gh("issue", "create", "-R", `${OWNER}/${repo}`, "-t", title, "-b", "Throwaway issue for wayfinder ticket #70.").trim().split("/").pop()));
const iss = (x) => `repos/${OWNER}/${x.repo}/issues/${x.n}`;
const updated = (xs) => Object.fromEntries(xs.map((x) => [`${x.repo}#${x.n}`, ghj("api", iss(x)).updated_at]));
const order = (p) => ghj("api", `${iss(p)}/sub_issues`).map((c) => `${c.repository_url.split("/").pop()}#${c.number}`);
const timeline = (p) => ghj("api", `${iss(p)}/timeline?per_page=100`).slice(-4).map((e) => ({ event: e.event, created_at: e.created_at }));
const deliveries = async (t0) => (await api("/app/hook/deliveries?per_page=50")).json
  .filter((d) => Date.parse(d.delivered_at) >= t0 - 2000).map((d) => ({ event: d.event, action: d.action, repo: d.repository_id }));

// Poll both repos' feeds every 250 ms until each shows something above its old top, or `ms` passes.
async function watch(t0, ms, before) {
  const st = Object.fromEntries(Object.entries(before).map(([k, v]) => [k, { ...v, polls: 0, n304: 0, seen: null, events: [] }]));
  while (Date.now() - t0 < ms && Object.values(st).some((s) => s.seen === null)) {
    for (const [repo, s] of Object.entries(st)) {
      if (s.seen !== null) continue;
      const r = await feed(repo, s.etag); s.polls++;
      if (r.status === 304) { s.n304++; continue; }
      s.etag = r.headers.get("etag");
      const fresh = (await r.json()).filter((e) => e.id > s.top);
      if (fresh.length) { s.seen = Date.now() - t0; s.events = fresh.map(brief); }
    }
    await sleep(250);
  }
  return Object.fromEntries(Object.entries(st).map(([k, s]) => [k, { feed_ms: s.seen, polls: s.polls, n304: s.n304, events: s.events }]));
}

if (process.argv[2] === "watch") {
  const before = { [RA]: await top(RA), [RB]: await top(RB) };
  console.log("watching both feeds for 3 min, drag now; parent order:", order(R.setup.P1));
  const t0 = Date.now();
  const res = await watch(t0, 180000, before);
  R.ui = { at: new Date(t0).toISOString(), feeds: res, order_after: order(R.setup.P1), updated_after: updated(Object.values(R.setup)), deliveries: await deliveries(t0), parent_timeline: timeline(R.setup.P1) };
  save(); console.log(JSON.stringify(R.ui, null, 1)); process.exit();
}

if (!R.setup) {
  const S = { P1: create(RA, "[p70] P1 parent"), A: create(RA, "[p70] A"), B: create(RA, "[p70] B"), C: create(RA, "[p70] C"), P2: create(RA, "[p70] P2 parent"), X: create(RB, "[p70] X cross-repo") };
  for (const k of ["A", "B", "C"]) gh("api", `${iss(S.P1)}/sub_issues`, "-F", `sub_issue_id=${S[k].id}`);
  R.setup = S; save(); console.log("setup", JSON.stringify(S));
  await sleep(10000);
}
const { P1, A, B, C, P2, X } = R.setup;
const reorderRest = (p, child, rel) => gh("api", "-X", "PATCH", `${iss(p)}/sub_issues/priority`, "-F", `sub_issue_id=${child.id}`, ...Object.entries(rel).flatMap(([k, v]) => ["-F", `${k}=${v.id}`]));
const reorderGql = (p, child, after) => gql(`mutation{reprioritizeSubIssue(input:{issueId:"${p.node_id}",subIssueId:"${child.node_id}",afterId:"${after.node_id}"}){clientMutationId}}`);

for (const [key, fn, xs] of [
  ["rest_reorder", () => reorderRest(P1, C, { before_id: A }), [P1, A, B, C]],
  ["gql_reorder", () => reorderGql(P1, A, B), [P1, A, B, C]],
  ["reparent", () => gh("api", `${iss(P2)}/sub_issues`, "-F", `sub_issue_id=${B.id}`, "-F", "replace_parent=true"), [P1, P2, B]],
  ["control_remove", () => gh("api", "-X", "DELETE", `${iss(P2)}/sub_issue`, "-F", `sub_issue_id=${B.id}`), [P2, B]],
  ["control_add_cross", () => gh("api", `${iss(P1)}/sub_issues`, "-F", `sub_issue_id=${X.id}`), [P1, X]],
  ["cross_reorder", () => reorderRest(P1, X, { before_id: C }), [P1, X, C]],
]) {
  if (R[key]) continue;
  const before = { [RA]: await top(RA), [RB]: await top(RB) };
  const u0 = updated(xs), o0 = order(P1);
  await sleep(1500); // so a bumped updated_at is distinguishable
  const t0 = Date.now(); fn();
  const feeds = await watch(t0, 60000, before);
  await sleep(Math.max(0, 15000 - (Date.now() - t0))); // let webhooks land in the delivery log
  R[key] = { at: new Date(t0).toISOString(), order_before: o0, order_after: order(P1), updated_before: u0, updated_after: updated(xs), feeds, deliveries: await deliveries(t0), parent_timeline: timeline(P1) };
  save(); console.log(key, JSON.stringify(R[key], null, 1));
}
console.log("done");
