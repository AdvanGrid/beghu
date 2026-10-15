// Edge-case probe (wayfinder ticket #35): delete, transfer, label/milestone rename on scratch repos; webhooks captured in events.jsonl.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const DIR = new URL("../../.dev/probe-edges/", import.meta.url).pathname;
const OWNER = "tomsjansons", RA = "beghu-scratch-a", RB = "beghu-scratch-b";
const EVENTS = DIR + "events.jsonl", OUT = DIR + "results.json";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gh = (...a) => execFileSync("gh", a, { encoding: "utf8" });
const ghj = (...a) => JSON.parse(gh(...a) || "null");
const gql = (q) => { const r = spawnSync("gh", ["api", "graphql", "-f", `query=${q}`], { encoding: "utf8" }); return JSON.parse(r.stdout || "null"); };
const events = () => existsSync(EVENTS) ? readFileSync(EVENTS, "utf8").trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
// Raw status of a REST GET without following redirects.
const status = (path) => {
  const r = spawnSync("gh", ["api", "-i", path], { encoding: "utf8" });
  const head = r.stdout.split("\r\n\r\n")[0];
  return { line: head.split("\r\n")[0], location: head.match(/^location: (.*)$/im)?.[1] ?? null, body: r.stdout.split("\r\n\r\n").slice(1).join("").slice(0, 300) };
};
const R = existsSync(OUT) ? JSON.parse(readFileSync(OUT)) : {};
const save = () => writeFileSync(OUT, JSON.stringify(R, null, 2));

const create = (repo, title, extra = []) => {
  const url = gh("issue", "create", "-R", `${OWNER}/${repo}`, "-t", title, "-b", "Throwaway issue for wayfinder ticket #35.", ...extra).trim();
  const n = Number(url.split("/").pop());
  const i = ghj("api", `repos/${OWNER}/${repo}/issues/${n}`);
  return { repo, n, id: i.id, node_id: i.node_id };
};
const rel = (x) => gql(`{repository(owner:"${OWNER}",name:"${x.repo}"){issue(number:${x.n}){number updatedAt parent{number repository{name}} subIssues(first:10){nodes{number repository{name}}} blockedBy(first:10){nodes{number repository{name}}} blocking(first:10){nodes{number repository{name}}} relatesTo(first:10){nodes{number repository{name}}}}}}`).data.repository.issue;
const updated = (xs) => Object.fromEntries(xs.map((x) => [`${x.repo}#${x.n}`, ghj("api", `repos/${OWNER}/${x.repo}/issues/${x.n}`).updated_at]));
const window = (t0) => events().filter((e) => e.local_ms >= t0).map((e) => ({ event: e.event, action: e.action, repo: e.repo, issue: e.issue, delivery: e.delivery, to_local_ms: e.local_ms - t0 }));

// --- setup
if (!R.setup) {
  gh("label", "create", "probe-label", "-R", `${OWNER}/${RA}`, "-c", "ededed");
  const ms = ghj("api", `repos/${OWNER}/${RA}/milestones`, "-f", "title=probe-ms");
  const I = {};
  for (const k of ["D", "T", "P", "C", "X", "Y", "Rel", "V", "VP", "L1", "L2"]) I[k] = create(RA, `[p35] ${k}`);
  for (const k of ["L1", "L2"]) gh("api", "-X", "PATCH", `repos/${OWNER}/${RA}/issues/${I[k].n}`, "-F", `milestone=${ms.number}`, "-f", "labels[]=probe-label");
  const iss = (x) => `repos/${OWNER}/${x.repo}/issues/${x.n}`;
  gh("api", `${iss(I.P)}/sub_issues`, "-F", `sub_issue_id=${I.T.id}`);   // P > T
  gh("api", `${iss(I.T)}/sub_issues`, "-F", `sub_issue_id=${I.C.id}`);   // T > C
  gh("api", `${iss(I.T)}/dependencies/blocked_by`, "-F", `issue_id=${I.X.id}`); // T blocked by X
  gh("api", `${iss(I.Y)}/dependencies/blocked_by`, "-F", `issue_id=${I.T.id}`); // Y blocked by T
  gql(`mutation{addRelatesTo(input:{issueId:"${I.T.node_id}",relatedIssueId:"${I.Rel.node_id}"}){clientMutationId}}`);
  gh("api", `${iss(I.VP)}/sub_issues`, "-F", `sub_issue_id=${I.V.id}`);  // VP > V (for the conversion step)
  gh("api", "-X", "PATCH", iss(I.V), "-F", `milestone=${ms.number}`, "-f", "labels[]=probe-label");
  R.setup = { I, milestone: ms.number }; save();
  console.log("setup", JSON.stringify(I));
  await sleep(15000);
}
const { I, milestone } = R.setup;
const linked = [I.P, I.C, I.X, I.Y, I.Rel];

// --- delete
if (!R.delete) {
  const t0 = Date.now();
  gql(`mutation{deleteIssue(input:{issueId:"${I.D.node_id}"}){clientMutationId}}`);
  await sleep(20000);
  const g = spawnSync("gh", ["api", "graphql", "-f", `query={repository(owner:"${OWNER}",name:"${RA}"){issue(number:${I.D.n}){number}}}`], { encoding: "utf8" });
  R.delete = { webhooks: window(t0), rest: status(`repos/${OWNER}/${RA}/issues/${I.D.n}`),
    graphql: (g.stdout || g.stderr).slice(0, 400),
    graphql_node: gql(`{node(id:"${I.D.node_id}"){id}}`) };
  save(); console.log("delete", JSON.stringify(R.delete, null, 1));
}

// --- transfer
if (!R.transfer) {
  const before = { T: rel(I.T), updated: updated(linked) };
  const repoB = gql(`{repository(owner:"${OWNER}",name:"${RB}"){id}}`).data.repository.id;
  await sleep(1500);
  const t0 = Date.now();
  const res = gql(`mutation{transferIssue(input:{issueId:"${I.T.node_id}",repositoryId:"${repoB}"}){issue{number id databaseId url}}}`).data.transferIssue.issue;
  await sleep(20000);
  const NT = { repo: RB, n: res.number, id: res.databaseId, node_id: res.id };
  R.transfer = { new: NT, before, after: { T: rel(NT), updated: updated(linked), linked: Object.fromEntries(linked.map((x) => [`${x.repo}#${x.n}`, rel(x)])) },
    webhooks: window(t0), old_rest: status(`repos/${OWNER}/${RA}/issues/${I.T.n}`), old_node: gql(`{node(id:"${I.T.node_id}"){id ... on Issue{number repository{name}}}}`) };
  save(); console.log("transfer", JSON.stringify(R.transfer, null, 1));
}

// --- label and milestone renames
for (const [key, fn] of [
  ["label_rename", () => gh("api", "-X", "PATCH", `repos/${OWNER}/${RA}/labels/probe-label`, "-f", "new_name=probe-label-renamed")],
  ["milestone_rename", () => gh("api", "-X", "PATCH", `repos/${OWNER}/${RA}/milestones/${milestone}`, "-f", "title=probe-ms-renamed")],
]) {
  if (R[key]) continue;
  const before = updated([I.L1, I.L2]);
  await sleep(1500);
  const t0 = Date.now(); fn(); await sleep(20000);
  R[key] = { before, after: updated([I.L1, I.L2]), webhooks: window(t0) };
  save(); console.log(key, JSON.stringify(R[key], null, 1));
}
console.log("done");
