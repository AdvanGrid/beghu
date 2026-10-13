# Filling and reconciling the beghu mirror: bulk import, costs, deletions, catch-up

Research date: 2026-10-13. Sources: docs.github.com (fetched as Markdown through
`https://docs.github.com/api/article/body?pathname=…`), the octokit/webhooks payload schemas,
read-only `gh api graphql` introspection of the public schema, and read-only REST and GraphQL
calls against public repos (cli/cli, microsoft/vscode, Azure/azure-dev, elastic/kibana,
zed-industries/zed, astral-sh/uv, ghostty-org/ghostty, dotnet/aspire,
uncovering-world/track-your-regions, microsoft/vscode-python(-environments)). Nothing on GitHub
was created or changed. Doc URLs drop the `https://docs.github.com/en` prefix and are written
as `/path`. This builds on [github-app-mechanics.md](github-app-mechanics.md) (tokens, rate
limit budgets, webhook events, the deliveries API); that material is linked, not repeated.

Each claim is tagged **[doc]** (stated in GitHub docs or schema), **[measured]** (observed in
calls made for this note), or **[inferred]**. Measurements were made with `gh api` from the dev
workstation using a user OAuth token. Its GraphQL budget follows the same point formula as an
installation token. Every `gh` call carries about 0.5 s of process and TLS overhead (a trivial
`{rateLimit{remaining}}` query took 0.47–0.56 s), so a long-lived HTTP client will be faster
than the figures below.

## Answers

1. **Bulk import: page `repository.issues` and `repository.pullRequests` with `first: 100`,
   ordered `UPDATED_AT ASC`. Fetch `parent` and the two summary objects inline, and fetch
   edge lists only for issues that have relationships.** The issue page with labels,
   assignees, milestone, state/stateReason, updatedAt, `parent`, `subIssuesSummary` and
   `issueDependenciesSummary` costs **2 points per 100 issues** (formula: 1 + 2 nested
   connections × 100 = 201 → 2; measured 2). Adding `subIssues`, `blockedBy` and `blocking`
   inline costs **5 per 100** (1 + 5 × 100 = 501 → 5; measured 5). The cheaper plan is a
   follow-up `nodes(ids:[…100])` query that reads those three edge lists for issues whose
   summaries are non-zero. It costs **3 points per 100 such issues** (measured), and only 0.3–5 %
   of issues needed it in the repos sampled. `body` and `comments { totalCount }` add no points
   (dry-run cost unchanged). PRs: the same shape without relationships, 2 per 100. All of the
   relationship fields exist in GraphQL. REST `GET /repos/{o}/{r}/issues?state=all` is 1 *core*
   point per 100 (a separate budget) and includes PRs, `parent_issue_url` and both summaries,
   but no dependency edges and always the full body (650–880 KB per page against 70–90 KB for
   GraphQL).
2. **Import time and cost.** 20k issues is about 200 pages, roughly **400 points plus about 30
   for edges**. 50k is about 500 pages and roughly 1,000 points. Add 2 points per 100 PRs.
   Measured latency was 1.3–1.8 s per page sequentially (p50, including the `gh` overhead) and
   1.6–2.1 s with 4 streams in parallel. A sustained run with 4 streams imported **16,800
   issues in 88 s (≈190 issues/s, 336 points) with no secondary-limit errors.** At that rate,
   20k issues plus 20k PRs take about 3–4 minutes and roughly 850 points. 50k plus 50k take about
   9–10 minutes and roughly 2,100 points. Both fit in one hour of an installation's 5,000
   points.
3. **Deletes and transfers never show up in `since` listings; they only disappear from full
   listings.** The webhooks are `issues.deleted` (with the full old `issue`) and
   `issues.transferred` (with the old `issue` plus `changes.new_issue` and
   `changes.new_repository`). REST `GET` on the old number returns **301** with a `Location`
   pointing at the new issue (documented and measured). GraphQL by number returns `NOT_FOUND`,
   and `resource(url:)` returns `null` (measured). **A transfer creates a new issue: new
   `id`/`databaseId`, a new `node_id` that encodes the destination repo id, and a new number.
   `created_at` is kept and `updated_at` is bumped to the transfer time** (measured). A deleted
   issue is documented as **410** (or 404 without access). In practice, 50 of the 56 numbering
   gaps sampled in cli/cli returned **404**, not 410, and the other 6 were discussions. Treat
   404 and 410 the same way. Conversion to a discussion has no documented webhook. Discussion
   numbers return 404 from the issues API, and the web UI redirects them with 302 to
   `/discussions/N` (measured). The safety net is a cheap **count check** (1 point for all 10
   repos), plus an **id sweep** (1 point per 100) whenever the counts disagree, plus a full
   sweep nightly.
4. **`updatedAt` is bumped by comments, labels, assignment, milestone, close, title edits and
   issue type, but NOT by sub-issue or dependency changes, and not by cross-references.** In
   public data the relationship timeline events were often hours to weeks newer than the
   issue's `updatedAt`, on both sides of the link (sub-issue added to the parent, parent added
   to the child, parent removed, blocking added/removed, blocked-by added). So `since` sweeps
   miss relationship changes. Label and milestone *renames* can't be tested read-only and are
   assumed not to bump `updatedAt` [inferred]. Catch-up plan: for gaps inside the 3-day window,
   replay the deliveries API (see
   [the mechanics doc §4](github-app-mechanics.md#4-delivery-guarantees-and-catch-up)); then
   run a REST `issues?state=all&since=<checkpoint − 5 min>` sweep per repo, which covers
   issues and PRs at 1 core point per page. For gaps outside the window, at startup without a
   checkpoint, and nightly, run a **full sweep**: re-run the import query (about 430 points for
   20k issues) and diff ids, fields and relationships. Polling for changes in between is free:
   a conditional REST request that gets back `304` does not count against the rate limit
   (documented; measured).

## 1. Query shape and cost

### Schema (introspected 2026-10-13)

- `Issue` has `parent: Issue`, `subIssues: IssueConnection` (args `first/last/after/before`
  only), `blockedBy`/`blocking: IssueConnection` (with `orderBy`, default
  `{field: DEPENDENCY_ADDED_AT, direction: DESC}`), `subIssuesSummary { total completed
  percentCompleted }`, `issueDependenciesSummary { blockedBy blocking totalBlockedBy
  totalBlocking }`, `relatesTo`, `duplicateOf`, `issueType`, `stateReason` (`COMPLETED`,
  `NOT_PLANNED`, `DUPLICATE`, `REOPENED`), `updatedAt`, `databaseId`, `fullDatabaseId` [doc,
  schema]. The schema says the summary `blockedBy`/`blocking` fields count open issues and the
  `total*` fields count open and closed [doc, schema descriptions].
- `Repository.issues` takes `orderBy` (`CREATED_AT`, `UPDATED_AT`, `COMMENTS`), `states`,
  `labels` and `filterBy: IssueFilters`. `IssueFilters.since` is "issues that have been
  updated **at or after** the given date" [doc, schema]. `Repository.issues` excludes PRs
  [measured: 6,527 issues and 4,707 PRs on cli/cli, counted separately].
- `Repository.pullRequests` has `states`, `labels`, `headRefName`, `baseRefName` and `orderBy`,
  but **no `since`/`filterBy`** [doc, schema]. Neither does REST `GET /repos/{o}/{r}/pulls`,
  whose only filters are `state, head, base, sort, direction` (`/rest/pulls/pulls`).
- The timeline has `SUB_ISSUE_ADDED/REMOVED_EVENT`, `PARENT_ISSUE_ADDED/REMOVED_EVENT`,
  `BLOCKED_BY_ADDED/REMOVED_EVENT` and `BLOCKING_ADDED/REMOVED_EVENT` item types [doc, schema].
  These events are the basis of §4.
- **Dependencies can cross owners** [measured]. cli/cli#14467 is `blocking`
  uncovering-world/track-your-regions#1056. This answers an open question in the mechanics
  doc; sub-issues are still documented as same-owner only.

### Import query (issues)

```graphql
query($owner:String!, $name:String!, $after:String) {
  rateLimit { cost remaining }
  repository(owner:$owner, name:$name) {
    issues(first:100, after:$after, orderBy:{field:UPDATED_AT, direction:ASC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id databaseId number title body state stateReason
        createdAt updatedAt closedAt url
        author { login } issueType { name }
        comments { totalCount }
        milestone { id number title }
        labels(first:20)    { totalCount nodes { id name color } }
        assignees(first:10) { totalCount nodes { id login } }
        parent { id number title url state repository { nameWithOwner } }
        subIssuesSummary { total completed }
        issueDependenciesSummary { totalBlockedBy totalBlocking }
      }
    }
  }
}
```

Follow-up for issues whose `subIssuesSummary.total`, `totalBlockedBy` or `totalBlocking` is
non-zero, 100 ids per call:

```graphql
query($ids:[ID!]!) {
  nodes(ids:$ids) { ... on Issue { id
    subIssues(first:100) { totalCount nodes { id number title url state repository { nameWithOwner } } }
    blockedBy(first:50)  { totalCount nodes { id number title url state repository { nameWithOwner } } }
    blocking(first:50)   { totalCount nodes { id number title url state repository { nameWithOwner } } } } }
}
```

The `first` values match the product limits: 100 sub-issues per parent, 50 per dependency
type (mechanics doc §2). The edge nodes carry title, URL, state and repo, so a link into an
unsynced repo becomes a stub without another call [inferred from the field set]. `parent` alone
gives every child→parent edge whose child is synced. `subIssues` is needed for ordering and for
children in unsynced repos.

PRs: the same shape on `pullRequests`, with `isDraft merged mergedAt` and without the
relationship fields.

### Costs: formula vs measured

Formula (`/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api`): add up the
requests per connection, assuming `first`/`last` is maxed, divide by 100, round, minimum 1.
Only the *parent multiplicity* counts, so `labels(first:20)` and `labels(first:100)` cost the
same.

| Query (cli/cli) | Formula | Measured cost | `nodeCount` | Response size |
|---|---|---|---|---|
| ids only: `issues(first:100){ id databaseId number updatedAt state }` | 1 → 1 | 1 | 100 | 13 KB |
| import shape above (labels + assignees nested) | 1 + 200 = 201 → 2 | 2 | 3,100 | 68–88 KB |
| same with `labels(first:100) assignees(first:100)` | 201 → 2 | 2 | 20,100 | same |
| same + `body` + `comments{totalCount}` | 201 → 2 | 2 (dry run) | 3,100 | ~148 KB |
| import shape + inline `subIssues` `blockedBy` `blocking` | 1 + 500 = 501 → 5 | 5 | 23,100 | ~93 KB |
| same with `first:50` issues | 1 + 250 = 251 → 3 | 3 | 9,050 | 42 KB |
| `pullRequests(first:100)` with labels + assignees | 201 → 2 | 2 | 3,100 | ~55 KB |
| `nodes(ids:100)` with 3 edge lists | 1 + 300 = 301 → 3 | 3 | 20,100 | — |
| 10 repos aliased: `issues.totalCount`, `pullRequests.totalCount`, open count | 30 → 1 | 1 | — | — |
| 10 repos aliased: `issues(first:100, filterBy:{since})` import shape | 10 × 201 → 20 | 20 (dry run) | 31,000 | — |
| same with `first:25` | 10 × 51 → 5 | 5 (dry run) | 7,750 | — |

`rateLimit(dryRun:true)` returns the cost without running the query and without deducting
points [measured: `remaining` was unchanged after three dry runs]. A query that asks only for
`rateLimit { remaining }` also left `remaining` unchanged [measured].

### Limits that apply

- `first`/`last` must be 1–100, and a call may touch at most 500,000 nodes [doc, same page].
  The shapes above use 3k–31k nodes.
- Timeout is 10 s, answered with 502/504, "additional points will be deducted from your primary
  rate limit for the next hour" after a timeout, and an over-heavy query can be cut off with
  partial results and a resource-limit error [doc]. The slowest page measured was 2.9 s.
- Secondary limits: 100 concurrent requests across REST and GraphQL; 2,000 points/min on the
  GraphQL endpoint (each query counts 1 here); 90 s of CPU per 60 s, at most 60 s of it
  GraphQL, "roughly" estimated by "total response time" [doc]. That rough estimate is very
  conservative: four streams for 88 s added up to about 300 s of response time with no
  throttling [measured]. Secondary-limit status can't be queried. On 403/429 honour
  `retry-after`, otherwise wait at least a minute, then back off exponentially
  (`/rest/using-the-rest-api/rate-limits-for-the-rest-api`).
- REST `per_page` max is 100. `GET /repos/{o}/{r}/issues` paginates by cursor (the `Link`
  header carries `after=`) [measured]. Follow the `Link` URLs; don't build them
  (`/rest/using-the-rest-api/using-pagination-in-the-rest-api`).

### REST alternative

`GET /repos/{o}/{r}/issues?state=all&sort=updated&direction=asc&since=…&per_page=100`
(`/rest/issues/issues#list-repository-issues`):

- Costs 1 point from the **core** budget, which is separate from GraphQL points. An
  installation gets 5,000 of each (mechanics doc §1).
- Includes PRs (the `pull_request` key, with `merged_at`; `draft` at the top level), labels,
  assignees, milestone, `state_reason`, `type`, `sub_issues_summary`,
  `issue_dependencies_summary` and `parent_issue_url` (present only when set) [measured].
- Missing: dependency and child edge lists. Those need one call per issue
  (`…/sub_issues`, `…/dependencies/blocked_by`, `…/blocking`), which is far worse than one
  `nodes()` batch per 100.
- Always includes the body: 650–880 KB per 100 on cli/cli against 70–150 KB for GraphQL
  [measured]. p50 was 1.3–1.6 s per page [measured, 3 pages].
- `since` means "last updated after the given time" [doc]. That is exclusive, while GraphQL's
  `since` is inclusive.
- Conditional requests: a `304` "does not count against your primary rate limit"
  (`/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests`).
  Measured: `?state=all&sort=updated&direction=desc&per_page=1` with `If-None-Match` returned
  304 twice, and `x-ratelimit-used` stayed the same. This makes a free per-repo "did anything
  change?" probe, though it only sees changes that bump `updated_at` (§4).

Verdict: use GraphQL for the bulk import and full sweeps, because it is smaller, carries
edges, and has an inclusive `since`. Use REST `issues?since` for the incremental sweep, because
it covers issues and PRs in one listing and spends the separate core budget [inferred].

### Pagination order

Use `orderBy: UPDATED_AT, direction: ASC` for every sweep [inferred]. If an issue changes while
pages are being read, it moves to the end and is read again. Nothing moves *before* the
cursor, so nothing is skipped. With `DESC`, an unread issue that gets updated jumps above the
cursor and is missed. Cursor behaviour under concurrent updates is not documented.

## 2. Import time and budget

Measured, `gh api` sequential (cli/cli, full repo):

| Run | Pages | Items | Points | Wall | p50 / p90 / max per page |
|---|---|---|---|---|---|
| issues, import shape | 66 | 6,527 | 132 | 109 s | 1.62 / 1.92 / 2.17 s |
| issues, shape + inline edges | 66 | 6,527 | 330 | 119 s | 1.76 / 2.15 / 2.73 s |
| PRs | 48 | 4,707 | 96 | 63 s | 1.28 / 1.57 / 2.87 s |
| issues, ids only (10 pages) | 10 | 1,000 | 10 | 11 s | 1.10 / 1.29 s |
| issues, + body (10 pages) | 10 | 1,000 | 20 | 16 s | 1.54 / 1.76 s |

Parallel, 4 streams on different repos (vscode, kibana, zed, uv), 42 pages each, sustained for
88 s: 16,800 issues, 336 points, p50 1.58–2.08 s, no errors [measured]. A shorter 4-stream run
(vscode, aspire, kibana, azure-dev) matched it. Parallelism raised per-page latency by about
10–25 %.

Share of issues needing the edge follow-up [measured]: track-your-regions 180/728 (25 %, a
heavy user of dependencies), Azure/azure-dev 157/5,250 (3 %), cli/cli 17/6,527 (0.3 %). None of
the sampled `parent` links crossed repos.

Estimates [inferred from the above]:

| Mirror size | Issue pages | Points: issues + edges (5 %) + PRs (same count) | Wall at 1 stream | Wall at 4 streams |
|---|---|---|---|---|
| 20k issues + 20k PRs | ~205 + ~205 | 410 + 30 + 410 ≈ **850** | ~10 min | **~3–4 min** |
| 50k issues + 50k PRs | ~505 + ~505 | 1,010 + 75 + 1,010 ≈ **2,100** | ~25 min | **~9–10 min** |

- The budget is 5,000 points per hour per installation (mechanics doc §1). Several
  installations (one per org or user) each have their own budget, so a single connected account
  never has to wait for a reset.
- The first screen can be served before the import finishes: import open issues first
  (`states: OPEN`), then the rest [inferred].
- Use a client that keeps connections open. The `gh` measurements include about 0.5 s per call
  that a real server won't pay.
- Run one stream per repo, capped at 4 per installation, and back off on any 403, 429 or
  `retry-after` [inferred from the run above].

## 3. Deleted, transferred and converted issues; repo-level changes

### What the docs and webhooks say

- `issues.deleted`: `{action, issue, repository, sender}`, where `issue` is the full issue
  object (octokit `payload-schemas/api.github.com/issues/deleted.schema.json`). Only admins can
  delete issues, and org repos need an owner setting first
  (`/issues/tracking-your-work-with-issues/administering-issues/deleting-an-issue`).
- `issues.transferred`: `{action, changes: {new_issue, new_repository}, issue, repository,
  sender}` (octokit `issues/transferred.schema.json`). Transfers are only allowed between repos
  of the same owner, and not from private to public. Comments and assignees go along; labels and
  milestones go along if they exist in the target, matched by name (milestones by name and due
  date). "The original URL redirects to the new issue's URL"
  (`/issues/tracking-your-work-with-issues/administering-issues/transferring-an-issue-to-another-repository`).
- `GET /repos/{o}/{r}/issues/{n}`: "**301** Moved Permanently status if the issue was
  transferred… If the issue was transferred to or deleted from a repository where the
  authenticated user lacks read access, the API returns a **404**… deleted from a repository
  where the authenticated user has read access, the API returns a **410** Gone"
  (`/rest/issues/issues#get-an-issue`). Clients should follow 301s and update stored URLs
  (`/rest/using-the-rest-api/best-practices-for-using-the-rest-api#follow-redirects`).
- `repository.renamed` has `changes.repository.name.from`; `repository.transferred` has
  `changes.owner.from`; `repository.deleted` is also sent (octokit `repository/*.schema.json`).
  Access removal arrives as `installation_repositories.removed`, `installation.deleted` and
  `installation.suspend` (mechanics doc §3).
- No document describes the webhook or API behaviour of **convert to discussion** beyond "the
  discussion is automatically created using the content from the issue"
  (`/discussions/managing-discussions-for-your-community/moderating-discussions`). No
  `converted` action exists on `issues`.

### What was measured

- **Transfer** (microsoft/vscode-python-environments#1421 → microsoft/vscode-python#26165,
  transferred 2026-09-24T17:52:41Z):
  - REST `GET …/vscode-python-environments/issues/1421` → `301`,
    `Location: https://api.github.com/repos/microsoft/vscode-python/issues/26165`. `gh api`
    follows the redirect silently. `…/1421/comments` → 404.
  - GraphQL `repository.issue(number:1421)` and `issueOrPullRequest` → `NOT_FOUND`.
    `resource(url:"…/issues/1421")` → `null`. No redirect in GraphQL.
  - The new issue has `id` 5572359697 and `node_id` `I_kwDOBlh-Lc8AAAABTCN2EQ`. Base64-decoded,
    the node id is msgpack `[0, 106462765, 5572359697]`, that is `[0, destination repo id, new
    issue database id]`. `created_at` stays 2026-04-02, but a database id that large belongs to
    late September 2026, so **the id and node id are new and the issue gets a new number**. The
    destination's `updated_at` is 17:52:59, just after the transfer, so it shows up in the
    destination's `since` listing.
  - Two other transfers (vscode-python-environments#1374 → microsoft/python-environment-tools#379)
    behaved the same way.
- **Deleted/hidden**: all 50 non-discussion gaps in cli/cli's numbers 13998–14653 returned
  **404** to a token that can read cli/cli, and so did the web page. None returned 410. They may
  be deleted spam or content from flagged accounts; the API doesn't say which. Code must treat
  404 and 410 the same.
- **Discussions**: discussion numbers share the issue sequence. The 6 discussions in that range
  return 404 from `/repos/cli/cli/issues/{n}`, while `https://github.com/cli/cli/issues/{n}`
  returns 302 to `/discussions/{n}`. Whether those 6 started as issues is unknown, so a
  converted issue is expected to look the same [inferred].
- **`since` and listings never surface removals.** Full id lists of
  microsoft/vscode-python-environments from REST (`issues?state=all`, 1,905 rows) and GraphQL
  (`issues` + `pullRequests`, 1,905) were identical, and both leave out the
  transferred/deleted numbers. A removed issue simply stops appearing, with no tombstone
  [measured].
- **Repo rename/owner rename**: REST `GET /repos/zeit/next.js` → 301 to
  `/repositories/70107786`. GraphQL `repository(owner:"zeit", name:"next.js")` silently
  resolves to `vercel/next.js` [measured]. Key repos by `databaseId`/node id, never by name.

### Handling (inferred)

| Event | Mirror action |
|---|---|
| `issues.deleted` | Delete the row by `issue.id`. Turn edges that point to it into "deleted" stubs, or drop them. |
| `issues.transferred` | Delete the old row by `issue.id`. If `changes.new_repository.id` is synced, upsert `changes.new_issue`; otherwise rewrite edges to a stub with the new URL and title. Re-read the relationships of the new issue; whether links survive a transfer is untested. |
| 404/410 when fetching an issue by number | Delete it. |
| 301 when fetching an issue by number | Treat as transferred: delete it and fetch the target. |
| Convert to discussion | No known webhook. Caught by the count check and the id sweep. |
| PRs | Users can't transfer or convert them [inferred: the transfer doc covers issues only]. Same sweep. |
| `repository.renamed` / `transferred` | Update the name and owner on the repo row, keyed by id. After a transfer, refresh the installation's repo list; access may have gone. |
| `repository.deleted`, `installation_repositories.removed`, `installation.deleted`/`suspend` | Drop the repo's rows (the mirror is disposable). Links from other repos become stubs. |

### Detection without webhooks

1. **Count check** (1 point for 10 repos; one aliased query for `issues{totalCount}
   pullRequests{totalCount}`). Run it after the incremental sweep, which has already added
   anything new. If the mirror holds more rows for a repo than GitHub reports, something was
   removed, so run that repo's id sweep. The check misses a removal that is cancelled out by
   an addition the sweep hasn't caught yet, which the nightly sweep covers.
2. **Id sweep**: `issues(first:100){ nodes{ id updatedAt } }` plus the same on
   `pullRequests`. 1 point per 100, about 1.1 s per page with `gh` overhead [measured]. 20k
   issues + 20k PRs = 400 points; 50k + 50k = 1,000. Delete mirror rows that are missing, unless
   a webhook touched them after the sweep started.
3. **Full sweep** (the import query). Pays for itself because it also fixes relationships
   (§4) and stub titles.

## 4. Catching up after missed webhooks or downtime

### What bumps `updatedAt` (measured on public data)

Method: for issues in several repos, the newest timeline item of each type was compared with
the issue's `updatedAt`. "Not bumped" means the event is newer than `updatedAt`, so it cannot
have set it. No document states these rules; the relationship docs and
`/rest/issues/sub-issues` and `/rest/issues/issue-dependencies` are silent.

| Change | Bumps `updatedAt`? | Evidence |
|---|---|---|
| Comment created | **Yes** | In 306 issues (vscode, azure-dev) the latest comment was never newer than `updatedAt`; in hundreds more (cli/cli, kibana, vscode, azure-dev) the newest item was a comment and `updatedAt` matched it within 3 s |
| Label add/remove, assign, milestone set, close, title edit, issue type | **Yes** | Counterexamples were only 1–6 s off (e.g. 33/215 close events on azure-dev were 1 s newer than `updatedAt`), which is clock skew between the event row and the issue row |
| Cross-reference from another issue/PR | **No** | 55/284 (azure-dev) and 118/156 (cli/cli) newer than `updatedAt`, by up to 25 days |
| Sub-issue added (parent side) | **No** | cli/cli#10093: event 2026-09-23, `updatedAt` 2026-09-20; azure-dev#9765: 09-16 vs 08-31; kibana#296986: 10-12 12:19 vs 01:42; 4 more |
| Parent added (child side) | **No** | azure-dev#9454: event 08-31, `updatedAt` 08-14; track-your-regions#611: 09-20 vs 09-15; kibana#292104; 10 more |
| Parent removed / sub-issue removed | **No** | Parent removed: ghostty#12184 (04-22 vs 04-09), azure-dev#9579, ghostty#13014. Sub-issue removed: kibana#296985 (10-12 12:18 vs 01:42); one other sample coincided with a different edit |
| Blocking added / removed | **No** | cli/cli#14188: event 09-24, `updatedAt` 08-28; track-your-regions#863: 09-20 vs 09-10; 18 more |
| Blocked-by added | **No** | 8 conclusive cases on track-your-regions, e.g. #1173 |
| Blocked-by removed | Unknown | No conclusive sample |
| Label renamed, milestone renamed/re-dated | Not testable read-only | Assume **no** [inferred]: the change is on the label or milestone, not on the issues |
| Comment edited | Untested | Use `issue_comment.edited` and `GET /repos/{o}/{r}/issues/comments?since=` (the comment's own `updated_at`, `/rest/issues/comments`) |

Consequences:

- A `since` sweep catches issue fields, labels, assignees, milestone membership, state and new
  comments, with an overlap of at least a few seconds because of the skew; use 5 minutes.
- It does **not** catch relationship changes, label or milestone renames, cross-references,
  deletions or transfers-out.
- For a webhook-driven mirror, relationship changes therefore depend on the `sub_issues` and
  `issue_dependencies` deliveries (or their replay). Otherwise they are only repaired by a sweep
  that re-reads edges.
- Label and milestone definitions are cheap to re-list (`GET …/labels`, `GET
  …/milestones?state=all`, 1 core point per 100), and renames arrive as `label.edited` and
  `milestone.edited`. Store labels and milestones by id and join, so a rename is a single-row
  update [inferred].

### Recommended reconciliation scheme

The webhook pipeline stays the primary path (mechanics doc §3–4). Store a per-installation
checkpoint `last_webhook_at` (the newest processed delivery time) and a per-repo
`last_sweep_at`.

1. **Startup**
   - Gap under 2.5 days (inside the 3-day delivery window, mechanics doc §4): replay failed
     deliveries from the deliveries API first; that brings back relationship events too. Then
     run step 2 once from `last_webhook_at − 5 min`.
   - Gap over 2.5 days, no checkpoint, or a new database: run the **full sweep** (step 4). It is
     the import with a diff.
2. **Incremental sweep, every 5 min and after any webhook outage**:
   `GET /repos/{o}/{r}/issues?state=all&sort=updated&direction=asc&since=<last_sweep_at − 5 min>&per_page=100`
   per repo. Issues and PRs come back in one list. Upsert only when `updated_at` is newer than
   the stored value.
   - Cost: 1 core point per repo per run when quiet, about 120 core points an hour for 10 repos.
   - It can be cut to nearly zero by first sending the `per_page=1` ETag probe, which costs
     nothing when the answer is 304.
   - Rows with `issue_dependencies_summary` or `sub_issues_summary` counts that differ from the
     mirror get their edges re-read through `nodes()`. That costs 3 points per 100.
3. **Count check, every 15 min** (1 GraphQL point for 10 repos, about 4 points/h): if the
   mirror holds more rows than GitHub for a repo, run that repo's id sweep (1 point per 100).
4. **Full sweep, nightly and on demand**: re-run the import query over all issues and PRs
   (`UPDATED_AT ASC`), plus the `nodes()` edge follow-up for every issue with non-zero
   summaries.
   - Diff everything: deletes rows that weren't seen, fixes edges whose counts didn't change
     but whose targets did, and refreshes stub titles and states.
   - Cost about 850 points for 20k + 20k, about 2,100 for 50k + 50k. That is 17–42 % of one
     hour's installation budget, once a day.
   - With a 4-way parallel stream it takes 3–10 minutes.
5. **Rate-limit hygiene**:
   - Read `x-ratelimit-remaining` from every response. Pause sweeps (never webhook-triggered
     single fetches) below 20 % remaining.
   - Back off on secondary limits as in §1.
   - Writes use user tokens and don't touch this budget (mechanics doc §1).

Steady-state cost for 20k issues and 20k PRs, as a daily average [inferred]: about 35 points/h
GraphQL for the full sweep, plus about 4/h for counts, plus edge re-reads as they come up.
REST adds about 120 core points/h, or about 0 with ETag probes. That is under 1 % of the
5,000/h budget, which leaves room for a full sweep on demand at any time.

## Open questions / unverified

- Whether "blocked-by removed" bumps `updatedAt` (no conclusive sample; every other relationship
  change does not).
- Whether label or milestone renames bump the `updatedAt` of affected issues (assumed no;
  untestable read-only).
- Whether sub-issue and dependency links survive an issue transfer, and what `issues.deleted`
  or `issue_dependencies` deliveries fire for the issues linked to a deleted one.
- Which webhooks a conversion to a discussion sends (none documented). Possibly
  `issues.deleted`; test it on a scratch repo.
- Why the 404 numbering gaps on cli/cli were 404 rather than the documented 410. Test by
  deleting an issue in a scratch repo.
- What GraphQL returns for edge targets in a private repo the installation can't see (null
  node, missing from the list, or a lower `totalCount`?).
- Whether GraphQL cursor pagination with `UPDATED_AT ASC` really never skips rows under
  concurrent updates (not documented).
- Product decisions:
  - Import `body` in bulk? It costs no extra points and no measurable latency, but roughly
    doubles the transferred bytes (cli/cli bodies average about 5 KB).
  - Import PRs in the first pass, or after issues?
  - Accept that relationship changes made during a webhook outage longer than 3 days can stay
    wrong until the next nightly sweep?
