// Linked-PR probe (wayfinder ticket #69): manual (sidebar) links vs "closes #n" in the body, same- and cross-repo.
// Needs listen.mjs appending to .dev/probe-prlink/events.jsonl. Records webhooks, updated_at and closingIssuesReferences per step.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { api } from "./app.mjs";
const DIR = new URL("../../.dev/probe-prlink/", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });
const OWNER = "tomsjansons", RA = "beghu-scratch-pr-a", RB = "beghu-scratch-pr-b";
const EVENTS = DIR + "events.jsonl", OUT = DIR + "results.json", WAIT = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gh = (...a) => execFileSync("gh", a, { encoding: "utf8" });
const ghj = (...a) => JSON.parse(gh(...a) || "null");
const gql = (q) => { const r = spawnSync("gh", ["api", "graphql", "-f", `query=${q}`], { encoding: "utf8" }); const j = JSON.parse(r.stdout || "null"); if (j?.errors) console.error(JSON.stringify(j.errors)); return j; };
const events = () => existsSync(EVENTS) ? readFileSync(EVENTS, "utf8").trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
const R = existsSync(OUT) ? JSON.parse(readFileSync(OUT)) : {};
const save = () => writeFileSync(OUT, JSON.stringify(R, null, 2));

const item = (repo, n) => { const i = ghj("api", `repos/${OWNER}/${repo}/issues/${n}`); return { repo, n, id: i.id, node_id: i.node_id }; };
const createIssue = (repo, title) => item(repo, Number(gh("issue", "create", "-R", `${OWNER}/${repo}`, "-t", title, "-b", "Throwaway issue for wayfinder ticket #69.").trim().split("/").pop()));
const prNode = (repo, n) => gql(`{repository(owner:"${OWNER}",name:"${repo}"){pullRequest(number:${n}){id}}}`).data.repository.pullRequest.id;
const createPR = (repo, branch, title) => {
  const main = ghj("api", `repos/${OWNER}/${repo}/git/ref/heads/main`).object.sha;
  gh("api", `repos/${OWNER}/${repo}/git/refs`, "-f", `ref=refs/heads/${branch}`, "-f", `sha=${main}`);
  gh("api", "-X", "PUT", `repos/${OWNER}/${repo}/contents/${branch}.txt`, "-f", `message=${branch}`, "-f", `content=${Buffer.from(branch).toString("base64")}`, "-f", `branch=${branch}`);
  const n = Number(gh("pr", "create", "-R", `${OWNER}/${repo}`, "-H", branch, "-B", "main", "-t", title, "-b", "Throwaway PR for wayfinder ticket #69.").trim().split("/").pop());
  return { ...item(repo, n), pr_node: prNode(repo, n) };
};

// Both sides of every link: REST updated_at (what a `since` sweep sees), GraphQL updatedAt, the PR's closing refs, the issue's timeline.
const snap = (xs) => Object.fromEntries(xs.map((x) => {
  const rest = ghj("api", `repos/${OWNER}/${x.repo}/issues/${x.n}`).updated_at;
  const q = x.pr_node
    ? `{repository(owner:"${OWNER}",name:"${x.repo}"){pullRequest(number:${x.n}){updatedAt closingIssuesReferences(first:10){nodes{number repository{name}}}}}}`
    : `{repository(owner:"${OWNER}",name:"${x.repo}"){issue(number:${x.n}){updatedAt closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number repository{name}}} timelineItems(last:5,itemTypes:[CONNECTED_EVENT,DISCONNECTED_EVENT,CROSS_REFERENCED_EVENT,REFERENCED_EVENT]){nodes{__typename ... on ConnectedEvent{createdAt isCrossRepository subject{... on PullRequest{number}}} ... on DisconnectedEvent{createdAt subject{... on PullRequest{number}}} ... on CrossReferencedEvent{createdAt willCloseTarget source{... on PullRequest{number}}}}}}}}`;
  const g = gql(q).data.repository;
  return [`${x.repo}#${x.n}`, { rest_updated_at: rest, ...(g.pullRequest ?? g.issue) }];
}));
// Webhooks seen on smee since t0, with every field that names an issue or PR, plus GitHub's own delivery log as a cross-check.
const window = (t0) => events().filter((e) => e.local_ms >= t0).map((e) => ({
  event: e.event, action: e.action, repo: e.repo, to_local_ms: e.local_ms - t0,
  issue: e.body.issue?.number, pr: e.body.pull_request?.number, pr_updated_at: e.body.pull_request?.updated_at, issue_updated_at: e.issue_updated_at,
  changes: e.body.changes && Object.keys(e.body.changes), keys: Object.keys(e.body),
}));
const deliveries = async (t0) => (await api("/app/hook/deliveries?per_page=100")).json
  .filter((d) => Date.parse(d.delivered_at) >= t0 - 2000).map((d) => ({ event: d.event, action: d.action, status: d.status_code, repo: d.repository_id }));

if (!R.setup) {
  const I = createIssue(RA, "[p69] I same-repo");
  const K = createIssue(RA, "[p69] K keyword control");
  const J = createIssue(RB, "[p69] J cross-repo");
  const P = createPR(RA, "p69-p", "[p69] P");
  R.setup = { I, K, J, P }; save();
  console.log("setup", JSON.stringify(R.setup));
  await sleep(WAIT);
}
const { I, K, J, P } = R.setup;
const editBody = (body) => gh("api", "-X", "PATCH", `repos/${OWNER}/${RA}/pulls/${P.n}`, "-f", `body=${body}`);
const link = (x) => gql(`mutation{addCloseIssueReferences(input:{issueId:"${x.node_id}",pullRequestIds:["${P.pr_node}"]}){clientMutationId}}`);
const unlink = (x) => gql(`mutation{removeCloseIssueReferences(input:{issueId:"${x.node_id}",pullRequestIds:["${P.pr_node}"]}){clientMutationId}}`);

for (const [key, fn, xs] of [
  ["manual_link", () => link(I), [I, P]],
  ["manual_unlink", () => unlink(I), [I, P]],
  ["keyword_add", () => editBody(`Throwaway PR for wayfinder ticket #69.\n\ncloses #${K.n}`), [K, P]],
  ["keyword_remove", () => editBody("Throwaway PR for wayfinder ticket #69."), [K, P]],
  ["cross_manual_link", () => link(J), [J, P]],
  ["cross_manual_unlink", () => unlink(J), [J, P]],
  ["cross_keyword_add", () => editBody(`Throwaway PR for wayfinder ticket #69.\n\ncloses ${OWNER}/${RB}#${J.n}`), [J, P]],
  ["cross_keyword_remove", () => editBody("Throwaway PR for wayfinder ticket #69."), [J, P]],
]) {
  if (R[key]) continue;
  const before = snap(xs);
  await sleep(1500); // so a bumped updated_at is distinguishable from the snapshot
  const t0 = Date.now(); fn(); await sleep(WAIT);
  R[key] = { at: new Date(t0).toISOString(), before, after: snap(xs), webhooks: window(t0), deliveries: await deliveries(t0) };
  save(); console.log(key, JSON.stringify(R[key], null, 1));
}
console.log("done");
