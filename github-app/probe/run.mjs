// Drive timed edits and relationship changes, match them to webhooks seen in events.jsonl.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const OWNER = "tomsjansons", RA = "beghu", RB = "lang-exp";
const EVENTS = new URL("../../.dev/probe/events.jsonl", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const ghjson = (...args) => JSON.parse(gh(...args) || "null");
const events = () => (existsSync(EVENTS) ? readFileSync(EVENTS, "utf8").trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : []);
const issue = (repo, n) => ghjson("api", `repos/${OWNER}/${repo}/issues/${n}`);
const timed = (fn) => { const t0 = Date.now(); fn(); return { t0, t1: Date.now() }; };

async function waitFor(t0, pred, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const e = events().find((e) => e.local_ms >= t0 && pred(e));
    if (e) return e;
    await sleep(100);
  }
  return null;
}

const RESULTS = new URL("../../.dev/probe/results.json", import.meta.url);
const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS)) : { latency: [], relationships: [], issues: {} };
const RELATIONSHIPS_ONLY = process.env.RELATIONSHIPS_ONLY === "1"; // rerun only the relationship part
if (RELATIONSHIPS_ONLY) results.relationships = [];
const save = () => writeFileSync(RESULTS, JSON.stringify(results, null, 2));

// --- setup: three probe issues
function create(repo, title) {
  const url = gh("issue", "create", "-R", `${OWNER}/${repo}`, "-t", title, "-b", "Throwaway issue for the webhook delivery probe (wayfinder ticket #27). Safe to delete.").trim();
  const n = Number(url.split("/").pop());
  const i = issue(repo, n);
  return { repo, n, id: i.id, node_id: i.node_id };
}
let A, A2, B;
if (RELATIONSHIPS_ONLY) ({ A, A2, B } = results.issues);
else {
  A = create(RA, "[webhook-probe] A");
  A2 = create(RA, "[webhook-probe] A2");
  B = create(RB, "[webhook-probe] B");
  results.issues = { A, A2, B };
  console.log("issues", results.issues);
  await sleep(5000);
}

// --- latency: gh CLI and REST edits, one at a time
const edits = (x, k) => {
  const R = `${OWNER}/${x.repo}`, n = String(x.n);
  return [
    ["gh", "issue_comment", "created", () => gh("issue", "comment", n, "-R", R, "-b", `probe comment ${k}`)],
    ["gh", "issues", "labeled", () => gh("issue", "edit", n, "-R", R, "--add-label", "bug")],
    ["gh", "issues", "unlabeled", () => gh("issue", "edit", n, "-R", R, "--remove-label", "bug")],
    ["gh", "issues", "edited", () => gh("issue", "edit", n, "-R", R, "-t", `[webhook-probe] ${x === B ? "B" : "A"} r${k}`)],
    ["gh", "issues", "closed", () => gh("issue", "close", n, "-R", R)],
    ["gh", "issues", "reopened", () => gh("issue", "reopen", n, "-R", R)],
    ["gh", "issues", "assigned", () => gh("issue", "edit", n, "-R", R, "--add-assignee", "@me")],
    ["gh", "issues", "unassigned", () => gh("issue", "edit", n, "-R", R, "--remove-assignee", "@me")],
    ["rest", "issue_comment", "created", () => gh("api", `repos/${R}/issues/${n}/comments`, "-f", `body=probe rest comment ${k}`)],
    ["rest", "issues", "edited", () => gh("api", "-X", "PATCH", `repos/${R}/issues/${n}`, "-f", `body=Throwaway probe issue, rev ${k}.`)],
  ];
};
if (!RELATIONSHIPS_ONLY) for (let k = 1; k <= 2; k++) for (const x of [A, B]) for (const [via, event, action, fn] of edits(x, k)) {
  const { t0, t1 } = timed(fn);
  const e = await waitFor(t0, (e) => e.event === event && e.action === action && e.issue === x.n && e.repo === `${OWNER}/${x.repo}`);
  const row = { via, repo: x.repo, event, action, call_ms: t1 - t0, delivery: e?.delivery,
    to_smee_ms: e ? e.smee_ms - t1 : null, to_local_ms: e ? e.local_ms - t1 : null };
  results.latency.push(row); save();
  console.log(JSON.stringify(row));
  await sleep(1500);
}

// --- relationships: every event in a window after each change, plus updated_at before/after
const restIssue = (x) => `repos/${OWNER}/${x.repo}/issues/${x.n}`;
const gql = (m, vars) => gh("api", "graphql", "-f", `query=mutation { ${m} }`);
const ops = [
  ["sub-issue add, same repo", A, A2, () => gh("api", `${restIssue(A)}/sub_issues`, "-F", `sub_issue_id=${A2.id}`)],
  ["sub-issue remove, same repo", A, A2, () => gh("api", "-X", "DELETE", `${restIssue(A)}/sub_issue`, "-F", `sub_issue_id=${A2.id}`)],
  ["sub-issue add, cross repo", A, B, () => gh("api", `${restIssue(A)}/sub_issues`, "-F", `sub_issue_id=${B.id}`)],
  ["sub-issue remove, cross repo", A, B, () => gh("api", "-X", "DELETE", `${restIssue(A)}/sub_issue`, "-F", `sub_issue_id=${B.id}`)],
  ["blocked-by add, same repo", A, A2, () => gh("api", `${restIssue(A)}/dependencies/blocked_by`, "-F", `issue_id=${A2.id}`)],
  ["blocked-by remove, same repo", A, A2, () => gh("api", "-X", "DELETE", `${restIssue(A)}/dependencies/blocked_by/${A2.id}`)],
  ["blocked-by add, cross repo", A, B, () => gh("api", `${restIssue(A)}/dependencies/blocked_by`, "-F", `issue_id=${B.id}`)],
  ["blocked-by remove, cross repo", A, B, () => gh("api", "-X", "DELETE", `${restIssue(A)}/dependencies/blocked_by/${B.id}`)],
  ["relates-to add, same repo", A, A2, () => gql(`addRelatesTo(input:{issueId:"${A.node_id}",relatedIssueId:"${A2.node_id}"}){clientMutationId}`)],
  ["relates-to remove, same repo", A, A2, () => gql(`removeRelatesTo(input:{issueId:"${A.node_id}",relatedIssueId:"${A2.node_id}"}){clientMutationId}`)],
  ["relates-to add, cross repo", A, B, () => gql(`addRelatesTo(input:{issueId:"${A.node_id}",relatedIssueId:"${B.node_id}"}){clientMutationId}`)],
  ["relates-to remove, cross repo", A, B, () => gql(`removeRelatesTo(input:{issueId:"${A.node_id}",relatedIssueId:"${B.node_id}"}){clientMutationId}`)],
];
for (const [name, x, y, fn] of ops) {
  const before = { x: issue(x.repo, x.n).updated_at, y: issue(y.repo, y.n).updated_at };
  await sleep(1500); // updated_at has 1 s resolution
  let error = null, t0 = Date.now(), t1;
  try { fn(); } catch (err) { error = String(err.stderr || err.message).trim(); }
  t1 = Date.now();
  await sleep(20000);
  const after = { x: issue(x.repo, x.n).updated_at, y: issue(y.repo, y.n).updated_at };
  const got = events().filter((e) => e.local_ms >= t0).map((e) => ({
    delivery: e.delivery, event: e.event, action: e.action, repo: e.repo, issue: e.issue, to_smee_ms: e.smee_ms - t1,
    sub_issue: e.body.sub_issue?.number, parent_issue: e.body.parent_issue?.number,
    blocked_issue: e.body.blocked_issue?.number, blocking_issue: e.body.blocking_issue?.number,
  }));
  const row = { name, error, before, after, bumped: { x: before.x !== after.x, y: before.y !== after.y }, deliveries: got };
  results.relationships.push(row); save();
  console.log(JSON.stringify(row));
}
console.log("done");
